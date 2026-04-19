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
  WireReader,
  WireWriter,
} from "@voxim/codecs";
import type {
  DurabilityData,
  InscribedData,
  QualityStampedData,
} from "@voxim/codecs";

export type { DurabilityData, InscribedData, QualityStampedData };

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
