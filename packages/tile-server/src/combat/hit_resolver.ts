/**
 * Shared capsule-vs-hitbox intersection test.
 *
 * Both melee (ActionSystem) and ranged (ProjectileSystem) resolve hits by
 * testing one or more blade/trajectory segments against each body part in a
 * target's hitbox. Prior to this helper each system carried its own copy of
 * the inner loop — same localToWorld transforms, same segSegDistSq test, same
 * short-circuit on first hit. Factored here so a fix in one path is a fix in
 * both, and a new weapon archetype (thrown, hitscan, channelled AoE) doesn't
 * spawn a third copy.
 */
import { localToWorld, segSegDistSq, segSegContactPoint } from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import type { HitboxData } from "@voxim/codecs";

export interface BladeSegment {
  from: Vec3;
  to: Vec3;
}

export interface HitboxIntersection {
  partId: string;
  /** World-space contact point between the striking segment and the hit part. */
  contact: Vec3;
}

/**
 * Test one or more blade segments against a target's hitbox parts.
 *
 * A hit is recorded when any segment's closest approach to a part's capsule
 * core is within bladeRadius + part.radius. Returns the first matching part
 * (hitbox.parts order is significant — designers list head before body for
 * head-priority hits). Returns null if nothing intersects.
 *
 * Multiple segments let callers submit a swept capsule — melee systems pass
 * prev-tick and curr-tick segments so a fast swing can't tunnel through a
 * narrow target between ticks. Projectiles pass just their trajectory slice.
 */
export function testHitboxIntersection(
  hitbox: HitboxData,
  targetPos: Vec3,
  targetFacing: number,
  bladeRadius: number,
  segments: ReadonlyArray<BladeSegment>,
): HitboxIntersection | null {
  for (const part of hitbox.parts) {
    const partFrom = localToWorld(part.fromFwd, part.fromRight, part.fromUp, targetPos, targetFacing);
    const partTo   = localToWorld(part.toFwd,   part.toRight,   part.toUp,   targetPos, targetFacing);
    const combinedRadiusSq = (bladeRadius + part.radius) ** 2;

    for (const seg of segments) {
      const distSq = segSegDistSq(seg.from, seg.to, partFrom, partTo);
      if (distSq <= combinedRadiusSq) {
        return {
          partId: part.id,
          contact: segSegContactPoint(seg.from, seg.to, partFrom, partTo),
        };
      }
    }
  }
  return null;
}
