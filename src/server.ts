import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import {
  COMMENT_KINDS,
  COMMENT_STATUSES,
  DEFAULT_PROJECT_ID,
  DEFAULT_TEAM_ID,
  createBoard,
  createProject,
  createComment,
  createStateStore,
  createTeamInvite,
  createTeamMember,
  createWorkItem,
  findBoard,
  findComment,
  findProject,
  findTeamInvite,
  findTeamMember,
  findTeamMemberByIdentity,
  findWorkItem,
  normalizeDraft,
  normalizeWorkspace,
  touchBoard,
  touchTeamInvite,
  touchTeamMember,
  touchProject,
  touchWorkItem
} from "./state-store";
import { createAgentTokenStore } from "./agent-token-store";
import { createEventStore } from "./event-store";
import {
  clearSessionAndRedirect,
  getSession,
  handleCallback,
  hasPlatformAuthConfig,
  logout,
  type PlatformAuthRouteResponse,
  type PlatformSession,
  startLogin
} from "./platform-auth";
import { formatSeedRoadmapReport, seedRoadmap } from "../scripts/seed-roadmap";
import type {
  AgentCapability,
  AgentInstruction,
  AgentSpec,
  AgentTokenStore,
  AgentTokenUpdateInput,
  Board,
  BoardDraft,
  CommentKind,
  CommentStatus,
  EventStore,
  PostgresOptions,
  Project,
  PublicTeamInvite,
  PublicTeamMember,
  PublicTokenRecord,
  StateStore,
  TeamInvite,
  TeamMember,
  TeamRole,
  WorkspaceEvent,
  WorkspaceEventActorProvenance,
  WorkspaceEventDelegationProvenance,
  WorkspaceEventPayload,
  WorkItem,
  WorkItemComment,
  WorkspaceState
} from "./types";

type SessionAdminAuthContext = {
  kind: "admin";
  method: "session";
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
};
type AdminAuthContext =
  | {
      kind: "admin";
      method: "bearer" | "local-open";
      userId: string;
      email: string;
      name: string;
      roles: string[];
      surfaceAccess: string[];
      teamId: string;
      projectId: string;
      memberId: string;
      role: "owner";
      isTeamMember: true;
      projectIds: ["*"];
    }
  | SessionAdminAuthContext;
type AgentAuthContext = {
  kind: "agent";
  method: "bearer";
  tokenId: string;
  boardId: string;
  agentId: string;
  last4: string;
  teamId: string | null;
  projectId: string | null;
  sessionId: string;
  delegatedBy: string | null;
  capabilities: string[];
  expiresAt: string | null;
  reason: string;
  lastUsedAt: string | null;
};
type AnonymousAuthContext = { kind: "anonymous" };
type KanbanAuthContext = AdminAuthContext | AgentAuthContext | AnonymousAuthContext;

declare global {
  namespace Express {
    interface Request {
      kanbanAuth?: KanbanAuthContext;
    }
  }
}

interface CreateAppOptions extends PostgresOptions {
  staticDir?: string;
  dataPath?: string;
  tokenDataPath?: string;
  requireDatabase?: boolean;
  requireAuth?: boolean;
  apiToken?: string;
  store?: StateStore;
  tokenStore?: AgentTokenStore;
  eventStore?: EventStore;
  tokenPool?: PostgresOptions["pool"];
  eventPool?: PostgresOptions["pool"];
  eventDataPath?: string;
  eventTableName?: string;
  host?: string;
  port?: string | number;
}

interface FlowAiDraftResponse {
  summary: string;
  warnings: string[];
  draft: BoardDraft;
  model: string;
  provider: "lm-studio";
}

interface FlowApplyResult {
  board: Board;
  warnings: string[];
  movedCards: Array<{ cardId: string; title: string; fromLaneId: string; toLaneId: string }>;
  removedAgents: RemovedAgentSummary[];
  clearedAssignments: ClearedAgentAssignmentSummary[];
  revokedAgentSessions: RevokedAgentSessionSummary[];
}

type AgentAssignmentField = "ownerAgentId" | "reviewerAgentId";
type WorkItemMemberField = "requesterMemberId" | "ownerMemberId" | "reviewerMemberId";

interface RemovedAgentSummary {
  agentId: string;
  name: string;
}

interface ClearedAgentAssignmentSummary {
  cardId: string;
  title: string;
  field: AgentAssignmentField;
  agentId: string;
}

interface AgentReconciliationResult {
  removedAgents: RemovedAgentSummary[];
  removedAgentIds: string[];
  clearedAssignments: ClearedAgentAssignmentSummary[];
}

interface BoardAgentReconciliationResult {
  board: Board;
  reconciliation: AgentReconciliationResult;
}

interface BoardAgentReconciliationSnapshot {
  agentSpecs: AgentSpec[];
  workItems: Array<Pick<WorkItem, "id" | "title" | "ownerAgentId" | "reviewerAgentId">>;
}

interface RevokedAgentSessionSummary {
  id: string;
  sessionId: string;
  agentId: string;
  label: string;
  last4: string;
  delegatedBy: string | null;
  capabilities: string[];
  expiresAt: string | null;
  reason: string;
  revokedAt: string | null;
}

interface AuthConfig {
  accessAuthRequired: boolean;
  apiToken: string;
  platformAuthConfigured: boolean;
  surfaceId: string;
  localWriteOpen: boolean;
  missingRequiredSecrets: string[];
}

interface HttpError extends Error {
  status?: number;
}

type UnknownRecord = Record<string, any>;
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PRODUCT_NAME = "kanban.cards";
const SSE_HEARTBEAT_MS = 25_000;
const SSE_POLL_MS = 1_000;
const SSE_BATCH_LIMIT = 200;
const MIN_FLOW_LANES = 2;
const MAX_FLOW_LANES = 8;
const AGENT_SESSION_CAPABILITIES: AgentCapability[] = ["view", "create", "update", "comment", "move"];
const AGENT_SESSION_CAPABILITY_SET = new Set<string>(AGENT_SESSION_CAPABILITIES);
const WORK_ITEM_MEMBER_FIELDS: WorkItemMemberField[] = ["requesterMemberId", "ownerMemberId", "reviewerMemberId"];
const FALLBACK_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="description" content="kanban.cards tracks human and agent-controlled Kanban cards with reviewable workflows.">
  <title>kanban.cards</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="styles.css">
</head>
<body class="app-body">
  <main class="product-shell">
    <header class="topbar">
      <div class="topbar-left">
        <a class="product-mark" href="./" aria-label="kanban.cards home">kanban.cards</a>
        <label class="project-switcher" for="project-select">
          <span class="sr-only">Project</span>
          <select id="project-select">
            <option>kanban.cards</option>
          </select>
        </label>
        <button class="secondary-button" type="button" id="project-settings">Project settings</button>
        <button class="secondary-button" type="button" id="new-project">New project</button>
        <label class="board-switcher" for="board-select">
          <span class="sr-only">Board</span>
          <select id="board-select">
            <option>Untitled board</option>
          </select>
        </label>
        <button class="secondary-button" type="button" id="new-board">New board</button>
      </div>
      <div class="topbar-right" id="account-control"></div>
    </header>

    <section class="board-toolbar" aria-label="Board controls">
      <div class="board-context">
        <h1 id="board-title">Untitled board</h1>
        <div class="board-counts" aria-label="Board summary">
          <span><strong id="metric-active">0</strong> active</span>
          <span><strong id="metric-blocked">0</strong> blocked</span>
          <span><strong id="metric-approvals">0</strong> approvals</span>
          <span><strong id="metric-delivered">0</strong> delivered</span>
        </div>
      </div>
      <div class="board-actions">
        <button class="secondary-button" type="button" id="board-settings" hidden>Board settings</button>
        <button class="secondary-button" type="button" id="edit-flow" hidden>Edit flow</button>
      </div>
    </section>

    <section class="workspace-grid" aria-label="Reviewer workspace">
      <section class="board-canvas is-setup" id="board-canvas" aria-label="Cards">
        <section class="flow-panel" aria-labelledby="flow-setup-title">
          <div class="flow-panel-heading">
            <p class="eyebrow">Board setup</p>
            <h2 id="flow-setup-title">Choose a template or describe the flow</h2>
          </div>
          <label class="board-name-field" for="board-name">
            <span class="meta-label">Board name</span>
            <input id="board-name" type="text" value="Untitled board">
          </label>
          <label class="flow-prompt-field" for="flow-prompt">
            <span class="sr-only">Kanban flow description</span>
            <textarea id="flow-prompt" rows="5" placeholder="Intake, Research, Draft, Review, Release"></textarea>
          </label>
          <div class="flow-actions">
            <button class="primary-button" type="button" data-action="generate-flow">Generate flow</button>
          </div>
        </section>
      </section>

      <aside class="detail-panel" aria-live="polite" aria-label="Card inspector">
        <div class="detail-shell" id="inspector-panel">
          <div class="inspector-label">
            <span>Inspector</span>
            <strong>No selection</strong>
          </div>
          <section class="empty-inspector" aria-labelledby="empty-inspector-title">
            <p class="eyebrow">Card detail</p>
            <h2 id="empty-inspector-title">Select a card</h2>
            <p>Details, review gates, approvals, and activity will appear here after cards exist.</p>
          </section>
        </div>
      </aside>
    </section>
  </main>

  <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>
  <div id="modal-root"></div>
  <script src="app.js"></script>
</body>
</html>`;

export function createApp(options: CreateAppOptions = {}): express.Express {
  const staticDir = options.staticDir || process.cwd();
  const dataPath = options.dataPath || process.env.KANBAN_CARDS_DATA_PATH || process.env.INSTRUCT_DATA_PATH || path.join(staticDir, "data", "kanban-cards-state.json");
  const connectionString = options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const auth = createAuthConfig(options);
  const missingRequiredConfig = [...auth.missingRequiredSecrets];
  const databaseRequired = options.requireDatabase ?? Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  if (databaseRequired && !connectionString) {
    missingRequiredConfig.push("KANBAN_CARDS_DATABASE_URL or POSTGRES_URL or DATABASE_URL");
  }
  const store = options.store || createStateStore({
    dataPath,
    connectionString,
    pool: options.pool,
    ssl: options.ssl
  });
  const tokenStore = options.tokenStore || createAgentTokenStore({
    dataPath: options.tokenDataPath || path.join(path.dirname(dataPath), "agent-access-tokens.json"),
    connectionString,
    pool: options.tokenPool,
    ssl: options.ssl
  });
  const eventStore = options.eventStore || createEventStore({
    dataPath: options.eventDataPath || path.join(path.dirname(dataPath), "kanban-events.jsonl"),
    connectionString,
    pool: options.eventPool || options.pool,
    ssl: options.ssl,
    tableName: options.eventTableName
  });
  const eventSubscribers = new Set<() => void>();
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    const ok = missingRequiredConfig.length === 0;
    res.status(ok ? 200 : 500).json({
      ok,
      product: PRODUCT_NAME,
      storage: store.kind,
      dataPath: store.kind === "file" ? store.path : undefined,
      tokenStorage: tokenStore.kind,
      eventStorage: eventStore.kind,
      authRequired: auth.accessAuthRequired,
      platformAuthConfigured: auth.platformAuthConfigured,
      surfaceId: auth.surfaceId,
      writeAuthRequired: !auth.localWriteOpen,
      missingConfig: missingRequiredConfig
    });
  });

  app.get("/auth/login", asyncHandler(async (req, res) => {
    await sendPlatformAuthResponse(res, await startLogin(toWebRequest(req), { surface: auth.surfaceId }));
  }));

  app.get("/auth/callback", asyncHandler(async (req, res) => {
    await sendPlatformAuthResponse(res, await handleCallback(toWebRequest(req), { surface: auth.surfaceId }));
  }));

  app.get("/auth/logout", asyncHandler(async (req, res) => {
    await sendPlatformAuthResponse(res, await logout(toWebRequest(req), { global: req.query.global === "1" }));
  }));

  app.post("/auth/logout", asyncHandler(async (req, res) => {
    await sendPlatformAuthResponse(res, await logout(toWebRequest(req), { global: req.query.global === "1" }));
  }));

  app.get("/auth/logout/complete", asyncHandler(async (req, res) => {
    await sendPlatformAuthResponse(res, clearSessionAndRedirect(toWebRequest(req), "/"));
  }));

  app.get("/auth/session", asyncHandler(async (req, res) => {
    if (!auth.platformAuthConfigured) {
      res.status(401).json({ error: "No active session." });
      return;
    }
    const result = await getSession(toWebRequest(req));
    if (!result.ok) {
      res.status(401).json({ error: "No active session." });
      return;
    }
    res.json(await publicSession(result.session, store));
  }));

  app.get("/invites/accept", asyncHandler(async (req, res) => {
    const token = queryString(req.query.token);
    if (!token) {
      res.status(400).type("html").send(renderInviteMessagePage("Invite link invalid", "This invite link is missing its token."));
      return;
    }
    if (!auth.platformAuthConfigured) {
      res.status(500).type("html").send(renderInviteMessagePage("Sign-in unavailable", "Auth0 session auth is not configured."));
      return;
    }
    const sessionResult = await getSession(toWebRequest(req));
    if (!sessionResult.ok) {
      res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl || req.url || "/")}`);
      return;
    }

    const state = await store.read();
    const invite = findInviteByToken(state, token);
    if (!invite) {
      res.status(404).type("html").send(renderInviteMessagePage("Invite link unavailable", "This invite was accepted, revoked, expired, or does not exist."));
      return;
    }
    res.type("html").send(renderInviteAcceptPage(invite, sessionResult.session, token));
  }));

  app.post("/invites/accept", asyncHandler(async (req, res) => {
    await acceptInviteFromRequest(req);
    res.redirect(303, "/");
  }));

  app.post("/api/invites/accept", asyncHandler(async (req, res) => {
    res.json(await acceptInviteFromRequest(req));
  }));

  app.use(requireAccessAuth(auth, tokenStore, store, missingRequiredConfig));

  app.get("/", serveIndex(staticDir));
  app.get("/index.html", serveIndex(staticDir));
  app.get("/app.js", sendStaticFile(staticDir, "public/app.js", "application/javascript; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "public/styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", sendStaticFile(staticDir, "public/robots.txt", "text/plain; charset=utf-8"));

  app.get("/admin/roadmap-seed", requireProjectManagerAuth(), asyncHandler(async (_req, res) => {
    res.type("html").send(renderRoadmapSeedPage());
  }));

  app.post("/admin/roadmap-seed", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const projectId = optionalText(req.body?.projectId) || currentAuthProjectId(req);
    if (projectId) assertProjectManager(req, projectId);
    const report = await runRoadmapSeed(req, auth, {
      dryRun: parseBooleanInput(req.body?.dryRun),
      projectId
    });
    res.type("html").send(renderRoadmapSeedPage(report));
  }));

  app.get("/api/state", asyncHandler(async (req, res) => {
    if (isAgentAuth(req)) throw httpError(403, "Agent tokens cannot read full workspace state.");
    res.json(publicWorkspaceState(await store.read(), req.kanbanAuth));
  }));

  app.put("/api/state", requireWriteAuth(), asyncHandler(async (req, res) => {
    if (isAgentAuth(req)) throw httpError(403, "Agent tokens cannot write full workspace state.");
    let agentReconciliations: BoardAgentReconciliationResult[] = [];
    const { state: saved } = await store.update((current) => {
      const next = normalizeWorkspace(req.body);
      const previousAgentSnapshotsByBoardId = snapshotBoardAgentReconciliationState(current);
      assertWorkspaceMemberReferences(current, next);
      assertWorkspaceWriteAllowed(req, current, next);
      applyWorkspaceStateWrite(req, current, next);
      agentReconciliations = reconcileWorkspaceStateRemovedAgentReferences(current, previousAgentSnapshotsByBoardId);
    });
    const agentReconciliationEvents = [];
    for (const agentReconciliation of agentReconciliations) {
      const revokedAgentSessions = await revokeActiveAgentSessionsForRemovedAgents(
        req,
        agentReconciliation.board,
        agentReconciliation.reconciliation.removedAgents,
        "agent_removed_from_state"
      );
      agentReconciliationEvents.push({
        boardId: agentReconciliation.board.id,
        boardName: agentReconciliation.board.name,
        projectId: agentReconciliation.board.projectId,
        removedAgents: agentReconciliation.reconciliation.removedAgents,
        clearedAssignments: agentReconciliation.reconciliation.clearedAssignments,
        revokedAgentSessions
      });
    }
    await publishWorkspaceEvent(
      req,
      null,
      "update",
      { type: "workspace" },
      "workspace_saved",
      agentReconciliationEvents.length ? { agentReconciliations: agentReconciliationEvents } : {}
    );
    res.json(publicWorkspaceState(saved, req.kanbanAuth));
  }));

  app.get("/api/events", asyncHandler(async (req, res) => {
    if (isAgentAuth(req)) throw httpError(403, "Agent tokens cannot subscribe to workspace events.");
    await streamWorkspaceEvents(req, res);
  }));

  app.get("/api/team", requireTeamManagerAuth(), asyncHandler(async (req, res) => {
    const state = await store.read();
    res.json(publicTeamState(state, req.kanbanAuth));
  }));

  app.post("/api/team/invites", requireTeamManagerAuth(), asyncHandler(async (req, res) => {
    const email = normalizeEmailInput(req.body?.email);
    if (!email) throw httpError(400, "Invite email is required.");
    const role = normalizeTeamRole(req.body?.role);
    if (!role) throw httpError(400, "Invite role must be owner, admin, or member.");
    assertCanInviteRole(req, role);
    const rawToken = createInviteToken();
    const { result } = await store.update((state) => {
      const projectIds = normalizeAccessProjectIds(req.body?.projectIds, state, req.kanbanAuth);
      const invite = createTeamInvite({
        teamId: state.team.id,
        email,
        role,
        projectIds,
        tokenHash: hashInviteToken(rawToken),
        invitedBy: actorId(req.kanbanAuth) || "unknown"
      });
      state.invites.push(invite);
      return invite;
    });
    await publishWorkspaceEvent(req, null, "create", { type: "team_invite", id: result.id }, "team_invite_created");
    res.status(201).json({
      invite: publicTeamInvite(result),
      acceptUrl: absoluteUrl(req, `/invites/accept?token=${encodeURIComponent(rawToken)}`)
    });
  }));

  app.delete("/api/team/invites/:inviteId", requireTeamManagerAuth(), asyncHandler(async (req, res) => {
    const inviteId = routeParam(req, "inviteId");
    const { result } = await store.update((state) => {
      const invite = findTeamInvite(state, inviteId);
      if (!invite) throw httpError(404, "Invite not found.");
      assertCanManageRole(req, invite.role);
      if (invite.status === "pending") {
        invite.status = "revoked";
        invite.revokedAt = new Date().toISOString();
        touchTeamInvite(invite);
      }
      return invite;
    });
    await publishWorkspaceEvent(req, null, "revoke", { type: "team_invite", id: result.id }, "team_invite_revoked");
    res.json(publicTeamInvite(result));
  }));

  app.patch("/api/team/members/:memberId", requireTeamManagerAuth(), asyncHandler(async (req, res) => {
    const memberId = routeParam(req, "memberId");
    const { result } = await store.update((state) => {
      const member = findTeamMember(state, memberId);
      if (!member) throw httpError(404, "Member not found.");
      assertCanManageMember(req, state, member);
      const nextRole = Object.prototype.hasOwnProperty.call(req.body || {}, "role") ? normalizeTeamRole(req.body?.role) : member.role;
      if (!nextRole) throw httpError(400, "Member role must be owner, admin, or member.");
      assertCanManageRole(req, nextRole);
      assertOwnerFloor(state, member, nextRole);
      member.role = nextRole;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "projectIds")) {
        member.projectIds = normalizeAccessProjectIds(req.body?.projectIds, state, req.kanbanAuth);
      }
      touchTeamMember(member);
      return member;
    });
    await publishWorkspaceEvent(req, null, "update", { type: "team_member", id: result.id }, "team_member_updated");
    res.json(publicTeamMember(result));
  }));

  app.delete("/api/team/members/:memberId", requireTeamManagerAuth(), asyncHandler(async (req, res) => {
    const memberId = routeParam(req, "memberId");
    const { result } = await store.update((state) => {
      const member = findTeamMember(state, memberId);
      if (!member) throw httpError(404, "Member not found.");
      assertCanManageMember(req, state, member);
      assertOwnerFloor(state, member, null);
      state.members = state.members.filter((candidate) => candidate.id !== member.id);
      return member;
    });
    await publishWorkspaceEvent(req, null, "delete", { type: "team_member", id: result.id }, "team_member_removed");
    res.json(publicTeamMember(result));
  }));

  app.get("/api/projects", requireWorkspaceAuth(), asyncHandler(async (req, res) => {
    const state = await store.read();
    const projects = filterProjectsByAccess(state.projects, req.kanbanAuth);
    const activeProjectId = projects.some((project) => project.id === state.activeProjectId) ? state.activeProjectId : projects[0]?.id || DEFAULT_PROJECT_ID;
    res.json({ team: state.team, projects, activeProjectId });
  }));

  app.post("/api/roadmap/seed", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const projectId = optionalText(req.body?.projectId) || currentAuthProjectId(req);
    if (projectId) assertProjectManager(req, projectId);
    const report = await runRoadmapSeed(req, auth, {
      dryRun: parseBooleanInput(req.body?.dryRun),
      projectId
    });
    if (!report.dryRun) {
      await publishWorkspaceEvent(req, report.boardId || null, "update", { type: "board", id: report.boardId || null }, "roadmap_seeded", {
        projectId: report.projectId,
        boardAction: report.boardAction,
        cardActions: report.cardActions.map((card) => ({ title: card.title, laneTitle: card.laneTitle, action: card.action }))
      });
    }
    res.json(report);
  }));

  app.post("/api/projects", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    assertCanCreateProject(req);
    const { result } = await store.update((state) => {
      const teamId = effectiveTeamId(req, state);
      ensureStateTeam(state, teamId);
      const project = createProject({
        teamId,
        name: normalizeProjectName(req.body?.name),
        description: typeof req.body?.description === "string" ? req.body.description : ""
      });
      state.projects.push(project);
      if (req.body?.active !== false) state.activeProjectId = project.id;
      return project;
    });
    await publishWorkspaceEvent(req, null, "create", { type: "project", id: result.id }, "project_created", { projectId: result.id });
    res.status(201).json(result);
  }));

  app.patch("/api/projects/:projectId", requireWorkspaceAuth(), asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const { state, result } = await store.update((workspace) => {
      const project = findProject(workspace, projectId);
      if (!project) throw httpError(404, "Project not found.");
      requireProjectAccess(req, project.id);
      const projectManagementFields = typeof req.body?.name === "string" || typeof req.body?.description === "string";
      if (projectManagementFields) assertProjectManager(req, project.id);
      if (typeof req.body?.name === "string") project.name = normalizeProjectName(req.body.name);
      if (typeof req.body?.description === "string") project.description = req.body.description.trim();
      if (req.body?.active === true) {
        workspace.activeProjectId = project.id;
        if (!workspace.boards.some((board) => board.id === workspace.activeBoardId && board.projectId === project.id)) {
          const projectBoard = workspace.boards.find((board) => board.projectId === project.id);
          if (projectBoard) workspace.activeBoardId = projectBoard.id;
        }
      }
      touchProject(project);
      return project;
    });
    await publishWorkspaceEvent(req, null, "update", { type: "project", id: result.id }, "project_updated", {
      projectId: result.id,
      activeProjectId: state.activeProjectId
    });
    res.json(result);
  }));

  app.get("/api/boards", requireAgentCapability("view"), asyncHandler(async (req, res) => {
    const state = await store.read();
    if (isAgentAuth(req)) {
      const board = findBoard(state, req.kanbanAuth.boardId);
      if (!board) throw httpError(404, "Board not found.");
      res.json({ boards: [board], activeBoardId: board.id });
      return;
    }
    const projectId = requestedProjectId(req, state);
    requireProjectAccess(req, projectId);
    const boards = state.boards.filter((board) => board.projectId === projectId);
    const activeBoardId = boards.some((board) => board.id === state.activeBoardId) ? state.activeBoardId : boards[0]?.id || null;
    res.json({ boards, activeBoardId, activeProjectId: projectId });
  }));

  app.get("/api/boards/:boardId", requireAgentCapability("view"), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    requireBoardAccess(req, boardId);
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    requireBoardProjectAccess(req, board);
    res.json(board);
  }));

  app.get("/api/boards/:boardId/events", requireWorkspaceAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    requireBoardProjectAccess(req, board);
    const events = await eventStore.listRecent({
      boardId,
      cardId: queryString(req.query.cardId),
      limit: queryLimit(req.query.limit)
    });
    res.json({ events });
  }));

  app.post("/api/boards/:boardId/flow/ai-draft", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const prompt = String(req.body?.prompt || req.body?.command || "").trim();
    if (!prompt) throw httpError(400, "Flow command is required.");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const result = await generateFlowDraftWithLmStudio(board, prompt);
    await publishWorkspaceEvent(req, board.id, "create", { type: "board_flow", id: board.id }, "board_flow_draft_generated", {
      projectId: board.projectId,
      provider: result.provider,
      model: result.model,
      summary: result.summary,
      warnings: result.warnings,
      laneCount: result.draft.lanes.length,
      agentCount: result.draft.agentSpecs.length
    });
    res.json(result);
  }));

  app.post("/api/boards/:boardId/flow/apply", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const source = req.body?.source === "manual" ? "manual" : "ai";
    const flowPrompt = typeof req.body?.flowPrompt === "string" ? req.body.flowPrompt : undefined;
    const draft = parseBoardDraftInput(req.body?.draft);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      assertProjectManager(req, board.projectId);
      return applyFlowDraftToBoard(board, draft, flowPrompt);
    });
    const revokedAgentSessions = await revokeActiveAgentSessionsForRemovedAgents(
      req,
      result.board,
      result.removedAgents,
      "agent_removed_from_flow"
    );
    const response: FlowApplyResult = { ...result, revokedAgentSessions };
    await publishWorkspaceEvent(req, boardId, "update", { type: "board_flow", id: boardId }, "board_flow_applied", {
      projectId: response.board.projectId,
      source,
      warnings: response.warnings,
      movedCards: response.movedCards,
      clearedAssignments: response.clearedAssignments,
      revokedAgentSessions: response.revokedAgentSessions,
      laneCount: response.board.lanes.length,
      agentCount: response.board.agentSpecs.length
    });
    res.json(response);
  }));

  app.get("/api/agent/instructions", requireAgentCapability("view"), asyncHandler(async (req, res) => {
    const state = await store.read();
    if (isAgentAuth(req)) {
      res.json({ instructions: collectAgentInstructions(state, req.kanbanAuth.agentId, req.kanbanAuth.boardId) });
      return;
    }
    res.json({ instructions: collectAgentInstructions(state, req.query.agentId) });
  }));

  app.get("/api/agent/session", requireAgentCapability("view"), asyncHandler(async (req, res) => {
    if (isAdminAuth(req)) {
      res.json({ mode: "admin" });
      return;
    }
    if (!isAgentAuth(req)) throw httpError(401, "Agent authentication required.");

    const state = await store.read();
    const board = findBoard(state, req.kanbanAuth.boardId);
    if (!board) throw httpError(404, "Board not found.");
    requireBoardProjectAccess(req, board);
    const agent = findAgentSpec(board, req.kanbanAuth.agentId);
    if (!agent) throw httpError(404, "Agent not found.");
    res.json({
      mode: "agent",
      board,
      agent,
      token: {
        id: req.kanbanAuth.tokenId,
        sessionId: req.kanbanAuth.sessionId,
        teamId: req.kanbanAuth.teamId,
        projectId: req.kanbanAuth.projectId || board.projectId,
        delegatedBy: req.kanbanAuth.delegatedBy,
        capabilities: req.kanbanAuth.capabilities,
        expiresAt: req.kanbanAuth.expiresAt,
        reason: req.kanbanAuth.reason,
        last4: req.kanbanAuth.last4,
        lastUsedAt: req.kanbanAuth.lastUsedAt
      }
    });
  }));

  app.post("/api/boards/:boardId/agent-tokens", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const agentId = nullableString(req.body?.agentId);
    if (!agentId) throw httpError(400, "agentId is required.");
    const agent = findAgentSpec(board, agentId);
    if (!agent) throw httpError(404, "Agent not found on this board.");
    const created = await tokenStore.create({
      boardId: board.id,
      agentId: agent.id,
      label: req.body?.label,
      teamId: effectiveTeamId(req, state),
      projectId: board.projectId,
      delegatedBy: actorId(req.kanbanAuth),
      capabilities: parseAgentSessionCapabilities(req.body?.capabilities, true),
      expiresAt: parseAgentSessionExpiresAt(req.body?.expiresAt),
      reason: req.body?.reason || `Board-scoped access for ${agent.name}.`
    });
    await publishWorkspaceEvent(
      req,
      board.id,
      "create",
      { type: "agent_session", id: created.tokenRecord.sessionId },
      "agent_session_created",
      agentSessionEventPayload(board, created.tokenRecord)
    );
    res.status(201).json({
      ...created.tokenRecord,
      token: created.token
    });
  }));

  app.post("/api/boards/:boardId/agent-sessions", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const agentId = nullableString(req.body?.agentId);
    if (!agentId) throw httpError(400, "agentId is required.");
    const agent = findAgentSpec(board, agentId);
    if (!agent) throw httpError(404, "Agent not found on this board.");
    const created = await tokenStore.create({
      boardId: board.id,
      agentId: agent.id,
      label: req.body?.label,
      teamId: effectiveTeamId(req, state),
      projectId: board.projectId,
      delegatedBy: actorId(req.kanbanAuth),
      capabilities: parseAgentSessionCapabilities(req.body?.capabilities, true),
      expiresAt: parseAgentSessionExpiresAt(req.body?.expiresAt),
      reason: req.body?.reason || `Board-scoped access for ${agent.name}.`
    });
    await publishWorkspaceEvent(
      req,
      board.id,
      "create",
      { type: "agent_session", id: created.tokenRecord.sessionId },
      "agent_session_created",
      agentSessionEventPayload(board, created.tokenRecord)
    );
    res.status(201).json({
      session: created.tokenRecord,
      token: created.token
    });
  }));

  app.get("/api/boards/:boardId/agent-tokens", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    res.json({ tokens: await tokenStore.list(board.id) });
  }));

  app.get("/api/boards/:boardId/agent-sessions", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    res.json({ sessions: await tokenStore.list(board.id) });
  }));

  app.patch("/api/boards/:boardId/agent-sessions/:sessionId", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const sessionId = routeParam(req, "sessionId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const previous = (await tokenStore.list(board.id)).find((tokenRecord) => tokenRecord.sessionId === sessionId) || null;
    const updateInput = parseAgentSessionUpdateInput(req.body);
    const tokenRecord = await tokenStore.update(board.id, sessionId, updateInput);
    if (!tokenRecord) throw httpError(404, "Agent session not found.");
    await publishWorkspaceEvent(
      req,
      board.id,
      "update",
      { type: "agent_session", id: tokenRecord.sessionId },
      "agent_session_updated",
      agentSessionEventPayload(board, tokenRecord, {
        capabilityChanges: previous
          ? {
              before: previous.capabilities,
              after: tokenRecord.capabilities
            }
          : null
      })
    );
    res.json({ session: tokenRecord });
  }));

  app.delete("/api/boards/:boardId/agent-tokens/:tokenId", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const tokenId = routeParam(req, "tokenId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const tokenRecord = await tokenStore.revoke(board.id, tokenId);
    if (!tokenRecord) throw httpError(404, "Token not found.");
    await publishWorkspaceEvent(
      req,
      board.id,
      "revoke",
      { type: "agent_session", id: tokenRecord.sessionId },
      "agent_session_revoked",
      agentSessionEventPayload(board, tokenRecord)
    );
    res.json(tokenRecord);
  }));

  app.delete("/api/boards/:boardId/agent-sessions/:sessionId", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const sessionId = routeParam(req, "sessionId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    assertProjectManager(req, board.projectId);
    const tokenRecord = await tokenStore.revokeSession(board.id, sessionId);
    if (!tokenRecord) throw httpError(404, "Agent session not found.");
    await publishWorkspaceEvent(
      req,
      board.id,
      "revoke",
      { type: "agent_session", id: tokenRecord.sessionId },
      "agent_session_revoked",
      agentSessionEventPayload(board, tokenRecord)
    );
    res.json({ session: tokenRecord });
  }));

  app.post("/api/boards", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const projectId = normalizeProjectId(req.body?.projectId) || state.activeProjectId || DEFAULT_PROJECT_ID;
      if (!findProject(state, projectId)) throw httpError(404, "Project not found.");
      assertProjectManager(req, projectId);
      const board = createBoard({ ...(req.body || {}), projectId });
      assertBoardMemberReferences(state, board);
      state.boards.push(board);
      state.activeBoardId = board.id;
      return board;
    });
    await publishWorkspaceEvent(req, result.id, "create", { type: "board", id: result.id }, "board_created", { projectId: result.projectId });
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId", requireProjectManagerAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      assertProjectManager(req, board.projectId);
      const previousAgentSpecs = board.agentSpecs.map((agent) => ({ ...agent, laneIds: [...agent.laneIds] }));
      let projectChanged = false;
      if (typeof req.body.name === "string") board.name = req.body.name;
      if (typeof req.body.projectId === "string" && req.body.projectId !== board.projectId) {
        if (!findProject(state, req.body.projectId)) throw httpError(404, "Project not found.");
        assertProjectManager(req, req.body.projectId);
        board.projectId = req.body.projectId;
        projectChanged = true;
      }
      if (typeof req.body.flowPrompt === "string") board.flowPrompt = req.body.flowPrompt;
      if (Object.prototype.hasOwnProperty.call(req.body, "configDraft")) board.configDraft = req.body.configDraft;
      if (Object.prototype.hasOwnProperty.call(req.body, "isEditingFlow")) board.isEditingFlow = Boolean(req.body.isEditingFlow);
      if (Array.isArray(req.body.lanes)) board.lanes = req.body.lanes;
      if (Array.isArray(req.body.agentSpecs)) board.agentSpecs = req.body.agentSpecs;
      if (req.body.active === true) state.activeBoardId = board.id;
      const reconciliation = Array.isArray(req.body.agentSpecs)
        ? reconcileRemovedAgentReferences(board, previousAgentSpecs)
        : emptyAgentReconciliation();
      if (projectChanged) assertBoardMemberReferences(state, board);
      touchBoard(board);
      return { board, reconciliation };
    });
    const revokedAgentSessions = await revokeActiveAgentSessionsForRemovedAgents(
      req,
      result.board,
      result.reconciliation.removedAgents,
      "agent_removed_from_board"
    );
    await publishWorkspaceEvent(req, result.board.id, "update", { type: "board", id: result.board.id }, "board_updated", {
      projectId: result.board.projectId,
      clearedAssignments: result.reconciliation.clearedAssignments,
      revokedAgentSessions
    });
    res.json(result.board);
  }));

  app.post("/api/boards/:boardId/work-items", requireWriteAuth(), requireAgentCapability("create"), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      requireBoardProjectAccess(req, board);
      if (!String(req.body.title || "").trim()) throw httpError(400, "Card title is required.");
      const input = isAgentAuth(req) ? withAgentCreateDefaults(req, req.body || {}) : req.body;
      assertWorkItemMemberReferences(state, board, input || {});
      const item = createWorkItem(input, board);
      if (!item) throw httpError(400, "Card is invalid.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only create cards assigned to that agent.");
      }
      board.workItems.push(item);
      touchBoard(board);
      return { item, projectId: board.projectId };
    });
    await publishWorkspaceEvent(req, boardId, "create", { type: "card", id: result.item.id }, "card_created", { projectId: result.projectId });
    res.status(201).json(result.item);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId", requireWriteAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    requireBoardAccess(req, boardId);
    requireAgentWorkItemPatchCapabilities(req);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      requireBoardProjectAccess(req, board);
      const item = findWorkItem(board, itemId);
      if (!item) throw httpError(404, "Card not found.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only update cards assigned to that agent.");
      }
      if (isAgentAuth(req)) assertAgentWorkItemPatchAllowed(req.body || {});
      assertWorkItemMemberReferences(state, board, req.body || {});
      applyWorkItemPatch(board, item, req.body || {});
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens cannot remove themselves from an assigned card.");
      }
      touchWorkItem(item);
      touchBoard(board);
      return { item, projectId: board.projectId };
    });
    await publishWorkspaceEvent(req, boardId, "update", { type: "card", id: result.item.id }, "card_updated", { projectId: result.projectId });
    res.json(result.item);
  }));

  app.post("/api/boards/:boardId/work-items/:itemId/comments", requireWriteAuth(), requireAgentCapability("comment"), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      requireBoardProjectAccess(req, board);
      const item = findWorkItem(board, itemId);
      if (!item) throw httpError(404, "Card not found.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only comment on cards assigned to that agent.");
      }
      const input = isAgentAuth(req) ? { ...(req.body || {}), author: req.kanbanAuth.agentId } : req.body || {};
      const comment = createComment(input);
      if (!comment) throw httpError(400, "Comment text is required.");
      item.comments.push(comment);
      touchWorkItem(item);
      touchBoard(board);
      return { comment, projectId: board.projectId };
    });
    await publishWorkspaceEvent(req, boardId, "comment", { type: "comment", id: result.comment.id, cardId: itemId }, "comment_created", { projectId: result.projectId });
    res.status(201).json(result.comment);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId/comments/:commentId", requireWriteAuth(), requireAgentCapability("comment"), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    const commentId = routeParam(req, "commentId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      requireBoardProjectAccess(req, board);
      const item = findWorkItem(board, itemId);
      if (!item) throw httpError(404, "Card not found.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only update comments on cards assigned to that agent.");
      }
      const comment = findComment(item, commentId);
      if (!comment) throw httpError(404, "Comment not found.");
      applyCommentPatch(comment, isAgentAuth(req) ? filterAgentCommentPatch(req.body || {}, comment, req.kanbanAuth.agentId) : req.body || {});
      touchWorkItem(item);
      touchBoard(board);
      return { comment, projectId: board.projectId };
    });
    await publishWorkspaceEvent(req, boardId, "update", { type: "comment", id: result.comment.id, cardId: itemId }, "comment_updated", { projectId: result.projectId });
    res.json(result.comment);
  }));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Not found.", path: req.path });
  });

  const errorHandler: ErrorRequestHandler = (error: HttpError, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({
      error: status === 500 ? "Internal server error." : error.message
    });
  };
  app.use(errorHandler);

  return app;

  async function acceptInviteFromRequest(req: Request): Promise<{ member: PublicTeamMember; invite: PublicTeamInvite }> {
    if (!auth.platformAuthConfigured) throw httpError(500, "Auth0 session auth is not configured.");
    const sessionResult = await getSession(toWebRequest(req));
    if (!sessionResult.ok) throw httpError(401, "Sign in before accepting this invite.");
    const rawToken = String(req.body?.token || req.query.token || "").trim();
    if (!rawToken) throw httpError(400, "Invite token is required.");
    const sessionEmail = normalizeEmailInput(sessionResult.session.email);

    const { result } = await store.update((state) => {
      const invite = findInviteByToken(state, rawToken);
      if (!invite) throw httpError(404, "Invite not found or no longer available.");
      if (normalizeEmailInput(invite.email) !== sessionEmail) {
        throw httpError(403, "This invite was issued to a different email address.");
      }
      let member = findTeamMemberByIdentity(state, {
        userId: sessionResult.session.userId,
        email: sessionResult.session.email
      });
      if (!member) {
        member = createTeamMember({
          teamId: state.team.id,
          userId: sessionResult.session.userId,
          email: sessionResult.session.email,
          name: sessionResult.session.name,
          role: invite.role,
          projectIds: invite.projectIds
        });
        state.members.push(member);
      } else {
        member.userId = sessionResult.session.userId;
        member.email = normalizeEmailInput(sessionResult.session.email);
        member.name = sessionResult.session.name || member.name;
        member.role = invite.role;
        member.projectIds = invite.projectIds;
        member.lastSeenAt = new Date().toISOString();
        touchTeamMember(member);
      }

      invite.status = "accepted";
      invite.acceptedBy = member.id;
      invite.acceptedAt = new Date().toISOString();
      touchTeamInvite(invite);
      return { member, invite };
    });

    req.kanbanAuth = await sessionAuthContext(sessionResult.session, store);
    await publishWorkspaceEvent(req, null, "accept", { type: "team_invite", id: result.invite.id }, "team_invite_accepted");
    return {
      member: publicTeamMember(result.member),
      invite: publicTeamInvite(result.invite)
    };
  }

  async function publishWorkspaceEvent(
    req: Request | null,
    boardId: string | null,
    action: string,
    resource: { type: string; id?: string | null; cardId?: string | null },
    reason: string,
    extraPayload: Record<string, unknown> = {}
  ): Promise<WorkspaceEvent> {
    const timestamp = new Date().toISOString();
    const payload: WorkspaceEventPayload = {
      ...extraPayload,
      reason,
      action,
      resource,
      actor: describeActor(req?.kanbanAuth),
      delegation: describeDelegation(req?.kanbanAuth),
      timestamp,
      updatedAt: timestamp
    };
    const event = await eventStore.append({
      type: "workspace_changed",
      boardId,
      payload
    });
    notifyEventSubscribers(eventSubscribers);
    return event;
  }

  async function revokeActiveAgentSessionsForRemovedAgents(
    req: Request,
    board: Board,
    removedAgents: RemovedAgentSummary[],
    revocationReason: string
  ): Promise<RevokedAgentSessionSummary[]> {
    if (!removedAgents.length) return [];
    const removedAgentIds = new Set(removedAgents.map((agent) => agent.agentId));
    const activeSessions = await tokenStore.list(board.id);
    const revokedAgentSessions: RevokedAgentSessionSummary[] = [];

    for (const activeSession of activeSessions) {
      if (!removedAgentIds.has(activeSession.agentId)) continue;
      const tokenRecord = await tokenStore.revokeSession(board.id, activeSession.sessionId);
      if (!tokenRecord) continue;
      const summary = summarizeRevokedAgentSession(tokenRecord);
      revokedAgentSessions.push(summary);
      await publishWorkspaceEvent(
        req,
        board.id,
        "revoke",
        { type: "agent_session", id: tokenRecord.sessionId },
        "agent_session_revoked",
        agentSessionEventPayload(board, tokenRecord, {
          revocationReason,
          removedAgentId: tokenRecord.agentId
        })
      );
    }

    return revokedAgentSessions;
  }

  async function streamWorkspaceEvents(req: Request, res: Response): Promise<void> {
    await eventStore.ensureReady();

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const requestedCursor = eventCursor(req);
    let cursor = requestedCursor ?? (await eventStore.latestId());
    let closed = false;
    let sending = false;
    let sendAgain = false;

    const sendAvailableEvents = async (): Promise<void> => {
      if (closed) return;
      if (sending) {
        sendAgain = true;
        return;
      }

      sending = true;
      try {
        do {
          sendAgain = false;
          const events = await eventStore.listSince(cursor, SSE_BATCH_LIMIT);
          for (const event of events) {
            if (closed) return;
            writeSseEvent(res, event);
            cursor = event.id;
          }
        } while (sendAgain);
      } finally {
        sending = false;
      }
    };

    const notify = (): void => {
      void sendAvailableEvents().catch(() => cleanup());
    };
    const heartbeat = windowlessSetInterval(() => {
      if (!closed) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    const poll = windowlessSetInterval(notify, SSE_POLL_MS);

    eventSubscribers.add(notify);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      eventSubscribers.delete(notify);
      clearInterval(heartbeat);
      clearInterval(poll);
      res.end();
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
    await sendAvailableEvents();
  }
}

function windowlessSetInterval(handler: () => void, timeout: number): NodeJS.Timeout {
  return setInterval(handler, timeout);
}

function notifyEventSubscribers(subscribers: Set<() => void>): void {
  for (const subscriber of [...subscribers]) subscriber();
}

function eventCursor(req: Request): string | null {
  const headerCursor = req.get("last-event-id");
  const queryCursor = req.query.since;
  const value = headerCursor || (Array.isArray(queryCursor) ? queryCursor[0] : queryCursor);
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function writeSseEvent(res: Response, event: WorkspaceEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function generateFlowDraftWithLmStudio(board: Board, prompt: string): Promise<FlowAiDraftResponse> {
  const baseUrl = normalizeLmStudioBaseUrl(process.env.LM_STUDIO_BASE_URL);
  const model = await resolveLmStudioModel(baseUrl);
  const timeoutMs = flowAiTimeoutMs();
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${process.env.LM_STUDIO_API_KEY || "lm-studio"}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: flowAiSystemPrompt() },
        { role: "user", content: flowAiUserPrompt(board, prompt) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "kanban_cards_flow_draft",
          strict: true,
          schema: FLOW_AI_RESPONSE_SCHEMA
        }
      }
    })
  }, timeoutMs).catch((error) => {
    throw httpError(503, `LM Studio is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!response.ok) {
    throw httpError(503, `LM Studio draft request failed with ${response.status}. Confirm a model is loaded.`);
  }

  const payload = await response.json().catch(() => null) as any;
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseLmStudioJsonContent(content);
  if (!parsed) throw httpError(502, "LM Studio returned an invalid structured flow response.");
  const draft = parseBoardDraftInput(parsed.draft);
  return {
    summary: String(parsed.summary || "Flow draft generated.").trim() || "Flow draft generated.",
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((warning: unknown) => String(warning || "").trim()).filter(Boolean) : [],
    draft,
    model,
    provider: "lm-studio"
  };
}

function flowAiSystemPrompt(): string {
  return [
    "You generate kanban.cards board flow drafts.",
    "Return only JSON matching the provided schema.",
    "The draft must have 2 to 8 lanes.",
    "Each lane needs a stable kebab-case id, title, description, default owner/reviewer agent ids when useful, and gate checks.",
    "Agents should be project/board workflow participants, not human users.",
    "Agent laneIds must reference lane ids in the draft.",
    "Preserve useful existing agent IDs when their role still exists.",
    "Do not create cards or comments."
  ].join(" ");
}

function flowAiUserPrompt(board: Board, prompt: string): string {
  return JSON.stringify({
    command: prompt,
    board: {
      id: board.id,
      name: board.name,
      flowPrompt: board.flowPrompt,
      lanes: board.lanes.map((lane) => ({
        id: lane.id,
        title: lane.title,
        description: lane.description,
        gate: lane.gate,
        defaultOwnerAgentId: lane.defaultOwnerAgentId,
        defaultReviewerAgentId: lane.defaultReviewerAgentId
      })),
      agents: board.agentSpecs.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        laneIds: agent.laneIds,
        instructions: agent.instructions,
        skillNotes: agent.skillNotes
      })),
      cardCountsByLane: board.lanes.map((lane) => ({
        laneId: lane.id,
        title: lane.title,
        cards: board.workItems.filter((item) => item.laneId === lane.id).length
      }))
    }
  });
}

async function resolveLmStudioModel(baseUrl: string): Promise<string> {
  const configured = String(process.env.LM_STUDIO_MODEL || "").trim();
  if (configured) return configured;
  const response = await fetchWithTimeout(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${process.env.LM_STUDIO_API_KEY || "lm-studio"}`
    }
  }, flowAiTimeoutMs()).catch((error) => {
    throw httpError(503, `LM Studio is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw httpError(503, `LM Studio model listing failed with ${response.status}.`);
  const payload = await response.json().catch(() => null) as any;
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const model = models.map((candidate: unknown) => isRecord(candidate) ? String(candidate.id || "").trim() : "").find(Boolean);
  if (!model) throw httpError(503, "LM Studio has no loaded or available models.");
  return model;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLmStudioBaseUrl(value: unknown): string {
  const text = String(value || "http://127.0.0.1:1234/v1").trim() || "http://127.0.0.1:1234/v1";
  return text.replace(/\/+$/, "");
}

function flowAiTimeoutMs(): number {
  const value = Number(process.env.FLOW_AI_TIMEOUT_MS || 45_000);
  return Number.isFinite(value) && value > 0 ? value : 45_000;
}

function parseLmStudioJsonContent(content: unknown): UnknownRecord | null {
  if (isRecord(content)) return content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(withoutFence);
    return isRecord(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function parseBoardDraftInput(value: unknown): BoardDraft {
  const draft = normalizeDraft(value);
  if (!draft) throw httpError(400, "Flow draft is invalid.");
  if (draft.lanes.length < MIN_FLOW_LANES) throw httpError(400, `Flow draft must include at least ${MIN_FLOW_LANES} lanes.`);
  if (draft.lanes.length > MAX_FLOW_LANES) throw httpError(400, `Flow draft must include ${MAX_FLOW_LANES} lanes or fewer.`);
  return draft;
}

function applyFlowDraftToBoard(board: Board, draft: BoardDraft, flowPrompt: string | undefined): FlowApplyResult {
  const oldLanes = board.lanes || [];
  const previousAgentSpecs = board.agentSpecs.map((agent) => ({ ...agent, laneIds: [...agent.laneIds] }));
  const newLaneById = new Set(draft.lanes.map((lane) => lane.id));
  const titleToNewLane = new Map(draft.lanes.map((lane) => [normalizeLaneTitle(lane.title), lane.id]));
  const fallbackLaneId = draft.lanes[0]?.id || "";
  const movedCards: FlowApplyResult["movedCards"] = [];
  const warnings: string[] = [];

  for (const item of board.workItems) {
    const fromLaneId = item.laneId;
    if (newLaneById.has(item.laneId)) continue;
    const oldLane = oldLanes.find((lane) => lane.id === item.laneId);
    const titleMatch = oldLane ? titleToNewLane.get(normalizeLaneTitle(oldLane.title)) : undefined;
    const nextLaneId = titleMatch || fallbackLaneId;
    item.laneId = nextLaneId;
    touchWorkItem(item);
    movedCards.push({ cardId: item.id, title: item.title, fromLaneId, toLaneId: nextLaneId });
  }

  if (movedCards.length) {
    warnings.push(`${movedCards.length} card${movedCards.length === 1 ? "" : "s"} moved because their previous lanes were not in the new flow.`);
  }

  board.lanes = draft.lanes;
  board.agentSpecs = draft.agentSpecs || [];
  const reconciliation = reconcileRemovedAgentReferences(board, previousAgentSpecs);
  if (reconciliation.clearedAssignments.length) {
    warnings.push(`${reconciliation.clearedAssignments.length} agent assignment${reconciliation.clearedAssignments.length === 1 ? "" : "s"} cleared because removed agents were not in the new flow.`);
  }
  board.selectedId = board.workItems.some((item) => item.id === board.selectedId) ? board.selectedId : null;
  board.configDraft = null;
  board.isEditingFlow = false;
  if (typeof flowPrompt === "string") board.flowPrompt = flowPrompt;
  touchBoard(board);
  return {
    board,
    warnings,
    movedCards,
    removedAgents: reconciliation.removedAgents,
    clearedAssignments: reconciliation.clearedAssignments,
    revokedAgentSessions: []
  };
}

function normalizeLaneTitle(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function emptyAgentReconciliation(): AgentReconciliationResult {
  return {
    removedAgents: [],
    removedAgentIds: [],
    clearedAssignments: []
  };
}

function snapshotBoardAgentReconciliationState(state: WorkspaceState): Map<string, BoardAgentReconciliationSnapshot> {
  return new Map(state.boards.map((board) => [
    board.id,
    {
      agentSpecs: board.agentSpecs.map((agent) => ({ ...agent, laneIds: [...agent.laneIds] })),
      workItems: board.workItems.map((item) => ({
        id: item.id,
        title: item.title,
        ownerAgentId: item.ownerAgentId,
        reviewerAgentId: item.reviewerAgentId
      }))
    }
  ]));
}

function reconcileWorkspaceStateRemovedAgentReferences(
  state: WorkspaceState,
  previousAgentSnapshotsByBoardId: Map<string, BoardAgentReconciliationSnapshot>
): BoardAgentReconciliationResult[] {
  const results: BoardAgentReconciliationResult[] = [];

  for (const board of state.boards) {
    const previousSnapshot = previousAgentSnapshotsByBoardId.get(board.id);
    if (!previousSnapshot) continue;
    const reconciliation = reconcileRemovedAgentReferences(board, previousSnapshot.agentSpecs);
    if (!reconciliation.removedAgents.length) continue;
    reconciliation.clearedAssignments = mergeClearedAssignments(
      reconciliation.clearedAssignments,
      summarizeRemovedAgentAssignments(previousSnapshot, reconciliation.removedAgentIds)
    );
    touchBoard(board);
    results.push({ board, reconciliation });
  }

  return results;
}

function summarizeRemovedAgentAssignments(
  previousSnapshot: BoardAgentReconciliationSnapshot,
  removedAgentIds: string[]
): ClearedAgentAssignmentSummary[] {
  const removedAgentIdSet = new Set(removedAgentIds);
  const clearedAssignments: ClearedAgentAssignmentSummary[] = [];
  for (const item of previousSnapshot.workItems) {
    if (item.ownerAgentId && removedAgentIdSet.has(item.ownerAgentId)) {
      clearedAssignments.push({
        cardId: item.id,
        title: item.title,
        field: "ownerAgentId",
        agentId: item.ownerAgentId
      });
    }
    if (item.reviewerAgentId && removedAgentIdSet.has(item.reviewerAgentId)) {
      clearedAssignments.push({
        cardId: item.id,
        title: item.title,
        field: "reviewerAgentId",
        agentId: item.reviewerAgentId
      });
    }
  }
  return clearedAssignments;
}

function mergeClearedAssignments(
  first: ClearedAgentAssignmentSummary[],
  second: ClearedAgentAssignmentSummary[]
): ClearedAgentAssignmentSummary[] {
  const assignments = new Map<string, ClearedAgentAssignmentSummary>();
  for (const assignment of [...first, ...second]) {
    assignments.set(`${assignment.cardId}:${assignment.field}:${assignment.agentId}`, assignment);
  }
  return [...assignments.values()];
}

function reconcileRemovedAgentReferences(board: Board, previousAgentSpecs: AgentSpec[]): AgentReconciliationResult {
  const currentAgentIds = new Set(board.agentSpecs.map((agent) => agent.id));
  const removedAgents = previousAgentSpecs
    .filter((agent) => !currentAgentIds.has(agent.id))
    .map((agent) => ({ agentId: agent.id, name: agent.name }));
  if (!removedAgents.length) return emptyAgentReconciliation();

  const removedAgentIds = removedAgents.map((agent) => agent.agentId);
  const removedAgentIdSet = new Set(removedAgentIds);
  const clearedAssignments: ClearedAgentAssignmentSummary[] = [];

  for (const lane of board.lanes) {
    if (lane.defaultOwnerAgentId && removedAgentIdSet.has(lane.defaultOwnerAgentId)) lane.defaultOwnerAgentId = null;
    if (lane.defaultReviewerAgentId && removedAgentIdSet.has(lane.defaultReviewerAgentId)) lane.defaultReviewerAgentId = null;
  }

  for (const item of board.workItems) {
    let changed = false;
    if (item.ownerAgentId && removedAgentIdSet.has(item.ownerAgentId)) {
      clearedAssignments.push({
        cardId: item.id,
        title: item.title,
        field: "ownerAgentId",
        agentId: item.ownerAgentId
      });
      item.ownerAgentId = null;
      changed = true;
    }
    if (item.reviewerAgentId && removedAgentIdSet.has(item.reviewerAgentId)) {
      clearedAssignments.push({
        cardId: item.id,
        title: item.title,
        field: "reviewerAgentId",
        agentId: item.reviewerAgentId
      });
      item.reviewerAgentId = null;
      changed = true;
    }
    if (changed) touchWorkItem(item);
  }

  return { removedAgents, removedAgentIds, clearedAssignments };
}

function assertWorkspaceMemberReferences(current: WorkspaceState, next: WorkspaceState): void {
  const boardsById = new Map(current.boards.map((board) => [board.id, board]));
  for (const board of next.boards) {
    assertBoardMemberReferences(current, {
      ...board,
      projectId: board.projectId || boardsById.get(board.id)?.projectId || DEFAULT_PROJECT_ID
    });
  }
}

function assertBoardMemberReferences(state: WorkspaceState, board: Board): void {
  for (const item of board.workItems) {
    assertWorkItemMemberReferences(state, board, item);
  }
}

function assertWorkItemMemberReferences(state: WorkspaceState, board: Board, value: Partial<Record<WorkItemMemberField, unknown>>): void {
  for (const field of WORK_ITEM_MEMBER_FIELDS) {
    const memberId = nullableString(value[field]);
    if (!memberId) continue;
    const member = findTeamMember(state, memberId);
    if (!member || member.teamId !== state.team.id || !teamMemberHasProjectAccess(member, board.projectId)) {
      throw httpError(400, `${field} must reference a team member with access to this board.`);
    }
  }
}

function teamMemberHasProjectAccess(member: TeamMember, projectId: string): boolean {
  return member.projectIds.includes("*") || member.projectIds.includes(projectId);
}

function summarizeRevokedAgentSession(tokenRecord: PublicTokenRecord): RevokedAgentSessionSummary {
  return {
    id: tokenRecord.id,
    sessionId: tokenRecord.sessionId,
    agentId: tokenRecord.agentId,
    label: tokenRecord.label,
    last4: tokenRecord.last4,
    delegatedBy: tokenRecord.delegatedBy,
    capabilities: [...tokenRecord.capabilities],
    expiresAt: tokenRecord.expiresAt,
    reason: tokenRecord.reason,
    revokedAt: tokenRecord.revokedAt
  };
}

const FLOW_AI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "warnings", "draft"],
  properties: {
    summary: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["lanes", "agentSpecs"],
      properties: {
        lanes: {
          type: "array",
          minItems: MIN_FLOW_LANES,
          maxItems: MAX_FLOW_LANES,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "description", "defaultOwnerAgentId", "defaultReviewerAgentId", "gate"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              defaultOwnerAgentId: { anyOf: [{ type: "string" }, { type: "null" }] },
              defaultReviewerAgentId: { anyOf: [{ type: "string" }, { type: "null" }] },
              gate: {
                type: "object",
                additionalProperties: false,
                required: ["title", "checks"],
                properties: {
                  title: { type: "string" },
                  checks: { type: "array", minItems: 1, items: { type: "string" } }
                }
              }
            }
          }
        },
        agentSpecs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "role", "laneIds", "instructions", "skillNotes"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              role: { type: "string" },
              laneIds: { type: "array", items: { type: "string" } },
              instructions: { type: "string" },
              skillNotes: { type: "string" }
            }
          }
        }
      }
    }
  }
} as const;

function applyWorkItemPatch(board: Board, item: WorkItem, patch: UnknownRecord): void {
  if (typeof patch.title === "string") item.title = patch.title;
  if (typeof patch.summary === "string") item.summary = patch.summary;
  if (Object.prototype.hasOwnProperty.call(patch, "requesterMemberId")) item.requesterMemberId = nullableString(patch.requesterMemberId);
  if (Object.prototype.hasOwnProperty.call(patch, "ownerMemberId")) item.ownerMemberId = nullableString(patch.ownerMemberId);
  if (Object.prototype.hasOwnProperty.call(patch, "reviewerMemberId")) item.reviewerMemberId = nullableString(patch.reviewerMemberId);
  if (Object.prototype.hasOwnProperty.call(patch, "ownerAgentId")) item.ownerAgentId = nullableString(patch.ownerAgentId);
  if (Object.prototype.hasOwnProperty.call(patch, "reviewerAgentId")) item.reviewerAgentId = nullableString(patch.reviewerAgentId);
  if (Array.isArray(patch.blockers)) item.blockers = patch.blockers;
  if (Array.isArray(patch.approvals)) item.approvals = patch.approvals;
  if (Object.prototype.hasOwnProperty.call(patch, "completed")) item.completed = Boolean(patch.completed);
  if (Object.prototype.hasOwnProperty.call(patch, "delivered")) item.delivered = Boolean(patch.delivered);
  if (typeof patch.laneId === "string") {
    if (!board.lanes.some((lane) => lane.id === patch.laneId)) throw httpError(400, "Lane does not exist on this board.");
    item.laneId = patch.laneId;
  }
}

function applyCommentPatch(comment: WorkItemComment, patch: UnknownRecord): void {
  if (typeof patch.text === "string" && patch.text.trim()) comment.text = patch.text.trim();
  if (typeof patch.author === "string" && patch.author.trim()) comment.author = patch.author.trim();
  if (typeof patch.kind === "string") {
    if (!COMMENT_KINDS.has(patch.kind as CommentKind)) throw httpError(400, "Invalid comment kind.");
    comment.kind = patch.kind as CommentKind;
  }
  if (typeof patch.status === "string") {
    if (!COMMENT_STATUSES.has(patch.status as CommentStatus)) throw httpError(400, "Invalid comment status.");
    comment.status = patch.status as CommentStatus;
  }
  comment.updatedAt = new Date().toISOString();
}

function assertAgentWorkItemPatchAllowed(patch: UnknownRecord): void {
  if (Object.prototype.hasOwnProperty.call(patch, "requesterMemberId") ||
      Object.prototype.hasOwnProperty.call(patch, "ownerMemberId") ||
      Object.prototype.hasOwnProperty.call(patch, "reviewerMemberId")) {
    throw httpError(403, "Agent sessions cannot change human accountability.");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "approvals")) {
    throw httpError(403, "Agent sessions cannot change approvals.");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "delivered")) {
    throw httpError(403, "Agent sessions cannot mark cards delivered.");
  }
}

function requireAgentCapability(capability: AgentCapability): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isAgentAuth(req)) assertAgentHasCapability(req, capability);
    next();
  };
}

function requireAgentWorkItemPatchCapabilities(req: Request): void {
  if (!isAgentAuth(req)) return;
  const patch = isRecord(req.body) ? req.body : {};
  const patchKeys = Object.keys(patch);
  const changesLane = Object.prototype.hasOwnProperty.call(patch, "laneId");
  const changesCardFields = patchKeys.some((key) => key !== "laneId");

  if (changesLane) assertAgentHasCapability(req, "move");
  if (changesCardFields || !changesLane) assertAgentHasCapability(req, "update");
}

function assertAgentHasCapability(req: Request, capability: AgentCapability): void {
  if (!isAgentAuth(req)) return;
  if (!req.kanbanAuth.capabilities.includes(capability)) {
    throw httpError(403, `Agent token is missing the "${capability}" capability.`);
  }
}

function parseAgentSessionUpdateInput(body: unknown): AgentTokenUpdateInput {
  if (!isRecord(body)) return {};
  const input: AgentTokenUpdateInput = {};
  if (hasOwnProperty(body, "label")) input.label = body.label;
  if (hasOwnProperty(body, "capabilities")) input.capabilities = parseAgentSessionCapabilities(body.capabilities, false);
  if (hasOwnProperty(body, "expiresAt")) input.expiresAt = parseAgentSessionExpiresAt(body.expiresAt);
  if (hasOwnProperty(body, "reason")) input.reason = body.reason;
  return input;
}

function parseAgentSessionCapabilities(value: unknown, defaultOnMissing: boolean): AgentCapability[] {
  if (!Array.isArray(value)) {
    if (defaultOnMissing && value == null) return [...AGENT_SESSION_CAPABILITIES];
    throw httpError(400, "capabilities must be an array.");
  }
  const capabilities = value.map((capability) => String(capability || "").trim()).filter(Boolean);
  const unique = [...new Set(capabilities)];
  if (!unique.length) throw httpError(400, "At least one capability is required.");
  const invalid = unique.find((capability) => !AGENT_SESSION_CAPABILITY_SET.has(capability));
  if (invalid) throw httpError(400, `Invalid capability: ${invalid}`);
  return unique as AgentCapability[];
}

function parseAgentSessionExpiresAt(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw httpError(400, "expiresAt must be a valid date.");
  return date.toISOString();
}

function agentSessionEventPayload(
  board: Board,
  tokenRecord: PublicTokenRecord,
  extraPayload: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...extraPayload,
    projectId: board.projectId,
    agentId: tokenRecord.agentId,
    tokenId: tokenRecord.id,
    sessionId: tokenRecord.sessionId,
    delegatedBy: tokenRecord.delegatedBy,
    capabilities: tokenRecord.capabilities,
    expiresAt: tokenRecord.expiresAt,
    sessionReason: tokenRecord.reason
  };
}

function hasOwnProperty(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function requestedProjectId(req: Request, state: WorkspaceState): string {
  const queryProjectId = Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId;
  const normalized = normalizeProjectId(queryProjectId);
  if (normalized && findProject(state, normalized)) return normalized;
  return state.activeProjectId || DEFAULT_PROJECT_ID;
}

function normalizeProjectId(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeProjectName(value: unknown): string {
  return String(value || "Untitled project").trim().slice(0, 120) || "Untitled project";
}

function effectiveTeamId(req: Request, state: WorkspaceState): string {
  if (isAdminAuth(req) && req.kanbanAuth.method === "session") return req.kanbanAuth.teamId;
  return state.team?.id || DEFAULT_TEAM_ID;
}

function currentAuthProjectId(req: Request): string | null {
  return isAdminAuth(req) ? req.kanbanAuth.projectId || null : null;
}

function ensureStateTeam(state: WorkspaceState, teamId: string): void {
  if (!teamId || state.team.id === teamId) return;
  state.team.id = teamId;
  for (const project of state.projects) {
    if (!project.teamId || project.teamId === DEFAULT_TEAM_ID) project.teamId = teamId;
  }
}

function describeActor(auth: KanbanAuthContext | undefined): WorkspaceEventActorProvenance {
  if (!auth || auth.kind === "anonymous") return { type: "anonymous" };
  if (auth.kind === "agent") {
    return {
      type: "agent",
      agentId: auth.agentId,
      tokenId: auth.tokenId,
      sessionId: auth.sessionId,
      boardId: auth.boardId,
      teamId: auth.teamId,
      projectId: auth.projectId,
      method: auth.method
    };
  }
  if (auth.method === "session") {
    return {
      type: "user",
      userId: auth.userId,
      email: auth.email,
      name: auth.name,
      teamId: auth.teamId,
      projectId: auth.projectId,
      method: auth.method
    };
  }
  return {
    type: "service",
    userId: auth.userId,
    name: auth.name,
    teamId: auth.teamId,
    projectId: auth.projectId,
    method: auth.method
  };
}

function describeDelegation(auth: KanbanAuthContext | undefined): WorkspaceEventDelegationProvenance | null {
  if (!auth || auth.kind !== "agent") return null;
  return {
    sessionId: auth.sessionId,
    delegatedBy: auth.delegatedBy,
    capabilities: auth.capabilities,
    expiresAt: auth.expiresAt,
    reason: auth.reason
  };
}

function actorId(auth: KanbanAuthContext | undefined): string | null {
  if (!auth || auth.kind === "anonymous") return null;
  if (auth.kind === "agent") return `agent:${auth.agentId}`;
  if (auth.method === "session") return `user:${auth.userId}`;
  return `service:${auth.userId}`;
}

function collectAgentInstructions(state: WorkspaceState, agentId: unknown, boardId: unknown = null): AgentInstruction[] {
  const normalizedAgentId = nullableString(agentId);
  const normalizedBoardId = nullableString(boardId);
  const actionableKinds = new Set(["instruction", "question", "change_request"]);
  const actionableStatuses = new Set(["open", "acknowledged"]);
  const instructions: AgentInstruction[] = [];

  for (const board of state.boards) {
    if (normalizedBoardId && board.id !== normalizedBoardId) continue;
    for (const item of board.workItems) {
      const matchesAgent = !normalizedAgentId
        || item.ownerAgentId === normalizedAgentId
        || item.reviewerAgentId === normalizedAgentId;
      if (!matchesAgent) continue;

      for (const comment of item.comments || []) {
        if (!actionableKinds.has(comment.kind) || !actionableStatuses.has(comment.status)) continue;
        instructions.push({
          boardId: board.id,
          boardName: board.name,
          workItemId: item.id,
          workItemTitle: item.title,
          laneId: item.laneId,
          requesterMemberId: item.requesterMemberId,
          ownerMemberId: item.ownerMemberId,
          reviewerMemberId: item.reviewerMemberId,
          ownerAgentId: item.ownerAgentId,
          reviewerAgentId: item.reviewerAgentId,
          comment
        });
      }
    }
  }

  return instructions;
}

function findAgentSpec(board: Board | null | undefined, agentId: string): AgentSpec | null {
  return board?.agentSpecs?.find((agent) => agent.id === agentId) || null;
}

function isItemAssignedToAgent(item: WorkItem | null | undefined, agentId: string | null | undefined): boolean {
  return Boolean(agentId && (item?.ownerAgentId === agentId || item?.reviewerAgentId === agentId));
}

function withAgentCreateDefaults(req: Request, input: UnknownRecord): UnknownRecord {
  if (!isAgentAuth(req)) return input;
  const agentId = req.kanbanAuth.agentId;
  const next = { ...input };
  delete next.requesterMemberId;
  delete next.ownerMemberId;
  delete next.reviewerMemberId;
  if (!next.ownerAgentId && !next.reviewerAgentId) next.ownerAgentId = agentId;
  return next;
}

function filterAgentCommentPatch(patch: UnknownRecord, comment: WorkItemComment, agentId: string): UnknownRecord {
  const filtered: UnknownRecord = {};
  if (typeof patch.status === "string") filtered.status = patch.status;
  if (comment.author === agentId && typeof patch.text === "string") filtered.text = patch.text;
  if (comment.author === agentId && typeof patch.kind === "string") filtered.kind = patch.kind;
  return filtered;
}

function publicWorkspaceState(state: WorkspaceState, auth: KanbanAuthContext | undefined): UnknownRecord {
  const projects = filterProjectsByAccess(state.projects, auth);
  const projectIds = new Set(projects.map((project) => project.id));
  const boards = state.boards.filter((board) => projectIds.has(board.projectId));
  const activeProjectId = projectIds.has(state.activeProjectId) ? state.activeProjectId : projects[0]?.id || DEFAULT_PROJECT_ID;
  const activeBoardId = boards.some((board) => board.id === state.activeBoardId)
    ? state.activeBoardId
    : boards.find((board) => board.projectId === activeProjectId)?.id || boards[0]?.id || "";
  return {
    team: state.team,
    projects,
    activeProjectId,
    members: publicWorkspaceMembers(state, auth),
    boards,
    activeBoardId,
    templates: state.templates
  };
}

function publicWorkspaceMembers(state: WorkspaceState, auth: KanbanAuthContext | undefined): PublicTeamMember[] {
  if (!auth || auth.kind === "anonymous") return [];
  if (!isAdminAuthContext(auth) || !auth.isTeamMember) return [];
  if (auth.role === "owner" || auth.role === "admin") return state.members.map(publicTeamMember);
  const currentMember = auth.memberId ? findTeamMember(state, auth.memberId) : null;
  return currentMember ? [publicTeamMember(currentMember)] : [];
}

function publicTeamState(state: WorkspaceState, auth: KanbanAuthContext | undefined): {
  team: WorkspaceState["team"];
  projects: Project[];
  members: PublicTeamMember[];
  invites: PublicTeamInvite[];
  currentMember: PublicTeamMember | null;
} {
  const currentMember = isAdminAuthContext(auth) && auth.memberId ? findTeamMember(state, auth.memberId) : null;
  return {
    team: state.team,
    projects: filterProjectsByAccess(state.projects, auth),
    members: state.members.map(publicTeamMember),
    invites: state.invites.map(publicTeamInvite),
    currentMember: currentMember ? publicTeamMember(currentMember) : null
  };
}

function publicTeamMember(member: TeamMember): PublicTeamMember {
  return {
    ...member,
    projectIds: [...member.projectIds]
  };
}

function publicTeamInvite(invite: TeamInvite): PublicTeamInvite {
  const { tokenHash: _tokenHash, ...safeInvite } = invite;
  return {
    ...safeInvite,
    projectIds: [...safeInvite.projectIds]
  };
}

function assertWorkspaceWriteAllowed(req: Request, current: WorkspaceState, next: WorkspaceState): void {
  if (!isAdminAuth(req) || !req.kanbanAuth.isTeamMember) throw httpError(403, "Team membership required.");
  if (req.kanbanAuth.role === "owner") return;
  if (req.kanbanAuth.role === "admin") {
    assertManagerWorkspaceWriteAllowed(req, current, next);
    return;
  }
  assertMemberWorkspaceWriteAllowed(req, current, next);
}

function applyWorkspaceStateWrite(req: Request, current: WorkspaceState, next: WorkspaceState): void {
  const preservedMembers = current.members;
  const preservedInvites = current.invites;
  if (!isAdminAuth(req)) throw httpError(403, "Team membership required.");
  if (req.kanbanAuth.role === "owner") {
    current.team = next.team;
    current.projects = next.projects;
    current.activeProjectId = next.activeProjectId;
    current.boards = next.boards;
    current.activeBoardId = next.activeBoardId;
    current.templates = next.templates;
  } else if (req.kanbanAuth.role === "admin") {
    applyScopedBoardStateWrite(current, next, req.kanbanAuth, true);
  } else {
    applyScopedBoardStateWrite(current, next, req.kanbanAuth, false);
  }
  current.members = preservedMembers;
  current.invites = preservedInvites;
}

function assertManagerWorkspaceWriteAllowed(req: Request, current: WorkspaceState, next: WorkspaceState): void {
  if (!isAdminAuth(req)) throw httpError(403, "Team membership required.");
  if (stableJson(workspaceWithoutBoards(current)) !== stableJson(workspaceWithoutBoards(next))) {
    throw httpError(403, "Project and team changes require owner APIs.");
  }
  assertScopedBoardWrite(req.kanbanAuth, current, next, true);
}

function assertMemberWorkspaceWriteAllowed(req: Request, current: WorkspaceState, next: WorkspaceState): void {
  if (!isAdminAuth(req)) throw httpError(403, "Team membership required.");
  if (stableJson(workspaceWithoutBoards(current)) !== stableJson(workspaceWithoutBoards(next))) {
    throw httpError(403, "Members can only update cards in assigned projects.");
  }
  assertScopedBoardWrite(req.kanbanAuth, current, next, false);
}

function assertScopedBoardWrite(auth: AdminAuthContext, current: WorkspaceState, next: WorkspaceState, allowBoardStructure: boolean): void {
  const currentBoards = new Map(current.boards.map((board) => [board.id, board]));
  const nextBoards = new Map(next.boards.map((board) => [board.id, board]));
  for (const board of current.boards) {
    if (hasProjectAccess(auth, board.projectId)) continue;
    if (stableJson(board) !== stableJson(nextBoards.get(board.id))) {
      throw httpError(403, "Cannot change boards outside your project scope.");
    }
  }
  for (const board of next.boards) {
    if (!hasProjectAccess(auth, board.projectId)) {
      const currentBoard = currentBoards.get(board.id);
      if (!currentBoard || stableJson(currentBoard) !== stableJson(board)) {
        throw httpError(403, "Cannot change boards outside your project scope.");
      }
      continue;
    }
    if (!allowBoardStructure) {
      const currentBoard = currentBoards.get(board.id);
      if (!currentBoard) throw httpError(403, "Members cannot create boards.");
      if (stableJson(memberProtectedBoardShape(currentBoard)) !== stableJson(memberProtectedBoardShape(board))) {
        throw httpError(403, "Members can only update card data.");
      }
    }
  }
}

function applyScopedBoardStateWrite(current: WorkspaceState, next: WorkspaceState, auth: AdminAuthContext, allowBoardStructure: boolean): void {
  const incomingById = new Map(next.boards.map((board) => [board.id, board]));
  if (allowBoardStructure) {
    current.boards = [
      ...next.boards.filter((board) => hasProjectAccess(auth, board.projectId)),
      ...current.boards.filter((board) => !hasProjectAccess(auth, board.projectId))
    ];
  } else {
    for (const board of current.boards) {
      if (!hasProjectAccess(auth, board.projectId)) continue;
      const incoming = incomingById.get(board.id);
      if (!incoming) continue;
      board.workItems = incoming.workItems;
      board.selectedId = incoming.selectedId;
      board.updatedAt = incoming.updatedAt;
    }
  }
  if (next.boards.some((board) => board.id === next.activeBoardId && hasProjectAccess(auth, board.projectId))) {
    current.activeBoardId = next.activeBoardId;
  }
}

function workspaceWithoutBoards(state: WorkspaceState): UnknownRecord {
  return {
    team: state.team,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    templates: state.templates
  };
}

function memberProtectedBoardShape(board: Board): UnknownRecord {
  return {
    id: board.id,
    projectId: board.projectId,
    name: board.name,
    lanes: board.lanes,
    agentSpecs: board.agentSpecs,
    flowPrompt: board.flowPrompt,
    configDraft: board.configDraft,
    isEditingFlow: board.isEditingFlow,
    createdAt: board.createdAt
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function requireBoardAccess(req: Request, boardId: string): void {
  if (isAgentAuth(req) && req.kanbanAuth.boardId !== boardId) {
    throw httpError(403, "Agent token is scoped to a different board.");
  }
}

function requireProjectAccess(req: Request, projectId: string): void {
  if (!isAdminAuth(req)) return;
  if (!hasProjectAccess(req.kanbanAuth, projectId)) {
    throw httpError(403, "Project access required.");
  }
}

function requireBoardProjectAccess(req: Request, board: Board): void {
  if (isAgentAuth(req) && req.kanbanAuth.projectId && req.kanbanAuth.projectId !== board.projectId) {
    throw httpError(403, "Agent session is scoped to a different project.");
  }
  if (isAdminAuth(req) && !hasProjectAccess(req.kanbanAuth, board.projectId)) {
    throw httpError(403, "Project access required.");
  }
}

function isAdminAuth(req: Request): req is Request & { kanbanAuth: AdminAuthContext } {
  return req.kanbanAuth?.kind === "admin";
}

function isAgentAuth(req: Request): req is Request & { kanbanAuth: AgentAuthContext } {
  return req.kanbanAuth?.kind === "agent";
}

function hasWorkspaceAccess(auth: KanbanAuthContext | undefined): boolean {
  if (!auth || auth.kind === "anonymous") return false;
  if (auth.kind === "agent") return true;
  return auth.isTeamMember;
}

function requireWorkspaceAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isAdminAuth(req) && req.kanbanAuth.isTeamMember) {
      next();
      return;
    }
    if (isAgentAuth(req)) throw httpError(403, "User authentication required.");
    throw httpError(401, "User authentication required.");
  };
}

function requireTeamManagerAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isTeamManagerAuth(req)) {
      next();
      return;
    }
    if (isAdminAuth(req)) throw httpError(403, "Owner or admin role required.");
    if (isAgentAuth(req)) throw httpError(403, "Owner or admin role required.");
    throw httpError(401, "Owner or admin role required.");
  };
}

function requireProjectManagerAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isTeamManagerAuth(req)) {
      next();
      return;
    }
    if (isAdminAuth(req)) throw httpError(403, "Owner or admin role required.");
    if (isAgentAuth(req)) throw httpError(403, "Owner or admin role required.");
    throw httpError(401, "Owner or admin role required.");
  };
}

function isTeamManagerAuth(req: Request): req is Request & { kanbanAuth: AdminAuthContext } {
  return isAdminAuth(req) && req.kanbanAuth.isTeamMember && (req.kanbanAuth.role === "owner" || req.kanbanAuth.role === "admin");
}

function assertProjectManager(req: Request, projectId: string): void {
  if (!isTeamManagerAuth(req)) throw httpError(403, "Owner or admin role required.");
  if (!hasProjectAccess(req.kanbanAuth, projectId)) throw httpError(403, "Project access required.");
}

function assertCanCreateProject(req: Request): void {
  if (!isTeamManagerAuth(req)) throw httpError(403, "Owner or admin role required.");
  if (req.kanbanAuth.role === "owner" || hasAllProjectAccess(req.kanbanAuth)) return;
  throw httpError(403, "Project creation requires owner or all-project admin access.");
}

function assertCanInviteRole(req: Request, role: TeamRole): void {
  assertCanManageRole(req, role);
}

function assertCanManageRole(req: Request, role: TeamRole): void {
  if (!isTeamManagerAuth(req)) throw httpError(403, "Owner or admin role required.");
  if (role === "owner" && req.kanbanAuth.role !== "owner") {
    throw httpError(403, "Only owners can manage owners.");
  }
}

function assertCanManageMember(req: Request, _state: WorkspaceState, member: TeamMember): void {
  if (!isTeamManagerAuth(req)) throw httpError(403, "Owner or admin role required.");
  if (member.role === "owner" && req.kanbanAuth.role !== "owner") {
    throw httpError(403, "Only owners can manage owners.");
  }
}

function assertOwnerFloor(state: WorkspaceState, member: TeamMember, nextRole: TeamRole | null): void {
  if (member.role !== "owner" || nextRole === "owner") return;
  const ownerCount = state.members.filter((candidate) => candidate.role === "owner").length;
  if (ownerCount <= 1) throw httpError(400, "At least one owner is required.");
}

function hasProjectAccess(auth: KanbanAuthContext | undefined, projectId: string): boolean {
  if (!auth || auth.kind !== "admin" || !auth.isTeamMember) return false;
  if (auth.role === "owner") return true;
  if (hasAllProjectAccess(auth)) return true;
  return auth.projectIds.includes(projectId);
}

function hasAllProjectAccess(auth: AdminAuthContext): boolean {
  return auth.projectIds.includes("*");
}

function filterProjectsByAccess(projects: Project[], auth: KanbanAuthContext | undefined): Project[] {
  if (!auth || auth.kind === "anonymous") return projects;
  if (!auth || auth.kind !== "admin") return [];
  if (!auth.isTeamMember) return [];
  if (auth.role === "owner" || hasAllProjectAccess(auth)) return projects;
  return projects.filter((project) => auth.projectIds.includes(project.id));
}

function normalizeAccessProjectIds(value: unknown, state: WorkspaceState, auth: KanbanAuthContext | undefined): string[] {
  if (!isAdminAuthContext(auth) || !auth.isTeamMember) throw httpError(403, "Team membership required.");
  const requested = Array.isArray(value) ? value.map((projectId) => String(projectId || "").trim()).filter(Boolean) : [];
  if (!requested.length) {
    if (auth.role === "owner" || hasAllProjectAccess(auth)) return ["*"];
    return auth.projectIds.length ? [...auth.projectIds] : [state.activeProjectId || DEFAULT_PROJECT_ID];
  }
  if (requested.includes("*")) {
    if (auth.role === "owner" || hasAllProjectAccess(auth)) return ["*"];
    throw httpError(403, "Cannot grant all-project access.");
  }
  const projectIds = new Set(state.projects.map((project) => project.id));
  const normalized = Array.from(new Set(requested.filter((projectId) => projectIds.has(projectId))));
  if (!normalized.length) throw httpError(400, "At least one valid project is required.");
  for (const projectId of normalized) {
    if (!hasProjectAccess(auth, projectId)) throw httpError(403, "Cannot grant access outside your project scope.");
  }
  return normalized;
}

function isAdminAuthContext(auth: KanbanAuthContext | undefined): auth is AdminAuthContext {
  return auth?.kind === "admin";
}

function createAuthConfig(options: CreateAppOptions = {}): AuthConfig {
  const productionLike = options.requireAuth ?? Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  const apiToken = options.apiToken ?? process.env.KANBAN_CARDS_API_TOKEN ?? process.env.INSTRUCT_API_TOKEN ?? "";
  const apiTokenProvided = Boolean(options.apiToken || process.env.KANBAN_CARDS_API_TOKEN || process.env.INSTRUCT_API_TOKEN);
  const platformAuthConfigured = hasPlatformAuthConfig();
  const surfaceId = process.env.PLATFORM_SURFACE_ID?.trim() || PRODUCT_NAME;
  const missingRequiredSecrets: string[] = [];

  if (productionLike && !apiToken) missingRequiredSecrets.push("KANBAN_CARDS_API_TOKEN");
  if (productionLike && !process.env.OIDC_ISSUER?.trim()) missingRequiredSecrets.push("OIDC_ISSUER");
  if (productionLike && !process.env.OIDC_CLIENT_ID?.trim()) missingRequiredSecrets.push("OIDC_CLIENT_ID");
  if (productionLike && !process.env.OIDC_REDIRECT_URI?.trim()) missingRequiredSecrets.push("OIDC_REDIRECT_URI");
  if (productionLike && !process.env.SESSION_SECRET?.trim()) missingRequiredSecrets.push("SESSION_SECRET");
  if (productionLike && process.env.PLATFORM_SURFACE_ID?.trim() !== PRODUCT_NAME) missingRequiredSecrets.push("PLATFORM_SURFACE_ID=kanban.cards");

  return {
    accessAuthRequired: Boolean(productionLike || platformAuthConfigured),
    apiToken,
    platformAuthConfigured,
    surfaceId,
    localWriteOpen: Boolean(!productionLike && !apiTokenProvided),
    missingRequiredSecrets
  };
}

function requireAccessAuth(
  auth: AuthConfig,
  tokenStore: AgentTokenStore,
  store: StateStore,
  missingRequiredConfig: string[] = auth.missingRequiredSecrets
): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    if (missingRequiredConfig.length) {
      res.status(500).json({
        error: "kanban.cards is not configured.",
        missingConfig: missingRequiredConfig
      });
      return;
    }

    req.kanbanAuth = await authenticateRequest(req, auth, tokenStore, store);

    if (!auth.accessAuthRequired || hasWorkspaceAccess(req.kanbanAuth)) {
      next();
      return;
    }

    if (isAdminAuth(req) && req.kanbanAuth.method === "session" && !req.kanbanAuth.isTeamMember) {
      if (isBrowserNavigation(req)) {
        res.status(403).type("html").send(renderNoTeamAccessPage(req.kanbanAuth));
        return;
      }
      res.status(403).json({ error: "Team membership required." });
      return;
    }

    if (isBrowserNavigation(req)) {
      res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl || req.url || "/")}`);
      return;
    }

    res.status(401).json({ error: "Authentication required." });
  });
}

async function authenticateRequest(
  req: Request,
  auth: AuthConfig,
  tokenStore: AgentTokenStore,
  store: StateStore
): Promise<KanbanAuthContext> {
  const bearerToken = getBearerToken(req);
  if (bearerToken && hasValidAdminBearer(bearerToken, auth)) return breakGlassAdminContext("bearer");

  if (bearerToken && tokenStore) {
    const record = await tokenStore.verify(bearerToken);
    if (record) {
      return {
        kind: "agent",
        method: "bearer",
        tokenId: record.id,
        boardId: record.boardId,
        agentId: record.agentId,
        last4: record.last4,
        teamId: record.teamId,
        projectId: record.projectId,
        sessionId: record.sessionId,
        delegatedBy: record.delegatedBy,
        capabilities: record.capabilities,
        expiresAt: record.expiresAt,
        reason: record.reason,
        lastUsedAt: record.lastUsedAt
      };
    }
  }

  if (auth.platformAuthConfigured) {
    const sessionResult = await getSession(toWebRequest(req));
    if (sessionResult.ok) return sessionAuthContext(sessionResult.session, store);
  }

  if (!auth.accessAuthRequired && auth.localWriteOpen) return breakGlassAdminContext("local-open");
  return { kind: "anonymous" };
}

function breakGlassAdminContext(method: "bearer" | "local-open"): AdminAuthContext {
  return {
    kind: "admin",
    method,
    userId: method === "bearer" ? "break-glass-admin" : "local-open-admin",
    email: "",
    name: method === "bearer" ? "Break-glass admin" : "Local admin",
    roles: ["admin"],
    surfaceAccess: [PRODUCT_NAME],
    teamId: DEFAULT_TEAM_ID,
    projectId: DEFAULT_PROJECT_ID,
    memberId: method === "bearer" ? "break-glass-admin" : "local-open-admin",
    role: "owner",
    isTeamMember: true,
    projectIds: ["*"]
  };
}

function requireAdminAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isAdminAuth(req)) {
      next();
      return;
    }

    if (isAgentAuth(req)) throw httpError(403, "Admin authentication required.");
    throw httpError(401, "Admin authentication required.");
  };
}

function requireWriteAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isAdminAuth(req) || isAgentAuth(req)) {
      next();
      return;
    }

    throw httpError(401, "Missing or invalid API token.");
  };
}

function hasValidAdminBearer(token: string, auth: AuthConfig): boolean {
  if (!auth.apiToken) return false;
  return safeEqual(token, auth.apiToken);
}

function getBearerToken(req: Request): string {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function safeEqual(left: unknown, right: unknown): boolean {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function sessionAuthContext(session: PlatformSession, store: StateStore): Promise<SessionAdminAuthContext> {
  const { result } = await store.update((state) => {
    if (!state.members.length) ensureStateTeam(state, session.workspaceId);
    let member = findTeamMemberByIdentity(state, {
      userId: session.userId,
      email: session.email
    });
    if (!member && !state.members.length) {
      member = createTeamMember({
        teamId: state.team.id,
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: "owner",
        projectIds: ["*"]
      });
      state.members.push(member);
    } else if (member) {
      member.userId = session.userId;
      member.email = normalizeEmailInput(session.email);
      member.name = session.name || member.name;
      member.lastSeenAt = new Date().toISOString();
      touchTeamMember(member);
    }

    return {
      teamId: state.team.id || session.workspaceId,
      projectId: activeProjectIdForMember(state, member),
      member: member ? { ...member, projectIds: [...member.projectIds] } : null
    };
  });

  return {
    kind: "admin",
    method: "session",
    userId: session.userId,
    email: session.email,
    name: session.name,
    workspaceId: session.workspaceId,
    roles: session.roles,
    surfaceAccess: session.surfaceAccess,
    teamId: result.teamId,
    projectId: result.projectId,
    memberId: result.member?.id || null,
    role: result.member?.role || null,
    isTeamMember: Boolean(result.member),
    projectIds: result.member?.projectIds || []
  };
}

async function publicSession(session: PlatformSession, store: StateStore): Promise<PlatformSession & {
  teamId: string;
  projectId: string;
  memberId: string | null;
  role: TeamRole | null;
  isTeamMember: boolean;
  projectIds: string[];
}> {
  const context = await sessionAuthContext(session, store);
  return {
    ...session,
    teamId: context.teamId,
    projectId: context.projectId,
    memberId: context.memberId,
    role: context.role,
    isTeamMember: context.isTeamMember,
    projectIds: context.projectIds
  };
}

async function readActiveProjectId(store: StateStore): Promise<string> {
  try {
    const state = await store.read();
    return state.activeProjectId || DEFAULT_PROJECT_ID;
  } catch (_error) {
    return DEFAULT_PROJECT_ID;
  }
}

function activeProjectIdForMember(state: WorkspaceState, member: TeamMember | null): string {
  if (!member) return state.activeProjectId || DEFAULT_PROJECT_ID;
  if (member.projectIds.includes("*")) return state.activeProjectId || DEFAULT_PROJECT_ID;
  if (member.projectIds.includes(state.activeProjectId)) return state.activeProjectId;
  return member.projectIds.find((projectId) => state.projects.some((project) => project.id === projectId)) || DEFAULT_PROJECT_ID;
}

function findInviteByToken(state: WorkspaceState, rawToken: string): TeamInvite | null {
  const tokenHash = hashInviteToken(rawToken);
  const now = Date.now();
  return state.invites.find((invite) => {
    if (invite.status !== "pending") return false;
    if (invite.tokenHash !== tokenHash) return false;
    const expiresAt = new Date(invite.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
  }) || null;
}

function createInviteToken(): string {
  return `kcinv_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashInviteToken(rawToken: string): string {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

function normalizeEmailInput(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeTeamRole(value: unknown): TeamRole | null {
  const role = String(value || "").trim();
  if (role === "owner" || role === "admin" || role === "member") return role;
  return null;
}

function absoluteUrl(req: Request, pathAndQuery: string): string {
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host") || "127.0.0.1";
  return `${protocol}://${host}${pathAndQuery}`;
}

function renderInviteAcceptPage(invite: TeamInvite, session: PlatformSession, token: string): string {
  const emailMatches = normalizeEmailInput(invite.email) === normalizeEmailInput(session.email);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Accept invite - kanban.cards</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="app-body">
  <main class="invite-page">
    <section class="modal-card invite-card">
      <p class="eyebrow">kanban.cards invite</p>
      <h1>Join ${escapeHtml(invite.email)}</h1>
      <dl class="settings-meta-grid">
        ${renderHtmlMetadataItem("Signed in as", session.email || session.userId)}
        ${renderHtmlMetadataItem("Invite email", invite.email)}
        ${renderHtmlMetadataItem("Role", invite.role)}
        ${renderHtmlMetadataItem("Project access", invite.projectIds.includes("*") ? "All projects" : invite.projectIds.join(", "))}
        ${renderHtmlMetadataItem("Expires", invite.expiresAt)}
      </dl>
      ${emailMatches ? `
        <form method="post" action="/invites/accept">
          <input type="hidden" name="token" value="${escapeAttribute(token)}">
          <div class="modal-actions">
            <button class="primary-button" type="submit">Accept invite</button>
            <a class="secondary-button" href="/">Cancel</a>
          </div>
        </form>
      ` : `
        <p class="flow-message warning">This invite is for ${escapeHtml(invite.email)}. Sign in with that email to accept it.</p>
        <div class="modal-actions">
          <a class="primary-button" href="/auth/logout?global=1">Switch account</a>
        </div>
      `}
    </section>
  </main>
</body>
</html>`;
}

function renderInviteMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - kanban.cards</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="app-body">
  <main class="invite-page">
    <section class="modal-card invite-card">
      <p class="eyebrow">kanban.cards invite</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="modal-copy">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <a class="secondary-button" href="/">Back to kanban.cards</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderNoTeamAccessPage(auth: SessionAdminAuthContext): string {
  return renderInviteMessagePage("Team access required", `${auth.email || auth.userId} is signed in, but is not a member of this kanban.cards team yet. Use an invite link or ask an owner/admin for access.`);
}

function renderHtmlMetadataItem(label: string, value: unknown): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "n/a")}</dd></div>`;
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

async function runRoadmapSeed(
  req: Request,
  auth: AuthConfig,
  input: { dryRun?: boolean; projectId?: string | null } = {}
) {
  if (!auth.apiToken) {
    throw httpError(500, "KANBAN_CARDS_API_TOKEN is not configured for server-side roadmap seeding.");
  }

  return seedRoadmap({
    apiBaseUrl: `${requestOrigin(req)}/api`,
    apiToken: auth.apiToken,
    projectId: input.projectId || undefined,
    dryRun: Boolean(input.dryRun)
  });
}

function requestOrigin(req: Request): string {
  const protocol = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0]?.trim() || "http";
  const host = (req.get("x-forwarded-host") || req.get("host") || `${DEFAULT_HOST}:${DEFAULT_PORT}`).split(",")[0]?.trim();
  return `${protocol}://${host}`;
}

function parseBooleanInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(parseBooleanInput);
  const text = String(value || "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function optionalText(value: unknown): string | null {
  if (Array.isArray(value)) return optionalText(value[0]);
  return nullableString(value);
}

function renderRoadmapSeedPage(report?: Awaited<ReturnType<typeof seedRoadmap>>): string {
  const reportText = report ? formatSeedRoadmapReport(report) : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Roadmap seed - kanban.cards</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f4f6f8; color: #18202a; }
    main { max-width: 760px; margin: 56px auto; padding: 0 24px; }
    section { background: #fff; border: 1px solid #d8e0ea; border-radius: 8px; padding: 24px; box-shadow: 0 18px 40px rgba(31, 45, 61, 0.08); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { color: #526173; line-height: 1.5; }
    label { display: grid; gap: 6px; margin: 20px 0; font-weight: 700; }
    input { border: 1px solid #cfd8e3; border-radius: 6px; font: inherit; padding: 10px 12px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; }
    button { border: 1px solid #2e5d96; border-radius: 6px; background: #2e5d96; color: #fff; cursor: pointer; font: inherit; font-weight: 700; padding: 10px 14px; }
    button.secondary { background: #fff; color: #2e5d96; }
    pre { white-space: pre-wrap; background: #101820; color: #e8eef6; border-radius: 6px; margin-top: 24px; padding: 16px; overflow-x: auto; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Seed product roadmap</h1>
      <p>This protected operation creates or updates the kanban.cards Product Roadmap board using the server runtime configuration. It does not expose the admin bearer token to the browser.</p>
      <form method="post" action="/admin/roadmap-seed">
        <label>
          Project ID
          <input name="projectId" placeholder="Active project, then kanban.cards:default">
        </label>
        <div class="actions">
          <button class="secondary" type="submit" name="dryRun" value="1">Dry run</button>
          <button type="submit" name="dryRun" value="0">Seed roadmap</button>
        </div>
      </form>
      ${report ? `<pre>${escapeHtml(reportText)}</pre>` : ""}
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isBrowserNavigation(req: Request): boolean {
  if (req.path.startsWith("/api/")) return false;
  const accept = req.get("accept") || "";
  const mode = req.get("sec-fetch-mode") || "";
  return mode === "navigate" || accept.includes("text/html") || !req.path.startsWith("/api/");
}

function toWebRequest(req: Request): globalThis.Request {
  const protocol = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0]?.trim() || "http";
  const host = (req.get("x-forwarded-host") || req.get("host") || `${DEFAULT_HOST}:${DEFAULT_PORT}`).split(",")[0]?.trim();
  const url = `${protocol}://${host}${req.originalUrl || req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return new globalThis.Request(url, { headers });
}

async function sendPlatformAuthResponse(res: Response, response: PlatformAuthRouteResponse): Promise<void> {
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase() === "set-cookie" && Array.isArray(value)) res.setHeader(name, value);
    else res.setHeader(name, value);
  }
  if (response.json !== undefined) {
    res.status(response.status).json(response.json);
    return;
  }
  if (response.body !== undefined) {
    res.status(response.status).send(response.body);
    return;
  }
  res.status(response.status).end();
}

function serveIndex(staticDir: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    const html = await readIndexHtml(staticDir);
    const injected = html.replace(
      '<script src="app.js"></script>',
      '<script>window.KANBAN_CARDS_API_BASE_URL="/api";</script>\n  <script src="app.js"></script>'
    );
    res.type("html").send(injected);
  });
}

async function readIndexHtml(staticDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(staticDir, "index.html"), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return FALLBACK_INDEX_HTML;
    throw error;
  }
}

function sendStaticFile(staticDir: string, filename: string, contentType: string): RequestHandler {
  return (_req: Request, res: Response) => {
    res.type(contentType).sendFile(path.join(staticDir, filename));
  };
}

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status: number, message: string): HttpError {
  const error: HttpError = new Error(message);
  error.status = status;
  return error;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function queryString(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return nullableString(raw);
}

function queryLimit(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === "") return undefined;
  const limit = Number(raw);
  return Number.isFinite(limit) ? limit : undefined;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

export function startServer(options: CreateAppOptions = {}) {
  const host = options.host || process.env.HOST || DEFAULT_HOST;
  const port = Number(options.port || process.env.PORT || DEFAULT_PORT);
  const app = createApp(options);
  return app.listen(port, host, () => {
    console.log(`${PRODUCT_NAME} server listening at http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

const defaultApp = createApp();
export default defaultApp;
