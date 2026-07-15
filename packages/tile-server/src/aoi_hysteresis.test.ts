/**
 * AoI boundary hysteresis (T-361) — entities enter at aoiRadius but a known
 * positioned entity only leaves at aoiRadius + margin. Pins:
 *   - the margin band retains a KNOWN entity (no destroy/re-spawn flap at the
 *     boundary, full bone subtree included),
 *   - the band does NOT admit an UNKNOWN entity (entry stays at aoiRadius),
 *   - past the exit radius the ordinary destroy diff still fires.
 *
 * Distances are chosen clear of the spatial grid's 16-unit cell quantization:
 * nearby(256, 256, 128) reaches cells up to x=400, so the "outside entry,
 * inside exit" probe sits at +150 (cell 25) with the exit edge at 128+32=160.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import type { GameEvent } from "@voxim/protocol";
import { Position } from "./components/game.ts";
import { Bone } from "./components/bone.ts";
import { ClientSession } from "./session.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { computeAoiSharedInputs, computeSessionUpdate } from "./aoi.ts";

const AOI_RADIUS = 128;

function setup() {
  const world = new World();
  const playerId = newEntityId();
  world.create(playerId);
  world.write(playerId, Position, { x: 256, y: 256, z: 4 });

  const spatial = new SpatialGrid();
  const session = new ClientSession(playerId);
  session.knownEntities.add(playerId);

  return { world, spatial, session, playerId };
}

function run(s: ReturnType<typeof setup>, worldDestroys = new Set<string>()) {
  s.spatial.rebuild(s.world);
  const events: GameEvent[] = [];
  return computeSessionUpdate(
    s.world, computeAoiSharedInputs(s.world), s.session, s.spatial, s.playerId,
    new Map(), new Map(), worldDestroys, events,
    /*serverTick*/ 10, /*ackInputSeq*/ 0, AOI_RADIUS, /*onlineCount*/ 1,
  );
}

function spawnCreatureWithBone(s: ReturnType<typeof setup>, x: number) {
  const creature = newEntityId();
  s.world.create(creature);
  s.world.write(creature, Position, { x, y: 256, z: 4 });
  const bone = newEntityId();
  s.world.create(bone);
  s.world.write(bone, Bone, { boneId: "hand_r" });
  s.world.setParent(bone, creature);
  return { creature, bone };
}

Deno.test("hysteresis: a known entity in the exit-margin band stays known — no destroy/re-spawn flap", () => {
  const s = setup();
  const { creature, bone } = spawnCreatureWithBone(s, 260); // well inside

  run(s);
  assert(s.session.knownEntities.has(creature));
  assert(s.session.knownEntities.has(bone));

  // Step just past the entry radius, inside the exit radius (150 < 128+32).
  s.world.write(creature, Position, { x: 256 + 150, y: 256, z: 4 });
  const out = run(s);
  assertEquals(out.destroys.length, 0, "margin band must not despawn a known entity");
  assert(s.session.knownEntities.has(creature), "creature retained");
  assert(s.session.knownEntities.has(bone), "bone subtree retained with its root");

  // Step back inside: no re-spawn either — it never left.
  s.world.write(creature, Position, { x: 256 + 100, y: 256, z: 4 });
  const back = run(s);
  assertEquals(back.spawns.length, 0, "re-entry produces no duplicate spawn");
  assertEquals(back.destroys.length, 0);
});

Deno.test("hysteresis: entry stays at aoiRadius — an UNKNOWN entity in the margin band does not spawn", () => {
  const s = setup();
  const stranger = newEntityId();
  s.world.create(stranger);
  s.world.write(stranger, Position, { x: 256 + 150, y: 256, z: 4 }); // in band, never known

  const out = run(s);
  assertEquals(out.spawns.map((sp) => sp.entityId).includes(stranger), false);
  assertEquals(s.session.knownEntities.has(stranger), false);
});

Deno.test("hysteresis: past the exit radius the entity (and its bones) despawns normally", () => {
  const s = setup();
  const { creature, bone } = spawnCreatureWithBone(s, 260);
  run(s);

  s.world.write(creature, Position, { x: 256 + 170, y: 256, z: 4 }); // > 160 exit edge
  const out = run(s);
  assert(out.destroys.includes(creature), "creature despawns past exit radius");
  assert(out.destroys.includes(bone), "bone despawns with its root");
  assertEquals(s.session.knownEntities.has(creature), false);
});

Deno.test("hysteresis: a world-destroyed entity in the band is still destroyed", () => {
  const s = setup();
  const { creature, bone } = spawnCreatureWithBone(s, 256 + 100);
  run(s);

  // Simulate the post-applyChangeset state: entity purged, id in destroys.
  s.world.destroy(creature);
  s.world.destroy(bone);
  s.world.applyChangeset();
  const out = run(s, new Set([creature, bone]));
  assert(out.destroys.includes(creature), "worldDestroys wins over hysteresis");
  assert(out.destroys.includes(bone));
});
