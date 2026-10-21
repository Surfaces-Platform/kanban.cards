# New Project and New Card: second UX audit

Reviewed October 20, 2026 against the current local implementation, the permissioned NN/g corpus, and Apple's official Human Interface Guidelines.

## Result

Three Medium findings and two Low findings remain. No High finding was identified. The earlier audit's overall clean conclusion was too broad: its passing scenarios and screenshots remain useful evidence, but they did not cover the states below.

The repeat audit left application code and tests unchanged. Two independent reviews examined behavior and visual/accessibility evidence before comparing conclusions. New edge cases were established from source; they were not reproduced in a new simulator run.

## Findings

### 1. Medium: a running save looks like an unresolved save

When Create starts, `saving` becomes true and the request is marked submitted before the network call. The form immediately displays “The save hasn’t been confirmed yet. Check its result before making changes.” Check Save, Cancel, and dismissal are disabled. There is no progress indicator or Creating status to distinguish an active request from an attempt that already ended without a confirmed result.

A slow request therefore looks stalled even when the app is working normally. Separate active processing from uncertain completion: show Creating with a native progress indicator while awaiting the request, and offer recovery only after an uncertain outcome.

Evidence: [status and disabled fields](../ios/KanbanCards/UI/CreationEditors.swift#L248), [disabled Cancel and dismissal](../ios/KanbanCards/UI/CreationEditors.swift#L304), [request sequence](../ios/KanbanCards/UI/CreationEditors.swift#L497). These state transitions are source-confirmed; perceived freezing is the usability inference. Apple HIG **Progress indicators**, Discussion and Best practices, and Aurora Harley's NN/g **Visibility of System Status**, “Appropriate Feedback,” support clear feedback during a wait.

### 2. Medium: archiving a Project hides recovery for its new-Card drafts

Keep a new Card draft, archive its Project, then reopen the archived Project. The only entry into this creation-draft collection is inside New Card, but the archived Project hides New Card. The draft bytes remain stored; the owner loses the route to preview or recover them while the Project is archived. The archived notice still says retained drafts can be recovered locally.

If the Project becomes archived while the creation form is already open, the fields and main action become disabled without an archived explanation. An already-submitted draft's inline Check Save button does not include the read-only condition, so it can remain enabled while its handler immediately returns.

Expose a recovery-only entry point on archived Projects and explain why creation is unavailable. Keep local viewing/export available without enabling server writes.

Evidence: [archived notice](../ios/KanbanCards/UI/Views.swift#L254), [hidden New Card action](../ios/KanbanCards/UI/Views.swift#L298), [recovery entry](../ios/KanbanCards/UI/CreationEditors.swift#L276), [read-only guard](../ios/KanbanCards/UI/CreationEditors.swift#L497). Route availability is source-confirmed; no archive transition was newly exercised. NN/g **Error-Message Guidelines**, “Efficiency Guidelines,” supports preserving effort and reducing recovery work. Apple HIG **Writing**, Best practices, supports accurate guidance and useful next actions.

### 3. Medium: Card recovery hides details that “Use Text” also copies

The saved preview displays only title and description. “Use Text in New Card” copies the whole Card draft, including next actor, priority, next action, and blocker. Those values then sit inside collapsed More details. A draft containing only these optional values can have an Untitled card preview with none of the entered values visible.

The recovery decision therefore omits information that affects the new Card. Show the retained details in the preview or a clearly named disclosure, and either label the action as copying the draft or restrict a text-copy action to the fields it names.

Evidence: [copy implementation](../ios/KanbanCards/UI/CreationEditors.swift#L47), [preview and action](../ios/KanbanCards/UI/CreationEditors.swift#L355), [applying the copy](../ios/KanbanCards/UI/CreationEditors.swift#L556), [collapsed details](../ios/KanbanCards/UI/CreationEditors.swift#L135), and the [captured copy action](../.local/creation-flow/final-attachments/42FB5470-3A76-4400-9107-AAE230FAE8DF.png). The screenshot confirms the label and preview; copying populated optional metadata is source-confirmed, not demonstrated by that fixture. Jakob Nielsen's NN/g **10 Usability Heuristics**, “Recognition Rather than Recall,” and Apple HIG **Writing**, Best practices, support visible decision information and accurate labels.

### 4. Low: switching drafts can retain the previous draft's server error

After draft A receives a definitive server error, keep A and continue saved draft B. `applyRecovery` replaces the payload and identity without clearing `errorMessage`. A successful local save clears that message only when `persistenceFailed` was true. A's server error can therefore appear below B's fields.

Clear draft-specific messages after a successful switch, or associate each error with its draft identity. Evidence: [conditional error reset](../ios/KanbanCards/UI/CreationEditors.swift#L458), [server error assignment](../ios/KanbanCards/UI/CreationEditors.swift#L531), [draft switch](../ios/KanbanCards/UI/CreationEditors.swift#L561). The stale-error path is confirmed in source and was not reproduced in a new runtime check. Apple HIG **Writing**, “Write clear error messages,” supports messages that identify the current problem and remedy.

### 5. Low: field names disappear after entry

Name, Title, and Description rely on placeholders instead of persistent visible labels. The filled-form screenshots show values without those field names. Small persistent labels would help someone returning to an unfinished form.

Evidence: [Card fields](../ios/KanbanCards/UI/CreationEditors.swift#L125), [Project fields](../ios/KanbanCards/UI/CreationEditors.swift#L164), and the recorded filled-form/cancellation captures. Apple HIG **Text fields**, Best practices, permits placeholder hints and suggests separate labels; Huei-Hsin Wang's NN/g **Few Guesses, More Success**, “Avoid Using Placeholders,” recommends persistent guidance. Persistent labels would improve usability; no VoiceOver failure was demonstrated.

## What still works and what remains unverified

The captured fresh forms put writing first, avoid the old blocking migration panel, and show the three explicit cancellation choices. Existing test receipts cover fresh creation, cancellation, draft preservation, clearing fields, and recovery of the seeded legacy/unreadable records. Those passes do not establish behavior for every state above.

No new application test run was performed for this audit. Existing screenshots use light portrait appearance at 402 by 874 points. Large Dynamic Type, increased contrast, dark appearance, smaller screens, landscape, physical-device behavior, and actual VoiceOver traversal remain unverified. Accessibility-tree dumps are not equivalent to VoiceOver testing.

## Source and guideline provenance

Audited source SHA-256 values:

- `ios/KanbanCards/UI/CreationEditors.swift`: `98e8a010b03edf7f88b8b1e93e5721a6855852593c6ca067ae5f4b1fa841661f`
- `ios/KanbanCards/Core/CreationDraftStore.swift`: `3623ebcaff3b81c4e522ec281d7b9a533d0f0fa08e879185a2896408edaefa50`

NN/g sections were retrieved in full after separate keyword searches for recovery, form recognition, and status feedback. Publisher: Nielsen Norman Group. Permission identifier: `user-confirmed-local-setup-2026-07-19`.

| Author and canonical article | Retrieved section ID | SHA-256 |
| --- | --- | --- |
| Aurora Harley, [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/) | `nngroup:article:visibility-system-status:s3:appropriate-feedback:3128539062bc` | `3128539062bcef91a359b3faf241f577908a9cf9ef03d72922d5a57f1e81d9c8` |
| Evan Sunwall and Tim Neusesser, [Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/) | `nngroup:article:error-message-guidelines:s4:efficiency-guidelines:8d84706391ec` | `8d84706391ecc9665f451a4dabd3836fffa30a68fe36e46ddaa4dbdd9c240fe5` |
| Jakob Nielsen, [10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/) | `nngroup:article:ten-usability-heuristics:s7:6-recognition-rather-than-recall:56fa6404204c` | `56fa6404204cd3aaf65148c2cfb24f90638fc36397f0b5839941a8cba1e09f91` |
| Huei-Hsin Wang, [Few Guesses, More Success: 4 Principles to Reduce Cognitive Load in Forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/) | `nngroup:article:4-principles-reduce-cognitive-load:s21:avoid-using-placeholders:b4c953ceb622` | `b4c953ceb622106d6fbb11d19f7350ede21aaecbc3a921e1f8b7e52f184bda1e` |

Apple's official Markdown pages were read directly during this audit: [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators), [Writing](https://developer.apple.com/design/human-interface-guidelines/writing), [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields), [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets), and [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data). Specific findings above cite the applicable page and section. Applying those general principles to this app is reviewer judgment; neither NN/g nor Apple prescribes this draft-storage design.
