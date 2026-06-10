/**
 * Shared sweep dispatch (T-244) — the common tail of weapon_trace (melee)
 * and projectile_trace (ranged).
 *
 * Both effects resolve hits the same way once a candidate target is in
 * hand: test a swept volume against the target's hitbox and, on contact,
 * publish a HitSpark and run the shared HitHandler chain. They differ only
 * in what comes *before* (candidate source, exclusions, broad-phase,
 * segment geometry) and in a handful of HitContext fields (attackerPart,
 * weaponStats, parry, coordinates) — all decided by the caller's
 * `buildContext`. That variation stays with each caller; this is the one
 * copy of the dispatch tail they share.
 *
 * The geometry test itself stays in `hit_resolver.ts` (pure); this layer
 * adds the events + handler dispatch on top.
 */

import type { World } from "@voxim/engine";
import type { Vec3 } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import type { HitboxData } from "../components/hitbox.ts";
import { testHitboxIntersection } from "./hit_resolver.ts";
import type { BladeSegment, HitboxIntersection } from "./hit_resolver.ts";

/**
 * Test `segments` (radius `radius`) against one target's `hitbox` at
 * `targetPos`/`targetFacing`. On contact, build the HitContext from the
 * intersection, publish a HitSpark at the context's hit point, and run the
 * handler chain. Returns the intersection (so the caller can record dedup /
 * count hits) or null on a miss. `buildContext` is only invoked on a hit.
 *
 * HitSpark position + attacker/victim parts are read back off the built
 * context, so each caller's choice of hit point (melee: blade contact;
 * ranged: trajectory end) and attacker part flows through unchanged.
 */
export function dispatchSweepHit(
  world: World,
  events: EventEmitter,
  handlers: readonly HitHandler[],
  hitbox: HitboxData,
  targetPos: Vec3,
  targetFacing: number,
  radius: number,
  segments: ReadonlyArray<BladeSegment>,
  buildContext: (hit: HitboxIntersection) => HitContext,
): HitboxIntersection | null {
  const hit = testHitboxIntersection(hitbox, targetPos, targetFacing, radius, segments);
  if (!hit) return null;

  const ctx = buildContext(hit);
  events.publish(TileEvents.HitSpark, {
    x: ctx.hitX, y: ctx.hitY, z: ctx.hitZ,
    attackerPart: ctx.attackerPart, victimPart: ctx.bodyPart,
  });
  for (const h of handlers) h.onHit(world, events, ctx);
  return hit;
}
