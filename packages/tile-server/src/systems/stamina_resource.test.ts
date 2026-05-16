/**
 * Stamina as a Resource — regen path (T-238b).
 *
 * Real content (data/resources/stamina.json) + ResourceSystem + the real
 * modifier registry. The spend path is covered by dodge_roll.test.ts; this
 * locks regen, the per-entity max clamp, and the equipment_stat penalty.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Resource } from "../components/resource.ts";
import { Equipment } from "../components/equipment.ts";
import { ResourceSystem } from "./resource.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import { equipmentStatModifier } from "../resources/modifiers/equipment_stat.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };
const content = await JsonSource.load();

function sys(): ResourceSystem {
  const mods = newResourceModifierRegistry();
  mods.register(equipmentStatModifier);
  return new ResourceSystem(content, newResourceEffectRegistry(), mods, noDeaths);
}

function tick(s: ResourceSystem, w: World): void {
  s.run(w, new EventBus(), DT);
  w.applyChangeset();
}

Deno.test("stamina regens at the def rate and clamps at per-entity max", () => {
  const s = sys();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Resource, { values: { stamina: { value: 50, max: 100 } } });

  tick(s, w);
  // stamina.json rate 8/s, no equipment → +8 * 1/20 = +0.4
  assertEquals(Math.round(w.get(id, Resource)!.values.stamina.value * 100) / 100, 50.4);

  for (let i = 0; i < 200; i++) tick(s, w);
  assertEquals(w.get(id, Resource)!.values.stamina.value, 100); // clamped
});

Deno.test("equipment_stat modifier slows regen by the worn armour penalty", () => {
  const s = sys();
  const w = new World();

  // Bare actor: full 8/s.
  const bare = newEntityId();
  w.create(bare);
  w.write(bare, Resource, { values: { stamina: { value: 50, max: 100 } } });

  // Find an armour prefab that declares a staminaRegenPenalty, if any ship.
  let penaltyPrefab: string | null = null;
  let penalty = 0;
  for (const p of content.prefabs.values()) {
    const st = content.deriveItemStats(p.id) as unknown as { staminaRegenPenalty?: number };
    if (st.staminaRegenPenalty && st.staminaRegenPenalty > 0) {
      penaltyPrefab = p.id; penalty = st.staminaRegenPenalty; break;
    }
  }

  const armored = newEntityId();
  w.create(armored);
  w.write(armored, Resource, { values: { stamina: { value: 50, max: 100 } } });
  w.write(armored, Equipment, {
    weapon: null, offHand: null, head: null,
    chest: penaltyPrefab ? { entityId: newEntityId(), prefabId: penaltyPrefab } : null,
    legs: null, feet: null, back: null,
  });

  tick(s, w);
  const bareGain = w.get(bare, Resource)!.values.stamina.value - 50;
  const armGain = w.get(armored, Resource)!.values.stamina.value - 50;
  if (penaltyPrefab) {
    // (1 - penalty) scaling → strictly slower regen than bare.
    if (!(armGain < bareGain)) {
      throw new Error(`expected armoured regen ${armGain} < bare ${bareGain} (penalty ${penalty})`);
    }
  } else {
    // No penalty armour ships → modifier is a no-op; equal regen.
    assertEquals(armGain, bareGain);
  }
});
