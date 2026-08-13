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
  type PlatformAuthConfig,
  type RootSession
} from "../../src/platform-auth";
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
  providerSubject: "oidc|workspace-browser-owner",
  email: "browser-owner@example.com",
  displayName: "Browser Owner",
  sessionId: "root-session-browser-workspace-access"
};

interface WorkspaceAccessHarness {
  accessStore: AccessStore;
  rootHost: string;
  rootOrigin: string;
  rootSessionCookie: string;
  setRevocationFailure(value: boolean): void;
  stop(): Promise<void>;
}

test.beforeAll(async () => {
  await assertChromiumInstalled();
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
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    expect((await context.cookies(`http://studio.${harness.rootHost}`)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("root logout outage preserves a non-authorizing retry path and completes after recovery", async ({ page, context }) => {
  const harness = await startWorkspaceAccessHarness();
  const errors = monitorBrowserErrors(page);

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

    harness.setRevocationFailure(false);
    await page.getByRole("button", { name: "Retry global sign-out" }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    expect((await context.cookies(harness.rootOrigin)).some((cookie) => cookie.name === LOGOUT_RETRY_COOKIE_DEV)).toBe(false);

    await page.goto(`http://studio.${harness.rootHost}/`);
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

async function startWorkspaceAccessHarness(): Promise<WorkspaceAccessHarness> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-workspace-access-browser-"));
  const port = await availablePort();
  const rootHost = `localhost:${port}`;
  const rootOrigin = `http://${rootHost}`;
  const platformAuthConfig: PlatformAuthConfig = {
    issuer: "https://identity.example.com",
    clientId: "workspace-access-browser",
    redirectUri: `${rootOrigin}/auth/callback`,
    postLogoutRedirectUri: "/",
    sessionSecret: SESSION_SECRET,
    surfaceId: "kanban.cards",
    scope: "openid profile email",
    rootSessionTtlSeconds: 3_600,
    tenantSessionTtlSeconds: 3_600
  };
  const accessStore = createFileAccessStore(path.join(temporaryDirectory, "access.json"));
  let revocationFailure = false;
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
    dataPath: path.join(temporaryDirectory, "legacy-workspace.json"),
    host: "localhost",
    platformAuthConfig,
    requireDatabase: false,
    staticDir: repositoryRoot,
    workspaceStoreResolver
  }));

  try {
    await listen(server, port);
    const rootSessionCookie = await createRootSessionCookie(
      ROOT_SESSION,
      SESSION_SECRET,
      false,
      platformAuthConfig.rootSessionTtlSeconds
    );
    return {
      accessStore,
      rootHost,
      rootOrigin,
      rootSessionCookie,
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
