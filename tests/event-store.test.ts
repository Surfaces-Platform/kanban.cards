import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileEventStore, createPostgresEventStore } from "../src/event-store";
import { FakePostgresEventPool } from "./helpers/postgres-fakes";

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
  const pool = new FakePostgresEventPool();
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

  const third = await store.append({ type: "workspace_changed", boardId: "board-2", payload: { reason: "other_board_updated" } });
  const recentBoardEvents = await store.listRecent({ boardId: "board-1", limit: 1 });
  assert.equal(third.id, "3");
  assert.equal(recentBoardEvents.length, 1);
  assert.equal(recentBoardEvents[0].id, second.id);
  assert.equal(recentBoardEvents[0].payload.reason, "card_updated");
});
