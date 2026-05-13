/**
 * Instrumented pipeline runner for the inspector (T-205).
 *
 * Three differences from `generateTile()`:
 *
 * 1. **Per-stage tracing** — duration, content hash, cache-hit flag.
 *    Returned alongside the final state so the inspector can render a
 *    trace panel.
 *
 * 2. **Long-lived per-tile cache** — slider tweaks in the inspector
 *    change one param slice; everything before that slice should hit
 *    cache. The cache key is "seed + the params history up to this
 *    stage" — independent of state content, so we never have to hash
 *    typed-array state to do cache lookups (which would defeat the
 *    purpose for 512² tiles).
 *
 * 3. **Intermediate state dumps** — every stage's output is captured
 *    in a wire-friendly form (typed arrays base64-encoded). The
 *    inspector can render any of them; tests can round-trip them to
 *    prove dump/reload byte-identity.
 *
 * `generateTile()` remains the production fast path — no tracing
 * overhead, no cache, single allocation per call. The inspector pays
 * the instrumentation cost.
 */

import { ORDERED_STAGES, type StageId } from "./pipeline/stages.ts";
import type { PipelineBase, PoiNetworkState } from "./pipeline/state.ts";
import type { GenParams } from "../genparams.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import type { ContentService } from "@voxim/content";

const DEFAULT_TILE_SIZE = 512;
const DEFAULT_GRID_SIZE = 512;

// ---- cache ----------------------------------------------------------------

interface CacheEntry {
  state: unknown;
  outputHash: number;
}

/**
 * Per-tile cache keyed on "prefix of params history through stage N".
 * A late-stage param edit invalidates only that stage onward; earlier
 * stages still hit. Cache is unbounded — atlas keeps one per open tile;
 * call `.clear()` when the inspector closes the tile.
 */
export class TileCache {
  private cache = new Map<string, CacheEntry>();

  get size(): number { return this.cache.size; }

  private keyForPrefix(seed: number, prefix: Array<{ id: string; params: unknown }>): string {
    return `${seed >>> 0}:${JSON.stringify(prefix)}`;
  }

  lookup(seed: number, prefix: Array<{ id: string; params: unknown }>): CacheEntry | undefined {
    return this.cache.get(this.keyForPrefix(seed, prefix));
  }

  store(seed: number, prefix: Array<{ id: string; params: unknown }>, entry: CacheEntry): void {
    this.cache.set(this.keyForPrefix(seed, prefix), entry);
  }

  clear(): void { this.cache.clear(); }
}

// ---- trace ----------------------------------------------------------------

export interface StageTrace {
  stageId: StageId;
  label: string;
  durationMs: number;
  cacheHit: boolean;
  /** Hash of the previous stage's output (or 0 for stage 0). */
  inputHash: number;
  /** Hash of this stage's output. */
  outputHash: number;
}

// ---- runner ---------------------------------------------------------------

export interface InstrumentedRunInput {
  worldCell: WorldCellRecord;
  tileSeed: number;
  params: GenParams;
  tileSize?: number;
  gridSize?: number;
  /** Optional persistent cache for cross-call memoization. */
  cache?: TileCache;
  /** If set, the run is resumed from this stage with `seedState` as the
   * input to that stage. Upstream stages are skipped (cache untouched). */
  resumeFromStage?: StageId;
  /** Required if `resumeFromStage` is set; produced by `dumpStage()`. */
  seedState?: unknown;
  /**
   * Optional content store — threaded into PipelineBase so the
   * Tier-6 POI network stage (T-209) can look up POI definitions.
   * When absent, the POI stage emits an empty narrative.
   */
  content?: ContentService;
}

export interface InstrumentedRunOutput {
  /** Final state after the full pipeline (POI network is the last stage). */
  final: PoiNetworkState;
  /** One entry per stage actually run (or skipped, in resume mode). */
  trace: StageTrace[];
  /** Per-stage output snapshot. Keys = StageId; values = the stage's TOut. */
  intermediates: Record<StageId, unknown>;
}

export function runInstrumented(input: InstrumentedRunInput): InstrumentedRunOutput {
  const tileSize = input.tileSize ?? DEFAULT_TILE_SIZE;
  const gridSize = input.gridSize ?? DEFAULT_GRID_SIZE;
  const px2world = tileSize / gridSize;

  const trace: StageTrace[] = [];
  const intermediates = {} as Record<StageId, unknown>;

  const initial: PipelineBase = {
    worldCell: input.worldCell, tileSize, gridSize, px2world,
    content: input.content,
  };

  let state: unknown = initial;
  let prevHash = 0;
  let skipping = !!input.resumeFromStage;
  const prefix: Array<{ id: string; params: unknown }> = [];

  for (const stage of ORDERED_STAGES) {
    const stageParams = (input.params as unknown as Record<string, unknown>)[stage.paramsKey];
    prefix.push({ id: stage.id, params: stageParams });

    if (skipping) {
      if (stage.id === input.resumeFromStage) {
        // Drop the dumped state in as this stage's *input* — we still
        // run this stage. (Resume means "resume *at* this stage.")
        state = input.seedState;
        skipping = false;
      } else {
        trace.push({
          stageId: stage.id, label: stage.label, durationMs: 0,
          cacheHit: false, inputHash: 0, outputHash: 0,
        });
        continue;
      }
    }

    const cached = input.cache?.lookup(input.tileSeed, prefix);
    const t0 = performance.now();
    let outputHash: number;
    let cacheHit = false;

    if (cached) {
      state = cached.state;
      outputHash = cached.outputHash;
      cacheHit = true;
    } else {
      state = stage.transformer(state, input.tileSeed, stageParams);
      outputHash = hashStageOutput(stage.id, state);
      input.cache?.store(input.tileSeed, prefix, { state, outputHash });
    }

    const durationMs = performance.now() - t0;
    trace.push({
      stageId:  stage.id,
      label:    stage.label,
      durationMs,
      cacheHit,
      inputHash: prevHash,
      outputHash,
    });
    intermediates[stage.id] = state;
    prevHash = outputHash;
  }

  return { final: state as PoiNetworkState, trace, intermediates };
}

// ---- hashing --------------------------------------------------------------

/**
 * FNV-1a 32-bit over a byte view. Cheap (~1 ms / 512² Uint16Array on
 * a modern CPU) and stable across engines. Caller passes a Uint8Array
 * view so we don't allocate.
 */
function fnv1aBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fnv1aString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function viewOf(arr: ArrayBufferView): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Hash the fields each stage produces or mutates. Combined into one
 * u32 via xor — order doesn't matter, and collision probability is
 * fine for display + divergence detection.
 *
 * Per-stage contribution (what should drive the hash):
 *   noiseField:      noiseField
 *   junctions:       seeds
 *   network:         openMask, corridors, degrees
 *   rooms:           openMask (mutated), chamberOf, chambers
 *   portalPlacement: openMask (mutated), corridors (appended), rooms,
 *                    roomOf, portals
 *   boundaryKinds:   kindOf
 *   rivers:          openMask (mutated), kindOf (mutated)
 *   terrain:         heightMap
 *   materials:       materials
 *
 * Hash always covers the union of all mutable fields a stage might
 * have touched, even if no actual change occurred — that's a strict
 * upper bound on "what changed" and keeps the hash function simple.
 */
function hashStageOutput(stageId: StageId, state: unknown): number {
  const s = state as Record<string, unknown>;
  let h = 0;
  switch (stageId) {
    case "noiseField":
      h ^= fnv1aBytes(viewOf(s.noiseField as Float32Array));
      break;
    case "junctions":
      h ^= fnv1aString(JSON.stringify(s.seeds));
      break;
    case "network":
      h ^= fnv1aBytes(s.openMask as Uint8Array);
      h ^= fnv1aBytes(s.degrees as Uint8Array);
      h ^= fnv1aString(JSON.stringify(s.corridors));
      break;
    case "rooms":
      h ^= fnv1aBytes(s.openMask as Uint8Array);
      h ^= fnv1aBytes(viewOf(s.chamberOf as Uint16Array));
      h ^= fnv1aString(JSON.stringify(s.chambers));
      break;
    case "portalPlacement":
      h ^= fnv1aBytes(s.openMask as Uint8Array);
      h ^= fnv1aBytes(viewOf(s.roomOf as Uint16Array));
      h ^= fnv1aString(JSON.stringify(s.rooms));
      h ^= fnv1aString(JSON.stringify(s.portals));
      h ^= fnv1aString(JSON.stringify(s.corridors));
      break;
    case "boundaryKinds":
      h ^= fnv1aBytes(viewOf(s.kindOf as Uint16Array));
      break;
    case "rivers":
      h ^= fnv1aBytes(s.openMask as Uint8Array);
      h ^= fnv1aBytes(viewOf(s.kindOf as Uint16Array));
      break;
    case "terrain":
      h ^= fnv1aBytes(viewOf(s.heightMap as Float32Array));
      break;
    case "materials":
      h ^= fnv1aBytes(viewOf(s.materials as Uint16Array));
      break;
    case "zoneGraph":
      h ^= fnv1aBytes(viewOf(s.zoneOf as Uint16Array));
      h ^= fnv1aString(JSON.stringify(s.zones));
      break;
    case "poiNetwork":
      h ^= fnv1aString(JSON.stringify(s.narrative));
      break;
  }
  return h >>> 0;
}

// ---- dump / load round-trip ----------------------------------------------

/**
 * Encode a pipeline state to a wire-friendly JSON object: typed arrays
 * become base64 with a kind tag. Anything else passes through as JSON.
 */
export function encodeState(state: unknown): unknown {
  const s = state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v instanceof Uint8Array)   out[k] = { __ta: "u8",  b64: b64Of(v) };
    else if (v instanceof Uint16Array)  out[k] = { __ta: "u16", b64: b64Of(viewOf(v)) };
    else if (v instanceof Float32Array) out[k] = { __ta: "f32", b64: b64Of(viewOf(v)) };
    else out[k] = v;
  }
  return out;
}

export function decodeState(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === "object" && "__ta" in v && "b64" in v) {
      const tagged = v as { __ta: string; b64: string };
      const bytes = bytesFromB64(tagged.b64);
      if      (tagged.__ta === "u8")  out[k] = bytes;
      else if (tagged.__ta === "u16") out[k] = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      else if (tagged.__ta === "f32") out[k] = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      else throw new Error(`unknown typed-array tag ${tagged.__ta}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function b64Of(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
