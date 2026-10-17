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

Owners choose Create account, name a private Workspace, create a passkey, and save a recovery code. Successful verification creates the owner, Workspace, and credentials together. Returning owners sign in with a passkey; one Workspace opens directly and two or more require a choice. Owner authority uses the internal owner ID. Agents use scoped API keys backed by Workspace-bound AgentConnections.

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

A verified owner session grants access only to Workspaces owned by its internal owner ID. Signup requires no email or password. Within a Workspace, authority remains Workspace-wide. Scoped API keys belong to one owner and one Workspace and grant explicit read or read/write access.

Activity attribution comes from the authenticated principal. Owner writes use the verified owner session; API-key writes use the AgentConnection's durable ID and stored owner-chosen label. Request headers cannot select or relabel the actor.

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

Brand artwork uses the canonical outlined Inter 780 lockups in `brand/split-k/lockups/`. They use optical size 32, a 60px visible Split K, a 38px cap height, a 20px measured ink gap, and at least 24px outer padding. Scale the complete lockup uniformly. The lower arm stays Nickel `#8B9096` in both themes; the remaining shapes and wordmark use Ink `#0B0D0E` on light backgrounds and Warm ivory `#F7F6F2` on dark backgrounds. `brand/split-k/README.md` defines the horizontal and stacked compositions. This brand-artwork choice leaves the app’s system typography unchanged.

## Public website and sign-in pages

Mike selected public website and sign-in alignment with Surfaces on October 16, 2026. The ordinary signed-out root is a public homepage governed by `docs/specs/website-family-layout.md` and `docs/specs/website-family-copy.md`. One full-width raster hero sits behind left-aligned copy and the existing Create account and Sign in actions. A three-item ruled problem row and a connected five-step execution loop follow. Conditional setup/retry utilities remain available in the footer. Recover access is a quiet tertiary text action inside the passkey sign-in card, below Continue with passkey and Back. The dedicated auth pages keep their current passkey fields, progress, recovery-code acknowledgement, validation, and initiating-root routing. `website-assets/copy-provenance.md` maps the homepage copy to current product sources.

These public pages use a 1120px shell, 24px desktop and 16px mobile gutters, a 72px Ink header, and an Ink footer. Both contain the complete reversed canonical lockup. Public UI typography uses the included self-hosted Inter font at 16px/1.45, with 40/32/24px headings at weight 600 and zero tracking. At widths up to 620px, the three heading levels reduce to 32/24/20px. The 820px layout breakpoint controls the compact navigation, gutters, and footer independently. Controls are at least 48px high, with 14px labels at weight 500, 4px control corners, 8px panel corners, and quiet 120ms transitions. The palette follows the Surfaces website: Ink, Ivory, Nickel, Rule, White, and its neutral dark surface. Preserve semantic warning and error states.

`website.css` owns this public treatment. Every selector is qualified by `body.public-website` or its descendant namespace. The client adds that marker only to signed-out root/auth views and removes it for every signed-in or local-development view. The unique font face may be declared globally; it is used only by the public namespace. `website-assets/manifest.json` records the unchanged font bytes, SIL Open Font License, and generated hero fingerprint. `website-assets/art-provenance.json` records the hero source and prompt. The hero is decorative page artwork, not an application screenshot or brand master.

Signed-in Workspace selection, access settings, Agent connections, and the Context Dock retain the pinned JudgmentKit Workbench tokens, system typography, layout, and behavior. Their shared access-card classes must not receive unqualified website overrides. Native Apple interfaces and canonical brand artwork remain separate and unchanged.

## Required surfaces

### Sign in

The signed-out application root offers `Create account` and `Sign in`. The dedicated passkey sign-in card offers `Recover access` as an underlined tertiary action with a 48px target and visible focus. Recovery returns through the validated initiating root to start the existing bound intent flow; it does not post authentication requests directly from the auth host to the root. Each form preserves the exact initiating root and asks only for the fields needed for that task and a short instruction to use the device or password manager.

Signup asks for the Workspace name and address, then offers `Create passkey`. After verification, show the recovery code once and ask the owner to save it before entering the board. Sign-in offers `Continue with passkey`. The forms require no email or password.

Access is private to each owner and signup is self-service. Public signup creates a new owner and private Workspace. Mike's existing account uses a separate one-time setup form bound to his exact internal owner ID; signup cannot claim that account.

After sign-out, keep one bounded receipt until the person continues: the product name, the heading `Signed out`, and one `Continue` action. Failed server revocation offers a retry and clears private board content from the screen.

Access settings let owners add another passkey, manage scoped API keys, replace the recovery code, and end browser sessions. Require passkey verification within five minutes for credential changes and key creation. Show a new API-key secret once and explain its Workspace, scope, and optional expiry.

Recovery asks for the saved single-use code and enrolls a replacement passkey. It issues a new code and revokes previous passkeys, sessions, pending handoffs, and agent keys. Tell the owner to reconnect agents. Losing all passkeys and the recovery code means losing access in this version.

Visible sign-in language uses the product name and the words people need to complete the task. Host configuration, internal owner IDs, browser-bound handoffs, session cookies, and operator setup belong in [`UI_CONTRACT.md`](UI_CONTRACT.md) and [`docs/runbook.md`](docs/runbook.md). Local development may retain an owner-key form when passkey authentication is deliberately absent; production never uses that fallback.

This design follows the NN/g guidance to [remove unnecessary steps](https://www.nngroup.com/articles/affordable_care_act_usability_issues/) (Jen Cardello and Susan Farrell, “9. Remove unnecessary steps”), [limit the first screen to essential information](https://www.nngroup.com/articles/defer-secondary-content-for-mobile/) (Jakob Nielsen, “Summary”), [avoid unnecessary choices and their instructional overhead](https://www.nngroup.com/articles/simplicity-vs-choice/) (Hoa Loranger, “Simplicity Usually Wins”), [show only what is relevant at each form step](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/) (Huei-Hsin Wang, “Utilize Progressive Disclosure”), and [keep labels and instructions in plain language](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/) (Huei-Hsin Wang, “Use Plain Language”). NN/g's [visual-hierarchy guidance](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/) (Huei-Hsin Wang, “Create Visual Hierarchy”) supports keeping secondary instructions subordinate to the primary form. The denied state follows NN/g's [plain, concise, actionable error-message guidance](https://www.nngroup.com/articles/error-messages-scoring-rubric/) (Evan Sunwall and Tim Neusesser, “Communication Guidelines”); the product's privacy boundary limits the explanation to a generic result.

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

Card detail must support title, body, Column, next actor, next action, priority, blocker, Comments, Activity context, and archive behavior without losing Project context.

Next actor is You, Agent, or Unassigned. Priority is High, Medium, Low, or unset. Next action and blocker are plain text. All four fields are optional. A nonempty blocker marks the Card as blocked. These fields describe the work; they do not change authority or execute actions. Columns remain the sole progress model.

Card tiles show compact actor, priority, blocked, and next-action context when present. The Project offers combined next-actor, priority, and blocked filters, matching counts, and one clear-filters action. A filtered Column with no matches must be distinguishable from an empty Column. Filtering must preserve a selected Card and any unsaved draft, including when an edit causes the Card to stop matching.

The detail surface may be inline, adjacent, overlaid, or navigated. A drawer, inspector, modal, or dedicated view is a decision to make from current workflows and rendered prototypes. No previous implementation decides it automatically.

### Project creation and editing

Project creation should ask only for information needed to begin. Default Columns should make a new Project immediately useful. Project editing covers the resource itself—its name, description, and ordered Columns—without becoming a catch-all administration surface.

## Required states

The design must account for the full workflow, including states that are easy to miss in a polished board mockup.

| State | What the experience must communicate |
| --- | --- |
| Opening | The application is loading without exposing stale private data. |
| Signed out | The application offers signup, passkey sign-in, and recovery and returns to the exact initiating root after verification. |
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

The product has self-service passkey owners, private Workspaces, and one Workspace-wide authority boundary inside each Workspace.

- The account indicator may show the owner's display name, but it must not imply a verified email or a role system.
- The canonical Workspace host and server-validated session select tenant context. A Project ID, request body, query, or header never selects it.
- The active Project is navigation context, not an authorization scope.
- Repository binding belongs to the skill workflow; the browser does not need to simulate repository permissions.
- API actor labels still should not receive avatars, presence, or identity treatments that imply verification.
- API keys appear once to the owner who creates them and never enter URLs, logs, or persistent browser storage. Agents store their keys outside repositories; the server stores only hashes.
- Setup and recovery codes enter through request bodies. Save the recovery code before leaving its one-time display. Neither secret belongs in a URL or log.
- Passkey ceremonies run only at the configured auth host. Challenges and handoffs bind to their purpose, browser, exact origin, and expiry. A handoff token travels only in the response and an immediately removed hidden-form POST to its exact destination.
- Browser sessions use signed, expiring, host-only HttpOnly cookies and durable server-side records. Sign-out revokes the session family; Sign out everywhere revokes all of the owner's browser sessions. Cookie-authenticated writes use exact Origin checks and CSRF protection.

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

- Use JudgmentKit's `judgmentkit_default` source with the `workbench` surface pattern for signed-in and local-development screens. Public root/auth pages use the scoped website treatment defined above.
- Use the exact `--jk-*` token roles, system typography, and component and pattern contracts; do not recreate the appearance with local lookalike tokens.
- Lucide is the icon authority when an icon materially improves comprehension. Text controls remain valid when an icon would add noise.
- Keep the surface calm, compact, and low-elevation. Selection, focus, validation, stale state, action progress, and receipts are the justified sources of salience.

### Application chrome and Project context

- Place the compact Project selector immediately after the product name in the header. Do not repeat the active Project name, description, or recency in a second context bar.
- Represent the owner with a simple avatar button. Its plain panel contains the username and Sign out; do not expose environment or QA labels in the chrome.
- Put New Project, New Card, Edit Project, and Refresh in one Actions panel at the top right of the Kanban surface. Keep routine success copy off the surface; show persistent status only when the user must act on it.
- Make Add Column a direct board action: the final desktop lane and the narrow-screen board control expand in place to ask only for the new Column name while the current Columns remain visible. New Projects start with exactly three ordered Columns: Next, Doing, and Done. Add Column appends after every stored Column. Project editing covers name, description, and every stored Column without truncating additional API-created Columns. Conflicting navigation stays unavailable until Save or Cancel.

### Columns, Cards, and creation

- Desktop uses an ordered Column grid with compact, consistently structured Card summaries: title, optional next actor, priority, blocked cue and next action, a short body-derived summary when present, Comment count, and recency.
- Column placement communicates Card state; do not repeat state decoration without a separate need.
- The board-local Add Column action preserves every existing Column id, order, and Card placement, then makes the new final Column visible on desktop and narrow screens.
- New Project and New Card actions remain near their resource context and stay reachable in empty, populated, desktop, and narrow-screen states.
- An existing Card has one canonical browser movement path: a visible `Move…` command in the selected-Card toolbar. It opens a named `Move Card` disclosure that states the current Column and presents every other Column as an explicit `Move to <Column>` action.
- The Move disclosure uses ordinary buttons, not menu semantics. It remains the same command on desktop and narrow screens and is the keyboard, touch, and assistive-technology path. This slice does not add drag-and-drop, a board-Card overflow action, or a persistent selected-Card Column field.
- New Card creation shows a labeled `Create in` choice before the Create action. Desktop defaults to the first ordered Column; narrow and Column-local entry default to the visible or launch Column. The choice is creation context, not an editable state field on an existing Card.
- Movement waits for pending Card field saves, locks conflicting mutations, changes only the destination against the latest Card version, and keeps the Card open. The board, Card Activity, narrow-screen Column, close label, and completion receipt then agree on the destination.
- A move-time version conflict retains only the requested destination. The latest stored Card remains authoritative, and recovery offers an explicit destination-specific Retry or Cancel without replaying title or Body changes.
- A successful create, edit, move, or Comment updates the visible resource and its Card-specific Activity before showing one secondary transient confirmation. The latest confirmation replaces the prior one and leaves without moving focus. Retaining an unsaved Card draft uses the same transient acknowledgement while the affected board Card and reopened editor carry the durable recovery cue instead of a workspace banner.

### Card detail, Comments, and Activity

- Card detail is absent until a Card is selected. It opens from the right as a full-height, wide, nonmodal surface with an X close control; no empty inspector, context eyebrow, detail heading, or inspector Refresh is rendered.
- Title and Description are surface-integrated controls. Description is the dominant object and stores its Markdown source unchanged apart from browser newline normalization in the existing Card `body` field. Existing Cards save title and Description on field blur, without a Save action or an inspector Column selector; new Card creation retains an explicit Create action.
- Next actor and Priority save on selection. Next action and Blocker save on blur. The optional fields follow Description and share its draft retention, conflict review, retry, and discard behavior.
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
