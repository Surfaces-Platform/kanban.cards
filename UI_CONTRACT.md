# kanban.cards V2 UI Contract

[`DESIGN.md`](DESIGN.md) governs visual, interaction, responsive, accessibility, and content-design decisions. This file records testable constraints in the current client. It must follow the governing design rather than preserve an implementation choice after the design changes.

The browser is a visual surface over the same project API used by `$kanban-cards`. It does not maintain a separate workspace document or model agents inside the product.

[The shared interaction workflow](docs/shared-interactions/README.md) defines the cross-client target. This branch implements its first slice: explicit Save and Revert, durable scoped drafts, separate Move, and field reconciliation. Validation and deployment are separate; the slice receipt records the tested candidate and results. Later shared capabilities remain pending.

## Accepted interface direction

Context Dock is the only production interface direction.

- The ordered Column grid uses the full Kanban surface until a Card is opened. On desktop, Card detail then becomes a full-height, nonmodal right dock.
- Card detail must not use dialog or `aria-modal` semantics, inert the board, or hide Project context.
- On narrow screens, the Project shows one explicitly named Column at a time through a selector that includes its Card count.
- A selected Card becomes a dedicated narrow-screen task view with an X whose accessible name identifies the return Column.
- Closing returns to the originating Column unless the Card moved while open. After a move, it returns to the destination Column and restores the moved Card, selection, and keyboard focus.
- Focus Workspace remains comparison evidence. It must not ship as a second product mode.

The client has passkey sign-up/sign-in, recovery, access settings, zero/one/many Workspace routing, scoped API key management, Project selection and empty state, the Project workspace, and Card detail and editing. Local development may show the access-key fallback when hosted passkey authentication is absent.

## Public website scope

- Signed-out root/auth views use `body.public-website`, a reversed-brand header/footer, a source-grounded public homepage, and the existing passkey forms. Loading, handoff, sign-out progress, local development, and signed-in views do not acquire that marker.
- Public copy follows `docs/specs/website-family-copy.md`. It names the owner or authorized agent, states the installed-skill and write-access prerequisite for agent updates, and makes no pricing or automatic-execution promise. Recovery-mode instructions state credential revocation before the existing registration ceremony; other passkey modes retain their instructions.
- The ordinary signed-out root follows `docs/specs/website-family-layout.md`: one edge-to-edge image hero, one left text stack, exactly two auth actions, one ruled three-item problem row, one connected five-step workflow, at most two supporting sentences, and a compact footer. Main copy stays within 220 words; `website-assets/copy-provenance.md` records its first-party sources.
- Public headings use 40/32/24px desktop sizes and 32/24/20px sizes at widths up to 620px, with Inter weight 600 and zero tracking. Layout uses a separate 820px breakpoint.
- Every public override in `website.css` is qualified by the public marker. The stylesheet loads after the unchanged Workbench styles; it must not redefine `--jk-*` tokens. Only its unique, self-hosted Inter font face is global.
- Workspace selection, Manage access, Agent connections, and the Context Dock retain their current rendered font, colors, controls, and layout after sign-in. Sign-out restores the public shell and its existing bounded receipt.
- The font and license are fingerprinted in `website-assets/manifest.json`. The static build verifies and copies them. Exact GET/HEAD routes expose only the website stylesheet, font, license, and fingerprinted hero WebP; private API routes, other methods, and encoded traversal remain restricted.
- The hero eyebrow uses 14px type, normal tracking, and a 20px bottom gap. Mobile hero intro copy uses 16px/23.2px. Problem and workflow headings have 40px and 48px gaps before their rows. The mobile footer uses 12px logo-to-description and description-to-copyright gaps, with zero paragraph margins.
- The public header has the reference sticky Ink backdrop and blur. The compact Menu control is at least 44px high and opens a full-width Ink panel below the 72px header, with 12px/16px/24px padding and four 52px ruled rows. The hamburger becomes an X, `aria-expanded` follows the native disclosure state, and scroll lock applies only while a public menu is open. Link selection, outside clicks, and resizing above 820px close it. Escape closes it and restores summary focus without rerendering the auth form or losing field drafts. Signed-in rendering removes the menu state and scroll lock. Secondary public buttons retain a visible keyboard focus ring.
- The four primary links lead to The work, How it works, Surfaces, and Handbooks. Conditional setup/retry controls remain quiet footer utilities. Recover access appears only inside the passkey sign-in card, after the primary Continue with passkey and secondary Back actions. It is an underlined tertiary text action with the existing visible keyboard focus and a 48px target. Selecting a compact-menu link closes the menu. Auth-page home links use the existing validated initiating root. Passkey ceremonies, recovery acknowledgement, and session/origin semantics remain unchanged.

## Resource model

- A project is the board.
- Projects contain ordered columns and cards.
- Cards contain comments. Projects have Activity, and an Activity entry may reference a Card.
- The browser and skill use the same `/api/projects` resources.
- Project updates send `X-Kanban-Version` with the project revision.
- Card updates send `X-Kanban-Version` with the card version.
- Resource creates send an operation-scoped `Idempotency-Key`. An unconfirmed retry reuses the same key and payload; changing that payload requires an explicit separate-attempt decision.
- Removing a card means setting `archivedAt`; the UI does not issue destructive deletes.

## Project workspace

- Product identity uses the complete outlined canonical lockup from `brand/split-k/lockups/`. A local picture source selects the reversed artwork in dark mode and exposes one `kanban.cards` image label. Scale the whole SVG uniformly; keep Project selection and the account trigger visible at narrow widths.
- Browser, touch, installed-app, maskable, and sharing identity use the approved resources documented in `brand/split-k/web/README.md`. Static and fallback HTML expose matching fixed public metadata. The public asset allowlist permits exact GET and HEAD paths; no owner or Workspace data belongs in a manifest or sharing card.
- The header contains product identity, the compact Project selector, and an avatar trigger. The avatar opens a plain panel containing the session username and Sign out.
- The client does not repeat the active Project name, description, recency, environment label, or routine workspace-opened receipt in a second context bar.
- New Project, New Card, Edit Project, and Refresh live in one Actions panel at the top right of the Kanban surface. Add Column is a direct board action: it is the final lane control on desktop and a visible board-local control above the active Column on narrow screens.
- Refresh preserves the active Project, selected Card, and valid draft when those resources still exist. Routine successful confirmations use the single transient notice region; only an outcome that requires attention remains persistent on the surface.
- New Projects start with exactly three ordered Columns: Next, Doing, and Done.
- Existing Projects are lossless. If the API returns additional Columns, the browser renders and edits every stored Column in order and preserves stable Column ids and Card placement. It must never silently truncate existing Columns to the three new-Project defaults.
- Project editing covers name, description, and one individually labeled field for every stored Column.
- Add Column expands in place on the board and keeps the stored Columns visible. It retains any visible Card draft locally and locks conflicting controls, then reads the complete latest Project before opening a focused, labeled form with one required Column name. It appends one collision-resistant stable id after the complete stored Column list, sends that current Project revision, and does not expose reorder or removal behavior. Cancel makes no request and restores the direct board trigger, or the visible Card field when a narrow-screen Card context has replaced the board. Success applies the write response before Refresh, selects and focuses the new Column, and keeps it visible as the active narrow-screen Column. A stale or unconfirmed response retains the entered name and never overwrites newer Project state.
- While Project editing or Add Column is open, Project switching, Project creation, Refresh, product navigation, and every other conflicting action remain unavailable until Save or Cancel.
- Cancel preserves the stored Project and restores focus. Save updates every visible occurrence of the Project and Column names.

## Card workspace

- Board Cards expose title, a short plain-text summary derived from the safe Markdown representation when present, Comment count, and recency. Markdown punctuation and rendered HTML do not appear as summary chrome.
- Cards optionally store `nextActor` (`human`, `agent`, or `null`), `nextAction` (text), `priority` (`High`, `Medium`, `Low`, or `null`), and `blockedReason` (text). The editor labels these Next actor, Next action, Priority, and Blocker; unset choices are Unassigned and Unset. Board Cards show restrained metadata and a bounded next-action preview. These fields do not change Column state or grant authority.
- Board filters combine Next actor, Priority, and Blocked with AND. Counts report matching and total active Cards, empty results are explicit, and Clear filters resets all three. Filters use the complete Project snapshot, remain per Project for the current page session, wrap on narrow screens, and clear on sign-out.
- Saving a selected Card that no longer matches filters keeps the Card and any retained draft open with an explanatory note. Closing or Undo returns focus to the source Card when visible, otherwise its visible Column heading. Filtering never removes hidden Cards from the loaded Project data.
- Column placement communicates Card state; the Card does not repeat state decoration without a separate need.
- Card detail is not rendered until a Card is selected or created. The open inspector is full height, closes with an X, and contains no visible context eyebrow, Card-detail heading, inspector Refresh, or empty selection prompt.
- Opening a Card presents editable fields with explicit Save and Revert actions. Typing and blur retain changes locally; only Save writes Card text to the server. Description preserves raw Markdown in the existing Card `body` field. Column placement uses the separate Move command; new Cards retain an explicit Create action.
- The four optional Card fields participate in creation and explicit Save, durable draft retention, and field reconciliation. Move and archive operations preserve their values.
- Description contains a nested automatic `Description view` tablist with Write and Preview. Write is the default, the native textarea remains mounted and authoritative, and Preview renders the current draft without waiting for or initiating a save. New Cards can preview before Create. The selected description view survives Card/Activity switching for the same Card and resets to Write when Card context changes.
- The supported Markdown subset is paragraphs, scoped headings, emphasis, ordered and unordered lists, blockquotes, absolute `http:`, `https:`, and `mailto:` links, inline code, fenced code, and horizontal rules. Raw HTML renders literally. Images, tables, embeds, forms, media, interactive task controls, syntax highlighting, relative links, and unsafe protocols do not render. Safe links open in a new tab with `noopener noreferrer` and expose that behavior in their accessible name.
- Preview uses semantic passive markup from a safe-by-default parser plus an explicit element, attribute, and URL boundary. It never stores HTML or loads remote images. Empty Preview says `Nothing to preview.` A parser failure shows escaped plain text and `Preview unavailable` without changing the source.
- Existing Cards expose a visible `Move…` disclosure in the sticky selected-Card toolbar from both Card and Activity tabs. Its trigger has `aria-expanded` and `aria-controls`; the disclosed region names the current Column and uses native buttons named `Move to <Column>` for every other Column.
- The Move disclosure is the canonical desktop, narrow-screen, keyboard, touch, and assistive-technology path. The client must not add drag-and-drop, a board-Card overflow move action, a custom menu role, or a persistent selected-Card Column selector.
- Escape or Cancel closes an open Move disclosure and restores focus to `Move…`. The destination list scrolls within the viewport when a stored Project has many Columns. A successful move keeps Card detail open, moves the board Card from the write response, changes the narrow-screen active Column and close label to the destination, refreshes Activity, announces a destination-specific receipt, and returns Close focus to the moved board Card.
- New Card forms expose a labeled, create-only `Create in` select before the Create action. Desktop entry defaults visibly to the first ordered Column; narrow and Column-local entry default to the visible or launch Column. Validation preserves the chosen destination while Close continues to name and restore the launch Column until creation commits.
- Movement reserves the global mutation lock and retains dirty text locally. It sends only `columnId` with the current Card version. A move-time `409` or `412` retains the requested destination and offers destination-specific Retry or Cancel after loading the latest Card. Conflict recovery stays on the Card tab. Text Save never sends placement; a later Save cannot move a Card back to an older destination.
- Comments are the primary Card context immediately after the editor. Their heading has no count or eyebrow, and an empty list adds no explanatory sentence or attribution disclaimer.
- Activity is a separate top-level tab filtered to the selected Card. Entries show the change, the stored actor name as `By <name>`, and the time. Actor names are escaped as plain text; entries omit channel and caller-label explanations.
- Successful create, edit, move, or Comment updates the visible Card, its board summary or placement, counts, and Card-specific Activity before one secondary transient confirmation appears. The latest confirmation replaces the prior one, does not take focus, and clears after approximately five seconds.
- A successful write and its follow-up Refresh are separate outcomes. If the write commits but Refresh fails, the returned resource remains visibly applied and the UI says Refresh is incomplete; it must not report that the write failed or repeat the write to reconcile.
- Unsaved drafts are retained across Card switching, Project switching, Close, and relaunch until Save is confirmed or the user explicitly reverts them. Draft scope includes owner, exact origin, Workspace, Project, and resource. Sign out and expiry hide private drafts immediately while retaining same-owner recovery. Close acknowledges retention in the transient notice region; the affected board Card keeps a visible `Draft retained` cue after that notice expires, and reopening places the recovery note inline with the restored fields rather than in a top-of-surface banner.
- Returning every field to its stored value deletes an obsolete retained draft. A confirmed Save or explicit Revert clears the relevant draft. Failed persistence remains visible with local Retry and Copy recovery actions; memory-only text cannot survive process termination.
- Adding a Comment must not replace an unsaved title, body, or Column draft.
- Save compares baseline, local draft, and the latest stored fields. Untouched fields adopt newer values; fields changed differently in both places require an explicit choice. A Comment-only version increment does not create a text conflict. Ambiguous PATCH outcomes use readback before retry; matching values do not prove the original request succeeded. Unconfirmed POST operations preserve their exact payload and idempotency key.
- During a version conflict, Archive cannot bypass recovery. The complete draft and newer stored Card remain visible, with per-field choices and explicit Revert.
- Archive remains non-destructive. The Card leaves the active board, while its named receipt and Undo persist through Project navigation until recovery.

## Authentication boundary

- The static shell and dedicated sign-in surface render without authenticated Project data.
- A signed-out application root offers `Create account` and `Sign in`. The passkey sign-in card offers `Recover access`; it returns through the validated initiating root, where only an anonymous root consumes the fixed `access=recover` navigation request and starts the existing same-origin, browser-bound intent flow. The request is removed from history before that transition. A configured, unclaimed existing account also offers `Set up existing account` on the root.
- `Create account` creates a private Workspace and owner together after a verified passkey registration. Signup collects the Workspace name and address and an optional display name. Sign-in uses a discoverable passkey without an email requirement.
- Authentication ceremonies run only on the exact dedicated auth host, using the auth host as the WebAuthn relying party. The browser begins at an authorized application root, posts to `/api/auth-start`, and immediately form-posts the returned intent token, browser nonce, and exact root origin to the configured `/api/passkeys/start`. Secrets never enter URLs or browser storage.
- The auth host trusts only the server-verified auth intent from `/api/session`. Direct navigation without an intent offers a return to the app root. No Workspace, Project, or app-session data API is available on the auth host.
- Registration and authentication use the supported SimpleWebAuthn browser API. The client requests options from `/api/passkeys/options`, completes the device ceremony, and posts its response and challenge id to `/api/passkeys/verify`. Cancellation leaves a retryable public form. Setup and recovery credentials leave the form before the device ceremony and are never persisted.
- The server verifies challenges, auth-host origin, relying party, user verification, credential ownership, and session binding. A credential authenticates only its durable owner ID. Email, request-supplied owner ids, and tenant selectors never authorize access.
- A successful auth response returns a single-use handoff token and exact initiating root destination. The client validates the destination and immediately hidden-form-posts the token to that root's `/api/auth-handoff`; it never places the token in a URL, logs, public content, or storage.
- Signup, initial setup, and recovery display a new recovery code once, with Copy and Download actions. Continuing requires an explicit `I saved my recovery code` action. Recovery replaces the passkey and rotates the recovery code. Lost passkeys and a lost recovery code cannot be recovered through unverified email or identity claims.
- Root and tenant sessions use separate host-only HttpOnly cookies. Root access lists only the owner's Workspaces. Zero Workspaces renders creation, one opens directly, and many render a chooser. The automatic one-Workspace handoff keeps the root on its private-free opening state until navigation commits.
- Workspace handoffs validate the exact selected tenant destination and transport their single-use tokens through immediately removed hidden form POSTs. Root and tenant cookies cannot authorize other tenants.
- Signed-in owners can manage passkeys and browser sessions, add a passkey, replace their recovery code, and sign out everywhere. Removing passkeys, replacing recovery codes, and issuing API keys require recent passkey verification. Protected tenant actions return through the exact family root. Only nonsecret pending UI preferences may survive that navigation in session storage.
- Agent API keys are shown once, stored server-side only as hashes, bound to one owner and Workspace, explicitly scoped, and individually revocable. API keys never enter browser storage or URLs. The browser renders a fresh-verification action when issuing a key requires a new passkey ceremony.
- Logging out calls `DELETE /api/session` to revoke the browser session family. A failure never claims success and offers Retry. The client clears pending and retained drafts, Card fields, selected Card, mobile Column context, receipts, transient confirmation content and timers, focus-return state, secrets, and pending UI preferences.
- Successful sign-out displays a private-free persistent `Signed out` receipt with one `Continue` action at the application root. A query hint can select this public receipt only when the server reports no authenticated session; it never revokes sessions or authenticates a user.
- Re-authentication never restores a pre-signout draft or selection. An API `401` after authentication clears the same private state before returning to sign-in. Opening, invalid access, session expiry, and service failure expose no private Project or Card content.
- Local development owner-key access remains an explicit development fallback. Its submitted key is exchanged once for an expiring browser session and never retained by the client.

## Form primitives

Raw `input`, `select`, and `textarea` markup in the production client renderer is allowed only inside:

- `renderTextInput`
- `renderTextArea`
- `renderSelect`

Every control uses `.form-control`; selects also use `.select-control`. Fallback markup in `index.html` must not collect credentials or authenticated data.

## Visual and accessibility source boundary

- Production imports the pinned JudgmentKit `judgmentkit_default` Workbench source from `judgmentkit.css` before application styles.
- `judgmentkit.css` is the only client stylesheet allowed to declare `--jk-*` tokens. `styles.css` consumes those canonical roles and must not redeclare them or create local lookalike tokens.
- Workbench application styles must not introduce literal colors, literal shadows, local or remote fonts, external assets, or unknown `--jk-*` roles. The separate public `website.css` allowance above uses the approved Surfaces website palette and local Inter font only under the public marker. Remote font loading remains prohibited. System and forced-color keywords remain valid where the platform requires them.
- Dynamic loading, Refresh, create progress, failure, stale recovery, archive, Undo, and Sign out are programmatic status messages. Routine successful Project, Card, Move, Comment, restore, discard, Refresh, and draft-retention confirmations use the single polite, atomic `#toast-region` without moving focus; each composes the JudgmentKit receipt-status anatomy and its non-color marker, the latest replaces the prior confirmation, and it clears after approximately five seconds. The changed resource remains the primary confirmation. A transient receipt must not cover Archive or sticky Card controls. Routine Save success is announced without adding visible persistent chrome. Errors, warnings, unconfirmed outcomes, conflicts, archived-draft recovery, archive Undo, and Sign out remain in their affected surface until resolved or superseded.
- Visible controls have accessible names. Fields have programmatic labels, and validation errors use `aria-invalid` plus referenced error text.
- Keyboard focus follows visible task order, remains visible, restores after Close, Back, Move Cancel, or Escape, and is not covered by sticky actions or the responsive Move disclosure.
- Long Project names, Column names, Card titles, descriptions, Markdown prose and links, Comments, and Activity wrap without covering controls or creating document-width overflow. Fenced code scrolls within its own block.

## Simplicity boundary

The primary client must not introduce teams, memberships, roles, agent identities, delegated sessions, capabilities, gates, approvals, delivery state, AI flow generation, or templates. Those concepts are intentionally outside V2.

## Required states

Production behavior accounts for Opening, Signed out, Access not available, Invalid key, Empty workspace, Empty Project, Populated Project, on-demand Card detail, explicit Save, retained drafts, field reconciliation, Activity tab, Refresh progress, Refresh success, Refresh failure, create Saving, Validation error, Version conflict, Session expired, Service unavailable, Archived, Sign out progress, and Sign out success. The browser gate reaches these states through isolated real client/API flows or narrowly scoped deterministic test-server responses.

Prototype `?state=` shortcuts are design evidence only. Production verification must reach these states through the real client state and API boundary or through deterministic test-server responses.

## Verification

Client completion requires all three layers:

1. **Static contract:** `npx tsx scripts/check-ui-contract.ts` checks source, token provenance, security, action-handler, resource-header, and semantic-structure boundaries.
2. **Runtime contract:** Node tests cover API/resource behavior, including version concurrency, exact new-Project defaults, and archive/Undo resource recovery.
3. **Browser contract:** automated Chromium verification uses a CDP virtual authenticator with resident credentials and user verification against the real SimpleWebAuthn client and server. It exercises one-time enrollment of the existing owner with preserved board data, independent owner signup and tenant isolation, one-time recovery-code acknowledgement, passkey sign-in, browser-family sign-out, recovery with a lost credential and code rotation, stale-owner verification before API key issuance, stale verification before adding a second passkey, passkey removal, recovery-code replacement, and scoped API key creation and revocation. Browser credentials are scoped to a shared local hostname family so cookie and cross-host form behavior match production. This proves real browser WebAuthn ceremonies with a virtual device; it does not prove a physical device, synced password manager, deployed HTTPS origins, production database, or live owner enrollment. The existing board suites retain Card detail, Markdown safety and explicit Save, Move recovery and responsive focus, archive/Undo, lossless Column editing, stale recovery, Project switching, private-state clearing, API failure states, and the isolated skill/browser reconciliation loop. Responsive board coverage includes `1440 × 1000`, `1440 × 600`, `1024 × 800`, `800 × 900`, `390 × 844`, and `320 × 720` against temporary servers and stores.


For client changes, run at minimum:

- `npm run build:client`
- `npx tsc -p tsconfig.client.json --noEmit`
- `npx tsx scripts/check-ui-contract.ts`
- the client runtime tests
- the production browser suite

The current browser contract verifies rendered structure, movement and creation placement, committed-resource recovery, lifecycle states, mutation locks, reconciliation, responsive transformation, private-content absence, document-width overflow, focus, accessible names and states, and console errors in those scenarios. Automated semantics and keyboard evidence do not substitute for spoken assistive-technology verification. Direct spoken verification against production later captured actual VoiceOver system audio after the Mac was unlocked. The critical-path announcements and focus behavior matched the expected contract, so spoken VoiceOver output is verified for that tested production path. Prototype control counts and pixel matching are not production acceptance criteria.
