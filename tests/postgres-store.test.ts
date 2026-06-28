import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAgentTokenStore, hashAgentToken } from "../src/agent-token-store";
import { normalizePostgresConnectionString } from "../src/postgres-config";
import { createBoard, createPostgresStateStore } from "../src/state-store";
import type { WorkspaceState } from "../src/types";
import { FakePostgresAgentTokenPool, FakePostgresStatePool } from "./helpers/postgres-fakes";

test("Postgres store reads, writes, and updates the workspace document", async () => {
  const pool = new FakePostgresStatePool();
  const store = createPostgresStateStore({ pool: pool as any });

  const initial = await store.read();
  assert.equal(initial.boards.length, 1);
  assert.equal(initial.boards[0].name, "Untitled board");

  const board = createBoard({ name: "Postgres board" });
  await store.write({
    boards: [board],
    activeBoardId: board.id,
    templates: []
  });

  const saved = await store.read();
  assert.equal(saved.boards[0].name, "Postgres board");

  const { result, state } = await store.update((workspace: WorkspaceState) => {
    workspace.boards[0].name = "Updated board";
    return workspace.boards[0];
  });

  assert.equal(result.name, "Updated board");
  assert.equal(state.boards[0].name, "Updated board");
  assert.equal((await store.read()).boards[0].name, "Updated board");
});

test("Postgres agent token store persists hashes and supports verify and revoke", async () => {
  const pool = new FakePostgresAgentTokenPool();
  const store = createPostgresAgentTokenStore({ pool: pool as any });

  const created = await store.create({
    boardId: "board-1",
    agentId: "agent-a",
    label: "Agent laptop"
  });
  assert.match(created.token, /^kcagt_/);
  assert.equal(created.tokenRecord.boardId, "board-1");
  assert.equal(Object.hasOwn(created.tokenRecord, "tokenHash"), false);
  assert.equal(pool.tokens[0].token_hash, hashAgentToken(created.token));

  const listed = await store.list("board-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].lastUsedAt, null);

  const verified = await store.verify(created.token);
  assert.ok(verified);
  assert.equal(verified.agentId, "agent-a");
  assert.ok(verified.lastUsedAt);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const updated = await store.update("board-1", created.tokenRecord.sessionId, {
    label: "View-only laptop",
    capabilities: ["view"],
    expiresAt,
    reason: "Limited visibility."
  });
  assert.ok(updated);
  assert.equal(updated.label, "View-only laptop");
  assert.deepEqual(updated.capabilities, ["view"]);
  assert.equal(updated.reason, "Limited visibility.");
  assert.equal(Object.hasOwn(updated, "tokenHash"), false);

  const sessionRevoked = await store.revokeSession("board-1", created.tokenRecord.sessionId);
  assert.ok(sessionRevoked);
  assert.ok(sessionRevoked.revokedAt);
  assert.equal(await store.verify(created.token), null);

  const compatibilityToken = await store.create({
    boardId: "board-1",
    agentId: "agent-a",
    label: "Compatibility token"
  });
  const revoked = await store.revoke("board-1", compatibilityToken.tokenRecord.id);
  assert.ok(revoked);
  assert.ok(revoked.revokedAt);
  assert.equal(await store.verify(compatibilityToken.token), null);
});

test("Postgres agent token store migrates legacy rows to sessions without exposing hashes", async () => {
  const pool = new FakePostgresAgentTokenPool();
  const store = createPostgresAgentTokenStore({ pool: pool as any });
  const rawToken = "kcagt_legacy-token";
  const tokenId = "legacy-token-id";
  pool.seedToken({
    id: tokenId,
    board_id: "board-1",
    agent_id: "agent-a",
    label: "Legacy row",
    token_hash: hashAgentToken(rawToken),
    last4: rawToken.slice(-4),
    session_id: null,
    delegated_by: null,
    capabilities: null,
    expires_at: null,
    reason: null
  });

  const listed = await store.list("board-1");
  assert.equal(pool.tokens[0].session_id, `legacy:${tokenId}`);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, `legacy:${tokenId}`);
  assert.deepEqual(listed[0].capabilities, ["view", "create", "update", "comment", "move"]);
  assert.equal(listed[0].reason, "Legacy board-scoped token.");
  assert.equal(Object.hasOwn(listed[0], "tokenHash"), false);

  const verified = await store.verify(rawToken);
  assert.ok(verified);
  assert.equal(verified.sessionId, `legacy:${tokenId}`);
  assert.ok(verified.lastUsedAt);
  assert.equal(Object.hasOwn(verified, "tokenHash"), false);

  const updated = await store.update("board-1", `legacy:${tokenId}`, {
    label: "Migrated managed session",
    capabilities: ["view"],
    expiresAt: null,
    reason: "Migrated legacy row."
  });
  assert.ok(updated);
  assert.equal(updated.label, "Migrated managed session");
  assert.deepEqual(updated.capabilities, ["view"]);
  assert.equal(updated.reason, "Migrated legacy row.");
  assert.equal(Object.hasOwn(updated, "tokenHash"), false);

  const revoked = await store.revokeSession("board-1", `legacy:${tokenId}`);
  assert.ok(revoked);
  assert.ok(revoked.revokedAt);
  assert.equal(Object.hasOwn(revoked, "tokenHash"), false);
  assert.equal(await store.verify(rawToken), null);
});

test("Postgres connection strings use explicit SSL mode to avoid pg runtime warnings", () => {
  assert.equal(
    normalizePostgresConnectionString("postgres://user:pass@example.com/db?sslmode=require"),
    "postgres://user:pass@example.com/db?sslmode=verify-full"
  );
  assert.equal(
    normalizePostgresConnectionString("postgres://user:pass@example.com/db?sslmode=require&uselibpqcompat=true"),
    "postgres://user:pass@example.com/db?sslmode=require&uselibpqcompat=true"
  );
});
