import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "index.html",
  "js/main.js",
  "js/xr-session.js",
  "js/xr-menu.js",
  "js/menu-layout.js",
  "js/hand-grab.js",
  "js/physics-world.js",
  "js/active-ragdoll.js",
  "js/humanoid-map.js",
  "js/character.js",
  "js/models-ui.js",
  "js/api.js",
  "assets/models/character.glb",
];

for (const rel of required) {
  if (!existsSync(join(root, rel))) {
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
if (!html.includes("immersive-ar") || !html.includes("Nova") || !html.includes("@pixiv/three-vrm")) {
  console.error("index.html missing Nova / immersive-ar / three-vrm");
  process.exit(1);
}

console.log("nova frontend smoke ok");
