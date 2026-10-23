/// <reference lib="dom" />

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import {
  assertChromiumInstalled, authenticate, expectNoHorizontalOverflow,
  openCard, seedBrowserWorkspace, signInToWorkspace, startBrowserHarness,
  type BrowserHarness, type BrowserProject, type SeededWorkspace
} from "./support/context-dock-harness";

let harness: BrowserHarness;
let seed: SeededWorkspace;
let archivedProjectId: string;
const labels = ["Claude Research (pilot)", "Codex Writer (pilot)", "Codex Research (pilot)", "Claude Writer (pilot)"];

async function request<T>(path: string, method = "GET", body?: Record<string, unknown>, actor = "Browser feed owner", version?: number): Promise<T> {
  const response = await fetch(`${harness.baseUrl}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${harness.ownerKey}`, "Content-Type": "application/json", "X-Kanban-Actor": actor,
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(version === undefined ? {} : { "X-Kanban-Version": String(version) })
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

test.beforeAll(async () => {
  await assertChromiumInstalled();
  harness = await startBrowserHarness();
  try {
    seed = await seedBrowserWorkspace(harness);
    const { project } = await request<{ project: BrowserProject }>("/projects", "POST", { name: "Archived research", columns: ["Next"] });
    archivedProjectId = project.id;
    const { card } = await request<{ card: { id: string } }>(`/projects/${project.id}/cards`, "POST", { title: "Archived research Card", columnId: project.columns[0].id });
    for (let index = 0; index < 54; index++) {
      await request(`/projects/${project.id}/cards/${card.id}/comments`, "POST", { body: `Result ${index}` }, labels[index % labels.length]);
    }
    const latest = await request<{ project: BrowserProject }>(`/projects/${project.id}`);
    await request(`/projects/${project.id}`, "PATCH", { archivedAt: "2026-10-19T21:00:00.000Z" }, "Archive owner", latest.project.revision);
    await request(`/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}/comments`, "POST", { body: "Project feed proof" }, labels[1]);
  } catch (error) { await harness.stop(); throw error; }
});

test.afterAll(async () => { await harness?.stop(); });

async function openWorkspaceActivity(page: Page): Promise<void> {
  const switcher = page.getByRole("button", { name: /^Workspace: / });
  if (await switcher.count()) await switcher.click();
  await page.getByRole("button", { name: "Workspace Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace Activity", exact: true })).toBeVisible();
}

function event(id: string, summary: string, projectId = seed.projectId, label = labels[0]): Record<string, unknown> {
  return { id, projectId, projectName: "Feed Project", summary, action: "card.updated", actor: { channel: "api", label }, createdAt: "2026-10-19T20:00:00.000Z" };
}

test("real Workspace, Project and Card feeds preserve actor names, archived context, pages and Card drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByLabel("Title", { exact: true }).fill("A retained local Card draft");
  await openWorkspaceActivity(page);
  await expect(page.locator("#activity-feed-title")).toBeFocused();
  const rows = page.locator(".activity-feed .activity-list > li");
  await expect(rows).toHaveCount(50);
  await expect(rows.filter({ hasText: "Archived research · Archived Project" }).first()).toBeVisible();
  for (const label of labels) await expect(rows.locator(".activity-actor").filter({ hasText: `By ${label}` }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("workspace-activity-desktop.png") });
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  const all = await request<{ activity: unknown[] }>("/activity?limit=200");
  await expect(rows).toHaveCount(all.activity.length);
  await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 1000 });
  await expectNoHorizontalOverflow(page, "Workspace Activity at 390px");
  await page.screenshot({ path: test.info().outputPath("workspace-activity-390.png") });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Back to board", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("A retained local Card draft");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "Project Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project Activity", exact: true })).toBeVisible();
  const projectActivity = await request<{ activity: unknown[] }>(`/projects/${seed.projectId}/activity?limit=200`);
  await expect(rows).toHaveCount(projectActivity.activity.length);
  await expect(rows.locator(".activity-actor").filter({ hasText: `By ${labels[1]}` })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Archived research Card" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("project-activity-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeFocused();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("A retained local Card draft");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.locator("#activity-panel .activity-actor").filter({ hasText: `By ${labels[1]}` })).toHaveCount(1);
});

test("first-load errors, refresh errors and older-page errors retain the correct state and Retry target", async ({ page }) => {
  let attempt = 0;
  await page.route("**/api/activity?**", async route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    attempt++;
    if ([1, 3, 5].includes(attempt)) return route.fulfill({ status: 503, json: { error: "A temporary feed failure" } });
    return route.fulfill({ json: { activity: [event(cursor ? "older" : "newer", cursor ? "Older result" : "Newest result")], nextCursor: cursor ? null : "older-page" } });
  });
  await authenticate(page, harness);
  await openWorkspaceActivity(page);
  await expect(page.getByText("Activity could not be loaded", { exact: true })).toBeVisible();
  await expect(page.getByText("No Activity in this Workspace yet.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const rows = page.locator(".activity-feed .activity-list > li");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("Newest result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("Older result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("Newest result", { exact: true })).toBeVisible();
});

test("empty Workspace Activity is discoverable without Projects and escapes all displayed names", async ({ page }) => {
  await page.route("**/api/session", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    if (!payload.authenticated) return route.fulfill({ response });
    await route.fulfill({ response, json: { ...payload, context: "workspace", workspace: { id: "workspace-feed-ui", slug: "feed-ui", name: "Feed Workspace", url: harness.baseUrl } } });
  });
  await page.route("**/api/projects", route => route.request().method() === "GET" ? route.fulfill({ json: { projects: [] } }) : route.continue());
  await page.route("**/api/activity?**", route => route.fulfill({ json: { activity: [], nextCursor: null } }));
  await signInToWorkspace(page, harness);
  await openWorkspaceActivity(page);
  await expect(page.getByText("No Activity in this Workspace yet.", { exact: true })).toBeVisible();
  const unsafe = `<img src=x onerror=alert(1)>${"AgentName".repeat(30)}`;
  await page.unroute("**/api/activity?**");
  await page.route("**/api/activity?**", route => route.fulfill({ json: { activity: [{ ...event("unsafe", unsafe, "archived", unsafe), projectName: unsafe }], nextCursor: null } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".activity-feed .activity-actor")).toHaveText(`By ${unsafe}`);
  await expect(page.locator(".activity-feed img, .activity-feed script")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 1000 });
  await expectNoHorizontalOverflow(page, "Long Workspace Activity names");
});

for (const oldStatus of [200, 401]) {
  test(`late ${oldStatus} Activity cannot reopen a feed after sign-out and a new session`, async ({ page }) => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    let calls = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/activity?**", async route => {
      if (++calls === 1) {
        entered();
        await held;
        await route.fulfill({ status: oldStatus, json: oldStatus === 200 ? { activity: [event("obsolete", "Old private result")], nextCursor: null } : { error: "Old session ended" } });
        return;
      }
      await route.fulfill({ json: { activity: [event("replacement", "Current feed")], nextCursor: null } });
    });
    await authenticate(page, harness);
    await openWorkspaceActivity(page);
    await started;
    await page.evaluate(() => {
      const channel = new BroadcastChannel("kanban.cards:session");
      channel.postMessage("signed-out");
      channel.close();
    });
    await expect(page.getByLabel("Owner key", { exact: true })).toBeVisible();
    await page.getByLabel("Owner key", { exact: true }).fill(harness.ownerKey);
    await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Context Dock regression", exact: true })).toBeVisible();
    await openWorkspaceActivity(page);
    await expect(page.getByText("Current feed", { exact: true })).toBeVisible();
    const completed = page.waitForResponse(response => response.url().includes("/api/activity?") && response.status() === oldStatus);
    release();
    await completed;
    await expect(page.getByText("Current feed", { exact: true })).toBeVisible();
    await expect(page.getByText("Old private result", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Your session ended", { exact: true })).toHaveCount(0);
  });
}

for (const scope of ["Workspace", "Project"] as const) {
  test(`${scope} Activity hides editing actions and Back restores normal Project and Card editors`, async ({ page }) => {
    await authenticate(page, harness);
    await openCard(page, seed.cards.desktopDraft.title);
    await page.getByLabel("Title", { exact: true }).fill("Draft retained through Activity navigation");
    await page.locator("#move-card-trigger").click();
    await expect(page.locator("#move-card-panel")).toBeVisible();
    if (scope === "Workspace") await openWorkspaceActivity(page);
    else {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("button", { name: "Project Activity", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: `${scope} Activity`, exact: true })).toBeVisible();
    for (const name of ["Actions", "New Project", "Edit Project", "New Card"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.locator("#project-editor, form[data-form='card']")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft retained through Activity navigation");
    await expect(page.locator("#move-card-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#move-card-panel")).toHaveCount(0);
    await expect(page.locator("#move-card-trigger")).toBeFocused();
    for (const name of ["New Project", "Edit Project"]) {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator("#project-editor")).toBeVisible();
      await expect(page.locator(".activity-feed")).toHaveCount(0);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "New Card", exact: true }).click();
    await expect(page.locator("#card-panel").getByRole("button", { name: "Create Card", exact: true })).toBeVisible();
    await expect(page.locator(".activity-feed")).toHaveCount(0);
    await page.locator("[data-action='close-card']").click();
    await openCard(page, seed.cards.desktopDraft.title);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft retained through Activity navigation");
  });
}
