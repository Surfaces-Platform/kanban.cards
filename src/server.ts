import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import {
  COMMENT_KINDS,
  COMMENT_STATUSES,
  createBoard,
  createComment,
  createStateStore,
  createWorkItem,
  findBoard,
  findComment,
  findWorkItem,
  normalizeWorkspace,
  touchBoard,
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
import type {
  AgentInstruction,
  AgentSpec,
  AgentTokenStore,
  Board,
  CommentKind,
  CommentStatus,
  EventStore,
  PostgresOptions,
  StateStore,
  WorkspaceEvent,
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
};
type AdminAuthContext =
  | { kind: "admin"; method: "bearer" | "local-open" }
  | SessionAdminAuthContext;
type AgentAuthContext = {
  kind: "agent";
  method: "bearer";
  tokenId: string;
  boardId: string;
  agentId: string;
  last4: string;
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
const DEFAULT_PROJECT_ID = "kanban.cards:default";
const SSE_HEARTBEAT_MS = 25_000;
const SSE_POLL_MS = 1_000;
const SSE_BATCH_LIMIT = 200;
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
    res.json(publicSession(result.session));
  }));

  app.use(requireAccessAuth(auth, tokenStore, missingRequiredConfig));

  app.get("/", serveIndex(staticDir));
  app.get("/index.html", serveIndex(staticDir));
  app.get("/app.js", sendStaticFile(staticDir, "public/app.js", "application/javascript; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "public/styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", sendStaticFile(staticDir, "public/robots.txt", "text/plain; charset=utf-8"));

  app.get("/api/state", asyncHandler(async (req, res) => {
    if (isAgentAuth(req)) throw httpError(403, "Agent tokens cannot read full workspace state.");
    res.json(await store.read());
  }));

  app.put("/api/state", requireAdminAuth(), asyncHandler(async (req, res) => {
    const saved = await store.write(req.body);
    await publishWorkspaceEvent(null, "workspace_saved");
    res.json(saved);
  }));

  app.get("/api/events", asyncHandler(async (req, res) => {
    if (isAgentAuth(req)) throw httpError(403, "Agent tokens cannot subscribe to workspace events.");
    await streamWorkspaceEvents(req, res);
  }));

  app.get("/api/boards", asyncHandler(async (req, res) => {
    const state = await store.read();
    if (isAgentAuth(req)) {
      const board = findBoard(state, req.kanbanAuth.boardId);
      if (!board) throw httpError(404, "Board not found.");
      res.json({ boards: [board], activeBoardId: board.id });
      return;
    }
    res.json({ boards: state.boards, activeBoardId: state.activeBoardId });
  }));

  app.get("/api/boards/:boardId", asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    requireBoardAccess(req, boardId);
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    res.json(board);
  }));

  app.get("/api/agent/instructions", asyncHandler(async (req, res) => {
    const state = await store.read();
    if (isAgentAuth(req)) {
      res.json({ instructions: collectAgentInstructions(state, req.kanbanAuth.agentId, req.kanbanAuth.boardId) });
      return;
    }
    res.json({ instructions: collectAgentInstructions(state, req.query.agentId) });
  }));

  app.get("/api/agent/session", asyncHandler(async (req, res) => {
    if (isAdminAuth(req)) {
      res.json({ mode: "admin" });
      return;
    }
    if (!isAgentAuth(req)) throw httpError(401, "Agent authentication required.");

    const state = await store.read();
    const board = findBoard(state, req.kanbanAuth.boardId);
    if (!board) throw httpError(404, "Board not found.");
    const agent = findAgentSpec(board, req.kanbanAuth.agentId);
    if (!agent) throw httpError(404, "Agent not found.");
    res.json({
      mode: "agent",
      board,
      agent,
      token: {
        id: req.kanbanAuth.tokenId,
        last4: req.kanbanAuth.last4,
        lastUsedAt: req.kanbanAuth.lastUsedAt
      }
    });
  }));

  app.post("/api/boards/:boardId/agent-tokens", requireAdminAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    const agentId = nullableString(req.body?.agentId);
    if (!agentId) throw httpError(400, "agentId is required.");
    const agent = findAgentSpec(board, agentId);
    if (!agent) throw httpError(404, "Agent not found on this board.");
    const created = await tokenStore.create({
      boardId: board.id,
      agentId: agent.id,
      label: req.body?.label
    });
    await publishWorkspaceEvent(board.id, "agent_token_created");
    res.status(201).json({
      ...created.tokenRecord,
      token: created.token
    });
  }));

  app.get("/api/boards/:boardId/agent-tokens", requireAdminAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    res.json({ tokens: await tokenStore.list(board.id) });
  }));

  app.delete("/api/boards/:boardId/agent-tokens/:tokenId", requireAdminAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const tokenId = routeParam(req, "tokenId");
    const state = await store.read();
    const board = findBoard(state, boardId);
    if (!board) throw httpError(404, "Board not found.");
    const tokenRecord = await tokenStore.revoke(board.id, tokenId);
    if (!tokenRecord) throw httpError(404, "Token not found.");
    await publishWorkspaceEvent(board.id, "agent_token_revoked");
    res.json(tokenRecord);
  }));

  app.post("/api/boards", requireAdminAuth(), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = createBoard(req.body || {});
      state.boards.push(board);
      state.activeBoardId = board.id;
      return board;
    });
    await publishWorkspaceEvent(result.id, "board_created");
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId", requireAdminAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      if (typeof req.body.name === "string") board.name = req.body.name;
      if (typeof req.body.flowPrompt === "string") board.flowPrompt = req.body.flowPrompt;
      if (Object.prototype.hasOwnProperty.call(req.body, "configDraft")) board.configDraft = req.body.configDraft;
      if (Object.prototype.hasOwnProperty.call(req.body, "isEditingFlow")) board.isEditingFlow = Boolean(req.body.isEditingFlow);
      if (Array.isArray(req.body.lanes)) board.lanes = req.body.lanes;
      if (Array.isArray(req.body.agentSpecs)) board.agentSpecs = req.body.agentSpecs;
      if (req.body.active === true) state.activeBoardId = board.id;
      touchBoard(board);
      return board;
    });
    await publishWorkspaceEvent(result.id, "board_updated");
    res.json(result);
  }));

  app.post("/api/boards/:boardId/work-items", requireWriteAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      if (!String(req.body.title || "").trim()) throw httpError(400, "Card title is required.");
      const input = isAgentAuth(req) ? withAgentCreateDefaults(req, req.body || {}) : req.body;
      const item = createWorkItem(input, board);
      if (!item) throw httpError(400, "Card is invalid.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only create cards assigned to that agent.");
      }
      board.workItems.push(item);
      touchBoard(board);
      return item;
    });
    await publishWorkspaceEvent(boardId, "card_created");
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId", requireWriteAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
      const item = findWorkItem(board, itemId);
      if (!item) throw httpError(404, "Card not found.");
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens can only update cards assigned to that agent.");
      }
      applyWorkItemPatch(board, item, req.body || {});
      if (isAgentAuth(req) && !isItemAssignedToAgent(item, req.kanbanAuth.agentId)) {
        throw httpError(403, "Agent tokens cannot remove themselves from an assigned card.");
      }
      touchWorkItem(item);
      touchBoard(board);
      return item;
    });
    await publishWorkspaceEvent(boardId, "card_updated");
    res.json(result);
  }));

  app.post("/api/boards/:boardId/work-items/:itemId/comments", requireWriteAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
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
      return comment;
    });
    await publishWorkspaceEvent(boardId, "comment_created");
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId/comments/:commentId", requireWriteAuth(), asyncHandler(async (req, res) => {
    const boardId = routeParam(req, "boardId");
    const itemId = routeParam(req, "itemId");
    const commentId = routeParam(req, "commentId");
    requireBoardAccess(req, boardId);
    const { result } = await store.update((state) => {
      const board = findBoard(state, boardId);
      if (!board) throw httpError(404, "Board not found.");
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
      return comment;
    });
    await publishWorkspaceEvent(boardId, "comment_updated");
    res.json(result);
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

  async function publishWorkspaceEvent(boardId: string | null, reason: string): Promise<WorkspaceEvent> {
    const event = await eventStore.append({
      type: "workspace_changed",
      boardId,
      payload: {
        reason,
        updatedAt: new Date().toISOString()
      }
    });
    notifyEventSubscribers(eventSubscribers);
    return event;
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

function applyWorkItemPatch(board: Board, item: WorkItem, patch: UnknownRecord): void {
  if (typeof patch.title === "string") item.title = patch.title;
  if (typeof patch.summary === "string") item.summary = patch.summary;
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

function requireBoardAccess(req: Request, boardId: string): void {
  if (isAgentAuth(req) && req.kanbanAuth.boardId !== boardId) {
    throw httpError(403, "Agent token is scoped to a different board.");
  }
}

function isAdminAuth(req: Request): req is Request & { kanbanAuth: AdminAuthContext } {
  return req.kanbanAuth?.kind === "admin";
}

function isAgentAuth(req: Request): req is Request & { kanbanAuth: AgentAuthContext } {
  return req.kanbanAuth?.kind === "agent";
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

    req.kanbanAuth = await authenticateRequest(req, auth, tokenStore);

    if (!auth.accessAuthRequired || isAdminAuth(req) || isAgentAuth(req)) {
      next();
      return;
    }

    if (isBrowserNavigation(req)) {
      res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl || req.url || "/")}`);
      return;
    }

    res.status(401).json({ error: "Authentication required." });
  });
}

async function authenticateRequest(req: Request, auth: AuthConfig, tokenStore: AgentTokenStore): Promise<KanbanAuthContext> {
  const bearerToken = getBearerToken(req);
  if (bearerToken && hasValidAdminBearer(bearerToken, auth)) return { kind: "admin", method: "bearer" };

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
        lastUsedAt: record.lastUsedAt
      };
    }
  }

  if (auth.platformAuthConfigured) {
    const sessionResult = await getSession(toWebRequest(req));
    if (sessionResult.ok) return sessionAuthContext(sessionResult.session);
  }

  if (!auth.accessAuthRequired && auth.localWriteOpen) return { kind: "admin", method: "local-open" };
  return { kind: "anonymous" };
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

function sessionAuthContext(session: PlatformSession): SessionAdminAuthContext {
  return {
    kind: "admin",
    method: "session",
    userId: session.userId,
    email: session.email,
    name: session.name,
    workspaceId: session.workspaceId,
    roles: session.roles,
    surfaceAccess: session.surfaceAccess,
    teamId: session.workspaceId,
    projectId: DEFAULT_PROJECT_ID
  };
}

function publicSession(session: PlatformSession): PlatformSession & { teamId: string; projectId: string } {
  return {
    ...session,
    teamId: session.workspaceId,
    projectId: DEFAULT_PROJECT_ID
  };
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

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
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
