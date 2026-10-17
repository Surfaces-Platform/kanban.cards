/** Public website rules must never select signed-in Workbench surfaces. */
export function validatePublicWebsiteCss(source: string): string[] {
  const errors: string[] = [];
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if ((css.match(/@font-face\b/g) || []).length !== 1) errors.push("website.css must declare exactly one public Inter font face");
  const urls = Array.from(css.matchAll(/url\(([^)]+)\)/g), match => match[1].replace(/["']/g, "").trim());
  const allowedUrls = new Set(["/fonts/inter-latin.woff2", "/images/kanban-card-cascade.webp"]);
  if (urls.filter(url => url === "/fonts/inter-latin.woff2").length !== 1 || !urls.includes("/images/kanban-card-cascade.webp") || urls.some(url => !allowedUrls.has(url))) errors.push("website.css may load only the declared local Inter font and hero image");
  if (/@import\b|--jk-[\w-]+\s*:/i.test(css)) errors.push("website.css must not import assets or redefine Workbench tokens");
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const header = match[1].trim();
    if (header.startsWith("@")) {
      if (!/^@(?:font-face\b|media\b)/.test(header)) errors.push(`Unsupported website at-rule: ${header}`);
      continue;
    }
    let depth = 0;
    let selector = "";
    const selectors: string[] = [];
    for (const character of header) {
      if (character === "(" || character === "[") depth++;
      if (character === ")" || character === "]") depth--;
      if (character === "," && depth === 0) { selectors.push(selector.trim()); selector = ""; }
      else selector += character;
    }
    selectors.push(selector.trim());
    for (const value of selectors) {
      if (!/^(?:body)?\.public-website(?=$|[\s.:#\[>+~])/.test(value)) errors.push(`Unscoped website selector: ${value}`);
    }
  }
  return errors;
}
