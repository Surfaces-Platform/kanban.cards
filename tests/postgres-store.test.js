const assert = require("node:assert/strict");
const test = require("node:test");

const { createPostgresAgentTokenStore, hashAgentToken } = require("../agent-token-store");
const { createBoard, createPostgresStateStore } = require("../state-store");

test("Postgres store reads, writes, and updates the workspace document", async () => {
  const pool = new FakePool();
  const store = createPostgresStateStore({ pool });

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

  const { result, state } = await store.update((workspace) => {
    workspace.boards[0].name = "Updated board";
    return workspace.boards[0];
  });

  assert.equal(result.name, "Updated board");
  assert.equal(state.boards[0].name, "Updated board");
  assert.equal((await store.read()).boards[0].name, "Updated board");
});

test("Postgres agent token store persists hashes and supports verify and revoke", async () => {
  const pool = new FakeTokenPool();
  const store = createPostgresAgentTokenStore({ pool });

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
  assert.equal(verified.agentId, "agent-a");
  assert.ok(verified.lastUsedAt);

  const revoked = await store.revoke("board-1", created.tokenRecord.id);
  assert.ok(revoked.revokedAt);
  assert.equal(await store.verify(created.token), null);
});

class FakePool {
  constructor() {
    this.rows = new Map();
  }

  async query(sql, args = []) {
    return this.handle(sql, args);
  }

  async connect() {
    return {
      query: (sql, args = []) => this.handle(sql, args),
      release: () => undefined
    };
  }

  async handle(sql, args = []) {
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
  constructor() {
    this.tokens = [];
  }

  async query(sql, args = []) {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql.startsWith("CREATE INDEX")) {
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
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null
      };
      this.tokens.push(row);
      return { rows: [row] };
    }

    if (normalizedSql.startsWith("SELECT ID")) {
      return {
        rows: this.tokens
          .filter((token) => token.board_id === args[0] && !token.revoked_at)
          .sort((left, right) => right.created_at - left.created_at)
      };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET LAST_USED_AT")) {
      const token = this.tokens.find((candidate) => candidate.token_hash === args[0] && !candidate.revoked_at);
      if (!token) return { rows: [] };
      token.last_used_at = new Date();
      return { rows: [token] };
    }

    if (normalizedSql.startsWith("UPDATE") && normalizedSql.includes("SET REVOKED_AT")) {
      const token = this.tokens.find((candidate) => candidate.board_id === args[0] && candidate.id === args[1]);
      if (!token) return { rows: [] };
      token.revoked_at = token.revoked_at || new Date();
      return { rows: [token] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}
