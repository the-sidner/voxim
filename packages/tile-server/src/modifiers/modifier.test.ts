/**
 * Status / Modifier substrate (T-239 phase 1) — inert.
 *
 * Locks the compose fold `(base + Σ add) × Π mul` and the two shipped
 * sources against real content. Nothing in the server reads `effective()`
 * yet; this is the T-238a-style substrate proof.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import {
  effective,
  newModifierSourceRegistry,
  type ModifierSource,
} from "./modifier.ts";
import { equipmentSource } from "./sources/equipment.ts";
import { encumbranceSource } from "./sources/encumbrance.ts";

const content = await JsonSource.load();

Deno.test("effective folds (base + Σ add) × Π mul across sources", () => {
  const reg = newModifierSourceRegistry();
  const a: ModifierSource = {
    id: "a",
    contribute: () => [
      { stat: "x", op: "add", value: 3 },
      { stat: "x", op: "mul", value: 0.5 },
      { stat: "other", op: "add", value: 99 },
    ],
  };
  const b: ModifierSource = {
    id: "b",
    contribute: () => [
      { stat: "x", op: "add", value: 2 },
      { stat: "x", op: "mul", value: 2 },
    ],
  };
  reg.register(a);
  reg.register(b);
  const w = new World();
  const id = newEntityId();
  w.create(id);
  // x: (base 1 + (3+2)) × (0.5 × 2) = 6 × 1 = 6 ; "other" ignored.
  assertEquals(effective(reg, { world: w, content, entityId: id }, "x", 1), 6);
  // unknown stat → base unchanged.
  assertEquals(effective(reg, { world: w, content, entityId: id }, "z", 7), 7);
});

Deno.test("equipment source emits armorReduction from a worn piece", () => {
  // Find an armour prefab that declares a reduction.
  let armorPrefab: string | null = null;
  let expected = 0;
  for (const p of content.prefabs.values()) {
    const s = content.deriveItemStats(p.id);
    if (s.armorReduction && s.armorReduction > 0) {
      armorPrefab = p.id;
      expected = s.armorReduction;
      break;
    }
  }

  const reg = newModifierSourceRegistry();
  reg.register(equipmentSource);
  const w = new World();
  const id = newEntityId();
  w.create(id);

  // Bare: no contribution → armorReduction stays at base 0.
  w.write(id, Equipment, {
    weapon: null, offHand: null, head: null, chest: null,
    legs: null, feet: null, back: null,
  });
  assertEquals(effective(reg, { world: w, content, entityId: id }, "armorReduction", 0), 0);

  if (armorPrefab) {
    w.write(id, Equipment, {
      weapon: null, offHand: null,
      chest: { entityId: newEntityId(), prefabId: armorPrefab },
      head: null, legs: null, feet: null, back: null,
    });
    // quality defaults to 1 (no QualityStamped on the slot entity).
    assertEquals(
      effective(reg, { world: w, content, entityId: id }, "armorReduction", 0),
      expected,
    );
  }
});

Deno.test("encumbrance source slows moveSpeed when overloaded", () => {
  const reg = newModifierSourceRegistry();
  reg.register(encumbranceSource);
  const w = new World();

  // Pick any prefab with positive weight.
  let heavyPrefab: string | null = null;
  let unit = 0;
  for (const p of content.prefabs.values()) {
    const wgt = content.deriveItemStats(p.id).weight;
    if (wgt > 0) { heavyPrefab = p.id; unit = wgt; break; }
  }
  assert(heavyPrefab, "content has at least one prefab with weight");

  const cfg = content.getGameConfig().encumbrance;

  // Light load (1 unit, well under the threshold) → no penalty (×1.0).
  const light = newEntityId();
  w.create(light);
  w.write(light, Inventory, {
    slots: [{ kind: "stack", prefabId: heavyPrefab!, quantity: 1 }],
    capacity: 99,
  });
  assertEquals(
    effective(reg, { world: w, content, entityId: light }, "moveSpeed", 1),
    1.0,
  );

  // Overloaded (weight ≥ maxCarryWeight) → clamped to minSpeedMultiplier.
  const qty = Math.ceil(cfg.maxCarryWeight / unit) + 5;
  const heavy = newEntityId();
  w.create(heavy);
  w.write(heavy, Inventory, {
    slots: [{ kind: "stack", prefabId: heavyPrefab!, quantity: qty }],
    capacity: 9999,
  });
  assertEquals(
    effective(reg, { world: w, content, entityId: heavy }, "moveSpeed", 1),
    cfg.minSpeedMultiplier,
  );
});
