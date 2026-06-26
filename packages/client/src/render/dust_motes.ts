/// <reference lib="dom" />
/**
 * Ambient dust motes (T-310, phase E) — slow-drifting lit particles that give
 * the air volume and the world a sense of life. A single THREE.Points cloud of
 * soft round sprites, additively blended so the motes catch light and feed the
 * bloom bright-pass faintly. The cloud is parented to the camera target each
 * frame and the motes wrap inside a local box, so density around the player
 * stays constant no matter how far they roam. Because it lives in the scene it
 * is fogged with everything else — distant motes fade into the haze.
 */
import * as THREE from "three";

const COUNT = 320;
const BOX = 44;       // half-extent of the drift box around the camera target
const BOX_Y = 22;     // vertical half-extent (motes hang lower than they're wide)

/** Soft radial sprite — white core fading to transparent, so motes read round. */
function makeMoteSprite(): THREE.CanvasTexture {
  const s = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DustMotes {
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly vel: Float32Array;     // per-mote drift velocity
  private readonly phase: Float32Array;   // per-mote sway phase
  private readonly sprite: THREE.CanvasTexture;
  private t = 0;
  private seed = 1337;

  constructor(private readonly scene: THREE.Scene) {
    this.positions = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.phase = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this.positions[i * 3]     = (this.rand() * 2 - 1) * BOX;
      this.positions[i * 3 + 1] = this.rand() * BOX_Y * 2;
      this.positions[i * 3 + 2] = (this.rand() * 2 - 1) * BOX;
      this.vel[i * 3]     = (this.rand() * 2 - 1) * 0.25;
      this.vel[i * 3 + 1] = 0.1 + this.rand() * 0.25;   // slow rise
      this.vel[i * 3 + 2] = (this.rand() * 2 - 1) * 0.25;
      this.phase[i] = this.rand() * 6.2831853;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));

    this.sprite = makeMoteSprite();
    const mat = new THREE.PointsMaterial({
      size: 0.22,
      map: this.sprite,
      color: 0xffe8c4,            // warm pale — dust catching the sun
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;   // it follows the camera; never cull
    this.points.renderOrder = 2;
    this.scene.add(this.points);
  }

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) | 0;
    return ((this.seed >>> 8) & 0xffffff) / 0x1000000;
  }

  /** Drift the motes and keep the cloud centred on the player. */
  update(dtMs: number, target: THREE.Vector3): void {
    const dt = Math.min(dtMs, 100) / 1000;
    this.t += dt;
    for (let i = 0; i < COUNT; i++) {
      // drift + a gentle horizontal sway so motes don't move in straight lines
      const sway = Math.sin(this.t * 0.6 + this.phase[i]) * 0.15;
      let x = this.positions[i * 3]     + (this.vel[i * 3] + sway) * dt;
      let y = this.positions[i * 3 + 1] + this.vel[i * 3 + 1] * dt;
      let z = this.positions[i * 3 + 2] + this.vel[i * 3 + 2] * dt;
      // wrap inside the local box so density stays constant around the player
      if (x >  BOX) x -= BOX * 2; else if (x < -BOX) x += BOX * 2;
      if (z >  BOX) z -= BOX * 2; else if (z < -BOX) z += BOX * 2;
      if (y > BOX_Y * 2) y -= BOX_Y * 2;
      this.positions[i * 3]     = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    }
    (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    // Centre the box on the player; offset down so motes fill the air column.
    this.points.position.set(target.x, target.y - BOX_Y, target.z);
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.sprite.dispose();
  }
}
