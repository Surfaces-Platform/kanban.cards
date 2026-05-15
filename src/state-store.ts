import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import type {
  AgentSpec,
  Board,
  BoardDraft,
  BoardTemplate,
  CommentKind,
  CommentStatus,
  Lane,
  PostgresClient,
  PostgresOptions,
  StateStore,
  StateStoreOptions,
  WorkItem,
  WorkItemComment,
  WorkspaceState
} from "./types";

export const COMMENT_KINDS = new Set<CommentKind>(["progress", "instruction", "question", "change_request", "note"]);
export const COMMENT_STATUSES = new Set<CommentStatus>(["open", "acknowledged", "resolved"]);

const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_TABLE_NAME = "kanban_workspaces";
type UnknownRecord = Record<string, any>;

export function createStateStore(options: StateStoreOptions | string = {}): StateStore {
  if (typeof options === "string") return createFileStateStore(options);

  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
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

export function createFileStateStore(dataPath: string): StateStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<WorkspaceState> {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      return normalizeWorkspace(JSON.parse(raw));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const state = freshWorkspaceState();
      await write(state);
      return state;
    }
  }

  async function write(nextState: unknown): Promise<WorkspaceState> {
    const normalized = normalizeWorkspace(nextState);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, resolvedPath);
    return normalized;
  }

  async function update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }> {
    const nextWrite = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const state = await read();
        const result = mutator(state);
        const saved = await write(state);
        return { state: saved, result };
      });
    writeQueue = nextWrite;
    return nextWrite;
  }

  return { kind: "file", path: resolvedPath, read, write, update };
}

export function createPostgresStateStore(options: StateStoreOptions = {}): StateStore {
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
  const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
  const pool =
    options.pool ||
    new Pool({
      connectionString: options.connectionString,
      ssl: resolvePostgresSsl(options)
    });
  let readyPromise: Promise<unknown> | null = null;

  async function ensureReady(client: PostgresClient = pool): Promise<void> {
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

  async function read(): Promise<WorkspaceState> {
    await ensureReady();
    const result = await pool.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1`, [workspaceId]);
    if (!result.rows.length) return write(freshWorkspaceState());
    return normalizeWorkspace(result.rows[0].state);
  }

  async function write(nextState: unknown): Promise<WorkspaceState> {
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

  async function update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }> {
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
      const result = await client.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1 FOR UPDATE`, [workspaceId]);
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

function resolvePostgresSsl(options: Pick<PostgresOptions, "ssl"> = {}): PostgresOptions["ssl"] | undefined {
  if (options.ssl !== undefined) return options.ssl;
  if (process.env.KANBAN_CARDS_POSTGRES_SSL === "disable") return false;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return { rejectUnauthorized: false };
  return undefined;
}

export function freshWorkspaceState(): WorkspaceState {
  const board = createBoard({ name: "Untitled board" });
  return {
    boards: [board],
    activeBoardId: board.id,
    templates: []
  };
}

export function createBoard(input: Partial<Board> = {}): Board {
  const now = new Date().toISOString();
  const board = normalizeBoard({
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
  if (!board) throw new Error("Unable to create board.");
  return board;
}

export function normalizeWorkspace(rawState: unknown): WorkspaceState {
  const state = isRecord(rawState) ? rawState : {};
  const boards = Array.isArray(state.boards) ? state.boards.map(normalizeBoard).filter(isNonNull) : [];

  if (!boards.length) boards.push(createBoard({ name: "Untitled board" }));

  const activeBoardId = boards.some((board) => board.id === state.activeBoardId) ? String(state.activeBoardId) : boards[0].id;
  const templates = Array.isArray(state.templates) ? state.templates.map(normalizeTemplate).filter(isNonNull) : [];

  return { boards, activeBoardId, templates };
}

function normalizeBoard(rawBoard: unknown): Board | null {
  if (!isRecord(rawBoard)) return null;

  const lanes = Array.isArray(rawBoard.lanes) ? withUniqueLaneIds(rawBoard.lanes.map(normalizeLane).filter(isNonNull)) : [];
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawBoard.agentSpecs)
    ? withUniqueAgentIds(rawBoard.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  const normalizedLanes = lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds));
  const workItems = Array.isArray(rawBoard.workItems)
    ? rawBoard.workItems.map((item) => normalizeWorkItem(item, normalizedLanes)).filter(isNonNull)
    : [];
  const selectedId = workItems.some((item) => item.id === rawBoard.selectedId) ? String(rawBoard.selectedId) : null;
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
    createdAt: String(rawBoard.createdAt || now),
    updatedAt: String(rawBoard.updatedAt || now)
  };
}

function normalizeTemplate(rawTemplate: unknown): BoardTemplate | null {
  if (!isRecord(rawTemplate)) return null;

  const lanes = Array.isArray(rawTemplate.lanes) ? withUniqueLaneIds(rawTemplate.lanes.map(normalizeLane).filter(isNonNull)) : [];
  const name = String(rawTemplate.name || "").trim();
  if (!name || !lanes.length) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(rawTemplate.agentSpecs)
    ? withUniqueAgentIds(rawTemplate.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));

  return {
    id: String(rawTemplate.id || makeId("template")),
    name,
    description: String(rawTemplate.description || "").trim(),
    builtIn: false,
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds)),
    agentSpecs,
    createdAt: String(rawTemplate.createdAt || new Date().toISOString())
  };
}

function normalizeDraft(draft: unknown): BoardDraft | null {
  if (!isRecord(draft) || !Array.isArray(draft.lanes)) return null;
  const lanes = withUniqueLaneIds(draft.lanes.map(normalizeLane).filter(isNonNull));
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const agentSpecs = Array.isArray(draft.agentSpecs)
    ? withUniqueAgentIds(draft.agentSpecs.map((agent) => normalizeAgentSpec(agent, laneIds)).filter(isNonNull))
    : [];
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  return {
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds)),
    agentSpecs
  };
}

function normalizeLane(lane: unknown): Lane | null {
  if (!isRecord(lane)) return null;
  const title = String(lane.title || "").trim();
  if (!title) return null;

  const gate = isRecord(lane.gate) ? lane.gate : {};
  const checks = Array.isArray(gate.checks)
    ? gate.checks.map((check: unknown) => String(check || "").trim()).filter(Boolean)
    : defaultGateChecks(title);

  return {
    id: String(lane.id || slugify(title)).trim() || slugify(title),
    title,
    description: String(lane.description || "").trim(),
    defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
    defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
    gate: {
      title: String(gate.title || `${title} gate`).trim(),
      checks: checks.length ? checks : defaultGateChecks(title)
    }
  };
}

function normalizeAgentSpec(rawAgent: unknown, laneIds: Set<string> = new Set()): AgentSpec | null {
  if (!isRecord(rawAgent)) return null;
  const name = String(rawAgent.name || "").trim();
  const id = String(rawAgent.id || slugify(name)).trim() || slugify(name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: String(rawAgent.role || "").trim(),
    laneIds: Array.isArray(rawAgent.laneIds)
      ? rawAgent.laneIds.map((laneId: unknown) => String(laneId || "").trim()).filter((laneId: string) => laneIds.has(laneId))
      : [],
    instructions: String(rawAgent.instructions || "").trim(),
    skillNotes: String(rawAgent.skillNotes || "").trim()
  };
}

function normalizeLaneAgentDefaults(lane: Lane, agentIds: Set<string> = new Set()): Lane {
  return {
    ...lane,
    defaultOwnerAgentId: agentIds.has(String(lane.defaultOwnerAgentId)) ? lane.defaultOwnerAgentId : null,
    defaultReviewerAgentId: agentIds.has(String(lane.defaultReviewerAgentId)) ? lane.defaultReviewerAgentId : null
  };
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

function normalizeWorkItem(rawItem: unknown, lanes: Lane[] = []): WorkItem | null {
  if (!isRecord(rawItem)) return null;
  const title = String(rawItem.title || "").trim();
  if (!title) return null;

  const laneIds = new Set(lanes.map((lane) => lane.id));
  const fallbackLaneId = lanes[0]?.id || "";
  const laneId = laneIds.has(String(rawItem.laneId)) ? String(rawItem.laneId) : fallbackLaneId;
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
    comments: Array.isArray(rawItem.comments) ? rawItem.comments.map(normalizeComment).filter(isNonNull) : [],
    createdAt: String(rawItem.createdAt || now),
    updatedAt: String(rawItem.updatedAt || now)
  };
}

export function createWorkItem(input: UnknownRecord, board: Board): WorkItem | null {
  return normalizeWorkItem(
    {
      ...input,
      id: input.id || makeId("item"),
      laneId: input.laneId || board.lanes[0]?.id || "",
      comments: input.comments || []
    },
    board.lanes
  );
}

function normalizeComment(rawComment: unknown): WorkItemComment | null {
  if (!isRecord(rawComment)) return null;
  const text = String(rawComment.text || "").trim();
  if (!text) return null;

  const now = new Date().toISOString();
  const kind = COMMENT_KINDS.has(rawComment.kind as CommentKind) ? (rawComment.kind as CommentKind) : "note";
  const status = COMMENT_STATUSES.has(rawComment.status as CommentStatus) ? (rawComment.status as CommentStatus) : "open";

  return {
    id: String(rawComment.id || makeId("comment")),
    kind,
    status,
    text,
    author: String(rawComment.author || "agent").trim() || "agent",
    createdAt: String(rawComment.createdAt || now),
    updatedAt: String(rawComment.updatedAt || now)
  };
}

export function createComment(input: UnknownRecord): WorkItemComment | null {
  return normalizeComment({
    ...input,
    id: input.id || makeId("comment")
  });
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
      defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
      defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
      gate: {
        title: lane.gate?.title || `${lane.title} gate`,
        checks: Array.isArray(lane.gate?.checks) ? [...lane.gate.checks] : defaultGateChecks(lane.title)
      }
    };
  });
}

function defaultGateChecks(title: string): string[] {
  return ["Output is reviewable.", "Blockers and open questions are captured.", `${title} handoff is clear.`];
}

export function findBoard(state: WorkspaceState, boardId: string | null | undefined): Board | null {
  return state.boards.find((board) => board.id === boardId) || null;
}

export function findWorkItem(board: Board | null | undefined, itemId: string | null | undefined): WorkItem | null {
  return board?.workItems.find((item) => item.id === itemId) || null;
}

export function findComment(item: WorkItem | null | undefined, commentId: string | null | undefined): WorkItemComment | null {
  return item?.comments.find((comment) => comment.id === commentId) || null;
}

export function touchBoard(board: Board): void {
  board.updatedAt = new Date().toISOString();
}

export function touchWorkItem(item: WorkItem): void {
  item.updatedAt = new Date().toISOString();
}

function slugify(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
