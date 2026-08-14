import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileAccessStore, type AccessStore, type AccessWorkspace } from "../src/access-store";
import {
  createRootSessionCookie,
  logoutRetryCookieName,
  rootSessionCookieName,
  tenantSessionCookieName,
  verifyTenantSession,
  type RootSession
} from "../src/app-sessions";
import type { ClerkAuthConfig, ClerkAuthGateway } from "../src/clerk-auth";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver, freshWorkspaceState } from "../src/state-store";

const ROOT_HOST = "kanban.cards";
const LEGACY_HOST = "legacy.kanban.cards";
const BETA_HOST = "beta.kanban.cards";
const CANDIDATE_ROOT_HOST = "kanban-candidate-root.vercel.app";
const CANDIDATE_LEGACY_HOST = "kanban-candidate-legacy.vercel.app";
const LEGACY_BEARER = "legacy-owner-key";
const OWNER: RootSession = {
  providerSubject: "user_legacyOwner123",
  email: "owner@example.com",
  displayName: "Verified Owner",
  sessionId: "sess_securityOwner123",
  rootOrigin: `https://${ROOT_HOST}`
};
const UNAUTHORIZED_CLERK_USER_ID = "user_notAdmitted456";
const CLERK_CONFIG: ClerkAuthConfig = {
  publishableKey: "pk_test_workspace_access_security",
  secretKey: "sk_test_workspace_access_security",
  encryptionKey: "workspace-access-security-clerk-encryption-key-0123456789",
  sessionSecret: "workspace-access-security-test-session-secret-0123456789",
  authHost: "auth.kanban.cards",
  allowedUserIds: [OWNER.providerSubject],
  rootSessionTtlSeconds: 3_600,
  tenantSessionTtlSeconds: 3_600
};

test("two Workspaces isolate API reads, writes, idempotency, and client selectors", async () => {
  await withApp(async ({ betaWorkspace, client, legacyWorkspace, rootCookie }) => {
    assert.equal(legacyWorkspace.storageId, "default");
    assert.notEqual(betaWorkspace.storageId, "default");
    assert.notEqual(betaWorkspace.storageId, legacyWorkspace.storageId);

    const legacyCookie = await openWorkspace(client, rootCookie, "legacy");
    const betaCookie = await openWorkspace(client, rootCookie, "beta");

    const legacyProject = await client.post("/api/projects", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      origin: `https://${LEGACY_HOST}`,
      idempotencyKey: "same-key",
      json: { name: "Legacy only" }
    });
    assert.equal(legacyProject.status, 201);

    const betaProject = await client.post("/api/projects", {
      host: BETA_HOST,
      cookie: betaCookie,
      origin: `https://${BETA_HOST}`,
      idempotencyKey: "same-key",
      json: { name: "Beta only" }
    });
    assert.equal(betaProject.status, 201);
    assert.notEqual(betaProject.data.project.id, legacyProject.data.project.id);

    const legacyProjects = await client.get("/api/projects", { host: LEGACY_HOST, cookie: legacyCookie });
    const betaProjects = await client.get("/api/projects", { host: BETA_HOST, cookie: betaCookie });
    assert.deepEqual(legacyProjects.data.projects.map((project: any) => project.name), ["Legacy only"]);
    assert.deepEqual(betaProjects.data.projects.map((project: any) => project.name), ["Beta only"]);

    assert.equal((await client.get("/api/projects", { host: BETA_HOST, cookie: legacyCookie })).status, 401);
    assert.equal((await client.get("/api/projects", { host: LEGACY_HOST, cookie: betaCookie })).status, 401);

    for (const selector of [
      { workspaceId: "beta" },
      { workspace: "beta" },
      { workspaceSlug: "beta" }
    ]) {
      const selected = await client.post("/api/projects", {
        host: LEGACY_HOST,
        cookie: legacyCookie,
        origin: `https://${LEGACY_HOST}`,
        json: { name: "Must not select a tenant", ...selector }
      });
      assert.equal(selected.status, 400);
      assert.match(selected.data.error, /workspace context cannot be supplied/i);
    }

    const querySelected = await client.get("/api/projects?workspaceId=beta", {
      host: LEGACY_HOST,
      cookie: legacyCookie
    });
    assert.equal(querySelected.status, 400);
    assert.match(querySelected.data.error, /workspace context cannot be supplied/i);
  });
});

test("legacy bearer is explicitly mapped to default and cannot enter a sibling Workspace", async () => {
  await withApp(async ({ client }) => {
    const legacyWrite = await client.post("/api/projects", {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER,
      idempotencyKey: "legacy-default-only",
      json: { name: "Stored in default" }
    });
    assert.equal(legacyWrite.status, 201);

    const legacyRead = await client.get("/api/projects", { host: LEGACY_HOST, bearer: LEGACY_BEARER });
    assert.deepEqual(legacyRead.data.projects.map((project: any) => project.name), ["Stored in default"]);

    const projectId = legacyWrite.data.project.id;
    const card = await client.post(`/api/projects/${projectId}/cards`, {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER,
      idempotencyKey: "legacy-bounded-card",
      json: { title: "Bounded compatibility proof", externalKey: "release:bounded-compatibility" }
    });
    assert.equal(card.status, 201);
    assert.equal(card.data.card.version, 1);
    const cardId = card.data.card.id;

    const comment = await client.post(`/api/projects/${projectId}/cards/${cardId}/comments`, {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER,
      idempotencyKey: "legacy-bounded-comment",
      json: { body: "Compatibility Comment passed." }
    });
    assert.equal(comment.status, 201);
    assert.equal(comment.data.card.version, 2);

    const move = await client.patch(`/api/projects/${projectId}/cards/${cardId}`, {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER,
      version: 2,
      json: { columnId: legacyWrite.data.project.columns[1].id }
    });
    assert.equal(move.status, 200);
    assert.equal(move.data.card.version, 3);

    const archive = await client.patch(`/api/projects/${projectId}/cards/${cardId}`, {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER,
      version: 3,
      json: { archivedAt: "2026-08-12T12:30:00.000Z" }
    });
    assert.equal(archive.status, 200);
    assert.equal(archive.data.card.version, 4);
    assert.equal(archive.data.card.archivedAt, "2026-08-12T12:30:00.000Z");

    const lifecycle = await client.get(`/api/projects/${projectId}`, { host: LEGACY_HOST, bearer: LEGACY_BEARER });
    assert.equal(lifecycle.status, 200);
    assert.equal(lifecycle.data.project.cards[0].comments.length, 1);
    assert.deepEqual(lifecycle.data.project.activity.map((entry: any) => entry.action), [
      "project.created",
      "card.created",
      "comment.created",
      "card.moved",
      "card.archived"
    ]);

    assert.equal((await client.get("/api/projects", { host: BETA_HOST, bearer: LEGACY_BEARER })).status, 401);
    const rootAlias = await client.get("/api/projects", { host: ROOT_HOST, bearer: LEGACY_BEARER });
    assert.deepEqual(rootAlias.data.projects.map((project: any) => project.name), ["Stored in default"]);
    assert.equal((await client.get("/api/projects", { host: "unknown.kanban.cards", bearer: LEGACY_BEARER })).status, 401);

    const unknownCookie = cookieHeader(await createRootSessionCookie({
      providerSubject: "user_unknownOwner789",
      email: "unknown@example.com",
      displayName: "Unknown Owner",
      sessionId: "unknown-root-session",
      rootOrigin: `https://${ROOT_HOST}`
    }, CLERK_CONFIG.sessionSecret, true, 3_600));
    const unknownWorkspaces = await client.get("/api/workspaces", { host: ROOT_HOST, cookie: unknownCookie });
    assert.equal(unknownWorkspaces.status, 401);
    assert.match(unknownWorkspaces.data.error, /sign-in required/i);
  });
});

test("Workspace handoffs reject wrong destinations, replay, and expiry without setting a cookie", async () => {
  await withApp(async ({ advance, client, rootCookie }) => {
    const browserFormToken = await issueHandoff(client, rootCookie, "legacy");
    const browserFormExchange = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      form: { token: browserFormToken }
    });
    assert.equal(browserFormExchange.status, 303);
    assert.equal(browserFormExchange.headers.get("location"), "/");
    assertHostOnlySessionCookie(browserFormExchange.headers.get("set-cookie"));

    const originBound = await issueHandoff(client, rootCookie, "legacy");
    const siblingOrigin = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${BETA_HOST}`,
      json: { token: originBound }
    });
    assert.equal(siblingOrigin.status, 403);
    assert.equal(siblingOrigin.headers.get("set-cookie"), null);
    const rootOrigin = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: originBound }
    });
    assert.equal(rootOrigin.status, 200);

    const wrongDestination = await issueHandoff(client, rootCookie, "legacy");
    const wrong = await client.post("/api/workspace-handoff", {
      host: BETA_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: wrongDestination }
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);

    const accepted = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: wrongDestination }
    });
    assert.equal(accepted.status, 200);
    assertHostOnlySessionCookie(accepted.headers.get("set-cookie"));

    const replay = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: wrongDestination }
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get("set-cookie"), null);

    const expiredToken = await issueHandoff(client, rootCookie, "legacy");
    advance(121_000);
    const expired = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: expiredToken }
    });
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get("set-cookie"), null);
  });
});

test("an explicit candidate host family exchanges only an admitted Clerk session and rejects cross-family sessions and handoffs", async () => {
  await withApp(async ({ client }) => {
    const candidateRootOrigin = `https://${CANDIDATE_ROOT_HOST}`;
    const candidateTenantOrigin = `https://${CANDIDATE_LEGACY_HOST}`;
    const canonicalSession = await client.get("/api/session", { host: ROOT_HOST });
    assert.equal(canonicalSession.status, 200);
    assert.equal(canonicalSession.data.clerkIsSatellite, true);
    assert.equal(canonicalSession.data.clerkPrimarySignInUrl, "https://auth.kanban.cards/sign-in");
    assert.equal(canonicalSession.data.clerkPrimarySignUpUrl, "https://auth.kanban.cards/sign-up");
    assert.deepEqual(canonicalSession.data.clerkAllowedRedirectOrigins, []);
    assert.equal(canonicalSession.data.clerkFallbackRedirectUrl, `https://${ROOT_HOST}`);
    const candidateSession = await client.get("/api/session", { host: CANDIDATE_ROOT_HOST });
    assert.equal(candidateSession.status, 200);
    assert.equal(candidateSession.data.clerkIsSatellite, true);
    assert.equal(candidateSession.data.clerkProxyUrl, `${candidateRootOrigin}/__clerk`);
    assert.equal(candidateSession.data.clerkPrimarySignInUrl, "https://auth.kanban.cards/sign-in");
    assert.equal(candidateSession.data.clerkPrimarySignUpUrl, "https://auth.kanban.cards/sign-up");
    assert.deepEqual(candidateSession.data.clerkAllowedRedirectOrigins, []);
    assert.equal(candidateSession.data.clerkFallbackRedirectUrl, `https://${ROOT_HOST}`);
    const tenantSession = await client.get("/api/session", { host: CANDIDATE_LEGACY_HOST });
    assert.equal("clerkPublishableKey" in tenantSession.data, false);
    assert.equal("clerkPrimarySignInUrl" in tenantSession.data, false);

    const crossFamilyExchange = await client.post("/api/clerk-session", {
      host: CANDIDATE_ROOT_HOST,
      origin: `https://${ROOT_HOST}`,
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: "sess_candidateOwner123"
    });
    assert.equal(crossFamilyExchange.status, 403);
    assert.equal(crossFamilyExchange.headers.get("set-cookie"), null);

    const exchanged = await client.post("/api/clerk-session", {
      host: CANDIDATE_ROOT_HOST,
      origin: candidateRootOrigin,
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: "sess_candidateOwner123"
    });
    assert.equal(exchanged.status, 201, JSON.stringify(exchanged.data));
    const candidateRootCookie = cookieHeader(requiredSessionCookie(exchanged, rootSessionCookieName(true)));

    assert.equal((await client.get("/api/workspaces", { host: ROOT_HOST, cookie: candidateRootCookie })).status, 401);
    const candidateWorkspaces = await client.get("/api/workspaces", {
      host: CANDIDATE_ROOT_HOST,
      cookie: candidateRootCookie
    });
    assert.equal(candidateWorkspaces.status, 200);
    assert.deepEqual(candidateWorkspaces.data.workspaces, [{
      id: candidateWorkspaces.data.workspaces[0].id,
      slug: "legacy",
      name: "Legacy Workspace",
      url: candidateTenantOrigin
    }]);

    const issued = await client.post("/api/workspace-handoffs", {
      host: CANDIDATE_ROOT_HOST,
      cookie: candidateRootCookie,
      origin: candidateRootOrigin,
      json: { slug: "legacy" }
    });
    assert.equal(issued.status, 201);
    assert.equal(issued.data.destination, `${candidateTenantOrigin}/api/workspace-handoff`);

    const wrongFamily = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: issued.data.handoffToken }
    });
    assert.equal(wrongFamily.status, 401);
    const candidateExchange = await client.post("/api/workspace-handoff", {
      host: CANDIDATE_LEGACY_HOST,
      origin: candidateRootOrigin,
      json: { token: issued.data.handoffToken }
    });
    assert.equal(candidateExchange.status, 200);
    const candidateTenantCookie = cookieHeader(candidateExchange.headers.get("set-cookie") || "");
    assert.equal((await client.get("/api/projects", {
      host: LEGACY_HOST,
      cookie: candidateTenantCookie
    })).status, 401);
    assert.equal((await client.get("/api/projects", {
      host: CANDIDATE_LEGACY_HOST,
      cookie: candidateTenantCookie
    })).status, 200);

    assert.equal((await client.post("/api/clerk-session", {
      host: "unapproved-candidate.vercel.app",
      origin: "https://unapproved-candidate.vercel.app",
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: "sess_unknownHost"
    })).status, 404);
    assert.equal((await client.get("/auth/login", { host: CANDIDATE_ROOT_HOST })).status, 404);
    assert.equal((await client.get("/auth/callback", { host: CANDIDATE_ROOT_HOST })).status, 404);
    assert.equal((await client.get("/api/projects", { host: "unapproved-candidate.vercel.app", bearer: LEGACY_BEARER })).status, 404);
  }, {
    candidateHostFamily: {
      rootHost: CANDIDATE_ROOT_HOST,
      tenantHosts: { legacy: CANDIDATE_LEGACY_HOST }
    }
  });
});

test("Clerk session exchange admits only exact configured user IDs and never accepts an email as identity", async () => {
  await withApp(async ({ client }) => {
    const missing = await client.post("/api/clerk-session", {
      host: ROOT_HOST,
      origin: `https://${ROOT_HOST}`
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("set-cookie"), null);

    const emailAsIdentity = await client.post("/api/clerk-session", {
      host: ROOT_HOST,
      origin: `https://${ROOT_HOST}`,
      clerkUserId: OWNER.email,
      clerkSessionId: "sess_emailMustNotIdentify"
    });
    assert.equal(emailAsIdentity.status, 403);
    assert.equal(emailAsIdentity.headers.get("set-cookie"), null);

    const unauthorized = await client.post("/api/clerk-session", {
      host: ROOT_HOST,
      origin: `https://${ROOT_HOST}`,
      clerkUserId: UNAUTHORIZED_CLERK_USER_ID,
      clerkSessionId: "sess_notAdmitted456"
    });
    assert.equal(unauthorized.status, 403);
    assert.match(unauthorized.data.error, /does not have access/i);
    assert.equal(unauthorized.headers.get("set-cookie"), null);

    const admitted = await client.post("/api/clerk-session", {
      host: ROOT_HOST,
      origin: `https://${ROOT_HOST}`,
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: "sess_explicitAdmission789"
    });
    assert.equal(admitted.status, 201);
    assert.equal(admitted.data.authenticated, true);
    assert.ok(requiredSessionCookie(admitted, rootSessionCookieName(true)));
  });
});

test("handoff identity comes from the access registry and sibling origins cannot mutate", async () => {
  await withApp(async ({ client, rootCookie }) => {
    const handoff = await issueHandoff(client, rootCookie, "legacy");
    const exchanged = await client.post("/api/workspace-handoff", {
      host: LEGACY_HOST,
      origin: `https://${ROOT_HOST}`,
      json: {
        token: handoff,
        providerSubject: "attacker|supplied",
        email: "attacker@example.com",
        displayName: "Impostor"
      }
    });
    assert.equal(exchanged.status, 200);
    const setCookie = exchanged.headers.get("set-cookie");
    assertHostOnlySessionCookie(setCookie);
    const legacyCookie = cookieHeader(setCookie || "");

    const decoded = await verifyTenantSession(new Request(`https://${LEGACY_HOST}/`, {
      headers: { Cookie: legacyCookie }
    }), CLERK_CONFIG.sessionSecret, true);
    assert.ok(decoded);
    assert.equal(decoded.providerSubject, OWNER.providerSubject);
    assert.equal(decoded.email, OWNER.email);
    assert.equal(decoded.displayName, OWNER.displayName);

    const session = await client.get("/api/session", { host: LEGACY_HOST, cookie: legacyCookie });
    assert.equal(session.status, 200);
    assert.equal(session.data.label, OWNER.displayName);
    assert.equal(session.data.email, OWNER.email);
    assert.equal(session.data.rootUrl, `https://${ROOT_HOST}`);
    assert.equal("loginUrl" in session.data, false);
    assert.equal(session.data.logoutUrl, `https://${ROOT_HOST}/auth/logout`);

    const siblingOrigin = await client.post("/api/projects", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      origin: `https://${BETA_HOST}`,
      json: { name: "Cross-Workspace request" }
    });
    assert.equal(siblingOrigin.status, 403);

    const missingOrigin = await client.post("/api/projects", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      json: { name: "Origin omitted" }
    });
    assert.equal(missingOrigin.status, 403);

    const sameOrigin = await client.post("/api/projects", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      origin: `https://${LEGACY_HOST}`,
      json: { name: "Same-origin request" }
    });
    assert.equal(sameOrigin.status, 201);
  });
});

test("tenant sign-out revokes the app session family, then root logout revokes the exact Clerk session without revoking the legacy bearer", async () => {
  await withApp(async ({ client, revokedClerkSessionIds, rootCookie }) => {
    const legacyCookie = await openWorkspace(client, rootCookie, "legacy");
    const betaCookie = await openWorkspace(client, rootCookie, "beta");
    const outstandingBetaHandoff = await issueHandoff(client, rootCookie, "beta");

    assert.equal((await client.get("/api/projects", { host: LEGACY_HOST, cookie: legacyCookie })).status, 200);
    assert.equal((await client.get("/api/projects", { host: BETA_HOST, cookie: betaCookie })).status, 200);

    const signedOut = await client.delete("/api/session", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      origin: `https://${LEGACY_HOST}`
    });
    assert.equal(signedOut.status, 200);
    assert.equal(signedOut.data.logoutUrl, `https://${ROOT_HOST}/auth/logout`);
    assert.deepEqual(revokedClerkSessionIds, []);

    assert.equal((await client.get("/api/projects", { host: LEGACY_HOST, cookie: legacyCookie })).status, 401);
    assert.equal((await client.get("/api/projects", { host: BETA_HOST, cookie: betaCookie })).status, 401);

    const revokedRootList = await client.get("/api/workspaces", {
      host: ROOT_HOST,
      cookie: rootCookie
    });
    assert.equal(revokedRootList.status, 401);

    const revokedRootIssue = await client.post("/api/workspace-handoffs", {
      host: ROOT_HOST,
      cookie: rootCookie,
      origin: `https://${ROOT_HOST}`,
      json: { slug: "legacy" }
    });
    assert.equal(revokedRootIssue.status, 401);

    const revokedOutstandingHandoff = await client.post("/api/workspace-handoff", {
      host: BETA_HOST,
      origin: `https://${ROOT_HOST}`,
      json: { token: outstandingBetaHandoff }
    });
    assert.equal(revokedOutstandingHandoff.status, 401);
    assert.equal(revokedOutstandingHandoff.headers.get("set-cookie"), null);

    const legacyBearerRead = await client.get("/api/projects", {
      host: LEGACY_HOST,
      bearer: LEGACY_BEARER
    });
    assert.equal(legacyBearerRead.status, 200);

    const rootLogout = await client.get("/auth/logout", { host: ROOT_HOST, cookie: rootCookie });
    assert.equal(rootLogout.status, 303);
    assert.equal(rootLogout.headers.get("location"), "/?signout=clerk");
    assert.deepEqual(revokedClerkSessionIds, [OWNER.sessionId]);
  });
});

test("access readiness validates the existing default state and supports retiring the legacy bearer", async () => {
  await withApp(async ({ client, legacyStatePath, rootCookie }) => {
    const health = await client.get("/api/access/health", { host: ROOT_HOST });
    assert.equal(health.status, 200);
    assert.deepEqual(health.data, {
      ok: true,
      authentication: "clerk-session+workspace",
      registry: "file",
      legacyBridge: "disabled",
      registryState: "ready",
      legacyState: "ready",
      legacyBinding: { present: true, status: "ready" },
      missingConfiguration: []
    });
    const serializedHealth = JSON.stringify(health.data);
    for (const secretValue of [OWNER.providerSubject, OWNER.email, OWNER.displayName, LEGACY_BEARER]) {
      assert.doesNotMatch(serializedHealth, new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    assert.equal((await client.get("/api/workspaces", { host: ROOT_HOST, cookie: rootCookie })).status, 200);
    const legacyCookie = await openWorkspace(client, rootCookie, "legacy");
    assert.equal((await client.get("/api/projects", { host: LEGACY_HOST, cookie: legacyCookie })).status, 200);
    assert.equal((await client.get("/api/projects", { host: LEGACY_HOST, bearer: LEGACY_BEARER })).status, 401);
    assert.ok((await fs.stat(legacyStatePath)).isFile());
  }, { apiToken: "" });
});

test("missing default state fails readiness and Project access without auto-creating data", async () => {
  await withApp(async ({ client, legacyStatePath }) => {
    const health = await client.get("/api/access/health", { host: ROOT_HOST });
    assert.equal(health.status, 503);
    assert.equal(health.data.ok, false);
    assert.equal(health.data.legacyState, "missing");
    assert.deepEqual(health.data.legacyBinding, { present: true, status: "ready" });

    const projectRead = await client.get("/api/projects", { host: LEGACY_HOST, bearer: LEGACY_BEARER });
    assert.equal(projectRead.status, 503);
    assert.equal(projectRead.data.error, "Internal server error.");
    await assert.rejects(() => fs.stat(legacyStatePath), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    });
  }, { seedLegacyState: false });
});

test("verified legacy binding refuses an absent default row and preserves its digest when binding succeeds", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-legacy-binding-"));
  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const legacyStatePath = path.join(directory, "legacy-workspace.json");
  const workspaceStoreResolver = createWorkspaceStoreResolver({
    dataPath: legacyStatePath,
    workspaceDirectory: path.join(directory, "workspaces")
  });
  const clerkAuthGateway = createFakeClerkGateway([]);
  const app = createApp({
    accessStore,
    apiToken: LEGACY_BEARER,
    clerkAuthConfig: {
      ...CLERK_CONFIG,
      allowedUserIds: [OWNER.providerSubject, "user_unrelatedOwner456"]
    },
    clerkAuthGateway,
    host: "0.0.0.0",
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "legacy",
    legacyWorkspaceName: "Legacy Workspace",
    requireDatabase: false,
    rootHost: ROOT_HOST,
    store: workspaceStoreResolver.resolve("default"),
    trustForwardedHost: true,
    workspaceStoreResolver
  });
  const server = createServer(app);
  await listen(server);
  const client = new SecurityClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

  async function completeLogin(): Promise<JsonResponse> {
    return client.post("/api/clerk-session", {
      host: ROOT_HOST,
      origin: `https://${ROOT_HOST}`,
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: OWNER.sessionId
    });
  }

  try {
    const unrelatedOwnerCookie = cookieHeader(await createRootSessionCookie({
      providerSubject: "user_unrelatedOwner456",
      email: "unrelated@example.com",
      displayName: "Unrelated Owner",
      sessionId: "unrelated-root-session",
      rootOrigin: `https://${ROOT_HOST}`
    }, CLERK_CONFIG.sessionSecret, true, 3_600));
    const reservedSlug = await client.post("/api/workspaces", {
      host: ROOT_HOST,
      cookie: unrelatedOwnerCookie,
      origin: `https://${ROOT_HOST}`,
      json: { name: "Claimed early", slug: "legacy" }
    });
    assert.equal(reservedSlug.status, 409);
    assert.match(reservedSlug.data.error, /reserved for the configured legacy migration/i);
    assert.deepEqual((await accessStore.read()).workspaces, []);

    const refused = await completeLogin();
    assert.equal(refused.status, 503);
    assert.deepEqual((await accessStore.read()).owners, []);
    assert.deepEqual((await accessStore.read()).workspaces, []);
    await assert.rejects(() => fs.stat(legacyStatePath), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    });

    const populatedState = populatedLegacyState();
    await workspaceStoreResolver.resolve("default").write(populatedState);
    const beforeDigest = crypto.createHash("sha256").update(await fs.readFile(legacyStatePath)).digest("hex");
    const accepted = await completeLogin();
    assert.equal(accepted.status, 201);
    assert.equal(accepted.data.authenticated, true);
    const afterDigest = crypto.createHash("sha256").update(await fs.readFile(legacyStatePath)).digest("hex");
    assert.equal(afterDigest, beforeDigest);
    const registry = await accessStore.read();
    assert.equal(registry.owners.length, 1);
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0].storageId, "default");
    assert.equal(registry.workspaces[0].slug, "legacy");
    assert.equal((await client.get("/api/access/health", { host: ROOT_HOST })).status, 200);
    assert.deepEqual(await workspaceStoreResolver.resolve("default").readExisting(), populatedState);

    const acceptedRootCookie = accepted.headers.getAll("set-cookie").find((cookie) => {
      return cookie.startsWith(`${rootSessionCookieName(true)}=`) && !cookie.includes("Max-Age=0");
    });
    assert.ok(acceptedRootCookie);
    const rootCookie = cookieHeader(acceptedRootCookie);
    const workspaces = await client.get("/api/workspaces", { host: ROOT_HOST, cookie: rootCookie });
    assert.equal(workspaces.status, 200);
    assert.deepEqual(workspaces.data.workspaces.map((workspace: any) => workspace.slug), ["legacy"]);
    const tenantCookie = await openWorkspace(client, rootCookie, "legacy");
    const tenantProjects = await client.get("/api/projects", { host: LEGACY_HOST, cookie: tenantCookie });
    assert.equal(tenantProjects.status, 200);
    assert.deepEqual(tenantProjects.data.projects.map((project: any) => project.id), ["project-existing"]);
  } finally {
    await close(server).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Clerk mode rejects numeric-IP roots before it can issue unusable tenant URLs", () => {
  for (const host of ["127.0.0.1:4317", "[::1]:4317"]) {
    assert.throws(() => createApp({
      host,
      clerkAuthConfig: CLERK_CONFIG,
      clerkAuthGateway: createFakeClerkGateway([]),
      requireDatabase: false
    }), /numeric-IP tenant hosts are unsupported/);
  }
});

test("legacy migration rejects reserved tenant slugs at startup", () => {
  assert.throws(() => createApp({
    host: "localhost",
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "auth",
    legacyWorkspaceName: "Unreachable legacy Workspace",
    clerkAuthConfig: CLERK_CONFIG,
    clerkAuthGateway: createFakeClerkGateway([]),
    requireDatabase: false,
    rootHost: "localhost:4317"
  }), /must be a valid, non-reserved Workspace hostname label/);
});

test("candidate host-family configuration requires Clerk and rejects overlap, duplicate, extra, and missing legacy routes", () => {
  const base = {
    host: "0.0.0.0",
    clerkAuthConfig: CLERK_CONFIG,
    clerkAuthGateway: createFakeClerkGateway([]),
    requireDatabase: false,
    rootHost: ROOT_HOST
  };
  assert.throws(() => createApp({
    host: "localhost",
    clerkAuthConfig: null,
    candidateHostFamily: {
      rootHost: CANDIDATE_ROOT_HOST,
      tenantHosts: { legacy: CANDIDATE_LEGACY_HOST }
    },
    requireDatabase: false,
    rootHost: "localhost"
  }), /requires Clerk authentication/);
  assert.throws(() => createApp({
    ...base,
    candidateHostFamily: {
      rootHost: `candidate.${ROOT_HOST}`,
      tenantHosts: { legacy: CANDIDATE_LEGACY_HOST }
    }
  }), /must not overlap a derived tenant host/);
  assert.throws(() => createApp({
    ...base,
    candidateHostFamily: {
      rootHost: CANDIDATE_ROOT_HOST,
      tenantHosts: {
        legacy: CANDIDATE_LEGACY_HOST,
        LEGACY: `candidate-legacy-duplicate.example.net`
      }
    },
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "legacy",
    legacyWorkspaceName: "Legacy Workspace"
  }), /normalized Workspace slugs must be unique/);
  assert.throws(() => createApp({
    ...base,
    candidateHostFamily: {
      rootHost: CANDIDATE_ROOT_HOST,
      tenantHosts: {
        legacy: CANDIDATE_LEGACY_HOST,
        studio: `candidate-studio.example.net`
      }
    },
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "legacy",
    legacyWorkspaceName: "Legacy Workspace"
  }), /exactly one legacy Workspace route/);
  assert.throws(() => createApp({
    ...base,
    candidateHostFamily: {
      rootHost: CANDIDATE_ROOT_HOST,
      tenantHosts: { studio: CANDIDATE_LEGACY_HOST }
    },
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "legacy",
    legacyWorkspaceName: "Legacy Workspace"
  }), /must contain exactly the configured legacy Workspace slug/);
});

test("Workspace creation returns recoverable validation and conflict responses", async () => {
  await withApp(async ({ client, rootCookie }) => {
    const duplicate = await client.post("/api/workspaces", {
      host: ROOT_HOST,
      cookie: rootCookie,
      origin: `https://${ROOT_HOST}`,
      json: { name: "Duplicate beta", slug: "beta" }
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, "Workspace address is already in use.");

    const invalidName = await client.post("/api/workspaces", {
      host: ROOT_HOST,
      cookie: rootCookie,
      origin: `https://${ROOT_HOST}`,
      json: { name: "x".repeat(121), slug: "valid-slug" }
    });
    assert.equal(invalidName.status, 400);
    assert.match(invalidName.data.error, /120 characters or fewer/);
  });
});

test("tenant registry failures remain service failures instead of appearing as expired sessions", async () => {
  await withApp(async ({ client, setRegistryResolutionFailure }) => {
    setRegistryResolutionFailure(true);
    const response = await client.get("/api/session", { host: LEGACY_HOST });
    assert.equal(response.status, 503);
    assert.equal(response.data.error, "Internal server error.");
  });
});

test("tenant revocation failure remains retryable without a root cookie and revokes sibling sessions", async () => {
  await withApp(async ({ client, rootCookie, setRevocationFailure }) => {
    const legacyCookie = await openWorkspace(client, rootCookie, "legacy");
    const betaCookie = await openWorkspace(client, rootCookie, "beta");
    setRevocationFailure(true);

    const tenantFailure = await client.delete("/api/session", {
      host: LEGACY_HOST,
      cookie: legacyCookie,
      origin: `https://${LEGACY_HOST}`
    });
    assert.equal(tenantFailure.status, 503);
    assert.deepEqual(tenantFailure.data, {
      error: "Global sign-out could not be completed.",
      signedOutHere: true,
      globalSignOutComplete: false
    });
    assert.equal("logoutUrl" in tenantFailure.data, false);
    assert.ok(tenantFailure.headers.getAll("set-cookie").some((cookie) => {
      return cookie.startsWith(`${tenantSessionCookieName(true)}=`) && cookie.includes("Max-Age=0") && !/Domain=/i.test(cookie);
    }));
    const retryCookie = tenantFailure.headers.getAll("set-cookie").find((cookie) => {
      return cookie.startsWith(`${logoutRetryCookieName(true)}=`) && !cookie.includes("Max-Age=0");
    });
    assert.ok(retryCookie);
    assert.doesNotMatch(retryCookie, /Domain=/i);

    assert.equal((await client.get("/api/projects", { host: BETA_HOST, cookie: betaCookie })).status, 200);
    setRevocationFailure(false);
    const retry = await client.delete("/api/session", {
      host: LEGACY_HOST,
      cookie: cookieHeader(retryCookie),
      origin: `https://${LEGACY_HOST}`
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.globalSignOutComplete, true);
    assert.equal(retry.data.logoutUrl, `https://${ROOT_HOST}/auth/logout`);
    assert.ok(retry.headers.getAll("set-cookie").some((cookie) => {
      return cookie.startsWith(`${logoutRetryCookieName(true)}=`) && cookie.includes("Max-Age=0");
    }));
    assert.equal((await client.get("/api/projects", { host: BETA_HOST, cookie: betaCookie })).status, 401);
  });
});

test("Clerk revocation failure preserves a non-authorizing root retry and completes with the same Clerk session", async () => {
  await withApp(async ({ client, revokedClerkSessionIds, rootCookie, setClerkRevocationFailure }) => {
    setClerkRevocationFailure(true);
    const failed = await client.get("/auth/logout", { host: ROOT_HOST, cookie: rootCookie });
    assert.equal(failed.status, 303);
    assert.equal(failed.headers.get("location"), "/?signout=incomplete");
    assert.deepEqual(revokedClerkSessionIds, []);
    assert.ok(failed.headers.getAll("set-cookie").some((cookie) => {
      return cookie.startsWith(`${rootSessionCookieName(true)}=`) && cookie.includes("Max-Age=0");
    }));
    const retryCookie = requiredSessionCookie(failed, logoutRetryCookieName(true));

    const pendingSession = await client.get("/api/session", {
      host: ROOT_HOST,
      cookie: cookieHeader(retryCookie)
    });
    assert.equal(pendingSession.status, 200);
    assert.equal(pendingSession.data.authenticated, false);
    assert.equal(pendingSession.data.context, "root");
    assert.equal(pendingSession.data.logoutRetryPending, true);

    const blockedExchange = await client.post("/api/clerk-session", {
      host: ROOT_HOST,
      cookie: cookieHeader(retryCookie),
      origin: `https://${ROOT_HOST}`,
      clerkUserId: OWNER.providerSubject,
      clerkSessionId: OWNER.sessionId
    });
    assert.equal(blockedExchange.status, 409);
    assert.match(blockedExchange.data.error, /sign-out must complete/i);
    assert.equal(blockedExchange.headers.get("set-cookie"), null);

    setClerkRevocationFailure(false);
    const retried = await client.get("/auth/logout", {
      host: ROOT_HOST,
      cookie: cookieHeader(retryCookie)
    });
    assert.equal(retried.status, 303);
    assert.equal(retried.headers.get("location"), "/?signout=clerk");
    assert.deepEqual(revokedClerkSessionIds, [OWNER.sessionId]);
    assert.ok(retried.headers.getAll("set-cookie").some((cookie) => {
      return cookie.startsWith(`${logoutRetryCookieName(true)}=`) && cookie.includes("Max-Age=0");
    }));
    const recoveredSession = await client.get("/api/session", { host: ROOT_HOST });
    assert.equal(recoveredSession.data.logoutRetryPending, false);
  });
});

interface AppFixture {
  client: SecurityClient;
  rootCookie: string;
  revokedClerkSessionIds: string[];
  legacyWorkspace: AccessWorkspace;
  betaWorkspace: AccessWorkspace;
  legacyStatePath: string;
  advance(milliseconds: number): void;
  setClerkRevocationFailure(value: boolean): void;
  setRevocationFailure(value: boolean): void;
  setRegistryResolutionFailure(value: boolean): void;
}

interface AppFixtureOptions {
  apiToken?: string;
  seedLegacyState?: boolean;
  candidateHostFamily?: {
    rootHost: string;
    tenantHosts: Record<string, string>;
  };
}

async function withApp(operation: (fixture: AppFixture) => Promise<void>, options: AppFixtureOptions = {}): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-workspace-security-"));
  let now = Date.parse("2026-08-12T12:00:00.000Z");
  let revocationFailure = false;
  let clerkRevocationFailure = false;
  let registryResolutionFailure = false;
  const revokedClerkSessionIds: string[] = [];
  const accessStore = createFileAccessStore(path.join(directory, "access.json"), {
    now: () => new Date(now)
  });
  const ownerInput = {
    providerSubject: OWNER.providerSubject,
    email: OWNER.email,
    displayName: OWNER.displayName
  };
  const legacyWorkspace = await accessStore.bindLegacyWorkspace({
    ...ownerInput,
    slug: "legacy",
    name: "Legacy Workspace"
  });
  const betaWorkspace = await accessStore.createWorkspace({
    ...ownerInput,
    slug: "beta",
    name: "Beta Workspace"
  });
  const workspaceStoreResolver = createWorkspaceStoreResolver({
    dataPath: path.join(directory, "legacy-workspace.json"),
    workspaceDirectory: path.join(directory, "workspaces")
  });
  const legacyStatePath = path.join(directory, "legacy-workspace.json");
  if (options.seedLegacyState !== false) await workspaceStoreResolver.resolve("default").write(freshWorkspaceState());
  const applicationAccessStore: AccessStore = {
    ...accessStore,
    getWorkspaceBySlug(slug) {
      if (registryResolutionFailure) return Promise.reject(new Error("Injected access registry lookup outage."));
      return accessStore.getWorkspaceBySlug(slug);
    },
    revokeSession(providerSubject, sessionId) {
      if (revocationFailure) return Promise.reject(new Error("Injected revocation registry outage."));
      return accessStore.revokeSession(providerSubject, sessionId);
    }
  };
  const app = createApp({
    accessStore: applicationAccessStore,
    apiToken: options.apiToken === undefined ? LEGACY_BEARER : options.apiToken,
    candidateHostFamily: options.candidateHostFamily,
    clerkAuthConfig: CLERK_CONFIG,
    clerkAuthGateway: createFakeClerkGateway(revokedClerkSessionIds, () => clerkRevocationFailure),
    host: "0.0.0.0",
    legacyApiWorkspaceId: "default",
    legacyClerkUserId: OWNER.providerSubject,
    legacyWorkspaceSlug: "legacy",
    legacyWorkspaceName: "Legacy Workspace",
    ownerLabel: "Legacy API owner",
    requireDatabase: false,
    rootHost: ROOT_HOST,
    store: workspaceStoreResolver.resolve("default"),
    trustForwardedHost: true,
    workspaceStoreResolver
  });
  const server = createServer(app);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new SecurityClient(baseUrl);

  try {
    const rootCookie = cookieHeader(await createRootSessionCookie(OWNER, CLERK_CONFIG.sessionSecret, true, 3_600));
    await operation({
      client,
      rootCookie,
      revokedClerkSessionIds,
      legacyWorkspace,
      betaWorkspace,
      legacyStatePath,
      advance(milliseconds: number) {
        now += milliseconds;
      },
      setClerkRevocationFailure(value: boolean) {
        clerkRevocationFailure = value;
      },
      setRevocationFailure(value: boolean) {
        revocationFailure = value;
      },
      setRegistryResolutionFailure(value: boolean) {
        registryResolutionFailure = value;
      }
    });
  } finally {
    await close(server).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function issueHandoff(client: SecurityClient, rootCookie: string, slug: string): Promise<string> {
  const issued = await client.post("/api/workspace-handoffs", {
    host: ROOT_HOST,
    cookie: rootCookie,
    origin: `https://${ROOT_HOST}`,
    json: { slug }
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  return issued.data.handoffToken;
}

async function openWorkspace(client: SecurityClient, rootCookie: string, slug: string): Promise<string> {
  const token = await issueHandoff(client, rootCookie, slug);
  const exchanged = await client.post("/api/workspace-handoff", {
    host: `${slug}.kanban.cards`,
    origin: `https://${ROOT_HOST}`,
    json: { token }
  });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.data));
  assertHostOnlySessionCookie(exchanged.headers.get("set-cookie"));
  return cookieHeader(exchanged.headers.get("set-cookie") || "");
}

function assertHostOnlySessionCookie(setCookie: string | null): void {
  assert.ok(setCookie);
  assert.match(setCookie, new RegExp(`^${tenantSessionCookieName(true)}=`));
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Domain=/i);
}

class SecurityClient {
  constructor(private readonly baseUrl: string) {}

  get(pathname: string, options: RequestOptions = {}): Promise<JsonResponse> {
    return this.request("GET", pathname, options);
  }

  post(pathname: string, options: RequestOptions = {}): Promise<JsonResponse> {
    return this.request("POST", pathname, options);
  }

  patch(pathname: string, options: RequestOptions = {}): Promise<JsonResponse> {
    return this.request("PATCH", pathname, options);
  }

  delete(pathname: string, options: RequestOptions = {}): Promise<JsonResponse> {
    return this.request("DELETE", pathname, options);
  }

  private async request(method: string, pathname: string, options: RequestOptions): Promise<JsonResponse> {
    const headers: Record<string, string> = {
      Host: options.host || ROOT_HOST,
      "X-Forwarded-Proto": "https"
    };
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    if (options.clerkUserId) headers["X-Test-Clerk-User"] = options.clerkUserId;
    if (options.clerkSessionId) headers["X-Test-Clerk-Session"] = options.clerkSessionId;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.version !== undefined) headers["X-Kanban-Version"] = String(options.version);
    let body: string | undefined;
    if (options.form !== undefined) {
      body = new URLSearchParams(options.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const target = new URL(pathname, this.baseUrl);
    return await new Promise<JsonResponse>((resolve, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method,
        path: `${target.pathname}${target.search}`,
        headers
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode || 0,
            headers: new HeaderView(response.headers),
            data: text ? parseResponse(text) : null
          });
        });
      });
      request.once("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}

interface RequestOptions {
  host?: string;
  bearer?: string;
  cookie?: string;
  origin?: string;
  clerkUserId?: string;
  clerkSessionId?: string;
  idempotencyKey?: string;
  version?: number;
  form?: Record<string, string>;
  json?: Record<string, unknown>;
}

interface JsonResponse {
  status: number;
  headers: HeaderView;
  data: any;
}

class HeaderView {
  constructor(private readonly headers: IncomingHttpHeaders) {}

  get(name: string): string | null {
    const value = this.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] || null;
    return value === undefined ? null : String(value);
  }

  getAll(name: string): string[] {
    const value = this.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value.map(String);
    return value === undefined ? [] : [String(value)];
  }
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createFakeClerkGateway(
  revokedSessionIds: string[],
  shouldFailRevocation: () => boolean = () => false
): ClerkAuthGateway {
  return {
    middleware(rootOrigins) {
      assert.ok(rootOrigins.length > 0);
      return (_req, _res, next) => next();
    },
    requestAuth(req) {
      const clerkUserId = req.get("x-test-clerk-user") || null;
      const clerkSessionId = req.get("x-test-clerk-session") || null;
      return {
        authenticated: Boolean(clerkUserId && clerkSessionId),
        clerkUserId,
        clerkSessionId
      };
    },
    async verifiedIdentity(clerkUserId, clerkSessionId) {
      if (clerkUserId !== OWNER.providerSubject) throw new Error("Unexpected fake Clerk identity lookup.");
      return {
        clerkUserId,
        clerkSessionId,
        email: OWNER.email,
        displayName: OWNER.displayName
      };
    },
    async revokeSession(clerkSessionId) {
      if (shouldFailRevocation()) throw new Error("Injected Clerk revocation outage.");
      revokedSessionIds.push(clerkSessionId);
    }
  };
}

function requiredSessionCookie(response: JsonResponse, name: string): string {
  const cookie = response.headers.getAll("set-cookie").find((value) => {
    return value.startsWith(`${name}=`) && !value.includes("Max-Age=0");
  });
  assert.ok(cookie, `Expected ${name} in ${JSON.stringify(response.data)}`);
  return cookie;
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

function populatedLegacyState() {
  return {
    schemaVersion: 2 as const,
    projects: [{
      id: "project-existing",
      name: "Existing Project",
      description: "Preserve every resource field.",
      columns: [
        { id: "next", name: "Next", position: 0 },
        { id: "done", name: "Done", position: 1 }
      ],
      cards: [{
        id: "card-existing",
        externalKey: "existing:card",
        title: "Existing Card",
        body: "Existing body",
        columnId: "done",
        position: 0,
        version: 7,
        archivedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        comments: [{
          id: "comment-existing",
          body: "Existing Comment",
          author: "Existing owner",
          createdAt: "2026-08-02T00:00:00.000Z"
        }]
      }],
      activity: [{
        id: "activity-existing",
        action: "comment.created",
        actor: { channel: "api" as const, label: "Existing owner" },
        summary: "Existing owner commented on Existing Card.",
        projectId: "project-existing",
        cardId: "card-existing",
        createdAt: "2026-08-02T00:00:00.000Z"
      }],
      revision: 11,
      archivedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    }],
    idempotencyRecords: [{
      key: "existing-idempotency-key",
      method: "POST" as const,
      path: "/api/projects/project-existing/cards",
      requestHash: "existing-request-hash",
      statusCode: 201,
      response: { card: { id: "card-existing", version: 7 } },
      createdAt: "2026-08-01T00:00:00.000Z"
    }]
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
