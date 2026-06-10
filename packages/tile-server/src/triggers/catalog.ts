/**
 * Trigger event-kind catalog (T-259) — the closed v1 vocabulary a
 * `TriggerDef.on` may name. Each entry binds a content-facing kind to a
 * `TileEvents` symbol and extracts the event's role → entity map (the
 * names a `TriggerDef.as` may bind to). Grows one registered entry per
 * need — the Registry<H> doctrine, never a switch.
 */

import type { EntityId, Registry } from "@voxim/engine";
import { Registry as RegistryImpl } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { HitLandedPayload, DamageDealtPayload, EntityDiedPayload } from "@voxim/protocol";

export interface TriggerEventBinding {
  /** Content-facing kind — what `TriggerDef.on` names. */
  id: string;
  /** The TileEvents symbol the TriggerSystem's collector subscribes to. */
  event: symbol;
  /** Role name → involved entity. A trigger's `as` must name one of these;
   * the effect's target binds to the *other* defined role. */
  roles(payload: unknown): Record<string, EntityId | undefined>;
}

export type TriggerCatalog = Registry<TriggerEventBinding>;

export function newTriggerCatalog(): TriggerCatalog {
  const r = new RegistryImpl<TriggerEventBinding>();
  r.register({
    id: "hit_landed",
    event: TileEvents.HitLanded,
    roles: (p) => {
      const e = p as HitLandedPayload;
      return { attacker: e.attackerId, target: e.targetId };
    },
  });
  r.register({
    id: "damage_taken",
    event: TileEvents.DamageDealt,
    roles: (p) => {
      const e = p as DamageDealtPayload;
      return { attacker: e.sourceId, target: e.targetId };
    },
  });
  r.register({
    id: "entity_died",
    event: TileEvents.EntityDied,
    roles: (p) => {
      const e = p as EntityDiedPayload;
      return { killer: e.killerId, victim: e.entityId };
    },
  });
  return r;
}
