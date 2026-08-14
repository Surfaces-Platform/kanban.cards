/// <reference lib="dom" />

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { createFileAccessStore, type AccessStore } from "../../src/access-store";
import {
  createRootSessionCookie,
  LOGOUT_RETRY_COOKIE_DEV,
  ROOT_SESSION_COOKIE_DEV,
  TENANT_SESSION_COOKIE_DEV,
  type RootSession
} from "../../src/app-sessions";
import type { ClerkAuthConfig, ClerkAuthGateway } from "../../src/clerk-auth";
import { createApp } from "../../src/server";
import { createWorkspaceStoreResolver } from "../../src/state-store";
import {
  assertChromiumInstalled,
  expectNoHorizontalOverflow,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors
} from "./support/context-dock-harness";

const SESSION_SECRET = "workspace-access-browser-secret-with-more-than-32-characters";
const ROOT_SESSION: RootSession = {
  providerSubject: "user_workspaceBrowserOwner123",
  email: "browser-owner@example.com",
  displayName: "Browser Owner",
  sessionId: "sess_browserWorkspaceAccess123",
  rootOrigin: "http://localhost"
};

interface WorkspaceAccessHarness {
  accessStore: AccessStore;
  rootHost: string;
  rootOrigin: string;
  authOrigin: string;
  primarySignInUrl: string;
  rootSessionCookie: string;
  candidateTenantOrigin?: string;
  revokedClerkSessionIds: string[];
  setRevocationFailure(value: boolean): void;
  stop(): Promise<void>;
}

test.beforeAll(async () => {
  await assertChromiumInstalled();
});

test("the single exact candidate route automatically opens its Workspace on the server-supplied tenant alias", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness({ candidateAliases: true });
  const errors = monitorBrowserErrors(page);

  try {
    await Promise.all([
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" }),
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "research", name: "Research" })
    ]);
    await seedRootSession(context, harness);
    const handoffRequest = page.waitForRequest((request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/workspace-handoff"
    );
    await page.goto(`${harness.rootOrigin}/`);

    expect(harness.candidateTenantOrigin).toBeTruthy();
    expect((await handoffRequest).url()).toBe(`${harness.candidateTenantOrigin}/api/workspace-handoff`);
    await expect(page).toHaveURL(`${harness.candidateTenantOrigin}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("candidate sign-in loads Clerk from its exact root proxy and redirects through the primary", async ({ page }) => {
  const harness = await startWorkspaceAccessHarness({ candidateAliases: true });
  const clerkRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/__clerk/")) clerkRequests.push(request.url());
  });

  try {
    await page.goto(`${harness.rootOrigin}/`);
    await expect(page.getByRole("heading", { name: "Sign in or create your account" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with email" })).toBeVisible();
    expect(clerkRequests).toEqual([
      `${harness.rootOrigin}/__clerk/npm/@clerk/ui@1/dist/ui.browser.js`,
      `${harness.rootOrigin}/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js`
    ]);
    expect(clerkRequests.every((url) => new URL(url).origin === harness.rootOrigin)).toBe(true);
    expect(page.url()).not.toContain("auth0");
    const satelliteRuntime = await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { loadOptions: Record<string, unknown>; mountSignInCalls: number; buildSignInCalls: number; buildSignUpCalls: number };
    }).__kanbanClerkTest);
    expect(satelliteRuntime.loadOptions).toMatchObject({
      isSatellite: true,
      signInUrl: harness.primarySignInUrl,
      signUpUrl: harness.primarySignInUrl.replace(/\/sign-in$/, "/sign-up")
    });
    expect(satelliteRuntime.loadOptions.allowedRedirectOrigins).toBeUndefined();
    expect(satelliteRuntime.mountSignInCalls).toBe(0);
    expect(satelliteRuntime.buildSignInCalls).toBe(1);
    expect(satelliteRuntime.buildSignUpCalls).toBe(1);

    const signInLink = page.getByRole("link", { name: "Continue with email" });
    const signInUrl = await signInLink.getAttribute("href");
    expect(signInUrl).toContain(`${harness.primarySignInUrl}?__clerk_synced=false`);
    expect(signInUrl).toContain(encodeURIComponent(harness.rootOrigin));
    await page.route(signInUrl!, (route) => route.fulfill({ status: 200, body: "Satellite redirect reached primary sign-in." }));
    const primaryRequest = page.waitForRequest(signInUrl!);
    await signInLink.click();
    expect((await primaryRequest).url()).toBe(signInUrl);
  } finally {
    await harness.stop();
  }
});

test("the dedicated auth host mounts Clerk locally and cannot expose or mint app sessions", async ({ page, request }) => {
  const harness = await startWorkspaceAccessHarness();

  try {
    for (const pathname of ["/", "/index.html"]) {
      const redirect = await request.get(`${harness.authOrigin}${pathname}`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      expect(redirect.headers().location).toBe("/sign-in");
    }
    await page.goto(`${harness.authOrigin}/sign-in`);
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
    const primaryRuntime = await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { loadOptions: Record<string, unknown>; mountSignInCalls: number; buildSignInCalls: number; buildSignUpCalls: number };
    }).__kanbanClerkTest);
    expect(primaryRuntime.loadOptions).toMatchObject({
      isSatellite: false,
      signInUrl: harness.primarySignInUrl,
      signUpUrl: harness.primarySignInUrl.replace(/\/sign-in$/, "/sign-up"),
      allowedRedirectOrigins: [harness.rootOrigin]
    });
    expect(primaryRuntime.mountSignInCalls).toBe(1);
    expect(primaryRuntime.buildSignInCalls).toBe(0);
    expect(primaryRuntime.buildSignUpCalls).toBe(0);
    await page.goto(`${harness.authOrigin}/sign-up`);
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();

    for (const pathname of ["/api/health", "/api/access/health", "/api/workspaces", "/api/projects", "/api/workspace-handoffs"]) {
      expect((await request.get(`${harness.authOrigin}${pathname}`)).status()).toBe(404);
    }
    expect((await request.post(`${harness.authOrigin}/api/clerk-session`, { headers: { Origin: harness.authOrigin } })).status()).toBe(404);
    const session = await request.get(`${harness.authOrigin}/api/session`);
    expect(session.status()).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: false, context: "auth" });
  } finally {
    await harness.stop();
  }
});

test("a verified Clerk browser session exchanges into the app without an OIDC redirect", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  await page.addInitScript(() => window.localStorage.setItem("kanban.tests:clerk-signed-in", "1"));

  try {
    const exchangeRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname === "/api/clerk-session";
    });
    await page.goto(`${harness.rootOrigin}/`);

    expect((await exchangeRequest).url()).toBe(`${harness.rootOrigin}/api/clerk-session`);
    await expect(page.getByRole("heading", { name: "Create a Workspace" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(true);
    expect(page.url()).toBe(`${harness.rootOrigin}/`);
  } finally {
    await harness.stop();
  }
});

test("a direct Clerk completion query cannot leave an app session behind a signed-out success state", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  const logoutRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/auth/logout") logoutRequests.push(request.url());
  });
  await page.addInitScript(() => window.localStorage.setItem("kanban.tests:clerk-signed-in", "1"));

  try {
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/?signout=clerk`);

    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "sign-out-success");
    await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
    expect(logoutRequests).toEqual([`${harness.rootOrigin}/auth/logout`]);
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(false);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { signOutCalls: number };
    }).__kanbanClerkTest.signOutCalls)).toBe(1);
    expect(await page.evaluate(async () => {
      const response = await fetch("/api/session", { credentials: "same-origin" });
      return (await response.json() as { authenticated: boolean }).authenticated;
    })).toBe(false);
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("unsafe Workspace origins are not rendered as navigation choices", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);

  try {
    await Promise.all([
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" }),
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "research", name: "Research" })
    ]);
    await seedRootSession(context, harness);
    await page.route("**/api/workspaces", async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as { workspaces: Array<Record<string, unknown>> };
      payload.workspaces.push(
        { id: "unsafe-scheme", slug: "unsafe-scheme", name: "Unsafe scheme", url: "javascript:alert(1)" },
        { id: "unsafe-http", slug: "unsafe-http", name: "Unsafe HTTP", url: "http://example.com" },
        { id: "unsafe-credentials", slug: "unsafe-credentials", name: "Unsafe credentials", url: `http://owner:secret@unsafe.localhost:${new URL(harness.rootOrigin).port}` },
        { id: "unsafe-path", slug: "unsafe-path", name: "Unsafe path", url: `http://unsafe.localhost:${new URL(harness.rootOrigin).port}/private` },
        { id: "unsafe-query", slug: "unsafe-query", name: "Unsafe query", url: `http://unsafe.localhost:${new URL(harness.rootOrigin).port}/?next=evil` },
        { id: "unsafe-hash", slug: "unsafe-hash", name: "Unsafe hash", url: `http://unsafe.localhost:${new URL(harness.rootOrigin).port}/#evil` }
      );
      await route.fulfill({ response, json: payload });
    });

    await page.goto(`${harness.rootOrigin}/`);

    await expect(page.getByRole("heading", { name: "Choose a Workspace" })).toBeVisible();
    await expect(page.locator(".workspace-choice")).toHaveCount(2);
    await expect(page.getByText(/^Unsafe /)).toHaveCount(0);
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("zero Workspaces create through a cross-host form handoff into an empty tenant", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  const requestUrls: string[] = [];
  const requestCookies: Array<{ url: string; cookie: string }> = [];
  page.on("request", (request) => {
    requestUrls.push(request.url());
    requestCookies.push({ url: request.url(), cookie: request.headers().cookie || "" });
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);

    await expect(page.locator("body")).toHaveAttribute("data-state", "workspace-route");
    await expect(page.getByRole("heading", { name: "Create a Workspace" })).toBeVisible();
    await expect(page.getByLabel("Workspace name")).toBeFocused();
    await expectNoHorizontalOverflow(page, "zero-Workspace route at 390px");

    const rootCookie = (await context.cookies(harness.rootOrigin)).find((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV);
    expect(rootCookie).toMatchObject({
      domain: "localhost",
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: false
    });
    expect(harness.rootSessionCookie).toContain(`${ROOT_SESSION_COOKIE_DEV}=`);
    expect(harness.rootSessionCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
    expect(harness.rootSessionCookie).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);

    await page.getByLabel("Workspace name").fill("Studio");
    await page.getByLabel("Workspace address").fill("studio");
    const apiHandoffResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.hostname === "localhost" && url.pathname === "/api/workspace-handoffs";
    });
    const formHandoffRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.hostname === "studio.localhost" && url.pathname === "/api/workspace-handoff";
    });

    await page.getByRole("button", { name: "Create Workspace" }).click();
    expect((await apiHandoffResponse).status()).toBe(201);
    const handoffRequest = await formHandoffRequest;
    const handoffUrl = new URL(handoffRequest.url());
    const handoffToken = String(new URLSearchParams(handoffRequest.postData() || "").get("token") || "");
    expect(handoffToken).toMatch(/^kch_[A-Za-z0-9_-]{43}$/);
    expect(handoffUrl.search).toBe("");
    expect(handoffRequest.url()).not.toContain(handoffToken);
    expect(handoffRequest.headers()["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(handoffRequest.headers().cookie || "").not.toContain(ROOT_SESSION_COOKIE_DEV);

    const handoffResponse = await handoffRequest.response();
    expect(handoffResponse?.status()).toBe(303);
    const tenantSetCookie = await handoffResponse?.headerValue("set-cookie");
    expect(tenantSetCookie).toContain(`${TENANT_SESSION_COOKIE_DEV}=`);
    expect(tenantSetCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
    expect(tenantSetCookie).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);

    const tenantOrigin = `http://studio.${harness.rootHost}`;
    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-workspace");
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "empty tenant at 390px");

    const storage = await readBrowserStorage(page);
    expect(JSON.stringify(storage)).not.toContain(handoffToken);
    expect(await page.content()).not.toContain(handoffToken);
    expect(page.url()).not.toContain(handoffToken);
    expect(requestUrls.every((url) => !url.includes(handoffToken))).toBe(true);

    const tenantCookie = (await context.cookies(tenantOrigin)).find((cookie) => cookie.name === TENANT_SESSION_COOKIE_DEV);
    expect(tenantCookie).toMatchObject({
      domain: "studio.localhost",
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      secure: false
    });
    const tenantRequests = requestCookies.filter((request) => new URL(request.url).hostname === "studio.localhost");
    expect(tenantRequests.length).toBeGreaterThan(1);
    expect(tenantRequests.every((request) => !request.cookie.includes(`${ROOT_SESSION_COOKIE_DEV}=`))).toBe(true);
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === TENANT_SESSION_COOKIE_DEV)).toBe(false);
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("multiple Workspaces render an explicit chooser at a narrow viewport", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);

  try {
    await Promise.all([
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" }),
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "research", name: "Research" })
    ]);
    await seedRootSession(context, harness);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`${harness.rootOrigin}/`);

    await expect(page.locator("body")).toHaveAttribute("data-state", "workspace-route");
    await expect(page.getByRole("heading", { name: "Choose a Workspace" })).toBeVisible();
    await expect(page.locator(".workspace-choice")).toHaveCount(2);
    await expect(page.locator(".workspace-choice").filter({ hasText: "Research" })).toContainText("research");
    await expect(page.locator(".workspace-choice").filter({ hasText: "Studio" })).toContainText("studio");
    await expect(page.getByRole("button", { name: "Open", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "multi-Workspace chooser at 360px");
    expect((await context.cookies()).filter((cookie) => cookie.name === TENANT_SESSION_COOKIE_DEV)).toEqual([]);
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("incomplete global sign-out clears private UI without claiming success", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);

  try {
    await harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" });
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    await expect(page).toHaveURL(`http://studio.${harness.rootHost}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    await context.clearCookies({ name: ROOT_SESSION_COOKIE_DEV });
    harness.setRevocationFailure(true);

    await page.getByRole("button", { name: "Open account panel" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByText(/another Workspace session may still be active/)).toBeVisible();
    await expect(page.getByText("Signed out", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to sign in" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(false);
    expect((await context.cookies(`http://studio.${harness.rootHost}`)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(true);

    harness.setRevocationFailure(false);
    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByRole("heading", { name: "Sign in or create your account" })).toBeVisible();
    expect((await context.cookies(`http://studio.${harness.rootHost}`)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("root logout outage preserves a non-authorizing retry path and completes after recovery", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  const clerkSessionExchanges: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/clerk-session") {
      clerkSessionExchanges.push(request.url());
    }
  });
  await page.addInitScript(() => window.localStorage.setItem("kanban.tests:clerk-signed-in", "1"));

  try {
    await harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" });
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    await expect(page).toHaveURL(`http://studio.${harness.rootHost}/`);

    harness.setRevocationFailure(true);
    await page.goto(`${harness.rootOrigin}/auth/logout`);
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(false);
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(true);
    expect(clerkSessionExchanges).toEqual([]);

    await page.reload();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(true);
    expect(clerkSessionExchanges).toEqual([]);

    await page.goto(`${harness.rootOrigin}/?signout=clerk`);
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBe("1");
    expect(clerkSessionExchanges).toEqual([]);

    harness.setRevocationFailure(false);
    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByRole("heading", { name: "Sign in or create your account" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { signOutCalls: number };
    }).__kanbanClerkTest.signOutCalls)).toBe(1);
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBeNull();
    expect(clerkSessionExchanges).toEqual([]);

    await page.goto(`http://studio.${harness.rootHost}/`);
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

async function startWorkspaceAccessHarness(options: { candidateAliases?: boolean } = {}): Promise<WorkspaceAccessHarness> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-workspace-access-browser-"));
  const port = await availablePort();
  const primaryPort = options.candidateAliases ? await availablePort() : port;
  const primaryRootHost = `localhost:${primaryPort}`;
  const candidateRootHost = `localhost:${port}`;
  const candidateTenantHost = `candidate-studio.localhost:${port}`;
  const authHost = `auth.localhost:${port}`;
  const rootHost = options.candidateAliases ? candidateRootHost : primaryRootHost;
  const rootOrigin = `http://${rootHost}`;
  const rootSession = { ...ROOT_SESSION, rootOrigin };
  const clerkAuthConfig: ClerkAuthConfig = {
    publishableKey: "pk_test_workspace_access_browser",
    secretKey: "sk_test_workspace_access_browser",
    encryptionKey: "workspace-access-browser-clerk-encryption-key-0123456789",
    sessionSecret: SESSION_SECRET,
    authHost,
    allowedUserIds: [ROOT_SESSION.providerSubject],
    rootSessionTtlSeconds: 3_600,
    tenantSessionTtlSeconds: 3_600
  };
  const accessStore = createFileAccessStore(path.join(temporaryDirectory, "access.json"));
  let revocationFailure = false;
  const revokedClerkSessionIds: string[] = [];
  const clerkAuthGateway = createBrowserClerkGateway(revokedClerkSessionIds);
  const applicationAccessStore: AccessStore = {
    ...accessStore,
    revokeSession(providerSubject, sessionId) {
      if (revocationFailure) return Promise.reject(new Error("Injected browser revocation outage."));
      return accessStore.revokeSession(providerSubject, sessionId);
    }
  };
  const workspaceStoreResolver = createWorkspaceStoreResolver({
    dataPath: path.join(temporaryDirectory, "legacy-workspace.json"),
    workspaceDirectory: path.join(temporaryDirectory, "workspaces")
  });
  const repositoryRoot = path.resolve(__dirname, "../..");
  const server = createServer(createApp({
    accessStore: applicationAccessStore,
    candidateHostFamily: options.candidateAliases ? {
      rootHost: candidateRootHost,
      tenantHosts: { studio: candidateTenantHost }
    } : undefined,
    clerkAuthConfig,
    clerkAuthGateway,
    dataPath: path.join(temporaryDirectory, "legacy-workspace.json"),
    host: "localhost",
    legacyClerkUserId: options.candidateAliases ? ROOT_SESSION.providerSubject : undefined,
    legacyWorkspaceSlug: options.candidateAliases ? "studio" : undefined,
    legacyWorkspaceName: options.candidateAliases ? "Studio" : undefined,
    requireDatabase: false,
    rootHost: primaryRootHost,
    staticDir: repositoryRoot,
    workspaceStoreResolver
  }));

  try {
    await listen(server, port);
    const rootSessionCookie = await createRootSessionCookie(
      rootSession,
      SESSION_SECRET,
      false,
      clerkAuthConfig.rootSessionTtlSeconds
    );
    return {
      accessStore,
      rootHost,
      rootOrigin,
      authOrigin: `http://${authHost}`,
      primarySignInUrl: `http://${authHost}/sign-in`,
      rootSessionCookie,
      revokedClerkSessionIds,
      ...(options.candidateAliases ? { candidateTenantOrigin: `http://${candidateTenantHost}` } : {}),
      setRevocationFailure(value: boolean) {
        revocationFailure = value;
      },
      async stop() {
        await close(server);
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await close(server).catch(() => undefined);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function createBrowserClerkGateway(revokedSessionIds: string[]): ClerkAuthGateway {
  return {
    middleware(rootDomains) {
      expect(rootDomains.length).toBeGreaterThan(0);
      return (req, res, next) => {
        if (req.path === "/__clerk/npm/@clerk/ui@1/dist/ui.browser.js") {
          res.type("application/javascript").send("window.__internal_ClerkUICtor = function ClerkUI() {};\n");
          return;
        }
        if (req.path === "/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js") {
          res.type("application/javascript").send(`
            window.Clerk = {
              isSignedIn: window.localStorage.getItem("kanban.tests:clerk-signed-in") === "1",
              load: async function (options) { window.__kanbanClerkTest.loadOptions = options; },
              buildSignInUrl: function () {
                window.__kanbanClerkTest.buildSignInCalls += 1;
                return window.__kanbanClerkTest.loadOptions.signInUrl + "?__clerk_synced=false&redirect_url=" + encodeURIComponent(window.location.origin);
              },
              buildSignUpUrl: function () {
                window.__kanbanClerkTest.buildSignUpCalls += 1;
                return window.__kanbanClerkTest.loadOptions.signUpUrl + "?__clerk_synced=false&redirect_url=" + encodeURIComponent(window.location.origin);
              },
              mountSignIn: function (node) {
                window.__kanbanClerkTest.mountSignInCalls += 1;
                var button = document.createElement("button");
                button.type = "button";
                button.textContent = "Continue with email";
                node.replaceChildren(button);
              },
              mountSignUp: function (node) {
                window.__kanbanClerkTest.mountSignUpCalls += 1;
                var button = document.createElement("button");
                button.type = "button";
                button.textContent = "Create account";
                node.replaceChildren(button);
              },
              unmountSignIn: function (node) { node.replaceChildren(); },
              unmountSignUp: function (node) { node.replaceChildren(); },
              signOut: async function () {
                window.__kanbanClerkTest.signOutCalls += 1;
                window.localStorage.removeItem("kanban.tests:clerk-signed-in");
                this.isSignedIn = false;
              }
            };
            window.__kanbanClerkTest = { loadOptions: {}, mountSignInCalls: 0, mountSignUpCalls: 0, buildSignInCalls: 0, buildSignUpCalls: 0, signOutCalls: 0 };
          `);
          return;
        }
        next();
      };
    },
    requestAuth(req) {
      const clerkUserId = req.get("x-test-clerk-user") || ROOT_SESSION.providerSubject;
      const clerkSessionId = req.get("x-test-clerk-session") || ROOT_SESSION.sessionId;
      return { authenticated: true, clerkUserId, clerkSessionId };
    },
    async verifiedIdentity(clerkUserId, clerkSessionId) {
      return {
        clerkUserId,
        clerkSessionId,
        email: ROOT_SESSION.email,
        displayName: ROOT_SESSION.displayName
      };
    },
    async revokeSession(clerkSessionId) {
      revokedSessionIds.push(clerkSessionId);
    }
  };
}

async function seedRootSession(context: BrowserContext, harness: WorkspaceAccessHarness): Promise<void> {
  const pair = harness.rootSessionCookie.split(";", 1)[0];
  const separator = pair.indexOf("=");
  if (separator < 1) throw new Error("The seeded root cookie was invalid.");
  const name = pair.slice(0, separator);
  const value = decodeURIComponent(pair.slice(separator + 1));
  if (name !== ROOT_SESSION_COOKIE_DEV) throw new Error("Expected a development root-session cookie.");
  await context.addCookies([{
    name,
    value,
    url: harness.rootOrigin,
    httpOnly: true,
    secure: false,
    sameSite: "Lax"
  }]);
}

async function readBrowserStorage(page: Page): Promise<{ local: Record<string, string>; session: Record<string, string> }> {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(window.localStorage)),
    session: Object.fromEntries(Object.entries(window.sessionStorage))
  }));
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    probe.once("error", onError);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", onError);
      resolve();
    });
  });
  const port = (probe.address() as AddressInfo).port;
  await close(probe);
  return port;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
