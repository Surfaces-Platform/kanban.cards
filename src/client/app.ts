declare global {
  interface Window {
    KANBAN_CARDS_API_BASE_URL?: string;
  }
}

type Revision = string | number;
type Overlay =
  | { kind: "new-project" }
  | { kind: "project-settings" }
  | { kind: "new-card"; columnId: string }
  | { kind: "card"; cardId: string }
  | null;

interface Session {
  authenticated: boolean;
  label: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  revision: Revision;
  updatedAt: string;
  cardCount: number;
}

interface ProjectColumn {
  id: string;
  name: string;
  position: number;
}

interface CardComment {
  id: string;
  body: string;
  createdAt: string;
  actorLabel: string;
}

interface ProjectCard {
  id: string;
  title: string;
  body: string;
  columnId: string;
  position: number;
  version: Revision;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  comments: CardComment[];
}

interface ActivityItem {
  id: string;
  cardId: string | null;
  action: string;
  summary: string;
  actorLabel: string;
  createdAt: string;
}

interface Project extends ProjectSummary {
  columns: ProjectColumn[];
  cards: ProjectCard[];
  activity: ActivityItem[];
  archivedAt: string | null;
}

interface Toast {
  id: number;
  message: string;
  tone: "neutral" | "success" | "error";
}

interface AuthNotice {
  kind: "invalid-key" | "service-unavailable" | "session-expired";
  title: string;
  message: string;
}

interface CardDraft {
  cardId: string;
  title: string;
  body: string;
  columnId: string;
}

interface FocusTarget {
  action: string;
  projectId?: string;
  cardId?: string;
  columnId?: string;
  occurrence: number;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  revision?: Revision | null;
  idempotent?: boolean;
}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const API_BASE_URL = (window.KANBAN_CARDS_API_BASE_URL || "/api").replace(/\/$/, "");
const AGENT_INSTRUCTION = "Use $kanban-cards in this repository to create a project and turn the current plan into cards.";
const DEFAULT_COLUMNS = ["Inbox", "Next", "Doing", "Done"];
const rootElement = document.querySelector<HTMLElement>("#app");
const toastElement = document.querySelector<HTMLElement>("#toast-region");

if (!rootElement || !toastElement) throw new Error("The kanban.cards application shell is missing.");
const root: HTMLElement = rootElement;
const toastRegion: HTMLElement = toastElement;

let session: Session | null = null;
let projects: ProjectSummary[] = [];
let activeProject: Project | null = null;
let overlay: Overlay = null;
let initialLoading = true;
let projectLoading = false;
let mutationInFlight = false;
let toastSequence = 0;
let toasts: Toast[] = [];
let authNotice: AuthNotice | null = null;
let cardDraft: CardDraft | null = null;
let cardFormMessage = "";
let cardConflict = false;
let overlayReturnFocus: FocusTarget | null = null;
let pendingFocusRestore: FocusTarget | null = null;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

function uniqueKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDate(value: string): string {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "KC";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}

function toRevision(value: unknown, fallback: Revision = 0): Revision {
  return typeof value === "string" || typeof value === "number" ? value : fallback;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function unwrapRecord(value: unknown, key: string): Record<string, any> {
  const record = objectValue(value);
  return objectValue(record[key] ?? record);
}

function actorLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  const actor = objectValue(value);
  return String(actor.label || actor.channel || "Owner");
}

function normalizeComment(value: unknown): CardComment {
  const comment = objectValue(value);
  return {
    id: String(comment.id || uniqueKey()),
    body: String(comment.body ?? ""),
    createdAt: String(comment.createdAt || ""),
    actorLabel: actorLabel(comment.actor ?? comment.actorLabel ?? comment.author)
  };
}

function normalizeCard(value: unknown): ProjectCard {
  const card = objectValue(value);
  return {
    id: String(card.id || ""),
    title: String(card.title || "Untitled card"),
    body: String(card.body ?? card.description ?? card.summary ?? ""),
    columnId: String(card.columnId || ""),
    position: Number.isFinite(Number(card.position)) ? Number(card.position) : 0,
    version: toRevision(card.version),
    createdAt: String(card.createdAt || ""),
    updatedAt: String(card.updatedAt || ""),
    archivedAt: card.archivedAt ? String(card.archivedAt) : null,
    comments: arrayValue(card.comments).map(normalizeComment)
  };
}

function normalizeActivity(value: unknown): ActivityItem {
  const item = objectValue(value);
  return {
    id: String(item.id || uniqueKey()),
    cardId: item.cardId ? String(item.cardId) : null,
    action: String(item.action || item.type || "updated"),
    summary: String(item.summary || item.message || item.action || item.type || "Project updated"),
    actorLabel: actorLabel(item.actor ?? item.actorLabel ?? item.channel),
    createdAt: String(item.createdAt || "")
  };
}

function normalizeProjectSummary(value: unknown): ProjectSummary {
  const project = objectValue(value);
  const cards = arrayValue(project.cards).map(normalizeCard).filter((card) => !card.archivedAt);
  return {
    id: String(project.id || ""),
    name: String(project.name || "Untitled project"),
    description: String(project.description || ""),
    revision: toRevision(project.revision),
    updatedAt: String(project.updatedAt || ""),
    cardCount: Number.isFinite(Number(project.cardCount)) ? Number(project.cardCount) : cards.length
  };
}

function normalizeProject(value: unknown): Project {
  const project = unwrapRecord(value, "project");
  const summary = normalizeProjectSummary(project);
  return {
    ...summary,
    columns: arrayValue(project.columns).map((columnValue, index) => {
      const column = objectValue(columnValue);
      return {
        id: String(column.id || ""),
        name: String(column.name ?? column.title ?? `Column ${index + 1}`),
        position: Number.isFinite(Number(column.position)) ? Number(column.position) : index
      };
    }).sort((a, b) => a.position - b.position),
    cards: arrayValue(project.cards).map(normalizeCard),
    activity: arrayValue(project.activity).map(normalizeActivity),
    archivedAt: project.archivedAt ? String(project.archivedAt) : null
  };
}

function normalizeSession(value: unknown): Session | null {
  const result = objectValue(value);
  if (result.authenticated === false) return null;
  const source = objectValue(result.session ?? result.user ?? result.actor ?? result);
  const authenticated = result.authenticated === true || Boolean(source.email || source.name || source.userId || source.id || source.label);
  if (!authenticated) return null;
  return {
    authenticated: true,
    label: String(source.name || source.email || source.label || "Owner")
  };
}

async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.revision !== undefined && options.revision !== null) headers.set("X-Kanban-Version", String(options.revision));
  if (options.idempotent) headers.set("Idempotency-Key", uniqueKey());

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = response.status === 204
    ? null
    : contentType.includes("application/json")
      ? await response.json()
      : await response.text();

  if (!response.ok) {
    const record = objectValue(payload);
    const responseText = typeof payload === "string" && !payload.trimStart().startsWith("<")
      ? payload.slice(0, 240)
      : "";
    const message = String(record.error || record.message || responseText || `Request failed (${response.status})`);
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

function renderTextInput(options: {
  id: string;
  name: string;
  value?: string;
  type?: "text" | "password";
  placeholder?: string;
  autocomplete?: string;
  required?: boolean;
  autofocus?: boolean;
  ariaDescribedBy?: string;
  invalid?: boolean;
}): string {
  return `<input class="form-control" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}" type="${options.type || "text"}" value="${escapeHtml(options.value || "")}"${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ""}${options.autocomplete ? ` autocomplete="${escapeHtml(options.autocomplete)}"` : ""}${options.required ? " required" : ""}${options.autofocus ? " autofocus" : ""}${options.ariaDescribedBy ? ` aria-describedby="${escapeHtml(options.ariaDescribedBy)}"` : ""}${options.invalid ? ' aria-invalid="true"' : ""}>`;
}

function renderTextArea(options: {
  id: string;
  name: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  ariaLabel?: string;
}): string {
  return `<textarea class="form-control textarea-control" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}" rows="${options.rows || 4}"${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ""}${options.required ? " required" : ""}${options.ariaLabel ? ` aria-label="${escapeHtml(options.ariaLabel)}"` : ""}>${escapeHtml(options.value || "")}</textarea>`;
}

function renderSelect(options: {
  id: string;
  name: string;
  value?: string;
  choices: Array<{ value: string; label: string }>;
  ariaLabel?: string;
}): string {
  return `<select class="form-control select-control" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}"${options.ariaLabel ? ` aria-label="${escapeHtml(options.ariaLabel)}"` : ""}>${options.choices.map((choice) => `<option value="${escapeHtml(choice.value)}"${choice.value === options.value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select>`;
}

function renderField(label: string, control: string, hint = ""): string {
  return `<label class="form-field"><span class="field-label">${escapeHtml(label)}</span>${control}${hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : ""}</label>`;
}

function renderButton(label: string, action: string, className = "secondary-button", attributes = ""): string {
  return `<button class="${className}" type="button" data-action="${escapeHtml(action)}" ${attributes}>${escapeHtml(label)}</button>`;
}

function showToast(message: string, tone: Toast["tone"] = "neutral"): void {
  const toast: Toast = { id: ++toastSequence, message, tone };
  toasts = [...toasts, toast];
  renderToasts();
  window.setTimeout(() => {
    toasts = toasts.filter((candidate) => candidate.id !== toast.id);
    renderToasts();
  }, tone === "error" ? 6000 : 3600);
}

function renderToasts(): void {
  toastRegion.innerHTML = toasts.map((toast) => `<div class="toast toast-${toast.tone}" role="status">${escapeHtml(toast.message)}</div>`).join("");
}

function renderLoading(): string {
  return `<main class="centered-view"><div class="brand-lockup"><span class="brand-dot" aria-hidden="true"></span><strong>kanban.cards</strong></div><p class="quiet">Opening your projects…</p></main>`;
}

function renderSignIn(): string {
  const notice = authNotice
    ? `<div class="form-message form-message-error" id="auth-notice" role="alert"><strong>${escapeHtml(authNotice.title)}</strong><p>${escapeHtml(authNotice.message)}</p></div>`
    : "";
  return `
    <main class="auth-view">
      <section class="auth-card" aria-labelledby="sign-in-title">
        <div class="brand-lockup"><span class="brand-dot" aria-hidden="true"></span><strong>kanban.cards</strong></div>
        <div class="auth-copy">
          <p class="eyebrow">Private workspace</p>
          <h1 id="sign-in-title">Open your projects</h1>
          <p>Use your kanban.cards access key once. It is exchanged for a private browser session and is never stored in the project.</p>
        </div>
        ${notice}
        <form data-form="sign-in" class="stack-form">
          ${renderField("Access key", renderTextInput({ id: "access-key", name: "token", type: "password", autocomplete: "current-password", required: true, autofocus: true, ariaDescribedBy: authNotice ? "auth-notice" : undefined, invalid: authNotice?.kind === "invalid-key" }), "You can rotate this key at any time.")}
          <button class="primary-button full-width" type="submit">${mutationInFlight ? "Opening…" : "Open kanban.cards"}</button>
        </form>
      </section>
    </main>`;
}

function renderHeader(): string {
  const activeId = activeProject?.id || "";
  const projectOptions = projects.map((project) => ({ value: project.id, label: project.name }));
  return `
    <header class="app-header">
      <div class="header-primary">
        <button class="brand-button" type="button" data-action="show-projects" aria-label="Show all projects">
          <span class="brand-dot" aria-hidden="true"></span><strong>kanban.cards</strong>
        </button>
        ${activeProject && projectOptions.length ? `<div class="project-select-wrap">${renderSelect({ id: "project-select", name: "projectId", value: activeId, choices: projectOptions, ariaLabel: "Active project" })}</div>` : ""}
      </div>
      <nav class="header-actions" aria-label="Project and account actions">
        ${renderButton("New project", "new-project")}
        ${activeProject ? renderButton("Project settings", "project-settings") : ""}
        <div class="account-chip" title="${escapeHtml(session?.label || "Owner")}"><span>${escapeHtml(initials(session?.label || "Owner"))}</span></div>
        ${renderButton("Log out", "logout", "text-button")}
      </nav>
    </header>`;
}

function renderAgentInstruction(compact = false): string {
  return `
    <section class="agent-instruction${compact ? " is-compact" : ""}" aria-label="Agent instruction">
      <div>
        <p class="eyebrow">Start with the skill</p>
        <p class="instruction-copy" id="agent-instruction">${escapeHtml(AGENT_INSTRUCTION)}</p>
      </div>
      ${renderButton("Copy instruction", "copy-agent-instruction", "secondary-button")}
    </section>`;
}

function renderProjectList(): string {
  return `
    ${renderHeader()}
    <main class="projects-view">
      <section class="page-heading">
        <div><p class="eyebrow">Workspace</p><h1>Your projects</h1><p>One project is one board. Open one here or let the skill create and populate it.</p></div>
        <button class="primary-button" type="button" data-action="new-project">New project</button>
      </section>
      ${projects.length ? `
        <section class="project-grid" aria-label="Projects">
          ${projects.map((project) => `
            <button class="project-card" type="button" data-action="open-project" data-project-id="${escapeHtml(project.id)}">
              <span class="project-card-top"><span class="project-glyph" aria-hidden="true">${escapeHtml(initials(project.name))}</span><span class="card-count">${project.cardCount} ${project.cardCount === 1 ? "card" : "cards"}</span></span>
              <strong>${escapeHtml(project.name)}</strong>
              <span class="project-description">${escapeHtml(project.description || "No description yet.")}</span>
              <span class="project-updated">${project.updatedAt ? `Updated ${escapeHtml(formatDate(project.updatedAt))}` : "Ready to use"}</span>
            </button>`).join("")}
        </section>
        ${renderAgentInstruction(true)}` : `
        <section class="empty-projects">
          <div class="empty-illustration" aria-hidden="true"><span></span><span></span><span></span></div>
          <p class="eyebrow">Nothing to migrate</p>
          <h2>Start with a clean project</h2>
          <p>Create it here, or copy this instruction into Codex so the skill can initialize the board from your repository.</p>
          ${renderAgentInstruction()}
        </section>`}
    </main>
    ${renderOverlay()}`;
}

function activeCards(project: Project): ProjectCard[] {
  return project.cards.filter((card) => !card.archivedAt);
}

function renderBoard(): string {
  const project = activeProject;
  if (!project) return renderProjectList();
  const visibleCards = activeCards(project);
  return `
    ${renderHeader()}
    <main class="board-view">
      <section class="board-heading">
        <div class="board-title-block">
          <button class="back-link" type="button" data-action="show-projects" aria-label="Back to projects">← Projects</button>
          <h1>${escapeHtml(project.name)}</h1>
          ${project.description ? `<p>${escapeHtml(project.description)}</p>` : ""}
          <button class="secondary-button mobile-project-settings" type="button" data-action="project-settings">Project settings</button>
        </div>
        <div class="board-heading-actions">
          <button class="secondary-button" type="button" data-action="refresh-project"${projectLoading ? " disabled" : ""}>${projectLoading ? "Refreshing…" : "Refresh"}</button>
          <div class="board-summary"><strong>${visibleCards.length}</strong><span>${visibleCards.length === 1 ? "active card" : "active cards"}</span></div>
        </div>
      </section>
      ${visibleCards.length === 0 ? renderAgentInstruction(true) : ""}
      ${projectLoading ? `<section class="board-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Refreshing project…</section>` : `
        <section class="kanban-board" aria-label="${escapeHtml(project.name)} board">
          ${project.columns.map((column) => renderColumn(project, column)).join("")}
        </section>`}
    </main>
    ${renderOverlay()}`;
}

function renderColumn(project: Project, column: ProjectColumn): string {
  const cards = activeCards(project)
    .filter((card) => card.columnId === column.id)
    .sort((a, b) => a.position - b.position);
  return `
    <section class="kanban-column" aria-labelledby="column-${escapeHtml(column.id)}">
      <header class="column-header">
        <div><h2 id="column-${escapeHtml(column.id)}">${escapeHtml(column.name)}</h2><span>${cards.length}</span></div>
        <button class="icon-button" type="button" data-action="new-card" data-column-id="${escapeHtml(column.id)}" aria-label="Add card to ${escapeHtml(column.name)}">+</button>
      </header>
      <div class="column-cards">
        ${cards.length ? cards.map((card) => renderCard(card)).join("") : `<button class="empty-column" type="button" data-action="new-card" data-column-id="${escapeHtml(column.id)}"><span>+</span>Add a card</button>`}
      </div>
    </section>`;
}

function renderCard(card: ProjectCard): string {
  const lastComment = card.comments.at(-1);
  return `
    <button class="kanban-card" type="button" data-action="open-card" data-card-id="${escapeHtml(card.id)}">
      <strong>${escapeHtml(card.title)}</strong>
      ${card.body ? `<span class="card-body-preview">${escapeHtml(card.body)}</span>` : ""}
      <span class="card-meta">
        ${card.comments.length ? `<span aria-label="${card.comments.length} comments">◌ ${card.comments.length}</span>` : `<span>No comments</span>`}
        <time>${escapeHtml(formatDate(card.updatedAt || card.createdAt))}</time>
      </span>
      ${lastComment ? `<span class="latest-comment">${escapeHtml(lastComment.actorLabel)}: ${escapeHtml(lastComment.body)}</span>` : ""}
    </button>`;
}

function renderOverlay(): string {
  if (!overlay) return "";
  if (overlay.kind === "new-project") return renderProjectDialog(false);
  if (overlay.kind === "project-settings") return renderProjectDialog(true);
  if (overlay.kind === "new-card") return renderCardDrawer(null, overlay.columnId);
  const cardId = overlay.cardId;
  const card = activeProject?.cards.find((candidate) => candidate.id === cardId) || null;
  return card ? renderCardDrawer(card, card.columnId) : "";
}

function renderProjectDialog(settings: boolean): string {
  const project = settings ? activeProject : null;
  const columnNames = project?.columns.map((column) => column.name).join("\n") || DEFAULT_COLUMNS.join("\n");
  return `
    <div class="overlay-backdrop" data-action="close-overlay"></div>
    <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <header class="overlay-header"><div><p class="eyebrow">${settings ? "Project settings" : "New project"}</p><h2 id="project-dialog-title">${settings ? "Edit the board" : "Create a clean board"}</h2></div><button class="close-button" type="button" data-action="close-overlay" aria-label="Close">×</button></header>
      <form class="stack-form" data-form="${settings ? "project-settings" : "new-project"}">
        ${renderField("Project name", renderTextInput({ id: "project-name", name: "name", value: project?.name || "", placeholder: "Product launch", required: true, autofocus: true }))}
        ${renderField("Description", renderTextArea({ id: "project-description", name: "description", value: project?.description || "", placeholder: "What this project is for", rows: 3 }))}
        ${renderField("Columns", renderTextArea({ id: "project-columns", name: "columns", value: columnNames, rows: 5, required: true }), settings ? "Rename columns one per line. Keep their order and count." : "One column per line. You can rename them later.")}
        <footer class="form-actions"><button class="secondary-button" type="button" data-action="close-overlay">Cancel</button><button class="primary-button" type="submit">${mutationInFlight ? "Saving…" : settings ? "Save changes" : "Create project"}</button></footer>
      </form>
    </section>`;
}

function renderCardDrawer(card: ProjectCard | null, initialColumnId: string): string {
  const project = activeProject;
  if (!project) return "";
  const cardActivity = card ? project.activity.filter((item) => item.cardId === card.id).slice(-8).reverse() : [];
  const cardId = card?.id || "";
  const draft = cardDraft?.cardId === cardId ? cardDraft : null;
  const title = draft?.title ?? card?.title ?? "";
  const body = draft?.body ?? card?.body ?? "";
  const columnId = draft?.columnId ?? card?.columnId ?? initialColumnId;
  const storedColumn = card ? project.columns.find((column) => column.id === card.columnId)?.name || "Unknown column" : "";
  const recovery = cardFormMessage
    ? `<div class="form-message form-message-error" id="card-form-message" role="alert" tabindex="-1"><strong>${cardConflict ? "This Card changed elsewhere" : "The Card was not saved"}</strong><p>${escapeHtml(cardFormMessage)}</p>${cardConflict && card ? `<details><summary>Review the stored version</summary><dl><div><dt>Title</dt><dd>${escapeHtml(card.title)}</dd></div><div><dt>Column</dt><dd>${escapeHtml(storedColumn)}</dd></div><div><dt>Details</dt><dd>${escapeHtml(card.body || "No details")}</dd></div></dl></details>` : ""}</div>`
    : "";
  return `
    <div class="overlay-backdrop" data-action="close-overlay"></div>
    <aside class="card-drawer" role="dialog" aria-modal="true" aria-labelledby="card-drawer-title">
      <header class="overlay-header"><div><p class="eyebrow">${card ? "Card" : "New card"}</p><h2 id="card-drawer-title">${card ? escapeHtml(card.title) : "Add work"}</h2></div><button class="close-button" type="button" data-action="close-overlay" aria-label="Close">×</button></header>
      <div class="drawer-scroll">
        ${recovery}
        <form class="stack-form" data-form="card" data-card-id="${escapeHtml(cardId)}"${cardFormMessage ? ' aria-describedby="card-form-message"' : ""}>
          ${renderField("Title", renderTextInput({ id: "card-title", name: "title", value: title, placeholder: "What needs to happen?", required: true, autofocus: !card }))}
          ${renderField("Details", renderTextArea({ id: "card-body", name: "body", value: body, placeholder: "Context, outcome, and anything the next person should know", rows: 7 }))}
          ${renderField("Column", renderSelect({ id: "card-column", name: "columnId", value: columnId, choices: project.columns.map((column) => ({ value: column.id, label: column.name })) }))}
          <footer class="form-actions card-form-actions">
            ${card ? `<button class="danger-text-button" type="button" data-action="archive-card" data-card-id="${escapeHtml(card.id)}">Archive card</button>` : `<span></span>`}
            <button class="primary-button" type="submit">${mutationInFlight ? "Saving…" : card ? "Save card" : "Add card"}</button>
          </footer>
        </form>
        ${card ? renderConversation(card, cardActivity) : ""}
      </div>
    </aside>`;
}

function renderConversation(card: ProjectCard, activity: ActivityItem[]): string {
  return `
    <section class="conversation" aria-labelledby="conversation-title">
      <div class="section-heading"><h3 id="conversation-title">Conversation</h3><span>${card.comments.length}</span></div>
      <div class="comment-list">
        ${card.comments.length ? card.comments.map((comment) => `<article class="comment"><div><header><strong>${escapeHtml(comment.actorLabel)}</strong><time>${escapeHtml(formatDate(comment.createdAt))}</time></header><p>${escapeHtml(comment.body)}</p></div></article>`).join("") : `<p class="empty-copy">No comments yet. Add context or leave a progress note.</p>`}
      </div>
      <form class="comment-form" data-form="comment" data-card-id="${escapeHtml(card.id)}">
        ${renderTextArea({ id: "comment-body", name: "body", placeholder: "Add a comment…", rows: 3, required: true, ariaLabel: "Comment" })}
        <button class="secondary-button" type="submit">Comment</button>
      </form>
      ${activity.length ? `<details class="activity-log"><summary>Recent activity</summary><ol>${activity.map((item) => `<li><span>${escapeHtml(item.summary)}</span><small>${escapeHtml(item.actorLabel)} · ${escapeHtml(formatDate(item.createdAt))}</small></li>`).join("")}</ol></details>` : ""}
    </section>`;
}

function focusTargetFor(element: HTMLElement): FocusTarget | null {
  const action = element.dataset.action;
  if (!action) return null;
  const peers = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)].filter((candidate) =>
    candidate.dataset.projectId === element.dataset.projectId
    && candidate.dataset.cardId === element.dataset.cardId
    && candidate.dataset.columnId === element.dataset.columnId
  );
  return {
    action,
    projectId: element.dataset.projectId,
    cardId: element.dataset.cardId,
    columnId: element.dataset.columnId,
    occurrence: Math.max(0, peers.indexOf(element))
  };
}

function findFocusTarget(target: FocusTarget): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(`[data-action="${target.action}"]`);
  const matches = [...candidates].filter((candidate) =>
    candidate.dataset.projectId === target.projectId
    && candidate.dataset.cardId === target.cardId
    && candidate.dataset.columnId === target.columnId
    && !candidate.hasAttribute("disabled")
    && candidate.getClientRects().length > 0
  );
  return matches[target.occurrence] || matches[0] || null;
}

function restorePendingFocus(): void {
  const target = pendingFocusRestore;
  if (!target) return;
  pendingFocusRestore = null;
  window.requestAnimationFrame(() => {
    const element = findFocusTarget(target)
      || root.querySelector<HTMLElement>("[data-action='show-projects']")
      || root.querySelector<HTMLElement>("main");
    if (!element) return;
    if (element.tagName === "MAIN" && !element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
    element.focus();
  });
}

function focusOverlay(): void {
  window.requestAnimationFrame(() => {
    const dialog = root.querySelector<HTMLElement>("[role='dialog']");
    const target = dialog?.querySelector<HTMLElement>("[autofocus], .close-button, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])");
    target?.focus();
  });
}

function render(): void {
  let content: string;
  if (initialLoading) {
    content = renderLoading();
  } else if (!session) {
    content = renderSignIn();
  } else {
    content = activeProject ? renderBoard() : renderProjectList();
  }
  root.innerHTML = content;
  restorePendingFocus();
}

function formData(form: HTMLFormElement): FormData {
  return new FormData(form);
}

function textField(data: FormData, name: string): string {
  return String(data.get(name) || "").trim();
}

function parseColumnNames(value: string): string[] {
  return value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

async function loadSession(): Promise<void> {
  try {
    session = normalizeSession(await api("/session"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) session = null;
    else throw error;
  }
}

async function loadProjects(preferredId?: string): Promise<void> {
  const payload = await api("/projects");
  const record = objectValue(payload);
  const list = Array.isArray(payload) ? payload : arrayValue(record.projects);
  projects = list.map(normalizeProjectSummary).filter((project) => project.id);

  const storedId = window.localStorage.getItem("kanban.cards:project-id") || "";
  const projectId = preferredId || activeProject?.id || storedId;
  if (projectId && projects.some((project) => project.id === projectId)) await loadProject(projectId);
  else activeProject = null;
}

async function loadProject(projectId: string): Promise<void> {
  projectLoading = true;
  if (activeProject) render();
  try {
    const [projectPayload, activityResult] = await Promise.all([
      api(`/projects/${safeId(projectId)}`),
      api(`/projects/${safeId(projectId)}/activity`).catch(() => null)
    ]);
    const project = normalizeProject(projectPayload);
    const activityRecord = objectValue(activityResult);
    const activityList = Array.isArray(activityResult) ? activityResult : arrayValue(activityRecord.activity ?? activityRecord.events);
    if (activityList.length) project.activity = activityList.map(normalizeActivity);
    activeProject = project;
    window.localStorage.setItem("kanban.cards:project-id", project.id);
  } finally {
    projectLoading = false;
  }
}

async function refreshAfterMutation(projectId: string): Promise<void> {
  const payload = await api("/projects");
  const record = objectValue(payload);
  const list = Array.isArray(payload) ? payload : arrayValue(record.projects);
  projects = list.map(normalizeProjectSummary).filter((project) => project.id);
  await loadProject(projectId);
}

async function signIn(form: HTMLFormElement): Promise<void> {
  const token = textField(formData(form), "token");
  if (!token) return;
  form.reset();
  authNotice = null;
  mutationInFlight = true;
  render();
  try {
    await api("/session", { method: "POST", body: { token } });
    await loadSession();
    if (!session) throw new Error("The access key was accepted, but no session was created.");
    await loadProjects();
    authNotice = null;
    showToast("Signed in.", "success");
  } catch (error) {
    session = null;
    projects = [];
    activeProject = null;
    if (error instanceof ApiError && error.status === 401) {
      authNotice = {
        kind: "invalid-key",
        title: "Access key not accepted",
        message: "Check the key and try again. No Project information was opened."
      };
    } else {
      authNotice = {
        kind: "service-unavailable",
        title: "kanban.cards is unavailable",
        message: "The service could not start a session. Your key was not retained; try again when the service is available."
      };
    }
  } finally {
    mutationInFlight = false;
    render();
    if (!session) window.requestAnimationFrame(() => root.querySelector<HTMLInputElement>("#access-key")?.focus());
  }
}

async function logOut(): Promise<void> {
  mutationInFlight = true;
  try {
    await api("/session", { method: "DELETE" });
  } finally {
    session = null;
    projects = [];
    activeProject = null;
    overlay = null;
    authNotice = null;
    cardDraft = null;
    cardFormMessage = "";
    cardConflict = false;
    overlayReturnFocus = null;
    pendingFocusRestore = null;
    mutationInFlight = false;
    window.localStorage.removeItem("kanban.cards:project-id");
    render();
  }
}

async function createProject(form: HTMLFormElement): Promise<void> {
  const data = formData(form);
  const name = textField(data, "name");
  const description = textField(data, "description");
  const columnNames = parseColumnNames(textField(data, "columns"));
  if (!name || !columnNames.length) throw new Error("Add a project name and at least one column.");

  mutationInFlight = true;
  render();
  try {
    const response = await api("/projects", {
      method: "POST",
      idempotent: true,
      body: { name, description, columns: columnNames.map((columnName, position) => ({ name: columnName, position })) }
    });
    const created = normalizeProject(response);
    const projectId = created.id || String(objectValue(response).id || "");
    if (!projectId) throw new Error("The project was created without an id.");
    closeOverlay(false);
    await loadProjects(projectId);
    showToast("Project created.", "success");
  } finally {
    mutationInFlight = false;
    render();
  }
}

async function updateProject(form: HTMLFormElement): Promise<void> {
  const project = activeProject;
  if (!project) return;
  const data = formData(form);
  const name = textField(data, "name");
  const description = textField(data, "description");
  const columnNames = parseColumnNames(textField(data, "columns"));
  if (!name || !columnNames.length) throw new Error("Add a project name and at least one column.");
  if (columnNames.length !== project.columns.length) throw new Error("For now, keep the same number of columns and rename them in place.");

  mutationInFlight = true;
  render();
  try {
    await api(`/projects/${safeId(project.id)}`, {
      method: "PATCH",
      revision: project.revision,
      body: {
        name,
        description,
        columns: project.columns.map((column, index) => ({ ...column, name: columnNames[index], position: index }))
      }
    });
    closeOverlay(false);
    await refreshAfterMutation(project.id);
    showToast("Project updated.", "success");
  } finally {
    mutationInFlight = false;
    render();
  }
}

async function saveCard(form: HTMLFormElement): Promise<void> {
  const project = activeProject;
  if (!project) return;
  const data = formData(form);
  const title = textField(data, "title");
  const body = textField(data, "body");
  const columnId = textField(data, "columnId");
  const cardId = form.dataset.cardId || "";
  if (!title || !columnId) throw new Error("Add a card title and choose a column.");

  cardDraft = { cardId, title, body, columnId };
  cardFormMessage = "";
  cardConflict = false;
  mutationInFlight = true;
  form.setAttribute("aria-busy", "true");
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button")) {
    control.disabled = true;
  }
  const submitButton = form.querySelector<HTMLButtonElement>("button[type='submit']");
  if (submitButton) submitButton.textContent = "Saving…";
  let mutationCompleted = false;
  try {
    if (cardId) {
      const card = project.cards.find((candidate) => candidate.id === cardId);
      if (!card) throw new Error("That card is no longer available.");
      await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
        method: "PATCH",
        revision: card.version,
        body: { title, body, columnId }
      });
    } else {
      await api(`/projects/${safeId(project.id)}/cards`, {
        method: "POST",
        idempotent: true,
        body: { title, body, columnId }
      });
    }
    mutationCompleted = true;
    await refreshAfterMutation(project.id);
    closeOverlay(false);
    showToast(cardId ? "Card updated." : "Card added.", "success");
  } catch (error) {
    mutationInFlight = false;
    if (error instanceof ApiError && error.status === 401) {
      handleError(error);
      return;
    }
    if (mutationCompleted) {
      closeOverlay(false);
      showToast("The Card was saved, but the Project could not refresh. Use Refresh to load the latest state.", "error");
      render();
      return;
    }
    if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
      cardConflict = true;
      cardFormMessage = "Your draft is preserved below. Review the stored version, then choose Save card to apply your draft to the latest Card version.";
      try {
        await refreshAfterMutation(project.id);
      } catch (refreshError) {
        if (refreshError instanceof ApiError && refreshError.status === 401) {
          handleError(refreshError);
          return;
        }
        cardFormMessage = "Your draft is preserved, but the latest stored version could not be loaded. Refresh the Project and try again.";
      }
      showToast("The Card changed elsewhere. Your draft is preserved.", "error");
    } else {
      const detail = error instanceof Error ? error.message : "The request failed.";
      cardFormMessage = `Your draft is preserved. ${detail} Try saving again.`;
      showToast("The Card was not saved. Your draft is preserved.", "error");
    }
    render();
    window.requestAnimationFrame(() => root.querySelector<HTMLElement>("#card-form-message")?.focus());
    return;
  }
  mutationInFlight = false;
  render();
}

async function archiveCard(cardId: string): Promise<void> {
  const project = activeProject;
  const card = project?.cards.find((candidate) => candidate.id === cardId);
  if (!project || !card) return;
  mutationInFlight = true;
  render();
  try {
    await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
      method: "PATCH",
      revision: card.version,
      body: { archivedAt: new Date().toISOString() }
    });
    closeOverlay(false);
    await refreshAfterMutation(project.id);
    showToast("Card archived.", "success");
  } finally {
    mutationInFlight = false;
    render();
  }
}

async function addComment(form: HTMLFormElement): Promise<void> {
  const project = activeProject;
  const cardId = form.dataset.cardId || "";
  const card = project?.cards.find((candidate) => candidate.id === cardId);
  const body = textField(formData(form), "body");
  if (!project || !card || !body) return;
  mutationInFlight = true;
  render();
  try {
    await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}/comments`, {
      method: "POST",
      revision: card.version,
      idempotent: true,
      body: { body }
    });
    await refreshAfterMutation(project.id);
    overlay = { kind: "card", cardId };
    showToast("Comment added.", "success");
  } finally {
    mutationInFlight = false;
    render();
  }
}

function openOverlay(nextOverlay: Overlay, trigger: HTMLElement): void {
  cardDraft = null;
  cardFormMessage = "";
  cardConflict = false;
  overlayReturnFocus = focusTargetFor(trigger);
  overlay = nextOverlay;
  render();
  focusOverlay();
}

function closeOverlay(renderNow = true): void {
  overlay = null;
  cardDraft = null;
  cardFormMessage = "";
  cardConflict = false;
  pendingFocusRestore = overlayReturnFocus;
  overlayReturnFocus = null;
  if (renderNow) render();
}

async function handleAction(button: HTMLElement): Promise<void> {
  const action = button.dataset.action || "";
  if (action === "close-overlay") {
    closeOverlay();
    return;
  }
  if (action === "new-project") return openOverlay({ kind: "new-project" }, button);
  if (action === "project-settings") return openOverlay({ kind: "project-settings" }, button);
  if (action === "new-card") return openOverlay({ kind: "new-card", columnId: button.dataset.columnId || activeProject?.columns[0]?.id || "" }, button);
  if (action === "open-card") return openOverlay({ kind: "card", cardId: button.dataset.cardId || "" }, button);
  if (action === "show-projects") {
    overlay = null;
    activeProject = null;
    render();
    return;
  }
  if (action === "open-project") {
    await loadProject(button.dataset.projectId || "");
    render();
    return;
  }
  if (action === "refresh-project" && activeProject) {
    const projectId = activeProject.id;
    await loadProject(projectId);
    render();
    showToast("Project refreshed.", "success");
    return;
  }
  if (action === "logout") return logOut();
  if (action === "archive-card") return archiveCard(button.dataset.cardId || "");
  if (action === "copy-agent-instruction") {
    await navigator.clipboard.writeText(AGENT_INSTRUCTION);
    showToast("Instruction copied.", "success");
  }
}

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]");
  if (!action || mutationInFlight) return;
  void handleAction(action).catch(handleError);
});

root.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id !== "project-select" || mutationInFlight) return;
  void loadProject(target.value).then(render).catch(handleError);
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  if (mutationInFlight) return;
  const form = event.target as HTMLFormElement;
  const kind = form.dataset.form || "";
  const operation = kind === "sign-in"
    ? signIn(form)
    : kind === "new-project"
      ? createProject(form)
      : kind === "project-settings"
        ? updateProject(form)
        : kind === "card"
          ? saveCard(form)
          : kind === "comment"
            ? addComment(form)
            : Promise.resolve();
  void operation.catch(handleError);
});

document.addEventListener("keydown", (event) => {
  if (!overlay || mutationInFlight) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeOverlay();
    return;
  }
  if (event.key === "Tab") {
    const dialog = root.querySelector<HTMLElement>("[role='dialog']");
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1) || first;
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
});

function handleError(error: unknown): void {
  mutationInFlight = false;
  if (error instanceof ApiError && error.status === 401) {
    session = null;
    projects = [];
    activeProject = null;
    overlay = null;
    cardDraft = null;
    cardFormMessage = "";
    cardConflict = false;
    overlayReturnFocus = null;
    pendingFocusRestore = null;
    window.localStorage.removeItem("kanban.cards:project-id");
    authNotice = {
      kind: "session-expired",
      title: "Your session ended",
      message: "Private Project data has been cleared from this screen. Enter your access key to continue."
    };
  } else if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
    showToast("This changed somewhere else. Refreshing the latest version.", "error");
    if (activeProject) void refreshAfterMutation(activeProject.id).then(render).catch(() => undefined);
  } else {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    if (!session) {
      authNotice = {
        kind: "service-unavailable",
        title: "kanban.cards is unavailable",
        message: "The service could not be reached. Access was not accepted or rejected; try again when the service is available."
      };
    } else {
      showToast(message, "error");
    }
  }
  render();
}

async function boot(): Promise<void> {
  render();
  try {
    await loadSession();
    if (session) await loadProjects();
  } catch (error) {
    handleError(error);
  } finally {
    initialLoading = false;
    render();
  }
}

void boot();

export {};
