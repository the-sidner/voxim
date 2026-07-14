import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Inscribed } from "../components/instance.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { findByIdentity, slotIdentity } from "../inventory_ops.ts";
import type { SlotIdentity } from "../inventory_ops.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DynastySystem");

export class DynastySystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentService) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().lore;

    for (const { entityId, inventory, loreLoadout } of
        world.query(Inventory, LoreLoadout)) {
      const commands = this._commands.get(entityId);
      if (!commands) continue;

      for (const cmd of commands) {
        if (cmd.cmd === CommandType.Externalise) {
          const fragIndex = cmd.fragIndex;
          if (fragIndex < 0 || fragIndex >= loreLoadout.learnedFragmentIds.length) continue;
          const fragmentId = loreLoadout.learnedFragmentIds[fragIndex];

          // Consume one blank tome (stack slot)
          const blankSlot = inventory.slots.findIndex((s) =>
            s.kind === "stack" && s.prefabId === cfg.blankTomeItemType
          );
          if (blankSlot === -1) {
            log.debug("externalise failed: entity=%s no blank tome in inventory", entityId);
            continue;
          }

          const blank = inventory.slots[blankSlot] as Extract<typeof inventory.slots[0], { kind: "stack" }>;
          const blankIdentity: SlotIdentity = { kind: "stack", prefabId: blank.prefabId };

          // Spawn a unique tome entity carrying the fragment. T-344
          // residual: unconditional/irreversible, ahead of the mutate
          // below — if it declines (the blank tome was already consumed
          // by a same-tick race), this entity is orphaned, never
          // referenced by any inventory. Same accepted class as
          // debug_commands.ts's _giveTrinket.
          const tomeId = newEntityId();
          world.create(tomeId);
          world.write(tomeId, ItemData, { prefabId: cfg.tomeItemType, quantity: 1 });
          world.write(tomeId, Inscribed, { fragmentId });

          // T-344: single component (both the blank's consumption and the
          // new tome's append land on this SAME entity's Inventory) —
          // AGGREGATE-RECHECK, re-locate the blank by identity against
          // commit-time state rather than trusting blankSlot literally.
          world.mutate(entityId, Inventory, (cur) => {
            const idx = findByIdentity(cur.slots, blankIdentity, blankSlot);
            if (idx === -1) return cur; // blank tome gone by commit time — the spawned tome above is orphaned
            const cs = cur.slots[idx] as Extract<InventorySlot, { kind: "stack" }>;
            const kept = cs.quantity <= 1
              ? cur.slots.filter((_, i) => i !== idx)
              : cur.slots.map((s, i) => (i === idx ? { ...cs, quantity: cs.quantity - 1 } : s));
            return { ...cur, slots: [...kept, { kind: "unique" as const, entityId: tomeId }] };
          });

          log.info("externalised: entity=%s fragment=%s", entityId, fragmentId);
          // T-344: optimistic — fires even if the mutate above declined,
          // matching the established pattern elsewhere in this codebase
          // (health_hit_handler.ts computes its decisions from the
          // pre-mutate local read too). Informational only (client log/UI
          // toast, see event_router.ts) — no gameplay state keys off it.
          events.publish(TileEvents.LoreExternalised, { entityId, fragmentId });
          break;
        }

        if (cmd.cmd === CommandType.Internalise) {
          const slotIndex = cmd.inventorySlot;
          if (slotIndex < 0 || slotIndex >= inventory.slots.length) continue;
          const tomeSlot = inventory.slots[slotIndex];
          if (tomeSlot.kind !== "unique") continue;

          const tomeEntityId = tomeSlot.entityId as EntityId;
          const itemData = world.get(tomeEntityId, ItemData);
          if (itemData?.prefabId !== cfg.tomeItemType) continue;

          const tomeData = world.get(tomeEntityId, Inscribed);
          if (!tomeData) continue;
          const fragmentId = tomeData.fragmentId;
          const alreadyKnown = loreLoadout.learnedFragmentIds.includes(fragmentId); // informational only — see the log line below

          // T-344: destroy stays eager/unconditional, but — uniquely among
          // the eager-destroy sites in this ticket — this one is provably
          // safe: no other system destroys, moves, or reads tome entities
          // via this path mid-tick, so the only way the captured tome slot
          // could be "gone" by commit time is an EARLIER Internalise op
          // THIS SAME TICK for THIS SAME tome (a replayed/duplicate
          // command) — a repeat world.destroy on an already-tombstoned id
          // is a no-op, so the residual is fully closed here, not just
          // accepted.
          world.destroy(tomeEntityId);

          const tomeIdentity: SlotIdentity = slotIdentity(tomeSlot);
          // T-344: COUPLED-DECLINE — Inventory (the tome's source, and the
          // only side with a real "is it still there" gate) is claimed
          // first; LoreLoadout's grant is dependent on that claim AND does
          // its own idempotency recheck, so two same-tick tomes carrying
          // the SAME fragment (or a replayed Internalise) learn it exactly
          // once while both tomes are still correctly consumed.
          let removed = false;
          world.mutate(entityId, Inventory, (cur) => {
            const idx = findByIdentity(cur.slots, tomeIdentity, slotIndex);
            if (idx === -1) return cur; // already consumed by an earlier same-tick Internalise of this tome
            removed = true;
            return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
          });
          world.mutate(entityId, LoreLoadout, (cur) => {
            if (!removed) return cur;
            if (cur.learnedFragmentIds.includes(fragmentId)) return cur;
            return { ...cur, learnedFragmentIds: [...cur.learnedFragmentIds, fragmentId] };
          });

          log.info("internalised: entity=%s fragment=%s (%s)", entityId, fragmentId,
            alreadyKnown ? "already known, tome consumed" : "now known");
          events.publish(TileEvents.LoreInternalised, { entityId, fragmentId });
          break;
        }
      }
    }
  }
}
