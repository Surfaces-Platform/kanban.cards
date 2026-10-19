# Shared features across macOS, iOS, and web

Every client should open a Card ready to edit, keep changes local until Save, and preserve the same fields, recovery choices, and saved results. Standard platform controls can present those actions differently.

The matrix compares code at `f3406b38b0c89bfdd65b909ce07c507f313a0084` with that target. **Runtime acceptance remains pending.** `aligned` means the inspected implementation supports the feature scope, `partial` names a remaining difference, and `missing` means the client lacks the target path. File/line evidence and complete targets live in [features.json](features.json). The unmerged Direction A candidate is excluded from this inventory.

The target keeps custom Column work to creation and renaming while preserving IDs, order, and Card placements. Reordering and deletion are outside this work. Account-management rows retain the current browser-only gaps in the inventory; no native delegation exception is assumed.

| Capability ID | Feature | macOS source | iOS source | Web source |
| --- | --- | --- | --- | --- |
| `feature-workspace-create` | Create a Workspace | Aligned | Aligned | Aligned |
| `feature-workspace-switch` | Switch Workspaces safely | Aligned | Partial: editor scoping | Partial: navigation blocked by memory drafts |
| `feature-project-create-edit` | Create and edit Project metadata | Partial: Description hidden | Aligned | Aligned |
| `feature-project-archive-restore` | Archive and restore Projects | Aligned | Partial: API only | Partial: API only |
| `feature-column-create-rename` | Create and rename custom Columns | Partial: display/preservation only | Partial: display/preservation only | Aligned |
| `feature-card-create` | Create a Card | Aligned | Aligned | Partial: retry state is memory-only |
| `feature-card-edit-save` | Edit on open and save explicitly | Aligned | Partial: read-first/edit sheet | Partial: blur autosave |
| `feature-card-fields` | Read and edit every Card field | Aligned | Aligned | Aligned |
| `feature-draft-durability` | Keep drafts across relaunch | Aligned | Aligned | Missing |
| `feature-draft-owner-isolation` | Isolate drafts by owner and resource | Partial: mixed Workspace-origin keys | Partial: resource/session scope | Partial: clears memory without durable recovery |
| `feature-draft-close-cancel` | Close, cancel, and discard drafts deliberately | Partial: uncertain Discard | Partial: no Comment Discard | Partial: autosave and non-durable Cancel |
| `feature-move` | Move independently of editing | Partial: duplicate Column editing path | Partial: full Card save | Partial: flushes/blocks unsaved edits |
| `feature-comment-post` | Post a Comment explicitly | Aligned | Aligned | Partial: Comment state is memory-only |
| `feature-markdown-preview` | Preview Description without changing its source | Missing | Missing | Aligned |
| `feature-archive-restore` | Browse and restore archived Cards | Aligned | Aligned | Partial: session Undo only |
| `feature-project-activity` | Inspect Project Activity | Aligned | Aligned | Missing |
| `feature-card-activity` | Inspect Card Activity | Aligned | Aligned | Partial: twelve-event display |
| `feature-search` | Search Card text | Partial: Blocker and matching rules | Missing | Missing |
| `feature-filters` | Combine actor, priority, and blocked filters | Partial: White_Space/search rules | Partial: White_Space/search rules | Partial: White_Space/search rules |
| `feature-refresh` | Refresh saved state without losing work | Aligned | Aligned | Partial: session/read fencing |
| `feature-conflict-reconciliation` | Reconcile independent field changes | Partial: whole-draft replacement | Partial: whole-draft replacement | Partial: whole-draft replacement |
| `feature-unknown-response` | Recover uncertain mutation responses | Partial: uncertain PATCH readback | Partial: PATCH/timeout treatment | Partial: retry state lost on reload |
| `feature-local-write-failure` | Recover local draft-write failures | Aligned | Partial: keep-editor-open only | Missing |
| `feature-signout` | Sign out without exposing or losing local work | Aligned | Partial: editor invalidation | Partial: draft loss |
| `feature-session-expiry` | Handle session expiry and replaced sessions | Aligned | Partial: editor/expiry lifecycle | Partial: memory loss/late responses |
| `feature-account-enrollment` | Enroll an owner account | Missing | Missing | Aligned |
| `feature-account-recovery` | Recover owner access | Missing | Missing | Aligned |
| `feature-account-passkeys` | Manage passkeys and recovery code | Missing | Missing | Aligned |
| `feature-account-sessions` | Inspect and revoke account sessions | Partial: current sign-out only | Partial: current sign-out only | Partial: session type mislabeled |
| `feature-agent-keys` | Manage scoped agent keys | Missing | Missing | Aligned |
| `feature-native-controls` | Use standard platform controls | Aligned in source | Aligned in source | Aligned in source |
| `feature-cross-client-handoff` | Read saved changes on another client | Aligned in source | Aligned in source | Aligned in source |
| `feature-multiple-card-contexts` | Coordinate repeated Card contexts | Partial: independent Comment composers | Partial: editor-local state | Partial: page-local state |

The largest shared behavior differences are explicit Save on web, editing immediately on iOS, durable drafts in the browser, and field-by-field conflict reconciliation on every client. Native Column creation/renaming, Markdown preview, complete text search, and account management also need defined delivery work. The Mac Project form currently hides Description, and the web session list labels native credentials as browser sessions.

Search follows the [shared search and filter rules](README.md): NFC, locale-independent Unicode full casefold, then NFC; query-end trimming uses the explicit Unicode White_Space set. Match a literal substring in one field without collapsing interior spaces or stripping diacritics. A blank query matches all Cards in the active Project before AND filters. Blocked uses the same explicit White_Space set.

Implement the target in this order:

1. Establish draft ownership, persistence, local-write recovery, session invalidation, and repeated-context coordination before changing editing behavior. A failed local write must keep the text recoverable and make the failure visible.
2. Align editable-on-open and explicit Save, separate Move from Card text edits, and reconcile base/local/latest fields without overwriting independent changes. Freeze unknown submissions and keep confirmed writes separate from refresh or cleanup retries.
3. Complete Project/Column management, archive/restore, Project/Card Activity, text search, and structured filtering. Use the same field definitions and distinguish clearing search from clearing filters.
4. Complete supported enrollment, lost-access recovery, passkey management, recovery-code replacement, session, and agent-key paths on each client. Preserve the existing authority checks and use standard native controls for native screens.
5. Link each capability to the shared scenarios before implementation. Run the same saved-result and failure/recovery scenarios on all three clients, then record each client's runtime result separately. Source alignment, compilation, simulator results, installed builds, and released behavior remain separate claims.

Use the capability IDs in [features.json](features.json) to track each change and its shared scenario coverage.
