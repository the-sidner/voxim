/**
 * SMScopeContributor — declarative source of variables for the CSM tick.
 *
 * Replaces the monolithic `buildSMScope` of T-192. Each contributor owns
 * one namespace of variables and writes them into the per-entity scope each
 * tick. Adding a new SM-readable variable is a one-file drop: register a
 * contributor in the default list and the SM can immediately read it.
 *
 * Contributors run in registration order. They are not allowed to read
 * other contributors' output within the same tick (no inter-contributor
 * dependencies) — if a value composes others, derive it inside one
 * contributor or read source components directly.
 *
 * The set of all variables a contributor emits is intentionally implicit
 * for now. T-194 will add a compile-time validation pass that cross-checks
 * referenced variables against contributor outputs and fails server boot on
 * typos.
 */

import type { World } from "@voxim/engine";
import type { ContentService, SMScopeValue } from "@voxim/content";
import type { TickEventBuffer } from "../tick_events.ts";

export interface SMScopeContext {
  readonly world: World;
  readonly entityId: string;
  readonly content: ContentService;
  readonly tickEvents: TickEventBuffer;
}

export interface SMScopeContributor {
  /**
   * Documentation-only label naming the dotted prefix this contributor owns
   * (e.g. "vel", "health", "input"). Useful for stack traces and error
   * messages.
   */
  readonly namespace: string;
  /**
   * Full list of variable names this contributor emits into the scope.
   * Used by T-194's validator to cross-check transition references — a
   * variable referenced in a transition but absent from every contributor's
   * `variables` list is a typo and fails server boot.
   *
   * Must stay in sync with what `contribute()` writes. The
   * `contributor-variables-in-sync` test runs each contributor against a
   * mock context and asserts the emitted keys match this declaration.
   */
  readonly variables: readonly string[];
  /**
   * Write this contributor's variables into `scope`. Must not allocate new
   * objects per call beyond what's strictly necessary — runs once per actor
   * per tick.
   */
  contribute(ctx: SMScopeContext, scope: Record<string, SMScopeValue>): void;
}
