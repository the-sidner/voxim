import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Inventory, InteractCooldown, ItemData } from "../components/items.ts";
import { Inscribed } from "../components/instance.ts";
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

          // Consume one blank tome (stack slot)
          const blankSlot = inventory.slots.findIndex((s) =>
            s.kind === "stack" && s.prefabId === cfg.blankTomeItemType
          );
          if (blankSlot === -1) {
            log.debug("externalise failed: entity=%s no blank tome in inventory", entityId);
            continue;
          }

          const blank = inventory.slots[blankSlot] as Extract<typeof inventory.slots[0], { kind: "stack" }>;
          const newSlots = blank.quantity <= 1
            ? inventory.slots.filter((_, i) => i !== blankSlot)
            : inventory.slots.map((s, i) => i === blankSlot
                ? { kind: "stack" as const, prefabId: blank.prefabId, quantity: blank.quantity - 1 }
                : s);

          // Spawn a unique tome entity carrying the fragment
          const tomeId = newEntityId();
          world.create(tomeId);
          world.write(tomeId, ItemData, { prefabId: cfg.tomeItemType, quantity: 1 });
          world.write(tomeId, Inscribed, { fragmentId });

          world.set(entityId, Inventory, {
            ...inventory,
            slots: [...newSlots, { kind: "unique", entityId: tomeId }],
          });
          world.set(entityId, InteractCooldown, { remaining: cfg.externaliseConsumeTicks });

          log.info("externalised: entity=%s fragment=%s", entityId, fragmentId);
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
          const alreadyKnown = loreLoadout.learnedFragmentIds.includes(fragmentId);

          world.destroy(tomeEntityId);
          world.set(entityId, Inventory, {
            ...inventory,
            slots: inventory.slots.filter((_, i) => i !== slotIndex),
          });
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
          break;
        }
      }
    }
  }
}
