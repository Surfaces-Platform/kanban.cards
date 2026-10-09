import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRootSessionCookie, clearTenantSessionCookie,
  createRootSessionCookie, createTenantSessionCookie,
  isProductionRequest, rootSessionCookieName, tenantSessionCookieName,
  verifyRootSession, verifyTenantSession,
  type RootSession, type TenantSession
} from "../src/app-sessions";

const SESSION_SECRET = "app-session-test-secret-with-at-least-32-characters";

const ROOT_SESSION: RootSession = {
  providerSubject: "user_owner1",
  email: "owner@example.com",
  displayName: "Owner One",
  sessionId: "root-session-1",
  rootOrigin: "https://kanban.cards"
};

const TENANT_SESSION: TenantSession = {
  ...ROOT_SESSION,
  sessionId: "tenant-session-1",
  workspaceId: "workspace-one",
  tenantOrigin: "https://workspace-one.kanban.cards"
};

test("root and tenant sessions are signed, audience-separated, host-only, and exact-origin bound", async () => {
  const rootCookie = await createRootSessionCookie(ROOT_SESSION, SESSION_SECRET, true, 300);
  const tenantCookie = await createTenantSessionCookie(TENANT_SESSION, SESSION_SECRET, true, 300);

  for (const cookie of [rootCookie, tenantCookie]) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/i);
  }

  assert.deepEqual(
    await verifyRootSession(cookieRequest("https://kanban.cards/", [rootCookie]), SESSION_SECRET, true),
    ROOT_SESSION
  );
  assert.deepEqual(
    await verifyTenantSession(
      cookieRequest("https://workspace-one.kanban.cards/", [tenantCookie]),
      SESSION_SECRET,
      true
    ),
    TENANT_SESSION
  );

  assert.equal(
    await verifyRootSession(cookieRequest("https://candidate.kanban.cards/", [rootCookie]), SESSION_SECRET, true),
    null
  );
  assert.equal(
    await verifyTenantSession(
      cookieRequest("https://workspace-two.kanban.cards/", [tenantCookie]),
      SESSION_SECRET,
      true
    ),
    null
  );
  assert.equal(
    await verifyRootSession(cookieRequest("https://kanban.cards/", [tenantCookie]), SESSION_SECRET, true),
    null
  );
  assert.equal(
    await verifyRootSession(cookieRequest("https://kanban.cards/", [rootCookie]), `${SESSION_SECRET}-wrong`, true),
    null
  );

  assert.match(clearRootSessionCookie(true), /^__Host-kanban_root_session=; .*Max-Age=0/);
  assert.match(clearTenantSessionCookie(true), /^__Host-kanban_tenant_session=; .*Max-Age=0/);
});

test("default root and tenant cookies and signed tokens last 365 days", async () => {
  const { decodeJwt } = await import("jose");
  const cookies = [
    await createRootSessionCookie(ROOT_SESSION, SESSION_SECRET, true),
    await createTenantSessionCookie(TENANT_SESSION, SESSION_SECRET, true)
  ];
  for (const cookie of cookies) {
    assert.match(cookie, /; Max-Age=31536000(?:;|$)/);
    const token = cookie.split(";", 1)[0].split("=")[1];
    const payload = decodeJwt(token);
    assert.equal(payload.exp! - payload.iat!, 31_536_000);
  }
});

test("session creation validates scalar identity, exact secure origins, TTL, and secret", async () => {
  await assert.rejects(() => createRootSessionCookie({
    ...ROOT_SESSION,
    providerSubject: " user_owner1"
  }, SESSION_SECRET, true, 300), /providerSubject must be a non-empty scalar string/);
  await assert.rejects(() => createRootSessionCookie({
    ...ROOT_SESSION,
    rootOrigin: "https://kanban.cards/"
  }, SESSION_SECRET, true, 300), /rootOrigin must be an exact secure origin/);
  await assert.rejects(() => createRootSessionCookie({
    ...ROOT_SESSION,
    rootOrigin: "http://kanban.cards"
  }, SESSION_SECRET, true, 300), /rootOrigin must be an exact secure origin/);
  await assert.rejects(() => createTenantSessionCookie({
    ...TENANT_SESSION,
    tenantOrigin: "https://workspace-one.kanban.cards/path"
  }, SESSION_SECRET, true, 300), /tenantOrigin must be an exact secure origin/);
  await assert.rejects(
    () => createRootSessionCookie(ROOT_SESSION, "too-short", true, 300),
    /SESSION_SECRET must contain at least 32 characters/
  );
  await assert.rejects(
    () => createRootSessionCookie(ROOT_SESSION, SESSION_SECRET, true, 0),
    /session TTL must be a positive integer/
  );

  const local: RootSession = { ...ROOT_SESSION, rootOrigin: "http://root.localhost:4317" };
  const localCookie = await createRootSessionCookie(local, SESSION_SECRET, false, 300);
  assert.deepEqual(
    await verifyRootSession(cookieRequest("http://root.localhost:4317/", [localCookie]), SESSION_SECRET, false),
    local
  );
});

test("cookie names and production detection retain local and deployed behavior", () => {
  assert.equal(rootSessionCookieName(true), "__Host-kanban_root_session");
  assert.equal(rootSessionCookieName(false), "kanban_root_session");
  assert.equal(tenantSessionCookieName(true), "__Host-kanban_tenant_session");
  assert.equal(tenantSessionCookieName(false), "kanban_tenant_session");
  assert.equal(isProductionRequest(new Request("https://kanban.cards/")), true);
  assert.equal(isProductionRequest(new Request("http://localhost:4317/")), false);
  assert.equal(isProductionRequest(new Request("http://tenant.localhost:4317/")), false);
  assert.equal(isProductionRequest(new Request("http://127.0.0.1:4317/")), false);
});

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function cookieRequest(url: string, setCookies: string[]): Request {
  return new Request(url, { headers: { Cookie: cookieHeader(setCookies) } });
}
