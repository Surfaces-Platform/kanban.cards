import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { createSessionCookie, validateClaims } from "../src/platform-auth";
import { createApp } from "../src/server";

test("Auth0 session auth protects UI/API while preserving bearer admin compatibility", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-auth-"));
    const dataPath = path.join(tempDir, "state.json");
    const apiToken = "break-glass-token";
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const sessionCookie = await createSessionCookie(testSession(), "test-session-secret-with-enough-entropy", false, 3600);

    try {
      const deniedUi = await fetch(`${baseUrl}/`, { redirect: "manual" });
      assert.equal(deniedUi.status, 302);
      assert.match(deniedUi.headers.get("location") || "", /^\/auth\/login\?returnTo=/);

      const deniedApi = await fetch(`${baseUrl}/api/state`);
      assert.equal(deniedApi.status, 401);

      const basicDenied = await fetch(`${baseUrl}/api/state`, {
        headers: basicHeaders("mike", "secret")
      });
      assert.equal(basicDenied.status, 401);

      const html = await text(`${baseUrl}/`, cookieHeaders(sessionCookie));
      assert.match(html, /kanban\.cards/);
      assert.doesNotMatch(html, /KANBAN_CARDS_API_TOKEN|INSTRUCT_API_TOKEN|break-glass-token/);

      const session = await getJson(`${baseUrl}/auth/session`, cookieHeaders(sessionCookie));
      assert.equal(session.workspaceId, "ws_auth_test");
      assert.equal(session.teamId, "ws_auth_test");
      assert.equal(session.projectId, "kanban.cards:default");

      const state = await getJson(`${baseUrl}/api/state`, cookieHeaders(sessionCookie));
      assert.equal(state.boards[0].name, "Untitled board");

      const saved = await writeJson(`${baseUrl}/api/state`, cookieHeaders(sessionCookie), state, "PUT");
      assert.equal(saved.boards[0].name, "Untitled board");

      const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(apiToken), { name: "Break-glass board" });
      assert.equal(board.name, "Break-glass board");
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("production-like auth reports missing Auth0/OIDC required config", async () => {
  const restore = setEnv({
    KANBAN_CARDS_API_TOKEN: "",
    INSTRUCT_API_TOKEN: "",
    OIDC_ISSUER: "",
    OIDC_CLIENT_ID: "",
    OIDC_REDIRECT_URI: "",
    SESSION_SECRET: "",
    PLATFORM_SURFACE_ID: ""
  });
  const server = await listen(createApp({ requireAuth: true, apiToken: "" }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 500);
    const body = await health.json() as any;
    assert.deepEqual(body.missingConfig, [
      "KANBAN_CARDS_API_TOKEN",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_REDIRECT_URI",
      "SESSION_SECRET",
      "PLATFORM_SURFACE_ID=kanban.cards"
    ]);
  } finally {
    await closeServer(server);
    restore();
  }
});

test("Auth0 login, callback, logout, and returnTo validation use platform claims", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-auth-routes-"));
    const dataPath = path.join(tempDir, "state.json");
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: "admin-token" }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const originalFetch = globalThis.fetch;
    const { SignJWT, exportJWK, generateKeyPair } = await import("jose");
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    let idTokenClaims: Record<string, unknown> = {
      sub: "auth0|route-user",
      email: "route@example.com",
      name: "Route User",
      "https://surfaces.systems/workspace_id": "ws_route",
      "https://surfaces.systems/surface_access": ["kanban.cards"]
    };

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      if (url === "https://auth.example.com/.well-known/openid-configuration") {
        return jsonResponse({
          issuer: "https://auth.example.com/",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/oauth/token",
          jwks_uri: "https://auth.example.com/.well-known/jwks.json",
          end_session_endpoint: "https://auth.example.com/oidc/logout"
        });
      }
      if (url === "https://auth.example.com/.well-known/jwks.json") {
        return jsonResponse({ keys: [publicJwk] });
      }
      if (url === "https://auth.example.com/oauth/token") {
        const token = await new SignJWT(idTokenClaims)
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://auth.example.com/")
          .setAudience("test-client")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return jsonResponse({ id_token: token });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const invalidReturnTo = await fetch(`${baseUrl}/auth/login?returnTo=${encodeURIComponent("https://evil.example/")}`);
      assert.equal(invalidReturnTo.status, 400);

      const login = await fetch(`${baseUrl}/auth/login?returnTo=${encodeURIComponent("/api/state?from=login")}`, {
        redirect: "manual"
      });
      assert.equal(login.status, 302);
      const loginLocation = new URL(login.headers.get("location") || "");
      assert.equal(loginLocation.origin, "https://auth.example.com");
      assert.equal(loginLocation.searchParams.get("client_id"), "test-client");
      assert.equal(loginLocation.searchParams.get("redirect_uri"), "http://127.0.0.1:4317/auth/callback");
      assert.equal(loginLocation.searchParams.get("code_challenge_method"), "S256");
      const loginCookies = getSetCookieHeaders(login);
      assert.ok(loginCookies.some((cookie) => cookie.startsWith("surfaces_pkce=")));
      assert.ok(loginCookies.some((cookie) => cookie.startsWith("surfaces_state=")));

      const callback = await fetch(`${baseUrl}/auth/callback?code=code-123&state=${loginLocation.searchParams.get("state")}`, {
        headers: cookieHeaders(loginCookies),
        redirect: "manual"
      });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), "/api/state?from=login");
      const callbackCookies = getSetCookieHeaders(callback);
      assert.ok(callbackCookies.some((cookie) => cookie.startsWith("surfaces_session=")));

      const session = await getJson(`${baseUrl}/auth/session`, cookieHeaders(callbackCookies));
      assert.equal(session.email, "route@example.com");
      assert.equal(session.workspaceId, "ws_route");

      idTokenClaims = {
        ...idTokenClaims,
        "https://surfaces.systems/surface_access": ["surfaceops.ai"]
      };
      const deniedLogin = await fetch(`${baseUrl}/auth/login?returnTo=/`, { redirect: "manual" });
      const deniedLocation = new URL(deniedLogin.headers.get("location") || "");
      const denied = await fetch(`${baseUrl}/auth/callback?code=code-456&state=${deniedLocation.searchParams.get("state")}`, {
        headers: cookieHeaders(getSetCookieHeaders(deniedLogin))
      });
      assert.equal(denied.status, 403);
      const deniedBody = await denied.json() as any;
      assert.equal(deniedBody.error, "AUTH_SURFACE_DENIED");

      const logout = await fetch(`${baseUrl}/auth/logout`, {
        headers: cookieHeaders(callbackCookies),
        method: "POST"
      });
      assert.equal(logout.status, 204);
      assert.ok(getSetCookieHeaders(logout).some((cookie) => cookie.startsWith("surfaces_session=;")));

      const logoutComplete = await fetch(`${baseUrl}/auth/logout/complete`, { redirect: "manual" });
      assert.equal(logoutComplete.status, 302);
      assert.equal(logoutComplete.headers.get("location"), "/");
    } finally {
      globalThis.fetch = originalFetch;
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("claim validation requires workspace and enforces kanban.cards surface access", () => {
  assert.deepEqual(validateClaims({
    sub: "auth0|missing-workspace",
    "https://surfaces.systems/surface_access": ["kanban.cards"]
  }, "kanban.cards"), { ok: false, code: "AUTH_MISSING_WORKSPACE" });

  assert.deepEqual(validateClaims({
    sub: "auth0|wrong-surface",
    "https://surfaces.systems/workspace_id": "ws_wrong",
    "https://surfaces.systems/surface_access": ["surfaceops.ai"]
  }, "kanban.cards"), { ok: false, code: "AUTH_SURFACE_DENIED" });
});

function testSession() {
  return {
    userId: "auth0|test-user",
    email: "test@example.com",
    name: "Test User",
    workspaceId: "ws_auth_test",
    roles: ["admin"],
    surfaceAccess: ["kanban.cards"]
  };
}

async function withPlatformAuthEnv(run: () => Promise<void>): Promise<void> {
  const restore = setEnv({
    OIDC_ISSUER: "https://auth.example.com/",
    OIDC_CLIENT_ID: "test-client",
    OIDC_REDIRECT_URI: "http://127.0.0.1:4317/auth/callback",
    OIDC_POST_LOGOUT_REDIRECT_URI: "http://127.0.0.1:4317/",
    SESSION_SECRET: "test-session-secret-with-enough-entropy",
    PLATFORM_SURFACE_ID: "kanban.cards",
    OIDC_LOGOUT_URL: ""
  });
  try {
    await run();
  } finally {
    restore();
  }
}

function setEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function getSetCookieHeaders(response: Response): string[] {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(response.headers);
  const value = response.headers.get("set-cookie");
  return value ? splitSetCookieHeader(value) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,]+=)/).map((cookie) => cookie.trim()).filter(Boolean);
}

function cookieHeaders(cookies: string | string[]): Record<string, string> {
  const values = Array.isArray(cookies) ? cookies : [cookies];
  return {
    Cookie: values.map((cookie) => cookie.split(";")[0]).join("; ")
  };
}

function basicHeaders(user: string, password: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  };
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function listen(app: Express): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function text(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.text();
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function writeJson<T = any>(url: string, headers: Record<string, string>, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}
