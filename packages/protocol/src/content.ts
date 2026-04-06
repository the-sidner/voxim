/**
 * Content channel — reliable bidirectional stream, client ↔ server.
 *
 * The client opens one long-lived bidi stream after the join handshake and
 * uses it to request model definitions and materials on demand.  The server
 * responds in-order on the same stream.  Requests can be pipelined.
 *
 * Wire format: length-prefixed JSON (same framing as the join handshake).
 *   [4-byte LE u32 payload length][UTF-8 JSON]
 *
 * Types for model and material definitions live in @voxim/content — imported
 * here so both ends share a single source of truth without duplication.
 */
import type { Serialiser } from "@voxim/engine";
import type { ModelDefinition, MaterialDef, SkeletonDef } from "@voxim/content";

// Re-export so consumers can import wire types from @voxim/protocol.
export type { ModelDefinition, MaterialDef, SkeletonDef } from "@voxim/content";

// ---- request ----

export type ContentRequest =
  | { type: "model_req";    modelId:    string }
  | { type: "material_req"; materialId: number }
  | { type: "skeleton_req"; skeletonId: string };

// ---- response ----

export type ContentResponse =
  | { type: "model_def";    modelId:    string; version: number; def: ModelDefinition }
  | { type: "material_def"; materialId: number; def: MaterialDef                      }
  | { type: "skeleton_def"; skeletonId: string; def: SkeletonDef                      }
  | { type: "not_found";    id:         string };

// ---- codecs ----

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  const payload = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

function decodeJson<T>(bytes: Uint8Array): T {
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return JSON.parse(dec.decode(bytes.slice(4, 4 + len))) as T;
}

export const contentRequestCodec: Serialiser<ContentRequest> = {
  encode: encodeJson,
  decode: (b) => decodeJson<ContentRequest>(b),
};

export const contentResponseCodec: Serialiser<ContentResponse> = {
  encode: encodeJson,
  decode: (b) => decodeJson<ContentResponse>(b),
};
