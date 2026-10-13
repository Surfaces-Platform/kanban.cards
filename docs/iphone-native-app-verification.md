# Early iPhone app verification

The native app uses standard Apple components with system appearance. This early private version includes native passkey presentation, Keychain sessions, Projects, Cards, Comments, Activity, combined filters, archive/restore, retained drafts, and conflict reconciliation. The [native authentication backend](native-auth.md) is already merged.

| Check | Recorded result |
| --- | --- |
| Simulator build and unit tests | Passed: 38 unit tests with Xcode 27 and an iOS 26.5 iPhone Simulator, including delayed refresh, obsolete-session, and Workspace recovery regressions |
| Simulator owner workflow | Passed: 3 XCUITests covering creation, editing, movement, Comments, filters, Activity, archive/restore, and retained drafts after relaunch |
| Backend regression checks | Check passed; 87 Node tests passed for this candidate; 47 browser tests passed during the native backend release |
| Native GUI source contract | Passed for all 9 application Swift files; no web rendering, custom drawing, custom control styles, or custom materials |
| Running interface review | Inspected Project, Card, editor with keyboard, filters, Activity, restored Card, sign-in, and large accessibility text in dark appearance |
| Private physical installation and launch | Passed, including a Home Screen launch with the existing owner session retained |
| Existing-owner passkey sign-in and Workspace read | Passed using Apple's development association mode only |
| Regular Apple CDN association and shared write workflow | Hold |
| Broader device/accessibility matrix and publication | Hold |

The [CI workflow](../.github/workflows/release-policy.yml) checks the native UI source contract alongside the existing backend checks and runs the shared Xcode scheme's unit and UI tests. Follow the [local build and test instructions](../ios/README.md) to reproduce the native checks. Signing profiles, installation receipts, diagnostics, and owner screenshots remain local and are not committed.

## Remaining acceptance

Complete the shared native/browser/agent workflow in the [plan](iphone-native-app-plan.md): create and edit Cards, move them, add Comments, inspect Activity, archive/restore, reconcile stale edits, and observe the same saved state after refresh. A passing simulator workflow does not establish physical shared-state acceptance.

Verify regular CDN association, small and large iPhones, VoiceOver, Reduce Motion, Reduce Transparency, increased contrast, and physical interruptions. TestFlight and App Store publication remain separate work. The development association result does not establish those outcomes.
