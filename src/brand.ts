import { BRAND_ICON_REVISION, BRAND_WEB_ASSETS } from "./brand-web-assets";
import { PUBLIC_HOME_TITLE } from "./public-website";

export const BRAND_LOCKUP_ASSETS = [
  ["/brand-lockup.svg", "public/branding/brand-lockup.svg"],
  ["/brand-lockup-dark.svg", "public/branding/brand-lockup-dark.svg"]
] as const;

export const BRAND_PUBLIC_ASSETS = [
  ...BRAND_LOCKUP_ASSETS.map(([route, file]) => [route, file, "image/svg+xml"] as const),
  ...BRAND_WEB_ASSETS
] as const;

export function renderBrandHead(): string {
  return `  <meta name="description" content="A shared board where you and your agents record work and its progress.">
  <meta name="application-name" content="kanban.cards">
  <meta name="apple-mobile-web-app-title" content="kanban.cards">
  <meta name="theme-color" content="#f8f7f2" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#101312" media="(prefers-color-scheme: dark)">
  <link rel="canonical" href="https://kanban.cards/">
  <script src="/favicon-theme-${BRAND_ICON_REVISION}.js" data-light-icon="/favicon-${BRAND_ICON_REVISION}-light.ico" data-dark-icon="/favicon-${BRAND_ICON_REVISION}-dark.ico"></script>
  <noscript><link rel="icon" href="/favicon-${BRAND_ICON_REVISION}-light.ico" type="image/x-icon" sizes="16x16 32x32 48x48"></noscript>
  <link rel="apple-touch-icon" href="/apple-touch-icon-${BRAND_ICON_REVISION}.png" sizes="180x180">
  <link rel="mask-icon" href="/safari-pinned-tab-${BRAND_ICON_REVISION}.svg" color="#0B0D0E">
  <link rel="manifest" href="/site-${BRAND_ICON_REVISION}.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="kanban.cards">
  <meta property="og:title" content="${PUBLIC_HOME_TITLE}">
  <meta property="og:description" content="A shared board where you and your agents record work and its progress.">
  <meta property="og:url" content="https://kanban.cards/">
  <meta property="og:image" content="https://kanban.cards/social-brand-v2.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="kanban.cards Split K mark and wordmark">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${PUBLIC_HOME_TITLE}">
  <meta name="twitter:description" content="A shared board where you and your agents record work and its progress.">
  <meta name="twitter:image" content="https://kanban.cards/social-brand-v2.png">
  <meta name="twitter:image:alt" content="kanban.cards Split K mark and wordmark">`;
}

export function renderProductName(tag: "p" | "span" | "strong" = "p"): string {
  return `<${tag} class="product-name"><picture class="product-lockup"><source media="(prefers-color-scheme: dark)" srcset="/brand-lockup-dark.svg"><img src="/brand-lockup.svg" width="452" height="109" alt="kanban.cards"></picture></${tag}>`;
}
