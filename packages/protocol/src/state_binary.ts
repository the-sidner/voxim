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
 *   u16  numDestroys
 *     per destroy: [uuid16 entityId]
 *   u16  numEvents
 *     per event: [u8 eventTypeId] [event-specific fields…]
 *
 * Event field layouts:
 *   DamageDealt       uuid targetId, uuid sourceId, f32 amount, u8 blocked
 *   EntityDied        uuid entityId, u8 hasKiller, [uuid killerId]
 *   CraftingCompleted uuid crafterId, str recipeId
 *   BuildingCompleted uuid builderId, uuid blueprintId, str structureType
 *   HungerCritical    uuid entityId
 *   GateApproached    uuid entityId, str gateId, str destinationTileId
 *   NodeDepleted      uuid nodeId, str nodeTypeId, uuid harvesterId
 *   DayPhaseChanged   str phase, f32 timeOfDay
 *   SkillActivated    uuid casterId, u8 slot, str effectType
 *   TradeCompleted    uuid buyerId, uuid traderId, str itemType, u16 quantity, i32 coinDelta
 *   LoreExternalised  uuid entityId, str fragmentId
 *   LoreInternalised  uuid entityId, str fragmentId
 */

import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import { EventType } from "./event_types.ts";
import type { GameEvent } from "./messages.ts";

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

export interface BinaryStateMessage {
  serverTick: number;
  ackInputSeq: number;
  /** Entities newly visible to this client (entered AoI or first connect). */
  spawns: BinaryEntitySpawn[];
  /** Component changes for already-known entities. */
  deltas: BinaryComponentDelta[];
  /** Entity UUIDs removed from this client's view (world destroy or left AoI). */
  destroys: string[];
  events: GameEvent[];
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
    case "SkillActivated":
      w.writeU8(EventType.SkillActivated);
      w.writeUuid(ev.casterId);
      w.writeU8(ev.slot);
      w.writeStr(ev.effectType);
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
    case EventType.NodeDepleted:
      return {
        type: "NodeDepleted",
        nodeId: r.readUuid(),
        nodeTypeId: r.readStr(),
        harvesterId: r.readUuid(),
      };
    case EventType.DayPhaseChanged:
      return { type: "DayPhaseChanged", phase: r.readStr(), timeOfDay: r.readF32() };
    case EventType.SkillActivated:
      return {
        type: "SkillActivated",
        casterId: r.readUuid(),
        slot: r.readU8(),
        effectType: r.readStr(),
      };
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

    return { serverTick, ackInputSeq, spawns, deltas, destroys, events };
  },
};
