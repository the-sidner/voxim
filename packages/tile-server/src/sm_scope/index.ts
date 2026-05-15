/**
 * Default contributor list for the CSM scope. Order is registration order —
 * contributors must not depend on each other within a single tick, but the
 * order is stable for any code that wants to introspect (e.g. T-194's
 * validator).
 *
 * Adding a new scope namespace = create a file in this directory, then
 * append the contributor here. No code changes needed in
 * CharacterStateMachineSystem.
 */

import type { SMScopeContributor } from "./types.ts";
import { velocityContributor } from "./velocity.ts";
import { healthContributor } from "./health.ts";
import { inputContributor } from "./input.ts";
import { physicsContributor } from "./physics.ts";
import { equipmentContributor } from "./equipment.ts";
import { eventsContributor } from "./events.ts";

export const DEFAULT_SM_SCOPE_CONTRIBUTORS: readonly SMScopeContributor[] = [
  velocityContributor,
  healthContributor,
  inputContributor,
  physicsContributor,
  equipmentContributor,
  eventsContributor,
];

/**
 * Union of every variable a contributor in `contributors` emits. The CSM
 * compile-time validator (T-194) uses this set to fail server boot when a
 * transition references a name that nothing produces.
 */
export function collectKnownScopeVars(
  contributors: readonly SMScopeContributor[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of contributors) for (const v of c.variables) out.add(v);
  return out;
}

export type { SMScopeContext, SMScopeContributor } from "./types.ts";
