/**
 * Soft aim-assist target pick (T-320) — the highest-value unit test of the
 * ticket. Deterministic, no live stack: a bare World with an attacker and
 * several candidates at known angles/distances proves the picker orients to the
 * best in-cone enemy, ignores enemies outside the cone or beyond range, never
 * snaps to a friendly (NpcTag-differs hostility, both directions), and returns
 * null when the cone is empty.
 */
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, newEntityId, type EntityId } from "@voxim/engine";
import { Position, Health } from "../components/game.ts";
import { NpcTag } from "../components/npcs.ts";
import { Hitbox } from "../components/hitbox.ts";
import { pickAimAssistTarget, type AimCandidate } from "./aim_assist.ts";

const CFG = { rangeUnits: 4.0, halfAngleRad: 60 * Math.PI / 180 };

/** Spawn a combat target (Position + Health + Hitbox), optionally an NPC. */
function spawnTarget(w: World, x: number, y: number, npc: boolean): EntityId {
  const id = newEntityId();
  w.create(id);
  w.write(id, Position, { x, y, z: 0 });
  w.write(id, Health, { current: 100, max: 100 });
  w.write(id, Hitbox, {
    derive: false,
    parts: [{ id: "torso", fromFwd: 0, fromRight: 0, fromUp: 0, toFwd: 0, toRight: 0, toUp: 1, radius: 0.5 }],
  });
  if (npc) w.write(id, NpcTag, { npcType: "wolf", name: "Wolf" });
  return id;
}

/** A player attacker at the origin facing +X. */
function spawnPlayer(w: World, x = 0, y = 0): EntityId {
  const id = newEntityId();
  w.create(id);
  w.write(id, Position, { x, y, z: 0 });
  w.write(id, Health, { current: 100, max: 100 });
  return id;
}

function candidatesOf(w: World): AimCandidate[] {
  return w.query(Position).map(({ entityId, position }) => ({ entityId, x: position.x, y: position.y }));
}

Deno.test("aim-assist: picks the best-cost enemy between two in-cone targets", () => {
  const w = new World();
  const me = spawnPlayer(w);
  // Facing +X (0 rad). Two enemies inside a 60° cone:
  //   near, slightly off-axis (2u at +20°) → low distSq, small angle
  //   far, dead-ahead (3.5u at 0°)         → higher distSq
  // Distance-dominant cost picks the near one.
  const near = spawnTarget(w, 2 * Math.cos(20 * Math.PI / 180), 2 * Math.sin(20 * Math.PI / 180), true);
  const far  = spawnTarget(w, 3.5, 0, true);

  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assert(picked !== null, "expected an in-cone target");
  assertEquals(picked!.entityId, near);
  assertAlmostEquals(picked!.facing, 20 * Math.PI / 180, 1e-9);
  // (far exists but lost on cost)
  assert(far !== near);
});

Deno.test("aim-assist: ignores an enemy just outside the cone half-angle", () => {
  const w = new World();
  const me = spawnPlayer(w);
  // Single enemy at 70° off-axis, well inside range → outside the 60° cone.
  spawnTarget(w, 2 * Math.cos(70 * Math.PI / 180), 2 * Math.sin(70 * Math.PI / 180), true);
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: ignores an enemy beyond range even if dead-ahead", () => {
  const w = new World();
  const me = spawnPlayer(w);
  spawnTarget(w, 5.0, 0, true); // dead-ahead but > 4u range
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: returns null when the cone is empty", () => {
  const w = new World();
  const me = spawnPlayer(w);
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: excludes self and picks the enemy behind is not chosen", () => {
  const w = new World();
  const me = spawnPlayer(w);
  // Enemy directly behind (180°) is outside the front cone.
  spawnTarget(w, -2, 0, true);
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: never snaps to a friendly (player ignores fellow players)", () => {
  const w = new World();
  const me = spawnPlayer(w);
  // A fellow player (no NpcTag) dead-ahead in cone+range must NOT be chosen.
  spawnTarget(w, 2, 0, false);
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: symmetric — an NPC attacker snaps to a player, not another NPC", () => {
  const w = new World();
  // NPC attacker at origin facing +X.
  const npcMe = newEntityId();
  w.create(npcMe);
  w.write(npcMe, Position, { x: 0, y: 0, z: 0 });
  w.write(npcMe, Health, { current: 100, max: 100 });
  w.write(npcMe, NpcTag, { npcType: "wolf", name: "Wolf" });

  const fellowNpc = spawnTarget(w, 1.5, 0, true);   // in cone+range, but friendly to NPC
  const player    = spawnTarget(w, 2.5, 0.2, false); // in cone+range, hostile to NPC

  const picked = pickAimAssistTarget(w, npcMe, 0, 0, 0, candidatesOf(w), CFG);
  assert(picked !== null, "expected the player target");
  assertEquals(picked!.entityId, player);
  assert(picked!.entityId !== fellowNpc);
});

Deno.test("aim-assist: a dead enemy still in the candidate list is ignored", () => {
  const w = new World();
  const me = spawnPlayer(w);
  const enemy = spawnTarget(w, 2, 0, true);
  // Snapshot the candidates BEFORE the kill (mirrors the rewound snapshot the
  // resolver passes in), then destroy — the picker must gate on live isAlive.
  const candidates = candidatesOf(w);
  assert(candidates.some((c) => c.entityId === enemy), "enemy should be a candidate");
  w.destroy(enemy);
  w.applyChangeset();
  assert(!w.isAlive(enemy));
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidates, CFG);
  assertEquals(picked, null);
});

Deno.test("aim-assist: a lingering dissolve corpse (alive, Health.current=0) is ignored", () => {
  // T-311 P5c: a death hook can vote { linger: true }, which keeps the corpse
  // world.isAlive (not destroyed) for its dissolve_timer's duration, at
  // Health.current === 0, still carrying Hitbox + NpcTag. The picker must not
  // snap a swing onto it just because isAlive/Health-presence both pass.
  const w = new World();
  const me = spawnPlayer(w);
  const corpse = spawnTarget(w, 2, 0, true);
  w.write(corpse, Health, { current: 0, max: 100 }); // killed, but never destroyed
  assert(w.isAlive(corpse));
  const picked = pickAimAssistTarget(w, me, 0, 0, 0, candidatesOf(w), CFG);
  assertEquals(picked, null);
});
