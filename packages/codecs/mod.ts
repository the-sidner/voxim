// @voxim/codecs — Serialiser implementations
// Depends on: @voxim/engine (for the Serialiser interface type)

export { buildCodec, encodeF64, decodeF64, encodeF32, decodeF32, encodeI32, decodeI32 } from "./src/binary.ts";

export type {
  PositionData, VelocityData, FacingData, HeightmapData, MaterialGridData, OpenMaskData, KindGridData,
  ItemPart, ModelRefData, AnimationStateData, SkillVerb,
  InputStateData, HealthData, LifetimeData,
  InventorySlot, CounterReadyData, EquipmentSlot, EquipmentData, InventoryData,
  ItemDataData, CraftingQueueData, TraderListing, TraderInventoryData,
  HeritageTrait, HeritageData, BlueprintMaterial, BlueprintData,
  ResourceNodeData, LoreSkillSlot, LoreLoadoutData, ActiveEffect, ActiveEffectsData,
  NpcTagData, Job, PlanStep, NpcPlanData, NpcJobQueueData,
  HitboxData,
  WorkstationSlot, WorkstationBufferData, WorkstationTagData,
  StatsData, ProvenanceData,
  LightEmitterData, DarknessModifierData,
  DurabilityData, InscribedData, QualityStampedData,
  GateEdge, GateLinkData,
  NameData,
  ActorSlotsData,
  ActiveActionState,
  ActiveActionsData,
} from "./src/components.ts";
export {
  positionCodec, velocityCodec, facingCodec, heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec,
  itemPartCodec, inventorySlotCodec,
  inputStateCodec, healthCodec, lifetimeCodec,
  counterReadyCodec, modelRefCodec, animationStateCodec,
  equipmentCodec, inventoryCodec, itemDataCodec, craftingQueueCodec,
  traderListingCodec, traderInventoryCodec,
  heritageTraitCodec, heritageCodec,
  blueprintMaterialCodec, blueprintCodec,
  resourceNodeCodec,
  SKILL_VERB_TO_U8, U8_TO_SKILL_VERB,
  loreSkillSlotCodec, loreLoadoutCodec,
  activeEffectCodec, activeEffectsCodec,
  npcTagCodec, npcJobQueueCodec,
  hitboxCodec,
  workstationBufferCodec, workstationTagCodec,
  statsCodec, provenanceCodec,
  lightEmitterCodec, darknessModifierCodec,
  durabilityCodec, inscribedCodec, qualityStampedCodec,
  gateLinkCodec,
  nameCodec,
  actorSlotsCodec,
  activeActionsCodec,
  WIRE_LIMITS,
} from "./src/components.ts";

export { uuidToBytes, bytesToUuid } from "./src/uuid.ts";
export { WireWriter, WireReader } from "./src/wire.ts";
