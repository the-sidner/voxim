/**
 * Resource threshold-effect registry (T-238).
 *
 * Same `Registry<H>` doctrine as the action arc's gate/effect registries —
 * content-defined string dispatch, never a hardcoded switch. The *context*
 * differs from the action `ResolveContext` (no slot/phase/ActiveActionState
 * — a resource crossing a threshold is not an action), so this is its own
 * registry rather than synthesising fake action state to reuse the action
 * one. Same spine, honest about the shape (cf. RESOURCE_PRIMITIVE_PLAN.md).
 */

import type { World, EntityId } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { DeathRequestPort } from "../events/death.ts";

export interface ResourceEffectContext {
  readonly world: World;
  readonly events: EventEmitter;
  /** The entity whose resource crossed the threshold (tile-scope: the tile entity). */
  readonly entityId: EntityId;
  readonly content: ContentService;
  /** The resource id whose threshold fired. */
  readonly resourceId: string;
  /** The resource's value after this tick's integration + clamp. */
  readonly value: number;
  /** Fixed server tick seconds (1/20) — resources tick at the server rate. */
  readonly dt: number;
  /** Threshold's typed payload from the ResourceDef JSON. */
  readonly params: Record<string, unknown>;
  /** Death is a direct port (not an event); lethal couplings request through it. */
  readonly deaths: DeathRequestPort;
}

export interface ResourceEffect {
  /** Registry key — the string used in `ResourceThreshold.effect`. */
  readonly id: string;
  resolve(ctx: ResourceEffectContext): void;
}

export type ResourceEffectRegistry = Registry<ResourceEffect>;

export function newResourceEffectRegistry(): ResourceEffectRegistry {
  return new Registry<ResourceEffect>();
}
