/**
 * Effect registry module — interfaces, handlers, and the wiring helper.
 *
 * To add a new effect type:
 *   1. Create a handler file in this directory.
 *   2. Register it below in `registerBuiltinEffects` (or from outside).
 *   3. Reference its id from concept_verb_matrix.json as `effectStat`.
 *
 * Startup validation in `server.ts` ensures every effectStat referenced from
 * content has an apply handler registered.
 */
import { Registry } from "@voxim/engine";
import type {
  EffectApplyHandler,
  EffectTickHandler,
  EffectComposeHandler,
} from "./effect_handler.ts";
import type {
  OutgoingDamageHook,
  IncomingDamageHook,
} from "./damage_hook.ts";
import { healthEffectApply, healthEffectTick } from "./health_effect.ts";
import { speedEffectApply, speedEffectCompose } from "./speed_effect.ts";
import { damageBoostEffectApply, damageBoostOutgoingHook } from "./damage_boost_effect.ts";
import { shieldEffectApply, shieldIncomingHook } from "./shield_effect.ts";
import { fleeEffectApply } from "./flee_effect.ts";

export type {
  EffectApplyHandler,
  EffectApplyContext,
  EffectTickHandler,
  EffectTickContext,
  EffectComposeHandler,
  EffectContribution,
} from "./effect_handler.ts";
export type {
  OutgoingDamageHook,
  OutgoingDamageContext,
  IncomingDamageHook,
  IncomingDamageContext,
} from "./damage_hook.ts";

export interface EffectRegistries {
  readonly apply: Registry<EffectApplyHandler>;
  readonly tick: Registry<EffectTickHandler>;
  readonly compose: Registry<EffectComposeHandler>;
  readonly outgoingDamage: Registry<OutgoingDamageHook>;
  readonly incomingDamage: Registry<IncomingDamageHook>;
}

export function createEffectRegistries(): EffectRegistries {
  return {
    apply: new Registry<EffectApplyHandler>(),
    tick: new Registry<EffectTickHandler>(),
    compose: new Registry<EffectComposeHandler>(),
    outgoingDamage: new Registry<OutgoingDamageHook>(),
    incomingDamage: new Registry<IncomingDamageHook>(),
  };
}

/** Register all built-in effect handlers. */
export function registerBuiltinEffects(r: EffectRegistries): void {
  r.apply.register(healthEffectApply);
  r.apply.register(speedEffectApply);
  r.apply.register(damageBoostEffectApply);
  r.apply.register(shieldEffectApply);
  r.apply.register(fleeEffectApply);

  r.tick.register(healthEffectTick);

  r.compose.register(speedEffectCompose);

  r.outgoingDamage.register(damageBoostOutgoingHook);
  r.incomingDamage.register(shieldIncomingHook);
}
