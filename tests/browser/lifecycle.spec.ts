/// <reference lib="dom" />

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

import {
  assertChromiumInstalled,
  authenticate,
  expectNoHorizontalOverflow,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors,
  openCard,
  readSeededProject,
  seedBrowserWorkspace,
  signInToWorkspace,
  startBrowserHarness,
  updateSeededProject
} from "./support/context-dock-harness";

interface HeldRequest {
  reached: Promise<void>;
  continue(): void;
  fulfill(status: number, body: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

type HeldRequestResolution =
  | { kind: "continue" }
  | { kind: "fulfill"; status: number; body: Record<string, unknown> };

function addColumnTrigger(page: Page) {
  const placement = (page.viewportSize()?.width || 1440) <= 768 ? ".add-column-narrow" : ".add-column-desktop";
  return page.locator(`${placement} [data-action="add-column"]`);
}

function addColumnSubmit(page: Page) {
  return page.locator('form[data-form="add-column"] button[type="submit"]');
}

test.beforeAll(async () => {
  await assertChromiumInstalled();
});

test("invalid access reveals no private Project or Card data", async ({ page, context }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  const rejectedKey = "known-wrong-browser-owner-key";

  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.goto(harness.baseUrl);
    await page.getByLabel("Owner key").fill(rejectedKey);
    await page.getByRole("button", { name: "Open workspace" }).click();

    await expect(page.locator("body")).toHaveAttribute("data-state", "invalid-key");
    await expect(page.getByText("Owner key not accepted", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Owner key")).toBeFocused();
    await expect(page.getByLabel("Owner key")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Owner key")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("Context Dock regression");
    await expect(page.locator("body")).not.toContainText(seed.cards.privacy.title);
    await expect(page.locator("body")).not.toContainText(seed.cards.privacy.body);
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.cards:project-id"))).toBeNull();
    expect((await context.cookies()).some((cookie) => cookie.name === "kanban_cards_session")).toBe(false);
    expect(await page.content()).not.toContain(rejectedKey);
    expectNoUnexpectedBrowserErrors(errors, [/401/]);
  } finally {
    await harness.stop();
  }
});

test("empty workspace and Project expose validated, duplicate-locked creation", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  let projectCreateRequests = 0;
  let projectPatchRequests = 0;
  let projectPatchHeaders: Record<string, string> = {};
  let projectPatchBody: Record<string, unknown> = {};
  let cardCreateRequests = 0;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/projects") projectCreateRequests += 1;
    if (request.method() === "PATCH" && /^\/api\/projects\/[^/]+$/.test(url.pathname)) {
      projectPatchRequests += 1;
      projectPatchHeaders = request.headers();
      projectPatchBody = request.postDataJSON() as Record<string, unknown>;
    }
    if (request.method() === "POST" && /^\/api\/projects\/[^/]+\/cards$/.test(url.pathname)) cardCreateRequests += 1;
  });

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signInToWorkspace(page, harness);
    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-workspace");
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    await expect(page.getByLabel("Active Project")).toBeDisabled();
    await expect(addColumnTrigger(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Create Project", exact: true }).click();
    await page.getByRole("button", { name: "Save Project", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-state", "validation-error");
    await expect(page.locator("#project-editor-status").getByText("Project needs attention", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Enter a Project name before saving.", { exact: true })).toBeVisible();
    expect(projectCreateRequests).toBe(0);

    await page.getByLabel("Name", { exact: true }).fill("Lifecycle Project");
    const projectGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname === "/api/projects";
    });
    try {
      await page.getByRole("button", { name: "Save Project", exact: true }).click();
      await projectGate.reached;
      await expect(page.locator("body")).toHaveAttribute("data-state", "saving");
      await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
      expect(await page.locator("#project-editor form input, #project-editor form textarea, #project-editor form button").evaluateAll((controls) =>
        controls.every((control) => (control as HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement).disabled)
      )).toBe(true);
      await page.locator('form[data-form="project"]').dispatchEvent("submit");
      expect(projectCreateRequests).toBe(1);
      projectGate.continue();
      await expect(page.locator("#toast-region").getByText("Project created", { exact: true })).toBeVisible();
    } finally {
      await projectGate.dispose();
    }

    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-project");
    await expect(page.getByLabel("Active Project")).toBeEnabled();
    await expect(addColumnTrigger(page)).toBeVisible();
    for (const columnName of ["Next", "Doing", "Done"]) {
      await expect(page.locator("section.column").getByRole("heading", { name: columnName, exact: true })).toBeVisible();
    }

    const nextColumn = page.locator('section.column[data-column-id="next"]');
    await nextColumn.getByRole("button", { name: "Create Card", exact: true }).click();
    const inspector = page.getByRole("complementary");
    await expect(inspector.getByLabel("Create in")).toHaveValue("next");
    await inspector.getByRole("button", { name: "Create Card", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-state", "validation-error");
    await expect(page.getByText("Card needs attention", { exact: true })).toBeVisible();
    await expect(inspector.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(inspector.getByLabel("Title", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Enter a Card title before saving.", { exact: true })).toBeVisible();
    expect(cardCreateRequests).toBe(0);

    await inspector.getByLabel("Title", { exact: true }).fill("Lifecycle-created Card");
    await inspector.getByLabel("Create in").selectOption("doing");
    const cardGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && /^\/api\/projects\/[^/]+\/cards$/.test(url.pathname);
    });
    try {
      await inspector.getByRole("button", { name: "Create Card", exact: true }).click();
      await cardGate.reached;
      await expect(page.locator("body")).toHaveAttribute("data-state", "saving");
      await expect(inspector.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
      expect(await inspector.locator('form[data-form="card"] input, form[data-form="card"] select, form[data-form="card"] textarea, form[data-form="card"] button').evaluateAll((controls) =>
        controls.every((control) => (control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement).disabled)
      )).toBe(true);
      const closeCard = inspector.getByRole("button", { name: "Close Card and return to Next" });
      await expect(closeCard).toBeDisabled();
      await closeCard.dispatchEvent("click");
      await expect(inspector).toBeVisible();
      await inspector.locator('form[data-form="card"]').dispatchEvent("submit");
      expect(cardCreateRequests).toBe(1);
      cardGate.continue();
      await expect(page.locator("#toast-region").getByText("Card created", { exact: true })).toBeVisible();
    } finally {
      await cardGate.dispose();
    }

    const projectId = await page.getByLabel("Active Project").inputValue();
    const afterCardCreation = await readSeededProject(harness, projectId);
    const createdCard = afterCardCreation.cards.find((card) => card.title === "Lifecycle-created Card");
    expect(createdCard?.columnId).toBe("doing");
    const beforeColumnAppend = await updateSeededProject(harness, projectId, afterCardCreation.revision, {
      columns: [
        ...afterCardCreation.columns,
        { id: "api-handoff", name: "API-managed handoff", position: 7 }
      ]
    });
    expect(beforeColumnAppend.columns.slice(0, -1)).toEqual(afterCardCreation.columns);
    expect(beforeColumnAppend.cards).toEqual(afterCardCreation.cards);

    const board = page.locator(".board-pane");
    await expect(addColumnTrigger(page)).toBeVisible();
    await expect(addColumnTrigger(page)).toHaveAttribute("type", "button");
    await expect(page.locator(".columns > :last-child")).toHaveClass(/add-column-desktop/);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await expect(page.locator("#project-actions-panel").getByRole("button", { name: "Add Column", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await expect(page.locator("#project-actions-panel")).toHaveCount(0);
    await addColumnTrigger(page).click();
    await expect(page.getByRole("heading", { name: "Add Column", exact: true })).toBeVisible();
    await expect(page.getByText("The new Column will appear after API-managed handoff.", { exact: true })).toBeVisible();
    await expect(board.locator('section.column[data-column-id="next"]')).toBeVisible();
    const columnName = page.getByLabel("Column name", { exact: true });
    await expect(columnName).toBeFocused();
    await expect(page.getByLabel("Active Project")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Open account panel" })).toBeDisabled();
    await expect(board.locator(".board-card").first()).toBeDisabled();
    await expect(page.locator(".workspace")).toHaveAttribute("data-card-open", "false");
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByRole("button", { name: "Open account panel" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "1024px Add Column form");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(columnName).toBeVisible();
    await expect(page.locator(".add-column-narrow")).toBeVisible();
    await expect(page.locator('section.column[data-mobile-active="true"]')).toBeVisible();
    await expect(addColumnSubmit(page)).toBeVisible();
    await expectNoHorizontalOverflow(page, "390px Add Column form");
    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoHorizontalOverflow(page, "320px Add Column form");
    await addColumnSubmit(page).click();
    await expect(page.locator("body")).toHaveAttribute("data-state", "validation-error");
    await expect(columnName).toHaveAttribute("aria-invalid", "true");
    await expect(columnName).toHaveAttribute("aria-describedby", /(^| )add-column-name-error( |$)/);
    await expect(columnName).toHaveAttribute("aria-errormessage", "add-column-name-error");
    await expect(page.getByText("Enter a Column name.", { exact: true })).toBeVisible();
    await expect(columnName).toBeFocused();
    await expectNoHorizontalOverflow(page, "320px Add Column validation");
    expect(projectPatchRequests).toBe(0);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: /Close Card/ })).toBeEnabled();
    expect(projectPatchRequests).toBe(0);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await addColumnTrigger(page).click();
    await page.getByLabel("Column name", { exact: true }).fill("Review and quality assurance");
    const columnGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "PATCH" && url.pathname === `/api/projects/${projectId}`;
    });
    try {
      await addColumnSubmit(page).click();
      await columnGate.reached;
      await expect(page.locator("body")).toHaveAttribute("data-state", "saving");
      await expect(page.locator("#add-column-status")).toBeFocused();
      await expect(page.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
      expect(await page.locator('form[data-form="add-column"] input, form[data-form="add-column"] button').evaluateAll((controls) =>
        controls.every((control) => (control as HTMLInputElement | HTMLButtonElement).disabled)
      )).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Add Column", exact: true })).toBeVisible();
      await expect(board.locator('section.column[data-column-id="next"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
      await expect(page.locator("#toast-region").getByText("Column unchanged", { exact: true })).toHaveCount(0);
      await page.locator('form[data-form="add-column"]').dispatchEvent("submit");
      expect(projectPatchRequests).toBe(1);
      columnGate.continue();
      await expect(page.locator("#toast-region").getByText("Column added", { exact: true })).toBeVisible();
    } finally {
      await columnGate.dispose();
    }

    const afterColumnAppend = await readSeededProject(harness, projectId);
    const appendedColumn = afterColumnAppend.columns.at(-1);
    expect(Object.keys(projectPatchBody)).toEqual(["columns"]);
    expect(projectPatchHeaders["x-kanban-version"]).toBe(String(beforeColumnAppend.revision));
    expect((projectPatchBody.columns as Array<{ id: string; name: string; position: number }>).slice(0, -1)).toEqual(beforeColumnAppend.columns);
    expect(appendedColumn?.id).toMatch(/^column-/);
    expect(appendedColumn).toEqual({
      id: (projectPatchBody.columns as Array<{ id: string; name: string; position: number }>).at(-1)?.id,
      name: "Review and quality assurance",
      position: Math.max(...beforeColumnAppend.columns.map((column) => column.position)) + 1
    });
    expect(afterColumnAppend.cards).toEqual(beforeColumnAppend.cards);
    expect(afterColumnAppend.revision).toBe(beforeColumnAppend.revision + 1);
    const appendedHeading = page.locator(`section.column[data-column-id="${appendedColumn?.id}"]`).getByRole("heading", { name: "Review and quality assurance", exact: true });
    await expect(appendedHeading).toBeVisible();
    await expect(appendedHeading).toBeFocused();
    await expect(page.locator(".columns > :last-child")).toHaveClass(/add-column-desktop/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Visible Column")).toHaveValue(appendedColumn?.id || "");
    await expect(page.getByLabel("Visible Column").locator("option:checked")).toHaveText("Review and quality assurance · 0 Cards");
    await expect(appendedHeading).toBeVisible();
    await expectNoHorizontalOverflow(page, "390px appended Column");
    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoHorizontalOverflow(page, "320px appended Column");
    expect(projectCreateRequests).toBe(1);
    expect(projectPatchRequests).toBe(1);
    expect(cardCreateRequests).toBe(1);
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("Add Column retains explicit intent when the Project revision is stale", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    const beforeConflict = await readSeededProject(harness, seed.projectId);

    const latestProjectGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === `/api/projects/${seed.projectId}`;
    });
    try {
      await addColumnTrigger(page).click();
      await latestProjectGate.reached;
      await expect(page.locator("body")).toHaveAttribute("data-state", "saving");
      await expect(page.locator("#add-column-status").getByText("Preparing Add Column", { exact: true })).toBeVisible();
      await expect(page.locator("#add-column-status")).toBeFocused();
      await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeDisabled();
      await expect(page.locator(".board-card").first()).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.locator("#add-column-status").getByText("Preparing Add Column", { exact: true })).toBeVisible();
      latestProjectGate.continue();
      await expect(page.getByRole("heading", { name: "Add Column", exact: true })).toBeVisible();
    } finally {
      await latestProjectGate.dispose();
    }
    await page.getByLabel("Column name", { exact: true }).fill("Retained browser Column");

    const externallyUpdated = await updateSeededProject(harness, seed.projectId, beforeConflict.revision, {
      columns: [
        ...beforeConflict.columns,
        { id: "external-review", name: "External review", position: beforeConflict.columns.length }
      ]
    });
    expect(externallyUpdated.revision).toBe(beforeConflict.revision + 1);

    await addColumnSubmit(page).click();
    const conflictStatus = page.locator("#add-column-status");
    await expect(conflictStatus.getByText("Column was not added", { exact: true })).toBeVisible();
    await expect(conflictStatus).toContainText("This Project changed elsewhere. Your Column name is still here.");
    await expect(conflictStatus).toBeFocused();
    await expect(page.getByLabel("Column name", { exact: true })).toHaveValue("Retained browser Column");
    await expect(page.locator("#toast-region").getByText("Column added", { exact: true })).toHaveCount(0);

    const stored = await readSeededProject(harness, seed.projectId);
    expect(stored.columns.map((column) => column.id)).toEqual(["next", "doing", "done", "external-review"]);
    expect(stored.columns.some((column) => column.name === "Retained browser Column")).toBe(false);
    expect(stored.cards).toEqual(beforeConflict.cards);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(addColumnTrigger(page)).toBeFocused();
    expectNoUnexpectedBrowserErrors(errors, [/status of 409/i, /409 \(Conflict\)/i]);
  } finally {
    await harness.stop();
  }
});

test("narrow Add Column opens directly above the active Column and returns to its trigger", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 390, height: 844 });
    await authenticate(page, harness);
    const board = page.locator(".board-pane");
    const narrowControl = board.locator(".add-column-narrow");
    await expect(narrowControl).toBeVisible();
    expect(await board.locator(".add-column-narrow, .columns").evaluateAll((elements) => elements.map((element) => element.className))).toEqual([
      expect.stringContaining("add-column-narrow"),
      "columns"
    ]);
    await addColumnTrigger(page).click();
    await expect(page.getByLabel("Column name", { exact: true })).toBeFocused();
    await expect(page.locator('section.column[data-mobile-active="true"]')).toBeVisible();
    await expectNoHorizontalOverflow(page, "390px native narrow Add Column");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(addColumnTrigger(page)).toBeFocused();
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("Add Column fails closed when the latest Project cannot be loaded", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  let projectPatchRequests = 0;
  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    const before = await readSeededProject(harness, seed.projectId);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "PATCH" && url.pathname === `/api/projects/${seed.projectId}`) projectPatchRequests += 1;
    });
    await page.route(`**/api/projects/${seed.projectId}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Deterministic latest Project read failure" })
      });
    });

    await addColumnTrigger(page).click();
    const status = page.locator("#project-status");
    await expect(status.getByText("Add Column did not open", { exact: true })).toBeVisible();
    await expect(status).toContainText("Deterministic latest Project read failure");
    await expect(status).toBeFocused();
    await expect(page.locator("#add-column-editor")).toHaveCount(0);
    await expect(addColumnTrigger(page)).toBeEnabled();
    await expect(page.getByLabel("Active Project")).toBeEnabled();
    expect(projectPatchRequests).toBe(0);

    await page.unroute(`**/api/projects/${seed.projectId}`);
    const stored = await readSeededProject(harness, seed.projectId);
    expect(stored.columns).toEqual(before.columns);
    expect(stored.cards).toEqual(before.cards);
    expect(stored.revision).toBe(before.revision);
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("Add Column reads full latest Project while retaining an unrelated local Card draft", async ({ page }) => {
  const harness = await startBrowserHarness();
  try {
    const seed = await seedBrowserWorkspace(harness); await authenticate(page, harness); await openCard(page, seed.cards.privacy.title);
    await page.getByLabel("Description", { exact: true }).fill("Local Card draft while adding a Column");
    const before = await readSeededProject(harness, seed.projectId);
    await updateSeededProject(harness, seed.projectId, before.revision, { columns: [...before.columns, { id: "parallel-review", name: "Parallel review", position: 9 }] });
    await addColumnTrigger(page).click(); await expect(page.getByText("The new Column will appear after Parallel review.", { exact: true })).toBeVisible();
    await page.getByLabel("Column name", { exact: true }).fill("After synchronized work"); await addColumnSubmit(page).click();
    await expect(page.getByText("Column added", { exact: true })).toBeVisible();
    const stored = await readSeededProject(harness, seed.projectId);
    expect(stored.columns.at(-1)?.name).toBe("After synchronized work"); expect(stored.cards.find(card => card.id === seed.cards.privacy.id)?.body).toBe(seed.cards.privacy.body);
    await openCard(page, seed.cards.privacy.title); await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Local Card draft while adding a Column");
  } finally { await harness.stop(); }
});

test("Add Column cancellation returns to Activity without submitting the local Card draft", async ({ page }) => {
  const harness = await startBrowserHarness();
  try {
    const seed = await seedBrowserWorkspace(harness); await authenticate(page, harness); await openCard(page, seed.cards.privacy.title);
    await page.getByLabel("Description", { exact: true }).fill("Retained Card source across Column cancellation");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await addColumnTrigger(page).click(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#activity-panel")).toBeVisible(); await page.getByRole("tab", { name: "Card", exact: true }).click();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Retained Card source across Column cancellation");
    expect((await readSeededProject(harness, seed.projectId)).cards.find(card => card.id === seed.cards.privacy.id)?.body).toBe(seed.cards.privacy.body);
  } finally { await harness.stop(); }
});

test("Add Column freezes an unconfirmed attempt until the owner refreshes", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    await addColumnTrigger(page).click();
    await page.getByLabel("Column name", { exact: true }).fill("Unconfirmed browser Column");

    const projectRoute = `**/api/projects/${seed.projectId}`;
    await page.route(projectRoute, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Deterministic unconfirmed Column outcome" })
      });
    });

    await addColumnSubmit(page).click();
    const status = page.locator("#add-column-status");
    await expect(status.getByText("Column outcome unconfirmed", { exact: true })).toBeVisible();
    await expect(status).toBeFocused();
    await expect(page.getByLabel("Column name", { exact: true })).toHaveValue("Unconfirmed browser Column");
    await expect(page.getByLabel("Column name", { exact: true })).toBeDisabled();
    await expect(addColumnSubmit(page)).toBeDisabled();
    await expect(page.locator("#toast-region").getByText("Column added", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const persistentStatus = page.locator("#project-status");
    await expect(persistentStatus.getByText("Column outcome unconfirmed", { exact: true })).toBeVisible();
    await expect(persistentStatus).toContainText("Unconfirmed browser Column may already be stored. Refresh the Project before trying again.");
    await expect(addColumnTrigger(page)).toBeFocused();
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("Add Column keeps a committed write visible when follow-up Refresh fails", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    let projectReads = 0;
    const projectRoute = `**/api/projects/${seed.projectId}`;
    await page.route(projectRoute, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      projectReads += 1;
      if (projectReads === 2) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Deterministic post-commit Refresh failure" })
        });
        return;
      }
      await route.continue();
    });

    await addColumnTrigger(page).click();
    await page.getByLabel("Column name", { exact: true }).fill("Committed browser Column");
    await addColumnSubmit(page).click();

    const status = page.locator("#project-status");
    await expect(status.getByText("Column added; refresh needed", { exact: true })).toBeVisible();
    await expect(status).toContainText("Committed browser Column is stored and visible from the write response.");
    const column = page.locator("section.column").filter({ has: page.getByRole("heading", { name: "Committed browser Column", exact: true }) });
    await expect(column).toBeVisible();
    await expect(column.getByRole("heading", { name: "Committed browser Column", exact: true })).toBeFocused();
    await expect(page.locator("#toast-region").getByText("Column added", { exact: true })).toHaveCount(0);
    const stored = await readSeededProject(harness, seed.projectId);
    const committedColumn = stored.columns.find((candidate) => candidate.name === "Committed browser Column");
    expect(committedColumn).toBeDefined();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Visible Column")).toHaveValue(committedColumn?.id || "");
    await expect(column).toBeVisible();
    await expect(addColumnTrigger(page)).toBeVisible();
    await expectNoHorizontalOverflow(page, "390px committed Add Column Refresh failure");
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("Add Column keeps committed refresh progress visible across the narrow breakpoint", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);
  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    await addColumnTrigger(page).click();
    await page.getByLabel("Column name", { exact: true }).fill("Responsive committed Column");
    const refreshGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === `/api/projects/${seed.projectId}`;
    });
    try {
      await addColumnSubmit(page).click();
      await refreshGate.reached;
      const desktopStatus = page.locator("#add-column-status");
      await expect(desktopStatus.getByText("Column added", { exact: true })).toBeVisible();
      await expect(desktopStatus).toBeFocused();
      await page.setViewportSize({ width: 390, height: 844 });
      const narrowStatus = page.locator(".add-column-narrow #add-column-status");
      await expect(narrowStatus.getByText("Column added", { exact: true })).toBeVisible();
      await expect(narrowStatus).toBeFocused();
      await expect(page.locator(".add-column-desktop")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "390px committed Add Column progress");
      refreshGate.continue();
      await expect(page.getByLabel("Visible Column").locator("option:checked")).toHaveText("Responsive committed Column · 0 Cards");
      await expect(page.getByRole("heading", { name: "Responsive committed Column", exact: true })).toBeFocused();
    } finally {
      await refreshGate.dispose();
    }
    expectNoUnexpectedBrowserErrors(errors);
  } finally {
    await harness.stop();
  }
});

test("Refresh failure retains selected Card context and unlocks the workspace", async ({ page }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);

  try {
    const seed = await seedBrowserWorkspace(harness);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await authenticate(page, harness);
    await openCard(page, seed.cards.privacy.title);
    const inspector = page.getByRole("complementary");
    const refreshGate = await holdNextRequest(page, (request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === "/api/projects";
    });
    try {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await refreshGate.reached;
      await expect(page.locator("body")).toHaveAttribute("data-state", "refreshing");
      await expect(inspector.getByLabel("Title", { exact: true })).toHaveValue(seed.cards.privacy.title);
      await expect(inspector.getByLabel("Description", { exact: true })).toHaveValue(seed.cards.privacy.body);
      await expect(inspector.getByLabel("Title", { exact: true })).toBeEnabled();
      await expect(page.locator(".columns")).toBeVisible();
      await expect(inspector.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      refreshGate.fulfill(503, { error: "Injected Refresh outage." });
      await expect(page.locator("body")).toHaveAttribute("data-state", "selected");
      await expect(page.getByText("Refresh failed", { exact: true })).toBeVisible();
      await expect(page.getByText(/The previous displayed state remains visible\. Injected Refresh outage\./)).toBeVisible();
    } finally {
      await refreshGate.dispose();
    }

    await expect(inspector).toBeVisible();
    await expect(inspector.getByLabel("Title", { exact: true })).toHaveValue(seed.cards.privacy.title);
    await expect(inspector.getByLabel("Description", { exact: true })).toHaveValue(seed.cards.privacy.body);
    await expect(inspector.getByLabel("Title", { exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeEnabled();
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

test("an actually expired browser session clears every private surface", async ({ page, context }) => {
  const harness = await startBrowserHarness({ sessionTtlSeconds: 2 });
  const errors = monitorBrowserErrors(page);

  try {
    const seed = await seedBrowserWorkspace(harness);
    await authenticate(page, harness);
    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "kanban_cards_session");
    expect(sessionCookie?.httpOnly).toBe(true);
    await expect.poll(async () =>
      (await context.cookies()).some((cookie) => cookie.name === "kanban_cards_session"),
    { timeout: 8_000 }).toBe(false);

    await expect(page.locator("body")).toContainText("Context Dock regression");
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();

    await expect(page.locator("body")).toHaveAttribute("data-state", "session-expired");
    await expect(page.getByText("Your session ended", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Owner key")).toBeFocused();
    await expect(page.getByLabel("Owner key")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("Context Dock regression");
    await expect(page.locator("body")).not.toContainText(seed.cards.privacy.title);
    await expect(page.locator("body")).not.toContainText(seed.cards.privacy.body);
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.cards:project-id"))).toBeNull();
    expect((await context.cookies()).some((cookie) => cookie.name === "kanban_cards_session")).toBe(false);
    expectNoUnexpectedBrowserErrors(errors, [/401/]);
  } finally {
    await harness.stop();
  }
});

test("boot-time service unavailability is distinct from invalid access", async ({ page, context }) => {
  const harness = await startBrowserHarness();
  const errors = monitorBrowserErrors(page);

  try {
    await page.route(`${harness.baseUrl}/api/session`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected boot outage." })
      });
    }, { times: 1 });
    await page.goto(harness.baseUrl);

    await expect(page.locator("body")).toHaveAttribute("data-state", "service-unavailable");
    await expect(page.getByText("kanban.cards is unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("The service could not be reached. Try again when it is available.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Owner key")).toBeFocused();
    await expect(page.getByLabel("Owner key")).toHaveValue("");
    expect(await page.evaluate(() => window.localStorage.getItem("kanban.cards:project-id"))).toBeNull();
    expect((await context.cookies()).some((cookie) => cookie.name === "kanban_cards_session")).toBe(false);
    expectNoUnexpectedBrowserErrors(errors, [/503/]);
  } finally {
    await harness.stop();
  }
});

async function holdNextRequest(page: Page, matches: (request: Request) => boolean): Promise<HeldRequest> {
  let reachedResolve!: () => void;
  let resolutionResolve!: (resolution: HeldRequestResolution) => void;
  let resolutionSettled = false;
  let matched = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const resolution = new Promise<HeldRequestResolution>((resolve) => {
    resolutionResolve = resolve;
  });
  const handler = async (route: Route): Promise<void> => {
    if (matched || !matches(route.request())) {
      await route.continue();
      return;
    }
    matched = true;
    reachedResolve();
    const outcome = await resolution;
    if (outcome.kind === "continue") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: outcome.status,
      contentType: "application/json",
      body: JSON.stringify(outcome.body)
    });
  };
  const settle = (next: HeldRequestResolution): void => {
    if (resolutionSettled) return;
    resolutionSettled = true;
    resolutionResolve(next);
  };

  await page.route("**/api/**", handler);
  return {
    reached,
    continue() {
      settle({ kind: "continue" });
    },
    fulfill(status, body) {
      settle({ kind: "fulfill", status, body });
    },
    async dispose() {
      settle({ kind: "continue" });
      await page.unroute("**/api/**", handler);
    }
  };
}
