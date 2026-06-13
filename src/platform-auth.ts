import crypto from "node:crypto";

export interface PlatformSession {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  roles: string[];
  surfaceAccess: string[];
}

export interface ClaimMapping {
  sub?: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
  workspaceId?: string;
  roles?: string;
  surfaceAccess?: string;
}

export interface PlatformAuthConfig {
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret?: string;
  oidcRedirectUri: string;
  oidcPostLogoutRedirectUri: string;
  oidcLogoutUrl?: string;
  oidcScope: string;
  oidcAudience?: string;
  sessionSecret: string;
  surfaceId: string;
  sessionTtlSeconds: number;
  oidcWorkspaceClaim?: string;
  oidcSurfaceAccessClaim?: string;
}

export interface OidcDiscoveryConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface StatePayload {
  state: string;
  returnTo: string;
  surface: string;
  csrf: string;
}

export interface PlatformAuthRouteResponse {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string;
  json?: unknown;
}

export class PlatformAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAuthConfigError";
    Object.setPrototypeOf(this, PlatformAuthConfigError.prototype);
  }
}

export const AUTH_CONFIG_MISSING = "AUTH_CONFIG_MISSING";
export const AUTH_INVALID_RETURN_TO = "AUTH_INVALID_RETURN_TO";
export const AUTH_INVALID_STATE = "AUTH_INVALID_STATE";
export const AUTH_TOKEN_EXCHANGE_FAILED = "AUTH_TOKEN_EXCHANGE_FAILED";
export const AUTH_MISSING_WORKSPACE = "AUTH_MISSING_WORKSPACE";
export const AUTH_SURFACE_DENIED = "AUTH_SURFACE_DENIED";

export const SESSION_COOKIE_PROD = "__Host-surfaces_session";
export const SESSION_COOKIE_DEV = "surfaces_session";

const PKCE_COOKIE_PROD = "__Host-surfaces_pkce";
const PKCE_COOKIE_DEV = "surfaces_pkce";
const STATE_COOKIE_PROD = "__Host-surfaces_state";
const STATE_COOKIE_DEV = "surfaces_state";
const DEFAULT_SCOPE = "openid profile email";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EPHEMERAL_COOKIE_TTL_SECONDS = 10 * 60;

const ERROR_MESSAGES: Record<string, string> = {
  [AUTH_CONFIG_MISSING]: "Authentication is not configured.",
  [AUTH_INVALID_RETURN_TO]: "Invalid returnTo URL.",
  [AUTH_INVALID_STATE]: "Invalid authentication state.",
  [AUTH_TOKEN_EXCHANGE_FAILED]: "Authentication token exchange failed.",
  [AUTH_MISSING_WORKSPACE]: "workspace_id claim missing or empty.",
  [AUTH_SURFACE_DENIED]: "User is not authorized for this surface."
};

const DEFAULT_CLAIM_KEYS = {
  sub: "sub",
  email: "email",
  name: "name",
  preferredUsername: "preferred_username",
  workspaceId: "workspace_id",
  roles: "roles",
  surfaceAccess: "surface_access"
} as const;

const NAMESPACED_CLAIM_KEYS = {
  workspaceId: "https://surfaces.systems/workspace_id",
  surfaceAccess: "https://surfaces.systems/surface_access"
} as const;

let joseModule: Promise<any> | null = null;

export function getPlatformAuthConfig(env: Record<string, string | undefined> = process.env): PlatformAuthConfig {
  const oidcIssuer = env.OIDC_ISSUER?.trim();
  const oidcClientId = env.OIDC_CLIENT_ID?.trim();
  const oidcRedirectUri = env.OIDC_REDIRECT_URI?.trim();
  const sessionSecret = env.SESSION_SECRET?.trim();
  const surfaceId = env.PLATFORM_SURFACE_ID?.trim();

  if (!oidcIssuer) throw new PlatformAuthConfigError("OIDC_ISSUER is required");
  if (!oidcClientId) throw new PlatformAuthConfigError("OIDC_CLIENT_ID is required");
  if (!oidcRedirectUri) throw new PlatformAuthConfigError("OIDC_REDIRECT_URI is required");
  if (!sessionSecret) throw new PlatformAuthConfigError("SESSION_SECRET is required");
  if (!surfaceId) throw new PlatformAuthConfigError("PLATFORM_SURFACE_ID is required");

  return {
    oidcIssuer,
    oidcClientId,
    oidcClientSecret: env.OIDC_CLIENT_SECRET?.trim() || undefined,
    oidcRedirectUri,
    oidcPostLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI?.trim() || "/",
    oidcLogoutUrl: env.OIDC_LOGOUT_URL?.trim() || undefined,
    oidcScope: env.OIDC_SCOPE?.trim() || DEFAULT_SCOPE,
    oidcAudience: env.OIDC_AUDIENCE?.trim() || undefined,
    sessionSecret,
    surfaceId,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS ? Number.parseInt(env.SESSION_TTL_SECONDS, 10) : DEFAULT_SESSION_TTL_SECONDS,
    oidcWorkspaceClaim: env.OIDC_WORKSPACE_CLAIM?.trim() || undefined,
    oidcSurfaceAccessClaim: env.OIDC_SURFACE_ACCESS_CLAIM?.trim() || undefined
  };
}

export function hasPlatformAuthConfig(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.OIDC_ISSUER?.trim() && env.OIDC_CLIENT_ID?.trim() && env.OIDC_REDIRECT_URI?.trim() && env.SESSION_SECRET?.trim() && env.PLATFORM_SURFACE_ID?.trim());
}

export async function startLogin(req: Request, opts: { surface?: string } = {}): Promise<PlatformAuthRouteResponse> {
  try {
    const config = getPlatformAuthConfig();
    const surface = normalizeSurface(opts.surface || config.surfaceId);
    const url = new URL(req.url);
    const returnTo = validateReturnTo(url.searchParams.get("returnTo") || "/");
    if (!returnTo.ok) return errorResponse(AUTH_INVALID_RETURN_TO, 400);

    const sessionResult = await getSession(req);
    if (sessionResult.ok) return redirectResponse(returnTo.value);

    const discovery = await fetchOidcConfig(config.oidcIssuer);
    const verifier = randomBase64Url(32);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = randomBase64Url(32);
    const authUrl = buildAuthorizeUrl(discovery, config, state, challenge);
    const prod = isProductionRequest(req);
    const statePayload: StatePayload = { state, returnTo: returnTo.value, surface, csrf: state };
    const stateCookie = await createStateCookie(statePayload, config.sessionSecret, prod);
    const pkceCookie = createCookie(pkceCookieName(prod), verifier, { maxAge: EPHEMERAL_COOKIE_TTL_SECONDS, production: prod });

    return redirectResponse(authUrl, [pkceCookie, stateCookie]);
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function handleCallback(req: Request, opts: { surface?: string } = {}): Promise<PlatformAuthRouteResponse> {
  let prod = false;
  try {
    const config = getPlatformAuthConfig();
    const surface = normalizeSurface(opts.surface || config.surfaceId);
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateFromIdp = url.searchParams.get("state");
    prod = isProductionRequest(req);

    if (!code || !stateFromIdp) return errorResponse(AUTH_INVALID_STATE, 400);

    const verifier = getCookieValue(req, pkceCookieName(prod));
    const statePayload = await readStateCookie(req, config.sessionSecret, prod);
    if (!verifier || !statePayload || statePayload.state !== stateFromIdp || normalizeSurface(statePayload.surface) !== surface) {
      return withSetCookies(errorResponse(AUTH_INVALID_STATE, 400), clearPkceStateCookies(prod));
    }

    const discovery = await fetchOidcConfig(config.oidcIssuer);
    const tokens = await exchangeCodeForTokens(discovery, config, code, verifier);
    const claims = await validateIdToken(discovery, config, tokens.id_token);
    const claimMapping: ClaimMapping | undefined =
      config.oidcWorkspaceClaim || config.oidcSurfaceAccessClaim
        ? {
            ...(config.oidcWorkspaceClaim ? { workspaceId: config.oidcWorkspaceClaim } : {}),
            ...(config.oidcSurfaceAccessClaim ? { surfaceAccess: config.oidcSurfaceAccessClaim } : {})
          }
        : undefined;
    const sessionResult = validateClaims(claims, surface, claimMapping);
    if (sessionResult.ok === false) {
      return withSetCookies(errorResponse(sessionResult.code, 403), clearPkceStateCookies(prod));
    }

    const returnTo = validateReturnTo(statePayload.returnTo);
    const target = returnTo.ok ? returnTo.value : "/";
    const sessionCookie = await createSessionCookie(sessionResult.session, config.sessionSecret, prod, config.sessionTtlSeconds);
    return redirectResponse(target, [sessionCookie, ...clearPkceStateCookies(prod)]);
  } catch (error) {
    const response = handleAuthError(error);
    return prod ? withSetCookies(response, clearPkceStateCookies(prod)) : response;
  }
}

export async function logout(req: Request, opts: { global?: boolean } = {}): Promise<PlatformAuthRouteResponse> {
  try {
    const config = getPlatformAuthConfig();
    const prod = isProductionRequest(req);
    const clearCookie = clearSessionCookie(prod);
    const url = new URL(req.url);
    const globalLogout = Boolean(opts.global || url.searchParams.get("global") === "1");
    if (!globalLogout) return { status: 204, headers: { "Set-Cookie": clearCookie } };

    const logoutTarget = await resolveGlobalLogoutUrl(config);
    if (!logoutTarget) return { status: 204, headers: { "Set-Cookie": clearCookie } };
    return redirectResponse(logoutTarget, [clearCookie]);
  } catch (error) {
    return handleAuthError(error);
  }
}

export function clearSessionAndRedirect(req: Request, redirectTo: string): PlatformAuthRouteResponse {
  const prod = isProductionRequest(req);
  return redirectResponse(redirectTo, [clearSessionCookie(prod)]);
}

export async function getSession(req: Request): Promise<{ ok: true; session: PlatformSession } | { ok: false }> {
  try {
    const config = getPlatformAuthConfig();
    const prod = isProductionRequest(req);
    const token = getCookieValue(req, sessionCookieName(prod));
    if (!token) return { ok: false };
    const jose = await loadJose();
    const { payload } = await jose.jwtVerify(token, secretKey(config.sessionSecret));
    return {
      ok: true,
      session: {
        userId: String(payload.userId || ""),
        email: String(payload.email || ""),
        name: String(payload.name || ""),
        workspaceId: String(payload.workspaceId || ""),
        roles: Array.isArray(payload.roles) ? payload.roles.filter(isString) : [],
        surfaceAccess: Array.isArray(payload.surfaceAccess) ? payload.surfaceAccess.filter(isString) : []
      }
    };
  } catch (_error) {
    return { ok: false };
  }
}

export async function createSessionCookie(session: PlatformSession, secret: string, production: boolean, expSeconds = DEFAULT_SESSION_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const jose = await loadJose();
  const token = await new jose.SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secretKey(secret));
  return createCookie(sessionCookieName(production), token, { maxAge: expSeconds, production });
}

export function clearSessionCookie(production: boolean): string {
  return clearCookie(sessionCookieName(production), production);
}

export function sessionCookieName(production: boolean): string {
  return production ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

export function validateClaims(
  claims: Record<string, unknown>,
  surfaceId: string,
  mapping?: ClaimMapping
): { ok: true; session: PlatformSession } | { ok: false; code: string } {
  const sub = claims[getClaimKey("sub", mapping)];
  const email = claims[getClaimKey("email", mapping)];
  const name = claims[getClaimKey("name", mapping)] ?? claims[getClaimKey("preferredUsername", mapping)];
  const workspaceId = firstClaimValue(claims, [
    getClaimKey("workspaceId", mapping),
    NAMESPACED_CLAIM_KEYS.workspaceId,
    DEFAULT_CLAIM_KEYS.workspaceId
  ]);
  const roles = claims[getClaimKey("roles", mapping)];
  const surfaceAccess = firstClaimValue(claims, [
    getClaimKey("surfaceAccess", mapping),
    NAMESPACED_CLAIM_KEYS.surfaceAccess,
    DEFAULT_CLAIM_KEYS.surfaceAccess
  ]);

  if (!workspaceId || (typeof workspaceId === "string" && !workspaceId.trim())) {
    return { ok: false, code: AUTH_MISSING_WORKSPACE };
  }

  if (Array.isArray(surfaceAccess)) {
    const allowed = surfaceAccess.some((surface) => typeof surface === "string" && surface.trim() === surfaceId);
    if (!allowed) return { ok: false, code: AUTH_SURFACE_DENIED };
  }

  return {
    ok: true,
    session: {
      userId: String(sub || ""),
      email: String(email || ""),
      name: String(name || ""),
      workspaceId: String(workspaceId),
      roles: Array.isArray(roles) ? roles.filter(isString) : [],
      surfaceAccess: Array.isArray(surfaceAccess) ? surfaceAccess.filter(isString) : []
    }
  };
}

export function isProductionRequest(req: Request): boolean {
  try {
    const forwardedHost = req.headers.get("x-forwarded-host");
    const hostHeader = forwardedHost || req.headers.get("host") || "";
    const hostnameFromHeader = hostHeader.split(",")[0]?.trim().split(":")[0]?.toLowerCase();
    if (hostnameFromHeader && hostnameFromHeader !== "localhost" && hostnameFromHeader !== "127.0.0.1") return true;
    const url = new URL(req.url);
    const hostname = url.hostname.toLowerCase();
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch (_error) {
    return false;
  }
}

function handleAuthError(error: unknown): PlatformAuthRouteResponse {
  if (error instanceof PlatformAuthConfigError) return errorResponse(AUTH_CONFIG_MISSING, 500);
  return errorResponse(AUTH_TOKEN_EXCHANGE_FAILED, 500, String((error as Error)?.message || error));
}

function errorResponse(code: string, status: number, detail?: string): PlatformAuthRouteResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    json: {
      error: code,
      message: ERROR_MESSAGES[code] || "Authentication failed.",
      ...(detail ? { detail } : {})
    }
  };
}

function redirectResponse(location: string, cookies: string[] = []): PlatformAuthRouteResponse {
  return {
    status: 302,
    headers: {
      Location: location,
      ...(cookies.length ? { "Set-Cookie": cookies } : {})
    }
  };
}

function withSetCookies(response: PlatformAuthRouteResponse, cookies: string[]): PlatformAuthRouteResponse {
  return {
    ...response,
    headers: {
      ...response.headers,
      "Set-Cookie": cookies
    }
  };
}

async function fetchOidcConfig(issuer: string): Promise<OidcDiscoveryConfig> {
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const response = await fetch(`${base}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed with ${response.status}`);
  const body = await response.json() as Partial<OidcDiscoveryConfig>;
  if (!body.issuer || !body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
    throw new Error("OIDC discovery response is incomplete");
  }
  return body as OidcDiscoveryConfig;
}

function buildAuthorizeUrl(discovery: OidcDiscoveryConfig, config: PlatformAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.oidcClientId);
  url.searchParams.set("redirect_uri", config.oidcRedirectUri);
  url.searchParams.set("scope", config.oidcScope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.oidcAudience) url.searchParams.set("audience", config.oidcAudience);
  return url.toString();
}

async function exchangeCodeForTokens(discovery: OidcDiscoveryConfig, config: PlatformAuthConfig, code: string, verifier: string): Promise<{ id_token: string }> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", config.oidcClientId);
  form.set("redirect_uri", config.oidcRedirectUri);
  form.set("code", code);
  form.set("code_verifier", verifier);
  if (config.oidcClientSecret) form.set("client_secret", config.oidcClientSecret);

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!response.ok) throw new Error(`OIDC token endpoint returned ${response.status}`);
  const body = await response.json() as { id_token?: string };
  if (!body.id_token) throw new Error("OIDC token response missing id_token");
  return { id_token: body.id_token };
}

async function validateIdToken(discovery: OidcDiscoveryConfig, config: PlatformAuthConfig, idToken: string): Promise<Record<string, unknown>> {
  const jose = await loadJose();
  const jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: config.oidcAudience || config.oidcClientId
  });
  return payload as Record<string, unknown>;
}

async function resolveGlobalLogoutUrl(config: PlatformAuthConfig): Promise<string> {
  if (config.oidcLogoutUrl) {
    const url = new URL(config.oidcLogoutUrl);
    url.searchParams.set("client_id", config.oidcClientId);
    url.searchParams.set("returnTo", config.oidcPostLogoutRedirectUri);
    return url.toString();
  }
  const discovery = await fetchOidcConfig(config.oidcIssuer);
  if (!discovery.end_session_endpoint) return "";
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("post_logout_redirect_uri", config.oidcPostLogoutRedirectUri);
  return url.toString();
}

async function createStateCookie(payload: StatePayload, secret: string, production: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + EPHEMERAL_COOKIE_TTL_SECONDS;
  const jose = await loadJose();
  const token = await new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secretKey(secret));
  return createCookie(stateCookieName(production), token, { maxAge: EPHEMERAL_COOKIE_TTL_SECONDS, production });
}

async function readStateCookie(req: Request, secret: string, production: boolean): Promise<StatePayload | null> {
  const token = getCookieValue(req, stateCookieName(production));
  if (!token) return null;
  try {
    const jose = await loadJose();
    const { payload } = await jose.jwtVerify(token, secretKey(secret));
    return {
      state: String(payload.state || ""),
      returnTo: String(payload.returnTo || "/"),
      surface: String(payload.surface || ""),
      csrf: String(payload.csrf || "")
    };
  } catch (_error) {
    return null;
  }
}

function validateReturnTo(raw: string): { ok: true; value: string } | { ok: false } {
  const value = raw.trim();
  if (!value) return { ok: true, value: "/" };
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return { ok: false };
  try {
    const parsed = new URL(value, "http://kanban.cards");
    if (parsed.origin !== "http://kanban.cards") return { ok: false };
    return { ok: true, value: `${parsed.pathname}${parsed.search}${parsed.hash}` };
  } catch (_error) {
    return { ok: false };
  }
}

function getClaimKey(contractKey: keyof typeof DEFAULT_CLAIM_KEYS, mapping?: ClaimMapping): string {
  const mapped = mapping as Record<string, string> | undefined;
  return mapped?.[contractKey] || DEFAULT_CLAIM_KEYS[contractKey];
}

function firstClaimValue(claims: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = claims[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function getCookieValue(req: Request, name: string): string {
  const header = req.headers.get("cookie") || "";
  const cookies = header.split(";").map((cookie) => cookie.trim());
  const prefix = `${name}=`;
  const match = cookies.find((cookie) => cookie.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function pkceCookieName(production: boolean): string {
  return production ? PKCE_COOKIE_PROD : PKCE_COOKIE_DEV;
}

function stateCookieName(production: boolean): string {
  return production ? STATE_COOKIE_PROD : STATE_COOKIE_DEV;
}

function clearPkceStateCookies(production: boolean): string[] {
  return [clearCookie(pkceCookieName(production), production), clearCookie(stateCookieName(production), production)];
}

function createCookie(name: string, value: string, options: { maxAge: number; production: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`
  ];
  if (options.production) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string, production: boolean): string {
  const parts = [`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
  if (production) parts.push("Secure");
  return parts.join("; ");
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function loadJose(): Promise<any> {
  joseModule ||= import("jose");
  return joseModule;
}

function normalizeSurface(surface: string): string {
  return surface.trim();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
