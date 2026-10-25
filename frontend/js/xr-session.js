import * as THREE from "three";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";

export const OPTIONAL_FEATURES = [
  "plane-detection",
  "mesh-detection",
  "hit-test",
  "anchors",
  "hand-tracking",
  "dom-overlay",
];

const REPORTED = ["hit-test", "plane-detection", "mesh-detection", "anchors", "hand-tracking"];
const BUTTON = { trigger: 0, squeeze: 1, thumbstick: 3, a: 4, b: 5 };

export function supportedFeatureList(session) {
  return REPORTED.filter((name) => session.enabledFeatures?.includes(name));
}

export async function isArSupported() {
  try {
    return Boolean(navigator.xr && (await navigator.xr.isSessionSupported("immersive-ar")));
  } catch {
    return false;
  }
}

export async function startImmersiveAR(renderer, overlay) {
  if (!navigator.xr) throw new Error("WebXR ist in diesem Browser nicht verfügbar (HTTPS nötig).");
  if (!(await navigator.xr.isSessionSupported("immersive-ar"))) {
    throw new Error("immersive-ar wird nicht unterstützt. Quest-Browser oder WebXR-Emulator nutzen.");
  }
  const session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local-floor"],
    optionalFeatures: OPTIONAL_FEATURES,
    domOverlay: overlay ? { root: overlay } : undefined,
  });
  renderer.xr.setReferenceSpaceType("local-floor");
  await renderer.xr.setSession(session);
  if (renderer.xr.setFoveation) renderer.xr.setFoveation(0.6);
  return session;
}

function makeRay() {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x6ee7ff, transparent: true, opacity: 0.7 }));
  line.name = "ray";
  line.scale.z = 2;
  return line;
}

export function createReticle(color = 0x6ee7ff) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.025, 0.06, 12).rotateX(Math.PI / 2).translate(0, 0, 0.13),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  arrow.name = "arrow";
  group.add(ring, arrow);
  group.visible = false;
  return group;
}

/**
 * One tracked input (controller or hand) with its target ray, grip, hand joints, hit-test source and
 * edge-detected buttons.
 */
class InputSlot {
  constructor(index, renderer, scene, modelFactory) {
    this.index = index;
    this.controller = renderer.xr.getController(index);
    this.grip = renderer.xr.getControllerGrip(index);
    this.hand = renderer.xr.getHand(index);
    this.ray = makeRay();
    this.controller.add(this.ray);
    this.grip.add(modelFactory.createControllerModel(this.grip));
    this.tip = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0x6ee7ff }));
    this.tip.visible = false;
    scene.add(this.controller, this.grip, this.hand, this.tip);

    this.source = null;
    this.hitTestSource = null;
    this.hit = null;
    this.selecting = false;
    this.squeezing = false;
    this.buttons = [];
    this.pressed = new Set();
    this.released = new Set();
    this.axes = [0, 0];

    this.controller.addEventListener("connected", (event) => this._connect(event.data, renderer));
    this.controller.addEventListener("disconnected", () => this._disconnect());
  }

  get handedness() {
    return this.source?.handedness || "none";
  }

  get isHand() {
    return Boolean(this.source?.hand);
  }

  get connected() {
    return Boolean(this.source);
  }

  async _connect(source, renderer) {
    this.source = source;
    this.ray.visible = true;
    const session = renderer.xr.getSession();
    if (session?.requestHitTestSource && source.targetRaySpace) {
      try {
        this.hitTestSource = await session.requestHitTestSource({ space: source.targetRaySpace });
      } catch {
        this.hitTestSource = null;
      }
    }
  }

  _disconnect() {
    this.hitTestSource?.cancel?.();
    this.hitTestSource = null;
    this.source = null;
    this.hit = null;
    this.selecting = false;
    this.squeezing = false;
    this.tip.visible = false;
  }

  rayOrigin(out) {
    return this.controller.getWorldPosition(out);
  }

  rayDirection(out) {
    return out.set(0, 0, -1).applyQuaternion(this.controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
  }

  /** Position of the hand/controller used for gestures and collisions. */
  handPosition(out) {
    const wrist = this.hand.joints?.wrist;
    if (this.isHand && wrist) return wrist.getWorldPosition(out);
    return (this.grip.visible ? this.grip : this.controller).getWorldPosition(out);
  }

  joint(name) {
    return this.isHand ? this.hand.joints?.[name] || null : null;
  }

  update(frame, refSpace, groundY) {
    this.pressed.clear();
    this.released.clear();
    if (!this.source) return;
    const gamepad = this.source.gamepad;
    if (gamepad && !this.isHand) {
      gamepad.buttons.forEach((b, i) => {
        const was = this.buttons[i] || false;
        if (b.pressed && !was) this.pressed.add(i);
        if (!b.pressed && was) this.released.add(i);
        this.buttons[i] = b.pressed;
      });
      const ax = gamepad.axes;
      this.axes = ax.length >= 4 ? [ax[2], ax[3]] : [ax[0] || 0, ax[1] || 0];
    } else {
      this.axes = [0, 0];
    }

    this.hit = null;
    const results = this.hitTestSource ? frame.getHitTestResults(this.hitTestSource) : [];
    const pose = results[0]?.getPose(refSpace);
    if (pose) {
      const p = pose.transform.position;
      this.hit = new THREE.Vector3(p.x, p.y, p.z);
    } else {
      const origin = this.rayOrigin(new THREE.Vector3());
      const dir = this.rayDirection(new THREE.Vector3());
      if (dir.y < -0.05) {
        const t = (groundY - origin.y) / dir.y;
        if (t > 0 && t < 12) this.hit = origin.addScaledVector(dir, t);
      }
    }
    const indexTip = this.joint("index-finger-tip");
    this.tip.visible = Boolean(indexTip);
    if (indexTip) indexTip.getWorldPosition(this.tip.position);
  }

  setRayLength(length, color) {
    this.ray.scale.z = Math.max(0.05, length);
    if (color !== undefined) this.ray.material.color.setHex(color);
  }

  wasPressed(name) {
    return this.pressed.has(BUTTON[name]);
  }
}

export class XRInput {
  constructor(renderer, scene) {
    const factory = new XRControllerModelFactory();
    this.slots = [0, 1].map((i) => new InputSlot(i, renderer, scene, factory));
  }

  forEachConnected(fn) {
    for (const slot of this.slots) if (slot.connected) fn(slot);
  }

  byHand(handedness) {
    return this.slots.find((s) => s.connected && s.handedness === handedness) || null;
  }

  update(frame, refSpace, groundY) {
    for (const slot of this.slots) slot.update(frame, refSpace, groundY);
  }

  on(type, handler) {
    for (const slot of this.slots) slot.controller.addEventListener(type, () => handler(slot));
  }
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

function poseToBox(pose, minX, maxX, minY, maxY, minZ, maxZ) {
  tmpMatrix.fromArray(pose.transform.matrix);
  tmpMatrix.decompose(tmpPos, tmpQuat, tmpScale);
  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2).applyMatrix4(tmpMatrix);
  return {
    center,
    quaternion: tmpQuat.clone(),
    half: new THREE.Vector3(Math.max(0.01, (maxX - minX) / 2), Math.max(0.01, (maxY - minY) / 2), Math.max(0.01, (maxZ - minZ) / 2)),
  };
}

/**
 * Turns detected planes and meshes into collider specs. Floors become the ground height; walls, tables and
 * furniture meshes become thin/solid boxes. Large "global" meshes are skipped (they would enclose the figure).
 */
export function readRoom(frame, refSpace, physics) {
  const planes = frame.detectedPlanes || null;
  const meshes = frame.detectedMeshes || null;
  let floorY = null;
  let planeCount = 0;
  let meshCount = 0;
  physics.beginRoomSync();
  if (planes) {
    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;
      planeCount += 1;
      const label = plane.semanticLabel || "";
      const horizontal = plane.orientation !== "vertical";
      const y = pose.transform.position.y;
      if (label === "floor" || (horizontal && !label && Math.abs(y) < 0.25)) {
        floorY = floorY === null ? y : Math.min(floorY, y);
        continue;
      }
      if (label === "ceiling") continue;
      physics.syncRoomCollider(plane, plane.lastChangedTime, () => {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of plane.polygon) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
        if (!Number.isFinite(minX)) return null;
        return poseToBox(pose, minX, maxX, -0.06, 0, minZ, maxZ);
      });
    }
  }
  if (meshes) {
    for (const mesh of meshes) {
      const label = mesh.semanticLabel || "";
      if (/global|floor|ceiling/i.test(label)) continue;
      const pose = frame.getPose(mesh.meshSpace, refSpace);
      if (!pose) continue;
      meshCount += 1;
      physics.syncRoomCollider(mesh, mesh.lastChangedTime, () => {
        const v = mesh.vertices;
        if (!v || v.length < 9) return null;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 3) {
          for (let k = 0; k < 3; k += 1) {
            min[k] = Math.min(min[k], v[i + k]);
            max[k] = Math.max(max[k], v[i + k]);
          }
        }
        if (max[0] - min[0] > 3 || max[1] - min[1] > 3 || max[2] - min[2] > 3) return null;
        return poseToBox(pose, min[0], max[0], min[1], max[1], min[2], max[2]);
      });
    }
  }
  physics.endRoomSync();
  return { floorY, planeCount, meshCount, available: Boolean(planes || meshes) };
}

/** Anchor helper: keeps the figure locked to the real room when tracking re-localises. */
export class AnchorKeeper {
  constructor() {
    this.anchor = null;
    this.pending = null;
  }

  request(position, yaw) {
    this.pending = { position: position.clone(), yaw };
  }

  clear() {
    this.anchor?.delete?.();
    this.anchor = null;
    this.pending = null;
  }

  async update(frame, refSpace) {
    if (this.pending && frame.createAnchor) {
      const { position, yaw } = this.pending;
      this.pending = null;
      this.anchor?.delete?.();
      this.anchor = null;
      try {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        this.anchor = await frame.createAnchor(
          new XRRigidTransform({ x: position.x, y: position.y, z: position.z }, { x: q.x, y: q.y, z: q.z, w: q.w }),
          refSpace,
        );
      } catch {
        this.anchor = null;
      }
    }
  }

  /** @returns {{position: THREE.Vector3, yaw: number} | null} */
  pose(frame, refSpace) {
    if (!this.anchor || !frame.trackedAnchors?.has(this.anchor)) return null;
    const pose = frame.getPose(this.anchor.anchorSpace, refSpace);
    if (!pose) return null;
    const { position: p, orientation: o } = pose.transform;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    return { position: new THREE.Vector3(p.x, p.y, p.z), yaw: Math.atan2(fwd.x, fwd.z) };
  }
}
