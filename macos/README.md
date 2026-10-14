# kanban.cards for macOS

The native Mac app opens a Project board and independent Card windows. Each Card window can move, resize, close, and come forward independently. Opening an already visible Card activates its existing window. Standard macOS controls provide the title bars, menus, typography, layout, and system appearance.

The app supports macOS 26 or later. The repository's test targets use Xcode 27; VoiceOver tests require macOS 27 and an unlocked interactive session. The Mac has a separate `cards.kanban.macos` bundle identifier, Keychain service, draft directory, and Xcode project. It reuses the existing portable iPhone models and credential protocol without changing the iPhone app.

## Open a synthetic board and two Cards

From the repository root:

```sh
./macos/run-demo.sh
```

The script builds an ad hoc Debug app and opens the synthetic Studio Workspace, Atlas website board, and two Card viewers. It leaves account sessions and existing app processes intact. Add `--reset-demo-drafts` to clear only the synthetic owner's drafts. The build products stay in ignored `macos/.build`.

Demo mode is available only in Debug builds. It makes no account or backend changes. Confirmed demo edits remain in memory for that run; unsaved drafts persist locally. The [Direction A Figma scene](https://www.figma.com/design/zlFNrtTvemQYEDePnCynCU?node-id=45-3081) is the design reference.

## Window and editing behavior

1. Card viewers retain their original owner, Workspace, Project, and Card context when the board selection changes. Closing the board leaves viewers open; File → Show Board or Command-0 reopens the board. Saved frames remain on an available display.
2. Edit and Add Comment open native sheets with explicit Save and Cancel. Cancel retains a local draft. Drafts stay separate per owner and Card, preserve Markdown source, and recover when an editor reopens.
3. Confirmed saves update the board and matching viewers without replacing another Card's unsaved draft. A stale Card version requires reconciliation with current server content. Uncertain requests retain their retry identity.
4. Card actions and shortcuts use the focused viewer. Command-Option-E opens Edit, Shift-Command-M opens Add Comment, and Command-R refreshes that Card. With the board focused, Command-N creates a Card and Shift-Command-N creates a Project.
5. Sign-out immediately hides private data and closes viewers. Unconfirmed server revocation remains pending and can be retried. Archived Projects stay readable and reject edits until restored.
6. Actor, priority, blocker, and text filters combine. The app refreshes saved data when a view becomes active and on explicit refresh; it does not provide realtime synchronization or an offline mutation queue.

## Sign in and edit existing boards

Open `macos/KanbanCards.xcodeproj` in Xcode, select an Apple development team, and build a signed app. The Mac uses the system passkey sheet and native API at `auth.kanban.cards`. Source entitlements request `webcredentials:auth.kanban.cards`, outbound network access, sandboxing, and user-selected file access.

The server's Associated Domains allowlist must contain the signed Mac app's exact application identifier. Append `TEAMID.cards.kanban.macos` to `KANBAN_CARDS_IOS_APP_IDS`, replacing `TEAMID` with the signed App ID prefix and preserving every existing iPhone identifier. The [native authentication contract](../docs/native-auth.md) describes association and API requirements.

Ordinary launches allow normal owner editing, subject to server authorization and archived-item safeguards. For live verification, use a dedicated test Project and leave real data unchanged. Explicit `--live-read-only` disables board mutations. To allow changes only in one exact test Project, pass all of these arguments:

```text
--live-read-only
--writable-test-workspace https://your-workspace.kanban.cards
--writable-test-project PROJECT_ID
```

Incomplete, conflicting, or malformed verification arguments fall back to read-only. These launch restrictions affect only the Mac app and do not change server or iPhone permissions.

A successful local signed build and passkey ceremony establish behavior on that Mac. Fresh-install association delivery, distribution signing, notarization, TestFlight, and App Store acceptance require separate verification. The ad hoc demo cannot establish live authentication.

## Run checks

The source guard rejects web views, bespoke controls, altered window chrome, decorative effects, and custom fonts:

```sh
npm run check:macos-native-ui
```

Run native unit tests with isolated build data and an ad hoc signature:

```sh
xcodebuild -project macos/KanbanCards.xcodeproj \
  -scheme KanbanCards -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath macos/.build \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_ENTITLEMENTS= -only-testing:KanbanCardsTests test
```

CI runs these unit tests, a Release build, and the Mac source guard alongside the existing iPhone and web checks. Interactive tests use synthetic data and require an unlocked Mac. To run the UI suite, replace the final unit-test selector with `-only-testing:KanbanCardsUITests`. The suite includes independent window behavior, editing and drafts, menus, filters, archived Projects, appearance, accessible values, VoiceOver speech, and the native diagnostic audit. VoiceOver cases temporarily control VoiceOver and restore its initial state. The diagnostic audit retains reviewed host-specific native wrapper and system findings and rejects unreviewed issues.

Keep signed-account, hosted CI, interactive accessibility, and distribution evidence distinct. Use a dedicated test Project for live edit verification and confirm persistence by server readback and relaunch.
