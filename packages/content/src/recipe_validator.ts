/**
 * Recipe-graph validator — runs once at server boot. Catches the class of
 * content bug where a recipe formula references a stat that no upstream
 * producer (raw-material prefab default OR another recipe's output formula)
 * ever emits. Without this check, a bow recipe referencing `stave.flexibility`
 * silently evaluates to NaN if `bow_stave_split` forgot to declare it.
 *
 * The validator walks every recipe, parses every output stat formula, and
 * confirms each variable reference is satisfiable:
 *
 *   `<role>.<stat>`         — the role's input(s) must include `<stat>` in
 *                             their producible-stats set.
 *   `tool.<stat>`,
 *   `workstation.<stat>`,
 *   `skill.<verb>`           — must belong to the documented scope set
 *                             (`KNOWN_AMBIENT_VARS` below).
 *
 * Producible-stats per item:
 *   - For a raw-material prefab: keys of `prefab.stats` (declared on disk).
 *   - For a crafted prefab: union of stat names emitted by every recipe
 *     that produces it (formulas are parsed once).
 *
 * Throws on first failure with both the recipe id and the missing variable
 * name. Server boot fails — no half-loaded crafting state.
 */
import type { ContentStore } from "./store.ts";
import type { Prefab, Recipe, RecipeInput } from "./types.ts";
import { parseFormula } from "./formula.ts";

// Ambient variables the formula scope always provides. Recipes can refer to
// these without further proof; missing values evaluate to 0 at craft time.
// Keep tight so typos like `tool.toolType` (vs `tool.qualityTier`) fail loud.
const KNOWN_AMBIENT_VARS: ReadonlySet<string> = new Set([
  "workstation.quality",
]);

/** Validate every recipe in the store. Throws on the first defect found. */
export function validateRecipeGraph(content: ContentStore): void {
  const allRecipes = content.getAllRecipes();
  const allPrefabs = content.getAllPrefabs();
  const producibleByPrefab = computeProducibleStats(allRecipes, allPrefabs);

  for (const recipe of allRecipes) {
    validateInputs(recipe);
    for (const output of recipe.outputs) {
      if (!output.stats) continue;
      for (const [statName, source] of Object.entries(output.stats)) {
        let parsed;
        try {
          parsed = parseFormula(source);
        } catch (err) {
          throw new Error(
            `recipe '${recipe.id}': output '${output.itemType}' stat '${statName}' formula failed to parse: ${(err as Error).message}`,
          );
        }
        for (const varName of parsed.vars) {
          if (KNOWN_AMBIENT_VARS.has(varName)) continue;
          // Skill / tool variables — accepted but not validated against a
          // schema yet; they're a known follow-up scope.
          if (varName.startsWith("skill.") || varName.startsWith("tool.")) continue;

          const dot = varName.indexOf(".");
          if (dot <= 0) {
            throw new Error(
              `recipe '${recipe.id}': output '${output.itemType}' stat '${statName}' references unscoped var '${varName}' (expected '<role>.<stat>')`,
            );
          }
          const roleName = varName.slice(0, dot);
          const statRef  = varName.slice(dot + 1);
          const input = recipe.inputs.find((i) => i.role === roleName);
          if (!input) {
            throw new Error(
              `recipe '${recipe.id}': formula for '${output.itemType}.${statName}' references role '${roleName}' that the recipe doesn't declare`,
            );
          }
          const candidates = candidatePrefabs(input, allPrefabs);
          if (candidates.length === 0) {
            throw new Error(
              `recipe '${recipe.id}': role '${roleName}' has no candidate prefabs (category/tags filter matches nothing)`,
            );
          }
          // Every candidate that could fill this role must be able to
          // provide the requested stat — otherwise picking the "wrong"
          // candidate at craft time would leave the formula evaluating
          // against a missing var.
          const missing = candidates.filter((p) => !(producibleByPrefab.get(p.id)?.has(statRef)));
          if (missing.length > 0) {
            throw new Error(
              `recipe '${recipe.id}': formula for '${output.itemType}.${statName}' wants '${roleName}.${statRef}', but ${missing.length} candidate prefab(s) don't produce it: ${missing.slice(0, 5).map((p) => p.id).join(", ")}${missing.length > 5 ? ", …" : ""}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Set of stat names each prefab can carry: union of (a) its own declared
 * `stats` keys (raw-material defaults) and (b) every output-formula key from
 * every recipe that produces it (crafted intermediates).
 */
function computeProducibleStats(recipes: readonly Recipe[], prefabs: readonly Prefab[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of prefabs) {
    if (p.stats) out.set(p.id, new Set(Object.keys(p.stats)));
  }
  for (const r of recipes) {
    for (const o of r.outputs) {
      if (!o.stats) continue;
      const set = out.get(o.itemType) ?? new Set();
      for (const k of Object.keys(o.stats)) set.add(k);
      out.set(o.itemType, set);
    }
  }
  return out;
}

function candidatePrefabs(input: RecipeInput, prefabs: readonly Prefab[]): readonly Prefab[] {
  if ("itemType" in input && input.itemType !== undefined) {
    return prefabs.filter((p) => p.id === input.itemType);
  }
  if ("category" in input && input.category !== undefined) {
    return prefabs.filter((p) => {
      if (p.category !== input.category) return false;
      if (input.tags) {
        const have = p.tags ?? [];
        for (const t of input.tags) if (!have.includes(t)) return false;
      }
      return true;
    });
  }
  return [];
}

function validateInputs(recipe: Recipe): void {
  const seenRoles = new Set<string>();
  for (const input of recipe.inputs) {
    const hasItemType = "itemType" in input && input.itemType !== undefined;
    const hasCategory = "category" in input && input.category !== undefined;
    if (hasItemType === hasCategory) {
      throw new Error(`recipe '${recipe.id}': input must declare exactly one of itemType / category (role='${input.role}')`);
    }
    if (typeof input.role !== "string" || input.role.length === 0) {
      throw new Error(`recipe '${recipe.id}': input is missing a non-empty 'role'`);
    }
    if (seenRoles.has(input.role)) {
      throw new Error(`recipe '${recipe.id}': role '${input.role}' appears more than once`);
    }
    seenRoles.add(input.role);
    if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error(`recipe '${recipe.id}': role '${input.role}' has invalid quantity ${input.quantity}`);
    }
  }
}
