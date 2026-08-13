# kanban.cards API

The base URL defaults to `http://127.0.0.1:4317/api`. The compatibility token authorizes the skill to use one server-bound Workspace. It never accepts a client-supplied Workspace selector. The browser uses provider-verified root and tenant sessions in production.

## Headers

Every helper request sends:

```http
Authorization: Bearer <owner-token>
X-Kanban-Actor: <actor-label>
```

Resource POSTs also send `Idempotency-Key`. `create-card` derives a stable key from `projectId` plus `externalKey` unless the caller supplies `--idempotency-key`. Other resource POSTs generate a unique key unless one is supplied.

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
  "apiBaseUrl": "https://kanban.cards/api",
  "token": "secret-owner-token",
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

Return the authenticated local, root, or Workspace session. Provider-mode responses include exact `rootUrl`, `loginUrl`, and `logoutUrl` values for the request's configured host family; Workspace responses also include the exact routed Workspace URL. The browser accepts navigation only when those origins and paths agree. The helper expects a Workspace context; it cannot use root Workspace-enumeration routes.

### Root Workspace routing

`GET /workspaces` returns only owned Workspaces that have a route in the current host family. `POST /workspaces` creates a routed Workspace. `POST /workspace-handoffs` returns an exact tenant `destination` and a single-use body-only `handoffToken`; `POST /workspace-handoff` consumes it only on that destination host and from the matching root origin. Candidate and canonical host-family sessions and handoffs cannot be replayed across origins.

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

### `POST /projects/:projectId/cards`

```json
{
  "title": "Simplify authentication",
  "body": "Replace delegated sessions with one owner credential.",
  "columnId": "next",
  "position": 0,
  "externalKey": "recommendation:simplify-auth"
}
```

Only `title` is required. Return `201 { "card": Card, "projectRevision": 2 }`. Reusing an existing `externalKey` in the project returns that card with `200` and `"deduplicated": true`.

### `PATCH /projects/:projectId/cards/:cardId`

Accept any of `title`, `body`, `columnId`, `position`, or `archivedAt`. Moving a card is a patch with `columnId` and optional `position`. Archiving is a patch with an ISO timestamp in `archivedAt`. Return `{ "card": Card, "projectRevision": number }`.

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

Return `{ "activity": Activity[], "projectRevision": number }`. Activity actors come from the server-validated `X-Kanban-Actor` label and channel metadata.

## Helper command mapping

| Command | Request |
| --- | --- |
| `session` | `GET /session` |
| `projects` | `GET /projects` |
| `create-project` | `POST /projects` |
| `project` | `GET /projects/:projectId` |
| `update-project` | `PATCH /projects/:projectId` |
| `cards` | Read cards from `GET /projects/:projectId` |
| `create-card` | `POST /projects/:projectId/cards` |
| `update-card`, `move-card`, `archive-card` | `PATCH /projects/:projectId/cards/:cardId` |
| `comment` | `POST /projects/:projectId/cards/:cardId/comments` |
| `activity` | `GET /projects/:projectId/activity` |
