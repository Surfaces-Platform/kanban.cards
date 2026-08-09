import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../src/server";

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
  const server = createServer(app);
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
