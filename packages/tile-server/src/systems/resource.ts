/**
 * ResourceSystem (T-238) — the one tick loop for every bounded scalar.
 *
 * For each entity carrying `Resource`, for each `values[id]`:
 *   1. resolve `ResourceDef`; chain its `rateModifiers` over the base rate;
 *   2. integrate `value += rate × dt`, clamp to `[def.bounds.min, rv.max]`
 *      (`rv.max` is per-entity — seeded at spawn);
 *   3. fire thresholds — `sustained` every tick in-zone, `cross` once on
 *      entering the zone — through the shared `ResourceEffect` registry.
 *
 * Replaces StaminaSystem / HungerSystem / PoiseSystem / the crafting
 * time-step timer (migrated one-by-one in T-238b…f). (CorruptionSystem
 * was deleted outright at T-238e — the mechanic was removed, not
 * migrated; it returns later at a different scale.) Entity-generic:
 * actors (stamina/hunger/thirst/poise), workstations (crafting_timer),
 * and buff children (buff_timer) all carry `Resource` alike.
 */

import type { World } from "@voxim/engine";
import type { ContentService, ResourceThreshold } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Resource } from "../components/resource.ts";
import type { ResourceData } from "../components/resource.ts";
import type { ResourceEffectRegistry } from "../resources/effect.ts";
import type { ResourceModifierRegistry } from "../resources/modifier.ts";
import type { ModifierSourceRegistry } from "../modifiers/modifier.ts";
import type { DeathRequestPort } from "../events/death.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ResourceSystem");

function inZone(v: number, t: ResourceThreshold): boolean {
  return t.dir === "above" ? v >= t.at : v <= t.at;
}

export class ResourceSystem implements System {
  readonly dependsOn = [];

  constructor(
    private readonly content: ContentService,
    private readonly effects: ResourceEffectRegistry,
    private readonly modifiers: ResourceModifierRegistry,
    private readonly deaths: DeathRequestPort,
    private readonly sources: ModifierSourceRegistry,
  ) {}

  run(world: World, events: EventEmitter, dt: number): void {
    for (const { entityId, resource } of world.query(Resource)) {
      // Per-key integration deltas, applied as ONE composing mutate at the
      // end (T-249): the integration composes with other writers' same-tick
      // contributions (a stamina spend, a poise hit) instead of rewriting
      // the whole component last-write-wins. Thresholds are still evaluated
      // against the run-time integrated value — same-tick foreign deltas
      // shift threshold timing by ≤1 tick, the accepted Resource retune.
      let deltas: Record<string, { delta: number; min: number }> | null = null;

      for (const [id, rv] of Object.entries(resource.values)) {
        const def = this.content.resources.get(id);
        if (!def) {
          log.debug("entity=%s carries unknown resource '%s' — skipped", entityId, id);
          continue;
        }

        let rate = def.rate;
        for (const m of def.rateModifiers ?? []) {
          rate = this.modifiers.get(m.kind).rate(
            { world, entityId, content: this.content, def, value: rv.value, dt, params: m.params ?? {}, sources: this.sources },
            rate,
          );
        }

        const prev = rv.value;
        const nextVal = Math.max(def.bounds.min, Math.min(rv.max, prev + rate * dt));

        for (const t of def.thresholds ?? []) {
          const fire = t.edge === "sustained"
            ? inZone(nextVal, t)
            : (inZone(nextVal, t) && !inZone(prev, t));
          if (!fire) continue;
          this.effects.get(t.effect).resolve({
            world, events, entityId, content: this.content,
            resourceId: id, value: nextVal, dt,
            params: t.params ?? {}, deaths: this.deaths,
          });
        }

        if (nextVal !== prev) {
          if (!deltas) deltas = {};
          deltas[id] = { delta: nextVal - prev, min: def.bounds.min };
        }
      }

      if (deltas) {
        const d = deltas;
        world.mutate(entityId, Resource, (r): ResourceData => {
          const values = { ...r.values };
          for (const [id, { delta, min }] of Object.entries(d)) {
            const rv = values[id];
            if (!rv) continue;
            values[id] = {
              value: Math.max(min, Math.min(rv.max, rv.value + delta)),
              max: rv.max,
            };
          }
          return { values };
        });
      }
    }
  }
}
