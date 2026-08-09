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

The skill does most of the operating. The browser turns the shared state into a clear workspace a person can understand and change. Every design decision should make one of those jobs easier.

## Experience model

The browser and skill are two clients of the same system:

- The skill creates and updates work while acting with the owner's authority.
- The browser shows the current state, provides direct editing, and helps the owner catch drift.
- A Project is the board. Columns express state. Cards carry the work. Comments and Activity preserve useful context.
- Neither client maintains a second workflow model.

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

One owner key grants access to the whole workspace. The interface must not imply per-Project permissions, authenticated agent identities, or verified authorship that the system does not provide.

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

The sign-in surface should explain that the owner key opens the whole workspace. Key entry is a short transition into the product, not a permanent part of the application chrome. The key must disappear from the client after the session exchange.

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
| Signed out | One owner key opens one private workspace. |
| Invalid key | Access was refused; no Project names or content are revealed. |
| Empty workspace | The owner can create a Project or ask the skill to create one. |
| Empty Project | Columns are present and the next Card can be created. |
| Populated Project | Column state and Card identity are easy to scan. |
| Card detail | One Card can be understood and changed without losing Project context. |
| Loading or saving | The affected surface shows progress and prevents duplicate action. |
| Success | The changed resource becomes the primary confirmation. |
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

The product has one implicit owner and one workspace-wide credential.

- The account indicator may show the configured owner label, but it must not suggest a role system.
- The active Project is navigation context, not an authorization scope.
- Repository binding belongs to the skill workflow; the browser does not need to simulate repository permissions.
- API actor labels should not receive avatars, presence, or identity treatments that imply verification.
- The owner key and bearer tokens must never appear in client-readable storage, markup, URLs, logs, or screenshots. The browser session is retained only in the signed, expiring HttpOnly cookie.

## Responsive and accessible behavior

The complete workflow must work with keyboard, pointer, touch, and assistive technology.

- Focus order follows the visible task order.
- Focus is always visible.
- Controls have clear names and comfortably usable targets.
- Selection, status, and errors do not rely on color alone.
- Dialogs and overlays, when used, manage focus and expose clear close behavior.
- Dynamic loading, saving, success, and failure states are announced programmatically. Validation errors are associated with the affected controls, and a temporary toast is never the only accessible record of an important result.
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

## Decisions still open

The following choices should be made through new working screens and rendered review:

- visual identity, palette, typography, and geometry
- Project navigation and application chrome
- Column behavior and Card density
- placement and treatment of creation actions
- Card detail presentation
- the prominence of Comments and Activity
- narrow-screen workspace behavior

Open decisions should remain open until a current user job and a representative state provide enough evidence to choose.

## Acceptance criteria

A design is ready to implement when:

- a new user can move from sign-in to a useful Project without configuring unrelated concepts
- the active Project, Card state, and next available action are clear
- a skill-created Card can be found and understood after refresh
- Card creation, editing, movement, commenting, stale-state recovery, and archiving have complete states
- authentication, loading, empty, success, error, and session-expiry states are designed
- the same core workflow works at desktop and mobile widths
- keyboard and assistive-technology behavior is defined for interactive surfaces
- no interface element overstates actor identity or narrows the owner key's real authority
- rendered review compares the result with this file and the product vision, not with historical screenshots
- `UI_CONTRACT.md` and its automated checks are updated to match the accepted design

## Change process

Design from representative states, including an empty workspace, a populated Project, a selected Card with Comments, a stale edit, an authentication failure, and a narrow screen.

When a design decision changes the experience contract, update this file. When implementation rules change, update `UI_CONTRACT.md` and its checks in the same change. Historical research can inform a question, but it cannot settle the answer.
