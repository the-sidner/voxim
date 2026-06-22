/**
 * NpcSensorySystem (T-040) — event-driven combat awareness.
 *
 * Locks the buffered runtime against REAL game_config: an NPC within
 * perceptionRadius of a DamageDealt / EntityDied / LoudNoise event acquires an
 * attackTarget job toward the *threat* (the attacker / killer / noise source);
 * one outside the radius does not; an NPC already attacking is left alone; and
 * the threat filter matches findDetectedThreat (live, has Health, non-NPC).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { SpatialGrid } from "../spatial_grid.ts";
import { Position, Health } from "../components/game.ts";
import { NpcTag, NpcJobQueue } from "../components/npcs.ts";
import { NpcSensorySystem } from "./npc_sensory.ts";

const content = await JsonSource.load();
const DT = 1 / 20;
const RADIUS = content.getGameConfig().npcAiDefaults.perceptionRadius;

function harness() {
  const world = new World();
  const bus = new EventBus();
  const spatial = new SpatialGrid();
  const sys = new NpcSensorySystem(content);
  sys.registerSubscribers(bus);

  let serverTick = 0;
  // One priming run so the EntityDied collector has a committed world to read
  // the killer's position from (the real server runs every tick before flush).
  const tick = () => {
    serverTick++;
    spatial.rebuild(world);
    sys.prepare(serverTick, { spatial, pendingCommands: new Map() });
    sys.run(world, bus, DT);
    world.applyChangeset();
  };
  tick();

  const spawnNpc = (x: number, y: number): EntityId => {
    const id = newEntityId();
    world.create(id);
    world.write(id, Position, { x, y, z: 0 });
    world.write(id, NpcTag, { npcType: "wolf", name: "Wolf" });
    world.write(id, NpcJobQueue, { current: null, scheduled: [], plan: null });
    return id;
  };
  const spawnPlayer = (x: number, y: number): EntityId => {
    const id = newEntityId();
    world.create(id);
    world.write(id, Position, { x, y, z: 0 });
    world.write(id, Health, { current: 100, max: 100 });
    return id;
  };
  const jobOf = (id: EntityId) => world.get(id, NpcJobQueue)?.current ?? null;

  return { world, bus, spatial, sys, tick, spawnNpc, spawnPlayer, jobOf };
}

Deno.test("an NPC near a DamageDealt event aggros toward the attacker", () => {
  const h = harness();
  const victim = h.spawnPlayer(0, 0); // someone gets wounded at the origin
  const attacker = h.spawnPlayer(2, 0); // a player — a valid threat
  const npc = h.spawnNpc(5, 0); // well within perceptionRadius of the hit
  h.world.applyChangeset();

  // hit lands at the victim's position; sourceId is the attacker.
  h.bus.publish(TileEvents.DamageDealt, {
    targetId: victim, sourceId: attacker, amount: 10, blocked: false,
    bodyPart: "torso", hitX: 0, hitY: 0, hitZ: 0,
  });
  h.tick();

  const job = h.jobOf(npc);
  assert(job && job.type === "attackTarget", "NPC investigates the commotion");
  assertEquals(job.targetId, attacker, "aggros the attacker, not the victim");
});

Deno.test("an NPC outside perceptionRadius does not react", () => {
  const h = harness();
  const victim = h.spawnPlayer(0, 0);
  const attacker = h.spawnPlayer(2, 0);
  const far = h.spawnNpc(RADIUS + 10, 0); // beyond perception
  h.world.applyChangeset();

  h.bus.publish(TileEvents.DamageDealt, {
    targetId: victim, sourceId: attacker, amount: 10, blocked: false,
    bodyPart: "torso", hitX: 0, hitY: 0, hitZ: 0,
  });
  h.tick();

  assertEquals(h.jobOf(far), null, "deaf to a fight beyond its perception radius");
});

Deno.test("an NPC already attacking keeps its current target", () => {
  const h = harness();
  const victim = h.spawnPlayer(0, 0);
  const attacker = h.spawnPlayer(2, 0);
  const npc = h.spawnNpc(5, 0);
  h.world.write(npc, NpcJobQueue, {
    current: { type: "attackTarget", targetId: "existing-prey", expiresAt: 999 },
    scheduled: [], plan: null,
  });
  h.world.applyChangeset();

  h.bus.publish(TileEvents.DamageDealt, {
    targetId: victim, sourceId: attacker, amount: 10, blocked: false,
    bodyPart: "torso", hitX: 0, hitY: 0, hitZ: 0,
  });
  h.tick();

  const job = h.jobOf(npc);
  assert(job && job.type === "attackTarget");
  assertEquals(job.targetId, "existing-prey", "an engaged NPC is not redirected");
});

Deno.test("the threat filter: no aggro toward a fellow NPC attacker", () => {
  const h = harness();
  const victim = h.spawnPlayer(0, 0);
  const wolfAttacker = h.spawnNpc(2, 0); // an NPC mauls the player
  const bystander = h.spawnNpc(5, 0);
  h.world.applyChangeset();

  h.bus.publish(TileEvents.DamageDealt, {
    targetId: victim, sourceId: wolfAttacker, amount: 10, blocked: false,
    bodyPart: "torso", hitX: 0, hitY: 0, hitZ: 0,
  });
  h.tick();

  assertEquals(h.jobOf(bystander), null, "the pack does not turn on its own");
});

Deno.test("EntityDied: nearby NPC aggros toward the killer at the killer's position", () => {
  const h = harness();
  const killer = h.spawnPlayer(0, 0);
  const npc = h.spawnNpc(4, 0); // near the killer
  h.world.applyChangeset();

  // The victim is irrelevant (already purged by drain time); aggro the killer.
  h.bus.publish(TileEvents.EntityDied, { entityId: "the-fallen", killerId: killer });
  h.tick();

  const job = h.jobOf(npc);
  assert(job && job.type === "attackTarget", "NPC reacts to a kill nearby");
  assertEquals(job.targetId, killer);
});

Deno.test("EntityDied with no killer (environmental death) is ignored", () => {
  const h = harness();
  const npc = h.spawnNpc(2, 0);
  h.world.applyChangeset();

  h.bus.publish(TileEvents.EntityDied, { entityId: "starved-villager" });
  h.tick();

  assertEquals(h.jobOf(npc), null, "no killer → nothing to aggro toward");
});

Deno.test("LoudNoise: nearby NPC investigates the source", () => {
  const h = harness();
  const sprinter = h.spawnPlayer(0, 0);
  const npc = h.spawnNpc(6, 0);
  h.world.applyChangeset();

  h.bus.publish(TileEvents.LoudNoise, { x: 0, y: 0, sourceId: sprinter, intensity: 1 });
  h.tick();

  const job = h.jobOf(npc);
  assert(job && job.type === "attackTarget", "NPC hears the sprint and investigates");
  assertEquals(job.targetId, sprinter);
});

Deno.test("a dead/despawned threat produces no aggro", () => {
  const h = harness();
  const victim = h.spawnPlayer(0, 0);
  const npc = h.spawnNpc(3, 0);
  h.world.applyChangeset();

  // sourceId references an entity that was never created (despawned attacker).
  h.bus.publish(TileEvents.DamageDealt, {
    targetId: victim, sourceId: "ghost-attacker", amount: 10, blocked: false,
    bodyPart: "torso", hitX: 0, hitY: 0, hitZ: 0,
  });
  h.tick();

  assertEquals(h.jobOf(npc), null, "an unattackable threat is ignored");
});
