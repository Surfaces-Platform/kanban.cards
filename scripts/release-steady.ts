import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { PROMOTION_CONFIRMATION, isVercelSsoProtectionRedirect, trustedReleaseTarget, type TrustedReleaseTarget } from "../src/release-gate";
import { mainGitDeploymentsAreEnabled, verifiedProductionDomainNames } from "../src/release-policy";

const run = promisify(execFile);

export interface SteadyReleaseArguments {
  deploymentId: string;
  promote: boolean;
  confirmation: string;
}

export interface SteadyReleaseBlocker {
  code: string;
  message: string;
}

export interface SteadyReleaseEvaluation {
  phase: "pre-promotion" | "post-promotion";
  ok: boolean;
  blockers: SteadyReleaseBlocker[];
  deploymentId: string;
  commitSha: string;
  candidate: SteadyDeploymentReceipt;
  rollbackTarget: SteadyDeploymentReceipt;
}

export interface SteadyDeploymentReceipt {
  id: string;
  url: string;
  commitSha: string;
  commitRef: string;
  target: string;
  readyState: string;
  source: string;
  repository: string;
}

export function parseSteadyReleaseArguments(argv: string[]): SteadyReleaseArguments {
  let deploymentId = "";
  let promote = false;
  let confirmation = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--deployment") deploymentId = argv[++index] || "";
    else if (argument === "--promote") promote = true;
    else if (argument === "--confirmation") confirmation = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (promote && confirmation !== PROMOTION_CONFIRMATION) {
    throw new Error(`--promote requires the literal confirmation: ${PROMOTION_CONFIRMATION}`);
  }
  if (deploymentId && !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error("--deployment must be an exact Vercel deployment id beginning with dpl_.");
  if (promote && !deploymentId) throw new Error("--promote requires the exact --deployment id emitted by release:preflight.");
  return { deploymentId, promote, confirmation };
}

export function evaluateSteadyRelease(
  facts: unknown,
  phase: "pre-promotion" | "post-promotion",
  target: TrustedReleaseTarget = trustedReleaseTarget()
): SteadyReleaseEvaluation {
  const root = record(facts);
  const checkout = record(root.checkout);
  const policy = record(root.policy);
  const candidate = record(root.candidate);
  const current = record(root.currentProduction);
  const candidateHealth = record(root.candidateHealth);
  const candidateAccess = record(root.candidateAccessHealth);
  const publicHealth = record(root.publicHealth);
  const publicAccess = record(root.publicAccessHealth);
  const routes = record(root.routes);
  const blockers: SteadyReleaseBlocker[] = [];
  const deploymentId = text(candidate.id);
  const commitSha = text(candidate.commitSha);
  const candidateReceipt = deploymentReceipt(candidate);
  const rollbackTarget = deploymentReceipt(phase === "pre-promotion" ? current : record(root.rollbackTarget));
  const domains = new Set(verifiedProductionDomainNames(policy.domains));
  const expectedDomains = [target.publicDomain, target.authDomain, `mike.${target.publicDomain}`];

  addUnless(blockers, checkout.clean === true, "checkout-dirty", "Steady release requires a clean checkout.");
  addUnless(blockers, text(checkout.branch) === target.productionBranch, "checkout-branch", `Steady release requires the ${target.productionBranch} branch.`);
  addUnless(blockers, text(checkout.sha) === commitSha, "checkout-sha", "The staged deployment must carry the exact checked-out commit SHA.");
  addUnless(blockers, text(policy.projectId) === target.projectId, "project-id", "Vercel Project id mismatch.");
  addUnless(blockers, text(policy.teamId) === target.teamId, "team-id", "Vercel team id mismatch.");
  addUnless(blockers, text(policy.repository) === target.repository, "repository", "Linked repository mismatch.");
  addUnless(blockers, text(policy.productionBranch) === target.productionBranch, "production-branch", "Vercel production branch mismatch.");
  addUnless(blockers, policy.autoAssignCustomDomains === false, "auto-domain-assignment", "Auto-assign Custom Production Domains must remain disabled so merge and promotion stay separate.");
  addUnless(blockers, policy.mainGitDeploymentsEnabled === true, "main-builds-disabled", "Git deployments from main must be enabled so a merge creates the staged production artifact.");
  addUnless(blockers, text(policy.deploymentProtection) === "all_except_custom_domains", "deployment-protection", "Generated deployments must remain protected while custom production domains stay public.");
  for (const domain of expectedDomains) addUnless(blockers, domains.has(domain), `domain-${domain}`, `${domain} must be a verified custom Production Domain.`);

  addUnless(blockers, /^dpl_[A-Za-z0-9]+$/.test(deploymentId), "deployment-id", "An exact staged deployment id is required.");
  addUnless(blockers, text(candidate.projectId) === target.projectId, "candidate-project", "Candidate Project id mismatch.");
  addUnless(blockers, text(candidate.source) === "git", "candidate-source", "Candidate must be created by the Vercel Git integration, not a CLI or dashboard redeploy.");
  addUnless(blockers, text(candidate.repository) === target.repository, "candidate-repository", "Candidate Git repository mismatch.");
  addUnless(blockers, candidate.gitDirty !== true, "candidate-dirty", "Candidate metadata reports a dirty source checkout.");
  addUnless(blockers, text(candidate.commitRef) === target.productionBranch, "candidate-ref", "Candidate must come from main.");
  addUnless(blockers, text(candidate.target) === "production", "candidate-target", "Candidate must use the Production environment.");
  addUnless(blockers, text(candidate.readyState) === "READY", "candidate-ready", "Candidate must be READY.");
  addUnless(blockers, /^[0-9a-f]{40}$/i.test(commitSha), "candidate-sha", "Candidate must carry a full Git SHA.");
  addUnless(blockers, isGeneratedDeploymentUrl(candidate.url, target.publicDomain), "candidate-url", "Candidate must use an immutable generated deployment URL.");
  addUnless(blockers, root.generatedDeploymentProtected === true, "candidate-protection", "The generated deployment URL must remain protected.");
  requireHealth(blockers, candidateHealth, "candidate-health");
  requireAccessHealth(blockers, candidateAccess, "candidate-access");

  if (phase === "pre-promotion") {
    addUnless(blockers, text(current.id) !== deploymentId, "candidate-already-current", "The staged deployment is already serving production.");
    addUnless(blockers, Boolean(text(current.id)) && text(current.readyState) === "READY", "rollback-target", "The current production deployment must remain a READY rollback target.");
    addUnless(blockers, text(current.projectId) === target.projectId, "rollback-project", "Rollback target Project id mismatch.");
    addUnless(blockers, text(current.target) === "production", "rollback-environment", "Rollback target must use the Production environment.");
    addUnless(blockers, /^[0-9a-f]{40}$/i.test(text(current.commitSha)), "rollback-sha", "Rollback target must carry a full Git SHA.");
    addUnless(blockers, isGeneratedDeploymentUrl(current.url, target.publicDomain), "rollback-url", "Rollback target must use an immutable generated deployment URL.");
    requireHealth(blockers, record(current.health), "current-health", false);
    const currentAccess = record(current.accessHealth);
    addUnless(blockers, currentAccess.status === 200 && currentAccess.ok === true && text(currentAccess.registryState) === "ready", "current-access", "Current production must report a ready access registry.");
  } else {
    addUnless(blockers, text(current.id) === deploymentId, "candidate-not-current", "Production does not resolve to the promoted deployment.");
    for (const [name, domain] of [["root", target.publicDomain], ["auth", target.authDomain], ["tenant", `mike.${target.publicDomain}`]] as const) {
      addUnless(blockers, text(record(routes[name]).deploymentId) === deploymentId, `route-${name}`, `${domain} is not pinned to the promoted deployment.`);
    }
    requireHealth(blockers, publicHealth, "public-health");
    requireAccessHealth(blockers, publicAccess, "public-access");
    requirePublicRoute(blockers, record(routes.root), "root-public", 200, 299);
    requirePublicRoute(blockers, record(routes.auth), "auth-public", 200, 299);
    requirePublicRoute(blockers, record(routes.tenant), "tenant-public", 200, 399);
  }

  return { phase, ok: blockers.length === 0, blockers, deploymentId, commitSha, candidate: candidateReceipt, rollbackTarget };
}

async function main(): Promise<void> {
  const args = parseSteadyReleaseArguments(process.argv.slice(2));
  const target = trustedReleaseTarget();
  const preFacts = await hydrateSteadyFacts(args.deploymentId, false, target);
  const alreadyCurrent = text(record(preFacts.currentProduction).id) === text(record(preFacts.candidate).id);
  if (alreadyCurrent) {
    const deploymentId = text(record(preFacts.candidate).id);
    const postFacts = await waitForPromotedRoutes(deploymentId, target);
    postFacts.rollbackTarget = await readPersistedRollbackTarget(deploymentId);
    return finish(evaluateSteadyRelease(postFacts, "post-promotion", target));
  }

  const pre = evaluateSteadyRelease(preFacts, "pre-promotion", target);
  if (!args.promote) return finish(pre);
  if (!pre.ok) return finish(pre);

  const receiptPath = await persistPromotionReceipt(pre);
  process.stderr.write(`Promotion receipt written to ${receiptPath}\n`);
  if (await pendingPromotionExists()) {
    process.stderr.write("A Vercel promotion is already in progress; waiting for it instead of submitting another request.\n");
    await waitForPendingPromotion();
    const resumedFacts = await waitForPromotedRoutes(pre.deploymentId, target);
    resumedFacts.rollbackTarget = pre.rollbackTarget;
    return finish(evaluateSteadyRelease(resumedFacts, "post-promotion", target));
  }

  let promotionError = "";
  try {
    await run("vercel", ["promote", pre.deploymentId, "--timeout=5m"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    promotionError = errorMessage(error);
    process.stderr.write("The promote command did not confirm completion; checking the exact deployment before deciding the outcome.\n");
    await waitForPendingPromotion();
  }
  const postFacts = await waitForPromotedRoutes(pre.deploymentId, target);
  postFacts.rollbackTarget = pre.rollbackTarget;
  const post = evaluateSteadyRelease(postFacts, "post-promotion", target);
  if (promotionError && !post.ok) post.blockers.unshift({ code: "promotion-command", message: promotionError });
  finish(post);
}

async function hydrateSteadyFacts(deploymentId: string, includePublic: boolean, target: TrustedReleaseTarget): Promise<Record<string, unknown>> {
  const root = process.cwd();
  const [statusResult, branchResult, headResult, linkSource, vercelSource] = await Promise.all([
    run("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
    run("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }),
    run("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
    fs.readFile(path.resolve(root, ".vercel/project.json"), "utf8"),
    fs.readFile(path.resolve(root, "vercel.json"), "utf8")
  ]);
  const checkoutSha = headResult.stdout.trim();
  const link = record(JSON.parse(linkSource));
  const vercelConfig = record(JSON.parse(vercelSource));
  const resolvedDeploymentId = deploymentId || await findStagedDeploymentId(target.projectId, checkoutSha, target.productionBranch, target.repository);
  const [project, domainResponse, candidate, currentSummary] = await Promise.all([
    vercelJson(["api", `/v9/projects/${target.projectId}`]),
    vercelJson(["api", `/v9/projects/${target.projectId}/domains`]),
    vercelJson(["api", `/v13/deployments/${resolvedDeploymentId}`]),
    vercelJson(["inspect", `https://${target.publicDomain}`, "--format=json"])
  ]);
  const currentId = text(currentSummary.id);
  if (!currentId) throw new Error("Unable to resolve current production deployment.");
  const current = await vercelJson(["api", `/v13/deployments/${currentId}`]);
  const candidateRecord = deploymentRecord(candidate);
  const currentRecord = deploymentRecord(current);
  const [candidateHealth, candidateAccessHealth, generatedDeploymentProtected, currentHealth, currentAccessHealth] = await Promise.all([
    vercelRuntimeJson(text(candidateRecord.url), "/api/health"),
    vercelRuntimeJson(text(candidateRecord.url), "/api/access/health"),
    unauthenticatedRouteIsProtected(text(candidateRecord.url)),
    vercelRuntimeJson(text(currentRecord.url), "/api/health"),
    vercelRuntimeJson(text(currentRecord.url), "/api/access/health")
  ]);
  const linkRecord = record(project.link);
  const localRules = record(vercelConfig.git).deploymentEnabled;
  const facts: Record<string, unknown> = {
    checkout: { clean: !statusResult.stdout.trim(), branch: branchResult.stdout.trim(), sha: checkoutSha },
    policy: {
      projectId: text(project.id) || text(link.projectId),
      teamId: text(project.accountId) || text(link.orgId),
      repository: `${text(linkRecord.org)}/${text(linkRecord.repo)}`,
      productionBranch: text(linkRecord.productionBranch),
      autoAssignCustomDomains: project.autoAssignCustomDomains,
      mainGitDeploymentsEnabled: mainGitDeploymentsAreEnabled(localRules),
      deploymentProtection: text(record(project.ssoProtection).deploymentType),
      domains: records(domainResponse.domains)
    },
    candidate: candidateRecord,
    currentProduction: { ...currentRecord, health: currentHealth, accessHealth: currentAccessHealth },
    candidateHealth,
    candidateAccessHealth,
    generatedDeploymentProtected
  };
  if (includePublic) Object.assign(facts, await hydratePublicFacts(target));
  return facts;
}

async function hydratePublicFacts(target: TrustedReleaseTarget): Promise<Record<string, unknown>> {
  const rootOrigin = `https://${target.publicDomain}`;
  const authOrigin = `https://${target.authDomain}`;
  const tenantOrigin = `https://mike.${target.publicDomain}`;
  const [rootRoute, authRoute, tenantRoute, publicHealth, publicAccess, authObservation, tenantObservation] = await Promise.all([
    vercelJson(["inspect", rootOrigin, "--format=json"]),
    vercelJson(["inspect", authOrigin, "--format=json"]),
    vercelJson(["inspect", tenantOrigin, "--format=json"]),
    publicJson(`${rootOrigin}/api/health`),
    publicJson(`${rootOrigin}/api/access/health`),
    publicRouteObservation(`${authOrigin}/sign-in`),
    publicRouteObservation(tenantOrigin)
  ]);
  return {
    routes: {
      root: { deploymentId: text(rootRoute.id), status: record(publicHealth).status, ssoProtected: record(publicHealth).ssoProtected, mitigated: record(publicHealth).mitigated },
      auth: { deploymentId: text(authRoute.id), ...authObservation },
      tenant: { deploymentId: text(tenantRoute.id), ...tenantObservation }
    },
    publicHealth,
    publicAccessHealth: publicAccess
  };
}

async function waitForPromotedRoutes(deploymentId: string, target: TrustedReleaseTarget): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const facts = await hydrateSteadyFacts(deploymentId, true, target);
    const routes = record(facts.routes);
    if (["root", "auth", "tenant"].every((name) => text(record(routes[name]).deploymentId) === deploymentId)) return facts;
    await delay(2_000);
  }
  return hydrateSteadyFacts(deploymentId, true, target);
}

async function findStagedDeploymentId(projectId: string, sha: string, productionBranch: string, repository: string): Promise<string> {
  const response = await vercelJson(["api", `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=20`]);
  const matches = records(response.deployments)
    .map((deployment) => {
      const identity = deploymentRecord(deployment);
      return {
        id: text(identity.id),
        commitSha: text(identity.commitSha),
        commitRef: text(identity.commitRef),
        target: text(identity.target),
        readyState: text(identity.readyState),
        source: text(identity.source),
        repository: text(identity.repository),
        gitDirty: identity.gitDirty === true,
        createdAt: Number(deployment.createdAt) || 0
      };
    })
    .filter((deployment) => deployment.commitSha === sha
      && deployment.commitRef === productionBranch
      && deployment.target === "production"
      && deployment.readyState === "READY"
      && deployment.source === "git"
      && deployment.repository === repository
      && deployment.gitDirty !== true)
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  const id = text(matches[0]?.id);
  if (!id) throw new Error(`No READY staged Production deployment matches HEAD ${sha}.`);
  return id;
}

async function vercelJson(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run("vercel", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return record(JSON.parse(stdout));
}

async function vercelRuntimeJson(deploymentUrl: string, pathname: string): Promise<Record<string, unknown>> {
  const { stdout } = await run("vercel", ["curl", pathname, "--deployment", deploymentUrl, "--", "--silent", "--show-error", "--write-out", "\n%{http_code}"], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024
  });
  const splitAt = stdout.lastIndexOf("\n");
  if (splitAt < 0) throw new Error(`Live ${pathname} response did not include an HTTP status.`);
  return { ...record(JSON.parse(stdout.slice(0, splitAt))), status: Number(stdout.slice(splitAt + 1).trim()) };
}

async function publicJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", redirect: "manual" });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.toLowerCase().includes("application/json") ? record(await response.json()) : {};
  return { ...body, ...routeObservation(response, url) };
}

async function publicRouteObservation(url: string): Promise<Record<string, unknown>> {
  return routeObservation(await fetch(url, { cache: "no-store", redirect: "manual" }), url);
}

function routeObservation(response: Response, requestedUrl: string): Record<string, unknown> {
  return {
    status: response.status,
    ssoProtected: isVercelSsoProtectionRedirect(response.status, response.headers.get("location"), requestedUrl, response.headers.get("set-cookie")),
    mitigated: text(response.headers.get("x-vercel-mitigated"))
  };
}

async function unauthenticatedRouteIsProtected(origin: string): Promise<boolean> {
  const probeUrl = new URL(`/__kanban_cards_protection_probe__/${randomUUID()}`, origin).href;
  const response = await fetch(probeUrl, { cache: "no-store", redirect: "manual" });
  return isVercelSsoProtectionRedirect(response.status, response.headers.get("location"), probeUrl, response.headers.get("set-cookie"));
}

function deploymentRecord(value: Record<string, unknown>): Record<string, unknown> {
  const gitSource = record(value.gitSource);
  const meta = record(value.meta);
  const project = record(value.project);
  const repositoryOwner = text(gitSource.org) || text(meta.githubCommitOrg) || text(meta.githubOrg);
  const repositoryName = text(gitSource.repo) || text(meta.githubCommitRepo) || text(meta.githubRepo);
  const dirtyValue = value.gitDirty ?? gitSource.dirty ?? meta.gitDirty ?? meta.githubCommitDirty;
  return {
    id: text(value.id) || text(value.uid),
    url: canonicalUrl(value.url),
    projectId: text(value.projectId) || text(project.id),
    source: text(value.source),
    repository: repositoryOwner && repositoryName ? `${repositoryOwner}/${repositoryName}` : "",
    gitDirty: dirtyValue === true || ["1", "true"].includes(text(dirtyValue).toLowerCase()),
    commitSha: text(gitSource.sha) || text(meta.githubCommitSha),
    commitRef: text(gitSource.ref) || text(meta.githubCommitRef),
    target: text(value.target),
    readyState: text(value.readyState) || text(value.state),
    aliases: strings(value.alias ?? value.aliases)
  };
}

function deploymentReceipt(value: Record<string, unknown>): SteadyDeploymentReceipt {
  return {
    id: text(value.id),
    url: canonicalUrl(value.url),
    commitSha: text(value.commitSha),
    commitRef: text(value.commitRef),
    target: text(value.target),
    readyState: text(value.readyState),
    source: text(value.source),
    repository: text(value.repository)
  };
}

async function persistPromotionReceipt(evaluation: SteadyReleaseEvaluation): Promise<string> {
  const directory = path.resolve(process.cwd(), ".vercel", "release-receipts");
  const receiptPath = path.join(directory, `${evaluation.deploymentId}.json`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(receiptPath, `${JSON.stringify({
    version: 1,
    authorizedAt: new Date().toISOString(),
    candidate: evaluation.candidate,
    rollbackTarget: evaluation.rollbackTarget
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return receiptPath;
}

async function readPersistedRollbackTarget(deploymentId: string): Promise<Record<string, unknown>> {
  try {
    const receiptPath = path.resolve(process.cwd(), ".vercel", "release-receipts", `${deploymentId}.json`);
    return record(record(JSON.parse(await fs.readFile(receiptPath, "utf8"))).rollbackTarget);
  } catch {
    return {};
  }
}

async function pendingPromotionExists(): Promise<boolean> {
  try {
    const result = await run("vercel", ["promote", "status", "--timeout=0s"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return !/No deployment promotion in progress/i.test(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    const output = subprocessOutput(error);
    if (/No deployment promotion in progress/i.test(output)) return false;
    if (/promotion|timed out|timeout/i.test(output)) return true;
    throw error;
  }
}

async function waitForPendingPromotion(): Promise<void> {
  try {
    await run("vercel", ["promote", "status", "--timeout=5m"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    // The exact route verification below is authoritative even when the CLI's
    // wait times out or loses its connection while Vercel keeps working.
  }
}

function addUnless(blockers: SteadyReleaseBlocker[], passed: boolean, code: string, message: string): void {
  if (!passed) blockers.push({ code, message });
}

function requireHealth(blockers: SteadyReleaseBlocker[], health: Record<string, unknown>, prefix: string, requirePasskeys = true): void {
  addUnless(blockers, health.status === 200 && health.ok === true && text(health.store) === "postgres", prefix, `${prefix} must return HTTP 200, ok:true, and Postgres.`);
  addUnless(blockers, strings(health.missingConfiguration).length === 0, `${prefix}-configuration`, `${prefix} reports missing configuration.`);
  if (requirePasskeys) {
    addUnless(blockers, text(health.authentication) === "passkey-session+workspace", `${prefix}-authentication`, `${prefix} must use passkey sessions with Workspace access.`);
    addUnless(blockers, text(record(health.access).registry) === "ready", `${prefix}-registry`, `${prefix} must report a ready access registry.`);
  }
}

function requireAccessHealth(blockers: SteadyReleaseBlocker[], health: Record<string, unknown>, prefix: string): void {
  addUnless(blockers, health.status === 200 && health.ok === true && text(health.registryState) === "ready", prefix, `${prefix} must report a ready access registry.`);
  addUnless(blockers, ["ready", "not-required"].includes(text(health.legacyState)), `${prefix}-state`, `${prefix} must report readable existing state or no legacy state requirement.`);
  addUnless(blockers, text(health.legacyBridge) === "disabled", `${prefix}-legacy-bridge`, `${prefix} must keep the retired global credential disabled.`);
  addUnless(blockers, strings(health.missingConfiguration).length === 0, `${prefix}-configuration`, `${prefix} reports missing configuration.`);
}

function requirePublicRoute(blockers: SteadyReleaseBlocker[], route: Record<string, unknown>, prefix: string, minimum: number, maximum: number): void {
  addUnless(blockers, statusInRange(route.status, minimum, maximum), prefix, `${prefix} returned an unhealthy status.`);
  addUnless(blockers, route.ssoProtected === false, `${prefix}-sso`, `${prefix} is behind Vercel SSO instead of public.`);
  addUnless(blockers, !text(route.mitigated), `${prefix}-mitigated`, `${prefix} was intercepted by Vercel mitigation.`);
}

function finish(evaluation: SteadyReleaseEvaluation): void {
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ok) process.exitCode = 1;
}

function isGeneratedDeploymentUrl(value: unknown, publicDomain: string): boolean {
  try {
    const url = new URL(canonicalUrl(value));
    return url.protocol === "https:" && !url.username && !url.password && url.port === "" && url.pathname === "/" && !url.search && !url.hash && url.hostname.endsWith(".vercel.app") && url.hostname !== publicDomain;
  } catch {
    return false;
  }
}

function statusInRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function subprocessOutput(value: unknown): string {
  const error = record(value);
  return `${text(error.stdout)}\n${text(error.stderr)}\n${errorMessage(value)}`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function canonicalUrl(value: unknown): string { const raw = text(value); return raw ? (raw.startsWith("https://") ? raw : `https://${raw}`) : ""; }

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
