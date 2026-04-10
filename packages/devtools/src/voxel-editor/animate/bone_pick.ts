/**
 * Bone picking — raycasts against skeleton sphere meshes to select bones.
 */
import * as THREE from "three";
import { getCamera } from "../viewport.ts";

import { getBoneSpheres } from "./skeleton_view.ts";

const _raycaster = new THREE.Raycaster();
_raycaster.params.Points = { threshold: 0.15 };

/**
 * Pick the nearest bone sphere under the pointer.
 * Returns the boneId string or null if nothing was hit.
 */
export function pickBone(e: PointerEvent, canvas: HTMLCanvasElement): string | null {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(new THREE.Vector2(x, y), getCamera());
  const hits = _raycaster.intersectObjects(getBoneSpheres(), false);
  if (hits.length === 0) return null;
  return (hits[0].object.userData.boneId as string) ?? null;
}
