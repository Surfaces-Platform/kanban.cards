# Workspace access migration

## Purpose

This migration adds tenant-aware owner access without changing the stored Project, Card, Comment, Activity, version, or idempotency-record shapes. The access registry is additive: it maps verified owner identities and canonical Workspace slugs to the existing `kanban_v2_workspaces` rows. It does not copy a Workspace merely to make it tenant-aware.

The first production migration requires three explicit operator-provided values:

- `legacyOwnerSubject`: the verified provider subject for the current owner
- `legacyWorkspaceSlug`: the canonical hostname slug for the current Workspace
- `legacyWorkspaceName`: the owner-facing Workspace name

Those values bind the current Workspace to `kanban_v2_workspaces:default` only when a provider-verified callback presents the exact configured subject. Email and display name come from that verified callback, never from migration environment values. The three values are migration inputs, not runtime fallbacks, and may be removed after the exact mapping is verified. An identity absent from the access registry receives no Workspace access.

## Additive storage contract

The access registry must durably represent:

- Workspaces: stable id, canonical unique slug, display name, and state-row id
- Owners: stable id, unique verified-provider subject, provider-verified email and display name, and timestamps
- Workspace ownership: explicit owner-to-Workspace membership
- Handoffs: hashed token, owner and Workspace binding, exact destination, expiry, and consumption state

The legacy owner profile is copied only from the verified provider result at admission. Callback, handoff, and API request fields cannot overwrite the stored provider subject, email, or display name.

Root and tenant sessions are signed, expiring, host-only cookies. Their shared session-family identifier has a durable revocation record so sign-out invalidates root and sibling-Workspace cookies from the same provider sign-in. Any later persisted owner-authority skill credential must likewise store only a hash plus its explicit owner, Workspace, expiry, and revocation state. The bounded legacy bearer remains a deployment secret during cutover; it is not converted into an identity by adding it to the registry.

The legacy mapping has one exact state-row binding:

```text
legacyOwnerSubject
  -> owner membership in legacyWorkspaceSlug
  -> state row kanban_v2_workspaces:default
```

Each newly created Workspace receives a distinct immutable state-row id. No new Workspace may point at `default`, and no two Workspace registry records may point at the same state-row id. Request routing selects the state row only after host and credential validation; clients cannot supply or override a Workspace id, slug, or state-row id.

The migration must not alter the JSON stored in `kanban_v2_workspaces:default`. In particular, it preserves all resource ids, external keys, versions, revisions, timestamps, Markdown source, Comments, Activity, archive state, and idempotency records.

## Preflight, transaction, and concurrency requirements

Migration is safe to run repeatedly and concurrently:

1. Validate all three legacy inputs, then require the exact subject from the provider-verified callback.
2. Read `kanban_v2_workspaces:default` through the non-creating preflight path. A missing table, missing row, unsupported schema, malformed file, or storage error stops the callback before any access-registry mutation.
3. Begin the access-registry transaction and lock its singleton row before inspecting or writing owner, Workspace, or membership records.
4. Insert the legacy owner, Workspace, and membership with uniqueness constraints and conflict handling that accepts only the same canonical mapping.
5. Reject a conflicting subject, slug, name, or state-row mapping. Never repair a conflict by choosing another owner or Workspace implicitly.
6. Commit the complete registry mapping atomically, then re-read it and verify the requested inputs and `stateRowId = default`.
7. Re-read the state row and compare it with the operator-recorded canonical digest.

The state preflight and registry write are deliberately not described as one cross-table transaction. The binding path never writes the V2 state row. Safety comes from a non-creating state check before the locked registry mutation, an atomic exact registry mapping, and operator-recorded before/after digests. A preflight failure leaves both stores untouched; a registry conflict leaves the accepted mapping and V2 state unchanged.

A second invocation with identical inputs is a successful no-op. Concurrent identical invocations converge on one owner, one Workspace, one membership, and one `default` binding. Concurrent conflicting invocations result in one complete mapping and one explicit failure; they never produce a partial or mixed mapping.

## Authentication cutover

The tenant-aware candidate must be verified before the public domain moves:

- Automatic Vercel deployments from `main` are disabled in repository configuration, and the Vercel Project keeps Auto-assign Custom Production Domains disabled. A merge cannot create or promote the production artifact.
- Candidate creation uses an explicit production-target `--skip-domain` deployment. The recorded commit SHA, deployment ID, immutable URL, linked Project, production target, and alias state must all agree.
- Provider-verified sign-in resolves the explicit legacy owner to the legacy Workspace.
- The root route offers only Workspaces explicitly owned by that subject.
- The canonical tenant host reads the unchanged `default` state.
- Unknown provider subjects receive no Workspace and cannot discover the legacy Workspace.
- A tenant session, handoff, or interim skill credential for one Workspace cannot read or write another.
- A client-supplied Workspace selector is rejected or ignored in favor of authenticated server context, as specified by the endpoint contract.

The legacy bearer may exist only as a bounded cutover bridge. It is authorized exclusively for the mapped legacy Workspace and `default` state row; it cannot create, enumerate, or enter another Workspace. The cutover record must state when that bridge is disabled. Retirement means the token is absent from the active environment, `/api/access/health` reports `legacyBridge: disabled` while remaining healthy, provider root and tenant access still work, and the retired bearer returns `401`. There is no unknown-identity fallback to the legacy owner, `default`, the first Workspace, or a request-supplied tenant.

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
- [ ] The legacy owner subject, verified email and display name, Workspace slug, and Workspace name are reviewed without exposing credentials.
- [ ] The existing `kanban_v2_workspaces:default` row exists and passes schema validation.
- [ ] Pre-migration counts and a canonical digest of `default` are recorded.
- [ ] The migration succeeds twice with identical inputs and leaves one exact mapping.
- [ ] A concurrent identical migration rehearsal converges without duplicates.
- [ ] A conflicting migration rehearsal fails atomically and leaves the accepted mapping unchanged.
- [ ] Post-migration counts and canonical digest prove the `default` state JSON is unchanged.
- [ ] The verified legacy owner reaches only the mapped legacy Workspace.
- [ ] An unknown verified identity receives no implicit legacy access.
- [ ] Two-Workspace read, write, idempotency, and selector-isolation checks pass against real Postgres.
- [ ] Wrong-destination, replayed, and expired handoffs fail without setting a tenant cookie.
- [ ] A sibling-Workspace origin cannot perform a cookie-authenticated mutation.
- [ ] While enabled, the legacy bearer reaches only the legacy Workspace.
- [ ] Retirement proof shows provider access still works, `/api/access/health` reports `legacyBridge: disabled` and `ok: true`, and the retired bearer returns `401`.
- [ ] Candidate browser proof covers root routing and the canonical tenant hostname through an approved protected candidate route pinned to the exact deployment. The generated immutable hostname alone does not satisfy provider callback or tenant-host proof.
- [ ] `npm run release:gate` passes the complete pre-promotion snapshot and the literal explicit-promotion confirmation.
- [ ] The exact candidate artifact is promoted; production checks repeat the identity and isolation proofs.

`GET /api/access/health` reports provider mode, registry availability, compatibility-bridge state, and coarse `legacyState` and `legacyBinding` readiness without exposing an owner subject, email, display name, secret, Workspace id, or state-row id. It returns `503` for an unavailable registry, a required missing or invalid `default` state, or a pending or mismatched required binding. It is readiness evidence only; it does not replace the identity, isolation, handoff, database, or browser checks above.

The current access registry keeps consumed handoff and revoked-session-family records in its locked registry state. Before broad availability, add retention sized to the longest relevant session lifetime and prove that cleanup cannot revive a token or session. Until then, treat this implementation as a bounded pilot and monitor registry-row size and auth latency.

## Rollback proof checklist

- [ ] A known-good immutable V2 rollback artifact and its environment are identified before promotion.
- [ ] A post-migration write to the legacy Workspace is visible through `kanban_v2_workspaces:default`.
- [ ] The V2 rollback artifact reads that write without a reverse data migration.
- [ ] A V2 write made during rollback remains visible after V3 is re-promoted.
- [ ] Access-registry rows and all new-tenant state rows remain present and unchanged through rollback.
- [ ] Operators confirm that new Workspaces are unavailable, not deleted, while V2 serves production.
- [ ] No alias or deployment retaining an unauthorized global legacy bearer can reach the database.
- [ ] If any rollback assertion fails, promotion stops before new tenant production writes are accepted.
