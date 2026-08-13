import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Pool } from "pg";

import {
  AccessStoreError,
  createFileAccessStore,
  createPostgresAccessStore,
  normalizeAccessRegistry
} from "../src/access-store";
import { createWorkspaceStoreResolver, freshWorkspaceState } from "../src/state-store";

const MIKE_IDENTITY = {
  providerSubject: "auth0|mike",
  email: "mike@example.com",
  displayName: "Mike"
} as const;

test("access registry normalization rejects duplicate identity and broken ownership", () => {
  const timestamp = "2026-08-12T12:00:00.000Z";
  assert.deepEqual(normalizeAccessRegistry({
    schemaVersion: 1,
    owners: [],
    workspaces: [],
    handoffs: []
  }).revokedSessions, []);

  assert.throws(() => normalizeAccessRegistry({
    schemaVersion: 1,
    owners: [
      { id: "owner-a", providerSubject: "oidc|same", email: "a@example.com", displayName: "A", createdAt: timestamp, updatedAt: timestamp },
      { id: "owner-b", providerSubject: "oidc|same", email: "b@example.com", displayName: "B", createdAt: timestamp, updatedAt: timestamp }
    ],
    workspaces: [],
    handoffs: []
  }), /Duplicate provider subject/);

  assert.throws(() => normalizeAccessRegistry({
    schemaVersion: 1,
    owners: [],
    workspaces: [{
      id: "workspace-a",
      slug: "alpha",
      name: "Alpha",
      storageId: "state-alpha",
      ownerIds: ["missing-owner"],
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    handoffs: []
  }), /missing owner/);

  assert.throws(() => normalizeAccessRegistry({
    schemaVersion: 1,
    owners: [],
    workspaces: [],
    handoffs: [],
    revokedSessions: [
      { providerSubject: "oidc|unknown", sessionId: "session-one", revokedAt: timestamp },
      { providerSubject: "oidc|unknown", sessionId: "session-one", revokedAt: timestamp }
    ]
  }), /Duplicate revoked session/);
});

test("file access registry creates isolated Workspaces and binds legacy default exactly once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-access-file-"));
  const dataPath = path.join(directory, "access.json");
  let clock = new Date("2026-08-12T12:00:00.000Z");
  const store = createFileAccessStore(dataPath, { now: () => clock });
  try {
    const legacy = await store.bindLegacyWorkspace({ ...MIKE_IDENTITY, slug: "mike", name: "Mike" });
    const replay = await store.bindLegacyWorkspace({ ...MIKE_IDENTITY, slug: "mike", name: "Mike" });
    assert.equal(replay.id, legacy.id);
    assert.equal(legacy.storageId, "default");

    clock = new Date("2026-08-12T12:01:00.000Z");
    const newWorkspace = await store.createWorkspace({
      ...MIKE_IDENTITY,
      email: "Mike.Updated@Example.com",
      displayName: "Michael Long",
      slug: "studio",
      name: "Studio"
    });
    assert.notEqual(newWorkspace.storageId, "default");
    assert.notEqual(newWorkspace.storageId, legacy.storageId);
    assert.deepEqual((await store.listWorkspacesForOwner("auth0|mike")).map((workspace) => workspace.slug), ["mike", "studio"]);
    const resolvedOwner = await store.resolveOwner("auth0|mike");
    assert.deepEqual(resolvedOwner?.workspaces.map((workspace) => workspace.slug), ["mike", "studio"]);
    assert.equal(resolvedOwner?.owner.email, "mike.updated@example.com");
    assert.equal(resolvedOwner?.owner.displayName, "Michael Long");
    assert.equal(resolvedOwner?.owner.createdAt, "2026-08-12T12:00:00.000Z");
    assert.equal(resolvedOwner?.owner.updatedAt, "2026-08-12T12:01:00.000Z");
    assert.equal(await store.resolveOwner("auth0|unknown"), null);
    assert.equal((await store.getWorkspaceById(newWorkspace.id))?.slug, "studio");
    assert.equal((await store.getWorkspaceBySlug("STUDIO"))?.id, newWorkspace.id);
    assert.deepEqual(await store.listWorkspacesForOwner("auth0|unknown"), []);

    await assert.rejects(
      store.bindLegacyWorkspace({
        providerSubject: "auth0|other",
        email: "other@example.com",
        displayName: "Other",
        slug: "mike",
        name: "Mike"
      }),
      (error: unknown) => error instanceof AccessStoreError && error.code === "ACCESS_CONFLICT"
    );
    const state = await store.read();
    assert.equal(state.workspaces.length, 2);
    assert.equal(state.workspaces.filter((workspace) => workspace.storageId === "default").length, 1);
    assert.equal((await fs.stat(dataPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("session revocation is durable, idempotent, concurrent, and independent of owner admission", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-access-revocation-"));
  const dataPath = path.join(directory, "access.json");
  let clock = new Date("2026-08-12T12:00:00.000Z");
  const store = createFileAccessStore(dataPath, { now: () => clock });
  try {
    assert.equal(await store.isSessionRevoked("auth0|not-admitted", "root-session-unknown"), false);
    const [first, concurrentReplay] = await Promise.all([
      store.revokeSession("auth0|not-admitted", "root-session-unknown"),
      store.revokeSession("auth0|not-admitted", "root-session-unknown")
    ]);
    assert.deepEqual(concurrentReplay, first);
    assert.equal(first.revokedAt, "2026-08-12T12:00:00.000Z");
    assert.equal(await store.isSessionRevoked("auth0|not-admitted", "root-session-unknown"), true);
    assert.equal(await store.resolveOwner("auth0|not-admitted"), null);

    clock = new Date("2026-08-12T12:01:00.000Z");
    assert.deepEqual(await store.revokeSession("auth0|not-admitted", "root-session-unknown"), first);
    assert.equal((await store.read()).revokedSessions.length, 1);

    const reopened = createFileAccessStore(dataPath);
    assert.equal(await reopened.isSessionRevoked("auth0|not-admitted", "root-session-unknown"), true);
    assert.equal((await reopened.read()).owners.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("revoking a session family blocks its outstanding and future handoffs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-access-revoked-handoff-"));
  const store = createFileAccessStore(path.join(directory, "access.json"), {
    now: () => new Date("2026-08-12T12:00:00.000Z")
  });
  try {
    const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "studio", name: "Studio" });
    const issued = await store.createHandoff({
      providerSubject: MIKE_IDENTITY.providerSubject,
      workspaceId: workspace.id,
      sessionId: "root-session-revoked",
      destinationHost: "studio.kanban.cards"
    });
    await store.revokeSession(MIKE_IDENTITY.providerSubject, "root-session-revoked");

    await assert.rejects(
      store.consumeHandoff({ token: issued.token, destinationHost: "studio.kanban.cards" }),
      (error: unknown) => error instanceof AccessStoreError && error.code === "ACCESS_SESSION_REVOKED"
    );
    assert.equal((await store.read()).handoffs[0].consumedAt, null);
    await assert.rejects(
      store.createHandoff({
        providerSubject: MIKE_IDENTITY.providerSubject,
        workspaceId: workspace.id,
        sessionId: "root-session-revoked",
        destinationHost: "studio.kanban.cards"
      }),
      (error: unknown) => error instanceof AccessStoreError && error.code === "ACCESS_SESSION_REVOKED"
    );

    const active = await store.createHandoff({
      providerSubject: MIKE_IDENTITY.providerSubject,
      workspaceId: workspace.id,
      sessionId: "root-session-active",
      destinationHost: "studio.kanban.cards"
    });
    assert.equal(
      (await store.consumeHandoff({ token: active.token, destinationHost: "studio.kanban.cards" })).sessionId,
      "root-session-active"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("handoffs are hashed, exact-host, expiring, and atomically one-time", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-access-handoff-"));
  let clock = new Date("2026-08-12T12:00:00.000Z");
  const store = createFileAccessStore(path.join(directory, "access.json"), { now: () => clock });
  try {
    const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "studio", name: "Studio" });
    const issued = await store.createHandoff({
      providerSubject: "auth0|mike",
      workspaceId: workspace.id,
      sessionId: "root-session-handoff",
      destinationHost: "studio.kanban.cards",
      ttlSeconds: 60
    });
    const persisted = await store.read();
    assert.equal(persisted.handoffs.length, 1);
    assert.match(persisted.handoffs[0].tokenHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(persisted).includes(issued.token), false);
    assert.equal(issued.owner.email, MIKE_IDENTITY.email);
    assert.equal(issued.owner.displayName, MIKE_IDENTITY.displayName);
    assert.equal(issued.sessionId, "root-session-handoff");
    assert.equal(persisted.handoffs[0].sessionId, "root-session-handoff");

    await assert.rejects(
      store.consumeHandoff({ token: issued.token, destinationHost: "other.kanban.cards" }),
      (error: unknown) => error instanceof AccessStoreError && error.code === "ACCESS_HANDOFF_DESTINATION_MISMATCH"
    );

    const outcomes = await Promise.allSettled([
      store.consumeHandoff({ token: issued.token, destinationHost: "studio.kanban.cards" }),
      store.consumeHandoff({ token: issued.token, destinationHost: "studio.kanban.cards" })
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof store.consumeHandoff>>> => outcome.status === "fulfilled");
    assert.equal(fulfilled?.value.owner.email, MIKE_IDENTITY.email);
    assert.equal(fulfilled?.value.owner.displayName, MIKE_IDENTITY.displayName);
    assert.equal(fulfilled?.value.sessionId, "root-session-handoff");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.ok(rejected?.reason instanceof AccessStoreError);
    assert.equal(rejected.reason.code, "ACCESS_HANDOFF_CONSUMED");

    const expiring = await store.createHandoff({
      providerSubject: "auth0|mike",
      workspaceId: workspace.id,
      sessionId: "root-session-expiring",
      destinationHost: "studio.kanban.cards",
      ttlSeconds: 1
    });
    clock = new Date("2026-08-12T12:00:02.000Z");
    await assert.rejects(
      store.consumeHandoff({ token: expiring.token, destinationHost: "studio.kanban.cards" }),
      (error: unknown) => error instanceof AccessStoreError && error.code === "ACCESS_HANDOFF_EXPIRED"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workspace store resolver preserves legacy path and hashes untrusted storage ids", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-workspace-resolver-"));
  const legacyPath = path.join(directory, "legacy.json");
  const workspaceDirectory = path.join(directory, "tenants");
  const resolver = createWorkspaceStoreResolver({ dataPath: legacyPath, workspaceDirectory });
  try {
    assert.equal(resolver.resolve("default").path, legacyPath);
    const hostile = resolver.resolve("../../escape/with spaces?and=query");
    assert.equal(path.dirname(hostile.path), workspaceDirectory);
    assert.match(path.basename(hostile.path), /^workspace-[a-f0-9]{64}\.json$/);
    assert.equal(hostile.path.includes("escape"), false);

    const alpha = resolver.resolve("state-alpha");
    const beta = resolver.resolve("state-beta");
    await alpha.write({ ...freshWorkspaceState(), projects: [] });
    const betaState = await beta.read();
    assert.deepEqual(betaState, freshWorkspaceState());
    assert.notEqual(alpha.path, beta.path);
    assert.equal(resolver.resolve("state-alpha"), alpha);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Postgres access registry locks mutations and concurrent handoff consumption", async () => {
  const database = new FakePostgresPool();
  const store = createPostgresAccessStore({
    pool: database as unknown as Pool,
    now: () => new Date("2026-08-12T12:00:00.000Z")
  });
  const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "studio", name: "Studio" });
  const issued = await store.createHandoff({
    providerSubject: "auth0|mike",
    workspaceId: workspace.id,
    sessionId: "root-session-postgres",
    destinationHost: "studio.kanban.cards"
  });
  const outcomes = await Promise.allSettled([
    store.consumeHandoff({ token: issued.token, destinationHost: "studio.kanban.cards" }),
    store.consumeHandoff({ token: issued.token, destinationHost: "studio.kanban.cards" })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const revocations = await Promise.all([
    store.revokeSession("auth0|unknown", "root-session-unknown"),
    store.revokeSession("auth0|unknown", "root-session-unknown")
  ]);
  assert.deepEqual(revocations[1], revocations[0]);
  assert.equal((await store.read()).revokedSessions.length, 1);
  assert.equal(await store.isSessionRevoked("auth0|unknown", "root-session-unknown"), true);
  assert.ok(database.queries.some((query) => query.includes("FOR UPDATE")));
  assert.equal(database.queries.filter((query) => query.startsWith("CREATE TABLE")).length, 1);
  assert.equal(database.releaseCount, 6);
});

test("Postgres workspace resolver shares table readiness and isolates storage rows", async () => {
  const database = new FakeWorkspacePostgresPool();
  const resolver = createWorkspaceStoreResolver({ pool: database as unknown as Pool });
  const alpha = resolver.resolve("state-alpha");
  const beta = resolver.resolve("state-beta");
  const now = "2026-08-12T12:00:00.000Z";

  await alpha.write({
    schemaVersion: 2,
    projects: [{
      id: "project-alpha",
      name: "Alpha",
      description: "",
      columns: [{ id: "next", name: "Next", position: 0 }],
      cards: [],
      activity: [],
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    }],
    idempotencyRecords: []
  });

  assert.deepEqual(await beta.read(), freshWorkspaceState());
  assert.equal((await alpha.read()).projects[0].name, "Alpha");
  assert.equal(database.queries.filter((query) => query.startsWith("CREATE TABLE")).length, 1);
  assert.deepEqual([...database.states.keys()].sort(), ["state-alpha", "state-beta"]);
});

class FakePostgresPool {
  state: unknown;
  queries: string[] = [];
  releaseCount = 0;
  private transactionQueue: Promise<void> = Promise.resolve();

  async connect(): Promise<FakePostgresClient> {
    return new FakePostgresClient(this);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ state: unknown }> }> {
    return this.execute(sql, params);
  }

  async begin(): Promise<() => void> {
    let release!: () => void;
    const previous = this.transactionQueue;
    this.transactionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }

  async execute(sql: string, params: unknown[]): Promise<{ rows: Array<{ state: unknown }> }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (normalized.startsWith("CREATE TABLE") || normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT state")) {
      return { rows: this.state === undefined ? [] : [{ state: structuredClone(this.state) }] };
    }
    if (normalized.startsWith("INSERT INTO") && normalized.includes("DO NOTHING")) {
      if (this.state === undefined) this.state = parseJsonParam(params[1]);
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE")) {
      this.state = parseJsonParam(params[1]);
      return { rows: [] };
    }
    throw new Error(`Unexpected fake Postgres query: ${normalized}`);
  }
}

class FakePostgresClient {
  private releaseTransaction: (() => void) | null = null;

  constructor(private readonly database: FakePostgresPool) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ state: unknown }> }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN") this.releaseTransaction = await this.database.begin();
    try {
      return await this.database.execute(sql, params);
    } finally {
      if ((normalized === "COMMIT" || normalized === "ROLLBACK") && this.releaseTransaction) {
        this.releaseTransaction();
        this.releaseTransaction = null;
      }
    }
  }

  release(): void {
    this.database.releaseCount += 1;
  }
}

class FakeWorkspacePostgresPool {
  states = new Map<string, unknown>();
  queries: string[] = [];

  async connect(): Promise<FakeWorkspacePostgresClient> {
    return new FakeWorkspacePostgresClient(this);
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
    const storageId = String(params[0]);
    if (normalized.startsWith("SELECT state")) {
      const state = this.states.get(storageId);
      return { rows: state === undefined ? [] : [{ state: structuredClone(state) }] };
    }
    if (normalized.startsWith("INSERT INTO") && normalized.includes("DO NOTHING")) {
      if (!this.states.has(storageId)) this.states.set(storageId, parseJsonParam(params[1]));
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO") || normalized.startsWith("UPDATE")) {
      this.states.set(storageId, parseJsonParam(params[1]));
      return { rows: [] };
    }
    throw new Error(`Unexpected fake Workspace Postgres query: ${normalized}`);
  }
}

class FakeWorkspacePostgresClient {
  constructor(private readonly database: FakeWorkspacePostgresPool) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ state: unknown }> }> {
    return this.database.execute(sql, params);
  }

  release(): void {}
}

function parseJsonParam(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected a JSON state parameter.");
  return JSON.parse(value);
}
