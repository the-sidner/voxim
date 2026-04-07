import type { World } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DynastySystem");

export class DynastySystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentStore) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().lore;

    for (const { entityId, interactCooldown, inventory, loreLoadout } of
        world.query(InteractCooldown, Inventory, LoreLoadout)) {
      if (interactCooldown.remaining > 0) continue;

      const commands = this._commands.get(entityId);
      if (!commands) continue;

      for (const cmd of commands) {
        if (cmd.cmd === CommandType.Externalise) {
          const fragIndex = cmd.fragIndex;
          if (fragIndex < 0 || fragIndex >= loreLoadout.learnedFragmentIds.length) continue;
          const fragmentId = loreLoadout.learnedFragmentIds[fragIndex];

          const blankSlot = inventory.slots.findIndex((s) => s.itemType === cfg.blankTomeItemType);
          if (blankSlot === -1) {
            log.debug("externalise failed: entity=%s no blank tome in inventory", entityId);
            continue;
          }

          const newSlots = [...inventory.slots];
          const blank = newSlots[blankSlot];
          if (blank.quantity <= 1) { newSlots.splice(blankSlot, 1); }
          else { newSlots[blankSlot] = { ...blank, quantity: blank.quantity - 1 }; }
          newSlots.push({ itemType: cfg.tomeItemType, quantity: 1, fragmentId });
          world.set(entityId, Inventory, { ...inventory, slots: newSlots });
          world.set(entityId, InteractCooldown, { remaining: cfg.externaliseConsumeTicks });

          log.info("externalised: entity=%s fragment=%s", entityId, fragmentId);
          events.publish(TileEvents.LoreExternalised, { entityId, fragmentId });
          break; // one lore action per tick
        }

        if (cmd.cmd === CommandType.Internalise) {
          const slotIndex = cmd.inventorySlot;
          if (slotIndex < 0 || slotIndex >= inventory.slots.length) continue;
          const tomeSlot = inventory.slots[slotIndex];
          if (tomeSlot.itemType !== cfg.tomeItemType || !tomeSlot.fragmentId) continue;

          const fragmentId = tomeSlot.fragmentId;
          const alreadyKnown = loreLoadout.learnedFragmentIds.includes(fragmentId);

          const newSlots = [...inventory.slots];
          if (tomeSlot.quantity <= 1) { newSlots.splice(slotIndex, 1); }
          else { newSlots[slotIndex] = { ...tomeSlot, quantity: tomeSlot.quantity - 1 }; }
          world.set(entityId, Inventory, { ...inventory, slots: newSlots });
          world.set(entityId, InteractCooldown, { remaining: cfg.externaliseConsumeTicks });

          if (!alreadyKnown) {
            world.set(entityId, LoreLoadout, {
              ...loreLoadout,
              learnedFragmentIds: [...loreLoadout.learnedFragmentIds, fragmentId],
            });
            log.info("internalised: entity=%s fragment=%s (now known)", entityId, fragmentId);
          } else {
            log.info("internalised: entity=%s fragment=%s (already known, tome consumed)", entityId, fragmentId);
          }

          events.publish(TileEvents.LoreInternalised, { entityId, fragmentId });
          break; // one lore action per tick
        }
      }
    }
  }
}
