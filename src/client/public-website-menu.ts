function publicMenu(): HTMLDetailsElement | null {
  return document.body.classList.contains("public-website")
    ? document.querySelector<HTMLDetailsElement>(".website-menu")
    : null;
}

// Synchronize only public navigation; never rerender forms or private screens.
export function syncPublicWebsiteMenu(): void {
  const menu = publicMenu();
  menu?.querySelector("summary")?.setAttribute("aria-expanded", String(menu.open));
  document.body.classList.toggle("website-menu-open", Boolean(menu?.open));
}

function closeMenu(restoreFocus = false): void {
  const menu = publicMenu();
  if (menu) menu.open = false;
  syncPublicWebsiteMenu();
  if (restoreFocus) menu?.querySelector<HTMLElement>("summary")?.focus();
}

document.addEventListener("toggle", event => {
  if (event.target instanceof HTMLDetailsElement && event.target.classList.contains("website-menu")) syncPublicWebsiteMenu();
}, { capture: true });

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !document.body.classList.contains("public-website")) return;
  const menu = document.querySelector<HTMLDetailsElement>(".website-menu[open]");
  if (!menu) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeMenu(true);
}, { capture: true });

document.addEventListener("click", event => {
  if (!document.body.classList.contains("public-website")) return;
  const menu = document.querySelector<HTMLDetailsElement>(".website-menu[open]");
  if (menu && event.target instanceof Node && (!menu.contains(event.target) || (event.target instanceof Element && event.target.closest("a")))) closeMenu();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 820) closeMenu();
});
