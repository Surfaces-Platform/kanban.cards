import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { createFileAccessStore, normalizeAccessRegistry } from "../src/access-store";
import { createNativeAuthRouter } from "../src/native-auth";
import { getPasskeyConfig, hashSecret } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const RP = "auth.kanban.cards";
const ROOT = "https://kanban.cards";
const config = getPasskeyConfig({ SESSION_SECRET: "native-onboarding-test-secret-at-least-32-bytes" });

async function fixture(run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const h = await harness();
  try { await run(h); }
  finally {
    await new Promise<void>((resolve, reject) => h.server.close(error => error ? reject(error) : resolve()));
    await fs.rm(h.directory, { recursive: true, force: true });
  }
}
async function harness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-native-onboarding-"));
  const dataPath = path.join(directory, "access.json");
  let clock = new Date("2026-10-21T12:00:00.000Z");
  const store = createFileAccessStore(dataPath, { now: () => clock });
  const app = express();
  app.use(express.json());
  app.use("/api/native-auth", createNativeAuthRouter({ config, accessStore: store, now: () => clock }));
  const workspaceStoreResolver = createWorkspaceStoreResolver({ dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "workspaces") });
  app.use(createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: config, accessStore: store,
    workspaceStoreResolver, dataPath: path.join(directory, "default.json"), requireDatabase: false, trustForwardedHost: true }));
  app.use(((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message })) as ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-auth`;
  async function request(route: string, body?: unknown, token?: string, method = "POST", headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  async function resource(host: string, route: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST", extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base.replace("/api/native-auth", "") + route, { method, headers: {
      Host: host, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https", Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  async function registration(challenge: string, overrides: { origin?: string; rpId?: string; flags?: number; resident?: boolean } = {}) {
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const { isoCBOR } = await import("@simplewebauthn/server/helpers");
    const key = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Uint8Array.from(Buffer.from(jwk.x!, "base64url"))], [-3, Uint8Array.from(Buffer.from(jwk.y!, "base64url"))]
    ]));
    const idBytes = crypto.randomBytes(32); const id = idBytes.toString("base64url");
    const length = Buffer.alloc(2); length.writeUInt16BE(idBytes.length);
    const authData = Buffer.concat([crypto.createHash("sha256").update(overrides.rpId || RP).digest(),
      Buffer.from([overrides.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, idBytes, key]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", origin: overrides.origin || `https://${RP}`, challenge, crossOrigin: false }));
    const attestationObject = Buffer.from(isoCBOR.encode(new Map<string | number, Parameters<typeof isoCBOR.encode>[0]>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))).toString("base64url");
    return { pair, credential: { id, rawId: id, type: "public-key", clientExtensionResults: { credProps: { rk: overrides.resident ?? true } },
      response: { clientDataJSON: clientData.toString("base64url"), attestationObject, transports: ["internal"] } } };
  }
  async function signup() {
    const challenge = await request("/registration/challenge", { displayName: "Simulator owner", email: "owner@example.test" });
    assert.equal(challenge.status, 200);
    const key = await registration(challenge.data.challenge);
    const body = { challengeId: challenge.data.challengeId, ceremonyToken: challenge.data.ceremonyToken, credential: key.credential };
    const result = await request("/registration/verify", body);
    assert.equal(result.status, 200);
    return { ...result.data, key, body, challenge: challenge.data };
  }
  async function signin(ownerId: string, key: Awaited<ReturnType<typeof registration>>) {
    const challenge = await request("/challenge", {});
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", origin: `https://${RP}`, challenge: challenge.data.challenge, crossOrigin: false }));
    const authenticatorData = Buffer.concat([crypto.createHash("sha256").update(RP).digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
    const signature = crypto.sign("sha256", Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientData).digest()]), key.pair.privateKey);
    const response = { id: key.credential.id, rawId: key.credential.id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: clientData.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: signature.toString("base64url"), userHandle: Buffer.from(ownerId).toString("base64url")
    } };
    const result = await request("/verify", { challengeId: challenge.data.challengeId, ceremonyToken: challenge.data.ceremonyToken, response });
    assert.equal(result.status, 200);
    return result.data;
  }
  return { directory, dataPath, store, server, request, resource, registration, signup, signin,
    time: () => clock, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); } };
}

test("native registration verifies a real resident passkey and concurrent retries return one owner and session", async () => fixture(async h => {
  const challenge = await h.request("/registration/challenge", { displayName: "First owner" });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.data.relyingPartyIdentifier, RP);
  const ownerId = Buffer.from(challenge.data.userId, "base64url").toString();
  assert.match(ownerId, /^owner-/);
  assert.equal((await h.store.read()).owners.length, 0);
  const key = await h.registration(challenge.data.challenge);
  const body = { challengeId: challenge.data.challengeId, ceremonyToken: challenge.data.ceremonyToken, credential: key.credential };
  const concurrent = await Promise.all([1, 2].map(() => h.request("/registration/verify", body)));
  assert.deepEqual(concurrent.map(result => result.status), [200, 200]);
  assert.equal(concurrent[0].data.owner.id, ownerId);
  assert.equal(concurrent[0].data.token, concurrent[1].data.token);
  const state = await h.store.read();
  assert.equal(state.owners.length, 1); assert.equal(state.passkeys.length, 1); assert.equal(state.nativeSessions.length, 1);
  assert.equal(state.nativeSessions[0].verifiedAt, h.time().toISOString());
  assert.equal(state.workspaces.length, 0);
  const stored = await fs.readFile(h.dataPath, "utf8");
  assert.ok(!stored.includes(concurrent[0].data.token)); assert.ok(!stored.includes(challenge.data.ceremonyToken));
  const changed = structuredClone(body); changed.credential.response.transports = ["hybrid"];
  assert.equal((await h.request("/registration/verify", changed)).status, 409);
  assert.equal((await h.request("/registration/verify", { ...body, ceremonyToken: crypto.randomBytes(32).toString("base64url") })).status, 401);
  const reloaded = createFileAccessStore(h.dataPath);
  assert.equal((await reloaded.read()).owners.length, 1);
  h.advance(5 * 60_000 + 1);
  assert.equal((await h.request("/registration/verify", body)).status, 401);
}));

test("native registration rejects wrong origin, RP, missing UV, nonresident output, and owner selectors", async () => fixture(async h => {
  for (const override of [{ origin: "https://other.example.test" }, { rpId: "other.example.test" }, { flags: 0x41 }, { resident: false }]) {
    const challenge = await h.request("/registration/challenge", { displayName: "Not registered" });
    const key = await h.registration(challenge.data.challenge, override);
    const response = await h.request("/registration/verify", { challengeId: challenge.data.challengeId, ceremonyToken: challenge.data.ceremonyToken, credential: key.credential });
    assert.equal(response.status, 401);
  }
  assert.equal((await h.store.read()).owners.length, 0);
  assert.equal((await h.request("/registration/challenge", { displayName: "Owner", ownerId: "injected" })).status, 400);
  assert.equal((await h.request("/registration/challenge", { displayName: "Owner" }, undefined, "POST", { Cookie: "session=ambient" })).status, 403);
  assert.equal((await h.request("/registration/challenge", { displayName: "Owner" }, undefined, "POST", { Origin: ROOT })).status, 403);
}));

test("native device pairing binds one Workspace after fresh approval and only its device secret retrieves the key", async () => fixture(async h => {
  const account = await h.signup();
  const workspace = await h.store.createWorkspace({ providerSubject: account.owner.id, displayName: "Owner", email: "", name: "Test board", slug: "test-board" });
  const other = await h.store.createWorkspace({ providerSubject: "different-owner", displayName: "Other", email: "", name: "Other", slug: "other" });
  const started = await h.request("/agent-pairings", { workspaceId: workspace.id, label: "Codex simulator test" });
  assert.equal(started.status, 201);
  const { pairingId, deviceToken, userCode } = started.data;
  const poll = () => h.request("/agent-pairings/poll", { pairingId, deviceToken });
  assert.equal((await poll()).data.status, "pending");
  assert.equal((await h.request("/agent-pairings/inspect", { userCode }, account.token)).data.workspaceId, workspace.id);
  const foreignToken = `kcn_${crypto.randomBytes(32).toString("base64url")}`;
  await h.store.authTransaction(state => { state.nativeSessions.push({ id: "native-session-other", ownerId: other.ownerIds[0], credentialHash: hashSecret(foreignToken), rootOrigin: ROOT,
    createdAt: h.time().toISOString(), verifiedAt: h.time().toISOString(), expiresAt: new Date(h.time().getTime() + 3_600_000).toISOString(), revokedAt: null }); });
  assert.equal((await h.request("/agent-pairings/inspect", { userCode }, foreignToken)).status, 404);
  assert.equal((await h.request("/agent-pairings/approve", { userCode }, foreignToken)).status, 404);
  h.advance(6 * 60_000);
  assert.equal((await h.request("/agent-pairings/approve", { userCode }, account.token)).status, 403);
  const fresh = await h.signin(account.owner.id, account.key);
  const approvals = await Promise.all([1, 2].map(() => h.request("/agent-pairings/approve", { userCode }, fresh.token)));
  assert.deepEqual(approvals.map(value => value.status), [200, 200]);
  assert.equal(approvals[0].data.connection.id, approvals[1].data.connection.id);
  assert.equal(approvals[0].data.approved, true);
  assert.equal(approvals[0].data.connection.workspaceId, workspace.id);
  assert.deepEqual(approvals[0].data.connection.scopes, ["read", "write"]);
  assert.equal("credential" in approvals[0].data, false); assert.equal("credentialHash" in approvals[0].data.connection, false);
  const accepted = await poll();
  assert.equal(accepted.data.status, "approved");
  assert.equal(accepted.data.apiBaseUrl, "https://test-board.kanban.cards/api");
  assert.equal((await poll()).data.credential, accepted.data.credential);
  assert.equal((await h.request("/agent-pairings/poll", { pairingId, deviceToken: crypto.randomBytes(32).toString("base64url") })).status, 401);
  const stored = await fs.readFile(h.dataPath, "utf8");
  for (const secret of [deviceToken, userCode, accepted.data.credential]) assert.ok(!stored.includes(secret));
  assert.equal((await h.store.read()).agentConnections.length, 1);
  assert.equal((await h.store.authorizeAgentCredential({ credential: accepted.data.credential, workspaceId: workspace.id, requiredScope: "write" })).workspace.id, workspace.id);
  await assert.rejects(h.store.authorizeAgentCredential({ credential: accepted.data.credential, workspaceId: other.id, requiredScope: "read" }));
  const listed = await h.request(`/agent-connections?workspaceId=${workspace.id}`, undefined, fresh.token, "GET");
  assert.equal(listed.status, 200); assert.equal(listed.data.connections.length, 1);
  assert.equal((await h.request(`/agent-connections?workspaceId=${other.id}`, undefined, fresh.token, "GET")).status, 404);
  const connectionId = accepted.data.connection.id;
  assert.deepEqual((await h.request(`/agent-connections/${connectionId}?workspaceId=${workspace.id}`, undefined, fresh.token, "DELETE")).data, { revoked: true });
  assert.equal((await poll()).data.status, "denied");
  await assert.rejects(createFileAccessStore(h.dataPath).verifyAgentCredential(accepted.data.credential));
}));

test("native pairing expires, rejects selectors and ambient browser authority, and enforces issuance and start limits", async () => fixture(async h => {
  const account = await h.signup();
  const workspace = await h.store.createWorkspace({ providerSubject: account.owner.id, displayName: "Owner", email: "", name: "Limits", slug: "limits" });
  const body = { workspaceId: workspace.id, label: "Codex" };
  const first = await h.request("/agent-pairings", body);
  assert.equal((await h.request("/agent-pairings/approve", { userCode: first.data.userCode, workspaceId: workspace.id }, account.token)).status, 400);
  assert.equal((await h.request("/agent-pairings/approve", { userCode: first.data.userCode }, account.token, "POST", { Origin: ROOT })).status, 403);
  await h.store.authTransaction(state => { state.authRateLimits.push({ id: `agent-key-issuance:${crypto.createHash("sha256").update(account.owner.id).digest("hex")}`, count: 100, resetAt: new Date(h.time().getTime() + 3_600_000).toISOString() }); });
  assert.equal((await h.request("/agent-pairings/approve", { userCode: first.data.userCode }, account.token)).status, 429);
  assert.equal((await h.store.read()).agentConnections.length, 0);
  for (let index = 1; index < 20; index++) assert.equal((await h.request("/agent-pairings", body)).status, 201);
  assert.equal((await h.request("/agent-pairings", body)).status, 429);
  h.advance(10 * 60_000 + 1);
  assert.equal((await h.request("/agent-pairings/poll", { pairingId: first.data.pairingId, deviceToken: first.data.deviceToken })).data.status, "expired");
  const state = await h.store.read();
  const { nativeAgentPairings: _pairings, ...legacy } = state;
  assert.deepEqual(normalizeAccessRegistry(legacy).nativeAgentPairings, []);
  const bad = structuredClone(state); bad.nativeAgentPairings[0].deviceTokenHash = first.data.deviceToken;
  assert.throws(() => normalizeAccessRegistry(bad));
}));

test("new native account creates one Idea Workspace, approves an agent, reads its real Card, and revokes further writes", async () => fixture(async h => {
  const account = await h.signup();
  const originalInput = "  Build a tiny counter.\nKeep my exact first-project request.\n";
  const setup = { name: "Native setup acceptance", slug: "native-acceptance", initialProject: {
    name: "First counter", idea: { originalInput, brief: "", completionCriteria: "" }
  } };
  const create = () => h.resource("kanban.cards", "/api/workspaces", account.token, setup, "POST", { "Idempotency-Key": "native-first-workspace-acceptance" });
  const created = await create();
  assert.equal(created.status, 201);
  const repeated = await create();
  assert.equal(repeated.status, 201);
  assert.equal(repeated.data.workspace.id, created.data.workspace.id);
  assert.equal(repeated.data.project.id, created.data.project.id);
  assert.equal(created.data.project.idea.originalInput, originalInput);
  const workspaceId = created.data.workspace.id;
  const projectId = created.data.project.id;
  const host = "native-acceptance.kanban.cards";
  const inventory = await h.resource("kanban.cards", "/api/workspaces", account.token);
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.data.workspaces.map((value: { id: string }) => value.id), [workspaceId]);
  const start = await h.request("/agent-pairings", { workspaceId, label: "Codex first-project test" });
  assert.equal(start.status, 201);
  const approved = await h.request("/agent-pairings/approve", { userCode: start.data.userCode }, account.token);
  assert.equal(approved.status, 200);
  const poll = await h.request("/agent-pairings/poll", { pairingId: start.data.pairingId, deviceToken: start.data.deviceToken });
  assert.equal(poll.data.status, "approved");
  const agentToken = poll.data.credential;
  const agentSession = await h.resource(host, "/api/session", agentToken);
  assert.deepEqual(agentSession.data.scopes, ["read", "write"]);
  const agentProject = await h.resource(host, `/api/projects/${projectId}`, agentToken);
  assert.equal(agentProject.status, 200);
  assert.equal(agentProject.data.project.idea.originalInput, originalInput);
  const cardRequest = { title: "Implement the counter", body: "Acceptance request created through the approved agent connection.", externalKey: "first-project:counter", nextActor: "agent" };
  const cardWrite = await h.resource(host, `/api/projects/${projectId}/cards`, agentToken, cardRequest, "POST", { "Idempotency-Key": "native-first-card-acceptance" });
  assert.equal(cardWrite.status, 201);
  const nativeRead = await h.resource(host, `/api/projects/${projectId}`, account.token);
  assert.equal(nativeRead.status, 200);
  assert.equal(nativeRead.data.project.cards.length, 1);
  assert.equal(nativeRead.data.project.cards[0].id, cardWrite.data.card.id);
  assert.equal(nativeRead.data.project.cards[0].body, cardRequest.body);
  const saved = await createFileAccessStore(h.dataPath).read();
  assert.equal(saved.owners.length, 1); assert.equal(saved.workspaces.length, 1);
  assert.equal(saved.agentConnections.length, 1);
  const revoke = await h.request(`/agent-connections/${poll.data.connection.id}?workspaceId=${workspaceId}`, undefined, account.token, "DELETE");
  assert.equal(revoke.status, 200);
  const denied = await h.resource(host, `/api/projects/${projectId}/cards`, agentToken, { title: "Must not be written" });
  assert.equal(denied.status, 401);
  const finalRead = await h.resource(host, `/api/projects/${projectId}`, account.token);
  assert.equal(finalRead.status, 200); assert.equal(finalRead.data.project.cards.length, 1);
}));
