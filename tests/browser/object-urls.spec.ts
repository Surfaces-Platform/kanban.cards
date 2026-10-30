/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { objectPath } from "../../src/object-urls";
import { authenticate, cardButton, expectNoHorizontalOverflow, openCard, seedBrowserWorkspace, startBrowserHarness,
  type BrowserHarness, type BrowserProject, type SeededWorkspace } from "./support/context-dock-harness";

let harness: BrowserHarness;
let seed: SeededWorkspace;
let commentId: string;
let otherProjectId: string;
let archivedProjectId: string;
let archivedCardId: string;
const cardPath = () => objectPath({ projectId: seed.projectId, cardId: seed.cards.desktopDraft.id });
const commentPath = () => objectPath({ projectId: seed.projectId, cardId: seed.cards.desktopDraft.id, commentId });
async function request<T>(path: string, method = "GET", body?: object, version?: number): Promise<T> {
  const response = await fetch(`${harness.baseUrl}/api${path}`, { method, headers: {
    Authorization: `Bearer ${harness.ownerKey}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID(),
    ...(version === undefined ? {} : { "X-Kanban-Version": String(version) })
  }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as T;
}
test.beforeAll(async () => {
  harness = await startBrowserHarness();
  try {
    seed = await seedBrowserWorkspace(harness);
    const comment = await request<{ comment: { id: string } }>(`/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}/comments`, "POST", { body: "A directly addressable Comment" });
    commentId = comment.comment.id;
    otherProjectId = (await request<{ project: BrowserProject }>("/projects", "POST", { name: "Another Project" })).project.id;
    const archived = (await request<{ project: BrowserProject }>("/projects", "POST", { name: "Archived links" })).project;
    archivedProjectId = archived.id;
    await request(`/projects/${archived.id}`, "PATCH", { archivedAt: "2026-10-25T00:00:00Z" }, archived.revision);
    const card = (await request<{ card: { id: string; version: number } }>(`/projects/${seed.projectId}/cards`, "POST", { title: "Archived link Card" })).card;
    archivedCardId = card.id;
    await request(`/projects/${seed.projectId}/cards/${card.id}`, "PATCH", { archivedAt: "2026-10-25T00:00:00Z" }, card.version);
  } catch (error) { await harness.stop(); throw error; }
});
test.afterAll(async () => { await harness?.stop(); });

test("a signed-out Comment URL resumes the exact Card and Comment after authentication and refresh", async ({ page }) => {
  await page.goto(harness.baseUrl + commentPath());
  await expect(page.getByLabel("Owner key")).toBeVisible();
  await expect(page.getByText("A directly addressable Comment")).toHaveCount(0);
  await page.getByLabel("Owner key").fill(harness.ownerKey);
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(seed.cards.desktopDraft.title);
  await expect(page.locator(`[id="${commentId}"]`)).toBeFocused();
  await expect(page).toHaveURL(harness.baseUrl + commentPath());
  await page.reload();
  await expect(page.locator(`[id="${commentId}"]`)).toBeFocused();
  await expect(page.getByText("A directly addressable Comment")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "Comment permalink at 390px");
  await page.screenshot({ path: test.info().outputPath("comment-link-mobile.png") });
});

test("Project URLs override the remembered Project and direct reload loads absolute shell assets", async ({ page }) => {
  await authenticate(page, harness);
  await page.getByLabel("Active Project").selectOption(otherProjectId);
  await expect(page).toHaveURL(harness.baseUrl + objectPath({ projectId: otherProjectId }));
  await page.goto(harness.baseUrl + cardPath());
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(seed.cards.desktopDraft.title);
  await expect(page.getByLabel("Active Project")).toHaveValue(seed.projectId);
  await page.goto(harness.baseUrl + objectPath({ projectId: otherProjectId }));
  await expect(page.getByLabel("Active Project")).toHaveValue(otherProjectId);
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("Card open, Back, Forward and close keep URLs, retained drafts and board state together", async ({ page }) => {
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  await expect(page).toHaveURL(harness.baseUrl + cardPath());
  await page.getByLabel("Title", { exact: true }).fill("Retained through browser history");
  await page.goBack();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Retained through browser history");
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(page).toHaveURL(harness.baseUrl + objectPath({ projectId: seed.projectId }));
  await expect(cardButton(page, seed.cards.desktopDraft.title)).toBeFocused();
});

test("Workspace, Project, Card and Comment copy controls put usable stable URLs on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await authenticate(page, harness);
  await page.getByRole("button", { name: "Open account panel" }).click();
  await page.getByRole("button", { name: "Copy Workspace link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(harness.baseUrl + "/");
  await page.getByRole("button", { name: "Close account panel" }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "Copy Project link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(harness.baseUrl + objectPath({ projectId: seed.projectId }));
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByRole("button", { name: "Copy Card link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(harness.baseUrl + cardPath());
  await page.locator(`[id="${commentId}"]`).getByRole("button", { name: "Copy Comment link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(harness.baseUrl + commentPath());
  const link = await page.locator(`[id="${commentId}"] a`).getAttribute("href");
  expect(link).toBe(commentPath());
  await page.goto(harness.baseUrl + link);
  await expect(page.locator(`[id="${commentId}"]`)).toBeFocused();
});

test("missing objects and archived links never open an unrelated active object", async ({ page }) => {
  await authenticate(page, harness);
  for (const [path, title] of [
    ["/projects/project-missing", "Link unavailable"],
    [objectPath({ projectId: seed.projectId, cardId: "card-missing" }), "Card unavailable"],
    [cardPath() + "#comment-missing", "Comment unavailable"],
    [objectPath({ projectId: archivedProjectId }), "Project is archived"],
    [objectPath({ projectId: seed.projectId, cardId: archivedCardId }), "Card is archived"]
  ]) {
    await page.goto(harness.baseUrl + path);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(page).toHaveURL(harness.baseUrl + path);
  }
  await page.getByRole("button", { name: "Back to board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Context Dock regression", exact: true })).toBeVisible();
});

test("a renamed Card moved between Columns keeps the same link", async ({ page }) => {
  await authenticate(page, harness);
  const original = seed.cards.desktopColumnContext;
  const { project } = await request<{ project: BrowserProject }>(`/projects/${seed.projectId}`);
  const stored = project.cards.find(card => card.id === original.id)!;
  await request(`/projects/${seed.projectId}/cards/${stored.id}`, "PATCH", { title: "Renamed linked Card" }, stored.version);
  await request(`/projects/${seed.projectId}/cards/${stored.id}`, "PATCH", { columnId: "done" }, stored.version + 1);
  await page.goto(harness.baseUrl + objectPath({ projectId: seed.projectId, cardId: stored.id }));
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Renamed linked Card");
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();
});


test("late linked-object responses cannot restore private content after sign-out", async ({ page }) => {
  await authenticate(page, harness);
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/projects/${seed.projectId}`, async route => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  await page.evaluate(path => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, cardPath());
  await started;
  await page.evaluate(() => {
    const channel = new BroadcastChannel("kanban.cards:session");
    channel.postMessage("signed-out");
    channel.close();
  });
  await expect(page.getByLabel("Owner key", { exact: true })).toBeVisible();
  const finished = page.waitForEvent("requestfinished", request => new URL(request.url()).pathname === `/api/projects/${seed.projectId}`);
  release();
  await finished;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await page.unroute(`**/api/projects/${seed.projectId}`);
  await expect(page.getByLabel("Owner key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(page.getByText("A directly addressable Comment", { exact: true })).toHaveCount(0);
});
