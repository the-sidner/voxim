# Wood, Bark & Pyrolysis

**Scope & gameplay role.** Wood is the most abundant primitive resource in any pre-industrial
economy — structural, fuel, and the feedstock for almost every destructive-distillation product
a pre-1500 craftsperson depends on. This category contributes three gameplay roles: (1) shaped
wooden goods beyond the trivial plank/beam (staves, shingles, handles, bowls, barrels), (2)
charcoal — the one fuel hot enough to smelt iron and bronze, which means metallurgy loops back
into this catalog on day one, and (3) a family of pyrolysis and leachate byproducts (tar,
pitch, rosin, potash, tannin, wood vinegar, birch tar) that are the chemical glue of the
whole simulation: waterproofing, adhesives, dye mordants, glass flux, leather tanning, soap
lye. Player archetypes served: homesteader (firewood, coopering, lye for soap), specialist
(collier burning charcoal for weeks at a stretch, tar-burner), and trader (barrel staves,
charcoal, potash are high-volume trade commodities).

Voxim already has the trivial `wood → plank` recipe via `chopping_block` (see
[packages/content/data/recipes/plank.json](../../packages/content/data/recipes/plank.json)). All
chains below extend beyond that anchor.

**Chains documented.**

1. **Riving staves & shingles** — froe + mallet along the grain; the input for coopering and
   roofing. Faster than sawing, grain-aligned.
2. **Cooperage (tight barrel)** — shape staves, raise around hoops, toast the interior, head it.
   The critical liquid container for brewing, brining, salt pork and long-haul trade.
3. **Pole-lathe turning** — treadle-powered lathe producing bowls, cups, tool handles, spindles.
   New workstation with a distinctive rhythm.
4. **Charcoal burning (clamp/pit)** — the economic backbone. Days of slow pyrolysis in an
   earth-sealed stack; the only game fuel that drives metallurgy.
5. **Tar burning (tjärdal)** — resinous pine in a funnel pit, slow dry-distillation, pine tar
   drains to a spout. Waterproofing for cooperage, rope, leather, ships.
6. **Pitch & rosin refining** — boil tar to drive off volatiles; short, hot, interactive step.
7. **Birch-bark tar** — oldest known adhesive, distilled from rolled bark. Primitive-tech
   hafting glue; valuable before metal hafts.
8. **Potash from wood ash** — leach hardwood ash, evaporate lye. Feeds soap, glass flux, dye
   mordanting.
9. **Tannin liquor from oak/chestnut bark** — strip, crush, soak. The liquor that feeds
   vegetable tanning in the leather category.

---

## Chain: Riving staves & shingles

**Real-world context.** Across medieval Europe coopers, shinglers and tool-haft makers split
green wood along the grain with a froe (a long L-handled wedge) driven by a mallet, supported
on a brake or shaving horse. Grain-aligned splits are vastly stronger than saw-cut boards of
the same thickness and waste no sawdust. Oak, chestnut, cedar and pine were preferred; the
output is called a clave, clapboard, shingle, or barrel stave depending on dimension.

**Gameplay role.** Produces `stave` (cooperage input) and `shingle` (roofing material beyond
`plank_wall`). Opens specialist wooden goods that plain planks cannot substitute for. Voxim
currently has `plank` and `plank_wall` only — staves and shingles would be new itemTypes.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | wood ×N | axe | — | Anchor: existing felling node |
| 2 | season | drying_rack | wood ×4 | seasoned_wood ×4 | — | 1800 | `stepType: time`; ~1.5 min compress of months of air-drying |
| 3 | rive | riving_brake | seasoned_wood ×1 | stave ×4, offcut ×1 | froe | 0 | `stepType: attack`; each strike cleaves one stave |
| 3' | rive | riving_brake | seasoned_wood ×1 | shingle ×6, offcut ×1 | froe | 0 | Alternate assembly output from same station |

**Primitive verbs exercised:** gather, season, rive.

**Workstations introduced:** `drying_rack` (open-air rack for air-drying green wood; reused by
tanning and herbal chains), `riving_brake` (shaving horse / brake supporting the billet while
the froe is driven).

**Byproducts and their fate:** `offcut` → kindling / campfire fuel, trivial recycle into
existing `coal` (kindling) chain. Green-wood `bark` stripped pre-rive → feeds tannin or
cordage chains.

**Knowledge gating:** none; basic woodcraft.

**Engine gaps exposed:** `GAP-QUALITY` (straight-grained oak gives cleaner staves than knotty
pine; no way to express stave quality), `GAP-CHECKPOINT` mild (ideally each strike produces one
stave until the billet is exhausted — workaround is a single recipe yielding four).

**Variants worth noting:** chestnut shingles (rot-resistant, preferred in wet climates), cedar
shingles (same). Treat as material-slot substitutions rather than new chains.

---

## Chain: Cooperage — tight barrel

**Real-world context.** Tight cooperage (watertight barrels for wine, beer, oil, brine)
dominates medieval liquid storage and shipping. The cooper hollows and tapers riven staves
with drawknives, assembles them upright inside a temporary iron hoop, heats the interior over
a brazier to make the wood bend (the "firing" or "toasting"), draws the ends together with a
windlass, cuts the croze groove, drops in the heads, and fits permanent wooden or iron hoops.
Staves must be oak (for tannin/waterproofing) and green-enough to bend without cracking.

**Gameplay role.** Produces `barrel` — the canonical bulk liquid container. Required input
for brewing chains (mash/ferment buffer), brining (salt pork, sauerkraut), dry-goods shipping,
water storage. No equivalent exists in Voxim today.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | shape | shaving_horse | stave ×16 | shaped_stave ×16, shavings ×1 | drawknife | 0 | `stepType: attack`; hollow and bevel staves |
| 2 | forge | anvil | iron_ingot ×1 | hoop ×4 | hammer | 0 | Existing smithing path; or purchase |
| 3 | assemble | cooper_workbench | shaped_stave ×16, hoop ×2 | raw_barrel ×1 | mallet | 0 | `stepType: assembly`; raise staves inside setup hoops |
| 4 | apply-heat | cooper_workbench | raw_barrel ×1 | toasted_barrel ×1 | — | 200 | `stepType: time`; interior fire bends the wood; `chainNextRecipeId` from step 3 |
| 5 | assemble | cooper_workbench | toasted_barrel ×1, hoop ×2, plank ×2, pine_pitch ×1 | barrel ×1 | drawknife | 0 | Cut croze, head it, pitch the seams |

**Primitive verbs exercised:** shape, forge (delegated), assemble, apply-heat.

**Workstations introduced:** `shaving_horse` (foot-clamped shaving bench; shared with riving
brake? — design choice), `cooper_workbench` (multi-phase station holding the half-built barrel
through toasting + heading).

**Byproducts and their fate:** `shavings` → kindling / stuffing. Failed barrels
("stove-in") → break to staves and hoops (not modelled; treat as durability loss on finished
barrel).

**Knowledge gating:** `fragment_cooperage` — cooperage is a specialist trade; gate behind a
lore fragment gained from an NPC cooper or a recipe book to preserve trade-good value.

**Engine gaps exposed:** `GAP-STATE` (the "toasting" step really wants an ongoing fire on the
station, not an input item), `GAP-CHECKPOINT` (real coopering is one continuous choreography;
we split it into 3 recipes which is acceptable but loses the windlass-tightening moment),
`GAP-QUALITY` (a skilled cooper's barrel does not leak; a novice's does — no way to model).

**Variants worth noting:** slack cooperage (dry goods — flour, nails, apples) skips the
toasting step and uses looser staves; treat as a simpler recipe on the same station. Puncheons,
hogsheads, tuns are size variants — all the same recipe scaled.

---

## Chain: Pole-lathe turning

**Real-world context.** The pole lathe is a treadle-and-springpole machine: the workpiece
spins on two centres, a rope wrapped around it is pulled by a foot treadle, and a springy
sapling overhead returns the treadle. Each downstroke is a cutting stroke; the upstroke idles.
Medieval "bodgers" used them in the woods to turn chair legs, spindles, bowls, cups and tool
handles directly from green wood — no mains power, no heavy tooling, highly portable.

**Gameplay role.** Produces `bowl`, `cup`, `handle` (tool hafting blank), and `spindle`
(required input for spinning wheels / textiles chain). Introduces a workstation with a
distinctive treadling rhythm and serves the cottager/specialist niche that is not combat-coded.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | turn | pole_lathe | wood ×1 | bowl ×1, shavings ×1 | gouge | 0 | `stepType: attack`; each swing is a treadle cycle |
| 1' | turn | pole_lathe | wood ×1 | handle ×4, shavings ×1 | gouge | 0 | Assembly-style: choose output |
| 1'' | turn | pole_lathe | wood ×1 | spindle ×2, shavings ×1 | skew_chisel | 0 | Alternate tool path |

**Primitive verbs exercised:** turn.

**Workstations introduced:** `pole_lathe` — two-centre green-wood lathe with treadle
animation.

**Byproducts and their fate:** `shavings` → kindling. Trivial absorb.

**Knowledge gating:** none for bowls; `fragment_turnery` for fine spindles and cups could gate
trade-grade output.

**Engine gaps exposed:** `GAP-DURABILITY` (gouges and skews go dull quickly in reality — a
bodger sharpens every 10 minutes), `GAP-QUALITY` (a master-turned bowl is thinner-walled and
worth more than a novice's; we have no per-craft quality). Otherwise a clean fit.

**Variants worth noting:** bow-lathe (one-handed, even more primitive) is a substitutable
workstation for the same recipes at slower tick rate — don't document separately.

---

## Chain: Charcoal burning (clamp / pit)

**Real-world context.** Colliers stacked cordwood into a domed "clamp" ~3–5 m across, covered
it with turf and earth leaving only small vents, and ignited it from a central chimney. The
pile burned anaerobically for 5–10 days, the collier adjusting vents around the clock to keep
the burn smouldering without flaring. The output is charcoal — a clean, hot, low-smoke fuel
that reaches temperatures no unworked firewood can, and the single non-negotiable prerequisite
for bloomery iron, bronze, and glass. Historically this was a specialist forest trade, with
colliers living in huts beside their clamps for the entire burn.

**Gameplay role.** Produces `charcoal`, the required fuel input for the existing iron and
copper smelting chains (currently fed by `coal` aliased from kindling). This is the ECONOMIC
BACKBONE of the whole catalog: every metal item in the game flows through charcoal. Byproducts
(wood tar, wood vinegar) open optional chemistry depth.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | wood ×many | axe | — | Realistic clamps took a cord (~3 m³); gameplay-compressed |
| 2 | assemble | — | wood ×20 | charcoal_clamp (workstation) ×1, turf ×4 | shovel | 0 | The clamp IS a built workstation; consumes the fuel as it builds |
| 3 | combust | charcoal_clamp | kindling ×1 | — | — | — | Ignite step; no direct output, transitions station to burning state |
| 4 | apply-heat | charcoal_clamp | — | charcoal ×12, wood_tar ×1, wood_vinegar ×1, ash ×2 | — | 800 | `stepType: time`; slow pyrolysis (~40s compress of ~1 week) |
| 5 | — | — | charcoal_clamp (consumed) | — | shovel | 0 | Station self-destructs on recipe completion — GAP-CONSUMED-STATION |

**Primitive verbs exercised:** gather, assemble, combust, apply-heat.

**Workstations introduced:** `charcoal_clamp` — large single-use earth-covered stack. Visible
dome. Emits smoke particles during burn phase.

**Byproducts and their fate:**
- `wood_tar` → input for rope waterproofing, inferior to pine tar; also a dilute ingredient
  for hafting glue.
- `wood_vinegar` → dilute pyroligneous acid; feeds a possible mordanting chain (fixes dyes)
  and primitive pesticide / fungicide.
- `ash` → straight into the potash chain below. Charcoal burning is itself a net ash producer
  even though the target product is un-oxidised carbon.

**Knowledge gating:** `fragment_collier` — colliery is specialist; gate to preserve its
identity as a trade. Alternatively keep it open; it's arguably foundational enough to be
freely learned.

**Engine gaps exposed:**
- `GAP-BATCH` **prime example.** Clamps are big one-shot affairs — you do not build a clamp
  per log. Voxim's current recipe model is "one unit in, one unit out"; scaling output
  quantities is the workaround, but the ratio here (20 wood → 12 charcoal + byproducts over
  one long tick) stretches the system further than typical.
- `GAP-ENV` **prime example.** Real clamps fail in heavy rain (water breaches the turf cap)
  and in high wind (fire flares up and consumes everything instead of carbonising). No way to
  express weather-sensitivity today.
- `GAP-CONSUMED-STATION` **prime example.** The clamp is destroyed on successful completion.
  Today's workaround is "the workstation prefab is the input", treating it as an item that
  yields on use; this loses the ongoing-process visual.
- `GAP-STATE` — a real collier walks the clamp 24/7 plugging breaches. We have no "tend the
  fire" interactive layer; burn is atomic.
- `GAP-CHECKPOINT` mild — venting is a mid-burn intervention ideally modelled as a
  partial-progress check; current workaround of decomposing into light/burn/open phases via
  `chainNextRecipeId` is acceptable.

**Variants worth noting:** retort kiln (a closed metal vessel distilling the wood) gives
higher charcoal yield AND recoverable tar/vinegar — historically late-medieval Scandinavia.
A second-tier unlock once the player has iron to build the retort.

---

## Chain: Tar burning (tjärdal)

**Real-world context.** Across Scandinavia and northern Russia, peasants dug funnel-shaped pits
5–10 m across, lined them with stone and clay, packed them with finely split resinous pine
stumps and roots (fat-wood), sealed the top with turf, and burned the pile for 3–4 days. The
pit's funnel sloped to a central clay spout; as the wood dry-distilled, liquid pine tar
(rich in terpenes) drained out through the spout into waiting barrels. The product was
essential — "Stockholm tar" was exported across Europe for caulking ship hulls, waterproofing
rope, protecting leather, and preserving wooden shingles.

**Gameplay role.** Produces `pine_tar`, the universal waterproofing agent. Consumed by:
cooperage (seam-pitching), rope-making (marine rope), leather (waterproof boots), building
(shingle and fence preservation). Without tar, wooden goods rot in wet climates — this becomes
a soft durability modifier in the cooperage and textile chains.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | fatwood ×N | axe | — | Fat pine stumps/roots — a distinct resource node from plain wood |
| 2 | rive | riving_brake | fatwood ×1 | fatwood_splits ×4 | froe | 0 | Fine splits expose max resin surface |
| 3 | assemble | — | fatwood_splits ×16, turf ×4, clay ×2 | tar_pit (workstation) ×1 | shovel | 0 | Build the funnel pit |
| 4 | combust | tar_pit | kindling ×1 | — | — | — | Ignite |
| 5 | apply-heat | tar_pit | — | pine_tar ×6, charcoal ×4, ash ×1 | — | 600 | `stepType: time`; slow dry-distillation |

**Primitive verbs exercised:** gather, rive, assemble, combust, apply-heat.

**Workstations introduced:** `tar_pit` — funnel-shaped turf-capped pit with a clay drain
spout. Single-use like the charcoal clamp.

**Byproducts and their fate:**
- `charcoal` secondary yield — the resin-depleted wood residue is still carbon. Feeds
  metallurgy.
- `ash` → potash chain.

**Knowledge gating:** `fragment_tar_burning` — specialist. Northern / forest regions might
ship tar as a trade good to southern players.

**Engine gaps exposed:**
- `GAP-BATCH`, `GAP-ENV`, `GAP-CONSUMED-STATION`, `GAP-STATE` — identical profile to charcoal
  burning; these two chains together make the strongest case for addressing large single-use
  outdoor process stations as a first-class concept.
- `GAP-PROCESS-PARAM` — quality depends on burn temperature; too hot burns the tar off as
  smoke; too cool leaves water in it. We can't express this without continuous parameters.

**Variants worth noting:** `birch tar` (below) uses the same logic but on bark, yielding a
stickier adhesive. `juniper tar` and `beech tar` are regional alternates — material-slot
substitutions.

---

## Chain: Pitch & rosin refining

**Real-world context.** Raw pine tar is a viscous, volatile-rich liquid. Boiling it in an open
cauldron drives off the light fractions (turpentine) as vapour, leaving thicker pitch (a
plastic black solid that softens with heat — the archetypal "pitch the seams" material) and
eventually, if boiled further, hard brittle rosin (crystallises on cooling, used as archer's
string wax, violin-bow rosin centuries later, and a flux for soldering).

**Gameplay role.** Produces `pine_pitch` (seam-sealer, firmer than tar; consumed by cooperage,
boatbuilding) and `rosin` (archery performance modifier, soldering flux, torch binder). A
short interactive step compared to the multi-day burns preceding it.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | apply-heat | cauldron | pine_tar ×2, kindling ×1 | pine_pitch ×1, turpentine ×1 | — | 80 | `stepType: time`; short boil |
| 2 | apply-heat | cauldron | pine_pitch ×2, kindling ×1 | rosin ×1, turpentine ×1 | — | 80 | Chained from step 1 optionally; further boil drives off more volatiles |

**Primitive verbs exercised:** apply-heat (sustained boil).

**Workstations introduced:** `cauldron` — open iron pot over a firebox. Reused by
soap-making, cheese-making, dye vats, potash evaporation; high reuse value.

**Byproducts and their fate:**
- `turpentine` → solvent for the nascent paints-and-varnish chain, also a medicinal tincture
  in some traditions. Stores as a flammable liquid (see glass/ceramics for bottle container).

**Knowledge gating:** none — if you have tar, refining it is obvious once known.

**Engine gaps exposed:**
- `GAP-PROCESS-PARAM` — the difference between pitch and rosin is "how long you boil"; we
  already fake this with two recipes.
- `GAP-STATE` — ideally the cauldron shows "is boiling" as ongoing state; currently implicit.

---

## Chain: Birch-bark tar

**Real-world context.** Birch bark dry-distilled in the absence of air produces a sticky
black tar — betulin-rich, archaeologically the earliest known synthetic adhesive (Neanderthal
tools from ~200 000 BP, modern humans throughout the Mesolithic). Traditional method: roll
bark into a tight cylinder, place upside-down in a pit over a collection dish, cover with a
second inverted pot, seal with clay, build a fire over the whole thing. The tar drips down
as the bark cooks.

**Gameplay role.** Produces `birch_tar` — an adhesive ingredient for primitive hafting
(stone axe heads onto handles, flint arrowheads onto shafts) and early-game repair compound.
Gameplay-distinctive as a pre-metal adhesive: the player who has not yet reached ironworking
can still haft composite tools with it. In Voxim today `stone_axe` and `stone_pickaxe` are
one-recipe crafts — birch tar opens a more believable primitive-tech tier.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | peel | — | birch_wood ×1 | birch_bark ×4, stripped_wood ×1 | knife | 0 | `stepType: attack` at a resource node; stripped trunk still yields wood |
| 2 | assemble | — | birch_bark ×4, clay ×1 | bark_retort ×1 | — | 0 | Small disposable clay-sealed retort |
| 3 | apply-heat | campfire | bark_retort ×1, kindling ×1 | birch_tar ×1, bark_char ×1 | — | 120 | `stepType: time`; compact dry-distillation |

**Primitive verbs exercised:** peel, assemble, apply-heat.

**Workstations introduced:** none new — reuses existing `campfire`. The clay retort is an
item, per `GAP-CONSUMED-STATION` workaround described in the engine gap taxonomy.

**Byproducts and their fate:**
- `bark_char` → trivial fuel or discard. Historically scraped off and reused as pigment.
- `stripped_wood` from step 1 → still feeds the normal `plank` chain at reduced quality.
  Opens a balance question: if bark peels are free, do players over-harvest birch? (Coppicing
  resource-management note below addresses this.)

**Knowledge gating:** `fragment_primitive_adhesive` — or freely known as a stone-age basic.

**Engine gaps exposed:**
- `GAP-QUALITY` — birch tar hafts degrade with heat/sun; modelled here as "it just works",
  which loses the interesting trade-off vs later iron rivets.

**Variants worth noting:** `spruce pitch`, `larch resin` — bleed directly from the tree
(gather, don't distill); simpler one-step recipes that serve the same adhesive role at lower
potency.

---

## Chain: Potash from wood ash

**Real-world context.** Hardwood ash soaked in water produces a strongly alkaline lye; boil
the lye down and you get potash crystals (potassium carbonate). Medieval monasteries and
villages produced it at scale — it was the flux that made clear glass, the lye that saponified
fat into soap, and the mordant that fixed red and blue dyes to wool. Ash was literally
collected by sweeping hearths and burning specific ash-rich plants. "Ashery" was a recognised
rural trade in Scandinavia, Russia, and colonial North America.

**Gameplay role.** Produces `lye` (intermediate) and `potash` (storable crystalline form).
Potash is the chemical hub of the game's mid-tier crafting: soap requires it, clear glass
requires it, vegetable-dye mordanting requires it. Pulls ash — an otherwise discarded
byproduct of campfires, kilns, and charcoal burns — back into the economy.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | leach | leach_barrel | ash ×4, water ×2 | lye ×1, spent_ash ×1 | — | 300 | `stepType: time`; water slowly percolates through ash bed |
| 2 | apply-heat | cauldron | lye ×2, kindling ×1 | potash ×1, steam ×0 | — | 150 | Evaporate water off, leaving crystalline K₂CO₃ |

**Primitive verbs exercised:** leach, apply-heat.

**Workstations introduced:** `leach_barrel` — a pierced-bottom barrel on a stand with a
collection trough. Shares cooperage dependency; you need to have built barrels before you
leach at scale. Nice cross-chain gating.

**Byproducts and their fate:**
- `spent_ash` → soil amendment (if a farming chain exists) or discard. Not reusable for a
  second leach.
- `lye` as an intermediate — also directly consumable as "lye water" for soap without drying
  to potash. Having both items gives the player a choice of portable crystal vs bulk liquid.

**Knowledge gating:** none — foundational.

**Engine gaps exposed:**
- `GAP-QUALITY` — "softwood vs hardwood ash" matters: hardwood gives much higher potassium.
  Workaround: two separate recipes or material-slot input.
- `GAP-BATCH` — real asheries ran big leach tubs; we're fine scaling the numbers.

**Variants worth noting:** `soda ash` from seaweed / saltwort plant ash — higher sodium, used
in Mediterranean glassmaking. Treat as a material variant feeding the same glass-flux slot.

---

## Chain: Tannin liquor from bark

**Real-world context.** Oak and chestnut bark contain 8–15% tannins — polyphenolic compounds
that cross-link collagen, turning raw skin into durable leather. Medieval tanneries stripped
bark from felled oaks (a byproduct of timber cutting), ground it under edge-runner mills or by
hand-pounding, and steeped it in cold water in layered pits with raw hides for 6–24 months.
The first step of that — making the liquor itself — is a stand-alone wood/bark chain; the hide
side belongs to the leather catalog.

**Gameplay role.** Produces `tannin_liquor`, the consumed input for the vegetable-tanning
step in the leather category. Without this, Voxim has no historically grounded path to
leather armour or leather goods. Also: pulls oak `bark` — another otherwise-discarded byproduct
of felling — into the economy.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | peel | — | oak_wood ×1 | bark ×3, stripped_wood ×1 | knife | 0 | Resource-node step, same pattern as birch |
| 2 | crush | grinding_bench | bark ×3 | bark_meal ×3 | mallet | 0 | `stepType: attack` — pound to expose tannin |
| 3 | leach | leach_barrel | bark_meal ×3, water ×2 | tannin_liquor ×2, spent_bark ×1 | — | 600 | Cold soak, ~30s compress of days |

**Primitive verbs exercised:** peel, crush, leach.

**Workstations introduced:** `grinding_bench` (crushing surface — potentially shared with
herbal / pigment chains), `leach_barrel` (as above).

**Byproducts and their fate:**
- `spent_bark` → compost / discard.
- `stripped_wood` — still feeds plank chain; incentive to bark-strip all felled oaks before
  chopping, which is thematically accurate.

**Knowledge gating:** `fragment_tanning` — if gated, this also gates the entire leather
category. Probably open it freely; leather is table-stakes.

**Engine gaps exposed:**
- `GAP-BATCH` — tanpits held hundreds of hides; we scale via recipe quantity.
- `GAP-QUALITY` — chestnut liquor gives darker leather than oak; recipe-per-species
  workaround.

**Variants worth noting:** `hemlock bark`, `sumac leaves`, `pomegranate rind`, and `gallnuts`
are all alternate tannin sources; treat as alternate inputs via `inputs[].alternates` on the
same recipe — a first-class use of Voxim's substitution feature.

---

## Variants and minor chains

- **Wood → plank → plank_wall.** Already authored as
  [plank.json](../../packages/content/data/recipes/plank.json) and
  [plank_wall.json](../../packages/content/data/recipes/plank_wall.json). Anchor only.
- **Hewing beams.** Squaring a log with a broadaxe — one-shot recipe `wood → beam`, trivial.
  Adds a `beam` itemType for post-and-beam construction but no multi-step depth.
- **Sawing boards by pit-saw.** Two-person workstation, distinctive animation, but mechanically
  identical to existing `plank` chain at different yield. Mention; don't document.
- **Wooden pegs / dowels.** One-shot on pole lathe or by whittling; trivial.
- **Coppicing.** Not a crafting chain — a resource-management practice. A felled "coppiced
  tree" resource node regrows its stump into a ring of straight poles after a seasonal timer.
  Best modelled as a terrain/tree-regrowth feature rather than a recipe. Worth flagging because
  it's how every high-volume wood consumer (charcoal, tar, cooperage) stayed sustainable
  historically — without some coppicing equivalent, the game's forests will be clear-cut in
  days. `GAP-ENV` adjacent.
- **Ash-lye soft soap** — belongs in a dedicated "Soap & Detergents" category, but the
  potash/lye output here is its direct feeder.
- **Birch sap tapping → syrup/wine.** Borderline case; sits between this category and a
  beverage/ferment category. Listed here only because the tap tree is birch and the bark chain
  lives here already.

---

## Category summary

- **Verbs used:** gather, peel, season, rive, turn, shape, crush, leach, assemble, combust,
  apply-heat, forge (delegated to metallurgy).
- **Workstations introduced:** `drying_rack`, `riving_brake`, `shaving_horse`,
  `cooper_workbench`, `pole_lathe`, `charcoal_clamp`, `tar_pit`, `cauldron`, `leach_barrel`,
  `grinding_bench`. The cauldron and leach_barrel are high-reuse across categories (soap,
  dye, glass, cheese, brewing). `charcoal_clamp` and `tar_pit` are the single-use outdoor
  process stations that most strain the current workstation model.
- **Primitives consumed:** `wood` (generic), `birch_wood`, `oak_wood`, `fatwood` (resinous
  pine stumps/roots — proposed new resource node), `bark` / `birch_bark` (as a felling
  byproduct), `clay`, `turf`, `water`, `ash` (from every fire). Kindling feeds most ignition
  steps and is already authored.
- **Byproducts (exports to other categories):**
  - `charcoal` → **Metallurgy** (iron, copper, bronze smelting; currently aliased from the
    kindling recipe, which is a known placeholder).
  - `pine_tar` → **Cooperage** (seam-pitch), **Rope & textiles** (marine rope), **Leather**
    (boot treatment), **Building** (shingle preservative).
  - `pine_pitch` → **Cooperage** (barrel heading), **Boatbuilding** (hull seams — out of
    current scope).
  - `rosin` → **Ranged weapons** (bowstring wax), **Metallurgy** (soldering flux),
    **Consumables** (torch binder).
  - `birch_tar` → **Primitive weapons** (stone-age hafting), **Repair** (field patch).
  - `turpentine` → **Paints & varnishes** (future category), **Medicine**.
  - `potash` → **Soap**, **Glass** (flux), **Dye** (mordant).
  - `lye` → **Soap** (direct), **Food preparation** (nixtamalisation, lutefisk — if cuisine
    category goes deep).
  - `tannin_liquor` → **Leather** (vegetable tanning — the canonical path).
  - `wood_vinegar` → **Dye mordanting**, **Pesticide/fungicide** (future agriculture).
  - `ash` → feeds potash chain here; also **Pottery glazes**, **Soil amendment**.
  - `shavings`, `offcut` → trivially → `kindling` (existing chain).

- **Top engine gaps in this category:**
  - `GAP-BATCH` (3 chains — cooperage, charcoal, tar). Pre-industrial wood processing is
    defined by big single-batch outdoor affairs. Addressing this would unlock a whole family
    of historically authentic chains across catalogues.
  - `GAP-CONSUMED-STATION` (2 chains — charcoal clamp, tar pit, birch-tar retort). Today's
    workaround of "item posing as station" works but eats the ongoing-process visual, which
    is exactly the visual that makes a collier or tar-burner feel like a specialist trade.
  - `GAP-ENV` (2 chains — charcoal, tar). Outdoor weather-sensitive processes. Also implicit
    in the seasoning step of riving: air-drying only works in dry, sheltered conditions.
  - `GAP-STATE` (3 chains — cooperage toasting, charcoal burn, cauldron boil). "Is the fire
    on?" as a persistent workstation property would clean up several recipes where fuel is
    currently modelled as a tick-by-tick input.
  - `GAP-QUALITY` (5+ chains). Wood species, grain alignment, burn control — all affect
    output quality. Today we can only shift quality via material slots, which is fine for
    discrete species but not for "how skilled was the collier".
