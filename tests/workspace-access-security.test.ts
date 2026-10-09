import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileAccessStore, type AccessStore } from "../src/access-store";
import { createRootSessionCookie, createTenantSessionCookie, type RootSession } from "../src/app-sessions";
import { hashSecret, type PasskeyAuthConfig } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const ROOT = "https://kanban.cards";
const AUTH = "https://auth.kanban.cards";
const SECRET = "passkey-server-security-secret-at-least-32-bytes";
const CONFIG: PasskeyAuthConfig = { authHost: "auth.kanban.cards", authOrigin: AUTH, rpId: "auth.kanban.cards", sessionSecret: SECRET, rootOrigins: [ROOT], sessionTtlSeconds: 604800 };

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
  async function request(host: string, route: string, options: { method?: string; cookie?: string; origin?: string; token?: string; body?: unknown; form?: Record<string,string> } = {}) {
    const headers: Record<string,string> = { Host: host, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https" };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
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

test("auth host exposes only auth APIs and rejects root/tenant data routes", async () => fixture(async f => {
  const session = await f.request("auth.kanban.cards", "/api/session");
  assert.equal(session.data.context, "auth");
  assert.equal(session.data.authMode, "passkey");
  assert.equal(session.data.authenticated, false);
  for (const route of ["/api/projects", "/api/workspaces", "/api/access-settings", "/api/agent-connections", "/api/health"]) assert.equal((await f.request("auth.kanban.cards", route, { cookie: f.rootCookie })).status, 404);
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
  assert.match(valid.headers.get("set-cookie") || "", /__Host-kanban_root_session=/);
  assert.equal((await submit(`__Host-kanban_login_nonce=${nonce}`)).status, 401);
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
