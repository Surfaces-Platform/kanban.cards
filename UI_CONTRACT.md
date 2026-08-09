# kanban.cards V2 UI Contract

[`DESIGN.md`](DESIGN.md) governs visual, interaction, responsive, accessibility, and content-design decisions. This file records testable constraints in the current client. It must follow the governing design rather than preserve an implementation choice after the design changes.

The browser is a visual surface over the same project API used by `$kanban-cards`. It does not maintain a separate workspace document or model agents inside the product.

## Accepted interface direction

Context Dock is the only production interface direction.

- The ordered Column grid uses the full Kanban surface until a Card is opened. On desktop, Card detail then becomes a full-height, nonmodal right dock.
- Card detail must not use dialog or `aria-modal` semantics, inert the board, or hide Project context.
- On narrow screens, the Project shows one explicitly named Column at a time through a selector that includes its Card count.
- A selected Card becomes a dedicated narrow-screen task view with an X whose accessible name identifies the return Column.
- Closing returns to the originating Column and restores Card position, scroll position, selection, and keyboard focus.
- Focus Workspace remains comparison evidence. It must not ship as a second product mode.

The client still has four primary surfaces: access-key sign-in, Project selection and empty state, the Project workspace, and Card detail and editing. Their structure must follow this accepted direction without introducing a second product model.

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
- Refresh preserves the active Project, selected Card, and valid draft when those resources still exist. Only an outcome that requires attention remains persistent on the surface.
- New Projects start with exactly three ordered Columns: Next, Doing, and Done.
- Existing Projects are lossless. If the API returns additional Columns, the browser renders and edits every stored Column in order and preserves stable Column ids and Card placement. It must never silently truncate existing Columns to the three new-Project defaults.
- Project editing covers name, description, and one individually labeled field for every stored Column.
- While Project editing is open, Project switching, Project creation, Refresh, product navigation, and every other conflicting action remain unavailable until Save or Cancel.
- Cancel preserves the stored Project and restores focus. Save updates every visible occurrence of the Project and Column names.

## Card workspace

- Board Cards expose title, a short body-derived summary when present, Comment count, and recency.
- Column placement communicates Card state; the Card does not repeat state decoration without a separate need.
- Card detail is not rendered until a Card is selected or created. The open inspector is full height, closes with an X, and contains no visible context eyebrow, Card-detail heading, inspector Refresh, or empty selection prompt.
- Existing Card Title and Body are surface-integrated controls that autosave serially on blur. The inspector has no selected-Card Save action and no Column selector; new Cards retain an explicit Create action.
- The reviewed slice does not invent a replacement browser move control after removing the inspector Column selector. Skill/API moves reconcile visibly through Refresh. New Cards created from the top-level Actions panel enter the current narrow-screen Column, or the first ordered Column on desktop. A reviewed browser move pattern and a more explicit desktop creation destination remain follow-up design work.
- Comments are the primary Card context immediately after the editor. Their heading has no count or eyebrow, and an empty list adds no explanatory sentence or attribution disclaimer.
- Activity is a separate top-level tab filtered to the selected Card. Entries show the change and time without channel or caller-label explanation.
- Successful create, edit, move, or Comment updates the visible Card, its board summary or placement, counts, and Card-specific Activity before a secondary receipt appears.
- A successful write and its follow-up Refresh are separate outcomes. If the write commits but Refresh fails, the returned resource remains visibly applied and the UI says Refresh is incomplete; it must not report that the write failed or repeat the write to reconcile.
- Unsaved drafts are retained per Card across Card switching, Project switching, and Close until blur autosave is confirmed or the user explicitly discards the draft.
- Returning every field to its stored value deletes an obsolete retained draft. A successful blur save or explicit Discard also clears the relevant draft.
- Adding a Comment must not replace an unsaved title, body, or Column draft.
- Blur saves are serialized per Card so rapid Title and Body changes use the latest returned version. Mutations that depend on Card version wait for pending blur saves.
- During a version conflict, Archive cannot bypass recovery. The complete draft and newer stored Card remain visible, with explicit Retry and Discard resolution.
- Archive remains non-destructive. The Card leaves the active board, while its named receipt and Undo persist through Project navigation until recovery.

## Authentication boundary

- The static shell and sign-in surface render without authenticated project data.
- The access key is submitted once to `POST /api/session`.
- The browser relies on the resulting secure, HttpOnly cookie.
- The access key must never be stored in local storage, session storage, markup, logs, or a client global.
- Logging out calls `DELETE /api/session` and clears pending and retained drafts, Card fields, selected Card, mobile Column context, receipts, focus-return state, and pending client operations.
- Sign out displays a persistent textual completion status and focuses an empty owner-key field.
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
- Dynamic loading, Refresh, create progress, failure, stale recovery, archive, Undo, and Sign out are programmatic status messages. Routine blur-save success is announced without adding persistent explanatory chrome.
- Visible controls have accessible names. Fields have programmatic labels, and validation errors use `aria-invalid` plus referenced error text.
- Keyboard focus follows visible task order, remains visible, restores after Close, Back, or Cancel, and is not covered by sticky actions.
- Long Project names, Column names, Card titles, bodies, Comments, and Activity wrap without covering controls or creating document-width overflow.

## Simplicity boundary

The primary client must not introduce teams, memberships, roles, agent identities, delegated sessions, capabilities, gates, approvals, delivery state, AI flow generation, or templates. Those concepts are intentionally outside V2.

## Required states

Production behavior accounts for Opening, Signed out, Invalid key, Empty workspace, Empty Project, Populated Project, on-demand Card detail, blur autosave, Activity tab, Refresh progress, Refresh success, Refresh failure, create Saving, Validation error, Version conflict, Session expired, Service unavailable, Archived, and Sign out success. The automated browser gate covers the deterministic subset listed below; the remaining states must not be represented as browser-automated until matching scenarios exist.

Prototype `?state=` shortcuts are design evidence only. Production verification must reach these states through the real client state and API boundary or through deterministic test-server responses.

## Verification

Client completion requires all three layers:

1. **Static contract:** `npx tsx scripts/check-ui-contract.ts` checks source, token provenance, security, action-handler, resource-header, and semantic-structure boundaries.
2. **Runtime contract:** Node tests cover API/resource behavior, including version concurrency, exact new-Project defaults, and archive/Undo resource recovery.
3. **Browser contract:** automated real-browser verification exercises on-demand Card detail, serialized blur autosave, stale Retry and Discard, archive and Undo, Project create/edit/switch focus, deterministic desktop new-Card placement, Sign out clearing, desktop dock reflow, tablet task-view transformation, and narrow-screen transformation against a temporary server and store at `1440 × 1000` and `390 × 844`, with `1024 × 800` dock coverage, `800 × 900` tablet coverage, and `320 × 720` reflow coverage.

For client changes, run at minimum:

- `npm run build:client`
- `npx tsc -p tsconfig.client.json --noEmit`
- `npx tsx scripts/check-ui-contract.ts`
- the client runtime tests
- the production browser suite

The current browser contract verifies rendered structure, on-demand inspector behavior, serialized blur autosave, stale recovery without overwriting a concurrent Column move, durable archive and Undo, Project save/switch focus, Sign out clearing, responsive transformation, private-content absence, document-width overflow, and console errors in those scenarios. A reviewed browser-originated move interaction, a more explicit desktop new-Card destination, and invalid-key, empty-state, Refresh-failure, create-validation/lock, session-expiry, and service-unavailable browser scenarios remain explicit follow-up work; their source and API behavior must not be described as browser-automated. Prototype control counts and pixel matching are not production acceptance criteria.
