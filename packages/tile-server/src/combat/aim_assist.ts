/**
 * Soft aim-assist (T-320) — pure target picker for the combat resolver.
 *
 * On an attack's active tick the weapon_trace resolver calls this to orient the
 * swing toward the best enemy in a frontal cone, replacing "the blade goes
 * exactly where the cursor pointed" (retired with the cursor) with "the blade
 * snaps to the best nearby threat". No hard lock-on, no lock state, no camera
 * framing — it only picks a facing angle for the active phase.
 *
 * Hostility (no team/faction model yet): a valid target has Health, is alive,
 * is not the attacker, carries a Hitbox — itself or, since T-333, on any
 * scene-graph descendant (the "is a combat target" signal the sweep already
 * requires; a bone-entity creature's Health lives on the root but its
 * Hitboxes live on the bones) — and its NpcTag PRESENCE differs from the
 * attacker's — the exact axis findNearestNonNpc / findDetectedThreat already
 * target. This is symmetric (a player snaps to NPCs, an NPC snaps to
 * players) with zero isNpc behavioural branch, and it can never snap to a
 * friendly. When factions land, replace the NpcTag-differs predicate with a
 * real team check.
 *
 * Positions come from the caller's already-rewound candidate list (the same
 * snapshot the sweep sweeps) so the chosen target's angle matches the swept
 * geometry; component gating reads the live world (snapshots carry no tags).
 *
 * Cost is distance-dominant with angular offset as the tiebreak:
 *   cost = distSq * (1 + off / halfAngle)
 * so a closer enemy slightly off-axis beats a far one dead-ahead, but among
 * near-equidistant enemies the one more in front wins. Ties break on the
 * caller's candidate order (deterministic).
 */
import type { World, EntityId } from "@voxim/engine";
import { NpcTag } from "../components/npcs.ts";
import { Health } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";

/** A candidate's rewound position (from the combat snapshot). */
export interface AimCandidate {
  entityId: EntityId;
  x: number;
  y: number;
}

export interface AimAssistConfig {
  rangeUnits: number;
  halfAngleRad: number;
}

/** Shortest-arc absolute angular difference (radians, in [0, π]). */
function angleOffset(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
}

/**
 * Pick the best in-cone enemy facing for an attacker at (ax, ay) facing
 * `currentFacing`, or null if none qualifies. Returns the facing angle to
 * orient the swing toward — not the entity — because the resolver only needs
 * the angle (the swept geometry is derived from facing + origin).
 */
export function pickAimAssistTarget(
  world: World,
  attackerId: EntityId,
  ax: number,
  ay: number,
  currentFacing: number,
  candidates: readonly AimCandidate[],
  cfg: AimAssistConfig,
): { entityId: EntityId; facing: number } | null {
  const attackerIsNpc = world.get(attackerId, NpcTag) !== null;
  const rangeSq = cfg.rangeUnits * cfg.rangeUnits;

  let best: { entityId: EntityId; facing: number } | null = null;
  let bestCost = Infinity;

  for (const c of candidates) {
    if (c.entityId === attackerId) continue;
    if (!world.isAlive(c.entityId)) continue;
    const health = world.get(c.entityId, Health);
    // Excludes a lingering dissolve corpse (T-311 P5c): DeathSystem keeps a
    // corpse `world.isAlive` for its dissolve_timer's duration when a hook
    // votes `{ linger: true }`, at Health.current === 0 — alive-but-dead, and
    // it still carries Hitbox/NpcTag, so without this check the sweep could
    // snap a swing onto a corpse.
    if (health === null || health.current <= 0) continue;
    // Same "is a combat target" signal the sweep uses — but the sweep can
    // land on a CHILD entity's Hitbox while Health lives on the ancestor
    // (T-333: a bone-entity creature). A candidate qualifies if it (or any
    // scene-graph descendant) carries a real Hitbox, so the aim-assist
    // facing still snaps to the creature root even when the root itself
    // carries no Hitbox of its own.
    if (!hasHitboxCoverage(world, c.entityId)) continue;
    // Hostility: NpcTag presence must differ from the attacker's (symmetric,
    // no isNpc branch, never friendly). Replace with a team check post-factions.
    if ((world.get(c.entityId, NpcTag) !== null) === attackerIsNpc) continue;

    const dx = c.x - ax;
    const dy = c.y - ay;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;

    const ang = Math.atan2(dy, dx);
    const off = angleOffset(ang, currentFacing);
    if (off > cfg.halfAngleRad) continue;

    const cost = distSq * (1 + off / cfg.halfAngleRad);
    if (cost < bestCost) {
      bestCost = cost;
      best = { entityId: c.entityId, facing: ang };
    }
  }

  return best;
}

/**
 * True if `entityId` itself carries a non-empty Hitbox, or any of its
 * scene-graph descendants does (T-333). `world.descendants` is O(subtree)
 * and cycle-safe by construction (purged reverse index) — bounded by the
 * same tree sizes the rest of the scene-graph arc already accepts.
 */
function hasHitboxCoverage(world: World, entityId: EntityId): boolean {
  const own = world.get(entityId, Hitbox);
  if (own && own.parts.length > 0) return true;
  for (const child of world.descendants(entityId)) {
    const h = world.get(child, Hitbox);
    if (h && h.parts.length > 0) return true;
  }
  return false;
}
