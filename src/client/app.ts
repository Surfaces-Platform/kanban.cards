import type { AgentCapability, AgentSpec, Board, BoardDraft, BoardTemplate, Lane, Project, PublicTeamInvite, PublicTeamMember, PublicTokenRecord, Team, TeamRole, WorkItem, WorkItemComment, WorkspaceState } from "../types";

declare global {
  interface Window {
    KANBAN_CARDS_API_BASE_URL?: string;
    INSTRUCT_API_BASE_URL?: string;
    KANBAN_CARDS_API_TOKEN?: string;
    INSTRUCT_API_TOKEN?: string;
  }
}

type AnyRecord = Record<string, any>;
type AliasMap = Map<string, string>;
type FormControlElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type TemplateLike = Omit<BoardTemplate, "createdAt"> & { createdAt?: string; builtIn: boolean };
type CreatedAgentTokenPayload = PublicTokenRecord & { token?: string };
type AttentionTone = "neutral" | "ok" | "warn" | "danger";
type ProjectDialogMode = "create" | "settings";

interface AttentionState {
  label: string;
  tone: AttentionTone;
}

interface WorkItemCurrentState {
  lane: Lane | null;
  comments: WorkItemComment[];
  latestComment: WorkItemComment | null;
  openRequests: WorkItemComment[];
  openChangeRequests: WorkItemComment[];
  openQuestions: WorkItemComment[];
  openInstructions: WorkItemComment[];
  openBlockers: any[];
  approvals: number;
  delivered: boolean;
  attention: AttentionState;
}

interface LiveWorkspaceEvent {
  id: string;
  type: "workspace_changed";
  boardId: string | null;
  payload: AnyRecord;
  createdAt: string;
}

interface InspectorActivityEvent {
  id: string;
  type: string;
  boardId: string | null;
  cardId: string | null;
  payload: AnyRecord;
  actor: AnyRecord | null;
  delegation: AnyRecord | null;
  createdAt: string;
}

type ActorKind = "human" | "agent" | "service" | "session" | "unknown";

interface ActorRef {
  kind: ActorKind;
  id: string;
  label: string;
  detail: string;
  initials: string;
  badge: string;
  title: string;
  sessionId?: string;
  delegatedBy?: string | null;
  projectId?: string | null;
  capabilities?: string[];
  status?: string;
}

interface AuthSession {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  roles: string[];
  surfaceAccess: string[];
  teamId: string;
  projectId: string;
  memberId: string | null;
  role: TeamRole | null;
  isTeamMember: boolean;
  projectIds: string[];
}

interface TeamSettingsPayload {
  team: Team;
  projects: Project[];
  members: PublicTeamMember[];
  invites: PublicTeamInvite[];
  currentMember: PublicTeamMember | null;
}

interface FlowAiDraftPayload {
  summary: string;
  warnings: string[];
  draft: BoardDraft;
  model?: string;
  provider?: string;
}

interface FlowApplyPayload {
  board: Board;
  warnings: string[];
  movedCards: Array<{ cardId: string; title: string; fromLaneId: string; toLaneId: string }>;
}

interface FlowAiRequestScope {
  requestId: number;
  boardId: string;
  contextKey: string;
}

interface FlowApplyRequestScope {
  requestId: number;
  boardId: string;
}

interface AgentConnectRequestScope {
  epoch: number;
  boardId: string;
  agentId: string;
}

interface InspectorActivityRequestScope {
  requestId: number;
  boardId: string;
  cardId: string;
}

type ToastTone = "neutral" | "success" | "warning" | "ok" | "warn";

interface ToastOptions {
  message: string;
  title?: string;
  tone?: ToastTone;
  persistent?: boolean;
  durationMs?: number;
  key?: string;
}

const API_BASE_URL = window.KANBAN_CARDS_API_BASE_URL || window.INSTRUCT_API_BASE_URL || "/api";
const API_TOKEN = window.KANBAN_CARDS_API_TOKEN || window.INSTRUCT_API_TOKEN || "";
const POLL_INTERVAL_MS = 5000;
const MAX_LANES = 8;
const MIN_LANES = 2;
const OPEN_REQUEST_COMMENT_KINDS = ["instruction", "question", "change_request"] as const;
const DEFAULT_TEAM_ID = "kanban.cards:team";
const DEFAULT_PROJECT_ID = "kanban.cards:default";
const DEFAULT_TEAM_NAME = "kanban.cards";
const DEFAULT_PROJECT_NAME = "kanban.cards";
const FLOW_AI_TOAST_KEY = "flow-ai";
const AGENT_SESSION_CAPABILITIES: AgentCapability[] = ["view", "create", "update", "comment", "move"];
const AGENT_SESSION_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  view: "View",
  create: "Create cards",
  update: "Update cards",
  comment: "Comment",
  move: "Move cards"
};

const BUILT_IN_TEMPLATES: TemplateLike[] = [
  {
    id: "builtin-generic-agent-review",
    name: "Generic Agent Review",
    description: "A neutral review flow for agent work from intake through release.",
    builtIn: true,
    lanes: withUniqueLaneIds([
      laneWithAgents("Intake", "The request, owner, and expected output are clear.", "Research", "agent-coordinator", "agent-reviewer"),
      laneWithAgents("Research", "Relevant context and source material are gathered.", "Plan", "agent-researcher", "agent-reviewer"),
      laneWithAgents("Plan", "The approach, dependencies, and review points are explicit.", "Draft", "agent-coordinator", "agent-reviewer"),
      laneWithAgents("Draft", "The agent output is assembled for human review.", "Review", "agent-producer", "agent-reviewer"),
      laneWithAgents("Review", "Feedback, approvals, and change requests are resolved.", "Release", "agent-reviewer", "agent-coordinator"),
      laneWithAgents("Release", "The final output is ready to deliver or archive.", "", "agent-coordinator", "agent-reviewer")
    ]),
    agentSpecs: [
      makeAgentSpec("agent-coordinator", "Coordinator Agent", "Workflow coordinator", ["intake", "plan", "release"], "Owns routing, blockers, and next-step clarity.", "Use the kanban.cards API to keep board state current."),
      makeAgentSpec("agent-researcher", "Research Agent", "Context researcher", ["research"], "Gathers source context and records open questions.", ""),
      makeAgentSpec("agent-producer", "Producer Agent", "Draft producer", ["draft"], "Produces the reviewable work output for the lane.", ""),
      makeAgentSpec("agent-reviewer", "Review Agent", "Reviewer", ["review"], "Checks outputs against gate criteria and records instructions.", "")
    ]
  }
];

let state: WorkspaceState = freshWorkspaceState();
let flowMessage = "";
let flowMessageTone: "neutral" | "warning" | "success" = "neutral";
let flowAiLoading = false;
let flowAiError = "";
let flowAiSummary = "";
let flowAiWarnings: string[] = [];
let flowApplyInFlight = false;
let flowAiRequestId = 0;
let flowAdvancedOpen = false;
let templateFormOpen = false;
let editingTemplateId: string | null = null;
let workItemDialogOpen = false;
let workItemDialogLaneId: string | null = null;
let flowActionsMenuOpen = false;
let deleteBoardDialogOpen = false;
let agentConnectDialogOpen = false;
let agentConnectAgentId: string | null = null;
let agentConnectTokens: PublicTokenRecord[] = [];
let agentConnectToken: CreatedAgentTokenPayload | null = null;
let agentConnectLoading = false;
let agentConnectError = "";
let agentConnectRequestEpoch = 0;
let projectDialogOpen = false;
let projectDialogMode: ProjectDialogMode = "settings";
let projectDialogSaving = false;
let projectDialogError = "";
let boardSettingsDialogOpen = false;
let boardSettingsSaving = false;
let boardSettingsError = "";
let teamSettingsDialogOpen = false;
let teamSettingsLoading = false;
let teamSettingsSaving = false;
let teamSettingsError = "";
let teamSettingsData: TeamSettingsPayload | null = null;
let teamInviteAcceptUrl = "";
let projectActionInFlight = false;
let inspectorActivityBoardId: string | null = null;
let inspectorActivityCardId: string | null = null;
let inspectorActivityEvents: InspectorActivityEvent[] = [];
let inspectorActivityLoading = false;
let inspectorActivityUnavailable = false;
let inspectorActivityError = "";
let inspectorActivityRequestId = 0;
let inspectorDrawerOpen = false;
let apiOnline = false;
let saveQueue: Promise<unknown> = Promise.resolve();
let lastPersistedState = "";
let apiWarningShown = false;
let eventSource: EventSource | null = null;
let pendingRemoteRefresh = false;
let pendingRemoteRefreshToastShown = false;
let remoteRefreshInFlight = false;
let authSession: AuthSession | null = null;
let authSessionLoaded = false;

const boardCanvas = document.querySelector("#board-canvas") as HTMLElement;
const inspectorPanel = document.querySelector("#inspector-panel") as HTMLElement;
const editFlowButton = document.querySelector("#edit-flow") as HTMLButtonElement | null;
const boardSettingsButton = document.querySelector("#board-settings") as HTMLButtonElement | null;
const projectSelect = document.querySelector("#project-select") as HTMLSelectElement | null;
const projectSettingsButton = document.querySelector("#project-settings") as HTMLButtonElement | null;
const newProjectButton = document.querySelector("#new-project") as HTMLButtonElement | null;
const boardSelect = document.querySelector("#board-select") as HTMLSelectElement | null;
const newBoardButton = document.querySelector("#new-board") as HTMLButtonElement | null;
const boardTitle = document.querySelector("#board-title") as HTMLElement | null;
const accountControl = document.querySelector("#account-control") as HTMLElement | null;
const toastRegion = document.querySelector("#toast-region") as HTMLElement | null;
const modalRoot = document.querySelector("#modal-root") as HTMLElement | null;

function clone<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadState(): Promise<WorkspaceState> {
  try {
    const response = await fetch(`${API_BASE_URL}/state`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`State request failed with ${response.status}`);
    const nextState = normalizeWorkspace(await response.json());
    apiOnline = true;
    lastPersistedState = JSON.stringify(nextState);
    return nextState;
  } catch (error) {
    apiOnline = false;
    showApiWarning("API unavailable. Showing a local fallback board.");
    return freshWorkspaceState();
  }
}

async function loadAuthSession(): Promise<void> {
  try {
    const response = await fetch("/auth/session", {
      headers: { Accept: "application/json" }
    });
    authSession = response.ok ? await response.json() as AuthSession : null;
  } catch (_error) {
    authSession = null;
  } finally {
    authSessionLoaded = true;
    renderAccountControl();
  }
}

function freshWorkspaceState(): WorkspaceState {
  const now = new Date().toISOString();
  const team = createTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, createdAt: now, updatedAt: now });
  const project = createProject({ id: DEFAULT_PROJECT_ID, teamId: team.id, name: DEFAULT_PROJECT_NAME, createdAt: now, updatedAt: now });
  const board = createBoard("Untitled board", { projectId: project.id });
  return {
    team,
    projects: [project],
    activeProjectId: project.id,
    members: [],
    invites: [],
    boards: [board],
    activeBoardId: board.id,
    templates: []
  };
}

function migrateSingleBoardState(rawState: any): WorkspaceState {
  const board = createBoard("Untitled board", {
    lanes: rawState?.lanes || [],
    workItems: rawState?.workItems || [],
    selectedId: rawState?.selectedId || null,
    flowPrompt: rawState?.flowPrompt || "",
    configDraft: rawState?.configDraft || null,
    isEditingFlow: Boolean(rawState?.isEditingFlow)
  });

  return normalizeWorkspace({
    boards: [board],
    activeBoardId: board.id,
    templates: []
  });
}

function createBoard(name: string, overrides: Partial<Board> = {}): Board {
  const now = new Date().toISOString();
  const projectId = overrides.projectId || DEFAULT_PROJECT_ID;
  const board = normalizeBoard({
    id: makeId("board"),
    projectId,
    name,
    lanes: [],
    agentSpecs: [],
    workItems: [],
    selectedId: null,
    flowPrompt: "",
    configDraft: null,
    isEditingFlow: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }, projectId, new Set([projectId]));
  if (!board) throw new Error("Unable to create board.");
  return board;
}

function normalizeWorkspace(rawState: any): WorkspaceState {
  const team = normalizeTeam(rawState?.team) || createTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME });
  const projects: Project[] = Array.isArray(rawState?.projects)
    ? withUniqueProjectIds(rawState.projects.map((project: any) => normalizeProject(project, team.id)).filter(isNonNull), team.id)
    : [];
  if (!projects.length) projects.push(createProject({ id: DEFAULT_PROJECT_ID, teamId: team.id, name: DEFAULT_PROJECT_NAME }));
  const projectIds = new Set(projects.map((project) => project.id));
  const fallbackProjectId = projectIds.has(DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : projects[0].id;
  const boards: Board[] = Array.isArray(rawState?.boards)
    ? rawState.boards.map((board: any) => normalizeBoard(board, fallbackProjectId, projectIds)).filter(isNonNull)
    : [];

  if (!boards.length) boards.push(createBoard("Untitled board", { projectId: fallbackProjectId }));

  const activeProjectId = projectIds.has(String(rawState?.activeProjectId)) ? String(rawState.activeProjectId) : fallbackProjectId;
  const activeProjectBoards = boards.filter((board) => board.projectId === activeProjectId);
  const activeBoardId = activeProjectBoards.some((board) => board.id === rawState?.activeBoardId)
    ? rawState.activeBoardId
    : activeProjectBoards[0]?.id || "";

  const templates: BoardTemplate[] = Array.isArray(rawState?.templates)
    ? rawState.templates.map(normalizeTemplate).filter(isNonNull)
    : [];
  const members: PublicTeamMember[] = Array.isArray(rawState?.members)
    ? rawState.members.map((member: any) => normalizeTeamMember(member, team.id)).filter(isNonNull)
    : [];

  return { team, projects, activeProjectId, members, invites: [], boards, activeBoardId, templates };
}

function createTeam(input: Partial<Team> = {}): Team {
  const now = new Date().toISOString();
  return {
    id: String(input.id || DEFAULT_TEAM_ID).trim() || DEFAULT_TEAM_ID,
    name: String(input.name || DEFAULT_TEAM_NAME).trim() || DEFAULT_TEAM_NAME,
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now)
  };
}

function createProject(input: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: String(input.id || makeId("project")).trim() || makeId("project"),
    teamId: String(input.teamId || DEFAULT_TEAM_ID).trim() || DEFAULT_TEAM_ID,
    name: String(input.name || "Untitled project").trim() || "Untitled project",
    description: String(input.description || "").trim(),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now)
  };
}

function normalizeTeam(rawTeam: any): Team | null {
  if (!rawTeam || typeof rawTeam !== "object") return null;
  const id = String(rawTeam.id || "").trim();
  if (!id) return null;
  return createTeam(rawTeam);
}

function normalizeProject(rawProject: any, fallbackTeamId: string): Project | null {
  if (!rawProject || typeof rawProject !== "object") return null;
  const id = String(rawProject.id || "").trim();
  const name = String(rawProject.name || "").trim();
  if (!id || !name) return null;
  return createProject({ ...rawProject, id, name, teamId: rawProject.teamId || fallbackTeamId });
}

function normalizeTeamMember(rawMember: any, fallbackTeamId: string): PublicTeamMember | null {
  if (!rawMember || typeof rawMember !== "object") return null;
  const id = String(rawMember.id || "").trim();
  const userId = String(rawMember.userId || "").trim();
  const email = String(rawMember.email || "").trim();
  if (!id || !userId || !email) return null;
  const role = isTeamRole(rawMember.role) ? rawMember.role : "member";
  const now = new Date().toISOString();
  return {
    id,
    teamId: String(rawMember.teamId || fallbackTeamId).trim() || fallbackTeamId,
    userId,
    email,
    name: String(rawMember.name || email).trim() || email,
    role,
    projectIds: normalizeProjectIds(rawMember.projectIds),
    createdAt: String(rawMember.createdAt || now),
    updatedAt: String(rawMember.updatedAt || now),
    lastSeenAt: String(rawMember.lastSeenAt || now)
  };
}

function isTeamRole(value: unknown): value is TeamRole {
  return value === "owner" || value === "admin" || value === "member";
}

function normalizeProjectIds(value: unknown): string[] {
  const ids = Array.isArray(value)
    ? value.map((projectId) => String(projectId || "").trim()).filter(Boolean)
    : [];
  return ids.length ? ids : ["*"];
}

function withUniqueProjectIds(projects: Project[], fallbackTeamId: string): Project[] {
  const used = new Map<string, number>();
  return projects.map((project) => {
    const baseId = project.id || makeId("project");
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    return {
      ...project,
      id: nextCount === 1 ? baseId : `${baseId}-${nextCount}`,
      teamId: project.teamId || fallbackTeamId
    };
  });
}

function normalizeBoard(rawBoard: any, fallbackProjectId: string = DEFAULT_PROJECT_ID, projectIds: Set<string> = new Set([DEFAULT_PROJECT_ID])): Board | null {
  if (!rawBoard || typeof rawBoard !== "object") return null;

  const rawLaneRecords: AnyRecord[] = Array.isArray(rawBoard.lanes) ? rawBoard.lanes.filter(isRecord) : [];
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: AnyRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords: AnyRecord[] = Array.isArray(rawBoard.agentSpecs) ? rawBoard.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: AnyRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  const normalizedLanes = lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases));

  const workItems: WorkItem[] = Array.isArray(rawBoard.workItems)
    ? rawBoard.workItems.map((item: any) => normalizeWorkItem(item, normalizedLanes, laneAliases, agentIds, agentAliases)).filter(isNonNull)
    : [];
  const selectedId = workItems.some((item: WorkItem) => item.id === rawBoard.selectedId)
    ? rawBoard.selectedId
    : null;
  const configDraft = normalizeDraft(rawBoard.configDraft);
  const name = String(rawBoard.name || "Untitled board").trim() || "Untitled board";
  const requestedProjectId = String(rawBoard.projectId || "").trim();
  const projectId = requestedProjectId && projectIds.has(requestedProjectId) ? requestedProjectId : fallbackProjectId;

  return {
    id: String(rawBoard.id || makeId("board")),
    projectId,
    name,
    lanes: normalizedLanes,
    agentSpecs,
    workItems,
    selectedId,
    flowPrompt: typeof rawBoard.flowPrompt === "string" ? rawBoard.flowPrompt : "",
    configDraft,
    isEditingFlow: Boolean(rawBoard.isEditingFlow && configDraft),
    createdAt: rawBoard.createdAt || new Date().toISOString(),
    updatedAt: rawBoard.updatedAt || new Date().toISOString()
  };
}

function normalizeTemplate(rawTemplate: any): BoardTemplate | null {
  if (!rawTemplate || typeof rawTemplate !== "object") return null;

  const rawLaneRecords: AnyRecord[] = Array.isArray(rawTemplate.lanes) ? rawTemplate.lanes.filter(isRecord) : [];
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: AnyRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const name = String(rawTemplate.name || "").trim();
  if (!name || !lanes.length) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords: AnyRecord[] = Array.isArray(rawTemplate.agentSpecs) ? rawTemplate.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: AnyRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));

  return {
    id: String(rawTemplate.id || makeId("template")),
    name,
    description: String(rawTemplate.description || "").trim(),
    builtIn: false,
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases)),
    agentSpecs,
    createdAt: rawTemplate.createdAt || new Date().toISOString()
  };
}

function normalizeDraft(draft: any): BoardDraft | null {
  if (!draft || !Array.isArray(draft.lanes)) return null;
  const rawLaneRecords: AnyRecord[] = draft.lanes.filter(isRecord);
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: AnyRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords: AnyRecord[] = Array.isArray(draft.agentSpecs) ? draft.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: AnyRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  return {
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases)),
    agentSpecs
  };
}

function normalizeLane(lane: any): Lane | null {
  if (!lane || typeof lane !== "object") return null;

  const title = String(lane.title || "").trim();
  if (!title) return null;

  const description = String(lane.description || "").trim();
  const id = slugify(lane.id || title) || slugify(title);
  const gateTitle = String(lane.gate?.title || `${title} gate`).trim();
  const checks = Array.isArray(lane.gate?.checks)
    ? lane.gate.checks.map((check: any) => String(check || "").trim()).filter(Boolean)
    : defaultGateChecks(title);

  return {
    id,
    title,
    description,
    defaultOwnerAgentId: optionalText(lane.defaultOwnerAgentId),
    defaultReviewerAgentId: optionalText(lane.defaultReviewerAgentId),
    gate: {
      title: gateTitle,
      checks: checks.length ? checks : defaultGateChecks(title)
    }
  };
}

function normalizeAgentSpec(rawAgent: any, laneIds: Set<string> = new Set(), laneAliases: AliasMap = new Map()): AgentSpec | null {
  if (!rawAgent || typeof rawAgent !== "object") return null;
  const name = String(rawAgent.name || "").trim();
  const id = slugify(rawAgent.id || name) || slugify(name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: String(rawAgent.role || "").trim(),
    laneIds: Array.isArray(rawAgent.laneIds)
      ? rawAgent.laneIds.map((laneId: any) => resolveAlias(laneId, laneAliases) || slugify(laneId)).filter((laneId: string) => laneIds.has(laneId))
      : [],
    instructions: String(rawAgent.instructions || "").trim(),
    skillNotes: String(rawAgent.skillNotes || "").trim()
  };
}

function normalizeWorkItem(
  rawItem: any,
  lanes: Lane[] = [],
  laneAliases: AliasMap = new Map(),
  agentIds: Set<string> = new Set(),
  agentAliases: AliasMap = new Map()
): WorkItem | null {
  if (!rawItem || typeof rawItem !== "object") return null;
  const title = String(rawItem.title || "").trim();
  if (!title) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const fallbackLaneId = lanes[0]?.id || "";
  const requestedLaneId = String(rawItem.laneId || "").trim();
  const resolvedLaneId = resolveAlias(requestedLaneId, laneAliases) || requestedLaneId;
  const now = new Date().toISOString();
  return {
    id: String(rawItem.id || makeId("item")),
    title,
    summary: String(rawItem.summary || "").trim(),
    laneId: laneIds.has(resolvedLaneId) ? resolvedLaneId : fallbackLaneId,
    requesterMemberId: optionalText(rawItem.requesterMemberId),
    ownerMemberId: optionalText(rawItem.ownerMemberId),
    reviewerMemberId: optionalText(rawItem.reviewerMemberId),
    ownerAgentId: normalizeLinkedAgentId(rawItem.ownerAgentId, agentIds, agentAliases),
    reviewerAgentId: normalizeLinkedAgentId(rawItem.reviewerAgentId, agentIds, agentAliases),
    blockers: Array.isArray(rawItem.blockers) ? rawItem.blockers : [],
    approvals: Array.isArray(rawItem.approvals) ? rawItem.approvals : [],
    completed: Boolean(rawItem.completed),
    delivered: Boolean(rawItem.delivered),
    comments: Array.isArray(rawItem.comments) ? rawItem.comments.map(normalizeComment).filter(isNonNull) : [],
    createdAt: String(rawItem.createdAt || now),
    updatedAt: String(rawItem.updatedAt || now)
  };
}

function normalizeComment(rawComment: any): WorkItemComment | null {
  if (!rawComment || typeof rawComment !== "object") return null;
  const text = String(rawComment.text || "").trim();
  if (!text) return null;
  const now = new Date().toISOString();
  const kind = ["progress", "instruction", "question", "change_request", "note"].includes(String(rawComment.kind))
    ? String(rawComment.kind) as WorkItemComment["kind"]
    : "note";
  const status = ["open", "acknowledged", "resolved"].includes(String(rawComment.status))
    ? String(rawComment.status) as WorkItemComment["status"]
    : "open";
  return {
    id: String(rawComment.id || makeId("comment")),
    kind,
    status,
    text,
    author: String(rawComment.author || "agent").trim() || "agent",
    createdAt: String(rawComment.createdAt || now),
    updatedAt: String(rawComment.updatedAt || rawComment.createdAt || now)
  };
}

function normalizeLaneAgentDefaults(lane: Lane, agentIds: Set<string> = new Set(), agentAliases: AliasMap = new Map()): Lane {
  const ownerAgentId = normalizeLinkedAgentId(lane.defaultOwnerAgentId, agentIds, agentAliases);
  const reviewerAgentId = normalizeLinkedAgentId(lane.defaultReviewerAgentId, agentIds, agentAliases);
  return {
    ...lane,
    defaultOwnerAgentId: ownerAgentId,
    defaultReviewerAgentId: reviewerAgentId
  };
}

function saveState() {
  persistState(state);
}

function persistState(nextState: WorkspaceState): void {
  const normalized = normalizeWorkspace(clone(nextState));
  const serialized = JSON.stringify(normalized);
  if (serialized === lastPersistedState) return;
  lastPersistedState = serialized;

  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      const response = await fetch(`${API_BASE_URL}/state`, {
        method: "PUT",
        headers: apiHeaders(true),
        credentials: "same-origin",
        body: serialized
      });
      if (!response.ok) throw new Error(`State save failed with ${response.status}`);
      const savedState = normalizeWorkspace(await response.json());
      lastPersistedState = JSON.stringify(savedState);
      apiOnline = true;
    })
    .catch(() => {
      apiOnline = false;
      showApiWarning("Board changes are not saved because the API is unavailable.");
    });
}

function apiHeaders(includeContentType: boolean): HeadersInit {
  const headers: Record<string, string> = {};
  headers.Accept = "application/json";
  if (includeContentType) headers["Content-Type"] = "application/json";
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  return headers;
}

async function fetchApiJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...apiHeaders(Boolean(init.body)),
      ...(init.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function reloadWorkspaceStateFromApi(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/state`, {
    headers: apiHeaders(false),
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(`State request failed with ${response.status}`);
  const nextState = normalizeWorkspace(await response.json());
  state = nextState;
  lastPersistedState = JSON.stringify(nextState);
  apiOnline = true;
  apiWarningShown = false;
}

function liveEventsUrl(): string {
  return new URL(`${API_BASE_URL.replace(/\/$/, "")}/events`, window.location.origin).toString();
}

function startLiveUpdates(): void {
  if (typeof EventSource === "undefined") return;
  if (eventSource) eventSource.close();

  eventSource = new EventSource(liveEventsUrl(), { withCredentials: true });
  eventSource.addEventListener("open", () => {
    apiOnline = true;
  });
  eventSource.addEventListener("workspace_changed", (event) => {
    handleWorkspaceChangedEvent(event as MessageEvent<string>);
  });
  eventSource.addEventListener("error", () => {
    apiOnline = false;
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void applyPendingRemoteRefresh();
  });
}

function handleWorkspaceChangedEvent(event: MessageEvent<string>): void {
  const payload = parseLiveEvent(event.data);
  if (payload?.boardId && payload.boardId !== state.activeBoardId) return;
  pendingRemoteRefresh = true;
  if (hasLocalEditingState()) {
    showPendingRemoteRefreshToast();
    return;
  }
  void applyPendingRemoteRefresh();
}

function parseLiveEvent(raw: string): LiveWorkspaceEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LiveWorkspaceEvent>;
    if (parsed.type !== "workspace_changed" || !parsed.id) return null;
    return {
      id: String(parsed.id),
      type: "workspace_changed",
      boardId: parsed.boardId ? String(parsed.boardId) : null,
      payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload as AnyRecord : {},
      createdAt: String(parsed.createdAt || "")
    };
  } catch (_error) {
    return null;
  }
}

function showPendingRemoteRefreshToast(): void {
  if (pendingRemoteRefreshToastShown) return;
  pendingRemoteRefreshToastShown = true;
  showToast("Board updated. Latest work appears after you close this panel.");
}

async function applyPendingRemoteRefresh(): Promise<void> {
  if (!pendingRemoteRefresh || remoteRefreshInFlight) return;
  if (document.visibilityState !== "visible" || hasLocalEditingState()) return;

  remoteRefreshInFlight = true;
  pendingRemoteRefresh = false;
  pendingRemoteRefreshToastShown = false;
  try {
    await saveQueue.catch(() => undefined);
    await refreshStateFromApi();
  } finally {
    remoteRefreshInFlight = false;
  }
}

function startPolling(): void {
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (hasLocalEditingState()) return;
    if (pendingRemoteRefresh) {
      void applyPendingRemoteRefresh();
      return;
    }
    refreshStateFromApi();
  }, POLL_INTERVAL_MS);
}

async function refreshStateFromApi(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/state`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`State request failed with ${response.status}`);
    const nextState = normalizeWorkspace(await response.json());
    const serialized = JSON.stringify(nextState);
    apiOnline = true;
    apiWarningShown = false;
    if (serialized === lastPersistedState) return;
    state = nextState;
    lastPersistedState = serialized;
    render();
  } catch (error) {
    apiOnline = false;
  }
}

function hasLocalEditingState(): boolean {
  const board = getActiveBoardOrNull();
  return Boolean(
    board?.isEditingFlow ||
    board?.configDraft ||
    templateFormOpen ||
    editingTemplateId ||
    workItemDialogOpen ||
    deleteBoardDialogOpen ||
    agentConnectDialogOpen ||
    projectDialogOpen ||
    boardSettingsDialogOpen
  );
}

function showApiWarning(message: string): void {
  if (apiWarningShown) return;
  apiWarningShown = true;
  showToast(message);
}

function getActiveProject(): Project {
  let project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
  if (project) return project;

  if (!state.projects.length) {
    project = createProject({ id: DEFAULT_PROJECT_ID, teamId: state.team?.id || DEFAULT_TEAM_ID, name: DEFAULT_PROJECT_NAME });
    state.projects.push(project);
  }

  state.activeProjectId = state.projects[0].id;
  return state.projects[0];
}

function getActiveProjectBoards(): Board[] {
  const project = getActiveProject();
  return state.boards.filter((board) => board.projectId === project.id);
}

function ensureActiveBoardWithinProject(): void {
  const projectBoards = getActiveProjectBoards();
  if (projectBoards.some((board) => board.id === state.activeBoardId)) return;
  state.activeBoardId = projectBoards[0]?.id || "";
}

function getActiveBoardOrNull(): Board | null {
  ensureActiveBoardWithinProject();
  return state.boards.find((candidate) => candidate.id === state.activeBoardId && candidate.projectId === state.activeProjectId) || null;
}

function getActiveBoard(): Board {
  let board = getActiveBoardOrNull();
  if (board) return board;

  board = createBoard("Untitled board", { projectId: state.activeProjectId || DEFAULT_PROJECT_ID });
  state.boards.push(board);

  state.activeBoardId = board.id;
  return board;
}

function getBoardById(boardId: string | null | undefined): Board | null {
  if (!boardId) return null;
  return state.boards.find((board) => board.id === boardId) || null;
}

function touchBoard(board: Board): void {
  board.updatedAt = new Date().toISOString();
}

function serializeFlowAiLane(lane: Lane): AnyRecord {
  return {
    id: lane.id,
    title: lane.title,
    description: lane.description,
    defaultOwnerAgentId: lane.defaultOwnerAgentId,
    defaultReviewerAgentId: lane.defaultReviewerAgentId,
    gate: {
      title: lane.gate?.title || `${lane.title} gate`,
      checks: Array.isArray(lane.gate?.checks) ? [...lane.gate.checks] : []
    }
  };
}

function serializeFlowAiAgent(agent: AgentSpec): AnyRecord {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    laneIds: Array.isArray(agent.laneIds) ? [...agent.laneIds] : [],
    instructions: agent.instructions,
    skillNotes: agent.skillNotes
  };
}

function buildFlowAiRequestContext(board: Board, configDraft: BoardDraft | null): AnyRecord {
  return {
    board: {
      id: board.id,
      projectId: board.projectId,
      name: board.name,
      flowPrompt: board.flowPrompt,
      lanes: board.lanes.map(serializeFlowAiLane),
      agentSpecs: (board.agentSpecs || []).map(serializeFlowAiAgent),
      cardCountsByLane: board.lanes.map((lane) => ({
        laneId: lane.id,
        title: lane.title,
        cards: board.workItems.filter((item) => item.laneId === lane.id).length
      }))
    },
    configDraft: configDraft
      ? {
          lanes: configDraft.lanes.map(serializeFlowAiLane),
          agentSpecs: (configDraft.agentSpecs || []).map(serializeFlowAiAgent)
        }
      : null
  };
}

function flowAiRequestContextKey(board: Board, configDraft: BoardDraft | null = normalizeDraft(board.configDraft)): string {
  return JSON.stringify(buildFlowAiRequestContext(board, configDraft));
}

function buildFlowAiPromptWithContext(command: string, context: AnyRecord): string {
  return [
    command,
    "",
    "Current normalized kanban.cards configDraft/context for this request:",
    JSON.stringify(context)
  ].join("\n");
}

function getCurrentFlowAiBoard(scope: FlowAiRequestScope): Board | null {
  if (scope.requestId !== flowAiRequestId) return null;
  const board = getActiveBoardOrNull();
  if (!board || board.id !== scope.boardId) return null;
  return flowAiRequestContextKey(board) === scope.contextKey ? board : null;
}

function isLatestFlowAiRequestForBoard(scope: FlowAiRequestScope): boolean {
  if (scope.requestId !== flowAiRequestId) return false;
  return getActiveBoardOrNull()?.id === scope.boardId;
}

function makeFlowApplyRequestScope(boardId: string): FlowApplyRequestScope {
  const scope = {
    requestId: flowAiRequestId + 1,
    boardId
  };
  flowAiRequestId = scope.requestId;
  return scope;
}

function isCurrentFlowApplyRequest(scope: FlowApplyRequestScope): boolean {
  return scope.requestId === flowAiRequestId && getActiveBoardOrNull()?.id === scope.boardId;
}

function makeAgentConnectRequestScope(boardId: string, agentId: string | null | undefined = agentConnectAgentId): AgentConnectRequestScope {
  return {
    epoch: agentConnectRequestEpoch,
    boardId,
    agentId: agentId || ""
  };
}

function isCurrentAgentConnectRequest(scope: AgentConnectRequestScope): boolean {
  const board = getActiveBoardOrNull();
  return Boolean(
    agentConnectDialogOpen &&
    scope.epoch === agentConnectRequestEpoch &&
    board?.id === scope.boardId &&
    agentConnectAgentId === scope.agentId &&
    board.agentSpecs?.some((agent) => agent.id === scope.agentId)
  );
}

function getAllTemplates(): TemplateLike[] {
  return [...BUILT_IN_TEMPLATES.map((template) => clone(template)), ...state.templates.map((template) => clone(template))];
}

function getTemplate(templateId: string): TemplateLike | null {
  return getAllTemplates().find((template) => template.id === templateId) || null;
}

function getSelectedWorkItem(): WorkItem | null {
  const board = getActiveBoardOrNull();
  if (!board) return null;
  if (!board.selectedId) return null;
  return board.workItems.find((item) => item.id === board.selectedId) || null;
}

function getOpenBlockers(item: any): any[] {
  return Array.isArray(item?.blockers) ? item.blockers.filter((blocker: any) => !blocker.resolved) : [];
}

function getApprovalCount(item: any): number {
  return Array.isArray(item?.approvals) ? item.approvals.length : 0;
}

function isDelivered(item: any): boolean {
  return Boolean(item?.completed || item?.delivered || item?.released);
}

function getWorkItemCurrentState(board: Board, item: WorkItem): WorkItemCurrentState {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  const latestComment = getLatestActivityComment(comments);
  const openRequests = comments.filter(isOpenRequestComment).sort(compareCommentsNewestFirst);
  const openChangeRequests = openRequests.filter((comment) => comment.kind === "change_request");
  const openQuestions = openRequests.filter((comment) => comment.kind === "question");
  const openInstructions = openRequests.filter((comment) => comment.kind === "instruction");
  const openBlockers = getOpenBlockers(item);
  const approvals = getApprovalCount(item);
  const delivered = isDelivered(item);

  return {
    lane: board.lanes.find((lane) => lane.id === item.laneId) || null,
    comments,
    latestComment,
    openRequests,
    openChangeRequests,
    openQuestions,
    openInstructions,
    openBlockers,
    approvals,
    delivered,
    attention: deriveAttentionState({
      latestComment,
      openChangeRequests,
      openQuestions,
      openInstructions,
      openBlockers,
      approvals,
      delivered
    })
  };
}

function getLatestActivityComment(comments: WorkItemComment[]): WorkItemComment | null {
  return comments.reduce<WorkItemComment | null>((latest, comment) => {
    if (!latest) return comment;
    return getCommentTime(comment) > getCommentTime(latest) ? comment : latest;
  }, null);
}

function compareCommentsNewestFirst(a: WorkItemComment, b: WorkItemComment): number {
  return getCommentTime(b) - getCommentTime(a);
}

function getCommentTime(comment: WorkItemComment): number {
  const value = comment.updatedAt || comment.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function isOpenRequestComment(comment: WorkItemComment): boolean {
  return comment.status !== "resolved" && (OPEN_REQUEST_COMMENT_KINDS as readonly string[]).includes(comment.kind);
}

function deriveAttentionState(input: {
  latestComment: WorkItemComment | null;
  openChangeRequests: WorkItemComment[];
  openQuestions: WorkItemComment[];
  openInstructions: WorkItemComment[];
  openBlockers: any[];
  approvals: number;
  delivered: boolean;
}): AttentionState {
  if (input.openChangeRequests.length) return { label: "Change requested", tone: "danger" };
  if (input.openQuestions.length) return { label: "Question open", tone: "warn" };
  if (input.openInstructions.length) return { label: "Instruction open", tone: "warn" };
  if (input.openBlockers.length) return { label: "Blocked", tone: "danger" };
  if (input.delivered) return { label: "Delivered", tone: "ok" };
  if (input.approvals > 0) return { label: "Approved", tone: "ok" };
  if (input.latestComment) return { label: "In progress", tone: "neutral" };
  return { label: "No activity", tone: "neutral" };
}

function render(): void {
  state = normalizeWorkspace(state);
  ensureActiveBoardWithinProject();
  const board = getActiveBoardOrNull();
  const hasSelectedCard = Boolean(board?.selectedId && board.workItems.some((item) => item.id === board.selectedId));
  if (!hasSelectedCard) inspectorDrawerOpen = false;
  document.body.classList.toggle("has-selected-card", hasSelectedCard);
  document.body.classList.toggle("inspector-drawer-open", inspectorDrawerOpen && hasSelectedCard);

  renderTopbar(board);
  if (authSessionLoaded && authSession && !authSession.isTeamMember) {
    renderNoTeamAccess();
    renderModals(null);
    return;
  }
  renderMetrics(board);
  renderBoard(board);
  renderInspector(board);
  renderModals(board);
  if (pendingRemoteRefresh && !hasLocalEditingState()) window.setTimeout(() => void applyPendingRemoteRefresh(), 0);
}

function renderNoTeamAccess(): void {
  inspectorDrawerOpen = false;
  document.body.classList.remove("has-selected-card", "inspector-drawer-open");
  if (boardTitle) boardTitle.textContent = "Team access required";
  document.querySelector("#metric-active")!.textContent = "0";
  document.querySelector("#metric-blocked")!.textContent = "0";
  document.querySelector("#metric-approvals")!.textContent = "0";
  document.querySelector("#metric-delivered")!.textContent = "0";
  boardCanvas.classList.remove("is-kanban");
  boardCanvas.classList.add("is-setup");
  boardCanvas.innerHTML = `
    <section class="flow-panel" aria-labelledby="team-access-title">
      <div class="flow-panel-heading">
        <p class="eyebrow">Access</p>
        <h2 id="team-access-title">Team invite required</h2>
      </div>
      <p class="modal-copy">${escapeHtml(authSession?.email || authSession?.userId || "This account")} is signed in but is not a member of this kanban.cards team.</p>
    </section>
  `;
  inspectorPanel.innerHTML = `
    <div class="inspector-label">
      <span>Inspector</span>
      <strong>No access</strong>
    </div>
  `;
}

function renderTopbar(board: Board | null): void {
  const activeProject = getActiveProject();
  const projectBoards = getActiveProjectBoards();
  const canManageStructure = !authSession || authSession.role === "owner" || authSession.role === "admin";

  if (projectSelect) {
    projectSelect.innerHTML = state.projects.map((project) => `
      <option value="${escapeAttribute(project.id)}">${escapeHtml(project.name)}</option>
    `).join("");
    projectSelect.value = activeProject.id;
    projectSelect.disabled = projectActionInFlight;
  }

  if (projectSettingsButton) {
    projectSettingsButton.hidden = !canManageStructure;
    projectSettingsButton.disabled = projectActionInFlight || projectDialogSaving;
  }
  if (newProjectButton) {
    newProjectButton.hidden = !canManageStructure;
    newProjectButton.disabled = projectActionInFlight || projectDialogSaving;
  }

  if (boardSelect) {
    boardSelect.innerHTML = projectBoards.length ? projectBoards.map((candidate) => `
      <option value="${escapeAttribute(candidate.id)}">${escapeHtml(candidate.name)}</option>
    `).join("") : '<option value="">No boards</option>';
    boardSelect.value = board?.id || "";
    boardSelect.disabled = !projectBoards.length;
  }

  if (newBoardButton) {
    newBoardButton.hidden = !canManageStructure;
    newBoardButton.disabled = !activeProject;
  }

  if (boardTitle) boardTitle.textContent = board ? board.name : `No boards in ${activeProject.name}`;

  if (boardSettingsButton) boardSettingsButton.hidden = !board || !canManageStructure;
  if (editFlowButton) editFlowButton.hidden = !Boolean(canManageStructure && board?.lanes.length && !board.isEditingFlow && !board.configDraft);
  renderAccountControl();
}

function renderAccountControl(): void {
  if (!accountControl) return;
  if (!authSessionLoaded || !authSession) {
    accountControl.innerHTML = "";
    return;
  }

  const label = authSession.name || authSession.email || authSession.userId || "Signed in";
  const roles = authSession.roles?.length ? authSession.roles.join(", ") : "No roles";
  const access = authSession.surfaceAccess?.length ? authSession.surfaceAccess.join(", ") : "No surface access";
  const appRole = authSession.isTeamMember ? authSession.role || "member" : "no team access";
  const canManageTeam = authSession.role === "owner" || authSession.role === "admin";
  accountControl.innerHTML = `
    <div class="account-context" aria-label="Session context">
      <span class="account-chip" title="${escapeAttribute(authSession.email || authSession.userId)}">${escapeHtml(label)}</span>
      <div class="account-meta">
        <span title="${escapeAttribute(authSession.workspaceId)}">Workspace ${escapeHtml(authSession.workspaceId || "unknown")}</span>
        <span title="${escapeAttribute(authSession.teamId)}">Team ${escapeHtml(authSession.teamId || "unknown")}</span>
        <span title="${escapeAttribute(authSession.projectId)}">Project ${escapeHtml(authSession.projectId || "unknown")}</span>
        <span title="${escapeAttribute(appRole)}">App role ${escapeHtml(appRole)}</span>
        <span title="${escapeAttribute(roles)}">Roles ${escapeHtml(roles)}</span>
        <span title="${escapeAttribute(access)}">Access ${escapeHtml(access)}</span>
      </div>
    </div>
    ${canManageTeam ? '<button class="secondary-button account-team-settings" type="button" data-action="open-team-settings">Team settings</button>' : ""}
    <a class="secondary-button account-logout" href="/auth/logout?global=1">Logout</a>
  `;
}

function renderMetrics(board: Board | null): void {
  const active = board ? board.workItems.filter((item) => !isDelivered(item)).length : 0;
  const blocked = board ? board.workItems.filter((item) => getOpenBlockers(item).length > 0).length : 0;
  const approvals = board ? board.workItems.reduce((total, item) => total + getApprovalCount(item), 0) : 0;
  const delivered = board ? board.workItems.filter(isDelivered).length : 0;

  document.querySelector("#metric-active")!.textContent = String(active);
  document.querySelector("#metric-blocked")!.textContent = String(blocked);
  document.querySelector("#metric-approvals")!.textContent = String(approvals);
  document.querySelector("#metric-delivered")!.textContent = String(delivered);
}

function renderBoard(board: Board | null): void {
  if (!board) {
    boardCanvas.classList.remove("is-kanban");
    boardCanvas.classList.add("is-setup");
    boardCanvas.innerHTML = renderEmptyProjectSetup();
    return;
  }

  const isConfiguring = Boolean(board.isEditingFlow || board.configDraft);
  boardCanvas.classList.toggle("is-kanban", Boolean(board.lanes.length && !isConfiguring));
  boardCanvas.classList.toggle("is-setup", Boolean(!board.lanes.length || isConfiguring));

  if (isConfiguring) {
    boardCanvas.innerHTML = renderFlowEditor(board);
    return;
  }

  if (!board.lanes.length) {
    boardCanvas.innerHTML = renderFlowSetup(board);
    return;
  }

  boardCanvas.innerHTML = board.lanes.map((lane) => {
    const laneItems = board.workItems.filter((item) => item.laneId === lane.id);
    return `
      <section class="kanban-lane" aria-labelledby="lane-${escapeAttribute(lane.id)}" data-lane-id="${escapeAttribute(lane.id)}">
        <div class="lane-header">
          <div>
            <h2 id="lane-${escapeAttribute(lane.id)}">${escapeHtml(lane.title)}</h2>
            ${renderLaneDescription(lane)}
          </div>
          <span class="lane-count">${laneItems.length}</span>
        </div>
        <div class="work-item-stack">
          ${laneItems.length ? laneItems.map((item) => renderWorkItemCard(item, board)).join("") : renderEmptyLaneCta(lane)}
        </div>
      </section>
    `;
  }).join("");
}

function renderEmptyLaneCta(lane: Lane): string {
  return `<button class="empty-lane empty-lane-cta" type="button" data-action="open-work-item-dialog" data-lane-id="${escapeAttribute(lane.id)}">+ New Card</button>`;
}

function renderLaneDescription(lane: Lane): string {
  const description = String(lane.description || "").trim();
  if (!description) return "";

  const descriptionId = `lane-${lane.id}-description`;
  const tooltipId = `lane-${lane.id}-description-tooltip`;
  return `
    <div class="lane-description-wrap">
      <p class="lane-description" id="${escapeAttribute(descriptionId)}" tabindex="0" aria-describedby="${escapeAttribute(tooltipId)}">${escapeHtml(description)}</p>
      <div class="lane-description-popover" id="${escapeAttribute(tooltipId)}" role="tooltip">${escapeHtml(description)}</div>
    </div>
  `;
}

function renderAttributes(attributes: Record<string, any> = {}): string {
  return Object.entries(attributes)
    .map(([key, value]) => {
      if (value === false || value === null || value === undefined) return "";
      if (value === true) return ` ${key}`;
      return ` ${key}="${escapeAttribute(value)}"`;
    })
    .join("");
}

function renderFormField({ label, control, className = "", id = "", srOnly = false }: any): string {
  const classes = ["form-field", className].filter(Boolean).join(" ");
  const forAttribute = id ? ` for="${escapeAttribute(id)}"` : "";
  const labelClass = srOnly ? "sr-only" : "meta-label";
  return `
    <label class="${escapeAttribute(classes)}"${forAttribute}>
      <span class="${labelClass}">${escapeHtml(label)}</span>
      ${control}
    </label>
  `;
}

function renderTextInput({ id = "", value = "", attributes = {}, required = false, autocomplete = "", ariaLabel = "" }: any): string {
  const controlAttributes = {
    id,
    type: "text",
    value,
    ...attributes,
    required,
    autocomplete: autocomplete || undefined,
    "aria-label": ariaLabel || undefined
  };
  return `<input class="form-control" ${renderAttributes(controlAttributes)}>`;
}

function renderTextField(options: any): string {
  return renderFormField({
    ...options,
    control: renderTextInput(options)
  });
}

function renderTextArea({ id = "", value = "", rows = 2, placeholder = "", attributes = {}, ariaLabel = "" }: any): string {
  const controlAttributes = {
    id,
    rows,
    placeholder: placeholder || undefined,
    ...attributes,
    "aria-label": ariaLabel || undefined
  };
  return `<textarea class="form-control" ${renderAttributes(controlAttributes)}>${escapeHtml(value)}</textarea>`;
}

function renderTextAreaField(options: any): string {
  return renderFormField({
    ...options,
    control: renderTextArea(options)
  });
}

function renderSelect({ id = "", optionsHtml = "", attributes = {}, ariaLabel = "" }: any): string {
  const controlAttributes = {
    id,
    ...attributes,
    "aria-label": ariaLabel || undefined
  };
  return `<select class="form-control select-control" ${renderAttributes(controlAttributes)}>${optionsHtml}</select>`;
}

function renderSelectField(options: any): string {
  return renderFormField({
    ...options,
    control: renderSelect(options)
  });
}

function renderFieldGrid(content: string, className = ""): string {
  const classes = ["field-grid", className].filter(Boolean).join(" ");
  return `<div class="${escapeAttribute(classes)}">${content}</div>`;
}

function renderCheckboxOption({ label, checked = false, attributes = {} }: any): string {
  return `
    <label class="checkbox-option">
      <input class="checkbox-control" type="checkbox" ${renderAttributes({ ...attributes, checked })}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderCheckboxGroup({ legend, options = [], summary = "", className = "", gridClassName = "" }: any): string {
  const classes = ["checkbox-group", className].filter(Boolean).join(" ");
  const gridClasses = ["checkbox-grid", gridClassName].filter(Boolean).join(" ");
  return `
    <fieldset class="${escapeAttribute(classes)}">
      <legend class="meta-label">${escapeHtml(legend)}</legend>
      <div class="${escapeAttribute(gridClasses)}">
        ${options.map(renderCheckboxOption).join("")}
      </div>
      ${summary ? `<p class="agent-lane-summary">${escapeHtml(summary)}</p>` : ""}
    </fieldset>
  `;
}

function renderEmptyProjectSetup(): string {
  const project = getActiveProject();
  return `
    <section class="empty-board empty-project" aria-labelledby="empty-project-title">
      <p class="eyebrow">Project setup</p>
      <h2 id="empty-project-title">${escapeHtml(project.name)} has no boards</h2>
      <p>Create a board in this project to start tracking cards, or switch to another project in the topbar.</p>
      <div class="empty-project-actions">
        <button class="primary-button" type="button" data-action="create-board">New board</button>
        <button class="secondary-button" type="button" data-action="open-project-settings">Project settings</button>
      </div>
    </section>
  `;
}

function renderFlowSetup(board: Board): string {
  const draft = normalizeDraft(board.configDraft);
  return `
    <section class="flow-panel flow-panel-wide setup-panel" aria-labelledby="flow-setup-title">
      <div class="flow-panel-heading">
        <p class="eyebrow">Board setup</p>
        <h2 id="flow-setup-title">Describe the workflow</h2>
      </div>
      ${renderTemplateGallery()}
      ${renderFlowCommandWorkspace(board, draft)}
    </section>
  `;
}

function renderTemplateGallery(): string {
  const templates = getAllTemplates();
  return `
    <section class="template-section" aria-label="Flow templates">
      <div class="section-heading">
        <h3>Flow templates</h3>
      </div>
      <div class="template-grid">
        ${templates.map(renderTemplateCard).join("")}
      </div>
    </section>
  `;
}

function renderTemplateCard(template: TemplateLike): string {
  const laneList = template.lanes.map((lane) => lane.title).join(", ");
  const templateKind = template.builtIn ? "Built-in" : "Saved";
  const isEditing = editingTemplateId === template.id && !template.builtIn;

  if (isEditing) {
    return `
      <article class="template-card is-editing" data-template-id="${escapeAttribute(template.id)}">
        <div class="template-card-body">
          <div class="template-card-topline">
            <span class="template-kind">${escapeHtml(templateKind)}</span>
            <span class="template-lane-count">${template.lanes.length} lanes</span>
          </div>
          ${renderTextField({ label: "Template name", value: template.name, className: "template-field", attributes: { "data-template-field": "name" } })}
          ${renderTextAreaField({ label: "Description", value: template.description || "", rows: 2, className: "template-field", attributes: { "data-template-field": "description" } })}
          <p class="template-lane-list">${escapeHtml(laneList)}</p>
        </div>
        <div class="template-actions">
          <button class="primary-button small" type="button" data-action="apply-template-rename" data-template-id="${escapeAttribute(template.id)}">Save</button>
          <button class="secondary-button small" type="button" data-action="cancel-template-rename" data-template-id="${escapeAttribute(template.id)}">Cancel</button>
        </div>
      </article>
    `;
  }

  return `
    <article class="template-card" data-template-id="${escapeAttribute(template.id)}">
      <div class="template-card-body">
        <div class="template-card-topline">
          <span class="template-kind">${escapeHtml(templateKind)}</span>
          <span class="template-lane-count">${template.lanes.length} lanes</span>
        </div>
        <h4>${escapeHtml(template.name)}</h4>
        <p>${escapeHtml(template.description || "No description.")}</p>
        <p class="template-lane-list">${escapeHtml(laneList)}</p>
      </div>
      <div class="template-actions">
        <button class="secondary-button small" type="button" data-action="use-template" data-template-id="${escapeAttribute(template.id)}">Use template</button>
        ${template.builtIn ? "" : `
          <button class="secondary-button small" type="button" data-action="rename-template" data-template-id="${escapeAttribute(template.id)}">Rename</button>
          <button class="secondary-button small danger-button" type="button" data-action="delete-template" data-template-id="${escapeAttribute(template.id)}">Delete</button>
        `}
      </div>
    </article>
  `;
}

function renderSaveTemplatePanel(board: Board): string {
  return `
    <form class="template-save-popover" data-template-form>
      <div class="template-card-topline">
        <span class="template-kind">Save flow</span>
        <button class="icon-action" type="button" data-action="cancel-template-save" aria-label="Close template form">x</button>
      </div>
      ${renderTextField({ label: "Template name", value: uniqueTemplateName(`${board.name} template`), className: "template-field", attributes: { "data-template-field": "name" } })}
      ${renderTextAreaField({ label: "Description", value: `Flow from ${board.name}.`, rows: 2, className: "template-field", attributes: { "data-template-field": "description" } })}
      <div class="template-actions">
        <button class="primary-button small" type="button" data-action="save-template-from-form">Save template</button>
        <button class="secondary-button small" type="button" data-action="cancel-template-save">Cancel</button>
      </div>
    </form>
  `;
}

function renderFlowEditor(board: Board): string {
  const draft = normalizeDraft(board.configDraft) || { lanes: [], agentSpecs: [] };
  return `
    <section class="flow-panel flow-panel-wide" aria-labelledby="flow-editor-title">
      <div class="flow-panel-heading flow-panel-heading-with-actions">
        <div>
          <p class="eyebrow">Board setup</p>
          <h2 id="flow-editor-title">Flow command workspace</h2>
        </div>
        <div class="flow-menu-wrap">
          <button class="icon-action flow-menu-button" type="button" data-action="toggle-flow-menu" aria-haspopup="menu" aria-expanded="${flowActionsMenuOpen ? "true" : "false"}" aria-label="Flow actions">...</button>
          ${flowActionsMenuOpen ? `
            <div class="flow-menu" role="menu" aria-label="Flow actions">
              <button type="button" role="menuitem" data-action="open-delete-board">Delete board</button>
            </div>
          ` : ""}
        </div>
      </div>
      ${renderFlowCommandWorkspace(board, draft)}
      ${templateFormOpen ? renderSaveTemplatePanel(board) : ""}
    </section>
  `;
}

function renderFlowCommandWorkspace(board: Board, draft: BoardDraft | null): string {
  const canApply = Boolean(draft && draft.lanes.length >= MIN_LANES && !flowAiLoading && !flowApplyInFlight);
  const quickPrompts = [
    "Tighten this into a paid SaaS product roadmap flow",
    "Add stronger review and release gates",
    "Split research, planning, build, review, and launch responsibilities",
    "Make agents explicit and keep humans accountable"
  ];
  return `
    <section class="flow-ai-workspace" aria-label="AI flow command workspace">
      <div class="flow-ai-command">
        ${renderTextField({ label: "Board name", id: "board-name", value: board.name, className: "board-name-field" })}
        ${renderTextAreaField({
          label: "Flow command",
          id: "flow-prompt",
          value: board.flowPrompt,
          rows: 4,
          placeholder: "Describe the workflow you want. Example: Intake, research, plan, build, review, release with explicit agent ownership and approval gates.",
          className: "flow-prompt-field"
        })}
        <div class="flow-prompt-chips" aria-label="Quick flow commands">
          ${quickPrompts.map((prompt) => `<button class="prompt-chip" type="button" data-action="use-flow-chip" data-flow-chip="${escapeAttribute(prompt)}">${escapeHtml(prompt)}</button>`).join("")}
        </div>
        <div class="flow-actions">
          <button class="primary-button" type="button" data-action="generate-flow" ${flowAiLoading ? "disabled" : ""}>${draft ? "Revise with AI" : "Generate with AI"}</button>
          <button class="primary-button" type="button" data-action="apply-board" ${canApply ? "" : "disabled"}>${flowApplyInFlight ? "Applying..." : "Apply flow"}</button>
          <button class="secondary-button" type="button" data-action="start-over">${board.lanes.length ? "Cancel edits" : "Start over"}</button>
          ${board.lanes.length ? `<button class="secondary-button" type="button" data-action="save-template">Save as template</button>` : ""}
        </div>
        ${renderFlowAiStatus()}
      </div>
      ${renderFlowDraftPreview(board, draft)}
      ${draft ? `
        <section class="flow-advanced-panel">
          <div class="section-heading">
            <h3>Advanced controls</h3>
            <div class="flow-actions compact-actions">
              <button class="secondary-button small" type="button" data-action="toggle-flow-advanced">${flowAdvancedOpen ? "Hide advanced" : "Open advanced"}</button>
              <button class="secondary-button small" type="button" data-action="add-lane">Add lane</button>
            </div>
          </div>
          ${flowAdvancedOpen ? `
            ${renderAgentSetup(draft)}
            <div class="lane-editor-list">
              ${draft.lanes.map((lane, laneIndex) => renderLaneEditor(lane, laneIndex, draft)).join("")}
            </div>
          ` : '<p class="empty-note">Detailed lane, gate, and agent form controls are available when needed.</p>'}
        </section>
      ` : ""}
    </section>
  `;
}

function renderFlowAiStatus(): string {
  const messages = [
    flowAiLoading ? "Asking LM Studio for a structured board flow..." : "",
    flowApplyInFlight ? "Applying flow and preserving cards..." : ""
  ].filter(Boolean);
  if (!messages.length) return "";
  return `
    <div class="flow-ai-status">
      ${messages.map((message) => `<p class="flow-message neutral">${escapeHtml(message)}</p>`).join("")}
    </div>
  `;
}

function renderFlowDraftNotes(): string {
  const summary = String(flowAiSummary || "").trim();
  const warnings = flowAiWarnings.map((warning) => String(warning || "").trim()).filter(Boolean);
  if (!summary && !warnings.length) return "";
  return `
    <section class="flow-draft-notes" aria-label="Draft notes">
      ${summary ? `
        <div>
          <p class="meta-label">Draft notes</p>
          <p>${escapeHtml(summary)}</p>
        </div>
      ` : ""}
      ${warnings.length ? `
        <div>
          <p class="meta-label">Warnings</p>
          <ul class="flow-warning-list">
            ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
    </section>
  `;
}

function renderFlowDraftPreview(board: Board, draft: BoardDraft | null): string {
  if (!draft) {
    return `
      <section class="flow-preview-panel empty-flow-preview">
        <div class="section-heading"><h3>Preview</h3></div>
        <p class="empty-note">Generate a flow to preview lanes, gates, agents, and card remapping before applying.</p>
      </section>
    `;
  }
  const diff = describeFlowDiff(board, draft);
  return `
    <section class="flow-preview-panel">
      <div class="section-heading">
        <h3>Preview</h3>
        <span class="template-lane-count">${draft.lanes.length} lanes / ${draft.agentSpecs.length} agents</span>
      </div>
      <div class="flow-diff-grid">
        ${renderStateGridItem("Lane changes", diff.laneChange)}
        ${renderStateGridItem("Agent changes", diff.agentChange)}
        ${renderStateGridItem("Card remap", diff.cardRemap)}
        ${renderStateGridItem("Apply mode", "Preview first")}
      </div>
      ${renderFlowDraftNotes()}
      <div class="flow-preview-lanes">
        ${draft.lanes.map((lane, index) => renderFlowPreviewLane(lane, index, draft)).join("")}
      </div>
    </section>
  `;
}

function renderFlowPreviewLane(lane: Lane, index: number, draft: BoardDraft): string {
  const owner = draft.agentSpecs.find((agent) => agent.id === lane.defaultOwnerAgentId);
  const reviewer = draft.agentSpecs.find((agent) => agent.id === lane.defaultReviewerAgentId);
  return `
    <article class="flow-preview-lane">
      <div class="flow-preview-lane-header">
        <span class="lane-position">${index + 1}</span>
        <div>
          <h4>${escapeHtml(lane.title)}</h4>
          <p>${escapeHtml(lane.description || "No description.")}</p>
        </div>
      </div>
      <div class="flow-preview-agents">
        <span>${escapeHtml(owner ? `Owner: ${owner.name}` : "Owner: unassigned")}</span>
        <span>${escapeHtml(reviewer ? `Reviewer: ${reviewer.name}` : "Reviewer: unassigned")}</span>
      </div>
      <div class="flow-preview-gate">
        <span class="meta-label">${escapeHtml(lane.gate.title || `${lane.title} gate`)}</span>
        <ul>${lane.gate.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>
      </div>
    </article>
  `;
}

function describeFlowDiff(board: Board, draft: BoardDraft): { laneChange: string; agentChange: string; cardRemap: string } {
  const oldLaneIds = new Set(board.lanes.map((lane) => lane.id));
  const newLaneIds = new Set(draft.lanes.map((lane) => lane.id));
  const addedLanes = draft.lanes.filter((lane) => !oldLaneIds.has(lane.id)).length;
  const removedLanes = board.lanes.filter((lane) => !newLaneIds.has(lane.id)).length;
  const oldAgentIds = new Set(board.agentSpecs.map((agent) => agent.id));
  const newAgentIds = new Set(draft.agentSpecs.map((agent) => agent.id));
  const addedAgents = draft.agentSpecs.filter((agent) => !oldAgentIds.has(agent.id)).length;
  const removedAgents = board.agentSpecs.filter((agent) => !newAgentIds.has(agent.id)).length;
  const remapCount = board.workItems.filter((item) => !newLaneIds.has(item.laneId)).length;
  return {
    laneChange: `${addedLanes} added / ${removedLanes} removed`,
    agentChange: `${addedAgents} added / ${removedAgents} removed`,
    cardRemap: remapCount ? `${remapCount} card${remapCount === 1 ? "" : "s"} will move` : "No card moves"
  };
}

function renderAgentSetup(draft: BoardDraft): string {
  const agents = draft.agentSpecs || [];
  return `
    <section class="agent-setup" aria-labelledby="agent-setup-title">
      <div class="section-heading">
        <h3 id="agent-setup-title">Agents</h3>
        <button class="secondary-button small" type="button" data-action="add-agent">Add agent</button>
      </div>
      ${agents.length ? `
        <div class="agent-editor-list">
          ${agents.map((agent, agentIndex) => renderAgentEditor(agent, agentIndex, draft)).join("")}
        </div>
      ` : '<p class="empty-note">No agents yet. Add agents to make owner and reviewer assignment readable.</p>'}
    </section>
  `;
}

function renderAgentEditor(agent: AgentSpec, agentIndex: number, draft: BoardDraft): string {
  const board = getActiveBoard();
  const laneTags = draft.lanes
    .filter((lane) => agent.laneIds.includes(lane.id))
    .map((lane) => lane.title)
    .join(", ");
  const canConnect = Boolean(board.agentSpecs?.some((candidate) => candidate.id === agent.id));

  return `
    <article class="agent-editor" data-agent-index="${agentIndex}">
      <div class="agent-editor-header">
        <span class="agent-badge">${escapeHtml(agent.id)}</span>
        <div class="agent-editor-actions">
          <button class="secondary-button small" type="button" data-action="connect-agent" data-agent-id="${escapeAttribute(agent.id)}" ${canConnect ? "" : "disabled"} title="${canConnect ? "Create a local-agent token" : "Apply this agent before connecting it"}">Connect</button>
          <button class="icon-action danger" type="button" data-action="remove-agent" aria-label="Remove ${escapeAttribute(agent.name)}">x</button>
        </div>
      </div>
      ${renderFieldGrid(`
        ${renderTextField({ label: "Agent name", value: agent.name, attributes: { "data-agent-field": "name" } })}
        ${renderTextField({ label: "Stable ID", value: agent.id, attributes: { "data-agent-field": "id" } })}
      `)}
      ${renderTextField({ label: "Role", value: agent.role, attributes: { "data-agent-field": "role" } })}
      ${renderCheckboxGroup({
        legend: "Lane responsibility",
        className: "lane-responsibility-field",
        gridClassName: "agent-lane-grid",
        options: draft.lanes.map((lane) => ({
          label: lane.title,
          checked: agent.laneIds.includes(lane.id),
          attributes: { "data-agent-lane-id": lane.id }
        })),
        summary: laneTags
      })}
      ${renderTextAreaField({ label: "Instructions", value: agent.instructions, rows: 2, attributes: { "data-agent-field": "instructions" } })}
      ${renderTextAreaField({ label: "Skill notes", value: agent.skillNotes, rows: 2, attributes: { "data-agent-field": "skillNotes" } })}
    </article>
  `;
}

function renderLaneEditor(lane: Lane, laneIndex: number, draft: BoardDraft): string {
  const canMoveLeft = laneIndex > 0;
  const canMoveRight = laneIndex < draft.lanes.length - 1;
  const canRemoveLane = draft.lanes.length > MIN_LANES;
  const agentOptions = renderAgentOptions(draft.agentSpecs || []);

  return `
    <article class="lane-editor" data-lane-index="${laneIndex}">
      <div class="lane-editor-header">
        <span class="lane-position">${laneIndex + 1}</span>
        <div class="lane-editor-controls" aria-label="Lane controls">
          <button class="icon-action" type="button" data-action="move-lane-left" ${canMoveLeft ? "" : "disabled"} aria-label="Move lane left">‹</button>
          <button class="icon-action" type="button" data-action="move-lane-right" ${canMoveRight ? "" : "disabled"} aria-label="Move lane right">›</button>
          <button class="icon-action danger" type="button" data-action="remove-lane" ${canRemoveLane ? "" : "disabled"} aria-label="Remove lane">x</button>
        </div>
      </div>
      ${renderTextField({ label: "Lane", value: lane.title, attributes: { "data-field": "title" } })}
      ${renderTextAreaField({ label: "Description", value: lane.description, rows: 2, attributes: { "data-field": "description" } })}
      ${renderFieldGrid(`
        ${renderSelectField({ label: "Default owner", optionsHtml: agentOptions(lane.defaultOwnerAgentId), attributes: { "data-field": "defaultOwnerAgentId" } })}
        ${renderSelectField({ label: "Default reviewer", optionsHtml: agentOptions(lane.defaultReviewerAgentId), attributes: { "data-field": "defaultReviewerAgentId" } })}
      `)}
      <div class="gate-editor">
        ${renderTextField({ label: "Gate", value: lane.gate.title, attributes: { "data-field": "gateTitle" } })}
        <div class="check-editor-list">
          ${lane.gate.checks.map((check, checkIndex) => renderCheckEditor(check, checkIndex)).join("")}
        </div>
        <button class="secondary-button small" type="button" data-action="add-check">Add check</button>
      </div>
    </article>
  `;
}

function renderCheckEditor(check: string, checkIndex: number): string {
  return `
    <div class="check-editor" data-check-index="${checkIndex}">
      ${renderTextInput({ value: check, attributes: { "data-field": "check" }, ariaLabel: "Gate check" })}
      <button class="icon-action danger" type="button" data-action="remove-check" aria-label="Remove check">x</button>
    </div>
  `;
}

function renderAgentOptions(agentSpecs: AgentSpec[]): (selectedId?: string | null) => string {
  return (selectedId = "") => `
    <option value="">Unassigned</option>
    ${agentSpecs.map((agent) => `
      <option value="${escapeAttribute(agent.id)}" ${agent.id === selectedId ? "selected" : ""}>${escapeHtml(formatAgentOption(agent))}</option>
    `).join("")}
  `;
}

function formatAgentOption(agent: AgentSpec): string {
  return agent.role ? `${agent.name} - ${agent.role}` : agent.name;
}

function renderMemberOptions(selectedId: string | null = ""): string {
  const members = getKnownMembers();
  return `
    <option value="">Unassigned</option>
    ${members.map((member) => `
      <option value="${escapeAttribute(member.id)}" ${member.id === selectedId ? "selected" : ""}>${escapeHtml(formatMemberOption(member))}</option>
    `).join("")}
  `;
}

function formatMemberOption(member: PublicTeamMember): string {
  const label = member.name || member.email || member.userId;
  return member.email && member.email !== label ? `${label} - ${member.email}` : label;
}

function getKnownMembers(): PublicTeamMember[] {
  const members = new Map<string, PublicTeamMember>();
  const addMember = (member: PublicTeamMember | null | undefined) => {
    if (!member?.id) return;
    members.set(member.id, member);
  };

  for (const member of state.members || []) addMember(member);
  for (const member of teamSettingsData?.members || []) addMember(member);
  if (authSession?.memberId && !members.has(authSession.memberId)) {
    const now = new Date().toISOString();
    addMember({
      id: authSession.memberId,
      teamId: authSession.teamId,
      userId: authSession.userId,
      email: authSession.email,
      name: authSession.name || authSession.email,
      role: authSession.role || "member",
      projectIds: authSession.projectIds.length ? authSession.projectIds : ["*"],
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now
    });
  }
  return Array.from(members.values()).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

function findMemberById(memberId: string | null | undefined): PublicTeamMember | null {
  if (!memberId) return null;
  return getKnownMembers().find((member) => member.id === memberId) || null;
}

function findMemberByIdentity(identity: { userId?: unknown; email?: unknown; name?: unknown }): PublicTeamMember | null {
  const userId = optionalText(identity.userId);
  const email = optionalText(identity.email)?.toLowerCase();
  const name = optionalText(identity.name)?.toLowerCase();
  return getKnownMembers().find((member) => {
    if (userId && member.userId === userId) return true;
    if (email && member.email.toLowerCase() === email) return true;
    if (name && member.name.toLowerCase() === name) return true;
    return false;
  }) || null;
}

function actorFromMember(member: PublicTeamMember): ActorRef {
  const label = member.name || member.email || member.userId;
  const detail = member.email && member.email !== label ? member.email : member.userId;
  return makeActorRef("human", member.id, label, detail, member.role || "Member");
}

function actorFromMemberId(memberId: string | null | undefined, fallbackLabel = "Unassigned"): ActorRef {
  const member = findMemberById(memberId);
  if (member) return actorFromMember(member);
  if (memberId) return makeActorRef("human", memberId, memberId, "Member", "Human");
  return makeActorRef("unknown", "unassigned", fallbackLabel, "", "");
}

function actorFromAgent(board: Board | null | undefined, agentId: string | null | undefined): ActorRef {
  if (!agentId) return makeActorRef("unknown", "unassigned-agent", "Unassigned", "", "");
  const agent = board?.agentSpecs?.find((candidate) => candidate.id === agentId);
  if (!agent) return makeActorRef("agent", agentId, agentId, "Board agent", "Agent");
  return makeActorRef("agent", agent.id, agent.name, agent.role || agent.id, "Agent");
}

function actorFromService(label: string, detail = ""): ActorRef {
  return makeActorRef("service", slugify(label) || "service", label, detail, "Service");
}

function actorFromSessionRecord(tokenRecord: Pick<PublicTokenRecord, "sessionId" | "label" | "projectId" | "delegatedBy" | "capabilities" | "expiresAt" | "revokedAt" | "lastUsedAt">, board?: Board | null): ActorRef {
  const status = tokenRecord.revokedAt ? "Revoked" : isExpiredTimestamp(tokenRecord.expiresAt) ? "Expired" : "Active";
  return {
    ...makeActorRef("session", tokenRecord.sessionId || "agent-session", tokenRecord.label || shortSessionId(tokenRecord.sessionId) || "AgentSession", `Session ${shortSessionId(tokenRecord.sessionId) || "n/a"}`, status),
    sessionId: tokenRecord.sessionId,
    delegatedBy: tokenRecord.delegatedBy,
    projectId: tokenRecord.projectId,
    capabilities: tokenRecord.capabilities,
    status,
    title: [
      tokenRecord.label || "AgentSession",
      tokenRecord.sessionId ? `Session ${tokenRecord.sessionId}` : "",
      tokenRecord.projectId ? `Project ${tokenRecord.projectId}` : "",
      board?.name ? `Board ${board.name}` : ""
    ].filter(Boolean).join(" / ")
  };
}

function actorFromActivitySession(event: InspectorActivityEvent, board?: Board | null): ActorRef {
  const sessionId = activityValue(event.delegation, "sessionId") || activityValue(event.payload, "sessionId");
  if (!sessionId) return makeActorRef("unknown", "no-session", "No session", "", "");
  return actorFromSessionRecord({
    sessionId,
    label: activityValue(event.delegation, "label") || shortSessionId(sessionId),
    projectId: activityValue(event.delegation, "projectId") || activityValue(event.payload, "projectId") || null,
    delegatedBy: activityValue(event.delegation, "delegatedBy") || activityValue(event.payload, "delegatedBy") || null,
    capabilities: Array.isArray(event.delegation?.capabilities) ? event.delegation.capabilities.map(String) : [],
    expiresAt: activityValue(event.delegation, "expiresAt") || null,
    revokedAt: null,
    lastUsedAt: event.createdAt || null
  }, board);
}

function actorFromProvenance(actor: AnyRecord | null, board?: Board | null): ActorRef {
  if (!actor) return makeActorRef("unknown", "unknown-actor", "Unknown actor", "", "");
  const type = activityValue(actor, "type");
  if (type === "agent") return actorFromAgent(board, activityValue(actor, "agentId") || activityValue(actor, "userId"));
  if (type === "user") {
    const member = findMemberByIdentity({
      userId: activityValue(actor, "userId"),
      email: activityValue(actor, "email"),
      name: activityValue(actor, "name")
    });
    if (member) return actorFromMember(member);
    return makeActorRef("human", activityValue(actor, "userId") || activityValue(actor, "email") || "user", activityValue(actor, "name") || activityValue(actor, "email") || "User", activityValue(actor, "email") || activityValue(actor, "userId"), "Human");
  }
  if (type === "service") {
    const method = activityValue(actor, "method");
    const label = activityValue(actor, "name") || (method === "break-glass" ? "Break-glass admin" : "Service");
    return actorFromService(label, method || activityValue(actor, "userId"));
  }
  return makeActorRef("unknown", activityValue(actor, "userId") || type || "unknown-actor", activityValue(actor, "name") || type || "Unknown actor", "", "");
}

function actorFromDelegatedBy(value: unknown, board?: Board | null): ActorRef {
  const text = optionalText(value);
  if (!text) return makeActorRef("unknown", "no-delegation", "No delegation", "", "");
  if (text.startsWith("user:")) {
    const userId = text.slice("user:".length);
    const member = findMemberByIdentity({ userId });
    return member ? actorFromMember(member) : makeActorRef("human", userId, userId, "Delegating user", "Human");
  }
  if (text.startsWith("agent:")) return actorFromAgent(board, text.slice("agent:".length));
  if (text.startsWith("service:")) return actorFromService(text.slice("service:".length) || "Service", "Delegation source");
  const member = findMemberByIdentity({ userId: text, email: text });
  return member ? actorFromMember(member) : actorFromService(text, "Delegation source");
}

function actorFromCommentAuthor(board: Board | null | undefined, author: string | null | undefined): ActorRef {
  const text = optionalText(author);
  if (!text) return actorFromService("System", "Comment");
  const agent = board?.agentSpecs?.find((candidate) => candidate.id === text || candidate.name === text);
  if (agent) return actorFromAgent(board, agent.id);
  const member = findMemberByIdentity({ userId: text, email: text, name: text });
  if (member) return actorFromMember(member);
  if (text === "system" || text === "admin" || text === "human-reviewer") return actorFromService(text, "Comment actor");
  return makeActorRef("unknown", text, text, "Comment actor", "");
}

function makeActorRef(kind: ActorKind, id: string, label: string, detail = "", badge = ""): ActorRef {
  const fallbackInitials: Record<ActorKind, string> = {
    human: "HU",
    agent: "AG",
    service: "SV",
    session: "SE",
    unknown: "--"
  };
  const normalizedLabel = label || (kind === "unknown" ? "Unassigned" : kind);
  return {
    kind,
    id,
    label: normalizedLabel,
    detail,
    initials: actorInitials(normalizedLabel, fallbackInitials[kind]),
    badge,
    title: [normalizedLabel, detail, badge].filter(Boolean).join(" / ")
  };
}

function actorInitials(value: string, fallback = "--"): string {
  const emailName = value.includes("@") ? value.split("@")[0] : value;
  const parts = emailName
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase() || fallback;
}

function renderActorChip(actor: ActorRef, options: { compact?: boolean; subtle?: boolean } = {}): string {
  const classes = [
    "actor-chip",
    `actor-chip-${actor.kind}`,
    options.compact ? "is-compact" : "",
    options.subtle ? "is-subtle" : ""
  ].filter(Boolean).join(" ");
  return `
    <span class="${escapeAttribute(classes)}" title="${escapeAttribute(actor.title)}">
      <span class="actor-avatar" aria-hidden="true">${escapeHtml(actor.initials)}</span>
      <span class="actor-chip-text">
        <strong>${escapeHtml(actor.label)}</strong>
        ${options.compact || !actor.detail ? "" : `<small>${escapeHtml(actor.detail)}</small>`}
      </span>
      ${options.compact || !actor.badge ? "" : `<span class="actor-badge">${escapeHtml(actor.badge)}</span>`}
    </span>
  `;
}

function renderActorRole(label: string, actor: ActorRef, compact = false): string {
  return `
    <div class="actor-role-row">
      <span class="meta-label">${escapeHtml(label)}</span>
      ${renderActorChip(actor, { compact })}
    </div>
  `;
}

function renderMetadataActorItem(label: string, actor: ActorRef): string {
  return renderMetadataHtmlItem(label, renderActorChip(actor, { compact: true }));
}

function renderMetadataHtmlItem(label: string, html: string): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd class="metadata-rich">${html}</dd>
    </div>
  `;
}

function shortSessionId(sessionId: unknown): string {
  const text = optionalText(sessionId);
  if (!text) return "";
  return text.length <= 12 ? text : `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function isExpiredTimestamp(value: unknown): boolean {
  const text = optionalText(value);
  if (!text) return false;
  const time = new Date(text).getTime();
  return !Number.isNaN(time) && time <= Date.now();
}

function renderFlowMessage(): string {
  if (!flowMessage) return "";
  return `<p class="flow-message ${escapeHtml(flowMessageTone)}">${escapeHtml(flowMessage)}</p>`;
}

function renderWorkItemCard(item: WorkItem, board: Board): string {
  const selectedClass = item.id === board.selectedId ? " is-selected" : "";
  const current = getWorkItemCurrentState(board, item);
  const openRequestText = current.openRequests.length ? formatCount(current.openRequests.length, "open request") : "";
  return `
    <article class="work-item-card${selectedClass}" tabindex="0" role="button" data-work-item-id="${escapeAttribute(item.id)}">
      <div class="card-heading-row">
        <h3 class="card-title">${escapeHtml(item.title || "Untitled card")}</h3>
        <span class="${escapeAttribute(attentionChipClass(current.attention))}">${escapeHtml(current.attention.label)}</span>
      </div>
      <p class="card-summary">${escapeHtml(item.summary || "No summary provided.")}</p>
      ${renderCardActorGrid(item, board)}
      <div class="card-state-footer">
        ${openRequestText ? `<span class="card-request-count">${escapeHtml(openRequestText)}</span>` : ""}
        <p>${escapeHtml(formatCardLatestActivity(current.latestComment, board))}</p>
      </div>
    </article>
  `;
}

function renderCardActorGrid(item: WorkItem, board: Board): string {
  const ownerActor = item.ownerMemberId
    ? actorFromMemberId(item.ownerMemberId)
    : actorFromAgent(board, item.ownerAgentId);
  const reviewerActor = item.reviewerMemberId
    ? actorFromMemberId(item.reviewerMemberId)
    : actorFromAgent(board, item.reviewerAgentId);
  const delegatedAgentIds = [
    item.ownerMemberId ? item.ownerAgentId : null,
    item.reviewerMemberId ? item.reviewerAgentId : null
  ]
    .filter((agentId): agentId is string => Boolean(agentId))
    .filter((agentId, index, ids) => ids.indexOf(agentId) === index);
  const showDelegatedAgent = delegatedAgentIds.length > 0;

  return `
    <div class="card-actor-grid">
      ${renderActorRole("Owner", ownerActor, true)}
      ${renderActorRole("Reviewer", reviewerActor, true)}
      ${showDelegatedAgent ? `
        <div class="card-delegated-agent">
          <span class="meta-label">Delegated agent</span>
          <div class="actor-chip-group">
            ${delegatedAgentIds.map((agentId) => renderActorChip(actorFromAgent(board, agentId), { compact: true })).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function attentionChipClass(attention: AttentionState): string {
  return ["chip", "attention-chip", attention.tone].filter(Boolean).join(" ");
}

function renderInspector(board: Board | null = getActiveBoardOrNull()): void {
  const selected = board ? getSelectedWorkItem() : null;

  if (!selected) {
    resetInspectorActivity();
    inspectorPanel.innerHTML = `
      <div class="inspector-label">
        <span>Inspector</span>
        <strong>No selection</strong>
      </div>
      <section class="empty-inspector" aria-labelledby="empty-inspector-title">
        <p class="eyebrow">Card detail</p>
        <h2 id="empty-inspector-title">Select a card</h2>
        <p>Details, review gates, approvals, and activity will appear here after cards exist.</p>
      </section>
    `;
    return;
  }
  if (!board) return;

  ensureInspectorActivity(board, selected);

  inspectorPanel.innerHTML = `
    <div class="inspector-label">
      <span>Inspector</span>
      <div class="inspector-label-actions">
        <strong>Selected card</strong>
        <button class="icon-action inspector-close" type="button" data-action="close-inspector-drawer" aria-label="Close inspector">x</button>
      </div>
    </div>
    <section class="work-item-detail">
      <div class="detail-header">
        <p class="eyebrow">Card detail</p>
        <h2>${escapeHtml(selected.title || "Untitled card")}</h2>
        <p>${escapeHtml(selected.summary || "No summary provided.")}</p>
      </div>
      ${renderPeopleAndAgentsPanel(selected, board)}
      ${renderCurrentStatePanel(selected, board)}
      <div class="comment-thread">
        <div class="section-heading">
          <h3>Activity</h3>
        </div>
        ${renderCommentThread(selected, board)}
      </div>
      ${renderInspectorActivityPanel()}
    </section>
  `;
}

function ensureInspectorActivity(board: Board, item: WorkItem): void {
  if (inspectorActivityBoardId === board.id && inspectorActivityCardId === item.id) return;
  inspectorActivityBoardId = board.id;
  inspectorActivityCardId = item.id;
  inspectorActivityEvents = [];
  inspectorActivityLoading = true;
  inspectorActivityUnavailable = false;
  inspectorActivityError = "";
  const requestScope: InspectorActivityRequestScope = {
    requestId: inspectorActivityRequestId + 1,
    boardId: board.id,
    cardId: item.id
  };
  inspectorActivityRequestId = requestScope.requestId;
  void loadInspectorActivity(requestScope);
}

function resetInspectorActivity(): void {
  inspectorActivityRequestId += 1;
  inspectorActivityBoardId = null;
  inspectorActivityCardId = null;
  inspectorActivityEvents = [];
  inspectorActivityLoading = false;
  inspectorActivityUnavailable = false;
  inspectorActivityError = "";
}

function closeInspectorDrawer(): void {
  inspectorDrawerOpen = false;
  render();
}

function isCurrentInspectorActivityRequest(scope: InspectorActivityRequestScope): boolean {
  const board = getActiveBoardOrNull();
  return Boolean(
    scope.requestId === inspectorActivityRequestId &&
    inspectorActivityBoardId === scope.boardId &&
    inspectorActivityCardId === scope.cardId &&
    board?.id === scope.boardId &&
    board.selectedId === scope.cardId &&
    board.workItems.some((item) => item.id === scope.cardId)
  );
}

async function loadInspectorActivity(scope: InspectorActivityRequestScope): Promise<void> {
  const params = new URLSearchParams({ cardId: scope.cardId, limit: "20" });
  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(scope.boardId)}/events?${params.toString()}`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (response.status === 404 || response.status === 405) {
      if (!isCurrentInspectorActivityRequest(scope)) return;
      inspectorActivityUnavailable = true;
      inspectorActivityEvents = [];
      return;
    }
    if (!response.ok) throw new Error(`Event request failed with ${response.status}`);
    const payload = await response.json();
    const rawEvents = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [];
    if (!isCurrentInspectorActivityRequest(scope)) return;
    inspectorActivityEvents = rawEvents.map(normalizeInspectorActivityEvent).filter(isNonNull);
    inspectorActivityUnavailable = false;
    inspectorActivityError = "";
  } catch (_error) {
    if (!isCurrentInspectorActivityRequest(scope)) return;
    inspectorActivityEvents = [];
    inspectorActivityUnavailable = true;
    inspectorActivityError = "Provenance is not available for this board.";
  } finally {
    if (isCurrentInspectorActivityRequest(scope)) {
      inspectorActivityLoading = false;
      renderInspector(getActiveBoardOrNull());
    }
  }
}

function renderPeopleAndAgentsPanel(item: WorkItem, board: Board): string {
  const ownerAgent = item.ownerAgentId ? actorFromAgent(board, item.ownerAgentId) : null;
  const reviewerAgent = item.reviewerAgentId ? actorFromAgent(board, item.reviewerAgentId) : null;
  const latestSessionEvent = inspectorActivityEvents.find((event) => activityValue(event.delegation, "sessionId") || activityValue(event.payload, "sessionId"));
  const latestEvent = inspectorActivityEvents[0] || null;
  const current = getWorkItemCurrentState(board, item);
  const lastActor = latestEvent?.actor
    ? actorFromProvenance(latestEvent.actor, board)
    : current.latestComment
      ? actorFromCommentAuthor(board, current.latestComment.author)
      : makeActorRef("unknown", "no-actor", "No activity", "", "");

  const agentRows = (() => {
    if (ownerAgent && reviewerAgent && item.ownerAgentId === item.reviewerAgentId) {
      return renderActorRole("Delegated agent", ownerAgent);
    }
    return [
      ownerAgent ? renderActorRole("Owner agent", ownerAgent) : "",
      reviewerAgent ? renderActorRole("Reviewer agent", reviewerAgent) : ""
    ].join("");
  })();

  return `
    <section class="people-agents-panel" aria-labelledby="people-agents-title">
      <div class="section-heading">
        <h3 id="people-agents-title">People & agents</h3>
      </div>
      <div class="actor-role-grid">
        ${renderActorRole("Requester", actorFromMemberId(item.requesterMemberId))}
        ${renderActorRole("Human owner", actorFromMemberId(item.ownerMemberId))}
        ${renderActorRole("Human reviewer", actorFromMemberId(item.reviewerMemberId))}
        ${agentRows || renderActorRole("Delegated agent", makeActorRef("unknown", "no-agent", "No agent", "", ""))}
        ${renderActorRole("Latest AgentSession", latestSessionEvent ? actorFromActivitySession(latestSessionEvent, board) : makeActorRef("unknown", "no-session", "No session yet", "", ""))}
        ${renderActorRole("Last actor", lastActor)}
      </div>
    </section>
  `;
}

function renderCurrentStatePanel(item: WorkItem, board: Board): string {
  const current = getWorkItemCurrentState(board, item);
  const laneTitle = current.lane?.title || "Unknown lane";
  return `
    <section class="current-state-panel" aria-labelledby="current-state-title">
      <div class="section-heading current-state-heading">
        <h3 id="current-state-title">Current state</h3>
        <span class="${escapeAttribute(attentionChipClass(current.attention))}">${escapeHtml(current.attention.label)}</span>
      </div>
      <div class="current-state-grid">
        ${renderStateGridItem("Lane", laneTitle)}
        ${renderStateGridItem("Open requests", String(current.openRequests.length))}
        ${renderStateGridItem("Change requests", String(current.openChangeRequests.length))}
        ${renderStateGridItem("Blockers", String(current.openBlockers.length))}
        ${renderStateGridItem("Approvals", String(current.approvals))}
        ${renderStateGridItem("Delivery", current.delivered ? "Delivered" : "Active")}
      </div>
      <div class="current-state-rows">
        <div class="current-state-row">
          <span class="meta-label">Latest</span>
          <p>${escapeHtml(formatLatestActivitySentence(current.latestComment, board))}</p>
        </div>
        <div class="current-state-row">
          <span class="meta-label">Open requests</span>
          <p>${escapeHtml(formatRequestSummary(current))}</p>
        </div>
      </div>
      ${renderGateSummary(current)}
    </section>
  `;
}

function renderStateGridItem(label: string, value: string): string {
  return `
    <div>
      <span class="meta-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderGateSummary(current: WorkItemCurrentState): string {
  if (!current.lane?.gate) return "";
  const checks = current.lane.gate.checks || [];
  return `
    <div class="gate-summary">
      <div>
        <span class="meta-label">Gate</span>
        <strong>${escapeHtml(current.lane.gate.title || `${current.lane.title} gate`)}</strong>
      </div>
      ${checks.length ? `
        <ul>
          ${checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}
        </ul>
      ` : '<p>No gate checks configured.</p>'}
    </div>
  `;
}

function normalizeInspectorActivityEvent(rawEvent: any): InspectorActivityEvent | null {
  if (!rawEvent || typeof rawEvent !== "object") return null;
  const payload = rawEvent.payload && typeof rawEvent.payload === "object" ? rawEvent.payload as AnyRecord : {};
  const actor = normalizeActivityObject(rawEvent.actor || payload.actor);
  const delegation = normalizeActivityObject(rawEvent.delegation || payload.delegation || payload.agentSession);
  const id = String(rawEvent.id || payload.id || makeId("activity"));
  return {
    id,
    type: String(rawEvent.type || payload.type || payload.event || payload.action || "event"),
    boardId: optionalText(rawEvent.boardId || rawEvent.board_id || payload.boardId),
    cardId: optionalText(rawEvent.cardId || rawEvent.card_id || rawEvent.workItemId || payload.cardId || payload.workItemId),
    payload,
    actor,
    delegation,
    createdAt: String(rawEvent.createdAt || rawEvent.created_at || payload.createdAt || payload.timestamp || "")
  };
}

function normalizeActivityObject(value: unknown): AnyRecord | null {
  return value && typeof value === "object" ? value as AnyRecord : null;
}

function renderInspectorActivityPanel(): string {
  const body = (() => {
    if (inspectorActivityLoading) return '<p class="empty-note">Loading provenance...</p>';
    if (inspectorActivityUnavailable) return `<p class="empty-note">${escapeHtml(inspectorActivityError || "Detailed provenance is not available on this server.")}</p>`;
    if (!inspectorActivityEvents.length) return '<p class="empty-note">No provenance events yet</p>';
    return inspectorActivityEvents.map(renderInspectorActivityEvent).join("");
  })();

  return `
    <section class="activity-provenance" aria-labelledby="activity-provenance-title">
      <div class="section-heading">
        <h3 id="activity-provenance-title">Provenance</h3>
      </div>
      <div class="activity-event-list">
        ${body}
      </div>
    </section>
  `;
}

function renderInspectorActivityEvent(event: InspectorActivityEvent): string {
  const board = getBoardById(event.boardId || "") || getActiveBoardOrNull();
  const actor = actorFromProvenance(event.actor, board);
  const sessionId = activityValue(event.delegation, "sessionId") || activityValue(event.payload, "sessionId");
  const projectId = activityValue(event.payload, "projectId") ||
    activityValue(event.actor, "projectId") ||
    activityValue(event.delegation, "projectId");
  const capabilities = formatActivityCapabilities(event.delegation?.capabilities || event.payload.capabilities);
  const reason = activityValue(event.delegation, "reason") || activityValue(event.payload, "reason");
  const delegatedBy = activityValue(event.delegation, "delegatedBy") || activityValue(event.payload, "delegatedBy");
  const sessionActor = sessionId ? actorFromActivitySession(event, board) : makeActorRef("unknown", "no-session", "No session", "", "");
  const delegatedActor = delegatedBy ? actorFromDelegatedBy(delegatedBy, board) : makeActorRef("unknown", "no-delegation", "No delegation", "", "");

  return `
    <article class="activity-event">
      <div class="activity-event-header">
        <div class="activity-event-actor">
          ${renderActorChip(actor, { compact: true })}
          <strong>${escapeHtml(formatActivityTitle(event))}</strong>
        </div>
        ${event.createdAt ? `<time datetime="${escapeAttribute(event.createdAt)}">${escapeHtml(formatDateTime(event.createdAt) || formatRelativeTime(event.createdAt))}</time>` : ""}
      </div>
      <dl class="metadata-grid compact">
        ${renderMetadataActorItem("Actor", actor)}
        ${renderMetadataActorItem("Session", sessionId ? sessionActor : makeActorRef("unknown", "no-session", "No session", "", ""))}
        ${renderMetadataItem("Project", projectId || "n/a")}
        ${renderMetadataActorItem("Delegated by", delegatedBy ? delegatedActor : makeActorRef("unknown", "no-delegation", "No delegation", "", ""))}
        ${renderMetadataItem("Capabilities", capabilities || "n/a")}
        ${renderMetadataItem("Reason", reason || "n/a")}
      </dl>
    </article>
  `;
}

function renderMetadataItem(label: string, value: unknown): string {
  const text = formatMetadataValue(value);
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(text)}</dd>
    </div>
  `;
}

function formatActivityTitle(event: InspectorActivityEvent): string {
  const action = activityValue(event.payload, "action") || event.type;
  const subjectType = activityValue(event.payload, "resource.type") ||
    activityValue(event.payload, "subject.type") ||
    activityValue(event.payload, "target.type") ||
    "event";
  return `${formatCommentKind(action)} / ${formatCommentKind(subjectType)}`;
}

function formatActivityCapabilities(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).join(", ") : String(value || "");
}

function activityValue(record: AnyRecord | null, path: string): string {
  if (!record) return "";
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as AnyRecord)[key];
  }, record);
  return formatMetadataValue(value);
}

function formatMetadataValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join(", ");
  if (typeof value === "object") return Object.entries(value as AnyRecord)
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join(", ");
  return String(value);
}

function renderCommentThread(item: WorkItem, board: Board): string {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  if (!comments.length) return '<p class="empty-note">No activity yet</p>';

  return comments.map((comment) => {
    const actor = actorFromCommentAuthor(board, comment.author);
    return `
      <article class="comment-card ${escapeAttribute(comment.kind || "note")}">
        <div class="comment-card-header">
          <div class="comment-actor-line">
            ${renderActorChip(actor, { compact: true })}
            <span class="comment-kind">${escapeHtml(comment.kind || "note")}</span>
          </div>
          <span class="comment-status">${escapeHtml(comment.status || "open")}</span>
        </div>
        <p>${escapeHtml(comment.text || "")}</p>
        <div class="comment-meta">
          <span>${escapeHtml(formatActorActionLabel(actor, "commented"))}</span>
          <time datetime="${escapeAttribute(comment.createdAt || "")}">${escapeHtml(formatDateTime(comment.createdAt))}</time>
        </div>
      </article>
    `;
  }).join("");
}

function formatCardLatestActivity(comment: WorkItemComment | null, board: Board): string {
  if (!comment) return "Latest: no activity yet";
  const actor = actorFromCommentAuthor(board, comment.author);
  const pieces = [
    actor.label,
    formatCommentKind(comment.kind),
    formatRelativeTime(comment.updatedAt || comment.createdAt)
  ].filter(Boolean);
  return `Latest: ${pieces.join(" / ")}`;
}

function formatLatestActivitySentence(comment: WorkItemComment | null, board: Board): string {
  if (!comment) return "No activity yet.";
  const actor = actorFromCommentAuthor(board, comment.author);
  const age = formatRelativeTime(comment.updatedAt || comment.createdAt);
  const suffix = age ? ` ${age}` : "";
  return `${formatActorActionLabel(actor, "posted")} ${formatCommentKind(comment.kind)}${suffix}.`;
}

function formatActorActionLabel(actor: ActorRef, verb: string): string {
  if (actor.kind === "session" && actor.delegatedBy) return `${actor.label} ${verb}`;
  return `${actor.label} ${verb}`;
}

function formatRequestSummary(current: WorkItemCurrentState): string {
  if (!current.openRequests.length) return "No open requests.";
  return [
    formatCount(current.openChangeRequests.length, "change request"),
    formatCount(current.openQuestions.length, "question"),
    formatCount(current.openInstructions.length, "instruction")
  ].filter(Boolean).join(", ");
}

function formatCount(count: number, singular: string): string {
  if (!count) return "";
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatCommentKind(kind: unknown): string {
  return String(kind || "note").replace(/_/g, " ");
}

function renderModals(board: Board | null): void {
  if (!modalRoot) return;
  if (teamSettingsDialogOpen) {
    modalRoot.innerHTML = renderTeamSettingsDialog();
  } else if (projectDialogOpen) {
    modalRoot.innerHTML = renderProjectDialog();
  } else if (boardSettingsDialogOpen && board) {
    modalRoot.innerHTML = renderBoardSettingsDialog(board);
  } else if (workItemDialogOpen && board) {
    modalRoot.innerHTML = renderCreateWorkItemDialog(board);
  } else if (agentConnectDialogOpen && board) {
    modalRoot.innerHTML = renderConnectAgentDialog(board);
  } else if (deleteBoardDialogOpen && board) {
    modalRoot.innerHTML = renderDeleteBoardDialog(board);
  } else {
    modalRoot.innerHTML = "";
  }
}

function renderTeamSettingsDialog(): string {
  const payload = teamSettingsData;
  const members = payload?.members || [];
  const invites = (payload?.invites || []).filter((invite) => invite.status === "pending");
  const roleOptions = renderTeamRoleOptions("member");
  const projectOptions = renderProjectAccessOptions(["*"]);
  const memberRows = members.length ? members.map(renderTeamMemberRow).join("") : '<li class="empty-note">No members yet</li>';
  const inviteRows = invites.length ? invites.map(renderTeamInviteRow).join("") : '<li class="empty-note">No pending invites</li>';
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card team-settings-modal" role="dialog" aria-modal="true" aria-labelledby="team-settings-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Team settings</p>
            <h2 id="team-settings-title">${escapeHtml(payload?.team.name || state.team.name || "kanban.cards")}</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-team-settings" aria-label="Close team settings">x</button>
        </div>
        ${teamSettingsError ? `<p class="flow-message warning">${escapeHtml(teamSettingsError)}</p>` : ""}
        ${teamSettingsLoading ? '<p class="empty-note">Loading team settings...</p>' : `
          <form class="modal-form team-invite-form" data-team-invite-form>
            <div class="field-grid">
              ${renderTextField({ label: "Invite email", autocomplete: "email", attributes: { "data-team-invite-email": true } })}
              ${renderSelectField({ label: "Role", optionsHtml: roleOptions, attributes: { "data-team-invite-role": true } })}
            </div>
            ${renderProjectAccessField(projectOptions, "data-team-invite-projects")}
            <div class="modal-actions">
              <button class="primary-button" type="submit" data-action="create-team-invite" ${teamSettingsSaving ? "disabled" : ""}>Create invite link</button>
            </div>
          </form>
          ${teamInviteAcceptUrl ? `
            <div class="copy-link-block">
              <span class="meta-label">Invite link</span>
              ${renderTextInput({ value: teamInviteAcceptUrl, attributes: { readonly: true, "data-team-invite-link": true }, ariaLabel: "Invite link" })}
              <button class="secondary-button small" type="button" data-action="copy-team-invite-link">Copy link</button>
            </div>
          ` : ""}
          <div class="team-settings-grid">
            <section>
              <div class="section-heading"><h3>Members</h3></div>
              <ul class="team-list">${memberRows}</ul>
            </section>
            <section>
              <div class="section-heading"><h3>Pending invites</h3></div>
              <ul class="team-list">${inviteRows}</ul>
            </section>
          </div>
        `}
      </section>
    </div>
  `;
}

function renderTeamMemberRow(member: PublicTeamMember): string {
  const editable = canManageMemberInUi(member);
  return `
    <li class="team-row" data-team-member-id="${escapeAttribute(member.id)}">
      <div class="team-row-main">
        ${renderActorChip(actorFromMember(member))}
        <span>${escapeHtml(member.userId)}</span>
      </div>
      <div class="team-row-controls">
        ${renderSelectField({ label: "Role", optionsHtml: renderTeamRoleOptions(member.role), attributes: { "data-team-member-role": true, disabled: !editable } })}
        ${renderProjectAccessField(renderProjectAccessOptions(member.projectIds), "data-team-member-projects", !editable)}
        <button class="secondary-button small" type="button" data-action="save-team-member" ${editable && !teamSettingsSaving ? "" : "disabled"}>Save</button>
        <button class="secondary-button small danger-button" type="button" data-action="remove-team-member" ${editable && !teamSettingsSaving ? "" : "disabled"}>Remove</button>
      </div>
    </li>
  `;
}

function renderTeamInviteRow(invite: PublicTeamInvite): string {
  const editable = canManageRoleInUi(invite.role);
  const actor = makeActorRef("human", invite.email, invite.email, "Pending invite", invite.role);
  return `
    <li class="team-row" data-team-invite-id="${escapeAttribute(invite.id)}">
      <div class="team-row-main">
        ${renderActorChip(actor, { subtle: true })}
        <span>${escapeHtml(invite.projectIds.includes("*") ? "All projects" : invite.projectIds.join(", "))}</span>
        <time datetime="${escapeAttribute(invite.expiresAt)}">${escapeHtml(formatDateTime(invite.expiresAt))}</time>
      </div>
      <button class="secondary-button small danger-button" type="button" data-action="revoke-team-invite" ${editable && !teamSettingsSaving ? "" : "disabled"}>Revoke</button>
    </li>
  `;
}

function renderTeamRoleOptions(selectedRole: TeamRole): string {
  const roles: TeamRole[] = authSession?.role === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
  if (!roles.includes(selectedRole)) roles.unshift(selectedRole);
  return roles.map((role) => `<option value="${role}" ${role === selectedRole ? "selected" : ""}>${role}</option>`).join("");
}

function renderProjectAccessOptions(projectIds: string[]): string {
  const allSelected = projectIds.includes("*");
  const options = [`<option value="*" ${allSelected ? "selected" : ""}>All projects</option>`];
  for (const project of state.projects) {
    options.push(`<option value="${escapeAttribute(project.id)}" ${!allSelected && projectIds.includes(project.id) ? "selected" : ""}>${escapeHtml(project.name)}</option>`);
  }
  return options.join("");
}

function renderProjectAccessField(optionsHtml: string, attributeName: string, disabled = false): string {
  return renderSelectField({
    label: "Project access",
    optionsHtml,
    attributes: {
      [attributeName]: true,
      multiple: true,
      size: Math.min(5, Math.max(2, state.projects.length + 1)),
      disabled
    }
  });
}

function renderProjectDialog(): string {
  const project = getActiveProject();
  const isCreate = projectDialogMode === "create";
  const title = isCreate ? "New project" : "Project settings";
  const nameValue = isCreate ? "" : project.name;
  const descriptionValue = isCreate ? "" : project.description || "";
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card project-settings-modal" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Project</p>
            <h2 id="project-dialog-title">${escapeHtml(title)}</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-project-dialog" aria-label="Close project dialog">x</button>
        </div>
        ${projectDialogError ? `<p class="flow-message warning">${escapeHtml(projectDialogError)}</p>` : ""}
        <form class="modal-form" data-project-form>
          ${renderTextField({ label: "Project name", value: nameValue, required: true, autocomplete: "off", attributes: { "data-project-field": "name" } })}
          ${renderTextAreaField({ label: "Description", value: descriptionValue, rows: 3, attributes: { "data-project-field": "description" } })}
          ${isCreate ? "" : `
            <dl class="settings-meta-grid">
              ${renderMetadataItem("Project ID", project.id)}
              ${renderMetadataItem("Team ID", project.teamId)}
              ${renderMetadataItem("Updated", formatDateTime(project.updatedAt) || "n/a")}
            </dl>
          `}
          <div class="modal-actions">
            <button class="secondary-button" type="button" data-action="cancel-project-dialog">Cancel</button>
            <button class="primary-button" type="submit" data-action="${isCreate ? "create-project" : "save-project-settings"}" ${projectDialogSaving ? "disabled" : ""}>${isCreate ? "Create project" : "Save project"}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderBoardSettingsDialog(board: Board): string {
  const projectOptions = state.projects.map((project) => `
    <option value="${escapeAttribute(project.id)}" ${project.id === board.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>
  `).join("");

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card board-settings-modal" role="dialog" aria-modal="true" aria-labelledby="board-settings-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Board settings</p>
            <h2 id="board-settings-title">${escapeHtml(board.name)}</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-board-settings" aria-label="Close board settings">x</button>
        </div>
        ${boardSettingsError ? `<p class="flow-message warning">${escapeHtml(boardSettingsError)}</p>` : ""}
        <form class="modal-form" data-board-settings-form>
          ${renderSelectField({ label: "Owning project", optionsHtml: projectOptions, attributes: { "data-board-settings-field": "projectId" } })}
          <dl class="settings-meta-grid">
            ${renderMetadataItem("Board ID", board.id)}
            ${renderMetadataItem("Project ID", board.projectId)}
            ${renderMetadataItem("Updated", formatDateTime(board.updatedAt) || "n/a")}
          </dl>
          <div class="modal-actions">
            <button class="secondary-button" type="button" data-action="cancel-board-settings">Cancel</button>
            <button class="primary-button" type="submit" data-action="save-board-settings" ${boardSettingsSaving ? "disabled" : ""}>Save board</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderConnectAgentDialog(board: Board): string {
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentConnectAgentId);
  if (!agent) {
    return `
      <div class="modal-backdrop" data-action="close-modal">
        <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="connect-agent-title">
          <div class="modal-header">
            <div>
              <p class="eyebrow">Agent access</p>
              <h2 id="connect-agent-title">Agent not found</h2>
            </div>
            <button class="icon-action" type="button" data-action="cancel-agent-connect" aria-label="Close agent connection">x</button>
          </div>
          <p class="modal-copy">Apply the board flow before creating local-agent access.</p>
        </section>
      </div>
    `;
  }

  const command = agentConnectToken?.token ? buildAgentSetupCommand(board, agent, agentConnectToken.token) : "";
  const tokenRows = agentConnectTokens.length
    ? agentConnectTokens.map((tokenRecord) => `
      <li class="token-row agent-session-row" data-agent-session-id="${escapeAttribute(tokenRecord.sessionId)}">
        <div class="token-row-main">
          <div class="token-row-heading">
            ${renderActorChip(actorFromSessionRecord(tokenRecord, board))}
            <span>Session ${escapeHtml(tokenRecord.sessionId || "n/a")} · token ending ${escapeHtml(tokenRecord.last4)}</span>
            <time datetime="${escapeAttribute(tokenRecord.createdAt || "")}">${escapeHtml(formatDateTime(tokenRecord.createdAt))}</time>
          </div>
          ${renderAgentTokenMetadata(tokenRecord, board)}
          ${renderAgentSessionTrace(tokenRecord, board)}
          <div class="agent-session-edit-grid">
            ${renderTextField({ label: "Label", value: tokenRecord.label || "", attributes: { "data-agent-session-label": true } })}
            ${renderTextField({ label: "Expires", value: formatDateTimeLocalInput(tokenRecord.expiresAt), attributes: { type: "datetime-local", "data-agent-session-expires": true } })}
            ${renderTextAreaField({ label: "Reason", value: tokenRecord.reason || "", rows: 2, className: "full-field", attributes: { "data-agent-session-reason": true } })}
            ${renderAgentSessionCapabilityGroup(tokenRecord.capabilities || [])}
          </div>
        </div>
        <div class="token-row-actions">
          <button class="secondary-button small" type="button" data-action="update-agent-session" data-session-id="${escapeAttribute(tokenRecord.sessionId)}" ${agentConnectLoading ? "disabled" : ""}>Save</button>
          <button class="secondary-button small danger-button" type="button" data-action="revoke-agent-session" data-session-id="${escapeAttribute(tokenRecord.sessionId)}" ${agentConnectLoading ? "disabled" : ""}>Revoke</button>
        </div>
      </li>
    `).join("")
    : '<li class="empty-note">No active AgentSessions</li>';

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card agent-connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-agent-title" aria-describedby="connect-agent-description">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Agent access</p>
            <h2 id="connect-agent-title">Connect ${escapeHtml(agent.name)}</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-agent-connect" aria-label="Close agent connection">x</button>
        </div>
        <p class="modal-copy" id="connect-agent-description">${escapeHtml(agent.id)} receives board-scoped AgentSession access for assigned cards.</p>
        ${agentConnectError ? `<p class="flow-message warning">${escapeHtml(agentConnectError)}</p>` : ""}
        <form class="modal-form" data-agent-session-form>
          ${renderFieldGrid(`
            ${renderTextField({ label: "Session label", value: `${agent.name} local session`, attributes: { "data-agent-session-label": true } })}
            ${renderTextField({ label: "Expires", value: "", attributes: { type: "datetime-local", "data-agent-session-expires": true } })}
          `)}
          ${renderTextAreaField({ label: "Reason", value: `Board-scoped access for ${agent.name}.`, rows: 2, attributes: { "data-agent-session-reason": true } })}
          ${renderAgentSessionCapabilityGroup(AGENT_SESSION_CAPABILITIES)}
          <div class="modal-actions">
            <button class="primary-button" type="button" data-action="create-agent-session" ${agentConnectLoading ? "disabled" : ""}>Create AgentSession</button>
          </div>
        </form>
        ${command ? `
          <div class="setup-command">
            <span class="meta-label">Setup command</span>
            ${renderTextArea({ value: command, rows: 4, attributes: { readonly: true, "data-agent-setup-command": true }, ariaLabel: "Agent setup command" })}
          </div>
          <div class="new-token-metadata">
            <div class="section-heading">
              <h3>New AgentSession</h3>
            </div>
            ${renderAgentTokenMetadata(agentConnectToken, board)}
            ${renderAgentSessionTrace(agentConnectToken, board)}
          </div>
        ` : ""}
        <div class="token-list-block">
          <div class="section-heading">
            <h3>Active AgentSessions</h3>
          </div>
          <ul class="token-list">
            ${tokenRows}
          </ul>
        </div>
      </section>
    </div>
  `;
}

function renderAgentSessionCapabilityGroup(selectedCapabilities: unknown): string {
  const selected = new Set(Array.isArray(selectedCapabilities) ? selectedCapabilities.map((capability) => String(capability)) : []);
  return renderCheckboxGroup({
    legend: "Capabilities",
    className: "agent-session-capabilities",
    gridClassName: "agent-session-capability-grid",
    options: AGENT_SESSION_CAPABILITIES.map((capability) => ({
      label: AGENT_SESSION_CAPABILITY_LABELS[capability],
      checked: selected.has(capability),
      attributes: {
        "data-agent-session-capability": capability
      }
    }))
  });
}

function renderAgentTokenMetadata(tokenRecord: PublicTokenRecord | CreatedAgentTokenPayload | null, board?: Board | null): string {
  if (!tokenRecord) return "";
  return `
    <dl class="metadata-grid token-metadata">
      ${renderMetadataActorItem("Session", actorFromSessionRecord(tokenRecord, board))}
      ${renderMetadataItem("Project", tokenRecord.projectId || "n/a")}
      ${renderMetadataActorItem("Delegated by", tokenRecord.delegatedBy ? actorFromDelegatedBy(tokenRecord.delegatedBy, board) : makeActorRef("unknown", "no-delegation", "No delegation", "", ""))}
      ${renderMetadataItem("Capabilities", formatMetadataValue(tokenRecord.capabilities) || "n/a")}
      ${renderMetadataItem("Expires", tokenRecord.expiresAt ? formatDateTime(tokenRecord.expiresAt) : "Never")}
      ${renderMetadataItem("Reason", tokenRecord.reason || "n/a")}
      ${renderMetadataItem("Last used", tokenRecord.lastUsedAt ? formatDateTime(tokenRecord.lastUsedAt) : "Never")}
    </dl>
  `;
}

function renderAgentSessionTrace(tokenRecord: PublicTokenRecord | CreatedAgentTokenPayload | null, board?: Board | null): string {
  if (!tokenRecord) return "";
  const agentActor = actorFromAgent(board, tokenRecord.agentId);
  const sessionActor = actorFromSessionRecord(tokenRecord, board);
  const delegatedActor = tokenRecord.delegatedBy
    ? actorFromDelegatedBy(tokenRecord.delegatedBy, board)
    : makeActorRef("unknown", "no-delegation", "No delegation", "", "");
  return `
    <div class="agent-session-trace-panel">
      <div class="actor-chip-group">
        ${renderActorChip(agentActor, { compact: true })}
        ${renderActorChip(sessionActor, { compact: true })}
        ${renderActorChip(delegatedActor, { compact: true, subtle: !tokenRecord.delegatedBy })}
      </div>
      <dl class="session-trace-list">
        ${renderMetadataItem("Status", sessionActor.status || "Active")}
        ${renderMetadataItem("Capabilities", formatMetadataValue(tokenRecord.capabilities) || "n/a")}
        ${renderMetadataItem("Reason", tokenRecord.reason || "n/a")}
        ${renderMetadataItem("Last used", tokenRecord.lastUsedAt ? formatDateTime(tokenRecord.lastUsedAt) : "Never")}
      </dl>
    </div>
  `;
}

function renderCreateWorkItemDialog(board: Board): string {
  const firstLane = board.lanes[0] || ({} as Partial<Lane>);
  const selectedLane = board.lanes.find((lane) => lane.id === workItemDialogLaneId) || firstLane;
  const selectedLaneId = selectedLane.id || "";
  const agentOptions = renderAgentOptions(board.agentSpecs || []);
  const memberOptions = renderMemberOptions(authSession?.memberId || null);
  const ownerMemberOptions = renderMemberOptions(null);
  const reviewerMemberOptions = renderMemberOptions(null);
  const hasMembers = getKnownMembers().length > 0;
  const laneOptions = board.lanes.map((lane) => `
    <option value="${escapeAttribute(lane.id)}" ${lane.id === selectedLaneId ? "selected" : ""}>${escapeHtml(lane.title)}</option>
  `).join("");

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-work-item-title" aria-describedby="create-work-item-description">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Card</p>
            <h2 id="create-work-item-title">New card</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-work-item" aria-label="Close card form">x</button>
        </div>
        <p class="modal-copy" id="create-work-item-description">Create a trackable card for human review and agent progress updates.</p>
        <form class="modal-form" data-work-item-form>
          ${renderTextField({ label: "Title", required: true, attributes: { "data-work-item-field": "title" } })}
          ${renderTextAreaField({ label: "Summary", rows: 3, attributes: { "data-work-item-field": "summary" } })}
          ${renderSelectField({ label: "Lane", optionsHtml: laneOptions, attributes: { "data-work-item-field": "laneId" } })}
          ${hasMembers ? renderFieldGrid(`
            ${renderSelectField({ label: "Requester", optionsHtml: memberOptions, attributes: { "data-work-item-field": "requesterMemberId" } })}
            ${renderSelectField({ label: "Human owner", optionsHtml: ownerMemberOptions, attributes: { "data-work-item-field": "ownerMemberId" } })}
            ${renderSelectField({ label: "Human reviewer", optionsHtml: reviewerMemberOptions, attributes: { "data-work-item-field": "reviewerMemberId" } })}
          `, "human-assignment-grid") : ""}
          ${board.agentSpecs?.length ? "" : '<p class="empty-note">No board agents configured yet. Add agents in Edit flow to make assignments selectable.</p>'}
          ${renderFieldGrid(`
            ${renderSelectField({ label: "Owner agent", optionsHtml: agentOptions(selectedLane.defaultOwnerAgentId), attributes: { "data-work-item-field": "ownerAgentId" } })}
            ${renderSelectField({ label: "Reviewer agent", optionsHtml: agentOptions(selectedLane.defaultReviewerAgentId), attributes: { "data-work-item-field": "reviewerAgentId" } })}
          `)}
          <div class="modal-actions">
            <button class="secondary-button" type="button" data-action="cancel-work-item">Cancel</button>
            <button class="primary-button" type="submit" data-action="create-work-item">Create card</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderDeleteBoardDialog(board: Board): string {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal-card danger-modal" role="dialog" aria-modal="true" aria-labelledby="delete-board-title" aria-describedby="delete-board-description">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Delete board</p>
            <h2 id="delete-board-title">Delete ${escapeHtml(board.name)}</h2>
          </div>
          <button class="icon-action" type="button" data-action="cancel-delete-board" aria-label="Close delete board confirmation">x</button>
        </div>
        <p class="modal-copy" id="delete-board-description">This removes the board, lanes, cards, drafts, and board history from the workspace. Type the board name exactly to confirm.</p>
        ${renderTextField({ label: "Board name", value: "", autocomplete: "off", attributes: { "data-delete-confirm": true, "aria-describedby": "delete-board-description" } })}
        <div class="modal-actions">
          <button class="primary-button danger-primary" type="button" data-action="confirm-delete-board" disabled>Delete board</button>
          <button class="secondary-button" type="button" data-action="cancel-delete-board">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

function resetBoardScopedUi(): void {
  resetFlowAiState();
  templateFormOpen = false;
  editingTemplateId = null;
  resetWorkItemDialogState();
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  boardSettingsDialogOpen = false;
  resetAgentConnectDialog();
  resetInspectorActivity();
  inspectorDrawerOpen = false;
}

function resetFlowAiState(): void {
  flowAiRequestId += 1;
  dismissToast(FLOW_AI_TOAST_KEY);
  flowMessage = "";
  flowMessageTone = "neutral";
  flowAiLoading = false;
  flowAiError = "";
  flowAiSummary = "";
  flowAiWarnings = [];
  flowApplyInFlight = false;
  flowAdvancedOpen = false;
}

async function openTeamSettingsDialog(): Promise<void> {
  if (!authSession || (authSession.role !== "owner" && authSession.role !== "admin")) return;
  teamSettingsDialogOpen = true;
  teamSettingsLoading = true;
  teamSettingsSaving = false;
  teamSettingsError = "";
  teamInviteAcceptUrl = "";
  projectDialogOpen = false;
  boardSettingsDialogOpen = false;
  resetWorkItemDialogState();
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  render();
  await reloadTeamSettings();
}

function closeTeamSettingsDialog(): void {
  teamSettingsDialogOpen = false;
  teamSettingsLoading = false;
  teamSettingsSaving = false;
  teamSettingsError = "";
  render();
}

async function reloadTeamSettings(): Promise<void> {
  if (!teamSettingsDialogOpen) return;
  teamSettingsLoading = true;
  render();
  try {
    teamSettingsData = await fetchApiJson<TeamSettingsPayload>(`${API_BASE_URL}/team`);
    teamSettingsError = "";
  } catch (error) {
    teamSettingsError = error instanceof Error ? error.message : "Could not load team settings.";
  } finally {
    teamSettingsLoading = false;
    render();
  }
}

async function createTeamInviteFromDialog(action: HTMLElement): Promise<void> {
  if (teamSettingsSaving) return;
  const form = action.closest("[data-team-invite-form]");
  const email = (form?.querySelector("[data-team-invite-email]") as FormControlElement | null)?.value.trim() || "";
  const role = ((form?.querySelector("[data-team-invite-role]") as FormControlElement | null)?.value || "member") as TeamRole;
  const projectIds = readProjectAccessSelection(form?.querySelector("[data-team-invite-projects]") as HTMLSelectElement | null);
  if (!email) {
    teamSettingsError = "Invite email is required.";
    render();
    return;
  }

  teamSettingsSaving = true;
  teamSettingsError = "";
  render();
  try {
    const payload = await fetchApiJson<{ invite: PublicTeamInvite; acceptUrl: string }>(`${API_BASE_URL}/team/invites`, {
      method: "POST",
      body: JSON.stringify({ email, role, projectIds })
    });
    teamInviteAcceptUrl = payload.acceptUrl;
    await reloadTeamSettings();
    showToast("Invite link created.");
  } catch (error) {
    teamSettingsError = error instanceof Error ? error.message : "Could not create invite.";
  } finally {
    teamSettingsSaving = false;
    render();
  }
}

async function saveTeamMemberFromDialog(action: HTMLElement): Promise<void> {
  if (teamSettingsSaving) return;
  const row = action.closest("[data-team-member-id]") as HTMLElement | null;
  const memberId = row?.dataset.teamMemberId;
  if (!memberId) return;
  const role = ((row.querySelector("[data-team-member-role]") as FormControlElement | null)?.value || "member") as TeamRole;
  const projectIds = readProjectAccessSelection(row.querySelector("[data-team-member-projects]") as HTMLSelectElement | null);
  teamSettingsSaving = true;
  teamSettingsError = "";
  render();
  try {
    await fetchApiJson<PublicTeamMember>(`${API_BASE_URL}/team/members/${encodeURIComponent(memberId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role, projectIds })
    });
    await reloadTeamSettings();
    await loadAuthSession();
    showToast("Member updated.");
  } catch (error) {
    teamSettingsError = error instanceof Error ? error.message : "Could not update member.";
  } finally {
    teamSettingsSaving = false;
    render();
  }
}

async function removeTeamMemberFromDialog(action: HTMLElement): Promise<void> {
  if (teamSettingsSaving) return;
  const row = action.closest("[data-team-member-id]") as HTMLElement | null;
  const memberId = row?.dataset.teamMemberId;
  if (!memberId) return;
  teamSettingsSaving = true;
  teamSettingsError = "";
  render();
  try {
    await fetchApiJson<PublicTeamMember>(`${API_BASE_URL}/team/members/${encodeURIComponent(memberId)}`, {
      method: "DELETE"
    });
    await reloadTeamSettings();
    showToast("Member removed.");
  } catch (error) {
    teamSettingsError = error instanceof Error ? error.message : "Could not remove member.";
  } finally {
    teamSettingsSaving = false;
    render();
  }
}

async function revokeTeamInviteFromDialog(action: HTMLElement): Promise<void> {
  if (teamSettingsSaving) return;
  const row = action.closest("[data-team-invite-id]") as HTMLElement | null;
  const inviteId = row?.dataset.teamInviteId;
  if (!inviteId) return;
  teamSettingsSaving = true;
  teamSettingsError = "";
  render();
  try {
    await fetchApiJson<PublicTeamInvite>(`${API_BASE_URL}/team/invites/${encodeURIComponent(inviteId)}`, {
      method: "DELETE"
    });
    await reloadTeamSettings();
    showToast("Invite revoked.");
  } catch (error) {
    teamSettingsError = error instanceof Error ? error.message : "Could not revoke invite.";
  } finally {
    teamSettingsSaving = false;
    render();
  }
}

async function copyTeamInviteLink(): Promise<void> {
  const input = modalRoot?.querySelector("[data-team-invite-link]") as HTMLInputElement | null;
  if (!input?.value) return;
  try {
    await navigator.clipboard?.writeText(input.value);
    showToast("Invite link copied.");
  } catch (_error) {
    input.select();
    showToast("Invite link selected.");
  }
}

function readProjectAccessSelection(select: HTMLSelectElement | null): string[] {
  if (!select) return ["*"];
  const values = Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean);
  if (!values.length || values.includes("*")) return ["*"];
  return values;
}

function canManageRoleInUi(role: TeamRole): boolean {
  if (authSession?.role === "owner") return true;
  return role !== "owner" && authSession?.role === "admin";
}

function canManageMemberInUi(member: PublicTeamMember): boolean {
  return canManageRoleInUi(member.role);
}

function openProjectCreateDialog(): void {
  projectDialogOpen = true;
  projectDialogMode = "create";
  projectDialogSaving = false;
  projectDialogError = "";
  teamSettingsDialogOpen = false;
  boardSettingsDialogOpen = false;
  resetWorkItemDialogState();
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  render();
  (modalRoot?.querySelector('[data-project-field="name"]') as HTMLElement | null)?.focus();
}

function openProjectSettingsDialog(): void {
  projectDialogOpen = true;
  projectDialogMode = "settings";
  projectDialogSaving = false;
  projectDialogError = "";
  teamSettingsDialogOpen = false;
  boardSettingsDialogOpen = false;
  resetWorkItemDialogState();
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  render();
  (modalRoot?.querySelector('[data-project-field="name"]') as HTMLElement | null)?.focus();
}

function closeProjectDialog(): void {
  projectDialogOpen = false;
  projectDialogSaving = false;
  projectDialogError = "";
  render();
}

async function activateProject(projectId: string): Promise<void> {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project || project.id === state.activeProjectId || projectActionInFlight) return;

  projectActionInFlight = true;
  try {
    await fetchApiJson<Project>(`${API_BASE_URL}/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ active: true })
    });
    state.activeProjectId = project.id;
    ensureActiveBoardWithinProject();
    resetBoardScopedUi();
    await reloadWorkspaceStateFromApi();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not switch project.");
  } finally {
    projectActionInFlight = false;
    render();
  }
}

async function saveProjectFromDialog(action: HTMLElement): Promise<void> {
  if (projectDialogSaving) return;
  const form = action.closest("[data-project-form]");
  const name = (form?.querySelector('[data-project-field="name"]') as FormControlElement | null)?.value.trim() || "";
  const description = (form?.querySelector('[data-project-field="description"]') as FormControlElement | null)?.value.trim() || "";
  if (!name) {
    projectDialogError = "Project name is required.";
    render();
    return;
  }

  projectDialogSaving = true;
  projectDialogError = "";
  render();

  try {
    if (projectDialogMode === "create") {
      await fetchApiJson<Project>(`${API_BASE_URL}/projects`, {
        method: "POST",
        body: JSON.stringify({ name, description, active: true })
      });
      projectDialogOpen = false;
      resetBoardScopedUi();
      await reloadWorkspaceStateFromApi();
      showToast("Project created.");
    } else {
      const project = getActiveProject();
      await fetchApiJson<Project>(`${API_BASE_URL}/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description })
      });
      projectDialogOpen = false;
      await reloadWorkspaceStateFromApi();
      showToast("Project saved.");
    }
  } catch (error) {
    projectDialogError = error instanceof Error ? error.message : "Could not save project.";
  } finally {
    projectDialogSaving = false;
    render();
  }
}

function openBoardSettingsDialog(): void {
  const board = getActiveBoardOrNull();
  if (!board) return;
  boardSettingsDialogOpen = true;
  boardSettingsSaving = false;
  boardSettingsError = "";
  teamSettingsDialogOpen = false;
  projectDialogOpen = false;
  resetWorkItemDialogState();
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  render();
}

function closeBoardSettingsDialog(): void {
  boardSettingsDialogOpen = false;
  boardSettingsSaving = false;
  boardSettingsError = "";
  render();
}

async function saveBoardSettingsFromDialog(action: HTMLElement): Promise<void> {
  const board = getActiveBoardOrNull();
  if (!board || boardSettingsSaving) return;
  const form = action.closest("[data-board-settings-form]");
  const projectId = (form?.querySelector('[data-board-settings-field="projectId"]') as FormControlElement | null)?.value || board.projectId;
  if (!state.projects.some((project) => project.id === projectId)) {
    boardSettingsError = "Choose an existing project.";
    render();
    return;
  }

  boardSettingsSaving = true;
  boardSettingsError = "";
  render();

  try {
    await fetchApiJson<Board>(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId, active: true })
    });
    if (projectId !== state.activeProjectId) {
      await fetchApiJson<Project>(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true })
      });
    }
    boardSettingsDialogOpen = false;
    resetBoardScopedUi();
    await reloadWorkspaceStateFromApi();
    showToast("Board settings saved.");
  } catch (error) {
    boardSettingsError = error instanceof Error ? error.message : "Could not save board settings.";
  } finally {
    boardSettingsSaving = false;
    render();
  }
}

async function createNewBoard(): Promise<void> {
  const projectId = state.activeProjectId || DEFAULT_PROJECT_ID;
  const name = uniqueBoardName("Untitled board");
  try {
    const createdBoard = await fetchApiJson<Board>(`${API_BASE_URL}/boards`, {
      method: "POST",
      body: JSON.stringify({ name, projectId })
    });
    state.boards.push(normalizeBoard(createdBoard, projectId, new Set(state.projects.map((project) => project.id))) || createdBoard);
    state.activeBoardId = createdBoard.id;
    state.activeProjectId = createdBoard.projectId || projectId;
    resetBoardScopedUi();
    await reloadWorkspaceStateFromApi();
    showToast("Board created.");
    render();
    return;
  } catch (_error) {
    if (apiOnline) showToast("Could not create board through the API. Creating a local draft.");
  }

  const board = createBoard(uniqueBoardName("Untitled board"), { projectId: state.activeProjectId || DEFAULT_PROJECT_ID });
  state.boards.push(board);
  state.activeBoardId = board.id;
  resetBoardScopedUi();
  saveState();
  render();
}

function switchBoard(boardId: string): void {
  if (!state.boards.some((board) => board.id === boardId && board.projectId === state.activeProjectId)) return;
  state.activeBoardId = boardId;
  resetBoardScopedUi();
  saveState();
  render();
}

function useTemplate(templateId: string): void {
  const template = getTemplate(templateId);
  if (!template) return;

  const board = getActiveBoard();
  if (shouldAdoptTemplateName(board)) {
    board.name = uniqueBoardName(template.name, board.id);
  }
  board.configDraft = {
    lanes: withUniqueLaneIds(clone(template.lanes)),
    agentSpecs: clone(template.agentSpecs || [])
  };
  board.flowPrompt = template.lanes.map((lane) => lane.title).join(", ");
  board.isEditingFlow = true;
  touchBoard(board);
  flowMessage = "";
  flowMessageTone = "neutral";
  flowAiSummary = `${template.name} template is ready to review.`;
  flowAiWarnings = [];
  flowAiError = "";
  flowAdvancedOpen = false;
  templateFormOpen = false;
  editingTemplateId = null;
  resetWorkItemDialogState();
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  showToast({
    title: "Template loaded",
    message: "Review the draft and apply it when ready.",
    tone: "success"
  });
  saveState();
  render();
}

function useFlowPromptChip(prompt: string | undefined): void {
  const text = String(prompt || "").trim();
  if (!text) return;
  const board = getActiveBoard();
  const current = String(board.flowPrompt || "").trim();
  board.flowPrompt = current ? `${current}\n\n${text}` : text;
  touchBoard(board);
  flowAiError = "";
  flowMessage = "";
  flowMessageTone = "neutral";
  saveState();
  render();
}

function shouldAdoptTemplateName(board: Board): boolean {
  if (!board.name.trim()) return true;
  if (/^Untitled board(?: \d+)?$/i.test(board.name)) return true;
  return board.name === "Untitled board" && state.boards.length === 1 && !board.lanes.length;
}

function canCreateWorkItems(board: Board): boolean {
  return Boolean(board?.lanes?.length && !board.isEditingFlow && !board.configDraft);
}

function resetWorkItemDialogState(): void {
  workItemDialogOpen = false;
  workItemDialogLaneId = null;
}

function openWorkItemDialog(laneId: string | null = null): void {
  const board = getActiveBoard();
  if (!canCreateWorkItems(board)) {
    workItemDialogLaneId = null;
    showToast(board.lanes.length ? "Apply or cancel flow edits before adding cards." : "Configure lanes before adding cards.");
    return;
  }

  workItemDialogOpen = true;
  workItemDialogLaneId = board.lanes.some((lane) => lane.id === laneId) ? laneId : null;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  flowActionsMenuOpen = false;
  render();
  (modalRoot?.querySelector('[data-work-item-field="title"]') as HTMLElement | null)?.focus();
}

function closeWorkItemDialog(): void {
  resetWorkItemDialogState();
  render();
}

async function openAgentConnectDialog(agentId: string | undefined): Promise<void> {
  if (!agentId) return;
  const board = getActiveBoard();
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentId);
  if (!agent) {
    showToast("Apply this agent before connecting it.");
    return;
  }

  resetWorkItemDialogState();
  deleteBoardDialogOpen = false;
  flowActionsMenuOpen = false;
  agentConnectRequestEpoch += 1;
  agentConnectDialogOpen = true;
  agentConnectAgentId = agent.id;
  agentConnectTokens = [];
  agentConnectToken = null;
  agentConnectLoading = true;
  agentConnectError = "";
  const requestScope = makeAgentConnectRequestScope(board.id, agent.id);
  render();
  await refreshAgentTokens(board.id, requestScope);
  if (!isCurrentAgentConnectRequest(requestScope)) return;
  (modalRoot?.querySelector("[data-agent-session-label]") as HTMLElement | null)?.focus();
}

function resetAgentConnectDialog(): void {
  agentConnectRequestEpoch += 1;
  agentConnectDialogOpen = false;
  agentConnectAgentId = null;
  agentConnectTokens = [];
  agentConnectToken = null;
  agentConnectLoading = false;
  agentConnectError = "";
}

function closeAgentConnectDialog(): void {
  resetAgentConnectDialog();
  render();
}

async function refreshAgentTokens(boardId: string = getActiveBoard().id, requestScope: AgentConnectRequestScope = makeAgentConnectRequestScope(boardId)): Promise<void> {
  if (!isCurrentAgentConnectRequest(requestScope)) return;
  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(boardId)}/agent-sessions`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`AgentSession list failed with ${response.status}`);
    const payload = await response.json();
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectTokens = Array.isArray(payload.sessions) ? payload.sessions : Array.isArray(payload.tokens) ? payload.tokens : [];
    agentConnectError = "";
  } catch (error) {
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectError = "Could not load active AgentSessions.";
  } finally {
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectLoading = false;
    render();
  }
}

async function createAgentTokenFromForm(action: HTMLElement): Promise<void> {
  const board = getActiveBoard();
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentConnectAgentId);
  if (!agent || agentConnectLoading) return;
  const requestScope = makeAgentConnectRequestScope(board.id, agent.id);
  if (!isCurrentAgentConnectRequest(requestScope)) return;

  const form = action.closest("[data-agent-session-form]");
  const label = (form?.querySelector("[data-agent-session-label]") as FormControlElement | null)?.value.trim() || `${agent.name} local session`;
  const reason = (form?.querySelector("[data-agent-session-reason]") as FormControlElement | null)?.value.trim() || `Board-scoped access for ${agent.name}.`;
  const expiresAt = readAgentSessionExpiresAt(form?.querySelector("[data-agent-session-expires]") as FormControlElement | null);
  const capabilities = readAgentSessionCapabilities(form);
  if (!capabilities.length) {
    agentConnectError = "Select at least one capability.";
    render();
    return;
  }
  agentConnectLoading = true;
  agentConnectError = "";
  render();

  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/agent-sessions`, {
      method: "POST",
      headers: apiHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ agentId: agent.id, label, capabilities, expiresAt, reason })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `AgentSession creation failed with ${response.status}`);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectToken = normalizeCreatedAgentTokenPayload(payload);
    await refreshAgentTokens(board.id, requestScope);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    showToast("AgentSession created.");
  } catch (error) {
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectError = error instanceof Error ? error.message : "Could not create AgentSession.";
    agentConnectLoading = false;
    render();
  }
}

function normalizeCreatedAgentTokenPayload(payload: any): CreatedAgentTokenPayload {
  if (payload?.session && typeof payload.session === "object") {
    return {
      ...payload.session,
      token: payload.token
    } as CreatedAgentTokenPayload;
  }
  if (payload?.tokenRecord && typeof payload.tokenRecord === "object") {
    return {
      ...payload.tokenRecord,
      token: payload.token
    } as CreatedAgentTokenPayload;
  }
  return payload as CreatedAgentTokenPayload;
}

async function updateAgentSession(action: HTMLElement): Promise<void> {
  const board = getActiveBoard();
  const requestScope = makeAgentConnectRequestScope(board.id, agentConnectAgentId);
  const row = action.closest("[data-agent-session-id]") as HTMLElement | null;
  const sessionId = row?.dataset.agentSessionId || action.dataset.sessionId || "";
  if (!sessionId || agentConnectLoading || !isCurrentAgentConnectRequest(requestScope)) return;
  const label = (row?.querySelector("[data-agent-session-label]") as FormControlElement | null)?.value.trim() || "Local agent";
  const reason = (row?.querySelector("[data-agent-session-reason]") as FormControlElement | null)?.value.trim() || "Board-scoped agent access.";
  const expiresAt = readAgentSessionExpiresAt(row?.querySelector("[data-agent-session-expires]") as FormControlElement | null);
  const capabilities = readAgentSessionCapabilities(row);
  if (!capabilities.length) {
    agentConnectError = "Select at least one capability.";
    render();
    return;
  }

  agentConnectLoading = true;
  agentConnectError = "";
  render();

  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/agent-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: apiHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ label, capabilities, expiresAt, reason })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `AgentSession update failed with ${response.status}`);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    if (agentConnectToken?.sessionId === sessionId && payload?.session) {
      agentConnectToken = { ...payload.session, token: agentConnectToken.token };
    }
    await refreshAgentTokens(board.id, requestScope);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    showToast("AgentSession updated.");
  } catch (error) {
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectError = error instanceof Error ? error.message : "Could not update AgentSession.";
    agentConnectLoading = false;
    render();
  }
}

async function revokeAgentSession(sessionId: string | undefined): Promise<void> {
  const board = getActiveBoard();
  const requestScope = makeAgentConnectRequestScope(board.id, agentConnectAgentId);
  if (!sessionId || agentConnectLoading || !isCurrentAgentConnectRequest(requestScope)) return;
  agentConnectLoading = true;
  agentConnectError = "";
  render();

  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/agent-sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `AgentSession revoke failed with ${response.status}`);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    if (agentConnectToken?.sessionId === sessionId) agentConnectToken = null;
    await refreshAgentTokens(board.id, requestScope);
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    showToast("AgentSession revoked.");
  } catch (error) {
    if (!isCurrentAgentConnectRequest(requestScope)) return;
    agentConnectError = error instanceof Error ? error.message : "Could not revoke AgentSession.";
    agentConnectLoading = false;
    render();
  }
}

function readAgentSessionCapabilities(root: Element | null | undefined): AgentCapability[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLInputElement>("[data-agent-session-capability]:checked"))
    .map((input) => input.dataset.agentSessionCapability || "")
    .filter((capability): capability is AgentCapability => AGENT_SESSION_CAPABILITIES.includes(capability as AgentCapability));
}

function readAgentSessionExpiresAt(input: FormControlElement | null | undefined): string | null {
  const value = input?.value.trim() || "";
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatDateTimeLocalInput(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function buildAgentSetupCommand(board: Board, agent: AgentSpec, token: string): string {
  const apiUrl = new URL(API_BASE_URL, window.location.origin).toString().replace(/\/$/, "");
  return `node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs setup --url ${apiUrl} --token ${token} --board ${board.id} --agent ${agent.id}`;
}

function createWorkItemFromForm(action: HTMLElement): void {
  const board = getActiveBoard();
  if (!canCreateWorkItems(board)) return;

  const form = action.closest("[data-work-item-form]");
  const title = (form?.querySelector('[data-work-item-field="title"]') as FormControlElement | null)?.value.trim() || "";
  if (!title) {
    showToast("Card title is required.");
    (form?.querySelector('[data-work-item-field="title"]') as HTMLElement | null)?.focus();
    return;
  }

  const requestedLaneId = (form?.querySelector('[data-work-item-field="laneId"]') as FormControlElement | null)?.value || "";
  const laneId = board.lanes.some((lane) => lane.id === requestedLaneId)
    ? requestedLaneId
    : board.lanes[0].id;
  const now = new Date().toISOString();
  const item: WorkItem = {
    id: makeId("item"),
    title,
    summary: (form?.querySelector('[data-work-item-field="summary"]') as FormControlElement | null)?.value.trim() || "",
    laneId,
    requesterMemberId: optionalText((form?.querySelector('[data-work-item-field="requesterMemberId"]') as FormControlElement | null)?.value),
    ownerMemberId: optionalText((form?.querySelector('[data-work-item-field="ownerMemberId"]') as FormControlElement | null)?.value),
    reviewerMemberId: optionalText((form?.querySelector('[data-work-item-field="reviewerMemberId"]') as FormControlElement | null)?.value),
    ownerAgentId: optionalText((form?.querySelector('[data-work-item-field="ownerAgentId"]') as FormControlElement | null)?.value),
    reviewerAgentId: optionalText((form?.querySelector('[data-work-item-field="reviewerAgentId"]') as FormControlElement | null)?.value),
    blockers: [],
    approvals: [],
    completed: false,
    delivered: false,
    comments: [],
    createdAt: now,
    updatedAt: now
  };

  board.workItems.push(item);
  board.selectedId = item.id;
  inspectorDrawerOpen = true;
  touchBoard(board);
  resetWorkItemDialogState();
  saveState();
  showToast("Card created.");
  render();
}

function syncWorkItemAgentDefaults(target: FormControlElement): void {
  const board = getActiveBoard();
  const form = target.closest("[data-work-item-form]");
  if (!form) return;

  if (target.dataset.workItemField === "ownerAgentId" || target.dataset.workItemField === "reviewerAgentId") {
    target.dataset.manual = "true";
    return;
  }

  if (target.dataset.workItemField !== "laneId") return;
  const lane = board.lanes.find((candidate) => candidate.id === target.value);
  if (!lane) return;

  const ownerSelect = form.querySelector('[data-work-item-field="ownerAgentId"]') as FormControlElement | null;
  const reviewerSelect = form.querySelector('[data-work-item-field="reviewerAgentId"]') as FormControlElement | null;
  if (ownerSelect && ownerSelect.dataset.manual !== "true") ownerSelect.value = lane.defaultOwnerAgentId || "";
  if (reviewerSelect && reviewerSelect.dataset.manual !== "true") reviewerSelect.value = lane.defaultReviewerAgentId || "";
}

function saveCurrentFlowAsTemplate(): void {
  const board = getActiveBoard();
  if (!getTemplateSourceLanes(board).length) return;
  templateFormOpen = true;
  editingTemplateId = null;
  render();
}

function saveTemplateFromForm(action: HTMLElement): void {
  const board = getActiveBoard();
  const sourceLanes = getTemplateSourceLanes(board);
  if (!sourceLanes.length) return;

  const form = action.closest("[data-template-form]");
  const name = (form?.querySelector('[data-template-field="name"]') as FormControlElement | null)?.value.trim() || "";
  const description = (form?.querySelector('[data-template-field="description"]') as FormControlElement | null)?.value.trim() || "";
  if (!name) {
    showToast("Template name is required.");
    return;
  }

  state.templates.push({
    id: makeId("template"),
    name: uniqueTemplateName(name),
    description,
    builtIn: false,
    lanes: withUniqueLaneIds(clone(sourceLanes)),
    agentSpecs: clone(getTemplateSourceAgentSpecs(board)),
    createdAt: new Date().toISOString()
  });

  templateFormOpen = false;
  saveState();
  showToast("Template saved.");
  render();
}

function getTemplateSourceLanes(board: Board): Lane[] {
  const draft = normalizeDraft(board.configDraft);
  if (draft?.lanes?.length) return draft.lanes;
  return board.lanes || [];
}

function getTemplateSourceAgentSpecs(board: Board): AgentSpec[] {
  const draft = normalizeDraft(board.configDraft);
  if (draft?.agentSpecs?.length) return draft.agentSpecs;
  return board.agentSpecs || [];
}

function renameTemplate(templateId: string): void {
  const template = state.templates.find((candidate) => candidate.id === templateId);
  if (!template) return;

  editingTemplateId = template.id;
  render();
}

function applyTemplateRename(action: HTMLElement): void {
  const templateId = action.dataset.templateId;
  const template = state.templates.find((candidate) => candidate.id === templateId);
  if (!template) return;

  const card = action.closest(".template-card");
  const name = (card?.querySelector('[data-template-field="name"]') as FormControlElement | null)?.value.trim() || "";
  const description = (card?.querySelector('[data-template-field="description"]') as FormControlElement | null)?.value.trim() || "";
  if (!name) {
    showToast("Template name is required.");
    return;
  }

  template.name = uniqueTemplateName(name, template.id);
  template.description = description;
  editingTemplateId = null;
  saveState();
  showToast("Template renamed.");
  render();
}

function cancelTemplateRename(): void {
  editingTemplateId = null;
  render();
}

function deleteTemplate(templateId: string): void {
  const template = state.templates.find((candidate) => candidate.id === templateId);
  if (!template) return;

  state.templates = state.templates.filter((candidate) => candidate.id !== templateId);
  if (editingTemplateId === templateId) editingTemplateId = null;
  saveState();
  showToast("Template deleted.");
  render();
}

async function generateDraftFromPrompt(): Promise<void> {
  const board = getActiveBoard();
  const prompt = String(board.flowPrompt || "").trim();

  if (!prompt) {
    flowMessage = "";
    flowMessageTone = "neutral";
    showFlowAiToast({
      title: "Flow command needed",
      message: "Describe the workflow you want before generating a draft.",
      tone: "warning"
    });
    render();
    return;
  }

  const requestConfigDraft = normalizeDraft(board.configDraft);
  const requestContext = buildFlowAiRequestContext(board, requestConfigDraft);
  const requestScope: FlowAiRequestScope = {
    requestId: flowAiRequestId + 1,
    boardId: board.id,
    contextKey: JSON.stringify(requestContext)
  };
  flowAiRequestId = requestScope.requestId;

  flowAiLoading = true;
  flowAiError = "";
  flowAiSummary = "";
  flowAiWarnings = [];
  flowMessage = "";
  flowMessageTone = "neutral";
  const previousConfigDraft = clone(board.configDraft);
  const previousIsEditingFlow = board.isEditingFlow;
  board.isEditingFlow = true;
  render();

  try {
    const payload = await fetchApiJson<FlowAiDraftPayload>(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/flow/ai-draft`, {
      method: "POST",
      body: JSON.stringify({
        prompt: buildFlowAiPromptWithContext(prompt, requestContext),
        command: prompt,
        flowPrompt: prompt,
        configDraft: requestConfigDraft,
        context: requestContext
      })
    });
    const currentBoard = getCurrentFlowAiBoard(requestScope);
    if (!currentBoard) return;
    const draft = normalizeDraft(payload.draft);
    if (!draft || draft.lanes.length < MIN_LANES) throw new Error("LM Studio returned a draft without enough lanes.");
    currentBoard.configDraft = draft;
    currentBoard.isEditingFlow = true;
    flowAiSummary = payload.summary || "AI flow draft ready.";
    flowAiWarnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    flowMessage = "";
    flowMessageTone = "neutral";
    touchBoard(currentBoard);
    saveState();
    showFlowAiToast({
      title: "Flow draft ready",
      message: `${payload.model ? `Draft generated with ${payload.model}. ` : ""}Review the preview, then apply it when ready.${flowAiWarnings.length ? ` ${flowAiWarnings.length} warning${flowAiWarnings.length === 1 ? "" : "s"} included in the preview.` : ""}`,
      tone: "success"
    });
  } catch (error) {
    const currentBoard = getCurrentFlowAiBoard(requestScope);
    if (!currentBoard) return;
    const message = error instanceof Error ? error.message : "Could not generate flow draft.";
    currentBoard.configDraft = previousConfigDraft;
    currentBoard.isEditingFlow = previousIsEditingFlow;
    flowAiError = "";
    flowMessage = "";
    flowMessageTone = "neutral";
    showFlowAiToast({
      title: "Flow draft failed",
      message,
      tone: "warning"
    });
  } finally {
    if (isLatestFlowAiRequestForBoard(requestScope)) {
      flowAiLoading = false;
      render();
    }
  }
}

async function applyBoard(): Promise<void> {
  const board = getActiveBoard();
  const draft = normalizeDraft(board.configDraft);

  if (!draft || draft.lanes.length < MIN_LANES) {
    flowMessage = "";
    flowMessageTone = "neutral";
    showFlowAiToast({
      title: "Flow cannot be applied",
      message: "Keep at least two lanes before applying the board.",
      tone: "warning"
    });
    render();
    return;
  }

  const requestScope = makeFlowApplyRequestScope(board.id);
  flowApplyInFlight = true;
  flowAiError = "";
  render();

  try {
    const payload = await fetchApiJson<FlowApplyPayload>(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/flow/apply`, {
      method: "POST",
      body: JSON.stringify({
        draft,
        flowPrompt: board.flowPrompt,
        source: "ai"
      })
    });
    if (!isCurrentFlowApplyRequest(requestScope)) return;
    await reloadWorkspaceStateFromApi();
    if (!isCurrentFlowApplyRequest(requestScope)) return;
    state.activeBoardId = payload.board.id;
    templateFormOpen = false;
    flowAdvancedOpen = false;
    flowAiSummary = "Flow applied without deleting cards.";
    flowAiWarnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    const movedCount = payload.movedCards?.length || 0;
    flowMessage = "";
    flowMessageTone = "neutral";
    showFlowAiToast({
      title: "Flow applied",
      message: movedCount
        ? `${movedCount} card${movedCount === 1 ? "" : "s"} remapped. Existing cards were preserved.`
        : "Existing cards were preserved.",
      tone: "success"
    });
  } catch (error) {
    if (!isCurrentFlowApplyRequest(requestScope)) return;
    const message = error instanceof Error ? error.message : "Could not apply flow.";
    flowAiError = "";
    flowMessage = "";
    flowMessageTone = "neutral";
    showFlowAiToast({
      title: "Flow apply failed",
      message,
      tone: "warning"
    });
  } finally {
    if (isCurrentFlowApplyRequest(requestScope)) {
      flowApplyInFlight = false;
      render();
    }
  }
}

function editCurrentFlow(): void {
  const board = getActiveBoard();
  if (!board.lanes.length) return;

  board.configDraft = {
    lanes: clone(board.lanes),
    agentSpecs: clone(board.agentSpecs || [])
  };
  board.isEditingFlow = true;
  templateFormOpen = false;
  resetFlowAiState();
  saveState();
  render();
}

function toggleFlowActionsMenu(): void {
  flowActionsMenuOpen = !flowActionsMenuOpen;
  render();
}

function openDeleteBoardDialog(): void {
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = true;
  resetWorkItemDialogState();
  resetAgentConnectDialog();
  render();
  (modalRoot?.querySelector("[data-delete-confirm]") as HTMLElement | null)?.focus();
}

function closeDeleteBoardDialog(): void {
  deleteBoardDialogOpen = false;
  render();
}

function syncDeleteConfirmState(input: FormControlElement): void {
  const board = getActiveBoard();
  const dialog = input.closest(".modal-card");
  const deleteButton = dialog?.querySelector('[data-action="confirm-delete-board"]');
  if (deleteButton) (deleteButton as HTMLButtonElement).disabled = input.value !== board.name;
}

function deleteCurrentBoardFromDialog(action: HTMLElement): void {
  const board = getActiveBoard();
  const dialog = action.closest(".modal-card");
  const confirmInput = dialog?.querySelector("[data-delete-confirm]") as FormControlElement | null;
  if (!confirmInput || confirmInput.value !== board.name) {
    showToast("Type the board name exactly to delete it.");
    confirmInput?.focus();
    return;
  }

  const boardIndex = state.boards.findIndex((candidate) => candidate.id === board.id);
  if (boardIndex === -1) return;

  const deletedName = board.name;
  const deletedProjectId = board.projectId;
  state.boards.splice(boardIndex, 1);
  const projectBoards = state.boards.filter((candidate) => candidate.projectId === deletedProjectId);
  const nextIndex = Math.min(boardIndex, projectBoards.length - 1);
  state.activeBoardId = projectBoards[nextIndex]?.id || "";

  resetBoardScopedUi();
  saveState();
  showToast(`${deletedName} deleted.`);
  render();
}

function startOver(): void {
  const board = getActiveBoard();
  if (board.lanes.length) {
    board.configDraft = null;
    board.isEditingFlow = false;
  } else {
    board.flowPrompt = "";
    board.configDraft = null;
    board.isEditingFlow = false;
  }

  resetFlowAiState();
  templateFormOpen = false;
  saveState();
  render();
}

function ensureDraft(): BoardDraft {
  const board = getActiveBoard();
  if (!board.configDraft) {
    board.configDraft = {
      lanes: board.lanes.length
        ? clone(board.lanes)
        : [
            makeLane("Intake", defaultLaneDescription("Intake", "Review"), "Review"),
            makeLane("Review", defaultLaneDescription("Review", ""), "")
          ],
      agentSpecs: clone(board.agentSpecs || [])
    };
  }
  if (!Array.isArray(board.configDraft.agentSpecs)) board.configDraft.agentSpecs = clone(board.agentSpecs || []);
  board.isEditingFlow = true;
  return board.configDraft;
}

function addLane(): void {
  const draft = ensureDraft();
  if (draft.lanes.length >= MAX_LANES) {
    flowMessage = "";
    flowMessageTone = "neutral";
    showToast({
      message: `Use ${MAX_LANES} lanes or fewer.`,
      tone: "warning"
    });
    render();
    return;
  }

  draft.lanes.push(makeLane("New stage", "Work in this stage is ready for review."));
  draft.lanes = withUniqueLaneIds(draft.lanes);
  flowMessage = "";
  flowMessageTone = "neutral";
  saveState();
  render();
}

function removeLane(laneIndex: number): void {
  const draft = ensureDraft();
  if (draft.lanes.length <= MIN_LANES) return;
  draft.lanes.splice(laneIndex, 1);
  draft.lanes = withUniqueLaneIds(draft.lanes);
  saveState();
  render();
}

function moveLane(laneIndex: number, direction: number): void {
  const draft = ensureDraft();
  const nextIndex = laneIndex + direction;
  if (nextIndex < 0 || nextIndex >= draft.lanes.length) return;

  const [lane] = draft.lanes.splice(laneIndex, 1);
  draft.lanes.splice(nextIndex, 0, lane);
  saveState();
  render();
}

function addCheck(laneIndex: number): void {
  const draft = ensureDraft();
  const lane = draft.lanes[laneIndex];
  if (!lane) return;

  lane.gate.checks.push("Review note is captured.");
  saveState();
  render();
}

function addAgent(): void {
  const draft = ensureDraft();
  const id = uniqueAgentId("agent");
  draft.agentSpecs = draft.agentSpecs || [];
  draft.agentSpecs.push({
    id,
    name: "New agent",
    role: "Workflow agent",
    laneIds: [],
    instructions: "",
    skillNotes: ""
  });
  saveState();
  render();
}

function removeAgent(agentIndex: number): void {
  const board = getActiveBoard();
  const draft = ensureDraft();
  const agent = draft.agentSpecs?.[agentIndex];
  if (!agent) return;

  const isAssignedToItem = board.workItems.some((item) => item.ownerAgentId === agent.id || item.reviewerAgentId === agent.id);
  if (isAssignedToItem) {
    showToast("Clear or reassign cards before deleting this agent.");
    return;
  }

  draft.agentSpecs.splice(agentIndex, 1);
  draft.lanes = draft.lanes.map((lane) => ({
    ...lane,
    defaultOwnerAgentId: lane.defaultOwnerAgentId === agent.id ? null : lane.defaultOwnerAgentId,
    defaultReviewerAgentId: lane.defaultReviewerAgentId === agent.id ? null : lane.defaultReviewerAgentId
  }));
  saveState();
  render();
}

function removeCheck(laneIndex: number, checkIndex: number): void {
  const draft = ensureDraft();
  const lane = draft.lanes[laneIndex];
  if (!lane || lane.gate.checks.length <= 1) return;

  lane.gate.checks.splice(checkIndex, 1);
  saveState();
  render();
}

function updateDraftField(target: FormControlElement): void {
  const board = getActiveBoard();

  if (target.matches("[data-agent-field], [data-agent-lane-id]")) {
    updateAgentField(target);
    return;
  }

  if (target.id === "board-name") {
    board.name = target.value;
    touchBoard(board);
    saveState();
    renderTopbar(board);
    return;
  }

  if (target.id === "flow-prompt") {
    board.flowPrompt = target.value;
    touchBoard(board);
    saveState();
    return;
  }

  const field = target.dataset.field;
  if (!field) return;

  const laneEditor = target.closest(".lane-editor") as HTMLElement | null;
  if (!laneEditor || !board.configDraft) return;

  const laneIndex = Number(laneEditor.dataset.laneIndex);
  const lane = board.configDraft.lanes[laneIndex];
  if (!lane) return;

  if (field === "title") {
    lane.title = target.value;
  } else if (field === "description") {
    lane.description = target.value;
  } else if (field === "gateTitle") {
    lane.gate.title = target.value;
  } else if (field === "check") {
    const checkEditor = target.closest(".check-editor") as HTMLElement | null;
    const checkIndex = Number(checkEditor?.dataset.checkIndex);
    if (Number.isInteger(checkIndex)) lane.gate.checks[checkIndex] = target.value;
  } else if (field === "defaultOwnerAgentId") {
    lane.defaultOwnerAgentId = optionalText(target.value);
  } else if (field === "defaultReviewerAgentId") {
    lane.defaultReviewerAgentId = optionalText(target.value);
  }

  touchBoard(board);
  saveState();
}

function updateAgentField(target: FormControlElement): void {
  const board = getActiveBoard();
  const draft = ensureDraft();
  const agentEditor = target.closest(".agent-editor") as HTMLElement | null;
  const agentIndex = Number(agentEditor?.dataset.agentIndex);
  const agent = draft.agentSpecs?.[agentIndex];
  if (!agent) return;

  if (target.matches("[data-agent-lane-id]")) {
    const laneId = target.dataset.agentLaneId || "";
    const laneIds = new Set(agent.laneIds || []);
    if ((target as HTMLInputElement).checked) laneIds.add(laneId);
    else laneIds.delete(laneId);
    agent.laneIds = [...laneIds].filter((id) => draft.lanes.some((lane) => lane.id === id));
    saveState();
    render();
    return;
  }

  const field = target.dataset.agentField;
  if (!field) return;

  if (field === "id") {
    const previousId = agent.id;
    const nextId = slugify(target.value) || previousId;
    if (nextId !== previousId && board.workItems.some((item) => item.ownerAgentId === previousId || item.reviewerAgentId === previousId)) {
      showToast("Clear or reassign cards before changing this agent ID.");
      render();
      return;
    }
    agent.id = uniqueAgentId(nextId, previousId);
    draft.lanes.forEach((lane) => {
      if (lane.defaultOwnerAgentId === previousId) lane.defaultOwnerAgentId = agent.id;
      if (lane.defaultReviewerAgentId === previousId) lane.defaultReviewerAgentId = agent.id;
    });
  } else if (field === "name") {
    agent.name = target.value;
  } else if (field === "role") {
    agent.role = target.value;
  } else if (field === "instructions") {
    agent.instructions = target.value;
  } else if (field === "skillNotes") {
    agent.skillNotes = target.value;
  }

  saveState();
}

function parseFlowPrompt(prompt: unknown): string[] {
  const normalized = String(prompt || "")
    .replace(/\r/g, "\n")
    .replace(/[→>]+/g, ",")
    .replace(/\b(?:then|to)\b/gi, ",")
    .replace(/[;\n]+/g, ",");

  return normalized
    .split(",")
    .map(cleanStageLabel)
    .filter(Boolean)
    .map(toTitleCase)
    .filter((stage, index, stages) => stages.indexOf(stage) === index);
}

function cleanStageLabel(label: string): string {
  return String(label || "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      if (!word) return "";
      if (word === word.toUpperCase() && word.length <= 4) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function makeLane(title: string, description = "", nextTitle = ""): Lane {
  const cleanTitle = String(title || "Stage").trim();
  const lane = normalizeLane({
    id: slugify(cleanTitle),
    title: cleanTitle,
    description,
    gate: {
      title: `${cleanTitle} gate`,
      checks: defaultGateChecks(cleanTitle, nextTitle)
    }
  });
  if (!lane) throw new Error("Unable to create lane.");
  return lane;
}

function laneWithAgents(title: string, description = "", nextTitle = "", ownerAgentId = "", reviewerAgentId = ""): Lane {
  return {
    ...makeLane(title, description, nextTitle),
    defaultOwnerAgentId: optionalText(ownerAgentId),
    defaultReviewerAgentId: optionalText(reviewerAgentId)
  };
}

function makeAgentSpec(id: string, name: string, role = "", laneIds: string[] = [], instructions = "", skillNotes = ""): AgentSpec {
  const agent = normalizeAgentSpec({
    id,
    name,
    role,
    laneIds,
    instructions,
    skillNotes
  }, new Set(laneIds));
  if (!agent) throw new Error("Unable to create agent spec.");
  return agent;
}

function defaultLaneDescription(title: string, nextTitle: string): string {
  if (nextTitle) return `Work is prepared for ${nextTitle}.`;
  return `${title} work is ready for closeout.`;
}

function defaultGateChecks(title: string, nextTitle = ""): string[] {
  return [
    "Output is reviewable.",
    "Blockers and open questions are captured.",
    nextTitle ? `Handoff to ${nextTitle} is clear.` : "Closeout decision is clear."
  ];
}

function withUniqueLaneIds(lanes: Lane[]): Lane[] {
  const used = new Map<string, number>();
  return lanes.map((lane) => {
    const baseId = slugify(lane.id) || slugify(lane.title) || "lane";
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    const id = nextCount === 1 ? baseId : `${baseId}-${nextCount}`;

    return {
      ...lane,
      id,
      defaultOwnerAgentId: optionalText(lane.defaultOwnerAgentId),
      defaultReviewerAgentId: optionalText(lane.defaultReviewerAgentId),
      gate: {
        title: lane.gate?.title || `${lane.title} gate`,
        checks: Array.isArray(lane.gate?.checks) ? [...lane.gate.checks] : defaultGateChecks(lane.title)
      }
    };
  });
}

function withUniqueAgentIds(agentSpecs: AgentSpec[]): AgentSpec[] {
  const used = new Map<string, number>();
  return agentSpecs.map((agent) => {
    const baseId = slugify(agent.id) || "agent";
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    return {
      ...agent,
      id: nextCount === 1 ? baseId : `${baseId}-${nextCount}`
    };
  });
}

function uniqueBoardName(baseName: string, excludeId = ""): string {
  const base = String(baseName || "Untitled board").trim() || "Untitled board";
  const names = new Set(
    state.boards
      .filter((board) => board.id !== excludeId)
      .map((board) => board.name.toLowerCase())
  );

  if (!names.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

function uniqueTemplateName(baseName: string, excludeId = ""): string {
  const base = String(baseName || "Saved template").trim() || "Saved template";
  const names = new Set(
    state.templates
      .filter((template) => template.id !== excludeId)
      .map((template) => template.name.toLowerCase())
  );

  if (!names.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

function uniqueAgentId(baseId: string, excludeId = ""): string {
  const draft = getActiveBoard().configDraft;
  const base = slugify(baseId || "agent") || "agent";
  const ids = new Set(
    (draft?.agentSpecs || [])
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.id.toLowerCase())
  );

  if (!ids.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (ids.has(`${base}-${suffix}`.toLowerCase())) suffix += 1;
  return `${base}-${suffix}`;
}

function slugify(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildAliasMap<T extends { id: string }>(rawRecords: AnyRecord[], normalizedRecords: T[], fields: string[]): AliasMap {
  const aliases: AliasMap = new Map();
  rawRecords.forEach((rawRecord, index) => {
    const normalizedId = normalizedRecords[index]?.id;
    if (!normalizedId) return;
    addAlias(aliases, normalizedId, normalizedId);
    for (const field of fields) addAlias(aliases, rawRecord[field], normalizedId);
  });
  return aliases;
}

function addAlias(aliases: AliasMap, value: unknown, normalizedId: string): void {
  const raw = String(value || "").trim();
  if (!raw) return;
  if (!aliases.has(raw)) aliases.set(raw, normalizedId);
  const slug = slugify(raw);
  if (slug && !aliases.has(slug)) aliases.set(slug, normalizedId);
}

function resolveAlias(value: unknown, aliases: AliasMap): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return aliases.get(raw) || aliases.get(slugify(raw)) || null;
}

function normalizeLinkedAgentId(value: unknown, agentIds: Set<string>, agentAliases: AliasMap): string | null {
  const raw = optionalText(value);
  if (!raw) return null;
  const resolved = resolveAlias(raw, agentAliases) || raw;
  return !agentIds.size || agentIds.has(resolved) ? resolved : null;
}

function showToast(input: string | ToastOptions): void {
  if (!toastRegion) return;
  const options: ToastOptions = typeof input === "string" ? { message: input } : input;
  const message = String(options.message || "").trim();
  if (!message) return;
  const key = String(options.key || "").trim();
  if (key) {
    toastRegion.querySelectorAll(`[data-toast-key="${cssEscape(key)}"]`).forEach((existingToast) => existingToast.remove());
  }
  const toast = document.createElement("div");
  toast.className = `toast${toastToneClass(options.tone)}${options.persistent ? " is-persistent" : ""}`;
  toast.setAttribute("role", toastRole(options.tone));
  if (key) toast.dataset.toastKey = key;

  const content = document.createElement("div");
  content.className = "toast-content";
  const title = String(options.title || "").trim();
  if (title) {
    const titleElement = document.createElement("strong");
    titleElement.className = "toast-title";
    titleElement.textContent = title;
    content.appendChild(titleElement);
  }
  const messageElement = document.createElement("span");
  messageElement.className = "toast-message";
  messageElement.textContent = message;
  content.appendChild(messageElement);
  toast.appendChild(content);

  if (options.persistent) {
    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss";
    dismiss.type = "button";
    dismiss.dataset.toastDismiss = "true";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "x";
    dismiss.addEventListener("click", () => toast.remove());
    toast.appendChild(dismiss);
  }

  toastRegion.appendChild(toast);
  if (!options.persistent) {
    window.setTimeout(() => {
      toast.remove();
    }, options.durationMs ?? 2600);
  }
}

function showFlowAiToast(options: Omit<ToastOptions, "key" | "persistent">): void {
  showToast({
    ...options,
    key: FLOW_AI_TOAST_KEY,
    persistent: true
  });
}

function dismissToast(key: string): void {
  if (!toastRegion) return;
  toastRegion.querySelectorAll(`[data-toast-key="${cssEscape(key)}"]`).forEach((existingToast) => existingToast.remove());
}

function toastToneClass(tone: ToastTone = "neutral"): string {
  if (tone === "success" || tone === "ok") return " ok";
  if (tone === "warning" || tone === "warn") return " warn";
  return "";
}

function toastRole(tone: ToastTone = "neutral"): string {
  return tone === "warning" || tone === "warn" ? "alert" : "status";
}

function cssEscape(value: string): string {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function formatDateTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatRelativeTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  const time = date.getTime();
  if (Number.isNaN(time)) return "";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

boardCanvas.addEventListener("click", (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  const action = target.closest("[data-action]") as HTMLElement | null;
  if (action) {
    const laneEditor = action.closest(".lane-editor") as HTMLElement | null;
    const laneIndex = laneEditor ? Number(laneEditor.dataset.laneIndex) : -1;
    const templateId = action.dataset.templateId;

    if (action.dataset.action === "toggle-flow-menu") toggleFlowActionsMenu();
    if (action.dataset.action === "create-board") void createNewBoard();
    if (action.dataset.action === "open-project-settings") openProjectSettingsDialog();
    if (action.dataset.action === "open-work-item-dialog") openWorkItemDialog(action.dataset.laneId || null);
    if (action.dataset.action === "open-delete-board") openDeleteBoardDialog();
    if (action.dataset.action === "generate-flow") void generateDraftFromPrompt();
    if (action.dataset.action === "apply-board") void applyBoard();
    if (action.dataset.action === "use-flow-chip") useFlowPromptChip(action.dataset.flowChip);
    if (action.dataset.action === "toggle-flow-advanced") {
      flowAdvancedOpen = !flowAdvancedOpen;
      render();
    }
    if (action.dataset.action === "start-over") startOver();
    if (action.dataset.action === "save-template") saveCurrentFlowAsTemplate();
    if (action.dataset.action === "add-lane") addLane();
    if (action.dataset.action === "add-agent") addAgent();
    if (action.dataset.action === "connect-agent") openAgentConnectDialog(action.dataset.agentId);
    if (action.dataset.action === "remove-agent") {
      const agentEditor = action.closest(".agent-editor") as HTMLElement | null;
      removeAgent(Number(agentEditor?.dataset.agentIndex));
    }
    if (action.dataset.action === "remove-lane" && Number.isInteger(laneIndex)) removeLane(laneIndex);
    if (action.dataset.action === "move-lane-left" && Number.isInteger(laneIndex)) moveLane(laneIndex, -1);
    if (action.dataset.action === "move-lane-right" && Number.isInteger(laneIndex)) moveLane(laneIndex, 1);
    if (action.dataset.action === "add-check" && Number.isInteger(laneIndex)) addCheck(laneIndex);
    if (action.dataset.action === "remove-check" && Number.isInteger(laneIndex)) {
      const checkEditor = action.closest(".check-editor") as HTMLElement | null;
      removeCheck(laneIndex, Number(checkEditor?.dataset.checkIndex));
    }
    if (action.dataset.action === "use-template" && templateId) useTemplate(templateId);
    if (action.dataset.action === "rename-template" && templateId) renameTemplate(templateId);
    if (action.dataset.action === "apply-template-rename" && templateId) applyTemplateRename(action);
    if (action.dataset.action === "cancel-template-rename") cancelTemplateRename();
    if (action.dataset.action === "delete-template" && templateId) deleteTemplate(templateId);
    if (action.dataset.action === "save-template-from-form") saveTemplateFromForm(action);
    if (action.dataset.action === "cancel-template-save") {
      templateFormOpen = false;
      render();
    }
    return;
  }

  if (flowActionsMenuOpen) {
    flowActionsMenuOpen = false;
    render();
    return;
  }

  const card = target.closest("[data-work-item-id]") as HTMLElement | null;
  if (!card) return;
  const board = getActiveBoard();
  board.selectedId = card.dataset.workItemId || null;
  inspectorDrawerOpen = Boolean(board.selectedId);
  saveState();
  render();
});

inspectorPanel.addEventListener("click", (event: MouseEvent) => {
  const action = (event.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (action?.dataset.action === "close-inspector-drawer") closeInspectorDrawer();
});

boardCanvas.addEventListener("input", (event: Event) => {
  const target = event.target as FormControlElement;
  if (target.matches("[data-delete-confirm]")) {
    syncDeleteConfirmState(target);
    return;
  }
  updateDraftField(target);
});

boardCanvas.addEventListener("change", (event: Event) => {
  const target = event.target as FormControlElement;
  if (target.matches("select[data-field]")) {
    updateDraftField(target);
    render();
  }
});

boardCanvas.addEventListener("focusout", (event: FocusEvent) => {
  const target = event.target as FormControlElement;
  if (target.closest?.(".lane-editor, .agent-editor") && target.matches("[data-field], [data-agent-field]")) {
    render();
  }
});

if (editFlowButton) {
  editFlowButton.addEventListener("click", editCurrentFlow);
}

if (boardSettingsButton) {
  boardSettingsButton.addEventListener("click", openBoardSettingsDialog);
}

if (projectSelect) {
  projectSelect.addEventListener("change", (event) => {
    void activateProject((event.target as HTMLSelectElement).value);
  });
}

if (projectSettingsButton) {
  projectSettingsButton.addEventListener("click", openProjectSettingsDialog);
}

if (newProjectButton) {
  newProjectButton.addEventListener("click", openProjectCreateDialog);
}

if (newBoardButton) {
  newBoardButton.addEventListener("click", () => void createNewBoard());
}

if (accountControl) {
  accountControl.addEventListener("click", (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (action?.dataset.action === "open-team-settings") {
      event.preventDefault();
      void openTeamSettingsDialog();
    }
  });
}

if (boardSelect) {
  boardSelect.addEventListener("change", (event) => {
    switchBoard((event.target as HTMLSelectElement).value);
  });
}

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Escape" || !inspectorDrawerOpen) return;
  if (workItemDialogOpen || deleteBoardDialogOpen || agentConnectDialogOpen || teamSettingsDialogOpen || projectDialogOpen || boardSettingsDialogOpen) return;
  closeInspectorDrawer();
});

if (modalRoot) {
  modalRoot.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const action = target.closest("[data-action]") as HTMLElement | null;
    if (!action) return;
    if (action.dataset.action === "close-modal" && target === action) {
      resetWorkItemDialogState();
      deleteBoardDialogOpen = false;
      resetAgentConnectDialog();
      teamSettingsDialogOpen = false;
      teamSettingsSaving = false;
      teamSettingsError = "";
      projectDialogOpen = false;
      projectDialogSaving = false;
      projectDialogError = "";
      boardSettingsDialogOpen = false;
      boardSettingsSaving = false;
      boardSettingsError = "";
      render();
    }
    if (action.dataset.action === "cancel-team-settings") closeTeamSettingsDialog();
    if (action.dataset.action === "copy-team-invite-link") void copyTeamInviteLink();
    if (action.dataset.action === "create-team-invite") {
      event.preventDefault();
      void createTeamInviteFromDialog(action);
    }
    if (action.dataset.action === "save-team-member") {
      event.preventDefault();
      void saveTeamMemberFromDialog(action);
    }
    if (action.dataset.action === "remove-team-member") {
      event.preventDefault();
      void removeTeamMemberFromDialog(action);
    }
    if (action.dataset.action === "revoke-team-invite") {
      event.preventDefault();
      void revokeTeamInviteFromDialog(action);
    }
    if (action.dataset.action === "cancel-project-dialog") closeProjectDialog();
    if (action.dataset.action === "create-project" || action.dataset.action === "save-project-settings") {
      event.preventDefault();
      void saveProjectFromDialog(action);
    }
    if (action.dataset.action === "cancel-board-settings") closeBoardSettingsDialog();
    if (action.dataset.action === "save-board-settings") {
      event.preventDefault();
      void saveBoardSettingsFromDialog(action);
    }
    if (action.dataset.action === "cancel-work-item") closeWorkItemDialog();
    if (action.dataset.action === "create-work-item") {
      event.preventDefault();
      createWorkItemFromForm(action);
    }
    if (action.dataset.action === "cancel-agent-connect") closeAgentConnectDialog();
    if (action.dataset.action === "create-agent-session") createAgentTokenFromForm(action);
    if (action.dataset.action === "update-agent-session") void updateAgentSession(action);
    if (action.dataset.action === "revoke-agent-session") void revokeAgentSession(action.dataset.sessionId);
    if (action.dataset.action === "cancel-delete-board") closeDeleteBoardDialog();
    if (action.dataset.action === "confirm-delete-board") deleteCurrentBoardFromDialog(action);
  });

  modalRoot.addEventListener("submit", (event: SubmitEvent) => {
    const form = event.target as HTMLElement;
    if (!form.matches("[data-work-item-form], [data-project-form], [data-board-settings-form], [data-team-invite-form], [data-agent-session-form]")) return;
    event.preventDefault();
    if (form.matches("[data-agent-session-form]")) {
      const action = form.querySelector('[data-action="create-agent-session"]') as HTMLElement | null;
      if (action) void createAgentTokenFromForm(action);
      return;
    }
    if (form.matches("[data-team-invite-form]")) {
      const action = form.querySelector('[data-action="create-team-invite"]') as HTMLElement | null;
      if (action) void createTeamInviteFromDialog(action);
      return;
    }
    if (form.matches("[data-project-form]")) {
      const action = form.querySelector('[data-action="create-project"], [data-action="save-project-settings"]') as HTMLElement | null;
      if (action) void saveProjectFromDialog(action);
      return;
    }
    if (form.matches("[data-board-settings-form]")) {
      const action = form.querySelector('[data-action="save-board-settings"]') as HTMLElement | null;
      if (action) void saveBoardSettingsFromDialog(action);
      return;
    }
    const action = form.querySelector('[data-action="create-work-item"]') as HTMLElement | null;
    if (action) createWorkItemFromForm(action);
  });

  modalRoot.addEventListener("input", (event: Event) => {
    const target = event.target as FormControlElement;
    if (target.matches("[data-delete-confirm]")) syncDeleteConfirmState(target);
  });

  modalRoot.addEventListener("change", (event: Event) => {
    const target = event.target as FormControlElement;
    if (target.matches("[data-work-item-field]")) syncWorkItemAgentDefaults(target);
  });

  modalRoot.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!workItemDialogOpen && !deleteBoardDialogOpen && !agentConnectDialogOpen && !teamSettingsDialogOpen && !projectDialogOpen && !boardSettingsDialogOpen) return;
    resetWorkItemDialogState();
    deleteBoardDialogOpen = false;
    resetAgentConnectDialog();
    teamSettingsDialogOpen = false;
    teamSettingsSaving = false;
    teamSettingsError = "";
    projectDialogOpen = false;
    projectDialogSaving = false;
    projectDialogError = "";
    boardSettingsDialogOpen = false;
    boardSettingsSaving = false;
    boardSettingsError = "";
    render();
  });
}

async function initialize() {
  const [loadedState] = await Promise.all([loadState(), loadAuthSession()]);
  state = loadedState;
  render();
  startPolling();
  startLiveUpdates();
}

initialize();
