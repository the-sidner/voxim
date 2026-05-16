/**
 * Effect registry module — the skill-effect apply registry.
 *
 * To add a new effect type: create a generic handler, register it below,
 * reference its id from concept_verb_matrix.json as `effectStat`. Startup
 * validation in `server.ts` ensures every referenced effectStat has an
 * apply handler.
 *
 * The old tick / compose / outgoingDamage / incomingDamage sub-registries
 * are gone (T-239): periodic + stat-modifier effects are buff scene-graph
 * children read through the Status/Modifier `effective()` query; the
 * damage pipeline reads `effective()` directly. One registry, all generic.
 */
import { Registry } from "@voxim/engine";
import type { EffectApplyHandler } from "./effect_handler.ts";
import { speedApply, damageBoostApply, shieldApply, healthApply } from "./skill_effects.ts";
import { fleeEffectApply } from "./flee_effect.ts";

export type {
  EffectApplyHandler,
  EffectApplyContext,
} from "./effect_handler.ts";

export interface EffectRegistries {
  readonly apply: Registry<EffectApplyHandler>;
}

export function createEffectRegistries(): EffectRegistries {
  return { apply: new Registry<EffectApplyHandler>() };
}

/** Register all built-in effect handlers. */
export function registerBuiltinEffects(r: EffectRegistries): void {
  r.apply.register(healthApply);
  r.apply.register(speedApply);
  r.apply.register(damageBoostApply);
  r.apply.register(shieldApply);
  r.apply.register(fleeEffectApply);
}
