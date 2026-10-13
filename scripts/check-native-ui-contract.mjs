import fs from "node:fs/promises";
import path from "node:path";

// This catches prohibited implementation paths. Running native UI review is still required.
const root = path.resolve("ios/KanbanCards");
const forbidden = [
  /\bimport\s+(?:WebKit|React|Flutter|Lottie)\b/,
  /\b(?:WKWebView|UIWebView|Canvas|Path|GeometryReader|ZStack|HStack|VStack)\s*[({]/,
  /\b(?:ButtonStyle|ToggleStyle|TextFieldStyle|PrimitiveButtonStyle|Shape|UIViewRepresentable)\b/,
  /\.(?:glassEffect|background|overlay|shadow|blur|mask|clipShape|cornerRadius|frame|gesture|highPriorityGesture|simultaneousGesture|onTapGesture|buttonStyle|toggleStyle|textFieldStyle|listStyle|toolbarBackground|presentationBackground|tint)\s*\(/,
  /\b(?:GlassEffectContainer|UIGlassEffect|UIVisualEffectView|SFSafariViewController|ASWebAuthenticationSession)\b/,
  /\bFont\.custom\s*\(|\.font\s*\(\s*\.system\s*\(\s*size:/
];

async function files(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]))).flat();
}

const swiftFiles = (await files(root)).filter(file => file.endsWith(".swift"));
const failures = [];
for (const file of swiftFiles) {
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (forbidden.some(pattern => pattern.test(line))) failures.push(`${path.relative(process.cwd(), file)}:${index + 1}: prohibited custom or web UI path`);
  });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Native UI source contract passed for ${swiftFiles.length} Swift files. Verify the running system components separately.`);
}
