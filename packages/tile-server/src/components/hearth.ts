/**
 * Hearth — a claim marker overlaid on a workstation prefab. Placing a hearth
 * anchors the owning player's respawn to this location: on heir login after
 * death the gateway routes back to the hearth's tile and the tile spawns
 * the new character at the hearth's position.
 *
 * Server-only. `requires: ["workstationTag"]` — hearths always sit on a
 * workbench. The "which dynasty owns this hearth" wiring lives outside the
 * component (currently: the player's hearthAnchor on the account record,
 * updated when the player deploys a hearth item).
 */
import { defineComponent } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface HearthData {
  /** World units; reserved for future territorial semantics. 0 = deploy point only. */
  claimRadius: number;
}

export const Hearth = defineComponent({
  name: "hearth" as const,
  networked: false,
  requires: ["workstationTag"],
  codec: {
    encode(v: HearthData): Uint8Array {
      const w = new WireWriter(); w.writeF32(v.claimRadius); return w.toBytes();
    },
    decode(b: Uint8Array): HearthData {
      const r = new WireReader(b); return { claimRadius: r.readF32() };
    },
  },
  default: (): HearthData => ({ claimRadius: 0 }),
});
