import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAgentTokenStore, hashAgentToken } from "../src/agent-token-store";
import { normalizePostgresConnectionString } from "../src/postgres-config";
import { createBoard, createPostgresStateStore } from "../src/state-store";
import type { WorkspaceState } from "../src/types";

type QueryResult = { rows: any[] };
type TokenRow = {
  id: string;
  board_id: string;
  agent_id: string;
  label: string;
  token_hash: string;
  last4: string;
  team_id: string | null;
  project_id: string | null;
  session_id: string;
  delegated_by: string | null;
  capabilities: string[];
  expires_at: Date | null;
  reason: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

test("Postgres store reads, writes, and updates the workspace document", async () => {
  const pool = new FakePool();
  const store = createPostgresStateStore({ pool: pool as any });

  const initial = await store.read();
  assert.equal(initial.boards.length, 1);
  assert.equal(initial.boards[0].name, "Untitled board");

  const board = createBoard({ name: "Postgres board" });
  await store.write({
    boards: [board],
    activeBoardId: board.id,
    templates: []
  });

  const saved = await store.read();
  assert.equal(saved.boards[0].name, "Postgres board");

  const { result, state } = await store.update((workspace: WorkspaceState) => {
    workspace.boards[0].name = "Updated board";
    return workspace.boards[0];
  });

  assert.equal(result.name, "Updated board");
  assert.equal(state.boards[0].name, "Updated board");
  assert.equal((await store.read()).boards[0].name, "Updated board");
});

test("Postgres agent token store persists hashes and supports verify and revoke", async () => {
  const pool = new FakeTokenPool();
  const store = createPostgresAgentTokenStore({ pool: pool as any });

  const created = await store.create({
    boardId: "board-1",
    agentId: "agent-a",
    label: "Agent laptop"
  });
  assert.match(created.token, /^kcagt_/);
  assert.equal(created.tokenRecord.boardId, "board-1");
  assert.equal(Object.hasOwn(created.tokenRecord, "tokenHash"), false);
  assert.equal(pool.tokens[0].token_hash, hashAgentToken(created.token));

  const listed = await store.list("board-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].lastUsedAt, null);

  const verified = await store.verify(created.token);
  assert.ok(verified);
  assert.equal(verified.agentId, "agent-a");
  assert.ok(verified.lastUsedAt);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const updated = await store.update("board-1", created.tokenRecord.sessionId, {
    label: "View-only laptop",
    capabilities: ["view"],
    expiresAt,
    reason: "Limited visibility."
  });
  assert.ok(updated);
  assert.equal(updated.label, "View-only laptop");
  assert.deepEqual(updated.capabilities, ["view"]);
  assert.equal(updated.reason, "Limited visibility.");
  assert.equal(Object.hasOwn(updated, "tokenHash"), false);

  const sessionRevoked = await store.revokeSession("board-1", created.tokenRecord.sessionId);
  assert.ok(sessionRevoked);
  assert.ok(sessionRevoked.revokedAt);
  assert.equal(await store.verify(created.token), null);

  const compatibilityToken = await store.create({
    boardId: "board-1",
    agentId: "agent-a",
    label: "Compatibility token"
  });
  const revoked = await store.revoke("board-1", compatibilityToken.tokenRecord.id);
  assert.ok(revoked);
  assert.ok(revoked.revokedAt);
  assert.equal(await store.verify(compatibilityToken.token), null);
});

test("Postgres connection strings use explicit SSL mode to avoid pg runtime warnings", () => {
  assert.equal(
    normalizePostgresConnectionString("postgres://user:pass@example.com/db?sslmode=require"),
    "postgres://user:pass@example.com/db?sslmode=verify-full"
  );
  assert.equal(
    normalizePostgresConnectionString("postgres://user:pass@example.com/db?sslmode=require&uselibpqcompat=true"),
    "postgres://user:pass@example.com/db?sslmode=require&uselibpqcompat=true"
  );
});

class FakePool {
  rows: Map<string, WorkspaceState>;

  constructor() {
    this.rows = new Map();
  }

  async query(sql: string, args: any[] = []): Promise<QueryResult> {
    return this.handle(sql, args);
  }

  async connect(): Promise<{ query: (sql: string, args?: any[]) => Promise<QueryResult>; release: () => undefined }> {
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

class FakeTokenPool {
  tokens: TokenRow[];

  constructor() {
    this.tokens = [];
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
      const row = {
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
