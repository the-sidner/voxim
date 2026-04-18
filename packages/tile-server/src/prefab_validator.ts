/**
 * Prefab validator — runs at server boot after content is loaded.
 *
 * For every registered prefab:
 *   1. Every component key in `prefab.components` is either a compound
 *      archetype key (player/npc/resourceNode) consumed by `spawnPrefab`,
 *      or a registered `ComponentDef.name` in `DEF_BY_NAME`. Unknown keys
 *      fail loud with the prefab id.
 *   2. Where a registered component has a schema, the prefab's data for
 *      that key (merged with the component's default) passes `v.parse`.
 *   3. Every component's declared `requires` list is satisfied by siblings
 *      in the same prefab's components dict. "Siblings" here means the
 *      set of keys present after prefab inheritance has been resolved.
 *
 * Abstract prefabs (id starts with `_`) are validated too — inheritance can
 * make errors show up only in children, so catching the error at the root
 * is preferable.
 */
import * as v from "valibot";
import type { ContentStore } from "@voxim/content";
import { DEF_BY_NAME } from "./component_registry.ts";
import { COMPOUND_ARCHETYPE_KEYS } from "./spawner.ts";

export function validatePrefabs(content: ContentStore): void {
  for (const prefab of content.getAllPrefabs()) {
    for (const [name, rawData] of Object.entries(prefab.components)) {
      if (COMPOUND_ARCHETYPE_KEYS.has(name)) continue;

      const def = DEF_BY_NAME.get(name);
      if (!def) {
        throw new Error(
          `[prefab_validator] prefab '${prefab.id}': unknown component '${name}'. ` +
          `Not in DEF_BY_NAME and not a compound archetype key.`,
        );
      }

      if (def.schema) {
        const merged = { ...def.default(), ...(rawData as Record<string, unknown>) };
        const result = v.safeParse(def.schema, merged);
        if (!result.success) {
          const issues = result.issues.map((i) => i.message).join("; ");
          throw new Error(
            `[prefab_validator] prefab '${prefab.id}' component '${name}': ${issues}`,
          );
        }
      }

      if (def.requires) {
        for (const required of def.requires) {
          if (!(required in prefab.components)) {
            throw new Error(
              `[prefab_validator] prefab '${prefab.id}': component '${name}' ` +
              `requires '${required}', which is missing`,
            );
          }
        }
      }
    }
  }
}
