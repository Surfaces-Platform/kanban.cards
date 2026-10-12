import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";

import { createFileAccessStore, type NativeOwnerSession } from "../src/access-store";
import { createRootSessionCookie } from "../src/app-sessions";
import { createPasskeyRouter, getPasskeyConfig, hashSecret, type PasskeyRouterOptions } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createFileStateStore } from "../src/state-store";

const config = getPasskeyConfig({ SESSION_SECRET: "native-compatibility-secret-at-least-32-bytes" });
const ROOT = config.rootOrigins[0];

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-native-compatibility-"));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function seededRegistry(directory: string) {
  const dataPath = path.join(directory, "access.json");
  const store = createFileAccessStore(dataPath);
  const workspace = await store.createWorkspace({ providerSubject: "compat-owner", email: "owner@example.test", displayName: "Owner", slug: "first", name: "First" });
  const otherWorkspace = await store.createWorkspace({ providerSubject: "compat-other", email: "other@example.test", displayName: "Other", slug: "second", name: "Second" });
  const ownerId = workspace.ownerIds[0];
  const otherOwnerId = otherWorkspace.ownerIds[0];
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const nativeSession = (id: string, sessionOwner: string): NativeOwnerSession => ({
    id, ownerId: sessionOwner, credentialHash: hashSecret(`credential-for-${id}`), rootOrigin: ROOT,
    createdAt, expiresAt, revokedAt: null
  });
  const nativeSessions = [nativeSession("native-first", ownerId), nativeSession("native-second", ownerId), nativeSession("native-other", otherOwnerId)];
  const recoveryCode = `kcr_${ownerId}.${crypto.randomBytes(32).toString("base64url")}`;
  await store.authTransaction(state => {
    state.nativeSessions.push(...nativeSessions);
    state.authSessions.push({ id: "browser-first", ownerId, rootOrigin: ROOT, createdAt, expiresAt, verifiedAt: createdAt, revokedAt: null });
    state.passkeys.push({ id: "b2xkLWtleQ", ownerId, publicKey: "AQID", counter: 0, transports: ["internal"], createdAt, lastUsedAt: null, revokedAt: null });
    state.recoveryCodes.push({ ownerId, codeHash: hashSecret(recoveryCode), createdAt, consumedAt: null });
  });
  return { dataPath, store, ownerId, otherOwnerId, workspace, nativeSessions, recoveryCode };
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

test("compatibility release reads a legacy registry and persists browser changes without changing existing authority", async () => fixture(async directory => {
  const h = await seededRegistry(directory);
  const { nativeSessions: _nativeSessions, ...legacy } = await h.store.read();
  await fs.writeFile(h.dataPath, JSON.stringify(legacy));
  const reloaded = createFileAccessStore(h.dataPath);
  const before = await reloaded.read();
  assert.deepEqual(before.nativeSessions, []);
  assert.deepEqual(before.owners, legacy.owners);
  assert.deepEqual(before.workspaces, legacy.workspaces);
  assert.deepEqual(before.passkeys, legacy.passkeys);
  assert.deepEqual(before.authSessions, legacy.authSessions);
  await reloaded.authTransaction(state => { state.authSessions[0].verifiedAt = new Date().toISOString(); });
  const after = await createFileAccessStore(h.dataPath).read();
  assert.deepEqual(after.nativeSessions, []);
  assert.deepEqual(after.owners, legacy.owners);
  assert.deepEqual(after.workspaces, legacy.workspaces);
  assert.deepEqual(after.passkeys, legacy.passkeys);
  assert.equal(after.authSessions[0].id, legacy.authSessions[0].id);
  assert.equal(after.authSessions[0].expiresAt, legacy.authSessions[0].expiresAt);
  assert.equal(after.authSessions[0].revokedAt, null);
}));

test("compatibility browser writes preserve native credentials and browser settings revoke only the intended owner's sessions", async () => fixture(async directory => {
  const h = await seededRegistry(directory);
  const ceremony = { id: "native-ceremony", challenge: "native-challenge", browserHash: hashSecret("ceremony-token"), purpose: "native-signin", ownerId: null, rootOrigin: ROOT, expiresAt: new Date(Date.now() + 300_000).toISOString(), data: {} };
  await h.store.authTransaction(state => { state.authChallenges.push(ceremony); state.authSessions[0].verifiedAt = new Date().toISOString(); });
  const preserved = await createFileAccessStore(h.dataPath).read();
  assert.deepEqual(preserved.nativeSessions, h.nativeSessions);
  assert.deepEqual(preserved.authChallenges.find(challenge => challenge.id === ceremony.id), ceremony);
  const owner = preserved.owners.find(candidate => candidate.id === h.ownerId)!;
  const cookie = (await createRootSessionCookie({ providerSubject: owner.id, displayName: owner.displayName, email: owner.email, sessionId: "browser-first", rootOrigin: ROOT }, config.sessionSecret, true)).split(";")[0];
  const app = createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: config, accessStore: h.store, requireDatabase: false, trustForwardedHost: true, dataPath: path.join(directory, "workspace.json"), workspaceDirectory: path.join(directory, "workspaces") });
  const server = await listen(app);
  async function request(route: string, method = "GET") {
    return fetch(`${server.origin}${route}`, { method, headers: { Host: "kanban.cards", "X-Forwarded-Host": "kanban.cards", "X-Forwarded-Proto": "https", Cookie: cookie, ...(method === "DELETE" ? { Origin: ROOT } : {}) } });
  }
  try {
    const settings = await request("/api/access-settings");
    assert.equal(settings.status, 200);
    const listed = await settings.json() as { sessions: Array<{ id: string; current: boolean }> };
    assert.deepEqual(listed.sessions.map(session => session.id).sort(), ["browser-first", "native-first", "native-second"]);
    assert.equal(listed.sessions.find(session => session.id === "browser-first")?.current, true);
    assert.equal((await request("/api/sessions/native-other", "DELETE")).status, 404);
    assert.equal((await request("/api/sessions/native-first", "DELETE")).status, 204);
    const individuallyRevoked = await createFileAccessStore(h.dataPath).read();
    assert.ok(individuallyRevoked.nativeSessions.find(session => session.id === "native-first")!.revokedAt);
    assert.equal(individuallyRevoked.nativeSessions.find(session => session.id === "native-second")!.revokedAt, null);
    assert.equal(individuallyRevoked.nativeSessions.find(session => session.id === "native-other")!.revokedAt, null);
    assert.equal(individuallyRevoked.authSessions[0].revokedAt, null);
    assert.equal((await request("/api/sessions/all", "DELETE")).status, 204);
    const ended = await createFileAccessStore(h.dataPath).read();
    assert.equal(ended.nativeSessions.length, 3);
    assert.ok(ended.nativeSessions.filter(session => session.ownerId === h.ownerId).every(session => session.revokedAt));
    assert.equal(ended.nativeSessions.find(session => session.ownerId === h.otherOwnerId)!.revokedAt, null);
    assert.ok(ended.authSessions[0].revokedAt);
    assert.deepEqual(ended.workspaces, preserved.workspaces);
  } finally { await server.close(); }
}));

test("compatibility browser recovery retains native records and revokes them only after replacement enrollment succeeds", async () => fixture(async directory => {
  const h = await seededRegistry(directory);
  const before = await h.store.read();
  const challenge = crypto.randomBytes(32).toString("base64url");
  const webauthn: NonNullable<PasskeyRouterOptions["webauthn"]> = {
    generateRegistrationOptions: async () => ({ challenge }) as never,
    verifyRegistrationResponse: async options => {
      const response = options.response as unknown as { id: string; testChallenge: string };
      assert.equal(options.expectedRPID, config.rpId);
      assert.equal(options.expectedOrigin, config.authOrigin);
      assert.equal(options.requireUserVerification, true);
      if (response.testChallenge !== options.expectedChallenge) throw new Error("Wrong challenge");
      return { verified: true, registrationInfo: { credential: { id: response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0, transports: ["internal"] } } } as never;
    },
    generateAuthenticationOptions: async () => { throw new Error("Recovery must enroll a replacement"); },
    verifyAuthenticationResponse: async () => { throw new Error("Recovery must enroll a replacement"); }
  };
  const app = express();
  app.use(express.json());
  app.use("/api/passkeys", createPasskeyRouter({ config, accessStore: h.store, webauthn }));
  app.use(((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message })) as ErrorRequestHandler);
  const server = await listen(app);
  const jar = new Map<string, string>();
  async function request(endpoint: string, body: unknown, origin = config.authOrigin) {
    const response = await fetch(`${server.origin}/api/passkeys/${endpoint}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Origin: origin, Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }, body: JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const equals = pair.indexOf("=");
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() as Record<string, any> : {} };
  }
  try {
    const intentToken = crypto.randomBytes(32).toString("base64url");
    const browserNonce = crypto.randomBytes(32).toString("base64url");
    await h.store.authTransaction(state => { state.authChallenges.push({ id: crypto.randomUUID(), challenge: hashSecret(intentToken), browserHash: hashSecret(browserNonce), purpose: "authorize", ownerId: null, rootOrigin: ROOT, expiresAt: new Date(Date.now() + 300_000).toISOString(), data: { mode: "recover" } }); });
    assert.equal((await request("start", { intentToken, browserNonce, rootOrigin: ROOT }, ROOT)).status, 303);
    const first = await request("options", { recoveryCode: h.recoveryCode });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await request("verify", { challengeId: first.body.challengeId, response: { id: "bmV3LWtleQ", testChallenge: "wrong" } })).status, 401);
    assert.deepEqual((await createFileAccessStore(h.dataPath).read()).nativeSessions, h.nativeSessions);
    const next = await request("options", { recoveryCode: h.recoveryCode });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const recovered = await request("verify", { challengeId: next.body.challengeId, response: { id: "bmV3LWtleQ", testChallenge: challenge } });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const after = await createFileAccessStore(h.dataPath).read();
    assert.equal(after.nativeSessions.length, 3);
    assert.ok(after.nativeSessions.filter(session => session.ownerId === h.ownerId).every(session => session.revokedAt));
    assert.equal(after.nativeSessions.find(session => session.ownerId === h.otherOwnerId)!.revokedAt, null);
    assert.ok(after.authSessions.find(session => session.id === "browser-first")!.revokedAt);
    assert.ok(after.passkeys.find(key => key.id === "b2xkLWtleQ")!.revokedAt);
    assert.equal(after.passkeys.find(key => key.id === "bmV3LWtleQ")!.revokedAt, null);
    assert.ok(after.recoveryCodes.find(code => code.codeHash === hashSecret(h.recoveryCode))!.consumedAt);
    assert.deepEqual(after.owners, before.owners);
    assert.deepEqual(after.workspaces, before.workspaces);
  } finally { await server.close(); }
}));

test("compatibility shared Workspace reads and writes retain native, browser, and agent Activity together", async () => fixture(async directory => {
  const dataPath = path.join(directory, "workspace.json");
  const timestamp = new Date().toISOString();
  const activity = [
    { id: "activity-native", action: "project.updated", actor: { channel: "native", label: "Owner" }, summary: "Owner updated Project from iPhone.", projectId: "project-one", createdAt: timestamp },
    { id: "activity-web", action: "project.updated", actor: { channel: "web", label: "Owner" }, summary: "Owner updated Project from browser.", projectId: "project-one", createdAt: timestamp },
    { id: "activity-agent", action: "project.updated", actor: { channel: "api", label: "Agent", agentConnectionId: "agent-one" }, summary: "Agent updated Project.", projectId: "project-one", createdAt: timestamp }
  ];
  const stored = { schemaVersion: 2, projects: [{ id: "project-one", name: "Shared Project", description: "Original", columns: [{ id: "next", name: "Next", position: 0 }], cards: [], activity, revision: 3, createdAt: timestamp, updatedAt: timestamp }], idempotencyRecords: [] };
  const raw = JSON.stringify(stored);
  await fs.writeFile(dataPath, raw);
  const store = createFileStateStore(dataPath);
  const read = await store.readExisting();
  assert.deepEqual(read!.projects[0].activity, activity);
  assert.equal(await fs.readFile(dataPath, "utf8"), raw, "reading compatible data must not rewrite it");
  await store.update(state => { state.projects[0].description = "Updated from browser"; state.projects[0].revision++; });
  const reloaded = await createFileStateStore(dataPath).readExisting();
  assert.deepEqual(reloaded!.projects[0].activity, activity);
  assert.equal(reloaded!.projects[0].description, "Updated from browser");
  assert.equal(reloaded!.projects[0].revision, 4);
  assert.deepEqual(JSON.parse(await fs.readFile(dataPath, "utf8")).projects[0].activity, activity);
}));
