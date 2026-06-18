/**
 * Binary codec for the reliable server→client state channel.
 *
 * Wire layout (all little-endian):
 *   u32  serverTick
 *   u32  ackInputSeq
 *   u16  numSpawns
 *     per spawn: [uuid16 entityId] [u16 numComponents]
 *       per component: [u8 typeId] [u16 dataLen] [bytes…]
 *   u16  numDeltas
 *     per delta: [uuid16 entityId] [u8 typeId] [u32 version] [u16 dataLen] [bytes…]
 *   u16  numRemovals
 *     per removal: [uuid16 entityId] [u8 typeId]
 *   u16  numDestroys
 *     per destroy: [uuid16 entityId]
 *   u16  numEvents
 *     per event: [u8 eventTypeId] [event-specific fields…]
 *   u8   hasFogSnapshot       (T-157)
 *     if 1: bytes (FOG_GRID_BYTES = 8192, bit-packed seenEver bitmap)
 *   u16  numFogReveals        (T-157)
 *     per reveal: u16 fog-cell index
 *
 * Event field layouts:
 *   DamageDealt       uuid targetId, uuid sourceId, f32 amount, u8 blocked
 *   EntityDied        uuid entityId, u8 hasKiller, [uuid killerId]
 *   CraftingCompleted uuid crafterId, str recipeId
 *   BuildingCompleted uuid builderId, uuid blueprintId, str structureType
 *   HungerCritical    uuid entityId
 *   GateApproached    uuid entityId, str gateId, str destinationTileId
 *   GateCrossing      uuid entityId, str destinationTileAddress, str destinationTileCertHashHex
 *   NodeDepleted      uuid nodeId, str nodeTypeId, uuid harvesterId
 *   DayPhaseChanged   str phase, f32 timeOfDay
 *   TradeCompleted    uuid buyerId, uuid traderId, str itemType, u16 quantity, i32 coinDelta
 *   LoreExternalised  uuid entityId, str fragmentId
 *   LoreInternalised  uuid entityId, str fragmentId
 *   HitSpark          f32 x, f32 y, f32 z, str attackerPart, str victimPart
 */

import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import { EventType } from "./event_types.ts";
import type { GameEvent, BuildingMaterial } from "./messages.ts";
import { FOG_GRID_BYTES } from "./fog.ts";

// ---- public types ----

export interface BinaryComponentEntry {
  componentType: number;  // u8 from ComponentType
  data: Uint8Array;       // pre-encoded component bytes
}

export interface BinaryEntitySpawn {
  entityId: string;
  components: BinaryComponentEntry[];
}

export interface BinaryComponentDelta {
  entityId: string;
  componentType: number;  // u8 from ComponentType
  version: number;        // u32
  data: Uint8Array;       // pre-encoded component bytes
}

export interface BinaryComponentRemoval {
  entityId: string;
  componentType: number;  // u8 from ComponentType
}

export interface BinaryStateMessage {
  serverTick: number;
  ackInputSeq: number;
  /** Entities newly visible to this client (entered AoI or first connect). */
  spawns: BinaryEntitySpawn[];
  /** Component changes for already-known entities. */
  deltas: BinaryComponentDelta[];
  /**
   * Components removed from an entity that REMAINS known to this client
   * (e.g. a settled item shedding Velocity, a picked-up item shedding
   * Position, a combat flag expiring). Without this channel a removed
   * component latches on the client forever — "component presence as flag"
   * is only wire-honest because of this list. Whole-entity removal is the
   * separate `destroys` channel.
   */
  removals: BinaryComponentRemoval[];
  /** Entity UUIDs removed from this client's view (world destroy or left AoI). */
  destroys: string[];
  events: GameEvent[];
  /**
   * Full fog-of-war snapshot (T-157), bit-packed.  Sent only on the first
   * tick after the player joins (or when the server explicitly resyncs);
   * `null` on every other tick.  Length is always `FOG_GRID_BYTES` when set.
   */
  fogSnapshot: Uint8Array | null;
  /**
   * Newly-revealed fog cell indices (T-157).  Each entry is a u16 index
   * into the 256×256 fog grid (`packFogCell` from fog.ts).  Empty array
   * when no cells were revealed this tick.
   */
  fogReveals: Uint16Array;
  /**
   * Total active sessions on this tile, sampled when the message was built.
   * Drives the HUD's online-players counter — cheap (one u16 per tick) and
   * authoritative without an extra HTTP round-trip.
   */
  onlineCount: number;
}

// ---- event encode/decode ----

function encodeEvent(w: WireWriter, ev: GameEvent): void {
  switch (ev.type) {
    case "DamageDealt":
      w.writeU8(EventType.DamageDealt);
      w.writeUuid(ev.targetId);
      w.writeUuid(ev.sourceId);
      w.writeF32(ev.amount);
      w.writeU8(ev.blocked ? 1 : 0);
      w.writeF32(ev.hitX);
      w.writeF32(ev.hitY);
      w.writeF32(ev.hitZ);
      break;
    case "EntityDied":
      w.writeU8(EventType.EntityDied);
      w.writeUuid(ev.entityId);
      w.writeU8(ev.killerId ? 1 : 0);
      if (ev.killerId) w.writeUuid(ev.killerId);
      break;
    case "CraftingCompleted":
      w.writeU8(EventType.CraftingCompleted);
      w.writeUuid(ev.crafterId);
      w.writeStr(ev.recipeId);
      break;
    case "BuildingCompleted":
      w.writeU8(EventType.BuildingCompleted);
      w.writeUuid(ev.builderId);
      w.writeUuid(ev.blueprintId);
      w.writeStr(ev.structureType);
      break;
    case "HungerCritical":
      w.writeU8(EventType.HungerCritical);
      w.writeUuid(ev.entityId);
      break;
    case "GateApproached":
      w.writeU8(EventType.GateApproached);
      w.writeUuid(ev.entityId);
      w.writeStr(ev.gateId);
      w.writeStr(ev.destinationTileId);
      break;
    case "GateCrossing":
      w.writeU8(EventType.GateCrossing);
      w.writeUuid(ev.entityId);
      w.writeStr(ev.destinationTileAddress);
      w.writeStr(ev.destinationTileCertHashHex);
      break;
    case "NodeDepleted":
      w.writeU8(EventType.NodeDepleted);
      w.writeUuid(ev.nodeId);
      w.writeStr(ev.nodeTypeId);
      w.writeUuid(ev.harvesterId);
      break;
    case "DayPhaseChanged":
      w.writeU8(EventType.DayPhaseChanged);
      w.writeStr(ev.phase);
      w.writeF32(ev.timeOfDay);
      break;
    case "TradeCompleted":
      w.writeU8(EventType.TradeCompleted);
      w.writeUuid(ev.buyerId);
      w.writeUuid(ev.traderId);
      w.writeStr(ev.itemType);
      w.writeU16(ev.quantity);
      w.writeI32(ev.coinDelta);
      break;
    case "LoreExternalised":
      w.writeU8(EventType.LoreExternalised);
      w.writeUuid(ev.entityId);
      w.writeStr(ev.fragmentId);
      break;
    case "LoreInternalised":
      w.writeU8(EventType.LoreInternalised);
      w.writeUuid(ev.entityId);
      w.writeStr(ev.fragmentId);
      break;
    case "HitSpark":
      w.writeU8(EventType.HitSpark);
      w.writeF32(ev.x);
      w.writeF32(ev.y);
      w.writeF32(ev.z);
      w.writeStr(ev.attackerPart);
      w.writeStr(ev.victimPart);
      break;
    case "BuildingMaterialsConsumed":
      w.writeU8(EventType.BuildingMaterialsConsumed);
      w.writeUuid(ev.builderId);
      w.writeStr(ev.structureType);
      w.writeU16(ev.consumed.length);
      for (const m of ev.consumed) { w.writeStr(m.itemType); w.writeU16(m.quantity); }
      break;
    case "BuildingMissingMaterials":
      w.writeU8(EventType.BuildingMissingMaterials);
      w.writeUuid(ev.builderId);
      w.writeStr(ev.structureType);
      w.writeU16(ev.missing.length);
      for (const m of ev.missing) { w.writeStr(m.itemType); w.writeU16(m.quantity); }
      break;
    case "ZoneEntered":
      w.writeU8(EventType.ZoneEntered);
      w.writeUuid(ev.playerId);
      w.writeU16(ev.zoneId);
      w.writeStr(ev.zoneName);
      w.writeStr(ev.topologyRole);
      w.writeU8(ev.traversal === "wilderness" ? 1 : 0);
      break;
  }
}

function decodeEvent(r: WireReader): GameEvent {
  const typeId = r.readU8();
  switch (typeId) {
    case EventType.DamageDealt:
      return {
        type: "DamageDealt",
        targetId: r.readUuid(),
        sourceId: r.readUuid(),
        amount: r.readF32(),
        blocked: r.readU8() !== 0,
        hitX: r.readF32(),
        hitY: r.readF32(),
        hitZ: r.readF32(),
      };
    case EventType.EntityDied: {
      const entityId = r.readUuid();
      const hasKiller = r.readU8() !== 0;
      return { type: "EntityDied", entityId, killerId: hasKiller ? r.readUuid() : undefined };
    }
    case EventType.CraftingCompleted:
      return { type: "CraftingCompleted", crafterId: r.readUuid(), recipeId: r.readStr() };
    case EventType.BuildingCompleted:
      return {
        type: "BuildingCompleted",
        builderId: r.readUuid(),
        blueprintId: r.readUuid(),
        structureType: r.readStr(),
      };
    case EventType.HungerCritical:
      return { type: "HungerCritical", entityId: r.readUuid() };
    case EventType.GateApproached:
      return {
        type: "GateApproached",
        entityId: r.readUuid(),
        gateId: r.readStr(),
        destinationTileId: r.readStr(),
      };
    case EventType.GateCrossing:
      return {
        type: "GateCrossing",
        entityId: r.readUuid(),
        destinationTileAddress: r.readStr(),
        destinationTileCertHashHex: r.readStr(),
      };
    case EventType.NodeDepleted:
      return {
        type: "NodeDepleted",
        nodeId: r.readUuid(),
        nodeTypeId: r.readStr(),
        harvesterId: r.readUuid(),
      };
    case EventType.DayPhaseChanged:
      return { type: "DayPhaseChanged", phase: r.readStr(), timeOfDay: r.readF32() };
    case EventType.TradeCompleted:
      return {
        type: "TradeCompleted",
        buyerId: r.readUuid(),
        traderId: r.readUuid(),
        itemType: r.readStr(),
        quantity: r.readU16(),
        coinDelta: r.readI32(),
      };
    case EventType.LoreExternalised:
      return { type: "LoreExternalised", entityId: r.readUuid(), fragmentId: r.readStr() };
    case EventType.LoreInternalised:
      return { type: "LoreInternalised", entityId: r.readUuid(), fragmentId: r.readStr() };
    case EventType.HitSpark:
      return {
        type: "HitSpark",
        x: r.readF32(), y: r.readF32(), z: r.readF32(),
        attackerPart: r.readStr(),
        victimPart: r.readStr(),
      };
    case EventType.BuildingMaterialsConsumed: {
      const builderId = r.readUuid();
      const structureType = r.readStr();
      const count = r.readU16();
      const consumed: BuildingMaterial[] = [];
      for (let i = 0; i < count; i++) consumed.push({ itemType: r.readStr(), quantity: r.readU16() });
      return { type: "BuildingMaterialsConsumed", builderId, structureType, consumed };
    }
    case EventType.BuildingMissingMaterials: {
      const builderId = r.readUuid();
      const structureType = r.readStr();
      const count = r.readU16();
      const missing: BuildingMaterial[] = [];
      for (let i = 0; i < count; i++) missing.push({ itemType: r.readStr(), quantity: r.readU16() });
      return { type: "BuildingMissingMaterials", builderId, structureType, missing };
    }
    case EventType.ZoneEntered: {
      const playerId     = r.readUuid();
      const zoneId       = r.readU16();
      const zoneName     = r.readStr();
      const topologyRole = r.readStr();
      const traversal    = r.readU8() === 1 ? "wilderness" : "path";
      return { type: "ZoneEntered", playerId, zoneId, zoneName, topologyRole, traversal };
    }
    default:
      throw new Error(`Unknown event type ID: ${typeId}`);
  }
}

// ---- codec ----

export const binaryStateMessageCodec: Serialiser<BinaryStateMessage> = {
  encode(msg: BinaryStateMessage): Uint8Array {
    const w = new WireWriter();

    w.writeU32(msg.serverTick);
    w.writeU32(msg.ackInputSeq);

    // spawns
    w.writeU16(msg.spawns.length);
    for (const spawn of msg.spawns) {
      w.writeUuid(spawn.entityId);
      w.writeU16(spawn.components.length);
      for (const comp of spawn.components) {
        w.writeU8(comp.componentType);
        w.writeU16(comp.data.byteLength);
        w.writeBytes(comp.data);
      }
    }

    // deltas
    w.writeU16(msg.deltas.length);
    for (const d of msg.deltas) {
      w.writeUuid(d.entityId);
      w.writeU8(d.componentType);
      w.writeU32(d.version);
      w.writeU16(d.data.byteLength);
      w.writeBytes(d.data);
    }

    // removals (component dropped from a still-known entity)
    w.writeU16(msg.removals.length);
    for (const rm of msg.removals) {
      w.writeUuid(rm.entityId);
      w.writeU8(rm.componentType);
    }

    // destroys
    w.writeU16(msg.destroys.length);
    for (const id of msg.destroys) {
      w.writeUuid(id);
    }

    // events
    w.writeU16(msg.events.length);
    for (const ev of msg.events) {
      encodeEvent(w, ev);
    }

    // fog (T-157)
    if (msg.fogSnapshot) {
      if (msg.fogSnapshot.byteLength !== FOG_GRID_BYTES) {
        throw new Error(`fogSnapshot must be ${FOG_GRID_BYTES} bytes, got ${msg.fogSnapshot.byteLength}`);
      }
      w.writeU8(1);
      w.writeBytes(msg.fogSnapshot);
    } else {
      w.writeU8(0);
    }
    w.writeU16(msg.fogReveals.length);
    for (let i = 0; i < msg.fogReveals.length; i++) {
      w.writeU16(msg.fogReveals[i]);
    }

    w.writeU16(msg.onlineCount);

    return w.toBytes();
  },

  decode(bytes: Uint8Array): BinaryStateMessage {
    const r = new WireReader(bytes);

    const serverTick  = r.readU32();
    const ackInputSeq = r.readU32();

    // spawns
    const numSpawns = r.readU16();
    const spawns: BinaryEntitySpawn[] = [];
    for (let i = 0; i < numSpawns; i++) {
      const entityId = r.readUuid();
      const numComps = r.readU16();
      const components: BinaryComponentEntry[] = [];
      for (let j = 0; j < numComps; j++) {
        const componentType = r.readU8();
        const dataLen = r.readU16();
        const data = r.readBytes(dataLen);
        components.push({ componentType, data });
      }
      spawns.push({ entityId, components });
    }

    // deltas
    const numDeltas = r.readU16();
    const deltas: BinaryComponentDelta[] = [];
    for (let i = 0; i < numDeltas; i++) {
      const entityId = r.readUuid();
      const componentType = r.readU8();
      const version = r.readU32();
      const dataLen = r.readU16();
      const data = r.readBytes(dataLen);
      deltas.push({ entityId, componentType, version, data });
    }

    // removals
    const numRemovals = r.readU16();
    const removals: BinaryComponentRemoval[] = [];
    for (let i = 0; i < numRemovals; i++) {
      const entityId = r.readUuid();
      const componentType = r.readU8();
      removals.push({ entityId, componentType });
    }

    // destroys
    const numDestroys = r.readU16();
    const destroys: string[] = [];
    for (let i = 0; i < numDestroys; i++) {
      destroys.push(r.readUuid());
    }

    // events
    const numEvents = r.readU16();
    const events: GameEvent[] = [];
    for (let i = 0; i < numEvents; i++) {
      events.push(decodeEvent(r));
    }

    // fog (T-157)
    const hasFog = r.readU8();
    const fogSnapshot = hasFog === 1 ? r.readBytes(FOG_GRID_BYTES) : null;
    const numReveals = r.readU16();
    const fogReveals = new Uint16Array(numReveals);
    for (let i = 0; i < numReveals; i++) {
      fogReveals[i] = r.readU16();
    }

    const onlineCount = r.readU16();

    return { serverTick, ackInputSeq, spawns, deltas, removals, destroys, events, fogSnapshot, fogReveals, onlineCount };
  },
};
