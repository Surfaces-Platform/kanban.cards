import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";

import {
  ClerkAuthConfigError,
  ClerkIdentityError,
  clerkAuthConfigurationRequested,
  createClerkAuthGateway,
  clerkPrimarySignInUrl,
  clerkPrimarySignUpUrl,
  getClerkAuthConfig,
  validateClerkAuthConfig,
  type ClerkAuthConfig,
  type ClerkAuthGateway
} from "../src/clerk-auth";
import { createApp } from "../src/server";

const CONFIG: ClerkAuthConfig = {
  publishableKey: "pk_test_kanban",
  secretKey: "sk_test_kanban",
  encryptionKey: "clerk-encryption-test-key-with-at-least-32-characters",
  sessionSecret: "clerk-auth-test-secret-with-at-least-32-characters",
  authHost: "auth.kanban.cards",
  allowedUserIds: ["user_mike123"],
  rootSessionTtlSeconds: 3600,
  tenantSessionTtlSeconds: 3600
};

test("Clerk configuration requires exact keys, user IDs, and a separate app-session secret", () => {
  const marketplaceEnv = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: CONFIG.publishableKey,
    CLERK_SECRET_KEY: CONFIG.secretKey,
    CLERK_ENCRYPTION_KEY: CONFIG.encryptionKey,
    SESSION_SECRET: CONFIG.sessionSecret,
    KANBAN_CARDS_AUTH_HOST: CONFIG.authHost,
    KANBAN_CARDS_ALLOWED_CLERK_USER_IDS: "user_mike123,user_mike123,user_teammate456",
    ROOT_SESSION_TTL_SECONDS: "90",
    TENANT_SESSION_TTL_SECONDS: "120"
  };
  assert.deepEqual(getClerkAuthConfig(marketplaceEnv), {
    ...CONFIG,
    allowedUserIds: ["user_mike123", "user_teammate456"],
    rootSessionTtlSeconds: 90,
    tenantSessionTtlSeconds: 120
  });

  const { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: _marketplaceKey, ...sharedEnv } = marketplaceEnv;
  assert.equal(getClerkAuthConfig({ ...sharedEnv, CLERK_PUBLISHABLE_KEY: CONFIG.publishableKey }).publishableKey, CONFIG.publishableKey);
  assert.equal(getClerkAuthConfig({
    ...marketplaceEnv,
    CLERK_PUBLISHABLE_KEY: CONFIG.publishableKey
  }).publishableKey, CONFIG.publishableKey);
  assert.throws(() => getClerkAuthConfig({
    ...marketplaceEnv,
    CLERK_PUBLISHABLE_KEY: "pk_test_different"
  }), /must match when both are set/);
  assert.equal(clerkAuthConfigurationRequested({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: CONFIG.publishableKey }), true);
  assert.throws(
    () => getClerkAuthConfig({ ...marketplaceEnv, VERCEL_ENV: "production" }),
    /pk_live_ and sk_live_/
  );
  assert.equal(getClerkAuthConfig({
    ...marketplaceEnv,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_kanban",
    CLERK_SECRET_KEY: "sk_live_kanban",
    VERCEL_ENV: "production"
  }).publishableKey, "pk_live_kanban");

  for (const change of [
    { publishableKey: "not-clerk" },
    { secretKey: "not-clerk" },
    { encryptionKey: "too-short" },
    { sessionSecret: "too-short" },
    { authHost: "https://auth.kanban.cards" },
    { authHost: "AUTH.kanban.cards" },
    { authHost: "127.0.0.1" },
    { allowedUserIds: [] },
    { allowedUserIds: ["mike@example.com"] },
    { rootSessionTtlSeconds: 0 }
  ]) {
    assert.throws(
      () => validateClerkAuthConfig({ ...CONFIG, ...change } as ClerkAuthConfig),
      ClerkAuthConfigError
    );
  }
});

test("Clerk middleware is limited to exact root origins and reads only verified session tokens", () => {
  let middlewareOptions: Record<string, unknown> | ((req: Request) => Record<string, unknown>) | null = null;
  let signedIn = true;
  const observedProxyHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let middlewareCalls = 0;
  const handler: RequestHandler = (req, _res, next) => {
    middlewareCalls += 1;
    observedProxyHeaders.push({ ...req.headers });
    next();
  };
  const gateway = createClerkAuthGateway(CONFIG, {
    middleware(options) {
      middlewareOptions = options;
      return handler;
    },
    getAuth() {
      return signedIn
        ? { isAuthenticated: true, userId: "user_mike123", sessionId: "sess_mike123" }
        : { isAuthenticated: false, userId: null, sessionId: null };
    },
    client: verifiedClient()
  });

  const directMiddleware = gateway.middleware([
    { origin: "https://auth.kanban.cards", isSatellite: false },
    { origin: "https://kanban.cards", isSatellite: true },
    { origin: "https://candidate.example.com", isSatellite: true }
  ], false);
  const optionsForRequest = middlewareOptions as unknown as (req: Request) => Record<string, unknown>;
  const primary = optionsForRequest(requestWithHost("auth.kanban.cards"));
  const canonical = optionsForRequest(requestWithHost("kanban.cards"));
  const candidate = optionsForRequest(requestWithHost("candidate.example.com"));
  assert.deepEqual(primary.authorizedParties, ["https://auth.kanban.cards"]);
  assert.deepEqual(primary.frontendApiProxy, { enabled: true });
  assert.equal(primary.isSatellite, false);
  assert.equal(primary.signInUrl, clerkPrimarySignInUrl(CONFIG));
  assert.equal(primary.signUpUrl, clerkPrimarySignUpUrl(CONFIG));
  assert.deepEqual(canonical.authorizedParties, ["https://kanban.cards"]);
  assert.deepEqual(candidate.authorizedParties, ["https://candidate.example.com"]);
  assert.deepEqual(canonical.frontendApiProxy, { enabled: true });
  assert.equal(canonical.isSatellite, true);
  assert.equal(canonical.signInUrl, clerkPrimarySignInUrl(CONFIG));
  assert.equal(canonical.signUpUrl, clerkPrimarySignUpUrl(CONFIG));
  assert.equal(candidate.isSatellite, true);
  assert.equal(candidate.satelliteAutoSync, false);
  assert.equal(candidate.signInUrl, clerkPrimarySignInUrl(CONFIG));
  assert.equal(candidate.signUpUrl, clerkPrimarySignUpUrl(CONFIG));

  const spoofedCandidate = optionsForRequest(requestWithHost(
    "kanban.cards",
    "candidate.example.com"
  ));
  assert.deepEqual(spoofedCandidate.authorizedParties, ["https://kanban.cards"]);
  assert.throws(
    () => optionsForRequest(requestWithHost("mike.kanban.cards")),
    /non-root host/
  );

  let tenantNextCalls = 0;
  directMiddleware(
    requestWithHost("mike.kanban.cards", "candidate.example.com"),
    {} as Response,
    () => { tenantNextCalls += 1; }
  );
  assert.equal(tenantNextCalls, 1);
  assert.equal(middlewareCalls, 0, "tenant hosts must bypass Clerk middleware entirely");

  const directProxyRequest = requestWithHost("kanban.cards", "candidate.example.com");
  Object.defineProperty(directProxyRequest, "socket", { value: { remoteAddress: "127.0.0.1" } });
  directProxyRequest.headers["x-forwarded-proto"] = "https";
  directProxyRequest.headers["x-forwarded-for"] = "203.0.113.5";
  directProxyRequest.headers["x-real-ip"] = "203.0.113.5";
  directMiddleware(directProxyRequest, {} as Response, () => undefined);
  assert.equal(middlewareCalls, 1);
  assert.deepEqual(observedProxyHeaders.at(-1), { host: "kanban.cards", "x-forwarded-for": "127.0.0.1" });

  const trustedMiddleware = gateway.middleware([
    { origin: "https://auth.kanban.cards", isSatellite: false },
    { origin: "https://kanban.cards", isSatellite: true },
    { origin: "https://candidate.example.com", isSatellite: true }
  ], true);
  const trustedOptionsForRequest = middlewareOptions as unknown as (req: Request) => Record<string, unknown>;
  const trustedCandidate = trustedOptionsForRequest(requestWithHost(
    "internal.vercel.invalid",
    "candidate.example.com"
  ));
  assert.deepEqual(trustedCandidate.authorizedParties, ["https://candidate.example.com"]);
  assert.deepEqual(trustedCandidate.frontendApiProxy, { enabled: true });
  const trustedProxyRequest = requestWithHost("internal.vercel.invalid", "candidate.example.com");
  trustedProxyRequest.headers["x-forwarded-proto"] = "https";
  trustedMiddleware(trustedProxyRequest, {} as Response, () => undefined);
  assert.equal(observedProxyHeaders.at(-1)?.["x-forwarded-host"], "candidate.example.com");
  assert.equal(observedProxyHeaders.at(-1)?.["x-forwarded-proto"], "https");
  assert.deepEqual(gateway.requestAuth({} as Request), {
    authenticated: true,
    clerkUserId: "user_mike123",
    clerkSessionId: "sess_mike123"
  });
  signedIn = false;
  assert.deepEqual(gateway.requestAuth({} as Request), {
    authenticated: false,
    clerkUserId: null,
    clerkSessionId: null
  });

  assert.throws(() => gateway.middleware([{ origin: "https://auth.kanban.cards/path", isSatellite: false }, { origin: "https://kanban.cards", isSatellite: true }], false), ClerkAuthConfigError);
  assert.throws(() => gateway.middleware([{ origin: "http://auth.kanban.cards", isSatellite: false }, { origin: "https://kanban.cards", isSatellite: true }], false), ClerkAuthConfigError);
  assert.throws(() => gateway.middleware([
    { origin: "https://auth.kanban.cards", isSatellite: false },
    { origin: "https://candidate.example.com", isSatellite: false }
  ], false), ClerkAuthConfigError);
  assert.doesNotThrow(() => createClerkAuthGateway({ ...CONFIG, authHost: "auth.localhost:4317" }, {
    middleware: () => handler,
    getAuth: () => ({ isAuthenticated: false, userId: null, sessionId: null }),
    client: verifiedClient()
  }).middleware([
    { origin: "http://auth.localhost:4317", isSatellite: false },
    { origin: "http://root.localhost:4317", isSatellite: true }
  ], false));
});

test("server routing and Clerk middleware share the same forwarded-host trust policy", () => {
  const observedTrust: boolean[] = [];
  const gateway: ClerkAuthGateway = {
    middleware(_rootOrigins, trustForwardedHost) {
      observedTrust.push(trustForwardedHost);
      return (_req, _res, next) => next();
    },
    requestAuth() {
      return { authenticated: false, clerkUserId: null, clerkSessionId: null };
    },
    async verifiedIdentity() {
      throw new Error("Not used by this wiring test");
    },
    async revokeSession() {}
  };

  for (const trustForwardedHost of [false, true]) {
    createApp({
      candidateHostFamily: null,
      clerkAuthConfig: CONFIG,
      clerkAuthGateway: gateway,
      host: "0.0.0.0",
      requireDatabase: false,
      rootHost: "kanban.cards",
      trustForwardedHost
    });
  }

  assert.deepEqual(observedTrust, [false, true]);
});

test("verified Clerk identity uses the stable user and session IDs, verified primary email, and profile name", async () => {
  const revoked: string[] = [];
  const gateway = createClerkAuthGateway(CONFIG, {
    middleware: () => ((_req, _res, next) => next()),
    getAuth: () => ({ isAuthenticated: true, userId: "user_mike123", sessionId: "sess_mike123" }),
    client: verifiedClient(revoked)
  });

  assert.deepEqual(await gateway.verifiedIdentity("user_mike123", "sess_mike123"), {
    clerkUserId: "user_mike123",
    clerkSessionId: "sess_mike123",
    email: "mike@example.com",
    displayName: "Mike Long"
  });
  await gateway.revokeSession("sess_mike123");
  assert.deepEqual(revoked, ["sess_mike123"]);
  await assert.rejects(() => gateway.verifiedIdentity("mike@example.com", "sess_mike123"), ClerkIdentityError);
});

test("Clerk identities fail closed when the account, verified email, or display name is unavailable", async () => {
  for (const user of [
    { ...verifiedUser(), banned: true },
    { ...verifiedUser(), locked: true },
    { ...verifiedUser(), primaryEmailAddress: null },
    { ...verifiedUser(), primaryEmailAddress: { emailAddress: "mike@example.com", verification: { status: "unverified" } } },
    { ...verifiedUser(), firstName: null, lastName: null, username: null }
  ]) {
    const gateway = createClerkAuthGateway(CONFIG, {
      middleware: () => ((_req, _res, next) => next()),
      getAuth: () => ({ isAuthenticated: true, userId: "user_mike123", sessionId: "sess_mike123" }),
      client: {
        users: { async getUser() { return user; } },
        sessions: { async revokeSession() {} }
      }
    });
    await assert.rejects(
      () => gateway.verifiedIdentity("user_mike123", "sess_mike123"),
      ClerkIdentityError
    );
  }
});

function verifiedClient(revoked: string[] = []) {
  return {
    users: { async getUser() { return verifiedUser(); } },
    sessions: { async revokeSession(sessionId: string) { revoked.push(sessionId); } }
  };
}

function requestWithHost(host: string, forwardedHost?: string): Request {
  const headers: Record<string, string> = { host };
  if (forwardedHost) headers["x-forwarded-host"] = forwardedHost;
  return {
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    }
  } as Request;
}

function verifiedUser() {
  return {
    id: "user_mike123",
    banned: false,
    locked: false,
    firstName: "Mike",
    lastName: "Long",
    username: null,
    primaryEmailAddress: {
      emailAddress: "mike@example.com",
      verification: { status: "verified" }
    }
  };
}
