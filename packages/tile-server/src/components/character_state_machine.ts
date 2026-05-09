/**
 * CharacterStateMachine component (server-only).
 *
 * Per-actor runtime state for the CSM (T-182). Holds the current node and
 * elapsed time for every layer in the SM def referenced by `stateMachineId`.
 *
 * Universal across actors: players, NPCs, mobs, critters, animals all carry
 * this component if their prefab declares a `stateMachineId`. Read by
 * AnimationSystem for animation projection and by gameplay systems for mode
 * gating (e.g. ActionSystem checks `csm.combat.node == "idle"` before
 * admitting a swing).
 *
 * Lifetime: installed at spawn for any prefab with stateMachineId; persists
 * for the entity's lifetime. Initial node per layer comes from the SM def.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface CharacterStateMachineData {
  /** SM def id; matches a key on ContentService.stateMachines. */
  stateMachineId: string;
  /** Per-layer current node and elapsed seconds since entering it. */
  layerStates: Record<string, { node: string; elapsed: number }>;
}

const codec: Serialiser<CharacterStateMachineData> = {
  encode(v: CharacterStateMachineData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.stateMachineId);
    const entries = Object.entries(v.layerStates);
    w.writeU16(entries.length);
    for (const [layerId, s] of entries) {
      w.writeStr(layerId);
      w.writeStr(s.node);
      w.writeF32(s.elapsed);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): CharacterStateMachineData {
    const r = new WireReader(bytes);
    const stateMachineId = r.readStr();
    const count = r.readU16();
    const layerStates: Record<string, { node: string; elapsed: number }> = {};
    for (let i = 0; i < count; i++) {
      const layerId = r.readStr();
      const node = r.readStr();
      const elapsed = r.readF32();
      layerStates[layerId] = { node, elapsed };
    }
    return { stateMachineId, layerStates };
  },
};

export const CharacterStateMachine = defineComponent({
  name: "characterStateMachine" as const,
  networked: false,
  codec,
  default: (): CharacterStateMachineData => ({ stateMachineId: "", layerStates: {} }),
});
