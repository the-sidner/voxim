# Food & Preservation

**Scope & gameplay role.** Pre-industrial food production is overwhelmingly about *preservation*:
fresh meat, milk, fish, and produce spoil in days, so the entire category exists to convert
perishable surplus into calorie-dense, shelf-stable, and tradeable goods. This category feeds
every other loop: hunger and thirst consumables for survival, staple trade goods (salt, grain,
cheese, ale, oil, stockfish) for the economy, and high-status luxuries (wine, aged cheese, mead)
for progression. It serves the homesteader (daily bread, butter, pickles), the specialist (the
miller, brewer, cheesemaker, salter), and the trader (preserved goods move well). Voxim already
has trivial campfire cooking (`cooked_meat`, `cooked_mushroom`); everything here extends *beyond*
the immediate-meal layer into the stored-food layer.

**Chains documented.**

- **Grain processing** — harvest → thresh → winnow → mill (three workstation tiers) → flour.
- **Bread baking** — flour + leaven → knead → proof (rise) → bake → loaf.
- **Malting** — grain → soak → germinate → kiln-arrest → malt.
- **Ale brewing** — malt → mash → boil (w/ hops) → cool → pitch yeast → ferment → ale.
- **Wine** — grapes → crush/tread → ferment on skins → press → barrel-age → wine.
- **Mead** — honey + water → pitch yeast → ferment → mead.
- **Cheese** — milk → renneting → curd cut → whey drain → press → salt → age.
- **Butter & buttermilk** — cream → churn → butter + buttermilk.
- **Salt-cured meat** — meat + salt → dry-rub or brine → draw moisture → cured pork/beef.
- **Cold-smoked fish** — split + brine → air-dry pellicle → cold-smoke (days) → smoked fish.
- **Stockfish** — split cod → air-dry on racks → stockfish (months of shelf life).
- **Lacto-pickling** — cabbage + salt → pack in crock → lactic ferment → sauerkraut.
- **Oil pressing** — olives/nuts → crush → press → oil + oil cake.
- **Salt production** — seawater solar pans OR brine-well boiling → salt.

---

## Chain: Grain processing (threshing → milling)

**Real-world context.** Every grain-eating culture from Egypt onward separated kernel from ear
and hull before grinding to flour. The threshing floor (flail and oxen) and winnowing fork were
near-universal; milling tech, however, tiers dramatically — saddle quern (Neolithic), rotary
hand quern (Iron Age, still in medieval households), water-mill (Roman, ubiquitous by 1100 CE),
windmill (late 12th c., where water was unavailable). Each tier is a distinct workstation.

**Gameplay role.** Flour is the gateway input for bread, porridge, and brewing precursor grist.
Grain is a primitive (gatherable/farm-harvested); the mill tier the player has access to gates
their bread economy. No current Voxim item.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | harvest | — | — | grain_sheaf ×N | sickle | — | Resource node |
| 2 | thresh | threshing_floor | grain_sheaf ×1 | raw_grain ×3, straw ×1 | flail | 60 | `stepType: attack` — repeated strikes |
| 3 | winnow | threshing_floor | raw_grain ×3 | cleaned_grain ×3, chaff ×1 | winnowing_fork | 40 | `stepType: time` — wind-dependent; `chainNextRecipeId` from step 2 |
| 4a | grind | hand_quern | cleaned_grain ×1 | flour ×1, bran ×0.2 | — | 200 | `stepType: attack` — slow, labour-intensive |
| 4b | grind | watermill | cleaned_grain ×5 | flour ×5, bran ×1 | — | 120 | `stepType: time` — batch, passive; requires adjacent running water |
| 4c | grind | windmill | cleaned_grain ×5 | flour ×5, bran ×1 | — | 120 | `stepType: time` — batch, passive; requires exposed site |

**Primitive verbs exercised:** thresh, winnow, grind.

**Workstations introduced:** `threshing_floor` (flat surface + flail target), `hand_quern`
(portable two-stone mill), `watermill` (river-sited), `windmill` (exposed-site). All four are new.

**Byproducts and their fate:** `straw` → thatching, bedding, pack-animal feed; `chaff` →
animal feed or compost; `bran` → animal feed, coarse porridge, or poor-man's bread.

**Knowledge gating:** hand quern freely known. Watermill and windmill gated behind
`lore_mill_engineering` — a specialist unlock.

**Engine gaps exposed:** `GAP-ENV` (windmill needs wind/open terrain; watermill needs river
adjacency; winnowing traditionally needs breeze), `GAP-BATCH` (watermill historically grinds
hundreds of kg continuously), `GAP-SKILLED-YIELD` (a good miller loses less to bran).

**Variants worth noting:** Saddle-quern is the primitive precursor to hand-quern; fold into
"hand_quern" tier. Oxen-driven horse mills fit between hand and water/wind — skip unless the
game models draft animals.

---

## Chain: Bread baking

**Real-world context.** Leavened bread appears in Egypt c. 3000 BCE and becomes the caloric
backbone of Europe/Near East by Roman times. Medieval bread is sourdough-leavened (wild yeast
starter refreshed indefinitely) or barm-leavened (skimmed from active ale fermentation — the
bread/beer economic link). Village ovens were often communal, fired hot then loaded as the
temperature fell through pizza → bread → pastry → drying stages.

**Gameplay role.** Staple consumable — high hunger restore, stacks, travels. Fills the
"carry-able meal" slot better than cooked meat (longer shelf life, plant-based supply chain).

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | combine | kneading_trough | flour ×2, water ×1, leaven ×0.5, salt ×0.1 | dough_raw ×1 | — | 40 | `stepType: time` — knead |
| 2 | proof | kneading_trough | dough_raw ×1 | dough_proofed ×1 | — | 200 | `stepType: time` — passive rise; `chainNextRecipeId` from step 1 |
| 3 | bake | bread_oven | dough_proofed ×1, firewood ×1 | bread_loaf ×1 | peel | 100 | `stepType: time` — oven must be pre-heated |

**Primitive verbs exercised:** knead, proof, bake.

**Workstations introduced:** `kneading_trough` (wooden bowl/table), `bread_oven` (masonry,
wood-fired, thermal-mass). Leaven (`sourdough_starter`) is a persistent consumable-that-regrows:
an item slot that refills over time from a small feed of flour.

**Byproducts and their fate:** Sourdough starter is self-regenerating — every bake reserves a
dollop. No hard byproducts beyond that.

**Knowledge gating:** `lore_bread` for the starter; unleavened flatbread could be the
starter-free fallback.

**Engine gaps exposed:** `GAP-STATE` (oven has pre-heat state; loading cold oven fails),
`GAP-CHECKPOINT` (overproofed dough collapses; the proof step wants a "peak window"),
`GAP-ENV` (warmth accelerates proofing — cold cellar won't rise).

**Variants worth noting:** Flatbread (no leaven, one step, skillet/stone bake). Rye/barley
bread — substitute flour alternate. Pastry and pies are downstream.

---

## Chain: Malting

**Real-world context.** Malting converts starch-rich grain into enzymatically-active,
sweet-tasting malt by germinating then arresting the sprout. Medieval maltsters soaked barley
in a stone cistern for two days, spread it on a malting floor for five to seven, then
kiln-dried it over a slow fire. The kiln's fuel (peat, wood, straw) flavours the malt — peated
whisky malt is the direct survival of this.

**Gameplay role.** Gate between farming and brewing. Malt is not eaten directly; it's the
input for the entire alcohol category. Authoring malting separately avoids bundling it into
every brew recipe.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | soak | steeping_cistern | cleaned_grain ×5, water ×5 | grain_steeped ×5 | — | 240 | `stepType: time` — 2 days compressed |
| 2 | germinate | malting_floor | grain_steeped ×5 | grain_green_malt ×5, rootlets ×1 | — | 480 | `stepType: time` — must be turned (flavour/verb only; mechanically passive) |
| 3 | kiln-dry | malt_kiln | grain_green_malt ×5, firewood ×2 | malt ×5 | — | 200 | `stepType: time` — arrests germination |

**Primitive verbs exercised:** soak, germinate, kiln-dry (new thermal verb: low, long heat).

**Workstations introduced:** `steeping_cistern` (stone trough, watertight), `malting_floor`
(broad flat covered surface), `malt_kiln` (indirect-heat dryer).

**Byproducts and their fate:** `rootlets` (sprout tails) — animal feed; historically sold as
cattle fodder.

**Knowledge gating:** `lore_malting` — a specialist unlock; without it, grain → malt is unavailable.

**Engine gaps exposed:** `GAP-ENV` (malting floor needs cool humid conditions; too hot and the
grain moulds), `GAP-STATE` (the kiln's flavour depends on fuel — peat-malt vs wood-malt is a
fuel-input distinction), `GAP-CHECKPOINT` (germination has a peak — undermalted grain lacks
enzymes, overmalted has consumed its own starch).

**Variants worth noting:** Pale vs dark malt is a single-parameter variant of kiln step.

---

## Chain: Ale / beer brewing

**Real-world context.** Ale (unhopped) and beer (hopped) are the staple hydration drink of
medieval Europe — water was often unsafe, small-beer was safe for children. Monastic
breweries industrialised the technique; by 1400, German brewers had pinned down hops as a
preservative that extended shelf life from days to months. The process: crushed malt is
mashed in hot water to convert starches to fermentable sugars, the sweet wort is boiled
(with hops in later periods), cooled, pitched with yeast, and fermented in barrels.

**Gameplay role.** Staple beverage — thirst restore, mild buff, tavern trade item. Hopped
beer is a storable trade variant; fresh ale is local-consumption.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | crush | hand_quern or malt_mill | malt ×4 | grist ×4 | — | 80 | `stepType: attack` — coarse grind |
| 2 | mash | mash_tun | grist ×4, water ×6 | wort_sweet ×6, spent_grain ×2 | — | 240 | `stepType: time` — hot steep |
| 3 | boil | brew_kettle | wort_sweet ×6, hops ×0.5, firewood ×2 | wort_boiled ×5 | — | 160 | `stepType: time` — hops optional pre-1200; `chainNextRecipeId` from step 2 |
| 4 | cool + pitch | fermenter | wort_boiled ×5, yeast ×0.2 | ale_fermenting ×5 | — | 20 | `stepType: time` — short mix step |
| 5 | ferment | fermenter | ale_fermenting ×5 | ale ×5, yeast_slurry ×0.3, lees ×0.1 | — | 1800 | `stepType: time` — ~1 week compressed; `chainNextRecipeId` from step 4 |

**Primitive verbs exercised:** crush, mash (new: hot-water steep for enzymatic conversion),
boil, pitch, ferment.

**Workstations introduced:** `mash_tun` (insulated hot-water vessel), `brew_kettle`
(fire-heated copper/iron pot), `fermenter` (large sealed barrel).

**Byproducts and their fate:** `spent_grain` → pig feed or livestock fodder (major!);
`yeast_slurry` → pitched into the next batch (closed-loop); `lees` → distilled or composted.

**Knowledge gating:** `lore_brewing`. Hopped beer behind a further `lore_hops` that late-gates
the preservation variant.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (mash temperature is critical — too hot denatures
enzymes, too cold doesn't convert), `GAP-STATE` (fermenter has active/dormant state; yeast
slurry recycled from previous batch), `GAP-BATCH` (a medieval brew is barrel-scale, not
cup-scale), `GAP-CHECKPOINT` (fermentation has a primary-active window for topping up; past
it and you've lost conditioning).

**Variants worth noting:** Small-beer (second runnings of the mash — weaker, for daily
drink), stout (darker malt), barley wine (longer mash, longer ferment, higher-strength).

---

## Chain: Wine

**Real-world context.** Viticulture spreads from the Caucasus through the Mediterranean by
1500 BCE; by Roman times every province with a suitable climate is a wine region. The
process is biologically simpler than beer — grape skins carry wild yeast, sugar is already
present — so medieval wine-making is largely about managing fermentation vessels and
post-ferment clarification in oak. Monastic vineyards kept the techniques alive in early
medieval Europe.

**Gameplay role.** High-value trade beverage and ritual good (church). Thirst + modest buff;
aged wines are the luxury tier.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | harvest | — | — | grapes ×N | — | — | Seasonal; resource node |
| 2 | crush | treading_trough or wine_press | grapes ×10 | must ×8, stems ×1 | — | 120 | `stepType: attack` — treading; or time on press |
| 3 | ferment | fermenter | must ×8 | wine_young ×7, grape_pomace ×1, lees ×0.2 | — | 2000 | `stepType: time` — on skins |
| 4 | press | wine_press | wine_young ×7, grape_pomace ×1 | wine_racked ×6, grape_pomace ×1.5 | — | 80 | Second pressing extracts last wine |
| 5 | age | wine_cellar | wine_racked ×6, oak_barrel ×1 | wine ×6 | — | 2400+ | `stepType: time` — months compressed; cellar environmental prereq |

**Primitive verbs exercised:** crush, ferment, press, age/mature.

**Workstations introduced:** `treading_trough` (shallow stone vat), `wine_press`
(screw/beam press), `fermenter` (shared with brewing), `wine_cellar` (cool-humid storage).

**Byproducts and their fate:** `stems` → compost or mulch; `grape_pomace` (skins + pips) →
distilled into marc/grappa, or animal feed, or compost; `lees` → distilled, or used as
bread leaven (historical!), or vinegar base.

**Knowledge gating:** `lore_viticulture`.

**Engine gaps exposed:** `GAP-ENV` (cellar needs cool, stable temperature — GAP-ENV drives
wine style), `GAP-CHECKPOINT` (knowing when to rack is a skill checkpoint), `GAP-QUALITY`
(skilled vintner's wine > novice's), `GAP-BATCH` (a barrel is the natural unit).

**Variants worth noting:** Red (on-skins ferment), white (pressed before ferment), vinegar
(below).

---

## Chain: Mead

**Real-world context.** Mead — fermented honey and water — is archaeologically the oldest
alcohol (Jiahu, 7000 BCE). Northern Europe and Ethiopia kept the tradition alive through
the medieval period, especially where viticulture failed. The process is the simplest of
the fermented chains: dilute honey to ~25% sugar, pitch yeast, wait.

**Gameplay role.** Alternative high-status alcohol for biomes/cultures without grapes.
Shorter supply chain than beer or wine — pays off honey-harvesting.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | combine | fermenter | honey ×3, water ×6, yeast ×0.1 | must_mead ×6 | — | 20 | `stepType: time` — short mix |
| 2 | ferment | fermenter | must_mead ×6 | mead_young ×5, lees ×0.1 | — | 2000 | `stepType: time`; `chainNextRecipeId` from step 1 |
| 3 | age | cellar | mead_young ×5, oak_barrel ×1 | mead ×5 | — | 2400 | `stepType: time` — optional but stat-upgrading |

**Primitive verbs exercised:** combine, ferment, age.

**Workstations introduced:** `fermenter` (shared), `cellar` (shared).

**Byproducts and their fate:** `lees` → vinegar / leaven / compost.

**Knowledge gating:** Freely known (short, obvious chain) or gate aged mead on `lore_aging`.

**Engine gaps exposed:** `GAP-ENV`, `GAP-CHECKPOINT` (aging is optional and
stat-improving — want to model the tradeoff between immediate drink and better drink later).

**Variants worth noting:** Metheglin (mead + spices), melomel (mead + fruit) — trivial
alternates swap inputs.

---

## Chain: Vinegar

**Real-world context.** Vinegar is what happens when alcohol meets oxygen and acetic-acid
bacteria — "mother of vinegar". Every culture with wine or beer also had vinegar, and the
Romans standardised its household and medical use. A failed batch of wine becomes vinegar
automatically if air is allowed in; deliberate vinegar-making seeds a fresh batch with
mother culture.

**Gameplay role.** Preservation agent (pickling input), medicinal, household cleaner, dye
mordant (cross-chain link to textiles). Rescues "ruined" alcohol from being a dead-end.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | acetify | vinegar_crock | ale ×3 OR wine_young ×3, vinegar_mother ×0.1 | vinegar ×3, vinegar_mother ×0.2 | — | 1200 | `stepType: time` — air-exposed (lid off) |

**Primitive verbs exercised:** acetify (sub-verb of `ferment` — flag as new if distinction
matters in Phase 3 merge).

**Workstations introduced:** `vinegar_crock` — a wide-mouth, cloth-covered earthenware jar.

**Byproducts and their fate:** `vinegar_mother` regenerates and self-seeds the next batch —
same closed-loop pattern as sourdough and beer yeast.

**Knowledge gating:** Freely known; mother culture is the real gate (player must obtain one).

**Engine gaps exposed:** `GAP-ENV` (requires air exposure — opposite of most ferments, which
want anaerobic), `GAP-STATE` (mother is a cultivated organism tied to the station), the
"air-open" vs "sealed" dichotomy is a new sub-gap — tentatively `GAP-ENV`.

**Variants worth noting:** Cider vinegar, malt vinegar, mead vinegar — same chain,
different input alcohol.

---

## Chain: Cheese

**Real-world context.** Cheese predates writing and independently appears in every region
with dairy livestock. Medieval cheesemaking centres (the Auvergne, Parma, West Country,
alpine monasteries) produced distinctive styles by varying milk source, rennet, culture,
salt, and cave-aging. Rennet (calf-stomach enzyme) curdles milk; the curd is cut to release
whey, pressed into shape, salted, and aged — the four classic levers that produce every
cheese style from fresh chèvre to hard Parmesan.

**Gameplay role.** High-calorie preserved dairy — hunger restore, stacks, ages into
progressively better-statted variants. Trade staple with huge value-density in the hard
aged tier. Monastery/cave-dweller archetype payoff.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | combine | cheese_vat | milk ×6, rennet ×0.1, culture ×0.05 | curd_whole ×6 | — | 200 | `stepType: time` — warm-set |
| 2 | cut-drain | cheese_vat | curd_whole ×6 | curd_cut ×4, whey ×2 | cheese_knife | 40 | `stepType: attack` — cut releases whey; `chainNextRecipeId` from step 1 |
| 3 | press | cheese_press | curd_cut ×4 | cheese_fresh ×3, whey ×1 | — | 400 | `stepType: time` — weighted press |
| 4 | salt | cheese_press | cheese_fresh ×3, salt ×0.3 | cheese_green ×3 | — | 200 | Dry rub or brine bath; `chainNextRecipeId` from step 3 |
| 5 | age | cheese_cave | cheese_green ×3 | cheese_aged ×3 | — | 4000+ | `stepType: time` — months compressed; environmental prereq |

**Primitive verbs exercised:** combine, cut, press, cure (salt), age/mature.

**Workstations introduced:** `cheese_vat` (heated copper/wooden vessel), `cheese_press`
(weighted mould), `cheese_cave` (cool humid aging environment).

**Byproducts and their fate:** `whey` — **critical byproduct**: pig feed (the classic
cheese-pig-bacon loop), ricotta (re-cooked whey curd), whey-butter, tanning aid. Cheese's
whey is one of the most cross-referenced byproducts in the entire category.

**Knowledge gating:** `lore_cheesemaking` for the rennet step; fresh curd (step 2 output)
could be freely known as "cottage cheese".

**Engine gaps exposed:** `GAP-ENV` (cave must be cool-humid — temperature and humidity both
matter), `GAP-STATE` (aging cheese has a continuous state — young/ripe/peak/overripe),
`GAP-CHECKPOINT` (ripe-window harvest), `GAP-PROCESS-PARAM` (curd-set temperature, press
weight, salt ratio all vary by style), `GAP-QUALITY` (skilled cheesemaker produces
better-statted wheels), `GAP-BATCH` (a wheel is one unit; a vat produces many).

**Variants worth noting:** Fresh (skip press + age), soft-ripened (short age, bloom rind),
hard (long age, low moisture), blue (introduce mould culture). All are parameter variants
of the same five-step chain.

---

## Chain: Butter and buttermilk

**Real-world context.** Butter is mechanically simple — agitate cream until the fat globules
coalesce. Every dairy culture made it; medieval Ireland famously buried firkins of salted
butter in bog water for preservation (bog butter, edible after decades). Buttermilk, the
acidulated liquid left behind, was a daily beverage.

**Gameplay role.** Consumable fat (cooking input, calorie restore); salted butter is the
preserved form. Provides `buttermilk` as a lacto-fermented input for other chains.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | separate | settling_pan | milk ×3 | cream ×1, skim_milk ×2 | — | 200 | `stepType: time` — cream rises |
| 2 | churn | butter_churn | cream ×1 | butter_fresh ×0.5, buttermilk ×0.5 | — | 120 | `stepType: attack` — repeated plunger swings |
| 3 | salt | kneading_trough | butter_fresh ×0.5, salt ×0.05 | butter_salted ×0.5 | — | 40 | `stepType: time` — preserved form |

**Primitive verbs exercised:** separate, churn (new verb; could be subsumed under `agitate`
or `pound`), cure.

**Workstations introduced:** `settling_pan` (wide shallow vessel), `butter_churn` (plunger
or paddle).

**Byproducts and their fate:** `skim_milk` → cheese input (poor-man's cheese), pig feed;
`buttermilk` → bread leaven, drink, lacto-ferment starter.

**Knowledge gating:** Freely known.

**Engine gaps exposed:** `GAP-ENV` (butter doesn't form when cream is too warm — temperature
matters), `GAP-CHECKPOINT` (over-churned butter turns grainy — classic peak-window).

**Variants worth noting:** Cultured butter (buttermilk added to cream before churning —
better flavour, better preservation).

---

## Chain: Salt-cured meat

**Real-world context.** Before refrigeration, salt was the primary meat preservative across
Europe, the Mediterranean, and China. Dry-cure (rub with salt, hang in cool airy place) and
wet-cure (submerge in brine) produced hams, salt pork, and salt beef that stored for
months. The Hanseatic salt-fish trade and the Roman *garum* factories were built on this.
November — *Blutmonat*, the "blood month" — was traditional slaughter-and-salt season in
northern Europe.

**Gameplay role.** Converts perishable meat (current Voxim `raw_meat`) into stacked,
shelf-stable rations. Drives demand for salt, which drives the salt-production chain below.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | butcher | butcher_block | raw_carcass ×1 | raw_meat ×6, offal ×1, bone ×2, hide ×1, fat ×1 | knife | 100 | `stepType: attack` — repeated cuts |
| 2a | dry-cure | curing_rack | raw_meat ×3, salt ×0.5 | cured_meat ×3, brine_runoff ×0.2 | — | 1200 | `stepType: time` — hang + draw moisture |
| 2b | brine-cure | brine_barrel | raw_meat ×3, salt ×0.5, water ×3 | cured_meat ×3, spent_brine ×3 | — | 1600 | Alternative wet cure |

**Primitive verbs exercised:** butcher (new; could subsume under `cut`), cure.

**Workstations introduced:** `butcher_block`, `curing_rack` (ventilated hanging), `brine_barrel`.

**Byproducts and their fate:** `offal` → sausage filling, soap (rendered), glue, dog feed;
`bone` → glue (boil), bone-black pigment, bone meal, tool blanks; `hide` → tanning chain;
`fat` → rendered tallow → soap, candles, food; `spent_brine` → garden fertiliser, pickling
liquor, salt recovery by boil-down.

**Knowledge gating:** Dry cure freely known; `lore_curing` for quality brine recipes.

**Engine gaps exposed:** `GAP-ENV` (cure needs cool airy place — hot/damp → rot not cure),
`GAP-PROCESS-PARAM` (salt-to-meat ratio, cure duration are continuous knobs),
`GAP-CHECKPOINT` (under-cured meat spoils; over-cured is inedible).

**Variants worth noting:** Salt pork, salt beef, prosciutto-style (extended air dry),
bacon (cure + smoke → see next chain).

---

## Chain: Cold-smoked fish (and meat)

**Real-world context.** Cold smoking (smoke at <30 °C) flavours and preserves without
cooking — the fish remains raw-textured. Medieval and Hanseatic smokehouses produced
kippered herring, smoked salmon, smoked ham, and the famous Arbroath smokies over
smouldering oak, beech, or birch. The chain always starts with a brine or dry cure — smoke
alone does not preserve; the salt does, and the smoke adds antimicrobials plus flavour.

**Gameplay role.** Upper-tier preserved food — higher shelf life than cured-only, higher
trade value. Combines the salt and fuel economies.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | split + brine | brine_barrel | raw_fish ×5, salt ×0.3, water ×3 | fish_brined ×5, spent_brine ×3 | knife | 80 | `stepType: attack` |
| 2 | dry (pellicle) | curing_rack | fish_brined ×5 | fish_pellicle ×5 | — | 400 | `stepType: time` — dry surface tackiness |
| 3 | cold-smoke | smokehouse | fish_pellicle ×5, smoking_wood ×2 | smoked_fish ×5 | — | 1600 | `stepType: time` — long, low-temp; env-dependent |

**Primitive verbs exercised:** split, brine/cure, dry, smoke (thermal: low-heat smouldering
fuel — distinct from `apply-heat` kiln).

**Workstations introduced:** `smokehouse` — key property: produces smoke without cooking
heat. Distinct from hot-smoke rack or oven.

**Byproducts and their fate:** `smoking_wood_ash` → lye (see chemistry category);
`spent_brine` → as above.

**Knowledge gating:** `lore_smoking`.

**Engine gaps exposed:** `GAP-ENV` (must be cool ambient — cold smoking in summer heat
cooks the fish), `GAP-PROCESS-PARAM` (smoke density, wood species affect flavour/quality),
`GAP-STATE` (smoker has fuel state — must be tended, re-chunked).

**Variants worth noting:** Hot-smoked (same station, shorter, higher heat — produces
cooked smoked fish instead), smoked ham, smoked cheese (cross-category combo).

---

## Chain: Stockfish (air-dried cod)

**Real-world context.** Stockfish is gutted, headed cod split and hung on wooden racks in
cold dry coastal wind for 6–12 weeks until stone-hard and shelf-stable for years. Norwegian
Lofoten producers dominated the medieval European market; stockfish was the protein staple
of Lent, of ship stores, and of inland trade from the Baltic to the Mediterranean. No salt,
no smoke — cold + wind + airflow alone.

**Gameplay role.** Shelf-life-years trade staple. The purest preservation chain — no salt
needed, which matters in salt-poor biomes. Gates coastal-cold regional economies.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | split-gut | butcher_block | raw_fish ×5 | fish_split ×5, fish_offal ×1, fish_head ×1 | knife | 60 | `stepType: attack` |
| 2 | air-dry | drying_rack | fish_split ×5 | stockfish ×4 | — | 3200 | `stepType: time` — cold-dry environmental prereq |
| 3 | beat (to eat) | — | stockfish ×1, water ×1 | stockfish_soaked ×1 | mallet | 40 | Rehydrate for cooking — optional player step |

**Primitive verbs exercised:** split, gut, dry (distinct from kiln-dry: ambient, not heated).

**Workstations introduced:** `drying_rack` — outdoor timber frame; environmental.

**Byproducts and their fate:** `fish_offal` → fertiliser, pig feed, fish-oil rendering;
`fish_head` → stock broth, glue (fish-skin glue was prized for gilding), pet food.

**Knowledge gating:** Freely known in coastal biomes; elsewhere the *environment* gates it.

**Engine gaps exposed:** `GAP-ENV` (hard requirement — only runs in cold, windy, coastal
biome; fails or moulds elsewhere). This is possibly the purest GAP-ENV chain in the category.

**Variants worth noting:** Clipfish (salt + dry, higher yield, Mediterranean trade),
dried herring ("red herring" = salt + smoke + dry combo).

---

## Chain: Lacto-pickling (sauerkraut / brined cabbage)

**Real-world context.** Lactic-acid fermentation of salted vegetables is pre-Columbian
worldwide — Chinese suan cai (c. 200 BCE, for the Great Wall builders), German sauerkraut,
Korean kimchi analogues, Roman pickled turnips. The technique: salt the vegetable, press
out juice, submerge in its own brine, seal from air. Lactobacilli outcompete pathogens; the
end product is sour, crunchy, vitamin-preserved, months-stable. Voyage-ready — Cook's ships
carried sauerkraut against scurvy.

**Gameplay role.** Vegetable preservation (cabbage, turnip, carrot, cucumber). Scurvy /
vitamin-deficiency antidote in long-voyage or winter survival contexts. Cheap compared to
salt-meat; uses far less salt.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | shred + salt | kneading_trough | cabbage ×3, salt ×0.1 | cabbage_salted ×3 | knife | 80 | `stepType: attack` |
| 2 | pack + weight | pickling_crock | cabbage_salted ×3 | crock_packed ×3 | — | 20 | `stepType: time` — submerges in own brine |
| 3 | ferment | pickling_crock | crock_packed ×3 | sauerkraut ×3, pickle_brine ×0.5 | — | 2000 | `stepType: time`; `chainNextRecipeId` from step 2 |

**Primitive verbs exercised:** shred, salt (cure variant), ferment.

**Workstations introduced:** `pickling_crock` — wide earthenware jar with water-seal lid
(medieval form: an inverted plate + stone weight under a cloth).

**Byproducts and their fate:** `pickle_brine` → starter for next batch, drinkable tonic,
cooking liquor.

**Knowledge gating:** Freely known.

**Engine gaps exposed:** `GAP-STATE` (crock has airlock/anaerobic state — exposed to air
and it rots/moulds), `GAP-ENV` (cool stable temperature matters), `GAP-CHECKPOINT` (peak
sour window — over-fermented goes to mush).

**Variants worth noting:** Vinegar-pickles (swap ferment for steep in vinegar — trivial),
kimchi-analog (+ chilli + ginger + fish sauce — regional).

---

## Chain: Oil pressing (olive / nut / seed)

**Real-world context.** Olive oil pressing is Mediterranean-universal from 4000 BCE;
walnut, hazelnut, poppy-seed, linseed, and sesame oils are the northern-European and
Asian analogues. Two-stage process: crush the fruit/seed (millstone or mortar) to release
oil from the cells, then press (beam press, screw press) to squeeze oil from the paste.
The residue cake is a major agricultural input in its own right.

**Gameplay role.** Cooking fat, lamp fuel, soap input, anointing oil (ritual), lubricant.
Oil cake → animal feed and lamp fuel. Olive-belt biome specialty; flax/walnut/poppy in
temperate.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | crush | oil_mill | olives ×10 OR nuts ×5 OR seeds ×5 | oil_paste ×8 | — | 120 | `stepType: time` — millstone over trough |
| 2 | press | oil_press | oil_paste ×8 | oil ×3, oil_cake ×4 | — | 160 | `stepType: time`; `chainNextRecipeId` from step 1 |
| 3 | decant | settling_pan | oil ×3 | oil_refined ×2.5, oil_dregs ×0.5 | — | 200 | `stepType: time` — optional quality step |

**Primitive verbs exercised:** crush, press, decant (settle + separate).

**Workstations introduced:** `oil_mill` (stone muller + trough), `oil_press` (beam or
screw), `settling_pan` (shared).

**Byproducts and their fate:** `oil_cake` — **major byproduct**: animal feed (high
energy), lamp fuel (burns smoky but hot), fertiliser, even winter human food in poor
households; `oil_dregs` → soap input.

**Knowledge gating:** Press tech gated by `lore_mechanical_press` (shared with wine press).

**Engine gaps exposed:** `GAP-QUALITY` (first pressing = extra virgin; later pressings
= lower grade — a sequence of same-recipe with decreasing yield and quality),
`GAP-SKILLED-YIELD`, `GAP-BATCH`.

**Variants worth noting:** Hot-press (heated paste, higher yield, lower quality),
cold-press (inverse) — a GAP-PROCESS-PARAM variant.

---

## Chain: Salt production

**Real-world context.** Salt is the keystone preservative, and pre-industrial production
split into three utterly different chains for the same output. **Solar salt pans:**
Mediterranean / Atlantic coasts, shallow ponds sluiced with seawater, evaporated by sun
and wind over weeks — passive but climate-dependent. **Brine-well boiling:** inland salt
springs (Droitwich in England, Halle in Germany, Hallstatt in Austria — the "hall"
placename marks them), pumped brine boiled down in lead or iron pans over wood fires —
active, fuel-hungry, year-round. **Rock-salt mining:** Wieliczka (Poland), Hallstatt —
solid halite hewn underground, dressed into blocks.

**Gameplay role.** Universal preservative input — every curing, cheese, and pickling chain
consumes salt. Source-biome exclusivity drives trade routes. Three chains, one output.

**Chain steps (solar pans):**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | sluice | salt_pan | seawater ×10 | brine_shallow ×10 | — | 40 | Periodic fill |
| 2 | evaporate | salt_pan | brine_shallow ×10 | salt ×1, bittern ×0.2 | rake | 3200 | `stepType: time` — sun + wind env-dependent; rake step at end |

**Chain steps (brine-boil):**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | draw | brine_well | — | brine_raw ×5 | bucket | 40 | Resource node variant |
| 2 | boil | salt_boiling_pan | brine_raw ×5, firewood ×4 | salt ×1.5, bittern ×0.3 | — | 300 | `stepType: time` — active, fuel-hungry |

**Chain steps (rock-salt mining):**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | mine | — | — | rock_salt ×1 | pickaxe | — | Resource node, underground biome |
| 2 | crush + grade | hand_quern | rock_salt ×1 | salt ×0.8, rock_tailings ×0.1 | — | 80 | `stepType: attack` |

**Primitive verbs exercised:** sluice, evaporate, draw, boil, mine, crush, grade.

**Workstations introduced:** `salt_pan` (shallow outdoor terraced pond — pure GAP-ENV
station), `brine_well` (capped spring), `salt_boiling_pan` (large iron/lead shallow pan
over hearth).

**Byproducts and their fate:** `bittern` (magnesium-rich liquid) → tofu coagulant (East
Asia), medicinal, dye mordant; `rock_tailings` → road fill.

**Knowledge gating:** Salt pans and wells freely known in their biomes; `lore_salt_boiling`
for efficient boil-down.

**Engine gaps exposed:** `GAP-ENV` (solar pans need sun + dry wind + sea access — hard
environmental gate; brine wells need the specific geological feature), `GAP-BATCH` (a
pan is inherently batch-scale), `GAP-STATE` (boiling pan has fuel/temp state — let it
cool and the crystallisation stops).

**Variants worth noting:** *Fleur de sel* — the fine crust raked off solar pans first
thing in the morning, a luxury grade of the same chain. `GAP-SKILLED-YIELD` variant of
the solar chain.

---

## Variants and minor chains

- **Honey harvesting.** Bee-skep → smoke-out bees → crush comb → strain → honey + beeswax.
  Honey → mead input (above); beeswax → candles / sealing wax / lost-wax casting (cross to
  metalwork). Two-step; included as a trivial recipe seed.
- **Porridge / gruel.** Cleaned_grain + water → boil → porridge. Trivial, one-step.
- **Hard tack / ship biscuit.** Flour + water + salt → bake long at low heat → shelf-life
  years. A variant of bread baking with a different tick count / oven-temperature profile.
- **Dried fruit.** Pick fruit → air-dry on rack → dried fruit. Same `drying_rack` as
  stockfish; no new station. Fold into stockfish chain as variant if authored.
- **Sausage.** Offal + fat + salt + spices + guts → stuff → smoke or dry. A *combinator*
  for salt-meat and smoke chains — worth authoring as a single assembly recipe.
- **Preserves / jam.** Fruit + honey (pre-sugar-era) → long boil → preserves. One-step.
- **Fish sauce (garum).** Fish + salt → long ferment in sun → liquamen. Notable for
  extreme duration and GAP-ENV (sunlight); flag if Mediterranean biomes exist.
- **Rennet and yeast/starter cultivation.** The *meta* chains that produce the biological
  inputs (rennet from calf stomach; yeast from ale barm; sourdough starter from flour +
  water + air). Each is a one-step gather/cultivate recipe with a persistent output item
  that self-regenerates — a pattern worth flagging engine-wise (GAP-STATE on an item,
  not a station).

---

## Category summary

- **Verbs used:** harvest, thresh, winnow, grind, combine, knead, proof, bake, soak,
  germinate, kiln-dry, crush, mash, boil, pitch, ferment, acetify, separate, churn, cure,
  salt, butcher, split, gut, dry, smoke, age/mature, press, decant, sluice, evaporate,
  draw, mine, shred, pack. (New verbs not on the seed list: mash, pitch, acetify, churn,
  butcher, smoke, sluice, evaporate. Several can be collapsed — `churn` = `agitate`/`pound`
  variant; `smoke` = low-heat thermal; `acetify` = aerobic-ferment sub-variant.)

- **Workstations introduced:** `threshing_floor`, `hand_quern`, `watermill`, `windmill`,
  `kneading_trough`, `bread_oven`, `steeping_cistern`, `malting_floor`, `malt_kiln`,
  `mash_tun`, `brew_kettle`, `fermenter`, `treading_trough`, `wine_press`, `wine_cellar`,
  `cellar` (generic), `vinegar_crock`, `cheese_vat`, `cheese_press`, `cheese_cave`,
  `settling_pan`, `butter_churn`, `butcher_block`, `curing_rack`, `brine_barrel`,
  `smokehouse`, `drying_rack`, `pickling_crock`, `oil_mill`, `oil_press`, `salt_pan`,
  `brine_well`, `salt_boiling_pan`. Several consolidate (`cellar` / `wine_cellar` /
  `cheese_cave` may be one parameterised station; `fermenter` serves beer, mead, wine,
  pickle, vinegar with only capacity/lid variations).

- **Primitives consumed:** raw_grain, grapes, honey, milk, raw_meat, raw_carcass, raw_fish,
  cabbage (and pickleable veg), olives / nuts / seeds, seawater, brine (spring-drawn),
  rock_salt, firewood, hops, smoking_wood, water, yeast (wild/sourdough/barm),
  vinegar_mother, rennet, salt (circular — produced by this category, consumed by it).

- **Byproducts exported to other categories:**
  - `straw` → thatching / bedding / paper pulp (construction, textiles)
  - `chaff`, `bran`, `spent_grain`, `rootlets`, `oil_cake`, `skim_milk`, `buttermilk`,
    `whey`, `fish_offal` → animal feed / livestock economy (cross-loop glue)
  - `whey` → pig-to-bacon loop, ricotta (re-enters this category)
  - `oil_cake`, `tallow` (from butchery fat) → lamp fuel / candles (lighting/chemistry)
  - `bone` → glue, black pigment, bone meal (chemistry, art, agriculture)
  - `hide` → tanning (leather category)
  - `offal` → sausage (self), soap/glue/rendered goods (chemistry)
  - `ash` (smoker, oven, brewery fires) → lye → soap, dye mordant (chemistry/textiles)
  - `lees`, `yeast_slurry`, `sourdough_starter`, `vinegar_mother` → self-seeding
    biological inputs, closed-loop within category
  - `bittern` → tofu coagulant (if East Asian cuisine), medicinal, mordant (textiles)
  - `beeswax` (honey chain) → candles, lost-wax casting (metalwork)

- **Top engine gaps (frequency in this category):**
  - `GAP-ENV` (cited in ~12 of 14 chains) — *the* defining gap for food & preservation.
    Cold-smoking, stockfish, solar salt, cheese aging, malting floor, wine cellar, brewing
    fermentation, sauerkraut, bread proofing — every preservation technique is
    environment-sensitive. Without a way to express ambient temperature, humidity, airflow,
    sun exposure, and biome gates, these chains collapse into "identical time recipes".
  - `GAP-STATE` (cited in ~8 chains) — fermenters, ovens, smokers, cheese caves all have
    continuous internal state (active/dormant, fuelled/cold, cultured/sterile,
    anaerobic/exposed). The current buffer-only station model can't represent "the mash
    is still warm" or "the mother is alive".
  - `GAP-CHECKPOINT` (cited in ~8 chains) — aging, fermenting, proofing, curing all have
    a peak window. "When is the cheese ready?" is a skill check the current engine
    cannot express; the current workaround (decompose into micro-recipes) would require
    dozens of age-level variants per product.
  - `GAP-BATCH` (cited in ~6 chains) — brewing, wine, salt pans, oil press, cheese vats
    are inherently batch-scale. One-charge recipes make medieval-scale production feel
    like cup-sized toy crafting.
  - `GAP-PROCESS-PARAM` (cited in ~5 chains) — brew mash temperature, cheese curd temp,
    salt ratio, smoke density, press pressure. These are the knobs that distinguish styles
    of the same output.
  - `GAP-QUALITY` / `GAP-SKILLED-YIELD` (cited in ~5 chains) — skilled brewer, cheesemaker,
    salter all produce meaningfully-better output from the same inputs. Critical for
    specialist-archetype progression.
