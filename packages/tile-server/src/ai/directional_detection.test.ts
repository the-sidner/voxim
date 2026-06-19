/**
 * Unified NPC threat detection (T-016 sight + T-014/T-015 hearing). A target is
 * detected within aggro range when ANY sense fires: sight (forward cone),
 * hearing (noise × proximity ≥ threshold), or proximity (very close, any way).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { Position, Health } from "../components/game.ts";
import { NoiseLevel } from "../components/noise.ts";
import { SpatialGrid } from "../spatial_grid.ts";
import { findDetectedThreat } from "./plan_helpers.ts";

const AGGRO_SQ = 225;          // 15 units
const CONE = 1.2217;           // ±70°
const REAR_SQ = AGGRO_SQ * 0.08; // ≈ 4.24 units
const HEAR = 0.15;             // auditory threshold

const NX = 100, NY = 100, FACING = 0; // NPC at (100,100) facing +x

/** Scan with a single target at (x,y) emitting `noise` (default silent). */
function scan(x: number, y: number, noise = 0): string | null {
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: NX, y: NY, z: 0 });
  const t = newEntityId();
  w.create(t);
  w.write(t, Position, { x, y, z: 0 });
  w.write(t, Health, { current: 100, max: 100 });
  if (noise > 0) w.write(t, NoiseLevel, { level: noise });
  const grid = new SpatialGrid();
  grid.rebuild(w);
  return findDetectedThreat(grid, w, npc, NX, NY, FACING, AGGRO_SQ, CONE, REAR_SQ, HEAR)?.entityId ?? null;
}

// ── sight (T-016) — silent targets, so only sight + proximity apply ──
Deno.test("sight: a silent target in the forward cone is seen at full range", () => {
  assert(scan(NX + 12, NY) !== null);
});
Deno.test("sight: a silent target far behind is unseen", () => {
  assertEquals(scan(NX - 12, NY), null);
});
Deno.test("proximity: a silent target close behind is felt", () => {
  assert(scan(NX - 3, NY) !== null);
});
Deno.test("sight: a silent flanker beyond cone + rear range is unseen", () => {
  assertEquals(scan(NX, NY + 10), null);
});

// ── hearing (T-014/T-015) — noise extends detection omnidirectionally ──
Deno.test("hearing: a sprinter (noise 1) behind at mid range is heard", () => {
  // 9u behind: silent → unseen, but noise 1 × (1−9/15)=0.4 ≥ 0.15 → heard.
  assertEquals(scan(NX - 9, NY), null, "silent at 9u behind is missed");
  assert(scan(NX - 9, NY, 1) !== null, "but a sprinter there is heard");
});
Deno.test("hearing: a croucher (noise 0.3) at range is NOT heard", () => {
  // 11u behind: 0.3 × (1−11/15)=0.08 < 0.15 → below threshold.
  assertEquals(scan(NX - 11, NY, 0.3), null);
});
Deno.test("hearing: a croucher close behind is still heard", () => {
  // 5u behind (outside rear 4.24): 0.3 × (1−5/15)=0.2 ≥ 0.15 → heard.
  assert(scan(NX - 5, NY, 0.3) !== null);
});
Deno.test("hearing: nothing is detected beyond aggro range however loud", () => {
  assertEquals(scan(NX + 20, NY, 1), null);
});
