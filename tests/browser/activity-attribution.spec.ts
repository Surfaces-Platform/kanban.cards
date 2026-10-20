/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

import {
  assertChromiumInstalled,
  authenticate,
  expectNoHorizontalOverflow,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors,
  openCard,
  seedBrowserWorkspace,
  startBrowserHarness,
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

async function showActivity(page: Page, events: Array<Record<string, unknown>>): Promise<void> {
  await page.route(`**/api/projects/${seed.projectId}/activity`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { activity: events } });
  });
  await authenticate(page, harness);
  await openCard(page, seed.cards.desktopDraft.title);
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
}

function activityEvent(id: string, summary: string, actorFields: Record<string, unknown>, action = "card.updated"): Record<string, unknown> {
  return {
    id,
    cardId: seed.cards.desktopDraft.id,
    projectId: seed.projectId,
    action,
    summary,
    createdAt: "2026-10-19T20:00:00.000Z",
    ...actorFields
  };
}

test("Activity names each pilot agent on updates and Comments independently of the summary", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  const labels = ["Claude Research (pilot)", "Claude Writer (pilot)", "Codex Research (pilot)", "Codex Writer (pilot)"];
  const updateSummary = `Updated ${seed.cards.desktopDraft.title}.`;
  const events = labels.flatMap((label, index) => {
    const actor = { channel: "api", label, agentConnectionId: `agent-pilot-${index}` };
    return [
      activityEvent(`update-${index}`, updateSummary, { actor }),
      activityEvent(`comment-${index}`, `${label} commented on ${seed.cards.desktopDraft.title}.`, { actor }, "comment.created")
    ];
  });
  await showActivity(page, events);

  const rows = page.locator("#activity-panel .activity-list > li");
  await expect(rows).toHaveCount(8);
  const updates = rows.filter({ has: page.getByText(updateSummary, { exact: true }) });
  await expect(updates).toHaveCount(4);
  for (const label of labels) {
    await expect(updates.locator(".activity-actor").filter({ hasText: label })).toHaveText(`By ${label}`);
    const comment = rows.filter({ has: page.getByText(`${label} commented on ${seed.cards.desktopDraft.title}.`, { exact: true }) });
    await expect(comment).toHaveCount(1);
    await expect(comment.locator(".activity-actor")).toHaveText(`By ${label}`);
    await expect(comment.locator("time")).toHaveAttribute("datetime", "2026-10-19T20:00:00.000Z");
  }
  expectNoUnexpectedBrowserErrors(errors);
});

test("Activity retains browser and legacy attribution and safely wraps long names at desktop and 390px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  const longLabel = `Agent <img src=x onerror=alert(1)>-${"UnbrokenAgentName".repeat(24)}`;
  const cases = [
    { summary: "Updated from the browser.", actorFields: { actor: { channel: "web", label: "Browser QA Owner" } }, expected: "Browser QA Owner" },
    { summary: "Updated by a legacy agent.", actorFields: { actorLabel: "Legacy agent" }, expected: "Legacy agent" },
    { summary: "Updated with a legacy channel.", actorFields: { actor: { channel: "api" } }, expected: "api" },
    { summary: "Updated before attribution was stored.", actorFields: {}, expected: "Owner" },
    { summary: "Updated by a long-named agent.", actorFields: { actor: { channel: "api", label: longLabel } }, expected: longLabel }
  ];
  await showActivity(page, cases.map((entry, index) => activityEvent(`fallback-${index}`, entry.summary, entry.actorFields)));

  const rows = page.locator("#activity-panel .activity-list > li");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const entry of cases) {
      const row = rows.filter({ has: page.getByText(entry.summary, { exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".activity-actor")).toHaveText(`By ${entry.expected}`);
    }
    const longActor = rows.filter({ has: page.getByText("Updated by a long-named agent.", { exact: true }) }).locator(".activity-actor");
    expect(await longActor.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    }), `${width}px actor name wraps across multiple lines`).toBeGreaterThan(1);
    await expect(page.locator("#activity-panel img, #activity-panel script")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, `${width}px Activity attribution`);
  }
  expectNoUnexpectedBrowserErrors(errors);
});
