# Voxim2 — Engineering Tickets

Each ticket is a self-contained unit of engineering work. Tickets are grouped by domain.

**Format:**
```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done   [Commit: <hash>]

What needs to be built and what "done" looks like.
```

Effort: **S** < half a day · **M** half–two days · **L** multi-day or architectural

---

## Combat

### T-001 · Wire `StateHistoryBuffer` into `ActionSystem` hit detection
Effort: M   Status: done   Commit: d4207dd

`ActionSystem` currently resolves hits against current world state. The buffer exists but is unused.
On swing entering active phase, rewind target position/facing to `serverTick - rttTicks` using the
buffer and evaluate the hit against that historical snapshot.
Done when: hit detection uses rewound state; RTT estimate drives rewind depth.

### T-002 · Parry window detection in `ActionSystem`
Effort: M   Status: done   Commit: 1a12c4b

HealthHitHandler: `blockHeldTicks < parryWindowTicks` (dodge config) triggers parry path.
Emits `DamageDealt { blocked: true, amount: 0 }` (no separate ParrySuccess event needed).

### T-003 · Stagger state from parry
Effort: S   Status: done   Commit: 1a12c4b

HealthHitHandler sets `staggerTicksRemaining: dodgeCfg.staggerTicks` on attacker.
DodgeSystem decrements each tick; ActionSystem gates swing initiation on stagger === 0.

### T-004 · Counter-attack window + bonus damage
Effort: S   Status: done   Commit: 1a12c4b

Parry sets `counterReady: true` on defender's CombatState. Next hit from that entity
applies `counterDamageMultiplier` and clears the flag. Window is open-ended (one hit).

### T-005 · Directional blocking — facing check in hit resolution
Effort: S   Status: done   Commit: 1a12c4b

HealthHitHandler: `angleDiff(incomingAngle, targetSnapshotFacing) <= blockArcHalfRadians`
(π/2 = 90° half-arc). Stamina-exhausted defenders cannot block. Rear/side hits land through.

### T-006 · Ranged weapon action type + projectile spawning
Effort: M   Status: done   Commit: b6cf296

Add `"ranged"` action type to `weapon_actions.json` schema. On action activation, spawn a
projectile entity with `Velocity` in facing direction, `Lifetime`, and `Damage` components.
Projectile travels until lifetime expires or it hits an entity/terrain.
Done when: firing a bow spawns a projectile that deals damage on contact.

### T-007 · Bow/crossbow item templates + facing-based aim
Effort: S   Status: done   Commit: b6cf296

Add bow and crossbow entries to `item_templates.json` with `weaponAction: "ranged_bow"` /
`"ranged_crossbow"`. No zoom — aim is entirely facing-driven (same system as melee).
Done when: equipping a bow uses ranged action; facing determines projectile direction.

### T-008 · Injuries — permanent debuffs from severe damage
Effort: M   Status: todo

When a single hit deals damage exceeding a configurable threshold, roll for an injury.
Write an injury component (type, severity) that applies a stat debuff until treated.
Example injury types: `broken_limb` (reduced speed/attack), `deep_wound` (slow health drain).
Done when: severe hits can produce injury components that apply persistent debuffs.

### T-009 · Injury treatment via supernatural/alchemy workstation
Effort: S   Status: todo

Add a `treat_injury` recipe type to the supernatural/alchemy crafting stations. Using it
removes the injury component from the target entity.
Done when: the correct crafting interaction removes an active injury component.

### T-119 · Replace `ResolveStrikePort` with a deferred `StrikeLanded` event
Effort: S   Status: done   Commit: a8e15ff

`HealthHitHandler` calls `this.strikes.resolveStrike(...)` synchronously during
damage resolution — a cross-system reach through a "port" interface. The docstring
acknowledges it violates the "deferred events for cross-system reactions"
invariant. Replace with an event.

Shape:
  - Add `TileEvents.StrikeLanded { casterId: EntityId; slot: number; targetId: EntityId }`
    to the tile event surface in `@voxim/protocol` (server-only — does not
    cross the wire as a GameEvent).
  - `HealthHitHandler` publishes the event to its `EventEmitter` when a hit
    connects and `SkillInProgress.pendingSkillVerb` starts with `"strike:"`.
  - `SkillSystem` subscribes to it in a new `subscribe(bus)` hook called once
    at construction; the subscriber calls the existing `resolveStrike` method.
    Writes land in the next tick's changeset — 50ms at 20Hz, below perceptible
    for stamina/cooldown/effect feedback.
  - Delete `events/resolve_strike.ts` and the `ResolveStrikePort` interface.
    `SkillSystem` no longer implements it; `HealthHitHandler`'s constructor
    drops the `strikes` parameter.

Done when: no file references `ResolveStrikePort`; strike skills still fire on
hit (stamina deducted, cooldown set, effect applied on the tick after impact);
the system pipeline has one fewer cross-system call.

### T-120 · Split `CombatState` into presence-as-flag components
Effort: M   Status: done   Commit: ac8f398

`CombatState` packs five counters/flags into one always-present component —
`blockHeldTicks`, `staggerTicksRemaining`, `counterReady`, `iFrameTicksRemaining`,
`dodgeCooldownTicks`. Most entities have zero values for most counters most
of the time, but the component ticks through the delta stream whenever any
one changes. Follow `SkillInProgress`'s canonical shape: presence = state.

Split into:
  - `Staggered { ticksRemaining: u8 }` — present only during stagger.
  - `CounterReady` — zero-data marker; present after a parry until the next hit.
  - `IFrameActive { ticksRemaining: u8 }` — present during dodge i-frames.
  - `BlockHeld { ticks: u16 }` — present while ACTION_BLOCK is held;
    counts ticks for parry-window detection.
  - `DodgeCooldown { ticksRemaining: u8 }` — present during cooldown.

DodgeSystem, ActionSystem, HealthHitHandler, and the dodge components already
read `CombatState` — each read site updates to `world.get/has` on the
specific component. New components added to `NETWORKED_DEFS` (or server-only
where clients don't need them — iFrame and dodge cooldown are probably
server-only; stagger and counterReady likely need to reach the client for
animation).

Delete `CombatState`, its codec, and the `combatState` entry in `NETWORKED_DEFS`
in the same commit. Assign fresh `ComponentType` wire IDs for the new
networked components; mark the old `combatState` slot retired with a comment.

Done when: `grep -r "CombatState\|combatState" packages/` returns zero hits
outside the retired-slot comment and migration notes; combat still produces
correct stagger, counter, i-frame, block-timing, and dodge-cooldown behaviour.

---

## Networking & Client Prediction

### T-010 · Entity interpolation for remote entities
Effort: M   Status: done   Commit: pre-existing

Remote entities (other players, NPCs) currently snap to last received position. Maintain a two-
snapshot buffer per remote entity on the client. Render at a fixed delay (~100ms), interpolating
position and facing between the two buffered snapshots.
Done when: remote entities move smoothly; no snapping visible under normal latency.

### T-011 · Client-side prediction replay loop
Effort: L   Status: done   Commit: e6ac868

Client currently waits for server state for own entity position. Apply own inputs immediately
client-side. On receiving `ack_input_seq`, discard acknowledged inputs and replay remaining
unacknowledged inputs on top of the server-authoritative position.
Done when: own movement is instant locally; server corrections are applied without visible snap
under normal latency.

### T-012 · Reconciliation smoothing
Effort: M   Status: done   Commit: dfa1313

Decide and implement correction strategy: interpolate toward server position for small divergences
(< configurable threshold); hard-snap for large ones. Threshold tunable in `game_config.json`.
Done when: minor corrections are invisible; large corrections snap without rubber-band effect.

### T-013 · RTT estimation per client
Effort: S   Status: done   Commit: d4207dd

Track RTT per client using the `timestamp` field in input datagrams. Maintain a rolling average
(configurable window). Expose as `rttTicks` for use in lag compensation (T-001) and client
reconciliation (T-011).
Done when: each session has a live RTT estimate in ticks; it's used by ActionSystem.

---

## Stealth

### T-014 · Noise level component — run vs. crouch
Effort: S   Status: todo

Add a `NoiseLevel` component derived each tick from movement speed and crouch state. Running =
high noise; walking = medium; crouching = low. Written by `PhysicsSystem` or a new
`StealthSystem`.
Done when: `NoiseLevel` is present on moving entities and varies correctly with movement state.

### T-015 · NPC detection radius driven by noise + distance
Effort: M   Status: todo

In `NpcAiSystem`, replace binary proximity detection with a soft gradient: detection probability
scales with target noise level and inverse distance. Crouching at range may not trigger detection;
running nearby always does.
Done when: crouching entities are harder to detect at distance than running ones; NPCs react
proportionally.

### T-016 · Directional detection — NPC facing vs. target position
Effort: S   Status: todo

Enemies facing away from the player have no detection. Add a facing arc check to NPC threat
detection: enemies detect within a forward cone at full sensitivity; rear detection only at very
short range.
Done when: flanking unaware NPCs is viable; frontal approach is consistently detected.

### T-017 · Light level detection modifier
Effort: M   Status: todo

Day/night cycle already reduces player perception radius. Extend the detection system to also
reduce NPC detection range at night (and in caves / unlit areas if light source system exists).
Done when: night makes stealth meaningfully easier; NPCs detect less far in darkness.

---

## Lore & Skills

### T-018 · Lore tome as inventory item
Effort: M   Status: done   Commit: (pre-existing)

`blank_tome` and `tome` item templates exist; `InventorySlot.fragmentId` carries the payload;
codec round-trips correctly via inventorySlotCodec optional field encoding.

### T-019 · Externalise Lore — write fragment to tome
Effort: M   Status: done   Commit: (pre-existing)

DynastySystem handles `CommandType.Externalise`: consumes a blank_tome from inventory,
produces a filled tome with the selected fragmentId. Cooldown gated via InteractCooldown.

### T-020 · Internalise Lore — read tome to add fragment
Effort: S   Status: done   Commit: (pre-existing)

DynastySystem handles `CommandType.Internalise`: reads fragmentId from tome slot,
appends to `learnedFragmentIds`, consumes the tome. Cooldown from `lore.externaliseConsumeTicks`.

### T-021 · Balance algorithm in SkillSystem
Effort: M   Status: todo

Implement the cost/effect ratio formula from spec:
`ratio = fragment2.magnitude / (fragment1.magnitude + action.base_magnitude)`
Scale effect power by ratio (full at ≥1.0; scaled down below; amplified above).
Done when: skills with higher-magnitude costs produce amplified effects; lower costs produce
reduced effects; a test case verifies the formula.

### T-022 · Full verb coverage in concept-verb matrix
Effort: L   Status: todo

Currently only `strike` and a few other verbs are wired. Implement all 14 verbs from the spec:
`attack`, `throw`, `shout`, `dash`, `pray`, `harvest`, `track`, `craft`, `enchant`, `trade`,
`persuade`, `build`, passive. Each verb needs a resolution path in `SkillSystem` that reads the
matrix and applies the appropriate effect.
Done when: all 14 verbs have a code path; at least one concept-verb combination per verb is
tested end-to-end.

### T-023 · Expanded skill loadout slots (6–8)
Effort: S   Status: todo

Current `LoreLoadout` has 4 slots. Expand to 6–8 (TBD, set in `game_config.json`). Ensure codec
and UI handle variable slot count.
Done when: slot count is config-driven; codec encodes correctly at the new count.

### T-024 · Tradition naming system for skills
Effort: S   Status: todo

Add `domain` field to fragment definitions (`SUPERNATURAL`, `RELIGIOUS`, `ALCHEMICAL`). Add a
tradition word bank per concept per domain to `lore_fragments.json`. Skill names are generated
as `fragment1_tradition_word + verb_noun`.
Done when: skill names render with tradition flavour; same underlying skill has three readable
names from three traditions.

---

## Crafting & Economy

### T-025 · Workstations as world deployables
Effort: M   Status: done   Commit: 708300c

Add workstation item templates: `chopping_block`, `forge`, `anvil`, `furnace`, `workbench`,
`writing_desk`, `altar`, `alchemist_bench`. Each is a deployable (can be placed in world).
Add a `WorkstationType` component on deployed entities. Crafting system routes interactions
by workstation type.
Done when: workstations can be placed and persist as world entities; they have a type component.

### T-026 · Physical crafting interaction — material placement on workstation
Effort: M   Status: done   Commit: 2822939

Replace menu-driven crafting with the physical model: player places material items onto a
workstation entity (via interact action). Workstation holds a material slot buffer. Attacking the
workstation with the correct tool triggers the crafting check against the buffer contents.
Done when: crafting requires physical material placement + tool attack; menu crafting is removed.

### T-027 · Crafting action step type (tool + attack)
Effort: S   Status: done   Commit: 2822939

Implement instantaneous crafting resolution: when player attacks workstation with correct tool
and correct materials are in the slot buffer, consume materials and spawn output item.
Done when: `axe on chopping_block + log → planks` works via the physical model.

### T-028 · Crafting time-based step type (furnace/fire)
Effort: S   Status: done   Commit: 2822939

Workstations with `"stepType": "time"` in recipe definition run a timer after materials are
placed and a fuel/trigger condition is met. Output spawns when timer completes.
Done when: `ore + fuel → furnace → metal slugs after N ticks` works.

### T-029 · Crafting assembly step type (multi-material + recipe select)
Effort: M   Status: done   Commit: 2822939

For assembly steps: player places multiple materials, selects a recipe from their known Lore
(filtered to recipes valid for current station + materials), then attacks to produce output.
Done when: `2 ingots on anvil + select blade recipe + hammer → rough blade` works.

### T-030 · Recipes as Lore — require known recipe to select
Effort: S   Status: done   Commit: (next)

`Recipe.requiredFragmentId` optional field added to types.ts. `_handleSelectRecipe` in
CraftingSystem checks `LoreLoadout.learnedFragmentIds` before setting `activeRecipeId`.
Recipes without `requiredFragmentId` remain freely available.

### T-031 · Currency — coins as physical inventory item with weight
Effort: S   Status: todo

Add `coin` item template with a weight value. Coins stack in inventory up to a limit.
Trader transactions deduct/add coins from entity inventory (not an abstract balance).
Done when: buying from a trader deducts physical coin items; selling adds them.

### T-032 · NPC buy/need system — NPCs seek traders when need critical
Effort: M   Status: todo

When an NPC's hunger/thirst reaches a threshold and it has coins, add a `seek_trader` job:
find the nearest trader NPC with food/water, buy from them if currency is sufficient.
Same mechanic for tool needs (NPC without hammer seeks a trader selling hammers).
Done when: hungry NPCs with coins autonomously locate and buy food from trader NPCs.

### T-033 · Material property propagation through crafting chain
Effort: M   Status: superseded by T-121

Original sketch: a flat material-property table propagated to outputs. Replaced by
T-121's category + per-recipe-formula model, which is per-instance, atomic, and
extends across multi-step chains.

### T-116 · Research pass — pre-industrial artisan crafting chains
Effort: L   Status: in-progress

Compile a curated catalog of real-world pre-industrial artisanal production chains (metallurgy,
ceramics, textiles, leather, wood/pyrolysis, food/preservation, chemistry/dyes, stone/mineral)
into `research/crafting/`. Each chain is documented with a canonical schema (steps, workstations,
primitive verbs, byproducts, gameplay role, engine-gap flags) so we can later decide which chains
to author as content and which engine features — if any — need to be added to express them.

Scope: pre-1500 tech, observable physical transformations, chains that fit Voxim's gamified
simulation tempo (long chains OK, month-long real-world durations compressed, NPCs handling
boring intermediate steps). Explicitly NOT a 1:1 history simulator.

Phases:
  1. Framing doc + schema (README.md)
  2. Per-category research files (one markdown per category)
  3. Synthesis: cross-category verb vocabulary, workstation inventory, engine-gap list
  4. (Separate ticket, later) — decisions on which chains to author as content,
     and which engine gaps to close.

Done when: research/crafting/ contains the framing doc, one file per category, and a summary
extracting the verb vocabulary, workstation inventory, and engine-gap list across all chains.

### T-117 · Items-as-entities refactor
Effort: L   Status: done   Commit (Ph1): 26a4546   Commit (Ph2): 46d638b   Commit (Ph3): 2dc9fd6   Commit (Ph4): 690de19

Collapse `ItemTemplate` into `Prefab`. Move every item behaviour onto composable
server-only components (Equippable, Swingable, Tool, Deployable, Edible,
Illuminator, Armor, MaterialSource, Composed, Stackable, Weight, Renderable).
Make every unique (non-stackable) item a World entity carried by inventory /
equipment entity-refs; stackables stay as `{ prefabId, quantity }` compact
slots. Instance state (parts, durability, quality, inscription, history) lives
as components on the item entity.

Phases:
  1. Template component vocabulary (additive, non-breaking) — DONE 26a4546
  2. `ItemTemplate` → `Prefab` migration (breaking) — DONE 46d638b
     Old item JSON scratched; new item prefabs authored fresh in content sprint.
  3. Unique items become entities; inventory/equipment entity-refs (breaking) — DONE 2dc9fd6
  4. Instance components: Durability, Inscribed, QualityStamped, History — DONE 690de19
  5. Polish, benchmarks, cleanup — DONE (this commit)

Each breaking phase is its own atomic diff per CLAUDE.md's refactor philosophy.
Checkpoint sign-off gates each breaking phase.

Done when: `grep -r "ItemTemplate" packages/` returns zero matches, every item
in the simulation is either a compact stackable slot or an entity with its own
components, and benchmark confirms the entity budget holds.

### T-118 · Unify deploy + place into one `PlacementSystem`
Effort: M   Status: done   Commit: 8e7578f

Two placement paths currently exist — `CraftingSystem._handleDeploy` (workstation
deploy via `CommandType.DeployItem`) and `BuildingSystem._handlePlace` (blueprint
placement via `CommandType.PlaceBlueprint`). They do the same thing: validate,
spawn a prefab, patch runtime coordinates, fire side-effects. Collapse them.

Target shape:
  - One `PlacementSystem` in `systems/placement.ts`.
  - One `CommandType.Place { prefabId, worldX, worldY, fromInventorySlot? }`.
  - Placement rules live on the target prefab, not on the command handler.
    Extend the existing `Deployable` component (or add a sibling `Placeable`)
    to carry: `alignment: "forward-facing" | "cell-aligned"`, `consumesFromInventory: boolean`,
    `requiresToolType?: string`, `reach?: number`. Blueprints declare these
    too — no blueprint-specific branch.
  - Hearth anchoring becomes an event subscriber. PlacementSystem publishes
    `TileEvents.EntityDeployed { entityId, placerId, prefabId }`; an
    `AccountHearthAnchor` subscriber (registered next to EventRouter)
    reacts when the deployed prefab carries `Hearth`. Removes `accountClient`
    from `CraftingSystem`'s constructor.
  - Delete `CommandType.DeployItem` and `CommandType.PlaceBlueprint` in the
    same commit; rewrite the protocol enum slot comment.
  - Blueprint construction (hit-driven) stays in `BlueprintHitHandler`; this
    refactor only unifies the spawn path.

Done when: `CraftingSystem._handleDeploy` and `BuildingSystem._handlePlace`
are gone, both flows run through `PlacementSystem.handlePlace`, and placing
a hearth still updates the player's account anchor via the new subscriber.

### T-121 · Per-instance stats + per-recipe formulas — items become real things
Effort: L   Status: done   (umbrella; phases T-122..T-127 cover the work)

Replace the current "every variant is its own prefab, recipes lock or list
alternates" model with a generic-item system where variants share a category,
carry per-instance stats, and recipes atomically map input stats → output
stats via expression formulas. The bow chain motivates the design (see
SPEC.md §"Crafting" and §"Quality is Cumulative"); birch/pine/oak/yew are all
`category: "wood"` with their own `flexibility`/`density`/`grain` stats; one
recipe `bow_stave_split` takes any wood and outputs a `bow_stave` with stats
computed from the input; `wooden_bow_assemble` takes a stave + a string and
outputs a bow whose `draw_weight`/`range`/`durability` are computed from
both. Adding spider silk = one new file. Adding a new wood = one new file.
Adding a new stat = touch the recipe(s) that should produce it.

This is a **destructive replacement**, per CLAUDE.md's refactor rules:
- The current variant-explosion item set is scratched. Every recipe that
  duplicated logic per material (`bowstring_linen`, `bowstring_sinew`,
  `bowstring_gut` → one `bowstring_assemble`) collapses. The 450-prefab item
  catalogue and 238-recipe set both shrink and re-shape; expect a substantial
  net deletion in content. Models stay — the visual primitives are reusable.
- No alternates field, no "either itemType or category" co-existence, no
  legacy recipe shape. Recipes pre-migration won't load post-migration. The
  loader rejects unknown shapes loudly.
- No save-data compatibility. Existing inventories regenerate from seed
  per CLAUDE.md.

The system is organised so each phase is one atomic diff. Phases T-122..T-126
break out the work; T-127 lands the UI. T-033 is superseded.

**Architectural shape (terminology used by all subsequent tickets):**
- **Category** — string tag on a prefab (`"wood"`, `"cordage"`, `"ingot"`).
  Loose filter, not a schema. Recipes match inputs by category.
- **Tags** — additional set-of-strings on a prefab (`"organic"`, `"elastic"`,
  `"fire-resistant"`). Recipes can require tags within a category. Authoring
  tags well is the biggest content-design risk; introducing them upfront
  means we don't paint into a corner.
- **Stats** — open key→f32 map on item entities. On raw-material prefabs
  the values are authored directly; on crafted intermediates they're
  computed by the recipe at craft time and stored on the new entity.
- **Roles** — name strings inside a recipe (`"stave"`, `"string"`,
  `"lamination"`) that disambiguate multiple inputs of the same category.
  The matcher assigns loaded buffer items to roles.
- **Formula** — expression string evaluated at craft completion. Variables:
  `<role>.<stat>`, `tool.<stat>`, `workstation.<stat>`, `skill.<verb>`.
  Operators: `+ - * / min max clamp`. Numbers only. No randomness, no IO.
- **Stack vs unique discriminator carries over from T-117**: prefabs with
  `stackable: {}` and no recipe-computed stats stay as compact stack slots;
  any item that has *computed* stats becomes a unique entity carrying a new
  `Stats` instance component. Two stacks of the same prefab merge only if
  their stat blobs are byte-identical (which is automatic for raw materials
  whose stats come from the prefab — they're always identical).

Done when: every phase below is `done`; the bow chain works end-to-end with
stats propagating from a yew log to a finished bow with a procedurally
generated name; a recipe-graph validator passes at content-load over the
full data set; no recipe still uses the old `itemType` + `alternates` shape.

### T-122 · Stats infrastructure + Stats instance component
Effort: M   Status: done   Commit: c776134   Phase 1 of T-121

Add a `Stats` instance component (`Map<string, number>` or fixed-arity
key-value list — pick whichever serialises cheapest in `@voxim/codecs`).
Networked because the client needs it for tooltips; one wireId slot.
Server-side: write at item-entity creation by `spawnPrefab` when the
prefab declares `stats: { ... }`; written at craft completion by the
crafting system.

`Prefab` type gains optional `category: string`, `tags?: string[]`, and
`stats?: Record<string, number>` for raw-material variants whose stats are
hand-authored on the prefab. Loader validates that any stat key is finite
and any tag is a non-empty string.

Done when: `Stats` exists in the codecs + tile-server registry; spawning a
prefab that declares `stats: { ... }` writes the component on the entity;
client decodes it onto `EntityState`; nothing yet consumes the data.

### T-123 · Formula DSL — parser, evaluator, validator
Effort: M   Status: done   Commit: 1defbb7   Phase 2 of T-121

A small expression language inside `@voxim/content` (~200 lines, no deps).
Parses the BNF below at load time into an AST; evaluator takes a scope
`{ [varName]: number }` → number. Variables are dotted strings resolved
against the supplied scope; no implicit fallbacks (referencing an unknown
var fails the eval and is logged once with the recipe id).

```
expr     := term (('+' | '-') term)*
term     := factor (('*' | '/') factor)*
factor   := number | identifier | '(' expr ')' | call
call     := ('min' | 'max' | 'clamp') '(' args ')'
args     := expr (',' expr)*
identifier := [a-zA-Z_][a-zA-Z0-9_.]*
```

Companion `validateFormula(expr, knownVars: Set<string>)` returns the set
of variables the expression actually reads, used by T-124's recipe-graph
validator.

Done when: `parseFormula` + `evalFormula` are exported; unit tests cover
arithmetic, function calls, var resolution, undefined-var errors, syntax
errors; `deno test` passes.

### T-124 · Recipe schema rewrite + content-graph validator
Effort: M   Status: done   Commit: b54bfe6   Phase 3 of T-121

`Recipe` type changes shape — destructive replacement of the input/output
fields; loader fails loud on the old shape (no migration path):

```
inputs: Array<{
  itemType?: string,         // exact prefab id (rare — keys, lore, etc.)
  category?: string,         // category filter (the common case)
  tags?: string[],           // all required (intersection)
  role: string,              // disambiguates multiple inputs
  quantity: number
}>

outputs: Array<{
  itemType: string,
  quantity: number,
  stats?: Record<string, string>  // statName → formula expression
}>
```

Exactly one of `itemType` / `category` per input, never both. Roles are
unique within a recipe. The crafting matcher iterates buffer slots,
assigns each to the first role whose category/tags filter accepts it, and
fails if any role goes unfilled.

Validator (runs once at server start, after content load):
- For every recipe, parse every output stat formula. Collect referenced
  variable names.
- For each `<role>.<stat>` reference: confirm at least one prefab matching
  that role's category/tags constraint produces `<stat>` (either via
  hand-authored prefab stats or via *some* upstream recipe whose output
  declares that stat under the matching itemType).
- For each `tool.<x>`, `workstation.<x>`, `skill.<x>` reference: confirm the
  variable belongs to the documented scope set.
- Any unsatisfied reference fails server boot with the recipe id and
  variable name. No silent NaN bows.

Done when: `Recipe` type carries the new shape; validator runs and passes
on the migrated content from T-125; spinning up the server with a
deliberately-broken recipe (drop a referenced stat from a wood prefab)
fails with a clear error message naming both files.

### T-125 · Wood + bow chain — first vertical
Effort: L   Status: done   Commit: 4287e5c   Phase 4 of T-121

Authoring pass that exercises every piece of T-122..T-124 end-to-end. No
new code unless something breaks.

- Add stats to the wood variants currently in `prefabs/items/`
  (`birch_wood`, `pine_wood`, `oak_wood`, `yew_wood`, `cedar_wood`,
  whichever exist). Tag `wood`. Stats: `flexibility`, `density`, `grain`,
  `flammability`, `color` (colour stays a hex int, but lives on the prefab
  not in stats — drop if it doesn't fit the f32 stat format).
- Add stats to the cordage variants (`linen_yarn`, `sinew`, `gut`).
  Tag `cordage`. Stats: `tensile`, `creep`, `elasticity`.
- Author replacements for the bow-chain recipes, deleting the originals
  in the same commit:
  - `bow_stave_split` (was: split). Takes `{ category: "wood", role: "stave" }`.
    Output `bow_stave` with stats `spring`/`weight`/`straightness` computed
    from `stave.flexibility`/`density`/`grain`.
  - `bowstring_assemble` (collapses `bowstring_linen` + `_sinew` + `_gut`).
    Takes `{ category: "cordage", role: "string", quantity: 3 }`.
    Output `bowstring` with stats `tensile`/`creep` from the cordage stats.
  - `wooden_bow_assemble`. Takes `bow_stave` + `bowstring`. Output
    `wooden_bow` with stats `draw_weight`/`range`/`durability`.
  - Same for `hunting_bow_assemble` and `composite_bow_assemble`.
- Delete the now-orphaned recipes: `bowstring_linen`, `bowstring_sinew`,
  `bowstring_gut`, `bow_stave_from_wood` (the broken `wood` reference one).
- Confirm T-124's validator passes against the result.

Done when: gathering yew, splitting a stave, twisting linen into a string,
and assembling all three on a bench produces a `wooden_bow` whose `Stats`
component reflects the chain (verifiable in network capture).

### T-126 · Migrate remaining categories (content sweep)
Effort: L   Status: done   Phase 5 of T-121

Replaced by a *catalogue wipe and minimal re-author* rather than a per-
category migration. Item count dropped 450 → 27, recipe count 238 → 13.
The new set is a single coherent pipeline (gather → smelt → forge → assemble)
that exercises every system in T-121..T-127 end-to-end with tractable
balance surface.

Categories: `wood` (birch / yew / oak — variants by stat), `ore` (iron_ore
with `purity`). Tags: `hardwood` (yew + oak only) gates `wood_handle_carve`,
proving tag-filter recipes work. Other materials (stone, fiber, coal) are
single-prefab and stat-less.

Resource nodes (7): tree, birch_tree, yew_tree, iron_ore_vein, rock_large,
fiber_bush, berry_bush. Zones updated; deprecated nodes (rock_small,
stone_deposit, coal_seam, copper_ore_vein, clay_deposit, flint_deposit,
mushroom_patch, flower_patch) removed.

Out of scope (deferred): cordage variance (sinew/gut), additional metals
(copper/steel/bronze), leather chain, stat aggregations (avg/sum across
multiple inputs of the same role). All purely additive over the current
shape — copy a recipe / variant file.

Pure content authoring — the system is in place from T-122..T-125. Each
sub-bullet is its own commit:
- `ingot` (copper, iron, steel, bronze, wootz). Stats: `hardness`,
  `toughness`, `density`, `melt_point`. Migrate the 50+ smith recipes.
- `cloth` (linen, wool, hemp). Stats: `weave_density`, `breathability`.
- `leather` (cow, deer, wolf). Stats: `thickness`, `suppleness`.
- `hide` and `fur`. Stats per real-world properties.
- `stone` (granite, sandstone, flint, marble). Stats: `hardness`,
  `friability`, `weight`.
- `bone`/`horn`/`shell`. Stats: `density`, `flexibility`.
- Whatever else the catalogue exposes once the pattern is set.

Each sub-pass deletes the per-variant recipe duplicates it replaces. Net
content count drops; the validator stays green throughout.

Done when: every domain in the existing recipe catalogue has been visited;
no recipe still expresses material variance via duplicated recipes or
`alternates`; the prefab item count is materially smaller than it is today.

### T-127 · Tooltip + procedural naming UI
Effort: M   Status: done   Phase 6 of T-121

Without UI, the system's depth is invisible — players just see numbers
fluctuate. Add:
- Inventory + workstation panel tooltips that show an item's stats with
  short labels (`Spring 0.96`, `Tensile 0.78`).
- A "provenance" affordance (right-click → Inspect, or hover-hold) that
  walks the entity-ref chain for crafted items and shows the chain:
  `Pine Bow ← Pine Stave ← pine_wood`. Bounded depth (3–4 levels max in
  the panel; deeper is collapsible).
- Procedural naming: the `displayName` for a crafted unique is built from
  the most-impactful role variant + the base prefab name. Convention:
  `{stave-variant-adjective} {base-name} with {string-variant} string`,
  e.g. `Pine Longbow with Linen String`. Rules live in a tiny formatter
  per recipe, declared next to the recipe (one line, optional — fall back
  to the base prefab name).

Done when: hovering a crafted bow in inventory shows its stats and a
provenance trail; the bow's display name reflects its source materials.

### T-034 · Terrain tool (shovel) — reduce heightmap cell via combat interaction
Effort: M   Status: done   Commit: 47a2a3d

wooden_shovel (digPower 1) and stone_shovel (digPower 2); DerivedItemStats.digPower field;
game_config.terrain: digStep, minDigHeight, materialDrops map. TerrainDigSystem fires on first
active-phase tick of a shovel swing; lowers Heightmap cell at targeted cell within DIG_REACH.

### T-035 · Terrain modification yields displaced material
Effort: S   Status: done   Commit: 47a2a3d

TerrainDigSystem reads MaterialGrid after dig; drops item matching materialDrops[matId];
auto-collects into digger inventory or spawns world ItemData entity when inventory is full.

### T-036 · Blueprint as saveable/storable Lore item
Effort: M   Status: todo

A blueprint (saved after designing) becomes a `blueprint_tome` — a Lore item storable in the
family library, tradeable, and loadable by NPCs via a `build(blueprint_element)` job.
Done when: a designed blueprint can be saved as a tome item; another character or NPC can load
and execute it.

### T-037 · NPC builder job assignment to blueprint element
Effort: S   Status: todo

Add `build_element` job type to the job board. NPCs with hammer + required materials in inventory
can execute build jobs, incrementally constructing blueprint elements.
Done when: assigning a build job to an NPC causes it to navigate to the blueprint and construct.

---

## NPC & Society

### T-038 · Hiring workbench as craftable deployable
Effort: S   Status: todo

The hiring workbench is currently hardcoded at spawn. Make it a craftable deployable item that
the player places in the world. Placed instance creates a `WorkbenchOwner` component with the
placer's dynasty ID.
Done when: players can craft and place hiring workbenches; ownership is tracked.

### T-039 · NPC sleep need + bed infrastructure
Effort: M   Status: todo

Add `Sleep` as an NPC need alongside `Hunger`/`Thirst`. Add a `bed` deployable. When sleep need
is critical, NPC seeks the nearest unoccupied bed and fulfills it. No bed = NPC enters permanent
low-performance state or eventually leaves.
Done when: NPCs seek and use beds; missing beds cause retention problems.

### T-040 · NPC sensory system — proximity event subscription
Effort: M   Status: todo

NPCs currently detect threats via direct distance checks. Replace with event-bus subscriptions:
NPCs subscribe to `DamageDealt`, `EntityDied`, `LoudNoise` events within their detection radius.
Guards subscribe broadly; labourers subscribe narrowly.
Done when: nearby combat events trigger NPC awareness without per-tick distance scans.

### T-041 · NPC Lore accumulation through job execution
Effort: M   Status: todo

When an NPC completes a job of a type it can learn from (crafting, building, gathering), increment
an internal Lore experience counter. At a threshold, add the relevant fragment to the NPC's Lore
set. Slower and with a smaller fragment ceiling than players.
Done when: a blacksmith NPC gains crafting-related Lore over many crafting jobs.

### T-042 · NPC specialisation matching to job requirements
Effort: S   Status: todo

Jobs in the board have optional `skillRequirement` field. When an NPC pulls a job, it checks
whether it has the required Lore. NPCs without the Lore skip to a lower-priority job.
Done when: a forging job requiring smithing Lore is only taken by NPCs with that fragment.

### T-043 · NPC social idle behaviour
Effort: S   Status: todo

When an NPC's job queue is empty, rather than standing idle, it wanders within a home range and
occasionally emits a `SocialIdle` event. Nearby NPCs react by moving closer briefly. Simple,
low-cost — flavour over simulation.
Done when: idle NPCs appear to socialise with nearby NPCs rather than standing frozen.

### T-144 · NPC ground-drop pickup pathway
Effort: S   Status: todo

NPCs that gather resources (and any future job that produces a world ItemData entity instead of
writing directly to the harvester's inventory) currently never collect their own drops. Background:
the player-facing `ItemPickupSystem` was deleted in favour of explicit PickUp commands; that system
already excluded NPCs (`if (world.has(collectorId, NpcTag)) continue`), so removing it changed
nothing for the NPC path — but the original `gather_resource` job docstring was aspirational and
assumed pickup happened automatically. It doesn't. Today a forester chops a tree, the logs spawn
on the ground next to it, and the NPC walks away empty-handed.

The fix lives inside the existing `JobHandler` pattern. Two reasonable shapes:
  - Extend `gather_resource` so after depleting the node it transitions into a "collect spawned
    drops" sub-state: scan ItemData entities within a small radius of the node whose `prefabId`
    matches the job's `itemType`, walk to each in turn, fold into Inventory, destroy the world
    entity. Job completes when the inventory threshold is met OR no more matching drops in range.
  - Or: a small dedicated `pickup_drops` job that `gather_resource` enqueues on depletion, with
    args `{ near: {x,y}, itemType, radius }`. Reusable by future producers (mining, butchering).
The implementer picks; the second is cleaner for reuse but heavier today.

Two interactions worth handling:
  - With T-129's drop-ejection physics, drops have non-zero Velocity for ~0.4s after spawn.
    Either wait for Velocity to be removed (settled) before collecting, or accept that the first
    pickup attempt may chase a moving target — collecting on settled-only is simpler.
  - Inventory-full case: the NPC just leaves the drops on the ground (matches the player flow);
    don't silently void overflow.

Done when: a forester NPC depletes a tree, walks to each dropped log, and the logs appear in its
inventory before it transitions to its next job. Verified via the NPC inventory tooltip and the
ground entity count returning to baseline near the node.

---

## World & Macro Simulation

### T-044 · City state data structure + persistent state file
Effort: M   Status: todo

Define a `CityState` structure: personality traits, long-term goals, relationship map
(city→city stance), resource inventory, population count, event log (last N events).
Serialise to a JSON file per city; load on startup. This is the LLM's memory.
Done when: city state persists across tile server restarts; event log accumulates.

### T-045 · World event bus (gateway-scoped)
Effort: M   Status: todo

Implement the gateway-level event bus. Tile servers publish cross-tile events to it
(`PlayerCrossedGate`, `CaravanArrived`, `CityRaided`, etc.). The macro simulation and gateway
subscribe. Gateway event bus is distinct from the per-tile event bus.
Done when: a tile server can publish a world event; a gateway subscriber receives it.

### T-046 · City LLM agent interface — event-driven tool calls
Effort: L   Status: todo

Define the LLM call interface: context packet structure, available tool call schema
(`post_job`, `set_priority`, `send_caravan`, `propose_trade`, `declare_hostility`, `hire_npc`).
LLM is triggered by significant events from the world event bus. Validate and execute tool call
outputs against engine state.
Done when: a mock LLM response can be parsed and its tool calls executed by the engine.
Note: actual LLM integration is a separate ticket.

### T-047 · LLM fallback utility AI for city strategy
Effort: M   Status: todo

When LLM is unavailable, a simple utility AI runs: maintain food production jobs, keep guard
posts filled, trigger `send_caravan` when a surplus threshold is crossed. Strategic decisions
queue until the LLM responds.
Done when: a city without LLM access maintains basic operations autonomously.

### T-048 · Caravan entity — NPC group with goods + destination
Effort: M   Status: todo

A caravan is a group entity: lead NPC + guard NPCs + goods inventory + destination tile.
The lead NPC navigates to a gate; at the gate, the caravan crosses tiles via the gate system.
Goods are physical items in the caravan inventory — raidable.
Done when: a caravan entity can be dispatched, navigate to a gate, and be intercepted.

### T-049 · Macro simulation — trade agreement + resource exchange
Effort: L   Status: todo

When two cities have an active trade agreement, a periodic job dispatches caravans (T-048)
between them. On arrival, goods are transferred between city inventories. Agreement can lapse
if a caravan is raided N times.
Done when: two cities with an agreement exchange goods via caravans; raiding disrupts the flow.

### T-050 · Connect LLM to city agent interface (T-046)
Effort: M   Status: todo

Wire the real LLM API (Anthropic Claude) to the city agent interface defined in T-046.
Context packet assembly, call trigger from world event bus, response parsing, tool execution.
Rate-limit: one call per city per event; no tick-driven calls.
Done when: a live city reacts to a significant event with LLM-generated tool calls.

### T-172 · Drowner creature + UAL2 import pipeline fix
Effort: M   Status: done   Commit: 84771f9

First non-human/non-canine creature: a Gollum-like swamp ambusher running on all fours with
elongated arms. Skeleton reuses the human bone-name schema so existing `anim_maps/` entries
work; voxel parts in a new `drowner_flesh` material with bone showing through skull/ribs/claws.
NPC template + prefab + addition to `MOB_NPC_POOL` so it spawns at mob POIs alongside
wolf/bandit/archer.

The work also exposed and fixed two latent bugs in `scripts/convert_anim.ts` and the
content-data conventions:
  - The converter was emitting absolute source-bone quaternions per keyframe, which baked the
    source rig's bind orientation (e.g. a leg bone whose source local Y points along the bone)
    into every frame and stacked it on top of our identity-rest skeleton. Fix: subtract the
    source node's bind rotation before Euler conversion so frames are stored as deltas-from-bind.
    Benefits any future Mixamo/CMU/Quaternius import.
  - Bone segment lengths must match attached voxel-model lengths or you get visible gaps at
    every joint (1-voxel-wide limbs make this glaring). Drowner part-models extended to fill
    the 2.5-unit arm and 1.5-unit upper-leg segments.

New `anim_maps/ual.json` covers the Unreal-style bone names (`pelvis`, `spine_01/02/03`,
`upperarm_l/r`, `thigh_l/r`, `calf_l/r`) used by `UAL2_Standard.fbx`, distinct from the older
Mixamo-style names handled by `quaternius.json`. Four core clips converted: idle / walk /
attack / death.

Done when: a drowner spawns at a mob POI, plays the converted Zombie idle in rest pose without
distortion, and the rest of the UAL2 library can be imported by any caller running
`convert_anim.ts <glb> ual --clip <name>`.

---

## Gateway & Multi-tile

### T-051 · Gateway handshake flow
Effort: M   Status: todo

Implement the real gateway handshake: client connects → authenticates → gateway looks up which
tile the player is on → returns tile server address → client opens direct WebTransport connection
to tile server → gateway steps off the data path.
Done when: a fresh client connects through gateway and reaches the correct tile server.

### T-052 · Tile directory — register on startup, lookup by player
Effort: S   Status: todo

Tile servers register with the gateway on startup (tile ID, address, current population).
Gateway maintains this directory in memory. Player→tile mapping updated on each gate crossing.
Done when: gateway can answer "which tile is player X on?" with current data.

### T-053 · Gate entities on tile edges
Effort: M   Status: todo

Gates are physical entities in the world at fixed positions on tile edges (from world generation).
Player approaching a gate receives a `GateApproached` event. Gate carries `destinationTileId`.
Done when: gate entities exist; player proximity triggers the gate event.

### T-054 · Player tile traversal — entity handoff
Effort: L   Status: todo

On `GateApproached` event, source tile server serialises the full player entity (all components).
Sends serialised entity + destination tile ID to gateway. Gateway forwards to destination tile
server which deserialises and inserts the entity. Source tombstones the entity.
Done when: a player crosses a gate and continues play on the destination tile; no component state
is lost.

### T-055 · Client tile transition — new WebTransport connection
Effort: M   Status: todo

When the client receives a `GateCrossing` event in the state stream, it opens a new WebTransport
connection to the destination tile server address (provided by gateway), closes the old one, and
re-initialises the client world state from the first state message on the new connection.
Done when: client seamlessly transitions between tiles on gate crossing.

---

## World Generation

### T-056 · World map macro generator
Effort: L   Status: todo

Generate the world map: elevation noise → temperature/moisture gradients → biome assignment per
tile cell. Output: a `WorldMap` structure with biome per cell, elevation, river flag, city seed
positions, corruption zones, road network stub.
Done when: a deterministic world map generates from a seed; biomes are distributed correctly.

### T-057 · River tracing on world map
Effort: M   Status: todo

Trace rivers from high-elevation cells downhill to coastal or low-elevation outlets. Output a
list of tile cells with river presence flag. River tiles get a channel cut during tile generation.
Done when: rivers flow from mountains to coast; river flags are present on tile map cells.

### T-058 · Road network generation
Effort: M   Status: todo

Connect city seed positions with roads following terrain of least resistance. Road tiles get a
flatten pass during tile generation. Gate positions on road tiles align with road path.
Done when: roads connect city seeds on the world map; road tiles carry a road flag.

### T-059 · NPC city seeding on world map
Effort: M   Status: todo

Select city locations from world map (flat terrain, near water, resource diversity). Create a
`CityState` (T-044) for each. Seed each with a founding NPC and a starting workbench.
Done when: world generation produces N cities at valid locations with initial state files.

### T-060 · Corruption distribution on world map
Effort: S   Status: todo

Place one or more catastrophe ground-zero points. Compute corruption level for each tile cell
using falloff from ground-zero points. Corrupted and Badlands biomes cluster here.
Done when: corruption level is available per tile cell; biome assignment uses it.

### T-061 · Tile generator — biome-parameterised heightmap + resource nodes
Effort: L   Status: todo

Generate a tile on demand from world map inputs: biome, elevation, river flag, road flag,
corruption level, gate positions. Produces `Heightmap`, `MaterialGrid`, and resource node
entities seeded by biome type and density.
Done when: a tile loads from world map data with correct biome-appropriate terrain and nodes.

### T-062 · Corruption overlay in tile generation
Effort: M   Status: todo

If a tile's corruption level > 0, warp terrain (increase noise amplitude) and replace normal
spawns with corrupted variants. Higher corruption = more severe warping.
Done when: corrupted tiles have visibly warped terrain; enemy spawns are corrupted variants.

### T-063 · Cave instance tile type
Effort: M   Status: todo

Cave instances are tiles with enclosed-rock generation (walls + floor = rock material, no open
sky). A cave gate on a surface tile links to a cave tile ID. Cave tiles are generated with the
same tile generator, just with different biome parameters (cave biome).
Done when: a surface gate can link to a cave tile; cave tile generates correctly.

### T-064 · Dynamic chunk loading/unloading by entity proximity
Effort: M   Status: todo

Currently all chunks for a tile are loaded at startup. Load a chunk entity into the world only
when a player or active NPC is within a configurable radius. Serialise and unload chunks with
no nearby entities after a grace period.
Done when: distant chunks are absent from world store; they load when an entity approaches.

### T-156 · Atlas tilemap — three wall kinds (grass mound, stone, forest), all 2u
Effort: S   Status: done   Commit: 8412026

The maze needs three visually distinct wall types, all non-walkable, all
raised the same 2 world units (just enough to exceed the 0.75u runtime
stepHeight). The existing `boundary_kinds` machinery had three slots
(CLIFF / VEGETATION / WATER) but only CLIFF was raised; VEGETATION was
flat-with-trees and the third "default" wall type was missing.

  - Rename CLIFF → STONE, VEGETATION → FOREST atomically through atlas
    + tile-server. Same numeric ids (1, 2) so old wire payloads still
    decode meaningfully — they were just internal vocabulary.
  - Add `BOUNDARY_KIND_GRASS_MOUND` (id 4). Becomes the fallback wall
    type — picked when neither STONE (high altitude / rugged) nor FOREST
    (high moisture) qualifies. Inspector colours it bright green.
  - `WALL_HEIGHT` 3.0 → 2.0; terrain stage now raises all three wall
    kinds (STONE, FOREST, GRASS_MOUND), not only STONE. WATER and OPEN
    stay at floor height. Players can't step over any wall type.
  - Per-kind closed material: STONE → STONE, FOREST → DIRT (forest
    floor), GRASS_MOUND → GRASS, WATER → WATER.
  - GenParams `kinds` slice renamed: `cliff*` → `stone*`,
    `vegetationMoisture` → `forestMoisture`, `vegetationDensityStride`
    → `forestDensityStride`. Inspector knob configs + hints follow.

Done when: a baked tile shows green-mound walls in dry biomes, dark-green
forest walls (with trees on top) in wet biomes, grey stone walls in
high-altitude biomes; player can't step over any of them; the inspector
"kinds" layer paints all four ids distinctly.

### T-155 · Atlas tilemap — paths first, rooms emerge at convergent junctions
Effort: M   Status: done   Commit: 9690371

Inverts the pipeline order. Today chambers come first and corridors are
forced to bridge them; user wants paths to drive the structure and rooms
to *emerge* where many paths converge.

New stage layout:

  noise → junctions → network → rooms → portals → ...

  - **junctions** (replaces the seed-placement half of `chambers`):
    Poisson-disk sample N points across the tile. Just positions; no
    growth. These are first-class graph nodes, not rooms.

  - **network** (modified): operates on `seeds[]` instead of chambers.
    Delaunay over the seeds, MST + braid as before, carve all chosen
    edges as Catmull-Rom splines (seed → seed; no boundary-endpoint
    walk needed since seeds are points). Recursive branches as before.
    NEW: returns a `degrees[]` array — for each seed, the count of
    chosen edges touching it.

  - **rooms** (new, replaces the growth half of `chambers`): per
    junction, roll a probability scaling with degree:
    `prob = clamp(roomChanceBase + (degree − 1) · roomChancePerDegree, 0, 1)`.
    Junctions where the roll succeeds get a noise-flooded disk grown
    around them via the same priority-flood used before, but tightly
    sized (`sizeMin/sizeMax` tuned for ~200–600 px = small "hub"
    rooms). Round-robin growth lets adjacent rooms compete fairly.
    Pass-through junctions (low degree) become invisible bends in the
    corridor; convergent junctions (degree ≥ 3) usually become rooms.

  - **portal_placement** (modified): targets the nearest junction
    instead of the nearest chamber. After room growth some junctions
    have rooms, some don't — gate carves don't care; they just stitch
    into the network.

GenParams adds `room.roomChanceBase` (default ~0.05) and
`room.roomChancePerDegree` (default ~0.30): degree 1 → 5%, degree 2 →
35%, degree 3 → 65%, degree 4 → 95%, ≥5 → 100%. Existing
`room.sizeMin/Max/compactness` retuned for the smaller room scale.
`chambers.ts` is deleted (replaced by the junctions + rooms split).

Done when: forest_maze bake produces a dense maze of paths with most
junctions invisible (just bends) and ~30–50% of junctions hosting small
noise-shaped rooms. Connectivity: the spanning tree still connects
every junction (and every gate to every other gate).

### T-154 · Atlas tilemap — organic chambers + recursive branch-paths
Effort: M   Status: done   Commit: f282b2c

After T-153 chambers were properly sized but visually too round (compactness
× distance dominates noise ~10:1, so growth is essentially Voronoi) and
the network was sparse — only chamber-to-chamber MST + braid corridors,
~10 carves per tile total. The user wants chambers with organic lobes
and "many more paths weaving like a maze."

Three bundled changes:

1. **Lower compactness, raise noise frequency.** Drop default
   `room.compactness` from 0.35 → 0.10 and bump `noise.baseFrequency`
   from 0.0125 → 0.022 across all presets, so noise wavelength becomes
   smaller than chamber radius — noise has space to sculpt the boundary
   into lobes/peninsulas/indents instead of being averaged out.

2. **More mainline interconnections.** Bump `room.targetCount` 7 → 10
   and `network.loopRate` 0.55 → 0.85 in the forest_maze preset. More
   chambers → more Delaunay edges; more loop rate → more braids kept.
   Roughly doubles the main corridor count.

3. **Recursive branch-paths pass.** After the main carve loop, each
   corridor optionally spawns sub-branches that wander off into the
   wall space. For each parent corridor: with probability
   `network.branchRate`, sample a point along its spline at random t
   in [0.2, 0.8], take the local tangent, pick a perpendicular ± random
   angle, and carve a new spline of length
   `branchLengthFraction × parent_length`. Branches recurse up to
   `branchMaxDepth` levels (each level scaled down by lengthFraction),
   so the carve fan-out is bounded but visible. Branches that
   coincidentally hit other corridors / chambers form natural junctions;
   ones that don't form dead-end paths — both reinforce the maze feel.

The `samplePoint` and `sampleTangent` helpers (Catmull-Rom evaluator
+ analytical derivative) move into `bezier_carve.ts` so other consumers
(future "POI placement on a corridor", inspector hover markers, …) can
reuse them.

Done when: forest_maze bake produces ~10 chambers with visible noise
lobes (no longer reading as disks) and the corridor count rises from
~10 to 30+, with branches forming dead-ends and crossings throughout
the wall space.

### T-153 · Atlas tilemap — generate at runtime resolution (gridSize 128 → 512)
Effort: S   Status: done   Commit: 1a15c73

Atlas was running its pipeline at a 128² sample grid and the upsample stage
was scaling the result 4× to fit tile-server's 512² voxel resolution. That
created a visible seam between what the inspector showed (chunky, coarse)
and what the player walked on (finer, with bilinear floor reconstruction
and nearest-neighbour openness). Bump `DEFAULT_GRID_SIZE` to 512 so atlas
generates at the same resolution as the runtime; one pixel = one voxel
= one world unit. The upsample stage stays in place but the loop becomes
effectively a 1:1 copy plus material translation.

Two follow-on cleanups land in the same commit:

- **`compactness` uses world units.** The chamber-growth distance term was
  in pixels, which would silently mean different things at different
  gridSize. Multiply by `px2world` so the knob is gridSize-invariant.
- **Spatial defaults rescaled.** All knobs that previously meant "pixels
  at 4 wu/px" now mean "pixels at 1 wu/px". minSeparation 32 → 128;
  sizeMin/Max 320/600 → 5000/9500; maxEdgeLength 90 → 360;
  widthMin/Max 0/1 → 1/3; bezierSamples 50 → 200. All four presets
  retuned. Inspector knob ranges widened to fit the new scale.

Done when: re-bake of forest_maze produces ~7 chambers per tile that
look identical in shape between the inspector and an in-game tile, no
upsample seam, and player physics behaves the same as before (collision
& heightmap unchanged).

### T-152 · Atlas tilemap — room-feeling chambers + segmented spline corridors
Effort: M   Status: done   Commit: 82c1639

T-151 produced chambers that read as snake-shaped fragments of the noise
field instead of *rooms* (areas you can spawn things inside), and single-
quadratic corridors that cut straight through chambers and could swing
outside the tile. Four bundled fixes to land it as a usable level shape:

1. **Compact chamber growth.** Today the priority-flood cost is just
   `noise[p]`, so chambers follow whichever low-noise lobe drifts away
   from the seed → snake silhouettes. Add a distance-from-seed term:
   `cost = noise[p] + compactness · |p − seed|`. `room.compactness`
   defaults around 0.35 — chambers accrete volume around the seed but
   still take organic shapes from noise structure. Combined with much
   bigger `sizeMin/sizeMax` defaults, this gives chambers that read as
   spaces, not corridors.

2. **Boundary endpoints.** Corridors used to run centroid → centroid,
   carving straight through the chambers they "connect". Now each
   network edge ray-marches from each centroid toward the partner and
   uses the last in-chamber pixel as the bezier endpoint. The chamber
   interior stays untouched; corridors look like they enter and exit at
   the chamber walls, which is what makes them feel like *gaps in a wall*
   rather than tubes drilled through rooms.

3. **Segmented spline paths.** Single quadratic bezier replaced with
   `network.segments` (default 4) waypoints generated along the line
   between endpoints, perpendicular-perturbed by `curvature ·
   edge_length` with a sin envelope so the perturbation tapers to zero
   at the endpoints. The carve sweeps a Catmull-Rom spline through the
   waypoints (each segment becomes a cubic bezier; C1 continuous at the
   joints). This gives real wandering paths instead of one arc.

4. **Tile-interior clipping.** Each waypoint is clamped to a margin
   inside the tile (margin = halfWidth + 2). Corridors no longer
   excursion outside the playable area when curvature is high.

`Corridor` record changes from (a, cp, b) to a `waypoints: Array<{x,y}>`
list. Inspector replicates the same Catmull-Rom math to draw centerlines.
Defaults retuned: chambers larger and rounder, corridors narrower so
chambers visually dominate the tile.

Done when: bake forest_maze and the inspector shows ~7 chunky chambers
of varied organic shape, corridors that wander through 3-5 bends and
stay inside the tile, and chamber interiors visibly preserved (no
corridor cutting them in half).

### T-151 · Atlas tilemap — Poisson-seeded chambers + bezier corridor carve
Effort: M   Status: done   Commit: 33ec1a6

T-150 produced too many chambers (~17 typical) with round/blob silhouettes
and fixed-width A* corridors that read as straight wedges. Replace the
chamber and carve stages so designers get explicit count control, organic
silhouettes, and curving variable-width paths between rooms.

Replace, don't accrete (the prior `roomify` and `carve` modules are
deleted in the same commit):

1. **`chambers`** (replaces `roomify`) — Poisson-disk sample N seeds
   (target count, deterministic from tileSeed), then grow each chamber
   via priority flood over the noise field: round-robin one-pixel-at-a-
   time accretion, lowest-noise neighbour first. Naturally gives organic
   shapes (the chamber follows weak-noise lobes) and Voronoi-ish
   competition between adjacent chambers.

2. **`bezier_carve`** (replaces `carve`) — for an edge between two
   chamber centroids: midpoint perpendicular-displaced by `network.curvature
   × edge_length × ±sign`, quadratic bezier sampled densely, square brush
   of `widthMin..widthMax` stamped at each sample. Per-edge width is
   sampled per edge from a tile-seeded PRNG so different routes have
   visibly different girths.

3. **`network`** rewritten to use bezier_carve. Stores the carved
   corridors (endpoints + control point + width) on `TileInit.corridors`
   so the inspector can draw centerlines and per-edge widths.

4. **`portal_placement`** carves gates → nearest chamber via the same
   bezier carve; the gate corridors land in `TileInit.corridors` too.

5. **GenParams** restructured: `room.{targetCount, minSeparation,
   sizeMin, sizeMax}` and `network.{maxEdgeLength, loopRate, widthMin,
   widthMax, curvature, bezierSamples}`. Inspector knob hints updated.

6. **Inspector** rooms layer overlays the corridor centerlines as thin
   contrasting lines on top of the chamber-coloured open pixels, so the
   network reads as drawn paths instead of just light-grey blobs.

Done when: the four named presets each give 5–10 chambers per tile with
visibly organic silhouettes, corridors curve and vary in width, the
inspector renders centerline overlays on the rooms layer, and the gate
summary stays correct (every present gate reaches every other through
the carved network).

### T-150 · Atlas tilemap — interwoven room network from noise blobs
Effort: M   Status: done   Commit: 64d2bc1

Today's tilemap pipeline leaves connectivity to luck: noise threshold produces one rambling
open snake, room detection labels whatever blobs fall out, and `portal_placement` carves a
straight 1-pixel stub from each gate until it bumps into anything open. There's no guarantee
gates reach each other, and no design intent behind which rooms connect to which.

Replace the head of the pipeline with a structural pass that uses the noise field as the
*source of organic shape* but treats connectivity as a deliberate plan:

1. **Tighten noise threshold** so the field fragments into many distinct open blobs
   instead of one connected region.
2. **`runRoomify`** — drop blobs below `params.room.minPixelArea`; optionally dilate the
   keepers; re-flood for a clean `rooms[]` + `roomOf`.
3. **`runNetwork`** — Delaunay triangulation over room centroids → MST for guaranteed
   connectivity → keep `params.network.loopRate` of the remaining Delaunay edges as loops.
   Carve each chosen edge using A\* through closed pixels with **noise-flow cost** (the
   carve naturally meanders along the weakest walls — no straight-line cuts).
4. **Shrink `runPortalPlacement`** to "stitch each gate into the network": pick the nearest
   room centroid, A\* from the gate's edge pixel using the same noise-flow cost.
5. New `GenParams` slices `room` and `network`; presets and inspector knob hints updated.

Done when: every present gate is on the network, the inspector "rooms" view shows a
clearly interwoven layout (multiple paths between most room pairs), corridors visibly
follow noise-thin regions instead of cutting straight lines, and the four named presets
each give a distinct overall topology.

---

## Rendering & Client

### T-065 · Enclosure detection on server
Effort: L   Status: todo

Server detects enclosed areas: a closed loop of wall entities forms an enclosure. Compute this
when walls are placed or destroyed. Emit `EnclosureChanged` event with enclosure polygon.
Client uses this to decide whether to render a roof.
Done when: placing walls in a closed rectangle produces an `EnclosureChanged` event with correct
polygon; destroying a wall removes the enclosure.

### T-066 · Client roof rendering for enclosed areas
Effort: M   Status: todo

On `EnclosureChanged` event, client generates roof geometry over the enclosure polygon.
When the player entity is inside the enclosure, the roof is hidden (player sees interior).
When outside, the roof is visible.
Done when: an enclosed building renders a roof; walking inside makes the roof disappear.

### T-067 · Model baking in Web Worker
Effort: M   Status: todo

Move `buildDisplacedVoxelGeo` (and the full model baking pipeline) off the main thread into a
Web Worker. Main thread sends model definition; worker returns a baked `BufferGeometry` (or
transferable geometry data). Game loop never stalls during baking.
Done when: loading a complex model does not drop frames; the main thread continues rendering
while the worker bakes.

### T-068 · Client content cache — IndexedDB
Effort: M   Status: todo

Raw model definitions received from the server are persisted to IndexedDB keyed by
`(modelId, version)`. On subsequent page loads, known models are served from cache; the server
is only queried for unknown or newer versions.
Done when: a page reload reuses cached models without re-requesting them from the server.

### T-069 · Model request via reliable WebTransport stream
Effort: S   Status: todo

Client requests model definitions via the same reliable WebTransport stream as game state.
No separate HTTP endpoint. Server responds with a `ModelDefinition` message on that stream.
Done when: model requests and game state share one connection; no HTTP fallback exists.

### T-070 · Render placeholder for unknown modelId
Effort: S   Status: todo

When an entity with an unknown `modelId` arrives, render a bounding-box placeholder immediately.
Replace with real geometry when baking completes (T-067). Never block the game loop.
Done when: new entities always appear immediately as boxes; real model swaps in without a pop.

### T-157 · Fog of war + LOS + minimap
Effort: L   Status: done   Commit: HEAD

Exploration tracking split across client and server.  The world is dark
by default; the player's line-of-sight reveals it.  Once seen, a cell
stays "explored" (dim) for the rest of the session.  Currently-visible
cells (the LOS arc in front of the player) render at full brightness.

Data is split by lifetime:

  - **`seenEver`** lives on the **server** — authoritative, persistent,
    can survive reconnects.  Per-player bitmap of explored fog cells.
  - **`currentlyVisible`** stays on the **client** — too ephemeral to
    network at 20 Hz; the client recomputes it each frame from `OpenMask`
    and the player's facing.

Resolution: 256×256 fog cells over the 512-unit tile (one fog cell per
2×2 world units).  Bit-packed to **8 KB per (player, tile)** on the wire
and on disk.  2u matches wall thickness (T-156) so the resolution drop
isn't visible.

Shared constants in `@voxim/protocol/src/fog.ts`:
`FOG_GRID_SIZE = 256`, `FOG_CELL_SIZE = 2`, `FOG_GRID_BYTES = 8192`,
`LOS_HALF_ANGLE_RAD ≈ 0.96`, `LOS_RADIUS = 40`, `LOS_RAY_COUNT = 110`,
`LOS_STEP = 0.5`.  Both sides import these — no drift possible.

Server (`packages/tile-server`):
  - `components/fog_state.ts` — server-only component: bit-packed
    `Uint8Array(FOG_GRID_BYTES)`, plus a `revealedThisTick: number[]`
    queue of newly-set cell indices (drained by the send path each
    tick).
  - `systems/fog_of_war.ts` — runs each tick.  For every player entity
    with `FogState`, casts the LOS cone in world-unit ray steps and
    marks fog cells.  Reads `OpenMask` from terrain chunks for
    occlusion; rays stop at closed cells.  New bits are pushed to
    `revealedThisTick`.
  - `aoi.ts` / `server.ts` — embeds fog data inside `BinaryStateMessage`:
    full snapshot on the first tick the client sees (cleared after
    send), reveal list on every subsequent tick that has new cells.

Wire format additions to `BinaryStateMessage`:
  - `fogSnapshot: Uint8Array | null` — 8 KB bit-packed bitmap, set only
    on the first message after join.
  - `fogReveals: Uint16Array` — newly-revealed fog cell indices as u16
    (256² = 65536 fits exactly).

Client (`packages/client`):
  - `state/fog_of_war.ts` refactored: `seenEver` is bit-packed and
    server-driven (applied via `applySnapshot`/`applyReveals`).
    `currentlyVisible` stays client-computed at 256² resolution (matches
    server grid).  Texture upload from packed bits: pack three states
    (unseen/seen/visible) into the R8 channel for the shader.
  - `connection/tile_connection.ts` and `game.ts`: forward fog fields
    from BinaryStateMessage into FogOfWar.

Persistence (deferred to follow-up): bitmap saved per (playerId, tileId)
to the account service or a tile-local file.  In-memory only for now —
fog resets on tile-server restart, but survives client refresh during
one server lifetime.

Renderer (`packages/client/src/render/edge_pass.ts`): unchanged shader
math; just samples the new 256² fog texture instead of 512².

UI (`packages/client/src/ui/components/Minimap.tsx`): 200×200 canvas in
the top-right.  Reads the bit-packed grids from `FogOfWar` and draws
the player marker.  Throttled to ~10 Hz.

Done when: world is black on first connect; walking forward reveals a
cone-shaped trail that stays dim behind the player; the LOS arc in
front is full-bright; closed cells (walls) block the cone; the minimap
top-right shows the same explored shape; on client refresh the player
sees their previously-explored area immediately on join (server-driven
snapshot).

### T-159 · River cells render as translucent water
Effort: S   Status: in-progress

Atlas marks rivers/ponds with `BOUNDARY_KIND_WATER` and they're already
closed in `OpenMask`, but visually they used to be just flat blue cells —
nothing said "water".  Two changes:

  - `atlas/.../terrain.ts`: WATER cells now drop to `floor - RIVER_DEPTH`
    (0.5 world units below floor) instead of staying flat.  Rivers carve
    a shallow trench.  STONE / FOREST / GRASS_MOUND walls still rise by
    `wallHeight`; OPEN cells unchanged.
  - `client/render/water_renderer.ts` (new): per-chunk translucent surface
    mesh at the original floor height (`heights[idx] + RIVER_DEPTH`) over
    every WATER cell.  One shared `THREE.ShaderMaterial` with a `uTime`-
    driven sin/cos wave pattern in the fragment shader — three crossed
    bands plus a sparkle highlight.  Subscribes to `ClientWorld.onChunkKinds`
    (same hook ForestPropsRenderer uses) and pulls the heightmap out of
    `ClientWorld` (new `getHeightmapData` accessor).

`RIVER_DEPTH = 0.5` is duplicated in the client mirror with a cross-
referencing comment (atlas isn't a client dep).  Per-frame `uTime` pump
runs from `game.ts` next to the renderer call.

Done when: rivers render as visibly recessed channels with an animated
translucent water surface above them; the bed (mud material) shows
through the water; the surface ripples gently at game speed.

### T-160 · First POI primitive: room + mob placement in chambers
Effort: M   Status: in-progress

Empty chambers feel pointless.  Atlas already detects discrete pre-network
chambers (T-152/155 — `TileInit.chambers`); this ticket gives each chamber
a deterministic chance of being a "point of interest".

Two POI types, deliberately primitive (the user spec was "first primitive"):

  - **mob POI** (40 % roll): 3 random NPCs spawn near the chamber centroid.
    Pool = `["wolf", "bandit", "archer"]` (whatever's in `content/npcs/`).
    Re-derived every boot from `(tileSeed, chamberId)`; NPCs aren't
    persisted (consistent with `procedural.spawnInitialNpcs`).
  - **room POI** (25 % roll): a 5×5 wooden enclosure stamped directly into
    the terrain buffers (closed `openMask`, raised `heights`, wood
    `material`, stone `kind` to suppress forest decoration).  One cell on
    the south wall is left open as a doorway.  Stamping happens BEFORE
    `chunksFromBuffers` so the walls are part of the world from boot.
  - 35 % empty.  Tiny chambers (<25 pixels) skipped outright.

Implementation entirely in `tile-server`:
  - `atlas_terrain.ts` exposes `chambers` on its result (world-unit
    centroids passed through from `TileInit`).
  - `poi_placer.ts` (new): `placePois(buffers, chambers, seed, woodId)`
    mutates buffers in place for room POIs and returns a list of mob
    spawns; `spawnMobPois(world, content, mobs)` instantiates them after
    chunks are committed.
  - `server.ts` calls both on the no-save boot path, between
    `loadTerrainFromAtlas` and `chunksFromBuffers` (room) and after
    `procedural.spawnProceduralProps()` (mobs).

Atlas-side `Feature[]` typing is intentionally out of scope — the
placeholders in `TileInit.features` stay `unknown[]` for now.  When the
POI system grows past "first primitive" it'll move into the atlas
pipeline so layouts are part of the persisted bake.

Done when: walking through a freshly-baked tile reveals empty rooms,
small wood-walled enclosures with a south door, and chamber clusters of
3 hostile NPCs scattered across the map — same layout on every restart.

### T-161 · Persist fog of war across sessions
Effort: M   Status: in-progress

T-157 left fog as ephemeral in-memory state — refresh / disconnect
discarded the whole exploration map.  This ticket lifts `seenEver` to
durable storage so reconnects start with the player's prior progress.

Persistence shape:
  - DB: `user_tile_fog (user_id uuid, tile_id text, bitmap bytea,
    updated_at timestamptz)` keyed by (user, tile).  Migration
    `0013_user_tile_fog.sql`; repo `PgUserTileFogRepo` mirrors the
    `PgHeritageRepo` upsert pattern.
  - Account service: two new endpoints under `/internal/user/:id/fog/:tileId`
    — `GET` returns the bitmap as `application/octet-stream` (404 if none),
    `PUT` writes the request body verbatim.  Service-secret gated like the
    other internal routes.
  - `AccountClient.getFog(userId, tileId)` / `saveFog(userId, tileId, bitmap)`.
  - Tile-server: after spawning the player, fetch fog and copy into
    `FogState.seenEver`; `pendingSnapshot` stays `true` so the next state
    message ships the hydrated bitmap to the client.  On disconnect (alive
    OR dead, before `world.destroy`), save the current `seenEver` back.
    Handoff path is intentionally not yet handled (rare in current dev mode).
  - Dev mode (no `accountClient`): noop — fog stays per-process as before.

Concurrency / size: 8 KB per (user, tile).  Upsert each disconnect — at
human play frequencies that's well under any DB pressure.  Buffer is
opaque to Postgres; the account service trusts what tile-server writes.

Done when: explore part of a tile, log out, log back in, the explored
area is immediately visible on join.  Tile-server logs `fog restored`
on hydration and surfaces save errors without blocking disconnect cleanup.

### T-163 · Weapon damage in prefab data + per-entity soft collision + floating names + HUD diagnostics
Effort: M   Status: done

Four small features bundled because they all flowed out of the same play
session.  Each is self-contained but the user noted them together, and
splitting hindsight tickets one-per-commit would just be ceremony.

**Damage on hit.** `deriveItemStats` in `packages/content/src/store.ts`
read `weight`, `armor`, `edible`, `illuminator`, `tool` from prefab
components but never `swingable` — so every equipped weapon's
`weaponStats.damage` was undefined and the `?? 0` in
`HealthHitHandler` zeroed every connected hit.  Unarmed worked because
it pulls from `gameConfig.combat.unarmed.damage` directly.

Fix:
  - Added `damage?: number` to `SwingableData` (types + valibot schema +
    server-only Swingable codec, with a presence byte so absent and
    explicit-zero round-trip distinctly).  Round-trip test got two new
    cases.
  - `deriveItemStats` now reads `swingable.damage` and exposes it as
    `stats.damage`, scaled by per-instance `quality`.
  - Populated all melee weapon prefabs with sensible base damages:
    stone_axe 12, stone_pickaxe 9, stone_hammer 14, iron_axe 22,
    iron_pickaxe 16, iron_sword 25.  `wooden_bow` left damage-less —
    bow_shot is projectile-driven, not melee.
  - Crafted iron items still carry per-instance `Stats` from the recipe
    formula (`head.sharpness * 30 + workstation.quality * 5` etc.); the
    prefab damage is the fallback.  Wiring an instance-Stats override
    into `ActionSystem` is a future ticket.

**Player ↔ entity soft collision.**  `PhysicsSystem` previously only
collided with terrain.  Reworked into a three-pass loop:

  1. Integrate every (Position + Velocity + InputState) entity into a
     local `Step[]` array (the existing per-entity body, just
     extracted).
  2. Pairwise XY separation — overlapping pairs each get pushed half the
     overlap along the connecting axis.  Pure position correction; no
     velocity damping (next-tick physics naturally re-runs).
  3. Commit the corrected positions via `world.set`.

  Brute-force O(N²) is fine: physics-active entities cap at < 100 in
  AoI; SpatialGrid would only pay off at much higher densities.  Radius
  is `gameConfig.physics.entityCollisionRadius` (0.4).  Z is untouched
  so jumping over entities still works.  Degenerate exact-overlap pairs
  are nudged along +X for determinism.

**Floating name labels.**  New networked `Name` component
(`ComponentType.name = 44`, `nameCodec` in `@voxim/codecs`).  Players
get their login name shipped via the new optional
`TileJoinRequest.displayName` field (client caches it under
`voxim.login_name` at sign-in); NPCs mirror their `NpcTemplate.displayName`
into `Name` at spawn.  Empty / missing names fall back to a
`Player-{id6}` stub on the server.  Client renders one camera-billboarded
`THREE.Sprite` per labelled entity, parented to the entity mesh group at
y = 2.2 with a translucent rounded-pill canvas texture.  Texture is
regenerated only on text change.  `disposeEntityMesh` and
`syncNameLabel` keep the sprite lifecycle pinned to the mesh's.

**HUD diagnostics.**  `BinaryStateMessage` gained one trailing u16,
`onlineCount`, sourced from the tile's session map.  Game.ts patches it
into a new `uiState.hudStats` slice plus a 500 ms-windowed FPS counter.
A small `HudStats` Preact component sits to the left of the minimap
(`top: 12, right: 220`), styled to match the minimap chrome.

Done when: starter stone_axe deals 12 damage, two players can't walk
through each other, every entity has a label above its head, and an
`fps / online` panel sits next to the minimap.

### T-162 · Geometric edge detection in `EdgePass`
Effort: S   Status: done

The Sobel pass in `edge_pass.ts` ran on luminance, normalised by local
mean brightness so day/night fired equally hard.  Side effect: the
±8 % per-cell brightness hash on terrain (`cellVariation` in
`terrain_mesh.ts`) became visible as diagonal dot rows on flat ground —
the normalised gradient on dark cells easily cleared `lumThreshold`,
and the 1-unit cell grid projects to ≈45° under the isometric camera.

Replaced with a depth-only detector that ignores colour entirely:
  - Sobel on linearised view-space depth (= -view.z), normalised by
    centre depth so a 1-unit step looks the same near and far —
    catches silhouettes against the background and terrain height steps.
  - 1 - cos(angle) between four "quadrant" view-space normals
    reconstructed via cross-products of asymmetric position derivatives
    (R/L × U/D) — catches creases between faces of different orientation.
  - `max(edgeD, edgeN) * edgeStrength` — whichever fires harder wins.
  - Sky pixels (depth ≥ 0.9999) skip the whole block; `vpos()` would
    explode there.

Tunables on the material are now `uDepthThreshold` (default 0.04 ≈
1-unit z-step at typical cam distance) and `uNormalThreshold` (default
0.10 ≈ 25° crease).  `lumThreshold` and the `luma()` helper are gone;
no other code referenced them.

Done when: flat terrain has no diagonal artifact rows, but building
silhouettes, terrain height steps, and corner creases still outline.

### T-164 · InstancePool refactor — Phase 1: primitive + voxel-geo extraction
Effort: M   Status: done   Commit: 21daefd

First of four phases that move all procedurally-placed instanced
rendering (forest decorations, server props, future rocks) onto a
single CPU-culled pool keyed by archetype.  Motivated by a 2026-05-07
profiling session: 1 327 draws / 2 M tris per frame, 23 ms GL, with
forest alone responsible for 7 936 InstancedMesh nodes covering
204 k instances (~25 instances/draw, well below the instancing
break-even).  Full design in `INSTANCE_POOL_PLAN.md` at the repo root.

This phase lands the primitive with no callers yet.

  - Extract `buildSubModelGeo`, `buildLocalDispGeo`, `mergeGeos` from
    `packages/client/src/render/prop_instance_pool.ts` into a new
    `packages/client/src/render/voxel_geo.ts`.  Update the imports in
    `prop_instance_pool.ts` and `forest_props.ts`.  No re-export
    bridge — the helpers' new home is the only home.
  - Add `packages/client/src/render/instance_pool.ts` exporting an
    `InstancePool` class with the API in the plan (`registerArchetype`,
    `add`, `remove`, `removeByPrefix`, `update`, `buildHoverShells`,
    `dispose`).  InstancedMeshes constructed by the pool use
    `frustumCulled = false`; visibility is owned by the pool, not
    Three.js.
  - Wire `this.instancePool = new InstancePool(this.scene)` in
    `GameRenderer`'s constructor and call `this.instancePool.update(visibleChunks)`
    inside `render()` just before the existing terrain-visibility loop
    is reused to compute the visible-chunks set.

Done when: `deno check packages/client/src/game.ts` passes; the game
runs and renders identically to before; the HUD draw/tris numbers are
unchanged because the new pool has zero handles.

### T-165 · InstancePool refactor — Phase 2: forest_props migration
Effort: M   Status: done   Commit: 21daefd

Rewrite `packages/client/src/render/forest_props.ts` so it registers
archetypes and per-tree handles into the InstancePool from T-164
instead of building per-chunk InstancedMeshes itself.

  - `decorateChunk` walks the kinds grid as today, but for each tree
    contribution it (a) calls `instancePool.registerArchetype("forest:" + def.id + "|" + matId, …)`
    once per (sub-model × material) pair, then (b) emits one handle
    per tree position keyed `"forest:cx,cy:lx,ly"` whose chunkKey is
    `"cx,cy"` and whose slots are the world matrices for each part.
  - Delete `geoCache`, `matCache`, `chunkMeshes` from the class — the
    pool owns them now.
  - `reset()` becomes `instancePool.removeByPrefix("forest:")` plus
    the existing `decorated`/`queue`/`active` cleanup.
  - The chunk-arrival queue and `start()`'s 8 ms-budget drain loop
    are preserved.

Done when: forests render pixel-identically (same trees, same
positions, same shadows, same canopyFade); HUD draws drop ~10× (660 →
~60 per pass); HUD tris number unchanged (same content, batched
differently); tile transition still cleans up the previous tile's
forest correctly.

### T-166 · InstancePool refactor — Phase 3: prop_instance_pool deletion
Effort: M   Status: done   Commit: 21daefd

Delete `packages/client/src/render/prop_instance_pool.ts` entirely.
Server-prop entities (ground items, ruins, resource nodes) register
with the InstancePool directly.

  - The static-prop branch in `GameRenderer.updateEntity()` (the
    `else` after the skeleton branch) registers archetypes via the
    pool, builds slots from the resolved sub-objects, and calls
    `instancePool.add(entityId, chunkKey, slots)` where `chunkKey =
    floor(worldPos.x / 32) + "," + floor(worldPos.z / 32)`.  Removal
    on entity destroy / AoI exit is `instancePool.remove(entityId)`.
  - The VELOCITY_EPSILON_SQ defer-until-settled gate is preserved
    verbatim.
  - `HoverOutlineRenderer` calls `instancePool.buildHoverShells(entityId)`
    instead of `propPool.buildHoverShells(entityId)`.  Behaviour
    identical: wrapper Meshes share pool-owned geometry/material and
    must not be disposed on cleanup beyond the wrapper itself.
  - `propPool` field on `GameRenderer`, `getPropPool()`, and every
    other reference to `PropInstancePool` are removed.
  - `propPositions.set(entityId, worldPos)` and the
    `interactionSystem.addStaticEntity(...)` registration stay where
    they are — pick-box handling is parallel to the pool, not part of
    it.

Done when: ground items, ruins, and resource nodes render with the
same position and rotation as before; hover outline still highlights
static props; no references to `PropInstancePool` or `prop_instance_pool.ts`
remain; HUD shows the prop_pool bucket folded into forest archetypes
or its own archetypes (down from 6 always-on draws to per-frame slice).

### T-167 · InstancePool refactor — Phase 4: perf validation + plan cleanup
Effort: S   Status: done   Commit: HEAD

Closeout for the four-phase refactor.  Numbers measured on the
user's machine in a forested area with shadows on:

  - **Before** (35 FPS): 1 327 draws, 2.07 M tris, 23 ms GL,
    7 936 forest InstancedMeshes (25 instances/draw average), the
    old `prop_instance_pool.ts` rendering all 4 096 slots every
    frame with `frustumCulled = false`.
  - **After**  (58 FPS): 421 draws, 2.5 M tris, 12.1 ms GL, 0.3 ms
    skeleton+IK, ping 25 ms, tick 20.0 Hz, 5 256 InstancePool
    handles spread across one InstancedMesh per archetype.

The 5×5 chunk window for InstancePool culling — 2-chunk radius
around the player — covers both the 120-unit shadow camera frustum
and the main camera's forward cone with no popping.  Terrain stays
at 9×9 since terrain meshes are cheap and a tighter window would
seam-pop visibly on flat ground.

The HUD diagnostics that drove the investigation stayed in: per-
section ms breakdown (sk+ik / trail / gl / post), draws and tris
counters, the "Bypass post-FX" / "Shadows" toggles, and the
`Log scene census` button.  A second commit (a5675f1) added
network and scene stats — ping, input lag, server tick rate,
inbound kbps, entity count, InstancePool handle count — to round
out the diagnostic surface.

Plan document `INSTANCE_POOL_PLAN.md` deleted in this commit.

Done.

### T-168 · Basic-item detail pass via per-prefab `modelScale`
Effort: M   Status: done

Sweep over hand-held items and small pickups: re-author every voxel
model at finer resolution and set `modelScale` on the prefab so the
physical size stays the same.  Hero weapons (sword, spear, bow,
crossbow) drop to `modelScale 0.25–0.33` (3–4× more voxels per axis,
enough to suggest a fuller, crossguard, recurve limbs, prod + string +
stirrup).  Tools and resources drop to `modelScale 0.5` (2× per axis).

  - Split shared models so iron and stone variants look different:
    `model_axe_basic` becomes the iron axe; new `model_axe_stone` and
    `model_pickaxe_stone` carry stone heads with leather binding.
  - Add prefabs for `iron_spear` (uses existing `thrust` action) and
    `wooden_crossbow` (uses existing `crossbow_shot`).  Add `model_bolt`
    (shorter than an arrow, broader head) and point `crossbow_shot`'s
    projectile at it instead of `model_arrow`.
  - Hitbox is auto-derived from voxels — no `hitbox` field in the
    refreshed model files.

Done when: every item under `prefabs/items/` has a `modelScale` set;
sword/spear/bow/crossbow render with recognisable detail; iron and
stone tool variants look distinct; `deno task gen-content` and
`deno check` are clean.

### T-169 · Human animation polish + walk-style variants
Effort: M   Status: done

Refresh every existing clip on the `human` skeleton with denser
keyframes (more in-betweens through each cycle) and asymmetric
secondary motion: idle gets a real breath cycle and slow weight
shift; walk gets heel-strike dorsiflexion, hip drop, counter-shoulder
roll, head bob and wrist follow-through; crouch + crouch_walk get a
slight asymmetric stance and listening head turn; roll picks up a
recovery overshoot before settling; death staggers torso/head timing
and adds a sideways head loll.

Add three locomotion variants for character / state expression:
  - `walk_slouch`: forward-tipped torso, head down, short stride,
    minimal arm swing — defeated / weary.
  - `walk_boast`: chest puffed back, head tilted up, exaggerated
    stride and shoulder roll — confident / threatening.
  - `walk_limp`: asymmetric stride favouring the left leg, right leg
    dragging, side-tilt toward injured side — wounded.

Wire `walk_limp` automatically: AnimationSystem picks it instead of
`walk` when `Health.current / Health.max < 0.30`.  `walk_slouch` and
`walk_boast` are authored content for future NPC archetypes / scripted
moments — they don't change behaviour by themselves.

Done when: idle and walk look noticeably more alive; a player at
< 30% health limps without further wiring; `deno check` is clean.

### T-170 · Held-weapon grip anchor + roll Y-lift + A/D fix
Effort: S   Status: done

Three independent bugs surfaced once T-168/T-169 were in front of the
camera:

  - **Weapons held wrong.**  Item models had `z=0` at the pommel/butt,
    so the renderer (which anchors the model origin at the wrist)
    placed the wrist at the END of the weapon and the blade extended
    a full 2m past the hand.  Re-author every held model so model
    `z=0` sits inside the grip — pommel/butt go into negative z, blade
    extends into positive z.  `bladeDimensions.length` (`maxZ*scale`)
    now correctly measures grip-to-tip.

  - **Dodge roll dipped through the floor.**  Animation tracks rotate
    bones but cannot translate the root, so a full forward somersault
    around the feet pivot swings the head below ground.  Renderer now
    reads the active "roll" layer's `time` and adds a `sin(πt) ·
    1.6 · modelScale · weight` Y offset to the entity group's position
    so the body clears the ground at mid-roll.  Stored on
    `EntityMeshGroup.rollLiftY`; applied to both the local-prediction
    and remote-interpolation position writes.

  - **A and D were swapped.**  The right-vector formula was
    `(sin f, -cos f)` (clockwise of facing in math-y-up convention),
    but with the top-down camera using world +Y as screen-up, that
    sent strafe-D into the screen-LEFT direction.  Flipped to
    `(-sin f, cos f)` so `D` strafes to the player's visual right and
    `A` to the left.

Done when: a held sword visibly hangs from the grip not the pommel; a
forward roll stays above ground; pressing D moves the player to the
right of where the cursor points.

### T-171 · Animation library + per-prefab slot assignment + devtool
Effort: L   Status: done

Three layers landed together:

  - **Animation library.**  `packages/content/data/anim_library/` —
    one file per clip.  Two file shapes: plain (`AnimationClip` +
    `_skeleton`/`_source`) and compound (`_kind: additive | crossfade
    | phase_shift` + recipe).  Compounds get **baked into plain clips
    at content load**, so `AnimationSystem` and the bone evaluator
    stay unchanged — no runtime support for compound clips needed.
    Library clips with the same `id` as a skeleton's inline clip
    override the inline one (that's how the devtool import workflow
    swaps a hand-authored `walk` for an imported one).  Loader work
    lives in `packages/content/src/anim_library.ts`.

  - **Per-prefab slot indirection.**  New `Prefab.animationSlots`
    field maps slot names (`"walk"`, `"idle"`, ...) to clip ids on
    the entity's skeleton.  `Spawner` writes a server-only
    `AnimationSlots` component from this; `AnimationSystem` looks up
    `slots["walk"]` instead of hard-coding `"walk"`.  Two prefabs
    sharing one skeleton can now play different walks — `walk_zombie`
    on a zombie, `walk_normal` on the player — without forking the
    skeleton.  Absent component / absent slot falls through to the
    slot name as the clip id, so existing prefabs keep working.

  - **Devtool: Library tab.**  New top-level tab in the voxel editor
    with four sub-workflows:
      * **Browse** — list library + inline clips per skeleton, with a
        delete button.  Shows when an inline clip is overridden.
      * **Import GLB** — file picker → animation picker → bone-map
        preset (quaternius / mixamo / cmu) → previews how many bones
        match vs. drop → saves as a `LibraryClipPlain`.
      * **Mix** — author a compound clip recipe (additive / crossfade
        / phase-shift), pick base + overlay, set weight / mask, save.
      * **Assign** — pick a prefab, edit its slot → clipId map (as a
        dropdown of clips known to the prefab's skeleton), save back
        to the prefab JSON.

    Devtool writes go through new POST/DELETE endpoints in
    `scripts/serve_devtools.ts`, restricted to `anim_library/` and
    `prefabs/`.  The browser uses three.js's GLTFLoader (already a
    dep) for parsing GLBs — no new toolchain needed.

Done when: a Quaternius GLB can be imported via the UI, the resulting
clip appears in Browse, an Assign edit on a prefab updates the
prefab JSON, and the tile server picks the new clip up after restart.

---

## Player UX

### T-071 · Character creation screen
Effort: M   Status: todo

On first connection (or after dynasty wipe), show a character creation screen: species selection
(visual only; minor passive trait), starting Lore fragment selection (from a small initial set).
Done when: new player completes character creation and spawns as a properly initialised entity.

### T-072 · Respawn / heir flow UI
Effort: M   Status: todo

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

### T-073 · Inventory UI
Effort: M   Status: todo

Basic inventory panel: grid of carried items, item info on hover, drag-to-equip. Weight bar
showing current vs. max encumbrance. Must reflect real-time updates from server state.
Done when: player can view, equip, and drop items from inventory.

### T-074 · Main menu / title screen
Effort: S   Status: todo

Minimal title screen: connect button (triggers gateway handshake), server status indicator.
No account system in scope for now — identity from a locally-stored player ID.
Done when: player can start the game from a title screen without direct URL manipulation.

### T-075 · Trader interaction UI
Effort: S   Status: todo

When interacting with a trader NPC, show a buy/sell panel: trader's goods + prices on one side,
player's inventory on the other. Transaction deducts/adds physical coin items (T-031).
Done when: player can buy and sell items with a trader NPC via a UI panel.

### T-076 · Job board UI
Effort: M   Status: todo

Panel for the hiring workbench: list of current jobs (type, priority, status), add/remove/
reprioritise jobs. Show which NPCs are assigned to which jobs. Simple, not real-time — refreshes
on open.
Done when: player can post and manage jobs via the workbench UI.

---

## Heritage & Dynasty

### T-077 · Family library — tome storage at workbench
Effort: M   Status: todo

A special chest entity associated with the family workbench serves as the library. Stores Lore
tome items (T-018). Persists across character deaths (it is a world entity, not character
inventory). Heir can interact with it during the respawn ritual.
Done when: tomes placed in the library chest persist after character death; heir can access them.

### T-078 · Family treasury — gear storage across deaths
Effort: S   Status: todo

A second chest entity at the family workbench serves as the treasury. Stores equipment items.
Same persistence model as the library (T-077). Heir equips from here during respawn ritual.
Done when: items stored in treasury persist across deaths; heir can equip them.

### T-079 · Heir spawn at family workbench
Effort: M   Status: todo

On character death, instead of direct respawn, create a new character entity at the family
workbench position. If the workbench was destroyed, heir spawns at a fallback location (tile
origin) in a weakened state.
Done when: death spawns an heir at the workbench; no workbench = displaced spawn.

### T-080 · Dynasty reputation persistence in NPC world
Effort: M   Status: todo

NPC city relationship maps (T-044) store reputation by dynasty ID, not character ID. On heir
spawn, the new character inherits the dynasty's relationship standing with all cities. Actions
by previous characters (king-killing, trade betrayals) persist as dynasty history.
Done when: a new heir faces the same NPC city attitudes as their predecessor.

---

## Territorial Control

### T-081 · Workbench ownership + NPC deauthorisation on destruction
Effort: S   Status: todo

`WorkbenchOwner` component already exists. When a workbench entity is destroyed, emit a
`WorkbenchDestroyed` event. NPCs assigned to that workbench receive the event, clear their
job board association, and enter idle/neutral state.
Done when: destroying a workbench causes its NPCs to go neutral within a configurable number
of ticks.

### T-082 · Base capture flow — place new workbench to claim
Effort: S   Status: todo

After an enemy workbench is destroyed (T-081), the attacker places their own workbench at the
location. Placed workbench assigns its owner's dynasty ID. Former NPCs, now neutral, can be
re-hired via the new workbench.
Done when: capturing a base by destroying and replacing the workbench gives the attacker control
of the management layer.

### T-083 · Family-tagged asset persistence after capture
Effort: S   Status: todo

Deployable entities (chests, furniture, structures built by a dynasty) carry a `DynastyTag`
component. After a base capture, tagged assets remain in the world but their dynasty tag
persists — they are not transferred to the new owner automatically. This is a persistent
grievance/motivation mechanic.
Done when: a captured base still has the original dynasty's tagged assets; a new owner does not
automatically inherit them.

---

## Species

### T-084 · Species component with minor passive trait
Effort: S   Status: todo

Add a `Species` component: `{ speciesId: string }`. Add species definitions to a new
`species.json` data file. Each species has a small passive trait (e.g. dwarf: +5% base health;
human: no modifier). Species is set at character creation (T-071).
Done when: species component is present on player entities; passive trait applies to base stats.

### T-085 · Species visual variants — skeleton archetype mapping
Effort: M   Status: todo

Species definitions include a `skeletonArchetype` field that maps to a different skeleton
definition. Dwarf skeleton is shorter and wider; human is the default. Visual differentiation
without new animations — same animation set, different bone proportions.
Done when: a dwarf character renders with dwarf skeleton proportions; animations play on both.

---

## Item Durability

### T-086 · Item durability scalar component
Effort: S   Status: todo

Add `Durability: { current: number; max: number }` component to all equippable items at spawn.
This is independent of material quality — two steel swords can be at different durability states.
Done when: equipped items have a durability component; it serialises and syncs to client.

### T-087 · Durability drain from use (combat + crafting)
Effort: S   Status: todo

Each successful combat hit with a weapon reduces its durability by a configurable amount.
Crafting tool use similarly drains the tool. At zero durability, item becomes unusable.
Done when: weapons and tools degrade from use; reaching zero makes them inoperable.

### T-088 · Durability repair via crafting workstation
Effort: S   Status: todo

Add a repair recipe type: item + repair material → restored durability. Repair at the
appropriate workstation (anvil for metal, workbench for wood). Repair restores a fixed amount,
not full — repeated repairs compound material cost.
Done when: player can repair a degraded item at a workstation to partially restore durability.

---

## World / Environment

### T-089 · Light emission system (torch, fireplace, hearth)
Effort: M   Status: done   Commit: 57587f4

`LightEmitter` (wireId 31) and `DarknessModifier` (wireId 32) networked components.
Light level is virtual state — `getLightAt(world, x, y)` is a pure function over ECS queries, no
precomputed grid. EquipmentSystem writes LightEmitter when a torch/lantern is equipped (driven by
`baseStats.lightColor/Intensity/Radius/Flicker` on the item template). `spawnEntity()` writes
LightEmitter for placed emitters (campfire, hearth) via `components.lightEmitter` on EntityTemplate.
Client: `LightManager` attaches `THREE.PointLight` to entity groups; flicker via double-sinusoid
oscillator. Protocol note: component-removal delta not yet implemented — zero-intensity write used
as "off" sentinel until wire removal is added (see T-097).
Done when: a placed torch emits visible light that fades with distance; campfire casts warm
ambient glow; lights respond to day/night cycle.

### T-090 · Room detection and enclosed-wall system
Effort: L   Status: todo

A room is a contiguous enclosed volume formed by placed wall/floor blueprint structures.
Room detection runs as a server-side flood-fill over the structure grid after each build event.
Detected rooms receive a `RoomTag` entity with area, enclosure quality (0–1), and an interior
cell set. Downstream consumers: warmth bonus (fireplaces raise interior temperature), shelter
bonus (reduces corruption gain), NPC pathfinding prefers enclosed spaces for settling.
Done when: placing walls that form a closed loop creates a detectable room entity; room dissolves
when a wall is removed; interior cells are queryable by other systems.

---

## UI / Interaction

### T-091 · Workstation recipe browser and selection UI
Effort: M   Status: todo

Currently the workstation CraftingPanel only shows auto-matched items; there is no way to
browse or select a recipe. The workstation needs a recipe list panel showing all recipes valid
for this station type. Clicking a recipe locks it as the `activeRecipeId` on WorkstationBuffer
(server command via CommandType.SelectRecipe). Input slots then show required ingredients;
items placed that don't match the locked recipe are rejected. Time-based recipes (smelt, cook)
auto-start once all ingredients are present.
Done when: player can open a workstation, browse its recipe list, select one, and place
matching items to start crafting.

### T-092 · Blade dimensions derived from equipped item voxel model
Effort: M   Status: done   Commit: (pending)

The hilt (from swingPath keyframes) is the anchor; the weapon model AABB drives blade geometry.
Model Z axis = blade axis (voxel Z → Three.js Y via anchor quaternion). `bladeLength = aabb.maxZ
× entityScale`, `bladeRadius = minCrossSection/2 × scale`. Unarmed uses constants in ActionSystem.
`WeaponSwingPath.defaultBladeLength/defaultBladeRadius` and `DerivedItemStats.bladeLength/bladeRadius`
removed — no per-action or per-item overrides. Swept-capsule hit detection (hilt→tip segment) unchanged.
Client caches blade dimensions on `EntityMeshGroup.bladeDimensions` when weapon model loads in
`syncHandSlot`. Volumetric trail covered by T-099.

### T-099 · Volumetric weapon trail
Effort: S   Status: done   Commit: (pending)

Trail now records the full weapon blade segment (hilt + tip in world space) plus a perpendicular
direction and half cross-section width (`halfCross` from model AABB). `rebuildTrailMesh` renders
a closed tube: 4 verts per slice (hiltL, hiltR, tipR, tipL), 4 quad faces per slice pair (left
side, right side, near face, far face). Shows the physical space the blade swept through rather
than a tip-only ribbon. Trail width driven by the widest AABB cross-section dimension.

### T-128 · Input system rewrite — Intent router + charged attacks + build polyline
Effort: L   Status: done   (delivered as T-129 + T-130 + T-131)

Replace the current ad-hoc click/key surface with a single Intent-based
pipeline. Add charged attacks (server-decided, charge_ms on the wire), a
proper Mode state machine for building, polyline-tool blueprints (walls
placed as connected segments), explicit hover-driven interact (E key), and
the matching server cleanup (drop the INTERACT bit, drop InteractCooldown,
add a PickUp command).

Today's surface — three independent pipelines (canvas mouse via
InputController; UI clicks via Preact onClick; drag via dragSystem global
listeners) — collapses into one router. Mode-switching (buildMode /
radial-open / drag-active) lives in a translator, not embedded in the
input listener. UI handlers and world handlers register against the same
router with priority + claim semantics; an open panel doesn't block
canvas clicks unless it actually sits under the cursor.

Architecture (terminology used across T-129..T-131):

  RawEvent              — kbd/mouse/touch event, no game knowledge
  InputCapture          — owns the global event listeners, emits RawEvent
  Context               — live state read by the translator:
                            HoverState (entity + terrain cell at cursor),
                            HoldState  (LMB held since when, charge),
                            Mode       (normal | radial-open | build),
                            ModalStack (currently open panels)
  IntentTranslator      — (RawEvent + Context) → typed Intent[]
                          all mode logic lives here
  Intent                — typed union: world-main-action, interact,
                          block-start/end, mode-enter-build,
                          build-cursor-move, build-place-anchor,
                          mode-exit-build, ui-* actions (existing UIAction
                          shapes get folded in)
  IntentRouter          — handlers register with priority + claim();
                          first claim wins; unclaimed intents fall through.
                          UI handlers and world handlers share the chain.

Wire-format change (T-129):
- InputDatagram extends from 36 → 38 bytes (`u16 chargeMs`).
- ACTION_INTERACT bit slot retired; comment-reserved.
- New `CommandType.PickUp { entityId }`.
- `Swingable` schema: `{ actions: Array<{ actionId, chargeMin, chargeMax }> }`
  replaces the single `weaponActionId`. Server picks the first action
  whose `[chargeMin, chargeMax]` interval contains chargeMs. Same shape
  for melee (two-tier light/heavy) and ranged (one action that reads
  chargeMs internally for projectile speed scaling). `chargeMin` defaults
  to 0 and `chargeMax` to 65535 (clipped at the wire).

What to delete (per CLAUDE.md "refactors replace"):
- `InputController` class entirely. Its responsibilities split into
  InputCapture (low-level events) + IntentTranslator (mode + charge logic).
- `ACTION_INTERACT` flag + every reference. Slot number stays a comment.
- `InteractCooldown` server-only component (was the throttle for the
  retired INTERACT bit). Drop from registry, components/items.ts, handoff.ts.
- `CraftingSystem.run()`'s INTERACT-load branch (the "shove inventory[0]
  into nearest workstation buffer" code). The drag-into-WorkstationPanel
  flow has replaced it since T-124.
- `UIAction` type's overlap with Intent — they merge; UIAction either
  becomes Intent or is fully absorbed (TBD during T-130).
- `buildMode` boolean on InputController, `onBuildPlace`/`onBuildOpenMenu`
  callback hooks — Mode state machine in the translator replaces them.

Phases T-129..T-131 break the work out so each commit ships standalone.

### T-129 · Server: chargeMs wire field, server-decided actions, drop INTERACT
Effort: M   Status: done   Commit: 3c80954   Phase 1 of T-128

Wire + server-side groundwork. Lands without the client input rewrite —
charged attacks are mechanically possible the moment this lands; the
client just sends `chargeMs = 0` until T-130 wires up the timing.

- `packages/protocol/src/messages.ts` — `InputDatagram` gains `chargeMs:
  u16`. Total size 36 → 38 bytes. ACTION_INTERACT (`1 << 3`) retired —
  bit slot stays a comment. New `CommandType.PickUp = 21` with payload
  `string entityId`.
- `packages/protocol/src/codecs.ts` — InputDatagram codec extended;
  encode/decode for the PickUp command.
- `packages/codecs/src/components.ts` — `inputStateCodec` extended to
  carry `chargeMs`.
- `packages/tile-server/src/components/items.ts` — delete `InteractCooldown`.
- `packages/tile-server/src/component_registry.ts` — drop InteractCooldown.
- `packages/tile-server/src/handoff.ts` — drop interactCooldown serialisation.
- `packages/tile-server/src/components/item_behaviours.ts` — `Swingable`
  schema becomes `{ actions: { actionId, chargeMin?, chargeMax? }[] }`.
  The matcher walks `actions` in order and picks the first whose
  [chargeMin, chargeMax] contains the player's chargeMs. Implicit defaults:
  chargeMin=0, chargeMax=65535.
- `packages/tile-server/src/systems/action.ts` — when starting a swing,
  read `InputState.chargeMs` and the equipped weapon's `swingable.actions`
  to pick the action variant; rest unchanged.
- `packages/tile-server/src/systems/crafting.ts` — delete the
  ACTION_INTERACT-driven buffer-load branch in `run()` (the for-loop
  block that walks players, checks the bit, finds nearest workstation,
  appends inventory[0] into the buffer). LoadWorkstation command
  remains the only path.
- New `CommandType.PickUp` handler — picks up the targeted ground item
  (ItemData entity) into the player's Inventory if the entity is within
  configured pickup range. Handler lives next to LoadWorkstation/
  TakeWorkstation in CraftingSystem (it's the same locality of inventory
  manipulation), or factor a new `InventoryCommandSystem` if cleaner.
- Content authoring: every weapon prefab with
  `swingable: { weaponActionId: X }` becomes
  `swingable: { actions: [{ actionId: X }] }` (no charge ranges →
  always-pick first). One demonstration weapon — iron_sword — gets the
  light/heavy split:
  ```
  swingable: { actions: [
    { actionId: "slash",    chargeMax: 200 },
    { actionId: "overhead", chargeMin: 200 }
  ] }
  ```
  All other weapons stay single-action.
- Client-side: only the InputController + InputDatagram encoder
  changes — send `chargeMs = 0` for now. The actual hold-and-release
  timing comes in T-130.

Done when: server boots clean against the new wire format; swinging a
sword produces "slash" today (chargeMs=0); no ACTION_INTERACT references
remain (`grep ACTION_INTERACT packages/` is empty); no InteractCooldown
references remain; crafting system's run() no longer mentions INTERACT.

### T-130 · Client: input system rewrite — InputCapture / IntentRouter / Mode / charge bar
Effort: L   Status: done   Commit: 84adcd0   Phase 2 of T-128

The big landing. Replaces InputController + the scattered Preact click
plumbing with the Intent pipeline.

New modules under `packages/client/src/input/`:
- `input_capture.ts` — owns `document` mouse/keyboard listeners. Emits
  `RawEvent { kind, button, key, canvasPos, target, t }`. The `target`
  field carries the original DOM EventTarget so the translator can
  distinguish UI clicks from canvas clicks. No game knowledge.
- `context.ts` — exports a `Context` object aggregating four reactive
  slices: `HoverState` (entity + terrain cell), `HoldState` (LMB held
  since), `Mode` (normal | radial | build), `ModalStack` (which panels
  are open). Slices are independent signals so consumers can subscribe
  fine-grained.
- `intent_translator.ts` — pure function `(RawEvent, Context) →
  Intent[]`. All mode-dependent logic concentrates here.
- `intent_router.ts` — registry of `IntentHandler { id, priority,
  claim(intent): boolean }`. First claim wins; consumed intents stop
  propagating.
- `intents.ts` — typed union of every intent shape.

Existing flows migrated (no parallel-system phase):
- `InputController` deleted. Game.ts no longer wires `onLmbClick` /
  `onBuildPlace` / `onBuildOpenMenu`; instead it registers handlers with
  the router for `world-main-action`, `block-start/end`, `interact`,
  `mode-enter-build`, etc.
- `InventoryPanel`, `EquipmentPanel`, `WorkstationPanel`, `RadialMenu`,
  `ContextMenu` — their onClick / onMouseDown handlers become
  `intentRouter.dispatch({ kind: "ui-...", ... })`. The shared `dragSystem`
  becomes a router handler too (claims `drag-start`, manages the document
  mousemove/mouseup loop internally).
- `UIAction` either folds into `Intent` (single union) or stays as a
  nested type — pick whichever produces less ceremony at registration
  sites. Lean toward single union with a `kind: "ui-..."` prefix
  convention to keep room for non-UI intents.

Charge attacks (client side):
- `HoldState.lmb = { downAtMs, weaponPrefabId }` set on LMB-down outside
  build mode, cleared on release.
- LMB-up emits `world-main-action { chargeMs }`.
- Default handler reads the player's equipped weapon, mirrors the server's
  `swingable.actions` lookup to pick the predicted action client-side
  (so the predictor stays in sync once predictor learns about swings),
  and sends an `InputDatagram` with ACTION_USE_SKILL set + chargeMs.
- New `ChargeBar` UI component — small fill bar above/under the player
  cursor showing chargeMs progress against the weapon's first
  `chargeMax` threshold. Reads `HoldState.lmb` reactively. Hidden when
  no charge active.

E-key flow:
- E-down → translator emits `interact { hoverTarget }`.
- Default `InteractHandler` switches on hoverTarget kind:
  - `entity = ground-item` → send `CommandType.PickUp { entityId }`
  - `entity = workstation`  → `openPanel("workstation")` + mirror entity
  - `entity = anything else` → no-op
  - no hover                → no-op.
- Removes the legacy server-side INTERACT path (already gone in T-129);
  the auto-pickup ItemPickupSystem stays in place for ambient
  collection within radius.

Modal precedence (per the agreed rule):
- The router does NOT special-case open panels. UI handlers register at
  high priority and naturally claim events that land on UI DOM nodes.
- World handlers register at lower priority and run for events that
  bubble through.
- Translator skips world intents when `event.target` is inside `#ui` AND
  some UI handler claimed the corresponding ui-* intent.

Done when: `grep InputController packages/client` is empty; LMB on
canvas attacks; LMB-hold then release sends a chargeMs; E over a hovered
ground item picks it up via PickUp command; E over a workstation opens
the panel; clicking a panel button doesn't attack the world; the charge
bar fills while LMB is held.

### T-131 · Build mode polyline + ghost preview
Effort: M   Status: done   Phase 3 of T-128

Build mode becomes a stateful tool with proper preview rendering and a
chain-placement workflow for line blueprints (walls).

Mode definition:
```
Mode = "normal" | "radial-open" | "build"
Mode.build = {
  blueprintId: string,
  tool: "single" | "polyline",
  polyline?: { lastAnchor: WorldCell }   // null until first click
}
```

Blueprint declaration:
- `Placeable` component gains `tool: "single" | "polyline"`. Default
  "single" when omitted. wall blueprints set `"polyline"`.

Mode entry/exit:
- RMB-down with hammer equipped → emits `mode-open-radial`.
- Radial commit → `mode-enter-build { blueprintId }` → Mode = build.
- Hammer unequipped → `mode-exit-build` (auto). Polyline anchors
  discarded silently.
- ESC while in build → `mode-exit-build`. Polyline anchors discarded.
- Re-opening the radial discards polyline implicitly (same as ESC).

In build mode, intents:
- `build-cursor-move { worldCell }` — fires per frame while in build
  mode; ghost renderer subscribes.
- `build-place { worldCell }` — emitted on LMB.
  - tool="single": send Place command, do not change mode.
  - tool="polyline": if no anchor yet, set lastAnchor = worldCell (no
    placement). If anchor exists, send Place commands for each cell on
    the segment from lastAnchor → worldCell (Bresenham line over grid),
    then update lastAnchor = worldCell. Each segment commits as it's
    drawn — no staging, no confirm.
- `build-undo` — emitted on RMB tap.
  - if polyline anchors active: pop the lastAnchor (no server side-effect;
    next click re-anchors fresh).
  - else: `mode-exit-build`.
- `build-cancel` — emitted on ESC. Same as exit.

Ghost rendering (renderer-side):
- New module `client/src/render/build_ghost.ts`. Subscribes to Mode +
  cursor cell. Renders:
  - tool="single": a wireframe outline of the blueprint's footprint at
    cursor cell.
  - tool="polyline" without anchor: same outline as single.
  - tool="polyline" with anchor: a ribbon/line of outlines from
    lastAnchor cell → cursor cell, one outline per cell along the
    Bresenham path. Highlight cursor cell brighter so the player sees
    the next-anchor target.
- Material: thin emissive line shader, accent colour from the theme
  palette.

Content updates:
- `wood_wall`, `stone_wall` blueprint prefabs add
  `placeable: { ..., tool: "polyline" }`. Existing `placeable.alignment`
  remains "cell-aligned".
- All other placeable prefabs (kits, doors, floors) implicitly default
  to `"single"`.

Future work (out of scope for T-131):
- Blueprint deletion via "right-click on a placed blueprint" intent.
- Rectangle / fill tools (would add new tool values + intent emitters).
- Build-mode HUD chip showing the active blueprint id.

Done when: equipping a hammer + RMB opens the radial; selecting "wood
wall" enters build mode with a polyline ghost; LMB places the first
anchor (no segment yet); LMB again places a wall segment from anchor to
cursor and re-anchors at the new cell; RMB tap pops the anchor and
returns to free-cursor preview; ESC exits build mode; unequipping the
hammer also exits.

## Housing

### T-093 · Housing system — player-owned structures as persistent home
Effort: L   Status: todo

A house is a enclosed structure (walls + floor + roof, built via the blueprint system) that a
dynasty claims as their home base. Claiming converts a completed enclosure into a `HouseEntity`
tagged with the dynasty ID. The house is the social and mechanical anchor for a dynasty:

**Claiming:** Player interacts with the interior of a fully enclosed structure (detected via
T-090 room flood-fill) to claim it. Requires a placed family workbench (T-038) inside. A
structure can only be claimed by one dynasty. Claiming transfers the structure's wall/floor
entities to the dynasty's tag (T-083).

**Shelter mechanics:** Interior cells of a claimed house provide: corruption gain suppression,
warmth bonus (amplified further if a hearth/campfire is inside, T-089), and a safe-sleep
anchor for NPCs (T-039). These are computed from the `RoomTag` interior cell set (T-090).

**Persistence:** House ownership persists across server restarts as part of the save system.
On heir spawn (T-079), heir always appears inside the family house if it still stands.

**Destruction / capture:** Destroying enough walls dissolves the enclosure (T-090), which
dissolves the `HouseEntity`. The dynasty loses its home anchor. A new claimant can rebuild
and re-claim. This is the base-capture loop (T-082) applied to housing.

**Furniture:** Deployable items (bed, shelf, chest, hearth) can be placed inside. Furniture
carries the dynasty tag. Furniture items are defined in item_templates.json with a
`deployable: true` flag and an entity template for the placed form.

Done when: a player can build a fully enclosed structure, claim it as home, gain shelter
bonuses inside, and lose the claim when the structure is sufficiently destroyed.

---

## Engine / Netcode

### T-094 · Discriminated union for ComponentDef — wireId required on networked components
Effort: M   Status: done

`ComponentDef` currently has `networked: boolean` but no wire ID on the type itself. Adding a
new networked component requires touching two separate places (the def file + `COMPONENT_REGISTRY`)
and forgetting the registry causes silent delta loss.

**Change `ComponentDef` in `@voxim/engine` to a discriminated union:**

```typescript
export interface NetworkedComponentDef<T, N extends string = string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  readonly networked: true;
  readonly wireId: number;  // stable wire format ID, never reuse
}

export interface ServerOnlyComponentDef<T, N extends string = string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  readonly networked: false;
}

export type ComponentDef<T, N extends string = string> =
  | NetworkedComponentDef<T, N>
  | ServerOnlyComponentDef<T, N>;
```

`defineComponent()` gets two overloads: one requiring `wireId` when networked (default), one
accepting `networked: false` without it.

**Cascade changes:**
- All ~28 networked component defs: add `wireId: ComponentType.X`
- All ~6 server-only defs: add `networked: false` explicitly (already set, just becomes
  the discriminant)
- `COMPONENT_REGISTRY` entries: drop `typeId` field (now lives on the def)
- `buildDeltaMap` in `server.ts`: replace `COMPONENT_NAME_TO_TYPE.get(entry.token.name)`
  lookup with `entry.token.wireId` directly
- `buildSpawnComponents` in `aoi.ts`: replace `COMPONENT_NAME_TO_TYPE.get(def.name)`
  with `def.wireId`
- `DEF_BY_TYPE_ID` derivation: `new Map(NETWORKED_DEFS.map(d => [d.wireId, d]))`
- Remove the startup assertion added in d372aef (TypeScript makes it redundant)
- Remove `COMPONENT_NAME_TO_TYPE` from `server.ts` import (no longer used there)

Done when: `deno check` passes, adding a networked component without `wireId` is a
compile error, and server-only components cannot have `wireId`.


### T-097 · Wire protocol: component removal delta
Effort: S   Status: todo

**The problem.** `BinaryStateMessage` currently carries `spawns`, `deltas` (component writes),
and `destroys` (entity removals).  There is no message for removing a single component from a
living entity.  When a component is removed via `world.remove()`, the client never learns about it
— its `EntityState` retains the stale value until the entity leaves and re-enters AoI.

**Known example: T-089 `LightEmitter`.** When a player unequips a torch, `EquipmentSystem` calls
`world.set(entityId, LightEmitter, { intensity: 0, radius: 0, ... })` instead of `world.remove()`
to signal "light off" to the client.  The component persists in ECS state with sentinel values.
This is a workaround, not a proper solution — it leaves garbage data in the ECS and requires every
consumer of `LightEmitter` to guard against `intensity <= 0`.

**Decision needed.** Before implementing, weigh:
- Extend `BinaryStateMessage` with `componentRemovals: { entityId: string; componentType: number }[]`.
  Clean, explicit, low overhead per removal.
- Alternatively, tolerate sentinel-value conventions for sparse components (simpler protocol,
  higher call-site burden).

**If wire removal is added:**
1. Add `componentRemovals` to `BinaryStateMessage` and update `binaryStateMessageCodec`.
2. Server: collect `changeset.removals` for networked defs and encode them alongside deltas.
3. Client: `ClientWorld.applyRemoval(entityId, componentType)` clears the field in `EntityState`.
4. Replace the `intensity: 0` sentinel in `EquipmentSystem._updateLightEmitter()` with a real
   `world.remove(entityId, LightEmitter)` call.
5. Remove the `intensity <= 0` guard from `getLightAt()` and `LightManager.sync()`.

Done when: a protocol decision is recorded here; if wire removal is chosen, all five steps above
are complete and `LightEmitter` is the first component to use the new path.
Effort: M   Status: done   Commit: 38e1462

All content previously stored in large flat JSON arrays has been split into
one file per item under typed subdirectories.  Singletons (game_config.json,
concept_verb_matrix.json, etc.) stay as flat files.

**New directory layout under `packages/content/data/`:**
- `models/{id}.json` — 69 model definitions
- `skeletons/{id}.json` — skeleton rigs
- `items/{id}.json` — item templates (was item_templates.json)
- `templates/{id}.json` — entity templates (was entity_templates.json)
- `npcs/{id}.json` — NPC templates
- `weapon_actions/{id}.json` — weapon swing definitions
- `recipes/{id}.json`
- `structures/{id}.json`
- `lore/{id}.json` — lore fragments
- `materials/{name}.json` — material definitions (numeric id stays in file)

**Loader** (`loader.ts`): switched from `readJson(dir, "file.json")` to
`readJsonDir(dir, "subdir")` which scans the directory, sorts by filename
for deterministic order, and loads each file as one item.

**Client aggregation**: since the browser bundle can't use Deno.readDir, two
generated TypeScript files aggregate the per-item imports for static bundling:
`weapon_actions_static.ts` and `item_templates_static.ts`.  Run
`deno task gen-content` after adding/renaming data files.

---

## Procedural Characters

### T-096 · Skeleton morph params — seed-driven body proportion variation
Effort: M   Status: done   Commit: (pending)

Add a `morphParams` array to `SkeletonDef` that declares named scalar parameters
(e.g. `armLength`, `legLength`, `torsoHeight`, `shoulderWidth`), each mapping
to a set of bone IDs, a rest-axis (`x`/`y`/`z`), and a `[min, max]` multiplier
range.  `resolveMorphParams(skeleton, seed)` samples each param via a PRNG stream
derived from `ModelRef.seed` (XOR-separated from the pool-selection stream so the
two don't alias).  Resolved values are applied in `solveSkeleton()` (server,
hitboxes) and `upgradeToSkeletonModel()` (client, Three.js bone Groups) — same
seed produces identical proportions on both sides, no codec changes needed.

Done when:
- `MorphParamDef` type defined in `types.ts`, `morphParams?` on `SkeletonDef`
- `resolveMorphParams()` exported from `@voxim/content`
- `solveSkeleton()` accepts optional `morphParams` and scales per-bone rest offsets
- `upgradeToSkeletonModel()` accepts optional `morphParams` and scales bone positions
- `HitboxSystem` and `spawner.ts` compute and forward morph params from `ModelRef.seed`
- `human.json` skeleton declares four params: `armLength`, `legLength`, `torsoHeight`, `shoulderWidth`
- `deno check` passes clean

**Deleted**: `model_hitboxes.json` (was never read by the loader — orphaned
leftover from a superseded hitbox system).

---

## Devtools

### T-098 · Comprehensive debug panel rework
Effort: M   Status: done   Commit: fe646e1

The debug panel in `DebugPanel.tsx` is growing ad-hoc. The existing `GiveItemSection`
(filter input → scrollable item list → quantity → button per item) establishes the right
pattern: a self-contained `Section` component, isolated signals for local state, actions
dispatched via `UIAction` to `game.ts`, server-side handler on `CommandType`. New sections
should follow that same shape.

Planned sections (this list will grow — add new ones here before implementing):
- **Set time of day** — slider or input for world clock hour; dispatches a `debug_set_time`
  action; server command sets `WorldClock` directly
- **Spawn NPC** — filterable list of NPC template IDs; quantity input; dispatches
  `debug_spawn_npc`; server spawns at player position
- **Set stat** — dropdown (health / stamina / hunger / …) + numeric input; dispatches
  `debug_set_stat`
- **Teleport** — X/Z coordinate inputs; dispatches `debug_teleport`

Done when:
- `DebugPanel.tsx` is restructured so each capability is a self-contained `Section`
  component following the `GiveItemSection` pattern (local signals, `onAction` dispatch)
- `UIAction` union extended with new debug action variants
- `game.ts` `handleAction` routes each new action to a `CommandType` send
- Server-side command handlers implemented for each new action
- Existing give-item flow untouched and still working

Done when: `deno check` passes, adding a new item is a single JSON file drop.

---

### T-100 · Entity hover + click interaction system
Effort: M   Status: done   Commit: (pending)

Client-side system for hovering entities and dispatching click events to
registered handlers. Foundation for workbench UI, ground item pickup, and
any future entity-level interaction.

**Outline system** (prerequisite):
- Inverted-hull outline meshes added to every entity voxel (`buildVoxelMesh`
  creates them as child meshes using `makeOutlineMesh`). Stored in
  `EntityMeshGroup.outlineMeshes[]`.
- `HOVER_OUTLINE_MAT` — warm yellow-white variant of `OUTLINE_MAT`, thicker.
  Material-swap on hover: `setEntityHovered(mesh, true/false)`.
- `setHullOutlinesVisible()` — bulk toggle used by the debug panel.

**InteractionSystem** (`src/interaction/`):
- Each entity gets an invisible pick cylinder on Three.js layer 3 (`PICK_LAYER`).
  Camera renders only layer 0 so cylinders are never drawn.
- `update(mouseX, mouseY)` — called each frame; raycasts layer 3, swaps outline
  materials, fires `onHoverStart`/`onHoverEnd` on the matching handler.
- `handleClick(mouseX, mouseY, playerX, playerY)` — called on LMB via
  `InputController.onLmbClick`; dispatches to the highest-priority handler
  whose `canHandle()` returns true and entity is within `interactionRange`.
  Returns `true` to consume the click (suppresses `ACTION_USE_SKILL`).
- `register(handler)` / `unregister(id)` — extensible handler registry.

**Debug panel** additions:
- "Sobel edges" toggle — sets `edgeStrength` uniform on EdgePass to 0/1.
- "Hull outlines" toggle — calls `toggleHullOutlines()` on renderer.

Both outline types now visible and independently toggleable for comparison.

**Registering a new handler** (example — workbench):
```typescript
is.register({
  id: "workbench",
  priority: 10,
  interactionRange: 4,
  canHandle: (t) => t.entityState.raw.has("workstationType"),
  onClick: (t) => { openPanel("crafting"); return true; },
});
```

## Registry Refactor

Multi-phase scaffolding effort to move string-dispatch in systems onto a unified
registry pattern. Each phase ships with deletion of replaced code — no
deprecation shims, feature flags, or legacy fallbacks.

### T-101 · Phase 0.2 — generic `Registry<T>` helper in `@voxim/engine`
Effort: S   Status: done

Added `packages/engine/src/registry.ts` with a typed `Registry<H>` class that
throws on duplicate ids and unknown id lookups. Exported from `@voxim/engine`.
Used by subsequent phases (EffectRegistry, JobHandler, BehaviorTree nodes,
RecipeStepHandler).

### T-102 · Phase 0.1 — move hardcoded tuning constants to `game_config.json`
Effort: S   Status: done

Moved 16 module-level `const` tuning values out of tile-server system files
into `data/game_config.json` under new / extended sub-objects
(`crafting`, `consumption`, `animation`, `building`, `terrain.digReach`,
`combat.unarmedBladeLength`/`unarmedBladeRadius`, and 7 new
`npcAiDefaults.*` fields). `GameConfig` type in `@voxim/content` extended
to match. All original constants deleted from systems; helper functions in
`npc_ai.ts` now take explicit config values through their signatures rather
than reading module-level constants.

### T-103 · Phase 1 — `EffectRegistry` for skill/buff effect dispatch
Effort: M   Status: done

Added three registries (apply / tick / compose) in
`packages/tile-server/src/effects/`. Five handlers created:
`health_effect` (apply + tick), `speed_effect` (apply + compose),
`damage_boost_effect` (apply), `shield_effect` (apply), `flee_effect` (apply).
SkillSystem and BuffSystem both dispatch through registries — zero
`effectStat ===` string branches remain in either system.

Wire-level `effectStat` changed from closed u8 enum to length-prefixed
string in `activeEffectCodec`, so new effect ids are addable via JSON +
handler file with no codec changes. `SkillEffectStat` union deleted from
`@voxim/content`, `@voxim/codecs`, and lore_loadout component.
`SKILL_EFFECT_STAT_TO_U8`/`U8_TO_SKILL_EFFECT_STAT` maps deleted.
`CONSUME_ON_USE_SENTINEL` only referenced by `damage_boost_effect.ts`
(apply) and lore_loadout's generic `isConsumeOnUse()` helper (used by
BuffSystem without effect-specific knowledge).

Startup validation in `server.ts` iterates every ConceptVerbEntry and
throws if its `effectStat` has no registered apply handler.

### T-104 · Phase 2 — `DeathSystem` + `RequestDeath` event
Effort: M   Status: done

Consolidated entity destruction from health loss into one system. Added
`DeathRequestPort` interface + `DeathSystem` that collects requests during
a tick, dedupes, runs registered `DeathHook`s, publishes
`TileEvents.EntityDied`, and destroys. Runs last in the tick chain.

`DeathRequestPort` is a direct port (not a deferred event) so death
happens same-tick. Systems receive `deathSystem` by constructor injection
and hold it as a port: `HungerSystem`, `CorruptionSystem`, `SkillSystem`,
`BuffSystem`, `HealthHitHandler`. Effect handler contexts
(`EffectApplyContext`, `EffectTickContext`) carry the port so
`healthEffectApply` and `healthEffectTick` can request deaths without
knowing about `DeathSystem`.

All 5 health-driven destroys redirected to `RequestDeath`:
`HungerSystem` (starvation), `CorruptionSystem` (corruption),
`HealthHitHandler` (damage), `healthEffectApply` (effect instant/drain),
`healthEffectTick` (DoT). Remaining `world.destroy` calls are all
non-death (item pickup, projectile expiry, blueprint completion,
resource depletion, player disconnect) — these stay direct.

`DeathHook` registry is empty today; future drop-tables / heirs /
corpses will register as additive hooks with no system-file edits.

### T-105 · Phase 3 — `JobHandler` registry in NpcAiSystem
Effort: M   Status: done

Added `JobHandler` interface in `packages/tile-server/src/ai/job_handler.ts`
and registry factory in `ai/mod.ts`. Six handlers, one file each:
`idle`, `wander`, `flee`, `seekFood`, `seekWater`, `attackTarget`.

NpcAiSystem no longer switches on `job.type`. Per-tick flow:
emergency overrides → queue advance → `registry.get(job.type)` →
plan/replan → `advancePlan` for direction → `handler.tick(...)` → apply
transition (replaceJob / clearJob) and write InputState. Job-specific
logic (attack stop-in-range, seek auto-consume, target validation) all
lives in the handlers.

Shared AI utilities (`moveSteps`, `advancePlan`, spatial scans) extracted
into `ai/plan_helpers.ts`. `NpcTuning` type consolidates per-NPC values
resolved from template + game_config defaults.

Emergency priority cascade and `generateDefaultJob` stay in `npc_ai.ts`
for this phase — Phase 4 behavior trees will replace both.
NpcAiSystem: 523 lines → 245 lines.

### T-106 · Phase 4 — Behavior trees for NPC decision-making
Effort: L   Status: done

NPC decision-making moved from hardcoded priority cascade into data. Added
BT infrastructure under `packages/tile-server/src/ai/bt/`: evaluator,
`BTNodeFactory` interface, and 13 node factories — 2 composites
(`sequence`, `selector`), 6 condition checks
(`check_hunger_critical`, `check_thirst_critical`, `check_health_critical`,
`check_current_job_not`, `check_queue_empty_or_expired`, `check_plan_expired`)
and 5 actions (`set_job_seek_food`, `set_job_seek_water`,
`set_job_flee_from_nearest`, `set_job_attack_nearest`, `set_job_default`).

ContentStore gained `getBehaviorTree` / `getAllBehaviorTrees` and the
`behavior_trees/` directory. Two BT JSON files encode the old cascade:
`hostile.json` (aggro scan included) and `passive.json` (no aggro).

`NpcTemplate.behavior` (union) deleted and replaced with
`behaviorTreeId: string` (required). All 5 existing NPC JSON files
updated in the same commit — bandit (previously "neutral") remapped to
"passive" since neutral and passive were behaviorally identical today.

Server startup validates every NpcTemplate's behaviorTreeId resolves to
a loaded tree; `buildBehaviorTree` throws on unknown node types.
NpcAiSystem's tick flow now:
  evaluate BT → apply BTOutput (replaceCurrent / cooldownPlan) →
  dispatch through JobHandler registry from Phase 3 → advance plan →
  handler.tick → write InputState.

Zero `behavior` references remain anywhere in the codebase.
NpcAiSystem went from 245 lines to 211 lines; the emergency cascade and
`generateDefaultJob` helper are both gone.

### T-107 · Phase 5 — `RecipeStepHandler` registry
Effort: S   Status: done

Added `RecipeStepHandler` interface in
`packages/tile-server/src/crafting/step_handler.ts` plus registry factory
in `crafting/mod.ts`. Three handlers, one file each: `attack_step`
(onHit, tool-gated instant resolve), `assembly_step` (onHit, requires
active selection), `time_step` (onTick, auto-start + countdown).

Shared `resolveRecipe` + `toolMatches` helpers in `crafting/util.ts`.

`WorkstationHitHandler` is now a generic dispatcher — iterates the
registry's `onHit` handlers in registration order (assembly before
attack so explicit selection wins). `CraftingSystem` keeps the
ACTION_INTERACT placement phase and iterates every registered `onTick`
handler per workstation; all time-specific code (auto-start,
progressTicks countdown, completion resolve) moved into `time_step`.

Server startup validates every recipe's `stepType` resolves to a
registered handler — fail fast on mismatch.

Zero `stepType === "..."` branches remain in systems or handlers.
The only remaining comparisons are (a) `findMatchingRecipe`'s filter
parameter and (b) the assembly handler's self-identity check
(`ID` constant referenced from its own factory). Neither is a
cross-system dispatch branch.

### T-108 · Phase 6 — biome + zone as content data
Effort: M   Status: done

Moved biome climate thresholds, material assignments, zone profiles,
and spawn densities out of `packages/world/` code into
`packages/content/data/biomes/*.json` (9 files) and
`packages/content/data/zones/*.json` (11 files). Added `BiomeDef` +
`ZoneDef` types with range-based classify rules and material rules to
`@voxim/content`; registered on `ContentStore` with `getAllBiomes` /
`getBiome` / `getAllZones` / `getZone` (both pre-sorted by priority).

Rewrote `packages/world/src/biomes.ts` and `zones.ts` as pure functions
over `BiomeDef[]` / `ZoneDef[]`: `classifyBiome(defs, sample)`,
`biomeMaterialName(def, sample)`, `classifyZone(defs, sample)`.

Generator takes a new `WorldGenContent` argument carrying the biomes,
zones, and a material-name → id resolver. Per-cell height scale and
roughness read directly from `BiomeDef` fields.

Terrain cache format bumped to v2: `biomeId` and `zoneId` serialized as
length-prefixed UTF-8 strings instead of u8 enum values. `ZoneCell`
gained string `zoneId` / `biomeId`.

Deletions:
- `BiomeId` const-enum and `MAT_*` constants in biomes.ts
- `ZoneType` const-enum and `ZONE_PROFILES` in zones.ts
- `biomeMaterial`, `biomeHeightScale`, `biomeRoughness` functions
- `NPC_DENSITY`, `NODE_DENSITY`, `PROP_DENSITY` constants in server.ts —
  densities now per-zone in data
- Unused `generateTile` and `generateFlatTile` convenience functions
- Tectonic-based hills fallthrough hardcoded in classifyZone;
  now expressed as two rules on `hills.json`.

Server spawn functions (spawnProceduralNpcs / Nodes / Props) read
weights + densities from the per-zone def via `content.getZone(cell.zoneId)`.
`gen_terrain.ts` loads ContentStore and builds a `WorldGenContent`
adapter before calling `buildTerrainBuffers`.

Adding a new biome or zone is a JSON file drop; the `packages/world/`
package holds only generic rule-matching logic and noise evaluation.

### T-109 · Phase 7 — recipe schema expansion
Effort: S   Status: done

Rewrote `Recipe` type:
- `inputs[]` gained `alternates?: string[]` — recipe matches when any
  primary or alternate item type has the required quantity in the buffer;
  consumption picks the first acceptable type (primary preferred).
- `outputs: RecipeOutput[]` replaces single `outputType` / `outputQuantity`.
  `resolveRecipe` spawns one item entity per output.
- `requiredTools: string[]` replaces `requiredTool: string | null`.
  Empty array = any tool. `toolMatches` accepts the weapon when its
  toolType is in the list.
- `chainNextRecipeId?: string` — when set, on completion the workstation's
  `activeRecipeId` is set to this id (rather than cleared) so the next
  swing or tick continues the chain.

All 18 existing recipe JSON files rewritten in the same commit to the
new shape via a one-shot Python transform. Loader accepts only the new
shape; old field names are gone from `Recipe` and from all content.

Consumers updated: `recipeInputsMatch` and `consumeFromBuffer` in
`crafting.ts` honor alternates; `findCraftableRecipe` in ContentStore
does the same; `resolveRecipe` spawns each output and chains via
`chainNextRecipeId`; `attack_step`, `assembly_step`, `time_step` log
the full outputs list.

---

## Account service (gateway-hosted)

The gateway gains a second responsibility alongside tile routing: it is the
outward-facing account service. It owns user identity, credentials, session
tokens, per-user settings, and persistent heritage. Tile servers become
stateless with respect to cross-session data — they call the account service
on player join/death/disconnect instead of keeping their own stores.

**Architecture summary**

- Single process, same as today's `deno task gateway`. New code lives under
  `packages/gateway/src/account/` with a narrow interface to the existing
  routing code — clean enough to extract into its own service later if load
  ever demands it.
- Password auth (argon2id), opaque session tokens (hashed at rest).
- Storage is two files per user, same directory:
  - `users/{userId}.json` — login + settings + activeDynastyId + lastTileId.
    JSON because these fields evolve freely (new settings, new features).
  - `users/{userId}.heritage.bin` — `heritageCodec` payload only. Binary
    because the shape is stable and the codec already exists.
  - No cross-reference stored; the filename stem is the link. No field is
    duplicated between the two files, so cross-file atomicity is a non-issue.
- Tiles call the account service via HTTP using a shared secret in a header.
- HeritageStore class is deleted entirely; tile-server gains an AccountClient.

Tickets T-110 through T-115 build this in order. T-110 and T-111 are
independent and can parallel.

### T-110 · Account storage layer — AccountStore + binary/JSON file format
Effort: M   Status: done   Commit: ea1d769

New `packages/gateway/src/account/store.ts` exposes:

```
class AccountStore {
  constructor(rootDir: string)
  async createUser(loginName, passwordHash): Promise<User>
  async getUserById(userId): Promise<User | null>
  async getUserByLogin(loginName): Promise<User | null>
  async updateUser(userId, patch): Promise<void>          // JSON side only
  async getHeritage(userId): Promise<HeritageData | null>
  async putHeritage(userId, data): Promise<void>          // binary side only
}
```

Files on disk:
- `users/{userId}.json` — `{ userId, loginName, passwordHash, createdAt,
  lastLoginAt, activeDynastyId, lastTileId, settings }`. `settings` is a
  free-form object; no schema enforced by the store.
- `users/{userId}.heritage.bin` — `heritageCodec.encode(data)` with file
  header `u32 magic "VXUH" | u32 version | f64 savedAt | bytes payload`.

Implementation notes:
- Atomic write via `write tmp + rename`, same as `save_manager.ts`.
- Login-name → userId lookup: maintain a sibling `users/_index_by_login.json`
  that maps loginName → userId. Rebuilt lazily by scanning on first use if
  missing. No DB.
- Store is oblivious to auth — it does not hash passwords. Caller passes the
  hash in.

Done when: unit can create, load, patch a user; heritage can be written and
read round-trip via the codec; missing files return null without throwing;
two concurrent writes to different users do not interfere.

### T-111 · Auth primitives — argon2id hashing + opaque session tokens
Effort: M   Status: done   Commit: 2fe46a6

Note: shipped with PBKDF2-HMAC-SHA256 (600k iterations) rather than
argon2id — pure Web Crypto, zero new deps. Hash format is self-describing
so a future swap is a prefix-dispatch in verifyPassword + rehash on
login.

New `packages/gateway/src/account/auth.ts`.

- Import `hash-wasm` or equivalent Deno-compatible argon2id implementation.
  Constants: memory 64 MiB, iterations 3, parallelism 1 (sensible defaults;
  tune on measured hardware).
- `hashPassword(plain): Promise<string>` returns the full argon2id-encoded
  string (includes salt + params).
- `verifyPassword(plain, stored): Promise<boolean>`.
- `generateToken(): string` — 32 random bytes, base64url-encoded (~43 chars).
- `hashToken(token): string` — SHA-256 hex. Only the hash is stored; the
  client holds the raw token.

New `packages/gateway/src/account/session_store.ts` — in-memory for MVP.
`Map<tokenHash, { userId, expiresAt }>`. On login: generate token, store
hashed form, return raw to client. On validate: hash incoming, look up, check
expiry. Token TTL: 7 days, rolling. Revocation is store removal.

Rationale for in-memory first: session state doesn't need to survive gateway
restarts (users re-login), and a single gateway process is the MVP shape. A
persistent sessions layer can be added later without changing the API.

Done when: a hashed password round-trips through verify; a generated token
validates exactly once per value; expired tokens reject.

### T-112 · HTTP endpoints — client-facing and server-to-server
Effort: M   Status: done   Commit: 0a290dc

New `packages/gateway/src/account/endpoints.ts`. Routed from the existing
`handleRequest` in `server.ts` under the `/account/*` prefix.

Client endpoints (authenticated by session token in `Authorization: Bearer`):
- `POST /account/register`    body: `{ loginName, password }`
                              → 201 `{ userId, token }`
                              → 409 if loginName taken
- `POST /account/login`       body: `{ loginName, password }`
                              → 200 `{ userId, token, activeDynastyId, lastTileId }`
                              → 401 on bad creds
- `POST /account/logout`      → 204 (invalidates the bearer token)
- `GET  /account/me`          → 200 `{ userId, loginName, settings,
                              activeDynastyId, lastTileId }`
- `PATCH /account/me/settings` body: arbitrary JSON object
                              → 204 (merged into settings, atomic)

Server-to-server endpoints (authenticated by `X-Voxim-Service-Secret`
matching a shared env var; no token):
- `GET  /internal/session/:token`     → `{ userId, activeDynastyId, lastTileId }`
                                      Used by gateway handshake; takes the raw
                                      token, not the hash, for operational
                                      simplicity.
- `GET  /internal/user/:userId/heritage` → heritageCodec payload as
                                      `application/octet-stream`
- `POST /internal/user/:userId/death`  body: `{ killerId?, cause }`
                                      Advances `HeritageData.generation`
                                      and appends a trait per the current
                                      `HeritageStore.recordDeath` logic.
                                      → 204
- `PATCH /internal/user/:userId/location` body: `{ lastTileId }` → 204

Done when: curl against each endpoint with the right auth produces the
expected status + body; wrong auth returns 401; malformed bodies return 400.
The server-to-server secret is read from `VOXIM_SERVICE_SECRET` env var and
the gateway refuses to start without it.

### T-113 · Gateway handshake requires a session token
Effort: S   Status: done   Commit: 1125d71

Kill the auth stub at `packages/gateway/src/session.ts:48-49`
(`// Auth stub — always accept`).

Protocol change in `@voxim/protocol`:
- `GatewayConnectRequest` gains `token: string` (required).
- `GatewayErrorResponse.code` gains `"unauthenticated"`.

In `handleGatewaySession`:
- Read `req.token`, hash it, look up in SessionStore via the `/internal/
  session/:token` endpoint (or directly against the store — the endpoints
  file exports the store).
- If invalid/expired: respond `{ type: "error", code: "unauthenticated" }`.
- If valid: use `session.userId` (not a generated playerId); resolve tile via
  `TileDirectory.tileForPlayer(userId)` with `userId` as the routing key.
- Carry `userId` through the `tile` response so the client passes it to the
  tile server on WT connect.

Done when: a client that presents no token or a bad token is refused; a
client that presents a valid token is routed to the tile identified by its
user record's `lastTileId` (or default tile if null).

### T-114 · Delete HeritageStore; tile-server becomes an account-service client
Effort: M   Status: done   Commit: 49c1c49

Tile server now also re-validates the session token in TileJoinRequest
against the gateway's /internal/session endpoint. Prevents a client that
skips the gateway (direct WebTransport) from claiming any userId.

- Delete `packages/tile-server/src/heritage_store.ts` and
  `@voxim/tile-server`'s export of `HeritageStore` from `mod.ts`.
- Add `packages/tile-server/src/account_client.ts` exposing:

  ```
  class AccountClient {
    constructor(baseUrl: string, serviceSecret: string)
    async getHeritage(userId): Promise<HeritageData | null>
    async recordDeath(userId, killerId?, cause): Promise<void>
    async updateLocation(userId, tileId): Promise<void>
  }
  ```

  Sends `X-Voxim-Service-Secret` on every call. Uses
  `heritageCodec.decode()` on the response bytes — no JSON parse.

- `spawnPlayer` (and its callers) take `AccountClient` instead of
  `HeritageStore`. On player join, `await accountClient.getHeritage(userId)`
  replaces `heritageStore.get(dynastyId)`. `maxHealthFor` moves into a
  pure function that takes `HeritageData` as input (no store dependency).

- `TileServer.handleSession` disconnect path: `accountClient.recordDeath(userId, …)`
  replaces `heritageStore.recordDeath(...)`. Make that call `await`ed (the
  path is already async).

- New `TileServerConfig.gatewayUrl` (already exists) +
  `TileServerConfig.serviceSecret` (new) wire the client.

- The `dynastyId` concept inside the tile server goes away for tracking
  purposes — the `Heritage` component still carries it (that's wire-facing
  data) but it comes from the `getHeritage` response, not from a local map.

Done when: `grep HeritageStore packages/` returns nothing; player death on a
tile posts to the gateway and a restart of the tile server preserves the
dynasty's generation count; no tile-local persistence of heritage remains.

### T-115 · Client login UI + connect flow
Effort: M   Status: done   Commit: b91928f

Currently the client connects to the gateway with no credentials. After this
ticket, the client acquires a session token via HTTP then uses it in the
WebTransport handshake.

- Add `packages/client/src/ui/login.ts` rendering a minimal login/register
  form. Two fields (loginName, password), two buttons.
- On login success: store the token in `localStorage` (acceptable for MVP;
  XSS is not in scope until we have a moderation story).
- On page load: if a token exists, try `GET /account/me` first; if 200,
  skip the login screen and proceed to the game. If 401, clear the stored
  token and show login.
- `GatewayConnectRequest` — populate `token` from storage. On
  `"unauthenticated"` response, clear token and re-show login.

Served by the gateway (via `/account/login.html` or just served alongside
the existing game client asset bundle). Match the existing theme CSS —
bare minimum, no framework.

Done when: a fresh browser session asks for login; after register, the
player connects to the game; after a death and reconnect the player's
heritage is visible (generation + bonus max-health applied).

---

**Out of scope for T-110–T-115 (explicitly deferred):**
- Email verification, password reset, OAuth — T-11x future tickets.
- Rate limiting on login / registration — add when we care about brute-force.
- Persistent session store — add when gateway horizontal scaling matters.
- Account deletion / GDPR-style export — add when we have a privacy policy.
- Admin tools (ban, reset, promote) — separate ticket line.
- `deno task inspect-user` CLI — nice to have, T-116 candidate.

---

## Multi-process architecture (Postgres + coordinator)

These tickets implement the cross-process architecture described in
`ARCHITECTURE.md`. They land in order — each phase produces something
runnable. They supersede / replace the older Gateway tickets T-051, T-052,
T-053, T-054, T-055 by giving them concrete substrates; the originals stay
as the gameplay-level acceptance criteria.

### T-132 · Postgres + docker-compose dev stack
Effort: M   Status: done   Commit: 7dc0764

Stand up the multi-process dev environment. No behaviour change yet — gateway
and tile-server still run with their existing in-memory / file-based state;
this ticket only puts the substrate in place so subsequent tickets can move
state into Postgres.

- Add `docker-compose.yml` with services: `postgres` (postgres:16, named
  volume `voxim-pg-data`, port 5432:5432), `certs-init` (one-shot, populates
  named volume `voxim-certs` by running `scripts/gen_certs.ts`).
- Add `docker-compose.dev.yml` overriding gateway/tile/coordinator services
  to bind-mount `packages/` and run with `deno run --watch`.
- Add `Dockerfile` per service (`gateway`, `tile-server`, `coordinator`,
  `client-dev`) — minimal, `denoland/deno:alpine` base, copy workspace,
  preload imports.
- Add `.env.example` with `POSTGRES_PASSWORD`, `VOXIM_SERVICE_SECRET`,
  `GATEWAY_URL`, `DATABASE_URL`. Real `.env` gitignored.
- Add `deno task compose-up` / `compose-down` helpers wrapping
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml`.
- Document the workflow in `ARCHITECTURE.md` (already present).

Done when: `deno task compose-up` brings up postgres + the existing services
unchanged, and `psql` to localhost:5432 succeeds.

### T-133 · `packages/db` — repositories + migrator
Effort: M   Status: done   Commit: 7dc0764

New workspace package. No consumers yet — that's T-134.

- `packages/db/deno.json` exporting `mod.ts`.
- `client.ts` — Postgres connection pool from `DATABASE_URL`, using
  `https://deno.land/x/postgres`.
- `migrate.ts` — forward-only migrator. Reads `migrations/*.sql` in numeric
  order, tracks applied versions in a `_migrations` table, applies pending
  ones inside a transaction. Runnable as `deno task migrate`.
- `migrations/0001_users.sql`, `0002_heritage.sql`, `0003_sessions.sql`,
  `0004_tile_registry.sql`, `0005_tile_saves.sql`, `0006_world_map.sql`,
  `0007_cities.sql` — schema per `ARCHITECTURE.md`.
- `repos/user_repo.ts`, `heritage_repo.ts`, `session_repo.ts`, `tile_repo.ts`,
  `tile_save_repo.ts`, `world_map_repo.ts`, `city_repo.ts` — typed CRUD
  interfaces. No business logic, just SQL.
- Repos export interfaces + a default Postgres-backed implementation. Tests
  can substitute fakes.

Done when: `deno task migrate` against a fresh Postgres applies all migrations
cleanly; running it twice is a no-op; each repo has a smoke test that does
insert → read → update → delete against a real local Postgres.

### T-134 · Migrate gateway accounts/sessions/heritage to Postgres
Effort: M   Status: done   Commit: deac9cc

Replace the file-based `AccountStore` and in-memory `SessionStore` with the
DB repositories from T-133.

- Gateway depends on `@voxim/db`.
- `AccountStore` deleted. `AccountEndpoints` consumes `UserRepo` +
  `HeritageRepo` + `SessionRepo` directly.
- Login index file (`_index_by_login.json`) and `users/` directory removed.
- Token hashing / heritage encoding / atomic-write semantics preserved by
  moving them into `SessionRepo` / `HeritageRepo`.
- Session expiry sweep: a daily job (no-op for now via simple interval) that
  deletes expired sessions. Sessions still validate lazily on read.

Done when: register → login → reconnect → die → reconnect cycle works
end-to-end against Postgres. Old `data/accounts/` directory has no readers
left and can be deleted.

### T-135 · Tile registry to DB + heartbeat + TTL eviction
Effort: M   Status: done   Commit: 97566c2   (supersedes T-052)

Replace in-memory `TileDirectory` with `TileRepo`. Add the heartbeat lifecycle.

- Tile-server hits `POST /register` on startup (already does), then
  `POST /heartbeat` every 10s (new).
- Gateway sweeps `tile_registry` for rows with `last_heartbeat_at < now() - 30s`
  and removes them. Sweep runs on a 10s interval.
- `TileSpawner` interface defined in
  `packages/gateway/src/edge/tile_orchestrator.ts`. Only impl: `NoopSpawner`
  that throws "not implemented" — used when gateway receives a connect for an
  unregistered tile.
- Player→tile lookup goes through `TileRepo.findByPlayer()` (joins on
  `users.last_tile_id` for now; will become a separate table when handoffs
  are real).

Done when: tile registers, heartbeats, gets evicted on Ctrl-C; `psql` shows
the row coming and going.

### T-136 · Tile saves to Postgres
Effort: M   Status: done   Commit: e29aaa7

Move tile snapshots from disk to `tile_saves` table.

- `SaveManager` writes `payload` blob (existing VXM2 binary format) +
  `size_bytes` to `tile_saves` via `TileSaveRepo` on auto-save.
- Tile-server boot: `SELECT payload FROM tile_saves WHERE tile_id = ?` →
  if hit, restore; else generate from world map (T-138) or seed.
- Old file-based save path deleted. Local save files in `data/saves/`
  removed.
- Tile-server is now stateless on disk: kill the container, bring up a
  replacement with the same TILE_ID, picks up where it left off.

Done when: a tile-server with state runs, is killed, comes back up (same
TILE_ID), and the world is intact (terrain mutations, dropped items, NPC
positions).

### T-137 · `packages/coordinator` skeleton + privileged WT handshake
Effort: M   Status: done   Commit: cf60647

New service. Reuses `@voxim/engine` for ECS + tickloop. Connects to gateway
on startup as a privileged peer.

- `packages/coordinator/main.ts` — entry point, reads `GATEWAY_URL`,
  `VOXIM_SERVICE_SECRET`, `DATABASE_URL`.
- `coordinator/src/world.ts` — boots a `World` from `@voxim/engine`,
  ticks at 1 Hz.
- `coordinator/src/gateway_link.ts` — opens WT session to gateway, sends
  `{ kind: "coordinator", secret }` handshake on first frame, multiplexes
  events (down) and commands (up) on the reliable stream.
- Gateway recognises `kind: "coordinator"` and stores a single coordinator
  link slot. Rejects a second simultaneous coordinator. Disconnect → null.
- No real macro sim yet — just a tickloop logging "tick N" and an empty ECS
  world.

Done when: `docker compose up coordinator` brings it up, gateway logs
"coordinator connected", coordinator logs ticks.

### T-138 · World map: gen + persist + tile lookup
Effort: M   Status: done   Commit: 0324930   (replaces stub for T-056/T-060)

Coordinator generates the world map on first startup and persists it.
Tile-servers fetch their cell during terrain generation.

- Coordinator on startup: if `world_map` table empty, generate from a seed
  (env `WORLD_SEED`), pack to a binary blob, write one row.
- World map cell shape: `biome`, `elevation_tier`, `river_flag`, `road_flag`,
  `gate_positions[]`, `city_seed_flag`, `corruption_level`. One cell per
  tile (e.g., 64×64 grid → 4096 tiles).
- Gateway exposes `GET /internal/world/tile/{tileId}` (service-secret auth)
  that proxies to coordinator's WT command channel and returns the cell for
  that tile.
- Tile-server's terrain generator reads its world-map cell as input. Existing
  terrain-gen code adapts to consume biome/elevation/river/road as inputs.

Done when: the same TILE_ID always generates the same terrain across
container restarts; cells differ correctly per tile_id; rivers/roads/gates
align with the macro grid.

### T-139 · World event bus over WT (tile→coordinator + coordinator→tile)
Effort: M   Status: done   Commit: 2871ade   (supersedes T-045)

Real publish/subscribe over the WT streams established in T-135 and T-137.

- Define `WorldEvent` and `TileCommand` codecs in `@voxim/protocol`.
- Tile-server publishes `WorldEvent` (e.g., `PlayerCrossedGate`,
  `CaravanArrived`, `NpcKilled`) on its WT stream to gateway.
- Gateway routes events to the connected coordinator (if any).
- Coordinator emits `TileCommand` (e.g., `SpawnCaravan`, `DispatchNpc`,
  `ApplyCityState`) targeting a specific tile-id; gateway routes to that
  tile-server's WT stream.
- In-memory only; no durable replay table (deferred per `ARCHITECTURE.md`).
- Gateway's `worldEvents` `// TODO` stubs in `server.ts` deleted.

Done when: tile publishes a test event, coordinator's tickloop receives it
and logs; coordinator emits a test command, the targeted tile receives and
logs it.

### T-140 · Gate entities + handoff over the new substrate
Effort: L   Status: done   Commit: db38b68   (supersedes / completes T-053, T-054)

Now that registry, world map, and event bus exist, build the actual
multi-tile gate flow.

- Gate entities placed at world-map cell edges where adjacent cells share a
  road or natural border. Tile-server reads gate positions from its world-map
  cell during terrain gen.
- Player proximity → `GateApproached` event published to coordinator (for
  logging) and a server-side handoff trigger.
- Source tile: serialise full player entity (all components), `POST /handoff`
  to gateway with `destinationTileId`.
- Gateway: validate destination tile is registered, forward to destination
  tile's admin URL, on ack tombstone player's entry on source.
- Destination tile: `restorePlayer()` deserialises and inserts the entity;
  acks gateway.
- Gateway updates `users.last_tile_id`.
- Idempotency: source tile retries on ack timeout with a stable handoff key;
  gateway dedupes via in-memory in-flight map keyed by handoff key.

Done when: a player walks through a gate and continues play on the
destination tile; entity state survives (HP, inventory, dynasty); same
player can't be present on both tiles simultaneously (no double-spawn).

### T-141 · Client tile transition
Effort: M   Status: done   Commit: a0eb265   (supersedes T-055)

Client side of T-140. Receives `GateCrossing` from the state stream, opens
a new WT to the destination tile, replaces local world state.

- Server-side: just before tombstoning on source, send a final state-stream
  message `{ type: "gate_crossing", destinationTileAddress, destinationTileCertHashHex }`.
- Client: tear down WT, drop interpolation buffers + entity caches, open new
  WT to destination, run `TileJoinRequest` flow, re-initialise from first
  state message.
- Loading screen during transition (~1s typical).

Done when: client transitions between tiles seamlessly in dev compose.

### T-142 · CityState + utility-AI fallback
Effort: M   Status: done   Commit: 8231e91   (folds in T-044, T-047)

Coordinator gets actual macro behaviour, even without an LLM.

- `CityState` row created on first startup at each city seed location from
  the world map. Fields: personality (random init), goals (default mix),
  relationships ({}), inventory (small starting stock), event_log ([]),
  population_count.
- Utility-AI tickloop (slow, every 10 server ticks): maintain food
  production, keep guard posts staffed, dispatch caravan when surplus
  threshold crossed. Mutates `cities.state` and emits `TileCommand`s.
- Event log trimmed to last 200 entries on each write.

Done when: coordinator boots, cities exist in DB, utility AI moves them
forward in observable ways (event log accumulates, caravan commands fire to
tiles).

### T-143 · `packages/ai-manager` skeleton + LLM call shape
Effort: M   Status: done   Commit: 374d7de   (lays groundwork for T-046, T-050)

Separate process. Stub LLM responses initially (echo a deterministic
response) so the coordinator integration is testable without API costs.

- `packages/ai-manager/main.ts` — Deno HTTP server.
- `POST /agent/city` — accepts a `CityContextPacket`, returns
  `{ tool_calls: [...] }`. Initially: deterministic mock response keyed on
  the most recent event.
- Coordinator gains an `AIManagerClient` that POSTs to it on significant
  events (rate-limited to one call per city per significant event).
- `AI_MANAGER_URL` env var; absent → coordinator skips and uses utility AI
  only (T-142).
- Real Anthropic call deferred to a future ticket — this one only proves
  the wiring.

Done when: significant in-game event in a city → coordinator POSTs to AI
manager → manager returns mock tool calls → coordinator validates and
applies them via `TileCommand`s.

### T-145 · Gate visual marker + label
Effort: S   Status: done   Commit: 45f1043

Without a visible cue, the player has no way to find a gate — gates were
server-only entities at fixed edge positions, and the proximity trigger
fired once they happened to walk within 4 units. T-141's reconnect path
proves out only with a way to actually reach a gate.

- Promote `GateLink` to networked: add `wireId`, move codec to `@voxim/codecs`.
- Always include gate entities in every player's AoI (≤4 per tile, trivial
  cost) so the player sees them from spawn.
- Client decodes `gateLink` into ClientWorld and the renderer draws a
  pillar with an edge-coloured capstone at each gate's position.
- WorldOverlay shows a "→ {destinationTileId}" label anchored above the pillar.

Done when: a fresh client sees pillars on its tile's connecting edges,
walks to one, and the existing T-140/141 handoff carries them across.

---

**Out of scope for T-132–T-143 (explicitly deferred):**
- Multi-gateway replication.
- Multi-coordinator sharding of macro sim.
- `DockerSocketSpawner` / dynamic tile-spawning by gateway. Slot-based
  scaling sufficient for solo dev.
- Per-tile world-map override layer.
- Durable `world_events` log with replay.
- Live tile migration between hosts.
- Real LLM API integration (separate ticket once T-143 wiring proves out).

---

## Content Architecture

End-state: every distinct piece of game tuning is content; the engine ships small
generic algorithms that consume content; a single typed-registry federation owns
it all. Client and server share content via a WebTransport-handshake bootstrap
blob — no separate HTTP service, no client-side static bundle. Procedural
generators (loot, names, POIs, quests, dialogue) live as data declarations on top
of engine-side algorithms in `@voxim/content`. Tile-server crash → connection
dies → client reconnects → fresh content blob, version drift impossible.

T-173 unblocks immediate creature work and is independent of the rest. T-174 →
T-175 → T-176 → T-177 are the foundation, sequenced. T-178 → T-179 → T-180
together retire the per-creature skeleton sprawl. T-181 / T-182 / T-183 can land
in parallel once the foundation is in.

### T-173 · BoneDef rest rotations + correct retargeting math
Effort: M   Status: done   Commit: 6e260e9

Add `restRotX/Y/Z` (Euler XYZ radians, parent-local frame) to `BoneDef`,
default 0/0/0 (forward-compatible — existing identity-rest skeletons
unchanged). Solver falls back to `restRot` for bones the clip omits, so
rest pose / sparse clips show the bind not identity.

Convert_anim.ts retargeting fixed from pre-multiply (`B^-1 * A`) to
post-multiply (`R = A * B^-1`). Pre-multiply produces a rotation of the
correct magnitude but expresses it in the source bind's local axes —
visually fine for symmetric bipeds close to T-pose, breaks for asymmetric
or non-identity bind chains (rotten knight's giant arm exposed this).
Post-multiply is the correct retargeting transform for identity-rest
targets: `target_world = parent_world * R = parent_world * A * B^-1`,
which differs from source's `parent_world * A` only by `B^-1` — exact
when source/target binds match (T-179 work), good approximation
otherwise. Removes the 47° "zombie reaching" amplification on rotten
knight's right arm.

Originally scoped as "drop bind subtraction entirely" + "encode source
bind in target's restRot". Tested empirically — that path requires
rewriting our translation convention (source rig uses near-zero
translations + bone-local-axis positioning; we use entity-local Z-up
translations + voxel models authored along world axes). Deferred to
T-179 where canonical biped + voxel models can be authored together.
T-173 ships the schema + correct retargeting math; existing skeletons
keep identity rest; clips re-imported with the corrected formula.

Done: schema field added; solver falls back to restRot; convert_anim.ts
post-multiplies; drowner + rotten_knight clips re-imported (8 clips);
type-check clean; bone world positions sane (feet near ground, hands at
chest height instead of flying above the head).

### T-174 · ContentRegistry<T> primitive + tag indexing
Effort: S   Status: done   Commit: 86e435a

Generic id-keyed registry primitive in `@voxim/content`:

  get(id) | getOrThrow(id) | has(id) | byTag(tag) | forEach() | size

Tags declared per item via optional `tags: string[]` on the schema; registry
maintains a reverse `Map<tag, Set<T>>` populated on register. Validation hook
(per-type schema check) called on register. Smoke-test by tagging existing
materials (`metal` / `flesh` / `wood`) and verifying `byTag` queries.

Building block for T-175. No engine call-site changes yet.

Done when: `ContentRegistry<T>` exists with unit coverage; materials have
tags; `byTag("metal")` returns the iron / steel / copper / worn_iron rows.

### T-175 · Federate ContentStore into typed registries
Effort: L   Status: done   Commit: e48cd39+e4c0e5c

Refactor `ContentStore`'s ~30 ad-hoc `get*` methods into a federated shape:

  store.materials, store.skeletons, store.models, store.prefabs,
  store.verbs, store.loreFragments, store.weaponActions, store.recipes,
  store.zones, store.tileLayouts                — ContentRegistry<T>
  store.gameConfig, store.terrainConfig, store.conceptVerbMatrix
                                                — singletons

Engine call sites updated: `content.getPrefab(id)` → `content.prefabs.getOrThrow(id)`.
Old methods deleted (no shim, per refactor philosophy).

Top-level package layout uses namespace re-exports for call-site clarity:

  // packages/content/mod.ts
  export * as registries from "./registries.ts"
  export * as generators from "./generators/index.ts"
  export * as algorithms from "./algorithms/index.ts"
  export { ContentService, type Prefab, ... } from "./service.ts"

Consumers write `import { registries, generators } from "@voxim/content"` then
`registries.prefabs.getOrThrow(id)` / `generators.names.invoke(...)`.
Modules stay side-effect-free so esbuild's default tree-shaking still prunes
unused namespace members on the client. Subpath exports
(`@voxim/content/generators`) deferred until measurable need.

Sequenced behind T-174 since registries are the building block. Touches every
package that consumes ContentStore, but each call-site change is mechanical.

Done when: every consumer reads via the federated shape; old getters gone;
`deno check` clean across all packages; runtime behavior unchanged.

### T-176 · ContentService interface + JsonSource
Effort: M   Status: done   Commit: d8398ee

Extract `ContentService` interface in `@voxim/content` describing the read
surface (federated registries + `invoke()` for generators). Implementations:

  - `JsonSource`     — scans `data/**/*.json`, builds a `ContentService`.
                       Used by tile-server at startup.
  - `BootstrapSource` — hydrates from a binary blob (T-177).
                       Used by client.

Engine code consumes `ContentService`, never `ContentStore` directly.
JsonSource is the only on-disk reader; nothing else touches the filesystem.

Done when: tile-server constructs JsonSource at boot; engine accepts
ContentService; no `Deno.readDir` outside `JsonSource`.

### T-177 · Content bootstrap codec + WT handshake delivery
Effort: M   Status: done   Commit: 61f3c59+ebc1bc0+ac1c401

Binary codec serializes a fully-loaded `ContentStore` into a length-prefixed
blob (target ~1–5 MB compressed) with a content hash in its manifest.
Tile-server sends the blob immediately after `TileJoinAck` on the reliable
stream. Client's `BootstrapSource` (T-176) reads the length-framed blob,
decodes, hydrates an in-memory ContentStore.

Removes the client's compile-time content dependency: delete
`scripts/gen_content.ts`, delete the generated `*_static.ts` files, drop
static imports of JSON from `packages/client/`. Bundle shrinks; content is
always in sync with the server it just connected to. Hash in manifest sits
unused for now — enables future delta / cache strategies.

Done when: client receives content over WT handshake on every join;
`gen-content` deno task gone; tile-server restart → client reconnect →
fresh content visible without rebuild.

### T-178 · AnimationLibrary as peer registry (decouple from Skeleton)
Effort: M   Status: done   Commit: 9ae9484

Animation clips currently live as `clips: AnimationClip[]` inside
`SkeletonDef`, populated at load by splicing files tagged `_skeleton: "X"`
from `data/anim_library/`. Move them out:

  store.animationLibraries: ContentRegistry<AnimationLibrary>
  AnimationLibrary { archetype, clips: ContentRegistry<AnimationClip> }

Skeletons declare `archetype: "biped" | "quadruped" | …`. Folder layout:
`data/anim_library/{archetype}/{clipId}.json` — folder is authoritative,
`_skeleton` field dropped. Loader sweeps each archetype subfolder, builds
one library per archetype. Multiple skeletons of the same archetype share
clips by reference (no duplication, as we currently do for drowner →
rotten_knight).

Animation system / skeleton evaluator look up clips via
`store.animationLibraries.getOrThrow(skeleton.archetype).clips.get(clipId)`.
Splice machinery in `anim_library.ts` deleted.

Done when: drowner_*.json and rotten_knight_*.json consolidated into one
biped library; both creatures animate from the shared library; no
`_skeleton` field anywhere; clip-splice code path gone.

### T-179 · Canonical biped skeleton + full UAL2 clip suite
Effort: M   Status: done   Commit: 9cb79df

Author `data/skeletons/biped.json` from the UAL2 bind directly: 17 bones
using UAL bone names (pelvis, spine_01/02/03, neck_01, Head, clavicle_l/r,
upperarm_l/r, lowerarm_l/r, hand_l/r, thigh_l/r, calf_l/r, foot_l/r),
translations from `inverseBindMatrices` decomposition, restRot from bind
quaternion (T-173). `archetype: "biped"`.

Morph params: `legLength`, `armLength`, `torsoHeight`, `shoulderWidth`,
`headSize`, `hipWidth`, plus per-side variants (`rightArmScale`,
`leftArmScale`, `rightLegScale`, `leftLegScale`) for asymmetric monsters.

Import ~20 UAL2 clips into `data/anim_library/biped/`: idle, walk, run
(Walk_Carry_Loop), jump_start/loop/land, slide, melee_hook, sword_combo,
hit_knockback, death, idle variants. No `_skeleton` field — folder placement
is authoritative (T-178).

Done when: biped skeleton + library load via JsonSource; sample biped NPC
plays distinct walk vs. run vs. attack from library clips; AnimationSlots
mappings resolve cleanly.

### T-180 · Migrate creatures to biped via morphs (retire one-off skeletons)
Effort: M   Status: done

Drowner, rotten_knight, human, bandit, archer, villager all migrate to
`skeletonId: "biped"`. Per-prefab morph values express proportions:

  drowner       { armLength: 1.4, legLength: 0.85, headSize: 1.1 }
  rotten_knight { torsoHeight: 1.1, rightArmScale: 1.5, … }
  human         { } (defaults)

Per-side morph application: extend the morph applier in
`skeleton_solver.ts` to scale single bones (not bilateral) when the param
targets an `_l`/`_r` suffix bone. Voxel parts updated to match canonical
biped offsets.

Delete `skeletons/drowner.json`, `skeletons/rotten_knight.json`, and
`skeletons/human.json` (the latter only if all human prefabs migrate
cleanly). `skeletons/wolf.json` untouched — different archetype.

Done when: every humanoid creature uses biped + morphs; old per-creature
humanoid skeleton JSONs deleted; rotten_knight's giant arm renders correctly
without authoring a separate skeleton.

### T-181 · Behavior tree runtime in @voxim/content + first BT as data
Effort: L   Status: todo

Move behavior-tree concepts from `tile-server/src/systems/npc_ai.ts` into
`@voxim/content` as a generic engine algorithm. Schema for `BehaviorTreeDef`:

  Composite nodes: sequence, selector, parallel
  Decorator nodes: invert, repeat, succeed-on-fail, cooldown
  Leaf nodes:      declarative action references (find_target, move_to,
                   attack_target, idle_wait) that resolve against an
                   ActionRegistry the host process supplies

Tree definitions live at `data/behavior_trees/{id}.json`. Migrate the
"hostile" tree (currently hardcoded in npc_ai.ts) to data. NPC templates
already reference `behaviorTreeId`; the lookup goes through
`content.behaviorTrees.getOrThrow(id)`.

Algorithm/data split: tree TICK runtime in `@voxim/content` (engine code),
tree DEFINITIONS in JSON (data), leaf ACTION implementations in tile-server
(registered with the runtime). Adding a new AI archetype = one JSON file.

Done when: hostile tree loads from data; NPC AI ticks against the loaded
tree; adding "skittish" or "patrol" archetypes is a content-only change
with no code edits.

### T-182 · State machine runtime + animation state machines as data
Effort: M   Status: todo

State machine concepts (currently buried in animation slot indirection plus
ad-hoc velocity-checks in `animation.ts`) move to `@voxim/content` as a
generic runtime. Schema for `StateMachineDef`:

  states:      { id, onEnter?, onExit?, layers? }
  transitions: { from, to, condition: ConditionExpr, priority }

`ConditionExpr` is a small data-driven expression: comparisons on entity
component values (`velocity.magnitude > 4`, `health.current / health.max < 0.3`,
`isOnGround === true`), boolean composition. Evaluated each tick.

Existing animation slot logic refactored into a state machine
(`humanoid_default`) with idle/walk/run/death/attack states. NPC templates
declare `stateMachineId: "humanoid_default"`.

Done when: animation transitions resolve via SM tick (not hardcoded velocity
comparisons); two NPCs sharing an SM share behavior; per-prefab SM override
is one JSON field flip.

### T-183 · Procedural generator framework + loot / names / POIs
Effort: L   Status: todo

Generic procedural-generation runtime in `@voxim/content`. Engine ships a
small set of named algorithms registered by id:

  weighted_draw  picks from a weighted list (loot, spawn weights)
  markov         Markov-chain sampling (names from phoneme tables)
  grammar        L-system / context-free expansion (POI / settlement layouts)
  template       placeholder substitution (quest / dialogue text)
  curve          piecewise-linear evaluator (stat scaling, difficulty curves)

Each generator declaration in content names an algorithm + params:

  data/generators/loot/{id}.json   LootTableDef    (uses weighted_draw)
  data/generators/names/{id}.json  NameGeneratorDef (uses markov)
  data/generators/poi/{id}.json    PoiTemplateDef   (uses grammar)

Engine entry point: `content.invoke<I, O>(generatorId, input): O` — routes
to the algorithm based on the declaration's `algorithm` field.

First migrations:
  - `poi_placer`'s hardcoded room shape → `PoiTemplateDef` (grammar)
  - new loot tables for wolf / drowner / rotten_knight corpses
  - one name generator per culture (NPCs currently share their type as name)

Done when: poi_placer reads its room shape from data; killing a wolf drops
items from a generator-driven loot table; spawned NPCs receive names from a
generator. Adding a new generator type (e.g. dialogue templates) is purely
additive — register the algorithm in @voxim/content, drop declarations in
data/generators/.

---

## Ops & Deployment

### T-158 · CI image publish + production compose
Effort: S   Status: done   Commit: db7c589

Until now there was no path from a green build to a deployable artifact —
the sysadmin would have had to clone the repo, run `docker compose build`,
and reason about source state on the host. Replace that with a registry-
based deploy: GitHub Actions builds and pushes every server image, the
sysadmin runs a compose file that only references images.

- `.github/workflows/docker-publish.yml`: manual `workflow_dispatch` trigger.
  Matrix builds all six images (gateway, coordinator, atlas, tile-server,
  certs-init, client-dev) in parallel, pushes to
  `ghcr.io/<owner>/<repo>/<service>`. Every build gets `:sha-<short>`;
  runs whose ref is `main` (or that pass `tag_latest=true`) also update
  `:latest`. Auth via `GITHUB_TOKEN` with `packages: write` — no extra
  secrets. GHA cache wired per-service so reruns are fast.
- `docker-compose.prod.yml`: mirrors the base compose service shape but
  replaces every `build:` with an `image:` reference parameterised by
  `VOXIM_IMAGE_REPO` (default `ghcr.io/the-sidner/voxim`) and `VOXIM_TAG`
  (default `latest`). Drops dev-only bind mounts. Sysadmin keeps a
  populated `.env` and runs
  `docker compose -f docker-compose.prod.yml --env-file .env up -d`.
  To pin a specific build set `VOXIM_TAG=sha-<short>` before `pull && up -d`.
- `.env.example`: document the two new variables.

Done when: a manual workflow run produces six ghcr.io tags, the sysadmin
pulls them on a clean host with only `docker-compose.prod.yml` + `.env`,
and the stack comes up identically to the dev compose.

