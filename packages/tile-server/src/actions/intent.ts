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
import { ACTION_CROUCH, ACTION_BLOCK, ACTION_USE_SKILL, hasAction } from "@voxim/protocol";
import type { ContentService, SwingableData } from "@voxim/content";
import { InputState } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { ActiveActions } from "../components/action.ts";
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
 *   - ACTION_USE_SKILL + slot free   → the equipped weapon's swing action
 *     (`swingable.swingActionId`, default `swing_light`; unarmed → light)
 *   - a swing already in flight      → null (don't disturb — the dispatcher
 *     runs its windup/active/winddown; combo-as-cancel-into is later)
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
