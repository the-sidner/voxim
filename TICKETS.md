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
Effort: L   Status: todo

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
Effort: L   Status: todo   Phase 5 of T-121

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

---

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

