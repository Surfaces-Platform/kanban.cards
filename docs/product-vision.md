# Product Vision

kanban.cards is a durable, visible execution surface for a person and the agents acting on that person's behalf.

## Thesis

Recommendations and plans are easy to generate and hard to carry through. A repository needs a small shared record of what was proposed, what is happening now, what changed, and what remains.

The browser uses a Clerk-verified owner identity and an isolated Workspace session. A dedicated auth-only host owns the Clerk sign-up/sign-in experience. Canonical and release-candidate application roots share the same `kanban.cards` root domain and recognize the verified Clerk browser session after an exact-origin return; they are not Clerk satellites. Tenant hosts receive only kanban.cards Workspace sessions. Automated clients use neutral AgentConnections bound to one owner and one Workspace with explicit read/write scopes. The earlier compatibility credential remains only as a migration bridge for the legacy Workspace. Both clients operate on the same Projects, Cards, Comments, and Activity through the same API.

## Why Kanban

A Card is a bounded piece of work. A Column makes its state visible. A Comment records context or progress. Activity makes recent changes inspectable.

That is enough to support an execution loop:

1. Turn a plan into Cards.
2. Choose the next work.
3. Perform the work.
4. Update the Card.
5. Reconcile the Project with reality.

## Product boundary

kanban.cards has owners, isolated Workspaces, and many Projects within each Workspace. A Project is the board and contains Columns and Cards. Cards contain Comments. Project Activity records changes made with the owner's authority.

The skill is the primary operating client. The browser provides sign-in, project selection, a visual board, and Card detail and editing. The product vision does not prescribe a drawer, inspector, or other specific UI construction.

[`DESIGN.md`](../DESIGN.md) governs visual and interaction decisions for the new interface.

## Trust boundary

A server-verified Clerk user with a verified primary email may enumerate only Workspaces owned by that exact Clerk user ID. Email is profile data, never binding or authorization authority. Entering a Workspace uses a single-use, exact-destination handoff and a signed, expiring, host-only HttpOnly tenant cookie. Every data read and mutation selects its state store from the validated host and session. AgentConnections are scoped credentials, not vendor identities, users, roles, or per-Project grants.

The skill stores a one-time AgentConnection credential in user-scoped configuration and sends it as a bearer token to the exact tenant API. The server stores only its strong hash and derives Workspace, scopes, and Activity attribution from the durable connection. A repository's `.kanban-cards.json` contains only a Project ID and cannot select tenant authority. The compatibility bearer remains separate and bounded to the legacy Workspace.

Activity records whether a change came through the browser or API. Owner attribution comes from the verified owner session; automated attribution comes from the authenticated AgentConnection's durable ID and stored label. A request cannot relabel its actor. The compatibility bearer keeps its distinct migration attribution and is not presented as an AgentConnection.

Owners can revoke an AgentConnection without deploying. Clerk and kanban.cards browser-session rotation is independent. Older immutable deployment URLs retain their original environment snapshot and must be protected or retired separately.

## Agentic safety

Safety comes from mechanics that help an agent act reliably:

- stable resource IDs and optional external keys
- bounded idempotent retry support and durable Card deduplication through external keys
- optimistic concurrency on edits
- non-destructive archiving
- server-recorded activity with bounded retention
- a credential stored outside the repository

These mechanics do not require teams, modeled agents, capability grants, delegated sessions, reviewers, approval objects, or workflow-generation controls in this version.

## What good looks like

Starting from an empty workspace, an agent can create a Project, populate recommendations without duplicates, read status, move and comment on Cards during execution, and reconcile the Project after repository work.

The browser and skill read the same stored state. After the skill makes a change, the browser shows it on the next refresh or Project load.

The user never has to configure an agent, team, separate Board, reviewer, gate, or flow before useful work appears. A new Project receives default Columns unless the caller supplies its own.

## What this is not

kanban.cards is not a team directory, identity platform, autonomous-agent runtime, workflow generator, immutable audit ledger, or full project-management suite. It is the smallest durable bridge between a plan and visible execution.
