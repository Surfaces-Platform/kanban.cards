# New Project and New Card: fixes and verified UX audit

Reviewed October 20, 2026. All five findings from the [second audit](../docs/ios-creation-flow-reaudit-2026-10-20.md) are resolved in the reviewed flows. The independent repeat review found no remaining High, Medium, or Low issue in this scope after simulator testing and screenshot inspection.

At audit completion, the implementation was local in the isolated creation-draft worktree. The simulator evidence below predates the separately authorized landing and physical iPhone installation.

## Changes and observed behavior

| Original finding | Final behavior | Evidence |
| --- | --- | --- |
| Medium: active saves looked stalled | Native progress and Creating or Checking status appear while a request runs. Unconfirmed-result guidance appears only after an uncertain outcome. | [Creating](../.local/creation-flow/review-final/creating-card.png), [Checking](../.local/creation-flow/review-final/checking-card.png). Both Project and Card tests passed. |
| Medium: archived Projects hid new-Card drafts | Saved Card Drafts opens a collection for preview and export. It exposes no Create, Continue, Copy, or Check Save action. A Project archived during creation retains the current draft in that collection. The guidance names the Mac app's existing Restore Project action. | [Archived draft](../.local/creation-flow/review-final/archived-draft.png). Archived recovery passed before and after relaunch; the archive-during-creation test passed. |
| Medium: Use Text copied hidden metadata | The preview includes Column, next actor, priority, next action, and blocker. Copy to New Card describes copying a draft. When current work exists, Keep Current and Copy Draft or Keep Current and Open Draft saves it before switching. Close leaves the current draft unchanged. | [Complete preview](../.local/creation-flow/review-final/copied-details.png). UI tests checked every copied value. A unit test covers metadata-only drafts. |
| Low: the previous draft's error carried across a switch | A successful switch clears the previous draft's error. Closing recovery without switching preserves the original draft and its error. Failure to preserve current work blocks the switch. | [Recovered Project](../.local/creation-flow/review-final/recovered-project.png), [recovered Card](../.local/creation-flow/review-final/recovered-card.png). Tests also reopened Saved drafts and verified that the previous work remained. |
| Low: field names disappeared after entry | Name and Title use persistent labels. Description, Next action, and Blocker use native section labels above full-width multiline fields. | [Filled Project](../.local/creation-flow/review-final/filled-project.png), [filled Card](../.local/creation-flow/review-final/filled-card.png), [optional fields](../.local/creation-flow/review-final/optional-card-details.png). Fresh and filled inputs passed checks that their frames fit inside their form rows. |

Fresh [New Project](../.local/creation-flow/review-final/new-project.png) and [New Card](../.local/creation-flow/review-final/new-card.png) still start empty. Existing checks passed for immediate empty Cancel, Keep Draft, Discard Draft, Continue Editing, erasing all text, interruption, relaunch, unknown-origin copies, and unreadable records. These cases use synthetic local drafts.

## Simulator results and corrections during verification

Device: Kanban Creation QA, iPhone 17 Pro, iOS 26.5 (23F77), simulator ID `FEE61483-E700-477D-8273-96672D946F38`. Screenshots use light portrait appearance at 402 by 874 points and default text size.

| Result bundle | Result and disposition |
| --- | --- |
| [FiveFixesChecks.xcresult](../.local/creation-flow/FiveFixesChecks.xcresult) | 114 unit tests passed, one gated live-server test skipped. Fourteen of fifteen UI scenarios passed. The failed draft-switch test exposed a confirmation attached to an inactive navigation view. Screenshot review also found multiline clipping that the earlier assertions had missed. |
| [FiveFixesFinal.xcresult](../.local/creation-flow/FiveFixesFinal.xcresult) | Unit checks passed again; archived recovery and complete metadata-copy checks passed. The switch test exposed a lingering popover after navigation. The redundant confirmation was removed: the visible action now explains preservation and saves current work before switching. |
| [CreationAcceptance.xcresult](../.local/creation-flow/CreationAcceptance.xcresult) | Final build: 119 passed (114 unit and five UI tests), one gated live-server test skipped, zero failures, zero runtime warnings reported. The five UI tests cover normal saves, uncertain-save retries, fresh forms, filled labels and row geometry, and draft switching for both forms. |

All fifteen distinct UI scenarios have passing receipts across these runs. Changed behavior was rerun after correction. The full fifteen-scenario suite was not repeated after the final UI changes; unaffected cancellation, retention, relaunch, and archive results come from the earlier runs. Failed bundles remain available above. The [screenshot index](../.local/creation-flow/review-final/evidence.json) maps each selected image to its source test and attachment.

`node scripts/check-native-ui-contract.mjs` and `git diff --check` pass. The UI uses standard Apple components. No custom drawing, control styles, web rendering, or third-party UI dependencies were added.

## NN/g and Apple HIG assessment

The repeat review used two focused keyword searches and full retrieved NN/g sections, followed by independent source and screenshot inspection. The corpus supports the usability principles below; applying them to these flows is reviewer judgment, not an NN/g certification.

1. Aurora Harley, [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/), **Appropriate Feedback**: Creating and Checking now distinguish ongoing work from an unresolved outcome. Apple's [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators), Discussion and Best practices, supports visible, accurate progress feedback.
2. Evan Sunwall and Tim Neusesser, [Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/), **Efficiency Guidelines**: current work survives recovery, and archived drafts remain reachable. Apple's [Writing](https://developer.apple.com/design/human-interface-guidelines/writing), Best practices, supports accurate next steps and errors relevant to the current task.
3. Jakob Nielsen, [10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/), **Recognition Rather than Recall**: the preview exposes the values that copying retains, and action labels explain what happens.
4. Huei-Hsin Wang, [Few Guesses, More Success: 4 Principles to Reduce Cognitive Load in Forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/), **Avoid Using Placeholders**: persistent labels remain after typing. Apple's [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields), Best practices, supports separate labels; the final screenshots also verify usable multiline space.
5. Apple's [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets), Best practices, supports sparing use and clear cancellation. The editor's intentional Cancel keeps its Keep, Discard, and Continue choices. Switching between preserved drafts needs no second modal confirmation. Removing the lingering popover was an implementation correction verified in the simulator, not an Apple-prescribed code pattern.

### NN/g provenance

Publisher: Nielsen Norman Group. Permission identifier: `user-confirmed-local-setup-2026-07-19`. Retrieved section identities and content hashes:

| Section | SHA-256 |
| --- | --- |
| `nngroup:article:visibility-system-status:s3:appropriate-feedback:3128539062bc` | `3128539062bcef91a359b3faf241f577908a9cf9ef03d72922d5a57f1e81d9c8` |
| `nngroup:article:error-message-guidelines:s4:efficiency-guidelines:8d84706391ec` | `8d84706391ecc9665f451a4dabd3836fffa30a68fe36e46ddaa4dbdd9c240fe5` |
| `nngroup:article:ten-usability-heuristics:s7:6-recognition-rather-than-recall:56fa6404204c` | `56fa6404204cd3aaf65148c2cfb24f90638fc36397f0b5839941a8cba1e09f91` |
| `nngroup:article:4-principles-reduce-cognitive-load:s21:avoid-using-placeholders:b4c953ceb622` | `b4c953ceb622106d6fbb11d19f7350ede21aaecbc3a921e1f8b7e52f184bda1e` |

Apple's linked official pages were read in full during this review.

## Implementation and limits

The main changes are in [CreationEditors.swift](../ios/KanbanCards/UI/CreationEditors.swift), [Views.swift](../ios/KanbanCards/UI/Views.swift), and the synthetic Debug fixtures in [AppModel.swift](../ios/KanbanCards/UI/AppModel.swift). Regressions are in [CreationFlowTests.swift](../ios/KanbanCardsUITests/CreationFlowTests.swift) and [CreationPayloadTests.swift](../ios/KanbanCardsTests/CreationPayloadTests.swift).

Final source SHA-256:

1. `CreationEditors.swift`: `26781d7b1320c9a11228c7791dd2f43e9a5859116056f07a8d9ece48db746fde`
2. `Views.swift`: `09bab5b12d4254a705ba9f3410b12a7a0c64ac4fdc6c13ffe0c1567c57f6127e`
3. `AppModel.swift`: `9723363f28a2eed2a522f3317fc862b753c9152f53363b6a8b53aabc6404beb5`
4. `CreationFlowTests.swift`: `2f7785be09344f068a4bd6772e9ee7ea3b86a30f03555cf8f51f90613aa6208b`

Slow, failed, and uncertain save outcomes were simulated through Debug fixtures while exercising the real editor and local-draft code. No new live-server mutation, physical-device run, VoiceOver traversal, large Dynamic Type, dark appearance, landscape, or smaller-screen verification was performed. Passing these scoped checks does not establish those untested results.
