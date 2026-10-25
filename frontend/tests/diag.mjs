// Dev helper: node frontend/tests/diag.mjs <impulse> [x] — prints the balance time series after a shove.
import * as CANNON from "cannon-es";
import { mapHumanoid } from "../js/humanoid-map.js";
import { PhysicsWorld } from "../js/physics-world.js";
import { buildTestRig } from "./rig-fixture.mjs";

const impulse = Number(process.argv[2] || 60);
const lateral = Number(process.argv[3] || 0);
const rig = buildTestRig();
const h = mapHumanoid(rig.list);
const physics = new PhysicsWorld();
physics.enabled = true;
const rest = new Map(rig.list.map((b) => [b, b.quaternion.clone()]));
const rd = physics.ragdoll;
rd.build(h.bones, 1.7, 0);
rd.onStateChange = (s) => console.log(`  -> ${s}`);
const frame = () => {
  for (const [b, q] of rest) b.quaternion.copy(q);
  rig.root.updateMatrixWorld(true);
  rd.captureTargets();
  physics.step(1 / 72);
  rd.writeBones();
};
let stepping = null;
for (let i = 0; i < 72 * 7; i += 1) {
  if (i === 72) {
    const torso = rd.byId.get("torso").body;
    rd.pushAt(torso.position.clone(), new CANNON.Vec3(lateral, 0, impulse), torso);
  }
  frame();
  if (rd.step && rd.step !== stepping) console.log(`  step ${rd.step.side} t=${(i / 72).toFixed(2)}`);
  stepping = rd.step;
  if (i % 9 === 0) {
    const com = new CANNON.Vec3();
    const vel = new CANNON.Vec3();
    rd.centerOfMass(com, vel);
    const p = rd.byId.get("pelvis").body.position;
    console.log(
      `${(i / 72).toFixed(2)} ${rd.state.padEnd(9)} tilt=${((rd.torsoTilt() * 180) / Math.PI).toFixed(1).padStart(5)} ` +
        `pelvisY=${p.y.toFixed(3)} z=${p.z.toFixed(3)} comV=${vel.z.toFixed(2)} tone=${rd.tone.toFixed(2)}`,
    );
  }
}
