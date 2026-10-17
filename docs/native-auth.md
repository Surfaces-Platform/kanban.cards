# Native owner authentication

An iPhone or macOS app can use an existing owner's passkey to open the same Workspaces and board data as the browser. Native sign-in uses AuthenticationServices and a separate owner bearer session. Initial enrollment, recovery, and credential management remain browser operations.

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
| Auth | `POST /api/native-auth/challenge` with `{}` | Five-minute, single-use `challengeId`, `ceremonyToken`, `challenge`, `relyingPartyIdentifier`, and `expiresAt` |
| Auth | `POST /api/native-auth/verify` with `challengeId`, `ceremonyToken`, and `response` | Verifies the signed assertion and returns `authenticated`, `tokenType`, `token`, absolute `expiresAt`, `rootUrl`, and owner identity |
| Root | `GET /api/workspaces` | Current owner's Workspaces with their exact tenant URLs |
| Root | `POST /api/workspaces` with `name` and `slug` | Creates a private Workspace for the current owner and returns `201 {workspace}` with its exact tenant URL; duplicate addresses return 409 and the ten-Workspace limit returns 403 |
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

Owners can revoke a native session individually or end all sessions in browser access settings. Recovery revokes browser and native sessions, pending handoffs, old passkeys, and agent keys. Native sessions cannot create credentials, recover an account, or create agent keys.

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
