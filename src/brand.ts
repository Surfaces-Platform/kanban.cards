export const BRAND_LOCKUP_ASSETS = [
  ["/brand-lockup.svg", "public/branding/brand-lockup.svg"],
  ["/brand-lockup-dark.svg", "public/branding/brand-lockup-dark.svg"]
] as const;

export function renderProductName(tag: "p" | "span" | "strong" = "p"): string {
  return `<${tag} class="product-name"><picture class="product-lockup"><source media="(prefers-color-scheme: dark)" srcset="/brand-lockup-dark.svg"><img src="/brand-lockup.svg" width="452" height="109" alt="kanban.cards"></picture></${tag}>`;
}
