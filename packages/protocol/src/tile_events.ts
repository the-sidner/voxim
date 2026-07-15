/**
 * Tile event bus symbols and payload types.
 *
 * Published by the tile server after applyChangeset() each tick.
 * Consumers: NPC AI, world event bus bridge, client-side UI/audio triggers.
 *
 * Every event with a wire face derives its payload from the GameEvent
 * interface in messages.ts (`Omit<XEvent, "type">`) — publisher, internal
 * subscribers, and the event registry's `translate` all share that ONE
 * shape, so the bus payload cannot drift from the wire again (T-359).
 * Server-only events (no GameEvent counterpart) keep hand-written
 * interfaces here.
 *
 * Usage:
 *   bus.subscribe(TileEvents.EntityDied, (e: EntityDiedPayload) => { ... })
 *   bus.publish(TileEvents.DamageDealt, { ... })
 */
import type { EntityId } from "@voxim/engine";
import type {
  BuildingCompletedEvent,
  BuildingMaterialsConsumedEvent,
  BuildingMissingMaterialsEvent,
  CraftingCompletedEvent,
  DamageDealtEvent,
  DayPhaseChangedEvent,
  EnclosureChangedEvent,
  EntityDiedEvent,
  GateApproachedEvent,
  HealedEvent,
  HitSparkEvent,
  LoreExternalisedEvent,
  LoreInternalisedEvent,
  NodeDepletedEvent,
  TradeCompletedEvent,
} from "./messages.ts";

export const TileEvents = {
  EntityDied: Symbol("EntityDied"),
  DamageDealt: Symbol("DamageDealt"),
  HitSpark: Symbol("HitSpark"),
  CraftingCompleted: Symbol("CraftingCompleted"),
  BuildingCompleted: Symbol("BuildingCompleted"),
  BuildingMaterialsConsumed: Symbol("BuildingMaterialsConsumed"),
  BuildingMissingMaterials: Symbol("BuildingMissingMaterials"),
  HungerCritical: Symbol("HungerCritical"),
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
  /**
   * Published by EnclosureSystem (T-065 server core, T-066 wire face) after
   * it recomputes the enclosed-cell set and it differs from last time. Tile-
   * wide broadcast (like DayPhaseChanged) — not scoped to one player, since
   * a building's roof is visible to everyone near it. Carries the FULL
   * current enclosed-cell set (not a diff): the client rebuilds its roof
   * geometry wholesale on each change, which is simpler and cheap (an
   * enclosure recomputes only on wall completion, not every tick).
   */
  EnclosureChanged: Symbol("EnclosureChanged"),
} as const;

// ---- wire-backed payloads: the GameEvent shape minus the discriminant ----

export type EntityDiedPayload = Omit<EntityDiedEvent, "type">;
export type DamageDealtPayload = Omit<DamageDealtEvent, "type">;
export type HitSparkPayload = Omit<HitSparkEvent, "type">;
export type CraftingCompletedPayload = Omit<CraftingCompletedEvent, "type">;
export type BuildingCompletedPayload = Omit<BuildingCompletedEvent, "type">;
export type BuildingMaterialsConsumedPayload = Omit<BuildingMaterialsConsumedEvent, "type">;
export type BuildingMissingMaterialsPayload = Omit<BuildingMissingMaterialsEvent, "type">;
export type HealedPayload = Omit<HealedEvent, "type">;
export type GateApproachedPayload = Omit<GateApproachedEvent, "type">;
export type NodeDepletedPayload = Omit<NodeDepletedEvent, "type">;
export type DayPhaseChangedPayload = Omit<DayPhaseChangedEvent, "type">;
export type TradeCompletedPayload = Omit<TradeCompletedEvent, "type">;
export type LoreExternalisedPayload = Omit<LoreExternalisedEvent, "type">;
export type LoreInternalisedPayload = Omit<LoreInternalisedEvent, "type">;
export type EnclosureChangedPayload = Omit<EnclosureChangedEvent, "type">;

/**
 * Published by the generic `emit_event` resource effect, whose payload is
 * always `{ entityId, value }` — the wire face (HungerCriticalEvent)
 * carries only `entityId`; `value` is the resource reading at the
 * threshold cross, available to server-side subscribers.
 */
export interface HungerCriticalPayload {
  entityId: EntityId;
  value: number;
}

// ---- server-only payloads (no GameEvent counterpart) ----

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
