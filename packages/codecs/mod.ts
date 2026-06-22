// @voxim/codecs — Serialiser implementations
// Depends on: @voxim/engine (for the Serialiser interface type)

export { buildCodec, encodeF64, decodeF64, encodeF32, decodeF32, encodeI32, decodeI32 } from "./src/binary.ts";

export type {
  PositionData, VelocityData, FacingData, HeightmapData, MaterialGridData, OpenMaskData, KindGridData,
  ItemPart, ModelRefData, AnimationStateData,
  InputStateData, HealthData,
  InventorySlot, EquipmentSlot, EquipmentData, InventoryData,
  ResourceValue, ResourceData,
  ActionCooldownsData,
  ItemDataData, CraftingQueueData, TraderListing, TraderInventoryData,
  JobBoardEntry, JobBoardData,
  HeritageTrait, HeritageData, BlueprintMaterial, BlueprintData,
  ResourceNodeData, LoreLoadoutData,
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
  inputStateCodec, healthCodec,
  resourceCodec, actionCooldownsCodec,
  modelRefCodec, animationStateCodec,
  equipmentCodec, inventoryCodec, itemDataCodec, craftingQueueCodec,
  traderListingCodec, traderInventoryCodec,
  jobBoardCodec,
  heritageTraitCodec, heritageCodec,
  blueprintMaterialCodec, blueprintCodec,
  resourceNodeCodec,
  loreLoadoutCodec,
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
