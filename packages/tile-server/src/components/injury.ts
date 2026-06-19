/**
 * Injury (T-008) — persistent debuffs an actor accrues from severe hits, until
 * treated. A list of `{ typeId, severity }`; each `typeId` resolves to a stat
 * debuff in `game_config.injuries`. The `injury` ModifierSource turns them into
 * `StatModifier`s through the Status/Modifier `effective()` fold, so an injury
 * composes with equipment / encumbrance / buffs / species over one path.
 *
 * Server-only and unsaved — injuries are runtime combat state. Removed by the
 * treatment flow (T-009).
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface InjuryEntry {
  typeId: string;
  /** 1+ — a worse instance scales the debuff (and stacks with re-injury). */
  severity: number;
}

export interface InjuryData {
  injuries: InjuryEntry[];
}

const injuryCodec: Serialiser<InjuryData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeU8(v.injuries.length);
    for (const i of v.injuries) { w.writeStr(i.typeId); w.writeU8(i.severity); }
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    const n = r.readU8();
    const injuries: InjuryEntry[] = [];
    for (let i = 0; i < n; i++) injuries.push({ typeId: r.readStr(), severity: r.readU8() });
    return { injuries };
  },
};

export const Injury = defineComponent({
  name: "injury" as const,
  networked: false,
  codec: injuryCodec,
  default: (): InjuryData => ({ injuries: [] }),
});
