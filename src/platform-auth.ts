import crypto from "node:crypto";

export interface VerifiedOwnerIdentity {
  providerSubject: string;
  email: string;
  displayName: string;
}

export interface RootSession extends VerifiedOwnerIdentity {
  sessionId: string;
  rootOrigin: string;
}

export interface TenantSession extends RootSession {
  workspaceId: string;
  tenantOrigin: string;
}

export interface LogoutRetrySession {
  providerSubject: string;
  sessionId: string;
  rootOrigin: string;
  cookieOrigin: string;
}

export interface PlatformAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  sessionSecret: string;
  surfaceId: string;
  scope: string;
  rootSessionTtlSeconds: number;
  tenantSessionTtlSeconds: number;
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface AuthRouteResponse {
  status: number;
  headers?: Record<string, string | string[]>;
  json?: { error: string; message: string };
}

export interface LoginCompletion {
  identity: VerifiedOwnerIdentity;
  returnTo: string;
}

export type LoginCompletionResponse = AuthRouteResponse & { completion?: LoginCompletion };

export class PlatformAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAuthConfigError";
  }
}

export class ProviderClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderClaimError";
  }
}

export const AUTH_CONFIG_MISSING = "AUTH_CONFIG_MISSING";
export const AUTH_INVALID_RETURN_TO = "AUTH_INVALID_RETURN_TO";
export const AUTH_INVALID_STATE = "AUTH_INVALID_STATE";
export const AUTH_PROVIDER_FAILED = "AUTH_PROVIDER_FAILED";
export const AUTH_INVALID_IDENTITY = "AUTH_INVALID_IDENTITY";
export const AUTH_SURFACE_DENIED = "AUTH_SURFACE_DENIED";

export const ROOT_SESSION_COOKIE_PROD = "__Host-kanban_root_session";
export const ROOT_SESSION_COOKIE_DEV = "kanban_root_session";
export const TENANT_SESSION_COOKIE_PROD = "__Host-kanban_tenant_session";
export const TENANT_SESSION_COOKIE_DEV = "kanban_tenant_session";
export const LOGOUT_RETRY_COOKIE_PROD = "__Host-kanban_logout_retry";
export const LOGOUT_RETRY_COOKIE_DEV = "kanban_logout_retry";

const PKCE_COOKIE_PROD = "__Host-kanban_oidc_pkce";
const PKCE_COOKIE_DEV = "kanban_oidc_pkce";
const STATE_COOKIE_PROD = "__Host-kanban_oidc_state";
const STATE_COOKIE_DEV = "kanban_oidc_state";
const DEFAULT_SCOPE = "openid profile email";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EPHEMERAL_COOKIE_TTL_SECONDS = 10 * 60;
const SESSION_ISSUER = "kanban.cards";
const ROOT_SESSION_AUDIENCE = "kanban.cards:root";
const TENANT_SESSION_AUDIENCE = "kanban.cards:tenant";
const LOGOUT_RETRY_AUDIENCE = "kanban.cards:logout-retry";
const SESSION_ALGORITHM = "HS256";

const ERROR_MESSAGES: Record<string, string> = {
  [AUTH_CONFIG_MISSING]: "Authentication is not configured.",
  [AUTH_INVALID_RETURN_TO]: "The requested return location is not allowed.",
  [AUTH_INVALID_STATE]: "The sign-in request expired or could not be verified.",
  [AUTH_PROVIDER_FAILED]: "The identity provider could not complete sign-in.",
  [AUTH_INVALID_IDENTITY]: "The identity provider did not return a complete verified identity.",
  [AUTH_SURFACE_DENIED]: "This identity is not authorized for kanban.cards."
};

type JwtPayload = Record<string, unknown> & { sub?: string; jti?: string };

interface StatePayload extends JwtPayload {
  state: string;
  nonce: string;
  returnTo: string;
  surface: string;
  rootOrigin: string;
}

interface TokenResponse {
  id_token?: unknown;
}

type FetchImplementation = typeof fetch;

export function getPlatformAuthConfig(env: Record<string, string | undefined> = process.env): PlatformAuthConfig {
  const issuer = requiredEnv(env, "OIDC_ISSUER");
  const clientId = requiredEnv(env, "OIDC_CLIENT_ID");
  const redirectUri = requiredEnv(env, "OIDC_REDIRECT_URI");
  const sessionSecret = requiredEnv(env, "SESSION_SECRET");
  const surfaceId = requiredEnv(env, "PLATFORM_SURFACE_ID");

  return validatePlatformAuthConfig({
    issuer,
    clientId,
    clientSecret: optionalEnv(env, "OIDC_CLIENT_SECRET"),
    redirectUri,
    postLogoutRedirectUri: optionalEnv(env, "OIDC_POST_LOGOUT_REDIRECT_URI") || "/",
    sessionSecret,
    surfaceId,
    scope: optionalEnv(env, "OIDC_SCOPE") || DEFAULT_SCOPE,
    rootSessionTtlSeconds: positiveSeconds(env.ROOT_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, "ROOT_SESSION_TTL_SECONDS"),
    tenantSessionTtlSeconds: positiveSeconds(env.TENANT_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, "TENANT_SESSION_TTL_SECONDS")
  });
}

export function hasPlatformAuthConfig(env: Record<string, string | undefined> = process.env): boolean {
  try {
    getPlatformAuthConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function validatePlatformAuthConfig(config: PlatformAuthConfig): PlatformAuthConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new PlatformAuthConfigError("Authentication configuration is invalid");
  }

  const issuer = configString(config.issuer, "OIDC_ISSUER");
  const clientId = configString(config.clientId, "OIDC_CLIENT_ID");
  const redirectUri = configString(config.redirectUri, "OIDC_REDIRECT_URI");
  const postLogoutRedirectUri = configString(config.postLogoutRedirectUri, "OIDC_POST_LOGOUT_REDIRECT_URI");
  const sessionSecret = configString(config.sessionSecret, "SESSION_SECRET");
  const surfaceId = configString(config.surfaceId, "PLATFORM_SURFACE_ID");
  const scope = configString(config.scope, "OIDC_SCOPE");
  const clientSecret = config.clientSecret === undefined
    ? undefined
    : configString(config.clientSecret, "OIDC_CLIENT_SECRET");

  validateSecureAbsoluteUrl(issuer, "OIDC_ISSUER", { query: false });
  validateSecureAbsoluteUrl(redirectUri, "OIDC_REDIRECT_URI");
  if (new URL(redirectUri).hash) throw new PlatformAuthConfigError("OIDC_REDIRECT_URI must not contain a fragment");
  if (postLogoutRedirectUri.startsWith("/")) {
    if (!validateReturnTo(postLogoutRedirectUri)) {
      throw new PlatformAuthConfigError("OIDC_POST_LOGOUT_REDIRECT_URI must be a safe relative URL or secure absolute URL");
    }
  } else {
    validateSecureAbsoluteUrl(postLogoutRedirectUri, "OIDC_POST_LOGOUT_REDIRECT_URI");
  }
  if (surfaceId !== "kanban.cards") throw new PlatformAuthConfigError("PLATFORM_SURFACE_ID must be kanban.cards");
  if (!scope.split(/\s+/).includes("openid")) throw new PlatformAuthConfigError("OIDC_SCOPE must include openid");
  assertSessionSecret(sessionSecret);

  const rootSessionTtlSeconds = configSeconds(config.rootSessionTtlSeconds, "ROOT_SESSION_TTL_SECONDS");
  const tenantSessionTtlSeconds = configSeconds(config.tenantSessionTtlSeconds, "TENANT_SESSION_TTL_SECONDS");
  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri,
    postLogoutRedirectUri,
    sessionSecret,
    surfaceId,
    scope,
    rootSessionTtlSeconds,
    tenantSessionTtlSeconds
  };
}

export async function startOwnerLogin(
  request: Request,
  config: PlatformAuthConfig = getPlatformAuthConfig(),
  fetchImpl: FetchImplementation = fetch
): Promise<AuthRouteResponse> {
  const returnTo = validateReturnTo(new URL(request.url).searchParams.get("returnTo") || "/");
  if (!returnTo) return errorResponse(AUTH_INVALID_RETURN_TO, 400);

  try {
    config = validatePlatformAuthConfig(config);
    const rootOrigin = new URL(config.redirectUri).origin;
    if (new URL(request.url).origin !== rootOrigin) return errorResponse(AUTH_INVALID_STATE, 400);
    const discovery = await fetchDiscovery(config, fetchImpl);
    const verifier = randomToken();
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = randomToken();
    const nonce = randomToken();
    const production = isProductionRequest(request);
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizationUrl.searchParams.set("scope", config.scope);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    const stateCookie = await createStateCookie({ state, nonce, returnTo, surface: config.surfaceId, rootOrigin }, config, production);
    const pkceCookie = createCookie(pkceCookieName(production), verifier, EPHEMERAL_COOKIE_TTL_SECONDS, production);
    return redirectResponse(authorizationUrl.toString(), [pkceCookie, stateCookie]);
  } catch (error) {
    return safeAuthError(error);
  }
}

export async function finishOwnerLogin(
  request: Request,
  config: PlatformAuthConfig = getPlatformAuthConfig(),
  fetchImpl: FetchImplementation = fetch
): Promise<LoginCompletionResponse> {
  const production = isProductionRequest(request);
  const clearCookies = clearEphemeralCookies(production);
  try {
    config = validatePlatformAuthConfig(config);
    const url = new URL(request.url);
    const code = scalarString(url.searchParams.get("code"));
    const returnedState = scalarString(url.searchParams.get("state"));
    const verifier = parseCookie(request, pkceCookieName(production));
    const statePayload = await verifyStateCookie(request, config, production);
    if (
      !code ||
      !returnedState ||
      !verifier ||
      !statePayload ||
      !safeEqual(returnedState, statePayload.state) ||
      statePayload.surface !== config.surfaceId
    ) {
      return withCookies(errorResponse(AUTH_INVALID_STATE, 400), clearCookies);
    }

    const returnTo = validateReturnTo(statePayload.returnTo);
    if (!returnTo) return withCookies(errorResponse(AUTH_INVALID_RETURN_TO, 400), clearCookies);
    const discovery = await fetchDiscovery(config, fetchImpl);
    const idToken = await exchangeCode(discovery, config, code, verifier, fetchImpl);
    const claims = await verifyIdToken(discovery, config, idToken, statePayload.nonce, fetchImpl);
    const identity = validateProviderClaims(claims, config.surfaceId);
    return { status: 200, headers: { "Set-Cookie": clearCookies }, completion: { identity, returnTo } };
  } catch (error) {
    return withCookies(safeAuthError(error), clearCookies);
  }
}

export function validateProviderClaims(claims: JwtPayload, surfaceId = "kanban.cards"): VerifiedOwnerIdentity {
  const providerSubject = strictClaim(claims.sub, "subject");
  const email = strictClaim(claims.email, "email");
  if (claims.email_verified !== true) throw new ProviderClaimError(AUTH_INVALID_IDENTITY);
  const displayName = strictClaim(claims.name, "name");
  const surfaceAccess = claims["https://surfaces.systems/surface_access"] ?? claims.surface_access;
  if (!Array.isArray(surfaceAccess) || !surfaceAccess.every((value) => typeof value === "string")) {
    throw new ProviderClaimError(AUTH_SURFACE_DENIED);
  }
  if (!surfaceAccess.some((value) => value === surfaceId)) throw new ProviderClaimError(AUTH_SURFACE_DENIED);
  return { providerSubject, email, displayName };
}

export async function createRootSessionCookie(
  session: RootSession,
  secret: string,
  production: boolean,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS
): Promise<string> {
  const payload = requireRootSession(session);
  const token = await signSession(payload, secret, ROOT_SESSION_AUDIENCE, ttlSeconds);
  return createCookie(rootSessionCookieName(production), token, ttlSeconds, production);
}

export async function verifyRootSession(request: Request, secret: string, production: boolean): Promise<RootSession | null> {
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

export async function createLogoutRetryCookie(
  session: LogoutRetrySession,
  secret: string,
  production: boolean,
  ttlSeconds = EPHEMERAL_COOKIE_TTL_SECONDS
): Promise<string> {
  const payload = requireLogoutRetrySession(session);
  const token = await signSession(payload, secret, LOGOUT_RETRY_AUDIENCE, ttlSeconds);
  return createCookie(logoutRetryCookieName(production), token, ttlSeconds, production);
}

export async function verifyLogoutRetrySession(
  request: Request,
  secret: string,
  production: boolean
): Promise<LogoutRetrySession | null> {
  const token = parseCookie(request, logoutRetryCookieName(production));
  if (!token) return null;
  try {
    const payload = await verifySessionToken(token, secret, LOGOUT_RETRY_AUDIENCE);
    const session = requireLogoutRetrySession(payload);
    return new URL(request.url).origin === session.cookieOrigin ? session : null;
  } catch {
    return null;
  }
}

export function clearLogoutRetryCookie(production: boolean): string {
  return clearCookie(logoutRetryCookieName(production), production);
}

export async function createTenantSessionCookie(
  session: TenantSession,
  secret: string,
  production: boolean,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS
): Promise<string> {
  const payload = requireTenantSession(session);
  const token = await signSession(payload, secret, TENANT_SESSION_AUDIENCE, ttlSeconds);
  return createCookie(tenantSessionCookieName(production), token, ttlSeconds, production);
}

export async function verifyTenantSession(request: Request, secret: string, production: boolean): Promise<TenantSession | null> {
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

export function logoutRetryCookieName(production: boolean): string {
  return production ? LOGOUT_RETRY_COOKIE_PROD : LOGOUT_RETRY_COOKIE_DEV;
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

export function validateReturnTo(raw: string): string | null {
  const value = raw.trim();
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return value ? null : "/";
  try {
    const parsed = new URL(value, "https://kanban.cards");
    if (parsed.origin !== "https://kanban.cards") return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function isProductionRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname !== "localhost" && !hostname.endsWith(".localhost") && hostname !== "127.0.0.1" && hostname !== "::1";
}

async function fetchDiscovery(config: PlatformAuthConfig, fetchImpl: FetchImplementation): Promise<OidcDiscoveryDocument> {
  const base = config.issuer.endsWith("/") ? config.issuer.slice(0, -1) : config.issuer;
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("OIDC discovery failed");
  const body = await response.json() as Partial<OidcDiscoveryDocument>;
  if (
    scalarString(body.issuer) !== config.issuer ||
    !isHttpsUrl(body.authorization_endpoint) ||
    !isHttpsUrl(body.token_endpoint) ||
    !isHttpsUrl(body.jwks_uri)
  ) {
    throw new Error("OIDC discovery is invalid");
  }
  return body as OidcDiscoveryDocument;
}

async function exchangeCode(
  discovery: OidcDiscoveryDocument,
  config: PlatformAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: FetchImplementation
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: verifier
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  const response = await fetchImpl(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!response.ok) throw new Error("OIDC token exchange failed");
  const body = await response.json() as TokenResponse;
  const idToken = scalarString(body.id_token);
  if (!idToken) throw new Error("OIDC token response is invalid");
  return idToken;
}

async function verifyIdToken(
  discovery: OidcDiscoveryDocument,
  config: PlatformAuthConfig,
  idToken: string,
  nonce: string,
  fetchImpl: FetchImplementation
): Promise<JwtPayload> {
  const jose = await loadJose();
  const jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri), { [jose.customFetch]: fetchImpl });
  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: config.clientId
  });
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, nonce)) throw new ProviderClaimError(AUTH_INVALID_IDENTITY);
  return payload as JwtPayload;
}

async function createStateCookie(
  payload: Pick<StatePayload, "state" | "nonce" | "returnTo" | "surface" | "rootOrigin">,
  config: PlatformAuthConfig,
  production: boolean
): Promise<string> {
  const jose = await loadJose();
  const rootOrigin = strictOriginClaim(payload.rootOrigin, "rootOrigin");
  const token = await new jose.SignJWT({ ...payload, rootOrigin })
    .setProtectedHeader({ alg: SESSION_ALGORITHM, typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience("kanban.cards:oidc-state")
    .setIssuedAt()
    .setExpirationTime(`${EPHEMERAL_COOKIE_TTL_SECONDS}s`)
    .sign(secretKey(config.sessionSecret));
  return createCookie(stateCookieName(production), token, EPHEMERAL_COOKIE_TTL_SECONDS, production);
}

async function verifyStateCookie(request: Request, config: PlatformAuthConfig, production: boolean): Promise<StatePayload | null> {
  const token = parseCookie(request, stateCookieName(production));
  if (!token) return null;
  try {
    const jose = await loadJose();
    const { payload } = await jose.jwtVerify(token, secretKey(config.sessionSecret), {
      algorithms: [SESSION_ALGORITHM],
      issuer: SESSION_ISSUER,
      audience: "kanban.cards:oidc-state"
    });
    const state = strictClaim(payload.state, "state");
    const nonce = strictClaim(payload.nonce, "nonce");
    const returnTo = strictClaim(payload.returnTo, "returnTo");
    const surface = strictClaim(payload.surface, "surface");
    const rootOrigin = strictOriginClaim(payload.rootOrigin, "rootOrigin");
    if (
      rootOrigin !== new URL(config.redirectUri).origin ||
      rootOrigin !== new URL(request.url).origin
    ) return null;
    return { ...payload, state, nonce, returnTo, surface, rootOrigin };
  } catch {
    return null;
  }
}

async function signSession(
  payload: RootSession | TenantSession | LogoutRetrySession,
  secret: string,
  audience: string,
  ttlSeconds: number
): Promise<string> {
  assertSessionSecret(secret);
  const ttl = positiveSeconds(String(ttlSeconds), DEFAULT_SESSION_TTL_SECONDS, "session TTL");
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
  if (payload.sub !== payload.providerSubject || payload.jti !== payload.sessionId) throw new Error("Session identity mismatch");
  return payload as JwtPayload;
}

function requireRootSession(value: unknown): RootSession {
  const session = recordValue(value);
  return {
    providerSubject: strictClaim(session.providerSubject, "providerSubject"),
    email: strictClaim(session.email, "email"),
    displayName: strictClaim(session.displayName, "displayName"),
    sessionId: strictClaim(session.sessionId, "sessionId"),
    rootOrigin: strictOriginClaim(session.rootOrigin, "rootOrigin")
  };
}

function requireTenantSession(value: unknown): TenantSession {
  const session = recordValue(value);
  return {
    ...requireRootSession(session),
    workspaceId: strictClaim(session.workspaceId, "workspaceId"),
    tenantOrigin: strictOriginClaim(session.tenantOrigin, "tenantOrigin")
  };
}

function requireLogoutRetrySession(value: unknown): LogoutRetrySession {
  const session = recordValue(value);
  return {
    providerSubject: strictClaim(session.providerSubject, "providerSubject"),
    sessionId: strictClaim(session.sessionId, "sessionId"),
    rootOrigin: strictOriginClaim(session.rootOrigin, "rootOrigin"),
    cookieOrigin: strictOriginClaim(session.cookieOrigin, "cookieOrigin")
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session is invalid");
  return value as Record<string, unknown>;
}

function strictClaim(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new ProviderClaimError(`${label} must be a non-empty scalar string`);
  }
  return value;
}

function strictOriginClaim(value: unknown, label: string): string {
  const origin = strictClaim(value, label);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ProviderClaimError(`${label} must be an exact secure origin`);
  }
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalSessionHostname(parsed.hostname)))
  ) {
    throw new ProviderClaimError(`${label} must be an exact secure origin`);
  }
  return origin;
}

function isLocalSessionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized.endsWith(".localhost") || isExplicitLoopbackHostname(normalized);
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

function clearEphemeralCookies(production: boolean): string[] {
  return [clearCookie(pkceCookieName(production), production), clearCookie(stateCookieName(production), production)];
}

function pkceCookieName(production: boolean): string {
  return production ? PKCE_COOKIE_PROD : PKCE_COOKIE_DEV;
}

function stateCookieName(production: boolean): string {
  return production ? STATE_COOKIE_PROD : STATE_COOKIE_DEV;
}

function redirectResponse(location: string, cookies: string[] = []): AuthRouteResponse {
  return { status: 302, headers: { Location: location, ...(cookies.length ? { "Set-Cookie": cookies } : {}) } };
}

function errorResponse(error: string, status: number): AuthRouteResponse {
  return { status, json: { error, message: ERROR_MESSAGES[error] || "Authentication failed." } };
}

function withCookies<T extends AuthRouteResponse>(response: T, cookies: string[]): T {
  return { ...response, headers: { ...response.headers, "Set-Cookie": cookies } };
}

function safeAuthError(error: unknown): AuthRouteResponse {
  if (error instanceof PlatformAuthConfigError) return errorResponse(AUTH_CONFIG_MISSING, 503);
  if (error instanceof ProviderClaimError) {
    return errorResponse(error.message === AUTH_SURFACE_DENIED ? AUTH_SURFACE_DENIED : AUTH_INVALID_IDENTITY, 403);
  }
  return errorResponse(AUTH_PROVIDER_FAILED, 502);
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) throw new PlatformAuthConfigError(`${name} is required`);
  return value;
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function positiveSeconds(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new PlatformAuthConfigError(`${label} must be a positive integer`);
  return result;
}

function configString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new PlatformAuthConfigError(`${label} must be a non-empty scalar string`);
  }
  return value;
}

function configSeconds(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new PlatformAuthConfigError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function validateSecureAbsoluteUrl(value: string, label: string, options: { query?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlatformAuthConfigError(`${label} must be an absolute URL`);
  }
  if (
    value.includes("\\") ||
    value.includes("#") ||
    (options.query === false && value.includes("?")) ||
    parsed.username ||
    parsed.password
  ) {
    throw new PlatformAuthConfigError(`${label} contains unsupported URL components`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isExplicitLoopbackHostname(parsed.hostname))) {
    throw new PlatformAuthConfigError(`${label} must use HTTPS except on an explicit loopback host`);
  }
  return parsed;
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function assertSessionSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) throw new PlatformAuthConfigError("SESSION_SECRET must contain at least 32 characters");
}

function secretKey(secret: string): Uint8Array {
  assertSessionSecret(secret);
  return new TextEncoder().encode(secret);
}

function loadJose(): Promise<any> {
  return import("jose");
}
