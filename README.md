# kanban.cards

kanban.cards is a private-beta Kanban board for human and agent-controlled cards. Humans use the browser UI to describe or choose a workflow, create cards, and review activity. Agents use the API to create cards, move cards, and post progress or reviewer-facing comments.

For the product thesis and the "why Kanban / why agents using Kanban" framing, see [Product Vision](docs/product-vision.md).

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
- `KANBAN_CARDS_BASIC_USER`: private-beta UI username
- `KANBAN_CARDS_BASIC_PASSWORD`: private-beta UI password
- `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`: Postgres connection string

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
