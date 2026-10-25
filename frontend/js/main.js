import * as THREE from "three";
import { Character } from "./character.js";
import { PhysicsWorld } from "./physics.js";
import { createScene } from "./scene.js";
import {
  bindControllers,
  collectRoomGeometry,
  createHitTestSource,
  createReticle,
  getHitPose,
  startImmersiveAR,
  supportedFeatureList,
} from "./xr-session.js";

const statusEl = document.getElementById("status");
const sessionEl = document.getElementById("session-state");
const featureEl = document.getElementById("feature-state");
const spaceEl = document.getElementById("space-state");
const enterBtn = document.getElementById("enter-ar");
const modeBtn = document.getElementById("toggle-mode");
const resetBtn = document.getElementById("reset");

const { scene, camera, renderer, fallbackFloor } = createScene();
const character = new Character(scene);
const physics = new PhysicsWorld();
const reticle = createReticle();
scene.add(reticle);

let mode = "place";
let session = null;
let hitTestSource = null;
let xrAnchor = null;
let lastHit = new THREE.Vector3(0, 0, -1.4);
let lastSelect = 0;
let lastModeToggle = 0;
const clock = new THREE.Clock();
const { controllers, grips, hands } = bindControllers(renderer, scene);

function setStatus(text) {
  statusEl.textContent = text;
}

function setMode(next) {
  mode = next;
  modeBtn.textContent = next === "place" ? "Modus: Platzieren" : "Modus: Interaktion";
  if (next === "interact") {
    character.stopIdle();
    physics.syncFromBones();
    physics.setEnabled(true);
    setStatus("Ragdoll aktiv. Hände oder Controller berühren die Figur.");
  } else {
    physics.setEnabled(false);
    character.playIdle();
    if (character.anchored) {
      character.place(character.root.position, character.yaw);
    }
    setStatus("Platzieren: Trigger/Pinch setzt die Figur auf den Boden.");
  }
}

function placeAt(position, yaw = character.yaw) {
  const pos = position.clone();
  pos.y += 0.01;
  character.place(pos, yaw);
  physics.syncFromBones();
  resetBtn.disabled = false;
  modeBtn.disabled = false;
}

async function tryCreateAnchor(frame, pose, refSpace) {
  if (!session?.requestPersistentAnchor && !frame.createAnchor) return;
  try {
    xrAnchor = await frame.createAnchor(pose, refSpace);
  } catch {
    xrAnchor = null;
  }
}

function updateRoomPhysics(frame, refSpace) {
  const { planes, meshes } = collectRoomGeometry(frame, refSpace);
  spaceEl.textContent = `${planes.length} Ebenen, ${meshes.length} Meshes`;
  if (planes.length === 0 && meshes.length === 0) {
    fallbackFloor.visible = true;
    return;
  }
  fallbackFloor.visible = false;
  physics.clearRoom();
  for (const plane of planes) {
    const t = plane.pose.transform;
    const origin = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    const matrix = new THREE.Matrix4().fromArray(t.matrix);
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(matrix));
    if (plane.orientation === "vertical") {
      physics.addStaticBox(origin, new THREE.Vector3(2.4, 2.4, 0.08), new THREE.Quaternion().setFromRotationMatrix(matrix));
    } else {
      physics.addStaticPlane(origin, normal);
    }
  }
  for (const item of meshes) {
    const t = item.pose.transform;
    const origin = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    physics.addStaticBox(origin, new THREE.Vector3(0.8, 0.8, 0.8), new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w));
  }
}

function updateHandsAndControllers() {
  for (const [index, hand] of hands.entries()) {
    const joints = ["index-finger-tip", "thumb-tip", "wrist"];
    for (const jointName of joints) {
      const joint = hand.joints?.[jointName];
      if (!joint) continue;
      const pos = new THREE.Vector3();
      joint.getWorldPosition(pos);
      physics.updateHandCollider(`hand-${index}-${jointName}`, pos);
      if (mode === "interact" && character.root.visible) {
        const away = new THREE.Vector3().subVectors(character.root.position, pos);
        if (away.length() < 0.28) {
          physics.shoveNearest(pos, away.setLength(0.12));
        }
      }
    }
  }
  for (const [index, grip] of grips.entries()) {
    if (!grip.visible) continue;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    grip.getWorldPosition(pos);
    grip.getWorldQuaternion(quat);
    physics.updateController(`grip-${index}`, pos, quat);
    if (mode === "interact" && character.root.visible) {
      const away = new THREE.Vector3().subVectors(character.root.position, pos);
      if (away.length() < 0.35) {
        physics.shoveNearest(pos, away.setLength(0.15));
      }
    }
  }
}

function desktopFallbackPlace() {
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ray = new THREE.Ray(origin, dir);
  const hit = new THREE.Vector3();
  if (ray.intersectPlane(plane, hit)) {
    lastHit.copy(hit);
    reticle.visible = true;
    reticle.matrix.identity();
    reticle.matrix.setPosition(hit);
  }
}

function onSelect() {
  const now = performance.now();
  if (now - lastSelect < 250) return;
  lastSelect = now;
  if (mode === "place" && reticle.visible) {
    placeAt(lastHit);
    setStatus("Figur verankert. Wechsle in Interaktion, um sie anzustoßen.");
  } else if (mode === "interact") {
    physics.shoveNearest(lastHit, new THREE.Vector3(0, 2.2, -1.4));
  }
}

for (const controller of controllers) {
  controller.addEventListener("select", onSelect);
  controller.addEventListener("squeeze", () => {
    if (mode === "place") character.rotate(Math.PI / 8);
  });
}

enterBtn.addEventListener("click", async () => {
  try {
    session = await startImmersiveAR(renderer, document.getElementById("hud"));
    document.body.classList.add("xr-active");
    sessionEl.textContent = "immersive-ar";
    const features = supportedFeatureList(session);
    featureEl.textContent = features.length ? features.join(", ") : "Basis + Fallback-Boden";
    hitTestSource = await createHitTestSource(session);
    setStatus("Passthrough aktiv. Ziele auf den Boden und drücke Trigger.");
    modeBtn.disabled = false;
    session.addEventListener("end", () => {
      session = null;
      hitTestSource = null;
      document.body.classList.remove("xr-active");
      sessionEl.textContent = "inaktiv";
      fallbackFloor.visible = true;
    });
  } catch (error) {
    setStatus(error.message);
  }
});

modeBtn.addEventListener("click", () => {
  setMode(mode === "place" ? "interact" : "place");
});

resetBtn.addEventListener("click", () => {
  setMode("place");
  if (character.anchored) placeAt(character.root.position, character.yaw);
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    setMode(mode === "place" ? "interact" : "place");
  }
  if (event.code === "KeyE") onSelect();
  if (event.code === "KeyQ") character.rotate(-Math.PI / 16);
  if (event.code === "KeyR") character.rotate(Math.PI / 16);
});

renderer.domElement.addEventListener("pointerdown", () => {
  if (!session) onSelect();
});

character.load().then(() => {
  physics.bindCharacter(character);
  placeAt(new THREE.Vector3(0, 0, -1.5), 0);
  setStatus("Modell geladen. AR starten oder Desktop-Fallback (E platzieren, Leertaste Modus).");
  resetBtn.disabled = false;
  modeBtn.disabled = false;
}).catch((error) => {
  setStatus(`Modellfehler: ${error.message}`);
});

let roomSyncTimer = 0;

renderer.setAnimationLoop((time, frame) => {
  const delta = clock.getDelta();
  character.update(delta);

  const refSpace = renderer.xr.getReferenceSpace();
  if (frame && refSpace) {
    const pose = getHitPose(frame, hitTestSource, refSpace);
    if (pose) {
      reticle.visible = mode === "place";
      reticle.matrix.fromArray(pose.transform.matrix);
      lastHit.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
      if (mode === "place" && character.anchored && xrAnchor == null) {
        tryCreateAnchor(frame, pose.transform, refSpace);
      }
    } else if (mode === "place") {
      desktopFallbackPlace();
    }

    roomSyncTimer += delta;
    if (roomSyncTimer > 1.2) {
      roomSyncTimer = 0;
      updateRoomPhysics(frame, refSpace);
    }

    for (const source of session?.inputSources || []) {
      const gamepad = source.gamepad;
      if (gamepad?.axes?.length >= 3 && mode === "place") {
        const x = gamepad.axes[2] || gamepad.axes[0] || 0;
        if (Math.abs(x) > 0.35) character.rotate(x * delta * 2.2);
      }
      if ((gamepad?.buttons?.[4]?.pressed || gamepad?.buttons?.[5]?.pressed) && time - lastModeToggle > 400) {
        lastModeToggle = time;
        setMode(mode === "place" ? "interact" : "place");
      }
    }
  } else if (mode === "place") {
    desktopFallbackPlace();
  }

  updateHandsAndControllers();
  physics.step(delta);
  renderer.render(scene, camera);
});

fetch("/api/version")
  .then((res) => res.json())
  .then((info) => {
    sessionEl.dataset.commit = info.git_commit;
  })
  .catch(() => {});
