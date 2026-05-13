/**
 * LevelDef pipeline-output invariants (T-214).
 *
 * Runs `generateTile` against the standard snapshot matrix and verifies
 * the LevelDef each reducer stage cooperatively builds:
 *   - every region carries a unique zoneId touched by zoneOf
 *   - plateau regions carry `jumpable: false`
 *   - stair edges resolve to real regions (path → plateau)
 *   - POIs host on real regions; trinkets reference real POIs
 *   - portal edges resolve to a host region
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import { generateTile } from "../generate.ts";
import { generateWorldMap } from "../../worldmap/generate.ts";
import { PRESETS } from "../../genparams.ts";
import { findRegion, levelToZoneOf } from "./types.ts";

const world = generateWorldMap(0, 4, 4);
function cell(cx: number, cy: number) {
  const c = world.cells[cy * 4 + cx];
  if (!c) throw new Error(`no cell at (${cx},${cy})`);
  return c;
}

Deno.test("LevelDef: every region's pixels round-trip through levelToZoneOf", async () => {
  const content = await JsonSource.load();
  const t = generateTile(cell(1, 1), 1001, { params: PRESETS.forest_maze.params, content });
  const zoneIds = new Set(t.level.regions.map(r => r.zoneId));
  assertEquals(zoneIds.size, t.level.regions.length, "region zoneIds are unique");
  // Regions own their pixels — their area must equal pixel count, and
  // the derived zoneOf must contain every region's zoneId in those
  // pixels (and only those).
  const zoneOf = levelToZoneOf(t.level);
  for (const r of t.level.regions) {
    assertEquals(r.area, r.pixels.length, `region ${r.id} area=${r.area} ≠ pixels=${r.pixels.length}`);
    for (const idx of r.pixels) {
      assertEquals(zoneOf[idx], r.zoneId, `region ${r.id} owns idx=${idx} but zoneOf says ${zoneOf[idx]}`);
    }
  }
});

Deno.test("LevelDef: plateau regions all carry jumpable: false", async () => {
  const content = await JsonSource.load();
  const t = generateTile(cell(2, 3), 2002, { params: PRESETS.forest_maze.params, content });
  let plateauCount = 0;
  for (const r of t.level.regions) {
    if (r.kind === "plateau") {
      plateauCount++;
      assertEquals(r.jumpable, false);
    }
  }
  assert(plateauCount > 0, "expected at least one plateau region in forest_maze");
});

Deno.test("LevelDef: stair edges reference real regions on both sides", async () => {
  const content = await JsonSource.load();
  const t = generateTile(cell(3, 0), 4004, { params: PRESETS.cliff_dungeon.params, content });
  for (const s of t.level.edges.stairs) {
    assert(findRegion(t.level, s.from), `stair ${s.id} from=${s.from} missing`);
    assert(findRegion(t.level, s.to),   `stair ${s.id} to=${s.to} missing`);
    const to = findRegion(t.level, s.to);
    assertEquals(to?.kind, "plateau", `stair ${s.id} should land on a plateau`);
    // climbDir is one of the 4 cardinals.
    const sum = Math.abs(s.climbDir.dx) + Math.abs(s.climbDir.dy);
    assertEquals(sum, 1, `stair ${s.id} climbDir not cardinal: ${JSON.stringify(s.climbDir)}`);
  }
});

Deno.test("LevelDef: every POI hosts on a real region; every trinket references real POIs", async () => {
  const content = await JsonSource.load();
  const t = generateTile(cell(1, 1), 1001, { params: PRESETS.forest_maze.params, content });
  const poiIds = new Set(t.level.narrative.pois.map(p => p.id));
  for (const p of t.level.narrative.pois) {
    assert(findRegion(t.level, p.hostRegion), `poi ${p.id} host=${p.hostRegion} missing`);
  }
  for (const tr of t.level.narrative.trinkets) {
    assert(poiIds.has(tr.sourcePoi), `trinket ${tr.id} sourcePoi=${tr.sourcePoi} missing`);
    assert(poiIds.has(tr.destPoi),   `trinket ${tr.id} destPoi=${tr.destPoi} missing`);
  }
});

Deno.test("LevelDef: portals attach to a host region", async () => {
  const content = await JsonSource.load();
  const t = generateTile(cell(0, 2), 3003, { params: PRESETS.open_plains.params, content });
  // Tile may have 0..4 portals depending on gate presence; just verify any
  // that exist have a valid host.
  for (const p of t.level.edges.portals) {
    assert(findRegion(t.level, p.hostRegion), `portal ${p.id} host=${p.hostRegion} missing`);
  }
});
