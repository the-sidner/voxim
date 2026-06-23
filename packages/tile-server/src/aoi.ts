/**
 * Area-of-Interest (AoI) filter — per-session entity lifecycle.
 *
 * Each tick, for each connected session:
 *   1. Build the set of entities visible to this player (terrain + spatial radius)
 *   2. Diff against session.knownEntities to find spawns and despawns
 *   3. Return a BinaryStateMessage ready to encode and send
 *
 * Terrain chunks (Heightmap/MaterialGrid entities) are always visible and never despawn.
 * Positioned entities are filtered by GameConfig.network.aoiRadius.
 */

import type { World, EntityId } from "@voxim/engine";
import { Heightmap, CHUNK_SIZE } from "@voxim/world";
import type { GameEvent } from "@voxim/protocol";
import type {
  BinaryStateMessage,
  BinaryEntitySpawn,
  BinaryComponentDelta,
  BinaryComponentRemoval,
  BinaryComponentEntry,
} from "@voxim/protocol";
import type { ClientSession } from "./session.ts";
import type { SpatialGrid } from "./spatial_grid.ts";
import { Position } from "./components/game.ts";
import { Inventory } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { Container } from "./components/container.ts";
import { Heritage } from "./components/heritage.ts";
import { GateLink } from "./components/gate.ts";
import { FogState } from "./components/fog_state.ts";
import { NETWORKED_DEFS } from "./component_registry.ts";

/**
 * Max number of NEW terrain chunk spawns per state message.
 * Each 32×32 chunk is ~6 KB; 20 chunks ≈ 120 KB — well within the QUIC
 * flow-control window.  256 total chunks load over ~13 ticks (≈650 ms).
 */
const MAX_CHUNK_SPAWNS_PER_TICK = 20;

function buildSpawnComponents(world: World, entityId: EntityId): BinaryComponentEntry[] {
  const components: BinaryComponentEntry[] = [];
  for (const def of NETWORKED_DEFS) {
    const data = world.get(entityId, def);
    if (data === null) continue;
    try {
      components.push({ componentType: def.wireId, data: def.codec.encode(data) });
    } catch (err) {
      // Surface silent encode failures — they indicate a codec bug, not
      // something to swallow.
      console.warn(`[AoI] entity ${entityId.slice(-8)}: encode failed for ${def.name}: ${(err as Error).message}`);
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
    case "Healed":
      return knownEntities.has(ev.entityId);
    case "GateApproached":
      return ev.entityId === playerId;
    case "GateCrossing":
      return ev.entityId === playerId;
    case "NodeDepleted":
      return knownEntities.has(ev.nodeId) || knownEntities.has(ev.harvesterId);
    case "DayPhaseChanged":
      return true;
    case "TradeCompleted":
      return ev.buyerId === playerId || knownEntities.has(ev.traderId);
    case "LoreExternalised":
      return ev.entityId === playerId;
    case "LoreInternalised":
      return ev.entityId === playerId;
    case "HitSpark":
      return true;
    case "BuildingMaterialsConsumed":
      return ev.builderId === playerId;
    case "BuildingMissingMaterials":
      return ev.builderId === playerId;
    case "ZoneEntered":
      // Each client only cares about its own player's zone transitions
      // (other players' zone changes don't drive its HUD). Server still
      // emits to AoI so spectator UIs / observability tools can listen.
      return ev.playerId === playerId;
    default:
      // TypeScript enforces exhaustiveness: adding a new GameEvent type without
      // a matching case here will produce a compile error.
      ev satisfies never;
      return false;
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
  removedComponents: Map<EntityId, number[]>,
  worldDestroys: ReadonlySet<EntityId>,
  events: GameEvent[],
  serverTick: number,
  ackInputSeq: number,
  aoiRadius: number,
  onlineCount: number,
): BinaryStateMessage {
  // ── 1. Build visible entity set ─────────────────────────────────────────────
  const inAoI = new Set<EntityId>();

  // Terrain chunks are always visible — they never leave AoI
  const allChunkIds: EntityId[] = [];
  for (const { entityId } of world.query(Heightmap)) {
    inAoI.add(entityId);
    allChunkIds.push(entityId);
  }

  // Positioned entities within radius
  const pos = world.get(playerId, Position);
  if (pos) {
    for (const id of spatial.nearby(pos.x, pos.y, aoiRadius)) {
      inAoI.add(id);
    }
  }

  // The player's own entity is always visible
  inAoI.add(playerId);

  // Gates are always visible — there's at most one per edge (≤4 per tile),
  // and they're navigational landmarks. Streaming them only on proximity
  // (T-145 visual rendered them invisible until ~128 units away) hid the
  // tile-edge structure from the player.
  for (const { entityId } of world.query(GateLink)) {
    inAoI.add(entityId);
  }

  // Unique item entities the player carries have no Position (they don't sit
  // in the spatial grid) yet the holder's client must see them — their prefab
  // id, durability, inscription, and quality drive UI and equipped rendering.
  // Include them in the holder's AoI so the standard spawn/delta/destroy
  // lifecycle transports their components. When a unique item is dropped it
  // gains a Position and becomes visible to everyone via the spatial query;
  // when picked up again it sheds Position and re-enters this path.
  const inv = world.get(playerId, Inventory);
  if (inv) {
    for (const slot of inv.slots) {
      if (slot.kind === "unique") inAoI.add(slot.entityId as EntityId);
    }
  }
  const equip = world.get(playerId, Equipment);
  if (equip) {
    for (const slot of [equip.weapon, equip.offHand, equip.head, equip.chest, equip.legs, equip.feet, equip.back]) {
      if (slot) inAoI.add(slot.entityId as EntityId);
    }
  }

  // Unique items banked in a family chest (T-077/T-078) likewise have no
  // Position. Stream the slot entities of any in-AoI chest the player's dynasty
  // owns, so the deposit/withdraw panel can resolve each item's prefab/name —
  // the same lifecycle the carried-item inclusion above relies on. Gated by
  // dynasty so a player can't snoop a rival chest's contents over the wire.
  const myDynasty = world.get(playerId, Heritage)?.dynastyId;
  if (myDynasty) {
    for (const { entityId, container } of world.query(Container)) {
      if (container.dynastyId !== myDynasty || !inAoI.has(entityId)) continue;
      for (const slot of container.slots) inAoI.add(slot.entityId as EntityId);
    }
  }

  // ── 2. Spawns: entities newly visible this tick ──────────────────────────────
  const spawns: BinaryEntitySpawn[] = [];
  const newlySpawned = new Set<EntityId>();

  // Terrain chunks: sort by distance from player, cap at MAX_CHUNK_SPAWNS_PER_TICK.
  // Each 32×32 chunk is ~6 KB; sending all 256 at once (~1.6 MB) exhausts the QUIC
  // flow-control window.  Deferred chunks remain outside knownEntities and are
  // processed in subsequent ticks until all 256 are delivered.
  const px = pos?.x ?? 256;
  const py = pos?.y ?? 256;
  const pendingChunks = allChunkIds.filter((id) => !session.knownEntities.has(id));
  pendingChunks.sort((a, b) => {
    const ha = world.get(a, Heightmap)!;
    const hb = world.get(b, Heightmap)!;
    const acx = (ha.chunkX + 0.5) * CHUNK_SIZE, acy = (ha.chunkY + 0.5) * CHUNK_SIZE;
    const bcx = (hb.chunkX + 0.5) * CHUNK_SIZE, bcy = (hb.chunkY + 0.5) * CHUNK_SIZE;
    const da = (acx - px) ** 2 + (acy - py) ** 2;
    const db = (bcx - px) ** 2 + (bcy - py) ** 2;
    return da - db;
  });
  for (let i = 0; i < Math.min(pendingChunks.length, MAX_CHUNK_SPAWNS_PER_TICK); i++) {
    const id = pendingChunks[i];
    const components = buildSpawnComponents(world, id);
    if (components.length > 0) {
      spawns.push({ entityId: id, components });
      session.knownEntities.add(id);
      newlySpawned.add(id);
    }
  }

  // Non-terrain entities: all new ones in AoI, no cap (each is small)
  for (const id of inAoI) {
    if (session.knownEntities.has(id)) continue;
    const hm = world.get(id, Heightmap);
    if (hm !== null) continue; // chunk — handled above
    const components = buildSpawnComponents(world, id);
    if (components.length > 0) {
      spawns.push({ entityId: id, components });
      session.knownEntities.add(id);
      newlySpawned.add(id);
    }
  }

  // Snapshot the known set BEFORE the prune below. Events (notably
  // EntityDied) are relevant to a session that knew the entity *this tick*,
  // even though that same entity is being despawned this tick — filtering
  // against the post-prune set would make a death the client never sees as
  // anything but a bare despawn (T-250). Includes this tick's spawns.
  const knownThisTick = new Set(session.knownEntities);

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

  // ── 4b. Removals: components dropped from entities that REMAIN known ──────────
  // An entity leaving AoI or destroyed this tick is a whole-entity `destroy`
  // (handled above) — its per-component removals are redundant, so we only
  // emit removals for survivors of the prune. The component's wire-ID latches
  // forever on the client without this (settled item → Velocity, picked-up
  // item → Position, expiring combat flag).
  const removals: BinaryComponentRemoval[] = [];
  for (const [entityId, types] of removedComponents) {
    if (!session.knownEntities.has(entityId)) continue;
    if (newlySpawned.has(entityId)) continue;
    for (const componentType of types) removals.push({ entityId, componentType });
  }

  // ── 5. Events: filter by relevance ───────────────────────────────────────────
  const filteredEvents = events.filter((ev) =>
    isEventRelevant(ev, playerId, knownThisTick)
  );

  // ── 6. Fog of war (T-157) ───────────────────────────────────────────────────
  // Drain the player's FogState into the message.  pendingSnapshot fires the
  // first tick after spawn (and after any future server-side resync); after
  // that we just ship the per-tick reveal list.  We mutate the component
  // instance directly — no world.set — because the inner buffer/array is
  // reference-typed and the FogOfWarSystem mutates it the same way.
  let fogSnapshot: Uint8Array | null = null;
  let fogReveals = new Uint16Array(0);
  const fog = world.get(playerId, FogState);
  if (fog) {
    if (fog.pendingSnapshot) {
      fogSnapshot = new Uint8Array(fog.seenEver);
      fog.pendingSnapshot = false;
      fog.revealedThisTick.length = 0;
    } else if (fog.revealedThisTick.length > 0) {
      fogReveals = Uint16Array.from(fog.revealedThisTick);
      fog.revealedThisTick.length = 0;
    }
  }

  return {
    serverTick,
    ackInputSeq,
    spawns,
    deltas,
    removals,
    destroys,
    events: filteredEvents,
    fogSnapshot,
    fogReveals,
    onlineCount,
  };
}
