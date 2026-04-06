import type { World, EntityId } from "@voxim/engine";
import { ACTION_TRADE_BUY, ACTION_TRADE_SELL, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState, Position } from "../components/game.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { TraderInventory } from "../components/trader.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("TraderSystem");

export class TraderSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().trade;

    const wantBuy = new Set<EntityId>();
    const wantSell = new Set<EntityId>();

    for (const { entityId, inputState, interactCooldown } of world.query(InputState, InteractCooldown)) {
      if (interactCooldown.remaining > 0) continue;
      if (hasAction(inputState.actions, ACTION_TRADE_BUY)) wantBuy.add(entityId);
      if (hasAction(inputState.actions, ACTION_TRADE_SELL)) wantSell.add(entityId);
    }

    if (wantBuy.size === 0 && wantSell.size === 0) return;

    const traders: Array<{ traderId: EntityId; x: number; y: number }> = [];
    for (const { entityId: traderId, position } of world.query(Position, TraderInventory)) {
      traders.push({ traderId, x: position.x, y: position.y });
    }
    if (traders.length === 0) return;

    const rangeSq = cfg.rangeWorldUnits * cfg.rangeWorldUnits;

    for (const entityId of wantBuy) {
      const inputState = world.get(entityId, InputState)!;
      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const traderId = nearestTrader(traders, pos.x, pos.y, rangeSq);
      if (traderId === null) {
        log.debug("buy failed: entity=%s no trader in range", entityId);
        continue;
      }

      const traderInv = world.get(traderId, TraderInventory)!;
      const slot = inputState.interactSlot;
      if (slot < 0 || slot >= traderInv.listings.length) continue;
      const listing = traderInv.listings[slot];
      if (listing.stock === 0) {
        log.debug("buy failed: entity=%s item=%s out of stock", entityId, listing.itemType);
        continue;
      }

      const inv = world.get(entityId, Inventory);
      if (!inv) continue;

      const coinCount = countItem(inv.slots, cfg.currencyItemType);
      if (coinCount < listing.buyPrice) {
        log.debug("buy failed: entity=%s item=%s need=%d coins have=%d",
          entityId, listing.itemType, listing.buyPrice, coinCount);
        continue;
      }

      const newSlots = deductItem(inv.slots, cfg.currencyItemType, listing.buyPrice);
      addItem(newSlots, { itemType: listing.itemType, quantity: 1 });
      world.set(entityId, Inventory, { ...inv, slots: newSlots });
      world.set(entityId, InteractCooldown, { remaining: cfg.cooldownTicks });

      if (listing.stock > 0) {
        const newListings = traderInv.listings.map((l, i) => i === slot ? { ...l, stock: l.stock - 1 } : l);
        world.set(traderId, TraderInventory, { listings: newListings });
      }

      log.info("buy: buyer=%s item=%s price=%d coins remaining=%d",
        entityId, listing.itemType, listing.buyPrice, coinCount - listing.buyPrice);
      events.publish(TileEvents.TradeCompleted, {
        buyerId: entityId, traderId, itemType: listing.itemType, quantity: 1, coinDelta: -listing.buyPrice,
      });
    }

    for (const entityId of wantSell) {
      const inputState = world.get(entityId, InputState)!;
      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const traderId = nearestTrader(traders, pos.x, pos.y, rangeSq);
      if (traderId === null) continue;

      const traderInv = world.get(traderId, TraderInventory)!;
      const slot = inputState.interactSlot;
      if (slot < 0 || slot >= traderInv.listings.length) continue;
      const listing = traderInv.listings[slot];

      const inv = world.get(entityId, Inventory);
      if (!inv) continue;
      if (countItem(inv.slots, listing.itemType) < 1) {
        log.debug("sell failed: entity=%s item=%s not in inventory", entityId, listing.itemType);
        continue;
      }

      const newSlots = deductItem(inv.slots, listing.itemType, 1);
      addItem(newSlots, { itemType: cfg.currencyItemType, quantity: listing.sellPrice });
      world.set(entityId, Inventory, { ...inv, slots: newSlots });
      world.set(entityId, InteractCooldown, { remaining: cfg.cooldownTicks });

      log.info("sell: seller=%s item=%s price=%d", entityId, listing.itemType, listing.sellPrice);
      events.publish(TileEvents.TradeCompleted, {
        buyerId: entityId, traderId, itemType: listing.itemType, quantity: 1, coinDelta: listing.sellPrice,
      });
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

function countItem(slots: InventorySlot[], itemType: string): number {
  return slots.filter((s) => s.itemType === itemType).reduce((sum, s) => sum + s.quantity, 0);
}

function deductItem(slots: InventorySlot[], itemType: string, amount: number): InventorySlot[] {
  let remaining = amount;
  return slots
    .map((s) => {
      if (s.itemType !== itemType || remaining <= 0) return s;
      const take = Math.min(s.quantity, remaining);
      remaining -= take;
      return { ...s, quantity: s.quantity - take };
    })
    .filter((s) => s.quantity > 0);
}

function addItem(slots: InventorySlot[], item: InventorySlot): void {
  const existing = slots.find((s) => s.itemType === item.itemType && !s.fragmentId);
  if (existing) { existing.quantity += item.quantity; } else { slots.push(item); }
}
