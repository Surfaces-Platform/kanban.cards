# kanban.cards for iPhone

Open the native iPhone project from the repository root:

```sh
open ios/KanbanCards.xcodeproj
```

Select the shared `KanbanCards` scheme. The project uses Swift 6, requires iOS 26 or later, and builds with the installed Xcode 27 toolchain. Xcode discovers Swift files in `KanbanCards/`, `KanbanCardsTests/`, and `KanbanCardsUITests/` through synchronized groups. The app entry point is `KanbanCards/KanbanCardsApp.swift`.

Every application screen must use standard Apple components with system appearance and behavior. The [native app plan](../docs/iphone-native-app-plan.md) defines the component inventory. Use Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), and [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) before changing the interface. Do not add custom control styles, materials, drawing, web views, or third-party UI dependencies.

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
