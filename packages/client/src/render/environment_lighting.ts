/// <reference lib="dom" />
/**
 * EnvironmentLighting — the sun + hemisphere ambient + sky/fog + day-night
 * phase interpolation, extracted from VoximRenderer (T-282, Phase 2). Owns the
 * directional sun (with its shadow camera + the basis vectors used to snap the
 * shadow frustum), the visible sun disc, the hemisphere fill, and the scene's
 * fog + background. The renderer drives it once per frame with
 * `update(cameraTarget, cameraPos, timeOfDay01)` after the camera has settled
 * — the lerp toward the current phase target plus the shadow-frustum
 * follow/snap and the sky-locked sun disc.
 *
 * This is distinct from LightManager (per-entity point lights / torches) — that
 * stays renderer-injected and is unrelated to the environment.
 *
 * T-311 P5a: the sun direction is no longer a fixed constant. It's the
 * server's WorldClock time-of-day fed through `sunArc()` (content, pure) each
 * frame — "server-authoritative" means driven by the server's clock, nothing
 * else (the wire carries WorldClock data; the client derives the direction).
 * `AtmosphereDef.sunArc` supplies the path params; day/night COLOUR stays on
 * `Palette.phases` (unchanged) — this phase only replaces the direction axis.
 */
import * as THREE from "three";
import type { Palette, AtmosphereDef } from "@voxim/content";
import { sunArc, type SunArcParams } from "@voxim/content";

/** Lighting definition for a given time-of-day phase. */
interface DayPhaseLight {
  sky: THREE.Color; fog: THREE.Color; sun: THREE.Color; hemiGround: THREE.Color;
  sunIntensity: number; hemiIntensity: number; fogFar: number;
}

/**
 * Build the day-night phase lights from the content palette (T-280/T-288). The
 * palette is the SOLE authority — there is no hardcoded fallback table (the old
 * cyan-sky defaults contradicted the palette and suppressed the art sweep). A
 * phase's `hemiGround` drives the ambient bounce on shadowed faces; it falls
 * back to a darkened sky only if a phase omits it. Fails loud if the `noon`
 * anchor (every consumer's fallback) is missing.
 */
function buildPhaseLights(palette: Palette): Record<string, DayPhaseLight> {
  const col = (h: string) => new THREE.Color(parseInt(h.replace("#", ""), 16) >>> 0);
  const out: Record<string, DayPhaseLight> = {};
  for (const [name, p] of Object.entries(palette.phases)) {
    out[name] = {
      sky: col(p.sky), fog: col(p.fog), sun: col(p.sun),
      hemiGround: p.hemiGround ? col(p.hemiGround) : col(p.sky).multiplyScalar(0.4),
      sunIntensity: p.sunIntensity, hemiIntensity: p.hemiIntensity, fogFar: p.fogFar,
    };
  }
  if (!out.noon) {
    throw new Error("palette.phases.noon missing — the day-night system has no anchor phase");
  }
  return out;
}

/** Neutral placeholder phase — the lerp state before applyPalette snaps it to noon. */
function neutralPhase(): DayPhaseLight {
  return {
    sky: new THREE.Color(0x808080), fog: new THREE.Color(0x808080), sun: new THREE.Color(0xffffff),
    hemiGround: new THREE.Color(0x404040), sunIntensity: 2.0, hemiIntensity: 0.4, fogFar: 220,
  };
}

/** Copy all fields of one phase into another (in place). */
function copyPhase(dst: DayPhaseLight, src: DayPhaseLight): void {
  dst.sky.copy(src.sky); dst.fog.copy(src.fog); dst.sun.copy(src.sun); dst.hemiGround.copy(src.hemiGround);
  dst.sunIntensity = src.sunIntensity; dst.hemiIntensity = src.hemiIntensity; dst.fogFar = src.fogFar;
}

/** Lerp a number toward target, returning new value. */
function lerpN(a: number, b: number, t: number): number { return a + (b - a) * t; }

/**
 * The pre-bootstrap fallback sun-arc params — reproduces the retired fixed
 * `SUN_DIR = (20,100,-15).normalize()` at noon exactly (pinned in
 * sun_arc.test.ts). Used only until `applyAtmosphere()` swaps in the
 * authored `data/atmospheres/default.json` values (same pattern as
 * EdgePass's PRE_BOOTSTRAP_GRADE).
 */
const PRE_BOOTSTRAP_SUN_ARC: SunArcParams = {
  dawnAzimuthDeg: -95,
  duskAzimuthDeg: 21.26,
  maxAltitudeDeg: 75.96375653207352,
  nightDepthDeg: 20,
};

/**
 * Direction FROM the origin TOWARD the cool rim/back light — roughly opposite the
 * sun in azimuth and raking low, so it catches the vertical faces the sun leaves
 * in shadow and separates silhouettes from the background. A non-shadowing fill;
 * its cool tint against the warm sun is the warm/cool temperature contrast that
 * reads as deliberately-lit (AAA) rather than flat-ambient. Scales with daylight
 * so night stays dark (it becomes a faint cool moon-fill, not a second sun).
 */
const RIM_DIR = new THREE.Vector3(-28, 34, 20).normalize();

/** Cool tint the rim fill is biased toward (a dusk-sky blue) for warm/cool contrast. */
const COOL_RIM_TINT = new THREE.Color(0x8aa6d8);

/**
 * FogExp2 density = this / palette.fogFar. Lower than a literal 1/fogFar so the
 * haze stays gentle inside the ~68-unit play radius and thickens toward the
 * draw edge — depth cue, not a wall of murk. Tuning knob for overall atmosphere.
 */
const FOG_DENSITY_K = 2.1;

export class EnvironmentLighting {
  /** Directional sun — its target tracks the camera center each frame. */
  private readonly sun: THREE.DirectionalLight;
  /**
   * Shadow camera basis vectors, RECOMPUTED every frame in update() from the
   * live sun direction (T-311 P5a — the sun arcs now, so a constructor-time
   * precompute would go stale). Used to snap the shadow frustum in shadow-UV
   * space rather than world X/Z — world-axis snapping leaves residual
   * swimming along the perpendicular axis whenever the shadow camera isn't
   * aligned with the world grid. A few vector ops per frame; no dirty-flag
   * caching cleverness — just recompute unconditionally.
   */
  private readonly _shadowCamRight = new THREE.Vector3();
  private readonly _shadowCamUp = new THREE.Vector3();
  /** Live normalized direction FROM the world origin TOWARD the sun, recomputed
   *  each frame in update() from sunArc(timeOfDay01, sunArcParams). */
  private readonly _sunDir = new THREE.Vector3();
  /** Sun-path params — the pre-bootstrap fallback until applyAtmosphere(). */
  private sunArcParams: SunArcParams = PRE_BOOTSTRAP_SUN_ARC;
  /** Visible sun disc in the sky. */
  private readonly sunMesh: THREE.Mesh;
  /** Hemisphere sky/ground ambient. */
  private readonly hemi: THREE.HemisphereLight;
  /** Cool, non-shadowing rim/back fill opposite the sun (silhouette separation). */
  private readonly rim: THREE.DirectionalLight;

  /** Phase table — empty until applyPalette() populates it from the palette. */
  private phaseLights: Record<string, DayPhaseLight> = {};
  /** Current interpolated lighting (mutated every frame; snapped to noon on applyPalette). */
  private readonly lightCur: DayPhaseLight = neutralPhase();
  /** Target lighting set by setPhase(). */
  private readonly lightTgt: DayPhaseLight = neutralPhase();

  constructor(private readonly scene: THREE.Scene) {
    // ---- lighting ----
    // Strong directional sun — dominates shading so flat-shaded faces read clearly.
    // Seed the initial direction from the pre-bootstrap arc's noon position;
    // update() overwrites this every frame once the render loop starts.
    {
      const noon = sunArc(0.5, this.sunArcParams).dir;
      this._sunDir.set(noon.x, noon.y, noon.z);
    }
    this.sun = new THREE.DirectionalLight(0xfffde0, 2.5);
    this.sun.position.copy(this._sunDir).multiplyScalar(100);
    this.sun.castShadow = true;
    // 2048 map over the same ±60 frustum = 4× the texel density of the old 1024,
    // so penumbrae read clean instead of pixel-staired. PCFSoftShadowMap (set on
    // the renderer) + a small radius gives a tight, stylized soft edge — comic,
    // not a mushy realistic blur.
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.camera.near   = 0.5;
    this.sun.shadow.camera.far    = 400;
    this.sun.shadow.camera.left   = -60;
    this.sun.shadow.camera.right  =  60;
    this.sun.shadow.camera.top    =  60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.bias = -0.0005;     // smaller depth bias at the higher resolution
    this.sun.shadow.normalBias = 0.02;  // push along the normal to kill acne on flat faces
    this.scene.add(this.sun);
    // Target must be in the scene so Three.js updates its world matrix each frame.
    this.scene.add(this.sun.target);

    // Seed the shadow-camera basis from the same initial direction; update()
    // recomputes it every frame from here on (see _shadowCamRight's doc).
    this.recomputeShadowCamBasis();

    // Ambient fill — brightened so shadowed cliff walls are readable, not black
    // voids. Colors are neutral placeholders, overwritten by applyPalette() from
    // the palette's noon sky (sky-side) + hemiGround (ground-side).
    this.hemi = new THREE.HemisphereLight(0x808080, 0x404040, 0.55);
    this.scene.add(this.hemi);

    // ---- cool rim / back fill ----
    // No shadow (a fill, not a key). Direction + color/intensity are set per frame
    // in update(); colour comes from the phase sky, intensity scales with daylight.
    this.rim = new THREE.DirectionalLight(0x9fb6d8, 0.0);
    this.rim.castShadow = false;
    this.scene.add(this.rim);
    this.scene.add(this.rim.target);

    // ---- visible sun sphere ----
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(10, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfffce0 }),
    );
    this.scene.add(this.sunMesh);

    // ---- sky ---- (neutral placeholders; applyPalette swaps to the palette noon)
    // Exponential fog (FogExp2) for aerial perspective — distance hazes out on a
    // smooth curve so ridgelines and valleys gain depth, instead of the flat
    // linear band the old THREE.Fog produced. Density is derived from the palette
    // fogFar each frame (FOG_DENSITY_K / fogFar) so the day-night phases keep
    // authoring the reach without a second knob.
    this.scene.fog = new THREE.FogExp2(0x808080, FOG_DENSITY_K / 220);
    this.scene.background = new THREE.Color(0x808080);
  }

  /**
   * Swap the day-night phase lights to the content palette (T-280) and prime the
   * scene's hemisphere/background/fog to noon. The per-frame update reads
   * phaseLights fresh, so the swap takes effect immediately.
   */
  applyPalette(palette: Palette): void {
    this.phaseLights = buildPhaseLights(palette);
    const noon = this.phaseLights.noon;
    this.hemi.color.copy(noon.sky);
    this.hemi.groundColor.copy(noon.hemiGround);
    (this.scene.background as THREE.Color).copy(noon.sky);
    (this.scene.fog as THREE.FogExp2).color.copy(noon.fog);
    (this.scene.fog as THREE.FogExp2).density = FOG_DENSITY_K / Math.max(noon.fogFar, 1);
    // Snap the lerp state to noon so there's no startup fade from the neutral
    // placeholder — applyPalette runs once at content load, before the loop.
    copyPhase(this.lightCur, noon);
    copyPhase(this.lightTgt, noon);
  }

  /**
   * Apply a content AtmosphereDef's sun-path params (T-311 P5a). Only the
   * geometric path — day/night COLOUR stays on Palette.phases (applyPalette).
   * The next update() call picks up the new params immediately.
   */
  applyAtmosphere(atmo: AtmosphereDef): void {
    this.sunArcParams = atmo.sunArc;
  }

  /** Set the target lighting for a named day phase (lerped toward each frame). */
  setPhase(phase: string): void {
    const p = this.phaseLights[phase] ?? this.phaseLights.noon;
    this.lightTgt.sky.copy(p.sky);
    this.lightTgt.fog.copy(p.fog);
    this.lightTgt.sun.copy(p.sun);
    this.lightTgt.hemiGround.copy(p.hemiGround);
    this.lightTgt.sunIntensity = p.sunIntensity;
    this.lightTgt.hemiIntensity = p.hemiIntensity;
    this.lightTgt.fogFar = p.fogFar;
  }

  /** World position of the visible sun disc — for projecting the sun to screen
   *  space (god-ray light shafts). */
  getSunWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.sunMesh.position);
  }

  /** Live normalized direction FROM the world origin TOWARD the sun (this
   *  frame's sunArc() result) — the single sun owner every other consumer
   *  (water shader, future reflection streak) reads instead of carrying its
   *  own constant. */
  getSunDirection(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this._sunDir);
  }

  /**
   * Recompute the shadow-camera basis vectors from the CURRENT `_sunDir`.
   * Three.js lookAt: camLocalZ = normalize(eye - target) = sunDir.
   * camLocalX = normalize(cross(worldUp, sunDir)); camLocalY = cross(sunDir, camLocalX).
   * Called once per frame from update() (the sun arcs continuously now, so a
   * one-time constructor precompute would go stale) — a handful of vector
   * ops, cheap enough not to need dirty-flag caching.
   */
  private recomputeShadowCamBasis(): void {
    const up = new THREE.Vector3(0, 1, 0);
    this._shadowCamRight.crossVectors(up, this._sunDir).normalize();
    this._shadowCamUp.crossVectors(this._sunDir, this._shadowCamRight).normalize();
  }

  /** Toggle sun shadow casting (debug). Returns the new state. */
  toggleShadows(): boolean {
    this.sun.castShadow = !this.sun.castShadow;
    return this.sun.castShadow;
  }

  /**
   * Per-frame: recompute the live sun direction from the server clock,
   * lerp the current lighting toward the phase target and apply it to the
   * sun/hemi/sky/fog, then keep the shadow frustum centered on the camera
   * target (texel-snapped to kill swimming) and the sun disc fixed in the sky
   * relative to the camera. Called after the camera has settled for the frame.
   *
   * `timeOfDay01` is the server WorldClock's time-of-day fraction — the ONLY
   * server-derived input; the direction itself is computed here (pure
   * function, T-311 P5a), never sent over the wire.
   */
  update(cameraTarget: THREE.Vector3, cameraPos: THREE.Vector3, timeOfDay01: number): void {
    // Recompute the live sun direction + its shadow-camera basis. The sun
    // arcs continuously now, so both must be per-frame, not a one-time
    // constructor precompute.
    {
      const { dir } = sunArc(timeOfDay01, this.sunArcParams);
      this._sunDir.set(dir.x, dir.y, dir.z);
      this.recomputeShadowCamBasis();
    }

    // Smoothly transition day/night lighting (per-frame lerp toward target)
    const L = 0.015; // lerp speed — full transition over ~4 s at 60 fps
    this.lightCur.sky.lerp(this.lightTgt.sky, L);
    this.lightCur.fog.lerp(this.lightTgt.fog, L);
    this.lightCur.sun.lerp(this.lightTgt.sun, L);
    this.lightCur.hemiGround.lerp(this.lightTgt.hemiGround, L);
    this.lightCur.sunIntensity  = lerpN(this.lightCur.sunIntensity,  this.lightTgt.sunIntensity,  L);
    this.lightCur.hemiIntensity = lerpN(this.lightCur.hemiIntensity, this.lightTgt.hemiIntensity, L);
    this.lightCur.fogFar        = lerpN(this.lightCur.fogFar,        this.lightTgt.fogFar,        L);
    (this.scene.background as THREE.Color).copy(this.lightCur.sky);
    (this.scene.fog as THREE.FogExp2).color.copy(this.lightCur.fog);
    (this.scene.fog as THREE.FogExp2).density = FOG_DENSITY_K / Math.max(this.lightCur.fogFar, 1);
    this.sun.color.copy(this.lightCur.sun);
    this.sun.intensity   = this.lightCur.sunIntensity;
    this.hemi.color.copy(this.lightCur.sky);
    this.hemi.groundColor.copy(this.lightCur.hemiGround);
    this.hemi.intensity  = this.lightCur.hemiIntensity;
    this.sunMesh.visible = this.lightCur.sunIntensity > 0.15;

    // Cool rim/back fill: a sky-tinted cool shifted away from the warm sun, at
    // ~28% of the sun's intensity (plus a small night floor as a moon-fill). It
    // tracks the camera like the sun so the lit band follows the player.
    // RIM_DIR stays a fixed art-directed opposite-fill (not physically the
    // anti-sun) — deriving it from the arc's azimuth+180° is a follow-up,
    // out of scope this phase.
    this.rim.color.copy(this.lightCur.sky).lerp(COOL_RIM_TINT, 0.5);
    this.rim.intensity = this.lightCur.sunIntensity * 0.28 + 0.06;
    this.rim.position.copy(cameraTarget).addScaledVector(RIM_DIR, 100);
    this.rim.target.position.copy(cameraTarget);

    // Keep sun shadow frustum centered on the player area.
    // Both position and target must move together — only the direction between
    // them (_sunDir) defines where shadows fall, not the absolute world position.
    this.sun.target.position.copy(cameraTarget);
    this.sun.position.copy(cameraTarget).addScaledVector(this._sunDir, 100);

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
      .addScaledVector(this._sunDir, 350);
  }
}
