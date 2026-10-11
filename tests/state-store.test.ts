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

test("existing Cards receive handoff defaults without interpreting or changing their body", () => {
  const now = new Date().toISOString();
  const workspace = workspaceWithProject(now) as any;
  const body = "  Next actor: agent\nPriority: High\nBlocked: waiting for approval  \n";
  workspace.projects[0].cards.push(storedCard(now, { body }));

  const card = normalizeWorkspace(workspace).projects[0].cards[0];
  assert.deepEqual(cardMetadata(card), { nextActor: null, nextAction: "", priority: null, blockedReason: "" });
  assert.equal(card.body, body);
  assert.equal(card.version, 1);
});

test("cached full Card responses receive defaults while preserving their original snapshots and other response shapes", () => {
  const workspace = workspaceWithCachedCards();
  const before = structuredClone(workspace);
  const normalized = normalizeWorkspace(workspace);
  const defaults = { nextActor: null, nextAction: "", priority: null, blockedReason: "" };

  for (const index of [0, 1]) {
    const original = before.idempotencyRecords[index];
    assert.deepEqual(normalized.idempotencyRecords[index], {
      ...original,
      response: { ...original.response, card: { ...original.response.card, ...defaults } }
    });
  }
  assert.deepEqual(normalized.idempotencyRecords.slice(2), before.idempotencyRecords.slice(2));
  assert.deepEqual(workspace, before, "normalization must not mutate the stored input");
  assert.deepEqual(normalizeWorkspace(normalized), normalized, "normalization must be repeatable");
});

test("cached Card handoff fields use the same validation and clearing rules as live Cards", () => {
  const workspace = workspaceWithCachedCards();
  Object.assign(workspace.idempotencyRecords[0].response.card, {
    nextActor: "agent", nextAction: "  Check the result\n", priority: "Medium", blockedReason: null
  });
  const card = (normalizeWorkspace(workspace).idempotencyRecords[0].response as any).card;
  assert.deepEqual(cardMetadata(card), {
    nextActor: "agent", nextAction: "Check the result", priority: "Medium", blockedReason: ""
  });

  for (const invalid of [
    { nextActor: "robot" }, { priority: "high" }, { nextAction: 1 }, { blockedReason: false }
  ]) {
    const attempted = structuredClone(workspace);
    Object.assign(attempted.idempotencyRecords[0].response.card, invalid);
    assert.throws(() => normalizeWorkspace(attempted), /Card (nextActor|priority|nextAction|blockedReason) must/);
  }
});

test("file and Postgres storage normalize legacy cached Cards on read and persist them on the next update", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cached-cards-"));
  const dataPath = path.join(directory, "workspace.json");
  const legacy = workspaceWithCachedCards();
  const raw = JSON.stringify(legacy);
  const database = new FakePostgresPool();
  database.state = structuredClone(legacy);

  try {
    await fs.writeFile(dataPath, raw);
    const stores = [
      createFileStateStore(dataPath),
      createPostgresStateStore({ pool: database as unknown as Pool, workspaceId: "test-workspace" })
    ];
    const expected = normalizeWorkspace(legacy);
    for (const store of stores) {
      const read = await store.readExisting();
      assert.deepEqual(read, expected);
      assert.deepEqual(cardMetadata((read!.idempotencyRecords[0].response as any).card), {
        nextActor: null, nextAction: "", priority: null, blockedReason: ""
      });
    }
    assert.equal(await fs.readFile(dataPath, "utf8"), raw, "readExisting must not rewrite the file");
    assert.deepEqual(database.state, legacy, "readExisting must not rewrite the database row");

    for (const store of stores) await store.update(() => undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(dataPath, "utf8")), expected);
    assert.deepEqual(database.state, expected);
    assert.deepEqual(await createFileStateStore(dataPath).readExisting(), expected);
    assert.deepEqual(await createPostgresStateStore({
      pool: database as unknown as Pool, workspaceId: "test-workspace"
    }).readExisting(), expected);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("handoff metadata persists normalized values and can be cleared without losing other Card data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-card-handoff-store-"));
  const dataPath = path.join(directory, "workspace.json");
  const store = createFileStateStore(dataPath);
  const now = new Date().toISOString();
  const workspace = workspaceWithProject(now) as any;
  workspace.projects[0].cards.push(storedCard(now, {
    nextActor: "agent", nextAction: "  Run the focused check\n", priority: "High", blockedReason: "  Waiting for access  "
  }));
  try {
    await store.write(workspace);
    const reopened = createFileStateStore(dataPath);
    let card = (await reopened.read()).projects[0].cards[0];
    assert.deepEqual(cardMetadata(card), { nextActor: "agent", nextAction: "Run the focused check", priority: "High", blockedReason: "Waiting for access" });

    const cleared = JSON.parse(await fs.readFile(dataPath, "utf8"));
    Object.assign(cleared.projects[0].cards[0], { nextActor: null, nextAction: null, priority: null, blockedReason: null });
    await reopened.write(cleared);
    card = (await store.read()).projects[0].cards[0];
    assert.deepEqual(cardMetadata(card), { nextActor: null, nextAction: "", priority: null, blockedReason: "" });
    assert.equal(card.title, "Existing Card");
    assert.equal(card.body, "Existing description");
    assert.equal(card.version, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid persisted handoff metadata fails closed and cannot overwrite valid state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-card-handoff-invalid-"));
  const dataPath = path.join(directory, "workspace.json");
  const store = createFileStateStore(dataPath);
  const now = new Date().toISOString();
  const workspace = workspaceWithProject(now) as any;
  workspace.projects[0].cards.push(storedCard(now));
  try {
    await store.write(workspace);
    const before = await fs.readFile(dataPath, "utf8");
    for (const invalid of [
      { nextActor: "robot" }, { nextActor: ["human"] }, { priority: "high" }, { priority: 1 },
      { nextAction: { text: "Act" } }, { blockedReason: false }
    ]) {
      const attempted = JSON.parse(before);
      Object.assign(attempted.projects[0].cards[0], invalid);
      await assert.rejects(() => store.write(attempted), /Card (nextActor|priority|nextAction|blockedReason) must/);
      assert.equal(await fs.readFile(dataPath, "utf8"), before);
    }
    const invalidStored = JSON.parse(before);
    invalidStored.projects[0].cards[0].nextActor = " Agent ";
    const rawInvalid = JSON.stringify(invalidStored);
    await fs.writeFile(dataPath, rawInvalid);
    await assert.rejects(() => store.readExisting(), /Card nextActor must/);
    assert.equal(await fs.readFile(dataPath, "utf8"), rawInvalid);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

function storedCard(now: string, metadata: Record<string, unknown> = {}) {
  return {
    id: "card-existing", title: "Existing Card", body: "Existing description", columnId: "inbox", position: 0,
    version: 1, archivedAt: null, createdAt: now, updatedAt: now, comments: [], ...metadata
  };
}

function workspaceWithCachedCards(): any {
  const now = "2026-10-01T12:00:00.000Z";
  const workspace = workspaceWithProject(now) as any;
  const card = storedCard(now, {
    body: "  Original Markdown  \n", externalKey: "cached:one", responseExtension: { preserved: true }
  });
  workspace.projects[0].cards = [storedCard(now, { title: "Changed live Card", nextActor: "human", priority: "High" })];
  const record = (key: string, requestPath: string, response: unknown, statusCode = 201) => ({
    key, method: "POST", path: requestPath, requestHash: `hash:${key}`, statusCode, response, createdAt: now
  });
  workspace.idempotencyRecords = [
    record("create", "/api/projects/project-one/cards", { card, projectRevision: 2 }),
    record("deduplicate", "/API/PROJECTS/project-one/CARDS/", { card: structuredClone(card), projectRevision: 4, deduplicated: true }, 200),
    record("modern", "/api/projects/project-one/cards", {
      card: { ...card, nextActor: "agent", nextAction: "Run the check", priority: "Low", blockedReason: "Access" }, projectRevision: 5
    }),
    record("comment", "/api/projects/project-one/cards/card-existing/comments", {
      comment: { id: "comment-one", body: "Original comment", author: "Agent", createdAt: now },
      card: { id: card.id, version: 2 }, projectRevision: 3
    }),
    record("project", "/api/projects", { project: { id: "project-one", cards: [] } }),
    record("partial", "/api/projects/project-one/cards", { card: { id: card.id, version: 1 } }),
    record("unrelated", "/api/projects/project-one/cards/card-existing/other", { card: structuredClone(card) })
  ];
  return workspace;
}

function cardMetadata(card: { nextActor: unknown; nextAction: unknown; priority: unknown; blockedReason: unknown }) {
  return { nextActor: card.nextActor, nextAction: card.nextAction, priority: card.priority, blockedReason: card.blockedReason };
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
