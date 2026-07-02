/**
 * SurfaceTreatment registry (T-311 P4, grammar G4) — the sibling of the
 * TextureStyle registry: named material-treatment handlers that PATCH a THREE
 * material's shader (real per-handler behaviour, not a value lookup). The wet
 * street and the water surface are meant to dispatch through the same handler
 * ids here (P5 brings water + `render.reflect`); v1 ships `wet_specular`,
 * consumed by the terrain path wherever a material authors `render.wetness`.
 *
 * A treatment CHAINS any pre-existing `onBeforeCompile` (canopyFade et al.
 * overwrite; treatments compose), so application order at the call site is:
 * buildVoxelMaterial → canopyFade.register → applySurfaceTreatment.
 */
import type * as THREE from "three";

export interface SurfaceTreatment {
  /** Patch `material` in place. `params` are the content-authored numbers
   *  (e.g. `MaterialDef.render.wetness`). */
  apply(material: THREE.Material, params: Readonly<Record<string, number>>): void;
}

const REGISTRY = new Map<string, SurfaceTreatment>();

export function registerSurfaceTreatment(id: string, treatment: SurfaceTreatment): void {
  REGISTRY.set(id, treatment);
}

export function surfaceTreatmentIds(): string[] {
  return [...REGISTRY.keys()];
}

/** Apply a registered treatment; unknown ids throw (boot-visible, fail-fast). */
export function applySurfaceTreatment(
  id: string,
  material: THREE.Material,
  params: Readonly<Record<string, number>>,
): void {
  registerBuiltinSurfaceTreatments();  // lazy, idempotent (the TextureStyle idiom)
  const t = REGISTRY.get(id);
  if (!t) throw new Error(`[surface_treatments] unknown treatment "${id}" (known: ${surfaceTreatmentIds().join(", ")})`);
  t.apply(material, params);
}

/**
 * `wet_specular` — darken + gloss from the per-vertex `aWetness` attribute
 * (baked from SurfaceStateGrid.wetness via VoxelAtom.wet01). Response params
 * come from `MaterialDef.render.wetness`: `darken` = diffuse darkening at
 * wetness 1, `gloss` = specular-strength gain at wetness 1 (`reflectGain` is
 * reserved for the P5 reflection streak). Geometry without the attribute must
 * not use this treatment (the terrain path gates on `baked.wetness`).
 */
const wetSpecular: SurfaceTreatment = {
  apply(material, params) {
    const gloss = params.gloss ?? 0;
    const darken = params.darken ?? 0;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      shader.uniforms.uWetGloss = { value: gloss };
      shader.uniforms.uWetDarken = { value: darken };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aWetness;
          varying float vWetness;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vWetness = aWetness;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vWetness;
          uniform float uWetGloss;
          uniform float uWetDarken;`)
        // Wet ground reads darker…
        .replace("#include <color_fragment>", `#include <color_fragment>
          diffuseColor.rgb *= 1.0 - uWetDarken * vWetness;`)
        // …and glossier (specularStrength feeds the Phong lighting below).
        .replace("#include <specularmap_fragment>", `#include <specularmap_fragment>
          specularStrength *= 1.0 + uWetGloss * vWetness;`);
    };
    material.needsUpdate = true;
  },
};

/** Idempotent builtin registration (mirrors registerBuiltinTextureStyles). */
export function registerBuiltinSurfaceTreatments(): void {
  registerSurfaceTreatment("wet_specular", wetSpecular);
}
