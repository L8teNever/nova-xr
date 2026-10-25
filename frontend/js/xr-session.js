import * as THREE from "three";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

export const OPTIONAL_FEATURES = [
  "plane-detection",
  "mesh-detection",
  "hit-test",
  "anchors",
  "hand-tracking",
  "local-floor",
  "dom-overlay",
];

export function supportedFeatureList(session) {
  const enabled = [];
  for (const name of ["hit-test", "plane-detection", "mesh-detection", "anchors", "hand-tracking"]) {
    if (session.enabledFeatures?.includes(name)) enabled.push(name);
  }
  return enabled;
}

export async function startImmersiveAR(renderer, overlay) {
  if (!navigator.xr) {
    throw new Error("WebXR ist in diesem Browser nicht verfügbar.");
  }
  const ok = await navigator.xr.isSessionSupported("immersive-ar");
  if (!ok) {
    throw new Error("immersive-ar wird nicht unterstützt. Quest-Browser oder WebXR-Emulator nutzen.");
  }

  const session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local-floor"],
    optionalFeatures: OPTIONAL_FEATURES,
    domOverlay: overlay ? { root: overlay } : undefined,
  });
  await renderer.xr.setSession(session);
  return session;
}

export function bindControllers(renderer, scene) {
  const controllerModelFactory = new XRControllerModelFactory();
  const handModelFactory = new XRHandModelFactory();
  const grips = [];
  const hands = [];
  const controllers = [];

  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    scene.add(controller);
    controllers.push(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerModelFactory.createControllerModel(grip));
    scene.add(grip);
    grips.push(grip);

    const hand = renderer.xr.getHand(i);
    hand.add(handModelFactory.createHandModel(hand, "mesh"));
    scene.add(hand);
    hands.push(hand);
  }
  return { controllers, grips, hands };
}

export function createReticle() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6ee7ff }),
  );
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.015, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  const group = new THREE.Group();
  group.add(ring, dot);
  group.visible = false;
  group.matrixAutoUpdate = false;
  return group;
}

export async function createHitTestSource(session) {
  if (!session.requestHitTestSource) return null;
  try {
    const space = await session.requestReferenceSpace("viewer");
    return session.requestHitTestSource({ space });
  } catch {
    return null;
  }
}

export function getHitPose(frame, hitTestSource, refSpace) {
  if (!hitTestSource) return null;
  const hits = frame.getHitTestResults(hitTestSource);
  const hit = hits[0];
  return hit?.getPose(refSpace) ?? null;
}

export function collectRoomGeometry(frame, refSpace) {
  const planes = [];
  const meshes = [];
  const detectedPlanes = frame.detectedPlanes || frame.session?.detectedPlanes;
  if (detectedPlanes) {
    for (const plane of detectedPlanes) {
      const pose = frame.getPose(plane.planeSpace || plane, refSpace);
      if (!pose) continue;
      planes.push({
        pose,
        orientation: plane.orientation || "horizontal",
        polygon: plane.polygon,
      });
    }
  }
  const detectedMeshes = frame.detectedMeshes || frame.session?.detectedMeshes;
  if (detectedMeshes) {
    for (const mesh of detectedMeshes) {
      const pose = frame.getPose(mesh.meshSpace || mesh, refSpace);
      if (!pose) continue;
      meshes.push({ pose, mesh });
    }
  }
  return { planes, meshes };
}
