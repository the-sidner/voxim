/// <reference lib="dom" />
/**
 * Inspect-tab 3D preview scene.
 *
 * Owns its own three.js renderer / scene / camera so it doesn't fight with
 * the voxel + animate viewports.  Builds a posed character from a prefab:
 *   - mounts the prefab's model on its skeleton (voxels parented to bone groups)
 *   - plays the locomotion clip resolved through prefab.animationSlots
 *   - optionally attaches a held weapon model to the hand_r bone
 *   - records that a swing was triggered so the inspector UI can flash; full
 *     swing-path-driven IK is a follow-up (the runtime evaluator does it via
 *     swingPath + solveTwoBoneIK; replicating that here cleanly is its own
 *     batch of work).
 *
 * Frame loop is requestAnimationFrame; advances clip time at the wall-clock
 * rate so a clip with `durationSeconds: 1` cycles once a second at 1× speed.
 */
import * as THREE from "three";
import { evaluateAnimationLayers, buildClipIndex, buildMaskIndex } from "@voxim/content";
import type {
  ContentService, SkeletonDef, MaterialDef, AnimationLayer, AnimationClip,
} from "@voxim/content";
import type { Locomotion, ActiveSwing } from "./inspect_state.ts";
import { vertexDisp } from "../../../../client/src/render/displacement.ts";
import { getVoxelTexture } from "../../../../client/src/render/material_textures.ts";

// ---- public scene handle ----

export interface PreviewScene {
  canvas: HTMLCanvasElement;
  /** Reconfigure for a new prefab/weapon — rebuilds meshes. */
  setPrefab(prefabId: string | null, weaponPrefabId: string | null): void;
  /** Switch locomotion clip. */
  setLocomotion(loc: Locomotion): void;
  /** Multiplier on top of the clip's native rate. */
  setSpeed(speed: number): void;
  /** Begin a one-shot swing.  null clears any active swing. */
  setSwing(swing: ActiveSwing | null): void;
  /** Pause/resume frame ticks. */
  setPlaying(playing: boolean): void;
  /** Tear down everything (called when the tab is unmounted). */
  dispose(): void;
}

// ---- internals ----

const VOX_GEO = new THREE.BoxGeometry(1, 1, 1);

interface InternalState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  raf: number;
  lastFrameMs: number;

  content: ContentService;
  skeleton: SkeletonDef | null;
  clipIndex: ReadonlyMap<string, AnimationClip>;
  maskIndex: ReturnType<typeof buildMaskIndex>;

  prefabId: string | null;
  weaponPrefabId: string | null;
  locomotion: Locomotion;
  speed: number;
  swing: ActiveSwing | null;
  playing: boolean;

  characterRoot: THREE.Group | null;
  boneGroups: Map<string, THREE.Group>;
  weaponAnchor: THREE.Group | null;
  /** Persistent normalised clip time per clip id so switching back resumes mid-cycle. */
  timeByClip: Map<string, number>;
}

export function createPreviewScene(
  hostEl: HTMLElement,
  content: ContentService,
): PreviewScene {
  // ---- canvas / renderer / scene / camera ----
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  hostEl.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(5, 10, 7);
  sun.castShadow = true;
  scene.add(sun);
  const grid = new THREE.GridHelper(20, 20, 0x444444, 0x2a2a2a);
  scene.add(grid);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(4, 4, 6);
  camera.lookAt(0, 1.2, 0);

  const state: InternalState = {
    scene, camera, renderer,
    raf: 0, lastFrameMs: performance.now(),
    content,
    skeleton: null,
    clipIndex: new Map(),
    maskIndex: new Map(),
    prefabId: null, weaponPrefabId: null,
    locomotion: "idle", speed: 1.0,
    swing: null, playing: true,
    characterRoot: null,
    boneGroups: new Map(),
    weaponAnchor: null,
    timeByClip: new Map(),
  };

  // ---- resize ----
  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    if (canvas.width === Math.floor(w * renderer.getPixelRatio()) &&
        canvas.height === Math.floor(h * renderer.getPixelRatio())) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---- mouse-drag orbit (lightweight, no OrbitControls dep) ----
  let dragging = false;
  let lastX = 0, lastY = 0;
  const orbit = { yaw: Math.atan2(camera.position.x, camera.position.z), pitch: 0.45, dist: 7.5 };
  const target = new THREE.Vector3(0, 1.2, 0);
  function applyOrbit() {
    const cy = Math.cos(orbit.pitch), sy = Math.sin(orbit.pitch);
    const cx = Math.cos(orbit.yaw),    sx = Math.sin(orbit.yaw);
    camera.position.set(
      target.x + orbit.dist * cy * sx,
      target.y + orbit.dist * sy,
      target.z + orbit.dist * cy * cx,
    );
    camera.lookAt(target);
  }
  applyOrbit();
  canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  globalThis.addEventListener("mouseup",   () => { dragging = false; });
  globalThis.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    orbit.yaw -= dx * 0.01;
    orbit.pitch = Math.max(-1.3, Math.min(1.3, orbit.pitch - dy * 0.01));
    applyOrbit();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbit.dist = Math.max(1.5, Math.min(30, orbit.dist + e.deltaY * 0.01));
    applyOrbit();
  }, { passive: false });

  // ---- frame loop ----
  function frame(now: number) {
    state.raf = requestAnimationFrame(frame);
    resize();
    if (state.playing) tickAnimation(state, (now - state.lastFrameMs) / 1000);
    state.lastFrameMs = now;
    renderer.render(scene, camera);
  }
  state.raf = requestAnimationFrame(frame);

  return {
    canvas,
    setPrefab(prefabId, weaponPrefabId) {
      state.prefabId = prefabId;
      state.weaponPrefabId = weaponPrefabId;
      rebuildCharacter(state);
    },
    setLocomotion(loc) { state.locomotion = loc; },
    setSpeed(speed) { state.speed = speed; },
    setSwing(swing) { state.swing = swing; },
    setPlaying(p) {
      state.playing = p;
      if (p) state.lastFrameMs = performance.now();
    },
    dispose() {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      clearCharacter(state);
      renderer.dispose();
      canvas.remove();
    },
  };
}

// ---- character build / rebuild ----

function clearCharacter(state: InternalState): void {
  if (state.characterRoot) {
    state.scene.remove(state.characterRoot);
    state.characterRoot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mat) => mat.dispose()); else m.dispose();
      }
    });
  }
  state.characterRoot = null;
  state.boneGroups.clear();
  state.weaponAnchor = null;
  state.skeleton = null;
  state.clipIndex = new Map();
  state.maskIndex = new Map();
}

function rebuildCharacter(state: InternalState): void {
  clearCharacter(state);
  if (!state.prefabId) return;

  const prefab = state.content.prefabs.get(state.prefabId);
  if (!prefab?.modelId) return;
  const model = state.content.models.get(prefab.modelId);
  if (!model) return;
  const skeleton = model.skeletonId ? state.content.skeletons.get(model.skeletonId) : null;
  if (!skeleton) return;

  state.skeleton = skeleton;
  state.clipIndex = buildClipIndex(skeleton);
  state.maskIndex = buildMaskIndex(skeleton);

  // Build the bone group hierarchy.  Coord swap mirrors animate/skeleton_view:
  // model (x, y, z) → three (x, z, y).  Local rotations are applied as-is by
  // evaluateAnimationLayers, mirroring how the existing animate tab poses.
  const root = new THREE.Group();
  const boneGroups = new Map<string, THREE.Group>();
  for (const bone of skeleton.bones) {
    const bg = new THREE.Group();
    bg.name = `bone:${bone.id}`;
    bg.position.set(bone.restX, bone.restZ, bone.restY);
    const parent = bone.parent !== null
      ? (boneGroups.get(bone.parent) ?? root)
      : root;
    parent.add(bg);
    boneGroups.set(bone.id, bg);
  }

  const matsList = state.content.materials.values();
  const matMap = new Map<number, MaterialDef>(matsList.map((m) => [m.id, m]));

  // Skeletal models put body-part voxels in sub-objects parented to bones.
  for (const sub of model.subObjects) {
    const subModelId = sub.modelId ?? sub.pool?.[0];
    if (!subModelId) continue;
    const subDef = state.content.models.get(subModelId);
    if (!subDef) continue;
    const target = sub.boneId ? (boneGroups.get(sub.boneId) ?? root) : root;
    const subGroup = new THREE.Group();
    subGroup.name = `sub:${subModelId}`;
    subGroup.position.set(sub.transform.x, sub.transform.z, sub.transform.y);
    target.add(subGroup);
    for (const node of subDef.nodes) {
      subGroup.add(buildVoxel(node.x, node.y, node.z, node.materialId, matMap, 1));
    }
  }

  // Top-level voxels (rare for skeletal models — most have everything in subs).
  for (const node of model.nodes) {
    root.add(buildVoxel(node.x, node.y, node.z, node.materialId, matMap, 1));
  }

  // Held-weapon anchor on hand_r — populated separately so we can swap weapons
  // without rebuilding the character.
  const handR = boneGroups.get("hand_r");
  if (handR) {
    const anchor = new THREE.Group();
    anchor.name = "weapon_anchor";
    handR.add(anchor);
    state.weaponAnchor = anchor;
  }

  state.scene.add(root);
  state.characterRoot = root;
  state.boneGroups = boneGroups;

  if (state.weaponPrefabId) attachWeapon(state, state.weaponPrefabId);
}

function attachWeapon(state: InternalState, weaponPrefabId: string): void {
  if (!state.weaponAnchor) return;
  while (state.weaponAnchor.children.length > 0) {
    const c = state.weaponAnchor.children[0];
    state.weaponAnchor.remove(c);
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      (c.material as THREE.Material).dispose();
    }
  }

  const prefab = state.content.prefabs.get(weaponPrefabId);
  if (!prefab?.modelId) return;
  const model = state.content.models.get(prefab.modelId);
  if (!model) return;

  const scale = prefab.modelScale ?? 1;
  const matsList = state.content.materials.values();
  const mats = new Map<number, MaterialDef>(matsList.map((m) => [m.id, m]));

  const weaponGroup = new THREE.Group();
  weaponGroup.scale.set(scale, scale, scale);
  for (const node of model.nodes) {
    weaponGroup.add(buildVoxel(node.x, node.y, node.z, node.materialId, mats, 1));
  }
  state.weaponAnchor.add(weaponGroup);
}

// ---- per-frame animation tick ----

function tickAnimation(state: InternalState, dtSeconds: number): void {
  if (!state.skeleton) return;

  const slotMap = state.prefabId
    ? (state.content.prefabs.get(state.prefabId)?.animationSlots ?? {})
    : {};
  const slot = (name: string): string => slotMap[name] ?? name;

  const locClipId = slot(state.locomotion);
  const locClip = state.clipIndex.get(locClipId);

  if (locClip) {
    const dur = locClip.durationSeconds && locClip.durationSeconds > 0
      ? locClip.durationSeconds
      : 1;
    const prev = state.timeByClip.get(locClipId) ?? 0;
    const next = prev + (state.speed * dtSeconds) / dur;
    state.timeByClip.set(locClipId, ((next % 1) + 1) % 1);
  }

  const layers: AnimationLayer[] = [];
  if (locClip) {
    layers.push({
      clipId: locClipId,
      maskId: "",
      time: state.timeByClip.get(locClipId) ?? 0,
      weight: 1,
      blend: "override",
      speedScale: 1,
    });
  }

  // Apply local Euler rotations directly to bone groups — same pattern as
  // animate/skeleton_view's applyPoseToView.  No solveSkeleton needed: the
  // three.js Group hierarchy multiplies through automatically.
  const rotations = evaluateAnimationLayers(state.skeleton, state.clipIndex, state.maskIndex, layers);
  // First reset every bone group to rest rotation (otherwise bones present in
  // the previous clip but absent in the current one keep stale rotations).
  for (const bg of state.boneGroups.values()) bg.rotation.set(0, 0, 0);
  for (const [boneId, rot] of rotations) {
    const bg = state.boneGroups.get(boneId);
    if (bg) bg.rotation.set(rot.x, rot.y, rot.z);
  }

  // Active swing — advance ticks; visual swing-path IK is a follow-up.
  if (state.swing) {
    const adv = state.speed * dtSeconds * 20;
    const next = state.swing.ticksIntoAction + adv;
    state.swing = next >= state.swing.totalTicks
      ? null
      : { ...state.swing, ticksIntoAction: next };
  }
}

// ---- voxel mesh helper ----

function buildVoxel(
  vx: number, vy: number, vz: number,
  matId: number,
  mats: Map<number, MaterialDef>,
  scale: number,
): THREE.Mesh {
  const md = mats.get(matId);
  const color = md?.color ?? 0x888888;
  const rough = md?.roughness ?? 0.8;
  const emi = md && md.emissive > 0
    ? new THREE.Color(color).multiplyScalar(md.emissive * 0.7)
    : new THREE.Color(0x000000);
  const shin = Math.round((1 - rough) * 80);

  const px = (vx + 0.5) * scale;
  const py = (vz + 0.5) * scale;
  const pz = (vy + 0.5) * scale;

  const geo = VOX_GEO.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, 0.10);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.scale(scale, scale, scale);

  const tex = getVoxelTexture(matId, color);
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    flatShading: true, shininess: shin, emissive: emi,
  }));
  mesh.position.set(px, py, pz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
