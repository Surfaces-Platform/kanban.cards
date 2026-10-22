import crypto from "node:crypto";
import express, { type Request } from "express";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { AccessStoreError, issueAgentConnectionInRegistry, type AccessOwner, type AccessRegistryState, type AccessStore, type AgentConnection, type NativeOwnerSession } from "./access-store";
import { authenticationClientIp, hashSecret, validatePasskeyConfig, type PasskeyAuthConfig } from "./passkey-auth";

export const NATIVE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const NATIVE_CREDENTIAL = /^kcn_[A-Za-z0-9_-]{43}$/;
type NativeWebAuthn = Pick<typeof import("@simplewebauthn/server"), "generateAuthenticationOptions" | "verifyAuthenticationResponse" | "generateRegistrationOptions" | "verifyRegistrationResponse">;

export interface NativeAuthOptions {
  config: PasskeyAuthConfig;
  accessStore: AccessStore;
  now?: () => Date;
  /** Production always uses SimpleWebAuthn; this seam supplies deterministic test authenticators. */
  webauthn?: NativeWebAuthn;
}

export function isNativeCredential(value: string): boolean { return NATIVE_CREDENTIAL.test(value); }

/** Reject ambient browser authority on native routes, without relaxing cookie CSRF checks. */
export function requireNativeRequest(req: Pick<Request, "headers">): void {
  if (req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers["sec-fetch-site"] !== undefined) throw httpError(403, "Native requests cannot use browser cookies or origins.");
}

export async function authorizeNativeCredential(accessStore: AccessStore, credential: string, rootOrigin: string, workspaceId: string | null, now = new Date()): Promise<{ session: NativeOwnerSession; owner: AccessOwner } | null> {
  if (!isNativeCredential(credential)) return null;
  const state = await accessStore.read();
  const session = state.nativeSessions.find(s => s.credentialHash === hashSecret(credential) && s.rootOrigin === rootOrigin && !s.revokedAt && Date.parse(s.createdAt) <= now.getTime() && Date.parse(s.expiresAt) > now.getTime());
  const owner = session && state.owners.find(o => o.id === session.ownerId);
  if (!session || !owner || state.revokedSessions.some(s => s.sessionId === session.id && (s.providerSubject === owner.id || s.providerSubject === owner.providerSubject))) return null;
  if (workspaceId && !state.workspaces.some(w => w.id === workspaceId && w.ownerIds.includes(owner.id))) return null;
  return { session, owner };
}

export function createNativeAuthRouter({ config, accessStore, now = () => new Date(), webauthn }: NativeAuthOptions): express.Router {
  validatePasskeyConfig(config);
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    requireNativeRequest(req);
    if (req.method === "POST" && !req.is("application/json")) throw httpError(415, "Native authentication requires JSON.");
    next();
  });

  router.post("/challenge", async (req, res) => {
    const body = record(req.body);
    if (Object.keys(body).length) throw httpError(400, "Native sign-in does not accept account or Workspace selectors.");
    const current = now();
    await rateLimit(accessStore, req, config, current, "challenge");
    const library = webauthn || await import("@simplewebauthn/server");
    const options = await library.generateAuthenticationOptions({ rpID: config.rpId, userVerification: "required" });
    const challengeId = crypto.randomUUID();
    const ceremonyToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(current.getTime() + CHALLENGE_TTL_MS).toISOString();
    await accessStore.authTransaction(state => {
      state.authChallenges = state.authChallenges.filter(c => Date.parse(c.expiresAt) > current.getTime());
      state.authChallenges.push({ id: challengeId, challenge: options.challenge, browserHash: hashSecret(ceremonyToken), purpose: "native-signin", ownerId: null, rootOrigin: config.rootOrigins[0], expiresAt, data: {} });
    });
    res.json({ challengeId, ceremonyToken, relyingPartyIdentifier: config.rpId, challenge: options.challenge, expiresAt });
  });

  router.post("/verify", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "verify");
    const body = record(req.body);
    const challengeId = scalar(body.challengeId, 100);
    const ceremonyToken = scalar(body.ceremonyToken, 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ceremonyToken)) throw httpError(400, "Native sign-in request is invalid.");
    const challenge = await accessStore.authTransaction(state => {
      const index = state.authChallenges.findIndex(c => c.id === challengeId && c.purpose === "native-signin" && c.browserHash === hashSecret(ceremonyToken) && c.rootOrigin === config.rootOrigins[0] && Date.parse(c.expiresAt) > current.getTime());
      if (index < 0) throw httpError(401, "Native passkey challenge expired or was already used.");
      return state.authChallenges.splice(index, 1)[0];
    });
    let credentialId: string;
    let ownerId: string;
    let expectedCounter: number;
    let newCounter: number;
    try {
      const response = assertion(body.response);
      const state = await accessStore.read();
      const key = state.passkeys.find(k => k.id === response.id && !k.revokedAt);
      if (!key || response.response.userHandle !== Buffer.from(key.ownerId, "utf8").toString("base64url")) throw new Error("Owner mismatch");
      // Apple supplies https:// + RP ID in rawClientDataJSON for native requests.
      // https://developer.apple.com/forums/thread/719003 (Apple Systems Engineer)
      // Forward the original bytes to SimpleWebAuthn; never rewrite client data.
      const clientData = record(JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")));
      const expectedOrigin = `https://${config.rpId}`;
      if (clientData.origin !== expectedOrigin || clientData.type !== "webauthn.get" || clientData.challenge !== challenge.challenge || (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) || clientData.topOrigin !== undefined) throw new Error("Client data mismatch");
      const library = webauthn || await import("@simplewebauthn/server");
      const verified = await library.verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin, expectedRPID: config.rpId, requireUserVerification: true, credential: { id: key.id, publicKey: Uint8Array.from(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: key.transports as never[] } });
      if (!verified.verified) throw new Error("Assertion not verified");
      credentialId = key.id;
      ownerId = key.ownerId;
      expectedCounter = key.counter;
      newCounter = verified.authenticationInfo.newCounter;
    } catch {
      throw httpError(401, "Passkey could not be verified. Start sign-in again.");
    }
    const token = `kcn_${crypto.randomBytes(32).toString("base64url")}`;
    const completedAt = now();
    const expiresAt = new Date(completedAt.getTime() + NATIVE_SESSION_TTL_SECONDS * 1_000).toISOString();
    const owner = await accessStore.authTransaction(state => {
      const key = state.passkeys.find(k => k.id === credentialId && k.ownerId === ownerId && !k.revokedAt && k.counter === expectedCounter);
      const owner = state.owners.find(o => o.id === ownerId);
      if (!key || !owner || Date.parse(challenge.expiresAt) <= completedAt.getTime()) throw httpError(401, "Passkey changed or expired. Start sign-in again.");
      key.counter = newCounter;
      key.lastUsedAt = completedAt.toISOString();
      state.nativeSessions.push({ id: `native-session-${crypto.randomUUID()}`, credentialHash: hashSecret(token), ownerId, rootOrigin: config.rootOrigins[0], createdAt: completedAt.toISOString(), verifiedAt: completedAt.toISOString(), expiresAt, revokedAt: null });
      return owner;
    });
    res.json({ authenticated: true, tokenType: "Bearer", token, expiresAt, rootUrl: config.rootOrigins[0], owner: { id: owner.id, displayName: owner.displayName, email: owner.email } });
  });
  router.post("/registration/challenge", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "registration-challenge", 20);
    const body = exactBody(req.body, ["displayName", "email"]);
    const displayName = ownerText(body.displayName, 80);
    const email = body.email == null ? "" : ownerText(body.email, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Enter a valid email address.");
    const ownerId = `owner-${crypto.randomUUID()}`;
    const userName = email || displayName;
    const library = webauthn || await import("@simplewebauthn/server");
    const options = await library.generateRegistrationOptions({ rpName: "kanban.cards", rpID: config.rpId,
      userID: Uint8Array.from(Buffer.from(ownerId)), userName, userDisplayName: displayName, attestationType: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" } });
    const challengeId = crypto.randomUUID();
    const ceremonyToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(current.getTime() + CHALLENGE_TTL_MS).toISOString();
    await accessStore.authTransaction(state => {
      state.authChallenges = state.authChallenges.filter(value => Date.parse(value.expiresAt) > current.getTime());
      state.authChallenges.push({ id: challengeId, challenge: options.challenge, browserHash: hashSecret(ceremonyToken),
        purpose: "native-signup", ownerId: null, rootOrigin: config.rootOrigins[0], expiresAt, data: { ownerId, displayName, email } });
    });
    res.json({ challengeId, ceremonyToken, relyingPartyIdentifier: config.rpId, challenge: options.challenge,
      userId: Buffer.from(ownerId).toString("base64url"), userName, expiresAt });
  });

  router.post("/registration/verify", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "registration-verify");
    const body = exactBody(req.body, ["challengeId", "ceremonyToken", "credential"]);
    const challengeId = scalar(body.challengeId, 100);
    const ceremonyToken = base64url(body.ceremonyToken, 43);
    if (ceremonyToken.length !== 43) throw httpError(400, "Registration request is invalid.");
    const response = registration(body.credential);
    const requestHash = hashSecret(JSON.stringify(response));
    const state = await accessStore.read();
    const challenge = state.authChallenges.find(value => value.id === challengeId &&
      ["native-signup", "native-signup-complete"].includes(value.purpose) && value.browserHash === hashSecret(ceremonyToken) &&
      value.rootOrigin === config.rootOrigins[0] && Date.parse(value.expiresAt) > current.getTime());
    if (!challenge) throw httpError(401, "Registration challenge expired. Start again.");
    const token = `kcn_${deriveSecret(config, "native-signup", `${challengeId}:${ceremonyToken}`)}`;
    if (challenge.purpose === "native-signup-complete") {
      const restored = registrationReceipt(state, challenge.data, requestHash, token, config.rootOrigins[0], current);
      res.json(sessionResponse(restored.owner, token, restored.session.expiresAt, config));
      return;
    }
    let verifiedKey: { id: string; publicKey: string; counter: number; transports: string[] };
    try {
      verifyClientData(response.response.clientDataJSON, challenge.challenge, config.rpId, "webauthn.create");
      if (response.clientExtensionResults.credProps?.rk === false) throw new Error("Resident passkey required");
      const library = webauthn || await import("@simplewebauthn/server");
      const result = await library.verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: `https://${config.rpId}`, expectedRPID: config.rpId, requireUserVerification: true, requireUserPresence: true });
      if (!result.verified || !result.registrationInfo) throw new Error("Registration not verified");
      const key = result.registrationInfo.credential;
      verifiedKey = { id: key.id, publicKey: Buffer.from(key.publicKey).toString("base64url"), counter: key.counter, transports: key.transports || [] };
    } catch { throw httpError(401, "Passkey registration could not be verified. Try again."); }
    const completedAt = now();
    const receipt = await accessStore.authTransaction(registry => {
      const stored = registry.authChallenges.find(value => value.id === challenge.id && value.browserHash === hashSecret(ceremonyToken));
      if (!stored || Date.parse(stored.expiresAt) <= completedAt.getTime()) throw httpError(401, "Registration expired. Start again.");
      if (stored.purpose === "native-signup-complete") return registrationReceipt(registry, stored.data, requestHash, token, config.rootOrigins[0], completedAt);
      if (stored.purpose !== "native-signup" || registry.passkeys.some(key => key.id === verifiedKey.id)) throw httpError(409, "This passkey is already registered.");
      const timestamp = completedAt.toISOString();
      const ownerId = scalar(stored.data.ownerId, 100);
      const owner = { id: ownerId, providerSubject: ownerId, displayName: scalar(stored.data.displayName, 80),
        email: typeof stored.data.email === "string" ? stored.data.email : "", createdAt: timestamp, updatedAt: timestamp };
      const session: NativeOwnerSession = { id: `native-session-${crypto.randomUUID()}`, ownerId, credentialHash: hashSecret(token),
        rootOrigin: config.rootOrigins[0], createdAt: timestamp, verifiedAt: timestamp,
        expiresAt: new Date(completedAt.getTime() + NATIVE_SESSION_TTL_SECONDS * 1_000).toISOString(), revokedAt: null };
      registry.owners.push(owner);
      registry.passkeys.push({ ...verifiedKey, ownerId, createdAt: timestamp, lastUsedAt: null, revokedAt: null });
      registry.nativeSessions.push(session);
      stored.purpose = "native-signup-complete";
      stored.ownerId = ownerId;
      stored.data = { ownerId, sessionId: session.id, requestHash };
      return { owner, session };
    });
    res.json(sessionResponse(receipt.owner, token, receipt.session.expiresAt, config));
  });

  router.post("/agent-pairings", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "pairing-start", 20);
    const body = exactBody(req.body, ["workspaceId", "label"]);
    const workspaceId = scalar(body.workspaceId, 120);
    const label = ownerText(body.label, 80);
    const pairingId = `pairing-${crypto.randomUUID()}`;
    const deviceToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(current.getTime() + PAIRING_TTL_MS).toISOString();
    const userCode = await accessStore.authTransaction(state => {
      state.nativeAgentPairings = state.nativeAgentPairings.filter(value => Date.parse(value.expiresAt) > current.getTime());
      if (state.nativeAgentPairings.length >= 1_000) throw httpError(429, "Pairing is busy. Try again later.");
      let code: string;
      do { code = Array.from(crypto.randomBytes(8), value => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[value % 32]).join(""); }
      while (state.nativeAgentPairings.some(value => value.userCodeHash === hashSecret(code)));
      state.nativeAgentPairings.push({ id: pairingId, deviceTokenHash: hashSecret(deviceToken), userCodeHash: hashSecret(code),
        workspaceId, label, createdAt: current.toISOString(), expiresAt, ownerId: null, connectionId: null, approvedAt: null });
      return `${code.slice(0, 4)}-${code.slice(4)}`;
    });
    res.status(201).json({ pairingId, deviceToken, userCode, expiresAt });
  });

  router.post("/agent-pairings/inspect", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "pairing-inspect");
    const body = exactBody(req.body, ["userCode"]);
    const state = await accessStore.read();
    const identity = nativeIdentity(req, state, config, current);
    const { pairing, workspace } = ownedPairing(state, body.userCode, identity.owner.id, current);
    res.json({ pairingId: pairing.id, workspaceId: workspace.id, workspaceName: workspace.name, label: pairing.label,
      scopes: ["read", "write"], expiresAt: pairing.expiresAt, approved: pairing.approvedAt !== null });
  });

  router.post("/agent-pairings/approve", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "pairing-approve");
    const body = exactBody(req.body, ["userCode"]);
    const connection = await accessStore.authTransaction(state => {
      const identity = nativeIdentity(req, state, config, current, true);
      const { pairing } = ownedPairing(state, body.userCode, identity.owner.id, current);
      if (pairing.connectionId) {
        const connection = state.agentConnections.find(value => value.id === pairing.connectionId && !value.revokedAt);
        if (!connection) throw httpError(409, "This pairing's connection was revoked. Start a new pairing.");
        return connection;
      }
      try {
        const issued = issueAgentConnectionInRegistry(state, { providerSubject: identity.owner.id, workspaceId: pairing.workspaceId,
          label: pairing.label, scopes: ["read", "write"] }, current.toISOString(), deriveSecret(config, "native-pairing", pairing.id));
        pairing.ownerId = identity.owner.id;
        pairing.connectionId = issued.connection.id;
        pairing.approvedAt = current.toISOString();
        return issued.connection;
      } catch (error) {
        if (error instanceof AccessStoreError) throw httpError(error.code === "ACCESS_RATE_LIMITED" ? 429 : 403, error.message);
        throw error;
      }
    });
    res.json({ approved: true, connection: publicConnection(connection) });
  });

  router.post("/agent-pairings/poll", async (req, res) => {
    const current = now();
    await rateLimit(accessStore, req, config, current, "pairing-poll", 600);
    const body = exactBody(req.body, ["pairingId", "deviceToken"]);
    const state = await accessStore.read();
    const pairing = state.nativeAgentPairings.find(value => value.id === scalar(body.pairingId, 120) &&
      safeEqual(value.deviceTokenHash, hashSecret(base64url(body.deviceToken, 43))));
    if (!pairing) throw httpError(401, "Pairing request is invalid.");
    if (Date.parse(pairing.expiresAt) <= current.getTime()) { res.json({ status: "expired", expiresAt: pairing.expiresAt }); return; }
    if (!pairing.connectionId) { res.json({ status: "pending", expiresAt: pairing.expiresAt }); return; }
    const connection = state.agentConnections.find(value => value.id === pairing.connectionId);
    const workspace = state.workspaces.find(value => value.id === pairing.workspaceId && value.ownerIds.includes(pairing.ownerId || ""));
    if (!workspace || !connection || connection.revokedAt || (connection.expiresAt && Date.parse(connection.expiresAt) <= current.getTime())) {
      res.json({ status: "denied", expiresAt: pairing.expiresAt }); return;
    }
    const root = new URL(config.rootOrigins[0]);
    root.hostname = `${workspace.slug}.${root.hostname}`;
    res.json({ status: "approved", connection: publicConnection(connection),
      credential: `kac_${connection.id}_${deriveSecret(config, "native-pairing", pairing.id)}`, apiBaseUrl: `${root.origin}/api` });
  });

  router.get("/agent-connections", async (req, res) => {
    const state = await accessStore.read();
    const { owner } = nativeIdentity(req, state, config, now());
    exactBody(req.query, ["workspaceId"]);
    const workspaceId = scalar(req.query.workspaceId, 120);
    if (!state.workspaces.some(value => value.id === workspaceId && value.ownerIds.includes(owner.id))) throw httpError(404, "Workspace is unavailable.");
    res.json({ connections: state.agentConnections.filter(value => value.workspaceId === workspaceId && value.ownerId === owner.id).map(publicConnection) });
  });

  router.delete("/agent-connections/:connectionId", async (req, res) => {
    const current = now();
    await accessStore.authTransaction(state => {
      const { owner } = nativeIdentity(req, state, config, current);
      exactBody(req.query, ["workspaceId"]);
      const workspaceId = scalar(req.query.workspaceId, 120);
      if (!state.workspaces.some(value => value.id === workspaceId && value.ownerIds.includes(owner.id))) throw httpError(404, "Workspace is unavailable.");
      const connection = state.agentConnections.find(value => value.id === req.params.connectionId && value.workspaceId === workspaceId && value.ownerId === owner.id);
      if (!connection) throw httpError(404, "Connection is unavailable.");
      connection.revokedAt ??= current.toISOString();
    });
    res.json({ revoked: true });
  });
  return router;
}

function exactBody(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw httpError(400, "Unexpected native request field.");
  return body;
}
function ownerText(value: unknown, max: number): string {
  const text = scalar(value, max).trim();
  if (/[\r\n\0]/.test(text)) throw httpError(400, "Use a single-line name.");
  return text;
}
function deriveSecret(config: PasskeyAuthConfig, purpose: string, value: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(`${purpose}\0${value}`).digest("base64url");
}
function publicConnection(connection: AgentConnection) {
  const { id, workspaceId, label, scopes, createdAt, lastUsedAt, expiresAt, revokedAt } = connection;
  return { id, workspaceId, label, scopes, createdAt, lastUsedAt, expiresAt, revokedAt };
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function nativeIdentity(req: Request, state: AccessRegistryState, config: PasskeyAuthConfig, current: Date, fresh = false) {
  const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1] || "";
  if (!isNativeCredential(token)) throw httpError(401, "Native owner sign-in required.");
  const session = state.nativeSessions.find(value => safeEqual(value.credentialHash, hashSecret(token)) && value.rootOrigin === config.rootOrigins[0] &&
    !value.revokedAt && Date.parse(value.createdAt) <= current.getTime() && Date.parse(value.expiresAt) > current.getTime());
  const owner = session && state.owners.find(value => value.id === session.ownerId);
  if (!session || !owner || state.revokedSessions.some(value => value.sessionId === session.id && [owner.id, owner.providerSubject].includes(value.providerSubject))) throw httpError(401, "Native owner sign-in required.");
  const verifiedAt = Date.parse(session.verifiedAt || session.createdAt);
  if (fresh && (verifiedAt > current.getTime() || current.getTime() - verifiedAt > CHALLENGE_TTL_MS)) throw httpError(403, "Fresh passkey verification required.");
  return { owner, session };
}
function ownedPairing(state: AccessRegistryState, code: unknown, ownerId: string, current: Date) {
  const normalized = scalar(code, 20).replace(/[ -]/g, "").toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(normalized)) throw httpError(404, "Pairing is unavailable.");
  const pairing = state.nativeAgentPairings.find(value => safeEqual(value.userCodeHash, hashSecret(normalized)) && Date.parse(value.expiresAt) > current.getTime());
  const workspace = pairing && state.workspaces.find(value => value.id === pairing.workspaceId && value.ownerIds.includes(ownerId));
  if (!pairing || !workspace || (pairing.ownerId && pairing.ownerId !== ownerId)) throw httpError(404, "Pairing is unavailable for this Workspace.");
  return { pairing, workspace };
}
function registrationReceipt(state: AccessRegistryState, data: Record<string, unknown>, requestHash: string, token: string, rootOrigin: string, current: Date) {
  if (data.requestHash !== requestHash) throw httpError(409, "Registration was completed with a different response.");
  const session = state.nativeSessions.find(value => value.id === data.sessionId && value.credentialHash === hashSecret(token) && value.rootOrigin === rootOrigin &&
    !value.revokedAt && Date.parse(value.expiresAt) > current.getTime());
  const owner = session && state.owners.find(value => value.id === session.ownerId);
  if (!owner || !session || state.revokedSessions.some(value => value.sessionId === session.id && [owner.id, owner.providerSubject].includes(value.providerSubject))) throw httpError(401, "Registration session ended. Sign in again.");
  return { owner, session };
}
function sessionResponse(owner: AccessOwner, token: string, expiresAt: string, config: PasskeyAuthConfig) {
  return { authenticated: true, tokenType: "Bearer", token, expiresAt, rootUrl: config.rootOrigins[0], owner: { id: owner.id, displayName: owner.displayName, email: owner.email } };
}
function verifyClientData(encoded: string, challenge: string, rpId: string, type: string) {
  const data = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  if (data.origin !== `https://${rpId}` || data.type !== type || data.challenge !== challenge ||
      (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new Error("Client data mismatch");
}
function registration(value: unknown): RegistrationResponseJSON {
  const object = record(value); const response = record(object.response);
  const id = base64url(object.id, 2048);
  if (object.type !== "public-key" || base64url(object.rawId, 2048) !== id) throw httpError(400, "Registration credential is invalid.");
  const extensions = object.clientExtensionResults === undefined ? {} : record(object.clientExtensionResults);
  const transports = response.transports;
  if (transports !== undefined && (!Array.isArray(transports) || transports.some(value => typeof value !== "string"))) throw httpError(400, "Registration transports are invalid.");
  return { id, rawId: id, type: "public-key", clientExtensionResults: extensions,
    response: { clientDataJSON: base64url(response.clientDataJSON, 16384), attestationObject: base64url(response.attestationObject, 32768),
      ...(Array.isArray(transports) ? { transports: transports as RegistrationResponseJSON["response"]["transports"] } : {}) } };
}

function assertion(value: unknown): AuthenticationResponseJSON {
  const object = record(value);
  const response = record(object.response);
  const id = base64url(object.id, 2048);
  if (object.type !== "public-key" || base64url(object.rawId, 2048) !== id) throw new Error("Credential identifier mismatch");
  return {
    id, rawId: id, type: "public-key", clientExtensionResults: {},
    response: {
      authenticatorData: base64url(response.authenticatorData, 16384),
      clientDataJSON: base64url(response.clientDataJSON, 16384),
      signature: base64url(response.signature, 4096),
      userHandle: base64url(response.userHandle, 1024)
    }
  };
}

function base64url(value: unknown, max: number): string {
  const text = scalar(value, max);
  if (!/^[A-Za-z0-9_-]+$/.test(text) || Buffer.from(text, "base64url").toString("base64url") !== text) throw httpError(400, "Invalid native credential encoding.");
  return text;
}
function scalar(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value.trim() !== value) throw httpError(400, "Native sign-in request is invalid.");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Native sign-in request is invalid.");
  return value as Record<string, unknown>;
}
async function rateLimit(store: AccessStore, req: Request, config: PasskeyAuthConfig, current: Date, phase: string, maximum = 100): Promise<void> {
  const id = hashSecret(`${config.sessionSecret}:native:${phase}:${authenticationClientIp(req)}`);
  const limited = await store.authTransaction(state => {
    state.authRateLimits = state.authRateLimits.filter(r => Date.parse(r.resetAt) > current.getTime());
    let limit = state.authRateLimits.find(r => r.id === id);
    if (!limit) { limit = { id, count: 0, resetAt: new Date(current.getTime() + 15 * 60_000).toISOString() }; state.authRateLimits.push(limit); }
    limit.count++;
    return limit.count > maximum;
  });
  if (limited) throw httpError(429, "Too many sign-in attempts. Try again in fifteen minutes.");
}
function httpError(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }); }
