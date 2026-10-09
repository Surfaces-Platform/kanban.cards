import fs from "node:fs/promises";
import path from "node:path";

import { mainGitDeploymentsAreEnabled } from "../src/release-policy";

interface Violation {
  file: string;
  reason: string;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  const [vercelSource, runbook, readme] = await Promise.all([
    fs.readFile(path.join(root, "vercel.json"), "utf8"),
    fs.readFile(path.join(root, "docs/runbook.md"), "utf8"),
    fs.readFile(path.join(root, "README.md"), "utf8")
  ]);
  const vercel = JSON.parse(vercelSource) as Record<string, unknown>;
  const git = record(vercel.git);
  const deploymentEnabled = git.deploymentEnabled;
  const github = record(vercel.github);
  const violations: Violation[] = [];

  if (!mainGitDeploymentsAreEnabled(deploymentEnabled)) {
    violations.push({
      file: "vercel.json",
      reason: "Git deployments from main must be enabled so a merge creates the staged production artifact"
    });
  }
  if (Object.hasOwn(github, "autoAlias")) {
    violations.push({
      file: "vercel.json",
      reason: "github.autoAlias must stay absent; merged staged deployments require Production environment values"
    });
  }
  for (const requiredText of [
    "Auto-assign Custom Production Domains",
    "Fast lane: ordinary product changes",
    "Sensitive lane: auth, authorization, and data boundaries",
    "all_except_custom_domains",
    "npm run release:preflight",
    "npm run release:promote",
    "PROMOTE EXACT VERIFIED CANDIDATE",
    "passkey",
    "scoped API key"
  ]) {
    if (!runbook.includes(requiredText)) {
      violations.push({ file: "docs/runbook.md", reason: `missing release boundary: ${requiredText}` });
    }
  }
  for (const obsoleteText of ["All Deployments", "Project policy must be All Deployments", "complete Vercel Authentication on all three"]) {
    if (runbook.includes(obsoleteText)) violations.push({ file: "docs/runbook.md", reason: `obsolete paid candidate-protection path remains: ${obsoleteText}` });
  }
  for (const requiredText of ["npm run release:preflight", "npm run release:promote -- --deployment", "Auto-assign Custom Production Domains"]) {
    if (!readme.includes(requiredText)) violations.push({ file: "README.md", reason: `missing steady release boundary: ${requiredText}` });
  }
  for (const obsoleteText of ["Automatic Vercel deployments from `main` are disabled", "npm run release:gate"]) {
    if (readme.includes(obsoleteText)) violations.push({ file: "README.md", reason: `obsolete release path remains: ${obsoleteText}` });
  }

  if (violations.length) {
    console.error("Release-policy violations found:");
    for (const violation of violations) console.error(`- ${violation.file}: ${violation.reason}`);
    process.exit(1);
  }
  console.log("Steady-state and sensitive release policy check passed.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
