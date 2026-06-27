# Production Rollout Runbook

This runbook covers the kanban.cards production rollout path for Auth0, database readiness, deployment, smoke checks, promotion, rollback, log monitoring, and roadmap board seeding.

## Auth0 Settings

Use the shared Surfaces Auth0 Regular Web Application for `surfaces.us.auth0.com`.

Production settings:

- Allowed Callback URLs: `https://kanban.cards/auth/callback`
- Allowed Logout URLs: `https://kanban.cards/`, `https://kanban.cards/auth/logout/complete`
- Allowed Web Origins: `https://kanban.cards`

Local settings:

- Allowed Callback URLs: `http://127.0.0.1:4317/auth/callback`
- Allowed Logout URLs: `http://127.0.0.1:4317/`, `http://127.0.0.1:4317/auth/logout/complete`
- Allowed Web Origins: `http://127.0.0.1:4317`

Set `OIDC_POST_LOGOUT_REDIRECT_URI=https://kanban.cards/auth/logout/complete` in production. The Post Login Action must emit `https://surfaces.systems/workspace_id` and include `kanban.cards` in `https://surfaces.systems/surface_access`.

## Environment Check

Production must have these configured before deploy or promotion:

- `KANBAN_CARDS_API_TOKEN`
- `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`
- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_REDIRECT_URI=https://kanban.cards/auth/callback`
- `OIDC_POST_LOGOUT_REDIRECT_URI=https://kanban.cards/auth/logout/complete`
- `SESSION_SECRET`
- `PLATFORM_SURFACE_ID=kanban.cards`

Useful checks:

```bash
vercel env ls
vercel pull --yes --environment=production
npm run typecheck
npm run check
npm test
```

Do not commit pulled `.env` files or tokens.

## Local Flow AI Check

Flow drafting is local-only in this pass and uses LM Studio's OpenAI-compatible API. Production Auth0, database, and board APIs do not require LM Studio to be running.

For local QA:

1. Start LM Studio from the Developer tab or run `lms server start`.
2. Load a model that supports structured output.
3. Confirm the model endpoint:

```bash
curl http://127.0.0.1:1234/v1/models
```

4. Start kanban.cards with optional overrides when needed:

```bash
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1 \
LM_STUDIO_MODEL='<model-id>' \
npm run dev
```

The flow editor sends a schema-constrained `POST /v1/chat/completions` request and keeps drafts unapplied until the user reviews and applies them.

## Database Init

Initialize the workspace, agent token, and event tables after production Postgres env vars are available:

```bash
export KANBAN_CARDS_DATABASE_URL='<production-postgres-url>'
npm run db:init
```

The command is idempotent and prints the initialized store paths.

## Deploy And Smoke

Create a preview deployment and inspect it before promotion:

```bash
vercel deploy
vercel inspect <deployment-url>
```

Smoke checks against the preview URL:

```bash
curl -fsS <deployment-url>/api/health
curl -i <deployment-url>/api/state
```

Expected smoke results:

- `/api/health` returns `ok: true` and `product: "kanban.cards"`.
- `/api/state` without auth returns `401`.
- Browser navigation without a session redirects to `/auth/login`.
- Auth0 login succeeds and `/auth/session` returns `workspaceId`, `teamId`, and `projectId`.
- Logout clears the session and returns to kanban.cards.

## Promote

Promote the verified preview deployment without rebuilding:

```bash
vercel promote <deployment-url>
```

After promotion, repeat the smoke checks against `https://kanban.cards`.

## Rollback

Rollback to the previous production deployment:

```bash
vercel rollback
```

Rollback to a specific deployment when the target is known:

```bash
vercel rollback <deployment-url-or-id>
```

After rollback, smoke `https://kanban.cards` and confirm Auth0 login/logout still works.

## Log Monitoring

Monitor logs during smoke, promotion, and rollback:

```bash
vercel logs <deployment-url> --follow
vercel logs https://kanban.cards --follow
vercel logs https://kanban.cards --level error --since 1h
```

Escalate if production logs show repeated `500` responses, Auth0 config errors, database connection failures, token verification failures, or event stream failures.

## Roadmap Seed

Preferred production path:

1. Sign in to `https://kanban.cards` with an Auth0 user that has `surface_access: kanban.cards`.
2. Open `https://kanban.cards/admin/roadmap-seed`.
3. Run `Dry run`.
4. Run `Seed roadmap`.
5. Return to `https://kanban.cards` and verify `kanban.cards Product Roadmap` exists with the expected cards.

This path uses the authenticated session for authorization and the server runtime config for internal API access, so the break-glass bearer token is not copied into a local shell.

CLI fallback for automation or break-glass operations:

```bash
KANBAN_CARDS_API_BASE_URL=https://kanban.cards/api \
KANBAN_CARDS_API_TOKEN='<admin-token>' \
npm run roadmap:seed -- --dry-run
```

Apply the seed through the CLI:

```bash
KANBAN_CARDS_API_BASE_URL=https://kanban.cards/api \
KANBAN_CARDS_API_TOKEN='<admin-token>' \
npm run roadmap:seed
```

To seed a non-active project:

```bash
KANBAN_CARDS_API_BASE_URL=https://kanban.cards/api \
KANBAN_CARDS_API_TOKEN='<admin-token>' \
KANBAN_CARDS_PROJECT_ID='<project-id>' \
npm run roadmap:seed -- --dry-run
```

The seed creates or updates `kanban.cards Product Roadmap`, applies the Generic Agent Review flow, and upserts the named rollout cards by title without deleting unknown cards or comments.
