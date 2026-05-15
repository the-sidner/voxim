/**
 * Action runtime components (T-226) — the substrate for the universal
 * behavior primitive (see ACTION_PRIMITIVE_PLAN.md).
 *
 *   ActorSlots   — the declared slot set for an actor (e.g. humanoid:
 *                  ["locomotion", "primary", "posture"]). Set once at spawn
 *                  from the actor template's `actorSlots`; never mutated.
 *                  The ActionDispatcher rejects any action whose `slot` the
 *                  actor does not declare.
 *
 *   ActiveActions — one entry per occupied slot: which action is running
 *                  there, its phase, ticks-in-phase, who initiated it, and
 *                  an opaque per-resolver scratch blob. Absence of a slot
 *                  key means nothing is running in that slot. The
 *                  ActionDispatcher is the only writer.
 *
 * Both are networked so the client's mirrored World can run the same
 * dispatch for prediction. Payloads are small and only re-sent when a slot's
 * state changes — same bandwidth profile as the CSM component they will,
 * across the arc, replace.
 *
 * Lifetime: installed at spawn for any actor prefab declaring `actorSlots`;
 * persists for the entity's lifetime. Nothing installs these yet — the
 * locomotion/posture migration (next phase) is the first writer.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { actorSlotsCodec, activeActionsCodec, WireWriter, WireReader } from "@voxim/codecs";
import type { ActorSlotsData, ActiveActionsData } from "@voxim/codecs";

export type { ActorSlotsData, ActiveActionsData, ActiveActionState } from "@voxim/codecs";

export const ActorSlots = defineComponent({
  name: "actorSlots" as const,
  wireId: ComponentType.actorSlots,
  codec: actorSlotsCodec,
  default: (): ActorSlotsData => ({ slots: [] }),
});

export const ActiveActions = defineComponent({
  name: "activeActions" as const,
  wireId: ComponentType.activeActions,
  codec: activeActionsCodec,
  default: (): ActiveActionsData => ({ states: {} }),
});

/**
 * PendingReaction (T-228) — a one-shot, server-only request that the damage
 * path writes to ask for an event-driven reaction action in the `reaction`
 * slot (hit_front/back, stagger_light/heavy). ReactionIntentResolver
 * consumes it (returns the id, removes the component). Death is derived
 * from health<=0 in the resolver, so it needs no PendingReaction.
 */
export interface PendingReactionData { actionId: string }

const pendingReactionCodec: Serialiser<PendingReactionData> = {
  encode(v) { const w = new WireWriter(); w.writeStr(v.actionId); return w.toBytes(); },
  decode(b) { return { actionId: new WireReader(b).readStr() }; },
};

export const PendingReaction = defineComponent({
  name: "pendingReaction" as const,
  networked: false,
  codec: pendingReactionCodec,
  default: (): PendingReactionData => ({ actionId: "" }),
});
