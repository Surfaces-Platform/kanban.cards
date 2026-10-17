/// <reference lib="dom" />

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { createFileAccessStore, type AccessStore } from "../../src/access-store";
import { createApp } from "../../src/server";
import { hashSecret } from "../../src/passkey-auth";
import { createWorkspaceStoreResolver } from "../../src/state-store";
import { assertChromiumInstalled, expectNoHorizontalOverflow } from "./support/context-dock-harness";

const SESSION_SECRET = "passkey-browser-secret-with-more-than-32-characters";
const SETUP_TOKEN = "test-only-single-owner-setup-token-with-entropy";
interface Harness {
  accessStore: AccessStore;
  rootOrigin: string;
  networkOrigin: string;
  authOrigin: string;
  setupOwnerId?: string;
  tenantOrigin(slug: string): string;
  stop(): Promise<void>;
}
interface Authenticator { cdp: CDPSession; id: string }

test.beforeAll(assertChromiumInstalled);

async function authenticator(context: BrowserContext, page: Page): Promise<Authenticator> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  });
  return { cdp, id: authenticatorId };
}

async function signup(page: Page, harness: Harness, slug: string): Promise<string> {
  await page.goto(harness.rootOrigin);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(`${harness.authOrigin}/sign-up`);
  await page.getByLabel("Workspace name", { exact: true }).fill(`${slug} Workspace`);
  await page.getByLabel("Workspace address", { exact: true }).fill(slug);
  await page.getByLabel("Your name (optional)").fill(`${slug} Owner`);
  await page.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery code", exact: true })).toBeVisible();
  const code = await page.locator("#recovery-code").innerText();
  expect(code).toMatch(/^kcr_owner-.+\./);
  await expectNoHorizontalOverflow(page, "Passkey access surface");
  // The code remains visible until the owner explicitly acknowledges saving it.
  expect(new URL(page.url()).origin).toBe(harness.authOrigin);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(storage).not.toContain(code);
  expect(page.url()).not.toContain(code);
  await page.getByRole("button", { name: "I saved my recovery code", exact: true }).click();
  await expect(page).toHaveURL(`${harness.tenantOrigin(slug)}/`);
  await expect(page.getByRole("heading", { name: "Create the first Project", exact: true })).toBeVisible();
  return code;
}

async function signout(page: Page, harness: Harness): Promise<void> {
  await page.getByRole("button", { name: "Open account panel", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(`${harness.rootOrigin}/`);
  await expect(page.getByRole("heading", { name: "Signed out", exact: true })).toBeVisible();
  await expect(page.locator("main button")).toHaveCount(1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await expect(page.getByLabel("Active Project", { exact: true })).toContainText(name);
}

test("real passkeys create isolated owner Workspaces and scoped agent keys", async ({ page, context, browser }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  const firstAuthenticator = await authenticator(context, page);
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await authenticator(secondContext, secondPage);
  try {
    await signup(page, harness, "alpha");
    await createProject(page, "Alpha private project");
    await signup(secondPage, harness, "beta");
    await createProject(secondPage, "Beta private project");
    const wrongTenant = await context.request.get(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("beta")).host, Cookie: (await context.cookies(harness.tenantOrigin("alpha"))).map(cookie => `${cookie.name}=${cookie.value}`).join("; ") } });
    expect(wrongTenant.status()).toBe(401);
    expect(await wrongTenant.text()).not.toContain("Beta private project");
    const betaProjects = await secondPage.evaluate(async () => (await fetch("/api/projects")).text());
    expect(betaProjects).not.toContain("Alpha private project");

    await page.getByRole("button", { name: "Open account panel", exact: true }).click();
    await page.getByRole("button", { name: "Agent connections", exact: true }).click();
    await page.getByLabel("Label", { exact: true }).fill("Read-only agent");
    await page.getByLabel("Scopes", { exact: true }).selectOption("read");
    await page.getByRole("button", { name: "Create connection", exact: true }).click();
    const credential = await page.locator("#agent-credential").innerText();
    const allowed = await context.request.get(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("alpha")).host, Authorization: `Bearer ${credential}` } });
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toContain("Alpha private project");
    const forbidden = await context.request.get(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("beta")).host, Authorization: `Bearer ${credential}` } });
    expect(forbidden.status()).toBe(401);
    const write = await context.request.post(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("alpha")).host, Authorization: `Bearer ${credential}`, "Content-Type": "application/json", "Idempotency-Key": "read-only-forbidden" }, data: { name: "Forbidden" } });
    expect(write.status()).toBe(403);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    const revoked = await context.request.get(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("alpha")).host, Authorization: `Bearer ${credential}` } });
    expect(revoked.status()).toBe(401);
    const state = await harness.accessStore.read();
    expect(JSON.stringify(state)).not.toContain(credential);
    expect(state.owners).toHaveLength(2);
    expect(state.passkeys).toHaveLength(2);
    expect(firstAuthenticator.id).toBeTruthy();
  } finally { await Promise.allSettled([secondContext.close(), harness.stop()]); }
});

test("Workspace menu creates another Workspace, keeps errors, cancels back, and switches without leaking Projects", async ({ page, context }) => {
  test.setTimeout(90_000);
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "studio");
    await createProject(page, "Studio private project");
    const switcher = page.getByRole("button", { name: "Workspace: studio Workspace", exact: true });
    await switcher.click();
    await expect(page.locator("#workspace-switcher-panel")).toContainText("current Workspace");
    await expect(page.getByRole("button", { name: "New Workspace…", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#workspace-switcher-panel")).toHaveCount(0);
    await expect(switcher).toBeFocused();
    await switcher.click();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByLabel("Workspace name", { exact: true })).toBeFocused();
    await page.getByLabel("Workspace name", { exact: true }).fill("Cancelled Workspace");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("studio")}/`);
    await expect(page.getByLabel("Active Project", { exact: true })).toContainText("Studio private project");
    expect((await harness.accessStore.read()).workspaces).toHaveLength(1);

    await page.setViewportSize({ width: 320, height: 720 });
    await switcher.click();
    await expectNoHorizontalOverflow(page, "320px Workspace menu");
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Research Workspace");
    await page.getByLabel("Workspace address", { exact: true }).fill("bad address");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByText("Workspace details needed", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("Research Workspace");
    await expect(page.getByLabel("Workspace address", { exact: true })).toHaveValue("bad address");
    await page.getByLabel("Workspace address", { exact: true }).fill("studio");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByText("Workspace address is already in use.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("Research Workspace");
    await expect(page.getByLabel("Workspace address", { exact: true })).toHaveValue("studio");
    await expectNoHorizontalOverflow(page, "320px Workspace creation validation");
    await page.getByLabel("Workspace address", { exact: true }).fill("research");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("research")}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Workspace: Research Workspace", exact: true })).toBeVisible();
    await expect(page.getByText("Studio private project", { exact: true })).toHaveCount(0);
    expect((await harness.accessStore.read()).workspaces).toHaveLength(2);
    await page.getByRole("button", { name: "Workspace: Research Workspace", exact: true }).click();
    await page.getByRole("button", { name: "Switch Workspace…", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose a Workspace", exact: true })).toBeVisible();
    await page.locator(".workspace-choice").filter({ hasText: "studio Workspace" }).getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("studio")}/`);
    await expect(page.getByLabel("Active Project", { exact: true })).toContainText("Studio private project");
  } finally { await harness.stop(); }
});

test("Workspace navigation preserves an unsaved new Card and Comment", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "drafts");
    await createProject(page, "Draft Project");
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "New Card", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("A retained new Card");
    await page.getByRole("button", { name: "Workspace: drafts Workspace", exact: true }).click();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("drafts")}/`);
    await expect(page.getByText("Workspace change paused", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("A retained new Card");
    await page.locator(".card-inspector").getByRole("button", { name: "Create Card", exact: true }).click();
    await expect(page.getByLabel("Add Comment", { exact: true })).toBeVisible();
    await page.getByLabel("Add Comment", { exact: true }).fill("Keep this unsent Comment");
    await page.getByRole("button", { name: "Workspace: drafts Workspace", exact: true }).click();
    await page.getByRole("button", { name: "Switch Workspace…", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("drafts")}/`);
    await expect(page.getByText("Workspace change paused", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Add Comment", { exact: true })).toHaveValue("Keep this unsent Comment");
    expect((await harness.accessStore.read()).workspaces).toHaveLength(1);
  } finally { await harness.stop(); }
});

test("Workspace creation reconciles a lost response and retries opening without another creation", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  await authenticator(context, page);
  let creationRequests = 0;
  let handoffRequests = 0;
  try {
    await signup(page, harness, "original");
    await page.getByRole("button", { name: "Workspace: original Workspace", exact: true }).click();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await page.route("**/api/workspaces", async route => {
      if (route.request().method() !== "POST") return route.continue();
      creationRequests += 1;
      await route.fetch();
      await route.abort("failed");
    });
    await page.route("**/api/workspace-handoffs", async route => {
      handoffRequests += 1;
      if (handoffRequests === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Workspace opening is temporarily unavailable." }) });
      return route.continue();
    });
    await page.getByLabel("Workspace name", { exact: true }).fill("Created once");
    await page.getByLabel("Workspace address", { exact: true }).fill("created-once");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Workspace created", exact: true })).toBeVisible();
    await expect(page.getByText("Workspace created; opening failed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Workspace", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("created-once")}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project", exact: true })).toBeVisible();
    expect(creationRequests).toBe(1);
    expect((await harness.accessStore.read()).workspaces).toHaveLength(2);
  } finally { await harness.stop(); }
});

test("an uncertain Workspace creation retries its original intent and never adopts a known duplicate", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  await authenticator(context, page);
  let dropPost = true;
  let failRead = true;
  let creationRequests = 0;
  try {
    await signup(page, harness, "existing");
    await page.getByRole("button", { name: "Workspace: existing Workspace", exact: true }).click();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await expect(page.getByLabel("Workspace name", { exact: true })).toBeVisible();
    await page.route("**/api/workspaces", async route => {
      if (route.request().method() === "GET") {
        if (failRead) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Inventory offline" }) });
        return route.continue();
      }
      if (route.request().method() !== "POST") return route.continue();
      creationRequests += 1;
      if (dropPost) { await route.fetch(); return route.abort("failed"); }
      return route.continue();
    });
    await page.getByLabel("Workspace name", { exact: true }).fill("Created after retry");
    await page.getByLabel("Workspace address", { exact: true }).fill("retry-created");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByText("Workspace creation could not be confirmed", { exact: true })).toBeVisible();
    expect((await harness.accessStore.read()).workspaces).toHaveLength(2);
    dropPost = false;
    failRead = false;
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("retry-created")}/`);
    expect(creationRequests).toBe(2);
    expect((await harness.accessStore.read()).workspaces).toHaveLength(2);

    await page.getByRole("button", { name: "Workspace: Created after retry", exact: true }).click();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    dropPost = true;
    await page.getByLabel("Workspace name", { exact: true }).fill("existing Workspace");
    await page.getByLabel("Workspace address", { exact: true }).fill("existing");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByText("Workspace creation could not be confirmed", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("existing Workspace");
    await expect(page.getByRole("button", { name: "Open Workspace", exact: true })).toHaveCount(0);
    dropPost = false;
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page.getByText("Workspace address is already in use.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
  } finally { await harness.stop(); }
});

test("New Workspace intent survives passkey sign-in without storing the form draft", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "signin-intent");
    await signout(page, harness);
    await page.goto(`${harness.rootOrigin}/?new-workspace=1&return-workspace=signin-intent`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Continue with passkey", exact: true }).click();
    await expect(page).toHaveURL(`${harness.rootOrigin}/`);
    await expect(page.getByRole("heading", { name: "Create a Workspace", exact: true })).toBeVisible();
    await page.getByLabel("Workspace name", { exact: true }).fill("This draft stays in memory");
    await page.getByLabel("Workspace address", { exact: true }).fill("not-persisted");
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(stored).not.toContain("This draft stays in memory");
    expect(stored).not.toContain("not-persisted");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("signin-intent")}/`);
    await page.goto(`${harness.rootOrigin}/?workspaces=1`);
    expect(await page.evaluate(() => sessionStorage.getItem("kanban.cards:workspace-route"))).toBeTruthy();
    await page.getByRole("button", { name: "New Workspace…", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("kanban.cards:workspace-route"))).toBeNull();
  } finally { await harness.stop(); }
});

test("an owner with no Workspaces has a visible first-Workspace creation form", async ({ page, context }) => {
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "removed");
    await harness.accessStore.authTransaction(state => {
      // Remove the fixture's consumed tenant handoffs with their Workspace so
      // the empty-owner state retains the registry's referential guarantees.
      state.handoffs = [];
      state.workspaces = [];
    });
    await page.goto(harness.rootOrigin);
    await expect(page.getByRole("heading", { name: "Create a Workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Workspace", exact: true })).toBeVisible();
    await page.getByLabel("Workspace name", { exact: true }).fill("First Workspace");
    await page.getByLabel("Workspace address", { exact: true }).fill("first");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("first")}/`);
    await expect(page.getByRole("heading", { name: "Create the first Project", exact: true })).toBeVisible();
  } finally { await harness.stop(); }
});

test("passkey sign-in returns to the same Workspace and sign-out revokes its browser family", async ({ page, context }) => {
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "returning");
    await createProject(page, "Retained project");
    await signout(page, harness);
    const ended = await context.request.get(`${harness.networkOrigin}/api/projects`, { headers: { Host: new URL(harness.tenantOrigin("returning")).host } });
    expect(ended.status()).toBe(401);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Continue with passkey", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("returning")}/`);
    await expect(page.getByLabel("Active Project", { exact: true })).toContainText("Retained project");
    const credentials = await context.cookies();
    expect(credentials.filter(cookie => cookie.name.includes("session")).every(cookie => cookie.httpOnly)).toBe(true);
  } finally { await harness.stop(); }
});

test("recovery replaces a lost passkey, rotates the code, and preserves owner data", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  const device = await authenticator(context, page);
  try {
    const originalCode = await signup(page, harness, "recovery");
    await createProject(page, "Recovery keeps my work");
    const ownerBefore = (await harness.accessStore.read()).owners[0].id;
    await signout(page, harness);
    await device.cdp.send("WebAuthn.clearCredentials", { authenticatorId: device.id });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Recover access", exact: true }).click();
    await page.getByLabel("Recovery code", { exact: true }).fill(originalCode);
    await page.getByRole("button", { name: "Replace passkeys", exact: true }).click();
    await expect(page.locator("#recovery-code")).toBeVisible();
    const replacementCode = await page.locator("#recovery-code").innerText();
    expect(replacementCode).not.toBe(originalCode);
    await page.getByRole("button", { name: "I saved my recovery code", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("recovery")}/`);
    await expect(page.getByLabel("Active Project", { exact: true })).toContainText("Recovery keeps my work");
    const state = await harness.accessStore.read();
    expect(state.owners).toHaveLength(1);
    expect(state.owners[0].id).toBe(ownerBefore);
    expect(state.passkeys.filter(key => !key.revokedAt)).toHaveLength(1);
    expect(state.passkeys.filter(key => key.revokedAt)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain(replacementCode);
    await signout(page, harness);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Recover access", exact: true }).click();
    await page.getByLabel("Recovery code", { exact: true }).fill(originalCode);
    await page.getByRole("button", { name: "Replace passkeys", exact: true }).click();
    await expect(page.getByText("Passkey access did not complete", { exact: true })).toBeVisible();
    await expect(page.locator("#recovery-code")).toHaveCount(0);
  } finally { await harness.stop(); }
});

test("stale owners verify a real passkey before issuing an agent key", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  await authenticator(context, page);
  try {
    await signup(page, harness, "fresh");
    await harness.accessStore.authTransaction(state => { for (const item of state.authSessions) { item.createdAt = new Date(Date.now() - 11 * 60_000).toISOString(); item.verifiedAt = new Date(Date.now() - 10 * 60_000).toISOString(); } });
    await page.getByRole("button", { name: "Open account panel", exact: true }).click();
    await page.getByRole("button", { name: "Agent connections", exact: true }).click();
    await page.getByLabel("Label", { exact: true }).fill("Protected agent");
    await page.getByRole("button", { name: "Create connection", exact: true }).click();
    await page.getByRole("button", { name: "Verify identity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Verify your identity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue with passkey", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("fresh")}/`);
    await expect(page.getByRole("heading", { name: "Agent connections", exact: true })).toBeVisible();
    await page.getByLabel("Label", { exact: true }).fill("Protected agent");
    await page.getByRole("button", { name: "Create connection", exact: true }).click();
    await expect(page.locator("#agent-credential")).toBeVisible();
  } finally { await harness.stop(); }
});

test("access settings add and remove passkeys without exposing owner secrets", async ({ page, context }) => {
  test.setTimeout(60_000);
  const harness = await startHarness();
  const first = await authenticator(context, page);
  try {
    await signup(page, harness, "settings");
    await page.getByRole("button", { name: "Open account panel", exact: true }).click();
    await page.getByRole("button", { name: "Manage access", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage access", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove passkey", exact: true })).toBeDisabled();
    await harness.accessStore.authTransaction(state => { for (const item of state.authSessions) { item.createdAt = new Date(Date.now() - 11 * 60_000).toISOString(); item.verifiedAt = new Date(Date.now() - 10 * 60_000).toISOString(); } });
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Verify your identity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage access", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Verify your identity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue with passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Add a passkey", exact: true })).toBeVisible();
    await first.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first.id });
    await authenticator(context, page);
    await page.getByRole("button", { name: "Create passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage access", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove passkey", exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Remove passkey", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Remove passkey", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Replace recovery code", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery code", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "I saved my recovery code", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage access", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "Passkey access surface");
  } finally { await harness.stop(); }
});

test("one-time setup attaches a passkey to the existing owner and preserves its board", async ({ page, context }) => {
  const harness = await startHarness({ setup: true });
  await authenticator(context, page);
  try {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(harness.rootOrigin);
    await expectNoHorizontalOverflow(page, "320px existing-owner setup entry");
    await page.getByRole("button", { name: "Set up existing account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
    await page.getByLabel("Setup token", { exact: true }).fill(SETUP_TOKEN);
    await page.getByRole("button", { name: "Create passkey", exact: true }).click();
    await expect(page.locator("#recovery-code")).toBeVisible();
    await expectNoHorizontalOverflow(page, "320px passkey recovery code");
    await page.getByRole("button", { name: "I saved my recovery code", exact: true }).click();
    await expect(page).toHaveURL(`${harness.tenantOrigin("existing")}/`);
    await expect(page.getByLabel("Active Project", { exact: true })).toContainText("Existing project");
    await expect(page.getByRole("button", { name: /Existing card/ })).toBeVisible();
    const state = await harness.accessStore.read();
    expect(state.owners).toHaveLength(1);
    expect(state.owners[0].id).toBe(harness.setupOwnerId);
    expect(state.workspaces[0].storageId).toBe("default");
    expect(state.passkeys[0].ownerId).toBe(harness.setupOwnerId);
    expect(state.setupConsumed).toBe(true);
    await signout(page, harness);
    await expect(page.getByRole("button", { name: "Set up existing account", exact: true })).toHaveCount(0);
  } finally { await harness.stop(); }
});

async function startHarness(options: { setup?: boolean } = {}): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-passkey-browser-"));
  const probe = createServer();
  await listen(probe, 0);
  const port = (probe.address() as AddressInfo).port;
  await close(probe);
  const rootOrigin = `http://board.localhost:${port}`;
  const networkOrigin = `http://127.0.0.1:${port}`;
  const authOrigin = `http://auth.board.localhost:${port}`;
  const accessStore = createFileAccessStore(path.join(directory, "access.json"));
  const workspaceStoreResolver = createWorkspaceStoreResolver({ dataPath: path.join(directory, "legacy.json"), workspaceDirectory: path.join(directory, "workspaces") });
  let setupOwnerId: string | undefined;
  if (options.setup) {
    await accessStore.bindLegacyWorkspace({ providerSubject: "sole-existing-owner", email: "owner@example.test", displayName: "Existing Owner", name: "Existing Workspace", slug: "existing" });
    setupOwnerId = (await accessStore.read()).owners[0].id;
    const now = new Date().toISOString();
    await workspaceStoreResolver.resolve("default").update(state => {
      state.projects.push({ id: "existing-project", name: "Existing project", description: "Saved before passkeys", columns: [{ id: "next", name: "Next", position: 0 }], cards: [{ id: "existing-card", title: "Existing card", body: "Preserve this work", nextActor: null, nextAction: "", priority: null, blockedReason: "", columnId: "next", position: 0, version: 1, archivedAt: null, createdAt: now, updatedAt: now, comments: [] }], activity: [], revision: 1, archivedAt: null, createdAt: now, updatedAt: now });
    });
  }
  const server = createServer(createApp({
    accessStore,
    passkeyAuthConfig: { authHost: `auth.board.localhost:${port}`, authOrigin, rpId: "auth.board.localhost", rootOrigins: [rootOrigin], sessionSecret: SESSION_SECRET, sessionTtlSeconds: 3600, ...(setupOwnerId ? { setupOwnerId, setupTokenHash: hashSecret(SETUP_TOKEN), setupExpiresAt: new Date(Date.now() + 60_000).toISOString() } : {}) },
    dataPath: path.join(directory, "legacy.json"),
    host: "board.localhost", rootHost: `board.localhost:${port}`, requireDatabase: false, trustForwardedHost: false,
    staticDir: path.resolve(__dirname, "../.."),
    workspaceStoreResolver
  }));
  await listen(server, port);
  return { accessStore, rootOrigin, networkOrigin, authOrigin, setupOwnerId, tenantOrigin: slug => `http://${slug}.board.localhost:${port}`, async stop() { await close(server); await fs.rm(directory, { recursive: true, force: true }); } };
}
async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
}
