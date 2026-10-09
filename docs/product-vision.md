# Product Vision

kanban.cards is a durable, visible execution surface for a person and the agents acting on that person's behalf.

## Thesis

Recommendations and plans are easy to generate and hard to carry through. A repository needs a small shared record of what was proposed, what is happening now, what changed, and what remains.

Owners create private Workspaces through self-service signup and sign in with passkeys. Passkey ceremonies run on a dedicated auth host; browser-bound, single-use handoffs open the initiating root and selected Workspace. Agents use API keys scoped to one owner and one Workspace with explicit read/write permissions. Both clients operate on the same Projects, Cards, Comments, and Activity through the same API.

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

A verified passkey identifies an internal owner ID. The owner may enumerate only their private Workspaces. Signup creates the owner, first Workspace, and credentials together after verification; it cannot claim an existing account. Email is not required and never grants access.

Entering a Workspace uses a single-use, exact-destination, browser-bound handoff and a signed, expiring, host-only HttpOnly cookie. Every data read and mutation selects its store from the validated host and current owner membership. Durable session records support revocation. Cookie-authenticated writes require exact Origin checks and CSRF protection.

The skill stores a scoped API key in user configuration and sends it as a bearer token to the exact tenant API. The server stores only its hash and derives Workspace, scopes, and Activity attribution from the durable AgentConnection. A repository's `.kanban-cards.json` contains only a Project ID and cannot select tenant authority. Agents cannot manage owner credentials, create Workspaces, or issue other keys. Production rejects the retired global token.

Activity records whether a change came through the browser or API. Owner attribution comes from the verified owner session; automated attribution comes from the authenticated AgentConnection's durable ID and stored label. A request cannot relabel its actor.

Owners can add passkeys, revoke keys, and end browser sessions without deploying. Credential changes and API-key creation require passkey verification within five minutes. A saved, single-use recovery code enrolls a replacement passkey, replaces the code, and revokes prior passkeys, sessions, handoffs, and agent keys. Losing all passkeys and the recovery code means losing access in this version.

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
