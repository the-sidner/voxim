/**
 * AoI removal channel + EntityDied relevance (T-250).
 *
 *   - A component removed from an entity that REMAINS in AoI is emitted as a
 *     per-component removal (the settled-item-sheds-Velocity / picked-up-item-
 *     sheds-Position case). Without it the component latches on the client.
 *   - An entity destroyed this tick is a whole-entity `destroy`; its
 *     per-component removals are suppressed (redundant).
 *   - `EntityDied` is filtered against the set the session knew BEFORE the
 *     prune, so a death the same tick the entity despawns still reaches the
 *     client (not just a bare despawn).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import type { GameEvent } from "@voxim/protocol";
import { Position, Velocity } from "./components/game.ts";
import { ClientSession } from "./session.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { computeSessionUpdate } from "./aoi.ts";

function setup() {
  const world = new World();
  const playerId = newEntityId();
  world.create(playerId);
  world.write(playerId, Position, { x: 256, y: 256, z: 4 });

  const targetId = newEntityId();
  world.create(targetId);
  world.write(targetId, Position, { x: 257, y: 256, z: 4 }); // 1 unit away → in AoI
  world.write(targetId, Velocity, { x: 1, y: 0, z: 0 });

  const spatial = new SpatialGrid();
  spatial.rebuild(world);

  const session = new ClientSession(playerId);
  // Both entities are already known to the session (spawned a prior tick).
  session.knownEntities.add(playerId);
  session.knownEntities.add(targetId);

  return { world, spatial, session, playerId, targetId };
}

function run(
  s: ReturnType<typeof setup>,
  removedComponents: Map<string, number[]>,
  worldDestroys: Set<string>,
  events: GameEvent[],
) {
  return computeSessionUpdate(
    s.world, s.session, s.spatial, s.playerId,
    new Map(), removedComponents, worldDestroys, events,
    /*serverTick*/ 10, /*ackInputSeq*/ 0, /*aoiRadius*/ 128, /*onlineCount*/ 1,
  );
}

Deno.test("T-250: a component removed from a surviving entity is emitted as a removal", () => {
  const s = setup();
  const msg = run(s, new Map([[s.targetId, [ComponentType.velocity]]]), new Set(), []);

  assertEquals(msg.removals.length, 1);
  assertEquals(msg.removals[0], { entityId: s.targetId, componentType: ComponentType.velocity });
  assertEquals(msg.destroys.length, 0, "the entity itself survives — no destroy");
});

Deno.test("T-250: removals are suppressed for an entity destroyed this tick (destroy wins)", () => {
  const s = setup();
  const msg = run(
    s,
    new Map([[s.targetId, [ComponentType.velocity]]]),
    new Set([s.targetId]),
    [],
  );

  assert(msg.destroys.includes(s.targetId), "destroyed entity reaches the client as a destroy");
  assertEquals(msg.removals.length, 0, "no redundant per-component removals for it");
});

Deno.test("T-250: EntityDied reaches a session that knew the entity even as it despawns", () => {
  const s = setup();
  const died: GameEvent = { type: "EntityDied", entityId: s.targetId, killerId: s.playerId };
  const msg = run(s, new Map(), new Set([s.targetId]), [died]);

  assert(
    msg.events.some((e) => e.type === "EntityDied" && e.entityId === s.targetId),
    "death event filtered against the pre-prune known set, not the post-prune one",
  );
  assert(msg.destroys.includes(s.targetId));
});
