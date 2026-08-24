---
name: kanban-cards
description: Keep project work visible and up to date in kanban.cards so you can see priorities, progress, and what needs attention next. Use for project setup, plan-to-card conversion, board reconciliation, progress updates, card movement or archival, and activity review.
---

# kanban.cards

Use the API as the source of truth. The normal credential is a neutral AgentConnection bound server-side to exactly one owner and one Workspace with explicit `read` and/or `write` scopes. It cannot select a Workspace from a Project binding, payload, query, header, or caller label. The legacy compatibility bearer may still work for its documented migration bridge, but it is not an AgentConnection and must not be described as an agent identity.

Resolve the absolute directory containing this `SKILL.md` from the active skill catalog. Run its bundled helper from the target repository root, replacing `{skill_dir}` with that directory:

```bash
node "{skill_dir}/scripts/kanban-cards-client.mjs" <command>
```

Do not assume the target repository contains its own `.agents/skills/kanban-cards` copy.

The executable helper is versioned with the skill and must work from a clean checkout without a local build. If it is missing, stop and report an incomplete skill installation; do not edit database rows or local application state as a substitute.

Read [references/api.md](references/api.md) when exact payloads, headers, or response shapes matter.

## Connect

Create the AgentConnection from the owner UI on the intended Workspace tenant host. Copy its one-time credential and store it only in `~/.kanban-cards/config.json`. Pipe it through standard input so it does not appear in the command line, shell history, or repository. Use that Workspace's tenant API URL, not the application root:

```bash
node "{skill_dir}/scripts/kanban-cards-client.mjs" setup \
  --url https://my-workspace.kanban.cards/api \
  --token-stdin
```

Never place a token or API URL in the repository. Bind the repository with a `.kanban-cards.json` containing only `projectId`:

```bash
node "{skill_dir}/scripts/kanban-cards-client.mjs" projects
node "{skill_dir}/scripts/kanban-cards-client.mjs" bind --project <project-id>
node "{skill_dir}/scripts/kanban-cards-client.mjs" project
```

`setup` verifies that the credential resolves to a Workspace context before saving it. `bind` verifies that the Project exists in that same Workspace before writing the repository file. AgentConnection Activity attribution contains the verified connection's stable ID and stored label; `X-Kanban-Actor` is ignored for AgentConnection authority and attribution. The legacy compatibility bearer does not receive an AgentConnection ID.

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
node "{skill_dir}/scripts/kanban-cards-client.mjs" create-project \
  --name "Product improvements" \
  --columns "Inbox,Next,Doing,Done" \
  --idempotency-key "product-improvements-v1"

node "{skill_dir}/scripts/kanban-cards-client.mjs" create-card \
  --title "Simplify authentication" \
  --body "Connect the bounded Workspace agent." \
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
node "{skill_dir}/scripts/kanban-cards-client.mjs" comment \
  --card <card-id> \
  --text "Implemented and verified the tenant-bound AgentConnection setup path."

node "{skill_dir}/scripts/kanban-cards-client.mjs" move-card \
  --card <card-id> \
  --column done \
  --version <card-version>

node "{skill_dir}/scripts/kanban-cards-client.mjs" activity --limit 25
```

Use `archive-card` instead of deletion. Do not modify or archive cards outside the user's requested scope.
