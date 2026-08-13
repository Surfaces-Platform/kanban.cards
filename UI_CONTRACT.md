# kanban.cards V2 UI Contract

[`DESIGN.md`](DESIGN.md) governs visual, interaction, responsive, accessibility, and content-design decisions. This file records testable constraints in the current client. It must follow the governing design rather than preserve an implementation choice after the design changes.

The browser is a visual surface over the same project API used by `$kanban-cards`. It does not maintain a separate workspace document or model agents inside the product.

## Accepted interface direction

Context Dock is the only production interface direction.

- The ordered Column grid uses the full Kanban surface until a Card is opened. On desktop, Card detail then becomes a full-height, nonmodal right dock.
- Card detail must not use dialog or `aria-modal` semantics, inert the board, or hide Project context.
- On narrow screens, the Project shows one explicitly named Column at a time through a selector that includes its Card count.
- A selected Card becomes a dedicated narrow-screen task view with an X whose accessible name identifies the return Column.
- Closing returns to the originating Column unless the Card moved while open. After a move, it returns to the destination Column and restores the moved Card, selection, and keyboard focus.
- Focus Workspace remains comparison evidence. It must not ship as a second product mode.

The client has provider sign-in, zero/one/many Workspace routing, Project selection and empty state, the Project workspace, and Card detail and editing. Local development may show the access-key fallback when provider auth is absent. Their structure must follow this accepted direction without introducing a second product model.

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

- The header contains product identity, the compact Project selector, and an avatar trigger. The avatar opens a plain panel containing the session username and Sign out.
- The client does not repeat the active Project name, description, recency, environment label, or routine workspace-opened receipt in a second context bar.
- New Project, New Card, Edit Project, and Refresh live in one Actions panel at the top right of the Kanban surface.
- Refresh preserves the active Project, selected Card, and valid draft when those resources still exist. Routine successful confirmations use the single transient notice region; only an outcome that requires attention remains persistent on the surface.
- New Projects start with exactly three ordered Columns: Next, Doing, and Done.
- Existing Projects are lossless. If the API returns additional Columns, the browser renders and edits every stored Column in order and preserves stable Column ids and Card placement. It must never silently truncate existing Columns to the three new-Project defaults.
- Project editing covers name, description, and one individually labeled field for every stored Column.
- While Project editing is open, Project switching, Project creation, Refresh, product navigation, and every other conflicting action remain unavailable until Save or Cancel.
- Cancel preserves the stored Project and restores focus. Save updates every visible occurrence of the Project and Column names.

## Card workspace

- Board Cards expose title, a short plain-text summary derived from the safe Markdown representation when present, Comment count, and recency. Markdown punctuation and rendered HTML do not appear as summary chrome.
- Column placement communicates Card state; the Card does not repeat state decoration without a separate need.
- Card detail is not rendered until a Card is selected or created. The open inspector is full height, closes with an X, and contains no visible context eyebrow, Card-detail heading, inspector Refresh, or empty selection prompt.
- Existing Card Title and Description are surface-integrated controls that autosave serially on blur. Description persists raw Markdown in the existing Card `body` field. The inspector has no selected-Card Save action and no Column selector; new Cards retain an explicit Create action.
- Description contains a nested automatic `Description view` tablist with Write and Preview. Write is the default, the native textarea remains mounted and authoritative, and Preview renders the current draft without waiting for or initiating a save. New Cards can preview before Create. The selected description view survives Card/Activity switching for the same Card and resets to Write when Card context changes.
- The supported Markdown subset is paragraphs, scoped headings, emphasis, ordered and unordered lists, blockquotes, absolute `http:`, `https:`, and `mailto:` links, inline code, fenced code, and horizontal rules. Raw HTML renders literally. Images, tables, embeds, forms, media, interactive task controls, syntax highlighting, relative links, and unsafe protocols do not render. Safe links open in a new tab with `noopener noreferrer` and expose that behavior in their accessible name.
- Preview uses semantic passive markup from a safe-by-default parser plus an explicit element, attribute, and URL boundary. It never stores HTML or loads remote images. Empty Preview says `Nothing to preview.` A parser failure shows escaped plain text and `Preview unavailable` without changing the source.
- Existing Cards expose a visible `Move…` disclosure in the sticky selected-Card toolbar from both Card and Activity tabs. Its trigger has `aria-expanded` and `aria-controls`; the disclosed region names the current Column and uses native buttons named `Move to <Column>` for every other Column.
- The Move disclosure is the canonical desktop, narrow-screen, keyboard, touch, and assistive-technology path. The client must not add drag-and-drop, a board-Card overflow move action, a custom menu role, or a persistent selected-Card Column selector.
- Escape or Cancel closes an open Move disclosure and restores focus to `Move…`. The destination list scrolls within the viewport when a stored Project has many Columns. A successful move keeps Card detail open, moves the board Card from the write response, changes the narrow-screen active Column and close label to the destination, refreshes Activity, announces a destination-specific receipt, and returns Close focus to the moved board Card.
- New Card forms expose a labeled, create-only `Create in` select before the Create action. Desktop entry defaults visibly to the first ordered Column; narrow and Column-local entry default to the visible or launch Column. Validation preserves the chosen destination while Close continues to name and restore the launch Column until creation commits.
- Movement reserves the global mutation lock, waits for serialized blur autosaves, and proceeds only after pending Card changes save successfully. It sends only `columnId` with the latest Card version. A failed or invalid autosave keeps the draft visible and blocks movement; a move-time `409` or `412` retains the requested destination and offers destination-specific Retry or Cancel after loading the latest Card. Conflict recovery stays on the Card tab and the retry must not overwrite title or Body.
- Comments are the primary Card context immediately after the editor. Their heading has no count or eyebrow, and an empty list adds no explanatory sentence or attribution disclaimer.
- Activity is a separate top-level tab filtered to the selected Card. Entries show the change and time without channel or caller-label explanation.
- Successful create, edit, move, or Comment updates the visible Card, its board summary or placement, counts, and Card-specific Activity before one secondary transient confirmation appears. The latest confirmation replaces the prior one, does not take focus, and clears after approximately five seconds.
- A successful write and its follow-up Refresh are separate outcomes. If the write commits but Refresh fails, the returned resource remains visibly applied and the UI says Refresh is incomplete; it must not report that the write failed or repeat the write to reconcile.
- Unsaved drafts are retained per Card across Card switching, Project switching, and Close until blur autosave is confirmed or the user explicitly discards the draft. Close acknowledges retention in the transient notice region; the affected board Card keeps a visible `Draft retained` cue after that notice expires, and reopening places the recovery note inline with the restored fields rather than in a top-of-surface banner.
- Returning every field to its stored value deletes an obsolete retained draft. A successful blur save or explicit Discard also clears the relevant draft.
- Adding a Comment must not replace an unsaved title, body, or Column draft.
- Blur saves are serialized per Card so rapid Title and Body changes use the latest returned version. Mutations that depend on Card version wait for pending blur saves.
- During a version conflict, Archive cannot bypass recovery. The complete draft and newer stored Card remain visible, with explicit Retry and Discard resolution.
- Archive remains non-destructive. The Card leaves the active board, while its named receipt and Undo persist through Project navigation until recovery.

## Authentication boundary

- The static shell and sign-in surface render without authenticated project data.
- Production redirects from the exact root `/auth/login` route into provider-verified OIDC with PKCE, state, nonce, issuer, audience, verified-email, and explicit `kanban.cards` surface checks.
- Root and tenant sessions are separate signed, expiring, host-only HttpOnly cookies. A root session lists only Workspaces owned by its verified subject. A tenant cookie works only at its exact Workspace host.
- Zero Workspaces renders creation, one opens directly, and many render a chooser. The tenant handoff uses an exact-origin, cross-host form POST; its hashed, single-use token exists only in the root response, an immediately removed hidden form control, and the exact-destination POST body. It never enters a URL, rendered content, or persistent browser storage.
- A host/session or the server-bound compatibility bearer selects Workspace context. Body, query, and header tenant selectors are rejected.
- Provider secrets and the compatibility bearer must never be stored in local storage, session storage, markup, URLs, logs, or a client global. The handoff token is limited to the transient POST transport above and is not retained. The local fallback key is submitted once to `POST /api/session` only when provider auth is absent.
- Sign-out clears private UI and the current host cookie before durable session-family revocation. A revocation-store failure must show an incomplete-global-sign-out error and never render the successful `Signed out` state. The current host may retain only a short-lived, signed, non-authorizing family-revocation handle. A tenant retry repeats `DELETE /api/session` on that tenant before navigating to root logout; the root recovery marker is removed from the URL on load, and retry remains available after recovery.
- Logging out calls `DELETE /api/session` and clears pending and retained drafts, Card fields, selected Card, mobile Column context, receipts, transient-confirmation content and timers, focus-return state, and pending client operations.
- Sign out displays a persistent textual completion status and focuses the provider sign-in action, or the empty owner-key field in local fallback mode.
- Re-authentication must not restore a pre-signout draft or selection.
- An API `401` after authentication applies the same private-state clearing behavior as Sign out before returning to sign-in.
- Opening, invalid access, session expiry, service failure, and Sign out expose no private Project or Card content.

## Form primitives

Raw `input`, `select`, and `textarea` markup in the production client renderer is allowed only inside:

- `renderTextInput`
- `renderTextArea`
- `renderSelect`

Every control uses `.form-control`; selects also use `.select-control`. Fallback markup in `index.html` must not collect credentials or authenticated data.

## Visual and accessibility source boundary

- Production imports the pinned JudgmentKit `judgmentkit_default` Workbench source from `judgmentkit.css` before application styles.
- `judgmentkit.css` is the only client stylesheet allowed to declare `--jk-*` tokens. `styles.css` consumes those canonical roles and must not redeclare them or create local lookalike tokens.
- Application styles must not introduce literal colors, literal shadows, local or remote fonts, external assets, or unknown `--jk-*` roles. System and forced-color keywords remain valid where the platform requires them.
- Dynamic loading, Refresh, create progress, failure, stale recovery, archive, Undo, and Sign out are programmatic status messages. Routine successful Project, Card, Move, Comment, restore, discard, Refresh, and draft-retention confirmations use the single polite, atomic `#toast-region` without moving focus; each composes the JudgmentKit receipt-status anatomy and its non-color marker, the latest replaces the prior confirmation, and it clears after approximately five seconds. The changed resource remains the primary confirmation. A transient receipt must not cover Archive or sticky Card controls. Routine blur-save success is announced without adding visible persistent chrome. Errors, warnings, unconfirmed outcomes, conflicts, archived-draft recovery, archive Undo, and Sign out remain in their affected surface until resolved or superseded.
- Visible controls have accessible names. Fields have programmatic labels, and validation errors use `aria-invalid` plus referenced error text.
- Keyboard focus follows visible task order, remains visible, restores after Close, Back, Move Cancel, or Escape, and is not covered by sticky actions or the responsive Move disclosure.
- Long Project names, Column names, Card titles, descriptions, Markdown prose and links, Comments, and Activity wrap without covering controls or creating document-width overflow. Fenced code scrolls within its own block.

## Simplicity boundary

The primary client must not introduce teams, memberships, roles, agent identities, delegated sessions, capabilities, gates, approvals, delivery state, AI flow generation, or templates. Those concepts are intentionally outside V2.

## Required states

Production behavior accounts for Opening, Signed out, Invalid key, Empty workspace, Empty Project, Populated Project, on-demand Card detail, blur autosave, Activity tab, Refresh progress, Refresh success, Refresh failure, create Saving, Validation error, Version conflict, Session expired, Service unavailable, Archived, and Sign out success. The browser gate reaches these states through isolated real client/API flows or narrowly scoped deterministic test-server responses.

Prototype `?state=` shortcuts are design evidence only. Production verification must reach these states through the real client state and API boundary or through deterministic test-server responses.

## Verification

Client completion requires all three layers:

1. **Static contract:** `npx tsx scripts/check-ui-contract.ts` checks source, token provenance, security, action-handler, resource-header, and semantic-structure boundaries.
2. **Runtime contract:** Node tests cover API/resource behavior, including version concurrency, exact new-Project defaults, and archive/Undo resource recovery.
3. **Browser contract:** automated real-browser verification exercises on-demand Card detail; Markdown Write/Preview safety, semantics, source preservation, autosave, summary derivation, and narrow-screen containment; the explicit desktop and narrow-screen Move disclosure; delayed-autosave mutation reservation and focus; many-Column destination reachability; destination-specific move conflict recovery; concurrent archive handling; committed-move Refresh failure; visible create-only destination selection and launch-context return; stale Retry and Discard; archive and Undo; Project create/edit/switch focus; invalid access; empty workspace and Project; create validation and duplicate locks; Refresh failure retention; real session expiry; boot unavailability; Sign out clearing; and the isolated skill/browser reconciliation loop. Responsive coverage includes `1440 × 1000`, `1440 × 600`, `1024 × 800`, `800 × 900`, `390 × 844`, and `320 × 720` against temporary servers and stores.

For client changes, run at minimum:

- `npm run build:client`
- `npx tsc -p tsconfig.client.json --noEmit`
- `npx tsx scripts/check-ui-contract.ts`
- the client runtime tests
- the production browser suite

The current browser contract verifies rendered structure, movement and creation placement, committed-resource recovery, lifecycle states, mutation locks, reconciliation, responsive transformation, private-content absence, document-width overflow, focus, accessible names and states, and console errors in those scenarios. Automated semantics and keyboard evidence do not substitute for spoken assistive-technology verification. Direct spoken verification against production later captured actual VoiceOver system audio after the Mac was unlocked. The critical-path announcements and focus behavior matched the expected contract, so spoken VoiceOver output is verified for that tested production path. Prototype control counts and pixel matching are not production acceptance criteria.
