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
const CLERK_FRONTEND_API_ORIGIN = "https://clerk.workspace-access.test";
const CLERK_PUBLISHABLE_KEY = clerkPublishableKey("test", new URL(CLERK_FRONTEND_API_ORIGIN).hostname);
const CLERK_UI_SCRIPT_URL = `${CLERK_FRONTEND_API_ORIGIN}/npm/@clerk/ui@1/dist/ui.browser.js`;
const CLERK_JS_SCRIPT_URL = `${CLERK_FRONTEND_API_ORIGIN}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
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
  authSignInUrl: string;
  clerkFrontendApiOrigin: string;
  clerkPublishableKey: string;
  rootSessionCookie: string;
  candidateTenantOrigin?: string;
  revokedClerkSessionIds: string[];
  setClerkRevocationFailure(value: boolean): void;
  setRevocationFailure(value: boolean): void;
  stop(): Promise<void>;
}

test.beforeAll(async () => {
  await assertChromiumInstalled();
});

test.beforeEach(async ({ page }) => {
  await installClerkFrontendApiRoutes(page);
});

test("the single exact candidate route automatically opens its Workspace on the server-supplied tenant alias", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness({ candidateAliases: true });
  const errors = monitorBrowserErrors(page);

  try {
    await Promise.all([
      harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "mike", name: "Mike's Workspace" }),
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
    await expect(page.locator(`script[src^="${harness.clerkFrontendApiOrigin}"]`)).toHaveCount(0);
    expect(await page.evaluate(async () => (
      await fetch("/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js")
    ).status)).toBe(404);
    expectNoUnexpectedBrowserErrors(errors, [/404/]);
  } finally {
    await harness.stop();
  }
});

test("the nested candidate root navigates directly to the exact auth form", async ({ page }) => {
  const harness = await startWorkspaceAccessHarness({ candidateAliases: true });
  const clerkRequests: string[] = [];
  const retiredProxyRequests: string[] = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === harness.clerkFrontendApiOrigin && requestUrl.pathname.startsWith("/npm/@clerk/")) {
      clerkRequests.push(request.url());
    }
    if (requestUrl.pathname.startsWith("/__clerk/")) retiredProxyRequests.push(request.url());
  });

  try {
    const expectedAuthUrl = `${harness.authSignInUrl}#/?redirect_url=${encodeURIComponent(new URL(harness.rootOrigin).href)}`;
    await page.route(harness.authSignInUrl, (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Sign in</title>"
    }));
    const authRequest = page.waitForRequest(harness.authSignInUrl);
    await page.goto(`${harness.rootOrigin}/`);
    expect((await authRequest).url()).toBe(harness.authSignInUrl);
    await expect(page).toHaveURL(expectedAuthUrl);
    expect(clerkRequests).toEqual([
      CLERK_UI_SCRIPT_URL,
      CLERK_JS_SCRIPT_URL
    ]);
    expect(retiredProxyRequests).toEqual([]);
    expect(page.url()).not.toContain("auth0");
  } finally {
    await harness.stop();
  }
});

test("the app root rejects malformed Clerk auth-host redirect links", async ({ context }) => {
  const harness = await startWorkspaceAccessHarness({ candidateAliases: true });
  const encodedRootOrigin = encodeURIComponent(new URL(harness.rootOrigin).href);
  const authHost = new URL(harness.authOrigin).host;
  const authPort = new URL(harness.authOrigin).port;
  const cases: Array<{ name: string; signInUrl: string }> = [
    {
      name: "outer query",
      signInUrl: `${harness.authSignInUrl}?from=untrusted#/?redirect_url=${encodedRootOrigin}`
    },
    {
      name: "wrong fragment route",
      signInUrl: `${harness.authSignInUrl}#/continue?redirect_url=${encodedRootOrigin}`
    },
    {
      name: "duplicate redirect",
      signInUrl: `${harness.authSignInUrl}#/?redirect_url=${encodedRootOrigin}&redirect_url=${encodedRootOrigin}`
    },
    {
      name: "unrelated redirect control",
      signInUrl: `${harness.authSignInUrl}#/?redirect_url=${encodedRootOrigin}&return_url=${encodedRootOrigin}`
    },
    {
      name: "wrong initiating origin",
      signInUrl: `${harness.authSignInUrl}#/?redirect_url=${encodeURIComponent("https://untrusted.example")}`
    },
    {
      name: "wrong auth origin",
      signInUrl: `http://untrusted.localhost${authPort ? `:${authPort}` : ""}/sign-in#/?redirect_url=${encodedRootOrigin}`
    },
    {
      name: "credentials",
      signInUrl: `http://user:password@${authHost}/sign-in#/?redirect_url=${encodedRootOrigin}`
    }
  ];

  try {
    for (const unsafeCase of cases) {
      await test.step(unsafeCase.name, async () => {
        const casePage = await context.newPage();
        await installClerkFrontendApiRoutes(casePage);
        await casePage.addInitScript((signInUrl) => {
          window.localStorage.setItem("kanban.tests:clerk-sign-in-url-override", signInUrl);
        }, unsafeCase.signInUrl);
        try {
          await casePage.goto(`${harness.rootOrigin}/`);
          await expect(casePage.getByText("Sign-in is unavailable")).toBeVisible();
          await expect(casePage.getByText("Try again later.")).toBeVisible();
          await expect(casePage.getByRole("link", { name: "Continue" })).toHaveCount(0);
          await expect(casePage.getByRole("link", { name: "Create account" })).toHaveCount(0);
        } finally {
          await casePage.close();
        }
      });
    }
  } finally {
    await harness.stop();
  }
});

test("the dedicated auth host renders only the email-code sign-in form", async ({ page, request }) => {
  const harness = await startWorkspaceAccessHarness();

  try {
    for (const pathname of ["/", "/index.html"]) {
      const redirect = await request.get(`${harness.authOrigin}${pathname}`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      expect(redirect.headers().location).toBe("/sign-in");
    }
    await page.goto(`${harness.authOrigin}/sign-in`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(page.locator(".clerk-test-panel")).toHaveCount(1);
    await expect(page.locator(".access-card")).toHaveCount(0);
    await expect(page.getByText("Create account", { exact: true })).toHaveCount(0);
    const visibleText = await page.locator("body").innerText();
    for (const forbidden of ["Clerk", "Secure account access", "This host verifies", "Workspace or Project", "Private workspaces"]) {
      expect(visibleText).not.toContain(forbidden);
    }
    await page.getByLabel("Email address").fill("mike@example.test");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveCount(0);
    await expect(page.locator(`script[src="${CLERK_UI_SCRIPT_URL}"]`)).toHaveCount(1);
    const clerkScript = page.locator(`script[src="${CLERK_JS_SCRIPT_URL}"]`);
    await expect(clerkScript).toHaveCount(1);
    expect(await clerkScript.getAttribute("data-clerk-publishable-key")).toBe(harness.clerkPublishableKey);
    expect(await clerkScript.getAttribute("data-clerk-proxy-url")).toBeNull();
    const primaryRuntime = await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { loadOptions: Record<string, unknown>; mountSignInOptions: Record<string, unknown>; mountSignInCalls: number; buildSignInCalls: number; buildSignUpCalls: number; mountSignUpCalls: number };
    }).__kanbanClerkTest);
    expect(primaryRuntime.loadOptions).toMatchObject({
      signInUrl: harness.authSignInUrl,
      signUpUrl: harness.authSignInUrl.replace(/\/sign-in$/, "/sign-up"),
      allowedRedirectOrigins: [harness.rootOrigin],
      localization: {
        formButtonPrimary: "Continue",
        formFieldLabel__emailAddress: "Email address",
        signIn: {
          start: { title: "Sign in", titleCombined: "Sign in", subtitle: "", subtitleCombined: "" },
          emailCode: { title: "Verification code", subtitle: "", formTitle: "Verification code", resendButton: "Resend code" }
        }
      },
      appearance: { elements: { headerSubtitle: { display: "none" } } }
    });
    expect(primaryRuntime.loadOptions.isSatellite).toBeUndefined();
    expect(primaryRuntime.loadOptions.domain).toBeUndefined();
    expect(primaryRuntime.loadOptions.satelliteAutoSync).toBeUndefined();
    expect(primaryRuntime.loadOptions.proxyUrl).toBeUndefined();
    expect(primaryRuntime.mountSignInCalls).toBe(1);
    expect(primaryRuntime.mountSignInOptions).toMatchObject({ routing: "hash", withSignUp: false, transferable: false });
    expect(primaryRuntime.mountSignUpCalls).toBe(0);
    expect(primaryRuntime.buildSignInCalls).toBe(0);
    expect(primaryRuntime.buildSignUpCalls).toBe(0);
    const legacyHash = `#/?redirect_url=${encodeURIComponent(new URL(harness.rootOrigin).href)}`;
    await page.goto(`${harness.authOrigin}/sign-up${legacyHash}`);
    await expect(page).toHaveURL(`${harness.authOrigin}/sign-in${legacyHash}`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Create account", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.localStorage.setItem("kanban.tests:clerk-mount-error", "1"));
    await page.reload();
    await expect(page.getByText("Sign-in is unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("Try again later.", { exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("Clerk internal provider failure");

    for (const pathname of ["/api/health", "/api/access/health", "/api/workspaces", "/api/projects", "/api/workspace-handoffs"]) {
      expect((await request.get(`${harness.authOrigin}${pathname}`)).status()).toBe(404);
    }
    expect((await request.post(`${harness.authOrigin}/api/clerk-session`, { headers: { Origin: harness.authOrigin } })).status()).toBe(404);
    expect((await request.get(`${harness.authOrigin}/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js`)).status()).toBe(404);
    const session = await request.get(`${harness.authOrigin}/api/session`);
    expect(session.status()).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: false, context: "auth" });
  } finally {
    await harness.stop();
  }
});

test("a verified Clerk browser session exchanges into the app without an OIDC redirect", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  await page.addInitScript(() => {
    if (window.localStorage.getItem("kanban.tests:clerk-seed-applied") === "1") return;
    window.localStorage.setItem("kanban.tests:clerk-seed-applied", "1");
    window.localStorage.setItem("kanban.tests:clerk-signed-in", "1");
  });

  try {
    const exchangeRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname === "/api/clerk-session";
    });
    await page.goto(`${harness.rootOrigin}/`);

    expect((await exchangeRequest).url()).toBe(`${harness.rootOrigin}/api/clerk-session`);
    await expect(page.locator(`script[src="${CLERK_JS_SCRIPT_URL}"]`)).toHaveCount(1);
    expect(await page.locator(`script[src="${CLERK_JS_SCRIPT_URL}"]`).getAttribute("data-clerk-proxy-url")).toBeNull();
    await expect(page.getByRole("heading", { name: "Create a Workspace" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(true);
    expect(page.url()).toBe(`${harness.rootOrigin}/`);
  } finally {
    await harness.stop();
  }
});

test("a forged root completion query cannot sign out an active tenant when the root app cookie is absent", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  const logoutRequests: Array<{ method: string; url: string }> = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname === "/auth/logout"
      || pathname === "/api/session" && request.method() === "DELETE"
      || pathname === "/api/logout-completion" && request.method() === "DELETE"
    ) {
      logoutRequests.push({ method: request.method(), url: request.url() });
    }
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("kanban.tests:clerk-seed-applied") === "1") return;
    window.localStorage.setItem("kanban.tests:clerk-seed-applied", "1");
    window.localStorage.setItem("kanban.tests:clerk-signed-in", "1");
  });

  try {
    await harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" });
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    const tenantOrigin = `http://studio.${harness.rootHost}`;
    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    await context.clearCookies({ name: ROOT_SESSION_COOKIE_DEV });
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(false);

    await page.goto(`${harness.rootOrigin}/?signout=clerk`);

    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-workspace");
    await expect(page.getByText("Signed out", { exact: true })).toHaveCount(0);
    expect(logoutRequests).toEqual([]);
    expect((await context.cookies(tenantOrigin)).some((cookie) => cookie.name === TENANT_SESSION_COOKIE_DEV)).toBe(true);
    expect(harness.revokedClerkSessionIds).toEqual([]);
    const rootStorage = (await context.storageState()).origins.find((origin) => origin.origin === harness.rootOrigin)?.localStorage || [];
    expect(rootStorage.find((entry) => entry.name === "kanban.tests:clerk-signed-in")?.value).toBe("1");
    expect(await page.evaluate(async () => {
      const response = await fetch("/api/session", { credentials: "same-origin" });
      return (await response.json() as { authenticated: boolean }).authenticated;
    })).toBe(true);

    await page.goto(`${harness.rootOrigin}/?signout=complete`);
    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.getByText("Signed out", { exact: true })).toHaveCount(0);
    expect(logoutRequests).toEqual([]);
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
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === ROOT_SESSION_COOKIE_DEV)).toBe(false);
    expect((await context.cookies(`http://studio.${harness.rootHost}`)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(true);

    harness.setRevocationFailure(false);
    const completionRequestPromise = page.waitForRequest((request) => {
      return request.method() === "POST" && new URL(request.url()).pathname === "/auth/logout";
    });
    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    const completionRequest = await completionRequestPromise;
    const completionUrl = new URL(completionRequest.url());
    expect(completionRequest.url()).toBe(`${harness.rootOrigin}/auth/logout`);
    expect(completionUrl.search).toBe("");
    expect(completionUrl.hash).toBe("");
    expect(completionRequest.headers().origin).toBe(`http://studio.${harness.rootHost}`);
    expect(completionRequest.postData() || "").toMatch(/^continuation=[A-Za-z0-9._%+-]+$/);
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await context.cookies(`http://studio.${harness.rootHost}`)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { sessionEndCalls: number };
    }).__kanbanClerkTest.sessionEndCalls)).toBe(0);
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("Clerk revocation outage preserves a non-authorizing retry path and completes after recovery", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  const clerkSessionExchanges: string[] = [];
  const completionRequests: string[] = [];
  let deleteRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/clerk-session") {
      clerkSessionExchanges.push(request.url());
    }
    if (request.method() === "POST" && pathname === "/auth/logout") completionRequests.push(request.url());
    if (request.method() === "DELETE" && pathname === "/api/session") deleteRequests += 1;
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("kanban.tests:clerk-seed-applied") === "1") return;
    window.localStorage.setItem("kanban.tests:clerk-seed-applied", "1");
    window.localStorage.setItem("kanban.tests:clerk-signed-in", "1");
  });

  try {
    await harness.accessStore.createWorkspace({ ...ROOT_SESSION, slug: "studio", name: "Studio" });
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    const tenantOrigin = `http://studio.${harness.rootHost}`;
    await expect(page).toHaveURL(`${tenantOrigin}/`);

    harness.setClerkRevocationFailure(true);
    await page.getByRole("button", { name: "Open account panel" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect((await context.cookies(tenantOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(true);
    expect(harness.revokedClerkSessionIds).toEqual([]);
    expect(completionRequests).toEqual([]);
    expect(deleteRequests).toBe(1);
    expect(clerkSessionExchanges).toEqual([]);

    await page.reload();
    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect(clerkSessionExchanges).toEqual([]);

    await page.goto(`${tenantOrigin}/?signout=clerk`);
    await expect(page).toHaveURL(`${tenantOrigin}/`);
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBe("1");
    expect(completionRequests).toEqual([]);
    expect(clerkSessionExchanges).toEqual([]);

    harness.setClerkRevocationFailure(false);
    const completionRequestPromise = page.waitForRequest((request) => {
      return request.method() === "POST" && new URL(request.url()).pathname === "/auth/logout";
    });
    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    await completionRequestPromise;
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await context.cookies(tenantOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { sessionEndCalls: number };
    }).__kanbanClerkTest.sessionEndCalls)).toBe(1);
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBeNull();
    expect(completionRequests).toEqual([`${harness.rootOrigin}/auth/logout`]);
    expect(deleteRequests).toBe(2);
    expect(clerkSessionExchanges).toEqual([]);

    await page.goto(`http://studio.${harness.rootHost}/`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("browser-side Clerk cleanup can retry without reminting or re-revoking the app session", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  let deleteRequests = 0;
  let completionRequests = 0;
  let completionAcks = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "DELETE" && pathname === "/api/session") deleteRequests += 1;
    if (request.method() === "POST" && pathname === "/auth/logout") completionRequests += 1;
    if (request.method() === "DELETE" && pathname === "/api/logout-completion") completionAcks += 1;
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("kanban.tests:clerk-seed-applied") === "1") return;
    window.localStorage.setItem("kanban.tests:clerk-seed-applied", "1");
    window.localStorage.setItem("kanban.tests:clerk-signed-in", "1");
  });

  try {
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    await page.evaluate(() => window.localStorage.setItem("kanban.tests:clerk-sign-out-fail-once", "1"));
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page).toHaveURL(`${harness.rootOrigin}/?signout=clerk`);
    await expect(page.getByText("Sign-out incomplete", { exact: true })).toBeVisible();
    await expect(page.getByText("Sign-out could not be completed. Try again.", { exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("Clerk browser sign-out is temporarily unavailable");
    await expect(page.getByRole("button", { name: "Retry global sign-out" })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBe("1");
    expect(deleteRequests).toBe(1);
    expect(completionRequests).toBe(1);
    expect(completionAcks).toBe(0);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);

    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.tests:clerk-signed-in"))).toBeNull();
    expect(deleteRequests).toBe(1);
    expect(completionRequests).toBe(1);
    expect(completionAcks).toBe(1);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => (window as unknown as {
      __kanbanClerkTest: { sessionEndCalls: number; sessionEndIds: string[] };
    }).__kanbanClerkTest)).toMatchObject({
      sessionEndCalls: 2,
      sessionEndIds: [ROOT_SESSION.sessionId, ROOT_SESSION.sessionId]
    });
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("an already-absent target Clerk session completes without ending another browser account", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);
  let completionAcks = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/logout-completion") {
      completionAcks += 1;
    }
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("kanban.tests:clerk-seed-applied") === "1") return;
    window.localStorage.setItem("kanban.tests:clerk-seed-applied", "1");
    window.localStorage.setItem("kanban.tests:clerk-signed-in", "1");
  });

  try {
    await seedRootSession(context, harness);
    await page.goto(`${harness.rootOrigin}/`);
    await page.evaluate(() => {
      window.localStorage.setItem("kanban.tests:clerk-target-absent", "1");
      window.localStorage.setItem("kanban.tests:clerk-other-session-id", "sess_otherBrowserAccount456");
    });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
    expect(completionAcks).toBe(1);
    expect(harness.revokedClerkSessionIds).toEqual([ROOT_SESSION.sessionId]);
    expect(await page.evaluate(() => {
      const clerk = (window as unknown as {
        Clerk: { client: { signedInSessions: Array<{ id: string }> } };
        __kanbanClerkTest: { sessionEndCalls: number; signOutCalls: number };
      });
      return {
        sessionIds: clerk.Clerk.client.signedInSessions.map((session) => session.id),
        sessionEndCalls: clerk.__kanbanClerkTest.sessionEndCalls,
        signOutCalls: clerk.__kanbanClerkTest.signOutCalls
      };
    })).toEqual({
      sessionIds: ["sess_otherBrowserAccount456"],
      sessionEndCalls: 0,
      signOutCalls: 0
    });
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

async function startWorkspaceAccessHarness(options: { candidateAliases?: boolean } = {}): Promise<WorkspaceAccessHarness> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-workspace-access-browser-"));
  const port = await availablePort();
  const primaryRootHost = `localhost:${port}`;
  const candidateRootHost = `candidate.release.localhost:${port}`;
  const candidateTenantHost = `mike.candidate.release.localhost:${port}`;
  const authHost = `auth.localhost:${port}`;
  const rootHost = options.candidateAliases ? candidateRootHost : primaryRootHost;
  const rootOrigin = `http://${rootHost}`;
  const rootSession = { ...ROOT_SESSION, rootOrigin };
  const clerkAuthConfig: ClerkAuthConfig = {
    publishableKey: CLERK_PUBLISHABLE_KEY,
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
  let clerkRevocationFailure = false;
  const revokedClerkSessionIds: string[] = [];
  const clerkAuthGateway = createBrowserClerkGateway(revokedClerkSessionIds, () => clerkRevocationFailure);
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
      tenantHosts: { mike: candidateTenantHost }
    } : undefined,
    clerkAuthConfig,
    clerkAuthGateway,
    dataPath: path.join(temporaryDirectory, "legacy-workspace.json"),
    host: "localhost",
    legacyClerkUserId: options.candidateAliases ? ROOT_SESSION.providerSubject : undefined,
    legacyWorkspaceSlug: options.candidateAliases ? "mike" : undefined,
    legacyWorkspaceName: options.candidateAliases ? "Mike's Workspace" : undefined,
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
      authSignInUrl: `http://${authHost}/sign-in`,
      clerkFrontendApiOrigin: CLERK_FRONTEND_API_ORIGIN,
      clerkPublishableKey: CLERK_PUBLISHABLE_KEY,
      rootSessionCookie,
      revokedClerkSessionIds,
      ...(options.candidateAliases ? { candidateTenantOrigin: `http://${candidateTenantHost}` } : {}),
      setClerkRevocationFailure(value: boolean) {
        clerkRevocationFailure = value;
      },
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

function createBrowserClerkGateway(
  revokedSessionIds: string[],
  shouldFailRevocation: () => boolean = () => false
): ClerkAuthGateway {
  return {
    middleware(rootDomains) {
      expect(rootDomains.length).toBeGreaterThan(0);
      return (_req, _res, next) => next();
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
      if (shouldFailRevocation()) throw new Error("Injected browser Clerk revocation outage.");
      revokedSessionIds.push(clerkSessionId);
    }
  };
}

async function installClerkFrontendApiRoutes(page: Page): Promise<void> {
  await page.route(CLERK_UI_SCRIPT_URL, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: "window.__internal_ClerkUICtor = function ClerkUI() {};\n"
  }));
  await page.route(CLERK_JS_SCRIPT_URL, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: `
      var targetSessionId = ${JSON.stringify(ROOT_SESSION.sessionId)};
      var otherSessionId = window.localStorage.getItem("kanban.tests:clerk-other-session-id") || "";
      var targetSession = {
        id: targetSessionId,
        end: async function () {
          window.__kanbanClerkTest.sessionEndCalls += 1;
          window.__kanbanClerkTest.sessionEndIds.push(targetSessionId);
          window.localStorage.setItem("kanban.tests:clerk-session-end-calls", String(window.__kanbanClerkTest.sessionEndCalls));
          window.localStorage.setItem("kanban.tests:clerk-session-end-ids", JSON.stringify(window.__kanbanClerkTest.sessionEndIds));
          if (window.localStorage.getItem("kanban.tests:clerk-sign-out-fail-once") === "1") {
            window.localStorage.removeItem("kanban.tests:clerk-sign-out-fail-once");
            throw new Error("Clerk browser sign-out is temporarily unavailable.");
          }
          window.localStorage.removeItem("kanban.tests:clerk-signed-in");
          window.Clerk.client.signedInSessions = window.Clerk.client.signedInSessions.filter(function (session) { return session.id !== targetSessionId; });
          window.Clerk.session = window.Clerk.client.signedInSessions[0] || null;
          window.Clerk.isSignedIn = window.Clerk.client.signedInSessions.length > 0;
        }
      };
      var otherSession = otherSessionId ? { id: otherSessionId, end: async function () { throw new Error("The unrelated Clerk session must not end."); } } : null;
      var targetPresent = window.localStorage.getItem("kanban.tests:clerk-target-absent") !== "1"
        && window.localStorage.getItem("kanban.tests:clerk-signed-in") === "1";
      var browserSessions = [];
      if (targetPresent) browserSessions.push(targetSession);
      if (otherSession) browserSessions.push(otherSession);
      window.Clerk = {
        isSignedIn: browserSessions.length > 0,
        session: browserSessions[0] || null,
        client: { signedInSessions: browserSessions },
        load: async function (options) { window.__kanbanClerkTest.loadOptions = options; },
        buildSignInUrl: function (options) {
          window.__kanbanClerkTest.buildSignInCalls += 1;
          window.__kanbanClerkTest.buildSignInRedirects.push(options && options.redirectUrl || "");
          var builtUrl = window.localStorage.getItem("kanban.tests:clerk-sign-in-url-override")
            || window.__kanbanClerkTest.loadOptions.signInUrl + "#/?redirect_url=" + encodeURIComponent(new URL(options && options.redirectUrl || "").href);
          window.__kanbanClerkTest.builtSignInUrls.push(builtUrl);
          return builtUrl;
        },
        buildSignUpUrl: function (options) {
          window.__kanbanClerkTest.buildSignUpCalls += 1;
          window.__kanbanClerkTest.buildSignUpRedirects.push(options && options.redirectUrl || "");
          return window.localStorage.getItem("kanban.tests:clerk-sign-up-url-override")
            || window.__kanbanClerkTest.loadOptions.signUpUrl + "#/?redirect_url=" + encodeURIComponent(new URL(options && options.redirectUrl || "").href);
        },
        mountSignIn: function (node, options) {
          window.__kanbanClerkTest.mountSignInCalls += 1;
          window.__kanbanClerkTest.mountSignInOptions = options || {};
          if (window.localStorage.getItem("kanban.tests:clerk-mount-error") === "1") {
            window.localStorage.removeItem("kanban.tests:clerk-mount-error");
            throw new Error("Clerk internal provider failure");
          }
          var panel = document.createElement("section");
          panel.className = "clerk-test-panel";
          var brand = document.createElement("p");
          brand.textContent = "kanban.cards";
          var heading = document.createElement("h1");
          heading.textContent = "Sign in";
          var form = document.createElement("form");
          var label = document.createElement("label");
          label.htmlFor = "clerk-test-email";
          label.textContent = "Email address";
          var input = document.createElement("input");
          input.id = "clerk-test-email";
          input.name = "email";
          input.type = "email";
          var button = document.createElement("button");
          button.type = "submit";
          button.textContent = "Continue";
          form.append(label, input, button);
          form.addEventListener("submit", function (event) {
            event.preventDefault();
            label.htmlFor = "clerk-test-code";
            label.textContent = "Verification code";
            input.id = "clerk-test-code";
            input.name = "code";
            input.type = "text";
            input.value = "";
          });
          panel.append(brand, heading, form);
          node.replaceChildren(panel);
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
        signOut: async function (options) {
          window.__kanbanClerkTest.signOutCalls += 1;
          window.__kanbanClerkTest.signOutSessionIds.push(options && options.sessionId || "");
          window.__kanbanClerkTest.signOutRedirects.push(options && options.redirectUrl || "");
          window.localStorage.setItem("kanban.tests:clerk-sign-out-calls", String(window.__kanbanClerkTest.signOutCalls));
          window.localStorage.setItem("kanban.tests:clerk-sign-out-session-ids", JSON.stringify(window.__kanbanClerkTest.signOutSessionIds));
          window.localStorage.setItem("kanban.tests:clerk-sign-out-redirects", JSON.stringify(window.__kanbanClerkTest.signOutRedirects));
          if (window.localStorage.getItem("kanban.tests:clerk-sign-out-fail-once") === "1") {
            window.localStorage.removeItem("kanban.tests:clerk-sign-out-fail-once");
            throw new Error("Clerk browser sign-out is temporarily unavailable.");
          }
          window.localStorage.removeItem("kanban.tests:clerk-signed-in");
          this.isSignedIn = false;
          this.session = null;
          if (options && options.redirectUrl) window.location.assign(options.redirectUrl);
        }
      };
      window.__kanbanClerkTest = {
        loadOptions: {},
        mountSignInCalls: 0,
        mountSignInOptions: {},
        mountSignUpCalls: 0,
        buildSignInCalls: 0,
        buildSignUpCalls: 0,
        buildSignInRedirects: [],
        buildSignUpRedirects: [],
        builtSignInUrls: [],
        signOutCalls: Number(window.localStorage.getItem("kanban.tests:clerk-sign-out-calls") || "0"),
        signOutSessionIds: JSON.parse(window.localStorage.getItem("kanban.tests:clerk-sign-out-session-ids") || "[]"),
        signOutRedirects: JSON.parse(window.localStorage.getItem("kanban.tests:clerk-sign-out-redirects") || "[]"),
        sessionEndCalls: Number(window.localStorage.getItem("kanban.tests:clerk-session-end-calls") || "0"),
        sessionEndIds: JSON.parse(window.localStorage.getItem("kanban.tests:clerk-session-end-ids") || "[]")
      };
    `
  }));
}

function clerkPublishableKey(instance: "test" | "live", frontendApi: string): string {
  const encoded = Buffer.from(`${frontendApi}$`, "utf8").toString("base64").replace(/=+$/, "");
  return `pk_${instance}_${encoded}`;
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
