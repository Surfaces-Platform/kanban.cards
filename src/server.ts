import { normalizeInitialProject, normalizeProjectIdea } from "./project-idea";
import crypto from "node:crypto";
import { BRAND_PUBLIC_ASSETS, renderBrandHead, renderProductName } from "./brand";
import { DEFAULT_PAGE_TITLE, PUBLIC_WEBSITE_ASSETS, publicPageTitle } from "./public-website";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { AccessStoreError, createAccessStore, type AccessStore, type AccessWorkspace, type AccessRegistryState } from "./access-store";
import {
  BROWSER_SESSION_TTL_SECONDS,
  clearRootSessionCookie, clearTenantSessionCookie,
  createRootSessionCookie, createTenantSessionCookie,
  isProductionRequest, verifyRootSession, verifyTenantSession, type RootSession
} from "./app-sessions";
import {
  createPasskeyRouter, getPasskeyConfig, validatePasskeyConfig,
  passkeyAuthConfigurationRequested, hashSecret, readAuthIntent, activeOwnerSession, authenticationClientIp,
  type PasskeyAuthConfig
} from "./passkey-auth";
import { createStateStore, createWorkspaceStoreResolver, DEFAULT_WORKSPACE_ID } from "./state-store";
import { ActivityCursorError, workspaceActivityPage } from "./activity";
import { authorizeNativeCredential, createNativeAuthRouter, isNativeCredential, requireNativeRequest } from "./native-auth";
import type {
  Activity,
  ActivityActor,
  Card,
  Column,
  Comment,
  IdempotencyRecord,
  JsonValue,
  Project,
  StateStore,
  StateStoreOptions,
  WorkspaceState
} from "./types";
import type { WorkspaceStoreResolver } from "./types";

type AuthMethod = "bearer" | "cookie" | "agent" | "native";

interface OwnerAuth {
  method: AuthMethod;
  actor: ActivityActor;
  workspace: AccessWorkspace | null;
  store: StateStore;
  scopes?: readonly ("read" | "write")[];
  expiresAt?: string;
}

declare global {
  namespace Express {
    interface Request {
      ownerAuth?: OwnerAuth;
    }
  }
}

export interface CreateAppOptions extends StateStoreOptions {
  staticDir?: string;
  dataPath?: string;
  requireDatabase?: boolean;
  apiToken?: string;
  ownerLabel?: string;
  sessionTtlSeconds?: number;
  store?: StateStore;
  accessStore?: AccessStore;
  workspaceStoreResolver?: WorkspaceStoreResolver;
  passkeyAuthConfig?: PasskeyAuthConfig | null;
  rootHost?: string;
  candidateHostFamily?: CandidateHostFamilyOptions | null;
  trustForwardedHost?: boolean;
  host?: string;
  port?: string | number;
}

export interface CandidateHostFamilyOptions {
  rootHost: string;
  tenantHosts: Record<string, string>;
}

interface HttpError extends Error {
  status?: number;
}

interface MutationResult {
  statusCode: number;
  response: JsonValue;
  replayed: boolean;
}

interface ResolvedAccessContext {
  kind: "local" | "root" | "workspace";
  auth: OwnerAuth | null;
  identity: RootSession | null;
  workspace: AccessWorkspace | null;
  hostFamily: HostFamily | null;
}

interface HostFamily {
  rootHost: string;
  rootOrigin: string;
  deriveTenantHosts: boolean;
  tenantHosts: ReadonlyMap<string, string>;
}

interface ResolvedHostContext {
  kind: "root" | "workspace";
  family: HostFamily;
  workspace: AccessWorkspace | null;
}

interface AccessContextConfig {
  accessStore: AccessStore;
  apiToken: string;
  legacyStore: StateStore;
  ownerLabel: string;
  passkeyAuthConfig: PasskeyAuthConfig | null;
  hostFamilies: readonly HostFamily[];
  primaryHostFamily: HostFamily;
  trustForwardedHost: boolean;
  workspaceStoreResolver: WorkspaceStoreResolver;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;
type UnknownRecord = Record<string, unknown>;

const PRODUCT_NAME = "kanban.cards";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const SESSION_COOKIE = "kanban_cards_session";
const RESERVED_WORKSPACE_SLUGS = new Set(["api", "app", "auth", "admin", "www"]);
const MAX_ACTIVITY = 1_000;
const MAX_IDEMPOTENCY_RECORDS = 1_000;
const DEFAULT_COLUMNS = ["Next", "Doing", "Done"];
const FALLBACK_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
${renderBrandHead()}
  <title>kanban.cards</title>
  <link rel="stylesheet" href="judgmentkit.css">
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="website.css">
</head>
<body>
  <div id="app"><main class="centered-view">${renderProductName("strong")}<p>Opening your projects…</p></main></div>
  <div class="toast-region" id="toast-region" role="status" aria-live="polite" aria-atomic="true"></div>
  <script src="app.js"></script>
</body>
</html>`;

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const staticDir = options.staticDir || process.cwd();
  const configuredHost = options.host || process.env.HOST || DEFAULT_HOST;
  const production = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production" || !isLoopbackHost(configuredHost));
  const apiToken = String(options.apiToken ?? process.env.KANBAN_CARDS_API_TOKEN ?? "").trim();
  const ownerLabel = cleanLabel(options.ownerLabel ?? process.env.KANBAN_CARDS_OWNER_LABEL ?? "Owner", "Owner");
  const databaseRequired = options.requireDatabase ?? production;
  const connectionString = options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const trustForwardedHost = options.trustForwardedHost ?? Boolean(process.env.VERCEL);
  const passkeyAuthConfig = options.passkeyAuthConfig === null
    ? null
    : options.passkeyAuthConfig || (passkeyAuthConfigurationRequested() ? getPasskeyConfig() : null);
  if (passkeyAuthConfig) validatePasskeyConfig(passkeyAuthConfig);
  const rootHost = canonicalConfiguredHost(options.rootHost || process.env.KANBAN_CARDS_ROOT_HOST || (production ? PRODUCT_NAME : configuredHost));
  const rootOrigin = originForHost(rootHost);
  if (passkeyAuthConfig && isIP(new URL(rootOrigin).hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("Passkey Workspace mode requires a DNS root host such as localhost or kanban.cards.");
  }
  const primaryHostFamily: HostFamily = { rootHost, rootOrigin, deriveTenantHosts: true, tenantHosts: new Map() };
  const candidateInput = options.candidateHostFamily === null ? null : options.candidateHostFamily || candidateHostFamilyFromEnv();
  const candidateHostFamily = candidateInput ? createCandidateHostFamily(candidateInput, Boolean(passkeyAuthConfig)) : null;
  const hostFamilies = candidateHostFamily ? [primaryHostFamily, candidateHostFamily] : [primaryHostFamily];
  validateHostFamilies(hostFamilies);
  const authHost = passkeyAuthConfig?.authHost || "";
  const authOrigin = passkeyAuthConfig?.authOrigin || "";
  if (passkeyAuthConfig) {
    if (candidateHostFamily && !isStrictSubdomainHost(candidateHostFamily.rootHost, rootHost)) throw new Error("Candidate auth roots must remain same-site beneath the canonical root.");
    if (!isStrictSubdomainHost(authHost, rootHost)) throw new Error("The auth host must be a strict same-root subdomain with a matching port.");
    if (JSON.stringify([...passkeyAuthConfig.rootOrigins].sort()) !== JSON.stringify(hostFamilies.map(f => f.rootOrigin).sort())) {
      throw new Error("Passkey root origins must exactly match the configured application roots.");
    }
  }
  const sessionTtlSeconds = passkeyAuthConfig?.sessionTtlSeconds || positiveInteger(options.sessionTtlSeconds ?? process.env.KANBAN_CARDS_SESSION_TTL_SECONDS, BROWSER_SESSION_TTL_SECONDS);
  const missingConfiguration = [
    ...(!passkeyAuthConfig && !apiToken ? ["KANBAN_CARDS_API_TOKEN (local development only)"] : []),
    ...(production && !passkeyAuthConfig ? ["SESSION_SECRET and KANBAN_CARDS_AUTH_HOST"] : []),
    ...(databaseRequired && !connectionString ? ["KANBAN_CARDS_DATABASE_URL or POSTGRES_URL or DATABASE_URL"] : [])
  ];
  const legacyStore = options.store || createStateStore({
    dataPath: options.dataPath,
    connectionString,
    tableName: options.tableName,
    workspaceId: options.workspaceId,
    pool: options.pool,
    ssl: options.ssl
  });
  const workspaceStoreResolver = options.workspaceStoreResolver || (options.store
    ? fixedWorkspaceStoreResolver(options.store, DEFAULT_WORKSPACE_ID)
    : createWorkspaceStoreResolver({
        dataPath: options.dataPath,
        workspaceDirectory: options.workspaceDirectory,
        connectionString,
        tableName: options.tableName,
        pool: options.pool,
        ssl: options.ssl
      }));
  const defaultWorkspaceStore = workspaceStoreResolver.resolve(DEFAULT_WORKSPACE_ID);
  const accessStore = options.accessStore || createAccessStore({
    dataPath: process.env.KANBAN_CARDS_ACCESS_DATA_PATH,
    connectionString,
    pool: options.pool,
    ssl: options.ssl
  });
  const contextConfig: AccessContextConfig = { accessStore, apiToken, legacyStore, ownerLabel, passkeyAuthConfig, hostFamilies, primaryHostFamily, trustForwardedHost, workspaceStoreResolver };
  async function requireExistingLegacyState(): Promise<WorkspaceState> {
    const existing = await defaultWorkspaceStore.readExisting();
    if (!existing) throw httpError(503, "Existing Workspace state is unavailable.");
    return existing;
  }
  async function inspectAccessReadiness() {
    if (!passkeyAuthConfig) return { ready: !missingConfiguration.length, registry: "not-required", legacyState: "not-required", legacyBinding: "not-required" };
    try {
      const state = await accessStore.read();
      const existing = state.workspaces.find(w => w.storageId === DEFAULT_WORKSPACE_ID);
      if (existing) await requireExistingLegacyState();
      return { ready: !missingConfiguration.length, registry: "ready", legacyState: existing ? "ready" : "not-required", legacyBinding: existing ? "ready" : "not-required" };
    } catch {
      return { ready: false, registry: "unavailable", legacyState: "unavailable", legacyBinding: "not-required" };
    }
  }
  async function requireBrowserOwner(req: Request, fresh = false) {
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    const context = await resolveAccessContext(req, contextConfig);
    if (!context.identity || context.auth?.method !== "cookie") throw httpError(401, "Owner sign-in required.");
    const active = await activeOwnerSession(accessStore, context.identity.sessionId);
    if (!active) throw httpError(401, "Owner sign-in required.");
    assertExpectedOwner(req, active.owner.id);
    if (fresh && Date.now() - Date.parse(active.session.verifiedAt) > 5 * 60_000) throw httpError(403, "Fresh passkey verification required.");
    return { ...active, context };
  }
  // Access and board state use separate stores. A durable pending bootstrap and
  // fixed Project id make interruption between their commits safely recoverable.
  async function bootstrapWorkspace(workspace: AccessWorkspace): Promise<Project | undefined> {
    if (!workspace.initialProjectId) return undefined;
    const store = workspaceStoreResolver.resolve(workspace.storageId);
    const projectId = workspace.initialProjectId;
    if (!workspace.pendingInitialProject) {
      const existing = (await store.read()).projects.find(project => project.id === projectId);
      if (!existing) throw httpError(503, "Initial Project setup is unavailable. Try again.");
      return existing;
    }
    const { result } = await store.update(state => {
      const existing = state.projects.find(project => project.id === projectId);
      if (existing) return existing;
      if (!workspace.pendingInitialProject) throw httpError(503, "Initial Project setup is unavailable. Try again.");
      const input = workspace.pendingInitialProject;
      const now = workspace.createdAt;
      const project: Project = { id: projectId, name: input.name, description: "", idea: input.idea, columns: normalizeColumns(undefined, undefined), cards: [], activity: [], revision: 1, archivedAt: null, createdAt: now, updatedAt: now };
      addActivity(project, { channel: "web", label: ownerLabel }, "project.created", `Created project ${project.name}.`);
      state.projects.push(project);
      return project;
    });
    if (workspace.pendingInitialProject) await accessStore.authTransaction(state => {
      const stored = state.workspaces.find(candidate => candidate.id === workspace.id && candidate.initialProjectId === projectId);
      if (stored) delete stored.pendingInitialProject;
    });
    return result;
  }
  const loginCookieName = production ? "__Host-kanban_login_nonce" : "kanban_login_nonce";
  app.disable("x-powered-by");
  app.use(securityHeaders(passkeyAuthConfig, hostFamilies));
  app.use(express.urlencoded({ extended: false, limit: "16kb", type: "application/x-www-form-urlencoded" }));
  app.use(express.json({ limit: "256kb", type: "application/json" }));
  app.use((req, res, next) => {
    if (passkeyAuthConfig && requestHost(req, trustForwardedHost) === authHost) {
      if ((req.method === "GET" || req.method === "HEAD") && (req.path === "/" || req.path === "/index.html")) { res.redirect(302, "/sign-in"); return; }
      if (!authHostSurfaceAllows(req)) { res.status(404).type("text/plain").send("Not found"); return; }
    }
    next();
  });
  app.use((req, res, next) => {
    if (production && missingConfiguration.length && req.path.startsWith("/api/") && !["/api/health", "/api/access/health"].includes(req.path)) {
      noStore(res);
      res.status(503).json({ error: "Required server configuration is unavailable." });
      return;
    }
    next();
  });
  if (passkeyAuthConfig) {
    const router = createPasskeyRouter({ config: passkeyAuthConfig, accessStore });
    app.use("/api/passkeys", (req, res, next) => {
      if (requestHost(req, trustForwardedHost) !== authHost) { next(); return; }
      router(req, res, next);
    });
    const nativeRouter = createNativeAuthRouter({ config: { ...passkeyAuthConfig, rootOrigins: [primaryHostFamily.rootOrigin] }, accessStore });
    app.use("/api/native-auth", (req, res, next) => {
      if (requestHost(req, trustForwardedHost) !== authHost) { next(); return; }
      nativeRouter(req, res, next);
    });
    app.get("/.well-known/apple-app-site-association", (req, res, next) => {
      if (requestHost(req, trustForwardedHost) !== authHost || !passkeyAuthConfig.iosAppIds?.length) { next(); return; }
      res.json({ webcredentials: { apps: passkeyAuthConfig.iosAppIds } });
    });
  }
  app.get("/api/health", asyncHandler(async (_req, res) => {
    const access = await inspectAccessReadiness();
    res.status(access.ready ? 200 : 503).json({ ok: access.ready, product: PRODUCT_NAME, schemaVersion: 2, store: legacyStore.kind, authentication: passkeyAuthConfig ? "passkey-session+workspace" : "local-owner-key", access, missingConfiguration });
  }));
  app.get("/api/access/health", asyncHandler(async (_req, res) => {
    const access = await inspectAccessReadiness();
    res.status(access.ready ? 200 : 503).json({ ok: access.ready, authentication: passkeyAuthConfig ? "passkey-session+workspace" : "local-owner-key", registry: accessStore.kind, legacyBridge: "disabled", registryState: access.registry, legacyState: access.legacyState, legacyBinding: { present: access.legacyBinding === "ready", status: access.legacyBinding }, missingConfiguration });
  }));
  app.get("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    if (passkeyAuthConfig && requestHost(req, trustForwardedHost) === authHost) {
      const intent = readAuthIntent(req, passkeyAuthConfig);
      res.json({ authenticated: false, context: "auth", rootUrl: intent?.rootOrigin || rootOrigin, authMode: "passkey", loginUrl: `${authOrigin}/sign-in`, ...(intent ? { authIntent: { mode: intent.mode, rootOrigin: intent.rootOrigin, action: intent.action } } : {}), setupAvailable: Boolean(passkeyAuthConfig.setupOwnerId && !((await accessStore.read()).setupConsumed)) });
      return;
    }
    const context = await resolveAccessContext(req, contextConfig);
    const family = context.hostFamily || primaryHostFamily;
    res.json({ authenticated: Boolean(context.auth), context: context.kind, rootUrl: family.rootOrigin, authMode: passkeyAuthConfig ? "passkey" : "local", loginUrl: passkeyAuthConfig ? `${authOrigin}/sign-in` : "", ...(context.auth ? { label: context.auth.actor.label, email: context.identity?.email, ...(context.identity ? { ownerId: context.identity.providerSubject } : context.kind === "local" ? { ownerId: "local-owner" } : {}) } : {}), ...(context.auth?.method === "agent" ? { scopes: [...(context.auth.scopes || [])] } : {}), ...(context.auth?.method === "native" ? { authenticationMethod: "native", expiresAt: context.auth.expiresAt } : {}), ...(context.workspace ? { workspace: publicAccessWorkspace(context.workspace, family) } : {}), setupAvailable: Boolean(passkeyAuthConfig?.setupOwnerId && !((await accessStore.read()).setupConsumed)) });
  }));
  app.post("/api/auth-start", asyncHandler(async (req, res) => {
    noStore(res);
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertExactOrigin(req, family.rootOrigin);
    const body = asRecord(req.body);
    const mode = requiredString(body.mode, "Authentication mode");
    if (!["signup", "signin", "setup", "recover", "add", "verify"].includes(mode)) throw httpError(400, "Invalid authentication mode.");
    const active = mode === "add" || mode === "verify" ? await requireBrowserOwner(req, mode === "add") : null;
    const nonce = crypto.randomBytes(32).toString("base64url");
    const intentToken = crypto.randomBytes(32).toString("base64url");
    await accessStore.authTransaction(state => {
      const now = Date.now();
      state.authChallenges = state.authChallenges.filter(c => Date.parse(c.expiresAt) > now);
      const rateId = `auth-start:${hashSecret(authenticationClientIp(req))}`;
      let rate = state.authRateLimits.find(r => r.id === rateId);
      if (!rate || Date.parse(rate.resetAt) <= now) { state.authRateLimits = state.authRateLimits.filter(r => r.id !== rateId); rate = { id: rateId, count: 0, resetAt: new Date(now + 60_000).toISOString() }; state.authRateLimits.push(rate); }
      if (rate.count >= 30) throw httpError(429, "Too many authentication attempts. Try again shortly.");
      rate.count++;
      state.authChallenges.push({ id: crypto.randomUUID(), challenge: hashSecret(intentToken), browserHash: hashSecret(nonce), purpose: "authorize", ownerId: active?.owner.id || null, rootOrigin: family.rootOrigin, expiresAt: new Date(now + 5 * 60_000).toISOString(), data: { mode, action: optionalString(body.action) || "", ...(active ? { sessionId: active.session.id } : {}) } });
    });
    res.cookie(loginCookieName, nonce, { httpOnly: true, secure: production, sameSite: "lax", path: "/", maxAge: 10 * 60_000 });
    res.json({ destination: `${authOrigin}/api/passkeys/start`, intentToken, browserNonce: nonce, rootOrigin: family.rootOrigin });
  }));
  app.post("/api/auth-handoff", asyncHandler(async (req, res) => {
    noStore(res);
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertExactOrigin(req, authOrigin);
    const token = requiredString(asRecord(req.body).handoffToken, "Handoff token");
    const nonce = parseCookies(req.get("cookie") || "")[loginCookieName] || "";
    if (!nonce) throw httpError(401, "Sign-in must begin in this browser.");
    const result = await accessStore.authTransaction(state => {
      const now = Date.now();
      const h = state.authHandoffs.find(h => h.tokenHash === hashSecret(token));
      const session = h && state.authSessions.find(s => s.id === h.sessionId && s.ownerId === h.ownerId && s.rootOrigin === family.rootOrigin && !s.revokedAt && Date.parse(s.expiresAt) > now);
      const owner = h && state.owners.find(o => o.id === h.ownerId);
      if (!h || !session || !owner || h.consumedAt || Date.parse(h.expiresAt) <= now || h.browserHash !== hashSecret(nonce) || h.destinationOrigin !== family.rootOrigin) throw httpError(401, "The sign-in handoff was not accepted.");
      h.consumedAt = new Date(now).toISOString();
      return { owner, session };
    });
    const identity = { providerSubject: result.owner.id, email: result.owner.email, displayName: result.owner.displayName, sessionId: result.session.id, rootOrigin: family.rootOrigin };
    const remaining = Math.max(1, Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000));
    res.append("Set-Cookie", await createRootSessionCookie(identity, passkeyAuthConfig.sessionSecret, isProductionRequest(webRequest(req, trustForwardedHost)), remaining));
    res.clearCookie(loginCookieName, { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    res.redirect(303, "/");
  }));
  app.post("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    if (passkeyAuthConfig || production) throw httpError(404, "API route not found.");
    assertRequestOrigin(req, false, trustForwardedHost);
    if (!apiToken) throw httpError(503, "Local owner authentication is not configured.");
    if (!safeEqual(requiredString(asRecord(req.body).token, "Access key"), apiToken)) throw httpError(401, "Invalid access key.");
    const expiresAt = Math.floor(Date.now() / 1_000) + sessionTtlSeconds;
    res.cookie(SESSION_COOKIE, createSessionValue(expiresAt, apiToken), { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: sessionTtlSeconds * 1000 });
    res.json({ authenticated: true, label: ownerLabel });
  }));
  app.delete("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    if (passkeyAuthConfig && req.get("authorization")) {
      const context = await resolveAccessContext(req, contextConfig);
      if (context.auth?.method !== "native" || !context.identity) throw httpError(401, "Owner sign-in required.");
      await accessStore.authTransaction(state => {
        const session = state.nativeSessions.find(s => s.id === context.identity!.sessionId && s.ownerId === context.identity!.providerSubject);
        if (!session || session.revokedAt) throw httpError(401, "Owner sign-in required.");
        session.revokedAt = new Date().toISOString();
      });
      res.json({ signedOutHere: true, globalSignOutComplete: true });
      return;
    }
    assertRequestOrigin(req, Boolean(passkeyAuthConfig), trustForwardedHost);
    if (passkeyAuthConfig) {
      const { session } = await requireBrowserOwner(req);
      await accessStore.authTransaction(state => {
        const active = state.authSessions.find(s => s.id === session.id);
        if (active) active.revokedAt = new Date().toISOString();
        state.authHandoffs = state.authHandoffs.filter(h => h.sessionId !== session.id);
        state.handoffs = state.handoffs.filter(h => h.sessionId !== session.id);
      });
      const secure = isProductionRequest(webRequest(req, trustForwardedHost));
      res.append("Set-Cookie", clearRootSessionCookie(secure));
      res.append("Set-Cookie", clearTenantSessionCookie(secure));
      res.json({ signedOutHere: true, globalSignOutComplete: true });
      return;
    }
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    res.status(204).end();
  }));
  app.get("/api/access-settings", asyncHandler(async (req, res) => {
    noStore(res);
    const { owner, session } = await requireBrowserOwner(req);
    const state = await accessStore.read();
    res.json({ passkeys: state.passkeys.filter(p => p.ownerId === owner.id && !p.revokedAt).map(p => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })), sessions: [...state.authSessions, ...state.nativeSessions].filter(s => s.ownerId === owner.id && !s.revokedAt && Date.parse(s.expiresAt) > Date.now()).map(s => ({ id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.id === session.id })) });
  }));
  app.delete("/api/passkeys/:id", asyncHandler(async (req, res) => {
    assertRequestOrigin(req, true, trustForwardedHost);
    const { owner, session } = await requireBrowserOwner(req, true);
    await accessStore.authTransaction(state => {
      assertCurrentAuthSession(state, owner.id, session.id, true);
      const keys = state.passkeys.filter(p => p.ownerId === owner.id && !p.revokedAt);
      const key = keys.find(p => p.id === routeParam(req, "id"));
      if (!key) throw httpError(404, "Passkey unavailable.");
      if (keys.length <= 1) throw httpError(409, "Add another passkey before removing your last one.");
      key.revokedAt = new Date().toISOString();
    });
    res.status(204).end();
  }));
  app.post("/api/recovery-code", asyncHandler(async (req, res) => {
    assertRequestOrigin(req, true, trustForwardedHost);
    const { owner, session } = await requireBrowserOwner(req, true);
    const code = `kcr_${owner.id}.${crypto.randomBytes(32).toString("base64url")}`;
    await accessStore.authTransaction(state => {
      assertCurrentAuthSession(state, owner.id, session.id, true);
      state.recoveryCodes = state.recoveryCodes.filter(c => c.ownerId !== owner.id);
      state.recoveryCodes.push({ ownerId: owner.id, codeHash: hashSecret(code), createdAt: new Date().toISOString(), consumedAt: null });
    });
    res.json({ recoveryCode: code });
  }));
  app.delete("/api/sessions/:id", asyncHandler(async (req, res) => {
    assertRequestOrigin(req, true, trustForwardedHost);
    const { owner, session } = await requireBrowserOwner(req);
    await accessStore.authTransaction(state => {
      assertCurrentAuthSession(state, owner.id, session.id);
      const id = routeParam(req, "id");
      const targets = [...state.authSessions, ...state.nativeSessions].filter(s => s.ownerId === owner.id && (id === "all" || s.id === id));
      if (!targets.length) throw httpError(404, "Session unavailable.");
      for (const target of targets) target.revokedAt = new Date().toISOString();
      const ids = new Set(targets.map(s => s.id));
      state.authHandoffs = state.authHandoffs.filter(h => !ids.has(h.sessionId));
      state.handoffs = state.handoffs.filter(h => !ids.has(h.sessionId));
    });
    res.status(204).end();
  }));

  app.get("/api/workspaces", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    const identity = req.get("authorization")
      ? (await resolveAccessContext(req, contextConfig)).identity
      : await verifiedRootIdentity(req, passkeyAuthConfig, trustForwardedHost, accessStore);
    if (!identity) throw httpError(401, "Owner sign-in required.");
    const workspaces = await accessStore.listWorkspacesForOwner(identity.providerSubject);
    await Promise.all(workspaces.map(bootstrapWorkspace));
    res.json({ workspaces: workspaces.filter((workspace) => supportsWorkspace(family, workspace.slug)).map((workspace) => publicAccessWorkspace(workspace, family)) });
  }));

  app.post("/api/workspaces", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    let identity: RootSession | null;
    if (req.get("authorization")) {
      identity = (await resolveAccessContext(req, contextConfig)).identity;
    } else {
      assertRequestOrigin(req, true, trustForwardedHost);
      identity = await verifiedRootIdentity(req, passkeyAuthConfig, trustForwardedHost, accessStore);
    }
    if (!identity) throw httpError(401, "Owner sign-in required.");
    assertExpectedOwner(req, identity.providerSubject);
    rejectWorkspaceSelectors(req, true);
    const body = asRecord(req.body);
    const slug = workspaceSlug(body.slug);
    workspaceHost(slug, family);
    const initialProject = body.initialProject === undefined ? undefined : normalizeInitialProject(body.initialProject);
    const idempotencyKey = optionalString(req.get("idempotency-key"));
    if (idempotencyKey && idempotencyKey.length > 200) throw httpError(400, "Idempotency key must be at most 200 characters.");
    const requestHash = crypto.createHash("sha256").update(stableJson({ name: workspaceName(body.name), slug, ...(initialProject ? { initialProject } : {}) })).digest("hex");
    let workspace: AccessWorkspace;
    try {
      workspace = await accessStore.createWorkspace({
        providerSubject: identity.providerSubject,
        email: identity.email,
        displayName: identity.displayName,
        name: workspaceName(body.name),
        slug,
        ...(initialProject ? { initialProject } : {}),
        ...(idempotencyKey ? { idempotencyKey, requestHash } : {})
      });
    } catch (error) {
      if (error instanceof AccessStoreError && error.code === "ACCESS_CONFLICT") {
        throw httpError(409, error.message.includes("Idempotency") ? error.message : "Workspace address is already in use.");
      }
      if (error instanceof AccessStoreError && error.code === "ACCESS_FORBIDDEN") {
        throw httpError(403, error.message);
      }
      throw error;
    }
    const project = await bootstrapWorkspace(workspace);
    res.status(201).json({ workspace: publicAccessWorkspace(workspace, family), ...(project ? { project } : {}) });
  }));

  app.post("/api/workspace-handoffs", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertRequestOrigin(req, true, trustForwardedHost);
    if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
    const identity = await verifiedRootIdentity(req, passkeyAuthConfig, trustForwardedHost, accessStore);
    if (!identity) throw httpError(401, "Owner sign-in required.");
    assertExpectedOwner(req, identity.providerSubject);
    const slug = workspaceSlug(asRecord(req.body).slug);
    const workspace = (await accessStore.listWorkspacesForOwner(identity.providerSubject)).find((candidate) => candidate.slug === slug);
    if (!workspace) throw httpError(404, "Workspace unavailable.");
    const destinationHost = workspaceHost(workspace.slug, family);
    const handoff = await accessStore.createHandoff({
      providerSubject: identity.providerSubject,
      workspaceId: workspace.id,
      destinationHost,
      sessionId: identity.sessionId,
      ttlSeconds: 120
    });
    res.status(201).json({
      destination: `${originForHost(destinationHost)}/api/workspace-handoff`,
      handoffToken: handoff.token
    });
  }));

  app.post("/api/workspace-handoff", asyncHandler(async (req, res) => {
    const host = requestHost(req, trustForwardedHost);
    const hostContext = await resolveKnownHost(host, hostFamilies, accessStore);
    const family = hostContext?.family;
    const workspace = hostContext?.kind === "workspace" ? hostContext.workspace : null;
    if (!family || !passkeyAuthConfig) throw httpError(404, "API route not found.");
    if (!workspace) throw httpError(404, "Workspace unavailable.");
    assertExactOrigin(req, family.rootOrigin);
    try {
      const consumed = await accessStore.consumeHandoff({ token: requiredString(asRecord(req.body).token, "Handoff token"), destinationHost: host });
      const active = await activeOwnerSession(accessStore, consumed.sessionId);
      if (!active || active.session.ownerId !== consumed.owner.id || active.session.rootOrigin !== family.rootOrigin) throw httpError(401, "The sign-in handoff was not accepted.");
      if (consumed.workspace.id !== workspace.id) throw httpError(401, "The sign-in handoff was not accepted.");
      const tenantSession = {
        providerSubject: consumed.owner.id,
        email: consumed.owner.email,
        displayName: consumed.owner.displayName,
        sessionId: consumed.sessionId,
        workspaceId: workspace.id,
        rootOrigin: family.rootOrigin,
        tenantOrigin: originForHost(host)
      };
      res.append("Set-Cookie", await createTenantSessionCookie(
        tenantSession,
        passkeyAuthConfig.sessionSecret,
        isProductionRequest(webRequest(req, trustForwardedHost)),
        Math.max(1, Math.floor((Date.parse(active.session.expiresAt) - Date.now()) / 1000))
      ));
      if (req.is("application/x-www-form-urlencoded")) {
        res.redirect(303, "/");
        return;
      }
      res.json({ authenticated: true, workspace: publicAccessWorkspace(workspace, family) });
    } catch (error) {
      if (error instanceof AccessStoreError) throw httpError(401, "The sign-in handoff was not accepted.");
      throw error;
    }
  }));

  app.use("/api/agent-connections", (req, _res, next) => {
    void (async () => {
      if (!passkeyAuthConfig) throw httpError(404, "API route not found.");
      rejectWorkspaceSelectors(req, req.method !== "GET" && req.method !== "HEAD");
      const context = await resolveAccessContext(req, contextConfig);
      if (!context.auth || context.auth.method !== "cookie" || !context.identity || !context.workspace) throw httpError(401, "Owner sign-in required.");
      if (req.method !== "GET" && req.method !== "HEAD") assertExpectedOwner(req, context.identity.providerSubject);
      if (req.method !== "GET" && req.method !== "HEAD") assertRequestOrigin(req, true, trustForwardedHost);
      req.ownerAuth = context.auth;
      next();
    })().catch(next);
  });

  app.get("/api/agent-connections", asyncHandler(async (req, res) => {
    noStore(res);
    const identity = (await resolveTenantOwner(req, passkeyAuthConfig!, trustForwardedHost, accessStore, req.ownerAuth!.workspace!));
    const connections = await accessStore.listAgentConnections(identity.providerSubject, req.ownerAuth!.workspace!.id);
    res.json({ connections: connections.map(publicAgentConnection) });
  }));

  app.post("/api/agent-connections", asyncHandler(async (req, res) => {
    noStore(res);
    const identity = await resolveTenantOwner(req, passkeyAuthConfig!, trustForwardedHost, accessStore, req.ownerAuth!.workspace!);
    const { session } = await requireBrowserOwner(req, true);
    const body = asRecord(req.body);
    let issued;
    try {
      issued = await accessStore.createAgentConnection({ authSessionId: session.id, providerSubject: identity.providerSubject, workspaceId: req.ownerAuth!.workspace!.id, label: requiredString(body.label, "Agent label"), scopes: body.scopes as ("read" | "write")[], expiresAt: body.expiresAt == null ? null : requiredString(body.expiresAt, "Agent expiry") });
    } catch (error) {
      if (error instanceof AccessStoreError && error.code === "ACCESS_RATE_LIMITED") throw httpError(429, error.message);
      if (error instanceof AccessStoreError && error.code === "ACCESS_FORBIDDEN") throw httpError(403, error.message);
      if (error instanceof Error) throw httpError(400, error.message);
      throw error;
    }
    res.status(201).json({ connection: publicAgentConnection(issued.connection), credential: issued.credential });
  }));

  app.delete("/api/agent-connections/:connectionId", asyncHandler(async (req, res) => {
    const identity = await resolveTenantOwner(req, passkeyAuthConfig!, trustForwardedHost, accessStore, req.ownerAuth!.workspace!);
    const connection = await accessStore.revokeAgentConnection(identity.providerSubject, req.ownerAuth!.workspace!.id, routeParam(req, "connectionId"));
    res.json({ connection: publicAgentConnection(connection) });
  }));

  const indexHandler = serveIndex(staticDir, req => {
    if (!passkeyAuthConfig) return DEFAULT_PAGE_TITLE;
    const host = requestHost(req, trustForwardedHost);
    if (host === authHost) return publicPageTitle({ context: "auth", authenticated: false, resolved: true, authMode: readAuthIntent(req, passkeyAuthConfig)?.mode });
    // Give anonymous crawlers the homepage title without interpreting credentials or private shells.
    // The client resolves cookies, query-driven receipts and authenticated views before applying task titles.
    if (hostFamilies.some(family => family.rootHost === host) && !req.get("cookie") && !req.get("authorization") && !req.originalUrl.includes("?")) {
      return publicPageTitle({ context: "root", authenticated: false, resolved: true });
    }
    return DEFAULT_PAGE_TITLE;
  });
  app.get("/", indexHandler);
  app.get("/index.html", indexHandler);
  app.get("/sign-in", indexHandler);
  app.get("/sign-up", indexHandler);
  app.get("/app.js", sendStaticFile(staticDir, "public/app.js", "application/javascript; charset=utf-8"));
  app.get("/judgmentkit.css", sendStaticFile(staticDir, "public/judgmentkit.css", "text/css; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "public/styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", (req, res, next) => {
    if (requestHost(req, trustForwardedHost) !== rootHost) {
      res.type("text/plain").send("User-agent: *\nDisallow: /\n");
      return;
    }
    return sendStaticFile(staticDir, "public/robots.txt", "text/plain; charset=utf-8")(req, res, next);
  });
  for (const [route, asset, contentType] of [...BRAND_PUBLIC_ASSETS, ...PUBLIC_WEBSITE_ASSETS]) app.get(route, sendStaticFile(staticDir, asset, contentType));

  app.use(["/api/projects", "/api/activity"], (req, _res, next) => {
    void (async () => {
      if (missingConfiguration.length) throw httpError(503, `Missing required configuration: ${missingConfiguration.join(", ")}.`);
      rejectWorkspaceSelectors(req, req.method !== "GET" && req.method !== "HEAD");
      const context = await resolveAccessContext(req, contextConfig);
      const auth = context.auth;
      if (!auth || context.kind === "root") throw httpError(401, "Authentication required.");
      if (req.method !== "GET" && req.method !== "HEAD") assertExpectedOwner(req, context.identity?.providerSubject || (context.kind === "local" ? "local-owner" : null));
      if (context.workspace?.storageId === DEFAULT_WORKSPACE_ID) await requireExistingLegacyState();
      req.ownerAuth = auth;
      if (req.method !== "GET" && req.method !== "HEAD" && auth.method === "cookie") assertRequestOrigin(req, true, trustForwardedHost);
      if (context.workspace?.pendingInitialProject) await bootstrapWorkspace(context.workspace);
      next();
    })().catch(next);
  });

  app.get("/api/activity", asyncHandler(async (req, res) => {
    noStore(res);
    if (Object.keys(req.query).some(key => key !== "limit" && key !== "cursor")
      || (req.query.limit !== undefined && typeof req.query.limit !== "string")) {
      throw httpError(400, "Activity accepts one limit and one cursor parameter.");
    }
    const state = await requestStore(req).read();
    const limit = boundedInteger(req.query.limit, 50, 1, 200);
    try {
      res.json(workspaceActivityPage(state.projects, limit, req.query.cursor));
    } catch (error) {
      if (error instanceof ActivityCursorError) throw httpError(400, error.message);
      throw error;
    }
  }));

  app.get("/api/projects", asyncHandler(async (req, res) => {
    noStore(res);
    const includeArchived = req.query.includeArchived === "true";
    const state = await requestStore(req).read();
    res.json({ projects: state.projects.filter((project) => includeArchived || !project.archivedAt).map(projectSummary) });
  }));

  app.post("/api/projects", asyncHandler(async (req, res) => {
    const body = asRecord(req.body);
    const actor = requireActor(req);
    const outcome = (await requestStore(req).update((state) => idempotentMutation(req, state, () => {
      const now = new Date().toISOString();
      const project: Project = {
        id: makeId("project"),
        name: requiredString(body.name, "Project name"),
        description: optionalText(body.description),
        ...(body.idea === undefined ? {} : { idea: normalizeProjectIdea(body.idea) }),
        columns: normalizeColumns(body.columns, undefined),
        cards: [],
        activity: [],
        revision: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now
      };
      addActivity(project, actor, "project.created", `Created project ${project.name}.`);
      state.projects.push(project);
      return { statusCode: 201, response: jsonValue({ project }) };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.get("/api/projects/:projectId", asyncHandler(async (req, res) => {
    noStore(res);
    const project = findProject(await requestStore(req).read(), routeParam(req, "projectId"));
    res.setHeader("ETag", quoteVersion(project.revision));
    res.json({ project });
  }));

  app.get("/api/projects/:projectId/cards", asyncHandler(async (req, res) => {
    noStore(res);
    const supportedFilters = new Set(["nextActor", "priority", "blocked", "includeArchived"]);
    if (Object.keys(req.query).some((key) => !supportedFilters.has(key))) {
      throw httpError(400, "Supported Card filters are nextActor, priority, blocked, and includeArchived.");
    }
    const nextActor = queryEnum(req.query.nextActor, ["human", "agent", "unassigned"], "nextActor");
    const priority = queryEnum(req.query.priority, ["High", "Medium", "Low", "unset"], "priority");
    const blocked = queryEnum(req.query.blocked, ["true", "false"], "blocked");
    const includeArchived = queryEnum(req.query.includeArchived, ["true", "false"], "includeArchived") === "true";
    const project = findProject(await requestStore(req).read(), routeParam(req, "projectId"));
    const cards = project.cards.filter((card) => {
      if (!includeArchived && card.archivedAt) return false;
      if (nextActor !== undefined && card.nextActor !== (nextActor === "unassigned" ? null : nextActor)) return false;
      if (priority !== undefined && card.priority !== (priority === "unset" ? null : priority)) return false;
      if (blocked !== undefined && Boolean(card.blockedReason.trim()) !== (blocked === "true")) return false;
      return true;
    });
    res.json({ cards, projectRevision: project.revision });
  }));

  app.patch("/api/projects/:projectId", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const expectedRevision = requiredMatch(req, "Project revision");
    const { result } = await requestStore(req).update((state) => {
      const project = findProject(state, projectId);
      assertVersion(project.revision, expectedRevision, "Project");
      let changed = false;
      if (hasOwn(body, "name")) {
        project.name = requiredString(body.name, "Project name");
        changed = true;
      }
      if (hasOwn(body, "description")) {
        project.description = optionalText(body.description);
        changed = true;
      }
      if (hasOwn(body, "idea")) {
        const input = asRecord(body.idea);
        if (project.idea && hasOwn(input, "originalInput") && input.originalInput !== project.idea.originalInput) throw httpError(409, "The original Idea is preserved and cannot be changed.");
        project.idea = normalizeProjectIdea(project.idea ? { ...project.idea, ...input } : input);
        changed = true;
      }
      if (hasOwn(body, "columns")) {
        const columns = normalizeColumns(body.columns, project.columns);
        const columnIds = new Set(columns.map((column) => column.id));
        const strandedCard = project.cards.find((card) => !columnIds.has(card.columnId));
        if (strandedCard) throw httpError(409, `Column ${strandedCard.columnId} still contains card ${strandedCard.id}.`);
        project.columns = columns;
        changed = true;
      }
      if (hasOwn(body, "archivedAt")) {
        project.archivedAt = nullableTimestamp(body.archivedAt, "Project archivedAt");
        changed = true;
      }
      if (!changed) throw httpError(400, "No supported project changes were provided.");
      touchProject(project);
      addActivity(project, actor, project.archivedAt ? "project.archived" : "project.updated", `Updated project ${project.name}.`);
      return { project };
    });
    res.setHeader("ETag", quoteVersion(result.project.revision));
    res.json(result);
  }));

  app.post("/api/projects/:projectId/cards", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const outcome = (await requestStore(req).update((state) => idempotentMutation(req, state, () => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const externalKey = optionalString(body.externalKey);
      if (externalKey) {
        const existing = project.cards.find((card) => card.externalKey === externalKey);
        if (existing) {
          return {
            statusCode: 200,
            response: jsonValue({ card: existing, projectRevision: project.revision, deduplicated: true })
          };
        }
      }
      const columnId = optionalString(body.columnId) || project.columns[0]?.id;
      if (!columnId || !project.columns.some((column) => column.id === columnId)) throw httpError(400, "A valid columnId is required.");
      const now = new Date().toISOString();
      const card: Card = {
        id: makeId("card"),
        ...(externalKey ? { externalKey } : {}),
        title: requiredString(body.title, "Card title"),
        body: cardBodyText(body.body),
        nextActor: nullableEnum(body.nextActor, ["human", "agent"], "Card nextActor"),
        nextAction: cardMetadataText(body.nextAction, "Card nextAction"),
        priority: nullableEnum(body.priority, ["High", "Medium", "Low"], "Card priority"),
        blockedReason: cardMetadataText(body.blockedReason, "Card blockedReason"),
        columnId,
        position: optionalPosition(body.position, nextCardPosition(project, columnId)),
        version: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        comments: []
      };
      project.cards.push(card);
      touchProject(project);
      addActivity(project, actor, "card.created", `Created card ${card.title}.`, card.id);
      return { statusCode: 201, response: jsonValue({ card, projectRevision: project.revision }) };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.patch("/api/projects/:projectId/cards/:cardId", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const cardId = routeParam(req, "cardId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const expectedVersion = requiredMatch(req, "Card version");
    const { result } = await requestStore(req).update((state) => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const card = findCard(project, cardId);
      assertVersion(card.version, expectedVersion, "Card");
      let changed = false;
      let moved = false;
      if (hasOwn(body, "title")) {
        card.title = requiredString(body.title, "Card title");
        changed = true;
      }
      if (hasOwn(body, "body")) {
        card.body = cardBodyText(body.body);
        changed = true;
      }
      if (hasOwn(body, "nextActor")) {
        card.nextActor = nullableEnum(body.nextActor, ["human", "agent"], "Card nextActor");
        changed = true;
      }
      if (hasOwn(body, "nextAction")) {
        card.nextAction = cardMetadataText(body.nextAction, "Card nextAction");
        changed = true;
      }
      if (hasOwn(body, "priority")) {
        card.priority = nullableEnum(body.priority, ["High", "Medium", "Low"], "Card priority");
        changed = true;
      }
      if (hasOwn(body, "blockedReason")) {
        card.blockedReason = cardMetadataText(body.blockedReason, "Card blockedReason");
        changed = true;
      }
      if (hasOwn(body, "columnId")) {
        const columnId = requiredString(body.columnId, "Card columnId");
        if (!project.columns.some((column) => column.id === columnId)) throw httpError(400, "Card columnId does not exist in this project.");
        moved = columnId !== card.columnId;
        card.columnId = columnId;
        if (!hasOwn(body, "position") && moved) card.position = nextCardPosition(project, columnId, card.id);
        changed = true;
      }
      if (hasOwn(body, "position")) {
        card.position = optionalPosition(body.position, card.position);
        changed = true;
      }
      if (hasOwn(body, "archivedAt")) {
        card.archivedAt = nullableTimestamp(body.archivedAt, "Card archivedAt");
        changed = true;
      }
      if (!changed) throw httpError(400, "No supported card changes were provided.");
      touchCard(card);
      touchProject(project);
      const action = card.archivedAt ? "card.archived" : moved ? "card.moved" : "card.updated";
      addActivity(project, actor, action, `${formatAction(action)} ${card.title}.`, card.id);
      return { card, projectRevision: project.revision };
    });
    res.setHeader("ETag", quoteVersion(result.card.version));
    res.json(result);
  }));

  app.post("/api/projects/:projectId/cards/:cardId/comments", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const cardId = routeParam(req, "cardId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const outcome = (await requestStore(req).update((state) => idempotentMutation(req, state, () => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const card = findCard(project, cardId);
      const comment: Comment = {
        id: makeId("comment"),
        body: requiredString(body.body, "Comment body"),
        author: actor.label,
        createdAt: new Date().toISOString()
      };
      card.comments.push(comment);
      touchCard(card);
      touchProject(project);
      addActivity(project, actor, "comment.created", `${actor.label} commented on ${card.title}.`, card.id);
      return {
        statusCode: 201,
        response: jsonValue({
          comment,
          card: { id: card.id, version: card.version },
          projectRevision: project.revision
        })
      };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.get("/api/projects/:projectId/activity", asyncHandler(async (req, res) => {
    noStore(res);
    const project = findProject(await requestStore(req).read(), routeParam(req, "projectId"));
    const limit = boundedInteger(req.query.limit, 50, 1, 200);
    res.json({ activity: project.activity.slice(-limit), projectRevision: project.revision });
  }));

  app.use("/api", (_req, _res, next) => next(httpError(404, "API route not found.")));
  app.use((req, res) => {
    res.status(404).type("text/plain").send(`Not found: ${req.path}`);
  });
  app.use(errorHandler());

  return app;
}

function assertCurrentAuthSession(state: AccessRegistryState, ownerId: string, sessionId: string, fresh = false): void {
  const session = state.authSessions.find(s => s.id === sessionId && s.ownerId === ownerId && !s.revokedAt && Date.parse(s.expiresAt) > Date.now());
  if (!session || state.revokedSessions.some(s => s.sessionId === sessionId)) throw httpError(401, "Owner sign-in required.");
  if (fresh && Date.now() - Date.parse(session.verifiedAt) > 5 * 60_000) throw httpError(403, "Fresh passkey verification required.");
}

function securityHeaders(config: PasskeyAuthConfig | null, families: readonly HostFamily[]): RequestHandler {
  const formOrigins = ["'self'", ...(config ? [config.authOrigin] : []), ...families.flatMap(family => {
    const root = new URL(family.rootOrigin);
    return [family.rootOrigin, ...(family.deriveTenantHosts ? [`${root.protocol}//*.${root.hostname}${root.port ? `:${root.port}` : ""}`] : [...family.tenantHosts.keys()].map(originForHost))];
  })].join(" ");
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action ${formOrigins}`);
    if (req.path.startsWith("/api/")) noStore(res);
    next();
  };
}

function authenticateLocal(
  req: Request,
  config: { apiToken: string; ownerLabel: string; store: StateStore }
): OwnerAuth | null {
  const authorization = req.get("authorization") || "";
  if (authorization) {
    if (!authorization.startsWith("Bearer ") || !config.apiToken) return null;
    const supplied = authorization.slice("Bearer ".length).trim();
    if (!safeEqual(supplied, config.apiToken)) return null;
    return {
      method: "bearer",
      actor: { channel: "api", label: cleanLabel(req.get("x-kanban-actor"), config.ownerLabel) },
      workspace: null,
      store: config.store
    };
  }
  const cookie = parseCookies(req.get("cookie") || "")[SESSION_COOKIE];
  if (cookie && config.apiToken && verifySessionValue(cookie, config.apiToken)) {
    return { method: "cookie", actor: { channel: "web", label: config.ownerLabel }, workspace: null, store: config.store };
  }
  return null;
}

async function resolveAccessContext(req: Request, config: AccessContextConfig): Promise<ResolvedAccessContext> {
  const host = requestHost(req, config.trustForwardedHost);
  const hostContext = await resolveKnownHost(host, config.hostFamilies, config.accessStore);
  const hostFamily = hostContext?.family || null;
  const tenantWorkspace = hostContext?.kind === "workspace" ? hostContext.workspace : null;

  if (!config.passkeyAuthConfig) {
    return {
      kind: "local",
      auth: authenticateLocal(req, { apiToken: config.apiToken, ownerLabel: config.ownerLabel, store: config.legacyStore }),
      identity: null,
      workspace: null,
      hostFamily: config.primaryHostFamily
    };
  }

  if (!hostContext || !hostFamily) {
    throw httpError(404, "Workspace unavailable.");
  }

  const authorization = req.get("authorization") || "";
  if (authorization) {
    const bearer = /^Bearer\s+(\S+)$/.exec(authorization)?.[1] || "";
    if (isNativeCredential(bearer)) {
      requireNativeRequest(req);
      const verified = await authorizeNativeCredential(config.accessStore, bearer, hostFamily.rootOrigin, tenantWorkspace?.id || null);
      if (!verified || (hostContext.kind === "workspace" && !tenantWorkspace)) return { kind: hostContext.kind, auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
      return {
        kind: hostContext.kind,
        auth: { method: "native", actor: { channel: "native", label: cleanLabel(verified.owner.displayName, config.ownerLabel) }, workspace: tenantWorkspace, store: tenantWorkspace ? config.workspaceStoreResolver.resolve(tenantWorkspace.storageId) : config.legacyStore, expiresAt: verified.session.expiresAt },
        identity: { providerSubject: verified.owner.id, email: verified.owner.email, displayName: verified.owner.displayName, sessionId: verified.session.id, rootOrigin: verified.session.rootOrigin },
        workspace: tenantWorkspace, hostFamily
      };
    }
    if (hostContext.kind !== "workspace" || !tenantWorkspace) return { kind: hostContext.kind, auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
    try {
      const verified = await config.accessStore.authorizeAgentCredential({ credential: bearer, workspaceId: tenantWorkspace.id, requiredScope: req.method === "GET" || req.method === "HEAD" ? "read" : "write" });
      return { kind: "workspace", auth: { method: "agent", actor: { channel: "api", label: verified.connection.label, agentConnectionId: verified.connection.id }, workspace: verified.workspace, store: config.workspaceStoreResolver.resolve(verified.workspace.storageId), scopes: verified.connection.scopes }, identity: null, workspace: verified.workspace, hostFamily };
    } catch (error) {
      if (error instanceof AccessStoreError && error.code === "ACCESS_AGENT_SCOPE_MISSING") throw httpError(403, error.message);
      if (!(error instanceof AccessStoreError)) throw error;
      return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
    }
  }

  if (hostContext.kind === "root") {
    const identity = await verifiedRootIdentity(req, config.passkeyAuthConfig, config.trustForwardedHost, config.accessStore);
    return {
      kind: "root",
      auth: identity ? {
        method: "cookie",
        actor: { channel: "web", label: cleanLabel(identity.displayName, config.ownerLabel) },
        workspace: null,
        store: config.legacyStore
      } : null,
      identity,
      workspace: null,
      hostFamily
    };
  }

  if (!tenantWorkspace) return { kind: "workspace", auth: null, identity: null, workspace: null, hostFamily };

  const appRequest = webRequest(req, config.trustForwardedHost);
  const tenantSession = await verifyTenantSession(appRequest, config.passkeyAuthConfig.sessionSecret, isProductionRequest(appRequest));
  if (!tenantSession || tenantSession.workspaceId !== tenantWorkspace.id) {
    return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
  }
  const active = await activeOwnerSession(config.accessStore, tenantSession.sessionId);
  if (!active || active.owner.id !== tenantSession.providerSubject || active.session.rootOrigin !== hostFamily.rootOrigin || tenantSession.rootOrigin !== hostFamily.rootOrigin) {
    return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
  }
  const ownerAccess = await config.accessStore.resolveOwner(tenantSession.providerSubject);
  if (!ownerAccess || !ownerAccess.workspaces.some((workspace) => workspace.id === tenantWorkspace.id)) {
    return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
  }
  return {
    kind: "workspace",
    auth: {
      method: "cookie",
      actor: { channel: "web", label: cleanLabel(ownerAccess.owner.displayName, config.ownerLabel) },
      workspace: tenantWorkspace,
      store: config.workspaceStoreResolver.resolve(tenantWorkspace.storageId)
    },
    identity: {
      providerSubject: ownerAccess.owner.id,
      email: ownerAccess.owner.email,
      displayName: ownerAccess.owner.displayName,
      sessionId: tenantSession.sessionId,
      rootOrigin: tenantSession.rootOrigin
    },
    workspace: tenantWorkspace,
    hostFamily
  };
}

function requestStore(req: Request): StateStore {
  if (!req.ownerAuth) throw httpError(401, "Authentication required.");
  return req.ownerAuth.store;
}

function fixedWorkspaceStoreResolver(store: StateStore, storageId: string): WorkspaceStoreResolver {
  return {
    kind: store.kind,
    resolve(requestedStorageId: string): StateStore {
      if (requestedStorageId !== storageId) throw new Error(`Workspace store ${requestedStorageId} is unavailable in this fixture.`);
      return store;
    }
  };
}

async function verifiedRootIdentity(
  req: Request,
  config: PasskeyAuthConfig,
  trustForwardedHost: boolean,
  accessStore?: AccessStore
): Promise<RootSession | null> {
  const platformRequest = webRequest(req, trustForwardedHost);
  const identity = await verifyRootSession(platformRequest, config.sessionSecret, isProductionRequest(platformRequest));
  if (!identity) return null;
  if (!accessStore) return null;
  const active = await activeOwnerSession(accessStore, identity.sessionId);
  if (!active || active.owner.id !== identity.providerSubject || active.session.rootOrigin !== identity.rootOrigin) return null;
  return { ...identity, email: active.owner.email, displayName: active.owner.displayName };
}

async function resolveTenantOwner(
  req: Request,
  config: PasskeyAuthConfig,
  trustForwardedHost: boolean,
  accessStore: AccessStore,
  workspace: AccessWorkspace
): Promise<RootSession> {
  const platformRequest = webRequest(req, trustForwardedHost);
  const session = await verifyTenantSession(platformRequest, config.sessionSecret, isProductionRequest(platformRequest));
  const active = session && await activeOwnerSession(accessStore, session.sessionId);
  if (!session || session.workspaceId !== workspace.id || !active || active.owner.id !== session.providerSubject || active.session.rootOrigin !== session.rootOrigin) {
    throw httpError(401, "Owner sign-in required.");
  }
  const owner = await accessStore.resolveOwner(session.providerSubject);
  if (!owner || !owner.workspaces.some((candidate) => candidate.id === workspace.id)) throw httpError(401, "Owner sign-in required.");
  return { providerSubject: owner.owner.id, email: owner.owner.email, displayName: owner.owner.displayName, sessionId: session.sessionId, rootOrigin: session.rootOrigin };
}

function publicAgentConnection(connection: import("./access-store").AgentConnection): UnknownRecord {
  return {
    id: connection.id,
    label: connection.label,
    scopes: [...connection.scopes],
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    expiresAt: connection.expiresAt,
    revokedAt: connection.revokedAt
  };
}

function webRequest(req: Request, trustForwardedHost: boolean): globalThis.Request {
  const protocol = requestProtocol(req, trustForwardedHost);
  const host = requestHost(req, trustForwardedHost);
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    if (Array.isArray(raw)) for (const value of raw) headers.append(name, value);
    else if (raw !== undefined) headers.set(name, raw);
  }
  return new globalThis.Request(`${protocol}://${host}${req.originalUrl}`, { method: req.method, headers });
}

function requestOrigin(request: globalThis.Request): string {
  return new URL(request.url).origin;
}

function canonicalConfiguredHost(raw: string): string {
  const value = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!value) throw new Error("Root host is required.");
  try {
    const parsed = new URL(`http://${value}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return parsed.host;
  } catch {
    throw new Error("Root host is invalid.");
  }
}

function candidateHostFamilyFromEnv(env: Record<string, string | undefined> = process.env): CandidateHostFamilyOptions | null {
  const rootHost = env.KANBAN_CARDS_CANDIDATE_ROOT_HOST?.trim() || "";
  const tenantHostsJson = env.KANBAN_CARDS_CANDIDATE_TENANT_HOSTS?.trim() || "";
  if (![rootHost, tenantHostsJson].some(Boolean)) return null;
  if (!rootHost || !tenantHostsJson) {
    throw new Error("KANBAN_CARDS_CANDIDATE_ROOT_HOST and KANBAN_CARDS_CANDIDATE_TENANT_HOSTS must be set together.");
  }
  let tenantHosts: Record<string, string>;
  try {
    const parsed = JSON.parse(tenantHostsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    tenantHosts = parsed as Record<string, string>;
  } catch {
    throw new Error("KANBAN_CARDS_CANDIDATE_TENANT_HOSTS must be a JSON object mapping Workspace slugs to exact hosts.");
  }
  return { rootHost, tenantHosts };
}

function createCandidateHostFamily(input: CandidateHostFamilyOptions, passkeyConfigured: boolean): HostFamily {
  if (!passkeyConfigured) throw new Error("A candidate host family requires passkey authentication.");
  const candidateRootHost = canonicalConfiguredHost(input.rootHost);
  if (isIP(new URL(`http://${candidateRootHost}`).hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("A passkey candidate root must use a DNS hostname.");
  }
  const candidateRootOrigin = originForHost(candidateRootHost);
  const tenantHosts = new Map<string, string>();
  const tenantSlugs = new Set<string>();
  for (const [rawSlug, rawHost] of Object.entries(input.tenantHosts || {})) {
    const slug = workspaceSlug(rawSlug);
    const host = canonicalConfiguredHost(rawHost);
    if (host === candidateRootHost || tenantHosts.has(host) || tenantSlugs.has(slug)) {
      throw new Error("Candidate tenant hosts and normalized Workspace slugs must be unique and must differ from the candidate root host.");
    }
    tenantHosts.set(host, slug);
    tenantSlugs.add(slug);
  }
  if (tenantHosts.size !== 1) throw new Error("KANBAN_CARDS_CANDIDATE_TENANT_HOSTS must contain exactly one Workspace route.");
  return {
    rootHost: candidateRootHost,
    rootOrigin: candidateRootOrigin,
    deriveTenantHosts: false,
    tenantHosts
  };
}

function isStrictSubdomainHost(host: string, rootHost: string): boolean {
  const parsedHost = new URL(`http://${host}`);
  const parsedRoot = new URL(`http://${rootHost}`);
  return parsedHost.port === parsedRoot.port
    && parsedHost.hostname.endsWith(`.${parsedRoot.hostname}`);
}

function authHostSurfaceAllows(req: Request): boolean {
  if (req.path.startsWith("/api/passkeys/")) return true;
  if (req.path.startsWith("/api/native-auth/")) return true;
  if ((req.method === "GET" || req.method === "HEAD") && req.path === "/.well-known/apple-app-site-association") return true;
  return (req.method === "GET" || req.method === "HEAD") && new Set(["/sign-in", "/sign-up", "/app.js", "/judgmentkit.css", "/styles.css", "/robots.txt", ...BRAND_PUBLIC_ASSETS.map(([route]) => route), ...PUBLIC_WEBSITE_ASSETS.map(([route]) => route), "/api/session"]).has(req.path);
}

function validateHostFamilies(families: readonly HostFamily[]): void {
  const hosts = new Set<string>();
  for (const family of families) {
    for (const host of [family.rootHost, ...family.tenantHosts.keys()]) {
      if (hosts.has(host)) throw new Error("Configured root and tenant hosts must be unique across host families.");
      if (families.some((other) => other !== family && other.deriveTenantHosts && isDerivedTenantHost(host, other.rootHost))) {
        throw new Error("Configured host families must not overlap a derived tenant host.");
      }
      hosts.add(host);
    }
  }
}

function requestHost(req: Request, trustForwardedHost: boolean): string {
  const raw = trustForwardedHost ? req.get("x-forwarded-host") || req.get("host") : req.get("host");
  const value = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.includes(",") || /[\s/@?#\\]/.test(value)) return "";
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.host.toLowerCase();
  } catch {
    return "";
  }
}

function requestProtocol(req: Request, trustForwardedHost: boolean): "http" | "https" {
  const forwarded = trustForwardedHost ? req.get("x-forwarded-proto") : undefined;
  if (forwarded === "https") return "https";
  return req.protocol === "https" ? "https" : "http";
}

function requireRootRequest(req: Request, families: readonly HostFamily[], trustForwardedHost: boolean): HostFamily {
  const host = requestHost(req, trustForwardedHost);
  const family = families.find((candidate) => candidate.rootHost === host);
  if (!family) throw httpError(404, "Workspace unavailable.");
  return family;
}

function requireKnownHost(req: Request, families: readonly HostFamily[], trustForwardedHost: boolean): ResolvedHostContext {
  const host = requestHost(req, trustForwardedHost);
  const family = families.find((candidate) => candidate.rootHost === host || candidate.tenantHosts.has(host) || candidate.deriveTenantHosts && isDerivedTenantHost(host, candidate.rootHost));
  if (!family) throw httpError(404, "Workspace unavailable.");
  if (family.rootHost === host) return { kind: "root", family, workspace: null };
  return { kind: "workspace", family, workspace: null };
}

async function resolveKnownHost(host: string, families: readonly HostFamily[], accessStore: AccessStore): Promise<ResolvedHostContext | null> {
  for (const family of families) {
    if (host === family.rootHost) return { kind: "root", family, workspace: null };
    const explicitSlug = family.tenantHosts.get(host);
    const slug = explicitSlug || (family.deriveTenantHosts ? derivedTenantSlug(host, family.rootHost) : null);
    if (!slug) continue;
    try {
      return { kind: "workspace", family, workspace: await accessStore.getWorkspaceBySlug(slug) };
    } catch {
      throw httpError(503, "Workspace registry is unavailable.");
    }
  }
  return null;
}

function isDerivedTenantHost(host: string, rootHost: string): boolean {
  return Boolean(derivedTenantSlug(host, rootHost));
}

function derivedTenantSlug(host: string, rootHost: string): string | null {
  if (!host || host === rootHost) return null;
  const parsedHost = new URL(`http://${host}`);
  const parsedRoot = new URL(`http://${rootHost}`);
  if (parsedHost.port !== parsedRoot.port) return null;
  const suffix = `.${parsedRoot.hostname}`;
  if (!parsedHost.hostname.endsWith(suffix)) return null;
  const slug = parsedHost.hostname.slice(0, -suffix.length);
  if (!slug || slug.includes(".") || RESERVED_WORKSPACE_SLUGS.has(slug)) return null;
  return slug;
}

function workspaceHost(slug: string, family: HostFamily): string {
  if (!family.deriveTenantHosts) {
    const exact = [...family.tenantHosts].find(([, mappedSlug]) => mappedSlug === slug)?.[0];
    if (!exact) throw httpError(503, "This Workspace does not have an approved route in the current host family.");
    return exact;
  }
  const parsed = new URL(`http://${family.rootHost}`);
  return `${slug}.${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

function supportsWorkspace(family: HostFamily, slug: string): boolean {
  return family.deriveTenantHosts || [...family.tenantHosts.values()].includes(slug);
}

function publicAccessWorkspace(workspace: AccessWorkspace, family: HostFamily): UnknownRecord {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    url: originForHost(workspaceHost(workspace.slug, family)),
    ...(workspace.initialProjectId ? { initialProjectId: workspace.initialProjectId } : {})
  };
}

function rootLogoutUrl(family: HostFamily): string {
  return `${family.rootOrigin}/auth/logout`;
}

function publicProtocol(rootHost: string): "http" | "https" {
  return isLoopbackHost(new URL(`http://${rootHost}`).hostname) ? "http" : "https";
}

function originForHost(host: string): string {
  return `${publicProtocol(host)}://${host}`;
}

function workspaceSlug(value: unknown): string {
  const slug = requiredString(value, "Workspace slug").toLowerCase();
  if (RESERVED_WORKSPACE_SLUGS.has(slug) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw httpError(400, "Workspace slug must use lowercase letters, numbers, and hyphens.");
  }
  return slug;
}

function workspaceName(value: unknown): string {
  const name = requiredString(value, "Workspace name");
  if (name.length > 120 || /[\r\n\0]/.test(name)) {
    throw httpError(400, "Workspace name must be 120 characters or fewer and stay on one line.");
  }
  return name;
}

function rejectWorkspaceSelectors(req: Request, includeBody: boolean): void {
  const selectorPattern = /^(workspace(?:id|slug)?|tenant(?:id|slug)?)$/i;
  if (Object.keys(req.query).some((key) => selectorPattern.test(key)) || req.get("x-kanban-workspace")) {
    throw httpError(400, "Workspace context cannot be supplied by the client.");
  }
  if (includeBody && Object.keys(asRecord(req.body)).some((key) => selectorPattern.test(key))) {
    throw httpError(400, "Workspace context cannot be supplied by the client.");
  }
}

function idempotentMutation(
  req: Request,
  state: WorkspaceState,
  mutate: () => { statusCode: number; response: JsonValue }
): MutationResult {
  const key = optionalString(req.get("idempotency-key"));
  const requestPath = req.originalUrl.split("?", 1)[0];
  const requestHash = crypto.createHash("sha256").update(stableJson(req.body ?? {})).digest("hex");
  if (key) {
    const existing = state.idempotencyRecords.find((record) => record.method === "POST" && record.path === requestPath && record.key === key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw httpError(409, "Idempotency key was already used with a different request.");
      return { statusCode: existing.statusCode, response: existing.response, replayed: true };
    }
  }

  const result = mutate();
  if (key) {
    const record: IdempotencyRecord = {
      key,
      method: "POST",
      path: requestPath,
      requestHash,
      statusCode: result.statusCode,
      response: result.response,
      createdAt: new Date().toISOString()
    };
    state.idempotencyRecords.push(record);
    if (state.idempotencyRecords.length > MAX_IDEMPOTENCY_RECORDS) {
      state.idempotencyRecords.splice(0, state.idempotencyRecords.length - MAX_IDEMPOTENCY_RECORDS);
    }
  }
  return { ...result, replayed: false };
}

function sendMutation(res: Response, outcome: MutationResult): void {
  if (outcome.replayed) res.setHeader("Idempotency-Replayed", "true");
  res.status(outcome.statusCode).json(outcome.response);
}

function addActivity(project: Project, actor: ActivityActor, action: string, summary: string, cardId?: string): Activity {
  const activity: Activity = {
    id: makeId("activity"),
    action,
    actor: { ...actor },
    summary,
    projectId: project.id,
    ...(cardId ? { cardId } : {}),
    createdAt: new Date().toISOString()
  };
  project.activity.push(activity);
  if (project.activity.length > MAX_ACTIVITY) project.activity.splice(0, project.activity.length - MAX_ACTIVITY);
  return activity;
}

function normalizeColumns(value: unknown, existing: Column[] | undefined): Column[] {
  const source = value === undefined
    ? DEFAULT_COLUMNS.map((name, position) => ({ id: slugId(name, position), name, position }))
    : requireArray(value, "Project columns").map((candidate, position) => {
        const input = typeof candidate === "string" ? { name: candidate } : asRecord(candidate);
        const name = requiredString(input.name, `Column ${position + 1} name`);
        return {
          id: optionalString(input.id) || existing?.[position]?.id || slugId(name, position),
          name,
          position: optionalPosition(input.position, position)
        };
      });
  if (!source.length) throw httpError(400, "A project requires at least one column.");
  const ids = source.map((column) => column.id);
  if (new Set(ids).size !== ids.length) throw httpError(400, "Column IDs must be unique.");
  return source.sort((left, right) => left.position - right.position);
}

function projectSummary(project: Project): UnknownRecord {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    revision: project.revision,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    cardCount: project.cards.filter((card) => !card.archivedAt).length
  };
}

function findProject(state: WorkspaceState, projectId: string): Project {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw httpError(404, "Project not found.");
  return project;
}

function findCard(project: Project, cardId: string): Card {
  const card = project.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw httpError(404, "Card not found.");
  return card;
}

function assertProjectWritable(project: Project): void {
  if (project.archivedAt) throw httpError(409, "Archived projects are read-only.");
}

function touchProject(project: Project): void {
  project.revision += 1;
  project.updatedAt = new Date().toISOString();
}

function touchCard(card: Card): void {
  card.version += 1;
  card.updatedAt = new Date().toISOString();
}

function nextCardPosition(project: Project, columnId: string, exceptCardId?: string): number {
  const positions = project.cards
    .filter((card) => card.id !== exceptCardId && card.columnId === columnId && !card.archivedAt)
    .map((card) => card.position);
  return positions.length ? Math.max(...positions) + 1 : 0;
}

function requiredMatch(req: Request, label: string): number {
  if (req.headers["if-match"] !== undefined) {
    throw httpError(400, "If-Match is not supported for writes. Use X-Kanban-Version.");
  }
  const value = req.get("x-kanban-version");
  if (!value) throw httpError(428, `${label} is required in X-Kanban-Version.`);
  const normalized = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result < 1) throw httpError(400, `Invalid ${label.toLowerCase()}.`);
  return result;
}

function assertVersion(actual: number, expected: number, resource: string): void {
  if (actual !== expected) throw httpError(409, `${resource} changed since it was read. Refresh and reconcile before retrying.`);
}

function quoteVersion(value: number): string {
  return `"${value}"`;
}

function createSessionValue(expiresAt: number, secret: string): string {
  const payload = `v1.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionValue(value: string, secret: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1_000)) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return safeEqual(parts[2], sign(payload, secret));
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

// Optional browser intent fence. The header never establishes authority; the
// authenticated owner resolved from this very request remains the only authority.
function assertExpectedOwner(req: Request, verifiedOwnerId: string | null): void {
  const expected = req.get("X-Kanban-Expected-Owner");
  if (expected !== undefined && (!verifiedOwnerId || expected !== verifiedOwnerId)) throw httpError(401, "The signed-in owner changed. Sign in again before retrying this action.");
}

function assertRequestOrigin(req: Request, requireOrigin: boolean, trustForwardedHost = false): void {
  const origin = req.get("origin");
  if (!origin) {
    if (requireOrigin) throw httpError(403, "A same-origin browser request is required.");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw httpError(403, "Invalid request origin.");
  }
  const expectedHost = requestHost(req, trustForwardedHost);
  const expectedProtocol = requestProtocol(req, trustForwardedHost);
  if (parsed.host !== expectedHost || parsed.protocol !== `${expectedProtocol}:`) throw httpError(403, "Cross-origin request rejected.");
}

function assertExactOrigin(req: Request, expectedOrigin: string): void {
  const origin = req.get("origin");
  if (!origin) throw httpError(403, "A trusted root-origin handoff is required.");
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(origin);
    expected = new URL(expectedOrigin);
  } catch {
    throw httpError(403, "Invalid request origin.");
  }
  if (actual.origin !== expected.origin) throw httpError(403, "Cross-origin request rejected.");
}

function requireActor(req: Request): ActivityActor {
  if (!req.ownerAuth) throw httpError(401, "Authentication required.");
  return req.ownerAuth.actor;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `Missing route parameter ${name}.`);
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (!text) throw httpError(400, `${label} is required.`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function cardBodyText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).replace(/\r\n?/g, "\n");
}

function nullableEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | null {
  if (value == null) return null;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw httpError(400, `${label} must be ${values.join(", ")}, or null.`);
  }
  return value as T;
}

function cardMetadataText(value: unknown, label: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw httpError(400, `${label} must be a string or null.`);
  return value.trim();
}

function queryEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw httpError(400, `${label} must be one of ${values.join(", ")} and supplied once.`);
  }
  return value as T;
}

function cleanLabel(value: unknown, fallback: string): string {
  const text = optionalString(value)?.replace(/[\r\n\0]/g, " ").slice(0, 80);
  return text || fallback;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === "") return null;
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw httpError(400, `${label} must be an ISO timestamp or null.`);
  return new Date(text).toISOString();
}

function optionalPosition(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw httpError(400, "Position must be a non-negative integer.");
  return result;
}

function positiveInteger(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw httpError(400, `Value must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array.`);
  return value;
}

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as UnknownRecord;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function slugId(name: string, position: number): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `column-${position + 1}`;
}

function isLoopbackHost(host: string): boolean {
  const raw = host.trim().toLowerCase();
  const candidate = raw === "::1" ? raw : raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":", 1)[0];
  const normalized = candidate.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1" || normalized.startsWith("127.");
}

function formatAction(action: string): string {
  if (action === "card.moved") return "Moved";
  if (action === "card.archived") return "Archived";
  return "Updated";
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as UnknownRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

function serveIndex(staticDir: string, titleForRequest: (req: Request) => string): RequestHandler {
  return asyncHandler(async (req, res) => {
    const title = titleForRequest(req);
    noStore(res);
    let html: string;
    try {
      html = await fs.readFile(path.join(staticDir, "index.html"), "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      html = FALLBACK_INDEX_HTML;
    }
    res.type("html").send(html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`));
  });
}

function sendStaticFile(staticDir: string, relativePath: string, contentType: string, styleHash?: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      const content = await fs.readFile(path.join(staticDir, relativePath));
      if (styleHash) {
        const policy = String(res.getHeader("Content-Security-Policy") || "");
        res.setHeader("Content-Security-Policy", policy.replace("style-src 'self'", `style-src 'self' '${styleHash}'`));
      }
      res.type(contentType).send(content);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      throw httpError(404, "Static asset not found.");
    }
  });
}

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorHandler(): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    const status = isHttpError(error) ? error.status || 500 : 500;
    const message = error instanceof Error && status < 500 ? error.message : "Internal server error.";
    if (status >= 500) console.error(error instanceof Error ? error.message : String(error));
    noStore(res);
    res.status(status).json({ error: message });
  };
}

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && typeof (error as HttpError).status === "number";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

if (require.main === module) {
  const host = process.env.HOST || DEFAULT_HOST;
  const port = positiveInteger(process.env.PORT, DEFAULT_PORT);
  const server = createServer(createApp());
  server.once("error", (error) => {
    console.error(`Unable to start ${PRODUCT_NAME}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`${PRODUCT_NAME} server listening at http://${host}:${port}`);
  });
}

const defaultApp = createApp();
export default defaultApp;
