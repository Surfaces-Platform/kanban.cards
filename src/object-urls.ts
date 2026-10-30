/** Browser addresses use immutable IDs within the current Workspace origin. */
export interface ObjectRoute {
  projectId?: string;
  cardId?: string;
  commentId?: string;
}

const objectId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
function id(value: string): string {
  if (!objectId.test(value)) throw new Error("Invalid object identifier.");
  return value;
}

export function objectPath(route: ObjectRoute = {}): string {
  if (!route.projectId) {
    if (route.cardId || route.commentId) throw new Error("A Project is required.");
    return "/";
  }
  let path = `/projects/${id(route.projectId)}`;
  if (route.cardId) path += `/cards/${id(route.cardId)}`;
  if (route.commentId) {
    if (!route.cardId) throw new Error("A Card is required.");
    path += `#${id(route.commentId)}`;
  }
  return path;
}

export function parseObjectRoute(pathname: string, hash = ""): ObjectRoute | null {
  if (pathname === "/" || pathname === "/index.html") return hash && hash !== "#main-content" ? null : {};
  const match = /^\/projects\/([a-zA-Z0-9_-]+)(?:\/cards\/([a-zA-Z0-9_-]+))?\/?$/.exec(pathname);
  if (!match || !objectId.test(match[1]) || match[2] && !objectId.test(match[2])) return null;
  const commentId = hash && hash !== "#main-content" ? hash.slice(1) : undefined;
  if (commentId && (!match[2] || !objectId.test(commentId))) return null;
  return { projectId: match[1], ...(match[2] ? { cardId: match[2] } : {}), ...(commentId ? { commentId } : {}) };
}

/** A handoff can return only to a known object path on its own tenant. */
export function safeObjectReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("?") || value.includes("\\")) return null;
  const [pathname, ...fragments] = value.split("#");
  if (fragments.length > 1) return null;
  const route = parseObjectRoute(pathname, fragments.length ? `#${fragments[0]}` : "");
  return route ? objectPath(route) : null;
}
