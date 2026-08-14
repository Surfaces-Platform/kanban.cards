import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const PROMOTION_CONFIRMATION = "PROMOTE EXACT VERIFIED CANDIDATE";
export const CANDIDATE_FIREWALL_BYPASS_RULE = "kanban-candidate-mike-bypass";
export const CANDIDATE_FIREWALL_DENY_RULE = "kanban-candidate-deny";

export type CutoverPhase = "pre-promotion" | "post-promotion";

export interface TrustedReleaseTarget {
  projectId: string;
  teamId: string;
  repository: string;
  productionBranch: string;
  publicDomain: string;
  authDomain: string;
}

export interface CutoverBlocker {
  gate:
    | "release-policy"
    | "candidate-identity"
    | "production-boundary"
    | "candidate-readiness"
    | "clerk-access"
    | "compatibility-bridge"
    | "data-integrity"
    | "rollback-target"
    | "evidence-binding"
    | "explicit-promotion";
  code: string;
  message: string;
}

export interface CutoverEvaluation {
  phase: CutoverPhase;
  ok: boolean;
  blockers: CutoverBlocker[];
  candidate: { deploymentId: string; url: string; commitSha: string };
}

export interface PromotionAuthorization extends CutoverEvaluation {
  authorized: boolean;
}

export interface PromotionDependencies {
  promote(deploymentId: string): Promise<void>;
  readPostPromotionSnapshot(): Promise<unknown>;
  now?: () => Date;
}

export interface PromotionResult {
  status: "blocked" | "promoted" | "post-promotion-failed";
  promotionCalls: number;
  evaluation: CutoverEvaluation;
}

type UnknownRecord = Record<string, unknown>;

export interface CandidateFirewallFacts {
  firewallEnabled: boolean;
  hasDraft: boolean;
  pendingChanges: number;
  configHash: string;
  ruleIds: string[];
  bypassRuleId: string;
  denyRuleId: string;
  reviewedSourceCidr: string;
  bypassReady: boolean;
  denyReady: boolean;
  releaseRulesAbsent: boolean;
}

const MAX_RECEIPT_AGE_MS = 30 * 60 * 1000;

export function evaluateCutoverSnapshot(
  snapshot: unknown,
  phase: CutoverPhase,
  trustedTarget: TrustedReleaseTarget = trustedReleaseTarget(),
  now: Date = new Date()
): CutoverEvaluation {
  const root = record(snapshot);
  const policy = record(root.policy);
  const candidate = record(root.candidate);
  const currentProduction = record(root.currentProduction);
  const currentProductionHealth = record(currentProduction.health);
  const evidence = phaseEvidence(root, phase);
  const health = record(evidence.health);
  const healthAccess = record(health.access);
  const accessHealth = record(evidence.accessHealth);
  const legacyBinding = record(accessHealth.legacyBinding);
  const clerk = record(evidence.clerkProof);
  const compatibility = record(evidence.compatibilityProof);
  const retirement = record(evidence.retirementProof);
  const data = record(evidence.dataIntegrityProof);
  const rollback = record(phase === "pre-promotion" ? root.rollbackTarget : root.originalRollbackTarget);
  const promotionReceipt = record(root.promotionReceipt);
  const receiptRollback = record(promotionReceipt.rollbackTarget);
  const preEvidence = record(record(root.evidence).prePromotion);
  const postEvidence = record(record(root.evidence).postPromotion);
  const blockers: CutoverBlocker[] = [];

  const candidateId = text(candidate.id);
  const candidateUrl = canonicalDeploymentUrl(candidate.url);
  const candidateSha = text(candidate.commitSha);
  const expectedOrigin = phase === "post-promotion" ? canonicalOrigin(trustedTarget.publicDomain) : "";
  const firewallFacts = inspectCandidateFirewall(policy.firewall, trustedTarget);

  requireMatch(blockers, "release-policy", "project-id", text(policy.projectId), trustedTarget.projectId, "Vercel Project id");
  requireMatch(blockers, "release-policy", "team-id", text(policy.teamId), trustedTarget.teamId, "Vercel team id");
  requireMatch(blockers, "release-policy", "repository", text(policy.repository), trustedTarget.repository, "linked repository");
  requireMatch(blockers, "release-policy", "production-branch", text(policy.productionBranch), trustedTarget.productionBranch, "production branch");
  if (policy.autoAssignCustomDomains !== false) add(blockers, "release-policy", "auto-domain-assignment-enabled", "Auto-assign Custom Production Domains must remain disabled.");
  if (policy.mainGitDeploymentsEnabled !== false) add(blockers, "release-policy", "main-git-deployments-enabled", "The repository must keep every Git rule that matches main disabled.");
  if (text(policy.deploymentProtection) !== "all_except_custom_domains") {
    add(blockers, "release-policy", "standard-protection-required", "Standard Protection must remain enabled so generated deployments are protected while custom production domains stay public.");
  }
  requireFirewallPolicy(blockers, firewallFacts, phase);

  requireMatch(blockers, "candidate-identity", "project-id", text(candidate.projectId), trustedTarget.projectId, "candidate Project id");
  requireMatch(blockers, "candidate-identity", "commit-ref", text(candidate.commitRef), trustedTarget.productionBranch, "candidate Git ref");
  requireMatch(blockers, "candidate-identity", "target", text(candidate.target), "production", "candidate environment target");
  requireMatch(blockers, "candidate-identity", "ready-state", text(candidate.readyState), "READY", "candidate readiness state");
  if (!candidateId) add(blockers, "candidate-identity", "deployment-id", "Candidate deployment id is missing.");
  if (!candidateSha || !/^[0-9a-f]{40}$/i.test(candidateSha)) add(blockers, "candidate-identity", "commit-sha", "Candidate must carry the full Git commit SHA from live deployment metadata.");
  if (!isGeneratedDeploymentUrl(candidateUrl, trustedTarget.publicDomain)) add(blockers, "candidate-identity", "deployment-url", "Candidate URL must be an immutable generated HTTPS deployment hostname, not the public domain or a branch alias.");
  if (strings(candidate.aliases).includes(trustedTarget.publicDomain) && phase === "pre-promotion") add(blockers, "production-boundary", "candidate-already-public", "The candidate already owns the public production domain.");

  const productionId = text(currentProduction.id);
  const productionUrl = canonicalDeploymentUrl(currentProduction.url);
  const productionAliases = strings(currentProduction.aliases);
  const projectAliasOrigins = new Set(strings(policy.aliases).map((alias) => canonicalOrigin(alias)).filter(Boolean));
  requireMatch(blockers, "production-boundary", "production-project-id", text(currentProduction.projectId), trustedTarget.projectId, "current production Project id");
  requireMatch(blockers, "production-boundary", "production-target", text(currentProduction.target), "production", "current production target");
  requireMatch(blockers, "production-boundary", "production-ready-state", text(currentProduction.readyState), "READY", "current production readiness state");
  if (!isGeneratedDeploymentUrl(productionUrl, trustedTarget.publicDomain)) add(blockers, "production-boundary", "production-url", "Current production must resolve to an immutable generated deployment URL.");
  if (!productionAliases.includes(trustedTarget.publicDomain)) add(blockers, "production-boundary", "public-domain-missing", "The inspected production deployment does not own the public domain.");
  if (phase === "pre-promotion" && productionId === candidateId) add(blockers, "production-boundary", "candidate-already-current", "The candidate must remain unpromoted while pre-promotion gates run.");
  if (phase === "pre-promotion") {
    if (policy.aliasInventoryComplete !== true) add(blockers, "production-boundary", "alias-inventory-incomplete", "Pre-promotion proof requires a complete live Vercel Project alias inventory.");
    if (projectAliasOrigins.has(canonicalOrigin(`mike.${trustedTarget.publicDomain}`))) add(blockers, "production-boundary", "canonical-tenant-alias-premature", "The canonical tenant must remain absent from the complete Project alias inventory before promotion.");
  }
  if (phase === "post-promotion" && productionId !== candidateId) add(blockers, "production-boundary", "candidate-not-current", "The public production target does not match the verified candidate deployment.");
  if (phase === "post-promotion") {
    if (policy.aliasInventoryComplete !== true) add(blockers, "production-boundary", "alias-inventory-incomplete", "Post-promotion proof requires a complete live Vercel Project alias inventory.");
    const liveAliasOrigins = new Set(productionAliases.map((alias) => canonicalOrigin(alias)).filter(Boolean));
    if (liveAliasOrigins.has(canonicalOrigin(preEvidence.origin))) {
      add(blockers, "production-boundary", "candidate-root-alias-still-live", "The pre-promotion candidate root alias must be removed before Standard Protection and public post-promotion proof.");
    }
    if (liveAliasOrigins.has(canonicalOrigin(preEvidence.tenantOrigin))) {
      add(blockers, "production-boundary", "candidate-tenant-alias-still-live", "The pre-promotion candidate tenant alias must be removed before Standard Protection and public post-promotion proof.");
    }
    if (projectAliasOrigins.has(canonicalOrigin(preEvidence.origin))) add(blockers, "production-boundary", "candidate-root-alias-still-routed", "The candidate root alias remains routed somewhere in the Vercel Project.");
    if (projectAliasOrigins.has(canonicalOrigin(preEvidence.tenantOrigin))) add(blockers, "production-boundary", "candidate-tenant-alias-still-routed", "The candidate tenant alias remains routed somewhere in the Vercel Project.");
  }
  if (currentProductionHealth.status !== 200 || currentProductionHealth.ok !== true || text(currentProductionHealth.store) !== "postgres") add(blockers, "production-boundary", "production-unhealthy", "The deployment currently serving production is not a healthy Postgres runtime.");

  requireReceiptBinding(blockers, evidence, preEvidence, phase, candidateId, candidateUrl, candidateSha, expectedOrigin, trustedTarget.publicDomain, trustedTarget.authDomain, firewallFacts, now);

  if (health.status !== 200 || health.ok !== true) add(blockers, "candidate-readiness", "health-not-ready", "The phase readiness receipt must report HTTP 200 with ok:true.");
  if (text(health.store) !== "postgres") add(blockers, "candidate-readiness", "store-not-postgres", "The phase readiness receipt must report the Postgres store.");
  if (strings(health.missingConfiguration).length) add(blockers, "candidate-readiness", "missing-configuration", "The phase readiness receipt reports missing configuration.");
  requireReadyValue(blockers, "candidate-readiness", "registry-not-ready", healthAccess.registry, "Registry");
  requireReadyValue(blockers, "candidate-readiness", "legacy-state-not-ready", healthAccess.legacyState, "Legacy state");
  requireReadyValue(blockers, "candidate-readiness", "legacy-binding-not-ready", healthAccess.legacyBinding, "Legacy binding");
  if (accessHealth.status !== 200 || accessHealth.ok !== true) add(blockers, "candidate-readiness", "access-health-not-ready", "The phase /api/access/health receipt must report HTTP 200 with ok:true.");
  if (strings(accessHealth.missingConfiguration).length) add(blockers, "candidate-readiness", "access-missing-configuration", "The phase access receipt reports missing configuration.");
  requireReadyValue(blockers, "candidate-readiness", "access-registry-not-ready", accessHealth.registryState, "Access registry");
  requireReadyValue(blockers, "candidate-readiness", "access-legacy-state-not-ready", accessHealth.legacyState, "Access legacy state");
  requireReadyValue(blockers, "candidate-readiness", "access-legacy-binding-not-ready", legacyBinding.status, "Access legacy binding");
  if (legacyBinding.present !== true) add(blockers, "candidate-readiness", "legacy-binding-absent", "The phase access receipt must report the exact legacy binding as present.");

  requirePassed(blockers, "clerk-access", evidence, "clerkAuthorizedParties", "clerk-authorized-parties", "Exact Clerk authorized parties");
  requirePassed(blockers, "clerk-access", evidence, "clerkDomainConfiguration", "clerk-domain-configuration", "Single Clerk production FAPI DNS/custom-domain and phase-exact finite effective allowed-origin configuration");
  requirePassed(blockers, "clerk-access", clerk, "authHostSurface", "clerk-auth-host-surface", "Dedicated Clerk auth-host sign-up and sign-in surface");
  requirePassed(blockers, "clerk-access", clerk, "authHostIsolation", "clerk-auth-host-isolation", "Dedicated Clerk auth-host isolation from Workspace application APIs");
  requirePassed(blockers, "clerk-access", clerk, "emailCodeAuth", "clerk-email-code-auth", "Clerk email-code authentication");
  requirePassed(blockers, "clerk-access", clerk, "sameRootSessionShare", "clerk-same-root-session-share", "Clerk auth-host completion, exact initiating application-root return, and per-origin Clerk session recognition");
  requirePassed(blockers, "clerk-access", clerk, "sessionExchange", "clerk-session-exchange", "Server-side Clerk session exchange");
  requirePassed(blockers, "clerk-access", clerk, "exactLegacyBinding", "exact-legacy-binding", "Exact Clerk user-to-legacy Workspace binding");
  requirePassed(blockers, "clerk-access", clerk, "canonicalHandoff", "canonical-handoff", "Canonical tenant handoff");
  requirePassed(blockers, "clerk-access", clerk, "tenantProjectAccess", "tenant-project-access", "Tenant Project access");
  requirePassed(blockers, "clerk-access", clerk, "tenantProjectWrite", "tenant-project-write", "Tenant Project write");
  requirePassed(blockers, "clerk-access", clerk, "signOut", "clerk-sign-out", "App-session and Clerk sign-out");

  const bridgeMode = text(accessHealth.legacyBridge);
  if (bridgeMode === "enabled") {
    if (compatibility.required !== true) add(blockers, "compatibility-bridge", "proof-not-required", "An enabled compatibility bridge must require the bounded bearer proof.");
    for (const field of ["read", "create", "comment", "move", "archive"] as const) requirePassed(blockers, "compatibility-bridge", compatibility, field, `${field}-failed`, `Compatibility ${field}`);
    if (!text(compatibility.cardId) || compatibility.finalCardVersion !== 4) add(blockers, "compatibility-bridge", "lifecycle-receipt-missing", "Compatibility proof must record the lifecycle Card id and final version 4.");
  } else if (bridgeMode === "disabled") {
    if (retirement.required !== true) add(blockers, "compatibility-bridge", "retirement-proof-not-required", "A disabled bridge must require explicit retirement proof.");
    for (const field of ["public401", "legacy401", "sibling401", "oldDeploymentsClosed"] as const) requirePassed(blockers, "compatibility-bridge", retirement, field, `retirement-${field}`, `Retirement ${field}`);
  } else {
    add(blockers, "candidate-readiness", "legacy-bridge-unknown", "Legacy bridge must be enabled or disabled.");
  }

  if (data.realPostgres !== true) add(blockers, "data-integrity", "not-real-postgres", "Data preservation proof must run against the real candidate Postgres store.");
  requireSameNonEmpty(blockers, "data-integrity", "state-digest-changed", data.beforeDigest, data.afterDigest, "Default Workspace canonical digest");
  requireSameNonEmpty(blockers, "data-integrity", "resource-fingerprint-changed", data.beforeResourceFingerprint, data.afterResourceFingerprint, "Default Workspace resource fingerprint");
  if (phase === "post-promotion") requireDistinctPostEvidence(blockers, preEvidence, postEvidence);

  requireMatch(blockers, "rollback-target", "project-id", text(rollback.projectId), trustedTarget.projectId, "rollback Project id");
  if (!/^[0-9a-f]{40}$/i.test(text(rollback.commitSha))) add(blockers, "rollback-target", "commit-sha", "Rollback requires the full live deployment commit SHA.");
  if (phase === "pre-promotion" && (text(rollback.id) !== productionId || canonicalDeploymentUrl(rollback.url) !== productionUrl || text(rollback.commitSha) !== text(currentProduction.commitSha) || text(rollback.target) !== text(currentProduction.target) || text(rollback.readyState) !== text(currentProduction.readyState))) add(blockers, "rollback-target", "identity-mismatch", "Rollback id, immutable URL, SHA, target, and readiness must match the live current production deployment.");
  if (phase === "post-promotion") {
    requireMatch(blockers, "rollback-target", "receipt-candidate-id", text(promotionReceipt.candidateDeploymentId), candidateId, "promotion receipt candidate id");
    requireMatch(blockers, "rollback-target", "receipt-candidate-url", canonicalDeploymentUrl(promotionReceipt.candidateUrl), candidateUrl, "promotion receipt candidate URL");
    requireMatch(blockers, "rollback-target", "receipt-candidate-sha", text(promotionReceipt.candidateCommitSha), candidateSha, "promotion receipt candidate SHA");
    if (!Number.isFinite(Date.parse(text(promotionReceipt.promotedAt)))) add(blockers, "rollback-target", "promotion-time-missing", "The controller-generated promotion receipt must record successful promotion time.");
    if (!sameDeploymentIdentity(rollback, receiptRollback)) add(blockers, "rollback-target", "predecessor-mismatch", "The live rollback deployment must exactly match the pre-authorized production predecessor recorded by the promotion controller.");
    if (!text(rollback.id) || text(rollback.id) === candidateId || !isGeneratedDeploymentUrl(canonicalDeploymentUrl(rollback.url), trustedTarget.publicDomain) || !/^[0-9a-f]{40}$/i.test(text(rollback.commitSha)) || text(rollback.target) !== "production" || text(rollback.readyState) !== "READY") add(blockers, "rollback-target", "identity-mismatch", "The original rollback record must retain a distinct immutable id, URL, full SHA, production target, and READY state after promotion.");
  }
  if (text(rollback.id) === candidateId && phase === "pre-promotion") add(blockers, "rollback-target", "same-as-candidate", "The rollback deployment must differ from the candidate before promotion.");
  if (rollback.verified !== true) add(blockers, "rollback-target", "not-verified", "The rollback target must have a recent health and compatibility verification receipt.");

  return { phase, ok: blockers.length === 0, blockers, candidate: { deploymentId: candidateId, url: candidateUrl, commitSha: candidateSha } };
}

export function authorizePromotion(snapshot: unknown, confirmation: string, trustedTarget?: TrustedReleaseTarget, now?: Date): PromotionAuthorization {
  const evaluation = evaluateCutoverSnapshot(snapshot, "pre-promotion", trustedTarget, now);
  const blockers = [...evaluation.blockers];
  if (confirmation !== PROMOTION_CONFIRMATION) add(blockers, "explicit-promotion", "confirmation-required", `Promotion requires the literal confirmation: ${PROMOTION_CONFIRMATION}`);
  return { ...evaluation, ok: blockers.length === 0, authorized: blockers.length === 0, blockers };
}

export async function promoteVerifiedCandidate(snapshot: unknown, confirmation: string, dependencies: PromotionDependencies, trustedTarget?: TrustedReleaseTarget): Promise<PromotionResult> {
  const now = dependencies.now?.() ?? new Date();
  const authorization = authorizePromotion(snapshot, confirmation, trustedTarget, now);
  if (!authorization.authorized) return { status: "blocked", promotionCalls: 0, evaluation: authorization };
  await dependencies.promote(authorization.candidate.deploymentId);
  const postSnapshot = await dependencies.readPostPromotionSnapshot();
  const postPromotion = evaluateCutoverSnapshot(postSnapshot, "post-promotion", trustedTarget, dependencies.now?.() ?? new Date());
  return { status: postPromotion.ok ? "promoted" : "post-promotion-failed", promotionCalls: 1, evaluation: postPromotion };
}

export function trustedReleaseTarget(): TrustedReleaseTarget {
  return {
    projectId: "prj_5DC7osq9fL2Ju8NMp6dgVz7dUas1",
    teamId: "team_Kw6YLfcGtRy40u9UEvifOh1r",
    repository: "Surfaces-Platform/kanban.cards",
    productionBranch: "main",
    publicDomain: "kanban.cards",
    authDomain: "auth.kanban.cards"
  };
}

export function inspectCandidateFirewall(value: unknown, trustedTarget: TrustedReleaseTarget = trustedReleaseTarget()): CandidateFirewallFacts {
  const firewall = record(value);
  const rules = records(firewall.rules);
  const hosts = candidateFirewallHosts(trustedTarget);
  const bypassMatches = rules.filter((rule) => text(rule.name) === CANDIDATE_FIREWALL_BYPASS_RULE);
  const denyMatches = rules.filter((rule) => text(rule.name) === CANDIDATE_FIREWALL_DENY_RULE);
  const bypass = bypassMatches.length === 1 ? bypassMatches[0] : {};
  const deny = denyMatches.length === 1 ? denyMatches[0] : {};
  const bypassConditions = singleConditionGroup(bypass);
  const denyConditions = singleConditionGroup(deny);
  const reviewedSourceCidr = exactSourceCidrFromConditions(bypassConditions);
  const bypassReady = bypassMatches.length === 1
    && rules[0] === bypass
    && liveRuleWithAction(bypass, "bypass")
    && bypassConditions.length === 2
    && exactHostCondition(bypassConditions, hosts)
    && exactIpCondition(bypassConditions, reviewedSourceCidr);
  const denyReady = denyMatches.length === 1
    && rules[1] === deny
    && liveRuleWithAction(deny, "deny")
    && denyConditions.length === 1
    && exactHostCondition(denyConditions, hosts);
  const releaseRulesAbsent = !rules.some((rule) => {
    if ([CANDIDATE_FIREWALL_BYPASS_RULE, CANDIDATE_FIREWALL_DENY_RULE].includes(text(rule.name))) return true;
    return ruleReferencesAnyHost(rule, hosts);
  });
  return {
    firewallEnabled: firewall.firewallEnabled === true,
    hasDraft: firewall.hasDraft === true,
    pendingChanges: finiteInteger(firewall.pendingChanges),
    configHash: candidateFirewallConfigHash(firewall),
    ruleIds: rules.map((rule) => text(rule.id)).filter(Boolean),
    bypassRuleId: text(bypass.id),
    denyRuleId: text(deny.id),
    reviewedSourceCidr,
    bypassReady,
    denyReady,
    releaseRulesAbsent
  };
}

export function isVercelSsoProtectionRedirect(
  status: number,
  location: unknown,
  requestedUrl: unknown,
  setCookie: unknown
): boolean {
  if (![302, 307].includes(status) || typeof location !== "string" || typeof requestedUrl !== "string" || typeof setCookie !== "string") return false;
  try {
    const requested = new URL(requestedUrl);
    const destination = new URL(location);
    const returnUrl = destination.searchParams.get("url");
    const nonce = destination.searchParams.get("nonce");
    const queryKeys = [...destination.searchParams.keys()].sort();
    return requested.protocol === "https:"
      && !requested.username
      && !requested.password
      && destination.origin === "https://vercel.com"
      && destination.pathname === "/sso-api"
      && !destination.hash
      && queryKeys.length === 2
      && queryKeys[0] === "nonce"
      && queryKeys[1] === "url"
      && returnUrl === requested.href
      && typeof nonce === "string"
      && /^[0-9a-f]{64}$/i.test(nonce)
      && /(?:^|,\s*)_vercel_sso_nonce=[A-Za-z0-9_-]{32,128}(?:;|,|$)/i.test(setCookie)
      && /;\s*Path=\//i.test(setCookie)
      && /;\s*Secure(?:;|,|$)/i.test(setCookie)
      && /;\s*HttpOnly(?:;|,|$)/i.test(setCookie);
  } catch {
    return false;
  }
}

function phaseEvidence(root: UnknownRecord, phase: CutoverPhase): UnknownRecord {
  const evidence = record(root.evidence);
  return record(evidence[phase === "pre-promotion" ? "prePromotion" : "postPromotion"]);
}

function requireReceiptBinding(blockers: CutoverBlocker[], proof: UnknownRecord, preProof: UnknownRecord, phase: CutoverPhase, id: string, url: string, sha: string, expectedOrigin: string, publicDomain: string, authDomain: string, firewallFacts: CandidateFirewallFacts, now: Date): void {
  requireMatch(blockers, "evidence-binding", "proof-phase", text(proof.phase), phase, "proof phase");
  requireMatch(blockers, "evidence-binding", "proof-deployment-id", text(proof.deploymentId), id, "proof deployment id");
  requireMatch(blockers, "evidence-binding", "proof-deployment-url", canonicalDeploymentUrl(proof.deploymentUrl), url, "proof deployment URL");
  requireMatch(blockers, "evidence-binding", "proof-commit-sha", text(proof.commitSha), sha, "proof commit SHA");
  const origin = canonicalOrigin(proof.origin);
  const tenantOrigin = canonicalOrigin(proof.tenantOrigin);
  const authOrigin = canonicalOrigin(proof.authOrigin);
  const candidateOrigin = canonicalOrigin(`candidate.release.${publicDomain}`);
  const candidateTenantOrigin = canonicalOrigin(`mike.candidate.release.${publicDomain}`);
  requireMatch(blockers, "evidence-binding", "proof-auth-origin", authOrigin, canonicalOrigin(authDomain), "proof auth origin");
  if (phase === "post-promotion") {
    requireMatch(blockers, "evidence-binding", "proof-origin", origin, expectedOrigin, "proof origin");
    if (!isDirectTenantOrigin(tenantOrigin, publicDomain) || tenantOrigin === authOrigin) {
      add(blockers, "evidence-binding", "proof-post-tenant-origin", "Post-promotion proof requires an exact one-label tenant origin beneath the canonical public root.");
    }
  } else if (origin !== candidateOrigin) {
    add(blockers, "evidence-binding", "proof-origin", `Pre-promotion Clerk proof requires the exact candidate application origin ${candidateOrigin}.`);
  }
  if (phase === "pre-promotion") {
    if (tenantOrigin !== candidateTenantOrigin) {
      add(blockers, "evidence-binding", "proof-tenant-origin", `Pre-promotion proof requires the exact candidate tenant origin ${candidateTenantOrigin}.`);
    }
  }
  requireMatch(blockers, "evidence-binding", "proof-route-deployment-id", text(proof.routeDeploymentId), id, "proof route deployment id");
  if (proof.routePinned !== "passed") add(blockers, "evidence-binding", "proof-route-not-pinned", "The exercised origin must be live-inspected as pinned to the exact deployment.");
  requireMatch(blockers, "evidence-binding", "proof-auth-route-deployment-id", text(proof.authRouteDeploymentId), id, "proof auth route deployment id");
  if (proof.authRoutePinned !== "passed") add(blockers, "evidence-binding", "proof-auth-route-not-pinned", "The dedicated Clerk auth origin must be live-inspected as pinned to the exact deployment.");
  requireMatch(blockers, "evidence-binding", "proof-tenant-route-deployment-id", text(proof.tenantRouteDeploymentId), id, "proof tenant route deployment id");
  if (proof.tenantRoutePinned !== "passed") add(blockers, "evidence-binding", "proof-tenant-route-not-pinned", "The exercised tenant origin must be live-inspected as pinned to the exact deployment.");
  requireFirewallReceipt(blockers, proof, preProof, phase, firewallFacts, now);
  if (proof.sameArtifactAuthHost !== "passed") add(blockers, "evidence-binding", "auth-host-not-proven", "The dedicated Clerk auth origin must be proven to serve the same immutable artifact as the candidate application routes.");
  if (proof.sameArtifactCanonicalHost !== "passed") add(blockers, "evidence-binding", "canonical-host-not-proven", "The same immutable artifact must be proven compatible with the canonical production root and tenant hosts before promotion.");
  const runId = text(proof.runId);
  if (!runId) add(blockers, "evidence-binding", "proof-run-id", "Proof requires a unique run id.");
  const observedAt = Date.parse(text(proof.observedAt));
  if (!Number.isFinite(observedAt) || observedAt > now.getTime() + 60_000 || now.getTime() - observedAt > MAX_RECEIPT_AGE_MS) add(blockers, "evidence-binding", "proof-stale", "Proof must have a valid observedAt no more than 30 minutes old.");
}

function requireFirewallPolicy(blockers: CutoverBlocker[], facts: CandidateFirewallFacts, phase: CutoverPhase): void {
  if (!facts.firewallEnabled) {
    add(blockers, "release-policy", "firewall-disabled", "The Vercel Firewall must be enabled for release proof.");
  }
  if (facts.hasDraft || facts.pendingChanges !== 0) {
    add(blockers, "release-policy", "firewall-draft-present", "The Vercel Firewall must have no unpublished draft changes during release proof.");
  }
  if (phase === "pre-promotion") {
    if (!facts.bypassReady) add(blockers, "release-policy", "candidate-firewall-bypass-invalid", "The highest-priority live rule must bypass only Mike's reviewed exact /32 or /128 on the three exact release hosts.");
    if (!facts.denyReady) add(blockers, "release-policy", "candidate-firewall-deny-invalid", "The immediately following live rule must deny the same three exact release hosts with no duration or additional conditions.");
  } else if (!facts.releaseRulesAbsent) {
    add(blockers, "release-policy", "candidate-firewall-cleanup-incomplete", "Both temporary candidate Firewall rules must be absent from the published configuration before public post-promotion proof.");
  }
}

function requireFirewallReceipt(blockers: CutoverBlocker[], proof: UnknownRecord, preProof: UnknownRecord, phase: CutoverPhase, facts: CandidateFirewallFacts, now: Date): void {
  const firewallProof = record(proof.firewallProof);
  if (phase === "pre-promotion") {
    requireMatch(blockers, "evidence-binding", "firewall-bypass-rule-id", text(firewallProof.liveBypassRuleId), facts.bypassRuleId, "live Firewall bypass rule id");
    requireMatch(blockers, "evidence-binding", "firewall-deny-rule-id", text(firewallProof.liveDenyRuleId), facts.denyRuleId, "live Firewall deny rule id");
    requireMatch(blockers, "evidence-binding", "firewall-reviewed-source", text(firewallProof.reviewedSourceCidr), facts.reviewedSourceCidr, "reviewed Firewall source CIDR");
    requireMatch(blockers, "evidence-binding", "firewall-config-hash", text(firewallProof.configHash), facts.configHash, "published Firewall configuration hash");
    const admitted = record(firewallProof.admittedProbe);
    requireMatch(blockers, "evidence-binding", "firewall-admitted-config", text(admitted.configHash), facts.configHash, "admitted probe Firewall configuration hash");
    const admittedVercelIds: string[] = [];
    for (const field of ["authHost", "candidateRoot", "candidateTenant"] as const) {
      const observation = record(admitted[field]);
      const status = finiteInteger(observation.status);
      if (field === "candidateRoot" || field === "authHost") {
        if (status !== 200) add(blockers, "evidence-binding", `firewall-admitted-${field}-status`, `Admitted-source ${field} probe must return HTTP 200.`);
      } else if (status < 200 || status >= 400) {
        add(blockers, "evidence-binding", `firewall-admitted-${field}-status`, "Admitted-source candidate tenant probe must return a public 2xx or intentional 3xx response.");
      }
      requireMatch(blockers, "evidence-binding", `firewall-admitted-${field}-mitigation`, text(observation.mitigated), "none", `admitted-source ${field} mitigation result`);
      const vercelId = text(observation.vercelId);
      if (!vercelId) add(blockers, "evidence-binding", `firewall-admitted-${field}-vercel-id`, `Admitted-source ${field} probe must record its x-vercel-id.`);
      else admittedVercelIds.push(vercelId);
    }
    if (new Set(admittedVercelIds).size !== admittedVercelIds.length) add(blockers, "evidence-binding", "firewall-admitted-vercel-id-reused", "Each admitted host probe must record a distinct x-vercel-id.");
    const external = record(firewallProof.externalDenyProbe);
    const externalSourceCidr = text(external.observedSourceCidr);
    if (!isExactAddressCidr(externalSourceCidr) || normalizeExactAddressCidr(externalSourceCidr) === normalizeExactAddressCidr(facts.reviewedSourceCidr)) add(blockers, "evidence-binding", "firewall-external-source", "External deny proof must record a different exact /32 or /128 source outside Mike's reviewed CIDR.");
    requireMatch(blockers, "evidence-binding", "firewall-external-config", text(external.configHash), facts.configHash, "external deny probe Firewall configuration hash");
    const externalVercelIds: string[] = [];
    for (const field of ["authHost", "candidateRoot", "candidateTenant"] as const) {
      const observation = record(external[field]);
      if (observation.status !== 403) add(blockers, "evidence-binding", `firewall-external-${field}-status`, `External-source ${field} probe must return HTTP 403.`);
      requireMatch(blockers, "evidence-binding", `firewall-external-${field}-mitigation`, text(observation.mitigated), "deny", `external-source ${field} mitigation result`);
      requireMatch(blockers, "evidence-binding", `firewall-external-${field}-action`, text(observation.wafAction), "deny", `external-source ${field} Firewall log action`);
      requireMatch(blockers, "evidence-binding", `firewall-external-${field}-rule-id`, text(observation.wafRuleId), facts.denyRuleId, `external-source ${field} Firewall log rule id`);
      const vercelId = text(observation.vercelId);
      if (!vercelId) add(blockers, "evidence-binding", `firewall-external-${field}-vercel-id`, `External-source ${field} denial must record its x-vercel-id for Firewall traffic correlation.`);
      else externalVercelIds.push(vercelId);
      requireFreshObservation(blockers, text(observation.observedAt), now, `firewall-external-${field}-stale`, `External-source ${field} Firewall correlation`);
    }
    const canonicalRoot = record(external.canonicalRoot);
    if (canonicalRoot.status !== 200 || canonicalRoot.ok !== true || text(canonicalRoot.store) !== "postgres" || text(canonicalRoot.mitigated) !== "none" || !text(canonicalRoot.vercelId)) add(blockers, "evidence-binding", "firewall-canonical-root-exclusion", "The same external source must receive a healthy, unmitigated HTTP 200 from the canonical root.");
    else externalVercelIds.push(text(canonicalRoot.vercelId));
    requireFreshObservation(blockers, text(canonicalRoot.observedAt), now, "firewall-canonical-root-stale", "Canonical-root exclusion probe");
    const canonicalTenant = record(external.canonicalTenant);
    if (canonicalTenant.status !== 404 || text(canonicalTenant.mitigated) !== "none" || text(canonicalTenant.vercelError) !== "DEPLOYMENT_NOT_FOUND" || !text(canonicalTenant.vercelId)) add(blockers, "evidence-binding", "firewall-canonical-tenant-exclusion", "Before promotion, the same external source must receive Vercel's unmitigated HTTP 404 with x-vercel-error: DEPLOYMENT_NOT_FOUND from the unrouted canonical tenant.");
    else externalVercelIds.push(text(canonicalTenant.vercelId));
    requireFreshObservation(blockers, text(canonicalTenant.observedAt), now, "firewall-canonical-tenant-stale", "Canonical-tenant exclusion probe");
    if (new Set(externalVercelIds).size !== externalVercelIds.length) add(blockers, "evidence-binding", "firewall-external-vercel-id-reused", "Every external release-host and canonical-exclusion probe must record a distinct x-vercel-id.");
    return;
  }

  const preFirewallProof = record(preProof.firewallProof);
  const expectedRemovedIds = [text(preFirewallProof.liveBypassRuleId), text(preFirewallProof.liveDenyRuleId)].filter(Boolean).sort();
  const removedRuleIds = strings(firewallProof.removedRuleIds).sort();
  if (expectedRemovedIds.length !== 2 || removedRuleIds.length !== 2 || expectedRemovedIds.some((id, index) => id !== removedRuleIds[index])) {
    add(blockers, "evidence-binding", "firewall-removed-rule-ids", "Post-promotion cleanup must bind the two removed Firewall rule ids to the live pre-promotion receipt.");
  }
  if (expectedRemovedIds.some((id) => facts.ruleIds.includes(id))) add(blockers, "evidence-binding", "firewall-removed-rule-id-still-live", "A pre-promotion Firewall rule id remains in the published post-cleanup configuration.");
  requireMatch(blockers, "evidence-binding", "firewall-post-config-hash", text(firewallProof.configHash), facts.configHash, "post-cleanup published Firewall configuration hash");
  for (const [field, code, label] of [
    ["releaseRulesRemoved", "firewall-release-rules-removed", "Published candidate Firewall rule removal"],
    ["noDraft", "firewall-no-draft", "Empty Firewall draft"],
    ["authHostPublic", "firewall-auth-public", "Public auth host"],
    ["canonicalRootPublic", "firewall-root-public", "Public canonical root"],
    ["canonicalTenantPublic", "firewall-tenant-public", "Public canonical tenant"],
    ["generatedDeploymentProtected", "firewall-generated-protected", "Standard-protected generated deployment"]
  ] as const) requirePassed(blockers, "evidence-binding", firewallProof, field, code, label);
  const external = record(firewallProof.externalPublicProbe);
  const externalSourceCidr = text(external.observedSourceCidr);
  if (!isExactAddressCidr(externalSourceCidr) || normalizeExactAddressCidr(externalSourceCidr) === normalizeExactAddressCidr(text(preFirewallProof.reviewedSourceCidr))) add(blockers, "evidence-binding", "firewall-post-external-source", "Post-cleanup public proof must use a different exact /32 or /128 outside the pre-promotion bypass.");
  requireMatch(blockers, "evidence-binding", "firewall-post-external-config", text(external.configHash), facts.configHash, "post-cleanup external probe Firewall configuration hash");
  const externalVercelIds: string[] = [];
  for (const [field, expectedStatus, requireHealth] of [["authHost", 200, false], ["canonicalRoot", 200, true], ["canonicalTenant", 0, false]] as const) {
    const observation = record(external[field]);
    const status = finiteInteger(observation.status);
    const statusMatches = expectedStatus ? status === expectedStatus : status >= 200 && status < 400;
    const healthMatches = !requireHealth || (observation.ok === true && text(observation.store) === "postgres");
    if (!statusMatches || !healthMatches || text(observation.mitigated) !== "none" || !text(observation.vercelId)) add(blockers, "evidence-binding", `firewall-post-external-${field}`, `Post-cleanup external ${field} probe must return its expected public, unmitigated response.`);
    else externalVercelIds.push(text(observation.vercelId));
    requireFreshObservation(blockers, text(observation.observedAt), now, `firewall-post-external-${field}-stale`, `Post-cleanup external ${field} probe`);
  }
  if (new Set(externalVercelIds).size !== externalVercelIds.length) add(blockers, "evidence-binding", "firewall-post-external-vercel-id-reused", "Each post-cleanup external public probe must record a distinct x-vercel-id.");
}

function requireFreshObservation(blockers: CutoverBlocker[], observedAt: string, now: Date, code: string, label: string): void {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed > now.getTime() + 60_000 || now.getTime() - observed > MAX_RECEIPT_AGE_MS) add(blockers, "evidence-binding", code, `${label} must be no more than 30 minutes old.`);
}

function requireDistinctPostEvidence(blockers: CutoverBlocker[], pre: UnknownRecord, post: UnknownRecord): void {
  if (!text(pre.runId) || text(pre.runId) === text(post.runId)) add(blockers, "evidence-binding", "post-run-reused", "Post-promotion proof requires a distinct run id.");
  const preObserved = Date.parse(text(pre.observedAt));
  const postObserved = Date.parse(text(post.observedAt));
  if (!Number.isFinite(preObserved) || !Number.isFinite(postObserved) || postObserved <= preObserved) add(blockers, "evidence-binding", "post-not-after-pre", "Post-promotion proof must be observed after pre-promotion proof.");
  const preCompatibility = record(pre.compatibilityProof);
  const postCompatibility = record(post.compatibilityProof);
  if (text(preCompatibility.cardId) && text(preCompatibility.cardId) === text(postCompatibility.cardId)) add(blockers, "evidence-binding", "post-card-reused", "Post-promotion compatibility proof requires a distinct lifecycle Card.");
  const preData = record(pre.dataIntegrityProof);
  const postData = record(post.dataIntegrityProof);
  requireMatch(blockers, "data-integrity", "promotion-baseline-digest", text(postData.beforeDigest), text(preData.finalCandidateDigest), "post-promotion baseline digest");
  requireMatch(blockers, "data-integrity", "promotion-baseline-fingerprint", text(postData.beforeResourceFingerprint), text(preData.finalCandidateResourceFingerprint), "post-promotion baseline fingerprint");
}

function sameDeploymentIdentity(actual: UnknownRecord, expected: UnknownRecord): boolean {
  return text(actual.id) === text(expected.id)
    && canonicalDeploymentUrl(actual.url) === canonicalDeploymentUrl(expected.url)
    && text(actual.projectId) === text(expected.projectId)
    && text(actual.commitSha) === text(expected.commitSha)
    && text(actual.target) === text(expected.target)
    && text(actual.readyState) === text(expected.readyState);
}

function record(value: unknown): UnknownRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}; }
function records(value: unknown): UnknownRecord[] { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()) : []; }
function finiteInteger(value: unknown): number { return typeof value === "number" && Number.isInteger(value) ? value : -1; }
function candidateFirewallHosts(target: TrustedReleaseTarget): string[] {
  return [target.authDomain, `candidate.release.${target.publicDomain}`, `mike.candidate.release.${target.publicDomain}`].sort();
}
function singleConditionGroup(rule: UnknownRecord): UnknownRecord[] {
  const groups = records(rule.conditionGroup);
  return groups.length === 1 ? records(groups[0].conditions) : [];
}
function liveRuleWithAction(rule: UnknownRecord, action: "bypass" | "deny"): boolean {
  const mitigate = record(record(rule.action).mitigate);
  const duration = mitigate.actionDuration;
  return /^rule_[A-Za-z0-9_]+$/.test(text(rule.id))
    && rule.active === true
    && text(rule._status) === "live"
    && text(mitigate.action) === action
    && (duration === undefined || duration === null);
}
function exactHostCondition(conditions: UnknownRecord[], hosts: string[]): boolean {
  const matching = conditions.filter((condition) => text(condition.type) === "host");
  if (matching.length !== 1) return false;
  const condition = matching[0];
  const values = strings(condition.value).sort();
  return text(condition.op) === "inc"
    && condition.neg !== true
    && !text(condition.key)
    && values.length === hosts.length
    && hosts.every((host, index) => host === values[index]);
}
function exactSourceCidrFromConditions(conditions: UnknownRecord[]): string {
  const matching = conditions.filter((condition) => text(condition.type) === "ip_address");
  if (matching.length !== 1) return "";
  const condition = matching[0];
  const cidr = text(condition.value);
  return text(condition.op) === "eq" && condition.neg !== true && !text(condition.key) && isExactAddressCidr(cidr) ? cidr : "";
}
function exactIpCondition(conditions: UnknownRecord[], expectedCidr: string): boolean {
  return Boolean(expectedCidr) && exactSourceCidrFromConditions(conditions) === expectedCidr;
}
function ruleReferencesAnyHost(rule: UnknownRecord, hosts: string[]): boolean {
  return records(rule.conditionGroup).some((group) => records(group.conditions).some((condition) => {
    if (text(condition.type) !== "host") return false;
    const value = condition.value;
    const values = Array.isArray(value) ? strings(value) : [text(value)].filter(Boolean);
    return values.some((entry) => hosts.includes(entry));
  }));
}
function candidateFirewallConfigHash(firewall: UnknownRecord): string {
  const normalized = {
    firewallEnabled: firewall.firewallEnabled === true,
    rules: records(firewall.rules).map((rule) => ({
      id: text(rule.id),
      name: text(rule.name),
      active: rule.active === true,
      conditionGroup: rule.conditionGroup,
      action: rule.action
    }))
  };
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as UnknownRecord;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function isExactAddressCidr(value: string): boolean {
  const separator = value.lastIndexOf("/");
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = value.slice(separator + 1);
  const version = isIP(address);
  return (version === 4 && prefix === "32") || (version === 6 && prefix === "128");
}
function normalizeExactAddressCidr(value: string): string {
  if (!isExactAddressCidr(value)) return "";
  const separator = value.lastIndexOf("/");
  const address = value.slice(0, separator);
  if (isIP(address) === 4) return `${address.split(".").map((part) => String(Number(part))).join(".")}/32`;
  try {
    const hostname = new URL(`http://[${address}]`).hostname;
    return `${hostname.slice(1, -1).toLowerCase()}/128`;
  } catch {
    return "";
  }
}
function canonicalOrigin(value: unknown): string { const raw = text(value); if (!raw) return ""; try { const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`); return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : ""; } catch { return ""; } }
function isDirectTenantOrigin(origin: string, publicDomain: string): boolean {
  const publicOrigin = canonicalOrigin(publicDomain);
  if (!origin || !publicOrigin || origin === publicOrigin) return false;
  const tenantUrl = new URL(origin);
  const publicUrl = new URL(publicOrigin);
  if (tenantUrl.port) return false;
  const suffix = `.${publicUrl.hostname}`;
  if (!tenantUrl.hostname.endsWith(suffix)) return false;
  const tenantLabel = tenantUrl.hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenantLabel);
}
function canonicalDeploymentUrl(value: unknown): string { return canonicalOrigin(value); }
function isGeneratedDeploymentUrl(value: string, publicDomain: string): boolean { if (!value) return false; const host = new URL(value).hostname; return host.endsWith(".vercel.app") && host !== publicDomain && !host.includes("-git-"); }
function add(blockers: CutoverBlocker[], gate: CutoverBlocker["gate"], code: string, message: string): void { blockers.push({ gate, code, message }); }
function requireMatch(blockers: CutoverBlocker[], gate: CutoverBlocker["gate"], code: string, actual: string, expected: string, label: string): void { if (!actual || !expected || actual !== expected) add(blockers, gate, code, `${label} does not match the trusted release target.`); }
function requireReadyValue(blockers: CutoverBlocker[], gate: CutoverBlocker["gate"], code: string, value: unknown, label: string): void { if (text(value) !== "ready") add(blockers, gate, code, `${label} must be ready; not-required, pending, mismatch, missing, invalid, and unavailable all block promotion.`); }
function requirePassed(blockers: CutoverBlocker[], gate: CutoverBlocker["gate"], proof: UnknownRecord, field: string, code: string, label: string): void { if (proof[field] !== "passed") add(blockers, gate, code, `${label} must be recorded as passed in the phase-bound receipt.`); }
function requireSameNonEmpty(blockers: CutoverBlocker[], gate: CutoverBlocker["gate"], code: string, beforeValue: unknown, afterValue: unknown, label: string): void { const before = text(beforeValue); const after = text(afterValue); if (!before || !after || before !== after) add(blockers, gate, code, `${label} must be present and unchanged.`); }
