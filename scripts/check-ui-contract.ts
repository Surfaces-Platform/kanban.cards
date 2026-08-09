import { readFile } from "node:fs/promises";
import path from "node:path";

interface Violation {
  file: string;
  line: number;
  reason: string;
  code: string;
}

interface SourceFile {
  file: string;
  source: string;
}

const approvedRawControlFunctions = new Set([
  "renderTextInput",
  "renderTextArea",
  "renderSelect"
]);

const forbiddenProductTerms = [
  /\bteam settings\b/i,
  /\bteam members?\b/i,
  /\bmemberships?\b/i,
  /\brole management\b/i,
  /\bpermission settings\b/i,
  /\bagent identities?\b/i,
  /\bagent sessions?\b/i,
  /\bdelegated sessions?\b/i,
  /\bcapabilities\b/i,
  /\breviewers?\b/i,
  /\breview gates?\b/i,
  /\bapprovals?\b/i,
  /\bdelivered\b/i,
  /\bgenerate flow\b/i,
  /\bflow templates?\b/i
];

const requiredRenderFunctions = [
  "renderProjectContext",
  "renderProjectActions",
  "renderColumnGrid",
  "renderCardInspector",
  "renderProjectEditor",
  "renderMobileColumnSelector",
  "renderComments",
  "renderActivity"
];

const requiredUiStates = [
  "opening",
  "signed-out",
  "invalid-key",
  "empty-workspace",
  "empty-project",
  "populated",
  "selected",
  "refreshing",
  "refresh-success",
  "refresh-failure",
  "saving",
  "validation-error",
  "stale",
  "session-expired",
  "service-unavailable",
  "archived",
  "sign-out-success"
];

const requiredJudgmentKitTokens = [
  "--jk-color-canvas",
  "--jk-color-surface",
  "--jk-color-text",
  "--jk-color-muted",
  "--jk-color-border",
  "--jk-color-focus",
  "--jk-color-success",
  "--jk-color-warning",
  "--jk-color-risk",
  "--jk-color-disabled",
  "--jk-color-receipt",
  "--jk-space-2",
  "--jk-space-3",
  "--jk-space-4",
  "--jk-radius-control",
  "--jk-radius-panel",
  "--jk-focus-ring"
];

const requiredApplicationTokenUses = [
  "--jk-color-surface",
  "--jk-color-text",
  "--jk-color-muted",
  "--jk-color-border",
  "--jk-color-focus",
  "--jk-color-risk"
];

const requiredActions: Array<{ capability: string; actions: string[] }> = [
  { capability: "Project creation", actions: ["new-project"] },
  { capability: "Project editing", actions: ["edit-project", "project-settings"] },
  { capability: "explicit Project Refresh", actions: ["refresh-project"] },
  { capability: "Card creation", actions: ["new-card"] },
  { capability: "Card selection", actions: ["open-card"] },
  { capability: "nonmodal Card Close", actions: ["close-card", "close-inspector"] },
  { capability: "stale retry", actions: ["retry-stale", "retry-save"] },
  { capability: "stale discard", actions: ["discard-stale", "discard-draft"] },
  { capability: "non-destructive archive", actions: ["archive-card"] },
  { capability: "archive recovery", actions: ["undo-archive"] },
  { capability: "Sign out", actions: ["sign-out", "logout"] }
];

const controlPattern = /<\s*(input|select|textarea)\b/i;
const forbiddenStoragePattern = /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:token|access.?key|owner.?key)/i;
const clientTokenGlobalPattern = /KANBAN_CARDS_(?:API_)?TOKEN/i;
const literalColorPattern = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;

function lineNumber(source: string, index: number): number {
  return source.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function sourceLine(source: string, index: number): string {
  return source.split(/\r?\n/)[lineNumber(source, index) - 1]?.trim() || "";
}

function addViolation(
  violations: Violation[],
  file: string,
  source: string,
  index: number,
  reason: string,
  code = sourceLine(source, index)
): void {
  violations.push({ file, line: lineNumber(source, index), reason, code });
}

function currentFunctionName(lines: string[], lineIndex: number): string {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
    if (match) return match[1];
  }
  return "";
}

function functionSection(source: string, name: string): string {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  if (!match) return "";
  const rest = source.slice(match.index + match[0].length);
  const nextFunction = /\n(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.exec(rest);
  return source.slice(match.index, nextFunction ? match.index + match[0].length + nextFunction.index : source.length);
}

function firstMatchViolation(
  violations: Violation[],
  file: SourceFile,
  pattern: RegExp,
  reason: string
): void {
  const match = pattern.exec(file.source);
  if (match) addViolation(violations, file.file, file.source, match.index, reason);
}

async function readSource(
  filePath: string,
  file: string,
  violations: Violation[]
): Promise<SourceFile> {
  try {
    return { file, source: await readFile(filePath, "utf8") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    violations.push({ file, line: 1, reason: "required UI contract source is missing or unreadable", code: detail });
    return { file, source: "" };
  }
}

function report(violations: Violation[]): never {
  console.error("V2 UI contract violations found:");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}: ${violation.reason}`);
    if (violation.code) console.error(`  ${violation.code}`);
  }
  process.exit(1);
}

function checkApplicationSource(app: SourceFile, violations: Violation[]): void {
  const lines = app.source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const functionName = currentFunctionName(lines, index);
    if (controlPattern.test(line) && !approvedRawControlFunctions.has(functionName)) {
      violations.push({
        file: app.file,
        line: index + 1,
        reason: `raw form control outside approved primitive (${functionName || "top-level"})`,
        code: line.trim()
      });
    }
    if (forbiddenStoragePattern.test(line)) {
      violations.push({
        file: app.file,
        line: index + 1,
        reason: "access credentials must never be persisted in browser storage",
        code: line.trim()
      });
    }
    if (clientTokenGlobalPattern.test(line)) {
      violations.push({
        file: app.file,
        line: index + 1,
        reason: "client token globals are outside the cookie-session authentication boundary",
        code: line.trim()
      });
    }
    for (const term of forbiddenProductTerms) {
      if (term.test(line)) {
        violations.push({
          file: app.file,
          line: index + 1,
          reason: `out-of-scope product concept (${term.source})`,
          code: line.trim()
        });
      }
    }

    const storageCall = line.match(/(?:window\.)?(localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(([^)]*)/);
    if (storageCall) {
      const literalKey = storageCall[2].match(/^\s*["']([^"']+)["']/)?.[1];
      if (storageCall[1] !== "localStorage" || literalKey !== "kanban.cards:project-id") {
        violations.push({
          file: app.file,
          line: index + 1,
          reason: "browser storage is limited to the non-secret active Project id",
          code: line.trim()
        });
      }
    }
  });

  firstMatchViolation(
    violations,
    app,
    /(?:URLSearchParams|searchParams|location\.(?:search|hash))[^\n]*(?:token|access.?key|owner.?key)/i,
    "access credentials must never enter a URL"
  );
  firstMatchViolation(
    violations,
    app,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:token|access.?key|owner.?key)/i,
    "access credentials must never be logged"
  );

  const requiredRequestFragments = [
    {
      fragment: 'headers.set("X-Kanban-Version", String(options.revision))',
      reason: "resource edits must send X-Kanban-Version"
    },
    {
      fragment: 'headers.set("Idempotency-Key",',
      reason: "resource creates must support Idempotency-Key"
    },
    {
      fragment: 'credentials: "same-origin"',
      reason: "the browser must use the secure same-origin session cookie"
    },
    {
      fragment: 'api("/session", { method: "DELETE" })',
      reason: "Sign out must delete the browser session"
    }
  ];
  for (const requirement of requiredRequestFragments) {
    if (!app.source.includes(requirement.fragment)) {
      violations.push({ file: app.file, line: 1, reason: requirement.reason, code: requirement.fragment });
    }
  }
  firstMatchViolation(
    violations,
    app,
    /headers\.set\(["']If-Match["']/,
    "If-Match conflicts with hosted response precondition handling"
  );
  firstMatchViolation(
    violations,
    app,
    /headers\.set\(["']Idempotency-Key["']\s*,\s*uniqueKey\s*\(/,
    "POST retries must reuse an operation-scoped idempotency key rather than generate one per request"
  );
  for (const semanticMarker of ["idempotencyKeyFor", "refreshCommittedProject"]) {
    if (!functionSection(app.source, semanticMarker)) {
      violations.push({
        file: app.file,
        line: 1,
        reason: `committed-write recovery boundary is missing (${semanticMarker})`,
        code: `function ${semanticMarker}(...)`
      });
    }
  }

  const defaults = /const\s+(?:DEFAULT_COLUMNS|NEW_PROJECT_COLUMNS)\s*=\s*(\[[\s\S]*?\])/.exec(app.source);
  const defaultNames = defaults
    ? [...defaults[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
    : [];
  if (JSON.stringify(defaultNames) !== JSON.stringify(["Next", "Doing", "Done"])) {
    addViolation(
      violations,
      app.file,
      app.source,
      defaults?.index || 0,
      "new Projects must default to exactly Next, Doing, and Done without constraining existing Projects",
      defaultNames.length ? JSON.stringify(defaultNames) : "missing DEFAULT_COLUMNS or NEW_PROJECT_COLUMNS"
    );
  }

  for (const functionName of requiredRenderFunctions) {
    if (!functionSection(app.source, functionName)) {
      violations.push({
        file: app.file,
        line: 1,
        reason: `accepted Context Dock semantic renderer is missing (${functionName})`,
        code: `function ${functionName}(...)`
      });
    }
  }

  const inspector = functionSection(app.source, "renderCardInspector");
  if (inspector) {
    const inspectorIndex = app.source.indexOf(inspector);
    if (!/<aside\b/i.test(inspector) || !/aria-labelledby=/.test(inspector)) {
      addViolation(
        violations,
        app.file,
        app.source,
        inspectorIndex,
        "Card detail must be a labeled on-demand inspector"
      );
    }
    const modal = /role=["']dialog["']|aria-modal=/.exec(inspector);
    if (modal) {
      addViolation(
        violations,
        app.file,
        app.source,
        inspectorIndex + modal.index,
        "Card inspector must remain nonmodal"
      );
    }
  }
  if (inspector && !/if\s*\(\s*!card\s*&&\s*!creatingCard\s*\)\s*return\s*["']{2}/.test(inspector)) {
    addViolation(violations, app.file, app.source, app.source.indexOf(inspector), "Card inspector must render only when a Card is selected or being created");
  }
  if (inspector && /Save Card|card-column-input/.test(inspector)) {
    addViolation(violations, app.file, app.source, app.source.indexOf(inspector), "selected Card detail must use blur autosave without Save or Column controls");
  }
  firstMatchViolation(
    violations,
    app,
    /renderCardDrawer|class=["'][^"']*card-drawer|overlay\.kind\s*===\s*["']card["']/,
    "legacy modal Card drawer is outside the accepted Context Dock direction"
  );

  const projectActions = functionSection(app.source, "renderProjectActions");
  if (projectActions && !/refresh-project/.test(projectActions)) {
    addViolation(violations, app.file, app.source, app.source.indexOf(projectActions), "Kanban surface Actions must keep explicit Refresh available");
  }

  const editor = functionSection(app.source, "renderProjectEditor");
  if (editor && !/(?:project|draft)\.columns\.map\s*\(/.test(editor)) {
    addViolation(
      violations,
      app.file,
      app.source,
      app.source.indexOf(editor),
      "Project editor must map every stored Column rather than assume the new-Project default count"
    );
  }
  firstMatchViolation(
    violations,
    app,
    /project\.columns\.slice\(\s*0\s*,\s*3\s*\)|project\.columns\.length\s*[!=]==?\s*3/,
    "existing Projects with additional Columns must not be truncated or rejected solely for exceeding three Columns"
  );

  const mobileSelector = functionSection(app.source, "renderMobileColumnSelector");
  if (mobileSelector && !/renderSelect\s*\(/.test(mobileSelector)) {
    addViolation(
      violations,
      app.file,
      app.source,
      app.source.indexOf(mobileSelector),
      "narrow screens must use an explicit native Column selector"
    );
  }
  const activity = functionSection(app.source, "renderActivity");
  if (activity && !/role=["']tabpanel["']/.test(activity)) {
    addViolation(violations, app.file, app.source, app.source.indexOf(activity), "Activity must be a distinct top-level inspector tab panel");
  }
  const comments = functionSection(app.source, "renderComments");
  if (comments && /renderActivity|Recent activity|<details\b|Conversation|No Comments|contextual attribution|not verified identit|jk-count/.test(comments)) {
    addViolation(violations, app.file, app.source, app.source.indexOf(comments), "Comments must remain separate from Activity and omit review-only explanatory chrome");
  }

  if (!functionSection(app.source, "performCardAutosave") || !/addEventListener\(["']focusout["']/.test(app.source)) {
    violations.push({ file: app.file, line: 1, reason: "surface-integrated Card fields must serialize autosave on blur", code: "expected performCardAutosave and delegated focusout handling" });
  }

  if (!/(?:retainedDrafts|cardDrafts)\s*=\s*new Map/.test(app.source)) {
    violations.push({ file: app.file, line: 1, reason: "per-Card retained-draft storage is missing", code: "const retainedDrafts = new Map(...)" });
  }
  for (const semanticMarker of ["clearPrivateState", "setWorkspaceMutationsDisabled"]) {
    if (!functionSection(app.source, semanticMarker)) {
      violations.push({ file: app.file, line: 1, reason: `required client-state boundary is missing (${semanticMarker})`, code: `function ${semanticMarker}(...)` });
    }
  }
  const privateClearCalls = app.source.match(/clearPrivateState\s*\(/g)?.length || 0;
  if (privateClearCalls < 3) {
    violations.push({
      file: app.file,
      line: 1,
      reason: "Sign out and authenticated 401 handling must reuse the same private-state clearing boundary",
      code: `clearPrivateState occurrences: ${privateClearCalls}`
    });
  }
  if (!/(?:archiveUndo|archiveReceipt)/.test(app.source)) {
    violations.push({ file: app.file, line: 1, reason: "durable archive receipt and Undo state are missing", code: "expected archiveUndo or archiveReceipt state" });
  }

  const stateRegistry = /const\s+UI_CONTRACT_STATES\s*=\s*\[([\s\S]*?)\]/.exec(app.source);
  const registeredStates = stateRegistry
    ? new Set([...stateRegistry[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]))
    : new Set<string>();
  const missingStates = requiredUiStates.filter((state) => !registeredStates.has(state));
  if (missingStates.length) {
    addViolation(
      violations,
      app.file,
      app.source,
      stateRegistry?.index || 0,
      "required production UI state registry is incomplete",
      `missing: ${missingStates.join(", ")}`
    );
  }

  for (const requirement of requiredActions) {
    if (!requirement.actions.some((action) => app.source.includes(`"${action}"`) || app.source.includes(`'${action}'`))) {
      violations.push({
        file: app.file,
        line: 1,
        reason: `${requirement.capability} action is missing`,
        code: `expected one of: ${requirement.actions.join(", ")}`
      });
    }
  }

  const declaredActions = new Set<string>();
  for (const match of app.source.matchAll(/data-action=["']([^"'${}]+)["']/g)) declaredActions.add(match[1]);
  for (const match of app.source.matchAll(/renderButton\([^,\n]+,\s*["']([^"']+)["']/g)) declaredActions.add(match[1]);
  for (const action of declaredActions) {
    const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handled = new RegExp(`action\\s*===\\s*["']${escaped}["']|case\\s+["']${escaped}["']|["']${escaped}["']\\s*:`).test(app.source);
    if (!handled) {
      const index = app.source.indexOf(action);
      addViolation(violations, app.file, app.source, index, "declared UI action has no handler", action);
    }
  }

  firstMatchViolation(
    violations,
    app,
    /focus-workspace|project-rail|navigation-rail/i,
    "comparison direction or permanent Project rail must not ship in the production client"
  );
}

function checkStaticShell(html: SourceFile, violations: Violation[]): void {
  if (!html.source.includes('id="app"')) {
    violations.push({ file: html.file, line: 1, reason: "static app shell is missing", code: "" });
  }
  firstMatchViolation(
    violations,
    html,
    /<(?:input|select|textarea)\b/i,
    "static shell must not collect credentials or Project data"
  );
  firstMatchViolation(
    violations,
    html,
    /https?:\/\//i,
    "static shell must not import external assets"
  );

  const approvedThemeColorMeta = [
    '<meta name="theme-color" content="#f8f7f2" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#101312" media="(prefers-color-scheme: dark)">'
  ];
  const htmlWithoutApprovedThemeColors = approvedThemeColorMeta.reduce(
    (source, tag) => source.replaceAll(tag, ""),
    html.source
  );
  const literalColor = literalColorPattern.exec(htmlWithoutApprovedThemeColors);
  if (literalColor) {
    addViolation(
      violations,
      html.file,
      html.source,
      html.source.indexOf(literalColor[0]),
      "static shell may use only the pinned light and dark JudgmentKit theme-color literals"
    );
  }

  const judgmentKitIndex = html.source.indexOf('href="judgmentkit.css"');
  const stylesIndex = html.source.indexOf('href="styles.css"');
  if (judgmentKitIndex < 0 || stylesIndex < 0 || judgmentKitIndex > stylesIndex) {
    violations.push({
      file: html.file,
      line: 1,
      reason: "static shell must load judgmentkit.css before styles.css",
      code: '<link rel="stylesheet" href="judgmentkit.css">'
    });
  }
}

function checkJudgmentKitSource(tokens: SourceFile, violations: Violation[]): Set<string> {
  const declaredTokens = new Set([...tokens.source.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]));
  const nonJudgmentKit = [...declaredTokens].filter((token) => !token.startsWith("--jk-"));
  if (nonJudgmentKit.length) {
    const index = tokens.source.indexOf(nonJudgmentKit[0]);
    addViolation(
      violations,
      tokens.file,
      tokens.source,
      index,
      "canonical token source may declare only --jk-* custom properties",
      nonJudgmentKit.join(", ")
    );
  }
  const missingTokens = requiredJudgmentKitTokens.filter((token) => !declaredTokens.has(token));
  if (missingTokens.length) {
    violations.push({
      file: tokens.file,
      line: 1,
      reason: "pinned JudgmentKit source is missing required Workbench token roles",
      code: missingTokens.join(", ")
    });
  }
  if (!/font-family:\s*system-ui\b/.test(tokens.source)) {
    violations.push({ file: tokens.file, line: 1, reason: "JudgmentKit source must use system typography", code: "font-family: system-ui, ..." });
  }
  firstMatchViolation(
    violations,
    tokens,
    /@font-face|@import\s+url|url\(\s*["']?https?:/i,
    "JudgmentKit source must not load remote fonts or assets"
  );
  return declaredTokens;
}

function checkApplicationStyles(
  styles: SourceFile,
  declaredTokens: Set<string>,
  violations: Violation[]
): void {
  firstMatchViolation(
    violations,
    styles,
    /--[A-Za-z0-9_-]+\s*:/,
    "styles.css must consume canonical JudgmentKit roles rather than declare local tokens"
  );
  firstMatchViolation(
    violations,
    styles,
    literalColorPattern,
    "styles.css must not hard-code literal colors"
  );
  firstMatchViolation(
    violations,
    styles,
    /(?:box-shadow|text-shadow)\s*:(?!\s*(?:none\b|[^;\n]*var\(\s*--jk-))[^;\n]+/i,
    "styles.css shadows must use a canonical JudgmentKit role"
  );
  firstMatchViolation(
    violations,
    styles,
    /font-family\s*:\s*(?!inherit\b|var\(\s*--jk-)[^;\n]+/i,
    "styles.css must inherit canonical system typography"
  );
  firstMatchViolation(
    violations,
    styles,
    /@font-face|@import\s+url|url\(/i,
    "styles.css must not load fonts or external assets"
  );

  const usedTokens = new Set([...styles.source.matchAll(/var\(\s*(--jk-[A-Za-z0-9_-]+)/g)].map((match) => match[1]));
  const unknownTokens = [...usedTokens].filter((token) => !declaredTokens.has(token));
  if (unknownTokens.length) {
    const index = styles.source.indexOf(unknownTokens[0]);
    addViolation(
      violations,
      styles.file,
      styles.source,
      index,
      "styles.css references unknown JudgmentKit roles",
      unknownTokens.join(", ")
    );
  }
  const missingUses = requiredApplicationTokenUses.filter((token) => !usedTokens.has(token));
  if (missingUses.length) {
    violations.push({
      file: styles.file,
      line: 1,
      reason: "application styles are not yet bound to required JudgmentKit Workbench roles",
      code: missingUses.join(", ")
    });
  }
  firstMatchViolation(
    violations,
    styles,
    /\.project-rail\b|\.navigation-rail\b|\.card-drawer\b/i,
    "legacy permanent rail or modal Card drawer styles must not ship"
  );
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const appEntry = await readSource(path.resolve(__dirname, "../src/client/app.ts"), "src/client/app.ts", violations);
  const appImplementation = await readSource(path.resolve(__dirname, "../src/client/context-dock.ts"), "src/client/context-dock.ts", violations);
  if (!appEntry.source.includes('import "./context-dock"')) {
    violations.push({
      file: appEntry.file,
      line: 1,
      reason: "client entry must load the accepted Context Dock implementation",
      code: 'import "./context-dock";'
    });
  }
  const app: SourceFile = {
    file: appImplementation.file,
    source: `${appEntry.source}\n${appImplementation.source}`
  };
  const html = await readSource(path.resolve(__dirname, "../index.html"), "index.html", violations);
  const tokens = await readSource(path.resolve(__dirname, "../judgmentkit.css"), "judgmentkit.css", violations);
  const styles = await readSource(path.resolve(__dirname, "../styles.css"), "styles.css", violations);

  checkApplicationSource(app, violations);
  checkStaticShell(html, violations);
  const declaredTokens = checkJudgmentKitSource(tokens, violations);
  checkApplicationStyles(styles, declaredTokens, violations);

  if (violations.length) report(violations);
  console.log("V2 Context Dock UI contract check passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
