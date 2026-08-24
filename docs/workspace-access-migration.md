# Workspace access migration

This is a one-time protected migration and audit record, not the steady-state deployment process. Ordinary product changes use the fast lane in [`runbook.md`](runbook.md); return here only when authentication, authorization, tenant routing, compatibility retirement, or durable data boundaries change.

## Purpose

This migration adds tenant-aware owner access without changing the stored Project, Card, Comment, Activity, version, or idempotency-record shapes. The access registry is additive: it maps verified owner identities and canonical Workspace slugs to the existing `kanban_v2_workspaces` rows. It does not copy a Workspace merely to make it tenant-aware.

The first production migration requires three explicit operator-provided values:

- `legacyClerkUserId`: the exact stable Clerk user ID for the current owner (`KANBAN_CARDS_LEGACY_CLERK_USER_ID`)
- `legacyWorkspaceSlug`: the canonical hostname slug for the current Workspace
- `legacyWorkspaceName`: the owner-facing Workspace name

Those values bind the current Workspace to `kanban_v2_workspaces:default` only when a server-verified Clerk session presents the exact configured legacy user ID. Email and display name come from Clerk after session verification and are never binding or authorization keys. `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS` remains optional migration input and does not gate self-service owners.

## Additive storage contract

The access registry must durably represent:

- Workspaces: stable id, canonical unique slug, display name, and state-row id
- Owners: stable id, unique verified Clerk user ID, Clerk-verified email and display name, and timestamps
- Workspace ownership: explicit owner-to-Workspace membership
- Handoffs: hashed token, owner and Workspace binding, exact destination, expiry, and consumption state

The legacy owner profile is copied only from the server-verified Clerk user at admission. Clerk client state, handoff, and API request fields cannot overwrite the stored Clerk user ID, email, or display name.

Root and tenant sessions are signed, expiring, host-only cookies. Their shared session-family identifier is the server-verified Clerk session ID and has a durable revocation record so sign-out invalidates root and sibling-Workspace cookies from the same Clerk sign-in. The initiating root or tenant first revokes both that family and the exact Clerk session. It then sends a short-lived signed continuation only in an exact-origin hidden POST to the family root, where a signed, short-lived, host-only completion marker preserves that exact Clerk session ID and authorizes browser-side cleanup. ClerkJS inspects its signed-in sessions, ends only the matching `Session` if it remains, and confirms that target is absent without touching any other browser account. A failed cleanup or confirmation leaves the marker for retry; success is acknowledged to the root, which consumes the marker before the persistent `Signed out` state renders. A bare URL query cannot complete sign-out. Any later persisted owner-authority skill credential must likewise store only a hash plus its explicit owner, Workspace, expiry, and revocation state. The bounded legacy bearer remains a deployment secret during cutover; it is not converted into an identity by adding it to the registry.

The same immutable application release has one stable auth-only host and one protected candidate family: `auth.kanban.cards`, `candidate.release.kanban.cards`, and `mike.candidate.release.kanban.cards`. The auth host exposes Clerk UI but no Workspace APIs. Clerk and application sessions accept only the configured exact origins; tenant and unknown hosts never enter Clerk middleware, and root sessions, tenant sessions, and handoffs cannot cross host families. Standard Protection stays enabled. Two published exact-host WAF rules admit one reviewed exact source and deny everyone else. One fresh request to the candidate root from a different exact source must receive Vercel's `403` deny response before promotion. The WAF policy itself proves that the same deny covers all three candidate hosts; a five-host atomic receipt is not required. After promotion, the temporary aliases, Clerk candidate subdomain, and temporary WAF rules are removed, while the public auth, root, and canonical tenant routes remain pinned to the promoted application.

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

1. Validate all three legacy inputs, then require that exact legacy user ID from the server-verified Clerk session.
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

- Git deployments from `main` create a staged Production artifact, while the Vercel Project keeps Auto-assign Custom Production Domains disabled. A merge builds but cannot promote production traffic.
- Candidate selection reuses the staged Production deployment created from validated `main`; it is never rebuilt as a second manual deploy. The deployment ID, immutable URL, linked Project, production target, commit metadata, and alias state must agree. The live controller accepts a differing clean-`main` SHA only when the exact Git delta is operator-only, while relevant runtime configuration remains bound by direct live checks.
- Standard Protection remains enabled; the Firewall is enabled with no draft, and the exact top-two bypass/deny rules retain their order, exact host set, exact admitted source, and actions.
- The complete pre-promotion alias inventory excludes the canonical tenant. One fresh candidate-root request from an exact source outside the admitted address returns HTTP `403`, `x-vercel-mitigated: deny`, and an `x-vercel-id`.
- The Clerk email-link flow returns to the exact initiating root, whose server-side session exchange resolves the legacy Clerk user ID to the legacy Workspace.
- The dedicated auth-only UI host is pinned to the exact candidate artifact, exposes only Clerk UI routes, and is protected during the pre-promotion proof; the single Clerk production FAPI DNS/custom domain is separately verified.
- The canonical and exact candidate application roots are same-root Clerk application origins, not satellites; the candidate returns from auth-host email-link completion to its exact origin and recognizes its Clerk session there.
- The root route offers only Workspaces owned by that Clerk user ID.
- The exact candidate tenant reads the unchanged `default` state; the canonical tenant does so only after the explicit promotion and exact route assignment.
- A different Clerk user ID may create its own Workspace but cannot discover or enter the legacy Workspace.
- A tenant session, handoff, or interim skill credential for one Workspace cannot read or write another.
- A client-supplied Workspace selector is rejected or ignored in favor of authenticated server context, as specified by the endpoint contract.

The legacy bearer may exist only as a bounded cutover bridge. It is authorized exclusively for the mapped legacy Workspace and `default` state row; it cannot create, enumerate, or enter another Workspace. Retirement means the token is absent, `/api/access/health` reports `legacyBridge: disabled`, and the retired bearer returns `401`. New owners never fall back to the legacy owner, `default`, the first Workspace, or a request-supplied tenant.

## Rollback boundary

Because the migration leaves `kanban_v2_workspaces:default` intact, a known-good V2 artifact can continue to read and write the legacy Workspace during the rollback window. Re-promoting V3 must reveal those V2-era writes through the same `default` mapping.

That compatibility applies only to the legacy Workspace. New tenant rows require V3 routing and authentication, so rolling the application back to V2 makes new Workspaces unavailable. It does not delete their registry records or state rows. Operators must not describe rollback as full multi-tenant availability.

Before any new Workspace receives production writes, choose and record one policy:

- accept that rollback restores only the legacy Workspace while new Workspaces remain durably unavailable until V3 is restored; or
- implement and prove a separate compatibility mechanism that preserves tenant isolation.

Do not copy new-tenant data into `default`, merge tenant rows, or add a catch-all V2 fallback as a rollback shortcut.

## One-time migration record

These items establish audit history for `roadmap:v3-workspace-access-v1`; they are not reusable release gates:

- [ ] Record a database backup or recovery point and review the exact legacy owner and Workspace inputs without exposing credentials.
- [ ] Verify `kanban_v2_workspaces:default` exists and passes schema validation.
- [ ] Run the documented migration twice with identical inputs, the concurrent identical rehearsal, and the conflicting-input rehearsal.
- [ ] Preserve the isolated restored-PostgreSQL rehearsal showing that only access/binding metadata changes and product data survives retry and recovery.

Mike accepted on `2026-08-22T02:19:24Z` that a historical production pre-binding receipt was not captured and cannot be reconstructed. The retained production dump and isolated rehearsal are the strongest available evidence, but neither the rehearsal nor current state is historical proof. The retained audit anchors are acceptance receipt SHA-256 `c158f2351dc33b7a7b2d4862f08f3d2901fdd7acda58dc65914a9b8a66a62bb5`, production dump SHA-256 `b79b370a4284872e255adf4f087fd85150f668fe89391ac17c06bdcf56db9097`, and rehearsal receipt SHA-256 `1235ba3110d414f6a5755f05ae6c9954ca7322c5feadfbc1a1ce0b7e263588bd`. This limitation is audit documentation only: it is not an evaluator exception, receipt object, candidate binding, or promotion blocker.

## Permanent release controls

- [ ] A clean validated checkout identifies the candidate deployment. The live controller verifies exact Git provenance or an exact operator-only Git delta, then binds relevant runtime configuration through the immutable deployment, protected routes, readiness, Clerk, and WAF checks.
- [ ] The candidate is READY, production-targeted, private, and pinned to the exact auth, candidate-root, and candidate-tenant routes. Standard Protection, enabled staged `main` builds, disabled automatic domain assignment, and the exact published candidate WAF policy remain active.
- [ ] One fresh candidate-root request from an independent exact source receives HTTP `403` with Vercel deny mitigation. No multi-host atomic receipt, traffic-correlation package, or source-switch choreography is required.
- [ ] `/api/health` and `/api/access/health` report healthy Postgres, ready registry/state/binding, and no missing configuration.
- [ ] Exact Clerk authorized parties, auth-host isolation, email-link sign-up/sign-in, exact-root return, session exchange, first Workspace creation, tenant handoff, tenant read/write, and exact-session sign-out pass.
- [ ] Automated and existing live sign-out evidence cover failure/retry behavior; a new same-session forced failure is not required for every release.
- [ ] If the compatibility bridge is enabled, one bounded read proves it reaches only the mapped legacy Workspace. Card creation, comments, movement, archival, and board comments are not release evidence. If disabled, the retirement negatives and old-deployment closure still pass.
- [ ] A distinct exact known-good rollback deployment is healthy and recorded before promotion.
- [ ] `npm run release:cutover` passes and promotion receives the literal explicit authorization.
- [ ] Post-promotion proof is a later distinct run covering public health, authentication, exact routing, a focused unchanged-data digest, temporary alias/WAF/Clerk cleanup, and the retained rollback target.

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
