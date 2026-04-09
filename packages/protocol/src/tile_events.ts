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
  CraftingCompleted: Symbol("CraftingCompleted"),
  BuildingCompleted: Symbol("BuildingCompleted"),
  HungerCritical: Symbol("HungerCritical"),
  ThirstCritical: Symbol("ThirstCritical"),
  GateApproached: Symbol("GateApproached"),
  NodeDepleted: Symbol("NodeDepleted"),
  DayPhaseChanged: Symbol("DayPhaseChanged"),
  SkillActivated: Symbol("SkillActivated"),
  TradeCompleted: Symbol("TradeCompleted"),
  LoreExternalised: Symbol("LoreExternalised"),
  LoreInternalised: Symbol("LoreInternalised"),
} as const;

export interface EntityDiedPayload {
  entityId: EntityId;
  killerId?: EntityId;
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
