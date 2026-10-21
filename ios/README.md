# kanban.cards for iPhone

Open the native iPhone project from the repository root:

```sh
open ios/KanbanCards.xcodeproj
```

Select the shared `KanbanCards` scheme. The project uses Swift 6, requires iOS 26 or later, and builds with the installed Xcode 27 toolchain. Xcode discovers Swift files in `KanbanCards/`, `KanbanCardsTests/`, and `KanbanCardsUITests/` through synchronized groups. The app entry point is `KanbanCards/KanbanCardsApp.swift`.

Every application screen must use standard Apple components with system appearance and behavior. The [native app plan](../docs/iphone-native-app-plan.md) defines the component inventory. Use Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), and [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) before changing the interface. Do not add custom control styles, materials, drawing, web views, or third-party UI dependencies.

## Create Projects and Cards

New Project and New Card open empty forms. Earlier drafts stay available through **Saved drafts** without blocking new work. New Card starts with Title, Description, and Column; **More details** contains assignment, priority, next action, and blocker.

Typing saves a separate draft on this iPhone. Cancel closes an untouched form immediately. After typing, Cancel offers **Keep Draft**, **Discard Draft**, and **Continue Editing**. Swiping down keeps a successfully saved draft. A failed local save stays visible with a retry and text export.

Open **Saved drafts** to preview earlier work, including a Card's Column, next actor, priority, next action, and blocker. **Continue Draft** resumes a draft saved for the current Workspace. If an earlier create request has no confirmed result, **Check Save** retries that same request. Creating and checking show a progress indicator while the request runs. A draft whose original Workspace is unknown offers **Copy to New Card** or **Copy to New Project**; this copies the displayed contents and keeps the original. Unreadable older records remain available to export, and neither case disables the fresh form. Field names stay visible after typing, and opening another draft clears the previous draft's error.

If the current form already contains work, the recovery action becomes **Keep Current and Copy Draft** or **Keep Current and Open Draft**. It saves that work before switching. **Close** returns to the current form without switching.

## Create and switch Workspaces

Open the Workspace title menu above the Project list to switch Workspaces or choose **New Workspace…**. The native form asks for a name and address. Cancel preserves the selected Workspace; successful creation opens its empty Project list. Accounts with no Workspaces have a visible New Workspace action. Existing Card drafts remain available when switching back.

Native creation uses the owner-session `POST /api/workspaces` contract. The backend change must be released before an installed client can create real Workspaces. Demo mode keeps creation in memory for isolated simulator testing.

## Browse archived Projects

Open **Archived Projects** at the bottom of a Workspace's Project list, then choose a Project. Its Cards, Archived Cards, Comments, Activity, and filters remain available. Archived Projects have no server editing, Move, archive, restore, or Comment actions.

Choose **Saved Card Drafts** in an archived Project to preview and export unfinished new Cards. Restore the Project in the Mac app before resuming or creating a Card on this iPhone. If the Project becomes archived during creation, the sheet shows the saved draft collection with the same preview and export actions.

A retained Card draft can still be confirmed for its original Workspace, copied, or exported. Confirmation protects a local copy on this iPhone and preserves the older record. It does not restore the Project or Card or save draft text to the server. Local draft fields and Revert remain disabled while browsing an archived Project.

## Build and test locally

Run these commands from the repository root. Build outputs stay in the ignored local project directory.

```sh
xcodebuild -project ios/KanbanCards.xcodeproj \
  -scheme KanbanCards -list \
  -derivedDataPath .local/ios/DerivedData

xcodebuild -project ios/KanbanCards.xcodeproj \
  -scheme KanbanCards -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .local/ios/DerivedData \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

Local ad hoc signing lets the simulator use Keychain without an Apple Development identity. An unsigned build can compile while Keychain operations fail.

For tests, choose an installed iPhone Simulator in Xcode and run Product → Test, or select its ID from `xcrun simctl list devices available` and run:

```sh
xcodebuild -project ios/KanbanCards.xcodeproj \
  -scheme KanbanCards \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_ID>' \
  -derivedDataPath .local/ios/DerivedData \
  -resultBundlePath .local/ios/NativeTests.xcresult \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test

npm run check:native-ui
```

Use a fresh result bundle path for each run. `KanbanCardsTests` checks API contracts, retained drafts, version checks, session handling, confirmed mutations followed by interrupted refreshes, delayed reads, obsolete session responses, and retrying Workspace loading with an existing session. `KanbanCardsUITests` exercises creation, editing, movement, Comments, combined filters, Activity, archive/restore, and draft retention across relaunch. It saves screenshots and accessibility trees in the result bundle.

To browse the interface without server credentials, add `--demo` to the Debug scheme's Run arguments. The app opens an isolated Demo Workspace; board changes remain in memory. Its owner-bound drafts persist locally. `--reset-demo-drafts` clears only those sample drafts. Release builds ignore demo arguments.

The source check rejects prohibited web rendering, custom drawing, control styles, and decorative materials. Review the running screens as well. A local build or passing test does not establish physical-device passkey sign-in or shared-state acceptance. The [plan's acceptance demonstration](../docs/iphone-native-app-plan.md) defines that work.

The [verification record](../docs/iphone-native-app-verification.md) lists the completed simulator checks, local screenshots, and remaining device acceptance steps.

## Sign and run on an iPhone

1. Use an iPhone running iOS 26 or later, connect it to Xcode, and enable Developer Mode. Select the shared `KanbanCards` scheme and the intended iPhone.
2. In Signing & Capabilities, select your authorized Apple developer team. The project uses automatic signing and bundle identifier `cards.kanban.iphone`; no personal signing team or provisioning profile is committed.
3. Keep the Associated Domains capability and canonical `webcredentials:auth.kanban.cards` entitlement. Configure the backend with the exact signed application identifier and verify the association file, following the [native authentication contract](../docs/native-auth.md).
4. Run the app in Xcode. Development and private device installs remain subject to the selected certificate and provisioning profile expiry. Apple's [provisioning profile guide](https://developer.apple.com/help/account/provisioning-profiles/provisioning-profile-updates/) explains first-launch online verification and the temporary offline option.
5. Tap Continue with passkey and choose the existing owner account. Initial enrollment, recovery, and credential management remain browser operations.

Recorded physical sign-in used Apple's development association mode with explicit device opt-in and a local build entitlement override. That override is not committed. The canonical entitlement above uses regular Apple CDN association, which remains unverified for this early version. Development association results do not establish TestFlight or App Store readiness.

## Early-version status

Simulator unit and workflow tests passed. Private physical installation, launch, existing-owner passkey sign-in, and Workspace Projects reading passed; sign-in was verified in development association mode only. The shared write workflow, regular CDN association, broader accessibility/device coverage, and publication remain open in the [verification record](../docs/iphone-native-app-verification.md).

App Store preparation still needs artwork, privacy and export-compliance declarations, distribution signing, and submission review. No signing credentials, personal profiles, device diagnostics, or owner screenshots are included in source control.

## App icon

The app uses the canonical Nickel Split K artwork in `KanbanCards/AppIcon.icon`. Apple's [Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer) supplies the native icon shape, sizes, and system appearances. The source artwork keeps the approved geometry, Ink background, ivory stem and upper arm, and Nickel lower arm.

To refresh both native icons from [the canonical brand tile](../brand/split-k/app-icons/app-icon-nickel.svg), run from the repository root:

```sh
python3 scripts/sync-native-app-icons.py
```

Xcode compiles the checked-in icon documents for both Debug and Release builds. Rebuild and reinstall the app to update an existing installation.
