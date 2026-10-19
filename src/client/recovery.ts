/** Local recovery is partitioned by verified owner and exact Workspace origin.
 * Each revision has its own key: another tab can never overwrite a draft.
 */
export interface RecoveryRecord<T = unknown> {
  schema: 1; scope: string; kind: string; resource: string; id: string; updatedAt: number; value: T; supersedes?: string;
}
export class RecoveryStore {
  scope = "";
  failure = "";
  private records = new Map<string, RecoveryRecord>();
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private lastTimestamp = 0;
  private readonly prefix = "kanban.cards:recovery:v1:";
  constructor(private storage: Storage, private id: () => string) {}
  bind(scope: string): void {
    this.scope = scope;
    this.scan();
  }
  scan(): void {
    try {
      const visible = new Set<string>();
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(this.prefix) || this.removed.has(key)) continue;
        visible.add(key);
        const raw = this.storage.getItem(key);
        if (!raw) continue;
        const item = JSON.parse(raw) as RecoveryRecord;
        if (!item || typeof item !== "object" || item.schema !== 1 || typeof item.id !== "string" || typeof item.scope !== "string" || typeof item.kind !== "string" || typeof item.resource !== "string" || typeof item.updatedAt !== "number" || !("value" in item)) throw new Error("A recovery record could not be read. Export your drafts before clearing browser storage.");
        this.lastTimestamp = Math.max(this.lastTimestamp, item.updatedAt);
        if (!this.dirty.has(key)) this.records.set(key, item);
      }
      for (const key of this.records.keys()) if (!visible.has(key) && !this.dirty.has(key) && !this.removed.has(key)) this.records.delete(key);
    } catch (error) { this.failure = error instanceof Error ? error.message : "Browser storage is unavailable."; }
  }
  list<T>(kind: string, resource?: string): Array<RecoveryRecord<T>> {
    const candidates = [...this.records.values()].filter(item => item.scope === this.scope && item.kind === kind && (resource === undefined || item.resource === resource));
    const superseded = new Set(candidates.flatMap(item => item.supersedes ? [item.supersedes] : []));
    return candidates.filter(item => !superseded.has(item.id)).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)) as Array<RecoveryRecord<T>>;
  }
  put<T>(kind: string, resource: string, value: T, previousId?: string): string {
    if (!this.scope) { this.failure = "Sign in again to verify who owns this draft."; return ""; }
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    const item: RecoveryRecord<T> = { schema: 1, scope: this.scope, kind, resource, id: this.id(), updatedAt: this.lastTimestamp, value: structuredClone(value), ...(previousId ? { supersedes: previousId } : {}) };
    const key = this.prefix + item.id;
    this.records.set(key, item);
    this.dirty.add(key);
    // Write the replacement first. A failed write never removes the last durable copy.
    if (this.write(key) && previousId) this.remove(previousId);
    return item.id;
  }
  remove(id: string): boolean {
    const key = this.prefix + id;
    this.removed.add(key);
    const item = this.records.get(key);
    // Keep the new revision until its predecessor is removed. Otherwise a failed
    // predecessor delete could resurrect an older draft on the next launch.
    if (item?.supersedes && this.records.has(this.prefix + item.supersedes) && !this.remove(item.supersedes)) return false;
    try { this.storage.removeItem(key); this.records.delete(key); this.dirty.delete(key); this.removed.delete(key); return true; }
    catch { this.failure = "Browser storage could not remove a completed draft. Retry local storage before continuing."; return false; }
  }
  private write(key: string): boolean {
    try { this.storage.setItem(key, JSON.stringify(this.records.get(key))); this.dirty.delete(key); return true; }
    catch { this.failure = "Browser storage could not save your latest draft. Keep this page open, then retry or copy your recovery data."; return false; }
  }
  retry(): boolean {
    this.failure = "";
    this.scan();
    for (const key of this.dirty) this.write(key);
    for (const key of [...this.removed]) this.remove(key.slice(this.prefix.length));
    return !this.failure;
  }
  export(): string { return JSON.stringify({ schema: 1, records: [...this.records.values()].filter(item => item.scope === this.scope) }, null, 2); }
}

/** Map-compatible adapter lets the actual client persist on every input event. */
export class RecoveryMap<T> extends Map<string, T> {
  private selected = new Map<string, string>();
  constructor(private store: RecoveryStore, readonly kind: string) { super(); }
  load(): void {
    super.clear(); this.selected.clear();
    for (const item of this.store.list<T>(this.kind)) {
      if (this.has(item.resource)) continue;
      super.set(item.resource, item.value); this.selected.set(item.resource, item.id);
    }
  }
  override set(key: string, value: T): this {
    const id = this.store.put(this.kind, key, value, this.selected.get(key));
    if (id) this.selected.set(key, id);
    return super.set(key, value);
  }
  override delete(key: string): boolean {
    const id = this.selected.get(key);
    if (id) this.store.remove(id);
    this.selected.delete(key);
    return super.delete(key);
  }
  // Sign-out clears only the visible partition. The durable and failed-write memory copies remain.
  override clear(): void { super.clear(); this.selected.clear(); }
  alternatives(key: string): Array<RecoveryRecord<T>> { return this.store.list<T>(this.kind, key).filter(item => item.id !== this.selected.get(key)); }
  recover(id: string): boolean {
    const item = this.store.list<T>(this.kind).find(item => item.id === id);
    if (!item) return false;
    // Keep the visible copy too. Recovery is a choice, never a last-writer overwrite.
    super.set(item.resource, item.value); this.selected.set(item.resource, item.id); return true;
  }
}

export const cardTextFields = ["title", "body", "nextActor", "nextAction", "priority", "blockedReason"] as const;
export type CardTextField = typeof cardTextFields[number];
export function reconcileFields<T extends Record<CardTextField, unknown>>(base: T, local: T, latest: T): { value: T; conflicts: CardTextField[] } {
  const value = { ...local };
  const conflicts: CardTextField[] = [];
  for (const field of cardTextFields) {
    if (local[field] === base[field]) value[field] = latest[field];
    else if (latest[field] !== base[field] && latest[field] !== local[field]) conflicts.push(field);
  }
  return { value, conflicts };
}

export type ReconciliationField = CardTextField | "placement";
export function reconcileCardValues<T extends Record<CardTextField, unknown> & { columnId: string; position: number }>(base: T, local: T, latest: T): { value: T; conflicts: ReconciliationField[] } {
  const result = reconcileFields(base, local, latest);
  const value = { ...result.value, ...("version" in latest ? { version: latest.version } : {}), ...("archivedAt" in latest ? { archivedAt: latest.archivedAt } : {}) };
  const changedLocal = local.columnId !== base.columnId || local.position !== base.position;
  const conflicts: ReconciliationField[] = [...result.conflicts];
  if (changedLocal && (local.columnId !== latest.columnId || local.position !== latest.position)) conflicts.push("placement");
  else { value.columnId = latest.columnId; value.position = latest.position; }
  return { value, conflicts };
}
