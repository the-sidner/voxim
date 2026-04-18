# Stone & Mineral Processing

**Scope & gameplay role.** Stone and mineral processing is the backbone of pre-industrial
construction, tool maintenance, food preservation, leather making, dyeing, and chemistry.
Voxim already has raw `stone` as a terrain-dug primitive and `stone_block` / `stone_pickaxe` /
`stone_shovel` as trivial one-shot recipes. This category picks up where those stop: multi-step
quarrying, graded masonry finishing, millstone dressing for food chains, and the *chemical*
transformations of non-metallic minerals (lime, gypsum, salt, alum, flint) that feed almost
every other category. The archetypes served are builders (blocks, mortar, millstones),
homesteaders (salt, whetstones, fire-starting flint), and specialist chemists
(quicklime, alum, saltpeter precursors).

**Chains documented.**

- **Fire-set quarrying** — thermal-shock rock face, split raw blocks with wedge-and-feathers.
- **Graded stone dressing** — raw block → rough-hewn → finished smooth block via chisel passes.
- **Sand-sawing marble** — toothless blade + water + abrasive sand cuts prestige stone.
- **Millstone dressing** — quartzite disc → furrowed millstone pair for grain milling.
- **Lime burning and slaking** — limestone → quicklime → slaked lime paste. THE foundational
  medieval chemical transformation.
- **Gypsum / plaster of Paris** — low-temp burn, fast-setting cast plaster.
- **Hydraulic (pozzolanic) mortar** — slaked lime + fired clay / volcanic ash → waterproof bind.
- **Solar salt pans** — sea water → crystallised salt via sun-and-wind evaporation.
- **Brine-well salt boiling** — saline spring → boiled in lead/iron pan → hearth salt.
- **Flint knapping** — nodule → flakes → strike-a-light / edge tool via attack swings.
- **Whetstone dressing** — quarried sandstone → flat hone for tool sharpening upkeep.

Eleven chains total. Rock-salt mining, alum, ochre, natron, and pumice are documented as
variants / cross-reference pointers rather than full chains (they bleed into chemistry,
dyes, ceramics-glass, and leather categories).

---

## Chain: Fire-set quarrying

**Real-world context.** Before gunpowder (~14C introduction, mainstream late 16C), quarrymen
extracted hard rock by fire-setting: stack brushwood against the rock face, burn it hot for
hours, then douse with water. Differential thermal expansion cracks the surface 5–20 cm deep.
Crews followed up with wedge-and-feathers — iron feathers slipped into drilled holes along a
desired split line, then a central wedge struck in turn until the block popped free. Used
in Egypt, throughout the Roman empire, in medieval silver and iron mines at Kutná Hora and
Rammelsberg.

**Gameplay role.** Produces `raw_stone_block` — the feedstock for the dressing chain below,
for millstones, and for high-quality construction. A step above terrain-dug `stone` rubble:
coherent, dimensioned, non-primitive. Gates mid/late-game masonry.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | brushwood ×4 | axe | — | Resource node |
| 2 | apply-high-heat + quench | rock_face | brushwood ×4, water ×2 | fractured_face ×1 | — | 600 | `stepType: time`; the distinctive "stack fire, walk away, douse" cycle |
| 3 | drill | rock_face | fractured_face ×1, iron_feather ×4 | plugged_face ×1 | hammer, chisel | 0 | `stepType: attack`; placing the split line |
| 4 | split | rock_face | plugged_face ×1 | raw_stone_block ×1, stone_chips ×2 | hammer | 0 | `stepType: attack` |

**Primitive verbs exercised:** apply-high-heat, quench, drill, split.

**Workstations introduced:** `rock_face` — a deployable workstation placed against exposed
bedrock (likely produced by terrain scan + tool-placement). Distinct from generic chopping_block
in that it's positional / not relocatable once placed.

**Byproducts and their fate:** `stone_chips` → aggregate for pozzolanic mortar, for road fill,
or can be crushed further for temper in clay mixing (cross-ref ceramics).

**Knowledge gating:** `lore_fire_setting` — quarrymaster lore fragment.

**Engine gaps exposed:**
- `GAP-PROCESS-PARAM` — the fire-then-water sequence really wants a two-phase recipe where
  temperature rises during phase A and then the player triggers quench. Workaround via two
  chained recipes is clean though (fire runs on timer, second recipe requires water input).
- `GAP-ENV` — needs brush-accessible dry weather; real fire-setting failed in rain.
- New gap: **GAP-DANGER-INPUT** — quenching a hot rock throws steam + spalls; the recipe
  should optionally hurt bystanders. Same tag will recur on lime slaking.

**Variants worth noting:** pre-gunpowder silver/copper miners used the same technique
underground, inhaling the smoke. In soft sedimentary stone (tuff, limestone) fire-setting was
skipped in favour of straight pick-and-wedge — that's the trivial "quarry rubble" path Voxim
already supports via terrain digging.

---

## Chain: Graded stone dressing

**Real-world context.** A Roman or medieval cathedral stoneyard received raw blocks and put
them through a fixed sequence of chisels: the *point* (pointed punch) knocked off gross mass,
then the *claw chisel* (multi-toothed) regularised the surface, then a *flat chisel* and
*boaster* took it to a smooth face. Masons' marks identified each worker's yield. The same
block could be stopped at any grade depending on its destination (foundation rubble vs nave
ashlar).

**Gameplay role.** Produces a ladder of construction materials: `rough_block` (cheap walls,
fortification), `dressed_block` (civic buildings, workstations needing flat surfaces),
`ashlar_block` (prestige builds, altars, lordly keeps). Connects directly to the building
system — different grades unlock different prefab structures.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | chisel (point) | mason_bench | raw_stone_block ×1 | rough_block ×1, stone_chips ×1 | point_chisel, mallet | 0 | `stepType: attack` |
| 2 | chisel (claw) | mason_bench | rough_block ×1 | dressed_block ×1, stone_dust ×1 | claw_chisel, mallet | 0 | `stepType: attack`; `chainNextRecipeId: chisel_flat` optional |
| 3 | chisel (flat) | mason_bench | dressed_block ×1 | ashlar_block ×1, stone_dust ×1 | flat_chisel, mallet | 0 | `stepType: attack` |

**Primitive verbs exercised:** chisel, strike.

**Workstations introduced:** `mason_bench` — a heavy timber banker with a stone top for
steady chiselling. Prefab file drop.

**Byproducts and their fate:** `stone_chips` → aggregate / pozzolan filler. `stone_dust` →
pozzolanic additive for mortar, abrasive for metal polishing, temper in daub.

**Knowledge gating:** none for rough/dressed; `lore_ashlar_finishing` for the final grade.

**Engine gaps exposed:**
- `GAP-QUALITY` — real masons produced visibly better or worse faces; the binary lore gate
  doesn't let a "journeyman" ashlar differ from a "master" ashlar.
- `GAP-DURABILITY` — chisels wear fast on hard stone; real crews re-forged points daily.
  This is the cleanest pure-`GAP-DURABILITY` chain in the category.

**Variants worth noting:** rustication (deliberately rough face), moulded profiles (ogee,
cavetto) for cornices — omitted as ornamental variants of the same base chain.

---

## Chain: Sand-sawing marble

**Real-world context.** Romans and medieval Italian workshops cut marble and prestige stones
with a toothless iron or bronze blade. Two sawyers worked it back and forth while water and
quartz sand were poured into the kerf; the sand did the cutting, the blade just carried it.
Hugely slow — a single slab could take days — but capable of producing large flat sheets
from otherwise unworkable blocks. Described by Pliny; water-powered versions at the 6C
Hierapolis sawmill.

**Gameplay role.** Produces `marble_slab` / `polished_slab` for altars, prestige flooring,
and tomb markers — high-value trade goods, limited building utility but strong status role.
A slow luxury chain suited to NPC labour offloading.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | quartz_sand ×2 | shovel | — | River/beach node |
| 2 | saw (abrasive) | sand_saw_frame | marble_block ×1, quartz_sand ×2, water ×1, saw_blade ×1 | marble_slab ×1, marble_sludge ×1 | — | 1600 | `stepType: time`; the distinctive "cut by feeding slurry" idea |
| 3 | grind (polish) | mason_bench | marble_slab ×1, stone_dust ×1, water ×1 | polished_slab ×1 | — | 400 | `stepType: time` |

**Primitive verbs exercised:** saw, grind.

**Workstations introduced:** `sand_saw_frame` — a two-person trestle with a held blade, fed
by a sand/water hopper. Needs two occupants in principle; single-occupant in current engine.

**Byproducts and their fate:** `marble_sludge` → whitewash pigment, fine polishing powder
(feeds metal finishing).

**Knowledge gating:** `lore_sand_sawing`.

**Engine gaps exposed:**
- **GAP-MULTI-OPERATOR** — the historical technique genuinely needs two workers on opposite
  ends of the saw. Voxim has no co-occupied workstation model. Workaround: pretend a single
  NPC can do it, losing flavour.
- `GAP-PROCESS-PARAM` — too little sand or water stalls; too much wastes. Expressed today as
  a fixed recipe input quantity, flavour lost.

**Variants worth noting:** water-powered sand saw (Hierapolis) is the proto-mechanised
version. Flag for a later chain tied to the waterwheel / mill-race workstation.

---

## Chain: Millstone dressing

**Real-world context.** Millstones were cut from specific hard stones — French "burr"
millstone quartzite, German basalt lava (Mayen), English Peak District gritstone — then
*dressed* with a series of radial and chord-wise furrows separating flat "lands". The pattern
funnels grain from centre to rim while shearing it against the upper stone. A working pair
(runner + bedstone) needed re-dressing every few months with a *mill bill* — a pointed hammer.

**Gameplay role.** Produces `millstone_pair`, deployable as the `grain_mill` workstation
which enables the flour / bread / beer / pottage chains (all food-category). One of the
highest-value intermediate goods in the economy.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | millstone_quartzite ×2 | pickaxe | — | Rare resource node — specific biome gated |
| 2 | chisel (shape) | mason_bench | millstone_quartzite ×1 | millstone_blank ×1, stone_chips ×2 | point_chisel, mallet | 600 | `stepType: time`; rough disc |
| 3 | chisel (dress furrows) | mason_bench | millstone_blank ×1 | millstone ×1, stone_dust ×1 | mill_bill, mallet | 400 | `stepType: attack`; the distinctive "furrows and lands" pattern |
| 4 | assemble | mason_bench | millstone ×2, iron_spindle ×1 | millstone_pair ×1 | hammer | 0 | `stepType: assembly`; pairs runner + bedstone |

**Primitive verbs exercised:** chisel, shape, assemble.

**Workstations introduced:** `grain_mill` (downstream, produced by deploying a
`millstone_pair`). The `mason_bench` is reused from the dressing chain.

**Byproducts and their fate:** `stone_chips`, `stone_dust` as above. Spent millstones
(after too many re-dressings, stones went thin and broke) → building rubble; not modelled
here as millstones are effectively durable.

**Knowledge gating:** `lore_millwright` — rare fragment, gates the entire flour/bread/beer
progression.

**Engine gaps exposed:**
- `GAP-DURABILITY` — mill bills wore down fast; re-dressing was a maintenance chore.
- New gap: **GAP-DEPLOY-STATION** — chain output is *itself* a workstation. Currently
  workstations are placed from prefab, not produced from recipes + deployment. Workaround
  via a "deployable item" category.

**Variants worth noting:** saddle quern, rotary hand quern — simpler, smaller, peasant-scale.
Could be a one-step recipe "carve quern from raw_stone_block" without the millstone chain's
furrow complexity.

---

## Chain: Lime burning and slaking

**Real-world context.** THE foundational chemical transformation of medieval construction.
Limestone (CaCO₃) heated above ~825 °C drives off CO₂ and leaves quicklime (CaO). This is a
multi-day burn in a wood or charcoal-fired lime kiln — typically 3–5 days at full heat with
constant stoking. Quicklime is caustic and hygroscopic; it must be slaked by adding water,
which reacts violently, boils, and yields calcium hydroxide (slaked lime / Ca(OH)₂) as a
paste. Slaked lime is the binder for mortar, plaster, whitewash, lime mortar grout, *and*
the dehairing agent for leather tanning. The steam and heat of slaking killed workers who
got it wrong.

**Gameplay role.** Produces `quicklime`, `slaked_lime_paste`, and ultimately `lime_mortar` —
the standard bind for any masonry above rubble grade; also `whitewash` (decor) and a
critical input to the leather dehairing chain (cross-ref hides). This is *the*
cross-category nexus of the entire crafting graph.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | limestone ×6 | pickaxe | — | Specific biome resource node |
| 2 | apply-high-heat + combust | lime_kiln | limestone ×6, firewood ×8 | quicklime ×4, kiln_ash ×1 | — | 2000 | `stepType: time`; the 3–5 day burn compressed |
| 3 | slake | slaking_pit | quicklime ×1, water ×2 | slaked_lime_paste ×1 | — | 200 | `stepType: time`; violent exothermic reaction — see gap notes |
| 4 | mix | mortar_trough | slaked_lime_paste ×1, sand ×2 | lime_mortar ×1 | trowel | 0 | `stepType: attack`; `chainNextRecipeId` optional from step 3 |

**Primitive verbs exercised:** apply-high-heat, combust, slake, mix.

**Workstations introduced:** `lime_kiln` (shaft or flare kiln, fuel-hungry); `slaking_pit`
(shallow lined pit or tub); `mortar_trough` (simple mixing box, could alias mason_bench).

**Byproducts and their fate:** `kiln_ash` → lye-making precursor (cross-ref chemistry /
soapmaking). `slaked_lime_paste` itself is a branching input: → mortar, → whitewash,
→ leather-dehair (cross-ref hides), → tanning alkali bath, → plaster base.

**Knowledge gating:** `lore_lime_burning` — widely known craftsman lore.

**Engine gaps exposed:**
- `GAP-STATE` — the *showcase* case. A lime kiln has to be lit, maintained at temperature
  for days, stoked at intervals, then allowed to cool before it can be unloaded. Single
  `stepType: time` with a fuel input as just another ingredient elides the "stoke the fire"
  interactivity entirely.
- `GAP-BATCH` — real kilns took tons of limestone per burn; scaling output quantity is the
  obvious workaround but breaks NPC labour-time assumptions.
- `GAP-PROCESS-PARAM` — under-burnt limestone (core unreacted) vs over-burnt (glassy,
  unreactive) vs ideal soft-burn. No continuous temperature / duration axis.
- **GAP-DANGER-INPUT** (reused) — slaking quicklime with water is the canonical "wrong input
  burns the crafter" case. Boiling water spits, vapour scalds. Recipe system has no
  danger side-effects on the crafter.
- `GAP-ENV` — kiln needs weather protection; slaking pit needs outdoor ventilation.

**Variants worth noting:** flare kiln (draw kiln, continuous feed), clamp (single-use pile
burn), draw kiln (continuous production for industrial scale). Medieval practice was
predominantly flare-kiln; compressing all into a single "lime_kiln" station is fine.

---

## Chain: Gypsum burning (plaster of Paris)

**Real-world context.** Gypsum (CaSO₄·2H₂O) burnt at a much lower temperature (~150 °C) loses
three-quarters of its water, yielding the hemihydrate (plaster of Paris). Mixed with water
it re-hydrates and sets in minutes — far faster than lime mortar. Used extensively in Paris
basin for interior plaster and mouldings (hence the name) from the Roman period on; the
low-temperature burn made it cheap and accessible.

**Gameplay role.** Produces `plaster` — fast-setting cast material for interior walls,
decorative mouldings, and as a lost-mould substrate for metal casting (cross-ref metalwork).
Contrasts lime mortar (slow, strong, load-bearing) with plaster (fast, weak, decorative).

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | gypsum ×4 | pickaxe | — | Evaporite-biome resource node |
| 2 | apply-heat | pottery_kiln | gypsum ×4, firewood ×2 | hemihydrate ×4 | — | 800 | `stepType: time`; reuses low-temp ceramics kiln |
| 3 | mix | mortar_trough | hemihydrate ×1, water ×1 | plaster_paste ×1 | trowel | 0 | `stepType: attack`; sets on timer after pour |
| 4 | cure (set) | casting_frame | plaster_paste ×1 | plaster_panel ×1 | — | 100 | `stepType: time`; fast set |

**Primitive verbs exercised:** apply-heat, mix, cure.

**Workstations introduced:** reuses `pottery_kiln` (low-temp variant of ceramics kiln) and
`mortar_trough` / `casting_frame`. No net-new station.

**Byproducts and their fate:** none material; trivial dust loss.

**Knowledge gating:** `lore_plaster` — common.

**Engine gaps exposed:**
- `GAP-PROCESS-PARAM` — over-burnt gypsum (dehydrated anhydrite) is inert. Same kiln
  temperature gap as lime.
- Minor `GAP-STATE` — but the kiln burn is shorter so the stoke-interactivity loss is less
  painful than lime.

**Variants worth noting:** alabaster (dense gypsum) carved raw for ornamental pieces is a
parallel chain that skips the burn entirely — one-shot chisel recipe.

---

## Chain: Hydraulic (pozzolanic) mortar

**Real-world context.** Romans discovered that adding volcanic ash from Pozzuoli (pulvis
puteolanus) to slaked lime produced a mortar that set *underwater* and grew stronger over
decades — the chemistry is calcium silicate hydrate formation, the same as modern Portland
cement. Medieval builders kept the technique using crushed fired-brick dust or trass
(volcanic tuff) when pozzolana wasn't local. Essential for harbours, cisterns, aqueducts.

**Gameplay role.** Produces `hydraulic_mortar` — gates waterworks: cisterns, well-linings,
bridge footings, harbours. A strict upgrade over lime mortar for anything near water.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather (pozzolan) | — | — | volcanic_ash ×2 OR fired_brick ×2 | shovel | — | Biome-specific or cross-ref ceramics |
| 2 | crush (if brick) | mortar_and_pestle | fired_brick ×1 | brick_dust ×1 | hammer | 0 | `stepType: attack`; skip if volcanic_ash |
| 3 | mix | mortar_trough | slaked_lime_paste ×1, pozzolan ×1, sand ×1 | hydraulic_mortar ×1 | trowel | 0 | `stepType: attack`; `inputs[].alternates` covers ash-or-brick-dust |

**Primitive verbs exercised:** crush, mix.

**Workstations introduced:** `mortar_and_pestle` — small-scale crushing station. Reused
across alchemy, pigments, spice.

**Byproducts and their fate:** none.

**Knowledge gating:** `lore_hydraulic_mortar` — rare; Roman-era engineering heritage.

**Engine gaps exposed:**
- None unique to this chain. Cleanly fits the recipe model thanks to `inputs[].alternates`
  handling "any pozzolan".

**Variants worth noting:** *opus signinum* (crushed terracotta in lime) vs *opus
caementicium* (rubble-core concrete) vs *trass mortar* (volcanic tuff binder) are all
regional variants of the same chain; handled by alternates.

---

## Chain: Solar salt pans

**Real-world context.** Mediterranean and Atlantic coasts ran sea-water through graded
evaporation ponds: reservoir → concentrator → crystalliser. Wind and sun drove the water
off over weeks; workers raked coarse salt off the crystalliser floor. The Guérande
(Brittany) and Trapani (Sicily) salt flats are direct medieval continuations. Labour-light
but weather-dependent.

**Gameplay role.** Produces `sea_salt` — the dominant food preservative in the game economy.
Cross-refs to meat-curing, cheese-making, leather-brining.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | sea_water ×4 | bucket | — | Coastal node |
| 2 | evaporate (solar) | salt_pan | sea_water ×4 | brine_concentrate ×1 | — | 1200 | `stepType: time`; requires sun + wind |
| 3 | evaporate (solar) | salt_pan | brine_concentrate ×1 | sea_salt ×2, bittern ×1 | rake | 800 | `stepType: time`; `chainNextRecipeId` from step 2 |

**Primitive verbs exercised:** evaporate.

**Workstations introduced:** `salt_pan` — shallow clay-lined basin. Terrain-placed, outdoor
only.

**Byproducts and their fate:** `bittern` (magnesium-rich brine residue) → coagulant for tofu
in cross-ref Asian food chains; pigment mordant; discarded in Voxim default.

**Knowledge gating:** none; universal coastal knowledge.

**Engine gaps exposed:**
- `GAP-ENV` — the canonical sun + wind + dry-weather case. Without env gating the salt pan
  produces in rain, which is flavour-breaking.
- `GAP-STATE` — pans stage in sequence (reservoir → concentrator → crystalliser) in reality;
  the chainNextRecipeId model compresses this acceptably but loses the spatial flow.

**Variants worth noting:** *sel gris* (grey salt, bottom-rake) vs *fleur de sel* (fine surface-
skim) are grade variants — `GAP-QUALITY` territory.

---

## Chain: Brine-well salt boiling

**Real-world context.** Inland salt came from brine springs or deep wells (Germany's Halle,
Lüneburg, Reichenhall; Austria's Salzkammergut; Cheshire's Northwich; France's Salins) where
saturated saline was pumped or hauled up and boiled in enormous shallow *saltpans* made of
lead, then iron, over sustained wood fires. The fuel demand was so large that whole forests
were felled specifically for salt-making — "saltern" woodland management is a medieval
ecological fingerprint.

**Gameplay role.** Same output (`hearth_salt`) as solar pans, different inputs and context.
Inland civilizations, heavy fuel consumption, weather-independent.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | brine ×4 | bucket | — | Brine-well resource node (rare) |
| 2 | apply-heat + combust | saltern_hearth | brine ×4, firewood ×6 | hearth_salt ×2, brine_scale ×1 | — | 1400 | `stepType: time`; continuous stoking |

**Primitive verbs exercised:** apply-heat, combust, evaporate.

**Workstations introduced:** `saltern_hearth` — a sheltered brick hearth with shallow iron
or lead pan.

**Byproducts and their fate:** `brine_scale` (gypsum/calcium sulfate crust from the pan
bottom) → discarded, could feed gypsum-burning chain.

**Knowledge gating:** `lore_saltern` — tied to specific trade guilds historically; viable
gate for a rich economic specialisation.

**Engine gaps exposed:**
- `GAP-STATE` — same "stoke the fire for hours" pattern as lime kiln.
- `GAP-BATCH` — historical salterns ran multi-ton pans. Scaling is a palatable workaround.

**Variants worth noting:** rock salt mining (Wieliczka, Hallstatt) is a *third* same-output
chain — mine → haul → crush → trade. Trivial as a recipe (primitive resource + crush)
so not documented fully; flag as a distinct biome gate.

---

## Chain: Flint knapping

**Real-world context.** Flint nodules from chalk deposits were reduced by percussion flaking
— a hammerstone strike drives a flake off along a conchoidal fracture. Medieval use outlived
the stone age: flint-and-steel strike-a-lights (pre-ferrocerium), sickle-teeth inlays,
ornamental gun-flints (later), and barn *threshing floor* embedding. Pressure-flaking with
an antler tine put fine edges on smaller tools. Voxim has `flint.json` as an item already.

**Gameplay role.** Produces `flint_flake` (fire-starter component), `flint_edge` (crude
cutting insert), `flint_threshing_stone` (late-chain, for threshing floor prefab).
Low-tier, always-accessible backup tooling; critical for the `fire_starter` consumable.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | flint_nodule ×1 | pickaxe | — | Existing `flint` item is this |
| 2 | strike (reduce) | knapping_stump | flint_nodule ×1 | flint_core ×1, flint_flake ×3, flint_shatter ×1 | hammerstone | 0 | `stepType: attack` |
| 3 | strike (pressure) | knapping_stump | flint_flake ×1 | flint_edge ×1, flint_shatter ×1 | antler_tine | 0 | `stepType: attack` |

**Primitive verbs exercised:** strike, knap.

**Workstations introduced:** `knapping_stump` — a sitting-log with a leather pad. Trivial
prefab.

**Byproducts and their fate:** `flint_shatter` (unusable small chips) → discarded; could
feed the threshing-floor aggregate. `flint_core` → secondary strike source.

**Knowledge gating:** none.

**Engine gaps exposed:**
- `GAP-QUALITY` — knapping is *highly* skill-dependent; beginners shatter nodules. Flat
  recipe output doesn't capture this.
- `GAP-SKILLED-YIELD` — expert knapper gets 5 good flakes per nodule; novice gets 1 and
  three shatters. Same core gap in a different flavour.

**Variants worth noting:** obsidian knapping (same chain, different biome-gated resource,
sharper edges); chert, jasper as flint substitutes via `inputs[].alternates`.

---

## Chain: Whetstone dressing

**Real-world context.** Sharpening stones came from specific quarries: Welsh slate, Arkansas
novaculite, Belgian coticule, Scandinavian Eidsborg schist. Blocks were sawn to rectangular
bars and lapped flat against a coarser stone. Medieval smiths kept a graded pair (coarse +
fine) on every forge; peasants carried pocket whetstones on belt-loops for sickle upkeep.

**Gameplay role.** Produces `whetstone` — a consumable / semi-durable tool used to restore
edge durability on bladed weapons and tools. Slots directly into the GAP-DURABILITY story
as a *maintenance* input: sharpening stops blades from degrading. Frequent low-value craft.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | whetstone_blank ×1 | pickaxe | — | Specific quartzite / novaculite node |
| 2 | saw | mason_bench | whetstone_blank ×1 | whetstone_bar ×2, stone_dust ×1 | saw_blade | 200 | `stepType: time` |
| 3 | grind (lap flat) | mason_bench | whetstone_bar ×1, coarse_grit ×1 | whetstone ×1, stone_dust ×1 | — | 100 | `stepType: time` |

**Primitive verbs exercised:** saw, grind.

**Workstations introduced:** reuses `mason_bench`.

**Byproducts and their fate:** `stone_dust` → abrasive polishing powder (feeds metal
finishing, sand-saw polish).

**Knowledge gating:** none.

**Engine gaps exposed:**
- `GAP-DURABILITY` — this chain's output is *specifically* a durability-maintenance
  consumable. The gap is both exposed here (the whetstone itself wears) and referenced
  (the tools it sharpens don't currently wear).

**Variants worth noting:** round grindstone (wheel) is the same chain with a rotating prefab
at the end — a powered workstation akin to `grain_mill`.

---

## Variants and minor chains

- **Rock salt mining.** Wieliczka / Hallstatt / Berchtesgaden. Resource node + primitive +
  one crush recipe. Same output as solar / brine salt via alternates. Documented as a
  resource-node flavour not a chain.
- **Alum processing.** Alunite schist → roast → leach → crystallise. Full chain, but cleanly
  belongs in the chemistry / dyes category as an astringent mordant; flag here for the
  quarry + roast steps which overlap lime burning.
- **Natron / trona.** Evaporite deposits used as glass flux and as a body-preserving salt
  (Egyptian). Cross-ref to the ceramics-glass category.
- **Ochre and earth pigments.** Red, yellow, umber ochres quarried from oxidised clay beds,
  sometimes roasted to intensify colour. Extraction is a one-step dig; the processing
  (wash → levigate → dry → burn-to-sienna) belongs in the pigments / paint chain.
- **Pumice and abrasive stone.** Pumice lump → dressed block. Used for leather finishing,
  parchment smoothing, bronze polishing. One-step recipe per grade; not a full chain.
- **Saltpeter gathering.** Nitre-beds scraped from stable / privy walls, leached, crystallised.
  Chemistry category — it's a biological-accumulation process not a mineral-extraction one.
- **Coal mining / peat cutting.** Present as resource primitives (`coal.json` exists). Peat
  cutting → drying is a two-step fuel chain handled under fuel / thermal, not here.
- **Ceramic-grade clay digging, kaolin washing.** Clay exists as an item; the levigation
  (sediment fractionation) chain is ceramics-category.

---

## Category summary

- **Verbs used:** gather, apply-heat, apply-high-heat, combust, quench, slake, chisel,
  strike, knap, split, drill, saw, grind, crush, mix, evaporate, cure, assemble.
  *New proposed verbs:* `slake` (specific violent-hydration reaction — worth its own tag
  for GAP-DANGER-INPUT gating), `knap` (specialisation of strike for brittle-flake
  reduction), `evaporate` (distinct from apply-heat in that the goal is water loss, not
  thermal transformation).
- **Workstations introduced:** `rock_face`, `mason_bench`, `sand_saw_frame`, `lime_kiln`,
  `slaking_pit`, `mortar_trough`, `casting_frame`, `salt_pan`, `saltern_hearth`,
  `knapping_stump`, `mortar_and_pestle`, plus downstream deployable `grain_mill`. Shared
  with other categories: `pottery_kiln` (ceramics), `mortar_and_pestle` (alchemy, pigments),
  `mason_bench` (multi-purpose masonry bench).
- **Primitives consumed:** `stone` (existing), `limestone`, `gypsum`, `millstone_quartzite`,
  `marble_block`, `flint_nodule` (existing as `flint`), `whetstone_blank`, `sea_water`,
  `brine`, `volcanic_ash`, `quartz_sand`, `brushwood`, `firewood`, `water`, `iron_feather`
  (from metalwork), `saw_blade` (from metalwork), `iron_spindle` (from metalwork),
  `antler_tine` (from bone/hides), `hammerstone`. Demonstrates how thoroughly stone/mineral
  work depends on *metalwork* delivering iron tooling.
- **Byproducts exported:** `stone_chips` → mortar aggregate, road fill; `stone_dust` →
  abrasive polish, pozzolan filler, daub temper; `kiln_ash` → lye (chemistry / soap);
  `marble_sludge` → whitewash pigment, polishing compound; `slaked_lime_paste` →
  **leather dehairing** (critical hides/tanning link), whitewash, tanning alkali, plaster
  base, mortar; `brine_scale` → gypsum feedback; `bittern` → tofu coagulant, pigment mordant;
  `flint_shatter` → aggregate; `flint_flake` → **fire-starting** consumable; `whetstone` →
  **tool maintenance consumable** (durability upkeep); `sea_salt` / `hearth_salt` → **food
  preservation** (meat curing, cheese, fish); `millstone_pair` → **grain milling** unlocks
  whole food category.
- **Top engine gaps:**
  - **GAP-STATE** (lime kiln, saltern hearth, fire-set quarrying) — the canonical
    showcase. Multi-day fuelled burns want a station that holds "lit?", "fuel left?",
    "temperature?" beyond the inert buffer model. Most-frequent gap in this category;
    recurs in every thermal chain.
  - **GAP-ENV** (salt pans, lime kiln shelter, fire-setting dryness) — environmental
    prerequisites. Second-most-frequent.
  - **GAP-PROCESS-PARAM** (fire-setting thermal shock, lime burn quality, marble sand-saw
    feed rate, gypsum over-burn) — continuous parameters. Kiln-heavy chains want a
    temperature axis.
  - **GAP-DURABILITY** (mason chisels, mill bills, whetstones themselves, sawblades) —
    the entire category revolves around tools-on-stone, and stone wins every time. This
    category is probably the strongest argument for closing GAP-DURABILITY.
  - **New: GAP-DANGER-INPUT** (lime slaking, fire-set quench) — recipes that *hurt the
    crafter* when run, or that hurt bystanders. Distinct from GAP-PROCESS-PARAM because
    it's a discrete safety outcome, not a quality dial.
  - **New: GAP-MULTI-OPERATOR** (sand-sawing marble) — workstations that genuinely want
    two simultaneous occupants. Minor frequency but categorical.
  - **New: GAP-DEPLOY-STATION** (millstone pair → grain_mill) — chains whose output is
    itself a workstation, needing a deployable intermediate item. Overlaps with
    ItemTemplate.deploysTo which Phase 4 metalwork/building work already touches.
