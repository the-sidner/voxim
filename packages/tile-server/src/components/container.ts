/**
 * Container (T-077/T-078) — a deployed world fixture's slot store for UNIQUE
 * item entities: the family **library** (kind "tome") and **treasury** (kind
 * "equipment"). Unlike `WorkstationBuffer` (stack-only) the slots hold entity
 * refs, so each tome's `Inscribed` and each weapon's `Durability`/`QualityStamped`
 * are preserved per-instance.
 *
 * Persists across character death because the chest is its own world entity —
 * death destroys only the player; SaveManager round-trips the chest AND the
 * unique item entities its slots reference (the heritage of a dynasty outlives
 * any one heir).
 *
 * Networked (T-284): the chest streams its slots to the owning dynasty's client
 * so the deposit/withdraw panel mirrors contents reactively. The codec lives in
 * `@voxim/codecs` (client + server share it); `dynastyId` (stamped from the
 * placer's Heritage on deploy) gates who may store/withdraw, `kind` gates what.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { containerCodec, type ContainerData } from "@voxim/codecs";

export type { ContainerData, ContainerSlot, ContainerKind } from "@voxim/codecs";

export const Container = defineComponent({
  name: "container" as const,
  wireId: ComponentType.container,
  codec: containerCodec,
  default: (): ContainerData => ({ kind: "equipment", dynastyId: "", capacity: 12, slots: [] }),
});
