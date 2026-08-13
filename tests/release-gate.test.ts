import assert from "node:assert/strict";
import test from "node:test";

import { PROMOTION_CONFIRMATION, authorizePromotion, evaluateCutoverSnapshot, isVercelSsoProtectionRedirect, promoteVerifiedCandidate, type TrustedReleaseTarget } from "../src/release-gate";
import { mainGitDeploymentsAreDisabled } from "../src/release-policy";
import { parseReleaseControllerArguments } from "../src/release-controller";

const NOW = new Date("2026-08-13T06:00:00.000Z");
const TARGET: TrustedReleaseTarget = {
  projectId: "prj_expected",
  teamId: "team_expected",
  repository: "Surfaces-Platform/kanban.cards",
  productionBranch: "main",
  publicDomain: "kanban.cards"
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

test("provider and full enabled bridge lifecycle are mandatory", () => {
  for (const field of ["login", "callback", "tenantProjectWrite"] as const) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.providerProof[field] = "failed";
    assert.equal(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).ok, false);
  }
  for (const field of ["read", "create", "comment", "move", "archive"] as const) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.compatibilityProof[field] = "not-run";
    assert.equal(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).ok, false);
  }
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

test("pre-promotion root and tenant routes must both be protected", () => {
  const rootUnprotected = readySnapshot();
  rootUnprotected.evidence.prePromotion.routeProtected = "failed";
  assert.ok(evaluateCutoverSnapshot(rootUnprotected, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-route-unprotected"));

  const tenantUnprotected = readySnapshot();
  tenantUnprotected.evidence.prePromotion.tenantRouteProtected = "failed";
  assert.ok(evaluateCutoverSnapshot(tenantUnprotected, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-route-unprotected"));
});

test("pre-promotion tenant origin must be exact and distinct", () => {
  const invalid = readySnapshot();
  invalid.evidence.prePromotion.tenantOrigin = "https://tenant.candidate.example.com/projects";
  assert.ok(evaluateCutoverSnapshot(invalid, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-origin"));

  for (const reused of [
    "https://cutover-root-surfaces-platform.vercel.app",
    "https://candidate-abc.vercel.app",
    "https://kanban.cards"
  ]) {
    const snapshot = readySnapshot();
    snapshot.evidence.prePromotion.tenantOrigin = reused;
    assert.ok(evaluateCutoverSnapshot(snapshot, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-origin-reused"));
  }

  const customRoot = readySnapshot();
  customRoot.evidence.prePromotion.origin = "https://candidate-root.example.com";
  assert.ok(evaluateCutoverSnapshot(customRoot, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-origin-platform"));

  const customTenant = readySnapshot();
  customTenant.evidence.prePromotion.tenantOrigin = "https://candidate-tenant.example.com";
  assert.ok(evaluateCutoverSnapshot(customTenant, "pre-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-tenant-origin-platform"));
});

test("post-promotion tenant origin must be a direct canonical tenant", () => {
  for (const invalidTenantOrigin of [
    "https://kanban.cards",
    "https://nested.default.kanban.cards",
    "https://candidate-tenant.example.com",
    "https://default.kanban.cards/projects"
  ]) {
    const snapshot = readySnapshot();
    snapshot.currentProduction = { ...snapshot.candidate, aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } };
    snapshot.evidence.postPromotion.tenantOrigin = invalidTenantOrigin;
    assert.ok(evaluateCutoverSnapshot(snapshot, "post-promotion", TARGET, NOW).blockers.some((blocker) => blocker.code === "proof-post-tenant-origin"));
  }
});

test("only an unauthenticated Vercel SSO redirect proves route protection", () => {
  const requested = "https://cutover-root-surfaces-platform.vercel.app/__kanban_cards_protection_probe__/probe-id";
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
  const post = readySnapshot();
  post.currentProduction = { ...post.candidate, aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } };
  const result = await promoteVerifiedCandidate(readySnapshot(), PROMOTION_CONFIRMATION, {
    async promote(id) { calls.push(id); },
    async readPostPromotionSnapshot() { return post; },
    now: () => NOW
  }, TARGET);
  assert.deepEqual(calls, ["dpl_candidate"]);
  assert.equal(result.status, "promoted", JSON.stringify(result.evaluation.blockers));
});

test("recycled pre receipt cannot pass post and does not auto rollback", async () => {
  const post = readySnapshot();
  post.currentProduction = { ...post.candidate, aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } };
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
  const post = readySnapshot();
  post.currentProduction = { ...post.candidate, aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } };
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
  const receipt = (phase: "pre-promotion" | "post-promotion", runId: string, origin: string) => ({
    phase,
    runId,
    observedAt: phase === "pre-promotion" ? "2026-08-13T05:50:00.000Z" : "2026-08-13T05:55:00.000Z",
    deploymentId: "dpl_candidate",
    deploymentUrl: "https://candidate-abc.vercel.app",
    commitSha: candidateSha,
    origin,
    tenantOrigin: phase === "pre-promotion" ? "https://cutover-tenant-surfaces-platform.vercel.app" : "https://default.kanban.cards",
    routeDeploymentId: "dpl_candidate",
    routePinned: "passed",
    routeProtected: phase === "pre-promotion" ? "passed" : "not-required",
    callbackRegistered: "passed",
    tenantRouteDeploymentId: "dpl_candidate",
    tenantRoutePinned: "passed",
    tenantRouteProtected: phase === "pre-promotion" ? "passed" : "not-required",
    sameArtifactCanonicalHost: "passed",
    health: { status: 200, ok: true, store: "postgres", missingConfiguration: [], access: { registry: "ready", legacyState: "ready", legacyBinding: "ready" } },
    accessHealth: { status: 200, ok: true, legacyBridge: "enabled", registryState: "ready", legacyState: "ready", legacyBinding: { present: true, status: "ready" }, missingConfiguration: [] },
    providerProof: { login: "passed", callback: "passed", exactLegacyBinding: "passed", canonicalHandoff: "passed", tenantProjectAccess: "passed", tenantProjectWrite: "passed" },
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
    policy: { projectId: TARGET.projectId, teamId: TARGET.teamId, repository: TARGET.repository, productionBranch: "main", autoAssignCustomDomains: false, mainGitDeploymentsEnabled: false, deploymentProtection: "all_except_custom_domains" },
    candidate: { id: "dpl_candidate", url: "https://candidate-abc.vercel.app", projectId: TARGET.projectId, commitSha: candidateSha, commitRef: "main", target: "production", readyState: "READY", aliases: [] },
    currentProduction: { id: "dpl_known_good", url: "https://known-good-abc.vercel.app", projectId: TARGET.projectId, commitSha: productionSha, commitRef: "main", target: "production", readyState: "READY", aliases: ["kanban.cards"], health: { status: 200, ok: true, store: "postgres" } },
    evidence: {
      prePromotion: receipt("pre-promotion", "run-pre", "https://cutover-root-surfaces-platform.vercel.app"),
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
