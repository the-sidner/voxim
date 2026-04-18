# Chemistry, Dyes & Adhesives

**Scope & gameplay role.** This category covers pre-industrial *chemical* transformations —
things that change substance rather than shape. Its outputs are the connective tissue of the
wider economy: dyes and mordants colour textiles, inks inscribe tomes (Voxim's lore-fragment
carrier), glues bind wood joinery and bookbinding, lye and soap drive cleaning and tanning,
beeswax enables candles, seals, and lost-wax casting, and saltpeter and aqua vitae act as
reagent feedstocks for late-medieval alchemy. Most chains are low-tool, multi-stage, and
environmentally sensitive — they expose the engine's weakest area (no station state, no
environmental prerequisites, no process parameters). Serves the homesteader-specialist
archetype most strongly (dyer, apothecary, scribe, glue-boiler), with clean outward flow to
combatants via alchemy reagents and to traders via dye bolts.

**Chains documented.**

- **Woad vat (blue dye)** — multi-week ferment/oxidation; flagship chain for state + pH +
  environment gaps.
- **Madder red dye** — simpler hot-liquor dyebath; baseline for "dip mordanted cloth".
- **Weld yellow dye** — cheap yellow; same shape as madder.
- **Oak-gall ink** — iron-gallate; the tome-economy hook. Links directly to lore system.
- **Mineral pigments & lamp black** — short chains grouped together (ochre grind, verdigris,
  lead white, lamp black).
- **Lye (wood-ash leach)** — foundational intermediate feeding soap, tanning, woad, pewter.
- **Curd soap (saponification)** — tallow + lye → soap; household and cleanup staple.
- **Hide/bone glue** — long boil → gelatin; joinery and bookbinding adhesive.
- **Birch tar (dry distillation)** — stone-age adhesive; overlaps with wood-products category.
- **Beeswax rendering** — melt/strain raw comb; candles, seals, lost-wax.
- **Aqua vitae (distilled spirits)** — late-medieval still; alchemical solvent and reagent.
- **Saltpeter (nitre) extraction** — scrape + leach + crystallise; late-medieval reagent.

---

## Chain: Woad vat (blue dye)

**Real-world context.** Woad (*Isatis tinctoria*) was Europe's only source of blue until
indigo imports became viable in the 16th century. Leaves were harvested, crushed, balled,
and aged for weeks to a year before reduction in a stale-urine / lye vat — a genuinely
hard-to-get-right fermentation requiring warmth, the right pH, and correctly exhausted
oxygen. Thread dipped in the colourless "woad yellow" solution oxidises blue in air.

**Gameplay role.** High-tier blue cloth and leather. The vat is the canonical "fussy living
process" station — supply it, maintain it, harvest from it repeatedly. Supports a dyer
profession trade good; blue cloth is a recognisable status marker and an obvious dye for
banners, tabards, and lore-tome covers.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | pick | — | — | woad_leaves ×N | — | — | Resource node (cultivated or wild) |
| 2 | pound | mortar | woad_leaves ×5 | woad_pulp ×1 | pestle | 0 | `stepType: attack`; releases indican |
| 3 | ferment | woad-ball-rack | woad_pulp ×3 | woad_balls ×1, effluent ×1 | — | 1600 | `stepType: time`; couching ferment. Interesting step — only step where raw leaves become storable feedstock |
| 4 | age | woad-ball-rack | woad_balls ×1 | aged_woad_balls ×1 | — | 2000 | `stepType: time`; shelf-stable dry age. GAP-ENV (dry, ventilated) |
| 5 | leach | ash-hopper | hardwood_ash ×2, water ×3 | lye ×1 | — | 200 | `stepType: time`; shared lye sub-chain — see below |
| 6 | ferment | woad-vat | aged_woad_balls ×1, lye ×2, stale_urine ×2 | woad_vat_charge ×1 | — | 800 | `stepType: time`; vat becomes alive. Flagship GAP-STATE step |
| 7 | dye | woad-vat | linen_cloth ×1, woad_vat_charge ×1 | dipped_cloth ×1 | — | 40 | `stepType: time`; consumes vat charge; cloth emerges yellow |
| 8 | oxidise | — | dipped_cloth ×1 | blue_linen ×1 | — | 60 | `stepType: time`; air exposure. GAP-ENV (open air). Could chain to step 7 via `chainNextRecipeId` to hide from UI |

**Primitive verbs exercised:** pick, pound, ferment, age, leach, dye, oxidise.

**Workstations introduced:** `mortar` (pound station, also used by pigments and herbs);
`woad-ball-rack` (drying/ageing rack); `woad-vat` (the active dye vat); `ash-hopper` (lye
leaching, shared with soap/tanning).

**Byproducts and their fate:** effluent from step 3 → discarded (could fertilise fields in a
future agriculture chain). Stale urine (step 6) → primitive, collected from settlement
latrines; arguably out-of-scope to model, but a cheeky gameplay verb. Vat exhausts over
repeated dips — vat-specific depletion is the interesting mechanic.

**Knowledge gating:** new `requiredFragmentId: lore.dyeing.woad_craft` — dyer's skill.

**Engine gaps exposed:** `GAP-STATE` (vat has pH, temperature, exhaustion level, oxygen —
modelled as buffer charges is a weak proxy), `GAP-PROCESS-PARAM` (pH matters; too acid or
alkaline kills the vat), `GAP-ENV` (warm ambient required for ferment; air exposure
required for oxidation), `GAP-QUALITY` (master dyer's blue > novice's), `GAP-BATCH` (real
vats dye cloth by the bolt, not one piece).

**Variants worth noting:** indigo (*Indigofera*) uses the same vat chemistry but is an
imported substitute reagent — could model as a late-game trader good that replaces aged
woad balls 1:1. Fustic (tropical yellow) and logwood (New World) are post-1500.

---

## Chain: Madder red dye

**Real-world context.** Madder (*Rubia tinctorum*) root produced the dominant European red
from antiquity through the industrial era — Turkey red, madder lake, alizarin before
alizarin had a name. Roots were dried for a year or more, ground, and extracted in hot
(but sub-boiling) water onto alum-mordanted cloth.

**Gameplay role.** Red cloth: status, banner, heraldry. Cheaper and faster than woad,
gives a dyer two colour tiers without overlapping mechanics.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | dig | — | — | madder_root ×N | shovel | — | Resource node |
| 2 | dry | drying-rack | madder_root ×3 | dried_madder ×1 | — | 1200 | `stepType: time` |
| 3 | grind | quern | dried_madder ×1 | madder_powder ×2 | — | 60 | `stepType: attack` |
| 4 | mordant | dye-vat | linen_cloth ×1, alum ×1, water ×2 | mordanted_cloth ×1 | — | 300 | `stepType: time`; alum pre-treatment |
| 5 | dye | dye-vat | mordanted_cloth ×1, madder_powder ×1, water ×2 | red_linen ×1, spent_liquor ×1 | — | 400 | `stepType: time`; interesting step — mordant binds dye |

**Primitive verbs exercised:** dig, dry, grind, mordant, dye.

**Workstations introduced:** `drying-rack` (shared with many categories); `quern` (shared
with grain and pigment grinding); `dye-vat` (simpler than woad-vat — no ferment state,
just a heated liquor tub; see GAP-STATE).

**Byproducts and their fate:** spent_liquor → exhausted but tintable for weaker pink on a
second dip (a "spent liquor" input item could model this); ultimately discarded.

**Knowledge gating:** `requiredFragmentId: lore.dyeing.madder_craft`.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (temperature: >85 °C "browns" the red; a
narrow hot-but-not-boiling window is the whole craft), `GAP-ENV` (requires fuel-fed heat —
partially covered by fuel-input), `GAP-QUALITY`.

**Variants worth noting:** brazilwood (imported red), kermes (scale-insect crimson, luxury
tier), cochineal (post-Columbian, out of scope).

---

## Chain: Weld yellow dye

**Real-world context.** Weld (*Reseda luteola*, dyer's rocket) was the standard European
yellow, producing a clearer lightfast colour than onion skin, saffron, or turmeric. The
whole plant was boiled to extract luteolin onto mordanted cloth.

**Gameplay role.** Third primary dye colour. Combined over woad blue gives Lincoln green —
a canonical recipe for overdye combination. Cheap, widely gathered.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | pick | — | — | weld_plant ×N | — | — | Resource node |
| 2 | dry | drying-rack | weld_plant ×3 | dried_weld ×1 | — | 800 | `stepType: time` |
| 3 | mordant | dye-vat | linen_cloth ×1, alum ×1, water ×2 | mordanted_cloth ×1 | — | 300 | Shared with madder |
| 4 | dye | dye-vat | mordanted_cloth ×1, dried_weld ×2, water ×2 | yellow_linen ×1, spent_liquor ×1 | — | 300 | `stepType: time` |
| 5 | dye | dye-vat | yellow_linen ×1, woad_vat_charge ×1 | green_linen ×1 | — | 40 | Optional overdye → Lincoln green |

**Primitive verbs exercised:** pick, dry, mordant, dye.

**Workstations introduced:** (none new — reuses drying-rack and dye-vat).

**Byproducts and their fate:** spent_liquor; residual plant matter → compost.

**Knowledge gating:** trivial — freely known or gated on a general `lore.dyeing.fundamentals`
fragment shared with madder.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (same temp window as madder), `GAP-QUALITY`.
Low-novelty chain overall — justifies its place only because overdyeing is the canonical
colour-combination mechanic.

---

## Chain: Oak-gall iron-gallate ink

**Real-world context.** From roughly the 5th century through the 20th, Europe's primary
writing ink was made by steeping oak galls (insect-induced tannic growths) in water,
adding iron sulfate ("green vitriol" — a mining byproduct from pyrite-bearing ore), and
binding the resulting black iron-tannate with gum arabic. Every surviving medieval
manuscript was written in a variant of this ink.

**Gameplay role.** This is the **direct hook into Voxim's tome system**. `blank_tome` and
`tome` item templates already exist; no recipe currently converts one to the other. Oak-gall
ink is the consumable that lets a scribe transcribe a lore fragment onto a blank tome,
producing a teachable tome. Ties the lore-progression economy to a craftable reagent.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | oak_gall ×N | — | — | Resource node — gathered from oak trees |
| 2 | crush | mortar | oak_gall ×3 | crushed_galls ×1 | pestle | 0 | `stepType: attack` |
| 3 | steep | kettle | crushed_galls ×1, water ×2 | gall_liquor ×1 | — | 400 | `stepType: time`; tannic-acid extraction |
| 4 | combine | ink-bench | gall_liquor ×1, green_vitriol ×1, gum_arabic ×1 | oak_gall_ink ×2 | — | 80 | `stepType: assembly`; interesting step — iron-tannate complex forms black instantly |
| 5 | inscribe | scribe-desk | blank_tome ×1, oak_gall_ink ×1, quill ×1 | tome ×1 (with lore payload) | quill | 200 | `stepType: time`; `requiredFragmentId` = fragment being transcribed |

**Primitive verbs exercised:** gather, crush, steep, combine, inscribe.

**Workstations introduced:** `kettle` (hot-water extraction, shared with glue, dye baths,
herbal prep); `ink-bench` (low tier — really just a clean table); `scribe-desk`
(writing station, consumes ink and blank tome). `mortar` reused.

**Byproducts and their fate:** spent gall pulp → discard. Green vitriol comes from pyrite
weathering or as a byproduct of copper/iron smelting (the cross-chain: roasting pyrite
ore tailings on damp ground crystallises vitriol — could model as a "weathered pyrite"
resource node byproduct from mining). Gum arabic is an import trade good — in Voxim could
source from a specific tree resource node or from traders.

**Knowledge gating:** `lore.scribe.ink_making` for step 4; transcription step inherits the
target fragment's own learn-gate, which the scribe must themselves know to inscribe.

**Engine gaps exposed:** `GAP-QUALITY` (a master scribe's ink and hand produce a tome that
teaches more reliably or with a magnitude bonus — natural fit for Voxim's `outwardScale` /
`inwardScale`), `GAP-DURABILITY` (the quill wears — arguable whether worth modelling).
**New tag candidate:** `GAP-PAYLOAD-ITEM` — an item that carries per-instance data beyond
its template (the lore fragment being inscribed). Voxim items don't currently carry
instance metadata beyond material slots, so transcribed tomes are a structural challenge.

**Variants worth noting:** lamp-black ink (carbon ink, below) — simpler, less permanent;
cinnabar red ink for rubrics; Tyrian purple for imperial/ritual use (out of scope as a
regular chain, possibly a trader luxury).

---

## Chain: Mineral pigments & lamp black

Grouped because each is a short chain (2–3 steps) with the same shape: *extract raw →
grind/refine → pigment*. Documented as one entry with a variant table.

**Real-world context.** Pre-industrial painters and scribes drew their palette from a small
set of stable pigments: earth ochres (hydrated iron oxides, yellow to red-brown), umbers
(manganese-bearing earths, brown), lamp black (pure carbon soot), verdigris (copper acetate,
green), lead white (lead carbonate, the premier white), and cinnabar (mercury sulfide, red).
Each has a distinctive preparation; all are ground on a stone muller before use.

**Gameplay role.** Paints for buildings, banners, shields, and illumination of tomes. A
painter profession consuming pigments and linseed-oil-or-egg binder. Coloured shields in
particular read visibly in combat — high-impact cosmetics.

**Generic chain steps (lamp black as canonical):**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | combust | soot-lamp | pine_resin ×2 | lamp_soot ×1 | — | 600 | `stepType: time`; resinous fuel burns sooty; interesting step — a station whose *output is its smoke* |
| 2 | grind | muller-slab | lamp_soot ×1, linseed_oil ×1 | lamp_black_paint ×1 | muller | 80 | `stepType: attack`; pigment bound in oil |

**Variant table:**

| Pigment | Source | Distinctive step | Station | Ticks total | Notes |
|---------|--------|------------------|---------|-------------|-------|
| ochre / umber | earth node | wash + settle → levigation | settling-tub + muller-slab | ~400 | washing removes grit; cheap bulk pigment |
| cinnabar | mercury ore | grind only | muller-slab | ~60 | toxic (optional damage-on-handle hook) |
| verdigris | copper sheet + vinegar fumes | `suspend over vinegar` in sealed pot | verdigris-pot | ~2400 | blue-green patina scraped off; GAP-ENV (sealed), GAP-STATE (pot's progress), GAP-CONSUMED-STATION (copper slowly depleted) |
| lead white | lead sheet + vinegar + dung | stack in manure for heat | lead-stack-bed | ~3000 | warm-composting chamber; flakes scraped off; same gaps as verdigris + GAP-ENV (warmth from dung) |
| lamp black | resinous soot | collect soot from flame | soot-lamp | ~600 | the "output is smoke" mechanic |

**Primitive verbs exercised:** combust, grind, wash, suspend, scrape, levigate.

**Workstations introduced:** `muller-slab` (stone grinding surface — heavy shared pigment
tool); `soot-lamp` (resinous-fuel lamp that captures soot); `verdigris-pot` (sealed
vinegar-fume chamber); `lead-stack-bed` (manure-heated chamber); `settling-tub` (levigation
bath, reused for clay prep in ceramics category).

**Byproducts and their fate:** verdigris and lead white gradually *consume their own
feedstock* (the copper/lead sheet thins). Reusable station with a depleting input slot
fits the existing buffer model — not a gap. Cinnabar mining leaves mercury-tainted tailings;
could block resource nodes from certain other uses if we ever model contamination.

**Knowledge gating:** `lore.painter.pigments` for the whole family; cinnabar and lead white
as higher-tier fragments.

**Engine gaps exposed:** `GAP-ENV` (verdigris and lead white need sealed / warm chambers
that aren't really stations in the input-slot sense), `GAP-STATE` (slow transformation
progress on a standing "pot"), `GAP-PROCESS-PARAM` (warmth for lead white). Lamp black is
the cleanest candidate for authoring first: no env gaps, existing station model fits.

---

## Chain: Lye (wood-ash leach)

**Real-world context.** Dripping water through hardwood ash produces potassium-rich lye
(potash lye), the universal caustic of pre-industrial Europe — the base for soap, an
ingredient in woad vats, an alkaline for tanning, and a cleaner for dishes and textiles.
The ash-hopper (a slatted funnel) is one of the most common homestead fixtures.

**Gameplay role.** Foundational intermediate. Four or more downstream chains consume it;
this is the common trunk.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | collect | — | — | hardwood_ash ×N | — | — | Campfire/hearth byproduct — resource node on spent hearths or an output of campfire recipes |
| 2 | leach | ash-hopper | hardwood_ash ×3, water ×3 | lye ×1, spent_ash ×1 | — | 200 | `stepType: time`; percolation; interesting step — "water in at top, caustic out at bottom" |
| 3 | evaporate | kettle | lye ×3 | potash ×1 | — | 400 | `stepType: time`; optional — concentrates lye into shelf-stable solid potash |

**Primitive verbs exercised:** collect, leach, evaporate.

**Workstations introduced:** `ash-hopper` (shared with woad and soap chains); `kettle`
already introduced.

**Byproducts and their fate:** spent_ash → inert, field fertiliser or discard. Hardwood
ash itself is a campfire byproduct — retroactively adds an output to existing campfire
recipes (cooking with the campfire should yield 1 ash per N burns).

**Knowledge gating:** freely known — too fundamental to gate.

**Engine gaps exposed:** `GAP-QUALITY` (strong vs weak lye — pre-industrial chemists
tested with a floating egg; for Voxim just author two tiers as separate recipes). Generally
clean; good candidate for first implementation.

---

## Chain: Curd soap (saponification)

**Real-world context.** Boiling animal fat (tallow) with lye produces soap — a reaction
known empirically across Eurasia for millennia. Medieval European soapmaking centred on
Marseilles, Savona, and Castile, where olive oil replaced tallow for luxury soaps. Coarse
tallow+lye soap was a household staple.

**Gameplay role.** Cleaning consumable: removes grime stat on player, prep step for
parchment/linen processing (clean cloth dyes better), tanning auxiliary. A trade good in
its own right.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | render | kettle | raw_fat ×3 | tallow ×2, cracklings ×1 | — | 400 | `stepType: time`; overlaps with food/rendering chain |
| 2 | saponify | soap-cauldron | tallow ×2, lye ×2 | soap_batch ×1, glycerin_liquor ×1 | — | 800 | `stepType: time`; interesting step — exothermic reaction, historically judged by "tongue test" for residual caustic |
| 3 | cure | drying-rack | soap_batch ×1 | curd_soap ×4 | — | 1400 | `stepType: time`; long cure for hardness |

**Primitive verbs exercised:** render, saponify, cure.

**Workstations introduced:** `soap-cauldron` (could be unified with `kettle` — argue for a
distinct station only if we want a recognisable soap-boiling silhouette).

**Byproducts and their fate:** cracklings → food item (savoury, high calorie);
glycerin_liquor → medicinal / pharmaceutical ("sweet oil") in late medieval use, discard
in Voxim unless we want an apothecary hook.

**Knowledge gating:** `lore.household.soapmaking`.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (ratio of fat to lye determines whether soap
is caustic, balanced, or greasy — a genuine skill element; currently expressible only by
rigid recipe ratios), `GAP-QUALITY`.

---

## Chain: Hide / bone glue

**Real-world context.** Boiling collagen-rich animal parts (hide trimmings, sinew, bone,
cartilage) for hours yields gelatin that, when dried, is the strongest pre-industrial
adhesive — the glue that held medieval furniture, musical instruments, and bookbindings
together. Reversible with heat and moisture: a feature, not a bug, for furniture repair.

**Gameplay role.** Adhesive for wood joinery (reinforces joints beyond mechanical fit),
bookbinding (the tome chain's spine-and-cover step), composite bow lamination (horn + wood
+ sinew backed with glue — high-tier archery), parchment sizing.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | collect | — | — | hide_trimmings ×N, bones ×N | — | — | Byproduct of tanning and butchery |
| 2 | soak | soak-tub | hide_trimmings ×3, water ×2, lye ×1 | swollen_hides ×1 | — | 600 | `stepType: time`; alkaline pre-soak breaks down hair and fat |
| 3 | boil | kettle | swollen_hides ×1, water ×3 | glue_stock ×1, hide_scum ×1 | — | 800 | `stepType: time`; interesting step — long slow boil, never above simmer, historically 8+ hours |
| 4 | strain | strainer | glue_stock ×1 | clear_glue_liquor ×1, strainings ×1 | cloth_filter | 20 | `stepType: attack` |
| 5 | dry | drying-rack | clear_glue_liquor ×1 | glue_blocks ×2 | — | 1400 | `stepType: time`; shelf-stable dry blocks |
| 6 | reconstitute | kettle | glue_blocks ×1, water ×1 | hot_glue ×1 | — | 60 | `stepType: time`; at use-site; short-lived item that gates assembly recipes |

**Primitive verbs exercised:** collect, soak, boil, strain, dry, reconstitute.

**Workstations introduced:** `soak-tub` (shared with tanning and retting); `strainer` (or
fold into kettle station); dry-rack and kettle reused.

**Byproducts and their fate:** hide_scum → can be added back to successive batches (real
practice) or discarded. Strainings → compost. Glue is cross-category: joinery (wood),
bookbinding (tome chain), composite bows (archery).

**Knowledge gating:** `lore.glue.hide_craft`; bone glue variant on same fragment.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (too-hot boil hydrolyses the glue and weakens
it — another sub-boiling window craft), `GAP-STATE` (hot glue's time-limited usefulness —
it cools and sets; workaround: a short-lifetime `hot_glue` item with a decay timer, which
itself is **GAP-ITEM-LIFETIME** — items don't currently decay to other items on a timer).

**Variants worth noting:** fish glue (lower strength, longer open time, made from fish
skins/heads); isinglass (luxury, from sturgeon swim bladders — trader good); casein glue
(milk-based, simpler but weaker). One common chain template covers them.

---

## Chain: Birch tar

**Real-world context.** Destructive distillation of birch bark in a sealed vessel produces
a sticky black tar — the oldest known manufactured adhesive, used since the Middle
Palaeolithic to haft stone tools. Method: pack bark into an inverted pot sealed in a fire,
with a small drip hole; heat drives out tar which drips into a collector vessel.

**Gameplay role.** Primitive/early-tier adhesive and waterproofer. Hafts stone tools
before hide glue is available; overlap with wood-products category's pitch-and-rosin
(almost certainly covered there). Mention here for completeness; author in wood-products.

**Chain steps (summary — see wood-products for full):**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | birch_bark ×N | knife | — | Resource node / harvest |
| 2 | distil | tar-kiln | birch_bark ×4, wood ×2 | birch_tar ×1, char ×1 | — | 800 | `stepType: time`; dry distillation. Interesting step — chemistry from the Stone Age |

**Overlap flag:** pine tar / rosin / pitch are almost identical structurally and belong
in wood-products. Treat birch tar there as well and cross-reference this category only
for the chemistry taxonomy note.

**Engine gaps exposed:** `GAP-STATE` (kiln's "is it smoking yet?" progression),
`GAP-ENV` (needs an open fire pit).

---

## Chain: Beeswax rendering

**Real-world context.** Raw honeycomb from skep-kept bees was the dominant pre-industrial
source of high-quality wax. Cappings and spent comb were melted, strained through cloth,
and cast into blocks for storage. Beeswax is central to candle-making (higher-tier light
than tallow, no smoke), wax-tablet writing surfaces (monastic), official seals, and
lost-wax casting (jewellery, bells).

**Gameplay role.** Beeswax is structurally important across categories: candles (light
source that doesn't smoke → no stat debuff in shrine/tome reading), seal-wax (letter and
document mechanic if ever modelled), and **lost-wax casting** (bridge to bronze jewellery
and fine metalwork in the metallurgy category).

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | collect | — | — | raw_comb ×N, honey ×N | smoker | — | Resource node (beehive) — honey is food cross-output |
| 2 | melt | kettle | raw_comb ×3, water ×1 | melted_wax ×1, slumgum ×1 | — | 200 | `stepType: time`; melt under hot water to separate wax from debris |
| 3 | strain | strainer | melted_wax ×1 | clean_wax ×1, slumgum ×1 | cloth_filter | 20 | `stepType: attack` |
| 4 | cast | wax-mould | clean_wax ×1 | beeswax_block ×1 | — | 40 | `stepType: time`; pour and cool |
| 5 | form | chandler-bench | beeswax_block ×1, wick ×1 | beeswax_candle ×4 | — | 80 | `stepType: assembly`; dipped candle |

**Primitive verbs exercised:** collect, melt, strain, cast, form.

**Workstations introduced:** `wax-mould` (cheap repeat-use casting frame — distinct from
foundry moulds); `chandler-bench` (candlemaker's dipping/moulding station).

**Byproducts and their fate:** honey → food/mead; slumgum (dark residue of bee debris) →
fire-starter or discarded. Wick is a separate cross-chain (spun linen, see textiles).

**Knowledge gating:** freely known — ubiquitous craft. Chandler variants (tapered, moulded,
scented) on `lore.chandler.fine_candles`.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (temperature on melt — too hot discolours
wax), `GAP-QUALITY` (hand-dipped count and evenness — a craft skill). Very clean structural
fit otherwise.

---

## Chain: Aqua vitae (distilled spirits)

**Real-world context.** Distillation of wine by alchemists — notably Abulcasis in
10th-century al-Andalus and later Taddeo Alderotti and Arnaldus of Villanova —
concentrated alcohol into "water of life", first as a medicine and preservative, later
as a social drink. Late-medieval addition to the European chemistry toolkit; a
prerequisite for many later alchemy recipes.

**Gameplay role.** Alchemical solvent (dissolves herbs to make tinctures, extracts
essential oils, preserves biological specimens), medicine consumable, fire-bomb reagent,
trader good. Opens a late-game alchemy tier.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | ferment | fermenting-vat | grain ×3, water ×3, yeast ×1 | wash ×2 | — | 2000 | `stepType: time`; overlap with brewing chain (cross-reference food/drink category) |
| 2 | distil | alembic-still | wash ×2 | aqua_vitae ×1, spent_wash ×1 | — | 600 | `stepType: time`; interesting step — the first genuine distillation station. Two tiers of output (first and second distil) is a redistil chain |
| 3 | distil | alembic-still | aqua_vitae ×2 | rectified_spirit ×1, weak_tails ×1 | — | 400 | Optional second-pass — chain via `chainNextRecipeId` from step 2 if pure spirit is the target |

**Primitive verbs exercised:** ferment, distil.

**Workstations introduced:** `fermenting-vat` (shared with brewing); `alembic-still`
(copper pot still with condenser — visually distinctive late-game station).

**Byproducts and their fate:** spent_wash → livestock feed or compost; weak_tails →
recycled into the next batch (can be modelled as input alternates to step 1).

**Knowledge gating:** `lore.alchemy.aqua_vitae` — late-tier alchemist gate.

**Engine gaps exposed:** `GAP-PROCESS-PARAM` (head/heart/tails separation depends on
steady heat — currently a single flat ticks value), `GAP-QUALITY` (a careful distiller
cuts better spirit; natural fit for a skill scalar).

**Variants worth noting:** brandy (from wine), gin-like juniper infusions (post-1500
proper, but juniper-infused spirits existed earlier), herb-infused cordials (two-step:
distil then macerate).

---

## Chain: Saltpeter (nitre) extraction

**Real-world context.** Potassium nitrate was scraped from cellar walls, old middens,
dovecotes, and deliberately built "nitre beds" (compost heaps inoculated with manure and
straw). The scrapings were leached with water, the liquor boiled with wood ash to convert
calcium nitrate to potassium nitrate, and the resulting solution crystallised. A
late-medieval entry into European chemistry (via China and the Islamic world),
overwhelmingly associated with gunpowder.

**Gameplay role.** Voxim doesn't want firearms. But saltpeter is also a preservative
(salpetering meat), a flux in glassmaking and some metallurgy, and plausibly a
fire-magic / ward reagent for the skill/lore system — a consumable that boosts or
unlocks fire-aspected lore fragments. Lets us keep the chain without committing to
gunpowder.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | scrape | — | — | nitre_earth ×N | shovel | — | Resource node placed on old cellars, dovecotes, or constructed nitre-beds |
| 2 | leach | ash-hopper | nitre_earth ×3, water ×3 | crude_nitre_liquor ×1, spent_earth ×1 | — | 300 | `stepType: time`; shared leach station |
| 3 | boil | kettle | crude_nitre_liquor ×1, hardwood_ash ×1 | refined_nitre_liquor ×1 | — | 400 | `stepType: time`; interesting step — double-decomposition (Ca(NO₃)₂ + K₂CO₃ → KNO₃ + CaCO₃), historically empirical |
| 4 | crystallise | crystallising-tub | refined_nitre_liquor ×1 | saltpeter ×1, bitter_water ×1 | — | 2400 | `stepType: time`; slow evaporative crystallisation. GAP-ENV (cool ambient favours crystals) |

**Primitive verbs exercised:** scrape, leach, boil, crystallise.

**Workstations introduced:** `crystallising-tub` (shallow evaporative basin — also useful
for salt, alum, copper sulfate); potentially a placeable `nitre-bed` (deliberately built
rot heap — its own "grows over time" station, which is **GAP-STATE** writ large).

**Byproducts and their fate:** spent_earth → field fertiliser (nitrogen-rich residue);
bitter_water → brine, mild preservative or discard. Calcium carbonate precipitates in
step 3 — could output `chalk ×1` as a minor byproduct feeding whitewash / lime chains.

**Knowledge gating:** `lore.alchemy.nitre_extraction` — late-tier.

**Engine gaps exposed:** `GAP-STATE` (nitre-bed as a slowly maturing station producing
feedstock over days is the whole craft — the sharpest gap-state example in the
category alongside woad-vat), `GAP-ENV` (cool crystallisation; sheltered beds), `GAP-BATCH`
(real nitre works processed barrel-loads).

---

## Variants and minor chains

- **Alum mining/mordant prep.** Geologically sourced (volcanic alunite) or extracted from
  alum shale by roasting + leaching + crystallising. Sub-chain shape is identical to
  saltpeter (scrape → leach → crystallise); author as a variant rather than a separate full
  entry. Alum is the critical mordant for every dye chain above.
- **Green vitriol (iron sulfate).** Pyrite weathering or pyrite-roasting byproduct →
  crystallise. Needed for oak-gall ink. Sub-chain of mining/smelting byproduct flow.
- **Vinegar.** Aerobic fermentation of weak wine or beer over weeks. Needed for verdigris
  and lead white and many cooking recipes. Overlap with food/drink category — author there.
- **Isinglass.** Luxury fish glue from sturgeon bladders; one recipe variant of the hide
  glue template.
- **Egg tempera binder.** Egg yolk + water + pigment → tempera paint. Single-step combine;
  mention only.
- **Linseed oil binder.** Press flax seeds → oil; overlap with food/textile category where
  flax is processed.
- **Tyrian purple.** Murex snails → painstaking small-batch dye → imperial/ritual purple.
  Trader-only luxury. Mention as a purchasable reagent rather than an authored chain.

---

## Category summary

- **Verbs used:** pick, dig, gather, scrape, collect, crush, pound, grind, steep, leach,
  ferment, age, mordant, dye, oxidise, render, saponify, cure, soak, boil, strain, dry,
  reconstitute, distil, melt, strain, cast, form, evaporate, crystallise, combust, suspend,
  inscribe. New-to-category verbs: `leach`, `mordant`, `saponify`, `oxidise`, `distil`,
  `crystallise`, `inscribe` — all chemistry-adjacent and reusable in metallurgy
  (leach/crystallise), food (ferment/distil), and lore (inscribe).
- **Workstations introduced:** `mortar`, `quern`, `kettle`, `drying-rack`, `dye-vat`,
  `woad-ball-rack`, `woad-vat`, `ash-hopper`, `soak-tub`, `strainer`, `soap-cauldron`,
  `muller-slab`, `soot-lamp`, `verdigris-pot`, `lead-stack-bed`, `settling-tub`, `ink-bench`,
  `scribe-desk`, `wax-mould`, `chandler-bench`, `fermenting-vat`, `alembic-still`,
  `crystallising-tub`, `tar-kiln`. Many will be shared with adjacent categories (textiles,
  food, metallurgy) — synthesis will dedupe.
- **Primitives consumed:** woad_leaves, madder_root, weld_plant, oak_gall, linen_cloth,
  raw_fat, hide_trimmings, bones, birch_bark, raw_comb, grain, yeast, nitre_earth,
  green_vitriol (from pyrite), gum_arabic (trader), alum (own sub-chain), water, hardwood_ash
  (campfire byproduct), pine_resin, copper_sheet, lead_sheet, mercury_ore, earth_pigments
  (ochre/umber nodes), stale_urine (settlement resource).
- **Byproducts exported:**
  - **ink → lore/tomes** (direct Voxim hookup — closes the blank_tome→tome gap and
    consumes a player-authored ink chain, tying the lore-progression economy to craft).
  - **lye → household, soap, tanning, woad vat, saltpeter refinement** (the common trunk
    intermediate for the whole category).
  - **alum → textiles** (mordant for every dye; trivial to gate dyeing on a working alum
    supply).
  - **pigments → decoration/paint** (building cosmetics, shield heraldry, tome illumination).
  - **beeswax → lost-wax casting (metallurgy), candles (light), seals (documents if
    modelled)**.
  - **glue → wood joinery, bookbinding/tomes, composite bows (archery)**.
  - **saltpeter → fire-magic / ward reagent (Voxim's lore system)**, glass flux,
    meat-preservative.
  - **soap → cleaning, tanning auxiliary, parchment prep**.
  - **honey (beeswax byproduct) → food, mead**; **cracklings (soap rendering) → food**;
    **chalk (nitre boil) → whitewash, lime**.
- **Top engine gaps:**
  - **GAP-STATE** (woad-vat, nitre-bed, verdigris-pot, lead-stack-bed, glue-kettle) — the
    category's defining gap. Most chemistry chains want a station that has *its own
    lifecycle* beyond input-buffer-plus-timer: a vat that is alive or dead, a bed that
    matures and exhausts, a pot whose progress is readable at a glance. Every major chain
    in this category exposes it. Highest-priority engine work to close if any of these
    chains are authored at depth.
  - **GAP-PROCESS-PARAM** (madder temp, weld temp, soap fat:lye ratio, glue sub-boil,
    distillation cut, wax melt temp) — chemistry is *chemistry* precisely because the
    parameters matter. Workaround via multiple graded recipes is serviceable but flattens
    craft skill.
  - **GAP-ENV** (woad ferment needs warmth, oxidation needs open air, nitre beds need
    cool cellars, lead white needs composting warmth) — complements GAP-STATE; many of the
    standing stations are defined by their environment.
  - **GAP-QUALITY** (dyer's master blue, scribe's hand, candlemaker's evenness) — every
    artisan craft in this category has a quality axis. The lore system already has
    `outwardScale` / `inwardScale`, so a natural path forward is to let recipes produce
    items with quality fields that downstream systems can consume the way lore magnitudes
    already do.
  - **GAP-PAYLOAD-ITEM (new)** — the tome inscription step requires items to carry
    per-instance payload data beyond material slots. Unique to the ink/tome chain in this
    category, but the pattern recurs (sealed letters, signed contracts, named weapons) and
    is worth naming now.
