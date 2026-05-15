import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createFileAgentTokenStore } from "../src/agent-token-store";
import { createBoard, createStateStore, findBoard, findComment, findWorkItem } from "../src/state-store";
import type { AgentSpec, Board, Lane, WorkItem, WorkItemComment } from "../src/types";

const execFileAsync = promisify(execFile);

const DEMO_BOARD_ID = "demo-board-launch-brief";
const DEMO_BOARD_NAME = "Orchestrated Agents Demo - Launch Brief";
const DEFAULT_API_URL = "http://127.0.0.1:4317/api";
const DEMO_DIR = path.resolve(process.env.KANBAN_CARDS_DEMO_DIR || ".demo");
const DEMO_API_URL = (process.env.KANBAN_CARDS_DEMO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
const DATA_PATH = path.join(DEMO_DIR, "kanban-cards-state.json");
const TOKEN_DATA_PATH = path.join(DEMO_DIR, "agent-access-tokens.json");
const CONFIG_DIR = path.join(DEMO_DIR, "configs");
const RUN_STATE_PATH = path.join(DEMO_DIR, "run-state.json");
const CLIENT_PATH = path.resolve(".agents", "skills", "kanban-cards", "scripts", "kanban-cards-client.mjs");

type AgentKey = "coordinator" | "researcher" | "producer" | "reviewer";
type StepName =
  | "coordinator-intake"
  | "researcher-research"
  | "producer-draft"
  | "reviewer-change-request"
  | "producer-revise"
  | "reviewer-release"
  | "coordinator-closeout";
type CardKey = "launchBrief" | "researchBrief" | "draftBrief";
type CommentKey = "reviewChangeRequest";

interface DemoAgent {
  key: AgentKey;
  id: string;
  name: string;
  role: string;
  laneIds: string[];
  instructions: string;
}

interface DemoRunState {
  boardId: string;
  apiBaseUrl: string;
  dataPath: string;
  tokenDataPath: string;
  configs: Record<AgentKey, string>;
  cards: Partial<Record<CardKey, string>>;
  comments: Partial<Record<CommentKey, string>>;
  completedSteps: StepName[];
}

const agents: DemoAgent[] = [
  {
    key: "coordinator",
    id: "agent-coordinator",
    name: "Coordinator Agent",
    role: "Workflow coordinator",
    laneIds: ["intake", "release"],
    instructions: "Own routing, blockers, and final status for the launch brief demo."
  },
  {
    key: "researcher",
    id: "agent-researcher",
    name: "Research Agent",
    role: "Context researcher",
    laneIds: ["research"],
    instructions: "Gather source context and capture findings for the demo launch brief."
  },
  {
    key: "producer",
    id: "agent-producer",
    name: "Producer Agent",
    role: "Draft producer",
    laneIds: ["draft"],
    instructions: "Turn research into a reviewable launch brief and respond to feedback."
  },
  {
    key: "reviewer",
    id: "agent-reviewer",
    name: "Review Agent",
    role: "Reviewer",
    laneIds: ["review", "release"],
    instructions: "Review the draft, request changes, and approve release readiness."
  }
];

const stepNames: StepName[] = [
  "coordinator-intake",
  "researcher-research",
  "producer-draft",
  "reviewer-change-request",
  "producer-revise",
  "reviewer-release",
  "coordinator-closeout"
];

async function main(): Promise<void> {
  const [command, maybeStep] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "prepare") {
    await prepareDemo();
    return;
  }

  if (command === "reset") {
    await resetDemo();
    process.stdout.write(`Removed ${relativePath(DEMO_DIR)}\n`);
    return;
  }

  if (command === "step") {
    if (!isStepName(maybeStep)) {
      throw new Error(`Missing or unknown step. Use one of: ${stepNames.join(", ")}`);
    }
    await runStep(maybeStep);
    return;
  }

  if (command === "verify") {
    await verifyDemo();
    process.stdout.write("Demo verification passed.\n");
    return;
  }

  throw new Error(`Unknown demo command: ${command}`);
}

async function prepareDemo(): Promise<void> {
  await ensureBuiltClient();
  await resetDemo();
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const board = createDemoBoard();
  const store = createStateStore(DATA_PATH);
  await store.write({
    boards: [board],
    activeBoardId: board.id,
    templates: []
  });

  const tokenStore = createFileAgentTokenStore(TOKEN_DATA_PATH);
  await tokenStore.ensureReady();

  const configs = {} as Record<AgentKey, string>;
  for (const agent of agents) {
    const created = await tokenStore.create({
      boardId: board.id,
      agentId: agent.id,
      label: `${agent.name} demo access`
    });
    const configPath = path.join(CONFIG_DIR, `${agent.key}.json`);
    configs[agent.key] = configPath;
    const output = await runClient([
      "setup",
      "--config",
      configPath,
      "--url",
      DEMO_API_URL,
      "--token",
      created.token,
      "--board",
      board.id,
      "--agent",
      agent.id
    ]);
    if (output.includes(created.token)) throw new Error(`Setup leaked token for ${agent.id}.`);
  }

  const runState: DemoRunState = {
    boardId: board.id,
    apiBaseUrl: DEMO_API_URL,
    dataPath: DATA_PATH,
    tokenDataPath: TOKEN_DATA_PATH,
    configs,
    cards: {},
    comments: {},
    completedSteps: []
  };
  await saveRunState(runState);

  process.stdout.write([
    "Demo prepared.",
    "",
    `Board: ${DEMO_BOARD_NAME}`,
    `State: ${relativePath(DATA_PATH)}`,
    `Agent configs: ${relativePath(CONFIG_DIR)}`,
    "",
    "Recording setup:",
    "1. Start the app: npm run demo:server",
    "2. Open http://127.0.0.1:4317",
    "3. Run one step at a time:",
    ...stepNames.map((step) => `   npm run demo:step -- ${step}`),
    "",
    "Reset when done: npm run demo:reset",
    ""
  ].join("\n"));
}

async function resetDemo(): Promise<void> {
  await fs.rm(DEMO_DIR, { recursive: true, force: true });
}

async function runStep(stepName: StepName): Promise<void> {
  const runState = await loadRunState();
  if (runState.completedSteps.includes(stepName)) {
    process.stdout.write(`${stepName} already completed. Run npm run demo:reset && npm run demo:prepare to replay from scratch.\n`);
    return;
  }

  const lines = await stepHandlers[stepName](runState);
  runState.completedSteps.push(stepName);
  await saveRunState(runState);

  process.stdout.write([
    `[${stepName}]`,
    ...lines.map((line) => `- ${line}`),
    nextStepLine(runState),
    ""
  ].filter(Boolean).join("\n"));
}

const stepHandlers: Record<StepName, (runState: DemoRunState) => Promise<string[]>> = {
  async "coordinator-intake"(runState) {
    const card = await cliJson<WorkItem>(runState, "coordinator", [
      "create-card",
      "--title",
      "Launch brief: Orchestrated agents demo",
      "--summary",
      "Coordinate the recordable demo showing scoped agents creating, updating, reviewing, and releasing work.",
      "--lane",
      "intake",
      "--owner",
      "agent-coordinator",
      "--reviewer",
      "agent-reviewer"
    ]);
    runState.cards.launchBrief = card.id;
    await cliJson<WorkItemComment>(runState, "coordinator", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Intake created. The launch brief now has an owner, reviewer, and recording sequence."
    ]);
    return [`Coordinator Agent created "${card.title}" in Intake.`];
  },

  async "researcher-research"(runState) {
    const card = await cliJson<WorkItem>(runState, "researcher", [
      "create-card",
      "--title",
      "Research demo proof points",
      "--summary",
      "Gather the concrete proof points the recording should show.",
      "--lane",
      "research",
      "--owner",
      "agent-researcher",
      "--reviewer",
      "agent-reviewer"
    ]);
    runState.cards.researchBrief = card.id;
    await cliJson<WorkItemComment>(runState, "researcher", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Findings captured: scoped tokens, per-agent configs, visible card movement, and reviewer feedback."
    ]);
    const moved = await cliJson<WorkItem>(runState, "researcher", ["move-card", "--item", card.id, "--lane", "draft"]);
    return [`Research Agent added findings and moved "${moved.title}" to Draft.`];
  },

  async "producer-draft"(runState) {
    const card = await cliJson<WorkItem>(runState, "producer", [
      "create-card",
      "--title",
      "Draft launch demo script",
      "--summary",
      "Create the talk track and demo sequence for the screen recording.",
      "--lane",
      "draft",
      "--owner",
      "agent-producer",
      "--reviewer",
      "agent-reviewer"
    ]);
    runState.cards.draftBrief = card.id;
    await cliJson<WorkItem>(runState, "producer", [
      "update-card",
      "--item",
      card.id,
      "--summary",
      "Draft includes setup framing, visible agent actions, reviewer feedback, and release closeout."
    ]);
    const moved = await cliJson<WorkItem>(runState, "producer", ["move-card", "--item", card.id, "--lane", "review"]);
    return [`Producer Agent drafted the script and moved "${moved.title}" to Review.`];
  },

  async "reviewer-change-request"(runState) {
    const draftCardId = requireCard(runState, "draftBrief");
    const comment = await cliJson<WorkItemComment>(runState, "reviewer", [
      "comment",
      "--item",
      draftCardId,
      "--kind",
      "change_request",
      "--status",
      "open",
      "--text",
      "Show one explicit revision before release so the recording proves reviewer-agent control."
    ]);
    runState.comments.reviewChangeRequest = comment.id;
    return ["Review Agent added an open change request to the draft card."];
  },

  async "producer-revise"(runState) {
    const draftCardId = requireCard(runState, "draftBrief");
    const commentId = requireComment(runState, "reviewChangeRequest");
    await cliJson<WorkItemComment>(runState, "producer", ["resolve-comment", "--item", draftCardId, "--comment", commentId]);
    await cliJson<WorkItemComment>(runState, "producer", [
      "comment",
      "--item",
      draftCardId,
      "--kind",
      "progress",
      "--text",
      "Revision applied. The demo now includes a clear reviewer request and resolved response."
    ]);
    const updated = await cliJson<WorkItem>(runState, "producer", [
      "update-card",
      "--item",
      draftCardId,
      "--summary",
      "Revised script includes the reviewer-request moment and a clean release handoff."
    ]);
    return [`Producer Agent resolved reviewer feedback and updated "${updated.title}".`];
  },

  async "reviewer-release"(runState) {
    const draftCardId = requireCard(runState, "draftBrief");
    await cliJson<WorkItemComment>(runState, "reviewer", [
      "comment",
      "--item",
      draftCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "Approved for release. The workflow now shows creation, revision, review, and advancement."
    ]);
    const moved = await cliJson<WorkItem>(runState, "reviewer", ["move-card", "--item", draftCardId, "--lane", "release"]);
    return [`Review Agent approved and moved "${moved.title}" to Release.`];
  },

  async "coordinator-closeout"(runState) {
    const launchCardId = requireCard(runState, "launchBrief");
    await cliJson<WorkItemComment>(runState, "coordinator", [
      "comment",
      "--item",
      launchCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "Closeout complete. The recording path is ready: board visible, agents scoped, work advanced."
    ]);
    await cliJson<WorkItem>(runState, "coordinator", [
      "update-card",
      "--item",
      launchCardId,
      "--summary",
      "Recording path complete. The board shows the orchestrated launch brief workflow end to end."
    ]);
    const moved = await cliJson<WorkItem>(runState, "coordinator", ["move-card", "--item", launchCardId, "--lane", "release"]);
    return [`Coordinator Agent closed out "${moved.title}" in Release.`];
  }
};

async function verifyDemo(): Promise<void> {
  const runState = await loadRunState();
  const store = createStateStore(runState.dataPath);
  const state = await store.read();
  const board = findBoard(state, runState.boardId);
  if (!board) throw new Error("Demo board was not found.");

  assertBoardShape(board);
  const launchCard = requireWorkItem(board, runState.cards.launchBrief, "launch brief card");
  const researchCard = requireWorkItem(board, runState.cards.researchBrief, "research card");
  const draftCard = requireWorkItem(board, runState.cards.draftBrief, "draft card");
  if (launchCard.laneId !== "release") throw new Error("Launch brief card is not in Release.");
  if (researchCard.laneId !== "draft") throw new Error("Research card is not in Draft.");
  if (draftCard.laneId !== "release") throw new Error("Draft card is not in Release.");
  if (!launchCard.comments.some((comment) => comment.author === "agent-coordinator")) throw new Error("Coordinator comment missing.");
  if (!researchCard.comments.some((comment) => comment.author === "agent-researcher")) throw new Error("Researcher comment missing.");
  if (!draftCard.comments.some((comment) => comment.author === "agent-producer")) throw new Error("Producer comment missing.");
  if (!draftCard.comments.some((comment) => comment.author === "agent-reviewer")) throw new Error("Reviewer comment missing.");

  const changeRequest = findComment(draftCard, runState.comments.reviewChangeRequest || "");
  if (!changeRequest) throw new Error("Reviewer change request was not found.");
  if (changeRequest.kind !== "change_request") throw new Error("Reviewer comment is not a change request.");
  if (changeRequest.status !== "resolved") throw new Error("Reviewer change request is not resolved.");
}

function createDemoBoard(): Board {
  return createBoard({
    id: DEMO_BOARD_ID,
    name: DEMO_BOARD_NAME,
    lanes: [
      lane("intake", "Intake", "The request, owner, and recording goal are clear.", "agent-coordinator", "agent-reviewer"),
      lane("research", "Research", "Proof points and setup details are gathered.", "agent-researcher", "agent-reviewer"),
      lane("draft", "Draft", "The demo script and sequence are assembled.", "agent-producer", "agent-reviewer"),
      lane("review", "Review", "Reviewer feedback is captured and resolved.", "agent-producer", "agent-reviewer"),
      lane("release", "Release", "The recording path is ready to run.", "agent-coordinator", "agent-reviewer")
    ],
    agentSpecs: agents.map(agentSpec),
    flowPrompt: "Intake, Research, Draft, Review, Release",
    workItems: [],
    selectedId: null
  });
}

function lane(id: string, title: string, description: string, defaultOwnerAgentId: string, defaultReviewerAgentId: string): Lane {
  return {
    id,
    title,
    description,
    defaultOwnerAgentId,
    defaultReviewerAgentId,
    gate: {
      title: `${title} gate`,
      checks: ["Output is reviewable.", "Blockers and open questions are captured.", `${title} handoff is clear.`]
    }
  };
}

function agentSpec(agent: DemoAgent): AgentSpec {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    laneIds: agent.laneIds,
    instructions: agent.instructions,
    skillNotes: "$kanban-cards"
  };
}

async function cliJson<T>(runState: DemoRunState, agentKey: AgentKey, args: string[]): Promise<T> {
  const configPath = runState.configs[agentKey];
  if (!configPath) throw new Error(`Missing config for ${agentKey}. Run npm run demo:prepare.`);
  const output = await runClient([args[0], "--config", configPath, ...args.slice(1)]);
  return JSON.parse(output) as T;
}

async function runClient(args: string[]): Promise<string> {
  await ensureBuiltClient();
  const { stdout } = await execFileAsync(process.execPath, [CLIENT_PATH, ...args], {
    env: demoClientEnv(),
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

async function ensureBuiltClient(): Promise<void> {
  try {
    await fs.access(CLIENT_PATH);
  } catch (_error) {
    throw new Error("Missing generated agent helper. Run npm run build first.");
  }
}

function demoClientEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KANBAN_CARDS_API_BASE_URL;
  delete env.KANBAN_CARDS_API_TOKEN;
  delete env.KANBAN_CARDS_BOARD_ID;
  delete env.KANBAN_CARDS_AGENT_ID;
  delete env.INSTRUCT_API_BASE_URL;
  delete env.INSTRUCT_API_TOKEN;
  return env;
}

async function loadRunState(): Promise<DemoRunState> {
  try {
    const raw = await fs.readFile(RUN_STATE_PATH, "utf8");
    return JSON.parse(raw) as DemoRunState;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("Demo state is missing. Run npm run demo:prepare first.");
    }
    throw error;
  }
}

async function saveRunState(runState: DemoRunState): Promise<void> {
  await fs.mkdir(path.dirname(RUN_STATE_PATH), { recursive: true });
  await fs.writeFile(RUN_STATE_PATH, `${JSON.stringify(runState, null, 2)}\n`);
}

function assertBoardShape(board: Board): void {
  const laneIds = new Set(board.lanes.map((candidate) => candidate.id));
  for (const id of ["intake", "research", "draft", "review", "release"]) {
    if (!laneIds.has(id)) throw new Error(`Missing demo lane: ${id}`);
  }
  const agentIds = new Set(board.agentSpecs.map((agent) => agent.id));
  for (const agent of agents) {
    if (!agentIds.has(agent.id)) throw new Error(`Missing demo agent: ${agent.id}`);
  }
}

function requireWorkItem(board: Board, itemId: string | undefined, label: string): WorkItem {
  if (!itemId) throw new Error(`Missing ${label} id in demo run state.`);
  const item = findWorkItem(board, itemId);
  if (!item) throw new Error(`Missing ${label} on demo board.`);
  return item;
}

function requireCard(runState: DemoRunState, key: CardKey): string {
  const id = runState.cards[key];
  if (!id) throw new Error(`Step prerequisite missing: ${key}. Run the earlier demo steps first.`);
  return id;
}

function requireComment(runState: DemoRunState, key: CommentKey): string {
  const id = runState.comments[key];
  if (!id) throw new Error(`Step prerequisite missing: ${key}. Run the earlier demo steps first.`);
  return id;
}

function isStepName(value: string | undefined): value is StepName {
  return Boolean(value && stepNames.includes(value as StepName));
}

function nextStepLine(runState: DemoRunState): string {
  const next = stepNames.find((step) => !runState.completedSteps.includes(step));
  return next ? `Next: npm run demo:step -- ${next}` : "Next: npm run demo:verify";
}

function printUsage(): void {
  process.stdout.write([
    "kanban.cards demo harness",
    "",
    "Commands:",
    "  npm run demo:prepare",
    "  npm run demo:server",
    "  npm run demo:step -- <step-name>",
    "  npm run demo:verify",
    "  npm run demo:reset",
    "",
    "Steps:",
    ...stepNames.map((step) => `  ${step}`),
    ""
  ].join("\n"));
}

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
