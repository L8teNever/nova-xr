import assert from "node:assert/strict";
import test from "node:test";
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { mapHumanoid } from "../js/humanoid-map.js";
import { PhysicsWorld } from "../js/physics-world.js";
import { buildTestRig } from "./rig-fixture.mjs";

const DEG = 180 / Math.PI;

function setup() {
  const rig = buildTestRig();
  const humanoid = mapHumanoid(rig.list);
  assert.ok(humanoid.physicsReady, `missing: ${humanoid.missing}`);
  const physics = new PhysicsWorld();
  physics.enabled = true;
  const rest = new Map(rig.list.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
  physics.ragdoll.build(humanoid.bones, 1.7, 0);
  const states = [];
  physics.ragdoll.onStateChange = (s) => states.push(s);
  physics.ragdoll.onNeedsReset = () => states.push("reset-requested");

  const frame = (dt = 1 / 72) => {
    for (const [bone, r] of rest) {
      bone.quaternion.copy(r.q);
      bone.position.copy(r.p);
    }
    rig.root.updateMatrixWorld(true);
    physics.ragdoll.captureTargets();
    physics.step(dt);
    physics.ragdoll.writeBones();
  };
  const run = (seconds, onFrame) => {
    const stats = { maxTilt: 0, minPelvis: Infinity, maxDrift: 0 };
    const start = physics.ragdoll.byId.get("pelvis").body.position.clone();
    for (let t = 0; t < seconds; t += 1 / 72) {
      frame();
      onFrame?.(t);
      stats.maxTilt = Math.max(stats.maxTilt, physics.ragdoll.torsoTilt() * DEG);
      stats.minPelvis = Math.min(stats.minPelvis, physics.ragdoll.pelvisHeight());
      const p = physics.ragdoll.byId.get("pelvis").body.position;
      stats.maxDrift = Math.max(stats.maxDrift, Math.hypot(p.x - start.x, p.z - start.z));
    }
    return stats;
  };
  const pushTorso = (impulse) => {
    const torso = physics.ragdoll.byId.get("torso").body;
    physics.ragdoll.pushAt(torso.position.clone(), impulse, torso);
  };
  return { rig, humanoid, physics, ragdoll: physics.ragdoll, run, pushTorso, states };
}

test("figure stands still and upright under its own muscles", () => {
  const { ragdoll, run } = setup();
  const stand = ragdoll.standPelvisHeight;
  const settle = run(1);
  assert.ok(settle.maxDrift < 0.05, `settling moved ${settle.maxDrift.toFixed(3)} m`);
  const stats = run(6);
  assert.equal(ragdoll.state, "standing");
  assert.ok(stats.maxTilt < 6, `tilt ${stats.maxTilt.toFixed(1)}°`);
  assert.ok(stats.minPelvis > 0.93 * stand, `pelvis sank to ${stats.minPelvis.toFixed(3)} of ${stand.toFixed(3)}`);
  assert.ok(stats.maxDrift < 0.01, `drifted ${stats.maxDrift.toFixed(3)} m while standing`);
});

test("medium shove: sways, does not fall, recovers upright", () => {
  const { ragdoll, run, pushTorso, states } = setup();
  run(1);
  pushTorso(new CANNON.Vec3(0, 0, 45));
  const stats = run(5);
  assert.ok(!states.includes("fallen"), `states: ${states}`);
  assert.equal(ragdoll.state, "standing");
  assert.ok(stats.maxTilt > 2, `expected visible sway, got ${stats.maxTilt.toFixed(1)}°`);
  assert.ok(ragdoll.torsoTilt() * DEG < 8, `final tilt ${(ragdoll.torsoTilt() * DEG).toFixed(1)}°`);
});

test("stronger shove triggers a recovery step instead of a fall", () => {
  const { ragdoll, run, pushTorso, states } = setup();
  run(1);
  const before = ["left", "right"].map((s) => ragdoll.byId.get(`${s}Foot`).body.position.clone());
  let stepped = false;
  pushTorso(new CANNON.Vec3(0, 0, 85));
  run(5, () => { if (ragdoll.step) stepped = true; });
  const after = ["left", "right"].map((s) => ragdoll.byId.get(`${s}Foot`).body.position);
  const moved = Math.max(...after.map((p, i) => Math.hypot(p.x - before[i].x, p.z - before[i].z)));
  assert.ok(stepped, "no step was taken");
  assert.ok(moved > 0.05, `feet moved only ${moved.toFixed(3)} m`);
  assert.ok(!states.includes("fallen"), `states: ${states}`);
  assert.equal(ragdoll.state, "standing");
});

test("very strong shove: falls, then gets back up", () => {
  const { ragdoll, run, pushTorso, states } = setup();
  run(0.5);
  pushTorso(new CANNON.Vec3(0, 0, 400));
  run(2.5);
  assert.ok(states.includes("fallen"), `states: ${states}`);
  run(9);
  assert.ok(states.includes("gettingUp"), `states: ${states}`);
  assert.equal(ragdoll.state, "standing", `states: ${states}`);
  assert.ok(ragdoll.pelvisHeight() > 0.85 * ragdoll.standPelvisHeight);
});

test("joint limits: knees never hyperextend or over-flex", () => {
  const { ragdoll, run, pushTorso } = setup();
  let worst = 0;
  pushTorso(new CANNON.Vec3(30, 0, -400));
  run(4, () => {
    for (const joint of ragdoll.joints) {
      if (joint.spec.joint !== "knee") continue;
      const axis = joint.A.quaternion.vmult(joint.hingeAxisA);
      const a = joint.A.quaternion.vmult(joint.parent.axisLocal);
      const b = joint.B.quaternion.vmult(joint.child.axisLocal);
      const flex = joint.sign * Math.atan2(a.cross(b).dot(axis), a.dot(b));
      worst = Math.min(worst, flex);
    }
  });
  assert.ok(worst * DEG > -12, `knee hyperextended by ${(-worst * DEG).toFixed(1)}°`);
});

test("bones follow the simulated bodies", () => {
  const { ragdoll, run, pushTorso } = setup();
  pushTorso(new CANNON.Vec3(0, 0, 60));
  run(0.5);
  const q = new THREE.Quaternion();
  for (const seg of ragdoll.segments) {
    seg.bone.getWorldQuaternion(q);
    const b = seg.body.quaternion;
    const dot = Math.abs(q.x * b.x + q.y * b.y + q.z * b.z + q.w * b.w);
    assert.ok(dot > 0.999, `${seg.id} bone/body mismatch (${dot})`);
  }
});
