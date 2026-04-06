/**
 * Wire codecs for the two protocol message types.
 *
 * These live in @voxim/protocol — the shared package — so both the tile server
 * and the client import from the same source.  A format change is a compile
 * error on both ends simultaneously.
 *
 * InputDatagram — fixed 36-byte little-endian binary:
 *   u32 seq | u32 tick | f64 timestamp | f32 facing | f32 movX | f32 movY | u32 actions | u32 interactSlot
 *
 * StateMessage — length-prefixed JSON:
 *   [4-byte LE u32 payload length][UTF-8 JSON payload]
 *   Uint8Array fields are tagged: { __t: "u8", b: "<base64>" }
 */
import type { Serialiser } from "@voxim/engine";
import type { InputDatagram } from "./messages.ts";
import type { StateMessage } from "./messages.ts";

// ---- InputDatagram codec ----

const INPUT_SIZE = 36;

export const inputDatagramCodec: Serialiser<InputDatagram> = {
  encode(data: InputDatagram): Uint8Array {
    const buf = new ArrayBuffer(INPUT_SIZE);
    const v = new DataView(buf);
    v.setUint32(0, data.seq >>> 0, true);
    v.setUint32(4, data.tick >>> 0, true);
    v.setFloat64(8, data.timestamp, true);
    v.setFloat32(16, data.facing, true);
    v.setFloat32(20, data.movementX, true);
    v.setFloat32(24, data.movementY, true);
    v.setUint32(28, data.actions >>> 0, true);
    v.setUint32(32, data.interactSlot >>> 0, true);
    return new Uint8Array(buf);
  },

  decode(bytes: Uint8Array): InputDatagram {
    if (bytes.byteLength < INPUT_SIZE) {
      throw new Error(`InputDatagram: expected ${INPUT_SIZE} bytes, got ${bytes.byteLength}`);
    }
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      seq: v.getUint32(0, true),
      tick: v.getUint32(4, true),
      timestamp: v.getFloat64(8, true),
      facing: v.getFloat32(16, true),
      movementX: v.getFloat32(20, true),
      movementY: v.getFloat32(24, true),
      actions: v.getUint32(28, true),
      interactSlot: v.getUint32(32, true),
    };
  },
};

// ---- StateMessage codec ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Process in 8 KiB chunks to avoid hitting V8's max-arguments-per-call limit
// (~65535), which would throw RangeError for large component buffers.
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let str = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(str);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __t: "u8", b: uint8ToBase64(value) };
  }
  return value;
}

export const stateMessageCodec: Serialiser<StateMessage> = {
  encode(data: StateMessage): Uint8Array {
    const json = JSON.stringify(data, replacer);
    const payload = encoder.encode(json);
    const out = new Uint8Array(4 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, payload.byteLength, true);
    out.set(payload, 4);
    return out;
  },

  decode(bytes: Uint8Array): StateMessage {
    const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    const json = decoder.decode(bytes.slice(4, 4 + len));
    return JSON.parse(json, (_key, value) => {
      if (value && typeof value === "object" && value.__t === "u8") {
        return Uint8Array.from(atob(value.b as string), (c) => c.charCodeAt(0));
      }
      return value;
    }) as StateMessage;
  },
};

/**
 * Pre-encode the shared delta payload (expensive: JSON.stringify with base64).
 * Call ONCE per tick, then pass the result to encodeStateMessageFast for each session.
 *
 * Returns a JSON fragment for { entityDeltas, entityDestroys, events } — the
 * fields that are identical for every connected player in a given tick.
 */
export function encodeStateDeltaPayload(data: {
  entityDeltas: StateMessage["entityDeltas"];
  entityDestroys: StateMessage["entityDestroys"];
  events: StateMessage["events"];
}): string {
  return JSON.stringify(data, replacer);
}

/**
 * Assemble + frame a StateMessage per session using a pre-encoded delta payload.
 * Cheap: only string concatenation + UTF-8 encode, no JSON replacer.
 *
 * @param serverTick     Current server tick.
 * @param ackInputSeq    Last processed input seq for this specific player.
 * @param deltaPayloadJson  Output of encodeStateDeltaPayload().
 */
export function encodeStateMessageFast(
  serverTick: number,
  ackInputSeq: number,
  deltaPayloadJson: string,
): Uint8Array {
  // deltaPayloadJson = '{"entityDeltas":[...],"entityDestroys":[...],"events":[...]}'
  // Slice off the leading '{' and prepend the per-session header fields.
  const inner = deltaPayloadJson.slice(1);
  const json = `{"serverTick":${serverTick},"ackInputSeq":${ackInputSeq},${inner}`;
  const payload = encoder.encode(json);
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}
