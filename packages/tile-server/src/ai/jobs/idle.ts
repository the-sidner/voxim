/**
 * Idle — stand in place. No plan, no movement, no actions.
 */
import type { GameConfig } from "@voxim/content";
import type { JobHandler, JobTickAction } from "../job_handler.ts";

const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

export const idleJob: JobHandler = {
  id: "idle",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.idleTicks;
  },
  plan(): null {
    return null;
  },
  tick(): JobTickAction {
    return NO_ACTION;
  },
};
