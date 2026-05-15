import type { AgentSpec, Board, BoardDraft, BoardTemplate, Lane, PublicTokenRecord, WorkItem, WorkspaceState } from "../types";

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

interface LiveWorkspaceEvent {
  id: string;
  type: "workspace_changed";
  boardId: string | null;
  payload: AnyRecord;
  createdAt: string;
}

const API_BASE_URL = window.KANBAN_CARDS_API_BASE_URL || window.INSTRUCT_API_BASE_URL || "/api";
const API_TOKEN = window.KANBAN_CARDS_API_TOKEN || window.INSTRUCT_API_TOKEN || "";
const POLL_INTERVAL_MS = 5000;
const MAX_LANES = 8;
const MIN_LANES = 2;

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
let flowActionsMenuOpen = false;
let deleteBoardDialogOpen = false;
let agentConnectDialogOpen = false;
let agentConnectAgentId: string | null = null;
let agentConnectTokens: PublicTokenRecord[] = [];
let agentConnectToken: CreatedAgentTokenPayload | null = null;
let agentConnectLoading = false;
let agentConnectError = "";
let apiOnline = false;
let saveQueue: Promise<unknown> = Promise.resolve();
let lastPersistedState = "";
let apiWarningShown = false;
let eventSource: EventSource | null = null;
let pendingRemoteRefresh = false;
let pendingRemoteRefreshToastShown = false;
let remoteRefreshInFlight = false;

const boardCanvas = document.querySelector("#board-canvas") as HTMLElement;
const inspectorPanel = document.querySelector("#inspector-panel") as HTMLElement;
const newWorkItemButton = document.querySelector("#new-work-item") as HTMLButtonElement | null;
const editFlowButton = document.querySelector("#edit-flow") as HTMLButtonElement | null;
const boardSelect = document.querySelector("#board-select") as HTMLSelectElement | null;
const newBoardButton = document.querySelector("#new-board") as HTMLButtonElement | null;
const boardTitle = document.querySelector("#board-title") as HTMLElement | null;
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
      headers: apiHeaders(false)
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

function freshWorkspaceState(): WorkspaceState {
  const board = createBoard("Untitled board");
  return {
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
  const board = normalizeBoard({
    id: makeId("board"),
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
  });
  if (!board) throw new Error("Unable to create board.");
  return board;
}

function normalizeWorkspace(rawState: any): WorkspaceState {
  const boards: Board[] = Array.isArray(rawState?.boards)
    ? rawState.boards.map(normalizeBoard).filter(isNonNull)
    : [];

  if (!boards.length) boards.push(createBoard("Untitled board"));

  const activeBoardId = boards.some((board) => board.id === rawState?.activeBoardId)
    ? rawState.activeBoardId
    : boards[0].id;

  const templates: BoardTemplate[] = Array.isArray(rawState?.templates)
    ? rawState.templates.map(normalizeTemplate).filter(isNonNull)
    : [];

  return { boards, activeBoardId, templates };
}

function normalizeBoard(rawBoard: any): Board | null {
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

  return {
    id: String(rawBoard.id || makeId("board")),
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
  if (includeContentType) headers["Content-Type"] = "application/json";
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  return headers;
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
      headers: apiHeaders(false)
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
  const board = getActiveBoard();
  return Boolean(board.isEditingFlow || board.configDraft || templateFormOpen || editingTemplateId || workItemDialogOpen || deleteBoardDialogOpen || agentConnectDialogOpen);
}

function showApiWarning(message: string): void {
  if (apiWarningShown) return;
  apiWarningShown = true;
  showToast(message);
}

function getActiveBoard(): Board {
  let board = state.boards.find((candidate) => candidate.id === state.activeBoardId);
  if (board) return board;

  if (!state.boards.length) {
    board = createBoard("Untitled board");
    state.boards.push(board);
  }

  state.activeBoardId = state.boards[0].id;
  return state.boards[0];
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
  const board = getActiveBoard();
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

function render(): void {
  state = normalizeWorkspace(state);
  const board = getActiveBoard();

  renderTopbar(board);
  renderMetrics(board);
  renderBoard(board);
  renderInspector();
  renderModals(board);
  if (pendingRemoteRefresh && !hasLocalEditingState()) window.setTimeout(() => void applyPendingRemoteRefresh(), 0);
}

function renderTopbar(board: Board): void {
  if (boardSelect) {
    boardSelect.innerHTML = state.boards.map((candidate) => `
      <option value="${escapeAttribute(candidate.id)}">${escapeHtml(candidate.name)}</option>
    `).join("");
    boardSelect.value = board.id;
  }

  if (boardTitle) boardTitle.textContent = board.name;

  const configured = Boolean(board.lanes.length && !board.isEditingFlow && !board.configDraft);
  if (editFlowButton) editFlowButton.hidden = !configured;
  if (newWorkItemButton) {
    newWorkItemButton.disabled = !configured;
    newWorkItemButton.title = configured
      ? "Create a card on this board."
      : board.lanes.length
        ? "Apply or cancel flow edits before adding cards."
        : "Configure lanes before adding cards.";
  }
}

function renderMetrics(board: Board): void {
  const active = board.workItems.filter((item) => !isDelivered(item)).length;
  const blocked = board.workItems.filter((item) => getOpenBlockers(item).length > 0).length;
  const approvals = board.workItems.reduce((total, item) => total + getApprovalCount(item), 0);
  const delivered = board.workItems.filter(isDelivered).length;

  document.querySelector("#metric-active")!.textContent = String(active);
  document.querySelector("#metric-blocked")!.textContent = String(blocked);
  document.querySelector("#metric-approvals")!.textContent = String(approvals);
  document.querySelector("#metric-delivered")!.textContent = String(delivered);
}

function renderBoard(board: Board): void {
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
          ${laneItems.length ? laneItems.map((item) => renderWorkItemCard(item, board)).join("") : '<p class="empty-lane">No cards</p>'}
        </div>
      </section>
    `;
  }).join("");
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
  return `
    <article class="work-item-card${selectedClass}" tabindex="0" role="button" data-work-item-id="${escapeAttribute(item.id)}">
      <h3 class="card-title">${escapeHtml(item.title || "Untitled card")}</h3>
      <p class="card-summary">${escapeHtml(item.summary || "No summary provided.")}</p>
    </article>
  `;
}

function renderInspector(): void {
  const selected = getSelectedWorkItem();
  const board = getActiveBoard();

  if (!selected) {
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
      <div class="detail-meta-grid">
        <div>
          <span class="meta-label">Owner</span>
          <strong>${escapeHtml(resolveAgentDisplayName(board, selected.ownerAgentId))}</strong>
        </div>
        <div>
          <span class="meta-label">Reviewer</span>
          <strong>${escapeHtml(resolveAgentDisplayName(board, selected.reviewerAgentId))}</strong>
        </div>
        <div>
          <span class="meta-label">Status</span>
          <strong>${escapeHtml(isDelivered(selected) ? "Delivered" : "Active")}</strong>
        </div>
      </div>
      <div class="comment-thread">
        <div class="section-heading">
          <h3>Activity</h3>
        </div>
        ${renderCommentThread(selected)}
      </div>
    </section>
  `;
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

function renderModals(board: Board): void {
  if (!modalRoot) return;
  if (workItemDialogOpen) {
    modalRoot.innerHTML = renderCreateWorkItemDialog(board);
  } else if (agentConnectDialogOpen) {
    modalRoot.innerHTML = renderConnectAgentDialog(board);
  } else if (deleteBoardDialogOpen) {
    modalRoot.innerHTML = renderDeleteBoardDialog(board);
  } else {
    modalRoot.innerHTML = "";
  }
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
        <div>
          <strong>${escapeHtml(tokenRecord.label || "Local agent")}</strong>
          <span>ending ${escapeHtml(tokenRecord.last4)}</span>
          <time datetime="${escapeAttribute(tokenRecord.createdAt || "")}">${escapeHtml(formatDateTime(tokenRecord.createdAt))}</time>
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

function renderCreateWorkItemDialog(board: Board): string {
  const firstLane = board.lanes[0] || ({} as Partial<Lane>);
  const agentOptions = renderAgentOptions(board.agentSpecs || []);
  const laneOptions = board.lanes.map((lane) => `
    <option value="${escapeAttribute(lane.id)}">${escapeHtml(lane.title)}</option>
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
            ${renderSelectField({ label: "Owner agent", optionsHtml: agentOptions(firstLane.defaultOwnerAgentId), attributes: { "data-work-item-field": "ownerAgentId" } })}
            ${renderSelectField({ label: "Reviewer agent", optionsHtml: agentOptions(firstLane.defaultReviewerAgentId), attributes: { "data-work-item-field": "reviewerAgentId" } })}
          `)}
          <div class="modal-actions">
            <button class="primary-button" type="button" data-action="create-work-item">Create card</button>
            <button class="secondary-button" type="button" data-action="cancel-work-item">Cancel</button>
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

function createNewBoard(): void {
  const board = createBoard(uniqueBoardName("Untitled board"));
  state.boards.push(board);
  state.activeBoardId = board.id;
  flowMessage = "";
  flowMessageTone = "neutral";
  templateFormOpen = false;
  editingTemplateId = null;
  workItemDialogOpen = false;
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  saveState();
  render();
}

function switchBoard(boardId: string): void {
  if (!state.boards.some((board) => board.id === boardId)) return;
  state.activeBoardId = boardId;
  flowMessage = "";
  flowMessageTone = "neutral";
  templateFormOpen = false;
  editingTemplateId = null;
  workItemDialogOpen = false;
  flowActionsMenuOpen = false;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
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
  workItemDialogOpen = false;
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

function openWorkItemDialog(): void {
  const board = getActiveBoard();
  if (!canCreateWorkItems(board)) {
    showToast(board.lanes.length ? "Apply or cancel flow edits before adding cards." : "Configure lanes before adding cards.");
    return;
  }

  workItemDialogOpen = true;
  deleteBoardDialogOpen = false;
  resetAgentConnectDialog();
  flowActionsMenuOpen = false;
  render();
  (modalRoot?.querySelector('[data-work-item-field="title"]') as HTMLElement | null)?.focus();
}

function closeWorkItemDialog(): void {
  workItemDialogOpen = false;
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

  workItemDialogOpen = false;
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
    agentConnectToken = payload;
    await refreshAgentTokens(board.id);
    showToast("Agent token created.");
  } catch (error) {
    agentConnectError = error instanceof Error ? error.message : "Could not create token.";
    agentConnectLoading = false;
    render();
  }
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
  workItemDialogOpen = false;
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
  workItemDialogOpen = false;
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
  state.boards.splice(boardIndex, 1);
  if (!state.boards.length) {
    const replacement = createBoard("Untitled board");
    state.boards.push(replacement);
    state.activeBoardId = replacement.id;
  } else {
    const nextIndex = Math.min(boardIndex, state.boards.length - 1);
    state.activeBoardId = state.boards[nextIndex].id;
  }

  deleteBoardDialogOpen = false;
  flowActionsMenuOpen = false;
  resetAgentConnectDialog();
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

if (newBoardButton) {
  newBoardButton.addEventListener("click", createNewBoard);
}

if (newWorkItemButton) {
  newWorkItemButton.addEventListener("click", openWorkItemDialog);
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
      workItemDialogOpen = false;
      deleteBoardDialogOpen = false;
      resetAgentConnectDialog();
      render();
    }
    if (action.dataset.action === "cancel-work-item") closeWorkItemDialog();
    if (action.dataset.action === "create-work-item") createWorkItemFromForm(action);
    if (action.dataset.action === "cancel-agent-connect") closeAgentConnectDialog();
    if (action.dataset.action === "create-agent-token") createAgentTokenFromForm(action);
    if (action.dataset.action === "revoke-agent-token") revokeAgentToken(action.dataset.tokenId);
    if (action.dataset.action === "cancel-delete-board") closeDeleteBoardDialog();
    if (action.dataset.action === "confirm-delete-board") deleteCurrentBoardFromDialog(action);
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
    if (!workItemDialogOpen && !deleteBoardDialogOpen && !agentConnectDialogOpen) return;
    workItemDialogOpen = false;
    deleteBoardDialogOpen = false;
    resetAgentConnectDialog();
    render();
  });
}

async function initialize() {
  state = await loadState();
  render();
  startPolling();
  startLiveUpdates();
}

initialize();
