const assert = require("node:assert/strict");
const test = require("node:test");

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
