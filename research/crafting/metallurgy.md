# Metallurgy

**Scope & gameplay role.** Metallurgy converts stone-age gathering into the mid-game
equipment economy: weapons, armour, tools, coinage, and the architectural fasteners
(nails, hinges, rivets) that gate permanent building. It is the category that most
clearly separates "lone homesteader" from "settled village" — a bloomery run is a
multi-hour group effort with bulky byproducts (slag, charcoal dust, scale) that feed
ceramics, masonry, and chemistry chains. It serves the combatant archetype (blade
stock, arrowheads), the specialist (wire, coinage, fine casting), and the trader
(ingot bars as a near-universal medium of exchange).

Voxim already ships two anchor recipes, both handled as single-step campfire smelts:
`iron_ingot` (iron_ore + coal → iron_ingot, 120t) and `copper_ingot` (copper_ore + coal
→ copper_ingot, 100t), and one handcraft assembly `copper_spear` (copper_ingot + wood
on workbench, hammer-swing). This document treats those as the minimal stub and
documents the fuller historical chains those ingots sit inside.

**Chains documented.**

- **Bog-iron bloomery** — gathered bog ore → roast → bloom smelt → consolidate → wrought billet.
- **Blade forging & heat treatment** — billet → draw/shape → harden (quench) → temper.
- **Copper sulphide matte smelting** — chalcopyrite → roast → matte → refined copper.
- **Bronze alloying** — refined copper + tin → bronze ingot (crucible melt).
- **Brass by cementation** — copper + calamine + charcoal → brass (vapour-phase zinc).
- **Lead smelting & cupellation** — galena → lead → cupel bone-ash hearth → silver + litharge.
- **Sand-cast fittings** — ingot → melt → pour into packed-sand mould → cast blank → finish.
- **Lost-wax casting** — wax master → clay shell → burn-out → pour → break shell.
- **Wire drawing & nail-making** — billet → plate → draw-plate → wire; or → cut → head.
- **Tinning** — clean copper/iron vessel → flux → dip molten tin → wipe.

Variants and rare chains (crucible steel/wootz, gold amalgamation) are noted at the
bottom rather than given full entries.

---

## Chain: Bog-iron bloomery

**Real-world context.** From the Iron Age through the high medieval period in northern
Europe, most iron was smelted from bog ore — hydrated iron oxide nodules precipitated
by bacteria in peat bogs — in small clay-and-stone shaft furnaces called bloomeries.
A single charge produced a spongy, slag-laced "bloom" of ~5–10 kg in 4–8 hours of
forced-draught burning with charcoal. Bloomeries do not melt iron; they reduce it in
the solid state, and the bloom must be consolidated by repeated hot hammering to expel
slag and weld the sponge into usable wrought iron.

**Gameplay role.** Authoritative replacement for Voxim's current one-step
`iron_ingot` campfire recipe. Produces the `wrought_iron_billet` that all iron
weapons, tools, nails, and hinges ultimately derive from. The chain's length is the
justification for iron being a mid-game rather than early-game material.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | bog_ore ×N | shovel | — | Resource node in wetland biome. `GAP-ENV` — no "wetland only" tag today. |
| 2 | roast | roasting_hearth | bog_ore ×3, firewood ×2 | roasted_ore ×3, bog_water_vapour (discarded) | — | 600 | `stepType: time`. Drives off water and sulphur. Open pit, different from bloomery. |
| 3 | apply-high-heat | bloomery | roasted_ore ×3, charcoal ×4 | raw_bloom ×1, slag ×2 | — | 800 | `stepType: time`. The interesting step — temperature and draught control matter historically; see GAP-PROCESS-PARAM. Chain via `chainNextRecipeId` to step 4 only if bloom stays in furnace, otherwise manual handoff. |
| 4 | hammer | anvil | raw_bloom ×1 | consolidated_bloom ×1, hammer_scale ×1 | hammer | 0 | `stepType: attack`. Squeezes slag out; historically took many heats. |
| 5 | apply-high-heat | forge | consolidated_bloom ×1, charcoal ×1 | hot_bloom ×1 | — | 80 | `stepType: time`. Reheat for the finish-hammering pass. |
| 6 | hammer | anvil | hot_bloom ×1 | wrought_iron_billet ×1, hammer_scale ×1 | hammer | 0 | `stepType: attack`. Final billet. |

**Primitive verbs exercised:** gather, roast, apply-high-heat, hammer.

**Workstations introduced:** `roasting_hearth` (open stone pit — also reusable for ceramics
pre-bisque and for lime-burning), `bloomery` (tall clay shaft furnace, charcoal-fuelled),
`forge` (already authored as item — reheat hearth with bellows), `anvil` (already authored).

**Byproducts and their fate:** `slag` → glassy flux, can be crushed for road fill or
added to later smelts as flux; exports to masonry/ceramics as temper. `hammer_scale`
(iron oxide flakes) → pigment for black paint/ink, or mordant-adjacent input for
dyeing; exports to chemistry. `bog_water_vapour` discarded.

**Knowledge gating:** none for steps 1–4 (peasant-tier craft). Consider a
`fragment_bloomery_draught` for step 3 to gate higher-yield variants without gating
access.

**Engine gaps exposed:** `GAP-ENV` (bog ore needs wetland biome tag), `GAP-BATCH`
(historically a bloomery is a batch process producing one large bloom; mapping to
fixed `quantity: 1` loses the sense of a "charge"), `GAP-PROCESS-PARAM` (draught/
temperature would make step 3 interactive — today it is a pure timer),
`GAP-CHECKPOINT` minor (consolidation historically happens in multiple heats; the
workaround of separate steps 4/5/6 is fine but chatty).

**Variants worth noting:** mined haematite/magnetite ore substitutes for bog ore via
`inputs[].alternates`. Catalan forge is a regional late-medieval bloomery variant with
water-powered bellows — express via better-yield recipe gated on a fragment, not a new
chain.

---

## Chain: Blade forging & heat treatment

**Real-world context.** Once a smith has a wrought-iron or steel billet, turning it
into a blade involves three distinct thermal operations: forging at red-heat to shape,
quenching from cherry-red into water or oil to form hard martensite, and tempering at
a low heat (200–300°C) to restore toughness. The tempering colour on the polished
steel (straw, bronze, peacock, blue) was the medieval smith's only thermometer.

**Gameplay role.** Produces the weapon-blade intermediate that feeds final hafting/
hilting recipes. Replaces Voxim's single-step `copper_spear`-style assembly with a
four-step chain for iron/steel weapons, and makes "why are iron swords better" a
matter of both material and process. Handcraft quality of the final blade is where
`GAP-QUALITY` hurts most.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | apply-high-heat | forge | wrought_iron_billet ×1, charcoal ×1 | hot_billet ×1 | — | 80 | `stepType: time`. Bring to forging heat. |
| 2 | hammer | anvil | hot_billet ×1 | blade_blank ×1, hammer_scale ×1 | hammer | 0 | `stepType: attack`. Shapes bevels and tang. `inputs[].outputSlot: "blade"` carries material identity. |
| 3 | quench | quench_tub | blade_blank ×1, water ×1 | hardened_blade ×1, steam (discarded) | tongs | 20 | `stepType: time`. The interesting step — timing window matters. Oil-quench variant via `alternates`. |
| 4 | temper | forge | hardened_blade ×1, charcoal ×1 | tempered_blade ×1 | — | 120 | `stepType: time`. Low-heat soak; over-tempering ruins hardness — see `GAP-PROCESS-PARAM`. |
| 5 | assemble | workbench | tempered_blade ×1, wood ×1, leather_strip ×1 | sword ×1 | hammer | 0 | `stepType: assembly`. Multiple blade shapes → sword/knife/spearhead disambiguated by recipe pick. |

**Primitive verbs exercised:** apply-high-heat, hammer, quench, temper, assemble.

**Workstations introduced:** `quench_tub` (new — wooden tub of water next to the forge;
could share entity with water-bucket if engine supports it). `forge`, `anvil`,
`workbench` already authored.

**Byproducts and their fate:** `hammer_scale` (see bloomery chain). `steam` discarded.
A failed quench (cracked blade) would export `scrap_iron` — but this requires a
failure mode the engine doesn't have yet.

**Knowledge gating:** `fragment_heat_treatment` recommended for steps 3–4 (a peasant
can swing a hammer; hardening without cracking the blade is specialist knowledge).

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (quench temperature, temper colour), 
`GAP-QUALITY` (a master smith's blade should outstat a novice's from the same billet —
currently impossible), `GAP-DURABILITY` (hammer never wears), new gap
**`GAP-FAIL-MODE`** — no way to express "this recipe has a chance of producing
`scrap_iron` instead of `hardened_blade`", which is the entire gameplay point of
skill-gated metallurgy.

**Variants worth noting:** pattern-welded blades (repeated fold-and-weld of bloom
iron + higher-carbon steel) are a whole sub-chain — each fold is a reheat + hammer
pass. Could be authored as a 6-fold recipe that consumes its own output via
`chainNextRecipeId` N times, but this is better expressed as `GAP-CHECKPOINT` fodder.

---

## Chain: Copper sulphide matte smelting

**Real-world context.** Copper from surface malachite/azurite is a one-step reduction
smelt (roughly what Voxim already models). But the bulk of historic copper came from
deeper sulphide ores — chalcopyrite (CuFeS₂) — which require a two-stage process: a
sulphur-burning roast to drive off most of the sulphur as SO₂, then a reducing smelt
in a shaft furnace that yields an impure "matte" (copper + iron sulphides), which is
roasted and smelted again to "blister copper", then refined by oxidation-reduction
("poling") in a crucible.

**Gameplay role.** Converts Voxim's existing `copper_ingot` stub into a chain that
explains why copper is still a trade good worth caring about after iron arrives. The
intermediate `copper_matte` is a plausible trade staple between a mining settlement
and a smelting centre — makes copper geography interesting.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | chalcopyrite_ore ×N | pickaxe | — | Rocky/mountain biome node. |
| 2 | crush | ore_stamp | chalcopyrite_ore ×3 | crushed_ore ×3, rock_dust (discarded) | hammer | 0 | `stepType: attack`. Liberates sulphide grains. |
| 3 | roast | roasting_hearth | crushed_ore ×3, firewood ×1 | roasted_copper_ore ×3, sulphur_fume (discarded) | — | 500 | `stepType: time`. Open-pit dead roast; historically a multi-day smouldering heap. |
| 4 | apply-high-heat | copper_furnace | roasted_copper_ore ×3, charcoal ×3 | copper_matte ×1, iron_slag ×2 | — | 600 | `stepType: time`. First smelt. |
| 5 | roast | roasting_hearth | copper_matte ×1, firewood ×1 | roasted_matte ×1, sulphur_fume (discarded) | — | 300 | `stepType: time`. Second roast drives off remaining sulphur. |
| 6 | apply-high-heat | copper_furnace | roasted_matte ×1, charcoal ×2 | blister_copper ×1, copper_slag ×1 | — | 400 | `stepType: time`. Yields impure copper. |
| 7 | refine | crucible_furnace | blister_copper ×1, green_wood_pole ×1 | copper_ingot ×1, dross ×1 | — | 200 | `stepType: time`. "Poling" — a green-wood pole plunged into the melt throws off oxygen as CO/CH₄. The interesting step. |

**Primitive verbs exercised:** gather, crush, roast, apply-high-heat, refine.

**Workstations introduced:** `ore_stamp` (hammer-and-mortar or foot-stamp for crushing;
also serves ceramics/grain chains), `roasting_hearth` (shared with bloomery chain),
`copper_furnace` (a shaft furnace tuned lower-temperature than a bloomery — could
plausibly share a station entity if `stationType: "furnace"` generalises),
`crucible_furnace` (smaller, higher-temperature, clay crucible on hearth — this is
also the alloying station below).

**Byproducts and their fate:** `iron_slag` and `copper_slag` → glassmaking flux,
masonry aggregate. `sulphur_fume` discarded in Voxim but historically is what killed
nearby vegetation around smelters — atmospheric flavour, not a material. `rock_dust`
discarded. `dross` (skimmed oxide scum from refining) → pigment stock for ceramics.

**Knowledge gating:** `fragment_matte_smelting` for steps 4–6 (not obvious from
surface-ore smelting). Step 7 poling would want its own `fragment_copper_refining`.

**Engine gaps exposed:** `GAP-CHECKPOINT` (the three-stage roast-smelt-roast-smelt is
decomposed via `chainNextRecipeId` fine, but reads awkwardly), `GAP-CONSUMED-INPUT`
minor (green_wood_pole is consumed once per refine; fine as an input),
`GAP-SKILLED-YIELD` (historically matte-smelting yields varied wildly with smith
skill).

**Variants worth noting:** surface oxide ores (malachite, azurite) skip steps 3–6 and
go straight to a one-step smelt — this is effectively what Voxim ships today. Retain
that as `copper_ingot_oxide` recipe alongside the sulphide chain.

---

## Chain: Bronze alloying

**Real-world context.** Bronze (copper + ~10% tin) was the dominant weapon metal from
~3000 BCE until iron displaced it. Unlike iron, tin ores are geographically rare
(Cornwall, Iberia, central Asia) — bronze was the first metal whose production
required long-distance trade. Alloying is done by co-melting in a clay crucible; the
proportions visibly affect colour and hardness, which is how ancient smiths
calibrated without assay.

**Gameplay role.** Provides a second-tier weapon material between copper and iron,
and — more importantly — provides a tin-import reason that drives trade between
biomes. Bronze is also the preferred metal for bell-casting and fine fittings.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | cassiterite_ore ×N | pickaxe | — | Tin ore, a separate rare node. |
| 2 | roast | roasting_hearth | cassiterite_ore ×2, firewood ×1 | roasted_cassiterite ×2 | — | 300 | `stepType: time`. |
| 3 | apply-high-heat | copper_furnace | roasted_cassiterite ×2, charcoal ×1 | tin_ingot ×1, tin_slag ×1 | — | 300 | `stepType: time`. Tin smelts at a much lower temperature than copper. |
| 4 | apply-high-heat | crucible_furnace | copper_ingot ×9, tin_ingot ×1, charcoal ×2 | bronze_ingot ×10, crucible_scum ×1 | — | 250 | `stepType: time`. The interesting step — ratio gates hardness. `GAP-PROCESS-PARAM` is felt here. |

**Primitive verbs exercised:** gather, roast, apply-high-heat.

**Workstations introduced:** `crucible_furnace` (shared with copper refining).

**Byproducts and their fate:** `tin_slag` → flux stock. `crucible_scum` → discarded or
reworkable — a minor pigment.

**Knowledge gating:** `fragment_bronze_alloy` — this is the canonical "lore unlock"
that moves a village out of the copper age.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (historically 9:1 is ideal; 8:2 is too
brittle; the recipe can only express one fixed ratio without author-exploding the
recipe list), `GAP-QUALITY` (bronze quality depends on alloy evenness — a skilled
smelter stirs the crucible).

**Variants worth noting:** arsenical bronze (copper + arsenic-rich ores) predates tin
bronze and could be a pre-tin variant gated on specific ore nodes; document here only
as a flavour variant. Lead-bronze (copper + tin + lead) for sculpture is a minor
variant, not a separate chain.

---

## Chain: Brass by cementation

**Real-world context.** Europe did not smelt elemental zinc until the 18th century,
yet brass (copper + zinc) was made continuously from Roman times via **cementation**:
copper metal packed with powdered calamine (zinc carbonate ore) and charcoal in a
sealed crucible, heated for ~10 hours. Zinc vapour permeates the solid copper and
alloys into it in place — no molten zinc ever exists. This is a chemically unusual
chain: the zinc input never appears as a separate metal intermediate.

**Gameplay role.** Gates decorative fittings and coinage (brass is a common medieval
coin alloy). The "no elemental zinc" aspect is a great knowledge-gate hook — a player
with calamine nodes but no cementation fragment simply cannot make brass.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | calamine_ore ×N | pickaxe | — | Zinc-carbonate surface ore. |
| 2 | roast | roasting_hearth | calamine_ore ×2, firewood ×1 | calcined_calamine ×2, carbonate_fume (discarded) | — | 400 | `stepType: time`. Drives off CO₂. |
| 3 | grind | quern | calcined_calamine ×2 | calamine_powder ×2 | — | 100 | `stepType: time`. |
| 4 | apply-high-heat | cementation_crucible | copper_ingot ×5, calamine_powder ×3, charcoal ×2 | brass_ingot ×5, spent_calamine ×1 | — | 1200 | `stepType: time`. The interesting step — very long hold at sub-melting heat so zinc vapour diffuses into solid copper. |

**Primitive verbs exercised:** gather, roast, grind, apply-high-heat.

**Workstations introduced:** `quern` (rotary stone hand-mill, shared with grain and
pigment chains), `cementation_crucible` (a sealed clay pot on a dedicated hearth — 
could share station entity with `crucible_furnace` if the engine ignores tuning
differences).

**Byproducts and their fate:** `spent_calamine` → discarded or feeds back as lean
ore. `carbonate_fume` discarded.

**Knowledge gating:** `fragment_cementation` required. This is the canonical "rare
monastic knowledge" gate — historically, brass-making was a guild secret.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (the 1200-tick hold is not just "a long
timer" historically — it required maintaining a specific temperature range for the
zinc-vapour reaction), `GAP-BATCH` (cementation was always batched in multi-crucible
hearths).

**Variants worth noting:** direct zinc-copper melting via "speltering" is post-1500
and out of scope.

---

## Chain: Lead smelting & cupellation

**Real-world context.** Galena (PbS) is abundant, easy to smelt, and — crucially —
usually contains silver. The ancient and medieval silver supply came almost entirely
from **cupellation**: silver-bearing lead is melted on a porous bone-ash cupel with
strong air blast, which oxidises the lead to litharge (PbO) that soaks into the cupel
and off the molten pool, leaving metallic silver behind. This chain is the reason
silver coinage existed at scale before the discovery of the Americas.

**Gameplay role.** Produces lead for pipes, shot, solder, stained-glass cames, and
roofing; produces silver for coinage and decorative inlay. Silver cupellation is the
showpiece chain for "specialist metallurgist" as a character archetype.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | galena_ore ×N | pickaxe | — | Argentiferous variant in specific nodes. |
| 2 | roast | roasting_hearth | galena_ore ×2, firewood ×1 | roasted_galena ×2, sulphur_fume (discarded) | — | 400 | `stepType: time`. |
| 3 | apply-high-heat | lead_hearth | roasted_galena ×2, charcoal ×2 | argentiferous_lead ×1, lead_slag ×1 | — | 400 | `stepType: time`. Lead melts very low — this is the easiest smelt in the category. |
| 4 | burn | bone_ash_kiln | bone ×3, firewood ×2 | bone_ash ×3 | — | 500 | `stepType: time`. Prep for the cupel — this is the weird dependency: silver extraction requires the ceramics/bone chain. |
| 5 | form | potter_bench | bone_ash ×2, clay ×1 | cupel ×1 | — | 100 | `stepType: time`. A cupel is a consumable dish — flag `GAP-CONSUMED-STATION`. |
| 6 | cupel | cupellation_hearth | argentiferous_lead ×1, cupel ×1, charcoal ×2 | silver_bead ×1, litharge ×1, spent_cupel ×0 (destroyed) | bellows | 600 | `stepType: time`. The interesting step — the cupel itself is consumed and absorbs the lead oxide. This is the clearest `GAP-CONSUMED-STATION` case in the category. |
| 7 | melt | crucible_furnace | silver_bead ×3, charcoal ×1 | silver_ingot ×1 | — | 150 | `stepType: time`. Consolidate beads into a traded form. |

**Primitive verbs exercised:** gather, roast, apply-high-heat, burn, form, cupel, melt.

**Workstations introduced:** `lead_hearth` (low-temperature reducing hearth; can share
with tinning station), `bone_ash_kiln` (small bisque kiln, shared with ceramics),
`potter_bench` (shared with ceramics), `cupellation_hearth` (dedicated — a small blown
hearth that holds a cupel).

**Byproducts and their fate:** `litharge` (PbO) → yellow pigment, ceramic glaze flux,
medicinal preparations — significant export to ceramics and chemistry. `lead_slag` →
road fill. `spent_cupel` discarded; could historically be re-smelted to recover the
lead.

**Knowledge gating:** `fragment_cupellation` — this is a late-game unlock, peasant-
tier smiths don't stumble into it.

**Engine gaps exposed:** `GAP-CONSUMED-STATION` (the cupel is the textbook case for
this gap — modelling it as an input item works but loses the spatial sense of "a
dish on the hearth being slowly absorbed"), `GAP-PROCESS-PARAM` (cupellation
requires continuous bellows-blown air; today bellows would have to be a required
tool with no continuous feedback), `GAP-SKILLED-YIELD` (silver recovery ratio
historically depended hugely on operator skill).

**Variants worth noting:** Pattinson process (crystallisation-based lead/silver
separation) is post-1800, out of scope.

---

## Chain: Sand-cast fittings

**Real-world context.** Sand casting uses a reusable two-part wooden frame (a flask)
packed with damp moulding sand around a wooden pattern. The pattern is removed, the
two halves of the flask rejoined, and molten metal poured in. The sand mould is
broken open to release the casting, and the same sand is re-rammed for the next cast.
Used throughout antiquity for bronze fittings, bells, cauldrons, and small ironwork.

**Gameplay role.** Produces bulk cast fittings (pot, lock-plate, buckle, bell) that
are shape-complex but not edge-tools. Distinct from forging because casting handles
shapes (hollow pots, intricate hardware) that cannot be hammered from a billet.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | moulding_sand ×N | shovel | — | River-sand node with clay binder. |
| 2 | carve | workbench | wood ×2 | casting_pattern ×1 | chisel | 0 | `stepType: attack`. Reusable master — `GAP-DURABILITY` would apply if patterns wore. |
| 3 | pack | casting_flask | moulding_sand ×4, casting_pattern ×1 | primed_flask ×1, casting_pattern ×1 (returned) | — | 80 | `stepType: time`. Pattern is conserved — `inputs[].outputSlot` trick or special "returned" semantics. See new gap below. |
| 4 | apply-high-heat | crucible_furnace | bronze_ingot ×2, charcoal ×1 | molten_bronze ×1 | — | 150 | `stepType: time`. Intermediate short-lived state — if `molten_bronze` can't be held, chain via `chainNextRecipeId` directly to step 5. |
| 5 | pour | primed_flask | molten_bronze ×1, primed_flask ×1 (consumed) | bronze_casting ×1, hot_sand ×4 | tongs | 40 | `stepType: time`. The primed_flask acts as station-and-input — or as just an input with no station. |
| 6 | hammer | anvil | bronze_casting ×1 | finished_fitting ×1, casting_sprue ×1 | hammer | 0 | `stepType: attack`. Break off sprue and runners. |
| 7 | repack | — | hot_sand ×4 | moulding_sand ×4 (cooled) | — | 200 | `stepType: time`. Sand is reusable, wanders back to the sand pile. |

**Primitive verbs exercised:** gather, carve, pack, apply-high-heat, pour, hammer.

**Workstations introduced:** `casting_flask` (a reusable frame — could be a station
whose activeRecipe cycles between "empty" and "primed"; today it is cleanest as an
input item).

**Byproducts and their fate:** `casting_sprue` → immediately re-meltable scrap, a
nice in-chain recycle loop. `hot_sand` → cooled back to `moulding_sand`, reusable.

**Knowledge gating:** `fragment_sand_casting`.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (pour temperature critical — too cold
misruns, too hot burns sand),  new gap **`GAP-INPUT-RETURNED`** — the pattern is
conserved, which doesn't fit today's consume-all-inputs model. Workaround is to list
the pattern as an input and as an output at quantity 1, which is ugly but works.

**Variants worth noting:** clay-sand hybrid moulds (loam moulding) for large bells.
Same chain, different `moulding_sand` alternate.

---

## Chain: Lost-wax casting

**Real-world context.** For shapes sand-casting cannot reproduce (undercuts, thin
filigree, sculpture) the lost-wax ("cire perdue") method was used from the Bronze Age
onward. A wax model is dipped in slip and coated with clay layers until it has a
thick shell; the shell is heated so the wax runs out through a vent; molten metal is
poured into the empty cavity; the shell is smashed to release the casting. The shell
is destroyed every cast — it is a single-use station.

**Gameplay role.** Produces high-value cast items: statuettes, elaborate jewellery,
reliquaries, bell-details. The destroyed shell is the canonical `GAP-CONSUMED-STATION`
case for this category.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | shape | workbench | wax ×2 | wax_model ×1 | knife | 0 | `stepType: attack`. Sculpted master. |
| 2 | dip | slip_bath | wax_model ×1, clay_slip ×2 | slipped_model ×1 | — | 60 | `stepType: time`. Thin first coat. |
| 3 | coat | workbench | slipped_model ×1, clay ×3, sand ×1 | green_shell ×1 | — | 120 | `stepType: time`. Build up thicker layers. |
| 4 | dry | drying_rack | green_shell ×1 | dry_shell ×1 | — | 1200 | `stepType: time`. Slow dry — cracks ruin the cast. `GAP-ENV` (sheltered, dry, cool). |
| 5 | burn-out | kiln | dry_shell ×1, firewood ×2 | ready_shell ×1, wax_residue (discarded) | — | 600 | `stepType: time`. Wax runs out of the vent; the shell is now the disposable station for step 6. |
| 6 | pour | ready_shell (station, consumed) | molten_bronze ×1 | cast_object_in_shell ×1 | tongs | 40 | `stepType: time`. The interesting step — the station itself is the one-use mould. |
| 7 | break | workbench | cast_object_in_shell ×1 | cast_object ×1, broken_shell (discarded) | hammer | 0 | `stepType: attack`. Destroys the shell to free the casting. |
| 8 | finish | workbench | cast_object ×1 | finished_cast ×1, metal_filings ×1 | file | 0 | `stepType: attack`. |

**Primitive verbs exercised:** shape, dip, coat, dry, burn-out, pour, break, finish.

**Workstations introduced:** `slip_bath` (shallow vat), `drying_rack` (shared with
leather/herb chains), `kiln` (shared with ceramics), `ready_shell` (a single-use
station — this is the one that does not fit today's model).

**Byproducts and their fate:** `wax_residue` discarded (historically captured and
re-melted if pure), `broken_shell` discarded, `metal_filings` → scrap for re-melt.

**Knowledge gating:** `fragment_lost_wax` — canonical "specialist/monastic craft"
gate.

**Engine gaps exposed:** `GAP-CONSUMED-STATION` — the clearest case in the whole
catalog. The shell *is* a station: it has the pour recipe on it. It exists for one
pour and is destroyed. Modelling the shell as an input item works mechanically but
loses "the object is physically present in the world for you to see before the
pour". `GAP-ENV` (cool dry drying), `GAP-PROCESS-PARAM` (shell must be preheated when
pouring or it cracks — today the "is shell hot" state can't be modelled).

**Variants worth noting:** investment casting with plaster is a later refinement, not
a separate medieval chain.

---

## Chain: Wire drawing & nail-making

**Real-world context.** Wire pre-1500 was made by **drawing**: a thin rod pulled
through successively smaller holes in a hardened iron draw-plate, elongating and
reducing its diameter each pass. Wire was used for mail armour, jewellery, musical
strings, and as stock for nails and pins. Nails specifically were made by cutting
short lengths off a wire or flat bar, then heading one end with a hammer blow into a
heading tool.

**Gameplay role.** Produces the fastener stock that gates advanced carpentry
(framed buildings, ship-like hulls, furniture), and the wire that gates mail armour.
A pure value-add chain that consumes ingot and outputs small-denomination goods.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | apply-high-heat | forge | wrought_iron_billet ×1, charcoal ×1 | hot_billet ×1 | — | 80 | `stepType: time`. |
| 2 | hammer | anvil | hot_billet ×1 | iron_rod ×1, hammer_scale ×1 | hammer | 0 | `stepType: attack`. Elongated stock. |
| 3 | draw | draw_bench | iron_rod ×1 | iron_wire ×4, rod_stub ×1 | tongs | 200 | `stepType: time`. The interesting step — multiple pulls through the plate, could be chained via `chainNextRecipeId` for finer-wire variants. `GAP-DURABILITY` (plates wear out historically). |
| 4 | cut | workbench | iron_wire ×4 | nail_blank ×20 | shears | 0 | `stepType: attack`. |
| 5 | head | heading_block | nail_blank ×1, hot_billet (shared) | iron_nail ×1, hammer_scale (trace) | hammer | 0 | `stepType: attack`. One blow forms the head. Batch-worthy — this is `GAP-BATCH` territory for sure. |

**Primitive verbs exercised:** apply-high-heat, hammer, draw, cut, head.

**Workstations introduced:** `draw_bench` (a timber frame with a clamp and tongs
chain; the draw-plate is the wearing part), `heading_block` (a stake with a conical
hole in the top — could plausibly live on the anvil as a station variant).

**Byproducts and their fate:** `rod_stub` → re-melt, `hammer_scale` → pigment.

**Knowledge gating:** none for nails (peasant smithing). `fragment_fine_drawing` for
sub-gauge wire (mail links).

**Engine gaps exposed:** `GAP-BATCH` (nails are produced by the hundred, one swing per
nail is unplayable — would want a "head 20 nails in one operation" abstraction),
`GAP-DURABILITY` (draw-plates wear — the whole reason drawplate sets exist is that
you replace the small end often).

**Variants worth noting:** mail-link making bends wire around a mandrel, cuts it into
rings, and closes each ring with a rivet — an entire sub-chain that belongs in an
armour category rather than here.

---

## Chain: Tinning

**Real-world context.** Bare copper and iron react with food acids (copper verdigris
is toxic, iron rusts), so cookware, drinking vessels, and some weapon fittings were
tinned — coated in a thin layer of pure tin. The object is cleaned of oxide, fluxed
with sal ammoniac or rosin, dipped briefly in a pot of molten tin, and the excess
wiped off with tow. A short, cheap chain, but essential for the cookware economy.

**Gameplay role.** Converts raw copper/iron cookware into food-safe cookware,
enabling certain cooking recipes (acidic stews, fermentation vessels). Also the
gateway to pewter work (tin-lead alloy) if desired.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | scour | workbench | copper_vessel ×1, sand ×1, vinegar ×1 | clean_vessel ×1, spent_scour (discarded) | — | 60 | `stepType: time`. Remove oxide. |
| 2 | flux | workbench | clean_vessel ×1, sal_ammoniac ×1 | fluxed_vessel ×1 | — | 20 | `stepType: time`. Chemistry crossover — sal ammoniac is a chemistry-category output. |
| 3 | apply-heat | tinning_pot | tin_ingot ×1, charcoal ×1 | molten_tin ×1 | — | 100 | `stepType: time`. Tin is very low-melting. |
| 4 | dip | tinning_pot | fluxed_vessel ×1, molten_tin ×1 | tinned_vessel ×1 | tongs, tow_wipe | 30 | `stepType: time`. The interesting step — short dwell, then wipe. |

**Primitive verbs exercised:** scour, flux, apply-heat, dip.

**Workstations introduced:** `tinning_pot` (an iron pot of molten tin kept over
coals; low-temperature, can share hearth with lead).

**Byproducts and their fate:** `spent_scour` discarded. `tow_wipe` becomes
`tin-dust-contaminated-rag` — discard in Voxim.

**Knowledge gating:** `fragment_tinning` — a specialist's craft, not peasant-tier.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (tin temperature window is narrow — too
cold doesn't coat, too hot burns the flux off), cross-category dependency on
chemistry for `sal_ammoniac` and on agriculture for `tow_wipe`.

**Variants worth noting:** "white-bronze" dip-coating, retinning (stripping old tin
and redipping) — minor variants, same chain.

---

## Variants and minor chains

- **Crucible steel (wootz / bulat).** A fragment-gated rare chain: wrought iron + a
  specific carbon source (cassia wood, leaf mass) + a sealed clay crucible held at
  >1300°C for many hours produces a high-carbon ingot with a visible pattern. Flag
  for `fragment_wootz_steel`; would expose `GAP-PROCESS-PARAM` severely (crucible
  steel requires both temperature *and* atmosphere control). Worth authoring only
  if the game wants a top-tier blade material above regular steel.
- **Gold placer washing & mercury amalgamation.** Pan gold-bearing sand → gold dust;
  amalgamate with mercury → gold-mercury paste; distil off mercury in a retort
  (mercury recovered) → sponge gold; melt → gold ingot. Clean and in-period (used
  from Roman times through late medieval), but introduces `mercury` which is a
  chemistry crossover, and mercury distillation needs a retort that only this chain
  uses. Worth flagging but not authoring in this pass.
- **Pattern-welded steel.** Not a separate chain — a variant of the blade chain with
  many fold-and-weld iterations. Best authored as a recipe that chains to itself
  N times via `chainNextRecipeId`.
- **Coinage striking.** Cast blank disc → anneal → strike between engraved dies with
  a hammer. One-step assembly on top of cast-blank output; not rich enough for its
  own chain, but important enough to author as a single recipe when the economy
  wants real coin.
- **Pewter.** Tin + lead alloy, one-step crucible melt. Same pattern as bronze with
  different ingredients; variant, not a chain.
- **Zinc from smithsonite via distillation (Indian rasa-shastra technique).** A
  downward-distillation vessel produces elemental zinc pre-1500 in Rajasthan. Clean
  example of knowledge-gated geographic craft, but requires a retort station that
  only this chain uses — document only if zinc becomes a first-class material.

---

## Category summary

**Verbs used.** gather, roast, apply-heat, apply-high-heat, crush, grind, hammer,
quench, temper, refine, melt, pour, draw, cut, head, scour, flux, dip, carve, shape,
coat, dry, burn-out, break, finish, pack, cupel, burn, form, assemble. New verbs
proposed: `roast` (oxidising open-pit heat, distinct from `apply-high-heat` reducing
smelt), `cupel` (specialised metallurgical — could fold into `refine`), `draw` (wire,
distinct from `draw` for bow strings), `head` (upset forging a nail head).

**Workstations introduced.** `bloomery`, `roasting_hearth`, `forge` (anchor, already
authored), `anvil` (anchor, already authored), `quench_tub`, `copper_furnace`,
`crucible_furnace`, `ore_stamp`, `quern` (shared with grain/chemistry),
`cementation_crucible`, `lead_hearth`, `bone_ash_kiln` (shared with ceramics),
`potter_bench` (shared with ceramics), `cupellation_hearth`, `casting_flask`,
`slip_bath`, `drying_rack` (shared with many categories), `kiln` (shared with
ceramics), `draw_bench`, `heading_block`, `tinning_pot`. Roughly half are
metallurgy-dedicated; the other half are shared with ceramics or chemistry.

**Primitives consumed.** bog_ore, chalcopyrite_ore, malachite/azurite ore (oxide
copper), cassiterite_ore, calamine_ore, galena_ore, gold_placer_sand (if gold chain
authored), moulding_sand, wax, clay, bone, firewood, charcoal, water, green_wood_pole,
vinegar, sal_ammoniac, tow_wipe. The charcoal requirement dominates — every
apply-high-heat step needs it, which means this category is a heavy consumer of the
forestry category's output.

**Byproducts exported.** `slag` and `copper_slag`/`iron_slag`/`tin_slag`/`lead_slag`
→ masonry aggregate, glassmaking flux (heavy export to ceramics/glass).
`hammer_scale` → black pigment, mordant (export to chemistry and dyeing).
`litharge` (PbO) → ceramic glaze flux, yellow pigment, medicinal stock (export to
ceramics and chemistry). `dross` → pigment stock. `wax_residue` → reuse in lost-wax
(intra-chain). `sulphur_fume` and `carbonate_fume` → atmospheric only, discarded.
`rod_stub`, `casting_sprue`, `metal_filings` → all re-meltable, forming a nice
intra-chain scrap loop. `spent_calamine` → back to ore pile as lean stock.

**Top engine gaps in this category.**

- **`GAP-CONSUMED-STATION`** — hit hardest by lost-wax casting (the shell is the
  station and is destroyed on pour) and cupellation (the cupel dish is consumed by
  the lead oxide). This is the category's signature gap. Workaround of modelling the
  disposable mould as an input works mechanically, but loses the spatial/physical
  reading that "the mould is a thing sitting on the forge, about to be broken open".
- **`GAP-PROCESS-PARAM`** — temperature, atmosphere, and dwell time are the language
  of pre-industrial metallurgy. Bronze ratio, quench timing, temper colour,
  cementation hold, cupellation air-blast, pour heat — every interesting metallurgical
  step has a continuous parameter that today's atomic-timer recipe cannot express.
  Shows up in nearly every chain.
- **`GAP-QUALITY`** and **`GAP-SKILLED-YIELD`** — together these are the "why does
  a master smith matter" gap. Materials carry stats into output, but the
  craftsperson's hand does not. Acutely felt in blade forging and silver cupellation.
- **`GAP-BATCH`** — nail-heading, bloomery charges, cementation crucibles, and
  kiln-fired cupels are all batch operations. Hammering 200 nails one-recipe-per-nail
  is unplayable; one-recipe-per-batch with scaled inputs is fine for NPCs but loses
  the player-interactive "fast-swinging batch work" gameplay of real smithing.
- **`GAP-ENV`** — wetland for bog ore, shelter for drying lost-wax shells, rain-free
  for bloomery operation. Moderate frequency, mostly at gather-step edges.
- **New: `GAP-FAIL-MODE`** — every heat-treatment, casting, and alloying step in
  this category has a plausible failure output (cracked blade, misrun casting,
  brittle alloy). The current "recipe succeeds and produces outputs" model has no
  vocabulary for probabilistic or skill-gated failure.
- **New: `GAP-INPUT-RETURNED`** — reusable patterns and draw-plates are inputs that
  should not be consumed. Workaround via listing the item as both input and output
  works but is ugly and fragile.
