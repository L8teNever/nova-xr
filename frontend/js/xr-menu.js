import * as THREE from "three";

const W = 512;
const H = 320;
const PANEL_W = 0.18;
const PANEL_H = (PANEL_W * H) / W;
const PRESS_COOLDOWN = 450;

const BUTTONS = [
  { id: "place", label: "Platzieren", x: 16, y: 16, w: 232, h: 92 },
  { id: "interact", label: "Interaktion", x: 264, y: 16, w: 232, h: 92 },
  { id: "reset", label: "Aufstellen", x: 16, y: 124, w: 232, h: 92 },
  { id: "next", label: "Modell ▸", x: 264, y: 124, w: 232, h: 92 },
];

/**
 * Small panel above the left wrist/controller, shown while that hand is raised. Buttons react to a ray
 * select (controller trigger / pinch) or to a poke with the other hand's index fingertip.
 */
export class XRMenu {
  constructor(scene, onAction) {
    this.onAction = onAction;
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, PANEL_H),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.mode = "place";
    this.status = "";
    this.hover = null;
    this.lastPress = 0;
    this.flash = null;
    this.raycaster = new THREE.Raycaster();
    this._dirty = true;
    this.draw();
  }

  setState({ mode, status }) {
    if (mode !== undefined && mode !== this.mode) {
      this.mode = mode;
      this._dirty = true;
    }
    if (status !== undefined && status !== this.status) {
      this.status = status;
      this._dirty = true;
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(11,16,32,0.86)";
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();
    for (const b of BUTTONS) {
      const active = b.id === this.mode;
      ctx.fillStyle = this.flash === b.id ? "#f8fafc" : active ? "#2dd4bf" : this.hover === b.id ? "#334a7d" : "#1d2a4a";
      roundRect(ctx, b.x, b.y, b.w, b.h, 22);
      ctx.fill();
      ctx.fillStyle = active || this.flash === b.id ? "#04212a" : "#e8eefc";
      ctx.font = "600 38px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 2);
    }
    ctx.fillStyle = "#9aacd1";
    ctx.font = "28px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(this.status.slice(0, 34), 22, 268);
    this.texture.needsUpdate = true;
    this._dirty = false;
  }

  /** Place the panel above the holder hand and turn it towards the head. */
  update(holder, camera) {
    const visible = Boolean(holder);
    if (visible) {
      const anchor = new THREE.Vector3();
      holder.handPosition(anchor);
      const head = camera.getWorldPosition(new THREE.Vector3());
      const raised = anchor.y > head.y - 0.75;
      this.mesh.visible = raised;
      if (raised) {
        this.mesh.position.copy(anchor).add(new THREE.Vector3(0, 0.11, 0));
        this.mesh.lookAt(head);
      }
    } else {
      this.mesh.visible = false;
    }
    if (this.flash && performance.now() - this.lastPress > 180) {
      this.flash = null;
      this._dirty = true;
    }
    if (this._dirty) this.draw();
  }

  _buttonAtUv(uv) {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    return BUTTONS.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  /** @returns {{button: object|null, distance: number} | null} */
  intersectRay(origin, direction) {
    if (!this.mesh.visible) return null;
    this.raycaster.set(origin, direction);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    return { button: this._buttonAtUv(hit.uv), distance: hit.distance };
  }

  setHover(id) {
    if (id !== this.hover) {
      this.hover = id;
      this._dirty = true;
    }
  }

  press(id) {
    const now = performance.now();
    if (!id || now - this.lastPress < PRESS_COOLDOWN) return false;
    this.lastPress = now;
    this.flash = id;
    this._dirty = true;
    this.onAction(id);
    return true;
  }

  /** Fingertip poke: pressed when the tip crosses the panel plane inside a button. */
  poke(tipWorld) {
    if (!this.mesh.visible) return;
    const local = this.mesh.worldToLocal(tipWorld.clone());
    if (Math.abs(local.z) > 0.012) return;
    const uv = new THREE.Vector2(local.x / PANEL_W + 0.5, local.y / PANEL_H + 0.5);
    if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return;
    const button = this._buttonAtUv(uv);
    if (button) this.press(button.id);
  }
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
