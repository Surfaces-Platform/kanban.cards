# Operate kanban.cards

Owners sign in with passkeys. Agents use scoped API keys on one Workspace host. Production keeps the existing Postgres board and access-registry rows.

## Configure the server

Use Node.js 22. Set these values in the server's environment:

| Variable | Value |
| --- | --- |
| `KANBAN_CARDS_DATABASE_URL` | Existing production Postgres connection |
| `SESSION_SECRET` | Stable random secret of at least 32 bytes |
| `KANBAN_CARDS_ROOT_HOST` | `kanban.cards` |
| `KANBAN_CARDS_AUTH_HOST` | `auth.kanban.cards` |

`POSTGRES_URL` or `DATABASE_URL` can provide the database connection. Keep secrets in the hosting environment. Local development may use `board.localhost:4317` and `auth.board.localhost:4317` with isolated JSON data.

The auth host runs passkey ceremonies with RP ID `auth.kanban.cards`. It denies Workspace and board-data APIs. Owners get host-only browser sessions that last 365 days from sign-in. Root and Workspace cookie lifetimes follow the server session's remaining lifetime. Activity and identity verification do not extend expiry. Sessions issued before this lifetime change retain their original expiry; sign in again after release to start a 365-day session. Temporary sign-in cookies still last ten minutes. Production accepts scoped agent credentials and passkey sessions; the global bearer bridge is disabled.

## Enroll Mike's first passkey

Use Mike's existing internal owner ID from the access registry. Keep that owner ID, Workspace memberships, storage IDs, board state, and agent-key hashes intact.

1. When the replacement is ready to release, run `npm run auth:setup -- --owner <existing-owner-id> --out .local/owner-setup.json` in the trusted local checkout.
2. Configure the returned `KANBAN_CARDS_SETUP_OWNER_ID`, `KANBAN_CARDS_SETUP_TOKEN_HASH`, and `KANBAN_CARDS_SETUP_EXPIRES_AT` values on the intended server. The raw token stays only in the local file, created with mode `0600` and a one-hour expiry.
3. After the authorized release, open the setup form, paste the token from that file, and create a passkey. Save the recovery code.
4. Open Mike's existing Workspace and verify the Projects, Cards, comments, and Activity.
5. Remove the setup environment values after enrollment. Setup is permanently consumed in the registry.

If the one-hour token expires before enrollment, generate a replacement using a new local output filename and update the three setup environment values. Release a fresh Git build before using the replacement: changing environment values in Vercel does not update the running deployment.

Public signup creates a new owner and private Workspace after passkey verification. It cannot claim an existing owner by email or receive Mike's board. The replacement uses one release; no coexistence deployment is required.

## Fast lane: ordinary product changes

Vercel Git deployments from `main` remain enabled. **Auto-assign Custom Production Domains** remains disabled. Deployment protection stays `all_except_custom_domains`, keeping generated deployment URLs protected and permanent production domains public.

1. Review the intended diff and run proportional local checks. Open a PR and wait for required hosted checks and approvals.
2. Merge the validated change. Sync a clean local `main` to that exact commit.
3. Run `npm run release:preflight`. Check the staged deployment ID, commit SHA, linked Project, health, permanent domains, and protection result.
4. Obtain explicit production authorization for that candidate. Then run:

   ```bash
   npm run release:promote -- --deployment <deploymentId> --confirmation "PROMOTE EXACT VERIFIED CANDIDATE"
   ```

5. Confirm that the returned post-promotion result passes and the public root, auth host, and tenant host point to the exact deployment. Check the feature or fix covered by the release in production.

The command promotes only the exact staged Git artifact for clean `main`. A merge, a READY deployment, or a passing local test does not establish production delivery. The controller records deployment identities locally and does not bypass Vercel protection.

## Sensitive lane: auth, authorization, and data boundaries

Use the same single-release command and explicit authorization. Before promoting an authentication or data change, collect the following evidence:

1. Run `npm run check`, `npm test`, and `npm run test:browser` against isolated data. Use a separate local RP so test credentials cannot become production credentials.
2. Check passkey signup and sign-in, challenge expiry and replay, recovery, session revocation, exact origins, CSRF, and browser-bound handoffs.
3. Use two owners and Workspaces to check tenant isolation. Confirm that signup cannot claim the existing owner and that scoped API keys enforce Workspace, scope, expiry, and revocation.
4. Complete a real-device passkey check. Record automated results separately from device and production evidence.
5. After authorized promotion, verify Mike's existing board, a new private Workspace, and scoped CLI access.

The candidate must report `authentication: passkey-session+workspace`, a ready access registry, readable existing state or `not-required`, no missing configuration, and `legacyBridge: disabled`. Production verification must use the exact promoted artifact.

Once the replacement is working, disconnect the old Clerk Marketplace integration, remove its environment variables, and remove its FAPI DNS records. Retain `auth.kanban.cards` for passkeys. These external changes need their own returned evidence before reporting them complete.

## Manage access

1. Add a second passkey from access settings. Credential changes and key creation require passkey verification within five minutes.
2. Create a named scoped API key for each agent. Supply it through the CLI's `setup --token-stdin` command with the Workspace's `https://<workspace>.kanban.cards/api` origin. The key appears once and is stored as a hash on the server.
3. Rotate an agent key by creating a replacement, updating and checking the client, then revoking the old key.
4. End sessions or revoke passkeys in access settings. Keep at least one usable passkey and save the recovery code safely.
5. Use the single-use recovery code to enroll a replacement passkey if needed. Recovery revokes old passkeys, sessions, handoffs, and agent keys and issues a new code. Reconnect agents afterward.

A lost recovery code cannot be recovered from its server-side hash. An owner who loses every passkey and the recovery code cannot recover the account in this version.

## Check service health

`GET /api/health` reports runtime storage and authentication readiness. `GET /api/access/health` reports the access registry and existing Workspace state. Investigate an unavailable registry or state before attempting production promotion.

`npm run db:init` is an optional manual initializer when the database URL is already configured. The initializer does not establish that production data was preserved. Do not point local tests at the production database.
