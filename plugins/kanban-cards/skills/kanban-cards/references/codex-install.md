# Install Kanban.cards in Codex

The package is a local source plugin until its repository files are published. It is not listed in the public plugin directory. Install the actual package from a trusted local checkout for development:

```bash
codex plugin marketplace add /absolute/path/to/kanban.cards
codex plugin add kanban-cards@kanban-cards
```

Start a new Codex session after installation. Run the plugin's setup workflow or ask Codex to use `kanban-cards` with the public Workspace URL and Project ID copied from the native app.

Once the package and repository marketplace are published to the selected Git ref, repository distribution uses:

```bash
codex plugin marketplace add Surfaces-Platform/kanban.cards
codex plugin add kanban-cards@kanban-cards
```

The remote commands require those files to exist at the fetched ref. Publishing to the public universal plugin directory is a separate review/submission action. Do not describe local packaging, a Git marketplace, or a successful install as public-directory publication.

The package contains skills and a Node.js API helper. It needs a Codex host that can execute Node.js 22+, access the target Git repository, reach Kanban.cards, and save private user configuration outside that repository. It supplies no remote MCP endpoint, background coordinator, automatic dispatch, or new cloud infrastructure. A connected agent updates Cards only while an authorized task is running.

Plugins available to an account can be used on mobile in Chat or Work, according to current OpenAI documentation. That statement does not prove this local Git marketplace, Node helper, native approval flow, or coding project can be installed and executed entirely from an iPhone. Do not promise phone-only cloud completion without a separate device test.

Official documentation checked 2026-10-21:

1. [Package plugins](https://developers.openai.com/plugins/build/plugins): portable `plugin.json`, `skills/`, onboarding skill, repository marketplaces, and distribution.
2. [Use plugins](https://learn.chatgpt.com/docs/plugins): supported plugin surfaces and starting a new session.

Local command syntax was checked with `codex-cli 0.155.0` help. A successful isolated install confirms package loading only; native approval and a live connected task need their own verification.

For an isolated connection, set `KANBAN_CARDS_CONFIG_DIR` to an absolute private directory outside the target repository. Use the same value for setup and every later helper command. Both credentials and pending approval stay there; the ordinary `~/.kanban-cards` connection is neither read nor changed. The directory uses mode 0700 and private files use mode 0600. Relative paths, symlinked credential directories, and paths resolving inside the repository are rejected. Keep the account home variables unchanged.
