/**
 * CharacterStateMachine component.
 *
 * Per-actor runtime state for the CSM (T-182). Holds the current node and
 * elapsed time for every layer in the SM def referenced by `stateMachineId`.
 *
 * Universal across actors: players, NPCs, mobs, critters, animals all carry
 * this component if their prefab declares a `stateMachineId`. Read by
 * AnimationSystem for animation projection and by gameplay systems for mode
 * gating (e.g. ActionSystem checks `csm.right_hand.node == "idle"` before
 * admitting a swing).
 *
 * Networked so the client debug overlay can render the active SM node per
 * layer. The full layerStates payload is small (≈10 bytes per layer) and
 * only sent when nodes change, so it adds negligible bandwidth.
 *
 * Lifetime: installed at spawn for any prefab with stateMachineId; persists
 * for the entity's lifetime. Initial node per layer comes from the SM def.
 */

import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { characterStateMachineCodec } from "@voxim/codecs";
import type { CharacterStateMachineData } from "@voxim/codecs";

export type { CharacterStateMachineData } from "@voxim/codecs";

export const CharacterStateMachine = defineComponent({
  name: "characterStateMachine" as const,
  wireId: ComponentType.characterStateMachine,
  codec: characterStateMachineCodec,
  default: (): CharacterStateMachineData => ({ stateMachineId: "", layerStates: {} }),
});
