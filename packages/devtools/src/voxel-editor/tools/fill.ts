/**
 * Fill tool — 6-connected flood fill from the clicked cell.
 * Fills cells that match the seed material with activeMaterial.
 * Bounded at MAX_CELLS to prevent runaway fills.
 */
import type { PickResult } from "../ray_pick.ts";
import {
  voxels, activeMaterial, pushUndo,
  voxelKey, parseKey, type VoxelPatch,
} from "../state.ts";
import type { MaterialId } from "@voxim/content";

const MAX_CELLS = 4096;

const NEIGHBORS: [number, number, number][] = [
  [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
];

export function fillAt(result: PickResult): void {
  // Target = the placement cell (not hitVoxel) for consistency
  const startCell = result.cell;
  const startKey  = voxelKey(startCell.x, startCell.y, startCell.z);
  const current   = voxels.value;
  const seedMat: MaterialId | null = current.get(startKey) ?? null;
  const fillMat   = activeMaterial.value;

  if (seedMat === fillMat) return; // already this material

  const patch: VoxelPatch = new Map();
  const next = new Map(current);
  const queue: string[] = [startKey];
  const visited = new Set<string>([startKey]);

  while (queue.length > 0 && visited.size <= MAX_CELLS) {
    const key = queue.shift()!;
    const [x, y, z] = parseKey(key);

    // Check this cell matches seed
    const mat: MaterialId | null = current.get(key) ?? null;
    if (mat !== seedMat) continue;

    // Record before-state and apply fill
    patch.set(key, mat);
    next.set(key, fillMat);

    // Enqueue 6-connected neighbors
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nk = voxelKey(x + dx, y + dy, z + dz);
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push(nk);
      }
    }
  }

  if (patch.size === 0) return;
  voxels.value = next;
  pushUndo(patch);
}
