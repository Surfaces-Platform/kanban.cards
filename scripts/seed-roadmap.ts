import type { AgentSpec, Board, Lane, Project, WorkItem } from "../src/types";

const ROADMAP_BOARD_NAME = "kanban.cards Product Roadmap";
const DEFAULT_PROJECT_ID = "kanban.cards:default";
const ROADMAP_FLOW_PROMPT = "Intake, Research, Plan, Draft, Review, Release";

type LaneTitle = "Intake" | "Plan" | "Release";
type BoardAction = "create" | "update" | "none";
type CardAction = "create" | "update" | "none";

interface ProjectsResponse {
  projects: Project[];
  activeProjectId?: string | null;
}

interface BoardsResponse {
  boards: Board[];
  activeBoardId?: string | null;
  activeProjectId?: string | null;
}

interface RoadmapCardSeed {
  title: string;
  laneTitle: LaneTitle;
  summary: string;
}

interface CardPlan {
  title: string;
  laneTitle: LaneTitle;
  laneId: string;
  itemId?: string;
  action: CardAction;
  patch?: Partial<WorkItem>;
}

export interface SeedRoadmapOptions {
  apiBaseUrl: string;
  apiToken: string;
  projectId?: string;
  dryRun?: boolean;
}

export interface SeedRoadmapReport {
  dryRun: boolean;
  projectId: string;
  projectName: string;
  boardName: string;
  boardId?: string;
  boardAction: BoardAction;
  cardActions: CardPlan[];
  warnings: string[];
}

const ROADMAP_CARDS: RoadmapCardSeed[] = [
  {
    title: "Close Auth0 production rollout",
    laneTitle: "Release",
    summary: "Confirm Auth0 dashboard settings, runtime env, smoke checks, rollout evidence, and rollback readiness."
  },
  {
    title: "Persist Team and Project model",
    laneTitle: "Plan",
    summary: "Store team and project records as durable access boundaries instead of relying only on seeded defaults."
  },
  {
    title: "Make boards project-scoped",
    laneTitle: "Plan",
    summary: "Ensure board lists, creation, navigation, and API access stay inside the selected project boundary."
  },
  {
    title: "Introduce AgentSession delegation",
    laneTitle: "Intake",
    summary: "Model delegated agent sessions with issuer, scope, capabilities, expiry, and revocation semantics."
  },
  {
    title: "Expand audit/provenance events",
    laneTitle: "Intake",
    summary: "Record actor, delegation, project, board, card, and policy context for sensitive workspace events."
  },
  {
    title: "Add sensitive-action policy gates",
    laneTitle: "Intake",
    summary: "Gate sensitive mutations with explicit policy checks and reviewable denial reasons."
  },
  {
    title: "Add member/invite UI",
    laneTitle: "Intake",
    summary: "Expose workspace membership, invitations, and role assignment for human operators."
  },
  {
    title: "Add board/project settings",
    laneTitle: "Intake",
    summary: "Expose settings for board metadata, project metadata, access posture, and operational controls."
  }
];

export async function seedRoadmap(options: SeedRoadmapOptions): Promise<SeedRoadmapReport> {
  const context = createApiContext(options);
  const projects = await apiRequest<ProjectsResponse>(context, "/projects");
  const project = selectProject(projects.projects || [], projects.activeProjectId, options.projectId);
  const warnings: string[] = [];

  const boardsResponse = await apiRequest<BoardsResponse>(context, `/boards?projectId=${encodeURIComponent(project.id)}`);
  const matchingBoards = (boardsResponse.boards || []).filter((board) => board.name === ROADMAP_BOARD_NAME);
  if (matchingBoards.length > 1) {
    warnings.push(`Found ${matchingBoards.length} boards named "${ROADMAP_BOARD_NAME}" in project ${project.id}; using ${matchingBoards[0].id}.`);
  }

  const template = genericAgentReviewTemplate();
  let board = matchingBoards[0];
  const boardAction = planBoardAction(board, template);

  const report: SeedRoadmapReport = {
    dryRun: Boolean(options.dryRun),
    projectId: project.id,
    projectName: project.name,
    boardName: ROADMAP_BOARD_NAME,
    boardId: board?.id,
    boardAction,
    cardActions: [],
    warnings
  };

  if (!options.dryRun) {
    if (!board) {
      board = await apiRequest<Board>(context, "/boards", {
        method: "POST",
        body: {
          projectId: project.id,
          name: ROADMAP_BOARD_NAME,
          lanes: template.lanes,
          agentSpecs: template.agentSpecs,
          flowPrompt: ROADMAP_FLOW_PROMPT,
          configDraft: null,
          isEditingFlow: false
        }
      });
    } else if (boardAction === "update") {
      board = await apiRequest<Board>(context, `/boards/${encodeURIComponent(board.id)}`, {
        method: "PATCH",
        body: {
          name: ROADMAP_BOARD_NAME,
          lanes: template.lanes,
          agentSpecs: template.agentSpecs,
          flowPrompt: ROADMAP_FLOW_PROMPT,
          configDraft: null,
          isEditingFlow: false
        }
      });
    }
    report.boardId = board.id;
  }

  const cardPlans = planCardActions(board, template.lanes);
  report.cardActions = cardPlans.map((plan) => ({ ...plan, patch: plan.patch ? { ...plan.patch } : undefined }));

  if (!options.dryRun && board) {
    for (const plan of cardPlans) {
      if (plan.action === "none") continue;
      const seed = ROADMAP_CARDS.find((card) => card.title === plan.title);
      if (!seed) continue;

      if (plan.action === "create") {
        const lane = findLane(template.lanes, seed.laneTitle);
        const created = await apiRequest<WorkItem>(context, `/boards/${encodeURIComponent(board.id)}/work-items`, {
          method: "POST",
          body: {
            title: seed.title,
            summary: seed.summary,
            laneId: lane.id,
            ownerAgentId: lane.defaultOwnerAgentId,
            reviewerAgentId: lane.defaultReviewerAgentId
          }
        });
        plan.itemId = created.id;
        continue;
      }

      if (plan.action === "update" && plan.itemId && plan.patch) {
        await apiRequest<WorkItem>(context, `/boards/${encodeURIComponent(board.id)}/work-items/${encodeURIComponent(plan.itemId)}`, {
          method: "PATCH",
          body: plan.patch
        });
      }
    }
    report.cardActions = cardPlans.map((plan) => ({ ...plan, patch: plan.patch ? { ...plan.patch } : undefined }));
  }

  return report;
}

export function formatSeedRoadmapReport(report: SeedRoadmapReport): string {
  const mode = report.dryRun ? "dry run" : "seed";
  const lines = [
    `Roadmap ${mode} for ${report.projectName} (${report.projectId})`,
    `Board: ${report.boardAction}${report.boardId ? ` ${report.boardId}` : ""} - ${report.boardName}`
  ];

  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  for (const card of report.cardActions) {
    lines.push(`Card: ${card.action} - ${card.title} -> ${card.laneTitle}`);
  }

  return `${lines.join("\n")}\n`;
}

function createApiContext(options: SeedRoadmapOptions): { apiBaseUrl: string; apiToken: string } {
  const apiBaseUrl = String(options.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const apiToken = String(options.apiToken || "").trim();
  if (!apiBaseUrl) throw new Error("KANBAN_CARDS_API_BASE_URL is required.");
  if (!apiToken) throw new Error("KANBAN_CARDS_API_TOKEN is required.");
  return { apiBaseUrl, apiToken };
}

function selectProject(projects: Project[], activeProjectId?: string | null, requestedProjectId?: string): Project {
  if (!projects.length) throw new Error("No kanban.cards projects are available.");

  if (requestedProjectId) {
    const project = projects.find((candidate) => candidate.id === requestedProjectId);
    if (!project) {
      const available = projects.map((candidate) => candidate.id).join(", ");
      throw new Error(`KANBAN_CARDS_PROJECT_ID=${requestedProjectId} was not found. Available projects: ${available}`);
    }
    return project;
  }

  return (
    projects.find((project) => project.id === activeProjectId)
    || projects.find((project) => project.id === DEFAULT_PROJECT_ID)
    || projects[0]
  );
}

function planBoardAction(board: Board | undefined, template: { lanes: Lane[]; agentSpecs: AgentSpec[] }): BoardAction {
  if (!board) return "create";
  const desired = {
    lanes: template.lanes,
    agentSpecs: template.agentSpecs,
    flowPrompt: ROADMAP_FLOW_PROMPT,
    configDraft: null,
    isEditingFlow: false
  };
  const current = {
    lanes: board.lanes || [],
    agentSpecs: board.agentSpecs || [],
    flowPrompt: board.flowPrompt || "",
    configDraft: board.configDraft || null,
    isEditingFlow: Boolean(board.isEditingFlow)
  };
  return stableJson(current) === stableJson(desired) ? "none" : "update";
}

function planCardActions(board: Board | undefined, lanes: Lane[]): CardPlan[] {
  return ROADMAP_CARDS.map((seed) => {
    const lane = findLane(lanes, seed.laneTitle);
    const matches = (board?.workItems || []).filter((item) => item.title === seed.title);
    const existing = matches[0];

    if (!existing) {
      return {
        title: seed.title,
        laneTitle: seed.laneTitle,
        laneId: lane.id,
        action: "create"
      };
    }

    const patch: Partial<WorkItem> = {};
    if (existing.laneId !== lane.id) patch.laneId = lane.id;
    if (existing.ownerAgentId !== lane.defaultOwnerAgentId) patch.ownerAgentId = lane.defaultOwnerAgentId;
    if (existing.reviewerAgentId !== lane.defaultReviewerAgentId) patch.reviewerAgentId = lane.defaultReviewerAgentId;
    if (!String(existing.summary || "").trim()) patch.summary = seed.summary;

    return {
      title: seed.title,
      laneTitle: seed.laneTitle,
      laneId: lane.id,
      itemId: existing.id,
      action: Object.keys(patch).length ? "update" : "none",
      patch: Object.keys(patch).length ? patch : undefined
    };
  });
}

async function apiRequest<T>(
  context: { apiBaseUrl: string; apiToken: string },
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = options.method || "GET";
  const response = await fetch(`${context.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${context.apiToken}`,
      "Content-Type": "application/json"
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${method} ${path} returned ${response.status}${body ? `: ${body}` : ""}`);
  }

  return response.json() as Promise<T>;
}

function genericAgentReviewTemplate(): { lanes: Lane[]; agentSpecs: AgentSpec[] } {
  const lanes = [
    laneWithAgents("Intake", "The request, owner, and expected output are clear.", "Research", "agent-coordinator", "agent-reviewer"),
    laneWithAgents("Research", "Relevant context and source material are gathered.", "Plan", "agent-researcher", "agent-reviewer"),
    laneWithAgents("Plan", "The approach, dependencies, and review points are explicit.", "Draft", "agent-coordinator", "agent-reviewer"),
    laneWithAgents("Draft", "The agent output is assembled for human review.", "Review", "agent-producer", "agent-reviewer"),
    laneWithAgents("Review", "Feedback, approvals, and change requests are resolved.", "Release", "agent-reviewer", "agent-coordinator"),
    laneWithAgents("Release", "The final output is ready to deliver or archive.", "", "agent-coordinator", "agent-reviewer")
  ];

  return {
    lanes,
    agentSpecs: [
      makeAgentSpec("agent-coordinator", "Coordinator Agent", "Workflow coordinator", ["intake", "plan", "release"], "Owns routing, blockers, and next-step clarity.", "Use the kanban.cards API to keep board state current."),
      makeAgentSpec("agent-researcher", "Research Agent", "Context researcher", ["research"], "Gathers source context and records open questions.", ""),
      makeAgentSpec("agent-producer", "Producer Agent", "Draft producer", ["draft"], "Produces the reviewable work output for the lane.", ""),
      makeAgentSpec("agent-reviewer", "Review Agent", "Reviewer", ["review"], "Checks outputs against gate criteria and records instructions.", "")
    ]
  };
}

function laneWithAgents(title: string, description = "", nextTitle = "", ownerAgentId = "", reviewerAgentId = ""): Lane {
  return {
    id: slugify(title),
    title,
    description,
    defaultOwnerAgentId: optionalText(ownerAgentId),
    defaultReviewerAgentId: optionalText(reviewerAgentId),
    gate: {
      title: `${title} gate`,
      checks: defaultGateChecks(title, nextTitle)
    }
  };
}

function makeAgentSpec(id: string, name: string, role = "", laneIds: string[] = [], instructions = "", skillNotes = ""): AgentSpec {
  return {
    id,
    name,
    role,
    laneIds,
    instructions,
    skillNotes
  };
}

function findLane(lanes: Lane[], title: LaneTitle): Lane {
  const lane = lanes.find((candidate) => candidate.title === title);
  if (!lane) throw new Error(`Roadmap template is missing the ${title} lane.`);
  return lane;
}

function defaultGateChecks(title: string, nextTitle = ""): string[] {
  return [
    "Output is reviewable.",
    "Blockers and open questions are captured.",
    nextTitle ? `Handoff to ${nextTitle} is clear.` : "Closeout decision is clear."
  ];
}

function optionalText(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function slugify(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseArgs(argv: string[]): { dryRun: boolean; help: boolean } {
  const args = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(`Usage: npm run roadmap:seed -- [--dry-run]

Required env:
  KANBAN_CARDS_API_BASE_URL  API base URL, for example https://kanban.cards/api
  KANBAN_CARDS_API_TOKEN     Admin compatibility bearer token

Optional env:
  KANBAN_CARDS_PROJECT_ID    Project ID to seed; defaults to the active project, then ${DEFAULT_PROJECT_ID}
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const report = await seedRoadmap({
    apiBaseUrl: process.env.KANBAN_CARDS_API_BASE_URL || "",
    apiToken: process.env.KANBAN_CARDS_API_TOKEN || "",
    projectId: process.env.KANBAN_CARDS_PROJECT_ID || undefined,
    dryRun: args.dryRun
  });
  process.stdout.write(formatSeedRoadmapReport(report));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
