import { micromark } from "micromark";

export interface CardMarkdown {
  html: string;
  text: string;
  empty: boolean;
  failed: boolean;
}

const PASSIVE_ELEMENTS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul"
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeLinkDestination(value: string): string | null {
  try {
    const destination = new URL(value);
    if (destination.protocol !== "http:" && destination.protocol !== "https:" && destination.protocol !== "mailto:") return null;
    if ((destination.protocol === "http:" || destination.protocol === "https:") && !destination.host) return null;
    return destination.href;
  } catch {
    return null;
  }
}

function replaceImage(image: Element): void {
  const alt = image.getAttribute("alt")?.trim();
  const placeholder = document.createElement("span");
  placeholder.className = "markdown-image-placeholder";
  placeholder.textContent = alt ? `Image not shown: ${alt}` : "Image not shown";
  image.replaceWith(placeholder);
}

function sanitizeLink(link: Element): void {
  const label = link.textContent || "Link";
  const destination = safeLinkDestination(link.getAttribute("href") || "");
  if (!destination) {
    link.replaceWith(document.createTextNode(label));
    return;
  }

  for (const attribute of Array.from(link.attributes)) link.removeAttribute(attribute.name);
  link.setAttribute("href", destination);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  const hint = document.createElement("span");
  hint.className = "jk-visually-hidden markdown-link-hint";
  hint.textContent = " (opens in new tab)";
  link.append(hint);
}

function sanitizeElement(element: Element): void {
  const name = element.localName.toLowerCase();
  if (name === "img") {
    replaceImage(element);
    return;
  }
  if (!PASSIVE_ELEMENTS.has(name)) {
    element.replaceWith(document.createTextNode(element.textContent || ""));
    return;
  }
  if (name === "a") {
    sanitizeLink(element);
    return;
  }

  const orderedListStart = name === "ol" ? element.getAttribute("start") || "" : "";
  for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
  if (/^[1-9]\d*$/.test(orderedListStart)) element.setAttribute("start", orderedListStart);
}

function plainText(fragment: DocumentFragment): string {
  const copy = fragment.cloneNode(true) as DocumentFragment;
  for (const hint of copy.querySelectorAll(".markdown-link-hint")) hint.remove();
  return (copy.textContent || "").replace(/\s+/g, " ").trim();
}

function fallback(source: string): CardMarkdown {
  const html = `<p class="markdown-plain-fallback">${escapeHtml(source).replaceAll("\n", "<br>")}</p>`;
  return {
    html,
    text: source.replace(/\s+/g, " ").trim(),
    empty: false,
    failed: true
  };
}

export function renderCardMarkdown(source: string): CardMarkdown {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return { html: "", text: "", empty: true, failed: false };

  try {
    const template = document.createElement("template");
    template.innerHTML = micromark(normalized, {
      allowDangerousHtml: false,
      allowDangerousProtocol: false
    });
    for (const element of Array.from(template.content.querySelectorAll("*"))) sanitizeElement(element);
    return {
      html: template.innerHTML,
      text: plainText(template.content),
      empty: false,
      failed: false
    };
  } catch {
    return fallback(normalized);
  }
}
