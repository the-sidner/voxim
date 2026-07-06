/**
 * `blade_grammar` generator (T-306) — thin ProcModel-registry wrapper over
 * `@voxim/content`'s shared `bladeGrammarAtoms` core. The registry/Generator
 * shape (`(seed, params, ctx) => VoxelAtom[]`) is client-only (T-285), but the
 * actual geometry evaluator is NOT duplicated here — it lives in
 * `blade_grammar.ts` under `@voxim/content` so the server's `weapon_trace`
 * resolver can call the SAME pure function (`deriveBladeGeometry`) to derive
 * the swept-hitbox length/radius from the identical seed. This file only
 * adapts that shared core to the generator registry's calling convention
 * (`ctx.resolveMaterial` → the core's `resolveMaterial` callback param).
 *
 * DESIGN_LANGUAGE.md §1 composition: LIMB spine + SOLID pommel + SHELL guard
 * (see the core's file doc for the full breakdown). Not `class: "character"`
 * — a weapon isn't checked against the human-anchor ground-plane invariant
 * (DESIGN_LANGUAGE.md §6 item 4 only applies to character-class generators).
 */
import type { BladeGrammarParams } from "@voxim/content";
import { bladeGrammarAtoms } from "@voxim/content";
import type { Generator } from "../registry.ts";

export type { BladeGrammarParams };

export const bladeGrammar: Generator = (seed, params, ctx) =>
  bladeGrammarAtoms(seed, params as BladeGrammarParams, ctx.resolveMaterial);
