/**
 * HitSparkRenderer — particle burst at melee contact points.
 *
 * Spawns 10 short-lived particles at the world-space hit location.
 * Particles fly outward in a random hemisphere, decelerate under gravity,
 * and fade from bright yellow-white to orange as they die.
 *
 * Rendered in the overlay pass (same layer as hitbox debug) so they appear
 * crisp on top of the pixel-art game world.
 */
import * as THREE from "three";
import { HITBOX_OVERLAY_LAYER } from "./hitbox_debug_overlay.ts";

/** Soft round sprite (white core → transparent) so sparks read as glowing points
 *  instead of hard squares. Additive blending turns the core white-hot. */
function makeSparkSprite(): THREE.CanvasTexture {
  const s = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SPARKS_PER_HIT = 10;
const MAX_SPARKS     = 256;
const GRAVITY        = -12;   // world units / s²
const LIFETIME_MIN   = 0.18;  // seconds
const LIFETIME_MAX   = 0.32;
const SPEED_MIN      = 1.5;   // world units / s
const SPEED_MAX      = 4.0;

interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
}

const FLASH_POOL    = 8;
const FLASH_LIFE    = 0.16;  // seconds
const FLASH_MIN_SCALE = 0.4;
const FLASH_MAX_SCALE = 2.6;

interface Flash {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  life: number;   // remaining; <= 0 = free
}

export class HitSparkRenderer {
  private readonly sparks: Spark[] = [];
  private readonly posArr:   Float32Array;
  private readonly colorArr: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly points:   THREE.Points;
  private readonly sprite:   THREE.CanvasTexture;
  private readonly flashes:  Flash[] = [];

  constructor(scene: THREE.Scene) {
    this.posArr   = new Float32Array(MAX_SPARKS * 3);
    this.colorArr = new Float32Array(MAX_SPARKS * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.posArr,   3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color",    new THREE.BufferAttribute(this.colorArr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);

    this.sprite = makeSparkSprite();
    const mat = new THREE.PointsMaterial({
      size: 7,               // screen pixels (sizeAttenuation off — sparks are HUD-crisp)
      sizeAttenuation: false,
      map: this.sprite,      // soft round sprite → glowing points, not hard squares
      vertexColors: true,
      transparent: true,
      depthTest: false,      // overlay pass depth buffer contains blit-quad values, not scene depth
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, mat);
    this.points.layers.set(HITBOX_OVERLAY_LAYER);
    this.points.renderOrder = 999;
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Impact-flash pool: soft additive billboards that pop + expand + fade on
    // each hit for a sense of weight. Each gets its own material so opacity
    // animates independently.
    for (let i = 0; i < FLASH_POOL; i++) {
      const fmat = new THREE.SpriteMaterial({
        map: this.sprite,
        color: 0xffe6b0,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(fmat);
      sprite.layers.set(HITBOX_OVERLAY_LAYER);
      sprite.renderOrder = 998;
      sprite.frustumCulled = false;
      sprite.visible = false;
      scene.add(sprite);
      this.flashes.push({ sprite, mat: fmat, life: 0 });
    }
  }

  /**
   * Spawn sparks at a server world-space position.
   * Converts server coords (x=east, y=north, z=up) to Three.js (x=east, y=up, z=north).
   * Matches the posBuffer push in entity_mesh.ts: { x: pos.x, y: pos.z, z: pos.y }.
   */
  spawn(serverX: number, serverY: number, serverZ: number): void {
    const tx = serverX;
    const ty = serverZ;  // server z (up)   → Three.js y
    const tz = serverY;  // server y (north) → Three.js z
    for (let i = 0; i < SPARKS_PER_HIT; i++) {
      if (this.sparks.length >= MAX_SPARKS) break;

      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(1 - Math.random() * 1.6);
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
      const sinPhi = Math.sin(phi);

      const maxLife = LIFETIME_MIN + Math.random() * (LIFETIME_MAX - LIFETIME_MIN);
      this.sparks.push({
        x: tx, y: ty, z: tz,
        vx: sinPhi * Math.cos(theta) * speed,
        vy: Math.cos(phi) * speed + 0.5,  // upward in Three.js y
        vz: sinPhi * Math.sin(theta) * speed,
        life: maxLife,
        maxLife,
      });
    }

    // One impact flash per hit, from the pool (skip if all are busy).
    const flash = this.flashes.find((f) => f.life <= 0);
    if (flash) {
      flash.life = FLASH_LIFE;
      flash.sprite.position.set(tx, ty, tz);
      flash.sprite.scale.set(FLASH_MIN_SCALE, FLASH_MIN_SCALE, 1);
      flash.sprite.visible = true;
    }
  }

  /** Advance particle physics and rebuild GPU buffers. Call once per frame. */
  update(dt: number): void {
    // Integrate and cull dead sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
      s.vy += GRAVITY * dt;  // gravity pulls down in Three.js y
      s.x  += s.vx * dt;
      s.y  += s.vy * dt;
      s.z  += s.vz * dt;
    }

    const count = this.sparks.length;
    for (let i = 0; i < count; i++) {
      const s = this.sparks[i];
      const t = s.life / s.maxLife; // 1 → 0 as spark ages

      this.posArr[i * 3 + 0] = s.x;
      this.posArr[i * 3 + 1] = s.y;
      this.posArr[i * 3 + 2] = s.z;

      // Colour: white-yellow at birth → orange → dim red at death
      this.colorArr[i * 3 + 0] = 1.0;                             // R always 1
      this.colorArr[i * 3 + 1] = t > 0.5 ? 1.0 : t * 2.0;       // G: white→orange
      this.colorArr[i * 3 + 2] = t > 0.7 ? 1.0 - t * 0.7 : 0.0; // B: faint white tinge early
    }

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, count);

    // Animate impact flashes: expand from small to large while fading out.
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sprite.visible = false; f.mat.opacity = 0; continue; }
      const tt   = f.life / FLASH_LIFE;                 // 1 → 0
      const grow = 1.0 - tt;                            // 0 → 1
      const s    = FLASH_MIN_SCALE + (FLASH_MAX_SCALE - FLASH_MIN_SCALE) * grow;
      f.sprite.scale.set(s, s, 1);
      f.mat.opacity = tt * 0.9;                         // bright at birth → 0
    }
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const f of this.flashes) {
      f.sprite.parent?.remove(f.sprite);
      f.mat.dispose();
    }
    this.sprite.dispose();
    this.points.parent?.remove(this.points);
  }
}
