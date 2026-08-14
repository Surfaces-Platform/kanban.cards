import assert from "node:assert/strict";
import test from "node:test";

import { CANDIDATE_FIREWALL_BYPASS_RULE, CANDIDATE_FIREWALL_DENY_RULE, PROMOTION_CONFIRMATION, authorizePromotion, evaluateCutoverSnapshot, inspectCandidateFirewall, isVercelSsoProtectionRedirect, promoteVerifiedCandidate, type TrustedReleaseTarget } from "../src/release-gate";
import { mainGitDeploymentsAreDisabled } from "../src/release-policy";
import { parseReleaseControllerArguments } from "../src/release-controller";

const NOW = new Date("2026-08-13T06:00:00.000Z");
const TARGET: TrustedReleaseTarget = {
  projectId: "prj_expected",
  teamId: "team_expected",
  repository: "Surfaces-Platform/kanban.cards",
  productionBranch: "main",
  publicDomain: "kanban.cards",
  authDomain: "auth.kanban.cards"
};

test("a fully proven staged candidate passes the pre-promotion gate", () => {
  const evaluation = evaluateCutoverSnapshot(readySnapshot(), "pre-promotion", TARGET, NOW);
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.blockers));
  assert.equal(evaluation.candidate.deploymentId, "dpl_candidate");
});

test("overlapping true Git rules cannot bypass the main deployment block", () => {
  assert.equal(mainGitDeploymentsAreDisabled({ main: false }), true);
  assert.equal(mainGitDeploymentsAreDisabled({ main: false, "*": true }), false);
  assert.equal(mainGitDeploymentsAreDisabled({ "*": false }), false);
});

test("the operational CLI requires live state for promotion and post completion", () => {
  assert.throws(() => parseReleaseControllerArguments(["--snapshot", "proof.json", "--authorize-promotion", "--confirmation", PROMOTION_CONFIRMATION]), /require --live/);
  assert.throws(() => parseReleaseControllerArguments(["--snapshot", "proof.json", "--phase", "post-promotion"]), /require --live/);
  const parsed = parseReleaseControllerArguments(["--snapshot", "proof.json", "--live", "--authorize-promotion", "--confirmation", PROMOTION_CONFIRMATION, "--promote"]);
  assert.equal(parsed.promote, true);
});

test("pending binding blocks with zero promotion calls", async () => {
  const snapshot = readySnapshot();
  snapshot.evidence.prePromotion.health.access.legacyBinding = "pending";
  snapshot.evidence.prePromotion.accessHealth = { ...snapshot.evidence.prePromotion.accessHealth, status: 503, ok: false, legacyBinding: { present: false, status: "pending" } };
  let calls = 0;
  const result = await promoteVerifiedCandidate(snapshot, PROMOTION_CONFIRMATION, {
    async promote() { calls += 1; },
    async readPostPromotionSnapshot() { throw new Error("not reached"); },
    now: () => NOW
  }, TARGET);
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
  assert.ok(result.evaluation.blockers.some((blocker) => blocker.code === "legacy-binding-not-ready"));
});

test("Clerk proof and the full enabled bridge lifecycle are mandatory", () => {
  for (const field of ["authHostSurface", "authHostIsolation", "emailCodeAuth", "sameRootSessionShare", "sessionExchange", "exactLegacyBinding", "canonicalHandoff", "tenantProjectAccess", "tenantProjectWrite", "signOut"] as const) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.clerkProof[field] = "failed";
    const result = evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((blocker) => blocker.gate === "clerk-access"));
  }
  const unauthorizedParty = readySnapshot();
  unauthorizedParty.evidence.prePromotion.clerkAuthorizedParties = "failed";
  assert.ok(evaluateCutoverSnapshot(unauthorizedParty, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "clerk-authorized-parties"));
  const wrongDomainConfiguration = readySnapshot();
  wrongDomainConfiguration.evidence.prePromotion.clerkDomainConfiguration = "failed";
  assert.ok(evaluateCutoverSnapshot(wrongDomainConfiguration, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "clerk-domain-configuration"));
  for (const field of ["read", "create", "comment", "move", "archive"] as const) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.compatibilityProof[field] = "not-run";
    assert.equal(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).ok, false);
  }
});

test("legacy provider and callback evidence cannot satisfy Clerk gates", () => {
  const snapshot = readySnapshot();
  const legacyReceipt = snapshot.evidence.prePromotion as unknown as Record<string, unknown>;
  delete legacyReceipt.clerkAuthorizedParties;
  delete legacyReceipt.clerkDomainConfiguration;
  delete legacyReceipt.clerkProof;
  legacyReceipt.callbackRegistered = "passed";
  legacyReceipt.providerProof = {
    login: "passed",
    callback: "passed",
    exactLegacyBinding: "passed",
    canonicalHandoff: "passed",
    tenantProjectAccess: "passed",
    tenantProjectWrite: "passed"
  };
  const codes = new Set(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).blockers.map((blocker) => blocker.code));
  assert.ok(codes.has("clerk-authorized-parties"));
  assert.ok(codes.has("clerk-domain-configuration"));
  assert.ok(codes.has("clerk-auth-host-surface"));
  assert.ok(codes.has("clerk-auth-host-isolation"));
  assert.ok(codes.has("clerk-email-code-auth"));
  assert.ok(codes.has("clerk-same-root-session-share"));
  assert.ok(codes.has("clerk-session-exchange"));
  assert.ok(codes.has("clerk-sign-out"));
  assert.equal(codes.has("proof-callback-unregistered"), false);

  const obsoleteSyncReceipt = readySnapshot();
  const obsoleteClerkProof = obsoleteSyncReceipt.evidence.prePromotion.clerkProof as unknown as Record<string, unknown>;
  delete obsoleteClerkProof.sameRootSessionShare;
  obsoleteClerkProof.primarySatelliteSync = "passed";
  assert.ok(evaluateCutoverSnapshot(obsoleteSyncReceipt, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "clerk-same-root-session-share"));
});

test("disabled bridge requires explicit retirement negatives and closure", () => {
  const snapshot = readySnapshot();
  snapshot.evidence.prePromotion.accessHealth.legacyBridge = "disabled";
  snapshot.evidence.prePromotion.retirementProof.oldDeploymentsClosed = "not-run";
  const result = evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW);
  assert.ok(result.blockers.some((blocker) => blocker.code === "retirement-oldDeploymentsClosed"));
});

test("receipts are bound to phase, artifact, origin, and freshness", () => {
  const snapshot = readySnapshot();
  snapshot.evidence.prePromotion.deploymentId = "dpl_other";
  snapshot.evidence.prePromotion.observedAt = "2026-08-12T00:00:00.000Z";
  snapshot.evidence.prePromotion.origin = "https://kanban.cards";
  const codes = new Set(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).blockers.map((blocker) => blocker.code));
  assert.ok(codes.has("proof-deployment-id"));
  assert.ok(codes.has("proof-stale"));
  assert.ok(codes.has("proof-origin"));
});

test("pre-promotion admitted and external probes cover all three exact release hosts", () => {
  const admittedFailure = readySnapshot();
  admittedFailure.evidence.prePromotion.firewallProof.admittedProbe!.authHost.status = 403;
  assert.ok(evaluateCutoverSnapshot(admittedFailure, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-admitted-authHost-status"));

  const externalFailure = readySnapshot();
  externalFailure.evidence.prePromotion.firewallProof.externalDenyProbe!.candidateRoot.wafRuleId = "rule_other";
  assert.ok(evaluateCutoverSnapshot(externalFailure, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-external-candidateRoot-rule-id"));

  const canonicalExclusionFailure = readySnapshot();
  canonicalExclusionFailure.evidence.prePromotion.firewallProof.externalDenyProbe!.canonicalRoot.status = 403;
  assert.ok(evaluateCutoverSnapshot(canonicalExclusionFailure, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-canonical-root-exclusion"));
});

test("Standard Protection remains enabled before and after promotion", () => {
  const pre = readySnapshot();
  pre.policy.deploymentProtection = "all";
  assert.ok(evaluateCutoverSnapshot(pre, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "standard-protection-required"));

  const post = readyPostSnapshot();
  post.policy.deploymentProtection = "all";
  assert.ok(evaluateCutoverSnapshot(post, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "standard-protection-required"));
  post.policy.deploymentProtection = "all_except_custom_domains";
  assert.equal(evaluateCutoverSnapshot(post, "post-promotion", TARGET, NOW).ok, true);
});

test("candidate Firewall rules are exact, published, enabled, and ordered", () => {
  const disabled = readySnapshot();
  disabled.policy.firewall.firewallEnabled = false;
  assert.ok(evaluateCutoverSnapshot(disabled, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-disabled"));

  const draft = readySnapshot();
  draft.policy.firewall.hasDraft = true;
  draft.policy.firewall.pendingChanges = 1;
  assert.ok(evaluateCutoverSnapshot(draft, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-draft-present"));

  const reordered = readySnapshot();
  reordered.policy.firewall.rules.reverse();
  const reorderedCodes = new Set(evaluateCutoverSnapshot(reordered, "pre-promotion", TARGET, NOW).blockers.map((blocker) => blocker.code));
  assert.ok(reorderedCodes.has("candidate-firewall-bypass-invalid"));
  assert.ok(reorderedCodes.has("candidate-firewall-deny-invalid"));

  const wildcard = readySnapshot();
  const bypassHost = wildcard.policy.firewall.rules[0].conditionGroup[0].conditions[0];
  bypassHost.op = "suf";
  bypassHost.value = ["kanban.cards"];
  assert.ok(evaluateCutoverSnapshot(wildcard, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "candidate-firewall-bypass-invalid"));

  const persistentDeny = readySnapshot();
  (persistentDeny.policy.firewall.rules[1].action.mitigate as Record<string, unknown>).actionDuration = "30m";
  assert.ok(evaluateCutoverSnapshot(persistentDeny, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "candidate-firewall-deny-invalid"));

  const wrongHash = readySnapshot();
  wrongHash.evidence.prePromotion.firewallProof.configHash = "0".repeat(64);
  assert.ok(evaluateCutoverSnapshot(wrongHash, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-config-hash"));
});

test("post cleanup rejects renamed, partial, and pre-id Firewall leftovers", () => {
  const renamedSubset = readyPostSnapshot();
  renamedSubset.policy.firewall.rules = [{
    id: "rule_renamed",
    name: "renamed",
    active: false,
    _status: "live",
    conditionGroup: [{ conditions: [{ type: "host", op: "eq", value: "auth.kanban.cards" }] }],
    action: { mitigate: { action: "deny" } }
  }];
  assert.ok(evaluateCutoverSnapshot(renamedSubset, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "candidate-firewall-cleanup-incomplete"));

  const retainedId = readyPostSnapshot();
  retainedId.policy.firewall.rules = [{
    id: "rule_kanban_candidate_mike_bypass_3sYrrO",
    name: "unrelated-renamed-rule",
    active: false,
    _status: "live",
    conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: "/unrelated" }] }],
    action: { mitigate: { action: "log" } }
  }];
  assert.ok(evaluateCutoverSnapshot(retainedId, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-removed-rule-id-still-live"));
});

test("post-promotion cleanup and public reachability expectations are explicit", () => {
  for (const [field, code] of [["releaseRulesRemoved", "firewall-release-rules-removed"], ["noDraft", "firewall-no-draft"], ["authHostPublic", "firewall-auth-public"], ["canonicalRootPublic", "firewall-root-public"], ["canonicalTenantPublic", "firewall-tenant-public"], ["generatedDeploymentProtected", "firewall-generated-protected"]] as const) {
    const snapshot = readyPostSnapshot();
    snapshot.evidence.postPromotion.firewallProof[field] = "failed";
    assert.ok(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === code));
  }

  const externalFailure = readyPostSnapshot();
  externalFailure.evidence.postPromotion.firewallProof.externalPublicProbe!.authHost.status = 403;
  assert.ok(evaluateCutoverSnapshot(externalFailure, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-post-external-authHost"));
});

test("post-promotion completion requires both temporary candidate aliases to be absent", () => {
  const snapshot = readyPostSnapshot();
  snapshot.currentProduction = {
    ...snapshot.candidate,
    aliases: [
      "kanban.cards",
      "candidate.release.kanban.cards",
      "mike.candidate.release.kanban.cards"
    ],
    health: { status: 200, ok: true, store: "postgres" }
  };
  const blockers = evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers;
  assert.ok(blockers.some((blocker) => blocker.code === "candidate-root-alias-still-live"));
  assert.ok(blockers.some((blocker) => blocker.code === "candidate-tenant-alias-still-live"));
  snapshot.policy.aliases.push("candidate.release.kanban.cards", "mike.candidate.release.kanban.cards");
  const globalBlockers = evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers;
  assert.ok(globalBlockers.some((blocker) => blocker.code === "candidate-root-alias-still-routed"));
  assert.ok(globalBlockers.some((blocker) => blocker.code === "candidate-tenant-alias-still-routed"));
});

test("the exact auth origin must be pinned to and serve the candidate artifact", () => {
  const wrongOrigin = readySnapshot();
  wrongOrigin.evidence.prePromotion.authOrigin = "https://accounts.kanban.cards";
  assert.ok(evaluateCutoverSnapshot(wrongOrigin, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-auth-origin"));

  const reusedAsApplicationRoot = readySnapshot();
  reusedAsApplicationRoot.evidence.prePromotion.origin = "https://auth.kanban.cards";
  assert.ok(evaluateCutoverSnapshot(reusedAsApplicationRoot, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-origin"));

  const wrongDeployment = readySnapshot();
  wrongDeployment.evidence.prePromotion.authRouteDeploymentId = "dpl_other";
  assert.ok(evaluateCutoverSnapshot(wrongDeployment, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-auth-route-deployment-id"));

  const unpinned = readySnapshot();
  unpinned.evidence.prePromotion.authRoutePinned = "failed";
  assert.ok(evaluateCutoverSnapshot(unpinned, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-auth-route-not-pinned"));

  const differentArtifact = readySnapshot();
  differentArtifact.evidence.prePromotion.sameArtifactAuthHost = "failed";
  assert.ok(evaluateCutoverSnapshot(differentArtifact, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "auth-host-not-proven"));
});

test("pre-promotion root and tenant origins must be the exact same-root candidate family", () => {
  const invalid = readySnapshot();
  invalid.evidence.prePromotion.tenantOrigin = "https://tenant.candidate.example.com/projects";
  assert.ok(evaluateCutoverSnapshot(invalid, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-origin"));

  for (const wrongTenantOrigin of [
    "https://auth.kanban.cards",
    "https://candidate.release.kanban.cards",
    "https://candidate-abc.vercel.app",
    "https://kanban.cards"
  ]) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.tenantOrigin = wrongTenantOrigin;
    assert.ok(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-origin"));
  }

  const wrongRoot = readySnapshot();
  wrongRoot.evidence.prePromotion.origin = "https://candidate-root.example.com";
  assert.ok(evaluateCutoverSnapshot(wrongRoot, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-origin"));

  const exactSameRootRoutes = readySnapshot();
  exactSameRootRoutes.evidence.prePromotion.origin = "https://candidate.release.kanban.cards";
  exactSameRootRoutes.evidence.prePromotion.tenantOrigin = "https://mike.candidate.release.kanban.cards";
  assert.equal(evaluateCutoverSnapshot(exactSameRootRoutes, "pre-promotion", TARGET, NOW).ok, true);
});

test("post-promotion tenant origin must be a direct canonical tenant", () => {
  for (const invalidTenantOrigin of [
    "https://auth.kanban.cards",
    "https://kanban.cards",
    "https://nested.default.kanban.cards",
    "https://mike.candidate.release.kanban.cards",
    "https://default.kanban.cards/projects"
  ]) {
    const snapshot = readyPostSnapshot();
    snapshot.evidence.postPromotion.tenantOrigin = invalidTenantOrigin;
    assert.ok(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-post-tenant-origin"));
  }
});

test("only an exact Vercel Authentication redirect proves Standard protection on a generated deployment", () => {
  const requested = "https://candidate-abc.vercel.app/__kanban_cards_protection_probe__/probe-id";
  const nonce = "a".repeat(64);
  const cookie = `_vercel_sso_nonce=${"b".repeat(40)}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`;
  const redirect = `https://vercel.com/sso-api?url=${encodeURIComponent(requested)}&nonce=${nonce}`;
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, requested, cookie), true);
  assert.equal(isVercelSsoProtectionRedirect(307, redirect, requested, cookie), true);
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, `${requested}/different`, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://vercel.com/sso-api/login?url=${encodeURIComponent(requested)}&nonce=${nonce}`, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://vercel.com/sso-api?url=${encodeURIComponent(requested)}`, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, requested, ""), false);
  assert.equal(isVercelSsoProtectionRedirect(200, redirect, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://candidate.example/auth/login?url=${encodeURIComponent(requested)}&nonce=${nonce}`, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://vercel.com.evil.example/sso-api?url=${encodeURIComponent(requested)}&nonce=${nonce}`, requested, cookie), false);
});

test("candidate URL, rollback tuple, artifact SHA, and public boundary must be exact", () => {
  const snapshot = readySnapshot();
  snapshot.candidate.url = "https://kanban.cards";
  snapshot.candidate.commitSha = "short";
  snapshot.rollbackTarget.url = "https://wrong.vercel.app";
  const codes = new Set(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).blockers.map((blocker) => blocker.code));
  assert.ok(codes.has("deployment-url"));
  assert.ok(codes.has("commit-sha"));
  assert.ok(codes.has("identity-mismatch"));
});

test("all green gates still require the exact literal", () => {
  assert.equal(authorizePromotion(readySnapshot(), "yes", TARGET, NOW).authorized, false);
  assert.equal(authorizePromotion(readySnapshot(), PROMOTION_CONFIRMATION, TARGET, NOW).authorized, true);
});

test("exact promotion runs once and requires a distinct public post receipt", async () => {
  const calls: string[] = [];
  const post = readyPostSnapshot();
  const result = await promoteVerifiedCandidate(readySnapshot(), PROMOTION_CONFIRMATION, {
    async promote(id) { calls.push(id); },
    async readPostPromotionSnapshot() { return post; },
    now: () => NOW
  }, TARGET);
  assert.deepEqual(calls, ["dpl_candidate"]);
  assert.equal(result.status, "promoted", JSON.stringify(result.evaluation.blockers));
});

test("recycled pre receipt cannot pass post and does not auto rollback", async () => {
  const post = readyPostSnapshot();
  post.evidence.postPromotion = { ...post.evidence.prePromotion };
  const result = await promoteVerifiedCandidate(readySnapshot(), PROMOTION_CONFIRMATION, {
    async promote() {},
    async readPostPromotionSnapshot() { return post; },
    now: () => NOW
  }, TARGET);
  assert.equal(result.status, "post-promotion-failed");
  assert.ok(result.evaluation.blockers.some((blocker) => blocker.code === "proof-phase"));
  assert.ok(result.evaluation.blockers.some((blocker) => blocker.code === "proof-origin"));
});

test("post-promotion rollback must remain the exact pre-authorized predecessor", () => {
  const post = readyPostSnapshot();
  post.originalRollbackTarget = {
    id: "dpl_other_ready",
    url: "https://other-ready-abc.vercel.app",
    projectId: TARGET.projectId,
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    target: "production",
    readyState: "READY",
    verified: true
  };
  const result = evaluateCutoverSnapshot(post, "post-promotion", TARGET, NOW);
  assert.ok(result.blockers.some((blocker) => blocker.code === "predecessor-mismatch"));
});

function readySnapshot() {
  const candidateSha = "9009e2c0987f97a886889e392aca4ea46b696d2e";
  const productionSha = "bcc03d9d939535d942a8fc23eed9251bcd58fd3f";
  const releaseHosts = ["auth.kanban.cards", "candidate.release.kanban.cards", "mike.candidate.release.kanban.cards"];
  const firewall = {
    firewallEnabled: true,
    hasDraft: false,
    pendingChanges: 0,
    rules: [
      {
        id: "rule_kanban_candidate_mike_bypass_3sYrrO",
        name: CANDIDATE_FIREWALL_BYPASS_RULE,
        active: true,
        _status: "live",
        conditionGroup: [{ conditions: [
          { type: "host", op: "inc", value: releaseHosts },
          { type: "ip_address", op: "eq", value: "203.0.113.42/32" }
        ] }],
        action: { mitigate: { action: "bypass" } }
      },
      {
        id: "rule_kanban_candidate_deny_COy5mP",
        name: CANDIDATE_FIREWALL_DENY_RULE,
        active: true,
        _status: "live",
        conditionGroup: [{ conditions: [{ type: "host", op: "inc", value: releaseHosts }] }],
        action: { mitigate: { action: "deny" } }
      }
    ]
  };
  const postFirewall = { firewallEnabled: true, hasDraft: false, pendingChanges: 0, rules: [] };
  const firewallFacts = inspectCandidateFirewall(firewall, TARGET);
  const postFirewallFacts = inspectCandidateFirewall(postFirewall, TARGET);
  const receipt = (phase: "pre-promotion" | "post-promotion", runId: string, origin: string) => ({
    phase,
    runId,
    observedAt: phase === "pre-promotion" ? "2026-08-13T05:50:00.000Z" : "2026-08-13T05:55:00.000Z",
    deploymentId: "dpl_candidate",
    deploymentUrl: "https://candidate-abc.vercel.app",
    commitSha: candidateSha,
    origin,
    authOrigin: "https://auth.kanban.cards",
    tenantOrigin: phase === "pre-promotion" ? "https://mike.candidate.release.kanban.cards" : "https://mike.kanban.cards",
    routeDeploymentId: "dpl_candidate",
    routePinned: "passed",
    authRouteDeploymentId: "dpl_candidate",
    authRoutePinned: "passed",
    clerkAuthorizedParties: "passed",
    clerkDomainConfiguration: "passed",
    tenantRouteDeploymentId: "dpl_candidate",
    tenantRoutePinned: "passed",
    firewallProof: phase === "pre-promotion" ? {
      liveBypassRuleId: firewallFacts.bypassRuleId,
      liveDenyRuleId: firewallFacts.denyRuleId,
      reviewedSourceCidr: firewallFacts.reviewedSourceCidr,
      configHash: firewallFacts.configHash,
      admittedProbe: {
        configHash: firewallFacts.configHash,
        authHost: { status: 200, mitigated: "none", vercelId: "sfo1::admit-auth" },
        candidateRoot: { status: 200, mitigated: "none", vercelId: "sfo1::admit-root" },
        candidateTenant: { status: 302, mitigated: "none", vercelId: "sfo1::admit-tenant" }
      },
      externalDenyProbe: {
        observedSourceCidr: "198.51.100.23/32",
        configHash: firewallFacts.configHash,
        authHost: { status: 403, mitigated: "deny", wafAction: "deny", wafRuleId: firewallFacts.denyRuleId, vercelId: "iad1::deny-auth", observedAt: "2026-08-13T05:50:00.000Z" },
        candidateRoot: { status: 403, mitigated: "deny", wafAction: "deny", wafRuleId: firewallFacts.denyRuleId, vercelId: "iad1::deny-root", observedAt: "2026-08-13T05:50:00.000Z" },
        candidateTenant: { status: 403, mitigated: "deny", wafAction: "deny", wafRuleId: firewallFacts.denyRuleId, vercelId: "iad1::deny-tenant", observedAt: "2026-08-13T05:50:00.000Z" },
        canonicalRoot: { status: 200, ok: true, store: "postgres", mitigated: "none", vercelId: "iad1::public-root", observedAt: "2026-08-13T05:50:00.000Z" },
        canonicalTenant: { status: 302, mitigated: "none", vercelId: "iad1::public-tenant", observedAt: "2026-08-13T05:50:00.000Z" }
      }
    } : {
      removedRuleIds: [firewallFacts.bypassRuleId, firewallFacts.denyRuleId],
      configHash: postFirewallFacts.configHash,
      releaseRulesRemoved: "passed",
      noDraft: "passed",
      authHostPublic: "passed",
      canonicalRootPublic: "passed",
      canonicalTenantPublic: "passed",
      generatedDeploymentProtected: "passed",
      externalPublicProbe: {
        observedSourceCidr: "198.51.100.23/32",
        configHash: postFirewallFacts.configHash,
        authHost: { status: 200, mitigated: "none", vercelId: "iad1::post-auth", observedAt: "2026-08-13T05:55:00.000Z" },
        canonicalRoot: { status: 200, ok: true, store: "postgres", mitigated: "none", vercelId: "iad1::post-root", observedAt: "2026-08-13T05:55:00.000Z" },
        canonicalTenant: { status: 302, mitigated: "none", vercelId: "iad1::post-tenant", observedAt: "2026-08-13T05:55:00.000Z" }
      }
    },
    sameArtifactAuthHost: "passed",
    sameArtifactCanonicalHost: "passed",
    health: { status: 200, ok: true, store: "postgres", missingConfiguration: [], access: { registry: "ready", legacyState: "ready", legacyBinding: "ready" } },
    accessHealth: { status: 200, ok: true, legacyBridge: "enabled", registryState: "ready", legacyState: "ready", legacyBinding: { present: true, status: "ready" }, missingConfiguration: [] },
    clerkProof: { authHostSurface: "passed", authHostIsolation: "passed", emailCodeAuth: "passed", sameRootSessionShare: "passed", sessionExchange: "passed", exactLegacyBinding: "passed", canonicalHandoff: "passed", tenantProjectAccess: "passed", tenantProjectWrite: "passed", signOut: "passed" },
    compatibilityProof: { required: true, read: "passed", create: "passed", comment: "passed", move: "passed", archive: "passed", cardId: `card-${runId}`, finalCardVersion: 4 },
    retirementProof: { required: true, public401: "passed", legacy401: "passed", sibling401: "passed", oldDeploymentsClosed: "passed" },
    dataIntegrityProof: {
      realPostgres: true,
      beforeDigest: phase === "pre-promotion" ? "binding-state" : "candidate-final-state",
      afterDigest: phase === "pre-promotion" ? "binding-state" : "candidate-final-state",
      beforeResourceFingerprint: phase === "pre-promotion" ? "binding-resources" : "candidate-final-resources",
      afterResourceFingerprint: phase === "pre-promotion" ? "binding-resources" : "candidate-final-resources",
      finalCandidateDigest: "candidate-final-state",
      finalCandidateResourceFingerprint: "candidate-final-resources"
    }
  });
  return {
    policy: { projectId: TARGET.projectId, teamId: TARGET.teamId, repository: TARGET.repository, productionBranch: "main", autoAssignCustomDomains: false, mainGitDeploymentsEnabled: false, deploymentProtection: "all_except_custom_domains", firewall, aliases: ["auth.kanban.cards", "kanban.cards", "mike.kanban.cards"], aliasInventoryComplete: true },
    candidate: { id: "dpl_candidate", url: "https://candidate-abc.vercel.app", projectId: TARGET.projectId, commitSha: candidateSha, commitRef: "main", target: "production", readyState: "READY", aliases: [] },
    currentProduction: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, commitRef: "main", target: "production", readyState: "READY", aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } },
    evidence: {
      prePromotion: receipt("pre-promotion", "run-pre", "https://candidate.release.kanban.cards"),
      postPromotion: receipt("post-promotion", "run-post", "https://kanban.cards")
    },
    rollbackTarget: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, target: "production", readyState: "READY", verified: true },
    originalRollbackTarget: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, target: "production", readyState: "READY", verified: true },
    promotionReceipt: {
      candidateDeploymentId: "dpl_candidate",
      candidateUrl: "https://candidate-abc.vercel.app",
      candidateCommitSha: candidateSha,
      rollbackTarget: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, target: "production", readyState: "READY", verified: true },
      authorizedAt: "2026-08-13T05:52:00.000Z",
      promotedAt: "2026-08-13T05:53:00.000Z"
    }
  };
}

function readyPostSnapshot() {
  const snapshot = readySnapshot();
  snapshot.policy.firewall = { firewallEnabled: true, hasDraft: false, pendingChanges: 0, rules: [] };
  snapshot.currentProduction = { ...snapshot.candidate, aliases: ["auth.kanban.cards", "kanban.cards", "mike.kanban.cards"], health: { status: 200, ok: true, store: "postgres" } };
  return snapshot;
}
