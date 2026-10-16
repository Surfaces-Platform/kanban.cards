import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { inflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileAccessStore } from "../src/access-store";
import { BRAND_PUBLIC_ASSETS, renderBrandHead } from "../src/brand";
import { BRAND_ICON_REVISION, FAVICON_STYLE_HASH, FAVICON_STYLE_ROUTES } from "../src/brand-web-assets";
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
  assert.equal(FAVICON_STYLE_HASH, null);
  assert.deepEqual(FAVICON_STYLE_ROUTES, []);
  assert.deepEqual(await fs.readFile(path.join(root, "public/branding/favicon.svg")), await fs.readFile(path.join(root, "public/branding/favicon-v2-dark.svg")));
  assert.doesNotMatch(await fs.readFile(path.join(root, "public/branding/favicon.svg"), "utf8"), /<style\b/);
  const baseIcons = manifest.assets.filter((a: { route: string }) => !a.route.startsWith("/social-brand-") && !a.route.startsWith("/site") && !/-[a-f0-9]{12}(?:[-.])/.test(a.route));
  const digestInput = baseIcons.map((a: { route: string; sha256: string }) => [a.route, a.sha256]);
  // Python's sort is Unicode codepoint order; use the same order for the identity.
  digestInput.sort((a: string[], b: string[]) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  assert.equal(sha256(JSON.stringify(digestInput)).slice(0, 12), BRAND_ICON_REVISION);
  assert.ok(head.includes(`src="/favicon-theme-${BRAND_ICON_REVISION}.js"`));
  assert.ok(head.includes(`data-light-icon="/favicon-${BRAND_ICON_REVISION}-light.ico"`));
  assert.ok(head.includes(`data-dark-icon="/favicon-${BRAND_ICON_REVISION}-dark.ico"`));
  const scripts = Array.from(head.matchAll(/<script\b([^>]*)><\/script>/g), match => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /\b(?:async|defer)\b|\btype\s*=/);
  assert.match(head, new RegExp(`<noscript><link rel="icon" href="/favicon-${BRAND_ICON_REVISION}-light.ico" type="image/x-icon" sizes="16x16 32x32 48x48"></noscript>`));
  assert.doesNotMatch(head.replace(/<noscript>[\s\S]*?<\/noscript>/g, ""), /<link\b[^>]*rel="icon"/);
  const controller = await fs.readFile(path.join(root, "brand/split-k/web/favicon-theme.js"));
  const rules = JSON.parse(await fs.readFile(path.join(root, "brand/split-k/web/derivative-rules.json"), "utf8"));
  assert.equal(sha256(controller), rules.browserController.sha256);
  assert.equal(rules.browserController.sha256, "438e2c44cada8c2a0ae77ff4000d87f5d943b00afda39a786850f5fe3871140e");
  assert.ok(manifest.assets.some((asset: { route: string; contentType: string }) => asset.route === `/favicon-theme-${BRAND_ICON_REVISION}.js` && asset.contentType === "text/javascript"));
  assert.ok(head.includes(`href="/apple-touch-icon-${BRAND_ICON_REVISION}.png"`));
  assert.ok(head.includes(`href="/site-${BRAND_ICON_REVISION}.webmanifest"`));
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
  assert.deepEqual([pwa.background_color, pwa.theme_color], ["#0B0D0E", "#0B0D0E"]);
  assert.deepEqual(pwa.icons.map((i: { src: string }) => i.src), [`/app-icon-${BRAND_ICON_REVISION}-192.png`, `/app-icon-${BRAND_ICON_REVISION}-512.png`, `/maskable-${BRAND_ICON_REVISION}-192.png`, `/maskable-${BRAND_ICON_REVISION}-512.png`]);
  assert.deepEqual(pwa.icons.map((i: { sizes: string; purpose: string }) => [i.sizes, i.purpose]), [["192x192", "any"], ["512x512", "any"], ["192x192", "maskable"], ["512x512", "maskable"]]);
  for (const icon of pwa.icons) assert.ok(BRAND_PUBLIC_ASSETS.some(([route]) => route === icon.src));
  const robots = await fs.readFile(path.join(root, "robots.txt"), "utf8");
  assert.equal(robots, "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /social-brand-v1.png$\nAllow: /social-brand-v2.png$\n\n");
});

test("shared icon derivatives keep original geometry, theme colors and measured placement", async () => {
  const rules = JSON.parse(await fs.readFile(path.join(root, "brand/split-k/web/derivative-rules.json"), "utf8"));
  assert.deepEqual(rules.browserIcon, { canvas: 64, visibleMarkHeight: 48, center: [32, 32], background: "transparent", legacyFallbackTheme: "dark", noScriptTheme: "light" });
  assert.deepEqual(rules.regularAppIcon, { canvas: 64, cornerRadius: 0, visibleMarkHeight: 48, theme: "dark" });
  assert.deepEqual(rules.maskableIcon, { canvas: 64, cornerRadius: 0, visibleMarkHeight: 36, safeZoneRadiusRatio: 0.4, theme: "dark" });
  assert.equal(rules.iconRaster.density, 384);
  assert.equal(rules.iconRaster.format, "PNG32");
  const points = ["6,6 18,6 18,58 6,58", "26,16 58,2 58,16 26,30", "26,34 58,48 58,62 26,48"];
  for (const [name, theme, visibleHeight, radius] of [["favicon-v2-light", "light", 48, 8], ["favicon-v2-dark", "dark", 48, 8], ["app-icon-v2", "dark", 48, 0], ["maskable-v2", "dark", 36, 0]] as const) {
    const svg = await fs.readFile(path.join(root, "brand/split-k/web", name + ".svg"), "utf8");
    assert.match(svg, /viewBox="0 0 64 64"/);
    assert.deepEqual(Array.from(svg.matchAll(/ points="([^"]+)"/g), m => m[1]), points);
    assert.doesNotMatch(svg, /<(?:text|path)\b/);
    const fills = Array.from(svg.matchAll(/ fill="([^"]+)"/g), m => m[1]);
    const transparentBrowser = name.startsWith("favicon-v2-");
    assert.deepEqual(fills, theme === "light" ? ["#0B0D0E", "#0B0D0E", "#8B9096"] : transparentBrowser ? ["#F7F6F2", "#F7F6F2", "#8B9096"] : ["#0B0D0E", "#F7F6F2", "#F7F6F2", "#8B9096"]);
    if (transparentBrowser) assert.doesNotMatch(svg, /<rect\b/);
    else assert.match(svg, new RegExp(`<rect width="64" height="64" rx="${radius}"`));
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
});

function decodeRgbaPng(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const data = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(stride * height);
  assert.equal(data.length, height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0, b = y ? pixels[(y - 1) * stride + x] : 0, c = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      pixels[y * stride + x] = (data[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

test("both theme ICOs match transparent marks; legacy fallbacks stay dark and installation icons stay opaque", async () => {
  const directory = path.join(root, "brand/split-k/web");
  assert.deepEqual(await fs.readFile(path.join(directory, "favicon.ico")), await fs.readFile(path.join(directory, "favicon-v2-dark.ico")));
  for (const theme of ["light", "dark"]) {
    const ico = await fs.readFile(path.join(directory, `favicon-v2-${theme}.ico`));
    assert.equal(ico.readUInt16LE(4), 3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const png = decodeRgbaPng(await fs.readFile(path.join(directory, `favicon-v2-${theme}-${size}.png`)));
      const offset = ico.readUInt32LE(6 + index * 16 + 12), length = ico.readUInt32LE(6 + index * 16 + 8);
      const frame = decodeRgbaPng(ico.subarray(offset, offset + length));
      assert.deepEqual(frame, png, "ICO uses exact themed PNG pixels");
      let transparentPixels = 0, primaryPixels = 0, nickelPixels = 0;
      const primary = theme === "dark" ? [247, 246, 242] : [11, 13, 14];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const pixel = Array.from(png.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
        if (pixel[3] === 0) transparentPixels++;
        if (Math.min(x, y, size - x - 1, size - y - 1) < Math.max(1, Math.floor(size / 16))) assert.equal(pixel[3], 0, "outside the mark remains fully transparent");
        if (pixel[3] > 0) assert.notDeepEqual(pixel.slice(0, 3), theme === "dark" ? [11, 13, 14] : [247, 246, 242], "browser icon has no opposite-theme plate");
        if (pixel[3] === 255 && pixel.slice(0, 3).every((value, i) => value === primary[i])) primaryPixels++;
        if (pixel[3] === 255 && pixel.slice(0, 3).every((value, i) => value === [139, 144, 150][i])) nickelPixels++;
      }
      assert.ok(transparentPixels > size * size / 2, "free-standing mark preserves surrounding transparency");
      assert.ok(primaryPixels > 0 && nickelPixels > 0, "primary and Nickel shapes remain visible");
    }
  }
  for (const name of ["apple-touch-icon-v2.png", "app-icon-v2-192.png", "app-icon-v2-512.png", "maskable-v2-192.png", "maskable-v2-512.png"]) {
    const png = decodeRgbaPng(await fs.readFile(path.join(directory, name)));
    assert.deepEqual(Array.from(png.pixels.subarray(0, 4)), [11, 13, 14, 255], name + " has a square dark plate");
    for (let offset = 3; offset < png.pixels.length; offset += 4) assert.equal(png.pixels[offset], 255);
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
        assert.doesNotMatch(csp, /sha256-/);
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
    for (const route of ["/api/projects", "/api/workspaces", "/public/branding/site.webmanifest", "/brand/split-k/web/social-brand-v2.png", "/favicon-theme.js%2f..%2fapi%2fprojects", "/favicon.svg%2f..%2fapi%2fprojects", "/favicon-v2.svg%2f..%2fapi%2fprojects", "/%2e%2e%2fapi%2fprojects", "/social-brand-v2.png/../api/projects"]) {
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
