/**
 * BuffSpec (T-239) — the data a buff scene-graph child carries.
 *
 * A buff is a child entity of the buffed actor: it holds one `BuffSpec`
 * (the modifier it contributes), the `buff` ambient action (drives the
 * optional periodic `tickDelta`), and a `buff_timer` Resource (its
 * lifetime — `cross@0` → `expire_buff` → `destroySubtree`). The `buffs`
 * ModifierSource reads `BuffSpec` off the actor's children and yields one
 * `StatModifier`; no `ActiveEffects` list, no `BuffSystem`.
 *
 * Server-only: buffs are not networked yet (same call ActiveActions /
 * Resource made — networking is a later additive step; client drifted).
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface BuffSpecData {
  /** Stat the buff modifies, e.g. "moveSpeed", "damageDealt". */
  stat: string;
  /** "add" or "mul" — folded by `effective()`. */
  op: "add" | "mul";
  /** Modifier value (op-dependent: a summand or a factor). */
  value: number;
  /**
   * Per-tick HP delta for DoT/HoT buffs (negative = damage). 0 = a pure
   * stat-modifier buff (no periodic effect — the `buff` action's tick
   * no-ops). Per-tick, not per-second (accepted retune from the retired
   * BuffSystem's tickDeltaPerSec×dt — magnitude semantics, documented).
   */
  tickDelta: number;
}

const buffSpecCodec: Serialiser<BuffSpecData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.stat);
    w.writeStr(v.op);
    w.writeF32(v.value);
    w.writeF32(v.tickDelta);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    const stat = r.readStr();
    const op = r.readStr() as "add" | "mul";
    const value = r.readF32();
    const tickDelta = r.readF32();
    return { stat, op, value, tickDelta };
  },
};

export const BuffSpec = defineComponent({
  name: "buffSpec" as const,
  networked: false,
  codec: buffSpecCodec,
  default: (): BuffSpecData => ({ stat: "", op: "add", value: 0, tickDelta: 0 }),
});
