# Runbook

This runbook covers local verification, Vercel deployment, production checks, owner-key rotation, and rollback for the V2 single-owner system.

## Operating boundary

One owner key grants read and write access to the entire workspace. Treat it like a password:

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

The browser exchanges the key for a signed, expiring, HttpOnly cookie. The CLI stores the key in `~/.kanban-cards/config.json` with mode `0600` and sends it as a bearer token. A deployment using a rotated key rejects browser cookies signed with the old one and requires CLI setup again. Older immutable deployment URLs retain their original environment snapshot; protect or retire them separately.

## Runtime contract

Production requires:

- `KANBAN_CARDS_API_TOKEN`
- one of `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`

Optional:

- `KANBAN_CARDS_OWNER_LABEL`
- `KANBAN_CARDS_SESSION_TTL_SECONDS`

Local operator controls:

- `KANBAN_CARDS_DATA_PATH`
- `HOST`
- `PORT`

`KANBAN_CARDS_POSTGRES_SSL=disable` is available for a trusted local database. Do not use it in production.

The public shell and session exchange load without prior authentication. Project data returns `503` when required configuration is missing and `401` when the supplied owner credential is invalid.

## Validate the candidate commit

Run from the repository root:

```bash
npm ci
npm run check
npm test
git status --short
git rev-parse HEAD
```

`git status --short` must be empty. Record the full commit SHA. Do not deploy an uncommitted working tree or a different commit from the one that passed validation.

Passing automation confirms the implementation contract. It does not prove the deployed database, browser rendering, or provider environment.

The CLI test exercises setup, repository binding, create deduplication, comments, movement, stale-version protection, Activity, and credential permissions inside isolated temporary state. Do not overwrite the operator's real local workspace or user-scoped CLI connection merely to repeat that automated loop by hand.

## Verify Vercel scope and configuration

Before reading or changing environment variables, storage, deployments, aliases, or rollback state, verify the active Vercel identity and linked Project:

```bash
vercel whoami
vercel project inspect
vercel project protection
```

Confirm the expected account or team, the `kanban.cards` Project, and its deployment-protection boundary. Stop on any mismatch. Repeat this preflight immediately before a later Vercel mutation if the session, terminal, or active scope may have changed.

Configure required values for the production environment through the Vercel dashboard or interactive CLI. Do not use `--value` for secrets because it places them in command history.

```bash
vercel env add KANBAN_CARDS_API_TOKEN production --sensitive
vercel env add KANBAN_CARDS_DATABASE_URL production --sensitive
```

If a variable already exists, update it interactively:

```bash
vercel env update KANBAN_CARDS_API_TOKEN production --sensitive
vercel env update KANBAN_CARDS_DATABASE_URL production --sensitive
```

List names and targets without printing values:

```bash
vercel env list production
```

## Initialize storage

The deployed Postgres adapter creates `kanban_v2_workspaces` and its empty V2 workspace during the first authenticated read. This is idempotent and does not replace an existing workspace. It does not inspect or import V1 workspace, event, membership, or agent-session data.

`npm run db:init` remains available when a database URL is already present in the current process. Do not rely on `vercel env run` to inject a sensitive database value into the local shell. If the initializer is run manually, it must report:

```text
Initialized V2 postgres workspace at kanban_v2_workspaces:default
```

Stop if it reports `file`. The authenticated candidate read below is the production storage proof.

For the first V2 release, preserve any environment configuration needed by the previous known-good deployment until V2 has passed production verification.

## Create a candidate deployment

Deploy the validated commit to the production target without assigning the production domain:

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
```

Do not rebuild between verification and promotion.

## Verify the candidate deployment

Generated deployment URLs may be behind Vercel Deployment Protection even when the custom production domain is public. Use `vercel curl`, which handles the linked Project's protection boundary, for source and API checks:

```bash
vercel curl /api/health --deployment "$KANBAN_CARDS_DEPLOYMENT_URL"
```

Confirm `ok` is `true`, `store` is `postgres`, and `missingConfiguration` is empty. Then provide the owner key without placing it in a command argument and perform a real authenticated storage read:

```bash
printf 'Production owner key: '
IFS= read -r -s KANBAN_CARDS_API_TOKEN
printf '\n'
printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl /api/projects --deployment "$KANBAN_CARDS_DEPLOYMENT_URL" -- --config -
```

The authenticated read must return the Project list. It also proves that the production-target deployment can reach Postgres and initialize the V2 table; `/api/health` alone does not query storage.

Use one persistent `Release verification` Project for deployment checks. Copy its ID from the Project list. If it does not exist, run this request once, then copy the returned ID:

```bash
printf 'header = "Authorization: Bearer %s"\nheader = "X-Kanban-Actor: release-check"\n' \
  "$KANBAN_CARDS_API_TOKEN" | \
  vercel curl /api/projects --deployment "$KANBAN_CARDS_DEPLOYMENT_URL" -- \
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
    --deployment "$KANBAN_CARDS_DEPLOYMENT_URL" -- \
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
    --deployment "$KANBAN_CARDS_DEPLOYMENT_URL" -- \
    --config - \
    --include \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: release:$KANBAN_CARDS_RELEASE_RUN_ID:external-replay-v1" \
    --data "{\"title\":\"Verify release $KANBAN_CARDS_RELEASE_RUN_ID\",\"body\":\"Production smoke check.\",\"externalKey\":\"release:$KANBAN_CARDS_RELEASE_RUN_ID\"}"

unset KANBAN_CARDS_API_TOKEN
```

The first Card request must return `201` with version `1`. The second uses a different idempotency key and the same external key; it must return `200`, `deduplicated: true`, and the same Card ID. This is the provider-live proof that the candidate can read and mutate Postgres. The Card remains visible until the post-promotion check archives it.

Open the immutable deployment URL in a browser authenticated with Vercel when Deployment Protection requires it. Confirm the kanban.cards sign-in surface renders, an invalid owner key creates no app session, a valid owner key loads the Project list, and the verification Card appears. If the browser cannot cross the Vercel protection boundary, stop. API checks do not replace rendered candidate verification.

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

## Promote the verified artifact

Promote the exact deployment that passed verification:

```bash
vercel whoami
vercel project inspect
vercel project protection
vercel promote "$KANBAN_CARDS_DEPLOYMENT_URL"
vercel inspect https://kanban.cards
```

Confirm the identity, linked Project, and protection boundary again before promotion. Then configure the helper for the public production origin without placing the owner key on the command line:

First open `https://kanban.cards` in a signed-out or private browser window. The kanban.cards sign-in surface must load without a Vercel login or another external redirect. Confirm an invalid owner key creates no app session and a valid key loads the Project list.

The helper has exactly one user-scoped connection and no named profiles or supported alternate config path. This verification requires `setup` so the following commands are pinned to the public production origin. Continue only when replacing that one connection with the production origin, actor, and owner credential is the intended outcome. If an existing connection must be retained, stop and run this verification from a designated production-operator account or machine instead. Do not copy the credential-bearing config into the repository or an ad hoc backup.

```bash
printf 'Production owner key: '
IFS= read -r -s KANBAN_CARDS_API_TOKEN
printf '\n'
printf '%s\n' "$KANBAN_CARDS_API_TOKEN" | \
  node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  setup --url https://kanban.cards/api --actor codex --token-stdin
unset KANBAN_CARDS_API_TOKEN

curl -fsS https://kanban.cards/api/health
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs session
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs projects
```

Reuse the Project, Card, and run ID from candidate verification. Run the public-origin smoke loop with `--project` so verification does not change the repository binding:

```bash
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

The helper create must return the same Card ID and version `1` created on the candidate URL. That proves the promoted public origin and protected candidate used the same artifact and store. The stale update must fail with the stale-version message; the automated API test verifies the underlying `409`. Use a new release run ID for every smoke run.

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

## Rotate the owner key

The single-key model has no built-in overlap or revocation registry. Vercel environment changes apply to new deployments; they do not rewrite older immutable deployments. Rotation is incomplete while any deployment that contains the old key can still reach the workspace database.

1. Open an exclusive deployment window. Do not allow another deployment until rotation closes; if one occurs, stop and rebuild the inventory. Verify the Vercel identity and Project.

   ```bash
   vercel whoami
   vercel project inspect
   vercel project protection
   ```

2. Because this runbook configures the owner key only for production, conservatively treat every existing production deployment as an old-key deployment. List every page and record every deployment ID in the rotation record. Copy the returned `next` cursor into the second command and repeat it until no next cursor remains:

   ```bash
   vercel ls --environment production --format=json
   vercel ls --environment production --format=json --next 'paste-next-cursor'
   ```

   If the owner key was ever configured for preview or development, inventory every page of those environments too. Do not assume the production-only inventory is complete.

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
   printf 'Old owner key: '
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

   Every recorded old-key deployment must be absent from all pages, no alias on any page may point to one, and a final `vercel inspect` for each recorded ID must fail because the deployment no longer exists. If the owner key existed in another environment, prove the same closure there. If an old-key deployment cannot be retired, revoke or rotate its database credential before treating owner-key rotation as complete.
11. Sign in again in the browser and run CLI `setup --token-stdin` again for every user-scoped helper configuration that should retain access.

Do not log either key during comparison. Never use an old-key deployment as a rollback target.

## Failure interpretation

- `401`: authentication failed. Check the API origin, browser input or user-scoped CLI configuration, recent key rotation, and the active deployment's environment snapshot.
- `409` with a stale-version message: read the current Project or Card, reconcile, and retry with the returned revision or version.
- `409` for an idempotency-key mismatch: reuse the original request body or choose a new stable key for the changed request.
- `409` for an archived Project: stop writing to it or restore it deliberately through the resource API.
- `409` while changing Columns: move or archive every Card that would be stranded before removing its Column.
- `400` naming `If-Match`: replace the legacy helper or caller; writes require `X-Kanban-Version` so a hosted response cannot be rewritten after the mutation commits.
- `428`: the caller omitted the required `X-Kanban-Version` revision or version on an edit.
- `503`: required owner-key or database configuration is missing.
- `/api/health` succeeds but authenticated reads fail: configuration is present, but storage may be unavailable or the caller may be using the wrong credential or origin.
- Duplicate Card creation: the caller omitted a stable external key and did not reuse the same idempotency key, or server deduplication regressed.
- Browser and helper disagree: reload the browser, then confirm both clients use the same origin and Project. A repository binding selects context but does not scope authority.

Never replace a production database failure with file storage.

## Retention and recovery

- Each Project retains its newest 1,000 Activity entries. The Activity endpoint returns at most the newest 200 per request and has no pagination.
- The workspace retains its newest 1,000 idempotency records. A stable Card external key remains the stronger long-lived deduplication mechanism.
- Archiving is non-destructive at the API level, but the primary clients currently expose Card archive without restore.
- Before decommissioning V2, take a database-provider snapshot and export every Project needed for inspection. The helper's `project --project <project-id>` output contains that Project's Columns, Cards, Comments, and retained Activity. Store exports outside the repository and do not include the owner key.

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

After an owner-key rotation, do not roll back to a deployment that still contains the prior key. Establish a new known-good rollback target under the rotated environment first.
