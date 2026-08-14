import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { AccessStoreError, createAccessStore, type AccessStore, type AccessWorkspace } from "./access-store";
import {
  clearLogoutCompletionCookie,
  clearRootSessionCookie,
  clearTenantSessionCookie,
  clearLogoutRetryCookie,
  createLogoutCompletionCookie,
  createLogoutContinuationToken,
  createLogoutRetryCookie,
  createRootSessionCookie,
  createTenantSessionCookie,
  isProductionRequest,
  verifyRootSession,
  verifyLogoutCompletionSession,
  verifyLogoutContinuationToken,
  verifyLogoutRetrySession,
  verifyTenantSession,
  type LogoutRetrySession,
  type RootSession
} from "./app-sessions";
import {
  ClerkIdentityError,
  clerkAuthOrigin,
  clerkAuthSignInUrl,
  clerkAuthSignUpUrl,
  clerkFrontendApiOrigin,
  clerkAuthConfigurationRequested,
  createClerkAuthGateway,
  getClerkAuthConfig,
  validateClerkAuthConfig,
  type ClerkAuthConfig,
  type ClerkAuthGateway
} from "./clerk-auth";
import { createStateStore, createWorkspaceStoreResolver, DEFAULT_WORKSPACE_ID } from "./state-store";
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

type AuthMethod = "bearer" | "cookie";

interface OwnerAuth {
  method: AuthMethod;
  actor: ActivityActor;
  workspace: AccessWorkspace | null;
  store: StateStore;
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
  clerkAuthConfig?: ClerkAuthConfig | null;
  clerkAuthGateway?: ClerkAuthGateway;
  rootHost?: string;
  candidateHostFamily?: CandidateHostFamilyOptions | null;
  legacyApiWorkspaceId?: string;
  legacyWorkspaceSlug?: string;
  legacyWorkspaceName?: string;
  legacyClerkUserId?: string;
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
  legacyApiWorkspaceId: string;
  legacyStore: StateStore;
  ownerLabel: string;
  clerkAuthConfig: ClerkAuthConfig | null;
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
const RESERVED_WORKSPACE_SLUGS = new Set(["api", "app", "auth", "admin", "clerk", "www"]);
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_ACTIVITY = 1_000;
const MAX_IDEMPOTENCY_RECORDS = 1_000;
const DEFAULT_COLUMNS = ["Next", "Doing", "Done"];
const FALLBACK_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>kanban.cards</title>
  <link rel="stylesheet" href="judgmentkit.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app"><main class="centered-view"><strong>kanban.cards</strong><p>Opening your projects…</p></main></div>
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
  const clerkAuthConfig = options.clerkAuthConfig === null
    ? null
    : options.clerkAuthConfig || (clerkAuthConfigurationRequested() ? getClerkAuthConfig() : null);
  const clerkAuthConfigured = Boolean(clerkAuthConfig);
  if (clerkAuthConfig) validateClerkAuthConfig(clerkAuthConfig);
  const rootHost = canonicalConfiguredHost(
    options.rootHost ||
    process.env.KANBAN_CARDS_ROOT_HOST ||
    (production ? PRODUCT_NAME : configuredHost)
  );
  const rootOrigin = originForHost(rootHost);
  const rootHostname = new URL(`http://${rootHost}`).hostname.replace(/^\[|\]$/g, "");
  if (clerkAuthConfig && isIP(rootHostname)) {
    throw new Error("Clerk Workspace mode requires a DNS root host such as localhost or kanban.cards; numeric-IP tenant hosts are unsupported.");
  }
  const primaryHostFamily: HostFamily = {
    rootHost,
    rootOrigin,
    deriveTenantHosts: true,
    tenantHosts: new Map()
  };
  const candidateHostFamilyInput = options.candidateHostFamily === null
    ? null
    : options.candidateHostFamily || candidateHostFamilyFromEnv();
  const candidateHostFamily = candidateHostFamilyInput
    ? createCandidateHostFamily(candidateHostFamilyInput, Boolean(clerkAuthConfig))
    : null;
  const hostFamilies = candidateHostFamily ? [primaryHostFamily, candidateHostFamily] : [primaryHostFamily];
  validateHostFamilies(hostFamilies);
  const authHost = clerkAuthConfig?.authHost || "";
  const authOrigin = clerkAuthConfig ? clerkAuthOrigin(clerkAuthConfig) : "";
  const clerkFrontendApi = clerkAuthConfig ? clerkFrontendApiOrigin(clerkAuthConfig) : "";
  if (clerkAuthConfig) {
    validateSameRootClerkTopology(authHost, primaryHostFamily, candidateHostFamily);
    validateClerkFrontendApiHostIsolation(clerkFrontendApi, authHost, hostFamilies);
    validateProductionClerkFrontendApi(clerkFrontendApi, primaryHostFamily);
  }
  const clerkRootDomains = clerkAuthConfig ? [
    { origin: authOrigin, role: "auth" as const },
    ...hostFamilies.map((family) => ({ origin: family.rootOrigin, role: "app" as const }))
  ] : [];
  const clerkAuthGateway = clerkAuthConfig
    ? options.clerkAuthGateway || createClerkAuthGateway(clerkAuthConfig)
    : null;
  const legacyApiWorkspaceId = String(options.legacyApiWorkspaceId ?? process.env.KANBAN_CARDS_API_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID).trim();
  if (legacyApiWorkspaceId !== DEFAULT_WORKSPACE_ID) {
    throw new Error(`KANBAN_CARDS_API_WORKSPACE_ID must remain ${DEFAULT_WORKSPACE_ID} during the compatibility bridge.`);
  }
  const legacyClerkUserId = String(options.legacyClerkUserId ?? process.env.KANBAN_CARDS_LEGACY_CLERK_USER_ID ?? "").trim();
  const legacyWorkspaceSlug = String(options.legacyWorkspaceSlug ?? process.env.KANBAN_CARDS_LEGACY_WORKSPACE_SLUG ?? "").trim().toLowerCase();
  const legacyWorkspaceName = String(options.legacyWorkspaceName ?? process.env.KANBAN_CARDS_LEGACY_WORKSPACE_NAME ?? "").trim();
  if (legacyWorkspaceSlug) {
    try {
      workspaceSlug(legacyWorkspaceSlug);
    } catch {
      throw new Error("KANBAN_CARDS_LEGACY_WORKSPACE_SLUG must be a valid, non-reserved Workspace hostname label.");
    }
  }
  if (candidateHostFamily) {
    const candidateSlugs = [...candidateHostFamily.tenantHosts.values()];
    if (!legacyWorkspaceSlug || candidateSlugs.length !== 1 || candidateSlugs[0] !== legacyWorkspaceSlug) {
      throw new Error("KANBAN_CARDS_CANDIDATE_TENANT_HOSTS must contain exactly the configured legacy Workspace slug and one exact candidate host.");
    }
  }
  const sessionTtlSeconds = positiveInteger(
    options.sessionTtlSeconds ?? process.env.KANBAN_CARDS_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS
  );
  const legacyMigrationValues = [legacyClerkUserId, legacyWorkspaceSlug, legacyWorkspaceName];
  const missingConfiguration = [
    ...(!clerkAuthConfigured && !apiToken ? ["KANBAN_CARDS_API_TOKEN"] : []),
    ...(production && !clerkAuthConfigured ? ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CLERK_ENCRYPTION_KEY, SESSION_SECRET, KANBAN_CARDS_AUTH_HOST, and KANBAN_CARDS_ALLOWED_CLERK_USER_IDS"] : []),
    ...(legacyMigrationValues.some(Boolean) && !legacyMigrationValues.every(Boolean)
      ? ["KANBAN_CARDS_LEGACY_CLERK_USER_ID, KANBAN_CARDS_LEGACY_WORKSPACE_SLUG, and KANBAN_CARDS_LEGACY_WORKSPACE_NAME must be set together"]
      : []),
    ...(legacyClerkUserId && clerkAuthConfig && !clerkAuthConfig.allowedUserIds.includes(legacyClerkUserId)
      ? ["KANBAN_CARDS_ALLOWED_CLERK_USER_IDS must include KANBAN_CARDS_LEGACY_CLERK_USER_ID"]
      : []),
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
    ? fixedWorkspaceStoreResolver(options.store, legacyApiWorkspaceId)
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
  const legacyMigrationConfigured = legacyMigrationValues.every(Boolean);

  async function requireExistingLegacyState(): Promise<WorkspaceState> {
    try {
      const existing = await defaultWorkspaceStore.readExisting();
      if (!existing) throw httpError(503, "Legacy Workspace state is unavailable.");
      return existing;
    } catch (error) {
      if (isHttpError(error)) throw error;
      throw httpError(503, "Legacy Workspace state is unavailable.");
    }
  }

  async function inspectAccessReadiness(): Promise<{
    ready: boolean;
    registry: "ready" | "unavailable" | "not-required";
    legacyState: "ready" | "missing" | "invalid" | "not-required";
    legacyBinding: "ready" | "pending" | "mismatch" | "not-required";
  }> {
    if (!clerkAuthConfig) {
      return {
        ready: missingConfiguration.length === 0,
        registry: "not-required",
        legacyState: "not-required",
        legacyBinding: "not-required"
      };
    }

    let registryState;
    try {
      registryState = await accessStore.read();
    } catch {
      return {
        ready: false,
        registry: "unavailable",
        legacyState: "not-required",
        legacyBinding: "not-required"
      };
    }

    const legacyWorkspace = registryState.workspaces.find((workspace) => workspace.storageId === DEFAULT_WORKSPACE_ID) || null;
    const legacyAccessRequired = Boolean(apiToken || legacyMigrationConfigured || legacyWorkspace);
    if (!legacyAccessRequired) {
      return {
        ready: missingConfiguration.length === 0,
        registry: "ready",
        legacyState: "not-required",
        legacyBinding: "not-required"
      };
    }

    let legacyState: "ready" | "missing" | "invalid" = "ready";
    try {
      if (!await defaultWorkspaceStore.readExisting()) legacyState = "missing";
    } catch {
      legacyState = "invalid";
    }

    let legacyBinding: "ready" | "pending" | "mismatch";
    if (!legacyWorkspace) {
      legacyBinding = "pending";
    } else if (legacyMigrationConfigured) {
      const owner = registryState.owners.find((candidate) => candidate.providerSubject === legacyClerkUserId);
      legacyBinding = owner &&
        legacyWorkspace.slug === legacyWorkspaceSlug &&
        legacyWorkspace.name === legacyWorkspaceName &&
        legacyWorkspace.ownerIds.includes(owner.id)
        ? "ready"
        : "mismatch";
    } else {
      legacyBinding = "ready";
    }

    return {
      ready: missingConfiguration.length === 0 && legacyState === "ready" && legacyBinding === "ready",
      registry: "ready",
      legacyState,
      legacyBinding
    };
  }

  let legacyBindingPromise: Promise<AccessWorkspace | null> | null = null;
  function ensureLegacyBinding(identity?: RootSession): Promise<AccessWorkspace | null> {
    if (!legacyClerkUserId && !legacyWorkspaceSlug && !legacyWorkspaceName) return Promise.resolve(null);
    if (!legacyClerkUserId || !legacyWorkspaceSlug || !legacyWorkspaceName) {
      return Promise.reject(httpError(503, "Legacy Workspace migration requires a Clerk user ID, Workspace slug, and Workspace name together."));
    }
    if (!identity || identity.providerSubject !== legacyClerkUserId) {
      return Promise.resolve(null);
    }
    if (!legacyBindingPromise) {
      legacyBindingPromise = requireExistingLegacyState().then(() => accessStore.bindLegacyWorkspace({
          providerSubject: legacyClerkUserId,
          email: identity.email,
          displayName: identity.displayName,
          slug: legacyWorkspaceSlug,
          name: legacyWorkspaceName
        })).catch((error) => {
        legacyBindingPromise = null;
        throw error;
      });
    }
    return legacyBindingPromise;
  }

  app.disable("x-powered-by");
  if (clerkAuthGateway) {
    app.use(clerkAuthGateway.middleware(
      clerkRootDomains,
      trustForwardedHost
    ));
  }
  app.use(securityHeaders(clerkFrontendApi));
  app.use(express.urlencoded({ extended: false, limit: "16kb", type: "application/x-www-form-urlencoded" }));
  app.use(express.json({ limit: "256kb", type: "application/json" }));
  if (clerkAuthConfig) {
    app.use((req, res, next) => {
      if (requestHost(req, trustForwardedHost) !== authHost) {
        next();
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && (req.path === "/" || req.path === "/index.html")) {
        res.redirect(302, "/sign-in");
        return;
      }
      if (authHostSurfaceAllows(req)) {
        next();
        return;
      }
      res.status(404).type("text/plain").send("Not found");
    });
  }

  app.get("/api/health", asyncHandler(async (_req, res) => {
    const access = await inspectAccessReadiness();
    res.status(access.ready ? 200 : 503).json({
      ok: access.ready,
      product: PRODUCT_NAME,
      schemaVersion: 2,
      store: legacyStore.kind,
      authentication: clerkAuthConfigured ? "clerk-session+workspace" : "local-owner-key",
      access,
      missingConfiguration
    });
  }));

  app.get("/api/access/health", asyncHandler(async (_req, res) => {
    const access = await inspectAccessReadiness();
    res.status(access.ready ? 200 : 503).json({
      ok: access.ready,
      authentication: clerkAuthConfigured ? "clerk-session+workspace" : "local-owner-key",
      registry: accessStore.kind,
      legacyBridge: apiToken ? "enabled" : "disabled",
      registryState: access.registry,
      legacyState: access.legacyState,
      legacyBinding: { present: access.legacyBinding === "ready", status: access.legacyBinding },
      missingConfiguration
    });
  }));

  app.post("/api/clerk-session", asyncHandler(async (req, res) => {
    noStore(res);
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertExactOrigin(req, family.rootOrigin);
    if (!clerkAuthConfig || !clerkAuthGateway) throw httpError(503, "Clerk sign-in is not configured.");
    const appRequest = webRequest(req, trustForwardedHost);
    const productionRequest = isProductionRequest(appRequest);
    if (await verifyLogoutRetrySession(appRequest, clerkAuthConfig.sessionSecret, productionRequest)) {
      throw httpError(409, "Sign-out must complete before creating a new browser session.");
    }
    const requestAuth = clerkAuthGateway.requestAuth(req);
    if (!requestAuth.authenticated || !requestAuth.clerkUserId || !requestAuth.clerkSessionId) {
      throw httpError(401, "Clerk sign-in required.");
    }
    if (!clerkAuthConfig.allowedUserIds.includes(requestAuth.clerkUserId)) {
      throw httpError(403, "This Clerk account does not have access to the private release.");
    }
    let identity;
    try {
      identity = await clerkAuthGateway.verifiedIdentity(requestAuth.clerkUserId, requestAuth.clerkSessionId);
    } catch (error) {
      if (error instanceof ClerkIdentityError) throw httpError(403, error.message);
      throw httpError(503, "Clerk identity verification is unavailable.");
    }
    const rootSession: RootSession = {
      providerSubject: identity.clerkUserId,
      email: identity.email,
      displayName: identity.displayName,
      sessionId: identity.clerkSessionId,
      rootOrigin: family.rootOrigin
    };
    await ensureLegacyBinding(rootSession);
    const cookie = await createRootSessionCookie(
      rootSession,
      clerkAuthConfig.sessionSecret,
      productionRequest,
      clerkAuthConfig.rootSessionTtlSeconds
    );
    res.append("Set-Cookie", clearLogoutCompletionCookie(productionRequest));
    res.append("Set-Cookie", cookie);
    res.status(201).json({ authenticated: true });
  }));

  app.post("/auth/logout", asyncHandler(async (req, res) => {
    noStore(res);
    if (req.originalUrl !== "/auth/logout") throw httpError(404, "API route not found.");
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    if (!clerkAuthConfig || !clerkAuthGateway) throw httpError(404, "API route not found.");
    await assertLogoutCompletionOrigin(req, family, accessStore);
    const continuationToken = requiredString(asRecord(req.body).continuation, "Logout continuation");
    const continuation = await verifyLogoutContinuationToken(continuationToken, clerkAuthConfig.sessionSecret);
    if (
      !continuation
      || continuation.rootOrigin !== family.rootOrigin
      || continuation.initiatingOrigin !== req.get("origin")
    ) {
      throw httpError(403, "Logout continuation is invalid or expired.");
    }
    const appRequest = webRequest(req, trustForwardedHost);
    const productionRequest = isProductionRequest(appRequest);
    const currentRootSession = await verifyRootSession(
      appRequest,
      clerkAuthConfig.sessionSecret,
      productionRequest
    );
    const [continuationRevoked, currentRootRevoked] = await Promise.all([
      accessStore.isSessionRevoked(continuation.providerSubject, continuation.sessionId),
      currentRootSession
        ? accessStore.isSessionRevoked(currentRootSession.providerSubject, currentRootSession.sessionId)
        : Promise.resolve(true)
    ]);
    if (!continuationRevoked || !currentRootRevoked) {
      throw httpError(409, "Logout continuation no longer matches the active browser state.");
    }
    res.append("Set-Cookie", clearRootSessionCookie(productionRequest));
    res.append("Set-Cookie", clearLogoutRetryCookie(productionRequest));
    res.append("Set-Cookie", await createLogoutCompletionCookie({
      completionId: continuation.completionId,
      providerSubject: continuation.providerSubject,
      sessionId: continuation.sessionId,
      rootOrigin: family.rootOrigin
    }, clerkAuthConfig.sessionSecret, productionRequest));
    res.redirect(303, "/?signout=clerk");
  }));

  app.get("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    if (clerkAuthConfig && requestHost(req, trustForwardedHost) === authHost) {
      res.json({
        authenticated: false,
        context: "auth",
        rootUrl: authOrigin,
        ...clerkBrowserRuntimeConfig({
          config: clerkAuthConfig,
          surfaceRole: "auth",
          allowedRedirectOrigins: hostFamilies.map((family) => family.rootOrigin),
          fallbackRedirectUrl: primaryHostFamily.rootOrigin
        })
      });
      return;
    }
    const requestContext = await resolveAccessContext(req, {
      accessStore,
      apiToken,
      legacyApiWorkspaceId,
      legacyStore,
      ownerLabel,
      clerkAuthConfig,
      hostFamilies,
      primaryHostFamily,
      trustForwardedHost,
      workspaceStoreResolver
    });
    const family = requestContext.hostFamily || primaryHostFamily;
    const appRequest = clerkAuthConfig && requestContext.kind !== "local"
      ? webRequest(req, trustForwardedHost)
      : null;
    const logoutRetryPending = clerkAuthConfig && appRequest
      ? Boolean(await verifyLogoutRetrySession(
          appRequest,
          clerkAuthConfig.sessionSecret,
          isProductionRequest(appRequest)
        ))
      : false;
    const logoutCompletionSession = clerkAuthConfig && appRequest && requestContext.kind === "root"
      ? await verifyLogoutCompletionSession(
          appRequest,
          clerkAuthConfig.sessionSecret,
          isProductionRequest(appRequest)
        )
      : null;
    if (!requestContext.auth) {
      res.json({
        authenticated: false,
        context: requestContext.kind,
        rootUrl: family.rootOrigin,
        ...(clerkAuthConfig ? { logoutUrl: rootLogoutUrl(family) } : {}),
        ...(clerkAuthConfig ? { logoutRetryPending } : {}),
        ...(clerkAuthConfig && requestContext.kind === "root" ? {
          logoutCompletion: Boolean(logoutCompletionSession),
          ...(logoutCompletionSession ? { logoutCompletionSessionId: logoutCompletionSession.sessionId } : {}),
          ...clerkBrowserRuntimeConfig({
            config: clerkAuthConfig,
            surfaceRole: "app",
            allowedRedirectOrigins: [],
            fallbackRedirectUrl: primaryHostFamily.rootOrigin
          })
        } : {})
      });
      return;
    }
    res.json({
      authenticated: true,
      context: requestContext.kind,
      rootUrl: family.rootOrigin,
      logoutUrl: rootLogoutUrl(family),
      ...(clerkAuthConfig ? { logoutRetryPending } : {}),
      ...(clerkAuthConfig && requestContext.kind === "root" ? {
        logoutCompletion: false,
        ...clerkBrowserRuntimeConfig({
          config: clerkAuthConfig,
          surfaceRole: "app",
          allowedRedirectOrigins: [],
          fallbackRedirectUrl: primaryHostFamily.rootOrigin
        })
      } : {}),
      label: requestContext.auth.actor.label,
      email: requestContext.identity?.email,
      ...(requestContext.workspace ? { workspace: publicAccessWorkspace(requestContext.workspace, family) } : {})
    });
  }));

  app.delete("/api/logout-completion", asyncHandler(async (req, res) => {
    noStore(res);
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    if (!clerkAuthConfig) throw httpError(404, "API route not found.");
    assertExactOrigin(req, family.rootOrigin);
    const appRequest = webRequest(req, trustForwardedHost);
    const productionRequest = isProductionRequest(appRequest);
    const [completion, rootSession] = await Promise.all([
      verifyLogoutCompletionSession(appRequest, clerkAuthConfig.sessionSecret, productionRequest),
      verifyRootSession(appRequest, clerkAuthConfig.sessionSecret, productionRequest)
    ]);
    if (!completion || completion.rootOrigin !== family.rootOrigin || rootSession) {
      throw httpError(401, "Logout completion required.");
    }
    res.append("Set-Cookie", clearLogoutCompletionCookie(productionRequest));
    res.json({ completed: true });
  }));

  app.post("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    assertRequestOrigin(req, false, trustForwardedHost);
    if (clerkAuthConfigured) throw httpError(404, "API route not found.");
    if (!apiToken) throw httpError(503, "Local owner authentication is not configured.");
    const suppliedToken = requiredString(asRecord(req.body).token, "Access key");
    if (!safeEqual(suppliedToken, apiToken)) throw httpError(401, "Invalid access key.");
    const expiresAt = Math.floor(Date.now() / 1_000) + sessionTtlSeconds;
    res.cookie(SESSION_COOKIE, createSessionValue(expiresAt, apiToken), {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
      maxAge: sessionTtlSeconds * 1_000
    });
    res.json({ authenticated: true, label: ownerLabel });
  }));

  app.delete("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    assertRequestOrigin(req, Boolean(clerkAuthConfig), trustForwardedHost);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    if (clerkAuthConfig) {
      const appRequest = webRequest(req, trustForwardedHost);
      const productionRequest = isProductionRequest(appRequest);
      const family = requireKnownHost(req, hostFamilies, trustForwardedHost).family;
      const [rootSession, tenantSession, retrySession] = await Promise.all([
        verifyRootSession(appRequest, clerkAuthConfig.sessionSecret, productionRequest),
        verifyTenantSession(appRequest, clerkAuthConfig.sessionSecret, productionRequest),
        verifyLogoutRetrySession(appRequest, clerkAuthConfig.sessionSecret, productionRequest)
      ]);
      res.append("Set-Cookie", clearRootSessionCookie(productionRequest));
      res.append("Set-Cookie", clearTenantSessionCookie(productionRequest));
      res.append("Set-Cookie", clearLogoutCompletionCookie(productionRequest));
      const session = tenantSession || rootSession || retrySession;
      if (!session || session.rootOrigin !== family.rootOrigin) {
        res.append("Set-Cookie", clearLogoutRetryCookie(productionRequest));
        throw httpError(401, "Authentication required.");
      }
      let logoutContinuation = "";
      try {
        await accessStore.revokeSession(session.providerSubject, session.sessionId);
        if (!clerkAuthGateway) throw new Error("Clerk sign-out is unavailable.");
        await clerkAuthGateway.revokeSession(session.sessionId);
        logoutContinuation = await createLogoutContinuationToken({
          completionId: crypto.randomUUID(),
          providerSubject: session.providerSubject,
          sessionId: session.sessionId,
          rootOrigin: family.rootOrigin,
          initiatingOrigin: requestOrigin(appRequest)
        }, clerkAuthConfig.sessionSecret);
      } catch {
        res.append("Set-Cookie", await createLogoutRetryCookie(
          logoutRetrySession(session, family.rootOrigin, requestOrigin(appRequest)),
          clerkAuthConfig.sessionSecret,
          productionRequest
        ));
        res.status(503).json({
          error: "Global sign-out could not be completed.",
          signedOutHere: true,
          globalSignOutComplete: false
        });
        return;
      }
      res.append("Set-Cookie", clearLogoutRetryCookie(productionRequest));
      res.json({
        signedOutHere: true,
        globalSignOutComplete: true,
        logoutUrl: rootLogoutUrl(family),
        logoutContinuation
      });
      return;
    }
    res.status(204).end();
  }));

  app.get("/api/workspaces", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    if (!clerkAuthConfig) throw httpError(404, "API route not found.");
    const identity = await verifiedRootIdentity(req, clerkAuthConfig, trustForwardedHost, accessStore);
    if (!identity) throw httpError(401, "Owner sign-in required.");
    const workspaces = await accessStore.listWorkspacesForOwner(identity.providerSubject);
    res.json({ workspaces: workspaces.filter((workspace) => supportsWorkspace(family, workspace.slug)).map((workspace) => publicAccessWorkspace(workspace, family)) });
  }));

  app.post("/api/workspaces", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertRequestOrigin(req, true, trustForwardedHost);
    if (!clerkAuthConfig) throw httpError(404, "API route not found.");
    const identity = await verifiedRootIdentity(req, clerkAuthConfig, trustForwardedHost, accessStore);
    if (!identity) throw httpError(401, "Owner sign-in required.");
    rejectWorkspaceSelectors(req, true);
    const body = asRecord(req.body);
    const slug = workspaceSlug(body.slug);
    workspaceHost(slug, family);
    if (legacyMigrationConfigured && slug === legacyWorkspaceSlug) {
      throw httpError(409, "Workspace address is reserved for the configured legacy migration.");
    }
    let workspace: AccessWorkspace;
    try {
      workspace = await accessStore.createWorkspace({
        providerSubject: identity.providerSubject,
        email: identity.email,
        displayName: identity.displayName,
        name: workspaceName(body.name),
        slug
      });
    } catch (error) {
      if (error instanceof AccessStoreError && error.code === "ACCESS_CONFLICT") {
        throw httpError(409, "Workspace address is already in use.");
      }
      throw error;
    }
    res.status(201).json({ workspace: publicAccessWorkspace(workspace, family) });
  }));

  app.post("/api/workspace-handoffs", asyncHandler(async (req, res) => {
    const family = requireRootRequest(req, hostFamilies, trustForwardedHost);
    assertRequestOrigin(req, true, trustForwardedHost);
    if (!clerkAuthConfig) throw httpError(404, "API route not found.");
    const identity = await verifiedRootIdentity(req, clerkAuthConfig, trustForwardedHost, accessStore);
    if (!identity) throw httpError(401, "Owner sign-in required.");
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
    if (!family || !clerkAuthConfig) throw httpError(404, "API route not found.");
    if (!workspace) throw httpError(404, "Workspace unavailable.");
    assertExactOrigin(req, family.rootOrigin);
    try {
      const consumed = await accessStore.consumeHandoff({ token: requiredString(asRecord(req.body).token, "Handoff token"), destinationHost: host });
      if (consumed.workspace.id !== workspace.id) throw httpError(401, "The sign-in handoff was not accepted.");
      const tenantSession = {
        providerSubject: consumed.owner.providerSubject,
        email: consumed.owner.email,
        displayName: consumed.owner.displayName,
        sessionId: consumed.sessionId,
        workspaceId: workspace.id,
        rootOrigin: family.rootOrigin,
        tenantOrigin: originForHost(host)
      };
      res.append("Set-Cookie", await createTenantSessionCookie(
        tenantSession,
        clerkAuthConfig.sessionSecret,
        isProductionRequest(webRequest(req, trustForwardedHost)),
        clerkAuthConfig.tenantSessionTtlSeconds
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

  app.get("/", serveIndex(staticDir));
  app.get("/index.html", serveIndex(staticDir));
  app.get("/sign-in", serveIndex(staticDir));
  app.get("/sign-up", serveIndex(staticDir));
  app.get("/app.js", sendStaticFile(staticDir, "public/app.js", "application/javascript; charset=utf-8"));
  app.get("/judgmentkit.css", sendStaticFile(staticDir, "public/judgmentkit.css", "text/css; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "public/styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", sendStaticFile(staticDir, "public/robots.txt", "text/plain; charset=utf-8"));
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  app.use("/api/projects", (req, _res, next) => {
    void (async () => {
      if (missingConfiguration.length) throw httpError(503, `Missing required configuration: ${missingConfiguration.join(", ")}.`);
      rejectWorkspaceSelectors(req, req.method !== "GET" && req.method !== "HEAD");
      const context = await resolveAccessContext(req, {
        accessStore,
        apiToken,
        legacyApiWorkspaceId,
        legacyStore,
        ownerLabel,
        clerkAuthConfig,
        hostFamilies,
        primaryHostFamily,
        trustForwardedHost,
        workspaceStoreResolver
      });
      const auth = context.auth;
      if (!auth || context.kind === "root") throw httpError(401, "Authentication required.");
      if (context.workspace?.storageId === DEFAULT_WORKSPACE_ID) await requireExistingLegacyState();
      req.ownerAuth = auth;
      if (req.method !== "GET" && req.method !== "HEAD" && auth.method === "cookie") assertRequestOrigin(req, true, trustForwardedHost);
      next();
    })().catch(next);
  });

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

function securityHeaders(clerkFrontendApi: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      clerkFrontendApi
        ? `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline' ${clerkFrontendApi} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${clerkFrontendApi} https://*.protect.clerk.com; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com`
        : "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'"
    );
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

  if (!config.clerkAuthConfig) {
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
    if (!config.apiToken || !safeEqual(bearer, config.apiToken)) {
      return {
        kind: hostContext.kind,
        auth: null,
        identity: null,
        workspace: tenantWorkspace,
        hostFamily
      };
    }
    const bearerWorkspace = hostContext.kind === "root"
      ? (await config.accessStore.read()).workspaces.find((workspace) => workspace.storageId === config.legacyApiWorkspaceId) || null
      : tenantWorkspace;
    if (bearerWorkspace?.storageId !== config.legacyApiWorkspaceId || !supportsWorkspace(hostFamily, bearerWorkspace.slug)) {
      return {
        kind: hostContext.kind,
        auth: null,
        identity: null,
        workspace: bearerWorkspace,
        hostFamily
      };
    }
    return {
      kind: "workspace",
      auth: {
        method: "bearer",
        actor: { channel: "api", label: cleanLabel(req.get("x-kanban-actor"), config.ownerLabel) },
        workspace: bearerWorkspace,
        store: config.workspaceStoreResolver.resolve(bearerWorkspace.storageId)
      },
      identity: null,
      workspace: bearerWorkspace,
      hostFamily
    };
  }

  if (hostContext.kind === "root") {
    const identity = await verifiedRootIdentity(req, config.clerkAuthConfig, config.trustForwardedHost, config.accessStore);
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
  const tenantSession = await verifyTenantSession(appRequest, config.clerkAuthConfig.sessionSecret, isProductionRequest(appRequest));
  if (!tenantSession || tenantSession.workspaceId !== tenantWorkspace.id) {
    return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
  }
  if (!config.clerkAuthConfig.allowedUserIds.includes(tenantSession.providerSubject)) {
    return { kind: "workspace", auth: null, identity: null, workspace: tenantWorkspace, hostFamily };
  }
  if (await config.accessStore.isSessionRevoked(tenantSession.providerSubject, tenantSession.sessionId)) {
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
      providerSubject: ownerAccess.owner.providerSubject,
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
  config: ClerkAuthConfig,
  trustForwardedHost: boolean,
  accessStore?: AccessStore
): Promise<RootSession | null> {
  const platformRequest = webRequest(req, trustForwardedHost);
  const identity = await verifyRootSession(platformRequest, config.sessionSecret, isProductionRequest(platformRequest));
  if (!identity) return null;
  if (!config.allowedUserIds.includes(identity.providerSubject)) return null;
  if (accessStore && await accessStore.isSessionRevoked(identity.providerSubject, identity.sessionId)) return null;
  return identity;
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

function logoutRetrySession(
  session: { providerSubject: string; sessionId: string; rootOrigin: string },
  rootOrigin: string,
  cookieOrigin: string
): LogoutRetrySession {
  if (session.rootOrigin !== rootOrigin) throw httpError(401, "Authentication required.");
  return {
    providerSubject: session.providerSubject,
    sessionId: session.sessionId,
    rootOrigin,
    cookieOrigin
  };
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

function createCandidateHostFamily(input: CandidateHostFamilyOptions, clerkConfigured: boolean): HostFamily {
  if (!clerkConfigured) throw new Error("A candidate host family requires Clerk authentication.");
  const candidateRootHost = canonicalConfiguredHost(input.rootHost);
  if (isIP(new URL(`http://${candidateRootHost}`).hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("A Clerk candidate root must use a DNS hostname.");
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
  if (tenantHosts.size !== 1) throw new Error("KANBAN_CARDS_CANDIDATE_TENANT_HOSTS must contain exactly one legacy Workspace route for this cutover.");
  return {
    rootHost: candidateRootHost,
    rootOrigin: candidateRootOrigin,
    deriveTenantHosts: false,
    tenantHosts
  };
}

function clerkBrowserRuntimeConfig(input: {
  config: ClerkAuthConfig;
  surfaceRole: "auth" | "app";
  allowedRedirectOrigins: readonly string[];
  fallbackRedirectUrl: string;
}): UnknownRecord {
  return {
    clerkPublishableKey: input.config.publishableKey,
    clerkFrontendApiOrigin: clerkFrontendApiOrigin(input.config),
    clerkSurfaceRole: input.surfaceRole,
    clerkAuthSignInUrl: clerkAuthSignInUrl(input.config),
    clerkAuthSignUpUrl: clerkAuthSignUpUrl(input.config),
    clerkAllowedRedirectOrigins: [...input.allowedRedirectOrigins],
    clerkFallbackRedirectUrl: input.fallbackRedirectUrl
  };
}

function validateSameRootClerkTopology(
  authHost: string,
  primaryFamily: HostFamily,
  candidateFamily: HostFamily | null
): void {
  if (!authHost) throw new Error("KANBAN_CARDS_AUTH_HOST is required for Clerk authentication.");
  if (!isStrictSubdomainHost(authHost, primaryFamily.rootHost)) {
    throw new Error("KANBAN_CARDS_AUTH_HOST must be a strict same-root subdomain of KANBAN_CARDS_ROOT_HOST with a matching port.");
  }
  const families = candidateFamily ? [primaryFamily, candidateFamily] : [primaryFamily];
  for (const family of families) {
    if (
      authHost === family.rootHost
      || family.tenantHosts.has(authHost)
      || family.deriveTenantHosts && isDerivedTenantHost(authHost, family.rootHost)
    ) {
      throw new Error("KANBAN_CARDS_AUTH_HOST must be distinct from every application root and tenant host.");
    }
  }
  if (!candidateFamily) return;
  if (!isStrictSubdomainHost(candidateFamily.rootHost, primaryFamily.rootHost)) {
    throw new Error("KANBAN_CARDS_CANDIDATE_ROOT_HOST must be nested beneath KANBAN_CARDS_ROOT_HOST with a matching port.");
  }
  for (const tenantHost of candidateFamily.tenantHosts.keys()) {
    if (!isStrictSubdomainHost(tenantHost, candidateFamily.rootHost)) {
      throw new Error("Every candidate tenant host must be nested beneath KANBAN_CARDS_CANDIDATE_ROOT_HOST with a matching port.");
    }
  }
}

function isStrictSubdomainHost(host: string, rootHost: string): boolean {
  const parsedHost = new URL(`http://${host}`);
  const parsedRoot = new URL(`http://${rootHost}`);
  return parsedHost.port === parsedRoot.port
    && parsedHost.hostname.endsWith(`.${parsedRoot.hostname}`);
}

function validateClerkFrontendApiHostIsolation(
  frontendApiOrigin: string,
  authHost: string,
  hostFamilies: readonly HostFamily[]
): void {
  const frontendApiHost = new URL(frontendApiOrigin).host;
  const applicationHosts = new Set([
    authHost,
    ...hostFamilies.flatMap((family) => [family.rootHost, ...family.tenantHosts.keys()])
  ]);
  if (applicationHosts.has(frontendApiHost)) {
    throw new Error("The Clerk Frontend API hostname must be distinct from every auth, application-root, and explicit tenant host.");
  }
}

function validateProductionClerkFrontendApi(frontendApiOrigin: string, primaryFamily: HostFamily): void {
  if (process.env.VERCEL_ENV?.trim().toLowerCase() !== "production") return;
  const rootHostname = new URL(`http://${primaryFamily.rootHost}`).hostname;
  const expectedOrigin = `https://clerk.${rootHostname}`;
  if (frontendApiOrigin !== expectedOrigin) {
    throw new Error(`Vercel production requires the Clerk Frontend API origin ${expectedOrigin} derived from the production publishable key.`);
  }
}

function authHostSurfaceAllows(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return new Set([
    "/sign-in",
    "/sign-up",
    "/app.js",
    "/judgmentkit.css",
    "/styles.css",
    "/robots.txt",
    "/favicon.ico",
    "/api/session"
  ]).has(req.path);
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
    url: originForHost(workspaceHost(workspace.slug, family))
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

async function assertLogoutCompletionOrigin(
  req: Request,
  family: HostFamily,
  accessStore: AccessStore
): Promise<void> {
  const origin = req.get("origin");
  if (!origin) throw httpError(403, "A trusted application origin is required.");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw httpError(403, "Invalid request origin.");
  }
  if (parsed.origin !== origin || parsed.username || parsed.password) {
    throw httpError(403, "Invalid request origin.");
  }
  if (origin === family.rootOrigin) return;
  if (originForHost(parsed.host.toLowerCase()) !== origin) {
    throw httpError(403, "Cross-origin request rejected.");
  }
  const context = await resolveKnownHost(parsed.host.toLowerCase(), [family], accessStore);
  if (!context || context.kind !== "workspace" || !context.workspace) {
    throw httpError(403, "Cross-origin request rejected.");
  }
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

function serveIndex(staticDir: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      res.type("html").send(await fs.readFile(path.join(staticDir, "index.html"), "utf8"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      res.type("html").send(FALLBACK_INDEX_HTML);
    }
  });
}

function sendStaticFile(staticDir: string, relativePath: string, contentType: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      const content = await fs.readFile(path.join(staticDir, relativePath));
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
