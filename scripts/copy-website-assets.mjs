import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(resolve(root, "website-assets/manifest.json"), "utf8"));
for (const asset of manifest.assets) {
  const bytes = await readFile(resolve(root, asset.source));
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`Website asset changed: ${asset.source}`);
  const output = resolve(root, asset.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
}
await writeFile(resolve(root, "public/website.css"), await readFile(resolve(root, "website.css")));
console.log("Copied public-only website styles and verified font, license, and selected hero.");
