import crypto from "node:crypto";
import { isIP } from "node:net";
import express, { type Request } from "express";

import { BROWSER_SESSION_TTL_SECONDS } from "./app-sessions";

import {
  type AccessOwner,
  type AccessRegistryState,
  type AccessStore,
  type AuthSession,
  createWorkspaceInRegistry
} from "./access-store";

export interface PasskeyAuthConfig {
  authHost: string;
  authOrigin: string;
  rpId: string;
  sessionSecret: string;
  rootOrigins: string[];
  sessionTtlSeconds: number;
  setupOwnerId?: string;
  setupTokenHash?: string;
  setupExpiresAt?: string;
}

export type PasskeyMode = "signup" | "signin" | "setup" | "recover" | "add" | "verify";
export interface AuthIntent {
  id: string;
  mode: PasskeyMode;
  browserHash: string;
  rootOrigin: string;
  ownerId: string | null;
  sessionId: string | null;
  action: string | null;
  expiresAt: string;
}

async function loadWebAuthn() { return import("@simplewebauthn/server"); }
type WebAuthnServer = Pick<Awaited<ReturnType<typeof loadWebAuthn>>, "generateRegistrationOptions" | "generateAuthenticationOptions" | "verifyRegistrationResponse" | "verifyAuthenticationResponse">;

export interface PasskeyRouterOptions {
  config: PasskeyAuthConfig;
  accessStore: AccessStore;
  now?: () => Date;
  /** Test seam for deterministic authenticator responses. Production uses SimpleWebAuthn. */
  webauthn?: WebAuthnServer;
}

const CEREMONY_TTL_MS = 5 * 60 * 1_000;
const INTENT_TTL_MS = 10 * 60 * 1_000;
const FRESH_VERIFICATION_MS = 5 * 60 * 1_000;
const MODES = new Set<PasskeyMode>(["signup", "signin", "setup", "recover", "add", "verify"]);
const RESERVED_SLUGS = new Set(["api", "app", "auth", "admin", "clerk", "www"]);

export function hashSecret(secret: string): string {
  return `sha256:${crypto.createHash("sha256").update(secret).digest("hex")}`;
}

export function passkeyAuthConfigurationRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SESSION_SECRET || env.KANBAN_CARDS_SESSION_SECRET || env.KANBAN_CARDS_AUTH_HOST);
}

export function getPasskeyConfig(env: NodeJS.ProcessEnv = process.env): PasskeyAuthConfig {
  const authHost = String(env.KANBAN_CARDS_AUTH_HOST || "auth.kanban.cards").trim().toLowerCase();
  const rootHost = String(env.KANBAN_CARDS_ROOT_HOST || "kanban.cards").trim().toLowerCase();
  const authOrigin = originForHost(authHost);
  const config: PasskeyAuthConfig = {
    authHost,
    authOrigin,
    rpId: String(env.KANBAN_CARDS_PASSKEY_RP_ID || new URL(authOrigin).hostname).trim().toLowerCase(),
    sessionSecret: String(env.SESSION_SECRET || env.KANBAN_CARDS_SESSION_SECRET || ""),
    rootOrigins: [originForHost(rootHost), ...(env.KANBAN_CARDS_CANDIDATE_ROOT_HOST?.trim() ? [originForHost(env.KANBAN_CARDS_CANDIDATE_ROOT_HOST.trim().toLowerCase())] : [])],
    sessionTtlSeconds: BROWSER_SESSION_TTL_SECONDS,
    setupOwnerId: env.KANBAN_CARDS_SETUP_OWNER_ID?.trim(),
    setupTokenHash: env.KANBAN_CARDS_SETUP_TOKEN_HASH?.trim(),
    setupExpiresAt: env.KANBAN_CARDS_SETUP_EXPIRES_AT?.trim()
  };
  validatePasskeyAuthConfig(config);
  return config;
}

export function validatePasskeyAuthConfig(config: PasskeyAuthConfig): void {
  if (!config.sessionSecret || config.sessionSecret.length < 32) throw new Error("Passkey authentication requires SESSION_SECRET with at least 32 characters.");
  const auth = checkedOrigin(config.authOrigin);
  if (auth.host !== config.authHost || auth.hostname !== config.rpId) throw new Error("Passkey auth host, origin, and RP ID must identify the exact auth host.");
  if (!config.rootOrigins.length || new Set(config.rootOrigins).size !== config.rootOrigins.length) throw new Error("Passkey root origins must be nonempty and unique.");
  for (const origin of config.rootOrigins) {
    if (checkedOrigin(origin).origin === auth.origin) throw new Error("The passkey auth host must be separate from the board root host.");
  }
  if (!Number.isSafeInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60 || config.sessionTtlSeconds > BROWSER_SESSION_TTL_SECONDS) throw new Error("Passkey session lifetime must be between one minute and 365 days.");
  const setup = [config.setupOwnerId, config.setupTokenHash, config.setupExpiresAt];
  if (setup.some(Boolean) && !setup.every(Boolean)) throw new Error("One-time owner setup requires owner ID, token hash, and expiry together.");
  if (config.setupTokenHash && !/^sha256:[a-f0-9]{64}$/.test(config.setupTokenHash)) throw new Error("Setup token must be configured as a SHA-256 hash.");
  if (config.setupExpiresAt && !Number.isFinite(Date.parse(config.setupExpiresAt))) throw new Error("Setup expiry must be a valid timestamp.");
}

export const validatePasskeyConfig = validatePasskeyAuthConfig;

/** Vercel overwrites its client-IP header. Outside that runtime, forwarded headers are untrusted. */
export function authenticationClientIp(req: Pick<Request, "headers" | "ip" | "socket">, trustedVercel = Boolean(process.env.VERCEL)): string {
  const forwarded = req.headers["x-vercel-forwarded-for"];
  if (trustedVercel && typeof forwarded === "string" && isIP(forwarded.trim())) return forwarded.trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function readAuthIntent(req: Pick<Request, "headers">, config: PasskeyAuthConfig, now = new Date()): AuthIntent | null {
  const payload = readSignedCookie(req, cookieName("intent", config), config.sessionSecret);
  if (!payload || typeof payload.id !== "string" || !isMode(payload.mode) || typeof payload.browserHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(payload.browserHash) || typeof payload.rootOrigin !== "string" || !config.rootOrigins.includes(payload.rootOrigin) || typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= now.getTime()) return null;
  if (payload.ownerId !== null && typeof payload.ownerId !== "string") return null;
  if (payload.sessionId !== null && typeof payload.sessionId !== "string") return null;
  if (payload.action !== null && typeof payload.action !== "string") return null;
  return payload as unknown as AuthIntent;
}

export async function activeOwnerSession(accessStore: AccessStore, sessionId: string, now = new Date()): Promise<{ session: AuthSession; owner: AccessOwner } | null> {
  return activeSessionInState(await accessStore.read(), sessionId, now);
}

export function createPasskeyRouter({ config, accessStore, now = () => new Date(), webauthn }: PasskeyRouterOptions): express.Router {
  validatePasskeyAuthConfig(config);
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  router.post("/start", async (req, res) => {
    const rootOrigin = text(req.body?.rootOrigin, "Root origin", 200);
    if (!config.rootOrigins.includes(rootOrigin) || req.get("origin") !== rootOrigin) throw httpError(403, "Start sign-in from your board.");
    const intentToken = secret(req.body?.intentToken, "Sign-in request");
    const browserNonce = secret(req.body?.browserNonce, "Browser verification");
    const current = now();
    const intent = await accessStore.authTransaction((state) => {
      const index = state.authChallenges.findIndex((entry) => entry.purpose === "authorize" && entry.challenge === hashSecret(intentToken));
      if (index < 0) throw httpError(401, "Sign-in request is invalid or already used. Start again from your board.");
      const challenge = state.authChallenges[index];
      if (challenge.rootOrigin !== rootOrigin || challenge.browserHash !== hashSecret(browserNonce) || Date.parse(challenge.expiresAt) <= current.getTime() || !isMode(challenge.data.mode)) throw httpError(401, "Sign-in request expired or belongs to another browser.");
      const mode = challenge.data.mode;
      const sessionId = typeof challenge.data.sessionId === "string" ? challenge.data.sessionId : null;
      if (mode === "add" || mode === "verify") requireOwnerSession(state, challenge.ownerId, sessionId, rootOrigin, current, mode === "add");
      state.authChallenges.splice(index, 1);
      const intent = {
        id: crypto.randomUUID(),
        mode,
        browserHash: challenge.browserHash,
        rootOrigin,
        ownerId: challenge.ownerId,
        sessionId,
        action: typeof challenge.data.action === "string" ? challenge.data.action : null,
        expiresAt: new Date(current.getTime() + INTENT_TTL_MS).toISOString()
      } satisfies AuthIntent;
      state.authChallenges.push({ id: intent.id, challenge: hashSecret(intentToken), browserHash: intent.browserHash, purpose: "intent", ownerId: intent.ownerId, rootOrigin, expiresAt: intent.expiresAt, data: { mode } });
      return intent;
    });
    res.append("Set-Cookie", signedCookie(cookieName("intent", config), intent, config, INTENT_TTL_MS / 1_000));
    res.redirect(303, intent.mode === "signup" ? "/sign-up" : "/sign-in");
  });

  router.post("/options", async (req, res) => {
    requireAuthOrigin(req, config);
    const current = now();
    const intent = readAuthIntent(req, config, current);
    if (!intent) throw httpError(401, "Start sign-in from your board.");
    if (req.body?.mode !== undefined && req.body.mode !== intent.mode) throw httpError(403, "This sign-in request cannot change its purpose.");
    await checkRateLimit(accessStore, req, intent, config, current, "options");
    let preauth = readCookie(req, cookieName("browser", config));
    if (!preauth || !/^[a-zA-Z0-9_-]{43}$/.test(preauth)) preauth = crypto.randomBytes(32).toString("base64url");
    res.append("Set-Cookie", plainCookie(cookieName("browser", config), preauth, config, INTENT_TTL_MS / 1_000));
    const browserHash = hashSecret(preauth);
    const mode = intent.mode;
    const registration = ["signup", "setup", "recover", "add"].includes(mode);
    let ownerId = intent.ownerId;
    const data: Record<string, unknown> = { intent, browserNonceHash: intent.browserHash };
    let displayName = "Owner";
    const state = await accessStore.read();
    requireActiveIntent(state, intent, current);
    if (mode === "signup") {
      const workspaceName = text(req.body?.workspaceName, "Workspace name", 80);
      const workspaceSlug = slug(req.body?.workspaceSlug);
      displayName = optionalText(req.body?.displayName, "Owner name", 80) || workspaceName;
      if (state.workspaces.some((workspace) => workspace.slug === workspaceSlug)) throw httpError(409, "That Workspace address is already in use.");
      ownerId = `owner-${crypto.randomUUID()}`;
      Object.assign(data, { workspaceName, workspaceSlug, displayName, pendingOwnerId: ownerId });
    } else if (mode === "setup") {
      requireSetup(state, config, hashSecret(secret(req.body?.setupToken, "Setup token")), current);
      ownerId = config.setupOwnerId!;
      data.setupTokenHash = config.setupTokenHash;
    } else if (mode === "recover") {
      const recoveryCode = secret(req.body?.recoveryCode, "Recovery code");
      const match = /^kcr_([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/.exec(recoveryCode);
      const record = match && state.recoveryCodes.find((entry) => entry.ownerId === match[1] && entry.codeHash === hashSecret(recoveryCode) && !entry.consumedAt);
      if (!record) throw httpError(401, "Recovery code is invalid or already used.");
      ownerId = record.ownerId;
      data.recoveryCodeHash = record.codeHash;
    } else if (mode === "add" || mode === "verify") {
      requireOwnerSession(state, ownerId, intent.sessionId, intent.rootOrigin, current, mode === "add");
    }
    if (ownerId && mode !== "signup") {
      const owner = state.owners.find((entry) => entry.id === ownerId);
      if (!owner) throw httpError(401, "Owner account is unavailable.");
      displayName = owner.displayName;
      if (ownerId !== intent.ownerId) await checkRateLimit(accessStore, req, { ...intent, ownerId }, config, current, `owner-${mode}`);
    }
    const ownerPasskeys = state.passkeys.filter((entry) => entry.ownerId === ownerId && !entry.revokedAt);
    if (mode === "add" && ownerPasskeys.length >= 8) throw httpError(409, "An owner can have up to eight passkeys.");
    const library = webauthn || await loadWebAuthn();
    const options = registration
      ? await library.generateRegistrationOptions({
        rpName: "kanban.cards",
        rpID: config.rpId,
        userID: Uint8Array.from(Buffer.from(ownerId!, "utf8")),
        userName: displayName,
        userDisplayName: displayName,
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: ownerPasskeys.map((key) => ({ id: key.id, transports: key.transports as never[] }))
      })
      : await library.generateAuthenticationOptions({
        rpID: config.rpId,
        userVerification: "required",
        ...(mode === "verify" ? { allowCredentials: ownerPasskeys.map((key) => ({ id: key.id, transports: key.transports as never[] })) } : {})
      });
    const challengeId = crypto.randomUUID();
    await accessStore.authTransaction((next) => {
      next.authChallenges = next.authChallenges.filter((entry) => Date.parse(entry.expiresAt) > current.getTime());
      next.authChallenges.push({ id: challengeId, challenge: options.challenge, browserHash, purpose: mode, ownerId: mode === "signup" ? null : ownerId, rootOrigin: intent.rootOrigin, expiresAt: new Date(current.getTime() + CEREMONY_TTL_MS).toISOString(), data });
    });
    res.json({ challengeId, options, ceremony: registration ? "registration" : "authentication" });
  });

  router.post("/verify", async (req, res) => {
    requireAuthOrigin(req, config);
    let current = now();
    const intent = readAuthIntent(req, config, current);
    if (!intent) throw httpError(401, "Sign-in request expired. Start again from your board.");
    await checkRateLimit(accessStore, req, intent, config, current, "verify");
    const challengeId = text(req.body?.challengeId, "Challenge", 100);
    const preauth = readCookie(req, cookieName("browser", config));
    const response = req.body?.response;
    if (!preauth || !response || typeof response !== "object" || typeof response.id !== "string") throw httpError(400, "Passkey response is missing.");
    const challenge = await accessStore.authTransaction((state) => {
      const index = state.authChallenges.findIndex((entry) => entry.id === challengeId);
      const found = state.authChallenges[index];
      if (!found || found.purpose !== intent.mode || found.rootOrigin !== intent.rootOrigin || found.browserHash !== hashSecret(preauth) || found.data.browserNonceHash !== intent.browserHash || Date.parse(found.expiresAt) <= current.getTime()) throw httpError(401, "Passkey challenge expired, was already used, or belongs to another browser.");
      state.authChallenges.splice(index, 1);
      return structuredClone(found);
    });
    const library = webauthn || await loadWebAuthn();
    const registration = ["signup", "setup", "recover", "add"].includes(challenge.purpose);
    let verifiedKey: { id: string; publicKey: string; counter: number; transports: string[] } | null = null;
    let signedInOwnerId: string | null = null;
    let expectedCounter = 0;
    try {
      if (registration) {
        const result = await library.verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: config.authOrigin, expectedRPID: config.rpId, requireUserVerification: true, requireUserPresence: true });
        if (!result.verified || !result.registrationInfo) throw new Error("Passkey registration was not verified.");
        const credential = result.registrationInfo.credential;
        verifiedKey = { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports: credential.transports || [] };
      } else {
        const state = await accessStore.read();
        const key = state.passkeys.find((entry) => entry.id === response.id && !entry.revokedAt);
        if (!key || (challenge.ownerId && key.ownerId !== challenge.ownerId)) throw new Error("Passkey does not belong to this owner.");
        const userHandle = response.response?.userHandle;
        if ((challenge.purpose === "signin" && typeof userHandle !== "string") || (userHandle && userHandle !== Buffer.from(key.ownerId).toString("base64url"))) throw new Error("Passkey owner does not match.");
        const result = await library.verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: config.authOrigin, expectedRPID: config.rpId, requireUserVerification: true, credential: { id: key.id, publicKey: Uint8Array.from(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: key.transports as never[] } });
        if (!result.verified) throw new Error("Passkey authentication was not verified.");
        signedInOwnerId = key.ownerId;
        expectedCounter = key.counter;
        verifiedKey = { id: key.id, publicKey: key.publicKey, counter: result.authenticationInfo.newCounter, transports: key.transports };
      }
    } catch {
      throw httpError(401, "Passkey could not be verified. Please start again.");
    }
    current = now();
    const challengeOwnerId = challenge.ownerId || (challenge.purpose === "signup" && typeof challenge.data.pendingOwnerId === "string" ? challenge.data.pendingOwnerId : null);
    const recoveryCode = ["signup", "setup", "recover"].includes(challenge.purpose) ? `kcr_${challengeOwnerId}.${crypto.randomBytes(32).toString("base64url")}` : null;
    const handoffToken = `kch_${crypto.randomBytes(32).toString("base64url")}`;
    await accessStore.authTransaction((state) => {
      const timestamp = current.toISOString();
      const intentIndex = requireActiveIntent(state, intent, current);
      state.authChallenges.splice(intentIndex, 1);
      const ownerId = challengeOwnerId || signedInOwnerId;
      if (!ownerId || !verifiedKey) throw httpError(401, "Owner account is unavailable.");
      if (registration && state.passkeys.some((entry) => entry.id === verifiedKey!.id)) throw httpError(409, "This passkey is already registered.");
      if (challenge.purpose === "signup") {
        const workspaceSlug = slug(challenge.data.workspaceSlug);
        if (state.workspaces.some((workspace) => workspace.slug === workspaceSlug)) throw httpError(409, "That Workspace address is already in use.");
        state.owners.push({ id: ownerId, providerSubject: ownerId, email: "", displayName: text(challenge.data.displayName, "Owner name", 80), createdAt: timestamp, updatedAt: timestamp });
        createWorkspaceInRegistry(state, { providerSubject: ownerId, email: "", displayName: text(challenge.data.displayName, "Owner name", 80), slug: workspaceSlug, name: text(challenge.data.workspaceName, "Workspace name", 80) }, timestamp);
      } else if (challenge.purpose === "setup") {
        requireSetup(state, config, String(challenge.data.setupTokenHash || ""), current);
        state.setupConsumed = true;
      } else if (challenge.purpose === "recover") {
        const code = state.recoveryCodes.find((entry) => entry.ownerId === ownerId && !entry.consumedAt && entry.codeHash === challenge.data.recoveryCodeHash);
        if (!code) throw httpError(401, "Recovery code is invalid or already used.");
        code.consumedAt = timestamp;
        for (const key of state.passkeys.filter((entry) => entry.ownerId === ownerId && !entry.revokedAt)) key.revokedAt = timestamp;
        for (const session of state.authSessions.filter((entry) => entry.ownerId === ownerId && !entry.revokedAt)) session.revokedAt = timestamp;
        for (const handoff of state.authHandoffs.filter((entry) => entry.ownerId === ownerId && !entry.consumedAt)) handoff.consumedAt = timestamp;
        for (const handoff of state.handoffs.filter((entry) => entry.ownerId === ownerId && !entry.consumedAt)) handoff.consumedAt = timestamp;
        for (const connection of state.agentConnections.filter((entry) => entry.ownerId === ownerId && !entry.revokedAt)) connection.revokedAt = timestamp;
        state.authChallenges = state.authChallenges.filter((entry) => entry.ownerId !== ownerId);
      }
      if (!state.owners.some((entry) => entry.id === ownerId)) throw httpError(401, "Owner account is unavailable.");
      let session: AuthSession;
      if (challenge.purpose === "add" || challenge.purpose === "verify") {
        session = requireOwnerSession(state, ownerId, intent.sessionId, intent.rootOrigin, current, challenge.purpose === "add");
        if (challenge.purpose === "add" && state.passkeys.filter((entry) => entry.ownerId === ownerId && !entry.revokedAt).length >= 8) throw httpError(409, "An owner can have up to eight passkeys.");
        session.verifiedAt = timestamp;
      } else {
        session = { id: `session-${crypto.randomBytes(32).toString("base64url")}`, ownerId, rootOrigin: intent.rootOrigin, createdAt: timestamp, expiresAt: new Date(current.getTime() + config.sessionTtlSeconds * 1_000).toISOString(), revokedAt: null, verifiedAt: timestamp };
        state.authSessions.push(session);
      }
      if (registration) {
        state.passkeys.push({ ...verifiedKey, ownerId, createdAt: timestamp, lastUsedAt: null, revokedAt: null });
      } else {
        const key = state.passkeys.find((entry) => entry.id === verifiedKey!.id && entry.ownerId === ownerId && !entry.revokedAt);
        if (!key || key.counter !== expectedCounter) throw httpError(401, "Passkey changed while signing in. Please try again.");
        key.counter = verifiedKey.counter;
        key.lastUsedAt = timestamp;
      }
      if (recoveryCode) {
        for (const code of state.recoveryCodes.filter((entry) => entry.ownerId === ownerId && !entry.consumedAt)) code.consumedAt = timestamp;
        state.recoveryCodes.push({ ownerId, codeHash: hashSecret(recoveryCode), createdAt: timestamp, consumedAt: null });
      }
      state.authHandoffs = state.authHandoffs.filter((entry) => Date.parse(entry.expiresAt) > current.getTime());
      state.authHandoffs.push({ id: crypto.randomUUID(), tokenHash: hashSecret(handoffToken), browserHash: intent.browserHash, ownerId, sessionId: session.id, destinationOrigin: intent.rootOrigin, expiresAt: new Date(current.getTime() + CEREMONY_TTL_MS).toISOString(), consumedAt: null });
    });
    res.append("Set-Cookie", plainCookie(cookieName("intent", config), "", config, 0));
    res.json({ authenticated: true, destination: `${intent.rootOrigin}/api/auth-handoff`, handoffToken, ...(recoveryCode ? { recoveryCode } : {}) });
  });
  return router;
}

function requireSetup(state: AccessRegistryState, config: PasskeyAuthConfig, suppliedHash: string, current: Date): void {
  if (!config.setupOwnerId || !config.setupTokenHash || !config.setupExpiresAt || state.setupConsumed || suppliedHash !== config.setupTokenHash || Date.parse(config.setupExpiresAt) <= current.getTime() || !state.owners.some((entry) => entry.id === config.setupOwnerId) || state.passkeys.some((entry) => entry.ownerId === config.setupOwnerId && !entry.revokedAt)) throw httpError(401, "Owner setup is unavailable, expired, or already used.");
}

function requireActiveIntent(state: AccessRegistryState, intent: AuthIntent, current: Date): number {
  const index = state.authChallenges.findIndex((entry) => entry.id === intent.id && entry.purpose === "intent" && entry.browserHash === intent.browserHash && entry.rootOrigin === intent.rootOrigin && entry.data.mode === intent.mode && Date.parse(entry.expiresAt) > current.getTime());
  if (index < 0) throw httpError(401, "Sign-in request expired or was already completed. Start again from your board.");
  return index;
}

function activeSessionInState(state: AccessRegistryState, sessionId: string, current: Date): { session: AuthSession; owner: AccessOwner } | null {
  const session = state.authSessions.find((entry) => entry.id === sessionId && !entry.revokedAt && Date.parse(entry.expiresAt) > current.getTime());
  if (!session) return null;
  const owner = state.owners.find((entry) => entry.id === session.ownerId);
  if (!owner || state.revokedSessions.some((entry) => entry.sessionId === session.id && (entry.providerSubject === owner.id || entry.providerSubject === owner.providerSubject))) return null;
  return { session, owner };
}

function requireOwnerSession(state: AccessRegistryState, ownerId: string | null, sessionId: string | null, rootOrigin: string, current: Date, fresh: boolean): AuthSession {
  const active = sessionId && activeSessionInState(state, sessionId, current);
  if (!active || active.owner.id !== ownerId || active.session.rootOrigin !== rootOrigin) throw httpError(401, "Sign in again to manage access.");
  if (fresh && current.getTime() - Date.parse(active.session.verifiedAt) > FRESH_VERIFICATION_MS) throw httpError(403, "Verify your current passkey before adding another.");
  return active.session;
}

async function checkRateLimit(store: AccessStore, req: Request, intent: AuthIntent, config: PasskeyAuthConfig, current: Date, phase: string): Promise<void> {
  const limits = [
    { id: hashSecret(`${config.sessionSecret}:ip:${authenticationClientIp(req)}:${phase}`), max: 100 },
    { id: hashSecret(`${intent.browserHash}:${phase}`), max: 20 },
    ...(intent.ownerId ? [{ id: hashSecret(`${intent.ownerId}:${phase}`), max: 30 }] : [])
  ];
  const limited = await store.authTransaction((state) => {
    state.authRateLimits = state.authRateLimits.filter((entry) => Date.parse(entry.resetAt) > current.getTime());
    let denied = false;
    for (const limit of limits) {
      let counter = state.authRateLimits.find((entry) => entry.id === limit.id);
      if (!counter) {
        counter = { id: limit.id, count: 0, resetAt: new Date(current.getTime() + 15 * 60 * 1_000).toISOString() };
        state.authRateLimits.push(counter);
      }
      counter.count += 1;
      if (counter.count > limit.max) denied = true;
    }
    return denied;
  });
  if (limited) throw httpError(429, "Too many sign-in attempts. Please try again in fifteen minutes.");
}

function requireAuthOrigin(req: Request, config: PasskeyAuthConfig): void {
  if (req.get("origin") !== config.authOrigin) throw httpError(403, "Passkey requests must come from the authentication page.");
}
function checkedOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Authentication origins must be valid HTTP(S) origins."); }
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))))) throw new Error("Authentication origins must use HTTPS (or local development HTTP) with no path.");
  return url;
}
function originForHost(host: string): string {
  if (!host || host.includes("/") || host.includes("@") || host.includes("?")) throw new Error("Authentication host must be a hostname with an optional port.");
  const hostname = new URL(`https://${host}`).hostname;
  return `${hostname === "localhost" || hostname.endsWith(".localhost") ? "http" : "https"}://${host}`;
}
function isMode(value: unknown): value is PasskeyMode { return typeof value === "string" && MODES.has(value as PasskeyMode); }
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw httpError(400, `${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function optionalText(value: unknown, label: string, max: number): string | null { return value === undefined || value === null || value === "" ? null : text(value, label, max); }
function secret(value: unknown, label: string): string {
  const result = text(value, label, 512);
  if (result.length < 24) throw httpError(400, `${label} is invalid.`);
  return result;
}
function slug(value: unknown): string {
  const result = text(value, "Workspace address", 48).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result) || RESERVED_SLUGS.has(result)) throw httpError(400, "Choose an available Workspace address using letters, numbers, and hyphens.");
  return result;
}
function httpError(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }); }
function cookieName(kind: "intent" | "browser", config: PasskeyAuthConfig): string { return `${config.authOrigin.startsWith("https:") ? "__Host-" : ""}kanban_auth_${kind}`; }
function plainCookie(name: string, value: string, config: PasskeyAuthConfig, ttl: number): string { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${config.authOrigin.startsWith("https:") ? "; Secure" : ""}`; }
function signedCookie(name: string, value: unknown, config: PasskeyAuthConfig, ttl: number): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return plainCookie(name, `${payload}.${signature}`, config, ttl);
}
function readCookie(req: Pick<Request, "headers">, name: string): string | null {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
function readSignedCookie(req: Pick<Request, "headers">, name: string, signingSecret: string): Record<string, unknown> | null {
  const value = readCookie(req, name);
  if (!value || value.length > 4_096) return null;
  const pieces = value.split(".");
  if (pieces.length !== 2) return null;
  const signature = crypto.createHmac("sha256", signingSecret).update(pieces[0]).digest();
  const received = Buffer.from(pieces[1], "base64url");
  if (signature.length !== received.length || !crypto.timingSafeEqual(signature, received)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : null;
  } catch { return null; }
}
