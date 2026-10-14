import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BRAND_LOCKUP_ASSETS, renderProductName } from "../src/brand";
import { createFileAccessStore } from "../src/access-store";
import { createApp } from "../src/server";
import { createWorkspaceStoreResolver } from "../src/state-store";

test("the static loading shell and shared product renderer use one accessible theme-aware lockup", async () => {
  const markup = renderProductName("strong");
  const html = await fs.readFile(path.resolve(__dirname, "../index.html"), "utf8");
  assert.ok(html.includes(markup));
  assert.equal((markup.match(/alt="kanban.cards"/g) || []).length, 1);
  assert.match(markup, /media="\(prefers-color-scheme: dark\)" srcset="\/brand-lockup-dark.svg"/);
  assert.doesNotMatch(markup, />kanban\.cards</);
});

test("canonical lockups load before sign-in on root, auth, and Workspace hosts through exact public GET paths", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-lockup-routing-"));
  const root = path.resolve(__dirname, "..");
  const server = createServer(createApp({
    host: "board.localhost", rootHost: "board.localhost", staticDir: root, requireDatabase: false,
    dataPath: path.join(directory, "data.json"),
    accessStore: createFileAccessStore(path.join(directory, "access.json")),
    workspaceStoreResolver: createWorkspaceStoreResolver({ dataPath: path.join(directory, "data.json"), workspaceDirectory: path.join(directory, "workspaces") }),
    passkeyAuthConfig: {
      authHost: "auth.board.localhost", authOrigin: "http://auth.board.localhost", rpId: "auth.board.localhost",
      rootOrigins: ["http://board.localhost"], sessionSecret: "canonical-lockup-test-secret-at-least-32-characters", sessionTtlSeconds: 3600
    }
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const host of ["board.localhost", "auth.board.localhost", "sample.board.localhost"]) {
      for (const [index, [route, output]] of BRAND_LOCKUP_ASSETS.entries()) {
        const canonical = index === 0 ? "horizontal.svg" : "horizontal-reversed.svg";
        const expected = await fs.readFile(path.join(root, "brand/split-k/lockups", canonical));
        assert.deepEqual(await fs.readFile(path.join(root, output)), expected, "Build output preserves the canonical source bytes");
        const response = await fetch(base + route, { headers: { Host: host } });
        assert.equal(response.status, 200, host + route);
        assert.match(response.headers.get("content-type") || "", /^image\/svg\+xml/);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.doesNotMatch(response.headers.get("content-security-policy") || "", /unsafe-inline/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        const head = await fetch(base + route, { method: "HEAD", headers: { Host: host } });
        assert.equal(head.status, 200);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
      }
    }
    for (const route of ["/public/branding/brand-lockup.svg", "/brand/split-k/lockups/horizontal.svg", "/api/projects", "/api/workspaces"]) {
      assert.equal((await fetch(base + route, { headers: { Host: "auth.board.localhost" } })).status, 404, route);
    }
    for (const [route] of BRAND_LOCKUP_ASSETS) {
      assert.equal((await fetch(base + route, { method: "POST", headers: { Host: "auth.board.localhost" } })).status, 404);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
