#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const check = process.argv.includes("--check");
const source = path.join(root, ".agents/skills/kanban-cards");
const destination = path.join(root, "plugins/kanban-cards");
const manifest = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "kanban-cards",
  version: "0.1.0",
  description: "Connect Codex to Kanban.cards with native approval, then track and complete Project work.",
  author: { name: "Kanban.cards", url: "https://kanban.cards" },
  homepage: "https://kanban.cards",
  repository: "https://github.com/Surfaces-Platform/kanban.cards",
  keywords: ["kanban", "project", "cards"],
  extensions: { "com.openai": {
    onboardingSkill: "./skills/setup/SKILL.md",
    interface: {
      displayName: "Kanban.cards",
      shortDescription: "Connect Codex and keep Project Cards up to date",
      longDescription: "Approve Workspace access in the Kanban.cards app, then use Codex to carry out bounded Project work and keep Cards up to date. Requires an execution host with Node.js and network access.",
      developerName: "Kanban.cards",
      category: "Productivity",
      capabilities: ["Read", "Write"],
      websiteURL: "https://kanban.cards",
      defaultPrompt: ["Use Kanban.cards to connect this Project with native approval, then read its Idea and Cards and carry out the authorized work."]
    }
  } }
};
const marketplace = {
  name: "kanban-cards",
  interface: { displayName: "Kanban.cards" },
  plugins: [{ name: "kanban-cards", source: { source: "local", path: "./plugins/kanban-cards" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }]
};
const files = ["SKILL.md", "agents/openai.yaml", "references/api.md", "references/codex-install.md", "scripts/kanban-cards-client.mjs"];
const expected = new Map();
for (const name of files) expected.set(path.join(destination, "skills/kanban-cards", name), await fs.readFile(path.join(source, name)));
expected.set(path.join(destination, "skills/setup/SKILL.md"), await fs.readFile(path.join(source, "references/setup-skill.md")));
expected.set(path.join(destination, "plugin.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
expected.set(path.join(root, ".agents/plugins/marketplace.json"), Buffer.from(JSON.stringify(marketplace, null, 2) + "\n"));
for (const [file, bytes] of expected) {
  if (check) {
    const actual = await fs.readFile(file).catch(() => undefined);
    if (!actual || !actual.equals(bytes)) throw new Error(`Plugin package is stale: ${path.relative(root, file)}`);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes, { mode: file.endsWith(".mjs") ? 0o755 : 0o644 });
  }
}
process.stdout.write(check ? "Codex plugin package matches its skill and helper sources.\n" : "Assembled Codex plugin and repository marketplace.\n");
