import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createFileAgentTokenStore } from "../src/agent-token-store";
import { createBoard, createStateStore, findBoard, findComment, findWorkItem } from "../src/state-store";
import type { AgentSpec, Board, Lane, WorkItem, WorkItemComment } from "../src/types";

const execFileAsync = promisify(execFile);

const DEMO_BOARD_ID = "agent-trip-planner-mvp-buildout";
const DEMO_BOARD_NAME = "Agent Trip Planner MVP Buildout";
const DEFAULT_API_URL = "http://127.0.0.1:4317/api";
const DEMO_DIR = path.resolve(process.env.KANBAN_CARDS_DEMO_DIR || ".demo");
const DEMO_API_URL = (process.env.KANBAN_CARDS_DEMO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
const DATA_PATH = path.join(DEMO_DIR, "kanban-cards-state.json");
const TOKEN_DATA_PATH = path.join(DEMO_DIR, "agent-access-tokens.json");
const CONFIG_DIR = path.join(DEMO_DIR, "configs");
const RUN_STATE_PATH = path.join(DEMO_DIR, "run-state.json");
const CLIENT_PATH = path.resolve(".agents", "skills", "kanban-cards", "scripts", "kanban-cards-client.mjs");

type AgentKey = "product" | "research" | "designer" | "engineer" | "reviewer";
type StepName =
  | "product-intake"
  | "traveller-research"
  | "designer-flow"
  | "engineer-build"
  | "reviewer-change-request"
  | "engineer-constraints"
  | "reviewer-approval"
  | "product-closeout";
type CardKey = "productBrief" | "researchBrief" | "experienceMap" | "planningSlice";
type CommentKey = "constraintChangeRequest";

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
    key: "product",
    id: "agent-product-lead",
    name: "Product Lead",
    role: "Trip planner product owner",
    laneIds: ["product-intake", "pilot-ready"],
    instructions: "Own the traveller problem, pilot owner, success metric, and support handoff."
  },
  {
    key: "research",
    id: "agent-traveller-research",
    name: "Traveller Research Agent",
    role: "Traveller needs research",
    laneIds: ["traveller-research"],
    instructions: "Capture traveller goals, planning constraints, and decision points before design starts."
  },
  {
    key: "designer",
    id: "agent-experience-designer",
    name: "Experience Designer",
    role: "Planning flow designer",
    laneIds: ["experience-design"],
    instructions: "Map the traveller intake, itinerary review, and booking handoff flow."
  },
  {
    key: "engineer",
    id: "agent-product-engineer",
    name: "Product Engineer",
    role: "Trip planner builder",
    laneIds: ["build"],
    instructions: "Build the first planning slice and resolve review findings before pilot."
  },
  {
    key: "reviewer",
    id: "agent-qa-reviewer",
    name: "QA Reviewer",
    role: "Pilot readiness reviewer",
    laneIds: ["review", "pilot-ready"],
    instructions: "Review traveller constraint coverage, itinerary quality, and booking handoff readiness."
  }
];

const stepNames: StepName[] = [
  "product-intake",
  "traveller-research",
  "designer-flow",
  "engineer-build",
  "reviewer-change-request",
  "engineer-constraints",
  "reviewer-approval",
  "product-closeout"
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
  async "product-intake"(runState) {
    const card = await cliJson<WorkItem>(runState, "product", [
      "create-card",
      "--title",
      "Build agent trip planner for independent travellers",
      "--summary",
      "Build a trip-planning agent that turns a traveller's goal, dates, budget, mobility needs, and preferences into a day-by-day itinerary with booking handoff.",
      "--lane",
      "product-intake",
      "--owner",
      "agent-product-lead",
      "--reviewer",
      "agent-qa-reviewer"
    ]);
    runState.cards.productBrief = card.id;
    await cliJson<WorkItemComment>(runState, "product", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Product Lead created this product brief in Product Intake for a 5-day Lisbon trip with fixed dates, a $2,400 budget, walking limits, and hotel-first booking handoff."
    ]);
    return [`Product Lead opened "${card.title}" in Product Intake.`];
  },

  async "traveller-research"(runState) {
    const card = await cliJson<WorkItem>(runState, "research", [
      "create-card",
      "--title",
      "Traveller planning constraints research",
      "--summary",
      "Collect traveller needs that the planning agent must ask before proposing a route or booking handoff.",
      "--lane",
      "traveller-research",
      "--owner",
      "agent-traveller-research",
      "--reviewer",
      "agent-qa-reviewer"
    ]);
    runState.cards.researchBrief = card.id;
    await cliJson<WorkItemComment>(runState, "research", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Traveller Research Agent created this research card, added date windows, total budget, pace, mobility limits, passport or visa uncertainty, cancellation tolerance, and neighbourhood preferences, then moved it toward design."
    ]);
    const moved = await cliJson<WorkItem>(runState, "research", ["move-card", "--item", card.id, "--lane", "experience-design"]);
    return [`Traveller Research Agent captured planning constraints and moved "${moved.title}" to Experience Design.`];
  },

  async "designer-flow"(runState) {
    const card = await cliJson<WorkItem>(runState, "designer", [
      "create-card",
      "--title",
      "Intake-to-itinerary experience map",
      "--summary",
      "Design the path from trip goal to clarified constraints, itinerary options, and booking handoff.",
      "--lane",
      "experience-design",
      "--owner",
      "agent-experience-designer",
      "--reviewer",
      "agent-qa-reviewer"
    ]);
    runState.cards.experienceMap = card.id;
    await cliJson<WorkItemComment>(runState, "designer", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Experience Designer created the experience map, ordered destination, dates, budget, traveller count, mobility needs, interests, and cancellation tolerance before day plans, then moved the card into Build."
    ]);
    const moved = await cliJson<WorkItem>(runState, "designer", ["move-card", "--item", card.id, "--lane", "build"]);
    return [`Experience Designer moved "${moved.title}" into Build.`];
  },

  async "engineer-build"(runState) {
    const card = await cliJson<WorkItem>(runState, "engineer", [
      "create-card",
      "--title",
      "Build first trip-planning slice",
      "--summary",
      "Build the first agent flow for trip intake, itinerary drafting, and booking handoff.",
      "--lane",
      "build",
      "--owner",
      "agent-product-engineer",
      "--reviewer",
      "agent-qa-reviewer"
    ]);
    runState.cards.planningSlice = card.id;
    await cliJson<WorkItemComment>(runState, "engineer", [
      "comment",
      "--item",
      card.id,
      "--kind",
      "progress",
      "--text",
      "Product Engineer created the build slice for Lisbon, five days, food and architecture interests, then added itinerary drafting, lodging notes, transit suggestions, and booking handoff."
    ]);
    await cliJson<WorkItem>(runState, "engineer", [
      "update-card",
      "--item",
      card.id,
      "--summary",
      "Product Engineer updated the planning slice to handle trip goal, dates, interests, itinerary drafting, and booking handoff before moving it to Review."
    ]);
    const moved = await cliJson<WorkItem>(runState, "engineer", ["move-card", "--item", card.id, "--lane", "review"]);
    return [`Product Engineer built the first planning slice and moved "${moved.title}" to Review.`];
  },

  async "reviewer-change-request"(runState) {
    const planningCardId = requireCard(runState, "planningSlice");
    const comment = await cliJson<WorkItemComment>(runState, "reviewer", [
      "comment",
      "--item",
      planningCardId,
      "--kind",
      "change_request",
      "--status",
      "open",
      "--text",
      "QA Reviewer opened this change request: block pilot readiness until budget, mobility needs, passport or visa uncertainty, cancellation tolerance, and incomplete-input handling are required before itinerary generation."
    ]);
    runState.comments.constraintChangeRequest = comment.id;
    return ["QA Reviewer opened a change request on required traveller constraints."];
  },

  async "engineer-constraints"(runState) {
    const planningCardId = requireCard(runState, "planningSlice");
    const commentId = requireComment(runState, "constraintChangeRequest");
    await cliJson<WorkItemComment>(runState, "engineer", ["resolve-comment", "--item", planningCardId, "--comment", commentId]);
    await cliJson<WorkItemComment>(runState, "engineer", [
      "comment",
      "--item",
      planningCardId,
      "--kind",
      "progress",
      "--text",
      "Product Engineer resolved the change request by adding budget range, mobility limits, passport or visa uncertainty, cancellation tolerance, and missing-answer prompts that block itinerary generation until resolved."
    ]);
    const updated = await cliJson<WorkItem>(runState, "engineer", [
      "update-card",
      "--item",
      planningCardId,
      "--summary",
      "Product Engineer updated the planning slice so traveller constraints are required before itinerary generation, with booking handoff, pacing notes, and support escalation preserved."
    ]);
    return [`Product Engineer resolved the constraint finding on "${updated.title}".`];
  },

  async "reviewer-approval"(runState) {
    const planningCardId = requireCard(runState, "planningSlice");
    await cliJson<WorkItemComment>(runState, "reviewer", [
      "comment",
      "--item",
      planningCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "QA Reviewer approved the build slice and moved it to Pilot Ready after required traveller constraints, incomplete-input handling, itinerary pacing, and booking handoff were covered."
    ]);
    const moved = await cliJson<WorkItem>(runState, "reviewer", ["move-card", "--item", planningCardId, "--lane", "pilot-ready"]);
    return [`QA Reviewer approved and moved "${moved.title}" to Pilot Ready.`];
  },

  async "product-closeout"(runState) {
    const productCardId = requireCard(runState, "productBrief");
    await cliJson<WorkItemComment>(runState, "product", [
      "comment",
      "--item",
      productCardId,
      "--kind",
      "progress",
      "--status",
      "resolved",
      "--text",
      "Product Lead updated the original brief and moved it to Pilot Ready. Pilot owner: Product Lead. Success metric: first itinerary accepted without support. Support handoff: QA Reviewer monitors failed constraint checks."
    ]);
    await cliJson<WorkItem>(runState, "product", [
      "update-card",
      "--item",
      productCardId,
      "--summary",
      "Product Lead closed the buildout after agent-created research, design, build, QA approval, required traveller constraints, booking handoff, and support monitoring."
    ]);
    const moved = await cliJson<WorkItem>(runState, "product", ["move-card", "--item", productCardId, "--lane", "pilot-ready"]);
    return [`Product Lead closed out "${moved.title}" in Pilot Ready.`];
  }
};

async function verifyDemo(): Promise<void> {
  const runState = await loadRunState();
  const store = createStateStore(runState.dataPath);
  const state = await store.read();
  const board = findBoard(state, runState.boardId);
  if (!board) throw new Error("Workflow board was not found.");

  assertBoardShape(board);
  const productCard = requireWorkItem(board, runState.cards.productBrief, "product brief card");
  const researchCard = requireWorkItem(board, runState.cards.researchBrief, "traveller research card");
  const designCard = requireWorkItem(board, runState.cards.experienceMap, "experience map card");
  const planningCard = requireWorkItem(board, runState.cards.planningSlice, "planning slice card");
  if (productCard.laneId !== "pilot-ready") throw new Error("Product brief card is not in Pilot Ready.");
  if (researchCard.laneId !== "experience-design") throw new Error("Traveller research card is not in Experience Design.");
  if (designCard.laneId !== "build") throw new Error("Experience map card is not in Build.");
  if (planningCard.laneId !== "pilot-ready") throw new Error("Planning slice card is not in Pilot Ready.");
  if (!productCard.comments.some((comment) => comment.author === "agent-product-lead")) throw new Error("Product lead comment missing.");
  if (!researchCard.comments.some((comment) => comment.author === "agent-traveller-research" && comment.text.includes("mobility limits"))) {
    throw new Error("Traveller research evidence missing.");
  }
  if (!designCard.comments.some((comment) => comment.author === "agent-experience-designer" && comment.text.includes("cancellation tolerance"))) {
    throw new Error("Experience design evidence missing.");
  }
  if (!planningCard.comments.some((comment) => comment.author === "agent-product-engineer" && comment.text.includes("Product Engineer resolved the change request"))) {
    throw new Error("Product engineering constraint evidence missing.");
  }
  if (!planningCard.comments.some((comment) => comment.author === "agent-qa-reviewer" && comment.text.includes("QA Reviewer approved"))) {
    throw new Error("QA reviewer approval missing.");
  }

  const changeRequest = findComment(planningCard, runState.comments.constraintChangeRequest || "");
  if (!changeRequest) throw new Error("QA reviewer change request was not found.");
  if (changeRequest.kind !== "change_request") throw new Error("QA reviewer comment is not a change request.");
  if (changeRequest.status !== "resolved") throw new Error("QA reviewer change request is not resolved.");
  if (!productCard.summary.includes("support monitoring")) throw new Error("Product closeout summary is incomplete.");
  assertOperationalBoardCopy(board);
}

function createDemoBoard(): Board {
  return createBoard({
    id: DEMO_BOARD_ID,
    name: DEMO_BOARD_NAME,
    lanes: [
      lane(
        "product-intake",
        "Product Intake",
        "Traveller problem, pilot owner, success metric, and target trip are clear.",
        "agent-product-lead",
        "agent-qa-reviewer",
        ["Traveller goal is named.", "Target trip is concrete.", "Pilot owner is assigned."]
      ),
      lane(
        "traveller-research",
        "Traveller Research",
        "Traveller goals, dates, budget, mobility needs, and uncertainty are captured.",
        "agent-traveller-research",
        "agent-qa-reviewer",
        ["Budget and dates are captured.", "Mobility needs are captured.", "Passport or visa uncertainty is captured."]
      ),
      lane(
        "experience-design",
        "Experience Design",
        "The traveller intake, itinerary review, and booking handoff are mapped before build.",
        "agent-experience-designer",
        "agent-qa-reviewer",
        ["Required inputs are placed before itinerary generation.", "Itinerary tradeoffs are visible.", "Booking handoff is clear."]
      ),
      lane(
        "build",
        "Build",
        "The first planning slice handles intake, itinerary drafting, and missing-input handling.",
        "agent-product-engineer",
        "agent-qa-reviewer",
        ["Trip intake is implemented.", "Itinerary drafting is implemented.", "Incomplete inputs are handled."]
      ),
      lane(
        "review",
        "Review",
        "Traveller constraints, itinerary quality, and booking handoff are checked before pilot.",
        "agent-product-engineer",
        "agent-qa-reviewer",
        ["Traveller constraints are enforced.", "Itinerary pacing is realistic.", "Booking handoff is ready."]
      ),
      lane(
        "pilot-ready",
        "Pilot Ready",
        "Pilot owner, QA approval, success metric, and support handoff are in place.",
        "agent-product-lead",
        "agent-qa-reviewer",
        ["QA approval is complete.", "Success metric is named.", "Support handoff is clear."]
      )
    ],
    agentSpecs: agents.map(agentSpec),
    flowPrompt: "Product Intake, Traveller Research, Experience Design, Build, Review, Pilot Ready",
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
  for (const id of ["product-intake", "traveller-research", "experience-design", "build", "review", "pilot-ready"]) {
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
