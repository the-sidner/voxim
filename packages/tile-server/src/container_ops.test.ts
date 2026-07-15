/**
 * Container store/withdraw + content/registry/codec (T-077/T-078).
 *
 * Pins the dynasty-chest primitive: deposit/withdraw MOVE a unique item entity
 * (never copy/destroy), gated on the chest's kind (library=tome, treasury=gear)
 * and owning dynasty, with capacity enforced. Plus: the new prefabs load, the
 * Container component is server-only + registered, and its codec round-trips.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { spawnPrefab } from "./spawner.ts";
import { Container } from "./components/container.ts";
import { Inventory, ItemData } from "./components/items.ts";
import type { InventorySlot } from "@voxim/codecs";
import { Heritage } from "./components/heritage.ts";
import { Inscribed, Durability } from "./components/instance.ts";
import { ModelRef } from "./components/game.ts";
import { storeInContainer, withdrawFromContainer } from "./systems/container.ts";
import { DEF_BY_NAME, NETWORKED_DEFS } from "./component_registry.ts";
import { ComponentType } from "@voxim/protocol";

const content = await JsonSource.load("packages/content/data");
const DYN = "dynasty-A";
const OTHER = "dynasty-B";

function deployChest(world: World, prefabId: string, dynastyId: string): string {
  const id = spawnPrefab(world, content, prefabId, { x: 0, y: 0, z: 0 });
  const c = world.get(id, Container)!;
  world.write(id, Container, { ...c, dynastyId });
  return id;
}
function makeActor(world: World, dynastyId: string, slots: InventorySlot[] = []): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Heritage, { dynastyId, generation: 0, traits: [] });
  world.write(id, Inventory, { slots, capacity: 20 });
  return id;
}
function makeUniqueItem(world: World, prefabId: string, extra?: (id: string) => void): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ItemData, { prefabId, quantity: 1 });
  extra?.(id);
  return id;
}

Deno.test("3a: owner + matching-kind store succeeds (tome into library)", () => {
  const w = new World();
  const lib = deployChest(w, "library_chest", DYN);
  const tome = makeUniqueItem(w, "tome", (id) => w.write(id, Inscribed, { fragmentId: "keen_edge" }));
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: tome }]);
  const r = storeInContainer(w, content, a, lib, tome);
  assert(r.ok, JSON.stringify(r));
  w.applyChangeset(); // store now defers via world.set (so the move ships as a delta)
  assertEquals(w.get(lib, Container)!.slots.map((s) => s.entityId), [tome]);
  assertEquals(w.get(a, Inventory)!.slots.length, 0, "item left the inventory");
  assert(w.isAlive(tome), "item entity itself is untouched");
});

Deno.test("3b: wrong-kind store rejected (equipment into a tome library)", () => {
  const w = new World();
  const lib = deployChest(w, "library_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  const r = storeInContainer(w, content, a, lib, sword);
  assert(!r.ok && r.reason === "wrong-kind", JSON.stringify(r));
  assertEquals(w.get(lib, Container)!.slots.length, 0);
  assertEquals(w.get(a, Inventory)!.slots.length, 1, "item stayed in inventory");
});

Deno.test("3c: wrong-dynasty actor rejected", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const a = makeActor(w, OTHER, [{ kind: "unique", entityId: sword }]);
  const r = storeInContainer(w, content, a, treas, sword);
  assert(!r.ok && r.reason === "wrong-dynasty", JSON.stringify(r));
});

Deno.test("3d: capacity enforced", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const c = w.get(treas, Container)!;
  w.write(treas, Container, { ...c, capacity: 1 });
  const s1 = makeUniqueItem(w, "iron_sword");
  const s2 = makeUniqueItem(w, "iron_sword");
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: s1 }, { kind: "unique", entityId: s2 }]);
  assert(storeInContainer(w, content, a, treas, s1).ok);
  w.applyChangeset(); // commit the first deposit so the second sees the chest full
  const r2 = storeInContainer(w, content, a, treas, s2);
  assert(!r2.ok && r2.reason === "container-full", JSON.stringify(r2));
  assertEquals(w.get(treas, Container)!.slots.length, 1);
});

Deno.test("3e: withdraw moves the ref back into the holder, instance comps intact", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword", (id) => w.write(id, Durability, { remaining: 42, max: 60 }));
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, a, treas, sword);
  w.applyChangeset(); // commit the deposit so the withdraw sees the banked slot
  const r = withdrawFromContainer(w, a, treas, 0, a);
  assert(r.ok, JSON.stringify(r));
  w.applyChangeset();
  assertEquals(w.get(treas, Container)!.slots.length, 0);
  assert(w.get(a, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === sword));
  assertEquals(w.get(sword, Durability)!.remaining, 42, "Durability rode along, untouched");
});

Deno.test("3f: withdraw rejects a wrong-dynasty actor and an out-of-range slot", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, a, treas, sword);
  w.applyChangeset();
  const intruder = makeActor(w, OTHER, []);
  assert(!withdrawFromContainer(w, intruder, treas, 0, intruder).ok, "wrong dynasty blocked");
  assert(!withdrawFromContainer(w, a, treas, 9, a).ok, "bad slot blocked");
});

Deno.test("3g: withdraw into a wrong-dynasty holder is rejected (no cross-dynasty siphon)", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const owner = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, owner, treas, sword);
  w.applyChangeset();
  // owner authorises, but the DESTINATION belongs to another dynasty.
  const outsider = makeActor(w, OTHER, []);
  const r = withdrawFromContainer(w, owner, treas, 0, outsider);
  assert(!r.ok && r.reason === "holder-wrong-dynasty", JSON.stringify(r));
  assertEquals(w.get(treas, Container)!.slots.length, 1, "item stayed banked");
});

Deno.test("3h: withdrawing a dead-entity slot purges it instead of handing out a dangling ref", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const a = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, a, treas, sword);
  w.destroy(sword);
  w.applyChangeset();
  const r = withdrawFromContainer(w, a, treas, 0, a);
  assert(!r.ok && r.reason === "slot-item-dead", JSON.stringify(r));
  w.applyChangeset(); // commit the dead-slot purge
  assertEquals(w.get(treas, Container)!.slots.length, 0, "dead slot purged");
  assertEquals(w.get(a, Inventory)!.slots.length, 0, "no dangling ref handed to the holder");
});

// ---- T-344: Container + Inventory are multi-writer (world.mutate, not get-then-set) ----
// A family chest is genuinely touched by MULTIPLE dynasty members' sessions
// in the same tick — the realistic race this ticket targets, more so than
// most single-player sites.

Deno.test("T-344: two different actors depositing into a chest with room for exactly one both call storeInContainer in the SAME tick — only one succeeds, Container never exceeds capacity", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const c = w.get(treas, Container)!;
  w.write(treas, Container, { ...c, capacity: 1 });
  const sword1 = makeUniqueItem(w, "iron_sword");
  const sword2 = makeUniqueItem(w, "iron_sword");
  const actor1 = makeActor(w, DYN, [{ kind: "unique", entityId: sword1 }]);
  const actor2 = makeActor(w, DYN, [{ kind: "unique", entityId: sword2 }]);

  // Both calls happen before EITHER commits — the same-tick shape.
  const r1 = storeInContainer(w, content, actor1, treas, sword1);
  const r2 = storeInContainer(w, content, actor2, treas, sword2);
  assert(r1.ok, JSON.stringify(r1));
  assert(r2.ok, "the synchronous pre-check is optimistic — both look ok before commit");
  w.applyChangeset();

  const chestSlots = w.get(treas, Container)!.slots;
  assertEquals(chestSlots.length, 1, "capacity never exceeded");
  const banked = chestSlots[0].entityId;
  // Whichever actor's item landed, it left THEIR inventory; the OTHER
  // actor's item declined and stayed with them — never duplicated, never lost.
  if (banked === sword1) {
    assertEquals(w.get(actor1, Inventory)!.slots.length, 0);
    assertEquals(w.get(actor2, Inventory)!.slots.length, 1, "the losing deposit's item stayed with its owner");
  } else {
    assertEquals(banked, sword2);
    assertEquals(w.get(actor2, Inventory)!.slots.length, 0);
    assertEquals(w.get(actor1, Inventory)!.slots.length, 1, "the losing deposit's item stayed with its owner");
  }
});

Deno.test("T-344: two different actors withdrawing DIFFERENT slots from the same chest in one tick both land (no index-based clobber)", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const swordA = makeUniqueItem(w, "iron_sword");
  const swordB = makeUniqueItem(w, "iron_sword");
  const owner = makeActor(w, DYN, [{ kind: "unique", entityId: swordA }, { kind: "unique", entityId: swordB }]);
  storeInContainer(w, content, owner, treas, swordA);
  storeInContainer(w, content, owner, treas, swordB);
  w.applyChangeset();
  assertEquals(w.get(treas, Container)!.slots.length, 2);

  const heir1 = makeActor(w, DYN, []);
  const heir2 = makeActor(w, DYN, []);
  // Same tick: withdraw slot 0 into heir1, slot 1 into heir2 — under the old
  // get-then-set both read the SAME 2-slot snapshot and both filtered
  // against it, so the SECOND write would clobber the FIRST's removal.
  const r1 = withdrawFromContainer(w, heir1, treas, 0, heir1);
  const r2 = withdrawFromContainer(w, heir2, treas, 1, heir2);
  assert(r1.ok && r2.ok, JSON.stringify([r1, r2]));
  w.applyChangeset();

  assertEquals(w.get(treas, Container)!.slots.length, 0, "both withdrawals composed — chest empty, not still holding one");
  assert(w.get(heir1, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === swordA));
  assert(w.get(heir2, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === swordB));
});

Deno.test("T-344: two same-tick withdraws into ONE holder with room for only one — the second declines and stays banked, never lost", () => {
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const swordA = makeUniqueItem(w, "iron_sword");
  const swordB = makeUniqueItem(w, "iron_sword");
  const owner = makeActor(w, DYN, [{ kind: "unique", entityId: swordA }, { kind: "unique", entityId: swordB }]);
  storeInContainer(w, content, owner, treas, swordA);
  storeInContainer(w, content, owner, treas, swordB);
  w.applyChangeset();

  // Holder has room for exactly one more item — both withdraw calls'
  // synchronous pre-checks see the SAME stale "room for one" snapshot
  // (neither has committed yet), so both look optimistically ok. The
  // Inventory (destination) mutate is what actually enforces capacity at
  // commit time, in program order — the second one sees the first's
  // already-applied append and correctly declines.
  const holder = makeActor(w, DYN, [{ kind: "stack", prefabId: "berries", quantity: 1 }]);
  w.write(holder, Inventory, { slots: w.get(holder, Inventory)!.slots, capacity: 2 });

  const r1 = withdrawFromContainer(w, owner, treas, 0, holder);
  const r2 = withdrawFromContainer(w, owner, treas, 1, holder);
  assert(r1.ok && r2.ok, "both pre-checks look ok before commit — the real gate is the mutate");
  w.applyChangeset();

  const holderSlots = w.get(holder, Inventory)!.slots;
  assertEquals(holderSlots.length, 2, "capacity never exceeded");
  const chestSlots = w.get(treas, Container)!.slots;
  assertEquals(chestSlots.length, 1, "exactly one withdrawal actually composed — the other's item is still banked, not lost");
});

Deno.test("T-344 adversarial: two DIFFERENT actors withdrawing the SAME slot in one tick — only one gets the item, never both", () => {
  // The bug this regression pins: destination-first COUPLED-DECLINE
  // (Inventory claims capacity first, Container's removal dependent)
  // gates on a resource that ISN'T actually contested between two
  // different withdrawers (each actor's own Inventory capacity has
  // nothing to do with the other actor), so both private-Inventory claims
  // could independently succeed before either Container-side identity
  // check ran — duplicating the item. This needs no contradictory
  // commands from one client; two ordinary family members each issuing
  // one normal withdraw is enough. Fixed via 3-closure claim/commit/
  // revert with Container (the genuinely shared resource) claiming first.
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const owner = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, owner, treas, sword);
  w.applyChangeset();
  assertEquals(w.get(treas, Container)!.slots.length, 1);

  const heir1 = makeActor(w, DYN, []);
  const heir2 = makeActor(w, DYN, []);
  // Both calls read the SAME pre-commit chest snapshot (slot 0 = sword) —
  // the same-tick shape.
  const r1 = withdrawFromContainer(w, heir1, treas, 0, heir1);
  const r2 = withdrawFromContainer(w, heir2, treas, 0, heir2);
  assert(r1.ok && r2.ok, "both pre-checks look ok before commit — the real gate is the mutate");
  w.applyChangeset();

  const heir1Has = w.get(heir1, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === sword);
  const heir2Has = w.get(heir2, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === sword);
  assert(heir1Has !== heir2Has, "exactly one heir got the item, never both (no duplication) and never neither (no loss)");
  assertEquals(w.get(treas, Container)!.slots.length, 0, "chest correctly shows the item gone, not duplicated back");
});

Deno.test("T-344 adversarial: withdraw reverts cleanly when the winning claimant's inventory turns out full", () => {
  // Container claims first now; if the destination Inventory then declines
  // (full), Container must revert — the item must not vanish. The holder
  // must pass the synchronous pre-check (room at READ time) so the revert
  // path — not the early `inventory-full` return — is what's exercised: a
  // same-tick writer PUSHED FIRST fills the last slot before the
  // withdraw's own Inventory-grant closure runs at commit.
  const w = new World();
  const treas = deployChest(w, "treasury_chest", DYN);
  const sword = makeUniqueItem(w, "iron_sword");
  const owner = makeActor(w, DYN, [{ kind: "unique", entityId: sword }]);
  storeInContainer(w, content, owner, treas, sword);
  w.applyChangeset();

  const holder = makeActor(w, DYN, [{ kind: "stack", prefabId: "berries", quantity: 1 }]);
  w.write(holder, Inventory, { slots: w.get(holder, Inventory)!.slots, capacity: 2 }); // room for one more, at read time
  w.mutate(holder, Inventory, (cur) =>
    cur.slots.length >= cur.capacity ? cur : { ...cur, slots: [...cur.slots, { kind: "stack" as const, prefabId: "coal", quantity: 1 }] });

  const r = withdrawFromContainer(w, owner, treas, 0, holder);
  assert(r.ok, "optimistic pre-check — real gate is the mutate");
  w.applyChangeset();

  const holderSlots = w.get(holder, Inventory)!.slots;
  assertEquals(holderSlots.length, 2, "capacity never exceeded");
  assert(holderSlots.some((s) => s.kind === "stack" && s.prefabId === "coal"), "the earlier same-tick writer's append landed");
  assert(!holderSlots.some((s) => s.kind === "unique" && s.entityId === sword), "sword did NOT land — holder ended up full by commit time");
  const chestSlots = w.get(treas, Container)!.slots;
  assertEquals(chestSlots.length, 1, "item reverted back into the chest, not lost");
  assertEquals(chestSlots[0].entityId, sword);
});

Deno.test("5a: chest/tome/kit prefabs load with the right wiring", () => {
  for (const id of ["tome", "blank_tome", "library_chest", "treasury_chest", "library_chest_kit", "treasury_chest_kit"]) {
    assert(content.prefabs.get(id), `${id} loads`);
  }
  // deno-lint-ignore no-explicit-any
  const kit = content.prefabs.get("treasury_chest_kit")!.components as any;
  assertEquals(kit.deployable.prefabId, "treasury_chest");
  // deno-lint-ignore no-explicit-any
  assertEquals((content.prefabs.get("treasury_chest")!.components as any).container.kind, "equipment");
});

Deno.test("5b: a chest spawns with Container + a visual shell", () => {
  const w = new World();
  const id = spawnPrefab(w, content, "library_chest", { x: 1, y: 2, z: 0 });
  const c = w.get(id, Container)!;
  assertEquals(c.kind, "tome");
  assertEquals(c.capacity, 24);
  assertEquals(c.slots.length, 0);
  assert(w.has(id, ModelRef), "got a renderable shell from modelId");
});

Deno.test("5c: Container is networked + registered (and ItemEffects too)", () => {
  assertEquals(DEF_BY_NAME.get("container"), Container);
  // T-284: Container went on the wire so the chest deposit/withdraw panel can mirror slots.
  assertEquals(Container.wireId, ComponentType.container);
  assert(NETWORKED_DEFS.some((d) => d.name === "container"), "on the wire now");
  assert(DEF_BY_NAME.has("itemEffects"), "ItemEffects registered (save-overlay regression guard)");
});

Deno.test("5d: container codec round-trips", () => {
  const cases = [
    { kind: "equipment" as const, dynastyId: "", capacity: 12, slots: [] },
    { kind: "tome" as const, dynastyId: "D1", capacity: 24, slots: [{ entityId: "a" }, { entityId: "b" }] },
  ];
  for (const v of cases) {
    assertEquals(Container.codec.decode(Container.codec.encode(v)), v);
  }
});
