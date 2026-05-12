/**
 * `equipped.*` / `weapon.*` scope variables — equipment-derived flags.
 *
 * `weapon.has_block` / `weapon.has_aim` are placeholder constants until
 * weapons declare capability tags on their prefab (`weapon.has_block` is
 * always true while any weapon is equipped, `weapon.has_aim` always false).
 * Authentic capability flags are a follow-up for T-198 / weapon-action work.
 */

import type { SMScopeContributor } from "./types.ts";
import { Equipment } from "../components/equipment.ts";

export const equipmentContributor: SMScopeContributor = {
  namespace: "equipped",
  variables: ["equipped.weapon", "weapon.has_block", "weapon.has_aim"],
  contribute({ world, entityId }, scope) {
    const eq = world.get(entityId, Equipment);
    const hasWeapon = !!eq?.weapon;
    scope["equipped.weapon"]  = hasWeapon;
    scope["weapon.has_block"] = hasWeapon;
    scope["weapon.has_aim"]   = false;
  },
};
