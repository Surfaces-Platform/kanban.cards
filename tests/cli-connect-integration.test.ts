import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileAccessStore } from "../src/access-store";
import { hashSecret, type PasskeyAuthConfig } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const helper = path.join(process.cwd(), ".agents/skills/kanban-cards/scripts/kanban-cards-client.mjs");

test("the bundled helper pairs through the actual backend, reuses approval, updates real Cards, and survives store reload", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-connect-integration-"));
  const home = path.join(directory, "home");
  const repo = path.join(directory, "repo");
  await fs.mkdir(home);
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  const accessPath = path.join(directory, "access.json");
  const accessStore = createFileAccessStore(accessPath);
  const workspace = await accessStore.createWorkspace({ providerSubject: "integration-owner", slug: "cli-pairing-test", name: "Disposable pairing integration", displayName: "Synthetic owner", email: "owner@example.test" });
  const owner = (await accessStore.resolveOwner("integration-owner"))!.owner;
  const nativeToken = `kcn_${crypto.randomBytes(32).toString("base64url")}`;
  let application: ReturnType<typeof createApp> | undefined;
  const server = createServer((req, res) => { if (!application) { res.writeHead(503).end(); return; } application(req, res); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  const rootOrigin = `http://localhost:${port}`;
  const authOrigin = `http://auth.localhost:${port}`;
  const tenantOrigin = `http://${workspace.slug}.localhost:${port}`;
  const timestamp = new Date().toISOString();
  await accessStore.authTransaction(state => {
    state.nativeSessions.push({ id: "native-integration-session", ownerId: owner.id, credentialHash: hashSecret(nativeToken), rootOrigin,
      createdAt: timestamp, verifiedAt: timestamp, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null });
  });
  const passkeyAuthConfig: PasskeyAuthConfig = { sessionSecret: "synthetic-integration-session-secret-32-bytes", authHost: `auth.localhost:${port}`,
    authOrigin, rpId: "auth.localhost", rootOrigins: [rootOrigin], sessionTtlSeconds: 3_600 };
  const resolverOptions = { dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "workspaces") };
  const resolver = createWorkspaceStoreResolver(resolverOptions);
  application = createApp({ accessStore, passkeyAuthConfig, rootHost: `localhost:${port}`, requireDatabase: false,
    dataPath: resolverOptions.dataPath, workspaceStoreResolver: resolver });
  async function ownerRequest(origin: string, route: string, body?: unknown) {
    const response = await fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers: {
      Authorization: `Bearer ${nativeToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" })
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.ok, true, `Owner fixture request failed with ${response.status}`);
    return await response.json() as any;
  }
  const children: ReturnType<typeof spawn>[] = [];
  function start(args: string[], onOutput?: (text: string) => void) {
    const child = spawn(process.execPath, [helper, ...args], { cwd: repo, env: { ...process.env, KANBAN_CARDS_CONFIG_DIR: path.join(home, ".kanban-cards") }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8").on("data", chunk => { stdout += chunk; onOutput?.(stdout); });
    child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin!.end();
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
    });
    return { child, done };
  }
  async function run(args: string[]) {
    const result = await start(args).done;
    assert.equal(result.code, 0, result.stderr);
    return result;
  }
  try {
    const { project } = await ownerRequest(tenantOrigin, "/api/projects", { name: "Disposable first project" });
    const connectArgs = ["connect", "--url", tenantOrigin, "--project-id", project.id, "--label", "Codex"];
    let approveCode!: (code: string) => void;
    const codeReady = new Promise<string>(resolve => { approveCode = resolve; });
    const connecting = start(connectArgs, output => { const match = /Approval code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output); if (match) approveCode(match[1]); });
    const userCode = await Promise.race([codeReady, connecting.done.then(() => { throw new Error("Connect exited before presenting an approval code."); })]);
    const inspection = await ownerRequest(authOrigin, "/api/native-auth/agent-pairings/inspect", { userCode });
    assert.equal(inspection.workspaceId, workspace.id);
    assert.deepEqual(inspection.scopes, ["read", "write"]);
    await ownerRequest(authOrigin, "/api/native-auth/agent-pairings/approve", { userCode });
    const connected = await connecting.done;
    assert.equal(connected.code, 0, connected.stderr);
    const config = JSON.parse(await fs.readFile(path.join(home, ".kanban-cards/config.json"), "utf8"));
    const privatePending = await fs.readFile(path.join(home, ".kanban-cards/pairing.json"), "utf8").catch(() => "");
    assert.equal(privatePending, "");
    assert.equal(connected.stdout.includes(config.token), false);
    assert.equal(connected.stderr.includes(config.token), false);
    assert.equal(connected.stdout.includes(nativeToken), false);
    const repeated = await run(connectArgs);
    assert.match(repeated.stdout, /already approved/);
    assert.equal((await accessStore.read()).agentConnections.length, 1);
    const session = JSON.parse((await run(["session"])).stdout);
    assert.equal(session.workspace.id, workspace.id);
    assert.deepEqual(session.scopes, ["read", "write"]);
    const createArgs = ["create-card", "--title", "Deliver the first project", "--body", "Initial acceptance check", "--external-key", "first-project-delivery"];
    const created = JSON.parse((await run(createArgs)).stdout).card;
    assert.equal(JSON.parse((await run(createArgs)).stdout).card.id, created.id);
    await run(["update-card", "--card", created.id, "--body", "Revised acceptance check from owner", "--version", String(created.version)]);
    const readback = await ownerRequest(tenantOrigin, `/api/projects/${project.id}`);
    assert.equal(readback.project.cards.length, 1);
    assert.equal(readback.project.cards[0].body, "Revised acceptance check from owner");
    assert.equal(readback.project.activity.find((entry: any) => entry.action === "card.created").actor.label, "Codex");
    const reloadedAccess = await createFileAccessStore(accessPath).read();
    assert.equal(reloadedAccess.agentConnections.length, 1);
    assert.equal((await fs.readFile(accessPath, "utf8")).includes(config.token), false);
    const reloaded = await createWorkspaceStoreResolver(resolverOptions).resolve(workspace.storageId).read();
    assert.equal(reloaded.projects[0].cards[0].body, "Revised acceptance check from owner");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(repo, ".kanban-cards.json"), "utf8")), { projectId: project.id });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
