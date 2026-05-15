const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { hashAgentToken } = require("../agent-token-store");
const { createApp } = require("../server");

test("scoped agent tokens are one-time, hashed, revocable, and board-agent limited", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-agent-access-"));
  const dataPath = path.join(tempDir, "state.json");
  const tokenDataPath = path.join(tempDir, "agent-tokens.json");
  const adminToken = "admin-token";
  const server = await listen(createApp({
    dataPath,
    tokenDataPath,
    requireAuth: true,
    apiToken: adminToken,
    basicUser: "mike",
    basicPassword: "secret"
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

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

function lane(title, description, defaultOwnerAgentId = null, defaultReviewerAgentId = null) {
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

function agent(id, name, role, laneIds) {
  return {
    id,
    name,
    role,
    laneIds,
    instructions: `${name} instructions.`,
    skillNotes: "$kanban-cards"
  };
}

function bearerHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function writeJson(url, headers, body, method = "POST") {
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
  return response.json();
}
