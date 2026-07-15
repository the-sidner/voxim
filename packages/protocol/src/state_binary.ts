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
 *       (per-event field layouts live on each descriptor in event_registry.ts)
 *   u8   hasFogSnapshot       (T-157)
 *     if 1: bytes (FOG_GRID_BYTES = 8192, bit-packed seenEver bitmap)
 *   u16  numFogReveals        (T-157)
 *     per reveal: u16 fog-cell index
 */

import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import type { GameEvent } from "./messages.ts";
import { encodeEvent, decodeEvent } from "./event_registry.ts";
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
