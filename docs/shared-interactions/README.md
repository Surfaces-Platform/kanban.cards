# Shared interactions for Mac, iPhone, and web

Owners should be able to change clients without learning different save, navigation, and recovery rules. The target is one feature set and one set of outcomes, expressed through each platform's standard controls.

This package defines the target and how to deliver it. It does not establish that the clients already match. The source inventory is pinned to `f3406b38b0c89bfdd65b909ce07c507f313a0084`. Direction A remains an isolated browser experiment; its viewer layout is not the common baseline.

## Start here

Use Node.js 22, npm, and a Git checkout containing the declared baseline commit. Run from the repository root:

```sh
npm run check:shared-interactions
```

The command reads the specification files and local Git objects. The existing CI specification-check job fetches repository history so the pinned baseline is available. It needs no account, credentials, server, browser, network connection, or dependency installation. It checks identifiers, capability coverage, source references, document links, and honest verification status. A successful result means the specification is internally consistent. It does not mean the apps pass the scenarios. The [validation record](validation.json) lists the checks run for this package and the runtime work that remains pending.

1. Read [the feature matrix](features.md) for current behavior and target gaps. [features.json](features.json) is its source inventory.
2. Read [the acceptance workflow](acceptance.md) and [shared scenarios](scenarios.json) before changing a client.
3. Implement the first slice below. Record real test evidence separately from source inspection.

No command in this package deploys, promotes, installs, or changes board data.

## Authority and scope

[Product vision](../product-vision.md) remains authoritative for the resource and trust model. This document defines the shared target for interactions that differ across the clients. During parity work, its explicit Save, local draft, separate Move, and reconciliation rules supersede contradictory target interaction prescriptions in [DESIGN.md](../../DESIGN.md), the [browser UI contract](../../UI_CONTRACT.md), and the [earlier iPhone plan](../iphone-native-app-plan.md). Those documents continue to describe current implementation constraints and platform-specific requirements until an implementation slice changes them together with tests.

The current Mac Column list with editable detail is the starting point. A Mac implementation detail does not override the rules below. Existing code, screenshots, historical receipts, or passing unrelated tests cannot establish cross-client acceptance.

The shared resources remain Owner → Workspace → Project → ordered Columns → Cards, Comments, and Activity. A handoff field does not execute an agent or grant authority. This work adds no new approval entities, background mutation queue, realtime transport, Column deletion/reordering, or synchronized unsaved drafts.

## Complete the same owner workflow

Choose a Workspace, open a Project, find a Card, change its fields, Save, then continue. Move, Post Comment, Activity, Archive, and Restore have the same data effects on all clients.

| Action | Required result |
| --- | --- |
| Open an existing Card | Expose editable fields directly. Opening and typing do not write to the server. Show whether the view contains saved data or a recovered local draft. |
| Save | Validate the draft and commit the intended editable changes against the latest reconciled version. Keep the Card open, apply the confirmed response, and clear only the confirmed draft. |
| Create | Commit the new resource only on explicit Create. Persist the submitted snapshot and operation identity before the request. |
| Close, Back, or Cancel | Retain unfinished local work and restore the surrounding navigation context. Cancel never means that an unconfirmed server request has been undone. |
| Revert an existing Card | Confirm removal of local edits and return to latest saved content. Do not send a compensating server mutation. Reconcile any outstanding request first. |
| Discard a new-resource or Comment draft | Remove local work only after confirmation. A request with an unknown outcome must be reconciled before its operation identity can be discarded or replaced. |
| Move | Write only `columnId` and any required ordering `position`, with a version precondition. Do not write Title, Description, handoff fields, or priority. Keep unrelated local edits. |
| Post Comment | Commit once through explicit Post, retaining text and one operation identity until confirmed. A Comment's new Card version must not erase a Card draft. |
| Archive / Restore | Use non-destructive versioned mutations. Archived resources remain discoverable and readable; editing waits for Restore. Archive does not save or discard local edits. Restore is available after navigation and relaunch, independently of a transient Undo notice. |
| Refresh | Read shared saved data while preserving selection, filters, and local drafts. Never label saved data as realtime. |

All Card editors preserve title, raw Description/body text and whitespace, next actor, next action, priority, and blocker. Description preview must use the same safe subset documented in the current browser UI contract, with standard native text/link presentation on Apple platforms. Preview never changes stored source or initiates a write.

Search uses title, Description, next action, and blocker within the active Project. Trim Unicode `White_Space` at query ends, apply NFC normalization, locale-independent full case folding, then NFC again to query and each field. Match a literal substring within any single field; retain accents and interior whitespace. An empty normalized query matches all active Cards before filters. These rules follow [Unicode default case folding](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/); SI-019 supplies concrete cross-language examples.

Use this fixed whitespace set for query trimming and for deciding whether a blocker is empty: U+0009–000D, U+0020, U+0085, U+00A0, U+1680, U+2000–200A, U+2028–2029, U+202F, U+205F, U+3000, as listed in the [Unicode property data](https://www.unicode.org/Public/17.0.0/ucd/PropList.txt). A Card is blocked only if its blocker contains a character outside that set. Matching never rewrites stored text.

Actor, priority, and blocked filters combine with AND; search combines with those filters. Clear filters preserves search and has a separate Clear search action. Filtering a selected Card out of the results keeps its detail and draft open with an explanation. Closing returns focus to that Card if visible, otherwise its visible Column control. Search and filters do not modify stored data.

Custom Column IDs, order, and Card placement remain intact. New Projects start with Next, Doing, and Done. Project editing covers name and description; Column creation and rename become available on all clients. Reorder and deletion are outside this target.

## Preserve work through conflicts and interruptions

Each editing session retains three values: the original saved baseline, the local proposed changes, and the latest confirmed saved resource. Reconciliation is based on changed fields, not a version number alone.

1. If only the local draft changed a field, retain that edit. If only saved data changed a field, adopt the saved value. Equal resulting values do not conflict. Competing changes to the same field require deliberate selection; display both values before another Save.
2. After a confirmed Move, adopt its destination, position, and version into fields untouched locally. A dirty title followed by Move Next → Done and Save must remain in Done. A competing destination retained by an older editor requires explicit recovery: either adopt saved placement or request a separate Move. Saving text alone cannot enact the legacy destination. Treat `columnId` and `position` together so placement stays valid.
3. A confirmed Comment can update the version without creating a text conflict. No recovery button may silently replace untouched fields with an old full-form snapshot.
4. Retrying an unconfirmed POST uses the identical submitted payload and idempotency key. Retrying a versioned PATCH requires readback and reconciliation; POST idempotency does not establish PATCH receipt identity. Matching saved values establish the current state, not proof of which request produced it. Never resend a newer edited payload as the old attempt.
5. A confirmed mutation followed by failed Refresh remains confirmed. Apply its response and offer Refresh retry without repeating the mutation. Retain local cleanup receipts until durable draft cleanup succeeds.
6. If a resource is missing, archived, or access is revoked, preserve recoverable local text, stop writes, and explain the unavailable resource. Do not recreate it automatically or restore it as a side effect of Save.

| State | User can rely on |
| --- | --- |
| Saved | Displayed data has a confirmed saved baseline. |
| Local draft | Changes are durable locally and have not been committed. A local write failure must remain visibly distinct. |
| Saving | The exact submitted snapshot and retry identity are protected. Conflicting commands cannot start a second intent. |
| Unconfirmed | The server may have committed. Reconcile or retry that intent before replacing it. Closing does not mean cancellation. |
| Conflict | Local work is retained; latest saved values and explicit recovery choices are available. |
| Confirmed; Refresh incomplete | The write succeeded. Retry only the incomplete read or local cleanup. |
| Archived / unavailable | Saved data is read-only or inaccessible; retained drafts cannot bypass that state. |
| Signed out / expired | Private views close immediately. No late response or retry can write into a different owner's session. |

## Retain drafts on the current device

Draft identity includes authenticated owner ID, exact Workspace identity/origin, Project ID, and resource ID or stable local creation ID. Display names are not identity keys. Persist Card/Project/Comment drafts and pending operation identities atomically with versioned formats and lossless migration of existing native drafts.

Closing, navigation, relaunch, sign-out, and expiry retain local recovery material. Sign-out hides it immediately; a later sign-in by the same verified owner can recover it. Another owner cannot see or submit it. Provide an explicit local draft removal action. Stored credentials, recovery codes, and issued secrets never belong in draft content or fixtures.

The target requires Mac panes and windows for the same Card to share coordinated editing, including Comment drafts and submitted operation identities. Separate browser tabs or processes cannot silently overwrite another retained draft; retain divergent copies and require recovery. No assumption about a single open window may be used as a storage lock.

When local persistence fails, show that protection has failed, retain the in-memory text, and offer Retry plus Copy/Export using platform-standard controls. Do not claim that a draft is safely retained or discard it during navigation while persistence remains unresolved. A sign-out still hides private content immediately. Owner-partitioned in-memory recovery may remain available after verified sign-in by the same owner while the process stays open. Relaunch can recover only persisted material. Explain that closing the process before persistence succeeds can lose that text; never promise durability for a failed write.

## Keep native controls and complete the same features

Mac uses standard system windows, menus, split views, lists, forms, sheets, and keyboard commands. Card windows remain optional. iPhone uses standard navigation, lists, forms, sheets, toolbars, and system Back. Web uses semantic responsive controls and ordinary browser navigation. Native UI automation runs in the dedicated VM; physical passkey/device checks remain separate evidence.

These platform differences are permitted: simultaneous native Mac windows, input shortcuts and context menus, system passkey presentation, browser cookies versus Keychain native credentials, and their existing server-defined session lifetimes. They do not waive shared business actions or recovery outcomes. Web does not imitate Mac window chrome, and iPhone does not need desktop windows to satisfy parity.

Full feature parity includes account enrollment, recovery, passkeys, recovery-code replacement, sessions, and scoped agent-key management. Native session authority currently excludes these operations. Implementing parity requires deliberate backend authorization and recent-verification support plus native forms; copying browser requests with native credentials is not a solution. Until then, record each missing native feature. A browser handoff is a visible temporary exception, never an accepted claim of feature parity.

## Deliver and verify one slice at a time

| Slice | Required result before the slice is complete |
| --- | --- |
| 1. Editing, drafts, and reconciliation | All clients meet Save, Close/Back, Revert/Discard, owner isolation, local failure, relaunch, unknown-response, non-overlap, and same-field conflict scenarios. This includes the Move-followed-by-Save safety rule. |
| 2. Move, Comments, archive, and history | All clients expose destination-only Move, one-time Comment posting, durable archive discovery and Restore, and Project/Card Activity with the same recovery rules. |
| 3. Finding and maintaining work | All clients share search scope, combined filters, focus recovery, Project name/description, Column creation/rename, and safe Description preview. |
| 4. Account feature gaps | Backend authorization and each native account feature meet the same owner-visible outcomes and security requirements as browser access. |

For every slice:

1. Select the applicable scenario IDs from [scenarios.json](scenarios.json). Record the exact base/changes and expected API effects. Fix an ambiguous expected result in the common specification before diverging client behavior.
2. Implement the feature across Mac, iPhone, and web. Reuse portable Swift domain logic where it reduces duplication; use the same language-neutral scenario data in Swift and TypeScript. Keep platform UI separate.
3. Update current implementation contracts with the implementation, not ahead of it. Add focused tests for actual client behavior and server effects. A toy implementation of the specification cannot substitute for these tests.
4. Run the documented per-client checks and manual/system checks in [acceptance.md](acceptance.md). Record client, scenario ID, exact revision/build, environment, result, and evidence path. All three clients must pass; an unavailable environment or unimplemented client remains pending, not passed or implicitly waived.
5. Run the cross-client handoff with a dedicated synthetic/test Project. Save on one client, refresh the other two, and read back identical stored data. Exercise competing edits and failure recovery as well as the successful path.
6. Use one focused review and affected checks. Commit, push, merge, deployment, promotion, and installation follow the user's separate release instructions. This package does not perform them.

The first implementation task is the shared baseline/draft/latest reconciliation behavior and its client tests. Preserve the existing checkout, Direction A port, old draft formats, and historical receipts throughout implementation. New evidence belongs in a new record; it must never rewrite an earlier result.
