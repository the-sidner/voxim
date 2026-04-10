/**
 * Paint tool — place or erase a single voxel on pointer events.
 * Dragging paints continuously (one write per cell to avoid redundant writes).
 */
import type { PickResult } from "../ray_pick.ts";
import {
  voxels, activeMaterial, pushUndo,
  voxelKey, type VoxelPatch,
} from "../state.ts";
import type { MaterialId } from "@voxim/content";

let _patch: VoxelPatch | null = null;
let _lastCell: string | null  = null;

function applyToCell(result: PickResult, mode: "paint" | "erase"): void {
  const target = mode === "erase" && result.hitVoxel
    ? result.hitVoxel
    : result.cell;

  const key = voxelKey(target.x, target.y, target.z);
  if (key === _lastCell) return; // already painted this cell this drag
  _lastCell = key;

  const current = voxels.value;
  const before: MaterialId | null = current.get(key) ?? null;

  if (mode === "paint") {
    if (before === activeMaterial.value) return; // no change
  } else {
    if (before === null) return; // nothing to erase
  }

  // Record before-state for undo
  if (!_patch!.has(key)) _patch!.set(key, before);

  const next = new Map(current);
  if (mode === "paint") {
    next.set(key, activeMaterial.value);
  } else {
    next.delete(key);
  }
  voxels.value = next;
}

export function paintDown(result: PickResult, mode: "paint" | "erase"): void {
  _patch = new Map();
  _lastCell = null;
  applyToCell(result, mode);
}

export function paintMove(result: PickResult, mode: "paint" | "erase"): void {
  if (!_patch) return;
  applyToCell(result, mode);
}

export function paintUp(): void {
  if (_patch && _patch.size > 0) pushUndo(_patch);
  _patch = null;
  _lastCell = null;
}
