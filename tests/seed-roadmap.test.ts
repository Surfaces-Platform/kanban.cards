import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";
import type { Server } from "node:http";

import { seedRoadmap } from "../scripts/seed-roadmap";
import { createSessionCookie } from "../src/platform-auth";
import { createApp } from "../src/server";
import type { Board, WorkItem } from "../src/types";

const ROADMAP_BOARD_NAME = "kanban.cards Product Roadmap";
const DEFAULT_PROJECT_ID = "kanban.cards:default";
const ROADMAP_TITLES = [
  "Close Auth0 production rollout",
  "Persist Team and Project model",
  "Make boards project-scoped",
  "Introduce AgentSession delegation",
  "Expand audit/provenance events",
  "Add sensitive-action policy gates",
  "Add member/invite UI",
  "Add board/project settings"
];

test("roadmap seed supports dry-run and repeatable upsert by title", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-roadmap-"));
  const dataPath = path.join(tempDir, "state.json");
  const token = "roadmap-test-token";
  const server = await listen(createApp({ dataPath, apiToken: token }));
  const apiBaseUrl = `http://127.0.0.1:${serverPort(server)}/api`;

  try {
    const dryRun = await seedRoadmap({ apiBaseUrl, apiToken: token, dryRun: true });
    assert.equal(dryRun.boardAction, "create");
    assert.equal(dryRun.cardActions.length, ROADMAP_TITLES.length);
    assert.equal(dryRun.cardActions.every((card) => card.action === "create"), true);

    const stateAfterDryRun = await getJson<{ boards: Board[] }>(`${apiBaseUrl}/state`, bearerHeaders(token));
    assert.equal(stateAfterDryRun.boards.some((board) => board.name === ROADMAP_BOARD_NAME), false);

    const firstSeed = await seedRoadmap({ apiBaseUrl, apiToken: token });
    assert.equal(firstSeed.boardAction, "create");
    assert.equal(firstSeed.cardActions.filter((card) => card.action === "create").length, ROADMAP_TITLES.length);

    let board = await getRoadmapBoard(apiBaseUrl, token);
    assert.equal(board.lanes.map((lane) => lane.title).join(", "), "Intake, Research, Plan, Draft, Review, Release");
    assert.equal(board.agentSpecs.map((agent) => agent.id).join(", "), "agent-coordinator, agent-researcher, agent-producer, agent-reviewer");
    assert.equal(board.workItems.length, ROADMAP_TITLES.length);

    const closeAuth0 = requireCard(board, "Close Auth0 production rollout");
    await writeJson(`${apiBaseUrl}/boards/${board.id}/work-items/${closeAuth0.id}`, bearerHeaders(token), { laneId: "intake" }, "PATCH");
    await writeJson(`${apiBaseUrl}/boards/${board.id}/work-items/${closeAuth0.id}/comments`, bearerHeaders(token), {
      kind: "note",
      text: "Keep this rollout note.",
      author: "test"
    });
    const unknown = await writeJson<WorkItem>(`${apiBaseUrl}/boards/${board.id}/work-items`, bearerHeaders(token), {
      title: "Do not touch this card",
      summary: "Existing operator-owned card.",
      laneId: "draft"
    });
    await writeJson(`${apiBaseUrl}/boards/${board.id}/work-items/${unknown.id}/comments`, bearerHeaders(token), {
      kind: "question",
      text: "Preserve this question.",
      author: "test"
    });

    const secondSeed = await seedRoadmap({ apiBaseUrl, apiToken: token });
    assert.equal(secondSeed.boardAction, "none");
    assert.equal(secondSeed.cardActions.find((card) => card.title === "Close Auth0 production rollout")?.action, "update");
    assert.equal(secondSeed.cardActions.filter((card) => card.action === "create").length, 0);

    board = await getRoadmapBoard(apiBaseUrl, token);
    for (const title of ROADMAP_TITLES) {
      assert.equal(board.workItems.filter((item) => item.title === title).length, 1, `${title} should be unique`);
    }
    assert.equal(requireCard(board, "Close Auth0 production rollout").laneId, "release");
    assert.equal(requireCard(board, "Close Auth0 production rollout").comments[0]?.text, "Keep this rollout note.");
    assert.equal(requireCard(board, "Do not touch this card").comments[0]?.text, "Preserve this question.");

    const thirdSeed = await seedRoadmap({ apiBaseUrl, apiToken: token });
    assert.equal(thirdSeed.boardAction, "none");
    assert.equal(thirdSeed.cardActions.every((card) => card.action === "none"), true);
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("server-side roadmap seed works from an Auth0 session without client bearer access", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-roadmap-session-"));
    const dataPath = path.join(tempDir, "state.json");
    const token = "server-side-roadmap-token";
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: token }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const apiBaseUrl = `${baseUrl}/api`;
    const sessionCookie = await createSessionCookie({
      userId: "auth0|roadmap-admin",
      email: "roadmap@example.com",
      name: "Roadmap Admin",
      workspaceId: "ws_roadmap",
      roles: ["admin"],
      surfaceAccess: ["kanban.cards"]
    }, "test-session-secret-with-enough-entropy", false, 3600);

    try {
      const adminPage = await getText(`${baseUrl}/admin/roadmap-seed`, cookieHeaders(sessionCookie));
      assert.match(adminPage, /Seed product roadmap/);

      const dryRun = await writeJson(`${apiBaseUrl}/roadmap/seed`, cookieHeaders(sessionCookie), { dryRun: true });
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.boardAction, "create");

      const stateAfterDryRun = await getJson<{ boards: Board[] }>(`${apiBaseUrl}/state`, cookieHeaders(sessionCookie));
      assert.equal(stateAfterDryRun.boards.some((board) => board.name === ROADMAP_BOARD_NAME), false);

      const seeded = await writeJson(`${apiBaseUrl}/roadmap/seed`, cookieHeaders(sessionCookie), {});
      assert.equal(seeded.dryRun, false);
      assert.equal(seeded.boardAction, "create");
      assert.equal(seeded.cardActions.filter((card: any) => card.action === "create").length, ROADMAP_TITLES.length);

      const board = await getRoadmapBoard(apiBaseUrl, token);
      assert.equal(board.workItems.length, ROADMAP_TITLES.length);
      assert.ok(board.workItems.some((item) => item.title === "Persist Team and Project model"));
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function getRoadmapBoard(apiBaseUrl: string, token: string): Promise<Board> {
  const response = await getJson<{ boards: Board[] }>(
    `${apiBaseUrl}/boards?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`,
    bearerHeaders(token)
  );
  const board = response.boards.find((candidate) => candidate.name === ROADMAP_BOARD_NAME);
  assert.ok(board, "roadmap board should exist");
  return board;
}

function requireCard(board: Board, title: string): WorkItem {
  const item = board.workItems.find((candidate) => candidate.title === title);
  assert.ok(item, `${title} should exist`);
  return item;
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

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function cookieHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie.split(";")[0] };
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.text();
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
