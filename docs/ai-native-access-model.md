# AI-Native Access Model

kanban.cards needs an access model that treats humans, agents, tools, and workflow state as first-class parts of the same system.

The core question is:

> Who or what may do which action, on which work object, under whose delegation, until when, with what review requirement?

This document describes the target model. It does not describe runtime behavior that already exists today unless that behavior is called out in the current-state section.

## Current State

The current product has a private-beta access model:

- Private UI access uses Auth0 session authentication with a signed, HttpOnly session cookie.
- Admin API access uses one compatibility bearer token.
- Agent API access uses hashed, revocable bearer tokens scoped to one board and one agent.
- Auth0 `workspaceId` is captured as the seed team boundary for the future Team/Project model.
- Workspace state persists a compatible `Team`, `Project`, `activeProjectId`, and `board.projectId` model while keeping boards top-level for current UI compatibility.
- Boards contain lanes, agent specs, cards, comments, and review state.
- Comments and workspace events provide the early audit trail, with mutation events carrying actor, resource, action, delegation, reason, and timestamp provenance.

That is enough for private beta work and scoped local agents. It is not a full user, team, project, membership, session, or policy model yet.

The current pieces map into the target model this way:

- Auth0 session auth maps to early user identity and team seed context.
- The admin compatibility bearer token maps to break-glass private-beta admin access.
- Board-scoped agent tokens map to delegated agent sessions, with legacy tokens normalized into board-scoped sessions.
- Board, comment, and event history map to the seed audit trail.

## Target Shape

The target model is:

```text
User
  belongs to Team
Team
  owns Projects
Project
  owns Boards, agents, members, and policy defaults
Board
  defines lanes, workflow gates, and visible work state
Card
  carries owner, reviewer, state, evidence, and activity
AgentSession
  grants one agent bounded authority for a task or work surface
```

Project is the boundary that makes a board operational. A team may have many projects. A project may have many boards. Boards remain the visible workflow surface, but project membership and policy decide who or what may act on them.

## Actors

Actors are the subjects that can take actions:

- `User`: a human member of a team.
- `Agent`: an AI worker represented by a project or board agent spec.
- `Service`: an integration, automation, or backend process.
- `AgentSession`: a delegated run of an agent with bounded authority.

An agent should not receive ambient access to everything a user can do. It should receive a narrow grant for a project, board, card, tool, action set, and time window.

## Resources

Resources are the objects access decisions apply to:

- `Team`
- `Project`
- `Board`
- `Lane`
- `Card`
- `Comment`
- `AgentSession`
- `Token`
- `ToolConnection`

The model should keep these resources addressable so access decisions can be explained and audited later.

## Capabilities

Capabilities are the actions an actor may take:

- `view`
- `create`
- `update`
- `comment`
- `move`
- `approve`
- `resolve`
- `invite`
- `connect`
- `revoke`

A grant should pair one or more capabilities with a resource boundary. For example, an agent session may be allowed to `comment` and `move` cards on one board, but not `approve` delivery or `invite` project members.

## Delegation

Delegation is the mechanism that lets an agent act for a bounded purpose.

A delegated grant should answer:

- Who delegated the authority?
- Which actor receives it?
- Which project, board, card, or tool does it cover?
- Which capabilities are allowed?
- When does it expire?
- What review requirement applies?
- What reason or task context explains the grant?

Agents act through delegated sessions. A project can define policy defaults, a board can narrow them by workflow, and a card can narrow them again by owner, reviewer, or lane state.

## Hybrid Governance

The first implementation target should be hybrid governance.

The system should enforce:

- Actor identity.
- Resource scope.
- Allowed action.
- Project and board boundary.
- Token or session revocation.
- Action provenance.

The system should show, but not hard-block by default:

- Lane gate checklist completion.
- Blockers.
- Reviewer assignment.

The system should hard-block sensitive transitions:

- Approval.
- Delivery or release.
- Token creation or revocation.
- Tool connection.
- Project membership changes.

This keeps normal workflow movement lightweight while making high-risk actions explicit and reviewable.

## Provenance

Every meaningful action should leave a record with:

- Actor.
- Delegated-by actor, when applicable.
- Resource.
- Action.
- Reason or task context.
- Timestamp.

For agent work, provenance matters as much as permission. A reviewer should be able to see what an agent changed, why it had authority to do it, and who or what approved the next step.

## Future Implementation Outline

The current runtime implementation starts this direction with compatible JSON-state evolution:

- Persist `Team` and `Project` records in the workspace model, with a default project for existing boards.
- Make boards project-scoped while preserving current board IDs and card history.
- Evolve board-scoped agent tokens into agent sessions with explicit delegation metadata.
- Record mutation provenance in workspace events.

Future passes should add:

- Memberships and roles at the team and project level.
- A fuller shared policy layer at the API boundary.
- Tool connection resources and review requirements.
- UI for project settings, membership, and invitations.

Auth0 session auth, the break-glass admin bearer token, and scoped agent sessions remain the production mechanism.
