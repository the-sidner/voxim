/**
 * Three.js viewport — scene, camera, orbit controls, render loop.
 * Call init(canvas) once. Call setVoxelMesh() when the mesh changes.
 */
import * as THREE from "three";
import { cursorMesh, selectionMesh } from "./voxel_mesh.ts";

// ---- scene ----

export const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const grid = new THREE.GridHelper(32, 32, 0x444444, 0x333333);
scene.add(grid);

const axes = new THREE.AxesHelper(3);
scene.add(axes);

scene.add(cursorMesh);
scene.add(selectionMesh);

// Lighting
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(10, 20, 10);
sun.castShadow = true;
scene.add(sun);

// ---- camera ----

let _camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
_camera.position.set(8, 12, 16);
_camera.lookAt(4, 4, 4);

export function getCamera(): THREE.PerspectiveCamera { return _camera; }

// ---- renderer ----

let _renderer: THREE.WebGLRenderer | null = null;
let _raf = 0;

let _currentMesh: THREE.Object3D | null = null;
let _currentSubMesh: THREE.Object3D | null = null;

export function setVoxelMesh(mesh: THREE.Object3D | null): void {
  if (_currentMesh) scene.remove(_currentMesh);
  _currentMesh = mesh;
  if (mesh) scene.add(mesh);
}

export function setSubObjectMesh(mesh: THREE.Object3D | null): void {
  if (_currentSubMesh) scene.remove(_currentSubMesh);
  _currentSubMesh = mesh;
  if (mesh) scene.add(mesh);
}

// ---- orbit ----

type OrbitState = {
  dragging: boolean;
  lastX: number;
  lastY: number;
  theta: number; // azimuth radians
  phi: number;   // elevation radians
  radius: number;
  target: THREE.Vector3;
};

const orbit: OrbitState = {
  dragging: false, lastX: 0, lastY: 0,
  theta: Math.PI / 4, phi: Math.PI / 4,
  radius: 22,
  target: new THREE.Vector3(4, 4, 4),
};

function applyOrbit(): void {
  const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
  const y = orbit.target.y + orbit.radius * Math.cos(orbit.phi);
  const z = orbit.target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
  _camera.position.set(x, y, z);
  _camera.lookAt(orbit.target);
}

// ---- public init ----

type PointerCallback = (e: PointerEvent) => void;

export interface ViewportCallbacks {
  onPointerMove: PointerCallback;
  onPointerDown: PointerCallback;
  onPointerUp:   PointerCallback;
}

export function init(canvas: HTMLCanvasElement, cb: ViewportCallbacks): void {
  _renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  _renderer.setPixelRatio(devicePixelRatio);
  _renderer.shadowMap.enabled = true;

  applyOrbit();

  // Resize
  const resize = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    _renderer!.setSize(w, h, false);
    _camera.aspect = w / h;
    _camera.updateProjectionMatrix();
  });
  resize.observe(canvas);

  // Orbit mouse
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      orbit.dragging = true;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    cb.onPointerDown(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (orbit.dragging) {
      const dx = e.clientX - orbit.lastX;
      const dy = e.clientY - orbit.lastY;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
      orbit.theta -= dx * 0.01;
      orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi - dy * 0.01));
      applyOrbit();
      return;
    }
    cb.onPointerMove(e);
  });

  canvas.addEventListener("pointerup", (e) => {
    if (orbit.dragging) {
      orbit.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      return;
    }
    cb.onPointerUp(e);
  });

  canvas.addEventListener("wheel", (e) => {
    orbit.radius = Math.max(2, Math.min(100, orbit.radius + e.deltaY * 0.05));
    applyOrbit();
  }, { passive: true });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Render loop
  function loop(): void {
    _raf = requestAnimationFrame(loop);
    _frameListener?.();
    _renderer!.render(scene, _camera);
  }
  loop();
}

// ---- frame listener ----

let _frameListener: (() => void) | null = null;

/** Register a callback invoked every render frame (before draw). Pass null to clear. */
export function setFrameListener(fn: (() => void) | null): void {
  _frameListener = fn;
}

export function dispose(): void {
  cancelAnimationFrame(_raf);
  _renderer?.dispose();
}
