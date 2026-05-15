/**
 * Posture slot parity (T-226b, updated T-228 — the CSM is gone).
 *
 * ActionDispatcher + PostureIntentResolver + set_tag/clear_tag drive the
 * Crouched tag from the ACTION_CROUCH input bit.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { ACTION_CROUCH } from "@voxim/protocol";
import { InputState } from "../components/game.ts";
import { Crouched } from "../components/tags.ts";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { ActionDispatcher, newGateRegistry, newEffectRegistry } from "./index.ts";
import { PostureIntentResolver } from "./intent.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";

function postureRig() {
  const world = new World();
  const content = new (class {
    actions = {
      get: (id: string) =>
        ({
          upright: {
            id: "upright", kind: "ambient", slot: "posture",
            phases: { hold: { ticks: -1 } }, cancel: { hold: { into: ["any"] } },
            movement: { hold: "free" }, effects: [],
          },
          crouched: {
            id: "crouched", kind: "ambient", slot: "posture",
            phases: { hold: { ticks: -1 } }, cancel: { hold: { into: ["any"] } },
            movement: { hold: "free" },
            effects: [
              { phase: "hold:enter", kind: "set_tag", params: { tag: "crouched" } },
              { phase: "hold:exit", kind: "clear_tag", params: { tag: "crouched" } },
            ],
          },
        } as Record<string, unknown>)[id],
    };
    // deno-lint-ignore no-explicit-any
  })() as any;

  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  const d = new ActionDispatcher(content, newGateRegistry(), effects, PostureIntentResolver);

  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["posture"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, InputState, { seq: 0, timestamp: 0, facing: 0, movementX: 0, movementY: 0, actions: 0, chargeMs: 0, rttMs: 0 });
  return { world, d, id };
}

Deno.test("crouch input installs the Crouched tag; release clears it", () => {
  const { world, d, id } = postureRig();

  // No crouch held → posture slot runs `upright`, no tag.
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["posture"]?.actionId, "upright");
  assert(!world.has(id, Crouched));

  // Hold crouch → dispatcher cancels upright (cancel "any"), starts
  // `crouched`, whose hold:enter set_tag installs Crouched.
  world.write(id, InputState, { seq: 1, timestamp: 0, facing: 0, movementX: 0, movementY: 0, actions: ACTION_CROUCH, chargeMs: 0, rttMs: 0 });
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["posture"]?.actionId, "crouched");
  assert(world.has(id, Crouched), "Crouched tag set while crouch held");

  // Release → back to `upright`, crouched hold:exit clears the tag.
  world.write(id, InputState, { seq: 2, timestamp: 0, facing: 0, movementX: 0, movementY: 0, actions: 0, chargeMs: 0, rttMs: 0 });
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["posture"]?.actionId, "upright");
  assert(!world.has(id, Crouched), "Crouched tag cleared on release");
});

