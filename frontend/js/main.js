import * as THREE from "three";
import * as CANNON from "cannon-es";
import { api } from "./api.js";
import { Character } from "./character.js";
import { ModelsUI } from "./models-ui.js";
import { PhysicsWorld } from "./physics-world.js";
import { createScene } from "./scene.js";
import { XRMenu } from "./xr-menu.js";
import {
  AnchorKeeper,
  XRInput,
  createReticle,
  isArSupported,
  readRoom,
  startImmersiveAR,
  supportedFeatureList,
} from "./xr-session.js";

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"),
  enter: $("enter-ar"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  reset: $("reset"),
  session: $("session-state"),
  features: $("feature-state"),
  room: $("space-state"),
  figure: $("figure-state"),
  version: $("version"),
  hudToggle: $("hud-toggle"),
};

const PUSH = { normal: 30, strong: 170 };
const STICK_DEADZONE = 0.25;
const STICK_ROTATE = 2.4;
const STICK_MOVE = 0.9;
const GESTURE_ROTATE = 7;
const GESTURE_START = 0.025;
const TAP_MAX_MS = 700;
const HAND_COLLIDERS = [
  ["index-finger-tip", 0.016],
  ["middle-finger-tip", 0.016],
  ["thumb-tip", 0.016],
  ["middle-finger-metacarpal", 0.04],
  ["wrist", 0.035],
];
const STATE_LABEL = { off: "Idle", standing: "steht (Muskeln aktiv)", fallen: "gestürzt", gettingUp: "steht auf" };
const MODEL_KEY = "nova.model";

const { scene, camera, renderer, controls, fallbackFloor } = createScene();
const character = new Character(scene, renderer);
const physics = new PhysicsWorld();
const input = new XRInput(renderer, scene);
const anchors = new AnchorKeeper();
const menu = new XRMenu(scene, handleMenuAction);
const models = new ModelsUI({ onSelect: (entry) => loadModel(entry), onStatus: setStatus });
const reticle = createReticle();
const facingRing = createReticle(0x2dd4bf);
facingRing.scale.setScalar(3.2);
scene.add(reticle, facingRing);

let mode = "place";
let session = null;
let groundY = 0;
let loading = null;
let firstXrPlacement = true;
let roomTimer = 0;
const gestures = new Map();
const dragging = new Set();
const clock = new THREE.Clock();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

physics.ragdoll.onStateChange = (state) => {
  ui.figure.textContent = STATE_LABEL[state] || state;
  if (state === "fallen") setStatus("Gestürzt – sie steht gleich von selbst wieder auf (oder „Aufstellen“).");
  if (state === "standing" && mode === "interact") setStatus("Interaktion: anstoßen mit Händen/Controllern, Trigger/Pinch auf die Figur = Stoß.");
};
physics.ragdoll.onNeedsReset = () => resetFigure();

function setStatus(text) {
  ui.status.textContent = text;
  menu.setState({ status: text });
}

function horizontalCameraAxes() {
  const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0);
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  return { forward, right };
}

function yawFacingCamera(position) {
  const cam = camera.getWorldPosition(new THREE.Vector3());
  return Math.atan2(cam.x - position.x, cam.z - position.z);
}

function placeAt(position, yaw) {
  groundY = position.y;
  physics.setGroundY(groundY);
  character.place(position, yaw, { teleport: true });
  if (session) anchors.request(character.root.position, character.yaw);
  updateModeUi();
}

function commitPlacement() {
  if (session && character.placed) anchors.request(character.root.position, character.yaw);
}

function enterPhysics() {
  anchors.clear();
  character.blend = null;
  character.update(0);
  physics.setGroundY(groundY);
  physics.ragdoll.build(character.humanoid.bones, character.height, groundY);
  physics.enabled = true;
}

function exitPhysics() {
  if (!physics.ragdoll.active) return;
  const pelvis = physics.ragdoll.byId.get("pelvis").body.position;
  const heading = physics.ragdoll.heading();
  character.startBlendFromCurrent();
  physics.enabled = false;
  physics.ragdoll.dispose();
  for (const id of physics.kinematic.keys()) physics.hideKinematic(id);
  ui.figure.textContent = STATE_LABEL.off;
  character.place(new THREE.Vector3(pelvis.x, groundY, pelvis.z), heading);
  commitPlacement();
}

function setMode(next) {
  if (next === mode) return;
  if (next === "interact") {
    if (!character.ready) return setStatus("Modell lädt noch …");
    if (!character.placed || !character.root.visible) return setStatus("Erst platzieren: auf den Boden zielen und Trigger/Pinch.");
    if (!character.humanoid.physicsReady) {
      const missing = character.humanoid.missing.slice(0, 4).join(", ");
      return setStatus(`Keine Muskel-Physik: Skelett nicht als humanoid erkannt (fehlt u. a.: ${missing}).`);
    }
    enterPhysics();
    mode = "interact";
    setStatus("Interaktion: anstoßen mit Händen/Controllern, Trigger/Pinch auf die Figur = Stoß.");
  } else {
    exitPhysics();
    mode = "place";
    setStatus(
      session
        ? "Platzieren: Trigger/Pinch = hierhin, halten + seitlich ziehen = drehen, Grip halten = verschieben."
        : "Platzieren: Klick = hierhin, ziehen = drehen, Q/E drehen, Leertaste = Modus.",
    );
  }
  gestures.clear();
  dragging.clear();
  updateModeUi();
}

function toggleMode() {
  setMode(mode === "place" ? "interact" : "place");
}

function resetFigure() {
  if (!character.ready) return;
  if (mode === "interact") {
    physics.ragdoll.dispose();
    character.update(0);
    enterPhysics();
  } else if (!character.placed) {
    placeAt(new THREE.Vector3(0, groundY, 0), yawFacingCamera(new THREE.Vector3()));
  }
  ui.figure.textContent = STATE_LABEL[physics.ragdoll.state] || STATE_LABEL.off;
  setStatus("Figur steht wieder.");
}

function updateModeUi() {
  for (const button of ui.modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = !character.ready;
  }
  ui.reset.disabled = !character.ready;
  menu.setState({ mode });
}

function handleMenuAction(id) {
  if (id === "place" || id === "interact") setMode(id);
  else if (id === "reset") resetFigure();
  else if (id === "next") {
    const next = models.next(1);
    if (next) loadModel(next);
  }
}

async function loadModel(entry) {
  if (!entry) return;
  if (loading) await loading.catch(() => {});
  const wasInteract = mode === "interact";
  if (wasInteract) setMode("place");
  const previous = { position: character.root.position.clone(), yaw: character.yaw, placed: character.placed, visible: character.root.visible };
  setStatus(`Lade „${entry.name}“ …`);
  loading = character.load(entry, (p) => setStatus(`Lade „${entry.name}“ … ${Math.round(p * 100)} %`));
  try {
    await loading;
    models.setActive(entry.id);
    localStorage.setItem(MODEL_KEY, entry.id);
    if (previous.placed) {
      character.place(previous.position, previous.yaw);
      character.root.visible = previous.visible;
    }
    const h = character.humanoid;
    const extras = [`Idle: ${character.idleSource}`];
    if (character.vrm) extras.push("VRM-Spring-Bones aktiv");
    setStatus(
      h.physicsReady
        ? `„${entry.name}“ geladen (${extras.join(", ")}).`
        : `„${entry.name}“ geladen – kein humanoides Skelett erkannt, daher nur Anzeige ohne Physik.`,
    );
    if (wasInteract && h.physicsReady) setMode("interact");
  } catch (error) {
    setStatus(`„${entry.name}“ konnte nicht geladen werden: ${error.message}`);
    if (!character.ready && entry.id !== "default") await loadModel(models.get("default"));
  } finally {
    loading = null;
    updateModeUi();
  }
}

// ---------- XR input ----------

function menuHolder() {
  return input.byHand("left");
}

function rayMenuHit(slot) {
  if (slot === menuHolder()) return null;
  return menu.intersectRay(slot.rayOrigin(tmpA), slot.rayDirection(tmpB));
}

function pushWithRay(slot, impulse) {
  const origin = slot.rayOrigin(new THREE.Vector3());
  const dir = slot.rayDirection(new THREE.Vector3());
  const hit = physics.raycastBody(origin, origin.clone().addScaledVector(dir, 6));
  if (!hit) return false;
  physics.ragdoll.pushAt(hit.point, new CANNON.Vec3(dir.x * impulse, dir.y * impulse * 0.3, dir.z * impulse), hit.body);
  return true;
}

input.on("selectstart", (slot) => {
  slot.selecting = true;
  slot.consumed = false;
  const menuHit = rayMenuHit(slot);
  if (menuHit?.button) {
    menu.press(menuHit.button.id);
    slot.consumed = true;
    return;
  }
  if (mode === "place") {
    gestures.set(slot.index, {
      start: performance.now(),
      startPos: slot.handPosition(new THREE.Vector3()),
      startYaw: character.yaw,
      rotating: false,
    });
  } else if (physics.ragdoll.active) {
    pushWithRay(slot, slot.squeezing ? PUSH.strong : PUSH.normal);
  }
});

input.on("selectend", (slot) => {
  slot.selecting = false;
  const gesture = gestures.get(slot.index);
  gestures.delete(slot.index);
  if (slot.consumed || mode !== "place" || !gesture) return;
  if (gesture.rotating) {
    commitPlacement();
    return;
  }
  if (performance.now() - gesture.start < TAP_MAX_MS && slot.hit) {
    const yaw = firstXrPlacement || !character.placed ? yawFacingCamera(slot.hit) : character.yaw;
    firstXrPlacement = false;
    placeAt(slot.hit, yaw);
    setStatus("Platziert. Halten + seitlich ziehen oder Stick = drehen. A/X oder Menü: Interaktion.");
  }
});

input.on("squeezestart", (slot) => {
  slot.squeezing = true;
  if (mode === "place" && character.placed) dragging.add(slot.index);
});

input.on("squeezeend", (slot) => {
  slot.squeezing = false;
  if (dragging.delete(slot.index)) commitPlacement();
});

function updateXrInput(dt) {
  const { right, forward } = horizontalCameraAxes();
  let reticleSlot = null;
  const holder = menuHolder();

  input.forEachConnected((slot) => {
    if (slot.wasPressed("a")) toggleMode();
    if (slot.wasPressed("b")) resetFigure();

    const menuHit = rayMenuHit(slot);
    if (menuHit) {
      slot.setRayLength(menuHit.distance, 0xffffff);
      menu.setHover(menuHit.button?.id || null);
    } else if (mode === "interact") {
      const origin = slot.rayOrigin(tmpA);
      const hit = physics.raycastBody(origin, tmpB.copy(slot.rayDirection(tmpB)).multiplyScalar(6).add(origin));
      slot.setRayLength(hit ? hit.distance : 1.5, hit ? 0xfbbf24 : 0x6ee7ff);
    } else {
      slot.setRayLength(slot.hit ? slot.rayOrigin(tmpA).distanceTo(slot.hit) : 2, 0x6ee7ff);
    }
    if (slot !== holder && slot.hit && (!reticleSlot || slot.handedness === "right")) reticleSlot = slot;

    // Fingertip poke on the wrist menu.
    const tip = slot !== holder ? slot.joint("index-finger-tip") : null;
    if (tip) menu.poke(tip.getWorldPosition(tmpA));

    if (mode !== "place" || !character.placed) return;
    const gesture = gestures.get(slot.index);
    if (gesture) {
      const offset = slot.handPosition(tmpA).sub(gesture.startPos).dot(right);
      if (!gesture.rotating && Math.abs(offset) > GESTURE_START) gesture.rotating = true;
      if (gesture.rotating) {
        character.place(character.root.position, gesture.startYaw + offset * GESTURE_ROTATE);
        anchors.clear();
      }
    }
    if (dragging.has(slot.index) && slot.hit) {
      character.place(slot.hit, character.yaw);
      groundY = slot.hit.y;
      anchors.clear();
    }
    const [sx, sy] = slot.axes;
    if (Math.abs(sx) > STICK_DEADZONE) {
      character.rotate(-sx * STICK_ROTATE * dt);
      slot.stickActive = true;
    }
    if (Math.abs(sy) > STICK_DEADZONE) {
      character.place(character.root.position.clone().addScaledVector(forward, -sy * STICK_MOVE * dt), character.yaw);
      slot.stickActive = true;
    }
    if (slot.stickActive && Math.abs(sx) <= STICK_DEADZONE && Math.abs(sy) <= STICK_DEADZONE) {
      slot.stickActive = false;
      commitPlacement();
    }
  });
  if (!menu.mesh.visible) menu.setHover(null);
  menu.update(holder, camera);

  reticle.visible = mode === "place" && Boolean(reticleSlot);
  if (reticle.visible) {
    reticle.position.copy(reticleSlot.hit);
    reticle.rotation.set(0, firstXrPlacement || !character.placed ? yawFacingCamera(reticleSlot.hit) : character.yaw, 0);
  }
}

function updateColliders(dt) {
  input.slots.forEach((slot) => {
    const active = mode === "interact" && slot.connected;
    if (slot.isHand) {
      for (const [name, radius] of HAND_COLLIDERS) {
        const id = `${slot.index}:${name}`;
        const joint = slot.joint(name);
        if (active && joint) physics.setKinematicSphere(id, joint.getWorldPosition(tmpA), radius, dt);
        else physics.hideKinematic(id);
      }
      physics.hideKinematic(`${slot.index}:grip`);
    } else {
      const id = `${slot.index}:grip`;
      if (active && slot.grip.visible) physics.setKinematicSphere(id, slot.grip.getWorldPosition(tmpA), 0.05, dt);
      else physics.hideKinematic(id);
      for (const [name] of HAND_COLLIDERS) physics.hideKinematic(`${slot.index}:${name}`);
    }
  });
}

// ---------- Desktop input ----------

const pointer = { down: false, x: 0, y: 0, startYaw: 0, rotating: false };
const raycaster = new THREE.Raycaster();

function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (session || event.button !== 0) return;
  Object.assign(pointer, { down: true, x: event.clientX, y: event.clientY, startYaw: character.yaw, rotating: false });
  renderer.domElement.setPointerCapture(event.pointerId);
});

renderer.domElement.addEventListener("pointermove", (event) => {
  if (!pointer.down || mode !== "place" || !character.placed) return;
  const dx = event.clientX - pointer.x;
  if (!pointer.rotating && Math.abs(dx) > 5) pointer.rotating = true;
  if (pointer.rotating) character.place(character.root.position, pointer.startYaw + dx * 0.012);
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (!pointer.down) return;
  pointer.down = false;
  if (pointer.rotating || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) return;
  const ray = pointerRay(event);
  if (mode === "place") {
    const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY), new THREE.Vector3());
    if (hit) placeAt(hit, character.placed ? character.yaw : yawFacingCamera(hit));
  } else {
    const hit = physics.raycastBody(ray.origin, ray.origin.clone().addScaledVector(ray.direction, 20));
    if (hit) {
      const impulse = event.shiftKey ? PUSH.strong : PUSH.normal;
      const d = ray.direction;
      physics.ragdoll.pushAt(hit.point, new CANNON.Vec3(d.x * impulse, d.y * impulse * 0.3, d.z * impulse), hit.body);
    }
  }
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    toggleMode();
  } else if (event.code === "KeyR") resetFigure();
  else if (event.code === "KeyQ" && mode === "place") character.rotate(Math.PI / 12);
  else if (event.code === "KeyE" && mode === "place") character.rotate(-Math.PI / 12);
  else if (event.code === "KeyN") loadModel(models.next(1));
});

// ---------- HUD ----------

for (const button of ui.modeButtons) button.addEventListener("click", () => setMode(button.dataset.mode));
ui.reset.addEventListener("click", resetFigure);
ui.hudToggle.addEventListener("click", () => document.body.classList.toggle("hud-collapsed"));

ui.enter.addEventListener("click", async () => {
  if (session) {
    session.end();
    return;
  }
  try {
    setMode("place");
    session = await startImmersiveAR(renderer, document.getElementById("hud"));
    document.body.classList.add("xr-active");
    ui.enter.textContent = "AR beenden";
    ui.session.textContent = "immersive-ar";
    const features = supportedFeatureList(session);
    ui.features.textContent = features.length ? features.join(", ") : "nur Basis (Boden-Fallback)";
    fallbackFloor.visible = false;
    character.root.visible = false;
    character.placed = false;
    firstXrPlacement = true;
    setStatus("Passthrough aktiv. Auf den Boden zielen und Trigger/Pinch drücken.");
    session.addEventListener("end", onSessionEnd);
  } catch (error) {
    session = null;
    setStatus(error.message);
  }
});

function onSessionEnd() {
  setMode("place");
  session = null;
  anchors.clear();
  physics.beginRoomSync();
  physics.endRoomSync();
  document.body.classList.remove("xr-active");
  ui.enter.textContent = "AR starten";
  ui.session.textContent = "inaktiv";
  ui.room.textContent = "—";
  fallbackFloor.visible = true;
  reticle.visible = false;
  menu.mesh.visible = false;
  groundY = 0;
  placeAt(new THREE.Vector3(0, 0, 0), yawFacingCamera(new THREE.Vector3()));
  setStatus("AR beendet. Desktop-Ansicht.");
}

// ---------- Loop ----------

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const refSpace = frame ? renderer.xr.getReferenceSpace() : null;
  const xr = Boolean(session && frame && refSpace);

  if (xr) {
    input.update(frame, refSpace, groundY);
    anchors.update(frame, refSpace);
    roomTimer -= dt;
    if (roomTimer <= 0) {
      roomTimer = 1;
      const room = readRoom(frame, refSpace, physics);
      ui.room.textContent = room.available ? `${room.planeCount} Ebenen, ${room.meshCount} Meshes, ${physics.roomColliderCount} Kollider` : "kein Raum-Scan";
      if (room.floorY !== null && !character.placed) groundY = room.floorY;
    }
    updateXrInput(dt);
  } else {
    const hips = character.humanoid.bones.hips;
    if (hips && character.root.visible) controls.target.lerp(hips.getWorldPosition(tmpA), Math.min(1, dt * 3));
    controls.update();
  }

  if (mode === "place") {
    if (xr && !gestures.size && !dragging.size) {
      const anchored = anchors.pose(frame, refSpace);
      if (anchored && anchored.position.distanceToSquared(character.root.position) > 1e-6) {
        character.root.position.copy(anchored.position);
        character.root.rotation.y = character.yaw = anchored.yaw;
      }
    }
    character.update(dt);
  } else {
    character.update(dt);
    physics.ragdoll.captureTargets();
    if (xr) updateColliders(dt);
    physics.step(dt);
    physics.ragdoll.writeBones();
  }
  character.updateSecondary(dt);
  character.updateShadow(groundY);

  facingRing.visible = mode === "place" && character.placed && character.root.visible;
  if (facingRing.visible) {
    facingRing.position.copy(character.root.position).setY(groundY + 0.004);
    facingRing.rotation.set(0, character.yaw, 0);
  }
  renderer.render(scene, camera);
});

// ---------- Startup ----------

isArSupported().then((ok) => {
  ui.enter.disabled = !ok;
  if (!ok) ui.enter.textContent = "AR nicht verfügbar";
});
api.version().then((info) => {
  ui.version.textContent = `v${info.version} · ${String(info.git_commit).slice(0, 7)}`;
}).catch(() => {});

updateModeUi();
models.init().then(async () => {
  const entry = models.get(localStorage.getItem(MODEL_KEY)) || models.get("default") || models.models[0];
  await loadModel(entry);
  if (!character.placed) placeAt(new THREE.Vector3(0, 0, 0), yawFacingCamera(new THREE.Vector3()));
  setStatus(`${ui.status.textContent} Desktop: Klick = platzieren, ziehen = drehen, Leertaste = Interaktion.`);
});
