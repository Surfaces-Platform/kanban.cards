import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/express";
import type { Request, RequestHandler } from "express";

export interface ClerkAuthConfig {
  publishableKey: string;
  secretKey: string;
  encryptionKey: string;
  sessionSecret: string;
  authHost: string;
  allowedUserIds: readonly string[];
  rootSessionTtlSeconds: number;
  tenantSessionTtlSeconds: number;
}

export interface ClerkRootDomainConfig {
  origin: string;
  role: "auth" | "app";
}

export interface VerifiedClerkIdentity {
  clerkUserId: string;
  clerkSessionId: string;
  email: string;
  displayName: string;
}

export interface ClerkRequestAuth {
  authenticated: boolean;
  clerkUserId: string | null;
  clerkSessionId: string | null;
}

export interface ClerkAuthGateway {
  middleware(rootDomains: readonly ClerkRootDomainConfig[], trustForwardedHost: boolean): RequestHandler;
  requestAuth(req: Request): ClerkRequestAuth;
  verifiedIdentity(clerkUserId: string, clerkSessionId: string): Promise<VerifiedClerkIdentity>;
  revokeSession(clerkSessionId: string): Promise<void>;
}

interface ClerkBackendUser {
  id: string;
  banned: boolean;
  locked: boolean;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  primaryEmailAddress: {
    emailAddress: string;
    verification?: { status?: string | null } | null;
  } | null;
}

interface ClerkBackendClient {
  users: { getUser(userId: string): Promise<ClerkBackendUser> };
  sessions: { revokeSession(sessionId: string): Promise<unknown> };
}

export interface ClerkAuthDependencies {
  client?: ClerkBackendClient;
  middleware?: (
    options: Record<string, unknown> | ((req: Request) => Record<string, unknown>)
  ) => RequestHandler;
  getAuth?: (req: Request, options: Record<string, unknown>) => {
    isAuthenticated: boolean;
    userId: string | null;
    sessionId: string | null;
  };
}

export class ClerkAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClerkAuthConfigError";
  }
}

export class ClerkIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClerkIdentityError";
  }
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;

export function getClerkAuthConfig(env: Record<string, string | undefined> = process.env): ClerkAuthConfig {
  const rootSessionTtlSeconds = appSessionTtlSeconds(env, "ROOT_SESSION_TTL_SECONDS");
  const tenantSessionTtlSeconds = appSessionTtlSeconds(env, "TENANT_SESSION_TTL_SECONDS");
  const config = validateClerkAuthConfig({
    publishableKey: clerkPublishableKey(env),
    secretKey: requiredEnv(env, "CLERK_SECRET_KEY"),
    encryptionKey: requiredEnv(env, "CLERK_ENCRYPTION_KEY"),
    sessionSecret: requiredEnv(env, "SESSION_SECRET"),
    authHost: requiredEnv(env, "KANBAN_CARDS_AUTH_HOST"),
    allowedUserIds: parseAllowedUserIds(requiredEnv(env, "KANBAN_CARDS_ALLOWED_CLERK_USER_IDS")),
    rootSessionTtlSeconds,
    tenantSessionTtlSeconds
  });
  if (env.VERCEL_ENV?.trim().toLowerCase() === "production") {
    if (!config.publishableKey.startsWith("pk_live_") || !config.secretKey.startsWith("sk_live_")) {
      throw new ClerkAuthConfigError("Vercel production requires Clerk production-instance pk_live_ and sk_live_ keys");
    }
  }
  return config;
}

export function hasClerkAuthConfig(env: Record<string, string | undefined> = process.env): boolean {
  try {
    getClerkAuthConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function clerkAuthConfigurationRequested(env: Record<string, string | undefined> = process.env): boolean {
  return [
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_ENCRYPTION_KEY",
    "SESSION_SECRET",
    "KANBAN_CARDS_AUTH_HOST",
    "KANBAN_CARDS_ALLOWED_CLERK_USER_IDS"
  ]
    .some((name) => Boolean(env[name]?.trim()));
}

export function validateClerkAuthConfig(config: ClerkAuthConfig): ClerkAuthConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ClerkAuthConfigError("Clerk authentication configuration is invalid");
  }
  const publishableKey = configString(config.publishableKey, "Clerk publishable key");
  const secretKey = configString(config.secretKey, "CLERK_SECRET_KEY");
  const encryptionKey = configString(config.encryptionKey, "CLERK_ENCRYPTION_KEY");
  const sessionSecret = configString(config.sessionSecret, "SESSION_SECRET");
  const authHost = exactClerkAuthHost(config.authHost);
  clerkFrontendApiOrigin({ publishableKey });
  if (!secretKey.startsWith("sk_")) throw new ClerkAuthConfigError("CLERK_SECRET_KEY must be a Clerk secret key");
  if (Buffer.byteLength(encryptionKey, "utf8") < 32) throw new ClerkAuthConfigError("CLERK_ENCRYPTION_KEY must be at least 32 bytes");
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) throw new ClerkAuthConfigError("SESSION_SECRET must be at least 32 bytes");
  if (!Array.isArray(config.allowedUserIds)) {
    throw new ClerkAuthConfigError("KANBAN_CARDS_ALLOWED_CLERK_USER_IDS must contain exact Clerk user IDs");
  }
  const allowedUserIds = [...new Set(config.allowedUserIds.map((value) => configClerkUserId(value, "KANBAN_CARDS_ALLOWED_CLERK_USER_IDS")))];
  if (!allowedUserIds.length) throw new ClerkAuthConfigError("KANBAN_CARDS_ALLOWED_CLERK_USER_IDS must contain at least one exact Clerk user ID");
  return {
    publishableKey,
    secretKey,
    encryptionKey,
    sessionSecret,
    authHost,
    allowedUserIds,
    rootSessionTtlSeconds: configSeconds(config.rootSessionTtlSeconds, "ROOT_SESSION_TTL_SECONDS"),
    tenantSessionTtlSeconds: configSeconds(config.tenantSessionTtlSeconds, "TENANT_SESSION_TTL_SECONDS")
  };
}

export function createClerkAuthGateway(config: ClerkAuthConfig, dependencies: ClerkAuthDependencies = {}): ClerkAuthGateway {
  const accepted = validateClerkAuthConfig(config);
  if (!dependencies.middleware && process.env.CLERK_ENCRYPTION_KEY !== accepted.encryptionKey) {
    throw new ClerkAuthConfigError("CLERK_ENCRYPTION_KEY must be set in the process environment for Clerk dynamic keys");
  }
  const client = dependencies.client || createClerkClient({
    publishableKey: accepted.publishableKey,
    secretKey: accepted.secretKey
  }) as unknown as ClerkBackendClient;
  const makeMiddleware = dependencies.middleware || (clerkMiddleware as unknown as ClerkAuthDependencies["middleware"]);
  const readAuth = dependencies.getAuth || (getAuth as unknown as NonNullable<ClerkAuthDependencies["getAuth"]>);
  return {
    middleware(rootDomains, trustForwardedHost) {
      const acceptedDomains = validateRootDomains(rootDomains);
      const configuredAuthOrigin = clerkAuthOrigin(accepted);
      if (!acceptedDomains.some((domain) => domain.origin === configuredAuthOrigin && domain.role === "auth")) {
        throw new ClerkAuthConfigError("Clerk middleware auth surface must match KANBAN_CARDS_AUTH_HOST");
      }
      const rootDomainsByHost = new Map(acceptedDomains.map((domain) => [new URL(domain.origin).host, domain]));
      const authenticate = makeMiddleware!((req) => {
        const requestHost = exactRequestHost(req, trustForwardedHost);
        const requestDomain = rootDomainsByHost.get(requestHost) || null;
        if (!requestDomain) {
          throw new ClerkAuthConfigError("Clerk middleware received a non-root host");
        }
        return {
          publishableKey: accepted.publishableKey,
          secretKey: accepted.secretKey,
          authorizedParties: [requestDomain.origin]
        };
      });
      return (req, res, next) => {
        if (!trustForwardedHost) stripUntrustedProxyHeaders(req);
        const requestHost = exactRequestHost(req, trustForwardedHost);
        if (!rootDomainsByHost.has(requestHost)) return next();
        return authenticate(req, res, next);
      };
    },
    requestAuth(req) {
      const auth = readAuth(req, { acceptsToken: "session_token", treatPendingAsSignedOut: true });
      if (!auth.isAuthenticated || !auth.userId || !auth.sessionId) {
        return { authenticated: false, clerkUserId: null, clerkSessionId: null };
      }
      return {
        authenticated: true,
        clerkUserId: identityClerkUserId(auth.userId, "Clerk user ID"),
        clerkSessionId: scalar(auth.sessionId, "Clerk session ID")
      };
    },
    async verifiedIdentity(clerkUserIdValue, clerkSessionId) {
      const userId = identityClerkUserId(clerkUserIdValue, "Clerk user ID");
      const sessionId = scalar(clerkSessionId, "Clerk session ID");
      const user = await client.users.getUser(userId);
      if (user.id !== userId || user.banned || user.locked) {
        throw new ClerkIdentityError("The Clerk identity is unavailable.");
      }
      const primaryEmail = user.primaryEmailAddress;
      if (!primaryEmail || primaryEmail.verification?.status !== "verified") {
        throw new ClerkIdentityError("A verified primary email address is required.");
      }
      const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.username?.trim() || "";
      if (!displayName) throw new ClerkIdentityError("A Clerk profile name is required.");
      return {
        clerkUserId: userId,
        clerkSessionId: sessionId,
        email: scalar(primaryEmail.emailAddress, "Verified primary email"),
        displayName
      };
    },
    async revokeSession(clerkSessionId) {
      await client.sessions.revokeSession(scalar(clerkSessionId, "Clerk session ID"));
    }
  };
}

function stripUntrustedProxyHeaders(req: Request): void {
  const remoteAddress = req.socket?.remoteAddress?.trim();
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-forwarded-server",
    "x-real-ip",
    "cf-connecting-ip"
  ]) {
    delete req.headers[name];
  }
  if (remoteAddress && !/[\r\n,]/.test(remoteAddress)) req.headers["x-forwarded-for"] = remoteAddress;
}

function validateRootDomains(values: readonly ClerkRootDomainConfig[]): ClerkRootDomainConfig[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 3) {
    throw new ClerkAuthConfigError("Clerk requires one auth surface and one or two same-root application surfaces");
  }
  const domains = values.map((value) => {
    if (value?.role !== "auth" && value?.role !== "app") {
      throw new ClerkAuthConfigError("Clerk root domains must declare an exact auth or app surface role");
    }
    return {
      origin: exactOrigin(value.origin),
      role: value.role
    };
  });
  if (
    new Set(domains.map((value) => value.origin)).size !== domains.length
    || domains.filter((value) => value.role === "auth").length !== 1
    || domains.filter((value) => value.role === "app").length < 1
  ) {
    throw new ClerkAuthConfigError("Clerk root domains must contain one exact auth surface and unique same-root application surfaces");
  }
  return domains;
}

export function clerkAuthOrigin(config: ClerkAuthConfig): string {
  const host = exactClerkAuthHost(config.authHost);
  const hostname = new URL(`http://${host}`).hostname;
  return `${isLoopback(hostname) ? "http" : "https"}://${host}`;
}

export function clerkAuthSignInUrl(config: ClerkAuthConfig): string {
  return `${clerkAuthOrigin(config)}/sign-in`;
}

export function clerkAuthSignUpUrl(config: ClerkAuthConfig): string {
  return `${clerkAuthOrigin(config)}/sign-up`;
}

export function clerkFrontendApiOrigin(config: Pick<ClerkAuthConfig, "publishableKey">): string {
  const publishableKey = configString(config?.publishableKey, "Clerk publishable key");
  const match = /^(pk_(?:test|live)_)([A-Za-z0-9+/]+)$/.exec(publishableKey);
  if (!match) throw new ClerkAuthConfigError("Clerk publishable key must be a valid pk_test_ or pk_live_ key");
  const encodedFrontendApi = match[2];
  let decoded: string;
  try {
    const bytes = Buffer.from(encodedFrontendApi, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== encodedFrontendApi) throw new Error();
    decoded = bytes.toString("utf8");
    if (Buffer.from(decoded, "utf8").compare(bytes) !== 0) throw new Error();
  } catch {
    throw new ClerkAuthConfigError("Clerk publishable key does not contain a valid Frontend API host");
  }
  if (!decoded.endsWith("$") || decoded.slice(0, -1).includes("$")) {
    throw new ClerkAuthConfigError("Clerk publishable key does not contain a valid Frontend API host");
  }
  const host = decoded.slice(0, -1);
  try {
    const parsed = new URL(`https://${host}`);
    if (
      parsed.host !== host
      || parsed.hostname !== host
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || isIPLiteral(parsed.hostname)
      || !isExactDnsHostname(parsed.hostname)
    ) throw new Error();
  } catch {
    throw new ClerkAuthConfigError("Clerk publishable key does not contain an exact DNS Frontend API host");
  }
  return `https://${host}`;
}

function isIPLiteral(hostname: string): boolean {
  return /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":");
}

function isExactDnsHostname(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes(".")) return false;
  return hostname.split(".").every((label) => (
    label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function exactRequestHost(req: Request, trustForwardedHost: boolean): string {
  const raw = trustForwardedHost ? req.get?.("x-forwarded-host") || req.get?.("host") : req.get?.("host");
  const host = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(",") || /[\s/@?#\\]/.test(host)) return "";
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.host.toLowerCase();
  } catch {
    return "";
  }
}

function exactOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClerkAuthConfigError("Clerk authorized parties must be exact origins");
  }
  if (parsed.origin !== value || parsed.username || parsed.password || (parsed.protocol !== "https:" && !isLoopback(parsed.hostname))) {
    throw new ClerkAuthConfigError("Clerk authorized parties must be exact secure origins");
  }
  return value;
}

function exactClerkAuthHost(value: unknown): string {
  const accepted = configString(value, "KANBAN_CARDS_AUTH_HOST");
  try {
    const parsed = new URL(`http://${accepted}`);
    if (
      parsed.host !== accepted ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      /^\d+(?:\.\d+){3}(?::\d+)?$/.test(accepted) ||
      accepted.includes("[")
    ) throw new Error();
  } catch {
    throw new ClerkAuthConfigError("KANBAN_CARDS_AUTH_HOST must be an exact lowercase DNS host with an optional local port");
  }
  return accepted;
}

function parseAllowedUserIds(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new ClerkAuthConfigError("KANBAN_CARDS_ALLOWED_CLERK_USER_IDS must contain at least one exact Clerk user ID");
  return values;
}

function configClerkUserId(value: unknown, label: string): string {
  const result = configString(value, label);
  if (!CLERK_USER_ID.test(result)) throw new ClerkAuthConfigError(`${label} must contain exact Clerk user IDs`);
  return result;
}

function identityClerkUserId(value: unknown, label: string): string {
  const result = scalar(value, label);
  if (!CLERK_USER_ID.test(result)) throw new ClerkIdentityError(`${label} is invalid.`);
  return result;
}

function scalar(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new ClerkIdentityError(`${label} is required.`);
  return value;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ClerkAuthConfigError(`${name} is required`);
  return value;
}

function clerkPublishableKey(env: Record<string, string | undefined>): string {
  const marketplaceKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const compatibilityKey = env.CLERK_PUBLISHABLE_KEY?.trim();
  if (marketplaceKey && compatibilityKey && marketplaceKey !== compatibilityKey) {
    throw new ClerkAuthConfigError("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_PUBLISHABLE_KEY must match when both are set");
  }
  const result = marketplaceKey || compatibilityKey;
  if (!result) {
    throw new ClerkAuthConfigError("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required (CLERK_PUBLISHABLE_KEY is accepted as a compatibility alias)");
  }
  return result;
}

function configString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new ClerkAuthConfigError(`${label} must be a non-empty scalar string`);
  return value;
}

function positiveSeconds(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new ClerkAuthConfigError(`${label} must be a positive integer`);
  return result;
}

function appSessionTtlSeconds(env: Record<string, string | undefined>, compatibilityName: string): number {
  const canonicalName = "KANBAN_CARDS_SESSION_TTL_SECONDS";
  const canonicalConfigured = env[canonicalName] !== undefined && env[canonicalName] !== "";
  if (!canonicalConfigured) {
    return positiveSeconds(env[compatibilityName], DEFAULT_SESSION_TTL_SECONDS, compatibilityName);
  }
  const canonical = positiveSeconds(env[canonicalName], DEFAULT_SESSION_TTL_SECONDS, canonicalName);
  if (env[compatibilityName] !== undefined && env[compatibilityName] !== "") {
    const compatibility = positiveSeconds(env[compatibilityName], DEFAULT_SESSION_TTL_SECONDS, compatibilityName);
    if (compatibility !== canonical) {
      throw new ClerkAuthConfigError(`${compatibilityName} must match ${canonicalName} when both are set`);
    }
  }
  return canonical;
}

function configSeconds(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ClerkAuthConfigError(`${label} must be a positive integer`);
  return Number(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
