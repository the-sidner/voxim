// @voxim/codecs — Serialiser implementations
// Depends on: @voxim/engine (for the Serialiser interface type)

export { buildCodec, encodeF64, decodeF64, encodeF32, decodeF32, encodeI32, decodeI32 } from "./src/binary.ts";

export type {
  PositionData, VelocityData, FacingData, HeightmapData, MaterialGridData,
  ItemPart, ModelRefData, AnimationStateData, SkillVerb, SkillEffectStat,
  InventorySlot, StaminaData, CombatStateData, EquipmentData, InventoryData,
  ItemDataData, CraftingQueueData, TraderListing, TraderInventoryData,
  HeritageTrait, HeritageData, BlueprintMaterial, BlueprintData,
  ResourceNodeData, LoreSkillSlot, LoreLoadoutData, ActiveEffect, ActiveEffectsData,
  NpcTagData, Job, PlanStep, NpcPlanData, NpcJobQueueData,
  HitboxData,
} from "./src/components.ts";
export {
  positionCodec, velocityCodec, facingCodec, heightmapCodec, materialGridCodec,
  itemPartCodec, inventorySlotCodec,
  staminaCodec, combatStateCodec, modelRefCodec, animationStateCodec,
  equipmentCodec, inventoryCodec, itemDataCodec, craftingQueueCodec,
  traderListingCodec, traderInventoryCodec,
  heritageTraitCodec, heritageCodec,
  blueprintMaterialCodec, blueprintCodec,
  resourceNodeCodec,
  SKILL_VERB_TO_U8, U8_TO_SKILL_VERB, SKILL_EFFECT_STAT_TO_U8, U8_TO_SKILL_EFFECT_STAT,
  loreSkillSlotCodec, loreLoadoutCodec,
  activeEffectCodec, activeEffectsCodec,
  npcTagCodec, npcJobQueueCodec,
  hitboxCodec,
} from "./src/components.ts";

export { uuidToBytes, bytesToUuid } from "./src/uuid.ts";
export { WireWriter, WireReader } from "./src/wire.ts";
