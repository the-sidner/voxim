/**
 * `input.*` scope variables — one boolean per action bitflag.
 *
 * NPCs and players share this contributor — both write into the same
 * `InputState` component (NpcAiSystem for NPCs, input drain for players).
 * The CSM treats them identically.
 */

import type { SMScopeContributor } from "./types.ts";
import {
  ACTION_BLOCK, ACTION_DODGE, ACTION_CROUCH, ACTION_USE_SKILL,
  ACTION_JUMP, ACTION_CONSUME,
  ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4,
  hasAction,
} from "@voxim/protocol";
import { InputState } from "../components/game.ts";

export const inputContributor: SMScopeContributor = {
  namespace: "input",
  variables: [
    "input.use_skill", "input.block", "input.jump", "input.dodge",
    "input.crouch", "input.consume",
    "input.skill_1", "input.skill_2", "input.skill_3", "input.skill_4",
    "input.aim",
  ],
  contribute({ world, entityId }, scope) {
    const input = world.get(entityId, InputState);
    const a = input?.actions ?? 0;
    scope["input.use_skill"] = hasAction(a, ACTION_USE_SKILL);
    scope["input.block"]     = hasAction(a, ACTION_BLOCK);
    scope["input.jump"]      = hasAction(a, ACTION_JUMP);
    scope["input.dodge"]     = hasAction(a, ACTION_DODGE);
    scope["input.crouch"]    = hasAction(a, ACTION_CROUCH);
    scope["input.consume"]   = hasAction(a, ACTION_CONSUME);
    scope["input.skill_1"]   = hasAction(a, ACTION_SKILL_1);
    scope["input.skill_2"]   = hasAction(a, ACTION_SKILL_2);
    scope["input.skill_3"]   = hasAction(a, ACTION_SKILL_3);
    scope["input.skill_4"]   = hasAction(a, ACTION_SKILL_4);
    // No dedicated ACTION_AIM bit yet — wire the semantic alias as false so
    // transitions referencing it don't throw on undefined.
    scope["input.aim"] = false;
  },
};
