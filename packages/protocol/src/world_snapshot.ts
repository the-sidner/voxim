/**
 * WorldSnapshot — unreliable server→client datagram, sent every tick.
 *
 * Carries only the high-frequency positional state for all entities:
 * position, velocity, and facing.  Loss-tolerant: a missed snapshot is
 * superseded by the next one.  Spawns, despawns, health changes, and all
 * other event-like state travel on the reliable StateMessage stream.
 *
 * Binary layout, little-endian:
 *   u32  serverTick
 *   u16  entityCount
 *   per entity (44 bytes):
 *     16 bytes  entityId  (UUID as raw bytes, dashes stripped)
 *      f32      x
 *      f32      y
 *      f32      z
 *      f32      facing    (radians, world-space)
 *      f32      vx
 *      f32      vy
 *      f32      vz
 *
 * Max entities per datagram ≈ 27  (stays under 1 200-byte QUIC limit).
 * If a tile has more, the server paginates across multiple datagrams with
 * the same serverTick value.
 */
import type { Serialiser } from "@voxim/engine";
import { uuidToBytes, bytesToUuid } from "@voxim/codecs";

export interface SnapshotEntity {
  entityId: string;  // UUID string — codec converts to/from 16 raw bytes
  x: number;        // f32
  y: number;        // f32
  z: number;        // f32
  facing: number;   // f32
  vx: number;       // f32
  vy: number;       // f32
  vz: number;       // f32
}

export interface WorldSnapshot {
  serverTick: number;       // u32
  entities: SnapshotEntity[];
}

// ---- constants ----

const ENTITY_BYTES = 44; // 16 + 7 × 4
const HEADER_BYTES = 6;  // u32 + u16

// ---- codec ----

export const worldSnapshotCodec: Serialiser<WorldSnapshot> = {
  encode(snap: WorldSnapshot): Uint8Array {
    const count = snap.entities.length;
    const buf = new ArrayBuffer(HEADER_BYTES + count * ENTITY_BYTES);
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);

    v.setUint32(0, snap.serverTick >>> 0, true);
    v.setUint16(4, count, true);

    for (let i = 0; i < count; i++) {
      const e = snap.entities[i];
      const base = HEADER_BYTES + i * ENTITY_BYTES;

      u8.set(uuidToBytes(e.entityId), base);

      v.setFloat32(base + 16, e.x,      true);
      v.setFloat32(base + 20, e.y,      true);
      v.setFloat32(base + 24, e.z,      true);
      v.setFloat32(base + 28, e.facing, true);
      v.setFloat32(base + 32, e.vx,     true);
      v.setFloat32(base + 36, e.vy,     true);
      v.setFloat32(base + 40, e.vz,     true);
    }

    return u8;
  },

  decode(bytes: Uint8Array): WorldSnapshot {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const serverTick = v.getUint32(0, true);
    const count      = v.getUint16(4, true);

    const entities: SnapshotEntity[] = [];
    for (let i = 0; i < count; i++) {
      const base = HEADER_BYTES + i * ENTITY_BYTES;
      entities.push({
        entityId: bytesToUuid(bytes, base),
        x:        v.getFloat32(base + 16, true),
        y:        v.getFloat32(base + 20, true),
        z:        v.getFloat32(base + 24, true),
        facing:   v.getFloat32(base + 28, true),
        vx:       v.getFloat32(base + 32, true),
        vy:       v.getFloat32(base + 36, true),
        vz:       v.getFloat32(base + 40, true),
      });
    }

    return { serverTick, entities };
  },
};
