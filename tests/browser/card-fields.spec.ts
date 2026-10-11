/// <reference lib="dom" />

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  assertChromiumInstalled,
  cardButton,
  expectNoHorizontalOverflow,
  openCard,
  readSeededProject,
  signInToWorkspace,
  startBrowserHarness,
  updateSeededCard,
  type BrowserCard,
  type BrowserHarness,
  type BrowserProject
} from "./support/context-dock-harness";

let harness: BrowserHarness;
let project: BrowserProject;
let cards: BrowserCard[];

async function create<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${harness.baseUrl}/api${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${harness.ownerKey}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload as T;
}

async function storedCard(id: string): Promise<BrowserCard> {
  const stored = (await readSeededProject(harness, project.id)).cards.find((card) => card.id === id);
  if (!stored) throw new Error(`Card ${id} was not stored`);
  return stored;
}

async function login(page: Page): Promise<void> {
  await signInToWorkspace(page, harness);
  if (await page.getByLabel("Active Project").inputValue() !== project.id) await page.getByLabel("Active Project").selectOption(project.id);
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeAttached();
}

async function expectFields(page: Page, values: { nextActor: string; nextAction: string; priority: string; blockedReason: string }): Promise<void> {
  const inspector = page.getByRole("complementary");
  await expect(inspector.getByLabel("Next actor", { exact: true })).toHaveValue(values.nextActor);
  await expect(inspector.getByLabel("Next action", { exact: true })).toHaveValue(values.nextAction);
  await expect(inspector.getByLabel("Priority", { exact: true })).toHaveValue(values.priority);
  await expect(inspector.getByLabel("Blocker", { exact: true })).toHaveValue(values.blockedReason);
}

test.beforeAll(assertChromiumInstalled);
test.beforeEach(async () => {
  harness = await startBrowserHarness();
  project = (await create<{ project: BrowserProject }>("/projects", { name: "Card fields regression" })).project;
  const definitions = [
    { title: "You high blocked", nextActor: "human", nextAction: "Review the result", priority: "High", blockedReason: "Waiting for feedback", columnId: "next" },
    { title: "Agent high ready", nextActor: "agent", nextAction: "Run the checks", priority: "High", blockedReason: "", columnId: "doing" },
    { title: "You low ready", nextActor: "human", nextAction: "Read the notes", priority: "Low", blockedReason: "", columnId: "next" },
    { title: "Unassigned unset ready", columnId: "done" }
  ];
  cards = [];
  for (const definition of definitions) cards.push((await create<{ card: BrowserCard }>(`/projects/${project.id}/cards`, definition)).card);
});
test.afterEach(async () => harness?.stop());

test("creates, edits, moves, archives, restores, and clears all optional Card fields durably", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.screenshot({ path: "output/playwright/card-fields/desktop-board.png", fullPage: true });
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New Card", exact: true }).click();
  const inspector = page.getByRole("complementary");
  await inspector.getByLabel("Title", { exact: true }).fill("Created with handoff details");
  await inspector.getByLabel("Next actor", { exact: true }).selectOption("agent");
  await inspector.getByLabel("Next action", { exact: true }).fill("Implement the change");
  await inspector.getByLabel("Priority", { exact: true }).selectOption("Medium");
  await inspector.getByLabel("Blocker", { exact: true }).fill("Waiting for a fixture");
  await page.getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible();
  const created = (await readSeededProject(harness, project.id)).cards.find((card) => card.title === "Created with handoff details")!;
  const initial = { nextActor: "agent", nextAction: "Implement the change", priority: "Medium", blockedReason: "Waiting for a fixture" };
  expect(created).toMatchObject(initial);
  await expect(cardButton(page, created.title)).toContainText("Next: Agent");
  await expect(cardButton(page, created.title)).toContainText("Medium priority");
  await expect(cardButton(page, created.title)).toContainText("Blocked");
  await inspector.getByLabel("Blocker", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/card-fields/desktop-selected-fields.png", fullPage: true });

  await inspector.getByLabel("Next actor", { exact: true }).selectOption("human");
  await expect.poll(async () => (await storedCard(created.id)).nextActor).toBe("human");
  await inspector.getByLabel("Next action", { exact: true }).fill("Review the change");
  await inspector.getByLabel("Next action", { exact: true }).blur();
  await expect.poll(async () => (await storedCard(created.id)).nextAction).toBe("Review the change");
  await inspector.getByLabel("Priority", { exact: true }).selectOption("High");
  await expect.poll(async () => (await storedCard(created.id)).priority).toBe("High");
  const edited = { ...initial, nextActor: "human", nextAction: "Review the change", priority: "High" };

  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Card and return to Doing" })).toBeVisible();
  expect(await storedCard(created.id)).toMatchObject({ ...edited, columnId: "doing" });
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Undo archive", exact: true }).click();
  await expect(cardButton(page, created.title)).toBeVisible();
  expect(await storedCard(created.id)).toMatchObject({ ...edited, archivedAt: null });
  await openCard(page, created.title);

  await inspector.getByLabel("Next actor", { exact: true }).selectOption("");
  await expect.poll(async () => (await storedCard(created.id)).nextActor).toBeNull();
  await inspector.getByLabel("Priority", { exact: true }).selectOption("");
  await expect.poll(async () => (await storedCard(created.id)).priority).toBeNull();
  await inspector.getByLabel("Next action", { exact: true }).fill("");
  await inspector.getByLabel("Blocker", { exact: true }).fill("");
  await inspector.getByLabel("Blocker", { exact: true }).blur();
  await expect.poll(async () => (await storedCard(created.id)).blockedReason).toBe("");
  expect(await storedCard(created.id)).toMatchObject({ nextActor: null, nextAction: "", priority: null, blockedReason: "" });
  await page.reload();
  await openCard(page, created.title);
  await expectFields(page, { nextActor: "", nextAction: "", priority: "", blockedReason: "" });
});

test("combines all filters with AND, reports empty results, and retains filters per Project", async ({ page }) => {
  const other = (await create<{ project: BrowserProject }>("/projects", { name: "Other Project" })).project;
  await login(page);
  await expect(page.locator(".card-filter-count")).toHaveText("Showing 4 of 4 Cards");
  await page.getByLabel("Filter by next actor", { exact: true }).selectOption("human");
  await expect(page.locator("button.board-card")).toHaveCount(2);
  await page.getByLabel("Filter by priority", { exact: true }).selectOption("High");
  await page.getByLabel("Filter by blocked", { exact: true }).selectOption("blocked");
  await expect(page.locator("button.board-card")).toHaveCount(1);
  await expect(cardButton(page, cards[0].title)).toBeVisible();
  await expect(page.locator(".card-filter-count")).toHaveText("Showing 1 of 4 Cards");
  await page.getByLabel("Filter by blocked", { exact: true }).selectOption("unblocked");
  await expect(page.locator("button.board-card")).toHaveCount(0);
  await expect(page.getByText("No Cards match these filters.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter by blocked", { exact: true })).toBeFocused();

  await page.getByLabel("Active Project").selectOption(other.id);
  await expect(page.getByLabel("Filter by next actor", { exact: true })).toHaveValue("all");
  await page.getByLabel("Active Project").selectOption(project.id);
  await expect(page.getByLabel("Filter by next actor", { exact: true })).toHaveValue("human");
  await expect(page.getByLabel("Filter by priority", { exact: true })).toHaveValue("High");
  await expect(page.getByLabel("Filter by blocked", { exact: true })).toHaveValue("unblocked");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator("button.board-card")).toHaveCount(4);
  await expect(page.getByLabel("Filter by next actor", { exact: true })).toBeFocused();
  await page.getByLabel("Filter by next actor", { exact: true }).selectOption("unassigned");
  await page.getByLabel("Filter by priority", { exact: true }).selectOption("unset");
  await expect(page.locator("button.board-card")).toHaveCount(1);
  await expect(cardButton(page, cards[3].title)).toBeVisible();
});

test("a selected Card and failed-save draft survive leaving the active filters", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByLabel("Filter by next actor", { exact: true }).selectOption("human");
  await openCard(page, cards[0].title);
  const inspector = page.getByRole("complementary");
  await inspector.getByLabel("Next actor", { exact: true }).selectOption("agent");
  await expect.poll(async () => (await storedCard(cards[0].id)).nextActor).toBe("agent");
  await expect(cardButton(page, cards[0].title)).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(page.getByText("This Card is outside the current board filters.", { exact: true })).toBeVisible();
  await page.route(`**/api/projects/${project.id}/cards/${cards[0].id}`, async (route) => {
    if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Deterministic retained draft failure" }) });
    else await route.continue();
  });
  await inspector.getByLabel("Next action", { exact: true }).fill("Retained hidden draft");
  await inspector.getByLabel("Next action", { exact: true }).blur();
  await expect(page.getByText("Changes not saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(page.locator("#column-next")).toBeFocused();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(cardButton(page, cards[0].title)).toContainText("Draft retained");
  await openCard(page, cards[0].title);
  await expect(inspector.getByLabel("Next action", { exact: true })).toHaveValue("Retained hidden draft");
  await expect(inspector.getByLabel("Next actor", { exact: true })).toHaveValue("agent");
  await page.unroute(`**/api/projects/${project.id}/cards/${cards[0].id}`);
  await inspector.getByLabel("Next action", { exact: true }).focus();
  await inspector.getByLabel("Next action", { exact: true }).blur();
  await expect.poll(async () => (await storedCard(cards[0].id)).nextAction).toBe("Retained hidden draft");
});

test("filter changes during a pending autosave preserve the selected draft and later edits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await openCard(page, cards[0].title);
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const actions: string[] = [];
  let firstHeld = false;
  await page.route(`**/api/projects/${project.id}/cards/${cards[0].id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      actions.push(route.request().postDataJSON().nextAction);
      if (!firstHeld) {
        firstHeld = true;
        markFirstStarted();
        await firstGate;
      }
    }
    await route.continue();
  });
  const inspector = page.getByRole("complementary");
  try {
    await inspector.getByLabel("Next action", { exact: true }).fill("First pending action");
    await inspector.getByLabel("Next action", { exact: true }).blur();
    await firstStarted;
    await page.getByLabel("Filter by priority", { exact: true }).selectOption("Low");
    await expect(cardButton(page, cards[0].title)).toHaveCount(0);
    await expect(inspector.getByLabel("Next action", { exact: true })).toHaveValue("First pending action");
    await expect(page.getByLabel("Filter by priority", { exact: true })).toBeFocused();
    await inspector.getByLabel("Next action", { exact: true }).fill("Second action while pending");
    await inspector.getByLabel("Next action", { exact: true }).blur();
    await page.getByLabel("Filter by priority", { exact: true }).focus();
  } finally {
    releaseFirst();
  }
  await expect.poll(async () => (await storedCard(cards[0].id)).nextAction).toBe("Second action while pending");
  await expect(inspector.getByLabel("Next action", { exact: true })).toHaveValue("Second action while pending");
  await expect(page.getByLabel("Filter by priority", { exact: true })).toBeFocused();
  await expect(page.locator(".card-filter-count")).toHaveText("Showing 1 of 4 Cards");
  expect(actions).toEqual(["First pending action", "Second action while pending"]);
  expect(await storedCard(cards[0].id)).toMatchObject({ nextActor: "human", priority: "High", blockedReason: "Waiting for feedback" });
});

test("stale recovery compares and retries every handoff field explicitly", async ({ page }) => {
  await login(page);
  await openCard(page, cards[0].title);
  await updateSeededCard(harness, project.id, cards[0].id, cards[0].version, { nextActor: "agent", nextAction: "Stored action", priority: "Medium", blockedReason: "Stored blocker" });
  const inspector = page.getByRole("complementary");
  await inspector.getByLabel("Next action", { exact: true }).fill("Draft action");
  await inspector.getByLabel("Next action", { exact: true }).blur();
  await expect(page.getByRole("heading", { name: "The stored Card changed", exact: true })).toBeVisible();
  await expect(page.locator(".stored-change")).toContainText("Stored action");
  await expect(page.locator(".stored-change")).toContainText("Stored blocker");
  await inspector.getByLabel("Next actor", { exact: true }).selectOption("human");
  await inspector.getByLabel("Priority", { exact: true }).selectOption("Low");
  await inspector.getByLabel("Blocker", { exact: true }).fill("Draft blocker");
  await page.getByRole("button", { name: "Retry with draft", exact: true }).click();
  await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect(await storedCard(cards[0].id)).toMatchObject({ nextActor: "human", nextAction: "Draft action", priority: "Low", blockedReason: "Draft blocker" });
  await page.reload();
  await openCard(page, cards[0].title);
  await expectFields(page, { nextActor: "human", nextAction: "Draft action", priority: "Low", blockedReason: "Draft blocker" });
});

test("stale Discard replaces every handoff field with the newer stored values without writing", async ({ page }) => {
  await login(page);
  await openCard(page, cards[0].title);
  const stored = await updateSeededCard(harness, project.id, cards[0].id, cards[0].version, { nextActor: "agent", nextAction: "Stored replacement action", priority: "Medium", blockedReason: "Stored replacement blocker" });
  const inspector = page.getByRole("complementary");
  let patchCount = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith(`/cards/${cards[0].id}`)) patchCount++;
  });
  await inspector.getByLabel("Next action", { exact: true }).fill("Discard this action");
  await inspector.getByLabel("Next action", { exact: true }).blur();
  await expect(page.getByRole("heading", { name: "The stored Card changed", exact: true })).toBeVisible();
  await inspector.getByLabel("Next actor", { exact: true }).selectOption("");
  await inspector.getByLabel("Priority", { exact: true }).selectOption("Low");
  await inspector.getByLabel("Blocker", { exact: true }).fill("Discard this blocker");
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expectFields(page, { nextActor: "agent", nextAction: "Stored replacement action", priority: "Medium", blockedReason: "Stored replacement blocker" });
  await expect(inspector.getByLabel("Title", { exact: true })).toBeFocused();
  expect(await storedCard(cards[0].id)).toEqual(stored);
  expect(patchCount).toBe(1);
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, cards[0].title)).not.toContainText("Draft retained");
  await openCard(page, cards[0].title);
  await expectFields(page, { nextActor: "agent", nextAction: "Stored replacement action", priority: "Medium", blockedReason: "Stored replacement blocker" });
});

test("320px filters and long field content wrap, with a visible focus return when filtered out", async ({ page }) => {
  const longAction = "NextAction".repeat(70);
  const longBlocker = "BlockedReason".repeat(70);
  await updateSeededCard(harness, project.id, cards[0].id, cards[0].version, { nextAction: longAction, blockedReason: longBlocker });
  await page.setViewportSize({ width: 320, height: 720 });
  await login(page);
  await page.getByLabel("Filter by next actor", { exact: true }).selectOption("human");
  await page.getByLabel("Filter by priority", { exact: true }).selectOption("High");
  await page.getByLabel("Filter by blocked", { exact: true }).selectOption("blocked");
  await expectNoHorizontalOverflow(page, "320px combined filters and Card metadata");
  await page.screenshot({ path: "output/playwright/card-fields/mobile-board.png", fullPage: true });
  await openCard(page, cards[0].title);
  await expectFields(page, { nextActor: "human", nextAction: longAction, priority: "High", blockedReason: longBlocker });
  await expectNoHorizontalOverflow(page, "320px Card fields");
  await page.getByRole("complementary").getByLabel("Next actor", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/card-fields/mobile-selected-fields.png", fullPage: true });
  await page.getByRole("complementary").getByLabel("Priority", { exact: true }).selectOption("Low");
  await expect.poll(async () => (await storedCard(cards[0].id)).priority).toBe("Low");
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(page.locator("#column-next")).toBeFocused();
  await expect(page.getByText("No Cards match these filters.", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, "320px empty filter results");
});
