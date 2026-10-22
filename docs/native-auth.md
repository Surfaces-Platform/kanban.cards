# Native owner authentication

The iPhone app can create an account and enroll its first passkey through AuthenticationServices. iPhone and macOS apps can use an existing owner's passkey to open the same Workspaces and board data as the browser. Native authentication uses a separate owner bearer session. Recovery and existing passkey management remain browser operations.

## Configure app association

Set the server's `KANBAN_CARDS_IOS_APP_IDS` to the exact `application-identifier` from each authorized signed app. The verified signed development apps use `2468833C5L.cards.kanban.iphone` for iPhone and `2468833C5L.cards.kanban.macos` for macOS. The existing setting accepts identifiers for both platforms. Preserve every existing app identifier when adding the Mac:

```text
KANBAN_CARDS_IOS_APP_IDS=2468833C5L.cards.kanban.iphone,2468833C5L.cards.kanban.macos
```

Apple defines the value as `<Application Identifier Prefix>.<Bundle Identifier>`. Use the Team ID only when it equals the signed app's prefix. The server accepts a ten-character uppercase alphanumeric prefix and at least two dot-separated bundle segments. Wildcards and duplicate identifiers fail startup.

The signed app must include the Associated Domains entitlement `webcredentials:auth.kanban.cards`. When the App ID setting is nonempty, the auth host serves `/.well-known/apple-app-site-association` with the configured identifiers:

```json
{"webcredentials":{"apps":["2468833C5L.cards.kanban.iphone","2468833C5L.cards.kanban.macos"]}}
```

An empty setting disables that route. The file must be available over HTTPS with a valid certificate and no redirect. Check the public response after release:

```sh
curl -i https://auth.kanban.cards/.well-known/apple-app-site-association
```

Apple's CDN also needs to serve the updated association file. Installing an app starts domain verification; installed devices can retain an earlier association result. Follow Apple's [associated domains guidance](https://developer.apple.com/documentation/xcode/supporting-associated-domains) and [passkey setup](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys).

Configure the environment before the intended Git Production build. Updating a Vercel environment value does not change an existing deployment. Use the [release runbook](runbook.md) to validate and promote the exact candidate.

## Sign in and use the API

Native requests use JSON. Send the bearer as `Authorization: Bearer <token>` after sign-in. Omit browser cookies, the HTTP `Origin` header, and `Sec-Fetch-Site`; the server rejects native requests that include ambient browser authority.

| Host | Route and body | Result |
| --- | --- | --- |
| Auth | `POST /api/native-auth/registration/challenge` with `displayName` and optional `email` | Five-minute registration challenge, ceremony token, RP ID, base64url user ID, user name, and expiry |
| Auth | `POST /api/native-auth/registration/verify` with `challengeId`, `ceremonyToken`, and standard WebAuthn `credential` | Verifies registration and atomically creates the owner, passkey, and native session |
| Auth | `POST /api/native-auth/challenge` with `{}` | Five-minute, single-use `challengeId`, `ceremonyToken`, `challenge`, `relyingPartyIdentifier`, and `expiresAt` |
| Auth | `POST /api/native-auth/verify` with `challengeId`, `ceremonyToken`, and `response` | Verifies the signed assertion and returns `authenticated`, `tokenType`, `token`, absolute `expiresAt`, `rootUrl`, and owner identity |
| Root | `GET /api/workspaces` | Current owner's Workspaces with their exact tenant URLs |
| Root | `POST /api/workspaces` with `name`, `slug`, optional `initialProject: {name, idea}` and a stable `Idempotency-Key` | Creates an owner-bound Workspace and returns `201 {workspace, project?}`. Native first setup supplies `initialProject` and preserves its exact original Idea. Identical owner retries return the same resources; changed requests with that key return 409. |
| Root or owned tenant | `GET /api/session` | Current authority, `authenticationMethod: "native"`, and expiry |
| Root or owned tenant | `DELETE /api/session` | Revokes the current native credential across the root and tenant hosts |
| Owned tenant | Existing Project, Card, Comment, and Activity routes | Same board data, membership checks, and version checks as browser and agent requests |

For production, Auth is `https://auth.kanban.cards`, Root is `https://kanban.cards`, and each owned tenant has its returned Workspace URL. Challenge and verification routes are unavailable on the root and tenant hosts. The auth host denies board-data APIs.

1. Request the challenge with an empty JSON object. Account and Workspace selectors are rejected.
2. Use `relyingPartyIdentifier` and the decoded challenge with `ASAuthorizationPlatformPublicKeyCredentialProvider`. Require user verification.
3. Submit the returned assertion with the original challenge ID and ceremony token. Preserve the assertion's original bytes. The assertion has `id`, `rawId`, `type: "public-key"`, and a `response` containing base64url `authenticatorData`, `clientDataJSON`, `signature`, and `userHandle`.
4. Store the returned bearer in Keychain and use the returned `rootUrl` to discover Workspaces. Open only an owned Workspace's exact tenant URL for board operations.
5. On sign-out, call `DELETE /api/session` and remove the local credential. An expired or revoked credential requires a new passkey sign-in.

The server verifies the RP ID, origin, challenge, signature, user presence, user verification, and owner handle. Ceremonies are consumed once. Invalid verification, replay, expiry, a revoked passkey, or an owner mismatch cannot issue a session. Native authentication is rate limited separately for challenge and verification requests.

## Session lifetime and revocation

Native sessions expire 30 days after sign-in. Activity does not extend expiry. The server stores only the bearer's SHA-256 hash; the raw bearer appears only in the successful verification response and the client's secure storage.

Owners can revoke a native session individually or end all sessions in browser access settings. Recovery revokes browser and native sessions, pending handoffs, old passkeys, and agent keys. Native sessions cannot recover an account or manage existing passkeys. A native owner can authorize a Workspace agent pairing after a fresh passkey verification.

## Native enrollment and agent pairing

Registration requires resident passkeys and user verification. The server verifies the canonical RP and origin, raw challenge, WebAuthn type, credential ID, and attestation before creating any account. The signed-in native client accepts a registration receipt only for its configured root and expected owner. Retrying the identical registration credential with its original ceremony token returns the same owner and session until the original five-minute challenge expiry; a changed credential is rejected. The receipt window does not extend on retry. After expiry, the native app must recover the expected owner with its existing passkey or explicitly confirm starting another account; an ambiguous failure must never create another owner automatically.

The new account form captures the original Idea before account details. Its local source remains protected until the first Project receipt proves persistence; signing in alone does not prove that the Idea was saved to a Project. Pending registration proof lives in a separate nonsynchronizing, device-only Keychain item so a lost verification reply or relaunch can retry the exact ceremony. After expiry, recovery verifies the expected owner's existing passkey. A separately confirmed **Start another account** action can abandon only that proof while retaining the Idea; the app never infers that an uncertain signup failed.

All pairing routes below are on the auth host and reject browser cookies, Origin, and Sec-Fetch-Site. Pairing codes expire after ten minutes. Agent connection credentials are never stored in cleartext in the registry or sent to the native app.

| Route | Authority and result |
| --- | --- |
| `POST /api/native-auth/agent-pairings` with `workspaceId`, `label` | Device starts a read/write request; returns `pairingId`, private `deviceToken`, public `userCode`, and expiry |
| `POST /api/native-auth/agent-pairings/inspect` with `userCode` | Native owner bearer; returns only a pairing for an owned Workspace, its label, scopes, and expiry |
| `POST /api/native-auth/agent-pairings/approve` with `userCode` | Native owner bearer verified within five minutes; atomically authorizes the exact Workspace and returns safe connection metadata |
| `POST /api/native-auth/agent-pairings/poll` with `pairingId`, `deviceToken` | Private device proof; returns pending, expiry, denial, or the approved credential and exact tenant API base URL |
| `GET /api/native-auth/agent-connections?workspaceId=...` | Native owner bearer; lists safe connection metadata for the owned Workspace |
| `DELETE /api/native-auth/agent-connections/:id?workspaceId=...` | Native owner bearer; revokes the matching owned Workspace connection |

The public approval code cannot claim a credential. The device must retain its independent secret to poll. The native app displays whole-Workspace read/write authority, verifies the same owner with a fresh passkey, and checks the returned connection before confirming consent. Approval and polling retries reuse the same connection. Revocation and account recovery prevent subsequent credential retrieval and API use.

The native app and portable Codex plugin are distributed separately. Releasing these backend routes does not establish that either client is published or that a user completed an end-to-end setup and handoff.

First Workspace setup uses a durable pending Project and fixed Project ID because access and board state use separate stores. The server returns success only after the Project is stored. An interrupted bootstrap is completed by the same owner’s retry or inventory read; it does not create another Project. The original Idea text is never trimmed or replaced, and later brief/completion-criteria changes require the normal Project revision check. Existing Projects without an Idea remain valid.

Browser CSRF checks stay in place. Native board writes record Activity channel `native`, which identifies the credential path and does not attest an app bundle. API-key scopes continue to apply to agent requests.

## Verify the release

Run the backend checks with isolated test data and a separate local RP:

```sh
npm run check
npm test
npm run test:browser
```

The native-auth tests use signed software assertions to check tenant isolation, challenge binding and replay, session expiry and revocation, recovery, browser-request rejection, and association-file configuration. Automated results do not establish physical-iPhone passkey support.

After the authorized release, verify the exact production deployment, public association file, Apple's CDN copy, real-device passkey sign-in, and the existing owner's Workspaces. Record the device ceremony separately from unit and browser tests. Claim real-device sign-in only after the signed app opens the intended owner's board.
