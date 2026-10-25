import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.02, 60);
  camera.position.set(0.6, 1.55, 1.6);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1.5, 3, 1);
  scene.add(sun);

  const fallbackFloor = new THREE.Group();
  fallbackFloor.name = "fallback-floor";
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(4, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  const grid = new THREE.GridHelper(8, 16, 0x38bdf8, 0x334155);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0.001;
  fallbackFloor.add(disc, grid);
  scene.add(fallbackFloor);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.6;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.495;
  // Left mouse belongs to the app (place / rotate / push); right mouse orbits, wheel zooms.
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.update();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, controls, fallbackFloor };
}
