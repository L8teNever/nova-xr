import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { describeMissing, isHelperBoneName, mapHumanoid, normalizeBoneName } from "../js/humanoid-map.js";
import { PhysicsWorld } from "../js/physics-world.js";

const FIXTURES = new URL("../../tests/fixtures/rigs/", import.meta.url);
const load = (file) => JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));

/** Bones from a fixture; a parent name refers to the latest bone defined with that name. */
function buildRig(fixture, rename = (n) => n) {
  const root = new THREE.Group();
  const byName = new Map();
  const list = [];
  for (const [name, parent, x, y, z] of fixture.bones) {
    const bone = new THREE.Bone();
    bone.name = rename(name);
    bone.position.set(x, y, z);
    const attach = parent ? byName.get(parent) : root;
    if (!attach) continue;
    attach.add(bone);
    byName.set(name, bone);
    list.push(bone);
  }
  root.updateMatrixWorld(true);
  return { root, list };
}

function checkMapping(fixture, rename = (n) => n) {
  const rig = buildRig(fixture, rename);
  const result = mapHumanoid(rig.list);
  assert.ok(result.physicsReady, `missing ${result.missingRequired}`);
  assert.deepEqual(result.missingRequired, []);
  for (const [key, name] of Object.entries(fixture.expect)) {
    assert.equal(result.bones[key]?.name, rename(name), key);
  }
  for (const [key, name] of Object.entries(fixture.expectFingers || {})) {
    assert.equal(result.fingers[key]?.name, rename(name), key);
  }
  for (const [key, parent] of Object.entries(fixture.expectParents || {})) {
    assert.equal(result.bones[key].parent.name, rename(parent), `${key} parent`);
  }
  const mapped = new Set([...Object.values(result.bones), ...Object.values(result.fingers)]);
  const forbidden = new Set([...fixture.helpers, ...fixture.unmapped].map(rename));
  const expected = new Set(Object.values(fixture.expect).map(rename));
  for (const bone of mapped) {
    assert.ok(!forbidden.has(bone.name) || expected.has(bone.name), `${bone.name} must not be mapped`);
  }
  for (const name of fixture.helpers) assert.ok(result.ignored.includes(rename(name)), `${name} should be ignored`);
  return { rig, result };
}

test("3ds Max Biped skeleton maps along its hierarchy and skips helpers", () => {
  const fixture = load("biped.json");
  const { result } = checkMapping(fixture);
  assert.notEqual(result.bones.hips.name, "Bip001");
  assert.equal(result.bones.leftFoot.parent.name, "Bip001 L Calf");
});

test("Biped naming variants: any Bip number, separators space, dash, underscore", () => {
  const fixture = load("biped.json");
  for (const prefix of ["Bip001", "Bip01", "Bip002", "Bip1"]) {
    for (const sep of [" ", "-", "_"]) {
      const rename = (name) => (name.startsWith("Bip001") ? name.replace(/^Bip001/, prefix).replaceAll(" ", sep) : name);
      checkMapping(fixture, rename);
    }
  }
});

test("Unreal mannequin skeleton maps; IK copies, twist bones and sockets stay unmapped", () => {
  checkMapping(load("ue-mannequin.json"));
});

test("helper bone names", () => {
  for (const name of [
    "upperarm_twist_01_l", "Bip001 L ForeTwist", "thigh_avg_l", "spine_push", "hand_r_socket", "weapon_r", "Bip001 R Prop1",
    "ik_foot_l", "IKFoot_L", "foot_l_IK", "LeftFootIK", "HeadTop_End", "neck_end", "Bip001 Footsteps", "root_foot", "root_hand",
    "Bip001 L Finger0Nub",
  ]) {
    assert.ok(isHelperBoneName(name), name);
  }
  for (const name of ["Bip001 Pelvis", "hand_l", "mixamorig:LeftHand", "J_Bip_L_UpperArm", "thigh.L", "root", "Bip001 Spine2", "spine_03"]) {
    assert.ok(!isHelperBoneName(name), name);
  }
  assert.equal(normalizeBoneName("Bip001-L-Thigh"), "lthigh");
  assert.equal(normalizeBoneName("Bip01_R_Toe0"), "rtoe0");
  assert.equal(normalizeBoneName("upperarm_l"), "lupperarm");
  assert.equal(normalizeBoneName("Bip001"), "");
});

test("a foot copy under root_foot is not taken even when it is not named like a helper", () => {
  const fixture = load("biped.json");
  const rename = (name) => (name === "root_foot" ? "FootCopies" : name);
  const { result } = checkMapping({ ...fixture, helpers: fixture.helpers.filter((n) => n !== "root_foot" && !/^foot_/.test(n)) }, rename);
  assert.equal(result.bones.leftFoot.name, "Bip001 L Foot");
  assert.equal(result.bones.rightFoot.name, "Bip001 R Foot");
});

test("missing required bones are reported in readable form", () => {
  const fixture = load("ue-mannequin.json");
  const skip = new Set(["calf_r", "foot_r", "ball_r", "calf_twist_01_r"]);
  const rig = buildRig({ bones: fixture.bones.filter(([name]) => !skip.has(name)) });
  const result = mapHumanoid(rig.list);
  assert.equal(result.physicsReady, false);
  assert.deepEqual(result.missingRequired, ["rightLowerLeg", "rightFoot"]);
  assert.equal(describeMissing(result.missingRequired), "rechter Unterschenkel, rechter Fuß");
});

for (const file of ["biped.json", "ue-mannequin.json"]) {
  test(`ragdoll on the ${file} skeleton stands on its own`, () => {
    const rig = buildRig(load(file));
    const humanoid = mapHumanoid(rig.list);
    const physics = new PhysicsWorld();
    physics.enabled = true;
    const rest = new Map(rig.list.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
    const ragdoll = physics.ragdoll;
    ragdoll.build(humanoid.bones, 1.7, 0);
    const start = ragdoll.byId.get("pelvis").body.position.clone();
    let maxTilt = 0;
    for (let t = 0; t < 4; t += 1 / 72) {
      for (const [bone, r] of rest) {
        bone.quaternion.copy(r.q);
        bone.position.copy(r.p);
      }
      rig.root.updateMatrixWorld(true);
      ragdoll.captureTargets();
      physics.step(1 / 72);
      ragdoll.writeBones();
      maxTilt = Math.max(maxTilt, (ragdoll.torsoTilt() * 180) / Math.PI);
    }
    const p = ragdoll.byId.get("pelvis").body.position;
    assert.equal(ragdoll.state, "standing");
    assert.ok(maxTilt < 8, `tilt ${maxTilt.toFixed(1)}°`);
    assert.ok(Math.hypot(p.x - start.x, p.z - start.z) < 0.08, "drifted");
    const head = humanoid.bones.head.getWorldPosition(new THREE.Vector3());
    assert.ok(head.y > 1.4, `head at ${head.y.toFixed(2)} m`);
    const hand = ragdoll.handPosition("left");
    ragdoll.grab("left", hand);
    const target = new CANNON.Vec3(hand.x + 0.05, hand.y + 0.35, hand.z + 0.15);
    for (let t = 0; t < 1.5; t += 1 / 72) {
      ragdoll.setGrabTarget("left", target, 1 / 72);
      rig.root.updateMatrixWorld(true);
      ragdoll.captureTargets();
      physics.step(1 / 72);
      ragdoll.writeBones();
    }
    const lifted = ragdoll.handPosition("left");
    assert.ok(lifted.distanceTo(target) < 0.12, `hand ${lifted.distanceTo(target).toFixed(2)} m from target`);
  });
}
