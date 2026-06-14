import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { hashAgentToken } from "../src/agent-token-store";
import { createApp } from "../src/server";

test("scoped agent tokens are one-time, hashed, revocable, and board-agent limited", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-agent-access-"));
    const dataPath = path.join(tempDir, "state.json");
    const tokenDataPath = path.join(tempDir, "agent-tokens.json");
    const adminToken = "admin-token";
    const server = await listen(createApp({
      dataPath,
      tokenDataPath,
      requireAuth: true,
      apiToken: adminToken
    }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(adminToken), {
      name: "Scoped board",
      lanes: [
        lane("Todo", "Ready for work.", "agent-a", "reviewer-a"),
        lane("Review", "Ready for review.", "reviewer-a", "agent-a")
      ],
      agentSpecs: [
        agent("agent-a", "Agent A", "Owner", ["todo"]),
        agent("agent-b", "Agent B", "Owner", ["todo"]),
        agent("reviewer-a", "Reviewer A", "Reviewer", ["review"])
      ]
    });

    const createdToken = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-tokens`, bearerHeaders(adminToken), {
      agentId: "agent-a",
      label: "Agent A laptop"
    });
    assert.match(createdToken.token, /^kcagt_/);
    assert.equal(createdToken.agentId, "agent-a");
    assert.equal(createdToken.last4, createdToken.token.slice(-4));
    assert.match(createdToken.sessionId, /^agsess_/);
    assert.equal(createdToken.projectId, board.projectId);
    assert.deepEqual(createdToken.capabilities, ["view", "create", "update", "comment", "move"]);
    assert.equal(Object.hasOwn(createdToken, "tokenHash"), false);

    const tokenFile = JSON.parse(await fs.readFile(tokenDataPath, "utf8"));
    assert.equal(tokenFile.tokens.length, 1);
    assert.equal(tokenFile.tokens[0].tokenHash, hashAgentToken(createdToken.token));
    assert.doesNotMatch(JSON.stringify(tokenFile), new RegExp(createdToken.token));

    const listed = await getJson(`${baseUrl}/api/boards/${board.id}/agent-tokens`, bearerHeaders(adminToken));
    assert.equal(listed.tokens.length, 1);
    assert.equal(Object.hasOwn(listed.tokens[0], "token"), false);
    assert.equal(Object.hasOwn(listed.tokens[0], "tokenHash"), false);

    const agentHeaders = bearerHeaders(createdToken.token);
    const session = await getJson(`${baseUrl}/api/agent/session`, agentHeaders);
    assert.equal(session.mode, "agent");
    assert.equal(session.board.id, board.id);
    assert.equal(session.agent.id, "agent-a");
    assert.equal(session.token.sessionId, createdToken.sessionId);
    assert.equal(session.token.projectId, board.projectId);

    const usedTokens = await getJson(`${baseUrl}/api/boards/${board.id}/agent-tokens`, bearerHeaders(adminToken));
    assert.ok(usedTokens.tokens[0].lastUsedAt);

    const stateDenied = await fetch(`${baseUrl}/api/state`, { headers: agentHeaders });
    assert.equal(stateDenied.status, 403);

    const boardPatchDenied = await fetch(`${baseUrl}/api/boards/${board.id}`, {
      method: "PATCH",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Denied" })
    });
    assert.equal(boardPatchDenied.status, 403);

    const createdCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, agentHeaders, {
      title: "Agent-owned card",
      laneId: board.lanes[0].id
    });
    assert.equal(createdCard.ownerAgentId, "agent-a");

    const moved = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${createdCard.id}`, agentHeaders, {
      laneId: board.lanes[1].id
    }, "PATCH");
    assert.equal(moved.laneId, board.lanes[1].id);

    const approvalDenied = await fetch(`${baseUrl}/api/boards/${board.id}/work-items/${createdCard.id}`, {
      method: "PATCH",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ approvals: [{ by: "agent-a" }] })
    });
    assert.equal(approvalDenied.status, 403);

    const deliveryDenied = await fetch(`${baseUrl}/api/boards/${board.id}/work-items/${createdCard.id}`, {
      method: "PATCH",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ delivered: true })
    });
    assert.equal(deliveryDenied.status, 403);

    const comment = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${createdCard.id}/comments`, agentHeaders, {
      kind: "progress",
      text: "Ready for review.",
      author: "spoofed"
    });
    assert.equal(comment.author, "agent-a");

    const wrongOwner = await fetch(`${baseUrl}/api/boards/${board.id}/work-items`, {
      method: "POST",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Other agent card",
        laneId: board.lanes[0].id,
        ownerAgentId: "agent-b"
      })
    });
    assert.equal(wrongOwner.status, 403);

    const otherCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(adminToken), {
      title: "Agent B card",
      laneId: board.lanes[0].id,
      ownerAgentId: "agent-b"
    });
    const otherPatch = await fetch(`${baseUrl}/api/boards/${board.id}/work-items/${otherCard.id}`, {
      method: "PATCH",
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ laneId: board.lanes[1].id })
    });
    assert.equal(otherPatch.status, 403);

    const revoked = await fetch(`${baseUrl}/api/boards/${board.id}/agent-tokens/${createdToken.id}`, {
      method: "DELETE",
      headers: bearerHeaders(adminToken)
    });
    assert.equal(revoked.status, 200);

    const afterRevoke = await fetch(`${baseUrl}/api/agent/session`, { headers: agentHeaders });
    assert.equal(afterRevoke.status, 401);
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function lane(title: string, description: string, defaultOwnerAgentId: string | null = null, defaultReviewerAgentId: string | null = null) {
  return {
    id: title.toLowerCase(),
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

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function listen(app: Express): Promise<Server> {
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

async function withPlatformAuthEnv(run: () => Promise<void>): Promise<void> {
  const restore = setEnv({
    OIDC_ISSUER: "https://auth.example.com/",
    OIDC_CLIENT_ID: "test-client",
    OIDC_REDIRECT_URI: "http://127.0.0.1:4317/auth/callback",
    SESSION_SECRET: "test-session-secret-with-enough-entropy",
    PLATFORM_SURFACE_ID: "kanban.cards"
  });
  try {
    await run();
  } finally {
    restore();
  }
}

function setEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
