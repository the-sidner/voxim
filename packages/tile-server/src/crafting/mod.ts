/**
 * Crafting step handler registry + built-ins.
 *
 * To add a new step type (e.g., "ritual", "channeled"):
 *   1. Create a handler file under `steps/` implementing `RecipeStepHandler`.
 *   2. Register it in `registerBuiltinSteps` (or externally).
 *   3. Reference its id as `stepType` in recipe JSON.
 *
 * Startup validation in `server.ts` ensures every `stepType` referenced from
 * content resolves to a registered handler.
 */
import { Registry } from "@voxim/engine";
import type { RecipeStepHandler } from "./step_handler.ts";
import { attackStep } from "./steps/attack_step.ts";
import { assemblyStep } from "./steps/assembly_step.ts";
import { timeStep } from "./steps/time_step.ts";

export type {
  RecipeStepHandler,
  RecipeHitContext,
  RecipeTickContext,
} from "./step_handler.ts";

export function createRecipeStepRegistry(): Registry<RecipeStepHandler> {
  return new Registry<RecipeStepHandler>();
}

/**
 * Register all built-in step handlers in the order the dispatcher iterates
 * them. Order matters for onHit: assembly is tried before attack so an
 * explicit selection wins over a generic attack match.
 */
export function registerBuiltinSteps(registry: Registry<RecipeStepHandler>): void {
  registry.register(assemblyStep);
  registry.register(attackStep);
  registry.register(timeStep);
}
