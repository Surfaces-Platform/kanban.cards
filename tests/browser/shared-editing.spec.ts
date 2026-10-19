/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { authenticate, cardButton, openCard, readSeededProject, seedBrowserWorkspace, startBrowserHarness, updateSeededCard, type BrowserHarness, type SeededWorkspace } from "./support/context-dock-harness";
let harness: BrowserHarness; let seed: SeededWorkspace;
test.beforeEach(async ({ page }) => { harness = await startBrowserHarness(); seed = await seedBrowserWorkspace(harness); await page.setViewportSize({ width: 1440, height: 1000 }); await authenticate(page, harness); });
test.afterEach(async () => { await harness.stop(); });
const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true });
const description = (page: Page) => page.getByLabel("Description", { exact: true });
const title = (page: Page) => page.getByLabel("Title", { exact: true });
async function stored() { return (await readSeededProject(harness, seed.projectId)).cards.find(card => card.id === seed.cards.desktopDraft.id)!; }
async function reopen(page: Page) { await page.reload(); await openCard(page, seed.cards.desktopDraft.title); }

test("SI-001,003,004: editable selection writes only on Save; Close/reload retain exact unsent source", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title);
  const baseline = await stored(); let patches = 0;
  page.on("request", request => { if (request.method() === "PATCH") patches++; });
  const source = "    code\n\nUnsent source  \n";
  await description(page).fill(source); await title(page).focus();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  expect((await stored()).body).toBe(baseline.body); expect(patches).toBe(0);
  await page.getByRole("tab", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: /Close Card/ }).click();
  await reopen(page); await expect(description(page)).toHaveValue(source);
  await save(page).click(); await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect((await stored()).body).toBe(source); expect(patches).toBe(1);
});

test("SI-005: standalone Move changes only placement, retains dirty text, then Save preserves the destination", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); const baseline = await stored();
  const bodies: Record<string, unknown>[] = [];
  page.on("request", request => { if (request.method() === "PATCH") bodies.push(request.postDataJSON()); });
  await title(page).fill("Unsent title after Move");
  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await page.getByRole("button", { name: "Move to Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Card and return to Done" })).toBeVisible();
  expect(await stored()).toMatchObject({ title: baseline.title, body: baseline.body, columnId: "done" });
  expect(bodies).toEqual([{ columnId: "done" }]);
  await expect(title(page)).toHaveValue("Unsent title after Move");
  await save(page).click(); await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect(await stored()).toMatchObject({ title: "Unsent title after Move", columnId: "done" });
  expect(bodies[1]).not.toHaveProperty("columnId");
});

test("SI-007,008: Save merges external untouched fields and Comment version changes into a dirty title", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title);
  await title(page).fill("My dirty title");
  await updateSeededCard(harness, seed.projectId, seed.cards.desktopDraft.id, (await stored()).version, { priority: "High", body: "External untouched Description\n" });
  await page.getByLabel("Add Comment", { exact: true }).fill("Comment advances version");
  await page.getByRole("button", { name: "Add Comment", exact: true }).click();
  await expect(page.getByText("Comment added", { exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue("My dirty title");
  await expect(description(page)).toHaveValue("External untouched Description\n");
  await save(page).click(); await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect(await stored()).toMatchObject({ title: "My dirty title", body: "External untouched Description\n", priority: "High" });
});

test("SI-009: differing same-field values require choices; Revert reads latest and sends no mutation", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await title(page).fill("My conflicting title");
  await updateSeededCard(harness, seed.projectId, seed.cards.desktopDraft.id, (await stored()).version, { title: "Other saved title", body: "Independent saved source" });
  let patches = 0; page.on("request", request => { if (request.method() === "PATCH") patches++; });
  await save(page).click();
  await expect(page.getByRole("heading", { name: "The stored Card changed", exact: true })).toBeVisible();
  expect(patches).toBe(0); await expect(description(page)).toHaveValue("Independent saved source");
  await page.getByRole("button", { name: "Keep draft", exact: true }).click();
  await save(page).click(); await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect((await stored()).title).toBe("My conflicting title");
  await title(page).fill("Do not save this");
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(title(page)).toHaveValue("My conflicting title"); expect(patches).toBe(1);
});

test("SI-010: lost Card-create response retries the frozen payload/key once and retains later edits", async ({ page }) => {
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Card", exact: true }).click();
  await title(page).fill("Frozen creation title"); await description(page).fill("Frozen body\n");
  const attempts: Array<{ body: unknown; key: string | undefined }> = []; let lose = true;
  await page.route(`**/api/projects/${seed.projectId}/cards`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card outcome unconfirmed", { exact: true })).toBeVisible();
  await title(page).fill("Later local title");
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
  expect((await readSeededProject(harness, seed.projectId)).cards.filter(card => card.title === "Frozen creation title")).toHaveLength(1);
  await expect(title(page)).toHaveValue("Later local title");
});

test("SI-011: lost PATCH response reads back matching saved values without a duplicate PATCH or false receipt", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Saved despite missing response\n");
  let attempts = 0;
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempts++; if (attempts === 1) { await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await save(page).click(); await expect(page.getByText("Card was not saved", { exact: true })).toBeVisible();
  await save(page).click(); await expect(page.getByText("Saved state observed", { exact: true })).toBeVisible();
  expect(attempts).toBe(1); expect((await stored()).body).toBe("Saved despite missing response\n");
});

test("SI-012: confirmed write plus failed refresh stays saved and does not offer a duplicate mutation", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Confirmed before refresh fails");
  let writes = 0; let fail = false;
  page.on("request", request => { if (request.method() === "PATCH") { writes++; fail = true; } });
  await page.route("**/api/projects", route => route.request().method() === "GET" && fail ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic refresh unavailable"}' }) : route.continue());
  await save(page).click(); await expect(page.getByText("Card updated; refresh needed", { exact: true })).toBeVisible();
  expect(writes).toBe(1); expect((await stored()).body).toBe("Confirmed before refresh fails");
  await expect(description(page)).toHaveValue("Confirmed before refresh fails");
});

test("SI-014: external archive retains dirty draft and never implicitly restores on Save", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Draft across archive");
  await updateSeededCard(harness, seed.projectId, seed.cards.desktopDraft.id, (await stored()).version, { archivedAt: new Date().toISOString() });
  let patches = 0; page.on("request", request => { if (request.method() === "PATCH") patches++; });
  await save(page).click(); await expect(page.getByRole("button", { name: "Restore Card", exact: true })).toBeVisible();
  expect((await stored()).archivedAt).not.toBeNull(); expect(patches).toBe(0);
  await expect(description(page)).toHaveValue("Draft across archive"); await expect(description(page)).toBeDisabled();
  await page.getByRole("button", { name: "Restore Card", exact: true }).click();
  await expect(description(page)).toBeEnabled(); await expect(description(page)).toHaveValue("Draft across archive");
  expect(patches).toBe(1); expect((await stored()).body).toBe(seed.cards.desktopDraft.body);
});

test("SI-015: sign-out hides durable Card and Comment drafts, same-owner sign-in recovers them", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Private unsent source"); await page.getByLabel("Add Comment", { exact: true }).fill("Private unsent Comment");
  await page.getByRole("button", { name: /Close Card/ }).click(); await page.getByRole("button", { name: "Open account panel" }).click(); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Owner key")).toBeVisible(); await expect(page.locator("body")).not.toContainText("Private unsent");
  expect(await page.evaluate(() => JSON.stringify(localStorage).includes("Private unsent source"))).toBe(true);
  await page.getByLabel("Owner key").fill(harness.ownerKey); await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await openCard(page, seed.cards.desktopDraft.title); await expect(description(page)).toHaveValue("Private unsent source"); await expect(page.getByLabel("Add Comment", { exact: true })).toHaveValue("Private unsent Comment");
  expect((await stored()).body).toBe(seed.cards.desktopDraft.body);
});

test("SI-016: a changed verified owner hides recovery and fences the pending Save", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Owner A unsent source"); let writes = 0;
  page.on("request", request => { if (request.method() === "PATCH") writes++; });
  await page.route("**/api/session", async route => {
    if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); const data = await response.json(); await route.fulfill({ response, json: { ...data, ownerId: "synthetic-other-owner" } });
  });
  await save(page).click(); await expect(page.getByText("Your session ended", { exact: true })).toBeVisible(); await expect(page.locator("body")).not.toContainText("Owner A unsent source"); expect(writes).toBe(0);
  await page.unroute("**/api/session"); await page.getByLabel("Owner key").fill(harness.ownerKey); await page.getByRole("button", { name: "Open workspace", exact: true }).click(); await openCard(page, seed.cards.desktopDraft.title); await expect(description(page)).toHaveValue("Owner A unsent source");
});

test("SI-017: browser quota failure is visible, blocks writes, and explicit Retry restores durability", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title);
  await page.evaluate(() => { const original = Storage.prototype.setItem; (window as any).__restoreStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function(key, value) { if (key.startsWith("kanban.cards:recovery:")) throw new DOMException("Synthetic quota failure", "QuotaExceededError"); return original.call(this, key, value); }; });
  await description(page).fill("Latest memory-only source\n"); await expect(page.getByText("Local draft recovery needs attention", { exact: true })).toBeVisible();
  await save(page).click();
  await expect(page.getByText("Card was not saved", { exact: true })).toBeVisible();
  await expect(save(page)).toBeEnabled();
  expect((await stored()).body).toBe(seed.cards.desktopDraft.body);
  await page.evaluate(() => (window as any).__restoreStorage()); await page.getByRole("button", { name: "Retry local storage", exact: true }).click();
  await expect(page.getByText("Local draft recovery needs attention", { exact: true })).toHaveCount(0);
  await reopen(page); await expect(description(page)).toHaveValue("Latest memory-only source\n");
});

test("SI-018: divergent tabs retain independent Card and Comment copies without replacing active text", async ({ page, context }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Tab A original draft");
  const second = await context.newPage(); await second.goto(harness.baseUrl); await openCard(second, seed.cards.desktopDraft.title);
  await description(page).fill("Tab A divergent source"); await description(second).fill("Tab B divergent source");
  await page.getByLabel("Add Comment", { exact: true }).fill("Tab A Comment"); await second.getByLabel("Add Comment", { exact: true }).fill("Tab B Comment");
  await expect(description(page)).toHaveValue("Tab A divergent source"); await expect(description(second)).toHaveValue("Tab B divergent source");
  await expect(page.getByText("Other draft copies are retained", { exact: true })).toBeVisible();
  const raw = await page.evaluate(() => JSON.stringify(localStorage)); expect(raw).toContain("Tab A divergent source"); expect(raw).toContain("Tab B divergent source"); expect(raw).toContain("Tab A Comment"); expect(raw).toContain("Tab B Comment");
  await second.close();
});

test("SI-004: unsent new Card and Project drafts survive Close/Cancel and a page relaunch", async ({ page }) => {
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Card", exact: true }).click(); await title(page).fill("Retained new Card"); await description(page).fill("Exact new Card source\n"); await page.getByRole("button", { name: /Close Card/ }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Project", exact: true }).click(); await page.getByLabel("Name", { exact: true }).fill("Retained new Project"); await page.getByRole("button", { name: "Cancel", exact: true }).click(); await page.reload();
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Project", exact: true }).click(); await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Retained new Project"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Card", exact: true }).click(); await expect(title(page)).toHaveValue("Retained new Card"); await expect(description(page)).toHaveValue("Exact new Card source\n");
  expect((await readSeededProject(harness, seed.projectId)).cards.some(card => card.title === "Retained new Card")).toBe(false);
});


for (const route of ["sign-out", "401"] as const) test(`SI-015..017: ${route} hides private UI despite both Storage APIs throwing and restores only verified-owner memory`, async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title);
  await description(page).fill("Last durable private source");
  await page.evaluate(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    (window as any).__restoreStorage = () => { Storage.prototype.getItem = get; Storage.prototype.setItem = set; Storage.prototype.removeItem = remove; };
    Storage.prototype.getItem = function() { throw new DOMException("Synthetic storage inaccessible", "SecurityError"); };
    Storage.prototype.setItem = function() { throw new DOMException("Synthetic storage inaccessible", "SecurityError"); };
    Storage.prototype.removeItem = function() { throw new DOMException("Synthetic storage inaccessible", "SecurityError"); };
  });
  await description(page).fill("Latest private memory source");
  await expect(page.getByText("Local draft recovery needs attention", { exact: true })).toBeVisible();
  if (route === "sign-out") {
    await page.locator("#local-recovery").getByRole("button", { name: "Sign out", exact: true }).click();
  } else {
    await page.route("**/api/projects", request => request.request().method() === "GET" ? request.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Synthetic session ended"}' }) : request.continue());
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
  }
  await expect(page.getByLabel("Owner key")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Latest private memory source");
  await expect(page.locator("body")).not.toContainText(seed.cards.desktopDraft.title);
  await page.evaluate(() => (window as any).__restoreStorage());
  if (route === "401") await page.unroute("**/api/projects");
  // The same process may recover failed-write memory only after this owner is verified again.
  await page.getByLabel("Owner key").fill(harness.ownerKey); await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await openCard(page, seed.cards.desktopDraft.title); await expect(description(page)).toHaveValue("Latest private memory source");
  expect((await stored()).body).toBe(seed.cards.desktopDraft.body);
});

test("SI-010: committed POST followed by 408 retains frozen payload/key even after the visible text changes", async ({ page }) => {
  await page.getByRole("button", { name: "Actions", exact: true }).click(); await page.getByRole("button", { name: "New Card", exact: true }).click();
  await title(page).fill("Frozen timeout creation"); await description(page).fill("Frozen timeout source\n");
  const attempts: Array<{ body: unknown; key: string | undefined }> = []; let timeout = true;
  await page.route(`**/api/projects/${seed.projectId}/cards`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    if (timeout) { timeout = false; await route.fetch(); await route.fulfill({ status: 408, contentType: "application/json", body: '{"error":"Synthetic intermediary timeout"}' }); } else await route.continue();
  });
  await page.getByRole("complementary").getByRole("button", { name: "Create Card", exact: true }).click();
  await expect(page.getByText("Card outcome unconfirmed", { exact: true })).toBeVisible(); await title(page).fill("");
  await page.getByRole("button", { name: "Retry original submission", exact: true }).click();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible(); expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
  const cards = (await readSeededProject(harness, seed.projectId)).cards;
  expect(cards.filter(card => card.title === "Frozen timeout creation")).toHaveLength(1); expect(cards.filter(card => card.title === "")).toHaveLength(0);
  await expect(title(page)).toHaveValue("");
});

test("SI-009: a PATCH 409 preserves the actual per-field choices computed by the latest read", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await title(page).fill("My choice after a race");
  let race = true;
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`, async route => {
    if (route.request().method() === "PATCH" && race) {
      race = false; const current = await stored();
      await updateSeededCard(harness, seed.projectId, current.id, current.version, { title: "External racing title", nextAction: "Independent external action" });
    }
    await route.continue();
  });
  await save(page).click(); await expect(page.getByRole("button", { name: "Keep draft", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use saved", exact: true })).toBeVisible();
  await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Independent external action");
  await page.getByRole("button", { name: "Keep draft", exact: true }).click(); await save(page).click();
  await expect(page.getByText("Card updated", { exact: true })).toBeVisible(); expect((await stored()).title).toBe("My choice after a race");
});


test("SI-011: an unknown text Save cannot be consumed as a Move on the same Card URL", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await description(page).fill("Original text submission");
  const writes: Record<string, unknown>[] = []; let lose = true;
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await save(page).click(); await expect(page.getByText("Card was not saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move…", exact: true }).click(); await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.getByText("Card was not moved", { exact: true })).toBeVisible(); expect(writes).toHaveLength(1); expect((await stored()).columnId).toBe("next");
  await page.getByRole("button", { name: "Read back original change", exact: true }).click();
  await expect(page.getByText("Saved state observed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Card and return to Doing" })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual({ columnId: "doing" });
});

test("SI-005,011: an unknown Move cannot be replayed or labeled as a text Save", async ({ page }) => {
  await openCard(page, seed.cards.desktopDraft.title); await title(page).fill("Local text after unknown Move");
  const writes: Record<string, unknown>[] = []; let lose = true;
  await page.route(`**/api/projects/${seed.projectId}/cards/${seed.cards.desktopDraft.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.getByRole("button", { name: "Move…", exact: true }).click(); await page.getByRole("button", { name: "Move to Done", exact: true }).click();
  await expect(page.getByText("Move outcome unconfirmed", { exact: true })).toBeVisible();
  await save(page).click(); await expect(page.getByText("Earlier change needs review", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ columnId: "done" }]); expect((await stored()).title).toBe(seed.cards.desktopDraft.title);
  await page.getByRole("button", { name: "Read back original change", exact: true }).click();
  await expect(page.getByText("Saved state observed", { exact: true })).toBeVisible(); await expect(title(page)).toHaveValue("Local text after unknown Move");
  await save(page).click(); await expect(page.getByText("Card updated", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1]).not.toHaveProperty("columnId"); expect(await stored()).toMatchObject({ title: "Local text after unknown Move", columnId: "done" });
});
