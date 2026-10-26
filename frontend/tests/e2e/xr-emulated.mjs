import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const BASE = process.env.NOVA_URL || "http://127.0.0.1:8080";

const iwer = readFileSync(createRequire(import.meta.url).resolve("iwer/build/iwer.min.js"), "utf8");
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("console", (m) => m.type() === "error" && logs.push(`[console] ${m.text()}`));
await page.evaluateOnNewDocument(`${iwer};
  window.__dev = new IWER.XRDevice(IWER.metaQuest3);
  window.__dev.installRuntime({ forceInstall: true });
  window.__dev.position.set(0, 1.6, 0);`);
await page.goto(`${BASE}/?debug`, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });
await page.waitForFunction(() => /geladen/.test(document.getElementById("status").textContent), { timeout: 60000 });
const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}` }) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);

await page.click("#enter-ar");
await sleep(1500);
check("AR session started", await ev(() => Boolean(window.nova.input.slots.some((s) => s.connected))));

await ev(() => {
  const V = window.nova.camera.position.constructor;
  const Q = window.nova.camera.quaternion.constructor;
  window.__aim = (hand, target) => {
    const c = window.__dev.controllers[hand];
    const dir = new V(target.x - c.position.x, target.y - c.position.y, target.z - c.position.z).normalize();
    const q = new Q().setFromUnitVectors(new V(0, 0, -1), dir);
    c.quaternion.set(q.x, q.y, q.z, q.w);
  };
  window.__menuPoint = (id) => {
    const { menu } = window.nova;
    const c = menu.controls.find((x) => x.id === id);
    const W = 1024, H = 1320, PW = 0.42, PH = (PW * H) / W;
    return menu.mesh.localToWorld(new V(((c.x + c.w / 2) / W - 0.5) * PW, (0.5 - (c.y + c.h / 2) / H) * PH, 0));
  };
  window.__pulses = [];
  for (const s of window.nova.input.slots) {
    const a = s.source?.gamepad?.hapticActuators?.[0];
    if (!a) continue;
    const orig = a.pulse.bind(a);
    a.pulse = (v, d) => { window.__pulses.push([s.handedness, v, d]); return orig(v, d); };
  }
  window.__dev.controllers.right.position.set(0.2, 1.3, -0.2);
  window.__dev.controllers.left.position.set(-0.2, 1.3, -0.2);
});
const press = async (hand, button, hold = 150) => {
  await ev((h, b) => window.__dev.controllers[h].updateButtonValue(b, 1), hand, button);
  await sleep(hold);
  await ev((h, b) => window.__dev.controllers[h].updateButtonValue(b, 0), hand, button);
  await sleep(200);
};

// Place with the right controller ray on the (fallback) floor.
await ev(() => window.__aim("right", { x: 0, y: 0, z: -1.2 }));
await sleep(300);
await press("right", "trigger");
const placed = await ev(() => [window.nova.character.placed, window.nova.character.root.position.toArray().map((v) => +v.toFixed(2))]);
check("trigger places figure on floor", placed[0] && Math.abs(placed[1][2] + 1.2) < 0.1, JSON.stringify(placed));

// Menu via left thumbstick press.
await press("left", "thumbstick");
check("left stick press opens menu", await ev(() => window.nova.menu.isOpen));
await shot("x1-menu.png");

const rayPress = async (id) => {
  await ev((id) => window.__aim("right", window.__menuPoint(id)), id);
  await sleep(250);
  await press("right", "trigger");
};
await rayPress("interact");
check("laser + trigger on 'Interaktion'", (await ev(() => window.nova.mode)) === "interact");
await rayPress("strength:-");
check("laser on 'Muskelkraft −'", (await ev(() => window.nova.settings.strengthPct)) === 90);
await rayPress("strength:+");

// Slider drag with held trigger.
const sStart = await ev(() => window.__menuPoint("scale"));
await ev((p) => window.__aim("right", p), sStart);
await sleep(200);
await ev(() => window.__dev.controllers.right.updateButtonValue("trigger", 1));
await sleep(150);
for (let i = 1; i <= 6; i += 1) {
  await ev((p, i) => window.__aim("right", { x: p.x + i * 0.02, y: p.y, z: p.z }), sStart, i);
  await sleep(80);
}
await ev(() => window.__dev.controllers.right.updateButtonValue("trigger", 0));
await sleep(900);
const scaleAfter = await ev(() => [window.nova.settings.scalePct, window.nova.mode]);
check("slider drag with laser changes size, interaction resumes", scaleAfter[0] > 105 && scaleAfter[1] === "interact", JSON.stringify(scaleAfter));
await rayPress("close");
check("'✕' closes menu", !(await ev(() => window.nova.menu.isOpen)));

// Grab her left hand with the right controller grip.
await sleep(1500);
const grabSetup = await ev(() => {
  const slot = window.nova.input.slots.find((s) => s.handedness === "right");
  const c = window.__dev.controllers.right;
  const hand = window.nova.figureHands().left;
  const delta = { x: slot.grabPoint.x - c.position.x, y: slot.grabPoint.y - c.position.y, z: slot.grabPoint.z - c.position.z };
  c.position.set(hand.x - delta.x + 0.01, hand.y - delta.y, hand.z - delta.z);
  return { hand: hand.toArray(), delta };
});
await sleep(300);
const hoverState = await ev(() => window.nova.grab.stateOf("left"));
await ev(() => { window.__pulses.length = 0; window.__dev.controllers.right.updateButtonValue("squeeze", 1); });
await sleep(300);
const heldState = await ev(() => [window.nova.grab.stateOf("left"), window.__pulses.slice()]);
check("grip near her hand grabs it (+ haptic pulse)", heldState[0] === "held" && heldState[1].some(([h, v]) => h === "right" && v >= 0.5), `${hoverState} -> ${JSON.stringify(heldState)}`);
const y0 = await ev(() => window.nova.figureHands().left.y);
for (let i = 0; i < 12; i += 1) {
  await ev(() => { const c = window.__dev.controllers.right; c.position.set(c.position.x, c.position.y + 0.04, c.position.z + 0.01); });
  await sleep(80);
}
await sleep(800);
const y1 = await ev(() => window.nova.figureHands().left.y);
await shot("x2-grab-up.png");
check("her hand follows the controller up", y1 - y0 > 0.3, `${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
await ev(() => window.__dev.controllers.right.updateButtonValue("squeeze", 0));
await sleep(2500);
const y2 = await ev(() => window.nova.figureHands().left.y);
check("release: arm returns", !(await ev(() => window.nova.grab.isGrabbing("xr0") || window.nova.grab.isGrabbing("xr1"))) && y2 < y1 - 0.25, `${y1.toFixed(2)} -> ${y2.toFixed(2)}`);
check("still standing", (await ev(() => window.nova.physics.ragdoll.state)) === "standing");

// ---- Hand tracking ----
await ev(() => { window.__dev.primaryInputMode = "hand"; });
await sleep(1200);
check("hand tracking active", await ev(() => window.nova.input.slots.filter((s) => s.connected && s.isHand).length === 2));

// Pinch at her right hand with the user's right hand.
const pinchOffset = await ev(async () => {
  const h = window.__dev.hands.right;
  h.position.set(0.3, 1.2, -0.3);
  h.poseId = "pinch";
  await new Promise((r) => setTimeout(r, 300));
  const slot = window.nova.input.slots.find((s) => s.handedness === "right");
  const off = { x: slot.grabPoint.x - h.position.x, y: slot.grabPoint.y - h.position.y, z: slot.grabPoint.z - h.position.z, pinching: slot.pinching };
  h.poseId = "open";
  await new Promise((r) => setTimeout(r, 300));
  off.openPinching = slot.pinching;
  return off;
});
await ev((off) => {
  const hand = window.nova.figureHands().right;
  window.__dev.hands.right.position.set(hand.x - off.x, hand.y - off.y, hand.z - off.z);
}, pinchOffset);
await sleep(300);
await ev(() => { window.__dev.hands.right.poseId = "pinch"; });
await sleep(400);
check("hand pinch at her hand grabs it", (await ev(() => window.nova.grab.stateOf("right"))) === "held", JSON.stringify(pinchOffset));
await ev(() => { window.__dev.hands.right.poseId = "open"; });
await sleep(400);
check("opening the hand releases", (await ev(() => window.nova.grab.stateOf("right"))) !== "held");

// Fist grab.
await ev(() => { window.__dev.hands.right.poseId = "fist"; });
await sleep(300);
const fist = await ev(() => { const s = window.nova.input.slots.find((x) => x.handedness === "right"); return [s.fist, s.pinching]; });
check("fist pose detected", fist[0] && !fist[1], JSON.stringify(fist));
await ev(() => { window.__dev.hands.right.poseId = "open"; window.__dev.hands.right.position.set(0.25, 1.2, -0.25); });
await sleep(300);

// Palm launcher: try orientations until the launcher above the left palm shows.
const launcher = await ev(async () => {
  const Q = window.nova.camera.quaternion.constructor;
  const E = window.nova.camera.rotation.constructor;
  const h = window.__dev.hands.left;
  h.poseId = "flat";
  h.position.set(-0.1, 1.35, -0.3);
  for (const x of [0, 90, -90, 180]) for (const y of [0, 90, -90, 180]) for (const z of [0, 90, -90, 180]) {
    const q = new Q().setFromEuler(new E((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180));
    h.quaternion.set(q.x, q.y, q.z, q.w);
    await new Promise((r) => setTimeout(r, 120));
    if (window.nova.menu.launcher.visible) return [x, y, z];
  }
  return null;
});
check("palm towards face shows menu launcher", Boolean(launcher), JSON.stringify(launcher));
await shot("x3-launcher.png");

const poke = async (targetFn) => {
  return ev(async (targetSrc) => {
    const target = eval(targetSrc)();
    const V = window.nova.camera.position.constructor;
    const h = window.__dev.hands.right;
    h.poseId = "point";
    await new Promise((r) => setTimeout(r, 250));
    const slot = window.nova.input.slots.find((s) => s.handedness === "right");
    const tip = slot.joint("index-finger-tip").getWorldPosition(new V());
    const off = tip.clone().sub(new V(h.position.x, h.position.y, h.position.z));
    const { point, normal } = target();
    for (const d of [0.06, 0.03, 0.012, 0.004, -0.004, -0.01, 0.06]) {
      const p = point.clone().addScaledVector(normal, d).sub(off);
      h.position.set(p.x, p.y, p.z);
      await new Promise((r) => setTimeout(r, 90));
    }
    return true;
  }, `(${targetFn})`);
};
if (launcher) {
  await poke(() => () => {
    const V = window.nova.camera.position.constructor;
    const m = window.nova.menu.launcher;
    return { point: m.getWorldPosition(new V()), normal: new V(0, 0, 1).transformDirection(m.matrixWorld) };
  });
  check("finger poke on launcher opens menu", await ev(() => window.nova.menu.isOpen));
  await ev(() => { window.__dev.hands.left.position.set(-0.4, 0.9, 0); });
  await sleep(300);
  const before = await ev(() => window.nova.settings.scalePct);
  await poke(() => () => {
    const V = window.nova.camera.position.constructor;
    const m = window.nova.menu.mesh;
    return { point: window.__menuPoint("scale:+"), normal: new V(0, 0, 1).transformDirection(m.matrixWorld) };
  });
  const afterPoke = await ev(() => window.nova.settings.scalePct);
  check("finger poke on 'Größe +'", afterPoke === before + 5, `${before} -> ${afterPoke}`);
  await shot("x4-poke.png");
}

check("no page errors", logs.length === 0, logs.join(" | "));
console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
