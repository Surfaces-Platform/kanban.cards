import { BRAND_WEB_ASSETS } from "./brand-web-assets";

export const BRAND_LOCKUP_ASSETS = [
  ["/brand-lockup.svg", "public/branding/brand-lockup.svg"],
  ["/brand-lockup-dark.svg", "public/branding/brand-lockup-dark.svg"]
] as const;

export const BRAND_PUBLIC_ASSETS = [
  ...BRAND_LOCKUP_ASSETS.map(([route, file]) => [route, file, "image/svg+xml"] as const),
  ...BRAND_WEB_ASSETS
] as const;

export function renderBrandHead(): string {
  return `  <meta name="description" content="A simple Kanban board for projects run by you and your agents.">
  <meta name="application-name" content="kanban.cards">
  <meta name="apple-mobile-web-app-title" content="kanban.cards">
  <meta name="theme-color" content="#f8f7f2" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#101312" media="(prefers-color-scheme: dark)">
  <link rel="canonical" href="https://kanban.cards/">
  <link rel="icon" href="/favicon-v2.ico" sizes="16x16 32x32 48x48">
  <link rel="icon" href="/favicon-v2-light-16.png" type="image/png" sizes="16x16" media="(prefers-color-scheme: light)">
  <link rel="icon" href="/favicon-v2-dark-16.png" type="image/png" sizes="16x16" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="/favicon-v2-light-32.png" type="image/png" sizes="32x32" media="(prefers-color-scheme: light)">
  <link rel="icon" href="/favicon-v2-dark-32.png" type="image/png" sizes="32x32" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="/favicon-v2.svg" type="image/svg+xml" sizes="any">
  <link rel="icon" href="/favicon-v2-light.svg" type="image/svg+xml" sizes="any" media="(prefers-color-scheme: light)">
  <link rel="icon" href="/favicon-v2-dark.svg" type="image/svg+xml" sizes="any" media="(prefers-color-scheme: dark)">
  <link rel="apple-touch-icon" href="/apple-touch-icon-v2.png" sizes="180x180">
  <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#0B0D0E">
  <link rel="manifest" href="/site.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="kanban.cards">
  <meta property="og:title" content="kanban.cards">
  <meta property="og:description" content="A simple Kanban board for projects run by you and your agents.">
  <meta property="og:url" content="https://kanban.cards/">
  <meta property="og:image" content="https://kanban.cards/social-brand-v2.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="kanban.cards Split K mark and wordmark">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="kanban.cards">
  <meta name="twitter:description" content="A simple Kanban board for projects run by you and your agents.">
  <meta name="twitter:image" content="https://kanban.cards/social-brand-v2.png">
  <meta name="twitter:image:alt" content="kanban.cards Split K mark and wordmark">`;
}

export function renderProductName(tag: "p" | "span" | "strong" = "p"): string {
  return `<${tag} class="product-name"><picture class="product-lockup"><source media="(prefers-color-scheme: dark)" srcset="/brand-lockup-dark.svg"><img src="/brand-lockup.svg" width="452" height="109" alt="kanban.cards"></picture></${tag}>`;
}
