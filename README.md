# kanban.cards

kanban.cards is a small, skill-first Kanban system. Owners use Clerk-verified, tenant-aware browser sessions. Automated clients use neutral AgentConnections bound to one owner and one Workspace with explicit scopes; the earlier compatibility credential remains a legacy migration bridge only. The website is the visual oversight surface.

The product model is deliberately narrow:

```text
Owner
└── Workspaces
    └── Projects
    ├── Columns
    ├── Cards
    │   └── Comments
    └── Activity
```

A Project is the board. Workspaces are the tenant boundary. AgentConnections are bounded credentials rather than vendor identities, users, roles, or a general policy system.

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

Open `http://127.0.0.1:4317` and enter the same owner key. This form is the deliberate local fallback when Clerk is absent. Production has one sign-in path: choose Start free, enter an email address, and open Clerk's emailed verification link. Any server-verified Clerk identity with a verified primary email is admitted by its durable Clerk user ID; an owner with zero Workspaces may create one after sign-in. Project data requires a tenant session, a scoped AgentConnection credential, or the Workspace-bound compatibility bearer.

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
- `src/clerk-auth.ts`: Clerk middleware, exact user admission, verified profile loading, and Clerk session revocation
- `src/app-sessions.ts`: signed, origin-bound root/tenant sessions plus logout retry and exact-session completion cookies
- `src/access-store.ts`: owner, Workspace, ownership, and one-time handoff registry
- `src/state-store.ts`: local JSON and Postgres persistence
- `src/client/app.ts`: sign-in, project list, Kanban board, and Card detail and editing
- `src/cli/kanban-cards-client.ts`: skill helper

The TypeScript CLI source builds to the tracked `.agents/skills/kanban-cards/scripts/kanban-cards-client.mjs` executable. After changing the CLI source, run `npm run build:cli` and include the regenerated helper in the same change so a clean checkout remains runnable.

Local development stores state in `data/kanban-cards-v2-state.json` unless a database URL is configured. Production uses the independent `kanban_v2_workspaces` table. Old workspace rows are not imported or read.

Production requires the database URL, Vercel Marketplace's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ENCRYPTION_KEY`, `SESSION_SECRET`, `KANBAN_CARDS_ROOT_HOST=kanban.cards`, and `KANBAN_CARDS_AUTH_HOST=auth.kanban.cards`. `CLERK_PUBLISHABLE_KEY` remains accepted as a compatibility alias, but both names must match if both are set. A Vercel production runtime requires Marketplace production-instance keys beginning with `pk_live_` and `sk_live_`; development keys fail configuration before readiness. The encryption and app-session secrets must each be at least 32 bytes. Clerk supplies the verified user ID, primary verified email, display name, and session ID; the server never admits or binds an owner by email. `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS` remains an optional validated migration input but does not gate new verified owners. The optional legacy cutover requires `KANBAN_CARDS_LEGACY_CLERK_USER_ID` plus the Workspace slug/name. While the skill bridge remains enabled, configure `KANBAN_CARDS_API_TOKEN` and `KANBAN_CARDS_API_WORKSPACE_ID=default`; remove the token after AgentConnection access passes the retirement proof.

`auth.kanban.cards` is the stable auth-only UI host. The same artifact redirects its root entry to `/sign-in`; `/sign-up` loads the shell and is client-canonicalized to `/sign-in`. It serves Clerk's email-link sign-in/sign-up component only at canonical `/sign-in` and never serves Workspace, Project, AgentConnection, handoff, or app-session exchange APIs. A signed-out application root offers one `Start free` action, which opens the auth form with its exact initiating return origin. Clerk uses one normal production Frontend API (FAPI) DNS/custom-domain setup for the `kanban.cards` root domain; there is no app-owned `/__clerk` proxy on any application origin. Request-scoped Clerk `authorizedParties` remain exact per auth or application origin. Tenant hosts accept only separate origin-bound kanban.cards app sessions, and app sessions and handoffs cannot cross candidate and canonical host families.

Global sign-out revokes the kanban.cards session family and exact Clerk session before the browser cleanup step. The server returns a short-lived signed continuation only in the immediately removed hidden-form POST body; the family root validates its exact initiating origin and stores the exact Clerk session ID in a signed, short-lived, host-only completion marker. ClerkJS then inspects its documented signed-in session list: if that exact session remains, the client ends only that `Session`; if backend revocation already removed it, no other browser account is touched. Only after the target is confirmed absent does the client acknowledge cleanup, consume the marker, and display the persistent `Signed out` state. A failed check or cleanup keeps the marker available for retry without repeating server revocation.

The access migration leaves the existing `kanban_v2_workspaces:default` JSON unchanged and adds an access-registry mapping around it. See [`docs/workspace-access-migration.md`](docs/workspace-access-migration.md) for the exact cutover and rollback proof.

## API

The browser and helper use the same endpoints:

```text
GET/POST/DELETE /api/session
POST            /api/clerk-session
GET             /api/access/health
GET/POST        /api/workspaces
GET/POST        /api/agent-connections
DELETE          /api/agent-connections/:connectionId
POST            /api/workspace-handoffs
POST            /api/workspace-handoff
GET/POST        /api/projects
GET/PATCH       /api/projects/:projectId
POST            /api/projects/:projectId/cards
PATCH           /api/projects/:projectId/cards/:cardId
POST            /api/projects/:projectId/cards/:cardId/comments
GET             /api/projects/:projectId/activity
```

See [the skill API reference](.agents/skills/kanban-cards/references/api.md) for request details.

AgentConnection credentials are returned only by the create response and stored only as SHA-256 hashes. Each connection belongs to one owner and one Workspace, carries explicit `read` and/or `write` scopes, and records creation, last use, optional expiry, and revocation. Automated requests must target that Workspace's tenant host; caller labels and Workspace selectors never grant authority or control Activity attribution.

One Clerk Dashboard step is required before release: in **User & authentication**, set access to **Open**, enable sign-up and sign-in with email, select **Email verification link** as the only customer-facing email strategy for both flows, and leave **Require the same device and browser** enabled. No live Clerk setting was changed by this repository patch.

## Validation

```bash
npm run typecheck
npm run build
npm run check
npm test
npm run test:browser
npm run check:release-policy
npm run release:preflight
```

`npm run check` verifies compilation, the primary UI contract, and the repository release boundary. `npm run check:release-policy` keeps Git deployments from `main` enabled and preserves the explicit promotion step in the docs. `npm run release:preflight` is the read-only live check for a clean `main`: it finds the exact Git-created staged Production deployment, verifies the linked Project and permanent domains, checks candidate and rollback health, and prints both deployment identities. `npm test` covers authentication, authorization, persistence, the CLI, and both release controllers. `npm run test:browser` exercises the product in Chromium at desktop and narrow-screen sizes. Passing automation proves the implementation contract; the live preflight proves the exact deployment boundary.

## Deployment

The repository deploys to Vercel as an Express function through `api/index.ts`. A merge to `main` creates a staged Production deployment. The Vercel Project keeps **Auto-assign Custom Production Domains** disabled, so the merge builds the artifact without moving traffic.

Ordinary product changes use the short path:

1. Open a pull request and let Preview plus hosted CI finish.
2. Merge the validated change to `main`.
3. Run `npm run release:preflight` from clean local `main` and copy the returned `deploymentId`.
4. After the literal authorization, run `npm run release:promote -- --deployment <deploymentId> --confirmation "PROMOTE EXACT VERIFIED CANDIDATE"`.

The controller accepts only the exact Git-created deployment for the checked-out SHA. It keeps the predecessor receipt locally, promotes once, and verifies the public root, auth, and tenant routes afterward. Authentication, authorization, tenant routing, agent credentials, database migrations, and Vercel protection changes use the sensitive lane in [the runbook](docs/runbook.md).

`npm run db:init` is an optional manual initializer only when a production database URL is already present in the current process. Treat it as successful production proof only when it reports `Initialized V2 postgres workspace at kanban_v2_workspaces:default`; a `file` result initialized local storage instead. Follow [the runbook](docs/runbook.md) for the complete candidate, promotion, rotation, and rollback procedure.

No V1 import, compatibility mode, or dual write is required. Git history preserves the V1 source for historical inspection; it does not retain V1 runtime board data.
