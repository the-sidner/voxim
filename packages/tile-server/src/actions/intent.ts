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
import { ACTION_CROUCH, hasAction } from "@voxim/protocol";
import { InputState } from "../components/game.ts";
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
