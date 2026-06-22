/**
 * Caravan (T-048) — the manifest carried by a caravan lead NPC: where it is
 * bound and what goods it carries.
 *
 * `destinationTileId` is the single source of truth the `caravanEscort` job
 * reads to pick the matching edge gate (a `GateLink` whose `destinationTileId`
 * agrees) and walk there. `goods` is the cargo the caravan delivers once the
 * cross-tile handoff lands (a follow-up — v1 only walks to the gate).
 *
 * Server-only: the caravan reads as an ordinary NPC on the wire (ModelRef /
 * Name); the manifest is a server-side bookkeeping concern, not presentation.
 * Mirrors `SpawnedFrom` — a small server-only component with an inline
 * WireWriter/WireReader codec, registered in ALL_DEFS.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface CaravanGood {
  itemType: string;
  quantity: number;
}

export interface CaravanData {
  destinationTileId: string;
  goods: CaravanGood[];
}

const caravanCodec: Serialiser<CaravanData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.destinationTileId);
    w.writeU16(v.goods.length);
    for (const g of v.goods) {
      w.writeStr(g.itemType);
      w.writeU16(g.quantity);
    }
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    const destinationTileId = r.readStr();
    const n = r.readU16();
    const goods: CaravanGood[] = [];
    for (let i = 0; i < n; i++) {
      goods.push({ itemType: r.readStr(), quantity: r.readU16() });
    }
    return { destinationTileId, goods };
  },
};

export const Caravan = defineComponent({
  name: "caravan" as const,
  networked: false,
  codec: caravanCodec,
  default: (): CaravanData => ({ destinationTileId: "", goods: [] }),
});
