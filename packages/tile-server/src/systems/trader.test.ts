/**
 * TraderSystem — TradeBuy/TradeSell (T-344).
 *
 * No test file existed for this system before. Real content (currency item
 * type comes from game_config.json's `trade` block). TraderSystem's own
 * per-entity command loop `break`s after the first matching command, so at
 * most one trade fires per player per tick BY DESIGN — the realistic
 * same-tick collision here is CROSS-entity (two different buyers hitting
 * one trader's listing) or cross-system (a trade settling while another
 * system also writes the buyer's Inventory this tick), not intra-command.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position } from "../components/game.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { TraderInventory } from "../components/trader.ts";
import type { TraderListing } from "../components/trader.ts";
import { TraderSystem } from "./trader.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();
const CURRENCY = content.getGameConfig().trade.currencyItemType;

function makeTrader(world: World, listings: TraderListing[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 0, y: 0, z: 0 });
  world.write(id, TraderInventory, { listings });
  return id;
}

function makePlayer(world: World, slots: InventorySlot[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 0.5, y: 0, z: 0 });
  world.write(id, Inventory, { slots, capacity: 20 });
  return id;
}

function coins(qty: number): InventorySlot {
  return { kind: "stack", prefabId: CURRENCY, quantity: qty };
}

/** Batches multiple (actor, command) pairs into one system.run() + one
 * applyChangeset — the same-tick shape T-344 targets. */
function runBatch(world: World, commands: Array<[actor: string, cmd: CommandPayload]>): void {
  const sys = new TraderSystem(content);
  const pending = new Map<string, CommandPayload[]>();
  for (const [actor, cmd] of commands) {
    const list = pending.get(actor) ?? [];
    list.push(cmd);
    pending.set(actor, list);
  }
  const ctx: TickContext = { spatial: null as unknown as TickContext["spatial"], pendingCommands: pending };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

Deno.test("buy: succeeds — coins deducted, item granted", () => {
  const w = new World();
  makeTrader(w, [{ itemType: "arrow", buyPrice: 5, sellPrice: 1, stock: 10 }]);
  const player = makePlayer(w, [coins(20)]);

  runBatch(w, [[player, { cmd: CommandType.TradeBuy, listingSlot: 0 }]]);

  const slots = w.get(player, Inventory)!.slots;
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "arrow" && s.quantity === 1));
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === CURRENCY && s.quantity === 15));
});

Deno.test("buy: declines cleanly on insufficient coins — no item granted, coins untouched", () => {
  const w = new World();
  makeTrader(w, [{ itemType: "arrow", buyPrice: 5, sellPrice: 1, stock: 10 }]);
  const player = makePlayer(w, [coins(4)]);

  runBatch(w, [[player, { cmd: CommandType.TradeBuy, listingSlot: 0 }]]);

  assertEquals(w.get(player, Inventory)!.slots, [coins(4)]);
});

Deno.test("sell: succeeds — item deducted, coins granted", () => {
  const w = new World();
  makeTrader(w, [{ itemType: "berries", buyPrice: 1, sellPrice: 8, stock: -1 }]);
  const player = makePlayer(w, [{ kind: "stack", prefabId: "berries", quantity: 3 }]);

  runBatch(w, [[player, { cmd: CommandType.TradeSell, listingSlot: 0 }]]);

  const slots = w.get(player, Inventory)!.slots;
  assertEquals(slots, [{ kind: "stack", prefabId: "berries", quantity: 2 }, coins(8)]);
});

Deno.test("sell: declines cleanly when the item isn't held", () => {
  const w = new World();
  makeTrader(w, [{ itemType: "berries", buyPrice: 1, sellPrice: 8, stock: -1 }]);
  const player = makePlayer(w, [coins(5)]);

  runBatch(w, [[player, { cmd: CommandType.TradeSell, listingSlot: 0 }]]);

  assertEquals(w.get(player, Inventory)!.slots, [coins(5)], "nothing sold, nothing paid");
});

Deno.test("T-344: a buy composes with a concurrent same-tick Inventory writer instead of clobbering it", () => {
  const w = new World();
  makeTrader(w, [{ itemType: "arrow", buyPrice: 5, sellPrice: 1, stock: 10 }]);
  const player = makePlayer(w, [coins(20)]);

  // TraderSystem's own command loop only fires one trade per player per
  // tick (break) — the realistic same-tick collision is a DIFFERENT system
  // also writing this player's Inventory the same tick (e.g. a crafting
  // pickup, a debug give). Simulate that directly via a second world.mutate
  // pushed alongside TraderSystem's own, committed together.
  const sys = new TraderSystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[player, [{ cmd: CommandType.TradeBuy, listingSlot: 0 } as CommandPayload]]]),
  };
  sys.prepare(0, ctx);
  sys.run(w, new EventBus(), 1 / 20);
  w.mutate(player, Inventory, (cur) => ({
    ...cur,
    slots: [...cur.slots, { kind: "stack" as const, prefabId: "berries", quantity: 1 }],
  }));
  w.applyChangeset();

  const slots = w.get(player, Inventory)!.slots;
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "arrow"), "the buy landed");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "berries"), "the concurrent writer's append also landed");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === CURRENCY && s.quantity === 15), "coins deducted exactly once");
});

Deno.test("T-344: two different buyers buying the LAST unit of stock in the same tick — exactly one succeeds, stock never goes negative, no duplication", () => {
  const w = new World();
  const traderId = makeTrader(w, [{ itemType: "rare_gem", buyPrice: 5, sellPrice: 1, stock: 1 }]);
  const buyer1 = makePlayer(w, [coins(20)]);
  const buyer2 = makePlayer(w, [coins(20)]);

  runBatch(w, [
    [buyer1, { cmd: CommandType.TradeBuy, listingSlot: 0 }],
    [buyer2, { cmd: CommandType.TradeBuy, listingSlot: 0 }],
  ]);

  assertEquals(w.get(traderId, TraderInventory)!.listings[0].stock, 0, "stock decremented exactly once, never negative");
  const got1 = w.get(buyer1, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === "rare_gem");
  const got2 = w.get(buyer2, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === "rare_gem");
  assert(got1 !== got2, "exactly one buyer received the gem — never both, never neither");

  // The winner paid; the loser kept their coins in full (never pays without receiving).
  const winner = got1 ? buyer1 : buyer2;
  const loser = got1 ? buyer2 : buyer1;
  assert(w.get(winner, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === CURRENCY && s.quantity === 15));
  assert(w.get(loser, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === CURRENCY && s.quantity === 20), "the loser's coins are untouched");
});

Deno.test("T-344: unlimited stock (-1 sentinel) never decrements, even with concurrent same-tick buyers", () => {
  const w = new World();
  const traderId = makeTrader(w, [{ itemType: "torch", buyPrice: 2, sellPrice: 1, stock: -1 }]);
  const buyer1 = makePlayer(w, [coins(20)]);
  const buyer2 = makePlayer(w, [coins(20)]);

  runBatch(w, [
    [buyer1, { cmd: CommandType.TradeBuy, listingSlot: 0 }],
    [buyer2, { cmd: CommandType.TradeBuy, listingSlot: 0 }],
  ]);

  assertEquals(w.get(traderId, TraderInventory)!.listings[0].stock, -1, "unlimited stock stays -1");
  assert(w.get(buyer1, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === "torch"));
  assert(w.get(buyer2, Inventory)!.slots.some((s) => s.kind === "stack" && s.prefabId === "torch"), "both buyers served — unlimited stock");
});
