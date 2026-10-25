import * as CANNON from "cannon-es";
import * as THREE from "three";

const BONE_MAP = [
  { keys: ["Hips"], size: [0.28, 0.16, 0.18], mass: 8 },
  { keys: ["Spine2", "Spine1", "Spine"], size: [0.26, 0.28, 0.16], mass: 10 },
  { keys: ["Head"], size: [0.16, 0.18, 0.16], mass: 4 },
  { keys: ["LeftArm"], size: [0.08, 0.28, 0.08], mass: 2 },
  { keys: ["LeftForeArm"], size: [0.07, 0.26, 0.07], mass: 1.5 },
  { keys: ["RightArm"], size: [0.08, 0.28, 0.08], mass: 2 },
  { keys: ["RightForeArm"], size: [0.07, 0.26, 0.07], mass: 1.5 },
  { keys: ["LeftUpLeg"], size: [0.1, 0.36, 0.1], mass: 5 },
  { keys: ["LeftLeg"], size: [0.09, 0.34, 0.09], mass: 3.5 },
  { keys: ["RightUpLeg"], size: [0.1, 0.36, 0.1], mass: 5 },
  { keys: ["RightLeg"], size: [0.09, 0.34, 0.09], mass: 3.5 },
];

const JOINTS = [
  ["Hips", "Spine2"],
  ["Spine2", "Head"],
  ["Spine2", "LeftArm"],
  ["LeftArm", "LeftForeArm"],
  ["Spine2", "RightArm"],
  ["RightArm", "RightForeArm"],
  ["Hips", "LeftUpLeg"],
  ["LeftUpLeg", "LeftLeg"],
  ["Hips", "RightUpLeg"],
  ["RightUpLeg", "RightLeg"],
];

export class PhysicsWorld {
  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.broadphase = new CANNON.NaiveBroadphase();
    this.world.solver.iterations = 12;
    this.bodies = [];
    this.boneBodies = new Map();
    this.roomBodies = [];
    this.handBodies = new Map();
    this.controllerBodies = new Map();
    this.springs = [];
    this.enabled = false;
    this.ground = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
    });
    this.ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(this.ground);
  }

  setEnabled(on) {
    this.enabled = on;
    for (const body of this.bodies) {
      body.type = on ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC;
      body.velocity.setZero();
      body.angularVelocity.setZero();
    }
  }

  clearRoom() {
    for (const body of this.roomBodies) this.world.removeBody(body);
    this.roomBodies.length = 0;
  }

  addStaticBox(center, size, quaternion) {
    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)),
    });
    body.position.set(center.x, center.y, center.z);
    if (quaternion) {
      body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    }
    this.world.addBody(body);
    this.roomBodies.push(body);
    return body;
  }

  addStaticPlane(origin, normal) {
    const body = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    body.position.set(origin.x, origin.y, origin.z);
    const up = new THREE.Vector3(0, 0, 1);
    const n = normal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, n);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    this.world.addBody(body);
    this.roomBodies.push(body);
    return body;
  }

  bindCharacter(character) {
    this.character = character;
    this.bodies = [];
    this.boneBodies.clear();

    for (const spec of BONE_MAP) {
      const bone = character.findBone(...spec.keys);
      if (!bone) continue;
      const body = new CANNON.Body({
        mass: spec.mass,
        shape: new CANNON.Box(new CANNON.Vec3(spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2)),
        linearDamping: 0.35,
        angularDamping: 0.55,
      });
      body.type = CANNON.Body.KINEMATIC;
      this.world.addBody(body);
      this.bodies.push(body);
      this.boneBodies.set(spec.keys[0], { body, bone, size: spec.size });
    }

    const get = (key) => this.boneBodies.get(key);
    for (const [a, b] of JOINTS) {
      const left = get(a);
      const right = get(b);
      if (!left || !right) continue;
      const constraint = new CANNON.ConeTwistConstraint(left.body, right.body, {
        pivotA: new CANNON.Vec3(0, left.size[1] / 2, 0),
        pivotB: new CANNON.Vec3(0, -right.size[1] / 2, 0),
        angle: Math.PI / 4,
        twistAngle: Math.PI / 8,
      });
      this.world.addConstraint(constraint);
    }

    // Keine Haar-/Kleidungs-Spring-Bones: das Grab3D-Rig hat dafür keine Joints,
    // und das einzige Mesh isoliert Haar/Blazer nicht zuverlässig.
    this.springs = [];
    this.syncFromBones();
  }

  syncFromBones() {
    if (!this.character) return;
    this.character.model.updateMatrixWorld(true);
    for (const { body, bone } of this.boneBodies.values()) {
      const world = new THREE.Vector3();
      bone.getWorldPosition(world);
      const quat = new THREE.Quaternion();
      bone.getWorldQuaternion(quat);
      body.position.set(world.x, world.y, world.z);
      body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
      body.velocity.setZero();
      body.angularVelocity.setZero();
    }
  }

  applyToBones() {
    if (!this.character) return;
    const inv = new THREE.Matrix4().copy(this.character.root.matrixWorld).invert();
    for (const { body, bone } of this.boneBodies.values()) {
      const pos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
      const quat = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      pos.applyMatrix4(inv);
      const parent = bone.parent;
      if (parent) {
        const parentInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
        const localPos = pos.clone().applyMatrix4(parentInv.multiply(this.character.root.matrixWorld));
        bone.position.lerp(localPos, 0.65);
        const parentWorldQ = new THREE.Quaternion();
        parent.getWorldQuaternion(parentWorldQ);
        const localQ = parentWorldQ.invert().multiply(quat);
        bone.quaternion.slerp(localQ, 0.65);
      }
    }
  }

  updateHandCollider(id, position) {
    let body = this.handBodies.get(id);
    if (!body) {
      body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Sphere(0.035),
      });
      this.world.addBody(body);
      this.handBodies.set(id, body);
    }
    body.position.set(position.x, position.y, position.z);
  }

  updateController(id, position, quaternion) {
    let body = this.controllerBodies.get(id);
    if (!body) {
      body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Cylinder(0.03, 0.03, 0.12, 8),
      });
      this.world.addBody(body);
      this.controllerBodies.set(id, body);
    }
    body.position.set(position.x, position.y, position.z);
    body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  shoveNearest(point, impulse) {
    let best = null;
    let bestDist = 0.45;
    for (const { body } of this.boneBodies.values()) {
      const dx = body.position.x - point.x;
      const dy = body.position.y - point.y;
      const dz = body.position.z - point.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < bestDist) {
        best = body;
        bestDist = d;
      }
    }
    if (best) {
      best.applyImpulse(new CANNON.Vec3(impulse.x, impulse.y, impulse.z), best.position);
    }
  }

  step(delta) {
    if (!this.enabled) return;
    this.world.step(1 / 60, Math.min(delta, 0.05), 4);
    this.applyToBones();
  }
}
