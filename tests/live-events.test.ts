import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { createApp } from "../src/server";

interface SseMessage {
  id: string;
  event: string;
  data: string;
}

test("live events require auth, stream changes, and replay missed events by cursor", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-live-events-"));
    const dataPath = path.join(tempDir, "state.json");
    const eventDataPath = path.join(tempDir, "events.jsonl");
    const apiToken = "admin-token";
    const server = await listen(createApp({
      dataPath,
      eventDataPath,
      requireAuth: true,
      apiToken
    }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
    const denied = await fetch(`${baseUrl}/api/events`);
    assert.equal(denied.status, 401);

    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), {
      name: "Live board",
      lanes: [lane("Todo", "Ready for work.")]
    });

    const stream = await openSse(`${baseUrl}/api/events`, bearerHeaders(apiToken));
    try {
      const connected = await stream.messages.next((message) => message.event === "connected");
      assert.equal(connected.event, "connected");
      assert.match(stream.response.headers.get("content-type") || "", /text\/event-stream/);

      const item = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, bearerHeaders(apiToken), {
        title: "Live card",
        laneId: board.lanes[0].id
      });

      const changed = await stream.messages.next((message) => message.event === "workspace_changed");
      const changedData = JSON.parse(changed.data);
      assert.equal(changedData.boardId, board.id);
      assert.equal(changedData.payload.reason, "card_created");
      assert.equal(changedData.payload.action, "create");
      assert.equal(changedData.payload.resource.type, "card");
      assert.equal(changedData.payload.actor.type, "service");

      stream.close();

      await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${item.id}/comments`, bearerHeaders(apiToken), {
        kind: "progress",
        text: "Ready for review.",
        author: "human-reviewer"
      });

      const replay = await openSse(`${baseUrl}/api/events?since=${encodeURIComponent(changed.id)}`, bearerHeaders(apiToken));
      try {
        const missed = await replay.messages.next((message) => message.event === "workspace_changed");
      const missedData = JSON.parse(missed.data);
      assert.equal(missedData.boardId, board.id);
      assert.equal(missedData.payload.reason, "comment_created");
      assert.equal(missedData.payload.action, "comment");
      assert.equal(missedData.payload.resource.type, "comment");
      assert.equal(missedData.payload.actor.method, "bearer");

      const recent = await getJson(`${baseUrl}/api/boards/${board.id}/events?limit=1`, bearerHeaders(apiToken));
      assert.equal(recent.events.length, 1);
      assert.equal(recent.events[0].payload.reason, "comment_created");
      assert.equal(recent.events[0].payload.actor.type, "service");

      const cardEvents = await getJson(`${baseUrl}/api/boards/${board.id}/events?cardId=${encodeURIComponent(item.id)}&limit=10`, bearerHeaders(apiToken));
      assert.deepEqual(cardEvents.events.map((event: any) => event.payload.reason), ["comment_created", "card_created"]);
      assert.ok(cardEvents.events.every((event: any) => event.boardId === board.id));
    } finally {
      replay.close();
    }
    } finally {
      stream.close();
    }
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

class SseMessageReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(predicate: (message: SseMessage) => boolean, timeoutMs = 4_000): Promise<SseMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const parsed = this.nextBuffered(predicate);
      if (parsed) return parsed;

      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_resolve, reject) => windowlessSetTimeout(() => reject(new Error("Timed out waiting for SSE message.")), remaining))
      ]);
      if (chunk.done) throw new Error("SSE stream closed before expected message.");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }

    throw new Error("Timed out waiting for SSE message.");
  }

  private nextBuffered(predicate: (message: SseMessage) => boolean): SseMessage | null {
    let separatorIndex = this.buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const raw = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      const message = parseSseMessage(raw);
      if (message && predicate(message)) return message;
      separatorIndex = this.buffer.indexOf("\n\n");
    }
    return null;
  }
}

async function openSse(url: string, headers: Record<string, string>): Promise<{
  response: Response;
  messages: SseMessageReader;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers,
    signal: controller.signal
  });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  assert.ok(response.body, "SSE response body is missing.");
  return {
    response,
    messages: new SseMessageReader(response.body.getReader()),
    close: () => controller.abort()
  };
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function parseSseMessage(raw: string): SseMessage | null {
  const message: SseMessage = { id: "", event: "message", data: "" };
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).replace(/^ /, "") : "";
    if (field === "id") message.id = value;
    if (field === "event") message.event = value;
    if (field === "data") dataLines.push(value);
  }
  message.data = dataLines.join("\n");
  return message.event || message.data ? message : null;
}

function lane(title: string, description: string) {
  return {
    id: title.toLowerCase(),
    title,
    description,
    defaultOwnerAgentId: null,
    defaultReviewerAgentId: null,
    gate: {
      title: `${title} gate`,
      checks: ["Output is reviewable."]
    }
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

function windowlessSetTimeout(handler: () => void, timeout: number): NodeJS.Timeout {
  return setTimeout(handler, timeout);
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
