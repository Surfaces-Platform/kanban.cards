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
  signInToWorkspace,
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

test("desktop exposes an explicit Move chooser and a visible new-Card destination", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await openCard(page, seed.cards.desktopDraft.title);
  await expect(page.getByLabel("Create in", { exact: true })).toHaveCount(0);
  const move = page.getByRole("button", { name: "Move…", exact: true });
  await expect(move).toHaveAttribute("aria-expanded", "false");

  const patchBodies: Array<Record<string, unknown>> = [];
  let releaseAutosave!: () => void;
  let releaseMove!: () => void;
  const autosaveGate = new Promise<void>((resolve) => { releaseAutosave = resolve; });
  const moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patchBodies.push(body);
    if (body.columnId) await moveGate;
    else await autosaveGate;
    await route.continue();
  });

  const sequencedBody = "Body autosave must commit before the explicit move";
  await page.getByLabel("Body", { exact: true }).fill(sequencedBody);
  await move.click();
  await expect(move).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "Move Card", exact: true })).toBeVisible();
  await expect(page.getByText("Current Column: Next", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move to Doing", exact: true })).toBeFocused();
  await expect.poll(() => patchBodies.length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(move).toBeFocused();
  await expect(move).toHaveAttribute("aria-expanded", "false");

  await move.click();
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-state", "saving");
  await expect(page.locator("#card-status")).toBeFocused();
  await expect(page.getByText("Preparing move", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move to Doing", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close Card and return to Next" })).toBeDisabled();
  expect(patchBodies.filter((body) => body.columnId === "doing")).toHaveLength(0);
  await page.getByRole("button", { name: "Move to Doing", exact: true }).dispatchEvent("click");
  releaseAutosave();
  await expect.poll(() => patchBodies.filter((body) => body.columnId === "doing").length).toBe(1);
  await expect(page.locator("#card-status")).toBeFocused();
  await expect(page.getByText("Moving Card", { exact: true })).toBeVisible();
  releaseMove();

  await expect(page.getByText("Card moved", { exact: true })).toBeVisible();
  await expect(page.getByText(`${seed.cards.desktopDraft.title} moved to Doing.`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Card and return to Doing" })).toBeVisible();
  await expect.poll(async () => {
    const stored = await readSeededProject(harness, seed.projectId);
    const card = stored.cards.find((candidate) => candidate.id === seed.cards.desktopDraft.id);
    return { body: card?.body, columnId: card?.columnId };
  }).toEqual({ body: sequencedBody, columnId: "doing" });
  expect(Object.hasOwn(patchBodies[0] || {}, "body")).toBe(true);
  expect(patchBodies.at(-1)).toEqual({ columnId: "doing" });

  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByText(`Moved ${seed.cards.desktopDraft.title}.`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Card and return to Doing" }).click();
  await expect(cardButton(page, seed.cards.desktopDraft.title)).toBeFocused();

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New Card", exact: true }).click();
  const createIn = page.getByLabel("Create in", { exact: true });
  await expect(createIn).toBeVisible();
  await expect(createIn).toHaveValue("next");
  await createIn.selectOption("done");
  await page.getByLabel("Title", { exact: true }).fill("Explicit Done destination");
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible();
  const stored = await readSeededProject(harness, seed.projectId);
  expect(stored.cards.find((card) => card.title === "Explicit Done destination")?.columnId).toBe("done");
  expectNoUnexpectedBrowserErrors(errors);
});

test("desktop Move keeps every stored destination reachable in a many-Column Project", async ({ page }) => {
  const manyColumnHarness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    const columns = Array.from({ length: 18 }, (_, index) => ({
      id: `column-${index + 1}`,
      name: `Column ${index + 1}`,
      position: index
    }));
    const createdProject = await postHarnessResource<{ project: { id: string } }>(
      manyColumnHarness,
      "/projects",
      { name: "Many destination Project", columns },
      "browser:many-columns:project"
    );
    const projectId = createdProject.project.id;
    const createdCard = await postHarnessResource<{ card: { id: string } }>(
      manyColumnHarness,
      `/projects/${projectId}/cards`,
      { title: "Reach the final Column", body: "Every destination stays available.", columnId: "column-1" },
      "browser:many-columns:card"
    );

    await page.setViewportSize({ width: 1440, height: 600 });
    await signInToWorkspace(page, manyColumnHarness);
    await expect(page.getByRole("heading", { name: "Many destination Project", exact: true })).toBeVisible();
    await openCard(page, "Reach the final Column");
    await page.getByRole("button", { name: "Move…", exact: true }).click();

    const panel = page.locator("#move-card-panel");
    await expect(panel).toBeVisible();
    const panelMetrics = await panel.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
        scrollHeight: element.scrollHeight
      };
    });
    expect(panelMetrics.bottom).toBeLessThanOrEqual(601);
    expect(panelMetrics.overflowY).toBe("auto");
    expect(panelMetrics.scrollHeight).toBeGreaterThan(panelMetrics.clientHeight);

    const lastDestination = page.getByRole("button", { name: "Move to Column 18", exact: true });
    await lastDestination.scrollIntoViewIfNeeded();
    await lastDestination.focus();
    await expect(lastDestination).toBeFocused();
    await expect(lastDestination).toBeVisible();
    await lastDestination.click();
    await expect(page.getByText("Card moved", { exact: true })).toBeVisible();
    const stored = await readSeededProject(manyColumnHarness, projectId);
    expect(stored.cards.find((card) => card.id === createdCard.card.id)?.columnId).toBe("column-18");
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await manyColumnHarness.stop();
  }
});

test("Move stays blocked when a pending Card autosave fails", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);
  await openCard(page, seed.cards.privacy.title);

  let autosaveReachedResolve!: () => void;
  let releaseAutosave!: () => void;
  const autosaveReached = new Promise<void>((resolve) => { autosaveReachedResolve = resolve; });
  const autosaveGate = new Promise<void>((resolve) => { releaseAutosave = resolve; });
  let movePatchCount = 0;
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.privacy.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.columnId) {
      movePatchCount += 1;
      await route.continue();
      return;
    }
    autosaveReachedResolve();
    await autosaveGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Deterministic pending autosave failure" })
    });
  });

  const unsavedBody = "This retained draft must not move before it saves";
  await page.getByLabel("Body", { exact: true }).fill(unsavedBody);
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await autosaveReached;
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.getByText("Preparing move", { exact: true })).toBeVisible();
  await expect(page.locator("#card-status")).toBeFocused();
  releaseAutosave();

  await expect(page.getByText("Changes not saved", { exact: true })).toBeVisible();
  await expect(page.getByText(/Deterministic pending autosave failure/)).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-state", "selected");
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(unsavedBody);
  await expect(page.getByRole("button", { name: "Move…", exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(movePatchCount).toBe(0);
  const stored = await readSeededProject(harness, seed.projectId);
  const unmoved = stored.cards.find((card) => card.id === seed.cards.privacy.id);
  expect(unmoved?.body).toBe(seed.cards.privacy.body);
  expect(unmoved?.columnId).toBe("next");
  expectNoUnexpectedBrowserErrors(errors, [/503/]);
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

test("390px mobile uses the same explicit Move command and returns to the destination Column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await openCard(page, seed.cards.mobileAutosave.title);
  const move = page.getByRole("button", { name: "Move…", exact: true });
  await expect(move).toBeVisible();
  await move.click();
  const panel = page.locator("#move-card-panel");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThanOrEqual(-1);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(391);
  await expectNoHorizontalOverflow(page, "390px Move Card choices");

  await page.getByRole("button", { name: "Move to Done", exact: true }).click();
  await expect(page.getByText("Card moved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();
  await page.getByRole("button", { name: "Close Card and return to Done" }).click();
  await expect(page.locator("#mobile-column")).toHaveValue("done");
  await expect(page.locator("section.column:visible").getByRole("heading", { name: "Done" })).toBeVisible();
  await expect(cardButton(page, seed.cards.mobileAutosave.title)).toBeFocused();
  const stored = await readSeededProject(harness, seed.projectId);
  expect(stored.cards.find((card) => card.id === seed.cards.mobileAutosave.id)?.columnId).toBe("done");
  expectNoUnexpectedBrowserErrors(errors);
});

test("390px new-Card destination does not change the launch Column return context", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);

  await page.locator("#mobile-column").selectOption("done");
  await expect(page.locator("section.column:visible").getByRole("heading", { name: "Done", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New Card", exact: true }).click();
  const createIn = page.getByLabel("Create in", { exact: true });
  await expect(createIn).toHaveValue("done");
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();

  await createIn.selectOption("next");
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-state", "validation-error");
  await expect(createIn).toHaveValue("next");
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();
  await page.getByRole("button", { name: "Close Card and return to Done" }).click();

  await expect(page.locator("#mobile-column")).toHaveValue("done");
  await expect(page.locator("section.column:visible").getByRole("heading", { name: "Done", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeFocused();
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

test("a stale move preserves only the requested destination for explicit retry or cancel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);
  await openCard(page, seed.cards.moveConflict.title);

  const moveBodies: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || !request.url().endsWith(`/cards/${seed.cards.moveConflict.id}`)) return;
    moveBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  const before = await readSeededProject(harness, seed.projectId);
  const current = before.cards.find((card) => card.id === seed.cards.moveConflict.id)!;
  await updateSeededCard(harness, seed.projectId, current.id, current.version, { body: "Stored API body must survive move retry" });
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();

  await expect(page.locator("body")).toHaveAttribute("data-state", "stale");
  await expect(page.getByRole("heading", { name: "The stored Card moved or changed" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Activity", exact: true }).dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "The stored Card moved or changed" })).toBeVisible();
  const cardTab = page.getByRole("tab", { name: "Card", exact: true });
  await cardTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(cardTab).toHaveAttribute("aria-selected", "true");
  await expect(cardTab).toBeFocused();
  await expect(page.getByRole("heading", { name: "The stored Card moved or changed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry move to Doing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel move", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Retry move to Doing", exact: true }).click();
  await expect(page.getByText("Card moved", { exact: true })).toBeVisible();
  const stored = await readSeededProject(harness, seed.projectId);
  const moved = stored.cards.find((card) => card.id === seed.cards.moveConflict.id);
  expect(moved?.body).toBe("Stored API body must survive move retry");
  expect(moved?.columnId).toBe("doing");
  expect(moveBodies).toEqual([{ columnId: "doing" }, { columnId: "doing" }]);
  expectNoUnexpectedBrowserErrors(errors, [/status of 409/i, /409 \(Conflict\)/i]);
});

test("a Card archived during move preparation returns to a visible board outcome", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);
  await openCard(page, seed.cards.moveArchived.title);

  await page.getByRole("button", { name: "Move…", exact: true }).click();
  const before = await readSeededProject(harness, seed.projectId);
  const current = before.cards.find((card) => card.id === seed.cards.moveArchived.id)!;
  await updateSeededCard(harness, seed.projectId, current.id, current.version, { archivedAt: new Date().toISOString() });
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();

  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByText("Move not completed", { exact: true })).toBeVisible();
  await expect(page.getByText(`${seed.cards.moveArchived.title} is archived and no longer appears on the active board.`, { exact: true })).toBeVisible();
  await expect(page.locator("#project-status")).toBeFocused();
  await expect(cardButton(page, seed.cards.moveArchived.title)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "The stored Card moved or changed" })).toHaveCount(0);
  const stored = await readSeededProject(harness, seed.projectId);
  const archived = stored.cards.find((card) => card.id === seed.cards.moveArchived.id);
  expect(archived?.archivedAt).not.toBeNull();
  expect(archived?.columnId).toBe("next");
  expectNoUnexpectedBrowserErrors(errors, [/status of 409/i, /409 \(Conflict\)/i]);
});

test("a committed move stays visible when its follow-up Refresh fails", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await authenticate(page, harness);
  await openCard(page, seed.cards.archive.title);

  let failNextProjectList = false;
  let movePatchCount = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith(`/cards/${seed.cards.archive.id}`)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.columnId === "done") movePatchCount += 1;
    }
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (failNextProjectList && request.method() === "GET" && pathname === "/api/projects") {
      failNextProjectList = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Deterministic follow-up Refresh failure" }) });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Move…", exact: true }).click();
  failNextProjectList = true;
  await page.getByRole("button", { name: "Move to Done", exact: true }).click();
  await expect(page.getByText("Card moved; refresh needed", { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`${seed.cards.archive.title} is stored in Done`))).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();
  expect(movePatchCount).toBe(1);
  const stored = await readSeededProject(harness, seed.projectId);
  expect(stored.cards.find((card) => card.id === seed.cards.archive.id)?.columnId).toBe("done");
  await page.getByRole("button", { name: "Close Card and return to Done" }).click();
  await expect(cardButton(page, seed.cards.archive.title)).toBeFocused();
  expectNoUnexpectedBrowserErrors(errors, [/503 .*\/api\/projects/i, /status of 503/i, /503 \(Service Unavailable\)/i]);
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

async function postHarnessResource<T>(
  targetHarness: BrowserHarness,
  pathname: string,
  body: Record<string, unknown>,
  idempotencyKey: string
): Promise<T> {
  const response = await fetch(`${targetHarness.baseUrl}/api${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${targetHarness.ownerKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-Kanban-Actor": "many-column-browser"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${pathname} failed with ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}
