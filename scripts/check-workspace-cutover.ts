import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { authorizePromotion, evaluateCutoverSnapshot, inspectCandidateFirewall, isVercelSsoProtectionRedirect, trustedReleaseTarget, unexpectedDeployableApplicationChanges, type CutoverPhase } from "../src/release-gate";
import { mainGitDeploymentsAreDisabled } from "../src/release-policy";
import { parseReleaseControllerArguments } from "../src/release-controller";

const run = promisify(execFile);

async function main(): Promise<void> {
  const args = parseReleaseControllerArguments(process.argv.slice(2));
  const snapshotPath = path.resolve(process.cwd(), args.snapshotPath);
  let snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as unknown;
  if (args.live) snapshot = await hydrateWithLiveFacts(snapshot, args.phase);
  const evaluation = args.authorizePromotion
    ? authorizePromotion(snapshot, args.confirmation)
    : evaluateCutoverSnapshot(snapshot, args.phase);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ok) {
    process.exitCode = 1;
    return;
  }
  if (args.promote) {
    const root = record(snapshot);
    const predecessor = deploymentIdentity(record(root.currentProduction));
    const promotionReceipt = {
      candidateDeploymentId: evaluation.candidate.deploymentId,
      candidateUrl: evaluation.candidate.url,
      candidateCommitSha: evaluation.candidate.commitSha,
      rollbackTarget: { ...predecessor, verified: record(root.rollbackTarget).verified === true },
      authorizedAt: new Date().toISOString()
    } as Record<string, unknown>;
    root.promotionReceipt = promotionReceipt;
    await writeSnapshotAtomic(snapshotPath, root);
    await runVercelPromotion(evaluation.candidate.deploymentId);
    promotionReceipt.promotedAt = new Date().toISOString();
    await writeSnapshotAtomic(snapshotPath, root);
    process.stdout.write(`${JSON.stringify({ promotedDeploymentId: evaluation.candidate.deploymentId })}\n`);
  }
}

async function runVercelPromotion(deploymentId: string): Promise<void> {
  await run("vercel", ["promote", deploymentId], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

async function hydrateWithLiveFacts(snapshot: unknown, phase: CutoverPhase): Promise<unknown> {
  const root = structuredClone(record(snapshot));
  const target = trustedReleaseTarget();
  const candidateInput = record(root.candidate);
  const candidateId = stringValue(candidateInput.id);
  if (!candidateId) throw new Error("Live verification requires candidate.id in the evidence record.");

  const [statusResult, branchResult, headResult] = await Promise.all([
    run("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" }),
    run("git", ["branch", "--show-current"], { cwd: process.cwd(), encoding: "utf8" }),
    run("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" })
  ]);
  if (statusResult.stdout.trim()) throw new Error("Live authorization requires a clean checkout.");
  if (branchResult.stdout.trim() !== target.productionBranch) throw new Error(`Live authorization requires the ${target.productionBranch} branch.`);

  const vercelConfig = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "vercel.json"), "utf8")) as Record<string, unknown>;
  const [project, firewallOverview, aliases, candidate, currentSummary] = await Promise.all([
    vercelJson(["api", `/v9/projects/${target.projectId}`]),
    vercelJson(["firewall", "overview", "--json"]),
    listAllAliases(),
    vercelJson(["api", `/v13/deployments/${candidateId}`]),
    vercelJson(["inspect", `https://${target.publicDomain}`, "--format=json"])
  ]);
  const firewall = normalizeFirewallOverview(firewallOverview);
  const currentId = stringValue(currentSummary.id);
  if (!currentId) throw new Error("Live verification could not resolve the deployment serving the public domain.");
  const current = await vercelJson(["api", `/v13/deployments/${currentId}`]);
  const liveCandidate = deploymentRecord(candidate);
  const candidateSha = stringValue(liveCandidate.commitSha);
  const headSha = headResult.stdout.trim();
  if (candidateSha !== headSha) {
    const delta = await run("git", ["diff", "--name-only", "--no-renames", candidateSha, headSha, "--"], { cwd: process.cwd(), encoding: "utf8" });
    const applicationChanges = unexpectedDeployableApplicationChanges(delta.stdout.split("\n"));
    if (applicationChanges.length) throw new Error(`Live candidate differs from the validated application closure: ${applicationChanges.join(", ")}`);
  }
  const projectLink = record(project.link);
  const protection = record(project.ssoProtection);
  const localRules = record(record(vercelConfig.git).deploymentEnabled);
  root.policy = {
    projectId: stringValue(project.id),
    teamId: stringValue(project.accountId),
    repository: `${stringValue(projectLink.org)}/${stringValue(projectLink.repo)}`,
    productionBranch: stringValue(projectLink.productionBranch),
    autoAssignCustomDomains: project.autoAssignCustomDomains,
    mainGitDeploymentsEnabled: !mainGitDeploymentsAreDisabled(localRules),
    deploymentProtection: stringValue(protection.deploymentType),
    firewall,
    aliases,
    aliasInventoryComplete: true
  };
  root.candidate = liveCandidate;
  const liveCurrent = deploymentRecord(current);
  const currentHealth = phase === "pre-promotion"
    ? await vercelRuntimeJson(stringValue(liveCurrent.url), "/api/health")
    : await publicJson(`https://${target.publicDomain}/api/health`);
  root.currentProduction = { ...liveCurrent, health: currentHealth };

  const evidence = record(root.evidence);
  const phaseKey = phase === "pre-promotion" ? "prePromotion" : "postPromotion";
  const receipt = record(evidence[phaseKey]);
  const proofOrigin = stringValue(receipt.origin);
  const authOrigin = stringValue(receipt.authOrigin);
  const tenantOrigin = stringValue(receipt.tenantOrigin);
  if (!proofOrigin) throw new Error(`Live verification requires evidence.${phaseKey}.origin.`);
  if (!authOrigin) throw new Error(`Live verification requires evidence.${phaseKey}.authOrigin.`);
  if (!tenantOrigin) throw new Error(`Live verification requires evidence.${phaseKey}.tenantOrigin.`);
  const [routed, authRouted, tenantRouted] = await Promise.all([
    vercelJson(["inspect", proofOrigin, "--format=json"]),
    vercelJson(["inspect", authOrigin, "--format=json"]),
    vercelJson(["inspect", tenantOrigin, "--format=json"])
  ]);
  receipt.routeDeploymentId = stringValue(routed.id);
  receipt.routePinned = receipt.routeDeploymentId === candidateId ? "passed" : "failed";
  receipt.authRouteDeploymentId = stringValue(authRouted.id);
  receipt.authRoutePinned = receipt.authRouteDeploymentId === candidateId ? "passed" : "failed";
  receipt.sameArtifactAuthHost = receipt.authRoutePinned;
  receipt.tenantRouteDeploymentId = stringValue(tenantRouted.id);
  receipt.tenantRoutePinned = receipt.tenantRouteDeploymentId === candidateId ? "passed" : "failed";
  const firewallFacts = inspectCandidateFirewall(firewall, target);
  const firewallProof = record(receipt.firewallProof);
  if (phase === "post-promotion") {
    const [rootObservation, authObservation, tenantObservation, generatedProtected] = await Promise.all([
      routeObservation(proofOrigin, "/api/health"),
      routeObservation(authOrigin, "/sign-in"),
      routeObservation(tenantOrigin, "/"),
      unauthenticatedRouteIsProtected(stringValue(liveCandidate.url))
    ]);
    firewallProof.releaseRulesRemoved = firewallFacts.releaseRulesAbsent ? "passed" : "failed";
    firewallProof.authHostPublic = authObservation.status === 200 && authObservation.mitigated === "none" ? "passed" : "failed";
    firewallProof.canonicalRootPublic = rootObservation.status === 200 && rootObservation.ok === true && rootObservation.store === "postgres" && rootObservation.mitigated === "none" ? "passed" : "failed";
    firewallProof.canonicalTenantPublic = Number.isInteger(tenantObservation.status) && Number(tenantObservation.status) >= 200 && Number(tenantObservation.status) < 400 && tenantObservation.mitigated === "none" ? "passed" : "failed";
    firewallProof.generatedDeploymentProtected = generatedProtected ? "passed" : "failed";
  }
  receipt.firewallProof = firewallProof;
  const runtimeOrigin = phase === "pre-promotion" ? stringValue(record(root.candidate).url) : `https://${target.publicDomain}`;
  const [health, accessHealth] = phase === "pre-promotion"
    ? await Promise.all([vercelRuntimeJson(runtimeOrigin, "/api/health"), vercelRuntimeJson(runtimeOrigin, "/api/access/health")])
    : await Promise.all([publicJson(`${runtimeOrigin}/api/health`), publicJson(`${runtimeOrigin}/api/access/health`)]);
  receipt.health = health;
  receipt.accessHealth = accessHealth;
  evidence[phaseKey] = receipt;
  root.evidence = evidence;
  if (phase === "post-promotion") {
    const promotionReceipt = record(root.promotionReceipt);
    const recordedRollback = record(promotionReceipt.rollbackTarget);
    const rollbackId = stringValue(recordedRollback.id);
    if (!rollbackId) throw new Error("Post-promotion live verification requires the controller-generated predecessor receipt.");
    root.originalRollbackTarget = { ...deploymentRecord(await vercelJson(["api", `/v13/deployments/${rollbackId}`])), verified: recordedRollback.verified };
  }
  return root;
}

function deploymentRecord(value: Record<string, unknown>): Record<string, unknown> {
  const gitSource = record(value.gitSource);
  const meta = record(value.meta);
  const project = record(value.project);
  return {
    id: stringValue(value.id),
    url: canonicalUrl(value.url),
    projectId: stringValue(value.projectId) || stringValue(project.id),
    commitSha: stringValue(gitSource.sha) || stringValue(meta.githubCommitSha),
    commitRef: stringValue(gitSource.ref) || stringValue(meta.githubCommitRef),
    target: stringValue(value.target),
    readyState: stringValue(value.readyState),
    aliases: stringArray(value.alias ?? value.aliases)
  };
}

function deploymentIdentity(value: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stringValue(value.id),
    url: canonicalUrl(value.url),
    projectId: stringValue(value.projectId),
    commitSha: stringValue(value.commitSha),
    target: stringValue(value.target),
    readyState: stringValue(value.readyState)
  };
}

async function writeSnapshotAtomic(snapshotPath: string, snapshot: Record<string, unknown>): Promise<void> {
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, snapshotPath);
}

async function vercelJson(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run("vercel", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return record(JSON.parse(stdout));
}

async function listAllAliases(): Promise<string[]> {
  const aliases: string[] = [];
  let next: number | null = null;
  do {
    const args = ["alias", "ls", "--format=json", "--limit", "100"];
    if (next !== null) args.push("--next", String(next));
    const page = await vercelJson(args);
    for (const entry of Array.isArray(page.aliases) ? page.aliases : []) {
      const alias = stringValue(record(entry).alias);
      if (alias) aliases.push(alias);
    }
    const nextValue = record(page.pagination).next;
    next = typeof nextValue === "number" && Number.isFinite(nextValue) ? nextValue : null;
  } while (next !== null);
  return [...new Set(aliases)].sort();
}

function normalizeFirewallOverview(overview: Record<string, unknown>): Record<string, unknown> {
  const active = record(overview.active);
  const draft = record(overview.draft);
  const changes = Array.isArray(draft.changes) ? draft.changes : [];
  const rules = (Array.isArray(active.rules) ? active.rules : []).map((rule) => ({ ...record(rule), _status: "live" }));
  return {
    firewallEnabled: active.firewallEnabled === true,
    rules,
    hasDraft: changes.length > 0,
    pendingChanges: changes.length
  };
}

async function vercelRuntimeJson(deploymentUrl: string, pathname: string): Promise<Record<string, unknown>> {
  const { stdout } = await run("vercel", ["curl", pathname, "--deployment", deploymentUrl, "--", "--silent", "--show-error", "--write-out", "\n%{http_code}"], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024
  });
  const splitAt = stdout.lastIndexOf("\n");
  if (splitAt < 0) throw new Error(`Live ${pathname} response did not include an HTTP status.`);
  const body = record(JSON.parse(stdout.slice(0, splitAt)));
  body.status = Number(stdout.slice(splitAt + 1).trim());
  return body;
}

async function publicJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error" });
  const body = record(await response.json());
  body.status = response.status;
  return body;
}

async function unauthenticatedRouteIsProtected(origin: string): Promise<boolean> {
  // A nonce path prevents an application-level root redirect from masquerading as
  // platform protection. Live hydration also corroborates this response with the
  // Vercel Project protection policy and an exact route-to-deployment inspection.
  const probeUrl = new URL(`/__kanban_cards_protection_probe__/${randomUUID()}`, origin).href;
  const response = await fetch(probeUrl, { cache: "no-store", redirect: "manual" });
  return isVercelSsoProtectionRedirect(
    response.status,
    response.headers.get("location"),
    probeUrl,
    response.headers.get("set-cookie")
  );
}

async function routeObservation(origin: string, pathname: string): Promise<Record<string, unknown>> {
  const probeUrl = new URL(pathname, origin).href;
  const response = await fetch(probeUrl, { cache: "no-store", redirect: "manual" });
  const contentType = response.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    try { body = record(await response.json()); } catch { body = {}; }
  }
  return {
    status: response.status,
    mitigated: response.headers.get("x-vercel-mitigated") ?? "none",
    vercelId: response.headers.get("x-vercel-id") ?? "",
    ok: body.ok,
    store: body.store
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function canonicalUrl(value: unknown): string { const raw = stringValue(value); return raw ? (raw.startsWith("https://") ? raw : `https://${raw}`) : ""; }

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
