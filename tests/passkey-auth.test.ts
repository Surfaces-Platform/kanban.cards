import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type ErrorRequestHandler, type Request } from "express";

import { createFileAccessStore } from "../src/access-store";
import { activeOwnerSession, authenticationClientIp, createPasskeyRouter, getPasskeyConfig, hashSecret, readAuthIntent, validatePasskeyAuthConfig, type PasskeyAuthConfig, type PasskeyMode, type PasskeyRouterOptions } from "../src/passkey-auth";

const config = getPasskeyConfig({ SESSION_SECRET: "a-development-secret-with-at-least-32-bytes" });
const AUTH_ORIGIN = config.authOrigin;
const ROOT_ORIGIN = config.rootOrigins[0];

function fakeAuthenticator(): NonNullable<PasskeyRouterOptions["webauthn"]> {
  return {
    generateRegistrationOptions: async (options) => {
      assert.equal(options.authenticatorSelection?.residentKey, "required");
      assert.equal(options.authenticatorSelection?.userVerification, "required");
      assert.equal(options.rpID, config.rpId);
      return { challenge: crypto.randomBytes(32).toString("base64url") } as never;
    },
    generateAuthenticationOptions: async (options) => {
      assert.equal(options.userVerification, "required");
      return { challenge: crypto.randomBytes(32).toString("base64url") } as never;
    },
    verifyRegistrationResponse: async (options) => {
      assert.equal(options.requireUserVerification, true);
      assert.equal(options.expectedRPID, config.rpId);
      assert.equal(options.expectedOrigin, AUTH_ORIGIN);
      const response = options.response as unknown as { id: string; testChallenge: string };
      if (response.testChallenge !== options.expectedChallenge) throw new Error("Wrong challenge");
      return { verified: true, registrationInfo: { credential: { id: response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0, transports: ["internal"] } } } as never;
    },
    verifyAuthenticationResponse: async (options) => {
      assert.equal(options.requireUserVerification, true);
      assert.equal(options.expectedOrigin, AUTH_ORIGIN);
      const response = options.response as unknown as { testChallenge: string };
      if (response.testChallenge !== options.expectedChallenge) throw new Error("Wrong challenge");
      return { verified: true, authenticationInfo: { newCounter: options.credential.counter + 1 } } as never;
    }
  };
}

async function harness(overrides: Partial<PasskeyAuthConfig> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-passkey-"));
  const dataPath = path.join(directory, "access.json");
  let clock = new Date("2026-10-09T12:00:00.000Z");
  const store = createFileAccessStore(dataPath, { now: () => clock });
  const actualConfig = { ...config, ...overrides };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/passkeys", createPasskeyRouter({ config: actualConfig, accessStore: store, now: () => clock, webauthn: fakeAuthenticator() }));
  app.use(((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function request(endpoint: string, body: unknown, jar: Map<string, string>, requestOrigin = AUTH_ORIGIN) {
    const response = await fetch(`${origin}/api/passkeys/${endpoint}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") }, body: JSON.stringify(body) });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() as Record<string, any> : {}, response };
  }
  async function begin(mode: PasskeyMode, options: { ownerId?: string; sessionId?: string; jar?: Map<string, string>; rootOrigin?: string } = {}) {
    const jar = options.jar || new Map<string, string>();
    const intentToken = crypto.randomBytes(32).toString("base64url");
    const browserNonce = crypto.randomBytes(32).toString("base64url");
    await store.authTransaction((state) => { state.authChallenges.push({ id: crypto.randomUUID(), challenge: hashSecret(intentToken), browserHash: hashSecret(browserNonce), purpose: "authorize", ownerId: options.ownerId || null, rootOrigin: options.rootOrigin || ROOT_ORIGIN, expiresAt: new Date(clock.getTime() + 300000).toISOString(), data: { mode, ...(options.sessionId ? { sessionId: options.sessionId } : {}) } }); });
    const response = await request("start", { intentToken, browserNonce, rootOrigin: options.rootOrigin || ROOT_ORIGIN }, jar, options.rootOrigin || ROOT_ORIGIN);
    assert.equal(response.status, 303, JSON.stringify(response.body));
    return { jar, intentToken, browserNonce };
  }
  async function enroll(mode: PasskeyMode, body: Record<string, unknown>, keyId = crypto.randomBytes(16).toString("base64url"), existingJar?: Map<string, string>) {
    const { jar } = existingJar ? { jar: existingJar } : await begin(mode);
    const options = await request("options", body, jar);
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const verified = await request("verify", { challengeId: options.body.challengeId, response: { id: keyId, testChallenge: options.body.options.challenge } }, jar);
    return { jar, keyId, options, verified };
  }
  return { store, request, begin, enroll, dataPath, config: actualConfig, time: () => clock, setTime: (date: Date) => { clock = date; }, async close() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("passkey configuration requires a strong session secret, exact auth RP, and complete setup configuration", () => {
  assert.throws(() => getPasskeyConfig({}), /SESSION_SECRET/);
  assert.equal(getPasskeyConfig({ SESSION_SECRET: config.sessionSecret }).rpId, "auth.kanban.cards");
  assert.deepEqual(getPasskeyConfig({ SESSION_SECRET: config.sessionSecret, KANBAN_CARDS_CANDIDATE_ROOT_HOST: "candidate.kanban.cards" }).rootOrigins, [ROOT_ORIGIN, "https://candidate.kanban.cards"]);
  assert.throws(() => validatePasskeyAuthConfig({ ...config, rpId: "kanban.cards" }), /exact auth host/);
  assert.throws(() => validatePasskeyAuthConfig({ ...config, authOrigin: "https://auth.kanban.cards/path" }), /no path/);
  assert.throws(() => validatePasskeyAuthConfig({ ...config, rootOrigins: ["http://kanban.cards"] }), /HTTPS/);
  assert.throws(() => validatePasskeyAuthConfig({ ...config, setupOwnerId: "owner-mike" }), /together/);
  assert.throws(() => validatePasskeyAuthConfig({ ...config, setupOwnerId: "owner-mike", setupTokenHash: "a-plain-secret", setupExpiresAt: new Date().toISOString() }), /SHA-256/);
});

test("client rate limits trust only a single Vercel client IP when running on Vercel", () => {
  const request = (headers: Request["headers"]) => ({ headers, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } } as Pick<Request, "headers" | "ip" | "socket">);
  assert.equal(authenticationClientIp(request({ "x-vercel-forwarded-for": "198.51.100.12" }), true), "198.51.100.12");
  assert.equal(authenticationClientIp(request({ "x-vercel-forwarded-for": "2001:db8::123" }), true), "2001:db8::123");
  assert.equal(authenticationClientIp(request({ "x-vercel-forwarded-for": "198.51.100.12, 198.51.100.13" }), true), "127.0.0.1");
  assert.equal(authenticationClientIp(request({ "x-vercel-forwarded-for": "198.51.100.12" }), false), "127.0.0.1");
  assert.equal(authenticationClientIp(request({ "x-forwarded-for": "198.51.100.12" }), true), "127.0.0.1");
});

test("browser sessions default to 365 days and reject lifetimes outside one minute to one year", () => {
  assert.equal(config.sessionTtlSeconds, 31_536_000);
  assert.doesNotThrow(() => validatePasskeyAuthConfig({ ...config, sessionTtlSeconds: 60 }));
  assert.doesNotThrow(() => validatePasskeyAuthConfig({ ...config, sessionTtlSeconds: 31_536_000 }));
  for (const sessionTtlSeconds of [59, 31_536_001, 60.5, NaN, Infinity]) {
    assert.throws(() => validatePasskeyAuthConfig({ ...config, sessionTtlSeconds }), /between one minute and 365 days/);
  }
});

test("a one-year session survives day 364, keeps its original expiry after verification, and ends at day 365", async () => {
  const h = await harness();
  try {
    const signup = await h.enroll("signup", { workspaceName: "Studio", workspaceSlug: "studio" });
    assert.equal(signup.verified.status, 200);
    const session = (await h.store.read()).authSessions[0];
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), 31_536_000_000);
    h.setTime(new Date(Date.parse(session.createdAt) + 364 * 24 * 60 * 60 * 1000));
    assert.ok(await activeOwnerSession(h.store, session.id, h.time()));
    const verification = await h.begin("verify", { ownerId: session.ownerId, sessionId: session.id });
    const options = await h.request("options", {}, verification.jar);
    assert.equal(options.status, 200);
    const verified = await h.request("verify", { challengeId: options.body.challengeId, response: { id: signup.keyId, testChallenge: options.body.options.challenge } }, verification.jar);
    assert.equal(verified.status, 200);
    const refreshed = (await h.store.read()).authSessions.find(entry => entry.id === session.id)!;
    assert.equal(refreshed.verifiedAt, h.time().toISOString());
    assert.equal(refreshed.expiresAt, session.expiresAt);
    h.setTime(new Date(Date.parse(session.expiresAt) - 1));
    assert.ok(await activeOwnerSession(h.store, session.id, h.time()));
    h.setTime(new Date(session.expiresAt));
    assert.equal(await activeOwnerSession(h.store, session.id, h.time()), null);
  } finally { await h.close(); }
});

test("signup creates an isolated owner only after verification and persists only recovery/handoff hashes", async () => {
  const h = await harness();
  try {
    const original = await h.store.bindLegacyWorkspace({ providerSubject: "user_mike", email: "mike@example.com", displayName: "Mike", slug: "mike", name: "Mike" });
    const { jar } = await h.begin("signup");
    const options = await h.request("options", { workspaceName: "Studio", workspaceSlug: "studio", displayName: "A new owner", ownerId: original.ownerIds[0] }, jar);
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal((await h.store.read()).owners.length, 1);
    const verified = await h.request("verify", { challengeId: options.body.challengeId, response: { id: "c3R1ZGlvLWtleQ", testChallenge: options.body.options.challenge } }, jar);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.destination, `${ROOT_ORIGIN}/api/auth-handoff`);
    const state = await h.store.read();
    assert.equal(state.owners.length, 2);
    const studio = state.workspaces.find((workspace) => workspace.slug === "studio")!;
    assert.notEqual(studio.ownerIds[0], original.ownerIds[0]);
    assert.notEqual(studio.storageId, original.storageId);
    assert.equal(state.passkeys[0].ownerId, studio.ownerIds[0]);
    assert.ok(await activeOwnerSession(h.store, state.authSessions[0].id, h.time()));
    const stored = await fs.readFile(h.dataPath, "utf8");
    assert.equal(stored.includes(verified.body.recoveryCode), false);
    assert.equal(stored.includes(verified.body.handoffToken), false);
    assert.equal(state.recoveryCodes[0].codeHash, hashSecret(verified.body.recoveryCode));
    assert.equal(state.authHandoffs[0].tokenHash, hashSecret(verified.body.handoffToken));
  } finally { await h.close(); }
});

test("auth starts and ceremonies reject cross-origin, changed mode, altered browser, expiry, and replay", async () => {
  const h = await harness();
  try {
    const { jar, intentToken, browserNonce } = await h.begin("signup");
    const replayStart = await h.request("start", { intentToken, browserNonce, rootOrigin: ROOT_ORIGIN }, jar, ROOT_ORIGIN);
    assert.equal(replayStart.status, 401);
    const noOrigin = await h.request("options", { workspaceName: "Studio", workspaceSlug: "studio" }, jar, "https://evil.example");
    assert.equal(noOrigin.status, 403);
    const changedMode = await h.request("options", { mode: "setup" }, jar);
    assert.equal(changedMode.status, 403);
    const options = await h.request("options", { workspaceName: "Studio", workspaceSlug: "studio" }, jar);
    const request = { challengeId: options.body.challengeId, response: { id: "Y2hhbGxlbmdlLWtleQ", testChallenge: options.body.options.challenge } };
    const altered = new Map(jar);
    altered.set("__Host-kanban_auth_browser", crypto.randomBytes(32).toString("base64url"));
    assert.equal((await h.request("verify", request, altered)).status, 401);
    assert.equal((await h.request("verify", request, jar)).status, 200);
    assert.equal((await h.request("verify", request, jar)).status, 401);
    const expired = await h.begin("signup");
    const expires = await h.request("options", { workspaceName: "Expired", workspaceSlug: "expired" }, expired.jar);
    h.setTime(new Date(h.time().getTime() + 301000));
    assert.equal((await h.request("verify", { challengeId: expires.body.challengeId, response: { id: "ZXhwaXJlZC1rZXk", testChallenge: expires.body.options.challenge } }, expired.jar)).status, 401);
    assert.equal((await h.store.read()).owners.length, 1);
  } finally { await h.close(); }
});

test("one signup intent cannot create multiple owners when two ceremonies finish concurrently", async () => {
  const h = await harness();
  try {
    const { jar } = await h.begin("signup");
    const left = await h.request("options", { workspaceName: "Left", workspaceSlug: "left" }, jar);
    const right = await h.request("options", { workspaceName: "Right", workspaceSlug: "right" }, jar);
    const results = await Promise.all([
      h.request("verify", { challengeId: left.body.challengeId, response: { id: "bGVmdC1rZXk", testChallenge: left.body.options.challenge } }, new Map(jar)),
      h.request("verify", { challengeId: right.body.challengeId, response: { id: "cmlnaHQta2V5", testChallenge: right.body.options.challenge } }, new Map(jar))
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
    const state = await h.store.read();
    assert.equal(state.owners.length, 1);
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.authSessions.length, 1);
    assert.equal(state.passkeys.length, 1);
  } finally { await h.close(); }
});

test("one-time setup attaches only to the specified existing owner and rejects concurrent reuse", async () => {
  const setupToken = crypto.randomBytes(32).toString("base64url");
  const ownerId = "owner-existing";
  const h = await harness({ setupOwnerId: ownerId, setupTokenHash: hashSecret(setupToken), setupExpiresAt: "2026-10-09T13:00:00.000Z" });
  try {
    await h.store.authTransaction((state) => { state.owners.push({ id: ownerId, providerSubject: "user_mike", email: "mike@example.com", displayName: "Mike", createdAt: h.time().toISOString(), updatedAt: h.time().toISOString() }); });
    const workspace = await h.store.bindLegacyWorkspace({ providerSubject: ownerId, email: "", displayName: "Mike", slug: "mike", name: "Mike" });
    const a = await h.begin("setup");
    const b = await h.begin("setup");
    assert.equal((await h.request("options", { setupToken: crypto.randomBytes(32).toString("base64url") }, a.jar)).status, 401);
    const left = await h.request("options", { setupToken }, a.jar);
    const right = await h.request("options", { setupToken }, b.jar);
    const results = await Promise.all([
      h.request("verify", { challengeId: left.body.challengeId, response: { id: "c2V0dXAtb25l", testChallenge: left.body.options.challenge } }, a.jar),
      h.request("verify", { challengeId: right.body.challengeId, response: { id: "c2V0dXAtdHdv", testChallenge: right.body.options.challenge } }, b.jar)
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
    const state = await h.store.read();
    assert.equal(state.setupConsumed, true);
    assert.equal(state.owners.length, 1);
    assert.equal(state.owners[0].email, "mike@example.com");
    assert.equal(state.workspaces[0].id, workspace.id);
    assert.equal(state.passkeys[0].ownerId, ownerId);
  } finally { await h.close(); }
});

test("recovery only changes access after replacement verifies and then revokes old credentials atomically", async () => {
  const h = await harness();
  try {
    const signup = await h.enroll("signup", { workspaceName: "Studio", workspaceSlug: "studio" });
    assert.equal(signup.verified.status, 200);
    const before = await h.store.read();
    const oldSession = before.authSessions[0];
    const owner = before.owners[0];
    await h.store.authTransaction(state => { state.nativeSessions.push({ id: "native-session-recovery-test", ownerId: owner.id, credentialHash: hashSecret("native-recovery-test-credential"), rootOrigin: ROOT_ORIGIN, createdAt: h.time().toISOString(), expiresAt: new Date(h.time().getTime() + 60_000).toISOString(), revokedAt: null }); });
    const agent = await h.store.createAgentConnection({ providerSubject: owner.id, workspaceId: before.workspaces[0].id, label: "Bot", scopes: ["read"] });
    const { jar } = await h.begin("recover");
    const options = await h.request("options", { recoveryCode: signup.verified.body.recoveryCode }, jar);
    const failed = await h.request("verify", { challengeId: options.body.challengeId, response: { id: "cmVwbGFjZW1lbnQ", testChallenge: "wrong-challenge" } }, jar);
    assert.equal(failed.status, 401);
    assert.equal((await h.store.read()).passkeys[0].revokedAt, null);
    assert.ok(await activeOwnerSession(h.store, oldSession.id, h.time()));
    assert.equal((await h.store.read()).nativeSessions[0].revokedAt, null);
    const recovered = await h.enroll("recover", { recoveryCode: signup.verified.body.recoveryCode }, "cmVwbGFjZW1lbnQ", jar);
    assert.equal(recovered.verified.status, 200, JSON.stringify(recovered.verified.body));
    const state = await h.store.read();
    assert.notEqual(recovered.verified.body.recoveryCode, signup.verified.body.recoveryCode);
    assert.ok(state.passkeys.find((key) => key.id === signup.keyId)?.revokedAt);
    assert.equal(state.passkeys.find((key) => key.id === "cmVwbGFjZW1lbnQ")?.revokedAt, null);
    assert.equal(await activeOwnerSession(h.store, oldSession.id, h.time()), null);
    assert.ok(state.nativeSessions[0].revokedAt);
    assert.ok(state.authHandoffs.find((handoff) => handoff.sessionId === oldSession.id)?.consumedAt);
    await assert.rejects(h.store.verifyAgentCredential(agent.credential), /revoked/);
    const retry = await h.begin("recover");
    assert.equal((await h.request("options", { recoveryCode: signup.verified.body.recoveryCode }, retry.jar)).status, 401);
    assert.equal(state.workspaces[0].id, before.workspaces[0].id);
  } finally { await h.close(); }
});

test("signin checks the credential owner handle and existing-owner verification cannot use another owner's key", async () => {
  const h = await harness();
  try {
    const first = await h.enroll("signup", { workspaceName: "First", workspaceSlug: "first" });
    const second = await h.enroll("signup", { workspaceName: "Second", workspaceSlug: "second" });
    let state = await h.store.read();
    const firstOwner = state.passkeys.find((key) => key.id === first.keyId)!.ownerId;
    const secondOwner = state.passkeys.find((key) => key.id === second.keyId)!.ownerId;
    const firstSession = state.authSessions.find((session) => session.ownerId === firstOwner)!;
    const signin = await h.begin("signin");
    const options = await h.request("options", {}, signin.jar);
    assert.equal((await h.request("verify", { challengeId: options.body.challengeId, response: { id: first.keyId, testChallenge: options.body.options.challenge, response: { userHandle: Buffer.from(secondOwner).toString("base64url") } } }, signin.jar)).status, 401);
    const correctOptions = await h.request("options", {}, signin.jar);
    assert.equal((await h.request("verify", { challengeId: correctOptions.body.challengeId, response: { id: first.keyId, testChallenge: correctOptions.body.options.challenge, response: { userHandle: Buffer.from(firstOwner).toString("base64url") } } }, signin.jar)).status, 200);
    const verification = await h.begin("verify", { ownerId: firstOwner, sessionId: firstSession.id });
    const verifyOptions = await h.request("options", {}, verification.jar);
    assert.equal((await h.request("verify", { challengeId: verifyOptions.body.challengeId, response: { id: second.keyId, testChallenge: verifyOptions.body.options.challenge, response: { userHandle: Buffer.from(secondOwner).toString("base64url") } } }, verification.jar)).status, 401);
    state = await h.store.read();
    assert.equal(state.passkeys.find((key) => key.id === second.keyId)!.counter, 0);
  } finally { await h.close(); }
});

test("adding a passkey requires a fresh, active owner session and signed intents cannot be tampered with", async () => {
  const h = await harness();
  try {
    const signup = await h.enroll("signup", { workspaceName: "Studio", workspaceSlug: "studio" });
    const state = await h.store.read();
    const session = state.authSessions[0];
    const started = await h.begin("add", { ownerId: session.ownerId, sessionId: session.id });
    const headers = { cookie: [...started.jar].map(([name, value]) => `${name}=${value}`).join("; ") };
    assert.equal(readAuthIntent({ headers }, h.config, h.time())?.mode, "add");
    assert.equal(readAuthIntent({ headers: { cookie: headers.cookie.replace(/kanban_auth_intent=./, "kanban_auth_intent=x") } }, h.config, h.time()), null);
    h.setTime(new Date(h.time().getTime() + 301000));
    assert.equal((await h.request("options", {}, started.jar)).status, 403);
    assert.equal((await h.store.read()).passkeys.length, 1);
    assert.equal(signup.verified.status, 200);
  } finally { await h.close(); }
});
