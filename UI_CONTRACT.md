# kanban.cards V2 UI Contract

[`DESIGN.md`](DESIGN.md) governs visual, interaction, responsive, accessibility, and content-design decisions. This file records testable constraints in the current client. It must follow the governing design rather than preserve an implementation choice after the design changes.

The browser is a visual surface over the same project API used by `$kanban-cards`. It does not maintain a separate workspace document or model agents inside the product.

## Product surfaces

The client has four primary surfaces:

1. Access-key sign-in
2. Project list and clean empty state
3. Kanban board
4. Card detail and editing

Navigation and Card-detail presentation may change through the design process. They must keep the active Project, selected Card, primary action, and account boundary clear without introducing a second product model.

## Resource model

- A project is the board.
- Projects contain ordered columns and cards.
- Cards contain comments. Projects have Activity, and an Activity entry may reference a Card.
- The browser and skill use the same `/api/projects` resources.
- Project updates send `If-Match` with the project revision.
- Card updates send `If-Match` with the card version.
- Resource creates send an `Idempotency-Key`.
- Removing a card means setting `archivedAt`; the UI does not issue destructive deletes.

## Authentication boundary

- The static shell and sign-in surface render without authenticated project data.
- The access key is submitted once to `POST /api/session`.
- The browser relies on the resulting secure, HttpOnly cookie.
- The access key must never be stored in local storage, session storage, markup, logs, or a client global.
- Logging out calls `DELETE /api/session` and clears local project state.

## Form primitives

Raw `input`, `select`, and `textarea` markup in `src/client/app.ts` is allowed only inside:

- `renderTextInput`
- `renderTextArea`
- `renderSelect`

Every control uses `.form-control`; selects also use `.select-control`. Fallback markup in `index.html` must not collect credentials or authenticated data.

## Simplicity boundary

The primary client must not introduce teams, memberships, roles, agent identities, delegated sessions, capabilities, gates, approvals, delivery state, AI flow generation, or templates. Those concepts are intentionally outside V2.

## Verification

For client changes, run:

- `npm run build:client`
- `npx tsc -p tsconfig.client.json --noEmit`
- `npx tsx scripts/check-ui-contract.ts`
- Browser QA at desktop and mobile widths when the server can be run safely
