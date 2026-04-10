/**
 * Editor state — all mutable state as @preact/signals so UI panels react automatically.
 */
import { signal, computed } from "@preact/signals";
import type { MaterialId, ModelDefinition, SubObjectRef } from "@voxim/content";

// ---- types ----

export type ToolMode = "paint" | "erase" | "fill" | "select";
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

export const modelId      = signal<string>("new_model");
export const modelVersion = signal<number>(1);
export const skeletonId   = signal<string | null>(null);
export const subObjects   = signal<SubObjectRef[]>([]);

/**
 * The voxel grid — source of truth.
 * Replace the whole Map reference on every mutation to trigger signal subscribers.
 */
export const voxels = signal<Map<VoxelKey, MaterialId>>(new Map());

export const activeMaterial   = signal<MaterialId>(3); // stone
export const activeTool       = signal<ToolMode>("paint");
export const activeLayer      = signal<number>(0);     // Y level for grid pick

/** Selected voxel key — set by the select tool, null when nothing is selected. */
export const selectedVoxelKey    = signal<VoxelKey | null>(null);
/** Selected subobject index into subObjects.value — set by select tool or sidebar. */
export const selectedSubObject   = signal<number | null>(null);

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
    // hitbox is derived server-side from voxel nodes — not authored here
    nodes,
    subObjects: subObjects.value,
    materials,
  };
  if (skeletonId.value) def.skeletonId = skeletonId.value;
  return def;
}

// ---- import helper ----

export function fromModelDefinition(def: ModelDefinition): void {
  modelId.value      = def.id;
  modelVersion.value = def.version ?? 1;
  skeletonId.value   = def.skeletonId ?? null;
  subObjects.value   = def.subObjects ?? [];
  selectedVoxelKey.value  = null;
  selectedSubObject.value = null;
  const next = new Map<VoxelKey, MaterialId>();
  for (const n of def.nodes) next.set(voxelKey(n.x, n.y, n.z), n.materialId);
  voxels.value = next;
  undoStack.length = 0;
}

// ---- subobject helpers ----

export function updateSubObject(index: number, patch: Partial<SubObjectRef>): void {
  subObjects.value = subObjects.value.map((s, i) => i === index ? { ...s, ...patch } : s);
}

export function updateSubObjectTransform(index: number, key: string, value: number): void {
  subObjects.value = subObjects.value.map((s, i) => {
    if (i !== index) return s;
    return { ...s, transform: { ...s.transform, [key]: value } };
  });
}

export function addSubObject(): void {
  const next: SubObjectRef = {
    modelId: "",
    transform: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
  };
  selectedSubObject.value = subObjects.value.length;
  subObjects.value = [...subObjects.value, next];
}

export function removeSubObject(index: number): void {
  subObjects.value = subObjects.value.filter((_, i) => i !== index);
  if (selectedSubObject.value === index) selectedSubObject.value = null;
  else if (selectedSubObject.value !== null && selectedSubObject.value > index)
    selectedSubObject.value -= 1;
}
