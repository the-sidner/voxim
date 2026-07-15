/**
 * T-219/T-220 — AoI replicates the scene-graph subtree of every visible
 * entity. Bone entities (and anything scene-graph-parented onto one, e.g.
 * equipped items) carry no Position, so without the subtree-expansion pass
 * in computeSessionUpdate they would never enter AoI at all — the existing
 * rules only special-case the VIEWING player's own carried items.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import type { GameEvent } from "@voxim/protocol";
import { Position } from "./components/game.ts";
import { Bone } from "./components/bone.ts";
import { ClientSession } from "./session.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { computeAoiSharedInputs, computeSessionUpdate } from "./aoi.ts";

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

function run(s: ReturnType<typeof setup>) {
  s.spatial.rebuild(s.world);
  const events: GameEvent[] = [];
  return computeSessionUpdate(
    s.world, computeAoiSharedInputs(s.world), s.session, s.spatial, s.playerId,
    new Map(), new Map(), new Set(), events,
    /*serverTick*/ 10, /*ackInputSeq*/ 0, /*aoiRadius*/ 128, /*onlineCount*/ 1,
  );
}

Deno.test("T-219: a bone entity (no Position) enters AoI as a descendant of its positioned, in-radius root", () => {
  const s = setup();
  const creature = newEntityId();
  s.world.create(creature);
  s.world.write(creature, Position, { x: 260, y: 256, z: 4 }); // 4 units away, in radius

  const boneEntity = newEntityId();
  s.world.create(boneEntity);
  s.world.write(boneEntity, Bone, { boneId: "hand_r" });
  s.world.setParent(boneEntity, creature);

  const msg = run(s);
  const spawnedIds = msg.spawns.map((sp) => sp.entityId);
  assert(spawnedIds.includes(creature), "creature root spawns");
  assert(spawnedIds.includes(boneEntity), "bone entity spawns as a scene-graph descendant");

  // Parent-before-child ordering within the same message.
  const creatureIdx = spawnedIds.indexOf(creature);
  const boneIdx = spawnedIds.indexOf(boneEntity);
  assert(creatureIdx < boneIdx, "creature root ships before its bone entity in the same spawn batch");
});

Deno.test("T-219: a bone entity leaves AoI (destroys) when its root leaves radius", () => {
  const s = setup();
  const creature = newEntityId();
  s.world.create(creature);
  s.world.write(creature, Position, { x: 260, y: 256, z: 4 });

  const boneEntity = newEntityId();
  s.world.create(boneEntity);
  s.world.write(boneEntity, Bone, { boneId: "hand_r" });
  s.world.setParent(boneEntity, creature);

  // First tick: both spawn and become known to the session.
  run(s);
  assert(s.session.knownEntities.has(creature));
  assert(s.session.knownEntities.has(boneEntity));

  // Move the creature far outside the AoI radius.
  s.world.write(creature, Position, { x: 260 + 1000, y: 256, z: 4 });
  const msg = run(s);
  assert(msg.destroys.includes(creature), "creature root destroys");
  assert(msg.destroys.includes(boneEntity), "bone entity destroys with its root");
});

Deno.test("T-220: an item scene-graph-parented onto ANOTHER (non-viewing) entity's bone is still visible to a nearby bystander", () => {
  const s = setup();
  const otherCreature = newEntityId();
  s.world.create(otherCreature);
  s.world.write(otherCreature, Position, { x: 258, y: 256, z: 4 }); // in radius, not the viewer

  const handBone = newEntityId();
  s.world.create(handBone);
  s.world.write(handBone, Bone, { boneId: "hand_r" });
  s.world.setParent(handBone, otherCreature);

  const weaponEntity = newEntityId();
  s.world.create(weaponEntity); // no Position — lives in an equip slot
  s.world.setParent(weaponEntity, handBone);

  const msg = run(s);
  const spawnedIds = msg.spawns.map((sp) => sp.entityId);
  assert(spawnedIds.includes(otherCreature), "the other creature spawns");
  assert(spawnedIds.includes(handBone), "its hand bone spawns");
  assert(
    spawnedIds.includes(weaponEntity),
    "its equipped weapon (parented to the hand bone) spawns too, even though it's not in the viewer's own Equipment",
  );
});

Deno.test("T-219: an entity with no scene-graph children is unaffected (no spurious descendants)", () => {
  const s = setup();
  const lonely = newEntityId();
  s.world.create(lonely);
  s.world.write(lonely, Position, { x: 259, y: 256, z: 4 });

  const msg = run(s);
  assertEquals(msg.spawns.map((sp) => sp.entityId).filter((id) => id === lonely).length, 1);
});
