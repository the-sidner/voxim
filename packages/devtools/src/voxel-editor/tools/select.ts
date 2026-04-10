/**
 * Select tool — click to select a voxel or subobject in the viewport.
 * Drag on a selected subobject to reposition it (snaps to grid).
 */
import type { PickResult } from "../ray_pick.ts";
import {
  selectedVoxelKey, selectedSubObject,
  voxelKey, voxels, subObjects, updateSubObjectTransform,
  type VoxelKey,
} from "../state.ts";

let _draggingSubObject: number | null = null;
let _dragStartCell: { x: number; y: number; z: number } | null = null;
let _transformOrigin: { x: number; y: number; z: number } | null = null;

export function selectDown(result: PickResult): void {
  if (result.hitSubObjectIndex !== undefined) {
    // Select the subobject and prepare for drag
    selectedSubObject.value = result.hitSubObjectIndex;
    selectedVoxelKey.value  = null;
    _draggingSubObject = result.hitSubObjectIndex;
    _dragStartCell     = result.cell;
    const sub = subObjects.value[result.hitSubObjectIndex];
    _transformOrigin   = sub ? { x: sub.transform.x, y: sub.transform.y, z: sub.transform.z } : null;
  } else if (result.hitVoxel) {
    // Select the voxel directly hit
    const key: VoxelKey = voxelKey(result.hitVoxel.x, result.hitVoxel.y, result.hitVoxel.z);
    if (voxels.value.has(key)) {
      selectedVoxelKey.value  = key;
      selectedSubObject.value = null;
    } else {
      selectedVoxelKey.value  = null;
      selectedSubObject.value = null;
    }
    _draggingSubObject = null;
  } else {
    // Clicked empty space — deselect
    selectedVoxelKey.value  = null;
    selectedSubObject.value = null;
    _draggingSubObject = null;
  }
}

export function selectMove(result: PickResult): void {
  if (_draggingSubObject === null || !_dragStartCell || !_transformOrigin) return;
  // Offset the subobject transform by how far the cursor has moved on the grid
  const dx = result.cell.x - _dragStartCell.x;
  const dy = result.cell.y - _dragStartCell.y;
  const dz = result.cell.z - _dragStartCell.z;
  updateSubObjectTransform(_draggingSubObject, "x", _transformOrigin.x + dx);
  updateSubObjectTransform(_draggingSubObject, "y", _transformOrigin.y + dy);
  updateSubObjectTransform(_draggingSubObject, "z", _transformOrigin.z + dz);
}

export function selectUp(): void {
  _draggingSubObject = null;
  _dragStartCell     = null;
  _transformOrigin   = null;
}
