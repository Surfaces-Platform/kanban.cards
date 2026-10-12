import crypto from "node:crypto";
import express, { type Request } from "express";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import type { AccessOwner, AccessStore, NativeOwnerSession } from "./access-store";
import { authenticationClientIp, hashSecret, validatePasskeyConfig, type PasskeyAuthConfig } from "./passkey-auth";

export const NATIVE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const NATIVE_CREDENTIAL = /^kcn_[A-Za-z0-9_-]{43}$/;
type NativeWebAuthn = Pick<typeof import("@simplewebauthn/server"), "generateAuthenticationOptions" | "verifyAuthenticationResponse">;

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
    if (!req.is("application/json")) throw httpError(415, "Native authentication requires JSON.");
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
      state.nativeSessions.push({ id: `native-session-${crypto.randomUUID()}`, credentialHash: hashSecret(token), ownerId, rootOrigin: config.rootOrigins[0], createdAt: completedAt.toISOString(), expiresAt, revokedAt: null });
      return owner;
    });
    res.json({ authenticated: true, tokenType: "Bearer", token, expiresAt, rootUrl: config.rootOrigins[0], owner: { id: owner.id, displayName: owner.displayName, email: owner.email } });
  });
  return router;
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
  if (!/^[A-Za-z0-9_-]+$/.test(text) || Buffer.from(text, "base64url").toString("base64url") !== text) throw new Error("Invalid base64url");
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
async function rateLimit(store: AccessStore, req: Request, config: PasskeyAuthConfig, current: Date, phase: string): Promise<void> {
  const id = hashSecret(`${config.sessionSecret}:native:${phase}:${authenticationClientIp(req)}`);
  const limited = await store.authTransaction(state => {
    state.authRateLimits = state.authRateLimits.filter(r => Date.parse(r.resetAt) > current.getTime());
    let limit = state.authRateLimits.find(r => r.id === id);
    if (!limit) { limit = { id, count: 0, resetAt: new Date(current.getTime() + 15 * 60_000).toISOString() }; state.authRateLimits.push(limit); }
    limit.count++;
    return limit.count > 100;
  });
  if (limited) throw httpError(429, "Too many sign-in attempts. Try again in fifteen minutes.");
}
function httpError(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }); }
