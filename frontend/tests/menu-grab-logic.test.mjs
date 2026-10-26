import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { HandGrab } from "../js/hand-grab.js";
import {
  MENU_H,
  MENU_W,
  buildLayout,
  clampRange,
  hitTest,
  pageCount,
  sliderValue,
  uvToPixel,
  wrapDegrees,
} from "../js/menu-layout.js";

const models = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, name: `Modell ${i}` }));
const baseState = { mode: "place", relocating: false, yawDeg: 0, scalePct: 100, strengthPct: 100, models, activeId: "m1", page: 0, status: "" };
const center = (c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });

test("menu contains every required control, inside the canvas and without overlaps", () => {
  const controls = buildLayout(baseState);
  const ids = controls.map((c) => c.id);
  for (const id of ["close", "place", "interact", "relocate", "reset", "rotate", "rotate:-", "rotate:+", "scale", "strength", "model:m0", "page:1"]) {
    assert.ok(ids.includes(id), `${id} missing`);
  }
  const interactive = controls.filter((c) => c.type !== "label");
  for (const c of interactive) {
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= MENU_W && c.y + c.h <= MENU_H, `${c.id} outside the canvas`);
    assert.ok(c.h >= 80, `${c.id} too small to hit comfortably`);
  }
  for (const a of interactive) {
    for (const b of interactive) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
  assert.equal(controls.find((c) => c.id === "place").active, true);
  assert.equal(controls.find((c) => c.id === "model:m1").active, true);
});

test("hit-testing maps UVs and pixels to the right control", () => {
  const controls = buildLayout(baseState);
  for (const id of ["interact", "relocate", "close", "scale:+"]) {
    const c = controls.find((x) => x.id === id);
    const { x, y } = center(c);
    assert.equal(hitTest(controls, x, y)?.id, id);
    const px = uvToPixel({ x: x / MENU_W, y: 1 - y / MENU_H });
    assert.equal(hitTest(controls, px.x, px.y)?.id, id);
  }
  assert.equal(hitTest(controls, 5, 5), null);
  const label = controls.find((c) => c.id === "rotate-label");
  assert.equal(hitTest(controls, label.x + 5, label.y + 5), null);
});

test("sliders map position to clamped values; rotation wraps", () => {
  const controls = buildLayout(baseState);
  const scale = controls.find((c) => c.id === "scale");
  assert.equal(sliderValue(scale, scale.x - 100), 50);
  assert.equal(sliderValue(scale, scale.x + scale.w / 2), 100);
  assert.equal(sliderValue(scale, scale.x + scale.w + 100), 150);
  const strength = controls.find((c) => c.id === "strength");
  assert.equal(sliderValue(strength, strength.x), 20);
  assert.equal(clampRange("strength", 500), 200);
  assert.equal(wrapDegrees(190), -170);
  assert.equal(wrapDegrees(-180), -180);
  assert.equal(wrapDegrees(540), -180);
});

test("model list is paged", () => {
  assert.equal(pageCount(models), 3);
  const page2 = buildLayout({ ...baseState, page: 2 });
  assert.deepEqual(page2.filter((c) => c.action === "model").map((c) => c.value), ["m6"]);
  const single = buildLayout({ ...baseState, models: models.slice(0, 2) });
  assert.ok(!single.some((c) => c.action === "page"));
  const clamped = buildLayout({ ...baseState, page: 99 });
  assert.deepEqual(clamped.filter((c) => c.action === "model").map((c) => c.value), ["m6"]);
});

class FakeRagdoll {
  constructor() {
    this.held = {};
    this.targets = {};
    this.log = [];
    this.allow = true;
  }
  grab(side, p) {
    if (!this.allow) return false;
    this.held[side] = true;
    this.targets[side] = p.clone();
    this.log.push(`grab:${side}`);
    return true;
  }
  setGrabTarget(side, p) {
    this.targets[side] = p.clone();
  }
  release(side, reason) {
    if (!this.held[side]) return;
    this.held[side] = false;
    this.log.push(`release:${side}:${reason}`);
    this.onGrabRelease?.(side, reason);
  }
  isHeld(side) {
    return Boolean(this.held[side]);
  }
}

function grabFixture() {
  const ragdoll = new FakeRagdoll();
  const grab = new HandGrab(null);
  ragdoll.onGrabRelease = (side, reason) => grab.handleRelease(side, reason);
  const hands = { left: new THREE.Vector3(0.3, 1, 0), right: new THREE.Vector3(-0.3, 1, 0) };
  const pulses = [];
  const grabber = (id, position, holding) => ({ id, position, holding, pulse: (i, ms) => pulses.push([id, i, ms]) });
  return { ragdoll, grab, hands, pulses, grabber };
}

test("grab starts only on a fresh hold within 10 cm, follows, and releases", () => {
  const { ragdoll, grab, hands, pulses, grabber } = grabFixture();
  const far = new THREE.Vector3(0.3, 1, 0.15);
  grab.update(ragdoll, hands, [grabber("c0", far, true)], 1 / 72);
  assert.equal(ragdoll.log.length, 0, "grabbed from 15 cm");
  // Still holding while moving into range: no grab (needs a fresh press near the hand).
  grab.update(ragdoll, hands, [grabber("c0", new THREE.Vector3(0.3, 1, 0.05), true)], 1 / 72);
  assert.equal(ragdoll.log.length, 0, "sweeping a held grip into range must not grab");
  grab.update(ragdoll, hands, [grabber("c0", new THREE.Vector3(0.3, 1, 0.05), false)], 1 / 72);
  assert.equal(grab.stateOf("left"), "hover");
  assert.ok(pulses.some(([, i]) => i < 0.2), "no hover pulse");
  grab.update(ragdoll, hands, [grabber("c0", new THREE.Vector3(0.3, 1, 0.05), true)], 1 / 72);
  assert.deepEqual(ragdoll.log, ["grab:left"]);
  assert.equal(grab.stateOf("left"), "held");
  assert.ok(pulses.some(([, i]) => i >= 0.5), "no grab pulse");
  const moved = new THREE.Vector3(0.4, 1.5, 0.2);
  grab.update(ragdoll, hands, [grabber("c0", moved, true)], 1 / 72);
  assert.ok(ragdoll.targets.left.equals(moved));
  grab.update(ragdoll, hands, [grabber("c0", moved, false)], 1 / 72);
  assert.deepEqual(ragdoll.log, ["grab:left", "release:left:user"]);
  assert.equal(grab.isGrabbing("c0"), false);
});

test("both hands independently; a held hand cannot be taken by the other grabber", () => {
  const { ragdoll, grab, hands, grabber } = grabFixture();
  const nearLeft = hands.left.clone().add(new THREE.Vector3(0, 0.03, 0));
  const nearRight = hands.right.clone().add(new THREE.Vector3(0, -0.03, 0));
  grab.update(ragdoll, hands, [grabber("a", nearLeft, false), grabber("b", nearLeft, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("a", nearLeft, true), grabber("b", nearLeft, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("a", nearLeft, true), grabber("b", nearLeft, true)], 1 / 72);
  assert.deepEqual(ragdoll.log, ["grab:left"], "second grabber stole the held hand");
  grab.update(ragdoll, hands, [grabber("a", nearLeft, true), grabber("b", nearRight, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("a", nearLeft, true), grabber("b", nearRight, true)], 1 / 72);
  assert.deepEqual(ragdoll.log, ["grab:left", "grab:right"]);
  assert.equal(grab.holderOf("left"), "a");
  assert.equal(grab.holderOf("right"), "b");
});

test("ragdoll-initiated release (stretched) clears the binding and pulses; lost grabbers release", () => {
  const { ragdoll, grab, hands, pulses, grabber } = grabFixture();
  const near = hands.right.clone();
  grab.update(ragdoll, hands, [grabber("h", near, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("h", near, true)], 1 / 72);
  const reasons = [];
  grab.onRelease = (id, side, reason) => reasons.push(reason);
  pulses.length = 0;
  ragdoll.release("right", "stretch");
  assert.equal(grab.isGrabbing("h"), false);
  assert.deepEqual(reasons, ["stretch"]);
  assert.equal(pulses.length, 1);
  // Keep holding: no automatic re-grab without a fresh press.
  grab.update(ragdoll, hands, [grabber("h", near, true)], 1 / 72);
  assert.equal(grab.isGrabbing("h"), false);

  grab.update(ragdoll, hands, [grabber("h", near, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("h", near, true)], 1 / 72);
  assert.ok(grab.isGrabbing("h"));
  grab.update(ragdoll, hands, [], 1 / 72);
  assert.equal(grab.isGrabbing("h"), false);
  assert.equal(reasons.at(-1), "lost");
});

test("beforeGrab can veto (e.g. figure not ready) and per-grabber radius applies", () => {
  const { ragdoll, grab, hands, grabber } = grabFixture();
  grab.beforeGrab = () => false;
  const p = hands.left.clone().add(new THREE.Vector3(0, 0, 0.05));
  grab.update(ragdoll, hands, [grabber("m", p, false)], 1 / 72);
  grab.update(ragdoll, hands, [grabber("m", p, true)], 1 / 72);
  assert.equal(ragdoll.log.length, 0);
  grab.beforeGrab = null;
  const p2 = hands.left.clone().add(new THREE.Vector3(0, 0, 0.115));
  grab.update(ragdoll, hands, [{ ...grabber("m", p2, false), radius: 0.12 }], 1 / 72);
  grab.update(ragdoll, hands, [{ ...grabber("m", p2, true), radius: 0.12 }], 1 / 72);
  assert.deepEqual(ragdoll.log, ["grab:left"]);
});
