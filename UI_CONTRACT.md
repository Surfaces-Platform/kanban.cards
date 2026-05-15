# kanban.cards UI Contract

This app uses two gates for generated UI work:

1. JudgmentKit validates the activity, workflow, and disclosure boundary before UI generation.
2. kanban.cards UI primitives validate component execution so generated screens cannot bypass approved controls.

## Approved Form Primitives

Feature UI in `src/client/app.ts` must render form controls through these helpers. The build emits the browser bundle at `public/app.js`.

- `renderFormField`
- `renderTextField`
- `renderTextAreaField`
- `renderSelectField`
- `renderFieldGrid`
- `renderCheckboxGroup`
- `renderCheckboxOption`

Raw `input`, `select`, and `textarea` markup is allowed only inside the primitive helpers. Fallback markup in `index.html` may use raw controls because it renders before JavaScript is available.

## Control Rules

- Text inputs, textareas, and selects use `.form-control`.
- Selects also use `.select-control`.
- Checkbox groups use `.checkbox-group`, `.checkbox-grid`, `.checkbox-option`, and `.checkbox-control`.
- Checkbox boxes are 16px square, top-aligned with wrapped labels, and separated from labels by 8px.
- Long checkbox labels must wrap inside a responsive grid without changing checkbox size or creating oversized label gaps.

## Verification

Every UI generation pass must run:

- JudgmentKit before implementation.
- `npm run check`, including the UI contract check.
- Browser QA on desktop and mobile when form/control surfaces change, verifying sizing, spacing, wrapping, focus states, and overflow.
