# Items-as-Entities Refactor — Plan

Tracks T-117. Collapses `ItemTemplate` into `Prefab`, moves every item behaviour
onto composable components, and makes every unique item in the simulation a
first-class entity. Stackable commodity items continue to live as `{ prefabId,
quantity }` inside inventory slots — they are interchangeable and don't justify
entities. Unique items (swords, armour, tomes, tools, crafted consumables with
per-instance state) become entities carrying their own components, including
optional history.

## Goal

Make `@voxim/engine` and `@voxim/tile-server` honour one declarative content
primitive and one runtime representation:

- **Prefab** is the template. It carries `components: Record<string, unknown>`
  validated against the component registry. Every "kind of thing that can
  exist" — a wolf, a workstation, a sword, a loaf of bread, a candle — is a
  prefab. Items are prefabs. No `ItemTemplate` struct exists.
- **Entity** is the runtime instance. Every non-stackable item in the
  simulation is an entity. Inventories and equipment hold entity IDs for
  uniques; stackable slots continue to hold `{ prefabId, quantity }`.

The payoff is a lean engine: one loader, one registry, one runtime model, one
save/load path, one wire format. Per-instance state (durability, inscriptions,
history, quality) becomes "components on the item-entity" — mutable at
runtime, serialised with the entity.

## Invariants we commit to

1. **No `ItemTemplate` type.** Its fields become components on a prefab. Every
   site that read `itemTemplate.X` now reads the corresponding component off
   the prefab (or, after Phase 3, off the item entity).
2. **Stackable items are compact, unique items are entities.** The
   discriminator is the `Stackable` component on the prefab. A prefab with
   `Stackable` produces `{ prefabId, quantity }` inventory slots; a prefab
   without it produces `{ entityId }` slots, each slot backed by a real World
   entity.
3. **AoI stays Position-driven.** Items in inventory have no `Position`; they
   never enter the spatial grid or the session AoI. The reverse index means
   they cost nothing in positional queries.
4. **No dual paths.** Following CLAUDE.md's refactor philosophy, each phase
   replaces the previous shape wholesale. No `itemTemplate_v2`, no "if
   (useItemEntities)" branches, no `@deprecated` bridges.
5. **Wire IDs stay stable for surviving components.** Networked components
   that keep their role (Inventory, Equipment, ItemData) keep their wireId.
   Retired components (if any) leave gaps — never reuse an id.

## Principles

1. **Composition over fields.** Behaviour is components, not properties. A
   chair has `Deployable` + `Composed`. A sword has `Equippable + Swingable +
   Composed`. Adding a new behaviour is a new component + a new system; it
   doesn't touch the prefab type.
2. **Template components are server-only by default.** Clients reconstruct
   template behaviour from the prefab id (client already has the prefab
   store). Instance components (Durability, Inscribed, History, Quality) live
   on the entity and are transferred as part of the entity's networked state
   when visible, or piggy-backed on inventory deltas when held.
3. **Lifecycle is by convention, not by type.** Some components are written
   only at spawn (Equippable.slot). Some are mutated at runtime (Durability).
   The engine doesn't enforce the distinction; systems do. We don't need a
   third `ComponentDef` variant — server-only components cover both lifecycles
   uniformly.
4. **Stack discriminator lives on the prefab.** A single `Stackable` component
   on a prefab is the signal. The spawner and crafting system check this when
   producing items: stackable → add to existing slot / open a new stack;
   unique → create a fresh entity.

## Surface area

Discovery pass (pre-plan grep) identified the following touch-points.

**Files that read ItemTemplate fields directly (13):**
`packages/content/src/item_templates_static.ts`,
`packages/content/src/store.ts`, `packages/content/src/loader.ts`,
`packages/content/src/types.ts`, `packages/content/mod.ts`,
`packages/tile-server/src/systems/crafting.ts`,
`packages/tile-server/src/systems/action.ts`,
`packages/tile-server/src/systems/consumption.ts`,
`packages/tile-server/src/systems/equipment.ts`,
`packages/tile-server/src/systems/encumbrance.ts`,
`packages/client/src/game.ts`,
`packages/client/src/render/renderer.ts`,
`packages/devtools/src/voxel-editor/content_loader.ts`.

**Files reading individual item fields (`equipSlot`, `weaponAction`, `toolType`,
`deploysTo`, `materialName`, `foodValue`, `waterValue`, `lightRadius`,
`lightColor`, `armorReduction`, etc.): 25 total, including every combat hit
handler, projectile system, animation system, plan_helpers, skeleton_evaluator,
and the codecs that serialise DerivedItemStats.**

**JSON data files affected:** 53 files in `packages/content/data/items/`. All
migrate to `packages/content/data/prefabs/items/` in Phase 2 with the new
component-based shape. Existing 44 files in `packages/content/data/prefabs/`
are untouched aside from any that declared `ItemTemplate`-shaped overrides.

**Engine core untouched.** `packages/engine/src/world.ts` and
`packages/engine/src/component.ts` need no changes — the reverse index and
`defineComponent()` already support everything we need. The refactor lives in
content + tile-server + client, not the engine.

---

## Phase 1 — Template component vocabulary (additive, non-breaking)

**Scope.** Introduce the full vocabulary of item-behaviour components. Wire
them into `component_registry.ts` so the prefab loader can validate them.
Nothing uses them yet — no JSON files declare them, no systems read them. This
is the foundation Phase 2 migrates onto.

**What changes.**

- New file `packages/tile-server/src/components/item_behaviours.ts` containing
  (at least) the following server-only component defs:
  - `Equippable { slot: EquipSlot }`
  - `Swingable { weaponActionId: string }`
  - `Tool { toolType: string }`
  - `Deployable { prefabId: string }`
  - `Edible { food: number, water: number, health: number, stamina: number }`
  - `Illuminator { radius: number, color: number, intensity: number, flicker: number }`
  - `Armor { reduction: number, staminaPenalty: number }`
  - `MaterialSource { materialName: string }`
  - `Composed { slots: ItemSlotDef[] }`
  - `Stackable {}` — marker
  - `Weight { baseWeight: number }`
  - `Renderable { modelId: string, scale: number }` (subsumes `Prefab.modelId`
    and `Prefab.modelScale` top-level fields; those top-level fields stay
    functional through Phase 1, removed in Phase 2.)

  Each def: inline `WireWriter`/`WireReader` codec, valibot schema, `default()`.

- Register every new def in
  `packages/tile-server/src/component_registry.ts` — append to `ALL_DEFS`.
  Deduplication by name is already enforced.

- Extend `packages/tile-server/src/prefab_validator.ts` if it needs
  per-component special handling (currently it validates shape-by-name via
  `DEF_BY_NAME`, so new components should "just work"; confirm).

**What doesn't change.**

- No JSON file is modified.
- No system reads any new component.
- `ItemTemplate` still exists and is still authoritative.
- Prefab top-level `modelId`/`modelScale` still work.

**Acceptance.**

- `deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts` clean.
- `deno task tile` starts, runs a tick, exits normally on SIGINT. No new warnings.
- Test: add a temporary `prefabs/items/_test_new_components.json` declaring
  `{ components: { equippable: {slot: "weapon"}, swingable: {weaponActionId: "slash"}, ... } }`
  and confirm the prefab loader validates it (remove the test file before landing).

**Rollback.** Revert the commit. Zero downstream impact — components are
unreferenced.

---

## Phase 2 — ItemTemplate → Prefab (breaking)

**Scope.** Delete `ItemTemplate`. Migrate every item JSON to a prefab JSON with
component-based declarations. Rewrite every reader to pull behaviour off the
prefab's components dict.

**What changes.**

- `packages/content/src/types.ts`: delete `ItemTemplate`, `ItemSlotDef`,
  `StatContribution`, `DerivedItemStats` as top-level exports. `ItemSlotDef`
  and `StatContribution` move inside `Composed`'s schema. `DerivedItemStats`
  becomes a runtime-only computed shape (no wire export — it was never on the
  wire anyway).
- `packages/content/src/store.ts`: remove `getItemTemplate`, add
  `getItemPrefab(id)` as a thin alias over `getPrefab` with an assertion that
  the prefab has at least one item-behaviour component. Producers of derived
  stats (weight with material density, damage from Swingable + Composed +
  materials) move into a new `deriveItemStats(prefab, parts)` helper.
- `packages/content/data/items/*.json`: **all 53 files moved** to
  `packages/content/data/prefabs/items/*.json` with the new shape:
  ```json
  {
    "id": "sword",
    "components": {
      "renderable": { "modelId": "sword_model", "scale": 1.0 },
      "weight": { "baseWeight": 1.5 },
      "equippable": { "slot": "weapon" },
      "swingable": { "weaponActionId": "slash" },
      "composed": { "slots": [ ... ] }
    }
  }
  ```
- `packages/content/src/loader.ts`: remove the `items/` loader branch. Prefabs
  under `prefabs/items/` load via the existing prefab loader.
- `packages/content/src/item_templates_static.ts`: delete. Client-side bundles
  re-use the existing static prefab aggregation if any, or a new
  `prefabs_static.ts` (whichever matches the current pattern for prefabs).
  Run `deno task gen-content` to regenerate.
- Every system listed in the surface-area grep migrates its field reads:
  - `equipSlot` → `prefab.components.equippable?.slot`
  - `weaponAction` → `prefab.components.swingable?.weaponActionId`
  - `toolType` → `prefab.components.tool?.toolType`
  - `deploysTo` → `prefab.components.deployable?.prefabId`
  - `materialName` → `prefab.components.materialSource?.materialName`
  - `stackable` → `prefab.components.stackable !== undefined` (marker)
  - `weight` → `prefab.components.weight?.baseWeight`
  - `foodValue/waterValue` → `prefab.components.edible?.food / .water`
  - `lightRadius/lightColor/lightIntensity/lightFlicker` → `prefab.components.illuminator?.*`
  - `armorReduction/staminaRegenPenalty` → `prefab.components.armor?.*`
  - `slots/baseStats` (for `Composed`) → `prefab.components.composed?.slots`
- `packages/tile-server/src/spawner.ts`: unchanged semantically — the prefab
  loader already walks the open-set components dict. Item-behaviour components
  installed into entities automatically as part of the existing flow.
- `packages/content/data/prefabs/*` (existing non-item prefabs): top-level
  `modelId` / `modelScale` fields rewritten to `components.renderable`. Files
  touched in the same commit as the rename of the top-level field.
- `packages/content/src/types.ts` `Prefab` interface: top-level `modelId` and
  `modelScale` **removed** — they live in `Renderable` now.

**What doesn't change in Phase 2.**

- Inventory and Equipment still hold `InventorySlot` with `{ itemType,
  quantity, parts?, condition?, fragmentId? }` — still compact data, no entity
  refs yet.
- Crafting system still spawns `ItemData` entities for dropped items using the
  existing path.
- Client-side render and prefab lookup unchanged conceptually; the client's
  own prefab store carries the new component shape.

**Acceptance.**

- `grep -r "ItemTemplate" packages/` returns zero matches.
- `deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts` clean.
- `deno task demo` — full server + client start, player can connect, craft a
  sword (still a compact-slot crafted item), equip it, swing it. Light items,
  food items, armour all work.
- `deno task gen-content` idempotent; generated files committed.
- Manual smoke test: every existing recipe produces output indistinguishable
  from before (stats, effects, visuals).

**Rollback.** Revert commit. Large diff, so revert is the only rollback.

---

## Phase 3 — Unique items become entities (breaking)

**Scope.** Flip the discriminator: unique items (prefabs without `Stackable`)
are entities in the World, referenced by entity id from inventory slots and
equipment. Stackables stay compact. Crafting system updated to pick the right
path based on the output prefab. Client sync updated to piggy-back instance
components on inventory deltas.

**What changes.**

- **`InventorySlot` (codec + type) becomes a discriminated union.** Two
  shapes:
  - `{ kind: "stack", prefabId: string, quantity: number }` — for stackables
    like ingots, logs, ammunition, grain.
  - `{ kind: "unique", entityId: EntityId }` — for uniques like swords,
    armour, tools, tomes. `parts`, `condition`, `fragmentId` are gone from
    the slot — they live as components on the referenced entity.
  The codec prefixes each slot with a 1-byte discriminator and branches.
- **`Inventory.slots` / `Equipment.*`** reshape: entity-ref slots reference
  entity ids. Equipment's per-slot type becomes `EntityId | null`; compact
  slots in Inventory retain their stackable form. Dangling-ref hygiene: when
  a referenced entity is destroyed, the Equipment/Inventory slot clears in a
  deferred hook registered by the equipment system.
- **`ItemData`** stays networked for world-dropped items; the component on a
  dropped unique-item entity now serves as "a label pointing at the prefab"
  (it may be reduced to just `prefabId` and lose `quantity`, since quantity
  is meaningless for uniques — stackable drops still spawn with quantity).
- **Spawner.** `spawnPrefab` already produces entities for all prefabs; the
  only new concern is "where does this entity live?" Unique items spawned
  *into inventory* get no `Position`; they just receive an `InInventory {
  ownerEntityId: EntityId }` component (new, server-only) so we can
  reverse-query "what items does this entity carry?"
- **New component `InInventory { ownerEntityId }`** — server-only, marks
  item-entities that are currently held. Absent on world-dropped items
  (replaced by `Position`). Mutually exclusive with `Position` by convention.
- **Crafting output path.** `systems/crafting.ts` + `crafting/util.ts`
  `spawnOutputNear()` branches on `Stackable` component presence:
  - stackable → add to existing stack in nearby inventory or spawn
    `{ kind: "stack", prefabId, quantity }` on ground as `ItemData`.
  - unique → spawn a new entity with all the prefab components, attach
    instance components that the recipe wrote into (parts as a `Composed`
    instance payload, optional quality stamp, optional inscription), and
    either place it into a nearby inventory or drop at the workstation.
- **Pickup/drop.** `Position`-having item entities can be picked up; they
  transition to `InInventory`, shed `Position`, and get written into the
  player's Inventory as a unique slot. Drop is the inverse.
- **Network delta for Inventory.** When a player's Inventory changes and a
  slot references a unique entity, the delta includes a per-entity snapshot
  of that entity's networked-or-client-relevant component data. Cleanest
  implementation: add a sibling networked field on `InventoryData`,
  `uniqueStates: Array<{ entityId, prefabId, instanceState: Uint8Array }>`,
  encoded with a light-weight per-entity codec. The client deserialises,
  looks up the prefab locally, and merges instance state for display.
  Alternative considered and rejected: "follow-entity" subscriptions — too
  much new complexity in AoI.
- **Save / load.** Container entities with inventories persist through save
  as entities; their inventory slot list (with entity-ref uniques) stashes
  the referenced entities. Save format gains a short uniques-list-per-owner.
  Player inventories are persisted on the account service, already
  per-player; each unique becomes a serialised blob (prefab id + instance
  components).

**What doesn't change.**

- AoI filter — Position-only.
- World API — all of this is just component writes/reads with the existing
  `world.set()` / `world.query()` mechanics.
- `@voxim/engine` core.

**Acceptance.**

- Crafting a sword writes a new entity to the player's Inventory slot as a
  unique ref; sword is equippable, swingable, retains its exact material-bind
  identity, and stats derive from its `Composed` component's `parts` instance
  state.
- Dropping the sword: entity transitions from `InInventory` + no-Position →
  `Position`, visible in world.
- Picking it up again (different player): entity transitions to new owner's
  `InInventory`; all instance components preserved including any mid-fight
  durability drop.
- Two swords crafted from identical recipes have different entity ids and
  independent mutable state.
- `deno task demo` end-to-end: login, craft, equip, fight, drop, pick up,
  log out, log back in, sword still in inventory with same entity-id-backed
  state (backed via account service serialisation round-trip).
- Entity-count stress test: script spawns 5000 item entities across NPC
  inventories; tick duration stays under 5 ms; per-session delta build under
  2 ms at full AoI saturation.
- `deno check` clean.

**Rollback.** Revert. Save-file incompatibility between pre- and post-Phase-3
is expected (we don't promise save compatibility across refactors —
CLAUDE.md's refactor philosophy).

---

## Phase 4 — Instance components (additive)

**Scope.** Add the instance-lifetime components that give the "every item is
unique" and "items carry history" stories their substance.

**What changes.**

- New components (server-only, server-mutated, some serialised to
  account-service when on player):
  - `Durability { remaining: number, max: number }` — ticks down on use. Item
    becomes "worn" below some fraction, unusable at 0. Managed by a new
    `DurabilitySystem` or by the relevant use-site systems.
  - `Inscribed { fragmentId: string }` — for tomes. Written at scribe
    workstation. Read at "read" interaction to grant the lore fragment to
    the reader.
  - `QualityStamped { quality: number }` — written at craft time from the
    producing workstation's `qualityTier` (a new field on the workstation
    prefab component). Read by stat derivation to scale final stats.
  - `History { events: HistoryEvent[] }` — optional; attached only to
    prefabs flagged as "noteworthy" (tomes, player-crafted weapons,
    relics). Capped length to bound memory.
  - `Owned { lineage: string[] }` — optional; for tracking named
    ownership. Event-driven updates on trade / inheritance.
- `deriveItemStats()` reads `QualityStamped` when present and multiplies
  relevant derived stats; absent defaults to 1.0.
- `scribeSystem.ts` (new or folded into existing lore system): the scribe
  desk workstation recipe writes `Inscribed` onto its output entity.
- `DurabilitySystem` (new): queries `Equipped` entities with `Durability`,
  decrements on use events. The decrement is an event subscription, not a
  per-tick walk.

**Acceptance.**

- Crafting at a high-`qualityTier` workstation produces items whose derived
  stats reflect the quality multiplier.
- A sword used for 100 swings has measurable durability loss; at 0
  durability it refuses to swing (or drops to unarmed behaviour).
- A tome passes through a scribe desk recipe → `Inscribed` component set →
  reading it at "read" interaction teaches the fragment.
- A named weapon preserves its `History` across drop/pickup and across
  cross-tile transfer.

**Rollback.** Revert. Each component is independent; individual components
can be shipped separately within this phase if desired.

---

## Phase 5 — Polish, benchmarks, cleanup

**Scope.** Finalisation: the stress benchmark, retirement of any transitional
scaffolding, documentation touch-up.

**What changes.**

- `packages/tile-server/bench/item_entity_stress.ts` — writes 5000 item
  entities, measures tick duration, delta build time, save size. CI-friendly
  output.
- CLAUDE.md updates:
  - New component composition section describing the Prefab / Entity
    unification.
  - Removed sections that reference `ItemTemplate` (the "Adding a networked
    component" section's item-specific bits).
- Delete any one-time migration helpers written during Phases 2/3.
- `TICKETS.md` — T-117 `Status: done` with the landing commit hash.

**Acceptance.**

- Benchmark output committed as a markdown report under `research/` or a
  new `bench/` dir.
- `grep -r "ItemTemplate" packages/` — zero matches (confirmed earlier,
  re-checked here).
- `grep -r "getItemTemplate" packages/` — zero matches.
- `deno task demo` green.
- Every chain in the research catalogue still has a clear mapping to the
  authoring model.

---

## Out of scope for T-117

Deferred to separate tickets:

- **GAP-ENV** — environmental prerequisites on recipes (retting ponds, solar
  salt). Touched by many item chains but not by the item-entity refactor.
- **GAP-STATE** — workstation internal state (woad vats, lime kilns).
  Orthogonal to item-entities.
- **GAP-BATCH** — multi-instance parallel recipes on one workstation. Builds
  on item-entities cleanly but is its own design.
- **Cross-tile item migration** beyond what account-service already gives us
  for players. Containers that move between tiles are out of scope.
- **Real-time item decay on the ground** (rotting food, rusting tools) —
  trivially added post-refactor via a per-component tick system.

## Dependencies and ordering

- Phase 1 is pure addition. Safe to land alone, buys forward compatibility.
- Phase 2 is a large atomic diff. Should not be split across commits because
  CLAUDE.md's refactor philosophy forbids the transitional shim state.
- Phase 3 is a second large atomic diff. Blocks Phase 4 fully (instance
  components are meaningless without item entities).
- Phases 4 and 5 are mostly additive on top of Phase 3.

Each breaking phase should be its own PR with all files touched in that
phase. Reviewers see the complete new shape, not a half-migration.

## Checkpoints and sign-off

- **After Phase 1 lands:** confirm the vocabulary reads correctly by
  hand-editing one prefab JSON to use components, validating, and reverting.
  Sign-off before Phase 2.
- **After Phase 2 lands:** full end-to-end smoke test; confirm every existing
  recipe still produces a working item. Sign-off before Phase 3.
- **After Phase 3 lands:** stress benchmark; confirm entity count budget
  holds. Sign-off before Phase 4.
- **After Phase 4 lands:** validate that "every item is unique" is
  demonstrable — two identical-recipe swords have different entity ids and
  can diverge in durability, quality, inscription, and history.
