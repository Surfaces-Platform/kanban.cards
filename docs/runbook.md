# Runbook

This runbook covers local verification, tenant-aware access migration, candidate proof, promotion, compatibility-credential rotation, and rollback.

## Operating boundary

The provider-verified browser session is bound to one canonical Workspace host. The interim API credential grants read and write access only to the explicitly mapped legacy Workspace. Treat that credential like a password:

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

The browser uses separate signed root and tenant cookies after provider verification and a one-time exact-host handoff. The CLI stores the compatibility key in `~/.kanban-cards/config.json` with mode `0600` and sends it as a bearer token. A deployment using a rotated compatibility key requires CLI setup again but does not define browser identity. Older immutable deployment URLs retain their original environment snapshot; protect or retire them separately.

## Runtime contract

Production requires:

- `KANBAN_CARDS_ROOT_HOST=kanban.cards`
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `SESSION_SECRET`, and `PLATFORM_SURFACE_ID=kanban.cards`
- one of `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`

Optional:

- `KANBAN_CARDS_API_TOKEN` and `KANBAN_CARDS_API_WORKSPACE_ID=default` while the skill compatibility bridge remains enabled
- `KANBAN_CARDS_LEGACY_OWNER_SUBJECT`, `KANBAN_CARDS_LEGACY_WORKSPACE_SLUG`, and `KANBAN_CARDS_LEGACY_WORKSPACE_NAME` during legacy cutover; set all three together
- `KANBAN_CARDS_OWNER_LABEL`
- `KANBAN_CARDS_SESSION_TTL_SECONDS`
- `OIDC_CLIENT_SECRET`, `OIDC_POST_LOGOUT_REDIRECT_URI`, `OIDC_SCOPE`, `ROOT_SESSION_TTL_SECONDS`, and `TENANT_SESSION_TTL_SECONDS`
- the bounded pre-promotion family: `KANBAN_CARDS_CANDIDATE_ROOT_HOST`, `KANBAN_CARDS_CANDIDATE_TENANT_HOSTS`, and `OIDC_CANDIDATE_REDIRECT_URI`; set all three together. `OIDC_CANDIDATE_POST_LOGOUT_REDIRECT_URI` is optional. `KANBAN_CARDS_CANDIDATE_TENANT_HOSTS` is a JSON object containing exactly the configured legacy Workspace slug and its one exact candidate tenant host. Extra mappings are rejected because the cutover proves exactly one tenant route.

Local operator controls:

- `KANBAN_CARDS_DATA_PATH`
- `KANBAN_CARDS_ROOT_HOST`
- `HOST`
- `PORT`

`KANBAN_CARDS_POSTGRES_SSL=disable` is available for a trusted local database. Do not use it in production.

Use `localhost` for local tenant-aware proof: set `HOST=localhost`, use an OIDC redirect such as `http://localhost:4317/auth/callback`, and open `http://localhost:4317`. When `KANBAN_CARDS_ROOT_HOST` is absent, the server derives the root host from the validated OIDC redirect; Workspace hosts use the same port at `<slug>.localhost`. Keep `127.0.0.1` for the OIDC-free owner-key fallback only. Numeric-IP subdomains are not a supported tenant topology.

The public shell and provider entry load without prior authentication. Project data returns `503` when required configuration is missing and `401` when the host/session or compatibility credential is invalid. Follow [`workspace-access-migration.md`](workspace-access-migration.md) before any tenant-aware promotion; it is the governing data, cutover, and rollback checklist.

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

`git status --short` must be empty. Record the full commit SHA. Do not deploy an uncommitted working tree or a different commit from the one that passed validation. `npm run check` includes `npm run check:release-policy`; that policy fails unless automatic deployments from `main` remain disabled in `vercel.json`.

Passing automation confirms the implementation contract. It does not prove the deployed database, browser rendering, or provider environment.

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

Configure provider auth, the canonical root host, and the database through the Vercel dashboard or interactive CLI. Do not use `--value` for secrets because it places them in command history. Add the compatibility token only when the recorded cutover plan still requires the skill bridge.

```bash
vercel env add KANBAN_CARDS_DATABASE_URL production --sensitive
vercel env add SESSION_SECRET production --sensitive
```

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

For a legacy cutover, `kanban_v2_workspaces:default` must already exist and pass the V2 schema check. The provider callback uses a non-creating read before it binds the access registry. A missing table, missing row, unsupported schema, or storage error returns `503` before any owner or Workspace mapping is written. The candidate must never turn a wrong or empty database into a valid-looking legacy Workspace.

`npm run db:init` remains available only for an explicitly new V2 store when a database URL is already present in the current process. Do not run it as a repair during legacy migration; restore or select the intended existing database instead. Do not rely on `vercel env run` to inject a sensitive database value into the local shell. If an initializer is deliberately used for a new store, it must report:

```text
Initialized V2 postgres workspace at kanban_v2_workspaces:default
```

Stop if it reports `file`. For legacy migration, record a backup or recovery point, the existing row count, and a canonical digest before the provider callback binds `default`. Repeat the count and digest after binding. The values must match.

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

Generated deployment URLs may be behind Vercel Deployment Protection even when the custom production domain is public. First read the fail-closed state through the exact immutable URL. On a first migration, `legacyBinding: pending` and HTTP `503` are expected until the verified provider callback creates the exact binding; they prove that promotion remains blocked, not that the candidate is ready:

```bash
vercel curl /api/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
vercel curl /api/access/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
```

Provider sign-in on a protected hostname pinned to the exact candidate is the action that creates and proves the binding. The generated immutable `*.vercel.app` hostname is useful for readiness calls but is not a valid provider or bearer proof: provider routes and the bounded bearer accept only an explicit root or tenant host. `/auth/login` on the generated hostname correctly returns `Workspace unavailable`.

Before continuing, establish an approved candidate root and tenant routing mechanism with all of these properties: both are exact `*.vercel.app` aliases distinct from `kanban.cards`; `vercel inspect` resolves both exact routes to the recorded candidate deployment ID; the live Project protection policy covers generated deployment URLs; an unauthenticated nonce-path probe on each route returns Vercel's SSO redirect bound back to that exact probe URL; the root callback is registered with the provider; and the same immutable artifact remains valid when later served on the canonical production hosts. Configure the finite candidate host family in the candidate environment; do not infer sibling `*.vercel.app` hosts or use a wildcard. OAuth state, root and tenant sessions, and handoffs are origin-bound, so candidate credentials cannot replay on canonical hosts or vice versa. Do not temporarily point `kanban.cards` at the candidate to manufacture proof. Until the exact routes and callback exist, this cutover is deliberately blocked.

```bash
KANBAN_CARDS_CANDIDATE_ROOT_URL='https://paste-approved-candidate-root'
KANBAN_CARDS_CANDIDATE_TENANT_URL='https://paste-approved-candidate-tenant'
vercel inspect "$KANBAN_CARDS_CANDIDATE_ROOT_URL" --format=json
vercel inspect "$KANBAN_CARDS_CANDIDATE_TENANT_URL" --format=json
```

Capture the canonical digest and resource fingerprint of `kanban_v2_workspaces:default` immediately before the first provider callback. Complete provider sign-in and callback on that exact route, verify the owner binding, root Workspace list, canonical handoff, and tenant Project read. Immediately re-read the state before any tenant or compatibility write; the digest and fingerprint must equal the pre-callback values. This pair proves that access binding did not change default Workspace data. Only after capturing equality, perform and record a bounded tenant-session write.

Now repeat both readiness calls against the immutable deployment URL. Both responses must report `ok: true`; `/api/health` must report `store: postgres` with no missing configuration, and `/api/access/health` must report `registryState: ready`, `legacyState: ready`, and `legacyBinding.status: ready` with `present: true`. `not-required` is not acceptable for this migration. Record whether `legacyBridge` is `enabled` or `disabled`.

If the compatibility bridge remains enabled, the same exact-host candidate routing must let the bearer reach only the mapped default Workspace. Provide its key without placing it in a command argument and perform the bounded lifecycle below. If the bridge is retired, skip the bearer loop and follow **Retire the compatibility API key** instead.

```bash
printf 'Production compatibility key: '
IFS= read -r -s KANBAN_CARDS_API_TOKEN
printf '\n'
printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl /api/projects --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- --config -
```

The authenticated bridge read must return the legacy Workspace Project list. It proves only that the bounded compatibility credential reaches the mapped `default` row; it does not prove provider identity or create missing legacy storage.

Use one persistent `Release verification` Project for deployment checks. Copy its ID from the Project list. If it does not exist, run this request once, then copy the returned ID:

```bash
printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl /api/projects --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'Idempotency-Key: release-verification-project-v1' \
    --data '{"name":"Release verification","columns":[{"id":"inbox","name":"Inbox"},{"id":"doing","name":"Doing"},{"id":"done","name":"Done"}]}'

KANBAN_CARDS_RELEASE_PROJECT_ID='paste-release-project-id'
```

Now prove a production-target write before promotion. The run ID is safe to place in JSON because it contains only the commit prefix, digits, letters, and hyphens:

```bash
KANBAN_CARDS_RELEASE_RUN_ID="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"

printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl "/api/projects/$KANBAN_CARDS_RELEASE_PROJECT_ID/cards" \
    --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: release:$KANBAN_CARDS_RELEASE_RUN_ID:create-v1" \
    --data "{\"title\":\"Verify release $KANBAN_CARDS_RELEASE_RUN_ID\",\"body\":\"Production smoke check.\",\"externalKey\":\"release:$KANBAN_CARDS_RELEASE_RUN_ID\"}"

KANBAN_CARDS_RELEASE_CARD_ID='paste-card-id-from-first-response'

printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl "/api/projects/$KANBAN_CARDS_RELEASE_PROJECT_ID/cards" \
    --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: release:$KANBAN_CARDS_RELEASE_RUN_ID:external-replay-v1" \
    --data "{\"title\":\"Verify release $KANBAN_CARDS_RELEASE_RUN_ID\",\"body\":\"Production smoke check.\",\"externalKey\":\"release:$KANBAN_CARDS_RELEASE_RUN_ID\"}"

printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl "/api/projects/$KANBAN_CARDS_RELEASE_PROJECT_ID/cards/$KANBAN_CARDS_RELEASE_CARD_ID/comments" \
    --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: release:$KANBAN_CARDS_RELEASE_RUN_ID:comment-v1" \
    --data '{"body":"Candidate compatibility Comment passed."}'

printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl "/api/projects/$KANBAN_CARDS_RELEASE_PROJECT_ID/cards/$KANBAN_CARDS_RELEASE_CARD_ID" \
    --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request PATCH \
    --header 'Content-Type: application/json' \
    --header 'X-Kanban-Version: 2' \
    --data '{"columnId":"doing"}'

KANBAN_CARDS_ARCHIVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl "/api/projects/$KANBAN_CARDS_RELEASE_PROJECT_ID/cards/$KANBAN_CARDS_RELEASE_CARD_ID" \
    --deployment "$KANBAN_CARDS_CANDIDATE_ROOT_URL" -- \
    --config - \
    --include \
    --request PATCH \
    --header 'Content-Type: application/json' \
    --header 'X-Kanban-Version: 3' \
    --data "{\"archivedAt\":\"$KANBAN_CARDS_ARCHIVED_AT\"}"

unset KANBAN_CARDS_API_TOKEN
```

The first Card request must return `201` with version `1`. The second uses a different idempotency key and the same external key; it must return `200`, `deduplicated: true`, and the same Card ID. Comment must return version `2`, Move version `3`, and archive version `4`. Re-read the Project with archived Cards included and confirm the same Card, Comment, move Activity, and archive Activity. This is the bounded compatibility-bridge proof that the candidate can read and complete create, comment, move, and archive against the mapped Postgres row before promotion.

Open both approved exact-deployment candidate hostnames in the same browser and complete Vercel Authentication on each before beginning provider sign-in. Protection cookies are host-specific; warming the tenant route first prevents its protection redirect from consuming the later cross-host form POST and losing the one-time handoff body. Return to the candidate root, complete provider sign-in and callback, verify the root route lists only the owner's routed Workspaces, open the exact candidate tenant through the one-time handoff, and confirm the archived verification Card remains present in the Project and Activity evidence. Repeat at a narrow viewport. If either hostname cannot cross the Vercel protection boundary or is not pinned to the exact deployment ID, stop. API checks do not replace rendered candidate verification.

After the candidate smoke mutations, capture a new canonical digest and resource fingerprint in `prePromotion.dataIntegrityProof.finalCandidateDigest` and `finalCandidateResourceFingerprint`. This is the pre-promotion baseline for the post-promotion receipt; do not compare it with the pre-binding digest because the bounded verification Card intentionally changed the Workspace.

Inspect recent candidate errors:

```bash
vercel logs "$KANBAN_CARDS_DEPLOYMENT_URL" --level error --since 15m --no-follow
```

Before promotion, capture the deployment currently serving the production domain:

```bash
vercel inspect https://kanban.cards --format=json
KANBAN_CARDS_ROLLBACK_URL='paste-current-immutable-deployment-url'
vercel inspect "$KANBAN_CARDS_ROLLBACK_URL"
```

Confirm that this exact immutable URL is the intended known-good rollback target and is different from the candidate URL. Stop if no verified rollback target exists.

## Record and evaluate cutover evidence

Copy [`workspace-cutover-evidence.example.json`](workspace-cutover-evidence.example.json) to an operator-controlled location outside the repository and replace every placeholder with evidence from the exact candidate, current production deployment, and real Postgres store. The record contains no credential values. Pre- and post-promotion receipts have distinct run IDs, timestamps no more than 30 minutes old, exercised origins, exact deployment ID/URL/SHA bindings, and concrete compatibility Card IDs/versions. A proof field may be `passed` only when that action was completed against that phase's exact origin; `not-run`, `failed`, missing, stale, and invented values block promotion.

The data proof uses separate phase-bound pairs:

- Pre-promotion compares the canonical digest and resource fingerprint immediately before and after the access binding, before compatibility writes.
- Post-promotion compares the final candidate baseline with the public production state immediately after promotion, before post-promotion smoke writes.

Each fingerprint covers Project, Column, Card, Comment, and Activity ids, resource versions and revisions, archive state, and idempotency records.

Run the pre-promotion evaluator:

```bash
KANBAN_CARDS_EVIDENCE_PATH='paste-operator-controlled-evidence-path'
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" --live
```

Every blocker is named by gate and code. A pending binding, provider failure, compatibility-loop failure, exact-artifact mismatch, changed default Workspace, unverified rollback target, enabled automatic domain assignment, or automatic `main` deployment leaves current production unchanged and returns a failing exit status.

## Promote the verified artifact

Promotion is a distinct explicit action. One controller re-reads the live Project policy, exact candidate metadata, public production/rollback identity, candidate route pin, and both runtime readiness endpoints; validates the phase-bound receipt and literal confirmation; and passes the evaluated deployment ID directly to `vercel promote`. It accepts no independent promotion target:

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

Confirm the identity, linked Project, remote auto-assignment setting, and protection boundary again immediately before promotion. A different ID, URL, SHA, Project, branch, or alias state invalidates the evidence. Never substitute a branch alias or rebuild. While the compatibility bridge is enabled, configure the helper for the public production origin without placing the key on the command line. If the bridge is disabled, skip helper setup and run the retirement proof below.

First open `https://kanban.cards` in a signed-out or private browser window. The provider sign-in surface must load without a Vercel login. Complete provider sign-in, confirm the root route exposes only the expected Workspaces, then open the canonical tenant and verify the Project list.

The helper has exactly one user-scoped connection and no named profiles or supported alternate config path. This verification requires `setup` so the following commands are pinned to the public production origin. Continue only when replacing that one connection with the production origin, actor, and owner credential is the intended outcome. If an existing connection must be retained, stop and run this verification from a designated production-operator account or machine instead. Do not copy the credential-bearing config into the repository or an ad hoc backup.

```bash
printf 'Production compatibility key: '
IFS= read -r -s KANBAN_CARDS_API_TOKEN
printf '\n'
printf '%s\n' "$KANBAN_CARDS_API_TOKEN" | \
  node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  setup --url https://kanban.cards/api --actor codex --token-stdin
unset KANBAN_CARDS_API_TOKEN

curl -fsS https://kanban.cards/api/health
curl -fsS https://kanban.cards/api/access/health
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs session
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs projects
```

Both public readiness responses must match the candidate's ready state and bridge mode before helper-based verification continues. Run the helper commands only while the compatibility bridge is intentionally enabled.

Before creating the post-promotion verification Card, re-read the canonical digest and resource fingerprint through the public origin and compare them with the final candidate baseline. Record that distinct promotion-before/after pair in `evidence.postPromotion.dataIntegrityProof`; the gate requires its `before*` values to match the final candidate baseline. Only after equality is established, perform and capture a bounded tenant-session write, then run the post-promotion bearer lifecycle below.

First read the candidate verification Project with archived Cards included and confirm the exact pre-promotion Card is still version `4` with the same evidence. Then choose a new post-promotion run ID and run a second public-origin bounded lifecycle with `--project` so verification does not change the repository binding:

```bash
KANBAN_CARDS_RELEASE_RUN_ID="$(git rev-parse --short=12 HEAD)-post-$(date -u +%Y%m%dT%H%M%SZ)"

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  create-card --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --title "Verify release $KANBAN_CARDS_RELEASE_RUN_ID" \
  --body "Production smoke check." \
  --external-key "release:$KANBAN_CARDS_RELEASE_RUN_ID"

KANBAN_CARDS_RELEASE_CARD_ID='paste-new-post-promotion-card-id'

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  create-card --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --title "Verify release $KANBAN_CARDS_RELEASE_RUN_ID" \
  --body "Production smoke check." \
  --external-key "release:$KANBAN_CARDS_RELEASE_RUN_ID"

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  comment --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --card "$KANBAN_CARDS_RELEASE_CARD_ID" \
  --text "Creation and deduplication passed." \
  --idempotency-key "release:$KANBAN_CARDS_RELEASE_RUN_ID:comment-v1"

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  move-card --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --card "$KANBAN_CARDS_RELEASE_CARD_ID" --column doing --version 2

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  update-card --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --card "$KANBAN_CARDS_RELEASE_CARD_ID" \
  --body "This stale write must fail." --version 2

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  activity --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" --limit 25
```

The helper create must return a new Card for the post-promotion run with version `1`. The archived candidate Card must retain its prior ID and version `4`; together those reads prove the promoted public origin retained the candidate's Postgres state. The stale update must fail with the stale-version message; the automated API test verifies the underlying `409`. Use a new release run ID for every smoke run.

Reload the production browser. Confirm the Card and API-labeled Activity appear. The current browser does not update an already-open Project automatically. Then archive the temporary Card using the current version:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  archive-card --project "$KANBAN_CARDS_RELEASE_PROJECT_ID" \
  --card "$KANBAN_CARDS_RELEASE_CARD_ID" --version 3
```

If another client changed the Card, use the version returned by `project --project "$KANBAN_CARDS_RELEASE_PROJECT_ID"` instead of the example version.

Repeat the browser reload after archiving and inspect recent production errors:

```bash
vercel logs --environment production --level error --since 15m --no-branch
```

Record the commit SHA, candidate URL, production verification result, and the rollback URL captured before promotion.

Update the evidence snapshot with the exact deployment now serving `kanban.cards` and the repeated readiness, provider, compatibility, and unchanged-data proofs. Then run:

```bash
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" --phase post-promotion --live
```

Do not describe the release as complete until this post-promotion gate passes. If it fails, report the exact blocker and keep the recorded rollback target available. Do not roll back automatically; rollback remains a separately authorized production mutation.

After the post-promotion gate passes, remove the two candidate aliases from the deployment and verify that neither route resolves. This closes the temporary host family without rebuilding or changing the promoted artifact. Do not remove `kanban.cards` or the canonical tenant domain:

```bash
vercel alias rm "$(node -p 'new URL(process.env.KANBAN_CARDS_CANDIDATE_ROOT_URL).hostname')"
vercel alias rm "$(node -p 'new URL(process.env.KANBAN_CARDS_CANDIDATE_TENANT_URL).hostname')"
```

Re-list aliases and record their absence in the cutover evidence. The candidate host-family environment values remain inert in the immutable artifact once no route points to them; remove those values from the Project environment before the next deployment.

## Retire the compatibility API key

Retirement is complete only when provider access works without the bridge and no reachable deployment still accepts the retired key.

1. On the candidate, complete provider sign-in, open the legacy tenant, and verify a Project read and write through the tenant session.
2. Confirm `/api/access/health` reports `legacyState: ready`, `legacyBinding.status: ready`, and `legacyBridge: enabled` before removal.
3. Remove `KANBAN_CARDS_API_TOKEN` from the candidate environment without changing the stored `default` mapping. Keep `KANBAN_CARDS_API_WORKSPACE_ID=default` only if the deployment process requires the explicit compatibility boundary; it grants no authority without the token.
4. Build and verify a new exact candidate. `/api/health` and `/api/access/health` must stay healthy, and `/api/access/health` must now report `legacyBridge: disabled`.
5. Repeat provider root, tenant handoff, Project read/write, sign-out, and recovery checks. The browser path must not depend on the retired token.
6. Provide the retired key through hidden input and call `https://kanban.cards/api/projects`. The response must be `401`. Repeat against the legacy tenant origin and one sibling tenant; neither may accept it.
7. Promote only that verified artifact. Inventory and retire every older deployment that still contains the key, using the target-specific closure procedure in the rotation section below.
8. Remove or replace user-scoped skill connections that contain the retired key. The next roadmap slice supplies the verified agent-principal path; do not relabel the retired bearer as an agent identity.

Record the candidate SHA, health responses, provider browser proof, three `401` results, promoted deployment, and old-deployment closure. A disabled bridge with broken provider access is an outage, not successful retirement.

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

- `401`: authentication failed. Check the provider session, canonical host, user-scoped CLI configuration, recent bridge rotation or retirement, and the active deployment's environment snapshot.
- `409` with a stale-version message: read the current Project or Card, reconcile, and retry with the returned revision or version.
- `409` for an idempotency-key mismatch: reuse the original request body or choose a new stable key for the changed request.
- `409` for an archived Project: stop writing to it or restore it deliberately through the resource API.
- `409` while changing Columns: move or archive every Card that would be stranded before removing its Column.
- `400` naming `If-Match`: replace the legacy helper or caller; writes require `X-Kanban-Version` so a hosted response cannot be rewritten after the mutation commits.
- `428`: the caller omitted the required `X-Kanban-Version` revision or version on an edit.
- `503`: inspect both readiness endpoints. Required provider/database configuration may be missing, the access registry may be unavailable, the required `default` state may be missing or invalid, the legacy binding may be pending or mismatched, or global sign-out revocation may be incomplete.
- `/api/health` or `/api/access/health` fails: stop promotion. Do not initialize or replace legacy storage as a shortcut.
- `main-git-deployments-enabled` or `auto-domain-assignment-enabled`: stop. Restore both release controls before creating another candidate; a merge is never promotion authorization.
- `Workspace unavailable` on an immutable generated deployment hostname: that hostname cannot prove canonical provider or compatibility access. Configure and verify an approved protected candidate root and tenant route pinned to the exact deployment; do not weaken host validation.
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

```bash
KANBAN_CARDS_ROLLBACK_URL='paste-known-good-deployment-url'
vercel whoami
vercel project inspect
vercel rollback "$KANBAN_CARDS_ROLLBACK_URL"
vercel rollback status
```

After rollback:

1. Inspect the active production deployment and confirm it is the intended target.
2. Repeat that version's health, authentication, browser, and storage checks.
3. Inspect production errors.
4. Keep the V2 database intact. V2 work remains available when a compatible V2 deployment returns.

If no committed, previously verified deployment exists, there is no reliable rollback target. Do not treat an uncommitted working tree as one.

After a compatibility-key rotation, do not roll back to a deployment that still contains the prior key. Establish a new known-good rollback target under the rotated environment first.
