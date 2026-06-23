/**
 * The model→three coordinate convention in ONE place (T-281).
 *
 * Voxim model space is (x=right, y=forward, z=up); Three.js is (x=right, y=up,
 * z=back). So model(x,y,z) → three(x, z, y), with each three axis scaled by the
 * entity scale's MATCHING MODEL axis:
 *
 *     three.x = model.x · scale.x
 *     three.y = model.z · scale.z      (model up → three up)
 *     three.z = model.y · scale.y      (model forward → three back)
 *
 * This swap was re-derived inline in ~6 render sites; every non-hot path now
 * routes through here so the convention has a single definition. The per-voxel
 * bake hot path keeps its inlined form (it folds into `bakeVoxels`, T-281 step 3).
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** model(mx,my,mz) + entity scale → three-space position. */
export function modelToThree(mx: number, my: number, mz: number, scale: Vec3): Vec3 {
  return { x: mx * scale.x, y: mz * scale.z, z: my * scale.y };
}

/** Scale a per-axis MODEL scale into three-space (sub-object nesting). */
export function modelScaleToThree(scale: Vec3, sub: Vec3): Vec3 {
  return { x: scale.x * sub.x, y: scale.z * sub.z, z: scale.y * sub.y };
}
