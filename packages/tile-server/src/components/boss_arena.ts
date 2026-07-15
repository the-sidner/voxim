/**
 * Bossfight POI runtime component (T-212 v2).
 *
 * `BossArenaLink` tags the boss NPC entity spawned by the `bossfight`
 * activity, correlating it back to its POI instance. `DeathSystem` runs
 * every registered `DeathHook` BEFORE destroying the dying entity (see
 * `systems/death.ts`) — the `boss_arena_unlock` hook reads this component
 * off the boss to log the clear and would find that POI's blocker
 * entities here, were `arenaRules.lockEntry` enforced (see the ticket note
 * on why it's data-only in v1: no entity-vs-entity collision substrate
 * exists in `PhysicsSystem` to make a spawned "blocker" prop actually
 * block movement).
 *
 * This is NOT wired through the Trigger primitive: `entity_died` triggers
 * bind roles by re-reading `TriggerSource`s off the dying entity during
 * TriggerSystem's buffered NEXT-tick drain — by then `DeathSystem` has
 * already `world.destroy()`-ed it (same tick, right after publishing
 * `EntityDied`), so `world.isAlive(ownerId)` at `trigger.ts`'s role-iteration
 * gate is false and the boss's owned triggers are silently never collected.
 * `DeathHook` is the doctrine-correct extension point for "read state
 * before destruction" (its own header comment says so) — same ergonomics
 * (one handler + one `register()` call), just synchronous instead of
 * event-buffered.
 *
 * Server-only: purely a bookkeeping join, never rendered directly.
 */

import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

export interface BossArenaLinkData {
  poiInstanceId: string;
  /** The POI def id (e.g. "ancient_arena") — the phase-adds TriggerSource
   * reads `arenaRules.addsTable` off this to pick the right adds-table
   * trigger set for THIS boss (bossNpcId aliases collide across bosses —
   * stone_construct/elder_treant/abyssal_serpent all resolve through the
   * same spawn-table stub bridge, so `poiDefId` is the only reliable
   * per-boss discriminator). */
  poiDefId: string;
}

export const BossArenaLink = defineComponent({
  name: "bossArenaLink" as const,
  networked: false,
  codec: {
    encode(v: BossArenaLinkData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      w.writeStr(v.poiDefId);
      return w.toBytes();
    },
    decode(b: Uint8Array): BossArenaLinkData {
      const r = new WireReader(b);
      return { poiInstanceId: r.readStr(), poiDefId: r.readStr() };
    },
  },
  default: (): BossArenaLinkData => ({ poiInstanceId: "", poiDefId: "" }),
});
