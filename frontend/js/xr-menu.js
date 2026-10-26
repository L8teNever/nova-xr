import * as THREE from "three";
import {
  MENU_H,
  MENU_W,
  MODELS_PER_PAGE,
  buildLayout,
  hitTest,
  pageCount,
  sliderFraction,
  sliderValue,
  uvToPixel,
} from "./menu-layout.js";

const PANEL_W = 0.42;
const PANEL_H = (PANEL_W * MENU_H) / MENU_W;
const DISTANCE = 0.6;
const DROP = 0.14;
const FOLLOW_ANGLE = (35 * Math.PI) / 180;
const FOLLOW_SPEED = 5;
const LAUNCHER_SIZE = 0.07;
const LAUNCHER_PX = 256;
const PALM_OFFSET = 0.075;
// Fingertip poke thresholds in metres along the panel normal (+z = in front of the panel).
const POKE = { press: 0.006, release: 0.025, hover: 0.08, behind: -0.05 };
const SLIDER_STATE = { rotate: "yawDeg", scale: "scalePct", strength: "strengthPct" };

const COLORS = {
  panel: "rgba(11,16,32,0.9)",
  button: "#1d2a4a",
  hover: "#334a7d",
  active: "#2dd4bf",
  flash: "#f8fafc",
  text: "#e8eefc",
  activeText: "#04212a",
  muted: "#9aacd1",
  track: "#1d2a4a",
};

function makeCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, ctx: canvas.getContext("2d"), texture };
}

function makePanel(texture, w, h) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  );
  mesh.renderOrder = 20;
  mesh.visible = false;
  return mesh;
}

/**
 * Floating in-headset menu. Opens in front of the user and lazily re-centres when it leaves the view.
 * Operated by rays (controller trigger / hand pinch, also drag on sliders), by fingertip poke, or by the
 * desktop mouse. A small launcher button appears above the left palm when it faces the user.
 */
export class XRMenu {
  constructor(scene, onAction) {
    this.onAction = onAction;
    const panel = makeCanvas(MENU_W, MENU_H);
    this.canvas = panel.canvas;
    this.ctx = panel.ctx;
    this.texture = panel.texture;
    this.mesh = makePanel(this.texture, PANEL_W, PANEL_H);
    this.mesh.name = "nova-menu";
    const launcher = makeCanvas(LAUNCHER_PX, LAUNCHER_PX);
    this.launcherCtx = launcher.ctx;
    this.launcherTexture = launcher.texture;
    this.launcher = makePanel(launcher.texture, LAUNCHER_SIZE, LAUNCHER_SIZE);
    this.launcher.name = "nova-menu-launcher";
    scene.add(this.mesh, this.launcher);

    this.state = { mode: "place", relocating: false, yawDeg: 0, scalePct: 100, strengthPct: 100, models: [], activeId: null, page: 0, status: "" };
    this.controls = buildLayout(this.state);
    this.pointers = new Map();
    this.pokes = new Map();
    this.hover = new Set();
    this.flash = null;
    this.flashUntil = 0;
    this.recentering = false;
    this.camera = null;
    this._dirty = true;
    this._drawLauncher();
  }

  get isOpen() {
    return this.mesh.visible;
  }

  setState(partial) {
    let changed = false;
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined || this.state[key] === value) continue;
      this.state[key] = value;
      changed = true;
    }
    if (changed) this._relayout();
  }

  _relayout() {
    this.state.page = Math.min(this.state.page, pageCount(this.state.models) - 1);
    this.controls = buildLayout(this.state);
    this._dirty = true;
  }

  show(camera = this.camera) {
    if (camera) this.camera = camera;
    this.mesh.visible = true;
    this.launcher.visible = false;
    const activeIndex = this.state.models.findIndex((m) => m.id === this.state.activeId);
    if (activeIndex >= 0) this.setState({ page: Math.floor(activeIndex / MODELS_PER_PAGE) });
    if (this.camera) {
      this._desiredPose(this.camera, this.mesh.position);
      this._face(this.camera);
    }
    this._dirty = true;
  }

  hide() {
    this.mesh.visible = false;
    for (const p of this.pointers.values()) p.captured = null;
    this.hover.clear();
  }

  toggle(camera) {
    if (this.isOpen) this.hide();
    else this.show(camera);
  }

  _desiredPose(camera, out) {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    return out.copy(head).addScaledVector(forward, DISTANCE).add(new THREE.Vector3(0, -DROP, 0));
  }

  _face(camera) {
    this.mesh.lookAt(camera.getWorldPosition(new THREE.Vector3()));
  }

  /**
   * @param camera the XR (or desktop) camera
   * @param palm { position, normal } of the left palm when it faces the user, else null
   */
  update(camera, dt, palm = null) {
    this.camera = camera;
    if (this.isOpen) {
      const captured = [...this.pointers.values()].some((p) => p.captured);
      if (!captured) {
        const head = camera.getWorldPosition(new THREE.Vector3());
        const desired = this._desiredPose(camera, new THREE.Vector3());
        const toPanel = this.mesh.position.clone().sub(head).setY(0);
        const toDesired = desired.clone().sub(head).setY(0);
        const angle = toPanel.angleTo(toDesired);
        const dist = this.mesh.position.distanceTo(head);
        if (angle > FOLLOW_ANGLE || dist > DISTANCE * 2 || dist < DISTANCE * 0.4) this.recentering = true;
        if (this.recentering) {
          this.mesh.position.lerp(desired, Math.min(1, dt * FOLLOW_SPEED));
          if (this.mesh.position.distanceTo(desired) < 0.02) this.recentering = false;
        }
      }
      this._face(camera);
      this.launcher.visible = false;
    } else {
      this.launcher.visible = Boolean(palm);
      if (palm) {
        this.launcher.position.copy(palm.position).addScaledVector(palm.normal, PALM_OFFSET);
        this.launcher.lookAt(camera.getWorldPosition(new THREE.Vector3()));
      }
    }
    if (this.flash && performance.now() > this.flashUntil) {
      this.flash = null;
      this._dirty = true;
    }
    if (this._dirty && this.isOpen) this.draw();
  }

  /** Intersection of a ray with the panel/launcher plane; `inside` tells whether it hits the visible area. */
  _planeHit(mesh, w, h, origin, direction) {
    if (!mesh.visible) return null;
    mesh.updateMatrixWorld();
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    const center = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const denom = direction.dot(normal);
    if (Math.abs(denom) < 1e-6) return null;
    const t = center.clone().sub(origin).dot(normal) / denom;
    if (t <= 0) return null;
    const point = origin.clone().addScaledVector(direction, t);
    const local = mesh.worldToLocal(point.clone());
    const uv = new THREE.Vector2(local.x / w + 0.5, local.y / h + 0.5);
    return { uv, distance: t, point, inside: uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1 };
  }

  raycast(origin, direction, { launcher = true } = {}) {
    const panel = this._planeHit(this.mesh, PANEL_W, PANEL_H, origin, direction);
    if (panel) {
      const { x, y } = uvToPixel(panel.uv);
      return { ...panel, target: "panel", control: panel.inside ? hitTest(this.controls, x, y) : null };
    }
    const button = launcher ? this._planeHit(this.launcher, LAUNCHER_SIZE, LAUNCHER_SIZE, origin, direction) : null;
    if (button?.inside) return { ...button, target: "launcher", control: null };
    return null;
  }

  /** Ray pointer (controller, hand ray, mouse). Returns the hit for ray rendering and input consumption. */
  pointerRay(id, origin, direction, pressed, options) {
    const hit = this.raycast(origin, direction, options);
    this._pointer(id, hit, pressed);
    return hit?.inside || this.pointers.get(id)?.captured ? hit : null;
  }

  /** Fingertip poke: press when the tip crosses the surface from the front, drag sliders while touching. */
  poke(id, tip, { launcher = true } = {}) {
    let hit = null;
    for (const [mesh, w, h, target] of [[this.mesh, PANEL_W, PANEL_H, "panel"], [this.launcher, LAUNCHER_SIZE, LAUNCHER_SIZE, "launcher"]]) {
      if (!mesh.visible || (target === "launcher" && !launcher)) continue;
      const local = mesh.worldToLocal(tip.clone());
      const uv = new THREE.Vector2(local.x / w + 0.5, local.y / h + 0.5);
      const inside = uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;
      if (!inside || local.z > POKE.hover || local.z < POKE.behind * 2) continue;
      const { x, y } = uvToPixel(uv);
      hit = { uv, distance: local.z, inside, target, control: target === "panel" ? hitTest(this.controls, x, y) : null, z: local.z };
      break;
    }
    const state = this.pokes.get(id) || { down: false, lastZ: Infinity };
    const z = hit ? hit.z : Infinity;
    if (!state.down) {
      if (hit && state.lastZ > POKE.press && z <= POKE.press && z > POKE.behind) state.down = true;
    } else if (z > POKE.release || z < POKE.behind * 2) {
      state.down = false;
    }
    state.lastZ = z;
    this.pokes.set(id, state);
    this._pointer(`poke:${id}`, hit, state.down);
    return hit;
  }

  _pointer(id, hit, pressed) {
    const p = this.pointers.get(id) || { down: false, captured: null, hover: null };
    if (p.captured) {
      if (!pressed || !this.isOpen) p.captured = null;
      else if (hit?.target === "panel") this._setSlider(p.captured, uvToPixel(hit.uv).x);
    } else if (pressed && !p.down && hit?.inside) {
      if (hit.target === "launcher") this.show();
      else if (hit.control?.type === "slider") {
        p.captured = hit.control.id;
        this._setSlider(hit.control.id, uvToPixel(hit.uv).x);
      } else if (hit.control) this._press(hit.control);
    }
    p.down = pressed;
    const hover = hit?.inside && hit.target === "panel" ? hit.control?.id || null : null;
    if (hover !== p.hover) {
      p.hover = hover;
      this.hover = new Set([...this.pointers.values(), p].map((q) => q.hover).filter(Boolean));
      this._dirty = true;
    }
    this.pointers.set(id, p);
  }

  _setSlider(id, px) {
    const control = this.controls.find((c) => c.id === id);
    if (!control) return;
    const value = sliderValue(control, px);
    if (value === control.value) return;
    this.setState({ [SLIDER_STATE[id]]: value });
    this.onAction(control.action, value);
  }

  _press(control) {
    this.flash = control.id;
    this.flashUntil = performance.now() + 160;
    this._dirty = true;
    if (control.action === "page") {
      const pages = pageCount(this.state.models);
      this.setState({ page: (this.state.page + control.value + pages) % pages });
      return;
    }
    this.onAction(control.action, control.value);
  }

  /** Press a control by id (desktop shortcuts and tests). */
  pressById(id) {
    const control = this.controls.find((c) => c.id === id);
    if (control) this._press(control);
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, MENU_W, MENU_H);
    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, 0, 0, MENU_W, MENU_H, 44);
    ctx.fill();
    for (const c of this.controls) {
      if (c.type === "label") this._drawLabel(c);
      else if (c.type === "slider") this._drawSlider(c);
      else this._drawButton(c);
    }
    this.texture.needsUpdate = true;
    this._dirty = false;
  }

  _drawLabel(c) {
    const ctx = this.ctx;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (c.style === "title") {
      ctx.fillStyle = COLORS.text;
      ctx.font = "700 60px system-ui, sans-serif";
      ctx.fillText(c.label, c.x, c.y + c.h / 2);
      return;
    }
    if (c.style === "status") {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "30px system-ui, sans-serif";
      const lines = wrap(ctx, c.label, c.w).slice(0, 2);
      lines.forEach((line, i) => ctx.fillText(line, c.x, c.y + 20 + i * 38));
      return;
    }
    ctx.fillStyle = COLORS.muted;
    ctx.font = "600 36px system-ui, sans-serif";
    ctx.fillText(c.label, c.x, c.y + c.h / 2);
  }

  _drawButton(c) {
    const ctx = this.ctx;
    const flash = this.flash === c.id;
    ctx.fillStyle = flash ? COLORS.flash : c.active ? COLORS.active : this.hover.has(c.id) ? COLORS.hover : COLORS.button;
    roundRect(ctx, c.x, c.y, c.w, c.h, 24);
    ctx.fill();
    ctx.fillStyle = flash || c.active ? COLORS.activeText : COLORS.text;
    ctx.font = `600 ${c.label.length <= 2 ? 52 : 40}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    if (c.align === "left") {
      ctx.textAlign = "left";
      ctx.fillText(ellipsize(ctx, c.label, c.w - 56), c.x + 28, c.y + c.h / 2 + 2);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2 + 2);
    }
  }

  _drawSlider(c) {
    const ctx = this.ctx;
    const midY = c.y + c.h / 2;
    const t = Math.min(1, Math.max(0, sliderFraction(c)));
    ctx.fillStyle = COLORS.track;
    roundRect(ctx, c.x, midY - 14, c.w, 28, 14);
    ctx.fill();
    ctx.fillStyle = COLORS.active;
    roundRect(ctx, c.x, midY - 14, Math.max(28, c.w * t), 28, 14);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c.x + c.w * t, midY, this.hover.has(c.id) ? 40 : 34, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.flash;
    ctx.fill();
  }

  _drawLauncher() {
    const ctx = this.launcherCtx;
    const s = LAUNCHER_PX;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = COLORS.active;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.activeText;
    for (const dy of [-40, 0, 40]) {
      roundRect(ctx, s / 2 - 62, s / 2 + dy - 10, 124, 20, 10);
      ctx.fill();
    }
    this.launcherTexture.needsUpdate = true;
  }
}

function wrap(ctx, text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function ellipsize(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
