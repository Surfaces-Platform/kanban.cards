import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { createApp } from "../src/server";

test("private beta auth protects the UI without exposing the agent token", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-auth-"));
  const dataPath = path.join(tempDir, "state.json");
  const server = await listen(createApp({
    dataPath,
    requireAuth: true,
    apiToken: "agent-token",
    basicUser: "mike",
    basicPassword: "secret"
  }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const denied = await fetch(`${baseUrl}/`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") || "", /kanban\.cards/);

    const html = await text(`${baseUrl}/`, basicHeaders("mike", "secret"));
    assert.match(html, /kanban\.cards/);
    assert.doesNotMatch(html, /KANBAN_CARDS_API_TOKEN|INSTRUCT_API_TOKEN|agent-token/);

    const state = await getJson(`${baseUrl}/api/state`, basicHeaders("mike", "secret"));
    assert.equal(state.boards[0].name, "Untitled board");

    const saved = await writeJson(`${baseUrl}/api/state`, basicHeaders("mike", "secret"), state, "PUT");
    assert.equal(saved.boards[0].name, "Untitled board");

    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders("agent-token"), { name: "Agent board" });
    assert.equal(board.name, "Agent board");
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("production-like auth reports missing required secrets", async () => {
  const server = await listen(createApp({ requireAuth: true, apiToken: "", basicUser: "", basicPassword: "" }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 500);
    const body = await health.json() as any;
    assert.deepEqual(body.missingConfig, [
      "KANBAN_CARDS_API_TOKEN",
      "KANBAN_CARDS_BASIC_USER",
      "KANBAN_CARDS_BASIC_PASSWORD"
    ]);
  } finally {
    await closeServer(server);
  }
});

function basicHeaders(user: string, password: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
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

async function text(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.text();
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
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
