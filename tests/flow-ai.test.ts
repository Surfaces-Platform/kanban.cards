import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { createApp } from "../src/server";

test("flow AI draft uses LM Studio structured output and leaves the board unchanged", async () => {
  await withEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-flow-ai-"));
    const dataPath = path.join(tempDir, "state.json");
    const apiToken = "admin-token";
    const draft = boardDraft(
      [
        lane("Plan Lane", "Plan", "Decide the work.", "Coordinator Agent", "Reviewer Agent"),
        lane("Release", "Release", "Ship the work.", "Coordinator Agent", "Reviewer Agent")
      ],
      [
        agent("Coordinator Agent", "Coordinator Agent", "Workflow owner", ["Plan Lane", "Release"]),
        agent("Reviewer Agent", "Reviewer Agent", "Human-facing reviewer", ["Plan Lane", "Release"])
      ]
    );
    const lmStudio = await listenLmStudio({
      response: {
        summary: "Drafted a tighter release flow.",
        warnings: ["Review release ownership before applying."],
        draft
      }
    });
    process.env.LM_STUDIO_BASE_URL = lmStudio.baseUrl;
    delete process.env.LM_STUDIO_MODEL;

    const server = await listen(createApp({ dataPath, apiToken }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
      const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), {
        name: "Flow AI board",
        lanes: [
          lane("intake", "Intake", "Capture the work."),
          lane("review", "Review", "Review the work.")
        ],
        agentSpecs: [agent("agent-coordinator", "Coordinator", "Owner", ["intake", "review"])]
      });
      const original = await getJson(`${baseUrl}/api/boards/${board.id}`, bearerHeaders(apiToken));

      const result = await writeJson(`${baseUrl}/api/boards/${board.id}/flow/ai-draft`, bearerHeaders(apiToken), {
        prompt: "Make this a product release workflow."
      });

      assert.equal(result.summary, "Drafted a tighter release flow.");
      assert.equal(result.model, "mock-flow-model");
      assert.equal(result.provider, "lm-studio");
      assert.equal(result.draft.lanes[0].id, "plan-lane");
      assert.equal(result.draft.agentSpecs[0].id, "coordinator-agent");
      assert.deepEqual(result.draft.agentSpecs[0].laneIds, ["plan-lane", "release"]);

      const afterDraft = await getJson(`${baseUrl}/api/boards/${board.id}`, bearerHeaders(apiToken));
      assert.deepEqual(afterDraft.lanes, original.lanes);
      assert.deepEqual(afterDraft.agentSpecs, original.agentSpecs);
      assert.equal(afterDraft.workItems.length, original.workItems.length);

      assert.equal(lmStudio.requests.length, 1);
      assert.equal(lmStudio.requests[0].model, "mock-flow-model");
      assert.equal(lmStudio.requests[0].response_format.type, "json_schema");
      assert.match(lmStudio.requests[0].messages[1].content, /Make this a product release workflow/);

      const events = await getJson(`${baseUrl}/api/boards/${board.id}/events?limit=10`, bearerHeaders(apiToken));
      const event = events.events.find((candidate: any) => candidate.payload.reason === "board_flow_draft_generated");
      assert.ok(event);
      assert.equal(event.payload.resource.type, "board_flow");
      assert.equal(event.payload.model, "mock-flow-model");
      assert.equal(event.payload.laneCount, 2);
    } finally {
      await closeServer(server);
      await closeServer(lmStudio.server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("flow AI draft returns 503 without mutating when LM Studio has no model", async () => {
  await withEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-flow-ai-"));
    const dataPath = path.join(tempDir, "state.json");
    const apiToken = "admin-token";
    const lmStudio = await listenLmStudio({ models: [] });
    process.env.LM_STUDIO_BASE_URL = lmStudio.baseUrl;
    delete process.env.LM_STUDIO_MODEL;

    const server = await listen(createApp({ dataPath, apiToken }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
      const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), {
        name: "Unavailable model board",
        lanes: [
          lane("todo", "Todo", "Work to do."),
          lane("done", "Done", "Finished work.")
        ],
        agentSpecs: []
      });
      const card = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(apiToken), {
        title: "Must survive",
        laneId: board.lanes[0].id
      });

      const response = await fetch(`${baseUrl}/api/boards/${board.id}/flow/ai-draft`, {
        method: "POST",
        headers: { ...bearerHeaders(apiToken), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Improve this flow." })
      });
      assert.equal(response.status, 503);

      const after = await getJson(`${baseUrl}/api/boards/${board.id}`, bearerHeaders(apiToken));
      assert.deepEqual(after.lanes, board.lanes);
      assert.equal(after.workItems.length, 1);
      assert.equal(after.workItems[0].id, card.id);
      assert.equal(after.workItems[0].laneId, board.lanes[0].id);
    } finally {
      await closeServer(server);
      await closeServer(lmStudio.server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("flow apply preserves cards and remaps removed lanes by id, title, then fallback", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-flow-apply-"));
  const dataPath = path.join(tempDir, "state.json");
  const apiToken = "admin-token";
  const server = await listen(createApp({ dataPath, apiToken }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), {
      name: "Safe apply board",
      lanes: [
        lane("intake", "Intake", "Capture."),
        lane("review", "Review", "Review."),
        lane("archive", "Archive", "Old work.")
      ],
      agentSpecs: []
    });
    const intakeCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(apiToken), {
      title: "Keep by lane id",
      laneId: "intake"
    });
    const reviewCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(apiToken), {
      title: "Move by lane title",
      laneId: "review"
    });
    const archiveCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(apiToken), {
      title: "Move to fallback",
      laneId: "archive"
    });

    const draft = boardDraft([
      lane("intake", "Intake", "Capture and qualify."),
      lane("review-v2", "Review", "Review with stronger gates."),
      lane("release", "Release", "Release safely.")
    ]);
    const result = await writeJson(`${baseUrl}/api/boards/${board.id}/flow/apply`, bearerHeaders(apiToken), {
      draft,
      flowPrompt: "Preserve cards while changing lanes.",
      source: "manual"
    });

    assert.equal(result.board.workItems.length, 3);
    const byId = new Map<string, any>(result.board.workItems.map((item: any) => [item.id, item]));
    assert.equal(byId.get(intakeCard.id).laneId, "intake");
    assert.equal(byId.get(reviewCard.id).laneId, "review-v2");
    assert.equal(byId.get(archiveCard.id).laneId, "intake");
    assert.equal(result.movedCards.length, 2);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /2 cards moved/);

    const after = await getJson(`${baseUrl}/api/boards/${board.id}`, bearerHeaders(apiToken));
    assert.equal(after.isEditingFlow, false);
    assert.equal(after.configDraft, null);
    assert.equal(after.flowPrompt, "Preserve cards while changing lanes.");
    assert.equal(after.workItems.length, 3);

    const events = await getJson(`${baseUrl}/api/boards/${board.id}/events?limit=10`, bearerHeaders(apiToken));
    const event = events.events.find((candidate: any) => candidate.payload.reason === "board_flow_applied");
    assert.ok(event);
    assert.equal(event.payload.source, "manual");
    assert.equal(event.payload.movedCards.length, 2);
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("agent tokens cannot generate or apply flow drafts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-flow-agent-"));
  const dataPath = path.join(tempDir, "state.json");
  const tokenDataPath = path.join(tempDir, "agent-tokens.json");
  const apiToken = "admin-token";
  const server = await listen(createApp({ dataPath, tokenDataPath, apiToken }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), {
      name: "Agent denied board",
      lanes: [
        lane("todo", "Todo", "Work to do.", "agent-a"),
        lane("done", "Done", "Finished work.", "agent-a")
      ],
      agentSpecs: [agent("agent-a", "Agent A", "Owner", ["todo", "done"])]
    });
    const createdToken = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-tokens`, bearerHeaders(apiToken), {
      agentId: "agent-a",
      label: "Agent flow token"
    });
    const agentHeaders = bearerHeaders(createdToken.token);

    const draftResponse = await fetch(`${baseUrl}/api/boards/${board.id}/flow/ai-draft`, {
      method: "POST",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Agents should not manage board flow." })
    });
    assert.equal(draftResponse.status, 403);

    const applyResponse = await fetch(`${baseUrl}/api/boards/${board.id}/flow/apply`, {
      method: "POST",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        draft: boardDraft([
          lane("todo", "Todo", "Work to do."),
          lane("done", "Done", "Finished work.")
        ]),
        source: "manual"
      })
    });
    assert.equal(applyResponse.status, 403);
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function boardDraft(lanes: any[], agentSpecs: any[] = []) {
  return { lanes, agentSpecs };
}

function lane(
  id: string,
  title: string,
  description: string,
  defaultOwnerAgentId: string | null = null,
  defaultReviewerAgentId: string | null = null
) {
  return {
    id,
    title,
    description,
    defaultOwnerAgentId,
    defaultReviewerAgentId,
    gate: {
      title: `${title} gate`,
      checks: ["Output is reviewable."]
    }
  };
}

function agent(id: string, name: string, role: string, laneIds: string[]) {
  return {
    id,
    name,
    role,
    laneIds,
    instructions: `${name} instructions.`,
    skillNotes: "$kanban-cards"
  };
}

async function listen(app: Express): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function listenLmStudio(options: {
  models?: string[];
  response?: unknown;
} = {}): Promise<{ server: Server; baseUrl: string; requests: any[] }> {
  const requests: any[] = [];
  const models = options.models ?? ["mock-flow-model"];
  const responsePayload = options.response ?? {
    summary: "Draft ready.",
    warnings: [],
    draft: boardDraft([
      lane("todo", "Todo", "Work to do."),
      lane("done", "Done", "Finished work.")
    ])
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      writeResponse(res, 200, { data: models.map((id) => ({ id })) });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = JSON.parse(await readRequestBody(req));
      requests.push(body);
      writeResponse(res, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify(responsePayload)
            }
          }
        ]
      });
      return;
    }
    writeResponse(res, 404, { error: "not found" });
  });
  await listenRaw(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${serverPort(server)}/v1`,
    requests
  };
}

async function listenRaw(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function writeJson<T = any>(url: string, headers: Record<string, string>, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function withEnv(run: () => Promise<void>): Promise<void> {
  const previous = {
    LM_STUDIO_BASE_URL: process.env.LM_STUDIO_BASE_URL,
    LM_STUDIO_MODEL: process.env.LM_STUDIO_MODEL,
    LM_STUDIO_API_KEY: process.env.LM_STUDIO_API_KEY,
    FLOW_AI_TIMEOUT_MS: process.env.FLOW_AI_TIMEOUT_MS
  };
  try {
    await run();
  } finally {
    restoreEnv("LM_STUDIO_BASE_URL", previous.LM_STUDIO_BASE_URL);
    restoreEnv("LM_STUDIO_MODEL", previous.LM_STUDIO_MODEL);
    restoreEnv("LM_STUDIO_API_KEY", previous.LM_STUDIO_API_KEY);
    restoreEnv("FLOW_AI_TIMEOUT_MS", previous.FLOW_AI_TIMEOUT_MS);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
