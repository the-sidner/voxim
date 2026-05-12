/**
 * 3D viewport — Three.js scene wrapped for reuse by every studio editor.
 *
 * Provides: a renderer attached to a canvas, scene root + ground grid,
 * default lighting rig, an orbit camera with pan/zoom/orbit controls, a
 * frame() helper that fits the camera to a bounding box, and a content
 * group editors attach their objects to.
 *
 * No game-content imports. Editors mount this, populate `contentGroup`,
 * and call `dispose()` on teardown. The same viewport powers the voxel
 * editor, animation editor, and any future tool.
 *
 * Controls (left-mouse orbit, right-mouse pan, wheel zoom) implemented
 * inline so we don't pull in three's OrbitControls (which would add an
 * extra npm dep + module routing).
 */
import * as THREE from "three";

export interface Viewport {
  /** Mount the canvas into a parent element and start the render loop. */
  attach(parent: HTMLElement): void;
  /** Detach + dispose all GL resources. */
  dispose(): void;
  /** Frame the camera to the given AABB. */
  frame(box: THREE.Box3, margin?: number): void;
  /** Add object3Ds here. Cleared by editors on switch. */
  readonly contentGroup: THREE.Group;
  /** Live scene reference for editors that need to spawn debug overlays. */
  readonly scene: THREE.Scene;
}

export function createViewport(): Viewport {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222226);

  // Lighting: one warm sun + one cool fill + low ambient.
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
  sun.position.set(6, 12, 8);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9bb6ff, 0.4);
  fill.position.set(-8, 4, -6);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // Reference grid so models in a void still have a horizon.
  const grid = new THREE.GridHelper(20, 20, 0x444448, 0x2f2f33);
  scene.add(grid);

  const contentGroup = new THREE.Group();
  contentGroup.name = "content";
  scene.add(contentGroup);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  camera.position.set(5, 4, 5);

  const target = new THREE.Vector3(0, 1, 0);
  const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(target));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Force the canvas to be sized by its container, not by its backing
  // buffer. Without explicit CSS, the canvas's intrinsic size equals
  // its `width` attribute (= clientWidth × pixelRatio), which makes
  // the flex parent grow, which makes the ResizeObserver fire bigger,
  // which grows the canvas more — runaway right-ward expansion.
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width   = "100%";
  renderer.domElement.style.height  = "100%";

  let raf = 0;
  let attached = false;
  let parentEl: HTMLElement | null = null;
  let resizeObs: ResizeObserver | null = null;

  const attach = (parent: HTMLElement) => {
    if (attached) return;
    attached = true;
    parentEl = parent;
    parent.appendChild(renderer.domElement);
    sizeToParent();
    installControls(renderer.domElement);
    resizeObs = new ResizeObserver(sizeToParent);
    resizeObs.observe(parent);
    tick();
  };

  const sizeToParent = () => {
    if (!parentEl) return;
    const w = parentEl.clientWidth;
    const h = parentEl.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const installControls = (el: HTMLCanvasElement) => {
    let dragging: "orbit" | "pan" | null = null;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("mousedown", (e) => {
      dragging = e.button === 2 ? "pan" : "orbit";
      lastX = e.clientX;
      lastY = e.clientY;
    });
    globalThis.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dragging === "orbit") {
        spherical.theta -= dx * 0.005;
        spherical.phi   -= dy * 0.005;
        spherical.phi = clamp(spherical.phi, 0.05, Math.PI - 0.05);
      } else {
        const distScale = spherical.radius * 0.0018;
        // Pan: move target in the camera's right/up plane.
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        target.addScaledVector(right, -dx * distScale);
        target.addScaledVector(up,     dy * distScale);
      }
    });
    globalThis.addEventListener("mouseup", () => { dragging = null; });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      spherical.radius *= 1 + (e.deltaY * 0.001);
      spherical.radius = clamp(spherical.radius, 0.4, 200);
    }, { passive: false });
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const p = new THREE.Vector3().setFromSpherical(spherical).add(target);
    camera.position.copy(p);
    camera.lookAt(target);
    renderer.render(scene, camera);
  };

  const dispose = () => {
    cancelAnimationFrame(raf);
    resizeObs?.disconnect();
    if (parentEl && renderer.domElement.parentElement === parentEl) {
      parentEl.removeChild(renderer.domElement);
    }
    renderer.dispose();
    attached = false;
  };

  const frame = (box: THREE.Box3, margin = 1.3) => {
    const center = new THREE.Vector3();
    box.getCenter(center);
    target.copy(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * margin;
    spherical.radius = Math.max(radius, 1.5);
  };

  return { attach, dispose, frame, contentGroup, scene };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
