/**
 * Builds and incrementally updates a Three.js InstancedMesh from the voxel map.
 *
 * Each voxel = one instance of a unit BoxGeometry.
 * Instance color is set from MaterialDef.color.
 * The mesh is rebuilt from scratch when voxels change (cheap enough for editor scale).
 */
import * as THREE from "three";
import type { MaterialId } from "@voxim/content";
import type { ContentStore } from "@voxim/content";
import type { VoxelKey } from "./state.ts";
import { parseKey } from "./state.ts";

const BOX = new THREE.BoxGeometry(1, 1, 1);
const MAT = new THREE.MeshLambertMaterial();

// Cursor: wireframe box showing hovered cell
const CURSOR_GEO = new THREE.BoxGeometry(1.02, 1.02, 1.02);
const CURSOR_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
export const cursorMesh = new THREE.Mesh(CURSOR_GEO, CURSOR_MAT);
cursorMesh.visible = false;

let _mesh: THREE.InstancedMesh | null = null;
const _dummy = new THREE.Object3D();
const _color  = new THREE.Color();

/** Returns the current InstancedMesh (or null if grid is empty). */
export function getVoxelMesh(): THREE.InstancedMesh | null {
  return _mesh;
}

/**
 * Rebuild the instanced mesh from the current voxel map.
 * Call this whenever voxels signal changes.
 * Returns the new mesh (or null) so the caller can swap it in the scene.
 */
export function rebuildVoxelMesh(
  voxelMap: Map<VoxelKey, MaterialId>,
  content: ContentStore,
): THREE.InstancedMesh | null {
  if (_mesh) {
    _mesh.dispose();
    _mesh = null;
  }

  const count = voxelMap.size;
  if (count === 0) return null;

  const mesh = new THREE.InstancedMesh(BOX, MAT, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  let i = 0;
  for (const [key, matId] of voxelMap) {
    const [x, y, z] = parseKey(key);
    _dummy.position.set(x + 0.5, y + 0.5, z + 0.5);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);

    const matDef = content.getMaterial(matId);
    const hex = matDef ? matDef.color : 0x888888;
    _color.set(hex);
    mesh.setColorAt(i, _color);
    i++;
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  _mesh = mesh;
  return mesh;
}

export function setCursorCell(cell: { x: number; y: number; z: number } | null): void {
  if (!cell) {
    cursorMesh.visible = false;
    return;
  }
  cursorMesh.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
  cursorMesh.visible = true;
}
