/**
 * T-226b — posture migration parity.
 *
 * Proves the substrate path end-to-end and that retiring the CSM posture
 * layer didn't break humanoid_default:
 *
 *   1. JsonSource + the real contributor set compile humanoid_default and
 *      pass scope validation — i.e. the `csm.posture == crouched` →
 *      `posture.crouched` paramOverride rewrite resolves against the new
 *      `posture` contributor. (This is exactly what
 *      CharacterStateMachineSystem's constructor does at server boot.)
 *   2. ActionDispatcher + PostureIntentResolver + set_tag/clear_tag drive
 *      the Crouched tag from the ACTION_CROUCH input bit.
 *   3. The `posture` scope contributor re-exposes that tag as
 *      `posture.crouched` for the still-CSM-resident locomotion layer.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { SMScopeValue } from "@voxim/content";
import { ACTION_CROUCH } from "@voxim/protocol";
import { InputState } from "../components/game.ts";
import { Crouched } from "../components/tags.ts";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { CharacterStateMachineSystem } from "../systems/character_state_machine.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { postureContributor } from "../sm_scope/posture.ts";
import { ActionDispatcher, newGateRegistry, newEffectRegistry } from "./index.ts";
import { PostureIntentResolver } from "./intent.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";

Deno.test("humanoid_default compiles + scope-validates after posture retirement", async () => {
  const content = await JsonSource.load();
  // CharacterStateMachineSystem's constructor compiles every SM def and
  // runs validateStateMachineScope against DEFAULT_SM_SCOPE_CONTRIBUTORS
  // (which now includes postureContributor). Throws on a dangling scope
  // ref — e.g. if a `posture.crouched` paramOverride had no producer.
  new CharacterStateMachineSystem(content, new TickEventBuffer());
});

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

Deno.test("posture contributor mirrors the Crouched tag into posture.crouched", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  // deno-lint-ignore no-explicit-any
  const ctx = { world, entityId: id, content: {} as any, tickEvents: {} as any };

  const up: Record<string, SMScopeValue> = {};
  postureContributor.contribute(ctx, up);
  assertEquals(up["posture.crouched"], false);

  world.write(id, Crouched, {});
  const down: Record<string, SMScopeValue> = {};
  postureContributor.contribute(ctx, down);
  assertEquals(down["posture.crouched"], true);
});
