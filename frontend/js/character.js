import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "/assets/models/character.glb";

export class Character {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = "nova-character";
    this.root.visible = false;
    scene.add(this.root);

    this.model = null;
    this.mixer = null;
    this.clipActions = new Map();
    this.bones = new Map();
    this.restPoses = new Map();
    this.ready = false;
    this.yaw = 0;
    this.anchored = false;
    this.idleEnabled = false;
    this.idleTime = 0;
  }

  async load() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL);
    this.model = gltf.scene;
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.frustumCulled = false;
      }
      if (obj.isBone) {
        this.bones.set(obj.name, obj);
        this.restPoses.set(obj.name, {
          position: obj.position.clone(),
          quaternion: obj.quaternion.clone(),
        });
      }
    });

    const box = new THREE.Box3().setFromObject(this.model);
    const height = Math.max(0.001, box.max.y - box.min.y);
    this.model.scale.multiplyScalar(1.72 / height);
    this.model.position.y = 0;
    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      this.clipActions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
    this.playIdle();
    this.ready = true;
    return this;
  }

  place(position, yaw = this.yaw) {
    this.yaw = yaw;
    this.root.position.copy(position);
    this.root.rotation.set(0, yaw, 0);
    this.root.visible = true;
    this.anchored = true;
  }

  rotate(deltaYaw) {
    this.yaw += deltaYaw;
    this.root.rotation.y = this.yaw;
  }

  playIdle() {
    for (const action of this.clipActions.values()) {
      action.stop();
    }
    this.restoreRestPose();
    this.idleEnabled = true;
    this.idleTime = 0;
  }

  stopIdle() {
    this.idleEnabled = false;
    this.restoreRestPose();
  }

  restoreRestPose() {
    for (const [name, pose] of this.restPoses) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      bone.position.copy(pose.position);
      bone.quaternion.copy(pose.quaternion);
    }
    this.model?.updateMatrixWorld(true);
  }

  findBone(...candidates) {
    for (const name of candidates) {
      if (this.bones.has(name)) return this.bones.get(name);
      for (const [key, bone] of this.bones) {
        if (key.toLowerCase().endsWith(name.toLowerCase())) return bone;
      }
    }
    return null;
  }

  _applyProceduralIdle(delta) {
    this.idleTime += delta;
    const breath = Math.sin(this.idleTime * 1.7) * 0.025;
    const sway = Math.sin(this.idleTime * 0.7) * 0.02;
    const chest = this.findBone("Spine2", "Spine1", "spine02", "spine01", "Spine");
    const hips = this.findBone("Hips", "hips", "pelvis");
    if (chest) {
      chest.rotation.x = (this.restPoses.get(chest.name)?.quaternion ? chest.rotation.x : chest.rotation.x);
    }
    if (chest) {
      const rest = this.restPoses.get(chest.name);
      if (rest) {
        chest.quaternion.copy(rest.quaternion);
        chest.rotateX(breath);
      }
    }
    if (hips) {
      const rest = this.restPoses.get(hips.name);
      if (rest) {
        hips.quaternion.copy(rest.quaternion);
        hips.rotateY(sway);
        hips.rotateZ(sway * 0.4);
      }
    }
  }

  update(delta) {
    if (this.idleEnabled) {
      this._applyProceduralIdle(delta);
      return;
    }
    if (this.mixer) this.mixer.update(delta);
  }
}
