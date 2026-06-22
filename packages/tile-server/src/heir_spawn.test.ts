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
  // A live workstation entity at the hearth position == hearth still stands.
  const hearth = world.create();
  world.write(hearth, Position, { x: 100, y: 120, z: 0 });
  world.write(hearth, WorkstationTag, { stationType: "hearth", qualityTier: 1 });

  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  assertEquals(r.atHearth, true);
  assertEquals(r.weakened, false);
  assertEquals(r.x, 100);
  assertEquals(r.y, 120);
});

Deno.test("T-079: destroyed hearth (anchor here, no workstation) → displaced + weakened", () => {
  const world = new World(); // no workstation entity near the anchor
  const r = resolveHeirSpawn(world, content, anchor(100, 120), TILE);
  const spawn = content.getGameConfig().player;
  assertEquals(r.atHearth, false);
  assertEquals(r.weakened, true);
  assertEquals(r.x, spawn.defaultSpawnX);
  assertEquals(r.y, spawn.defaultSpawnY);
});

Deno.test("T-079: workstation outside the detect radius still counts as destroyed", () => {
  const world = new World();
  const far = world.create();
  // Place a workstation well beyond hearthDetectRadius of the anchor.
  world.write(far, Position, { x: 200, y: 200, z: 0 });
  world.write(far, WorkstationTag, { stationType: "workbench", qualityTier: 1 });
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

Deno.test("T-079: normal spawn → full HP, no injury, no moveSpeed debuff", () => {
  const world = new World();
  const id = spawnPrefab(world, content, "player", { x: 0, y: 0, z: 0 });

  const hp = world.get(id, Health)!;
  assertEquals(hp.current, hp.max);
  assertEquals(world.get(id, Injury)?.injuries.length ?? 0, 0);

  const base = 5;
  assertEquals(effective(injuryRegistry(), { world, content, entityId: id }, "moveSpeed", base), base);
});
