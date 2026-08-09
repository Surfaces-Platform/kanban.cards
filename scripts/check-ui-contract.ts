import { readFile } from "node:fs/promises";
import path from "node:path";

interface Violation {
  file: string;
  line: number;
  reason: string;
  code: string;
}

const approvedRawControlFunctions = new Set([
  "renderTextInput",
  "renderTextArea",
  "renderSelect"
]);

const forbiddenProductTerms = [
  /\bteam settings\b/i,
  /\bteam members?\b/i,
  /\bagent sessions?\b/i,
  /\bdelegated sessions?\b/i,
  /\bcapabilities\b/i,
  /\breview gates?\b/i,
  /\bapprovals?\b/i,
  /\bdelivered\b/i,
  /\bgenerate flow\b/i,
  /\bflow templates?\b/i
];

const controlPattern = /<\s*(input|select|textarea)\b/i;
const forbiddenStoragePattern = /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:token|access.?key)/i;
const clientTokenGlobalPattern = /KANBAN_CARDS_(?:API_)?TOKEN/i;

function currentFunctionName(lines: string[], lineIndex: number): string {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(/^function\s+([A-Za-z0-9_]+)\s*\(/);
    if (match) return match[1];
  }
  return "";
}

function report(violations: Violation[]): never {
  console.error("V2 UI contract violations found:");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}: ${violation.reason}`);
    console.error(`  ${violation.code}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const appPath = path.resolve(__dirname, "../src/client/app.ts");
  const htmlPath = path.resolve(__dirname, "../index.html");
  const appSource = await readFile(appPath, "utf8");
  const htmlSource = await readFile(htmlPath, "utf8");
  const lines = appSource.split(/\r?\n/);
  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    const functionName = currentFunctionName(lines, index);
    if (controlPattern.test(line) && !approvedRawControlFunctions.has(functionName)) {
      violations.push({
        file: "src/client/app.ts",
        line: index + 1,
        reason: `raw form control outside approved primitive (${functionName || "top-level"})`,
        code: line.trim()
      });
    }
    if (forbiddenStoragePattern.test(line)) {
      violations.push({
        file: "src/client/app.ts",
        line: index + 1,
        reason: "access credentials must never be persisted in browser storage",
        code: line.trim()
      });
    }
    if (clientTokenGlobalPattern.test(line)) {
      violations.push({
        file: "src/client/app.ts",
        line: index + 1,
        reason: "client token globals are outside the cookie-session authentication boundary",
        code: line.trim()
      });
    }
    for (const term of forbiddenProductTerms) {
      if (term.test(line)) {
        violations.push({
          file: "src/client/app.ts",
          line: index + 1,
          reason: `legacy product concept (${term.source})`,
          code: line.trim()
        });
      }
    }
  });

  if (!htmlSource.includes('id="app"')) {
    violations.push({ file: "index.html", line: 1, reason: "static app shell is missing", code: "" });
  }
  if (/<(?:input|select|textarea)\b/i.test(htmlSource)) {
    violations.push({ file: "index.html", line: 1, reason: "static shell must not collect credentials or project data", code: "" });
  }

  if (violations.length) report(violations);
  console.log("V2 UI contract check passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
