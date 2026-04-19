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
  GateApproached: Symbol("GateApproached"),
  NodeDepleted: Symbol("NodeDepleted"),
  DayPhaseChanged: Symbol("DayPhaseChanged"),
  SkillActivated: Symbol("SkillActivated"),
  /**
   * Published by PlacementSystem after a Place command spawns a world
   * entity. Subscribers react to prefab-specific side-effects (hearth
   * anchor update, city-claim tracker, etc.) without PlacementSystem
   * having to know about any of them. Server-side only.
   */
  EntityDeployed: Symbol("EntityDeployed"),
  /**
   * Published by a hit handler when a melee hit lands and the attacker's
   * SkillInProgress carries a pending "strike:<slot>" verb. Consumed by
   * SkillSystem via a real-bus subscriber registered at construction; the
   * subscriber runs during the post-changeset flush, so stamina / cooldown /
   * effect writes land in the next tick's changeset. Server-side only —
   * never translated into a client GameEvent (the visible DamageDealt and
   * SkillActivated events already cover the user-facing side).
   */
  StrikeLanded: Symbol("StrikeLanded"),
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

export interface SkillActivatedPayload {
  casterId: EntityId;
  slot: number;
  effectType: string;
}

export interface StrikeLandedPayload {
  casterId: EntityId;
  slot: number;
  targetId: EntityId;
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
