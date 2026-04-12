/**
 * Wire codecs for datagram message types.
 *
 * These live in @voxim/protocol — the shared package — so both the tile server
 * and the client import from the same source.  A format change is a compile
 * error on both ends simultaneously.
 *
 * MovementDatagram — fixed 33-byte little-endian binary (type byte included):
 *   u8  type=1 | u32 seq | u32 tick | f64 timestamp | f32 facing | f32 movX | f32 movY | u32 actions
 *
 * CommandDatagram — variable-length TLV binary:
 *   u8  type=2 | u32 seq | u8 cmdType | u16 payloadLen | [payloadLen bytes]
 *
 * Reliable stream messages (StateMessage, join handshake) use binary framing
 * from framing.ts — [4-byte LE u32 payload length][payload bytes].
 */
import type { Serialiser } from "@voxim/engine";
import type { MovementDatagram, CommandDatagram, CommandPayload } from "./messages.ts";
import { CommandType, EquipSlotIndex } from "./messages.ts";

// ---- Datagram type discriminants ----

export const DATAGRAM_TYPE_MOVEMENT = 1;
export const DATAGRAM_TYPE_COMMAND  = 2;

// ---- MovementDatagram codec ----

/** Wire size in bytes, including the leading type byte. */
const MOVEMENT_SIZE = 33;

export const movementDatagramCodec: Serialiser<MovementDatagram> = {
  encode(data: MovementDatagram): Uint8Array {
    const buf = new ArrayBuffer(MOVEMENT_SIZE);
    const v = new DataView(buf);
    v.setUint8(0, DATAGRAM_TYPE_MOVEMENT);
    v.setUint32(1,  data.seq       >>> 0, true);
    v.setUint32(5,  data.tick      >>> 0, true);
    v.setFloat64(9, data.timestamp,       true);
    v.setFloat32(17, data.facing,          true);
    v.setFloat32(21, data.movementX,       true);
    v.setFloat32(25, data.movementY,       true);
    v.setUint32(29, data.actions   >>> 0, true);
    return new Uint8Array(buf);
  },

  decode(bytes: Uint8Array): MovementDatagram {
    if (bytes.byteLength < MOVEMENT_SIZE) {
      throw new Error(`MovementDatagram: expected ${MOVEMENT_SIZE} bytes, got ${bytes.byteLength}`);
    }
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // byte 0 is the type discriminant — already consumed by decodeDatagram
    return {
      seq:       v.getUint32(1,  true),
      tick:      v.getUint32(5,  true),
      timestamp: v.getFloat64(9, true),
      facing:    v.getFloat32(17, true),
      movementX: v.getFloat32(21, true),
      movementY: v.getFloat32(25, true),
      actions:   v.getUint32(29, true),
    };
  },
};

// ---- CommandDatagram codec ----

/** Minimum header size: type(1) + seq(4) + cmdType(1) + payloadLen(2) = 8 bytes. */
const COMMAND_HEADER_SIZE = 8;

function encodeCommandPayload(cmd: CommandPayload): Uint8Array {
  switch (cmd.cmd) {
    case CommandType.Equip:
      return new Uint8Array([cmd.fromInventorySlot]);

    case CommandType.Unequip:
      return new Uint8Array([cmd.equipSlot]);

    case CommandType.MoveItem:
      return new Uint8Array([cmd.fromSlot, cmd.toSlot]);

    case CommandType.DropItem:
      return new Uint8Array([cmd.fromSlot]);

    case CommandType.UseItem:
      return new Uint8Array([cmd.fromSlot]);

    case CommandType.Externalise:
      return new Uint8Array([cmd.fragIndex]);

    case CommandType.Internalise:
      return new Uint8Array([cmd.inventorySlot]);

    case CommandType.TradeBuy: {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, cmd.listingSlot >>> 0, true);
      return new Uint8Array(buf);
    }

    case CommandType.TradeSell:
      return new Uint8Array([cmd.inventorySlot]);

    case CommandType.PlaceBlueprint: {
      const strBytes = new TextEncoder().encode(cmd.structureType);
      const buf = new ArrayBuffer(1 + strBytes.byteLength + 4 + 4);
      const v = new DataView(buf);
      const u8 = new Uint8Array(buf);
      v.setUint8(0, strBytes.byteLength);
      u8.set(strBytes, 1);
      v.setFloat32(1 + strBytes.byteLength,     cmd.worldX, true);
      v.setFloat32(1 + strBytes.byteLength + 4, cmd.worldY, true);
      return u8;
    }

    case CommandType.DeployItem:
      return new Uint8Array([cmd.inventorySlot]);

    case CommandType.SelectRecipe: {
      const strBytes = new TextEncoder().encode(cmd.recipeId);
      const buf = new ArrayBuffer(1 + strBytes.byteLength);
      const u8 = new Uint8Array(buf);
      u8[0] = strBytes.byteLength;
      u8.set(strBytes, 1);
      return u8;
    }
  }
}

function decodeCommandPayload(cmdType: number, bytes: Uint8Array): CommandPayload | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (cmdType) {
    case CommandType.Equip:
      return { cmd: CommandType.Equip, fromInventorySlot: bytes[0] };

    case CommandType.Unequip:
      return { cmd: CommandType.Unequip, equipSlot: bytes[0] as EquipSlotIndex };

    case CommandType.MoveItem:
      return { cmd: CommandType.MoveItem, fromSlot: bytes[0], toSlot: bytes[1] };

    case CommandType.DropItem:
      return { cmd: CommandType.DropItem, fromSlot: bytes[0] };

    case CommandType.UseItem:
      return { cmd: CommandType.UseItem, fromSlot: bytes[0] };

    case CommandType.Externalise:
      return { cmd: CommandType.Externalise, fragIndex: bytes[0] };

    case CommandType.Internalise:
      return { cmd: CommandType.Internalise, inventorySlot: bytes[0] };

    case CommandType.TradeBuy:
      return { cmd: CommandType.TradeBuy, listingSlot: v.getUint32(0, true) };

    case CommandType.TradeSell:
      return { cmd: CommandType.TradeSell, inventorySlot: bytes[0] };

    case CommandType.PlaceBlueprint: {
      const strLen = bytes[0];
      const structureType = new TextDecoder().decode(bytes.slice(1, 1 + strLen));
      const dv = new DataView(bytes.buffer, bytes.byteOffset + 1 + strLen, 8);
      const worldX = dv.getFloat32(0, true);
      const worldY = dv.getFloat32(4, true);
      return { cmd: CommandType.PlaceBlueprint, structureType, worldX, worldY };
    }

    case CommandType.DeployItem:
      return { cmd: CommandType.DeployItem, inventorySlot: bytes[0] };

    case CommandType.SelectRecipe: {
      const strLen = bytes[0];
      const recipeId = new TextDecoder().decode(bytes.slice(1, 1 + strLen));
      return { cmd: CommandType.SelectRecipe, recipeId };
    }

    default:
      // Unknown command type — forward-compatible skip (caller uses payloadLen).
      return null;
  }
}

export const commandDatagramCodec: Serialiser<CommandDatagram> = {
  encode(data: CommandDatagram): Uint8Array {
    const payload = encodeCommandPayload(data.command);
    const buf = new ArrayBuffer(COMMAND_HEADER_SIZE + payload.byteLength);
    const v = new DataView(buf);
    v.setUint8(0, DATAGRAM_TYPE_COMMAND);
    v.setUint32(1, data.seq >>> 0, true);
    v.setUint8(5, data.command.cmd);
    v.setUint16(6, payload.byteLength, true);
    new Uint8Array(buf).set(payload, COMMAND_HEADER_SIZE);
    return new Uint8Array(buf);
  },

  decode(bytes: Uint8Array): CommandDatagram {
    if (bytes.byteLength < COMMAND_HEADER_SIZE) {
      throw new Error(`CommandDatagram: too short (${bytes.byteLength} bytes)`);
    }
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq        = v.getUint32(1, true);
    const cmdType    = v.getUint8(5);
    const payloadLen = v.getUint16(6, true);
    const payload    = bytes.slice(COMMAND_HEADER_SIZE, COMMAND_HEADER_SIZE + payloadLen);

    const command = decodeCommandPayload(cmdType, payload);
    if (command === null) {
      throw new Error(`CommandDatagram: unknown cmdType ${cmdType}`);
    }
    return { seq, command };
  },
};

// ---- Top-level datagram dispatcher ----

export type DecodedDatagram =
  | { kind: "movement"; data: MovementDatagram }
  | { kind: "command";  data: CommandDatagram }
  | { kind: "unknown";  typeByte: number };

/**
 * Inspect the leading type byte and decode the appropriate datagram.
 * The server calls this once per received datagram before dispatching.
 */
export function decodeDatagram(bytes: Uint8Array): DecodedDatagram {
  if (bytes.byteLength === 0) return { kind: "unknown", typeByte: 0 };
  const typeByte = bytes[0];
  switch (typeByte) {
    case DATAGRAM_TYPE_MOVEMENT:
      return { kind: "movement", data: movementDatagramCodec.decode(bytes) };
    case DATAGRAM_TYPE_COMMAND: {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < COMMAND_HEADER_SIZE) return { kind: "unknown", typeByte };
      const cmdType    = v.getUint8(5);
      const payloadLen = v.getUint16(6, true);
      const payload    = bytes.slice(COMMAND_HEADER_SIZE, COMMAND_HEADER_SIZE + payloadLen);
      const command    = decodeCommandPayload(cmdType, payload);
      if (command === null) return { kind: "unknown", typeByte };
      const seq = v.getUint32(1, true);
      return { kind: "command", data: { seq, command } };
    }
    default:
      return { kind: "unknown", typeByte };
  }
}

