# kanban.cards

kanban.cards is a private-beta Kanban board for human and agent-controlled cards. Humans use the browser UI to describe or choose a workflow, create cards, and review activity. Agents use the API to create cards, move cards, and post progress or reviewer-facing comments.

## Local Development

```bash
npm install
npm start
```

The local server defaults to `http://127.0.0.1:4317` and stores state in `data/kanban-cards-state.json` unless a database URL is configured.

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

This repo is designed to deploy to Vercel as a Node function through `api/index.js`. The intended production project is `kanban.cards` under the `surfaces-platform` Vercel team, connected to `Surfaces-Platform/kanban.cards`.

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

## Checks

```bash
npm run check
npm test
```
