import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Pool } from "pg";

import { createFileStateStore, createPostgresStateStore, freshWorkspaceState, normalizeWorkspace } from "../src/state-store";

test("V2 starts empty and rejects legacy workspace shapes", () => {
  assert.deepEqual(freshWorkspaceState(), {
    schemaVersion: 2,
    projects: [],
    idempotencyRecords: []
  });

  assert.throws(
    () => normalizeWorkspace({ projects: [], boards: [], members: [] }),
    /Unsupported workspace schema/
  );
});

test("Activity normalization preserves an optional stable AgentConnection ID without requiring it from legacy rows", () => {
  const now = new Date().toISOString();
  const workspace = workspaceWithProject(now) as any;
  workspace.projects[0].activity = [
    { id: "activity-agent", action: "card.created", actor: { channel: "api", label: "Automation", agentConnectionId: "agent-123" }, summary: "Created Card", projectId: "project-one", createdAt: now },
    { id: "activity-legacy", action: "project.updated", actor: { channel: "api", label: "Legacy bridge" }, summary: "Updated Project", projectId: "project-one", createdAt: now }
  ];

  const normalized = normalizeWorkspace(workspace);
  assert.deepEqual(normalized.projects[0].activity[0].actor, { channel: "api", label: "Automation", agentConnectionId: "agent-123" });
  assert.deepEqual(normalized.projects[0].activity[1].actor, { channel: "api", label: "Legacy bridge" });
});

test("file storage persists only normalized V2 state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-v2-store-"));
  const dataPath = path.join(directory, "workspace.json");
  const store = createFileStateStore(dataPath);

  try {
    assert.deepEqual(await store.read(), freshWorkspaceState());

    const now = new Date().toISOString();
    await store.write({
      schemaVersion: 2,
      projects: [{
        id: "project-one",
        name: "Project one",
        description: "",
        columns: [
          { id: "inbox", name: "Inbox", position: 0 },
          { id: "done", name: "Done", position: 1 }
        ],
        cards: [],
        activity: [],
        revision: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now
      }],
      idempotencyRecords: []
    });

    const restarted = createFileStateStore(dataPath);
    const state = await restarted.read();
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].name, "Project one");
    assert.deepEqual(state.projects[0].columns.map((column) => column.name), ["Inbox", "Done"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file readExisting validates without creating or rewriting state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-v2-preflight-"));
  const dataPath = path.join(directory, "workspace.json");
  const store = createFileStateStore(dataPath);

  try {
    assert.equal(await store.readExisting(), null);
    await assert.rejects(() => fs.stat(dataPath), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    });

    await fs.writeFile(dataPath, JSON.stringify({ schemaVersion: 1, projects: [], idempotencyRecords: [] }));
    await assert.rejects(() => store.readExisting(), /Unsupported workspace schema/);
    assert.equal(JSON.parse(await fs.readFile(dataPath, "utf8")).schemaVersion, 1);

    const expected = freshWorkspaceState();
    await fs.writeFile(dataPath, JSON.stringify(expected));
    assert.deepEqual(await store.readExisting(), expected);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Postgres storage initializes and updates V2 state in a locked transaction", async () => {
  const database = new FakePostgresPool();
  const store = createPostgresStateStore({ pool: database as unknown as Pool, workspaceId: "test-workspace" });

  assert.deepEqual(await store.read(), freshWorkspaceState());

  const now = new Date().toISOString();
  await store.write(workspaceWithProject(now));
  const mutation = await store.update((state) => {
    state.projects[0].name = "Updated project";
    state.projects[0].revision += 1;
    state.projects[0].updatedAt = new Date().toISOString();
    return state.projects[0].revision;
  });

  assert.equal(mutation.result, 2);
  assert.equal((await store.read()).projects[0].name, "Updated project");
  assert.ok(database.queries.some((query) => query === "BEGIN"));
  assert.ok(database.queries.some((query) => query.includes("FOR UPDATE")));
  assert.ok(database.queries.some((query) => query === "COMMIT"));
  assert.equal(database.queries.filter((query) => query.startsWith("CREATE TABLE")).length, 1);
  assert.equal(database.releaseCount, 1);
});

test("Postgres readExisting performs a non-creating SELECT and validates the stored row", async () => {
  const database = new FakePostgresPool();
  const store = createPostgresStateStore({ pool: database as unknown as Pool, workspaceId: "default" });

  assert.equal(await store.readExisting(), null);
  assert.deepEqual(database.queries, ["SELECT state FROM kanban_v2_workspaces WHERE id = $1"]);

  database.state = { schemaVersion: 1, projects: [], idempotencyRecords: [] };
  await assert.rejects(() => store.readExisting(), /Unsupported workspace schema/);
  assert.equal(database.queries.filter((query) => query.startsWith("SELECT state")).length, 2);
  assert.equal(database.queries.some((query) => query.startsWith("CREATE TABLE") || query.startsWith("INSERT INTO")), false);

  database.state = freshWorkspaceState();
  assert.deepEqual(await store.readExisting(), freshWorkspaceState());
});

function workspaceWithProject(now: string): unknown {
  return {
    schemaVersion: 2,
    projects: [{
      id: "project-one",
      name: "Project one",
      description: "",
      columns: [{ id: "inbox", name: "Inbox", position: 0 }],
      cards: [],
      activity: [],
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    }],
    idempotencyRecords: []
  };
}

class FakePostgresPool {
  state: unknown;
  queries: string[] = [];
  releaseCount = 0;

  async connect(): Promise<FakePostgresClient> {
    return new FakePostgresClient(this);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ state: unknown }> }> {
    return this.execute(sql, params);
  }

  async execute(sql: string, params: unknown[]): Promise<{ rows: Array<{ state: unknown }> }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (normalized.startsWith("CREATE TABLE") || normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT state")) {
      return { rows: this.state === undefined ? [] : [{ state: this.state }] };
    }
    if (normalized.startsWith("INSERT INTO") && normalized.includes("DO NOTHING")) {
      if (this.state === undefined) this.state = parseJsonParam(params[1]);
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO") || normalized.startsWith("UPDATE")) {
      this.state = parseJsonParam(params[1]);
      return { rows: [] };
    }
    throw new Error(`Unexpected fake Postgres query: ${normalized}`);
  }
}

class FakePostgresClient {
  constructor(private readonly database: FakePostgresPool) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ state: unknown }> }> {
    return this.database.execute(sql, params);
  }

  release(): void {
    this.database.releaseCount += 1;
  }
}

function parseJsonParam(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected a JSON state parameter.");
  return JSON.parse(value);
}
