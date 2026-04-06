/**
 * Deterministic vertex displacement — organic geometry.
 *
 * Every vertex is offset by a small fixed random amount derived from its
 * world-space (or model-space) position.  The same position always produces
 * the same offset, so shared vertices across chunk, tile, or object boundaries
 * always agree — no cracks, seams, or jitter at any boundary.
 *
 * Spec reference: "Vertex Displacement — Organic Geometry"
 *   "A vertex at world position (32, 16, 4.0) has exactly one displacement
 *    value, derived from those coordinates. Adjacent geometry always agrees
 *    on shared vertex positions."
 *
 * Usage:
 *   const [dx, dy, dz] = vertexDisp(worldX, worldY, worldZ, magnitude);
 *   vertex.x += dx;  vertex.y += dy;  vertex.z += dz;
 */

/**
 * Integer hash of three signed integers.
 * Uses Murmur3-style mixing for good distribution at low values.
 */
function ihash3(x: number, y: number, z: number): number {
  // Combine with prime multipliers before mixing
  let h = (Math.imul(x, 0x9e3779b9) ^ Math.imul(y, 0x6c62272e) ^ Math.imul(z, 0x13198a2e)) >>> 0;
  // Murmur3 finalizer
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Compute a deterministic 3-axis displacement for a vertex.
 *
 * @param x, y, z   — world or model-space position.  Snapped to 0.25-unit
 *                    grid internally, so fractional heights (multiples of
 *                    0.25) hash correctly.
 * @param magnitude — maximum offset per axis, in world units.
 *                    Spec suggestion: ~10 % of voxel face width.
 *                    Terrain (1-unit voxels): 0.10.
 *                    Character voxels (0.2-unit): 0.02.
 * @returns [dx, dy, dz] — add directly to vertex position.
 */
export function vertexDisp(
  x: number,
  y: number,
  z: number,
  magnitude: number,
): [number, number, number] {
  // Snap to 0.25-unit grid (height precision per spec).
  const ix = Math.round(x * 4) | 0;
  const iy = Math.round(y * 4) | 0;
  const iz = Math.round(z * 4) | 0;

  const h = ihash3(ix, iy, iz);

  // Extract three independent floats in [-1, 1] from different byte lanes.
  const dx = ((h          & 0xFF) / 127.5 - 1.0) * magnitude;
  const dy = (((h >>>  8) & 0xFF) / 127.5 - 1.0) * magnitude;
  const dz = (((h >>> 16) & 0xFF) / 127.5 - 1.0) * magnitude;

  return [dx, dy, dz];
}
