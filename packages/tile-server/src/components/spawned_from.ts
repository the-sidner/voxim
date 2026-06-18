/**
 * SpawnedFrom (T-251) — the prefab id an entity was spawned from.
 *
 * Stamped by `spawnPrefab` on every entity it produces. It is the single
 * primitive that makes an entity *re-completable*: given `{prefabId, position}`
 * any consumer can re-run the full spawn pipeline (visual shell, archetype
 * installers, server-only Resources) and then overlay the entity's mutable
 * runtime state — instead of raw-writing a saved subset of components and
 * losing everything the installers add (ModelRef/Hitbox/respawn Resource).
 *
 * Used by SaveManager (restart round-trip) and, later, the tile handoff
 * (T-256), which face the same "partial reconstruction" problem.
 *
 * Server-only: clients already learn an entity's identity from ModelRef /
 * ItemData; the prefab id is a server-side reconstruction key.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface SpawnedFromData {
  prefabId: string;
}

const spawnedFromCodec: Serialiser<SpawnedFromData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.prefabId);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    return { prefabId: r.readStr() };
  },
};

export const SpawnedFrom = defineComponent({
  name: "spawnedFrom" as const,
  networked: false,
  codec: spawnedFromCodec,
  default: (): SpawnedFromData => ({ prefabId: "" }),
});
