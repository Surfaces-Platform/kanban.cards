import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helper = path.join(process.cwd(), ".agents/skills/kanban-cards/scripts/kanban-cards-client.mjs");
const deviceToken = "syntheticDeviceSecret_01234567890123456789012345";
const credential = "kac_agent_test_SyntheticCredential01234567890123456789012345";
const workspaceId = "workspace-pairing-test";
const projectId = "project-pairing-test";
type Result = { code: number | null; stdout: string; stderr: string };
type Mode = "pending-approved" | "pending" | "approved" | "denied" | "expired" | "wrong-workspace" | "wrong-session" | "wrong-url" | "wrong-project" | "secret-error" | "read-only";

async function fixture(initialMode: Mode, body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const f = await createFixture(initialMode);
  try { await body(f); } finally { await f.close(); }
}

async function createFixture(initialMode: Mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-codex-connect-"));
  const home = path.join(directory, "home");
  const repo = path.join(directory, "repo");
  await fs.mkdir(home);
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  const config = path.join(home, ".kanban-cards/config.json");
  const pending = path.join(home, ".kanban-cards/pairing.json");
  const binding = path.join(repo, ".kanban-cards.json");
  let mode = initialMode;
  let starts = 0;
  let polls = 0;
  let api = "";
  let firstPoll!: () => void;
  const polled = new Promise<void>(resolve => { firstPoll = resolve; });
  const processes: ChildProcess[] = [];
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const data = await new Promise<string>(resolve => { let text = ""; req.on("data", c => { text += c; }); req.on("end", () => resolve(text)); });
    const json = data ? JSON.parse(data) : {};
    if (req.url === "/api/session") {
      const authenticated = req.headers.authorization !== undefined;
      if (authenticated) assert.equal(req.headers.authorization, `Bearer ${credential}`);
      return send(200, { authenticated, ...(authenticated ? { scopes: mode === "read-only" ? ["read"] : ["read", "write"] } : {}), context: "workspace", loginUrl: `${api.slice(0, -4)}/sign-in`, workspace: {
        id: authenticated && mode === "wrong-session" ? "workspace-other" : workspaceId, url: api.slice(0, -4), name: "Disposable CLI fixture"
      } });
    }
    if (req.url === "/api/native-auth/agent-pairings") {
      starts++;
      assert.deepEqual(json, { workspaceId, label: "Codex" });
      assert.equal(req.headers.authorization, undefined);
      return send(201, { pairingId: "pairing-test", deviceToken, userCode: "ABCD-EFGH", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.url === "/api/native-auth/agent-pairings/poll") {
      polls++;
      firstPoll();
      assert.deepEqual(json, { pairingId: "pairing-test", deviceToken });
      assert.equal(req.headers.authorization, undefined);
      if (mode === "secret-error") return send(500, { error: `Never echo ${credential} or ${deviceToken}` });
      if (mode === "pending" || (mode === "pending-approved" && polls === 1)) return send(200, { status: "pending" });
      if (mode === "denied" || mode === "expired") return send(200, { status: mode });
      return send(200, { status: "approved", credential,
        apiBaseUrl: mode === "wrong-url" ? "https://other.kanban.cards/api" : api,
        connection: { id: "agent-test", workspaceId: mode === "wrong-workspace" ? "workspace-other" : workspaceId, label: "Codex", scopes: ["read", "write"], revokedAt: null }
      });
    }
    if (req.url === `/api/projects/${projectId}`) {
      assert.equal(req.headers.authorization, `Bearer ${credential}`);
      return send(200, { project: { id: mode === "wrong-project" ? "project-other" : projectId } });
    }
    send(404, { error: "Missing test route" });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  function start(extraArgs: string[] = [], configDirectory = path.join(home, ".kanban-cards")) {
    const child = spawn(process.execPath, [helper, "connect", "--url", api.slice(0, -4), "--project-id", projectId, "--label", "Codex", ...extraArgs], {
      cwd: repo, env: { ...process.env, KANBAN_CARDS_CONFIG_DIR: configDirectory }, stdio: ["pipe", "pipe", "pipe"]
    });
    processes.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", c => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", c => { stderr += c; });
    const done = new Promise<Result>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    child.stdin.end();
    return { child, done };
  }
  return { directory, home, repo, config, pending, binding, api, start, polled,
    get starts() { return starts; }, get polls() { return polls; }, setMode(value: Mode) { mode = value; },
    async close() {
      for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}

function secretsAbsent(result: Result) {
  assert.equal(result.stdout.includes(deviceToken), false);
  assert.equal(result.stderr.includes(deviceToken), false);
  assert.equal(result.stdout.includes(credential), false);
  assert.equal(result.stderr.includes(credential), false);
}
async function exists(file: string) { return fs.stat(file).then(() => true, () => false); }

test("native pairing waits for approval, verifies the Workspace and Project, and saves private credentials separately", { timeout: 15_000 }, async () => {
  await fixture("pending-approved", async f => {
    const run = f.start();
    await f.polled;
    assert.equal(await exists(f.config), false);
    assert.equal(await exists(f.binding), false);
    assert.equal((await fs.stat(f.pending)).mode & 0o777, 0o600);
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    secretsAbsent(result);
    assert.match(result.stdout, /Approval code: ABCD-EFGH/);
    assert.match(result.stdout, /Set up Codex, then Review approval code/);
    assert.match(result.stdout, /approve Agent access/);
    assert.equal(f.starts, 1);
    assert.equal(f.polls, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(f.config, "utf8")), { apiBaseUrl: f.api, token: credential, actor: "Codex" });
    assert.equal((await fs.stat(f.config)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(f.config))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await fs.readFile(f.binding, "utf8")), { projectId });
    assert.equal(await exists(f.pending), false);
    assert.equal((await fs.readFile(f.binding, "utf8")).includes(credential), false);
    const repeated = await f.start().done;
    assert.equal(repeated.code, 0, repeated.stderr);
    secretsAbsent(repeated);
    assert.match(repeated.stdout, /already approved/);
    assert.equal(f.starts, 1, "repeating a successful connection must not issue another pairing");
    assert.equal(f.polls, 2);
  });
});

test("an interrupted approval resumes the same pairing without issuing another connection", { timeout: 15_000 }, async () => {
  await fixture("pending", async f => {
    const initial = f.start();
    await f.polled;
    initial.child.kill("SIGTERM");
    const interrupted = await initial.done;
    secretsAbsent(interrupted);
    assert.equal(f.starts, 1);
    assert.equal(await exists(f.config), false);
    assert.equal(await exists(f.binding), false);
    const stored = JSON.parse(await fs.readFile(f.pending, "utf8"));
    assert.equal(stored.userCode, "ABCD-EFGH");
    assert.equal((await fs.stat(f.pending)).mode & 0o777, 0o600);
    f.setMode("approved");
    const resumed = await f.start().done;
    assert.equal(resumed.code, 0, resumed.stderr);
    secretsAbsent(resumed);
    assert.match(resumed.stdout, /ABCD-EFGH/);
    assert.equal(f.starts, 1);
    assert.equal(await exists(f.pending), false);
  });
});

for (const mode of ["denied", "expired", "wrong-workspace", "wrong-session", "wrong-url", "wrong-project", "secret-error", "read-only"] as const) {
  test(`pairing ${mode} cannot save a credential or change the Project binding`, { timeout: 15_000 }, async () => {
    await fixture(mode, async f => {
      await fs.mkdir(path.dirname(f.config), { mode: 0o700 });
      const previous = { apiBaseUrl: "https://previous.kanban.cards/api", token: "synthetic-previous-secret", actor: "Previous" };
      await fs.writeFile(f.config, JSON.stringify(previous), { mode: 0o600 });
      await fs.writeFile(f.binding, JSON.stringify({ projectId: "project-previous" }));
      const result = await f.start().done;
      assert.equal(result.code, 1);
      secretsAbsent(result);
      assert.equal(result.stdout.includes(previous.token), false);
      assert.equal(result.stderr.includes(previous.token), false);
      assert.deepEqual(JSON.parse(await fs.readFile(f.config, "utf8")), previous);
      assert.deepEqual(JSON.parse(await fs.readFile(f.binding, "utf8")), { projectId: "project-previous" });
      if (mode === "denied" || mode === "expired") assert.equal(await exists(f.pending), false);
      if (mode === "secret-error") assert.match(result.stderr, /rejected the request \(500\)/);
    });
  });
}

test("connect rejects credential arguments and storage inside the repository before network requests", { timeout: 15_000 }, async () => {
  await fixture("approved", async f => {
    for (const args of [["--token", credential], [credential]]) {
      const result = await f.start(args).done;
      assert.equal(result.code, 1);
      secretsAbsent(result);
    }
    const result = await f.start([], f.repo).done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /outside the repository/);
    assert.equal(f.starts, 0);
    assert.equal(await exists(f.config), false);
    assert.equal(await exists(f.binding), false);
  });
});


test("a saved read-only credential cannot claim native read/write approval", { timeout: 15_000 }, async () => {
  await fixture("read-only", async f => {
    await fs.mkdir(path.dirname(f.config), { mode: 0o700 });
    const previous = { apiBaseUrl: f.api, token: credential, actor: "Codex" };
    await fs.writeFile(f.config, JSON.stringify(previous), { mode: 0o600 });
    await fs.writeFile(f.binding, JSON.stringify({ projectId }));
    const result = await f.start().done;
    assert.equal(result.code, 1);
    secretsAbsent(result);
    assert.equal(f.starts, 1, "a read-only key must request explicit approval instead of skipping pairing");
    assert.equal(result.stdout.includes("already approved"), false);
    assert.match(result.stderr, /read\/write access/);
    assert.deepEqual(JSON.parse(await fs.readFile(f.config, "utf8")), previous);
    assert.deepEqual(JSON.parse(await fs.readFile(f.binding, "utf8")), { projectId });
  });
});


test("explicit private storage stays isolated and rejects relative or symlinked repository paths before pairing", { timeout: 15_000 }, async () => {
  await fixture("approved", async f => {
    const isolated = path.join(f.directory, "isolated-connection");
    const result = await f.start([], isolated).done;
    assert.equal(result.code, 0, result.stderr);
    secretsAbsent(result);
    assert.equal(await exists(f.config), false, "an explicit directory must not write another connection location");
    const saved = JSON.parse(await fs.readFile(path.join(isolated, "config.json"), "utf8"));
    assert.deepEqual(saved, { apiBaseUrl: f.api, token: credential, actor: "Codex" });
    assert.equal((await fs.stat(isolated)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(isolated, "config.json"))).mode & 0o777, 0o600);
    const repeated = await f.start([], isolated).done;
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(f.starts, 1, "every retry must read the same explicit private connection");
  });
  await fixture("approved", async f => {
    const link = path.join(f.directory, "repository-link");
    await fs.symlink(f.repo, link);
    for (const directory of ["relative-private", path.join(link, "private")]) {
      const result = await f.start([], directory).done;
      assert.equal(result.code, 1);
      secretsAbsent(result);
      assert.match(result.stderr, /absolute private directory|outside the repository/);
    }
    assert.equal(f.starts, 0);
    assert.equal(await exists(path.join(f.repo, "private")), false, "reject a symlinked ancestor before creating anything inside the repository");
    assert.equal(await exists(f.config), false);
  });
});
