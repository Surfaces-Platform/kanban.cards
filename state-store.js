const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const COMMENT_KINDS = new Set(["progress", "instruction", "question", "change_request", "note"]);
const COMMENT_STATUSES = new Set(["open", "acknowledged", "resolved"]);
const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_TABLE_NAME = "kanban_workspaces";

function createStateStore(options = {}) {
  if (typeof options === "string") return createFileStateStore(options);

  const connectionString = options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString) {
    return createPostgresStateStore({
      connectionString,
      workspaceId: options.workspaceId,
      tableName: options.tableName,
      pool: options.pool,
      ssl: options.ssl
    });
  }

  return createFileStateStore(options.dataPath || path.join(__dirname, "data", "kanban-cards-state.json"));
}

function createFileStateStore(dataPath) {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue = Promise.resolve();

  async function read() {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      return normalizeWorkspace(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const state = freshWorkspaceState();
      await write(state);
      return state;
    }
  }

  async function write(nextState) {
    const normalized = normalizeWorkspace(nextState);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, resolvedPath);
    return normalized;
  }

  async function update(mutator) {
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const state = await read();
        const result = mutator(state);
        const saved = await write(state);
        return { state: saved, result };
      });
    return writeQueue;
  }

  return { kind: "file", path: resolvedPath, read, write, update };
}

function createPostgresStateStore(options = {}) {
  const { Pool } = require("pg");
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
  const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
  const pool = options.pool || new Pool({
    connectionString: options.connectionString,
    ssl: resolvePostgresSsl(options)
  });
  let readyPromise = null;

  async function ensureReady(client = pool) {
    if (!readyPromise || client !== pool) {
      const ready = client.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id text PRIMARY KEY,
          state jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      if (client === pool) readyPromise = ready;
      await ready;
      return;
    }

    await readyPromise;
  }

  async function read() {
    await ensureReady();
    const result = await pool.query(`SELECT state FROM ${tableName} WHERE id = $1`, [workspaceId]);
    if (!result.rows.length) return write(freshWorkspaceState());
    return normalizeWorkspace(result.rows[0].state);
  }

  async function write(nextState) {
    const normalized = normalizeWorkspace(nextState);
    await ensureReady();
    await pool.query(
      `INSERT INTO ${tableName} (id, state, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [workspaceId, JSON.stringify(normalized)]
    );
    return normalized;
  }

  async function update(mutator) {
    const client = await pool.connect();
    try {
      await ensureReady(client);
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${tableName} (id, state, created_at, updated_at)
         VALUES ($1, $2::jsonb, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [workspaceId, JSON.stringify(freshWorkspaceState())]
      );
      const result = await client.query(`SELECT state FROM ${tableName} WHERE id = $1 FOR UPDATE`, [workspaceId]);
      const state = normalizeWorkspace(result.rows[0]?.state);
      const mutationResult = mutator(state);
      const normalized = normalizeWorkspace(state);
      await client.query(`UPDATE ${tableName} SET state = $2::jsonb, updated_at = now() WHERE id = $1`, [
        workspaceId,
        JSON.stringify(normalized)
      ]);
      await client.query("COMMIT");
      return { state: normalized, result: mutationResult };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { kind: "postgres", path: `${tableName}:${workspaceId}`, read, write, update };
}

function resolvePostgresSsl(options = {}) {
  if (options.ssl !== undefined) return options.ssl;
  if (process.env.KANBAN_CARDS_POSTGRES_SSL === "disable") return false;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return { rejectUnauthorized: false };
  return undefined;
}

function freshWorkspaceState() {
  const board = createBoard({ name: "Untitled board" });
  return {
    boards: [board],
    activeBoardId: board.id,
    templates: []
  };
}

function createBoard(input = {}) {
  const now = new Date().toISOString();
  return normalizeBoard({
    id: input.id || makeId("board"),
    name: input.name || "Untitled board",
    lanes: input.lanes || [],
    agentSpecs: input.agentSpecs || [],
    workItems: input.workItems || [],
    selectedId: input.selectedId || null,
    flowPrompt: input.flowPrompt || "",
    configDraft: input.configDraft || null,
    isEditingFlow: Boolean(input.isEditingFlow),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  });
}

function normalizeWorkspace(rawState) {
  const boards = Array.isArray(rawState?.boards)
    ? rawState.boards.map(normalizeBoard).filter(Boolean)
    : [];

  if (!boards.length) boards.push(createBoard({ name: "Untitled board" }));

  const activeBoardId = boards.some((board) => board.id === rawState?.activeBoardId)
    ? rawState.activeBoardId
    : boards[0].id;

  const templates = Array.isArray(rawState?.templates)
    ? rawState.templates.map(normalizeTemplate).filter(Boolean)
    : [];

  return { boards, activeBoardId, templates };
}

function normalizeBoard(rawBoard) {
  if (!rawBoard || typeof rawBoard !== "object") return null;

  const lanes = Array.isArray(rawBoard.lanes)
    ? withUniqueLaneIds(rawBoard.lanes.map(normalizeLane).filter(Boolean))
    : [];
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawBoard.agentSpecs)
    ? withUniqueAgentIds(rawBoard.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(Boolean))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  const normalizedLanes = lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds));
  const workItems = Array.isArray(rawBoard.workItems)
    ? rawBoard.workItems.map((item) => normalizeWorkItem(item, normalizedLanes)).filter(Boolean)
    : [];
  const selectedId = workItems.some((item) => item.id === rawBoard.selectedId)
    ? rawBoard.selectedId
    : null;
  const configDraft = normalizeDraft(rawBoard.configDraft);
  const name = String(rawBoard.name || "Untitled board").trim() || "Untitled board";
  const now = new Date().toISOString();

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
    createdAt: rawBoard.createdAt || now,
    updatedAt: rawBoard.updatedAt || now
  };
}

function normalizeTemplate(rawTemplate) {
  if (!rawTemplate || typeof rawTemplate !== "object") return null;

  const lanes = Array.isArray(rawTemplate.lanes)
    ? withUniqueLaneIds(rawTemplate.lanes.map(normalizeLane).filter(Boolean))
    : [];
  const name = String(rawTemplate.name || "").trim();
  if (!name || !lanes.length) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawTemplate.agentSpecs)
    ? withUniqueAgentIds(rawTemplate.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(Boolean))
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

function normalizeDraft(draft) {
  if (!draft || !Array.isArray(draft.lanes)) return null;
  const lanes = withUniqueLaneIds(draft.lanes.map(normalizeLane).filter(Boolean));
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(draft.agentSpecs)
    ? withUniqueAgentIds(draft.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(Boolean))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  return {
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds)),
    agentSpecs
  };
}

function normalizeLane(lane) {
  if (!lane || typeof lane !== "object") return null;
  const title = String(lane.title || "").trim();
  if (!title) return null;

  const checks = Array.isArray(lane.gate?.checks)
    ? lane.gate.checks.map((check) => String(check || "").trim()).filter(Boolean)
    : defaultGateChecks(title);

  return {
    id: String(lane.id || slugify(title)).trim() || slugify(title),
    title,
    description: String(lane.description || "").trim(),
    defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
    defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
    gate: {
      title: String(lane.gate?.title || `${title} gate`).trim(),
      checks: checks.length ? checks : defaultGateChecks(title)
    }
  };
}

function normalizeAgentSpec(rawAgent, laneIds = new Set()) {
  if (!rawAgent || typeof rawAgent !== "object") return null;
  const name = String(rawAgent.name || "").trim();
  const id = String(rawAgent.id || slugify(name)).trim() || slugify(name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: String(rawAgent.role || "").trim(),
    laneIds: Array.isArray(rawAgent.laneIds)
      ? rawAgent.laneIds.map((laneId) => String(laneId || "").trim()).filter((laneId) => laneIds.has(laneId))
      : [],
    instructions: String(rawAgent.instructions || "").trim(),
    skillNotes: String(rawAgent.skillNotes || "").trim()
  };
}

function normalizeLaneAgentDefaults(lane, agentIds = new Set()) {
  return {
    ...lane,
    defaultOwnerAgentId: agentIds.has(lane.defaultOwnerAgentId) ? lane.defaultOwnerAgentId : null,
    defaultReviewerAgentId: agentIds.has(lane.defaultReviewerAgentId) ? lane.defaultReviewerAgentId : null
  };
}

function withUniqueAgentIds(agentSpecs) {
  const used = new Map();
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

function normalizeWorkItem(rawItem, lanes = []) {
  if (!rawItem || typeof rawItem !== "object") return null;
  const title = String(rawItem.title || "").trim();
  if (!title) return null;

  const laneIds = new Set(lanes.map((lane) => lane.id));
  const fallbackLaneId = lanes[0]?.id || "";
  const laneId = laneIds.has(rawItem.laneId) ? rawItem.laneId : fallbackLaneId;
  const now = new Date().toISOString();

  return {
    id: String(rawItem.id || makeId("item")),
    title,
    summary: String(rawItem.summary || "").trim(),
    laneId,
    ownerAgentId: nullableString(rawItem.ownerAgentId),
    reviewerAgentId: nullableString(rawItem.reviewerAgentId),
    blockers: Array.isArray(rawItem.blockers) ? rawItem.blockers : [],
    approvals: Array.isArray(rawItem.approvals) ? rawItem.approvals : [],
    completed: Boolean(rawItem.completed),
    delivered: Boolean(rawItem.delivered),
    comments: Array.isArray(rawItem.comments) ? rawItem.comments.map(normalizeComment).filter(Boolean) : [],
    createdAt: rawItem.createdAt || now,
    updatedAt: rawItem.updatedAt || now
  };
}

function createWorkItem(input, board) {
  return normalizeWorkItem({
    ...input,
    id: input.id || makeId("item"),
    laneId: input.laneId || board.lanes[0]?.id || "",
    comments: input.comments || []
  }, board.lanes);
}

function normalizeComment(rawComment) {
  if (!rawComment || typeof rawComment !== "object") return null;
  const text = String(rawComment.text || "").trim();
  if (!text) return null;

  const now = new Date().toISOString();
  const kind = COMMENT_KINDS.has(rawComment.kind) ? rawComment.kind : "note";
  const status = COMMENT_STATUSES.has(rawComment.status) ? rawComment.status : "open";

  return {
    id: String(rawComment.id || makeId("comment")),
    kind,
    status,
    text,
    author: String(rawComment.author || "agent").trim() || "agent",
    createdAt: rawComment.createdAt || now,
    updatedAt: rawComment.updatedAt || now
  };
}

function createComment(input) {
  return normalizeComment({
    ...input,
    id: input.id || makeId("comment")
  });
}

function withUniqueLaneIds(lanes) {
  const used = new Map();
  return lanes.map((lane) => {
    const baseId = slugify(lane.title) || "lane";
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    const id = nextCount === 1 ? baseId : `${baseId}-${nextCount}`;
    return {
      ...lane,
      id,
      defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
      defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
      gate: {
        title: lane.gate?.title || `${lane.title} gate`,
        checks: Array.isArray(lane.gate?.checks) ? [...lane.gate.checks] : defaultGateChecks(lane.title)
      }
    };
  });
}

function defaultGateChecks(title) {
  return [
    "Output is reviewable.",
    "Blockers and open questions are captured.",
    `${title} handoff is clear.`
  ];
}

function findBoard(state, boardId) {
  return state.boards.find((board) => board.id === boardId) || null;
}

function findWorkItem(board, itemId) {
  return board?.workItems.find((item) => item.id === itemId) || null;
}

function findComment(item, commentId) {
  return item?.comments.find((comment) => comment.id === commentId) || null;
}

function touchBoard(board) {
  board.updatedAt = new Date().toISOString();
}

function touchWorkItem(item) {
  item.updatedAt = new Date().toISOString();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

module.exports = {
  COMMENT_KINDS,
  COMMENT_STATUSES,
  createBoard,
  createComment,
  createFileStateStore,
  createPostgresStateStore,
  createStateStore,
  createWorkItem,
  findBoard,
  findComment,
  findWorkItem,
  freshWorkspaceState,
  normalizeWorkspace,
  touchBoard,
  touchWorkItem
};
