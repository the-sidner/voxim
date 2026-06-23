/// <reference lib="dom" />
/**
 * EnvironmentLighting — the sun + hemisphere ambient + sky/fog + day-night
 * phase interpolation, extracted from VoximRenderer (T-282, Phase 2). Owns the
 * directional sun (with its shadow camera + the basis vectors used to snap the
 * shadow frustum), the visible sun disc, the hemisphere fill, and the scene's
 * fog + background. The renderer drives it once per frame with
 * `update(cameraTarget, cameraPos)` after the camera has settled — the lerp
 * toward the current phase target plus the shadow-frustum follow/snap and the
 * sky-locked sun disc.
 *
 * This is distinct from LightManager (per-entity point lights / torches) — that
 * stays renderer-injected and is unrelated to the environment.
 */
import * as THREE from "three";
import type { Palette } from "@voxim/content";

/** Lighting definition for a given time-of-day phase. */
interface DayPhaseLight {
  sky: THREE.Color; fog: THREE.Color; sun: THREE.Color;
  sunIntensity: number; hemiIntensity: number; fogFar: number;
}

function makePhaseLights(): Record<string, DayPhaseLight> {
  return {
    noon:     { sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc), sun: new THREE.Color(0xfffde0), sunIntensity: 2.5,  hemiIntensity: 0.25, fogFar: 220 },
    dawn:     { sky: new THREE.Color(0xd8846a), fog: new THREE.Color(0xb06848), sun: new THREE.Color(0xffb060), sunIntensity: 1.4,  hemiIntensity: 0.14, fogFar: 160 },
    dusk:     { sky: new THREE.Color(0xa04828), fog: new THREE.Color(0x883820), sun: new THREE.Color(0xff7030), sunIntensity: 1.1,  hemiIntensity: 0.11, fogFar: 150 },
    midnight: { sky: new THREE.Color(0x08091a), fog: new THREE.Color(0x060714), sun: new THREE.Color(0x2030a0), sunIntensity: 0.06, hemiIntensity: 0.04, fogFar: 100 },
  };
}

/**
 * Build the day-night phase lights from the content palette (T-280) — replaces
 * the hardcoded cyan-sky defaults in makePhaseLights with the ash-hazed `phases`
 * block. Starts from the defaults so a palette missing a phase still resolves.
 */
function buildPhaseLights(palette: Palette): Record<string, DayPhaseLight> {
  const col = (h: string) => new THREE.Color(parseInt(h.replace("#", ""), 16) >>> 0);
  const out = makePhaseLights();
  for (const [name, p] of Object.entries(palette.phases)) {
    out[name] = {
      sky: col(p.sky), fog: col(p.fog), sun: col(p.sun),
      sunIntensity: p.sunIntensity, hemiIntensity: p.hemiIntensity, fogFar: p.fogFar,
    };
  }
  return out;
}

/** Lerp a number toward target, returning new value. */
function lerpN(a: number, b: number, t: number): number { return a + (b - a) * t; }

/**
 * Normalized direction FROM the world origin TOWARD the sun.
 * Used for both the DirectionalLight position and the visible sun sphere.
 */
const SUN_DIR = new THREE.Vector3(20, 100, -15).normalize();

export class EnvironmentLighting {
  /** Directional sun — its target tracks the camera center each frame. */
  private readonly sun: THREE.DirectionalLight;
  /**
   * Shadow camera basis vectors (pre-computed from the fixed SUN_DIR).
   * Used to snap the shadow frustum in shadow-UV space rather than world X/Z —
   * world-axis snapping leaves residual swimming along the perpendicular axis
   * whenever the shadow camera isn't aligned with the world grid.
   */
  private readonly _shadowCamRight: THREE.Vector3;
  private readonly _shadowCamUp: THREE.Vector3;
  /** Visible sun disc in the sky. */
  private readonly sunMesh: THREE.Mesh;
  /** Hemisphere sky/ground ambient. */
  private readonly hemi: THREE.HemisphereLight;

  private phaseLights = makePhaseLights();
  /** Current interpolated lighting values (mutated every frame). */
  private readonly lightCur: DayPhaseLight = {
    sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc),
    sun: new THREE.Color(0xfffde0), sunIntensity: 2.5, hemiIntensity: 0.25, fogFar: 220,
  };
  /** Target lighting values set by setPhase(). */
  private readonly lightTgt: DayPhaseLight = {
    sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc),
    sun: new THREE.Color(0xfffde0), sunIntensity: 2.5, hemiIntensity: 0.25, fogFar: 220,
  };

  constructor(private readonly scene: THREE.Scene) {
    // ---- lighting ----
    // Strong directional sun — dominates shading so flat-shaded faces read clearly.
    this.sun = new THREE.DirectionalLight(0xfffde0, 2.5);
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near   = 0.5;
    this.sun.shadow.camera.far    = 400;
    this.sun.shadow.camera.left   = -60;
    this.sun.shadow.camera.right  =  60;
    this.sun.shadow.camera.top    =  60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.bias = -0.001; // prevent self-shadow acne on flat faces
    this.scene.add(this.sun);
    // Target must be in the scene so Three.js updates its world matrix each frame.
    this.scene.add(this.sun.target);

    // Pre-compute shadow camera basis vectors from the fixed SUN_DIR.
    // Three.js lookAt: camLocalZ = normalize(eye - target) = SUN_DIR.
    // camLocalX = normalize(cross(worldUp, SUN_DIR)); camLocalY = cross(SUN_DIR, camLocalX).
    // Snapping in these axes (not world X/Z) eliminates shadow swimming on non-axis geometry.
    {
      const up = new THREE.Vector3(0, 1, 0);
      this._shadowCamRight = new THREE.Vector3().crossVectors(up, SUN_DIR).normalize();
      this._shadowCamUp    = new THREE.Vector3().crossVectors(SUN_DIR, this._shadowCamRight).normalize();
    }

    // Ambient fill — brightened so shadowed cliff walls are readable, not black voids.
    this.hemi = new THREE.HemisphereLight(0x99bbdd, 0x334433, 0.55);
    this.scene.add(this.hemi);

    // ---- visible sun sphere ----
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(10, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfffce0 }),
    );
    this.scene.add(this.sunMesh);

    // ---- sky ----
    this.scene.fog = new THREE.Fog(0x7aa4cc, 80, 220);
    this.scene.background = new THREE.Color(0x7aa4cc);
  }

  /**
   * Swap the day-night phase lights to the content palette (T-280) and prime the
   * scene's hemisphere/background/fog to noon. The per-frame update reads
   * phaseLights fresh, so the swap takes effect immediately.
   */
  applyPalette(palette: Palette): void {
    this.phaseLights = buildPhaseLights(palette);
    this.hemi.color.copy(this.phaseLights.noon.sky);
    (this.scene.background as THREE.Color).copy(this.phaseLights.noon.sky);
    (this.scene.fog as THREE.Fog).color.copy(this.phaseLights.noon.fog);
  }

  /** Set the target lighting for a named day phase (lerped toward each frame). */
  setPhase(phase: string): void {
    const p = this.phaseLights[phase] ?? this.phaseLights.noon;
    this.lightTgt.sky.copy(p.sky);
    this.lightTgt.fog.copy(p.fog);
    this.lightTgt.sun.copy(p.sun);
    this.lightTgt.sunIntensity = p.sunIntensity;
    this.lightTgt.hemiIntensity = p.hemiIntensity;
    this.lightTgt.fogFar = p.fogFar;
  }

  /** Toggle sun shadow casting (debug). Returns the new state. */
  toggleShadows(): boolean {
    this.sun.castShadow = !this.sun.castShadow;
    return this.sun.castShadow;
  }

  /**
   * Per-frame: lerp the current lighting toward the phase target and apply it to
   * the sun/hemi/sky/fog, then keep the shadow frustum centered on the camera
   * target (texel-snapped to kill swimming) and the sun disc fixed in the sky
   * relative to the camera. Called after the camera has settled for the frame.
   */
  update(cameraTarget: THREE.Vector3, cameraPos: THREE.Vector3): void {
    // Smoothly transition day/night lighting (per-frame lerp toward target)
    const L = 0.015; // lerp speed — full transition over ~4 s at 60 fps
    this.lightCur.sky.lerp(this.lightTgt.sky, L);
    this.lightCur.fog.lerp(this.lightTgt.fog, L);
    this.lightCur.sun.lerp(this.lightTgt.sun, L);
    this.lightCur.sunIntensity  = lerpN(this.lightCur.sunIntensity,  this.lightTgt.sunIntensity,  L);
    this.lightCur.hemiIntensity = lerpN(this.lightCur.hemiIntensity, this.lightTgt.hemiIntensity, L);
    this.lightCur.fogFar        = lerpN(this.lightCur.fogFar,        this.lightTgt.fogFar,        L);
    (this.scene.background as THREE.Color).copy(this.lightCur.sky);
    (this.scene.fog as THREE.Fog).color.copy(this.lightCur.fog);
    (this.scene.fog as THREE.Fog).far = this.lightCur.fogFar;
    this.sun.color.copy(this.lightCur.sun);
    this.sun.intensity   = this.lightCur.sunIntensity;
    this.hemi.intensity  = this.lightCur.hemiIntensity;
    this.sunMesh.visible = this.lightCur.sunIntensity > 0.15;

    // Keep sun shadow frustum centered on the player area.
    // Both position and target must move together — only the direction between
    // them (SUN_DIR) defines where shadows fall, not the absolute world position.
    this.sun.target.position.copy(cameraTarget);
    this.sun.position.copy(cameraTarget).addScaledVector(SUN_DIR, 100);

    // Snap shadow frustum to its own texel grid (in shadow-camera UV space) to
    // eliminate shadow swimming.  Snapping in world X/Z leaves residual drift
    // along the axes not aligned with the shadow camera — visible on tall objects
    // like trees.  Projecting onto the shadow camera's right/up vectors and
    // rounding there keeps the shadow projection pixel-stable in all directions.
    {
      const sc = this.sun.shadow.camera;
      const texelX = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
      const texelY = (sc.top   - sc.bottom) / this.sun.shadow.mapSize.y;

      const t   = this.sun.target.position;
      const dotX = t.dot(this._shadowCamRight);
      const dotY = t.dot(this._shadowCamUp);

      const snapX = Math.round(dotX / texelX) * texelX - dotX;
      const snapY = Math.round(dotY / texelY) * texelY - dotY;

      const cx = this._shadowCamRight.x * snapX + this._shadowCamUp.x * snapY;
      const cy = this._shadowCamRight.y * snapX + this._shadowCamUp.y * snapY;
      const cz = this._shadowCamRight.z * snapX + this._shadowCamUp.z * snapY;

      this.sun.target.position.x += cx;
      this.sun.target.position.y += cy;
      this.sun.target.position.z += cz;
      this.sun.position.x += cx;
      this.sun.position.y += cy;
      this.sun.position.z += cz;
    }

    // Keep the sun sphere fixed in the sky relative to the camera
    this.sunMesh.position
      .copy(cameraPos)
      .addScaledVector(SUN_DIR, 350);
  }
}
