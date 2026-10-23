import type { Activity, Project, WorkspaceActivity } from "./types";

interface ActivityKey { timestamp: number; projectId: string; id: string }

export class ActivityCursorError extends Error {}

function key(item: Activity): ActivityKey {
  const parsed = Date.parse(item.createdAt);
  return { timestamp: Number.isFinite(parsed) ? parsed : 0, projectId: item.projectId, id: item.id };
}

function compare(left: ActivityKey, right: ActivityKey): number {
  if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
  for (const field of ["projectId", "id"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? 1 : -1;
  }
  return 0;
}

function decodeCursor(value: unknown): ActivityKey | undefined {
  if (value === undefined) return undefined;
  const fail = () => { throw new ActivityCursorError("Activity cursor is invalid. Refresh Activity and try again."); };
  if (typeof value !== "string" || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return fail();
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded).equals(bytes)) return fail();
    const cursor = JSON.parse(decoded) as Record<string, unknown>;
    if (!cursor || Array.isArray(cursor) || Object.keys(cursor).sort().join(",") !== "i,p,t,v"
      || cursor.v !== 1 || typeof cursor.t !== "number" || !Number.isSafeInteger(cursor.t)
      || Math.abs(cursor.t) > 8_640_000_000_000_000
      || typeof cursor.p !== "string" || !cursor.p || cursor.p.length > 512
      || typeof cursor.i !== "string" || !cursor.i || cursor.i.length > 512) return fail();
    return { timestamp: cursor.t, projectId: cursor.p, id: cursor.i };
  } catch { return fail(); }
}

function encodeCursor(item: Activity): string {
  const k = key(item);
  return Buffer.from(JSON.stringify({ v: 1, t: k.timestamp, p: k.projectId, i: k.id })).toString("base64url");
}

/** Read retained Project history without changing it or widening its Workspace. */
export function workspaceActivityPage(projects: readonly Project[], limit: number, cursor?: unknown): {
  activity: WorkspaceActivity[]; nextCursor: string | null;
} {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Activity limit must be from 1 to 200.");
  const before = decodeCursor(cursor);
  const events = projects.flatMap(project => {
    const titles = new Map(project.cards.map(card => [card.id, card.title]));
    return project.activity.map(item => ({
      ...item,
      actor: { ...item.actor },
      projectId: project.id,
      projectName: project.name,
      projectArchivedAt: project.archivedAt,
      ...(item.cardId && titles.has(item.cardId) ? { cardTitle: titles.get(item.cardId)! } : {})
    }));
  }).filter(item => !before || compare(key(item), before) > 0)
    .sort((left, right) => compare(key(left), key(right)));
  const activity = events.slice(0, limit);
  return { activity, nextCursor: events.length > limit ? encodeCursor(activity[activity.length - 1]) : null };
}
