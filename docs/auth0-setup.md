# Auth0 Setup

kanban.cards uses the SurfacesPlatform Auth0/OIDC contract with a local session implementation.

## Application

Use the shared Surfaces Auth0 Regular Web Application for `surfaces.us.auth0.com`.

Production settings:

- Allowed Callback URLs: `https://kanban.cards/auth/callback`
- Allowed Logout URLs: `https://kanban.cards/`, `https://kanban.cards/auth/logout/complete`
- Allowed Web Origins: `https://kanban.cards`

Local settings:

- Allowed Callback URLs: `http://127.0.0.1:4317/auth/callback`
- Allowed Logout URLs: `http://127.0.0.1:4317/`, `http://127.0.0.1:4317/auth/logout/complete`
- Allowed Web Origins: `http://127.0.0.1:4317`

Keep the existing Surfaces callback and logout URLs in the same application.

## Post Login Action

The Post Login Action must set these ID token claims:

- `https://surfaces.systems/workspace_id`
- `https://surfaces.systems/surface_access`

`surface_access` must include `kanban.cards`.

Example:

```js
exports.onExecutePostLogin = async (event, api) => {
  const workspaceId =
    event.user.app_metadata?.workspace_id ||
    `ws_${event.user.user_id.replace(/\|/g, "_")}`;

  api.idToken.setCustomClaim("https://surfaces.systems/workspace_id", workspaceId);

  const surfaceAccess =
    event.user.app_metadata?.surface_access ||
    [
      "surfaces.systems",
      "surfaceops.ai",
      "interfacectl.com",
      "surfaces.dev",
      "kanban.cards",
    ];

  api.idToken.setCustomClaim("https://surfaces.systems/surface_access", surfaceAccess);
};
```

Save and deploy the Action, then attach it to the `post-login` trigger.

## Runtime

Production requires:

- `KANBAN_CARDS_API_TOKEN`
- `KANBAN_CARDS_DATABASE_URL`, `POSTGRES_URL`, or `DATABASE_URL`
- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_REDIRECT_URI=https://kanban.cards/auth/callback`
- `SESSION_SECRET`
- `PLATFORM_SURFACE_ID=kanban.cards`

Optional:

- `OIDC_CLIENT_SECRET`
- `OIDC_LOGOUT_URL`
- `OIDC_POST_LOGOUT_REDIRECT_URI=https://kanban.cards/auth/logout/complete`
- `SESSION_TTL_SECONDS`

## Smoke Checks

- `GET /api/health` returns `ok: true`.
- Browser requests without a session redirect to `/auth/login`.
- API requests without auth return `401`.
- Login succeeds and `/auth/session` returns `workspaceId`, `teamId`, and `projectId`.
- Logout clears the session and returns to kanban.cards.

Common failures:

- `Callback URL mismatch`: the exact callback URL is missing from the Auth0 application.
- `AUTH_SURFACE_DENIED`: `surface_access` does not include `kanban.cards`.
- `AUTH_MISSING_WORKSPACE`: the Post Login Action did not set `workspace_id`.
