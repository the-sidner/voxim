/**
 * SurfaceTreatment registry (T-311 P4, grammar G4) — the sibling of the
 * TextureStyle registry: named material-treatment handlers that PATCH a THREE
 * material's shader (real per-handler behaviour, not a value lookup). The wet
 * street and the water surface dispatch through the same handler ids here
 * (P5b brings `wet_reflect`, consuming `render.reflect`); v1 shipped
 * `wet_specular`, consumed by the terrain path wherever a material authors
 * `render.wetness`.
 *
 * A treatment CHAINS any pre-existing `onBeforeCompile` (canopyFade et al.
 * overwrite; treatments compose), so application order at the call site is:
 * buildVoxelMaterial → canopyFade.register → applySurfaceTreatment.
 */
import * as THREE from "three";

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

/**
 * Shared sky-colour uniform for `wet_reflect` (T-311 P5b) — one object every
 * treated material's compiled shader points at, so `setSkyColor()` updates
 * every wet-reflective ground material in one write (the same shared-uniform
 * idiom `canopy_fade.ts` uses for wind time, rather than a per-material
 * per-frame walk).
 */
const wetReflectUniforms = { uSkyColor: { value: new THREE.Color(0x808080) } };

/** Push the current frame's sky colour (EnvironmentLighting, the single sky
 *  owner) into every `wet_reflect`-treated material at once. */
export function setWetReflectSkyColor(hex: number): void {
  wetReflectUniforms.uSkyColor.value.setHex(hex);
}

/**
 * `wet_reflect` — a cheap sky-gradient reflection tint for wet/shoreline
 * ground materials (T-311 P5b), weighted by `render.wetness`'s per-vertex
 * `aWetness` (the SAME input `wet_specular` reads — `render.reflect` and
 * `render.wetness` compose on one attribute, no new geometry data). No
 * render-to-texture, no planar probe: just blends the diffuse toward the
 * live sky colour at the material's authored `strength`, so wet paths/stone
 * pick up a faint "reflecting the sky" cast instead of reading as flat-wet.
 * Params come from `MaterialDef.render.reflect`: `strength` (0..1 blend
 * amount at full wetness), `tint` (0..1, biases the blend warmer/toward the
 * sky vs. neutral grey — kept simple, no HSL shift machinery).
 */
const wetReflect: SurfaceTreatment = {
  apply(material, params) {
    const strength = params.strength ?? 0;
    const tint = params.tint ?? 1;
    const u = wetReflectUniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      shader.uniforms.uSkyColor = u.uSkyColor;
      shader.uniforms.uReflectStrength = { value: strength };
      shader.uniforms.uReflectTint = { value: tint };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aWetness;
          varying float vReflectWetness;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vReflectWetness = aWetness;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vReflectWetness;
          uniform vec3  uSkyColor;
          uniform float uReflectStrength;
          uniform float uReflectTint;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb,
            mix(diffuseColor.rgb, uSkyColor, uReflectTint),
            uReflectStrength * vReflectWetness);`);
    };
    material.needsUpdate = true;
  },
};

/** Idempotent builtin registration (mirrors registerBuiltinTextureStyles). */
export function registerBuiltinSurfaceTreatments(): void {
  registerSurfaceTreatment("wet_specular", wetSpecular);
  registerSurfaceTreatment("wet_reflect", wetReflect);
}
