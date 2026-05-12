/**
 * Local mirrors of ModelDefinition + MaterialDef so the voxel editor
 * stays Layer-A pure (no @voxim/content import). The on-disk JSON is
 * the contract — these types declare the subset the editor reads /
 * writes / round-trips.
 *
 * Any field the editor doesn't manipulate is kept as opaque
 * passthrough so saving doesn't drop authored data the engine cares
 * about (e.g. hitbox cache, skeletonId binding).
 */

export interface VoxelNode {
  x: number;
  y: number;
  z: number;
  materialId: number;
}

export interface SubObjectRef {
  modelId?: string;
  pool?: string[];
  probability?: number;
  transform: {
    x: number; y: number; z: number;
    rotX: number; rotY: number; rotZ: number;
    scaleX: number; scaleY: number; scaleZ: number;
  };
  boneId?: string;
  materialSlot?: string;
  hitbox?: false;
}

export interface ModelDefinition {
  id: string;
  version: number;
  nodes: VoxelNode[];
  subObjects: SubObjectRef[];
  materials: number[];
  skeletonId?: string;
  hitbox?: {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  };
}

export interface MaterialDef {
  id: number;
  name: string;
  color: number;       // 0xRRGGBB
  roughness: number;
  metallic: number;
  emissive: number;
  solid: boolean;
  walkable: boolean;
  tags?: readonly string[];
  // `properties` and others passed through opaquely — we never edit them
  // from the voxel editor.
  [k: string]: unknown;
}

/** Default identity transform for a new sub-object. */
export function defaultSubTransform(): SubObjectRef["transform"] {
  return {
    x: 0, y: 0, z: 0,
    rotX: 0, rotY: 0, rotZ: 0,
    scaleX: 1, scaleY: 1, scaleZ: 1,
  };
}
