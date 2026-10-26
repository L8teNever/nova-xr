// Active ragdoll: rigid segments joined by limited joints, driven by bounded "muscle" motors that track the
// animated target pose, plus a balance layer (upright assist, centre-of-mass assist, capture-point stepping,
// fall detection and get-up). Motors are solver equations with a velocity target and a force bound, so the
// figure yields to strong contacts instead of fighting them with unbounded stiffness.
import * as CANNON from "cannon-es";
import * as THREE from "three";

export const COLLISION = { ENV: 1, BODY: 2, HAND: 4 };

const DEG = Math.PI / 180;
const UP = new CANNON.Vec3(0, 1, 0);
const AXES = [new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, 0, 1)];

export const DEFAULT_PARAMS = {
  totalMass: 62,
  responseTime: 0.09,
  maxJointSpeed: 14,
  uprightStrength: 90,
  uprightResponse: 0.15,
  comAssist: 0.05,
  stepThreshold: 0.035,
  stepTime: 0.26,
  stepHeight: 0.07,
  maxStepLength: 0.36,
  maxStepsInRow: 5,
  fallTilt: 58 * DEG,
  fallSpeed: 2.6,
  fallenTone: 0.16,
  settleTime: 1.2,
  getUpTime: 2.2,
  grabForce: 150,
  grabResponse: 0.1,
  grabMaxSpeed: 4,
  grabArmTone: 0.45,
  grabIkBlendTime: 0.25,
  grabStretch: 0.3,
  grabStretchTime: 0.5,
  grabBreak: 0.65,
  grabRecoverTime: 0.9,
  shoulderLift: 18 * DEG,
};

// strength in N·m for a 62 kg / 1.7 m figure; scaled to the actual model.
const JOINTS = {
  spine: { strength: 280, swing: 40 * DEG, twist: 35 * DEG },
  neck: { strength: 50, swing: 50 * DEG, twist: 70 * DEG },
  shoulder: { strength: 60, swing: 145 * DEG, twist: 70 * DEG, swingTwistLimit: true },
  elbow: { strength: 45, hinge: [0, 145 * DEG] },
  hip: { strength: 300, swing: 80 * DEG, twist: 35 * DEG },
  knee: { strength: 260, hinge: [0, 150 * DEG] },
  ankle: { strength: 170, swing: 35 * DEG, twist: 15 * DEG },
};

const MASS = { pelvis: 0.14, torso: 0.3, head: 0.08, upperArm: 0.028, lowerArm: 0.022, upperLeg: 0.1, lowerLeg: 0.045, foot: 0.015 };

class LinearMotorEquation extends CANNON.Equation {
  constructor(body, anchor) {
    super(body, anchor, -1, 1);
    this.axis = new CANNON.Vec3();
    this.targetVelocity = 0;
  }

  computeB(h) {
    const GA = this.jacobianElementA;
    const GB = this.jacobianElementB;
    GA.spatial.copy(this.axis);
    GA.rotational.set(0, 0, 0);
    this.axis.negate(GB.spatial);
    GB.rotational.set(0, 0, 0);
    const GW = this.computeGW() - this.targetVelocity;
    return -GW * this.b - h * this.computeGiMf();
  }
}

/** Velocity drive of one body point (offset ri, world frame) along a world axis, relative to a static anchor. */
class PointMotorEquation extends CANNON.Equation {
  constructor(body, anchor) {
    super(body, anchor, -1, 1);
    this.axis = new CANNON.Vec3();
    this.ri = new CANNON.Vec3();
    this.targetVelocity = 0;
  }

  computeB(h) {
    const GA = this.jacobianElementA;
    const GB = this.jacobianElementB;
    GA.spatial.copy(this.axis);
    this.ri.cross(this.axis, GA.rotational);
    this.axis.negate(GB.spatial);
    GB.rotational.set(0, 0, 0);
    const GW = this.computeGW() - this.targetVelocity;
    return -GW * this.b - h * this.computeGiMf();
  }
}

class EquationGroup extends CANNON.Constraint {
  constructor(bodyA, bodyB, equations) {
    super(bodyA, bodyB, { wakeUpBodies: false });
    this.equations.push(...equations);
  }

  update() {}
}

function setBound(eq, impulse) {
  eq.maxForce = impulse;
  eq.minForce = -impulse;
}

function disable(eqs) {
  for (const eq of eqs) eq.enabled = false;
}

const tq1 = new CANNON.Quaternion();
const tq2 = new CANNON.Quaternion();
const tv1 = new CANNON.Vec3();
const tv2 = new CANNON.Vec3();
const tv3 = new CANNON.Vec3();

/** Rotation vector (axis * angle) of q, shortest path. */
function rotationVector(q, out) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(s, w);
  return out.set((x / s) * angle, (y / s) * angle, (z / s) * angle);
}

function signedAngle(a, b, axis) {
  a.cross(b, tv3);
  return Math.atan2(tv3.dot(axis), a.dot(b));
}

function toCannonQ(q) { return new CANNON.Quaternion(q.x, q.y, q.z, q.w); }
function toCannonV(v) { return new CANNON.Vec3(v.x, v.y, v.z); }
function smoothstep(t) { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); }

export class ActiveRagdoll {
  /**
   * @param {CANNON.World} world
   * @param {{ groundMaterial?: CANNON.Material, bodyMaterial?: CANNON.Material, params?: object }} options
   */
  constructor(world, options = {}) {
    this.world = world;
    this.params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
    this.bodyMaterial = options.bodyMaterial || null;
    this.anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    this.anchor.collisionFilterGroup = 0;
    this.anchor.collisionFilterMask = 0;
    world.addBody(this.anchor);
    this.segments = [];
    this.byId = new Map();
    this.joints = [];
    this.constraints = [];
    this.groundY = 0;
    this.state = "off";
    this.tone = 1;
    this.onStateChange = null;
    this.onGrabRelease = null;
    this.strength = 1;
    this.grabs = {};
    this._time = 0;
  }

  get active() {
    return this.state !== "off";
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this._stateTime = 0;
    this.onStateChange?.(next);
  }

  dispose() {
    for (const c of this.constraints) this.world.removeConstraint(c);
    for (const s of this.segments) this.world.removeBody(s.body);
    this.constraints = [];
    this.segments = [];
    this.joints = [];
    this.grabs = {};
    this._ordered = null;
    this.byId.clear();
    this.state = "off";
  }

  /**
   * Builds bodies from the bones' current world pose.
   * @param {Record<string, THREE.Object3D>} h humanoid bone map
   * @param {number} height figure height in metres
   */
  build(h, height, groundY = 0) {
    this.dispose();
    this.humanoid = h;
    this.height = height;
    this.groundY = groundY;
    const H = height;
    const scale = (this.params.totalMass / 62) * (H / 1.7);

    const pos = (bone) => bone.getWorldPosition(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0);
    const lateral = pos(h.leftUpperLeg).sub(pos(h.rightUpperLeg));
    lateral.y = 0;
    if (lateral.lengthSq() < 1e-8) lateral.set(1, 0, 0);
    lateral.normalize();
    const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
    this.forward = forward.clone();
    this.lateral = lateral.clone();

    const specs = [];
    const add = (spec) => specs.push(spec);
    const legRoot = pos(h.leftUpperLeg).add(pos(h.rightUpperLeg)).multiplyScalar(0.5);
    const spineBase = h.spine || h.chest;
    const torsoBone = h.chest || h.spine;
    const torsoTop = pos(h.neck || h.head);
    const hipWidth = pos(h.leftUpperLeg).distanceTo(pos(h.rightUpperLeg));

    add({ id: "pelvis", bone: h.hips, kind: "pelvis", from: legRoot.clone().addScaledVector(up, -0.03 * H), to: pos(spineBase),
      w: hipWidth + 0.08 * H, d: 0.11 * H, minLen: 0.1 * H });
    const shoulderWidth = h.leftUpperArm && h.rightUpperArm ? pos(h.leftUpperArm).distanceTo(pos(h.rightUpperArm)) * 0.85 : 0.2 * H;
    add({ id: "torso", bone: torsoBone, kind: "torso", parent: "pelvis", pivot: pos(spineBase), joint: "spine",
      from: pos(spineBase), to: torsoTop, w: Math.max(shoulderWidth, hipWidth + 0.04 * H), d: 0.12 * H });
    const torsoDir = torsoTop.clone().sub(pos(spineBase)).normalize();
    add({ id: "head", bone: h.head, kind: "head", parent: "torso", pivot: pos(h.head), joint: "neck",
      from: pos(h.head), to: pos(h.head).addScaledVector(torsoDir, 0.14 * H), w: 0.095 * H, d: 0.11 * H });

    for (const side of ["left", "right"]) {
      const S = (part) => h[side + part];
      if (S("UpperArm") && S("LowerArm")) {
        add({ id: `${side}UpperArm`, bone: S("UpperArm"), kind: "upperArm", parent: "torso", pivot: pos(S("UpperArm")), joint: "shoulder",
          from: pos(S("UpperArm")), to: pos(S("LowerArm")), w: 0.05 * H, d: 0.05 * H });
        const handPos = S("Hand") ? pos(S("Hand")) : null;
        const lowerEnd = handPos
          ? handPos.clone().addScaledVector(handPos.clone().sub(pos(S("LowerArm"))).normalize(), 0.07 * H)
          : pos(S("LowerArm")).addScaledVector(pos(S("LowerArm")).sub(pos(S("UpperArm"))).normalize(), 0.22 * H);
        const forearmDir = lowerEnd.clone().sub(pos(S("LowerArm"))).normalize();
        const handPoint = handPos ? handPos.clone().addScaledVector(forearmDir, 0.035 * H) : lowerEnd.clone().addScaledVector(forearmDir, -0.04 * H);
        add({ id: `${side}LowerArm`, bone: S("LowerArm"), kind: "lowerArm", parent: `${side}UpperArm`, pivot: pos(S("LowerArm")), joint: "elbow",
          from: pos(S("LowerArm")), to: lowerEnd, w: 0.042 * H, d: 0.042 * H, handPoint });
      }
      add({ id: `${side}UpperLeg`, bone: S("UpperLeg"), kind: "upperLeg", parent: "pelvis", pivot: pos(S("UpperLeg")), joint: "hip",
        from: pos(S("UpperLeg")), to: pos(S("LowerLeg")), w: 0.08 * H, d: 0.08 * H });
      add({ id: `${side}LowerLeg`, bone: S("LowerLeg"), kind: "lowerLeg", parent: `${side}UpperLeg`, pivot: pos(S("LowerLeg")), joint: "knee",
        from: pos(S("LowerLeg")), to: pos(S("Foot")), w: 0.06 * H, d: 0.06 * H });
      const ankle = pos(S("Foot"));
      const sole = Math.min(ankle.y - 0.035 * H, S("Toes") ? pos(S("Toes")).y - 0.01 * H : Infinity);
      const toeTip = S("Toes") ? pos(S("Toes")).addScaledVector(forward, 0.045 * H) : ankle.clone().addScaledVector(forward, 0.13 * H);
      const heel = ankle.clone().addScaledVector(forward, -0.035 * H);
      add({ id: `${side}Foot`, bone: S("Foot"), kind: "foot", parent: `${side}LowerLeg`, pivot: ankle, joint: "ankle",
        heel, toeTip, sole, footHeight: Math.max(0.03 * H, Math.min(0.06 * H, ankle.y - sole + 0.01 * H)), w: 0.06 * H });
    }

    const massSum = specs.reduce((sum, s) => sum + MASS[s.kind], 0);
    for (const spec of specs) this._createSegment(spec, (MASS[spec.kind] / massSum) * this.params.totalMass, lateral, forward, up);

    // Put the soles exactly on the ground so the figure does not drop or pop on activation.
    const feet = this.segments.filter((s) => s.kind === "foot");
    const lowest = Math.min(...feet.map((f) => f.body.position.y - f.halfExtents.y));
    const dy = groundY + 0.002 - lowest;
    for (const s of this.segments) s.body.position.y += dy;
    for (const spec of specs) {
      if (spec.pivot) spec.pivot.y += dy;
      if (spec.handPoint) spec.handPoint.y += dy;
    }

    for (const spec of specs) if (spec.parent) this._createJoint(spec, scale);
    this._createBalance();
    this._createGrabs();

    const pelvis = this.byId.get("pelvis");
    this.standPelvisHeight = pelvis.body.position.y - groundY;
    this.pelvisForwardLocal = pelvis.body.quaternion.inverse().vmult(toCannonV(forward));
    const torso = this.byId.get("torso");
    this.torsoUpLocal = torso.body.quaternion.inverse().vmult(toCannonV(torsoDir));
    this.halfStance = Math.max(0.05 * H, hipWidth * 0.5);
    this.torsoLateralLocal = torso.body.quaternion.inverse().vmult(toCannonV(lateral));
    this.footLength = feet[0].halfExtents.z * 2;
    this.footWidth = feet[0].halfExtents.x * 2;

    this.step = null;
    this.stepsInRow = 0;
    this._settle = 0;
    this._stateTime = 0;
    this.tone = 1;
    this.captureTargets();
    this.setState("standing");
  }

  _createSegment(spec, mass, lateral, forward, up) {
    const center = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const halfExtents = new THREE.Vector3();
    let axisY;
    if (spec.kind === "foot") {
      const flatForward = forward.clone();
      const len = spec.toeTip.clone().sub(spec.heel).dot(flatForward);
      center.copy(spec.heel).addScaledVector(flatForward, len / 2);
      center.y = spec.sole + spec.footHeight / 2;
      basis.makeBasis(lateral, up, flatForward);
      halfExtents.set(spec.w / 2, spec.footHeight / 2, Math.max(0.05, len) / 2);
      axisY = up.clone();
    } else {
      const seg = spec.to.clone().sub(spec.from);
      let len = seg.length();
      axisY = len > 1e-6 ? seg.clone().divideScalar(len) : up.clone();
      if (spec.minLen && len < spec.minLen) len = spec.minLen;
      center.copy(spec.from).addScaledVector(axisY, len / 2);
      let axisX = lateral.clone().addScaledVector(axisY, -lateral.dot(axisY));
      if (axisX.lengthSq() < 1e-4) axisX = forward.clone().addScaledVector(axisY, -forward.dot(axisY));
      axisX.normalize();
      const axisZ = new THREE.Vector3().crossVectors(axisX, axisY).normalize();
      basis.makeBasis(axisX, axisY, axisZ);
      halfExtents.set(spec.w / 2, len / 2, spec.d / 2);
    }
    const basisQ = new THREE.Quaternion().setFromRotationMatrix(basis);
    const bonePos = new THREE.Vector3();
    const boneQ = new THREE.Quaternion();
    spec.bone.matrixWorld.decompose(bonePos, boneQ, new THREE.Vector3());
    const invBoneQ = boneQ.clone().invert();

    const body = new CANNON.Body({
      mass,
      material: this.bodyMaterial || undefined,
      linearDamping: 0.03,
      angularDamping: 0.12,
      collisionFilterGroup: COLLISION.BODY,
      collisionFilterMask: COLLISION.ENV | COLLISION.HAND,
    });
    body.allowSleep = false;
    body.position.set(center.x, center.y, center.z);
    body.quaternion.set(boneQ.x, boneQ.y, boneQ.z, boneQ.w);
    const shapeQ = invBoneQ.clone().multiply(basisQ);
    body.addShape(new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)), new CANNON.Vec3(), toCannonQ(shapeQ));
    this.world.addBody(body);

    const segment = {
      ...spec,
      body,
      mass,
      halfExtents,
      boneOffset: toCannonV(bonePos.clone().sub(center).applyQuaternion(invBoneQ)),
      axisLocal: toCannonV(axisY.clone().applyQuaternion(invBoneQ)),
      target: new CANNON.Quaternion().copy(body.quaternion),
      depth: depthOf(spec.bone),
    };
    body.userData = { segment: spec.id };
    this.segments.push(segment);
    this.byId.set(spec.id, segment);
  }

  _createJoint(spec, scale) {
    const A = this.byId.get(spec.parent).body;
    const child = this.byId.get(spec.id);
    const B = child.body;
    const def = JOINTS[spec.joint];
    const pivot = toCannonV(spec.pivot);
    const pivotA = A.pointToLocalFrame(pivot);
    const pivotB = B.pointToLocalFrame(pivot);
    const parentSeg = this.byId.get(spec.parent);
    const childDirW = spec.kind === "foot" ? parentSeg.body.vectorToWorldFrame(parentSeg.axisLocal) : B.vectorToWorldFrame(child.axisLocal);
    const joint = { spec, A, B, def, strength: def.strength * scale, tone: 1, child, parent: parentSeg };

    if (def.hinge) {
      const parentDir = A.vectorToWorldFrame(parentSeg.axisLocal);
      let axis = parentDir.cross(toCannonV(this.forward));
      if (axis.length() < 0.2) axis = toCannonV(this.lateral);
      axis.normalize();
      const constraint = new CANNON.HingeConstraint(A, B, {
        pivotA, pivotB, axisA: A.vectorToLocalFrame(axis), axisB: B.vectorToLocalFrame(axis), collideConnected: false,
      });
      // Flexion sign: knees bend backwards, elbows bring the hand forwards.
      const childDir = B.vectorToWorldFrame(child.axisLocal);
      const rotated = new CANNON.Quaternion().setFromAxisAngle(axis, 0.1).vmult(childDir);
      const moved = rotated.vsub(childDir).dot(toCannonV(this.forward));
      joint.sign = (spec.joint === "knee" ? moved < 0 : moved > 0) ? 1 : -1;
      joint.hingeAxisA = A.vectorToLocalFrame(axis);
      const limitEq = new CANNON.RotationalMotorEquation(A, B, 1e6);
      limitEq.enabled = false;
      const motor = new CANNON.RotationalMotorEquation(A, B, 1);
      joint.motors = [motor];
      joint.limitEq = limitEq;
      this._addConstraint(constraint);
      this._addConstraint(new EquationGroup(A, B, [motor, limitEq]));
    } else {
      // cannon's twist limit measures the angle between perpendicular axes, which also grows with large swings
      // and then blocks the arm; joints that swing far use a swing-twist decomposition limit instead.
      const constraint = new CANNON.ConeTwistConstraint(A, B, {
        pivotA, pivotB, axisA: A.vectorToLocalFrame(childDirW), axisB: B.vectorToLocalFrame(childDirW),
        angle: def.swing, twistAngle: def.swingTwistLimit ? Math.PI : def.twist, collideConnected: false,
      });
      joint.motors = AXES.map(() => new CANNON.RotationalMotorEquation(A, B, 1));
      const extra = [];
      if (def.swingTwistLimit) {
        joint.restRel = A.quaternion.conjugate().mult(B.quaternion);
        joint.twistAxisB = B.vectorToLocalFrame(childDirW).unit();
        joint.limitEq = new CANNON.RotationalMotorEquation(A, B, 1e6);
        joint.limitEq.enabled = false;
        extra.push(joint.limitEq);
      }
      this._addConstraint(constraint);
      this._addConstraint(new EquationGroup(A, B, [...joint.motors, ...extra]));
    }
    this.joints.push(joint);
  }

  _createBalance() {
    const pelvis = this.byId.get("pelvis").body;
    this.uprightEqs = AXES.map(() => new CANNON.RotationalMotorEquation(pelvis, this.anchor, 1));
    this.pelvisLinEqs = AXES.map(() => new LinearMotorEquation(pelvis, this.anchor));
    this.pelvisLinEqs.forEach((eq, i) => eq.axis.copy(AXES[i]));
    this.uprightEqs.forEach((eq, i) => { eq.axisA.copy(AXES[i]); eq.axisB.copy(AXES[i]); });
    this._addConstraint(new EquationGroup(pelvis, this.anchor, [...this.uprightEqs, ...this.pelvisLinEqs]));
    this.footEqs = {};
    for (const side of ["left", "right"]) {
      const foot = this.byId.get(`${side}Foot`).body;
      const eqs = AXES.map((axis) => {
        const eq = new LinearMotorEquation(foot, this.anchor);
        eq.axis.copy(axis);
        eq.enabled = false;
        return eq;
      });
      this.footEqs[side] = eqs;
      this._addConstraint(new EquationGroup(foot, this.anchor, eqs));
    }
  }

  _createGrabs() {
    this.grabs = {};
    const torso = this.byId.get("torso").body;
    for (const side of ["left", "right"]) {
      const lower = this.byId.get(`${side}LowerArm`);
      const upper = this.byId.get(`${side}UpperArm`);
      if (!lower || !upper || !lower.handPoint) continue;
      const hand = toCannonV(lower.handPoint);
      const shoulder = toCannonV(upper.pivot);
      const elbow = toCannonV(lower.pivot);
      const eqs = AXES.map((axis) => {
        const eq = new PointMotorEquation(lower.body, this.anchor);
        eq.axis.copy(axis);
        eq.enabled = false;
        return eq;
      });
      this._addConstraint(new EquationGroup(lower.body, this.anchor, eqs));
      this.grabs[side] = {
        side,
        seg: lower,
        upper,
        upperLen: shoulder.distanceTo(elbow),
        lowerLen: elbow.distanceTo(hand),
        ikBlend: 0,
        eqs,
        handLocal: lower.body.pointToLocalFrame(hand),
        shoulderLocal: torso.pointToLocalFrame(shoulder),
        reach: shoulder.distanceTo(elbow) + elbow.distanceTo(hand),
        held: false,
        target: new CANNON.Vec3(),
        targetVel: new CANNON.Vec3(),
        stretch: 0,
        recover: 0,
      };
    }
  }

  /** World position of the figure's palm (the grab point), or null if the arm is not simulated. */
  handPosition(side, out = new CANNON.Vec3()) {
    const g = this.grabs[side];
    if (!g) return null;
    return g.seg.body.pointToWorldFrame(g.handLocal, out);
  }

  isHeld(side) {
    return Boolean(this.grabs[side]?.held);
  }

  /** Start holding the figure's hand; it is pulled towards `point` by a bounded spring, never teleported. */
  grab(side, point) {
    const g = this.grabs[side];
    if (!g || this.state !== "standing") return false;
    g.held = true;
    g.target.set(point.x, point.y, point.z);
    g.targetVel.setZero();
    g.stretch = 0;
    g.recover = 0;
    g.ikBlend = 0;
    return true;
  }

  setGrabTarget(side, point, dt = 0) {
    const g = this.grabs[side];
    if (!g?.held) return;
    if (dt > 0) {
      g.targetVel.set((point.x - g.target.x) / dt, (point.y - g.target.y) / dt, (point.z - g.target.z) / dt);
      const speed = g.targetVel.length();
      if (speed > this.params.grabMaxSpeed) g.targetVel.scale(this.params.grabMaxSpeed / speed, g.targetVel);
    }
    g.target.set(point.x, point.y, point.z);
  }

  release(side, reason = "user") {
    const g = this.grabs[side];
    if (!g?.held) return;
    g.held = false;
    g.recover = this.params.grabRecoverTime;
    g.upper.ikTarget = null;
    g.seg.ikTarget = null;
    disable(g.eqs);
    this.onGrabRelease?.(side, reason);
  }

  releaseAll(reason = "user") {
    for (const side of Object.keys(this.grabs)) this.release(side, reason);
  }

  get anyHeld() {
    return Object.values(this.grabs).some((g) => g.held);
  }

  _addConstraint(c) {
    this.world.addConstraint(c);
    this.constraints.push(c);
  }

  /** Read the animated pose of the bones as motor targets. Call after the animation update. */
  captureTargets() {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (const seg of this.segments) {
      seg.bone.matrixWorld.decompose(p, q, s);
      seg.target.set(q.x, q.y, q.z, q.w);
    }
  }

  /** Write the simulated pose back to the bones (rotations; translation only for the hips). */
  writeBones() {
    const pq = new THREE.Quaternion();
    const pp = new THREE.Vector3();
    const ps = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const wp = new THREE.Vector3();
    const ordered = this._ordered || (this._ordered = [...this.segments].sort((a, b) => a.depth - b.depth));
    for (const seg of ordered) {
      const { body, bone } = seg;
      const parent = bone.parent;
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(pp, pq, ps);
      if (seg.kind === "upperArm" && this._liftShoulder(seg)) parent.matrixWorld.decompose(pp, pq, ps);
      q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      bone.quaternion.copy(pq.invert().multiply(q));
      if (seg.kind === "pelvis") {
        const off = body.quaternion.vmult(seg.boneOffset, tv1);
        wp.set(body.position.x + off.x, body.position.y + off.y, body.position.z + off.z);
        bone.position.copy(parent.worldToLocal(wp));
      }
      bone.updateMatrixWorld(true);
    }
  }

  /** Raise the clavicle with the arm once the upper arm lifts past ~20° below horizontal (cosmetic, mesh only). */
  _liftShoulder(seg) {
    const side = seg.id.startsWith("left") ? "left" : "right";
    const clavicle = this.humanoid[`${side}Shoulder`];
    if (!clavicle || seg.bone.parent !== clavicle) return false;
    const dir = seg.body.quaternion.vmult(seg.axisLocal, tv1);
    const elevation = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const k = Math.min(1, Math.max(0, (elevation + 0.35) / (Math.PI / 2 + 0.35)));
    const angle = this.params.shoulderLift * smoothstep(k);
    if (angle < 0.005) return false;
    const torso = this.byId.get("torso").body;
    const outward = torso.quaternion.vmult(this.torsoLateralLocal, tv2);
    if (side === "right") outward.negate(outward);
    const axis = new THREE.Vector3(outward.x, outward.y, outward.z).cross(new THREE.Vector3(0, 1, 0));
    if (axis.lengthSq() < 1e-6) return false;
    const lift = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
    const clavWorld = clavicle.getWorldQuaternion(new THREE.Quaternion());
    const parentWorld = clavicle.parent.getWorldQuaternion(new THREE.Quaternion());
    clavicle.quaternion.copy(parentWorld.invert().multiply(lift.multiply(clavWorld)));
    clavicle.updateMatrixWorld(true);
    return true;
  }

  /** Mass-weighted centre and velocity. */
  centerOfMass(outPos, outVel) {
    outPos.set(0, 0, 0);
    outVel.set(0, 0, 0);
    let m = 0;
    for (const { body } of this.segments) {
      outPos.addScaledVector(body.mass, body.position, outPos);
      outVel.addScaledVector(body.mass, body.velocity, outVel);
      m += body.mass;
    }
    outPos.scale(1 / m, outPos);
    outVel.scale(1 / m, outVel);
    return m;
  }

  heading() {
    const f = this.byId.get("pelvis").body.quaternion.vmult(this.pelvisForwardLocal, tv1);
    return Math.atan2(f.x, f.z);
  }

  torsoTilt() {
    const torso = this.byId.get("torso").body;
    const upW = torso.quaternion.vmult(this.torsoUpLocal, tv1);
    return Math.acos(Math.min(1, Math.max(-1, upW.dot(UP))));
  }

  pelvisHeight() {
    return this.byId.get("pelvis").body.position.y - this.groundY;
  }

  /** Apply an impulse (N·s) at a world point to the closest segment, or to the given body. */
  pushAt(point, impulse, body = null) {
    let target = body;
    if (!target) {
      let best = Infinity;
      for (const seg of this.segments) {
        const d = seg.body.position.distanceTo(point);
        if (d < best) { best = d; target = seg.body; }
      }
    }
    if (!target) return;
    target.applyImpulse(impulse, point.vsub(target.position));
  }

  /** One controller update; call once before every fixed physics substep. */
  preStep(h) {
    if (!this.active) return;
    this._time += h;
    this._stateTime += h;
    const P = this.params;
    const com = this._com || (this._com = new CANNON.Vec3());
    const vel = this._vel || (this._vel = new CANNON.Vec3());
    const totalMass = this.centerOfMass(com, vel);
    const hSpeed = Math.hypot(vel.x, vel.z);
    const tilt = this.torsoTilt();
    const pelvisH = this.pelvisHeight();

    if (this.anyHeld) this.stepsInRow = Math.min(this.stepsInRow, P.maxStepsInRow - 1);
    if (this.state === "standing") {
      const down = tilt > P.fallTilt || pelvisH < 0.6 * this.standPelvisHeight || hSpeed > P.fallSpeed || this.stepsInRow > P.maxStepsInRow;
      if (down) {
        this.setState("fallen");
        this.releaseAll("fallen");
      }
    } else if (this.state === "fallen") {
      this._settle = hSpeed < 0.3 ? this._settle + h : 0;
      if (this._settle > P.settleTime || this._stateTime > 5) {
        this._beginGetUp();
      }
    } else if (this.state === "gettingUp") {
      if (this._stateTime > P.getUpTime && tilt < 15 * DEG && pelvisH > 0.9 * this.standPelvisHeight) {
        this.stepsInRow = 0;
        this.setState("standing");
      } else if (this._stateTime > P.getUpTime * 2.5) {
        this.onNeedsReset?.();
      }
    }

    const standing = this.state === "standing";
    const gettingUp = this.state === "gettingUp";
    const u = gettingUp ? smoothstep(this._stateTime / P.getUpTime) : 0;
    const toneTarget = standing ? 1 : gettingUp ? P.fallenTone + (1 - P.fallenTone) * smoothstep((this._stateTime / P.getUpTime) * 2) : P.fallenTone;
    this.tone += (toneTarget - this.tone) * Math.min(1, h * (standing ? 4 : 10));

    const feet = this._feetInfo();
    if (standing) this._updateStepping(h, com, vel, feet);
    else if (this.step) this._endStep();

    this._solveArmIk(h);
    for (const joint of this.joints) this._driveJoint(joint, h);
    this._driveGrabs(h);
    const reflex = this.step || this.stepsInRow > 0 ? 2.5 : 1;
    this._driveUpright(h, standing ? reflex : gettingUp ? 1 + 3 * u : 0);
    this._driveCom(h, com, vel, feet, standing, gettingUp, u, totalMass);
    this._driveFeet(h, gettingUp, feet);
  }

  _feetInfo() {
    const info = {};
    for (const side of ["left", "right"]) {
      const seg = this.byId.get(`${side}Foot`);
      const b = seg.body;
      info[side] = { body: b, grounded: b.position.y - seg.halfExtents.y < this.groundY + 0.03 };
    }
    return info;
  }

  /** Closest point to (x, z) on the support region: the segment between the stance feet. */
  _supportPoint(feet, x, z, out) {
    const a = this.step ? feet[this.step.side === "left" ? "right" : "left"].body.position : feet.left.body.position;
    const b = this.step ? a : feet.right.body.position;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 1e-8 ? Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / len2)) : 0;
    return out.set(a.x + abx * t, 0, a.z + abz * t);
  }

  _updateStepping(h, com, vel, feet) {
    const P = this.params;
    if (this.step) {
      this.step.t += h;
      if (this.step.t >= P.stepTime) this._endStep();
      return;
    }
    this._cooldown = Math.max(0, (this._cooldown || 0) - h);
    if (this._cooldown > 0) return;

    const comH = Math.max(0.3, com.y - this.groundY);
    const omega = Math.sqrt(9.81 / comH);
    const lead = this._grabLead(this._lead || (this._lead = new CANNON.Vec3()));
    const cp = tv2.set(com.x + vel.x / omega + lead.x, 0, com.z + vel.z / omega + lead.z);
    const support = this._supportPoint(feet, cp.x, cp.z, new CANNON.Vec3());
    const heading = this.heading();
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const dx = cp.x - support.x;
    const dz = cp.z - support.z;
    const along = dx * fx + dz * fz;
    const across = dx * fz - dz * fx; // + = towards the figure's left
    const outFwd = Math.max(0, Math.abs(along) - this.footLength * 0.4);
    const outSide = Math.max(0, Math.abs(across) - this.footWidth * 0.6);
    if (Math.hypot(outFwd, outSide) < P.stepThreshold) {
      if (Math.hypot(vel.x, vel.z) < 0.15) this.stepsInRow = 0;
      return;
    }

    // Lateral push: step with the foot on that side. Otherwise: the rear foot relative to the push direction.
    let side;
    if (outSide > outFwd) side = across > 0 ? "left" : "right";
    else {
      const l = feet.left.body.position;
      const r = feet.right.body.position;
      side = (l.x - r.x) * dx + (l.z - r.z) * dz < 0 ? "left" : "right";
    }
    const foot = feet[side].body;
    const sideSign = side === "left" ? 1 : -1;
    const lx = fz;
    const lz = -fx;
    const target = new CANNON.Vec3(
      com.x + (vel.x / omega) * 1.15 + lead.x + lx * sideSign * this.halfStance,
      foot.position.y,
      com.z + (vel.z / omega) * 1.15 + lead.z + lz * sideSign * this.halfStance,
    );
    const otherFoot = feet[side === "left" ? "right" : "left"].body;
    const reach = target.vsub(otherFoot.position);
    reach.y = 0;
    const len = reach.length();
    const maxLen = P.maxStepLength * (this.height / 1.7);
    if (len > maxLen) {
      reach.scale(maxLen / len, reach);
      target.x = otherFoot.position.x + reach.x;
      target.z = otherFoot.position.z + reach.z;
    }
    this.step = { side, t: 0, start: foot.position.clone(), target };
    this.stepsInRow += 1;
  }

  /** Horizontal offset by which held hands are pulled beyond arm's reach: shifts the capture point so she follows. */
  _grabLead(out) {
    out.set(0, 0, 0);
    const torso = this.byId.get("torso").body;
    for (const g of Object.values(this.grabs)) {
      if (!g.held) continue;
      const shoulder = torso.pointToWorldFrame(g.shoulderLocal, tv3);
      const dx = g.target.x - shoulder.x;
      const dz = g.target.z - shoulder.z;
      const d = Math.hypot(dx, dz);
      const excess = d - g.reach * 0.8;
      if (excess > 0 && d > 1e-6) {
        out.x += (dx / d) * excess;
        out.z += (dz / d) * excess;
      }
    }
    const max = this.params.maxStepLength * (this.height / 1.7);
    const len = Math.hypot(out.x, out.z);
    if (len > max) out.scale(max / len, out);
    return out;
  }

  /**
   * Two-bone IK from the shoulder towards each held target; the result becomes the arm muscles' target pose,
   * so the whole arm (not just the hand) follows. Elbow points outwards and slightly down/back.
   */
  _solveArmIk(h) {
    const torso = this.byId.get("torso").body;
    for (const g of Object.values(this.grabs)) {
      if (!g.held) continue;
      g.ikBlend = Math.min(1, g.ikBlend + h / this.params.grabIkBlendTime);
      const S = torso.pointToWorldFrame(g.shoulderLocal, new CANNON.Vec3());
      const toT = g.target.vsub(S);
      let D = toT.length();
      if (D < 1e-4) continue;
      const u = toT.scale(1 / D);
      const L1 = g.upperLen;
      const L2 = g.lowerLen;
      D = Math.min(Math.max(D, Math.abs(L1 - L2) + 1e-3), (L1 + L2) * 0.999);
      const outward = torso.quaternion.vmult(this.torsoLateralLocal);
      if (g.side === "right") outward.negate(outward);
      const fwd = UP.cross(outward);
      const pole = new CANNON.Vec3(0, -0.6, 0).vadd(fwd.scale(-0.3)).vadd(outward.scale(0.8));
      let v = pole.vsub(u.scale(pole.dot(u)));
      if (v.length() < 1e-3) v = fwd.scale(-1).vsub(u.scale(-fwd.dot(u)));
      v.normalize();
      const a = (L1 * L1 - L2 * L2 + D * D) / (2 * D);
      const hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const E = S.vadd(u.scale(a)).vadd(v.scale(hgt));
      const T = S.vadd(u.scale(D));
      g.upper.ikTarget = this._aimTarget(g.upper, E.vsub(S), g.ikBlend, g.upper.ikTarget);
      g.seg.ikTarget = this._aimTarget(g.seg, T.vsub(E), g.ikBlend, g.seg.ikTarget);
    }
  }

  /** Animated target of `seg`, swung (minimal rotation) so its long axis points along `dir`, blended by k. */
  _aimTarget(seg, dir, k, out) {
    const q = out || new CANNON.Quaternion();
    dir.normalize();
    const cur = seg.target.vmult(seg.axisLocal);
    const swing = new CANNON.Quaternion().setFromVectors(cur, dir);
    swing.mult(seg.target, q);
    if (k < 1) seg.target.slerp(q, k, q);
    return q;
  }

  _driveGrabs(h) {
    const P = this.params;
    const sizeK = this.height / 1.7;
    for (const g of Object.values(this.grabs)) {
      if (!g.held) {
        g.recover = Math.max(0, g.recover - h);
        continue;
      }
      const body = g.seg.body;
      const r = body.quaternion.vmult(g.handLocal, tv1);
      const ex = g.target.x - (body.position.x + r.x);
      const ey = g.target.y - (body.position.y + r.y);
      const ez = g.target.z - (body.position.z + r.z);
      const dist = Math.hypot(ex, ey, ez);
      g.stretch = dist > P.grabStretch * sizeK ? g.stretch + h : 0;
      if (dist > P.grabBreak * sizeK || g.stretch > P.grabStretchTime) {
        this.release(g.side, "stretch");
        continue;
      }
      const err = [ex, ey, ez];
      const ff = [g.targetVel.x, g.targetVel.y, g.targetVel.z];
      for (let i = 0; i < 3; i += 1) {
        const eq = g.eqs[i];
        eq.enabled = true;
        eq.ri.copy(r);
        eq.targetVelocity = clampAbs(err[i] / P.grabResponse + ff[i], P.grabMaxSpeed);
        setBound(eq, P.grabForce * sizeK * h);
      }
    }
  }

  _endStep() {
    if (this.step) disable(this.footEqs[this.step.side]);
    this.step = null;
    this._cooldown = 0.08;
  }

  _driveJoint(joint, h) {
    const P = this.params;
    const { A, B } = joint;
    let tone = this.tone * this.strength;
    let maxSpeed = P.maxJointSpeed;
    if (joint.spec.joint === "shoulder" || joint.spec.joint === "elbow") {
      const g = this.grabs[joint.spec.id.startsWith("left") ? "left" : "right"];
      if (g?.held) tone *= P.grabArmTone;
      else if (g?.recover > 0) {
        const k = smoothstep(1 - g.recover / P.grabRecoverTime);
        tone *= P.grabArmTone + (1 - P.grabArmTone) * k;
        maxSpeed *= 0.12 + 0.88 * k;
      }
    }
    if (this.step) {
      const swingLeg = joint.spec.id.startsWith(this.step.side) && (joint.spec.joint === "hip" || joint.spec.joint === "knee");
      if (swingLeg) tone *= 0.35;
    }
    const impulse = joint.strength * tone * h;

    if (joint.def.hinge) {
      const axis = A.quaternion.vmult(joint.hingeAxisA, tv1);
      const parentDir = A.quaternion.vmult(joint.parent.axisLocal, tv2);
      const childDir = B.quaternion.vmult(joint.child.axisLocal, tv3).clone();
      const theta = signedAngle(parentDir, childDir, axis);
      const parentT = joint.parent.ikTarget || joint.parent.target;
      const childT = joint.child.ikTarget || joint.child.target;
      const targetParentDir = parentT.vmult(joint.parent.axisLocal);
      const targetChildDir = childT.vmult(joint.child.axisLocal);
      const targetAxis = parentT.vmult(joint.hingeAxisA);
      let thetaT = signedAngle(targetParentDir, targetChildDir, targetAxis);
      if (this.step && joint.spec.joint === "knee" && joint.spec.id.startsWith(this.step.side)) {
        thetaT += joint.sign * 45 * DEG * Math.sin(Math.PI * Math.min(1, this.step.t / P.stepTime));
      }
      const [lo, hi] = joint.def.hinge;
      const flexT = Math.min(hi, Math.max(lo, joint.sign * thetaT));
      const desired = clampAbs((joint.sign * flexT - theta) / P.responseTime, maxSpeed);
      const motor = joint.motors[0];
      motor.axisA.copy(axis);
      motor.axisB.copy(axis);
      motor.targetVelocity = -desired;
      setBound(motor, impulse);

      const flex = joint.sign * theta;
      const limit = joint.limitEq;
      if (flex < lo || flex > hi) {
        const clamped = Math.min(hi, Math.max(lo, flex));
        limit.enabled = true;
        limit.axisA.copy(axis);
        limit.axisB.copy(axis);
        limit.targetVelocity = -(joint.sign * (clamped - flex)) / (4 * h);
        setBound(limit, 2000 * h);
      } else {
        limit.enabled = false;
      }
      return;
    }

    // qB_des = qA * (targetA^-1 * targetB); error = qB_des * qB^-1 (world frame). IK targets are absolute.
    if (joint.child.ikTarget) {
      joint.child.ikTarget.mult(B.quaternion.conjugate(tq2), tq2);
    } else {
      joint.parent.target.conjugate(tq1);
      tq1.mult(joint.child.target, tq2);
      A.quaternion.mult(tq2, tq1);
      tq1.mult(B.quaternion.conjugate(tq2), tq2);
    }
    const rv = rotationVector(tq2, tv1);
    rv.scale(1 / P.responseTime, rv);
    const speed = rv.length();
    if (speed > maxSpeed) rv.scale(maxSpeed / speed, rv);
    for (let i = 0; i < 3; i += 1) {
      const motor = joint.motors[i];
      motor.axisA.copy(AXES[i]);
      motor.axisB.copy(AXES[i]);
      motor.targetVelocity = -rv.dot(AXES[i]);
      setBound(motor, impulse);
    }
    if (joint.restRel) this._limitTwist(joint, h);
  }

  _limitTwist(joint, h) {
    const { A, B, limitEq } = joint;
    // Deviation from the rest pose in B's frame: qB = qA * restRel * d
    joint.restRel.conjugate(tq1);
    A.quaternion.conjugate(tq2);
    tq1.mult(tq2, tq1);
    tq1.mult(B.quaternion, tq1);
    const a = joint.twistAxisB;
    if (tq1.w < 0) { tq1.x = -tq1.x; tq1.y = -tq1.y; tq1.z = -tq1.z; tq1.w = -tq1.w; }
    const twist = 2 * Math.atan2(tq1.x * a.x + tq1.y * a.y + tq1.z * a.z, tq1.w);
    const limit = joint.def.twist;
    if (Math.abs(twist) <= limit) {
      limitEq.enabled = false;
      return;
    }
    const axis = B.quaternion.vmult(a, tv1);
    const clamped = Math.sign(twist) * limit;
    limitEq.enabled = true;
    limitEq.axisA.copy(axis);
    limitEq.axisB.copy(axis);
    limitEq.targetVelocity = -(clamped - twist) / (4 * h);
    setBound(limitEq, 400 * h);
  }

  _driveUpright(h, gain) {
    const P = this.params;
    const pelvisSeg = this.byId.get("pelvis");
    const pelvis = pelvisSeg.body;
    if (gain <= 0) {
      for (const eq of this.uprightEqs) eq.enabled = false;
      return;
    }
    // Animated pelvis orientation, re-yawed to the current heading: only tilt is corrected, not facing.
    const targetFwd = pelvisSeg.target.vmult(this.pelvisForwardLocal, tv2);
    const yawDelta = this.heading() - Math.atan2(targetFwd.x, targetFwd.z);
    tq1.setFromAxisAngle(UP, yawDelta);
    tq1.mult(pelvisSeg.target, tq2);
    tq2.mult(pelvis.quaternion.conjugate(tq1), tq1);
    const rv = rotationVector(tq1, tv1);
    rv.scale(1 / P.uprightResponse, rv);
    for (let i = 0; i < 3; i += 1) {
      const eq = this.uprightEqs[i];
      eq.enabled = true;
      eq.targetVelocity = rv.dot(AXES[i]);
      setBound(eq, P.uprightStrength * (this.height / 1.7) * Math.min(1, this.strength) * gain * h);
    }
  }

  _driveCom(h, com, vel, feet, standing, gettingUp, u, totalMass) {
    const P = this.params;
    const eqs = this.pelvisLinEqs;
    const g = 9.81;
    if (gettingUp) {
      const pelvis = this.byId.get("pelvis").body;
      const goal = this._getUp;
      const targetY = goal.startY + (this.groundY + this.standPelvisHeight - goal.startY) * u;
      const err = [goal.x - pelvis.position.x, targetY - pelvis.position.y, goal.z - pelvis.position.z];
      for (let i = 0; i < 3; i += 1) {
        eqs[i].enabled = true;
        eqs[i].targetVelocity = clampAbs(err[i] / 0.25, 1.2);
        setBound(eqs[i], (i === 1 ? 1.5 : 0.5) * totalMass * g * h);
      }
      return;
    }
    if (!standing) {
      disable(eqs);
      return;
    }
    const support = this._supportPoint(feet, com.x, com.z, tv2);
    eqs[1].enabled = false;
    let errX = support.x - com.x;
    let errZ = support.z - com.z;
    const dist = Math.hypot(errX, errZ);
    const deadZone = this.footLength * 0.4;
    const k = dist > deadZone ? (dist - deadZone) / dist : 0;
    errX *= k;
    errZ *= k;
    for (const [i, err] of [[0, errX], [2, errZ]]) {
      eqs[i].enabled = k > 0;
      eqs[i].targetVelocity = clampAbs(err / 0.4, 0.6);
      setBound(eqs[i], P.comAssist * Math.min(1, this.strength) * totalMass * g * h);
    }
  }

  _driveFeet(h, gettingUp, feet) {
    const P = this.params;
    for (const side of ["left", "right"]) {
      const eqs = this.footEqs[side];
      const foot = this.byId.get(`${side}Foot`);
      const body = foot.body;
      let goal = null;
      let bound = 0;
      if (this.step && this.step.side === side) {
        const s = this.step;
        const t = Math.min(1, s.t / P.stepTime);
        const e = smoothstep(t);
        goal = tv2.set(
          s.start.x + (s.target.x - s.start.x) * e,
          this.groundY + foot.halfExtents.y + P.stepHeight * (this.height / 1.7) * Math.sin(Math.PI * t),
          s.start.z + (s.target.z - s.start.z) * e,
        );
        bound = 900;
      } else if (this.state === "standing" && feet[side].grounded) {
        // Planted stance foot: horizontal drive to zero velocity, bounded like static friction.
        for (let i = 0; i < 3; i += 1) {
          eqs[i].enabled = i !== 1;
          eqs[i].targetVelocity = 0;
          setBound(eqs[i], 0.5 * this.params.totalMass * 9.81 * h);
        }
        continue;
      } else if (gettingUp) {
        const sign = side === "left" ? 1 : -1;
        const hd = this._getUp.heading;
        goal = tv2.set(
          this._getUp.x + Math.cos(hd) * sign * this.halfStance,
          body.position.y,
          this._getUp.z - Math.sin(hd) * sign * this.halfStance,
        );
        bound = 260;
      }
      if (!goal) {
        disable(eqs);
        continue;
      }
      const err = [goal.x - body.position.x, goal.y - body.position.y, goal.z - body.position.z];
      for (let i = 0; i < 3; i += 1) {
        eqs[i].enabled = !(gettingUp && i === 1);
        eqs[i].targetVelocity = clampAbs(err[i] / 0.05, 4);
        setBound(eqs[i], bound * h);
      }
    }
  }

  _beginGetUp() {
    const pelvis = this.byId.get("pelvis").body;
    const feet = ["left", "right"].map((s) => this.byId.get(`${s}Foot`).body.position);
    const heading = this.heading();
    this._getUp = {
      x: (pelvis.position.x + (feet[0].x + feet[1].x) / 2) / 2,
      z: (pelvis.position.z + (feet[0].z + feet[1].z) / 2) / 2,
      startY: pelvis.position.y,
      heading,
    };
    this.step = null;
    this.setState("gettingUp");
  }
}

function clampAbs(value, max) {
  return Math.max(-max, Math.min(max, value));
}

function depthOf(node) {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d += 1;
  return d;
}
