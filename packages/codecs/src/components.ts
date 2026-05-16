/**
 * Binary Serialiser implementations for the first-pass component types.
 *
 * All use little-endian DataView encoding — no external deps.
 * The Serialiser interface means any of these can be swapped for a protobuf
 * implementation without touching any other code.
 */
import type { Serialiser } from "@voxim/engine";
import { buildCodec } from "./binary.ts";
import { WireWriter, WireReader } from "./wire.ts";
import type { ItemPart, ModelRefData, AnimationStateData, AnimationLayer, SkillVerb, BodyPartVolume } from "@voxim/content";

/**
 * Hard array-size caps for variable-length component payloads. Purely a
 * safety-rail against pathological growth (cheat client, bug) — these are not
 * gameplay tuning. All values are u16 on the wire, so codec decoders always
 * tolerate up to 65535; these ceilings just fail fast on the encode side so
 * a runaway system doesn't ship garbage across the wire.
 */
export const WIRE_LIMITS = {
  inventorySlots: 64,
  craftingQueue: 16,
  traderListings: 64,
  heritageTraits: 64,
  activeEffects: 32,
  hitRecordsPerSwing: 32,
} as const;

function assertMaxLen(name: string, len: number, max: number): void {
  if (len > max) {
    throw new Error(`[codec] ${name} length ${len} exceeds wire cap ${max}`);
  }
}

// ---- Position ---- 24 bytes (3 × f64)

export interface PositionData {
  x: number;
  y: number;
  z: number;
}

export const positionCodec: Serialiser<PositionData> = buildCodec<PositionData>({
  x: { type: "f64" },
  y: { type: "f64" },
  z: { type: "f64" },
});

// ---- Velocity ---- 24 bytes (3 × f64)

export interface VelocityData {
  x: number;
  y: number;
  z: number;
}

export const velocityCodec: Serialiser<VelocityData> = buildCodec<VelocityData>({
  x: { type: "f64" },
  y: { type: "f64" },
  z: { type: "f64" },
});

// ---- Facing ---- 8 bytes (1 × f64, radians)

export interface FacingData {
  angle: number;
}

export const facingCodec: Serialiser<FacingData> = buildCodec<FacingData>({
  angle: { type: "f64" },
});

// ---- Heightmap ---- 4104 bytes (1024 × f32 + 2 × i32)
// Float32Array is the canonical store; codec converts to/from a flat Uint8Array.

export interface HeightmapData {
  /** 1024 height values, row-major: index = localX + localY * 32 */
  data: Float32Array;
  chunkX: number;
  chunkY: number;
}

const CHUNK_CELLS = 32 * 32; // 1024

export const heightmapCodec: Serialiser<HeightmapData> = {
  encode(data: HeightmapData): Uint8Array {
    // 1024 floats + 2 int32s = 4096 + 8 = 4104 bytes
    const buf = new ArrayBuffer(CHUNK_CELLS * 4 + 8);
    const view = new DataView(buf);
    const arr = new Uint8Array(buf);

    // copy the Float32Array bytes directly (it is already f32 little-endian on all JS engines)
    arr.set(new Uint8Array(data.data.buffer, data.data.byteOffset, CHUNK_CELLS * 4), 0);

    view.setInt32(CHUNK_CELLS * 4, data.chunkX, true);
    view.setInt32(CHUNK_CELLS * 4 + 4, data.chunkY, true);

    return arr;
  },

  decode(bytes: Uint8Array): HeightmapData {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Slice the float data into a new buffer so the Float32Array owns it
    const floatBytes = bytes.slice(0, CHUNK_CELLS * 4);
    const data = new Float32Array(
      floatBytes.buffer,
      floatBytes.byteOffset,
      CHUNK_CELLS,
    );
    return {
      data,
      chunkX: view.getInt32(CHUNK_CELLS * 4, true),
      chunkY: view.getInt32(CHUNK_CELLS * 4 + 4, true),
    };
  },
};

// ---- MaterialGrid ---- 2048 bytes (1024 × u16)

export interface MaterialGridData {
  /** 1024 material IDs, same row-major layout as HeightmapData.data */
  data: Uint16Array;
}

export const materialGridCodec: Serialiser<MaterialGridData> = {
  encode(data: MaterialGridData): Uint8Array {
    return new Uint8Array(data.data.buffer, data.data.byteOffset, CHUNK_CELLS * 2);
  },

  decode(bytes: Uint8Array): MaterialGridData {
    const copy = bytes.slice(0, CHUNK_CELLS * 2);
    return {
      data: new Uint16Array(copy.buffer, copy.byteOffset, CHUNK_CELLS),
    };
  },
};

// ---- OpenMask ---- 1024 bytes (1024 × u8)

export interface OpenMaskData {
  /** 1024 cells, 1 = open, 0 = closed. Same row-major layout as HeightmapData.data. */
  data: Uint8Array;
}

export const openMaskCodec: Serialiser<OpenMaskData> = {
  encode(data: OpenMaskData): Uint8Array {
    return new Uint8Array(data.data); // copy for safety
  },
  decode(bytes: Uint8Array): OpenMaskData {
    return { data: new Uint8Array(bytes.slice(0, CHUNK_CELLS)) };
  },
};

// ---- KindGrid ---- 2048 bytes (1024 × u16)

export interface KindGridData {
  /**
   * Per-cell boundary kind id from atlas's BOUNDARY_KIND_* set. Same
   * row-major layout as HeightmapData.data. 0 = open / un-tagged.
   * Drives client-side decoration (trees on FOREST, etc.) without
   * needing per-tree server entities.
   */
  data: Uint16Array;
}

export const kindGridCodec: Serialiser<KindGridData> = {
  encode(data: KindGridData): Uint8Array {
    return new Uint8Array(data.data.buffer, data.data.byteOffset, CHUNK_CELLS * 2);
  },
  decode(bytes: Uint8Array): KindGridData {
    const copy = bytes.slice(0, CHUNK_CELLS * 2);
    return { data: new Uint16Array(copy.buffer, copy.byteOffset, CHUNK_CELLS) };
  },
};

// ============================================================================
// Game component binary layouts.
// All use WireWriter / WireReader (little-endian, no JSON, no base64).
// ============================================================================

// Re-export the content types we encode so consumers can import from one place.
export type { ItemPart, ModelRefData, AnimationStateData, AnimationLayer, SkillVerb };

// ---- ItemPart ---------------------------------------------------------------
// { slot: string, materialName: string }
// [u16 slotLen][slot bytes][u16 materialNameLen][materialName bytes]

export const itemPartCodec: Serialiser<ItemPart> = {
  encode(v: ItemPart): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.slot);
    w.writeStr(v.materialName);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ItemPart {
    const r = new WireReader(bytes);
    return { slot: r.readStr(), materialName: r.readStr() };
  },
};

// ---- InventorySlot ----------------------------------------------------------
// Discriminated union: stack (prefabId + quantity) or unique (entityId).
//
// kind == 0 → stack: most items (resources, food, stackable goods)
// kind == 1 → unique: one-of-a-kind items with their own world entity

export type InventorySlot =
  | { kind: "stack"; prefabId: string; quantity: number }
  | { kind: "unique"; entityId: string };

// Internal helpers so InventorySlot can be nested inside other codecs.
function writeInventorySlot(w: WireWriter, v: InventorySlot): void {
  if (v.kind === "stack") {
    w.writeU8(0);
    w.writeStr(v.prefabId);
    w.writeU16(v.quantity);
  } else {
    w.writeU8(1);
    w.writeStr(v.entityId);
  }
}

function readInventorySlot(r: WireReader): InventorySlot {
  const kind = r.readU8();
  if (kind === 0) {
    return { kind: "stack", prefabId: r.readStr(), quantity: r.readU16() };
  } else {
    return { kind: "unique", entityId: r.readStr() };
  }
}

export const inventorySlotCodec: Serialiser<InventorySlot> = {
  encode(v: InventorySlot): Uint8Array {
    const w = new WireWriter();
    writeInventorySlot(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): InventorySlot {
    return readInventorySlot(new WireReader(bytes));
  },
};

// ---- InputState -------------------------------------------------------------
// Player/NPC intent for the current tick. Written immediately at tick start
// from the drained input ring buffer (player sessions) or from NpcAi. Read by
// every downstream system. Networked so the client can render other players'
// facing / movement intent between state messages.

export interface InputStateData {
  facing: number;
  movementX: number;
  movementY: number;
  actions: number;
  /**
   * Duration the use-skill button was held before release, in milliseconds.
   * Written when ACTION_USE_SKILL is set on this tick; otherwise 0. ActionSystem
   * reads it to pick the matching weapon action variant from the equipped
   * weapon's `swingable.actions[]`.
   */
  chargeMs: number;
  seq: number;
  timestamp: number;
  rttMs: number;
}

export const inputStateCodec: Serialiser<InputStateData> = buildCodec<InputStateData>({
  facing: { type: "f32" },
  movementX: { type: "f32" },
  movementY: { type: "f32" },
  actions: { type: "i32" },
  chargeMs: { type: "i32" },
  seq: { type: "i32" },
  timestamp: { type: "f64" },
  rttMs: { type: "f32" },
});

// ---- Health -----------------------------------------------------------------

export interface HealthData {
  current: number;
  max: number;
}

export const healthCodec: Serialiser<HealthData> = buildCodec<HealthData>({
  current: { type: "f32" },
  max: { type: "f32" },
});

// (Hunger / Thirst codecs retired — they're server-only Resources now
// (tile-server/components/resource.ts). Wire ids 7/8 retired in
// @voxim/protocol; never reuse. T-238c.)

// ---- Lifetime ---------------------------------------------------------------
// Countdown on transient entities (projectiles, effects). Decremented each
// tick by LifetimeSystem; when ticks reaches 0 the entity is destroyed.

export interface LifetimeData { ticks: number; }

export const lifetimeCodec: Serialiser<LifetimeData> = buildCodec<LifetimeData>({
  ticks: { type: "i32" },
});

// (Stamina codec retired — stamina is a server-only `Resource` now
// (tile-server/components/resource.ts). Wire id 9 retired in
// @voxim/protocol; never reuse. T-238b.)

// (Staggered codec retired in T-232 — stagger is a reaction action +
// `staggered` tag now; the client renders it from the reaction-slot
// AnimationState, so it is no longer a wire component. Wire id 36 retired,
// never reuse.)

// ---- CounterReady -----------------------------------------------------------
// Marker component — zero payload. Present iff the entity has an open
// counter-attack window after a successful parry. Cleared by HealthHitHandler
// when the counter lands (or by a future timer when the window expires).

export type CounterReadyData = Record<never, never>;

export const counterReadyCodec: Serialiser<CounterReadyData> = {
  encode(_v: CounterReadyData): Uint8Array {
    return new Uint8Array(0);
  },
  decode(_bytes: Uint8Array): CounterReadyData {
    return {};
  },
};

// ---- ModelRef ---------------------------------------------------------------
// { modelId: string, scaleX/Y/Z: f32, seed: u32, morphValues: u8 count + (str,f32)... }
// Note: ModelRefData also has optional materialBindings — not transmitted over the wire
// (server never needs to round-trip that field).
//
// `morphValues` (T-180) — prefab-prescribed morph param overrides. Travels
// with the entity so server and client morph identically. Empty map (count=0)
// is the common case; only creatures with prefab-level proportion overrides
// pay the bytes (a few key/value pairs).

export const modelRefCodec: Serialiser<ModelRefData> = {
  encode(v: ModelRefData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.modelId);
    w.writeF32(v.scaleX);
    w.writeF32(v.scaleY);
    w.writeF32(v.scaleZ);
    w.writeU32(v.seed);
    const entries = v.morphValues ? Object.entries(v.morphValues) : [];
    w.writeU8(entries.length);
    for (const [k, val] of entries) { w.writeStr(k); w.writeF32(val); }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ModelRefData {
    const r = new WireReader(bytes);
    const out: ModelRefData = {
      modelId: r.readStr(),
      scaleX: r.readF32(),
      scaleY: r.readF32(),
      scaleZ: r.readF32(),
      seed: r.readU32(),
    };
    const morphCount = r.readU8();
    if (morphCount > 0) {
      const morphValues: Record<string, number> = {};
      for (let i = 0; i < morphCount; i++) morphValues[r.readStr()] = r.readF32();
      out.morphValues = morphValues;
    }
    return out;
  },
};

// ---- AnimationState ---------------------------------------------------------
// { layers: AnimationLayer[], weaponActionId: string, ticksIntoAction: u16 }
//
// Layer wire format (per layer):
//   str  clipId
//   str  maskId
//   f32  time
//   f32  weight
//   u8   blend         (0 = override, 1 = additive)
//   f32  speedScaleVal (-1.0 sentinel = "velocity")
//   f32  speedReference (0 when not applicable)

export const animationStateCodec: Serialiser<AnimationStateData> = {
  encode(v: AnimationStateData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.layers.length);
    for (const l of v.layers) {
      w.writeStr(l.clipId);
      w.writeStr(l.maskId);
      w.writeF32(l.time);
      w.writeF32(l.weight);
      w.writeU8(l.blend === "additive" ? 1 : 0);
      w.writeF32(typeof l.speedScale === "number" ? l.speedScale : -1.0);
      w.writeF32(l.speedReference ?? 0);
    }
    w.writeStr(v.weaponActionId);
    w.writeU16(v.ticksIntoAction);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): AnimationStateData {
    const r = new WireReader(bytes);
    const layerCount = r.readU8();
    const layers: AnimationLayer[] = [];
    for (let i = 0; i < layerCount; i++) {
      const clipId         = r.readStr();
      const maskId         = r.readStr();
      const time           = r.readF32();
      const weight         = r.readF32();
      const blend          = r.readU8() === 1 ? "additive" as const : "override" as const;
      const speedScaleVal  = r.readF32();
      const speedReference = r.readF32();
      const speedScale: AnimationLayer["speedScale"] = speedScaleVal < 0 ? "velocity" : speedScaleVal;
      layers.push({ clipId, maskId, time, weight, blend, speedScale, speedReference: speedReference || undefined });
    }
    return {
      layers,
      weaponActionId: r.readStr(),
      ticksIntoAction: r.readU16(),
    };
  },
};

// ---- Equipment --------------------------------------------------------------
// All seven equipment slots. Wire order is fixed — never reorder.
// Each slot carries both the item entity's EntityId and its prefabId so the
// client can resolve models and display names without a separate entity lookup.

export interface EquipmentSlot {
  entityId: string;
  prefabId: string;
}

export interface EquipmentData {
  weapon:  EquipmentSlot | null;
  offHand: EquipmentSlot | null;
  head:    EquipmentSlot | null;
  chest:   EquipmentSlot | null;
  legs:    EquipmentSlot | null;
  feet:    EquipmentSlot | null;
  back:    EquipmentSlot | null;
}

function writeSlot(w: WireWriter, slot: EquipmentSlot | null): void {
  if (slot !== null) {
    w.writeU8(1);
    w.writeStr(slot.entityId);
    w.writeStr(slot.prefabId);
  } else {
    w.writeU8(0);
  }
}

function readSlot(r: WireReader): EquipmentSlot | null {
  if (!r.readU8()) return null;
  return { entityId: r.readStr(), prefabId: r.readStr() };
}

export const equipmentCodec: Serialiser<EquipmentData> = {
  encode(v: EquipmentData): Uint8Array {
    const w = new WireWriter();
    writeSlot(w, v.weapon);
    writeSlot(w, v.offHand);
    writeSlot(w, v.head);
    writeSlot(w, v.chest);
    writeSlot(w, v.legs);
    writeSlot(w, v.feet);
    writeSlot(w, v.back);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): EquipmentData {
    const r = new WireReader(bytes);
    return {
      weapon:  readSlot(r),
      offHand: readSlot(r),
      head:    readSlot(r),
      chest:   readSlot(r),
      legs:    readSlot(r),
      feet:    readSlot(r),
      back:    readSlot(r),
    };
  },
};

// ---- Inventory --------------------------------------------------------------
// { slots: InventorySlot[], capacity: number }

export interface InventoryData {
  slots: InventorySlot[];
  capacity: number;
}

export const inventoryCodec: Serialiser<InventoryData> = {
  encode(v: InventoryData): Uint8Array {
    assertMaxLen("Inventory.slots", v.slots.length, WIRE_LIMITS.inventorySlots);
    const w = new WireWriter();
    w.writeU16(v.slots.length);
    for (const s of v.slots) writeInventorySlot(w, s);
    w.writeU16(v.capacity);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): InventoryData {
    const r = new WireReader(bytes);
    const count = r.readU16();
    const slots: InventorySlot[] = [];
    for (let i = 0; i < count; i++) slots.push(readInventorySlot(r));
    const capacity = r.readU16();
    return { slots, capacity };
  },
};

// ---- ItemData ---------------------------------------------------------------
// { prefabId, quantity } — marks a world-entity as a physical item drop or
// an in-equipment item entity. prefabId identifies the Prefab definition.

export interface ItemDataData {
  prefabId: string;
  quantity: number;
}

export const itemDataCodec: Serialiser<ItemDataData> = {
  encode(v: ItemDataData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.prefabId);
    w.writeU16(v.quantity);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ItemDataData {
    const r = new WireReader(bytes);
    return { prefabId: r.readStr(), quantity: r.readU16() };
  },
};

// ---- CraftingQueue ----------------------------------------------------------
// { activeRecipeId: string|null, progressTicks: number, queued: string[] }

export interface CraftingQueueData {
  activeRecipeId: string | null;
  progressTicks: number;
  queued: string[];
}

export const craftingQueueCodec: Serialiser<CraftingQueueData> = {
  encode(v: CraftingQueueData): Uint8Array {
    assertMaxLen("CraftingQueue.queued", v.queued.length, WIRE_LIMITS.craftingQueue);
    const w = new WireWriter();
    if (v.activeRecipeId !== null) { w.writeU8(1); w.writeStr(v.activeRecipeId); } else { w.writeU8(0); }
    w.writeI32(v.progressTicks);
    w.writeU16(v.queued.length);
    for (const id of v.queued) w.writeStr(id);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): CraftingQueueData {
    const r = new WireReader(bytes);
    const hasActive = r.readU8();
    const activeRecipeId = hasActive ? r.readStr() : null;
    const progressTicks = r.readI32();
    const queueLen = r.readU16();
    const queued: string[] = [];
    for (let i = 0; i < queueLen; i++) queued.push(r.readStr());
    return { activeRecipeId, progressTicks, queued };
  },
};

// ---- TraderListing ----------------------------------------------------------
// { itemType: string, buyPrice: number, sellPrice: number, stock: number }

export interface TraderListing {
  itemType: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
}

function writeTraderListing(w: WireWriter, v: TraderListing): void {
  w.writeStr(v.itemType);
  w.writeI32(v.buyPrice);
  w.writeI32(v.sellPrice);
  w.writeI32(v.stock);
}

function readTraderListing(r: WireReader): TraderListing {
  return { itemType: r.readStr(), buyPrice: r.readI32(), sellPrice: r.readI32(), stock: r.readI32() };
}

export const traderListingCodec: Serialiser<TraderListing> = {
  encode(v: TraderListing): Uint8Array {
    const w = new WireWriter();
    writeTraderListing(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): TraderListing {
    return readTraderListing(new WireReader(bytes));
  },
};

// ---- TraderInventory --------------------------------------------------------
// { listings: TraderListing[] }

export interface TraderInventoryData {
  listings: TraderListing[];
}

export const traderInventoryCodec: Serialiser<TraderInventoryData> = {
  encode(v: TraderInventoryData): Uint8Array {
    assertMaxLen("TraderInventory.listings", v.listings.length, WIRE_LIMITS.traderListings);
    const w = new WireWriter();
    w.writeU16(v.listings.length);
    for (const l of v.listings) writeTraderListing(w, l);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): TraderInventoryData {
    const r = new WireReader(bytes);
    const count = r.readU16();
    const listings: TraderListing[] = [];
    for (let i = 0; i < count; i++) listings.push(readTraderListing(r));
    return { listings };
  },
};

// ---- HeritageTrait ----------------------------------------------------------
// { type: string, value: f32, fromGeneration: u32 }

export interface HeritageTrait {
  type: string;
  value: number;
  fromGeneration: number;
}

function writeHeritageTrait(w: WireWriter, v: HeritageTrait): void {
  w.writeStr(v.type);
  w.writeF32(v.value);
  w.writeU32(v.fromGeneration);
}

function readHeritageTrait(r: WireReader): HeritageTrait {
  return { type: r.readStr(), value: r.readF32(), fromGeneration: r.readU32() };
}

export const heritageTraitCodec: Serialiser<HeritageTrait> = {
  encode(v: HeritageTrait): Uint8Array {
    const w = new WireWriter();
    writeHeritageTrait(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): HeritageTrait {
    return readHeritageTrait(new WireReader(bytes));
  },
};

// ---- Heritage ---------------------------------------------------------------
// { dynastyId: string, generation: number, traits: HeritageTrait[] }

export interface HeritageData {
  dynastyId: string;
  generation: number;
  traits: HeritageTrait[];
}

export const heritageCodec: Serialiser<HeritageData> = {
  encode(v: HeritageData): Uint8Array {
    assertMaxLen("Heritage.traits", v.traits.length, WIRE_LIMITS.heritageTraits);
    const w = new WireWriter();
    w.writeStr(v.dynastyId);
    w.writeU32(v.generation);
    w.writeU16(v.traits.length);
    for (const t of v.traits) writeHeritageTrait(w, t);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): HeritageData {
    const r = new WireReader(bytes);
    const dynastyId = r.readStr();
    const generation = r.readU32();
    const traitCount = r.readU16();
    const traits: HeritageTrait[] = [];
    for (let i = 0; i < traitCount; i++) traits.push(readHeritageTrait(r));
    return { dynastyId, generation, traits };
  },
};

// ---- BlueprintMaterial ------------------------------------------------------
// { itemType: string, quantity: number }

export interface BlueprintMaterial {
  itemType: string;
  quantity: number;
}

function writeBlueprintMaterial(w: WireWriter, v: BlueprintMaterial): void {
  w.writeStr(v.itemType);
  w.writeU16(v.quantity);
}

function readBlueprintMaterial(r: WireReader): BlueprintMaterial {
  return { itemType: r.readStr(), quantity: r.readU16() };
}

export const blueprintMaterialCodec: Serialiser<BlueprintMaterial> = {
  encode(v: BlueprintMaterial): Uint8Array {
    const w = new WireWriter();
    writeBlueprintMaterial(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): BlueprintMaterial {
    return readBlueprintMaterial(new WireReader(bytes));
  },
};

// ---- Blueprint --------------------------------------------------------------

export interface BlueprintData {
  structureType: string;
  chunkX: number;
  chunkY: number;
  localX: number;
  localY: number;
  heightDelta: number;
  materialId: number;
  materialCost: BlueprintMaterial[];
  totalTicks: number;
  ticksRemaining: number;
  materialsDeducted: boolean;
}

export const blueprintCodec: Serialiser<BlueprintData> = {
  encode(v: BlueprintData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.structureType);
    w.writeI32(v.chunkX);
    w.writeI32(v.chunkY);
    w.writeU8(v.localX);
    w.writeU8(v.localY);
    w.writeF32(v.heightDelta);
    w.writeU16(v.materialId);
    w.writeU16(v.materialCost.length);
    for (const m of v.materialCost) writeBlueprintMaterial(w, m);
    w.writeI32(v.totalTicks);
    w.writeI32(v.ticksRemaining);
    w.writeU8(v.materialsDeducted ? 1 : 0);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): BlueprintData {
    const r = new WireReader(bytes);
    const structureType = r.readStr();
    const chunkX = r.readI32();
    const chunkY = r.readI32();
    const localX = r.readU8();
    const localY = r.readU8();
    const heightDelta = r.readF32();
    const materialId = r.readU16();
    const costCount = r.readU16();
    const materialCost: BlueprintMaterial[] = [];
    for (let i = 0; i < costCount; i++) materialCost.push(readBlueprintMaterial(r));
    const totalTicks = r.readI32();
    const ticksRemaining = r.readI32();
    const materialsDeducted = r.readU8() !== 0;
    return { structureType, chunkX, chunkY, localX, localY, heightDelta, materialId, materialCost, totalTicks, ticksRemaining, materialsDeducted };
  },
};

// ---- ResourceNode -----------------------------------------------------------
// { nodeTypeId: string, hitPoints: number, depleted: boolean, respawnTicksRemaining: number|null }

export interface ResourceNodeData {
  nodeTypeId: string;
  hitPoints: number;
  depleted: boolean;
  respawnTicksRemaining: number | null;
}

export const resourceNodeCodec: Serialiser<ResourceNodeData> = {
  encode(v: ResourceNodeData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.nodeTypeId);
    w.writeI32(v.hitPoints);
    w.writeU8(v.depleted ? 1 : 0);
    if (v.respawnTicksRemaining !== null) {
      w.writeU8(1); w.writeI32(v.respawnTicksRemaining);
    } else {
      w.writeU8(0);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ResourceNodeData {
    const r = new WireReader(bytes);
    const nodeTypeId = r.readStr();
    const hitPoints = r.readI32();
    const depleted = r.readU8() !== 0;
    const hasRespawn = r.readU8();
    const respawnTicksRemaining = hasRespawn ? r.readI32() : null;
    return { nodeTypeId, hitPoints, depleted, respawnTicksRemaining };
  },
};

// ---- SkillVerb enum map -----------------------------------------------------

export const SKILL_VERB_TO_U8: Record<string, number> = {
  strike: 0,
  invoke: 1,
  ward:   2,
  step:   3,
};

export const U8_TO_SKILL_VERB: string[] = ["strike", "invoke", "ward", "step"];

// ---- LoreSkillSlot ----------------------------------------------------------
// { verb: SkillVerb, outwardFragmentId: string, inwardFragmentId: string }

export interface LoreSkillSlot {
  verb: SkillVerb;
  outwardFragmentId: string;
  inwardFragmentId: string;
}

function writeLoreSkillSlot(w: WireWriter, v: LoreSkillSlot): void {
  w.writeU8(SKILL_VERB_TO_U8[v.verb] ?? 0);
  w.writeStr(v.outwardFragmentId);
  w.writeStr(v.inwardFragmentId);
}

function readLoreSkillSlot(r: WireReader): LoreSkillSlot {
  const verb = (U8_TO_SKILL_VERB[r.readU8()] ?? "strike") as SkillVerb;
  const outwardFragmentId = r.readStr();
  const inwardFragmentId  = r.readStr();
  return { verb, outwardFragmentId, inwardFragmentId };
}

export const loreSkillSlotCodec: Serialiser<LoreSkillSlot> = {
  encode(v: LoreSkillSlot): Uint8Array {
    const w = new WireWriter();
    writeLoreSkillSlot(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): LoreSkillSlot {
    return readLoreSkillSlot(new WireReader(bytes));
  },
};

// ---- LoreLoadout ------------------------------------------------------------
// { skills: (LoreSkillSlot|null)[], learnedFragmentIds: string[], skillCooldowns: number[] }
// Always exactly 4 skill slots and 4 cooldown values.

export interface LoreLoadoutData {
  skills: (LoreSkillSlot | null)[];
  learnedFragmentIds: string[];
  skillCooldowns: number[];
}

export const loreLoadoutCodec: Serialiser<LoreLoadoutData> = {
  encode(v: LoreLoadoutData): Uint8Array {
    const w = new WireWriter();
    // 4 hasSlot flags
    for (let i = 0; i < 4; i++) w.writeU8(v.skills[i] !== null && v.skills[i] !== undefined ? 1 : 0);
    // slot data
    for (let i = 0; i < 4; i++) {
      const s = v.skills[i];
      if (s !== null && s !== undefined) writeLoreSkillSlot(w, s);
    }
    // learned fragment IDs
    w.writeU16(v.learnedFragmentIds.length);
    for (const id of v.learnedFragmentIds) w.writeStr(id);
    // 4 cooldown values (u32)
    for (let i = 0; i < 4; i++) w.writeU32(v.skillCooldowns[i] ?? 0);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): LoreLoadoutData {
    const r = new WireReader(bytes);
    const hasSlot = [r.readU8(), r.readU8(), r.readU8(), r.readU8()];
    const skills: (LoreSkillSlot | null)[] = [];
    for (let i = 0; i < 4; i++) skills.push(hasSlot[i] ? readLoreSkillSlot(r) : null);
    const learnedCount = r.readU16();
    const learnedFragmentIds: string[] = [];
    for (let i = 0; i < learnedCount; i++) learnedFragmentIds.push(r.readStr());
    const skillCooldowns = [r.readU32(), r.readU32(), r.readU32(), r.readU32()];
    return { skills, learnedFragmentIds, skillCooldowns };
  },
};

// ---- ActiveEffect -----------------------------------------------------------
// { effectStat, magnitude, ticksRemaining, sourceEntityId, tickDeltaPerSec? }

export interface ActiveEffect {
  effectStat: string;
  magnitude: number;
  ticksRemaining: number;
  sourceEntityId: string;
  tickDeltaPerSec?: number;
}

function writeActiveEffect(w: WireWriter, v: ActiveEffect): void {
  w.writeStr(v.effectStat);
  w.writeF32(v.magnitude);
  w.writeI32(v.ticksRemaining);
  w.writeStr(v.sourceEntityId);
  if (v.tickDeltaPerSec !== undefined) {
    w.writeU8(1); w.writeF64(v.tickDeltaPerSec);
  } else {
    w.writeU8(0);
  }
}

function readActiveEffect(r: WireReader): ActiveEffect {
  const effectStat = r.readStr();
  const magnitude = r.readF32();
  const ticksRemaining = r.readI32();
  const sourceEntityId = r.readStr();
  const hasTickDelta = r.readU8();
  const tickDeltaPerSec = hasTickDelta ? r.readF64() : undefined;
  return { effectStat, magnitude, ticksRemaining, sourceEntityId, ...(tickDeltaPerSec !== undefined && { tickDeltaPerSec }) };
}

export const activeEffectCodec: Serialiser<ActiveEffect> = {
  encode(v: ActiveEffect): Uint8Array {
    const w = new WireWriter();
    writeActiveEffect(w, v);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ActiveEffect {
    return readActiveEffect(new WireReader(bytes));
  },
};

// ---- ActiveEffects ----------------------------------------------------------
// { effects: ActiveEffect[] }

export interface ActiveEffectsData {
  effects: ActiveEffect[];
}

export const activeEffectsCodec: Serialiser<ActiveEffectsData> = {
  encode(v: ActiveEffectsData): Uint8Array {
    assertMaxLen("ActiveEffects.effects", v.effects.length, WIRE_LIMITS.activeEffects);
    const w = new WireWriter();
    w.writeU16(v.effects.length);
    for (const e of v.effects) writeActiveEffect(w, e);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ActiveEffectsData {
    const r = new WireReader(bytes);
    const count = r.readU16();
    const effects: ActiveEffect[] = [];
    for (let i = 0; i < count; i++) effects.push(readActiveEffect(r));
    return { effects };
  },
};

// ---- NpcTag -----------------------------------------------------------------
// { npcType: string; name: string }
// networked: false — server-only marker component.

export interface NpcTagData {
  npcType: string;
  name: string;
}

export const npcTagCodec: Serialiser<NpcTagData> = {
  encode(d: NpcTagData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(d.npcType);
    w.writeStr(d.name);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): NpcTagData {
    const r = new WireReader(bytes);
    return { npcType: r.readStr(), name: r.readStr() };
  },
};

// ---- NpcJobQueue ------------------------------------------------------------
// Complex union-typed server-only AI state.
// networked: false — never leaves the server; codec needed only for persistence.

export type Job =
  | { type: "idle";          expiresAt: number }
  | { type: "wander";        targetX: number; targetY: number; expiresAt: number }
  | { type: "seekFood";      expiresAt: number }
  | { type: "seekWater";     expiresAt: number }
  | { type: "flee";          fromX: number; fromY: number; expiresAt: number }
  | { type: "attackTarget";  targetId: string; expiresAt: number }
  | {
      type: "craftAtWorkbench";
      workbenchType: string;
      inputs: ReadonlyArray<{ itemType: string; quantity: number }>;
      /** Set once the job handler has resolved a specific workstation entity to approach. */
      workbenchId: string | null;
      /** approach → place → hit → (job cleared). */
      phase: "approach" | "place" | "hit";
      expiresAt: number;
    }
  | {
      type: "gatherResource";
      itemType: string;
      /** Acceptable resource-node prefab ids whose yields include itemType. */
      resourceNodeTypes: ReadonlyArray<string>;
      /** Total inventory count of itemType the NPC wants to end with. */
      targetQuantity: number;
      /** Set once the job handler has resolved a specific node entity to approach. */
      nodeId: string | null;
      expiresAt: number;
    };

export type PlanStep =
  | { kind: "moveTo";   x: number; y: number }
  | { kind: "interact"; targetId: string; verb: string }
  | { kind: "wait";     ticks: number; ticksRemaining: number }
  | { kind: "dropItem"; itemType: string; quantity: number };

export interface NpcPlanData {
  steps: PlanStep[];
  stepIdx: number;
  expiresAt: number;
  lastKnownTargetX?: number;
  lastKnownTargetY?: number;
}

export interface NpcJobQueueData {
  current: Job | null;
  scheduled: Job[];
  plan: NpcPlanData | null;
}

// Job discriminants
const JOB_IDLE        = 0;
const JOB_WANDER      = 1;
const JOB_SEEK_FOOD   = 2;
const JOB_SEEK_WATER  = 3;
const JOB_FLEE        = 4;
const JOB_ATTACK      = 5;
const JOB_CRAFT_AT    = 6;
const JOB_GATHER      = 7;

// craftAtWorkbench phase discriminants
const CRAFT_APPROACH = 0;
const CRAFT_PLACE    = 1;
const CRAFT_HIT      = 2;

// Plan step discriminants
const STEP_MOVE_TO  = 0;
const STEP_INTERACT = 1;
const STEP_WAIT     = 2;
const STEP_DROP     = 3;

function writeJob(w: WireWriter, job: Job): void {
  switch (job.type) {
    case "idle":         w.writeU8(JOB_IDLE);   w.writeI32(job.expiresAt); break;
    case "wander":       w.writeU8(JOB_WANDER); w.writeF32(job.targetX); w.writeF32(job.targetY); w.writeI32(job.expiresAt); break;
    case "seekFood":     w.writeU8(JOB_SEEK_FOOD);  w.writeI32(job.expiresAt); break;
    case "seekWater":    w.writeU8(JOB_SEEK_WATER); w.writeI32(job.expiresAt); break;
    case "flee":         w.writeU8(JOB_FLEE); w.writeF32(job.fromX); w.writeF32(job.fromY); w.writeI32(job.expiresAt); break;
    case "attackTarget": w.writeU8(JOB_ATTACK); w.writeStr(job.targetId); w.writeI32(job.expiresAt); break;
    case "craftAtWorkbench":
      w.writeU8(JOB_CRAFT_AT);
      w.writeStr(job.workbenchType);
      w.writeU8(job.phase === "approach" ? CRAFT_APPROACH : job.phase === "place" ? CRAFT_PLACE : CRAFT_HIT);
      w.writeStr(job.workbenchId ?? "");
      w.writeU16(job.inputs.length);
      for (const inp of job.inputs) { w.writeStr(inp.itemType); w.writeU16(inp.quantity); }
      w.writeI32(job.expiresAt);
      break;
    case "gatherResource":
      w.writeU8(JOB_GATHER);
      w.writeStr(job.itemType);
      w.writeU16(job.targetQuantity);
      w.writeStr(job.nodeId ?? "");
      w.writeU16(job.resourceNodeTypes.length);
      for (const t of job.resourceNodeTypes) w.writeStr(t);
      w.writeI32(job.expiresAt);
      break;
  }
}

function readJob(r: WireReader): Job {
  const kind = r.readU8();
  switch (kind) {
    case JOB_IDLE:       return { type: "idle",          expiresAt: r.readI32() };
    case JOB_WANDER:     return { type: "wander",        targetX: r.readF32(), targetY: r.readF32(), expiresAt: r.readI32() };
    case JOB_SEEK_FOOD:  return { type: "seekFood",      expiresAt: r.readI32() };
    case JOB_SEEK_WATER: return { type: "seekWater",     expiresAt: r.readI32() };
    case JOB_FLEE:       return { type: "flee",          fromX: r.readF32(), fromY: r.readF32(), expiresAt: r.readI32() };
    case JOB_ATTACK:     return { type: "attackTarget",  targetId: r.readStr(), expiresAt: r.readI32() };
    case JOB_CRAFT_AT: {
      const workbenchType = r.readStr();
      const phaseDisc = r.readU8();
      const phase: "approach" | "place" | "hit" =
        phaseDisc === CRAFT_APPROACH ? "approach" :
        phaseDisc === CRAFT_PLACE    ? "place" : "hit";
      const wbid = r.readStr();
      const workbenchId = wbid === "" ? null : wbid;
      const n = r.readU16();
      const inputs: Array<{ itemType: string; quantity: number }> = [];
      for (let i = 0; i < n; i++) inputs.push({ itemType: r.readStr(), quantity: r.readU16() });
      const expiresAt = r.readI32();
      return { type: "craftAtWorkbench", workbenchType, phase, workbenchId, inputs, expiresAt };
    }
    case JOB_GATHER: {
      const itemType = r.readStr();
      const targetQuantity = r.readU16();
      const rawId = r.readStr();
      const nodeId = rawId === "" ? null : rawId;
      const n = r.readU16();
      const resourceNodeTypes: string[] = [];
      for (let i = 0; i < n; i++) resourceNodeTypes.push(r.readStr());
      const expiresAt = r.readI32();
      return { type: "gatherResource", itemType, targetQuantity, nodeId, resourceNodeTypes, expiresAt };
    }
    default: throw new Error(`Unknown job kind: ${kind}`);
  }
}

function writePlanStep(w: WireWriter, step: PlanStep): void {
  switch (step.kind) {
    case "moveTo":   w.writeU8(STEP_MOVE_TO);  w.writeF32(step.x); w.writeF32(step.y); break;
    case "interact": w.writeU8(STEP_INTERACT); w.writeStr(step.targetId); w.writeStr(step.verb); break;
    case "wait":     w.writeU8(STEP_WAIT);     w.writeI32(step.ticks); w.writeI32(step.ticksRemaining); break;
    case "dropItem": w.writeU8(STEP_DROP);     w.writeStr(step.itemType); w.writeU16(step.quantity); break;
  }
}

function readPlanStep(r: WireReader): PlanStep {
  const kind = r.readU8();
  switch (kind) {
    case STEP_MOVE_TO:  return { kind: "moveTo",   x: r.readF32(), y: r.readF32() };
    case STEP_INTERACT: return { kind: "interact", targetId: r.readStr(), verb: r.readStr() };
    case STEP_WAIT:     return { kind: "wait",     ticks: r.readI32(), ticksRemaining: r.readI32() };
    case STEP_DROP:     return { kind: "dropItem", itemType: r.readStr(), quantity: r.readU16() };
    default: throw new Error(`Unknown plan step kind: ${kind}`);
  }
}

export const npcJobQueueCodec: Serialiser<NpcJobQueueData> = {
  encode(d: NpcJobQueueData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(d.current ? 1 : 0);
    if (d.current) writeJob(w, d.current);
    w.writeU16(d.scheduled.length);
    for (const job of d.scheduled) writeJob(w, job);
    w.writeU8(d.plan ? 1 : 0);
    if (d.plan) {
      w.writeU16(d.plan.steps.length);
      for (const step of d.plan.steps) writePlanStep(w, step);
      w.writeU16(d.plan.stepIdx);
      w.writeI32(d.plan.expiresAt);
      const hasTarget = d.plan.lastKnownTargetX !== undefined;
      w.writeU8(hasTarget ? 1 : 0);
      if (hasTarget) { w.writeF32(d.plan.lastKnownTargetX!); w.writeF32(d.plan.lastKnownTargetY!); }
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): NpcJobQueueData {
    const r = new WireReader(bytes);
    const current   = r.readU8() ? readJob(r) : null;
    const numSched  = r.readU16();
    const scheduled: Job[] = [];
    for (let i = 0; i < numSched; i++) scheduled.push(readJob(r));
    let plan: NpcPlanData | null = null;
    if (r.readU8()) {
      const numSteps = r.readU16();
      const steps: PlanStep[] = [];
      for (let i = 0; i < numSteps; i++) steps.push(readPlanStep(r));
      const stepIdx   = r.readU16();
      const expiresAt = r.readI32();
      const hasTarget = r.readU8() !== 0;
      plan = {
        steps, stepIdx, expiresAt,
        lastKnownTargetX: hasTarget ? r.readF32() : undefined,
        lastKnownTargetY: hasTarget ? r.readF32() : undefined,
      };
    }
    return { current, scheduled, plan };
  },
};

// ---- Hitbox ----

/**
 * Hit geometry for an entity. Always server-only.
 *
 * `derive` is the authority flag:
 *   true  — HitboxSystem repopulates `parts` each tick from ModelRef + the
 *           live skeleton pose. Prefabs for animated entities use this.
 *   false — `parts` is static and owned by whoever wrote it (spawner's
 *           one-shot derivation for non-skeletal models, or a prefab with
 *           hand-authored capsule geometry). HitboxSystem ignores the entity.
 */
export interface HitboxData {
  derive: boolean;
  parts: BodyPartVolume[];
}

function writeBodyPart(w: WireWriter, p: BodyPartVolume): void {
  w.writeStr(p.id);
  w.writeF32(p.fromFwd);  w.writeF32(p.fromRight); w.writeF32(p.fromUp);
  w.writeF32(p.toFwd);    w.writeF32(p.toRight);   w.writeF32(p.toUp);
  w.writeF32(p.radius);
}

function readBodyPart(r: WireReader): BodyPartVolume {
  const id        = r.readStr();
  const fromFwd   = r.readF32(); const fromRight = r.readF32(); const fromUp  = r.readF32();
  const toFwd     = r.readF32(); const toRight   = r.readF32(); const toUp    = r.readF32();
  const radius    = r.readF32();
  return { id, fromFwd, fromRight, fromUp, toFwd, toRight, toUp, radius };
}

export const hitboxCodec: Serialiser<HitboxData> = {
  encode(v: HitboxData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.derive ? 1 : 0);
    w.writeU16(v.parts.length);
    for (const p of v.parts) writeBodyPart(w, p);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): HitboxData {
    const r = new WireReader(bytes);
    const derive = r.readU8() === 1;
    const count = r.readU16();
    const parts: BodyPartVolume[] = [];
    for (let i = 0; i < count; i++) parts.push(readBodyPart(r));
    return { derive, parts };
  },
};

// ---- LightEmitter ----------------------------------------------------------
// Emitted by entities that cast light (torch, campfire, hearth, player holding torch).
// color is a packed RGB u32 (0xRRGGBB). intensity 0–1 scales the raw radius.
// flicker 0–1 drives random oscillation amplitude on the client.

export interface LightEmitterData {
  color: number;
  intensity: number;
  radius: number;
  flicker: number;
}

export const lightEmitterCodec: Serialiser<LightEmitterData> = {
  encode(v: LightEmitterData): Uint8Array {
    const w = new WireWriter();
    w.writeU32(v.color);
    w.writeF32(v.intensity);
    w.writeF32(v.radius);
    w.writeF32(v.flicker);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): LightEmitterData {
    const r = new WireReader(bytes);
    return { color: r.readU32(), intensity: r.readF32(), radius: r.readF32(), flicker: r.readF32() };
  },
};

// ---- DarknessModifier -------------------------------------------------------
// Present on entities that suppress ambient light in a radius (deep corruption,
// shadow-cursed creatures). Client darkens tiles within range.

export interface DarknessModifierData {
  radius: number;
  /** 0–1: fraction of ambient light suppressed at the entity center. Falls off to 0 at radius. */
  strength: number;
}

export const darknessModifierCodec: Serialiser<DarknessModifierData> = {
  encode(v: DarknessModifierData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.radius);
    w.writeF32(v.strength);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): DarknessModifierData {
    const r = new WireReader(bytes);
    return { radius: r.readF32(), strength: r.readF32() };
  },
};

// ---- Durability ---- instance-lifetime component.
// Remaining / max uses before the item is worn out. Ticked down by DurabilitySystem
// on each weapon swing; when remaining hits 0 the item is destroyed.

export interface DurabilityData {
  remaining: number;
  max: number;
}

export const durabilityCodec: Serialiser<DurabilityData> = {
  encode(v: DurabilityData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.remaining);
    w.writeF32(v.max);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): DurabilityData {
    const r = new WireReader(bytes);
    return { remaining: r.readF32(), max: r.readF32() };
  },
};

// ---- Inscribed ----
// A lore fragment encoded into a unique item. Written at a scribe workstation;
// read at the "internalise" interaction to grant the fragment to the reader.

export interface InscribedData {
  fragmentId: string;
}

export const inscribedCodec: Serialiser<InscribedData> = {
  encode(v: InscribedData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.fragmentId);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): InscribedData {
    const r = new WireReader(bytes);
    return { fragmentId: r.readStr() };
  },
};

// ---- QualityStamped ----
// Craft-time quality tier in [0, 1]. deriveItemStats() reads this and multiplies
// the relevant derived stats (armour reduction, food/water value, light intensity).

export interface QualityStampedData {
  quality: number;
}

export const qualityStampedCodec: Serialiser<QualityStampedData> = {
  encode(v: QualityStampedData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.quality);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): QualityStampedData {
    const r = new WireReader(bytes);
    return { quality: r.readF32() };
  },
};

// ---- WorkstationBuffer ----
//
// Discriminated-slot buffer. Each populated slot is either:
//   stack  — { itemType, quantity }: raw materials with prefab-defined stats.
//   unique — { entityId, prefabId }: crafted intermediates carrying their own
//            Stats instance component. The entity continues to exist while
//            sitting in the buffer; the crafting system destroys it on
//            consumption.
//
// stationType is intentionally NOT stored here — it lives on WorkstationTag
// on the same entity. Consumers read the tag when they need the type.

export type WorkstationSlot =
  | { kind: "stack";  itemType: string; quantity: number }
  | { kind: "unique"; entityId: string; prefabId: string };

export interface WorkstationBufferData {
  slots: Array<WorkstationSlot | null>;
  capacity: number;
  /** Set by SelectRecipe command for "assembly" step recipes. */
  activeRecipeId: string | null;
}

function writeWorkstationSlot(w: WireWriter, s: WorkstationSlot): void {
  if (s.kind === "stack") {
    w.writeU8(0);
    w.writeStr(s.itemType);
    w.writeU16(s.quantity);
  } else {
    w.writeU8(1);
    w.writeStr(s.entityId);
    w.writeStr(s.prefabId);
  }
}

function readWorkstationSlot(r: WireReader): WorkstationSlot {
  const kind = r.readU8();
  if (kind === 0) {
    return { kind: "stack", itemType: r.readStr(), quantity: r.readU16() };
  }
  return { kind: "unique", entityId: r.readStr(), prefabId: r.readStr() };
}

export const workstationBufferCodec: Serialiser<WorkstationBufferData> = {
  encode(v: WorkstationBufferData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.capacity);
    if (v.activeRecipeId !== null) { w.writeU8(1); w.writeStr(v.activeRecipeId); }
    else                           { w.writeU8(0); }
    w.writeU16(v.slots.length);
    for (const s of v.slots) {
      if (s !== null) { w.writeU8(1); writeWorkstationSlot(w, s); }
      else            { w.writeU8(0); }
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): WorkstationBufferData {
    const r = new WireReader(bytes);
    const capacity       = r.readU8();
    const hasRecipe      = r.readU8() === 1;
    const activeRecipeId = hasRecipe ? r.readStr() : null;
    const count = r.readU16();
    const slots: Array<WorkstationSlot | null> = [];
    for (let i = 0; i < count; i++) {
      const present = r.readU8() === 1;
      if (present) slots.push(readWorkstationSlot(r));
      else         slots.push(null);
    }
    return { capacity, activeRecipeId, slots };
  },
};

// ---- Provenance (item instance) ----
// Records which prefab variant filled each role of the recipe that produced
// this item. Drives tooltip "made of yew_wood, with linen_yarn string" lines
// and the procedural display name. One entry per recipe role; empty for
// items that came from a stack-only recipe with no per-role identity.
//
// Wire layout: [u8 count][for each: writeStr(role) + writeStr(prefabId)].

export type ProvenanceData = ReadonlyArray<{ role: string; prefabId: string }>;

export const provenanceCodec: Serialiser<ProvenanceData> = {
  encode(v: ProvenanceData): Uint8Array {
    const w = new WireWriter();
    if (v.length > 255) throw new Error(`ProvenanceData has ${v.length} entries; max is 255`);
    w.writeU8(v.length);
    for (const e of v) {
      w.writeStr(e.role);
      w.writeStr(e.prefabId);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ProvenanceData {
    const r = new WireReader(bytes);
    const count = r.readU8();
    const out: { role: string; prefabId: string }[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ role: r.readStr(), prefabId: r.readStr() });
    }
    return out;
  },
};

// ---- Stats (item instance) ----
// Open key→f32 map carried by item entities. On raw-material prefabs (a wood
// log, an iron ingot before craft, etc.) the values are authored on the
// prefab; spawnPrefab copies them onto the entity at creation. On crafted
// intermediates the values are computed by the originating recipe's formula
// at craft time.
//
// Wire layout: [u8 count][for each: writeStr(key) + writeF32(value)].
// Capped at 255 stats per item (fits the u8 count); a single item realistically
// carries < 10 stats.

export type StatsData = Record<string, number>;

export const statsCodec: Serialiser<StatsData> = {
  encode(v: StatsData): Uint8Array {
    const w = new WireWriter();
    const keys = Object.keys(v);
    if (keys.length > 255) throw new Error(`StatsData has ${keys.length} entries; max is 255`);
    w.writeU8(keys.length);
    for (const k of keys) {
      w.writeStr(k);
      w.writeF32(v[k]);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): StatsData {
    const r = new WireReader(bytes);
    const count = r.readU8();
    const out: StatsData = {};
    for (let i = 0; i < count; i++) {
      const key = r.readStr();
      out[key] = r.readF32();
    }
    return out;
  },
};

// ---- WorkstationTag ----
// Identifies a station entity's type (workbench, anvil, forge, …) so the
// client can filter recipes for the open workstation panel. qualityTier is a
// craft-time multiplier; clients display it as a metadata badge but don't
// otherwise act on it.

export interface WorkstationTagData {
  stationType: string;
  qualityTier: number;
}

export const workstationTagCodec: Serialiser<WorkstationTagData> = {
  encode(v: WorkstationTagData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.stationType);
    w.writeF32(v.qualityTier);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): WorkstationTagData {
    const r = new WireReader(bytes);
    return { stationType: r.readStr(), qualityTier: r.readF32() };
  },
};

// ---- GateLink ---- variable size (string + u8 + f32)
//
// Networked so the client can render gate markers + the destination label
// (T-145). Edge name is encoded as a u8 ordinal — order is wire format and
// must never change.

export type GateEdge = "north" | "south" | "east" | "west";

export interface GateLinkData {
  destinationTileId: string;
  edge: GateEdge;
  /** World units; visualisation matches the proximity trigger. */
  radius: number;
}

const GATE_EDGE_TO_INT: Record<GateEdge, number> = {
  north: 0, south: 1, east: 2, west: 3,
};
const INT_TO_GATE_EDGE: GateEdge[] = ["north", "south", "east", "west"];

export const gateLinkCodec: Serialiser<GateLinkData> = {
  encode(v: GateLinkData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.destinationTileId);
    w.writeU8(GATE_EDGE_TO_INT[v.edge]);
    w.writeF32(v.radius);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): GateLinkData {
    const r = new WireReader(bytes);
    const destinationTileId = r.readStr();
    const edge = INT_TO_GATE_EDGE[r.readU8()] ?? "north";
    const radius = r.readF32();
    return { destinationTileId, edge, radius };
  },
};

// ---- Name -------------------------------------------------------------------
// Display name for floating labels above an entity's head. Players carry the
// account login the user signed in with; NPCs carry their template's
// `displayName` (e.g. "Wolf"). Empty string = render no label.

export interface NameData {
  value: string;
}

export const nameCodec: Serialiser<NameData> = {
  encode(v: NameData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.value);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): NameData {
    const r = new WireReader(bytes);
    return { value: r.readStr() };
  },
};

// (SwingChain codec retired with the CSM/maneuver teardown — combos are
// cancel-into rules on the action vocabulary now, no networked chain-step
// component. Wire id 46 retired, never reuse.)

// ---- ActorSlots ------------------------------------------------------------
// The declared slot set for an actor (T-226). Set once at spawn from the
// actor template's `actorSlots`; never mutated at runtime. Networked so the
// client's mirrored World can dispatch/predict the same slots.

export interface ActorSlotsData {
  slots: string[];
}

export const actorSlotsCodec: Serialiser<ActorSlotsData> = {
  encode(v: ActorSlotsData): Uint8Array {
    const w = new WireWriter();
    w.writeU16(v.slots.length);
    for (const s of v.slots) w.writeStr(s);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ActorSlotsData {
    const r = new WireReader(bytes);
    const n = r.readU16();
    const slots: string[] = [];
    for (let i = 0; i < n; i++) slots.push(r.readStr());
    return { slots };
  },
};

// ---- ActiveActions ---------------------------------------------------------
// One entry per occupied slot: what action is running there, which phase,
// how many ticks into it, who initiated it, plus an opaque per-resolver
// scratch blob (JSON; replicated so client prediction matches the server).
// Absence of a slot key = nothing running in that slot. The ActionDispatcher
// is the only writer. (T-226)

export interface ActiveActionState {
  actionId: string;
  phase: string;
  ticksInPhase: number;
  initiator: "intent" | "event" | "ambient";
  scratch?: Record<string, unknown>;
}

export interface ActiveActionsData {
  states: Record<string, ActiveActionState>;
}

const ACTIVE_ACTION_INITIATORS = ["intent", "event", "ambient"] as const;

export const activeActionsCodec: Serialiser<ActiveActionsData> = {
  encode(v: ActiveActionsData): Uint8Array {
    const w = new WireWriter();
    const entries = Object.entries(v.states);
    w.writeU16(entries.length);
    for (const [slot, s] of entries) {
      w.writeStr(slot);
      w.writeStr(s.actionId);
      w.writeStr(s.phase);
      w.writeU16(s.ticksInPhase);
      w.writeU8(ACTIVE_ACTION_INITIATORS.indexOf(s.initiator));
      w.writeStr(s.scratch ? JSON.stringify(s.scratch) : "");
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ActiveActionsData {
    const r = new WireReader(bytes);
    const n = r.readU16();
    const states: Record<string, ActiveActionState> = {};
    for (let i = 0; i < n; i++) {
      const slot = r.readStr();
      const actionId = r.readStr();
      const phase = r.readStr();
      const ticksInPhase = r.readU16();
      const initiator = ACTIVE_ACTION_INITIATORS[r.readU8()] ?? "intent";
      const scratchStr = r.readStr();
      const state: ActiveActionState = { actionId, phase, ticksInPhase, initiator };
      if (scratchStr.length > 0) state.scratch = JSON.parse(scratchStr);
      states[slot] = state;
    }
    return { states };
  },
};

// (CharacterStateMachine codec retired — the CSM was fully replaced by the
// action primitive (ActiveActions + ActionDispatcher); the client mirrors
// behaviour from AnimationState now. Wire id 45 retired, never reuse.)
