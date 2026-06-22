/**
 * Tile event bus symbols and payload types.
 *
 * Published by the tile server after applyChangeset() each tick.
 * Consumers: NPC AI, world event bus bridge, client-side UI/audio triggers.
 *
 * Usage:
 *   bus.subscribe(TileEvents.EntityDied, (e: EntityDiedPayload) => { ... })
 *   bus.publish(TileEvents.DamageDealt, { ... })
 */
import type { EntityId } from "@voxim/engine";

export const TileEvents = {
  EntityDied: Symbol("EntityDied"),
  DamageDealt: Symbol("DamageDealt"),
  HitSpark: Symbol("HitSpark"),
  CraftingCompleted: Symbol("CraftingCompleted"),
  BuildingCompleted: Symbol("BuildingCompleted"),
  BuildingMaterialsConsumed: Symbol("BuildingMaterialsConsumed"),
  BuildingMissingMaterials: Symbol("BuildingMissingMaterials"),
  HungerCritical: Symbol("HungerCritical"),
  ThirstCritical: Symbol("ThirstCritical"),
  Healed: Symbol("Healed"),
  GateApproached: Symbol("GateApproached"),
  NodeDepleted: Symbol("NodeDepleted"),
  DayPhaseChanged: Symbol("DayPhaseChanged"),
  /**
   * Published by PlacementSystem after a Place command spawns a world
   * entity. Subscribers react to prefab-specific side-effects (hearth
   * anchor update, city-claim tracker, etc.) without PlacementSystem
   * having to know about any of them. Server-side only.
   */
  EntityDeployed: Symbol("EntityDeployed"),
  /**
   * The reified hit fact (T-259): published by HealthHitHandler after a
   * hit fully resolves (block/parry/damage/poise), carrying who hit whom,
   * where, for how much. Consumed by the TriggerSystem's collectors (the
   * `hit_landed` catalog kind) — content-defined on-hit triggers fire off
   * it next tick. Server-side only; DamageDealt covers the client face.
   */
  HitLanded: Symbol("HitLanded"),
  /**
   * A loud sound emitted at a world point (T-040): combat, a sprinting actor,
   * a thrown object landing. Published by NoiseSystem when an actor's
   * `NoiseLevel` crosses the perception threshold. Consumed server-side by
   * the NPC sensory system, which aggros nearby NPCs toward the source — an
   * NPC investigates a commotion it can hear even outside its visual cone.
   * Server-side only; no client face.
   */
  LoudNoise: Symbol("LoudNoise"),
  TradeCompleted: Symbol("TradeCompleted"),
  LoreExternalised: Symbol("LoreExternalised"),
  LoreInternalised: Symbol("LoreInternalised"),
} as const;

export interface EntityDiedPayload {
  entityId: EntityId;
  killerId?: EntityId;
}

export interface HitSparkPayload {
  x: number;
  y: number;
  z: number;
}

export interface DamageDealtPayload {
  targetId: EntityId;
  sourceId: EntityId;
  amount: number;
  blocked: boolean;
  /** Which body part was struck. Empty string for parried hits (no contact). */
  bodyPart: string;
  /** World-space contact point — midpoint between closest points on blade and hit capsule. */
  hitX: number;
  hitY: number;
  hitZ: number;
}

export interface CraftingCompletedPayload {
  crafterId: EntityId;
  recipeId: string;
}

export interface HungerCriticalPayload {
  entityId: EntityId;
  value: number;
}

export interface HealedPayload {
  entityId: EntityId;
  amount: number;
}

export interface ThirstCriticalPayload {
  entityId: EntityId;
  value: number;
}

export interface BuildingCompletedPayload {
  builderId: EntityId;
  blueprintId: EntityId;
  structureType: string;
}

export interface BuildingMaterial {
  itemType: string;
  quantity: number;
}

export interface BuildingMaterialsConsumedPayload {
  builderId: EntityId;
  structureType: string;
  consumed: BuildingMaterial[];
}

export interface BuildingMissingMaterialsPayload {
  builderId: EntityId;
  structureType: string;
  missing: BuildingMaterial[];
}

export interface GateApproachedPayload {
  entityId: EntityId;
  gateId: string;
  destinationTileId: string;
}

export interface NodeDepletedPayload {
  nodeId: EntityId;
  nodeTypeId: string;
  harvesterId: EntityId;
}

export interface DayPhaseChangedPayload {
  phase: string;
  timeOfDay: number;
}

export interface HitLandedPayload {
  attackerId: EntityId;
  targetId: EntityId;
  bodyPart: string;
  damage: number;
  blocked: boolean;
}

export interface LoudNoisePayload {
  /** World-space origin of the sound. */
  x: number;
  y: number;
  /** The actor that made the noise (the entity nearby NPCs aggro toward). */
  sourceId: EntityId;
  /** Loudness in [0,1] — how far the sound carries (NoiseLevel of the source). */
  intensity: number;
}

export interface EntityDeployedPayload {
  placerId: EntityId;
  entityId: EntityId;
  prefabId: string;
  worldX: number;
  worldY: number;
  worldZ: number;
}

export interface TradeCompletedPayload {
  buyerId: EntityId;
  traderId: EntityId;
  itemType: string;
  quantity: number;
  coinDelta: number;
}

export interface LoreExternalisedPayload {
  entityId: EntityId;
  fragmentId: string;
}

export interface LoreInternalisedPayload {
  entityId: EntityId;
  fragmentId: string;
}
