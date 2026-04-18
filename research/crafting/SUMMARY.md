# Pre-Industrial Crafting Research — Phase 3 Synthesis

Aggregates the eight category catalogues into one decision document. Source files:
[ceramics_and_glass.md](ceramics_and_glass.md), [chemistry_and_dyes.md](chemistry_and_dyes.md),
[food_and_preservation.md](food_and_preservation.md), [leather_and_hide.md](leather_and_hide.md),
[metallurgy.md](metallurgy.md), [stone_and_mineral.md](stone_and_mineral.md),
[textiles.md](textiles.md), [wood_and_pyrolysis.md](wood_and_pyrolysis.md). Framing:
[README.md](README.md).

---

## 1. At a glance

| Category | Chains |
|---|---|
| Ceramics & Glass | 9 |
| Chemistry & Dyes | 12 |
| Food & Preservation | 14 |
| Leather & Hide | 7 |
| Metallurgy | 10 |
| Stone & Mineral | 11 |
| Textiles | 8 |
| Wood & Pyrolysis | 9 |
| **Total** | **80** |

- **~95 workstations** introduced (~**75** post-dedup).
- **78 raw verbs → ~50 canonical** after merging synonyms.
- **16 distinct `GAP-*` tags** (9 from README + 7 new proposed by category authors).

---

## 2. Merged primitive verb vocabulary

Grouped by family. Aliases absorbed in parentheses. This vocabulary argues for a future
`Recipe.verb` field so recipes self-classify.

**Thermal.** `apply-heat` (all; absorbs boil/simmer/kiln-dry/bake/low-smoke), `apply-high-heat`
(Ceramics&Glass, Metallurgy, Stone, Wood), `combust` (Chemistry, Stone, Wood), `quench`
(Metallurgy, Stone), `temper` (Metallurgy), `roast` (Metallurgy, Chemistry), `burn-out`
(Metallurgy), `distil` (Chemistry, Metallurgy), `evaporate` (Chemistry, Food, Stone).

**Mechanical.** `hammer` (Ceramics, Metallurgy, Stone, Textiles, Wood; absorbs
strike/forge/pound/knap), `grind` (Ceramics, Chemistry, Food, Metallurgy, Stone; absorbs
mill/muller), `crush` (Chemistry, Food, Metallurgy, Stone, Wood), `cut` (all; absorbs
saw/split/shear/butcher), `chisel` (Stone, Metallurgy), `rive` (Wood), `turn` (Ceramics, Wood),
`press` (Ceramics, Chemistry, Food, Leather), `knead` (Ceramics, Food, Leather), `draw`
(Metallurgy wire, Textiles fibre), `spin` (Ceramics glass, Textiles fibre), `stretch`
(Leather, Metallurgy), `scrape` (Ceramics, Leather, Metallurgy, Stone), `drill` (Stone),
`churn` (Food, Textiles; full/felt collapse here when output is dense mat), `pack` (Food,
Metallurgy, Stone), `pour` (Metallurgy, Stone), `head` (Metallurgy — kept distinct from
hammer).

**Chemical / biological.** `ferment` (Chemistry, Food, Textiles; absorbs acetify), `ret`
(Textiles, Chemistry — kept distinct, pectin-specific), `cure` (Food, Leather, Stone;
absorbs salt/brine/age/mature/smoke-when-preservative), `tan` (Leather), `taw` (Leather),
`leach` (Ceramics, Chemistry, Stone, Wood), `mordant` (Chemistry, Textiles), `dye`
(Chemistry, Textiles), `saponify` (Chemistry), `slake` (Stone — kept for GAP-DANGER-INPUT),
`oxidise` (Chemistry), `crystallise` (Chemistry, Stone), `bate` (Leather), `render`
(Chemistry, Food), `flux` (Metallurgy), `refine`/`pole` (Metallurgy), `cupel` (Metallurgy).

**Assembly.** `assemble` (Metallurgy, Stone, Textiles, Wood; absorbs form/shape for multi-part),
`weave` (Textiles; absorbs plait), `knot` (Textiles — kept distinct from weave), `spin-fibre`
(Textiles), `nalbind`/`knit`/`loop` (Textiles), `ply` (Textiles), `sew` (Leather, Textiles),
`join`/`rivet`/`solder` (Metallurgy), `cast` (Chemistry, Metallurgy; absorbs pour-into-mould),
`inscribe` (Chemistry), `dip` (Metallurgy; absorbs coat), `blow-and-shape` (Ceramics).

**Preparation & gathering.** `gather`/`pick`/`harvest`/`dig`/`mine` (all — usually resource
node ops), `dry` (all), `soak` (Chemistry, Food, Leather, Textiles; absorbs steep), `wash`
(Chemistry, Leather; absorbs scour), `strain` (Chemistry, Leather; absorbs filter), `sort`
(Food, Textiles; absorbs winnow/sieve/skirt), `thresh` (Food), `germinate` (Food), `mash`
(Food), `pitch`-yeast (Food), `proof` (Food), `peel` (Wood), `age`/`season`/`mature`
(Ceramics, Food, Wood), `shred` (Food, Textiles), `decant` (Food).

---

## 3. Full workstation inventory

**Background stations already in Voxim (anchors, not re-introduced):** `campfire`, `workbench`,
`chopping_block`, `forge`, `anvil`.

### Thermal / kiln family

| Name | Purpose | Originating | `stationType` | Notes |
|---|---|---|---|---|
| Updraft kiln | Fire ceramics, gypsum | Ceramics&Glass, Metallurgy, Stone | `updraft_kiln` | Parameterise temp; absorbs `pottery_kiln`, `bone_ash_kiln` |
| Brick clamp | Self-consuming brick pile | Ceramics&Glass | `brick_clamp` | GAP-CONSUMED-STATION |
| Glass furnace | Continuously-hot glass tank | Ceramics&Glass | `glass_furnace` | GAP-STATE flagship |
| Annealing lehr | Slow-cool blown glass | Ceramics&Glass | `annealing_lehr` | |
| Bloomery | Reduce iron ore | Metallurgy | `bloomery` | |
| Copper furnace | Non-ferrous reducing smelt | Metallurgy | `copper_furnace` | May merge with bloomery |
| Crucible furnace | High-temp alloying | Metallurgy | `crucible_furnace` | |
| Cementation crucible | Sealed long-hold (brass) | Metallurgy | `cementation_crucible` | May alias crucible_furnace |
| Cupellation hearth | Bellows silver refining | Metallurgy | `cupellation_hearth` | GAP-CONSUMED-STATION (cupel) |
| Roasting hearth | Open-pit ore roast | Metallurgy, Stone | `roasting_hearth` | |
| Lime kiln | Calcine limestone | Stone | `lime_kiln` | GAP-STATE |
| Saltern hearth | Boil brine to salt | Food, Stone | `saltern_hearth` | Merge with `salt_boiling_pan` |
| Charcoal clamp | Pyrolysis cordwood | Wood | `charcoal_clamp` | GAP-CONSUMED-STATION |
| Tar pit (tjärdal) | Dry-distil pine | Wood | `tar_pit` | GAP-CONSUMED-STATION |
| Tar kiln | Birch dry distillation | Chemistry, Wood | `tar_kiln` | |
| Soot lamp | Capture lamp-black | Chemistry | `soot_lamp` | |
| Malt kiln | Arrest germination | Food | `malt_kiln` | |
| Bread oven | Masonry thermal-mass | Food | `bread_oven` | GAP-STATE |
| Smokehouse | Cold/hot smoke | Food, Leather | `smokehouse` | Absorbs `smoke_pit` |
| Alembic still | Distil spirits | Chemistry | `alembic_still` | |
| Quench tub | Harden blade | Metallurgy | `quench_tub` | |
| Tinning pot | Molten tin dip | Metallurgy | `tinning_pot` | Alias cauldron |
| Lead hearth | Low-temp lead smelt | Metallurgy | `lead_hearth` | |
| **Cauldron** | **Generic hot pot** | **Chemistry, Food, Leather, Wood, Textiles** | `cauldron` | **Absorbs `kettle`, `brew_kettle`, `soap_cauldron`, `glue_pot`, `tarring_pot`, `salt_boiling_pan` — pick one name, commit** |

### Wet / vat / pit family

| Name | Purpose | Originating | `stationType` | Notes |
|---|---|---|---|---|
| Weathering bed | Outdoor clay weather | Ceramics | `weathering_bed` | GAP-ENV |
| Settling tub | Levigate fines | Ceramics, Chemistry | `settling_tub` | |
| Wedging bench | Knead clay | Ceramics | `wedging_bench` | |
| Ash hopper | Leach lye from ash | Ceramics, Chemistry, Wood | `ash_hopper` | Absorbs `ash_boiler`, `leach_barrel` |
| Glazing bench | Dip/brush pottery | Ceramics | `glazing_bench` | |
| Batching bench | Weigh glass batch | Ceramics | `batching_bench` | |
| Soaking vat | Rehydrate hide/fibre | Chemistry, Leather, Textiles | `soaking_vat` | Absorbs `soak_tub`, `mixing_tub`, `soaking_trough`, `strainer` |
| Retting pond | Bacterial fibre retting | Textiles, Chemistry | `retting_pond` | GAP-ENV |
| Dye vat | Heated dye bath | Chemistry, Textiles | `dye_vat` | |
| Woad vat | Alkaline indigo vat | Chemistry | `woad_vat` | GAP-STATE flagship |
| Woad-ball rack | Age woad pulp | Chemistry | `woad_ball_rack` | |
| Vinegar crock | Aerobic acetify | Food | `vinegar_crock` | |
| Pickling crock | Anaerobic lacto-ferment | Food | `pickling_crock` | |
| Crystallising tub | Slow evaporative | Chemistry, Stone | `crystallising_tub` | |
| Salt pan | Solar evaporate | Food, Stone | `salt_pan` | GAP-ENV flagship |
| Brine well | Saline spring | Food, Stone | `brine_well` | |
| Slaking pit | Slake quicklime | Stone | `slaking_pit` | GAP-DANGER-INPUT |
| Mortar trough | Mix lime mortar | Stone | `mortar_trough` | |
| Verdigris pot | Vinegar fume over copper | Chemistry | `verdigris_pot` | GAP-ENV (sealed) |
| Lead-stack bed | Dung-heated lead-white | Chemistry | `lead_stack_bed` | GAP-ENV |
| Tanning pit | Bark-liquor soak | Leather | `tanning_pit` | GAP-ENV + GAP-BATCH |
| Lime pit | Dehair quicklime | Leather | `lime_pit` | |
| Bating tub | Enzymatic relax | Leather | `bating_tub` | |
| Fermenter | Generic ferment vessel | Food | `fermenter` | Absorbs `fermenting_vat` |
| Mash tun | Hot mash for brew | Food | `mash_tun` | |
| Steeping cistern | Soak malt grain | Food | `steeping_cistern` | |
| Cheese vat | Warm-set milk | Food | `cheese_vat` | |
| **Cellar** | **Cool-humid aging** | **Food** | `cellar` | **Absorbs `wine_cellar`, `cheese_cave` — parameterise `ageProfile`, saves ~30% aged-goods authoring** |
| Cooling tray | Set hide glue | Leather | `cooling_tray` | Alias `drying_rack` |
| Fulling trough | Agitate wet wool | Textiles | `fulling_trough` | GAP-STATE |
| Scouring vat | Wash fleece | Textiles | `scouring_vat` | |
| Tawing drum | Paddle alum hide | Leather | `tawing_drum` | |
| Slip bath | Dip lost-wax model | Metallurgy | `slip_bath` | |

### Mechanical / bench family

| Name | Purpose | Originating | `stationType` | Notes |
|---|---|---|---|---|
| Potter's wheel | Throw vessels | Ceramics | `potters_wheel` | |
| Handbuilding mat | Coil/slab build | Ceramics | `handbuilding_mat` | |
| Brick mould | Form green bricks | Ceramics | `brick_mould` | |
| Tile form | Curved tile former | Ceramics | `tile_form` | |
| Glassblower's chair | Blow & shape | Ceramics | `glassblowers_chair` | |
| Mortar & pestle | Small-scale crush | Chemistry, Stone, Wood | `mortar_and_pestle` | Absorbs `mortar`, `grinding_bench`, `bark_mill` |
| Muller slab | Grind pigment | Chemistry | `muller_slab` | |
| Hand quern | Manual grain mill | Ceramics, Chemistry, Food, Metallurgy | `hand_quern` | |
| Watermill / windmill | Mechanised mill | Food | `watermill`, `windmill` | GAP-ENV |
| Grain mill (deployed) | Assembled millstone pair | Stone, Food | `grain_mill` | GAP-DEPLOY-STATION |
| Ore stamp | Crush ore | Metallurgy | `ore_stamp` | |
| Mason bench | Chisel stone | Stone | `mason_bench` | |
| Sand-saw frame | Abrasive marble saw | Stone | `sand_saw_frame` | GAP-MULTI-OPERATOR |
| Knapping stump | Flake flint | Stone | `knapping_stump` | |
| Rock face | Placed quarry site | Stone | `rock_face` | |
| Shaving horse | Draw-knife bench | Wood | `shaving_horse` | May absorb `riving_brake` |
| Riving brake | Froe-split billet | Wood | `riving_brake` | |
| Cooper workbench | Raise/toast/head barrel | Wood | `cooper_workbench` | |
| Pole lathe | Treadle turning | Wood | `pole_lathe` | |
| Draw bench | Draw wire | Metallurgy | `draw_bench` | |
| Heading block | Upset nail heads | Metallurgy | `heading_block` | May live on anvil |
| Casting flask | Packed sand mould | Metallurgy | `casting_flask` | GAP-INPUT-RETURNED |
| Parchment frame | Stretch hide | Leather | `parchment_frame` | |
| Fleshing beam | Dehair/de-flesh | Leather | `fleshing_beam` | |
| Staking bench | Flex hide supple | Leather | `staking_bench` | |
| Currying bench | Dub/finish leather | Leather | `currying_bench` | |
| Flax brake | Break retted stalks | Textiles | `flax_brake` | |
| Scutching board | Scrape boon | Textiles | `scutching_board` | |
| Heckling comb | Comb fibre | Textiles | `heckling_comb` | |
| Carding bench | Card wool | Textiles | `carding_bench` | |
| Spinning wheel | Spin yarn | Textiles | `spinning_wheel` | |
| Distaff & spindle | Hand spinning | Textiles | `distaff_and_spindle` | |
| Loom | Weave cloth | Textiles | `loom` | |
| Teasing frame | Raise nap | Textiles | `teasing_frame` | |
| Cloth-shearing board | Shear nap | Textiles | `cloth_shearing_board` | |
| Netting bench | Knot nets | Textiles | `netting_bench` | |
| Basketry form | Weave around form | Textiles | `basketry_form` | |
| Rope walk | Counter-twist rope | Textiles | `rope_walk` | GAP-ENV (length) |
| Felting mat | Wet-felt wool | Textiles | `felting_mat` | |
| Form block | Shape felt body | Textiles | `form_block` | |
| **Drying rack** | **Shelved dry shelter** | **Ceramics, Chemistry, Food, Leather, Metallurgy, Wood** | `drying_rack` | **Heavy reuse; absorbs `curing_rack`, `cooling_tray`, `drying_yard`** |
| Threshing floor | Flail grain | Food | `threshing_floor` | |
| Kneading trough | Knead dough | Food | `kneading_trough` | |
| Cheese press | Weighted press | Food | `cheese_press` | |
| Butter churn | Agitate cream | Food | `butter_churn` | |
| Settling pan | Separate cream/oil | Food | `settling_pan` | |
| Oil mill / oil press | Crush + squeeze | Food | `oil_mill`, `oil_press` | |
| Wine press / treading trough | Crush grapes | Food | `wine_press`, `treading_trough` | |
| Butcher block | Break down carcass | Food | `butcher_block` | |
| Brine barrel | Wet-cure meat | Food | `brine_barrel` | |
| Sorting table | Skirt fleece | Textiles | `sorting_table` | |
| Bleaching green | Sun-bleach linen | Textiles | `bleaching_green` | GAP-ENV |
| Ink bench | Combine ink | Chemistry | `ink_bench` | |
| Scribe desk | Inscribe tome | Chemistry | `scribe_desk` | GAP-PAYLOAD-ITEM |
| Chandler bench / wax mould | Pour candles | Chemistry | `chandler_bench`, `wax_mould` | |
| Salting floor | Dry-cure hide | Leather | `salting_floor` | |

**Consolidation impact:** `cauldron` absorbs 7 names, `drying_rack` absorbs 3, `soaking_vat`
absorbs 4, `ash_hopper` absorbs 2, `mortar_and_pestle` absorbs 3, `cellar` absorbs 2,
`smokehouse` absorbs 1, `updraft_kiln` absorbs 2, `fermenter` absorbs 1. Post-dedup: **~75
authored stations**.

---

## 4. Engine gap frequency table

Sorted by chain-count descending.

| # | Tag | Count | Description | Reference chain |
|---|---|---|---|---|
| 1 | GAP-ENV | 33 | No environmental prerequisites (water-adjacent, sheltered, direct sun, biome-gated). | Stockfish air-drying ([food_and_preservation.md](food_and_preservation.md)) |
| 2 | GAP-STATE | 23 | No station state beyond buffer+timer (lit?, fuel?, temp?, vat alive?). | Woad vat ([chemistry_and_dyes.md](chemistry_and_dyes.md)) |
| 3 | GAP-PROCESS-PARAM | 22 | No continuous recipe parameters (temp, humidity, ratio, pH). | Bronze alloying ([metallurgy.md](metallurgy.md)) |
| 4 | GAP-QUALITY | 22 | No per-craft quality scalar — master cannot outstat novice from same inputs. | Blade forging ([metallurgy.md](metallurgy.md)) |
| 5 | GAP-BATCH | 17 | No batch-size concept for intrinsically batched processes. | Brick clamp ([ceramics_and_glass.md](ceramics_and_glass.md)) |
| 6 | GAP-CHECKPOINT | 13 | No intra-recipe checkpoints — "is it done yet?" flattens to atomic timers. | Parchment scraping ([leather_and_hide.md](leather_and_hide.md)) |
| 7 | GAP-DURABILITY | 10 | Crafting does not wear tools/stations. | Mason chisels ([stone_and_mineral.md](stone_and_mineral.md)) |
| 8 | GAP-SKILLED-YIELD | 9 | Skilled crafter extracts more output from same inputs. | Flint knapping ([stone_and_mineral.md](stone_and_mineral.md)) |
| 9 | GAP-CONSUMED-STATION | 8 | Workstation cannot self-destruct on use. | Lost-wax casting ([metallurgy.md](metallurgy.md)) |
| 10 | GAP-FAIL-MODE *(new)* | 3 | No probabilistic/skill-gated alternate outputs. | Blade heat treatment ([metallurgy.md](metallurgy.md)) |
| 11 | GAP-DANGER-INPUT *(new)* | 3 | Recipes that hurt the crafter/bystanders. | Lime slaking ([stone_and_mineral.md](stone_and_mineral.md)) |
| 12 | GAP-INPUT-RETURNED *(new)* | 2 | Reusable inputs that shouldn't be consumed (patterns, gauges). | Sand-cast fittings ([metallurgy.md](metallurgy.md)) |
| 13 | GAP-PAYLOAD-ITEM *(new)* | 1 | Items carrying per-instance payload beyond material slots. | Oak-gall ink → tome ([chemistry_and_dyes.md](chemistry_and_dyes.md)) |
| 14 | GAP-PORTABLE-CRAFT *(new)* | 1 | Timed recipes with no station. | Nalbound mitten ([textiles.md](textiles.md)) |
| 15 | GAP-MULTI-OPERATOR *(new)* | 1 | Workstations needing two simultaneous occupants. | Sand-sawing marble ([stone_and_mineral.md](stone_and_mineral.md)) |
| 16 | GAP-DEPLOY-STATION *(new)* | 1 | Chain output is itself a workstation needing deployment. | Millstone dressing ([stone_and_mineral.md](stone_and_mineral.md)) |

---

## 5. Proposed new gaps (beyond README taxonomy)

**GAP-FAIL-MODE** — alternate outputs on failure (scrap_iron, misrun casting, mouldy cheese,
over-retted flax). Surfaced by blade forging, sand-casting, parchment. *Subsumable?* No —
sibling to GAP-QUALITY (which is degrees of the same output).

**GAP-DANGER-INPUT** — running the recipe damages crafter/bystanders. Surfaced by lime slaking,
fire-set quench, cupellation. *Subsumable?* No — side-effect mechanic, not a quality dial.
Implement as `onActiveTick` damage emit.

**GAP-INPUT-RETURNED** — inputs that survive the recipe (casting patterns, mesh gauges, mill
bills). *Subsumable?* Partially — extending `requiredTools` or adding `reusableInputs`
resolves it.

**GAP-PAYLOAD-ITEM** — per-instance item data beyond material slots (inscribed fragment, named
owner, seal). Surfaced by oak-gall ink → tome. *Subsumable?* No — material slots can't hold
lore-fragment refs. Narrow but load-bearing.

**GAP-PORTABLE-CRAFT** — timed recipes without a station (nalbinding). *Subsumable?* Probably —
a "portable stool" workstation item resolves mechanically. Defer.

**GAP-MULTI-OPERATOR** — two-body workstations (two-man saw). *Subsumable?* No. Low frequency;
flag and defer.

**GAP-DEPLOY-STATION** — chain output is a workstation (millstone → grain mill). *Subsumable?*
**Yes** — `ItemTemplate.deploysTo` (commit 4aa0c16) already addresses this.

---

## 6. The byproduct economic graph

Connectors that appear in ≥ 2 chains. These are the economic glue: they tell you which chains
must be authored in bundles rather than in isolation.

```
wood_ash ─(leach)→ lye ─(evaporate)→ potash
  lye ─→ soap, woad_vat, leather-dehair, household cleaning
  potash ─→ glass_flux, dye_mordant, soap

limestone ─(burn)→ quicklime ─(slake)→ slaked_lime
  slaked_lime ─→ leather-dehair, mortar, whitewash, plaster

salt ─→ cured_meat, cheese, stockfish cure, leather salting, tawing

tallow / bone / hide / offal (butchery) ─→ soap, candles, glue, leather, cupels

charcoal ─→ metallurgy (all smelts), glass_furnace, every updraft_kiln

pine_tar ─→ barrel seams, rope, leather boots, shingles
  pine_tar ─(boil)→ pine_pitch ─(boil further)→ rosin

oak_bark ─→ tannin_liquor ─→ vegetable tanning
oak_gall ─(+iron sulfate)→ iron-gallate_ink ─→ tome inscription

whey, spent_grain, bran, oil_cake ─→ pig/livestock feed loop

slag ─→ glass flux, masonry aggregate
hammer_scale ─→ pigment, dye mordant
fired_crucible ─→ all non-ferrous metallurgy

beeswax ─→ candles, lost-wax casting, seals
honey ─→ mead, food

cullet / glass_drip ─→ glass batch remelt (internal loop)
potsherd / crucible_shard ─→ grog temper (clay prep)

flax_stalks ─→ retted_flax ─→ line_flax ─→ linen_yarn ─→ linen_cloth
tow (flax/hemp) ─→ gambeson stuffing, oakum caulking
lanolin (wool) ─→ leather waterproofing, candles, soap
```

**Four arteries of the catalogue:**

1. **`wood_ash → lye → potash`** (Wood → Chemistry → Textiles/Ceramics/Leather)
2. **Butchery byproducts** (Food → Leather/Chemistry/Metallurgy)
3. **`charcoal`** (Wood → Metallurgy/Ceramics/Chemistry — every high-heat step depends on it)
4. **`salt`** (Food/Stone → Food/Leather/Chemistry)

**Implication:** either trunk authored in isolation leaves dead-end items. The wood_ash trunk
and the butchery trunk should each be authored in full sweeps.

---

## 7. Load-bearing engine changes

Ranked by leverage — how many chains each unlocks.

**1. Environmental prerequisites (GAP-ENV) — 33 chains.** Add `requiresNearby: ["water_source" |
"outdoors" | "sheltered" | "direct_sun" | "cool_ambient" | "wetland" | "windy" | ...]` to
Recipe/Workstation, evaluated against terrain + weather each tick. Unblocks stockfish, solar
salt pans, retting ponds, woad-vat warmth, bleaching greens, rope walks, charcoal clamps
failing in rain, tanning pits near water, lead-white composting warmth.

**2. First-class station state (GAP-STATE) — 23 chains.** Extend `WorkstationBuffer` with an
author-defined typed state blob (`{ isLit, fuelRemaining, temperature, liquorStrength,
motherAlive, age }`), read/written per tick with per-prefab codec. Unblocks lime-kiln stoking,
glass-furnace continuous pool, woad-vat alive/dead, fermenters, mother-of-vinegar, tanning-pit
liquor strength, cheese aging, kiln pre-heat. Also eliminates the "fuel as per-tick-input"
kludge.

**3. Continuous recipe parameters (GAP-PROCESS-PARAM) — 22 chains.** Add `parameters: [{ name,
range, affects: ["yield"|"quality"|"failChance"] }]` to Recipe, set at start or mid-recipe via
swing input. Unblocks the entire "skilled crafter" dimension and collapses N-graded-recipe
explosions into one parameterised recipe.

**4. Per-craft quality scalar (GAP-QUALITY) — 22 chains.** Optional `quality: f32` on item
instances, rolled at craft time from (crafter skill × recipe parameters), consumed by
downstream stat derivations. Hooks cleanly into the existing lore `outwardScale`/`inwardScale`
pattern.

**5. Batch / multi-instance recipes (GAP-BATCH) — 17 chains.** Workstation runs N parallel
recipe instances up to `capacity`, sharing common state (tanning pit holding 20 hides).
Simpler fallback: scale input/output quantities + bump station `slots`. Unblocks medieval-scale
production; resolves NPC-labour throughput awkwardness.

**Runners-up:** Tool durability (10 chains — also unblocks whetstone consumer); consumable
stations (8 chains — unblocks lost-wax + charcoal clamp visuals); fail-mode outputs (3 chains
— unblocks skill-gated metallurgy).

---

## 8. Priority authoring shortlist

Chains that should be first-wave content. Criteria: high gameplay value, minimal engine gaps,
high cross-category connectivity.

| # | Chain | Category | Reason |
|---|---|---|---|
| 1 | Charcoal burning (clamp) | Wood | Backbone of metallurgy; nothing smelts without charcoal. Workaround (station-as-item yielding on completion) is clean. Unblocks bronze, brass, iron, silver, glass. |
| 2 | Potash from wood ash | Wood/Chemistry | Short (leach + evaporate), fits engine today. Feeds soap, glass flux, dye mordants, woad vats. Highest short-chain leverage. |
| 3 | Lye + curd soap | Chemistry | Clean fit; household consumable + leather degreaser + parchment prep. Natural pair with potash. |
| 4 | Flax → linen | Textiles | Ten-step archetype showcasing `chainNextRecipeId`; unblocks gambesons, bandages, sails, tome-grade linen. No existing linen item. |
| 5 | Vegetable (bark) tanning → leather | Leather | No leather item exists currently. Gates an entire equipment sub-tree. Gaps workaroundable. |
| 6 | Parchment / vellum | Leather | Only physical chain that feeds the lore tome economy. Low engine friction (reuses tanning prep). |
| 7 | Oak-gall ink | Chemistry | Pairs with parchment to produce tomes. Blocker GAP-PAYLOAD-ITEM — surmountable. |
| 8 | Wool → woollen broadcloth | Textiles | Largest medieval industry; high trade value; material-stat differentiation vs linen. Gaps workaroundable. |
| 9 | Blade forging & heat treatment | Metallurgy | Replaces single-step `copper_spear` with a real chain. Unlocks weapon progression. GAP-QUALITY acute but placeholder OK. |
| 10 | Lime burning & slaking | Stone | Cross-category hub — feeds tanning, mortar, whitewash, plaster. GAP-STATE flagged; authors cleanly at coarse tick granularity. |
| 11 | Grain milling → flour → bread | Food | Gates staple carbohydrate loop; cheese/ale/porridge downstream. Clean engine fit. |
| 12 | Salt production (solar + boil) | Food/Stone | Salt consumed by six chains. Solar needs GAP-ENV workaround; boil variant clean today. |

**Deliberately excluded despite high value:** Woad vat, cheese-cave aging, glass blowing — all
need GAP-STATE engine work first. Lost-wax casting — needs GAP-CONSUMED-STATION or accept a
lossy workaround.

---

## 9. Chains blocked by engine work

Chains that cannot be authored well without closing specific gaps first.

| Chain | Blocking gap(s) | One-line reason |
|---|---|---|
| Woad vat (blue dye) | GAP-STATE, GAP-PROCESS-PARAM | Vat is alive/dead/exhausted — the whole craft IS the state. |
| Glass blowing (free + crown) | GAP-STATE, GAP-CHECKPOINT | Continuous-hot furnace; worker takes many gathers per melt. Atomic recipe is wrong shape. |
| Glass batch melting | GAP-STATE | Furnace IS the station, not the recipe. |
| Cheese/wine/mead aging | GAP-ENV, GAP-CHECKPOINT | Cool-humid cellar + peak-window harvesting are the gameplay. |
| Stockfish (air-dried cod) | GAP-ENV | Pure biome-gated: cold-dry coastal wind, nothing else. |
| Solar salt pans | GAP-ENV | Sun + wind + coast; producing in rain is flavour-breaking. |
| Lost-wax casting | GAP-CONSUMED-STATION | Shell IS the station and is destroyed on pour. |
| Saltpeter nitre-bed | GAP-STATE | Bed matures over days producing feedstock; no buffer+timer captures this. |
| Tanning pit (full scale) | GAP-BATCH, GAP-STATE | Real pits hold 20–100 hides migrating between liquor strengths. |
| Verdigris / lead-white | GAP-ENV, GAP-STATE | Vinegar-fume chambers and composting warmth aren't stations today. |
| Nail-heading (batch) | GAP-BATCH | 200 nails one-swing-each is unplayable; batched inputs lose the rhythm. |
| Coopering (toasting step) | GAP-STATE | Toasting is an ongoing fire on the station, not an input item. |

---

## 10. Open questions / redundancy flags

**Duplicate chain coverage across files — lead decision needed:**

- **Hide glue** — authored fully in *both* Chemistry and Leather with near-identical content.
  **Recommend Leather as canonical** (byproduct consumer of tanning waste).
- **Salt production** — Food authors all three variants; Stone also authors solar + brine-boil.
  **Recommend Food as canonical** (salt is a preservative consumer); Stone keeps short
  mineral-extraction cross-refs.

**Already resolved (noted for record):**

- **Birch tar** — Wood authors, Chemistry cross-references. Clean.
- **Vinegar** — Food authors, Chemistry defers. Clean.
- **Dyeing** — Chemistry authors, Textiles defers. Clean.
- **Lime → slaked lime** — Stone authors, Leather consumes. Clean.

**Chains to re-scope:**

- **Saltpeter** (Chemistry) — authored with speculative "fire-magic reagent" downstream. Lead
  should confirm a consumer exists or drop.
- **Aqua vitae** (Chemistry) — matters only if alchemy gameplay materialises. Soft-flag.

**Verb/station consolidations to commit to (naming-level decisions):**

- `cauldron` vs `kettle` vs `glue_pot` vs `tinning_pot` vs `soap_cauldron` vs `tarring_pot` —
  **one station. Pick `cauldron`.**
- `mortar` / `mortar_and_pestle` / `grinding_bench` / `bark_mill` — **one station. Pick
  `mortar_and_pestle`.**
- `leach_barrel` / `ash_hopper` / `ash_boiler` — **one station. Pick `ash_hopper`.**
- `cellar` / `wine_cellar` / `cheese_cave` — **one parameterised station. Lead sign-off.
  Saves ~30% aged-goods authoring.**
- Verbs `strike` / `hammer` — pick `hammer`.
- `chopping_block`, `campfire`, `workbench`, `forge`, `anvil` already exist in Voxim; category
  files treat them as anchors correctly.

---

**Ticket T-116 Phase 3 status:** complete. Phase 4 (content-authoring decisions + engine-change
decisions) is a separate ticket, to be opened after the project lead reviews this document.
