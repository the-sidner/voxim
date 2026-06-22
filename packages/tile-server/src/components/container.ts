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
 * Server-only for now (no wire) — the deposit/withdraw UI is the deferred client
 * layer; networking is a later add, the same call buffs/modifiers/ActiveActions
 * made. `dynastyId` (stamped from the placer's Heritage on deploy) gates who may
 * store/withdraw; `kind` gates what may be stored.
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

export type ContainerKind = "tome" | "equipment";

/** One occupied slot — a ref to a unique item entity (never a stack). */
export interface ContainerSlot {
  entityId: string;
}

export interface ContainerData {
  /** What this chest accepts — library (tome) vs treasury (equipment). */
  kind: ContainerKind;
  /** Owning dynasty; "" until deploy stamps it from the placer's Heritage. */
  dynastyId: string;
  capacity: number;
  /** Dense list of occupied slots (length ≤ capacity); no holes. */
  slots: ContainerSlot[];
}

const containerCodec: Serialiser<ContainerData> = {
  encode(v: ContainerData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.kind);
    w.writeStr(v.dynastyId);
    w.writeU16(v.capacity);
    w.writeU16(v.slots.length);
    for (const s of v.slots) w.writeStr(s.entityId);
    return w.toBytes();
  },
  decode(b: Uint8Array): ContainerData {
    const r = new WireReader(b);
    const kind = r.readStr() as ContainerKind;
    const dynastyId = r.readStr();
    const capacity = r.readU16();
    const n = r.readU16();
    const slots: ContainerSlot[] = [];
    for (let i = 0; i < n; i++) slots.push({ entityId: r.readStr() });
    return { kind, dynastyId, capacity, slots };
  },
};

export const Container = defineComponent({
  name: "container" as const,
  networked: false,
  codec: containerCodec,
  default: (): ContainerData => ({ kind: "equipment", dynastyId: "", capacity: 12, slots: [] }),
});
