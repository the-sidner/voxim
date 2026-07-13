/**
 * Camera-occlusion fade. Anything above the player's Y inside a soft
 * blob centred on the camera-to-player midpoint becomes transparent and
 * (when nearly invisible) discards in the fragment shader so it doesn't
 * write to the depth buffer.
 *
 * One module so trees, terrain, props and any other material we want
 * to fade share the same uniforms — push the player's position once per
 * frame via update() and every registered material reflects it.
 *
 * Every registered material's geometry has a `voxelCenter` attribute
 * (every vertex of a voxel cube tagged with its model-space centre) —
 * all terrain and scatter geometry comes out of the voxel bake. The
 * shader reads that, transforms once to world, and produces a "blocky"
 * fade — voxels pop in and out as discrete blocks.
 *
 * Two independent bands share this pipeline (T-314), combined per-voxel
 * with max() before the single discard test:
 *   - "canopy" band  — anything ABOVE the player's head, inside a wide
 *     radial blob centred on the camera↔player midpoint. Fades overhead
 *     tree canopy so it doesn't block the view straight down.
 *   - "wall" band    — anything from just above the player's FEET upward,
 *     inside a tight corridor around the camera↔player LINE SEGMENT
 *     (clamped to the segment, not a point-radius blob). Fades the sliver
 *     of a tall side-wall/building/cliff that sits directly between camera
 *     and player — the case T-328's rigid over-the-shoulder camera makes
 *     constant. The low minHeight is what tells the two bands apart: a
 *     wall fades from ankle height up, the canopy only from head height up,
 *     so the ground the player stands on is never eaten by either.
 */
import * as THREE from "three";

export interface CanopyFadeUniforms {
  uPlayerY:      { value: number };
  uFadeCenterXZ: { value: THREE.Vector2 };
  uCameraXZ:     { value: THREE.Vector2 };
  uPlayerXZ:     { value: THREE.Vector2 };
  uWindTime:     { value: number };
  uWindStrength: { value: number };
  uWindDir:      { value: THREE.Vector2 };
  uFadeMinHeight: { value: number };
  uFadeMaxHeight: { value: number };
  uFadeInnerR:    { value: number };
  uFadeOuterR:    { value: number };
  uFadeCutoff:    { value: number };
  uWallMinHeight: { value: number };
  uWallMaxHeight: { value: number };
  uWallInnerR:    { value: number };
  uWallOuterR:    { value: number };
}

/** Horizontal wind direction (three-space XZ) and how far the crown sways. */
const WIND_DIR = new THREE.Vector2(0.92, 0.39);  // normalized-ish
const WIND_STRENGTH = 0.06;                       // world units per unit of voxel height

/**
 * Fade thresholds. Geometry is killed via `discard` (binary cutout), not
 * alpha blending — keeping every material opaque preserves Three.js's
 * sort order, depth-write behaviour, and the edge-detection post pass.
 * The smoothstep + 0.5 cutoff turns the soft transition into a hard
 * boundary that still tracks the same vertical and radial bands.
 */
// Height is measured ABOVE the player's reported Y (game.position.z, which
// is feet-anchored). 2.0 ≈ top of the head, then a 3-unit ramp up to 5.0
// — so the player and anything around their body stays visible, and the
// canopy / overhead geometry above the head fades out.
const FADE_MIN_HEIGHT   = 2.0;  // start fading just above the player
const FADE_MAX_HEIGHT   = 5.0;  // fully faded 3 units higher
const FADE_INNER_RADIUS = 9.0;  // horizontal core where fade is fully active
const FADE_OUTER_RADIUS = 11.0; // 2-unit transition outside the core
const FADE_CUTOFF       = 0.5;  // discard when max(canopyBandFade, wallBandFade) > this

// Wall band (T-314): starts just above the feet (protects the floor the
// player stands on) and is fully faded within ~1 unit, so a wall's whole
// height above that thin ankle strip disappears. The radius is a corridor
// half-width around the camera↔player segment, not a canopy-sized dome.
const WALL_MIN_HEIGHT   = 0.3;
const WALL_MAX_HEIGHT   = 1.2;
const WALL_INNER_RADIUS = 1.5;
const WALL_OUTER_RADIUS = 3.0;

export class CanopyFade {
  readonly uniforms: CanopyFadeUniforms = {
    uPlayerY:      { value: -1e6 },
    uFadeCenterXZ: { value: new THREE.Vector2(0, 0) },
    uCameraXZ:     { value: new THREE.Vector2(0, 0) },
    uPlayerXZ:     { value: new THREE.Vector2(0, 0) },
    uWindTime:     { value: 0 },
    uWindStrength: { value: WIND_STRENGTH },
    uWindDir:      { value: WIND_DIR.clone() },
    uFadeMinHeight: { value: FADE_MIN_HEIGHT },
    uFadeMaxHeight: { value: FADE_MAX_HEIGHT },
    uFadeInnerR:    { value: FADE_INNER_RADIUS },
    uFadeOuterR:    { value: FADE_OUTER_RADIUS },
    uFadeCutoff:    { value: FADE_CUTOFF },
    uWallMinHeight: { value: WALL_MIN_HEIGHT },
    uWallMaxHeight: { value: WALL_MAX_HEIGHT },
    uWallInnerR:    { value: WALL_INNER_RADIUS },
    uWallOuterR:    { value: WALL_OUTER_RADIUS },
  };

  /** Advance the foliage wind animation. Pumped once per frame by the renderer. */
  setWindTime(nowMs: number): void {
    this.uniforms.uWindTime.value = nowMs * 0.001;
  }

  /**
   * Apply content-driven canopy wind + fade-cylinder + wall-fade config
   * (T-315 D3, wallFade added T-314). Mutates the shared uniform `.value`s
   * in place — Three.js reads `.value` at render time, so this
   * retroactively reaches every material already registered (no shader
   * recompile needed), unlike the old per-material fresh-literal capture
   * at `register()` time.
   */
  applyConfig(cfg: {
    canopyWind: { dirX: number; dirY: number; strength: number };
    canopyFade: { minHeight: number; maxHeight: number; innerRadius: number; outerRadius: number; cutoff: number };
    wallFade: { minHeight: number; maxHeight: number; innerRadius: number; outerRadius: number };
  }): void {
    const u = this.uniforms;
    u.uWindStrength.value = cfg.canopyWind.strength;
    (u.uWindDir.value as THREE.Vector2).set(cfg.canopyWind.dirX, cfg.canopyWind.dirY);
    u.uFadeMinHeight.value = cfg.canopyFade.minHeight;
    u.uFadeMaxHeight.value = cfg.canopyFade.maxHeight;
    u.uFadeInnerR.value    = cfg.canopyFade.innerRadius;
    u.uFadeOuterR.value    = cfg.canopyFade.outerRadius;
    u.uFadeCutoff.value    = cfg.canopyFade.cutoff;
    u.uWallMinHeight.value = cfg.wallFade.minHeight;
    u.uWallMaxHeight.value = cfg.wallFade.maxHeight;
    u.uWallInnerR.value    = cfg.wallFade.innerRadius;
    u.uWallOuterR.value    = cfg.wallFade.outerRadius;
  }

  /**
   * Push per-frame state. Coords are GAME space (z = up). Camera is in
   * Three.js space (y = up). The horizontal plane in three space is (x, z).
   */
  update(
    playerWorldX: number,
    playerWorldY: number,
    playerWorldZ: number,
    camera: THREE.Camera,
  ): void {
    // Game (x, y) → Three (x, z) on the horizontal plane.
    this.uniforms.uCameraXZ.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPlayerXZ.value.set(playerWorldX, playerWorldY);
    this.uniforms.uFadeCenterXZ.value.set(
      (camera.position.x + playerWorldX) * 0.5,
      (camera.position.z + playerWorldY) * 0.5,
    );
    this.uniforms.uPlayerY.value = playerWorldZ; // game z = three y
  }

  /**
   * Patch a material so its fragments alpha-fade and discard inside the
   * blob. Call once per material at construction; the patch is applied
   * the first time Three.js compiles its program.
   */
  register(material: THREE.Material, options: { wind?: boolean } = {}): void {
    const wind = options.wind ?? false;
    const u = this.uniforms;

    // Foliage wind: a height-scaled horizontal sway recomputed into gl_Position.
    // Amplitude grows with the voxel's model-space height so the foot stays
    // planted; the phase varies by world XZ so neighbouring plants don't lockstep.
    // (Only the colour pass sways — the shadow depth material is unpatched, so
    // shadows stay put; acceptable for a gentle breeze.)
    const windUniforms = wind
      ? `uniform float uWindTime;
         uniform float uWindStrength;
         uniform vec2  uWindDir;`
      : "";
    const windBody = wind
      ? `vec4 wpos = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           wpos = instanceMatrix * wpos;
         #endif
         wpos = modelMatrix * wpos;
         float windPhase = uWindTime * 1.7 + wpos.x * 0.22 + wpos.z * 0.22;
         float gust = sin(windPhase) + 0.4 * sin(windPhase * 2.3 + 1.7);
         float windH = max(voxelCenter.y, 0.0);
         wpos.xyz += vec3(uWindDir.x, 0.0, uWindDir.y) * (gust * uWindStrength * windH);
         gl_Position = projectionMatrix * viewMatrix * wpos;`
      : "";

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPlayerY       = u.uPlayerY;
      shader.uniforms.uFadeCenterXZ  = u.uFadeCenterXZ;
      shader.uniforms.uCameraXZ      = u.uCameraXZ;
      shader.uniforms.uPlayerXZ      = u.uPlayerXZ;
      shader.uniforms.uFadeMinHeight = u.uFadeMinHeight;
      shader.uniforms.uFadeMaxHeight = u.uFadeMaxHeight;
      shader.uniforms.uFadeInnerR    = u.uFadeInnerR;
      shader.uniforms.uFadeOuterR    = u.uFadeOuterR;
      shader.uniforms.uFadeCutoff    = u.uFadeCutoff;
      shader.uniforms.uWallMinHeight = u.uWallMinHeight;
      shader.uniforms.uWallMaxHeight = u.uWallMaxHeight;
      shader.uniforms.uWallInnerR    = u.uWallInnerR;
      shader.uniforms.uWallOuterR    = u.uWallOuterR;
      if (wind) {
        shader.uniforms.uWindTime     = u.uWindTime;
        shader.uniforms.uWindStrength = u.uWindStrength;
        shader.uniforms.uWindDir      = u.uWindDir;
      }

      // Per-voxel cutout. `voxelCenter` is a per-vertex attribute that
      // tags every cube vertex with its centre in model space. Transform
      // once to world, compute the canopy band (vert × horiz-blob) and the
      // wall band (vert × horiz-segment-corridor), take the stronger of the
      // two, and forward as a single float varying. All 24 verts of one
      // cube share that value, so every fragment of one voxel agrees on
      // discard — voxels disappear as whole blocks, never sliced.
      shader.vertexShader = `
        attribute vec3 voxelCenter;
        uniform vec2  uFadeCenterXZ;
        uniform vec2  uCameraXZ;
        uniform vec2  uPlayerXZ;
        uniform float uPlayerY;
        uniform float uFadeMinHeight;
        uniform float uFadeMaxHeight;
        uniform float uFadeInnerR;
        uniform float uFadeOuterR;
        uniform float uWallMinHeight;
        uniform float uWallMaxHeight;
        uniform float uWallInnerR;
        uniform float uWallOuterR;
        ${windUniforms}
        varying float vFade;
        ${shader.vertexShader}
      `.replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         vec4 vc = vec4(voxelCenter, 1.0);
         #ifdef USE_INSTANCING
           vc = instanceMatrix * vc;
         #endif
         vc = modelMatrix * vc;
         float aboveY = vc.y - uPlayerY;

         // Canopy band — overhead geometry inside a wide blob centred
         // between camera and player.
         float vertFade = smoothstep(uFadeMinHeight, uFadeMaxHeight, aboveY);
         float horizDist = length(vc.xz - uFadeCenterXZ);
         float horizFade = 1.0 - smoothstep(uFadeInnerR, uFadeOuterR, horizDist);
         float canopyBandFade = vertFade * horizFade;

         // Wall band (T-314) — side geometry inside a tight corridor around
         // the camera→player LINE SEGMENT (projected + clamped to [0,1] so
         // only the sliver actually BETWEEN the two, never beyond either,
         // is affected). minHeight starts just above the feet so the floor
         // under the player is never eaten by this band.
         vec2 toPlayer = uPlayerXZ - uCameraXZ;
         float segLenSq = max(dot(toPlayer, toPlayer), 1e-4);
         float segT = clamp(dot(vc.xz - uCameraXZ, toPlayer) / segLenSq, 0.0, 1.0);
         vec2 closest = uCameraXZ + toPlayer * segT;
         float segDist = length(vc.xz - closest);
         float wallVert = smoothstep(uWallMinHeight, uWallMaxHeight, aboveY);
         float wallHoriz = 1.0 - smoothstep(uWallInnerR, uWallOuterR, segDist);
         float wallBandFade = wallVert * wallHoriz;

         vFade = max(canopyBandFade, wallBandFade);
         ${windBody}`,
      );

      // Use the dummy `_FRAGMENT_BEGIN_` token via the `dithering_fragment`
      // include — earliest hook that runs after gl_FragColor is final.
      shader.fragmentShader = `
        uniform float uFadeCutoff;
        varying float vFade;
        ${shader.fragmentShader}
      `.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
         if (vFade > uFadeCutoff) discard;`,
      );
    };
  }
}

/** Process-wide singleton — every renderer that creates a fade-able
 *  material registers it here, and game.ts pumps update() each frame. */
export const canopyFade = new CanopyFade();
