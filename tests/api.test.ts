import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import defaultApp, { createApp } from "../src/server";
import { createFileAccessStore } from "../src/access-store";
import type { PasskeyAuthConfig } from "../src/passkey-auth";
import { createWorkspaceStoreResolver } from "../src/state-store";

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
    assert.ok(localHealth.data.missingConfiguration.includes("KANBAN_CARDS_API_TOKEN (local development only)"));
    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 503);

    await close(server);
    server = await listenApp(createApp({
      host: "0.0.0.0",
      dataPath: path.join(directory, "external.json"),
      apiToken: "configured-api-credential"
    }));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const externalHealth = await fetchJsonAllowError(`${baseUrl}/api/health`);
    assert.equal(externalHealth.status, 503);
    assert.ok(externalHealth.data.missingConfiguration.some((item: string) => item.includes("DATABASE_URL")));
    assert.ok(externalHealth.data.missingConfiguration.some((item: string) => item.includes("SESSION_SECRET")));
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: "Bearer configured-api-credential" } })).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ token: "configured-api-credential" })
    })).status, 503);
  } finally {
    if (server) await close(server).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("production cannot enroll owners or mutate access through a file fallback when its database is missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-passkey-db-required-"));
  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const config: PasskeyAuthConfig = {
    authHost: "auth.kanban.cards", authOrigin: "https://auth.kanban.cards", rpId: "auth.kanban.cards",
    rootOrigins: ["https://kanban.cards"], sessionSecret: "test-secret-with-at-least-32-characters", sessionTtlSeconds: 3600
  };
  let server: Server | undefined;
  try {
    server = await listenApp(createApp({ host: "0.0.0.0", rootHost: "kanban.cards", passkeyAuthConfig: config,
      dataPath: path.join(directory, "state.json"), accessStore, requireDatabase: true }));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [endpoint, host, origin] of [
      ["/api/auth-start", "kanban.cards", "https://kanban.cards"],
      ["/api/passkeys/start", "auth.kanban.cards", "https://kanban.cards"],
      ["/api/passkeys/options", "auth.kanban.cards", "https://auth.kanban.cards"],
      ["/api/workspaces", "kanban.cards", "https://kanban.cards"]
    ]) {
      const response = await fetch(`${baseUrl}${endpoint}`, { method: "POST", headers: {
        Host: host, Origin: origin, "Content-Type": "application/json"
      }, body: JSON.stringify({ mode: "signup" }) });
      assert.equal(response.status, 503, endpoint);
    }
    const state = await accessStore.read();
    assert.equal(state.owners.length, 0);
    assert.equal(state.authChallenges.length, 0);
    assert.equal(state.authSessions.length, 0);
  } finally {
    if (server) await close(server);
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

    const defaultColumnsResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "project:default-columns" },
      body: JSON.stringify({ name: "Default columns" })
    });
    assert.equal(defaultColumnsResponse.status, 201);
    const defaultColumnsProject = unwrap(await defaultColumnsResponse.json(), "project");
    assert.deepEqual(defaultColumnsProject.columns.map((column: any) => column.name), ["Next", "Doing", "Done"]);

    const keyConflict = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "project:v2" },
      body: JSON.stringify({ ...projectBody, name: "Different request" })
    });
    assert.equal(keyConflict.status, 409);

    const createdMarkdown = "    indented code\r\n\r\nLine with hard break  \r\nNext line\r\n";
    const normalizedCreatedMarkdown = "    indented code\n\nLine with hard break  \nNext line\n";
    const cardBody = {
      title: "Simplify authentication",
      body: createdMarkdown,
      columnId: "inbox",
      externalKey: "recommendation:simplify-auth"
    };
    const cardResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "card:simplify-auth" },
      body: JSON.stringify(cardBody)
    });
    assert.equal(cardResponse.status, 201);
    const cardPayload = await cardResponse.json() as any;
    const card = unwrap(cardPayload, "card");
    assert.equal(card.version, 1);
    assert.equal(card.body, normalizedCreatedMarkdown);

    const cardReplayResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "card:simplify-auth" },
      body: JSON.stringify(cardBody)
    });
    assert.equal(cardReplayResponse.status, 201);
    assert.equal(cardReplayResponse.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await cardReplayResponse.json(), cardPayload);

    const deduplicatedResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "card:simplify-auth:retry" },
      body: JSON.stringify({
        title: "Simplify authentication",
        body: createdMarkdown,
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

    const updatedMarkdown = `${normalizedCreatedMarkdown}\n## Updated\n\nTrailing source space  \n`;
    const markdownUpdateResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(moved.version) },
      body: JSON.stringify({ body: updatedMarkdown })
    });
    assert.equal(markdownUpdateResponse.status, 200);
    const markdownUpdated = unwrap(await markdownUpdateResponse.json(), "card");
    assert.equal(markdownUpdated.body, updatedMarkdown);
    assert.equal(markdownUpdated.version, 3);

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
      body: JSON.stringify({ body: "Implemented and verified the bounded credential path." })
    });
    assert.equal(commentResponse.status, 201);
    const commentPayload = await commentResponse.json() as any;
    assert.equal(commentPayload.comment.body, "Implemented and verified the bounded credential path.");
    assert.deepEqual(commentPayload.card, { id: card.id, version: 4 });

    const commentReplayResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}/comments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "comment:implemented" },
      body: JSON.stringify({ body: "Implemented and verified the bounded credential path." })
    });
    assert.equal(commentReplayResponse.status, 201);
    assert.equal(commentReplayResponse.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await commentReplayResponse.json(), commentPayload);

    const storedState = JSON.parse(await fs.readFile(dataPath, "utf8"));
    const commentRecord = storedState.idempotencyRecords.find((record: any) => record.key === "comment:implemented");
    assert.deepEqual(commentRecord.response.card, { id: card.id, version: 4 });

    const beforeColumnAppend = unwrap(await fetchJson(`${baseUrl}/api/projects/${project.id}`, { headers }), "project");
    const appendColumnsResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(beforeColumnAppend.revision) },
      body: JSON.stringify({
        columns: [
          ...beforeColumnAppend.columns,
          { id: "review", name: "Review", position: beforeColumnAppend.columns.length }
        ]
      })
    });
    assert.equal(appendColumnsResponse.status, 200);
    const withAppendedColumn = unwrap(await appendColumnsResponse.json(), "project");
    assert.equal(appendColumnsResponse.headers.get("etag"), `"${withAppendedColumn.revision}"`);
    assert.deepEqual(withAppendedColumn.columns.map((column: any) => column.id), ["inbox", "doing", "done", "review"]);
    assert.deepEqual(withAppendedColumn.columns.slice(0, -1), beforeColumnAppend.columns);
    assert.deepEqual(withAppendedColumn.cards, beforeColumnAppend.cards);
    assert.ok(withAppendedColumn.activity.some((entry: any) => entry.action === "project.updated"));

    const staleProjectResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(beforeColumnAppend.revision) },
      body: JSON.stringify({
        columns: [
          ...beforeColumnAppend.columns,
          { id: "must-not-exist", name: "Must not exist", position: beforeColumnAppend.columns.length }
        ]
      })
    });
    assert.equal(staleProjectResponse.status, 409);

    const strandedCardResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(withAppendedColumn.revision) },
      body: JSON.stringify({ columns: withAppendedColumn.columns.filter((column: any) => column.id !== "doing") })
    });
    assert.equal(strandedCardResponse.status, 409);
    const afterRejectedColumnWrites = unwrap(await fetchJson(`${baseUrl}/api/projects/${project.id}`, { headers }), "project");
    assert.equal(afterRejectedColumnWrites.revision, withAppendedColumn.revision);
    assert.deepEqual(afterRejectedColumnWrites.columns, withAppendedColumn.columns);
    assert.deepEqual(afterRejectedColumnWrites.cards, beforeColumnAppend.cards);

    const archivedResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(commentPayload.card.version) },
      body: JSON.stringify({ archivedAt: new Date().toISOString() })
    });
    assert.equal(archivedResponse.status, 200);
    const archived = unwrap(await archivedResponse.json(), "card");
    assert.ok(archived.archivedAt);

    const restoredResponse = await fetch(`${baseUrl}/api/projects/${project.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", "X-Kanban-Version": String(archived.version) },
      body: JSON.stringify({ archivedAt: null })
    });
    assert.equal(restoredResponse.status, 200);
    const restored = unwrap(await restoredResponse.json(), "card");
    assert.equal(restored.archivedAt, null);

    const projectListAfterUndo = await fetchJson(`${baseUrl}/api/projects`, { headers });
    assert.equal(projectListAfterUndo.projects.find((candidate: any) => candidate.id === project.id).cardCount, 1);

    const activityPayload = await fetchJson(`${baseUrl}/api/projects/${project.id}/activity`, { headers });
    assert.ok(activityPayload.activity.length >= 4);
    assert.ok(activityPayload.activity.some((entry: any) => entry.actor.channel === "api" && entry.actor.label === "codex-test"));

    const restartedBaseUrl = await restart();
    const persistedPayload = await fetchJson(`${restartedBaseUrl}/api/projects/${project.id}`, { headers });
    const persisted = unwrap(persistedPayload, "project");
    assert.equal(persisted.cards.length, 1);
    assert.equal(persisted.cards[0].comments.length, 1);
    assert.equal(persisted.cards[0].columnId, "doing");
    assert.equal(persisted.cards[0].body, updatedMarkdown);
    assert.deepEqual(persisted.columns.map((column: any) => column.id), ["inbox", "doing", "done", "review"]);
    assert.equal(path.basename(dataPath), "workspace.json");
  });
});

test("Card handoffs round-trip, clear, and survive other mutations without weakening concurrency or idempotency", async () => {
  await withServer(async ({ baseUrl, token, restart }) => {
    const headers = { ...ownerHeaders(token, "handoff-test"), "Content-Type": "application/json" };
    const project = unwrap(await fetchJson(`${baseUrl}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "Card handoffs" })
    }), "project");
    const projectUrl = `${baseUrl}/api/projects/${project.id}`;
    const cardsUrl = `${projectUrl}/cards`;
    const existingBody = "Next actor: human\nPriority: Low\nKeep this description intact.  \n";
    const defaults = unwrap(await fetchJson(cardsUrl, {
      method: "POST", headers, body: JSON.stringify({ title: "No metadata", body: existingBody })
    }), "card");
    assert.deepEqual(cardMetadata(defaults), emptyCardMetadata());
    assert.equal(defaults.body, existingBody);

    const createBody = {
      title: "Structured handoff", body: "  Markdown source  \n", externalKey: "handoff:one",
      nextActor: "agent", nextAction: "  Run the check\n", priority: "High", blockedReason: "  Waiting for access  "
    };
    const creationHeaders = { ...headers, "Idempotency-Key": "handoff:create" };
    const created = await fetchJson(cardsUrl, { method: "POST", headers: creationHeaders, body: JSON.stringify(createBody) });
    let card = created.card;
    const metadata = { nextActor: "agent", nextAction: "Run the check", priority: "High", blockedReason: "Waiting for access" };
    assert.deepEqual(cardMetadata(card), metadata);
    const replay = await fetch(cardsUrl, { method: "POST", headers: creationHeaders, body: JSON.stringify(createBody) });
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replay.json(), created);
    assert.equal((await fetch(cardsUrl, {
      method: "POST", headers: creationHeaders, body: JSON.stringify({ ...createBody, priority: "Low" })
    })).status, 409);
    const duplicate = await fetchJson(cardsUrl, {
      method: "POST", headers, body: JSON.stringify({ ...createBody, priority: "Low", nextActor: "human" })
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.card.id, card.id);
    assert.deepEqual(cardMetadata(duplicate.card), metadata);

    const beforeInvalid = await fetchJson(projectUrl, { headers });
    for (const invalid of [
      { nextActor: "robot" }, { nextActor: " agent " }, { priority: "high" }, { priority: true },
      { nextAction: ["Act"] }, { blockedReason: { text: "Blocked" } }
    ]) {
      assert.equal((await fetch(cardsUrl, {
        method: "POST", headers, body: JSON.stringify({ title: "Must not exist", ...invalid })
      })).status, 400);
      assert.equal((await fetch(`${cardsUrl}/${card.id}`, {
        method: "PATCH", headers: { ...headers, "X-Kanban-Version": String(card.version) },
        body: JSON.stringify({ title: "Must not overwrite", ...invalid })
      })).status, 400);
    }
    assert.deepEqual(await fetchJson(projectUrl, { headers }), beforeInvalid);
    assert.equal((await fetch(`${cardsUrl}/${card.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ priority: "Medium" })
    })).status, 428);

    const patch = async (body: Record<string, unknown>) => {
      const result = await fetchJson(`${cardsUrl}/${card.id}`, {
        method: "PATCH", headers: { ...headers, "X-Kanban-Version": String(card.version) }, body: JSON.stringify(body)
      });
      card = result.card;
      return result;
    };
    await patch({ nextActor: "human", nextAction: "  Review the result ", priority: "Medium", blockedReason: null });
    const updatedMetadata = { nextActor: "human", nextAction: "Review the result", priority: "Medium", blockedReason: "" };
    assert.deepEqual(cardMetadata(card), updatedMetadata);
    assert.equal((await fetch(`${cardsUrl}/${card.id}`, {
      method: "PATCH", headers: { ...headers, "X-Kanban-Version": "1" }, body: JSON.stringify({ priority: "Low" })
    })).status, 409);
    await patch({ columnId: project.columns[1].id });
    assert.deepEqual(cardMetadata(card), updatedMetadata);
    const comment = await fetchJson(`${cardsUrl}/${card.id}/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "Ready for review." })
    });
    assert.equal(comment.card.version, card.version + 1);
    card = (await fetchJson(projectUrl, { headers })).project.cards.find((candidate: any) => candidate.id === card.id);
    assert.deepEqual(cardMetadata(card), updatedMetadata);
    await patch({ archivedAt: new Date().toISOString() });
    assert.deepEqual(cardMetadata(card), updatedMetadata);
    await patch({ archivedAt: null });
    assert.deepEqual(cardMetadata(card), updatedMetadata);
    await patch({ nextActor: null, nextAction: null, priority: null, blockedReason: " \n " });
    assert.deepEqual(cardMetadata(card), emptyCardMetadata());
    assert.equal(card.body, createBody.body);
    assert.equal(card.comments.length, 1);

    const restarted = await restart();
    const persisted = (await fetchJson(`${restarted}/api/projects/${project.id}`, { headers })).project.cards.find((candidate: any) => candidate.id === card.id);
    assert.deepEqual(cardMetadata(persisted), emptyCardMetadata());
    assert.equal(persisted.version, card.version);
  });
});

test("the Card list combines validated filters and archive visibility without filtering the full Project snapshot", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const headers = { ...ownerHeaders(token, "filter-test"), "Content-Type": "application/json" };
    const project = unwrap(await fetchJson(`${baseUrl}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "Filtered cards" })
    }), "project");
    const projectUrl = `${baseUrl}/api/projects/${project.id}`;
    const cardsUrl = `${projectUrl}/cards`;
    const inputs = [
      { title: "Blocked agent", nextActor: "agent", priority: "High", blockedReason: "  Access needed  ", position: 3 },
      { title: "Human review", nextActor: "human", priority: "High", blockedReason: "  \n ", position: 1 },
      { title: "Agent follow-up", nextActor: "agent", priority: "Low", position: 2 },
      { title: "Unassigned", position: 0 },
      { title: "Archived agent", nextActor: "agent", priority: "High", blockedReason: "Old blocker", position: 4 }
    ];
    const created: Array<{ id: string; version: number }> = [];
    for (const input of inputs) created.push(unwrap(await fetchJson(cardsUrl, { method: "POST", headers, body: JSON.stringify(input) }), "card"));
    const archived = created[4];
    await fetchJson(`${cardsUrl}/${archived.id}`, {
      method: "PATCH", headers: { ...headers, "X-Kanban-Version": String(archived.version) },
      body: JSON.stringify({ archivedAt: new Date().toISOString() })
    });
    const snapshot = await fetchJson(projectUrl, { headers });
    const expected = (indices: number[]) => snapshot.project.cards.filter((card: any) => indices.some(index => card.id === created[index].id)).map((card: any) => card.id);
    for (const [query, indices] of [
      ["", [0, 1, 2, 3]], ["?includeArchived=false", [0, 1, 2, 3]], ["?includeArchived=true", [0, 1, 2, 3, 4]],
      ["?nextActor=agent", [0, 2]], ["?nextActor=human", [1]], ["?priority=Low", [2]],
      ["?priority=Medium", []], ["?blocked=true", [0]], ["?blocked=false", [1, 2, 3]],
      ["?nextActor=unassigned&priority=unset&blocked=false", [3]],
      ["?nextActor=agent&priority=High&blocked=true", [0]],
      ["?nextActor=agent&priority=High&blocked=false", []],
      ["?includeArchived=true&nextActor=agent&priority=High&blocked=true", [0, 4]]
    ] as Array<[string, number[]]>) {
      const listed = await fetchJson(`${cardsUrl}${query}`, { headers });
      assert.deepEqual(listed.cards.map((card: any) => card.id), expected(indices), query);
      assert.equal(listed.projectRevision, snapshot.project.revision);
    }
    for (const query of [
      "nextActor=robot", "nextActor=", "priority=high", "priority=", "blocked=1", "includeArchived=yes",
      "nextActor=agent&nextActor=human", "priority=High&priority=Low", "blocked=true&blocked=false",
      "includeArchived=true&includeArchived=false", "nextActr=agent", "nextActor[]=agent", "priority[level]=High"
    ]) {
      assert.equal((await fetch(`${cardsUrl}?${query}`, { headers })).status, 400, query);
    }
    assert.deepEqual(await fetchJson(`${projectUrl}?nextActor=agent&priority=High&blocked=true`, { headers }), snapshot);
    assert.equal((await fetch(`${baseUrl}/api/projects/missing/cards`, { headers })).status, 404);
    assert.equal((await fetch(cardsUrl)).status, 401);
  });
});

test("filtered Card reads require the scoped read permission and cannot grant writes or cross Workspaces", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-card-filter-scopes-"));
  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const workspace = await accessStore.createWorkspace({ providerSubject: "filter-test-owner", email: "", displayName: "Test owner", slug: "cards", name: "Cards" });
  await accessStore.createWorkspace({ providerSubject: "other-filter-owner", email: "", displayName: "Other test owner", slug: "other", name: "Other" });
  const reader = await accessStore.createAgentConnection({ providerSubject: "filter-test-owner", workspaceId: workspace.id, label: "Reader", scopes: ["read"] });
  const writer = await accessStore.createAgentConnection({ providerSubject: "filter-test-owner", workspaceId: workspace.id, label: "Writer", scopes: ["write"] });
  const resolver = createWorkspaceStoreResolver({ dataPath: path.join(directory, "default.json"), workspaceDirectory: path.join(directory, "workspaces") });
  const config: PasskeyAuthConfig = {
    authHost: "auth.kanban.cards", authOrigin: "https://auth.kanban.cards", rpId: "auth.kanban.cards",
    rootOrigins: ["https://kanban.cards"], sessionSecret: "card-scopes-test-secret-at-least-32-characters", sessionTtlSeconds: 3600
  };
  const server = await listenApp(createApp({ host: "kanban.cards", rootHost: "kanban.cards", passkeyAuthConfig: config,
    accessStore, workspaceStoreResolver: resolver, dataPath: path.join(directory, "default.json"), requireDatabase: false, trustForwardedHost: true }));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tenantHeaders = (credential: string, host = "cards.kanban.cards") => ({
    Host: host, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https", Authorization: `Bearer ${credential}`, "Content-Type": "application/json"
  });
  try {
    const project = unwrap(await fetchJson(`${baseUrl}/api/projects`, {
      method: "POST", headers: tenantHeaders(writer.credential), body: JSON.stringify({ name: "Scoped cards" })
    }), "project");
    const cardsUrl = `${baseUrl}/api/projects/${project.id}/cards`;
    const card = unwrap(await fetchJson(cardsUrl, {
      method: "POST", headers: tenantHeaders(writer.credential), body: JSON.stringify({ title: "Read me", nextActor: "agent", priority: "High" })
    }), "card");
    const listed = await fetchJson(`${cardsUrl}?nextActor=agent&priority=High&blocked=false`, { headers: tenantHeaders(reader.credential) });
    assert.deepEqual(listed.cards.map((entry: any) => entry.id), [card.id]);
    assert.equal((await fetch(cardsUrl, { headers: tenantHeaders(writer.credential) })).status, 403);
    assert.equal((await fetch(`${cardsUrl}/${card.id}`, { method: "PATCH", headers: { ...tenantHeaders(reader.credential), "X-Kanban-Version": "1" }, body: JSON.stringify({ nextActor: "human" }) })).status, 403);
    assert.equal((await fetch(cardsUrl, { headers: tenantHeaders(reader.credential, "other.kanban.cards") })).status, 401);
    const snapshot = await fetchJson(`${baseUrl}/api/projects/${project.id}`, { headers: tenantHeaders(reader.credential) });
    assert.equal(snapshot.project.cards[0].nextActor, "agent");
    assert.equal(snapshot.project.cards[0].version, 1);
  } finally {
    await close(server);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function cardMetadata(card: { nextActor: unknown; nextAction: unknown; priority: unknown; blockedReason: unknown }) {
  return { nextActor: card.nextActor, nextAction: card.nextAction, priority: card.priority, blockedReason: card.blockedReason };
}

function emptyCardMetadata() {
  return { nextActor: null, nextAction: "", priority: null, blockedReason: "" };
}

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
