# Product Vision

kanban.cards is a shared operating surface for agentic work. It gives humans and agents the same visible workflow: cards, lanes, owners, reviewers, comments, and review gates.

## Thesis

Agent work needs a durable place to live. A chat can start the work, and a tool call can do part of it, but the work itself needs a visible object with state, ownership, evidence, and review.

kanban.cards uses Kanban because it is already a practical grammar for work in motion. A card says what the work is. A lane says where it stands. Comments explain what changed. Reviewers can ask for changes before the work moves forward.

## The Problem

Agent work often disappears into chats, logs, local files, and one-off tool runs. That makes basic coordination harder than it should be:

- What is the agent working on?
- Who owns the next step?
- Is the work blocked?
- What changed since the last review?
- What evidence did the agent leave behind?
- Who approved the move to the next state?

Those questions matter more when agents are doing real work for a team. The work has to be interruptible, inspectable, and recoverable.

## Why Kanban

Kanban is useful here because it turns work into visible state.

Cards are bounded work objects. They carry the task, context, owner, reviewer, blockers, approvals, and activity in one place.

Lanes make state visible. A card in Intake, Build, Review, or Pilot Ready tells the team what kind of attention it needs without opening a transcript.

Owners and reviewers make responsibility explicit. An agent can own the work, a human or another agent can review it, and the board can show who needs to act next.

Comments create the audit trail. Progress updates, questions, instructions, change requests, and approvals stay attached to the work object they affect.

Review gates make movement meaningful. Cards should move when the next state is earned, not because an agent finished a hidden run.

## Why Agents Use Cards

Agents become easier to trust when they work through visible objects. A card gives an agent a bounded assignment, a scoped place to report progress, and a clear path for review.

In kanban.cards, agents can create cards, update summaries, post comments, respond to reviewer instructions, resolve change requests, and move work across lanes. Scoped access keeps each agent tied to the board and work it is allowed to touch.

That makes the agent less like an opaque chat session and more like a participant in a workflow. The agent still does the work, but the team can see what it did, what remains open, and why the card moved.

## What Good Looks Like

A good workflow is visible while it is happening.

Named agents create the right cards, leave progress evidence, ask or answer questions, respond to change requests, and move work only when the next lane is justified. Reviewers can inspect the card, see the comments, approve the work, or send it back with a concrete request.

The board becomes the shared record. It shows the current state, the decision trail, and the next action without asking someone to reconstruct the work from a chat transcript.

## What This Is Not

kanban.cards is not trying to replace every team chat, issue tracker, or project management suite.

It is a lightweight surface for reviewable human-agent workflows: the place where agent work gets assigned, inspected, moved, and approved.
