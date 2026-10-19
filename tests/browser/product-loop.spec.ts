/// <reference lib="dom" />

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  assertChromiumInstalled,
  expectNoUnexpectedBrowserErrors,
  monitorBrowserErrors,
  readSeededProject,
  startBrowserHarness,
  type BrowserHarness
} from "./support/context-dock-harness";

const CLIENT_PATH = path.resolve(
  __dirname,
  "../..",
  ".agents/skills/kanban-cards/scripts/kanban-cards-client.mjs"
);
const PROJECT_NAME = "Product loop proof";
const CARD_TITLE = "Reconcile the product loop";
const CARD_BODY = "# Skill-created plan\n\nCreated by the bundled skill from an isolated empty Project.";
const BROWSER_BODY = "## Browser update\n\n- Edited before the work moved\n- Preserved as exact Markdown source\n";
const BROWSER_COMMENT = "Person verified the browser workflow.";
const SKILL_COMMENT = "Skill reconciliation marker.";
const EXTERNAL_KEY = "proof:product-loop:card";

interface CliComment {
  body: string;
}

interface CliCard {
  id: string;
  externalKey?: string;
  title: string;
  body: string;
  columnId: string;
  version: number;
  archivedAt: string | null;
  comments: CliComment[];
}

interface CliProject {
  id: string;
  name: string;
  cards: CliCard[];
  revision: number;
}

interface CliActivity {
  action: string;
  cardId?: string;
  actor: {
    channel: string;
    label: string;
  };
}

interface CliResult<T> {
  data: T;
  stdout: string;
}

let harness: BrowserHarness | undefined;
let cliTemporaryDirectory = "";
let cliHome = "";
let cliRepository = "";

test.beforeAll(async () => {
  await assertChromiumInstalled();
  await fs.access(CLIENT_PATH);
  try {
    harness = await startBrowserHarness();
    cliTemporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-product-loop-cli-"));
    cliHome = path.join(cliTemporaryDirectory, "home");
    cliRepository = path.join(cliTemporaryDirectory, "repo");
    await Promise.all([
      fs.mkdir(cliHome, { recursive: true }),
      fs.mkdir(path.join(cliRepository, ".git"), { recursive: true })
    ]);

    const setup = await runSkill<{ tokenConfigured: boolean }>([
      "setup",
      "--url", `${harness.baseUrl}/api`,
      "--actor", "product-loop-skill",
      "--token-stdin"
    ], `${harness.ownerKey}\n`);
    expect(setup.data.tokenConfigured).toBe(true);
    expect(setup.stdout).not.toContain(harness.ownerKey);
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
});

test.afterAll(async () => {
  await cleanup();
});

test("skill and browser complete one isolated product loop from empty through archive recovery", async ({ page }) => {
  test.setTimeout(60_000);
  if (!harness) throw new Error("The product-loop browser harness did not start.");

  const errors = monitorBrowserErrors(page);
  const emptyWorkspace = await runSkill<{ projects: CliProject[] }>(["projects"]);
  expect(emptyWorkspace.data.projects).toEqual([]);

  const createdProject = await runSkill<{ project: CliProject }>([
    "create-project",
    "--name", PROJECT_NAME,
    "--columns", '[{"id":"inbox","name":"Inbox"},{"id":"doing","name":"Doing"},{"id":"done","name":"Done"}]',
    "--idempotency-key", "product-loop:project:v1"
  ]);
  const projectId = createdProject.data.project.id;
  const emptyProject = await runSkill<{ project: CliProject }>([
    "project",
    "--project", projectId
  ]);
  expect(emptyProject.data.project.cards).toEqual([]);

  const createCardArguments = [
    "create-card",
    "--project", projectId,
    "--title", CARD_TITLE,
    "--body", CARD_BODY,
    "--column", "inbox",
    "--external-key", EXTERNAL_KEY
  ];
  const firstCreate = await runSkill<{ card: CliCard; projectRevision: number }>([
    ...createCardArguments,
    "--idempotency-key", "product-loop:card:create:v1"
  ]);
  const deduplicatedCreate = await runSkill<{
    card: CliCard;
    deduplicated: boolean;
    projectRevision: number;
  }>([
    ...createCardArguments,
    "--idempotency-key", "product-loop:card:deduplicate:v1"
  ]);
  const cardId = firstCreate.data.card.id;
  expect(deduplicatedCreate.data.deduplicated).toBe(true);
  expect(deduplicatedCreate.data.card.id).toBe(cardId);
  expect(deduplicatedCreate.data.card.version).toBe(firstCreate.data.card.version);
  expect(deduplicatedCreate.data.projectRevision).toBe(firstCreate.data.projectRevision);

  const projectAfterDeduplication = await runSkill<{ project: CliProject }>([
    "project",
    "--project", projectId
  ]);
  expect(projectAfterDeduplication.data.project.cards).toHaveLength(1);
  expect(projectAfterDeduplication.data.project.cards[0]?.externalKey).toBe(EXTERNAL_KEY);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(harness.baseUrl);
  await expect(page.getByRole("heading", { name: "Open your workspace" })).toBeVisible();
  await page.getByLabel("Owner key").fill(harness.ownerKey);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("heading", { name: PROJECT_NAME, exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-state", "populated");

  const boardCard = page.locator("button.board-card").filter({ hasText: CARD_TITLE });
  await expect(boardCard).toBeVisible();
  await expect(boardCard.locator(".card-summary")).toHaveText("Skill-created plan Created by the bundled skill from an isolated empty Project.");
  await boardCard.click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(CARD_TITLE);
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(CARD_BODY);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Preview", exact: true }).getByRole("heading", { name: "Skill-created plan" })).toBeVisible();

  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByText(`Created card ${CARD_TITLE}.`, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Card", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Write", exact: true }).click();

  await page.getByLabel("Description", { exact: true }).fill(BROWSER_BODY);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Preview", exact: true }).getByRole("heading", { name: "Browser update" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Preview", exact: true }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => {
    const stored = await readSeededProject(harness!, projectId);
    return stored.cards.find((card) => card.id === cardId)?.body;
  }).toBe(BROWSER_BODY);
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Card", exact: true }).click();

  await page.getByLabel("Add Comment", { exact: true }).fill(BROWSER_COMMENT);
  await page.locator("form[data-form='comment']").getByRole("button", { name: "Add Comment", exact: true }).click();
  await expect(page.locator("#toast-region").getByText("Comment added", { exact: true })).toBeVisible();
  await expect(page.getByText(BROWSER_COMMENT, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Move…", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Move Card", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move to Doing", exact: true }).click();
  await expect(page.locator("#toast-region").getByText("Card moved", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const stored = await readSeededProject(harness!, projectId);
    return stored.cards.find((card) => card.id === cardId)?.columnId;
  }).toBe("doing");
  await expect(
    page.locator('section.column[data-column-id="doing"] button.board-card').filter({ hasText: CARD_TITLE })
  ).toBeVisible();
  await expect(
    page.locator('section.column[data-column-id="inbox"] button.board-card').filter({ hasText: CARD_TITLE })
  ).toHaveCount(0);

  await runSkill([
    "comment",
    "--project", projectId,
    "--card", cardId,
    "--text", SKILL_COMMENT,
    "--idempotency-key", "product-loop:comment:reconcile:v1"
  ]);
  await expect(page.getByText(SKILL_COMMENT, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#toast-region").getByText("Refresh complete", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(CARD_TITLE);
  await expect(page.getByText(SKILL_COMMENT, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByText(`product-loop-skill commented on ${CARD_TITLE}.`, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Card", exact: true }).click();

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(boardCard).toHaveCount(0);
  const undo = page.getByRole("button", { name: "Undo archive", exact: true });
  await expect(undo).toBeVisible();
  await expect(undo).toBeFocused();
  await undo.click();
  const restoredCard = page.locator('section.column[data-column-id="doing"] button.board-card').filter({ hasText: CARD_TITLE });
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard).toBeFocused();

  const finalProject = await runSkill<{ project: CliProject }>([
    "project",
    "--project", projectId
  ]);
  expect(finalProject.data.project.cards).toHaveLength(1);
  const finalCard = finalProject.data.project.cards[0]!;
  expect(finalCard.id).toBe(cardId);
  expect(finalCard.externalKey).toBe(EXTERNAL_KEY);
  expect(finalCard.body).toBe(BROWSER_BODY);
  expect(finalCard.columnId).toBe("doing");
  expect(finalCard.archivedAt).toBeNull();
  expect(finalCard.version).toBeGreaterThan(firstCreate.data.card.version);
  expect(finalCard.comments.map((comment) => comment.body)).toEqual([BROWSER_COMMENT, SKILL_COMMENT]);

  const finalActivity = await runSkill<{ activity: CliActivity[] }>([
    "activity",
    "--project", projectId,
    "--limit", "50"
  ]);
  const cardActivity = finalActivity.data.activity.filter((activity) => activity.cardId === cardId);
  expect(cardActivity.filter((activity) => activity.action === "card.created")).toHaveLength(1);
  expect(cardActivity.filter((activity) => activity.action === "comment.created")).toHaveLength(2);
  expect(cardActivity.filter((activity) => activity.action === "card.moved")).toHaveLength(1);
  expect(cardActivity.filter((activity) => activity.action === "card.archived")).toHaveLength(1);
  expect(cardActivity.filter((activity) => activity.action === "card.updated").length).toBeGreaterThanOrEqual(2);
  expect(cardActivity.some((activity) =>
    activity.actor.channel === "api" && activity.actor.label === "product-loop-skill"
  )).toBe(true);
  expect(cardActivity.some((activity) =>
    activity.actor.channel === "web" && activity.actor.label === "Browser QA Owner"
  )).toBe(true);
  expectNoUnexpectedBrowserErrors(errors);
});

async function runSkill<T = unknown>(args: string[], input = ""): Promise<CliResult<T>> {
  if (!cliHome || !cliRepository) throw new Error("The isolated CLI environment is unavailable.");
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT_PATH, ...args], {
      cwd: cliRepository,
      env: cleanCliEnvironment(cliHome),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Skill helper exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
  return {
    data: JSON.parse(result.stdout) as T,
    stdout: result.stdout
  };
}

function cleanCliEnvironment(home: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("KANBAN_CARDS_")) delete environment[key];
  }
  return { ...environment, HOME: home };
}

async function cleanup(): Promise<void> {
  const failures: unknown[] = [];
  if (harness) {
    try {
      await harness.stop();
    } catch (error) {
      failures.push(error);
    } finally {
      harness = undefined;
    }
  }
  if (cliTemporaryDirectory) {
    const target = cliTemporaryDirectory;
    cliTemporaryDirectory = "";
    cliHome = "";
    cliRepository = "";
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Product-loop cleanup failed.");
}
