import * as THREE from "three";

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 2.4);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x334466, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(1.5, 3, 1);
  scene.add(dir);

  const fallbackFloor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshStandardMaterial({
      color: 0x334155,
      transparent: true,
      opacity: 0.28,
      roughness: 1,
    }),
  );
  fallbackFloor.rotation.x = -Math.PI / 2;
  fallbackFloor.receiveShadow = true;
  fallbackFloor.name = "fallback-floor";
  scene.add(fallbackFloor);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, xrCompatible: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, fallbackFloor };
}
