import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { hashSecret } from "../src/passkey-auth";

async function main() {
  const args = process.argv.slice(2);
  let ownerId = "";
  let output = path.join(process.cwd(), ".local", "owner-setup.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--owner") ownerId = args[++i] || "";
    else if (args[i] === "--out") output = path.resolve(args[++i] || "");
    else throw new Error("Usage: npm run auth:setup -- --owner <existing-owner-id> [--out <local-file>]");
  }
  if (!/^owner-[A-Za-z0-9-]+$/.test(ownerId)) throw new Error("Supply the exact existing owner ID, not an email or provider user ID.");
  const forbidden = ["/Documents/", "/Desktop/", "/Library/Mobile Documents/", "/Library/CloudStorage/"];
  if (forbidden.some(segment => output.includes(segment))) throw new Error("Choose a local output path outside synced Documents, Desktop, or cloud folders.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await fs.writeFile(output, JSON.stringify({ ownerId, setupToken: token, expiresAt }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(JSON.stringify({ secretFile: output, environment: { KANBAN_CARDS_SETUP_OWNER_ID: ownerId, KANBAN_CARDS_SETUP_TOKEN_HASH: hashSecret(token), KANBAN_CARDS_SETUP_EXPIRES_AT: expiresAt } }, null, 2) + "\n");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Setup generation failed."); process.exitCode = 1; });
