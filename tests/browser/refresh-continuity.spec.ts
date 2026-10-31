/// <reference lib="dom" />

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  authenticate, cardButton, expectNoHorizontalOverflow, openCard, readSeededProject,
  seedBrowserWorkspace, startBrowserHarness, updateSeededCard,
  type BrowserHarness, type SeededWorkspace
} from "./support/context-dock-harness";

let harness: BrowserHarness;
let seed: SeededWorkspace;

test.beforeEach(async () => {
  harness = await startBrowserHarness();
  try { seed = await seedBrowserWorkspace(harness); }
  catch (error) { await harness.stop(); throw error; }
});
test.afterEach(async () => { await harness?.stop(); });

interface HeldRefresh {
  started: Promise<void>;
  release(): void;
}

async function holdRefresh(page: Page, part: "list" | "detail" = "detail", fail = false): Promise<HeldRefresh> {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const pathname = `/api/projects${part === "detail" ? `/${seed.projectId}` : ""}`;
  await page.route(url => url.pathname === pathname, async (route: Route) => {
    entered();
    await held;
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Refresh temporarily unavailable. Try again." }) });
    else await route.continue();
  }, { times: 1 });
  return { started, release };
}

async function openRefreshMenu(page: Page): Promise<Locator> {
  // At narrow widths an open Card covers the board toolbar. Dispatching the same
  // action lets the test cover a refresh already in progress when that layout is used.
  await page.locator("#project-actions-trigger").dispatchEvent("click");
  return page.getByRole("button", { name: "Refresh", exact: true, includeHidden: true });
}

async function focusSelection(field: Locator, start: number, end = start): Promise<void> {
  await field.evaluate((element, selection) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.focus({ preventScroll: true });
    input.setSelectionRange(selection.start, selection.end, "forward");
  }, { start, end });
}

async function editingContext(page: Page, field: Locator) {
  return field.evaluate(element => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    const inspector = document.querySelector<HTMLElement>(".inspector-content")!;
    const columns = document.querySelector<HTMLElement>(".columns")!;
    return {
      focused: document.activeElement === input,
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
      fieldTop: input.scrollTop,
      inspectorTop: inspector.scrollTop,
      viewportTop: input.getBoundingClientRect().top,
      columnsLeft: columns.scrollLeft,
      windowTop: window.scrollY
    };
  });
}

async function expectEditingContext(page: Page, field: Locator, expected: Awaited<ReturnType<typeof editingContext>>) {
  await expect(field).toBeFocused();
  const actual = await editingContext(page, field);
  expect(actual.start).toBe(expected.start);
  expect(actual.end).toBe(expected.end);
  expect(actual.direction).toBe(expected.direction);
  for (const key of ["fieldTop", "viewportTop", "columnsLeft", "windowTop"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${key} remains at the user's editing position`).toBeLessThanOrEqual(1);
  }
}

function visibleRefreshFailure(page: Page) {
  return page.locator(".jk-status:visible").filter({ hasText: "Refresh failed" });
}

for (const width of [1440, 390]) {
  test(`${width}px refresh keeps the board and editing position, captures pending edits, and merges unrelated saved fields`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await authenticate(page, harness);
    await openCard(page, seed.cards.desktopDraft.title);
    const title = page.getByLabel("Title", { exact: true });
    const description = page.getByLabel("Description", { exact: true });
    const localTitle = "Local refresh draft";
    const localBody = Array.from({ length: 65 }, (_, index) => `Line ${index}: Keep this unsaved description.`).join("\n");
    await title.fill(localTitle);
    await description.fill(localBody);
    await page.getByLabel("Next actor", { exact: true }).last().selectOption("agent");
    await page.getByLabel("Priority", { exact: true }).last().selectOption("Low");
    await page.getByLabel("Blocker", { exact: true }).fill("Local blocker");
    const url = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const boardCount = await page.locator(".columns button.board-card").count();
    const held = await holdRefresh(page);
    const refresh = await openRefreshMenu(page);
    await focusSelection(description, 260, 268);
    await description.evaluate(element => {
      element.scrollTop = 110;
      document.querySelector<HTMLElement>(".inspector-content")!.scrollTop = 200;
      document.querySelector<HTMLElement>(".columns")!.scrollLeft = 90;
    });
    const before = await editingContext(page, description);
    await refresh.dispatchEvent("click");
    await held.started;
    try {
      await expect(page.locator("body")).toHaveAttribute("data-state", "refreshing");
      await expect(page.locator(".columns button.board-card")).toHaveCount(boardCount);
      if (width === 1440) await expect(page.locator(".columns")).toBeVisible();
      await expect(description).toBeEnabled();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await expectEditingContext(page, description, before);
      await page.keyboard.insertText("typed while loading");
      const pendingBody = await description.inputValue();
      await page.getByLabel("Priority", { exact: true }).last().selectOption("High");
      await focusSelection(description, 279);
      await description.evaluate(element => { element.scrollTop = 120; });
      const pending = await editingContext(page, description);
      const stored = await readSeededProject(harness, seed.projectId);
      const card = stored.cards.find(candidate => candidate.id === seed.cards.desktopDraft.id)!;
      await updateSeededCard(harness, seed.projectId, card.id, card.version, { nextAction: "Saved follow-up from another client" });
      held.release();
      await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
      await expect(title).toHaveValue(localTitle);
      await expect(description).toHaveValue(pendingBody);
      await expect(page.getByLabel("Next actor", { exact: true }).last()).toHaveValue("agent");
      await expect(page.getByLabel("Priority", { exact: true }).last()).toHaveValue("High");
      await expect(page.getByLabel("Blocker", { exact: true })).toHaveValue("Local blocker");
      await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Saved follow-up from another client");
      await expectEditingContext(page, description, pending);
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await expect(page.getByRole("heading", { name: "The stored Card changed", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(url);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      const after = await readSeededProject(harness, seed.projectId);
      expect(after.cards.find(candidate => candidate.id === card.id)?.body).toBe(seed.cards.desktopDraft.body);
      await expectNoHorizontalOverflow(page, `refresh result at ${width}px`);
      await page.screenshot({ path: test.info().outputPath(`refresh-success-${width}.png`) });
    } finally { held.release(); }
  });
}

for (const width of [1440, 390]) {
  for (const part of ["list", "detail"] as const) {
    test(`${width}px ${part} refresh failure preserves the board, draft and caret and offers a working retry`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await authenticate(page, harness);
      await openCard(page, seed.cards.desktopDraft.title);
      await page.getByLabel("Title", { exact: true }).fill("Draft retained after refresh failure");
      await page.getByLabel("Description", { exact: true }).fill("Unsaved body after failure");
      await page.getByLabel("Next action", { exact: true }).fill("Keep this unsaved next action");
      const field = page.getByLabel(part === "detail" ? "Title" : "Next action", { exact: true });
      const boardCount = await page.locator(".columns button.board-card").count();
      const url = page.url();
      const held = await holdRefresh(page, part, true);
      const refresh = await openRefreshMenu(page);
      await focusSelection(field, 5, 10);
      const before = await editingContext(page, field);
      await refresh.dispatchEvent("click");
      await held.started;
      try {
        await expect(page.locator(".columns button.board-card")).toHaveCount(boardCount);
        await expectEditingContext(page, field, before);
        held.release();
        await expect(visibleRefreshFailure(page)).toBeVisible();
        await expect(visibleRefreshFailure(page)).toContainText("Refresh temporarily unavailable");
        await expect(page.locator(".columns button.board-card")).toHaveCount(boardCount);
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft retained after refresh failure");
        await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Unsaved body after failure");
        await expectEditingContext(page, field, before);
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect(page).toHaveURL(url);
        const retry = page.getByRole("button", { name: "Retry refresh", exact: true });
        await expect(retry).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: test.info().outputPath(`refresh-failure-${part}-${width}.png`) });
        await retry.click();
        await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
        await expect(visibleRefreshFailure(page)).toHaveCount(0);
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft retained after refresh failure");
        await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Keep this unsaved next action");
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expectNoHorizontalOverflow(page, `refresh retry at ${width}px`);
      } finally { held.release(); }
    });
  }
}

test("refresh requires an explicit choice for overlapping edits and never writes a draft implicitly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === `/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`) writes.push(request.postData() || "");
  });
  await page.getByLabel("Title", { exact: true }).fill("Local conflicting title");
  const held = await holdRefresh(page);
  const refresh = await openRefreshMenu(page);
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    const stored = await readSeededProject(harness, seed.projectId);
    const card = stored.cards.find(candidate => candidate.id === seed.cards.desktopDraft.id)!;
    await updateSeededCard(harness, seed.projectId, card.id, card.version, { title: "Saved conflicting title", body: "Saved unrelated description" });
    held.release();
    await expect(page.getByRole("heading", { name: "The stored Card changed", exact: true })).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Local conflicting title");
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Saved unrelated description");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect((await readSeededProject(harness, seed.projectId)).cards.find(candidate => candidate.id === card.id)?.title).toBe("Saved conflicting title");
    await page.getByRole("button", { name: "Keep draft", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await readSeededProject(harness, seed.projectId)).cards.find(candidate => candidate.id === card.id)?.title).toBe("Local conflicting title");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).body).toBe("Saved unrelated description");
  } finally { held.release(); }
});

test("keyboard refresh returns to Actions and adds no history entry before Back and Forward restore the Card draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticate(page, harness);
  const projectUrl = page.url();
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByLabel("Title", { exact: true }).fill("Keyboard refresh history draft");
  const cardUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const held = await holdRefresh(page);
  const actions = page.getByRole("button", { name: "Actions", exact: true });
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "New Project", exact: true })).toBeFocused();
  for (let index = 0; index < 5; index += 1) await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await held.started;
  try {
    held.release();
    await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
    await expect(actions).toBeFocused();
    await expect(page).toHaveURL(cardUrl);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.goBack();
    await expect(page).toHaveURL(projectUrl);
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(cardUrl);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keyboard refresh history draft");
    await page.getByRole("button", { name: "Close Card and return to Next", exact: true }).click();
    await expect(cardButton(page, seed.cards.desktopDraft.title)).toBeFocused();
  } finally { held.release(); }
});

test("an unsent Comment keeps focus, selection, scrolling and edits made during refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  let commentPosts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/comments")) commentPosts += 1;
  });
  const comment = page.getByLabel("Add Comment", { exact: true });
  const body = Array.from({ length: 30 }, (_, index) => `Unsent comment line ${index}`).join("\n");
  await comment.fill(body);
  const held = await holdRefresh(page);
  const refresh = await openRefreshMenu(page);
  await focusSelection(comment, 95);
  await comment.evaluate(element => {
    element.scrollTop = 60;
    const inspector = document.querySelector<HTMLElement>(".inspector-content")!;
    inspector.scrollTop = inspector.scrollHeight;
  });
  const before = await editingContext(page, comment);
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    await expectEditingContext(page, comment, before);
    await expect(comment).toBeEnabled();
    await page.keyboard.insertText("kept while loading");
    const pendingBody = await comment.inputValue();
    const pending = await editingContext(page, comment);
    held.release();
    await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
    await expect(comment).toHaveValue(pendingBody);
    await expectEditingContext(page, comment, pending);
    await expect(page.getByRole("button", { name: "Add Comment", exact: true })).toBeEnabled();
    expect(commentPosts).toBe(0);
    expect((await readSeededProject(harness, seed.projectId)).cards.find(candidate => candidate.id === seed.cards.desktopDraft.id)).toMatchObject({ title: seed.cards.desktopDraft.title, body: seed.cards.desktopDraft.body });
  } finally { held.release(); }
});


for (const width of [1440, 390]) {
  test(`${width}px refresh status changes keep a focused field near the viewport bottom in the same visible position`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await authenticate(page, harness);
    await openCard(page, seed.cards.desktopDraft.title);
    await page.getByLabel("Description", { exact: true }).fill("A retained draft for visible editing continuity.");
    const field = page.getByLabel("Next action", { exact: true });
    await field.fill("Keep this selection visible during refresh");
    const first = await holdRefresh(page, "detail", true);
    const refresh = await openRefreshMenu(page);
    await focusSelection(field, 8, 17);
    await field.evaluate(element => {
      const inspector = element.closest<HTMLElement>(".inspector-content")!;
      inspector.scrollTop += element.getBoundingClientRect().top - (window.innerHeight - 160);
    });
    const before = await editingContext(page, field);
    expect(before.viewportTop).toBeGreaterThan(640);
    expect(before.viewportTop).toBeLessThan(700);
    await expect(field).toBeInViewport({ ratio: 1 });
    await refresh.dispatchEvent("click");
    await first.started;
    try {
      await expectEditingContext(page, field, before);
      await expect(field).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath(`refresh-pending-position-${width}.png`) });
      first.release();
      await expect(visibleRefreshFailure(page)).toBeVisible();
      await expectEditingContext(page, field, before);
      await expect(field).toBeInViewport({ ratio: 1 });
      const retry = await holdRefresh(page);
      await page.getByRole("button", { name: "Retry refresh", exact: true }).dispatchEvent("click");
      await retry.started;
      try {
        await expectEditingContext(page, field, before);
        retry.release();
        await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
        await expectEditingContext(page, field, before);
        await expect(field).toBeInViewport({ ratio: 1 });
      } finally { retry.release(); }
    } finally { first.release(); }
  });
}

test("explicit move-conflict focus after refresh overrides the previous editor scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.moveConflict.title);
  await page.getByLabel("Description", { exact: true }).fill("Local body stays separate from the requested move.");
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  const stored = await readSeededProject(harness, seed.projectId);
  const card = stored.cards.find(candidate => candidate.id === seed.cards.moveConflict.id)!;
  await updateSeededCard(harness, seed.projectId, card.id, card.version, { nextAction: "Concurrent stored follow-up" });
  await page.route(url => url.pathname === `/api/projects/${seed.projectId}`, route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Latest Card temporarily unavailable" })
  }), { times: 1 });
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  const heading = page.getByRole("heading", { name: "The stored Card moved or changed", exact: true });
  await expect(heading).toBeFocused();
  const refresh = page.getByRole("button", { name: "Refresh latest", exact: true });
  await expect(refresh).toBeVisible();
  const comment = page.getByLabel("Add Comment", { exact: true });
  await comment.fill("Keep this unsent Comment");
  await comment.focus();
  await comment.evaluate(element => {
    const inspector = element.closest<HTMLElement>(".inspector-content")!;
    inspector.scrollTop = inspector.scrollHeight;
  });
  await expect(heading).not.toBeInViewport();
  const held = await holdRefresh(page);
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    held.release();
    await expect(page.getByRole("button", { name: "Retry move to Doing", exact: true })).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(comment).toHaveValue("Keep this unsent Comment");
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Local body stays separate from the requested move.");
    expect((await readSeededProject(harness, seed.projectId)).cards.find(candidate => candidate.id === card.id)?.columnId).toBe("next");
  } finally { held.release(); }
});

test("a focused Description Preview moves to visible conflict recovery when refresh must return to Write", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByLabel("Description", { exact: true }).fill("# Local description requiring a choice");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  const preview = page.getByRole("tabpanel", { name: "Preview", exact: true });
  const held = await holdRefresh(page);
  const refresh = await openRefreshMenu(page);
  await preview.focus();
  await expect(preview).toBeFocused();
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    const stored = await readSeededProject(harness, seed.projectId);
    const card = stored.cards.find(candidate => candidate.id === seed.cards.desktopDraft.id)!;
    await updateSeededCard(harness, seed.projectId, card.id, card.version, { body: "# Conflicting stored description" });
    held.release();
    const heading = page.getByRole("heading", { name: "The stored Card changed", exact: true });
    await expect(heading).toBeVisible();
    await expect(preview).toBeHidden();
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("# Local description requiring a choice");
    await expect(page.getByRole("button", { name: "Keep draft", exact: true })).toBeVisible();
  } finally { held.release(); }
});

test("a delayed refresh cannot clear a newly signed-in session or replace its draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByLabel("Title", { exact: true }).fill("Draft before another tab signs out");
  const cardUrl = page.url();
  const held = await holdRefresh(page);
  const refresh = await openRefreshMenu(page);
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    await page.evaluate(() => {
      const channel = new BroadcastChannel("kanban.cards:session");
      channel.postMessage("signed-out");
      channel.close();
    });
    await expect(page.getByLabel("Owner key", { exact: true })).toBeVisible();
    await page.getByLabel("Owner key", { exact: true }).fill(harness.ownerKey);
    await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    const title = page.getByLabel("Title", { exact: true });
    await expect(title).toHaveValue("Draft before another tab signs out");
    await title.fill("New signed-in draft survives the old refresh");
    await focusSelection(title, 4, 11);
    const finished = page.waitForEvent("requestfinished", request => new URL(request.url()).pathname === `/api/projects/${seed.projectId}`);
    held.release();
    await finished;
    // Let the completed response's parsing/catch/finally work settle before checking
    // that an expired request did not clear or rerender the replacement session.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel("Owner key", { exact: true })).toHaveCount(0);
    await expect(title).toHaveValue("New signed-in draft survives the old refresh");
    await expect(title).toBeFocused();
    expect(await title.evaluate(element => ({ start: (element as HTMLInputElement).selectionStart, end: (element as HTMLInputElement).selectionEnd }))).toEqual({ start: 4, end: 11 });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(cardUrl);
    await expect(visibleRefreshFailure(page)).toHaveCount(0);
  } finally { held.release(); }
});


test("320px refresh failure keeps Retry, Move, Close and the focused editor usable without overlap", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Narrow draft after refresh failure");
  await page.getByLabel("Description", { exact: true }).fill("Retain this unsaved narrow description.");
  const held = await holdRefresh(page, "detail", true);
  const refresh = await openRefreshMenu(page);
  await title.focus();
  await focusSelection(title, 5, 11);
  await refresh.dispatchEvent("click");
  await held.started;
  try {
    held.release();
    await expect(visibleRefreshFailure(page)).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry refresh", exact: true });
    const controls = [
      page.getByRole("tab", { name: "Card", exact: true }),
      page.getByRole("tab", { name: "Activity", exact: true }),
      page.getByRole("button", { name: "Move…", exact: true }),
      retry,
      page.getByRole("button", { name: "Close Card and return to Next", exact: true })
    ];
    for (const control of controls) await expect(control).toBeInViewport({ ratio: 1 });
    const boxes = await Promise.all(controls.map(control => control.boundingBox()));
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left]!, b = boxes[right]!;
        const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapWidth > 1 && overlapHeight > 1, `toolbar controls ${left} and ${right} must not overlap`).toBe(false);
      }
    }
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("Narrow draft after refresh failure");
    expect(await title.evaluate(element => ({ start: (element as HTMLInputElement).selectionStart, end: (element as HTMLInputElement).selectionEnd }))).toEqual({ start: 5, end: 11 });
    await expect(title).toBeInViewport({ ratio: 1 });
    const toolbarBox = await page.locator(".inspector-toolbar").boundingBox();
    const titleBox = await title.boundingBox();
    expect(titleBox!.y, "the sticky toolbar must not cover the focused Title").toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height - 1);
    await expectNoHorizontalOverflow(page, "320px visible refresh retry");
    await page.screenshot({ path: test.info().outputPath("refresh-failure-toolbar-320.png") });
    await retry.click();
    await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
    await expect(title).toHaveValue("Narrow draft after refresh failure");
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Retain this unsaved narrow description.");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  } finally { held.release(); }
});
