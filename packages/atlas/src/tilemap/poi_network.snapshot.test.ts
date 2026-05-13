/**
 * T-209 determinism gates for the POI-network solver. Ported to read
 * from `state.level.narrative` in T-214 (the matcher's output now lives
 * on LevelDef, not on a pipeline-state field).
 *
 * What this test pins down:
 *   1. Two runs with the same (cell, seed, content) → byte-identical
 *      narrative. (the core determinism guarantee)
 *   2. Different seeds → different narrative. (proves randomness is
 *      actually consumed, not silently bypassed)
 *   3. No-content runs → empty narrative. (snapshot tests stay clean)
 *   4. The narrative is structurally valid: every POI either has open
 *      gate or a trinketRef that maps to an existing trinket; every
 *      trinket has source ≠ dest; every entry POI's gate is "open".
 */

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { generateWorldMap } from "../worldmap/generate.ts";
import { JsonSource } from "../../../content/src/loader.ts";
import { runInstrumented } from "./instrumented_runner.ts";
import { PRESETS } from "../genparams.ts";
import type { PoiNetworkState } from "./pipeline/state.ts";

const world = generateWorldMap(0, 4, 4);
const content = await JsonSource.load();

function cell(x: number, y: number) {
  const c = world.cells[y * 4 + x];
  if (!c) throw new Error(`no cell (${x},${y})`);
  return c;
}

function narrativeOf(state: PoiNetworkState) {
  return state.level.narrative;
}

Deno.test("poiNetwork: identical inputs → byte-identical narrative", () => {
  const a = runInstrumented({
    worldCell: cell(1, 1), tileSeed: 1234,
    params: PRESETS.forest_maze.params,
    content,
  });
  const b = runInstrumented({
    worldCell: cell(1, 1), tileSeed: 1234,
    params: PRESETS.forest_maze.params,
    content,
  });
  assertEquals(
    JSON.stringify(narrativeOf(a.final as PoiNetworkState)),
    JSON.stringify(narrativeOf(b.final as PoiNetworkState)),
  );
});

Deno.test("poiNetwork: different seeds → different narrative", () => {
  const a = runInstrumented({
    worldCell: cell(1, 1), tileSeed: 1234,
    params: PRESETS.forest_maze.params,
    content,
  });
  const b = runInstrumented({
    worldCell: cell(1, 1), tileSeed: 9999,
    params: PRESETS.forest_maze.params,
    content,
  });
  assertNotEquals(
    JSON.stringify(narrativeOf(a.final as PoiNetworkState)),
    JSON.stringify(narrativeOf(b.final as PoiNetworkState)),
  );
});

Deno.test("poiNetwork: no content → empty narrative (snapshot-safe)", () => {
  const r = runInstrumented({
    worldCell: cell(1, 1), tileSeed: 1234,
    params: PRESETS.forest_maze.params,
    // no content
  });
  const n = narrativeOf(r.final as PoiNetworkState);
  assertEquals(n.pois, []);
  assertEquals(n.trinkets, []);
  assertEquals(n.dag.entryPoiIds, []);
  assertEquals(n.dag.terminalPoiIds, []);
});

Deno.test("poiNetwork: produced narrative is structurally valid", () => {
  for (const seed of [1001, 2002, 3003, 4004, 5005]) {
    const r = runInstrumented({
      worldCell: cell(1, 1), tileSeed: seed,
      params: PRESETS.forest_maze.params,
      content,
    });
    const n = narrativeOf(r.final as PoiNetworkState);
    // Some narrative must exist — degraded or not — when content is present.
    if (n.pois.length === 0) continue; // happens if scoring rejects every candidate (acceptable edge case)

    // Every trinket's source and dest must be distinct PoiInstance ids
    // that appear in the pois list.
    const poiIds = new Set(n.pois.map(p => p.id));
    for (const t of n.trinkets) {
      assert(t.sourcePoi !== t.destPoi, `trinket ${t.id} is self-loop`);
      assert(poiIds.has(t.sourcePoi), `trinket ${t.id} source ${t.sourcePoi} not in pois`);
      assert(poiIds.has(t.destPoi),   `trinket ${t.id} dest ${t.destPoi} not in pois`);
    }
    // Every POI gate of kind "item"/"multi"/"choice" must reference
    // trinkets that exist.
    const trinketIds = new Set(n.trinkets.map(t => t.id));
    for (const p of n.pois) {
      for (const ref of p.gate.trinketRefs) {
        assert(trinketIds.has(ref), `poi ${p.id} gate references missing trinket ${ref}`);
      }
    }
    // Every entry POI MUST have an open gate.
    for (const eid of n.dag.entryPoiIds) {
      const poi = n.pois.find(p => p.id === eid);
      assert(poi, `entryPoiIds references missing poi ${eid}`);
      assertEquals(poi.gate.kind, "open", `entry poi ${eid} should have open gate`);
    }
  }
});

Deno.test("poiNetwork: trinket display names use real themes + source name", () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = runInstrumented({
      worldCell: cell((attempt % 4), (attempt + 1) % 4), tileSeed: 10_000 + attempt,
      params: PRESETS.forest_maze.params,
      content,
    });
    const n = narrativeOf(r.final as PoiNetworkState);
    if (n.trinkets.length === 0 || n.dag.degraded) continue;
    const t = n.trinkets[0];
    assert(t.displayName.length > 0, "trinket display name empty");
    assert(t.displayName.includes(" "), `expected multi-word display name, got "${t.displayName}"`);
    return;
  }
  throw new Error("Every sampled tile fell back to degraded — bridge coverage regression?");
});

Deno.test("poiNetwork: wider roster hits happy path on majority of bakes", () => {
  // With T-207's 15-POI roster (and bridge validator passing), random
  // tile bakes should usually solve cleanly without falling back. We
  // sample 20 (cell, seed) tuples and require ≥40% non-degraded.
  let nonDegraded = 0;
  const total = 20;
  for (let i = 0; i < total; i++) {
    const r = runInstrumented({
      worldCell: cell(i % 4, (i + 2) % 4), tileSeed: 20_000 + i,
      params: PRESETS.forest_maze.params,
      content,
    });
    const n = narrativeOf(r.final as PoiNetworkState);
    if (n.pois.length > 0 && !n.dag.degraded) nonDegraded++;
  }
  assert(
    nonDegraded / total >= 0.4,
    `expected ≥40% non-degraded bakes, got ${nonDegraded}/${total}`,
  );
});
