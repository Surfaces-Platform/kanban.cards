const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_TABLE_NAME = "agent_access_tokens";
const DEFAULT_TOKEN_FILE = path.join(__dirname, "data", "agent-access-tokens.json");

function createAgentTokenStore(options = {}) {
  const connectionString = options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
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

function createFileAgentTokenStore(dataPath = DEFAULT_TOKEN_FILE) {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue = Promise.resolve();

  async function ensureReady() {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    try {
      await fs.access(resolvedPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeTokens([]);
    }
  }

  async function readTokens() {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.tokens) ? parsed.tokens.map(normalizeTokenRecord).filter(Boolean) : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  }

  async function writeTokens(tokens) {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, resolvedPath);
    await fs.chmod(resolvedPath, 0o600).catch(() => undefined);
  }

  async function updateTokens(mutator) {
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const tokens = await readTokens();
        const result = mutator(tokens);
        await writeTokens(tokens);
        return result;
      });
    return writeQueue;
  }

  async function list(boardId) {
    await ensureReady();
    return (await readTokens())
      .filter((token) => token.boardId === boardId && !token.revokedAt)
      .map(toPublicTokenRecord);
  }

  async function create(input) {
    const rawToken = generateAgentToken();
    const now = new Date().toISOString();
    const record = normalizeTokenRecord({
      id: input.id || `agtok_${crypto.randomUUID()}`,
      boardId: input.boardId,
      agentId: input.agentId,
      label: input.label || "Local agent",
      tokenHash: hashAgentToken(rawToken),
      last4: rawToken.slice(-4),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    });

    await updateTokens((tokens) => {
      tokens.push(record);
    });

    return { token: rawToken, tokenRecord: toPublicTokenRecord(record) };
  }

  async function verify(rawToken) {
    const tokenHash = hashAgentToken(rawToken);
    const now = new Date().toISOString();
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.tokenHash === tokenHash && !candidate.revokedAt);
      if (!record) return null;
      record.lastUsedAt = now;
      return toPublicTokenRecord(record);
    });
  }

  async function revoke(boardId, tokenId) {
    const now = new Date().toISOString();
    return updateTokens((tokens) => {
      const record = tokens.find((candidate) => candidate.id === tokenId && candidate.boardId === boardId);
      if (!record) return null;
      if (!record.revokedAt) record.revokedAt = now;
      return toPublicTokenRecord(record);
    });
  }

  return { kind: "file", path: resolvedPath, ensureReady, list, create, verify, revoke };
}

function createPostgresAgentTokenStore(options = {}) {
  const { Pool } = require("pg");
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
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
          board_id text NOT NULL,
          agent_id text NOT NULL,
          label text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          last4 text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz,
          revoked_at timestamptz
        )
      `).then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_board_id_idx ON ${tableName} (board_id)`))
        .then(() => client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_token_hash_idx ON ${tableName} (token_hash)`));
      if (client === pool) readyPromise = ready;
      await ready;
      return;
    }

    await readyPromise;
  }

  async function list(boardId) {
    await ensureReady();
    const result = await pool.query(
      `SELECT id, board_id, agent_id, label, last4, created_at, last_used_at, revoked_at
       FROM ${tableName}
       WHERE board_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [boardId]
    );
    return result.rows.map(toPublicTokenRecord);
  }

  async function create(input) {
    await ensureReady();
    const rawToken = generateAgentToken();
    const id = input.id || `agtok_${crypto.randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO ${tableName} (id, board_id, agent_id, label, token_hash, last4, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING id, board_id, agent_id, label, last4, created_at, last_used_at, revoked_at`,
      [
        id,
        input.boardId,
        input.agentId,
        sanitizeLabel(input.label),
        hashAgentToken(rawToken),
        rawToken.slice(-4)
      ]
    );
    return { token: rawToken, tokenRecord: toPublicTokenRecord(result.rows[0]) };
  }

  async function verify(rawToken) {
    await ensureReady();
    const result = await pool.query(
      `UPDATE ${tableName}
       SET last_used_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id, board_id, agent_id, label, last4, created_at, last_used_at, revoked_at`,
      [hashAgentToken(rawToken)]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  async function revoke(boardId, tokenId) {
    await ensureReady();
    const result = await pool.query(
      `UPDATE ${tableName}
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE board_id = $1 AND id = $2
       RETURNING id, board_id, agent_id, label, last4, created_at, last_used_at, revoked_at`,
      [boardId, tokenId]
    );
    return result.rows[0] ? toPublicTokenRecord(result.rows[0]) : null;
  }

  return { kind: "postgres", path: tableName, ensureReady, list, create, verify, revoke };
}

function generateAgentToken() {
  return `kcagt_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashAgentToken(rawToken) {
  return `sha256:${crypto.createHash("sha256").update(String(rawToken)).digest("hex")}`;
}

function normalizeTokenRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id || "").trim();
  const boardId = String(record.boardId || record.board_id || "").trim();
  const agentId = String(record.agentId || record.agent_id || "").trim();
  const tokenHash = String(record.tokenHash || record.token_hash || "").trim();
  const last4 = String(record.last4 || "").trim();
  if (!id || !boardId || !agentId || !tokenHash || !last4) return null;

  return {
    id,
    boardId,
    agentId,
    label: sanitizeLabel(record.label),
    tokenHash,
    last4,
    createdAt: dateToIso(record.createdAt || record.created_at) || new Date().toISOString(),
    lastUsedAt: dateToIso(record.lastUsedAt || record.last_used_at),
    revokedAt: dateToIso(record.revokedAt || record.revoked_at)
  };
}

function toPublicTokenRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id || "").trim();
  const boardId = String(record.boardId || record.board_id || "").trim();
  const agentId = String(record.agentId || record.agent_id || "").trim();
  const last4 = String(record.last4 || "").trim();
  if (!id || !boardId || !agentId || !last4) return null;

  return {
    id,
    boardId,
    agentId,
    label: sanitizeLabel(record.label),
    last4,
    createdAt: dateToIso(record.createdAt || record.created_at) || new Date().toISOString(),
    lastUsedAt: dateToIso(record.lastUsedAt || record.last_used_at),
    revokedAt: dateToIso(record.revokedAt || record.revoked_at)
  };
}

function sanitizeLabel(label) {
  return String(label || "Local agent").trim().slice(0, 120) || "Local agent";
}

function dateToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolvePostgresSsl(options = {}) {
  if (options.ssl !== undefined) return options.ssl;
  if (process.env.KANBAN_CARDS_POSTGRES_SSL === "disable") return false;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return { rejectUnauthorized: false };
  return undefined;
}

module.exports = {
  createAgentTokenStore,
  createFileAgentTokenStore,
  createPostgresAgentTokenStore,
  generateAgentToken,
  hashAgentToken
};
