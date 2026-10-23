# kanban.cards

kanban.cards gives owners and agents a shared board for Projects, Cards, comments, and Activity. Each owner has private Workspaces. Owners sign in with a passkey; agents use API keys scoped to one Workspace.

```text
Owner
└── Workspaces
    └── Projects
        ├── Columns
        ├── Cards and comments
        └── Activity
```

A Project is a board. A Workspace is the tenant boundary. Agent credentials grant `read` or `read` and `write` access to that Workspace; they cannot manage owner credentials or issue other keys.

Open Workspace Activity from the web Workspace menu or the native Projects view to read changes across active and archived Projects. On web, Project Activity is in the Project's Actions menu; Card Activity remains in Card detail. Every level displays the stored name of the owner or agent who made each change. Workspace feeds offer Refresh and Load more, and retain readable entries if an update fails. The [Activity API](.agents/skills/kanban-cards/references/api.md#activity) supports the same scoped history for API clients.

## First local run

Use Node.js 22 and npm. Keep local test data separate from production.

```bash
npm install
export SESSION_SECRET="$(openssl rand -hex 32)"
export KANBAN_CARDS_ROOT_HOST=board.localhost:4317
export KANBAN_CARDS_AUTH_HOST=auth.board.localhost:4317
npm run dev
```

Open `http://board.localhost:4317`, choose Create account, and create a passkey at `http://auth.board.localhost:4317`. Save the recovery code before opening the board. A returning owner chooses Sign in and uses their passkey. No email or password is required.

Local development uses JSON files under `data/`. Production requires Postgres. `.env.example` lists configuration; export the values into the server process or set them in the hosting environment.

## Owner access

Passkey ceremonies run only on the configured auth host. Production uses `https://auth.kanban.cards` and the exact RP ID `auth.kanban.cards`. The auth host denies board-data APIs.

Successful sign-in creates a browser session that lasts 365 days from sign-in in a Secure, HttpOnly, host-only cookie. Server-side session records support revocation. Root and Workspace cookies expire with the original session; activity and identity verification do not extend the lifetime. Short-lived, single-use handoffs open the initiating root and the selected Workspace. Every protected request checks current owner membership.

Access settings let an owner add another passkey, manage API keys, replace the recovery code, and end sessions. Credential changes and API-key creation require passkey verification within five minutes. Store a second passkey or the recovery code somewhere safe.

Use a recovery code once to enroll a replacement passkey. Successful recovery issues a new code and revokes previous passkeys, browser and native sessions, pending handoffs, and agent keys. Reconnect agents afterward. Losing every passkey and the saved code means losing access; email recovery is unavailable.

## Native owner access

The early [native iPhone app](ios/README.md) uses standard Apple components for Projects, Cards, Comments, Activity, filtering, and editing. Existing owners sign in with a passkey. The [setup instructions](ios/README.md) cover simulator use and private device installation; the [verification record](docs/iphone-native-app-verification.md) lists completed checks and remaining acceptance work.

The [native macOS app](macos/README.md) opens a Project board and independent Card windows with standard system controls, native passkey sign-in, and normal owner editing. Its separate bundle, session store, drafts, and Xcode project preserve the iPhone setup.

See the [native authentication contract](docs/native-auth.md) for app association, sign-in requests, session storage, and release verification.

The [shared interaction workflow](docs/shared-interactions/README.md) defines the target feature set, editing and recovery rules, source-based parity matrix, and acceptance scenarios for Mac, iPhone, and web. Its validation command checks the specification; client runtime acceptance remains separate.

## Set up the existing owner

The first passkey must attach to the existing internal owner ID so the owner's Workspace IDs, storage IDs, board data, and agent-key hashes stay intact. Public signup always creates a separate owner and Workspace.

Generate a one-hour setup token through the trusted local operator environment:

```bash
npm run auth:setup -- --owner <existing-owner-id> --out .local/owner-setup.json
```

The command writes the raw token only to a new local file with mode `0600`. Its output contains the file path and these environment values:

```text
KANBAN_CARDS_SETUP_OWNER_ID
KANBAN_CARDS_SETUP_TOKEN_HASH
KANBAN_CARDS_SETUP_EXPIRES_AT
```

Configure those values for the intended server. The owner opens the setup form and pastes the token from the local file. Enrollment consumes setup atomically and disables it permanently. Remove the temporary setup environment values after enrollment. Generate the token when the replacement is ready for use; no coexistence release is required.

## Connect an agent

Create a named API key in the Workspace's access settings. Choose its scopes and optional expiry. Copy the secret once. The server stores only its SHA-256 hash and records creation, last use, and revocation.

Pass the key through standard input, targeting that Workspace's tenant host:

```bash
read -r -s AGENT_KEY
printf '%s\n' "$AGENT_KEY" | \
  node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  setup --url https://<workspace>.kanban.cards/api --token-stdin
unset AGENT_KEY

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  create-project --name "My project"

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  bind --project <project-id>
```

The user configuration at `~/.kanban-cards/config.json` stores the API origin and key with mode `0600`. The repository's `.kanban-cards.json` stores only the Project ID. Caller labels and Workspace selectors cannot change authorization or Activity attribution.

Invoke `$kanban-cards` from a bound repository to create cards, read current status, and comment on or move work as it progresses. Writes use Project revisions or Card versions; create operations support `Idempotency-Key`, and imports can use stable `externalKey` values.

Rotate a key by creating its replacement, updating the client, checking access, and revoking the old key. A revoked or expired key stops working immediately.

## Card handoffs and filters

Cards have four optional fields for coordinating work:

| Field | API value | Browser label |
| --- | --- | --- |
| `nextActor` | `human`, `agent`, or `null` | You, Agent, or Unassigned |
| `nextAction` | Plain text; empty by default | Next action |
| `priority` | `High`, `Medium`, `Low`, or `null` | Priority |
| `blockedReason` | Plain text; empty by default | Blocker |

Set the fields when creating a Card or edit them in Card detail. Existing Cards start unassigned, with no priority, next action, or blocker. A nonempty blocker means the Card is blocked. Column still describes progress; next actor describes who should act next. These fields do not run agents or grant permission to take an action.

The board combines Next actor, Priority, and Blocked filters. For example, choose Agent, High, and Unblocked to find work an agent can pick up next. Counts show matching Cards out of all active Cards. Clear filters restores the full board. Filtering keeps an open Card available while you edit, even if your changes remove it from the matching results.

Agents can use the same fields and filters:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  create-card --title "Draft release notes" --next-actor agent \
  --next-action "Write a draft from the merged changes" --priority High

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  cards --next-actor agent --priority High --blocked false

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs \
  update-card --card <card-id> --version <card-version> \
  --next-actor human --next-action "Review the draft" --blocked-reason ""
```

Use `--next-actor unassigned`, `--priority unset`, or an empty string for either text field to clear a value. The filtered `GET /api/projects/:projectId/cards` endpoint returns active Cards by default and accepts `nextActor`, `priority`, `blocked`, and `includeArchived` query parameters. The Project endpoint continues to return its complete snapshot. See [the API reference](.agents/skills/kanban-cards/references/api.md) for values and response shapes.

## Runtime and storage

| Source | Responsibility |
| --- | --- |
| `src/server.ts` | Host routing, browser sessions, owner and resource APIs |
| `src/passkey-auth.ts` | Passkey ceremonies, self-service signup, recovery, rate limits |
| `src/app-sessions.ts` | Signed, origin-bound browser cookies and CSRF protection |
| `src/access-store.ts` | Owners, Workspaces, passkeys, sessions, recovery hashes, scoped agent keys |
| `src/state-store.ts` | Workspace JSON and Postgres persistence |
| `src/client/app.ts` | Authentication, access settings, Project list, board, Card editing |
| `src/cli/kanban-cards-client.ts` | Agent helper source |

Production uses `kanban_v2_workspaces` for board state and `kanban_v3_access_registry` for access records. Authentication updates use the existing access-registry transaction, including owner and Workspace creation. The existing `default` storage row stays in place.

Production requires `KANBAN_CARDS_DATABASE_URL`, `SESSION_SECRET` with at least 32 bytes, `KANBAN_CARDS_ROOT_HOST=kanban.cards`, and `KANBAN_CARDS_AUTH_HOST=auth.kanban.cards`. `POSTGRES_URL` or `DATABASE_URL` can supply the database URL. Production does not accept the local owner-key fallback or the retired global API token.

The CLI builds to the tracked `.agents/skills/kanban-cards/scripts/kanban-cards-client.mjs`. After changing its TypeScript source, run `npm run build:cli` and include the regenerated helper.

## API

```text
GET/DELETE      /api/session
POST            /api/auth-start
POST            /api/auth-handoff
GET             /api/access-settings
DELETE          /api/passkeys/:id
POST            /api/recovery-code
DELETE          /api/sessions/:id
GET/POST        /api/workspaces
GET/POST        /api/agent-connections
DELETE          /api/agent-connections/:connectionId
POST            /api/workspace-handoffs
POST            /api/workspace-handoff
GET/POST        /api/projects
GET/PATCH       /api/projects/:projectId
GET/POST        /api/projects/:projectId/cards
PATCH           /api/projects/:projectId/cards/:cardId
POST            /api/projects/:projectId/cards/:cardId/comments
GET             /api/projects/:projectId/activity
```

See [the skill API reference](.agents/skills/kanban-cards/references/api.md) for resource requests. Passkey endpoints on the auth host are browser ceremony endpoints; agents authenticate with their scoped bearer key.

## Validation and release

```bash
npm run check
npm test
npm run test:browser
```

`check` verifies types, builds, the UI contract, and release policy. Tests cover authentication, tenant isolation, persistence, scoped API keys, the CLI, and promotion checks. Browser automation uses isolated passkeys and data. Verify a real device before claiming real-device passkey support.

Vercel builds a staged Production deployment when a validated change merges to `main`. **Auto-assign Custom Production Domains** stays disabled, so merge and traffic promotion remain separate.

1. Merge the reviewed change after required checks pass.
2. From clean local `main`, run `npm run release:preflight` and inspect the exact deployment ID and SHA.
3. After explicit production authorization, run `npm run release:promote -- --deployment <deploymentId> --confirmation "PROMOTE EXACT VERIFIED CANDIDATE"`.
4. Verify the public root, auth host, Workspace, passkey sign-in, and scoped agent access.

The controller verifies the exact Git-created artifact, passkey health, database readiness, permanent domains, deployment protection, and public routes. See [the runbook](docs/runbook.md) for the operator steps. The replacement uses one release and preserves existing owner and board records.

## Design authority

1. [Product vision](docs/product-vision.md) defines the product and trust boundary.
2. [DESIGN.md](DESIGN.md) governs the experience.
3. [UI_CONTRACT.md](UI_CONTRACT.md) records browser constraints.
4. [Design research](docs/design-language.md) preserves historical research.

The [shared editing slice](docs/shared-interactions/slice-1.md) implements explicit Save, durable drafts and field reconciliation across macOS, iOS and web.
