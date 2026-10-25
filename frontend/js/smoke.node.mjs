import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "index.html",
  "js/main.js",
  "js/xr-session.js",
  "js/physics.js",
  "js/character.js",
  "assets/models/character.glb",
];

for (const rel of required) {
  const path = join(root, rel);
  if (!existsSync(path)) {
    console.error(`missing ${rel}`);
    process.exit(1);
  }
}

const xr = readFileSync(join(root, "js/xr-session.js"), "utf8");
for (const flag of ["plane-detection", "mesh-detection", "hit-test", "anchors", "hand-tracking"]) {
  if (!xr.includes(flag)) {
    console.error(`missing feature flag ${flag}`);
    process.exit(1);
  }
}

const html = readFileSync(join(root, "index.html"), "utf8");
if (!html.includes("immersive-ar") || !html.includes("Nova")) {
  console.error("index.html missing Nova / immersive-ar");
  process.exit(1);
}

console.log("nova frontend smoke ok");
