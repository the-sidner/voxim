/**
 * Death-dissolve drift shader (T-311 P5c, I3b). Patches a voxel material so
 * fragments carrying nonzero `aFray` translate along their static
 * `aDriftDir` as `dissolutionPhase` rises 0→1 — a pure per-vertex POSITION
 * offset, geometry/normals otherwise untouched, zero CPU re-bake, zero
 * per-frame geometry rewrite (satisfies I3b's "deliberate, capped,
 * harness-verified amendment" bar).
 *
 * Unlike `canopy_fade.ts`'s wind/fade uniforms (shared across every
 * registered material — one player position, one wind direction),
 * `dissolutionPhase` is PER-ENTITY: each dissolving corpse has its own
 * phase, driven by its own `AnimationState.dissolutionPhase`. So this
 * module hands back a fresh uniform bundle per `register()` call (one per
 * material, i.e. one per profiled sub-mesh) instead of sharing one module-
 * level uniforms object — the caller stores the returned bundle (see
 * `DissolveUniforms` on `EntityMeshGroup`) and calls `.value =` on
 * `uPhase` once per frame from the render loop, exactly the way
 * `CanopyFade.update()` pushes `uPlayerY` — Three.js reads `.value` at
 * draw time, so no shader recompile is needed for the per-frame change.
 *
 * I3b hard caps (`maxSeparatedVoxels`, `maxSeparationDistance`) are
 * enforced BEFORE this module ever sees the mesh: the bake path (next
 * commit) only ever writes nonzero `aFray` to the N frayest voxels by
 * loose01, and `uDriftDistance` below is clamped to the profile's
 * `maxSeparationDistance` — so even at phase=1 no voxel can travel further
 * than the content-authored cap.
 */
import * as THREE from "three";

export interface DissolveUniforms {
  uPhase:         { value: number };
  uDriftDistance: { value: number };
}

function newUniforms(maxSeparationDistance: number): DissolveUniforms {
  return {
    uPhase:         { value: 0 },
    uDriftDistance: { value: maxSeparationDistance },
  };
}

/**
 * Patch `material` so its vertex shader offsets `transformed` by
 * `aDriftDir * aFray * uPhase * uDriftDistance`. Call once per material at
 * construction (mirrors `CanopyFade.register`'s "patch once, push values
 * every frame after" shape). Only meaningful on geometry carrying the
 * `aFray`/`aDriftDir` attributes (the bake path only emits them for a
 * profiled creature's loose voxels) — a material with no such geometry
 * simply never has a nonzero `aFray` to multiply against, so registering
 * this on ordinary geometry is inert, not wrong.
 */
export function registerDissolveDrift(
  material: THREE.Material,
  maxSeparationDistance: number,
): DissolveUniforms {
  const u = newUniforms(maxSeparationDistance);
  const prevCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    prevCompile?.(shader, renderer);
    shader.uniforms.uDissolvePhase = u.uPhase;
    shader.uniforms.uDriftDistance = u.uDriftDistance;

    shader.vertexShader = `
      attribute float aFray;
      attribute vec3  aDriftDir;
      uniform float uDissolvePhase;
      uniform float uDriftDistance;
      ${shader.vertexShader}
    `.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       transformed += aDriftDir * aFray * uDissolvePhase * uDriftDistance;`,
    );
  };

  return u;
}
