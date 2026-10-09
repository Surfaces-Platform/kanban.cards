# Replace Clerk with passkeys and scoped API keys

Status: implemented and validated locally on `codex/passkey-auth`. Production release, real-device verification, and Mike's passkey enrollment remain pending.

Mike is the only existing owner. Replace Clerk in one release, keep his Workspace and board data, and let future owners create private Workspaces through self-service signup. There is no coexistence release, general owner-migration system, or rollback project.

## Product experience

1. **Create a Workspace.** Choose a name and available address, create a passkey through the browser, save a recovery code, and enter the board. No password or email verification step is required. Create the owner, Workspace, and credentials only after successful passkey verification; retries cannot create duplicates.
2. **Return to the board.** Select Sign in with a passkey. Open the owner's only Workspace directly or show the existing chooser for multiple Workspaces. Support password managers, security keys, and phone-assisted authentication where available.
3. **Connect an agent.** Create a named API key with read or read/write access to one Workspace. Show its secret once and provide setup instructions that accept it through standard input. Reuse the existing AgentConnection IDs, hashes, scopes, expiry, revocation, and Activity attribution. Agents cannot manage owner credentials or issue other keys.
4. **Manage access.** Add a second passkey, revoke an API key, or end browser sessions. Require fresh passkey verification for credential changes and key creation. Rotation creates a replacement key before revoking the old one.
5. **Recover access.** A saved, single-use recovery code permits enrollment of a replacement passkey. Successful recovery replaces the code and revokes previous passkeys, sessions, pending handoffs, and agent keys. Owners reconnect agents afterward. Losing every passkey and the recovery code means losing access in this first version; email recovery is outside this change.

## Mike's initial setup

Preserve Mike's existing owner ID, Workspace IDs, membership, storage IDs, Projects, Cards, Activity, and scoped agent keys. Associate his first passkey with that exact owner record using a short-lived, single-use setup token generated through the operator's trusted environment.

Bind the token to Mike's owner ID, store only its hash, accept it only in the setup request body, and consume it atomically with passkey enrollment. Disable setup permanently after successful enrollment. Public signup always creates a new owner and cannot claim Mike's Workspace. Never grant the existing board to the first public signup or select its owner by email.

Mike's first-passkey enrollment is the only existing-owner setup work. Do not build Clerk-to-passkey linking, cohort tracking, compatibility releases, or data-copy tooling. Invalidate existing browser sessions at the switch, and let Mike enroll through the setup flow.

## Implementation

1. **Replace the authentication code.** Use `@simplewebauthn/server` and `@simplewebauthn/browser`, with supported versions for the deployed Node runtime. Require discoverable passkeys and user verification. Authenticate against internal owner IDs. Remove Clerk middleware, browser loading, session exchange, provider logout, and production fallback to the local owner key. [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server).
2. **Extend the existing Postgres-backed access store.** Add passkeys, recovery-code hashes, short-lived challenges, and app-owned session records to its validated model. Reuse its transaction boundary for signup, setup-token consumption, recovery, and revocation. Preserve existing data through explicit normalization of the current records. Choose storage for the working application; do not add a separate persistence layer for older deployments.
3. **Keep the current domain structure.** Run passkey ceremonies only at `https://auth.kanban.cards`, using RP ID `auth.kanban.cards` and that exact expected origin. The auth host serves authentication APIs and denies board-data APIs. Reuse the root-to-tenant handoff pattern and add the auth-to-root handoff. Each transfer is short-lived, single-use, browser-bound, and restricted to its exact destination. [WebAuthn relying party identifiers](https://www.w3.org/TR/webauthn-3/#relying-party-identifier).
4. **Use browser sessions after sign-in.** Keep host-only, Secure, HttpOnly cookies and durable server-side revocation. Use a 365-day absolute lifetime from sign-in, with root and Workspace cookies bounded by the server session's remaining lifetime. Check current membership on protected requests. Require fresh passkey verification within five minutes for credential changes and API-key creation. Apply exact Origin checks and CSRF protection to cookie-authenticated writes. [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
5. **Protect public signup and recovery.** Persist challenges and rate limits across server instances. Bind challenges to purpose, browser, and exact origin; consume them atomically and reject expiry or replay. Rate-limit signup, authentication, recovery, and key issuance. Limit each owner to 10 Workspaces and 50 unrevoked API keys per Workspace, and expire abandoned signup attempts. Keep secrets out of URLs, logs, and browser storage. Do not make a CAPTCHA part of every signup.
6. **Remove the integration completely.** Delete Clerk packages, runtime configuration, CSP allowances, UI code, and active Clerk-specific tests and release checks. Update the UI contract, README, environment example, CLI/skill instructions, and runbook. The replacement rejects the legacy global bearer; agents use scoped API keys. After the replacement works, disconnect the Marketplace integration and remove Clerk environment variables and FAPI DNS records. Retain `auth.kanban.cards` for passkeys.

## Delivery order

| Step | Deliverable | Done when |
| --- | --- | --- |
| 1 | Passkey authentication, sessions, and Mike's one-time setup | Mike can enroll against his existing owner record and open his existing board. |
| 2 | Self-service signup, recovery, and API-key settings | A new owner gets a private Workspace, returns with a passkey, connects an agent, and can recover or revoke access. |
| 3 | Clerk removal and focused validation | The application works without Clerk configuration and rejects old Clerk sessions and retired global credentials. |
| 4 | One release and production check | Mike opens his existing Workspace with a passkey; production signup and scoped agent access work. |

Implement and validate locally first. Use isolated development/test data and a separate RP configuration so tests cannot register production credentials or change Mike's board. Update authentication release checks to describe the new system. Follow the existing merge and production-promotion authorization rules for the single release, without adding coexistence or rollback work.

## Verification

Run `npm run check`, `npm test`, and the browser tests for signup, sign-in, recovery, Workspace routing, and API keys. Cover challenge replay/expiry, wrong origin, mismatched credential ownership, CSRF, concurrent setup/signup/recovery, session revocation, and API-key scopes/expiry/revocation.

Use two test owners and Workspaces to prove tenant isolation. Check that public signup cannot claim Mike's existing owner record. Test passkeys with browser automation and perform one real-device signup/sign-in check. After release, verify Mike's existing board, a new owner's private Workspace, and scoped CLI access.

Completion means Mike retains his data, future owners can sign up independently, agents use scoped API keys, and the application runs without Clerk.
