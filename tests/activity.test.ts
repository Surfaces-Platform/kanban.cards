import assert from "node:assert/strict";
import test from "node:test";
import { ActivityCursorError, workspaceActivityPage } from "../src/activity";
import type { Activity, Project } from "../src/types";

const date = "2026-10-19T12:00:00.000Z";
function event(id: string, createdAt = date): Activity {
  return { id, createdAt, projectId: "untrusted-context", cardId: "card", action: "card.updated",
    actor: { channel: "api", label: "Claude Research", agentConnectionId: "connection-one" }, summary: `Changed ${id}` };
}
function project(id: string, activity: Activity[], archivedAt: string | null = null): Project {
  return { id, name: `Project ${id}`, description: "", columns: [], cards: [{ id: "card", title: "Current card title", body: "",
    nextActor: null, nextAction: "", priority: null, blockedReason: "", columnId: "inbox", position: 0, version: 1,
    archivedAt: null, createdAt: date, updatedAt: date, comments: [] }], activity,
    revision: 7, archivedAt, createdAt: date, updatedAt: date };
}

test("Workspace history includes archived Projects with context and unchanged stored actors", () => {
  const projects = [project("active", [event("old", "2026-10-18T12:00:00Z")]), project("archived", [event("new")], date)];
  const snapshot = structuredClone(projects);
  const page = workspaceActivityPage(projects, 50);
  assert.deepEqual(page.activity.map(a => a.id), ["new", "old"]);
  assert.deepEqual(page.activity[0], { ...projects[1].activity[0], projectId: "archived", projectName: "Project archived", projectArchivedAt: date, cardTitle: "Current card title" });
  assert.deepEqual(page.activity[0].actor, snapshot[1].activity[0].actor);
  page.activity[0].actor.label = "Cannot rewrite history";
  assert.deepEqual(projects, snapshot);
  assert.equal(page.nextCursor, null);
});

test("paging handles tied timestamps and overlapping per-Project event IDs without skips or duplicates", () => {
  const projects = [project("a", [event("one"), event("two")]), project("b", [event("one"), event("two")])];
  const ids: string[] = [];
  let cursor: string | null | undefined;
  do {
    const page = workspaceActivityPage(projects, 1, cursor ?? undefined);
    ids.push(...page.activity.map(a => `${a.projectId}:${a.id}`));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["b:two", "b:one", "a:two", "a:one"]);
});

test("newer events arriving between page requests do not repeat the first page", () => {
  const projects = [project("a", [event("old", "2026-10-18T12:00:00Z"), event("new")])];
  const first = workspaceActivityPage(projects, 1);
  projects[0].activity.push(event("newest", "2026-10-20T12:00:00Z"));
  const second = workspaceActivityPage(projects, 1, first.nextCursor);
  assert.deepEqual(second.activity.map(a => a.id), ["old"]);
  assert.equal(second.nextCursor, null);
});

test("empty history and missing/deleted Card context remain readable", () => {
  assert.deepEqual(workspaceActivityPage([], 50), { activity: [], nextCursor: null });
  const p = project("a", [event("one", "invalid legacy timestamp")]);
  p.cards = [];
  assert.equal(workspaceActivityPage([p], 1).activity[0].cardTitle, undefined);
});

test("untrusted cursors are validated and cannot supply a Workspace or Project collection", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const cursor = { v: 1, t: Date.parse(date), p: "p", i: "i" };
  for (const value of [null, {}, ["cursor"], "", "not+a/cursor==", "a".repeat(2049), encode(null), encode([]),
    encode({ ...cursor, v: 2 }), encode({ ...cursor, t: 1.5 }), encode({ ...cursor, p: "" }),
    encode({ ...cursor, workspaceId: "foreign" }), encode({ ...cursor, t: 9e15 }), encode({ ...cursor, i: "i".repeat(513) })]) {
    assert.throws(() => workspaceActivityPage([], 1, value), ActivityCursorError);
  }
});

test("Workspace page limits are bounded", () => {
  for (const limit of [0, -1, 201, 1.5, NaN]) assert.throws(() => workspaceActivityPage([], limit), RangeError);
});
