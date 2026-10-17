/// <reference lib="dom" />

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createFileAccessStore } from "../../src/access-store";
import { createApp } from "../../src/server";
import { createWorkspaceStoreResolver } from "../../src/state-store";
import { assertChromiumInstalled } from "./support/context-dock-harness";

test.beforeAll(assertChromiumInstalled);

for (const theme of ["light", "dark"] as const) {
  test(`public ${theme} shell leaves chooser, access settings, board and account styles unchanged after sign-in`, async ({ page, context }) => {
    test.setTimeout(45_000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-public-isolation-"));
    const server: Server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const rootOrigin = `http://board.localhost:${port}`, authOrigin = `http://auth.board.localhost:${port}`;
    const store = createFileAccessStore(path.join(directory, "access.json"));
    server.on("request", createApp({
      host: "board.localhost", rootHost: `board.localhost:${port}`, requireDatabase: false, staticDir: path.resolve(__dirname, "../.."),
      dataPath: path.join(directory, "data.json"), accessStore: store,
      workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }),
      passkeyAuthConfig: { authHost: `auth.board.localhost:${port}`, authOrigin, rpId: "auth.board.localhost", rootOrigins: [rootOrigin], sessionSecret: "public-isolation-browser-synthetic-only-more-than-32", sessionTtlSeconds: 3600 }
    }));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const privateCanvas = theme === "light" ? "rgb(248, 247, 242)" : "rgb(16, 19, 18)";
    const privateSurface = theme === "light" ? "rgb(255, 255, 255)" : "rgb(24, 29, 27)";
    async function expectWorkbench(): Promise<void> {
      await expect(page.locator("body")).not.toHaveClass(/public-website/);
      await expect(page.locator(".website-header")).toHaveCount(0);
      expect(await page.locator("body").evaluate(body => getComputedStyle(body).fontFamily)).toContain("system-ui");
      expect(await page.locator("body").evaluate(body => getComputedStyle(body).fontFamily)).not.toContain("Inter Website");
      expect(await page.locator("body").evaluate(body => getComputedStyle(body).backgroundColor)).toBe(privateCanvas);
    }
    try {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(rootOrigin);
      await expect(page.locator("body")).toHaveClass(/public-website/);
      await expect(page.getByRole("heading", { name: "Turn a plan into Cards.", exact: true })).toBeVisible();
      await expect(page.locator(".website-header img")).toHaveAttribute("src", "/brand-lockup-dark.svg");
      expect(await page.locator("body").evaluate(body => getComputedStyle(body).fontFamily)).toContain("Inter Website");
      expect(await page.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("-webkit-font-smoothing"))).toBe("antialiased");
      expect(await page.locator(".website-footer-copy p").first().evaluate(copy => getComputedStyle(copy).color)).toBe("rgb(139, 144, 150)");
      expect(await page.locator(".website-problem .website-eyebrow").evaluate(eyebrow => getComputedStyle(eyebrow).color)).toBe(theme === "dark" ? "rgb(139, 144, 150)" : "rgb(85, 91, 96)");
      expect(await page.getByRole("button", { name: "Create account", exact: true }).evaluate(button => getComputedStyle(button).minHeight)).toBe("48px");
      expect(await page.locator("h1").evaluate(heading => getComputedStyle(heading).fontSize)).toBe("32px");
      const headingMetrics = await page.evaluate(async () => {
        await document.fonts.ready;
        const probe = document.createElement("div");
        probe.innerHTML = "<h2>Section</h2><h3>Detail</h3>";
        document.querySelector(".website-home")!.append(probe);
        const metrics = [document.querySelector("h1")!, ...probe.children].map(heading => {
          const style = getComputedStyle(heading);
          return [style.fontSize, style.fontWeight, style.lineHeight];
        });
        probe.remove();
        return { metrics, interLoaded: document.fonts.check('600 32px "Inter Website"') };
      });
      expect(headingMetrics).toEqual({ metrics: [["32px", "600", "36.8px"], ["24px", "600", "27.6px"], ["20px", "600", "23px"]], interLoaded: true });
      await page.setViewportSize({ width: 700, height: 844 });
      await expect.poll(() => page.locator("h1").evaluate(heading => getComputedStyle(heading).fontSize)).toBe("40px");
      await expect(page.locator(".website-menu")).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.locator(".website-navigation")).toBeVisible();
      await expect(page.locator(".website-menu")).toBeHidden();
      await expect(page.locator(".website-hero-actions button")).toHaveCount(2);
      await expect(page.locator(".website-problem-row > li")).toHaveCount(3);
      await expect(page.locator(".website-workflow-row > li")).toHaveCount(5);
      expect(await page.locator(".website-hero").evaluate(hero => {
        const bounds = hero.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, background: getComputedStyle(hero).backgroundImage };
      })).toMatchObject({ x: 0, y: 72, width: 1280, height: 560 });
      expect(await page.locator("#workload").evaluate(section => section.getBoundingClientRect().top)).toBe(632);
      expect(await page.locator(".website-hero .website-eyebrow").evaluate(label => {
        const style = getComputedStyle(label);
        return { top: label.getBoundingClientRect().top, color: style.color, rule: style.borderInlineStartWidth, padding: style.paddingInlineStart, aligned: label.getBoundingClientRect().left === document.querySelector(".website-hero h1")!.getBoundingClientRect().left };
      })).toEqual({ top: 152, color: "rgb(247, 246, 242)", rule: "0px", padding: "0px", aligned: true });
      for (const row of [".website-problem-row", ".website-workflow-row"]) {
        const notch = await page.locator(row + " > li").first().evaluate(item => {
          const notch = getComputedStyle(item, "::after");
          return { top: parseFloat(notch.top), midpoint: item.getBoundingClientRect().height / 2, right: notch.right, borderBottom: notch.borderBottomWidth, borderLeft: notch.borderLeftWidth };
        });
        expect(notch).toMatchObject({ right: "-6px", borderBottom: "0px", borderLeft: "0px" });
        expect(notch.top).toBeCloseTo(notch.midpoint, 1);
      }
      expect(await page.locator(".website-problem .website-eyebrow").evaluate(label => getComputedStyle(label).textTransform)).toBe("none");
      await expect(page.locator(".website-workflow .website-eyebrow")).toHaveText("How it works");
      expect((await page.locator("main").innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(220);
      const image = await page.evaluate(async () => {
        const image = new Image(); image.src = "/images/kanban-card-cascade.webp"; await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
      expect(image.width / image.height).toBeGreaterThan(2.4);
      expect(image.width / image.height).toBeLessThan(2.6);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.locator("h1").evaluate(heading => getComputedStyle(heading).fontSize)).toBe("32px");
      expect(await page.locator(".website-hero").evaluate(hero => hero.getBoundingClientRect().height)).toBe(528);
      expect(await page.locator("#workload").evaluate(section => section.getBoundingClientRect().top)).toBe(600);
      expect(await page.locator(".website-workflow-step").first().evaluate(step => {
        const marker = step.querySelector(".website-step-marker")!.getBoundingClientRect();
        const title = step.querySelector("h3")!.getBoundingClientRect();
        return { columns: getComputedStyle(step).gridTemplateColumns.split(" ").length, markerLeft: marker.left, titleLeft: title.left };
      })).toMatchObject({ columns: 2, markerLeft: 36, titleLeft: 96 });
      const problemMobile = await page.locator(".website-problem-row > li").first().evaluate(item => {
        const ordinal = item.querySelector(".website-ordinal")!.getBoundingClientRect();
        const title = item.querySelector("h3")!.getBoundingClientRect();
        const notch = getComputedStyle(item, "::after");
        return { display: getComputedStyle(item).display, ordinalLeft: ordinal.left, titleLeft: title.left, ordinalBottom: ordinal.bottom, titleTop: title.top, notchBottom: notch.bottom, notchLeft: notch.left };
      });
      expect(problemMobile).toMatchObject({ display: "list-item", ordinalLeft: 36, titleLeft: 36, notchBottom: "-6px", notchLeft: "24px" });
      expect(problemMobile.titleTop).toBeGreaterThan(problemMobile.ordinalBottom);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const start = page.getByRole("button", { name: "Create account", exact: true });
      expect(await start.evaluate(button => getComputedStyle(button).backgroundColor)).toBe("rgb(247, 246, 242)");
      expect(await start.evaluate(button => getComputedStyle(button).color)).toBe("rgb(11, 13, 14)");
      await start.focus();
      await page.keyboard.press("Tab");
      const secondary = page.getByRole("button", { name: "Sign in", exact: true });
      await expect(secondary).toBeFocused();
      expect(await secondary.evaluate(button => getComputedStyle(button).boxShadow)).toContain("5px");
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await secondary.click();
      await expect(page).toHaveURL(authOrigin + "/sign-in");
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      const signInCard = page.locator(".access-card");
      const recovery = signInCard.getByRole("button", { name: "Recover access", exact: true });
      await expect(page.locator("footer").getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await expect(signInCard.getByRole("button")).toHaveText(["Continue with passkey", "Back", "Recover access"]);
      expect(await recovery.evaluate(button => {
        const style = getComputedStyle(button);
        return { target: button.getBoundingClientRect().height, background: style.backgroundColor, border: style.borderTopWidth, underline: style.textDecorationLine, shadow: style.boxShadow };
      })).toEqual({ target: 48, background: "rgba(0, 0, 0, 0)", border: "0px", underline: "underline", shadow: "none" });
      await signInCard.getByRole("button", { name: "Continue with passkey", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(signInCard.getByRole("button", { name: "Back", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(recovery).toBeFocused();
      expect(await recovery.evaluate(button => getComputedStyle(button).boxShadow)).toContain("5px");
      const flow: Array<{ host: string; path: string; origin: string; mode?: string; rootOrigin?: string; boundFieldsPresent?: boolean }> = [];
      const headerReads: Array<Promise<void>> = [];
      const observeRecovery = (request: import("@playwright/test").Request) => {
        if (request.method() !== "POST") return;
        const url = new URL(request.url());
        if (!["/api/auth-start", "/api/passkeys/start"].includes(url.pathname)) return;
        const observed: (typeof flow)[number] = { host: url.host, path: url.pathname, origin: "" };
        flow.push(observed);
        headerReads.push(request.allHeaders().then(headers => { observed.origin = headers.origin || ""; }));
        if (url.pathname === "/api/auth-start") observed.mode = request.postDataJSON().mode;
        if (url.pathname === "/api/passkeys/start") {
          const fields = new URLSearchParams(request.postData() || "");
          observed.rootOrigin = fields.get("rootOrigin") || "";
          observed.boundFieldsPresent = Boolean(fields.get("intentToken") && fields.get("browserNonce"));
        }
      };
      page.on("request", observeRecovery);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Recover your account", exact: true })).toBeVisible();
      page.off("request", observeRecovery);
      await Promise.all(headerReads);
      await expect(page).toHaveURL(authOrigin + "/sign-in");
      await expect(page.getByLabel("Recovery code", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      expect(flow).toEqual([
        { host: `board.localhost:${port}`, path: "/api/auth-start", origin: rootOrigin, mode: "recover" },
        { host: `auth.board.localhost:${port}`, path: "/api/passkeys/start", origin: rootOrigin, rootOrigin, boundFieldsPresent: true }
      ]);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(rootOrigin + "/");
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await start.click();
      await expect(page).toHaveURL(authOrigin + "/sign-up");
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await expect(page.locator("body")).toHaveClass(/public-website/);
      await page.getByLabel("Workspace name", { exact: true }).fill("First synthetic Workspace");
      await page.getByLabel("Workspace address", { exact: true }).fill("first");
      const menu = page.locator(".website-menu");
      await menu.locator("summary").click();
      await expect(menu).toHaveAttribute("open", "");
      await page.keyboard.press("Escape");
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(menu.locator("summary")).toBeFocused();
      await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("First synthetic Workspace");
      await expect(page.getByLabel("Workspace address", { exact: true })).toHaveValue("first");
      await menu.locator("summary").click();
      await page.getByLabel("Workspace name", { exact: true }).click();
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("First synthetic Workspace");
      await page.getByRole("button", { name: "Create passkey", exact: true }).focus();
      await page.keyboard.press("Tab");
      const back = page.getByRole("button", { name: "Back", exact: true });
      await expect(back).toBeFocused();
      expect(await back.evaluate(button => getComputedStyle(button).boxShadow)).toContain("5px");
      await page.getByRole("button", { name: "Create passkey", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Save your recovery code", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await expect(page.locator("body")).toHaveClass(/public-website/);
      await page.getByRole("button", { name: "I saved my recovery code", exact: true }).click();
      await expect(page).toHaveURL(`http://first.board.localhost:${port}/`);
      await expect(page.getByRole("heading", { name: "Create the first Project", exact: true })).toBeVisible();
      await expectWorkbench();
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Open account panel", exact: true }).click();
      await expect(page.locator("#account-panel")).toBeVisible();
      expect(await page.locator("#account-panel .jk-button").first().evaluate(button => getComputedStyle(button).minHeight)).toBe("44px");
      const owner = (await store.read()).owners[0];
      await store.createWorkspace({ providerSubject: owner.id, email: "", displayName: owner.displayName, slug: "second", name: "Second synthetic Workspace" });
      await page.goto(rootOrigin + "/?access=recover");
      await expect(page.getByRole("heading", { name: "Choose a Workspace", exact: true })).toBeVisible();
      await expect(page).toHaveURL(rootOrigin + "/?access=recover");
      await expect(page.getByRole("button", { name: "Recover access", exact: true })).toHaveCount(0);
      await expectWorkbench();
      expect(await page.locator(".access-card").evaluate(card => getComputedStyle(card).backgroundColor)).toBe(privateSurface);
      expect(await page.getByRole("button", { name: "Manage access", exact: true }).evaluate(button => getComputedStyle(button).minHeight)).toBe("44px");
      await page.getByRole("button", { name: "Manage access", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Manage access", exact: true })).toBeVisible();
      await expectWorkbench();
      expect(await page.locator(".access-card").evaluate(card => getComputedStyle(card).backgroundColor)).toBe(privateSurface);
      await page.getByRole("button", { name: "Back to Workspaces", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Signed out", exact: true })).toBeVisible();
      await expect(page.locator("body")).toHaveClass(/public-website/);
      await expect(page.locator("main button")).toHaveCount(1);
    } finally {
      await cdp.detach();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
