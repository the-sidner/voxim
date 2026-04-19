/**
 * Instance-lifetime components — Phase 4 of T-117.
 *
 * These components live on unique item entities (the `{ kind: "unique", entityId }` slot
 * introduced in Phase 3). They give each item its own mutable identity: wear, authorship,
 * quality, and provenance. All are server-only — clients reconstruct display values from
 * the prefab; instance state is surfaced to the client only via inventory delta payloads
 * (future work, tracked in T-117 Phase 5).
 *
 * Components:
 *   Durability      — remaining uses before the item is worn out
 *   Inscribed       — lore fragment written into this item (tomes, relics)
 *   QualityStamped  — crafting-time quality tier (0–1); scales derived stats
 *   History         — capped sequence of notable events in this item's life
 *   Owned           — ordered lineage of owner dynasty IDs
 */
import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

// ---- Durability ----

export interface DurabilityData {
  remaining: number;
  max: number;
}

export const Durability = defineComponent({
  name: "durability" as const,
  networked: false,
  codec: {
    encode(v: DurabilityData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.remaining);
      w.writeF32(v.max);
      return w.toBytes();
    },
    decode(b: Uint8Array): DurabilityData {
      const r = new WireReader(b);
      return { remaining: r.readF32(), max: r.readF32() };
    },
  },
  default: (): DurabilityData => ({ remaining: 100, max: 100 }),
});

// ---- Inscribed ----
// A lore fragment encoded into this item — written at a scribe desk, read at "read"
// interaction to grant the fragment to the reader. Replaces the previous TomeData
// component: any unique item can be inscribed, not only tomes.

export interface InscribedData {
  fragmentId: string;
}

export const Inscribed = defineComponent({
  name: "inscribed" as const,
  networked: false,
  codec: {
    encode(v: InscribedData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.fragmentId);
      return w.toBytes();
    },
    decode(b: Uint8Array): InscribedData {
      const r = new WireReader(b);
      return { fragmentId: r.readStr() };
    },
  },
  default: (): InscribedData => ({ fragmentId: "" }),
});

// ---- QualityStamped ----
// Craft-time quality tier in the range 0–1 (1 = perfect).
// `deriveItemStats()` accepts an optional quality parameter to scale relevant stats.

export interface QualityStampedData {
  quality: number;
}

export const QualityStamped = defineComponent({
  name: "qualityStamped" as const,
  networked: false,
  codec: {
    encode(v: QualityStampedData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.quality);
      return w.toBytes();
    },
    decode(b: Uint8Array): QualityStampedData {
      const r = new WireReader(b);
      return { quality: r.readF32() };
    },
  },
  default: (): QualityStampedData => ({ quality: 1 }),
});

// ---- History ----
// An ordered log of notable events (hits, trades, inscriptions) that happened to
// this item. Capped at maxLength to bound memory — oldest events are discarded first.

export interface HistoryEvent {
  tick: number;
  type: string;
  detail?: string;
}

export interface HistoryData {
  events: HistoryEvent[];
  maxLength: number;
}

export const MAX_HISTORY_EVENTS = 50;

export const History = defineComponent({
  name: "history" as const,
  networked: false,
  codec: {
    encode(v: HistoryData): Uint8Array {
      const w = new WireWriter();
      w.writeU8(v.maxLength);
      w.writeU8(v.events.length);
      for (const e of v.events) {
        w.writeI32(e.tick);
        w.writeStr(e.type);
        w.writeU8(e.detail !== undefined ? 1 : 0);
        if (e.detail !== undefined) w.writeStr(e.detail);
      }
      return w.toBytes();
    },
    decode(b: Uint8Array): HistoryData {
      const r = new WireReader(b);
      const maxLength = r.readU8();
      const count = r.readU8();
      const events: HistoryEvent[] = [];
      for (let i = 0; i < count; i++) {
        const tick = r.readI32();
        const type = r.readStr();
        const hasDetail = r.readU8();
        const detail = hasDetail ? r.readStr() : undefined;
        events.push({ tick, type, ...(detail !== undefined ? { detail } : {}) });
      }
      return { events, maxLength };
    },
  },
  default: (): HistoryData => ({ events: [], maxLength: MAX_HISTORY_EVENTS }),
});

// ---- Owned ----
// Ordered lineage of owner dynasty IDs — most recent owner last. Optional:
// not all items track ownership. Added at first trade or inheritance event.

export interface OwnedData {
  lineage: string[];
}

export const Owned = defineComponent({
  name: "owned" as const,
  networked: false,
  codec: {
    encode(v: OwnedData): Uint8Array {
      const w = new WireWriter();
      w.writeU8(v.lineage.length);
      for (const id of v.lineage) w.writeStr(id);
      return w.toBytes();
    },
    decode(b: Uint8Array): OwnedData {
      const r = new WireReader(b);
      const count = r.readU8();
      const lineage: string[] = [];
      for (let i = 0; i < count; i++) lineage.push(r.readStr());
      return { lineage };
    },
  },
  default: (): OwnedData => ({ lineage: [] }),
});
