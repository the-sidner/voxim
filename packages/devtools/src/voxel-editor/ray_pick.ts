/**
 * Ray picking — converts pointer events into grid cells.
 *
 * Checks two targets in order:
 *   1. SubObject group  — returns hitSubObjectIndex when a subobject is hit
 *   2. Main voxel group — returns hitVoxel + adjacent placement cell
 *   3. Y-plane fallback — returns grid cell at activeLayer height
 */
import * as THREE from "three";
import { getCamera } from "./viewport.ts";
import { getVoxelMesh, getSubObjectMesh } from "./voxel_mesh.ts";

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
   */
  hitFace: boolean;
  /** The voxel that was directly hit (only set when hitFace=true and no subobject hit). */
  hitVoxel?: { x: number; y: number; z: number };
  /** Index into subObjects array when a subobject was directly hit. */
  hitSubObjectIndex?: number;
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

  // 1. Try subobject group first — subobjects are "on top" for selection purposes
  const subGroup = getSubObjectMesh();
  if (subGroup) {
    const hits = raycaster.intersectObject(subGroup, true);
    if (hits.length > 0) {
      // Walk up from hit object to find the child of subGroup that has subObjectIndex
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && obj.parent !== subGroup) obj = obj.parent;
      const idx = obj?.userData?.subObjectIndex;
      if (typeof idx === "number") {
        // Return the hit world position snapped to nearest grid cell as cell
        const wp = hits[0].point;
        return {
          cell: { x: Math.floor(wp.x), y: Math.floor(wp.y), z: Math.floor(wp.z) },
          hitFace: false,
          hitSubObjectIndex: idx,
        };
      }
    }
  }

  // 2. Try main voxel group
  const voxelGroup = getVoxelMesh();
  if (voxelGroup) {
    const hits = raycaster.intersectObject(voxelGroup, true);
    if (hits.length > 0) {
      const hit = hits[0];
      const normal = hit.face?.normal ?? new THREE.Vector3(0, 1, 0);
      const worldNormal = normal.clone().transformDirection(hit.object.matrixWorld).round();
      const wp = hit.point.clone().sub(worldNormal.clone().multiplyScalar(0.01));
      const hx = Math.floor(wp.x), hy = Math.floor(wp.y), hz = Math.floor(wp.z);
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

  // 3. Fall back to grid plane at Y = activeLayer
  yPlane.constant = -activeLayer;
  if (raycaster.ray.intersectPlane(yPlane, planeHit)) {
    return {
      cell: { x: Math.floor(planeHit.x), y: activeLayer, z: Math.floor(planeHit.z) },
      hitFace: false,
    };
  }

  return null;
}
