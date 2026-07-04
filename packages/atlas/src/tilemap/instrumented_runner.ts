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
import type { PipelineBase, FieldsState } from "./pipeline/state.ts";
import { emptyLevel } from "./level/types.ts";
import type { GenParams } from "../genparams.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import type { ContentService } from "@voxim/content";
import { hashString, hashBytes } from "@voxim/levelgen";
import { DEFAULT_TILE_SIZE, DEFAULT_GRID_SIZE } from "./types.ts";
import { bytesToBase64, base64ToBytes } from "./generate.ts";

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
  /**
   * Error message if the stage's transformer threw. Set by the reorder
   * UI's exploratory mode — when a stage runs out of order its state
   * dependencies may not hold and it'll throw. The runner records the
   * error here and skips the rest of the pipeline so the inspector
   * can surface "this stage broke at the new order" without crashing
   * the server.
   */
  error?: string;
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
  /**
   * Optional stage order override (T-214 step 4 — inspector
   * "reducer reordering" mode). When set, the runner iterates this
   * list instead of `ORDERED_STAGES`. Each id must reference a known
   * stage and appear at most once. Stages whose state dependencies
   * aren't met by the prior stage may crash or produce nonsense —
   * that's the point of the feature, it's an exploratory tool.
   */
  stageOrder?: StageId[];
}

export interface InstrumentedRunOutput {
  /** Final state after the full pipeline (POI network is the last stage). */
  final: FieldsState;
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
    level: emptyLevel({
      gridSize, tileSize, seed: input.tileSeed,
      cellX: input.worldCell.cellX, cellY: input.worldCell.cellY,
    }),
  };

  let state: unknown = initial;
  let prevHash = 0;
  let skipping = !!input.resumeFromStage;
  const prefix: Array<{ id: string; params: unknown }> = [];

  // Resolve the actual stage order to run. The default is the canonical
  // `ORDERED_STAGES`; `input.stageOrder` overrides for the inspector's
  // reordering UI.
  const orderIds = input.stageOrder ?? ORDERED_STAGES.map(s => s.id);
  const stageById = new Map(ORDERED_STAGES.map(s => [s.id, s]));
  const stagesToRun = orderIds
    .map(id => stageById.get(id))
    .filter((s): s is typeof ORDERED_STAGES[number] => s !== undefined);

  for (const stage of stagesToRun) {
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
      try {
        state = stage.transformer(state, input.tileSeed, stageParams);
      } catch (err) {
        // Reorder mode: a stage may run before its dependencies and
        // throw. Record the error in the trace and stop the pipeline
        // here — the rest of the trace gets empty entries so the
        // inspector can still show the prefix.
        const durationMs = performance.now() - t0;
        trace.push({
          stageId: stage.id, label: stage.label, durationMs,
          cacheHit: false, inputHash: prevHash, outputHash: 0,
          error: (err as Error)?.message ?? String(err),
        });
        return { final: state as FieldsState, trace, intermediates };
      }
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

  return { final: state as FieldsState, trace, intermediates };
}

// ---- hashing --------------------------------------------------------------

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
 *   fields:          all FieldPlanes planes (T-315 A5)
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
      h ^= hashBytes(viewOf(s.noiseField as Float32Array));
      break;
    case "junctions":
      h ^= hashString(JSON.stringify(s.seeds));
      break;
    case "network":
      h ^= hashBytes(s.openMask as Uint8Array);
      h ^= hashBytes(s.degrees as Uint8Array);
      h ^= hashString(JSON.stringify(s.corridors));
      break;
    case "rooms":
      h ^= hashBytes(s.openMask as Uint8Array);
      h ^= hashBytes(viewOf(s.chamberOf as Uint16Array));
      h ^= hashString(JSON.stringify(s.chambers));
      break;
    case "portalPlacement":
      h ^= hashBytes(s.openMask as Uint8Array);
      h ^= hashBytes(viewOf(s.roomOf as Uint16Array));
      h ^= hashString(JSON.stringify(s.rooms));
      h ^= hashString(JSON.stringify(s.portals));
      h ^= hashString(JSON.stringify(s.corridors));
      break;
    case "boundaryKinds":
      h ^= hashBytes(viewOf(s.kindOf as Uint16Array));
      break;
    case "rivers":
      h ^= hashBytes(s.openMask as Uint8Array);
      h ^= hashBytes(viewOf(s.kindOf as Uint16Array));
      break;
    case "terrain":
      h ^= hashBytes(viewOf(s.heightMap as Float32Array));
      break;
    case "materials":
      h ^= hashBytes(viewOf(s.materials as Uint16Array));
      break;
    case "zoneGraph":
      h ^= hashBytes(viewOf(s.zoneOf as Uint16Array));
      // T-214: regions live on state.level after zoneGraph; hash both
      // the legacy `zones` (still used by poi_network) and the LevelDef
      // regions so a divergence in either flags as a fixture diff.
      h ^= hashString(JSON.stringify(s.zones));
      h ^= hashString(JSON.stringify((s.level as { regions: unknown }).regions));
      break;
    case "cliff": {
      // T-311 P6 — same "never let a new stage's output go unhashed"
      // discipline the T-315 A5 fields fix established.
      const c = s.cliff as Record<string, ArrayBufferView>;
      for (const k of Object.keys(c).sort()) h ^= hashBytes(viewOf(c[k]));
      break;
    }
    case "poiNetwork":
      // T-214: narrative + stairs are now on state.level; their JSON
      // shape is the canonical hash input for the matcher's output.
      h ^= hashString(JSON.stringify((s.level as { narrative: unknown }).narrative));
      h ^= hashString(JSON.stringify((s.level as { edges: { stairs: unknown } }).edges.stairs));
      break;
    case "fields": {
      // T-315 A5: was silently excluded — a corrupted/regressed field
      // plane was invisible to divergence detection. Sorted key order
      // keeps the xor combination deterministic (doesn't affect the
      // result, which is order-independent anyway, per the doc above).
      const f = s.fields as Record<string, ArrayBufferView>;
      for (const k of Object.keys(f).sort()) h ^= hashBytes(viewOf(f[k]));
      break;
    }
  }
  return h >>> 0;
}

// ---- dump / load round-trip ----------------------------------------------

/**
 * Encode a pipeline state to a wire-friendly JSON object: typed arrays
 * become base64 with a kind tag. Anything else passes through as JSON.
 */
function encodeTA(v: unknown): { __ta: string; b64: string } | null {
  if (v instanceof Uint8Array)   return { __ta: "u8",  b64: bytesToBase64(v) };
  if (v instanceof Uint16Array)  return { __ta: "u16", b64: bytesToBase64(viewOf(v)) };
  if (v instanceof Float32Array) return { __ta: "f32", b64: bytesToBase64(viewOf(v)) };
  return null;
}

/** A flat object whose every value is a typed array — e.g. the T-311 `fields`
 *  plane bundle. Encoded under `__planes` so decode can recurse one level. */
function isPlaneBundle(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const vals = Object.values(v as Record<string, unknown>);
  return vals.length > 0 && vals.every((x) =>
    x instanceof Uint8Array || x instanceof Uint16Array || x instanceof Float32Array);
}

export function encodeState(state: unknown): unknown {
  const s = state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    const ta = encodeTA(v);
    if (ta) out[k] = ta;
    else if (isPlaneBundle(v)) {
      const planes: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) planes[ik] = encodeTA(iv);
      out[k] = { __planes: planes };
    } else out[k] = v;
  }
  return out;
}

function decodeTA(tagged: { __ta: string; b64: string }): unknown {
  const bytes = base64ToBytes(tagged.b64);
  if (tagged.__ta === "u8")  return bytes;
  if (tagged.__ta === "u16") return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  if (tagged.__ta === "f32") return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  throw new Error(`unknown typed-array tag ${tagged.__ta}`);
}

export function decodeState(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === "object" && "__ta" in v && "b64" in v) {
      out[k] = decodeTA(v as { __ta: string; b64: string });
    } else if (v && typeof v === "object" && "__planes" in v) {
      const planes: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries((v as { __planes: Record<string, { __ta: string; b64: string }> }).__planes)) {
        planes[ik] = decodeTA(iv);
      }
      out[k] = planes;
    } else {
      out[k] = v;
    }
  }
  return out;
}

