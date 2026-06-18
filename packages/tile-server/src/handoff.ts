/**
 * Player entity handoff (T-140, rebuilt T-256).
 *
 * When a player crosses a tile boundary the source tile serializes the player
 * — AND the item entities they carry — into a JSON payload, ships it to the
 * destination tile via the gateway, and the destination RE-COMPLETES the
 * player there.
 *
 * The v1 handoff shipped eight player components and lost state two ways: the
 * referenced unique item *entities* (Durability/QualityStamped/…) were left
 * behind and orphaned, and `restorePlayer` raw-wrote a component subset, so
 * the reconnect path (which sees the entity already alive and skips
 * `spawnPrefab`) produced a hollow player — no ModelRef (invisible), no Hitbox
 * (unhittable), no ActorSlots (can't act).
 *
 * v2 fixes both with the same re-completion `SpawnedFrom` gives save/load
 * (T-251): carry the player's `prefabId` + position + mutable overlay
 * components + the carried item entities + the fog bitmap; restore the items
 * first, RE-SPAWN the player through `spawnPrefab` (rebuilding the full shell),
 * then overlay the saved state on top (the Inventory/Equipment now point at the
 * restored item entities). Components travel as their decoded data objects
 * keyed by name (JSON-native); fog travels as a raw byte array (its codec is a
 * no-op stub).
 *
 * NOT carried (transient, reset on connect): InputState, the action runtime
 * (ActiveActions), presence-as-flag combat tags (iframe/blocking/staggered),
 * buffs (scene-graph children).
 */
import type { World, EntityId, ComponentDef } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Position, Velocity, Facing, Health, Name } from "./components/game.ts";
import { Resource } from "./components/resource.ts";
import { Inventory } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { LoreLoadout } from "./components/lore_loadout.ts";
import { Heritage } from "./components/heritage.ts";
import { ItemData } from "./components/items.ts";
import { Durability, Inscribed, QualityStamped, Stats, Provenance, History, Owned } from "./components/instance.ts";
import { FogState } from "./components/fog_state.ts";
import { SpawnedFrom } from "./components/spawned_from.ts";
import { DEF_BY_NAME } from "./component_registry.ts";
import { spawnPrefab, destroyCarriedItemEntities } from "./spawner.ts";

/** Player components overlaid onto the re-spawned shell (fog handled separately). */
// deno-lint-ignore no-explicit-any
const PLAYER_OVERLAY_DEFS: ReadonlyArray<ComponentDef<any>> = [
  Position, Velocity, Facing, Health, Resource, Inventory, Equipment, LoreLoadout, Heritage, Name,
];

/** Components a carried unique item entity may hold. */
// deno-lint-ignore no-explicit-any
const ITEM_DEFS: ReadonlyArray<ComponentDef<any>> = [
  ItemData, Durability, Inscribed, QualityStamped, Stats, Provenance, History, Owned,
];

/** A component map: componentName → its decoded data object. */
type ComponentMap = Record<string, unknown>;

interface SerializedEntity {
  entityId: string;
  components: ComponentMap;
}

export interface HandoffPayload {
  playerId: string;
  dynastyId: string;
  destinationTileId: string;
  /** Unique per-attempt token so the destination can dedupe retries. */
  handoffId: string;
  /** Prefab the player was spawned from — the re-completion key (SpawnedFrom). */
  prefabId: string;
  x: number;
  y: number;
  z: number;
  /** Player overlay components (decoded data objects keyed by name). */
  player: ComponentMap;
  /** Carried unique item entities, restored before the player overlay references them. */
  items: SerializedEntity[];
  /** Fog `seenEver` bitmap as a byte array (its codec is a no-op stub). */
  fogSeenEver: number[] | null;
}

/** The entity ids of every unique item this holder carries (inventory + equipment). */
function carriedItemIds(world: World, holderId: EntityId): EntityId[] {
  const ids: EntityId[] = [];
  const inv = world.get(holderId, Inventory);
  for (const slot of inv?.slots ?? []) {
    if (slot?.kind === "unique" && world.isAlive(slot.entityId as EntityId)) ids.push(slot.entityId as EntityId);
  }
  const eq = world.get(holderId, Equipment);
  if (eq) {
    for (const slot of [eq.weapon, eq.offHand, eq.head, eq.chest, eq.legs, eq.feet, eq.back]) {
      if (slot && world.isAlive(slot.entityId as EntityId)) ids.push(slot.entityId as EntityId);
    }
  }
  return ids;
}

/** Read the present components from `defs` on an entity into a name→data map. */
// deno-lint-ignore no-explicit-any
function collect(world: World, id: EntityId, defs: ReadonlyArray<ComponentDef<any>>): ComponentMap {
  const out: ComponentMap = {};
  for (const def of defs) {
    const v = world.get(id, def);
    if (v !== null) out[def.name] = v;
  }
  return out;
}

/** Decode + write a name→data map onto an entity (skips retired component names). */
function overlay(world: World, id: EntityId, components: ComponentMap): void {
  for (const [name, data] of Object.entries(components)) {
    const def = DEF_BY_NAME.get(name);
    if (def) world.write(id, def, data);
  }
}

/**
 * Read the full transferable state of a player — the player itself plus the
 * item entities they carry. `handoffId` should be a fresh UUID per attempt.
 */
export function serializePlayer(
  world: World,
  playerId: EntityId,
  dynastyId: string,
  destinationTileId: string,
  handoffId: string,
): HandoffPayload {
  const pos = world.get(playerId, Position) ?? { x: 256, y: 256, z: 4 };
  const fog = world.get(playerId, FogState);
  return {
    playerId,
    dynastyId,
    destinationTileId,
    handoffId,
    prefabId: world.get(playerId, SpawnedFrom)?.prefabId ?? "player",
    x: pos.x, y: pos.y, z: pos.z,
    player: collect(world, playerId, PLAYER_OVERLAY_DEFS),
    items: carriedItemIds(world, playerId).map((id) => ({
      entityId: id,
      components: collect(world, id, ITEM_DEFS),
    })),
    fogSeenEver: fog ? Array.from(fog.seenEver) : null,
  };
}

/**
 * Re-complete a handed-off player on the destination tile: restore the carried
 * item entities, RE-SPAWN the player from its prefab (full visual shell +
 * archetype installers), then overlay the saved state on top.
 *
 * Idempotent: a retry naming an already-live player returns without touching
 * the world (the admin-server dedupes most retries upstream; this is the
 * backstop).
 */
export function restorePlayer(world: World, content: ContentService, payload: HandoffPayload): EntityId {
  const id = payload.playerId as EntityId;
  if (world.isAlive(id)) return id;

  // 1. Carried item entities first — the player's Inventory/Equipment overlay
  //    references them by id, so they must exist before the overlay lands.
  for (const item of payload.items) {
    const itemId = item.entityId as EntityId;
    if (world.isAlive(itemId)) continue;
    world.create(itemId);
    overlay(world, itemId, item.components);
  }

  // 2. Re-spawn the player through the full pipeline (ModelRef, Hitbox,
  //    ActorSlots, FogState, default loadout + throwaway starter equipment).
  spawnPrefab(world, content, payload.prefabId || "player", {
    id, x: payload.x, y: payload.y, z: payload.z,
  });

  // 3. Drop the starter equipment the fresh spawn created — the real gear
  //    arrives via the Equipment overlay below. Runs before the overlay so it
  //    can't destroy the just-restored carried items (different entity ids).
  destroyCarriedItemEntities(world, id);

  // 4. Overlay the saved player state on the fresh shell.
  overlay(world, id, payload.player);

  // 5. Fog bitmap — its codec is a no-op, so it rides as raw bytes.
  if (payload.fogSeenEver) {
    const seen = world.get(id, FogState)?.seenEver;
    if (seen && seen.length === payload.fogSeenEver.length) {
      seen.set(payload.fogSeenEver);
      world.write(id, FogState, { seenEver: seen, revealedThisTick: [], pendingSnapshot: true });
    }
  }

  return id;
}
