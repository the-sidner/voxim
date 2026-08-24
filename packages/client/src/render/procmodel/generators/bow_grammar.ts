/**
 * `bow_grammar` generator (T-346 — T-306 composition) — thin ProcModel-
 * registry wrapper over `@voxim/content`'s shared `bowGrammarAtoms` core,
 * the bow/crossbow twin of `blade_grammar.ts`. Unlike `blade_grammar` there
 * is no server trace consumer to keep in sync (a bow is purely visual — see
 * the shared core's file doc), so this file only adapts the core to the
 * generator registry's calling convention (`ctx.resolveMaterial` -> the
 * core's `resolveMaterial` callback param), exactly like `blade_grammar.ts`
 * does. Not `class: "character"` — a bow isn't checked against the
 * human-anchor ground-plane invariant (DESIGN_LANGUAGE.md §6 item 4 only
 * applies to character-class generators).
 */
import type { BowGrammarParams } from "@voxim/content";
import { bowGrammarAtoms } from "@voxim/content";
import type { Generator } from "../registry.ts";

export type { BowGrammarParams };

export const bowGrammar: Generator = (seed, params, ctx) =>
  bowGrammarAtoms(seed, params as BowGrammarParams, ctx.resolveMaterial);
