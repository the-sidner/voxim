/**
 * Status / Modifier primitive (T-239) — the third content-driven
 * primitive, alongside Actions and Resources.
 *
 * "What changes this entity's effective stats?" had five scattered,
 * unrelated mechanisms (buffs, equipment scans, environment, posture,
 * resource rate-bends). The unifying atom is one record:
 *
 *   StatModifier — "stat S changes by (op, value)" from some source.
 *
 * Sources stay where they are already authoritative (the Equipment
 * component, scene-graph buff children, carried weight); a `ModifierSource`
 * registry (the same `Registry<H>` doctrine as gates / effects /
 * rateModifiers — no hardcoded switch on a kind) composes them on read:
 *
 *   effective(stat) = (base + Σ add) × Π mul
 *
 * The stat decides whether its sources are `add` (armorReduction: a sum)
 * or `mul` (moveSpeed: a product) purely by what they emit. No stored,
 * synced ledger — equipment is read live from the component that already
 * owns it; nothing is duplicated. See `STATUS_MODIFIER_PLAN.md`.
 *
 * Phase 1 (this file + the equipment/encumbrance sources): inert
 * substrate — nothing calls `effective()` yet (BuffSystem / SpeedModifier
 * still authoritative). Mirrors the T-238a precedent.
 */

import type { World, EntityId } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService } from "@voxim/content";

export type ModifierOp = "add" | "mul";

export interface StatModifier {
  /** Stat id, e.g. "moveSpeed", "armorReduction", "staminaRegen". */
  readonly stat: string;
  readonly op: ModifierOp;
  readonly value: number;
}

export interface ModifierSourceContext {
  readonly world: World;
  readonly content: ContentService;
  readonly entityId: EntityId;
}

export interface ModifierSource {
  /** Registry key (the source kind: "equipment" | "encumbrance" | …). */
  readonly id: string;
  /** Every modifier this source contributes for `entityId` right now. */
  contribute(ctx: ModifierSourceContext): StatModifier[];
}

export type ModifierSourceRegistry = Registry<ModifierSource>;

export function newModifierSourceRegistry(): ModifierSourceRegistry {
  return new Registry<ModifierSource>();
}

/**
 * Compose every registered source's modifiers for one stat:
 *   `(base + Σ add) × Π mul`.
 * Pure read — no caching here (add a per-tick memo only if measured;
 * a materialized store would re-introduce exactly the sync the hybrid
 * model rejects).
 */
export function effective(
  registry: ModifierSourceRegistry,
  ctx: ModifierSourceContext,
  stat: string,
  base: number,
): number {
  let add = 0;
  let mul = 1;
  for (const id of registry.ids()) {
    for (const m of registry.get(id).contribute(ctx)) {
      if (m.stat !== stat) continue;
      if (m.op === "add") add += m.value;
      else mul *= m.value;
    }
  }
  return (base + add) * mul;
}
