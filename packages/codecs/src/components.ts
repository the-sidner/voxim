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

// ============================================================================
// Phase 2 codecs — game component binary layouts
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

// ---- Stamina ----------------------------------------------------------------
// { current: f32, max: f32, regenPerSecond: f32, exhausted: boolean }

export interface StaminaData {
  current: number;
  max: number;
  regenPerSecond: number;
  exhausted: boolean;
}

export const staminaCodec: Serialiser<StaminaData> = {
  encode(v: StaminaData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.current);
    w.writeF32(v.max);
    w.writeF32(v.regenPerSecond);
    w.writeU8(v.exhausted ? 1 : 0);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): StaminaData {
    const r = new WireReader(bytes);
    return {
      current: r.readF32(),
      max: r.readF32(),
      regenPerSecond: r.readF32(),
      exhausted: r.readU8() !== 0,
    };
  },
};

// ---- CombatState ------------------------------------------------------------
// { blockHeldTicks, staggerTicksRemaining, counterReady, iFrameTicksRemaining, dodgeCooldownTicks }

export interface CombatStateData {
  blockHeldTicks: number;
  staggerTicksRemaining: number;
  counterReady: boolean;
  iFrameTicksRemaining: number;
  dodgeCooldownTicks: number;
}

export const combatStateCodec: Serialiser<CombatStateData> = {
  encode(v: CombatStateData): Uint8Array {
    const w = new WireWriter();
    w.writeI32(v.blockHeldTicks);
    w.writeI32(v.staggerTicksRemaining);
    w.writeU8(v.counterReady ? 1 : 0);
    w.writeI32(v.iFrameTicksRemaining);
    w.writeI32(v.dodgeCooldownTicks);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): CombatStateData {
    const r = new WireReader(bytes);
    return {
      blockHeldTicks: r.readI32(),
      staggerTicksRemaining: r.readI32(),
      counterReady: r.readU8() !== 0,
      iFrameTicksRemaining: r.readI32(),
      dodgeCooldownTicks: r.readI32(),
    };
  },
};

// ---- ModelRef ---------------------------------------------------------------
// { modelId: string, scaleX: f32, scaleY: f32, scaleZ: f32, seed: u32 }
// Note: ModelRefData also has optional materialBindings — not transmitted over the wire
// (server never needs to round-trip that field).

export const modelRefCodec: Serialiser<ModelRefData> = {
  encode(v: ModelRefData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.modelId);
    w.writeF32(v.scaleX);
    w.writeF32(v.scaleY);
    w.writeF32(v.scaleZ);
    w.writeU32(v.seed);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ModelRefData {
    const r = new WireReader(bytes);
    return {
      modelId: r.readStr(),
      scaleX: r.readF32(),
      scaleY: r.readF32(),
      scaleZ: r.readF32(),
      seed: r.readU32(),
    };
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
// Each slot holds the EntityId of the equipped item entity, or null if empty.
// Equipment slots store EntityIds, not inline item data — stat reads go through
// the item entity's ItemData component.

export interface EquipmentData {
  weapon:  string | null;
  offHand: string | null;
  head:    string | null;
  chest:   string | null;
  legs:    string | null;
  feet:    string | null;
  back:    string | null;
}

function writeSlot(w: WireWriter, slot: string | null): void {
  if (slot !== null) { w.writeU8(1); w.writeStr(slot); } else { w.writeU8(0); }
}

function readSlot(r: WireReader): string | null {
  return r.readU8() ? r.readStr() : null;
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

// ---- Durability ---- (T-117 Phase 4 — instance-lifetime component)
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

// ---- Inscribed ---- (T-117 Phase 4)
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

// ---- QualityStamped ---- (T-117 Phase 4)
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
// Wire layout:
//   capacity:       u8
//   activeRecipeId: u8 present + [u16 len][UTF-8 bytes] if present
//   progressTicks:  i32 (-1 = null)
//   slots:          [u16 count] per slot: u8 present + [u16 str][u16 qty] if present
//
// stationType is intentionally NOT stored here — it lives on WorkstationTag
// on the same entity. Consumers read the tag when they need the type.

export interface WorkstationSlot {
  itemType: string;
  quantity: number;
}

export interface WorkstationBufferData {
  slots: Array<WorkstationSlot | null>;
  capacity: number;
  /** Set by SelectRecipe command for "assembly" step recipes. */
  activeRecipeId: string | null;
  /** Countdown for "time" step recipes. null when idle. */
  progressTicks: number | null;
}

export const workstationBufferCodec: Serialiser<WorkstationBufferData> = {
  encode(v: WorkstationBufferData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.capacity);
    if (v.activeRecipeId !== null) { w.writeU8(1); w.writeStr(v.activeRecipeId); }
    else                           { w.writeU8(0); }
    w.writeI32(v.progressTicks ?? -1);
    w.writeU16(v.slots.length);
    for (const s of v.slots) {
      if (s !== null) { w.writeU8(1); w.writeStr(s.itemType); w.writeU16(s.quantity); }
      else            { w.writeU8(0); }
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): WorkstationBufferData {
    const r = new WireReader(bytes);
    const capacity       = r.readU8();
    const hasRecipe      = r.readU8() === 1;
    const activeRecipeId = hasRecipe ? r.readStr() : null;
    const rawTicks       = r.readI32();
    const progressTicks  = rawTicks < 0 ? null : rawTicks;
    const count = r.readU16();
    const slots: Array<WorkstationSlot | null> = [];
    for (let i = 0; i < count; i++) {
      const present = r.readU8() === 1;
      if (present) { const itemType = r.readStr(); const quantity = r.readU16(); slots.push({ itemType, quantity }); }
      else         { slots.push(null); }
    }
    return { capacity, activeRecipeId, progressTicks, slots };
  },
};
