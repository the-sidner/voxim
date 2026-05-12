/**
 * ManeuverLoadout component (server-only) — T-185.
 *
 * Per-actor binding from skill slot index (0..3, mapped to
 * ACTION_SKILL_1..ACTION_SKILL_4) to ManeuverDef id. Empty string means the
 * slot is unbound. ActionSystem reads this when a skill bit fires; the
 * binding lives on the actor so PCs and NPCs use the same path.
 *
 * Cooldowns deliberately live elsewhere (or are absent for the first cut)
 * — this component is purely the binding. A future loadout-management UI
 * lets the player rearrange slots; today the prefab installs them at spawn.
 *
 * Server-only: the client doesn't need to know which skill key fires which
 * maneuver. It just sends ACTION_SKILL_N bits; the server resolves and
 * the resulting Maneuver state surfaces via the (already-networked) CSM
 * + AnimationState components.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface ManeuverLoadoutData {
  /** Four slots. Empty string ⇒ unbound. Indices map to ACTION_SKILL_1..4. */
  slots: [string, string, string, string];
}

const codec: Serialiser<ManeuverLoadoutData> = {
  encode(v: ManeuverLoadoutData): Uint8Array {
    const w = new WireWriter();
    for (const id of v.slots) w.writeStr(id);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ManeuverLoadoutData {
    const r = new WireReader(bytes);
    return { slots: [r.readStr(), r.readStr(), r.readStr(), r.readStr()] };
  },
};

export const ManeuverLoadout = defineComponent({
  name: "maneuverLoadout" as const,
  networked: false,
  codec,
  default: (): ManeuverLoadoutData => ({ slots: ["", "", "", ""] }),
});
