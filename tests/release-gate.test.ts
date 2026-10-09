import assert from "node:assert/strict";
import test from "node:test";

import { PROMOTION_CONFIRMATION, isVercelSsoProtectionRedirect, trustedReleaseTarget, type TrustedReleaseTarget } from "../src/release-gate";
import { mainGitDeploymentsAreDisabled, mainGitDeploymentsAreEnabled, verifiedProductionDomainNames } from "../src/release-policy";
import { evaluateSteadyRelease, parseSteadyReleaseArguments } from "../scripts/release-steady";

const TARGET: TrustedReleaseTarget = {
  projectId: "prj_expected", teamId: "team_expected", repository: "Surfaces-Platform/kanban.cards",
  productionBranch: "main", publicDomain: "kanban.cards", authDomain: "auth.kanban.cards"
};

test("release policy permits staged main builds and excludes branch or unverified custom domains", () => {
  assert.equal(mainGitDeploymentsAreEnabled(undefined), true);
  assert.equal(mainGitDeploymentsAreDisabled({ main: false }), true);
  assert.equal(mainGitDeploymentsAreDisabled({ main: false, "*": true }), false);
  assert.equal(mainGitDeploymentsAreDisabled({ "*": false }), true);
  assert.equal(mainGitDeploymentsAreEnabled(false), false);
  assert.equal(mainGitDeploymentsAreEnabled({ main: "false" }), false);
  assert.equal(mainGitDeploymentsAreEnabled({ "release/*": false }), false);
  assert.deepEqual(verifiedProductionDomainNames([
    { name: "kanban.cards", verified: true }, { name: "KANBAN.CARDS", verified: true },
    { name: "preview.kanban.cards", verified: true, gitBranch: "feature" },
    { name: "custom.kanban.cards", verified: true, customEnvironmentId: "env_custom" },
    { name: "missing.kanban.cards", verified: false }
  ]), ["kanban.cards"]);
  assert.equal(trustedReleaseTarget().repository, TARGET.repository);
});

test("promotion requires an exact deployment and literal authorization", () => {
  assert.throws(() => parseSteadyReleaseArguments(["--promote", "--confirmation", "yes"]), /literal confirmation/);
  assert.throws(() => parseSteadyReleaseArguments(["--promote", "--confirmation", PROMOTION_CONFIRMATION]), /exact --deployment id/);
  assert.throws(() => parseSteadyReleaseArguments(["--deployment", "https://candidate.vercel.app"]), /exact Vercel deployment id/);
  assert.throws(() => parseSteadyReleaseArguments(["--force"]), /Unknown argument/);
  assert.deepEqual(parseSteadyReleaseArguments(["--deployment", "dpl_candidate"]), { deploymentId: "dpl_candidate", promote: false, confirmation: "" });
  assert.deepEqual(parseSteadyReleaseArguments(["--promote", "--deployment", "dpl_candidate", "--confirmation", PROMOTION_CONFIRMATION]), { deploymentId: "dpl_candidate", promote: true, confirmation: PROMOTION_CONFIRMATION });
});

test("a clean exact Git deployment passes without requiring the previous runtime to use passkeys", () => {
  const facts = readyFacts();
  const result = evaluateSteadyRelease(facts, "pre-promotion", TARGET);
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.candidate.id, "dpl_candidate");
  assert.equal(result.rollbackTarget.id, "dpl_previous");
  facts.currentProduction.health.ok = false;
  assert.ok(evaluateSteadyRelease(facts, "pre-promotion", TARGET).blockers.some((entry) => entry.code === "current-health"));
});

test("release preflight blocks dirty sources, changed traffic policy, wrong repository, and unprotected candidates", () => {
  const changes: Array<[string, (facts: ReturnType<typeof readyFacts>) => void]> = [
    ["checkout-dirty", (facts) => { facts.checkout.clean = false; }],
    ["checkout-sha", (facts) => { facts.checkout.sha = "b".repeat(40); }],
    ["auto-domain-assignment", (facts) => { facts.policy.autoAssignCustomDomains = true; }],
    ["main-builds-disabled", (facts) => { facts.policy.mainGitDeploymentsEnabled = false; }],
    ["candidate-source", (facts) => { facts.candidate.source = "cli"; }],
    ["candidate-repository", (facts) => { facts.candidate.repository = "another/repo"; }],
    ["candidate-protection", (facts) => { facts.generatedDeploymentProtected = false; }],
    ["candidate-url", (facts) => { facts.candidate.url = "https://kanban.cards"; }]
  ];
  for (const [code, change] of changes) {
    const facts = readyFacts();
    change(facts);
    assert.ok(evaluateSteadyRelease(facts, "pre-promotion", TARGET).blockers.some((entry) => entry.code === code), code);
  }
});

test("new candidates require passkey authentication, a ready registry, and retired global credentials", () => {
  const changes: Array<[string, (facts: ReturnType<typeof readyFacts>) => void]> = [
    ["candidate-health-authentication", (facts) => { facts.candidateHealth.authentication = "local-owner-key"; }],
    ["candidate-health-registry", (facts) => { facts.candidateHealth.access.registry = "pending"; }],
    ["candidate-access", (facts) => { facts.candidateAccessHealth.registryState = "pending"; }],
    ["candidate-access-state", (facts) => { facts.candidateAccessHealth.legacyState = "pending"; }],
    ["candidate-access-legacy-bridge", (facts) => { facts.candidateAccessHealth.legacyBridge = "enabled"; }],
    ["candidate-health-configuration", (facts) => { facts.candidateHealth.missingConfiguration = ["SESSION_SECRET"]; }]
  ];
  for (const [code, change] of changes) {
    const facts = readyFacts();
    change(facts);
    assert.ok(evaluateSteadyRelease(facts, "pre-promotion", TARGET).blockers.some((entry) => entry.code === code), code);
  }
  const existingState = readyFacts();
  existingState.candidateAccessHealth.legacyState = "ready";
  assert.equal(evaluateSteadyRelease(existingState, "pre-promotion", TARGET).ok, true);
});

test("post-promotion proof requires exact public root, auth, and tenant routes", () => {
  const facts: any = readyFacts();
  facts.currentProduction = { ...facts.candidate };
  facts.publicHealth = facts.candidateHealth;
  facts.publicAccessHealth = facts.candidateAccessHealth;
  facts.routes = Object.fromEntries(["root", "auth", "tenant"].map((name) => [name, {
    deploymentId: facts.candidate.id, status: 200, ssoProtected: false, mitigated: ""
  }]));
  assert.equal(evaluateSteadyRelease(facts, "post-promotion", TARGET).ok, true);
  facts.routes.auth.deploymentId = "dpl_other";
  facts.routes.auth.ssoProtected = true;
  facts.routes.tenant.mitigated = "challenge";
  facts.policy.domains = facts.policy.domains.filter((domain: { name: string }) => domain.name !== "mike.kanban.cards");
  const codes = new Set(evaluateSteadyRelease(facts, "post-promotion", TARGET).blockers.map((entry) => entry.code));
  for (const code of ["route-auth", "auth-public-sso", "tenant-public-mitigated", "domain-mike.kanban.cards"]) assert.ok(codes.has(code), code);
});

test("only an exact Vercel Authentication redirect proves generated deployment protection", () => {
  const requested = "https://candidate-abc.vercel.app/__kanban_cards_protection_probe__/probe-id";
  const nonce = "a".repeat(64);
  const cookie = `_vercel_sso_nonce=${"b".repeat(40)}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`;
  const redirect = `https://vercel.com/sso-api?url=${encodeURIComponent(requested)}&nonce=${nonce}`;
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, requested, cookie), true);
  assert.equal(isVercelSsoProtectionRedirect(307, redirect, requested, cookie), true);
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, `${requested}/different`, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://vercel.com/sso-api/login?url=${encodeURIComponent(requested)}&nonce=${nonce}`, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `${redirect}&extra=1`, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, redirect, requested, ""), false);
  assert.equal(isVercelSsoProtectionRedirect(200, redirect, requested, cookie), false);
  assert.equal(isVercelSsoProtectionRedirect(302, `https://vercel.com.evil.example/sso-api?url=${encodeURIComponent(requested)}&nonce=${nonce}`, requested, cookie), false);
});

function readyFacts() {
  const candidate = {
    id: "dpl_candidate", url: "https://candidate-abc.vercel.app", projectId: TARGET.projectId,
    source: "git", repository: TARGET.repository, gitDirty: false, commitSha: "a".repeat(40),
    commitRef: "main", target: "production", readyState: "READY"
  };
  return {
    checkout: { clean: true, branch: "main", sha: candidate.commitSha },
    policy: {
      projectId: TARGET.projectId, teamId: TARGET.teamId, repository: TARGET.repository, productionBranch: TARGET.productionBranch,
      autoAssignCustomDomains: false, mainGitDeploymentsEnabled: true, deploymentProtection: "all_except_custom_domains",
      domains: ["kanban.cards", "auth.kanban.cards", "mike.kanban.cards"].map((name) => ({ name, verified: true }))
    },
    candidate,
    currentProduction: {
      id: "dpl_previous", url: "https://previous-abc.vercel.app", projectId: TARGET.projectId, commitSha: "b".repeat(40),
      commitRef: "main", target: "production", readyState: "READY",
      health: { status: 200, ok: true, store: "postgres", missingConfiguration: [] as string[] },
      accessHealth: { status: 200, ok: true, registryState: "ready" }
    },
    candidateHealth: { status: 200, ok: true, store: "postgres", authentication: "passkey-session+workspace", access: { registry: "ready" }, missingConfiguration: [] as string[] },
    candidateAccessHealth: { status: 200, ok: true, registryState: "ready", legacyState: "not-required", legacyBridge: "disabled", missingConfiguration: [] as string[] },
    generatedDeploymentProtected: true
  };
}
