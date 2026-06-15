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
  "risk-triage",
  "engineer-plan",
  "engineer-implementation",
  "security-change-request",
  "engineer-evidence",
  "security-approval",
  "coordinator-closeout"
] as const;

test("demo harness prepares scoped configs and runs the private beta security release", async () => {
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
    apiToken: ""
  }));
  const env = cleanEnv({
    HOME: homeDir,
    KANBAN_CARDS_DEMO_DIR: demoDir,
    KANBAN_CARDS_DEMO_API_URL: `http://127.0.0.1:${serverPort(server)}/api`
  });

  try {
    const prepared = await runDemo(["prepare"], env);
    assert.match(prepared.stdout, /Workflow prepared\./);
    assert.doesNotMatch(prepared.stdout, /kcagt_[A-Za-z0-9_-]+/);

    for (const agent of ["coordinator", "risk", "engineer", "security"]) {
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
    assert.match(verify.stdout, /Workflow verification passed\./);

    const runState = JSON.parse(await fs.readFile(path.join(demoDir, "run-state.json"), "utf8"));
    assert.deepEqual(runState.completedSteps, [...DEMO_STEPS]);
    assert.ok(runState.cards.releaseBrief);
    assert.ok(runState.cards.riskBrief);
    assert.ok(runState.cards.engineeringPlan);
    assert.ok(runState.cards.releaseImplementation);
    assert.ok(runState.comments.securityChangeRequest);

    const workspace = JSON.parse(await fs.readFile(dataPath, "utf8")) as WorkspaceState;
    const board = requireBoard(workspace);
    assert.equal(board.name, "Private Beta Security Release");
    assert.deepEqual(board.lanes.map((lane) => lane.title), [
      "Intake",
      "Risk Triage",
      "Engineering Plan",
      "Implementation",
      "Security Review",
      "Release Ready"
    ]);

    const releaseCard = board.workItems.find((item) => item.id === runState.cards.releaseBrief);
    const riskCard = board.workItems.find((item) => item.id === runState.cards.riskBrief);
    const planCard = board.workItems.find((item) => item.id === runState.cards.engineeringPlan);
    const implementationCard = board.workItems.find((item) => item.id === runState.cards.releaseImplementation);
    assert.equal(releaseCard?.laneId, "release-ready");
    assert.equal(riskCard?.laneId, "engineering-plan");
    assert.equal(planCard?.laneId, "implementation");
    assert.equal(implementationCard?.laneId, "release-ready");
    assert.equal(releaseCard?.delivered, true);

    const changeRequest = implementationCard?.comments.find((comment) => comment.id === runState.comments.securityChangeRequest);
    assert.equal(changeRequest?.author, "agent-security-reviewer");
    assert.equal(changeRequest?.kind, "change_request");
    assert.equal(changeRequest?.status, "resolved");
    assert.ok(releaseCard?.comments.some((comment) => comment.author === "agent-release-coordinator" && comment.text.includes("opened the release packet")));
    assert.ok(riskCard?.comments.some((comment) => comment.author === "agent-risk-triage" && comment.text.includes("live event replay gaps")));
    assert.ok(planCard?.comments.some((comment) => comment.author === "agent-release-engineer" && comment.text.includes("implementation plan")));
    assert.ok(implementationCard?.comments.some((comment) => comment.author === "agent-release-engineer" && comment.text.includes("rotated stale tokens")));
    assert.ok(changeRequest?.text.includes("Security Reviewer opened this change request"));
    assert.ok(implementationCard?.comments.some((comment) => comment.author === "agent-release-engineer" && comment.text.includes("Release Engineer resolved the change request")));
    assert.ok(implementationCard?.comments.some((comment) => comment.author === "agent-security-reviewer" && comment.text.includes("Security Reviewer approved")));
    assert.equal(implementationCard?.approvals.length, 1);
    assert.ok(releaseCard?.comments.some((comment) => comment.author === "agent-release-coordinator" && comment.text.includes("closed the release packet")));
    assert.ok(releaseCard?.summary.includes("rollback ownership"));
    assertOperationalBoardCopy(board);
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
  const board = workspace.boards.find((candidate) => candidate.id === "private-beta-security-release");
  assert.ok(board);
  return board;
}

function assertOperationalBoardCopy(board: Board): void {
  const bannedPatterns = [
    /\bdemo\b/i,
    /\bthrowaway\b/i,
    /\brecording\b/i,
    /\bsample\b/i,
    /\bfake\b/i,
    /\bharness\b/i,
    /\bthis shows\b/i,
    /\bthis proves\b/i
  ];
  const visibleCopy = [
    board.name,
    board.flowPrompt,
    ...board.lanes.flatMap((lane) => [
      lane.title,
      lane.description,
      lane.gate?.title || "",
      ...(lane.gate?.checks || [])
    ]),
    ...board.agentSpecs.flatMap((agent) => [agent.name, agent.role, agent.instructions, agent.skillNotes || ""]),
    ...board.workItems.flatMap((item) => [
      item.title,
      item.summary,
      ...item.comments.map((comment) => comment.text)
    ])
  ];
  assert.equal(visibleCopy.find((text) => bannedPatterns.some((pattern) => pattern.test(text))), undefined);
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
