/**
 * puzzle POI activity + lever_sequence tests (T-212 v2).
 *
 * Real content — `glyph_puzzle` (puzzleId "lever_sequence", params
 * {length:5, showHints:true}, failurePenalty "reset"; reward.extras has
 * one "lore" 100% chance). Covers: activation spawns N levers with a
 * deterministic order + PuzzleState; wrong-order pull resets nextIndex;
 * correct full sequence solves + grants the reward.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Position } from "../../components/game.ts";
import { PoiTrigger } from "../../components/poi.ts";
import { PuzzleState, Lever } from "../../components/puzzle.ts";
import { PoiSystem } from "../../systems/poi.ts";
import { newPoiActivityRegistry } from "../mod.ts";
import type { TickContext } from "../../system.ts";

const activities = newPoiActivityRegistry();
const content = await JsonSource.load();
const DT = 1 / 20;

function placeTrigger(world: World, poiDefId: string, poiInstanceId: string) {
  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });

  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, { poiInstanceId, poiDefId, triggerRadius: 5, fired: false });
  return { pid, tid };
}

function use(sys: PoiSystem, world: World, events: EventBus, playerId: string, entityId: string) {
  const cmd: CommandPayload = { cmd: CommandType.UseEntity, entityId };
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[playerId, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, events, DT);
  world.applyChangeset();
}

function activatePuzzle(): { world: World; events: EventBus; sys: PoiSystem; pid: string; tid: string } {
  const world = new World();
  const events = new EventBus();
  const { pid, tid } = placeTrigger(world, "glyph_puzzle", "glyph_puzzle_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();
  return { world, events, sys, pid, tid };
}

Deno.test("puzzle: activation spawns length levers with a deterministic order + PuzzleState", () => {
  const { world, tid } = activatePuzzle();

  const state = world.get(tid, PuzzleState);
  assert(state, "expected PuzzleState on the trigger entity");
  assertEquals(state!.correctOrder.length, 5); // glyph_puzzle.json params.length
  assertEquals(new Set(state!.correctOrder).size, 5, "order must be a permutation, no repeats");
  assertEquals(state!.nextIndex, 0);
  assertEquals(state!.solved, false);

  const levers = world.query(Lever).filter((l) => l.lever.poiInstanceId === "glyph_puzzle_z1");
  assertEquals(levers.length, 5);
  assertEquals(new Set(levers.map((l) => l.lever.leverIndex)).size, 5);
});

Deno.test("puzzle: same POI instance id always yields the same order (deterministic)", () => {
  const a = activatePuzzle();
  const b = activatePuzzle();
  assertEquals(a.world.get(a.tid, PuzzleState)!.correctOrder, b.world.get(b.tid, PuzzleState)!.correctOrder);
});

Deno.test("puzzle: wrong-order pull resets nextIndex to 0 (failurePenalty: reset)", () => {
  const { world, events, sys, pid, tid } = activatePuzzle();
  const state = world.get(tid, PuzzleState)!;
  const levers = world.query(Lever).filter((l) => l.lever.poiInstanceId === "glyph_puzzle_z1");

  // Pull the CORRECT first lever to advance nextIndex to 1.
  const first = levers.find((l) => l.lever.leverIndex === state.correctOrder[0])!;
  use(sys, world, events, pid, first.entityId);
  assertEquals(world.get(tid, PuzzleState)!.nextIndex, 1);

  // Pull a WRONG lever (anything but correctOrder[1]).
  const wrong = levers.find((l) => l.lever.leverIndex !== state.correctOrder[1])!;
  use(sys, world, events, pid, wrong.entityId);
  assertEquals(world.get(tid, PuzzleState)!.nextIndex, 0, "wrong pull resets progress");
});

Deno.test("puzzle: full correct sequence solves and grants the reward", () => {
  const { world, events, sys, pid, tid } = activatePuzzle();
  const state = world.get(tid, PuzzleState)!;
  const levers = world.query(Lever).filter((l) => l.lever.poiInstanceId === "glyph_puzzle_z1");
  const byIndex = new Map(levers.map((l) => [l.lever.leverIndex, l.entityId]));

  let lore: string[] = [];
  events.subscribe(TileEvents.LoreInternalised, (p: { fragmentId: string }) => { lore.push(p.fragmentId); });

  for (const idx of state.correctOrder) {
    use(sys, world, events, pid, byIndex.get(idx)!);
  }

  const finalState = world.get(tid, PuzzleState)!;
  assertEquals(finalState.solved, true);
  assertEquals(finalState.nextIndex, 5);
  assertEquals(lore, ["lore_glyph_codex_page"]); // glyph_puzzle.json reward.extras[0]
});

Deno.test("puzzle: pulling a lever after solved is a no-op", () => {
  const { world, events, sys, pid, tid } = activatePuzzle();
  const state = world.get(tid, PuzzleState)!;
  const levers = world.query(Lever).filter((l) => l.lever.poiInstanceId === "glyph_puzzle_z1");
  const byIndex = new Map(levers.map((l) => [l.lever.leverIndex, l.entityId]));

  for (const idx of state.correctOrder) use(sys, world, events, pid, byIndex.get(idx)!);
  assertEquals(world.get(tid, PuzzleState)!.solved, true);

  let lore: string[] = [];
  events.subscribe(TileEvents.LoreInternalised, (p: { fragmentId: string }) => { lore.push(p.fragmentId); });
  use(sys, world, events, pid, byIndex.get(state.correctOrder[0])!);
  assertEquals(lore.length, 0, "re-pulling after solved must not re-grant the reward");
});
