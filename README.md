# kanban.cards

kanban.cards is a private-beta Kanban board for human and agent-controlled cards. Humans use the browser UI to describe or choose a workflow, create cards, and review activity. Agents use the API to create cards, move cards, and post progress or reviewer-facing comments.

For the product thesis and the "why Kanban / why agents using Kanban" framing, see [Product Vision](docs/product-vision.md). For the target user, team, project, and agent governance model, see [AI-Native Access Model](docs/ai-native-access-model.md). For the Auth0 dashboard contract, see [Auth0 Setup](docs/auth0-setup.md).

## Local Development

```bash
npm install
npm run dev
```

The local server defaults to `http://127.0.0.1:4317` and stores state in `data/kanban-cards-state.json` unless a database URL is configured.

Runtime source lives in TypeScript under `src/`. `src/client/app.ts` builds to `public/app.js`, and `src/cli/kanban-cards-client.ts` builds to the existing local-agent helper command path. Generated JavaScript and copied static assets are build output, not committed source.

## Environment

Production requires:

- `KANBAN_CARDS_API_TOKEN`: admin compatibility bearer token for emergencies and tests
- `OIDC_ISSUER`: Auth0/OIDC issuer URL
- `OIDC_CLIENT_ID`: Auth0/OIDC client ID
- `OIDC_REDIRECT_URI`: callback URL, usually `https://kanban.cards/auth/callback`
- `SESSION_SECRET`: unique secret for signing session cookies
- `PLATFORM_SURFACE_ID`: `kanban.cards`
- `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`: Postgres connection string

Optional Auth0/OIDC settings:

- `OIDC_CLIENT_SECRET`: client secret when required by the Auth0 application
- `OIDC_LOGOUT_URL`: Auth0 v2 logout URL, for example `https://<tenant>.auth0.com/v2/logout`
- `OIDC_POST_LOGOUT_REDIRECT_URI`: post-logout return URL, usually `https://kanban.cards/`
- `OIDC_WORKSPACE_CLAIM`: override for the workspace claim key
- `OIDC_SURFACE_ACCESS_CLAIM`: override for the surface access claim key
- `SESSION_TTL_SECONDS`: session cookie lifetime, default `604800`

Auth0 must allow these callback URLs:

- `https://kanban.cards/auth/callback`
- `http://127.0.0.1:4317/auth/callback`

Auth0 must allow these logout URLs:

- `https://kanban.cards/`
- `https://kanban.cards/auth/logout/complete`
- `http://127.0.0.1:4317/`
- `http://127.0.0.1:4317/auth/logout/complete`

The Auth0 Post Login Action should emit `https://surfaces.systems/workspace_id` and include `kanban.cards` in `https://surfaces.systems/surface_access`.

Local aliases from the earlier Instruct prototype are still accepted temporarily:

- `INSTRUCT_API_BASE_URL`
- `INSTRUCT_API_TOKEN`
- `INSTRUCT_DATA_PATH`

## Deployment

This repo is designed to deploy to Vercel as a Node function through `api/index.ts`. The intended production project is `kanban.cards` under the `surfaces-platform` Vercel team, connected to `Surfaces-Platform/kanban.cards`.

Initialize the workspace table after the Postgres env vars are available:

```bash
npm run db:init
```

`db:init` initializes both the workspace table and the `agent_access_tokens` table.

## Local Agent Access

Normal local agents should use scoped tokens generated from the private UI instead of the admin bearer token. In Edit flow, open an existing board agent and choose `Connect`; kanban.cards returns a one-time setup command:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs setup --url https://kanban.cards/api --token <token> --board <board-id> --agent <agent-id>
```

The helper writes `~/.kanban-cards/config.json` with `0600` permissions. Runtime precedence is environment variables first, then the config file, then local defaults.

## Local Private Beta Security Release Workflow

Use the local workflow runner to seed a private beta security release and execute the scoped agent actions:

```bash
npm run demo:prepare
npm run demo:server
```

Open `http://127.0.0.1:4317`, then run each visible agent action one at a time:

```bash
npm run demo:step -- coordinator-intake
npm run demo:step -- risk-triage
npm run demo:step -- engineer-plan
npm run demo:step -- engineer-implementation
npm run demo:step -- security-change-request
npm run demo:step -- engineer-evidence
npm run demo:step -- security-approval
npm run demo:step -- coordinator-closeout
npm run demo:verify
```

To generate a browser-only MP4 with narration:

```bash
KANBAN_CARDS_DEMO_RECORD_TTS_PROVIDER=elevenlabs npm run demo:record
```

The workflow state is written under `.demo/`, creates scoped per-agent configs, and uses the generated CLI helper for all agent actions. `.demo/` is ignored so generated tokens and local run artifacts are never committed.

```bash
npm run demo:reset
```

## Checks

```bash
npm run typecheck
npm run build
npm run check
npm test
```
