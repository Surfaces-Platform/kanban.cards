---
name: kanban-cards
description: Use the kanban.cards API to read assigned cards, inspect reviewer instructions, create or move cards, and post progress/comments. Trigger when an agent is asked to update kanban.cards, check board status, report progress to a human reviewer, acknowledge instructions, or coordinate work through the Kanban board.
---

# kanban.cards

## Overview

Use the kanban.cards API as the source of truth. Do not edit local state files or database rows directly.

Default connection:
- `KANBAN_CARDS_API_BASE_URL`, default `http://127.0.0.1:4317/api`
- `KANBAN_CARDS_API_TOKEN`, optional bearer token override for agent writes
- `KANBAN_CARDS_BOARD_ID` and `KANBAN_CARDS_AGENT_ID`, optional board and agent defaults

The preferred setup path is a scoped token created from the kanban.cards UI:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs setup --url https://kanban.cards/api --token <token> --board <board-id> --agent <agent-id>
```

The helper reads env vars first, then `~/.kanban-cards/config.json`. Legacy local aliases `INSTRUCT_API_BASE_URL` and `INSTRUCT_API_TOKEN` are accepted temporarily.

For endpoint details, read `references/api.md` when needed.

## Workflow

1. Read your session with `GET /agent/session` or list your scoped board with the helper script.
2. Inspect the active board's `agentSpecs` to find your stable agent `id`, role, lane responsibilities, instructions, and skill notes.
3. Find your cards by matching `ownerAgentId` or `reviewerAgentId` to your agent spec `id`, then by title or board context.
4. Check reviewer instructions with `GET /agent/instructions`; scoped tokens are automatically limited to their own agent and board.
5. Post progress as a `progress` comment before or after substantive work.
6. Acknowledge or resolve human instructions by patching the relevant comment status.
7. Move a card only when the current lane's output is genuinely ready for the next lane.

## Helper Script

Use `scripts/kanban-cards-client.mjs` for common operations:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs boards
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs session
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs instructions
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs create-card --title "Draft brief" --lane <lane-id>
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs comment --item <card-id> --kind progress --text "Draft is ready for review."
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs move-card --item <card-id> --lane <lane-id>
```

The helper sends `Authorization: Bearer <token>` when a token is configured.

## Comment Guidance

- Use `progress` for agent status updates.
- Use `instruction` for human direction that should be acknowledged or resolved.
- Use `question` when blocked on a decision.
- Use `change_request` for reviewer-requested changes.
- Use `note` for context that does not require action.

Keep comments concise and operational. Include what changed, what remains open, and which lane or reviewer action is next.
