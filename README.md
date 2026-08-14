# kanban.cards

kanban.cards is a small, skill-first Kanban system. Owners use Clerk-verified, tenant-aware browser sessions. During the migration slice, the skill uses a compatibility credential bound server-side to one Workspace and acts with the owner's authority. The website is the visual oversight surface; it is not a second workflow engine.

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

A Project is the board. Workspaces are the tenant boundary. There are no teams, board sub-resources, modeled agent identities, delegated sessions, roles, invitations, reviewers, approval gates, workflow generators, or legacy-board migration.

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

Open `http://127.0.0.1:4317` and enter the same owner key. This form is the deliberate local fallback when Clerk is absent. Production requires Clerk sign-up or sign-in; Project data requires either the tenant session or the Workspace-bound compatibility bearer.

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

Production requires the database URL, Vercel Marketplace's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ENCRYPTION_KEY`, `SESSION_SECRET`, `KANBAN_CARDS_ROOT_HOST=kanban.cards`, `KANBAN_CARDS_AUTH_HOST=auth.kanban.cards`, and an exact comma-separated `KANBAN_CARDS_ALLOWED_CLERK_USER_IDS` admission list. `CLERK_PUBLISHABLE_KEY` remains accepted as a compatibility alias, but both names must match if both are set. A Vercel production runtime requires Marketplace production-instance keys beginning with `pk_live_` and `sk_live_`; development keys fail configuration before readiness. The server derives `https://auth.kanban.cards/sign-in` and `/sign-up` from that one exact auth host; operators do not configure independent auth-flow URLs. The encryption and app-session secrets must each be at least 32 bytes. Clerk supplies the verified user ID, primary verified email, display name, and session ID; the server must never admit or bind an owner by email. The optional legacy cutover requires `KANBAN_CARDS_LEGACY_CLERK_USER_ID` plus the Workspace slug/name, and that user ID must also appear in the admission list. While the skill bridge remains enabled, configure `KANBAN_CARDS_API_TOKEN` and `KANBAN_CARDS_API_WORKSPACE_ID=default`; remove the token after Clerk access passes the retirement proof.

`auth.kanban.cards` is the stable auth-only UI host. The same artifact redirects its root entry to `/sign-in` and serves Clerk UI only at `/sign-in` and `/sign-up`, but it never serves Workspace, Project, handoff, or app-session exchange APIs. Clerk uses one normal production Frontend API (FAPI) DNS/custom-domain setup for the `kanban.cards` root domain; there is no app-owned `/__clerk` proxy on any application origin. ClerkJS runs against the validated `clerkFrontendApiOrigin` on the auth host, `kanban.cards`, and the bounded `candidate.release.kanban.cards` release root. During protected candidate proof, enable Clerk Allowed Subdomains and enter exactly `auth.kanban.cards` and `candidate.release.kanban.cards`; the primary root `kanban.cards` is inherently allowed. After the candidate aliases are removed, remove `candidate.release.kanban.cards` from Clerk before public post-promotion proof, leaving only `auth.kanban.cards` explicitly allowed. Neither application root is a Clerk satellite, and tenant hosts such as `mike.kanban.cards` and `mike.candidate.release.kanban.cards` are excluded from Clerk configuration. Each application root links to the exact auth host, supplies its own exact return origin, recognizes its Clerk browser session after return, and exchanges that verified session for a kanban.cards root session. Request-scoped Clerk `authorizedParties` remain exact per auth or application origin. Tenant hosts accept only separate origin-bound kanban.cards app sessions, and app sessions and handoffs cannot cross candidate and canonical host families. This one-root-domain topology uses no Clerk satellite or multi-domain feature; Clerk Hobby's production FAPI custom domain and email-code authentication are sufficient.

Global sign-out revokes the kanban.cards session family and exact Clerk session before the browser cleanup step. The server returns a short-lived signed continuation only in the immediately removed hidden-form POST body; the family root validates its exact initiating origin and stores the exact Clerk session ID in a signed, short-lived, host-only completion marker. ClerkJS then inspects its documented signed-in session list: if that exact session remains, the client ends only that `Session`; if backend revocation already removed it, no other browser account is touched. Only after the target is confirmed absent does the client acknowledge cleanup, consume the marker, and display the persistent `Signed out` state. A failed check or cleanup keeps the marker available for retry without repeating server revocation.

The access migration leaves the existing `kanban_v2_workspaces:default` JSON unchanged and adds an access-registry mapping around it. See [`docs/workspace-access-migration.md`](docs/workspace-access-migration.md) for the exact cutover and rollback proof.

## API

The browser and helper use the same endpoints:

```text
GET/POST/DELETE /api/session
POST            /api/clerk-session
GET             /api/access/health
GET/POST        /api/workspaces
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

`npm run check` verifies compilation, the primary UI contract, and the repository release boundary. `npm run check:release-policy` specifically proves that a merge to `main` cannot trigger a Vercel deployment and that the runbook preserves staged production deployment plus explicit promotion. `npm run release:preflight` additionally checks the linked live Vercel Project, production branch, remote domain auto-assignment, Standard Protection, enabled Firewall, empty draft, and either an absent or exact published candidate WAF pair without changing them. `npm test` verifies authentication, authorization, idempotency, optimistic version conflicts, file persistence, the Postgres adapter through an isolated fake, CLI configuration, and the cutover gate's failure matrix. `npm run test:browser` builds the production client and exercises the Context Dock against a temporary real server and store in Chromium at desktop and narrow-screen sizes; install its browser once with `npx playwright install chromium` if needed. A passing automated suite means the implementation contract holds; it does not prove connectivity to the production database or replace exact candidate-deployment verification before promotion.

## Deployment

The repository deploys to Vercel as an Express function through `api/index.ts`. Automatic Vercel deployments from `main` are disabled in `vercel.json`, so a merge and a production traffic change are distinct events. The Vercel Project must also keep **Auto-assign Custom Production Domains** disabled as a remotely verified defense in depth.

1. Configure Clerk, the exact admitted Clerk user IDs, the explicit legacy Workspace mapping, Postgres, and—only while required—the Workspace-bound compatibility key.
2. Deploy the exact validated commit to a protected production-target candidate without moving the public domain.
3. Keep Standard Protection enabled and publish the exact top-two WAF pair from the runbook: Mike's reviewed `/32` or `/128` bypass on only the auth/candidate-root/candidate-tenant hosts, immediately followed by a no-duration deny on only those hosts. Verify admitted reachability, fresh external denials correlated to the live deny rule and config hash, canonical exclusion, the unified Clerk email-code sign-up/sign-in flow, server-side Clerk session exchange, exact user-ID admission and legacy binding, exact-session Clerk sign-out with retry and completion acknowledgement, and the handoff to `mike.candidate.release.kanban.cards` on routes pinned to the exact deployment. Keep `mike.kanban.cards` unrouted until explicit promotion. The generated deployment hostname does not satisfy Clerk or bearer routing; if no separate exact candidate routes exist, stop. Legacy cutover refuses a missing or invalid `kanban_v2_workspaces:default` row before it writes the access mapping; it does not initialize replacement legacy data.
4. Confirm `/api/health` and `/api/access/health` are ready after the verified Clerk session has created the exact binding. While the bridge is enabled, also complete the bounded read, Card create, comment, move, and archive proof before promotion.
5. Record distinct, artifact-bound pre/post receipts without credentials. Promote through `npm run release:gate -- --snapshot <evidence.json> --live --authorize-promotion --confirmation "PROMOTE EXACT VERIFIED CANDIDATE" --promote`; the controller live-verifies and supplies the evaluated deployment ID itself. Repeat the complete gate with `--phase post-promotion --live`.

`npm run db:init` is an optional manual initializer only when a production database URL is already present in the current process. Treat it as successful production proof only when it reports `Initialized V2 postgres workspace at kanban_v2_workspaces:default`; a `file` result initialized local storage instead. Follow [the runbook](docs/runbook.md) for the complete candidate, promotion, rotation, and rollback procedure.

No V1 import, compatibility mode, or dual write is required. Git history preserves the V1 source for historical inspection; it does not retain V1 runtime board data.
