import * as CANNON from "cannon-es";
import { ActiveRagdoll, COLLISION } from "./active-ragdoll.js";

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 4;
const MAX_HAND_SPEED = 3.5;
// A hand is a light body that chases the real hand with a limited force: a gentle touch only nudges the figure
// (like touching a person), a fast swing carries more momentum and force and can really shove it.
const HAND_MASS = 3;
const HAND_FORCE_MIN = 30;
const HAND_FORCE_MAX = 220;
const HAND_FORCE_SPEED = 2.2;

export class PhysicsWorld {
  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 14;
    this.world.allowSleep = false;

    this.groundMaterial = new CANNON.Material("ground");
    this.bodyMaterial = new CANNON.Material("body");
    this.handMaterial = new CANNON.Material("hand");
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.groundMaterial, this.bodyMaterial, { friction: 0.9, restitution: 0.02 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.handMaterial, this.bodyMaterial, { friction: 0.35, restitution: 0.05 }));

    this.ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: this.groundMaterial });
    this.ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.ground.collisionFilterGroup = COLLISION.ENV;
    this.world.addBody(this.ground);

    this.ragdoll = new ActiveRagdoll(this.world, { bodyMaterial: this.bodyMaterial });
    this.roomBodies = new Map();
    this.kinematic = new Map();
    this.accumulator = 0;
    this.enabled = false;
  }

  get groundY() {
    return this.ground.position.y;
  }

  setGroundY(y) {
    this.ground.position.y = y;
    this.ragdoll.groundY = y;
  }

  /** Static room collider keyed by an XR object (plane/mesh); rebuilt only when its data changes. */
  syncRoomCollider(key, version, build) {
    const existing = this.roomBodies.get(key);
    if (existing && existing.version === version) {
      existing.seen = true;
      return;
    }
    if (existing) this.world.removeBody(existing.body);
    const spec = build();
    if (!spec) {
      this.roomBodies.delete(key);
      return;
    }
    const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: this.groundMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(spec.half.x, spec.half.y, spec.half.z)));
    body.position.set(spec.center.x, spec.center.y, spec.center.z);
    body.quaternion.set(spec.quaternion.x, spec.quaternion.y, spec.quaternion.z, spec.quaternion.w);
    body.collisionFilterGroup = COLLISION.ENV;
    this.world.addBody(body);
    this.roomBodies.set(key, { body, version, seen: true });
  }

  beginRoomSync() {
    for (const entry of this.roomBodies.values()) entry.seen = false;
  }

  endRoomSync() {
    for (const [key, entry] of this.roomBodies) {
      if (entry.seen) continue;
      this.world.removeBody(entry.body);
      this.roomBodies.delete(key);
    }
  }

  get roomColliderCount() {
    return this.roomBodies.size;
  }

  /** Force-limited sphere that follows a hand joint or controller (see HAND_FORCE_*). */
  setKinematicSphere(id, position, radius, dt) {
    let entry = this.kinematic.get(id);
    if (!entry) {
      const body = new CANNON.Body({ mass: HAND_MASS, material: this.handMaterial, linearDamping: 0.05 });
      body.fixedRotation = true;
      body.updateMassProperties();
      body.addShape(new CANNON.Sphere(radius));
      body.collisionFilterGroup = COLLISION.HAND;
      body.collisionFilterMask = COLLISION.BODY;
      body.position.set(position.x, position.y, position.z);
      this.world.addBody(body);
      entry = { body, active: true, target: new CANNON.Vec3(position.x, position.y, position.z), speed: 0 };
      this.kinematic.set(id, entry);
    }
    const { body } = entry;
    if (!entry.active) {
      this.world.addBody(body);
      entry.active = true;
      entry.speed = 0;
      body.position.set(position.x, position.y, position.z);
      body.velocity.setZero();
      entry.target.set(position.x, position.y, position.z);
    }
    // speed of the real hand: a fast swing is allowed more force than a slow touch
    if (dt > 0) {
      const moved = Math.hypot(position.x - entry.target.x, position.y - entry.target.y, position.z - entry.target.z);
      entry.speed += (Math.min(MAX_HAND_SPEED, moved / dt) - entry.speed) * Math.min(1, dt * 12);
    }
    entry.target.set(position.x, position.y, position.z);
    if (dt <= 0 || entry.target.distanceTo(body.position) > 0.6) {
      body.position.copy(entry.target);
      body.velocity.setZero();
    }
  }

  /** Per physics substep: pull each hand body towards its target with a bounded force. */
  _driveHands(h) {
    for (const entry of this.kinematic.values()) {
      if (!entry.active) continue;
      const { body, target } = entry;
      let wx = (target.x - body.position.x) / 0.04;
      let wy = (target.y - body.position.y) / 0.04;
      let wz = (target.z - body.position.z) / 0.04;
      const speed = Math.hypot(wx, wy, wz);
      if (speed > MAX_HAND_SPEED) {
        const k = MAX_HAND_SPEED / speed;
        wx *= k;
        wy *= k;
        wz *= k;
      }
      let fx = ((wx - body.velocity.x) * HAND_MASS) / h;
      let fy = ((wy - body.velocity.y) * HAND_MASS) / h;
      let fz = ((wz - body.velocity.z) * HAND_MASS) / h;
      const limit = HAND_FORCE_MIN + (HAND_FORCE_MAX - HAND_FORCE_MIN) * Math.min(1, entry.speed / HAND_FORCE_SPEED);
      const len = Math.hypot(fx, fy, fz);
      if (len > limit) {
        const k = limit / len;
        fx *= k;
        fy *= k;
        fz *= k;
      }
      body.force.set(fx, fy - this.world.gravity.y * HAND_MASS, fz);
    }
  }

  hideKinematic(id) {
    const entry = this.kinematic.get(id);
    if (entry?.active) {
      this.world.removeBody(entry.body);
      entry.active = false;
    }
  }

  /** Closest ragdoll segment hit by a ray, or null. */
  raycastBody(from, to) {
    const result = new CANNON.RaycastResult();
    const hit = this.world.raycastClosest(
      new CANNON.Vec3(from.x, from.y, from.z),
      new CANNON.Vec3(to.x, to.y, to.z),
      { collisionFilterMask: COLLISION.BODY, skipBackfaces: true },
      result,
    );
    return hit ? { body: result.body, point: result.hitPointWorld.clone(), distance: result.distance } : null;
  }

  step(delta) {
    if (!this.enabled) {
      this.accumulator = 0;
      return 0;
    }
    this.accumulator += Math.min(delta, MAX_SUBSTEPS * FIXED_DT);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.ragdoll.preStep(FIXED_DT);
      this._driveHands(FIXED_DT);
      this.world.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    return steps;
  }
}
