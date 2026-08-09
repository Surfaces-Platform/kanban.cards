# kanban.cards

kanban.cards is a small, skill-first Kanban system. An agent uses the same resource API as the browser and acts with the owner's credential. The website is the visual oversight surface; it is not a second workflow engine.

The product model is deliberately narrow:

```text
Owner
└── Projects
    ├── Columns
    ├── Cards
    │   └── Comments
    └── Activity
```

A Project is the board. There are no teams, board sub-resources, modeled agents, delegated sessions, roles, reviewers, approval gates, workflow generators, or legacy-board migration.

## Design authority

- [`docs/product-vision.md`](docs/product-vision.md) defines the product purpose, model, and trust boundary.
- [`DESIGN.md`](DESIGN.md) governs the current experience and design.
- [`UI_CONTRACT.md`](UI_CONTRACT.md) records testable constraints in the current browser implementation.
- [`docs/design-language.md`](docs/design-language.md) preserves historical research and is not an implementation source.

## First local run

Prerequisites: Node.js 20 or newer and npm.

```bash
npm install
export KANBAN_CARDS_API_TOKEN='choose-a-local-owner-key'
npm run dev
```

Open `http://127.0.0.1:4317` and enter the same owner key. Static assets and the sign-in screen remain public; project data requires either the signed browser cookie or bearer token.

The runnable helper is included with the skill. Connect it to the local server:

```bash
printf '%s\n' "$KANBAN_CARDS_API_TOKEN" | \
  node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  setup --url http://127.0.0.1:4317/api --token-stdin

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  create-project --name "My project"
```

Bind the returned project ID to the current repository:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  bind --project <project-id>
```

The user-level configuration at `~/.kanban-cards/config.json` contains the API origin and credential and is written with mode `0600`. The repository file `.kanban-cards.json` contains only `projectId`; a repository cannot redirect the credential to another origin.

## Agent workflow

Invoke `$kanban-cards` from a project to:

1. Create or bind a kanban.cards Project.
2. Turn recommendations or a plan into cards with stable external keys.
3. Read current status before beginning work.
4. Comment on and move cards as execution progresses.
5. Reconcile the board after repository changes.

Create operations accept `Idempotency-Key`, card imports can use `externalKey`, and writes use project revisions or card versions to prevent silent overwrites.

## Runtime and storage

Runtime source is TypeScript under `src/`:

- `src/server.ts`: public shell, owner authentication, and resource API
- `src/state-store.ts`: local JSON and Postgres persistence
- `src/client/app.ts`: sign-in, project list, Kanban board, and Card detail and editing
- `src/cli/kanban-cards-client.ts`: skill helper

The TypeScript CLI source builds to the tracked `.agents/skills/kanban-cards/scripts/kanban-cards-client.mjs` executable. After changing the CLI source, run `npm run build:cli` and include the regenerated helper in the same change so a clean checkout remains runnable.

Local development stores state in `data/kanban-cards-v2-state.json` unless a database URL is configured. Production uses the independent `kanban_v2_workspaces` table. Old workspace rows are not imported or read.

Environment variables:

- `KANBAN_CARDS_API_TOKEN`: required owner key in production
- `KANBAN_CARDS_OWNER_LABEL`: optional activity label, default `Owner`
- `KANBAN_CARDS_SESSION_TTL_SECONDS`: optional browser-cookie lifetime, default seven days
- `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`: Postgres connection

Every environment requires the owner key. A non-loopback bind is treated as production: cookies are Secure and a database URL is required. Missing authentication or storage configuration fails closed while the public shell remains available.

## API

The browser and helper use the same endpoints:

```text
GET/POST/DELETE /api/session
GET/POST        /api/projects
GET/PATCH       /api/projects/:projectId
POST            /api/projects/:projectId/cards
PATCH           /api/projects/:projectId/cards/:cardId
POST            /api/projects/:projectId/cards/:cardId/comments
GET             /api/projects/:projectId/activity
```

See [the skill API reference](.agents/skills/kanban-cards/references/api.md) for request details.

## Validation

```bash
npm run typecheck
npm run build
npm run check
npm test
```

`npm run check` verifies compilation plus the primary UI contract. `npm test` verifies authentication, authorization, idempotency, optimistic version conflicts, file persistence, the Postgres adapter through an isolated fake, and CLI configuration. A passing automated suite means the implementation contract holds; it does not prove connectivity to the production database or replace rendered browser verification before deployment.

## Deployment

The repository deploys to Vercel as an Express function through `api/index.ts`.

1. Configure the owner key and Postgres URL for production.
2. Deploy the exact validated commit to a protected production-target candidate without moving the public domain.
3. Make an authenticated candidate read and confirm it reports the `postgres` store. That request creates the V2 table and empty workspace idempotently when they do not exist.
4. Verify a skill-created Card, comment, movement, Activity, and rendered browser state against the candidate before promoting that exact artifact.

`npm run db:init` is an optional manual initializer only when a production database URL is already present in the current process. Treat it as successful production proof only when it reports `Initialized V2 postgres workspace at kanban_v2_workspaces:default`; a `file` result initialized local storage instead. Follow [the runbook](docs/runbook.md) for the complete candidate, promotion, rotation, and rollback procedure.

No V1 import, compatibility mode, or dual write is required. Git history preserves the V1 source for historical inspection; it does not retain V1 runtime board data.
