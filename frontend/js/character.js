import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { VRMLoaderPlugin, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere, VRMUtils } from "@pixiv/three-vrm";
import { mapFromVrm, mapHumanoid } from "./humanoid-map.js";

const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs";
const IDLE_PATTERN = /idle|stand|breath/i;
const SKIP_PATTERN = /t-?pose|a-?pose|bind/i;
const BLEND_TIME = 0.35;
const CLOTH_PATTERN = /cloth|tops?\b|shirt|jacket|dress|coat|hoodie|sweater/i;

let sharedLoader = null;

function createLoader(renderer) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader().setDecoderPath(`${THREE_CDN}/draco/gltf/`);
  loader.setDRACOLoader(draco);
  if (renderer) {
    const ktx2 = new KTX2Loader().setTranscoderPath(`${THREE_CDN}/basis/`).detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

function makeShadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

export class Character {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = "nova-character";
    this.root.visible = false;
    scene.add(this.root);
    this.pivot = new THREE.Group();
    this.root.add(this.pivot);

    this.model = null;
    this.vrm = null;
    this.mixer = null;
    this.idleAction = null;
    this.humanoid = { bones: {}, missing: [], missingRequired: [], physicsReady: false };
    this.restPose = new Map();
    this.height = 1.7;
    this.scale = 1;
    this.yaw = 0;
    this.placed = false;
    this.entry = null;
    this.idleTime = 0;
    this.blend = null;
    this.touchers = new Map();
    this.touchGroup = null;
    this.shield = [];

    if (typeof document !== "undefined") {
      this.shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false }),
      );
      this.shadow.renderOrder = -1;
      this.shadow.visible = false;
      scene.add(this.shadow);
    }
  }

  get ready() {
    return Boolean(this.model);
  }

  /** Height in the scene, including the user's size setting. */
  get worldHeight() {
    return this.height * this.scale;
  }

  setScale(scale) {
    this.scale = scale;
    this.root.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);
  }

  async load(entry, onProgress) {
    sharedLoader ||= createLoader(this.renderer);
    const gltf = await sharedLoader.loadAsync(entry.url, (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    this.dispose();
    this.entry = entry;

    const vrm = gltf.userData.vrm || null;
    let model = gltf.scene;
    if (vrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      vrm.humanoid.autoUpdateHumanBones = false;
      model = vrm.scene;
    }
    this.vrm = vrm;
    this.model = model;
    // Facing and size are measured at scale 1; the user's size setting is applied on top.
    this.root.scale.setScalar(1);
    model.traverse((obj) => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        obj.frustumCulled = false;
        obj.castShadow = false;
      }
    });
    this.pivot.add(model);
    this.pivot.rotation.set(0, 0, 0);
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);

    const bones = [];
    model.traverse((obj) => obj.isBone && bones.push(obj));
    this.humanoid = vrm ? mapFromVrm(vrm) : mapHumanoid(bones);
    this.animatedBones = bones;
    for (const bone of bones) this.restPose.set(bone, { q: bone.quaternion.clone(), p: bone.position.clone() });

    this._faceForward();
    this._normalizeSize();
    this._buildClothShield();
    this._setupIdle(gltf.animations || []);
    this.root.scale.setScalar(this.scale);
    this.update(0);
    return this;
  }

  /** Rotate the model inside the pivot so the figure looks along the root's +Z axis. */
  _faceForward() {
    const h = this.humanoid.bones;
    if (!h.leftUpperLeg || !h.rightUpperLeg) return;
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const l = h.leftUpperLeg.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const r = h.rightUpperLeg.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const lateral = l.sub(r).setY(0);
    if (lateral.lengthSq() < 1e-10) return;
    const forward = new THREE.Vector3().crossVectors(lateral.normalize(), new THREE.Vector3(0, 1, 0));
    this.pivot.rotation.y = -Math.atan2(forward.x, forward.z);
    this.pivot.updateMatrixWorld(true);
  }

  _normalizeSize() {
    const model = this.model;
    this.root.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model, true);
    let height = box.max.y - box.min.y;
    if (!(height > 0.5 && height < 2.6)) {
      model.scale.multiplyScalar(1.7 / Math.max(height, 1e-4));
      this.root.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model, true);
      height = box.max.y - box.min.y;
    }
    this.height = height;
    const hips = this.humanoid.bones.hips;
    const center = hips ? hips.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
    const inv = new THREE.Matrix4().copy(this.pivot.matrixWorld).invert();
    const local = center.setY(box.min.y).applyMatrix4(inv);
    model.position.sub(local);
    this.root.updateMatrixWorld(true);
  }

  _setupIdle(clips) {
    this.mixer = new THREE.AnimationMixer(this.model);
    const usable = clips.filter((c) => !SKIP_PATTERN.test(c.name) && c.duration > 0);
    const idle = usable.find((c) => /^idle$/i.test(c.name)) || usable.find((c) => IDLE_PATTERN.test(c.name));
    this.clipNames = clips.map((c) => c.name);
    this.idleAction = idle ? this.mixer.clipAction(idle).play() : null;
    this.idleSource = idle ? `Clip „${idle.name}“` : "prozedural";
    this.relaxedPose = idle ? null : this._relaxedPose();
  }

  /** Arms down from a T/A bind pose, as local rotations per bone. */
  _relaxedPose() {
    const h = this.humanoid.bones;
    const pose = new Map();
    const up = new THREE.Vector3(0, 1, 0);
    for (const side of ["left", "right"]) {
      const upper = h[`${side}UpperArm`];
      const lower = h[`${side}LowerArm`];
      if (!upper || !lower) continue;
      this.root.updateMatrixWorld(true);
      const a = upper.getWorldPosition(new THREE.Vector3());
      const b = lower.getWorldPosition(new THREE.Vector3());
      const dir = b.sub(a).normalize();
      if (dir.y < -0.75) continue;
      const outward = dir.clone().setY(0).normalize();
      const target = outward.multiplyScalar(0.28).addScaledVector(up, -0.96).normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(dir, target);
      const worldQ = upper.getWorldQuaternion(new THREE.Quaternion());
      const parentQ = upper.parent.getWorldQuaternion(new THREE.Quaternion());
      const local = parentQ.invert().multiply(delta.multiply(worldQ));
      pose.set(upper, local);
      upper.quaternion.copy(local);
    }
    for (const [bone, { q }] of this.restPose) if (!pose.has(bone)) bone.quaternion.copy(q);
    return pose;
  }

  _applyProceduralIdle(delta) {
    this.idleTime += delta;
    for (const [bone, q] of this.relaxedPose) bone.quaternion.copy(q);
    const h = this.humanoid.bones;
    const breath = Math.sin(this.idleTime * 1.6) * 0.02;
    const sway = Math.sin(this.idleTime * 0.6) * 0.015;
    const chest = h.upperChest || h.chest || h.spine;
    if (chest) chest.rotateX(breath);
    if (h.hips) h.hips.rotateZ(sway);
    if (h.spine && h.spine !== chest) h.spine.rotateZ(-sway * 0.8);
  }

  resetToRest() {
    for (const [bone, { q, p }] of this.restPose) {
      bone.quaternion.copy(q);
      bone.position.copy(p);
    }
  }

  /** Evaluate the idle animation into the bones (also the physics target pose). */
  update(delta) {
    if (!this.model) return;
    this.resetToRest();
    if (this.idleAction) this.mixer.update(delta);
    else if (this.relaxedPose) this._applyProceduralIdle(delta);
    if (this.blend) this._applyBlend(delta);
    this.root.updateMatrixWorld(true);
  }

  /** Secondary motion (VRM spring bones) after the final pose is known. */
  updateSecondary(delta) {
    for (const collider of this.shield) collider.updateWorldMatrix(false, false);
    this.vrm?.update(Math.min(delta, 1 / 30));
  }

  /**
   * VRM body colliders hug the body, but shirts are often wider: long hair then sinks into the back of the
   * clothes. Measure the back surface of the clothing mesh and cover it with small spring-bone colliders.
   */
  _buildClothShield() {
    const manager = this.vrm?.springBoneManager;
    const h = this.humanoid.bones;
    const top = h.upperChest || h.chest || h.spine;
    if (!manager || !h.hips || !top || !h.neck) return;
    this.root.updateMatrixWorld(true);
    const toRoot = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const rootPos = (bone) => bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);
    const yMin = rootPos(h.hips).y;
    const yMax = rootPos(h.neck).y;
    const armX = h.leftUpperArm && h.rightUpperArm
      ? Math.min(Math.abs(rootPos(h.leftUpperArm).x), Math.abs(rootPos(h.rightUpperArm).x))
      : Infinity;
    const step = 0.05 * (this.height / 1.7);
    const rows = Math.max(1, Math.ceil((yMax - yMin) / step));
    const cols = 7;
    const back = Array.from({ length: rows }, () => ({ min: Infinity, max: -Infinity, cells: new Array(cols).fill(Infinity) }));
    const v = new THREE.Vector3();
    let found = false;
    this.model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || !mesh.geometry.index) return;
      const materials = [].concat(mesh.material);
      const index = mesh.geometry.index;
      for (const group of mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }]) {
        if (!CLOTH_PATTERN.test(materials[group.materialIndex]?.name || "")) continue;
        for (let i = group.start; i < group.start + group.count; i += 1) {
          mesh.getVertexPosition(index.getX(i), v).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot);
          if (v.y < yMin || v.y > yMax || Math.abs(v.x) > armX * 0.92) continue;
          const row = back[Math.min(rows - 1, Math.floor((v.y - yMin) / step))];
          row.min = Math.min(row.min, v.x);
          row.max = Math.max(row.max, v.x);
          found = true;
        }
      }
    });
    if (!found) return;
    // second pass: back-most depth (smallest z) per column of each row
    this.model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || !mesh.geometry.index) return;
      const materials = [].concat(mesh.material);
      const index = mesh.geometry.index;
      for (const group of mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }]) {
        if (!CLOTH_PATTERN.test(materials[group.materialIndex]?.name || "")) continue;
        for (let i = group.start; i < group.start + group.count; i += 1) {
          mesh.getVertexPosition(index.getX(i), v).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot);
          if (v.y < yMin || v.y > yMax || Math.abs(v.x) > armX * 0.92) continue;
          const row = back[Math.min(rows - 1, Math.floor((v.y - yMin) / step))];
          if (!(row.max > row.min)) continue;
          const col = Math.min(cols - 1, Math.floor(((v.x - row.min) / (row.max - row.min)) * cols));
          row.cells[col] = Math.min(row.cells[col], v.z);
        }
      }
    });

    const radius = 0.05 * (this.height / 1.7);
    const chain = [h.hips, h.spine, h.chest, h.upperChest].filter(Boolean);
    const group = { name: "nova-cloth", colliders: [] };
    for (let r = 0; r < rows; r += 1) {
      const row = back[r];
      if (!(row.max > row.min)) continue;
      const y = yMin + (r + 0.5) * step;
      for (let c = 0; c < cols; c += 1) {
        if (!Number.isFinite(row.cells[c])) continue;
        const x = row.min + ((c + 0.5) / cols) * (row.max - row.min);
        const world = new THREE.Vector3(x, y, row.cells[c] + radius).applyMatrix4(this.root.matrixWorld);
        // attach to the highest torso bone that is not above this height
        let bone = chain[0];
        for (const candidate of chain) if (rootPos(candidate).y <= y) bone = candidate;
        bone.updateWorldMatrix(true, false);
        const collider = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({ radius }));
        collider.position.copy(bone.worldToLocal(world));
        bone.add(collider);
        collider.updateWorldMatrix(true, false);
        group.colliders.push(collider);
        this.shield.push(collider);
      }
    }
    for (const joint of manager.joints) joint.colliderGroups = [...joint.colliderGroups, group];
    manager.setInitState();
  }

  /**
   * Let hands touch the hair and clothes: each id is a sphere in world space that spring bones (hair, skirt,
   * ...) collide with. `null` removes the sphere (parked far away so the collider list never changes).
   */
  setTouchSphere(id, position, radius = 0.03) {
    const manager = this.vrm?.springBoneManager;
    if (!manager) return;
    if (!this.touchGroup) this._createTouchGroup(manager);
    let entry = this.touchers.get(id);
    if (!entry) {
      const shape = new VRMSpringBoneColliderShapeSphere({ radius });
      const collider = new VRMSpringBoneCollider(shape);
      this.touchGroup.colliders.push(collider);
      entry = { collider, shape };
      this.touchers.set(id, entry);
    }
    if (position) {
      entry.shape.radius = radius;
      entry.collider.position.copy(position);
    } else {
      entry.collider.position.set(0, -1000, 0);
    }
    entry.collider.updateWorldMatrix(true, false);
  }

  _createTouchGroup(manager) {
    this.touchGroup = { name: "nova-touch", colliders: [] };
    for (const joint of manager.joints) {
      joint.colliderGroups = [...joint.colliderGroups, this.touchGroup];
      // Hair strands are points: a little thickness keeps fingers from slipping through.
      joint.settings.hitRadius = Math.max(joint.settings.hitRadius || 0, 0.015);
    }
  }

  /** Remember the current (simulated) pose and fade from it into the animation. */
  startBlendFromCurrent() {
    const hips = this.humanoid.bones.hips;
    if (!hips) return;
    this.root.updateMatrixWorld(true);
    const hipsWorld = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    hips.matrixWorld.decompose(hipsWorld.p, hipsWorld.q, new THREE.Vector3());
    const local = Object.values(this.humanoid.bones).map((bone) => ({ bone, q: bone.quaternion.clone(), p: bone.position.clone() }));
    this.blend = { t: 0, local, hipsWorld, resolved: false };
  }

  _applyBlend(delta) {
    const blend = this.blend;
    const hips = this.humanoid.bones.hips;
    if (!blend.resolved) {
      // The root may have moved since the pose was stored: express the hips in their parent's new frame.
      hips.parent.updateWorldMatrix(true, false);
      const pq = hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      const entry = blend.local.find((e) => e.bone === hips);
      entry.q.copy(pq.multiply(blend.hipsWorld.q));
      entry.p.copy(hips.parent.worldToLocal(blend.hipsWorld.p.clone()));
      blend.resolved = true;
    }
    blend.t += delta;
    const k = Math.min(1, blend.t / BLEND_TIME);
    const e = k * k * (3 - 2 * k);
    const tmpQ = new THREE.Quaternion();
    const tmpP = new THREE.Vector3();
    for (const { bone, q, p } of blend.local) {
      bone.quaternion.copy(tmpQ.copy(q).slerp(bone.quaternion, e));
      if (bone === hips) bone.position.copy(tmpP.copy(p).lerp(bone.position, e));
    }
    if (k >= 1) this.blend = null;
  }

  place(position, yaw = this.yaw, { teleport = false } = {}) {
    this.yaw = yaw;
    this.root.position.copy(position);
    this.root.rotation.set(0, yaw, 0);
    this.root.visible = Boolean(this.model);
    this.placed = true;
    this.root.updateMatrixWorld(true);
    if (teleport) this.vrm?.springBoneManager?.reset();
  }

  rotate(deltaYaw) {
    this.place(this.root.position, this.yaw + deltaYaw);
  }

  updateShadow(groundY) {
    if (!this.shadow) return;
    const hips = this.humanoid.bones.hips;
    this.shadow.visible = this.root.visible;
    if (!hips || !this.root.visible) return;
    const p = hips.getWorldPosition(new THREE.Vector3());
    const height = Math.max(0, p.y - groundY);
    const size = this.worldHeight * 0.42 * (1 + Math.max(0, 0.5 - height / this.worldHeight));
    this.shadow.position.set(p.x, groundY + 0.003, p.z);
    this.shadow.scale.set(size, 1, size);
  }

  dispose() {
    if (!this.model) return;
    this.pivot.remove(this.model);
    if (this.vrm) VRMUtils.deepDispose(this.model);
    else {
      this.model.traverse((obj) => {
        obj.geometry?.dispose();
        for (const m of [].concat(obj.material || [])) {
          for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
          m.dispose();
        }
      });
    }
    this.mixer?.stopAllAction();
    this.model = null;
    this.vrm = null;
    this.touchers.clear();
    this.touchGroup = null;
    this.shield = [];
    this.mixer = null;
    this.idleAction = null;
    this.restPose.clear();
    this.blend = null;
    this.humanoid = { bones: {}, missing: [], missingRequired: [], physicsReady: false };
  }
}
