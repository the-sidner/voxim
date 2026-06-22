/**
 * Heir spawn resolution + weakened state (T-079).
 *
 * Locks the destroyed-hearth fallback: a heir whose family hearth was destroyed
 * spawns displaced (default spawn) AND weakened (injured + below max health,
 * with a live moveSpeed debuff through the modifier fold). The happy path
 * (standing hearth → spawn at the hearth) and the no-anchor path (fresh dynasty
 * → ordinary spawn) are pinned too. Server-only: no QUIC/session stack needed.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { spawnPrefab } from "./spawner.ts";
import { resolveHeirSpawn } from "./heir_spawn.ts";
import { Health, Position } from "./components/game.ts";
import { Injury } from "./components/injury.ts";
import { WorkstationTag } from "./components/building.ts";
import { Hearth } from "./components/hearth.ts";
import { effective, newModifierSourceRegistry } from "./modifiers/modifier.ts";
import { injurySource } from "./modifiers/sources/injury.ts";
import type { HearthAnchor } from "./account_client.ts";

const content = await JsonSource.load();
const TILE = "0_0";
const anchor = (x: number, y: number, z = 0): HearthAnchor => ({ tileId: TILE, position: { x, y, z } });

function injuryRegistry() {
  const reg = newModifierSourceRegistry();
  reg.register(injurySource);
  return reg;
}

Deno.test("T-079: standing hearth → spawn at the hearth, full strength", () => {
  const world = new World();
  // A live Hearth entity at the anchor == hearth still stands.
  const hearth = world.create();
  world.write(hearth, Position, { x: 100, y: 120, z: 0 });
  world.write(hearth, Hearth, { claimRadius: 20 });

  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  assertEquals(r.atHearth, true);
  assertEquals(r.weakened, false);
  assertEquals(r.x, 100);
  assertEquals(r.y, 120);
});

Deno.test("T-079: destroyed hearth (anchor here, no hearth entity) → displaced + weakened", () => {
  const world = new World(); // no Hearth entity near the anchor
  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  const spawn = content.getGameConfig().player;
  assertEquals(r.atHearth, false);
  assertEquals(r.weakened, true);
  assertEquals(r.x, spawn.defaultSpawnX);
  assertEquals(r.y, spawn.defaultSpawnY);
});

Deno.test("T-079: a NON-hearth workstation at the anchor does NOT count as a standing hearth", () => {
  // Regression (review HIGH): an adjacent surviving workbench must not mask the
  // destroyed hearth — the heir must still be displaced + weakened.
  const world = new World();
  const bench = world.create();
  world.write(bench, Position, { x: 100, y: 121, z: 0 }); // 1 unit from the anchor, inside radius
  world.write(bench, WorkstationTag, { stationType: "workbench", qualityTier: 1 });
  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  assertEquals(r.atHearth, false, "a workbench is not a hearth");
  assertEquals(r.weakened, true);
});

Deno.test("T-079: a hearth outside the detect radius still counts as destroyed", () => {
  const world = new World();
  const far = world.create();
  world.write(far, Position, { x: 200, y: 200, z: 0 });
  world.write(far, Hearth, { claimRadius: 20 });
  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  assertEquals(r.atHearth, false);
  assertEquals(r.weakened, true);
});

Deno.test("T-079: no anchor on this tile → default spawn, not weakened", () => {
  const world = new World();
  const spawn = content.getGameConfig().player;
  for (const a of [null, { tileId: "9_9", position: { x: 1, y: 2, z: 0 } } as HearthAnchor]) {
    const r = resolveHeirSpawn(world, content, a, TILE);
    assertEquals(r.atHearth, false);
    assertEquals(r.weakened, false);
    assertEquals(r.x, spawn.defaultSpawnX);
    assertEquals(r.y, spawn.defaultSpawnY);
  }
});

Deno.test("T-079: weakened spawn → displaced injury, reduced HP, live moveSpeed debuff", () => {
  const world = new World();
  const id = spawnPrefab(world, content, "player", { x: 0, y: 0, z: 0, weakened: true });

  const hp = world.get(id, Health)!;
  assert(hp.current < hp.max, `weakened heir starts below max health (${hp.current}/${hp.max})`);

  const inj = world.get(id, Injury);
  assert(inj && inj.injuries.some((i) => i.typeId === "displaced"), "carries the displaced injury");

  const base = 5;
  const eff = effective(injuryRegistry(), { world, content, entityId: id }, "moveSpeed", base);
  assert(eff < base, `weakened moveSpeed ${eff} < base ${base}`);
});

Deno.test("T-079: the `displaced` heir debuff is NOT in the random combat injury pool", () => {
  // Regression (review MEDIUM): a spawn-only state must never roll from a hit.
  const injuries = content.getGameConfig().injuries;
  assertEquals(injuries.displaced.combatEligible, false);
  const combatRollable = Object.keys(injuries).filter((id) => injuries[id].combatEligible !== false);
  assert(!combatRollable.includes("displaced"), "displaced excluded from combat roll");
  assert(combatRollable.includes("broken_leg"), "ordinary combat injuries still roll");
});

Deno.test("T-079: normal spawn → full HP, no injury, no moveSpeed debuff", () => {
  const world = new World();
  const id = spawnPrefab(world, content, "player", { x: 0, y: 0, z: 0 });

  const hp = world.get(id, Health)!;
  assertEquals(hp.current, hp.max);
  assertEquals(world.get(id, Injury)?.injuries.length ?? 0, 0);

  const base = 5;
  assertEquals(effective(injuryRegistry(), { world, content, entityId: id }, "moveSpeed", base), base);
});
