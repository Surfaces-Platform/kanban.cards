const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
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
} = require("./state-store");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PRODUCT_NAME = "kanban.cards";
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
      <button class="primary-button" type="button" id="new-work-item" disabled title="Configure lanes before adding cards.">New card</button>
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

function createApp(options = {}) {
  const staticDir = options.staticDir || __dirname;
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
      authRequired: auth.accessAuthRequired,
      writeAuthRequired: !auth.localWriteOpen,
      missingConfig: missingRequiredConfig
    });
  });

  app.use(requireAccessAuth(auth, missingRequiredConfig));

  app.get("/", serveIndex(staticDir));
  app.get("/index.html", serveIndex(staticDir));
  app.get("/app.js", sendStaticFile(staticDir, "app.js", "application/javascript; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", sendStaticFile(staticDir, "robots.txt", "text/plain; charset=utf-8"));

  app.get("/api/state", asyncHandler(async (_req, res) => {
    res.json(await store.read());
  }));

  app.put("/api/state", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    res.json(await store.write(req.body));
  }));

  app.get("/api/boards", asyncHandler(async (_req, res) => {
    const state = await store.read();
    res.json({ boards: state.boards, activeBoardId: state.activeBoardId });
  }));

  app.get("/api/boards/:boardId", asyncHandler(async (req, res) => {
    const state = await store.read();
    const board = findBoard(state, req.params.boardId);
    if (!board) throw httpError(404, "Board not found.");
    res.json(board);
  }));

  app.get("/api/agent/instructions", asyncHandler(async (req, res) => {
    const state = await store.read();
    res.json({ instructions: collectAgentInstructions(state, req.query.agentId) });
  }));

  app.post("/api/boards", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = createBoard(req.body || {});
      state.boards.push(board);
      state.activeBoardId = board.id;
      return board;
    });
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = findBoard(state, req.params.boardId);
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
    res.json(result);
  }));

  app.post("/api/boards/:boardId/work-items", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = findBoard(state, req.params.boardId);
      if (!board) throw httpError(404, "Board not found.");
      if (!String(req.body.title || "").trim()) throw httpError(400, "Card title is required.");
      const item = createWorkItem(req.body, board);
      if (!item) throw httpError(400, "Card is invalid.");
      board.workItems.push(item);
      touchBoard(board);
      return item;
    });
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = findBoard(state, req.params.boardId);
      if (!board) throw httpError(404, "Board not found.");
      const item = findWorkItem(board, req.params.itemId);
      if (!item) throw httpError(404, "Card not found.");
      applyWorkItemPatch(board, item, req.body || {});
      touchWorkItem(item);
      touchBoard(board);
      return item;
    });
    res.json(result);
  }));

  app.post("/api/boards/:boardId/work-items/:itemId/comments", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = findBoard(state, req.params.boardId);
      if (!board) throw httpError(404, "Board not found.");
      const item = findWorkItem(board, req.params.itemId);
      if (!item) throw httpError(404, "Card not found.");
      const comment = createComment(req.body || {});
      if (!comment) throw httpError(400, "Comment text is required.");
      item.comments.push(comment);
      touchWorkItem(item);
      touchBoard(board);
      return comment;
    });
    res.status(201).json(result);
  }));

  app.patch("/api/boards/:boardId/work-items/:itemId/comments/:commentId", requireWriteAuth(auth), asyncHandler(async (req, res) => {
    const { result } = await store.update((state) => {
      const board = findBoard(state, req.params.boardId);
      if (!board) throw httpError(404, "Board not found.");
      const item = findWorkItem(board, req.params.itemId);
      if (!item) throw httpError(404, "Card not found.");
      const comment = findComment(item, req.params.commentId);
      if (!comment) throw httpError(404, "Comment not found.");
      applyCommentPatch(comment, req.body || {});
      touchWorkItem(item);
      touchBoard(board);
      return comment;
    });
    res.json(result);
  }));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found.", path: req.path });
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({
      error: status === 500 ? "Internal server error." : error.message
    });
  });

  return app;
}

function applyWorkItemPatch(board, item, patch) {
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

function applyCommentPatch(comment, patch) {
  if (typeof patch.text === "string" && patch.text.trim()) comment.text = patch.text.trim();
  if (typeof patch.author === "string" && patch.author.trim()) comment.author = patch.author.trim();
  if (typeof patch.kind === "string") {
    if (!COMMENT_KINDS.has(patch.kind)) throw httpError(400, "Invalid comment kind.");
    comment.kind = patch.kind;
  }
  if (typeof patch.status === "string") {
    if (!COMMENT_STATUSES.has(patch.status)) throw httpError(400, "Invalid comment status.");
    comment.status = patch.status;
  }
  comment.updatedAt = new Date().toISOString();
}

function collectAgentInstructions(state, agentId) {
  const normalizedAgentId = nullableString(agentId);
  const actionableKinds = new Set(["instruction", "question", "change_request"]);
  const actionableStatuses = new Set(["open", "acknowledged"]);
  const instructions = [];

  for (const board of state.boards) {
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

function createAuthConfig(options = {}) {
  const productionLike = options.requireAuth ?? Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  const apiToken = options.apiToken ?? process.env.KANBAN_CARDS_API_TOKEN ?? process.env.INSTRUCT_API_TOKEN ?? "";
  const apiTokenProvided = Boolean(options.apiToken || process.env.KANBAN_CARDS_API_TOKEN || process.env.INSTRUCT_API_TOKEN);
  const basicUser = options.basicUser ?? process.env.KANBAN_CARDS_BASIC_USER ?? "";
  const basicPassword = options.basicPassword ?? process.env.KANBAN_CARDS_BASIC_PASSWORD ?? "";
  const basicConfigured = Boolean(basicUser && basicPassword);
  const missingRequiredSecrets = [];

  if (productionLike && !apiToken) missingRequiredSecrets.push("KANBAN_CARDS_API_TOKEN");
  if (productionLike && !basicUser) missingRequiredSecrets.push("KANBAN_CARDS_BASIC_USER");
  if (productionLike && !basicPassword) missingRequiredSecrets.push("KANBAN_CARDS_BASIC_PASSWORD");

  return {
    accessAuthRequired: Boolean(productionLike || basicConfigured),
    apiToken,
    basicUser,
    basicPassword,
    localWriteOpen: Boolean(!productionLike && !apiTokenProvided),
    missingRequiredSecrets
  };
}

function requireAccessAuth(auth, missingRequiredConfig = auth.missingRequiredSecrets) {
  return (req, res, next) => {
    if (missingRequiredConfig.length) {
      res.status(500).json({
        error: "kanban.cards is not configured.",
        missingConfig: missingRequiredConfig
      });
      return;
    }

    if (!auth.accessAuthRequired || hasValidBearer(req, auth) || hasValidBasic(req, auth)) {
      next();
      return;
    }

    res.set("WWW-Authenticate", 'Basic realm="kanban.cards", charset="UTF-8"');
    res.status(401).json({ error: "Authentication required." });
  };
}

function requireWriteAuth(auth) {
  return (req, _res, next) => {
    if (auth.localWriteOpen || hasValidBearer(req, auth) || hasValidBasic(req, auth)) {
      next();
      return;
    }

    throw httpError(401, "Missing or invalid API token.");
  };
}

function hasValidBearer(req, auth) {
  if (!auth.apiToken) return false;
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && safeEqual(match[1], auth.apiToken));
}

function hasValidBasic(req, auth) {
  if (!auth.basicUser || !auth.basicPassword) return false;
  const header = req.get("authorization") || "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;

  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch (_error) {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) return false;
  const user = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return safeEqual(user, auth.basicUser) && safeEqual(password, auth.basicPassword);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function serveIndex(staticDir) {
  return asyncHandler(async (_req, res) => {
    const html = await readIndexHtml(staticDir);
    const injected = html.replace(
      '<script src="app.js"></script>',
      '<script>window.KANBAN_CARDS_API_BASE_URL="/api";</script>\n  <script src="app.js"></script>'
    );
    res.type("html").send(injected);
  });
}

async function readIndexHtml(staticDir) {
  try {
    return await fs.readFile(path.join(staticDir, "index.html"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return FALLBACK_INDEX_HTML;
    throw error;
  }
}

function sendStaticFile(staticDir, filename, contentType) {
  return (_req, res) => {
    res.type(contentType).sendFile(path.join(staticDir, filename));
  };
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function startServer(options = {}) {
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

const defaultApp = createApp();
module.exports = defaultApp;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
