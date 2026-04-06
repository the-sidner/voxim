/**
 * Area-of-Interest (AoI) filter — per-session entity lifecycle.
 *
 * Each tick, for each connected session:
 *   1. Build the set of entities visible to this player (terrain + spatial radius)
 *   2. Diff against session.knownEntities to find spawns and despawns
 *   3. Return a BinaryStateMessage ready to encode and send
 *
 * Terrain chunks (Heightmap/MaterialGrid entities) are always visible and never despawn.
 * Positioned entities are filtered by AOI_RADIUS (128 world units).
 */

import type { World, EntityId } from "@voxim/engine";
import { Heightmap } from "@voxim/world";
import type { GameEvent } from "@voxim/protocol";
import { COMPONENT_NAME_TO_TYPE } from "@voxim/protocol";
import type {
  BinaryStateMessage,
  BinaryEntitySpawn,
  BinaryComponentDelta,
  BinaryComponentEntry,
} from "@voxim/protocol";
import type { ClientSession } from "./session.ts";
import type { SpatialGrid } from "./spatial_grid.ts";
import { Position } from "./components/game.ts";
import { NETWORKED_DEFS } from "./component_registry.ts";

/** Radius in world units within which entities are visible to a client. */
export const AOI_RADIUS = 128;

function buildSpawnComponents(world: World, entityId: EntityId): BinaryComponentEntry[] {
  const components: BinaryComponentEntry[] = [];
  for (const def of NETWORKED_DEFS) {
    const typeId = COMPONENT_NAME_TO_TYPE.get(def.name);
    if (typeId === undefined) continue;
    const data = world.get(entityId, def);
    if (data === null) continue;
    try {
      components.push({ componentType: typeId, data: def.codec.encode(data) });
    } catch {
      // Encoding failure — skip this component
    }
  }
  return components;
}

function isEventRelevant(
  ev: GameEvent,
  playerId: EntityId,
  knownEntities: ReadonlySet<EntityId>,
): boolean {
  switch (ev.type) {
    case "DamageDealt":
      return knownEntities.has(ev.targetId) || knownEntities.has(ev.sourceId);
    case "EntityDied":
      return knownEntities.has(ev.entityId);
    case "CraftingCompleted":
      return ev.crafterId === playerId;
    case "BuildingCompleted":
      return ev.builderId === playerId || knownEntities.has(ev.blueprintId);
    case "HungerCritical":
      return ev.entityId === playerId;
    case "GateApproached":
      return ev.entityId === playerId;
    case "NodeDepleted":
      return knownEntities.has(ev.nodeId) || knownEntities.has(ev.harvesterId);
    case "DayPhaseChanged":
      return true;
    case "SkillActivated":
      return knownEntities.has(ev.casterId);
    case "TradeCompleted":
      return ev.buyerId === playerId || knownEntities.has(ev.traderId);
    case "LoreExternalised":
      return ev.entityId === playerId;
    case "LoreInternalised":
      return ev.entityId === playerId;
  }
}

/**
 * Compute the full per-session state message for one tick.
 *
 * Mutates session.knownEntities to reflect the new visible set.
 */
export function computeSessionUpdate(
  world: World,
  session: ClientSession,
  spatial: SpatialGrid,
  playerId: EntityId,
  changedComponents: Map<EntityId, BinaryComponentDelta[]>,
  worldDestroys: ReadonlySet<EntityId>,
  events: GameEvent[],
  serverTick: number,
  ackInputSeq: number,
): BinaryStateMessage {
  // ── 1. Build visible entity set ─────────────────────────────────────────────
  const inAoI = new Set<EntityId>();

  // Terrain chunks are always visible — they never leave AoI
  for (const { entityId } of world.query(Heightmap)) {
    inAoI.add(entityId);
  }

  // Positioned entities within radius
  const pos = world.get(playerId, Position);
  if (pos) {
    for (const id of spatial.nearby(pos.x, pos.y, AOI_RADIUS)) {
      inAoI.add(id);
    }
  }

  // The player's own entity is always visible
  inAoI.add(playerId);

  // ── 2. Spawns: entities newly visible this tick ──────────────────────────────
  const spawns: BinaryEntitySpawn[] = [];
  const newlySpawned = new Set<EntityId>();

  for (const id of inAoI) {
    if (session.knownEntities.has(id)) continue;
    const components = buildSpawnComponents(world, id);
    if (components.length > 0) {
      spawns.push({ entityId: id, components });
      session.knownEntities.add(id);
      newlySpawned.add(id);
    }
  }

  // ── 3. Destroys: left AoI or world-destroyed ────────────────────────────────
  const destroys: string[] = [];
  const toRemove: EntityId[] = [];

  for (const id of session.knownEntities) {
    if (worldDestroys.has(id) || !inAoI.has(id)) {
      destroys.push(id);
      toRemove.push(id);
    }
  }
  for (const id of toRemove) session.knownEntities.delete(id);

  // ── 4. Deltas: changed components for already-known entities ─────────────────
  const deltas: BinaryComponentDelta[] = [];
  for (const [entityId, entityDeltas] of changedComponents) {
    // Skip: not known to this session, or just spawned (spawn already carries full state)
    if (!session.knownEntities.has(entityId)) continue;
    if (newlySpawned.has(entityId)) continue;
    for (const d of entityDeltas) deltas.push(d);
  }

  // ── 5. Events: filter by relevance ───────────────────────────────────────────
  const filteredEvents = events.filter((ev) =>
    isEventRelevant(ev, playerId, session.knownEntities)
  );

  return { serverTick, ackInputSeq, spawns, deltas, destroys, events: filteredEvents };
}
