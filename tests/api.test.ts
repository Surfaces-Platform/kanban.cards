import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";
import type { Server } from "node:http";

import { createApp } from "../src/server";

test("agent API protects writes, persists cards, and returns instructions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-api-"));
  const dataPath = path.join(tempDir, "state.json");
  const token = "test-token";
  const server = await listen(createApp({ dataPath, apiToken: token }));
  let serverClosed = false;
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

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
    assert.equal(item.requesterMemberId, null);
    assert.equal(item.ownerMemberId, null);
    assert.equal(item.reviewerMemberId, null);

    const moved = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}`, token, {
      laneId: board.lanes[1].id,
      reviewerMemberId: null
    }, "PATCH");
    assert.equal(moved.laneId, board.lanes[1].id);
    assert.equal(moved.ownerMemberId, null);
    assert.equal(moved.reviewerMemberId, null);

    const instruction = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}/comments`, token, {
      kind: "instruction",
      text: "Tighten the handoff note.",
      author: "human-reviewer"
    });
    assert.equal(instruction.status, "open");

    const instructions = await getJson(`${baseUrl}/api/agent/instructions?agentId=agent-a`);
    assert.equal(instructions.instructions.length, 1);
    assert.equal(instructions.instructions[0].comment.text, "Tighten the handoff note.");
    assert.equal(instructions.instructions[0].requesterMemberId, null);
    assert.equal(instructions.instructions[0].ownerMemberId, null);
    assert.equal(instructions.instructions[0].reviewerMemberId, null);

    const resolved = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}/comments/${instruction.id}`, token, {
      status: "resolved"
    }, "PATCH");
    assert.equal(resolved.status, "resolved");

    await closeServer(server);
    serverClosed = true;

    const restarted = await listen(createApp({ dataPath, apiToken: token }));
    try {
      const restartedBase = `http://127.0.0.1:${serverPort(restarted)}`;
      const persistedBoard = await getJson(`${restartedBase}/api/boards/${board.id}`);
      assert.equal(persistedBoard.workItems.length, 1);
      assert.equal(persistedBoard.workItems[0].comments[0].status, "resolved");
      assert.equal(persistedBoard.workItems[0].requesterMemberId, null);
      assert.equal(persistedBoard.workItems[0].ownerMemberId, null);
      assert.equal(persistedBoard.workItems[0].reviewerMemberId, null);
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

test("board agentSpec patch clears removed agent assignments and revokes sessions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-board-agent-patch-"));
  const dataPath = path.join(tempDir, "state.json");
  const tokenDataPath = path.join(tempDir, "agent-tokens.json");
  const token = "test-token";
  const server = await listen(createApp({ dataPath, tokenDataPath, apiToken: token }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const board = await writeJson(`${baseUrl}/api/boards`, token, {
      name: "Agent patch board",
      lanes: [
        lane("Todo", "Ready for work.", "agent-a", "agent-b"),
        lane("Review", "Ready for review.", "agent-b", "agent-a")
      ],
      agentSpecs: [
        agent("agent-a", "Agent A", "Owner", ["todo", "review"]),
        agent("agent-b", "Agent B", "Reviewer", ["todo", "review"])
      ]
    });
    const keptSession = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-sessions`, token, {
      agentId: "agent-a",
      label: "Kept session"
    });
    const removedSession = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-sessions`, token, {
      agentId: "agent-b",
      label: "Removed session"
    });
    const card = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, token, {
      title: "Needs reassignment",
      laneId: "todo",
      ownerAgentId: "agent-b",
      reviewerAgentId: "agent-a"
    });

    const patched = await writeJson(`${baseUrl}/api/boards/${board.id}`, token, {
      agentSpecs: [agent("agent-a", "Agent A", "Owner", ["todo", "review"])]
    }, "PATCH");
    const patchedCard = patched.workItems.find((item: any) => item.id === card.id);
    assert.equal(patchedCard.ownerAgentId, null);
    assert.equal(patchedCard.reviewerAgentId, "agent-a");
    assert.equal(patched.lanes[0].defaultReviewerAgentId, null);
    assert.equal(patched.lanes[1].defaultOwnerAgentId, null);

    const sessionsResponse = await fetch(`${baseUrl}/api/boards/${board.id}/agent-sessions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(sessionsResponse.ok, true);
    const sessions = await sessionsResponse.json() as { sessions: any[] };
    assert.deepEqual(sessions.sessions.map((session: any) => session.sessionId), [keptSession.session.sessionId]);

    assert.equal((await fetch(`${baseUrl}/api/agent/session`, { headers: { Authorization: `Bearer ${keptSession.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/agent/session`, { headers: { Authorization: `Bearer ${removedSession.token}` } })).status, 401);

    const eventsResponse = await fetch(`${baseUrl}/api/boards/${board.id}/events?limit=20`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(eventsResponse.ok, true);
    const events = await eventsResponse.json() as { events: any[] };
    const boardEvent = events.events.find((candidate: any) => candidate.payload.reason === "board_updated");
    assert.ok(boardEvent);
    assert.equal(boardEvent.payload.clearedAssignments.length, 1);
    assert.equal(boardEvent.payload.clearedAssignments[0].cardId, card.id);
    assert.equal(boardEvent.payload.revokedAgentSessions.length, 1);
    assert.equal(boardEvent.payload.revokedAgentSessions[0].sessionId, removedSession.session.sessionId);
    const revokedEvent = events.events.find((candidate: any) =>
      candidate.payload.reason === "agent_session_revoked" &&
      candidate.payload.sessionId === removedSession.session.sessionId
    );
    assert.ok(revokedEvent);
    assert.equal(revokedEvent.payload.revocationReason, "agent_removed_from_board");
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("state write clears removed agent assignments and revokes sessions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-state-agent-write-"));
  const dataPath = path.join(tempDir, "state.json");
  const tokenDataPath = path.join(tempDir, "agent-tokens.json");
  const eventDataPath = path.join(tempDir, "events.jsonl");
  const token = "test-token";
  const server = await listen(createApp({ dataPath, tokenDataPath, eventDataPath, apiToken: token }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const board = await writeJson(`${baseUrl}/api/boards`, token, {
      name: "State write board",
      lanes: [
        lane("Todo", "Ready for work.", "agent-b", "agent-a"),
        lane("Review", "Ready for review.", "agent-a", "agent-b")
      ],
      agentSpecs: [
        agent("agent-a", "Agent A", "Owner", ["todo", "review"]),
        agent("agent-b", "Agent B", "Reviewer", ["todo", "review"])
      ]
    });
    const keptSession = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-sessions`, token, {
      agentId: "agent-a",
      label: "Kept session"
    });
    const removedSession = await writeJson(`${baseUrl}/api/boards/${board.id}/agent-sessions`, token, {
      agentId: "agent-b",
      label: "Removed session"
    });
    const ownerCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, token, {
      title: "Owner removed",
      laneId: "todo",
      ownerAgentId: "agent-b",
      reviewerAgentId: "agent-a"
    });
    const reviewerCard = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, token, {
      title: "Reviewer removed",
      laneId: "review",
      ownerAgentId: "agent-a",
      reviewerAgentId: "agent-b"
    });

    const state = await getJson(`${baseUrl}/api/state`);
    const nextState = JSON.parse(JSON.stringify(state));
    const nextBoard = nextState.boards.find((candidate: any) => candidate.id === board.id);
    assert.ok(nextBoard);
    nextBoard.agentSpecs = [agent("agent-a", "Agent A", "Owner", ["todo", "review"])];

    const savedState = await writeJson(`${baseUrl}/api/state`, token, nextState, "PUT");
    const savedBoard = savedState.boards.find((candidate: any) => candidate.id === board.id);
    assert.ok(savedBoard);
    assert.deepEqual(savedBoard.agentSpecs.map((candidate: any) => candidate.id), ["agent-a"]);
    assert.equal(savedBoard.lanes[0].defaultOwnerAgentId, null);
    assert.equal(savedBoard.lanes[0].defaultReviewerAgentId, "agent-a");
    assert.equal(savedBoard.lanes[1].defaultOwnerAgentId, "agent-a");
    assert.equal(savedBoard.lanes[1].defaultReviewerAgentId, null);

    const savedOwnerCard = savedBoard.workItems.find((candidate: any) => candidate.id === ownerCard.id);
    const savedReviewerCard = savedBoard.workItems.find((candidate: any) => candidate.id === reviewerCard.id);
    assert.equal(savedOwnerCard.ownerAgentId, null);
    assert.equal(savedOwnerCard.reviewerAgentId, "agent-a");
    assert.equal(savedReviewerCard.ownerAgentId, "agent-a");
    assert.equal(savedReviewerCard.reviewerAgentId, null);

    const sessionsResponse = await fetch(`${baseUrl}/api/boards/${board.id}/agent-sessions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(sessionsResponse.ok, true);
    const sessions = await sessionsResponse.json() as { sessions: any[] };
    assert.deepEqual(sessions.sessions.map((session: any) => session.sessionId), [keptSession.session.sessionId]);

    assert.equal((await fetch(`${baseUrl}/api/agent/session`, { headers: { Authorization: `Bearer ${keptSession.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/agent/session`, { headers: { Authorization: `Bearer ${removedSession.token}` } })).status, 401);

    const eventsResponse = await fetch(`${baseUrl}/api/boards/${board.id}/events?limit=20`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(eventsResponse.ok, true);
    const events = await eventsResponse.json() as { events: any[] };
    const revokedEvent = events.events.find((candidate: any) =>
      candidate.payload.reason === "agent_session_revoked" &&
      candidate.payload.sessionId === removedSession.session.sessionId
    );
    assert.ok(revokedEvent);
    assert.equal(revokedEvent.payload.revocationReason, "agent_removed_from_state");

    const fileEvents = await readEventFile(eventDataPath);
    const workspaceSaved = fileEvents.find((candidate: any) =>
      candidate.payload.reason === "workspace_saved" &&
      candidate.payload.agentReconciliations?.some((reconciliation: any) => reconciliation.boardId === board.id)
    );
    assert.ok(workspaceSaved);
    assert.equal(workspaceSaved.payload.agentReconciliations.length, 1);
    assert.equal(workspaceSaved.payload.agentReconciliations[0].boardId, board.id);
    assert.equal(workspaceSaved.payload.agentReconciliations[0].removedAgents[0].agentId, "agent-b");
    assert.equal(workspaceSaved.payload.agentReconciliations[0].clearedAssignments.length, 2);
    assert.equal(workspaceSaved.payload.agentReconciliations[0].revokedAgentSessions[0].sessionId, removedSession.session.sessionId);
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

async function getJson<T = any>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function writeJson<T = any>(url: string, token: string, body: unknown, method = "POST"): Promise<T> {
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
  return response.json() as Promise<T>;
}

async function readEventFile(dataPath: string): Promise<any[]> {
  const raw = await fs.readFile(dataPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
