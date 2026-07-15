import { assertThrows } from "jsr:@std/assert";
import { validateArmorCoversBones } from "./loader.ts";
import type { Prefab } from "./types.ts";

/**
 * T-223 — `armor.coversBones` boot-validation. Legs/feet are excluded from
 * `EQUIP_SLOT_PRIMARY_BONE` server-side (T-220: a scene-graph `Parent` edge
 * is 1:1, those slots cover multiple bones) — so an item equipped into one
 * of those slots has no graph-derivable attach point and MUST declare which
 * bones its `armorGrammar` should fan out onto, or the client renders
 * nothing for it.
 */

function makePrefab(components: Prefab["components"]): Prefab {
  return { id: "p", components };
}

Deno.test("validateArmorCoversBones: no armor component — no-op", () => {
  validateArmorCoversBones(makePrefab({ equippable: { slots: ["legs"] } }));
});

Deno.test("validateArmorCoversBones: single-bone slot (chest) without coversBones passes", () => {
  validateArmorCoversBones(makePrefab({
    equippable: { slots: ["chest"] },
    armor: { reduction: 0.2, staminaPenalty: 0.1, armorGrammar: "plate_armor_iron" },
  }));
});

Deno.test("validateArmorCoversBones: authored (non-grammar) chest armor passes", () => {
  validateArmorCoversBones(makePrefab({
    equippable: { slots: ["chest"] },
    armor: { reduction: 1 },
  }));
});

Deno.test("validateArmorCoversBones: legs slot WITH coversBones passes", () => {
  validateArmorCoversBones(makePrefab({
    equippable: { slots: ["legs"] },
    armor: {
      reduction: 0.12, staminaPenalty: 0.08,
      armorGrammar: "plate_armor_iron",
      coversBones: ["upper_leg_l", "upper_leg_r"],
    },
  }));
});

Deno.test("validateArmorCoversBones: legs slot WITHOUT coversBones throws", () => {
  assertThrows(
    () => validateArmorCoversBones(makePrefab({
      equippable: { slots: ["legs"] },
      armor: { reduction: 0.12, staminaPenalty: 0.08, armorGrammar: "plate_armor_iron" },
    })),
    Error,
    "coversBones is unset",
  );
});

Deno.test("validateArmorCoversBones: feet slot WITHOUT coversBones throws", () => {
  assertThrows(
    () => validateArmorCoversBones(makePrefab({
      equippable: { slots: ["feet"] },
      armor: { reduction: 0.05, staminaPenalty: 0.02, armorGrammar: "plate_armor_iron" },
    })),
    Error,
    "coversBones is unset",
  );
});

Deno.test("validateArmorCoversBones: coversBones without armorGrammar throws", () => {
  assertThrows(
    () => validateArmorCoversBones(makePrefab({
      equippable: { slots: ["legs"] },
      armor: { reduction: 0.12, staminaPenalty: 0.08, coversBones: ["upper_leg_l"] },
    })),
    Error,
    "without armor.armorGrammar",
  );
});

Deno.test("validateArmorCoversBones: abstract prefab (_-prefixed) is skipped", () => {
  // Would throw if not skipped — legs slot, armorGrammar set, no coversBones.
  validateArmorCoversBones({
    id: "_abstract_legs_armor",
    components: {
      equippable: { slots: ["legs"] },
      armor: { reduction: 0.12, staminaPenalty: 0.08, armorGrammar: "plate_armor_iron" },
    },
  });
});
