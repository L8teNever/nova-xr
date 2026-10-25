import * as THREE from "three";

/** Mixamo-named skeleton, 1.7 m tall, arms hanging (A-pose), facing +Z, feet at y=0. */
export function buildTestRig({ prefix = "mixamorig", armsDown = true } = {}) {
  const root = new THREE.Group();
  const bones = {};
  const make = (name, parent, x, y, z) => {
    const bone = new THREE.Bone();
    bone.name = `${prefix}${name}`;
    bone.position.set(x, y, z);
    (parent ? bones[parent] : root).add(bone);
    bones[name] = bone;
    return bone;
  };
  make("Hips", null, 0, 0.95, 0);
  make("Spine", "Hips", 0, 0.1, 0);
  make("Spine1", "Spine", 0, 0.12, 0);
  make("Spine2", "Spine1", 0, 0.12, 0);
  make("Neck", "Spine2", 0, 0.14, 0);
  make("Head", "Neck", 0, 0.09, 0.01);
  for (const [side, s] of [["Left", 1], ["Right", -1]]) {
    make(`${side}Shoulder`, "Spine2", 0.05 * s, 0.1, 0);
    make(`${side}Arm`, `${side}Shoulder`, 0.12 * s, 0, 0);
    if (armsDown) {
      make(`${side}ForeArm`, `${side}Arm`, 0.03 * s, -0.27, 0);
      make(`${side}Hand`, `${side}ForeArm`, 0.01 * s, -0.25, 0.02);
    } else {
      make(`${side}ForeArm`, `${side}Arm`, 0.27 * s, 0, 0);
      make(`${side}Hand`, `${side}ForeArm`, 0.25 * s, 0, 0);
    }
    make(`${side}UpLeg`, "Hips", 0.09 * s, -0.05, 0);
    make(`${side}Leg`, `${side}UpLeg`, 0, -0.43, 0.005);
    make(`${side}Foot`, `${side}Leg`, 0, -0.41, -0.01);
    make(`${side}ToeBase`, `${side}Foot`, 0, -0.05, 0.12);
  }
  root.updateMatrixWorld(true);
  return { root, bones, list: Object.values(bones) };
}
