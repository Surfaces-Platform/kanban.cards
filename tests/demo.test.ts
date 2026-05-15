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
  "product-intake",
  "traveller-research",
  "designer-flow",
  "engineer-build",
  "reviewer-change-request",
  "engineer-constraints",
  "reviewer-approval",
  "product-closeout"
] as const;

test("demo harness prepares scoped configs and runs the agent trip planner product buildout", async () => {
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
    assert.match(prepared.stdout, /Workflow prepared\./);
    assert.doesNotMatch(prepared.stdout, /kcagt_[A-Za-z0-9_-]+/);

    for (const agent of ["product", "research", "designer", "engineer", "reviewer"]) {
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
    assert.ok(runState.cards.productBrief);
    assert.ok(runState.cards.researchBrief);
    assert.ok(runState.cards.experienceMap);
    assert.ok(runState.cards.planningSlice);
    assert.ok(runState.comments.constraintChangeRequest);

    const workspace = JSON.parse(await fs.readFile(dataPath, "utf8")) as WorkspaceState;
    const board = requireBoard(workspace);
    assert.equal(board.name, "Agent Trip Planner MVP Buildout");
    assert.deepEqual(board.lanes.map((lane) => lane.title), [
      "Product Intake",
      "Traveller Research",
      "Experience Design",
      "Build",
      "Review",
      "Pilot Ready"
    ]);

    const productCard = board.workItems.find((item) => item.id === runState.cards.productBrief);
    const researchCard = board.workItems.find((item) => item.id === runState.cards.researchBrief);
    const designCard = board.workItems.find((item) => item.id === runState.cards.experienceMap);
    const planningCard = board.workItems.find((item) => item.id === runState.cards.planningSlice);
    assert.equal(productCard?.laneId, "pilot-ready");
    assert.equal(researchCard?.laneId, "experience-design");
    assert.equal(designCard?.laneId, "build");
    assert.equal(planningCard?.laneId, "pilot-ready");

    const changeRequest = planningCard?.comments.find((comment) => comment.id === runState.comments.constraintChangeRequest);
    assert.equal(changeRequest?.author, "agent-qa-reviewer");
    assert.equal(changeRequest?.kind, "change_request");
    assert.equal(changeRequest?.status, "resolved");
    assert.ok(productCard?.comments.some((comment) => comment.author === "agent-product-lead" && comment.text.includes("Product Lead created")));
    assert.ok(researchCard?.comments.some((comment) => comment.author === "agent-traveller-research" && comment.text.includes("created this research card") && comment.text.includes("moved it toward design")));
    assert.ok(designCard?.comments.some((comment) => comment.author === "agent-experience-designer" && comment.text.includes("created the experience map") && comment.text.includes("moved the card into Build")));
    assert.ok(planningCard?.comments.some((comment) => comment.author === "agent-product-engineer" && comment.text.includes("created the build slice")));
    assert.ok(planningCard?.summary.includes("Product Engineer updated the planning slice"));
    assert.ok(changeRequest?.text.includes("QA Reviewer opened this change request"));
    assert.ok(planningCard?.comments.some((comment) => comment.author === "agent-product-engineer" && comment.text.includes("Product Engineer resolved the change request")));
    assert.ok(planningCard?.comments.some((comment) => comment.author === "agent-qa-reviewer" && comment.text.includes("QA Reviewer approved") && comment.text.includes("moved it to Pilot Ready")));
    assert.ok(productCard?.comments.some((comment) => comment.author === "agent-product-lead" && comment.text.includes("updated the original brief") && comment.text.includes("moved it to Pilot Ready")));
    assert.ok(productCard?.summary.includes("Product Lead closed the buildout"));
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
  const board = workspace.boards.find((candidate) => candidate.id === "agent-trip-planner-mvp-buildout");
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
