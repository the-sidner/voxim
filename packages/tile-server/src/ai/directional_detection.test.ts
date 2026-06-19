/**
 * Directional NPC threat detection (T-016): an NPC sees a target at full
 * `aggroRangeSq` only inside its forward cone; behind/flanking it only sees a
 * much shorter `rearRangeSq`. Frontal approach is always caught; flanking an
 * unaware NPC is viable.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { Position, Health } from "../components/game.ts";
import { SpatialGrid } from "../spatial_grid.ts";
import { findNearestThreatInArc } from "./plan_helpers.ts";

// game_config values under test.
const AGGRO_SQ = 225;          // 15 units frontal
const CONE = 1.2217;           // ±70°
const REAR_SQ = AGGRO_SQ * 0.08; // ≈ 4.24 units behind

// NPC stands at (100,100) facing +x (angle 0).
const NX = 100, NY = 100, FACING = 0;

function scan(targets: Array<{ x: number; y: number }>): string | null {
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: NX, y: NY, z: 0 });
  for (const t of targets) {
    const id = newEntityId();
    w.create(id);
    w.write(id, Position, { x: t.x, y: t.y, z: 0 });
    w.write(id, Health, { current: 100, max: 100 });
  }
  const grid = new SpatialGrid();
  grid.rebuild(w);
  const hit = findNearestThreatInArc(grid, w, npc, NX, NY, FACING, AGGRO_SQ, CONE, REAR_SQ);
  return hit?.entityId ?? null;
}

Deno.test("directional: a target in the forward cone is detected at full range", () => {
  assert(scan([{ x: NX + 12, y: NY }]) !== null, "12u dead ahead → detected");
});

Deno.test("directional: a target far behind is NOT detected", () => {
  assertEquals(scan([{ x: NX - 12, y: NY }]), null, "12u directly behind → unseen");
});

Deno.test("directional: a target close behind (within rear range) IS detected", () => {
  assert(scan([{ x: NX - 3, y: NY }]) !== null, "3u behind → within short rear sight");
});

Deno.test("directional: a flanking target outside the cone and beyond rear range is unseen", () => {
  // 10u to the side: angle π/2 (90°) > cone 70°, distance 10 > rear ~4.24.
  assertEquals(scan([{ x: NX, y: NY + 10 }]), null);
});

Deno.test("directional: nearest eligible wins across front + rear", () => {
  // front at 12u (dSq 144), close rear at 3u (dSq 9) — both eligible, rear nearer.
  const front = NX + 12, rear = NX - 3;
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: NX, y: NY, z: 0 });
  const frontId = newEntityId(); w.create(frontId);
  w.write(frontId, Position, { x: front, y: NY, z: 0 }); w.write(frontId, Health, { current: 100, max: 100 });
  const rearId = newEntityId(); w.create(rearId);
  w.write(rearId, Position, { x: rear, y: NY, z: 0 }); w.write(rearId, Health, { current: 100, max: 100 });
  const grid = new SpatialGrid(); grid.rebuild(w);
  const hit = findNearestThreatInArc(grid, w, npc, NX, NY, FACING, AGGRO_SQ, CONE, REAR_SQ);
  assertEquals(hit?.entityId, rearId, "the closer (rear, in-range) target is chosen");
});
