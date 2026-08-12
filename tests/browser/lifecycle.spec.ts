/// <reference lib="dom" />

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

import {
  assertChromiumInstalled,
  authenticate,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors,
  openCard,
  readSeededProject,
  seedBrowserWorkspace,
  signInToWorkspace,
  startBrowserHarness
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
  let cardCreateRequests = 0;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/projects") projectCreateRequests += 1;
    if (request.method() === "POST" && /^\/api\/projects\/[^/]+\/cards$/.test(url.pathname)) cardCreateRequests += 1;
  });

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signInToWorkspace(page, harness);
    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-workspace");
    await expect(page.getByRole("heading", { name: "Create the first Project" })).toBeVisible();
    await expect(page.getByLabel("Active Project")).toBeDisabled();

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
      await expect(page.getByText("Project created", { exact: true })).toBeVisible();
    } finally {
      await projectGate.dispose();
    }

    await expect(page.locator("body")).toHaveAttribute("data-state", "empty-project");
    await expect(page.getByLabel("Active Project")).toBeEnabled();
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
      await expect(page.getByText("Card created", { exact: true })).toBeVisible();
    } finally {
      await cardGate.dispose();
    }

    const projectId = await page.getByLabel("Active Project").inputValue();
    const stored = await readSeededProject(harness, projectId);
    const createdCard = stored.cards.find((card) => card.title === "Lifecycle-created Card");
    expect(createdCard?.columnId).toBe("doing");
    expect(projectCreateRequests).toBe(1);
    expect(cardCreateRequests).toBe(1);
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
      await expect(inspector.getByLabel("Title", { exact: true })).toBeDisabled();
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
