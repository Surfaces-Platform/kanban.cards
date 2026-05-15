const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");

test("agent API protects writes, persists cards, and returns instructions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-api-"));
  const dataPath = path.join(tempDir, "state.json");
  const token = "test-token";
  const server = await listen(createApp({ dataPath, apiToken: token }));
  let serverClosed = false;
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await getJson(`${baseUrl}/api/health`);
    assert.equal(health.ok, true);
    assert.equal(health.product, "kanban.cards");

    const initialState = await getJson(`${baseUrl}/api/state`);
    assert.equal(initialState.boards.length, 1);
    assert.equal(initialState.boards[0].name, "Untitled board");
    assert.equal(initialState.boards[0].lanes.length, 0);
    assert.equal(initialState.boards[0].workItems.length, 0);

    const denied = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Denied" })
    });
    assert.equal(denied.status, 401);

    const board = await writeJson(`${baseUrl}/api/boards`, token, {
      name: "API board",
      lanes: [
        lane("Backlog", "Work is waiting.", "agent-a", "reviewer-a"),
        lane("Review", "Work is ready for review.", "reviewer-a", "agent-a")
      ],
      agentSpecs: [
        agent("agent-a", "Agent A", "Owner", ["backlog"]),
        agent("reviewer-a", "Reviewer A", "Reviewer", ["review"])
      ]
    });
    assert.equal(board.name, "API board");
    assert.equal(board.lanes.length, 2);
    assert.equal(board.agentSpecs.length, 2);
    assert.equal(board.lanes[0].defaultOwnerAgentId, "agent-a");
    assert.equal(board.lanes[0].defaultReviewerAgentId, "reviewer-a");

    const item = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, token, {
      title: "Draft progress update",
      summary: "Create an agent-visible update.",
      laneId: board.lanes[0].id,
      ownerAgentId: "agent-a",
      reviewerAgentId: "reviewer-a"
    });
    assert.equal(item.laneId, board.lanes[0].id);

    const moved = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}`, token, {
      laneId: board.lanes[1].id
    }, "PATCH");
    assert.equal(moved.laneId, board.lanes[1].id);

    const instruction = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}/comments`, token, {
      kind: "instruction",
      text: "Tighten the handoff note.",
      author: "human-reviewer"
    });
    assert.equal(instruction.status, "open");

    const instructions = await getJson(`${baseUrl}/api/agent/instructions?agentId=agent-a`);
    assert.equal(instructions.instructions.length, 1);
    assert.equal(instructions.instructions[0].comment.text, "Tighten the handoff note.");

    const resolved = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}/comments/${instruction.id}`, token, {
      status: "resolved"
    }, "PATCH");
    assert.equal(resolved.status, "resolved");

    await closeServer(server);
    serverClosed = true;

    const restarted = await listen(createApp({ dataPath, apiToken: token }));
    try {
      const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
      const persistedBoard = await getJson(`${restartedBase}/api/boards/${board.id}`);
      assert.equal(persistedBoard.workItems.length, 1);
      assert.equal(persistedBoard.workItems[0].comments[0].status, "resolved");
      assert.equal(persistedBoard.agentSpecs[0].name, "Agent A");
      assert.equal(persistedBoard.lanes[0].defaultOwnerAgentId, "agent-a");
    } finally {
      await closeServer(restarted);
    }
  } finally {
    if (!serverClosed) await closeServer(server);
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

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function writeJson(url, token, body, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
