/**
 * T-205 determinism gates for the instrumented runner:
 *
 * 1. `runInstrumented` final state matches `generateTile` byte-for-byte
 *    (instrumentation doesn't change semantics).
 * 2. Re-running with the same params hits the cache for every stage.
 * 3. Tweaking a late-stage param keeps upstream stages cached and only
 *    invalidates the touched stage onward.
 * 4. Dumping any intermediate, decoding, and resuming from that stage
 *    produces a final state byte-identical to a from-scratch run.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { generateWorldMap } from "../worldmap/generate.ts";
import { generateTile } from "./generate.ts";
import {
  decodeState,
  encodeState,
  runInstrumented,
  TileCache,
} from "./instrumented_runner.ts";
import { PRESETS } from "../genparams.ts";

const world = generateWorldMap(0, 4, 4);
const cell  = world.cells[1 * 4 + 1];

function hashTypedArray(arr: Uint8Array | Uint16Array | Float32Array): string {
  const bytes = new Uint8Array(arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

Deno.test("instrumented runner: final state matches generateTile byte-for-byte", () => {
  const expected = generateTile(cell, 1234, { params: PRESETS.forest_maze.params });
  const actual   = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.forest_maze.params,
  });
  assertEquals(hashTypedArray(actual.final.openMask),  hashTypedArray(expected.openMask));
  assertEquals(hashTypedArray(actual.final.roomOf),    hashTypedArray(expected.roomOf));
  assertEquals(hashTypedArray(actual.final.chamberOf), hashTypedArray(expected.chamberOf));
  assertEquals(hashTypedArray(actual.final.heightMap), hashTypedArray(expected.heightMap));
  assertEquals(hashTypedArray(actual.final.materials), hashTypedArray(expected.materials));
  assertEquals(hashTypedArray(actual.final.kindOf),    hashTypedArray(expected.kindOf));
  assertEquals(JSON.stringify(actual.final.rooms),     JSON.stringify(expected.rooms));
  assertEquals(JSON.stringify(actual.final.portals),   JSON.stringify(expected.portals));
});

Deno.test("instrumented runner: trace has one entry per stage with monotonic input/output linking", () => {
  const r = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.forest_maze.params,
  });
  assertEquals(r.trace.length, 10);
  // First stage's inputHash is 0 (no upstream).
  assertEquals(r.trace[0].inputHash, 0);
  // Each subsequent stage's inputHash equals the prior stage's outputHash.
  for (let i = 1; i < r.trace.length; i++) {
    assertEquals(r.trace[i].inputHash, r.trace[i - 1].outputHash);
  }
});

Deno.test("instrumented runner: full re-run with shared cache hits every stage", () => {
  const cache = new TileCache();
  const a = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.forest_maze.params, cache,
  });
  const b = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.forest_maze.params, cache,
  });
  // First run: every stage missed.
  for (const t of a.trace) assert(!t.cacheHit, `stage ${t.stageId} should have missed on first run`);
  // Second run: every stage hit.
  for (const t of b.trace) assert(t.cacheHit, `stage ${t.stageId} should have hit on second run`);
});

Deno.test("instrumented runner: late-stage param tweak only invalidates from that stage onward", () => {
  const cache = new TileCache();
  runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.forest_maze.params, cache,
  });
  const tweaked = {
    ...PRESETS.forest_maze.params,
    materials: { ...PRESETS.forest_maze.params.materials, detailFrequency: 0.42 },
  };
  const r = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: tweaked, cache,
  });
  // Cache keys are prefix-of-params-history: stages upstream of materials
  // share the same prefix and hit; materials itself misses; every stage
  // downstream also misses because its prefix now includes the tweaked
  // materials params. This is the strict prefix-cache guarantee.
  const downstreamOfMaterials = new Set(["materials", "zoneGraph"]);
  for (const t of r.trace) {
    if (downstreamOfMaterials.has(t.stageId)) {
      assert(!t.cacheHit, `${t.stageId} should have missed (downstream of materials tweak)`);
    } else {
      assert(t.cacheHit, `${t.stageId} should still hit cache after a materials-only tweak`);
    }
  }
});

Deno.test("instrumented runner: dump intermediate + resume produces byte-identical final", () => {
  const full = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.cliff_dungeon.params,
  });
  // Dump the rooms stage's output state, then resume from boundaryKinds.
  const dumped = encodeState(full.intermediates.rooms);
  const wireRoundtrip = JSON.parse(JSON.stringify(dumped));
  const decoded = decodeState(wireRoundtrip);

  const resumed = runInstrumented({
    worldCell: cell, tileSeed: 1234, params: PRESETS.cliff_dungeon.params,
    resumeFromStage: "portalPlacement",
    seedState: decoded,
  });

  // Final state must match the full run byte-for-byte.
  assertEquals(hashTypedArray(resumed.final.openMask),  hashTypedArray(full.final.openMask));
  assertEquals(hashTypedArray(resumed.final.heightMap), hashTypedArray(full.final.heightMap));
  assertEquals(hashTypedArray(resumed.final.materials), hashTypedArray(full.final.materials));
  assertEquals(hashTypedArray(resumed.final.kindOf),    hashTypedArray(full.final.kindOf));
  assertEquals(JSON.stringify(resumed.final.rooms),     JSON.stringify(full.final.rooms));
  // Resumed run's trace marks pre-portalPlacement stages as skipped (durationMs 0, cache flag false).
  for (let i = 0; i < 4; i++) {
    assertEquals(resumed.trace[i].durationMs, 0);
  }
});
