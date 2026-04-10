/**
 * Voxel and subobject mesh builders.
 *
 * Main voxels: rebuilt as a Group of individual displaced Mesh objects.
 * SubObjects:  rebuilt as a separate Group — one child Group per subobject,
 *              tagged with userData.subObjectIndex for picking.
 *
 * Both use the same buildVoxelMesh() helper so displacement, textures, and
 * materials look identical to the in-game client.
 */
import * as THREE from "three";
import type { MaterialId, SubObjectRef } from "@voxim/content";
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

// Selection highlight: slightly-expanded wireframe around a selected voxel
const SEL_GEO = new THREE.BoxGeometry(1.06, 1.06, 1.06);
const SEL_MAT = new THREE.MeshBasicMaterial({ color: 0xffdd44, wireframe: true });
export const selectionMesh = new THREE.Mesh(SEL_GEO, SEL_MAT);
selectionMesh.visible = false;

let _voxelGroup: THREE.Group | null = null;
let _subObjectGroup: THREE.Group | null = null;

export function getVoxelMesh(): THREE.Group | null { return _voxelGroup; }
export function getSubObjectMesh(): THREE.Group | null { return _subObjectGroup; }

// ---- shared voxel geometry builder ----

function buildDisplacedVoxelGeo(cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const geo = GEO_VOXEL.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
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
  opacity = 1,
): THREE.Mesh {
  const matDef    = content.getMaterial(matId);
  const color     = matDef ? matDef.color : 0x888888;
  const roughness = matDef ? matDef.roughness : 0.8;
  const emissive  = matDef && matDef.emissive > 0
    ? new THREE.Color(color).multiplyScalar(matDef.emissive * 0.7)
    : new THREE.Color(0x000000);
  const shininess = Math.round((1 - roughness) * 80);
  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
  const geo = buildDisplacedVoxelGeo(cx, cy, cz);
  const tex = getVoxelTexture(matId, color);
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    flatShading: true,
    shininess,
    emissive,
    transparent: opacity < 1,
    opacity,
  }));
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- main voxel group ----

export function rebuildVoxelMesh(
  voxelMap: Map<VoxelKey, MaterialId>,
  content: ContentStore,
): THREE.Group | null {
  if (_voxelGroup) {
    _voxelGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); }
    });
    _voxelGroup = null;
  }
  if (voxelMap.size === 0) return null;
  const group = new THREE.Group();
  for (const [key, matId] of voxelMap) {
    const [x, y, z] = parseKey(key);
    group.add(buildVoxelMesh(x, y, z, matId, content));
  }
  _voxelGroup = group;
  return group;
}

// ---- subobject group ----

/**
 * Rebuild the subobject preview Group.
 * Each subobject becomes a child THREE.Group at its transform position, tagged
 * with userData.subObjectIndex so ray_pick can identify which was clicked.
 * Selected subobject gets a colored wireframe box around its AABB.
 */
export function rebuildSubObjectMeshes(
  subs: SubObjectRef[],
  content: ContentStore,
  selectedIndex: number | null,
): THREE.Group | null {
  if (_subObjectGroup) {
    _subObjectGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); }
    });
    _subObjectGroup = null;
  }
  if (subs.length === 0) return null;

  const group = new THREE.Group();

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const mid = sub.pool?.[0] ?? sub.modelId;
    if (!mid) continue;

    const def = content.getModel(mid);
    if (!def) continue;

    const isSelected = i === selectedIndex;
    const subGroup = new THREE.Group();
    subGroup.userData.subObjectIndex = i;
    subGroup.position.set(sub.transform.x, sub.transform.y, sub.transform.z);
    subGroup.rotation.set(
      sub.transform.rotX * Math.PI / 180,
      sub.transform.rotY * Math.PI / 180,
      sub.transform.rotZ * Math.PI / 180,
    );
    subGroup.scale.set(sub.transform.scaleX, sub.transform.scaleY, sub.transform.scaleZ);

    // Render voxels at 85% opacity when not selected, full when selected
    const opacity = isSelected ? 1.0 : 0.75;
    for (const node of def.nodes) {
      subGroup.add(buildVoxelMesh(node.x, node.y, node.z, node.materialId, content, opacity));
    }

    // Bounding wireframe — always visible, brighter when selected
    const aabb = content.getModelAabb(mid);
    if (aabb) {
      const w = aabb.maxX - aabb.minX, h = aabb.maxY - aabb.minY, d = aabb.maxZ - aabb.minZ;
      const bboxGeo = new THREE.BoxGeometry(w, h, d);
      const bboxMat = new THREE.MeshBasicMaterial({
        color: isSelected ? 0xffdd44 : 0x4488cc,
        wireframe: true,
        transparent: true,
        opacity: isSelected ? 0.9 : 0.4,
      });
      const bbox = new THREE.Mesh(bboxGeo, bboxMat);
      bbox.position.set(
        aabb.minX + w / 2,
        aabb.minY + h / 2,
        aabb.minZ + d / 2,
      );
      subGroup.add(bbox);
    }

    group.add(subGroup);
  }

  _subObjectGroup = group;
  return group;
}

// ---- cursor / selection highlight ----

export function setCursorCell(cell: { x: number; y: number; z: number } | null): void {
  if (!cell) { cursorMesh.visible = false; return; }
  cursorMesh.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
  cursorMesh.visible = true;
}

export function setSelectionHighlight(cell: { x: number; y: number; z: number } | null): void {
  if (!cell) { selectionMesh.visible = false; return; }
  selectionMesh.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
  selectionMesh.visible = true;
}
