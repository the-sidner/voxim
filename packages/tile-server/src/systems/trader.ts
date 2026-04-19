import type { World, EntityId } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { TraderInventory } from "../components/trader.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("TraderSystem");

export class TraderSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentStore) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().trade;

    const traders: Array<{ traderId: EntityId; x: number; y: number }> = [];
    for (const { entityId: traderId, position } of world.query(Position, TraderInventory)) {
      traders.push({ traderId, x: position.x, y: position.y });
    }
    if (traders.length === 0) return;

    const rangeSq = cfg.rangeWorldUnits * cfg.rangeWorldUnits;

    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;

      const interactCooldown = world.get(entityId, InteractCooldown);
      if (!interactCooldown || interactCooldown.remaining > 0) continue;

      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const traderId = nearestTrader(traders, pos.x, pos.y, rangeSq);
      if (traderId === null) continue;

      const traderInv = world.get(traderId, TraderInventory);
      if (!traderInv) continue;

      const inv = world.get(entityId, Inventory);
      if (!inv) continue;

      for (const cmd of commands) {
        if (cmd.cmd === CommandType.TradeBuy) {
          const slot = cmd.listingSlot;
          if (slot < 0 || slot >= traderInv.listings.length) continue;
          const listing = traderInv.listings[slot];

          if (listing.stock === 0) {
            log.debug("buy failed: entity=%s item=%s out of stock", entityId, listing.itemType);
            continue;
          }

          const coinCount = countItem(inv.slots, cfg.currencyItemType);
          if (coinCount < listing.buyPrice) {
            log.debug("buy failed: entity=%s item=%s need=%d coins have=%d",
              entityId, listing.itemType, listing.buyPrice, coinCount);
            continue;
          }

          const newSlots = deductItem(inv.slots, cfg.currencyItemType, listing.buyPrice);
          addItem(newSlots, listing.itemType, 1);
          world.set(entityId, Inventory, { ...inv, slots: newSlots });
          world.set(entityId, InteractCooldown, { remaining: cfg.cooldownTicks });

          if (listing.stock > 0) {
            const newListings = traderInv.listings.map((l, i) =>
              i === slot ? { ...l, stock: l.stock - 1 } : l,
            );
            world.set(traderId, TraderInventory, { listings: newListings });
          }

          log.info("buy: buyer=%s item=%s price=%d coins remaining=%d",
            entityId, listing.itemType, listing.buyPrice, coinCount - listing.buyPrice);
          events.publish(TileEvents.TradeCompleted, {
            buyerId: entityId, traderId, itemType: listing.itemType, quantity: 1,
            coinDelta: -listing.buyPrice,
          });
          break;
        }

        if (cmd.cmd === CommandType.TradeSell) {
          const slot = cmd.inventorySlot;
          if (slot < 0 || slot >= traderInv.listings.length) continue;
          const listing = traderInv.listings[slot];

          if (countItem(inv.slots, listing.itemType) < 1) {
            log.debug("sell failed: entity=%s item=%s not in inventory", entityId, listing.itemType);
            continue;
          }

          const newSlots = deductItem(inv.slots, listing.itemType, 1);
          addItem(newSlots, cfg.currencyItemType, listing.sellPrice);
          world.set(entityId, Inventory, { ...inv, slots: newSlots });
          world.set(entityId, InteractCooldown, { remaining: cfg.cooldownTicks });

          log.info("sell: seller=%s item=%s price=%d", entityId, listing.itemType, listing.sellPrice);
          events.publish(TileEvents.TradeCompleted, {
            buyerId: entityId, traderId, itemType: listing.itemType, quantity: 1,
            coinDelta: listing.sellPrice,
          });
          break;
        }
      }
    }
  }
}

function nearestTrader(
  traders: Array<{ traderId: EntityId; x: number; y: number }>,
  px: number, py: number, rangeSq: number,
): EntityId | null {
  let nearest: EntityId | null = null;
  let nearestDist = Infinity;
  for (const t of traders) {
    const dx = t.x - px; const dy = t.y - py;
    const d = dx * dx + dy * dy;
    if (d <= rangeSq && d < nearestDist) { nearestDist = d; nearest = t.traderId; }
  }
  return nearest;
}

function countItem(slots: InventorySlot[], prefabId: string): number {
  return slots
    .filter((s): s is Extract<InventorySlot, { kind: "stack" }> => s.kind === "stack" && s.prefabId === prefabId)
    .reduce((sum, s) => sum + s.quantity, 0);
}

function deductItem(slots: InventorySlot[], prefabId: string, amount: number): InventorySlot[] {
  let remaining = amount;
  return slots
    .map((s) => {
      if (s.kind !== "stack" || s.prefabId !== prefabId || remaining <= 0) return s;
      const take = Math.min(s.quantity, remaining);
      remaining -= take;
      return { ...s, quantity: s.quantity - take };
    })
    .filter((s) => s.kind !== "stack" || s.quantity > 0);
}

function addItem(slots: InventorySlot[], prefabId: string, quantity: number): void {
  const existing = slots.find((s): s is Extract<InventorySlot, { kind: "stack" }> =>
    s.kind === "stack" && s.prefabId === prefabId
  );
  if (existing) { existing.quantity += quantity; }
  else { slots.push({ kind: "stack", prefabId, quantity }); }
}
