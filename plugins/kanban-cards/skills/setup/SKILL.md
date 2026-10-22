---
name: setup
description: Connect the installed Kanban.cards plugin to the owner's selected Workspace and Project through native app approval, without requesting an API key.
---

# Set up Kanban.cards

Use the Workspace URL and Project ID supplied by the owner's Kanban.cards **Set up Codex** screen. If either is missing, ask for that public identifier. Never ask for an API key, device token, private configuration file, or password.

Resolve this installed setup skill's directory from the active catalog. The helper is packaged in its sibling skill at `../kanban-cards/scripts/kanban-cards-client.mjs`. Run it from the target repository root:

```bash
node "{setup_skill_dir}/../kanban-cards/scripts/kanban-cards-client.mjs" connect \
  --url <workspace-url> \
  --project-id <project-id> \
  --label Codex
```

Keep the command alive while showing the owner its human approval code. The owner opens the Project in Kanban.cards, chooses **Set up Codex**, then **Review approval code**, and approves **Agent access**. Poll the running command through the host's normal async command mechanism so the owner can see the code and approve. Do not start another connection attempt while one is waiting.

If the command was interrupted, repeat the exact command to reuse the unexpired approval request. If the owner denies access or the code expires, report the result; request a new code only when the owner wants to retry. The helper stores secrets outside the repository in private files and verifies the exact Workspace and Project before binding them. Never display the private files.

After successful connection, use the sibling `kanban-cards` skill to read the selected Project's saved Idea and Cards. Then carry out the owner's bounded request under the current task's permissions, updating the existing Cards and checking the actual result. Connection alone does not start or complete the Project.

The bundled helper requires a Codex execution host with Node.js 22 or newer, a target Git repository, network access to Kanban.cards, and private user storage outside the repository. If this host cannot run the helper, report that limitation. Installing the package does not establish phone-only cloud execution or supply a remote MCP service.

For an isolated connection, set `KANBAN_CARDS_CONFIG_DIR` to an absolute private directory outside the target repository. Use the same value for setup and every later helper command. Both credentials and pending approval stay there; the ordinary `~/.kanban-cards` connection is neither read nor changed. The directory uses mode 0700 and private files use mode 0600. Relative paths, symlinked credential directories, and paths resolving inside the repository are rejected. Keep the account home variables unchanged.
