import type { World } from "@voxim/engine";
import { ACTION_EXTERNALISE, ACTION_INTERNALISE, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState } from "../components/game.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DynastySystem");

export class DynastySystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().lore;

    for (const { entityId, inputState, interactCooldown, inventory, loreLoadout } of
        world.query(InputState, InteractCooldown, Inventory, LoreLoadout)) {
      if (interactCooldown.remaining > 0) continue;

      if (hasAction(inputState.actions, ACTION_EXTERNALISE)) {
        const fragIndex = inputState.interactSlot;
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
        continue;
      }

      if (hasAction(inputState.actions, ACTION_INTERNALISE)) {
        const slotIndex = inputState.interactSlot;
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
      }
    }
  }
}
