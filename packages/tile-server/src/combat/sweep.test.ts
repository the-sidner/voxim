/**
 * T-333 — hit-bubbling in the shared sweep dispatch tail.
 *
 * `dispatchSweepHit` is the one place every hit (melee weapon_trace,
 * ranged projectile_trace) crosses from "geometry intersection" into
 * "handler dispatch". These tests exercise its handler-retargeting logic
 * directly, with small stand-in HitHandlers that just record the
 * `ctx.targetId` they were called with — the geometry (a single hitbox
 * part, a single point-segment placed exactly on it) is fixed across every
 * test so only the scene-graph shape (parentless vs child+ancestor)
 * varies.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus, type ComponentDef, type EntityId } from "@voxim/engine";
import type { HitContext, HitHandler } from "../hit_handler.ts";
import type { EventEmitter } from "../system.ts";
import { Position, Health } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitboxData } from "../components/hitbox.ts";
import { dispatchSweepHit } from "./sweep.ts";

/** A single-part hitbox spanning local z=0..1 at the origin (facing 0). */
const HITBOX: HitboxData = {
  derive: false,
  parts: [{ id: "torso", fromFwd: 0, fromRight: 0, fromUp: 0, toFwd: 0, toRight: 0, toUp: 1, radius: 0.5 }],
};

/** Degenerate point-segment sitting inside the part's capsule — always hits. */
const SEGMENTS = [{ from: { x: 0, y: 0, z: 0.5 }, to: { x: 0, y: 0, z: 0.5 } }];

function spawn(w: World): EntityId {
  const id = newEntityId();
  w.create(id);
  return id;
}

function buildContext(struckId: EntityId) {
  return (hit: { partId: string }): HitContext => ({
    attackerId: "attacker",
    targetId: struckId,
    weaponStats: { damage: 10, weight: 1 },
    bodyPart: hit.partId,
    attackerPart: "mid",
    targetSnapshotFacing: 0,
    attackerX: 0, attackerY: 0,
    targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0.5,
    parryAllowed: true,
  });
}

/** Records every ctx it's called with; never mutates world state. */
class RecordingHandler implements HitHandler {
  readonly calls: HitContext[] = [];
  constructor(readonly requiredComponent?: ComponentDef<unknown>) {}
  onHit(_world: World, _events: EventEmitter, ctx: HitContext): void {
    this.calls.push(ctx);
  }
}

Deno.test("dispatchSweepHit: parentless struck entity resolves to itself (behaviour-preserving)", () => {
  const w = new World();
  const events = new EventBus();
  const target = spawn(w);
  w.write(target, Position, { x: 0, y: 0, z: 0 });
  w.write(target, Health, { current: 100, max: 100 });
  w.write(target, Hitbox, HITBOX);

  const handler = new RecordingHandler(Health);
  const hit = dispatchSweepHit(
    w, events, [handler], HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, buildContext(target),
  );

  assert(hit !== null, "expected the fixed geometry to intersect");
  assertEquals(handler.calls.length, 1);
  assertEquals(handler.calls[0].targetId, target);
  assertEquals(handler.calls[0].bodyPart, "torso");
});

Deno.test("dispatchSweepHit: a struck child bubbles to the ancestor carrying the required component", () => {
  const w = new World();
  const events = new EventBus();
  const creature = spawn(w); // ancestor — carries Health, no Hitbox of its own
  w.write(creature, Health, { current: 100, max: 100 });
  const bone = spawn(w); // struck child — carries the Hitbox that intersects
  w.write(bone, Position, { x: 0, y: 0, z: 0 });
  w.write(bone, Hitbox, HITBOX);
  w.setParent(bone, creature);

  const requiring = new RecordingHandler(Health);
  const passthrough = new RecordingHandler(); // no requiredComponent — dispatches to the struck entity
  const hit = dispatchSweepHit(
    w, events, [requiring, passthrough], HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, buildContext(bone),
  );

  assert(hit !== null);
  // The handler that needs Health is retargeted to the ancestor…
  assertEquals(requiring.calls[0].targetId, creature);
  // …but a handler with no declared requirement still gets the struck entity.
  assertEquals(passthrough.calls[0].targetId, bone);
  // Struck-part identity survives the bubble regardless of which entity ends
  // up as targetId — both handlers see the same bodyPart.
  assertEquals(requiring.calls[0].bodyPart, "torso");
  assertEquals(passthrough.calls[0].bodyPart, "torso");
});

Deno.test("dispatchSweepHit: no ancestor carries the component — falls back to the struck entity", () => {
  const w = new World();
  const events = new EventBus();
  const root = spawn(w); // ancestor exists, but doesn't carry Health either
  const bone = spawn(w);
  w.write(bone, Position, { x: 0, y: 0, z: 0 });
  w.write(bone, Hitbox, HITBOX);
  w.setParent(bone, root);

  const handler = new RecordingHandler(Health);
  const hit = dispatchSweepHit(
    w, events, [handler], HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, buildContext(bone),
  );

  assert(hit !== null);
  // Falls back to the struck entity — identical to a handler's own
  // world.get(ctx.targetId, Health) failing and bailing, same as today.
  assertEquals(handler.calls[0].targetId, bone);
});

Deno.test("dispatchSweepHit: walks past an intermediate ancestor that lacks the component", () => {
  const w = new World();
  const events = new EventBus();
  const creature = spawn(w); // grandparent — carries Health
  w.write(creature, Health, { current: 100, max: 100 });
  const attachment = spawn(w); // parent — carries neither
  w.setParent(attachment, creature);
  const bone = spawn(w); // struck child
  w.write(bone, Position, { x: 0, y: 0, z: 0 });
  w.write(bone, Hitbox, HITBOX);
  w.setParent(bone, attachment);

  const handler = new RecordingHandler(Health);
  const hit = dispatchSweepHit(
    w, events, [handler], HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, buildContext(bone),
  );

  assert(hit !== null);
  assertEquals(handler.calls[0].targetId, creature);
});
