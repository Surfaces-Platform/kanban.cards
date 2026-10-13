# iPhone native app plan

Build an iPhone app for kanban.cards where every application screen and control uses standard Apple native components with system appearance and behavior. No exceptions. The first working prototype must let an existing owner sign in with a passkey, open a Project, edit and move a Card, add a Comment, and see the same saved changes in the browser and agent client. The complete private first release must pass the broader demonstration in step 8.

The native project is in [`ios/`](../ios/README.md). This is an early private version. Simulator build, unit tests, and workflow tests passed. Existing-owner passkey sign-in and Workspace Projects reading passed on a physical iPhone using Apple's development association mode. Regular Apple CDN association, the shared write workflow, broader accessibility coverage, TestFlight, and App Store publication remain unverified. See the [verification record](iphone-native-app-verification.md). The standard-component requirement below applies to every change.

The current [product vision](product-vision.md) supplies the resource model and authority rules. Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) supply the iPhone interface patterns. The screen mapping below is a product proposal using those documented patterns; Apple does not prescribe kanban.cards' information architecture. The browser's [design contract](../DESIGN.md) remains browser guidance. Its original palette, geometry, Context Dock, and narrow-screen construction are not templates for this native app.

1. **Make standard Apple UI a binding requirement before implementation.** Use Swift and SwiftUI. Use a standard UIKit component only when a documented Apple component provides a capability SwiftUI lacks. Every screen, including authentication, errors, editing, recovery, and settings, follows the same requirement.

   Keep system navigation, list rows, forms, controls, typography, semantic colors, spacing, keyboard behavior, selection, and transitions. App-specific Swift view structs may compose these components and bind data; they may not create a new visual control or appearance. No custom button, toggle, picker, text-field, list, or navigation styles. No custom-drawn interface, Canvas, HTML/CSS, WebKit, cross-platform UI framework, third-party UI kit, custom gesture navigation, floating dock, toast, or recreated bottom sheet. No browser-based sign-in screen.

   Liquid Glass comes from system components. Do not add `glassEffect`, `GlassEffectContainer`, blur, gradients, shadows, masks, decorative capsules, or custom toolbar/sheet backgrounds. Apple explains that standard components adopt the system appearance automatically and advises removing backgrounds that interfere with it. Apple's [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) keeps Liquid Glass in the controls and navigation layer. This project's ban on custom styling is stricter than Apple's general permission to customize controls.

   Before adding any GUI element, identify its Apple component, relevant HIG page, and documented API. If no standard component fits, simplify or defer the feature. Do not invent a substitute.

2. **Use one familiar navigation hierarchy.** Start with `NavigationStack`: Workspaces → Projects → Project → Card. Use `NavigationLink` and the system Back control. Keep the selected Workspace, Project, and Card clear in navigation titles. Returning owners with one Workspace can open its Projects directly. Account settings open from a standard toolbar button.

   Show each Project as a vertical `List` with a `Section` for each existing Column, preserving server order and Card order. Each Card is a standard row with its title and concise native text for the next actor, priority, or blocker when present. Use the stored Column names, including custom names. Do not replace Columns with a new status model. Apple's [Lists and tables guidance](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) supports grouped text and hierarchical navigation.

   Use this component inventory for every application state:

   | User task | Apple components and behavior |
   | --- | --- |
   | Sign in, create a passkey, or verify identity | Native `Button` / `Form`, then the system AuthenticationServices passkey presentation |
   | Choose a Workspace or Project | `List`, `NavigationLink`, system navigation title and Back control |
   | Scan a Project | `List`, `Section`, `Text`, `Label`; standard row appearance |
   | Filter Cards | Toolbar `Button` opens a system `sheet` containing a `Form` and `Picker` controls for next actor, priority, and blocked state; a standard Clear action |
   | Read a Card | Native `List` / `LabeledContent` / `Text` sections with links to Comments and Activity |
   | Create or edit a Card or Project | System `sheet`, `Form`, `TextField`, `TextEditor`, `Picker`, and toolbar Cancel / Save or Create actions |
   | Move a Card | The existing Column `Picker` in the Card form; selecting a destination changes the stored Column on Save |
   | Read or add Comments | `List` and a native compose `sheet` with `TextEditor` and Send / Cancel actions |
   | Inspect Activity | A standard chronological `List` with native text and dates |
   | Archive or restore | Standard native buttons; an Archived Cards list provides Restore |
   | Refresh | `.refreshable` and `ProgressView` |
   | Empty or unavailable content | `ContentUnavailableView` with a standard action when useful |
   | Review a stale edit | A native `Form` showing the full draft and latest saved values, with editable fields and Save / Cancel actions |
   | Handle an actionable error or irreversible action | System `alert` or `confirmationDialog`, chosen using Apple's guidance |
   | Manage account and access | `List`, `Form`, standard native controls and AuthenticationServices verification |

   Use system modal presentation and toolbar action placement from Apple's [Sheets guidance](https://developer.apple.com/design/human-interface-guidelines/sheets). Dismissing an editor must retain its draft or use a system confirmation before discarding changes. Successful routine edits update the visible saved data; do not invent a success banner or use an alert for every save. Follow Apple's [Feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback).

3. **Prove native owner authentication before expanding the app.** The browser [authentication implementation](../src/passkey-auth.ts) uses Origins, cookies, and browser-bound handoffs. The separate [native contract](../src/native-auth.ts) must preserve the existing owner IDs, Workspaces, and RP ID `auth.kanban.cards`.

   Before device installation, verify the Apple developer team, signing access, bundle identifier, intended physical iPhone and OS version, and authority to publish the associated-domain entry. Use `ASAuthorizationPlatformPublicKeyCredentialProvider` and `ASAuthorizationController`. Configure the app's Associated Domains entitlement with `webcredentials:auth.kanban.cards` and serve the matching `apple-app-site-association` entry for the verified signed app ID. Follow Apple's [Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys) and [associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains) documentation.

   Validate the native challenge and verification ceremony using Apple's documented client data and relying-party rules. Do not spoof browser Origin headers or weaken the browser's checks. Native sessions use an opaque credential stored in Keychain and hashed server-side, with existing owner authority, a fixed 30-day expiry, and revocation. Resolve Workspace authority from the validated session and current membership on every request. Native owner Activity uses the `native` channel. The initial app does not expose credential management; recent passkey verification must be added before those actions ship.

   Native owner sessions must support sign-out, expiry, server revocation, and recovery revocation. Agent API keys remain agent credentials. They cannot substitute for owner sign-in. Verify a real passkey on a physical iPhone before calling authentication complete. Use a test owner for destructive recovery and revocation tests.

4. **Build one complete workflow against the shared backend.** Keep the Xcode project under `ios/` in this repository. Use the installed Xcode 27 toolchain, SwiftUI, Foundation `URLSession`, `Codable`, and native observation. The current deployment target is iOS 26; confirm the intended iPhone supports it before device installation. Do not introduce older-system visual emulation.

   Keep networking, authentication, models, and screen state separate. Reuse the existing server resources and [data model](../src/types.ts), rather than copying the JavaScript client or maintaining a second board database. First implement sign-in → Workspace → Project → Card → edit → move → comment → refresh. Completion means the browser and agent client read the same saved state.

5. **Complete the core owner workflow and failure recovery.** Support Project creation and editing, all current Card fields, combined filters, Comments, Activity, archive, and restore. Next actor stays You / Agent / Unassigned; priority stays High / Medium / Low / unset. Preserve custom Columns. A handoff never starts an agent or grants authority. Reviews and evidence remain text and links in Cards or Comments; do not add approval, reviewer, or evidence entities absent from the current product.

   Use explicit native Save / Cancel editing in this version. Preserve Card body source exactly, including Markdown and whitespace, in `TextEditor`. Display source as native text initially. Rich Markdown preview is deferred rather than embedded as HTML. External URLs use native link controls and the system-selected destination; no in-app webpage becomes an application screen.

   Start online-first. Refresh on Project entry, foreground return, pull-to-refresh, and confirmed mutations. Retain the complete local draft when a request fails. Store drafts in the app container, partitioned by owner and resource; never expose a previous owner's draft after sign-out. Do not add background mutation queues, push notifications, or realtime sync to the first release.

   Send `X-Kanban-Version` for Card edits and Project revisions for Project edits. After a 409, retain the full draft, fetch the latest data, and require deliberate reconciliation in the native form before another save. Comments also change Card versions. Reuse the same `Idempotency-Key` only for the same POST retry, then re-read current state. A timed-out request must not be shown as a confirmed failure or blindly duplicated. These behaviors follow the existing [API contract](../.agents/skills/kanban-cards/references/api.md).

6. **Add native account management after the core workflow works.** First deliver a private existing-owner build. Then add native signup, recovery-code saving and recovery, additional passkeys, recent verification, session management, Workspace creation, and scoped agent-key management. Every form and confirmation still uses the inventory above. Show newly issued secrets only where required by the existing product, with no credential logging.

   If account creation ships in the App Store app, add native account deletion and its backend support before submission. Apple requires apps supporting account creation to let people initiate account deletion in the app. Follow Apple's [account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/). A website fallback does not satisfy this project's native GUI requirement.

7. **Verify the running interface and shared state.** Review every screen against its cited Apple pattern and component inventory. Reject custom appearance or interaction even when implemented with SwiftUI primitives. Audit dependencies and UI code for web rendering, custom styles, drawing, materials, and gesture replacements. A source scan supports review; it cannot prove native appearance by itself.

   Test the core workflow on a small and large iPhone, in light and dark appearance, at large accessibility text sizes, with VoiceOver, Reduce Motion, Reduce Transparency, increased contrast, the keyboard visible, and interrupted networking. Confirm readable content, reachable actions, correct focus, native Back behavior, and no clipped controls. Follow Apple's [Accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility).

   Add focused tests for JSON contracts, owner/Workspace isolation, native session expiry and revocation, optimistic concurrency, retained drafts, idempotent retries, and archive/restore. Use XCUITest for the complete owner workflow and physical-device checks for passkeys and system appearance. Run the affected backend checks when native authentication changes; preserve existing browser authentication behavior.

8. **Deliver an installed iPhone build before considering publication complete.** The private first release acceptance demonstration must show native sign-in, Project navigation, Card creation and editing, movement, Comments, filtering, Activity, archive/restore, stale-edit recovery, and a browser or agent change appearing after native refresh. Every application screen must pass the standard-component review.

   Package a signed build for the intended iPhone, then prepare TestFlight after device acceptance. Public App Store submission adds the native onboarding/account-management work, privacy disclosures, app icon, screenshots, and account deletion described above. Device installation, TestFlight availability, and App Store publication are separate outcomes and need their own returned evidence.

Complete the shared workflow demonstration in step 8 and verify regular Apple CDN association. Development-mode sign-in and real Workspace Projects reading have passed; the CDN still served the earlier cached failure as of 18:53 UTC.
