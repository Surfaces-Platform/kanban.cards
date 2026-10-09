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
  createWorkspaceInRegistry,
  freshAccessRegistryState,
  normalizeAccessRegistry
} from "../src/access-store";
import type { AccessRegistryState, AccessStore } from "../src/access-store";
import { createWorkspaceStoreResolver, freshWorkspaceState } from "../src/state-store";

const MIKE_IDENTITY = {
  providerSubject: "user_mike123",
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
      { id: "owner-a", providerSubject: "user_same", email: "a@example.com", displayName: "A", createdAt: timestamp, updatedAt: timestamp },
      { id: "owner-b", providerSubject: "user_same", email: "b@example.com", displayName: "B", createdAt: timestamp, updatedAt: timestamp }
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
      { providerSubject: "user_unknown", sessionId: "session-one", revokedAt: timestamp },
      { providerSubject: "user_unknown", sessionId: "session-one", revokedAt: timestamp }
    ]
  }), /Duplicate revoked session/);
});

test("existing access registries default auth records without changing owners, Workspaces, or agent hashes", () => {
  const timestamp = "2026-08-12T12:00:00.000Z";
  const legacyState = {
    schemaVersion: 1,
    owners: [{ id: "owner-mike", ...MIKE_IDENTITY, createdAt: timestamp, updatedAt: timestamp }],
    workspaces: [{ id: "workspace-mike", slug: "mike", name: "Mike", storageId: "default", ownerIds: ["owner-mike"], createdAt: timestamp, updatedAt: timestamp }],
    handoffs: [],
    agentConnections: [{
      id: "agent-build", credentialHash: `sha256:${"1".repeat(64)}`, ownerId: "owner-mike", workspaceId: "workspace-mike",
      label: "Build bot", scopes: ["read", "write"], createdAt: timestamp, lastUsedAt: null, expiresAt: null, revokedAt: null
    }]
  };
  const normalized = normalizeAccessRegistry(legacyState);
  assert.deepEqual(normalized.owners, legacyState.owners);
  assert.deepEqual(normalized.workspaces, legacyState.workspaces);
  assert.deepEqual(normalized.agentConnections, legacyState.agentConnections);
  for (const field of ["passkeys", "authChallenges", "authSessions", "recoveryCodes", "authHandoffs", "authRateLimits"] as const) {
    assert.deepEqual(normalized[field], []);
  }
  assert.equal(normalized.setupConsumed, false);
  assert.deepEqual(normalizeAccessRegistry(freshAccessRegistryState()), freshAccessRegistryState());
});

test("auth registry validation rejects duplicate credentials, missing owners, and cross-owner session handoffs", () => {
  const state = freshAccessRegistryState();
  const workspace = createWorkspaceInRegistry(state, { ...MIKE_IDENTITY, slug: "mike", name: "Mike" }, "2026-08-12T12:00:00.000Z");
  addAuthRecords(state, workspace.ownerIds[0]);
  assert.deepEqual(normalizeAccessRegistry(state), state);

  const duplicate = structuredClone(state);
  duplicate.passkeys.push({ ...duplicate.passkeys[0] });
  assert.throws(() => normalizeAccessRegistry(duplicate), /Duplicate passkey credential id/);

  const unknownOwner = structuredClone(state);
  unknownOwner.authChallenges[0].ownerId = "owner-missing";
  assert.throws(() => normalizeAccessRegistry(unknownOwner), /Auth challenge.*missing owner/);

  const crossedHandoff = structuredClone(state);
  const other = createWorkspaceInRegistry(crossedHandoff, { providerSubject: "other", email: "", displayName: "Other", slug: "other", name: "Other" }, "2026-08-12T12:00:00.000Z");
  crossedHandoff.authHandoffs[0].ownerId = other.ownerIds[0];
  assert.throws(() => normalizeAccessRegistry(crossedHandoff), /not bound to its owner's session/);

  const invalidOrigin = structuredClone(state);
  invalidOrigin.authSessions[0].rootOrigin = "https://kanban.cards/board";
  assert.throws(() => normalizeAccessRegistry(invalidOrigin), /exact secure origin/);

  const unsafeCounter = structuredClone(state);
  unsafeCounter.passkeys[0].counter = -1;
  assert.throws(() => normalizeAccessRegistry(unsafeCounter), /nonnegative integer/);

  const invalidSetup = { ...state, setupConsumed: "false" };
  assert.throws(() => normalizeAccessRegistry(invalidSetup), /setupConsumed must be a boolean/);
});

test("internal owner IDs reuse the existing owner across Workspace, agent, and handoff operations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-access-owner-id-"));
  const store = createFileAccessStore(path.join(directory, "access.json"), { now: () => new Date("2026-08-12T12:00:00.000Z") });
  try {
    const legacy = await store.bindLegacyWorkspace({ ...MIKE_IDENTITY, slug: "mike", name: "Mike" });
    const ownerId = legacy.ownerIds[0];
    const workspace = await store.createWorkspace({ providerSubject: ownerId, email: "", displayName: "Mike", slug: "studio", name: "Studio" });
    const resolved = await store.resolveOwner(ownerId);
    assert.equal(resolved?.owner.providerSubject, MIKE_IDENTITY.providerSubject);
    assert.equal(resolved?.owner.email, MIKE_IDENTITY.email);
    assert.deepEqual(resolved, await store.resolveOwner(MIKE_IDENTITY.providerSubject));
    assert.deepEqual(await store.getOwnerByProviderSubject(ownerId), resolved?.owner);
    assert.deepEqual((await store.listWorkspacesForOwner(ownerId)).map((item) => item.id), [legacy.id, workspace.id]);
    assert.equal((await store.read()).owners.length, 1);

    const connection = await store.createAgentConnection({ providerSubject: ownerId, workspaceId: workspace.id, label: "ID-based bot", scopes: ["read"] });
    assert.equal((await store.listAgentConnections(ownerId, workspace.id))[0].id, connection.connection.id);
    assert.equal((await store.verifyAgentCredential(connection.credential)).owner.id, ownerId);
    await store.revokeAgentConnection(ownerId, workspace.id, connection.connection.id);
    await assert.rejects(store.verifyAgentCredential(connection.credential), (error: any) => error.code === "ACCESS_AGENT_REVOKED");

    const handoff = await store.createHandoff({ providerSubject: ownerId, workspaceId: workspace.id, sessionId: "session-by-id", destinationHost: "studio.kanban.cards" });
    assert.equal(handoff.ownerId, ownerId);
    await store.revokeSession(ownerId, "session-by-id");
    assert.equal(await store.isSessionRevoked(MIKE_IDENTITY.providerSubject, "session-by-id"), true);
    assert.equal(await store.isSessionRevoked(ownerId, "session-by-id"), true);
    await assert.rejects(store.consumeHandoff({ token: handoff.token, destinationHost: "studio.kanban.cards" }), (error: any) => error.code === "ACCESS_SESSION_REVOKED");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("concurrent Workspace creation enforces each owner's quota inside the shared transaction", async () => {
  const database = new FakePostgresPool();
  const store = createPostgresAccessStore({ pool: database as unknown as Pool });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => store.createWorkspace({
    ...MIKE_IDENTITY, slug: `quota-${index}`, name: `Quota ${index}`
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 10);
  const rejections = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejections.length, 2);
  for (const result of rejections) {
    assert.equal(result.reason.code, "ACCESS_FORBIDDEN");
    assert.match(result.reason.message, /10 Workspaces/);
  }
  const resolved = await store.resolveOwner(MIKE_IDENTITY.providerSubject);
  assert.equal(resolved?.workspaces.length, 10);
  await assert.rejects(store.authTransaction((state) => createWorkspaceInRegistry(state, {
    providerSubject: resolved!.owner.id, email: "", displayName: "Mike", slug: "quota-extra", name: "Extra"
  })), (error: any) => error.code === "ACCESS_FORBIDDEN");
  const anotherOwner = await store.createWorkspace({ providerSubject: "other-owner", email: "", displayName: "Other", slug: "other-quota", name: "Other" });
  assert.notEqual(anotherOwner.ownerIds[0], resolved?.owner.id);
});

test("concurrent API-key creation caps unrevoked keys per owner and Workspace and revocation frees a slot", async () => {
  const database = new FakePostgresPool();
  const store = createPostgresAccessStore({ pool: database as unknown as Pool });
  const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "key-quota", name: "Keys" });
  const input = { providerSubject: workspace.ownerIds[0], workspaceId: workspace.id, label: "Quota bot", scopes: ["read"] as const };
  const results = await Promise.allSettled(Array.from({ length: 52 }, (_, index) => store.createAgentConnection({ ...input, label: `Quota bot ${index}`, scopes: [...input.scopes] })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 50);
  const rejections = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejections.length, 2);
  for (const result of rejections) {
    assert.equal(result.reason.code, "ACCESS_FORBIDDEN");
    assert.match(result.reason.message, /50 unrevoked API keys/);
  }
  const keys = await store.listAgentConnections(workspace.ownerIds[0], workspace.id);
  await store.revokeAgentConnection(workspace.ownerIds[0], workspace.id, keys[0].id);
  await store.createAgentConnection({ ...input, scopes: [...input.scopes] });
  assert.equal((await store.listAgentConnections(workspace.ownerIds[0], workspace.id)).filter((key) => !key.revokedAt).length, 50);

  const secondWorkspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "other-keys", name: "Other keys" });
  await store.createAgentConnection({ ...input, workspaceId: secondWorkspace.id, scopes: [...input.scopes] });
  assert.equal((await store.listAgentConnections(workspace.ownerIds[0], secondWorkspace.id)).length, 1);
});

test("API-key issuance atomically rejects revoked, expired, stale, and foreign browser sessions", async () => {
  const database = new FakePostgresPool();
  const current = "2026-08-12T12:10:00.000Z";
  const store = createPostgresAccessStore({ pool: database as unknown as Pool, now: () => new Date(current) });
  const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "session-keys", name: "Keys" });
  const other = await store.createWorkspace({ providerSubject: "other", email: "", displayName: "Other", slug: "other-session", name: "Other" });
  await store.authTransaction((state) => {
    const common = { rootOrigin: "https://kanban.cards", createdAt: "2026-08-12T12:00:00.000Z", verifiedAt: current, revokedAt: null, expiresAt: "2026-08-12T13:00:00.000Z" };
    state.authSessions.push(
      { ...common, id: "fresh", ownerId: workspace.ownerIds[0] },
      { ...common, id: "expired", ownerId: workspace.ownerIds[0], expiresAt: current },
      { ...common, id: "stale", ownerId: workspace.ownerIds[0], verifiedAt: "2026-08-12T12:04:59.999Z" },
      { ...common, id: "foreign", ownerId: other.ownerIds[0] },
      { ...common, id: "family-revoked", ownerId: workspace.ownerIds[0] },
      { ...common, id: "id-family-revoked", ownerId: workspace.ownerIds[0] }
    );
  });
  const issue = (authSessionId: string) => store.createAgentConnection({ providerSubject: workspace.ownerIds[0], workspaceId: workspace.id, label: "Browser-issued", scopes: ["read"], authSessionId });
  await issue("fresh");
  await store.revokeSession(MIKE_IDENTITY.providerSubject, "family-revoked");
  await store.revokeSession(workspace.ownerIds[0], "id-family-revoked");
  for (const id of ["expired", "stale", "foreign", "missing", "family-revoked", "id-family-revoked"]) {
    await assert.rejects(issue(id), (error: any) => error.code === "ACCESS_FORBIDDEN");
  }
  const [revoked, issuance] = await Promise.allSettled([
    store.authTransaction((state) => { state.authSessions.find((session) => session.id === "fresh")!.revokedAt = current; }),
    issue("fresh")
  ]);
  assert.equal(revoked.status, "fulfilled");
  assert.equal(issuance.status, "rejected");
  if (issuance.status === "rejected") assert.equal(issuance.reason.code, "ACCESS_FORBIDDEN");
  assert.equal((await store.listAgentConnections(workspace.ownerIds[0], workspace.id)).length, 1);
  assert.equal((await store.read()).authRateLimits.find((limit) => limit.id.startsWith("agent-key-issuance:"))?.count, 1);
});

test("API-key create/revoke loops hit the durable owner-wide hourly rate limit and reset after expiry", async () => {
  const database = new FakePostgresPool();
  let current = new Date("2026-08-12T12:00:00.000Z");
  const options = { pool: database as unknown as Pool, now: () => current };
  const store = createPostgresAccessStore(options);
  const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "key-rate", name: "Keys" });
  const ownerId = workspace.ownerIds[0];
  const input = { providerSubject: ownerId, workspaceId: workspace.id, label: "Rotating bot", scopes: ["read"] as const };
  for (let index = 0; index < 100; index += 1) {
    const issued = await store.createAgentConnection({ ...input, scopes: [...input.scopes] });
    await store.revokeAgentConnection(ownerId, workspace.id, issued.connection.id);
  }
  const reopened = createPostgresAccessStore(options);
  const before = await reopened.read();
  assert.equal(before.authRateLimits[0].count, 100);
  assert.equal(before.authRateLimits[0].resetAt, "2026-08-12T13:00:00.000Z");
  await assert.rejects(reopened.createAgentConnection({ ...input, scopes: [...input.scopes] }), (error: any) => {
    assert.equal(error.code, "ACCESS_RATE_LIMITED");
    assert.match(error.message, /Try again after 2026-08-12T13:00:00.000Z/);
    return true;
  });
  const otherWorkspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "key-rate-other", name: "Other" });
  await assert.rejects(reopened.createAgentConnection({ ...input, workspaceId: otherWorkspace.id, scopes: [...input.scopes] }), (error: any) => error.code === "ACCESS_RATE_LIMITED");
  assert.equal((await reopened.read()).authRateLimits[0].count, 100);
  assert.equal((await reopened.read()).agentConnections.length, 100);

  current = new Date("2026-08-12T13:00:00.000Z");
  await reopened.createAgentConnection({ ...input, scopes: [...input.scopes] });
  const reset = await store.read();
  assert.equal(reset.authRateLimits.length, 1);
  assert.equal(reset.authRateLimits[0].count, 1);
  assert.equal(reset.authRateLimits[0].resetAt, "2026-08-12T14:00:00.000Z");
});

for (const kind of ["file", "postgres"] as const) {
  test(`${kind} auth transactions persist new owners and credentials together and serialize setup consumption`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `kanban-auth-transaction-${kind}-`));
    const dataPath = path.join(directory, "access.json");
    const database = new FakePostgresPool();
    const open = (): AccessStore => kind === "file"
      ? createFileAccessStore(dataPath)
      : createPostgresAccessStore({ pool: database as unknown as Pool });
    const store = open();
    try {
      const ownerId = await store.authTransaction((state) => {
        const workspace = createWorkspaceInRegistry(state, { providerSubject: "passkey-owner", email: "", displayName: "New owner", slug: "private", name: "Private" }, "2026-08-12T12:00:00.000Z");
        const id = workspace.ownerIds[0];
        addAuthRecords(state, id);
        return id;
      });
      const reopened = open();
      const saved = await reopened.read();
      assert.equal(saved.owners[0].id, ownerId);
      assert.equal(saved.owners[0].email, "");
      assert.equal(saved.workspaces[0].ownerIds[0], ownerId);
      assert.equal(saved.passkeys[0].ownerId, ownerId);
      assert.equal(saved.authChallenges[0].ownerId, ownerId);
      assert.equal(saved.authSessions[0].ownerId, ownerId);
      assert.equal(saved.authHandoffs[0].sessionId, saved.authSessions[0].id);
      assert.equal(saved.recoveryCodes[0].ownerId, ownerId);
      assert.deepEqual(saved.authRateLimits, [{ id: "signup:browser", count: 1, resetAt: "2026-08-12T12:05:00.000Z" }]);

      const consumeSetup = () => store.authTransaction((state) => {
        if (state.setupConsumed) throw new Error("Setup is already consumed.");
        state.setupConsumed = true;
        state.passkeys[0].counter += 1;
        return state.passkeys[0].counter;
      });
      const results = await Promise.allSettled([consumeSetup(), consumeSetup()]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal((await reopened.read()).setupConsumed, true);
      assert.equal((await reopened.read()).passkeys[0].counter, 1);

      const beforeFailedTransaction = await store.read();
      await assert.rejects(store.authTransaction((state) => {
        state.owners[0].displayName = "Discard this change";
        state.passkeys[0].ownerId = "owner-missing";
      }), /Passkey.*missing owner/);
      assert.deepEqual(await reopened.read(), beforeFailedTransaction);

      await assert.rejects(store.authTransaction((state) => {
        state.recoveryCodes[0].consumedAt = "2026-08-12T12:01:00.000Z";
        throw new Error("Abort recovery.");
      }), /Abort recovery/);
      assert.deepEqual(await reopened.read(), beforeFailedTransaction);

      await assert.rejects(store.authTransaction(async (state) => {
        state.passkeys[0].revokedAt = "2026-08-12T12:01:00.000Z";
      }), /callbacks must be synchronous/);
      assert.deepEqual(await reopened.read(), beforeFailedTransaction);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

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
    assert.deepEqual((await store.listWorkspacesForOwner("user_mike123")).map((workspace) => workspace.slug), ["mike", "studio"]);
    const resolvedOwner = await store.resolveOwner("user_mike123");
    assert.deepEqual(resolvedOwner?.workspaces.map((workspace) => workspace.slug), ["mike", "studio"]);
    assert.equal(resolvedOwner?.owner.email, "mike.updated@example.com");
    assert.equal(resolvedOwner?.owner.displayName, "Michael Long");
    assert.equal(resolvedOwner?.owner.createdAt, "2026-08-12T12:00:00.000Z");
    assert.equal(resolvedOwner?.owner.updatedAt, "2026-08-12T12:01:00.000Z");
    assert.equal(await store.resolveOwner("user_unknown"), null);
    assert.equal((await store.getWorkspaceById(newWorkspace.id))?.slug, "studio");
    assert.equal((await store.getWorkspaceBySlug("STUDIO"))?.id, newWorkspace.id);
    assert.deepEqual(await store.listWorkspacesForOwner("user_unknown"), []);

    await assert.rejects(
      store.bindLegacyWorkspace({
        providerSubject: "user_other",
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

test("agent connections persist only a strong hash and enforce expiry and durable revocation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-agent-connection-"));
  const dataPath = path.join(directory, "access.json");
  let clock = new Date("2026-08-12T12:00:00.000Z");
  const store = createFileAccessStore(dataPath, { now: () => clock });
  try {
    const workspace = await store.createWorkspace({ ...MIKE_IDENTITY, slug: "agents", name: "Agents" });
    const issued = await store.createAgentConnection({ providerSubject: MIKE_IDENTITY.providerSubject, workspaceId: workspace.id, label: "Build bot", scopes: ["read", "write"], expiresAt: "2026-08-12T13:00:00.000Z" });
    assert.match(issued.credential, /^kac_agent-/);
    const storedText = await fs.readFile(dataPath, "utf8");
    assert.doesNotMatch(storedText, new RegExp(issued.credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(storedText, /"credentialHash": "sha256:[a-f0-9]{64}"/);
    assert.equal((await store.verifyAgentCredential(issued.credential)).connection.label, "Build bot");
    assert.equal((await store.listAgentConnections(MIKE_IDENTITY.providerSubject, workspace.id))[0].lastUsedAt, null);
    await assert.rejects(store.authorizeAgentCredential({ credential: issued.credential, workspaceId: "workspace-wrong", requiredScope: "read" }), (error: any) => error.code === "ACCESS_AGENT_WORKSPACE_MISMATCH");
    assert.equal((await store.listAgentConnections(MIKE_IDENTITY.providerSubject, workspace.id))[0].lastUsedAt, null);
    await store.authorizeAgentCredential({ credential: issued.credential, workspaceId: workspace.id, requiredScope: "write" });
    assert.equal((await store.listAgentConnections(MIKE_IDENTITY.providerSubject, workspace.id))[0].lastUsedAt, clock.toISOString());
    await store.revokeAgentConnection(MIKE_IDENTITY.providerSubject, workspace.id, issued.connection.id);
    await assert.rejects(store.verifyAgentCredential(issued.credential), (error: any) => error.code === "ACCESS_AGENT_REVOKED");
    const reopened = createFileAccessStore(dataPath, { now: () => clock });
    await assert.rejects(reopened.verifyAgentCredential(issued.credential), (error: any) => error.code === "ACCESS_AGENT_REVOKED");

    clock = new Date("2026-08-12T14:00:00.000Z");
    const expiring = await reopened.createAgentConnection({ providerSubject: MIKE_IDENTITY.providerSubject, workspaceId: workspace.id, label: "Expired bot", scopes: ["read"], expiresAt: "2026-08-12T15:00:00.000Z" });
    clock = new Date("2026-08-12T14:01:00.000Z");
    await assert.rejects(reopened.authorizeAgentCredential({ credential: expiring.credential, workspaceId: workspace.id, requiredScope: "write" }), (error: any) => error.code === "ACCESS_AGENT_SCOPE_MISSING");
    assert.equal((await reopened.listAgentConnections(MIKE_IDENTITY.providerSubject, workspace.id)).find((connection) => connection.id === expiring.connection.id)?.lastUsedAt, null);
    clock = new Date("2026-08-12T15:00:00.000Z");
    await assert.rejects(reopened.verifyAgentCredential(expiring.credential), (error: any) => error.code === "ACCESS_AGENT_EXPIRED");
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
    assert.equal(await store.isSessionRevoked("user_notadmitted", "root-session-unknown"), false);
    const [first, concurrentReplay] = await Promise.all([
      store.revokeSession("user_notadmitted", "root-session-unknown"),
      store.revokeSession("user_notadmitted", "root-session-unknown")
    ]);
    assert.deepEqual(concurrentReplay, first);
    assert.equal(first.revokedAt, "2026-08-12T12:00:00.000Z");
    assert.equal(await store.isSessionRevoked("user_notadmitted", "root-session-unknown"), true);
    assert.equal(await store.resolveOwner("user_notadmitted"), null);

    clock = new Date("2026-08-12T12:01:00.000Z");
    assert.deepEqual(await store.revokeSession("user_notadmitted", "root-session-unknown"), first);
    assert.equal((await store.read()).revokedSessions.length, 1);

    const reopened = createFileAccessStore(dataPath);
    assert.equal(await reopened.isSessionRevoked("user_notadmitted", "root-session-unknown"), true);
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
      providerSubject: "user_mike123",
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
      providerSubject: "user_mike123",
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
    providerSubject: "user_mike123",
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
    store.revokeSession("user_unknown", "root-session-unknown"),
    store.revokeSession("user_unknown", "root-session-unknown")
  ]);
  assert.deepEqual(revocations[1], revocations[0]);
  assert.equal((await store.read()).revokedSessions.length, 1);
  assert.equal(await store.isSessionRevoked("user_unknown", "root-session-unknown"), true);
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

function addAuthRecords(state: AccessRegistryState, ownerId: string): void {
  const createdAt = "2026-08-12T12:00:00.000Z";
  const expiresAt = "2026-08-12T12:05:00.000Z";
  const browserHash = `sha256:${"2".repeat(64)}`;
  state.passkeys.push({ id: "credential-test", ownerId, publicKey: "AQID", counter: 0, transports: ["internal"], createdAt, lastUsedAt: null, revokedAt: null });
  state.authChallenges.push({
    id: "challenge-test", challenge: "test-challenge", browserHash, purpose: "register", ownerId,
    rootOrigin: "https://kanban.cards", expiresAt, data: { action: "register", nested: { attempt: 1 }, options: ["passkey", null] }
  });
  state.authSessions.push({ id: "session-test", ownerId, rootOrigin: "https://kanban.cards", createdAt, expiresAt, revokedAt: null, verifiedAt: createdAt });
  state.recoveryCodes.push({ ownerId, codeHash: `sha256:${"3".repeat(64)}`, createdAt, consumedAt: null });
  state.authHandoffs.push({ id: "handoff-test", tokenHash: `sha256:${"4".repeat(64)}`, browserHash, ownerId, sessionId: "session-test", destinationOrigin: "https://kanban.cards", expiresAt, consumedAt: null });
  state.authRateLimits.push({ id: "signup:browser", count: 1, resetAt: expiresAt });
}
