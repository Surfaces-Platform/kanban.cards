import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashSecret } from "../src/passkey-auth";

const script = path.resolve("dist/scripts/create-owner-setup.js");

test("owner setup writes its one-hour secret only to a private local file and never overwrites it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-owner-setup-"));
  const output = path.join(directory, "private", "setup.json");
  try {
    const before = Date.now();
    const stdout = execFileSync(process.execPath, [script, "--owner", "owner-existing", "--out", output], { encoding: "utf8" });
    const result = JSON.parse(stdout);
    const contents = await fs.readFile(output, "utf8");
    const saved = JSON.parse(contents);
    assert.equal(saved.ownerId, "owner-existing");
    assert.match(saved.setupToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.environment.KANBAN_CARDS_SETUP_OWNER_ID, saved.ownerId);
    assert.equal(result.environment.KANBAN_CARDS_SETUP_TOKEN_HASH, hashSecret(saved.setupToken));
    assert.equal(result.environment.KANBAN_CARDS_SETUP_EXPIRES_AT, saved.expiresAt);
    assert.equal(stdout.includes(saved.setupToken), false);
    assert.ok(Date.parse(saved.expiresAt) >= before + 3_600_000);
    assert.ok(Date.parse(saved.expiresAt) <= Date.now() + 3_600_000);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(output))).mode & 0o777, 0o700);
    assert.throws(() => execFileSync(process.execPath, [script, "--owner", "owner-other", "--out", output], { stdio: "pipe" }), /EEXIST/);
    assert.equal(await fs.readFile(output, "utf8"), contents);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("owner setup rejects provider identities and synced output destinations", async () => {
  for (const owner of ["user_provider", "mike@example.com", ""]) {
    assert.throws(() => execFileSync(process.execPath, [script, "--owner", owner], { stdio: "pipe" }), /exact existing owner ID/);
  }
  assert.throws(() => execFileSync(process.execPath, [script, "--owner", "owner-existing", "--out", "/Users/mike/Documents/Codex/setup.json"], { stdio: "pipe" }), /outside synced/);
});
