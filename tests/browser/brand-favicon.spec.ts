/// <reference lib="dom" />

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createFileAccessStore } from "../../src/access-store";
import { BRAND_ICON_REVISION } from "../../src/brand-web-assets";
import { createApp } from "../../src/server";
import { createWorkspaceStoreResolver } from "../../src/state-store";
import { assertChromiumInstalled } from "./support/context-dock-harness";

let server: Server;
let directory: string;
let rootOrigin: string;
let authOrigin: string;

test.beforeAll(async () => {
  await assertChromiumInstalled();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-favicon-browser-"));
  server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  rootOrigin = `http://board.localhost:${port}`;
  authOrigin = `http://auth.board.localhost:${port}`;
  server.on("request", createApp({
    host: "board.localhost", rootHost: `board.localhost:${port}`, requireDatabase: false,
    staticDir: path.resolve(__dirname, "../.."), dataPath: path.join(directory, "data.json"),
    accessStore: createFileAccessStore(path.join(directory, "access.json")),
    workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }),
    passkeyAuthConfig: { authHost: `auth.board.localhost:${port}`, authOrigin, rpId: "auth.board.localhost", rootOrigins: [rootOrigin], sessionSecret: "favicon-browser-fixture-only-more-than-32-characters", sessionTtlSeconds: 3600 }
  }));
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

for (const surface of ["root", "sign-in"] as const) for (const initial of ["light", "dark"] as const) {
  test(`${surface} selects one ${initial} ICO synchronously and updates that same link on theme change`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (/Content Security Policy|Refused to (?:load|execute)/i.test(message.text())) errors.push(message.text()); });
    await page.emulateMedia({ colorScheme: initial });
    const controllerResponse = page.waitForResponse(response => response.url().endsWith(`/favicon-theme-${BRAND_ICON_REVISION}.js`));
    await page.goto(surface === "root" ? rootOrigin : authOrigin + "/sign-in", { waitUntil: "domcontentloaded" });
    expect((await controllerResponse).status()).toBe(200);
    const icons = page.locator('head link[rel="icon"]');
    await expect(icons).toHaveCount(1);
    await expect(icons).toHaveAttribute("type", "image/x-icon");
    await expect(icons).toHaveAttribute("sizes", "16x16 32x32 48x48");
    await expect(icons).toHaveAttribute("href", `/favicon-${BRAND_ICON_REVISION}-${initial}.ico`);
    expect(await icons.evaluate(link => link.hasAttribute("data-brand-favicon"))).toBe(true);
    await icons.evaluate(link => link.setAttribute("data-test-same-link", "true"));
    const current = await page.request.get(new URL(`/favicon-${BRAND_ICON_REVISION}-${initial}.ico`, page.url()).href);
    expect(current.status()).toBe(200);
    expect(current.headers()["content-type"]).toContain("image/x-icon");
    expect(current.headers()["content-security-policy"]).toContain("script-src 'self'");
    const changed = initial === "light" ? "dark" : "light";
    await page.emulateMedia({ colorScheme: changed });
    await expect(icons).toHaveCount(1);
    await expect(icons).toHaveAttribute("href", `/favicon-${BRAND_ICON_REVISION}-${changed}.ico`);
    await expect(icons).toHaveAttribute("data-test-same-link", "true");
    expect(errors).toEqual([]);
  });
}

for (const appearance of ["light", "dark"] as const) {
  test(`JavaScript-disabled ${appearance} browser receives exactly one light ICO fallback`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: appearance });
    try {
      const page = await context.newPage();
      await page.goto(authOrigin + "/sign-in", { waitUntil: "domcontentloaded" });
      const icons = page.locator('head link[rel="icon"]');
      await expect(icons).toHaveCount(1);
      await expect(icons).toHaveAttribute("href", `/favicon-${BRAND_ICON_REVISION}-light.ico`);
      await expect(icons).toHaveAttribute("type", "image/x-icon");
      expect(await icons.evaluate(link => link.parentElement?.tagName)).toBe("NOSCRIPT");
    } finally {
      await context.close();
    }
  });
}
