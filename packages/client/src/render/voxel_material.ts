/**
 * The one MaterialDef → THREE material builder (T-280). Collapses the four
 * copy-paste sites (entity voxels, forest props, prop pool, terrain) into a
 * single curve so color (from the snapped content palette), roughness→shininess,
 * emissive glow, and the voxel texture are decided in exactly one place.
 */
import * as THREE from "three";
import type { MaterialDef } from "@voxim/content";
import { getVoxelTexture } from "./material_textures.ts";

const FALLBACK_COLOR = 0x808080;

/**
 * Scene-wide multiplier pushing a material's authored `emissive` (0-1) past
 * 1.0 into HDR/bloom range. Content-driven via GradeDef.emissiveHdrScale
 * (T-315 D2); this default is the pre-bootstrap fallback (module-level
 * singleton, same pattern as palette.ts's `setClientPalette`).
 */
let emissiveHdrScale = 2.2;

/** Apply a content grade's emissive HDR scale (T-315 D2). */
export function setEmissiveHdrScale(v: number): void {
  emissiveHdrScale = v;
}

/**
 * Build a flat-shaded voxel material for `matDef` (already palette-snapped).
 * `onTop` enables polygonOffset for overlay voxels (e.g. armor over body parts)
 * so they render cleanly without z-fighting.
 */
export function buildVoxelMaterial(
  matDef: MaterialDef | undefined,
  materialId: number,
  onTop = false,
): THREE.MeshPhongMaterial {
  const color = matDef?.color ?? FALLBACK_COLOR;
  // roughness (0–1) → shininess: rough surfaces have no specular highlight.
  const shininess = matDef ? Math.round((1 - matDef.roughness) * 80) : 0;
  // emissive: glow in the material's own color, scaled past 1.0 so emissive
  // surfaces (torches, embers) sit in the HDR headroom and clear the bloom
  // bright-pass threshold — that's what makes them visibly GLOW into the scene
  // rather than just reading as a bright-coloured face (T-310, phase D).
  const emissive = matDef && matDef.emissive > 0
    ? new THREE.Color(color).multiplyScalar(matDef.emissive * emissiveHdrScale)
    : new THREE.Color(0x000000);
  const tex = getVoxelTexture(matDef?.render?.textureStyle, materialId, color);
  return new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    // Per-voxel tint (baked into the `color` attribute by voxel_bake): every
    // voxel a slightly different shade of the material → a rich mottled mosaic
    // instead of one flat colour, the core of the reference surface richness.
    vertexColors: true,
    flatShading: true,
    shininess,
    emissive,
    polygonOffset: onTop,
    polygonOffsetFactor: onTop ? -1 : 0,
    polygonOffsetUnits: onTop ? -4 : 0,
  });
}
