import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileEventStore, createPostgresEventStore } from "../src/event-store";

type QueryResult = { rows: any[] };
type EventRow = {
  id: string;
  type: string;
  board_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

test("file event store appends and lists events after a cursor", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-events-file-"));
  const eventPath = path.join(tempDir, "events.jsonl");
  const store = createFileEventStore(eventPath);

  try {
    assert.equal(await store.latestId(), null);
    const first = await store.append({ type: "workspace_changed", boardId: "board-1", payload: { reason: "card_created" } });
    const second = await store.append({ type: "workspace_changed", boardId: "board-1", payload: { reason: "comment_created" } });

    assert.equal(first.id, "1");
    assert.equal(second.id, "2");
    assert.equal(await store.latestId(), "2");

    const afterFirst = await store.listSince(first.id);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].id, second.id);
    assert.equal(afterFirst[0].payload.reason, "comment_created");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Postgres event store initializes and lists events after a cursor", async () => {
  const pool = new FakeEventPool();
  const store = createPostgresEventStore({ pool: pool as any });

  assert.equal(await store.latestId(), null);
  const first = await store.append({ type: "workspace_changed", boardId: "board-1", payload: { reason: "card_created" } });
  const second = await store.append({ type: "workspace_changed", boardId: "board-1", payload: { reason: "card_updated" } });

  assert.equal(first.id, "1");
  assert.equal(second.id, "2");
  assert.equal(await store.latestId(), "2");

  const afterFirst = await store.listSince(first.id);
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].id, second.id);
  assert.equal(afterFirst[0].payload.reason, "card_updated");
});

class FakeEventPool {
  events: EventRow[] = [];

  async query(sql: string, args: any[] = []): Promise<QueryResult> {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql.startsWith("CREATE INDEX")) {
      return { rows: [] };
    }

    if (normalizedSql.startsWith("INSERT INTO")) {
      const event = {
        id: String(this.events.length + 1),
        type: args[0],
        board_id: args[1],
        payload: JSON.parse(args[2] || "{}"),
        created_at: new Date()
      };
      this.events.push(event);
      return { rows: [event] };
    }

    if (normalizedSql.startsWith("SELECT ID::TEXT")) {
      const since = BigInt(String(args[0] || "0"));
      const limit = Number(args[1] || 200);
      return {
        rows: this.events
          .filter((event) => BigInt(event.id) > since)
          .slice(0, limit)
      };
    }

    if (normalizedSql.startsWith("SELECT MAX(ID)::TEXT")) {
      return { rows: [{ id: this.events.at(-1)?.id || null }] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}
