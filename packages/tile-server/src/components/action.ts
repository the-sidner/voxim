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

/**
 * PendingItemUse (T-240 Ph1) — a one-shot, server-only stimulus the
 * `UseItem` command writes to ask the `primary` slot to run the generic
 * `use_item` action. `PrimaryIntentResolver` consumes it one-shot (returns
 * `use_item`, removes the component — same shape as `PendingReaction`), so
 * a stale request never lingers. No payload in Ph1: the action acts on the
 * first usable inventory slot (the held `ACTION_CONSUME` quick-eat key
 * resolves to the same action with no component). Explicit per-slot
 * targeting lands in Ph2 with the `ItemEffects` data model, where the slot
 * can ride the action's `scratch` honestly — recorded here as a deliberate
 * Ph1 scope cut (the ticket's "RequestedAction({slot})" wording assumed a
 * param channel that the RequestedActions component does not have).
 */
export interface PendingItemUseData { _: 0 }

const pendingItemUseCodec: Serialiser<PendingItemUseData> = {
  encode() { return new Uint8Array(0); },
  decode() { return { _: 0 }; },
};

export const PendingItemUse = defineComponent({
  name: "pendingItemUse" as const,
  networked: false,
  codec: pendingItemUseCodec,
  default: (): PendingItemUseData => ({ _: 0 }),
});

/**
 * RequestedActions (T-234) — a per-slot "run this named action" channel an
 * NPC's behavior tree drives. The BT's `request_action` node writes
 * `slot → actionId`; NpcAiSystem rewrites this component each tick (a
 * stimulus, like InputState — stale requests don't linger); the
 * `RequestedActionIntentResolver` turns it into the slot's desired action
 * in the dispatcher. This lets data name *any* action for an NPC, not just
 * the handful reachable through the InputState action bits. Server-only:
 * the client mirrors NPC behaviour from the resulting ActiveActions, not
 * from the request itself.
 */
export interface RequestedActionsData { requests: Record<string, string> }

const requestedActionsCodec: Serialiser<RequestedActionsData> = {
  encode(v) {
    const w = new WireWriter();
    const entries = Object.entries(v.requests);
    w.writeU8(entries.length);
    for (const [slot, actionId] of entries) { w.writeStr(slot); w.writeStr(actionId); }
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    const n = r.readU8();
    const requests: Record<string, string> = {};
    for (let i = 0; i < n; i++) requests[r.readStr()] = r.readStr();
    return { requests };
  },
};

export const RequestedActions = defineComponent({
  name: "requestedActions" as const,
  networked: false,
  codec: requestedActionsCodec,
  default: (): RequestedActionsData => ({ requests: {} }),
});

/**
 * SwingChain (T-295 follow-up — combo wiring) — per-actor melee combo state.
 * The weapon's `swingable.chain` defines a sequence of `{light, heavy}`
 * WeaponActionDefs; each new swing advances `index` (mod chain length) so
 * consecutive attacks alternate animation + geometry. `heavy` records whether
 * THIS swing was charged (chargeMs >= heavyChargeMs) so animation + the
 * weapon_trace resolver agree on which variant to play/trace. `idleTicks`
 * counts ticks the primary slot has been idle; once it exceeds the combo
 * window the next swing resets to index 0 (the documented "chain resets when
 * the actor reaches idle" behaviour). Server-only — the chosen WeaponActionDef
 * reaches the client via AnimationState.weaponActionId, so the chain index
 * itself never needs to be networked.
 */
export interface SwingChainData { index: number; heavy: boolean; idleTicks: number }

const swingChainCodec: Serialiser<SwingChainData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeU16(v.index); w.writeU8(v.heavy ? 1 : 0); w.writeU16(v.idleTicks);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    return { index: r.readU16(), heavy: r.readU8() === 1, idleTicks: r.readU16() };
  },
};

export const SwingChain = defineComponent({
  name: "swingChain" as const,
  networked: false,
  codec: swingChainCodec,
  default: (): SwingChainData => ({ index: 0, heavy: false, idleTicks: 0 }),
});
