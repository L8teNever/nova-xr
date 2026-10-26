import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mapHumanoid } from "../js/humanoid-map.js";
import { PhysicsWorld } from "../js/physics-world.js";

const GLB = new URL("../assets/models/character.glb", import.meta.url);

async function loadCharacter() {
  const data = readFileSync(GLB);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const loader = new GLTFLoader();
  // No DOM in Node: skip textures, geometry and skeleton are what matter here.
  loader.register((parser) => ({ name: "no-textures", loadTexture: () => Promise.resolve(null) }));
  return loader.parseAsync(buffer, "");
}

test("bundled character maps to a physics-ready humanoid and stands", async () => {
  const gltf = await loadCharacter();
  const bones = [];
  gltf.scene.traverse((o) => o.isBone && bones.push(o));
  const humanoid = mapHumanoid(bones);
  assert.ok(humanoid.physicsReady, `missing ${humanoid.missing}`);
  for (const key of ["hips", "spine", "chest", "neck", "head", "leftUpperArm", "rightLowerLeg", "leftToes"]) {
    assert.ok(humanoid.bones[key], `${key} not mapped`);
  }
  assert.match(humanoid.bones.leftUpperLeg.name, /LeftUpLeg/);

  const root = new THREE.Group();
  root.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene, true);
  const height = box.max.y - box.min.y;
  assert.ok(height > 1.2 && height < 2.3, `height ${height}`);
  gltf.scene.position.y -= box.min.y;

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const idle = gltf.animations.find((c) => /idle/i.test(c.name));
  assert.ok(idle, "Idle clip missing");
  mixer.clipAction(idle).play();
  mixer.update(0);
  root.updateMatrixWorld(true);

  const physics = new PhysicsWorld();
  physics.enabled = true;
  physics.ragdoll.build(humanoid.bones, height, 0);
  const states = [];
  physics.ragdoll.onStateChange = (s) => states.push(s);
  const rest = new Map(bones.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]));
  const run = (seconds) => {
    for (let i = 0; i < 72 * seconds; i += 1) {
      for (const [b, r] of rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
      mixer.update(1 / 72);
      root.updateMatrixWorld(true);
      physics.ragdoll.captureTargets();
      physics.step(1 / 72);
      physics.ragdoll.writeBones();
    }
  };
  const upright = () => {
    assert.equal(physics.ragdoll.state, "standing", `states: ${states}`);
    assert.ok(physics.ragdoll.torsoTilt() < (10 * Math.PI) / 180, `tilt ${physics.ragdoll.torsoTilt()}`);
    assert.ok(physics.ragdoll.pelvisHeight() > 0.88 * physics.ragdoll.standPelvisHeight);
  };
  run(5);
  assert.deepEqual(states, [], `states: ${states}`);
  upright();

  const torso = physics.ragdoll.byId.get("torso").body;
  physics.ragdoll.pushAt(torso.position.clone(), new CANNON.Vec3(0, 0, 60), torso);
  run(5);
  assert.ok(!states.includes("fallen"), `states: ${states}`);
  upright();

  physics.ragdoll.pushAt(torso.position.clone(), new CANNON.Vec3(0, 0, -450), torso);
  run(3);
  assert.ok(states.includes("fallen"), `states: ${states}`);
  run(9);
  upright();

  // Hold her right hand and lift it above her head, then let go.
  const ragdoll = physics.ragdoll;
  const pelvis = ragdoll.byId.get("pelvis").body;
  const relHand = () => pelvis.pointToLocalFrame(ragdoll.handPosition("right"));
  const idleRel = relHand();
  const start = ragdoll.handPosition("right").clone();
  assert.ok(ragdoll.grab("right", start));
  const g = ragdoll.grabs.right;
  const shoulder = ragdoll.byId.get("torso").body.pointToWorldFrame(g.shoulderLocal);
  const top = shoulder.vadd(new CANNON.Vec3(0, g.reach * 0.8, g.reach * 0.3));
  for (let i = 1; i <= 108; i += 1) {
    ragdoll.setGrabTarget("right", start.vadd(top.vsub(start).scale(Math.min(1, i / 72))), 1 / 72);
    run(1 / 72);
  }
  assert.ok(ragdoll.isHeld("right"));
  assert.ok(ragdoll.handPosition("right").distanceTo(top) < 0.15, `held hand ${ragdoll.handPosition("right").distanceTo(top)} m from target`);
  upright();
  ragdoll.release("right");
  run(3);
  assert.ok(relHand().distanceTo(idleRel) < 0.12, `released hand ${relHand().distanceTo(idleRel)} m from idle`);
  upright();
});
