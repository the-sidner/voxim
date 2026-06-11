/**
 * Intent resolvers (T-226b) — translate an actor's InputState into the
 * action each slot should be running this tick.
 *
 * `PostureIntentResolver` is the first: the posture slot wants `crouched`
 * while ACTION_CROUCH is held, `upright` otherwise. Players and NPCs share
 * it — both write the same `InputState` (input drain / NpcAiSystem). As
 * further CSM layers migrate, additional per-slot logic composes here
 * (locomotion by velocity, etc.); `CompositeIntentResolver` merges them.
 */

import type { World, EntityId } from "@voxim/engine";
import {
  ACTION_CROUCH, ACTION_BLOCK, ACTION_USE_SKILL, ACTION_CONSUME,
  ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4,
  hasAction,
} from "@voxim/protocol";
import type { ContentService, SwingableData } from "@voxim/content";
import { InputState, Health } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { ActiveActions, PendingReaction, PendingItemUse, RequestedActions } from "../components/action.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import type { IntentResolver } from "./dispatcher.ts";

export const PostureIntentResolver: IntentResolver = {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!slots.includes("posture")) return out;
    const a = world.get(entityId, InputState)?.actions ?? 0;
    out.set("posture", hasAction(a, ACTION_CROUCH) ? "crouched" : "upright");
    return out;
  },
};

/**
 * Primary slot (T-227) — the upper body. Replaces the CSM right_hand FSM:
 *
 *   - ACTION_BLOCK held              → `block` (held; sets the Blocking tag)
 *   - ACTION_CONSUME held, or a one-shot `PendingItemUse` (the `UseItem`
 *     command's stimulus) + slot free → `use_item` (the `slot_has_usable`
 *     precondition rejects it when there's nothing usable, so the slot just
 *     stays idle rather than playing a useless animation). The component is
 *     consumed one-shot here, same as `PendingReaction` below.
 *   - ACTION_USE_SKILL + slot free   → the equipped weapon's swing action
 *     (`swingable.swingActionId`, default `swing_light`; unarmed → light)
 *   - an active action in flight     → null (don't disturb — the dispatcher
 *     runs its phases; use_item/swing both run to completion this way)
 *   - otherwise                      → `primary_idle` (no animation layer;
 *     locomotion's full-body clip shows through)
 *
 * Players and NPCs share it (both write InputState).
 */
export class PrimaryIntentResolver implements IntentResolver {
  constructor(private readonly content: ContentService) {}

  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!slots.includes("primary")) return out;

    const a = world.get(entityId, InputState)?.actions ?? 0;
    const cur = world.get(entityId, ActiveActions)?.states["primary"]?.actionId;
    const swinging = !!cur && this.content.actions.get(cur)?.kind === "active";

    let want: string | null;
    if (hasAction(a, ACTION_BLOCK)) {
      want = "block";
    } else if ((hasAction(a, ACTION_CONSUME) || world.has(entityId, PendingItemUse)) && !swinging) {
      if (world.has(entityId, PendingItemUse)) world.remove(entityId, PendingItemUse); // one-shot
      want = "use_item";
    } else if (hasAction(a, ACTION_USE_SKILL) && !swinging) {
      const weaponPrefab = world.get(entityId, Equipment)?.weapon?.prefabId;
      const swingable = weaponPrefab
        ? this.content.prefabs.get(weaponPrefab)?.components["swingable"] as SwingableData | undefined
        : undefined;
      want = swingable?.swingActionId ?? "swing_light";
    } else if (swinging) {
      want = null;
    } else {
      want = "primary_idle";
    }
    out.set("primary", want);
    return out;
  }
}

/**
 * Skill bar (T-260b) — SKILL_N presses become primary-slot intent for the
 * slot's skill ActionDef. Composes AFTER PrimaryIntentResolver, so a skill
 * press overrides a swing press; the dispatcher then arbitrates like any
 * other action (cancel matrix, costs, per-action cooldown + GCD —
 * T-260a). Replaces SkillSystem.run: there is no separate skill
 * activation path any more.
 */
export const SkillIntentResolver: IntentResolver = {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!slots.includes("primary")) return out;
    const a = world.get(entityId, InputState)?.actions ?? 0;
    const loadout = world.get(entityId, LoreLoadout);
    if (!loadout) return out;
    const flags = [ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4];
    for (let i = 0; i < 4; i++) {
      if (!hasAction(a, flags[i])) continue;
      const actionId = loadout.skills[i];
      if (!actionId) continue;
      out.set("primary", actionId);
      break; // lowest pressed slot wins the tick
    }
    return out;
  },
};

/**
 * Reaction slot (T-228) — event-driven, not intent-driven. Replaces the
 * CSM `reaction` layer:
 *
 *   - Health ≤ 0                 → `death` (stable condition, interrupt 100)
 *   - `PendingReaction` present  → its action id (hit_front/back,
 *     stagger_light/heavy), consumed one-shot (component removed)
 *   - otherwise                  → null (slot empty, or a reaction running
 *     out its one-shot phase undisturbed)
 *
 * The damage path writes `PendingReaction`; reaction-kind actions carry
 * `interruptPriority` so a stagger preempts a flinch and death preempts
 * all. The stagger actions own their own gameplay now — they install the
 * `staggered` tag for their `play` phase (the action-lockout the
 * `not_staggered` precondition reads), so there's no separate Staggered
 * component or countdown system (T-232). Death is still DeathSystem.
 */
export const ReactionIntentResolver: IntentResolver = {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!slots.includes("reaction")) return out;
    const hp = world.get(entityId, Health);
    if (hp && hp.current <= 0) {
      out.set("reaction", "death");
      return out;
    }
    const pending = world.get(entityId, PendingReaction);
    if (pending && pending.actionId) {
      out.set("reaction", pending.actionId);
      world.remove(entityId, PendingReaction); // one-shot consume
      return out;
    }
    out.set("reaction", null);
    return out;
  },
};

/**
 * Named-action slot (T-234) — the data-driven NPC channel. A behavior
 * tree's `request_action` node sets `slot → actionId` on the entity's
 * `RequestedActions` component (via NpcAiSystem); this resolver turns it
 * into the slot's desired action. Composed last so a tree's explicit
 * request overrides the input-bit-derived intent (an NPC's signature move
 * beats its default swing). Players never carry RequestedActions, so this
 * is inert for them. Only requests for slots the actor declares apply.
 */
export const RequestedActionIntentResolver: IntentResolver = {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const reqs = world.get(entityId, RequestedActions)?.requests;
    if (!reqs) return out;
    for (const slot of slots) {
      const want = reqs[slot];
      if (want) out.set(slot, want);
    }
    return out;
  },
};

/** Merge several per-slot resolvers into one (later slots win on conflict). */
export class CompositeIntentResolver implements IntentResolver {
  constructor(private readonly parts: readonly IntentResolver[]) {}
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const p of this.parts) {
      for (const [slot, want] of p.resolve(world, entityId, slots)) out.set(slot, want);
    }
    return out;
  }
}
