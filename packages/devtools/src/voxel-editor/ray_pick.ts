/**
 * Ray picking — converts pointer events into grid cells.
 *
 * Face pick: if pointer hovers an existing voxel, returns the face normal
 * so tools can place adjacent or target the hit voxel.
 *
 * Grid pick: if pointer misses all voxels, intersects the Y=activeLayer plane.
 */
import * as THREE from "three";
import { getCamera } from "./viewport.ts";
import { getVoxelMesh } from "./voxel_mesh.ts";

const raycaster = new THREE.Raycaster();
const ndcPoint  = new THREE.Vector2();
const yPlane    = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit  = new THREE.Vector3();

export interface PickResult {
  /** Integer grid cell the tool should target. */
  cell: { x: number; y: number; z: number };
  /**
   * true  → hit an existing voxel face; cell is the ADJACENT (placement) cell.
   * false → hit the grid plane; cell is the empty grid cell.
   * Use the `erase` flag separately — on erase, face-pick should target the voxel itself.
   */
  hitFace: boolean;
  /** The voxel that was directly hit (only set when hitFace=true). */
  hitVoxel?: { x: number; y: number; z: number };
}

export function pick(
  e: PointerEvent,
  canvas: HTMLCanvasElement,
  activeLayer: number,
): PickResult | null {
  const rect = canvas.getBoundingClientRect();
  ndcPoint.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndcPoint.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(ndcPoint, getCamera());

  const mesh = getVoxelMesh();
  if (mesh) {
    const hits = raycaster.intersectObject(mesh, true);
    if (hits.length > 0) {
      const hit = hits[0];
      const normal = hit.face?.normal ?? new THREE.Vector3(0, 1, 0);
      // Transform face normal from the hit child mesh's local space to world space
      const worldNormal = normal.clone().transformDirection(hit.object.matrixWorld).round();
      // The hit position in world space
      const wp = hit.point.clone().sub(
        worldNormal.clone().multiplyScalar(0.01), // step back slightly from face
      );
      // Voxel that was hit (floor of world position - 0.5 offset)
      const hx = Math.floor(wp.x);
      const hy = Math.floor(wp.y);
      const hz = Math.floor(wp.z);
      return {
        cell: {
          x: hx + Math.round(worldNormal.x),
          y: hy + Math.round(worldNormal.y),
          z: hz + Math.round(worldNormal.z),
        },
        hitFace: true,
        hitVoxel: { x: hx, y: hy, z: hz },
      };
    }
  }

  // Fall back to grid plane at Y = activeLayer
  yPlane.constant = -activeLayer;
  if (raycaster.ray.intersectPlane(yPlane, planeHit)) {
    return {
      cell: {
        x: Math.floor(planeHit.x),
        y: activeLayer,
        z: Math.floor(planeHit.z),
      },
      hitFace: false,
    };
  }

  return null;
}
