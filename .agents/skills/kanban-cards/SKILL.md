---
name: kanban-cards
description: Use the kanban.cards API to read assigned cards, inspect reviewer instructions, create or move cards, and post progress/comments. Trigger when an agent is asked to update kanban.cards, check board status, report progress to a human reviewer, acknowledge instructions, or coordinate work through the Kanban board.
---

# kanban.cards

## Overview

Use the kanban.cards API as the source of truth. Do not edit local state files or database rows directly.

Default connection:
- `KANBAN_CARDS_API_BASE_URL`, default `http://127.0.0.1:4317/api`
- `KANBAN_CARDS_API_TOKEN`, required for agent writes

Legacy local aliases `INSTRUCT_API_BASE_URL` and `INSTRUCT_API_TOKEN` are accepted temporarily.

For endpoint details, read `references/api.md` when needed.

## Workflow

1. Read board state with `GET /state` or list boards with the helper script.
2. Inspect the active board's `agentSpecs` to find your stable agent `id`, role, lane responsibilities, instructions, and skill notes.
3. Find your cards by matching `ownerAgentId` or `reviewerAgentId` to your agent spec `id`, then by title or board context.
4. Check reviewer instructions with `GET /agent/instructions?agentId=<id>`.
5. Post progress as a `progress` comment before or after substantive work.
6. Acknowledge or resolve human instructions by patching the relevant comment status.
7. Move a card only when the current lane's output is genuinely ready for the next lane.

## Helper Script

Use `scripts/kanban-cards-client.mjs` for common operations:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs boards
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs instructions --agent agent-a
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs create-card --board <board-id> --title "Draft brief" --lane <lane-id> --owner agent-a
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs comment --board <board-id> --item <card-id> --kind progress --text "Draft is ready for review."
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs move-card --board <board-id> --item <card-id> --lane <lane-id>
```

The helper sends `Authorization: Bearer $KANBAN_CARDS_API_TOKEN` for mutating commands.

## Comment Guidance

- Use `progress` for agent status updates.
- Use `instruction` for human direction that should be acknowledged or resolved.
- Use `question` when blocked on a decision.
- Use `change_request` for reviewer-requested changes.
- Use `note` for context that does not require action.

Keep comments concise and operational. Include what changed, what remains open, and which lane or reviewer action is next.
