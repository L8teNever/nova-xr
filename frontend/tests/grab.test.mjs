import assert from "node:assert/strict";
import test from "node:test";
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { mapHumanoid } from "../js/humanoid-map.js";
import { PhysicsWorld } from "../js/physics-world.js";
import { buildTestRig } from "./rig-fixture.mjs";

const FRAME = 1 / 72;

function setup({ scale = 1 } = {}) {
  const rig = buildTestRig();
  rig.root.scale.setScalar(scale);
  rig.root.updateMatrixWorld(true);
  const humanoid = mapHumanoid(rig.list);
  const physics = new PhysicsWorld();
  physics.enabled = true;
  const rest = new Map(rig.list.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
  const ragdoll = physics.ragdoll;
  ragdoll.build(humanoid.bones, 1.7 * scale, 0);
  const events = [];
  ragdoll.onStateChange = (s) => events.push(s);
  ragdoll.onGrabRelease = (side, reason) => events.push(`release:${side}:${reason}`);
  const frame = () => {
    for (const [bone, r] of rest) {
      bone.quaternion.copy(r.q);
      bone.position.copy(r.p);
    }
    rig.root.updateMatrixWorld(true);
    ragdoll.captureTargets();
    physics.step(FRAME);
    ragdoll.writeBones();
  };
  const run = (seconds, onFrame) => {
    for (let t = 0; t < seconds; t += FRAME) {
      onFrame?.(t);
      frame();
    }
  };
  const hand = (side) => ragdoll.handPosition(side).clone();
  return { rig, humanoid, physics, ragdoll, run, hand, events };
}

/** Move a held hand's target along a straight line over `seconds`, like a user's hand would. */
function guide(env, side, from, to, seconds) {
  env.run(seconds, (t) => {
    const k = Math.min(1, t / seconds);
    const p = new CANNON.Vec3(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k);
    env.ragdoll.setGrabTarget(side, p, FRAME);
  });
}

test("held hand follows the user's hand upwards and the arm (incl. shoulder) lifts", () => {
  const env = setup();
  const { ragdoll, run, hand, events, humanoid } = env;
  run(1);
  const start = hand("left");
  const clavicleBefore = humanoid.bones.leftShoulder.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(ragdoll.grab("left", start));
  const top = start.vadd(new CANNON.Vec3(0, 0.95, 0.2));
  guide(env, "left", start, top, 1.5);
  run(1, () => ragdoll.setGrabTarget("left", top, FRAME));
  const now = hand("left");
  assert.ok(ragdoll.isHeld("left"), `released: ${events}`);
  assert.ok(now.y - start.y > 0.75, `hand rose only ${(now.y - start.y).toFixed(2)} m`);
  assert.ok(now.distanceTo(top) < 0.15, `hand ${now.distanceTo(top).toFixed(2)} m from target`);
  const upper = ragdoll.byId.get("leftUpperArm");
  const dir = upper.body.quaternion.vmult(upper.axisLocal);
  assert.ok(dir.y > 0, `upper arm still points down (${dir.y.toFixed(2)})`);
  const clavicleAfter = humanoid.bones.leftShoulder.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(clavicleBefore.angleTo(clavicleAfter) > 0.1, "clavicle did not lift with the arm");
  assert.equal(ragdoll.state, "standing", `${events}`);
  assert.ok(!ragdoll.isHeld("right"));
});

test("release: arm returns smoothly to the idle pose", () => {
  const env = setup();
  const { ragdoll, run, hand } = env;
  run(1);
  const rest = hand("right");
  ragdoll.grab("right", rest);
  const side = rest.vadd(new CANNON.Vec3(-0.3, 0.5, 0.25));
  guide(env, "right", rest, side, 1.2);
  run(0.5, () => ragdoll.setGrabTarget("right", side, FRAME));
  ragdoll.release("right");
  const lower = ragdoll.byId.get("rightLowerArm").body;
  let peak = 0;
  run(0.25, () => { peak = Math.max(peak, lower.angularVelocity.length()); });
  assert.ok(peak < 6, `arm snapped back at ${peak.toFixed(1)} rad/s`);
  run(2.5);
  assert.ok(hand("right").distanceTo(rest) < 0.1, `hand ${hand("right").distanceTo(rest).toFixed(2)} m from idle`);
  assert.equal(ragdoll.state, "standing");
});

test("yanking far away breaks the grip; balance stays active", () => {
  const env = setup();
  const { ragdoll, run, hand, events } = env;
  run(1);
  const start = hand("left");
  ragdoll.grab("left", start);
  const far = start.vadd(new CANNON.Vec3(1.4, 0.2, 0));
  run(1.2, () => ragdoll.setGrabTarget("left", far, FRAME));
  assert.ok(!ragdoll.isHeld("left"), "grip did not break");
  assert.ok(events.some((e) => e.startsWith("release:left:")), `${events}`);
  run(3);
  assert.equal(ragdoll.state, "standing", `${events}`);
});

test("leading her by the hand makes her step after it", () => {
  const env = setup();
  const { ragdoll, run, hand, events } = env;
  run(1);
  const pelvis = ragdoll.byId.get("pelvis").body;
  const startPelvis = pelvis.position.clone();
  const start = hand("right");
  ragdoll.grab("right", start);
  let stepped = false;
  const ahead = start.vadd(new CANNON.Vec3(0, 0.25, 0.9));
  env.run(3, (t) => {
    const k = Math.min(1, t / 3);
    ragdoll.setGrabTarget("right", start.vadd(ahead.vsub(start).scale(k)), FRAME);
    if (ragdoll.step) stepped = true;
  });
  run(1, () => ragdoll.setGrabTarget("right", ahead, FRAME));
  const moved = Math.hypot(pelvis.position.x - startPelvis.x, pelvis.position.z - startPelvis.z);
  assert.ok(stepped, "no step taken");
  assert.ok(moved > 0.2, `pelvis moved only ${moved.toFixed(2)} m`);
  assert.ok(!events.includes("fallen"), `${events}`);
  assert.equal(ragdoll.state, "standing");
});

test("both hands can be held independently", () => {
  const env = setup();
  const { ragdoll, run, hand } = env;
  run(1);
  const l0 = hand("left");
  const r0 = hand("right");
  ragdoll.grab("left", l0);
  ragdoll.grab("right", r0);
  const lT = l0.vadd(new CANNON.Vec3(0.1, 0.6, 0.2));
  const rT = r0.vadd(new CANNON.Vec3(0, 0.15, 0.35));
  env.run(1.5, (t) => {
    const k = Math.min(1, t / 1.2);
    ragdoll.setGrabTarget("left", l0.vadd(lT.vsub(l0).scale(k)), FRAME);
    ragdoll.setGrabTarget("right", r0.vadd(rT.vsub(r0).scale(k)), FRAME);
  });
  assert.ok(ragdoll.isHeld("left") && ragdoll.isHeld("right"));
  assert.ok(hand("left").distanceTo(lT) < 0.15, `left ${hand("left").distanceTo(lT).toFixed(2)}`);
  assert.ok(hand("right").distanceTo(rT) < 0.15, `right ${hand("right").distanceTo(rT).toFixed(2)}`);
  assert.ok(hand("left").y - hand("right").y > 0.25, "hands did not move independently");
});

test("grip is dropped when she falls, and cannot start while fallen", () => {
  const env = setup();
  const { ragdoll, run, hand, events } = env;
  run(0.5);
  ragdoll.grab("left", hand("left"));
  const torso = ragdoll.byId.get("torso").body;
  ragdoll.pushAt(torso.position.clone(), new CANNON.Vec3(0, 0, 450), torso);
  run(1.5, () => ragdoll.isHeld("left") && ragdoll.setGrabTarget("left", hand("left"), FRAME));
  assert.ok(events.includes("fallen"), `${events}`);
  assert.ok(!ragdoll.isHeld("left"));
  assert.equal(ragdoll.grab("left", hand("left")), false);
});

test("muscle strength setting: stronger stays upright, very weak collapses", () => {
  const strong = setup();
  strong.ragdoll.strength = 2;
  strong.run(4);
  assert.equal(strong.ragdoll.state, "standing");
  assert.ok(strong.ragdoll.torsoTilt() < 0.1);

  const weak = setup();
  weak.ragdoll.strength = 0.2;
  weak.run(4);
  assert.ok(weak.events.includes("fallen"), `weak figure kept standing: ${weak.events}`);
});

for (const scale of [0.6, 1.3]) {
  test(`scaled figure (${scale}x) stands and can be grabbed`, () => {
    const env = setup({ scale });
    const { ragdoll, run, hand } = env;
    run(2);
    assert.equal(ragdoll.state, "standing");
    const start = hand("left");
    assert.ok(ragdoll.grab("left", start));
    const up = start.vadd(new CANNON.Vec3(0, 0.4 * scale, 0.1 * scale));
    guide(env, "left", start, up, 1);
    run(0.5, () => ragdoll.setGrabTarget("left", up, FRAME));
    assert.ok(hand("left").distanceTo(up) < 0.12 * scale, `${hand("left").distanceTo(up).toFixed(2)}`);
    assert.equal(ragdoll.state, "standing");
  });
}
