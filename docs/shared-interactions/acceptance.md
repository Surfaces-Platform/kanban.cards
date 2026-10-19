# Shared interaction acceptance

The 31 cases in [scenarios.json](scenarios.json) link to [features.json](features.json) and define future behavior for macOS, iOS and web. Runtime acceptance is **pending on every platform**. The source baseline is `f3406b38b0c89bfdd65b909ce07c507f313a0084`. Existing tests and documentation help locate implementation work; no case passes by association.

From the repository root, inspect the machine-readable contract with:

```sh
python3 -m json.tool docs/shared-interactions/scenarios.json
```

JSON parsing checks document structure only. The repository contract checker must also validate scenario IDs, capability references, priorities and platform names. Neither check launches the product or proves the requested behavior.

## Common assertions

Each platform adapter performs the same user action and checks the same stored effects. Native windows, navigation stacks, sheets and browser tabs can differ. A test must name when a change is a local draft, a requested operation, an unknown result, an observed saved state or a confirmed write.

1. Reset a fresh synthetic fixture for each scenario and each independent variant. The JSON fixture supplies IDs and selected field values; adapters add server-required timestamps and other mandatory defaults. Its `.invalid` origins are placeholders, never production endpoints. Map them to the isolated test server without weakening owner or origin checks. Use no real account, board, credential or device data.
2. Record server state and requests independently of the rendered UI. Check fields, identity, Column placement, versions, Comments and Activity. A screenshot of proposed text does not establish persistence. Read after each confirmed write and assert that unrelated fields and resources remain intact.
3. Retain baseline, proposed draft and latest saved fields for reconciliation. A Comment can change version without changing editable fields. A Move may send `columnId` and permitted `position`; dirty text and metadata never accompany the Move command. SI-005 must end in Done after the later title Save. Text Save never changes placement; SI-006 preserves a legacy destination until the owner adopts saved placement or starts a separate Move.
4. Freeze idempotent POST keys and payloads while the outcome is unknown. Local Revert or Discard does not undo the server and cannot erase unresolved operation identity before reconciliation. One original POST operation has one effect across its retries; an acknowledged and submitted separate intent has its own independent effect. Versioned PATCH uses readback and current-version reconciliation, not assumed idempotency. Matching saved values do not prove original request identity.
5. Distinguish disk persistence from memory recovery. A failed disk write can leave useful owner-scoped text in the running client. Sign-out hides retained content; verified same-owner authentication can recover unsaved text only while that client process still holds it. Relaunch restores persisted records. Never describe an in-memory draft as durable or retry an old operation under another owner.
6. Run every declared platform and branch. Mark unsupported behavior as a gap or blocked evidence. A browser management handoff can document an interim path; it cannot establish complete native feature parity. Pending evidence stays pending until the same-commit runtime assertions pass.

## Scenario coverage

All rows require macOS, iOS and web evidence. The IDs remain stable when platform tests are reorganized.

| ID | Required outcome |
| --- | --- |
| SI-001 | Field edits remain local until explicit Save. |
| SI-002 | Explicit Create adds exactly one Card in the selected Column. |
| SI-003 | Cancel/Close retain drafts through relaunch; explicit Discard removes unsubmitted drafts. |
| SI-004 | Local write failure preserves an honest, accessible recovery path. |
| SI-005 | Dirty title, Move Next to Done, then Save retains Done. |
| SI-006 | A legacy destination proposal requires adoption of saved placement or a separate Move; text Save never moves. |
| SI-007 | Posting a Comment advances version without creating a false text conflict. |
| SI-008 | Nonoverlapping external fields rebase without reverting saved changes. |
| SI-009 | Same-field conflicts require a deliberate choice with the full draft retained. |
| SI-010 | Unknown POST retry preserves its key, payload and owner through discard/recovery. |
| SI-011 | Unknown versioned PATCH uses readback without claiming request idempotency. |
| SI-012 | Confirmed write survives failed refresh and local cleanup without resubmission. |
| SI-013 | Archive/Restore preserve unfinished drafts and saved placement. |
| SI-014 | Missing or unauthorized resources are never recreated implicitly. |
| SI-015 | Owner, Workspace and resource identities isolate durable drafts. |
| SI-016 | Sign-out hides private data and retains pending revocation intent. |
| SI-017 | Expiry blocks writes and obsolete failures cannot damage a replacement session. |
| SI-018 | Multiple Card/Comment presentations preserve drafts and unknown POST identities without duplicate submission. |
| SI-019 | Project-scoped search/filtering normalize whitespace-only blockers and preserve work/focus. |
| SI-020 | Workspace create/select Cancel preserves context; confirmed creation selects the new Workspace. |
| SI-021 | Unknown Workspace creation reconciles exact owned inventory. |
| SI-022 | Project and custom Column operations preserve existing resource identities. |
| SI-023 | Interim management navigation names unsupported capabilities without passing full parity. |
| SI-024 | Saved handoffs agree across all six writer/reader platform pairs. |
| SI-025 | Description preserves the exact LF fixture source and passive preview safety. |
| SI-026 | Refresh/Activity show saved changes without displacing local work. |
| SI-027 | Complete enrollment binds the intended owner/Workspace and gates board entry on recovery-code acknowledgement. |
| SI-028 | Complete recovery rotates credentials and revokes old authority while preserving resources. |
| SI-029 | Complete passkey/recovery-code management enforces recent verification and credential limits. |
| SI-030 | Complete session management lists and revokes only intended owner sessions. |
| SI-031 | Complete scoped key management enforces authority, scopes, expiry, revocation and one-time secrets. |

## Complete management acceptance

SI-023 checks interim navigation only. Enrollment, recovery, passkeys, sessions and scoped agent keys require the successful stored effects in SI-027 through SI-031 on all three platforms. Cancel and authority-rejection checks supplement those successful flows; they do not replace them. Native browser handoff cannot pass a complete-native case.

The current [native authentication contract](../native-auth.md) permits existing-owner sign-in and board access; it does not authorize native credential creation, account recovery or agent-key issuance. Complete native management therefore needs explicit backend authorization extensions and a defined recent-verification ceremony. Ordinary bearer possession cannot be promoted into that authority. Those prerequisites remain pending until implemented and verified; this package does not authorize live enrollment, recovery or credential writes.

The expected owned effects follow [`src/passkey-auth.ts`](../../src/passkey-auth.ts), the management routes in [`src/server.ts`](../../src/server.ts), [`tests/native-compatibility.test.ts`](../../tests/native-compatibility.test.ts), and the [product trust contract](../product-vision.md). The fixtures retain current five-minute recent-verification, eight-passkey, fifty-key-per-owner/Workspace and hundred-issuances-per-owner/hour limits. Changing a limit requires an explicit contract revision rather than silently changing test expectations.

SI-018 also covers independent same-Card Comment composers and their frozen POST keys. Shared Card fields alone do not establish coordinated Comment recovery. SI-019 makes the future normalization rule explicit: normalize each allowed field and query to NFC, apply default locale-independent full Unicode case folding, then normalize to NFC again. Trim the governing README Unicode White_Space set from query ends only. Match a literal substring within one title, Description, next action or blocker field; retain interior whitespace and diacritics. Empty/whitespace-only search matches all active Project Cards before AND filters. Blocked uses nonempty blocker text after trimming that same whitespace set, without rewriting stored source. The fixture includes NFC, full-case-fold, accent-preservation, interior-space and NBSP examples.

SI-025 checks the exact UTF-8/LF source bytes supplied in its fixture. There is no unspecified newline-normalization allowance. A CRLF variant needs an explicit expected byte sequence before execution and remains pending until that target is defined.

## Runners and existing source

The paths below identify existing suites to extend or inspect. Existing suite source does not establish passing shared acceptance. Each test implementation must name its SI IDs and load equivalent synthetic inputs.

| Layer | Existing paths | Evidence required |
| --- | --- | --- |
| Backend contracts | [`tests/native-auth.test.ts`](../../tests/native-auth.test.ts), [`tests/native-compatibility.test.ts`](../../tests/native-compatibility.test.ts), remaining [`tests/`](../../tests/) API tests | Isolated API readback, request/version/idempotency assertions, owner/origin isolation and fault injection. |
| macOS model | [`macos/KanbanCardsTests/`](../../macos/KanbanCardsTests/), especially `SharedCardEditingSessionTests`, `MultiwindowSessionTests`, `DraftStoreTests`, `SharedBoardStateTests` and `WorkspaceCreationTests` | Draft/baseline/latest comparisons, versioned saves, operation recovery, local storage faults and session races. |
| macOS UI | [`macos/KanbanCardsUITests/`](../../macos/KanbanCardsUITests/), especially `CardContextMenuAndInlineEditTests`, `ColumnLayoutAndInlineCommentTests`, `CommentDraftRecoveryTests`, `NativeWindowWorkflowTests` and `WorkspaceCreationTests` | Native actions, focused Card identity, independent windows, keyboard focus, retained text and native accessibility output. |
| iOS model | [`ios/KanbanCardsTests/`](../../ios/KanbanCardsTests/), including `NativeCoreTests`, `AppModelMutationTests`, `NativeAsyncRaceTests`, `ConfirmedDraftReceiptTests`, `WorkspaceLoadingTests` and `WorkspaceCreationTests` | Equivalent save/recovery effects with owner-bound storage, current versions and obsolete-response protection. |
| iOS UI | [`ios/KanbanCardsUITests/NativeWorkflowTests.swift`](../../ios/KanbanCardsUITests/NativeWorkflowTests.swift), [`WorkspaceCreationTests.swift`](../../ios/KanbanCardsUITests/WorkspaceCreationTests.swift) | Native Back/Cancel/Save behavior, resource context, retained drafts, reachable actions and accessibility. Extra iPhone windows are not a prerequisite for SI-018. |
| Web UI | [`tests/browser/context-dock.spec.ts`](../../tests/browser/context-dock.spec.ts), [`card-fields.spec.ts`](../../tests/browser/card-fields.spec.ts), [`lifecycle.spec.ts`](../../tests/browser/lifecycle.spec.ts), [`product-loop.spec.ts`](../../tests/browser/product-loop.spec.ts), [`workspace-access.spec.ts`](../../tests/browser/workspace-access.spec.ts) | Real browser/client/API flow, two tabs where needed, storage/fault injection, keyboard focus and saved readback. Public website and brand regressions remain separately covered by their existing suites. |
| Cross-client | SI-024 adapters using the same isolated server fixture | All six ordered writer/reader pairs, with a fresh authenticated read and independent local draft checks. Two mocked clients do not prove installed-device behavior. |

Run **all native UI automation inside the dedicated macOS VM**, including iOS simulator interaction. Record VM identity, unlocked guest state and destination. An `xcode-27` runner label alone does not prove VM isolation. No host-desktop UI automation or personal-device action is authorized by these fixtures. Native UI must use standard Apple components; shared semantics do not require copying Mac window layout onto iPhone or web.

## CI and evidence records

[The existing CI workflow](../../.github/workflows/release-policy.yml) runs `npm run check` and Node tests, an iOS unit/UI test command, Mac unit tests and a Mac Release build. Its Mac job does not run the Mac UI suite, and its web job does not run the Playwright suite. Establish the native runner's VM isolation before treating its UI execution as shared acceptance evidence. [The Mac README](../../macos/README.md) and [iOS README](../../ios/README.md) describe their existing commands and limits.

A future acceptance run must add the missing browser/Mac UI execution and record explicit SI coverage. A passing source guard, build, JSON validator or existing suite without SI assertions cannot close an acceptance row. Hosted CI, native UI results, cross-client saved readback and signed installation remain separate evidence.

For each scenario/platform/variant, record:

1. Scenario ID, platform, variant, tested commit and fixture digest.
2. Status (`pending`, `pass`, `fail` or `blocked`), runner/VM identity, test name and run/result-bundle path.
3. Redacted request trace and independent before/after server assertions, including counts and versions.
4. Local draft/relaunch assertions and any injected storage/network/session fault.
5. UI/accessibility evidence that supports the claimed behavior: screenshots for labels/layout, keyboard traces for focus, and spoken output for speech assertions. Retain native result attachments when available.
6. Exact unresolved behavior or runner blocker. A test skipped because a capability is missing stays pending or blocked.

Keep synthetic run artifacts in task-specific ignored project output or CI artifacts. Do not store secrets or private account screenshots in this fixture package. Accept parity only after every required platform/variant has matching stored-effect evidence for the reviewed commit; preserve remaining gaps explicitly.
