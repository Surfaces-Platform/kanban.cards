# Shared editing slice

macOS, iOS and web now open Cards directly into editable fields with explicit Save and Revert. Typing stays local. Close, Back and Cancel retain unfinished work; Revert discards unsubmitted changes without undoing a saved server change.

Drafts persist by verified owner, exact origin, Workspace, Project and resource. Sign-out and expiry hide private content while retaining recovery for the same owner. Unproven legacy native drafts require an explicit Workspace association before use. Storage failures expose Retry and Copy or Export; text held only in memory cannot survive process termination. Divergent browser-tab copies remain recoverable, and native Card/Comment presentations share their editing authority.

Save compares baseline, local draft and latest saved fields. Untouched fields adopt newer values. Different edits to the same field require a choice. A Comment-only version increment does not create a text conflict. Archived or unavailable resources retain local recovery without being recreated implicitly.

Move is a separate, versioned destination operation. Dirty text stays local, and text Save never sends placement. Moving a Card to Done and then saving an unfinished title leaves it in Done. Unresolved operations retain their original identity across relaunch. POST retries freeze their payload and idempotency key, including HTTP 408 outcomes. PATCH recovery reads back saved state before another deliberate action; matching values are described as observed state, not proof of the original request.

A confirmed write is separate from refresh and local cleanup. Recovery cannot repeat a completed mutation because a later read or local delete failed. Card and Comment drafts retain the owner and session that created them; stale responses cannot expose work under a replacement session. The web mutation fence checks the intended owner against authority resolved for that same request.

[The validation record](slice-1-validation.json) identifies the frozen source, VM, commands, results, source-equivalence checks, preservation proof and VM cleanup. Local logs, traces, screenshots and native result bundles are retained under `output/shared-editing-2026-10-19/`, including failed and superseded attempts. The shared fixture is [`tests/fixtures/shared-editing.json`](../../tests/fixtures/shared-editing.json); all three implementations execute its reconciliation vectors.

Native UI tests exercise standard Apple controls inside the task VM. Cross-client handoff tests use the actual web UI and native API clients against an isolated synthetic backend. Native handoffs are API evidence, with separate native UI results; they do not prove physical-device authentication or deployed TLS and associated-domain behavior.

This slice does not complete the full 33-capability, 31-scenario workflow. Search, native Markdown preview and complete native account management retain their separate acceptance work. The earlier specification receipt remains unchanged. Hosted CI, release signing, installation and deployment are separate from this local validation.
