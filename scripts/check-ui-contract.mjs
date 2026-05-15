import { readFile } from "node:fs/promises";

const appPath = new URL("../app.js", import.meta.url);
const source = await readFile(appPath, "utf8");
const lines = source.split(/\r?\n/);

const approvedRawControlFunctions = new Set([
  "renderTextInput",
  "renderTextArea",
  "renderSelect",
  "renderCheckboxOption"
]);

const controlPattern = /<\s*(input|select|textarea)\b/i;
const forbiddenClassPattern = /class=["'][^"']*\b(check-row|modal-field-grid)\b/i;

function currentFunctionName(lineIndex) {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(/^function\s+([A-Za-z0-9_]+)\s*\(/);
    if (match) return match[1];
  }
  return "";
}

const violations = [];

lines.forEach((line, index) => {
  const functionName = currentFunctionName(index);
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
  console.error("UI contract violations found in app.js:");
  for (const violation of violations) {
    console.error(`- ${violation.line}: ${violation.reason}`);
    console.error(`  ${violation.code}`);
  }
  process.exit(1);
}

console.log("UI contract check passed.");
