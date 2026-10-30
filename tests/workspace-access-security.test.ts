import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileAccessStore, type AccessStore } from "../src/access-store";
import { BROWSER_SESSION_TTL_SECONDS, createRootSessionCookie, createTenantSessionCookie, verifyRootSession, verifyTenantSession, type RootSession } from "../src/app-sessions";
import { hashSecret, type PasskeyAuthConfig } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const ROOT = "https://kanban.cards";
const AUTH = "https://auth.kanban.cards";
const SECRET = "passkey-server-security-secret-at-least-32-bytes";
const CONFIG: PasskeyAuthConfig = { authHost: "auth.kanban.cards", authOrigin: AUTH, rpId: "auth.kanban.cards", sessionSecret: SECRET, rootOrigins: [ROOT], sessionTtlSeconds: BROWSER_SESSION_TTL_SECONDS };

function assertSessionCookieLifetime(headers: Headers, name: string, expiresAt: string) {
  const cookie = headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(cookie, "Handoff must issue its host-only session cookie");
  const maxAge = Number(cookie.match(/; Max-Age=(\d+)(?:;|$)/)?.[1]);
  const token = decodeURIComponent(cookie.split(";")[0].slice(name.length + 1));
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { iat: number; exp: number };
  assert.ok(Number.isSafeInteger(maxAge) && maxAge > 0);
  assert.equal(claims.exp - claims.iat, maxAge);
  assert.ok(claims.exp * 1000 <= Date.parse(expiresAt), "JWT must not outlive the stored session");
  assert.ok(Date.parse(expiresAt) - claims.exp * 1000 < 2000, "Cookie must retain the stored session's remaining lifetime");
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; SameSite=Lax(?:;|$)/);
  assert.doesNotMatch(cookie, /; Domain=/i);
  return maxAge;
}

async function fixture(run: (f: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const f = await startFixture();
  try { await run(f); } finally { await new Promise<void>((resolve,reject) => f.server.close(e => e ? reject(e) : resolve())); await fs.rm(f.directory, { recursive: true, force: true }); }
}
async function startFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-passkey-security-"));
  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const first = await accessStore.createWorkspace({ providerSubject: "user_existingOwner", email: "mike@example.test", displayName: "Mike", slug: "mike", name: "Existing board" });
  const second = await accessStore.createWorkspace({ providerSubject: "owner:second", email: "", displayName: "Other owner", slug: "other", name: "Other board" });
  const owner = (await accessStore.resolveOwner("user_existingOwner"))!.owner;
  const other = (await accessStore.resolveOwner("owner:second"))!.owner;
  const resolver = createWorkspaceStoreResolver({ dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "workspaces") });
  const now = new Date().toISOString();
  await accessStore.authTransaction(s => {
    s.authSessions.push({ id: "passkey-session-one", ownerId: owner.id, rootOrigin: ROOT, createdAt: now, verifiedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    s.authSessions.push({ id: "passkey-session-two", ownerId: other.id, rootOrigin: ROOT, createdAt: now, verifiedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    s.passkeys.push({ id: "Zmlyc3Q", ownerId: owner.id, publicKey: "a2V5", counter: 0, transports: ["internal"], createdAt: now, lastUsedAt: null, revokedAt: null });
  });
  const session: RootSession = { providerSubject: owner.id, email: owner.email, displayName: owner.displayName, sessionId: "passkey-session-one", rootOrigin: ROOT };
  const rootCookie = (await createRootSessionCookie(session, SECRET, true)).split(";")[0];
  const tenantCookie = (await createTenantSessionCookie({ ...session, workspaceId: first.id, tenantOrigin: "https://mike.kanban.cards" }, SECRET, true)).split(";")[0];
  const secondCookie = (await createTenantSessionCookie({ ...session, providerSubject: other.id, email: "", displayName: "Other owner", sessionId: "passkey-session-two", workspaceId: second.id, tenantOrigin: "https://other.kanban.cards" }, SECRET, true)).split(";")[0];
  const server = createServer(createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: CONFIG, apiToken: "retired-global-bearer", accessStore, workspaceStoreResolver: resolver, dataPath: path.join(directory, "default.json"), requireDatabase: false, trustForwardedHost: true }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(host: string, route: string, options: { method?: string; cookie?: string; origin?: string; token?: string; body?: unknown; form?: Record<string,string>; expectedOwner?: string } = {}) {
    const headers: Record<string,string> = { Host: host, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https" };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.expectedOwner !== undefined) headers["X-Kanban-Expected-Owner"] = options.expectedOwner;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetch(`${base}${route}`, { method: options.method || "GET", headers, redirect: "manual", body: options.form ? new URLSearchParams(options.form) : options.body !== undefined ? JSON.stringify(options.body) : undefined });
    const text = await response.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  return { directory, server, accessStore, first, second, owner, other, rootCookie, tenantCookie, secondCookie, request };
}

test("owners use durable passkey sessions; old provider cookies and global bearer cannot enter", async () => fixture(async f => {
  assert.equal((await f.request("kanban.cards", "/api/session", { cookie: f.rootCookie })).data.authenticated, true);
  assert.equal((await f.request("mike.kanban.cards", "/api/session", { cookie: f.tenantCookie })).data.authenticated, true);
  const old = await createRootSessionCookie({ providerSubject: "user_existingOwner", email: "mike@example.test", displayName: "Mike", sessionId: "old-provider-session", rootOrigin: ROOT }, SECRET, true);
  assert.equal((await f.request("kanban.cards", "/api/session", { cookie: old.split(";")[0] })).data.authenticated, false);
  for (const host of ["kanban.cards", "mike.kanban.cards", "other.kanban.cards"]) assert.equal((await f.request(host, "/api/projects", { token: "retired-global-bearer" })).status, 401);
  assert.equal((await f.request("kanban.cards", "/api/session", { method: "POST", origin: ROOT, body: { token: "retired-global-bearer" } })).status, 404);
}));

test("two owners cannot cross tenant boundaries through cookie, header, or scoped key", async () => fixture(async f => {
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { cookie: f.tenantCookie })).status, 401);
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { cookie: f.secondCookie })).status, 200);
  const owned = await f.request("kanban.cards", "/api/workspaces", { cookie: f.rootCookie });
  assert.deepEqual(owned.data.workspaces.map((w: any) => w.id), [f.first.id]);
  const key = await f.accessStore.createAgentConnection({ providerSubject: f.owner.id, workspaceId: f.first.id, label: "Build agent", scopes: ["read"] });
  assert.equal((await f.request("mike.kanban.cards", "/api/projects", { token: key.credential })).status, 200);
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { token: key.credential })).status, 401);
  assert.equal((await f.request("mike.kanban.cards", "/api/projects?workspaceId=" + f.second.id, { token: key.credential })).status, 400);
  assert.equal((await f.request("mike.kanban.cards", "/api/projects", { method: "POST", token: key.credential, body: { name: "Forbidden" } })).status, 403);
  assert.equal((await f.request("mike.kanban.cards", "/api/agent-connections", { token: key.credential })).status, 401);
}));

test("Workspace Activity stays in its authenticated tenant and preserves each verified agent name", async () => fixture(async f => {
  const first = await f.request("mike.kanban.cards", "/api/projects", { method: "POST", cookie: f.tenantCookie, origin: "https://mike.kanban.cards", body: { name: "Mike history" } });
  const second = await f.request("other.kanban.cards", "/api/projects", { method: "POST", cookie: f.secondCookie, origin: "https://other.kanban.cards", body: { name: "Private other history" } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const agents = await Promise.all(["Claude Research", "Codex Writer"].map(label => f.accessStore.createAgentConnection({ providerSubject: f.owner.id, workspaceId: f.first.id, label, scopes: ["read", "write"] })));
  for (const agent of agents) {
    const result = await f.request("mike.kanban.cards", `/api/projects/${first.data.project.id}/cards`, { method: "POST", token: agent.credential, body: { title: agent.connection.label + " result" } });
    assert.equal(result.status, 201);
  }
  const reader = await f.accessStore.createAgentConnection({ providerSubject: f.owner.id, workspaceId: f.first.id, label: "Read only", scopes: ["read"] });
  const feed = await f.request("mike.kanban.cards", "/api/activity", { token: reader.credential });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual([...new Set(feed.data.activity.map((a: any) => a.projectId))], [first.data.project.id]);
  for (const agent of agents) assert.ok(feed.data.activity.some((a: any) => a.actor.label === agent.connection.label && a.actor.agentConnectionId === agent.connection.id));
  const foreign = await f.request("other.kanban.cards", "/api/activity", { cookie: f.secondCookie });
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign.data.activity.map((a: any) => a.projectId), [second.data.project.id]);
  assert.equal((await f.request("mike.kanban.cards", "/api/activity")).status, 401);
  assert.equal((await f.request("kanban.cards", "/api/activity", { cookie: f.rootCookie })).status, 401);
  assert.equal((await f.request("other.kanban.cards", "/api/activity", { cookie: f.tenantCookie })).status, 401);
  assert.equal((await f.request("other.kanban.cards", "/api/activity", { token: reader.credential })).status, 401);
  assert.equal((await f.request("mike.kanban.cards", `/api/activity?workspaceId=${f.second.id}`, { token: reader.credential })).status, 400);
  assert.equal((await f.request("mike.kanban.cards", "/api/activity", { method: "POST", token: reader.credential, body: {} })).status, 403);
}));

test("auth host exposes only auth APIs and rejects root/tenant data routes", async () => fixture(async f => {
  const session = await f.request("auth.kanban.cards", "/api/session");
  assert.equal(session.data.context, "auth");
  assert.equal(session.data.authMode, "passkey");
  assert.equal(session.data.authenticated, false);
  for (const route of ["/api/projects", "/api/activity", "/api/workspaces", "/api/access-settings", "/api/agent-connections", "/api/health"]) assert.equal((await f.request("auth.kanban.cards", route, { cookie: f.rootCookie })).status, 404);
  assert.equal((await f.request("kanban.cards", "/api/clerk-session", { method: "POST", origin: ROOT, body: {} })).status, 404);
  const headers = (await f.request("kanban.cards", "/")).headers;
  assert.doesNotMatch(headers.get("content-security-policy") || "", /clerk|unsafe-inline/);
}));

test("authentication starts on exact root and intent cannot be replayed or repurposed", async () => fixture(async f => {
  assert.equal((await f.request("kanban.cards", "/api/auth-start", { method: "POST", origin: "https://other.kanban.cards", body: { mode: "signin" } })).status, 403);
  assert.equal((await f.request("kanban.cards", "/api/auth-start", { method: "POST", origin: ROOT, body: { mode: "add" } })).status, 401);
  const start = await f.request("kanban.cards", "/api/auth-start", { method: "POST", origin: ROOT, body: { mode: "signup" } });
  assert.equal(start.status, 200);
  assert.match(start.headers.get("set-cookie") || "", /^__Host-kanban_login_nonce=/);
  const moved = await f.request("auth.kanban.cards", "/api/passkeys/start", { method: "POST", origin: ROOT, form: start.data });
  assert.equal(moved.status, 303);
  const replay = await f.request("auth.kanban.cards", "/api/passkeys/start", { method: "POST", origin: ROOT, form: start.data });
  assert.equal(replay.status, 401);
  const cookie = moved.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const repurpose = await f.request("auth.kanban.cards", "/api/passkeys/options", { method: "POST", origin: AUTH, cookie, body: { mode: "setup", setupToken: "anything" } });
  assert.equal(repurpose.status, 403);
}));

test("root handoff requires the initiating browser nonce and consumes once", async () => fixture(async f => {
  const token = "root-handoff-secret-with-enough-entropy";
  const nonce = "root-browser-nonce-with-enough-entropy";
  await f.accessStore.authTransaction(s => s.authHandoffs.push({ id: "auth-transfer-one", tokenHash: hashSecret(token), browserHash: hashSecret(nonce), ownerId: f.owner.id, sessionId: "passkey-session-one", destinationOrigin: ROOT, expiresAt: new Date(Date.now() + 60000).toISOString(), consumedAt: null }));
  const submit = (cookie: string) => f.request("kanban.cards", "/api/auth-handoff", { method: "POST", origin: AUTH, cookie, form: { handoffToken: token } });
  assert.equal((await submit("")).status, 401);
  assert.equal((await submit("__Host-kanban_login_nonce=wrong")).status, 401);
  const valid = await submit(`__Host-kanban_login_nonce=${nonce}`);
  assert.equal(valid.status, 303);
  const storedSession = (await f.accessStore.read()).authSessions.find(session => session.id === "passkey-session-one")!;
  assert.ok(assertSessionCookieLifetime(valid.headers, "__Host-kanban_root_session", storedSession.expiresAt) <= 600);
  assert.equal((await submit(`__Host-kanban_login_nonce=${nonce}`)).status, 401);
}));

test("repeated Workspace handoffs preserve an aged browser session's absolute expiry", async () => fixture(async f => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await f.accessStore.authTransaction(state => {
    const session = state.authSessions.find(session => session.id === "passkey-session-one")!;
    session.createdAt = new Date(Date.parse(expiresAt) - BROWSER_SESSION_TTL_SECONDS * 1000).toISOString();
    session.expiresAt = expiresAt;
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const handoff = await f.request("kanban.cards", "/api/workspace-handoffs", { method: "POST", origin: ROOT, cookie: f.rootCookie, body: { slug: "mike" } });
    assert.equal(handoff.status, 201);
    const entered = await f.request("mike.kanban.cards", "/api/workspace-handoff", { method: "POST", origin: ROOT, form: { token: handoff.data.handoffToken } });
    assert.equal(entered.status, 303);
    assert.ok(assertSessionCookieLifetime(entered.headers, "__Host-kanban_tenant_session", expiresAt) <= 3600);
    assert.equal((await f.accessStore.read()).authSessions.find(session => session.id === "passkey-session-one")!.expiresAt, expiresAt);
  }
}));

test("expired server sessions reject root and Workspace access while their signed cookies remain valid", async () => fixture(async f => {
  assert.ok(await verifyRootSession(new Request(`${ROOT}/`, { headers: { cookie: f.rootCookie } }), SECRET, true));
  assert.ok(await verifyTenantSession(new Request("https://mike.kanban.cards/", { headers: { cookie: f.tenantCookie } }), SECRET, true));
  await f.accessStore.authTransaction(state => {
    const session = state.authSessions.find(session => session.id === "passkey-session-one")!;
    session.createdAt = new Date(Date.now() - 10000).toISOString();
    session.verifiedAt = session.createdAt;
    session.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  assert.equal((await f.request("kanban.cards", "/api/session", { cookie: f.rootCookie })).data.authenticated, false);
  assert.equal((await f.request("mike.kanban.cards", "/api/session", { cookie: f.tenantCookie })).data.authenticated, false);
  assert.equal((await f.request("mike.kanban.cards", "/api/projects", { cookie: f.tenantCookie })).status, 401);
  assert.equal((await f.request("kanban.cards", "/api/workspace-handoffs", { method: "POST", origin: ROOT, cookie: f.rootCookie, body: { slug: "mike" } })).status, 401);
}));

test("fresh verification gates credential changes and final passkey cannot be removed", async () => fixture(async f => {
  assert.equal((await f.request("mike.kanban.cards", "/api/passkeys/Zmlyc3Q", { method: "DELETE", origin: "https://mike.kanban.cards", cookie: f.tenantCookie })).status, 409);
  await f.accessStore.authTransaction(s => { const session = s.authSessions.find(s => s.id === "passkey-session-one")!; session.createdAt = new Date(Date.now() - 7 * 60000).toISOString(); session.verifiedAt = new Date(Date.now() - 6 * 60000).toISOString(); });
  assert.equal((await f.request("mike.kanban.cards", "/api/agent-connections", { method: "POST", origin: "https://mike.kanban.cards", cookie: f.tenantCookie, body: { label: "Agent", scopes: ["read", "write"] } })).status, 403);
  assert.equal((await f.request("kanban.cards", "/api/recovery-code", { method: "POST", origin: ROOT, cookie: f.rootCookie, body: {} })).status, 403);
}));

test("logout durably revokes root, tenant, and outstanding handoff access", async () => fixture(async f => {
  const handoff = await f.request("kanban.cards", "/api/workspace-handoffs", { method: "POST", origin: ROOT, cookie: f.rootCookie, body: { slug: "mike" } });
  assert.equal(handoff.status, 201);
  assert.equal((await f.request("mike.kanban.cards", "/api/session", { method: "DELETE", cookie: f.tenantCookie, origin: "https://other.kanban.cards" })).status, 403);
  const logout = await f.request("mike.kanban.cards", "/api/session", { method: "DELETE", cookie: f.tenantCookie, origin: "https://mike.kanban.cards" });
  assert.equal(logout.status, 200);
  assert.equal(logout.data.globalSignOutComplete, true);
  assert.equal((await f.request("kanban.cards", "/api/session", { cookie: f.rootCookie })).data.authenticated, false);
  assert.equal((await f.request("mike.kanban.cards", "/api/projects", { cookie: f.tenantCookie })).status, 401);
  assert.equal((await f.request("mike.kanban.cards", "/api/workspace-handoff", { method: "POST", origin: ROOT, form: { token: handoff.data.handoffToken } })).status, 401);
}));


test("browser recovery ownerId comes only from verified owner identity and exposes no authentication secrets", async () => fixture(async f => {
  const root = await f.request("kanban.cards", "/api/session", { cookie: f.rootCookie });
  const tenant = await f.request("mike.kanban.cards", "/api/session", { cookie: f.tenantCookie });
  const other = await f.request("other.kanban.cards", "/api/session", { cookie: f.secondCookie });
  assert.equal(root.data.ownerId, f.owner.id); assert.equal(tenant.data.ownerId, f.owner.id); assert.equal(other.data.ownerId, f.other.id);
  assert.notEqual(other.data.ownerId, f.owner.id);
  for (const response of [root, tenant, other]) {
    const serialized = JSON.stringify(response.data);
    for (const secret of [SECRET, f.rootCookie, f.tenantCookie, "passkey-session-one", "passkey-session-two"]) assert.equal(serialized.includes(secret), false);
    assert.match(response.headers.get("cache-control") || "", /(?:^|,\s*)no-store(?:\s*,|$)/);
  }
  for (const [host, cookie] of [["mike.kanban.cards", undefined], ["other.kanban.cards", f.tenantCookie], ["auth.kanban.cards", f.rootCookie]] as const) {
    const anonymous = await f.request(host, "/api/session", { cookie });
    assert.equal(anonymous.data.authenticated, false); assert.equal("ownerId" in anonymous.data, false);
  }
  const key = await f.accessStore.createAgentConnection({ providerSubject: f.owner.id, workspaceId: f.first.id, label: "Synthetic reader", scopes: ["read"] });
  const agent = await f.request("mike.kanban.cards", "/api/session", { token: key.credential });
  assert.equal("ownerId" in agent.data, false); assert.equal(JSON.stringify(agent.data).includes(key.credential), false);
}));


test("expected-owner fence rejects swapped cookies atomically before Project, Workspace or handoff side effects", async () => fixture(async f => {
  const otherRoot = (await createRootSessionCookie({ providerSubject: f.other.id, email: "", displayName: "Other owner", sessionId: "passkey-session-two", rootOrigin: ROOT }, SECRET, true)).split(";")[0];
  // Model a browser that read owner A, then sent its old intent with owner B's replacement cookie.
  const beforeRegistry = await f.accessStore.read();
  const beforeProjects = await f.request("other.kanban.cards", "/api/projects", { cookie: f.secondCookie });
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { method: "POST", cookie: f.secondCookie, origin: "https://other.kanban.cards", expectedOwner: f.owner.id, body: { name: "Old owner intent must not create" } })).status, 401);
  assert.deepEqual((await f.request("other.kanban.cards", "/api/projects", { cookie: f.secondCookie })).data, beforeProjects.data);
  assert.equal((await f.request("kanban.cards", "/api/workspaces", { method: "POST", cookie: otherRoot, origin: ROOT, expectedOwner: f.owner.id, body: { name: "Old intent", slug: "old-intent" } })).status, 401);
  assert.equal((await f.request("kanban.cards", "/api/workspace-handoffs", { method: "POST", cookie: otherRoot, origin: ROOT, expectedOwner: f.owner.id, body: { slug: "other" } })).status, 401);
  const afterRegistry = await f.accessStore.read();
  assert.deepEqual(afterRegistry.workspaces, beforeRegistry.workspaces); assert.deepEqual(afterRegistry.handoffs, beforeRegistry.handoffs);
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { method: "POST", cookie: f.secondCookie, origin: "https://other.kanban.cards", expectedOwner: f.other.id, body: { name: "Verified owner intent" } })).status, 201);
  assert.equal((await f.request("other.kanban.cards", "/api/projects", { method: "POST", origin: "https://other.kanban.cards", expectedOwner: f.other.id, body: { name: "Header alone grants nothing" } })).status, 401);
}));


test("object shells keep tenant data private and auth handoffs return only to local object addresses", async () => fixture(async f => {
  const projectPath = "/projects/project-permalink/cards/card-permalink#comment-permalink";
  const shell = await f.request("mike.kanban.cards", projectPath.split("#")[0]);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("cache-control") || "", /no-store/);
  assert.doesNotMatch(shell.data, /Existing board/);
  assert.equal((await f.request("mike.kanban.cards", "/api/projects/project-permalink")).status, 401);
  assert.equal((await f.request("auth.kanban.cards", projectPath.split("#")[0])).status, 404);
  const handoff = await f.request("kanban.cards", "/api/workspace-handoffs", {
    method: "POST", origin: ROOT, cookie: f.rootCookie, body: { slug: "mike" }
  });
  assert.equal(handoff.status, 201);
  for (const returnPath of ["https://evil.test/", "//other.kanban.cards/", "/api/projects", "/projects/p?workspaceId=other"]) {
    const denied = await f.request("mike.kanban.cards", "/api/workspace-handoff", {
      method: "POST", origin: ROOT, form: { token: handoff.data.handoffToken, returnPath }
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get("location"), null);
  }
  const entered = await f.request("mike.kanban.cards", "/api/workspace-handoff", {
    method: "POST", origin: ROOT, form: { token: handoff.data.handoffToken, returnPath: projectPath }
  });
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.get("location"), projectPath);
}));
