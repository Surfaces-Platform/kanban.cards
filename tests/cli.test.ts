import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLIENT_PATH = path.join(__dirname, "..", ".agents", "skills", "kanban-cards", "scripts", "kanban-cards-client.mjs");

test("kanban-cards client setup writes 0600 config without echoing the token", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-cli-home-"));
  const env = cleanEnv({ HOME: tempHome });

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      CLIENT_PATH,
      "setup",
      "--url",
      "https://kanban.cards/api",
      "--token",
      "kcagt_secret_token",
      "--board",
      "board-1",
      "--agent",
      "agent-a"
    ], { env });

    assert.doesNotMatch(stdout, /kcagt_secret_token/);
    const result = JSON.parse(stdout);
    assert.equal(result.apiBaseUrl, "https://kanban.cards/api");
    assert.equal(result.boardId, "board-1");
    assert.equal(result.agentId, "agent-a");
    assert.equal(result.tokenConfigured, true);

    const configPath = path.join(tempHome, ".kanban-cards", "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(config.token, "kcagt_secret_token");
    assert.equal(config.boardId, "board-1");
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("kanban-cards client reads config after env vars", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-cli-home-"));
  const baseEnv = cleanEnv({ HOME: tempHome });

  try {
    await execFileAsync(process.execPath, [
      CLIENT_PATH,
      "setup",
      "--url",
      "https://kanban.cards/api",
      "--token",
      "kcagt_config_token",
      "--board",
      "board-1",
      "--agent",
      "agent-a"
    ], { env: baseEnv });

    const configOnly = JSON.parse((await execFileAsync(process.execPath, [CLIENT_PATH, "config"], { env: baseEnv })).stdout);
    assert.equal(configOnly.apiBaseUrl, "https://kanban.cards/api");
    assert.equal(configOnly.boardId, "board-1");
    assert.equal(configOnly.agentId, "agent-a");
    assert.equal(configOnly.tokenConfigured, true);

    const overrideEnv = cleanEnv({
      HOME: tempHome,
      KANBAN_CARDS_API_BASE_URL: "https://override.test/api",
      KANBAN_CARDS_API_TOKEN: "kcagt_env_token",
      KANBAN_CARDS_BOARD_ID: "board-2",
      KANBAN_CARDS_AGENT_ID: "agent-b"
    });
    const overridden = JSON.parse((await execFileAsync(process.execPath, [CLIENT_PATH, "config"], { env: overrideEnv })).stdout);
    assert.equal(overridden.apiBaseUrl, "https://override.test/api");
    assert.equal(overridden.boardId, "board-2");
    assert.equal(overridden.agentId, "agent-b");
    assert.equal(overridden.tokenConfigured, true);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

function cleanEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.KANBAN_CARDS_API_BASE_URL;
  delete env.KANBAN_CARDS_API_TOKEN;
  delete env.KANBAN_CARDS_BOARD_ID;
  delete env.KANBAN_CARDS_AGENT_ID;
  delete env.INSTRUCT_API_BASE_URL;
  delete env.INSTRUCT_API_TOKEN;
  return { ...env, ...overrides };
}
