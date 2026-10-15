import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileAccessStore } from "../src/access-store";
import { BRAND_PUBLIC_ASSETS, renderBrandHead } from "../src/brand";
import { FAVICON_STYLE_HASH, FAVICON_STYLE_ROUTES } from "../src/brand-web-assets";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

const root = path.resolve(__dirname, "..");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

test("web branding metadata, fixed manifest identity, canonical artwork and raster dimensions stay coherent", async () => {
  const head = renderBrandHead();
  assert.ok((await fs.readFile(path.join(root, "index.html"), "utf8")).includes(head));
  for (const name of ["og:title", "og:type", "og:url", "og:image", "og:image:type", "og:image:width", "og:image:height", "og:image:alt", "twitter:card", "twitter:image", "twitter:image:alt"]) {
    assert.equal((head.match(new RegExp(`(?:name|property)="${name}"`, "g")) || []).length, 1, name);
  }
  assert.match(head, /name="twitter:card" content="summary_large_image"/);
  assert.match(head, /property="og:image" content="https:\/\/kanban.cards\/social-brand-v2.png"/);
  assert.match(head, /property="og:image:width" content="1200"/);
  assert.match(head, /property="og:image:height" content="630"/);
  assert.doesNotMatch(head, /(?:auth\.|mike\.|intent=|handoff=|workspace=)/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "brand/split-k/web/asset-manifest.json"), "utf8"));
  assert.equal(manifest.faviconStyleHash, FAVICON_STYLE_HASH);
  assert.deepEqual(manifest.faviconStyleRoutes, FAVICON_STYLE_ROUTES);
  for (const [file, hash] of Object.entries(manifest.sources)) assert.equal(sha256(await fs.readFile(path.join(root, file))), hash);
  assert.deepEqual(BRAND_PUBLIC_ASSETS.slice(2).map(([route, file, contentType]) => ({ route, file, contentType })), manifest.assets.map((a: { route: string; source: string; contentType: string }) => ({ route: a.route, file: "public/branding/" + path.basename(a.source), contentType: a.contentType })));
  for (const asset of manifest.assets) {
    const bytes = await fs.readFile(path.join(root, asset.source));
    assert.equal(sha256(bytes), asset.sha256, asset.source);
    assert.deepEqual(await fs.readFile(path.join(root, "public/branding", path.basename(asset.source))), bytes);
    if (asset.aliasOf) {
      const target = manifest.assets.find((item: { route: string }) => item.route === asset.aliasOf);
      assert.ok(target);
      assert.deepEqual(bytes, await fs.readFile(path.join(root, target.source)), asset.route + " is a fresh alias");
    }
    if (asset.contentType === "image/png") {
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], asset.dimensions);
      assert.equal(bytes[25], asset.route.startsWith("/social-brand-") ? 2 : 6, "social PNG is RGB; icons use the shared PNG32 recipe");
    }
  }
  const ico = await fs.readFile(path.join(root, "public/branding/favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([0, 1, 2].map(i => [ico[6 + i * 16], ico[7 + i * 16]]), [[16, 16], [32, 32], [48, 48]]);
  const adaptive = await fs.readFile(path.join(root, "public/branding/favicon.svg"), "utf8");
  const style = adaptive.match(/<style>([^<]+)<\/style>/)?.[1];
  assert.ok(style);
  assert.equal("sha256-" + createHash("sha256").update(style).digest("base64"), FAVICON_STYLE_HASH);
  const social = await fs.readFile(path.join(root, "brand/split-k/web/social-brand-v1.svg"), "utf8");
  const canonical = await fs.readFile(path.join(root, "brand/split-k/lockups/horizontal-reversed.svg"), "utf8");
  for (const attribute of ["d", "points"]) {
    const values = (s: string) => Array.from(s.matchAll(new RegExp(` ${attribute}="([^"]+)"`, "g")), m => m[1]);
    assert.deepEqual(values(social), values(canonical), attribute + " keeps the complete canonical mark and wordmark");
  }
  const viewBox = canonical.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(viewBox);
  const width = Number(viewBox[1]), height = Number(viewBox[2]);
  const transform = social.match(/data-role="canonical-lockup" transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"/);
  assert.ok(transform);
  const scale = Math.min(2.8, 960 / width);
  assert.ok(Math.abs(Number(transform[3]) - scale) < 1e-11);
  assert.ok(Math.abs(Number(transform[1]) - (1200 - width * scale) / 2) < 1e-8);
  assert.ok(Math.abs(Number(transform[2]) - (630 - height * scale) / 2) < 1e-8);
  assert.match(social, /<rect width="1200" height="630" fill="#0B0D0E"/);
  assert.equal((social.match(/<rect /g) || []).length, 1);
  const canonicalTransforms = Array.from(canonical.matchAll(/ transform="([^"]+)"/g), m => m[1]);
  assert.deepEqual(Array.from(social.matchAll(/ transform="([^"]+)"/g), m => m[1]).slice(1), canonicalTransforms);
  assert.deepEqual(Array.from(social.matchAll(/ fill="([^"]+)"/g), m => m[1]).slice(1), Array.from(canonical.matchAll(/ fill="([^"]+)"/g), m => m[1]));
  assert.match(social, /#8B9096/);
  assert.doesNotMatch(social, /<text\b/);
  const pwa = JSON.parse(await fs.readFile(path.join(root, "public/branding/site.webmanifest"), "utf8"));
  assert.deepEqual([pwa.id, pwa.start_url, pwa.scope], ["/", "/", "/"]);
  assert.equal(pwa.name, "kanban.cards");
  assert.equal(pwa.display, "standalone");
  assert.deepEqual([pwa.background_color, pwa.theme_color], ["#F7F6F2", "#F7F6F2"]);
  assert.deepEqual(pwa.icons.map((i: { src: string }) => i.src), ["/app-icon-v2-192.png", "/app-icon-v2-512.png", "/maskable-v2-192.png", "/maskable-v2-512.png"]);
  assert.deepEqual(pwa.icons.map((i: { sizes: string; purpose: string }) => [i.sizes, i.purpose]), [["192x192", "any"], ["512x512", "any"], ["192x192", "maskable"], ["512x512", "maskable"]]);
  for (const icon of pwa.icons) assert.ok(BRAND_PUBLIC_ASSETS.some(([route]) => route === icon.src));
  const robots = await fs.readFile(path.join(root, "robots.txt"), "utf8");
  assert.equal(robots, "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /social-brand-v1.png$\nAllow: /social-brand-v2.png$\n\n");
});

test("shared icon tiles keep original geometry, theme colors, measured placement and external radius", async () => {
  const rules = JSON.parse(await fs.readFile(path.join(root, "brand/split-k/web/derivative-rules.json"), "utf8"));
  assert.deepEqual(rules.browserIcon, { canvas: 64, cornerRadius: 8, visibleMarkHeight: 48, center: [32, 32], fallbackTheme: "light" });
  assert.deepEqual(rules.regularAppIcon, { canvas: 64, cornerRadius: 0, visibleMarkHeight: 48, theme: "light" });
  assert.deepEqual(rules.maskableIcon, { canvas: 64, cornerRadius: 0, visibleMarkHeight: 36, safeZoneRadiusRatio: 0.4, theme: "light" });
  assert.equal(rules.iconRaster.density, 384);
  assert.equal(rules.iconRaster.format, "PNG32");
  const points = ["6,6 18,6 18,58 6,58", "26,16 58,2 58,16 26,30", "26,34 58,48 58,62 26,48"];
  for (const [name, theme, visibleHeight, radius] of [["favicon-v2-light", "light", 48, 8], ["favicon-v2-dark", "dark", 48, 8], ["app-icon-v2", "light", 48, 0], ["maskable-v2", "light", 36, 0]] as const) {
    const svg = await fs.readFile(path.join(root, "brand/split-k/web", name + ".svg"), "utf8");
    assert.match(svg, /viewBox="0 0 64 64"/);
    assert.deepEqual(Array.from(svg.matchAll(/ points="([^"]+)"/g), m => m[1]), points);
    assert.doesNotMatch(svg, /<(?:text|path)\b/);
    const fills = Array.from(svg.matchAll(/ fill="([^"]+)"/g), m => m[1]);
    assert.deepEqual(fills, theme === "light" ? ["#F7F6F2", "#0B0D0E", "#0B0D0E", "#8B9096"] : ["#0B0D0E", "#F7F6F2", "#F7F6F2", "#8B9096"]);
    assert.match(svg, new RegExp(`<rect width="64" height="64" rx="${radius}"`));
    const transform = svg.match(/data-role="mark" transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"/);
    assert.ok(transform);
    const [tx, ty, scale] = transform.slice(1).map(Number);
    assert.equal(scale * 60, visibleHeight);
    assert.equal(tx + scale * 32, 32);
    assert.equal(ty + scale * 32, 32);
    if (name === "maskable-v2") for (const polygon of points) for (const point of polygon.split(" ")) {
      const [x, y] = point.split(",").map(Number);
      assert.ok(Math.hypot(tx + scale * x - 32, ty + scale * y - 32) < 64 * 0.4);
    }
  }
  const head = renderBrandHead();
  for (const theme of ["light", "dark"]) for (const size of [16, 32]) {
    assert.ok(head.includes(`href="/favicon-v2-${theme}-${size}.png" type="image/png" sizes="${size}x${size}" media="(prefers-color-scheme: ${theme})"`));
  }
});

test("only exact public GET/HEAD brand resources bypass auth-host route restrictions; fallback head matches", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-web-brand-"));
  const create = (staticDir: string) => createApp({
    host: "board.localhost", rootHost: "board.localhost", staticDir, requireDatabase: false, trustForwardedHost: true,
    dataPath: path.join(directory, "data.json"), accessStore: createFileAccessStore(path.join(directory, "access.json")),
    workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }),
    passkeyAuthConfig: { authHost: "auth.board.localhost", authOrigin: "http://auth.board.localhost", rpId: "auth.board.localhost", rootOrigins: ["http://board.localhost"], sessionSecret: "web-brand-test-only-secret-more-than-32-characters", sessionTtlSeconds: 3600 }
  });
  const server = createServer(create(root));
  const fallback = createServer(create(directory));
  await Promise.all([server, fallback].map(s => new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve))));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const host of ["board.localhost", "auth.board.localhost", "sample.board.localhost"]) {
      for (const [route, file, contentType] of BRAND_PUBLIC_ASSETS) {
        const expected = await fs.readFile(path.join(root, file));
        const response = await fetch(base + route, { headers: { "X-Forwarded-Host": host } });
        assert.equal(response.status, 200, host + route);
        assert.ok(response.headers.get("content-type")?.startsWith(contentType));
        assert.equal(response.headers.get("set-cookie"), null);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        const csp = response.headers.get("content-security-policy") || "";
        assert.doesNotMatch(csp, /unsafe-inline/);
        assert.equal(csp.includes(FAVICON_STYLE_HASH), FAVICON_STYLE_ROUTES.some(adaptive => adaptive === route));
        const head = await fetch(base + route, { method: "HEAD", headers: { "X-Forwarded-Host": host } });
        assert.equal(head.status, 200);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(base + route, { method, headers: { "X-Forwarded-Host": host } })).status, 404, method + host + route);
      }
      const html = await (await fetch(base + (host.startsWith("auth.") ? "/sign-in" : "/"), { headers: { "X-Forwarded-Host": host } })).text();
      assert.ok(html.includes(renderBrandHead()));
      assert.match(html, /noindex,nofollow/);
      const robots = await (await fetch(base + "/robots.txt", { headers: { "X-Forwarded-Host": host } })).text();
      if (host === "board.localhost") {
        assert.equal(robots, "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /social-brand-v1.png$\nAllow: /social-brand-v2.png$\n\n");
      } else {
        assert.equal(robots, "User-agent: *\nDisallow: /\n");
      }
    }
    for (const route of ["/api/projects", "/api/workspaces", "/public/branding/site.webmanifest", "/brand/split-k/web/social-brand-v2.png", "/favicon.svg%2f..%2fapi%2fprojects", "/favicon-v2.svg%2f..%2fapi%2fprojects", "/%2e%2e%2fapi%2fprojects", "/social-brand-v2.png/../api/projects"]) {
      const response = await fetch(base + route, { headers: { "X-Forwarded-Host": "auth.board.localhost" } });
      assert.equal(response.status, 404, route);
    }
    const fallbackHtml = await (await fetch(`http://127.0.0.1:${(fallback.address() as AddressInfo).port}/`, { headers: { "X-Forwarded-Host": "board.localhost" } })).text();
    assert.ok(fallbackHtml.includes(renderBrandHead()));
    assert.match(fallbackHtml, /noindex,nofollow/);
  } finally {
    for (const s of [server, fallback]) s.closeAllConnections();
    await Promise.all([server, fallback].map(s => new Promise<void>((resolve, reject) => s.close(error => error ? reject(error) : resolve()))));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
