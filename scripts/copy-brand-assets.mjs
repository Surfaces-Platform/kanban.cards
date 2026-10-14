import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "brand/split-k/lockups");
const output = resolve(root, "public/branding");
const rules = JSON.parse(await readFile(resolve(root, "brand/split-k/wordmark-source/lockup-rules.json"), "utf8"));
const files = [["horizontal.svg", "brand-lockup.svg"], ["horizontal-reversed.svg", "brand-lockup-dark.svg"]];

await mkdir(output, { recursive: true });
for (const [canonical, destination] of files) {
  const bytes = await readFile(resolve(source, canonical));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== rules.approvedHorizontalSha256[canonical]) throw new Error(`Canonical brand asset changed: ${canonical}`);
  await writeFile(resolve(output, destination), bytes);
}
console.log("Copied the exact canonical light and dark lockups.");
