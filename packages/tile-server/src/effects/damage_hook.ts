/**
 * Damage-pipeline hooks — the fourth and fifth effect registries.
 *
 *   apply / tick / compose handlers operate on an entity's own state.
 *   Damage hooks operate at the boundary between two entities (attacker
 *   strikes target). Two flavors:
 *
 *     OutgoingDamageHook — runs on the ATTACKER's effects before the
 *       target's defenses. Returns a multiplicative factor (1.0 = no
 *       change). May mutate the attacker's ActiveEffects (e.g. consume
 *       a one-shot damage_boost on use).
 *
 *     IncomingDamageHook — runs on the TARGET's effects after the
 *       attacker's multipliers but before final HP application.
 *       Returns the surviving damage (i.e. shield absorbs some).
 *       May mutate the target's ActiveEffects (e.g. drain a shield's
 *       magnitude).
 *
 * Each handler is responsible for searching the relevant ActiveEffects
 * list for the effects it cares about; handlers with nothing to do
 * return identity (1.0 multiplier or unchanged damage).
 */
import type { World, EntityId } from "@voxim/engine";
import type { HitContext } from "../hit_handler.ts";
import type { ActiveEffectsData } from "../components/lore_loadout.ts";

export interface OutgoingDamageContext {
  readonly world: World;
  readonly attackerId: EntityId;
  /** Snapshot of the attacker's ActiveEffects at hit time. */
  readonly attackerEffects: ActiveEffectsData;
  readonly hit: HitContext;
}

export interface OutgoingDamageHook {
  readonly id: string;
  /** Multiplicative factor on outgoing damage. 1.0 = no change. */
  apply(ctx: OutgoingDamageContext): number;
}

export interface IncomingDamageContext {
  readonly world: World;
  readonly targetId: EntityId;
  /** Snapshot of the target's ActiveEffects at hit time. */
  readonly targetEffects: ActiveEffectsData;
  /** Damage as it stands after attacker multipliers + armor + block. */
  readonly incomingDamage: number;
  readonly hit: HitContext;
}

export interface IncomingDamageHook {
  readonly id: string;
  /** Returns the damage that survives this hook. */
  apply(ctx: IncomingDamageContext): number;
}
