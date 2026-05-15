import { readFile } from "node:fs/promises";
import path from "node:path";

interface Violation {
  line: number;
  reason: string;
  code: string;
}

const approvedRawControlFunctions = new Set([
  "renderTextInput",
  "renderTextArea",
  "renderSelect",
  "renderCheckboxOption"
]);

const controlPattern = /<\s*(input|select|textarea)\b/i;
const forbiddenClassPattern = /class=["'][^"']*\b(check-row|modal-field-grid)\b/i;

function currentFunctionName(lines: string[], lineIndex: number): string {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(/^function\s+([A-Za-z0-9_]+)\s*\(/);
    if (match) return match[1];
  }
  return "";
}

async function main(): Promise<void> {
  const appPath = path.resolve(__dirname, "../src/client/app.ts");
  const source = await readFile(appPath, "utf8");
  const lines = source.split(/\r?\n/);
  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    const functionName = currentFunctionName(lines, index);
    if (controlPattern.test(line) && !approvedRawControlFunctions.has(functionName)) {
      violations.push({
        line: index + 1,
        reason: `raw form control outside approved primitive (${functionName || "top-level"})`,
        code: line.trim()
      });
    }

    if (forbiddenClassPattern.test(line)) {
      violations.push({
        line: index + 1,
        reason: "deprecated form layout class; use field-grid or checkbox primitives",
        code: line.trim()
      });
    }
  });

  if (violations.length) {
    console.error("UI contract violations found in src/client/app.ts:");
    for (const violation of violations) {
      console.error(`- ${violation.line}: ${violation.reason}`);
      console.error(`  ${violation.code}`);
    }
    process.exit(1);
  }

  console.log("UI contract check passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
