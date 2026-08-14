import fs from "node:fs/promises";
import path from "node:path";

import { mainGitDeploymentsAreDisabled } from "../src/release-policy";

interface Violation {
  file: string;
  reason: string;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  const [vercelSource, runbook] = await Promise.all([
    fs.readFile(path.join(root, "vercel.json"), "utf8"),
    fs.readFile(path.join(root, "docs/runbook.md"), "utf8")
  ]);
  const vercel = JSON.parse(vercelSource) as Record<string, unknown>;
  const git = record(vercel.git);
  const deploymentEnabled = record(git.deploymentEnabled);
  const github = record(vercel.github);
  const violations: Violation[] = [];

  if (!mainGitDeploymentsAreDisabled(deploymentEnabled)) {
    violations.push({
      file: "vercel.json",
      reason: "git.deploymentEnabled.main must be false so a main merge cannot create or promote a production deployment"
    });
  }
  if (Object.hasOwn(github, "autoAlias")) {
    violations.push({
      file: "vercel.json",
      reason: "github.autoAlias must stay absent; merged candidates require production environment values and explicit --skip-domain deployment"
    });
  }
  for (const requiredText of [
    "Auto-assign Custom Production Domains",
    "vercel deploy --prod --skip-domain",
    "all_except_custom_domains",
    "kanban-candidate-mike-bypass",
    "kanban-candidate-deny",
    "vercel firewall publish --yes",
    "npm run release:gate -- --snapshot",
    "PROMOTE EXACT VERIFIED CANDIDATE",
    "--authorize-promotion --confirmation \"$KANBAN_CARDS_PROMOTION_CONFIRMATION\" --promote"
  ]) {
    if (!runbook.includes(requiredText)) {
      violations.push({ file: "docs/runbook.md", reason: `missing release boundary: ${requiredText}` });
    }
  }
  for (const obsoleteText of ["All Deployments", "Project policy must be All Deployments", "complete Vercel Authentication on all three"]) {
    if (runbook.includes(obsoleteText)) violations.push({ file: "docs/runbook.md", reason: `obsolete paid candidate-protection path remains: ${obsoleteText}` });
  }

  if (violations.length) {
    console.error("Workspace cutover release-policy violations found:");
    for (const violation of violations) console.error(`- ${violation.file}: ${violation.reason}`);
    process.exit(1);
  }
  console.log("Workspace cutover release policy check passed.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
