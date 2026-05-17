/**
 * Instance-lifetime components.
 *
 * These components live on unique item entities (the
 * `{ kind: "unique", entityId }` inventory slot form). They give each item
 * its own mutable identity: wear, authorship, quality, and provenance.
 *
 * Durability / Inscribed / QualityStamped are networked — the client needs
 * them to display durability bars, read tome fragments, and apply the
 * quality-scaled stat badge. AoI brings the unique item entity (and these
 * components along with it) into the holder's session via aoi.ts.
 *
 * History / Owned are server-only: the client never renders these directly
 * and they can be large. Surface them through a UI command response when the
 * UI is built, not over the delta stream.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import {
  durabilityCodec,
  inscribedCodec,
  qualityStampedCodec,
  statsCodec,
  provenanceCodec,
  WireReader,
  WireWriter,
} from "@voxim/codecs";
import type {
  DurabilityData,
  InscribedData,
  QualityStampedData,
  StatsData,
  ProvenanceData,
} from "@voxim/codecs";
import type { EffectSpec } from "@voxim/content";

export type { DurabilityData, InscribedData, QualityStampedData, StatsData, ProvenanceData };

// ---- Durability (networked) ----

export const Durability = defineComponent({
  name: "durability" as const,
  wireId: ComponentType.durability,
  codec: durabilityCodec,
  default: (): DurabilityData => ({ remaining: 100, max: 100 }),
});

// ---- Inscribed (networked) ----

export const Inscribed = defineComponent({
  name: "inscribed" as const,
  wireId: ComponentType.inscribed,
  codec: inscribedCodec,
  default: (): InscribedData => ({ fragmentId: "" }),
});

// ---- QualityStamped (networked) ----

export const QualityStamped = defineComponent({
  name: "qualityStamped" as const,
  wireId: ComponentType.qualityStamped,
  codec: qualityStampedCodec,
  default: (): QualityStampedData => ({ quality: 1 }),
});

// ---- Stats (networked) ----
// Per-instance numeric stats. Raw materials inherit values from their prefab
// declaration; crafted intermediates have values computed by the originating
// recipe's formula at craft completion. Stat keys are open strings — the
// recipe-graph validator (T-124) ensures every reference is producible.

export const Stats = defineComponent({
  name: "stats" as const,
  wireId: ComponentType.stats,
  codec: statsCodec,
  default: (): StatsData => ({}),
});

// ---- Provenance (networked) ----
// Records which prefab variant filled each role of the recipe that produced
// this item. Drives tooltip "made of yew_wood, with linen_yarn string" lines
// and the procedural display name.

export const Provenance = defineComponent({
  name: "provenance" as const,
  wireId: ComponentType.provenance,
  codec: provenanceCodec,
  default: (): ProvenanceData => ([]),
});

// ---- History (server-only) ----
// Ordered log of notable events (hits, trades, inscriptions) that happened to
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

// ---- Owned (server-only) ----
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

// ---- ItemEffects (server-only) ----
// Per-instance effect payload for *unique* items (T-240). Stackable items
// carry their `effects` on the prefab; a unique item's payload can differ
// per instance — this is where procedural generation writes the generated
// EffectSpec[] at spawn. `use_item`'s apply_item_effects reads this when the
// used slot is unique, else falls back to the prefab. Server-only: the
// client reconstructs nothing from it. params is opaque JSON.

export interface ItemEffectsData {
  effects: EffectSpec[];
}

export const ItemEffects = defineComponent({
  name: "itemEffects" as const,
  networked: false,
  codec: {
    encode(v: ItemEffectsData): Uint8Array {
      const w = new WireWriter();
      w.writeU8(v.effects.length);
      for (const e of v.effects) {
        w.writeStr(e.id);
        w.writeStr(e.params ? JSON.stringify(e.params) : "");
      }
      return w.toBytes();
    },
    decode(b: Uint8Array): ItemEffectsData {
      const r = new WireReader(b);
      const n = r.readU8();
      const effects: EffectSpec[] = [];
      for (let i = 0; i < n; i++) {
        const id = r.readStr();
        const p = r.readStr();
        effects.push(p.length > 0 ? { id, params: JSON.parse(p) } : { id });
      }
      return { effects };
    },
  },
  default: (): ItemEffectsData => ({ effects: [] }),
});
