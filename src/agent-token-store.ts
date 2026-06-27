import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import { normalizePostgresConnectionString, resolvePostgresSsl } from "./postgres-config";
import type {
  AgentCapability,
  AgentTokenCreateInput,
  AgentTokenStore,
  AgentTokenStoreOptions,
  AgentTokenUpdateInput,
  CreatedAgentToken,
  PostgresClient,
  PostgresOptions,
  PublicTokenRecord,
  TokenRecord
} from "./types";

const DEFAULT_TABLE_NAME = "agent_access_tokens";
const DEFAULT_TOKEN_FILE = path.join(__dirname, "data", "agent-access-tokens.json");
const DEFAULT_AGENT_CAPABILITIES: AgentCapability[] = ["view", "create", "update", "comment", "move"];
const AGENT_CAPABILITY_SET = new Set<string>(DEFAULT_AGENT_CAPABILITIES);
type UnknownRecord = Record<string, any>;

export function createAgentTokenStore(options: AgentTokenStoreOptions = {}): AgentTokenStore {
  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString || options.pool) {
    return createPostgresAgentTokenStore({
      connectionString,
      tableName: options.tableName,
      pool: options.pool,
      ssl: options.ssl
    });
  }

  return createFileAgentTokenStore(options.dataPath || DEFAULT_TOKEN_FILE);
}

export function createFileAgentTokenStore(dataPath: string = DEFAULT_TOKEN_FILE): AgentTokenStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    try {
      await fs.access(resolvedPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await writeTokens([]);
    }
  }

  async function readTokens(): Promise<TokenRecord[]> {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.tokens) ? parsed.tokens.map(normalizeTokenRecord).filter(isNonNull) : [];
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      return [];
    }
  }

  async function writeTokens(tokens: TokenRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, resolvedPath);
    await fs.chmod(resolvedPath, 0o600).catch(() => undefined);
  }

  async function updateTokens<T>(mutator: (tokens: TokenRecord[]) => T): Promise<T> {
    const nextWrite = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const tokens = await readTokens();
        const result = mutator(tokens);
        await writeTokens(tokens);
        return result;
      });
    writeQueue = nextWrite;
    return nextWrite;
  }

  async function list(boardId: string): Promise<PublicTokenRecord[]> {
    await ensureReady();
    return (await readTokens())
      .filter((token) => token.boardId === boardId && !token.revokedAt)
      .map(toPublicTokenRecord)
      .filter(isNonNull);
  }

  async function create(input: AgentTokenCreateInput): Promise<CreatedAgentToken> {
    const rawToken = generateAgentToken();
    const now = new Date().toISOString();
    const record = normalizeTokenRecord({
      id: input.id || `agtok_${crypto.randomUUID()}`,
      boardId: input.boardId,
      agentId: input.agentId,
      label: input.label || "Local agent",
      tokenHash: hashAgentToken(rawToken),
      last4: rawToken.slice(-4),
      teamId: input.teamId || null,
      projectId: input.projectId || null,
      sessionId: input.sessionId || `agsess_${crypto.randomUUID()}`,
      delegatedBy: input.delegatedBy || null,
      capabilities: normalizeCapabilityInput(input.capabilities, true),
      expiresAt: input.expiresAt || null,
      reason: input.reason || "Board-scoped agent access.",
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    });
    if (!record) throw new Error("Unable to create agent token record.");

    await updateTokens((tokens) => {
      tokens.push(record);
    });

    const tokenRecord = toPublicTokenRecord(record);
    if (!tokenRecord) throw new Error("Unable to create public agent token record.");
    return { token: rawToken, tokenRecord };
  }

  async function update(boardId: string, sessionId: string, input: AgentTokenUpdateInput): Promise<PublicTokenRecord | null> {
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.boardId === boardId && candidate.sessionId === sessionId && !candidate.revokedAt);
      if (!record) return null;
      applyTokenUpdate(record, input);
      return toPublicTokenRecord(record);
    });
  }

  async function verify(rawToken: string): Promise<PublicTokenRecord | null> {
    const tokenHash = hashAgentToken(rawToken);
    const now = new Date().toISOString();
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.tokenHash === tokenHash && !candidate.revokedAt && !isExpired(candidate.expiresAt));
      if (!record) return null;
      record.lastUsedAt = now;
      return toPublicTokenRecord(record);
    });
  }

  async function revoke(boardId: string, tokenId: string): Promise<PublicTokenRecord | null> {
    const now = new Date().toISOString();
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.id === tokenId && candidate.boardId === boardId);
      if (!record) return null;
      if (!record.revokedAt) record.revokedAt = now;
      return toPublicTokenRecord(record);
    });
  }

  async function revokeSession(boardId: string, sessionId: string): Promise<PublicTokenRecord | null> {
    const now = new Date().toISOString();
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.sessionId === sessionId && candidate.boardId === boardId);
      if (!record) return null;
      if (!record.revokedAt) record.revokedAt = now;
      return toPublicTokenRecord(record);
    });
  }

  return { kind: "file", path: resolvedPath, ensureReady, list, create, update, verify, revoke, revokeSession };
}

export function createPostgresAgentTokenStore(options: AgentTokenStoreOptions = {}): AgentTokenStore {
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
  const pool =
    options.pool ||
    new Pool({
      connectionString: normalizePostgresConnectionString(options.connectionString),
      ssl: resolvePostgresSsl(options)
    });
  let readyPromise: Promise<unknown> | null = null;

  async function ensureReady(client: PostgresClient = pool): Promise<void> {
    if (!readyPromise || client !== pool) {
      const ready = client
        .query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id text PRIMARY KEY,
          board_id text NOT NULL,
          agent_id text NOT NULL,
          label text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          last4 text NOT NULL,
          team_id text,
          project_id text,
          session_id text,
          delegated_by text,
          capabilities jsonb NOT NULL DEFAULT '["view","create","update","comment","move"]'::jsonb,
          expires_at timestamptz,
          reason text NOT NULL DEFAULT 'Board-scoped agent access.',
          created_at timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz,
          revoked_at timestamptz
        )
      `)
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS team_id text`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS project_id text`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS session_id text`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS delegated_by text`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '["view","create","update","comment","move"]'::jsonb`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS expires_at timestamptz`))
        .then(() => client.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'Board-scoped agent access.'`))
        .then(() => client.query(`UPDATE ${tableName} SET session_id = 'legacy:' || id WHERE session_id IS NULL`))
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_board_id_idx ON ${tableName} (board_id)`))
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_token_hash_idx ON ${tableName} (token_hash)`))
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_session_id_idx ON ${tableName} (session_id)`));
      if (client === pool) readyPromise = ready;
      await ready;
      return;
    }

    await readyPromise;
  }

  async function list(boardId: string): Promise<PublicTokenRecord[]> {
    await ensureReady();
    const result = await pool.query(
      `SELECT id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at
       FROM ${tableName}
       WHERE board_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [boardId]
    );
    return result.rows.map(toPublicTokenRecord).filter(isNonNull);
  }

  async function create(input: AgentTokenCreateInput): Promise<CreatedAgentToken> {
    await ensureReady();
    const rawToken = generateAgentToken();
    const id = input.id || `agtok_${crypto.randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO ${tableName} (id, board_id, agent_id, label, token_hash, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, now())
       RETURNING id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at`,
      [
        id,
        input.boardId,
        input.agentId,
        sanitizeLabel(input.label),
        hashAgentToken(rawToken),
        rawToken.slice(-4),
        nullableString(input.teamId),
        nullableString(input.projectId),
        sanitizeSessionId(input.sessionId) || `agsess_${crypto.randomUUID()}`,
        nullableString(input.delegatedBy),
        JSON.stringify(normalizeCapabilityInput(input.capabilities, true)),
        nullableDate(input.expiresAt),
        sanitizeReason(input.reason)
      ]
    );
    const tokenRecord = toPublicTokenRecord(result.rows[0]);
    if (!tokenRecord) throw new Error("Unable to create public agent token record.");
    return { token: rawToken, tokenRecord };
  }

  async function update(boardId: string, sessionId: string, input: AgentTokenUpdateInput): Promise<PublicTokenRecord | null> {
    await ensureReady();
    const hasLabel = hasOwn(input, "label");
    const hasCapabilities = hasOwn(input, "capabilities");
    const hasExpiresAt = hasOwn(input, "expiresAt");
    const hasReason = hasOwn(input, "reason");
    const result = await pool.query(
      `UPDATE ${tableName}
       SET label = CASE WHEN $3 THEN $4 ELSE label END,
           capabilities = CASE WHEN $5 THEN $6::jsonb ELSE capabilities END,
           expires_at = CASE WHEN $7 THEN $8::timestamptz ELSE expires_at END,
           reason = CASE WHEN $9 THEN $10 ELSE reason END
       WHERE board_id = $1 AND session_id = $2 AND revoked_at IS NULL
       RETURNING id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at`,
      [
        boardId,
        sessionId,
        hasLabel,
        sanitizeLabel(input.label),
        hasCapabilities,
        hasCapabilities ? JSON.stringify(normalizeCapabilityInput(input.capabilities, false)) : null,
        hasExpiresAt,
        nullableDate(input.expiresAt),
        hasReason,
        sanitizeReason(input.reason)
      ]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  async function verify(rawToken: string): Promise<PublicTokenRecord | null> {
    await ensureReady();
    const result = await pool.query(
      `UPDATE ${tableName}
       SET last_used_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at`,
      [hashAgentToken(rawToken)]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  async function revoke(boardId: string, tokenId: string): Promise<PublicTokenRecord | null> {
    await ensureReady();
    const result = await pool.query(
      `UPDATE ${tableName}
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE board_id = $1 AND id = $2
       RETURNING id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at`,
      [boardId, tokenId]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  async function revokeSession(boardId: string, sessionId: string): Promise<PublicTokenRecord | null> {
    await ensureReady();
    const result = await pool.query(
      `UPDATE ${tableName}
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE board_id = $1 AND session_id = $2
       RETURNING id, board_id, agent_id, label, last4, team_id, project_id, session_id, delegated_by, capabilities, expires_at, reason, created_at, last_used_at, revoked_at`,
      [boardId, sessionId]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  return { kind: "postgres", path: tableName, ensureReady, list, create, update, verify, revoke, revokeSession };
}

export function generateAgentToken(): string {
  return `kcagt_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashAgentToken(rawToken: string): string {
  return `sha256:${crypto.createHash("sha256").update(String(rawToken)).digest("hex")}`;
}

function normalizeTokenRecord(record: unknown): TokenRecord | null {
  if (!isRecord(record)) return null;
  const id = String(record.id || "").trim();
  const boardId = String(record.boardId || record.board_id || "").trim();
  const agentId = String(record.agentId || record.agent_id || "").trim();
  const tokenHash = String(record.tokenHash || record.token_hash || "").trim();
  const last4 = String(record.last4 || "").trim();
  if (!id || !boardId || !agentId || !tokenHash || !last4) return null;
  const sessionId = sanitizeSessionId(record.sessionId || record.session_id) || `legacy:${id}`;

  return {
    id,
    boardId,
    agentId,
    label: sanitizeLabel(record.label),
    tokenHash,
    last4,
    teamId: nullableString(record.teamId || record.team_id),
    projectId: nullableString(record.projectId || record.project_id),
    sessionId,
    delegatedBy: nullableString(record.delegatedBy || record.delegated_by),
    capabilities: normalizeStoredCapabilities(record.capabilities),
    expiresAt: nullableDate(record.expiresAt || record.expires_at),
    reason: sanitizeReason(record.reason || "Legacy board-scoped token."),
    createdAt: dateToIso(record.createdAt || record.created_at) || new Date().toISOString(),
    lastUsedAt: dateToIso(record.lastUsedAt || record.last_used_at),
    revokedAt: dateToIso(record.revokedAt || record.revoked_at)
  };
}

function toPublicTokenRecord(record: unknown): PublicTokenRecord | null {
  if (!isRecord(record)) return null;
  const id = String(record.id || "").trim();
  const boardId = String(record.boardId || record.board_id || "").trim();
  const agentId = String(record.agentId || record.agent_id || "").trim();
  const last4 = String(record.last4 || "").trim();
  if (!id || !boardId || !agentId || !last4) return null;
  const sessionId = sanitizeSessionId(record.sessionId || record.session_id) || `legacy:${id}`;

  return {
    id,
    boardId,
    agentId,
    label: sanitizeLabel(record.label),
    last4,
    teamId: nullableString(record.teamId || record.team_id),
    projectId: nullableString(record.projectId || record.project_id),
    sessionId,
    delegatedBy: nullableString(record.delegatedBy || record.delegated_by),
    capabilities: normalizeStoredCapabilities(record.capabilities),
    expiresAt: nullableDate(record.expiresAt || record.expires_at),
    reason: sanitizeReason(record.reason || "Legacy board-scoped token."),
    createdAt: dateToIso(record.createdAt || record.created_at) || new Date().toISOString(),
    lastUsedAt: dateToIso(record.lastUsedAt || record.last_used_at),
    revokedAt: dateToIso(record.revokedAt || record.revoked_at)
  };
}

function sanitizeLabel(label: unknown): string {
  return String(label || "Local agent").trim().slice(0, 120) || "Local agent";
}

function sanitizeSessionId(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, 160);
}

function sanitizeReason(value: unknown): string {
  return String(value || "Board-scoped agent access.").trim().slice(0, 500) || "Board-scoped agent access.";
}

function applyTokenUpdate(record: TokenRecord, input: AgentTokenUpdateInput): void {
  if (hasOwn(input, "label")) record.label = sanitizeLabel(input.label);
  if (hasOwn(input, "capabilities")) record.capabilities = normalizeCapabilityInput(input.capabilities, false);
  if (hasOwn(input, "expiresAt")) record.expiresAt = nullableDate(input.expiresAt);
  if (hasOwn(input, "reason")) record.reason = sanitizeReason(input.reason);
}

function normalizeStoredCapabilities(value: unknown): string[] {
  if (value == null) return [...DEFAULT_AGENT_CAPABILITIES];
  try {
    return normalizeCapabilities(value, true);
  } catch {
    return ["view"];
  }
}

function normalizeCapabilityInput(value: unknown, defaultOnMissing: boolean): string[] {
  return normalizeCapabilities(value, defaultOnMissing);
}

function normalizeCapabilities(value: unknown, defaultOnMissing: boolean): string[] {
  if (!Array.isArray(value)) return defaultOnMissing ? [...DEFAULT_AGENT_CAPABILITIES] : invalidCapabilities();
  const rawValues = value;
  const capabilities = rawValues
    .map((capability) => String(capability || "").trim())
    .filter(Boolean);
  const unique = [...new Set(capabilities)];
  if (!unique.length) return invalidCapabilities();
  const invalid = unique.find((capability) => !AGENT_CAPABILITY_SET.has(capability));
  if (invalid) throw new Error(`Invalid agent capability: ${invalid}`);
  return unique.slice(0, DEFAULT_AGENT_CAPABILITIES.length);
}

function invalidCapabilities(): never {
  throw new Error("At least one agent capability is required.");
}

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableDate(value: unknown): string | null {
  return dateToIso(value);
}

function isExpired(value: unknown): boolean {
  const expiresAt = dateToIso(value);
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
}

function dateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
