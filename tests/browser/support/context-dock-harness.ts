/// <reference lib="dom" />

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium, expect, type Locator, type Page } from "@playwright/test";

import { createApp } from "../../../src/server";

export const OWNER_KEY = "context-dock-browser-regression-owner";

export type SeedCardName =
  | "archive"
  | "desktopColumnContext"
  | "desktopDraft"
  | "mobileAutosave"
  | "moveArchived"
  | "moveConflict"
  | "overflow"
  | "privacy"
  | "staleDiscard"
  | "staleRetry";

export interface BrowserCard {
  id: string;
  title: string;
  body: string;
  columnId: string;
  version: number;
  archivedAt: string | null;
  nextActor: "human" | "agent" | null;
  nextAction: string;
  priority: "High" | "Medium" | "Low" | null;
  blockedReason: string;
}

export interface BrowserProject {
  id: string;
  name: string;
  columns: Array<{ id: string; name: string; position: number }>;
  cards: BrowserCard[];
  revision: number;
}

export interface SeededWorkspace {
  projectId: string;
  cards: Record<SeedCardName, BrowserCard>;
  overflowTitle: string;
}

export interface BrowserHarness {
  baseUrl: string;
  ownerKey: string;
  stop(): Promise<void>;
}

export interface BrowserHarnessOptions {
  sessionTtlSeconds?: number;
}

export interface BrowserError {
  kind: "console" | "page" | "request" | "server";
  text: string;
}

interface ApiRequestOptions {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  method?: "GET" | "PATCH" | "POST";
}

export async function assertChromiumInstalled(): Promise<void> {
  const executable = chromium.executablePath();
  try {
    await fs.access(executable);
  } catch {
    throw new Error(
      `Playwright Chromium is not installed at ${executable}. Run: npx playwright install chromium`
    );
  }
}

export async function startBrowserHarness(options: BrowserHarnessOptions = {}): Promise<BrowserHarness> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-context-dock-browser-"));
  const dataPath = path.join(temporaryDirectory, "workspace.json");
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const server = createServer(createApp({
    apiToken: OWNER_KEY,
    dataPath,
    host: "127.0.0.1",
    ownerLabel: "Browser QA Owner",
    requireDatabase: false,
    sessionTtlSeconds: options.sessionTtlSeconds,
    staticDir: repositoryRoot
  }));

  try {
    await listen(server);
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    ownerKey: OWNER_KEY,
    async stop() {
      await close(server);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
}

export async function seedBrowserWorkspace(harness: BrowserHarness): Promise<SeededWorkspace> {
  const api = makeHarnessApi(harness.baseUrl);
  const projectPayload = await api<{ project: BrowserProject }>("/projects", {
    method: "POST",
    body: {
      name: "Context Dock regression",
      description: "Real resources for the production-browser Context Dock gate.",
      columns: [
        { id: "next", name: "Next", position: 0 },
        { id: "doing", name: "Doing", position: 1 },
        { id: "done", name: "Done", position: 2 }
      ]
    }
  });
  const projectId = projectPayload.project.id;

  const overflowTitle = `Overflow-${"UnbrokenToken".repeat(24)}`;
  const definitions: Array<[SeedCardName, string, string, string?]> = [
    ["desktopDraft", "Preserve desktop draft focus", "Stored desktop body"],
    ["desktopColumnContext", "Review a Doing Card", "Desktop creation must still target the first Column.", "doing"],
    ["mobileAutosave", "Autosave on mobile", "Stored mobile body"],
    ["moveArchived", "Archive during a move", "Stored concurrent-archive body"],
    ["moveConflict", "Recover a stale move", "Stored move-conflict body"],
    ["staleDiscard", "Discard a stale draft", "Stored discard body"],
    ["staleRetry", "Retry a stale draft", "Stored retry body"],
    ["archive", "Archive and undo", "Stored archive body"],
    ["privacy", "Private sign-out proof", "Stored privacy body"],
    ["overflow", overflowTitle, `Body-${"UnbrokenBodyToken".repeat(28)}`]
  ];
  const cards = {} as Record<SeedCardName, BrowserCard>;
  for (const [name, title, body, columnId = "next"] of definitions) {
    const payload = await api<{ card: BrowserCard }>(`/projects/${projectId}/cards`, {
      method: "POST",
      body: { title, body, columnId }
    });
    cards[name] = payload.card;
  }

  return { projectId, cards, overflowTitle };
}

export async function signInToWorkspace(page: Page, harness: BrowserHarness): Promise<void> {
  await page.goto(harness.baseUrl);
  await expect(page.getByRole("heading", { name: "Open your workspace" })).toBeVisible();
  await page.getByLabel("Owner key").fill(harness.ownerKey);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-state",
    /^(empty-workspace|empty-project|populated|selected|archived)$/
  );
}

export async function authenticate(page: Page, harness: BrowserHarness): Promise<void> {
  await signInToWorkspace(page, harness);
  await expect(page.getByRole("heading", { name: "Context Dock regression" })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-state", "populated");
}

export function cardButton(page: Page, title: string): Locator {
  return page.locator("button.board-card").filter({ hasText: title });
}

export async function openCard(page: Page, title: string): Promise<void> {
  await cardButton(page, title).click();
  await expect(page.getByRole("tab", { name: "Card", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
}

export function monitorBrowserErrors(page: Page): BrowserError[] {
  const errors: BrowserError[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ kind: "console", text: message.text() });
  });
  page.on("pageerror", (error) => errors.push({ kind: "page", text: error.message }));
  page.on("requestfailed", (request) => {
    errors.push({ kind: "request", text: `${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}` });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push({ kind: "server", text: `${response.status()} ${response.url()}` });
  });
  return errors;
}

export function expectNoUnexpectedBrowserErrors(errors: BrowserError[], allowed: RegExp[] = []): void {
  const unexpected = errors.filter((error) => !allowed.some((pattern) => pattern.test(error.text)));
  expect(unexpected, `Unexpected browser errors:\n${JSON.stringify(unexpected, null, 2)}`).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page, context: string): Promise<void> {
  const measurements = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}.${element.className || ""} [${rect.left.toFixed(1)}, ${rect.right.toFixed(1)}]`;
      });
    return {
      documentWidth: document.documentElement.scrollWidth,
      offenders,
      viewportWidth
    };
  });
  expect(
    measurements.documentWidth,
    `${context} horizontally overflowed ${measurements.viewportWidth}px: ${measurements.offenders.join(", ")}`
  ).toBeLessThanOrEqual(measurements.viewportWidth);
}

export async function readSeededProject(harness: BrowserHarness, projectId: string): Promise<BrowserProject> {
  const api = makeHarnessApi(harness.baseUrl);
  return (await api<{ project: BrowserProject }>(`/projects/${projectId}`)).project;
}

export async function updateSeededProject(
  harness: BrowserHarness,
  projectId: string,
  revision: number,
  changes: Record<string, unknown>
): Promise<BrowserProject> {
  const api = makeHarnessApi(harness.baseUrl);
  return (await api<{ project: BrowserProject }>(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "X-Kanban-Version": String(revision) },
    body: changes
  })).project;
}

export async function updateSeededCard(
  harness: BrowserHarness,
  projectId: string,
  cardId: string,
  version: number,
  changes: Record<string, unknown>
): Promise<BrowserCard> {
  const api = makeHarnessApi(harness.baseUrl);
  return (await api<{ card: BrowserCard }>(`/projects/${projectId}/cards/${cardId}`, {
    method: "PATCH",
    headers: { "X-Kanban-Version": String(version) },
    body: changes
  })).card;
}

function makeHarnessApi(baseUrl: string) {
  return async <T>(pathname: string, options: ApiRequestOptions = {}): Promise<T> => {
    const headers = new Headers({
      Authorization: `Bearer ${OWNER_KEY}`,
      "X-Kanban-Actor": "browser-regression"
    });
    for (const [name, value] of Object.entries(options.headers || {})) headers.set(name, value);
    if (options.body) headers.set("Content-Type", "application/json");
    if (options.method === "POST") headers.set("Idempotency-Key", `browser-regression:${randomUUID()}`);
    const response = await fetch(`${baseUrl}/api${pathname}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} failed with ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
