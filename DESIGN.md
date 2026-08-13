# kanban.cards Design

## Status and authority

This file is the governing design contract for kanban.cards.

The documents have different jobs:

1. [`docs/product-vision.md`](docs/product-vision.md) defines the product purpose, resource model, and trust boundary.
2. `DESIGN.md` governs the user experience, interaction model, visual direction, responsive behavior, accessibility, and product language.
3. [`UI_CONTRACT.md`](UI_CONTRACT.md) records testable constraints in the current browser implementation. It must follow this file and change when the design changes.
4. [`docs/design-language.md`](docs/design-language.md) is historical research. It is not a specification or acceptance target.

Product scope wins over design preference. This file wins over implementation habit. Historical code, CSS, markup, screenshots, assets, tokens, and layouts are not reusable design inputs for the new interface.

## Design thesis

kanban.cards should make delegated execution easy to start, easy to inspect, and easy to correct.

The skill does most of the operating. The browser turns the shared state into a clear Workspace a person can understand and change. Every design decision should make one of those jobs easier.

## Experience model

The browser and skill are two clients of the same system:

- The skill creates and updates work while acting with the owner's authority.
- The browser shows the current state, provides direct editing, and helps the owner catch drift.
- A Project is the board. Columns express state. Cards carry the work. Comments and Activity preserve useful context.
- Neither client maintains a second workflow model.

Owners sign in through a provider-verified root experience, then enter one server-authorized Workspace at its canonical host. Zero Workspaces leads to creation, one opens directly, and many require an explicit choice. The skill credential remains a temporary owner-authority compatibility path bound server-side to the migrated Workspace; the next roadmap slice replaces that bridge with a verified agent principal.

The interface should feel like a focused work surface. It should not feel like an administration console for agents, permissions, or workflows.

## Core user jobs

The design must make these jobs straightforward:

1. Enter the workspace safely.
2. Create or select a Project.
3. Scan what is waiting, active, and complete.
4. Create, inspect, edit, move, comment on, and archive a Card.
5. Understand what changed and whether the browser reflects the latest stored state.
6. Reconcile the Project after an agent or person performs work elsewhere.

The agent uses the same resources through the skill. Stable external keys, idempotent requests, and version checks support that workflow without becoming interface concepts the user has to manage.

## Design principles

### Current state comes first

The Project, Columns, Cards, and selected Card should receive the strongest visual attention. Navigation, Project editing, and account controls should stay quiet until needed.

### Context is always clear

The active Project and selected Card must be obvious. Changing Projects should never leave the user wondering which work they are viewing or editing.

### Authority stays simple and honest

A verified owner session grants access only to Workspaces explicitly bound to that provider identity. Within a Workspace, authority remains Workspace-wide. The interface must not imply per-Project permissions, authenticated agent identities, or verified agent authorship that the system does not provide.

Activity may show the client channel and a caller-supplied actor label. The presentation should treat that information as attribution, not identity proof.

### Actions happen near their object

Card actions should be available from the Card or its immediate context. Project actions should live with Project context. Global controls should be limited to truly global jobs.

### Changes are legible and recoverable

The interface should show when a save, move, comment, or archive succeeds. Stale edits, authentication expiry, storage failures, and network failures need specific recovery paths. Archiving should never look like irreversible deletion.

### Density serves scanning

The workspace should show enough work to understand the Project without opening every Card. Card detail can carry longer content and history. Large decorative surfaces should not displace useful state.

### Restraint supports focus

Color, motion, elevation, and illustration should have a job. Use them to communicate action, selection, status, feedback, or hierarchy. Routine work should remain visually quiet.

## A new visual system

The new interface will be designed from the current product model rather than reconstructed from an earlier version.

The intended qualities are:

- calm and precise
- compact enough to scan
- clear about hierarchy and selection
- restrained in color and decoration
- familiar in its controls
- original to the current product

These qualities are outcomes, not inherited tokens. The new system must choose its own palette, type scale, spacing, geometry, elevation, icons, and component treatments through current design work. Historical values should not be copied and renamed.

## Required surfaces

### Sign-in

The production sign-in surface should send the owner through the configured identity provider without collecting credentials in kanban.cards. After sign-in, the root surface creates the first Workspace, opens the sole Workspace, or presents an explicit Workspace chooser. A one-time, exact-host handoff establishes a host-only tenant session without placing its token in a URL. Local development may retain the owner-key form when provider auth is deliberately absent.

### Empty workspace

An empty workspace should explain what a Project represents and offer one clear next action. The user should not have to configure a team, agent, Board, reviewer, gate, or flow first.

### Project workspace

The workspace must show:

- the active Project
- its ordered Columns
- Cards in their current Columns
- a clear way to create work
- visible loading, empty, and failure states

The design may use horizontal lanes, a responsive grid, or another tested construction. No historical layout is mandatory.

### Card detail and editing

Card detail must support title, body, Column, Comments, Activity context, and archive behavior without losing Project context.

The detail surface may be inline, adjacent, overlaid, or navigated. A drawer, inspector, modal, or dedicated view is a decision to make from current workflows and rendered prototypes. No previous implementation decides it automatically.

### Project creation and editing

Project creation should ask only for information needed to begin. Default Columns should make a new Project immediately useful. Project editing covers the resource itself—its name, description, and ordered Columns—without becoming a catch-all administration surface.

## Required states

The design must account for the full workflow, including states that are easy to miss in a polished board mockup.

| State | What the experience must communicate |
| --- | --- |
| Opening | The application is loading without exposing stale private data. |
| Signed out | Provider sign-in opens only Workspaces owned by the verified identity; local fallback states their narrower development boundary. |
| Invalid key | Access was refused; no Project names or content are revealed. |
| Empty workspace | The owner can create a Project or ask the skill to create one. |
| Empty Project | Columns are present and the next Card can be created. |
| Populated Project | Column state and Card identity are easy to scan. |
| Card detail | One Card can be understood and changed without losing Project context. |
| Loading or saving | The affected surface shows progress and prevents duplicate action. |
| Success | The changed resource becomes the primary confirmation; routine completion feedback is secondary and transient. |
| Validation error | The affected field and required correction are clear. |
| Version conflict | Stored state changed elsewhere; the latest version and recovery path are clear. |
| Refresh | The Project can reload without losing valid Project or Card context, and completion is clear. |
| Session expired | Private state leaves the screen and sign-in returns. |
| Service unavailable | The user can distinguish availability failure from invalid access and retry safely. |
| Archived | The Card leaves the active board, remains archived in the Project data, and the result is confirmed. |

## Interaction and system feedback

- Loading should preserve enough structure to show what is being loaded.
- Empty states should name the missing object and the next useful action.
- Save and move feedback should stay close to the changed object.
- A stale-version response should preserve the user's work, explain that the stored Card changed, and offer a path to review and retry.
- Authentication expiry should return the user to sign-in without exposing prior Project data.
- Activity and Comments should remain readable as context, not become a second timeline product.
- The browser should not imply live synchronization. The Project workspace must provide an explicit refresh action, make refresh completion clear, and preserve the active Project and selected Card when they still exist. Skill changes appear after refresh or Project reload until a real synchronization mechanism exists.
- Repeated create requests should resolve quietly when the server identifies the same Card.

## Access and context presentation

The product has provider-verified owners, isolated Workspaces, and one Workspace-wide authority boundary inside each Workspace.

- The account indicator may show the provider-verified display name, but it must not suggest a role system.
- The canonical Workspace host and server-validated session select tenant context. A Project ID, request body, query, or header never selects it.
- The active Project is navigation context, not an authorization scope.
- Repository binding belongs to the skill workflow; the browser does not need to simulate repository permissions.
- API actor labels still should not receive avatars, presence, or identity treatments that imply verification.
- Provider secrets and the compatibility bearer must never appear in client-readable storage, markup, URLs, logs, or screenshots. A handoff token may exist only in the root response, an immediately removed hidden form control, and the exact-destination POST body; it never enters rendered content, persistent browser storage, a URL, a log, or a screenshot. Browser sessions remain only in signed, expiring, host-only HttpOnly cookies.

## Responsive and accessible behavior

The complete workflow must work with keyboard, pointer, touch, and assistive technology.

- Focus order follows the visible task order.
- Focus is always visible.
- Controls have clear names and comfortably usable targets.
- Selection, status, and errors do not rely on color alone.
- Dialogs and overlays, when used, manage focus and expose clear close behavior.
- Dynamic loading, saving, success, and failure states are announced programmatically. Routine successful confirmations may use one polite, non-focus-stealing transient notice because the changed resource remains the primary record. Validation errors are associated with the affected controls, and a temporary notice is never the only accessible record of an important result.
- Board navigation remains understandable at narrow widths without hiding the active Project or Card context.
- Long titles, bodies, comments, and Column names wrap without covering controls.
- Motion respects user preference and never carries required meaning by itself.
- Rendered desktop and mobile states are part of design verification.

## Product language

Use the product's real nouns: Project, Column, Card, Comment, and Activity.

Copy should be short, direct, and specific about the next action. Avoid agent-platform jargon, governance language, and claims about permissions or identity that the system cannot support.

Errors should say what happened, whether the user's work was retained, and what to do next.

## Explicit non-goals

The design should not introduce:

- a separate Board level
- teams, memberships, roles, or per-Project access controls
- modeled agents, delegated sessions, or capability management
- reviewers, approvals, gates, delivery states, templates, or flow generation
- decorative identity systems for actor labels
- dashboards or metrics that do not help the user execute or reconcile work
- reconstructed historical screens, components, tokens, or layouts

## Accepted interface direction

The structural direction is **Context Dock**. The ordered Columns use the whole Kanban surface until a Card is opened. On desktop, Card detail then enters as a nonmodal, full-height work surface from the right while the Project remains available for context. On narrow screens, the Project shows one explicit Column at a time and the Card surface fills the screen.

The alternative **Focus Workspace** remains comparison evidence, not a second product mode. Live design review superseded its persistent `Displayed state` treatment: routine synchronization copy must not occupy the working surface.

### Visual system

- Use JudgmentKit's `judgmentkit_default` source with the `workbench` surface pattern.
- Use the exact `--jk-*` token roles, system typography, and component and pattern contracts; do not recreate the appearance with local lookalike tokens.
- Lucide is the icon authority when an icon materially improves comprehension. Text controls remain valid when an icon would add noise.
- Keep the surface calm, compact, and low-elevation. Selection, focus, validation, stale state, action progress, and receipts are the justified sources of salience.

### Application chrome and Project context

- Place the compact Project selector immediately after the product name in the header. Do not repeat the active Project name, description, or recency in a second context bar.
- Represent the owner with a simple avatar button. Its plain panel contains the username and Sign out; do not expose environment or QA labels in the chrome.
- Put New Project, New Card, Edit Project, and Refresh in one Actions panel at the top right of the Kanban surface. Keep routine success copy off the surface; show persistent status only when the user must act on it.
- New Projects start with exactly three ordered Columns: Next, Doing, and Done. Project editing covers name, description, and every stored Column without truncating additional API-created Columns. Conflicting navigation stays unavailable until Save or Cancel.

### Columns, Cards, and creation

- Desktop uses an ordered Column grid with compact, consistently structured Card summaries: title, a short body-derived summary when present, Comment count, and recency.
- Column placement communicates Card state; do not repeat state decoration without a separate need.
- New Project and New Card actions remain near their resource context and stay reachable in empty, populated, desktop, and narrow-screen states.
- An existing Card has one canonical browser movement path: a visible `Move…` command in the selected-Card toolbar. It opens a named `Move Card` disclosure that states the current Column and presents every other Column as an explicit `Move to <Column>` action.
- The Move disclosure uses ordinary buttons, not menu semantics. It remains the same command on desktop and narrow screens and is the keyboard, touch, and assistive-technology path. This slice does not add drag-and-drop, a board-Card overflow action, or a persistent selected-Card Column field.
- New Card creation shows a labeled `Create in` choice before the Create action. Desktop defaults to the first ordered Column; narrow and Column-local entry default to the visible or launch Column. The choice is creation context, not an editable state field on an existing Card.
- Movement waits for pending title and Body saves, locks conflicting mutations, changes only the destination against the latest Card version, and keeps the Card open. The board, Card Activity, narrow-screen Column, close label, and completion receipt then agree on the destination.
- A move-time version conflict retains only the requested destination. The latest stored Card remains authoritative, and recovery offers an explicit destination-specific Retry or Cancel without replaying title or Body changes.
- A successful create, edit, move, or Comment updates the visible resource and its Card-specific Activity before showing one secondary transient confirmation. The latest confirmation replaces the prior one and leaves without moving focus. Retaining an unsaved Card draft uses the same transient acknowledgement while the affected board Card and reopened editor carry the durable recovery cue instead of a workspace banner.

### Card detail, Comments, and Activity

- Card detail is absent until a Card is selected. It opens from the right as a full-height, wide, nonmodal surface with an X close control; no empty inspector, context eyebrow, detail heading, or inspector Refresh is rendered.
- Title and Description are surface-integrated controls. Description is the dominant object and stores its Markdown source unchanged apart from browser newline normalization in the existing Card `body` field. Existing Cards save title and Description on field blur, without a Save action or an inspector Column selector; new Card creation retains an explicit Create action.
- Description has one local Write/Preview switch inside the Card tab. Write is the default and keeps the native textarea authoritative; Preview renders the current draft without becoming a save action. Switching views preserves the draft, lifecycle, and editing focus. Activity remains the only other top-level Card view.
- The first Markdown slice supports paragraphs, scoped headings, emphasis, ordered and unordered lists, blockquotes, links, inline code, fenced code, and horizontal rules. Raw HTML is shown as text. Images, tables, embeds, interactive task controls, and syntax highlighting do not render. Preview links accept only absolute `http:`, `https:`, and `mailto:` destinations, open separately from the work surface, and identify that behavior accessibly.
- Preview is semantic, passive, and derived at display time; rendered HTML is never stored. The same safe representation supplies plain-text board summaries so Markdown punctuation does not become summary chrome. An empty or failed preview never loses or rewrites the source.
- Comments are primary Card context and follow the editor without a count, conversation eyebrow, empty-state sentence, or caller-attribution disclaimer.
- Activity is Card-specific and appears as a top-level inspector tab. It shows the change and time without channel or caller-label explanation.
- Drafts remain retained until a blur save is confirmed or the user explicitly discards them. A stale conflict exposes the complete draft and newer stored state with Retry and Discard; Archive cannot bypass that recovery.
- Archive remains non-destructive. The Card leaves the active board, and the named receipt and Undo remain available across Project navigation until recovery.

### Narrow screens

- Show one named Column at a time through an explicit selector with its Card count; do not rely on horizontal-swipe discovery.
- A selected Card becomes a dedicated full-screen surface. The visible close control is an X, with an accessible name that identifies the return Column.
- Closing returns to the originating Column unless the Card moved while open; after movement it returns to the destination Column and restores the moved Card, selection, and keyboard focus context.
- Long fields reflow in one dimension, primary actions remain reachable, and sticky actions may not obscure focused controls.

### Decision evidence and implementation boundary

The original direction was selected from matched, interactive desktop and `390 × 844` prototypes. A live interface review on 2026-08-09 then refined the accepted Context Dock: compact header menus, no routine explanatory chrome, an on-demand full-height Card surface, blur autosave, and Activity as a tab. Those direct review decisions supersede contradictory prototype details.

The Card-placement slice was reviewed against actual desktop and `390 × 844` renders of the current Context Dock plus matched renders of three candidates. Desktop keeps the ordered Columns beside the selected Card; narrow screens remove the board while Card detail is open. The visible Card-local `Move…` command was the only candidate that kept one interaction model across both states. A board-Card overflow action hid a core job and crowded summaries, while drag-and-drop still required the same explicit narrow-screen and assistive-technology fallback.

JudgmentKit's Workbench review accepted a `workspace` topology that keeps Card selection, destination choice, and completion evidence adjacent. The implementation contract requires visible decision options, disabled reasons, completion receipts, keyboard/focus evidence, and matched desktop and narrow browser QA. NN/g evidence supports the same boundary: [contextual menus should remain secondary](https://www.nngroup.com/articles/contextual-menus-guidelines/), [accessible drag-and-drop requires a complete keyboard and screen-reader model](https://www.nngroup.com/articles/drag-drop/), [an ellipsis signals that more information is required](https://www.nngroup.com/articles/ui-copy/), and [small bounded option sets benefit from visible comparison](https://www.nngroup.com/articles/dropdown-list/).

The prototypes are design evidence, not production implementation. The implementation change must update `UI_CONTRACT.md` and its automated checks to this accepted direction before the production UI can be called complete.

## Acceptance criteria

A design is ready to implement when:

- a new user can move from sign-in to a useful Project without configuring unrelated concepts
- the active Project, Card state, and next available action are clear
- a skill-created Card can be found and understood after refresh
- Card creation, editing, movement, commenting, stale-state recovery, and archiving have complete states
- authentication, loading, empty, success, error, and session-expiry states are designed
- the same core workflow works at desktop and mobile widths
- keyboard and assistive-technology behavior is defined for interactive surfaces
- no interface element overstates agent identity or narrows the authenticated Workspace authority
- rendered review compares the result with this file and the product vision, not with historical screenshots
- `UI_CONTRACT.md` and its automated checks are updated to match the accepted design

## Change process

Design from representative states, including an empty workspace, a populated Project, a selected Card with Comments, a stale edit, an authentication failure, and a narrow screen.

When a design decision changes the experience contract, update this file. When implementation rules change, update `UI_CONTRACT.md` and its checks in the same change. Historical research can inform a question, but it cannot settle the answer.
