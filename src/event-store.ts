import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import type {
  EventStore,
  EventStoreOptions,
  PostgresClient,
  PostgresOptions,
  WorkspaceEvent,
  WorkspaceEventCreateInput,
  WorkspaceEventListRecentOptions,
  WorkspaceEventPayload,
  WorkspaceEventType
} from "./types";

const DEFAULT_TABLE_NAME = "kanban_events";
const DEFAULT_EVENT_FILE = path.join(__dirname, "data", "kanban-events.jsonl");
const DEFAULT_LIST_LIMIT = 200;
type UnknownRecord = Record<string, any>;

export function createEventStore(options: EventStoreOptions | string = {}): EventStore {
  if (typeof options === "string") return createFileEventStore(options);

  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString || options.pool) {
    return createPostgresEventStore({
      connectionString,
      tableName: options.tableName,
      pool: options.pool,
      ssl: options.ssl
    });
  }

  return createFileEventStore(options.dataPath || DEFAULT_EVENT_FILE);
}

export function createFileEventStore(dataPath: string = DEFAULT_EVENT_FILE): EventStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    try {
      await fs.access(resolvedPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await fs.writeFile(resolvedPath, "");
    }
  }

  async function readEvents(): Promise<WorkspaceEvent[]> {
    await ensureReady();
    const raw = await fs.readFile(resolvedPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeEvent(JSON.parse(line));
        } catch (_error) {
          return null;
        }
      })
      .filter(isNonNull);
  }

  async function append(input: WorkspaceEventCreateInput): Promise<WorkspaceEvent> {
    const nextWrite = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const events = await readEvents();
        const latestEvent = events.length ? events[events.length - 1] : null;
        const nextId = nextNumericId(latestEvent?.id || null);
        const event = normalizeEvent({
          id: String(nextId),
          type: input.type,
          boardId: input.boardId || null,
          payload: input.payload || {},
          createdAt: new Date().toISOString()
        });
        if (!event) throw new Error("Unable to create event record.");
        await fs.appendFile(resolvedPath, `${JSON.stringify(event)}\n`);
        return event;
      });
    writeQueue = nextWrite;
    return nextWrite;
  }

  async function listSince(sinceId: string | null, limit = DEFAULT_LIST_LIMIT): Promise<WorkspaceEvent[]> {
    const since = parseEventId(sinceId);
    const events = await readEvents();
    return events
      .filter((event) => parseEventId(event.id) > since)
      .sort(compareEvents)
      .slice(0, normalizeLimit(limit));
  }

  async function listRecent(options: WorkspaceEventListRecentOptions = {}): Promise<WorkspaceEvent[]> {
    const events = await readEvents();
    return events
      .filter((event) => matchesRecentOptions(event, options))
      .sort((left, right) => compareEvents(right, left))
      .slice(0, normalizeLimit(options.limit));
  }

  async function latestId(): Promise<string | null> {
    const events = await readEvents();
    return events.length ? events[events.length - 1].id : null;
  }

  return { kind: "file", path: resolvedPath, ensureReady, append, listSince, listRecent, latestId };
}

export function createPostgresEventStore(options: EventStoreOptions = {}): EventStore {
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
  const pool =
    options.pool ||
    new Pool({
      connectionString: options.connectionString,
      ssl: resolvePostgresSsl(options)
    });
  let readyPromise: Promise<unknown> | null = null;

  async function ensureReady(client: PostgresClient = pool): Promise<void> {
    if (!readyPromise || client !== pool) {
      const ready = client
        .query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id bigserial PRIMARY KEY,
          type text NOT NULL,
          board_id text,
          payload jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_board_id_idx ON ${tableName} (board_id)`))
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_created_at_idx ON ${tableName} (created_at)`));
      if (client === pool) readyPromise = ready;
      await ready;
      return;
    }

    await readyPromise;
  }

  async function append(input: WorkspaceEventCreateInput): Promise<WorkspaceEvent> {
    await ensureReady();
    const result = await pool.query(
      `INSERT INTO ${tableName} (type, board_id, payload, created_at)
       VALUES ($1, $2, $3::jsonb, now())
       RETURNING id::text, type, board_id, payload, created_at`,
      [input.type, input.boardId || null, JSON.stringify(input.payload || {})]
    );
    const event = normalizeEvent(result.rows[0]);
    if (!event) throw new Error("Unable to create event record.");
    return event;
  }

  async function listSince(sinceId: string | null, limit = DEFAULT_LIST_LIMIT): Promise<WorkspaceEvent[]> {
    await ensureReady();
    const result = await pool.query(
      `SELECT id::text, type, board_id, payload, created_at
       FROM ${tableName}
       WHERE id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [parseEventId(sinceId).toString(), normalizeLimit(limit)]
    );
    return result.rows.map(normalizeEvent).filter(isNonNull);
  }

  async function listRecent(options: WorkspaceEventListRecentOptions = {}): Promise<WorkspaceEvent[]> {
    await ensureReady();
    const where: string[] = [];
    const args: unknown[] = [];
    const boardId = nullableString(options.boardId);
    const cardId = nullableString(options.cardId);

    if (boardId) {
      args.push(boardId);
      where.push(`board_id = $${args.length}`);
    }
    if (cardId) {
      args.push(cardId);
      const parameter = `$${args.length}`;
      where.push(`(
        payload->'resource'->>'cardId' = ${parameter}
        OR (payload->'resource'->>'type' = 'card' AND payload->'resource'->>'id' = ${parameter})
        OR payload->>'cardId' = ${parameter}
      )`);
    }

    args.push(normalizeLimit(options.limit));
    const result = await pool.query(
      `SELECT id::text, type, board_id, payload, created_at
       FROM ${tableName}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT $${args.length}`,
      args
    );
    return result.rows.map(normalizeEvent).filter(isNonNull);
  }

  async function latestId(): Promise<string | null> {
    await ensureReady();
    const result = await pool.query<{ id: string | null }>(`SELECT max(id)::text AS id FROM ${tableName}`);
    return result.rows[0]?.id || null;
  }

  return { kind: "postgres", path: tableName, ensureReady, append, listSince, listRecent, latestId };
}

function normalizeEvent(record: unknown): WorkspaceEvent | null {
  if (!isRecord(record)) return null;
  const id = String(record.id || "").trim();
  const type = String(record.type || "").trim();
  if (!id || !isWorkspaceEventType(type)) return null;

  return {
    id,
    type,
    boardId: nullableString(record.boardId || record.board_id),
    payload: normalizePayload(record.payload),
    createdAt: dateToIso(record.createdAt || record.created_at) || new Date().toISOString()
  };
}

function isWorkspaceEventType(value: string): value is WorkspaceEventType {
  return value === "workspace_changed";
}

function normalizePayload(value: unknown): WorkspaceEventPayload {
  return isRecord(value) ? value : {};
}

function matchesRecentOptions(event: WorkspaceEvent, options: WorkspaceEventListRecentOptions): boolean {
  const boardId = nullableString(options.boardId);
  if (boardId && event.boardId !== boardId) return false;

  const cardId = nullableString(options.cardId);
  if (cardId && eventCardId(event) !== cardId) return false;

  return true;
}

function eventCardId(event: WorkspaceEvent): string | null {
  const resource: UnknownRecord = isRecord(event.payload.resource) ? event.payload.resource : {};
  const directCardId = nullableString(resource.cardId || event.payload.cardId);
  if (directCardId) return directCardId;

  if (String(resource.type || "") === "card") return nullableString(resource.id);
  return null;
}

function nextNumericId(previousId: string | null): bigint {
  return parseEventId(previousId) + 1n;
}

function parseEventId(value: unknown): bigint {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return 0n;
  return BigInt(text);
}

function compareEvents(left: WorkspaceEvent, right: WorkspaceEvent): number {
  const leftId = parseEventId(left.id);
  const rightId = parseEventId(right.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function normalizeLimit(limit: unknown): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(Math.trunc(Number(limit)), 1000));
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function dateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolvePostgresSsl(options: Pick<PostgresOptions, "ssl"> = {}): PostgresOptions["ssl"] | undefined {
  if (options.ssl !== undefined) return options.ssl;
  if (process.env.KANBAN_CARDS_POSTGRES_SSL === "disable") return false;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return { rejectUnauthorized: false };
  return undefined;
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
