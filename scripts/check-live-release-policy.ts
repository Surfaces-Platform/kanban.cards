import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { mainGitDeploymentsAreDisabled } from "../src/release-policy";

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

  const { stdout } = await run("vercel", ["api", `/v9/projects/${projectId}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  const project = JSON.parse(stdout) as Record<string, unknown>;
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
    deploymentProtection: stringValue(protection.deploymentType)
  };
  const failures = [
    [policy.projectId === projectId, "linked Project id mismatch"],
    [policy.teamId === teamId, "linked team id mismatch"],
    [policy.repository === "Surfaces-Platform/kanban.cards", "linked GitHub repository mismatch"],
    [policy.productionBranch === "main", "production branch is not main"],
    [policy.autoAssignCustomDomains === false, "Auto-assign Custom Production Domains is enabled"],
    [policy.mainGitDeploymentsEnabled === false, "automatic deployments from main are enabled"],
    [new Set(["all_except_custom_domains", "all"]).has(policy.deploymentProtection), "generated candidates are not protected"]
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
