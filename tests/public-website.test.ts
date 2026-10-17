import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePublicWebsiteCss } from "../scripts/public-website-contract";
import { DEFAULT_PAGE_TITLE, PUBLIC_HOME_TITLE, PUBLIC_WEBSITE_ASSETS, passkeyFormCopy, publicPageTitle, renderPublicHomepage, renderPublicWebsite, usesPublicWebsite } from "../src/public-website";
import { createApp } from "../src/server";
import { renderBrandHead } from "../src/brand";
import { createFileAccessStore } from "../src/access-store";
import { createWorkspaceStoreResolver } from "../src/state-store";

const root = path.resolve(__dirname, "..");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("public shell eligibility excludes every authenticated and local context", () => {
  for (const context of ["root", "auth", "workspace", "local"]) {
    assert.equal(usesPublicWebsite(context, true), false, context + " authenticated");
    assert.equal(usesPublicWebsite(context, false), context === "root" || context === "auth", context + " signed out");
  }
  const form = '<main class="access-view"><h1>Sign in</h1><form data-form="passkey"><button>Continue with passkey</button></form></main>';
  const html = renderPublicWebsite(form, "http://board.localhost:4322");
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.ok(html.includes('id="public-main" tabindex="-1"'));
  assert.ok(html.includes('<form data-form="passkey"><button>Continue with passkey</button></form>'));
  assert.equal((html.match(/src="\/brand-lockup-dark.svg"/g) || []).length, 2);
  assert.equal((html.match(/href="http:\/\/board.localhost:4322"/g) || []).length, 2);
  assert.ok(html.includes('href="https://surfaces.systems/"'));
  assert.ok(html.includes('href="https://handbooks.surfaces.systems/"'));
});

test("public homepage has the bounded source-grounded composition and two existing auth actions", () => {
  const actions = '<button data-action="start-signup">Create account</button><button data-action="passkey-sign-in">Sign in</button>';
  const html = renderPublicHomepage(actions);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<section\b/g) || []).length, 3);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes('Turn a plan into Cards.'));
  assert.ok(html.includes('A shared board where you and your agents record work and its progress.'));
  assert.ok(html.includes('An installed skill with read and write access lets your agent read and update the board.'));
  assert.ok(html.includes('Keep the work and its updates together.'));
  const hero = html.split('<section id="workload"')[0];
  assert.equal((hero.match(/<button\b/g) || []).length, 2);
  assert.ok(!html.includes('access-card'));
  assert.ok(!html.includes('<img'));
  const problems = html.match(/<ol class="website-problem-row">([\s\S]*?)<\/ol>/)![1];
  assert.equal((problems.match(/<li>/g) || []).length, 3);
  const steps = Array.from(html.matchAll(/<div><h3>(.*?)<\/h3><p>/g), match => match[1]);
  assert.deepEqual(steps, ["Turn a plan into Cards", "Choose the next work", "Perform the work", "Update the Card", "Reconcile the Project with reality"]);
  assert.equal((html.match(/<svg\b/g) || []).length, 5);
  assert.equal((html.match(/class="website-support"/g) || []).length, 1);
  const words = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").trim().split(/\s+/);
  assert.ok(words.length <= 220, `Homepage contains ${words.length} words`);
  assert.ok(!html.includes("Recover access"));
  const shell = renderPublicWebsite(html, "https://kanban.cards/", '<button data-action="start-setup">Set up existing account</button>');
  const desktopNav = shell.match(/<nav class="website-navigation"[^>]*>([\s\S]*?)<\/nav>/)![1];
  assert.equal((desktopNav.match(/<a\b/g) || []).length, 4);
  assert.ok(shell.includes('href="https://kanban.cards/#workload"'));
  assert.ok(shell.includes('href="https://kanban.cards/#how-it-works"'));
  assert.ok(shell.match(/<footer[\s\S]*data-action="start-setup"/));
  assert.ok(!shell.includes("Recover access"));
});

test("recovery copy states credential replacement while other passkey modes keep their instructions", () => {
  const recovery = passkeyFormCopy("recover");
  assert.equal(recovery.submitLabel, "Replace passkeys");
  assert.ok(recovery.instruction.includes("After verification"));
  for (const consequence of ["previous passkeys", "browser and app sessions", "agent keys stop working"]) assert.ok(recovery.instruction.includes(consequence));
  for (const mode of ["signup", "setup", "add"]) assert.deepEqual(passkeyFormCopy(mode), {
    instruction: "Use your device or password manager to save a passkey.", submitLabel: "Create passkey"
  });
  for (const mode of ["signin", "verify"]) assert.deepEqual(passkeyFormCopy(mode), {
    instruction: "Use your passkey to continue.", submitLabel: "Continue with passkey"
  });
});

test("page and social descriptions match the exact visible homepage lead", async () => {
  const lead = renderPublicHomepage("").match(/<p class="website-lead">([^<]+)<\/p>/)![1];
  assert.equal(lead, "A shared board where you and your agents record work and its progress.");
  const staticHtml = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.equal(staticHtml.match(/<title>([^<]*)<\/title>/)![1], PUBLIC_HOME_TITLE);
  assert.ok(staticHtml.includes(renderBrandHead()));
  for (const html of [staticHtml, renderBrandHead()]) {
    const descriptions = Array.from(html.matchAll(/<meta (?:name|property)="(?:description|og:description|twitter:description)" content="([^"]+)"/g), match => match[1]);
    assert.deepEqual(descriptions, [lead, lead, lead]);
  }
});

test("resolved public titles follow the task while private and transitional views stay neutral", async () => {
  const resolved = { context: "root", authenticated: false, resolved: true };
  assert.equal(PUBLIC_HOME_TITLE, "Shared Kanban Board for People and Agents | kanban.cards");
  assert.equal(publicPageTitle(resolved), PUBLIC_HOME_TITLE);
  assert.equal(publicPageTitle({ ...resolved, signedOut: true }), "Signed out | kanban.cards");
  const modes = { signin: "Sign in", signup: "Create account", recover: "Recover your account", setup: "Set up your passkey", add: "Add a passkey", verify: "Confirm access" };
  for (const [authMode, title] of Object.entries(modes)) {
    const state = { ...resolved, context: "auth", authMode };
    assert.equal(publicPageTitle(state), title + " | kanban.cards");
    assert.equal(publicPageTitle({ ...state, recoveryCodePresent: true }), "Save your recovery code | kanban.cards", "receipt takes priority over " + authMode);
  }
  for (const authMode of [null, "", "unvalidated-private-token"]) assert.equal(publicPageTitle({ ...resolved, context: "auth", authMode }), "Account access | kanban.cards");
  for (const context of ["root", "auth", "workspace", "local"]) {
    assert.equal(publicPageTitle({ ...resolved, context, authenticated: true, recoveryCodePresent: true, signedOut: true }), DEFAULT_PAGE_TITLE);
    assert.equal(publicPageTitle({ ...resolved, context, resolved: false }), DEFAULT_PAGE_TITLE);
    assert.equal(publicPageTitle({ ...resolved, context, pending: true }), DEFAULT_PAGE_TITLE);
  }
  for (const context of ["workspace", "local", "unknown-private-project"]) assert.equal(publicPageTitle({ ...resolved, context, signedOut: true }), DEFAULT_PAGE_TITLE);
  // Repeated renders must restore the neutral title after entering a private or pending state.
  const sequence = [resolved, { ...resolved, authenticated: true }, { ...resolved, pending: true }, { ...resolved, context: "auth", authMode: "recover" }, { ...resolved, context: "local" }];
  assert.deepEqual(sequence.map(publicPageTitle), [PUBLIC_HOME_TITLE, DEFAULT_PAGE_TITLE, DEFAULT_PAGE_TITLE, "Recover your account | kanban.cards", DEFAULT_PAGE_TITLE]);
  const client = await fs.readFile(path.join(root, "src/client/context-dock.ts"), "utf8");
  assert.match(client, /function render\(\): void \{[\s\S]*?document\.title = publicPageTitle\(/);
});

test("HTML title classification is conservative and social identity stays fixed on every shell", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-public-titles-"));
  const config = { authHost: "auth.board.localhost", authOrigin: "http://auth.board.localhost", rpId: "auth.board.localhost", rootOrigins: ["http://board.localhost"], sessionSecret: "public-titles-synthetic-only-more-than-32", sessionTtlSeconds: 3600 };
  const options = { host: "board.localhost", rootHost: "board.localhost", staticDir: root, requireDatabase: false, trustForwardedHost: true, apiToken: "",
    dataPath: path.join(directory, "data.json"), accessStore: createFileAccessStore(path.join(directory, "access.json")),
    workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }), passkeyAuthConfig: config };
  const servers = [createServer(createApp(options)), createServer(createApp({ ...options, staticDir: path.join(directory, "missing-static") })), createServer(createApp({ ...options, passkeyAuthConfig: null }))];
  const bases: string[] = [];
  try {
    for (const server of servers) {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    async function check(base: string, host: string, route: string, expected: string, headers: Record<string, string> = {}) {
      const response = await fetch(base + route, { headers: { "X-Forwarded-Host": host, ...headers } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const html = await response.text();
      assert.deepEqual(Array.from(html.matchAll(/<title>([^<]*)<\/title>/g), match => match[1]), [expected]);
      const socialTitles = Array.from(html.matchAll(/<meta (?:property|name)="(?:og:title|twitter:title)" content="([^"]+)"/g), match => match[1]);
      assert.deepEqual(socialTitles, [PUBLIC_HOME_TITLE, PUBLIC_HOME_TITLE]);
      assert.match(html, /name="application-name" content="kanban.cards"/);
      assert.match(html, /name="apple-mobile-web-app-title" content="kanban.cards"/);
      assert.match(html, /property="og:site_name" content="kanban.cards"/);
    }
    const intentCookie = (mode: string, overrides = {}) => {
      const payload = Buffer.from(JSON.stringify({ id: "synthetic-intent", mode, browserHash: "sha256:" + "a".repeat(64), rootOrigin: config.rootOrigins[0], ownerId: null, sessionId: null, action: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides })).toString("base64url");
      return `kanban_auth_intent=${payload}.${createHmac("sha256", config.sessionSecret).update(payload).digest("base64url")}`;
    };
    for (const base of bases.slice(0, 2)) {
      for (const route of ["/", "/index.html", "/sign-in", "/sign-up"]) await check(base, "board.localhost", route, PUBLIC_HOME_TITLE);
      await check(base, "board.localhost", "/?signedout=1&private=never-copy-this", DEFAULT_PAGE_TITLE);
      await check(base, "board.localhost", "/", DEFAULT_PAGE_TITLE, { Cookie: "kanban_root_session=synthetic-credential" });
      await check(base, "board.localhost", "/", DEFAULT_PAGE_TITLE, { Authorization: "Bearer synthetic-credential" });
      for (const host of ["sample.board.localhost", "unknown.localhost"]) await check(base, host, "/", DEFAULT_PAGE_TITLE);
      for (const route of ["/sign-in", "/sign-up"]) await check(base, "auth.board.localhost", route, "Account access | kanban.cards");
      for (const [mode, title] of Object.entries({ signin: "Sign in", signup: "Create account", recover: "Recover your account", setup: "Set up your passkey", add: "Add a passkey", verify: "Confirm access" })) {
        await check(base, "auth.board.localhost", "/sign-in?mode=ignore-raw-value", title + " | kanban.cards", { Cookie: intentCookie(mode) });
      }
      for (const cookie of ["kanban_auth_intent=forged.invalid", intentCookie("recover", { rootOrigin: "http://untrusted.localhost" }), intentCookie("recover", { expiresAt: "2000-01-01T00:00:00Z" }), intentCookie("unknown-secret-value")]) {
        await check(base, "auth.board.localhost", "/sign-up?mode=signup", "Account access | kanban.cards", { Cookie: cookie });
      }
    }
    await check(bases[2], "board.localhost", "/", DEFAULT_PAGE_TITLE);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("selected Card cascade source is the approved unchanged raster and build output", async () => {
  const image = await fs.readFile(path.join(root, "website-assets/kanban-card-cascade.webp"));
  assert.equal(sha256(image), "07322bbc443588bb9b4fd9ae5c2567ea67b58d9e93dca591b3b92c862842a699");
  assert.equal(image.toString("ascii", 0, 4), "RIFF");
  assert.equal(image.toString("ascii", 8, 12), "WEBP");
  assert.equal(image.readUInt32LE(4) + 8, image.length);
  assert.equal(image.toString("ascii", 12, 16), "VP8 ");
  assert.deepEqual(Array.from(image.subarray(23, 26)), [0x9d, 0x01, 0x2a]);
  assert.equal(image.readUInt16LE(26) & 0x3fff, 1983);
  assert.equal(image.readUInt16LE(28) & 0x3fff, 793);
  assert.deepEqual(image, await fs.readFile(path.join(root, "public/images/kanban-card-cascade.webp")));
  const provenance = JSON.parse(await fs.readFile(path.join(root, "website-assets/art-provenance.json"), "utf8"));
  assert.equal(provenance.selection.status, "user-selected");
  assert.equal(provenance.selection.key, "cascade");
  assert.equal(provenance.sha256, sha256(image));
  await assert.rejects(fs.access(path.join(root, "website-assets/kanban-card-environment-v2.webp")), { code: "ENOENT" });
});

test("website CSS cannot leak into Workbench selectors or introduce remote fonts", async () => {
  const css = await fs.readFile(path.join(root, "website.css"), "utf8");
  assert.deepEqual(validatePublicWebsiteCss(css), []);
  assert.equal(await fs.readFile(path.join(root, "public/website.css"), "utf8"), css);
  assert.ok(validatePublicWebsiteCss(css + "\n.access-card { padding: 1px; }").some(error => error.includes("Unscoped")));
  assert.ok(validatePublicWebsiteCss(css + "\nbody { font-family: Inter; }").some(error => error.includes("Unscoped")));
  assert.ok(validatePublicWebsiteCss(css.replace('/fonts/inter-latin.woff2', 'https://example.test/font.woff2')).some(error => error.includes("local Inter")));
  assert.ok(validatePublicWebsiteCss(css.replaceAll('/images/kanban-card-cascade.webp', 'https://example.test/hero.webp')).some(error => error.includes("hero image")));
  assert.ok(validatePublicWebsiteCss(css + "\n.public-website { --jk-color-canvas: white; }").some(error => error.includes("Workbench tokens")));
  for (const name of ["judgmentkit.css", "styles.css"]) {
    assert.deepEqual(await fs.readFile(path.join(root, name)), await fs.readFile(path.join(root, "public", name)));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, "website-assets/manifest.json"), "utf8"));
  for (const asset of manifest.assets) {
    const source = await fs.readFile(path.join(root, asset.source));
    assert.equal(sha256(source), asset.sha256);
    assert.deepEqual(source, await fs.readFile(path.join(root, asset.output)));
  }
});

test("only exact public GET/HEAD website assets bypass auth routing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-public-assets-"));
  const server = createServer(createApp({
    host: "board.localhost", rootHost: "board.localhost", staticDir: root, requireDatabase: false, trustForwardedHost: true,
    dataPath: path.join(directory, "data.json"), accessStore: createFileAccessStore(path.join(directory, "access.json")),
    workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }),
    passkeyAuthConfig: { authHost: "auth.board.localhost", authOrigin: "http://auth.board.localhost", rpId: "auth.board.localhost", rootOrigins: ["http://board.localhost"], sessionSecret: "public-website-assets-synthetic-only-more-than-32", sessionTtlSeconds: 3600 }
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const host of ["board.localhost", "auth.board.localhost", "sample.board.localhost"]) for (const [route, file, type] of PUBLIC_WEBSITE_ASSETS) {
      const response = await fetch(base + route, { headers: { "X-Forwarded-Host": host } });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(type));
      assert.equal(response.headers.get("set-cookie"), null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(path.join(root, file)));
      const head = await fetch(base + route, { method: "HEAD", headers: { "X-Forwarded-Host": host } });
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
      for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(base + route, { method, headers: { "X-Forwarded-Host": host } })).status, 404);
    }
    for (const route of ["/fonts/inter-latin.woff2%2f..%2f..%2fapi%2fprojects", "/fonts/private.woff2", "/website-assets/manifest.json", "/images/kanban-card-environment-v2.webp", "/images/private.webp", "/images/kanban-card-cascade.webp%2f..%2f..%2fapi%2fprojects", "/api/projects"]) {
      assert.equal((await fetch(base + route, { headers: { "X-Forwarded-Host": "auth.board.localhost" } })).status, 404, route);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
