import type { WorkspaceState } from "../../src/types";

export type QueryResult = { rows: any[] };

export type EventRow = {
  id: string;
  type: string;
  board_id: string | null;
  payload: Record<string, any>;
  created_at: Date;
};

export type TokenRow = {
  id: string;
  board_id: string;
  agent_id: string;
  label: string;
  token_hash: string;
  last4: string;
  team_id: string | null;
  project_id: string | null;
  session_id: string | null;
  delegated_by: string | null;
  capabilities: string[] | null;
  expires_at: Date | null;
  reason: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

export class FakePostgresStatePool {
  rows: Map<string, WorkspaceState>;

  constructor() {
    this.rows = new Map();
  }

  async query(sql: string, args: any[] = []): Promise<QueryResult> {
    return this.handle(sql, args);
  }

  async connect(): Promise<{ query: (sql: string, args?: any[]) => Promise<QueryResult>; release: () => void }> {
    return {
      query: (sql: string, args: any[] = []) => this.handle(sql, args),
      release: () => undefined
    };
  }

  async handle(sql: string, args: any[] = []): Promise<QueryResult> {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql === "BEGIN" || normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK") {
      return { rows: [] };
    }

    if (normalizedSql.startsWith("SELECT STATE")) {
      const state = this.rows.get(args[0]);
      return { rows: state ? [{ state }] : [] };
    }

    if (normalizedSql.startsWith("INSERT INTO")) {
      if (normalizedSql.includes("DO NOTHING") && this.rows.has(args[0])) return { rows: [] };
      this.rows.set(args[0], JSON.parse(args[1]));
      return { rows: [] };
    }

    if (normalizedSql.startsWith("UPDATE")) {
      this.rows.set(args[0], JSON.parse(args[1]));
      return { rows: [] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

export class FakePostgresAgentTokenPool {
  tokens: TokenRow[];

  constructor() {
    this.tokens = [];
  }

  seedToken(row: Partial<TokenRow> & Pick<TokenRow, "id" | "board_id" | "agent_id" | "token_hash" | "last4">): TokenRow {
    const token: TokenRow = {
      id: row.id,
      board_id: row.board_id,
      agent_id: row.agent_id,
      label: row.label ?? "Legacy token",
      token_hash: row.token_hash,
      last4: row.last4,
      team_id: row.team_id ?? null,
      project_id: row.project_id ?? null,
      session_id: row.session_id ?? null,
      delegated_by: row.delegated_by ?? null,
      capabilities: row.capabilities ?? null,
      expires_at: row.expires_at ?? null,
      reason: row.reason ?? null,
      created_at: row.created_at ?? new Date(),
      last_used_at: row.last_used_at ?? null,
      revoked_at: row.revoked_at ?? null
    };
    this.tokens.push(token);
    return token;
  }

  async query(sql: string, args: any[] = []): Promise<QueryResult> {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql.startsWith("CREATE INDEX") || normalizedSql.startsWith("ALTER TABLE")) {
      return { rows: [] };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET SESSION_ID")) {
      for (const token of this.tokens) {
        if (!token.session_id) token.session_id = `legacy:${token.id}`;
      }
      return { rows: [] };
    }

    if (normalizedSql.startsWith("INSERT INTO")) {
      const row: TokenRow = {
        id: args[0],
        board_id: args[1],
        agent_id: args[2],
        label: args[3],
        token_hash: args[4],
        last4: args[5],
        team_id: args[6],
        project_id: args[7],
        session_id: args[8],
        delegated_by: args[9],
        capabilities: JSON.parse(args[10]),
        expires_at: args[11] ? new Date(args[11]) : null,
        reason: args[12],
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null
      };
      this.tokens.push(row);
      return { rows: [publicTokenRow(row)] };
    }

    if (normalizedSql.startsWith("SELECT ID")) {
      return {
        rows: this.tokens
          .filter((token: TokenRow) => token.board_id === args[0] && !token.revoked_at)
          .sort((left: TokenRow, right: TokenRow) => right.created_at.getTime() - left.created_at.getTime())
          .map(publicTokenRow)
      };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET LAST_USED_AT")) {
      const token = this.tokens.find((candidate: TokenRow) =>
        candidate.token_hash === args[0] &&
        !candidate.revoked_at &&
        (!candidate.expires_at || candidate.expires_at.getTime() > Date.now())
      );
      if (!token) return { rows: [] };
      token.last_used_at = new Date();
      return { rows: [publicTokenRow(token)] };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET LABEL = CASE")) {
      const token = this.tokens.find((candidate: TokenRow) => candidate.board_id === args[0] && candidate.session_id === args[1] && !candidate.revoked_at);
      if (!token) return { rows: [] };
      if (args[2]) token.label = args[3];
      if (args[4]) token.capabilities = JSON.parse(args[5]);
      if (args[6]) token.expires_at = args[7] ? new Date(args[7]) : null;
      if (args[8]) token.reason = args[9];
      return { rows: [publicTokenRow(token)] };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET REVOKED_AT")) {
      const usesSessionId = normalizedSql.includes("SESSION_ID = $2");
      const token = this.tokens.find((candidate: TokenRow) =>
        candidate.board_id === args[0] &&
        (usesSessionId ? candidate.session_id === args[1] : candidate.id === args[1])
      );
      if (!token) return { rows: [] };
      token.revoked_at = token.revoked_at || new Date();
      return { rows: [publicTokenRow(token)] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

export class FakePostgresEventPool {
  events: EventRow[];

  constructor() {
    this.events = [];
  }

  async query(sql: string, args: any[] = []): Promise<QueryResult> {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql.startsWith("CREATE INDEX")) {
      return { rows: [] };
    }

    if (normalizedSql.startsWith("INSERT INTO")) {
      const event: EventRow = {
        id: String(this.events.length + 1),
        type: args[0],
        board_id: args[1] ?? null,
        payload: JSON.parse(args[2] || "{}"),
        created_at: new Date()
      };
      this.events.push(event);
      return { rows: [event] };
    }

    if (normalizedSql.startsWith("SELECT MAX(ID)::TEXT")) {
      return { rows: [{ id: this.events.at(-1)?.id || null }] };
    }

    if (normalizedSql.startsWith("SELECT ID::TEXT") && normalizedSql.includes("ORDER BY ID ASC")) {
      const since = BigInt(String(args[0] || "0"));
      const limit = normalizeLimit(args[1]);
      return {
        rows: this.events
          .filter((event) => BigInt(event.id) > since)
          .sort((left, right) => compareEventRows(left, right))
          .slice(0, limit)
      };
    }

    if (normalizedSql.startsWith("SELECT ID::TEXT") && normalizedSql.includes("ORDER BY ID DESC")) {
      const hasBoardFilter = normalizedSql.includes("BOARD_ID =");
      const hasCardFilter = normalizedSql.includes("PAYLOAD->'RESOURCE'");
      let argIndex = 0;
      const boardId = hasBoardFilter ? String(args[argIndex++] || "") : null;
      const cardId = hasCardFilter ? String(args[argIndex++] || "") : null;
      const limit = normalizeLimit(args[argIndex]);
      return {
        rows: this.events
          .filter((event) => matchesRecentEvent(event, boardId, cardId))
          .sort((left, right) => compareEventRows(right, left))
          .slice(0, limit)
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

function publicTokenRow(row: TokenRow): any {
  return {
    id: row.id,
    board_id: row.board_id,
    agent_id: row.agent_id,
    label: row.label,
    last4: row.last4,
    team_id: row.team_id,
    project_id: row.project_id,
    session_id: row.session_id,
    delegated_by: row.delegated_by,
    capabilities: row.capabilities,
    expires_at: row.expires_at,
    reason: row.reason,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at
  };
}

function matchesRecentEvent(event: EventRow, boardId: string | null, cardId: string | null): boolean {
  if (boardId && event.board_id !== boardId) return false;
  if (cardId && eventCardId(event) !== cardId) return false;
  return true;
}

function eventCardId(event: EventRow): string | null {
  const resource = isRecord(event.payload.resource) ? event.payload.resource : {};
  const directCardId = nullableString(resource.cardId || event.payload.cardId);
  if (directCardId) return directCardId;
  if (String(resource.type || "") === "card") return nullableString(resource.id);
  return null;
}

function compareEventRows(left: EventRow, right: EventRow): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function normalizeLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 200;
  return Math.max(1, Math.min(Math.trunc(limit), 1000));
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
