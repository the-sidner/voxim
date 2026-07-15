/**
 * Hitstop freeze set (T-296) — pure unit test of `collectHitStopFreezes`.
 * No live dispatcher/resolver stack: hand-built `ActiveActions` scratch
 * blobs (the exact shape `WeaponTraceResolver.resolve()` writes on a landed
 * hit) prove the freeze set contains attacker + target for exactly
 * `hitStopTicks` ticks and is empty once the window has elapsed — the same
 * pure-function test shape as `pickAimAssistTarget`'s suite.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { collectHitStopFreezes } from "./hitstop.ts";

const content = await JsonSource.load();

/** swing_heavy carries hitStopTicks: 5 (authored T-296). */
const HEAVY_HITSTOP_TICKS = content.actions.getOrThrow("swing_heavy").hitStopTicks;

Deno.test("T-296: swing_heavy declares a positive hitStopTicks", () => {
  assertEquals(HEAVY_HITSTOP_TICKS, 5);
});

Deno.test("T-296: an action with no hitStopTicks freezes nobody", () => {
  const world = new World();
  const attacker = newEntityId();
  world.create(attacker);
  world.write(attacker, ActorSlots, { slots: ["primary"] });
  world.write(attacker, ActiveActions, {
    states: {
      primary: {
        actionId: "primary_idle", // hitStopTicks absent
        phase: "hold", ticksInPhase: 1, initiator: "intent",
        scratch: { hitStopUntilTick: 999 }, // even if scratch somehow carried one
      },
    },
  });
  const frozen = collectHitStopFreezes(world, content, 1);
  assertEquals(frozen.size, 0, "no hitStopTicks on the action ⇒ never frozen, scratch or not");
});

Deno.test("T-296: attacker + target are frozen while the hitstop window is live, then released", () => {
  const world = new World();
  const attacker = newEntityId();
  const target = newEntityId();
  world.create(attacker);
  world.create(target);
  world.write(attacker, ActorSlots, { slots: ["primary"] });

  const enterTick = 10;
  const untilTick = enterTick + HEAVY_HITSTOP_TICKS!;
  world.write(attacker, ActiveActions, {
    states: {
      primary: {
        actionId: "swing_heavy",
        phase: "active", ticksInPhase: 0, initiator: "intent",
        scratch: {
          rewindTick: enterTick,
          hits: [{ entityId: target, bodyPart: "torso" }],
          hitStopUntilTick: untilTick,
          hitStopTargets: [{ entityId: target, untilTick }],
        },
      },
    },
  });

  // Still inside the window (serverTick < untilTick): both frozen.
  const midFrozen = collectHitStopFreezes(world, content, enterTick + 1);
  assertEquals(midFrozen.has(attacker), true, "attacker frozen mid-window");
  assertEquals(midFrozen.has(target), true, "target frozen mid-window");
  assertEquals(midFrozen.size, 2);

  // At exactly the window's last live tick.
  const lastLiveTick = untilTick - 1;
  const lastFrozen = collectHitStopFreezes(world, content, lastLiveTick);
  assertEquals(lastFrozen.has(attacker), true);
  assertEquals(lastFrozen.has(target), true);

  // Once serverTick reaches untilTick, the freeze has expired for both.
  const released = collectHitStopFreezes(world, content, untilTick);
  assertEquals(released.size, 0, "freeze released once serverTick reaches untilTick");
});

Deno.test("T-296: an entity with no ActiveActions is never frozen", () => {
  const world = new World();
  const bystander = newEntityId();
  world.create(bystander);
  const frozen = collectHitStopFreezes(world, content, 5);
  assertEquals(frozen.has(bystander), false);
});
