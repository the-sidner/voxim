/**
 * Resource rate-modifier registry (T-238).
 *
 * A closed vocabulary of rate transforms (armor penalty, cross-resource
 * scale, day/night selection, tile coupling) — `Registry<H>` doctrine, no
 * inline logic, no expression DSL (the action-arc rule). A modifier takes
 * the running rate and returns the transformed rate; `ResourceDef.rateModifiers`
 * chains them in declaration order. Shipped kind: `equipment_stat`
 * (stamina's worn-gear regen coupling) — it defers to the Status/Modifier
 * `effective()` query rather than scanning Equipment itself.
 */

import type { World, EntityId } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService, ResourceDef } from "@voxim/content";
import type { ModifierSourceRegistry } from "../modifiers/modifier.ts";

export interface RateModifierContext {
  readonly world: World;
  readonly entityId: EntityId;
  readonly content: ContentService;
  readonly def: ResourceDef;
  /** The resource's current value (pre-integration this tick). */
  readonly value: number;
  readonly dt: number;
  /** The modifier's typed payload from the ResourceDef JSON. */
  readonly params: Record<string, unknown>;
  /** Status/Modifier query registry — for sources that read effective(). */
  readonly sources: ModifierSourceRegistry;
}

export interface ResourceRateModifier {
  /** Registry key — the string used in `ResourceRateModifierRef.kind`. */
  readonly id: string;
  /** Transform the running rate (scale / replace / offset). Pure. */
  rate(ctx: RateModifierContext, current: number): number;
}

export type ResourceModifierRegistry = Registry<ResourceRateModifier>;

export function newResourceModifierRegistry(): ResourceModifierRegistry {
  return new Registry<ResourceRateModifier>();
}
