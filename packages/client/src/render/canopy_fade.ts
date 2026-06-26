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
 * Two modes:
 *   - voxelMode = true: the geometry has a `voxelCenter` attribute (every
 *     vertex of a voxel cube tagged with its model-space centre). The
 *     shader reads that, transforms once to world, and produces a
 *     "blocky" fade — voxels pop in and out as discrete blocks.
 *   - voxelMode = false: per-fragment world position. Used for smooth
 *     meshes (terrain) where there are no voxel cells to align with.
 */
import * as THREE from "three";

export interface CanopyFadeUniforms {
  uPlayerY:      { value: number };
  uFadeCenterXZ: { value: THREE.Vector2 };
  uWindTime:     { value: number };
  uWindStrength: { value: number };
  uWindDir:      { value: THREE.Vector2 };
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
const FADE_CUTOFF       = 0.5;  // discard when (vertFade × horizFade) > this

export class CanopyFade {
  readonly uniforms: CanopyFadeUniforms = {
    uPlayerY:      { value: -1e6 },
    uFadeCenterXZ: { value: new THREE.Vector2(0, 0) },
    uWindTime:     { value: 0 },
    uWindStrength: { value: WIND_STRENGTH },
    uWindDir:      { value: WIND_DIR.clone() },
  };

  /** Advance the foliage wind animation. Pumped once per frame by the renderer. */
  setWindTime(nowMs: number): void {
    this.uniforms.uWindTime.value = nowMs * 0.001;
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
  register(material: THREE.Material, options: { voxelMode?: boolean; wind?: boolean } = {}): void {
    const voxelMode = options.voxelMode ?? false;
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
      shader.uniforms.uFadeMinHeight = { value: FADE_MIN_HEIGHT };
      shader.uniforms.uFadeMaxHeight = { value: FADE_MAX_HEIGHT };
      shader.uniforms.uFadeInnerR    = { value: FADE_INNER_RADIUS };
      shader.uniforms.uFadeOuterR    = { value: FADE_OUTER_RADIUS };
      shader.uniforms.uFadeCutoff    = { value: FADE_CUTOFF };
      if (wind) {
        shader.uniforms.uWindTime     = u.uWindTime;
        shader.uniforms.uWindStrength = u.uWindStrength;
        shader.uniforms.uWindDir      = u.uWindDir;
      }

      if (voxelMode) {
        // Per-voxel cutout. `voxelCenter` is a per-vertex attribute that
        // tags every cube vertex with its centre in model space. Transform
        // once to world, compute the (vert × horiz) fade product, and
        // forward as a single float varying. All 24 verts of one cube
        // share that value, so every fragment of one voxel agrees on
        // discard — voxels disappear as whole blocks, never sliced.
        shader.vertexShader = `
          attribute vec3 voxelCenter;
          uniform vec2  uFadeCenterXZ;
          uniform float uPlayerY;
          uniform float uFadeMinHeight;
          uniform float uFadeMaxHeight;
          uniform float uFadeInnerR;
          uniform float uFadeOuterR;
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
           float vertFade = smoothstep(uFadeMinHeight, uFadeMaxHeight, aboveY);
           float horizDist = length(vc.xz - uFadeCenterXZ);
           float horizFade = 1.0 - smoothstep(uFadeInnerR, uFadeOuterR, horizDist);
           vFade = vertFade * horizFade;
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
      } else {
        // Smooth meshes (terrain, etc.): per-fragment world position.
        shader.vertexShader = `varying vec3 vFadeWorldPos;\n${shader.vertexShader}`
          .replace(
            "#include <worldpos_vertex>",
            `#include <worldpos_vertex>
             vFadeWorldPos = worldPosition.xyz;`,
          );

        shader.fragmentShader = `
          uniform vec2  uFadeCenterXZ;
          uniform float uPlayerY;
          uniform float uFadeMinHeight;
          uniform float uFadeMaxHeight;
          uniform float uFadeInnerR;
          uniform float uFadeOuterR;
          uniform float uFadeCutoff;
          varying vec3  vFadeWorldPos;
          ${shader.fragmentShader}
        `.replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
           {
             float aboveY = vFadeWorldPos.y - uPlayerY;
             float vertFade = smoothstep(uFadeMinHeight, uFadeMaxHeight, aboveY);
             float horizDist = length(vFadeWorldPos.xz - uFadeCenterXZ);
             float horizFade = 1.0 - smoothstep(uFadeInnerR, uFadeOuterR, horizDist);
             if (vertFade * horizFade > uFadeCutoff) discard;
           }`,
        );
      }
    };
  }
}

/** Process-wide singleton — every renderer that creates a fade-able
 *  material registers it here, and game.ts pumps update() each frame. */
export const canopyFade = new CanopyFade();
