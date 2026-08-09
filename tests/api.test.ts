import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import defaultApp, { createApp } from "../src/server";

test("the server entry exports an Express app for Vercel framework discovery", () => {
  assert.equal(typeof defaultApp, "function");
  assert.equal(typeof defaultApp.listen, "function");
});

test("missing owner and external-bind configuration fail closed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-v2-fail-closed-"));
  let server: Server | undefined;
  try {
    server = await listenApp(createApp({
      dataPath: path.join(directory, "local.json"),
      requireDatabase: false
    }));
    let baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const shell = await fetch(baseUrl);
    assert.equal(shell.status, 200);
    const localHealth = await fetchJsonAllowError(`${baseUrl}/api/health`);
    assert.equal(localHealth.status, 503);
    assert.ok(localHealth.data.missingConfiguration.includes("KANBAN_CARDS_API_TOKEN"));
    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 503);

    await close(server);
    server = await listenApp(createApp({
      host: "0.0.0.0",
      dataPath: path.join(directory, "external.json"),
      apiToken: "configured-owner-token"
    }));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const externalHealth = await fetchJsonAllowError(`${baseUrl}/api/health`);
    assert.equal(externalHealth.status, 503);
    assert.ok(externalHealth.data.missingConfiguration.some((item: string) => item.includes("DATABASE_URL")));
  } finally {
    if (server) await close(server).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the public shell stays reachable while project data stays private", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const shell = await fetch(baseUrl);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /kanban\.cards/);

    const denied = await fetch(`${baseUrl}/api/projects`);
    assert.equal(denied.status, 401);

    const badSession = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ token: "wrong" })
    });
    assert.equal(badSession.status, 401);
    assert.equal(badSession.headers.get("set-cookie"), null);

    const opened = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ token })
    });
    assert.equal(opened.status, 200);
    const cookie = opened.headers.get("set-cookie");
    assert.ok(cookie);
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));

    const session = await fetchJson(`${baseUrl}/api/session`, { headers: { Cookie: cookieHeader(cookie) } });
    assert.equal(session.authenticated, true);

    const projects = await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookieHeader(cookie) } });
    assert.equal(projects.status, 200);

    const crossOriginWrite = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader(cookie),
        "Content-Type": "application/json",
        Origin: "https://attacker.example"
      },
      body: JSON.stringify({ name: "Must not exist" })
    });
    assert.equal(crossOriginWrite.status, 403);
  });
});

test("one resource API supports idempotent plans, concurrency, comments, activity, and persistence", async () => {
  await withServer(async ({ baseUrl, token, dataPath, restart }) => {
    const headers = ownerHeaders(token, "codex-test");
    const projectBody = {
      name: "Skill-first V2",
      description: "Execute the greenfield plan.",
      columns: [
        { id: "inbox", name: "Inbox", position: 0 },
        { id: "doing", name: "Doing", position: 1 },
        { id: "done", name: "Done", position: 2 }
      ]
    };

    const firstProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "project:v2" },
      body: JSON.stringify(projectBody)
    });
    assert.equal(firstProjectResponse.status, 201);
    const firstProjectPayload = await firstProjectResponse.json() as any;
    const project = unwrap(firstProjectPayload, "project");
    assert.equal(project.name, "Skill-first V2");
    assert.deepEqual(project.columns.map((column: any) => column.id), ["inbox", "doing", "done"]);

    const replayResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "project:v2" },
      body: JSON.stringify(projectBody)
    });
    assert.equal(replayResponse.status, 201);
    const replay = unwrap(await replayResponse.json(), "project");
    assert.equal(replay.id, project.id);

    const keyConflict = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "project:v2" },
      body: JSON.stringify({ ...projectBody, name: "Different request" })
    });
    assert.equal(keyConflict.status, 409);

    const cardResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "card:simplify-auth" },
      body: JSON.stringify({
        title: "Simplify authentication",
        body: "Use the owner credential.",
        columnId: "inbox",
        externalKey: "recommendation:simplify-auth"
      })
    });
    assert.equal(cardResponse.status, 201);
    const cardPayload = await cardResponse.json() as any;
    const card = unwrap(cardPayload, "card");
    assert.equal(card.version, 1);

    const deduplicatedResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "card:simplify-auth:retry" },
      body: JSON.stringify({
        title: "Simplify authentication",
        body: "Use the owner credential.",
        columnId: "inbox",
        externalKey: "recommendation:simplify-auth"
      })
    });
    assert.equal(deduplicatedResponse.status, 200);
    const deduplicatedPayload = await deduplicatedResponse.json() as any;
    assert.equal(unwrap(deduplicatedPayload, "card").id, card.id);

    const movedResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(card.version) },
      body: JSON.stringify({ columnId: "doing" })
    });
    assert.equal(movedResponse.status, 200);
    const moved = unwrap(await movedResponse.json(), "card");
    assert.equal(moved.columnId, "doing");
    assert.equal(moved.version, 2);

    const staleResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": "1" },
      body: JSON.stringify({ title: "Overwrite stale state" })
    });
    assert.equal(staleResponse.status, 409);

    const legacyHeaderResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "If-Match": String(moved.version) },
      body: JSON.stringify({ title: "Do not commit through a legacy precondition" })
    });
    assert.equal(legacyHeaderResponse.status, 400);
    assert.match((await legacyHeaderResponse.json() as any).error, /X-Kanban-Version/);

    const emptyLegacyHeaderResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "If-Match": "" },
      body: JSON.stringify({ title: "Do not accept an empty legacy precondition" })
    });
    assert.equal(emptyLegacyHeaderResponse.status, 400);

    const commentResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}/comments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "comment:implemented" },
      body: JSON.stringify({ body: "Implemented and verified the owner-token path." })
    });
    assert.equal(commentResponse.status, 201);
    const commentPayload = await commentResponse.json() as any;
    assert.equal(commentPayload.comment.body, "Implemented and verified the owner-token path.");
    assert.deepEqual(commentPayload.card, { id: card.id, version: 3 });

    const commentReplayResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}/comments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "comment:implemented" },
      body: JSON.stringify({ body: "Implemented and verified the owner-token path." })
    });
    assert.equal(commentReplayResponse.status, 201);
    assert.equal(commentReplayResponse.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await commentReplayResponse.json(), commentPayload);

    const storedState = JSON.parse(await fs.readFile(dataPath, "utf8"));
    const commentRecord = storedState.idempotencyRecords.find((record: any) => record.key === "comment:implemented");
    assert.deepEqual(commentRecord.response.card, { id: card.id, version: 3 });

    const activityPayload = await fetchJson(`${baseUrl}/api/projects/${project.id}/activity`, { headers });
    assert.ok(activityPayload.activity.length >= 4);
    assert.ok(activityPayload.activity.some((entry: any) => entry.actor.channel === "api" && entry.actor.label === "codex-test"));

    const restartedBaseUrl = await restart();
    const persistedPayload = await fetchJson(`${restartedBaseUrl}/api/projects/${project.id}`, { headers });
    const persisted = unwrap(persistedPayload, "project");
    assert.equal(persisted.cards.length, 1);
    assert.equal(persisted.cards[0].comments.length, 1);
    assert.equal(persisted.cards[0].columnId, "doing");
    assert.equal(path.basename(dataPath), "workspace.json");
  });
});

async function withServer(
  operation: (context: {
    baseUrl: string;
    token: string;
    dataPath: string;
    restart(): Promise<string>;
  }) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-v2-api-"));
  const dataPath = path.join(directory, "workspace.json");
  const token = "owner-test-token";
  let server = await listen(dataPath, token);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await operation({
      baseUrl,
      token,
      dataPath,
      restart: async () => {
        await close(server);
        server = await listen(dataPath, token);
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
    });
  } finally {
    await close(server).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function listen(dataPath: string, token: string, port = 0): Promise<Server> {
  const app = createApp({
    dataPath,
    apiToken: token,
    ownerLabel: "Test owner",
    requireDatabase: false
  });
  return listenApp(app, port);
}

async function listenApp(app: Express, port = 0): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function ownerHeaders(token: string, actor: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Kanban-Actor": actor };
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, `${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function fetchJsonAllowError(url: string, init?: RequestInit): Promise<{ status: number; data: any }> {
  const response = await fetch(url, init);
  return { status: response.status, data: JSON.parse(await response.text()) };
}

function unwrap(value: any, key: string): any {
  return value?.[key] ?? value;
}
