/**
 * ActionCooldowns component (T-260).
 *
 * Per-actor cooldown state for the action runtime: `remaining[id]` = ticks
 * before action `id` may start again; `gcd` = the global cooldown any
 * `triggersGcd` action raises (and is blocked by). The dispatcher is the
 * single writer: decrements at the top of its run, stamps in `start()` —
 * both via composing mutates (T-249). Cooldowns are per-ACTION, not
 * per-bar-slot (the WoW model: the spell is on cooldown, wherever bound).
 *
 * Networked (T-265): the skill bar draws cooldown sweeps from `remaining` +
 * `gcd`. Only churns during active cooldowns (a brief post-cast window).
 *
 * Same honest stance as `TriggerCooldowns`: per-instance N-counters don't
 * fit the single-named-scalar Resource primitive (recorded at T-248).
 */

import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { actionCooldownsCodec } from "@voxim/codecs";
import type { ActionCooldownsData } from "@voxim/codecs";

export type { ActionCooldownsData };

export const ActionCooldowns = defineComponent({
  name: "actionCooldowns" as const,
  wireId: ComponentType.actionCooldowns,
  codec: actionCooldownsCodec,
  default: (): ActionCooldownsData => ({ gcd: 0, remaining: {} }),
});
