# New Project and New Card UX audit

Reviewed on October 20, 2026. Scope: the iPhone creation forms, local draft retention, cancellation, and optional recovery. This review uses the permissioned local NN/g UX corpus and Apple’s official Human Interface Guidelines.

## Result

No High or Medium findings remain in the reviewed create, cancel, and recovery paths. Source review, the targeted simulator scenarios, and the inspected screenshots passed.

The new implementation starts each creation form empty and keeps earlier drafts in a separate recovery list. Card title and description appear before optional assignment, priority, next action, and blocker fields. Cancel offers Keep Draft, Discard Draft, and Continue Editing when work exists. Swiping closes an already autosaved draft; a local-save message explains that the work is retained. Saving failures prevent swipe dismissal until the person resolves the failure.

The source review identified and resolved these issues:

| Finding | Severity | Disposition |
| --- | --- | --- |
| Opening a saved draft could replace the payload while a create request was running. | High | Recovery is disabled during saving. Asynchronous completion must match the operation’s draft UUID before changing the active editor. |
| Erasing all entered content could leave older autosaved text available for recovery. | Medium | Clearing a new form now removes its current working record. A failed removal shows Retry Removing Draft, and Cancel cannot silently bypass the failure. |
| Swiping on a changed form was blocked without a useful response. | Medium | Successfully autosaved drafts can be dismissed by swiping. The form states that the draft is saved locally. Active requests and failed persistence remain protected. |
| Recovery failures appeared behind the recovery view. | Medium | Recovery failures now appear in the visible list or draft preview with a retry instruction. |
| Opening recovery added another modal over the creation form. | Medium | Recovery now uses the existing navigation stack and has a visible Close action. |
| The iOS confirmation popover omitted the action with the cancellation role, hiding the return-to-editing choice. | Medium | Continue Editing is now an explicit standard button in the native confirmation dialog. Simulator screenshots confirm all three choices are visible for both forms. |

These dispositions were checked in the source. The simulator screenshots listed below confirm the principal layouts and visible choices. Static review and these screenshots do not establish physical-device behavior, VoiceOver acceptance, or release readiness.

## Acceptance criteria

| Situation | Expected behavior | Basis |
| --- | --- | --- |
| Open New Project or New Card with a saved, legacy, or unreadable draft | Start with an editable, empty form. Offer recovery separately without requiring a statement about the old draft’s origin. | Product requirement; applying NN/g user control and recovery guidance. |
| Cancel an untouched form | Close immediately. Do not create a draft or show a destructive choice. | Product requirement; applying Apple’s instruction to keep interruptions useful. |
| Cancel after entering content | Offer Keep Draft, Discard Draft, and a safe return to the form. Each choice must have a distinct effect. | NN/g cancellation guidance; Apple Sheets and Action sheets. |
| Swipe down after entering content | Close only when the draft is safely retained locally; explain that retention in the form. Protect active requests and failed persistence from accidental dismissal. | Product decision applying Apple Sheets and NN/g preservation of user input. |
| Keep Draft | Retain current content on the iPhone and close. Reopening creation still starts fresh; recovery can reopen the saved content. | Product requirement; NN/g preservation of user input. |
| Discard Draft | Remove only the current local draft and close. Preserve other drafts and any server result. | Product requirement; Apple’s clear destructive choices. |
| Erase all new content and close | Do not resurrect earlier autosaved text or create an empty recovery entry. | Product requirement; applying NN/g respect for user effort. |
| Inspect an old draft | Show recognizable content before any recovery action. Unknown-origin recovery creates a copy and preserves the original. | Product requirement; applying NN/g useful recovery and Apple clear action labels. |
| Save result is uncertain | Preserve the request and current content. Explain a useful next step without claiming a confirmed save or retrying with a new identity. | Product requirement; applying NN/g precise, constructive error guidance. |
| Enter a new card | Show title and description before optional management details. | Applying NN/g progressive disclosure and Apple’s instruction to place the most important information first. |
| Recovery operation fails | Show the failure in the visible recovery context, preserve the draft, and offer a useful next step. | NN/g error-message guidance; Apple Writing. |

## Runtime verification

Verified for the targeted iPhone Simulator scenarios on October 20, 2026. All eight distinct UI scenarios passed across the runs below: seven in `CreationFlowTests` and the additional unread-draft regression in `NativeWorkflowTests`. The creation scenarios cover both Project and Card. The native source check and `git diff --check` also passed.

| Result bundle under `.local/creation-flow/` | Recorded result |
| --- | --- |
| `IsolatedTests.xcresult` | Six of seven UI scenarios passed. Erase-to-empty failed because the helper left description text in place. |
| `CompletedChecks.xcresult` | 113 unit tests passed; one live-server test was skipped by its environment gate. Both UI rechecks passed: erase-to-empty and unknown-origin copying. |
| `LegacyRegression.xcresult` | `NativeWorkflowTests/testUnreadCreationDraftsDoNotBlockNewFormsAfterRelaunch` passed: one test, zero failures. |

Eleven screenshots were visually inspected across these runs. Project and Card creation make the writing fields available first. Their cancellation popovers display Keep Draft, Discard Draft, and Continue Editing. Saved previews contain recognizable titles and descriptions; unknown-origin recovery offers a copy without demanding confirmation of the original Workspace. The final cleared forms are empty and show no saved-draft entry. No High or Medium visual finding remains in these inspected states.

| Inspected state | Project screenshot | Card screenshot |
| --- | --- | --- |
| Fresh form | [Project](../.local/creation-flow/attachments/A4E6895F-44F1-42AD-828B-0056BCF2BA58.png) | [Card](../.local/creation-flow/attachments/34313DDE-22F7-49F7-8523-0D7B41C22507.png) |
| Cancel choices | [Project](../.local/creation-flow/attachments/9C745387-0812-44F1-B17E-A050D9B06273.png) | [Card](../.local/creation-flow/attachments/BA6A08C7-4851-4FE0-815E-CDB37079D5BF.png) |
| Saved preview after relaunch | [Project](../.local/creation-flow/attachments/447A932C-582D-43B4-BB76-2AB04898ABC6.png) | [Card](../.local/creation-flow/attachments/CA9B32F2-3E5F-4FCA-A793-A8745DA4900D.png) |
| Unknown-origin copy | [Project](../.local/creation-flow/attachments/5AA5A712-7BBF-44A6-A562-E4416E5B8E45.png) | [Card, final recheck](../.local/creation-flow/final-attachments/42FB5470-3A76-4400-9107-AAE230FAE8DF.png) |
| Erased form after successful empty Cancel and reopening | [Project](../.local/creation-flow/final-attachments/BEFF78B6-C898-4141-A0EC-C0187ACE96CB.png) | [Card](../.local/creation-flow/final-attachments/FF8FDA83-A847-4117-ACA7-294EDF18C001.png) |

Screenshot links point to local verification artifacts, which are excluded from Git. Exported manifests map each image to its test and simulator. The initial `testErasingAllTextRestoresEmptyCancelWithoutLeavingSavedDraft` failure came from the clearing helper: the recording still showed the complete description with the caret at its beginning. The final recheck uses Select All and exact field assertions before Cancel, then verifies immediate dismissal and no saved draft when reopening. The failure and successful recheck remain recorded in their separate result bundles.

No physical-device or VoiceOver acceptance is claimed by this audit.

The exact form fields, recovery list, storage architecture, and treatment of legacy identity are product decisions. NN/g and Apple provide supporting principles; neither source prescribes this implementation.

## NN/g evidence

The following sections were retrieved in full from the permissioned local corpus. Search excerpts were used only to locate them. The corpus supports the general usability principles below; it is not an exhaustive or live assessment of this app.

1. Maria Rosala, [User Control and Freedom (Usability Heuristic #3)](https://www.nngroup.com/articles/user-control-and-freedom/), “Allow Users to Easily Cancel an Action.” Describes a visible, quick Cancel action and the choice to save or delete a composition draft without accidental loss.
2. Evan Sunwall and Tim Neusesser, [Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/), “Communication Guidelines” and “Efficiency Guidelines.” Recommends plain, precise, constructive messages, preserving input, and reducing recovery effort.
3. Huei-Hsin Wang, [Few Guesses, More Success: 4 Principles to Reduce Cognitive Load in Forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/), “Utilize Progressive Disclosure.” Recommends showing the information relevant to the current task and introducing additional fields as needed.
4. Megan Chan, [Designing for Serial Task Switching](https://www.nngroup.com/articles/serial-task-switching/), “Design for Error Prevention and Recovery.” Recommends safeguards, useful error messages, and forgiving defaults such as retaining work.

## Apple HIG evidence

1. [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets), “Anatomy” and “iOS, iPadOS.” Describes Cancel or Close as dismissing without saving, and Done as completing or saving. Calls for swipe dismissal, with an action sheet when unsaved changes need a decision.
2. [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets/), “Best practices” and “iOS, iPadOS.” Uses a cancelled Mail composition as the example for save-or-delete choices. Recommends brief content, a safe Cancel action, and distinct destructive actions. Identifies SwiftUI confirmation dialogs as the corresponding component.
3. [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), “Best practices,” “Buttons,” and “iOS, iPadOS.” Reserves alerts for essential information and useful actions. Recommends specific button titles and a safe way to cancel destructive actions. Directs intentional choices such as draft handling to action sheets.
4. [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data), “Best practices.” Recommends gathering available information automatically, clear field prompts, reasonable defaults, and making required inputs clear before proceeding.
5. [Writing](https://developer.apple.com/design/human-interface-guidelines/writing), “Getting started” and “Best practices.” Recommends familiar language, important information first, action-oriented labels, and useful error instructions near the problem.

Apple’s official pages were checked during this task. The web reader could not render their Markdown endpoints, so the cited guidance was read through indexed contents from the official developer.apple.com pages. No third-party HIG summary was used as evidence.

## NN/g provenance

Permission identifier: `user-confirmed-local-setup-2026-07-19`. Publisher: Nielsen Norman Group. Each row records the exact retrieved section and SHA-256 content hash.

| Document ID | Section ID | SHA-256 |
| --- | --- | --- |
| `nngroup:article:user-control-and-freedom` | `nngroup:article:user-control-and-freedom:s5:allow-users-to-easily-cancel-an-action:2f13d0132863` | `2f13d0132863abf73121f2b1e35ff252d90db3d157d771fa9b697cc0c98e80e9` |
| `nngroup:article:error-message-guidelines` | `nngroup:article:error-message-guidelines:s3:communication-guidelines:7360cffea63d` | `7360cffea63d5e16b97eb060a82985fc8788197c482bf9fa88dc6cd6529a4a1d` |
| `nngroup:article:error-message-guidelines` | `nngroup:article:error-message-guidelines:s4:efficiency-guidelines:8d84706391ec` | `8d84706391ecc9665f451a4dabd3836fffa30a68fe36e46ddaa4dbdd9c240fe5` |
| `nngroup:article:4-principles-reduce-cognitive-load` | `nngroup:article:4-principles-reduce-cognitive-load:s8:utilize-progressive-disclosure:82e6212a5886` | `82e6212a588651ed78382d845e0fce5817ffccc664c8412557c0df71e35ac15a` |
| `nngroup:article:serial-task-switching` | `nngroup:article:serial-task-switching:s16:design-for-error-prevention-and-recovery:0af57823e947` | `0af57823e947bcd2b396ceedb3b64ad8c21cef17032fc6344579e19c394db8d4` |
