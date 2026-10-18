export const PUBLIC_WEBSITE_ASSETS = [
  ["/website.css", "public/website.css", "text/css; charset=utf-8"],
  ["/fonts/inter-latin.woff2", "public/fonts/inter-latin.woff2", "font/woff2"],
  ["/fonts/OFL.txt", "public/fonts/OFL.txt", "text/plain; charset=utf-8"],
  ["/images/kanban-card-cascade.webp", "public/images/kanban-card-cascade.webp", "image/webp"]
] as const;

export function usesPublicWebsite(context: string, authenticated: boolean): boolean {
  return !authenticated && (context === "root" || context === "auth");
}

export const DEFAULT_PAGE_TITLE = "kanban.cards";
export const PUBLIC_HOME_TITLE = "Shared Kanban Board for People and Agents | kanban.cards";

interface PublicPageTitleState {
  context: string;
  authenticated: boolean;
  resolved: boolean;
  pending?: boolean;
  authMode?: string | null;
  recoveryCodePresent?: boolean;
  signedOut?: boolean;
}

/** Accept only resolved public state and finite labels, never private names or credential values. */
export function publicPageTitle(state: PublicPageTitleState): string {
  if (!state.resolved || state.pending || !usesPublicWebsite(state.context, state.authenticated)) return DEFAULT_PAGE_TITLE;
  if (state.context === "root") return state.signedOut ? "Signed out | kanban.cards" : PUBLIC_HOME_TITLE;
  if (state.recoveryCodePresent) return "Save your recovery code | kanban.cards";
  switch (state.authMode) {
    case "signin": return "Sign in | kanban.cards";
    case "signup": return "Create account | kanban.cards";
    case "recover": return "Recover your account | kanban.cards";
    case "setup": return "Set up your passkey | kanban.cards";
    case "add": return "Add a passkey | kanban.cards";
    case "verify": return "Confirm access | kanban.cards";
    default: return "Account access | kanban.cards";
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const workflow = [
  ["Turn a plan into Cards", "Create Cards for the work you want to track.", '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 8h6M9 12h6M9 16h3"/>'],
  ["Choose the next work", "Use the board and its filters to choose a Card.", '<path d="M4 6h16M4 12h10M4 18h6M16 14l3 3-3 3M19 17h-6"/>'],
  ["Perform the work", "Do the work in your own tools.", '<path d="M5 12l4 4L19 6M5 21h14"/>'],
  ["Update the Card", "Move it, edit it, or record progress in a Comment.", '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 8h8M8 12h5M8 16h3"/>'],
  ["Reconcile the Project with reality", "Review the board against what happened and what remains.", '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>']
] as const;

export function passkeyFormCopy(mode: string): { instruction: string; submitLabel: string } {
  if (mode === "recover") return {
    instruction: "Use your saved recovery code to create a replacement passkey. After verification, your previous passkeys, browser and app sessions, and agent keys stop working.",
    submitLabel: "Replace passkeys"
  };
  const registering = ["signup", "setup", "add"].includes(mode);
  return {
    instruction: registering ? "Use your device or password manager to save a passkey." : "Use your passkey to continue.",
    submitLabel: registering ? "Create passkey" : "Continue with passkey"
  };
}

export function renderPublicHomepage(actions: string, notice = ""): string {
  const steps = workflow.map(([title, explanation, icon], index) => `<li class="website-workflow-step"><div class="website-step-marker"><span class="website-ordinal">0${index + 1}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></div><div><h3>${title}</h3><p>${explanation}</p></div></li>`).join("");
  return `<main class="website-home"><section class="website-hero" aria-labelledby="home-title"><div class="website-shell"><div class="website-hero-copy"><p class="website-eyebrow">For owners and agents.</p><h1 id="home-title">Turn a plan into Cards.</h1><p class="website-lead">A shared board where you and your agents record work and its progress.</p><div class="website-hero-actions">${actions}</div>${notice}</div></div></section><section id="workload" class="website-problem" aria-labelledby="problem-title"><div class="website-shell"><p class="website-eyebrow">From plans to work</p><h2 id="problem-title">Keep the work and its updates together.</h2><ol class="website-problem-row"><li><span class="website-ordinal">01</span><h3>Cards describe the work</h3><p>Record a task and its next action.</p></li><li><span class="website-ordinal">02</span><h3>Columns show its status</h3><p>Move a Card as work progresses.</p></li><li><span class="website-ordinal">03</span><h3>Comments keep the updates</h3><p>Record context or progress on the Card.</p></li></ol></div></section><section id="how-it-works" class="website-workflow" aria-labelledby="workflow-title"><div class="website-shell"><p class="website-eyebrow">How it works</p><h2 id="workflow-title">Keep the Project current.</h2><ol class="website-workflow-row">${steps}</ol><p class="website-support">An installed skill with read and write access lets your agent read and update the board.</p></div></section></main>`;
}

export function renderPublicWebsite(content: string, rootUrl: string, utilities = ""): string {
  const home = escapeAttribute(rootUrl || "/");
  const brand = `<a class="website-brand" href="${home}" aria-label="kanban.cards home"><img src="/brand-lockup-dark.svg" width="452" height="109" alt=""></a>`;
  const links = `<a href="${home}#workload">The work</a><a href="${home}#how-it-works">How it works</a><a href="https://surfaces.systems/">Surfaces</a><a href="https://handbooks.surfaces.systems/">Handbooks</a>`;
  const main = content.replace(/^<main\b/, '<main id="public-main" tabindex="-1"');
  return `<div class="website-frame"><a class="website-skip-link" href="#public-main">Skip to main content</a><header class="website-header"><div class="website-shell website-header-inner">${brand}<nav class="website-navigation" aria-label="Main navigation">${links}</nav><details class="website-menu"><summary aria-expanded="false" aria-controls="website-mobile-navigation">Menu<svg class="website-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path class="website-menu-bars" d="M4.5 6.75h15M4.5 12h15M4.5 17.25h15"/><path class="website-menu-close" d="M6 6l12 12M6 18 18 6"/></svg></summary><nav id="website-mobile-navigation" aria-label="Main navigation">${links}</nav></details></div></header>${main}<footer class="website-footer"><div class="website-shell website-footer-inner">${brand}<div class="website-footer-copy"><p>A shared board for owners and agents.</p><p>© ${new Date().getFullYear()} kanban.cards</p></div>${utilities ? `<div class="website-footer-utilities">${utilities}</div>` : ""}</div></footer></div>`;
}
