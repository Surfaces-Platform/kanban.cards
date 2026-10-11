export interface VerifiedAppIdentity {
  providerSubject: string;
  email: string;
  displayName: string;
}

export type VerifiedOwnerIdentity = VerifiedAppIdentity;

export interface RootSession extends VerifiedAppIdentity {
  sessionId: string;
  rootOrigin: string;
}

export interface TenantSession extends RootSession {
  workspaceId: string;
  tenantOrigin: string;
}

export const ROOT_SESSION_COOKIE_PROD = "__Host-kanban_root_session";
export const ROOT_SESSION_COOKIE_DEV = "kanban_root_session";
export const TENANT_SESSION_COOKIE_PROD = "__Host-kanban_tenant_session";
export const TENANT_SESSION_COOKIE_DEV = "kanban_tenant_session";

export const BROWSER_SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
const SESSION_ISSUER = "kanban.cards";
const ROOT_SESSION_AUDIENCE = "kanban.cards:root";
const TENANT_SESSION_AUDIENCE = "kanban.cards:tenant";
const SESSION_ALGORITHM = "HS256";

type JwtPayload = Record<string, unknown> & { sub?: string; jti?: string };

export async function createRootSessionCookie(
  session: RootSession,
  secret: string,
  production: boolean,
  ttlSeconds = BROWSER_SESSION_TTL_SECONDS
): Promise<string> {
  const payload = requireRootSession(session);
  const token = await signSession(payload, secret, ROOT_SESSION_AUDIENCE, ttlSeconds);
  return createCookie(rootSessionCookieName(production), token, ttlSeconds, production);
}

export async function verifyRootSession(
  request: Request,
  secret: string,
  production: boolean
): Promise<RootSession | null> {
  const token = parseCookie(request, rootSessionCookieName(production));
  if (!token) return null;
  try {
    const payload = await verifySessionToken(token, secret, ROOT_SESSION_AUDIENCE);
    const session = requireRootSession(payload);
    return new URL(request.url).origin === session.rootOrigin ? session : null;
  } catch {
    return null;
  }
}

export function clearRootSessionCookie(production: boolean): string {
  return clearCookie(rootSessionCookieName(production), production);
}

export async function createTenantSessionCookie(
  session: TenantSession,
  secret: string,
  production: boolean,
  ttlSeconds = BROWSER_SESSION_TTL_SECONDS
): Promise<string> {
  const payload = requireTenantSession(session);
  const token = await signSession(payload, secret, TENANT_SESSION_AUDIENCE, ttlSeconds);
  return createCookie(tenantSessionCookieName(production), token, ttlSeconds, production);
}

export async function verifyTenantSession(
  request: Request,
  secret: string,
  production: boolean
): Promise<TenantSession | null> {
  const token = parseCookie(request, tenantSessionCookieName(production));
  if (!token) return null;
  try {
    const payload = await verifySessionToken(token, secret, TENANT_SESSION_AUDIENCE);
    const session = requireTenantSession(payload);
    return new URL(request.url).origin === session.tenantOrigin ? session : null;
  } catch {
    return null;
  }
}

export function clearTenantSessionCookie(production: boolean): string {
  return clearCookie(tenantSessionCookieName(production), production);
}

export function rootSessionCookieName(production: boolean): string {
  return production ? ROOT_SESSION_COOKIE_PROD : ROOT_SESSION_COOKIE_DEV;
}

export function tenantSessionCookieName(production: boolean): string {
  return production ? TENANT_SESSION_COOKIE_PROD : TENANT_SESSION_COOKIE_DEV;
}

export function parseCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
}

export function isProductionRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname !== "localhost"
    && !hostname.endsWith(".localhost")
    && hostname !== "127.0.0.1"
    && hostname !== "::1";
}

async function signSession(
  payload: RootSession | TenantSession,
  secret: string,
  audience: string,
  ttlSeconds: number
): Promise<string> {
  assertSessionSecret(secret);
  const ttl = positiveSeconds(ttlSeconds, "session TTL");
  const jose = await loadJose();
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: SESSION_ALGORITHM, typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(audience)
    .setSubject(payload.providerSubject)
    .setJti(payload.sessionId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secretKey(secret));
}

async function verifySessionToken(token: string, secret: string, audience: string): Promise<JwtPayload> {
  assertSessionSecret(secret);
  const jose = await loadJose();
  const { payload } = await jose.jwtVerify(token, secretKey(secret), {
    algorithms: [SESSION_ALGORITHM],
    issuer: SESSION_ISSUER,
    audience
  });
  if (payload.sub !== payload.providerSubject || payload.jti !== payload.sessionId) {
    throw new Error("Session identity mismatch");
  }
  return payload as JwtPayload;
}

function requireRootSession(value: unknown): RootSession {
  const session = recordValue(value);
  return {
    providerSubject: strictScalar(session.providerSubject, "providerSubject"),
    email: typeof session.email === "string" && session.email === session.email.trim() ? session.email : "",
    displayName: strictScalar(session.displayName, "displayName"),
    sessionId: strictScalar(session.sessionId, "sessionId"),
    rootOrigin: strictOrigin(session.rootOrigin, "rootOrigin")
  };
}

function requireTenantSession(value: unknown): TenantSession {
  const session = recordValue(value);
  return {
    ...requireRootSession(session),
    workspaceId: strictScalar(session.workspaceId, "workspaceId"),
    tenantOrigin: strictOrigin(session.tenantOrigin, "tenantOrigin")
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session is invalid");
  }
  return value as Record<string, unknown>;
}

function strictScalar(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty scalar string`);
  }
  return value;
}

function strictOrigin(value: unknown, label: string): string {
  const origin = strictScalar(value, label);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`${label} must be an exact secure origin`);
  }
  if (
    parsed.origin !== origin
    || parsed.username
    || parsed.password
    || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalSessionHostname(parsed.hostname)))
  ) {
    throw new Error(`${label} must be an exact secure origin`);
  }
  return origin;
}

function isLocalSessionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized.endsWith(".localhost") || isExplicitLoopbackHostname(normalized);
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function createCookie(name: string, value: string, maxAge: number, production: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (production) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string, production: boolean): string {
  return createCookie(name, "", 0, production);
}

function positiveSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function assertSessionSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
}

function secretKey(secret: string): Uint8Array {
  assertSessionSecret(secret);
  return new TextEncoder().encode(secret);
}

function loadJose(): Promise<any> {
  return import("jose");
}
