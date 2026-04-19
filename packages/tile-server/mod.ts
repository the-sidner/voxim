// @voxim/tile-server — authoritative tile process
// Depends on: @voxim/engine, @voxim/codecs, @voxim/world, @voxim/protocol, @voxim/content

export { TileServer } from "./src/server.ts";
export type { TileServerConfig } from "./src/server.ts";

// Game components (also consumed by tests and future headless client)
export {
  Position,
  Velocity,
  Facing,
  InputState,
  Health,
  Hunger,
  Thirst,
  Stamina,
  Lifetime,
} from "./src/components/game.ts";
export type {
  PositionData,
  VelocityData,
  FacingData,
  InputStateData,
  HealthData,
  HungerData,
  ThirstData,
  StaminaData,
  LifetimeData,
} from "./src/components/game.ts";
export {
  SkillInProgress,
  Staggered, CounterReady, IFrameActive, BlockHeld, DodgeCooldown,
} from "./src/components/combat.ts";
export type {
  SkillInProgressData, HitRecord,
  IFrameActiveData, BlockHeldData, DodgeCooldownData,
} from "./src/components/combat.ts";

// NPC components
export { NpcTag, NpcJobQueue } from "./src/components/npcs.ts";
export type { NpcTagData, NpcJobQueueData, Job } from "./src/components/npcs.ts";

// Item / crafting components
export { ItemData, Inventory, CraftingQueue, InteractCooldown } from "./src/components/items.ts";
export type {
  ItemDataData,
  InventoryData,
  InventorySlot,
  CraftingQueueData,
  InteractCooldownData,
} from "./src/components/items.ts";

// Heritage — component lives on entities; persistence is owned by the
// gateway-hosted account service. The tile server reads/writes it via
// AccountClient.
export { Heritage } from "./src/components/heritage.ts";
export type { HeritageData, HeritageTrait } from "./src/components/heritage.ts";
export { AccountClient, maxHealthFor, heritageHealthBonus } from "./src/account_client.ts";
export type { SessionInfo } from "./src/account_client.ts";

// Equipment component
export { Equipment } from "./src/components/equipment.ts";
export type { EquipmentData } from "./src/components/equipment.ts";

// Building component
export { Blueprint } from "./src/components/building.ts";
export type { BlueprintData, BlueprintMaterial } from "./src/components/building.ts";

export { InputRingBuffer } from "./src/input_buffer.ts";
export { StateHistoryBuffer } from "./src/state_history.ts";
export type { TickSnapshot, EntitySnapshot } from "./src/state_history.ts";

// Resource node component
export { ResourceNode } from "./src/components/resource_node.ts";
export type { ResourceNodeData } from "./src/components/resource_node.ts";

// World-state components
export { WorldClock, TileCorruption, CorruptionExposure, SpeedModifier } from "./src/components/world.ts";
export type {
  WorldClockData,
  TileCorruptionData,
  CorruptionExposureData,
  SpeedModifierData,
} from "./src/components/world.ts";

// Spawner
export { spawnPrefab } from "./src/spawner.ts";
export type { SpawnPrefabOverrides } from "./src/spawner.ts";

// Lore / skill components
export { LoreLoadout, ActiveEffects } from "./src/components/lore_loadout.ts";
export type {
  LoreSkillSlot,
  LoreLoadoutData,
  ActiveEffect,
  ActiveEffectsData,
} from "./src/components/lore_loadout.ts";

// Trader component
export { TraderInventory } from "./src/components/trader.ts";
export type { TraderInventoryData, TraderListing } from "./src/components/trader.ts";

// World persistence
export { SaveManager } from "./src/save_manager.ts";
