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
- `KANBAN_CARDS_AUTH_HOST=auth.kanban.cards`, the exact stable auth-only application host. The server derives `https://auth.kanban.cards/sign-in` and `/sign-up`; there are no independently configured auth-flow URLs. Clerk's production FAPI DNS/custom domain is configured separately through Clerk's normal production-domain setup.
- Vercel Marketplace's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, plus `CLERK_SECRET_KEY`, `CLERK_ENCRYPTION_KEY`, and `SESSION_SECRET`. `CLERK_PUBLISHABLE_KEY` remains accepted as a compatibility alias, but both names must match if both are set. Vercel production rejects Clerk development-instance keys: the Marketplace values must start with `pk_live_` and `sk_live_`. The last two app-owned values must each be at least 32 bytes; the encryption key is required because Clerk middleware selects the exact root configuration at request time.
- `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS`, a comma-separated list of exact admitted Clerk user IDs. It is required in production; the configured legacy user ID must be included.
- one of `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`

The Clerk instance must be a production instance configured for email verification codes, unified sign-up/sign-in, and a required profile name. Complete Clerk's one normal production FAPI DNS/custom-domain setup for the `kanban.cards` root domain; use the exact DNS names and targets supplied by Clerk and verify them before candidate proof. Do not configure an app-owned `/__clerk` proxy on the auth host or either application root. During protected candidate proof, enable Allowed Subdomains and enter exactly `auth.kanban.cards` and `candidate.release.kanban.cards`; the primary root `kanban.cards` is inherently allowed and must not be entered as a subdomain. After the candidate aliases are removed, remove `candidate.release.kanban.cards` from Clerk before restoring public access, leaving only `auth.kanban.cards` explicitly allowed. Never include `mike.kanban.cards`, `mike.candidate.release.kanban.cards`, wildcards, generated deployment hostnames, or any other tenant/unknown host. The same artifact serves the three app surfaces: the auth host redirects `/` and `/index.html` to `/sign-in`, exposes Clerk UI only at `/sign-in` and `/sign-up`, and otherwise exposes only the public session configuration needed by ClerkJS and static shell assets; it rejects Workspace, Project, handoff, and app-session exchange APIs. ClerkJS runs on the auth host and both exact application roots against the single validated production FAPI origin derived from the publishable key. Restrict each request's `authorizedParties` to its exact auth or application origin. Application-root sign-in and sign-up links must complete authentication on the auth host and carry the exact initiating application-root return. On return, that same application root must recognize its Clerk browser session before the app exchanges it. Tenant hosts accept only kanban.cards app-session cookies and never load ClerkJS. This topology uses one root domain, requires no Clerk satellite or multi-domain feature, and is supported by Clerk Hobby with its production FAPI custom domain and email-code flow. The Clerk-compatible CSP intentionally permits Clerk's runtime inline styles, bot-protection frames/scripts, protected-service connections, image host, and blob workers; do not remove those directives without replacing them with a tested nonce-based policy.

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

The public application shell and dedicated auth-host sign-up/sign-in entries load without prior authentication. The signed-out session contract contains only public configuration: the exact current origin, publishable key, validated `clerkFrontendApiOrigin`, `clerkSurfaceRole` (`auth` or `app`), server-derived auth-host flow URLs, and finite exact application return origins. It contains no app-owned Clerk proxy URL. Clerk and app secrets remain server-only. The auth host denies application data and session-exchange routes; application Project data returns `503` when required configuration is missing and `401` when the host/session or compatibility credential is invalid. Follow [`workspace-access-migration.md`](workspace-access-migration.md) before any tenant-aware promotion; it is the governing data, cutover, and rollback checklist.

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

Keep Vercel Standard Protection (`all_except_custom_domains`) enabled throughout the release. It protects generated deployment URLs while leaving custom domains public. Protect only the temporary dress-rehearsal surface with two published Vercel WAF custom rules. Rule priority is part of the release contract:

1. `kanban-candidate-mike-bypass` is the highest-priority rule. Its single condition group is `(host in the exact three-host set) AND (ip_address equals Mike's reviewed exact /32 or /128)`, and its action is `bypass`.
2. `kanban-candidate-deny` follows immediately. Its only condition is `host in the same exact three-host set`, and its action is `deny` with no duration.

The host set is exactly `auth.kanban.cards`, `candidate.release.kanban.cards`, and `mike.candidate.release.kanban.cards`. Do not use a wildcard, suffix, prefix, regex, path, method, header, cookie, broader CIDR, or persistent action duration. `kanban.cards` and `mike.kanban.cards` are deliberately excluded. Review Mike's current public address immediately before staging it as an exact `/32` or `/128`; an IP change invalidates the proof and requires a newly reviewed, republished rule and new receipts.

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

The live pre-promotion gate requires Standard Protection, an enabled Firewall, no unpublished changes, a complete live Project alias inventory that excludes `mike.kanban.cards`, the exact live rule IDs and deterministic published-config hash, the exact priority and Boolean grouping above, admitted-source application responses on all three hosts, and a fresh external-network deny proof. Record `externalDenyProbe.correlationMethod` explicitly and set `externalDenyProbe.runId` to the enclosing proof `runId`, binding the five observations to one operator-trusted atomic receipt. This is an operator evidence boundary, not cryptographic attestation. Use `platform-traffic` only when Vercel exposes each denied request in Firewall Traffic; copy its `wafAction: deny` and exact live `wafRuleId` for each distinct `x-vercel-id`. When the plan exposes no per-request Firewall Traffic, use `deterministic-live-policy`: the live hydrator must prove the complete active custom-rule inventory is exactly the governing bypass first and deny second, the sole eligible live no-duration rule denies only the exact three release hosts, Project IP blocks are empty, Attack Mode is off, and the derived rule ID and config hash include those hydrated safety facts. Deterministic observations must omit `wafAction` and `wafRuleId`; never fill them by inference or self-attestation. For either method, run all five requests from one separately controlled exact `/32` or `/128` outside the bypass and record that source privately. Each release host must return HTTP `403` with `x-vercel-mitigated: deny` and a fresh distinct `x-vercel-id`. From that same external source, `https://kanban.cards/api/health` must remain an unmitigated healthy Postgres response. The canonical tenant must still be unrouted before promotion: require HTTP `404`, no `x-vercel-mitigated` value, the exact `x-vercel-error: DEPLOYMENT_NOT_FOUND` platform header, and its own `x-vercel-id`. A listed canonical-tenant alias, public application response, arbitrary application-level `404`, active IP block, enabled Attack Mode, ambiguous deny rule, or missing hydrated safety fact blocks deterministic correlation. Stop on any mismatch or draft.

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

Stop if it reports `file`. For legacy migration, record a backup or recovery point, the existing row count, and a canonical digest before the verified Clerk session exchange binds `default`. Repeat the count and digest after binding. The values must match.

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

Generated deployment URLs may be behind Vercel Deployment Protection even when the custom production domain is public. First read the fail-closed state through the exact immutable URL. On a first migration, `legacyBinding: pending` and HTTP `503` are expected until the verified admitted Clerk session creates the exact binding; they prove that promotion remains blocked, not that the candidate is ready:

```bash
vercel curl /api/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
vercel curl /api/access/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
```

Clerk email-code sign-up/sign-in on the Firewall-bounded dedicated auth host, exact return to and shared-session recognition on the Firewall-bounded candidate application root, and `POST /api/clerk-session` on that root create and prove the binding. The generated immutable `*.vercel.app` hostname is useful for readiness calls but is not a valid Clerk or bearer proof: Clerk authentication and the bounded bearer accept only an explicit configured auth, application-root, or tenant host. A signed-out session request on an unknown generated hostname must fail closed with `Workspace unavailable`; there is no `/auth/login` route.

Before continuing, establish the exact routes `https://auth.kanban.cards`, `https://candidate.release.kanban.cards`, and `https://mike.candidate.release.kanban.cards`. All three must be distinct from the generated immutable deployment URL and the candidate application root must remain distinct from `https://kanban.cards`. `auth.kanban.cards` is the auth-only UI host; `kanban.cards` and `candidate.release.kanban.cards` are application origins under the same root domain, not satellites. Verify the single Clerk production FAPI DNS/custom domain, enable Allowed Subdomains with exactly `auth.kanban.cards` and `candidate.release.kanban.cards` as explicit entries, and confirm the primary root `kanban.cards` is inherently allowed; tenant and unknown hosts must be absent. Before assigning any alias, the two exact WAF rules above must be published, active, first and second in priority, and the Firewall must have no draft. `vercel inspect` must then resolve the auth, candidate-root, and candidate-tenant routes to the recorded candidate deployment ID. Do not register or alias `mike.kanban.cards` before promotion; its external proof must remain Vercel's unmitigated `DEPLOYMENT_NOT_FOUND` response rather than the old owner-key artifact. Run the admitted probes from Mike's reviewed address and the deny/canonical-exclusion probes from the separately controlled external address; bind all observations to the current published-config hash. Platform Traffic correlation additionally binds each request to the exact live deny rule ID; deterministic live-policy correlation derives that ID only from the hydrated exact policy and accepts no per-request rule claim. After the admitted boundary passes, ClerkJS on the candidate must reach the normal production FAPI, its sign-in/sign-up link must complete the real email-code flow on the auth host, return to the exact initiating candidate origin, and recognize a Clerk session there. Verify the auth host exposes only Clerk UI/static/public-session surfaces and rejects Workspace, Project, handoff, and app-session exchange APIs. The server must verify Clerk requests only for the exact auth and application-root `authorizedParties`, and the same immutable artifact must remain valid when later served on the canonical production hosts. Configure the finite candidate host family explicitly; do not infer sibling hosts or use a wildcard. Root and tenant app sessions and handoffs are origin-bound, so candidate credentials cannot replay on canonical hosts or vice versa. Do not temporarily point `kanban.cards` or its canonical tenant at the candidate to manufacture proof. Until Standard Protection, the exact two published WAF rules, three exact pinned routes, external deny plus canonical-exclusion receipts, one verified Clerk production FAPI DNS/custom domain, the two explicit Allowed Subdomains entries plus the inherently allowed primary root, exact application returns, and authorized-party checks exist, this cutover is deliberately blocked.

```bash
KANBAN_CARDS_AUTH_URL='https://auth.kanban.cards'
KANBAN_CARDS_CANDIDATE_ROOT_URL='https://candidate.release.kanban.cards'
KANBAN_CARDS_CANDIDATE_TENANT_URL='https://mike.candidate.release.kanban.cards'
vercel inspect "$KANBAN_CARDS_AUTH_URL" --format=json
vercel inspect "$KANBAN_CARDS_CANDIDATE_ROOT_URL" --format=json
vercel inspect "$KANBAN_CARDS_CANDIDATE_TENANT_URL" --format=json
```

Capture the canonical digest and resource fingerprint of `kanban_v2_workspaces:default` immediately before the first verified Clerk session exchange. On `https://candidate.release.kanban.cards`, use the rendered auth-host link, complete the real email-code flow at `https://auth.kanban.cards/sign-in` or `/sign-up`, and prove the exact initiating candidate is restored and recognizes the signed-in Clerk session before `POST /api/clerk-session`. Verify the exact admitted Clerk user ID, Clerk session ID, owner binding, root Workspace list, canonical handoff, tenant Project read, and exact-session Clerk sign-out with retry and completion acknowledgement. Immediately re-read the state before any tenant or compatibility write; the digest and fingerprint must equal the pre-exchange values. This pair proves that access binding did not change default Workspace data. Only after capturing equality, perform and record a bounded tenant-session write.

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

The authenticated bridge read must return the legacy Workspace Project list. It proves only that the bounded compatibility credential reaches the mapped `default` row; it does not prove Clerk identity or create missing legacy storage.

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

From Mike's reviewed exact source address, open the auth, `candidate.release.kanban.cards`, and `mike.candidate.release.kanban.cards` hostnames in the same browser. Each must reach its expected application surface without a Vercel mitigation response; the immediately following deny rule means that a valid response on an exact release host is evidence that the highest-priority bypass matched. Record the distinct `x-vercel-id` values and current published-config hash. Return to the candidate root, confirm ClerkJS reaches the single production FAPI without an app-owned proxy, follow its link to the dedicated auth host, complete the real email-code flow, confirm the browser returns to the exact candidate root and that root recognizes the verified Clerk session, and only then perform the server-side session exchange. Verify the root route lists only the admitted Clerk user's routed Workspaces, open the exact candidate tenant through the one-time handoff, and confirm the archived verification Card remains present in the Project and Activity evidence. On the auth host, verify `/sign-in`, `/sign-up`, static assets, and the public Clerk session contract are the only available surfaces; `/__clerk`, application, and handoff APIs must fail closed. Sign out and verify `DELETE /api/session` revokes both the app session family and exact Clerk session, then returns a short-lived signed continuation outside the URL. Confirm that continuation appears only in the immediately removed exact-origin POST body sent to the family-root `/auth/logout`, whose signed completion marker preserves the exact Clerk session ID. Confirm ClerkJS inspects its signed-in session list, ends only that matching `Session` if it remains, verifies the target ID is absent, and preserves any other browser account. Force one browser-cleanup failure and verify the marker remains for a successful retry without repeating server revocation; after cleanup succeeds, verify the client acknowledges completion, the root consumes the marker and sign-out hint, and the persistent `Signed out` state renders. A direct GET, a forged completion query, a tampered or stale continuation (including after a new root sign-in), or a completion acknowledgement without a valid marker must not sign out or claim success. Repeat at a narrow viewport. If any hostname is mitigated for the admitted source, available from the unadmitted external source, or not pinned to the exact deployment ID, stop. API checks do not replace rendered candidate verification.

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

`authOrigin` must be exactly `https://auth.kanban.cards`; the pre-promotion application and tenant origins must be exactly `https://candidate.release.kanban.cards` and `https://mike.candidate.release.kanban.cards`. The live evaluator inspects all three routes, requires a complete Project alias inventory with no `mike.kanban.cards` entry, and hydrates the active Firewall state rather than accepting self-attested rule IDs. Standard Protection (`all_except_custom_domains`) is required in both phases. Pre-promotion `firewallProof` binds the two exact live rule IDs, the reviewed exact source CIDR, deterministic published-config hash, admitted probe responses, and external deny/canonical-exclusion observations. `externalDenyProbe.correlationMethod` is mandatory, and its `runId` must equal the enclosing proof `runId` so the operator vouches that all five observations came from one atomic run. `platform-traffic` requires per-request Firewall Traffic fields `wafAction: deny` and `wafRuleId` equal to the hydrated live deny rule. `deterministic-live-policy` instead derives the unique eligible deny rule ID from the hydrated exact first/second live order, requires empty Project IP blocks and Attack Mode off, includes those facts in the config hash, and rejects any per-request `wafAction` or `wafRuleId` field as self-attested. Both methods require every external release-host observation to be a fresh HTTP `403` with `x-vercel-mitigated: deny` and a distinct `x-vercel-id`, all from the privately recorded exact external source. The same external source must leave the canonical root healthy on Postgres, while the canonical tenant observation must be HTTP `404`, unmitigated, carry `vercelError: DEPLOYMENT_NOT_FOUND` copied from `x-vercel-error`, and have a distinct `x-vercel-id`. The complete alias inventory and platform error together prove the canonical tenant is not routed before promotion; an application `404` is insufficient. Post-promotion proof requires the complete live Project alias inventory to exclude both candidate aliases, both recorded pre-promotion rule IDs and any rule referencing a temporary release host to be absent, no Firewall draft, a new published-config hash, and a Standard-protected generated deployment URL. Its `externalPublicProbe` must use a different exact /32 or /128 outside the retired bypass, bind the new published-config hash, and record fresh, distinct `x-vercel-id` values for unmitigated public auth, healthy Postgres root, and public canonical-tenant responses. `sameArtifactAuthHost` may be `passed` only when the exact deployment identity agrees. `clerkAuthorizedParties` may be `passed` only after the server accepts the dedicated auth origin and exact exercised application-root origins, rejects an unknown root origin, and bypasses Clerk middleware entirely on tenant and unknown hosts. Tenant access is proven separately through the app handoff/session checks. `clerkDomainConfiguration` is phase-exact: pre-promotion may pass only after the single Clerk production FAPI DNS/custom domain is verified, Allowed Subdomains is enabled with explicit entries exactly `auth.kanban.cards` and `candidate.release.kanban.cards`, and the primary root `kanban.cards` is confirmed inherently allowed; public post-promotion may pass only after the candidate entry is absent and only `auth.kanban.cards` remains explicitly allowed. In both phases, tenant/unknown hosts are absent, no app-owned proxy is configured, and the server-derived auth-host `/sign-in` and `/sign-up` routes and exact application returns are confirmed. No satellite or multi-domain configuration is part of this proof. `clerkProof` records distinct real-browser results for `authHostSurface`, `authHostIsolation`, `emailCodeAuth`, `sameRootSessionShare`, `sessionExchange`, `exactLegacyBinding`, `canonicalHandoff`, `tenantProjectAccess`, `tenantProjectWrite`, and `signOut`. `authHostSurface` requires the real Clerk sign-in/sign-up components on the dedicated auth host; `authHostIsolation` requires `/__clerk`, Workspace, Project, handoff, and app-session exchange APIs to fail closed there. `sameRootSessionShare` requires ClerkJS/FAPI participation on the exact app root, auth-host email-code completion, return to the exact initiating application root, recognition of a verified Clerk session on that root, and request-scoped exact `authorizedParties`. `signOut` may be `passed` only when the app session family and exact Clerk session are revoked, a signed continuation carrying that exact session identity remains outside URLs and persistent client storage, and the exact-origin root POST converts it to a signed host-only completion marker. ClerkJS must then confirm the target ID is absent or end only that matching signed-in `Session`, re-confirm absence, and preserve any different browser session. A failed browser cleanup must leave the marker for retry; only a successful exact-origin acknowledgement may consume it, remove the hint query, and render the persistent `Signed out` state. Direct GET, forged query, tampered-continuation, stale-continuation, and invalid-acknowledgement checks must fail closed. Do not record a user ID, email, code, cookie, token, session ID, Clerk key, or browser credential in the evidence file.

The data proof uses separate phase-bound pairs:

- Pre-promotion compares the canonical digest and resource fingerprint immediately before and after the access binding, before compatibility writes.
- Post-promotion compares the final candidate baseline with the public production state immediately after promotion, before post-promotion smoke writes.

Each fingerprint covers Project, Column, Card, Comment, and Activity ids, resource versions and revisions, archive state, and idempotency records.

Run the pre-promotion evaluator:

```bash
KANBAN_CARDS_EVIDENCE_PATH='paste-operator-controlled-evidence-path'
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" --live
```

Every blocker is named by gate and code. A pending binding, Clerk authentication, admission, session-exchange, or sign-out failure, malformed/unpublished Firewall contract, admitted/external probe failure, compatibility-loop failure, exact-artifact mismatch, changed default Workspace, unverified rollback target, enabled automatic domain assignment, or automatic `main` deployment leaves current production unchanged and returns a failing exit status.

## Promote the verified artifact

Promotion is a distinct explicit action. One controller re-reads the live Project policy, complete alias inventory, enabled/published Firewall configuration, exact candidate metadata, public production/rollback identity, dedicated-auth/candidate-root/candidate-tenant route pins, and both runtime readiness endpoints; validates the phase-bound receipt and literal confirmation; and passes the evaluated deployment ID directly to `vercel promote`. It accepts no independent promotion target:

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

Confirm the identity, linked Project, remote auto-assignment setting, Standard Protection, exact live Firewall rule IDs/order/conditions, empty draft, published-config hash, and complete alias inventory again immediately before promotion. A different ID, URL, SHA, Project, branch, alias state, Firewall state, source CIDR, or protection mode invalidates the evidence. Never substitute a branch alias or rebuild.

Immediately after promotion, keep both published WAF rules unchanged. Register and assign the previously unrouted canonical tenant only now, pin it to the exact promoted deployment, and inspect `https://auth.kanban.cards`, `https://kanban.cards`, and that canonical tenant route from Mike's admitted source; all three must resolve to the promoted deployment. A canonical tenant `404` that was required before promotion is now a blocker. Perform a bounded authenticated readiness and Clerk auth-host-to-canonical per-origin session smoke. While the deny rule still protects every unadmitted request to the temporary surface, remove the two candidate aliases and the Clerk candidate Allowed Subdomains entry. Do not remove `auth.kanban.cards`, `kanban.cards`, or the canonical tenant domain:

```bash
vercel alias rm "$(node -p 'new URL(process.env.KANBAN_CARDS_CANDIDATE_ROOT_URL).hostname')"
vercel alias rm "$(node -p 'new URL(process.env.KANBAN_CARDS_CANDIDATE_TENANT_URL).hostname')"
```

Re-list the complete Project alias inventory and stop unless both candidate aliases are absent globally, including from deployments other than the promoted one. In Clerk, remove `candidate.release.kanban.cards` from Allowed Subdomains and verify that `auth.kanban.cards` is the only explicit entry; `kanban.cards` remains inherently allowed. Stop if the candidate entry or any tenant, wildcard, generated, or unknown host remains. Only after both alias and Clerk cleanup pass may the operator stage removal of both temporary WAF rules. Remove the exact pre-promotion rule IDs in one draft, confirm no other rule changed, and publish the two removals atomically:

```bash
vercel firewall rules remove "kanban-candidate-mike-bypass" --yes
vercel firewall rules remove "kanban-candidate-deny" --yes
vercel firewall diff --json
# The authorized operator confirms exactly two removals, then runs:
vercel firewall publish --yes
vercel firewall overview --json
vercel project protection
npm run release:preflight
```

Continue only when the live policy still reports `all_except_custom_domains`, the Firewall has no draft, both pre-promotion rule IDs and every rule referencing a temporary release host are absent, both candidate aliases are globally absent, generated deployments remain protected, and the complete alias inventory includes the canonical tenant route while the canonical auth/root/tenant routes are public. If removal or publication fails, stop with the still-published deny rule in place; never disable the Firewall or publish a partial cleanup. Rollback remains a separate authorization.

Now inspect `https://auth.kanban.cards`, `https://kanban.cards`, and the canonical tenant route for the public post-promotion receipt. Repeat those three probes from an external exact /32 or /128 outside the retired bypass and bind each fresh, distinct `x-vercel-id` plus the unmitigated response to the new published-config hash; the root must return healthy Postgres evidence. The auth and canonical application origins must still resolve to the exact promoted deployment; the post receipt records the new published-config hash, empty Firewall draft, removal of both exact pre-promotion rule IDs, global absence of both temporary aliases, public auth/root/tenant probes, Standard protection on the generated deployment, and Clerk Allowed Subdomains containing only the explicit `auth.kanban.cards` entry. In a signed-out or private browser window, open `https://kanban.cards`, confirm ClerkJS reaches the single production FAPI without an app-owned proxy, use its sign-in/sign-up link, and verify the dedicated auth-host surface loads at `https://auth.kanban.cards/sign-in` or `/sign-up` without a Vercel mitigation. Complete the real email-code flow, prove the browser returns to `https://kanban.cards` and that origin recognizes the verified Clerk session, and then perform the server-side session exchange. Confirm the root route exposes only the expected Workspaces for the exact admitted Clerk user ID, then open the canonical tenant and verify the Project list. Recheck that `/__clerk`, application, and handoff APIs remain unavailable on the auth host. Sign out and repeat the exact-session cleanup proof: the app session family and exact Clerk session are revoked, the signed continuation remains body-only, ClerkJS confirms the target is absent or ends only that exact remaining `Session`, and any other browser account remains signed in. Retry must retain the marker after a forced cleanup failure, and successful exact-origin acknowledgement must consume it before the persistent `Signed out` state renders. Only then sign in again for the remaining proof. While the compatibility bridge is enabled, configure the helper for the public production origin without placing the key on the command line. If the bridge is disabled, skip helper setup and run the retirement proof below.

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

Update the evidence snapshot with the exact deployment now serving `kanban.cards` and the repeated readiness, Clerk, compatibility, and unchanged-data proofs. Then run:

```bash
npm run release:gate -- --snapshot "$KANBAN_CARDS_EVIDENCE_PATH" --phase post-promotion --live
```

Do not describe the release as complete until this post-promotion gate passes. If it fails, report the exact blocker and keep the recorded rollback target available. Do not roll back automatically; rollback remains a separately authorized production mutation.

After the post-promotion gate passes, re-confirm that the two candidate aliases remain absent and that `auth.kanban.cards` still serves the exact promoted artifact. The candidate host-family environment values remain inert in the immutable artifact once no route points to them; remove those values from the Project environment before the next deployment.

## Retire the compatibility API key

Retirement is complete only when Clerk access works without the bridge and no reachable deployment still accepts the retired key.

1. On the candidate, complete Clerk email-code sign-up/sign-in and server-side session exchange, open the legacy tenant, and verify a Project read and write through the tenant session.
2. Confirm `/api/access/health` reports `legacyState: ready`, `legacyBinding.status: ready`, and `legacyBridge: enabled` before removal.
3. Remove `KANBAN_CARDS_API_TOKEN` from the candidate environment without changing the stored `default` mapping. Keep `KANBAN_CARDS_API_WORKSPACE_ID=default` only if the deployment process requires the explicit compatibility boundary; it grants no authority without the token.
4. Build and verify a new exact candidate. `/api/health` and `/api/access/health` must stay healthy, and `/api/access/health` must now report `legacyBridge: disabled`.
5. Repeat Clerk root, tenant handoff, Project read/write, app-family plus exact-session Clerk sign-out, failed-cleanup retry, successful completion acknowledgement, and recovery checks. The browser path must not depend on the retired token.
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
