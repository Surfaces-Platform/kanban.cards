# Runbook

This runbook covers local verification, tenant-aware access migration, candidate proof, promotion, compatibility-credential rotation, and rollback.

## Operating boundary

The Clerk-verified browser session is bound to one canonical Workspace host. The interim API credential grants read and write access only to the explicitly mapped legacy Workspace. Treat that credential like a password:

- Generate a high-entropy value with a password manager or secure random generator.
- Store production values only in the deployment environment and user-scoped skill configuration.
- Never place the key in a repository file, command argument, log, or screenshot.
- Treat `X-Kanban-Actor` as an attribution label, not an identity or permission boundary.
- Treat `.kanban-cards.json` as Project selection, not access control.

One way to generate a 256-bit key is:

```bash
openssl rand -hex 32
```

Copy the result directly into the approved password manager and deployment environment. Do not put the generated value into another command.

The browser uses a Clerk session plus separate signed kanban.cards root and tenant cookies after server-side Clerk verification and a one-time exact-host handoff. The stable Clerk user ID is the owner identity and the Clerk session ID is the app session-family identifier; email is never an admission or binding key. The CLI stores the compatibility key in `~/.kanban-cards/config.json` with mode `0600` and sends it as a bearer token. A deployment using a rotated compatibility key requires CLI setup again but does not define browser identity. Older immutable deployment URLs retain their original environment snapshot; protect or retire them separately.

## Runtime contract

Production requires:

- `KANBAN_CARDS_ROOT_HOST=kanban.cards`
- `KANBAN_CARDS_AUTH_HOST=auth.kanban.cards`, the exact stable auth-only application host. The server derives `https://auth.kanban.cards/sign-in`; `/sign-up` is retained as a successful shell entry that the client canonicalizes to `/sign-in` with `history.replaceState` while preserving the query and fragment. There are no independently configured auth-flow URLs. Clerk's production FAPI DNS/custom domain is configured separately through Clerk's normal production-domain setup.
- Vercel Marketplace's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, plus `CLERK_SECRET_KEY`, `CLERK_ENCRYPTION_KEY`, and `SESSION_SECRET`. `CLERK_PUBLISHABLE_KEY` remains accepted as a compatibility alias, but both names must match if both are set. Vercel production rejects Clerk development-instance keys: the Marketplace values must start with `pk_live_` and `sk_live_`. The last two app-owned values must each be at least 32 bytes; the encryption key is required because Clerk middleware selects the exact root configuration at request time.
- `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS`, a comma-separated list of exact admitted Clerk user IDs. It is required in production; the configured legacy user ID must be included.
- one of `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`

The Clerk instance must be a production instance configured for email verification codes and one sign-in path. Disable self-service sign-up navigation and do not require a name or any profile field after email verification. Before candidate proof, rename every customer-visible Clerk application label to `kanban.cards` and verify that no generated provider resource, environment, or school name appears in the rendered flow; this external configuration change is a release prerequisite, not a repository-controlled result. Clerk Hobby's required small `Secured by Clerk` badge may remain and must stay subordinate to the form. Create the allowed Clerk user, record the stable user ID without the email or credentials, and add that exact ID to `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS`. A successful email-code verification does not itself grant access; an admitted identity with zero Workspaces may create its first Workspace after sign-in.

Complete Clerk's one normal production FAPI DNS/custom-domain setup for the `kanban.cards` root domain; use the exact DNS names and targets supplied by Clerk and verify them before candidate proof. Do not configure an app-owned `/__clerk` proxy on the auth host or either application root. During protected candidate proof, enable Allowed Subdomains and enter exactly `auth.kanban.cards` and `candidate.release.kanban.cards`; the primary root `kanban.cards` is inherently allowed and must not be entered as a subdomain. After the candidate aliases are removed, remove `candidate.release.kanban.cards` from Clerk before restoring public access, leaving only `auth.kanban.cards` explicitly allowed. Never include `mike.kanban.cards`, `mike.candidate.release.kanban.cards`, wildcards, generated deployment hostnames, or any other tenant/unknown host. The same artifact serves the three app surfaces: the auth host redirects `/` and `/index.html` to `/sign-in`; `/sign-up` loads the shell and is client-canonicalized to `/sign-in`. It exposes one Clerk email-code sign-in component only at canonical `/sign-in` and otherwise exposes only the public session configuration needed by ClerkJS and static shell assets; it rejects Workspace, Project, handoff, and app-session exchange APIs. ClerkJS runs on the auth host and both exact application roots against the single validated production FAPI origin derived from the publishable key. Restrict each request's `authorizedParties` to its exact auth or application origin. Each signed-out application root navigates directly to the auth form and carries the exact initiating application-root return. On return, that same application root must recognize its Clerk browser session before the app exchanges it. Tenant hosts accept only kanban.cards app-session cookies and never load ClerkJS. This topology uses one root domain, requires no Clerk satellite or multi-domain feature, and is supported by Clerk Hobby with its production FAPI custom domain and email-code flow. The Clerk-compatible CSP intentionally permits Clerk's runtime inline styles, bot-protection frames/scripts, protected-service connections, image host, and blob workers; do not remove those directives without replacing them with a tested nonce-based policy.

Optional:

- `KANBAN_CARDS_API_TOKEN` and `KANBAN_CARDS_API_WORKSPACE_ID=default` while the skill compatibility bridge remains enabled
- `KANBAN_CARDS_LEGACY_CLERK_USER_ID`, `KANBAN_CARDS_LEGACY_WORKSPACE_SLUG`, and `KANBAN_CARDS_LEGACY_WORKSPACE_NAME` during legacy cutover; set all three together
- `KANBAN_CARDS_OWNER_LABEL`
- `KANBAN_CARDS_SESSION_TTL_SECONDS`, the canonical TTL for local, Clerk root, and Clerk tenant app-session cookies. Deprecated `ROOT_SESSION_TTL_SECONDS` and `TENANT_SESSION_TTL_SECONDS` remain compatibility aliases only when this value is absent; if either is also set, its numeric value must match.
- the bounded pre-promotion family: `KANBAN_CARDS_CANDIDATE_ROOT_HOST=candidate.release.kanban.cards` and `KANBAN_CARDS_CANDIDATE_TENANT_HOSTS={"mike":"mike.candidate.release.kanban.cards"}`; set both together. Extra mappings are rejected because the cutover proves exactly one tenant route. The server derives Clerk's exact authorized parties from the dedicated auth host plus the configured canonical and candidate application roots; there is no callback URI and Clerk does not authenticate tenant requests.

Local operator controls:

- `KANBAN_CARDS_DATA_PATH`
- `KANBAN_CARDS_ROOT_HOST`
- `HOST`
- `PORT`

`KANBAN_CARDS_POSTGRES_SSL=disable` is available for a trusted local database. Do not use it in production.

Use the Clerk-free owner-key fallback for ordinary local development. Real Clerk production email-code proof runs on the approved deployed candidate only after the single production FAPI DNS/custom domain and exact Allowed Subdomains list are verified. `localhost` remains available for deterministic Clerk gateway/browser tests; numeric-IP subdomains are not a supported tenant topology.

The public application shell and dedicated auth-host sign-in entry load without prior authentication. The signed-out session contract contains only public configuration: the exact current origin, publishable key, validated `clerkFrontendApiOrigin`, `clerkSurfaceRole` (`auth` or `app`), server-derived auth-host flow URLs, and finite exact application return origins. It contains no app-owned Clerk proxy URL. Clerk and app secrets remain server-only. The auth host denies application data and session-exchange routes; application Project data returns `503` when required configuration is missing and `401` when the host/session or compatibility credential is invalid. Follow [`workspace-access-migration.md`](workspace-access-migration.md) before any tenant-aware promotion; it is the governing data, cutover, and rollback checklist.

## Validate the candidate commit

Run from the repository root:

```bash
npm ci
npm run check
npm test
node --import tsx --test tests/release-gate.test.ts
git status --short
git rev-parse HEAD
```

`git status --short` must be empty. Record the full commit SHA. New application deployments must come from a commit that passed validation. A later operator-only evaluator or documentation change may inspect an older application-equivalent candidate only when the live Git delta is limited to the evaluator's exact operator-only allowlist and all direct live configuration checks still pass. `npm run check` includes `npm run check:release-policy`; that policy fails unless automatic deployments from `main` remain disabled in `vercel.json`.

Passing automation confirms the implementation contract. It does not prove the deployed database, browser rendering, Clerk environment, real email-code flow, or exact admission list.

The CLI test exercises setup, repository binding, create deduplication, comments, movement, stale-version protection, Activity, and credential permissions inside isolated temporary state. Do not overwrite the operator's real local workspace or user-scoped CLI connection merely to repeat that automated loop by hand.

## Verify Vercel scope and configuration

Before reading or changing environment variables, storage, deployments, aliases, or rollback state, verify the active Vercel identity and linked Project:

```bash
vercel whoami
vercel project inspect
vercel project protection
npm run release:preflight
```

Confirm the expected account or team, the `kanban.cards` Project, and its deployment-protection boundary. Stop on any mismatch. Repeat this preflight immediately before a later Vercel mutation if the session, terminal, or active scope may have changed.

Two independent controls keep a merge from moving production traffic:

- `vercel.json` sets `git.deploymentEnabled.main` to `false`, so the Git integration cannot create a deployment from a `main` push or merge.
- In Vercel Project Settings → Environments → Production → Branch Tracking, **Auto-assign Custom Production Domains** must remain disabled. The live Project API must report `autoAssignCustomDomains: false`.

The first control is repository-enforced and covered by `npm run check:release-policy`. `npm run release:preflight` reads the linked Vercel Project and fails unless the exact Project/team/repository, `main` production branch, disabled domain auto-assignment, local `main` deployment block, and generated-deployment protection all agree. Run it before every candidate and immediately before promotion. If either control is absent, stop. Do not use `github.autoAlias: false`; that changes a merged build into a Preview-environment artifact and cannot prove the production environment that will serve after promotion.

Keep Vercel Standard Protection (`all_except_custom_domains`) enabled throughout the release. Protect only the temporary dress-rehearsal surface with two published Vercel WAF custom rules. Rule priority is part of the release contract:

1. `kanban-candidate-mike-bypass` is the highest-priority rule. Its single condition group is `(host in the exact three-host set) AND (ip_address equals the reviewed operator /32 or /128)`, and its action is `bypass`. The existing rule name is retained for operational continuity; it does not make a person part of the release identity.
2. `kanban-candidate-deny` follows immediately. Its only condition is `host in the same exact three-host set`, and its action is `deny` with no duration.

The host set is exactly `auth.kanban.cards`, `candidate.release.kanban.cards`, and `mike.candidate.release.kanban.cards`. Do not use a wildcard, broader CIDR, or persistent action duration. `kanban.cards` and `mike.kanban.cards` are excluded.

The two rule additions and their ordering are draft changes until published. Stage both, place the bypass first and deny second, inspect the exact conditions/actions, and review the complete diff. Publishing is an explicit external security mutation; neither `Land this`, candidate deployment, nor promotion authority publishes Firewall changes. The operator must publish only after reviewing the draft:

```bash
KANBAN_CARDS_REVIEWED_SOURCE_CIDR='replace-with-reviewed-exact-ip/32-or-128'
vercel firewall rules add "kanban-candidate-mike-bypass" \
  --condition '{"type":"host","op":"inc","value":["auth.kanban.cards","candidate.release.kanban.cards","mike.candidate.release.kanban.cards"]}' \
  --condition "{\"type\":\"ip_address\",\"op\":\"eq\",\"value\":\"$KANBAN_CARDS_REVIEWED_SOURCE_CIDR\"}" \
  --action bypass --yes
vercel firewall rules add "kanban-candidate-deny" \
  --condition '{"type":"host","op":"inc","value":["auth.kanban.cards","candidate.release.kanban.cards","mike.candidate.release.kanban.cards"]}' \
  --action deny --yes
vercel firewall rules reorder "kanban-candidate-mike-bypass" --first --yes
vercel firewall rules reorder "kanban-candidate-deny" --position 2 --yes
vercel firewall rules inspect "kanban-candidate-mike-bypass" --json
vercel firewall rules inspect "kanban-candidate-deny" --json
vercel firewall diff --json
# The authorized operator reviews the exact draft, then runs:
vercel firewall publish --yes
vercel firewall overview --json
npm run release:preflight
```

The live pre-promotion gate reads the published policy and complete alias inventory once. From a different exact `/32` or `/128`, make one fresh request to `https://candidate.release.kanban.cards`; it must return HTTP `403`, `x-vercel-mitigated: deny`, and an `x-vercel-id`. Record only that source and observation in `externalDenyProbe`. The exact WAF rule already covers the other two private hosts, so no five-host package, Traffic correlation, configuration hash, or coordinated source-switch script is required. Stop on an unpublished draft, a policy mismatch, a routed canonical tenant, or a failed independent denial.

The Clerk Marketplace connection automatically syncs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to the connected Vercel environments. Verify those two names are present; do not manually add duplicate copies. The production values must belong to the Marketplace production instance (`pk_live_` and `sk_live_`), but do not print them to prove that condition—the deployed readiness check fails closed on development keys.

Configure every app-owned value through the Vercel dashboard or interactive CLI. Do not use `--value` for secrets, identity lists, or JSON because it places values in command history. For this legacy cutover, the database, root/auth topology, exact admitted user, exact legacy binding, and finite candidate family must all be present before deployment. Add the compatibility token only when the recorded cutover plan still requires the skill bridge.

```bash
vercel env list production
vercel env add KANBAN_CARDS_DATABASE_URL production --sensitive
vercel env add CLERK_ENCRYPTION_KEY production --sensitive
vercel env add SESSION_SECRET production --sensitive
vercel env add KANBAN_CARDS_ROOT_HOST production
vercel env add KANBAN_CARDS_AUTH_HOST production
vercel env add KANBAN_CARDS_ALLOWED_CLERK_USER_IDS production --sensitive
vercel env add KANBAN_CARDS_LEGACY_CLERK_USER_ID production --sensitive
vercel env add KANBAN_CARDS_LEGACY_WORKSPACE_SLUG production
vercel env add KANBAN_CARDS_LEGACY_WORKSPACE_NAME production
vercel env add KANBAN_CARDS_CANDIDATE_ROOT_HOST production
vercel env add KANBAN_CARDS_CANDIDATE_TENANT_HOSTS production --sensitive
```

Use `vercel env update` instead of `vercel env add` for a name that already exists. Re-run `vercel env list production` and verify the complete name/target inventory without revealing values. A partial topology is a deployment blocker.

Bridge-only configuration:

```bash
vercel env add KANBAN_CARDS_API_TOKEN production --sensitive
vercel env add KANBAN_CARDS_API_WORKSPACE_ID production
```

If an enabled bridge variable already exists, update it interactively:

```bash
vercel env update KANBAN_CARDS_API_TOKEN production --sensitive
vercel env update KANBAN_CARDS_DATABASE_URL production --sensitive
```

List names and targets without printing values:

```bash
vercel env list production
```

## Initialize storage

For a legacy cutover, `kanban_v2_workspaces:default` must already exist and pass the V2 schema check. `KANBAN_CARDS_LEGACY_CLERK_USER_ID` must contain the exact stable Clerk user ID, that ID must appear in `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS`, and the server-verified Clerk session exchange uses a non-creating read before it binds the access registry. A missing table, missing row, unsupported schema, storage error, unadmitted ID, or different Clerk ID returns a failure before any owner or Workspace mapping is written. The candidate must never turn a wrong or empty database into a valid-looking legacy Workspace.

`npm run db:init` remains available only for an explicitly new V2 store when a database URL is already present in the current process. Do not run it as a repair during legacy migration; restore or select the intended existing database instead. Do not rely on `vercel env run` to inject a sensitive database value into the local shell. If an initializer is deliberately used for a new store, it must report:

```text
Initialized V2 postgres workspace at kanban_v2_workspaces:default
```

Stop if it reports `file`. For a future migration, record a backup or recovery point plus a before/after digest when the before state is still available. For this migration, the historical production pre-binding receipt was not captured. Mike accepted that limitation on `2026-08-22T02:19:24Z`; the retained production dump and isolated restored-PostgreSQL rehearsal are audit evidence, not reconstructed historical proof and not release-gate inputs.

For the first V2 release, preserve any environment configuration needed by the previous known-good deployment until V2 has passed production verification.

## Create a candidate deployment

Because `main` Git deployments are disabled, merging does not build or promote anything. Create the candidate as a separate explicit action. Deploy the validated commit to the production target without assigning the production domain:

```bash
vercel whoami
vercel project inspect
git status --short
git rev-parse HEAD
vercel deploy --prod --skip-domain
```

Confirm the identity, linked Project, clean status, and SHA still match the recorded candidate. Save the full URL returned by the deploy command, then wait for that exact deployment to become ready:

```bash
KANBAN_CARDS_DEPLOYMENT_URL='paste-full-deployment-url'
vercel inspect "$KANBAN_CARDS_DEPLOYMENT_URL" --wait --timeout 3m
KANBAN_CARDS_DEPLOYMENT_ID='paste-exact-deployment-id'
vercel api "/v13/deployments/$KANBAN_CARDS_DEPLOYMENT_ID"
```

The deployment API response must report the recorded full commit SHA, `target: production`, `readyState: READY`, the linked Project id, the same immutable URL, and no `kanban.cards` alias. Do not rebuild between verification and promotion.

## Verify the candidate deployment

Generated deployment URLs remain protected. Read the immutable candidate readiness endpoints first:

```bash
vercel curl /api/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
vercel curl /api/access/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
```

A first-migration `legacyBinding: pending` and HTTP `503` is a truthful stop until the exact admitted Clerk session establishes the documented binding. Continue only after both endpoints return `200`, `ok: true`, `store: postgres`, ready registry/state/binding values, and no missing configuration.

The live controller compares the immutable candidate deployment's Git SHA with clean local `main`. An exact SHA passes this check. A different SHA is allowed only when `git diff --name-only --no-renames` contains files from the evaluator's exact operator-only allowlist; any application, API, server, dependency, build, or Vercel configuration change blocks promotion.

Relevant runtime configuration is bound directly by the immutable deployment ID and URL, production target and READY state, exact protected route pins, live readiness, Clerk configuration, and WAF policy. The operator does not self-attest a separate runtime or configuration hash.

Publish the exact candidate WAF pair before assigning these routes, then inspect each route:

```bash
KANBAN_CARDS_AUTH_URL='https://auth.kanban.cards'
KANBAN_CARDS_CANDIDATE_ROOT_URL='https://candidate.release.kanban.cards'
KANBAN_CARDS_CANDIDATE_TENANT_URL='https://mike.candidate.release.kanban.cards'
vercel inspect "$KANBAN_CARDS_AUTH_URL" --format=json
vercel inspect "$KANBAN_CARDS_CANDIDATE_ROOT_URL" --format=json
vercel inspect "$KANBAN_CARDS_CANDIDATE_TENANT_URL" --format=json
```

All three must resolve to the candidate deployment. The complete Project alias inventory must leave `mike.kanban.cards` unrouted before promotion.

Complete the invited candidate journey once: signed-out candidate root to the dedicated auth host, email-code completion, return to the exact initiating root, server-side session exchange, expected Workspace enumeration, one-time handoff, tenant Project read, one bounded tenant write, auth-host API isolation, cross-origin/tenant rejection, and an exact-session sign-out. The normal sign-out must reach the persistent `Signed out` state and recover to the supported sign-in path. Existing live evidence plus automated retry-recovery coverage is sufficient; do not force another same-session failure/retry solely for release evidence.

Production remains Invite-only in this release. Automated security and browser coverage is sufficient for the authenticated-but-unadmitted state until self-serve makes that state reachable; do not create a temporary live Clerk identity solely for cutover proof.

If the compatibility bridge is enabled, perform one authenticated read of the mapped legacy Workspace. Do not create a verification Card, add a Comment, move or archive a Card, or write a board comment as release evidence. If the bridge is disabled, use the retirement checklist.

From one independently controlled exact source outside the WAF bypass, make one candidate-root request:

```bash
curl --silent --show-error --dump-header - --output /dev/null \
  https://candidate.release.kanban.cards/
```

Record the exact source privately plus HTTP `403`, `x-vercel-mitigated: deny`, `x-vercel-id`, and observation time. The live WAF policy already proves the same deny covers all three candidate hosts. No hotspot script, five-host package, Traffic correlation, canonical-host probes, or synchronized source choreography is required.

Inspect recent candidate errors, then capture the exact current production deployment as the rollback target:

```bash
vercel logs "$KANBAN_CARDS_DEPLOYMENT_URL" --level error --since 15m --no-follow
vercel inspect https://kanban.cards --format=json
KANBAN_CARDS_ROLLBACK_URL='paste-current-immutable-deployment-url'
vercel inspect "$KANBAN_CARDS_ROLLBACK_URL"
```

The rollback target must be a distinct READY production deployment with healthy Postgres and a successful bounded compatibility check.
## Record and evaluate cutover evidence

Copy [`workspace-cutover-evidence.example.json`](workspace-cutover-evidence.example.json) to an operator-controlled path outside the repository. Do not include credentials, identity values, email codes, cookies, session IDs, or secret configuration values.

The pre-promotion receipt binds one fresh run to the immutable candidate identity and deployment Git provenance, the live application-closure check, direct runtime-configuration checks, exact auth/root/tenant routes, healthy readiness, Clerk and tenant isolation checks, one compatibility read when enabled, the known rollback target, one focused current production data baseline, and one independent candidate-root denial. `authHostSurface` no longer implies creation of a live unadmitted identity; Invite-only denial remains covered by the validated automated suite. `signOut` requires a successful exact-session sign-out, while the already accepted live failure result and automated recovery tests cover failure/retry behavior.

The unavailable historical production pre-binding receipt is documented in [`workspace-access-migration.md`](workspace-access-migration.md). It is not copied into the evidence JSON, parsed as an exception, rebound to each candidate, or used to authorize promotion.

A post-promotion receipt must use a distinct run ID and later observation time. It repeats focused health, authentication, exact routing, and isolation checks; verifies temporary aliases and WAF/Clerk candidate configuration are removed; and records an unchanged focused production data digest before any smoke write. Board comments and temporary Card lifecycles are not evidence.

Run the pre-promotion evaluator:

```bash
KANBAN_CARDS_EVIDENCE_PATH='paste-operator-controlled-evidence-path'
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" --live
```

Every blocker is named by gate and code. An unexpected deployable-application delta, pending access binding, unhealthy Postgres, Clerk or tenant-isolation failure, WAF policy or independent-denial failure, unverified rollback target, or disabled release-policy control leaves public production unchanged.
## Promote the verified artifact

Promotion is a distinct explicit action. The controller re-reads live policy, candidate and production identities, exact route pins, readiness, and the phase receipt, then passes only the evaluated deployment ID to `vercel promote`:

```bash
vercel whoami
vercel project inspect
vercel project protection
npm run release:preflight
KANBAN_CARDS_PROMOTION_CONFIRMATION='PROMOTE EXACT VERIFIED CANDIDATE'
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" \
  --live --authorize-promotion --confirmation "$KANBAN_CARDS_PROMOTION_CONFIRMATION" --promote
vercel inspect https://kanban.cards
```

Immediately after promotion:

1. Confirm `kanban.cards` serves the exact promoted deployment and both readiness endpoints remain healthy on Postgres.
2. Assign `mike.kanban.cards` to that deployment and verify the public auth, root, and tenant routes.
3. Repeat the focused Clerk journey: sign-in, exact session exchange, expected Workspace, tenant handoff, Project read/write, auth-host isolation, cross-tenant rejection, and normal exact-session sign-out.
4. Before any smoke write, compare a focused production data digest with the value captured immediately before promotion.
5. While the candidate deny rule is still live, remove both candidate aliases and remove `candidate.release.kanban.cards` from Clerk Allowed Subdomains.
6. Stage removal of the two temporary WAF rules, inspect the draft, and publish only when both removals are present. Keep Standard Protection enabled.
7. Confirm the complete alias inventory has no candidate aliases, no Firewall rule references a temporary candidate host, no draft remains, and the public auth/root/tenant routes still serve the promoted deployment.
8. Run the distinct post-promotion evaluator:

```bash
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" \
  --phase post-promotion --live
vercel logs --environment production --level error --since 15m --no-branch
```

Do not create a release Card or board Comment. Do not describe the release as complete until the post-promotion gate passes. A failure stops cleanup or completion at the observed step; rollback remains a separately authorized production mutation using the retained exact predecessor.
## Retire the compatibility API key

Retirement is complete only when Clerk access works without the bridge and no reachable deployment still accepts the retired key.

1. On the candidate, complete the one-path Clerk email-code sign-in and server-side session exchange, open the legacy tenant, and verify a Project read and write through the tenant session.
2. Confirm `/api/access/health` reports `legacyState: ready`, `legacyBinding.status: ready`, and `legacyBridge: enabled` before removal.
3. Remove `KANBAN_CARDS_API_TOKEN` from the candidate environment without changing the stored `default` mapping. Keep `KANBAN_CARDS_API_WORKSPACE_ID=default` only if the deployment process requires the explicit compatibility boundary; it grants no authority without the token.
4. Build and verify a new exact candidate. `/api/health` and `/api/access/health` must stay healthy, and `/api/access/health` must now report `legacyBridge: disabled`.
5. Repeat Clerk root, tenant handoff, Project read/write, and a normal exact-session Clerk sign-out. The browser path must not depend on the retired token; automated tests retain failure/retry coverage.
6. Provide the retired key through hidden input and call `https://kanban.cards/api/projects`. The response must be `401`. Repeat against the legacy tenant origin and one sibling tenant; neither may accept it.
7. Promote only that verified artifact. Inventory and retire every older deployment that still contains the key, using the target-specific closure procedure in the rotation section below.
8. Remove or replace user-scoped skill connections that contain the retired key. The next roadmap slice supplies the verified agent-principal path; do not relabel the retired bearer as an agent identity.

Record the candidate SHA, health responses, Clerk browser proof, three `401` results, promoted deployment, and old-deployment closure. A disabled bridge with broken Clerk access is an outage, not successful retirement.

## Rotate the compatibility API key

The single-key model has no built-in overlap or revocation registry. Vercel environment changes apply to new deployments; they do not rewrite older immutable deployments. Rotation is incomplete while any deployment that contains the old key can still reach the workspace database.

1. Open an exclusive deployment window. Do not allow another deployment until rotation closes; if one occurs, stop and rebuild the inventory. Verify the Vercel identity and Project.

   ```bash
   vercel whoami
   vercel project inspect
   vercel project protection
   ```

2. Because this runbook configures the compatibility key only for production, conservatively treat every existing production deployment as an old-key deployment. List every page and record every deployment ID in the rotation record. Copy the returned `next` cursor into the second command and repeat it until no next cursor remains:

   ```bash
   vercel ls --environment production --format=json
   vercel ls --environment production --format=json --next 'paste-next-cursor'
   ```

   If the compatibility key was ever configured for preview or development, inventory every page of those environments too. Do not assume the production-only inventory is complete.

3. List every alias page and record any alias that targets an old-key deployment. Repeat the second command until no next cursor remains:

   ```bash
   vercel alias list --format=json --limit 100
   vercel alias list --format=json --limit 100 --next 'paste-next-cursor'
   ```

4. Generate a new high-entropy key and store it in the approved secret manager.
5. Update `KANBAN_CARDS_API_TOKEN` interactively:

   ```bash
   vercel env update KANBAN_CARDS_API_TOKEN production --sensitive
   ```

6. Create and verify a new deployment with the new key, following the candidate procedure above. Promote that exact deployment.
7. Confirm the new key works on the production domain. Provide the old key through hidden input and confirm it now returns `401` without placing the key in an argument:

   ```bash
   printf 'Old compatibility key: '
   IFS= read -r -s KANBAN_CARDS_OLD_API_TOKEN
   printf '\n'
   printf 'header = "Authorization: Bearer %s"\n' "$KANBAN_CARDS_OLD_API_TOKEN" | \
     curl --config - --include https://kanban.cards/api/projects
   unset KANBAN_CARDS_OLD_API_TOKEN
   ```

8. If rollback capability must survive the rotation, deploy and verify the chosen known-good source again under the new environment before removing its old-key deployment. Otherwise, explicitly accept that there is no older compatible rollback target until the rotated deployment becomes the known-good base for the next release.
9. Inspect each recorded old-key deployment, remove any custom alias that still points to it, then remove that exact deployment. Repeat these target-specific commands for every recorded ID:

   ```bash
   KANBAN_CARDS_OLD_DEPLOYMENT_ID='paste-one-recorded-old-key-deployment-id'
   KANBAN_CARDS_OLD_ALIAS='paste-old-alias-if-one-exists'

   vercel inspect "$KANBAN_CARDS_OLD_DEPLOYMENT_ID"
   vercel alias remove "$KANBAN_CARDS_OLD_ALIAS"
   vercel remove "$KANBAN_CARDS_OLD_DEPLOYMENT_ID" --yes
   ```

   Omit `vercel alias remove` when the inspected deployment has no custom alias. Do not use a Project name as the `vercel remove` target; that would remove every deployment in the Project.

10. Prove closure. Re-run every page of both inventories, following each returned next cursor until none remains:

   ```bash
   vercel ls --environment production --format=json
   vercel ls --environment production --format=json --next 'paste-next-cursor'
   vercel alias list --format=json --limit 100
   vercel alias list --format=json --limit 100 --next 'paste-next-cursor'
   vercel inspect "$KANBAN_CARDS_OLD_DEPLOYMENT_ID"
   ```

   Every recorded old-key deployment must be absent from all pages, no alias on any page may point to one, and a final `vercel inspect` for each recorded ID must fail because the deployment no longer exists. If the compatibility key existed in another environment, prove the same closure there. If an old-key deployment cannot be retired, revoke or rotate its database credential before treating compatibility-key rotation as complete.
11. Sign in again in the browser and run CLI `setup --token-stdin` again for every user-scoped helper configuration that should retain access.

Do not log either key during comparison. Never use an old-key deployment as a rollback target.

## Failure interpretation

- `401`: authentication failed. Check the Clerk session, exact admitted Clerk user ID, authorized party, canonical host, user-scoped CLI configuration, recent bridge rotation or retirement, and the active deployment's environment snapshot.
- `409` with a stale-version message: read the current Project or Card, reconcile, and retry with the returned revision or version.
- `409` for an idempotency-key mismatch: reuse the original request body or choose a new stable key for the changed request.
- `409` for an archived Project: stop writing to it or restore it deliberately through the resource API.
- `409` while changing Columns: move or archive every Card that would be stranded before removing its Column.
- `400` naming `If-Match`: replace the legacy helper or caller; writes require `X-Kanban-Version` so a hosted response cannot be rewritten after the mutation commits.
- `428`: the caller omitted the required `X-Kanban-Version` revision or version on an edit.
- `503`: inspect both readiness endpoints. Required Clerk/database configuration may be missing, the access registry may be unavailable, the required `default` state may be missing or invalid, the legacy binding may be pending or mismatched, or global sign-out revocation may be incomplete.
- `/api/health` or `/api/access/health` fails: stop promotion. Do not initialize or replace legacy storage as a shortcut.
- `main-git-deployments-enabled` or `auto-domain-assignment-enabled`: stop. Restore both release controls before creating another candidate; a merge is never promotion authorization.
- `Workspace unavailable` on an immutable generated deployment hostname: that hostname cannot prove canonical Clerk or compatibility access. Configure and verify approved protected auth, candidate-root, and candidate-tenant routes pinned to the exact deployment; do not weaken host or Clerk authorized-party validation.
- Any `npm run release:gate` blocker: leave the current production deployment serving. Correct and re-run the failed proof against the same candidate, or build and record a new candidate if its artifact or environment changed.
- `Global sign-out could not be completed`: the current host instructed the browser to clear its cookie, but sibling sessions may remain active. Retry sign-out after the registry recovers and verify the full session family is revoked.
- Duplicate Card creation: the caller omitted a stable external key and did not reuse the same idempotency key, or server deduplication regressed.
- Browser and helper disagree: reload the browser, then confirm both clients use the same origin and Project. A repository binding selects context but does not scope authority.

Never replace a production database failure with file storage.

## Retention and recovery

- Each Project retains its newest 1,000 Activity entries. The Activity endpoint returns at most the newest 200 per request and has no pagination.
- The workspace retains its newest 1,000 idempotency records. A stable Card external key remains the stronger long-lived deduplication mechanism.
- Archiving is non-destructive at the API level. The browser exposes immediate `Undo archive` recovery from its named receipt; the bundled helper remains archive-only, so helper-led recovery requires a deliberate resource-API restore.
- Before decommissioning V2, take a database-provider snapshot and export every Project needed for inspection. The helper's `project --project <project-id>` output contains that Project's Columns, Cards, Comments, and retained Activity. Store exports outside the repository and do not include the compatibility key.

## Rollback

Rollback changes the active deployment. It does not reverse or delete the independent V2 table.

Classify the rollback artifact before changing traffic. If the known-good target is the owner-key version, remove both the `auth.kanban.cards` and `mike.kanban.cards` Project routes before invoking `vercel rollback`, or perform those removals in the same protected maintenance operation. Re-read the complete alias inventory and require both hostnames to be absent; each must return Vercel's unmitigated `404` with `x-vercel-error: DEPLOYMENT_NOT_FOUND`. Never allow an owner-key rollback to recreate a tenant-looking public origin.

```bash
KANBAN_CARDS_ROLLBACK_URL='paste-known-good-deployment-url'
vercel whoami
vercel project inspect
vercel rollback "$KANBAN_CARDS_ROLLBACK_URL"
vercel rollback status
```

After rollback:

1. Inspect the active production deployment and confirm it is the intended target.
2. Resolve both the dedicated auth alias and canonical tenant route as part of the same rollback operation. If the rollback target implements this Clerk topology, pin `auth.kanban.cards` and `mike.kanban.cards` to that exact rollback deployment and verify they serve the same artifact as the canonical root. If the first migration rolls back to the owner-key version, confirm both routes remain absent from the complete Project alias inventory and still return the exact platform `DEPLOYMENT_NOT_FOUND` response; never leave either hostname serving the rejected candidate or the owner-key artifact beside a different canonical deployment.
3. Repeat that version's health, authentication, browser, and storage checks.
4. Inspect production errors.
5. Keep the V2 database intact. V2 work remains available when a compatible V2 deployment returns.

If no committed, previously verified deployment exists, there is no reliable rollback target. Do not treat an uncommitted working tree as one.

After a compatibility-key rotation, do not roll back to a deployment that still contains the prior key. Establish a new known-good rollback target under the rotated environment first.
