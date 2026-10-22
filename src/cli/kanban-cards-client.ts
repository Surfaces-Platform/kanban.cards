import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:4317/api";
const CONFIG_DIRECTORY = process.env.KANBAN_CARDS_CONFIG_DIR ?? path.join(os.homedir(), ".kanban-cards");
const USER_CONFIG_PATH = path.join(CONFIG_DIRECTORY, "config.json");
const REPO_CONFIG_NAME = ".kanban-cards.json";

const PAIRING_CONFIG_PATH = path.join(CONFIG_DIRECTORY, "pairing.json");
const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_POLL_MS = 1_500;

interface PendingPairing {
  pairingId: string;
  deviceToken: string;
  userCode: string;
  expiresAt: string;
  apiBaseUrl: string;
  authOrigin: string;
  workspaceId: string;
  projectId: string;
  label: string;
}

type CliOptions = Record<string, string | boolean | undefined>;

interface UserConfig {
  apiBaseUrl?: string;
  token?: string;
  actor?: string;
}

interface RepoConfig {
  projectId: string;
}

interface RuntimeContext {
  baseUrl: string;
  token: string;
  actor: string;
}

interface RequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  expectedVersion?: string;
}

class ConnectionRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  if (process.env.KANBAN_CARDS_CONFIG_DIR !== undefined && command && command !== "help" && command !== "--help") {
    await preparePrivateConfigDirectory(await findRepositoryRoot(repoStart(options)));
  }
  const skipsConfig = !command || command === "setup" || command === "connect" || command === "help" || command === "--help";
  const userConfig = skipsConfig ? {} : await loadUserConfig();
  const runtime = resolveRuntime(userConfig);
  const result = await run(command, options, runtime);
  if (result !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function run(action: string | undefined, opts: CliOptions, context: RuntimeContext): Promise<unknown> {
  if (!action || action === "help" || action === "--help") return usage();

  if (action === "setup") return setup(opts);
  if (action === "connect") return connect(opts);

  requireToken(context);

  if (action === "session") return request("/session", {}, context);
  if (action === "projects") return request("/projects", {}, context);

  if (action === "create-project") {
    requireOption(opts, "name");
    const body: Record<string, unknown> = { name: stringOption(opts, "name") };
    copyTextOption(opts, body, "description");
    if (opts.columns !== undefined) body.columns = columnsOption(opts.columns);
    return request("/projects", {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "project")
    }, context);
  }

  if (action === "bind") {
    const projectId = stringOption(opts, "project");
    await request(`/projects/${encodeURIComponent(projectId)}`, {}, context);
    const repoRoot = await findRepositoryRoot(repoStart(opts));
    const configPath = path.join(repoRoot, REPO_CONFIG_NAME);
    await assertSafeExistingRepoConfig(configPath);
    await writeJsonAtomic(configPath, { projectId }, 0o644);
    return { configPath, projectId };
  }

  const projectId = await resolveProjectId(opts);
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;

  if (action === "project") return request(projectPath, {}, context);

  if (action === "update-project") {
    const body: Record<string, unknown> = {};
    copyStringOption(opts, body, "name");
    copyTextOption(opts, body, "description");
    if (opts.columns !== undefined) body.columns = columnsOption(opts.columns);
    requireNonEmptyBody(body, action);
    return request(projectPath, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }

  if (action === "cards") {
    assertKnownOptions(opts, ["project", "repo", "next-actor", "priority", "blocked", "include-archived"]);
    const query = new URLSearchParams();
    if (opts["next-actor"] !== undefined) query.set("nextActor", enumOption(opts, "next-actor", ["human", "agent", "unassigned"]));
    if (opts.priority !== undefined) query.set("priority", enumOption(opts, "priority", ["High", "Medium", "Low", "unset"]));
    if (opts.blocked !== undefined) query.set("blocked", enumOption(opts, "blocked", ["true", "false"]));
    if (opts["include-archived"] !== undefined) query.set("includeArchived", enumOption(opts, "include-archived", ["true", "false"]));
    return request(`${projectPath}/cards${query.size ? `?${query}` : ""}`, {}, context);
  }

  if (action === "create-card") {
    assertKnownOptions(opts, ["project", "repo", "title", "body", "column", "position", "external-key", "idempotency-key", "next-actor", "next-action", "priority", "blocked-reason"]);
    requireOption(opts, "title");
    const body: Record<string, unknown> = { title: stringOption(opts, "title") };
    copyTextOption(opts, body, "body");
    copyStringOption(opts, body, "column", "columnId");
    copyStringOption(opts, body, "external-key", "externalKey");
    copyCardMetadataOptions(opts, body);
    if (opts.position !== undefined) body.position = numberOption(opts, "position");
    const externalKey = optionalStringOption(opts, "external-key");
    return request(`${projectPath}/cards`, {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "card", externalKey ? `${projectId}:${externalKey}` : undefined)
    }, context);
  }

  if (action === "update-card") {
    assertKnownOptions(opts, ["project", "repo", "card", "title", "body", "version", "next-actor", "next-action", "priority", "blocked-reason"]);
    const cardId = stringOption(opts, "card");
    const body: Record<string, unknown> = {};
    copyStringOption(opts, body, "title");
    copyTextOption(opts, body, "body");
    copyCardMetadataOptions(opts, body);
    requireNonEmptyBody(body, action);
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }

  if (action === "move-card") {
    const cardId = stringOption(opts, "card");
    const body: Record<string, unknown> = { columnId: stringOption(opts, "column") };
    if (opts.position !== undefined) body.position = numberOption(opts, "position");
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }

  if (action === "archive-card") {
    const cardId = stringOption(opts, "card");
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: { archivedAt: new Date().toISOString() },
      expectedVersion: stringOption(opts, "version")
    }, context);
  }

  if (action === "comment") {
    const cardId = stringOption(opts, "card");
    const body = { body: stringOption(opts, "text") };
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}/comments`, {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "comment")
    }, context);
  }

  if (action === "activity") {
    const query = opts.limit === undefined ? "" : `?limit=${encodeURIComponent(String(positiveIntegerOption(opts, "limit")))}`;
    return request(`${projectPath}/activity${query}`, {}, context);
  }

  throw new Error(`Unknown command: ${action}`);
}

/** Pair the active Codex host with one Workspace without asking for an API key. */
async function connect(opts: CliOptions): Promise<void> {
  assertKnownOptions(opts, ["url", "project-id", "label", "repo"]);
  const apiBaseUrl = workspaceApiUrl(stringOption(opts, "url"));
  const projectId = stringOption(opts, "project-id");
  if (!safeIdentifier(projectId)) throw new Error("The Project ID is invalid.");
  const label = optionalStringOption(opts, "label") || "Codex";
  if (label.length > 80 || /[\r\n\x00-\x1f]/.test(label)) throw new Error("The connection label must be one line of at most 80 characters.");
  const repositoryRoot = await findRepositoryRoot(repoStart(opts));
  const bindingPath = path.join(repositoryRoot, REPO_CONFIG_NAME);
  await assertSafeExistingRepoConfig(bindingPath);
  await preparePrivateConfigDirectory(repositoryRoot);

  const session = await connectionRequest(`${apiBaseUrl}/session`);
  const workspaceId = exactWorkspaceId(session, apiBaseUrl);
  const authOrigin = pairingAuthOrigin(apiBaseUrl, session);
  let pairing = await loadPendingPairing();
  if (pairing && Date.parse(pairing.expiresAt) <= Date.now()) {
    await fs.rm(PAIRING_CONFIG_PATH, { force: true });
    pairing = undefined;
  }
  if (pairing && (pairing.apiBaseUrl !== apiBaseUrl || pairing.authOrigin !== authOrigin ||
      pairing.workspaceId !== workspaceId || pairing.projectId !== projectId || pairing.label !== label)) {
    throw new Error("A connection approval is already pending for another Workspace, Project, or label. Finish that approval or wait for it to expire before starting another.");
  }
  const saved = await loadUserConfig();
  const bound = await readJsonIfPresent(bindingPath);
  if (saved.apiBaseUrl === apiBaseUrl && typeof saved.token === "string" && saved.token &&
      saved.actor === label && isRecord(bound) && bound.projectId === projectId) {
    let previousSession: unknown;
    try { previousSession = await connectionRequest(`${apiBaseUrl}/session`, { token: saved.token }); }
    catch (error) {
      if (!(error instanceof ConnectionRequestError) || (error.status !== 401 && error.status !== 403)) throw error;
    }
    if (isRecord(previousSession) && previousSession.authenticated === true && hasReadWriteAccess(previousSession)) {
      if (exactWorkspaceId(previousSession, apiBaseUrl) !== workspaceId) throw new Error("The saved credential does not match the requested Workspace.");
      const project = await connectionRequest(`${apiBaseUrl}/projects/${encodeURIComponent(projectId)}`, { token: saved.token });
      if (!isRecord(project) || !isRecord(project.project) || project.project.id !== projectId) throw new Error("The selected Project could not be verified in the saved Workspace connection.");
      if (pairing) await fs.rm(PAIRING_CONFIG_PATH, { force: true });
      process.stdout.write("Workspace access is already approved. Continue this Project in Codex.\n");
      return;
    }
  }
  if (!pairing) {
    const created = await connectionRequest(`${authOrigin}/api/native-auth/agent-pairings`, { body: { workspaceId, label } });
    if (!isRecord(created) || !safeIdentifier(created.pairingId) ||
        typeof created.deviceToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(created.deviceToken) ||
        typeof created.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(created.userCode) ||
        typeof created.expiresAt !== "string" || !validPairingExpiry(created.expiresAt)) {
      throw new Error("The pairing service returned an incomplete approval request. Start connection again.");
    }
    pairing = { pairingId: created.pairingId, deviceToken: created.deviceToken, userCode: created.userCode,
      expiresAt: created.expiresAt, apiBaseUrl, authOrigin, workspaceId, projectId, label };
    await writeJsonAtomic(PAIRING_CONFIG_PATH, pairing, 0o600);
  }

  process.stdout.write(`Approval code: ${pairing.userCode}\nIn Kanban.cards, open this Project, choose Set up Codex, then Review approval code. Enter the code and approve Agent access. Keep this Codex task open while it waits.\n`);
  const deadline = Math.min(Date.parse(pairing.expiresAt), Date.now() + PAIRING_TTL_MS);
  while (Date.now() < deadline) {
    const result = await connectionRequest(`${authOrigin}/api/native-auth/agent-pairings/poll`, {
      body: { pairingId: pairing.pairingId, deviceToken: pairing.deviceToken },
      timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now()))
    });
    if (!isRecord(result)) throw new Error("The pairing service returned an incomplete approval status. Retry connect to resume the same request.");
    if (result.status === "pending") {
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(PAIRING_POLL_MS, deadline - Date.now()))));
      continue;
    }
    if (result.status === "denied" || result.status === "expired") {
      await fs.rm(PAIRING_CONFIG_PATH, { force: true });
      throw new Error(result.status === "denied" ? "Connection approval was denied or revoked. Run connect again only when you want to request access." : "Connection approval expired. Run connect again for a new code.");
    }
    if (result.status !== "approved" || !isRecord(result.connection) ||
        result.connection.workspaceId !== workspaceId || typeof result.credential !== "string" ||
        !/^kac_[A-Za-z0-9_-]{32,512}$/.test(result.credential) ||
        typeof result.apiBaseUrl !== "string" || workspaceApiUrl(result.apiBaseUrl) !== apiBaseUrl ||
        !Array.isArray(result.connection.scopes) || !result.connection.scopes.includes("read") || !result.connection.scopes.includes("write") ||
        result.connection.revokedAt != null) {
      await fs.rm(PAIRING_CONFIG_PATH, { force: true });
      throw new Error("The approved connection did not match the requested Workspace and access. No credentials or Project binding were saved.");
    }
    const authenticated = await connectionRequest(`${apiBaseUrl}/session`, { token: result.credential });
    if (!isRecord(authenticated) || authenticated.authenticated !== true || !hasReadWriteAccess(authenticated) || exactWorkspaceId(authenticated, apiBaseUrl) !== workspaceId) {
      await fs.rm(PAIRING_CONFIG_PATH, { force: true });
      throw new Error("The approved credential did not authenticate the requested Workspace with read/write access. No credentials or Project binding were saved.");
    }
    const project = await connectionRequest(`${apiBaseUrl}/projects/${encodeURIComponent(projectId)}`, { token: result.credential });
    if (!isRecord(project) || !isRecord(project.project) || project.project.id !== projectId) {
      throw new Error("The selected Project could not be verified in the approved Workspace. No credentials or Project binding were saved.");
    }
    const previousConfig = await fs.readFile(USER_CONFIG_PATH, "utf8").catch(error => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    await writeJsonAtomic(USER_CONFIG_PATH, { apiBaseUrl, token: result.credential, actor: label }, 0o600);
    try {
      await writeJsonAtomic(bindingPath, { projectId }, 0o644);
    } catch {
      if (previousConfig === undefined) await fs.rm(USER_CONFIG_PATH, { force: true });
      else await writeJsonAtomic(USER_CONFIG_PATH, JSON.parse(previousConfig), 0o600);
      throw new Error("The Project binding could not be saved. Retry connect to resume the approved request.");
    }
    await fs.rm(PAIRING_CONFIG_PATH, { force: true });
    process.stdout.write("Access approved. Continue this Project in Codex.\n");
    return;
  }
  await fs.rm(PAIRING_CONFIG_PATH, { force: true });
  throw new Error("Connection approval expired. Run connect again for a new code.");
}

function workspaceApiUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  const url = new URL(normalized);
  if (url.pathname !== "/" && url.pathname !== "/api") throw new Error("Use the Workspace URL or its /api URL, without a Project path.");
  return `${url.origin}/api`;
}

function exactWorkspaceId(session: unknown, apiBaseUrl: string): string {
  if (!isRecord(session) || session.context !== "workspace" || !isRecord(session.workspace) ||
      !safeIdentifier(session.workspace.id) || typeof session.workspace.url !== "string" ||
      workspaceApiUrl(session.workspace.url) !== apiBaseUrl) {
    throw new Error("The requested URL did not identify the exact Workspace. No credentials or Project binding were saved.");
  }
  return session.workspace.id;
}

function pairingAuthOrigin(apiBaseUrl: string, session: unknown): string {
  const target = new URL(apiBaseUrl);
  if (target.hostname.endsWith(".kanban.cards") && target.hostname !== "auth.kanban.cards") return "https://auth.kanban.cards";
  if (!isLoopbackHostname(target.hostname) || !isRecord(session) || typeof session.loginUrl !== "string") {
    throw new Error("Native pairing requires a kanban.cards Workspace or a configured local test service.");
  }
  let auth: URL;
  try { auth = new URL(session.loginUrl); } catch { throw new Error("The local service did not identify its authentication origin."); }
  if (!isLoopbackHostname(auth.hostname) || auth.protocol !== target.protocol || auth.port !== target.port || auth.username || auth.password || auth.search || auth.hash) {
    throw new Error("The local authentication origin must use the same loopback service.");
  }
  return auth.origin;
}

function hasReadWriteAccess(value: Record<string, unknown>): boolean {
  return Array.isArray(value.scopes) && value.scopes.includes("read") && value.scopes.includes("write");
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function validPairingExpiry(value: string): boolean {
  const expires = Date.parse(value);
  return Number.isFinite(expires) && expires > Date.now() && expires <= Date.now() + PAIRING_TTL_MS + 30_000;
}

async function loadPendingPairing(): Promise<PendingPairing | undefined> {
  const value = await readJsonIfPresent(PAIRING_CONFIG_PATH);
  if (value === undefined) return undefined;
  if (!isRecord(value) || !safeIdentifier(value.pairingId) || typeof value.deviceToken !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(value.deviceToken) || typeof value.userCode !== "string" ||
      !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.userCode) || typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.apiBaseUrl !== "string" ||
      typeof value.authOrigin !== "string" || !safeIdentifier(value.workspaceId) ||
      typeof value.projectId !== "string" || typeof value.label !== "string") {
    throw new Error("The saved connection approval is invalid. Remove only pairing.json from the configured private credential directory, then retry connect.");
  }
  await fs.chmod(PAIRING_CONFIG_PATH, 0o600);
  return value as unknown as PendingPairing;
}

async function preparePrivateConfigDirectory(repositoryRoot: string): Promise<void> {
  const directory = path.dirname(USER_CONFIG_PATH);
  if (!path.isAbsolute(CONFIG_DIRECTORY) || !CONFIG_DIRECTORY || /[\r\n\0]/.test(CONFIG_DIRECTORY)) {
    throw new Error("KANBAN_CARDS_CONFIG_DIR must be an absolute private directory path.");
  }
  const repo = await fs.realpath(repositoryRoot);
  const isInside = (candidate: string): boolean => candidate === repo || candidate.startsWith(`${repo}${path.sep}`);
  if (isInside(path.resolve(directory)) || isInside(await prospectiveRealPath(directory))) {
    throw new Error("The user credential directory must be outside the repository.");
  }
  const existing = await fs.lstat(directory).catch(error => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("The user credential directory must be a private regular directory.");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (isInside(await fs.realpath(directory))) throw new Error("The user credential directory must be outside the repository.");
  await fs.chmod(directory, 0o700);
  for (const file of [USER_CONFIG_PATH, PAIRING_CONFIG_PATH]) {
    const stat = await fs.lstat(file).catch(error => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("The user credential files must be regular private files.");
    if (stat) await fs.chmod(file, 0o600);
  }
}

/** Resolve existing parents before creating a directory, including symlinked ancestors. */
async function prospectiveRealPath(directory: string): Promise<string> {
  let candidate = path.resolve(directory);
  const missing: string[] = [];
  while (true) {
    try { return path.join(await fs.realpath(candidate), ...missing.reverse()); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      missing.push(path.basename(candidate));
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("The private credential directory could not be resolved.");
      candidate = parent;
    }
  }
}

/** Pairing errors never echo remote bodies, URLs, credentials, or transport internals. */
async function connectionRequest(url: string, options: { body?: Record<string, unknown>; token?: string; timeoutMs?: number } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: options.body ? "POST" : "GET", redirect: "error",
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  } catch {
    throw new ConnectionRequestError("The connection service could not be reached. Retry connect to resume an unfinished approval.");
  }
  if (!response.ok) throw new ConnectionRequestError(`The connection service rejected the request (${response.status}). Retry after checking access in Kanban.cards.`, response.status);
  try { return await response.json(); } catch { throw new Error("The connection service returned an invalid response. Retry connect to resume an unfinished approval."); }
}

async function setup(opts: CliOptions): Promise<Record<string, unknown>> {
  if (opts.token !== undefined) {
    throw new Error("Do not pass tokens on the command line. Pipe the token to setup with --token-stdin.");
  }
  if (opts["token-stdin"] !== true) {
    throw new Error("Missing --token-stdin. Pipe the AgentConnection credential to standard input.");
  }

  const token = (await readStdin()).trim();
  if (!token) throw new Error("No token was received on standard input.");

  const apiBaseUrl = normalizeBaseUrl(optionalStringOption(opts, "url") || DEFAULT_BASE_URL);
  const actor = optionalStringOption(opts, "actor") || "codex";
  const session = await request("/session", {}, { baseUrl: apiBaseUrl, token, actor });
  if (!isRecord(session) || session.authenticated !== true || (session.context !== "workspace" && session.context !== "local")) {
    throw new Error("The credential must authenticate an exact Workspace tenant API.");
  }
  const nextConfig: UserConfig = { apiBaseUrl, token, actor };
  await writeJsonAtomic(USER_CONFIG_PATH, nextConfig, 0o600);

  return {
    configPath: USER_CONFIG_PATH,
    apiBaseUrl,
    actor,
    tokenConfigured: true
  };
}

async function request(pathname: string, options: RequestOptions, context: RuntimeContext): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.token}`,
    "X-Kanban-Actor": context.actor
  };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options.expectedVersion) headers["X-Kanban-Version"] = options.expectedVersion;

  const endpoint = `${context.baseUrl}${pathname}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach the kanban.cards API at ${context.baseUrl}: ${detail}`);
  }

  const responseText = await response.text();
  const data = parseResponse(responseText);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string"
      ? data.error
      : `Request failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(message);
  }
  return data;
}

async function loadUserConfig(): Promise<UserConfig> {
  const parsed = await readJsonIfPresent(USER_CONFIG_PATH);
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`Invalid user config: ${USER_CONFIG_PATH}`);

  const allowed = new Set(["apiBaseUrl", "token", "actor"]);
  const unexpected = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`Unsupported user config field(s): ${unexpected.join(", ")}`);
  return parsed as UserConfig;
}

function resolveRuntime(config: UserConfig): RuntimeContext {
  return {
    baseUrl: normalizeBaseUrl(config.apiBaseUrl || DEFAULT_BASE_URL),
    token: typeof config.token === "string" ? config.token : "",
    actor: typeof config.actor === "string" && config.actor.trim() ? config.actor.trim() : "codex"
  };
}

async function resolveProjectId(opts: CliOptions): Promise<string> {
  const explicit = optionalStringOption(opts, "project");
  if (explicit) return explicit;

  const repoRoot = await findRepositoryRoot(repoStart(opts));
  const configPath = path.join(repoRoot, REPO_CONFIG_NAME);
  const parsed = await readJsonIfPresent(configPath);
  if (parsed === undefined) {
    throw new Error(`No project selected. Pass --project or run bind in ${repoRoot}.`);
  }
  return validateRepoConfig(parsed, configPath).projectId;
}

async function assertSafeExistingRepoConfig(configPath: string): Promise<void> {
  const parsed = await readJsonIfPresent(configPath);
  if (parsed !== undefined) validateRepoConfig(parsed, configPath);
}

function validateRepoConfig(value: unknown, configPath: string): RepoConfig {
  if (!isRecord(value)) throw new Error(`Invalid repository config: ${configPath}`);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "projectId") {
    throw new Error(`${configPath} may contain only projectId. Never store a token or API URL in a repository config.`);
  }
  if (typeof value.projectId !== "string" || !value.projectId.trim()) {
    throw new Error(`Invalid projectId in ${configPath}`);
  }
  return { projectId: value.projectId.trim() };
}

async function findRepositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  const stat = await fs.stat(current).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Repository path is not a directory: ${current}`);

  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No Git repository found from ${start}. Pass --repo with a path inside the repository.`);
    }
    current = parent;
  }
}

function repoStart(opts: CliOptions): string {
  return optionalStringOption(opts, "repo") || process.cwd();
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${filePath}`);
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, mode).catch(() => undefined);
}

function createIdempotencyKey(opts: CliOptions, namespace: string, stableSeed?: string): string {
  const explicit = optionalStringOption(opts, "idempotency-key");
  if (explicit) return explicit;
  if (stableSeed) {
    const digest = createHash("sha256").update(`${namespace}\0${stableSeed}`).digest("hex").slice(0, 32);
    return `kanban-cards-${namespace}-${digest}`;
  }
  return `kanban-cards-${namespace}-${randomUUID()}`;
}

function columnsOption(value: string | boolean | undefined): Array<{ id?: string; name: string; position?: number }> {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing --columns");
  const text = value.trim();
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("--columns must be a comma-separated list or a JSON array.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("--columns must contain at least one column.");
    return parsed.map((column, index) => normalizeColumn(column, index));
  }
  const columns = text.split(",").map((column) => column.trim()).filter(Boolean);
  if (!columns.length) throw new Error("--columns must contain at least one column.");
  return columns.map((name, position) => ({ name, position }));
}

function normalizeColumn(value: unknown, index: number): { id?: string; name: string; position?: number } {
  if (typeof value === "string" && value.trim()) return { name: value.trim(), position: index };
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`Column ${index + 1} must be a name or an object with a name.`);
  }
  const column: { id?: string; name: string; position?: number } = { name: value.name.trim() };
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`Column ${index + 1} has an invalid id.`);
    column.id = value.id.trim();
  }
  if (value.position !== undefined) {
    if (typeof value.position !== "number" || !Number.isFinite(value.position) || value.position < 0) {
      throw new Error(`Column ${index + 1} has an invalid position.`);
    }
    column.position = value.position;
  }
  return column;
}

function copyStringOption(opts: CliOptions, body: Record<string, unknown>, option: string, field = option): void {
  if (opts[option] !== undefined) body[field] = stringOption(opts, option);
}

function copyTextOption(opts: CliOptions, body: Record<string, unknown>, option: string, field = option): void {
  if (opts[option] === undefined) return;
  if (typeof opts[option] !== "string") throw new Error(`Missing --${option}`);
  body[field] = opts[option];
}

function copyCardMetadataOptions(opts: CliOptions, body: Record<string, unknown>): void {
  if (opts["next-actor"] !== undefined) {
    const value = enumOption(opts, "next-actor", ["human", "agent", "unassigned"]);
    body.nextActor = value === "unassigned" ? null : value;
  }
  copyTextOption(opts, body, "next-action", "nextAction");
  if (opts.priority !== undefined) {
    const value = enumOption(opts, "priority", ["High", "Medium", "Low", "unset"]);
    body.priority = value === "unset" ? null : value;
  }
  copyTextOption(opts, body, "blocked-reason", "blockedReason");
}

function enumOption<T extends string>(opts: CliOptions, key: string, allowed: readonly T[]): T {
  const value = stringOption(opts, key);
  if (!allowed.includes(value as T)) throw new Error(`--${key} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

function assertKnownOptions(opts: CliOptions, allowed: readonly string[]): void {
  const unexpected = Object.keys(opts).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`Unsupported option(s): ${unexpected.map((key) => `--${key}`).join(", ")}`);
}

function optionalStringOption(opts: CliOptions, key: string): string | undefined {
  const value = opts[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}`);
  return value.trim();
}

function stringOption(opts: CliOptions, key: string): string {
  const value = optionalStringOption(opts, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function numberOption(opts: CliOptions, key: string): number {
  const value = Number(stringOption(opts, key));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a non-negative number.`);
  return value;
}

function positiveIntegerOption(opts: CliOptions, key: string): number {
  const value = numberOption(opts, key);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer.`);
  return value;
}

function requireOption(opts: CliOptions, key: string): void {
  stringOption(opts, key);
}

function requireNonEmptyBody(body: Record<string, unknown>, command: string): void {
  if (!Object.keys(body).length) throw new Error(`${command} requires at least one field to update.`);
}

function requireToken(context: RuntimeContext): void {
  if (!context.token) throw new Error("Run connect --url <WorkspaceURL> --project-id <ID> --label Codex before using the API.");
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("The API URL must be an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The API URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The API URL must not contain credentials, a query, or a fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("A non-loopback kanban.cards API requires https:// so the AgentConnection credential is encrypted in transit.");
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.startsWith("127.") ||
    normalized === "[::1]" ||
    normalized === "::1";
}

function parseResponse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseArgs(values: string[]): CliOptions {
  const parsed: CliOptions = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error("Unexpected argument. Use named options; never pass credentials as arguments.");
    const equalsIndex = value.indexOf("=");
    const key = equalsIndex > 2 ? value.slice(2, equalsIndex) : value.slice(2);
    if (Object.hasOwn(parsed, key)) throw new Error(`Repeated option: --${key}. Supply each option once.`);
    if (equalsIndex > 2) {
      parsed[key] = value.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function usage(): Record<string, unknown> {
  return {
    userConfig: USER_CONFIG_PATH,
    privateConfigDirectoryEnvironment: "KANBAN_CARDS_CONFIG_DIR (absolute path outside the target repository)",
    repositoryConfig: REPO_CONFIG_NAME,
    commands: [
      "connect --url <workspace-url> --project-id <project-id> [--label Codex] [--repo <path>]",
      "setup [--url <api-url>] [--actor <label>] --token-stdin",
      "session",
      "projects",
      "create-project --name <name> [--description <text>] [--columns <comma-list-or-json>] [--idempotency-key <key>]",
      "bind --project <project-id> [--repo <path>]",
      "project [--project <project-id>] [--repo <path>]",
      "update-project [--project <project-id>] [--name <name>] [--description <text>] [--columns <comma-list-or-json>] --version <version>",
      "cards [--project <project-id>] [--next-actor human|agent|unassigned] [--priority High|Medium|Low|unset] [--blocked true|false] [--include-archived true|false]",
      "create-card [--project <project-id>] --title <title> [--body <text>] [--column <column-id>] [--position <number>] [--external-key <key>] [--idempotency-key <key>] [--next-actor human|agent|unassigned] [--next-action <text>] [--priority High|Medium|Low|unset] [--blocked-reason <text>]",
      "update-card [--project <project-id>] --card <card-id> [--title <title>] [--body <text>] [--next-actor human|agent|unassigned] [--next-action <text>] [--priority High|Medium|Low|unset] [--blocked-reason <text>] --version <version>",
      "move-card [--project <project-id>] --card <card-id> --column <column-id> [--position <number>] --version <version>",
      "archive-card [--project <project-id>] --card <card-id> --version <version>",
      "comment [--project <project-id>] --card <card-id> --text <text> [--idempotency-key <key>]",
      "activity [--project <project-id>] [--limit <count>]"
    ]
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
