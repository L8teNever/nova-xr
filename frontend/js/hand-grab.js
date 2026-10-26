import * as THREE from "three";

export const GRAB_RADIUS = 0.1;
const HOVER_FACTOR = 1.4;
const COLORS = { hover: 0xfbbf24, held: 0x34d399 };
const SIDES = ["left", "right"];

/**
 * Binds "grabbers" (controllers, tracked hands, the mouse) to the figure's hands. A grab starts only on the
 * rising edge of a grabber's hold (grip, pinch, fist, mouse button) within `radius` of a free hand; while held,
 * the grabber's position drives the ragdoll's hand target. Shows a highlight per hand and sends haptic pulses.
 *
 * grabber: { id, position: Vector3, holding: boolean, radius?: number, pulse?: (intensity, ms) => void }
 * ragdoll: { grab(side, p), setGrabTarget(side, p, dt), release(side, reason), isHeld(side) }
 */
export class HandGrab {
  constructor(scene = null, { radius = GRAB_RADIUS } = {}) {
    this.radius = radius;
    this.bindings = new Map();
    this.holding = new Map();
    this.hovering = new Map();
    this.pulses = new Map();
    this.onGrab = null;
    this.onRelease = null;
    this.beforeGrab = null;
    this.markers = {};
    if (scene) {
      for (const side of SIDES) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(1, 20, 14),
          new THREE.MeshBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0.45, depthWrite: false }),
        );
        marker.visible = false;
        marker.renderOrder = 5;
        scene.add(marker);
        this.markers[side] = marker;
      }
    }
  }

  isGrabbing(id) {
    return this.bindings.has(id);
  }

  holderOf(side) {
    for (const [id, s] of this.bindings) if (s === side) return id;
    return null;
  }

  /** Closest figure hand within `radius` of `point` that is not already held, or null. */
  nearest(hands, point, radius = this.radius) {
    let best = null;
    let bestDist = radius;
    for (const side of SIDES) {
      const hand = hands[side];
      if (!hand || this.holderOf(side)) continue;
      const d = Math.hypot(hand.x - point.x, hand.y - point.y, hand.z - point.z);
      if (d <= bestDist) {
        best = side;
        bestDist = d;
      }
    }
    return best;
  }

  /** Called from the ragdoll's onGrabRelease (also for releases it decides itself: stretched too far, fallen). */
  handleRelease(side, reason) {
    const id = this.holderOf(side);
    if (!id) return;
    this.bindings.delete(id);
    if (reason !== "user") this.pulses.get(id)?.(0.5, 90);
    this.onRelease?.(id, side, reason);
  }

  releaseAll(ragdoll) {
    for (const side of [...this.bindings.values()]) ragdoll.release(side, "user");
    this.bindings.clear();
  }

  /**
   * @param ragdoll the active ragdoll (may be inactive; grabs then only start if beforeGrab activates it)
   * @param hands { left: Vector3|null, right: Vector3|null } figure palm positions
   * @param grabbers current grabber states
   */
  update(ragdoll, hands, grabbers, dt) {
    const seen = new Set();
    for (const g of grabbers) {
      seen.add(g.id);
      if (g.pulse) this.pulses.set(g.id, g.pulse);
      const started = g.holding && !this.holding.get(g.id);
      this.holding.set(g.id, g.holding);
      const side = this.bindings.get(g.id);
      if (side) {
        if (!g.holding) {
          this.bindings.delete(g.id);
          ragdoll.release(side, "user");
          g.pulse?.(0.2, 25);
          this.onRelease?.(g.id, side, "user");
        } else {
          ragdoll.setGrabTarget(side, g.position, dt);
        }
        this.hovering.delete(g.id);
        continue;
      }
      const radius = g.radius ?? this.radius;
      const hover = g.holding ? null : this.nearest(hands, g.position, radius * HOVER_FACTOR);
      if (hover && this.hovering.get(g.id) !== hover) g.pulse?.(0.12, 12);
      if (hover) this.hovering.set(g.id, hover);
      else this.hovering.delete(g.id);
      if (!started) continue;
      const target = this.nearest(hands, g.position, radius);
      if (!target) continue;
      if (this.beforeGrab && this.beforeGrab(target, g) === false) continue;
      if (!ragdoll.grab(target, g.position)) continue;
      this.bindings.set(g.id, target);
      g.pulse?.(0.7, 45);
      this.onGrab?.(g.id, target);
    }
    for (const id of [...this.holding.keys()]) {
      if (seen.has(id)) continue;
      const side = this.bindings.get(id);
      if (side) {
        this.bindings.delete(id);
        ragdoll.release(side, "user");
        this.onRelease?.(id, side, "lost");
      }
      this.holding.delete(id);
      this.hovering.delete(id);
    }
  }

  /** "held" | "hover" | null per hand, for UI and tests. */
  stateOf(side) {
    if (this.holderOf(side)) return "held";
    for (const s of this.hovering.values()) if (s === side) return "hover";
    return null;
  }

  updateMarkers(hands) {
    for (const side of SIDES) {
      const marker = this.markers[side];
      if (!marker) continue;
      const state = this.stateOf(side);
      const hand = hands[side];
      marker.visible = Boolean(state && hand);
      if (!marker.visible) continue;
      marker.position.copy(hand);
      marker.scale.setScalar(state === "held" ? 0.04 : 0.05);
      marker.material.color.setHex(COLORS[state]);
      marker.material.opacity = state === "held" ? 0.6 : 0.4;
    }
  }

  hideMarkers() {
    for (const marker of Object.values(this.markers)) marker.visible = false;
  }
}
