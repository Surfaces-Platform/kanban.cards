import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import { normalizePostgresConnectionString, resolvePostgresSsl } from "./postgres-config";
import type {
  Activity,
  Card,
  Column,
  Comment,
  IdempotencyRecord,
  JsonValue,
  Project,
  StateStore,
  StateStoreOptions,
  WorkspaceState,
  WorkspaceStoreResolver
} from "./types";

export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_TABLE_NAME = "kanban_v2_workspaces";
export const DEFAULT_DATA_PATH = path.join(process.cwd(), "data", "kanban-cards-v2-state.json");

interface PostgresStoreRuntime {
  pool: Pool;
  tableName: string;
  ensureReady(): Promise<void>;
}

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

  return createFileStateStore(options.dataPath || process.env.KANBAN_CARDS_DATA_PATH || DEFAULT_DATA_PATH);
}

export function createFileStateStore(dataPath: string): StateStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function readExisting(): Promise<WorkspaceState | null> {
    try {
      return normalizeWorkspace(JSON.parse(await fs.readFile(resolvedPath, "utf8")));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function read(): Promise<WorkspaceState> {
    const existing = await readExisting();
    if (existing) return existing;
    const state = freshWorkspaceState();
    await write(state);
    return state;
  }

  async function write(nextState: unknown): Promise<WorkspaceState> {
    const normalized = normalizeWorkspace(nextState);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const temporaryPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
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

  return { kind: "file", path: resolvedPath, readExisting, read, write, update };
}

export function createPostgresStateStore(options: StateStoreOptions = {}): StateStore {
  const tableName = validateTableName(options.tableName || DEFAULT_TABLE_NAME);
  const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
  const pool =
    options.pool ||
    new Pool({
      connectionString: normalizePostgresConnectionString(options.connectionString),
      ssl: resolvePostgresSsl(options)
    });
  return createPostgresStateStoreForWorkspace(workspaceId, createPostgresStoreRuntime(pool, tableName));
}

export function createWorkspaceStoreResolver(options: StateStoreOptions = {}): WorkspaceStoreResolver {
  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const stores = new Map<string, StateStore>();

  if (connectionString || options.pool) {
    const tableName = validateTableName(options.tableName || DEFAULT_TABLE_NAME);
    const pool =
      options.pool ||
      new Pool({
        connectionString: normalizePostgresConnectionString(connectionString),
        ssl: resolvePostgresSsl(options)
      });
    const runtime = createPostgresStoreRuntime(pool, tableName);
    return {
      kind: "postgres",
      resolve(storageId: string): StateStore {
        const normalizedStorageId = validateStorageId(storageId);
        let store = stores.get(normalizedStorageId);
        if (!store) {
          store = createPostgresStateStoreForWorkspace(normalizedStorageId, runtime);
          stores.set(normalizedStorageId, store);
        }
        return store;
      }
    };
  }

  const legacyPath = path.resolve(options.dataPath || process.env.KANBAN_CARDS_DATA_PATH || DEFAULT_DATA_PATH);
  const workspaceDirectory = path.resolve(options.workspaceDirectory || path.join(path.dirname(legacyPath), "workspaces"));
  return {
    kind: "file",
    resolve(storageId: string): StateStore {
      const normalizedStorageId = validateStorageId(storageId);
      let store = stores.get(normalizedStorageId);
      if (!store) {
        const dataPath = normalizedStorageId === DEFAULT_WORKSPACE_ID
          ? legacyPath
          : path.join(workspaceDirectory, `${storageFileKey(normalizedStorageId)}.json`);
        store = createFileStateStore(dataPath);
        stores.set(normalizedStorageId, store);
      }
      return store;
    }
  };
}

function createPostgresStoreRuntime(pool: Pool, tableName: string): PostgresStoreRuntime {
  let readyPromise: Promise<void> | null = null;

  function ensureReady(): Promise<void> {
    if (!readyPromise) {
      readyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id text PRIMARY KEY,
          state jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `).then(() => undefined).catch((error: unknown) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  return { pool, tableName, ensureReady };
}

function createPostgresStateStoreForWorkspace(workspaceId: string, runtime: PostgresStoreRuntime): StateStore {
  const { pool, tableName, ensureReady } = runtime;

  async function readExisting(): Promise<WorkspaceState | null> {
    const result = await pool.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1`, [workspaceId]);
    return result.rows.length ? normalizeWorkspace(result.rows[0].state) : null;
  }

  async function read(): Promise<WorkspaceState> {
    await ensureReady();
    await pool.query(
      `INSERT INTO ${tableName} (id, state, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, JSON.stringify(freshWorkspaceState())]
    );
    const result = await pool.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1`, [workspaceId]);
    if (!result.rows.length) throw new Error(`Workspace ${workspaceId} was not initialized.`);
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
    await ensureReady();
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
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
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { kind: "postgres", path: `${tableName}:${workspaceId}`, readExisting, read, write, update };
}

export function freshWorkspaceState(): WorkspaceState {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    projects: [],
    idempotencyRecords: []
  };
}

/**
 * V2 deliberately has no V1 adapter. Pointing this store at a legacy state file
 * fails explicitly instead of silently importing teams, boards, or agent data.
 */
export function normalizeWorkspace(rawState: unknown): WorkspaceState {
  const state = requireRecord(rawState, "Workspace state");
  if (state.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported workspace schema. Expected version ${WORKSPACE_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(state.projects) || !Array.isArray(state.idempotencyRecords)) {
    throw new Error("Workspace state must contain projects and idempotencyRecords arrays.");
  }

  const projects = state.projects.map(normalizeProject);
  assertUnique(projects.map((project) => project.id), "project id");
  const idempotencyRecords = state.idempotencyRecords.map(normalizeIdempotencyRecord);
  assertUnique(idempotencyRecords.map((record) => `${record.method}:${record.path}:${record.key}`), "idempotency key");
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, projects, idempotencyRecords };
}

function normalizeProject(value: unknown): Project {
  const project = requireRecord(value, "Project");
  const id = requiredString(project.id, "Project id");
  const name = requiredString(project.name, "Project name");
  const columns = requireArray(project.columns, "Project columns").map(normalizeColumn).sort(byPosition);
  const cards = requireArray(project.cards, "Project cards").map(normalizeCard).sort(byPosition);
  const activity = requireArray(project.activity, "Project activity").map(normalizeActivity);
  assertUnique(columns.map((column) => column.id), `column id in project ${id}`);
  assertUnique(cards.map((card) => card.id), `card id in project ${id}`);
  assertUnique(
    cards.map((card) => card.externalKey).filter((key): key is string => Boolean(key)),
    `card externalKey in project ${id}`
  );
  assertUnique(activity.map((entry) => entry.id), `activity id in project ${id}`);
  const columnIds = new Set(columns.map((column) => column.id));
  for (const card of cards) {
    if (!columnIds.has(card.columnId)) throw new Error(`Card ${card.id} refers to missing column ${card.columnId}.`);
  }
  return {
    id,
    name,
    description: stringValue(project.description),
    columns,
    cards,
    activity,
    revision: positiveInteger(project.revision, "Project revision"),
    archivedAt: nullableTimestamp(project.archivedAt, "Project archivedAt"),
    createdAt: timestamp(project.createdAt, "Project createdAt"),
    updatedAt: timestamp(project.updatedAt, "Project updatedAt")
  };
}

function normalizeColumn(value: unknown): Column {
  const column = requireRecord(value, "Column");
  return {
    id: requiredString(column.id, "Column id"),
    name: requiredString(column.name, "Column name"),
    position: nonNegativeInteger(column.position, "Column position")
  };
}

function normalizeCard(value: unknown): Card {
  const card = requireRecord(value, "Card");
  const externalKey = optionalString(card.externalKey);
  return {
    id: requiredString(card.id, "Card id"),
    ...(externalKey ? { externalKey } : {}),
    title: requiredString(card.title, "Card title"),
    body: stringValue(card.body),
    columnId: requiredString(card.columnId, "Card columnId"),
    position: nonNegativeInteger(card.position, "Card position"),
    version: positiveInteger(card.version, "Card version"),
    archivedAt: nullableTimestamp(card.archivedAt, "Card archivedAt"),
    createdAt: timestamp(card.createdAt, "Card createdAt"),
    updatedAt: timestamp(card.updatedAt, "Card updatedAt"),
    comments: requireArray(card.comments, "Card comments").map(normalizeComment)
  };
}

function normalizeComment(value: unknown): Comment {
  const comment = requireRecord(value, "Comment");
  return {
    id: requiredString(comment.id, "Comment id"),
    body: requiredString(comment.body, "Comment body"),
    author: requiredString(comment.author, "Comment author"),
    createdAt: timestamp(comment.createdAt, "Comment createdAt")
  };
}

function normalizeActivity(value: unknown): Activity {
  const activity = requireRecord(value, "Activity");
  const actor = requireRecord(activity.actor, "Activity actor");
  const channel = actor.channel;
  if (channel !== "web" && channel !== "api") throw new Error("Activity actor channel must be web or api.");
  const cardId = optionalString(activity.cardId);
  const agentConnectionId = optionalString(actor.agentConnectionId);
  return {
    id: requiredString(activity.id, "Activity id"),
    action: requiredString(activity.action, "Activity action"),
    actor: {
      channel,
      label: requiredString(actor.label, "Activity actor label"),
      ...(agentConnectionId ? { agentConnectionId } : {})
    },
    summary: requiredString(activity.summary, "Activity summary"),
    projectId: requiredString(activity.projectId, "Activity projectId"),
    ...(cardId ? { cardId } : {}),
    createdAt: timestamp(activity.createdAt, "Activity createdAt")
  };
}

function normalizeIdempotencyRecord(value: unknown): IdempotencyRecord {
  const record = requireRecord(value, "Idempotency record");
  if (record.method !== "POST") throw new Error("Idempotency record method must be POST.");
  if (!isJsonValue(record.response)) throw new Error("Idempotency response must be JSON serializable.");
  return {
    key: requiredString(record.key, "Idempotency key"),
    method: "POST",
    path: requiredString(record.path, "Idempotency path"),
    requestHash: requiredString(record.requestHash, "Idempotency requestHash"),
    statusCode: positiveInteger(record.statusCode, "Idempotency statusCode"),
    response: record.response,
    createdAt: timestamp(record.createdAt, "Idempotency createdAt")
  };
}

function validateTableName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid PostgreSQL table name.");
  return value;
}

function validateStorageId(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || /[\r\n\0]/.test(normalized)) {
    throw new Error("Workspace storage id is invalid.");
  }
  return normalized;
}

function storageFileKey(storageId: string): string {
  return `workspace-${crypto.createHash("sha256").update(storageId).digest("hex")}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative integer.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp.`);
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value == null) return null;
  return timestamp(value, label);
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function byPosition<T extends { position: number }>(left: T, right: T): number {
  return left.position - right.position;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
