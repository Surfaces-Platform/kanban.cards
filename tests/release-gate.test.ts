import assert from "node:assert/strict";
import test from "node:test";

import { CANDIDATE_FIREWALL_BYPASS_RULE, CANDIDATE_FIREWALL_DENY_RULE, PROMOTION_CONFIRMATION, authorizePromotion, evaluateCutoverSnapshot, isVercelSsoProtectionRedirect, promoteVerifiedCandidate, unexpectedDeployableApplicationChanges, type TrustedReleaseTarget } from "../src/release-gate";
import { mainGitDeploymentsAreDisabled, mainGitDeploymentsAreEnabled } from "../src/release-policy";
import { parseReleaseControllerArguments } from "../src/release-controller";
import { evaluateSteadyRelease, parseSteadyReleaseArguments } from "../scripts/release-steady";

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

test("only an exact operator-only delta may reuse an application-equivalent candidate", () => {
  assert.deepEqual(unexpectedDeployableApplicationChanges([
    "src/release-gate.ts",
    "scripts/check-workspace-cutover.ts",
    "tests/release-gate.test.ts",
    "docs/runbook.md"
  ]), []);
  assert.deepEqual(unexpectedDeployableApplicationChanges([
    "api/index.ts",
    "src/server.ts",
    "vercel.json",
    "package-lock.json"
  ]), ["api/index.ts", "src/server.ts", "vercel.json", "package-lock.json"]);

  const equivalent = readySnapshot();
  equivalent.candidate.commitSha = "a".repeat(40);
  equivalent.evidence.prePromotion.commitSha = equivalent.candidate.commitSha;
  assert.equal(evaluateCutoverSnapshot(equivalent, "pre-promotion", TARGET, NOW).ok, true);
});

test("unavailable historical pre-binding evidence is not a release input", () => {
  const snapshot = readySnapshot();
  snapshot.evidence.prePromotion.dataIntegrityProof = { realPostgres: true, afterDigest: "focused-pre-promotion-state" };
  assert.equal(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).ok, true);
});

test("main deployment policy follows the default and matching true override", () => {
  assert.equal(mainGitDeploymentsAreDisabled({ main: false }), true);
  assert.equal(mainGitDeploymentsAreDisabled({ main: false, "*": true }), false);
  assert.equal(mainGitDeploymentsAreDisabled({ "*": false }), true);
  assert.equal(mainGitDeploymentsAreEnabled(false), false);
  assert.equal(mainGitDeploymentsAreEnabled({ main: "false" }), false);
});

test("steady releases enable staged main builds without auto-promoting traffic", () => {
  assert.equal(mainGitDeploymentsAreEnabled(undefined), true);
  assert.equal(mainGitDeploymentsAreEnabled({ main: false }), false);
  assert.throws(() => parseSteadyReleaseArguments(["--promote", "--confirmation", "yes"]), /literal confirmation/);
  assert.throws(() => parseSteadyReleaseArguments(["--promote", "--confirmation", PROMOTION_CONFIRMATION]), /exact --deployment id/);
  assert.deepEqual(parseSteadyReleaseArguments(["--deployment", "dpl_candidate"]), { deploymentId: "dpl_candidate", promote: false, confirmation: "" });

  const pre = steadyReleaseFacts();
  const evaluation = evaluateSteadyRelease(pre, "pre-promotion", TARGET);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.candidate.id, "dpl_candidate");
  assert.equal(evaluation.rollbackTarget.id, "dpl_previous");
  pre.policy.autoAssignCustomDomains = true;
  assert.ok(evaluateSteadyRelease(pre, "pre-promotion", TARGET).blockers.some((blocker) => blocker.code === "auto-domain-assignment"));

  const unhealthyRollback = steadyReleaseFacts();
  unhealthyRollback.currentProduction.health.ok = false;
  assert.ok(evaluateSteadyRelease(unhealthyRollback, "pre-promotion", TARGET).blockers.some((blocker) => blocker.code === "rollback-health"));

  const manualCandidate = steadyReleaseFacts();
  manualCandidate.candidate.source = "cli";
  assert.ok(evaluateSteadyRelease(manualCandidate, "pre-promotion", TARGET).blockers.some((blocker) => blocker.code === "candidate-source"));
});

test("steady post-promotion proof requires permanent domains and exact public routes", () => {
  const post = steadyReleaseFacts();
  post.currentProduction = { ...post.candidate };
  post.routes = {
    root: { deploymentId: post.candidate.id, status: 200, ssoProtected: false, mitigated: "" },
    auth: { deploymentId: post.candidate.id, status: 200, ssoProtected: false, mitigated: "" },
    tenant: { deploymentId: post.candidate.id, status: 200, ssoProtected: false, mitigated: "" }
  };
  post.publicHealth = post.candidateHealth;
  post.publicAccessHealth = post.candidateAccessHealth;
  assert.equal(evaluateSteadyRelease(post, "post-promotion", TARGET).ok, true);

  post.policy.domains = post.policy.domains.filter((domain: { name: string }) => domain.name !== "mike.kanban.cards");
  assert.ok(evaluateSteadyRelease(post, "post-promotion", TARGET).blockers.some((blocker) => blocker.code === "domain-mike.kanban.cards"));

  post.routes.auth.ssoProtected = true;
  assert.ok(evaluateSteadyRelease(post, "post-promotion", TARGET).blockers.some((blocker) => blocker.code === "auth-public-sso"));
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

test("Clerk isolation and one bounded compatibility read remain mandatory", () => {
  for (const field of ["authHostSurface", "authHostIsolation", "emailLinkAuth", "sameRootSessionShare", "sessionExchange", "exactLegacyBinding", "canonicalHandoff", "tenantProjectAccess", "tenantProjectWrite", "signOut"] as const) {
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
  const missingRead = readySnapshot();
  missingRead.evidence.prePromotion.compatibilityProof.read = "not-run";
  assert.ok(evaluateCutoverSnapshot(missingRead, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "read-failed"));

  const retiredLifecycle = readySnapshot();
  Object.assign(retiredLifecycle.evidence.prePromotion.compatibilityProof, {
    create: "not-run",
    comment: "not-run",
    move: "not-run",
    archive: "not-run"
  });
  assert.equal(evaluateCutoverSnapshot(retiredLifecycle, "pre-promotion", TARGET, NOW).ok, true);
});

test("AgentConnection lifecycle and isolation proof is mandatory before and after promotion", () => {
  const fields = [
    ["credentialIssuedOnce", "agent-credential-issued-once"],
    ["scopeEnforcement", "agent-scope-enforcement"],
    ["workspaceHostIsolation", "agent-workspace-host-isolation"],
    ["activityAttribution", "agent-activity-attribution"],
    ["revocation", "agent-revocation"]
  ] as const;
  for (const phase of ["pre-promotion", "post-promotion"] as const) {
    for (const [field, code] of fields) {
      const missing = phase === "pre-promotion" ? readySnapshot() : readyPostSnapshot();
      delete (missing.evidence[phase === "pre-promotion" ? "prePromotion" : "postPromotion"].agentConnectionProof as Record<string, unknown>)[field];
      assert.ok(evaluateCutoverSnapshot(missing, phase, TARGET, NOW).blockers.some((blocker) => blocker.code === code));

      const notRun = phase === "pre-promotion" ? readySnapshot() : readyPostSnapshot();
      notRun.evidence[phase === "pre-promotion" ? "prePromotion" : "postPromotion"].agentConnectionProof[field] = "not-run";
      assert.ok(evaluateCutoverSnapshot(notRun, phase, TARGET, NOW).blockers.some((blocker) => blocker.code === code));
    }
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
  assert.ok(codes.has("clerk-email-link-auth"));
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

test("one fresh independent candidate-root denial remains mandatory", () => {
  const denied = readySnapshot();
  denied.evidence.prePromotion.firewallProof.externalDenyProbe!.candidateRoot.status = 200;
  assert.ok(evaluateCutoverSnapshot(denied, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-external-candidate-root"));

  const sameSource = readySnapshot();
  sameSource.evidence.prePromotion.firewallProof.externalDenyProbe!.observedSourceCidr = "203.0.113.42/32";
  assert.ok(evaluateCutoverSnapshot(sameSource, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-external-source"));

  const stale = readySnapshot();
  stale.evidence.prePromotion.firewallProof.externalDenyProbe!.candidateRoot.observedAt = "2026-08-12T00:00:00.000Z";
  assert.ok(evaluateCutoverSnapshot(stale, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "firewall-external-candidate-root-stale"));
});

test("complete pre-promotion alias inventory keeps an established canonical tenant on the rollback target", () => {
  const incomplete = readySnapshot();
  incomplete.policy.aliasInventoryComplete = false;
  assert.ok(evaluateCutoverSnapshot(incomplete, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "alias-inventory-incomplete"));

  for (const alias of ["mike.kanban.cards", "https://mike.kanban.cards"]) {
    const established = readySnapshot();
    established.policy.aliases.push(alias);
    established.currentProduction.aliases.push(alias);
    assert.equal(evaluateCutoverSnapshot(established, "pre-promotion", TARGET, NOW).ok, true);

    const unverified = readySnapshot();
    unverified.policy.aliases.push(alias);
    assert.ok(evaluateCutoverSnapshot(unverified, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "canonical-tenant-alias-unverified"));

    const candidateOwned = readySnapshot();
    candidateOwned.policy.aliases.push(alias);
    candidateOwned.currentProduction.aliases.push(alias);
    candidateOwned.candidate.aliases = [alias];
    assert.ok(evaluateCutoverSnapshot(candidateOwned, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "canonical-tenant-alias-candidate"));

    const unhealthyBaseline = readySnapshot();
    unhealthyBaseline.policy.aliases.push(alias);
    unhealthyBaseline.currentProduction.aliases.push(alias);
    unhealthyBaseline.currentProduction.health.authentication = "local-owner-key";
    assert.ok(evaluateCutoverSnapshot(unhealthyBaseline, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "canonical-tenant-auth-not-ready"));
  }

  for (const [field, blockerCode] of [
    ["registry", "canonical-tenant-registry-not-ready"],
    ["legacyState", "canonical-tenant-legacyState-not-ready"],
    ["legacyBinding", "canonical-tenant-legacyBinding-not-ready"]
  ] as const) {
    const unhealthyAccess = readySnapshot();
    unhealthyAccess.policy.aliases.push("mike.kanban.cards");
    unhealthyAccess.currentProduction.aliases.push("mike.kanban.cards");
    unhealthyAccess.currentProduction.health.access[field] = "not-ready";
    assert.ok(evaluateCutoverSnapshot(unhealthyAccess, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === blockerCode));
  }
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

  const broadSource = readySnapshot();
  broadSource.policy.firewall.rules[0].conditionGroup[0].conditions[1].value = "203.0.113.0/24";
  assert.ok(evaluateCutoverSnapshot(broadSource, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "candidate-firewall-bypass-invalid"));
});

test("post cleanup rejects temporary-host leftovers without inventorying unrelated rule IDs", () => {
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

  const unrelatedRetainedId = readyPostSnapshot();
  unrelatedRetainedId.policy.firewall.rules = [{
    id: "rule_kanban_candidate_mike_bypass_3sYrrO",
    name: "unrelated-renamed-rule",
    active: false,
    _status: "live",
    conditionGroup: [{ conditions: [{ type: "path", op: "eq", value: "/unrelated" }] }],
    action: { mitigate: { action: "log" } }
  }];
  assert.equal(evaluateCutoverSnapshot(unrelatedRetainedId, "post-promotion", TARGET, NOW).ok, true);
});

test("post-promotion cleanup and public reachability expectations are explicit", () => {
  for (const [field, code] of [["releaseRulesRemoved", "firewall-release-rules-removed"], ["authHostPublic", "firewall-auth-public"], ["canonicalRootPublic", "firewall-root-public"], ["canonicalTenantPublic", "firewall-tenant-public"], ["generatedDeploymentProtected", "firewall-generated-protected"]] as const) {
    const snapshot = readyPostSnapshot();
    snapshot.evidence.postPromotion.firewallProof[field] = "failed";
    assert.ok(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === code));
  }

});

test("project domain registry and exact route proof outrank deployment alias metadata", () => {
  const snapshot = readyPostSnapshot();
  snapshot.currentProduction.aliases = ["kanbancards-surfaces-platform.vercel.app"];
  assert.equal(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).ok, true);

  snapshot.policy.domains = snapshot.policy.domains.filter((domain: { name: string }) => domain.name !== "kanban.cards");
  assert.ok(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "public-domain-unregistered"));
});

test("post-promotion keeps one focused real-Postgres preservation check", () => {
  const wrongBaseline = readyPostSnapshot();
  wrongBaseline.evidence.postPromotion.dataIntegrityProof.beforeDigest = "different-pre-promotion-state";
  assert.ok(evaluateCutoverSnapshot(wrongBaseline, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "promotion-baseline-digest"));

  const changed = readyPostSnapshot();
  changed.evidence.postPromotion.dataIntegrityProof.afterDigest = "changed-production-state";
  assert.ok(evaluateCutoverSnapshot(changed, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "state-digest-changed"));

  const wrongStore = readyPostSnapshot();
  wrongStore.evidence.postPromotion.dataIntegrityProof.realPostgres = false;
  assert.ok(evaluateCutoverSnapshot(wrongStore, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "not-real-postgres"));
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
    health: snapshot.currentProduction.health
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

  const applicationUnpinned = readySnapshot();
  applicationUnpinned.evidence.prePromotion.routePinned = "failed";
  assert.ok(evaluateCutoverSnapshot(applicationUnpinned, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-route-not-pinned"));

  const tenantUnpinned = readySnapshot();
  tenantUnpinned.evidence.prePromotion.tenantRoutePinned = "failed";
  assert.ok(evaluateCutoverSnapshot(tenantUnpinned, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-route-not-pinned"));

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
      externalDenyProbe: {
        observedSourceCidr: "198.51.100.23/32",
        candidateRoot: { status: 403, mitigated: "deny", vercelId: "iad1::deny-root", observedAt: "2026-08-13T05:50:00.000Z" }
      }
    } : {
      releaseRulesRemoved: "passed",
      authHostPublic: "passed",
      canonicalRootPublic: "passed",
      canonicalTenantPublic: "passed",
      generatedDeploymentProtected: "passed"
    },
    sameArtifactAuthHost: "passed",
    sameArtifactCanonicalHost: "passed",
    health: { status: 200, ok: true, store: "postgres", missingConfiguration: [], access: { registry: "ready", legacyState: "ready", legacyBinding: "ready" } },
    accessHealth: { status: 200, ok: true, legacyBridge: "enabled", registryState: "ready", legacyState: "ready", legacyBinding: { present: true, status: "ready" }, missingConfiguration: [] },
    clerkProof: { authHostSurface: "passed", authHostIsolation: "passed", emailLinkAuth: "passed", sameRootSessionShare: "passed", sessionExchange: "passed", exactLegacyBinding: "passed", canonicalHandoff: "passed", tenantProjectAccess: "passed", tenantProjectWrite: "passed", signOut: "passed" },
    agentConnectionProof: { credentialIssuedOnce: "passed", scopeEnforcement: "passed", workspaceHostIsolation: "passed", activityAttribution: "passed", revocation: "passed" },
    compatibilityProof: { required: true, read: "passed" },
    retirementProof: { required: true, public401: "passed", legacy401: "passed", sibling401: "passed", oldDeploymentsClosed: "passed" },
    dataIntegrityProof: phase === "post-promotion"
      ? { realPostgres: true, beforeDigest: "focused-pre-promotion-state", afterDigest: "focused-pre-promotion-state" }
      : { realPostgres: true, afterDigest: "focused-pre-promotion-state" }
  });
  return {
    policy: { projectId: TARGET.projectId, teamId: TARGET.teamId, repository: TARGET.repository, productionBranch: "main", autoAssignCustomDomains: false, mainGitDeploymentsEnabled: true, deploymentProtection: "all_except_custom_domains", domains: [{ name: "kanban.cards", verified: true }, { name: "auth.kanban.cards", verified: true }, { name: "mike.kanban.cards", verified: true }], firewall, aliases: ["auth.kanban.cards", "candidate.release.kanban.cards", "mike.candidate.release.kanban.cards", "kanban.cards"], aliasInventoryComplete: true },
    candidate: { id: "dpl_candidate", url: "https://candidate-abc.vercel.app", projectId: TARGET.projectId, source: "git", repository: TARGET.repository, gitDirty: false, commitSha: candidateSha, commitRef: "main", target: "production", readyState: "READY", aliases: [] as string[] },
    currentProduction: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, commitRef: "main", target: "production", readyState: "READY", aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres", authentication: "clerk-session+workspace", access: { registry: "ready", legacyState: "ready", legacyBinding: "ready" } } },
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
  snapshot.policy.aliases = ["auth.kanban.cards", "kanban.cards", "mike.kanban.cards"];
  snapshot.currentProduction = { ...snapshot.candidate, aliases: ["auth.kanban.cards", "kanban.cards", "mike.kanban.cards"], health: snapshot.currentProduction.health };
  return snapshot;
}

function steadyReleaseFacts(): any {
  const candidate = {
    id: "dpl_candidate",
    url: "https://candidate-abc.vercel.app",
    projectId: TARGET.projectId,
    source: "git",
    repository: TARGET.repository,
    gitDirty: false,
    commitSha: "a".repeat(40),
    commitRef: "main",
    target: "production",
    readyState: "READY"
  };
  return {
    checkout: { clean: true, branch: "main", sha: candidate.commitSha },
    policy: {
      projectId: TARGET.projectId,
      teamId: TARGET.teamId,
      repository: TARGET.repository,
      productionBranch: TARGET.productionBranch,
      autoAssignCustomDomains: false,
      mainGitDeploymentsEnabled: true,
      deploymentProtection: "all_except_custom_domains",
      domains: [
        { name: "kanban.cards", verified: true },
        { name: "auth.kanban.cards", verified: true },
        { name: "mike.kanban.cards", verified: true }
      ]
    },
    candidate,
    currentProduction: {
      id: "dpl_previous",
      url: "https://previous-abc.vercel.app",
      projectId: TARGET.projectId,
      commitSha: "b".repeat(40),
      commitRef: "main",
      target: "production",
      readyState: "READY",
      health: { status: 200, ok: true, store: "postgres", missingConfiguration: [] },
      accessHealth: { status: 200, ok: true, registryState: "ready", legacyState: "ready", legacyBinding: { status: "ready" } }
    },
    candidateHealth: { status: 200, ok: true, store: "postgres", missingConfiguration: [] },
    candidateAccessHealth: { status: 200, ok: true, registryState: "ready", legacyState: "ready", legacyBinding: { status: "ready" } },
    generatedDeploymentProtected: true
  };
}
