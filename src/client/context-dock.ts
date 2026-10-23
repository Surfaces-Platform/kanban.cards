import { RecoveryStore, RecoveryMap, reconcileCardValues, cardTextFields, type CardTextField, type ReconciliationField } from "./recovery";
import { renderProductName } from "../brand";
import { passkeyFormCopy, publicPageTitle, renderPublicHomepage, renderPublicWebsite, usesPublicWebsite } from "../public-website";
import { syncPublicWebsiteMenu } from "./public-website-menu";
import { renderCardMarkdown } from "./markdown";
import { startRegistration, startAuthentication, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

declare global {
  interface Window {
    KANBAN_CARDS_API_BASE_URL?: string;
  }
}

type Revision = string | number;
type AccessContext = "auth" | "local" | "root" | "workspace";
type ProjectEditorMode = "create" | "edit" | null;
type InspectorTab = "card" | "activity";
type DescriptionView = "write" | "preview";
type NextActor = "human" | "agent" | null;
type CardPriority = "High" | "Medium" | "Low" | null;
interface CardFields {
  nextActor: NextActor;
  nextAction: string;
  priority: CardPriority;
  blockedReason: string;
}
interface CardFilters {
  nextActor: "all" | "human" | "agent" | "unassigned";
  priority: "all" | "High" | "Medium" | "Low" | "unset";
  blocked: "all" | "blocked" | "unblocked";
}
type MutationKind = "sign-in" | "workspace" | "agent" | "refresh" | "project" | "column" | "card" | "move" | "comment" | "archive" | "undo" | null;
type StatusTone = "neutral" | "success" | "warning" | "error" | "receipt";

interface Session {
  authenticated: boolean;
  ownerId: string;
  label: string;
  context: AccessContext;
  email?: string;
  workspace?: WorkspaceAccess;
}

type PasskeyMode = "signup" | "signin" | "setup" | "recover" | "add" | "verify";
interface AuthIntent { mode: PasskeyMode; rootOrigin: string; action?: string }
interface SessionEnvelope {
  authenticated: boolean;
  context: AccessContext;
  rootUrl: string;
  loginUrl: string;
  authIntent: AuthIntent | null;
  setupAvailable: boolean;
  session: Session | null;
}
interface AccessSettings {
  passkeys: Array<{ id: string; createdAt: string; lastUsedAt: string | null }>;
  sessions: Array<{ id: string; createdAt: string; expiresAt: string; current: boolean }>;
}

interface AccessFailure {
  title: string;
  message: string;
}

interface WorkspaceAccess {
  id: string;
  slug: string;
  name: string;
  url: string;
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

interface ProjectCard extends CardFields {
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
  projectId: string;
  projectName: string;
  projectArchivedAt: string | null;
  cardTitle: string;
  cardId: string | null;
  action: string;
  summary: string;
  actorLabel: string;
  channel: string;
  createdAt: string;
}

interface ActivityFeed {
  scope: "workspace" | "project";
  projectId: string | null;
  name: string;
  items: ActivityItem[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string;
  retryMore: boolean;
  requestId: number;
}

interface AgentConnection {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface Project extends ProjectSummary {
  columns: ProjectColumn[];
  cards: ProjectCard[];
  activity: ActivityItem[];
  archivedAt: string | null;
}

interface AuthNotice {
  kind: "invalid-key" | "access-denied" | "service-unavailable" | "session-expired" | "signed-out" | "sign-out-incomplete";
  title: string;
  message: string;
}

interface CardDraft extends CardFields {
  projectId: string;
  cardId: string | null;
  title: string;
  body: string;
  columnId: string;
  position: number;
  basePosition: number;
  baseVersion: Revision | null;
  baseTitle: string;
  baseBody: string;
  baseColumnId: string;
  baseArchivedAt: string | null;
  baseNextActor: NextActor;
  baseNextAction: string;
  basePriority: CardPriority;
  baseBlockedReason: string;
}

interface ProjectEditorDraft {
  mode: Exclude<ProjectEditorMode, null>;
  projectId: string | null;
  name: string;
  description: string;
  columns: Array<{ id: string | null; name: string }>;
}

interface AddColumnDraft {
  projectId: string;
  revision: Revision;
  columns: ProjectColumn[];
  id: string;
  name: string;
  outcomeUnconfirmed: boolean;
}

interface StatusMessage {
  tone: StatusTone;
  title: string;
  message: string;
}

interface ConfirmationMessage {
  title: string;
  message: string;
  uiState?: "refresh-success";
}

interface ArchiveReceipt {
  key: string;
  projectId: string;
  cardId: string;
  cardTitle: string;
}

interface CardConflict {
  projectId: string;
  cardId: string;
  latestLoaded: boolean;
  fields?: ReconciliationField[];
}

interface MoveConflict extends CardConflict {
  destinationColumnId: string;
}

interface FocusTarget {
  action: string;
  cardId?: string;
  columnId?: string;
  occurrence: number;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  revision?: Revision | null;
  idempotencyKey?: string;
  expectedOwnerId?: string;
}

interface TextControlOptions {
  id: string;
  name: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  autofocus?: boolean;
  disabled?: boolean;
  ariaDescribedBy?: string;
  ariaErrorMessage?: string;
  invalid?: boolean;
}

class LocalActionBlockedError extends Error {}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const API_BASE_URL = (window.KANBAN_CARDS_API_BASE_URL || "/api").replace(/\/$/, "");
const DEFAULT_COLUMNS = ["Next", "Doing", "Done"];
const CONFIRMATION_DURATION_MS = 5_000;
const ADD_COLUMN_PREPARING_STATUS: StatusMessage = {
  tone: "neutral",
  title: "Preparing Add Column",
  message: "Retaining your local Card draft and loading the latest Project before adding a Column."
};
const UI_CONTRACT_STATES = [
  "opening", "signed-out", "invalid-key", "workspace-route", "empty-workspace", "empty-project", "populated", "selected",
  "refreshing", "refresh-success", "refresh-failure", "saving", "validation-error", "stale",
  "session-expired", "service-unavailable", "archived", "signing-out", "sign-out-success"
] as const;

const rootElement = document.querySelector<HTMLElement>("#app");
if (!rootElement) throw new Error("The kanban.cards application shell is missing.");
const root: HTMLElement = rootElement;
const narrowBoardQuery = window.matchMedia("(max-width: 48rem)");
const cardOnlyQuery = window.matchMedia("(max-width: 56rem)");

let session: Session | null = null;
let accessContext: AccessContext = "local";
let rootUrl = window.location.origin;
let loginUrl = "";
let authIntent: AuthIntent | null = null;
let setupAvailable = false;
let signOutPending = false;
let recoveryCode = "";
let pendingAuthHandoff: { destination: string; token: string } | null = null;
let accessSettings: AccessSettings | null = null;
let accessPanelOpen = false;
let accessStatus: StatusMessage | null = null;
let agentNeedsVerification = false;
let passkeyDraft = { workspaceName: "", workspaceSlug: "", displayName: "" };
let workspaceHandoffPending = false;
let workspaceChoices: WorkspaceAccess[] = [];
let workspaceMenuOpen = false;
let workspaceCreationOpen = false;
let workspaceCreationReturnSlug = "";
let workspaceDraft = { name: "", slug: "" };
let createdWorkspace: WorkspaceAccess | null = null;
const uncertainWorkspaceCreations = new Map<string, Set<string>>();
let accessFailure: AccessFailure | null = null;
let agentConnections: AgentConnection[] = [];
let agentPanelOpen = false;
let issuedAgentCredential = "";
let projects: ProjectSummary[] = [];
let activeProject: Project | null = null;
let initialLoading = true;
let projectLoading = false;
let mutationInFlight = false;
let mutationKind: MutationKind = null;
let authNotice: AuthNotice | null = null;
let selectedCardId: string | null = null;
let creatingCard = false;
let creatingColumnId = "";
let projectEditorMode: ProjectEditorMode = null;
let projectEditorDraft: ProjectEditorDraft | null = null;
let addColumnPreparing = false;
let addColumnCommitted = false;
let addColumnDraft: AddColumnDraft | null = null;
let addColumnFieldError = "";
let projectFieldErrors = new Map<string, string>();
let cardFieldErrors = new Map<string, string>();
let commentFieldError = "";
let projectStatus: StatusMessage | null = null;
let cardStatus: StatusMessage | null = null;
let confirmation: ConfirmationMessage | null = null;
let confirmationTimer: number | null = null;
let cardConflict: CardConflict | null = null;
let moveConflict: MoveConflict | null = null;
let movePanelOpen = false;
let moveDestinationId = "";
let cardReturnFocus: FocusTarget | null = null;
let projectEditorReturnFocus: FocusTarget | null = null;
let addColumnReturnFocus: FocusTarget | null = null;
let pendingFocusRestore: FocusTarget | null = null;
let pendingFocusId: string | null = null;
let pendingScrollRestore: number | null = null;
let inspectorTab: InspectorTab = "card";
let descriptionView: DescriptionView = "write";
let descriptionSelection: { start: number; end: number; direction: "forward" | "backward" | "none" } | null = null;
let accountPanelOpen = false;
let projectActionsOpen = false;
let sessionEpoch = 0;
let activityFeed: ActivityFeed | null = null;
const recoveryStorage: Storage = {
  get length() { return window.localStorage.length; },
  key: index => window.localStorage.key(index),
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
  clear: () => { throw new Error("Recovery storage must never be cleared in bulk."); }
};
const recoveryStore = new RecoveryStore(recoveryStorage, uniqueKey);
const recoveryMaps: Array<RecoveryMap<any>> = [];
function recoveryMap<T>(kind: string): RecoveryMap<T> { const map = new RecoveryMap<T>(recoveryStore, kind); recoveryMaps.push(map); return map; }
function bindRecovery(): void {
  recoveryStore.bind(session?.ownerId ? JSON.stringify([session.ownerId, window.location.origin, session.workspace?.id || "local"]) : "");
  if (session?.ownerId) for (const map of recoveryMaps) map.load();
}
const projectDrafts = recoveryMap<ProjectEditorDraft>("project");
const pendingPatches = recoveryMap<{ body: Record<string, unknown>; revision: Revision | null; response?: unknown; evidence?: "observed" }>("patch");
let observedWrite = false;
const sessionChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("kanban.cards:session") : null;
sessionChannel?.addEventListener("message", event => { if (event.data === "signed-out") { captureVisibleDrafts(); clearPrivateState({ kind: "session-expired", title: "Your session ended", message: "Sign in again to recover your drafts." }); render(); } });

const retainedDrafts = recoveryMap<CardDraft>("card");
const commentDrafts = recoveryMap<string>("comment");
const displayedAt = new Map<string, string>();
const archiveReceipts = new Map<string, ArchiveReceipt[]>();
const mobileColumns = new Map<string, string>();
const boardScrollPositions = new Map<string, number>();
const projectCardFilters = new Map<string, CardFilters>();
const pendingIdempotencyKeys = recoveryMap<{ fingerprint: string; key: string; response?: unknown }>("post");


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

function ownerName(): string {
  return session?.label.trim() || "Owner";
}

function ownerInitial(): string {
  return Array.from(ownerName())[0]?.toLocaleUpperCase() || "O";
}

function idempotencyKeyFor(scope: string, body: unknown): string {
  const fingerprint = JSON.stringify(body);
  const existing = pendingIdempotencyKeys.get(scope);
  if (existing?.fingerprint === fingerprint) return existing.key;
  if (existing) return existing.key;
  const key = uniqueKey();
  pendingIdempotencyKeys.set(scope, { fingerprint, key });
  return key;
}

function clearIdempotencyKey(scope: string): void {
  // Keep the confirmed response receipt until every preceding local cleanup is durable.
  if (!recoveryStore.failure) pendingIdempotencyKeys.delete(scope);
}
function completePatch(path: string): void {
  if (!recoveryStore.failure) pendingPatches.delete(path);
}

function renderPendingPostAction(scope: string): string {
  const attempt = pendingIdempotencyKeys.get(scope);
  if (!attempt) return "";
  return `<div class="pending-post jk-status" data-kind="warning"><span class="jk-status-marker" aria-hidden="true">!</span><div><strong>${attempt.response ? "Saved submission needs local recovery" : "Previous outcome unconfirmed"}</strong><p>Retry sends the frozen original submission with the same request key. Later edits remain a separate local draft.</p>${renderButton("Retry original submission", "retry-pending-post", { data: `data-idempotency-scope="${escapeHtml(scope)}"` })}</div></div>`;
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

function toRevision(value: unknown, fallback: Revision = 0): Revision {
  return typeof value === "string" || typeof value === "number" ? value : fallback;
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
    title: String(card.title || "Untitled Card"),
    body: String(card.body ?? card.description ?? card.summary ?? ""),
    columnId: String(card.columnId || ""),
    position: Number.isFinite(Number(card.position)) ? Number(card.position) : 0,
    version: toRevision(card.version),
    createdAt: String(card.createdAt || ""),
    updatedAt: String(card.updatedAt || ""),
    archivedAt: card.archivedAt ? String(card.archivedAt) : null,
    comments: arrayValue(card.comments).map(normalizeComment),
    ...normalizeCardFields(card)
  };
}

function normalizeCardFields(value: Record<string, any>): CardFields {
  return {
    nextActor: value.nextActor === "human" || value.nextActor === "agent" ? value.nextActor : null,
    nextAction: String(value.nextAction ?? ""),
    priority: value.priority === "High" || value.priority === "Medium" || value.priority === "Low" ? value.priority : null,
    blockedReason: String(value.blockedReason ?? "")
  };
}

function normalizeActivity(value: unknown): ActivityItem {
  const item = objectValue(value);
  const actor = objectValue(item.actor);
  return {
    id: String(item.id || uniqueKey()),
    projectId: String(item.projectId || ""),
    projectName: String(item.projectName || "Untitled Project"),
    projectArchivedAt: item.projectArchivedAt ? String(item.projectArchivedAt) : null,
    cardTitle: String(item.cardTitle || ""),
    cardId: item.cardId ? String(item.cardId) : null,
    action: String(item.action || item.type || "updated"),
    summary: String(item.summary || item.message || item.action || item.type || "Project updated"),
    actorLabel: actorLabel(item.actor ?? item.actorLabel ?? item.channel),
    channel: String(actor.channel || item.channel || "web").toLowerCase(),
    createdAt: String(item.createdAt || "")
  };
}

function normalizeProjectSummary(value: unknown): ProjectSummary {
  const project = objectValue(value);
  const cards = arrayValue(project.cards).map(normalizeCard).filter((card) => !card.archivedAt);
  return {
    id: String(project.id || ""),
    name: String(project.name || "Untitled Project"),
    description: String(project.description || ""),
    revision: toRevision(project.revision),
    updatedAt: String(project.updatedAt || ""),
    cardCount: Number.isFinite(Number(project.cardCount)) ? Number(project.cardCount) : cards.length
  };
}

function normalizeProject(value: unknown): Project {
  const project = unwrapRecord(value, "project");
  return {
    ...normalizeProjectSummary(project),
    columns: arrayValue(project.columns).map((value, index) => {
      const column = objectValue(value);
      return {
        id: String(column.id || ""),
        name: String(column.name ?? column.title ?? `Column ${index + 1}`),
        position: Number.isFinite(Number(column.position)) ? Number(column.position) : index
      };
    }).sort((left, right) => left.position - right.position),
    cards: arrayValue(project.cards).map(normalizeCard),
    activity: arrayValue(project.activity).map(normalizeActivity),
    archivedAt: project.archivedAt ? String(project.archivedAt) : null
  };
}

function normalizeSession(value: unknown): SessionEnvelope {
  const result = objectValue(value);
  const context: AccessContext = result.context === "auth" || result.context === "root" || result.context === "workspace" ? result.context : "local";
  const nextRootUrl = safeOrigin(result.rootUrl) || (context === "local" ? window.location.origin : "");
  const nextLoginUrl = safeAccessUrl(result.loginUrl, "/sign-in") || "";
  const intent = objectValue(result.authIntent);
  const modes: PasskeyMode[] = ["signup", "signin", "setup", "recover", "add", "verify"];
  const nextIntent = context === "auth" && modes.includes(intent.mode as PasskeyMode) && safeOrigin(intent.rootOrigin) === nextRootUrl
    ? { mode: intent.mode as PasskeyMode, rootOrigin: nextRootUrl, ...(typeof intent.action === "string" ? { action: intent.action } : {}) }
    : null;
  const source = objectValue(result.session ?? result.user ?? result.actor ?? result);
  const authenticated = result.authenticated !== false && (result.authenticated === true || Boolean(source.label || source.name || source.email));
  const workspaceSource = objectValue(result.workspace ?? source.workspace);
  const workspace = workspaceSource.id && workspaceSource.slug ? normalizeWorkspaceAccess(workspaceSource) : undefined;
  return {
    authenticated, context, rootUrl: nextRootUrl, loginUrl: nextLoginUrl,
    authIntent: nextIntent, setupAvailable: result.setupAvailable === true,
    session: authenticated ? {
      authenticated: true,
      ownerId: typeof result.ownerId === "string" ? result.ownerId : "",
      label: String(source.label || source.displayName || source.name || source.email || "Owner"), context,
      ...(source.email ? { email: String(source.email) } : {}), ...(workspace ? { workspace } : {})
    } : null
  };
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\\")) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeAccessUrl(value: unknown, path: string, expectedOrigin?: string): string | null {
  if (typeof value !== "string" || value !== value.trim() || value.includes("\\")) return null;
  try {
    const parsed = new URL(value);
    if (!safeOrigin(parsed.origin) || (expectedOrigin && parsed.origin !== expectedOrigin)) return null;
    if (parsed.pathname !== path || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString();
  } catch { return null; }
}

function submitAuthForm(destination: string, fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = destination;
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  try { form.submit(); } finally { form.remove(); }
}

async function beginPasskeyFlow(mode: PasskeyMode, action?: string): Promise<void> {
  if (accessContext === "workspace") {
    if (!session) { if (rootUrl) window.location.assign(rootUrl); return; }
    if (action === "api-key") window.sessionStorage.setItem("kanban.cards:open-agents", "1");
    const destination = new URL("/", rootUrl);
    destination.searchParams.set("access", mode);
    if (action) destination.searchParams.set("action", action);
    window.location.assign(destination.toString());
    return;
  }
  if (accessContext === "auth") {
    if (rootUrl) {
      const destination = new URL("/", rootUrl);
      if (mode === "recover") destination.searchParams.set("access", "recover");
      if (authIntent?.mode === "add" || authIntent?.mode === "verify" && authIntent.action === "access-settings") destination.searchParams.set("cancel-access", "1");
      window.location.assign(destination.toString());
    }
    return;
  }
  if (mode === "add" || action === "access-settings") window.sessionStorage.setItem("kanban.cards:open-access", "1");
  setWorkspaceMutationsDisabled(true, "sign-in");
  authNotice = null;
  render();
  try {
    const payload = objectValue(await api("/auth-start", { method: "POST", body: { mode, ...(action ? { action } : {}) } }));
    const expectedOrigin = loginUrl ? new URL(loginUrl).origin : "";
    const destination = expectedOrigin && safeAccessUrl(payload.destination, "/api/passkeys/start", expectedOrigin);
    if (!destination || safeOrigin(payload.rootOrigin) !== rootUrl || typeof payload.intentToken !== "string" || !payload.intentToken || typeof payload.browserNonce !== "string" || !payload.browserNonce) throw new Error("Sign-in could not start. Try again.");
    submitAuthForm(destination, { intentToken: payload.intentToken, browserNonce: payload.browserNonce, rootOrigin: rootUrl });
  } catch (error) {
    setWorkspaceMutationsDisabled(false);
    if (mode === "add" && error instanceof ApiError && error.status === 403) {
      window.sessionStorage.setItem("kanban.cards:add-passkey-after-verify", "1");
      await beginPasskeyFlow("verify", "access-settings");
      return;
    }
    authNotice = { kind: "service-unavailable", title: "Sign-in could not start", message: error instanceof Error ? error.message : "Try again." };
    accessStatus = { tone: "error", title: "Verification could not start", message: authNotice.message };
    render();
  }
}

async function performPasskeyCeremony(form: HTMLFormElement): Promise<void> {
  if (!authIntent) return;
  const data = new FormData(form);
  passkeyDraft = { workspaceName: cleanValue(String(data.get("workspaceName") || "")), workspaceSlug: cleanValue(String(data.get("workspaceSlug") || "")).toLowerCase(), displayName: cleanValue(String(data.get("displayName") || "")) };
  const body = { ...passkeyDraft, mode: authIntent.mode, setupToken: String(data.get("setupToken") || ""), recoveryCode: String(data.get("recoveryCode") || "") };
  form.reset();
  authNotice = null;
  setWorkspaceMutationsDisabled(true, "sign-in");
  render();
  try {
    const payload = objectValue(await api("/passkeys/options", { method: "POST", body }));
    const response = payload.ceremony === "registration"
      ? await startRegistration({ optionsJSON: payload.options as PublicKeyCredentialCreationOptionsJSON })
      : await startAuthentication({ optionsJSON: payload.options as PublicKeyCredentialRequestOptionsJSON });
    const verified = objectValue(await api("/passkeys/verify", { method: "POST", body: { challengeId: payload.challengeId, response } }));
    const destination = safeAccessUrl(verified.destination, "/api/auth-handoff", authIntent.rootOrigin);
    if (verified.authenticated !== true || !destination || typeof verified.handoffToken !== "string" || !verified.handoffToken) throw new Error("Passkey access could not be completed. Try again.");
    pendingAuthHandoff = { destination, token: verified.handoffToken };
    passkeyDraft = { workspaceName: "", workspaceSlug: "", displayName: "" };
    if (typeof verified.recoveryCode === "string" && verified.recoveryCode) {
      recoveryCode = verified.recoveryCode;
      pendingFocusId = "recovery-title";
    } else {
      submitAuthForm(destination, { handoffToken: verified.handoffToken });
    }
  } catch (error) {
    const cancelled = error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
    authNotice = { kind: "service-unavailable", title: cancelled ? "Passkey request cancelled" : "Passkey access did not complete", message: cancelled ? "Try again when you’re ready." : error instanceof Error ? error.message : "Try again." };
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

function renderRecoveryCode(): string {
  return `<section class="access-card jk-panel" aria-labelledby="recovery-title">${renderProductName()}<h1 id="recovery-title" tabindex="-1">Save your recovery code</h1><p>Use this code if you lose your passkeys. Store it somewhere private, such as your password manager. It is shown once.</p><code class="recovery-code" id="recovery-code">${escapeHtml(recoveryCode)}</code><div class="jk-actions">${renderButton("Copy code", "copy-recovery-code")}${renderButton("Download code", "download-recovery-code")}</div>${renderButton("I saved my recovery code", "continue-after-recovery", { priority: "primary" })}</section>`;
}

function safeWorkspaceHandoffUrl(value: unknown, workspaceUrl: string): string | null {
  const expectedOrigin = safeOrigin(workspaceUrl);
  if (!expectedOrigin || typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\\")) return null;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== expectedOrigin || parsed.pathname !== "/api/workspace-handoff") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalizeWorkspaceAccess(value: unknown): WorkspaceAccess {
  const workspace = objectValue(value);
  return {
    id: String(workspace.id || ""),
    slug: String(workspace.slug || ""),
    name: String(workspace.name || "Workspace"),
    url: safeOrigin(workspace.url) || ""
  };
}

function patchIntentKind(body: Record<string, unknown>): string {
  if ("columnId" in body) return "placement";
  if ("archivedAt" in body) return body.archivedAt === null ? "restore" : "archive";
  if ("title" in body || "nextActor" in body || "blockedReason" in body) return "card-text";
  return `project:${Object.keys(body).sort().join(",")}`;
}

async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const epoch = sessionEpoch;
  const mutation = options.method && options.method !== "GET" && path !== "/session";
  if (mutation && session) {
    if (!recoveryStore.retry()) throw new Error(recoveryStore.failure);
    const verified = normalizeSession(await api("/session"));
    if (!verified.session?.ownerId || verified.session.ownerId !== session.ownerId) throw new ApiError(401, "The signed-in owner changed. Sign in again to recover your drafts.");
  }
  if (epoch !== sessionEpoch) throw new ApiError(401, "The session changed before this request started.");
  let postEntry: [string, { fingerprint: string; key: string; response?: unknown }] | undefined;
  if (options.idempotencyKey) {
    if (recoveryStore.failure) throw new Error(recoveryStore.failure);
    postEntry = [...pendingIdempotencyKeys].find(([, attempt]) => attempt.key === options.idempotencyKey);
    if (postEntry) {
      if (postEntry[1].response) return postEntry[1].response as T;
      options = { ...options, body: JSON.parse(postEntry[1].fingerprint) };
    }
  }
  if (options.method === "PATCH") {
    observedWrite = false;
    const previous = pendingPatches.get(path);
    if (previous) {
      const requested = objectValue(options.body);
      if (patchIntentKind(requested) !== patchIntentKind(previous.body) || (patchIntentKind(requested) === "placement" && requested.columnId !== previous.body.columnId)) throw new LocalActionBlockedError("An earlier different change has an unconfirmed outcome. Read back the original change before choosing another action.");
      if (previous.response) { observedWrite = previous.evidence === "observed"; return previous.response as T; }
      const projectPath = path.match(/^\/projects\/[^/]+/)?.[0];
      if (!projectPath) throw new Error("Refresh the original resource before retrying this change.");
      const payload = objectValue(await api(projectPath));
      const project = normalizeProject(payload);
      const cardId = path.match(/\/cards\/([^/]+)$/)?.[1];
      const latest = cardId ? project.cards.find(card => card.id === decodeURIComponent(cardId)) : project;
      if (!latest) throw new Error("The resource is unavailable. Your draft and original submission are retained.");
      const matches = Object.entries(previous.body).every(([field, value]) => JSON.stringify(objectValue(latest)[field]) === JSON.stringify(value));
      if (matches) {
        observedWrite = true;
        const observed = cardId ? { card: latest, projectRevision: project.revision } : { project };
        pendingPatches.set(path, { ...previous, response: observed, evidence: "observed" });
        return observed as T;
      }
      if (previous.response) throw new Error("The earlier write was confirmed and later changed. Refresh and review before saving again.");
      pendingPatches.delete(path);
      if (String(cardId ? (latest as ProjectCard).version : project.revision) !== String(previous.revision)) throw new ApiError(409, "The latest saved state differs from the unconfirmed submission. Review the draft before retrying.");
      options = { ...options, body: previous.body, revision: previous.revision };
    }
    pendingPatches.set(path, { body: objectValue(options.body), revision: options.revision ?? null });
    if (recoveryStore.failure) throw new Error(recoveryStore.failure);
  }
  const headers = new Headers({ Accept: "application/json" });
  if (options.method && options.method !== "GET" && (options.expectedOwnerId || session?.ownerId)) headers.set("X-Kanban-Expected-Owner", options.expectedOwnerId || session!.ownerId);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.revision !== undefined && options.revision !== null) {
    headers.set("X-Kanban-Version", String(options.revision));
  }
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

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

  if (epoch !== sessionEpoch) throw new ApiError(401, "The session changed while the request was in progress. Its recovery record is retained.");
  if (!response.ok) {
    if (response.status < 500 && response.status !== 401 && response.status !== 408) {
      if (options.method === "PATCH") pendingPatches.delete(path);
    }
    const record = objectValue(payload);
    const text = typeof payload === "string" && !payload.trimStart().startsWith("<") ? payload.slice(0, 240) : "";
    throw new ApiError(response.status, String(record.error || record.message || text || `Request failed (${response.status})`));
  }
  if (options.method === "PATCH") pendingPatches.set(path, { body: objectValue(options.body), revision: options.revision ?? null, response: payload });
  if (postEntry) pendingIdempotencyKeys.set(postEntry[0], { ...postEntry[1], response: payload });
  return payload as T;
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

function formatRecency(value: string): string {
  if (!value) return "Updated just now";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return `Updated ${value}`;
  const elapsed = Math.max(0, Date.now() - date.valueOf());
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) return `Updated ${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
  if (new Date().toDateString() === date.toDateString()) return "Updated today";
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
}

function bodySummary(value: string): string {
  const compact = renderCardMarkdown(value).text;
  if (compact.length <= 116) return compact;
  return `${compact.slice(0, 113).trimEnd()}…`;
}

function activeCards(project: Project): ProjectCard[] {
  return project.cards.filter((card) => !card.archivedAt);
}

function cardFilters(project: Project): CardFilters {
  return projectCardFilters.get(project.id) || { nextActor: "all", priority: "all", blocked: "all" };
}

function hasCardFilters(project: Project): boolean {
  const filters = cardFilters(project);
  return filters.nextActor !== "all" || filters.priority !== "all" || filters.blocked !== "all";
}

function cardMatchesFilters(card: ProjectCard, project: Project): boolean {
  const filters = cardFilters(project);
  return (filters.nextActor === "all" || (filters.nextActor === "unassigned" ? card.nextActor === null : card.nextActor === filters.nextActor))
    && (filters.priority === "all" || (filters.priority === "unset" ? card.priority === null : card.priority === filters.priority))
    && (filters.blocked === "all" || (filters.blocked === "blocked" ? Boolean(card.blockedReason.trim()) : !card.blockedReason.trim()));
}

function visibleCards(project: Project): ProjectCard[] {
  return activeCards(project).filter((card) => cardMatchesFilters(card, project));
}

function renderCardFilters(project: Project): string {
  const filters = cardFilters(project);
  const filterField = (id: string, label: string, value: string, choices: Array<{ value: string; label: string }>): string => renderField({
    id: `board-filter-${id}`,
    label,
    control: renderSelect({ id: `board-filter-${id}`, name: id, value, choices, ariaLabel: `Filter by ${label.toLowerCase()}`, disabled: workspaceLocked() })
  });
  return `<section class="card-filters" aria-label="Filter Cards"><div class="card-filter-controls">${filterField("next-actor", "Next actor", filters.nextActor, [{ value: "all", label: "All" }, { value: "human", label: "You" }, { value: "agent", label: "Agent" }, { value: "unassigned", label: "Unassigned" }])}${filterField("priority", "Priority", filters.priority, [{ value: "all", label: "All" }, { value: "High", label: "High" }, { value: "Medium", label: "Medium" }, { value: "Low", label: "Low" }, { value: "unset", label: "Unset" }])}${filterField("blocked", "Blocked", filters.blocked, [{ value: "all", label: "All" }, { value: "blocked", label: "Blocked" }, { value: "unblocked", label: "Unblocked" }])}${hasCardFilters(project) ? renderButton("Clear filters", "clear-card-filters", { disabled: workspaceLocked() }) : ""}</div><p class="card-filter-count jk-meta" role="status" aria-live="polite" aria-atomic="true">Showing ${visibleCards(project).length} of ${activeCards(project).length} Cards</p></section>`;
}

function syncProjectSummary(project: Project): void {
  const summary: ProjectSummary = {
    id: project.id,
    name: project.name,
    description: project.description,
    revision: project.revision,
    updatedAt: project.updatedAt,
    cardCount: activeCards(project).length
  };
  const index = projects.findIndex((candidate) => candidate.id === project.id);
  if (index >= 0) projects[index] = summary;
  else projects.push(summary);
}

function applyProjectSnapshot(project: Project): void {
  syncProjectSummary(project);
  reconcileProjectContext(project);
}

function applyCardMutationResponse(projectId: string, payload: unknown): ProjectCard {
  const project = activeProject;
  if (!project || project.id !== projectId) throw new Error("The changed Card does not belong to the displayed Project.");
  const record = objectValue(payload);
  const card = normalizeCard(unwrapRecord(record, "card"));
  const index = project.cards.findIndex((candidate) => candidate.id === card.id);
  if (index >= 0) project.cards[index] = card;
  else project.cards.push(card);
  project.revision = toRevision(record.projectRevision, project.revision);
  project.updatedAt = card.updatedAt || new Date().toISOString();
  syncProjectSummary(project);
  return card;
}

function recordBrowserActivity(project: Project, summary: string, cardId: string): void {
  project.activity.push({
    id: uniqueKey(),
    projectId: project.id,
    projectName: project.name,
    projectArchivedAt: project.archivedAt,
    cardTitle: project.cards.find((card) => card.id === cardId)?.title || "",
    cardId,
    action: "browser.local",
    summary,
    actorLabel: session?.label || "Owner",
    channel: "web",
    createdAt: new Date().toISOString()
  });
}

async function refreshCommittedProject(projectId: string): Promise<string | null> {
  try {
    await refreshAfterMutation(projectId);
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearPrivateState({ kind: "session-expired", title: "Change saved; session ended", message: "The write committed before the browser session ended. Private Project and Card data left the screen." });
      pendingFocusId = "owner-key";
      render();
      return "session-ended";
    }
    return error instanceof Error ? error.message : "The latest Project could not be reloaded.";
  }
}

function outcomeIsUnconfirmed(error: unknown): boolean {
  return !(error instanceof LocalActionBlockedError) && (!(error instanceof ApiError) || error.status === 408 || error.status >= 500);
}

function workspaceLocked(): boolean {
  return mutationInFlight || projectEditorMode !== null || addColumnPreparing || addColumnCommitted || addColumnDraft !== null;
}

function resetMoveContext(): void {
  moveConflict = null;
  movePanelOpen = false;
  moveDestinationId = "";
}

function resetDescriptionContext(): void {
  descriptionView = "write";
  descriptionSelection = null;
}

function captureDescriptionSelection(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>("#card-body-input");
  if (!textarea) return;
  descriptionSelection = {
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection || "none"
  };
}

function restoreDescriptionSelection(): void {
  if (descriptionView !== "write" || !descriptionSelection) return;
  const textarea = document.querySelector<HTMLTextAreaElement>("#card-body-input");
  if (!textarea) return;
  const end = textarea.value.length;
  textarea.setSelectionRange(
    Math.min(descriptionSelection.start, end),
    Math.min(descriptionSelection.end, end),
    descriptionSelection.direction
  );
}

function setWorkspaceMutationsDisabled(disabled: boolean, kind: MutationKind = null): void {
  if (disabled) clearConfirmation();
  mutationInFlight = disabled;
  mutationKind = disabled ? kind : null;
}

function disabledAttribute(disabled = false): string {
  return mutationInFlight || disabled ? " disabled" : "";
}

function renderTextInput(options: TextControlOptions & {
  type?: "text" | "password" | "datetime-local";
  autocomplete?: string;
  className?: string;
}): string {
  return `<input class="form-control${options.className ? ` ${escapeHtml(options.className)}` : ""}" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}" type="${options.type || "text"}" value="${escapeHtml(options.value || "")}"${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ""}${options.autocomplete ? ` autocomplete="${escapeHtml(options.autocomplete)}"` : ""}${options.required ? " required" : ""}${options.autofocus ? " autofocus" : ""}${options.ariaDescribedBy ? ` aria-describedby="${escapeHtml(options.ariaDescribedBy)}"` : ""}${options.ariaErrorMessage ? ` aria-errormessage="${escapeHtml(options.ariaErrorMessage)}"` : ""}${options.invalid ? ' aria-invalid="true"' : ""}${disabledAttribute(Boolean(options.disabled))}>`;
}

function renderTextArea(options: TextControlOptions & { rows?: number; ariaLabel?: string; className?: string }): string {
  return `<textarea class="form-control textarea-control${options.className ? ` ${escapeHtml(options.className)}` : ""}" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}" rows="${options.rows || 4}"${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ""}${options.required ? " required" : ""}${options.ariaLabel ? ` aria-label="${escapeHtml(options.ariaLabel)}"` : ""}${options.ariaDescribedBy ? ` aria-describedby="${escapeHtml(options.ariaDescribedBy)}"` : ""}${options.ariaErrorMessage ? ` aria-errormessage="${escapeHtml(options.ariaErrorMessage)}"` : ""}${options.invalid ? ' aria-invalid="true"' : ""}${disabledAttribute(Boolean(options.disabled))}>${escapeHtml(options.value || "")}</textarea>`;
}

function renderSelect(options: TextControlOptions & {
  choices: Array<{ value: string; label: string }>;
  ariaLabel?: string;
  className?: string;
}): string {
  return `<select class="form-control select-control${options.className ? ` ${escapeHtml(options.className)}` : ""}" id="${escapeHtml(options.id)}" name="${escapeHtml(options.name)}"${options.ariaLabel ? ` aria-label="${escapeHtml(options.ariaLabel)}"` : ""}${options.ariaDescribedBy ? ` aria-describedby="${escapeHtml(options.ariaDescribedBy)}"` : ""}${options.ariaErrorMessage ? ` aria-errormessage="${escapeHtml(options.ariaErrorMessage)}"` : ""}${options.invalid ? ' aria-invalid="true"' : ""}${disabledAttribute(Boolean(options.disabled))}>${options.choices.map((choice) => `<option value="${escapeHtml(choice.value)}"${choice.value === options.value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select>`;
}

function renderField(options: {
  id: string;
  label: string;
  control: string;
  hint?: string;
  error?: string;
  errorId?: string;
  className?: string;
}): string {
  return `<div class="jk-field${options.className ? ` ${escapeHtml(options.className)}` : ""}"><label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>${options.control}${options.error ? `<p class="jk-error" id="${escapeHtml(options.errorId || `${options.id}-error`)}">${escapeHtml(options.error)}</p>` : options.hint ? `<p class="jk-help">${escapeHtml(options.hint)}</p>` : ""}</div>`;
}

function renderButton(
  label: string,
  action: string,
  options: { priority?: "primary" | "risk"; className?: string; disabled?: boolean; data?: string } = {}
): string {
  return `<button class="${escapeHtml(options.className || "jk-button")}" type="button" data-action="${escapeHtml(action)}"${options.priority ? ` data-priority="${options.priority}"` : ""}${options.data ? ` ${options.data}` : ""}${disabledAttribute(Boolean(options.disabled))}>${escapeHtml(label)}</button>`;
}

function renderStatus(message: StatusMessage | null, id: string): string {
  if (!message) return `<div id="${escapeHtml(id)}" class="status-slot" role="status" aria-live="polite" aria-atomic="true"></div>`;
  const marker = message.tone === "error" || message.tone === "warning" ? "!" : message.tone === "neutral" ? "…" : "✓";
  const detail = message.message ? `<p>${escapeHtml(message.message)}</p>` : "";
  return `<div id="${escapeHtml(id)}" class="jk-status" data-kind="${escapeHtml(message.tone)}" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"><span class="jk-status-marker" aria-hidden="true">${marker}</span><div><strong>${escapeHtml(message.title)}</strong>${detail}</div></div>`;
}

function clearConfirmation(): void {
  if (confirmationTimer !== null) {
    window.clearTimeout(confirmationTimer);
    confirmationTimer = null;
  }
  confirmation = null;
  document.querySelector<HTMLElement>("#toast-region")?.replaceChildren();
}

function showConfirmation(title: string, message: string, uiState?: ConfirmationMessage["uiState"]): void {
  clearConfirmation();
  confirmation = { title, message, ...(uiState ? { uiState } : {}) };
  const region = document.querySelector<HTMLElement>("#toast-region");
  if (region) {
    const toast = document.createElement("div");
    toast.className = "toast jk-status";
    toast.dataset.kind = "receipt";
    const marker = document.createElement("span");
    marker.className = "jk-status-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "✓";
    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("p");
    detail.textContent = message;
    content.append(heading, detail);
    toast.append(marker, content);
    region.replaceChildren(toast);
  }
  document.body.dataset.state = currentUiState();
  confirmationTimer = window.setTimeout(() => {
    confirmationTimer = null;
    confirmation = null;
    region?.replaceChildren();
    document.body.dataset.state = currentUiState();
  }, CONFIRMATION_DURATION_MS);
}

function renderLoading(): string {
  return `<main class="centered-view">${renderProductName("strong")}<p class="quiet" role="status">Opening your workspace…</p></main>`;
}

function renderSignOutProgress(): string {
  return `<main class="centered-view">${renderProductName("strong")}<p class="quiet" role="status">Finishing sign out…</p></main>`;
}

function renderSignIn(): string {
  const notice = authNotice
    ? renderStatus({
        tone: authNotice.kind === "signed-out" ? "success" : "error",
        title: authNotice.title,
        message: authNotice.message
      }, "access-status")
    : "";
  const errorId = authNotice?.kind === "invalid-key" ? "access-status" : undefined;
  if (accessContext !== "local") {
    if (accessContext === "auth") {
      if (recoveryCode) return `<main class="access-view">${renderRecoveryCode()}</main>`;
      if (!authIntent) return `<main class="access-view"><section class="access-card jk-panel">${renderProductName()}<h1>Open kanban.cards to continue</h1><p>Return to kanban.cards to create a Workspace or sign in.</p>${renderButton("Continue", "passkey-sign-in", { priority: "primary", disabled: !rootUrl })}</section></main>`;
      const mode = authIntent.mode;
      const heading = mode === "signup" ? "Create your Workspace" : mode === "setup" ? "Set up your passkey" : mode === "recover" ? "Recover your account" : mode === "add" ? "Add a passkey" : mode === "verify" ? "Verify your identity" : "Sign in";
      const workspaceFields = mode === "signup" ? renderField({ id: "signup-workspace-name", label: "Workspace name", control: renderTextInput({ id: "signup-workspace-name", name: "workspaceName", value: passkeyDraft.workspaceName, required: true, autofocus: true }) }) + renderField({ id: "signup-workspace-slug", label: "Workspace address", control: renderTextInput({ id: "signup-workspace-slug", name: "workspaceSlug", value: passkeyDraft.workspaceSlug, required: true, placeholder: "your-workspace" }), hint: "Lowercase letters, numbers, and hyphens." }) + renderField({ id: "signup-display-name", label: "Your name (optional)", control: renderTextInput({ id: "signup-display-name", name: "displayName", value: passkeyDraft.displayName, autocomplete: "name" }) }) : "";
      const secretField = mode === "setup" || mode === "recover" ? renderField({ id: "passkey-access-code", label: mode === "setup" ? "Setup token" : "Recovery code", control: renderTextInput({ id: "passkey-access-code", name: mode === "setup" ? "setupToken" : "recoveryCode", type: "password", autocomplete: "off", required: true, autofocus: true }) }) : "";
      const { instruction, submitLabel } = passkeyFormCopy(mode);
      const recoveryAction = mode === "signin" ? renderButton("Recover access", "start-recovery", { className: "jk-button website-tertiary-action", disabled: !rootUrl }) : "";
      return `<main class="access-view"><section class="access-card jk-panel" aria-labelledby="access-title">${renderProductName()}<h1 id="access-title">${heading}</h1><p>${instruction}</p>${notice}<form data-form="passkey" class="access-form">${workspaceFields}${secretField}<button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationInFlight ? "Waiting for your passkey…" : submitLabel}</button></form>${renderButton("Back", "passkey-sign-in")}${recoveryAction}</section></main>`;
    }
    if (accessContext === "root") {
      if (authNotice?.kind === "signed-out") return `<main class="access-view"><section class="access-card jk-panel" aria-labelledby="access-title">${renderProductName()}<h1 id="access-title">Signed out</h1>${renderButton("Continue", "signed-out-continue", { priority: "primary" })}</section></main>`;
      return renderPublicHomepage(renderButton("Create account", "start-signup", { priority: "primary", disabled: !loginUrl }) + renderButton("Sign in", "passkey-sign-in", { disabled: !loginUrl }), notice);
    }
    return `<main class="access-view"><section class="access-card jk-panel">${renderProductName()}<h1>Sign in</h1>${notice}${renderButton("Continue", "passkey-sign-in", { priority: "primary", disabled: !rootUrl })}${authNotice?.kind === "sign-out-incomplete" ? renderButton("Retry sign out", "retry-global-sign-out") : ""}</section></main>`;
  }
  return `<main class="access-view"><section class="access-card jk-panel" aria-labelledby="access-title">${renderProductName()}<div><p class="eyebrow">Local workspace</p><h1 id="access-title">Open your workspace</h1><p class="access-description">Use the local owner key to open this development workspace.</p></div>${notice}<form data-form="sign-in" class="access-form" novalidate>${renderField({
    id: "owner-key",
    label: "Owner key",
    control: renderTextInput({
      id: "owner-key",
      name: "token",
      type: "password",
      autocomplete: "current-password",
      required: true,
      autofocus: true,
      ariaDescribedBy: errorId || "owner-key-help",
      invalid: Boolean(errorId)
    }),
    hint: "The key is exchanged for an expiring browser session."
  })}<p id="owner-key-help" class="jk-help">The key is never stored in the browser.</p><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationKind === "sign-in" ? "Opening…" : "Open workspace"}</button></form></section></main>`;
}

function renderWorkspaceForm(): string {
  if (createdWorkspace) {
    return `<div><h1 id="workspace-route-title" tabindex="-1">Workspace created</h1><p>${escapeHtml(createdWorkspace.name)} is ready.</p></div>${renderButton("Open Workspace", "open-workspace", { priority: "primary", data: `data-workspace-slug="${escapeHtml(createdWorkspace.slug)}"` })}`;
  }
  const addressHost = new URL(rootUrl).host;
  return `<div><p class="eyebrow">${workspaceChoices.length ? "New Workspace" : "Your first Workspace"}</p><h1 id="workspace-route-title" tabindex="-1">Create a Workspace</h1><p class="access-description">Give this private work surface a name and address.</p></div><form data-form="workspace" class="access-form" novalidate>${renderField({
    id: "workspace-name", label: "Workspace name",
    control: renderTextInput({ id: "workspace-name", name: "name", value: workspaceDraft.name, required: true, autofocus: true })
  })}${renderField({
    id: "workspace-slug", label: "Workspace address",
    control: renderTextInput({ id: "workspace-slug", name: "slug", value: workspaceDraft.slug, required: true, placeholder: "example" }),
    hint: `Your address will be example.${addressHost}. Use lowercase letters, numbers, and hyphens.`
  })}<div class="jk-actions"><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationKind === "workspace" ? "Creating…" : "Create Workspace"}</button>${workspaceChoices.length ? renderButton("Cancel", "cancel-workspace") : ""}</div></form>`;
}

function renderWorkspaceRoute(): string {
  const failure = renderStatus(accessFailure ? { tone: "error", ...accessFailure } : null, "workspace-route-status");
  const choices = workspaceChoices.map((workspace) => `<li class="workspace-choice"><div><strong>${escapeHtml(workspace.name)}</strong><p class="quiet">${escapeHtml(workspace.slug)}</p></div>${renderButton("Open", "open-workspace", {
    disabled: mutationInFlight, data: `data-workspace-slug="${escapeHtml(workspace.slug)}"`
  })}</li>`).join("");
  const chooser = workspaceCreationOpen || !choices
    ? renderWorkspaceForm()
    : `<div><p class="eyebrow">Your Workspaces</p><h1 id="workspace-route-title" tabindex="-1">Choose a Workspace</h1><p class="access-description">Each Workspace has its own private address and stored Projects.</p></div><ul class="workspace-choices">${choices}</ul><div class="workspace-create-action">${renderButton("New Workspace…", "new-workspace")}</div>`;
  return `<main class="access-view"><section class="access-card workspace-route-card jk-panel" aria-labelledby="workspace-route-title">${renderProductName()}${chooser}${failure}<div class="workspace-route-footer"><span>${escapeHtml(ownerName())}</span>${renderButton("Manage access", "manage-access")}${renderButton("Sign out", "sign-out")}</div></section></main>`;
}

function renderWorkspaceSwitcher(): string {
  const workspace = session?.workspace;
  if (accessContext !== "workspace" || !workspace) return renderButton("Workspace Activity", "show-workspace-activity", { disabled: workspaceLocked() });
  const locked = workspaceLocked();
  return `<div class="header-workspace-switcher"><button id="workspace-switcher-trigger" class="jk-button workspace-switcher-trigger" type="button" data-action="toggle-workspace-menu" aria-label="Workspace: ${escapeHtml(workspace.name)}" aria-expanded="${workspaceMenuOpen}" aria-controls="workspace-switcher-panel"${disabledAttribute(locked)}><span>${escapeHtml(workspace.name)}</span><span aria-hidden="true">⌄</span></button>${workspaceMenuOpen ? `<section id="workspace-switcher-panel" class="menu-panel workspace-switcher-panel" aria-labelledby="workspace-switcher-trigger"><p class="workspace-current"><span aria-hidden="true">✓ </span>${escapeHtml(workspace.name)}<span class="jk-visually-hidden">, current Workspace</span></p>${renderButton("Workspace Activity", "show-workspace-activity", { disabled: locked })}${renderButton("Switch Workspace…", "choose-workspace", { disabled: locked })}<hr>${renderButton("New Workspace…", "new-workspace", { disabled: locked })}</section>` : ""}</div>`;
}

function renderHeader(): string {
  const name = ownerName();
  const editingProject = projectEditorMode !== null || addColumnPreparing || addColumnCommitted || addColumnDraft !== null;
  return `<header class="app-header"><div class="header-primary">${renderProductName("span")}${renderWorkspaceSwitcher()}${renderProjectContext()}</div><div class="profile-menu"><button class="avatar-button" type="button" data-action="toggle-account-panel" aria-label="${accountPanelOpen ? "Close" : "Open"} account panel" aria-expanded="${accountPanelOpen ? "true" : "false"}" aria-controls="account-panel"${disabledAttribute(editingProject)}><span aria-hidden="true">${escapeHtml(ownerInitial())}</span></button>${accountPanelOpen ? `<section id="account-panel" class="menu-panel account-panel" aria-labelledby="account-name"><strong id="account-name">${escapeHtml(name)}</strong>${accessContext === "workspace" ? renderButton("Agent connections", "manage-agents", { disabled: editingProject }) : ""}${accessContext !== "local" ? renderButton("Manage access", "manage-access", { disabled: editingProject }) : ""}${renderButton("Sign out", "sign-out", { disabled: editingProject })}</section>` : ""}</div></header>`;
}

function renderAccessSettings(): string {
  const passkeys = accessSettings?.passkeys.map((key) => `<li><strong>Passkey</strong><p class="quiet">Added ${escapeHtml(formatDate(key.createdAt))}${key.lastUsedAt ? ` · Last used ${escapeHtml(formatDate(key.lastUsedAt))}` : ""}</p>${renderButton("Remove passkey", "remove-passkey", { disabled: (accessSettings?.passkeys.length || 0) < 2, data: `data-passkey-id="${escapeHtml(key.id)}"` })}</li>`).join("") || "<li>No passkeys found.</li>";
  const sessions = accessSettings?.sessions.map((item) => `<li><strong>${item.current ? "This browser" : "Browser session"}</strong><p class="quiet">Expires ${escapeHtml(formatDate(item.expiresAt))}</p>${item.current ? "" : renderButton("End session", "end-session", { data: `data-session-id="${escapeHtml(item.id)}"` })}</li>`).join("") || "<li>No other browser sessions.</li>";
  return `<main class="access-view">${recoveryCode ? renderRecoveryCode() : `<section class="access-card jk-panel">${renderProductName()}<h1>Manage access</h1>${renderStatus(accessStatus, "access-settings-status")}<h2>Passkeys</h2><ul class="workspace-choices">${passkeys}</ul>${renderButton("Add a passkey", "add-passkey", { priority: "primary" })}<h2>Recovery</h2><p>Replacing your recovery code makes the previous code unusable.</p>${renderButton("Replace recovery code", "replace-recovery-code")}<h2>Browser sessions</h2><ul class="workspace-choices">${sessions}</ul><div class="jk-actions">${renderButton("Sign out everywhere", "sign-out-everywhere")}${renderButton("Back to Workspaces", "close-access")}</div></section>`}</main>`;
}

async function loadAccessSettings(): Promise<void> {
  const payload = objectValue(await api("/access-settings"));
  accessSettings = {
    passkeys: arrayValue(payload.passkeys).map((value) => { const key = objectValue(value); return { id: String(key.id || ""), createdAt: String(key.createdAt || ""), lastUsedAt: key.lastUsedAt ? String(key.lastUsedAt) : null }; }),
    sessions: arrayValue(payload.sessions).map((value) => { const item = objectValue(value); return { id: String(item.id || ""), createdAt: String(item.createdAt || ""), expiresAt: String(item.expiresAt || ""), current: item.current === true }; })
  };
}

async function changeAccessSetting(path: string, method: "POST" | "DELETE"): Promise<void> {
  setWorkspaceMutationsDisabled(true, "sign-in");
  accessStatus = null;
  render();
  try {
    const payload = objectValue(await api(path, { method }));
    if (typeof payload.recoveryCode === "string") recoveryCode = payload.recoveryCode;
    await loadAccessSettings();
  } catch (error) {
    accessStatus = { tone: "error", title: "Access was not changed", message: error instanceof Error ? error.message : "Try again." };
    if (error instanceof ApiError && error.status === 403) { setWorkspaceMutationsDisabled(false); await beginPasskeyFlow("verify", "access-settings"); return; }
  } finally { setWorkspaceMutationsDisabled(false); render(); }
}

function renderAgentConnections(): string {
  if (!agentPanelOpen) return "";
  const credential = issuedAgentCredential ? `<div class="jk-status" data-kind="warning" role="status"><div><strong>Copy this credential now</strong><p>This secret is shown once and cannot be recovered.</p><code id="agent-credential">${escapeHtml(issuedAgentCredential)}</code><div class="jk-actions">${renderButton("Copy credential", "copy-agent-credential", { priority: "primary" })}${renderButton("Clear secret", "clear-agent-credential")}</div></div></div>` : "";
  const rows = agentConnections.map((connection) => `<li><strong>${escapeHtml(connection.label)}</strong><p class="quiet">${escapeHtml(connection.scopes.join(", "))} · ${connection.revokedAt ? "Revoked" : connection.expiresAt ? `Expires ${escapeHtml(formatDate(connection.expiresAt))}` : "No expiry"}</p>${connection.revokedAt ? "" : renderButton("Revoke", "revoke-agent", { data: `data-connection-id="${escapeHtml(connection.id)}"` })}</li>`).join("");
  const labelField = renderField({ id: "agent-label", label: "Label", control: renderTextInput({ id: "agent-label", name: "label", required: true }) });
  const scopeField = renderField({ id: "agent-scopes", label: "Scopes", control: renderSelect({ id: "agent-scopes", name: "scopes", value: "read-write", choices: [{ value: "read", label: "Read only" }, { value: "write", label: "Write only" }, { value: "read-write", label: "Read and write" }] }) });
  const expiryField = renderField({ id: "agent-expires-at", label: "Expires (optional)", control: renderTextInput({ id: "agent-expires-at", name: "expiresAt", type: "datetime-local" }), hint: "Leave blank for no expiry." });
  return `<section class="access-card jk-panel" aria-labelledby="agent-connections-title"><div><p class="eyebrow">${escapeHtml(session?.workspace?.name || "Workspace")}</p><h1 id="agent-connections-title">Agent connections</h1><p>Credentials are bound to this Workspace. Read allows reads; write allows bounded mutations.</p></div>${credential}${agentNeedsVerification ? `<div class="jk-status" data-kind="warning" role="status"><div><strong>Verify your identity to create an API key</strong><p>Confirm with your passkey, then return here.</p>${renderButton("Verify identity", "verify-identity", { priority: "primary" })}</div></div>` : ""}<form data-form="agent-connection" class="access-form">${labelField}${scopeField}${expiryField}<button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationKind === "agent" ? "Creating…" : "Create connection"}</button></form><ul class="workspace-choices">${rows || "<li>No agent connections yet.</li>"}</ul>${renderButton("Back to board", "close-agents")}</section>`;
}

function renderProjectContext(): string {
  const project = activeProject;
  const locked = workspaceLocked();
  const choices = projects.length
    ? projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))
    : [{ value: "", label: "No Projects yet" }];
  const workspaceLabel = accessContext !== "workspace" && !projects.length && session?.workspace?.name
    ? `<span class="header-workspace-label"><span class="jk-visually-hidden">Current Workspace: </span>${escapeHtml(session.workspace.name)}</span>`
    : "";
  return `${workspaceLabel}<div class="header-project-switcher jk-field"><label class="jk-visually-hidden" for="project-select">Project</label>${renderSelect({
    id: "project-select",
    name: "projectId",
    value: project?.id || "",
    choices,
    ariaLabel: "Active Project",
    className: "header-project-select",
    disabled: locked || !projects.length
  })}</div>`;
}

function renderProjectActions(project: Project): string {
  const locked = workspaceLocked();
  const label = projectLoading || mutationKind === "refresh" ? "Refreshing…" : "Refresh";
  return `<div class="project-action-menu"><button id="project-actions-trigger" class="jk-button action-menu-trigger" type="button" data-action="toggle-project-actions" aria-expanded="${projectActionsOpen ? "true" : "false"}" aria-controls="project-actions-panel"${disabledAttribute(locked)}><span>Actions</span><span aria-hidden="true">•••</span></button>${projectActionsOpen ? `<section id="project-actions-panel" class="menu-panel action-panel" aria-labelledby="project-actions-trigger">${renderButton("New Project", "new-project", { disabled: locked })}${renderButton("New Card", "new-card", { disabled: locked, data: `data-column-id="${escapeHtml(newCardColumn(project))}"` })}${renderButton("Edit Project", "edit-project", { disabled: locked })}${renderButton("Project Activity", "show-project-activity", { disabled: locked })}${renderButton(label, "refresh-project", { disabled: locked })}</section>` : ""}</div>`;
}

function currentArchiveReceipt(projectId: string): ArchiveReceipt | null {
  return archiveReceipts.get(projectId)?.at(-1) || null;
}

function recoverableArchivedDrafts(project: Project): Array<{ card: ProjectCard; draft: CardDraft }> {
  return [...retainedDrafts.values()].flatMap((draft) => {
    if (draft.projectId !== project.id || !draft.cardId) return [];
    const card = project.cards.find((candidate) => candidate.id === draft.cardId);
    return card?.archivedAt ? [{ card, draft }] : [];
  });
}

function renderProjectReceipt(): string {
  const project = activeProject;
  const projectId = project?.id || "";
  const archive = projectId ? currentArchiveReceipt(projectId) : null;
  const recoverableDrafts = project ? recoverableArchivedDrafts(project) : [];
  const visibleProjectStatus = addColumnPreparing || addColumnCommitted || addColumnDraft ? null : projectStatus;
  if (!archive && !visibleProjectStatus && !recoverableDrafts.length) return `<div class="project-status-wrap">${renderStatus(null, "project-status")}</div>`;
  const archiveMarkup = archive
    ? `<div class="jk-status" data-kind="receipt" role="status" aria-live="polite"><span class="jk-status-marker" aria-hidden="true">✓</span><div><strong>${escapeHtml(archive.cardTitle)} archived</strong><p>The Card left the active Project. It can be restored.</p>${renderButton("Undo archive", "undo-archive", { disabled: workspaceLocked(), data: `data-receipt-key="${escapeHtml(archive.key)}"` })}</div></div>`
    : "";
  const recoveryMarkup = recoverableDrafts.map(({ card }, index) => {
    const headingId = `draft-recovery-${index}`;
    return `<section class="jk-status draft-recovery" data-kind="warning" aria-labelledby="${headingId}"><span class="jk-status-marker" aria-hidden="true">!</span><div><strong id="${headingId}">${escapeHtml(card.title)} has a retained draft</strong><p>The stored Card is archived. Review the draft to restore it or discard it.</p>${renderButton("Review retained draft", "recover-draft", { disabled: workspaceLocked(), data: `data-card-id="${escapeHtml(card.id)}"` })}</div></section>`;
  }).join("");
  return `<div class="project-status-wrap">${visibleProjectStatus ? renderStatus(visibleProjectStatus, "project-status") : ""}${archiveMarkup}${recoveryMarkup}</div>`;
}

function ordinalLabel(index: number): string {
  return ["First", "Second", "Third"][index] || `Column ${index + 1}`;
}

function renderProjectEditor(): string {
  const draft = projectEditorDraft;
  if (!draft) return "";
  const pendingPost = draft.mode === "create" ? renderPendingPostAction("project:create") : "";
  const columnFields = draft.columns.map((column, index) => {
    const inputId = `project-column-${index}`;
    const error = projectFieldErrors.get(`column-${index}`) || "";
    const errorId = `${inputId}-error`;
    return renderField({
      id: inputId,
      label: ordinalLabel(index),
      control: renderTextInput({
        id: inputId,
        name: `column-${index}`,
        value: column.name,
        required: true,
        invalid: Boolean(error),
        ariaDescribedBy: error ? errorId : undefined,
        ariaErrorMessage: error ? errorId : undefined
      }),
      error,
      errorId
    });
  }).join("");
  const nameError = projectFieldErrors.get("name") || "";
  return `<section id="project-editor" class="project-editor jk-panel" aria-labelledby="project-editor-heading"><div><p class="eyebrow">Project</p><h1 id="project-editor-heading" tabindex="-1">${draft.mode === "edit" ? "Edit Project" : "Create Project"}</h1><p class="jk-muted">${draft.mode === "edit" ? "Update this Project without changing its resource model." : "Name the Project and start with three useful Columns."}</p></div>${renderStatus(projectStatus, "project-editor-status")}${pendingPost}<form class="project-form" data-form="project" novalidate>${renderField({
    id: "project-name-input",
    label: "Name",
    control: renderTextInput({
      id: "project-name-input",
      name: "name",
      value: draft.name,
      required: true,
      invalid: Boolean(nameError),
      ariaDescribedBy: nameError ? "project-name-error" : undefined,
      ariaErrorMessage: nameError ? "project-name-error" : undefined
    }),
    error: nameError,
    errorId: "project-name-error"
  })}${renderField({
    id: "project-description-input",
    label: "Description",
    control: renderTextArea({ id: "project-description-input", name: "description", value: draft.description, rows: 3 })
  })}<fieldset class="column-fields"><legend>Ordered Columns</legend><div class="column-field-grid">${columnFields}</div></fieldset><div class="jk-actions"><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationKind === "project" ? "Saving…" : "Save Project"}</button>${renderButton("Cancel", "cancel-project")}</div></form></section>`;
}

function renderAddColumnControl(placement: "desktop" | "narrow"): string {
  const placementClass = placement === "desktop" ? "add-column-desktop" : "add-column-narrow";
  if (addColumnCommitted) {
    return `<section id="add-column-editor" class="add-column-control add-column-form-surface ${placementClass} jk-panel" aria-labelledby="add-column-heading"><h3 id="add-column-heading" tabindex="-1">Add Column</h3>${renderStatus({ tone: "neutral", title: "Column added", message: "Refreshing the Project before returning control to the board." }, "add-column-status")}</section>`;
  }
  if (addColumnPreparing) {
    return `<section id="add-column-editor" class="add-column-control add-column-form-surface ${placementClass} jk-panel" aria-labelledby="add-column-heading"><h3 id="add-column-heading" tabindex="-1">Add Column</h3>${renderStatus(ADD_COLUMN_PREPARING_STATUS, "add-column-status")}</section>`;
  }
  const draft = addColumnDraft;
  if (!draft) {
    return `<div class="add-column-control add-column-entry ${placementClass}"><button class="jk-button add-column-trigger" type="button" data-action="add-column"${disabledAttribute(workspaceLocked())}><span aria-hidden="true">+</span><span>Add Column</span></button></div>`;
  }
  const priorColumn = draft.columns.at(-1)?.name || "the current Columns";
  const errorId = "add-column-name-error";
  const statusId = projectStatus ? "add-column-status" : undefined;
  const describedBy = [addColumnFieldError ? errorId : "", statusId || ""].filter(Boolean).join(" ") || undefined;
  return `<section id="add-column-editor" class="add-column-control add-column-form-surface ${placementClass} jk-panel" aria-labelledby="add-column-heading"><div><h3 id="add-column-heading" tabindex="-1">Add Column</h3><p class="jk-muted">The new Column will appear after ${escapeHtml(priorColumn)}.</p></div>${renderStatus(projectStatus, "add-column-status")}<form class="add-column-form" data-form="add-column" novalidate>${renderField({
    id: "add-column-name",
    label: "Column name",
    control: renderTextInput({
      id: "add-column-name",
      name: "name",
      value: draft.name,
      required: true,
      autofocus: true,
      disabled: draft.outcomeUnconfirmed,
      invalid: Boolean(addColumnFieldError),
      ariaDescribedBy: describedBy,
      ariaErrorMessage: addColumnFieldError ? errorId : undefined
    }),
    error: addColumnFieldError,
    errorId
  })}<div class="jk-actions add-column-actions"><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute(draft.outcomeUnconfirmed)}>${mutationKind === "column" ? "Adding…" : "Add Column"}</button>${renderButton("Cancel", "cancel-add-column")}</div></form></section>`;
}

function renderEmptyWorkspace(): string {
  const workspaceName = session?.workspace?.name || "Workspace";
  return `<section class="empty-state jk-panel" aria-labelledby="empty-workspace-title"><div class="empty-state-copy"><p class="eyebrow">${escapeHtml(workspaceName)} Workspace</p><h1 id="empty-workspace-title">Create the first Project</h1><p>A Project holds a workflow and its work items.</p></div>${renderButton("Create Project", "new-project", { priority: "primary" })}</section>`;
}

function selectedMobileColumn(project: Project): string {
  const stored = mobileColumns.get(project.id);
  if (stored && project.columns.some((column) => column.id === stored)) return stored;
  const selected = selectedCardId ? project.cards.find((card) => card.id === selectedCardId)?.columnId : "";
  return selected && project.columns.some((column) => column.id === selected) ? selected : project.columns[0]?.id || "";
}

function newCardColumn(project: Project): string {
  const firstColumn = project.columns[0]?.id || "";
  return window.matchMedia("(max-width: 48rem)").matches ? selectedMobileColumn(project) : firstColumn;
}

function renderMobileColumnSelector(project: Project): string {
  const selected = selectedMobileColumn(project);
  const choices = project.columns.map((column) => {
    const total = activeCards(project).filter((card) => card.columnId === column.id).length;
    const count = visibleCards(project).filter((card) => card.columnId === column.id).length;
    return { value: column.id, label: `${column.name} · ${hasCardFilters(project) ? `${count} of ${total} Cards` : `${count} ${count === 1 ? "Card" : "Cards"}`}` };
  });
  return `<div class="mobile-column-control jk-field"><label for="mobile-column">Column</label>${renderSelect({ id: "mobile-column", name: "mobile-column", value: selected, choices, ariaLabel: "Visible Column", disabled: workspaceLocked() })}</div>`;
}

function renderBoardCard(card: ProjectCard): string {
  const summary = bodySummary(card.body);
  const hasRetainedDraft = Boolean(activeProject && retainedDrafts.has(draftKey(activeProject.id, card.id)));
  const metadata = [card.nextActor ? `<span>Next: ${card.nextActor === "human" ? "You" : "Agent"}</span>` : "", card.priority ? `<span>${card.priority} priority</span>` : "", card.blockedReason.trim() ? `<span>Blocked</span>` : ""].filter(Boolean).join("");
  return `<button class="board-card jk-card" type="button" data-action="open-card" data-card-id="${escapeHtml(card.id)}" aria-current="${card.id === selectedCardId ? "true" : "false"}"${disabledAttribute(workspaceLocked())}><span class="card-title">${escapeHtml(card.title)}</span>${metadata ? `<span class="card-work-meta jk-meta">${metadata}</span>` : ""}${card.nextAction ? `<span class="card-next-action">${escapeHtml(card.nextAction)}</span>` : ""}${summary ? `<span class="card-summary">${escapeHtml(summary)}</span>` : ""}<span class="card-meta">${hasRetainedDraft ? `<span class="card-draft-state jk-meta">Draft retained</span>` : ""}<span>${card.comments.length} ${card.comments.length === 1 ? "Comment" : "Comments"}</span><span>${escapeHtml(formatRecency(card.updatedAt || card.createdAt))}</span></span></button>`;
}

function renderColumnGrid(project: Project): string {
  const mobileColumnId = selectedMobileColumn(project);
  const desktopAddColumn = !addColumnPreparing && !addColumnCommitted && !addColumnDraft || !narrowBoardQuery.matches
    ? renderAddColumnControl("desktop")
    : "";
  return `<div class="columns" aria-label="Project Columns">${project.columns.map((column) => {
    const allCards = activeCards(project).filter((card) => card.columnId === column.id);
    const cards = allCards.filter((card) => cardMatchesFilters(card, project)).sort((left, right) => left.position - right.position);
    const headingId = `column-${safeId(column.id)}`;
    const cardCountLabel = hasCardFilters(project) ? `${cards.length} of ${allCards.length} Cards match filters` : `${cards.length} ${cards.length === 1 ? "Card" : "Cards"}`;
    const empty = allCards.length ? `<div class="column-empty"><p>No matching Cards.</p></div>` : `<div class="column-empty"><p>No Cards in ${escapeHtml(column.name)}.</p>${renderButton("Create Card", "new-card", { disabled: workspaceLocked(), data: `data-column-id="${escapeHtml(column.id)}"` })}</div>`;
    return `<section class="column jk-panel" data-column-id="${escapeHtml(column.id)}" data-mobile-active="${column.id === mobileColumnId ? "true" : "false"}" aria-labelledby="${escapeHtml(headingId)}"><header class="column-header"><h3 id="${escapeHtml(headingId)}" tabindex="-1">${escapeHtml(column.name)}</h3><span class="jk-count" aria-label="${cardCountLabel}">${hasCardFilters(project) ? `${cards.length}/${allCards.length}` : cards.length}</span></header><div class="card-list">${cards.length ? cards.map(renderBoardCard).join("") : empty}</div></section>`;
  }).join("")}${desktopAddColumn}</div>`;
}

function renderBoardPane(project: Project): string {
  const narrowAddColumn = addColumnPreparing || addColumnCommitted || addColumnDraft
    ? narrowBoardQuery.matches ? renderAddColumnControl("narrow") : ""
    : renderAddColumnControl("narrow");
  const emptyResults = hasCardFilters(project) && activeCards(project).length && !visibleCards(project).length ? `<p class="card-filter-empty">No Cards match these filters.</p>` : "";
  return `<section class="board-pane" aria-labelledby="cards-heading"><header class="board-toolbar"><h1 id="cards-heading" class="jk-visually-hidden">${escapeHtml(project.name)}</h1>${renderMobileColumnSelector(project)}${renderProjectActions(project)}</header>${renderCardFilters(project)}${emptyResults}${narrowAddColumn}${projectLoading ? `<div class="jk-status" data-kind="neutral" role="status"><span class="jk-status-marker" aria-hidden="true">…</span><p>Refreshing Project…</p></div>` : renderColumnGrid(project)}</section>`;
}

function draftKey(projectId: string, cardId: string | null): string {
  return `${projectId}:${cardId || "new"}`;
}

function storedCardDraft(project: Project, card: ProjectCard | null): CardDraft {
  return {
    projectId: project.id,
    cardId: card?.id || null,
    title: card?.title || "",
    body: card?.body || "",
    ...normalizeCardFields(card || {}),
    columnId: card?.columnId || creatingColumnId || project.columns[0]?.id || "",
    position: card?.position || 0,
    basePosition: card?.position || 0,
    baseVersion: card?.version ?? null,
    baseTitle: card?.title || "",
    baseBody: card?.body || "",
    baseColumnId: card?.columnId || creatingColumnId || project.columns[0]?.id || "",
    baseArchivedAt: card?.archivedAt || null,
    baseNextActor: card?.nextActor ?? null,
    baseNextAction: card?.nextAction || "",
    basePriority: card?.priority ?? null,
    baseBlockedReason: card?.blockedReason || ""
  };
}

function currentCardDraft(project: Project, card: ProjectCard | null): CardDraft {
  return retainedDrafts.get(draftKey(project.id, card?.id || null)) || storedCardDraft(project, card);
}

function renderComments(card: ProjectCard): string {
  const project = activeProject;
  if (!project) return "";
  const errorId = "comment-error";
  const draft = commentDrafts.get(draftKey(project.id, card.id)) || "";
  const idempotencyScope = `comment:${project.id}:${card.id}`;
  return `<section class="comments" aria-labelledby="comments-heading"><h3 id="comments-heading">Comments</h3><ol class="comment-list">${card.comments.map((comment) => `<li><div class="comment-heading"><strong>${escapeHtml(comment.actorLabel)}</strong><time datetime="${escapeHtml(comment.createdAt)}">${escapeHtml(formatDate(comment.createdAt))}</time></div><p>${escapeHtml(comment.body)}</p></li>`).join("")}</ol>${renderPendingPostAction(idempotencyScope)}<form class="comment-form" data-form="comment" data-card-id="${escapeHtml(card.id)}" novalidate>${renderField({
    id: "comment-input",
    label: "Add Comment",
    control: renderTextArea({
      id: "comment-input",
      name: "body",
      value: draft,
      rows: 3,
      required: true,
      invalid: Boolean(commentFieldError),
      ariaDescribedBy: commentFieldError ? errorId : undefined,
      ariaErrorMessage: commentFieldError ? errorId : undefined
    }),
    error: commentFieldError,
    errorId
  })}<button class="jk-button" type="submit"${disabledAttribute()}>${mutationKind === "comment" ? "Adding…" : "Add Comment"}</button>${draft ? renderButton("Discard Comment", "discard-comment") : ""}</form></section>`;
}

function renderActivity(card: ProjectCard): string {
  const activity = (activeProject?.activity || []).filter((item) => item.cardId === card.id).slice(-12).reverse();
  return `<section id="activity-panel" class="activity-panel" role="tabpanel" aria-labelledby="activity-tab" tabindex="0"><ol class="activity-list">${activity.map((item) => `<li><span>${escapeHtml(item.summary)}</span><span class="activity-actor jk-meta">By ${escapeHtml(item.actorLabel)}</span><time class="jk-meta" datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatDate(item.createdAt))}</time></li>`).join("")}</ol>${activity.length ? "" : `<p class="quiet">No Activity for this Card yet.</p>`}</section>`;
}

function renderCreateDestination(project: Project, draft: CardDraft): string {
  return renderField({
    id: "card-create-column",
    label: "Create in",
    control: renderSelect({
      id: "card-create-column",
      name: "columnId",
      value: draft.columnId,
      choices: project.columns.map((column) => ({ value: column.id, label: column.name })),
      ariaDescribedBy: "card-create-column-help"
    }),
    hint: "Choose the Column where this new Card will begin."
  }).replace('<p class="jk-help">', '<p class="jk-help" id="card-create-column-help">');
}

function renderCardWorkFields(draft: CardDraft): string {
  return `<div class="card-work-fields"><div class="card-work-choices">${renderField({ id: "card-next-actor", label: "Next actor", control: renderSelect({ id: "card-next-actor", name: "nextActor", value: draft.nextActor || "", choices: [{ value: "", label: "Unassigned" }, { value: "human", label: "You" }, { value: "agent", label: "Agent" }] }) })}${renderField({ id: "card-priority", label: "Priority", control: renderSelect({ id: "card-priority", name: "priority", value: draft.priority || "", choices: [{ value: "", label: "Unset" }, { value: "High", label: "High" }, { value: "Medium", label: "Medium" }, { value: "Low", label: "Low" }] }) })}</div>${renderField({ id: "card-next-action", label: "Next action", control: renderTextArea({ id: "card-next-action", name: "nextAction", value: draft.nextAction, rows: 2, placeholder: "What should happen next?" }) })}${renderField({ id: "card-blocked-reason", label: "Blocker", control: renderTextArea({ id: "card-blocked-reason", name: "blockedReason", value: draft.blockedReason, rows: 2, placeholder: "Leave empty when work can proceed" }) })}</div>`;
}

function selectedCardFilterMessage(project: Project, card: ProjectCard | null): string {
  return card && !cardMatchesFilters(card, project) ? "This Card is outside the current board filters." : "";
}

function renderMoveDisclosure(project: Project, card: ProjectCard, conflict: boolean): string {
  const currentColumn = project.columns.find((column) => column.id === card.columnId);
  const destinations = project.columns.filter((column) => column.id !== card.columnId);
  const blockedByMoveConflict = Boolean(moveConflict?.projectId === project.id && moveConflict.cardId === card.id);
  const unavailableReason = conflict
    ? "Resolve the stored Card change before moving it."
    : blockedByMoveConflict
      ? "Resolve the pending move below."
      : destinations.length
        ? ""
        : "This Project has no other Column.";
  const describedBy = conflict ? "stale-heading" : blockedByMoveConflict ? "move-conflict-heading" : unavailableReason ? "move-card-unavailable" : "";
  const destinationActions = destinations.map((column) => {
    const retrying = moveDestinationId === column.id && Boolean(cardStatus?.title.includes("Move"));
    return renderButton(`${retrying ? "Retry move" : "Move"} to ${column.name}`, "move-card", {
      priority: retrying ? "primary" : undefined,
      data: `id="move-to-${safeId(column.id)}" data-column-id="${escapeHtml(column.id)}"`
    });
  }).join("");
  const panel = movePanelOpen && !unavailableReason
    ? `<section id="move-card-panel" class="move-card-panel jk-panel" aria-labelledby="move-card-heading"><h2 id="move-card-heading">Move Card</h2><p>Current Column: <strong>${escapeHtml(currentColumn?.name || "Unknown Column")}</strong></p><div class="jk-actions" aria-label="Destination Columns">${destinationActions}${renderButton("Cancel", "cancel-move")}</div></section>`
    : "";
  const disabledReason = unavailableReason && !describedBy.startsWith("stale") && !describedBy.startsWith("move-conflict")
    ? `<span id="move-card-unavailable" class="move-disabled-reason">${escapeHtml(unavailableReason)}</span>`
    : "";
  return `<div class="move-card-disclosure"><button id="move-card-trigger" class="jk-button move-card-trigger" type="button" data-action="toggle-move-panel" aria-expanded="${movePanelOpen && !unavailableReason ? "true" : "false"}" aria-controls="move-card-panel"${describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : ""}${disabledAttribute(Boolean(unavailableReason))}>Move…</button>${disabledReason}${panel}</div>`;
}

function renderMoveConflict(project: Project, card: ProjectCard): string {
  const conflict = moveConflict;
  if (!conflict || conflict.projectId !== project.id || conflict.cardId !== card.id) return "";
  const destination = project.columns.find((column) => column.id === conflict.destinationColumnId);
  const guidance = !conflict.latestLoaded
    ? "The requested destination is retained, but the latest stored Card could not be loaded. Refresh before retrying."
    : destination
      ? `The requested destination, ${destination.name}, is retained. Retry the move against the latest stored Card or cancel it.`
      : "The requested destination is no longer in this Project. Cancel this move and choose another Column.";
  const retry = conflict.latestLoaded && destination
    ? renderButton(`Retry move to ${destination.name}`, "retry-move", { priority: "primary", data: `data-column-id="${escapeHtml(destination.id)}"` })
    : conflict.latestLoaded
      ? ""
      : renderButton("Refresh latest", "refresh-project", { priority: "primary" });
  return `<section class="move-conflict jk-status" data-kind="warning" aria-labelledby="move-conflict-heading"><span class="jk-status-marker" aria-hidden="true">!</span><div><h3 id="move-conflict-heading" tabindex="-1">The stored Card moved or changed</h3><p>${escapeHtml(guidance)}</p><div class="jk-actions">${retry}${renderButton("Cancel move", "cancel-move")}</div></div></section>`;
}

function renderCardInspector(project: Project): string {
  const card = selectedCardId ? project.cards.find((candidate) => candidate.id === selectedCardId) || null : null;
  if (!card && !creatingCard) return "";
  const draft = currentCardDraft(project, card);
  const draftColumn = project.columns.find((candidate) => candidate.id === draft.columnId) || project.columns[0];
  const launchColumn = project.columns.find((candidate) => candidate.id === creatingColumnId) || draftColumn;
  const contextColumn = card
    ? project.columns.find((candidate) => candidate.id === card.columnId) || draftColumn
    : launchColumn;
  const conflict = Boolean(card && cardConflict?.projectId === project.id && cardConflict.cardId === card.id);
  const titleError = cardFieldErrors.get("title") || "";
  const hasRetainedDraft = retainedDrafts.has(draftKey(project.id, card?.id || null));
  const status = cardStatus;
  const draftRetentionMarkup = hasRetainedDraft && !status && !addColumnPreparing
    ? `<p class="draft-retained-note jk-help" role="status"><strong>Draft retained</strong><span>Your unsaved Card changes are restored below and remain available until you save or explicitly revert them.</span></p>`
    : "";
  const pendingCardCreate = card ? "" : renderPendingPostAction(`card:create:${project.id}`);
  const fields = cardConflict?.fields || [];
  const staleMarkup = conflict && card ? `<section class="stale-review jk-status" data-kind="warning" aria-labelledby="stale-heading"><div><h3 id="stale-heading" tabindex="-1">The stored Card changed</h3>${card.archivedAt ? `<p>This Card is archived. Your draft remains local. Restore it separately before saving.</p>${renderButton("Restore Card", "restore-selected-card")}` : fields.length ? `<p>Choose a value for each field changed in both places.</p>${fields.map(field => field === "placement" ? `<fieldset><legend>Column</legend><p>The retained destination differs from the saved Column. Text Save never moves a Card.</p>${renderButton("Use saved Column", "resolve-card-field", { data: `data-field="placement" data-choice="saved"` })}${project.columns.some(column => column.id === draft.columnId) ? renderButton("Move to retained Column", "move-retained-placement", { data: `data-column-id="${escapeHtml(draft.columnId)}"` }) : ""}</fieldset>` : `<fieldset><legend>${escapeHtml(field)}</legend><p>Draft: <span class="conflict-source">${escapeHtml(draft[field] ?? "Unset")}</span></p><p>Saved: <span class="conflict-source">${escapeHtml(card[field] ?? "Unset")}</span></p>${renderButton("Keep draft", "resolve-card-field", { data: `data-field="${field}" data-choice="local"` })}${renderButton("Use saved", "resolve-card-field", { data: `data-field="${field}" data-choice="saved"` })}</fieldset>`).join("")}` : `<p>Refresh to load the latest saved Card before continuing.</p>${renderButton("Refresh latest", "refresh-project")}`}${pendingPatches.has(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`) ? renderButton("Check original save", "retry-save") : ""}${renderButton("Revert draft", "discard-draft")}</div></section>` : "";
  const moveConflictMarkup = card ? renderMoveConflict(project, card) : "";
  const recoveryActive = conflict || Boolean(moveConflictMarkup);
  const previewBlocked = addColumnPreparing || recoveryActive || Boolean(status && (status.tone === "error" || status.title.includes("outcome unconfirmed")));
  if (previewBlocked) descriptionView = "write";
  const cardSelected = inspectorTab === "card" || !card;
  const tabs = `<div class="inspector-tabs" role="tablist" aria-label="Card views"><button id="card-tab" class="inspector-tab" type="button" role="tab" data-action="show-card-tab" aria-selected="${cardSelected ? "true" : "false"}" aria-controls="card-panel" tabindex="${cardSelected ? "0" : "-1"}"${disabledAttribute()}>Card</button>${card ? `<button id="activity-tab" class="inspector-tab" type="button" role="tab" data-action="show-activity-tab" aria-selected="${cardSelected ? "false" : "true"}" aria-controls="activity-panel" tabindex="${cardSelected ? "-1" : "0"}"${disabledAttribute(recoveryActive)}>Activity</button>` : ""}</div>`;
  const closeLabel = `Close Card and return to ${contextColumn?.name || "Column"}`;
  const titleControl = renderTextInput({
    id: "card-title-input",
    name: "title",
    value: draft.title,
    placeholder: "Card title",
    required: true,
    className: "surface-control card-title-control",
    invalid: Boolean(titleError),
    ariaDescribedBy: titleError ? "card-title-error" : undefined,
    ariaErrorMessage: titleError ? "card-title-error" : undefined
  });
  const bodyControl = renderTextArea({
    id: "card-body-input",
    name: "body",
    value: draft.body,
    placeholder: "Add details…",
    rows: 12,
    className: "surface-control card-body-control",
    ariaLabel: "Description",
    ariaDescribedBy: "card-description-help"
  });
  const descriptionMarkdown = renderCardMarkdown(draft.body);
  const descriptionTabs = `<div class="description-view-tabs" role="tablist" aria-label="Description view" data-tablist="description"><button id="description-write-tab" class="description-view-tab" type="button" role="tab" data-action="show-description-write" aria-selected="${descriptionView === "write" ? "true" : "false"}" aria-controls="description-write-panel" tabindex="${descriptionView === "write" ? "0" : "-1"}"${disabledAttribute()}>Write</button><button id="description-preview-tab" class="description-view-tab" type="button" role="tab" data-action="show-description-preview" aria-selected="${descriptionView === "preview" ? "true" : "false"}" aria-controls="description-preview-panel" tabindex="${descriptionView === "preview" ? "0" : "-1"}"${disabledAttribute(previewBlocked)}>Preview</button></div>`;
  const writePanel = `<div id="description-write-panel" class="description-view-panel" role="tabpanel" aria-labelledby="description-write-tab"${descriptionView === "write" ? "" : " hidden"}>${bodyControl}</div>`;
  const previewContent = descriptionMarkdown.empty
    ? `<p class="markdown-preview-empty">Nothing to preview.</p>`
    : `${descriptionMarkdown.failed ? `<p class="jk-error markdown-preview-error">Preview unavailable. Showing plain text.</p>` : ""}${descriptionMarkdown.html}`;
  const previewPanel = `<div id="description-preview-panel" class="description-view-panel markdown-preview" role="tabpanel" aria-labelledby="description-preview-tab" tabindex="0"${descriptionView === "preview" ? "" : " hidden"}>${previewContent}</div>`;
  const descriptionEditor = `<div class="jk-field surface-field card-body-field"><div class="description-field-header"><label for="card-body-input">Description</label>${descriptionTabs}</div><p class="jk-help" id="card-description-help">Markdown supports headings, lists, links, quotes, and code. HTML and images aren’t supported.</p>${writePanel}${previewPanel}</div>`;
  const createDestination = card ? "" : renderCreateDestination(project, draft);
  const editor = `<form class="card-form surface-card-form" data-form="card" data-card-id="${escapeHtml(card?.id || "")}" novalidate><fieldset class="card-edit-fields"${card?.archivedAt ? " disabled" : ""}><div class="jk-field surface-field"><label class="jk-visually-hidden" for="card-title-input">Title</label>${titleControl}${titleError ? `<p class="jk-error" id="card-title-error">${escapeHtml(titleError)}</p>` : ""}</div><p id="card-filter-note" class="card-filter-note jk-help" role="status">${selectedCardFilterMessage(project, card)}</p>${draftRetentionMarkup}${descriptionEditor}${renderCardWorkFields(draft)}${createDestination}</fieldset>${conflict || moveConflictMarkup ? "" : card ? `<div class="inspector-actions"><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute(Boolean(card.archivedAt))}>Save</button>${renderButton("Revert", "discard-draft")}${renderButton("Archive", "archive-card", { priority: "risk", data: `data-card-id="${escapeHtml(card.id)}"` })}</div>` : `<div class="inspector-actions"><button class="jk-button" data-priority="primary" type="submit"${disabledAttribute()}>${mutationKind === "card" ? "Creating…" : "Create Card"}</button>${renderButton("Discard", "discard-draft")}</div>`}</form>`;
  const cardPanel = `<div id="card-panel" class="inspector-panel" role="tabpanel" aria-labelledby="card-tab">${status ? `<div class="card-status">${renderStatus(status, "card-status")}</div>` : renderStatus(null, "card-status")}${staleMarkup}${moveConflictMarkup}${pendingCardCreate}${editor}${card && !card.archivedAt ? renderComments(card) : ""}</div>`;
  const preparingStatus = addColumnPreparing && cardOnlyQuery.matches
    ? `<div class="card-status inspector-preparing-status">${renderStatus(ADD_COLUMN_PREPARING_STATUS, "add-column-preparing-status")}</div>`
    : "";
  const toolbarActions = `<div class="inspector-toolbar-actions">${card ? renderMoveDisclosure(project, card, conflict) : ""}<button class="close-button inspector-close" type="button" data-action="close-card" aria-label="${escapeHtml(closeLabel)}"${disabledAttribute()}><span aria-hidden="true">×</span></button></div>`;
  return `<aside class="card-inspector jk-panel" aria-labelledby="card-tab"><div class="inspector-content"><header class="inspector-toolbar">${tabs}${toolbarActions}</header>${preparingStatus}${cardSelected ? cardPanel : card ? renderActivity(card) : cardPanel}</div></aside>`;
}

function renderRecovery(): string {
  const alternatives = recoveryMaps.flatMap(map => [...map.keys()].flatMap(key => map.alternatives(key).map(item => ({ ...item, kind: map.kind }))));
  const missing = activeProject ? [...retainedDrafts].filter(([, draft]) => draft.projectId === activeProject!.id && draft.cardId && !activeProject!.cards.some(card => card.id === draft.cardId)) : [];
  return `<section id="local-recovery" class="project-status-wrap" aria-label="Local draft recovery">${retainedDrafts.size || commentDrafts.size || projectDrafts.size || pendingIdempotencyKeys.size || pendingPatches.size ? `<details><summary>Local drafts and recovery</summary><p>Drafts stay on this browser for this signed-in owner and Workspace.</p>${renderButton("Copy recovery data", "copy-recovery")}</details>` : ""}${recoveryStore.failure ? `<div class="jk-status" data-kind="warning" role="alert"><div><strong>Local draft recovery needs attention</strong><p>${escapeHtml(recoveryStore.failure)}</p>${renderButton("Retry local storage", "retry-local-storage")}${renderButton("Copy recovery data", "copy-recovery")}${renderButton("Sign out", "sign-out")}</div></div>` : ""}${[...pendingPatches].map(([path]) => `<div class="jk-status" data-kind="warning"><div><strong>Original change needs reconciliation</strong><p>Read saved values before retrying or choosing a different action.</p>${renderButton("Read back original change", "read-back-patch", { data: `data-patch-path="${escapeHtml(path)}"` })}</div></div>`).join("")}${alternatives.length ? `<div class="jk-status" data-kind="warning"><div><strong>Other draft copies are retained</strong><p>Opening a copy keeps the current copy available.</p>${alternatives.map(item => renderButton(`Open draft copy (${new Date(item.updatedAt).toLocaleString()})`, "recover-copy", { data: `data-record-id="${escapeHtml(item.id)}" data-record-kind="${escapeHtml(item.kind)}"` })).join("")}</div></div>` : ""}${missing.length ? `<div class="jk-status" data-kind="warning"><div><strong>A Card with a local draft is unavailable</strong><p>Your draft is retained. Copy recovery data to keep its full text.</p>${renderButton("Copy recovery data", "copy-recovery")}</div></div>` : ""}</section>`;
}
function syncRecoveryNotice(): void {
  if (!session) return;
  const panel = root.querySelector("#local-recovery");
  if (panel) panel.outerHTML = renderRecovery();
}
async function readBackPendingPatch(path: string): Promise<void> {
  const operation = pendingPatches.get(path);
  const projectPath = path.match(/^\/projects\/([^/]+)(?:\/cards\/([^/]+))?$/);
  if (!operation || !projectPath || mutationInFlight) return;
  const projectId = decodeURIComponent(projectPath[1]);
  const cardId = projectPath[2] ? decodeURIComponent(projectPath[2]) : null;
  setWorkspaceMutationsDisabled(true, "refresh");
  try {
    const latestProject = await fetchProject(projectId);
    const latest = cardId ? latestProject.cards.find(card => card.id === cardId) : latestProject;
    if (!latest) throw new Error("The original resource is unavailable. Its draft and submission are retained.");
    const matches = Object.entries(operation.body).every(([field, value]) => JSON.stringify(objectValue(latest)[field]) === JSON.stringify(value));
    if (matches) {
      pendingPatches.set(path, { ...operation, response: cardId ? { card: latest, projectRevision: latestProject.revision } : { project: latestProject }, evidence: "observed" });
      if (cardId && patchIntentKind(operation.body) === "card-text") {
        const key = draftKey(projectId, cardId), local = retainedDrafts.get(key);
        if (local && cardTextFields.every(field => objectValue(local)[field] === operation.body[field])) retainedDrafts.delete(key);
      }
      completePatch(path);
    } else {
      // A deliberate readback ends the unknown state without replaying a PATCH.
      // The local draft still carries text intent; a requested move stays explicit.
      pendingPatches.delete(path);
      if (cardId && patchIntentKind(operation.body) === "placement") moveConflict = { projectId, cardId, destinationColumnId: String(operation.body.columnId), latestLoaded: true };
    }
    if (activeProject?.id === projectId) applyProjectSnapshot(latestProject);
    const status: StatusMessage = matches
      ? { tone: "success", title: "Saved state observed", message: "The latest saved values match the original submission. Readback does not identify the request or actor that saved them." }
      : { tone: "warning", title: "Latest saved values read", message: "The original submission is not the current saved state. Your draft is retained. Review it, then explicitly choose Save or Move; no PATCH was replayed." };
    if (selectedCardId === cardId && cardId) cardStatus = status; else projectStatus = status;
  } finally { setWorkspaceMutationsDisabled(false); render(); }
}

async function resolveCardField(field: string, choice: string): Promise<void> {
  const project = activeProject; const card = project?.cards.find(item => item.id === selectedCardId);
  if (!project || !card || (!cardTextFields.includes(field as CardTextField) && field !== "placement")) return;
  const key = draftKey(project.id, card.id); const draft = retainedDrafts.get(key);
  if (!draft) return;
  if (field === "placement") { retainedDrafts.set(key, { ...draft, columnId: card.columnId, position: card.position, baseColumnId: card.columnId, basePosition: card.position }); cardConflict = null; retainedDrafts.set(key, mergeCardDraft(retainedDrafts.get(key)!, card)); render(); return; }
  const name = field as CardTextField;
  const baseKey = `base${name[0].toUpperCase()}${name.slice(1)}`;
  const next = { ...draft, [baseKey]: card[name], ...(choice === "saved" ? { [name]: card[name] } : {}) };
  retainedDrafts.set(key, next);
  cardConflict = null;
  retainedDrafts.set(key, mergeCardDraft(next, card));
  cardStatus = cardConflict ? cardStatus : null;
  pendingFocusId = cardConflict ? "stale-heading" : "card-title-input";
  render();
}
async function restoreSelectedCard(): Promise<void> {
  const project = activeProject; const card = project?.cards.find(item => item.id === selectedCardId);
  if (!project || !card || !card.archivedAt || mutationInFlight) return;
  setWorkspaceMutationsDisabled(true, "undo");
  const path = `/projects/${safeId(project.id)}/cards/${safeId(card.id)}`;
  try {
    const response = await api(path, { method: "PATCH", revision: card.version, body: { archivedAt: null } });
    const restored = applyCardMutationResponse(project.id, response);
    completePatch(path);
    const key = draftKey(project.id, card.id); const draft = retainedDrafts.get(key);
    cardConflict = null; if (draft) retainedDrafts.set(key, mergeCardDraft(draft, restored));
    cardStatus = { tone: "success", title: observedWrite ? "Saved active state observed" : "Card restored", message: "Your text draft is still local. Use Save to store it." };
  } finally { setWorkspaceMutationsDisabled(false); render(); }
}

function activityScopeKey(): string {
  return JSON.stringify([sessionEpoch, session?.ownerId, session?.workspace?.id || "local"]);
}

function renderActivityFeed(): string {
  const feed = activityFeed!;
  const title = feed.scope === "workspace" ? "Workspace Activity" : "Project Activity";
  const status = feed.loading
    ? { tone: "neutral" as const, title: feed.items.length ? "Loading Activity…" : "Opening Activity…", message: "" }
    : feed.error
      ? { tone: "error" as const, title: "Activity could not be loaded", message: feed.error }
      : null;
  const items = feed.items.map((item) => `<li>${feed.scope === "workspace" ? `<span class="activity-context jk-meta">${escapeHtml(item.projectName)}${item.projectArchivedAt ? " · Archived Project" : ""}</span>` : ""}<span>${escapeHtml(item.summary)}</span><span class="activity-actor jk-meta">By ${escapeHtml(item.actorLabel)}</span><time class="jk-meta" datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatDate(item.createdAt))}</time></li>`).join("");
  return `<section class="activity-feed jk-panel" aria-labelledby="activity-feed-title" aria-busy="${feed.loading}"><div class="activity-feed-header"><div><p class="eyebrow">${escapeHtml(feed.name)}</p><h1 id="activity-feed-title" tabindex="-1">${title}</h1></div><div class="jk-actions">${renderButton("Refresh", "refresh-activity-feed", { disabled: feed.loading })}${renderButton("Back to board", "close-activity-feed")}</div></div>${renderStatus(status, "activity-feed-status")}${feed.error ? renderButton("Retry", "retry-activity-feed", { disabled: feed.loading }) : ""}<ol class="activity-list" aria-label="${title}">${items}</ol>${feed.loaded && !feed.items.length ? `<p class="quiet">${feed.scope === "workspace" ? "No Activity in this Workspace yet." : "No Activity in this Project yet."}</p>` : ""}${feed.nextCursor ? `<div class="activity-feed-more">${renderButton("Load more", "load-more-activity", { disabled: feed.loading })}</div>` : ""}</section>`;
}

async function loadActivityFeed(more = false): Promise<void> {
  const feed = activityFeed;
  if (!feed || feed.loading || (more && !feed.nextCursor)) return;
  const scope = activityScopeKey();
  const requestId = ++feed.requestId;
  const current = () => activityFeed === feed && feed.requestId === requestId && activityScopeKey() === scope;
  const cursor = more ? feed.nextCursor : null;
  const initiatingAction = (document.activeElement as HTMLElement | null)?.dataset.action;
  feed.loading = true;
  feed.error = "";
  feed.retryMore = more;
  render();
  try {
    const path = feed.scope === "workspace"
      ? `/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : `/projects/${safeId(feed.projectId!)}/activity?limit=200`;
    const payload = objectValue(await api(path));
    if (!current()) return;
    if (!Array.isArray(payload.activity) || (feed.scope === "workspace" && payload.nextCursor !== null && typeof payload.nextCursor !== "string")) throw new Error("Try again to load Activity.");
    const incoming = payload.activity.map(normalizeActivity);
    if (feed.scope === "project") incoming.reverse();
    const unique = new Map<string, ActivityItem>();
    for (const item of more ? [...feed.items, ...incoming] : incoming) unique.set(JSON.stringify([item.projectId, item.id]), item);
    feed.items = [...unique.values()];
    feed.nextCursor = feed.scope === "workspace" ? payload.nextCursor : null;
    feed.loaded = true;
  } catch (error) {
    if (!current()) return;
    if (handlePrivateError(error)) return;
    feed.error = error instanceof Error ? error.message : "Try again to load Activity.";
  } finally {
    if (current()) {
      feed.loading = false;
      if (initiatingAction && document.activeElement === document.body) {
        pendingFocusRestore = { action: initiatingAction === "load-more-activity" && feed.nextCursor ? "load-more-activity" : feed.error ? "retry-activity-feed" : "refresh-activity-feed", occurrence: 0 };
      }
      render();
    }
  }
}

async function openActivityFeed(scope: ActivityFeed["scope"]): Promise<void> {
  if (!session || workspaceLocked() || (scope === "project" && !activeProject)) return;
  await retainVisibleDrafts();
  activityFeed = { scope, projectId: scope === "project" ? activeProject!.id : null, name: scope === "project" ? activeProject!.name : session.workspace?.name || "Workspace", items: [], nextCursor: null, loaded: false, loading: false, error: "", retryMore: false, requestId: 0 };
  workspaceMenuOpen = false;
  projectActionsOpen = false;
  accountPanelOpen = false;
  agentPanelOpen = false;
  pendingFocusId = "activity-feed-title";
  await loadActivityFeed();
}

function closeActivityFeed(): void {
  if (!activityFeed) return;
  const scope = activityFeed.scope;
  activityFeed = null;
  pendingFocusRestore = { action: scope === "project" ? "toggle-project-actions" : accessContext === "workspace" ? "toggle-workspace-menu" : "show-workspace-activity", occurrence: 0 };
  render();
}

function renderWorkspace(): string {
  const project = activeProject;
  const cardOpen = Boolean(!activityFeed && project && !addColumnDraft && !projectEditorMode && (selectedCardId || creatingCard));
  const content = projectEditorMode
      ? renderProjectEditor()
      : !projects.length
        ? renderEmptyWorkspace()
        : project
          ? `${renderBoardPane(project)}${cardOpen ? renderCardInspector(project) : ""}`
          : renderEmptyWorkspace();
  return `<a class="skip-link" href="#main-content">Skip to workspace</a><div class="workspace" data-card-open="${cardOpen ? "true" : "false"}" data-workspace-locked="${workspaceLocked() ? "true" : "false"}">${renderHeader()}${renderRecovery()}${renderProjectReceipt()}<main id="main-content" class="workbench" tabindex="-1">${agentPanelOpen ? renderAgentConnections() : activityFeed ? renderActivityFeed() : content}</main></div>`;
}

function currentUiState(): string {
  if (initialLoading || workspaceHandoffPending) return "opening";
  if (signOutPending) return "signing-out";
  if (!session) {
    if (authNotice?.kind === "signed-out") return "sign-out-success";
    if (authNotice?.kind === "invalid-key") return "invalid-key";
    if (authNotice?.kind === "session-expired") return "session-expired";
    if (authNotice?.kind === "service-unavailable" || authNotice?.kind === "sign-out-incomplete") return "service-unavailable";
    return "signed-out";
  }
  if (accessContext === "root") return "workspace-route";
  if (mutationKind === "refresh") return "refreshing";
  if (mutationInFlight) return "saving";
  if (cardConflict || moveConflict) return "stale";
  if (projectFieldErrors.size || addColumnFieldError || cardFieldErrors.size || commentFieldError) return "validation-error";
  if (!projects.length) return "empty-workspace";
  if (currentArchiveReceipt(activeProject?.id || "")) return "archived";
  if (selectedCardId || creatingCard) return "selected";
  if (activeProject && !activeCards(activeProject).length) return "empty-project";
  if (projectStatus?.title.includes("Refresh")) return "refresh-failure";
  if (confirmation?.uiState === "refresh-success") return "refresh-success";
  return "populated";
}

function focusTargetFor(element: HTMLElement): FocusTarget | null {
  const action = element.dataset.action;
  if (!action) return null;
  const peers = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)].filter((candidate) =>
    candidate.dataset.cardId === element.dataset.cardId && candidate.dataset.columnId === element.dataset.columnId
  );
  return {
    action,
    cardId: element.dataset.cardId,
    columnId: element.dataset.columnId,
    occurrence: Math.max(0, peers.indexOf(element))
  };
}

function findFocusTarget(target: FocusTarget): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>(`[data-action="${target.action}"]`)];
  const matches = candidates.filter((candidate) =>
    candidate.dataset.cardId === target.cardId
    && candidate.dataset.columnId === target.columnId
    && !candidate.hasAttribute("disabled")
    && candidate.getClientRects().length > 0
  );
  return matches[target.occurrence] || matches[0] || null;
}

function restorePendingContext(): void {
  const focusId = pendingFocusId;
  const focusTarget = pendingFocusRestore;
  const scrollTop = pendingScrollRestore;
  pendingFocusId = null;
  pendingFocusRestore = null;
  pendingScrollRestore = null;
  if (scrollTop !== null) window.scrollTo({ top: scrollTop });
  let target = focusId ? document.getElementById(focusId) : focusTarget ? findFocusTarget(focusTarget) : null;
  if (!target && focusTarget?.action === "open-card" && activeProject) {
    const card = activeProject.cards.find((candidate) => candidate.id === focusTarget.cardId);
    const heading = document.getElementById(`column-${safeId(card?.columnId || selectedMobileColumn(activeProject))}`);
    target = heading?.getClientRects().length ? heading : document.getElementById("board-filter-next-actor");
  }
  target?.focus();
}

function render(): void {
  if (confirmation && (mutationInFlight || projectStatus || cardStatus || cardConflict || moveConflict)) {
    clearConfirmation();
  }
  document.body.dataset.state = currentUiState();
  const publicWebsite = usesPublicWebsite(accessContext, Boolean(session)) && !initialLoading && !workspaceHandoffPending && !signOutPending;
  document.title = publicPageTitle({ context: accessContext, authenticated: Boolean(session), resolved: !initialLoading, pending: workspaceHandoffPending || signOutPending, authMode: authIntent?.mode, recoveryCodePresent: Boolean(recoveryCode), signedOut: authNotice?.kind === "signed-out" });
  document.body.classList.toggle("public-website", publicWebsite);
  const content = initialLoading || workspaceHandoffPending
    ? renderLoading()
    : signOutPending
      ? renderSignOutProgress()
      : session
        ? accessContext === "root" ? accessPanelOpen ? renderAccessSettings() : renderWorkspaceRoute() : renderWorkspace()
        : renderSignIn();
  const utilities = publicWebsite && accessContext === "root" && authNotice?.kind !== "signed-out"
    ? (setupAvailable ? renderButton("Set up existing account", "start-setup", { disabled: !loginUrl }) : "") + (authNotice?.kind === "sign-out-incomplete" ? renderButton("Retry sign out", "retry-global-sign-out") : "")
    : "";
  const activeElement = document.activeElement;
  if (!pendingFocusId && !pendingFocusRestore && activeElement instanceof HTMLElement && root.contains(activeElement) && activeElement.id) {
    pendingFocusId = activeElement.id;
  }
  root.innerHTML = publicWebsite ? renderPublicWebsite(content, rootUrl, utilities) : content;
  syncPublicWebsiteMenu();
  restoreDescriptionSelection();
  restorePendingContext();
}

function formData(form: HTMLFormElement): FormData {
  return new FormData(form);
}

function formValue(data: FormData, name: string): string {
  return String(data.get(name) || "");
}

function cleanValue(value: string): string {
  return value.trim();
}

function cardBodyValue(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function captureProjectDraft(form: HTMLFormElement): void {
  if (!projectEditorDraft) return;
  const data = formData(form);
  projectEditorDraft = {
    ...projectEditorDraft,
    name: formValue(data, "name"),
    description: formValue(data, "description"),
    columns: projectEditorDraft.columns.map((column, index) => ({ ...column, name: formValue(data, `column-${index}`) }))
  };
  projectDrafts.set(projectEditorDraft.projectId || "new", projectEditorDraft);
}

function captureAddColumnDraft(form: HTMLFormElement): void {
  if (!addColumnDraft || addColumnDraft.outcomeUnconfirmed) return;
  addColumnDraft = { ...addColumnDraft, name: formValue(formData(form), "name") };
}

function sameDraft(left: CardDraft, right: CardDraft): boolean {
  return cleanValue(left.title) === cleanValue(right.title)
    && cardBodyValue(left.body) === cardBodyValue(right.body)
    && left.columnId === right.columnId
    && sameCardFields(left, right);
}

function sameCardFields(left: CardFields, right: CardFields): boolean {
  return left.nextActor === right.nextActor
    && cleanValue(left.nextAction) === cleanValue(right.nextAction)
    && left.priority === right.priority
    && cleanValue(left.blockedReason) === cleanValue(right.blockedReason);
}

function cardFieldsPayload(draft: CardDraft): CardFields {
  return { nextActor: draft.nextActor, nextAction: cleanValue(draft.nextAction), priority: draft.priority, blockedReason: cleanValue(draft.blockedReason) };
}

function sameRevision(left: Revision | null, right: Revision | null): boolean {
  return left !== null && right !== null && String(left) === String(right);
}

function mergeCardDraft(draft: CardDraft, card: ProjectCard): CardDraft {
  const base = { title: draft.baseTitle, body: draft.baseBody, nextActor: draft.baseNextActor, nextAction: draft.baseNextAction, priority: draft.basePriority, blockedReason: draft.baseBlockedReason, columnId: draft.baseColumnId, position: draft.basePosition ?? card.position };
  const merged = reconcileCardValues(base, { ...draft, position: draft.position ?? base.position }, card);
  const next = { ...rebaseDraft(draft, card), ...Object.fromEntries([...cardTextFields, "columnId", "position"].map(field => [field, objectValue(merged.value)[field]])) } as CardDraft;
  // Conflicting base values remain intact until each field has an explicit choice.
  for (const field of merged.conflicts) {
    if (field === "placement") { next.baseColumnId = draft.baseColumnId; next.basePosition = draft.basePosition; continue; }
    const baseKey = `base${field[0].toUpperCase()}${field.slice(1)}` as keyof CardDraft;
    Object.assign(next, { [baseKey]: draft[baseKey] });
  }
  if (card.archivedAt || merged.conflicts.length) cardConflict = { projectId: draft.projectId, cardId: card.id, latestLoaded: true, fields: merged.conflicts };
  else if (cardConflict?.cardId === card.id) cardConflict = null;
  return next;
}
function storedCardMatchesDraftBase(card: ProjectCard, draft: CardDraft): boolean {
  return cardTextFields.every(field => card[field] === draft[`base${field[0].toUpperCase()}${field.slice(1)}` as keyof CardDraft]) && card.archivedAt === draft.baseArchivedAt;
}

function rebaseDraft(draft: CardDraft, card: ProjectCard): CardDraft {
  return {
    ...draft,
    basePosition: card.position,
    baseVersion: card.version,
    baseTitle: card.title,
    baseBody: card.body,
    baseColumnId: card.columnId,
    baseArchivedAt: card.archivedAt,
    baseNextActor: card.nextActor,
    baseNextAction: card.nextAction,
    basePriority: card.priority,
    baseBlockedReason: card.blockedReason
  };
}

function captureCardDraft(form: HTMLFormElement): CardDraft | null {
  const project = activeProject;
  if (!project) return null;
  const cardId = form.dataset.cardId || null;
  const card = cardId ? project.cards.find((candidate) => candidate.id === cardId) || null : null;
  const key = draftKey(project.id, cardId);
  if (mutationInFlight || card?.archivedAt) return retainedDrafts.get(key) || storedCardDraft(project, card);
  const data = formData(form);
  const existing = retainedDrafts.get(key);
  const base = existing || storedCardDraft(project, card);
  const draft: CardDraft = {
    projectId: project.id,
    cardId,
    title: formValue(data, "title"),
    body: formValue(data, "body"),
    ...normalizeCardFields({ nextActor: formValue(data, "nextActor"), nextAction: formValue(data, "nextAction"), priority: formValue(data, "priority"), blockedReason: formValue(data, "blockedReason") }),
    columnId: formValue(data, "columnId") || base.columnId,
    position: base.position,
    basePosition: base.basePosition,
    baseVersion: base.baseVersion,
    baseTitle: base.baseTitle,
    baseBody: base.baseBody,
    baseColumnId: base.baseColumnId,
    baseArchivedAt: base.baseArchivedAt,
    baseNextActor: base.baseNextActor,
    baseNextAction: base.baseNextAction,
    basePriority: base.basePriority,
    baseBlockedReason: base.baseBlockedReason
  };
  if (sameDraft(draft, storedCardDraft(project, card))) retainedDrafts.delete(key);
  else retainedDrafts.set(key, draft);
  return draft;
}

function safeSessionRemove(key: string): void {
  try { window.sessionStorage.removeItem(key); } catch { /* Optional preferences cannot prevent private state from leaving the screen. */ }
}

function clearPrivateState(notice: AuthNotice | null): void {
  sessionEpoch++;
  activityFeed = null;
  session = null;
  recoveryStore.scope = "";
  projectDrafts.clear();
  pendingPatches.clear();
  workspaceHandoffPending = false;
  workspaceChoices = [];
  workspaceMenuOpen = false;
  workspaceCreationOpen = false;
  workspaceCreationReturnSlug = "";
  workspaceDraft = { name: "", slug: "" };
  createdWorkspace = null;
  uncertainWorkspaceCreations.clear();
  safeSessionRemove("kanban.cards:workspace-route");
  agentConnections = [];
  agentPanelOpen = false;
  issuedAgentCredential = "";
  agentNeedsVerification = false;
  accessSettings = null;
  accessPanelOpen = false;
  accessStatus = null;
  recoveryCode = "";
  pendingAuthHandoff = null;
  projects = [];
  activeProject = null;
  selectedCardId = null;
  creatingCard = false;
  creatingColumnId = "";
  projectEditorMode = null;
  projectEditorDraft = null;
  addColumnPreparing = false;
  addColumnCommitted = false;
  addColumnDraft = null;
  addColumnFieldError = "";
  projectFieldErrors.clear();
  cardFieldErrors.clear();
  commentFieldError = "";
  projectStatus = null;
  cardStatus = null;
  clearConfirmation();
  cardConflict = null;
  resetMoveContext();
  retainedDrafts.clear();
  commentDrafts.clear();
  displayedAt.clear();
  archiveReceipts.clear();
  pendingIdempotencyKeys.clear();

  mobileColumns.clear();
  boardScrollPositions.clear();
  projectCardFilters.clear();
  cardReturnFocus = null;
  projectEditorReturnFocus = null;
  addColumnReturnFocus = null;
  pendingFocusRestore = null;
  pendingScrollRestore = null;
  inspectorTab = "card";
  resetDescriptionContext();
  accountPanelOpen = false;
  projectActionsOpen = false;
  setWorkspaceMutationsDisabled(false);
  try { window.localStorage.removeItem("kanban.cards:project-id"); } catch { /* Sign-out still hides private state. */ }
  safeSessionRemove("kanban.cards:open-agents");
  safeSessionRemove("kanban.cards:open-access");
  safeSessionRemove("kanban.cards:add-passkey-after-verify");
  authNotice = notice;
}

async function loadSession(): Promise<void> {
  try {
    const result = normalizeSession(await api("/session"));
    accessContext = result.context;
    rootUrl = result.rootUrl;
    loginUrl = result.loginUrl;
    authIntent = result.authIntent;
    setupAvailable = result.setupAvailable;
    session = result.session;
    bindRecovery();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) session = null;
    else throw error;
  }
}

async function loadWorkspaceChoices(): Promise<void> {
  const payload = objectValue(await api("/workspaces"));
  workspaceChoices = arrayValue(payload.workspaces).map(normalizeWorkspaceAccess).filter((workspace) => workspace.id && workspace.slug && workspace.url);
}

async function openWorkspace(slug: string, selectedWorkspace?: WorkspaceAccess): Promise<void> {
  if (!slug) return;
  const workspace = selectedWorkspace || workspaceChoices.find((candidate) => candidate.slug === slug);
  if (!workspace || workspace.slug !== slug || !workspace.url) {
    accessFailure = { title: "Workspace did not open", message: "The Workspace route was incomplete." };
    render();
    return;
  }
  setWorkspaceMutationsDisabled(true, "workspace");
  render();
  try {
    const payload = objectValue(await api("/workspace-handoffs", { method: "POST", body: { slug } }));
    const destination = String(payload.destination || "");
    const token = String(payload.handoffToken || "");
    const safeDestination = safeWorkspaceHandoffUrl(destination, workspace.url);
    if (!safeDestination || !token) throw new Error("The Workspace handoff was incomplete.");
    const parsed = new URL(safeDestination);
    workspaceHandoffPending = true;
    render();
    window.sessionStorage.removeItem("kanban.cards:workspace-route");
    submitWorkspaceHandoff(parsed, token);
  } catch (error) {
    workspaceHandoffPending = false;
    accessFailure = { title: "Workspace did not open", message: error instanceof Error ? error.message : "Try again." };
    throw error;
  } finally {
    if (!workspaceHandoffPending) setWorkspaceMutationsDisabled(false);
  }
}

function submitWorkspaceHandoff(destination: URL, token: string): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = destination.toString();
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = token;
  form.append(input);
  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

async function showWorkspaceRoute(create: boolean): Promise<void> {
  if (workspaceLocked()) return;
  workspaceMenuOpen = false;
  accountPanelOpen = false;
  projectActionsOpen = false;
  if (accessContext === "root") {
    workspaceCreationOpen = create;
    createdWorkspace = null;
    workspaceDraft = { name: "", slug: "" };
    accessFailure = null;
    window.sessionStorage.setItem("kanban.cards:workspace-route", JSON.stringify({ create, returnSlug: workspaceCreationReturnSlug }));
    pendingFocusId = create ? "workspace-name" : "workspace-route-title";
    render();
    return;
  }
  if (accessContext !== "workspace" || !session?.workspace) return;
  const form = document.querySelector<HTMLFormElement>("form[data-form='card']");
  if (form) {
    captureCardDraft(form);

  }
  setWorkspaceMutationsDisabled(true, "workspace");
  render();
  await retainVisibleDrafts();
  if (!session) return;
  if (recoveryStore.failure) {
    setWorkspaceMutationsDisabled(false);
    projectStatus = { tone: "warning", title: "Workspace change paused", message: "Retry local storage or export your drafts before leaving this Workspace." };
    pendingFocusId = "project-status";
    render();
    return;
  }
  const destination = new URL("/", rootUrl);
  destination.searchParams.set(create ? "new-workspace" : "workspaces", "1");
  destination.searchParams.set("return-workspace", session.workspace.slug);
  window.location.assign(destination.toString());
}

async function cancelWorkspaceCreation(): Promise<void> {
  if (mutationInFlight) return;
  workspaceCreationOpen = false;
  workspaceDraft = { name: "", slug: "" };
  createdWorkspace = null;
  uncertainWorkspaceCreations.clear();
  accessFailure = null;
  window.sessionStorage.removeItem("kanban.cards:workspace-route");
  const previous = workspaceChoices.find((workspace) => workspace.slug === workspaceCreationReturnSlug);
  if (previous) await openWorkspace(previous.slug, previous);
  else { pendingFocusRestore = { action: "new-workspace", occurrence: 0 }; render(); }
}

async function createWorkspace(form: HTMLFormElement): Promise<void> {
  if (accessContext !== "root" || mutationInFlight || createdWorkspace) return;
  const data = formData(form);
  workspaceDraft = { name: formValue(data, "name"), slug: formValue(data, "slug") };
  const name = cleanValue(workspaceDraft.name);
  const slug = cleanValue(workspaceDraft.slug).toLowerCase();
  if (!name || name.length > 120 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    accessFailure = { title: "Workspace details needed", message: "Enter a name of 120 characters or fewer and an address using letters, numbers, and hyphens, starting and ending with a letter or number." };
    pendingFocusId = !name || name.length > 120 ? "workspace-name" : "workspace-slug";
    render();
    return;
  }
  workspaceCreationOpen = true;
  const intent = JSON.stringify({ name, slug });
  const knownWorkspaceIds = uncertainWorkspaceCreations.get(intent) || new Set(workspaceChoices.map((workspace) => workspace.id));
  setWorkspaceMutationsDisabled(true, "workspace");
  accessFailure = null;
  render();
  try {
    try {
      const payload = objectValue(await api("/workspaces", { method: "POST", body: { name, slug } }));
      const workspace = normalizeWorkspaceAccess(payload.workspace);
      if (!workspace.id || workspace.slug !== slug || !workspace.url) throw new Error("The Workspace creation response was incomplete.");
      createdWorkspace = workspace;
      workspaceChoices = [...workspaceChoices.filter((candidate) => candidate.id !== workspace.id), workspace];
    } catch (error) {
      const previouslyUnconfirmed = uncertainWorkspaceCreations.has(intent);
      if (outcomeIsUnconfirmed(error)) uncertainWorkspaceCreations.set(intent, knownWorkspaceIds);
      if (!outcomeIsUnconfirmed(error) && !(previouslyUnconfirmed && error instanceof ApiError && error.status === 409)) throw error;
      try { await loadWorkspaceChoices(); }
      catch (inventoryError) {
        if (inventoryError instanceof ApiError && inventoryError.status === 401) throw inventoryError;
        throw new Error("Workspace creation could not be confirmed. Retry the same name and address when your connection is available.");
      }
      createdWorkspace = workspaceChoices.find((workspace) => !knownWorkspaceIds.has(workspace.id) && workspace.slug === slug && workspace.name === name) || null;
      if (!createdWorkspace) throw error;
    }
    uncertainWorkspaceCreations.delete(intent);
    await openWorkspace(createdWorkspace.slug, createdWorkspace);
  } catch (error) {
    if (handlePrivateError(error)) return;
    accessFailure = {
      title: createdWorkspace ? "Workspace created; opening failed" : outcomeIsUnconfirmed(error) ? "Workspace creation could not be confirmed" : "Workspace was not created",
      message: outcomeIsUnconfirmed(error) && !createdWorkspace ? "Retry with the same address to check or finish creation. " + (error instanceof Error ? error.message : "Try again.") : error instanceof Error ? error.message : "Try again."
    };
    pendingFocusId = "workspace-route-status";
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

function normalizeAgentConnection(value: unknown): AgentConnection {
  const item = objectValue(value);
  return { id: String(item.id || ""), label: String(item.label || ""), scopes: arrayValue(item.scopes).map(String), createdAt: String(item.createdAt || ""), lastUsedAt: item.lastUsedAt ? String(item.lastUsedAt) : null, expiresAt: item.expiresAt ? String(item.expiresAt) : null, revokedAt: item.revokedAt ? String(item.revokedAt) : null };
}

async function loadAgentConnections(): Promise<void> {
  const payload = objectValue(await api("/agent-connections"));
  agentConnections = arrayValue(payload.connections).map(normalizeAgentConnection);
}

async function createAgentConnection(form: HTMLFormElement): Promise<void> {
  if (mutationInFlight) return;
  const data = new FormData(form);
  const selectedScopes = String(data.get("scopes") || "");
  const scopes = selectedScopes === "read-write" ? ["read", "write"] : [selectedScopes].filter(Boolean);
  const expiryValue = cleanValue(String(data.get("expiresAt") || ""));
  const expiresAt = expiryValue ? new Date(expiryValue).toISOString() : null;
  setWorkspaceMutationsDisabled(true, "agent");
  render();
  try {
    const payload = objectValue(await api("/agent-connections", { method: "POST", body: { label: cleanValue(String(data.get("label") || "")), scopes, expiresAt } }));
    issuedAgentCredential = String(payload.credential || "");
    agentNeedsVerification = false;
    await loadAgentConnections();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) agentNeedsVerification = true;
    else throw error;
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function revokeAgentConnection(connectionId: string): Promise<void> {
  if (mutationInFlight) return;
  setWorkspaceMutationsDisabled(true, "agent");
  render();
  try {
    await api(`/agent-connections/${safeId(connectionId)}`, { method: "DELETE" });
    issuedAgentCredential = "";
    await loadAgentConnections();
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}


async function fetchProject(projectId: string): Promise<Project> {
  const [projectPayload, activityPayload] = await Promise.all([
    api(`/projects/${safeId(projectId)}`),
    api(`/projects/${safeId(projectId)}/activity`).catch((error) => {
      if (error instanceof ApiError && error.status === 401) throw error;
      return null;
    })
  ]);
  const project = normalizeProject(projectPayload);
  const activityRecord = objectValue(activityPayload);
  const activity = Array.isArray(activityPayload) ? activityPayload : arrayValue(activityRecord.activity ?? activityRecord.events);
  if (activity.length) project.activity = activity.map(normalizeActivity);
  return project;
}

function reconcileProjectContext(project: Project): void {
  activeProject = project;
  displayedAt.set(project.id, new Date().toISOString());
  try { window.localStorage.setItem("kanban.cards:project-id", project.id); } catch { /* Project selection is optional. Draft persistence reports its own failures. */ }
  if (selectedCardId) {
    const selected = project.cards.find((card) => card.id === selectedCardId);
    if (!selected) {
      selectedCardId = null;
      creatingCard = false;
      resetMoveContext();
      cardStatus = { tone: "warning", title: "Card no longer active", message: "The selected Card is no longer on this active Project." };
    } else {
      mobileColumns.set(project.id, selected.columnId);
      const key = draftKey(project.id, selected.id);
      const draft = retainedDrafts.get(key);
      if (draft) {
        retainedDrafts.set(key, mergeCardDraft(draft, selected));
      } else if (selected.archivedAt && !draft) {
        selectedCardId = null;
        creatingCard = false;
        resetMoveContext();
        cardStatus = { tone: "warning", title: "Card no longer active", message: "The selected Card is archived and no longer appears on the active board." };
      }
    }
  }
  const currentMobile = mobileColumns.get(project.id);
  if (!currentMobile || !project.columns.some((column) => column.id === currentMobile)) {
    mobileColumns.set(project.id, project.columns[0]?.id || "");
  }
}

async function loadProject(projectId: string): Promise<void> {
  reconcileProjectContext(await fetchProject(projectId));
}

async function loadProjects(preferredId?: string): Promise<void> {
  const payload = await api("/projects");
  const record = objectValue(payload);
  const list = Array.isArray(payload) ? payload : arrayValue(record.projects);
  const nextProjects = list.map(normalizeProjectSummary).filter((project) => project.id);
  if (!nextProjects.length) {
    projects = [];
    activeProject = null;
    return;
  }
  let storedId = "";
  try { storedId = window.localStorage.getItem("kanban.cards:project-id") || ""; } catch { /* Optional preference. */ }
  const candidateId = preferredId || activeProject?.id || storedId;
  const projectId = nextProjects.some((project) => project.id === candidateId) ? candidateId : nextProjects[0].id;
  const nextProject = await fetchProject(projectId);
  projects = nextProjects;
  reconcileProjectContext(nextProject);
}

async function refreshAfterMutation(projectId: string): Promise<void> {
  await loadProjects(projectId);
}

async function signIn(form: HTMLFormElement): Promise<void> {
  const token = cleanValue(formValue(formData(form), "token"));
  if (!token) return;
  form.reset();
  authNotice = null;
  setWorkspaceMutationsDisabled(true, "sign-in");
  render();
  try {
    await api("/session", { method: "POST", body: { token } });
    await loadSession();
    if (!session) throw new Error("The owner key was accepted, but no browser session was created.");
    await loadProjects();
    authNotice = null;
    projectStatus = null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearPrivateState({ kind: "invalid-key", title: "Owner key not accepted", message: "Check the key and try again. No Project information was opened." });
    } else {
      clearPrivateState({ kind: "service-unavailable", title: "kanban.cards is unavailable", message: "The service could not start a session. Your key was not retained; try again when the service is available." });
    }
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
    if (!session) {
      pendingFocusId = "owner-key";
      restorePendingContext();
    }
  }
}

async function signOut(): Promise<void> {
  const signingOutOwner = session?.ownerId;
  captureVisibleDrafts();
  sessionChannel?.postMessage("signed-out");
  signOutPending = true;
  render();
  try {
    await retainVisibleDrafts();
    clearPrivateState(null);
    const response = objectValue(await api("/session", { method: "DELETE", expectedOwnerId: signingOutOwner }));
    if (accessContext !== "local" && (response.signedOutHere !== true || response.globalSignOutComplete !== true)) throw new Error("Sign-out could not be confirmed.");
    if (accessContext !== "local" && rootUrl && rootUrl !== window.location.origin) {
      window.location.replace(`${rootUrl}/?signedout=1`);
      return;
    }
    clearPrivateState({ kind: "signed-out", title: "Signed out", message: "" });
  } catch {
    clearPrivateState({ kind: "sign-out-incomplete", title: "Sign-out could not be confirmed", message: "Private data left this screen. Retry sign out before leaving this device." });
  } finally {
    signOutPending = false;
    render();
    pendingFocusId = accessContext === "local" ? "owner-key" : "access-title";
    restorePendingContext();
  }
}

function openProjectEditor(mode: Exclude<ProjectEditorMode, null>, trigger: HTMLElement): void {
  const project = mode === "edit" ? activeProject : null;
  projectEditorMode = mode;
  projectEditorDraft = {
    mode,
    projectId: project?.id || null,
    name: project?.name || "",
    description: project?.description || "",
    columns: project
      ? project.columns.map((column) => ({ id: column.id, name: column.name }))
      : DEFAULT_COLUMNS.map((name) => ({ id: null, name }))
  };
  projectEditorDraft = projectDrafts.get(project?.id || "new") || projectEditorDraft;
  projectFieldErrors.clear();
  projectStatus = null;
  projectEditorReturnFocus = trigger.closest(".action-panel")
    ? { action: "toggle-project-actions", occurrence: 0 }
    : focusTargetFor(trigger);
  render();
  pendingFocusId = "project-name-input";
  restorePendingContext();
}

function cancelProjectEditor(): void {
  projectEditorMode = null;
  projectEditorDraft = null;
  projectFieldErrors.clear();
  projectStatus = null;
  showConfirmation("Project draft retained", "Your unsaved Project details will return when you open this editor.");
  pendingFocusRestore = projectEditorReturnFocus;
  projectEditorReturnFocus = null;
  render();
}

async function openAddColumnEditor(trigger: HTMLElement): Promise<void> {
  const projectId = activeProject?.id;
  if (!projectId) return;
  addColumnCommitted = false;
  addColumnReturnFocus = focusTargetFor(trigger);
  const cardForm = document.querySelector<HTMLFormElement>("form[data-form='card']");
  if (cardForm) captureCardDraft(cardForm);
  addColumnPreparing = true;
  setWorkspaceMutationsDisabled(true, "column");
  pendingFocusId = selectedCardId || creatingCard
    ? cardOnlyQuery.matches ? "add-column-preparing-status" : "add-column-status"
    : "add-column-status";
  render();
  await retainVisibleDrafts();
  if (!session) return;
  if (cardConflict || moveConflict || recoveryStore.failure) {
    addColumnPreparing = false;
    setWorkspaceMutationsDisabled(false);
    inspectorTab = "card";
    if (!cardStatus) {
      cardStatus = {
        tone: "warning",
        title: "Add Column paused",
        message: "The Card still has unsaved changes. Correct or retry that save before adding a Column."
      };
    }
    pendingFocusId = selectedCardId || creatingCard ? "card-title-input" : "main-content";
    addColumnReturnFocus = null;
    render();
    return;
  }
  try {
    await loadProject(projectId);
  } catch (error) {
    addColumnPreparing = false;
    setWorkspaceMutationsDisabled(false);
    if (handlePrivateError(error)) return;
    const status: StatusMessage = { tone: "error", title: "Add Column did not open", message: `The latest Project could not be loaded. ${error instanceof Error ? error.message : "Try again."}` };
    if (selectedCardId || creatingCard) {
      cardStatus = status;
      inspectorTab = "card";
      pendingFocusId = "card-status";
    } else {
      projectStatus = status;
      pendingFocusId = "project-status";
    }
    addColumnReturnFocus = null;
    render();
    return;
  }
  const project = activeProject;
  if (!project || project.id !== projectId) {
    addColumnPreparing = false;
    setWorkspaceMutationsDisabled(false);
    projectStatus = { tone: "warning", title: "Add Column did not open", message: "The active Project changed before the latest Columns could be loaded." };
    pendingFocusId = "project-status";
    addColumnReturnFocus = null;
    render();
    return;
  }
  addColumnPreparing = false;
  addColumnDraft = {
    projectId: project.id,
    revision: project.revision,
    columns: project.columns.map((column) => ({ ...column })),
    id: `column-${uniqueKey()}`,
    name: "",
    outcomeUnconfirmed: false
  };
  addColumnFieldError = "";
  projectStatus = null;
  setWorkspaceMutationsDisabled(false);
  render();
  pendingFocusId = "add-column-name";
  restorePendingContext();
}

function cancelAddColumn(): void {
  const outcomeUnconfirmed = Boolean(addColumnDraft?.outcomeUnconfirmed);
  const name = cleanValue(addColumnDraft?.name || "The Column");
  addColumnPreparing = false;
  addColumnCommitted = false;
  addColumnDraft = null;
  addColumnFieldError = "";
  if (outcomeUnconfirmed) {
    projectStatus = { tone: "warning", title: "Column outcome unconfirmed", message: `${name} may already be stored. Refresh the Project before trying again.` };
  } else {
    projectStatus = null;
    showConfirmation("Column unchanged", "No Column was added.");
  }
  pendingFocusRestore = null;
  if ((selectedCardId || creatingCard) && cardOnlyQuery.matches) {
    pendingFocusId = inspectorTab === "activity" && selectedCardId ? "activity-panel" : "card-title-input";
  } else {
    pendingFocusRestore = addColumnReturnFocus;
  }
  addColumnReturnFocus = null;
  render();
}

function validateAddColumnDraft(draft: AddColumnDraft): boolean {
  addColumnFieldError = cleanValue(draft.name) ? "" : "Enter a Column name.";
  if (!addColumnFieldError) return true;
  pendingFocusId = "add-column-name";
  projectStatus = { tone: "error", title: "Column needs attention", message: "Enter a name before adding the Column." };
  render();
  return false;
}

async function saveAddColumn(form: HTMLFormElement): Promise<void> {
  captureAddColumnDraft(form);
  const draft = addColumnDraft;
  const project = activeProject;
  if (!draft || draft.outcomeUnconfirmed || !project || project.id !== draft.projectId || !validateAddColumnDraft(draft)) return;
  const name = cleanValue(draft.name);
  const newPosition = Math.max(-1, ...draft.columns.map((column) => column.position)) + 1;
  const columns = [
    ...draft.columns.map((column) => ({ id: column.id, name: column.name, position: column.position })),
    { id: draft.id, name, position: newPosition }
  ];
  setWorkspaceMutationsDisabled(true, "column");
  projectStatus = { tone: "neutral", title: "Adding Column", message: "Conflicting actions are unavailable until the Project update finishes." };
  pendingFocusId = "add-column-status";
  render();
  try {
    const response = await api(`/projects/${safeId(draft.projectId)}`, {
      method: "PATCH",
      revision: draft.revision,
      body: { columns }
    });
    const updated = normalizeProject(response);
    completePatch(`/projects/${safeId(draft.projectId)}`);
    applyProjectSnapshot(updated);
    mobileColumns.set(updated.id, draft.id);
    selectedCardId = null;
    creatingCard = false;
    creatingColumnId = "";
    cardStatus = null;
    cardConflict = null;
    resetMoveContext();
    inspectorTab = "card";
    resetDescriptionContext();
    addColumnCommitted = true;
    addColumnDraft = null;
    addColumnFieldError = "";
    addColumnReturnFocus = null;
    pendingFocusId = "add-column-status";
    render();
    const refreshError = await refreshCommittedProject(updated.id);
    if (session) {
      addColumnCommitted = false;
      pendingFocusId = `column-${safeId(draft.id)}`;
      if (refreshError) {
        projectStatus = { tone: "warning", title: "Column added; refresh needed", message: `${name} is stored and visible from the write response. Refresh failed: ${refreshError}` };
      } else {
        projectStatus = null;
        showConfirmation("Column added", `${name} is ready for Cards.`);
      }
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
      projectStatus = { tone: "warning", title: "Column was not added", message: "This Project changed elsewhere. Your Column name is still here. Cancel, refresh the Project, and try again." };
      pendingFocusId = "add-column-status";
    } else if (outcomeIsUnconfirmed(error)) {
      addColumnDraft = { ...draft, name, outcomeUnconfirmed: true };
      projectStatus = { tone: "warning", title: "Column outcome unconfirmed", message: "Your Column name is still here. Cancel and refresh the Project before trying again." };
      pendingFocusId = "add-column-status";
    } else {
      projectStatus = { tone: "error", title: "Column was not added", message: `Your Column name is still here. ${error instanceof Error ? error.message : "Try again."}` };
      pendingFocusId = "add-column-name";
    }
  } finally {
    addColumnCommitted = false;
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

function validateProjectDraft(draft: ProjectEditorDraft): boolean {
  projectFieldErrors.clear();
  if (!cleanValue(draft.name)) projectFieldErrors.set("name", "Enter a Project name before saving.");
  draft.columns.forEach((column, index) => {
    if (!cleanValue(column.name)) projectFieldErrors.set(`column-${index}`, `Enter a name for ${ordinalLabel(index).toLowerCase()} Column.`);
  });
  if (!projectFieldErrors.size) return true;
  const firstKey = projectFieldErrors.keys().next().value as string;
  pendingFocusId = firstKey === "name" ? "project-name-input" : `project-column-${firstKey.split("-")[1]}`;
  projectStatus = { tone: "error", title: "Project needs attention", message: "Correct the marked fields before saving." };
  render();
  return false;
}

async function saveProject(form: HTMLFormElement): Promise<void> {
  captureProjectDraft(form);
  const draft = projectEditorDraft;
  if (!draft || (!(draft.mode === "create" && pendingIdempotencyKeys.has("project:create")) && !validateProjectDraft(draft))) return;
  setWorkspaceMutationsDisabled(true, "project");
  projectStatus = { tone: "neutral", title: "Saving Project", message: "Conflicting actions are unavailable until the save finishes." };
  render();
  try {
    if (draft.mode === "create") {
      const body = {
        name: cleanValue(draft.name),
        description: cleanValue(draft.description),
        columns: draft.columns.map((column, position) => ({ name: cleanValue(column.name), position }))
      };
      const idempotencyScope = "project:create";
      const response = await api("/projects", {
        method: "POST",
        idempotencyKey: idempotencyKeyFor(idempotencyScope, body),
        body
      });
      const created = normalizeProject(response);
      if (!created.id) throw new Error("The Project was created without an id.");
      const submitted = JSON.parse(pendingIdempotencyKeys.get(idempotencyScope)!.fingerprint);
      projectDrafts.delete("new");
      if (cleanValue(draft.name) !== submitted.name || cleanValue(draft.description) !== submitted.description || draft.columns.some((column, index) => cleanValue(column.name) !== submitted.columns[index]?.name)) projectDrafts.set(created.id, { ...draft, mode: "edit", projectId: created.id, columns: draft.columns.map((column, index) => ({ ...column, id: created.columns[index]?.id || null })) });
      clearIdempotencyKey(idempotencyScope);
      projectEditorMode = null;
      projectEditorDraft = null;
      projectEditorReturnFocus = null;
      applyProjectSnapshot(created);
      const refreshError = await refreshCommittedProject(created.id);
      if (session) {
        if (refreshError) {
          projectStatus = { tone: "warning", title: "Project created; refresh needed", message: `${created.name} is stored and visible from the write response. Refresh failed: ${refreshError}` };
        } else {
          projectStatus = null;
          showConfirmation("Project created", `${created.name} is ready for Cards.`);
        }
      }
    } else {
      const project = activeProject;
      if (!project) return;
      const body = { name: cleanValue(draft.name), description: cleanValue(draft.description), columns: draft.columns.map((column, position) => ({ id: column.id, name: cleanValue(column.name), position })) };
      const submitted = pendingPatches.get(`/projects/${safeId(project.id)}`)?.body || body;
      const response = await api(`/projects/${safeId(project.id)}`, { method: "PATCH", revision: project.revision, body });
      const updated = normalizeProject(response);
      projectDrafts.delete(project.id);
      if (JSON.stringify(body) !== JSON.stringify(submitted)) projectDrafts.set(project.id, draft);
      completePatch(`/projects/${safeId(project.id)}`);
      projectEditorMode = null;
      projectEditorDraft = null;
      projectEditorReturnFocus = null;
      applyProjectSnapshot(updated);
      const refreshError = await refreshCommittedProject(project.id);
      if (session) {
        if (refreshError) {
          projectStatus = { tone: "warning", title: "Project updated; refresh needed", message: `The update is stored and visible from the write response. Refresh failed: ${refreshError}` };
        } else {
          projectStatus = null;
          showConfirmation("Project updated", "The stored Project and ordered Columns now match these changes.");
        }
      }
    }
    if (session) pendingFocusId = "project-select";
  } catch (error) {
    if (handlePrivateError(error)) return;
    if (draft.mode === "create" && !outcomeIsUnconfirmed(error)) clearIdempotencyKey("project:create");
    projectStatus = draft.mode === "create" && outcomeIsUnconfirmed(error)
      ? { tone: "warning", title: "Project outcome unconfirmed", message: `The safe retry key is retained. Retry unchanged. ${error instanceof Error ? error.message : "The response was unavailable."}` }
      : { tone: "error", title: "Project was not saved", message: error instanceof Error ? error.message : "Try again." };
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

function openCard(cardId: string, trigger: HTMLElement, allowArchived = false): void {
  const project = activeProject;
  const card = project?.cards.find((candidate) => candidate.id === cardId && (allowArchived || !candidate.archivedAt));
  if (!project || !card) return;
  selectedCardId = card.id;
  creatingCard = false;
  creatingColumnId = "";
  mobileColumns.set(project.id, card.columnId);
  cardReturnFocus = focusTargetFor(trigger);
  boardScrollPositions.set(project.id, window.scrollY);
  cardFieldErrors.clear();
  commentFieldError = "";
  const key = draftKey(project.id, card.id);
  const draft = retainedDrafts.get(key);
  cardConflict = null;
  if (draft) retainedDrafts.set(key, mergeCardDraft(draft, card));
  const hasStoredConflict = Boolean(cardConflict);
  cardStatus = hasStoredConflict ? { tone: "warning", title: "Stored Card changed", message: "Choose a value for each conflicting field. Your other changes are retained." } : null;
  resetMoveContext();
  inspectorTab = "card";
  resetDescriptionContext();
  accountPanelOpen = false;
  projectActionsOpen = false;
  render();
  pendingFocusId = hasStoredConflict ? "stale-heading" : "card-title-input";
  restorePendingContext();
}

function openNewCard(columnId: string, trigger: HTMLElement): void {
  const project = activeProject;
  if (!project) return;
  selectedCardId = null;
  creatingCard = true;
  creatingColumnId = columnId || project.columns[0]?.id || "";
  mobileColumns.set(project.id, creatingColumnId);
  cardReturnFocus = trigger.closest(".action-panel")
    ? { action: "toggle-project-actions", occurrence: 0 }
    : focusTargetFor(trigger);
  boardScrollPositions.set(project.id, window.scrollY);
  cardFieldErrors.clear();
  cardStatus = null;
  cardConflict = null;
  resetMoveContext();
  inspectorTab = "card";
  resetDescriptionContext();
  accountPanelOpen = false;
  projectActionsOpen = false;
  render();
  pendingFocusId = "card-title-input";
  restorePendingContext();
}

function closeCard(): void {
  const project = activeProject;
  if (!project) return;
  const cardId = selectedCardId;
  const key = draftKey(project.id, cardId);
  if (retainedDrafts.has(key)) {
    projectStatus = null;
    showConfirmation("Draft retained", "Your unsaved Card changes will return when you open this Card again.");
  }
  selectedCardId = null;
  creatingCard = false;
  creatingColumnId = "";
  cardStatus = null;
  cardConflict = null;
  resetMoveContext();
  inspectorTab = "card";
  resetDescriptionContext();
  pendingFocusRestore = cardReturnFocus || (cardId ? { action: "open-card", cardId, occurrence: 0 } : null);
  pendingScrollRestore = boardScrollPositions.get(project.id) ?? null;
  cardReturnFocus = null;
  render();
}

function validateCardDraft(draft: CardDraft): boolean {
  cardFieldErrors.clear();
  if (!cleanValue(draft.title)) cardFieldErrors.set("title", "Enter a Card title before saving.");
  if (!cardFieldErrors.size) return true;
  descriptionView = "write";
  pendingFocusId = "card-title-input";
  cardStatus = { tone: "error", title: "Card needs attention", message: "Correct the marked fields before saving." };
  render();
  return false;
}

async function retainVisibleDrafts(): Promise<void> { captureVisibleDrafts(); }
function captureVisibleDrafts(): void {
  if (mutationInFlight) return;
  const card = root.querySelector<HTMLFormElement>("form[data-form='card']");
  if (card) captureCardDraft(card);
  const project = root.querySelector<HTMLFormElement>("form[data-form='project']");
  if (project) captureProjectDraft(project);
}

function showDescriptionView(nextView: DescriptionView): void {
  const previewUnavailable = Boolean(cardConflict || moveConflict || (cardStatus && (cardStatus.tone === "error" || cardStatus.title.includes("outcome unconfirmed"))));
  if (nextView === "preview" && previewUnavailable) return;
  if (descriptionView === "write") captureDescriptionSelection();
  const form = document.querySelector<HTMLFormElement>("form[data-form='card']");
  if (form) captureCardDraft(form);
  descriptionView = nextView;
  pendingFocusId = nextView === "preview" ? "description-preview-tab" : "description-write-tab";
  render();
}

function toggleMovePanel(): void {
  const project = activeProject;
  const card = selectedCardId ? project?.cards.find((candidate) => candidate.id === selectedCardId) : null;
  if (!project || !card || cardConflict || moveConflict) return;
  const destinations = project.columns.filter((column) => column.id !== card.columnId);
  if (!destinations.length) return;
  movePanelOpen = !movePanelOpen;
  if (movePanelOpen && !destinations.some((column) => column.id === moveDestinationId)) {
    moveDestinationId = destinations[0].id;
  }
  pendingFocusId = movePanelOpen ? `move-to-${safeId(moveDestinationId)}` : "move-card-trigger";
  render();
}

function cancelMove(): void {
  const hadConflict = Boolean(moveConflict);
  resetMoveContext();
  if (hadConflict) {
    cardStatus = null;
    showConfirmation("Move canceled", "The Card remains in its latest stored Column.");
  }
  pendingFocusId = "move-card-trigger";
  render();
}

async function moveCard(destinationColumnId: string, explicitRetry = false): Promise<void> {
  const initialProject = activeProject;
  const initialCard = selectedCardId ? initialProject?.cards.find((candidate) => candidate.id === selectedCardId) : null;
  const initialDestination = initialProject?.columns.find((column) => column.id === destinationColumnId);
  if (!initialProject || !initialCard || !initialDestination || cardConflict) return;
  if (moveConflict && (!explicitRetry || moveConflict.destinationColumnId !== initialDestination.id)) return;
  if (initialCard.columnId === initialDestination.id) {
    mobileColumns.set(initialProject.id, initialDestination.id);
    resetMoveContext();
    cardStatus = null;
    showConfirmation("Card already moved", `${initialCard.title} is already in ${initialDestination.name}.`);
    pendingFocusId = "move-card-trigger";
    render();
    return;
  }

  let project = initialProject;
  let card = initialCard;
  let destination = initialDestination;
  const retryingConflict = Boolean(moveConflict);
  moveDestinationId = destination.id;
  if (!retryingConflict) movePanelOpen = true;
  setWorkspaceMutationsDisabled(true, "move");
  cardStatus = { tone: "neutral", title: "Preparing move", message: `Your text draft stays local while ${card.title} moves to ${destination.name}.` };
  pendingFocusId = "card-status";
  render();
  try {
    await retainVisibleDrafts();
    if (!session) return;
    const latestProject = activeProject;
    const latestCard = selectedCardId ? latestProject?.cards.find((candidate) => candidate.id === selectedCardId) : null;
    const latestDestination = latestProject?.columns.find((column) => column.id === destinationColumnId);
    if (!latestProject || !latestCard || !latestDestination) {
      resetMoveContext();
      cardStatus = null;
      projectStatus = { tone: "warning", title: "Move not completed", message: "The Card or destination is no longer active. Refresh the Project before choosing another move." };
      pendingFocusId = "project-status";
      return;
    }
    if (cardConflict) {
      movePanelOpen = false;
      moveDestinationId = destinationColumnId;
      return;
    }
    project = latestProject;
    card = latestCard;
    destination = latestDestination;
    if (card.columnId === destination.id) {
      mobileColumns.set(project.id, destination.id);
      resetMoveContext();
      cardStatus = null;
      showConfirmation("Card already moved", `${card.title} is already in ${destination.name}.`);
      pendingFocusId = "move-card-trigger";
      return;
    }

    moveConflict = null;
    movePanelOpen = true;
    cardStatus = { tone: "neutral", title: "Moving Card", message: `Moving ${card.title} to ${destination.name}. Conflicting actions are unavailable until the move finishes.` };
    pendingFocusId = "card-status";
    render();
    observedWrite = false;
    const response = await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
      method: "PATCH", revision: card.version, body: { columnId: destination.id }
    });
    const movedCard = applyCardMutationResponse(project.id, response);
    completePatch(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`);
    const local = retainedDrafts.get(draftKey(project.id, card.id));
    if (local) retainedDrafts.set(draftKey(project.id, card.id), mergeCardDraft({ ...local, columnId: movedCard.columnId, position: movedCard.position }, movedCard));
    if (!observedWrite) recordBrowserActivity(project, `Moved ${movedCard.title} to ${destination.name}.`, movedCard.id);
    mobileColumns.set(project.id, destination.id);
    movePanelOpen = false;
    moveDestinationId = "";
    const refreshError = await refreshCommittedProject(project.id);
    if (session) {
      if (refreshError) {
        cardStatus = { tone: "warning", title: "Card moved; refresh needed", message: `${movedCard.title} is stored in ${destination.name} and remains visible from the write response. Refresh failed: ${refreshError}` };
        projectStatus = { tone: "warning", title: "Project refresh needed", message: "The move committed; use Refresh to reconcile the latest Project Activity." };
      } else {
        cardStatus = null;
        projectStatus = null;
        showConfirmation(observedWrite ? "Saved destination observed" : "Card moved", observedWrite ? "The latest Column matches the original move. The original request outcome and actor are not confirmed." : `${movedCard.title} moved to ${destination.name}.`);
      }
      pendingFocusId = "move-card-trigger";
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
      let latestLoaded = false;
      try {
        await loadProject(project.id);
        latestLoaded = true;
      } catch (refreshError) {
        if (handlePrivateError(refreshError)) return;
      }
      const latestCard = activeProject?.id === project.id
        ? activeProject.cards.find((candidate) => candidate.id === card.id)
        : null;
      if (latestLoaded && (!latestCard || latestCard.archivedAt || selectedCardId !== card.id)) {
        resetMoveContext();
        cardStatus = null;
        projectStatus = {
          tone: "warning",
          title: "Move not completed",
          message: latestCard?.archivedAt
            ? `${latestCard.title} is archived and no longer appears on the active board.`
            : "The Card is no longer active in this Project."
        };
        pendingFocusId = "project-status";
      } else if (latestLoaded && latestCard?.columnId === destination.id) {
        mobileColumns.set(project.id, destination.id);
        resetMoveContext();
        cardStatus = null;
        showConfirmation("Card moved", `${latestCard.title} is now in ${destination.name}.`);
        pendingFocusId = "move-card-trigger";
      } else {
        moveConflict = { projectId: project.id, cardId: card.id, destinationColumnId: destination.id, latestLoaded };
        movePanelOpen = false;
        moveDestinationId = destination.id;
        inspectorTab = "card";
        cardStatus = latestLoaded
          ? { tone: "warning", title: "Move needs review", message: `The stored Card changed. The requested destination, ${destination.name}, is retained for an explicit retry or cancel.` }
          : { tone: "warning", title: "Latest Card unavailable", message: `The requested destination, ${destination.name}, is retained. Refresh the latest stored Card before retrying.` };
        pendingFocusId = "move-conflict-heading";
      }
    } else {
      movePanelOpen = true;
      moveDestinationId = destination.id;
      cardStatus = outcomeIsUnconfirmed(error)
        ? { tone: "warning", title: "Move outcome unconfirmed", message: `The requested destination, ${destination.name}, is retained. Refresh before retrying. ${error instanceof Error ? error.message : "The response was unavailable."}` }
        : { tone: "error", title: "Card was not moved", message: `The requested destination, ${destination.name}, is retained. ${error instanceof Error ? error.message : "Try again."}` };
      pendingFocusId = `move-to-${safeId(destination.id)}`;
    }
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function saveCard(form: HTMLFormElement | null, explicitRetry = false): Promise<void> {
  const project = activeProject;
  if (!project) return;
  let card = selectedCardId ? project.cards.find((candidate) => candidate.id === selectedCardId) || null : null;
  if (cardConflict && !(card && pendingPatches.has(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`))) return;
  const key = draftKey(project.id, card?.id || null);
  const captured = form ? captureCardDraft(form) : null;
  let draft = captured || retainedDrafts.get(key) || storedCardDraft(project, card);
  if (!(card === null && pendingIdempotencyKeys.has(`card:create:${project.id}`)) && !validateCardDraft(draft)) return;
  retainedDrafts.set(key, draft);
  setWorkspaceMutationsDisabled(true, "card");
  cardStatus = { tone: "neutral", title: "Saving Card", message: "Conflicting actions are unavailable until the save finishes." };
  render();
  try {
    observedWrite = false;
    let storedCard: ProjectCard;
    let submittedFields: Record<string, unknown> = {};
    if (card) {
      const originalPatch = pendingPatches.get(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`);
      if (originalPatch && patchIntentKind(originalPatch.body) !== "card-text") {
        cardStatus = { tone: "warning", title: "Earlier change needs review", message: "Read back the original placement or archive change before saving text. Your text draft remains local." };
        return;
      }
      const latest = await fetchProject(project.id);
      const latestCard = latest.cards.find(candidate => candidate.id === card!.id);
      if (!latestCard) throw new Error("The Card is unavailable. Your draft remains local.");
      applyProjectSnapshot(latest);
      if (!originalPatch) draft = mergeCardDraft(draft, latestCard);
      retainedDrafts.set(key, draft);
      card = latestCard;
      if ((!originalPatch && cardConflict) || card.archivedAt) {
        cardStatus = { tone: "warning", title: card.archivedAt ? "Card is archived" : "Stored Card changed", message: card.archivedAt ? "Your draft remains local. Restore the Card separately before saving." : "Choose a value for each conflicting field before saving." };
        pendingFocusId = "stale-heading";
        return;
      }
      if (!originalPatch && sameDraft(draft, storedCardDraft(latest, card))) {
        retainedDrafts.delete(key); cardStatus = null; showConfirmation("No unsaved changes", "The fields already match the latest saved Card."); return;
      }
      const body: Record<string, unknown> = {
        title: cleanValue(draft.title),
        body: cardBodyValue(draft.body),
        ...cardFieldsPayload(draft)
      };

      submittedFields = originalPatch?.body || body;
      const response = await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
        method: "PATCH",
        revision: originalPatch?.revision ?? card.version,
        body: submittedFields
      });
      storedCard = applyCardMutationResponse(project.id, response);
      if (!observedWrite) recordBrowserActivity(project, `Updated ${storedCard.title}.`, storedCard.id);
    } else {
      const body = { title: cleanValue(draft.title), body: cardBodyValue(draft.body), columnId: draft.columnId, ...cardFieldsPayload(draft) };
      const idempotencyScope = `card:create:${project.id}`;
      const requestKey = idempotencyKeyFor(idempotencyScope, body);
      submittedFields = JSON.parse(pendingIdempotencyKeys.get(idempotencyScope)!.fingerprint);
      const response = await api(`/projects/${safeId(project.id)}/cards`, {
        method: "POST", idempotencyKey: requestKey, body: submittedFields
      });
      storedCard = applyCardMutationResponse(project.id, response);
      creatingCard = false;
      creatingColumnId = "";
      recordBrowserActivity(project, `Created card ${storedCard.title}.`, storedCard.id);
    }
    retainedDrafts.delete(key);
    const laterChanges = cardTextFields.some(field => objectValue(draft)[field] !== submittedFields[field]);
    if (laterChanges) retainedDrafts.set(draftKey(project.id, storedCard.id), { ...rebaseDraft(draft, storedCard), cardId: storedCard.id, columnId: storedCard.columnId, position: storedCard.position });
    if (!card) clearIdempotencyKey(`card:create:${project.id}`);
    if (card) completePatch(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`);
    cardConflict = null;
    resetMoveContext();
    selectedCardId = storedCard.id;
    mobileColumns.set(project.id, storedCard.columnId);
    const refreshError = await refreshCommittedProject(project.id);
    if (session) {
      if (refreshError) {
        cardStatus = { tone: "warning", title: `${card ? "Card updated" : "Card created"}; refresh needed`, message: `The Card is stored and visible from the write response. Refresh failed: ${refreshError}` };
        projectStatus = { tone: "warning", title: "Project refresh needed", message: "The Card write committed; use Refresh to reconcile the latest Project state." };
      } else {
        cardStatus = null;
        projectStatus = null;
        showConfirmation(
          observedWrite ? "Saved state observed" : card ? "Card updated" : "Card created",
          observedWrite ? "The latest saved values match the original submission. The original request outcome and actor are not confirmed." : card ? "The visible Card and its Activity reflect the saved change." : "The new Card is visible in its Column and ready for Comments."
        );
      }
      pendingFocusId = "card-title-input";
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    descriptionView = "write";
    if (!card) {
      const idempotencyScope = `card:create:${project.id}`;
      if (!outcomeIsUnconfirmed(error)) clearIdempotencyKey(idempotencyScope);
      cardStatus = outcomeIsUnconfirmed(error)
        ? { tone: "warning", title: "Card outcome unconfirmed", message: `Your draft and safe retry key are retained. Retry unchanged. ${error instanceof Error ? error.message : "The response was unavailable."}` }
        : { tone: "error", title: "Card was not created", message: `Your draft is retained. ${error instanceof Error ? error.message : "Try again."}` };
      pendingFocusId = "card-title-input";
      return;
    }
    if (error instanceof ApiError && (error.status === 409 || error.status === 412) && card) {
      let latestLoaded = false;
      try {
        await loadProject(project.id);
        latestLoaded = true;
      } catch (refreshError) {
        if (handlePrivateError(refreshError)) return;
      }
      if (!latestLoaded) cardConflict = { projectId: project.id, cardId: card.id, latestLoaded: false };
      // loadProject already reconciled baseline/local/latest and computed field
      // choices. A version-only or nonoverlapping change must not invent a conflict.
      cardStatus = latestLoaded
        ? { tone: "warning", title: cardConflict ? "Stored Card changed" : "Latest Card loaded", message: cardConflict ? "Choose a value for each conflicting field. Your other edits are retained." : "Your draft includes the latest unrelated changes. Review it, then use Save." }
        : { tone: "warning", title: "Latest Card unavailable", message: "Your complete draft is retained. Refresh the latest stored Card before retrying." };
      pendingFocusId = cardConflict ? "stale-heading" : "card-title-input";
    } else {
      cardStatus = { tone: "error", title: "Card was not saved", message: `Your draft is retained. ${error instanceof Error ? error.message : "Try again."}` };
      pendingFocusId = "card-title-input";
    }
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function discardDraft(): Promise<void> {
  const project = activeProject;
  if (!project || !window.confirm("Revert this local draft? Saved changes will stay saved.")) return;
  const key = draftKey(project.id, selectedCardId);
  const path = selectedCardId ? `/projects/${safeId(project.id)}/cards/${safeId(selectedCardId)}` : "";
  if (path && pendingPatches.has(path)) { cardStatus = { tone: "warning", title: "Save outcome unconfirmed", message: "Use Save to read back the original submission before reverting." }; render(); return; }
  if (!selectedCardId && pendingIdempotencyKeys.has(`card:create:${project.id}`)) { cardStatus = { tone: "warning", title: "Create outcome unconfirmed", message: "Retry the original creation before discarding its draft." }; render(); return; }
  if (selectedCardId) await loadProject(project.id);
  retainedDrafts.delete(key);
  cardConflict = null; cardFieldErrors.clear(); cardStatus = null;
  showConfirmation("Draft reverted", "The fields show the latest saved Card.");
  pendingFocusId = "card-title-input";
  render();
}

function discardPendingPost(_scope: string): void {
  throw new Error("The original submission must be reconciled before its recovery identity can be discarded.");
}

async function addComment(form: HTMLFormElement): Promise<void> {
  await retainVisibleDrafts();
  const project = activeProject;
  const cardId = form.dataset.cardId || "";
  const card = project?.cards.find((candidate) => candidate.id === cardId);
  if (!project || !card) return;
  const body = formValue(formData(form), "body");
  const idempotencyScope = `comment:${project.id}:${card.id}`;
  if (!cleanValue(body) && !pendingIdempotencyKeys.has(idempotencyScope)) {
    commentFieldError = "Enter a Comment before adding it.";
    pendingFocusId = "comment-input";
    render();
    return;
  }
  commentDrafts.set(draftKey(project.id, card.id), body);
  commentFieldError = "";
  setWorkspaceMutationsDisabled(true, "comment");
  cardStatus = { tone: "neutral", title: "Adding Comment", message: "Conflicting actions are unavailable until the Comment is stored." };
  render();
  const requestBody = { body: cleanValue(body) };
  const requestKey = idempotencyKeyFor(idempotencyScope, requestBody);
  const submitted = JSON.parse(pendingIdempotencyKeys.get(idempotencyScope)!.fingerprint) as { body: string };
  try {
    const response = await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}/comments`, {
      method: "POST",
      idempotencyKey: requestKey,
      body: submitted
    });
    const record = objectValue(response);
    const storedComment = normalizeComment(record.comment);
    if (!card.comments.some((comment) => comment.id === storedComment.id)) card.comments.push(storedComment);
    const compactCard = objectValue(record.card);
    card.version = toRevision(compactCard.version, card.version);
    card.updatedAt = new Date().toISOString();
    project.revision = toRevision(record.projectRevision, project.revision);
    project.updatedAt = card.updatedAt;
    recordBrowserActivity(project, `${session?.label || "Owner"} commented on ${card.title}.`, card.id);
    syncProjectSummary(project);
    if (cleanValue(body) === submitted.body) commentDrafts.delete(draftKey(project.id, card.id));
    clearIdempotencyKey(idempotencyScope);
    selectedCardId = card.id;
    const refreshError = await refreshCommittedProject(project.id);
    if (session) {
      if (refreshError) {
        cardStatus = { tone: "warning", title: "Comment added; refresh needed", message: `The Comment is stored and visible. Activity could not be refreshed: ${refreshError}` };
      } else {
        cardStatus = null;
        projectStatus = null;
        showConfirmation("Comment added", "The Comment and Card-specific Activity are now visible.");
      }
      pendingFocusId = "comment-input";
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    if (!outcomeIsUnconfirmed(error)) clearIdempotencyKey(idempotencyScope);
    cardStatus = outcomeIsUnconfirmed(error)
      ? { tone: "warning", title: "Comment outcome unconfirmed", message: `Your Comment and safe retry key are retained. Retry unchanged. ${error instanceof Error ? error.message : "The response was unavailable."}` }
      : { tone: "error", title: "Comment was not added", message: `Your Comment is retained. ${error instanceof Error ? error.message : "Try again."}` };
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function archiveCard(cardId: string): Promise<void> {
  await retainVisibleDrafts();
  const project = activeProject;
  const card = project?.cards.find((candidate) => candidate.id === cardId);
  if (!project || !card) return;
  setWorkspaceMutationsDisabled(true, "archive");
  cardStatus = { tone: "neutral", title: "Archiving Card", message: "Conflicting actions are unavailable until the Card leaves the active board." };
  render();
  try {
    const response = await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
      method: "PATCH",
      revision: card.version,
      body: { archivedAt: new Date().toISOString() }
    });
    const archivedCard = applyCardMutationResponse(project.id, response);
    completePatch(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`);
    if (!observedWrite) recordBrowserActivity(project, `Archived ${archivedCard.title}.`, archivedCard.id);
    const receipts = archiveReceipts.get(project.id) || [];
    receipts.push({ key: uniqueKey(), projectId: project.id, cardId: archivedCard.id, cardTitle: archivedCard.title });
    archiveReceipts.set(project.id, receipts);
    selectedCardId = null;
    creatingCard = false;
    cardConflict = null;
    resetMoveContext();
    const refreshError = await refreshCommittedProject(project.id);
    if (session) {
      cardStatus = null;
      projectStatus = refreshError
        ? { tone: "warning", title: "Card archived; refresh needed", message: `The Card is stored as archived and Undo is available. Refresh failed: ${refreshError}` }
        : null;
      pendingFocusRestore = { action: "undo-archive", occurrence: 0 };
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    cardStatus = { tone: "error", title: "Card was not archived", message: error instanceof Error ? error.message : "Try again." };
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function undoArchive(): Promise<void> {
  const project = activeProject;
  const receipts = project ? archiveReceipts.get(project.id) || [] : [];
  const receipt = receipts.at(-1);
  const card = receipt ? project?.cards.find((candidate) => candidate.id === receipt.cardId) : null;
  if (!project || !receipt || !card) return;
  setWorkspaceMutationsDisabled(true, "undo");
  projectStatus = { tone: "neutral", title: "Restoring Card", message: "Conflicting actions are unavailable until the Card returns to its Column." };
  render();
  try {
    const response = await api(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`, {
      method: "PATCH",
      revision: card.version,
      body: { archivedAt: null }
    });
    const restoredCard = applyCardMutationResponse(project.id, response);
    completePatch(`/projects/${safeId(project.id)}/cards/${safeId(card.id)}`);
    recordBrowserActivity(project, `Updated ${restoredCard.title}.`, restoredCard.id);
    receipts.pop();
    if (receipts.length) archiveReceipts.set(project.id, receipts);
    else archiveReceipts.delete(project.id);
    const refreshError = await refreshCommittedProject(project.id);
    if (session) {
      if (refreshError) {
        projectStatus = { tone: "warning", title: "Card restored; refresh needed", message: `${receipt.cardTitle} returned to its Column from the write response. Refresh failed: ${refreshError}` };
      } else {
        projectStatus = null;
        showConfirmation("Card restored", `${receipt.cardTitle} returned to its stored Column.`);
      }
      pendingFocusRestore = { action: "open-card", cardId: restoredCard.id, occurrence: 0 };
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    projectStatus = { tone: "error", title: "Card was not restored", message: error instanceof Error ? error.message : "Refresh and try again." };
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function refreshProject(): Promise<void> {
  await retainVisibleDrafts();
  const project = activeProject;
  if (!project) return;
  projectLoading = true;
  setWorkspaceMutationsDisabled(true, "refresh");
  projectStatus = { tone: "neutral", title: "Refreshing Project", message: "Loading the latest stored state without discarding valid Card context." };
  render();
  try {
    await loadProjects(project.id);
    projectStatus = null;
    let refreshConfirmation = {
      title: "Refresh complete",
      message: "The displayed state now reflects the latest stored Project."
    };
    if (moveConflict && activeProject?.id === moveConflict.projectId) {
      const latestCard = activeProject.cards.find((candidate) => candidate.id === moveConflict?.cardId);
      const destination = activeProject.columns.find((column) => column.id === moveConflict?.destinationColumnId);
      if (latestCard && destination && latestCard.columnId === destination.id) {
        mobileColumns.set(activeProject.id, destination.id);
        resetMoveContext();
        cardStatus = null;
        refreshConfirmation = { title: "Card moved", message: `${latestCard.title} is now in ${destination.name}.` };
        pendingFocusId = "move-card-trigger";
      } else {
        moveConflict.latestLoaded = true;
        pendingFocusId = "move-conflict-heading";
      }
    }
    showConfirmation(refreshConfirmation.title, refreshConfirmation.message, "refresh-success");
  } catch (error) {
    if (handlePrivateError(error)) return;
    projectStatus = { tone: "error", title: "Refresh failed", message: `The previous displayed state remains visible. ${error instanceof Error ? error.message : "Try again."}` };
  } finally {
    projectLoading = false;
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

async function switchProject(projectId: string): Promise<void> {
  if (!projects.some((project) => project.id === projectId)) return;
  activityFeed = null;
  await retainVisibleDrafts();
  selectedCardId = null;
  creatingCard = false;
  creatingColumnId = "";
  cardStatus = null;
  cardConflict = null;
  resetMoveContext();
  inspectorTab = "card";
  workspaceMenuOpen = false;
  accountPanelOpen = false;
  projectActionsOpen = false;
  projectStatus = { tone: "neutral", title: "Opening Project", message: "Loading the selected Project without exposing stale workspace data." };
  setWorkspaceMutationsDisabled(true, "refresh");
  render();
  try {
    await loadProject(projectId);
    if (session) {
      projectStatus = null;
      pendingFocusId = "project-select";
    }
  } catch (error) {
    if (handlePrivateError(error)) return;
    projectStatus = { tone: "error", title: "Project did not open", message: error instanceof Error ? error.message : "Try again." };
    pendingFocusId = "project-select";
  } finally {
    setWorkspaceMutationsDisabled(false);
    render();
  }
}

function handlePrivateError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false;
  clearPrivateState({ kind: "session-expired", title: "Your session ended", message: "Private Project and Card data left the screen. Sign in again to continue." });
  if (accessContext === "local") pendingFocusId = "owner-key";
  else pendingFocusRestore = { action: "passkey-sign-in", occurrence: 0 };
  render();
  return true;
}

async function handleAction(button: HTMLElement): Promise<void> {
  const action = button.dataset.action || "";
  if (recoveryStore.failure && ["open-workspace", "choose-workspace", "new-workspace", "close-card", "cancel-project"].includes(action)) { syncRecoveryNotice(); return; }
  if (action === "read-back-patch") return readBackPendingPatch(button.dataset.patchPath || "");
  if (action === "retry-pending-post") {
    const scope = button.dataset.idempotencyScope || "";
    if (!pendingIdempotencyKeys.has(scope)) return;
    if (scope === "project:create") { const form = root.querySelector<HTMLFormElement>("form[data-form='project']"); if (form) return saveProject(form); }
    if (scope.startsWith("card:create:")) return saveCard(root.querySelector<HTMLFormElement>("form[data-form='card']"));
    if (scope.startsWith("comment:")) { const form = root.querySelector<HTMLFormElement>("form[data-form='comment']"); if (form) return addComment(form); }
    return;
  }
  if (action === "retry-local-storage") { recoveryStore.retry(); render(); return; }
  if (action === "copy-recovery") { await navigator.clipboard.writeText(recoveryStore.export()); showConfirmation("Recovery data copied", "The copy contains your local drafts and submission records. Keep it private."); render(); return; }
  if (action === "resolve-card-field") return resolveCardField(button.dataset.field || "", button.dataset.choice || "");
  if (action === "move-retained-placement") {
    if (cardConflict?.fields?.some(field => field !== "placement")) throw new Error("Resolve the text field conflicts before moving this Card.");
    cardConflict = null; return moveCard(button.dataset.columnId || "");
  }
  if (action === "restore-selected-card") return restoreSelectedCard();
  if (action === "recover-copy") { captureVisibleDrafts(); recoveryMaps.find(map => map.kind === button.dataset.recordKind)?.recover(button.dataset.recordId || "");
    if (button.dataset.recordKind === "project" && projectEditorDraft) projectEditorDraft = projectDrafts.get(projectEditorDraft.projectId || "new") || projectEditorDraft;
    render(); return; }
  if (action === "discard-comment" && activeProject && selectedCardId) {
    if (pendingIdempotencyKeys.has(`comment:${activeProject.id}:${selectedCardId}`)) throw new Error("Retry the original Comment before discarding its submission record.");
    if (window.confirm("Discard this unsent Comment?")) commentDrafts.delete(draftKey(activeProject.id, selectedCardId)); render(); return;
  }
  if (action === "clear-card-filters" && activeProject && !workspaceLocked()) {
    projectCardFilters.delete(activeProject.id);
    pendingFocusId = "board-filter-next-actor";
    render();
    return;
  }
  if (action === "new-workspace") return showWorkspaceRoute(true);
  if (action === "choose-workspace") return showWorkspaceRoute(false);
  if (action === "cancel-workspace") return cancelWorkspaceCreation();
  if (action === "passkey-sign-in") return beginPasskeyFlow("signin");
  if (action === "start-signup") return beginPasskeyFlow("signup");
  if (action === "start-recovery") return beginPasskeyFlow("recover");
  if (action === "start-setup") return beginPasskeyFlow("setup");
  if (action === "verify-identity") return beginPasskeyFlow("verify", "api-key");
  if (action === "add-passkey") return beginPasskeyFlow("add");
  if (action === "retry-global-sign-out") return signOut();
  if (action === "sign-out-everywhere") {
    try {
      await api("/sessions/all", { method: "DELETE" });
      clearPrivateState({ kind: "signed-out", title: "Signed out", message: "" });
      if (rootUrl !== window.location.origin) window.location.replace(`${rootUrl}/?signedout=1`);
      else render();
    } catch (error) {
      if (handlePrivateError(error)) return;
      accessStatus = { tone: "error", title: "Sign-out could not be confirmed", message: "Try again before leaving this device." }; render();
    }
    return;
  }
  if (action === "signed-out-continue") { authNotice = null; render(); return; }
  if (action === "copy-recovery-code") { await navigator.clipboard.writeText(recoveryCode); button.textContent = "Copied"; return; }
  if (action === "download-recovery-code") {
    const url = URL.createObjectURL(new Blob([`kanban.cards recovery code\n\n${recoveryCode}\n\nKeep this code private.\n`], { type: "text/plain" }));
    const link = document.createElement("a"); link.href = url; link.download = "kanban-cards-recovery-code.txt"; link.click(); URL.revokeObjectURL(url); return;
  }
  if (action === "continue-after-recovery") {
    recoveryCode = "";
    if (pendingAuthHandoff) { const handoff = pendingAuthHandoff; pendingAuthHandoff = null; submitAuthForm(handoff.destination, { handoffToken: handoff.token }); }
    else render();
    return;
  }
  if (action === "manage-access") {
    if (accessContext === "workspace") { window.location.assign(`${rootUrl}/?access=1`); return; }
    accessPanelOpen = true; await loadAccessSettings(); render(); return;
  }
  if (action === "close-access") { accessPanelOpen = false; accessStatus = null; render(); return; }
  if (action === "remove-passkey") return changeAccessSetting(`/passkeys/${safeId(button.dataset.passkeyId || "")}`, "DELETE");
  if (action === "end-session") return changeAccessSetting(`/sessions/${safeId(button.dataset.sessionId || "")}`, "DELETE");
  if (action === "replace-recovery-code") return changeAccessSetting("/recovery-code", "POST");
  if (action === "show-description-write" || action === "show-description-preview") {
    showDescriptionView(action === "show-description-preview" ? "preview" : "write");
    return;
  }
  if (mutationInFlight) return;
  if (projectEditorMode && !button.closest("#project-editor")) return;
  if (addColumnDraft && !button.closest("#add-column-editor")) return;
  if (action === "toggle-workspace-menu") {
    workspaceMenuOpen = !workspaceMenuOpen;
    accountPanelOpen = false;
    projectActionsOpen = false;
    pendingFocusRestore = { action: workspaceMenuOpen ? "choose-workspace" : "toggle-workspace-menu", occurrence: 0 };
    render();
    return;
  }
  if (action === "toggle-account-panel") {
    workspaceMenuOpen = false;
    accountPanelOpen = !accountPanelOpen;
    projectActionsOpen = false;
    pendingFocusRestore = accountPanelOpen
      ? { action: "sign-out", occurrence: 0 }
      : { action: "toggle-account-panel", occurrence: 0 };
    render();
    return;
  }
  if (action === "manage-agents") {
    activityFeed = null;
    accountPanelOpen = false;
    agentPanelOpen = true;
    issuedAgentCredential = "";
    await loadAgentConnections();
    render();
    return;
  }
  if (action === "close-agents") {
    agentPanelOpen = false;
    issuedAgentCredential = "";
    render();
    return;
  }
  if (action === "revoke-agent") return revokeAgentConnection(button.dataset.connectionId || "");
  if (action === "copy-agent-credential") {
    if (!issuedAgentCredential) return;
    await navigator.clipboard.writeText(issuedAgentCredential);
    issuedAgentCredential = "";
    render();
    return;
  }
  if (action === "clear-agent-credential") {
    issuedAgentCredential = "";
    render();
    return;
  }
  if (action === "show-workspace-activity") return openActivityFeed("workspace");
  if (action === "show-project-activity") return openActivityFeed("project");
  if (action === "close-activity-feed") return closeActivityFeed();
  if (action === "refresh-activity-feed") return loadActivityFeed();
  if (action === "retry-activity-feed") return loadActivityFeed(activityFeed?.retryMore);
  if (action === "load-more-activity") return loadActivityFeed(true);
  if (action === "toggle-project-actions") {
    workspaceMenuOpen = false;
    projectActionsOpen = !projectActionsOpen;
    accountPanelOpen = false;
    pendingFocusRestore = projectActionsOpen
      ? { action: "new-project", occurrence: 0 }
      : { action: "toggle-project-actions", occurrence: 0 };
    render();
    return;
  }
  if (action === "show-card-tab" || action === "show-activity-tab") {
    captureVisibleDrafts();
    if (action === "show-activity-tab" && (cardConflict || moveConflict)) return;
    inspectorTab = action === "show-activity-tab" ? "activity" : "card";
    pendingFocusId = inspectorTab === "activity" ? "activity-tab" : "card-tab";
    render();
    return;
  }
  if (action === "toggle-move-panel") return toggleMovePanel();
  if (action === "cancel-move") return cancelMove();
  if (action === "move-card") return moveCard(button.dataset.columnId || "");
  if (action === "retry-move") return moveCard(button.dataset.columnId || "", true);
  workspaceMenuOpen = false;
  accountPanelOpen = false;
  projectActionsOpen = false;
  if (action === "new-project") return openProjectEditor("create", button);
  if (action === "add-column") return openAddColumnEditor(button);
  if (action === "edit-project") return openProjectEditor("edit", button);
  if (action === "cancel-project") return cancelProjectEditor();
  if (action === "cancel-add-column") return cancelAddColumn();
  if (action === "new-card") return openNewCard(button.dataset.columnId || activeProject?.columns[0]?.id || "", button);
  if (action === "open-card") {
    await retainVisibleDrafts();
    return openCard(button.dataset.cardId || "", button);
  }
  if (action === "recover-draft") return openCard(button.dataset.cardId || "", button, true);
  if (action === "close-card") return closeCard();
  if (action === "refresh-project") return refreshProject();
  if (action === "retry-save") return saveCard(null, true);
  if (action === "discard-draft") return discardDraft();
  if (action === "discard-pending-post") return discardPendingPost(button.dataset.idempotencyScope || "");
  if (action === "archive-card") return archiveCard(button.dataset.cardId || "");
  if (action === "undo-archive") return undoArchive();
  if (action === "sign-out") return signOut();
  if (action === "open-workspace") return openWorkspace(button.dataset.workspaceSlug || "");
}

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]");
  if (!action) {
    if ((accountPanelOpen || projectActionsOpen || workspaceMenuOpen) && !target.closest(".menu-panel")) {
      workspaceMenuOpen = false;
      accountPanelOpen = false;
      projectActionsOpen = false;
      render();
    }
    return;
  }
  void handleAction(action).catch((error) => {
    if (handlePrivateError(error)) return;
    const message = error instanceof Error ? error.message : "Something went wrong.";
    projectStatus = { tone: "error", title: "Action failed", message };
    setWorkspaceMutationsDisabled(false);
    render();
  });
});

root.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  const form = target.closest<HTMLFormElement>("form");
  if (!form || mutationInFlight) return;
  if (form.dataset.form === "workspace") {
    const data = formData(form);
    workspaceDraft = { name: formValue(data, "name"), slug: formValue(data, "slug") };
  }
  if (form.dataset.form === "project") captureProjectDraft(form);
  if (form.dataset.form === "add-column") {
    captureAddColumnDraft(form);
    addColumnFieldError = "";
  }
  if (form.dataset.form === "card") captureCardDraft(form);
  if (form.dataset.form === "comment" && activeProject) {
    const cardId = form.dataset.cardId || "";
    const body = form.querySelector<HTMLTextAreaElement>("[name='body']")?.value || "";
    const key = draftKey(activeProject.id, cardId);
    if (body) commentDrafts.set(key, body);
    else commentDrafts.delete(key);
    commentFieldError = "";
  }
  syncRecoveryNotice();
});

root.addEventListener("focusout", (event) => {
  const target = event.target as HTMLElement;
  if (!["card-title-input", "card-body-input", "card-next-action", "card-blocked-reason"].includes(target.id)) return;
  if (target.id === "card-body-input") captureDescriptionSelection();
  const form = target.closest<HTMLFormElement>("form[data-form='card']");
  if (form) captureCardDraft(form);
});

root.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (mutationInFlight || projectEditorMode || addColumnDraft) return;
  if (target.id.startsWith("board-filter-") && activeProject) {
    const filters = { ...cardFilters(activeProject) };
    if (target.id === "board-filter-next-actor") filters.nextActor = target.value as CardFilters["nextActor"];
    if (target.id === "board-filter-priority") filters.priority = target.value as CardFilters["priority"];
    if (target.id === "board-filter-blocked") filters.blocked = target.value as CardFilters["blocked"];
    projectCardFilters.set(activeProject.id, filters);
    pendingFocusId = target.id;
    render();
    return;
  }
  if (target.id === "project-select") {
    void switchProject(target.value);
    return;
  }
  if (target.id === "mobile-column" && activeProject) {
    mobileColumns.set(activeProject.id, target.value);
    render();
    pendingFocusId = `column-${safeId(target.value)}`;
    restorePendingContext();
    return;
  }
  const cardForm = target.closest<HTMLFormElement>("form[data-form='card']");
  if (cardForm) {
    captureCardDraft(cardForm);

  }
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  if (mutationInFlight) return;
  const form = event.target as HTMLFormElement;
  const operation = form.dataset.form === "passkey"
    ? performPasskeyCeremony(form)
    : form.dataset.form === "sign-in"
    ? signIn(form)
    : form.dataset.form === "workspace"
      ? createWorkspace(form)
    : form.dataset.form === "agent-connection"
      ? createAgentConnection(form)
    : form.dataset.form === "project"
      ? saveProject(form)
      : form.dataset.form === "add-column"
        ? saveAddColumn(form)
      : form.dataset.form === "card"
        ? saveCard(form)
        : form.dataset.form === "comment"
          ? addComment(form)
          : Promise.resolve();
  void operation.catch((error) => {
    if (handlePrivateError(error)) return;
    setWorkspaceMutationsDisabled(false);
    projectStatus = { tone: "error", title: "Action failed", message: error instanceof Error ? error.message : "Try again." };
    render();
  });
});

root.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (target.closest("[data-tablist='description']")) {
      const nextView = event.key === "Home"
        ? "write"
        : event.key === "End"
          ? "preview"
          : event.key === "ArrowRight"
            ? target.id === "description-write-tab" ? "preview" : "write"
            : target.id === "description-preview-tab" ? "write" : "preview";
      showDescriptionView(nextView);
      return;
    }
    const showActivity = event.key === "ArrowRight" || event.key === "End";
    if (showActivity && !document.querySelector("#activity-tab")) return;
    if (showActivity && (cardConflict || moveConflict)) return;
    inspectorTab = showActivity ? "activity" : "card";
    pendingFocusId = inspectorTab === "activity" ? "activity-tab" : "card-tab";
    render();
    return;
  }
  if (event.key !== "Escape") return;
  if (accessContext === "root" && workspaceCreationOpen && workspaceChoices.length) {
    event.preventDefault();
    if (!mutationInFlight) void cancelWorkspaceCreation();
    return;
  }
  if (workspaceMenuOpen) {
    event.preventDefault();
    workspaceMenuOpen = false;
    pendingFocusRestore = { action: "toggle-workspace-menu", occurrence: 0 };
    render();
    return;
  }
  if (addColumnPreparing || addColumnCommitted) {
    event.preventDefault();
    return;
  }
  if (addColumnDraft) {
    event.preventDefault();
    if (!mutationInFlight) cancelAddColumn();
    return;
  }
  if (accountPanelOpen || projectActionsOpen) {
    event.preventDefault();
    pendingFocusRestore = accountPanelOpen
      ? { action: "toggle-account-panel", occurrence: 0 }
      : { action: "toggle-project-actions", occurrence: 0 };
    accountPanelOpen = false;
    projectActionsOpen = false;
    render();
    return;
  }
  if (activityFeed) {
    event.preventDefault();
    closeActivityFeed();
    return;
  }
  if (movePanelOpen || moveConflict) {
    event.preventDefault();
    cancelMove();
    return;
  }
  if (selectedCardId || creatingCard) {
    event.preventDefault();
    closeCard();
  }
});

narrowBoardQuery.addEventListener("change", () => {
  if (!session || accessContext === "root" || (!addColumnPreparing && !addColumnCommitted && !addColumnDraft)) return;
  const form = document.querySelector<HTMLFormElement>("form[data-form='add-column']");
  if (form && !mutationInFlight) captureAddColumnDraft(form);
  if (addColumnPreparing) {
    pendingFocusId = selectedCardId || creatingCard ? "add-column-preparing-status" : "add-column-status";
  } else if (addColumnCommitted) {
    pendingFocusId = "add-column-status";
  } else if (mutationInFlight || addColumnDraft?.outcomeUnconfirmed || (projectStatus && !addColumnFieldError)) {
    pendingFocusId = "add-column-status";
  } else {
    pendingFocusId = "add-column-name";
  }
  render();
});

cardOnlyQuery.addEventListener("change", () => {
  if (!session || accessContext === "root" || !addColumnPreparing || (!selectedCardId && !creatingCard)) return;
  pendingFocusId = cardOnlyQuery.matches ? "add-column-preparing-status" : "add-column-status";
  render();
});

async function boot(): Promise<void> {
  const currentUrl = new URL(window.location.href);
  const requestedWorkspaceRoute = currentUrl.searchParams.get("new-workspace") === "1" || currentUrl.searchParams.get("workspaces") === "1";
  if (requestedWorkspaceRoute) window.sessionStorage.setItem("kanban.cards:workspace-route", JSON.stringify({ create: currentUrl.searchParams.get("new-workspace") === "1", returnSlug: currentUrl.searchParams.get("return-workspace") || "" }));
  render();
  try {
    await loadSession();
    if (currentUrl.searchParams.has("signedout")) {
      currentUrl.searchParams.delete("signedout");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}`);
      if (!session && accessContext === "root") authNotice = { kind: "signed-out", title: "Signed out", message: "" };
    }
    if (!session && accessContext === "root" && currentUrl.searchParams.get("access") === "recover") {
      window.history.replaceState(null, "", "/");
      await beginPasskeyFlow("recover");
      return;
    }
    if (session && accessContext === "root") {
      if (currentUrl.searchParams.get("cancel-access") === "1") {
        window.sessionStorage.removeItem("kanban.cards:add-passkey-after-verify");
        window.history.replaceState(null, "", "/");
      }
      const requestedMode = currentUrl.searchParams.get("access");
      if (requestedMode === "verify" || requestedMode === "add") {
        const action = currentUrl.searchParams.get("action") === "api-key" ? "api-key" : "access-settings";
        window.history.replaceState(null, "", "/");
        await beginPasskeyFlow(requestedMode, action);
        return;
      }
      if (window.sessionStorage.getItem("kanban.cards:add-passkey-after-verify") === "1") {
        window.sessionStorage.removeItem("kanban.cards:add-passkey-after-verify");
        await beginPasskeyFlow("add");
        return;
      }
      await loadWorkspaceChoices();
      let workspaceRouteRequested = requestedWorkspaceRoute;
      try {
        const intent = JSON.parse(window.sessionStorage.getItem("kanban.cards:workspace-route") || "null");
        const validReturnSlug = typeof intent?.returnSlug === "string" && (intent.returnSlug === "" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(intent.returnSlug));
        if (intent && !Array.isArray(intent) && typeof intent.create === "boolean" && validReturnSlug && (!intent.returnSlug || workspaceChoices.some((workspace) => workspace.slug === intent.returnSlug))) {
          workspaceRouteRequested = true;
          workspaceCreationOpen = intent.create;
          workspaceCreationReturnSlug = intent.returnSlug;
        } else {
          workspaceRouteRequested = false;
          window.sessionStorage.removeItem("kanban.cards:workspace-route");
        }
      } catch { window.sessionStorage.removeItem("kanban.cards:workspace-route"); }
      if (workspaceRouteRequested) {
        window.history.replaceState(null, "", "/");
        pendingFocusId = workspaceCreationOpen ? "workspace-name" : "workspace-route-title";
      }
      if (currentUrl.searchParams.get("access") === "1" || window.sessionStorage.getItem("kanban.cards:open-access") === "1") {
        window.sessionStorage.removeItem("kanban.cards:open-access");
        accessPanelOpen = true; await loadAccessSettings();
        window.history.replaceState(null, "", "/");
      } else if (!workspaceRouteRequested && workspaceChoices.length === 1) await openWorkspace(workspaceChoices[0].slug);
    } else if (session) {
      await loadProjects();
      if (window.sessionStorage.getItem("kanban.cards:open-agents") === "1") {
        window.sessionStorage.removeItem("kanban.cards:open-agents");
        agentPanelOpen = true;
        await loadAgentConnections();
      }
    }
  } catch (error) {
    if (!handlePrivateError(error)) {
      clearPrivateState(error instanceof ApiError && error.status === 403
        ? {
            kind: "access-denied",
            title: "This account doesn’t have access",
            message: "Sign in with a passkey that has access to this Workspace."
          }
        : {
            kind: "service-unavailable",
            title: "kanban.cards is unavailable",
            message: "The service could not be reached. Try again when it is available."
          });
    }
  } finally {
    initialLoading = false;
    render();
  }
}

void UI_CONTRACT_STATES;
void boot();

export {};

window.addEventListener("storage", event => { if (event.key?.startsWith("kanban.cards:recovery:v1:") && session) { recoveryStore.scan(); syncRecoveryNotice(); } });
window.addEventListener("beforeunload", event => { captureVisibleDrafts(); if (session && recoveryStore.failure) { event.preventDefault(); event.returnValue = ""; } });

window.addEventListener("focus", () => {
  if (!session || mutationInFlight || initialLoading) return;
  const ownerId = session.ownerId;
  void api("/session").then(payload => {
    const verified = normalizeSession(payload).session;
    if (!verified || verified.ownerId !== ownerId) { captureVisibleDrafts(); clearPrivateState({ kind: "session-expired", title: "Your session ended", message: "Sign in again to recover your drafts." }); render(); }
  }).catch(error => { handlePrivateError(error); });
});
