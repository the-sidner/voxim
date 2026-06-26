/**
 * Procmodel module entry (T-285) — registers the built-in generators and runs
 * the client boot cross-check that fails fast on a content typo, mirroring
 * `server.ts`'s ResourceDef/BT cross-checks.
 */
import type { ContentService } from "@voxim/content";
import { registerGenerator, getGenerator, generatorIds } from "./registry.ts";
import { treeGrammar } from "./generators/tree_grammar.ts";
import { boulderGrammar } from "./generators/boulder_grammar.ts";
import { foliageTuft } from "./generators/foliage_tuft.ts";
import { mushroom } from "./generators/mushroom.ts";

let _registered = false;

/** Register every built-in generator. Idempotent (safe across tile transitions). */
export function registerBuiltinGenerators(): void {
  if (_registered) return;
  _registered = true;
  registerGenerator("tree_grammar", treeGrammar);
  registerGenerator("boulder_grammar", boulderGrammar);
  registerGenerator("foliage_tuft", foliageTuft);
  registerGenerator("mushroom", mushroom);
}

/**
 * Client boot cross-check (T-285): every `ProcModelDef.generator` resolves to a
 * registered generator, and every `ScatterDef.procModel` resolves to a
 * `ProcModelDef`. Throws on a typo — the same fail-fast discipline the server
 * applies to ResourceDef / behaviour-tree ids.
 */
export function crossCheckProcModels(content: ContentService): void {
  registerBuiltinGenerators();
  for (const pm of content.procModels.values()) {
    if (!getGenerator(pm.generator)) {
      throw new Error(
        `[procmodel] "${pm.id}" names unknown generator "${pm.generator}" ` +
        `(registered: ${generatorIds().join(", ") || "none"})`,
      );
    }
  }
  for (const s of content.scatter.values()) {
    if (!content.procModels.get(s.procModel)) {
      throw new Error(`[procmodel] scatter "${s.id}" references unknown procModel "${s.procModel}"`);
    }
  }
}

export { registerGenerator, getGenerator, generatorIds } from "./registry.ts";
export type { Generator, GeneratorContext } from "./registry.ts";
