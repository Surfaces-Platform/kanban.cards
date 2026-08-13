import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_INVALID_IDENTITY,
  AUTH_INVALID_RETURN_TO,
  AUTH_INVALID_STATE,
  AUTH_SURFACE_DENIED,
  clearRootSessionCookie,
  clearTenantSessionCookie,
  clearLogoutRetryCookie,
  createLogoutRetryCookie,
  createRootSessionCookie,
  createTenantSessionCookie,
  finishOwnerLogin,
  getPlatformAuthConfig,
  startOwnerLogin,
  validatePlatformAuthConfig,
  validateProviderClaims,
  validateReturnTo,
  verifyRootSession,
  verifyLogoutRetrySession,
  verifyTenantSession,
  type PlatformAuthConfig
} from "../src/platform-auth";

const SESSION_SECRET = "platform-auth-test-secret-with-at-least-32-characters";

test("provider claims require scalar identity and explicit kanban.cards access", () => {
  assert.deepEqual(validateProviderClaims({
    sub: "provider|owner-1",
    email: "owner@example.com",
    email_verified: true,
    name: "Owner One",
    "https://surfaces.systems/surface_access": ["kanban.cards"]
  }), {
    providerSubject: "provider|owner-1",
    email: "owner@example.com",
    displayName: "Owner One"
  });

  assert.throws(() => validateProviderClaims({
    sub: ["provider|owner-1"],
    email: "owner@example.com",
    email_verified: true,
    name: "Owner One",
    surface_access: ["kanban.cards"]
  } as unknown as Parameters<typeof validateProviderClaims>[0]), /subject must be a non-empty scalar string/);
  assert.throws(() => validateProviderClaims({
    sub: "provider|owner-1",
    email: "owner@example.com",
    email_verified: true,
    name: "Owner One",
    surface_access: ["another.product"]
  }), new RegExp(AUTH_SURFACE_DENIED));
  assert.throws(() => validateProviderClaims({
    sub: "provider|owner-1",
    email: "owner@example.com",
    email_verified: true,
    name: "Owner One"
  }), new RegExp(AUTH_SURFACE_DENIED));
  for (const emailVerified of [false, undefined, "true"]) {
    assert.throws(() => validateProviderClaims({
      sub: "provider|owner-1",
      email: "owner@example.com",
      ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
      name: "Owner One",
      surface_access: ["kanban.cards"]
    }), new RegExp(AUTH_INVALID_IDENTITY));
  }
});

test("return locations stay relative to kanban.cards", () => {
  assert.equal(validateReturnTo("/projects?active=one#card"), "/projects?active=one#card");
  assert.equal(validateReturnTo("https://attacker.example"), null);
  assert.equal(validateReturnTo("//attacker.example"), null);
  assert.equal(validateReturnTo("/\\attacker.example"), null);
});

test("root and tenant session cookies are separate, signed, host-only, origin-bound, and clearable", async () => {
  const root = {
    providerSubject: "provider|owner-1",
    email: "owner@example.com",
    displayName: "Owner One",
    sessionId: "root-session-1",
    rootOrigin: "https://kanban.cards"
  };
  const tenant = {
    ...root,
    sessionId: "tenant-session-1",
    workspaceId: "workspace-one",
    tenantOrigin: "https://workspace-one.kanban.cards"
  };
  const rootCookie = await createRootSessionCookie(root, SESSION_SECRET, true, 300);
  const tenantCookie = await createTenantSessionCookie(tenant, SESSION_SECRET, true, 300);

  for (const cookie of [rootCookie, tenantCookie]) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/i);
  }

  const rootRequest = cookieRequest("https://kanban.cards/", [rootCookie]);
  const tenantRequest = cookieRequest("https://workspace-one.kanban.cards/", [tenantCookie]);
  assert.deepEqual(await verifyRootSession(rootRequest, SESSION_SECRET, true), root);
  assert.deepEqual(await verifyTenantSession(tenantRequest, SESSION_SECRET, true), tenant);
  assert.equal(await verifyRootSession(rootRequest, `${SESSION_SECRET}-wrong`, true), null);
  assert.equal(await verifyRootSession(cookieRequest("https://candidate.kanban.cards/", [rootCookie]), SESSION_SECRET, true), null);
  assert.equal(await verifyTenantSession(cookieRequest("https://workspace-two.kanban.cards/", [tenantCookie]), SESSION_SECRET, true), null);

  await assert.rejects(() => createRootSessionCookie({
    ...root,
    rootOrigin: "https://kanban.cards/"
  }, SESSION_SECRET, true, 300), /rootOrigin must be an exact secure origin/);
  await assert.rejects(() => createTenantSessionCookie({
    ...tenant,
    tenantOrigin: "https://workspace-one.kanban.cards/path"
  }, SESSION_SECRET, true, 300), /tenantOrigin must be an exact secure origin/);

  assert.match(clearRootSessionCookie(true), /^__Host-kanban_root_session=; .*Max-Age=0/);
  assert.match(clearTenantSessionCookie(true), /^__Host-kanban_tenant_session=; .*Max-Age=0/);
});

test("logout retry cookies preserve only the revocation family and bind it to the current origin", async () => {
  const retry = {
    providerSubject: "provider|owner-1",
    sessionId: "root-session-1",
    rootOrigin: "https://kanban.cards",
    cookieOrigin: "https://kanban.cards"
  };
  const cookie = await createLogoutRetryCookie(retry, SESSION_SECRET, true, 300);
  assert.match(cookie, /^__Host-kanban_logout_retry=/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.deepEqual(await verifyLogoutRetrySession(cookieRequest("https://kanban.cards/", [cookie]), SESSION_SECRET, true), retry);
  assert.equal(await verifyLogoutRetrySession(cookieRequest("https://candidate.kanban.cards/", [cookie]), SESSION_SECRET, true), null);
  assert.equal(await verifyLogoutRetrySession(cookieRequest("https://kanban.cards/", [cookie]), `${SESSION_SECRET}-wrong`, true), null);
  assert.match(clearLogoutRetryCookie(true), /^__Host-kanban_logout_retry=; .*Max-Age=0/);
});

test("OIDC authorization code flow binds state to the exact root origin and verifies provider claims", async () => {
  const jose = await import("jose");
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const publicJwk = await jose.exportJWK(publicKey);
  Object.assign(publicJwk, { kid: "provider-key", alg: "RS256", use: "sig" });
  const config = testConfig();
  let idTokenClaims: Record<string, unknown> = {};
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${config.issuer}.well-known/openid-configuration`) return jsonResponse(discovery(config));
    if (url === "https://identity.example/jwks") return jsonResponse({ keys: [publicJwk] });
    if (url === "https://identity.example/token") {
      assert.equal(init?.method, "POST");
      const idToken = await new jose.SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: "RS256", kid: "provider-key" })
        .setIssuer(config.issuer)
        .setAudience(config.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return jsonResponse({ id_token: idToken });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };

  const invalidReturn = await startOwnerLogin(
    new Request("http://127.0.0.1:4317/auth/login?returnTo=https%3A%2F%2Fattacker.example"),
    config,
    fetchImpl as typeof fetch
  );
  assert.equal(invalidReturn.status, 400);
  assert.equal(invalidReturn.json?.error, AUTH_INVALID_RETURN_TO);

  const login = await startOwnerLogin(
    new Request("http://127.0.0.1:4317/auth/login?returnTo=%2Fprojects%3Ffrom%3Dlogin"),
    config,
    fetchImpl as typeof fetch
  );
  assert.equal(login.status, 302);
  const authorizeUrl = new URL(String(login.headers?.Location));
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizeUrl.searchParams.get("nonce"));
  assert.ok(authorizeUrl.searchParams.get("state"));
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), config.redirectUri);
  const loginCookies = login.headers?.["Set-Cookie"] as string[];
  idTokenClaims = {
    sub: "provider|owner-1",
    email: "owner@example.com",
    email_verified: true,
    name: "Owner One",
    nonce: authorizeUrl.searchParams.get("nonce"),
    surface_access: ["kanban.cards"]
  };

  const callback = await finishOwnerLogin(new Request(
    `http://127.0.0.1:4317/auth/callback?code=code-1&state=${encodeURIComponent(String(authorizeUrl.searchParams.get("state")))}`,
    { headers: { Cookie: cookieHeader(loginCookies) } }
  ), config, fetchImpl as typeof fetch);
  assert.equal(callback.status, 200);
  assert.deepEqual(callback.completion, {
    identity: {
      providerSubject: "provider|owner-1",
      email: "owner@example.com",
      displayName: "Owner One"
    },
    returnTo: "/projects?from=login"
  });
  assert.equal("workspaceId" in callback.completion!.identity, false);

  const replayLogin = await startOwnerLogin(new Request("http://127.0.0.1:4317/auth/login"), config, fetchImpl as typeof fetch);
  const replayAuthorizeUrl = new URL(String(replayLogin.headers?.Location));
  const replayedAcrossOrigins = await finishOwnerLogin(new Request(
    `http://localhost:4317/auth/callback?code=replayed-code&state=${encodeURIComponent(String(replayAuthorizeUrl.searchParams.get("state")))}`,
    { headers: { Cookie: cookieHeader(replayLogin.headers?.["Set-Cookie"] as string[]) } }
  ), config, fetchImpl as typeof fetch);
  assert.equal(replayedAcrossOrigins.status, 400);
  assert.equal(replayedAcrossOrigins.json?.error, AUTH_INVALID_STATE);

  const wrongOriginStart = await startOwnerLogin(
    new Request("http://localhost:4317/auth/login"),
    config,
    fetchImpl as typeof fetch
  );
  assert.equal(wrongOriginStart.status, 400);
  assert.equal(wrongOriginStart.json?.error, AUTH_INVALID_STATE);

  const secondLogin = await startOwnerLogin(new Request("http://127.0.0.1:4317/auth/login"), config, fetchImpl as typeof fetch);
  const secondAuthorizeUrl = new URL(String(secondLogin.headers?.Location));
  idTokenClaims = { ...idTokenClaims, nonce: "wrong-nonce" };
  const rejected = await finishOwnerLogin(new Request(
    `http://127.0.0.1:4317/auth/callback?code=code-2&state=${encodeURIComponent(String(secondAuthorizeUrl.searchParams.get("state")))}`,
    { headers: { Cookie: cookieHeader(secondLogin.headers?.["Set-Cookie"] as string[]) } }
  ), config, fetchImpl as typeof fetch);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json?.error, AUTH_INVALID_IDENTITY);
  assert.doesNotMatch(JSON.stringify(rejected), /wrong-nonce|provider request|token exchange/i);
});

test("configuration requires secure auth URLs, the kanban.cards surface, and a separate session secret", () => {
  const config = getPlatformAuthConfig({
    OIDC_ISSUER: "https://identity.example/",
    OIDC_CLIENT_ID: "client-one",
    OIDC_REDIRECT_URI: "https://kanban.cards/auth/callback",
    SESSION_SECRET,
    PLATFORM_SURFACE_ID: "kanban.cards"
  });
  assert.equal(config.surfaceId, "kanban.cards");
  assert.equal(config.sessionSecret, SESSION_SECRET);

  assert.equal(validatePlatformAuthConfig({
    ...testConfig(),
    issuer: "http://localhost:5555/",
    redirectUri: "http://127.0.0.1:4317/auth/callback"
  }).issuer, "http://localhost:5555/");

  assert.throws(() => getPlatformAuthConfig({
    OIDC_ISSUER: "https://identity.example/",
    OIDC_CLIENT_ID: "client-one",
    OIDC_REDIRECT_URI: "https://kanban.cards/auth/callback",
    SESSION_SECRET,
    PLATFORM_SURFACE_ID: "another.product"
  }), /must be kanban\.cards/);

  for (const issuer of [
    "http://identity.example/",
    "http://127.evil.example/",
    "https://user:password@identity.example/",
    "https://identity.example/?tenant=one",
    "https://identity.example/?",
    "https://identity.example/#",
    "https:\\identity.example/",
    "not-a-url"
  ]) {
    assert.throws(() => validatePlatformAuthConfig({ ...testConfig(), issuer }), /OIDC_ISSUER/);
  }

  for (const redirectUri of [
    "http://kanban.cards/auth/callback",
    "http://localhost.evil.example/auth/callback",
    "https://user:password@kanban.cards/auth/callback",
    "https://kanban.cards/auth/callback#token",
    "https://kanban.cards/auth/callback#",
    "/auth/callback"
  ]) {
    assert.throws(() => validatePlatformAuthConfig({ ...testConfig(), redirectUri }), /OIDC_REDIRECT_URI/);
  }

  assert.throws(() => validatePlatformAuthConfig({ ...testConfig(), surfaceId: "another.product" }), /must be kanban\.cards/);
  assert.throws(() => validatePlatformAuthConfig({ ...testConfig(), sessionSecret: "too-short" }), /at least 32 characters/);
});

function testConfig(): PlatformAuthConfig {
  return {
    issuer: "https://identity.example/",
    clientId: "client-one",
    redirectUri: "http://127.0.0.1:4317/auth/callback",
    postLogoutRedirectUri: "/",
    sessionSecret: SESSION_SECRET,
    surfaceId: "kanban.cards",
    scope: "openid profile email",
    rootSessionTtlSeconds: 300,
    tenantSessionTtlSeconds: 300
  };
}

function discovery(config: PlatformAuthConfig): object {
  return {
    issuer: config.issuer,
    authorization_endpoint: "https://identity.example/authorize",
    token_endpoint: "https://identity.example/token",
    jwks_uri: "https://identity.example/jwks"
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function cookieRequest(url: string, setCookies: string[]): Request {
  return new Request(url, { headers: { Cookie: cookieHeader(setCookies) } });
}
