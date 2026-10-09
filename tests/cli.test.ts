import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileAccessStore } from "../src/access-store";
import type { PasskeyAuthConfig } from "../src/passkey-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const CLIENT_PATH = path.join(process.cwd(), ".agents", "skills", "kanban-cards", "scripts", "kanban-cards-client.mjs");

test("the skill helper keeps credentials user-scoped and reconciles a bound project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-v2-cli-"));
  const home = path.join(directory, "home");
  const repository = path.join(directory, "repo");
  const dataPath = path.join(directory, "workspace.json");
  const token = "cli-owner-secret";
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(home, { recursive: true });

  const app = createApp({ dataPath, apiToken: token, requireDatabase: false });
  const observedVersionHeaders: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers["if-match"] !== undefined) {
      res.statusCode = 412;
      res.end("A platform boundary rejected If-Match.");
      return;
    }
    const version = req.headers["x-kanban-version"];
    if (typeof version === "string") observedVersionHeaders.push(version);
    app(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const env = cleanEnv({ HOME: home });

  try {
    await assert.rejects(
      runCli(["setup", "--url", "http://example.com/api", "--token-stdin"], {
        cwd: repository,
        env,
        input: `${token}\n`
      }),
      /requires https:\/\//
    );
    const setup = await runCli(["setup", "--url", baseUrl, "--actor", "cli-test", "--token-stdin"], {
      cwd: repository,
      env,
      input: `${token}\n`
    });
    assert.doesNotMatch(setup.stdout, new RegExp(token));
    assert.equal(JSON.parse(setup.stdout).tokenConfigured, true);

    const userConfigPath = path.join(home, ".kanban-cards", "config.json");
    const userConfig = JSON.parse(await fs.readFile(userConfigPath, "utf8"));
    assert.equal(userConfig.apiBaseUrl, baseUrl);
    assert.equal(userConfig.actor, "cli-test");
    assert.equal(userConfig.token, token);
    assert.equal((await fs.stat(userConfigPath)).mode & 0o777, 0o600);

    const createdOutput = await runCli([
      "create-project",
      "--name", "CLI project",
      "--columns", '[{"id":"inbox","name":"Inbox"},{"id":"doing","name":"Doing"},{"id":"done","name":"Done"}]',
      "--idempotency-key", "cli-project-v1"
    ], { cwd: repository, env });
    const project = unwrap(JSON.parse(createdOutput.stdout), "project");
    assert.equal(project.name, "CLI project");

    await runCli(["bind", "--project", project.id], { cwd: repository, env });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(repository, ".kanban-cards.json"), "utf8")), { projectId: project.id });

    const createArgs = [
      "create-card",
      "--title", "Execute the recommendation",
      "--body", "Keep the board reconciled.",
      "--column", "inbox",
      "--external-key", "recommendation:execute"
    ];
    const firstCard = unwrap(JSON.parse((await runCli(createArgs, { cwd: repository, env })).stdout), "card");
    const retriedCard = unwrap(JSON.parse((await runCli(createArgs, { cwd: repository, env })).stdout), "card");
    assert.equal(retriedCard.id, firstCard.id);

    await runCli([
      "comment", "--card", firstCard.id, "--text", "Implemented the first execution step.", "--idempotency-key", "cli-comment-v1"
    ], { cwd: repository, env });
    await assert.rejects(
      runCli(["move-card", "--card", firstCard.id, "--column", "doing"], { cwd: repository, env }),
      /Missing --version/
    );
    await runCli([
      "move-card", "--card", firstCard.id, "--column", "doing", "--version", "2"
    ], { cwd: repository, env });
    assert.deepEqual(observedVersionHeaders, ["2"]);

    const cards = JSON.parse((await runCli(["cards"], { cwd: repository, env })).stdout);
    assert.equal(cards.cards.length, 1);
    assert.equal(cards.cards[0].columnId, "doing");

    const activity = JSON.parse((await runCli(["activity", "--limit", "20"], { cwd: repository, env })).stdout);
    assert.ok(activity.activity.some((entry: any) => entry.actor.label === "cli-test" && entry.actor.channel === "api"));
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the skill helper verifies a tenant-bound AgentConnection, preserves stable Activity attribution, and fails after revocation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-agent-cli-"));
  const home = path.join(directory, "home");
  const repository = path.join(directory, "repo");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(home, { recursive: true });

  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const owner = { providerSubject: "user_cliAgent123", email: "cli-agent@example.com", displayName: "CLI Agent Owner" };
  const workspace = await accessStore.createWorkspace({ ...owner, slug: "cli-agent", name: "CLI Agent Workspace" });
  const issued = await accessStore.createAgentConnection({
    providerSubject: owner.providerSubject,
    workspaceId: workspace.id,
    label: "Tenant automation",
    scopes: ["read", "write"]
  });
  const workspaceStoreResolver = createWorkspaceStoreResolver({
    dataPath: path.join(directory, "legacy.json"),
    workspaceDirectory: path.join(directory, "workspaces")
  });
  let application: ReturnType<typeof createApp> | null = null;
  const server = createServer((req, res) => {
    if (!application) {
      res.statusCode = 503;
      res.end("Test application is starting.");
      return;
    }
    application(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const rootHost = `localhost:${port}`;
  const passkeyAuthConfig: PasskeyAuthConfig = {
    sessionSecret: "cli-agent-session-secret-01234567890123456789",
    authHost: `auth.localhost:${port}`,
    authOrigin: `http://auth.localhost:${port}`,
    rpId: "auth.localhost",
    rootOrigins: [`http://${rootHost}`],
    sessionTtlSeconds: 3_600
  };
  application = createApp({
    accessStore,
    passkeyAuthConfig,
    requireDatabase: false,
    rootHost,
    store: workspaceStoreResolver.resolve("default"),
    workspaceStoreResolver
  });
  const rootApi = `http://localhost:${port}/api`;
  const tenantApi = `http://${workspace.slug}.localhost:${port}/api`;
  const env = cleanEnv({ HOME: home });

  try {
    await assert.rejects(
      runCli(["setup", "--url", rootApi, "--actor", "Forged caller label", "--token-stdin"], { cwd: repository, env, input: `${issued.credential}\n` }),
      /exact Workspace tenant API|Workspace unavailable/
    );
    const setup = await runCli(["setup", "--url", tenantApi, "--actor", "Forged caller label", "--token-stdin"], {
      cwd: repository,
      env,
      input: `${issued.credential}\n`
    });
    assert.equal(JSON.parse(setup.stdout).tokenConfigured, true);

    const project = unwrap(JSON.parse((await runCli(["create-project", "--name", "Agent CLI project", "--idempotency-key", "agent-cli-project"], { cwd: repository, env })).stdout), "project");
    await runCli(["bind", "--project", project.id], { cwd: repository, env });
    await runCli(["create-card", "--title", "Agent-created Card", "--external-key", "agent-cli-card"], { cwd: repository, env });
    const activity = JSON.parse((await runCli(["activity", "--limit", "20"], { cwd: repository, env })).stdout);
    const created = activity.activity.find((entry: any) => entry.action === "card.created");
    assert.deepEqual(created.actor, { channel: "api", label: "Tenant automation", agentConnectionId: issued.connection.id });

    await accessStore.revokeAgentConnection(owner.providerSubject, workspace.id, issued.connection.id);
    await assert.rejects(runCli(["cards"], { cwd: repository, env }), /Authentication required|401/);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function runCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(options.input || "");
  });
}

function cleanEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KANBAN_CARDS_API_TOKEN;
  delete env.KANBAN_CARDS_API_BASE_URL;
  delete env.KANBAN_CARDS_PROJECT_ID;
  return { ...env, ...overrides };
}

function unwrap(value: any, key: string): any {
  return value?.[key] ?? value;
}
