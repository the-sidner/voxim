/**
 * Editor state — all mutable state as @preact/signals so UI panels react automatically.
 */
import { signal, computed } from "@preact/signals";
import type { MaterialId, ModelDefinition, SubObjectRef, Hitbox } from "@voxim/content";

// ---- types ----

export type ToolMode = "paint" | "erase" | "fill";
export type VoxelKey = string; // "x,y,z"

export function voxelKey(x: number, y: number, z: number): VoxelKey {
  return `${x},${y},${z}`;
}

export function parseKey(key: VoxelKey): [number, number, number] {
  const parts = key.split(",");
  return [parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2])];
}

/** Before-state of changed cells for one undoable action. null = cell was absent. */
export type VoxelPatch = Map<VoxelKey, MaterialId | null>;

// ---- core state signals ----

export const modelId       = signal<string>("new_model");
export const modelVersion  = signal<number>(1);
export const skeletonId    = signal<string | null>(null);
export const hitbox        = signal<Hitbox>({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 });
export const subObjects    = signal<SubObjectRef[]>([]);

/**
 * The voxel grid — source of truth.
 * Replace the whole Map reference on every mutation to trigger signal subscribers.
 */
export const voxels        = signal<Map<VoxelKey, MaterialId>>(new Map());

export const activeMaterial = signal<MaterialId>(3); // stone
export const activeTool     = signal<ToolMode>("paint");
export const activeLayer    = signal<number>(0);      // Y level for grid pick
export const selectedSubObject = signal<number | null>(null);

// ---- undo ----

const MAX_UNDO = 128;
const undoStack: VoxelPatch[] = [];

export function pushUndo(patch: VoxelPatch): void {
  undoStack.push(patch);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export function undo(): void {
  const patch = undoStack.pop();
  if (!patch) return;
  const next = new Map(voxels.value);
  for (const [key, before] of patch) {
    if (before === null) next.delete(key);
    else next.set(key, before);
  }
  voxels.value = next;
}

// ---- derived ----

export const voxelCount = computed(() => voxels.value.size);

// ---- export helper ----

export function toModelDefinition(): ModelDefinition {
  const nodes = [...voxels.value.entries()].map(([key, materialId]) => {
    const [x, y, z] = parseKey(key);
    return { x, y, z, materialId };
  });
  const materials = [...new Set(nodes.map((n) => n.materialId))];
  const def: ModelDefinition = {
    id: modelId.value,
    version: modelVersion.value,
    hitbox: hitbox.value,
    nodes,
    subObjects: subObjects.value,
    materials,
  };
  if (skeletonId.value) def.skeletonId = skeletonId.value;
  return def;
}

// ---- import helper ----

export function fromModelDefinition(def: ModelDefinition): void {
  modelId.value = def.id;
  modelVersion.value = def.version ?? 1;
  skeletonId.value = def.skeletonId ?? null;
  hitbox.value = def.hitbox ?? { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  subObjects.value = def.subObjects ?? [];
  const next = new Map<VoxelKey, MaterialId>();
  for (const n of def.nodes) next.set(voxelKey(n.x, n.y, n.z), n.materialId);
  voxels.value = next;
  undoStack.length = 0;
}

// ---- hitbox auto-fit ----

export function autoFitHitbox(): void {
  const map = voxels.value;
  if (map.size === 0) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const key of map.keys()) {
    const [x, y, z] = parseKey(key);
    if (x < minX) minX = x; if (x + 1 > maxX) maxX = x + 1;
    if (y < minY) minY = y; if (y + 1 > maxY) maxY = y + 1;
    if (z < minZ) minZ = z; if (z + 1 > maxZ) maxZ = z + 1;
  }
  hitbox.value = { minX, minY, minZ, maxX, maxY, maxZ };
}
