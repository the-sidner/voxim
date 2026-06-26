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
    ? new THREE.Color(color).multiplyScalar(matDef.emissive * 2.2)
    : new THREE.Color(0x000000);
  const tex = getVoxelTexture(materialId, color);
  return new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    flatShading: true,
    shininess,
    emissive,
    polygonOffset: onTop,
    polygonOffsetFactor: onTop ? -1 : 0,
    polygonOffsetUnits: onTop ? -4 : 0,
  });
}
