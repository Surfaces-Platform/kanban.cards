# Workspace access migration

## Purpose

This migration adds tenant-aware owner access without changing the stored Project, Card, Comment, Activity, version, or idempotency-record shapes. The access registry is additive: it maps verified owner identities and canonical Workspace slugs to the existing `kanban_v2_workspaces` rows. It does not copy a Workspace merely to make it tenant-aware.

The first production migration requires three explicit operator-provided values:

- `legacyClerkUserId`: the exact stable Clerk user ID for the current owner (`KANBAN_CARDS_LEGACY_CLERK_USER_ID`)
- `legacyWorkspaceSlug`: the canonical hostname slug for the current Workspace
- `legacyWorkspaceName`: the owner-facing Workspace name

Those values bind the current Workspace to `kanban_v2_workspaces:default` only when a server-verified Clerk session presents the exact configured user ID. That ID must also appear in the exact `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS` admission list. Email and display name come from Clerk after session verification, never from migration environment values, and email is never an admission or binding key. The three values are migration inputs, not runtime fallbacks, and may be removed after the exact mapping is verified. A Clerk user ID absent from the admission list receives no Workspace access.

## Additive storage contract

The access registry must durably represent:

- Workspaces: stable id, canonical unique slug, display name, and state-row id
- Owners: stable id, unique verified Clerk user ID, Clerk-verified email and display name, and timestamps
- Workspace ownership: explicit owner-to-Workspace membership
- Handoffs: hashed token, owner and Workspace binding, exact destination, expiry, and consumption state

The legacy owner profile is copied only from the server-verified Clerk user at admission. Clerk client state, handoff, and API request fields cannot overwrite the stored Clerk user ID, email, or display name.

Root and tenant sessions are signed, expiring, host-only cookies. Their shared session-family identifier is the server-verified Clerk session ID and has a durable revocation record so sign-out invalidates root and sibling-Workspace cookies from the same Clerk sign-in. The initiating root or tenant first revokes both that family and the exact Clerk session. It then sends a short-lived signed continuation only in an exact-origin hidden POST to the family root, where a signed, short-lived, host-only completion marker preserves that exact Clerk session ID and authorizes browser-side cleanup. ClerkJS inspects its signed-in sessions, ends only the matching `Session` if it remains, and confirms that target is absent without touching any other browser account. A failed cleanup or confirmation leaves the marker for retry; success is acknowledged to the root, which consumes the marker before the persistent `Signed out` state renders. A bare URL query cannot complete sign-out. Any later persisted owner-authority skill credential must likewise store only a hash plus its explicit owner, Workspace, expiry, and revocation state. The bounded legacy bearer remains a deployment secret during cutover; it is not converted into an identity by adding it to the registry.

The same immutable release has one stable auth-only UI host at `KANBAN_CARDS_AUTH_HOST` and an exact protected candidate application family during pre-promotion proof: `candidate.release.kanban.cards` plus `mike.candidate.release.kanban.cards`, mapped to the legacy Workspace slug. The canonical root remains on the known-good predecessor, while the canonical tenant is deliberately unrouted until promotion; it must not expose the old owner-key artifact. The auth host serves only Clerk sign-in/sign-up UI; it does not expose Workspace, Project, handoff, or app-session exchange APIs. The Clerk production instance uses one normal FAPI DNS/custom-domain setup for the `kanban.cards` root domain, not an app-owned proxy per origin. ClerkJS runs on the auth host and exact canonical/candidate application roots. During protected candidate proof, Clerk Allowed Subdomains has explicit entries only for `auth.kanban.cards` and `candidate.release.kanban.cards`; the primary root `kanban.cards` is inherently allowed, and tenant hosts are excluded. The canonical and candidate application roots are under the same root domain and are not Clerk satellites. Each application root links to the exact auth host with its own exact return origin. After email-code completion, only the initiating application root may recognize and exchange its Clerk browser session. This topology uses no Clerk satellite or multi-domain feature; Clerk Hobby's production FAPI custom domain and email-code flow are sufficient. The candidate family never derives arbitrary sibling hosts or accepts additional Workspace routes beyond the single route covered by cutover evidence. Clerk session verification accepts only the auth host and exact configured application-root origins as request-scoped authorized parties; Clerk middleware is bypassed entirely on tenant and unknown hosts. Each kanban.cards root session, tenant session, logout retry, and one-time handoff is bound to its exact family origin or destination, so no app credential can cross from candidate to canonical hosts. Standard Protection remains enabled throughout. Candidate privacy comes from two published exact-host WAF rules: the highest-priority bypass is `(host in auth/candidate-root/candidate-tenant) AND (source equals Mike's reviewed exact /32 or /128)`, and the immediately following no-duration deny covers only that same three-host set. The canonical root and tenant are excluded from those rules; before promotion, an external canonical-tenant probe must instead prove the exact unmitigated Vercel `404` with `x-vercel-error: DEPLOYMENT_NOT_FOUND`. After promotion, the canonical tenant is routed to the exact promoted deployment, candidate aliases and the Clerk candidate Allowed Subdomains entry are removed while the deny remains live, and only then are both temporary rule IDs removed and published together. Public post-promotion proof requires a complete alias inventory, no temporary rule or host reference, no Firewall draft, a Standard-protected generated deployment, and fresh public auth/root/tenant observations from an exact source outside the retired bypass. Those observations bind distinct `x-vercel-id` values and unmitigated expected responses to the post-cleanup published-config hash; the canonical root must also prove healthy Postgres state.

The legacy mapping has one exact state-row binding:

```text
exact Clerk user ID
  -> owner membership in legacyWorkspaceSlug
  -> state row kanban_v2_workspaces:default
```

Each newly created Workspace receives a distinct immutable state-row id. No new Workspace may point at `default`, and no two Workspace registry records may point at the same state-row id. Request routing selects the state row only after host and credential validation; clients cannot supply or override a Workspace id, slug, or state-row id.

The migration must not alter the JSON stored in `kanban_v2_workspaces:default`. In particular, it preserves all resource ids, external keys, versions, revisions, timestamps, Markdown source, Comments, Activity, archive state, and idempotency records.

## Preflight, transaction, and concurrency requirements

Migration is safe to run repeatedly and concurrently:

1. Validate all three legacy inputs, require the legacy Clerk user ID to appear in the exact admission list, then require that user ID from the server-verified Clerk session.
2. Read `kanban_v2_workspaces:default` through the non-creating preflight path. A missing table, missing row, unsupported schema, malformed file, or storage error stops the Clerk session exchange before any access-registry mutation.
3. Begin the access-registry transaction and lock its singleton row before inspecting or writing owner, Workspace, or membership records.
4. Insert the legacy owner, Workspace, and membership with uniqueness constraints and conflict handling that accepts only the same canonical mapping.
5. Reject a conflicting Clerk user ID, slug, name, or state-row mapping. Never repair a conflict by choosing another owner or Workspace implicitly.
6. Commit the complete registry mapping atomically, then re-read it and verify the requested inputs and `stateRowId = default`.
7. Re-read the state row and compare it with the operator-recorded canonical digest.

The state preflight and registry write are deliberately not described as one cross-table transaction. The binding path never writes the V2 state row. Safety comes from a non-creating state check before the locked registry mutation, an atomic exact registry mapping, and operator-recorded before/after digests. A preflight failure leaves both stores untouched; a registry conflict leaves the accepted mapping and V2 state unchanged.

A second invocation with identical inputs is a successful no-op. Concurrent identical invocations converge on one owner, one Workspace, one membership, and one `default` binding. Concurrent conflicting invocations result in one complete mapping and one explicit failure; they never produce a partial or mixed mapping.

## Authentication cutover

The tenant-aware candidate must be verified before the public domain moves:

- Automatic Vercel deployments from `main` are disabled in repository configuration, and the Vercel Project keeps Auto-assign Custom Production Domains disabled. A merge cannot create or promote the production artifact.
- Candidate creation uses an explicit production-target `--skip-domain` deployment. The recorded commit SHA, deployment ID, immutable URL, linked Project, production target, and alias state must all agree.
- Standard Protection remains enabled; the Firewall is enabled with no draft, and the exact top-two bypass/deny rules are live-bound by rule ID, order, Boolean grouping, reviewed exact source CIDR, hydrated empty IP blocks, hydrated Attack Mode off, and a deterministic config hash that includes those facts.
- The complete pre-promotion Project alias inventory excludes the canonical tenant. One operator-trusted atomic external run records its exact source privately, a shared proof run ID, HTTP `403`, `x-vercel-mitigated: deny`, and distinct `x-vercel-id` values for all three release hosts while proving the canonical root remains healthy and the canonical tenant remains unrouted with Vercel's unmitigated `DEPLOYMENT_NOT_FOUND` `404`. Per-request Firewall Traffic may bind the exact deny rule directly; when it is unavailable, deterministic live-policy correlation derives the sole eligible deny rule from hydrated policy and rejects self-attested per-request rule/action fields.
- The unified Clerk email-code flow and server-side session exchange resolve the explicit legacy Clerk user ID to the legacy Workspace.
- The dedicated auth-only UI host is pinned to the exact candidate artifact, exposes only Clerk UI routes, and is protected during the pre-promotion proof; the single Clerk production FAPI DNS/custom domain is separately verified.
- The canonical and exact candidate application roots are same-root Clerk application origins, not satellites; ClerkJS uses the normal production FAPI, and the candidate returns from auth-host email-code completion to its exact origin and recognizes its Clerk session there.
- The root route offers only Workspaces explicitly owned by that admitted Clerk user ID.
- The exact candidate tenant reads the unchanged `default` state; the canonical tenant does so only after the explicit promotion and exact route assignment.
- Clerk user IDs absent from the exact admission list receive no Workspace and cannot discover the legacy Workspace.
- A tenant session, handoff, or interim skill credential for one Workspace cannot read or write another.
- A client-supplied Workspace selector is rejected or ignored in favor of authenticated server context, as specified by the endpoint contract.

The legacy bearer may exist only as a bounded cutover bridge. It is authorized exclusively for the mapped legacy Workspace and `default` state row; it cannot create, enumerate, or enter another Workspace. The cutover record must state when that bridge is disabled. Retirement means the token is absent from the active environment, `/api/access/health` reports `legacyBridge: disabled` while remaining healthy, Clerk root and tenant access still work, and the retired bearer returns `401`. There is no unadmitted-user fallback to the legacy owner, `default`, the first Workspace, or a request-supplied tenant.

## Rollback boundary

Because the migration leaves `kanban_v2_workspaces:default` intact, a known-good V2 artifact can continue to read and write the legacy Workspace during the rollback window. Re-promoting V3 must reveal those V2-era writes through the same `default` mapping.

That compatibility applies only to the legacy Workspace. New tenant rows require V3 routing and authentication, so rolling the application back to V2 makes new Workspaces unavailable. It does not delete their registry records or state rows. Operators must not describe rollback as full multi-tenant availability.

Before any new Workspace receives production writes, choose and record one policy:

- accept that rollback restores only the legacy Workspace while new Workspaces remain durably unavailable until V3 is restored; or
- implement and prove a separate compatibility mechanism that preserves tenant isolation.

Do not copy new-tenant data into `default`, merge tenant rows, or add a catch-all V2 fallback as a rollback shortcut.

## Cutover proof checklist

- [ ] Candidate commit is clean, fully validated, and recorded by exact SHA.
- [ ] Database backup or recovery point is recorded before the access-registry migration.
- [ ] The exact legacy Clerk user ID, Clerk-verified email and display name, Workspace slug, and Workspace name are reviewed without exposing credentials.
- [ ] The existing `kanban_v2_workspaces:default` row exists and passes schema validation.
- [ ] Pre-migration counts and a canonical digest of `default` are recorded, unless the exact migration-specific `historical-pre-binding-receipt-unavailable` exception in the cutover runbook is fully valid.
- [ ] The migration succeeds twice with identical inputs and leaves one exact mapping.
- [ ] A concurrent identical migration rehearsal converges without duplicates.
- [ ] A conflicting migration rehearsal fails atomically and leaves the accepted mapping unchanged.
- [ ] Post-migration counts and canonical digest prove the `default` state JSON is unchanged. The one accepted exception may replace only the unavailable historical before/after pair; its restored-PostgreSQL rehearsal and current baseline are explicitly not historical proof, and every other checklist item remains mandatory.
- [ ] The verified legacy owner reaches only the mapped legacy Workspace.
- [ ] A server-verified Clerk user ID absent from the exact admission list receives no implicit legacy access.
- [ ] Two-Workspace read, write, idempotency, and selector-isolation checks pass against real Postgres.
- [ ] Wrong-destination, replayed, and expired handoffs fail without setting a tenant cookie.
- [ ] A sibling-Workspace origin cannot perform a cookie-authenticated mutation.
- [ ] While enabled, the legacy bearer reaches only the legacy Workspace.
- [ ] Retirement proof shows Clerk access still works, `/api/access/health` reports `legacyBridge: disabled` and `ok: true`, and the retired bearer returns `401`.
- [ ] Candidate browser proof covers the single production FAPI DNS/custom domain; Allowed Subdomains enabled with exactly the two explicit entries `auth.kanban.cards` and `candidate.release.kanban.cards`; the inherently allowed primary root `kanban.cards`; the auth host's route fence; auth-host email-code completion; exact initiating application-root return and Clerk session recognition; server-side session exchange; root routing; exact-session Clerk sign-out with failed-cleanup retry and successful-cleanup acknowledgement; and the exact candidate tenant hostname. The dedicated auth, `candidate.release.kanban.cards`, and `mike.candidate.release.kanban.cards` routes are pinned to the exact deployment and bounded by the exact published top-two WAF rules. Admitted probes reach the app; one fresh external run uses either explicit platform-Traffic correlation or deterministic hydrated live-policy correlation, leaves the canonical root healthy, and proves the canonical tenant is not routed with the exact unmitigated Vercel `DEPLOYMENT_NOT_FOUND` `404`. The generated immutable hostname alone does not satisfy Clerk authorized-party or tenant-host proof.
- [ ] Candidate and canonical host-family proof verifies the exact Clerk root authorized parties, rejects unknown hosts, and rejects cross-family root-session, tenant-session, and handoff replay.
- [ ] `npm run release:gate` passes the complete pre-promotion snapshot and the literal explicit-promotion confirmation.
- [ ] The exact candidate artifact is promoted; production checks repeat the identity and isolation proofs.
- [ ] After explicit promotion, the canonical tenant route is assigned to the exact promoted deployment. With the deny still live, both candidate aliases are globally removed and the candidate Clerk Allowed Subdomains entry is absent; both recorded rule IDs are then removed in one published draft, and post proof confirms no draft/rule/host reference remains. From an exact source outside the retired bypass, fresh public auth/root/tenant observations bind distinct `x-vercel-id` values and the unmitigated expected responses to the post-cleanup config hash.

`GET /api/access/health` reports Clerk mode, registry availability, compatibility-bridge state, and coarse `legacyState` and `legacyBinding` readiness without exposing a Clerk user ID, email, display name, secret, Workspace id, or state-row id. It returns `503` for an unavailable registry, a required missing or invalid `default` state, or a pending or mismatched required binding. It is readiness evidence only; it does not replace the identity, isolation, handoff, database, or browser checks above.

The current access registry keeps consumed handoff and revoked-session-family records in its locked registry state. Before broad availability, add retention sized to the longest relevant session lifetime and prove that cleanup cannot revive a token or session. Until then, treat this implementation as a bounded pilot and monitor registry-row size and auth latency.

## Rollback proof checklist

- [ ] A known-good immutable V2 rollback artifact and its environment are identified before promotion.
- [ ] The dedicated auth alias rollback disposition is recorded: pin it to the exact rollback artifact when that artifact implements Clerk, or remove it when returning to the owner-key version; never leave a split-artifact auth host.
- [ ] A post-migration write to the legacy Workspace is visible through `kanban_v2_workspaces:default`.
- [ ] The V2 rollback artifact reads that write without a reverse data migration.
- [ ] A V2 write made during rollback remains visible after V3 is re-promoted.
- [ ] Access-registry rows and all new-tenant state rows remain present and unchanged through rollback.
- [ ] Operators confirm that new Workspaces are unavailable, not deleted, while V2 serves production.
- [ ] No alias or deployment retaining an unauthorized global legacy bearer can reach the database.
- [ ] If any rollback assertion fails, promotion stops before new tenant production writes are accepted.
