import type { ComponentDef, World, EntityId } from "@voxim/engine";
import type { EventEmitter } from "./system.ts";
import type { DerivedItemStats } from "@voxim/content";

/**
 * All data available to a HitHandler when ActionSystem confirms a blade-capsule hit.
 *
 * Positions and snapshot values are lag-compensated — they reflect the state at the
 * rewind tick used for hit resolution, not necessarily the current server tick.
 */
export interface HitContext {
  attackerId: EntityId;
  /**
   * The entity this handler should act on. For a handler declaring
   * `requiredComponent` (T-333), this is already resolved to the nearest
   * ancestor of the struck entity carrying that component — never the raw
   * struck entity unless they're the same (the parentless case, or the
   * struck entity itself carries it). `bodyPart` still names which part of
   * the struck geometry was actually hit, so that identity survives the
   * bubble-up.
   */
  targetId: EntityId;
  /** Derived stats of the equipped weapon (or unarmed defaults). */
  weaponStats: DerivedItemStats;
  /** Which body part was struck — e.g. "head", "torso", "trunk". */
  bodyPart: string;
  /**
   * Which part of the attacker's weapon landed the hit — "tip", "mid", or
   * "haft", derived from the contact point's parameter along the blade
   * segment. Drives the attacker-side damage multiplier (tip > haft).
   */
  attackerPart: "tip" | "mid" | "haft";
  /** Lag-compensated facing of the target at time of hit (for block/parry arc). */
  targetSnapshotFacing: number;
  /** Lag-compensated world position of the attacker. */
  attackerX: number;
  attackerY: number;
  /** Lag-compensated world position of the target. */
  targetX: number;
  targetY: number;
  /** World-space contact point — midpoint between closest points on the blade and hit capsule. */
  hitX: number;
  hitY: number;
  hitZ: number;
  /**
   * Whether the attacker can be staggered by a successful parry.
   * Melee hits: true — attacker is nearby and physically can be staggered.
   * Projectile hits: false — attacker is far away, parry deflects but cannot stagger them.
   */
  parryAllowed: boolean;
}

/**
 * A HitHandler is called by ActionSystem for every confirmed hit, once per handler
 * per hit. Each handler is responsible for checking whether the target has the
 * component(s) it cares about, and returning immediately if not.
 *
 * Handlers may call world.set() freely — writes land in the same changeset as all
 * other system writes this tick. Handlers must not call world.write() (immediate
 * writes are reserved for spawn-time initialisation).
 *
 * Registration: pass the handler array to ActionSystem's constructor in server.ts.
 * Order matters only when two handlers might both react to the same target (currently
 * no such overlap exists). The array is fixed at startup and never modified at runtime.
 */
export interface HitHandler {
  /**
   * The component this handler dispatches on (T-333). Declaring it lets
   * the shared sweep dispatch (`combat/sweep.ts`) resolve `ctx.targetId`
   * to the nearest ancestor of the struck entity carrying it —
   * `World.findAncestorWithComponent` — BEFORE calling `onHit`, so a hit
   * that lands on a child entity (a bone, a prop sub-object) still reaches
   * the ancestor that owns the behaviour. Purely declarative: `onHit`'s own
   * `world.get(ctx.targetId, X)` check is unchanged and still the source of
   * truth — this field only tells the generic walk where to look. A
   * handler that omits it (none do today) dispatches to the struck entity
   * as before.
   */
  readonly requiredComponent?: ComponentDef<unknown>;
  onHit(world: World, events: EventEmitter, ctx: HitContext): void;
}
