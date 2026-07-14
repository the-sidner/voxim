/**
 * The model→three ENTITY-LOCAL coordinate convention in ONE place (T-281).
 *
 * Voxim model space is (x=right, y=forward, z=up); Three.js is (x=right, y=up,
 * z=back). So model(x,y,z) → three(x, z, y), with each three axis scaled by the
 * entity scale's MATCHING MODEL axis:
 *
 *     three.x = model.x · scale.x
 *     three.y = model.z · scale.z      (model up → three up)
 *     three.z = model.y · scale.y      (model forward → three back)
 *
 * This file owns ONLY the scaled, entity-LOCAL half of that conversion (sub-model
 * and sub-object transforms nested inside an entity's group) — the 2 real call
 * sites are entity_mesh_registry.ts's sub-model placement and entity_mesh.ts's
 * bone-attached sub-object placement, both routed through modelToThree/
 * modelScaleToThree below.
 *
 * A SECOND, related idiom — WORLD-POSITION → three, same (x,z,y) axis permutation
 * but with no scale param — is NOT owned here. It stays inlined at its own sites,
 * each individually commented: entity_mesh.ts (updateEntityMesh's instant-set +
 * posBuffer interpolation push), renderer.ts (local-player predicted position),
 * gate_marker.ts, particle_system.ts, and scatter_renderer.ts. Folding those
 * into a shared unscaled `worldToThree()` helper is a safe, optional follow-up —
 * not done here because every site above is already correctly self-documented.
 *
 * The per-voxel bake hot path (voxel_bake.ts) keeps its own inlined form
 * (T-281 step 3) for performance — deliberately excluded from both above.
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
