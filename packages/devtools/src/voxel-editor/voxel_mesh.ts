/**
 * Builds a Three.js Group of individual displaced voxel meshes from the voxel map.
 *
 * Each voxel gets its own cloned + displaced BoxGeometry so the look matches
 * the in-game client exactly (same vertexDisp() function, same MeshPhongMaterial
 * with flatShading, same procedural textures from getVoxelTexture()).
 *
 * Individual meshes are more expensive than InstancedMesh but editor models are
 * small (hundreds of voxels, not thousands), so the simplicity is worth it.
 */
import * as THREE from "three";
import type { MaterialId } from "@voxim/content";
import type { ContentStore } from "@voxim/content";
import type { VoxelKey } from "./state.ts";
import { parseKey } from "./state.ts";
import { vertexDisp } from "../../../client/src/render/displacement.ts";
import { getVoxelTexture } from "../../../client/src/render/material_textures.ts";

// Base geometry — cloned per voxel, never disposed directly.
const GEO_VOXEL = new THREE.BoxGeometry(1, 1, 1);

// Cursor: wireframe box showing hovered cell
const CURSOR_GEO = new THREE.BoxGeometry(1.02, 1.02, 1.02);
const CURSOR_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
export const cursorMesh = new THREE.Mesh(CURSOR_GEO, CURSOR_MAT);
cursorMesh.visible = false;

let _group: THREE.Group | null = null;

/** Returns the current voxel Group (or null if grid is empty). */
export function getVoxelMesh(): THREE.Group | null {
  return _group;
}

/**
 * Clone GEO_VOXEL and displace each vertex by vertexDisp() keyed on its
 * world position. Magnitude is 10% of the voxel size (matching entity_mesh.ts).
 */
function buildDisplacedVoxelGeo(
  cx: number, cy: number, cz: number,
): THREE.BufferGeometry {
  const geo = GEO_VOXEL.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10; // 10% of 1-unit voxel
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const ly = pos.getY(i);
    const lz = pos.getZ(i);
    const [dx, dy, dz] = vertexDisp(cx + lx, cy + ly, cz + lz, mag);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function buildVoxelMesh(
  x: number, y: number, z: number,
  matId: MaterialId,
  content: ContentStore,
): THREE.Mesh {
  const matDef = content.getMaterial(matId);
  const color     = matDef ? matDef.color : 0x888888;
  const roughness = matDef ? matDef.roughness : 0.8;
  const emissive  = matDef && matDef.emissive > 0
    ? new THREE.Color(color).multiplyScalar(matDef.emissive * 0.7)
    : new THREE.Color(0x000000);
  const shininess = Math.round((1 - roughness) * 80);

  // Center of this voxel in world space
  const cx = x + 0.5;
  const cy = y + 0.5;
  const cz = z + 0.5;

  const geo = buildDisplacedVoxelGeo(cx, cy, cz);
  const tex = getVoxelTexture(matId, color);

  const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    flatShading: true,
    shininess,
    emissive,
  }));
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Rebuild the voxel Group from the current voxel map.
 * Call this whenever the voxels signal changes.
 * Returns the new Group (or null) so the caller can swap it in the scene.
 */
export function rebuildVoxelMesh(
  voxelMap: Map<VoxelKey, MaterialId>,
  content: ContentStore,
): THREE.Group | null {
  // Dispose previous
  if (_group) {
    _group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    _group = null;
  }

  if (voxelMap.size === 0) return null;

  const group = new THREE.Group();
  for (const [key, matId] of voxelMap) {
    const [x, y, z] = parseKey(key);
    group.add(buildVoxelMesh(x, y, z, matId, content));
  }

  _group = group;
  return group;
}

export function setCursorCell(cell: { x: number; y: number; z: number } | null): void {
  if (!cell) {
    cursorMesh.visible = false;
    return;
  }
  cursorMesh.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
  cursorMesh.visible = true;
}
