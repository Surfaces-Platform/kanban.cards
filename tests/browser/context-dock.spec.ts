/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

import {
  assertChromiumInstalled,
  authenticate,
  cardButton,
  expectNoHorizontalOverflow,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors,
  openCard,
  readSeededProject,
  seedBrowserWorkspace,
  startBrowserHarness,
  updateSeededCard,
  type BrowserHarness,
  type SeededWorkspace
} from "./support/context-dock-harness";

let harness: BrowserHarness;
let seed: SeededWorkspace;

test.beforeAll(async () => {
  await assertChromiumInstalled();
  harness = await startBrowserHarness();
  try {
    seed = await seedBrowserWorkspace(harness);
  } catch (error) {
    await harness.stop();
    throw error;
  }
});

test.afterAll(async () => {
  await harness?.stop();
});

test("desktop opens an adjacent Card inspector, autosaves on blur, and restores source focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  const board = page.locator(".board-pane");
  const inspector = page.getByRole("complementary");
  await expect(board).toBeVisible();
  await expect(inspector).toHaveCount(0);
  await expect(page.locator("dialog, [role='dialog']")).toHaveCount(0);

  const source = cardButton(page, seed.cards.desktopDraft.title);
  await source.click();
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(inspector).toBeVisible();
  await expect(board).toBeVisible();
  const [boardBox, inspectorBox] = await Promise.all([board.boundingBox(), inspector.boundingBox()]);
  expect(boardBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(inspectorBox!.x).toBeGreaterThan(boardBox!.x);
  expect(inspectorBox!.x).toBeGreaterThanOrEqual(boardBox!.x + boardBox!.width - 1);

  await page.setViewportSize({ width: 1024, height: 800 });
  const [compactBoardBox, compactInspectorBox] = await Promise.all([board.boundingBox(), inspector.boundingBox()]);
  expect(compactBoardBox).not.toBeNull();
  expect(compactInspectorBox).not.toBeNull();
  expect(compactBoardBox!.x + compactBoardBox!.width).toBeLessThanOrEqual(compactInspectorBox!.x + 1);
  await expect(page.getByRole("button", { name: "Open account panel" })).toBeHidden();

  await page.setViewportSize({ width: 800, height: 900 });
  const tabletInspectorBox = await inspector.boundingBox();
  expect(tabletInspectorBox).not.toBeNull();
  expect(tabletInspectorBox!.x).toBe(0);
  expect(tabletInspectorBox!.width).toBe(800);
  await expect(board).toBeHidden();
  await expect(page.getByLabel("Active Project")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });

  const savedBody = "Stored desktop body — autosaved browser change";
  await page.getByLabel("Body", { exact: true }).fill(savedBody);
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => {
    const stored = await readSeededProject(harness, seed.projectId);
    return stored.cards.find((card) => card.id === seed.cards.desktopDraft.id)?.body;
  }).toBe(savedBody);
  await page.getByRole("tab", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, seed.cards.desktopDraft.title)).toBeFocused();

  await cardButton(page, seed.cards.desktopDraft.title).click();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(savedBody);
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, seed.cards.desktopDraft.title)).toBeFocused();

  await openCard(page, seed.overflowTitle);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(seed.overflowTitle);
  await expectNoHorizontalOverflow(page, "1440px desktop Card inspector");
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, seed.overflowTitle)).toBeFocused();
  expectNoUnexpectedBrowserErrors(errors);
});

test("390px mobile presents a full-height Card view, autosaves on blur, and restores source focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await expect(page.locator("#mobile-column")).toHaveCount(1);
  await expect(page.locator("section.column:visible")).toHaveCount(1);
  await expectNoHorizontalOverflow(page, "390px mobile board");

  await openCard(page, seed.cards.mobileAutosave.title);
  await expect(page.locator(".board-pane")).toBeHidden();
  await expect(page.getByLabel("Active Project")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open account panel" })).toBeHidden();
  await expect(page.locator("dialog, [role='dialog']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close Card and return to Next" })).toBeVisible();
  const mobileBody = "Stored mobile body — autosaved on blur";
  await page.getByLabel("Body", { exact: true }).fill(mobileBody);
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect.poll(async () => {
    const stored = await readSeededProject(harness, seed.projectId);
    return stored.cards.find((card) => card.id === seed.cards.mobileAutosave.id)?.body;
  }).toBe(mobileBody);
  await page.getByRole("tab", { name: "Card", exact: true }).click();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(mobileBody);
  await expectNoHorizontalOverflow(page, "390px mobile Card view");

  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, seed.cards.mobileAutosave.title)).toBeFocused();
  await expect(page.locator("#mobile-column")).toHaveValue("next");
  await expect(page.locator("section.column:visible").getByRole("heading", { name: "Next" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "390px mobile source Column");
  expectNoUnexpectedBrowserErrors(errors);
});

test("320px narrow mobile contains unbroken Card content without document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await page.locator("#mobile-column").selectOption("next");
  await expectNoHorizontalOverflow(page, "320px narrow board");
  await openCard(page, seed.overflowTitle);
  await expect(page.getByRole("button", { name: "Close Card and return to Next" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "320px narrow Card view");

  const controlsFit = await page.locator(".card-inspector input, .card-inspector select, .card-inspector textarea").evaluateAll((controls) =>
    controls.every((control) => {
      const rect = control.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    })
  );
  expect(controlsFit).toBe(true);
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await expect(cardButton(page, seed.overflowTitle)).toBeFocused();
  expectNoUnexpectedBrowserErrors(errors);
});

test("stale edits expose only Retry or Discard and both paths preserve explicit intent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await openCard(page, seed.cards.staleDiscard.title);
  await page.getByLabel("Title", { exact: true }).fill("Browser draft to discard");
  await updateSeededCard(
    harness,
    seed.projectId,
    seed.cards.staleDiscard.id,
    seed.cards.staleDiscard.version,
    { title: "Stored API change for discard" }
  );
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The stored Card changed" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Retry with draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard draft" })).toBeVisible();
  const inspector = page.getByRole("complementary");
  await expect(inspector.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Browser draft to discard");

  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Stored API change for discard");
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();

  await openCard(page, seed.cards.staleRetry.title);
  await page.getByLabel("Title", { exact: true }).fill("Retried browser draft wins");
  await updateSeededCard(
    harness,
    seed.projectId,
    seed.cards.staleRetry.id,
    seed.cards.staleRetry.version,
    { title: "Stored API change before retry", columnId: "doing" }
  );
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The stored Card changed" })).toBeFocused();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Retried browser draft wins");
  await page.getByRole("button", { name: "Retry with draft" }).click();
  await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Retried browser draft wins");

  const stored = await readSeededProject(harness, seed.projectId);
  const retried = stored.cards.find((card) => card.id === seed.cards.staleRetry.id);
  expect(retried?.title).toBe("Retried browser draft wins");
  expect(retried?.columnId).toBe("doing");
  // The two intentional stale writes return 409; all other console/runtime errors still fail the test.
  expectNoUnexpectedBrowserErrors(errors, [/status of 409/i, /409 \(Conflict\)/i]);
});

test("Project create, edit, and switching restore focus without persistent progress copy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New Project", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser focus Project");
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await expect(page.getByText("Project created", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Active Project")).toBeFocused();

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "Edit Project", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser focus Project updated");
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await expect(page.getByText("Project updated", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Active Project")).toBeFocused();

  await page.getByLabel("Active Project").selectOption({ label: "Context Dock regression" });
  await expect(page.getByRole("heading", { name: "Context Dock regression" })).toBeVisible();
  await expect(page.getByText("Opening Project", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Active Project")).toBeFocused();

  await openCard(page, seed.cards.desktopColumnContext.title);
  await page.getByRole("button", { name: "Close Card and return to Doing" }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New Card", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Desktop defaults to first Column");
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible();
  const stored = await readSeededProject(harness, seed.projectId);
  expect(stored.cards.find((card) => card.title === "Desktop defaults to first Column")?.columnId).toBe("next");
  expectNoUnexpectedBrowserErrors(errors);
});

test("archive removes the active Card and Undo restores both resource and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await openCard(page, seed.cards.archive.title);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(cardButton(page, seed.cards.archive.title)).toHaveCount(0);
  const undo = page.getByRole("button", { name: "Undo archive" });
  await expect(undo).toBeVisible();
  await expect(undo).toBeFocused();

  await undo.click();
  await expect(cardButton(page, seed.cards.archive.title)).toBeVisible();
  await expect(cardButton(page, seed.cards.archive.title)).toBeFocused();
  const stored = await readSeededProject(harness, seed.projectId);
  expect(stored.cards.find((card) => card.id === seed.cards.archive.id)?.archivedAt).toBeNull();
  expectNoUnexpectedBrowserErrors(errors);
});

test("sign-out clears rendered, cookie, and local Project data before reauthentication", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await expect(page.getByLabel("Active Project")).toHaveValue(seed.projectId);
  await openCard(page, seed.cards.privacy.title);
  await page.getByRole("button", { name: "Close Card and return to Next" }).click();
  await page.getByRole("button", { name: "Open account panel" }).click();
  await expect(page.getByText("Browser QA Owner", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: "Open your workspace" })).toBeVisible();
  await expect(page.getByLabel("Owner key")).toBeFocused();
  await expect(page.getByText("Signed out", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Context Dock regression");
  await expect(page.locator("body")).not.toContainText(seed.cards.privacy.title);
  await expect(page.locator("body")).not.toContainText(seed.cards.privacy.body);
  expect(await page.evaluate(() => window.localStorage.getItem("kanban.cards:project-id"))).toBeNull();
  expect((await context.cookies()).some((cookie) => cookie.name === "kanban_cards_session")).toBe(false);

  await page.getByLabel("Owner key").fill(harness.ownerKey);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("heading", { name: "Context Dock regression" })).toBeVisible();
  await openCard(page, seed.cards.privacy.title);
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(seed.cards.privacy.body);
  // Chromium can classify a successful bodyless 204 DELETE as aborted; cookie and privacy assertions gate the outcome above.
  expectNoUnexpectedBrowserErrors(errors, [/DELETE .*\/api\/session: net::ERR_ABORTED/i]);
});
