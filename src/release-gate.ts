export const PROMOTION_CONFIRMATION = "PROMOTE EXACT VERIFIED CANDIDATE";

export interface TrustedReleaseTarget {
  projectId: string;
  teamId: string;
  repository: string;
  productionBranch: string;
  publicDomain: string;
  authDomain: string;
}

export function trustedReleaseTarget(): TrustedReleaseTarget {
  return {
    projectId: "prj_5DC7osq9fL2Ju8NMp6dgVz7dUas1",
    teamId: "team_Kw6YLfcGtRy40u9UEvifOh1r",
    repository: "Surfaces-Platform/kanban.cards",
    productionBranch: "main",
    publicDomain: "kanban.cards",
    authDomain: "auth.kanban.cards"
  };
}


export function isVercelSsoProtectionRedirect(
  status: number,
  location: unknown,
  requestedUrl: unknown,
  setCookie: unknown
): boolean {
  if (![302, 307].includes(status) || typeof location !== "string" || typeof requestedUrl !== "string" || typeof setCookie !== "string") return false;
  try {
    const requested = new URL(requestedUrl);
    const destination = new URL(location);
    const returnUrl = destination.searchParams.get("url");
    const nonce = destination.searchParams.get("nonce");
    const queryKeys = [...destination.searchParams.keys()].sort();
    return requested.protocol === "https:"
      && !requested.username
      && !requested.password
      && destination.origin === "https://vercel.com"
      && destination.pathname === "/sso-api"
      && !destination.hash
      && queryKeys.length === 2
      && queryKeys[0] === "nonce"
      && queryKeys[1] === "url"
      && returnUrl === requested.href
      && typeof nonce === "string"
      && /^[0-9a-f]{64}$/i.test(nonce)
      && /(?:^|,\s*)_vercel_sso_nonce=[A-Za-z0-9_-]{32,128}(?:;|,|$)/i.test(setCookie)
      && /;\s*Path=\//i.test(setCookie)
      && /;\s*Secure(?:;|,|$)/i.test(setCookie)
      && /;\s*HttpOnly(?:;|,|$)/i.test(setCookie);
  } catch {
    return false;
  }
}
