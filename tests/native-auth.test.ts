import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileAccessStore, normalizeAccessRegistry } from "../src/access-store";
import { createRootSessionCookie, createTenantSessionCookie } from "../src/app-sessions";
import { authorizeNativeCredential, NATIVE_SESSION_TTL_SECONDS } from "../src/native-auth";
import { getPasskeyConfig, hashSecret } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const ROOT = "https://kanban.cards";
const AUTH_HOST = "auth.kanban.cards";
const AUTH = `https://${AUTH_HOST}`;
const SECRET = "native-session-test-secret-at-least-32-bytes";
const APP_ID = "ABCDEFGHIJ.test.kanban.ios";

test("session reports only verified AgentConnection scopes and never infers writes from owner or read-only sessions", async () => fixture(async h => {
  const reader = await h.accessStore.createAgentConnection({ providerSubject: h.owner.id, workspaceId: h.first.id, label: "Reader", scopes: ["read"] });
  const writer = await h.accessStore.createAgentConnection({ providerSubject: h.owner.id, workspaceId: h.first.id, label: "Reader and writer", scopes: ["read", "write"] });
  const writeOnly = await h.accessStore.createAgentConnection({ providerSubject: h.owner.id, workspaceId: h.first.id, label: "Write only", scopes: ["write"] });
  const readSession = await h.request("first.kanban.cards", "/api/session", { token: reader.credential, headers: { "X-Kanban-Scopes": "read,write" } });
  assert.equal(readSession.status, 200);
  assert.deepEqual(readSession.data.scopes, ["read"]);
  assert.deepEqual((await h.request("first.kanban.cards", "/api/session", { token: writer.credential })).data.scopes, ["read", "write"]);
  assert.equal((await h.request("first.kanban.cards", "/api/session", { token: writeOnly.credential })).status, 403);
  const native = await h.signin();
  for (const options of [{ token: native.token }, { cookie: h.tenantCookie }, {}]) {
    const result = await h.request("first.kanban.cards", "/api/session", options);
    assert.equal(result.status, 200);
    assert.equal("scopes" in result.data, false);
  }
}));

async function fixture(run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>, appIds = [APP_ID]) {
  const h = await harness(appIds);
  try { await run(h); } finally { await new Promise<void>((resolve, reject) => h.server.close(e => e ? reject(e) : resolve())); await fs.rm(h.directory, { recursive: true, force: true }); }
}

async function harness(appIds: string[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-native-auth-"));
  const dataPath = path.join(directory, "access.json");
  const accessStore = createFileAccessStore(dataPath);
  const first = await accessStore.createWorkspace({ providerSubject: "native-test-owner", email: "owner@example.test", displayName: "Native owner", slug: "first", name: "First" });
  const second = await accessStore.createWorkspace({ providerSubject: "different-test-owner", email: "", displayName: "Other owner", slug: "second", name: "Second" });
  const owner = (await accessStore.resolveOwner("native-test-owner"))!.owner;
  const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const { isoCBOR } = await import("@simplewebauthn/server/helpers");
  const publicKey = Buffer.from(isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Uint8Array.from(Buffer.from(jwk.x!, "base64url"))], [-3, Uint8Array.from(Buffer.from(jwk.y!, "base64url"))]]))).toString("base64url");
  const credentialId = crypto.randomBytes(32).toString("base64url");
  const timestamp = new Date().toISOString();
  await accessStore.authTransaction(s => {
    s.passkeys.push({ id: credentialId, ownerId: owner.id, publicKey, counter: 0, transports: ["internal"], createdAt: timestamp, lastUsedAt: null, revokedAt: null });
    s.authSessions.push({ id: "browser-session", ownerId: owner.id, rootOrigin: ROOT, createdAt: timestamp, verifiedAt: timestamp, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), revokedAt: null });
  });
  const identity = { providerSubject: owner.id, email: owner.email, displayName: owner.displayName, sessionId: "browser-session", rootOrigin: ROOT };
  const rootCookie = (await createRootSessionCookie(identity, SECRET, true)).split(";")[0];
  const tenantCookie = (await createTenantSessionCookie({ ...identity, workspaceId: first.id, tenantOrigin: "https://first.kanban.cards" }, SECRET, true)).split(";")[0];
  const resolver = createWorkspaceStoreResolver({ dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "workspaces") });
  const config = getPasskeyConfig({ SESSION_SECRET: SECRET, KANBAN_CARDS_IOS_APP_IDS: appIds.join(",") });
  const server = createServer(createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: config, accessStore, workspaceStoreResolver: resolver, requireDatabase: false, trustForwardedHost: true, dataPath: path.join(directory, "default.json") }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(host: string, route: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { Host: host, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https", ...options.headers };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    const response = await fetch(`${base}${route}`, { method: options.method || "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
    const text = await response.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function challenge() {
    const result = await request(AUTH_HOST, "/api/native-auth/challenge", { method: "POST", body: {} });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data as { challengeId: string; ceremonyToken: string; challenge: string; relyingPartyIdentifier: string; expiresAt: string };
  }
  function assertion(challengeValue: string, overrides: { origin?: string; rpId?: string; userHandle?: string; flags?: number; challenge?: string; crossOrigin?: boolean; topOrigin?: string; type?: string; corruptSignature?: boolean } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: overrides.type || "webauthn.get", origin: overrides.origin || AUTH, challenge: overrides.challenge || challengeValue, crossOrigin: overrides.crossOrigin || false, ...(overrides.topOrigin ? { topOrigin: overrides.topOrigin } : {}) }));
    const authData = Buffer.concat([crypto.createHash("sha256").update(overrides.rpId || AUTH_HOST).digest(), Buffer.from([overrides.flags ?? 0x05]), Buffer.alloc(4)]);
    const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), keyPair.privateKey);
    if (overrides.corruptSignature) signature[signature.length - 1] ^= 1;
    return { id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {}, response: { authenticatorData: authData.toString("base64url"), clientDataJSON: clientData.toString("base64url"), signature: signature.toString("base64url"), userHandle: overrides.userHandle || Buffer.from(owner.id).toString("base64url") } };
  }
  async function signin() {
    const ceremony = await challenge();
    const response = assertion(ceremony.challenge);
    const result = await request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { challengeId: ceremony.challengeId, ceremonyToken: ceremony.ceremonyToken, response } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { ...result.data, ceremony, response } as { token: string; expiresAt: string; rootUrl: string; owner: { id: string }; ceremony: typeof ceremony; response: typeof response };
  }
  return { directory, dataPath, accessStore, resolver, owner, first, second, server, request, challenge, assertion, signin, rootCookie, tenantCookie };
}

test("native passkeys verify real signatures, issue only hashed fixed-expiry owner credentials, and share tenant data with browser and agent", async () => fixture(async h => {
  const before = await h.accessStore.read();
  const signin = await h.signin();
  assert.match(signin.token, /^kcn_[A-Za-z0-9_-]{43}$/);
  assert.equal(signin.owner.id, h.owner.id);
  assert.equal(signin.rootUrl, ROOT);
  const state = await h.accessStore.read();
  assert.equal(state.owners.length, before.owners.length);
  assert.deepEqual(state.workspaces, before.workspaces);
  assert.equal(state.authSessions.length, before.authSessions.length);
  assert.equal(state.nativeSessions.length, 1);
  assert.equal(state.nativeSessions[0].credentialHash, hashSecret(signin.token));
  assert.equal(Date.parse(signin.expiresAt) - Date.parse(state.nativeSessions[0].createdAt), NATIVE_SESSION_TTL_SECONDS * 1000);
  const raw = await fs.readFile(h.dataPath, "utf8");
  assert.equal(raw.includes(signin.token), false);
  assert.equal(raw.includes(signin.ceremony.ceremonyToken), false);
  const replay = await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { ...signin.ceremony, response: signin.response } });
  assert.equal(replay.status, 401);
  const session = await h.request("kanban.cards", "/api/session", { token: signin.token });
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.authenticationMethod, "native");
  assert.equal(session.data.expiresAt, signin.expiresAt);
  const workspaces = await h.request("kanban.cards", "/api/workspaces", { token: signin.token });
  assert.deepEqual(workspaces.data.workspaces, [{ id: h.first.id, slug: "first", name: "First", url: "https://first.kanban.cards" }]);
  const created = await h.request("first.kanban.cards", "/api/projects", { method: "POST", token: signin.token, body: { name: "Native project" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal((await h.request("second.kanban.cards", "/api/projects", { token: signin.token })).status, 401);
  assert.equal((await h.request("kanban.cards", "/api/projects", { token: signin.token })).status, 401);
  const key = await h.accessStore.createAgentConnection({ providerSubject: h.owner.id, workspaceId: h.first.id, label: "Test agent", scopes: ["read"] });
  for (const auth of [{ token: key.credential }, { cookie: h.tenantCookie }]) {
    const shared = await h.request("first.kanban.cards", `/api/projects/${created.data.project.id}`, auth);
    assert.equal(shared.status, 200);
    assert.equal(shared.data.project.name, "Native project");
    assert.deepEqual(shared.data.project.activity[0].actor, { channel: "native", label: "Native owner" });
  }
  assert.equal((await h.request("first.kanban.cards", "/api/projects?workspaceId=" + h.second.id, { token: signin.token })).status, 400);
  assert.equal((await h.request("first.kanban.cards", "/api/agent-connections", { method: "POST", token: signin.token, body: { label: "No escalation", scopes: ["write"] } })).status, 401);
}));

test("native verification binds RP, origin, challenge, user verification, presence, signature, owner handle and one-use ceremony", async () => fixture(async h => {
  for (const overrides of [{ origin: ROOT }, { rpId: "kanban.cards" }, { challenge: "d3JvbmctY2hhbGxlbmdl" }, { userHandle: Buffer.from("wrong-owner").toString("base64url") }, { flags: 1 }, { flags: 4 }, { corruptSignature: true }, { crossOrigin: true }, { topOrigin: AUTH }, { type: "webauthn.create" }]) {
    const ceremony = await h.challenge();
    const body = { challengeId: ceremony.challengeId, ceremonyToken: ceremony.ceremonyToken, response: h.assertion(ceremony.challenge, overrides) };
    const rejected = await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body });
    assert.equal(rejected.status, 401, JSON.stringify(overrides));
    assert.equal((await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { ...body, response: h.assertion(ceremony.challenge) } })).status, 401);
  }
  assert.equal((await h.accessStore.read()).nativeSessions.length, 0);
  const ceremony = await h.challenge();
  const wrongToken = await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { challengeId: ceremony.challengeId, ceremonyToken: crypto.randomBytes(32).toString("base64url"), response: h.assertion(ceremony.challenge) } });
  assert.equal(wrongToken.status, 401);
  await h.accessStore.authTransaction(s => { s.authChallenges.find(c => c.id === ceremony.challengeId)!.expiresAt = new Date(Date.now() - 1).toISOString(); });
  assert.equal((await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { ...ceremony, response: h.assertion(ceremony.challenge) } })).status, 401);
}));

test("native routes are auth-host-only JSON and cannot receive browser authority or choose an account", async () => fixture(async h => {
  for (const host of ["kanban.cards", "first.kanban.cards"]) assert.equal((await h.request(host, "/api/native-auth/challenge", { method: "POST", body: {} })).status, 404);
  for (const options of [{ origin: AUTH }, { cookie: h.rootCookie }, { headers: { "Sec-Fetch-Site": "same-origin" } }]) {
    assert.equal((await h.request(AUTH_HOST, "/api/native-auth/challenge", { method: "POST", body: {}, ...options })).status, 403);
  }
  assert.equal((await h.request(AUTH_HOST, "/api/native-auth/challenge", { method: "POST", body: { ownerId: h.owner.id } })).status, 400);
  assert.equal((await h.request(AUTH_HOST, "/api/native-auth/challenge", { method: "POST" })).status, 415);
  const ceremony = await h.challenge();
  assert.equal(ceremony.relyingPartyIdentifier, AUTH_HOST);
  assert.equal((await h.accessStore.read()).authChallenges.find(c => c.id === ceremony.challengeId)!.browserHash, hashSecret(ceremony.ceremonyToken));
  const aasa = await h.request(AUTH_HOST, "/.well-known/apple-app-site-association");
  assert.equal(aasa.status, 200);
  assert.deepEqual(aasa.data, { webcredentials: { apps: [APP_ID] } });
  assert.equal(aasa.headers.get("location"), null);
  assert.equal((await h.request("kanban.cards", "/.well-known/apple-app-site-association")).status, 404);
}));

test("AASA is disabled without explicitly configured signing identifiers and malformed identifiers fail startup", async () => {
  await fixture(async h => { assert.equal((await h.request(AUTH_HOST, "/.well-known/apple-app-site-association")).status, 404); }, []);
  assert.throws(() => getPasskeyConfig({ SESSION_SECRET: SECRET, KANBAN_CARDS_IOS_APP_IDS: "invented.bundle" }), /App IDs/);
});

test("native sessions cannot bypass cookie CSRF, cannot fall back to cookies, and sign out only themselves", async () => fixture(async h => {
  const signin = await h.signin();
  for (const options of [{ cookie: h.rootCookie }, { origin: ROOT }]) assert.equal((await h.request("kanban.cards", "/api/workspaces", { token: signin.token, ...options })).status, 403);
  assert.equal((await h.request("kanban.cards", "/api/workspaces", { token: "invalid", cookie: h.rootCookie })).status, 401);
  assert.equal((await h.request("first.kanban.cards", "/api/projects", { method: "POST", cookie: h.tenantCookie, body: { name: "Missing origin" } })).status, 403);
  assert.equal((await h.request("second.kanban.cards", "/api/session", { method: "DELETE", token: signin.token })).status, 401);
  assert.equal((await h.request("kanban.cards", "/api/session", { token: signin.token })).data.authenticated, true);
  const logout = await h.request("kanban.cards", "/api/session", { method: "DELETE", token: signin.token });
  assert.equal(logout.status, 200);
  assert.equal(logout.data.signedOutHere, true);
  assert.equal(logout.headers.get("set-cookie"), null);
  assert.equal((await h.request("kanban.cards", "/api/session", { token: signin.token })).data.authenticated, false);
  assert.equal((await h.request("kanban.cards", "/api/session", { cookie: h.rootCookie })).data.authenticated, true);
  assert.equal((await h.request("kanban.cards", "/api/workspaces", { token: signin.token })).status, 401);
}));

test("native expiry is fixed and browser access settings revoke native sessions individually and together", async () => fixture(async h => {
  const first = await h.signin();
  const session = (await h.accessStore.read()).nativeSessions[0];
  assert.ok(await authorizeNativeCredential(h.accessStore, first.token, ROOT, h.first.id, new Date(Date.parse(session.expiresAt) - 1)));
  assert.equal(await authorizeNativeCredential(h.accessStore, first.token, ROOT, h.first.id, new Date(session.expiresAt)), null);
  assert.equal(await authorizeNativeCredential(h.accessStore, first.token, "https://candidate.kanban.cards", h.first.id), null);
  const settings = await h.request("kanban.cards", "/api/access-settings", { cookie: h.rootCookie });
  assert.ok(settings.data.sessions.some((s: any) => s.id === session.id));
  const revoke = await h.request("kanban.cards", `/api/sessions/${session.id}`, { method: "DELETE", cookie: h.rootCookie, origin: ROOT });
  assert.equal(revoke.status, 204);
  assert.equal((await h.request("first.kanban.cards", "/api/projects", { token: first.token })).status, 401);
  const next = await h.signin();
  assert.equal((await h.request("kanban.cards", "/api/sessions/all", { method: "DELETE", cookie: h.rootCookie, origin: ROOT })).status, 204);
  assert.equal((await h.request("first.kanban.cards", "/api/projects", { token: next.token })).status, 401);
}));

test("native registry sessions are optional for legacy data and reject hashes, broken owners and expiry", async () => fixture(async h => {
  const signedIn = await h.signin();
  const state = await h.accessStore.read();
  const { nativeSessions: _sessions, ...legacy } = state;
  assert.deepEqual(normalizeAccessRegistry(legacy).nativeSessions, []);
  for (const mutation of [{ credentialHash: signedIn.token }, { ownerId: "missing" }, { expiresAt: state.nativeSessions[0].createdAt }]) {
    const bad = structuredClone(state);
    Object.assign(bad.nativeSessions[0], mutation);
    assert.throws(() => normalizeAccessRegistry(bad));
  }
}));

test("concurrent native verification consumes one ceremony once and revoked keys cannot create sessions", async () => fixture(async h => {
  const ceremony = await h.challenge();
  const body = { challengeId: ceremony.challengeId, ceremonyToken: ceremony.ceremonyToken, response: h.assertion(ceremony.challenge) };
  const concurrent = await Promise.all([1, 2].map(() => h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 401]);
  assert.equal((await h.accessStore.read()).nativeSessions.length, 1);
  const next = await h.challenge();
  await h.accessStore.authTransaction(s => { s.passkeys[0].revokedAt = new Date().toISOString(); });
  assert.equal((await h.request(AUTH_HOST, "/api/native-auth/verify", { method: "POST", body: { ...next, response: h.assertion(next.challenge) } })).status, 401);
  assert.equal((await h.accessStore.read()).nativeSessions.length, 1);
}));

test("native owners create Workspaces on the root and immediately use their isolated tenant", async () => fixture(async h => {
  const signin = await h.signin();
  const created = await h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body: { name: "Design Studio", slug: "design-studio" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const workspace = created.data.workspace;
  assert.deepEqual(workspace, { id: workspace.id, name: "Design Studio", slug: "design-studio", url: "https://design-studio.kanban.cards" });
  assert.ok(workspace.id);
  const registered = (await h.accessStore.read()).workspaces.find(w => w.id === workspace.id)!;
  assert.deepEqual(registered.ownerIds, [h.owner.id]);
  assert.notEqual(registered.storageId, h.first.storageId);
  assert.notEqual(registered.storageId, h.second.storageId);
  for (const auth of [{ token: signin.token }, { cookie: h.rootCookie }]) {
    const inventory = await h.request("kanban.cards", "/api/workspaces", auth);
    assert.equal(inventory.status, 200);
    assert.deepEqual(inventory.data.workspaces, [
      workspace,
      { id: h.first.id, name: "First", slug: "first", url: "https://first.kanban.cards" }
    ]);
  }
  const empty = await h.request("design-studio.kanban.cards", "/api/projects", { token: signin.token });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.projects, []);
  const project = await h.request("design-studio.kanban.cards", "/api/projects", { method: "POST", token: signin.token, body: { name: "New Workspace project" } });
  assert.equal(project.status, 201, JSON.stringify(project.data));
  assert.deepEqual((await h.request("first.kanban.cards", "/api/projects", { token: signin.token })).data.projects, []);
  assert.equal((await h.request("second.kanban.cards", "/api/projects", { token: signin.token })).status, 401);
  assert.deepEqual((await h.accessStore.listWorkspacesForOwner("different-test-owner")).map(w => w.id), [h.second.id]);
}));

test("a native owner with no Workspaces can create their first Workspace", async () => fixture(async h => {
  await h.accessStore.authTransaction(s => { s.workspaces = s.workspaces.filter(w => !w.ownerIds.includes(h.owner.id)); });
  const signin = await h.signin();
  assert.deepEqual((await h.request("kanban.cards", "/api/workspaces", { token: signin.token })).data.workspaces, []);
  const before = (await h.accessStore.read()).owners;
  const created = await h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body: { name: "First Workspace", slug: "first-workspace" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const owned = await h.accessStore.listWorkspacesForOwner(h.owner.id);
  assert.deepEqual(owned.map(w => w.slug), ["first-workspace"]);
  assert.deepEqual(owned[0].ownerIds, [h.owner.id]);
  assert.deepEqual((await h.accessStore.read()).owners, before);
  assert.deepEqual((await h.request("first-workspace.kanban.cards", "/api/projects", { token: signin.token })).data.projects, []);
}));

test("native Workspace creation rejects ambient browser authority, agent tokens, tenant hosts and Workspace selectors", async () => fixture(async h => {
  const signin = await h.signin();
  const agent = await h.accessStore.createAgentConnection({ providerSubject: h.owner.id, workspaceId: h.first.id, label: "Scoped agent", scopes: ["read", "write"] });
  const before = (await h.accessStore.read()).workspaces;
  const body = { name: "Rejected Workspace", slug: "rejected" };
  for (const options of [{ origin: ROOT }, { cookie: h.rootCookie }, { headers: { "Sec-Fetch-Site": "same-origin" } }]) {
    const response = await h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body, ...options });
    assert.equal(response.status, 403, JSON.stringify(response.data));
  }
  for (const token of ["invalid", agent.credential]) {
    const response = await h.request("kanban.cards", "/api/workspaces", { method: "POST", token, cookie: h.rootCookie, origin: ROOT, body });
    assert.equal(response.status, 401, JSON.stringify(response.data));
  }
  for (const host of ["first.kanban.cards", "second.kanban.cards", AUTH_HOST, "unknown.example.test"]) {
    assert.equal((await h.request(host, "/api/workspaces", { method: "POST", token: signin.token, body })).status, 404, host);
  }
  for (const selector of [{ workspaceId: h.second.id }, { workspaceSlug: "second" }, { tenant: "second" }]) {
    assert.equal((await h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body: { ...body, ...selector } })).status, 400);
  }
  assert.equal((await h.request("kanban.cards", "/api/workspaces?workspaceId=" + h.second.id, { method: "POST", token: signin.token, body })).status, 400);
  assert.equal((await h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, headers: { "X-Kanban-Workspace": "second" }, body })).status, 400);
  assert.deepEqual((await h.accessStore.read()).workspaces, before);
}));

test("native Workspace creation honors fixed expiry, root binding and revocation", async () => fixture(async h => {
  const signin = await h.signin();
  const session = (await h.accessStore.read()).nativeSessions[0];
  const before = (await h.accessStore.read()).workspaces;
  const create = () => h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body: { name: "Unavailable", slug: "unavailable" } });
  await h.accessStore.authTransaction(s => { s.nativeSessions[0].rootOrigin = "https://candidate.kanban.cards"; });
  assert.equal((await create()).status, 401);
  await h.accessStore.authTransaction(s => {
    s.nativeSessions[0].rootOrigin = ROOT;
    s.nativeSessions[0].createdAt = new Date(Date.now() - 120_000).toISOString();
    s.nativeSessions[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
  });
  assert.equal((await create()).status, 401);
  await h.accessStore.authTransaction(s => { s.nativeSessions[0] = session; });
  assert.equal((await h.request("kanban.cards", `/api/sessions/${session.id}`, { method: "DELETE", cookie: h.rootCookie, origin: ROOT })).status, 204);
  assert.equal((await create()).status, 401);
  assert.deepEqual((await h.accessStore.read()).workspaces, before);
  assert.equal((await h.request("kanban.cards", "/api/session", { cookie: h.rootCookie })).data.authenticated, true);
}));

test("Workspace creation preserves browser CSRF and returns native validation, conflict and quota errors", async () => fixture(async h => {
  const signin = await h.signin();
  const post = (body: unknown) => h.request("kanban.cards", "/api/workspaces", { method: "POST", token: signin.token, body });
  const browserBody = { name: "Browser Workspace", slug: "browser-workspace" };
  for (const options of [{}, { origin: "https://other.example.test" }]) {
    assert.equal((await h.request("kanban.cards", "/api/workspaces", { method: "POST", cookie: h.rootCookie, body: browserBody, ...options })).status, 403);
  }
  assert.equal((await h.request("kanban.cards", "/api/workspaces", { method: "POST", origin: ROOT, body: browserBody })).status, 401);
  const browser = await h.request("kanban.cards", "/api/workspaces", { method: "POST", origin: ROOT, cookie: h.rootCookie, body: browserBody });
  assert.equal(browser.status, 201, JSON.stringify(browser.data));
  assert.deepEqual(browser.data.workspace, { id: browser.data.workspace.id, name: browserBody.name, slug: browserBody.slug, url: "https://browser-workspace.kanban.cards" });
  for (const body of [
    { name: "", slug: "valid" }, { name: "x".repeat(121), slug: "valid" }, { name: "Two\nlines", slug: "valid" },
    { name: "Valid", slug: "" }, { name: "Valid", slug: "auth" }, { name: "Valid", slug: "-invalid" },
    { name: "Valid", slug: "invalid-" }, { name: "Valid", slug: "not valid" }, { name: "Valid", slug: "x".repeat(64) }
  ]) {
    const invalid = await post(body);
    assert.equal(invalid.status, 400, JSON.stringify(body));
  }
  for (const slug of ["first", "second", "browser-workspace"]) {
    const conflict = await post({ name: "Duplicate", slug });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "Workspace address is already in use.");
  }
  for (let index = 0; index < 8; index += 1) {
    const created = await post({ name: `Workspace ${index}`, slug: `quota-${index}` });
    assert.equal(created.status, 201, JSON.stringify(created.data));
  }
  const quota = await post({ name: "One too many", slug: "over-quota" });
  assert.equal(quota.status, 403);
  assert.equal(quota.data.error, "An owner can have up to 10 Workspaces.");
  assert.equal((await h.accessStore.listWorkspacesForOwner(h.owner.id)).length, 10);
  assert.deepEqual((await h.accessStore.listWorkspacesForOwner("different-test-owner")).map(w => w.id), [h.second.id]);
}));
