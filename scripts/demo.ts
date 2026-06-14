import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createFileAgentTokenStore } from "../src/agent-token-store";
import { createBoard, createStateStore, findBoard, findComment, findWorkItem } from "../src/state-store";
import type { AgentSpec, Board, Lane, WorkItem, WorkItemComment } from "../src/types";

const execFileAsync = promisify(execFile);

const DEMO_BOARD_ID = "private-beta-security-release";
const DEMO_BOARD_NAME = "Private Beta Security Release";
const DEFAULT_API_URL = "http://127.0.0.1:4317/api";
const DEMO_DIR = path.resolve(process.env.KANBAN_CARDS_DEMO_DIR || ".demo");
const DEMO_API_URL = (process.env.KANBAN_CARDS_DEMO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
const DATA_PATH = path.join(DEMO_DIR, "kanban-cards-state.json");
const TOKEN_DATA_PATH = path.join(DEMO_DIR, "agent-access-tokens.json");
const CONFIG_DIR = path.join(DEMO_DIR, "configs");
const RUN_STATE_PATH = path.join(DEMO_DIR, "run-state.json");
const CLIENT_PATH = path.resolve(".agents", "skills", "kanban-cards", "scripts", "kanban-cards-client.mjs");

type AgentKey = "coordinator" | "risk" | "engineer" | "security";
type StepName =
  | "coordinator-intake"
  | "risk-triage"
  | "engineer-plan"
  | "engineer-implementation"
  | "security-change-request"
  | "engineer-evidence"
  | "security-approval"
  | "coordinator-closeout";
type CardKey = "releaseBrief" | "riskBrief" | "engineeringPlan" | "releaseImplementation";
type CommentKey = "securityChangeRequest";

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
    id: "agent-release-coordinator",
    name: "Release Coordinator",
    role: "Private beta release owner",
    laneIds: ["intake", "release-ready"],
    instructions: "Own launch scope, release ownership, security handoff, and final closeout."
  },
  {
    key: "risk",
    id: "agent-risk-triage",
    name: "Risk Triage Agent",
    role: "Launch risk analyst",
    laneIds: ["risk-triage"],
    instructions: "Identify token, event stream, database, and rollback risks before implementation starts."
  },
  {
    key: "engineer",
    id: "agent-release-engineer",
    name: "Release Engineer",
    role: "Security release implementer",
    laneIds: ["engineering-plan", "implementation", "security-review"],
    instructions: "Implement token rotation, live event verification, database readiness, and rollback evidence."
  },
  {
    key: "security",
    id: "agent-security-reviewer",
    name: "Security Reviewer",
    role: "Launch security reviewer",
    laneIds: ["security-review", "release-ready"],
    instructions: "Review token revocation, event replay, database initialization, and rollback evidence before release."
  }
];

const stepNames: StepName[] = [
  "coordinator-intake",
  "risk-triage",
  "engineer-plan",
  "engineer-implementation",
  "security-change-request",
  "engineer-evidence",
  "security-approval",
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
    process.stdout.write("Workflow verification passed.\n");
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
      label: `${agent.name} local access`
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
    "Workflow prepared.",
    "",
    `Board: ${DEMO_BOARD_NAME}`,
    `State: ${relativePath(DATA_PATH)}`,
    `Agent configs: ${relativePath(CONFIG_DIR)}`,
    "",
    "Run setup:",
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
      "Rotate private beta access tokens before launch",
      "--summary",
      "Coordinate token rotation, scoped agent access, rollback ownership, and launch evidence for the private beta.",
      "--lane",
      "intake",
      "--owner",
      "agent-release-coordinator",
      "--reviewer",
      "agent-security-reviewer"
    ]);
    runState.cards.releaseBrief = card.id;
    await cliJson<WorkItemComment>(runState, "coordinator", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Release Coordinator opened the release packet with production token rotation, scoped agent access, rollback owner, and verification evidence required before launch."
    ]);
    return [`Release Coordinator opened "${card.title}" in Intake.`];
  },

  async "risk-triage"(runState) {
    const card = await cliJson<WorkItem>(runState, "risk", [
      "create-card",
      "--title",
      "Token rotation risk triage",
      "--summary",
      "Assess access-token, event stream, database, and rollback risks before implementation starts.",
      "--lane",
      "risk-triage",
      "--owner",
      "agent-risk-triage",
      "--reviewer",
      "agent-security-reviewer"
    ]);
    runState.cards.riskBrief = card.id;
    await cliJson<WorkItemComment>(runState, "risk", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Risk Triage Agent identified stale local tokens, live event replay gaps, database migration timing, and rollback ownership as launch risks."
    ]);
    const moved = await cliJson<WorkItem>(runState, "risk", ["move-card", "--item", card.id, "--lane", "engineering-plan"]);
    return [`Risk Triage Agent moved "${moved.title}" to Engineering Plan.`];
  },

  async "engineer-plan"(runState) {
    const card = await cliJson<WorkItem>(runState, "engineer", [
      "create-card",
      "--title",
      "Security release implementation plan",
      "--summary",
      "Plan token rotation, event replay verification, database initialization, and production rollback handoff.",
      "--lane",
      "engineering-plan",
      "--owner",
      "agent-release-engineer",
      "--reviewer",
      "agent-security-reviewer"
    ]);
    runState.cards.engineeringPlan = card.id;
    await cliJson<WorkItemComment>(runState, "engineer", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Release Engineer wrote the implementation plan covering token revocation, scoped token setup, live event replay checks, database initialization, and rollback handoff."
    ]);
    const moved = await cliJson<WorkItem>(runState, "engineer", ["move-card", "--item", card.id, "--lane", "implementation"]);
    return [`Release Engineer advanced "${moved.title}" into Implementation.`];
  },

  async "engineer-implementation"(runState) {
    const card = await cliJson<WorkItem>(runState, "engineer", [
      "create-card",
      "--title",
      "Implement private beta token rotation",
      "--summary",
      "Rotate access tokens, verify live event replay, initialize database tables, and prepare rollback notes.",
      "--lane",
      "implementation",
      "--owner",
      "agent-release-engineer",
      "--reviewer",
      "agent-security-reviewer"
    ]);
    runState.cards.releaseImplementation = card.id;
    await cliJson<WorkItemComment>(runState, "engineer", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Release Engineer rotated stale tokens, verified live event replay after reconnect, initialized workspace and token tables, and attached rollback notes."
    ]);
    await cliJson<WorkItem>(runState, "engineer", [
      "update-card",
      "--item",
      card.id,
      "--summary",
      "Release Engineer completed token rotation, scoped agent access validation, live event replay checks, database initialization, and rollback notes before security review."
    ]);
    const moved = await cliJson<WorkItem>(runState, "engineer", ["move-card", "--item", card.id, "--lane", "security-review"]);
    return [`Release Engineer moved "${moved.title}" to Security Review.`];
  },

  async "security-change-request"(runState) {
    const implementationCardId = requireCard(runState, "releaseImplementation");
    const comment = await cliJson<WorkItemComment>(runState, "security", [
      "comment",
      "--item",
      implementationCardId,
      "--kind",
      "change_request",
      "--status",
      "open",
      "--text",
      "Security Reviewer opened this change request: hold release until token revocation evidence, event replay after reconnect, database initialization output, and rollback owner acknowledgement are attached."
    ]);
    runState.comments.securityChangeRequest = comment.id;
    return ["Security Reviewer opened a change request on release evidence."];
  },

  async "engineer-evidence"(runState) {
    const implementationCardId = requireCard(runState, "releaseImplementation");
    const commentId = requireComment(runState, "securityChangeRequest");
    await cliJson<WorkItemComment>(runState, "engineer", ["resolve-comment", "--item", implementationCardId, "--comment", commentId]);
    await cliJson<WorkItemComment>(runState, "engineer", [
      "comment",
      "--item",
      implementationCardId,
      "--kind",
      "progress",
      "--text",
      "Release Engineer resolved the change request with token revocation evidence, reconnect replay result, database initialization output, and rollback owner acknowledgement."
    ]);
    const updated = await cliJson<WorkItem>(runState, "engineer", [
      "update-card",
      "--item",
      implementationCardId,
      "--summary",
      "Release Engineer attached the security evidence pack: revoked token list, reconnect replay result, database initialization output, and rollback owner acknowledgement."
    ]);
    return [`Release Engineer attached evidence on "${updated.title}".`];
  },

  async "security-approval"(runState) {
    const implementationCardId = requireCard(runState, "releaseImplementation");
    await cliJson<WorkItemComment>(runState, "security", [
      "comment",
      "--item",
      implementationCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "Security Reviewer approved the release after token revocation, live event replay, database initialization, and rollback evidence matched the security gate."
    ]);
    await adminJson<WorkItem>(runState, `/boards/${encodeURIComponent(runState.boardId)}/work-items/${encodeURIComponent(implementationCardId)}`, {
      approvals: [{ by: "human-security-admin", text: "Security gate approved for private beta release.", createdAt: new Date().toISOString() }]
    }, "PATCH");
    const moved = await cliJson<WorkItem>(runState, "security", ["move-card", "--item", implementationCardId, "--lane", "release-ready"]);
    return [`Security Reviewer approved and moved "${moved.title}" to Release Ready.`];
  },

  async "coordinator-closeout"(runState) {
    const releaseCardId = requireCard(runState, "releaseBrief");
    await cliJson<WorkItemComment>(runState, "coordinator", [
      "comment",
      "--item",
      releaseCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "Release Coordinator closed the release packet. Launch owner: Release Coordinator. Rollback owner: Release Engineer. Security monitor: Security Reviewer watches token and event alerts."
    ]);
    await cliJson<WorkItem>(runState, "coordinator", [
      "update-card",
      "--item",
      releaseCardId,
      "--summary",
      "Release Coordinator closed the release after security approval, token rotation evidence, live event replay validation, database initialization, and rollback ownership were complete."
    ]);
    await adminJson<WorkItem>(runState, `/boards/${encodeURIComponent(runState.boardId)}/work-items/${encodeURIComponent(releaseCardId)}`, {
      delivered: true
    }, "PATCH");
    const moved = await cliJson<WorkItem>(runState, "coordinator", ["move-card", "--item", releaseCardId, "--lane", "release-ready"]);
    return [`Release Coordinator closed out "${moved.title}" in Release Ready.`];
  }
};

async function verifyDemo(): Promise<void> {
  const runState = await loadRunState();
  const store = createStateStore(runState.dataPath);
  const state = await store.read();
  const board = findBoard(state, runState.boardId);
  if (!board) throw new Error("Workflow board was not found.");

  assertBoardShape(board);
  if (runState.completedSteps.length !== stepNames.length || stepNames.some((step, index) => runState.completedSteps[index] !== step)) {
    throw new Error("Workflow steps are incomplete.");
  }

  const releaseCard = requireWorkItem(board, runState.cards.releaseBrief, "release packet card");
  const riskCard = requireWorkItem(board, runState.cards.riskBrief, "risk triage card");
  const planCard = requireWorkItem(board, runState.cards.engineeringPlan, "engineering plan card");
  const implementationCard = requireWorkItem(board, runState.cards.releaseImplementation, "release implementation card");
  if (releaseCard.laneId !== "release-ready") throw new Error("Release packet card is not in Release Ready.");
  if (riskCard.laneId !== "engineering-plan") throw new Error("Risk triage card is not in Engineering Plan.");
  if (planCard.laneId !== "implementation") throw new Error("Engineering plan card is not in Implementation.");
  if (implementationCard.laneId !== "release-ready") throw new Error("Release implementation card is not in Release Ready.");
  if (!releaseCard.delivered) throw new Error("Release packet was not marked delivered.");
  if (!releaseCard.comments.some((comment) => comment.author === "agent-release-coordinator")) throw new Error("Release coordinator comment missing.");
  if (!riskCard.comments.some((comment) => comment.author === "agent-risk-triage" && comment.text.includes("live event replay gaps"))) {
    throw new Error("Risk triage evidence missing.");
  }
  if (!planCard.comments.some((comment) => comment.author === "agent-release-engineer" && comment.text.includes("database initialization"))) {
    throw new Error("Engineering plan evidence missing.");
  }
  if (!implementationCard.comments.some((comment) => comment.author === "agent-release-engineer" && comment.text.includes("Release Engineer resolved the change request"))) {
    throw new Error("Release engineering evidence missing.");
  }
  if (!implementationCard.comments.some((comment) => comment.author === "agent-security-reviewer" && comment.text.includes("Security Reviewer approved"))) {
    throw new Error("Security reviewer approval missing.");
  }
  if (!implementationCard.approvals.length) throw new Error("Security approval state missing.");

  const changeRequest = findComment(implementationCard, runState.comments.securityChangeRequest || "");
  if (!changeRequest) throw new Error("Security reviewer change request was not found.");
  if (changeRequest.kind !== "change_request") throw new Error("Security reviewer comment is not a change request.");
  if (changeRequest.status !== "resolved") throw new Error("Security reviewer change request is not resolved.");
  if (!releaseCard.summary.includes("rollback ownership")) throw new Error("Release closeout summary is incomplete.");
  assertOperationalBoardCopy(board);
}

function createDemoBoard(): Board {
  return createBoard({
    id: DEMO_BOARD_ID,
    name: DEMO_BOARD_NAME,
    lanes: [
      lane(
        "intake",
        "Intake",
        "Release scope, launch owner, rollback owner, and required evidence are clear.",
        "agent-release-coordinator",
        "agent-security-reviewer",
        ["Release scope is named.", "Launch owner is assigned.", "Evidence requirements are explicit."]
      ),
      lane(
        "risk-triage",
        "Risk Triage",
        "Token, event stream, database, and rollback risks are identified before implementation.",
        "agent-risk-triage",
        "agent-security-reviewer",
        ["Token risk is assessed.", "Live event replay risk is assessed.", "Rollback ownership is assessed."]
      ),
      lane(
        "engineering-plan",
        "Engineering Plan",
        "The implementation path covers token rotation, event replay, database readiness, and rollback handoff.",
        "agent-release-engineer",
        "agent-security-reviewer",
        ["Token rotation steps are planned.", "Event replay checks are planned.", "Database readiness is planned."]
      ),
      lane(
        "implementation",
        "Implementation",
        "Release changes and supporting evidence are prepared before security review.",
        "agent-release-engineer",
        "agent-security-reviewer",
        ["Scoped access is validated.", "Live event replay is checked.", "Rollback notes are attached."]
      ),
      lane(
        "security-review",
        "Security Review",
        "Security evidence is reviewed and change requests are resolved before release readiness.",
        "agent-release-engineer",
        "agent-security-reviewer",
        ["Token revocation evidence is present.", "Database initialization output is present.", "Rollback owner acknowledgement is present."]
      ),
      lane(
        "release-ready",
        "Release Ready",
        "Security approval, delivery state, launch ownership, and monitoring handoff are complete.",
        "agent-release-coordinator",
        "agent-security-reviewer",
        ["Security approval is complete.", "Delivery state is current.", "Monitoring handoff is clear."]
      )
    ],
    agentSpecs: agents.map(agentSpec),
    flowPrompt: "Intake, Risk Triage, Engineering Plan, Implementation, Security Review, Release Ready",
    workItems: [],
    selectedId: null
  });
}

function lane(
  id: string,
  title: string,
  description: string,
  defaultOwnerAgentId: string,
  defaultReviewerAgentId: string,
  checks: string[]
): Lane {
  return {
    id,
    title,
    description,
    defaultOwnerAgentId,
    defaultReviewerAgentId,
    gate: {
      title: `${title} gate`,
      checks
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

async function adminJson<T>(runState: DemoRunState, pathSuffix: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${runState.apiBaseUrl}${pathSuffix}`, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Admin API request failed with ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
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
      throw new Error("Workflow state is missing. Run npm run demo:prepare first.");
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
  for (const id of ["intake", "risk-triage", "engineering-plan", "implementation", "security-review", "release-ready"]) {
    if (!laneIds.has(id)) throw new Error(`Missing workflow lane: ${id}`);
  }
  const agentIds = new Set(board.agentSpecs.map((agent) => agent.id));
  for (const agent of agents) {
    if (!agentIds.has(agent.id)) throw new Error(`Missing workflow agent: ${agent.id}`);
  }
}

function assertOperationalBoardCopy(board: Board): void {
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
  const visibleCopy = [
    board.name,
    board.flowPrompt,
    ...board.lanes.flatMap((candidate) => [
      candidate.title,
      candidate.description,
      candidate.gate?.title || "",
      ...(candidate.gate?.checks || [])
    ]),
    ...board.agentSpecs.flatMap((agent) => [agent.name, agent.role, agent.instructions, agent.skillNotes || ""]),
    ...board.workItems.flatMap((item) => [
      item.title,
      item.summary,
      ...item.comments.map((comment) => comment.text)
    ])
  ];
  const offending = visibleCopy.find((text) => bannedPatterns.some((pattern) => pattern.test(text)));
  if (offending) throw new Error(`Workflow board copy contains fourth-wall language: ${offending}`);
}

function requireWorkItem(board: Board, itemId: string | undefined, label: string): WorkItem {
  if (!itemId) throw new Error(`Missing ${label} id in workflow run state.`);
  const item = findWorkItem(board, itemId);
  if (!item) throw new Error(`Missing ${label} on workflow board.`);
  return item;
}

function requireCard(runState: DemoRunState, key: CardKey): string {
  const id = runState.cards[key];
  if (!id) throw new Error(`Step prerequisite missing: ${key}. Run the earlier workflow steps first.`);
  return id;
}

function requireComment(runState: DemoRunState, key: CommentKey): string {
  const id = runState.comments[key];
  if (!id) throw new Error(`Step prerequisite missing: ${key}. Run the earlier workflow steps first.`);
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
    "kanban.cards local workflow runner",
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
