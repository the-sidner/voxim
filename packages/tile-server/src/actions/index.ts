/**
 * Action runtime (T-226) — the substrate for the universal behavior
 * primitive. See ACTION_PRIMITIVE_PLAN.md.
 *
 * Nothing is wired into the server tick yet: the locomotion/posture
 * migration is the first consumer. This barrel is the public surface the
 * migration and its tests build against.
 */

export { newGateRegistry } from "./gate.ts";
export type { GateRegistry, GateHandler, GateContext } from "./gate.ts";

export { newEffectRegistry } from "./effect.ts";
export type { EffectRegistry, EffectResolver, ResolveContext, EffectEdge } from "./effect.ts";

export { ActionDispatcher } from "./dispatcher.ts";
export type { IntentResolver, CostHandler } from "./dispatcher.ts";

export { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
export { WeaponTraceResolver, ProjectileSpawnResolver } from "./resolvers/combat.ts";
