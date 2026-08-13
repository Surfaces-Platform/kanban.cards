---
name: kanban-cards
description: Operate kanban.cards projects through its owner API and bundled CLI. Use when Codex needs to create or bind a project to a repository, turn recommendations or plans into idempotent cards, inspect or reconcile project status, update or move cards after work, comment on progress, archive cards, or review project activity.
---

# kanban.cards

Use the API as the source of truth. This slice's credential is a compatibility path acting for the owner and bound server-side to exactly one Workspace. It cannot select a Workspace from a Project binding, payload, query, or header. Do not create agent identities, roles, sessions, reviewers, or approval workflows; verified agent identity is the next roadmap slice.

Run the bundled helper from the repository root:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs <command>
```

The executable helper is versioned with the skill and must work from a clean checkout without a local build. If it is missing, stop and report an incomplete skill installation; do not edit database rows or local application state as a substitute.

Read [references/api.md](references/api.md) when exact payloads, headers, or response shapes matter.

## Connect

Store the Workspace-bound compatibility token only in `~/.kanban-cards/config.json`. Pipe it through standard input so it does not appear in the command line:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs setup \
  --url https://kanban.cards/api \
  --actor codex \
  --token-stdin
```

Never place a token or API URL in the repository. Bind the repository with a `.kanban-cards.json` containing only `projectId`:

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs projects
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs bind --project <project-id>
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs project
```

`bind` verifies that the Project exists through the configured API before writing the repository file.

Pass `--project <project-id>` to override the repository binding for one command.

## Turn a plan into cards

1. Read `session`, then list `projects` and inspect the selected `project`.
2. Create and bind a project only when no suitable project exists.
3. Map durable workflow stages to columns. Prefer a small flow such as `Inbox,Next,Doing,Done`.
4. Give every plan item a stable `externalKey` derived from its source identifier or a durable slug.
5. Read `cards` before writing. Create missing cards, update changed cards, and leave unrelated cards alone.
6. Pass a stable `--idempotency-key` when creating a project or retrying any POST after an uncertain response.
7. Read the project again and report what was created, updated, unchanged, or unresolved.

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs create-project \
  --name "Product improvements" \
  --columns "Inbox,Next,Doing,Done" \
  --idempotency-key "product-improvements-v1"

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs create-card \
  --title "Simplify authentication" \
  --body "Replace delegated sessions with one owner credential." \
  --external-key "recommendation:simplify-auth"
```

When `--column` is omitted, the server places the card in the first column. Read the project and use its returned column IDs for later moves. To choose stable IDs at project creation, pass JSON to `--columns`, for example `[{"id":"next","name":"Next"}]`.

## Execute and reconcile

Before work, read `project` or `cards` and note the card version. After substantive work:

1. Update the card body when its scope or outcome changed.
2. Add a concise comment stating what changed and what remains.
3. Move the card only when the destination column truthfully describes its state.
4. Pass `--version` on every project or card patch; the helper requires it. A comment returns the compact reference `card: { id, version }`; use that version or re-read before a later update, move, or archive.
5. Re-read the project to verify the mutation. If the server reports a version conflict, inspect current state and reconcile instead of overwriting it.

```bash
node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs comment \
  --card <card-id> \
  --text "Implemented and verified the owner-token setup path."

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs move-card \
  --card <card-id> \
  --column done \
  --version <card-version>

node .agents/skills/kanban-cards/scripts/kanban-cards-client.mjs activity --limit 25
```

Use `archive-card` instead of deletion. Do not modify or archive cards outside the user's requested scope.
