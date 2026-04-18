/**
 * System ordering — stable topological sort for the tick's system pipeline.
 *
 * Each System declares `dependsOn` — names of systems that must run *before*
 * it. A Kahn-style sort produces the final execution order. When two systems
 * have no ordering constraint between them (neither transitively depends on
 * the other) the original array position breaks the tie: the system that
 * appears earlier in the input stays earlier in the output. That lets the
 * server file keep reading like a pipeline — `const systems = [A, B, C, …]`
 * — while the sorter only reshuffles pairs whose order actually matters.
 *
 * Cycles and missing dependencies fail fast at startup with a descriptive
 * error. There is no runtime fallback; an unsortable pipeline is a bug in
 * the system declarations, not a recoverable condition.
 */
import type { System } from "./system.ts";

/**
 * Extract the name the sorter uses to identify a system. Prefers an explicit
 * `name` field on the system (for systems that want a stable name decoupled
 * from their class), falls back to the constructor name.
 */
function systemName(s: System): string {
  return s.name ?? s.constructor.name;
}

/**
 * Sort a list of systems so every `dependsOn` name appears earlier in the
 * output than the system that declared the dependency. Preserves the input
 * order for systems that have no ordering relationship.
 *
 * Throws if:
 *   - two systems share a name (ambiguous reference target)
 *   - any dependsOn name doesn't match a system in the list
 *   - the declared dependencies form a cycle
 */
export function sortSystemsByDependencies(systems: System[]): System[] {
  // ---- index + uniqueness check ----
  const byName = new Map<string, { idx: number; system: System }>();
  for (let i = 0; i < systems.length; i++) {
    const name = systemName(systems[i]);
    if (byName.has(name)) {
      throw new Error(`[system_order] duplicate system name "${name}" — names must be unique`);
    }
    byName.set(name, { idx: i, system: systems[i] });
  }

  // ---- build adjacency + in-degree ----
  // edge dep → system means: dep must appear before system in the output.
  const dependents = new Map<string, string[]>(); // dep → [systems that depend on it]
  const inDegree = new Map<string, number>();
  for (const s of systems) inDegree.set(systemName(s), 0);

  for (const s of systems) {
    const sName = systemName(s);
    for (const depName of s.dependsOn ?? []) {
      if (!byName.has(depName)) {
        throw new Error(
          `[system_order] system "${sName}" declares dependsOn "${depName}" but no system with that name exists in the pipeline`,
        );
      }
      if (depName === sName) {
        throw new Error(`[system_order] system "${sName}" declares itself as a dependency`);
      }
      let list = dependents.get(depName);
      if (!list) { list = []; dependents.set(depName, list); }
      list.push(sName);
      inDegree.set(sName, (inDegree.get(sName) ?? 0) + 1);
    }
  }

  // ---- Kahn's algorithm, stable by original index ----
  // The ready set is kept sorted by original input index so ties break in
  // declaration order. Using a sorted-insert pass each time keeps the
  // implementation tiny; with ~30 systems this is cheaper than maintaining
  // a heap.
  const ready: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) ready.push(name);
  }
  ready.sort((a, b) => byName.get(a)!.idx - byName.get(b)!.idx);

  const result: System[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    result.push(byName.get(next)!.system);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        // Insert in order of original index to preserve stability.
        const idx = byName.get(dependent)!.idx;
        let insertAt = ready.length;
        for (let i = 0; i < ready.length; i++) {
          if (byName.get(ready[i])!.idx > idx) { insertAt = i; break; }
        }
        ready.splice(insertAt, 0, dependent);
      }
    }
  }

  if (result.length !== systems.length) {
    const unresolved = systems
      .filter((s) => !result.includes(s))
      .map((s) => `${systemName(s)} (deps: ${(s.dependsOn ?? []).join(", ") || "none"})`);
    throw new Error(
      `[system_order] dependency cycle detected — unresolved systems: ${unresolved.join("; ")}`,
    );
  }

  return result;
}
