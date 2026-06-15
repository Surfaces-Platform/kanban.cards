import type { AgentSpec, Board, BoardDraft, BoardTemplate, Lane, Project, PublicTeamInvite, PublicTeamMember, PublicTokenRecord, Team, TeamRole, WorkItem, WorkItemComment, WorkspaceState } from "../types";

declare global {
  interface Window {
    KANBAN_CARDS_API_BASE_URL?: string;
    INSTRUCT_API_BASE_URL?: string;
    KANBAN_CARDS_API_TOKEN?: string;
    INSTRUCT_API_TOKEN?: string;
  }
}

type AnyRecord = Record<string, any>;
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

  return { team, projects, activeProjectId, members: [], invites: [], boards, activeBoardId, templates };
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

  const lanes = Array.isArray(rawBoard.lanes)
    ? withUniqueLaneIds(rawBoard.lanes.map(normalizeLane).filter(isNonNull))
    : [];
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawBoard.agentSpecs)
    ? withUniqueAgentIds(rawBoard.agentSpecs.map((agent: any) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  const normalizedLanes = lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds));

  const workItems: WorkItem[] = Array.isArray(rawBoard.workItems) ? rawBoard.workItems : [];
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

  const lanes = Array.isArray(rawTemplate.lanes)
    ? withUniqueLaneIds(rawTemplate.lanes.map(normalizeLane).filter(isNonNull))
    : [];
  const name = String(rawTemplate.name || "").trim();
  if (!name || !lanes.length) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawTemplate.agentSpecs)
    ? withUniqueAgentIds(rawTemplate.agentSpecs.map((agent: any) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));

  return {
    id: String(rawTemplate.id || makeId("template")),
    name,
    description: String(rawTemplate.description || "").trim(),
    builtIn: false,
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds)),
    agentSpecs,
    createdAt: rawTemplate.createdAt || new Date().toISOString()
  };
}

function normalizeDraft(draft: any): BoardDraft | null {
  if (!draft || !Array.isArray(draft.lanes)) return null;
  const lanes = withUniqueLaneIds(draft.lanes.map(normalizeLane).filter(isNonNull));
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(draft.agentSpecs)
    ? withUniqueAgentIds(draft.agentSpecs.map((agent: any) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  return {
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds)),
    agentSpecs
  };
}

function normalizeLane(lane: any): Lane | null {
  if (!lane || typeof lane !== "object") return null;

  const title = String(lane.title || "").trim();
  if (!title) return null;

  const description = String(lane.description || "").trim();
  const id = String(lane.id || slugify(title)).trim() || slugify(title);
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

function normalizeAgentSpec(rawAgent: any, laneIds: Set<string> = new Set()): AgentSpec | null {
  if (!rawAgent || typeof rawAgent !== "object") return null;
  const name = String(rawAgent.name || "").trim();
  const id = String(rawAgent.id || slugify(name)).trim() || slugify(name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: String(rawAgent.role || "").trim(),
    laneIds: Array.isArray(rawAgent.laneIds)
      ? rawAgent.laneIds.map((laneId: any) => String(laneId || "").trim()).filter((laneId: string) => laneIds.has(laneId))
      : [],
    instructions: String(rawAgent.instructions || "").trim(),
    skillNotes: String(rawAgent.skillNotes || "").trim()
  };
}

function normalizeLaneAgentDefaults(lane: Lane, agentIds: Set<string> = new Set()): Lane {
  return {
    ...lane,
    defaultOwnerAgentId: lane.defaultOwnerAgentId && agentIds.has(lane.defaultOwnerAgentId) ? lane.defaultOwnerAgentId : null,
    defaultReviewerAgentId: lane.defaultReviewerAgentId && agentIds.has(lane.defaultReviewerAgentId) ? lane.defaultReviewerAgentId : null
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

function touchBoard(board: Board): void {
  board.updatedAt = new Date().toISOString();
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
  return `
    <section class="flow-panel flow-panel-wide setup-panel" aria-labelledby="flow-setup-title">
      <div class="flow-panel-heading">
        <p class="eyebrow">Board setup</p>
        <h2 id="flow-setup-title">Choose a template or describe the flow</h2>
      </div>
      ${renderTextField({ label: "Board name", id: "board-name", value: board.name, className: "board-name-field" })}
      ${renderTemplateGallery()}
      <div class="custom-flow-section">
        <div class="section-heading">
          <h3>Custom flow</h3>
        </div>
        ${renderTextAreaField({ label: "Kanban flow description", id: "flow-prompt", value: board.flowPrompt, rows: 4, placeholder: "Intake, Research, Draft, Review, Release", className: "flow-prompt-field", srOnly: true })}
        <div class="flow-actions">
          <button class="primary-button" type="button" data-action="generate-flow">Generate flow</button>
        </div>
        ${renderFlowMessage()}
      </div>
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
          <h2 id="flow-editor-title">Edit flow</h2>
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
      ${renderTextField({ label: "Board name", id: "board-name", value: board.name, className: "board-name-field" })}
      ${renderTextAreaField({ label: "Description", id: "flow-prompt", value: board.flowPrompt, rows: 3, placeholder: "Intake, Research, Draft, Review, Release", className: "flow-prompt-field" })}
      <div class="flow-actions">
        <button class="secondary-button" type="button" data-action="generate-flow">Regenerate</button>
        <button class="secondary-button" type="button" data-action="add-lane">Add lane</button>
      </div>
      ${renderFlowMessage()}
      ${renderAgentSetup(draft)}
      <div class="lane-editor-list">
        ${draft.lanes.map((lane, laneIndex) => renderLaneEditor(lane, laneIndex, draft)).join("")}
      </div>
      <div class="flow-actions final-actions">
        <div class="final-action-group">
          <button class="primary-button" type="button" data-action="apply-board">Apply board</button>
          <button class="secondary-button" type="button" data-action="start-over">${board.lanes.length ? "Cancel edits" : "Start over"}</button>
        </div>
        ${board.lanes.length ? `
          <div class="final-action-group final-action-group-right">
            <button class="secondary-button" type="button" data-action="save-template">Save as template</button>
          </div>
        ` : ""}
      </div>
      ${templateFormOpen ? renderSaveTemplatePanel(board) : ""}
    </section>
  `;
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
      <div class="card-agent-grid">
        <div>
          <span class="meta-label">Owner</span>
          <strong>${escapeHtml(resolveAgentShortName(board, item.ownerAgentId))}</strong>
        </div>
        <div>
          <span class="meta-label">Reviewer</span>
          <strong>${escapeHtml(resolveAgentShortName(board, item.reviewerAgentId))}</strong>
        </div>
      </div>
      <div class="card-state-footer">
        ${openRequestText ? `<span class="card-request-count">${escapeHtml(openRequestText)}</span>` : ""}
        <p>${escapeHtml(formatCardLatestActivity(current.latestComment))}</p>
      </div>
    </article>
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
      <strong>Selected card</strong>
    </div>
    <section class="work-item-detail">
      <div class="detail-header">
        <p class="eyebrow">Card detail</p>
        <h2>${escapeHtml(selected.title || "Untitled card")}</h2>
        <p>${escapeHtml(selected.summary || "No summary provided.")}</p>
      </div>
      ${renderCurrentStatePanel(selected, board)}
      <div class="comment-thread">
        <div class="section-heading">
          <h3>Activity</h3>
        </div>
        ${renderCommentThread(selected)}
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
  void loadInspectorActivity(board.id, item.id);
}

function resetInspectorActivity(): void {
  inspectorActivityBoardId = null;
  inspectorActivityCardId = null;
  inspectorActivityEvents = [];
  inspectorActivityLoading = false;
  inspectorActivityUnavailable = false;
  inspectorActivityError = "";
}

async function loadInspectorActivity(boardId: string, cardId: string): Promise<void> {
  const params = new URLSearchParams({ cardId, limit: "20" });
  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(boardId)}/events?${params.toString()}`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (response.status === 404 || response.status === 405) {
      inspectorActivityUnavailable = true;
      inspectorActivityEvents = [];
      return;
    }
    if (!response.ok) throw new Error(`Event request failed with ${response.status}`);
    const payload = await response.json();
    const rawEvents = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [];
    inspectorActivityEvents = rawEvents.map(normalizeInspectorActivityEvent).filter(isNonNull);
    inspectorActivityUnavailable = false;
    inspectorActivityError = "";
  } catch (_error) {
    inspectorActivityEvents = [];
    inspectorActivityUnavailable = true;
    inspectorActivityError = "Provenance is not available for this board.";
  } finally {
    if (inspectorActivityBoardId === boardId && inspectorActivityCardId === cardId) {
      inspectorActivityLoading = false;
      renderInspector(getActiveBoardOrNull());
    }
  }
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
        ${renderStateGridItem("Owner", resolveAgentDisplayName(board, item.ownerAgentId))}
        ${renderStateGridItem("Reviewer", resolveAgentDisplayName(board, item.reviewerAgentId))}
        ${renderStateGridItem("Open requests", String(current.openRequests.length))}
        ${renderStateGridItem("Change requests", String(current.openChangeRequests.length))}
        ${renderStateGridItem("Blockers", String(current.openBlockers.length))}
        ${renderStateGridItem("Approvals", String(current.approvals))}
        ${renderStateGridItem("Delivery", current.delivered ? "Delivered" : "Active")}
      </div>
      <div class="current-state-rows">
        <div class="current-state-row">
          <span class="meta-label">Latest</span>
          <p>${escapeHtml(formatLatestActivitySentence(current.latestComment))}</p>
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
  const actor = formatActivityActor(event);
  const sessionId = activityValue(event.delegation, "sessionId") || activityValue(event.payload, "sessionId");
  const projectId = activityValue(event.payload, "projectId") ||
    activityValue(event.actor, "projectId") ||
    activityValue(event.delegation, "projectId");
  const capabilities = formatActivityCapabilities(event.delegation?.capabilities || event.payload.capabilities);
  const reason = activityValue(event.delegation, "reason") || activityValue(event.payload, "reason");
  const delegatedBy = activityValue(event.delegation, "delegatedBy") || activityValue(event.payload, "delegatedBy");

  return `
    <article class="activity-event">
      <div class="activity-event-header">
        <strong>${escapeHtml(formatActivityTitle(event))}</strong>
        ${event.createdAt ? `<time datetime="${escapeAttribute(event.createdAt)}">${escapeHtml(formatDateTime(event.createdAt) || formatRelativeTime(event.createdAt))}</time>` : ""}
      </div>
      <dl class="metadata-grid compact">
        ${renderMetadataItem("Actor", actor)}
        ${renderMetadataItem("Session", sessionId || "n/a")}
        ${renderMetadataItem("Project", projectId || "n/a")}
        ${renderMetadataItem("Delegated by", delegatedBy || "n/a")}
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

function formatActivityActor(event: InspectorActivityEvent): string {
  const actor = event.actor;
  if (!actor) return "unknown";
  return activityValue(actor, "email") ||
    activityValue(actor, "name") ||
    activityValue(actor, "userId") ||
    activityValue(actor, "agentId") ||
    activityValue(actor, "type") ||
    "unknown";
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

function renderCommentThread(item: WorkItem): string {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  if (!comments.length) return '<p class="empty-note">No activity yet</p>';

  return comments.map((comment) => `
    <article class="comment-card ${escapeAttribute(comment.kind || "note")}">
      <div class="comment-card-header">
        <span class="comment-kind">${escapeHtml(comment.kind || "note")}</span>
        <span class="comment-status">${escapeHtml(comment.status || "open")}</span>
      </div>
      <p>${escapeHtml(comment.text || "")}</p>
      <div class="comment-meta">
        <span>${escapeHtml(comment.author || "agent")}</span>
        <time datetime="${escapeAttribute(comment.createdAt || "")}">${escapeHtml(formatDateTime(comment.createdAt))}</time>
      </div>
    </article>
  `).join("");
}

function resolveAgentDisplayName(board: Board, agentId: string | null | undefined): string {
  if (!agentId) return "Unassigned";
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentId);
  if (!agent) return agentId;
  return agent.role ? `${agent.name} (${agent.role})` : agent.name;
}

function resolveAgentShortName(board: Board, agentId: string | null | undefined): string {
  if (!agentId) return "Unassigned";
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentId);
  return agent?.name || agentId;
}

function formatCardLatestActivity(comment: WorkItemComment | null): string {
  if (!comment) return "Latest: no activity yet";
  const pieces = [
    comment.author || "agent",
    formatCommentKind(comment.kind),
    formatRelativeTime(comment.updatedAt || comment.createdAt)
  ].filter(Boolean);
  return `Latest: ${pieces.join(" / ")}`;
}

function formatLatestActivitySentence(comment: WorkItemComment | null): string {
  if (!comment) return "No activity yet.";
  const age = formatRelativeTime(comment.updatedAt || comment.createdAt);
  const suffix = age ? ` ${age}` : "";
  return `${comment.author || "agent"} posted ${formatCommentKind(comment.kind)}${suffix}.`;
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
        <strong>${escapeHtml(member.name || member.email)}</strong>
        <span>${escapeHtml(member.email)}</span>
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
  return `
    <li class="team-row" data-team-invite-id="${escapeAttribute(invite.id)}">
      <div class="team-row-main">
        <strong>${escapeHtml(invite.email)}</strong>
        <span>${escapeHtml(invite.role)}</span>
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
      <li class="token-row">
        <div class="token-row-main">
          <div class="token-row-heading">
            <strong>${escapeHtml(tokenRecord.label || "Local agent")}</strong>
            <span>ending ${escapeHtml(tokenRecord.last4)}</span>
            <time datetime="${escapeAttribute(tokenRecord.createdAt || "")}">${escapeHtml(formatDateTime(tokenRecord.createdAt))}</time>
          </div>
          ${renderAgentTokenMetadata(tokenRecord)}
        </div>
        <button class="secondary-button small danger-button" type="button" data-action="revoke-agent-token" data-token-id="${escapeAttribute(tokenRecord.id)}">Revoke</button>
      </li>
    `).join("")
    : '<li class="empty-note">No active tokens</li>';

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
        <p class="modal-copy" id="connect-agent-description">${escapeHtml(agent.id)} receives board-scoped API access for assigned cards.</p>
        ${agentConnectError ? `<p class="flow-message warning">${escapeHtml(agentConnectError)}</p>` : ""}
        <form class="modal-form" data-agent-token-form>
          ${renderTextField({ label: "Token label", value: `${agent.name} local access`, attributes: { "data-agent-token-label": true } })}
          <div class="modal-actions">
            <button class="primary-button" type="button" data-action="create-agent-token" ${agentConnectLoading ? "disabled" : ""}>Create token</button>
          </div>
        </form>
        ${command ? `
          <div class="setup-command">
            <span class="meta-label">Setup command</span>
            ${renderTextArea({ value: command, rows: 4, attributes: { readonly: true, "data-agent-setup-command": true }, ariaLabel: "Agent setup command" })}
          </div>
          <div class="new-token-metadata">
            <div class="section-heading">
              <h3>New token session</h3>
            </div>
            ${renderAgentTokenMetadata(agentConnectToken)}
          </div>
        ` : ""}
        <div class="token-list-block">
          <div class="section-heading">
            <h3>Active tokens</h3>
          </div>
          <ul class="token-list">
            ${tokenRows}
          </ul>
        </div>
      </section>
    </div>
  `;
}

function renderAgentTokenMetadata(tokenRecord: PublicTokenRecord | CreatedAgentTokenPayload | null): string {
  if (!tokenRecord) return "";
  return `
    <dl class="metadata-grid token-metadata">
      ${renderMetadataItem("Session", tokenRecord.sessionId || "n/a")}
      ${renderMetadataItem("Project", tokenRecord.projectId || "n/a")}
      ${renderMetadataItem("Delegated by", tokenRecord.delegatedBy || "n/a")}
      ${renderMetadataItem("Capabilities", formatMetadataValue(tokenRecord.capabilities) || "n/a")}
      ${renderMetadataItem("Expires", tokenRecord.expiresAt ? formatDateTime(tokenRecord.expiresAt) : "Never")}
      ${renderMetadataItem("Reason", tokenRecord.reason || "n/a")}
      ${renderMetadataItem("Last used", tokenRecord.lastUsedAt ? formatDateTime(tokenRecord.lastUsedAt) : "Never")}
    </dl>
  `;
}

function renderCreateWorkItemDialog(board: Board): string {
  const firstLane = board.lanes[0] || ({} as Partial<Lane>);
  const selectedLane = board.lanes.find((lane) => lane.id === workItemDialogLaneId) || firstLane;
  const selectedLaneId = selectedLane.id || "";
  const agentOptions = renderAgentOptions(board.agentSpecs || []);
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
  flowMessage = "";
  flowMessageTone = "neutral";
  templateFormOpen = false;
  editingTemplateId = null;
  resetWorkItemDialogState();
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  boardSettingsDialogOpen = false;
  resetAgentConnectDialog();
  resetInspectorActivity();
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
  board.lanes = withUniqueLaneIds(clone(template.lanes));
  board.agentSpecs = clone(template.agentSpecs || []);
  board.workItems = [];
  board.selectedId = null;
  board.flowPrompt = template.lanes.map((lane) => lane.title).join(", ");
  board.configDraft = null;
  board.isEditingFlow = false;
  touchBoard(board);
  flowMessage = "";
  flowMessageTone = "neutral";
  templateFormOpen = false;
  editingTemplateId = null;
  resetWorkItemDialogState();
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
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
  agentConnectDialogOpen = true;
  agentConnectAgentId = agent.id;
  agentConnectTokens = [];
  agentConnectToken = null;
  agentConnectLoading = true;
  agentConnectError = "";
  render();
  await refreshAgentTokens(board.id);
  (modalRoot?.querySelector("[data-agent-token-label]") as HTMLElement | null)?.focus();
}

function resetAgentConnectDialog(): void {
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

async function refreshAgentTokens(boardId: string = getActiveBoard().id): Promise<void> {
  if (!agentConnectDialogOpen) return;
  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(boardId)}/agent-tokens`, {
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`Token list failed with ${response.status}`);
    const payload = await response.json();
    agentConnectTokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    agentConnectError = "";
  } catch (error) {
    agentConnectError = "Could not load active tokens.";
  } finally {
    agentConnectLoading = false;
    render();
  }
}

async function createAgentTokenFromForm(action: HTMLElement): Promise<void> {
  const board = getActiveBoard();
  const agent = board.agentSpecs?.find((candidate) => candidate.id === agentConnectAgentId);
  if (!agent || agentConnectLoading) return;

  const form = action.closest("[data-agent-token-form]");
  const label = (form?.querySelector("[data-agent-token-label]") as FormControlElement | null)?.value.trim() || `${agent.name} local access`;
  agentConnectLoading = true;
  agentConnectError = "";
  render();

  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/agent-tokens`, {
      method: "POST",
      headers: apiHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ agentId: agent.id, label })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Token creation failed with ${response.status}`);
    agentConnectToken = normalizeCreatedAgentTokenPayload(payload);
    await refreshAgentTokens(board.id);
    showToast("Agent token created.");
  } catch (error) {
    agentConnectError = error instanceof Error ? error.message : "Could not create token.";
    agentConnectLoading = false;
    render();
  }
}

function normalizeCreatedAgentTokenPayload(payload: any): CreatedAgentTokenPayload {
  if (payload?.tokenRecord && typeof payload.tokenRecord === "object") {
    return {
      ...payload.tokenRecord,
      token: payload.token
    } as CreatedAgentTokenPayload;
  }
  return payload as CreatedAgentTokenPayload;
}

async function revokeAgentToken(tokenId: string | undefined): Promise<void> {
  const board = getActiveBoard();
  if (!tokenId || agentConnectLoading) return;
  agentConnectLoading = true;
  agentConnectError = "";
  render();

  try {
    const response = await fetch(`${API_BASE_URL}/boards/${encodeURIComponent(board.id)}/agent-tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE",
      headers: apiHeaders(false),
      credentials: "same-origin"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Token revoke failed with ${response.status}`);
    if (agentConnectToken?.id === tokenId) agentConnectToken = null;
    await refreshAgentTokens(board.id);
    showToast("Agent token revoked.");
  } catch (error) {
    agentConnectError = error instanceof Error ? error.message : "Could not revoke token.";
    agentConnectLoading = false;
    render();
  }
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
  const item = {
    id: makeId("item"),
    title,
    summary: (form?.querySelector('[data-work-item-field="summary"]') as FormControlElement | null)?.value.trim() || "",
    laneId,
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

function generateDraftFromPrompt(): void {
  const board = getActiveBoard();
  const stages = parseFlowPrompt(board.flowPrompt);

  if (stages.length < MIN_LANES) {
    board.configDraft = null;
    board.isEditingFlow = false;
    flowMessage = "Use at least two comma-separated stages.";
    flowMessageTone = "warning";
    saveState();
    render();
    return;
  }

  const cappedStages = stages.slice(0, MAX_LANES);
  board.configDraft = {
    lanes: cappedStages.map((stage, index) => {
      const nextStage = cappedStages[index + 1] || "";
      return makeLane(stage, defaultLaneDescription(stage, nextStage), nextStage);
    }),
    agentSpecs: clone(board.agentSpecs || [])
  };
  board.isEditingFlow = true;
  flowMessage = stages.length > MAX_LANES
    ? `Using the first ${MAX_LANES} stages.`
    : "Draft flow generated.";
  flowMessageTone = stages.length > MAX_LANES ? "warning" : "success";
  touchBoard(board);
  saveState();
  render();
}

function applyBoard(): void {
  const board = getActiveBoard();
  const draft = normalizeDraft(board.configDraft);

  if (!draft || draft.lanes.length < MIN_LANES) {
    flowMessage = "Keep at least two lanes before applying the board.";
    flowMessageTone = "warning";
    render();
    return;
  }

  board.lanes = withUniqueLaneIds(draft.lanes);
  board.agentSpecs = draft.agentSpecs || [];
  board.workItems = [];
  board.selectedId = null;
  board.configDraft = null;
  board.isEditingFlow = false;
  templateFormOpen = false;
  touchBoard(board);
  flowMessage = "";
  flowMessageTone = "neutral";
  saveState();
  render();
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
  flowMessage = "";
  flowMessageTone = "neutral";
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

  deleteBoardDialogOpen = false;
  flowActionsMenuOpen = false;
  resetAgentConnectDialog();
  resetInspectorActivity();
  templateFormOpen = false;
  editingTemplateId = null;
  flowMessage = "";
  flowMessageTone = "neutral";
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

  flowMessage = "";
  flowMessageTone = "neutral";
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
    flowMessage = `Use ${MAX_LANES} lanes or fewer.`;
    flowMessageTone = "warning";
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
    const baseId = slugify(lane.title) || "lane";
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

function showToast(message: string): void {
  if (!toastRegion) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastRegion.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 2600);
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
    if (action.dataset.action === "generate-flow") generateDraftFromPrompt();
    if (action.dataset.action === "apply-board") applyBoard();
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
  saveState();
  render();
});

boardCanvas.addEventListener("input", (event: Event) => {
  const target = event.target as FormControlElement;
  if (target.matches("[data-delete-confirm]")) {
    syncDeleteConfirmState(target);
    return;
  }
  updateDraftField(target);
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
    if (action.dataset.action === "create-agent-token") createAgentTokenFromForm(action);
    if (action.dataset.action === "revoke-agent-token") revokeAgentToken(action.dataset.tokenId);
    if (action.dataset.action === "cancel-delete-board") closeDeleteBoardDialog();
    if (action.dataset.action === "confirm-delete-board") deleteCurrentBoardFromDialog(action);
  });

  modalRoot.addEventListener("submit", (event: SubmitEvent) => {
    const form = event.target as HTMLElement;
    if (!form.matches("[data-work-item-form], [data-project-form], [data-board-settings-form], [data-team-invite-form]")) return;
    event.preventDefault();
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
