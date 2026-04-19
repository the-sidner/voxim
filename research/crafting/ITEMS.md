# Item Catalogue — Recipes by Item

Inverts the chain research. Each entry names an item the game needs,
explains what role it plays, and lists one or more recipes producing it.

Multi-recipe is encouraged where historically justified — same output,
different inputs and workstations. Recipes are authored against the
[CONSOLIDATION.md](CONSOLIDATION.md) taxonomy (17 station families).

---

## Authoring philosophy — component-based orthogonal assembly

The previous pass treated every weapon and tool as an atomic recipe:
"plank + iron → sword". That collapses history into placeholders and
kills the combinatorics. This catalogue instead recognises a **middle
tier** between raw materials and finished items:

```
raw materials      →  primary materials  →  COMPONENTS  →  assemblies
(ore, wood, hide)     (ingot, plank,        (blade,        (sword, jerkin,
                       leather, cloth)       haft, strap,    knife, axe, bow)
                                             panel, head)
```

A sword is a **blade + haft (+ optionally pommel, grip-wrap)**. A knife
is a **blade + short haft**. A spear is a **spear-head + long haft**.
An axe (tool) is an **axe-head + medium haft**. The same `blade`
component produces sword, dagger, knife, glaive; the same `haft_medium`
produces sword, axe, mace, hammer, pickaxe. **Orthogonality is the
content**: five blades × four hafts × three grips = 60 weapon variants
from twelve components.

**Material tiers multiply the orthogonality.** Copper, bronze, iron,
and steel blades are all valid `blade` items; they plug into the same
haft. The sword recipe doesn't care which — it reads the blade's
`MaterialSource` component via Voxim's `Composed` + `outputSlot`
system and the output sword inherits the material's damage / weight /
edge-retention. One recipe, four weapon grades, driven by which
ingredient you fed.

**Practical authoring note.** In this catalogue, material variants of
a component are listed as separate entries (`iron_blade_medium`,
`bronze_blade_medium`, …) for clarity. When the prefabs are authored,
the implementer may choose to collapse them via `Composed` — a single
`blade_medium` prefab, produced by multiple recipes, each depositing
different `MaterialSource` data. The catalogue does not prescribe this;
it lists what must exist semantically.

**Assembly workstation.** The `bench` family (see CONSOLIDATION §"The
bench collapse") with `stepType: assembly` is the universal assembly
surface. Pick a recipe (sword vs knife), place the components, swing
the tool. One station, many outputs. Ready today with no engine work.

---

## Table of contents

- [§1 Primitives](#1-primitives-gathered-not-crafted)
- [§2 Primary materials](#2-primary-materials-t2-first-processing)
- [§3 Components (T3)](#3-components-t3--the-orthogonal-middle-tier)
  - [§3a Metal components](#3a-metal-components)
  - [§3b Wood components](#3b-wood-components)
  - [§3c Leather components](#3c-leather-components)
  - [§3d Textile components](#3d-textile-components)
  - [§3e Cord / thread / string](#3e-cord--thread--string)
  - [§3f Ceramic components](#3f-ceramic-components)
  - [§3g Bone / horn / sinew components](#3g-bone--horn--sinew-components)
- [§4 Tools (T4 assembly)](#4-tools-t4-assembly)
- [§5 Weapons (T4 assembly)](#5-weapons-t4-assembly)
- [§6 Armour (T4 assembly)](#6-armour-t4-assembly)
- [§7 Containers and vessels](#7-containers-and-vessels)
- [§8 Food, drink, preserved](#8-food-drink-preserved)
- [§9 Finished clothing and textiles](#9-finished-clothing-and-textiles)
- [§10 Lore physicals](#10-lore-physicals)
- [§11 Lighting](#11-lighting)
- [§12 Alchemical, chemical, paints](#12-alchemical-chemical-paints)
- [§13 Ceramics (finished goods)](#13-ceramics-finished-goods)
- [§14 Furniture](#14-furniture)
- [§15 Transport & horse tack](#15-transport--horse-tack)
- [§16 Fishing & trapping](#16-fishing--trapping)
- [§17 Religious items](#17-religious-items)
- [§18 Farming & gardening](#18-farming--gardening)
- [§19 Construction finishing](#19-construction-finishing)
- [§20 Locks, keys, security](#20-locks-keys-security)
- [§21 Apothecary & herbal remedies](#21-apothecary--herbal-remedies)
- [§22 Instruments](#22-instruments)
- [§23 Struck coinage & administrative](#23-struck-coinage--administrative)
- [§24 Byproducts](#24-byproducts)

---

## Notation

Throughout this catalogue:

- `Kind`: **stack** (fungible, `{ prefabId, quantity }` inventory slot) or **unique** (entity-backed, carries per-instance components like Durability / QualityStamped).
- `Station` values come from [CONSOLIDATION.md](CONSOLIDATION.md)'s 17-family taxonomy (`furnace`, `bench`, `vat`, etc.). Specific variants within a family (`anvil` as a `bench`, `bloomery` as a `furnace`) are noted in parentheses.
- `Step`: one of `attack` (tool swing resolves), `assembly` (player picks recipe from multi-match, then tool swing resolves), `time` (timer after inputs placed).
- `Ticks` at 20 Hz. `0` on attack/assembly recipes means the resolve is instant on the triggering swing; the "time" the player experiences is the windup + active of that swing.
- **Lore gate**: where noted, the recipe is invisible until the crafter has learned the referenced fragment.
- **GAP-** tags flag engine limitations that flatten the recipe's intended flavour. See [SUMMARY.md §4](SUMMARY.md) for the taxonomy.

**Compact table format** is used for straightforward recipes (most components). Full indented recipe blocks are used only for items with real multi-step chains (linen, leather, iron, bread, ale, etc.).

---

## 1. Primitives (gathered, not crafted)

Resource-node drops. No recipes; downstream recipes cite them.

| id | Biome / node | Role |
|---|---|---|
| `wood` | tree node, any forest | All woodwork; fuel |
| `oak_wood` | oak tree | Tannin-bearing; best hafts |
| `pine_wood` | pine / conifer | Straight-grained; stave; resinous variant = fatwood |
| `birch_wood` | birch | Bark separately harvestable |
| `fatwood` | old pine stump | Tar feedstock |
| `bark` | any tree, chopped | Tannin, tinder, roofing |
| `birch_bark` | birch | Waterproof roofing; tar; cordage |
| `oak_bark` | oak | Primary bark for vegetable tanning |
| `stone` | rock node | Crude tools; aggregate |
| `flint_nodule` | coastal / chalk | Knapped blades; strike-a-light |
| `clay` | riverbed / pit | Pottery, brick, mortar |
| `fireclay` | rare pit | Crucibles, kiln lining |
| `sand` | coastal / desert | Glass; sand casting |
| `limestone` | quarry | Lime burn |
| `iron_ore` | mountain | Iron smelt |
| `bog_ore` | wetland | Lower-yield iron (GAP-ENV) |
| `copper_ore` | mountain | Copper smelt |
| `tin_ore` | mountain (rare) | Bronze alloy |
| `lead_ore` (galena) | mountain | Lead / silver |
| `silver_ore` (rare) | mountain | Coinage; inlay |
| `gold_nugget` | river panning | Coinage; inlay |
| `salt_rock` | coastal / saline spring | Direct salt source |
| `brine` | coastal / saline spring (liquid) | Boil / evaporate → salt |
| `flax_stalks` | cultivated plains | Linen chain |
| `hemp_stalks` | cultivated plains | Rope chain; coarse cloth |
| `raw_wool` | sheep node | Wool chain |
| `raw_hide` | animal kill | Leather chain |
| `raw_pelt` | fur-bearing animal | Fur-lined clothing |
| `raw_meat` | animal kill | Cook / cure |
| `bone` | animal kill | Tool bits, glue, bone-ash |
| `sinew` | animal kill | Bowstring, thread, bindings |
| `horn` | cattle / goat kill | Cups, bowstring nocks, strips |
| `gut` | animal kill | Dried strings, cordage |
| `animal_fat` | animal kill | Tallow rendering |
| `grain` | cultivated plains | Flour, malt |
| `rye_grain` | cooler plains | Rye bread, coarse ale |
| `barley_grain` | plains | Ale malt |
| `oats` | plains | Porridge |
| `mushroom` | forest floor | Food; some medicinal |
| `berry` | bush | Food; cordial |
| `herb_rosemary` | varied | Flavouring; weak medicinal |
| `herb_sage` | varied | Flavouring; ceremonial |
| `herb_yarrow` | meadow | Medicinal wound-wash |
| `herb_comfrey` | meadow / damp | Bone-knit salve; poultice |
| `herb_mint` | wild / cultivated | Digestive; flavouring |
| `herb_mullein` | waste ground | Cough remedy; lamp-wick |
| `herb_chamomile` | meadow | Sleeping draught; eye-wash |
| `herb_willowbark` | willow tree | Pain-relief tincture |
| `herb_comfrey_root` | comfrey deep-root | Stronger than leaves |
| `willow_osier` | young willow (wetland) | Wicker weaving |
| `reed` | wetland / pond | Thatching, basketry, pen-cut |
| `straw` | grain harvest byproduct | Thatch, stuffing, bedding |
| `yew_wood` | yew tree (rare) | Longbow staves |
| `horsehair` | horse shear / kill | Fiddle bow; rope; sieve |
| `apple` | apple tree / orchard | Cider, food |
| `grape` | vineyard | Wine, must |
| `olive` | olive tree (warm) | Oil press |
| `rose_petal` | rose bush | Rose water, perfume |
| `raw_fish` | water node, rod or net | Food; stockfish |
| `red_earth` | iron-rich soil | Pigment (red ochre) |
| `cinnabar_ore` | rare mineral | Pigment (vermilion) |
| `calamine` | zinc ore (rare) | Brass cementation |
| `dung` | livestock / field gather | Bate liquor; fertiliser; lead-white beds |
| `honey_comb` | bee node | Wax + honey |
| `oak_gall` | oak rare drop | Ink |
| `woad_leaves` | cultivated | Blue dye (woad vat) |
| `madder_root` | cultivated | Red dye |
| `weld_plant` | cultivated | Yellow dye |
| `indigo_leaf` | rare cultivated | Blue dye (alternative to woad) |
| `walnut_husk` | walnut tree | Brown dye |
| `alum_crystal` | volcanic / rare pit | Mordant |
| `nitre_earth` | old-cellar deposit | Saltpeter precursor |
| `water` | water source | Universal solvent |
| `feather` | bird kill | Arrow fletching; quill |
| `quill_feather` | large bird kill | Writing quill |
| `beeswax` | honeycomb rendered | Candles; lost-wax; seals |
| `milk` | cow / goat livestock | Dairy products |

---

## 2. Primary materials (T2, first-processing)

First-layer stacks produced from primitives by one-step recipes. These
feed the Components tier.

### Woodwork first-layer

#### `plank`

**Kind:** stack **Role:** All flat-wood assembly; blueprint material.  
**Status:** Authored.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Chop (today) | wood ×1 | `bench` (chopping_block) | axe | attack | 0 | plank ×2 |
| Rive (higher yield) | wood ×1 | `bench` (riving_brake) | froe | attack | 0 | plank ×3 + bark ×1 |

**Lore gate (rive):** `fragment_riving`.

#### `wooden_billet`

**Kind:** stack **Role:** Rough blank for turning / carving.  
**Status:** Proposed.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Split billet | wood ×1 | `bench` (riving_brake) | froe | attack | 0 | wooden_billet ×1 |

#### `sawdust`

**Kind:** stack **Role:** Smoking fuel (for smokehouse), tinder, glue-filler.  
**Status:** Byproduct of sawing recipes. See §14.

### Stonework first-layer

#### `stone_block`

**Kind:** stack **Role:** Masonry; stone blueprints.  
**Status:** Authored.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Dress | stone ×2 | `bench` (mason_bench) | chisel | attack | 0 | stone_block ×1 + stone_chip ×1 |

#### `crushed_stone`

**Kind:** stack **Role:** Aggregate for mortar; road fill.  
**Status:** Proposed.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Crush | stone ×1 | `millstone` (ore_stamp) | maul | attack | 0 | crushed_stone ×2 |

#### `flint_flake`

**Kind:** stack **Role:** Small blade bits, strike-a-light, arrowheads (stone-tier).  
**Status:** Proposed.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Knap | flint_nodule ×1 | `bench` (knapping_stump) | — (hand-knap) | attack | 0 | flint_flake ×3 + stone_chip ×2 |

**Lore gate:** none — universal stone-age tech.

### Metal first-layer ingots

Each metal has the same shape: ore → smelt at `furnace` → ingot. Full
historical chain (bloomery) for iron documented in §Iron bloom chain
below. Simpler one-step recipes match what ships today.

#### `iron_ingot`

**Kind:** stack **Role:** Base for every iron component.  
**Status:** Authored (one-step stub).

**Simple recipe (today):**

| Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|
| iron_ore ×1 + coal ×1 | `campfire` | — | time | 120 | iron_ingot ×1 |

**Full bloomery chain (proposed):** see §Iron bloom chain after this section.

#### `copper_ingot`

**Kind:** stack **Status:** Authored.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Smelt (today) | copper_ore ×1 + coal ×1 | `campfire` | time | 100 | copper_ingot ×1 |
| Matte (proposed) | copper_ore ×3 + charcoal ×3 | `furnace` | time | 500 | copper_matte ×2 + slag ×1 |
| Refine | copper_matte ×2 + charcoal ×2 | `furnace` (crucible) | time | 400 | copper_ingot ×2 |

#### `bronze_ingot`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Crucible alloy | copper_ingot ×4 + tin_ore ×1 + charcoal ×2 | `furnace` (crucible) | time | 300 | bronze_ingot ×4 |
| Brass (zinc vapour) | copper_ingot ×3 + calamine ×1 + charcoal ×2 | `furnace` (cementation) | time | 900 | brass_ingot ×3 |

**Lore gate:** `fragment_bronze_alloy` / `fragment_brass_cementation`.  
**GAP-PROCESS-PARAM:** copper/tin ratio is the craft — today fixed per recipe.

#### `lead_ingot`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Low-temp smelt | lead_ore ×2 + charcoal ×1 | `furnace` (lead hearth) | time | 300 | lead_ingot ×1 + silver_trace ×0–1 |

**Notes:** Silver byproduct is unreliable; cupellation refines it to `silver_ingot`. See §Silver refining.

#### `silver_ingot`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Cupellation | lead_ingot ×3 + bone_ash_cupel ×1 + charcoal ×2 | `furnace` (cupellation) | time | 600 | silver_ingot ×1 + litharge ×2 |

**GAP-CONSUMED-STATION** — the bone-ash cupel is consumed per smelt; modelled here as an input item.

#### `steel_ingot`

**Kind:** stack **Status:** Proposed — late-game rarity.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Cementation steel | iron_ingot ×3 + charcoal ×4 | `furnace` (cementation) | time | 1800 | steel_ingot ×3 |
| Crucible (wootz) | iron_ingot ×2 + charcoal ×3 | `furnace` (crucible) | time | 1200 | wootz_ingot ×2 |

**Lore gate:** `fragment_cementation_steel`, `fragment_wootz`.

#### `gold_ingot`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Melt and cast | gold_nugget ×3 | `cauldron` (tinning_pot variant) | time | 150 | gold_ingot ×1 |

### Iron bloom chain (proposed full replacement for iron_ingot)

Three-step via `chainNextRecipeId`.

**Step A — Roast ore (off-gas sulphur, dry bog-water):**
| Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|
| iron_ore ×3 + wood ×2 | `furnace` (roasting) | time | 600 | roasted_ore ×3 |

**Step B — Bloom smelt:**
| Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|
| roasted_ore ×3 + charcoal ×4 | `furnace` (bloomery) | time | 800 | raw_bloom ×1 + slag ×2 |

**Step C — Consolidate bloom:**
| Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|
| raw_bloom ×1 | `bench` (anvil) | hammer | attack | 0 | iron_ingot ×1 + hammer_scale ×1 |

**GAP-PROCESS-PARAM** (draught), **GAP-BATCH** (real blooms ×5–10 kg).

### Ceramic / stone first-layer

#### `quicklime`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Calcine | limestone ×3 + charcoal ×2 | `furnace` (lime kiln) | time | 900 | quicklime ×2 + flue_dust ×1 |

#### `slaked_lime`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Slake | quicklime ×1 + water ×2 | `danger_pit` | time | 100 | slaked_lime ×1 |

**GAP-DANGER-INPUT**. Ships-in `cauldron` as safe fallback today.

#### `mortar_paste`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Mix | slaked_lime ×1 + sand ×2 + water ×1 | `vat` (mortar trough) | time | 60 | mortar_paste ×3 |

#### `fireclay_brick` (unfired)

Use green_brick in §13; this id deprecated.

### Fuel first-layer

#### `charcoal`

**Kind:** stack **Role:** Universal reducing fuel.  
**Status:** Proposed (today's `coal` primitive stands in).

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Pit burn | wood ×10 | `pyrolysis_pit` | time | 2400 | charcoal ×6 + wood_ash ×1 |
| Kiln burn (higher yield) | wood ×10 | `kiln` | time | 1800 | charcoal ×7 + wood_ash ×1 |

**Lore gate (kiln variant):** `fragment_kiln_charcoal`.  
**GAP-CONSUMED-STATION** for the pit (deployable that despawns on complete).

#### `coal`

**Kind:** stack **Role:** Alternative fuel (mineral coal, not charcoal).  
**Status:** Authored as primitive today. Keep as gatherable.

#### `kindling`

**Kind:** stack **Status:** Authored.

| Recipe | Inputs | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| Split | wood ×1 | `bench` (chopping_block) | axe | attack | 0 | kindling ×4 |

### Fibres first-layer (cord/thread pre-assembly)

#### `linen_yarn`

Produced by Step E of the linen chain in §Linen chain below. Listed here for forward-reference.

#### `wool_yarn`

Produced by Step C of the wool chain in §Wool chain. Forward-reference.

#### `hemp_cord`

**Kind:** stack **Status:** Proposed.

Same chain as linen but with hemp_stalks; lower grade, coarser. Explicit catalogue entry omitted to avoid duplication — use the linen chain with `hemp_stalks` substituted.

### Ashes / solvents first-layer

#### `wood_ash`

**Kind:** stack **Status:** Byproduct of every wood-fire recipe. See §14.

#### `lye`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Cold leach | wood_ash ×4 + water ×2 | `vat` (ash_hopper) | time | 400 | lye ×1 + spent_ash ×1 |
| Boil down (concentrate) | lye ×2 | `cauldron` | time | 200 | concentrated_lye ×1 |

#### `potash`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Evaporate | concentrated_lye ×2 | `pan` | time | 800 | potash ×1 |

#### `salt`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Boil brine | brine ×4 | `pan` | time | 600 | salt ×2 |
| Solar pan | brine ×8 | `pan` (solar) | time | 2400 | salt ×5 |

**GAP-ENV** (solar).

#### `tallow`

**Kind:** stack **Status:** Proposed.

| Recipe | Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|---|
| Render | animal_fat ×2 + water ×1 | `cauldron` | time | 400 | tallow ×2 + greaves ×1 |

### Leather first-layer

#### `tanned_leather`

Produced by the bark-tanning chain (§Leather chain). Forward-reference;
full multi-step recipe lives there.

#### `parchment`

Produced by the parchment-branch chain (§Leather chain). Forward-ref.

---

## 3. Components (T3) — the orthogonal middle tier

### 3a. Metal components

Blades, heads, hardware, sheet, wire. Most recipes are `anvil` (a
`bench` variant) with `hammer` tool. Each material tier — copper,
bronze, iron, steel — produces a separate catalogue entry; see
Authoring Philosophy for the Composed-collapse note.

#### Blades

The generic cutting edge. **Same blade is used in sword, dagger,
knife, glaive.** Size distinguishes use case.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `copper_blade_small` | unique | copper_ingot ×1 | anvil | hammer | attack | copper_blade_small ×1 + hammer_scale ×0–1 |
| `copper_blade_medium` | unique | copper_ingot ×2 + charcoal ×1 | anvil | hammer | attack | copper_blade_medium ×1 + hammer_scale ×1 |
| `copper_blade_large` | unique | copper_ingot ×3 + charcoal ×1 | anvil | hammer | attack | copper_blade_large ×1 + hammer_scale ×1 |
| `bronze_blade_small` | unique | bronze_ingot ×1 | anvil | hammer | attack | bronze_blade_small ×1 |
| `bronze_blade_medium` | unique | bronze_ingot ×2 + charcoal ×1 | anvil | hammer | attack | bronze_blade_medium ×1 + hammer_scale ×1 |
| `bronze_blade_large` | unique | bronze_ingot ×3 + charcoal ×1 | anvil | hammer | attack | bronze_blade_large ×1 + hammer_scale ×1 |
| `iron_blade_small` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_blade_small ×1 + hammer_scale ×1 |
| `iron_blade_medium` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | attack | iron_blade_medium ×1 + hammer_scale ×1 |
| `iron_blade_large` | unique | iron_ingot ×3 + charcoal ×1 | anvil | hammer | attack | iron_blade_large ×1 + hammer_scale ×1 |
| `steel_blade_small` | unique | steel_ingot ×1 + charcoal ×1 | anvil | hammer | attack | steel_blade_small ×1 |
| `steel_blade_medium` | unique | steel_ingot ×2 + charcoal ×1 | anvil | hammer | attack | steel_blade_medium ×1 |
| `steel_blade_large` | unique | steel_ingot ×3 + charcoal ×1 | anvil | hammer | attack | steel_blade_large ×1 |
| `flint_blade_small` | unique | flint_nodule ×1 | `bench` (knapping_stump) | — | attack | flint_blade_small ×1 + stone_chip ×2 |

**Notes on blades.** Tempered steel blades optionally go through a quench
(`vat` or `cauldron`) and temper (`furnace`) chain before being counted
as `steel_blade_*` — see Iron sword chain in §5.

#### Weapon heads

Not interchangeable with blades — these are purpose-shaped (thick spine,
pierce-tip, or striking mass).

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `bronze_axe_head` | unique | bronze_ingot ×2 | anvil | hammer | assembly | bronze_axe_head ×1 |
| `iron_axe_head` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | assembly | iron_axe_head ×1 + hammer_scale ×1 |
| `steel_axe_head` | unique | steel_ingot ×2 + charcoal ×1 | anvil | hammer | assembly | steel_axe_head ×1 |
| `iron_pickaxe_head` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | assembly | iron_pickaxe_head ×1 |
| `iron_hammer_head` | unique | iron_ingot ×2 | anvil | hammer | assembly | iron_hammer_head ×1 |
| `iron_mace_head` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | assembly | iron_mace_head ×1 |
| `iron_spear_head` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_spear_head ×1 |
| `bronze_spear_head` | unique | bronze_ingot ×1 | anvil | hammer | attack | bronze_spear_head ×1 |
| `iron_adze_head` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | assembly | iron_adze_head ×1 |
| `iron_hoe_head` | unique | iron_ingot ×1 | anvil | hammer | assembly | iron_hoe_head ×1 |
| `iron_scythe_blade` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | attack | iron_scythe_blade ×1 |
| `iron_sickle_blade` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_sickle_blade ×1 |
| `iron_shovel_blade` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | assembly | iron_shovel_blade ×1 |
| `iron_chisel_bit` | unique | iron_ingot ×1 | anvil | hammer | attack | iron_chisel_bit ×1 |
| `iron_drill_bit` | unique | iron_ingot ×1 | anvil | hammer | attack | iron_drill_bit ×1 |
| `iron_plane_blade` | unique | iron_ingot ×1 | anvil | hammer | attack | iron_plane_blade ×1 |
| `iron_saw_blade` | unique | iron_ingot ×2 + charcoal ×1 | anvil | hammer | attack | iron_saw_blade ×1 |
| `iron_shears_blades` | unique | iron_ingot ×1 | anvil | hammer | attack | iron_shears_blades ×1 |
| `iron_awl_spike` | unique | iron_ingot ×1 | anvil | hammer | attack | iron_awl_spike ×1 |
| `iron_needle` | stack | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_needle ×6 |
| `bone_needle` | stack | bone ×1 | `bench` | knife | attack | bone_needle ×3 |

#### Arrow and bolt heads

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `flint_arrow_head` | stack | flint_nodule ×1 | `bench` (knapping_stump) | — | attack | flint_arrow_head ×5 + stone_chip ×2 |
| `iron_arrow_head` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_arrow_head ×8 |
| `iron_bodkin_point` | stack | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_bodkin_point ×6 |
| `iron_broadhead` | stack | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_broadhead ×4 |
| `iron_bolt_head` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_bolt_head ×10 |

**Notes.** Bodkin penetrates mail. Broadhead deals more damage to unarmoured targets. Bolt is crossbow ammo.

#### Structural hardware (small iron fittings)

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_nail` | stack | iron_ingot ×1 | anvil (`bench` with heading_block variant) | hammer | attack | iron_nail ×20 |
| `iron_hinge` | stack | iron_ingot ×1 | anvil | hammer | assembly | iron_hinge ×2 |
| `iron_latch` | stack | iron_ingot ×1 | anvil | hammer | assembly | iron_latch ×2 |
| `iron_buckle` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_buckle ×4 |
| `iron_rivet` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_rivet ×20 |
| `iron_clasp` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_clasp ×4 |
| `iron_ring` | stack | iron_wire ×1 | anvil | hammer | attack | iron_ring ×40 |
| `iron_chain_link` | stack | iron_wire ×1 | anvil | hammer | attack | iron_chain_link ×20 |
| `iron_spike` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_spike ×8 |

#### Drawn metal (wire, strip, sheet)

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_wire` | stack | iron_ingot ×1 + charcoal ×1 | `bench` (draw_bench) | tongs | attack | iron_wire ×4 |
| `copper_wire` | stack | copper_ingot ×1 | `bench` (draw_bench) | tongs | attack | copper_wire ×5 |
| `iron_strip` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_strip ×3 |
| `iron_sheet` | stack | iron_ingot ×2 + charcoal ×1 | anvil | hammer | attack | iron_sheet ×1 |
| `copper_sheet` | stack | copper_ingot ×2 | anvil | hammer | attack | copper_sheet ×1 |
| `lead_sheet` | stack | lead_ingot ×1 | anvil | hammer | attack | lead_sheet ×2 |
| `silver_sheet` | stack | silver_ingot ×1 | anvil | hammer | attack | silver_sheet ×2 |

#### Armour plates (pre-shaped iron/steel panels)

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_plate_panel` | stack | iron_sheet ×2 + charcoal ×1 | anvil | hammer | assembly | iron_plate_panel ×1 |
| `steel_plate_panel` | stack | iron_sheet ×2 + charcoal ×2 | anvil | hammer | assembly | steel_plate_panel ×1 |
| `iron_skull_cap` | unique | iron_sheet ×2 + charcoal ×1 | anvil | hammer | assembly | iron_skull_cap ×1 |
| `iron_cheek_piece` | stack | iron_sheet ×1 | anvil | hammer | assembly | iron_cheek_piece ×2 |
| `iron_greave_plate` | unique | iron_sheet ×2 + charcoal ×1 | anvil | hammer | assembly | iron_greave_plate ×1 |
| `iron_vambrace_plate` | unique | iron_sheet ×1 + charcoal ×1 | anvil | hammer | assembly | iron_vambrace_plate ×1 |
| `iron_gauntlet_plate` | unique | iron_sheet ×1 + charcoal ×1 | anvil | hammer | assembly | iron_gauntlet_plate ×1 |
| `iron_shield_boss` | unique | iron_sheet ×2 + charcoal ×1 | anvil | hammer | assembly | iron_shield_boss ×1 |
| `iron_shield_rim` | stack | iron_strip ×2 | anvil | hammer | attack | iron_shield_rim ×1 |

#### Specialty metal

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `copper_pan_blank` | unique | copper_sheet ×2 | anvil | hammer | assembly | copper_pan_blank ×1 |
| `iron_pot_shell` | unique | iron_sheet ×3 + charcoal ×1 | anvil | hammer | assembly | iron_pot_shell ×1 |
| `iron_crucible` | unique | iron_sheet ×2 + charcoal ×2 | anvil | hammer | assembly | iron_crucible ×1 |
| `silver_coin_blank` | stack | silver_sheet ×1 | anvil | hammer | attack | silver_coin_blank ×10 |
| `copper_coin_blank` | stack | copper_sheet ×1 | anvil | hammer | attack | copper_coin_blank ×15 |
| `gold_coin_blank` | stack | gold_ingot ×1 | anvil | hammer | attack | gold_coin_blank ×5 |

**Notes.** Coin blanks → struck coins (see §12 Alchemical / coinage or §11 Trade).

---

### 3b. Wood components

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_haft_short` | stack | plank ×1 | `bench` (shaving_horse) | draw_knife / knife | attack | wooden_haft_short ×2 |
| `wooden_haft_medium` | stack | plank ×1 | `bench` (shaving_horse) | draw_knife / knife | attack | wooden_haft_medium ×1 |
| `wooden_haft_long` | stack | plank ×2 | `bench` (shaving_horse) | draw_knife / knife | attack | wooden_haft_long ×1 |
| `wooden_arrow_shaft` | stack | plank ×1 | `bench` | knife | attack | wooden_arrow_shaft ×8 |
| `wooden_bolt_shaft` | stack | plank ×1 | `bench` | knife | attack | wooden_bolt_shaft ×12 |
| `bow_stave_short` | unique | wooden_billet ×1 | `bench` (shaving_horse) | draw_knife | attack | bow_stave_short ×1 |
| `bow_stave_long` | unique | wooden_billet ×2 | `bench` (shaving_horse) | draw_knife | attack | bow_stave_long ×1 |
| `crossbow_stock` | unique | plank ×3 | `bench` | plane / chisel | assembly | crossbow_stock ×1 |
| `crossbow_prod` | unique | wooden_billet ×1 + horn ×1 | `bench` | draw_knife | assembly | crossbow_prod ×1 |
| `wooden_pommel` | stack | wooden_billet ×1 | `loom_device` (pole_lathe) | turning_chisel | time | wooden_pommel ×3 |
| `metal_pommel` | stack | iron_ingot ×1 | anvil | hammer | attack | metal_pommel ×2 |
| `wooden_dowel` | stack | plank ×1 | `loom_device` (pole_lathe) | turning_chisel | time | wooden_dowel ×6 |
| `wooden_shield_blank` | unique | plank ×3 | `bench` | plane | assembly | wooden_shield_blank ×1 |
| `wooden_wedge` | stack | wooden_billet ×1 | `bench` | axe | attack | wooden_wedge ×6 |
| `barrel_stave` | stack | plank ×1 | `bench` (riving_brake) | froe | attack | barrel_stave ×3 |
| `barrel_head` | stack | plank ×2 | `bench` | saw / plane | attack | barrel_head ×1 |
| `wooden_spoke` | stack | wooden_billet ×1 | `loom_device` (pole_lathe) | turning_chisel | time | wooden_spoke ×4 |

**Notes.** `wooden_haft_*` is the universal stick — any haft fits any head in the same size class. A wooden_pommel is cheap; a metal_pommel is heavier (better balance) but uses an ingot. `barrel_stave` + `iron_strip` + `barrel_head` → finished barrel (see §7).

---

### 3c. Leather components

Bark-tanned or alum-tawed leather cut into functional shapes.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_strip` | stack | tanned_leather ×1 | `bench` (currying_bench) | knife | attack | leather_strip ×6 |
| `leather_panel` | stack | tanned_leather ×1 | `bench` | knife | attack | leather_panel ×2 |
| `leather_strap` | stack | tanned_leather ×1 | `bench` | knife | attack | leather_strap ×3 |
| `leather_thong` | stack | tanned_leather ×1 | `bench` | knife | attack | leather_thong ×8 |
| `leather_grip_wrap` | stack | leather_strip ×1 + linen_thread ×1 | `bench` | awl | assembly | leather_grip_wrap ×1 |
| `leather_sheath_blank` | unique | leather_panel ×1 + linen_thread ×1 | `bench` | awl | assembly | leather_sheath_blank ×1 |
| `leather_boot_upper` | unique | leather_panel ×2 + linen_thread ×2 | `bench` | awl | assembly | leather_boot_upper ×1 |
| `leather_gauntlet_blank` | unique | leather_panel ×1 + linen_thread ×1 | `bench` | awl | assembly | leather_gauntlet_blank ×1 |
| `leather_belt_blank` | unique | leather_strap ×1 + iron_buckle ×1 | `bench` | awl | assembly | leather_belt_blank ×1 |
| `leather_pouch_blank` | unique | leather_panel ×1 + leather_thong ×1 | `bench` | awl | assembly | leather_pouch_blank ×1 |
| `rawhide_strip` | stack | raw_hide ×1 | `bench` (fleshing_beam) | knife | attack | rawhide_strip ×4 |
| `rawhide_lashing` | stack | rawhide_strip ×1 + water ×1 | `bench` | — | attack | rawhide_lashing ×2 |

**Notes.** `rawhide_lashing` shrinks as it dries, making it ideal for hafting axe-heads to wooden hafts. Goes through no tanning — rawhide and tanned_leather are distinct materials.

---

### 3d. Textile components

Cloth panels cut for specific assemblies. Loose cloth (§9) is the
finished good; these are assembly-stage pre-cuts.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_panel` | stack | linen_cloth ×1 | `bench` | shears / knife | attack | linen_panel ×3 |
| `linen_strip` | stack | linen_cloth ×1 | `bench` | shears | attack | linen_strip ×8 |
| `linen_bandage` | stack | linen_cloth ×1 | `bench` | shears | attack | linen_bandage ×10 |
| `wool_panel` | stack | wool_cloth ×1 | `bench` | shears | attack | wool_panel ×3 |
| `wool_strip` | stack | wool_cloth ×1 | `bench` | shears | attack | wool_strip ×8 |
| `wool_stuffing` | stack | raw_wool ×1 | `bench` (carding_bench) | cards | attack | wool_stuffing ×4 |
| `tow_stuffing` | stack | tow ×1 | `bench` | — | attack | tow_stuffing ×3 |
| `felt_panel` | stack | felt ×1 | `bench` | shears | attack | felt_panel ×3 |
| `padding_wadding` | stack | tow_stuffing ×2 + linen_strip ×1 | `bench` | awl | assembly | padding_wadding ×1 |
| `canvas_panel` | stack | canvas ×1 | `bench` | shears | attack | canvas_panel ×3 |
| `canvas` | stack | hemp_yarn ×4 | `loom_device` (loom) | — | time | canvas ×1 |

---

### 3e. Cord / thread / string

The "thin long" family. Used as stitching, lashing, strings, bindings.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_thread` | stack | linen_yarn ×1 | `loom_device` (spinning_wheel) | — | time | linen_thread ×3 |
| `wool_thread` | stack | wool_yarn ×1 | `loom_device` (spinning_wheel) | — | time | wool_thread ×3 |
| `sinew_cord` | stack | sinew ×1 | `bench` | — | attack | sinew_cord ×2 |
| `gut_string` | stack | gut ×1 + water ×1 | `rack` | — | time / 400 | gut_string ×2 |
| `hemp_twine` | stack | hemp_yarn ×1 | `loom_device` (spinning_wheel) | — | time | hemp_twine ×3 |
| `horsehair_cord` | stack | horsehair ×1 | `bench` | — | attack | horsehair_cord ×2 |
| `rope` | stack | hemp_twine ×6 (or linen_thread ×6) | `loom_device` (rope_walk) | — | time / 400 | rope ×2 |
| `bowstring_linen` | unique | linen_thread ×4 + beeswax ×1 | `bench` | — | assembly | bowstring_linen ×1 |
| `bowstring_sinew` | unique | sinew_cord ×3 + beeswax ×1 | `bench` | — | assembly | bowstring_sinew ×1 |
| `bowstring_hemp` | unique | hemp_twine ×4 + beeswax ×1 | `bench` | — | assembly | bowstring_hemp ×1 |
| `bowstring_gut` | unique | gut_string ×2 + beeswax ×1 | `bench` | — | assembly | bowstring_gut ×1 |

**Notes.** Bowstrings have distinct stats — sinew is strongest and wet-sensitive; hemp is reliable and weatherproof; gut is traditional for fine bows. All feed the same `Bow` assembly slot.

---

### 3f. Ceramic components

Intermediate fired-clay parts.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `crucible` | unique | fireclay ×2 + sand ×1 | `kiln` | — | time / 1800 | crucible ×1 |
| `bone_ash_cupel` | unique | bone_ash ×2 + fireclay ×1 | `kiln` | — | time / 1200 | bone_ash_cupel ×2 |
| `clay_tile` | stack | clay ×1 | `mould` (tile form) | — | time / 900 | clay_tile ×4 |
| `green_brick` | stack | clay ×1 + sand ×1 | `mould` (brick mould) | — | attack / 0 | green_brick ×1 |
| `brick` | stack | green_brick ×10 + charcoal ×3 | `kiln` | — | time / 2400 | brick ×10 |
| `glass_bead` | stack | cullet ×1 | `furnace` (glass) | — | time / 200 | glass_bead ×6 |
| `glass_vial` | unique | cullet ×2 | `loom_device` (glassblowers_chair) | — | time / 300 | glass_vial ×1 |

**Notes.** `cullet` (glass fragments) is an input; the glass chain itself is gap-blocked (§SUMMARY §9). Glass components shippable only when raw glass is authored.

---

### 3g. Bone / horn / sinew components

Frequently overlooked but historically ubiquitous — bone needles,
horn cups, sinew bindings.

| id | Kind | Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `bone_blade_small` | unique | bone ×1 | `bench` (knapping_stump) | — | attack | bone_blade_small ×1 |
| `bone_needle` | stack | bone ×1 | `bench` | knife | attack | bone_needle ×3 |
| `bone_ash` | stack | bone ×4 + charcoal ×1 | `furnace` (roasting) | — | time / 400 | bone_ash ×2 |
| `bone_char` | stack | bone ×4 | `pyrolysis_pit` | — | time / 800 | bone_char ×2 |
| `hide_glue` | stack | rawhide_strip ×3 + water ×1 | `cauldron` (glue_pot) | — | time / 1200 | hide_glue ×2 |
| `bone_glue` | stack | bone ×3 + water ×1 | `cauldron` | — | time / 1500 | bone_glue ×2 |
| `horn_strip` | stack | horn ×1 | `bench` | saw / knife | attack | horn_strip ×3 |
| `horn_cup_blank` | unique | horn ×1 + water ×1 | `cauldron` (hot water soften) | — | time / 200 | horn_cup_blank ×1 |

**Notes.** `bone_ash_cupel` in 3f depends on `bone_ash` here. `hide_glue` is used in every real wood/composite assembly (bow, chest, wheel). `horn_strip` is the composite-bow belly layer.

---

## 4. Tools (T4 assembly)

Assembled from Components (§3). Each tool family has a stone/bronze/iron tier.
Assembly step is the bench-driven selector that picks a specific tool from
interchangeable components.

### Axe (tool variant — for woodcraft)

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `stone_axe` | unique | plank ×1 + stone ×2 | `bench` | knife | assembly | stone_axe ×1 |
| `bronze_axe` | unique | bronze_axe_head ×1 + wooden_haft_medium ×1 + rawhide_lashing ×1 | `bench` | — | assembly | bronze_axe ×1 |
| `iron_axe` | unique | iron_axe_head ×1 + wooden_haft_medium ×1 + rawhide_lashing ×1 | `bench` | — | assembly | iron_axe ×1 |
| `steel_axe` | unique | steel_axe_head ×1 + wooden_haft_medium ×1 + leather_strip ×1 | `bench` | — | assembly | steel_axe ×1 |

### Pickaxe

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `stone_pickaxe` | unique | plank ×1 + stone ×3 | `bench` | knife | assembly | stone_pickaxe ×1 |
| `iron_pickaxe` | unique | iron_pickaxe_head ×1 + wooden_haft_medium ×1 + iron_wedge ×1 | `bench` | hammer | assembly | iron_pickaxe ×1 |
| `steel_pickaxe` | unique | steel_pickaxe_head ×1 + wooden_haft_medium ×1 + iron_wedge ×1 | `bench` | hammer | assembly | steel_pickaxe ×1 |

### Shovel

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `stone_shovel` | unique | plank ×2 + stone ×1 | `bench` | knife | assembly | stone_shovel ×1 |
| `iron_shovel` | unique | iron_shovel_blade ×1 + wooden_haft_medium ×1 + iron_rivet ×2 | `bench` | hammer | assembly | iron_shovel ×1 |

### Hammer

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_hammer` | unique | plank ×2 + stone ×1 | `bench` | knife | assembly | wooden_hammer ×1 |
| `iron_hammer` | unique | iron_hammer_head ×1 + wooden_haft_medium ×1 + wooden_wedge ×1 | `bench` | — | assembly | iron_hammer ×1 |
| `smithing_hammer` | unique | iron_hammer_head ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | smithing_hammer ×1 |

**Notes.** A `smithing_hammer` is a dedicated forging hammer; using a generic `wooden_hammer` on anvil recipes produces lower-quality blades (GAP-QUALITY placeholder).

### Knife

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `flint_knife` | unique | flint_blade_small ×1 + wooden_haft_short ×1 + rawhide_lashing ×1 | `bench` | — | assembly | flint_knife ×1 |
| `bronze_knife` | unique | bronze_blade_small ×1 + wooden_haft_short ×1 + leather_strip ×1 | `bench` | — | assembly | bronze_knife ×1 |
| `iron_knife` | unique | iron_blade_small ×1 + wooden_haft_short ×1 + leather_strip ×1 | `bench` | — | assembly | iron_knife ×1 |
| `steel_knife` | unique | steel_blade_small ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | steel_knife ×1 |

### Chisel / plane / specialty woodwork

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_chisel` | unique | iron_chisel_bit ×1 + wooden_haft_short ×1 | `bench` | — | assembly | iron_chisel ×1 |
| `iron_plane` | unique | iron_plane_blade ×1 + plank ×1 + wooden_dowel ×1 | `bench` | — | assembly | iron_plane ×1 |
| `iron_drill` | unique | iron_drill_bit ×1 + wooden_haft_short ×1 + linen_thread ×1 | `bench` | — | assembly | iron_drill ×1 |
| `iron_adze` | unique | iron_adze_head ×1 + wooden_haft_medium ×1 + rawhide_lashing ×1 | `bench` | — | assembly | iron_adze ×1 |
| `iron_saw` | unique | iron_saw_blade ×1 + plank ×1 + iron_rivet ×3 | `bench` | — | assembly | iron_saw ×1 |
| `draw_knife` | unique | iron_strip ×1 + wooden_haft_short ×2 | `bench` | — | assembly | draw_knife ×1 |
| `froe` | unique | iron_strip ×2 + wooden_haft_short ×1 | anvil | hammer | assembly | froe ×1 |

### Leather / textile specialty

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `fleshing_knife` | unique | iron_strip ×1 + wooden_haft_short ×2 | `bench` | — | assembly | fleshing_knife ×1 |
| `lunellum` | unique | iron_strip ×1 + wooden_haft_short ×1 | anvil | hammer | assembly | lunellum ×1 |
| `awl` | unique | iron_awl_spike ×1 + wooden_haft_short ×1 | `bench` | — | assembly | awl ×1 |
| `scutching_knife` | unique | wooden_billet ×1 | `bench` | knife | assembly | scutching_knife ×1 |
| `wool_cards_pair` | unique | plank ×2 + iron_wire ×2 + leather_strip ×2 | `bench` | awl | assembly | wool_cards_pair ×1 |
| `heckling_comb` | unique | plank ×1 + iron_wire ×4 | `bench` | hammer | assembly | heckling_comb ×1 |
| `shears` | unique | iron_shears_blades ×1 + iron_rivet ×1 | anvil | hammer | assembly | shears ×1 |
| `spindle_and_whorl` | unique | wooden_dowel ×1 + fired_clay_whorl ×1 | `bench` | — | assembly | spindle_and_whorl ×1 |
| `distaff` | unique | wooden_haft_long ×1 | `bench` (pole_lathe) | — | time | distaff ×1 |

### Farm / field

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `hoe` | unique | iron_hoe_head ×1 + wooden_haft_long ×1 + rawhide_lashing ×1 | `bench` | — | assembly | hoe ×1 |
| `scythe` | unique | iron_scythe_blade ×1 + wooden_haft_long ×1 + iron_ring ×2 | `bench` | — | assembly | scythe ×1 |
| `sickle` | unique | iron_sickle_blade ×1 + wooden_haft_short ×1 | `bench` | — | assembly | sickle ×1 |
| `flail` | unique | wooden_haft_long ×1 + wooden_haft_short ×1 + leather_thong ×2 | `bench` | — | assembly | flail ×1 |
| `pitchfork` | unique | iron_strip ×3 + wooden_haft_long ×1 | anvil | hammer | assembly | pitchfork ×1 |

### Kitchen / household

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `kitchen_knife` | unique | iron_blade_small ×1 + wooden_haft_short ×1 | `bench` | — | assembly | kitchen_knife ×1 |
| `iron_ladle` | unique | iron_sheet ×1 + iron_strip ×1 | anvil | hammer | assembly | iron_ladle ×1 |
| `iron_frying_pan` | unique | copper_pan_blank ×1 + wooden_haft_short ×1 | `bench` | — | assembly | iron_frying_pan ×1 |
| `wooden_spoon` | stack | wooden_billet ×1 | `bench` (pole_lathe) | turning_chisel | time | wooden_spoon ×3 |
| `wooden_bowl` | stack | wooden_billet ×1 | `bench` (pole_lathe) | turning_chisel | time | wooden_bowl ×2 |

---

## 5. Weapons (T4 assembly)

### Swords

Same frame: blade + grip + (optional) pommel + (optional) guard.
Orthogonal across materials. **One sword recipe; the inputs determine
the material.** In this catalogue, material-specific entries are
explicit; the prefab implementation may consolidate via Composed.

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_sword` | unique | plank ×3 | `bench` (workbench) | knife | assembly | wooden_sword ×1 |
| `bronze_sword` | unique | bronze_blade_medium ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | bronze_sword ×1 |
| `iron_sword` | unique | iron_blade_medium ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 + metal_pommel ×1 | `bench` | — | assembly | iron_sword ×1 |
| `iron_sword_quilloned` | unique | iron_blade_medium ×1 + iron_strip ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 + metal_pommel ×1 | `bench` | — | assembly | iron_sword_quilloned ×1 |
| `steel_sword` | unique | steel_blade_medium ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 + metal_pommel ×1 | `bench` | — | assembly | steel_sword ×1 |
| `greatsword` | unique | steel_blade_large ×1 + wooden_haft_medium ×1 + leather_grip_wrap ×2 + metal_pommel ×1 | `bench` | — | assembly | greatsword ×1 |

**Iron sword full forge chain (proposed, replaces simple recipe over time):**
See §Iron sword forge chain after this section. The table above is the shorter
assembly path; the forge chain produces a higher-quality `iron_blade_medium`
that plugs into the same assembly.

### Daggers / knives-as-weapons

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `flint_dagger` | unique | flint_blade_small ×1 + wooden_haft_short ×1 + rawhide_lashing ×1 | `bench` | — | assembly | flint_dagger ×1 |
| `bronze_dagger` | unique | bronze_blade_small ×1 + wooden_haft_short ×1 + leather_strip ×1 | `bench` | — | assembly | bronze_dagger ×1 |
| `iron_dagger` | unique | iron_blade_small ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | iron_dagger ×1 |
| `steel_dagger` | unique | steel_blade_small ×1 + wooden_haft_short ×1 + leather_grip_wrap ×1 + metal_pommel ×1 | `bench` | — | assembly | steel_dagger ×1 |
| `rondel_dagger` | unique | steel_blade_small ×1 + wooden_haft_short ×1 + iron_sheet ×2 | `bench` | — | assembly | rondel_dagger ×1 |

### Spears / polearms

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_spear` | unique | plank ×2 | `bench` (workbench) | knife | assembly | wooden_spear ×1 |
| `bronze_spear` | unique | bronze_spear_head ×1 + wooden_haft_long ×1 + rawhide_lashing ×1 | `bench` | — | assembly | bronze_spear ×1 |
| `copper_spear` | unique | copper_ingot ×2 + wood ×2 | `bench` (workbench) | hammer | assembly | copper_spear ×1 |
| `iron_spear` | unique | iron_spear_head ×1 + wooden_haft_long ×1 + rawhide_lashing ×1 | `bench` | — | assembly | iron_spear ×1 |
| `iron_pike` | unique | iron_spear_head ×1 + wooden_haft_long ×1 + iron_strip ×2 | `bench` | — | assembly | iron_pike ×1 |
| `iron_halberd` | unique | iron_axe_head ×1 + iron_spear_head ×1 + wooden_haft_long ×1 + iron_rivet ×4 | `bench` | — | assembly | iron_halberd ×1 |
| `iron_glaive` | unique | iron_blade_large ×1 + wooden_haft_long ×1 + iron_rivet ×2 | `bench` | — | assembly | iron_glaive ×1 |
| `war_scythe` | unique | iron_scythe_blade ×1 + wooden_haft_long ×1 + iron_strip ×1 | `bench` | — | assembly | war_scythe ×1 |

### Axes (weapon variant)

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `bronze_war_axe` | unique | bronze_axe_head ×1 + wooden_haft_medium ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | bronze_war_axe ×1 |
| `iron_war_axe` | unique | iron_axe_head ×1 + wooden_haft_medium ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | iron_war_axe ×1 |
| `steel_war_axe` | unique | steel_axe_head ×1 + wooden_haft_medium ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | steel_war_axe ×1 |
| `dane_axe` | unique | iron_axe_head ×1 + wooden_haft_long ×1 + iron_rivet ×2 | `bench` | — | assembly | dane_axe ×1 |
| `bearded_axe` | unique | iron_axe_head ×1 + wooden_haft_short ×1 + rawhide_lashing ×1 | `bench` | — | assembly | bearded_axe ×1 |

### Maces / flails / blunt

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_mace` | unique | iron_mace_head ×1 + wooden_haft_medium ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | iron_mace ×1 |
| `iron_morning_star` | unique | iron_mace_head ×1 + iron_spike ×6 + wooden_haft_medium ×1 | anvil | hammer | assembly | iron_morning_star ×1 |
| `iron_warhammer` | unique | iron_hammer_head ×1 + wooden_haft_long ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | iron_warhammer ×1 |
| `iron_flail` | unique | iron_mace_head ×1 + wooden_haft_short ×1 + iron_chain_link ×6 | anvil | hammer | assembly | iron_flail ×1 |
| `quarterstaff` | unique | wooden_haft_long ×1 + iron_strip ×2 | `bench` | — | assembly | quarterstaff ×1 |

### Bows and crossbows

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_bow` | unique | bow_stave_short ×1 + bowstring_linen ×1 | `bench` | — | assembly | wooden_bow ×1 |
| `self_longbow` | unique | bow_stave_long ×1 + bowstring_linen ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | self_longbow ×1 |
| `yew_longbow` | unique | yew_stave_long ×1 + bowstring_hemp ×1 + leather_grip_wrap ×1 | `bench` | — | assembly | yew_longbow ×1 |
| `composite_bow` | unique | bow_stave_short ×1 + horn_strip ×2 + sinew_cord ×3 + hide_glue ×1 | `bench` | — | assembly | composite_bow ×1 |
| `recurve_bow` | unique | bow_stave_short ×1 + horn_strip ×1 + bowstring_sinew ×1 | `bench` | — | assembly | recurve_bow ×1 |
| `crossbow_light` | unique | crossbow_stock ×1 + crossbow_prod ×1 + bowstring_hemp ×1 + iron_ring ×2 | `bench` | — | assembly | crossbow_light ×1 |
| `crossbow_heavy` | unique | crossbow_stock ×1 + iron_prod ×1 + bowstring_hemp ×1 + iron_trigger_nut ×1 | `bench` | — | assembly | crossbow_heavy ×1 |

**Notes.** `yew_stave_long` is a regional resource (yew tree, not universally available). `iron_prod` is a sibling of `crossbow_prod` made from `iron_strip ×3 + charcoal ×1` at anvil. `iron_trigger_nut` is a small assembly piece of `iron_ingot ×1` at anvil.

### Arrows / bolts (stacks)

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `flint_arrow` | stack | flint_arrow_head ×5 + wooden_arrow_shaft ×5 + feather ×5 + linen_thread ×1 | `bench` | — | assembly | flint_arrow ×5 |
| `iron_arrow` | stack | iron_arrow_head ×5 + wooden_arrow_shaft ×5 + feather ×5 + linen_thread ×1 | `bench` | — | assembly | iron_arrow ×5 |
| `bodkin_arrow` | stack | iron_bodkin_point ×5 + wooden_arrow_shaft ×5 + feather ×5 + linen_thread ×1 | `bench` | — | assembly | bodkin_arrow ×5 |
| `broadhead_arrow` | stack | iron_broadhead ×3 + wooden_arrow_shaft ×3 + feather ×3 + linen_thread ×1 | `bench` | — | assembly | broadhead_arrow ×3 |
| `crossbow_bolt` | stack | iron_bolt_head ×10 + wooden_bolt_shaft ×10 + feather ×10 + linen_thread ×1 | `bench` | — | assembly | crossbow_bolt ×10 |

**Notes.** Bodkin is anti-mail; broadhead is anti-unarmoured. These use different `DerivedItemStats` — specifically `armorReduction` — so quiver choice matters against different foes.

### Shields

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_round_shield` | unique | wooden_shield_blank ×1 + rawhide_strip ×2 + iron_shield_boss ×1 + leather_strap ×2 | `bench` | — | assembly | wooden_round_shield ×1 |
| `kite_shield` | unique | wooden_shield_blank ×1 + linen_panel ×1 + iron_shield_boss ×1 + iron_shield_rim ×1 + leather_strap ×2 + hide_glue ×1 | `bench` | — | assembly | kite_shield ×1 |
| `iron_kite_shield` | unique | iron_sheet ×4 + leather_strap ×2 + linen_panel ×1 + iron_rivet ×10 | `bench` | — | assembly | iron_kite_shield ×1 |
| `steel_heater_shield` | unique | steel_plate_panel ×2 + leather_strap ×2 + iron_rivet ×8 | `bench` | — | assembly | steel_heater_shield ×1 |
| `buckler` | unique | iron_sheet ×1 + leather_strap ×1 + iron_rivet ×2 | `bench` | — | assembly | buckler ×1 |

### Iron sword forge chain (proposed, quality-producing path)

Full chain that produces `iron_blade_medium` at higher quality than the
simple blade recipe in §3a. Plugs into the `iron_sword` assembly table
above.

**Step A — Forge blade stock:**
| Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|
| iron_ingot ×2 + charcoal ×1 | `furnace` (forge) | time | 200 | hot_iron_billet ×1 |

**Step B — Hammer to shape:**
| Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|
| hot_iron_billet ×1 | anvil (`bench`) | smithing_hammer | attack | raw_blade ×1 + hammer_scale ×1 |

**Step C — Harden (quench):**
| Inputs | Station | Tool | Step | Output |
|---|---|---|---|---|
| raw_blade ×1 + water ×1 | `vat` (quench) OR `cauldron` (oil for higher-grade) | tongs | attack | hard_blade ×1 |

**GAP-CHECKPOINT** — historically the blade is red-hot at a specific moment; the recipe flattens this to a timerless resolve.

**Step D — Temper:**
| Inputs | Station | Step | Ticks | Output |
|---|---|---|---|---|
| hard_blade ×1 + charcoal ×1 | `furnace` (tempering) | time | 120 | iron_blade_medium ×1 |

**GAP-QUALITY** — the skilled-smith dimension is the whole craft; today the output is uniform. First-wave content gets the chain without the quality scalar.

---

## 6. Armour (T4 assembly)

### Padding / base layer

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_tunic` | unique | linen_panel ×4 + linen_thread ×2 | `bench` | awl / needle | assembly | linen_tunic ×1 |
| `wool_tunic` | unique | wool_panel ×4 + wool_thread ×2 | `bench` | awl / needle | assembly | wool_tunic ×1 |
| `gambeson` | unique | linen_panel ×6 + wool_stuffing ×8 + linen_thread ×3 | `bench` | awl / needle | assembly | gambeson ×1 |
| `wool_cloak` | unique | wool_panel ×4 + iron_clasp ×1 + wool_thread ×1 | `bench` | awl | assembly | wool_cloak ×1 |
| `fur_cloak` | unique | wool_panel ×4 + raw_pelt ×2 + iron_clasp ×1 + linen_thread ×1 | `bench` | awl | assembly | fur_cloak ×1 |

**Notes.** Gambeson is the essential underlayer for mail/plate — historically worn alone as cheap infantry armour and under heavier harness for padding.

### Leather / hide

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_jerkin` | unique | leather_panel ×4 + leather_thong ×4 | `bench` | awl | assembly | leather_jerkin ×1 |
| `studded_jerkin` | unique | leather_panel ×4 + iron_rivet ×20 + leather_thong ×4 | `bench` | awl | assembly | studded_jerkin ×1 |
| `boiled_leather_cuirass` | unique | leather_panel ×4 + beeswax ×1 + water ×1 | `cauldron` + `bench` | awl | assembly | boiled_leather_cuirass ×1 |
| `leather_vambraces` | unique | leather_panel ×1 + leather_thong ×1 | `bench` | awl | assembly | leather_vambraces ×1 |
| `leather_greaves` | unique | leather_panel ×2 + leather_thong ×2 | `bench` | awl | assembly | leather_greaves ×1 |

### Mail (chain)

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `mail_coif` | unique | iron_ring ×200 + linen_panel ×1 + linen_thread ×2 | anvil | — (work is slow) | assembly | mail_coif ×1 |
| `mail_shirt` | unique | iron_ring ×1200 + gambeson ×1 + linen_thread ×4 | anvil | — | assembly | mail_shirt ×1 |
| `mail_hauberk` | unique | iron_ring ×2000 + gambeson ×1 + linen_thread ×6 | anvil | — | assembly | mail_hauberk ×1 |
| `mail_mittens` | unique | iron_ring ×300 + leather_panel ×2 | anvil | — | assembly | mail_mittens ×1 |

**Notes.** Ring count is large because each ring is linked to four others; assembly is slow (`ticks: 2400` — but via the recipe's internal step timing, not in this table). **GAP-BATCH** genuinely matters here — real mail-making is a skilled piecework activity, not a one-tick craft.

### Plate

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_breastplate` | unique | iron_plate_panel ×2 + leather_strap ×3 + iron_rivet ×10 | anvil | hammer | assembly | iron_breastplate ×1 |
| `steel_breastplate` | unique | steel_plate_panel ×2 + leather_strap ×3 + iron_rivet ×10 | anvil | hammer | assembly | steel_breastplate ×1 |
| `iron_greaves` | unique | iron_greave_plate ×2 + leather_strap ×2 + iron_rivet ×6 | anvil | hammer | assembly | iron_greaves ×1 |
| `iron_vambraces` | unique | iron_vambrace_plate ×2 + leather_strap ×2 + iron_rivet ×4 | anvil | hammer | assembly | iron_vambraces ×1 |
| `iron_gauntlets` | unique | iron_gauntlet_plate ×2 + leather_panel ×2 + iron_rivet ×12 | anvil | hammer | assembly | iron_gauntlets ×1 |
| `pauldrons` | unique | iron_plate_panel ×2 + leather_strap ×2 + iron_rivet ×6 | anvil | hammer | assembly | pauldrons ×1 |

### Helms

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_cap` | unique | leather_panel ×2 + leather_thong ×1 | `bench` | awl | assembly | leather_cap ×1 |
| `iron_skullcap` | unique | iron_skull_cap ×1 + linen_panel ×1 + leather_strap ×1 | `bench` | awl | assembly | iron_skullcap ×1 |
| `nasal_helm` | unique | iron_skull_cap ×1 + iron_strip ×1 + linen_panel ×1 + leather_strap ×1 + iron_rivet ×2 | anvil | hammer | assembly | nasal_helm ×1 |
| `spangenhelm` | unique | iron_plate_panel ×4 + iron_strip ×4 + linen_panel ×1 + leather_strap ×1 + iron_rivet ×12 | anvil | hammer | assembly | spangenhelm ×1 |
| `great_helm` | unique | iron_sheet ×3 + linen_panel ×1 + leather_strap ×1 + iron_rivet ×8 | anvil | hammer | assembly | great_helm ×1 |
| `kettle_helm` | unique | iron_sheet ×2 + linen_panel ×1 + leather_strap ×1 + iron_rivet ×4 | anvil | hammer | assembly | kettle_helm ×1 |

### Footwear

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_shoes` | unique | leather_boot_upper ×1 + leather_panel ×1 + linen_thread ×2 + pine_tar ×1 | `bench` | awl | assembly | leather_shoes ×1 |
| `leather_boots` | unique | leather_boot_upper ×1 + leather_panel ×2 + linen_thread ×3 + pine_tar ×1 | `bench` | awl | assembly | leather_boots ×1 |
| `iron_sabatons` | unique | iron_plate_panel ×2 + leather_boots ×1 + iron_rivet ×6 | anvil | hammer | assembly | iron_sabatons ×1 |

### Gauntlets and gloves

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_gloves` | unique | leather_gauntlet_blank ×2 + linen_thread ×2 | `bench` | awl | assembly | leather_gloves ×1 |
| `wool_mittens` | unique | wool_yarn ×2 | `bench` (nalbinding) | — | assembly | wool_mittens ×1 |

**GAP-PORTABLE-CRAFT** — nalbinding is historically a sit-and-knot skill with no station; today requires a bench placeholder.

---

## 7. Containers and vessels

### Wooden

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_crate` | unique | plank ×6 + iron_nail ×12 | `bench` | hammer | assembly | wooden_crate ×1 |
| `wooden_chest` | unique | plank ×8 + iron_nail ×16 + iron_hinge ×2 + iron_latch ×1 | `bench` | hammer | assembly | wooden_chest ×1 |
| `iron_bound_chest` | unique | plank ×8 + iron_strip ×4 + iron_nail ×20 + iron_hinge ×2 + iron_latch ×1 | `bench` | hammer | assembly | iron_bound_chest ×1 |
| `wooden_barrel` | unique | barrel_stave ×8 + iron_strip ×3 + barrel_head ×2 | `bench` (cooper_workbench) | — | assembly | wooden_barrel ×1 |
| `wooden_cask` | unique | barrel_stave ×6 + iron_strip ×2 + barrel_head ×2 | `bench` (cooper_workbench) | — | assembly | wooden_cask ×1 |
| `small_keg` | unique | barrel_stave ×4 + iron_strip ×2 + barrel_head ×2 | `bench` (cooper_workbench) | — | assembly | small_keg ×1 |
| `wooden_bucket` | unique | barrel_stave ×4 + iron_strip ×1 + leather_strap ×1 | `bench` | — | assembly | wooden_bucket ×1 |

### Ceramic

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `clay_pot` | stack | dry_pot ×3 + charcoal ×2 | `kiln` | — | time | clay_pot ×3 |
| `clay_jar` | unique | dry_jar ×1 + charcoal ×1 | `kiln` | — | time | clay_jar ×1 |
| `glazed_jar` | unique | clay_jar ×1 + glaze_mix ×1 + charcoal ×1 | `kiln` | — | time | glazed_jar ×1 |
| `amphora` | unique | dry_amphora ×1 + charcoal ×2 | `kiln` | — | time | amphora ×1 |
| `clay_pitcher` | unique | dry_pitcher ×1 + charcoal ×1 | `kiln` | — | time | clay_pitcher ×1 |

**Intermediate stages (on potters_wheel, then rack-dried, then fired):**

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `greenware_pot` | stack | raw_clay ×2 | `loom_device` (potters_wheel) | — | time | greenware_pot ×1 |
| `dry_pot` | stack | greenware_pot ×1 | `rack` | — | time / 1200 | dry_pot ×1 |
| (similarly for jar, pitcher, amphora) | | | | | | |

### Textile

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_sack` | unique | linen_panel ×2 + linen_thread ×1 | `bench` | awl | assembly | linen_sack ×1 |
| `wool_sack` | unique | wool_panel ×2 + wool_thread ×1 | `bench` | awl | assembly | wool_sack ×1 |
| `hemp_sack` | unique | canvas_panel ×2 + hemp_twine ×1 | `bench` | awl | assembly | hemp_sack ×1 |

### Leather

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `leather_pouch` | unique | leather_pouch_blank ×1 + iron_buckle ×1 | `bench` | awl | assembly | leather_pouch ×1 |
| `leather_satchel` | unique | leather_panel ×3 + leather_strap ×1 + iron_buckle ×2 + linen_thread ×2 | `bench` | awl | assembly | leather_satchel ×1 |
| `waterskin` | unique | tanned_leather ×2 + pine_tar ×1 + leather_thong ×2 | `bench` | awl | assembly | waterskin ×1 |

### Glass (blocked on engine work)

Deferred — glass chain needs GAP-STATE. Listed here for future.
- `glass_vial`, `glass_bottle`, `glass_urn`, `stained_glass_panel`.

---

## 8. Food, drink, preserved

### Meat

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `cooked_meat` | stack | raw_meat ×1 | `campfire` | time | 200 | cooked_meat ×1 |
| `roasted_meat` | stack | raw_meat ×1 + salt ×1 | `oven` | time | 400 | roasted_meat ×1 |
| `cured_meat` | stack | raw_meat ×2 + salt ×1 | `vat` (brine_barrel) | time | 1800 | cured_meat ×2 |
| `smoked_meat` | stack | raw_meat ×2 + wood ×1 | `smokehouse` | time | 1200 | smoked_meat ×2 |
| `jerky` | stack | raw_meat ×3 + salt ×1 | `rack` | time | 2400 | jerky ×3 |
| `sausage` | stack | raw_meat ×3 + gut ×1 + salt ×1 + herb_rosemary ×1 | `bench` (butcher_block) | attack | 0 | sausage ×3 |
| `cooked_fish` | stack | raw_fish ×1 | `campfire` | time | 150 | cooked_fish ×1 |
| `smoked_fish` | stack | raw_fish ×2 + salt ×1 + wood ×1 | `smokehouse` | time | 1500 | smoked_fish ×2 |
| `stockfish` | stack | raw_fish ×2 + salt ×0 | `rack` (air-dry) | time | 3600 | stockfish ×2 |

**GAP-ENV** blocks the stockfish chain (needs cold coastal wind) — flagged.

### Grain → bread

| id | Kind | Recipe | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|---|
| `flour` | stack | grain ×2 | `millstone` (hand_quern) | — | attack | 0 | flour ×1 + bran ×1 |
| `flour` (watermill) | stack | grain ×2 | `millstone` (watermill) | — | time | 80 | flour ×2 + bran ×1 |
| `rye_flour` | stack | rye_grain ×2 | `millstone` | — | attack | 0 | rye_flour ×1 + bran ×1 |
| `dough` | stack | flour ×2 + water ×1 + salt ×1 | `bench` (kneading_trough) | — | attack | 0 | dough ×2 |
| `sourdough_dough` | stack | flour ×2 + water ×1 + sourdough_starter ×1 | `vat` | time | 800 | sourdough_dough ×2 |
| `bread` | stack | dough ×2 + wood ×1 | `oven` | time | 400 | bread ×2 |
| `rye_bread` | stack | rye_dough ×2 + wood ×1 | `oven` | time | 500 | rye_bread ×2 |
| `flatbread` | stack | dough ×1 + wood ×1 | `campfire` | time | 100 | flatbread ×2 |
| `porridge` | stack | oats ×2 + water ×1 + salt ×1 | `cauldron` | time | 200 | porridge ×2 |

### Dairy

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `butter` | stack | milk ×3 | `press` (butter_churn) | attack | 0 | butter ×1 + buttermilk ×2 |
| `cream` | stack | milk ×4 | `bench` (settling_pan) | time | 600 | cream ×1 + skim_milk ×3 |
| `fresh_cheese` | stack | milk ×3 + vinegar ×1 | `vat` (cheese_vat) | time | 600 | fresh_cheese ×1 + whey ×2 |
| `pressed_cheese` | stack | fresh_cheese ×1 + salt ×1 | `press` (cheese_press) | time | 200 | pressed_cheese ×1 |
| `aged_cheese` | stack | pressed_cheese ×3 | `cellar` | time | 4800 | aged_cheese ×3 |

**GAP-ENV + GAP-CHECKPOINT** block aged_cheese meaningfully.

### Brewing / fermenting

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `malt` | stack | barley_grain ×3 + water ×1 | `vat` (steeping_cistern) | time | 1200 | malt ×3 |
| `wort` | stack | malt ×3 + water ×2 | `cauldron` (mash_tun) | time | 300 | wort ×3 |
| `ale` | stack | wort ×3 + yeast ×1 | `vat` (fermenter) | time | 1800 | ale ×3 |
| `rye_ale` | stack | wort_rye ×3 + yeast ×1 | `vat` | time | 1800 | rye_ale ×3 |
| `mead` | stack | honey ×2 + water ×2 + yeast ×1 | `vat` | time | 2400 | mead ×2 |
| `cider` | stack | apple ×3 + yeast ×1 | `vat` | time | 2000 | cider ×2 |
| `wine` | stack | grape_must ×3 + yeast ×1 | `vat` | time | 2400 | wine ×3 |
| `grape_must` | stack | grape ×4 | `press` (wine_press) | attack | 0 | grape_must ×2 + grape_pomace ×1 |
| `vinegar` | stack | ale ×2 | `vat` (vinegar_crock) | time | 2400 | vinegar ×2 |

### Condiments, sweeteners, misc

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `honey` | stack | honey_comb ×1 | `press` | attack | 0 | honey ×2 + beeswax ×1 |
| `pickle` | stack | vegetable ×2 + brine ×1 + vinegar ×1 | `vat` (pickling_crock) | time | 2400 | pickle ×2 |
| `preserves` | stack | berry ×3 + honey ×1 | `cauldron` | time | 300 | preserves ×2 |
| `oil` | stack | olive ×4 | `press` (oil_press) | attack | 0 | oil ×1 + oil_cake ×1 |
| `yeast` | stack | flour ×1 + water ×1 | `vat` | time | 1200 | yeast ×2 |
| `sourdough_starter` | stack | flour ×1 + water ×1 | `vat` | time | 3600 | sourdough_starter ×1 |
| `salt_fish_preserve` | stack | raw_fish ×2 + salt ×2 | `vat` (brine_barrel) | time | 1800 | salt_fish_preserve ×2 |

---

## 9. Finished clothing and textiles

### Fabric (bolts)

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `linen_cloth` | stack | linen_yarn ×4 | `loom_device` (loom) | time | 800 | linen_cloth ×1 |
| `wool_cloth` | stack | wool_yarn ×4 | `loom_device` (loom) | time | 800 | raw_cloth ×1 (→ full → wool_cloth) |
| `canvas` | stack | hemp_yarn ×4 | `loom_device` (loom) | time | 800 | canvas ×1 |
| `felt` | stack | scoured_wool ×3 + lye ×1 | `vat` (felting) | time | 600 | felt ×2 |
| `hemp_cloth` | stack | hemp_yarn ×4 | `loom_device` (loom) | time | 800 | hemp_cloth ×1 |
| `fulled_wool` | stack | raw_cloth ×1 + water ×1 | `vat` (fulling_trough) | time | 300 | wool_cloth ×1 |
| `bleached_linen` | stack | linen_cloth ×1 + lye ×1 + sun | `rack` (bleaching_green) | time | 3000 | bleached_linen ×1 |
| `dyed_wool` | stack | wool_cloth ×1 + dye_liquor ×1 + mordant ×1 | `vat` (dye_vat) | time | 800 | dyed_wool ×1 |
| `dyed_linen` | stack | linen_cloth ×1 + dye_liquor ×1 + mordant ×1 | `vat` (dye_vat) | time | 800 | dyed_linen ×1 |

**GAP-ENV** blocks bleached_linen (needs sun + dew).  
**Note.** `dye_liquor` and `mordant` stack ids — see §12.

### Clothing

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_shirt` | unique | linen_panel ×3 + linen_thread ×2 | `bench` | awl / needle | assembly | linen_shirt ×1 |
| `linen_breeches` | unique | linen_panel ×2 + linen_thread ×1 | `bench` | awl / needle | assembly | linen_breeches ×1 |
| `wool_trousers` | unique | wool_panel ×2 + wool_thread ×1 | `bench` | awl / needle | assembly | wool_trousers ×1 |
| `wool_hose` | unique | wool_panel ×1 + wool_thread ×1 | `bench` | awl / needle | assembly | wool_hose ×1 |
| `wool_coif` | unique | wool_panel ×1 + wool_thread ×1 | `bench` | awl / needle | assembly | wool_coif ×1 |
| `leather_belt` | unique | leather_strap ×1 + iron_buckle ×1 | `bench` | awl | assembly | leather_belt ×1 |
| `wool_hat` | unique | felt_panel ×2 + wool_thread ×1 | `bench` (form_block) | awl | assembly | wool_hat ×1 |
| `tabard` | unique | dyed_linen ×2 + wool_thread ×2 | `bench` | awl / needle | assembly | tabard ×1 |

---

## 10. Lore physicals

### Writing substrate

| id | Kind | Source | Notes |
|---|---|---|---|
| `parchment` | stack | Leather chain branch — see Leather chain §Parchment branch | Premium writing substrate |
| `vellum` | stack | As parchment but from calf-hide specifically | Higher grade; rarer |
| `birch_bark_sheet` | stack | birch_bark ×1 at `bench` with knife | Low-quality note paper |

### Ink

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `oak_gall_ink` | stack | oak_gall ×3 + iron_sulfate ×1 + water ×1 + ale ×1 | `bench` (ink_bench) | time | 600 | oak_gall_ink ×3 |
| `lamp_black_ink` | stack | soot ×2 + hide_glue ×1 + water ×1 | `bench` | attack | 0 | lamp_black_ink ×2 |
| `cinnabar_ink` | stack | cinnabar_pigment ×1 + hide_glue ×1 | `bench` | attack | 0 | cinnabar_ink ×1 |

### Writing tools

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `quill` | stack | quill_feather ×1 | `bench` | knife | attack | quill ×1 |
| `reed_pen` | stack | reed ×1 | `bench` | knife | attack | reed_pen ×1 |
| `wax_tablet` | unique | plank ×1 + beeswax ×1 | `bench` | — | assembly | wax_tablet ×1 |
| `stylus` | unique | iron_strip ×1 + wooden_haft_short ×1 | `bench` | — | assembly | stylus ×1 |

### Books

| id | Kind | Recipe | Station | Tool | Step | Ticks | Output |
|---|---|---|---|---|---|---|---|
| `blank_tome` | unique | parchment ×6 + leather_panel ×1 + linen_thread ×1 + hide_glue ×1 | `bench` (bookbinding) | awl | assembly | 400 | blank_tome ×1 |
| `inscribed_tome` | unique | blank_tome ×1 + oak_gall_ink ×1 | `bench` (scribe_desk) | quill | assembly | 1200 | inscribed_tome ×1 |
| `illuminated_tome` | unique | inscribed_tome ×1 + oak_gall_ink ×1 + cinnabar_ink ×1 + gold_leaf ×1 | `bench` (scribe_desk) | quill | assembly | 2400 | illuminated_tome ×1 |
| `scroll` | unique | parchment ×1 + oak_gall_ink ×1 + wax_seal ×1 | `bench` (scribe_desk) | quill | assembly | 400 | scroll ×1 |
| `sealed_letter` | unique | parchment ×1 + oak_gall_ink ×1 + wax_seal ×1 | `bench` (scribe_desk) | quill | assembly | 200 | sealed_letter ×1 |

**GAP-PAYLOAD-ITEM** — tomes carry a specific Lore-fragment reference on
the item instance. Voxim's `Inscribed` component supports this.

---

## 11. Lighting

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `torch` | stack | plank ×1 + kindling ×1 | `campfire` | time | 60 | torch ×1 |
| `pitch_torch` | stack | plank ×1 + linen_strip ×1 + pine_tar ×1 | `cauldron` | time | 120 | pitch_torch ×1 |
| `tallow_candle` | stack | tallow ×1 + linen_thread ×1 | `bench` (chandler) | attack | 0 | tallow_candle ×3 |
| `beeswax_candle` | stack | beeswax ×1 + linen_thread ×1 | `bench` (chandler) | attack | 0 | beeswax_candle ×3 |
| `oil_lamp` | unique | clay_pitcher ×1 + linen_thread ×1 + oil ×1 | `bench` | — | assembly | oil_lamp ×1 |
| `iron_lantern` | unique | iron_sheet ×1 + iron_wire ×2 + horn_cup_blank ×1 | anvil | hammer | assembly | iron_lantern ×1 |
| `brazier` | unique | iron_pot_shell ×1 + iron_strip ×3 + charcoal ×2 | anvil | hammer | assembly | brazier ×1 |

**Notes.** Different light sources have different `lightRadius`, `lightIntensity`, `lightFlicker`, and duration (burn-out). A torch burns quickly; a lantern is protected from wind and lasts long; a brazier is static, bright, and radiates heat (future temperature component).

---

## 12. Alchemical, chemical, paints

### Soaps and cleaners

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `curd_soap` | stack | tallow ×2 + lye ×1 | `cauldron` (soap_cauldron) | time | 800 | curd_soap ×3 |
| `hard_soap` | stack | curd_soap ×3 + salt ×1 | `cauldron` | time | 300 | hard_soap ×3 |
| `fine_soap` | stack | hard_soap ×1 + herb_rosemary ×1 + olive_oil ×1 | `bench` | attack | 0 | fine_soap ×1 |

### Pitches and tars

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `pine_tar` | stack | fatwood ×6 | `pyrolysis_pit` | time | 3000 | pine_tar ×3 + charcoal ×2 |
| `birch_tar` | stack | birch_bark ×4 | `pyrolysis_pit` | time | 2000 | birch_tar ×2 + char ×1 |
| `pine_pitch` | stack | pine_tar ×2 | `cauldron` | time | 400 | pine_pitch ×2 |
| `rosin` | stack | pine_pitch ×2 | `cauldron` | time | 300 | rosin ×2 |

### Glues

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `hide_glue` | stack | rawhide_strip ×3 + water ×1 | `cauldron` (glue_pot) | time | 1200 | hide_glue ×2 |
| `bone_glue` | stack | bone ×3 + water ×1 | `cauldron` | time | 1500 | bone_glue ×2 |
| `fish_glue` | stack | fish_scale ×4 + water ×1 | `cauldron` | time | 1200 | fish_glue ×1 |

### Mordants

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `alum_mordant` | stack | alum_crystal ×1 + water ×1 | `vat` | time | 100 | alum_mordant ×2 |
| `iron_sulfate` | stack | hammer_scale ×2 + vinegar ×1 | `vat` | time | 800 | iron_sulfate ×1 |
| `copper_sulfate` | stack | copper_ingot ×1 + vinegar ×1 | `vat` | time | 1200 | copper_sulfate ×1 |
| `tannin_liquor` | stack | oak_bark ×4 + water ×2 | `vat` | time | 1200 | tannin_liquor ×3 |

### Pigments

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `lamp_black` | stack | oil ×1 + linen_strip ×1 | `bench` (soot_lamp) | time | 400 | lamp_black ×1 |
| `red_ochre` | stack | red_earth ×1 | `millstone` (muller_slab) | attack | 0 | red_ochre ×2 |
| `verdigris` | stack | copper_sheet ×1 + vinegar ×1 | `danger_pit` (verdigris_pot) | time | 2400 | verdigris ×2 |
| `lead_white` | stack | lead_sheet ×1 + vinegar ×1 | `danger_pit` (lead_stack) | time | 3600 | lead_white ×2 |
| `cinnabar_pigment` | stack | cinnabar_ore ×1 | `millstone` | attack | 0 | cinnabar_pigment ×2 |
| `indigo_paste` | stack | indigo_leaf ×4 + water ×1 + lime ×1 | `vat` (woad_vat) | time | 2400 | indigo_paste ×2 |
| `woad_indigo` | stack | woad_leaves ×6 + water ×1 + lime ×1 | `vat` (woad_vat) | time | 2400 | woad_indigo ×2 |
| `madder_red` | stack | madder_root ×3 + water ×1 | `cauldron` | time | 800 | madder_red ×2 |

**GAP-STATE + GAP-ENV** block the woad chain (live vat).  
**GAP-DANGER-INPUT + GAP-ENV** block verdigris / lead_white.

### Dyes (ready to apply)

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `blue_dye` | stack | woad_indigo ×1 + lye ×1 | `cauldron` (dye_vat) | time | 400 | blue_dye ×2 |
| `red_dye` | stack | madder_red ×1 + alum_mordant ×1 | `cauldron` | time | 400 | red_dye ×2 |
| `yellow_dye` | stack | weld_plant ×2 + alum_mordant ×1 + water ×1 | `cauldron` | time | 400 | yellow_dye ×2 |
| `brown_dye` | stack | walnut_husk ×3 + water ×1 | `cauldron` | time | 400 | brown_dye ×2 |
| `purple_dye` | stack | blue_dye ×1 + red_dye ×1 | `cauldron` | attack | 0 | purple_dye ×2 |

### Distillates

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `aqua_vitae` | stack | ale ×4 | `still` | time | 1200 | aqua_vitae ×1 |
| `rose_water` | stack | rose_petal ×6 + water ×1 | `still` | time | 800 | rose_water ×2 |

### Saltpeter / unusual

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `saltpeter` | stack | nitre_earth ×3 + water ×1 | `vat` | time | 2400 | saltpeter ×1 |

**GAP-STATE** on saltpeter — historically a nitre bed matures over months.

---

## 13. Ceramics (finished goods)

See also Components §3f for intermediate ceramic bits and §7 for containers.

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `clay_tile` | stack | raw_clay ×1 | `mould` (tile form) | time | 900 | clay_tile ×4 |
| `roofing_tile` | stack | clay_tile ×4 + charcoal ×1 | `kiln` | time | 1200 | roofing_tile ×4 |
| `drainage_pipe` | stack | raw_clay ×3 | `mould` + `kiln` | time | 1800 | drainage_pipe ×1 |
| `salt_glaze_jar` | unique | dry_jar ×1 + salt ×1 + charcoal ×1 | `kiln` | time | 1500 | salt_glaze_jar ×1 |

### Ceramic intermediate (greenware)

Authored as separate items so the dry/fire chain is explicit:

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `greenware_pot` | stack | raw_clay ×2 | `loom_device` (potters_wheel) | time | 120 | greenware_pot ×1 |
| `greenware_jar` | unique | raw_clay ×3 | `loom_device` (potters_wheel) | time | 180 | greenware_jar ×1 |
| `greenware_pitcher` | unique | raw_clay ×2 | `loom_device` (potters_wheel) | time | 120 | greenware_pitcher ×1 |
| `greenware_amphora` | unique | raw_clay ×4 | `loom_device` (potters_wheel) | time | 240 | greenware_amphora ×1 |
| `dry_pot` | stack | greenware_pot ×1 | `rack` | time | 1200 | dry_pot ×1 |
| `dry_jar` | unique | greenware_jar ×1 | `rack` | time | 1500 | dry_jar ×1 |
| `dry_pitcher` | unique | greenware_pitcher ×1 | `rack` | time | 1200 | dry_pitcher ×1 |
| `dry_amphora` | unique | greenware_amphora ×1 | `rack` | time | 1800 | dry_amphora ×1 |

---

## 14. Furniture

Joiner and carpenter work. Furniture is almost entirely absent from the
starting set despite being the volume output of two major trades and the
difference between an inhabited and an empty base.

### Seating

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_stool` | unique | plank ×2 + wooden_dowel ×3 | `bench` | saw / chisel | assembly | wooden_stool ×1 |
| `wooden_chair` | unique | plank ×4 + wooden_dowel ×6 + hide_glue ×1 | `bench` | saw / chisel | assembly | wooden_chair ×1 |
| `armchair` | unique | plank ×6 + wooden_dowel ×8 + leather_panel ×2 + linen_thread ×2 + wool_stuffing ×2 | `bench` | awl | assembly | armchair ×1 |
| `long_bench` | unique | plank ×4 + wooden_dowel ×4 | `bench` | saw | assembly | long_bench ×1 |
| `cushioned_bench` | unique | long_bench ×1 + wool_stuffing ×4 + linen_panel ×1 + linen_thread ×2 | `bench` | awl | assembly | cushioned_bench ×1 |
| `wooden_throne` | unique | plank ×10 + wooden_dowel ×10 + leather_panel ×3 + iron_rivet ×12 | `bench` | hammer | assembly | wooden_throne ×1 |

### Tables

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `trestle_table` | unique | plank ×6 + wooden_dowel ×4 | `bench` | saw | assembly | trestle_table ×1 |
| `dining_table` | unique | plank ×8 + wooden_dowel ×8 + hide_glue ×1 | `bench` | saw / plane | assembly | dining_table ×1 |
| `writing_desk_furniture` | unique | plank ×6 + wooden_dowel ×6 + iron_hinge ×1 | `bench` | plane | assembly | writing_desk_furniture ×1 |
| `work_table` | unique | plank ×5 + wooden_dowel ×4 + iron_nail ×8 | `bench` | hammer | assembly | work_table ×1 |

**Notes.** The craftable `workbench` prefab in the game today is a workstation,
not furniture — it carries `WorkstationTag`. `work_table` here is a domestic
table without any crafting role, just for living spaces.

### Beds

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `straw_mattress` | unique | linen_panel ×2 + straw ×6 + linen_thread ×2 | `bench` | awl | assembly | straw_mattress ×1 |
| `wool_mattress` | unique | linen_panel ×2 + wool_stuffing ×8 + linen_thread ×2 | `bench` | awl | assembly | wool_mattress ×1 |
| `feather_mattress` | unique | linen_panel ×2 + feather ×30 + linen_thread ×2 | `bench` | awl | assembly | feather_mattress ×1 |
| `wooden_bed_frame` | unique | plank ×6 + wooden_dowel ×8 + iron_nail ×8 | `bench` | hammer | assembly | wooden_bed_frame ×1 |
| `simple_bed` | unique | wooden_bed_frame ×1 + straw_mattress ×1 + wool_blanket ×1 | `bench` | — | assembly | simple_bed ×1 |
| `bed` | unique | wooden_bed_frame ×1 + wool_mattress ×1 + linen_sheet ×2 + wool_blanket ×1 + feather_pillow ×1 | `bench` | — | assembly | bed ×1 |
| `noble_bed` | unique | wooden_bed_frame ×1 + feather_mattress ×1 + linen_sheet ×2 + wool_blanket ×1 + feather_pillow ×2 + wool_cloth ×2 | `bench` | — | assembly | noble_bed ×1 |
| `bedroll` | unique | wool_blanket ×2 + leather_strap ×2 | `bench` | awl | assembly | bedroll ×1 |
| `cradle` | unique | plank ×3 + wooden_dowel ×4 + linen_panel ×1 + wool_stuffing ×2 | `bench` | saw / awl | assembly | cradle ×1 |

**Linens:**

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `linen_sheet` | stack | linen_cloth ×1 | `bench` | shears / needle | attack | linen_sheet ×1 |
| `wool_blanket` | stack | wool_cloth ×1 | `bench` | shears | attack | wool_blanket ×1 |
| `feather_pillow` | stack | linen_panel ×1 + feather ×10 + linen_thread ×1 | `bench` | awl | assembly | feather_pillow ×1 |

### Storage furniture

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_shelf` | unique | plank ×4 + iron_nail ×8 | `bench` | hammer | assembly | wooden_shelf ×1 |
| `bookshelf` | unique | plank ×6 + iron_nail ×12 | `bench` | hammer | assembly | bookshelf ×1 |
| `wooden_cupboard` | unique | plank ×8 + iron_nail ×10 + iron_hinge ×2 | `bench` | hammer | assembly | wooden_cupboard ×1 |
| `wooden_wardrobe` | unique | plank ×10 + iron_nail ×14 + iron_hinge ×2 + iron_latch ×1 | `bench` | hammer | assembly | wooden_wardrobe ×1 |
| `display_cabinet` | unique | plank ×8 + iron_nail ×10 + iron_hinge ×2 + glass_pane ×2 | `bench` | hammer | assembly | display_cabinet ×1 |

**Notes.** `display_cabinet` needs `glass_pane` — blocked on glass chain
(GAP-STATE). Defer until glass ships.

### Kitchen / domestic

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `kneading_table` | unique | plank ×4 + wooden_dowel ×4 | `bench` | saw | assembly | kneading_table ×1 |
| `washing_tub` | unique | barrel_stave ×8 + iron_strip ×2 | `bench` (cooper_workbench) | — | assembly | washing_tub ×1 |
| `wooden_basin` | unique | wooden_billet ×2 | `loom_device` (pole_lathe) | turning_chisel | time | wooden_basin ×1 |
| `clothes_chest` | unique | plank ×6 + iron_nail ×10 + iron_hinge ×1 + wool_cloth ×1 | `bench` | hammer | assembly | clothes_chest ×1 |

---

## 15. Transport & horse tack

Wheelwright + cartwright + saddler. Essential for any NPC-caravan
gameplay and for scaling from homestead to settlement.

### Wheel components

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_wheel_hub` | unique | wooden_billet ×2 | `loom_device` (pole_lathe) | turning_chisel | time | wooden_wheel_hub ×1 |
| `wooden_rim_segment` | stack | plank ×1 | `bench` | saw / plane | attack | wooden_rim_segment ×2 |
| `wooden_wheel` | unique | wooden_wheel_hub ×1 + wooden_spoke ×8 + wooden_rim_segment ×6 + hide_glue ×1 | `bench` (wheelwright) | drill / hammer | assembly | wooden_wheel ×1 |
| `iron_tyred_wheel` | unique | wooden_wheel ×1 + iron_strip ×4 + charcoal ×1 | anvil | hammer | assembly | iron_tyred_wheel ×1 |

**Notes.** Iron tyre is fitted red-hot and cools to shrink onto the wooden
rim, locking the wheel. **GAP-PROCESS-PARAM** (temperature at fit). Recipe
ships today as flat `time` with fair yields.

### Axles & frames

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_axle` | unique | wooden_billet ×2 + iron_strip ×2 | `bench` (shaving_horse) | draw_knife | assembly | wooden_axle ×1 |
| `wooden_cart_body` | unique | plank ×8 + iron_nail ×16 + iron_strip ×2 | `bench` | hammer | assembly | wooden_cart_body ×1 |
| `wooden_wagon_body` | unique | plank ×16 + iron_nail ×24 + iron_strip ×4 + iron_hinge ×2 | `bench` | hammer | assembly | wooden_wagon_body ×1 |

### Vehicles

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `handcart` | unique | wooden_cart_body ×1 + wooden_wheel ×1 + wooden_haft_long ×2 | `bench` | hammer | assembly | handcart ×1 |
| `wheelbarrow` | unique | plank ×4 + wooden_wheel ×1 + wooden_haft_long ×2 + iron_nail ×8 | `bench` | hammer | assembly | wheelbarrow ×1 |
| `two_wheel_cart` | unique | wooden_cart_body ×1 + wooden_axle ×1 + iron_tyred_wheel ×2 + wooden_haft_long ×2 + leather_strap ×2 | `bench` | hammer | assembly | two_wheel_cart ×1 |
| `four_wheel_wagon` | unique | wooden_wagon_body ×1 + wooden_axle ×2 + iron_tyred_wheel ×4 + wooden_dowel ×6 + leather_strap ×4 | `bench` | hammer | assembly | four_wheel_wagon ×1 |
| `wooden_sled` | unique | plank ×4 + wooden_dowel ×4 + iron_strip ×2 | `bench` | — | assembly | wooden_sled ×1 |

### Horse tack

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_horseshoe` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_horseshoe ×4 |
| `iron_stirrup` | stack | iron_strip ×1 + leather_strap ×1 | anvil | hammer | assembly | iron_stirrup ×2 |
| `iron_bit` | unique | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_bit ×1 |
| `iron_spur` | stack | iron_ingot ×1 + charcoal ×1 | anvil | hammer | attack | iron_spur ×2 |
| `leather_halter` | unique | leather_strap ×3 + iron_buckle ×2 | `bench` | awl | assembly | leather_halter ×1 |
| `leather_bridle` | unique | leather_strap ×4 + iron_bit ×1 + iron_buckle ×2 | `bench` | awl | assembly | leather_bridle ×1 |
| `leather_reins` | unique | leather_strap ×2 + iron_buckle ×1 | `bench` | awl | assembly | leather_reins ×1 |
| `wooden_saddle_tree` | unique | plank ×3 + rawhide_strip ×2 | `bench` | saw / plane | assembly | wooden_saddle_tree ×1 |
| `riding_saddle` | unique | wooden_saddle_tree ×1 + leather_panel ×3 + wool_stuffing ×2 + iron_buckle ×2 + linen_thread ×3 | `bench` | awl | assembly | riding_saddle ×1 |
| `pack_saddle` | unique | wooden_saddle_tree ×1 + leather_panel ×2 + leather_strap ×4 + iron_buckle ×4 | `bench` | awl | assembly | pack_saddle ×1 |
| `war_saddle` | unique | wooden_saddle_tree ×1 + leather_panel ×4 + wool_stuffing ×3 + iron_buckle ×4 + iron_strip ×2 | `bench` | awl | assembly | war_saddle ×1 |
| `draft_harness` | unique | leather_strap ×6 + leather_panel ×2 + iron_buckle ×4 + iron_ring ×4 | `bench` | awl | assembly | draft_harness ×1 |
| `ox_yoke` | unique | wooden_billet ×2 + leather_strap ×2 + iron_ring ×2 | `bench` | chisel | assembly | ox_yoke ×1 |

---

## 16. Fishing & trapping

Rural livelihood. None of these exist today. All authorable with no
engine changes beyond simple world interaction.

### Rod & line

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_fish_hook` | stack | iron_wire ×1 | anvil | hammer | attack | iron_fish_hook ×10 |
| `bone_fish_hook` | stack | bone ×1 | `bench` | knife | attack | bone_fish_hook ×4 |
| `fishing_line` | stack | linen_thread ×1 + beeswax ×1 | `bench` | — | attack | fishing_line ×4 |
| `fishing_rod` | unique | wooden_haft_long ×1 + fishing_line ×1 + iron_fish_hook ×1 | `bench` | — | assembly | fishing_rod ×1 |
| `feather_lure` | stack | iron_fish_hook ×1 + feather ×1 + linen_thread ×1 | `bench` | — | assembly | feather_lure ×4 |

### Nets & traps

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `fishing_net` | unique | hemp_twine ×10 + wooden_dowel ×4 | `bench` (netting_bench) | — | assembly | fishing_net ×1 |
| `cast_net` | unique | hemp_twine ×6 + iron_ring ×8 + lead_ingot ×1 | `bench` | — | assembly | cast_net ×1 |
| `fish_basket_trap` | unique | willow_osier ×6 + hemp_twine ×1 | `bench` (basketry_form) | — | assembly | fish_basket_trap ×1 |
| `eel_pot` | unique | willow_osier ×8 + hemp_twine ×2 | `bench` (basketry_form) | — | assembly | eel_pot ×1 |
| `fish_spear` | unique | iron_strip ×2 + wooden_haft_long ×1 + leather_thong ×1 | anvil | hammer | assembly | fish_spear ×1 |

### Land trapping

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wire_snare` | stack | iron_wire ×1 + linen_thread ×1 | `bench` | — | attack | wire_snare ×4 |
| `deadfall_trap` | unique | wooden_billet ×2 + wooden_dowel ×2 + rope ×1 | `bench` | — | assembly | deadfall_trap ×1 |
| `pit_trap_covering` | unique | plank ×3 + linen_cloth ×1 + straw ×2 | `bench` | — | assembly | pit_trap_covering ×1 |
| `leghold_trap_iron` | unique | iron_strip ×2 + iron_ring ×1 + iron_rivet ×2 | anvil | hammer | assembly | leghold_trap_iron ×1 |

**Notes.** Traps are deployables — placed like workstations. A triggered
deadfall or snare captures a small-game `raw_meat` / `raw_pelt` yield
(future integration with NPC spawn system).

### Bait

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `worm` | stack | — (dig from earth, tool: shovel) | — | — | — | gather |
| `grain_bait` | stack | grain ×1 + water ×1 | `bench` | — | attack | grain_bait ×2 |

---

## 17. Religious items

The altar, prayer mat, and writing desk are already workstations in
the game's content. These are the accoutrements that sit on them.

### Devotional

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `rosary_beads_wood` | unique | wooden_dowel ×1 + linen_thread ×1 | `bench` | knife | assembly | rosary_beads_wood ×1 |
| `rosary_beads_amber` | unique | amber ×10 + linen_thread ×1 | `bench` | — | assembly | rosary_beads_amber ×1 |
| `prayer_bell` | unique | brass_ingot ×2 + wooden_haft_short ×1 | anvil | hammer | assembly | prayer_bell ×1 |
| `wooden_altar_cross` | unique | plank ×2 + hide_glue ×1 | `bench` | saw / chisel | assembly | wooden_altar_cross ×1 |
| `iron_altar_cross` | unique | iron_strip ×3 + charcoal ×1 | anvil | hammer | assembly | iron_altar_cross ×1 |
| `silver_altar_cross` | unique | silver_sheet ×2 + wooden_dowel ×1 | anvil | hammer | assembly | silver_altar_cross ×1 |
| `painted_icon` | unique | plank ×1 + gesso ×1 + pigment_set ×1 + beeswax ×1 | `bench` (scribe_desk) | brush | assembly | painted_icon ×1 |
| `illuminated_prayer_tome` | unique | blank_tome ×1 + oak_gall_ink ×1 + gold_leaf ×1 + cinnabar_ink ×1 | `bench` (scribe_desk) | quill | assembly | illuminated_prayer_tome ×1 |
| `censer_brass` | unique | brass_ingot ×2 + iron_chain_link ×4 + charcoal ×1 | anvil | hammer | assembly | censer_brass ×1 |
| `incense_cone` | stack | pine_resin ×1 + herb_rosemary ×1 + beeswax ×1 | `bench` | — | attack | incense_cone ×6 |
| `holy_water_vial` | stack | water ×1 + salt ×1 | `bench` (altar) | — | time / 100 | holy_water_vial ×1 |
| `reliquary_small` | unique | silver_sheet ×2 + wooden_dowel ×2 + linen_cloth ×1 | `bench` | hammer | assembly | reliquary_small ×1 |
| `prayer_mat` | unique | wool_cloth ×2 + wool_thread ×1 | `bench` | needle | assembly | prayer_mat ×1 |
| `pilgrim_badge_tin` | stack | lead_sheet ×1 + tin_ore ×1 | anvil | hammer | attack | pilgrim_badge_tin ×8 |
| `monastic_habit` | unique | wool_cloth ×4 + rope ×1 + iron_clasp ×1 | `bench` | needle | assembly | monastic_habit ×1 |
| `holy_symbol` | unique | silver_sheet ×1 + leather_thong ×1 | `bench` | hammer | assembly | holy_symbol ×1 |

**Notes.** `amber` is a gatherable coastal primitive not listed in §1 —
add when amber-producing biomes are authored. `gesso` and `pigment_set`
are alchemical pre-mixes — see §12. Gold leaf is authored as a proposed
alchemical product (hammer gold ingot thin; stack output).

---

## 18. Farming & gardening

Extends the existing tools in §4 with the seed / animal-production
loop that actually drives cultivation.

### Seeds

| id | Kind | Source | Notes |
|---|---|---|---|
| `grain_seed` | stack | Reserved from grain harvest (byproduct of threshing — 1 in 20) | Plant at tilled_cell to grow grain node |
| `rye_seed` | stack | As above for rye | |
| `barley_seed` | stack | As above for barley | |
| `oat_seed` | stack | As above for oats | |
| `flax_seed` | stack | Reserved from flax harvest | Tilled only |
| `hemp_seed` | stack | Reserved from hemp harvest | Tilled only |
| `apple_pip` | stack | Apple eaten / pressed | Plant → sapling → mature tree over seasons |
| `grape_cutting` | stack | Vineyard prune | Vine propagation |
| `herb_seed_mix` | stack | Any herb gathering | Propagate herb patches |
| `vegetable_seeds` | stack | Vegetable gather byproduct | Mixed; drop from turnip/cabbage/onion nodes |

**Notes.** Farming-as-a-cycle is not today a Voxim system — tilled soil,
growth timers, season gating. Seed items can be authored as inventory-only
items immediately (used by future farming); growth itself needs engine
work.

### Farming implements (extending §4)

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `ard_plough` | unique | wooden_billet ×2 + iron_strip ×1 + leather_strap ×2 | `bench` | — | assembly | ard_plough ×1 |
| `heavy_plough` | unique | wooden_billet ×3 + iron_sheet ×1 + iron_strip ×2 + leather_strap ×2 + iron_nail ×6 | `bench` | hammer | assembly | heavy_plough ×1 |
| `wooden_harrow` | unique | plank ×3 + wooden_dowel ×8 + leather_strap ×2 | `bench` | — | assembly | wooden_harrow ×1 |
| `iron_tined_harrow` | unique | wooden_harrow ×1 + iron_spike ×12 | anvil | hammer | assembly | iron_tined_harrow ×1 |
| `seed_basket` | unique | willow_osier ×4 + leather_strap ×1 | `bench` (basketry_form) | — | assembly | seed_basket ×1 |
| `grain_cradle_scythe` | unique | scythe ×1 + wooden_dowel ×5 + linen_thread ×1 | `bench` | — | assembly | grain_cradle_scythe ×1 |
| `threshing_flail` | unique | wooden_haft_long ×1 + wooden_haft_short ×1 + leather_thong ×2 | `bench` | — | assembly | threshing_flail ×1 |
| `winnowing_basket` | unique | willow_osier ×3 | `bench` (basketry_form) | — | assembly | winnowing_basket ×1 |

### Livestock accessories

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `milk_pail_wood` | unique | barrel_stave ×4 + iron_strip ×1 + leather_strap ×1 | `bench` (cooper) | — | assembly | milk_pail_wood ×1 |
| `milking_stool` | unique | plank ×1 + wooden_dowel ×3 | `bench` | — | assembly | milking_stool ×1 |
| `butter_crock` | unique | clay ×2 | `loom_device` (potters_wheel) + `kiln` | — | time | butter_crock ×1 |
| `feed_trough` | unique | plank ×4 + iron_nail ×6 | `bench` | hammer | assembly | feed_trough ×1 |
| `chicken_coop_frame` | unique | plank ×6 + iron_nail ×12 + iron_hinge ×1 | `bench` | hammer | assembly | chicken_coop_frame ×1 |
| `beehive_skep` | unique | willow_osier ×6 + straw ×4 | `bench` (basketry_form) | — | assembly | beehive_skep ×1 |

**Notes.** `beehive_skep` is a domesticated honey-producing deployable —
replaces the wild `honey_comb` node as a sustainable source. Needs
entity-type tied to honey production over time (simple timer works).

---

## 19. Construction finishing

Thatch, plaster, whitewash, wattle-and-daub. What turns a
blueprint-built skeleton into a weatherproof dwelling.

### Roofing

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `thatch_bundle` | stack | straw ×4 + hemp_twine ×1 | `bench` | — | attack | thatch_bundle ×1 |
| `reed_bundle` | stack | reed ×4 + hemp_twine ×1 | `bench` | — | attack | reed_bundle ×1 |
| `wooden_shingle` | stack | wooden_billet ×1 | `bench` (riving_brake) | froe | attack | wooden_shingle ×6 |
| `oak_shake` | stack | oak_wood ×1 | `bench` (riving_brake) | froe | attack | oak_shake ×6 |
| `slate_tile` | stack | slate_block ×1 | `bench` (mason_bench) | chisel | attack | slate_tile ×4 |

**Notes.** `slate_block` is a new primitive proposal — gatherable in
mountain regions with splittable stone. Rivable grain is the requirement;
where present, slate tiles are the weatherproof premium roofing.

### Plasters and washes

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `lime_plaster` | stack | slaked_lime ×2 + sand ×3 + hemp_twine ×1 | `vat` (mortar trough) | time | 200 | lime_plaster ×4 |
| `clay_plaster` | stack | clay ×2 + straw ×2 + water ×1 | `vat` | time | 300 | clay_plaster ×3 |
| `whitewash` | stack | slaked_lime ×1 + water ×2 + salt ×1 | `cauldron` | time | 200 | whitewash ×3 |
| `limewash_paint` | stack | whitewash ×2 + pigment_set ×1 | `cauldron` | time | 100 | limewash_paint ×2 |
| `gesso` | stack | slaked_lime ×1 + hide_glue ×1 + water ×1 | `cauldron` | time | 300 | gesso ×2 |

### Wattle and daub

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `willow_wattle_panel` | unique | willow_osier ×8 + wooden_dowel ×3 | `bench` (basketry_form) | — | assembly | willow_wattle_panel ×1 |
| `daub_mix` | stack | clay ×2 + straw ×3 + dung ×1 + water ×1 | `vat` | time | 400 | daub_mix ×4 |
| `wattle_and_daub_wall` | (blueprint) | willow_wattle_panel ×2 + daub_mix ×4 | `bench` | hammer | assembly | wall_panel_wad ×1 |

### Wooden construction assemblies

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `timber_frame_post` | unique | wooden_billet ×3 + iron_nail ×4 | `bench` | adze | assembly | timber_frame_post ×1 |
| `roof_beam` | unique | wooden_billet ×4 + iron_nail ×6 | `bench` | adze | assembly | roof_beam ×1 |
| `wooden_window_frame` | unique | plank ×2 + iron_nail ×6 | `bench` | hammer | assembly | wooden_window_frame ×1 |
| `wooden_door_panel` | unique | plank ×4 + iron_nail ×8 + iron_hinge ×2 + iron_latch ×1 | `bench` | hammer | assembly | wooden_door_panel ×1 |
| `studded_wooden_door` | unique | wooden_door_panel ×1 + iron_nail ×20 + iron_strip ×2 | `bench` | hammer | assembly | studded_wooden_door ×1 |
| `iron_reinforced_door` | unique | wooden_door_panel ×1 + iron_sheet ×2 + iron_rivet ×16 | anvil | hammer | assembly | iron_reinforced_door ×1 |

---

## 20. Locks, keys, security

Locksmith trade. Ties directly into the SPEC's territorial-control
and dynasty-library-protection gameplay.

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `iron_key_blank` | stack | iron_ingot ×1 | anvil | hammer | attack | iron_key_blank ×4 |
| `iron_key` | unique | iron_key_blank ×1 + charcoal ×1 | anvil | hammer | assembly | iron_key ×1 |
| `iron_lock_mechanism` | unique | iron_ingot ×2 + iron_wire ×2 + iron_rivet ×4 | anvil | hammer | assembly | iron_lock_mechanism ×1 |
| `iron_padlock` | unique | iron_lock_mechanism ×1 + iron_sheet ×1 + iron_shackle ×1 | anvil | hammer | assembly | iron_padlock ×1 |
| `iron_shackle` | stack | iron_strip ×2 | anvil | hammer | attack | iron_shackle ×2 |
| `iron_door_lock` | unique | iron_lock_mechanism ×1 + iron_sheet ×2 + iron_key ×1 | anvil | hammer | assembly | iron_door_lock ×1 |
| `chest_lock_assembly` | unique | iron_lock_mechanism ×1 + iron_hinge ×1 + iron_key ×1 | anvil | hammer | assembly | chest_lock_assembly ×1 |
| `strongbox` | unique | iron_bound_chest ×1 + chest_lock_assembly ×1 + iron_rivet ×8 | anvil | hammer | assembly | strongbox ×1 |
| `iron_chains` | stack | iron_chain_link ×10 | anvil | hammer | assembly | iron_chains ×1 |
| `iron_manacles` | unique | iron_shackle ×2 + iron_chain_link ×6 + iron_key ×1 | anvil | hammer | assembly | iron_manacles ×1 |

**Notes.** Each `iron_key` is unique (entity with Durability / instance
state). A lock-and-key pair share a key-ID (future: `Inscribed`-like
component holding a match code). GAP-PAYLOAD-ITEM applies — today the
match is flattened to "any iron_key opens any iron_door_lock." Flag and
ship.

---

## 21. Apothecary & herbal remedies

The herbal primitives (§1) are currently dead-ends — no products.
Completing this section links them to gameplay (injuries per SPEC §Injuries),
survival, and the supernatural-as-alchemy tradition.

### Preparation tools / intermediates

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `dried_herb_bundle` | stack | any_herb ×3 + linen_thread ×1 | `rack` | — | time / 1200 | dried_herb_bundle ×1 |
| `herb_powder` | stack | dried_herb_bundle ×1 | `millstone` (mortar_and_pestle) | — | attack | herb_powder ×2 |
| `distillate_base` | stack | aqua_vitae ×1 + herb_powder ×2 | `vat` | time | 1200 | distillate_base ×1 |

### Internal remedies

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `willowbark_tincture` | stack | herb_willowbark ×3 + aqua_vitae ×1 | `vat` | time | 2400 | willowbark_tincture ×2 |
| `sage_infusion` | stack | herb_sage ×2 + water ×1 | `cauldron` | time | 150 | sage_infusion ×2 |
| `chamomile_tea` | stack | herb_chamomile ×2 + water ×1 + honey ×1 | `cauldron` | time | 100 | chamomile_tea ×2 |
| `mint_infusion` | stack | herb_mint ×2 + water ×1 | `cauldron` | time | 100 | mint_infusion ×2 |
| `rosemary_tonic` | stack | herb_rosemary ×3 + aqua_vitae ×1 | `vat` | time | 2000 | rosemary_tonic ×2 |
| `mullein_cough_syrup` | stack | herb_mullein ×3 + honey ×2 + water ×1 | `cauldron` | time | 300 | mullein_cough_syrup ×2 |
| `sleeping_draught` | stack | herb_chamomile ×2 + aqua_vitae ×1 + honey ×1 | `vat` | time | 1500 | sleeping_draught ×1 |
| `fever_draught` | stack | herb_willowbark ×2 + herb_yarrow ×1 + water ×1 | `cauldron` | time | 400 | fever_draught ×2 |

### Topical remedies

| id | Kind | Recipe | Station | Step | Ticks | Output |
|---|---|---|---|---|---|---|
| `yarrow_poultice` | stack | herb_yarrow ×2 + linen_strip ×1 + water ×1 | `bench` | attack | 0 | yarrow_poultice ×1 |
| `comfrey_salve` | stack | herb_comfrey_root ×2 + tallow ×1 + beeswax ×1 | `cauldron` | time | 600 | comfrey_salve ×2 |
| `rosemary_liniment` | stack | herb_rosemary ×2 + oil ×1 | `cauldron` | time | 400 | rosemary_liniment ×2 |
| `wound_wash` | stack | herb_yarrow ×1 + vinegar ×1 + water ×1 | `cauldron` | time | 200 | wound_wash ×2 |
| `burn_balm` | stack | tallow ×1 + beeswax ×1 + herb_comfrey ×1 | `cauldron` | time | 300 | burn_balm ×2 |
| `antiseptic_ointment` | stack | pine_tar ×1 + tallow ×1 + herb_yarrow ×1 | `cauldron` | time | 400 | antiseptic_ointment ×2 |

### Applied bandages

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `medicated_bandage` | stack | linen_bandage ×1 + yarrow_poultice ×1 | `bench` | — | assembly | medicated_bandage ×1 |
| `burn_dressing` | stack | linen_bandage ×1 + burn_balm ×1 | `bench` | — | assembly | burn_dressing ×1 |
| `splint_set` | unique | wooden_dowel ×4 + linen_strip ×2 + comfrey_salve ×1 | `bench` | — | assembly | splint_set ×1 |

**Notes.** Applying a medicated_bandage to an entity with an Injury
component (per SPEC injury stub) removes or mitigates the debuff. The
effect handler registry (see packages/tile-server/src/effects/) is where
heal-over-time effects attach — matches existing `health_effect` path.

---

## 22. Instruments

Bardic / social gameplay. All are assemblies of existing components
(wood + gut/sinew string + metal fittings) — ship today.

### Wind

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `reed_pipe` | unique | reed ×1 | `bench` | knife | assembly | reed_pipe ×1 |
| `wooden_flute` | unique | wooden_billet ×1 + beeswax ×1 | `bench` (pole_lathe) | drill | assembly | wooden_flute ×1 |
| `horn_trumpet` | unique | horn ×1 + brass_ingot ×1 | `bench` | — | assembly | horn_trumpet ×1 |
| `bagpipes` | unique | wooden_flute ×2 + reed_pipe ×1 + leather_panel ×2 + linen_thread ×2 + pine_tar ×1 | `bench` | awl | assembly | bagpipes ×1 |

### String

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_lute_body` | unique | wooden_billet ×3 + hide_glue ×1 | `bench` | chisel | assembly | wooden_lute_body ×1 |
| `lute` | unique | wooden_lute_body ×1 + gut_string ×4 + wooden_dowel ×4 + hide_glue ×1 | `bench` | — | assembly | lute ×1 |
| `wooden_harp_frame` | unique | wooden_billet ×3 + hide_glue ×1 | `bench` | chisel | assembly | wooden_harp_frame ×1 |
| `harp` | unique | wooden_harp_frame ×1 + gut_string ×6 + iron_nail ×6 | `bench` | — | assembly | harp ×1 |
| `wooden_fiddle_body` | unique | wooden_billet ×2 + hide_glue ×1 | `bench` | chisel | assembly | wooden_fiddle_body ×1 |
| `fiddle` | unique | wooden_fiddle_body ×1 + gut_string ×4 + wooden_dowel ×4 | `bench` | — | assembly | fiddle ×1 |
| `fiddle_bow` | unique | wooden_haft_short ×1 + horsehair ×20 + pine_resin ×1 | `bench` | — | assembly | fiddle_bow ×1 |
| `psaltery` | unique | plank ×2 + gut_string ×10 + iron_nail ×10 | `bench` | — | assembly | psaltery ×1 |

### Percussion

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `wooden_drum_frame` | unique | plank ×2 + iron_nail ×4 | `bench` | hammer | assembly | wooden_drum_frame ×1 |
| `frame_drum` | unique | wooden_drum_frame ×1 + tanned_leather ×1 + leather_thong ×4 | `bench` | — | assembly | frame_drum ×1 |
| `tabor_drum` | unique | wooden_billet ×3 + tanned_leather ×2 + hemp_twine ×4 | `bench` (cooper) | — | assembly | tabor_drum ×1 |
| `tambourine` | unique | wooden_drum_frame ×1 + tanned_leather ×1 + iron_ring ×6 + leather_thong ×2 | `bench` | — | assembly | tambourine ×1 |
| `hand_bell` | unique | brass_ingot ×1 + wooden_haft_short ×1 | anvil | hammer | assembly | hand_bell ×1 |
| `cow_bell` | unique | iron_sheet ×1 + iron_strip ×1 | anvil | hammer | assembly | cow_bell ×1 |

**Notes.** `horn_trumpet` is the battlefield blast horn. `hand_bell` is
small (no lost-wax needed). Church bells and founder-cast brass bells
are deferred (GAP-CONSUMED-STATION — lost-wax mould).

---

## 23. Struck coinage & administrative

### Coinage

Currency. Struck from blanks (see §3a metal components) with a die.

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `copper_coin_die` | unique | iron_ingot ×2 + charcoal ×2 | anvil | smithing_hammer | assembly | copper_coin_die ×1 |
| `silver_coin_die` | unique | iron_ingot ×2 + charcoal ×2 | anvil | smithing_hammer | assembly | silver_coin_die ×1 |
| `gold_coin_die` | unique | iron_ingot ×2 + charcoal ×2 | anvil | smithing_hammer | assembly | gold_coin_die ×1 |
| `copper_coin` | stack | copper_coin_blank ×1 + copper_coin_die ×1 (tool) | anvil | smithing_hammer | attack | copper_coin ×1 |
| `silver_coin` | stack | silver_coin_blank ×1 + silver_coin_die ×1 (tool) | anvil | smithing_hammer | attack | silver_coin ×1 |
| `gold_coin` | stack | gold_coin_blank ×1 + gold_coin_die ×1 (tool) | anvil | smithing_hammer | attack | gold_coin ×1 |
| `copper_penny` | stack | copper_coin ×1 | anvil | — | attack | alias |
| `silver_denier` | stack | silver_coin ×1 | anvil | — | attack | alias |

**Notes.** The coin die is a durable tool (unique item with Durability).
The blank is an input, the die is a tool, the swing produces the struck
coin. No engine changes required. `copper_penny` / `silver_denier` are
**aliases** — the same items with a period-appropriate name when shown
in UI. Authoring should pick one canonical id per material tier.

### Seals & stationery

| id | Kind | Recipe | Station | Tool | Step | Output |
|---|---|---|---|---|---|---|
| `signet_ring` | unique | silver_ingot ×1 + charcoal ×1 | anvil | smithing_hammer | assembly | signet_ring ×1 |
| `wax_seal` | stack | beeswax ×1 + cinnabar_pigment ×1 + signet_ring ×1 (tool) | `bench` | — | attack | wax_seal ×3 |
| `sealed_letter_carrier` | unique | parchment ×1 + oak_gall_ink ×1 + wax_seal ×1 | `bench` (scribe_desk) | quill | assembly | sealed_letter_carrier ×1 |
| `ink_well_ceramic` | unique | clay ×1 | `loom_device` (potters_wheel) + `kiln` | — | time / 1500 | ink_well_ceramic ×1 |
| `inkwell_horn` | unique | horn ×1 | `bench` | knife | assembly | inkwell_horn ×1 |
| `scroll_case_leather` | unique | leather_panel ×2 + iron_buckle ×1 + linen_thread ×1 | `bench` | awl | assembly | scroll_case_leather ×1 |
| `scribe_kit_travelling` | unique | scroll_case_leather ×1 + inkwell_horn ×1 + quill ×3 + parchment ×6 | `bench` | — | assembly | scribe_kit_travelling ×1 |
| `gold_leaf` | stack | gold_ingot ×1 | anvil | smithing_hammer | attack | gold_leaf ×20 |
| `pigment_set` | unique | leather_pouch ×1 + red_ochre ×1 + lamp_black ×1 + madder_red ×1 + weld_yellow ×1 | `bench` | — | assembly | pigment_set ×1 |
| `weld_yellow` | stack | weld_plant ×2 + alum_mordant ×1 | `cauldron` | time / 400 | — | weld_yellow ×2 |

---

## 24. Byproducts

Emerge from other recipes. Listed for cross-chain economic linkage.

| id | Kind | Origin recipes | Downstream uses |
|---|---|---|---|
| `wood_ash` | charcoal, cooking, lime burn, any sustained fire | lye, potash, glass flux |
| `bran` | flour (any mill) | animal feed, second-mash brewing |
| `whey` | cheese set | animal feed, ricotta |
| `buttermilk` | butter churn | drink, dough acid |
| `grape_pomace` | wine press | vinegar, grappa (after still unlocked) |
| `oil_cake` | oil press | animal feed |
| `spent_grain` | mash tun | animal feed, bread filler |
| `hammer_scale` | blade hammering, consolidation | iron_sulfate (ink), pigment |
| `slag` | bloomery, copper matte | glass flux, masonry aggregate |
| `stone_chip` | stone dressing, knapping | mortar aggregate |
| `flax_shive` | flax break | kindling |
| `tow` | flax break/scutch/heckle | gambeson stuffing, caulking, coarse twine |
| `hair` | hide dehair | felt, brush bristle, mortar binder |
| `lanolin` | wool scour | soap, waterproofing, leather dub |
| `offal` | butchery | dung (bating), animal feed |
| `dung` | livestock | bating liquor, fertiliser |
| `bone_char` | pyrolysed bone | sugar-refining filter (late-game), pigment black |
| `litharge` | cupellation | lead-white precursor, pottery glaze |
| `cullet` | broken glass | glass remelt |
| `bark` | any tree chopped | tannin, roofing, tinder |
| `flue_dust` | lime burn | discarded today; future saltpeter reagent |
| `spent_ash` | ash leach | discarded; fertiliser |
| `salt_trace` | cured meat run-off | discarded today |
| `honey_wax_comb` | honey press | beeswax, candle |
| `greaves` | tallow render | animal feed, soap |

---

## Closing notes

**Item count.** ~680 distinct item ids across 24 sections, covering every
volume medieval artisan trade. Component tier (§3) carries ~80; T4
assemblies (§4–6) carry ~110; trade-specific sections §14–§23 carry
~190 more; byproducts (§24) another ~25; primitives (§1) ~70; primary
materials (§2) ~40; food / alchemical / containers / ceramics across
§7–§13 another ~160. Original catalogue was ~70 items; the
pre-component-tier revision was ~270.

**Trade coverage.** Every volume medieval trade is represented:

| Trade | Primary section(s) |
|---|---|
| Weaver / fuller / dyer | §2 textile first-layer, §9 finished cloth, §12 dyes |
| Tailor / hosier / glover / cap-maker | §3d textile components, §9 clothing |
| Blacksmith / cutler / nailor / wire-drawer | §3a metal components |
| Swordsmith / armourer | §5 weapons, §6 armour |
| Tanner / tawyer / currier / cobbler / parchmenter | §2 leather first-layer, §3c leather components, §9 boots, §10 parchment |
| Carpenter / joiner / turner / cooper | §3b wood components, §14 furniture, §7 containers, §19 timber framing |
| Bowyer / fletcher | §5 bows + arrows |
| Potter / tilemaker / brickmaker | §13 ceramics, §3f ceramic components |
| Baker / miller / brewer / butcher / cheesemaker / chandler / soaper / apiarist | §8 food, §11 lighting, §12 soaps |
| Lime-burner / charcoal-burner / pitch-boiler | §2 primary materials |
| Wheelwright / cartwright | §15 transport |
| Saddler | §15 horse tack |
| Locksmith | §20 locks, keys, security |
| Apothecary / herbalist | §21 apothecary |
| Instrument-maker | §22 instruments |
| Moneyer | §23 coinage |
| Thatcher / plasterer | §19 construction finishing |
| Scribe / bookbinder / illuminator | §10 lore physicals, §23 administrative |
| Fisher / trapper | §16 fishing & trapping |
| Goldsmith / silversmith | §3a metal components, §23 seals / signet |

**Deferred trades** (engine-gap blocked): bellfounder (lost-wax,
GAP-CONSUMED-STATION), glass-blower / glazier (GAP-STATE), shipwright
(scope). Flagged per-item.

**Authoring order (dependency-respecting, first wave):**

1. Primitives — all gathering nodes exist today or are straightforward.
2. Primary materials — plank, stone_block, iron_ingot, copper_ingot,
   clay-ware base, quicklime, salt, charcoal, tallow, lye.
3. Wood components — hafts, shafts, staves, pommels, dowels, shield
   blanks, barrel staves, wheel hubs, spokes.
4. Metal components — blades (all tiers), heads (axe, spear, hammer,
   etc.), hardware (nails, hinges, rivets, rings, wire, sheet), armour
   plates, horseshoes.
5. Leather components — after the leather chain.
6. Cord / thread — after linen/wool chains.
7. Tools — assembly from the above.
8. Weapons — assembly; bow / crossbow depend on cord.
9. Armour — assembly.
10. Food and drink.
11. Containers.
12. Furniture — biggest single gap before; unblocks "home" feel.
13. Transport (wheels → cart → wagon); horse tack.
14. Construction finishing (thatch, shingles, plaster, wattle-and-daub,
    doors) — unblocks richer blueprint variety.
15. Locks, keys, strongboxes — unblocks library/treasury security per
    SPEC.
16. Lighting and lore physicals.
17. Apothecary remedies — closes the loop on herb primitives and
    SPEC injuries.
18. Fishing & trapping — rural livelihood.
19. Religious items.
20. Instruments — social / bardic.
21. Coinage — economy layer.
22. Alchemical pigments (mostly GAP-blocked).

**Multi-recipe principle honoured.** Items with historical alternatives
have multiple recipes:

| Item | Paths |
|---|---|
| plank | chop / rive |
| charcoal | pit / kiln |
| salt | boil / solar |
| flour | quern / watermill |
| iron_ingot | stub smelt / full bloomery chain |
| iron_blade_medium | direct hammer / full forge chain with quench + temper |
| bowstring | linen / sinew / hemp / gut |
| cured_meat | salt / smoke / air-dry |
| bread | wheat / rye / flatbread / sourdough |
| ale | barley / rye |
| soap | curd / hard / fine |
| candle | tallow / beeswax |
| tanned_leather | bark / alum-taw |
| dye | blue (woad/indigo) / red (madder) / yellow (weld) / brown (walnut) / purple (blue+red) |
| wheel | wooden / iron-tyred |
| saddle | riding / pack / war |
| altar_cross | wood / iron / silver |
| plough | ard / heavy |
| mattress | straw / wool / feather |
| shingle | wooden / oak / slate |
| drum | frame / tabor / tambourine |
| mortar | lime / clay; + lime_plaster / whitewash / gesso |
| lock | padlock / door / strongbox |
| poultice | yarrow / comfrey / burn balm |
| infusion | sage / chamomile / mint / rosemary / willowbark |

**Orthogonality multipliers (component → assembly reuse):**

- `wooden_haft_medium` — sword, axe, pickaxe, hammer, mace, war-axe, adze, hoe
- `wooden_haft_long` — spear, pike, glaive, halberd, scythe, pitchfork, flail, hoe, quarterstaff, cart-shafts
- `wooden_haft_short` — knife, dagger, chisel, drill, froe, awl, lunellum, fish-spear, lute-neck (abstract), fiddle-bow
- `leather_strap` — belt, saddle, harness, shield, helm, boot, armour, bridle, pouch
- `leather_panel` — boots, gauntlets, book binding, satchel, tunic, sheath
- `iron_ring` — mail, chain, net weight, chain armour, chain_link, cast_net, leghold trap
- `iron_nail` — crate, chest, furniture, door, frame, barrel
- `iron_strip` — sword tang, hinge, axle reinforcement, tyre, pickaxe wedge, key shaft
- `linen_thread` — bowstring, sewing, bookbinding, bandage, net-tying, quillwrap
- `brass_ingot` — bell, censer, horn_trumpet, hand_bell, cow_bell (iron variant), fittings

Component-tier authorship is one-time; every assembly above leans on it.

**Deferred from first wave** (need engine gaps):
- Live woad vat, aged cheese, aqua_vitae, solar salt, stockfish, bleached_linen, verdigris, lead_white, saltpeter — GAP-STATE, GAP-ENV, GAP-CHECKPOINT.
- Mail-making at real scale — GAP-BATCH.
- Bell-founding (lost-wax) and glass blowing — GAP-CONSUMED-STATION / GAP-STATE.
- Seasonal / farming cycle — engine lacks tilled-soil, growth timers, seasons.
- Lock-and-key match codes — GAP-PAYLOAD-ITEM (works flattened today).

These flagged with GAP-* per recipe so the engine work chooses targets
by frequency.

**Next move.** Author content bottom-up from the authoring order list.
Each item is a `prefab.json` drop plus one or more `recipe.json` drops.
The taxonomy in [CONSOLIDATION.md](CONSOLIDATION.md) limits the new
workstation prefab count to ~12 for first wave; every recipe in this
document maps to one of them.
