import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 4317;
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const DEFAULT_VOICE = "Samantha";
const DEFAULT_OUTPUT = path.resolve(REPO_ROOT, ".demo", "recordings", "kanban-cards-demo.mp4");
const DEFAULT_TTS_PROVIDER = "say";
const AUDIO_CASCADE_EFFECTS_ROOT = "/Users/mike/Audio_CascadeEffects";
const DEFAULT_ELEVENLABS_ENV_FILE = path.join(AUDIO_CASCADE_EFFECTS_ROOT, ".env.local");
const DEFAULT_ELEVENLABS_HELPER = path.join(AUDIO_CASCADE_EFFECTS_ROOT, "scripts", "elevenlabs_provider.py");
const DEFAULT_ELEVENLABS_PROFILE_REGISTRY = path.join(AUDIO_CASCADE_EFFECTS_ROOT, "references", "voice_profiles", "youtube_shorts_voice_profiles.json");
const DEFAULT_ELEVENLABS_PROFILE_ID = "youtube_shorts_mike_challenger_match_v1";
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "wav_44100";
const SILENCE_SECONDS = 0.35;
const COMMAND_TIMEOUT_MS = 120_000;
const ELEVENLABS_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 30_000;

type TtsProvider = "say" | "elevenlabs";

interface DemoScene {
  label?: string;
  narration: string;
  step?: string;
  verify?: boolean;
  expectedText: string;
  currentStateText?: string;
  selectCardTitle?: string;
}

interface AudioScene {
  scene: DemoScene;
  wavPath: string;
  durationMs: number;
}

interface MediaProbe {
  streams?: Array<{ codec_name?: string; codec_type?: string }>;
}

interface VoiceProfileRegistry {
  profiles?: Record<string, unknown>;
}

interface VoiceProfile {
  provider?: string;
  voice?: string;
  model?: string;
  render_settings?: Record<string, unknown>;
}

interface ElevenLabsConfig {
  env: NodeJS.ProcessEnv;
  helperPath: string;
  profileId: string;
  voiceId: string;
  model: string;
  outputFormat: string;
  renderSettings: Record<string, unknown>;
}

const scenes: DemoScene[] = [
  {
    label: "intro",
    narration: "The board opens on a private beta security release. Release, risk, engineering, and security agents will move the launch toward approval.",
    expectedText: "Private Beta Security Release"
  },
  {
    narration: "Release Coordinator opens the release packet with token rotation, scoped access, rollback ownership, and required evidence.",
    step: "coordinator-intake",
    expectedText: "Release Coordinator opened the release packet with production token rotation, scoped agent access, rollback owner, and verification evidence required before launch.",
    currentStateText: "In progress",
    selectCardTitle: "Rotate private beta access tokens before launch"
  },
  {
    narration: "Risk Triage Agent identifies token, event stream, database, and rollback risks, then advances the work into engineering planning.",
    step: "risk-triage",
    expectedText: "Risk Triage Agent identified stale local tokens, live event replay gaps, database migration timing, and rollback ownership as launch risks.",
    currentStateText: "Engineering Plan",
    selectCardTitle: "Token rotation risk triage"
  },
  {
    narration: "Release Engineer writes the implementation plan and carries it into the implementation lane.",
    step: "engineer-plan",
    expectedText: "Release Engineer wrote the implementation plan covering token revocation, scoped token setup, live event replay checks, database initialization, and rollback handoff.",
    currentStateText: "Implementation",
    selectCardTitle: "Security release implementation plan"
  },
  {
    narration: "Release Engineer rotates stale tokens, checks live event replay after reconnect, initializes tables, and moves the work into security review.",
    step: "engineer-implementation",
    expectedText: "Release Engineer rotated stale tokens, verified live event replay after reconnect, initialized workspace and token tables, and attached rollback notes.",
    currentStateText: "Security Review",
    selectCardTitle: "Implement private beta token rotation"
  },
  {
    narration: "Security Reviewer opens a change request until revocation evidence, replay results, initialization output, and rollback acknowledgement are attached.",
    step: "security-change-request",
    expectedText: "Security Reviewer opened this change request: hold release until token revocation evidence, event replay after reconnect, database initialization output, and rollback owner acknowledgement are attached.",
    currentStateText: "Change requested",
    selectCardTitle: "Implement private beta token rotation"
  },
  {
    narration: "Release Engineer resolves the request with the evidence pack, clearing open requests in the current state panel.",
    step: "engineer-evidence",
    expectedText: "Release Engineer resolved the change request with token revocation evidence, reconnect replay result, database initialization output, and rollback owner acknowledgement.",
    currentStateText: "No open requests.",
    selectCardTitle: "Implement private beta token rotation"
  },
  {
    narration: "Security Reviewer approves the security gate and moves the implementation card to Release Ready.",
    step: "security-approval",
    expectedText: "Security Reviewer approved the release after token revocation, live event replay, database initialization, and rollback evidence matched the security gate.",
    currentStateText: "Approved",
    selectCardTitle: "Implement private beta token rotation"
  },
  {
    narration: "Release Coordinator closes the release packet with launch owner, rollback owner, and security monitoring handoff.",
    step: "coordinator-closeout",
    expectedText: "Release Coordinator closed the release packet. Launch owner: Release Coordinator. Rollback owner: Release Engineer. Security monitor: Security Reviewer watches token and event alerts.",
    currentStateText: "Delivered",
    selectCardTitle: "Rotate private beta access tokens before launch"
  },
  {
    label: "verification",
    narration: "The final board keeps the launch packet, risk triage, engineering work, security approval, and delivered closeout together.",
    verify: true,
    expectedText: "Release Coordinator closed the release after security approval, token rotation evidence, live event replay validation, database initialization, and rollback ownership were complete.",
    currentStateText: "Delivered",
    selectCardTitle: "Rotate private beta access tokens before launch"
  }
];

async function main(): Promise<void> {
  const width = positiveIntegerEnv("KANBAN_CARDS_DEMO_RECORD_WIDTH", DEFAULT_WIDTH);
  const height = positiveIntegerEnv("KANBAN_CARDS_DEMO_RECORD_HEIGHT", DEFAULT_HEIGHT);
  const ttsProvider = parseTtsProvider(process.env.KANBAN_CARDS_DEMO_RECORD_TTS_PROVIDER || DEFAULT_TTS_PROVIDER);
  if (ttsProvider === "say" && process.platform !== "darwin") {
    throw new Error("The say TTS provider is macOS-only. Use KANBAN_CARDS_DEMO_RECORD_TTS_PROVIDER=elevenlabs on other platforms.");
  }
  const voice = process.env.KANBAN_CARDS_DEMO_RECORD_VOICE || DEFAULT_VOICE;
  const outputPath = path.resolve(process.env.KANBAN_CARDS_DEMO_RECORD_OUT || DEFAULT_OUTPUT);
  const outputDir = path.dirname(outputPath);
  const workDir = path.join(outputDir, `work-${Date.now()}`);
  const videoDir = path.join(workDir, "video");
  const audioDir = path.join(workDir, "audio");
  const apiPort = await choosePort(DEFAULT_PORT);
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const demoEnv = {
    ...process.env,
    PORT: String(apiPort),
    KANBAN_CARDS_DEMO_API_URL: `${baseUrl}/api`
  };

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let failed = false;
  let cleanupStarted = false;

  assertRecordingCopyIsOperational(scenes);

  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (server) await stopProcess(server).catch(() => undefined);
    if (!failed) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  };

  process.once("SIGINT", () => {
    failed = true;
    cleanup().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    failed = true;
    cleanup().finally(() => process.exit(143));
  });

  try {
    const elevenLabsConfig = ttsProvider === "elevenlabs" ? await loadElevenLabsConfig() : null;

    await verifyExecutable("ffmpeg");
    await verifyExecutable("ffprobe");
    await verifyExecutable(process.execPath);
    if (ttsProvider === "say") {
      await verifyExecutable("say");
    } else {
      await verifyExecutable("python3");
      await verifyExecutable("curl");
      if (!elevenLabsConfig) throw new Error("ElevenLabs configuration was not loaded.");
      await fs.access(elevenLabsConfig.helperPath);
    }
    await ensureChromiumAvailable();

    await run("Build app", "npm", ["run", "build"], { env: process.env });
    await run("Prepare demo state", "npm", ["run", "demo:prepare"], { env: demoEnv });

    await fs.mkdir(videoDir, { recursive: true });
    await fs.mkdir(audioDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    const audioScenes = await createVoiceoverScenes(audioDir, {
      provider: ttsProvider,
      sayVoice: voice,
      elevenLabs: elevenLabsConfig
    });
    const voiceoverPath = path.join(audioDir, "voiceover.wav");
    await concatenateVoiceover(audioDir, audioScenes, voiceoverPath);

    server = startServer(demoEnv);
    await waitForServer(`${baseUrl}/api/state`, server);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width, height },
      recordVideo: {
        dir: videoDir,
        size: { width, height }
      }
    });

    const page = await context.newPage();
    const video = page.video();
    if (!video) throw new Error("Playwright did not initialize browser video capture.");

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await runRecordingScenes(page, audioScenes, demoEnv);
    await page.waitForTimeout(1_000);

    await context.close();
    context = null;
    const rawVideoPath = await video.path();
    const finalVideoPath = path.join(workDir, "browser-recording.mp4");
    await muxVideoAndAudio(rawVideoPath, voiceoverPath, finalVideoPath);
    await fs.copyFile(finalVideoPath, outputPath);
    await verifyFinalMedia(outputPath);

    process.stdout.write(`Demo recording written to ${path.relative(REPO_ROOT, outputPath)}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(formatError(error));
    process.stderr.write(`\nRecording work files were left at ${path.relative(REPO_ROOT, workDir)}\n`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

async function runRecordingScenes(page: Page, audioScenes: AudioScene[], env: NodeJS.ProcessEnv): Promise<void> {
  for (const audioScene of audioScenes) {
    const { scene, durationMs } = audioScene;
    process.stdout.write(`Recording scene: ${scene.step || scene.label || "scene"}\n`);

    if (scene.step) {
      await run(`Workflow step ${scene.step}`, "npm", ["run", "demo:step", "--", scene.step], { env });
    }

    if (scene.verify) {
      await run("Verify workflow state", "npm", ["run", "demo:verify"], { env });
    }

    if (scene.selectCardTitle) {
      await clickCard(page, scene.selectCardTitle);
    }

    await waitForText(page, scene.expectedText);
    if (scene.currentStateText) {
      await waitForText(page, "Current state");
      await waitForText(page, scene.currentStateText);
    }
    await page.waitForTimeout(durationMs + 350);
  }
}

async function createVoiceoverScenes(
  audioDir: string,
  options: { provider: TtsProvider; sayVoice: string; elevenLabs: ElevenLabsConfig | null }
): Promise<AudioScene[]> {
  if (options.provider === "elevenlabs") {
    if (!options.elevenLabs) throw new Error("Missing ElevenLabs config.");
    return createElevenLabsVoiceoverScenes(audioDir, options.elevenLabs);
  }
  return createSayVoiceoverScenes(audioDir, options.sayVoice);
}

async function createSayVoiceoverScenes(audioDir: string, voice: string): Promise<AudioScene[]> {
  const audioScenes: AudioScene[] = [];

  for (const [index, scene] of scenes.entries()) {
    const baseName = `scene-${String(index + 1).padStart(2, "0")}`;
    const aiffPath = path.join(audioDir, `${baseName}.aiff`);
    const wavPath = path.join(audioDir, `${baseName}.wav`);
    const sayArgs = voice ? ["-v", voice, "-o", aiffPath, scene.narration] : ["-o", aiffPath, scene.narration];

    await run(`Generate narration ${index + 1}`, "say", sayArgs, { env: process.env });
    await run("Normalize narration audio", "ffmpeg", [
      "-y",
      "-i",
      aiffPath,
      "-af",
      "loudnorm=I=-18:TP=-1.5:LRA=11",
      "-ar",
      "48000",
      "-ac",
      "2",
      wavPath
    ], { env: process.env });

    const durationMs = Math.ceil((await mediaDurationSeconds(wavPath) + SILENCE_SECONDS) * 1000);
    audioScenes.push({ scene, wavPath, durationMs });
  }

  return audioScenes;
}

async function createElevenLabsVoiceoverScenes(audioDir: string, config: ElevenLabsConfig): Promise<AudioScene[]> {
  const renderedDir = path.join(audioDir, "elevenlabs-rendered");
  const manifestPath = path.join(audioDir, "elevenlabs-scenes.jsonl");
  await fs.mkdir(renderedDir, { recursive: true });

  const rows = scenes.map((scene, index) => {
    const baseName = `scene-${String(index + 1).padStart(2, "0")}`;
    return JSON.stringify({
      input: scene.narration,
      spoken_input: scene.narration,
      elevenlabs_text: scene.narration,
      elevenlabs_voice_id: config.voiceId,
      elevenlabs_model_id: config.model,
      elevenlabs_apply_text_normalization: "on",
      elevenlabs_voice_settings: config.renderSettings,
      out: `${baseName}.wav`
    });
  });
  await fs.writeFile(manifestPath, rows.join("\n") + "\n", "utf8");

  await run("Render ElevenLabs narration", "python3", [
    config.helperPath,
    "render-batch",
    "--input",
    manifestPath,
    "--out-dir",
    renderedDir,
    "--model",
    config.model,
    "--voice-id",
    config.voiceId,
    "--output-format",
    config.outputFormat,
    "--force"
  ], { env: config.env, timeoutMs: ELEVENLABS_TIMEOUT_MS });

  const audioScenes: AudioScene[] = [];
  for (const [index, scene] of scenes.entries()) {
    const baseName = `scene-${String(index + 1).padStart(2, "0")}`;
    const renderedPath = path.join(renderedDir, `${baseName}.wav`);
    const wavPath = path.join(audioDir, `${baseName}.wav`);

    await run("Normalize ElevenLabs narration audio", "ffmpeg", [
      "-y",
      "-i",
      renderedPath,
      "-af",
      "loudnorm=I=-18:TP=-1.5:LRA=11",
      "-ar",
      "48000",
      "-ac",
      "2",
      wavPath
    ], { env: process.env });

    const durationMs = Math.ceil((await mediaDurationSeconds(wavPath) + SILENCE_SECONDS) * 1000);
    audioScenes.push({ scene, wavPath, durationMs });
  }

  return audioScenes;
}

async function concatenateVoiceover(audioDir: string, audioScenes: AudioScene[], outputPath: string): Promise<void> {
  const silencePath = path.join(audioDir, "silence.wav");
  const listPath = path.join(audioDir, "voiceover-list.txt");
  const files: string[] = [];

  await run("Generate narration spacing", "ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t",
    String(SILENCE_SECONDS),
    silencePath
  ], { env: process.env });

  for (const audioScene of audioScenes) {
    files.push(audioScene.wavPath, silencePath);
  }

  await fs.writeFile(listPath, files.map((file) => `file '${escapeConcatPath(file)}'`).join("\n") + "\n");
  await run("Concatenate narration", "ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath
  ], { env: process.env });
}

async function muxVideoAndAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  await run("Mux browser video and narration", "ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath
  ], { env: process.env, timeoutMs: 180_000 });
}

async function verifyFinalMedia(outputPath: string): Promise<void> {
  const { stdout } = await run("Inspect final media", "ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,codec_type",
    "-of",
    "json",
    outputPath
  ], { env: process.env });
  const probe = JSON.parse(stdout) as MediaProbe;
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video") || [];
  const audioStreams = probe.streams?.filter((stream) => stream.codec_type === "audio") || [];
  if (videoStreams.length !== 1 || audioStreams.length !== 1) {
    throw new Error(`Expected one video stream and one audio stream, found ${videoStreams.length} video and ${audioStreams.length} audio.`);
  }
  if (videoStreams[0]?.codec_name !== "h264") {
    throw new Error(`Expected H.264 video, found ${videoStreams[0]?.codec_name || "unknown"}.`);
  }
  if (audioStreams[0]?.codec_name !== "aac") {
    throw new Error(`Expected AAC audio, found ${audioStreams[0]?.codec_name || "unknown"}.`);
  }
}

async function clickCard(page: Page, title: string): Promise<void> {
  const card = page.locator("[data-work-item-id]", { hasText: title }).first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.scrollIntoViewIfNeeded();
  await card.click();
}

async function waitForText(page: Page, text: string): Promise<void> {
  await page.locator("body", { hasText: text }).waitFor({ state: "visible", timeout: 15_000 });
}

function startServer(env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn("npm", ["run", "demo:server"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) process.stderr.write(`demo:server exited with code ${code}\n`);
    if (signal) process.stderr.write(`demo:server exited from signal ${signal}\n`);
  });
  return child;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
    if (child.exitCode !== null) throw new Error(`demo:server exited before ${url} was ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_error) {
      // The server is still starting.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function ensureChromiumAvailable(): Promise<void> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Please run")) throw error;
  }

  await run("Install Playwright Chromium", "npx", ["playwright", "install", "chromium"], {
    env: process.env,
    timeoutMs: 300_000
  });

  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

async function verifyExecutable(command: string): Promise<void> {
  if (path.isAbsolute(command)) {
    await fs.access(command);
    return;
  }
  await run(`Verify ${command}`, "which", [command], { env: process.env });
}

async function run(
  label: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  process.stdout.write(`${label}...\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: REPO_ROOT,
      env: options.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: options.timeoutMs || COMMAND_TIMEOUT_MS
    });
    return result;
  } catch (error) {
    throw new Error(`${label} failed.\n${formatCommandError(error)}`);
  }
}

async function mediaDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await run("Measure media duration", "ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { env: process.env });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read media duration for ${filePath}.`);
  return duration;
}

async function choosePort(preferredPort: number): Promise<number> {
  if (await isPortAvailable(preferredPort)) return preferredPort;
  for (let port = preferredPort + 1; port < preferredPort + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`Could not find an available local port starting at ${preferredPort}.`);
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function loadElevenLabsConfig(): Promise<ElevenLabsConfig> {
  const envFile = path.resolve(process.env.KANBAN_CARDS_DEMO_RECORD_ELEVENLABS_ENV_FILE || DEFAULT_ELEVENLABS_ENV_FILE);
  const helperPath = path.resolve(process.env.KANBAN_CARDS_DEMO_RECORD_ELEVENLABS_HELPER || DEFAULT_ELEVENLABS_HELPER);
  const registryPath = path.resolve(process.env.KANBAN_CARDS_DEMO_RECORD_VOICE_PROFILE_REGISTRY || DEFAULT_ELEVENLABS_PROFILE_REGISTRY);
  const profileId = process.env.KANBAN_CARDS_DEMO_RECORD_VOICE_PROFILE_ID || DEFAULT_ELEVENLABS_PROFILE_ID;
  const outputFormat = process.env.KANBAN_CARDS_DEMO_RECORD_ELEVENLABS_OUTPUT_FORMAT || DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
  if (!outputFormat.startsWith("wav_")) throw new Error(`ElevenLabs output format must be WAV-based, got ${outputFormat}.`);

  const envFileValues = await readEnvFile(envFile);
  const env = {
    ...envFileValues,
    ...process.env
  };
  const profile = await readElevenLabsProfile(registryPath, profileId);
  const voiceId = requiredProfileString(profile, "voice", profileId);
  const model = requiredProfileString(profile, "model", profileId);
  const provider = requiredProfileString(profile, "provider", profileId);
  if (provider !== "elevenlabs") throw new Error(`Voice profile ${profileId} uses provider ${provider}, expected elevenlabs.`);

  env.ELEVEN_LABS_VOICE_ID = voiceId;
  env.ELEVENLABS_DEFAULT_MODEL = model;
  if (!env.ELEVEN_LABS_API_KEY) {
    throw new Error(`ELEVEN_LABS_API_KEY is missing. Add it to ${envFile} or export it in the shell.`);
  }

  return {
    env,
    helperPath,
    profileId,
    voiceId,
    model,
    outputFormat,
    renderSettings: isRecord(profile.render_settings) ? profile.render_settings : {}
  };
}

async function readElevenLabsProfile(registryPath: string, profileId: string): Promise<VoiceProfile> {
  const raw = await fs.readFile(registryPath, "utf8");
  const registry = JSON.parse(raw) as VoiceProfileRegistry;
  if (!isRecord(registry.profiles)) throw new Error(`Voice profile registry has no profiles object: ${registryPath}`);
  const rawProfile = registry.profiles[profileId];
  if (!isRecord(rawProfile)) throw new Error(`Voice profile ${profileId} was not found in ${registryPath}.`);
  return rawProfile as VoiceProfile;
}

async function readEnvFile(envFile: string): Promise<Record<string, string>> {
  let raw = "";
  try {
    raw = await fs.readFile(envFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }

  const values: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = stripEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function stripEnvValue(value: string): string {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, "\n");
}

function requiredProfileString(profile: VoiceProfile, key: keyof VoiceProfile, profileId: string): string {
  const value = profile[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Voice profile ${profileId} is missing ${String(key)}.`);
  }
  return value.trim();
}

function parseTtsProvider(value: string): TtsProvider {
  if (value === "say" || value === "elevenlabs") return value;
  throw new Error(`KANBAN_CARDS_DEMO_RECORD_TTS_PROVIDER must be say or elevenlabs, got ${value}.`);
}

function assertRecordingCopyIsOperational(recordingScenes: DemoScene[]): void {
  const bannedPatterns = [
    /\bdemo\b/i,
    /\bthrowaway\b/i,
    /\brecording\b/i,
    /\bsample\b/i,
    /\bfake\b/i,
    /\bharness\b/i,
    /\bthis shows\b/i,
    /\bthis proves\b/i
  ];
  for (const [index, scene] of recordingScenes.entries()) {
    for (const [field, value] of [
      ["narration", scene.narration],
      ["expectedText", scene.expectedText],
      ["selectCardTitle", scene.selectCardTitle || ""]
    ]) {
      const pattern = bannedPatterns.find((candidate) => candidate.test(value));
      if (pattern) {
        throw new Error(`Scene ${index + 1} ${field} contains fourth-wall language: ${value}`);
      }
    }
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`;
}

function formatCommandError(error: unknown): string {
  if (!isExecError(error)) return formatError(error);
  const parts = [
    error.message,
    error.stdout ? `stdout:\n${error.stdout}` : "",
    error.stderr ? `stderr:\n${error.stderr}` : ""
  ].filter(Boolean);
  return parts.join("\n");
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

main().catch((error: unknown) => {
  process.stderr.write(formatError(error));
  process.exitCode = 1;
});
