// Layout and hit-testing of the in-headset menu, in canvas pixels. No three.js / DOM: testable in Node.

export const MENU_W = 1024;
export const MENU_H = 1320;
export const MODELS_PER_PAGE = 3;

export const RANGES = {
  rotate: { min: -180, max: 180, step: 15, unit: "°" },
  scale: { min: 50, max: 150, step: 5, unit: " %" },
  strength: { min: 20, max: 200, step: 10, unit: " %" },
};

const PAD = 40;
const FULL = MENU_W - 2 * PAD;
const HALF = (FULL - 24) / 2;
const STEP_W = 110;

function sliderRow(id, label, value, y) {
  const r = RANGES[id];
  return [
    { id: `${id}-label`, type: "label", x: PAD, y: y - 46, w: FULL, h: 40, label: `${label}  ${Math.round(value)}${r.unit}` },
    { id: `${id}:-`, type: "button", action: `${id}-step`, value: -r.step, x: PAD, y, w: STEP_W, h: 84, label: "−" },
    { id, type: "slider", action: id, x: PAD + STEP_W + 20, y, w: FULL - 2 * (STEP_W + 20), h: 84, min: r.min, max: r.max, value },
    { id: `${id}:+`, type: "button", action: `${id}-step`, value: r.step, x: MENU_W - PAD - STEP_W, y, w: STEP_W, h: 84, label: "+" },
  ];
}

export function pageCount(models) {
  return Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
}

/**
 * @param state { mode, relocating, yawDeg, scalePct, strengthPct, models: [{id,name}], activeId, page, status }
 * @returns controls: { id, type: "button"|"slider"|"label", action?, value?, x, y, w, h, label?, active?, min?, max? }
 */
export function buildLayout(state) {
  const controls = [
    { id: "title", type: "label", x: PAD, y: 28, w: 700, h: 72, label: "Nova", style: "title" },
    { id: "close", type: "button", action: "close", x: MENU_W - PAD - 110, y: 24, w: 110, h: 84, label: "✕" },
    { id: "place", type: "button", action: "place", x: PAD, y: 140, w: HALF, h: 100, label: "Platzieren", active: state.mode === "place" && !state.relocating },
    { id: "interact", type: "button", action: "interact", x: PAD + HALF + 24, y: 140, w: HALF, h: 100, label: "Interaktion", active: state.mode === "interact" },
    { id: "relocate", type: "button", action: "relocate", x: PAD, y: 264, w: HALF, h: 100, label: "Neu platzieren", active: Boolean(state.relocating) },
    { id: "reset", type: "button", action: "reset", x: PAD + HALF + 24, y: 264, w: HALF, h: 100, label: "Aufstellen" },
    ...sliderRow("rotate", "Drehen", state.yawDeg, 450),
    ...sliderRow("scale", "Größe", state.scalePct, 600),
    ...sliderRow("strength", "Muskelkraft", state.strengthPct, 750),
  ];
  const models = state.models || [];
  const pages = pageCount(models);
  const page = Math.min(Math.max(0, state.page || 0), pages - 1);
  controls.push({ id: "models-label", type: "label", x: PAD, y: 850, w: FULL, h: 40, label: pages > 1 ? `Modell  (Seite ${page + 1}/${pages})` : "Modell" });
  models.slice(page * MODELS_PER_PAGE, (page + 1) * MODELS_PER_PAGE).forEach((m, i) => {
    controls.push({
      id: `model:${m.id}`, type: "button", action: "model", value: m.id,
      x: PAD, y: 900 + i * 96, w: FULL, h: 84, label: m.name, active: m.id === state.activeId, align: "left",
    });
  });
  if (pages > 1) {
    controls.push({ id: "page:-1", type: "button", action: "page", value: -1, x: PAD, y: 1196, w: 200, h: 84, label: "◀" });
    controls.push({ id: "page:1", type: "button", action: "page", value: 1, x: MENU_W - PAD - 200, y: 1196, w: 200, h: 84, label: "▶" });
  }
  controls.push({ id: "status", type: "label", x: PAD + (pages > 1 ? 224 : 0), y: 1200, w: FULL - (pages > 1 ? 448 : 0), h: 80, label: state.status || "", style: "status" });
  return controls;
}

export function hitTest(controls, px, py) {
  return controls.find((c) => c.type !== "label" && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) || null;
}

/** Slider value at canvas x (clamped; snapped to whole units). */
export function sliderValue(control, px) {
  const t = Math.min(1, Math.max(0, (px - control.x) / control.w));
  return Math.round(control.min + t * (control.max - control.min));
}

export function sliderFraction(control) {
  return (control.value - control.min) / (control.max - control.min);
}

/** Canvas pixel coordinates from panel UV (three.js plane UV: v = 0 at the bottom). */
export function uvToPixel(uv) {
  return { x: uv.x * MENU_W, y: (1 - uv.y) * MENU_H };
}

export function clampRange(id, value) {
  const r = RANGES[id];
  return Math.min(r.max, Math.max(r.min, value));
}

/** Wrap an angle in degrees to [-180, 180). */
export function wrapDegrees(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}
