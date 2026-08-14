import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { mainGitDeploymentsAreDisabled } from "../src/release-policy";
import { inspectCandidateFirewall } from "../src/release-gate";

const run = promisify(execFile);

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  const [linkSource, vercelSource] = await Promise.all([
    fs.readFile(path.join(root, ".vercel/project.json"), "utf8"),
    fs.readFile(path.join(root, "vercel.json"), "utf8")
  ]);
  const link = JSON.parse(linkSource) as Record<string, unknown>;
  const vercel = JSON.parse(vercelSource) as Record<string, unknown>;
  const projectId = stringValue(link.projectId);
  const teamId = stringValue(link.orgId);
  if (!projectId || !teamId) throw new Error("The local Vercel link is missing its Project or team id.");

  const [projectResult, firewallResult] = await Promise.all([
    run("vercel", ["api", `/v9/projects/${projectId}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
    run("vercel", ["firewall", "overview", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  ]);
  const project = JSON.parse(projectResult.stdout) as Record<string, unknown>;
  const firewallOverview = JSON.parse(firewallResult.stdout) as Record<string, unknown>;
  const activeFirewall = record(firewallOverview.active);
  const draftFirewall = record(firewallOverview.draft);
  const draftChanges = Array.isArray(draftFirewall.changes) ? draftFirewall.changes : [];
  const firewall = {
    firewallEnabled: activeFirewall.firewallEnabled === true,
    rules: (Array.isArray(activeFirewall.rules) ? activeFirewall.rules : []).map((rule) => ({ ...record(rule), _status: "live" })),
    hasDraft: draftChanges.length > 0,
    pendingChanges: draftChanges.length
  };
  const firewallFacts = inspectCandidateFirewall(firewall);
  const remoteLink = record(project.link);
  const protection = record(project.ssoProtection);
  const localGit = record(vercel.git);
  const localDeployments = record(localGit.deploymentEnabled);
  const policy = {
    projectId: stringValue(project.id),
    teamId: stringValue(project.accountId),
    repository: `${stringValue(remoteLink.org)}/${stringValue(remoteLink.repo)}`,
    productionBranch: stringValue(remoteLink.productionBranch),
    autoAssignCustomDomains: project.autoAssignCustomDomains,
    mainGitDeploymentsEnabled: !mainGitDeploymentsAreDisabled(localDeployments),
    deploymentProtection: stringValue(protection.deploymentType),
    firewall: firewallFacts
  };
  const failures = [
    [policy.projectId === projectId, "linked Project id mismatch"],
    [policy.teamId === teamId, "linked team id mismatch"],
    [policy.repository === "Surfaces-Platform/kanban.cards", "linked GitHub repository mismatch"],
    [policy.productionBranch === "main", "production branch is not main"],
    [policy.autoAssignCustomDomains === false, "Auto-assign Custom Production Domains is enabled"],
    [policy.mainGitDeploymentsEnabled === false, "automatic deployments from main are enabled"],
    [policy.deploymentProtection === "all_except_custom_domains", "Standard Protection is not enabled"],
    [firewallFacts.firewallEnabled, "Vercel Firewall is disabled"],
    [!firewallFacts.hasDraft && firewallFacts.pendingChanges === 0, "Vercel Firewall has unpublished changes"],
    [firewallFacts.releaseRulesAbsent || (firewallFacts.bypassReady && firewallFacts.denyReady), "temporary candidate Firewall rules are partial or malformed"]
  ].filter(([passed]) => !passed).map(([, reason]) => reason);

  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, policy, failures }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
