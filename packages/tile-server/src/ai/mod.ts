/**
 * NPC AI module — job handler registry + built-in registrations.
 *
 * To add a new job type:
 *   1. Add its discriminant to the `Job` union in `@voxim/codecs`.
 *   2. Create a handler file under `jobs/` implementing `JobHandler`.
 *   3. Register it below in `registerBuiltinJobs` (or from outside).
 *
 * Startup validation in `server.ts` ensures every job handler id is unique;
 * additional content-level validation can be added as the job set grows.
 */
import { Registry } from "@voxim/engine";
import type { JobHandler } from "./job_handler.ts";
import { idleJob } from "./jobs/idle.ts";
import { wanderJob } from "./jobs/wander.ts";
import { fleeJob } from "./jobs/flee.ts";
import { seekFoodJob } from "./jobs/seek_food.ts";
import { seekWaterJob } from "./jobs/seek_water.ts";
import { attackTargetJob } from "./jobs/attack_target.ts";
import { craftAtWorkbenchJob } from "./jobs/craft_at_workbench.ts";

export type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
  NpcTuning,
} from "./job_handler.ts";

export function createJobRegistry(): Registry<JobHandler> {
  return new Registry<JobHandler>();
}

/** Register all built-in job handlers. */
export function registerBuiltinJobs(registry: Registry<JobHandler>): void {
  registry.register(idleJob);
  registry.register(wanderJob);
  registry.register(fleeJob);
  registry.register(seekFoodJob);
  registry.register(seekWaterJob);
  registry.register(attackTargetJob);
  registry.register(craftAtWorkbenchJob);
}
