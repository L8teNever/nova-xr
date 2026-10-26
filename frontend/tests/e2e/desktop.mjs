import puppeteer from "puppeteer-core";

const BASE = process.env.NOVA_URL || "http://127.0.0.1:8080";

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
page.on("response", (r) => r.status() >= 400 && logs.push(`[http ${r.status()}] ${r.url()}`));
await page.goto(`${BASE}/?debug`, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });
await page.waitForFunction(() => /geladen/.test(document.getElementById("status").textContent), { timeout: 60000 });
await page.evaluate(() => document.body.classList.add("hud-collapsed"));
const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}` }) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
const status = () => page.$eval("#status", (e) => e.textContent);
await sleep(800);

const screenOf = (expr) =>
  page.evaluate((expr) => {
    const { camera } = window.nova;
    const p = eval(expr).clone().project(camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  }, expr);
const handY = (side) => page.evaluate((s) => window.nova.figureHands()[s]?.y ?? null, side);

// ---- Grab the right hand with the mouse (place mode -> switches to interaction) ----
const hand = await screenOf("window.nova.figureHands().right");
const y0 = await handY("right");
await page.mouse.move(hand.x, hand.y);
await sleep(200);
const hoverState = await page.evaluate(() => window.nova.grab.stateOf("right"));
await shot("g1-hover.png");
await page.mouse.down();
for (let i = 1; i <= 20; i += 1) {
  await page.mouse.move(hand.x + i * 2, hand.y - i * 9);
  await sleep(40);
}
await sleep(1200);
const held = await page.evaluate(() => ({ mode: window.nova.mode, state: window.nova.grab.stateOf("right"), ragdoll: window.nova.physics.ragdoll.state }));
const y1 = await handY("right");
await shot("g2-held-up.png");
await page.mouse.up();
await sleep(2500);
const y2 = await handY("right");
const after = await page.evaluate(() => ({ state: window.nova.grab.stateOf("right"), ragdoll: window.nova.physics.ragdoll.state }));
await shot("g3-released.png");
check("mouse over her hand highlights it", hoverState === "hover", hoverState);
check("mouse drag holds the hand (switches to interaction)", held.mode === "interact" && held.state === "held", JSON.stringify(held));
check("held hand follows the mouse up", y1 - y0 > 0.3, `${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
check("released hand returns, figure keeps standing", after.state === null && after.ragdoll === "standing" && y1 - y2 > 0.3, `${y1.toFixed(2)} -> ${y2.toFixed(2)}`);

// ---- 3D menu via M ----
await page.keyboard.press("KeyM");
await sleep(400);
const menuPoint = (id) =>
  page.evaluate((id) => {
    const { menu, camera } = window.nova;
    const c = menu.controls.find((x) => x.id === id);
    const W = 1024, H = 1320, PW = 0.42, PH = (0.42 * H) / W;
    const local = new window.nova.camera.position.constructor(((c.x + c.w / 2) / W - 0.5) * PW, (0.5 - (c.y + c.h / 2) / H) * PH, 0);
    const p = menu.mesh.localToWorld(local).project(camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, c };
  }, id);
const click = async (id) => {
  const p = await menuPoint(id);
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  return p;
};
check("M opens the 3D menu", await page.evaluate(() => window.nova.menu.isOpen));
await shot("m1-open.png");
await click("scale:+");
await click("scale:+");
const scaled = await page.evaluate(() => [window.nova.settings.scalePct, window.nova.character.scale]);
check("'Größe +' twice", scaled[0] === 110 && Math.abs(scaled[1] - 1.1) < 1e-6, JSON.stringify(scaled));
// drag strength slider to the left end
const s = await menuPoint("strength");
await page.mouse.move(s.x, s.y);
await page.mouse.down();
await page.mouse.move(s.x - 600, s.y, { steps: 8 });
await page.mouse.up();
await sleep(200);
const strength = await page.evaluate(() => [window.nova.settings.strengthPct, window.nova.physics.ragdoll.strength]);
check("dragging the strength slider to the left", strength[0] === 20 && Math.abs(strength[1] - 0.2) < 1e-6, JSON.stringify(strength));
await click("strength:+");
const yawBefore = await page.evaluate(() => Math.round((window.nova.character.yaw * 180) / Math.PI));
await click("rotate:+");
await click("rotate:+");
const yaw = await page.evaluate(() => Math.round((window.nova.character.yaw * 180) / Math.PI));
check("'Drehen +' twice = +30°", yaw - yawBefore === 30, `${yawBefore}° -> ${yaw}°`);
await sleep(900);
check("interaction resumes after editing", (await page.evaluate(() => window.nova.mode)) === "interact");
await shot("m2-edited.png");
await click("place");
check("'Platzieren'", (await page.evaluate(() => window.nova.mode)) === "place");
await click("interact");
check("'Interaktion'", (await page.evaluate(() => window.nova.mode)) === "interact");
const models = await page.evaluate(() => window.nova.menu.controls.filter((c) => c.action === "model").map((c) => c.id));
check("model list in the menu", models.includes("model:default"), models.join(", "));
await click("relocate");
const reloc = await page.evaluate(() => [window.nova.relocating, window.nova.character.root.visible, window.nova.menu.isOpen, window.nova.mode]);
check("'Neu platzieren' hides figure, closes menu", reloc[0] && !reloc[1] && !reloc[2] && reloc[3] === "place", JSON.stringify(reloc));
await page.mouse.click(760, 700);
await sleep(300);
const placedAgain = await page.evaluate(() => [window.nova.relocating, window.nova.character.root.visible]);
check("click places it again", !placedAgain[0] && placedAgain[1], JSON.stringify(placedAgain));
await page.keyboard.press("KeyM");
await sleep(300);
await shot("m3-menu-after-relocate.png");
await click("close");
check("'✕' closes the menu", !(await page.evaluate(() => window.nova.menu.isOpen)));
check("no page errors", logs.length === 0, logs.join(" | "));
console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
