# kanban.cards API

In production, configure the exact tenant URL such as `https://my-workspace.kanban.cards/api` and use a scoped API key bound to that Workspace. Owners sign in with passkeys and create keys in access settings after fresh passkey verification. The key's secret appears once. A client-supplied Workspace selector cannot change its authority. Production rejects the retired global bearer token.

## Headers

Every helper request sends:

```http
Authorization: Bearer <agent-connection-credential>
```

Activity attribution uses the verified AgentConnection's stable ID and stored label. `X-Kanban-Actor` cannot override either field. Resource POSTs also send `Idempotency-Key`. `create-card` derives a stable key from `projectId` plus `externalKey` unless the caller supplies `--idempotency-key`. Other resource POSTs generate a unique key unless one is supplied.

Each owner may have up to 50 unrevoked API keys per Workspace. Revoke an existing key to free a slot. Expired or revoked credentials cannot access the API.

Each owner may create up to 100 API keys per hour across all Workspaces. Revoking a key does not reset that limit. Further creation requests receive `429` with the retry time; unsuccessful requests do not consume the allowance.

Project and card patches accept:

```http
X-Kanban-Version: <revision-or-version>
```

Use the `revision` or `version` from the last read. The API accepts raw or quoted numeric values and returns `409` when current state no longer matches.

The API rejects `If-Match` on writes. Standard HTTP precondition handling can replace a successful mutation response with `412` after the application has committed the write, so every caller must use `X-Kanban-Version`.

## Local configuration

`~/.kanban-cards/config.json` is mode `0600` and contains only:

```json
{
  "apiBaseUrl": "https://my-workspace.kanban.cards/api",
  "token": "one-time-agent-connection-credential",
  "actor": "codex"
}
```

The repository-level `.kanban-cards.json` contains only:

```json
{
  "projectId": "project-id"
}
```

The helper refuses repository configuration containing a token, API URL, or any field besides `projectId`.

Use `https://` for every non-loopback API URL. The helper permits plaintext `http://` only for local loopback development.

## Session and projects

### `GET /session`

Return the authenticated owner browser session or scoped agent context. Browser responses include exact navigation origins; Workspace responses include the routed Workspace URL. The helper requires a Workspace context and cannot enumerate owner Workspaces or manage credentials.

### Root Workspace routing

Owner browser sessions use `GET /workspaces` to list owned Workspaces and `POST /workspaces` to create one. Each owner may have up to 10 Workspaces. `POST /workspace-handoffs` returns an exact tenant `destination` and a single-use body-only `handoffToken`; `POST /workspace-handoff` accepts it only on that destination host with the matching browser nonce and root origin. Agents cannot issue these handoffs or create Workspaces.

### `GET /projects`

Return `{ "projects": ProjectSummary[] }`. A summary contains `id`, `name`, `description`, `revision`, timestamps, archive state, and `cardCount`; read `GET /projects/:projectId` for columns and cards. The browser may request archived projects with `?includeArchived=true`; the helper lists active projects.

### `POST /projects`

```json
{
  "name": "Product improvements",
  "description": "Optional description",
  "columns": [
    { "id": "inbox", "name": "Inbox", "position": 0 },
    { "id": "doing", "name": "Doing", "position": 1 },
    { "id": "done", "name": "Done", "position": 2 }
  ]
}
```

Columns are optional; the server supplies its defaults when omitted. The response is `201 { "project": Project }`. An idempotent replay returns the original status and body.

### `GET /projects/:projectId`

Return `{ "project": Project }` and an `ETag` containing the project revision. A project includes its columns, cards, comments, and revision.

### `PATCH /projects/:projectId`

Accept any of `name`, `description`, `columns`, or `archivedAt`. `X-Kanban-Version` with the current project revision is required; omission returns `428`. Return `{ "project": Project }`.

Replacing `columns` requires the complete desired column list. Preserve IDs for existing columns so cards retain their placement.

## Cards

Every Card includes these structured work fields:

| Field | Stored value | Default |
| --- | --- | --- |
| `nextActor` | `"human"`, `"agent"`, or `null` | `null` (unassigned) |
| `nextAction` | Plain text | `""` |
| `priority` | `"High"`, `"Medium"`, `"Low"`, or `null` | `null` (unset) |
| `blockedReason` | Plain text describing what prevents progress | `""` (unblocked) |

The browser labels `"human"` as You. These fields describe the next handoff; they do not identify a credential holder, grant authority, or trigger agent execution. Column remains the workflow stage. Existing cards receive the same defaults without inferring values from their descriptions.

### `GET /projects/:projectId/cards`

Return `{ "cards": Card[], "projectRevision": number }`. Active cards are returned by default. Optional query parameters:

| Parameter | Accepted values |
| --- | --- |
| `nextActor` | `human`, `agent`, `unassigned` |
| `priority` | `High`, `Medium`, `Low`, `unset` |
| `blocked` | `true`, `false` |
| `includeArchived` | `true`, `false` |

All supplied filters must match. `unassigned` matches `nextActor: null`; `unset` matches `priority: null`. `blocked=true` matches a nonempty blocker; `blocked=false` matches an empty blocker. Omitted filters include every value for that field. Supply each parameter once. Unknown names, repeated parameters, and invalid values return `400`.

For example, `GET /projects/:projectId/cards?nextActor=agent&priority=High&blocked=false` returns active High-priority cards ready for agent work.

### `POST /projects/:projectId/cards`

```json
{
  "title": "Simplify authentication",
  "body": "Use passkeys for owners and scoped API keys for agents.",
  "columnId": "next",
  "position": 0,
  "nextActor": "agent",
  "nextAction": "Implement the scoped API key setup path",
  "priority": "High",
  "blockedReason": "",
  "externalKey": "recommendation:simplify-auth"
}
```

Only `title` is required. Return `201 { "card": Card, "projectRevision": 2 }`. Reusing an existing `externalKey` in the project returns that card with `200` and `"deduplicated": true`.

Use `null` to clear `nextActor` or `priority`. `nextAction` and `blockedReason` accept text, `""`, or `null`. Text is trimmed; empty strings, whitespace-only text, and `null` clear the field to `""`. Invalid enum values or non-text actions and blockers return `400`.

### `PATCH /projects/:projectId/cards/:cardId`

Accept any of `title`, `body`, `columnId`, `position`, `archivedAt`, `nextActor`, `nextAction`, `priority`, or `blockedReason`. Omitted fields remain unchanged. Enum and clearing rules match card creation. Moving a card is a patch with `columnId` and optional `position`. Archiving is a patch with an ISO timestamp in `archivedAt`. Return `{ "card": Card, "projectRevision": number }`.

Supply the card's current `version` through required `X-Kanban-Version`; omission returns `428`. Adding a comment increments the Card version returned in the comment response's compact `card` reference.

### `POST /projects/:projectId/cards/:cardId/comments`

```json
{
  "body": "Implemented and verified the setup path."
}
```

Return `201 { "comment": Comment, "card": { "id": string, "version": number }, "projectRevision": number }`.

## Activity

### `GET /projects/:projectId/activity?limit=25`

Return `{ "activity": Activity[], "projectRevision": number }`. Agent calls record `{ channel: "api", label, agentConnectionId }` from the verified durable connection; request labels cannot override the stored fields. Historical Activity rows may omit `agentConnectionId`.

## Helper command mapping

| Command | Request |
| --- | --- |
| `session` | `GET /session` |
| `projects` | `GET /projects` |
| `create-project` | `POST /projects` |
| `project` | `GET /projects/:projectId` |
| `update-project` | `PATCH /projects/:projectId` |
| `cards` | `GET /projects/:projectId/cards` with optional `--next-actor`, `--priority`, `--blocked`, and `--include-archived` filters |
| `create-card` | `POST /projects/:projectId/cards` |
| `update-card`, `move-card`, `archive-card` | `PATCH /projects/:projectId/cards/:cardId` |
| `comment` | `POST /projects/:projectId/cards/:cardId/comments` |
| `activity` | `GET /projects/:projectId/activity` |

`create-card` and `update-card` accept `--next-actor human|agent|unassigned`, `--next-action <text>`, `--priority High|Medium|Low|unset`, and `--blocked-reason <text>`. The helper maps `unassigned` and `unset` to API `null`. Pass `""` for an action or blocker to clear it. `update-card` still requires `--version` for metadata-only changes.
