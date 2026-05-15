import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createFileAgentTokenStore } from "../src/agent-token-store";
import { createApp } from "../src/server";
import { createStateStore } from "../src/state-store";
import type { Board, WorkspaceState } from "../src/types";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, "..");
const DEMO_SCRIPT = path.join(REPO_ROOT, "scripts", "demo.ts");
const DEMO_STEPS = [
  "coordinator-intake",
  "researcher-research",
  "producer-draft",
  "reviewer-change-request",
  "producer-revise",
  "reviewer-release",
  "coordinator-closeout"
] as const;

test("demo harness prepares scoped configs and runs the launch brief flow", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-demo-"));
  const demoDir = path.join(tempDir, ".demo");
  const homeDir = path.join(tempDir, "home");
  const dataPath = path.join(demoDir, "kanban-cards-state.json");
  const tokenDataPath = path.join(demoDir, "agent-access-tokens.json");
  const server = await listen(createApp({
    staticDir: REPO_ROOT,
    store: createStateStore(dataPath),
    tokenStore: createFileAgentTokenStore(tokenDataPath),
    requireAuth: false,
    requireDatabase: false,
    apiToken: "",
    basicUser: "",
    basicPassword: ""
  }));
  const env = cleanEnv({
    HOME: homeDir,
    KANBAN_CARDS_DEMO_DIR: demoDir,
    KANBAN_CARDS_DEMO_API_URL: `http://127.0.0.1:${serverPort(server)}/api`
  });

  try {
    const prepared = await runDemo(["prepare"], env);
    assert.match(prepared.stdout, /Demo prepared\./);
    assert.doesNotMatch(prepared.stdout, /kcagt_[A-Za-z0-9_-]+/);

    for (const agent of ["coordinator", "researcher", "producer", "reviewer"]) {
      const configPath = path.join(demoDir, "configs", `${agent}.json`);
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.match(config.token, /^kcagt_/);
      assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    }

    for (const step of DEMO_STEPS) {
      const result = await runDemo(["step", step], env);
      assert.match(result.stdout, new RegExp(`\\[${step}\\]`));
      assert.doesNotMatch(result.stdout, /kcagt_[A-Za-z0-9_-]+/);
    }

    const verify = await runDemo(["verify"], env);
    assert.match(verify.stdout, /Demo verification passed\./);

    const runState = JSON.parse(await fs.readFile(path.join(demoDir, "run-state.json"), "utf8"));
    assert.deepEqual(runState.completedSteps, [...DEMO_STEPS]);
    assert.ok(runState.cards.launchBrief);
    assert.ok(runState.cards.researchBrief);
    assert.ok(runState.cards.draftBrief);
    assert.ok(runState.comments.reviewChangeRequest);

    const workspace = JSON.parse(await fs.readFile(dataPath, "utf8")) as WorkspaceState;
    const board = requireBoard(workspace);
    assert.equal(board.name, "Orchestrated Agents Demo - Launch Brief");
    assert.deepEqual(board.lanes.map((lane) => lane.title), ["Intake", "Research", "Draft", "Review", "Release"]);

    const launchCard = board.workItems.find((item) => item.id === runState.cards.launchBrief);
    const researchCard = board.workItems.find((item) => item.id === runState.cards.researchBrief);
    const draftCard = board.workItems.find((item) => item.id === runState.cards.draftBrief);
    assert.equal(launchCard?.laneId, "release");
    assert.equal(researchCard?.laneId, "draft");
    assert.equal(draftCard?.laneId, "release");

    const changeRequest = draftCard?.comments.find((comment) => comment.id === runState.comments.reviewChangeRequest);
    assert.equal(changeRequest?.author, "agent-reviewer");
    assert.equal(changeRequest?.kind, "change_request");
    assert.equal(changeRequest?.status, "resolved");
    assert.ok(draftCard?.comments.some((comment) => comment.author === "agent-producer"));
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function runDemo(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", DEMO_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 1024 * 1024
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function requireBoard(workspace: WorkspaceState): Board {
  const board = workspace.boards.find((candidate) => candidate.id === "demo-board-launch-brief");
  assert.ok(board);
  return board;
}

function cleanEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.KANBAN_CARDS_API_BASE_URL;
  delete env.KANBAN_CARDS_API_TOKEN;
  delete env.KANBAN_CARDS_BOARD_ID;
  delete env.KANBAN_CARDS_AGENT_ID;
  delete env.INSTRUCT_API_BASE_URL;
  delete env.INSTRUCT_API_TOKEN;
  delete env.KANBAN_CARDS_DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.DATABASE_URL;
  delete env.VERCEL;
  env.NODE_ENV = "test";
  return { ...env, ...overrides };
}
