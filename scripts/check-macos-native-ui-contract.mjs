import fs from "node:fs/promises";
import path from "node:path";

// Source guard only. Real window behavior and system appearance require native review.
const root = path.resolve("macos/KanbanCards");
const forbidden = [
  /\bimport\s+(?:UIKit|WebKit|React|Flutter|Lottie)\b/,
  /\b(?:WKWebView|UIWebView|Canvas|Path)\s*[({]/,
  /\b(?:ButtonStyle|ToggleStyle|TextFieldStyle|PrimitiveButtonStyle|Shape)\b/,
  /\.(?:glassEffect|overlay|shadow|blur|mask|clipShape|cornerRadius|gesture|highPriorityGesture|simultaneousGesture|onTapGesture|toggleStyle|textFieldStyle|toolbarBackground|presentationBackground|tint)\s*\(/,
  // Permit the standard semantic surface; custom backgrounds remain prohibited.
  /\.background\s*\((?!\s*\.background\s*\.\s*secondary\s*\))/,
  /\.buttonStyle\s*\(\s*(?!\.(?:plain|bordered|borderedProminent|automatic)\s*\))/,
  /\b(?:GlassEffectContainer|NSVisualEffectView|LinearGradient|RadialGradient|AngularGradient|ASWebAuthenticationSession)\b/,
  /\bFont\.custom\s*\(|\.font\s*\(\s*\.system\s*\(\s*size:/,
  /\.(?:titlebarAppearsTransparent|titleVisibility|isMovableByWindowBackground|styleMask|level)\s*=/
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
    const nativeBridges = [path.join(root, "WindowGeometry.swift"), path.join(root, "UI/NativePopUpPicker.swift")];
    if (/\bNSViewRepresentable\b/.test(line) && !nativeBridges.includes(file)) {
      failures.push(`${path.relative(process.cwd(), file)}:${index + 1}: only native window integration and the standard AppKit popup control bridges are allowed`);
    }
  });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`macOS native UI source contract passed for ${swiftFiles.length} Swift files. Verify running system components separately.`);
}
