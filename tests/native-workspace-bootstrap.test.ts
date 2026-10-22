import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileAccessStore } from "../src/access-store";
import { createRootSessionCookie } from "../src/app-sessions";
import type { PasskeyAuthConfig } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createFileStateStore, createWorkspaceStoreResolver } from "../src/state-store";
import type { WorkspaceStoreResolver } from "../src/types";

const ROOT = "https://kanban.cards";
const SECRET = "project-idea-test-secret-with-at-least-32-bytes";
const config: PasskeyAuthConfig = { authHost: "auth.kanban.cards", authOrigin: "https://auth.kanban.cards", rpId: "auth.kanban.cards", rootOrigins: [ROOT], sessionSecret: SECRET, sessionTtlSeconds: 3600 };
const idea = { originalInput: "  Build a place for rough ideas.\n\nKeep the exact intent.\n  ", brief: "", completionCriteria: "" };

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(route: string, options: { method?: string; body?: unknown; host?: string; cookie?: string; key?: string; version?: number; token?: string; origin?: string } = {}) {
    const headers: Record<string, string> = { Host: options.host || "127.0.0.1", "Content-Type": "application/json" };
    if (options.host) { headers["X-Forwarded-Host"] = options.host; headers["X-Forwarded-Proto"] = "https"; headers.Origin = `https://${options.host}`; }
    if (options.origin) headers.Origin = options.origin;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.key) headers["Idempotency-Key"] = options.key;
    if (options.version) headers["X-Kanban-Version"] = String(options.version);
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(`${base}${route}`, { method: options.method || "GET", redirect: "manual", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, data: text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as any : {}, headers: response.headers };
  }
  return { request, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("Project Idea preserves source formatting across API restart and guards evolving context with Project revisions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-idea-api-"));
  const dataPath = path.join(directory, "board.json");
  let app = await listen(createApp({ dataPath, apiToken: "local-idea-key", requireDatabase: false }));
  try {
    const original = await app.request("/api/projects", { method: "POST", token: "local-idea-key", key: "capture", body: { name: "Idea", idea } });
    assert.equal(original.status, 201);
    const project = original.data.project;
    assert.deepEqual(project.idea, idea);
    const replay = await app.request("/api/projects", { method: "POST", token: "local-idea-key", key: "capture", body: { name: "Idea", idea } });
    assert.equal(replay.data.project.id, project.id);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const evolved = await app.request(`/api/projects/${project.id}`, { method: "PATCH", token: "local-idea-key", version: 1, body: { idea: { brief: "A bounded brief", completionCriteria: "Owner can capture and read the same Idea." } } });
    assert.equal(evolved.status, 200);
    assert.equal(evolved.data.project.idea.originalInput, idea.originalInput);
    assert.equal((await app.request(`/api/projects/${project.id}`, { method: "PATCH", token: "local-idea-key", version: 1, body: { idea: { brief: "stale" } } })).status, 409);
    assert.equal((await app.request(`/api/projects/${project.id}`, { method: "PATCH", token: "local-idea-key", version: 2, body: { idea: { originalInput: "rewritten intent" } } })).status, 409);
    await app.close();
    app = await listen(createApp({ dataPath, apiToken: "local-idea-key", requireDatabase: false }));
    const stored = await app.request(`/api/projects/${project.id}`, { token: "local-idea-key" });
    assert.equal(stored.data.project.revision, 2);
    assert.deepEqual(stored.data.project.idea, evolved.data.project.idea);
    const legacy = await app.request("/api/projects", { method: "POST", token: "local-idea-key", body: { name: "Existing style" } });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.data.project.idea, undefined);
    const attached = await app.request(`/api/projects/${legacy.data.project.id}`, { method: "PATCH", token: "local-idea-key", version: 1, body: { idea } });
    assert.deepEqual(attached.data.project.idea, idea);
    assert.equal((await app.request("/api/projects", { method: "POST", token: "local-idea-key", body: { name: "Invalid", idea: { originalInput: "  " } } })).status, 400);
    assert.equal((await createFileStateStore(dataPath).read()).projects.length, 2);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Workspace bootstrap survives interruption and restart, identical retries, and owner isolation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-idea-workspace-"));
  const accessPath = path.join(directory, "access.json");
  let access = createFileAccessStore(accessPath);
  const ownerWorkspace = await access.createWorkspace({ providerSubject: "owner-one", displayName: "One", email: "", name: "Legacy", slug: "legacy" });
  await access.createWorkspace({ providerSubject: "owner-two", displayName: "Two", email: "", name: "Other", slug: "other" });
  const owners = (await access.read()).owners;
  const cookieFor = async (ownerId: string, id: string) => {
    const now = new Date().toISOString();
    await access.authTransaction(state => state.authSessions.push({ id, ownerId, rootOrigin: ROOT, createdAt: now, verifiedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null }));
    return (await createRootSessionCookie({ providerSubject: ownerId, displayName: "Owner", email: "", sessionId: id, rootOrigin: ROOT }, SECRET, true)).split(";")[0];
  };
  const firstCookie = await cookieFor(owners[0].id, "one-session");
  const otherCookie = await cookieFor(owners[1].id, "two-session");
  const resolverOptions = { dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "boards") };
  let resolver = createWorkspaceStoreResolver(resolverOptions);
  let fail = true;
  const broken: WorkspaceStoreResolver = { kind: "file", resolve(storageId) { const store = resolver.resolve(storageId); return { ...store, async update(mutator) { if (fail) { fail = false; throw new Error("simulated interrupted bootstrap"); } return store.update(mutator); } }; } };
  const start = (workspaceStoreResolver: WorkspaceStoreResolver) => listen(createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: config, accessStore: access, workspaceStoreResolver, requireDatabase: false, trustForwardedHost: true }));
  let app = await start(broken);
  const body = { name: "New workspace", slug: "new-workspace", initialProject: { name: "First result", idea } };
  try {
    assert.equal((await app.request("/api/workspaces", { host: "kanban.cards", method: "POST", cookie: firstCookie, key: "same-owner-key", body })).status, 500);
    let pending = (await access.read()).workspaces.find(workspace => workspace.slug === body.slug)!;
    assert.deepEqual(pending.pendingInitialProject?.idea, idea);
    const projectId = pending.initialProjectId;
    assert.ok(projectId);
    await app.close();
    access = createFileAccessStore(accessPath);
    resolver = createWorkspaceStoreResolver(resolverOptions);
    app = await start(resolver);
    const retry = await app.request("/api/workspaces", { host: "kanban.cards", method: "POST", cookie: firstCookie, key: "same-owner-key", body });
    assert.equal(retry.status, 201);
    assert.equal(retry.data.project.id, projectId);
    assert.deepEqual(retry.data.project.idea, idea);
    assert.equal(retry.data.workspace.initialProjectId, projectId);
    const replay = await app.request("/api/workspaces", { host: "kanban.cards", method: "POST", cookie: firstCookie, key: "same-owner-key", body });
    assert.equal(replay.data.project.id, projectId);
    pending = (await access.read()).workspaces.find(workspace => workspace.slug === body.slug)!;
    assert.equal(pending.pendingInitialProject, undefined, "private pending copy is removed after canonical Project storage");
    assert.equal((await resolver.resolve(pending.storageId).read()).projects.length, 1);
    assert.equal((await access.listWorkspacesForOwner(owners[0].id)).length, 2);
    assert.equal((await app.request("/api/workspaces", { host: "kanban.cards", method: "POST", cookie: firstCookie, key: "same-owner-key", body: { ...body, name: "Changed" } })).status, 409);
    const other = await app.request("/api/workspaces", { host: "kanban.cards", method: "POST", cookie: otherCookie, key: "same-owner-key", body: { ...body, slug: "other-new", initialProject: { name: "Other", idea: { ...idea, originalInput: "Other owner's request" } } } });
    assert.equal(other.status, 201);
    assert.notEqual(other.data.project.id, projectId);
    const inventory = await app.request("/api/workspaces", { host: "kanban.cards", cookie: otherCookie });
    assert.ok(inventory.data.workspaces.every((workspace: any) => workspace.id !== pending.id));
    assert.equal((await resolver.resolve(ownerWorkspace.storageId).read()).projects.length, 0);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
