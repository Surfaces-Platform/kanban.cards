# Production verification — `b0dd503`

Verified on 2026-08-09 before the Card-placement implementation slice. This record follows [`docs/runbook.md`](runbook.md) and identifies the exact merged artifact already serving production. No deployment, promotion, alias change, rollback, environment change, or credential rotation was performed during verification.

## Deployment identity

- Source and merge SHA: `b0dd5030154b9778f7a25673451ded356caeaf97`
- Production deployment: `dpl_GrpcGP89k37WXc8xstpjbEjnVKdY`
- Build: `bld_fvscpsnqj`
- Immutable URL: `https://kanbancards-kp0nkqrhb-surfaces-platform.vercel.app`
- Production alias: `https://kanban.cards`
- Provider state: `READY`
- Vercel Git metadata, build clone, and served production deployment all reported the exact source SHA above.

## Configuration, storage, and authentication

- `GET https://kanban.cards/api/health` returned `ok: true`, `store: postgres`, `authentication: owner-key`, and no missing configuration.
- The existing user-scoped helper configuration remained mode `0600` and pinned to `https://kanban.cards/api`. The credential was read only inside the local process and was never printed, placed in chat, passed as a command argument, stored in a screenshot, trace, or video, or copied into the repository.
- The public-origin helper session returned `authenticated: true`; the authenticated Project read returned two Projects. This is the production Postgres read proof that the public health response alone cannot provide.
- A deliberate invalid browser-session exchange returned `401`, set no cookie, and exposed no private Project or Card content.
- A valid exchange returned `200`; the browser session cookie was `HttpOnly`, `Secure`, and `SameSite=Lax`. Cookie-authenticated session and Project reads then succeeded.

## Provider-live mutation loop

The persistent `Release verification` Project was used with run id `b0dd5030154b-20260809T210729Z`.

- Project: `project-450f6545-448c-46d0-8be3-e32721a3c2ec`
- Card: `card-96c801d8-e1e8-4111-85d7-5641171e7608`
- External key: `release:b0dd5030154b-20260809T210729Z`
- The first create returned `201` and version `1`.
- A second request used a different idempotency key with the same external key. It returned `200`, `deduplicated: true`, and the same Card id.
- Adding the verification Comment produced version `2`.
- Moving the Card from Inbox to Doing produced version `3` and visible Created, Commented, and Moved Activity.
- A write using stale version `2` returned the expected `409`; stored version `3` remained authoritative.
- Archiving produced version `4` and Project revision `13`. A fresh authenticated browser context then rendered the `Release verification` Project as empty and did not render the archived smoke Card.

## Rendered browser proof

Fresh ephemeral Chromium contexts exercised the production origin without screenshots, traces, videos, or persisted browser state.

- Signed out: rendered `Open your workspace`, one owner-key field, and no session cookie.
- Invalid key: rendered `Owner key not accepted` and `No Project information was opened`; session and Project API behavior remained unauthenticated, and the DOM contained none of the private verification Project, Card title, or body.
- Valid key: rendered the two authenticated Projects, selected `Release verification`, opened the exact smoke Card, and rendered its title, body, verification Comment, and three Activity items.
- After archive: a new signed-out context authenticated again, selected `Release verification`, rendered the empty-Project state, and contained no active smoke Card.
- Across the valid rendered paths there were no page errors, request failures, unexpected console errors, or `5xx` responses. The only console errors were the deliberate `401` checks.

## Logs and rollback target

- The exact `b0dd503` build log showed the exact source clone, completed build, deployment readiness, and no build error.
- The retained runtime snapshot contained 48 requests: 39 `200`, three `201`, five expected `401`, and one expected `409`; it contained zero `5xx`, error, or fatal records.
- The immediately preceding production artifact is the real rollback target:
  - Deployment: `dpl_Eqjc3MS3URKnVy3zXT9bVir2XCpt`
  - Build: `bld_adwfp7m4j`
  - Source SHA: `16bfa048d8bf07e45a3c217c1bf6ff32e3e8cf45`
  - Immutable URL: `https://kanbancards-awpjgmvfh-surfaces-platform.vercel.app`
  - Provider state: `READY`
- The protected rollback URL returned healthy Postgres configuration with no missing values, and an authenticated Project read returned the current revisions. That proves the predecessor can still reach the same storage and authentication boundary; no rollback was executed.
