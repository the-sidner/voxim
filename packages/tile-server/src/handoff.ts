/**
 * Player entity handoff serialization — used when a player crosses a tile boundary.
 *
 * The source tile serializes the player's mutable state into a plain object,
 * sends it to the destination tile via the gateway, and the destination tile
 * restores it as a new entity.
 *
 * Components persisted: Position, Velocity, Facing, Health,
 * Resource (stamina/hunger/thirst/poise/… T-238), Inventory, Equipment,
 * LoreLoadout, ActiveEffects, SpeedModifier.
 *
 * Components NOT persisted: InputState (reset on connect), presence-as-flag
 * combat components like CounterReady and action tags (iframe, blocking,
 * staggered) — all transient, ActiveActions resets on connect
 * — Lifetime (players don't expire),
 * NpcTag (players aren't NPCs).
 */
import type { World, EntityId } from "@voxim/engine";
import { Position, Velocity, Facing, Health } from "./components/game.ts";
import { Resource } from "./components/resource.ts";
import { Inventory } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { SpeedModifier } from "./components/world.ts";

export interface HandoffPayload {
  playerId: string;
  dynastyId: string;
  destinationTileId: string;
  /**
   * Unique per-attempt token. Lets the destination detect and swallow retries
   * (e.g. if the source tile network-timeouts and re-POSTs the same handoff).
   * Destinations track recent tokens and return a fast success on re-delivery.
   */
  handoffId: string;
  /** All serialized component data */
  components: SerializedComponents;
}

interface SerializedComponents {
  position?: ReturnType<typeof Position.codec.decode> | null;
  velocity?: ReturnType<typeof Velocity.codec.decode> | null;
  facing?: ReturnType<typeof Facing.codec.decode> | null;
  health?: ReturnType<typeof Health.codec.decode> | null;
  resource?: ReturnType<typeof Resource.codec.decode> | null;
  inventory?: ReturnType<typeof Inventory.codec.decode> | null;
  equipment?: ReturnType<typeof Equipment.codec.decode> | null;
  loreLoadout?: ReturnType<typeof LoreLoadout.codec.decode> | null;
  activeEffects?: ReturnType<typeof ActiveEffects.codec.decode> | null;
  speedModifier?: ReturnType<typeof SpeedModifier.codec.decode> | null;
}

/**
 * Read all persistent components from a player entity into a plain object.
 * `handoffId` should be a fresh UUID per handoff attempt so the destination can
 * deduplicate retries.
 */
export function serializePlayer(
  world: World,
  playerId: EntityId,
  dynastyId: string,
  destinationTileId: string,
  handoffId: string,
): HandoffPayload {
  return {
    playerId,
    dynastyId,
    destinationTileId,
    handoffId,
    components: {
      position: world.get(playerId, Position) ?? null,
      velocity: world.get(playerId, Velocity) ?? null,
      facing: world.get(playerId, Facing) ?? null,
      health: world.get(playerId, Health) ?? null,
      resource: world.get(playerId, Resource) ?? null,
      inventory: world.get(playerId, Inventory) ?? null,
      equipment: world.get(playerId, Equipment) ?? null,
      loreLoadout: world.get(playerId, LoreLoadout) ?? null,
      activeEffects: world.get(playerId, ActiveEffects) ?? null,
      speedModifier: world.get(playerId, SpeedModifier) ?? null,
    },
  };
}

/**
 * Create a new entity in the world from a handoff payload.
 * The entity's position and dynasty are restored; combat state is reset.
 *
 * Idempotent when the entity already exists: if `payload.playerId` names a live
 * entity (retry of an already-processed handoff), the function returns the
 * existing id without re-creating or overwriting anything.
 */
export function restorePlayer(world: World, payload: HandoffPayload): EntityId {
  const id = payload.playerId as EntityId;
  if (world.isAlive(id)) return id;
  world.create(id);
  const c = payload.components;
  if (c.position) world.write(id, Position, c.position);
  if (c.velocity) world.write(id, Velocity, c.velocity);
  if (c.facing) world.write(id, Facing, c.facing);
  if (c.health) world.write(id, Health, c.health);
  if (c.resource) world.write(id, Resource, c.resource);
  if (c.inventory) world.write(id, Inventory, c.inventory);
  if (c.equipment) world.write(id, Equipment, c.equipment);
  if (c.loreLoadout) world.write(id, LoreLoadout, c.loreLoadout);
  if (c.activeEffects) world.write(id, ActiveEffects, c.activeEffects);
  if (c.speedModifier) world.write(id, SpeedModifier, c.speedModifier);
  return id;
}
