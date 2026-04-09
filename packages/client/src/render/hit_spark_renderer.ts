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

export class HitSparkRenderer {
  private readonly sparks: Spark[] = [];
  private readonly posArr:   Float32Array;
  private readonly colorArr: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly points:   THREE.Points;

  constructor(scene: THREE.Scene) {
    this.posArr   = new Float32Array(MAX_SPARKS * 3);
    this.colorArr = new Float32Array(MAX_SPARKS * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.posArr,   3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color",    new THREE.BufferAttribute(this.colorArr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      size: 5,               // pixels — sizeAttenuation must be false for orthographic cameras
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthTest: false,      // overlay pass depth buffer contains blit-quad values, not scene depth
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, mat);
    this.points.layers.set(HITBOX_OVERLAY_LAYER);
    this.points.renderOrder = 999;
    scene.add(this.points);
  }

  /** Spawn a burst of sparks at a world-space position. */
  spawn(x: number, y: number, z: number): void {
    for (let i = 0; i < SPARKS_PER_HIT; i++) {
      if (this.sparks.length >= MAX_SPARKS) break;

      // Random direction in full sphere, biased slightly upward
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(1 - Math.random() * 1.6); // 0..~143° — upper hemisphere
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
      const sinPhi = Math.sin(phi);

      const maxLife = LIFETIME_MIN + Math.random() * (LIFETIME_MAX - LIFETIME_MIN);
      this.sparks.push({
        x, y, z,
        vx: sinPhi * Math.cos(theta) * speed,
        vy: sinPhi * Math.sin(theta) * speed,
        vz: Math.cos(phi) * speed + 0.5, // slight upward bias
        life: maxLife,
        maxLife,
      });
    }
  }

  /** Advance particle physics and rebuild GPU buffers. Call once per frame. */
  update(dt: number): void {
    // Integrate and cull dead sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
      s.vz += GRAVITY * dt;
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
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.parent?.remove(this.points);
  }
}
