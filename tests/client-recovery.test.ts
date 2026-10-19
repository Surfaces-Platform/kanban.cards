/// <reference lib="dom" />
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RecoveryStore, RecoveryMap, reconcileCardValues } from "../src/client/recovery";

class BrowserStorage implements Storage {
  private values = new Map<string, string>();
  failWrite = false;
  failRemove = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw new Error("QuotaExceededError"); this.values.set(key, value); }
  removeItem(key: string) { if (this.failRemove) throw new Error("Storage unavailable"); this.values.delete(key); }
  clear() { this.values.clear(); }
}
let nextId = 0;
function store(storage: Storage, owner = "owner-a", origin = "https://one.kanban.cards", workspace = "workspace-a") {
  const result = new RecoveryStore(storage, () => `record-${++nextId}`);
  result.bind(JSON.stringify([owner, origin, workspace]));
  return result;
}

test("SI-005..009,014: the production Card reconciler consumes the shared baseline/local/latest vectors", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/shared-editing.json"), "utf8"));
  for (const item of fixture.cases) {
    const baseline = fixture.baseline;
    const result = reconcileCardValues(baseline, { ...baseline, ...item.localChanges }, { ...baseline, ...item.latestChanges });
    for (const [field, value] of Object.entries(item.expectedDraft)) assert.deepEqual(result.value[field], value, `${item.id}: ${field}`);
    assert.deepEqual(result.conflicts, item.conflicts, item.id);
  }
});

test("SI-004,015,016: actual recovery records isolate owner, exact origin and Workspace, across relaunch and same-process sign-out", () => {
  const storage = new BrowserStorage();
  const first = store(storage); const drafts = new RecoveryMap<{ body: string }>(first, "card");
  drafts.set("project-a:card-a", { body: "Unsent private source\n" });
  drafts.clear();
  assert.equal(drafts.size, 0);
  for (const isolated of [store(storage, "owner-b"), store(storage, "owner-a", "https://two.kanban.cards"), store(storage, "owner-a", "https://one.kanban.cards", "workspace-b")]) {
    const hidden = new RecoveryMap(isolated, "card"); hidden.load(); assert.equal(hidden.size, 0);
    assert.equal(isolated.export().includes("Unsent private"), false);
  }
  const relaunched = new RecoveryMap<{ body: string }>(store(storage), "card"); relaunched.load();
  assert.equal(relaunched.get("project-a:card-a")?.body, "Unsent private source\n");
  assert.equal([...Array(storage.length)].map((_, index) => storage.getItem(storage.key(index)!)).join("").includes("token"), false);
});

test("SI-016,017: quota failure preserves last durable revision, memory-only latest and explicit Retry", () => {
  const storage = new BrowserStorage(); const recovery = store(storage); const drafts = new RecoveryMap<string>(recovery, "card");
  drafts.set("p:c", "Last durable text");
  storage.failWrite = true; drafts.set("p:c", "Latest memory text");
  assert.match(recovery.failure, /could not save/);
  assert.match(recovery.export(), /Latest memory text/);
  const relaunched = new RecoveryMap<string>(store(storage), "card"); relaunched.load();
  assert.equal(relaunched.get("p:c"), "Last durable text");
  drafts.clear(); recovery.bind(JSON.stringify(["owner-b", "https://one.kanban.cards", "workspace-a"])); drafts.load();
  assert.equal(drafts.size, 0);
  recovery.bind(JSON.stringify(["owner-a", "https://one.kanban.cards", "workspace-a"])); drafts.load();
  assert.equal(drafts.get("p:c"), "Latest memory text");
  storage.failWrite = false; assert.equal(recovery.retry(), true);
  const retried = new RecoveryMap<string>(store(storage), "card"); retried.load();
  assert.equal(retried.get("p:c"), "Latest memory text");
});

test("SI-018: two actual recovery adapters never overwrite divergent tab copies", () => {
  const storage = new BrowserStorage(); const first = store(storage); const a = new RecoveryMap<string>(first, "card");
  a.set("p:c", "Shared initial draft");
  const second = store(storage); const b = new RecoveryMap<string>(second, "card"); b.load();
  a.set("p:c", "Tab A text"); b.set("p:c", "Tab B text");
  first.scan(); second.scan();
  assert.equal(a.get("p:c"), "Tab A text"); assert.equal(b.get("p:c"), "Tab B text");
  assert.equal(a.alternatives("p:c").some(item => item.value === "Tab B text"), true);
  a.delete("p:c");
  const relaunched = new RecoveryMap<string>(store(storage), "card"); relaunched.load();
  assert.equal(relaunched.get("p:c"), "Tab B text");
});

test("SI-010,012: failed completion cleanup keeps the receipt for safe recovery", () => {
  const storage = new BrowserStorage(); const recovery = store(storage); const operations = new RecoveryMap(recovery, "post");
  operations.set("comment:p:c", { key: "synthetic-operation", fingerprint: '{"body":"Original source"}', response: { comment: { id: "stored-comment" } } });
  storage.failRemove = true; operations.delete("comment:p:c");
  assert.match(recovery.failure, /completed draft/);
  assert.match(recovery.export(), /stored-comment/);
  storage.failRemove = false; assert.equal(recovery.retry(), true);
  const relaunched = new RecoveryMap(store(storage), "post"); relaunched.load(); assert.equal(relaunched.size, 0);
});


test("SI-012,017: superseded revisions do not reappear after failed cleanup and relaunch", () => {
  const storage = new BrowserStorage(); const recovery = store(storage); const drafts = new RecoveryMap<string>(recovery, "card");
  drafts.set("p:c", "Original source");
  storage.failRemove = true; drafts.set("p:c", "New source");
  const restartedStore = store(storage); const restarted = new RecoveryMap<string>(restartedStore, "card"); restarted.load();
  assert.equal(restarted.get("p:c"), "New source"); assert.equal(restarted.alternatives("p:c").length, 0);
  restarted.delete("p:c"); assert.match(restartedStore.failure, /completed draft/);
  storage.failRemove = false; assert.equal(restartedStore.retry(), true);
  const finalDrafts = new RecoveryMap<string>(store(storage), "card"); finalDrafts.load(); assert.equal(finalDrafts.size, 0);
});
