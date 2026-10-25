import * as CANNON from "cannon-es";
import { ActiveRagdoll, COLLISION } from "./active-ragdoll.js";

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 4;
const MAX_HAND_SPEED = 3.5;

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

  /** Kinematic sphere that follows a hand joint or controller; its velocity makes contacts push correctly. */
  setKinematicSphere(id, position, radius, dt) {
    let entry = this.kinematic.get(id);
    if (!entry) {
      const body = new CANNON.Body({ type: CANNON.Body.KINEMATIC, mass: 0, material: this.handMaterial });
      body.addShape(new CANNON.Sphere(radius));
      body.collisionFilterGroup = COLLISION.HAND;
      body.collisionFilterMask = COLLISION.BODY;
      body.position.set(position.x, position.y, position.z);
      this.world.addBody(body);
      entry = { body, active: true };
      this.kinematic.set(id, entry);
    }
    const { body } = entry;
    if (!entry.active) {
      this.world.addBody(body);
      entry.active = true;
      body.position.set(position.x, position.y, position.z);
    }
    const dx = position.x - body.position.x;
    const dy = position.y - body.position.y;
    const dz = position.z - body.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dt <= 0 || dist > 0.5) {
      body.position.set(position.x, position.y, position.z);
      body.velocity.setZero();
      return;
    }
    const speed = dist / dt;
    const k = speed > MAX_HAND_SPEED ? MAX_HAND_SPEED / speed : 1;
    body.velocity.set((dx / dt) * k, (dy / dt) * k, (dz / dt) * k);
    if (k < 1) body.position.set(position.x - dx * k, position.y - dy * k, position.z - dz * k);
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
      this.world.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    for (const entry of this.kinematic.values()) entry.body.velocity.setZero();
    return steps;
  }
}
