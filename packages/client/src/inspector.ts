/// <reference lib="dom" />
/**
 * Swing Inspector — a standalone debug tool to step through melee swing
 * animations frame-by-frame and SEE the authoring: the skeleton pose, the blade
 * orientation, the arc the tip traces, where the active hit window fires, and
 * whether the blade actually sweeps through an enemy standing in front.
 *
 * Pure static page: it fetches the same content blob the game ships (no join /
 * WebTransport), runs the SAME FK the server uses (evaluateAnimationLayers +
 * solveSkeleton), and draws bones as lines — no voxel bake, so the pose + blade
 * are unobstructed.
 */
import * as THREE from "three";
import {
  BootstrapSource, evaluateAnimationLayers, solveSkeleton, applyQuat, solveSwingPose, applyLocomotionPose, applyCrouchPose,
} from "@voxim/content";
import type { ContentService, SkeletonDef, WeaponActionDef } from "@voxim/content";

const SKELETON_MODEL = "biped_skeletal";
const HOLD_BONE = "hand_r";
// Enemy reference box: standing in front (forward = -Z), body height.
const ENEMY = { fwd: 1.5, halfW: 0.6, yMin: 0.5, yMax: 3.5, depth: 0.9 };

// ---- load content -----------------------------------------------------------
const blob = new Uint8Array(await (await fetch("/dist/content.bin")).arrayBuffer());
const content: ContentService = await BootstrapSource.load(blob);
const skeleton: SkeletonDef = content.getSkeletonForModel(SKELETON_MODEL)!;
const clipIndex = content.getClipIndex(skeleton.id);
const maskIndex = content.getMaskIndex(skeleton.id);
const boneIndex = content.getBoneIndex(skeleton.id);
const weaponActions: WeaponActionDef[] = [...content.weaponActions.values()]
  .filter((w) => !!w.swingPath || (!!w.blade && clipIndex.has(w.clipId ?? "")))
  .sort((a, b) => a.id.localeCompare(b.id));

// ---- three.js scene ---------------------------------------------------------
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xbcd0e0, 0x20242c, 1.1));
const grid = new THREE.GridHelper(16, 16, 0x39414d, 0x252b33);
scene.add(grid);

// Enemy box in front.
{
  const g = new THREE.BoxGeometry(ENEMY.halfW * 2, ENEMY.yMax - ENEMY.yMin, ENEMY.depth);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x6c1f1c, transparent: true, opacity: 0.28 }));
  m.position.set(0, (ENEMY.yMin + ENEMY.yMax) / 2, -ENEMY.fwd);
  scene.add(m);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xb24a40 }));
  e.position.copy(m.position);
  scene.add(e);
}
// "forward" arrow (the way the character faces / the enemy is).
scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.05, 0), ENEMY.fwd + 0.6, 0x4a6b3c, 0.4, 0.25));

// Skeleton: one LineSegments for bone segments + a Points cloud for joints.
const boneList = skeleton.bones;
const segPairs = boneList.filter((b) => b.parent !== null);
const segGeo = new THREE.BufferGeometry();
segGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segPairs.length * 6), 3));
const segLines = new THREE.LineSegments(segGeo, new THREE.LineBasicMaterial({ color: 0x9fb4c8 }));
scene.add(segLines);
const jointGeo = new THREE.BufferGeometry();
jointGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(boneList.length * 3), 3));
scene.add(new THREE.Points(jointGeo, new THREE.PointsMaterial({ color: 0xe6e8ec, size: 0.12 })));

// Blade: a thin box from base to tip.
const blade = new THREE.Mesh(
  new THREE.BoxGeometry(0.07, 0.07, 1),
  new THREE.MeshBasicMaterial({ color: 0xd97826 }),
);
scene.add(blade);

// Authored-swing extras: a marker at the hilt (where the arm's wrist must
// reach) and a dashed guide line hand → hilt (the reach the IK will close).
const hiltDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0x39d7c0 }),
);
hiltDot.visible = false;
scene.add(hiltDot);
const guideGeo = new THREE.BufferGeometry();
guideGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
const guide = new THREE.Line(guideGeo, new THREE.LineDashedMaterial({ color: 0x39d7c0, dashSize: 0.15, gapSize: 0.1 }));
guide.visible = false;
scene.add(guide);

// Tip arc — the full path the blade tip traces over the whole clip, sampled
// once per clip so you see the entire swing shape at a glance.
const ARC = 64;
const arcPts = new Float32Array(ARC * 3);
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute("position", new THREE.BufferAttribute(arcPts, 3));
scene.add(new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0x5a7fb0 })));

// ---- authored swing sampling ------------------------------------------------
type V3 = { x: number; y: number; z: number };
// actor-local {fwd,right,up} → inspector world {x:right, y:up, z:-fwd}.
const toWorld = (p: { fwd: number; right: number; up: number }): V3 => ({ x: p.right, y: p.up, z: -p.fwd });

// Sample the authored swingPath at normalised t → world-space hilt + tip.
function sampleSwing(t: number): { hilt: V3; tip: V3 } | null {
  const sp = curWA.swingPath;
  if (!sp || sp.keyframes.length === 0) return null;
  const kf = sp.keyframes;
  let a = kf[0], b = kf[kf.length - 1];
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= kf[i].t && t <= kf[i + 1].t) { a = kf[i]; b = kf[i + 1]; break; }
  }
  const span = b.t - a.t;
  const f = span > 1e-6 ? (t - a.t) / span : 0;
  const lp = (x: number, y: number) => x + (y - x) * f;
  const hilt = { fwd: lp(a.hilt.fwd, b.hilt.fwd), right: lp(a.hilt.right, b.hilt.right), up: lp(a.hilt.up, b.hilt.up) };
  const bd = { fwd: lp(a.blade.fwd, b.blade.fwd), right: lp(a.blade.right, b.blade.right), up: lp(a.blade.up, b.blade.up) };
  const m = Math.hypot(bd.fwd, bd.right, bd.up) || 1;
  const tip = { fwd: hilt.fwd + (bd.fwd / m) * sp.length, right: hilt.right + (bd.right / m) * sp.length, up: hilt.up + (bd.up / m) * sp.length };
  return { hilt: toWorld(hilt), tip: toWorld(tip) };
}

// ---- pose evaluation --------------------------------------------------------
// Default to a swing that has an authored path (the new thing under design),
// else a real clip swing, else whatever sorts first.
let curWA: WeaponActionDef = weaponActions.find((w) => w.swingPath)
  ?? weaponActions.find((w) => /^(slash|swing|overhead|thrust|heavy)/.test(w.id))
  ?? weaponActions[0];
let useAuthored = !!curWA.swingPath;

function inBox(p: V3): boolean {
  return -p.z > ENEMY.fwd - ENEMY.depth / 2 && -p.z < ENEMY.fwd + ENEMY.depth / 2 &&
    p.y > ENEMY.yMin && p.y < ENEMY.yMax && Math.abs(p.x) < ENEMY.halfW + 0.3;
}

// Orient + scale the blade box so it spans base→tip.
function placeBlade(base: V3, tip: V3) {
  const bv = new THREE.Vector3(base.x, base.y, base.z);
  const tv = new THREE.Vector3(tip.x, tip.y, tip.z);
  blade.position.copy(bv).add(tv).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(tv, bv);
  blade.scale.set(1, 1, Math.max(0.01, dir.length()));
  blade.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
}

function buildArc() {
  for (let i = 0; i < ARC; i++) {
    const t = i / (ARC - 1);
    if (useAuthored) {
      const s = sampleSwing(t);
      if (s) arcPts.set([s.tip.x, s.tip.y, s.tip.z], i * 3);
      continue;
    }
    const rot = evaluateAnimationLayers(skeleton, clipIndex, maskIndex, [{ clipId: curWA.clipId ?? "", maskId: "", time: t, weight: 1, blend: "override" as const, speedScale: 1 }]);
    const tf = solveSkeleton(skeleton, boneIndex, rot, 1, undefined);
    const hand = tf.get(curWA.holdHand ?? HOLD_BONE);
    if (hand && curWA.blade) {
      const tt = applyQuat({ x: curWA.blade.tipLocal[0], y: curWA.blade.tipLocal[1], z: curWA.blade.tipLocal[2] }, hand.rot);
      arcPts.set([hand.pos.x + tt.x, hand.pos.y + tt.y, hand.pos.z + tt.z], i * 3);
    }
  }
  arcGeo.getAttribute("position").needsUpdate = true;
}

function setPose(t: number) {
  // Pose: authored mode runs the procedural full-body swing producer (spine
  // twist+lean, weapon-arm IK onto the hilt, off-hand counter); clip mode plays
  // the Mixamo clip that currently drives the game.
  let tf;
  if (useAuthored) {
    // Fused pipeline: crouch (legs + pelvis drop) → locomotion lean → swing
    // overlay + IK, all on one skeleton. The pelvis drop is a root translation.
    const dropY = crouch * CROUCH_DROP;
    let rot = applyCrouchPose(skeleton, boneIndex, new Map(), 1, dropY);
    rot = applyLocomotionPose(skeleton, boneIndex, rot, 1, { strafe, turn });
    rot = solveSwingPose(skeleton, boneIndex, rot, 1, curWA.swingPath!, t, {});
    tf = solveSkeleton(skeleton, boneIndex, rot, 1, undefined, undefined, dropY > 1e-4 ? { x: 0, y: -dropY, z: 0 } : undefined);
  } else {
    tf = solveSkeleton(skeleton, boneIndex, evaluateAnimationLayers(skeleton, clipIndex, maskIndex, [{ clipId: curWA.clipId ?? "", maskId: "", time: t, weight: 1, blend: "override" as const, speedScale: 1 }]), 1, undefined);
  }

  // bone segments + joints
  const segPos = segGeo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < segPairs.length; i++) {
    const b = segPairs[i];
    const p = tf.get(b.parent!)?.pos, c = tf.get(b.id)?.pos;
    if (p && c) { segPos.setXYZ(i * 2, p.x, p.y, p.z); segPos.setXYZ(i * 2 + 1, c.x, c.y, c.z); }
  }
  segPos.needsUpdate = true;
  const jPos = jointGeo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < boneList.length; i++) { const p = tf.get(boneList[i].id)?.pos; if (p) jPos.setXYZ(i, p.x, p.y, p.z); }
  jPos.needsUpdate = true;

  let fwd = 0, height = 0, hits = false, gap = 0;
  const hand = tf.get(curWA.holdHand ?? HOLD_BONE);
  if (useAuthored && hand) {
    // Real attached blade: from the IK'd hand, along its +Y (the weapon axis).
    const ln = curWA.swingPath!.length;
    const axis = applyQuat({ x: 0, y: 1, z: 0 }, hand.rot);
    const base = { x: hand.pos.x, y: hand.pos.y, z: hand.pos.z };
    const tip = { x: hand.pos.x + axis.x * ln, y: hand.pos.y + axis.y * ln, z: hand.pos.z + axis.z * ln };
    placeBlade(base, tip);
    // Authored hilt target + the gap the fist fell short by (over-reach clamp).
    const s = sampleSwing(t)!;
    hiltDot.position.set(s.hilt.x, s.hilt.y, s.hilt.z);
    const gp = guideGeo.getAttribute("position") as THREE.BufferAttribute;
    gp.setXYZ(0, hand.pos.x, hand.pos.y, hand.pos.z); gp.setXYZ(1, s.hilt.x, s.hilt.y, s.hilt.z); gp.needsUpdate = true;
    guide.computeLineDistances();
    gap = Math.hypot(hand.pos.x - s.hilt.x, hand.pos.y - s.hilt.y, hand.pos.z - s.hilt.z);
    fwd = -tip.z; height = tip.y;
    hits = inBox(tip) || inBox(base) || inBox({ x: (tip.x + base.x) / 2, y: (tip.y + base.y) / 2, z: (tip.z + base.z) / 2 });
  } else if (hand && curWA.blade) {
    const bl = curWA.blade;
    const bt = applyQuat({ x: bl.baseLocal[0], y: bl.baseLocal[1], z: bl.baseLocal[2] }, hand.rot);
    const tt = applyQuat({ x: bl.tipLocal[0], y: bl.tipLocal[1], z: bl.tipLocal[2] }, hand.rot);
    const base = { x: hand.pos.x + bt.x, y: hand.pos.y + bt.y, z: hand.pos.z + bt.z };
    const tip = { x: hand.pos.x + tt.x, y: hand.pos.y + tt.y, z: hand.pos.z + tt.z };
    placeBlade(base, tip);
    fwd = -tip.z; height = tip.y;
    hits = inBox(tip) || inBox(base) || inBox({ x: (tip.x + base.x) / 2, y: (tip.y + base.y) / 2, z: (tip.z + base.z) / 2 });
  }
  hiltDot.visible = useAuthored && gap > 0.03;
  guide.visible = useAuthored && gap > 0.03;

  // active-window flash
  const tot = curWA.windupTicks + curWA.activeTicks + curWA.winddownTicks;
  const inWin = t >= curWA.windupTicks / tot && t <= (curWA.windupTicks + curWA.activeTicks) / tot;
  (blade.material as THREE.MeshBasicMaterial).color.setHex(inWin ? 0xee5533 : 0xd97826);

  // UI readout
  q("#fwd")!.textContent = fwd.toFixed(2);
  q("#hgt")!.textContent = height.toFixed(2);
  const win = q("#inwin")!; win.textContent = inWin ? "YES (hit fires)" : "no"; win.className = inWin ? "hit" : "";
  const h = q("#hits")!; h.textContent = hits ? "HIT ✓" : "miss"; h.className = hits ? "hit" : "miss";
  q("#tval")!.textContent = t.toFixed(3);
  q("#frame")!.textContent = useAuthored
    ? `procedural swing${gap > 0.05 ? ` · ⚠ over-reach ${gap.toFixed(2)}` : ""}`
    : `clip: ${curWA.clipId ?? "—"}`;
}

// ---- camera presets ---------------------------------------------------------
function setCam(preset: string) {
  const look = new THREE.Vector3(0, 2.4, 0);
  const pos: Record<string, [number, number, number]> = {
    side: [11, 2.6, 0], front: [0, 2.6, -11], top: [0, 13, -0.01], iso: [8, 7, -8],
  };
  const [x, y, z] = pos[preset] ?? pos.side;
  camera.position.set(x, y, z); camera.lookAt(look);
}

// ---- UI ---------------------------------------------------------------------
function q(s: string) { return document.querySelector(s) as HTMLElement | null; }
const waSel = q("#wa") as HTMLSelectElement;
for (const w of weaponActions) {
  const o = document.createElement("option");
  o.value = w.id; o.textContent = w.swingPath ? `✦ ${w.id}  (authored)` : `${w.id}  (${w.clipId})`;
  waSel.appendChild(o);
}
waSel.value = curWA.id;
let t = 0, playing = false, speed = 1;
let strafe = 0, turn = 0, crouch = 0;
const CROUCH_DROP = 0.9; // pelvis drop (solver units) at full crouch
const tSlider = q("#t") as HTMLInputElement;
const STEP = 1 / 30;

// Locomotion + crouch controls — the base-pose catalogue composing live with the swing.
{
  const panel = waSel.parentElement ?? document.body;
  const mk = (label: string, min: number, set: (v: number) => void) => {
    const row = document.createElement("div");
    row.style.cssText = "margin-top:6px;font-size:12px;color:#9fb4c8;display:flex;align-items:center;gap:8px";
    const lab = document.createElement("span"); lab.textContent = label; lab.style.width = "44px"; row.appendChild(lab);
    const sl = document.createElement("input");
    sl.type = "range"; sl.min = String(min); sl.max = "1"; sl.step = "0.05"; sl.value = "0"; sl.style.flex = "1";
    sl.oninput = () => { set(parseFloat(sl.value)); setPose(t); };
    row.appendChild(sl); panel.appendChild(row);
  };
  mk("strafe", -1, (v) => { strafe = v; });
  mk("turn", -1, (v) => { turn = v; });
  mk("crouch", 0, (v) => { crouch = v; });
}

waSel.onchange = () => { curWA = weaponActions.find((w) => w.id === waSel.value)!; useAuthored = !!curWA.swingPath; buildArc(); setPose(t); };
tSlider.oninput = () => { t = parseFloat(tSlider.value); setPose(t); };
q("#stepf")!.onclick = () => { t = Math.min(1, t + STEP); tSlider.value = String(t); setPose(t); };
q("#stepb")!.onclick = () => { t = Math.max(0, t - STEP); tSlider.value = String(t); setPose(t); };
q("#play")!.onclick = () => { playing = !playing; q("#play")!.textContent = playing ? "❚❚ pause" : "▶ play"; q("#play")!.classList.toggle("on", playing); };
document.querySelectorAll<HTMLButtonElement>("[data-spd]").forEach((b) => b.onclick = () => {
  speed = parseFloat(b.dataset.spd!); document.querySelectorAll("[data-spd]").forEach((x) => x.classList.remove("on")); b.classList.add("on");
});
document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => b.onclick = () => {
  setCam(b.dataset.cam!); document.querySelectorAll("[data-cam]").forEach((x) => x.classList.remove("on")); b.classList.add("on");
});
addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") (q("#stepf") as HTMLButtonElement).click();
  else if (e.key === "ArrowLeft") (q("#stepb") as HTMLButtonElement).click();
  else if (e.key === " ") { e.preventDefault(); (q("#play") as HTMLButtonElement).click(); }
  // 'a' toggles authored swingPath ↔ Mixamo clip for the SAME action, so you
  // can A/B the clean authored arc against the borrowed full-body flail.
  else if (e.key === "a" || e.key === "A") {
    if (curWA.swingPath) { useAuthored = !useAuthored; buildArc(); setPose(t); }
  }
});

// ---- loop -------------------------------------------------------------------
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); resize(); setCam("side");
let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000; last = now;
  if (playing) { t = (t + dt * speed * 0.6) % 1; tSlider.value = String(t); setPose(t); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
buildArc();
setPose(0);
requestAnimationFrame(frame);
