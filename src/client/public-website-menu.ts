// These listeners never rerender forms or run on signed-in Workbench screens.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !document.body.classList.contains("public-website")) return;
  const menu = document.querySelector<HTMLDetailsElement>(".website-menu[open]");
  if (!menu) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  menu.open = false;
  menu.querySelector<HTMLElement>("summary")?.focus();
}, { capture: true });

document.addEventListener("click", event => {
  if (!document.body.classList.contains("public-website")) return;
  const menu = document.querySelector<HTMLDetailsElement>(".website-menu[open]");
  if (menu && event.target instanceof Node && (!menu.contains(event.target) || (event.target instanceof Element && event.target.closest("a")))) menu.open = false;
});
