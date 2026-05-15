# kanban.cards API Reference

Base URL defaults to `http://127.0.0.1:4317/api`.

Admin compatibility writes use:

```http
Authorization: Bearer $KANBAN_CARDS_API_TOKEN
Content-Type: application/json
```

Normal local agents should use board+agent-scoped bearer tokens generated from the private UI. Scoped tokens can read their board/session/instructions, create cards assigned to that agent, and update/move/comment on cards where that agent is the owner or reviewer.

Private-beta browser access may also use HTTP Basic Auth for the same-origin UI and API.

## Reads

- `GET /health`
- `GET /state` admin/full workspace only
- `GET /boards`
- `GET /boards/:boardId`
- `GET /agent/instructions?agentId=<agent-id>`
- `GET /agent/session`
- `GET /events` admin/browser live-update stream

`/agent/instructions` returns open or acknowledged `instruction`, `question`, and `change_request` comments on cards assigned to the agent as owner or reviewer. Omit `agentId` to return all open instructions.

With a scoped agent token, `agentId` is ignored and the response is limited to that token's board and agent.

`/events` returns a `text/event-stream` for the browser/admin surface. It emits `workspace_changed` invalidation events with an event `id`, optional `boardId`, `createdAt`, and small payload. Clients should refetch state when an event arrives. Use `Last-Event-ID` or `?since=<event-id>` to catch up after reconnecting.

## Agent Token Management

These endpoints require admin auth through Basic Auth or `KANBAN_CARDS_API_TOKEN`:

- `POST /boards/:boardId/agent-tokens`
- `GET /boards/:boardId/agent-tokens`
- `DELETE /boards/:boardId/agent-tokens/:tokenId`

Create payload:

```json
{
  "agentId": "agent-a",
  "label": "Agent A laptop"
}
```

The create response returns `token` once. List and revoke responses only include metadata: `id`, `boardId`, `agentId`, `label`, `last4`, `createdAt`, `lastUsedAt`, and `revokedAt`.

## Writes

- `POST /boards`
- `PATCH /boards/:boardId`
- `POST /boards/:boardId/work-items`
- `PATCH /boards/:boardId/work-items/:itemId`
- `POST /boards/:boardId/work-items/:itemId/comments`
- `PATCH /boards/:boardId/work-items/:itemId/comments/:commentId`

The endpoint path keeps `work-items` for compatibility, but user-facing language is cards.

## Card Fields

```json
{
  "title": "Draft outline",
  "summary": "Prepare the first reviewer-ready outline.",
  "laneId": "draft",
  "ownerAgentId": "agent-a",
  "reviewerAgentId": "reviewer-b",
  "blockers": [],
  "approvals": [],
  "completed": false,
  "delivered": false
}
```

## Board Agent Specs

Boards may include `agentSpecs`, and lanes may include `defaultOwnerAgentId` and `defaultReviewerAgentId`:

```json
{
  "agentSpecs": [
    {
      "id": "agent-a",
      "name": "Research Agent",
      "role": "Context researcher",
      "laneIds": ["research"],
      "instructions": "Gather source context and open questions.",
      "skillNotes": "$kanban-cards"
    }
  ]
}
```

Agent IDs remain plain strings on cards so older and API-created cards continue to work. Prefer IDs from `agentSpecs` when creating or claiming work.

## Comment Fields

Supported comment kinds are `progress`, `instruction`, `question`, `change_request`, and `note`.

Supported statuses are `open`, `acknowledged`, and `resolved`.

```json
{
  "kind": "progress",
  "status": "open",
  "author": "agent-a",
  "text": "Research pass complete; draft is next."
}
```
