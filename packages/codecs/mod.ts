// @voxim/codecs — Serialiser implementations
// Depends on: @voxim/engine (for the Serialiser interface type)

export { buildCodec, encodeF64, decodeF64, encodeF32, decodeF32, encodeI32, decodeI32 } from "./src/binary.ts";

export type {
  PositionData, VelocityData, FacingData, HeightmapData, MaterialGridData, OpenMaskData, KindGridData,
  VegFieldGridData, SurfaceStateGridData, WaterGridData, CliffGridData,
  ItemPart, ModelRefData, AnimationStateData,
  HealthData, WorldClockData,
  InventorySlot, EquipmentSlot, EquipmentData, InventoryData,
  ResourceValue, ResourceData,
  ActionCooldownsData,
  ItemDataData, TraderListing, TraderInventoryData,
  JobBoardEntry, JobBoardData,
  HeritageTrait, HeritageData, BlueprintMaterial, BlueprintData,
  ResourceNodeData, LoreLoadoutData,
  WorkstationSlot, WorkstationBufferData, WorkstationTagData,
  StatsData, ProvenanceData,
  LightEmitterData,
  DurabilityData,
  GateEdge, GateLinkData,
  ContainerKind, ContainerSlot, ContainerData,
  NameData,
  ActiveActionState,
  ActiveActionsData,
  PoiInteractableData,
  BoneData,
} from "./src/components.ts";
export {
  positionCodec, velocityCodec, facingCodec, heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec,
  vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec, cliffGridCodec,
  itemPartCodec, inventorySlotCodec,
  healthCodec, worldClockCodec,
  resourceCodec, actionCooldownsCodec,
  modelRefCodec, animationStateCodec,
  equipmentCodec, inventoryCodec, itemDataCodec,
  traderListingCodec, traderInventoryCodec,
  jobBoardCodec,
  heritageTraitCodec, heritageCodec,
  blueprintMaterialCodec, blueprintCodec,
  resourceNodeCodec,
  loreLoadoutCodec,
  workstationBufferCodec, workstationTagCodec,
  statsCodec, provenanceCodec,
  lightEmitterCodec,
  durabilityCodec,
  gateLinkCodec,
  containerCodec,
  nameCodec,
  activeActionsCodec,
  poiInteractableCodec,
  boneCodec,
  WIRE_LIMITS,
} from "./src/components.ts";

export { uuidToBytes, bytesToUuid } from "./src/uuid.ts";
export { WireWriter, WireReader } from "./src/wire.ts";
