# Ceramics & Glass

**Scope & gameplay role.** Ceramics and glass share the kiln/furnace and the same
underlying high-heat fusion physics, so they live together. Ceramics gives the world its
storage vessels, tableware, brick and tile for masonry walls and roofs, and the
refractory crucibles that metallurgy needs for melting non-ferrous metals — meaning this
category is an upstream supplier to the smelting/casting chains. Glass gives flasks and
phials (alchemy/healing containers), beads and trade goods, and window panes (a late
status/building material). Both serve homesteader (everyday pottery, roof tile),
specialist (glassblower, tiler, potter NPC vendors), and trader (regional styles as
commodity) archetypes. Neither produces combat equipment directly, but both are
economic glue: no crucibles → no bronze, no brick → no blast-furnace stack, no flasks →
no bottled potions.

**Chains documented.**

- **Clay body preparation** — dig, weather, levigate, wedge. Upstream of every ceramic chain.
- **Wheel-thrown pottery (bisque + glaze)** — two-fire workflow, the archetype of the category.
- **Brickmaking** — clay → moulded bricks → kiln-fired construction stock.
- **Roof tile** — variant of brick with a curved/flat form step; feeds roofing.
- **Refractory crucible** — fireclay vessel that survives metal-melting heat; exports to metallurgy.
- **Glaze preparation** — raw ash/lead/sand → frit → slurry; sub-chain feeding glazed pottery.
- **Glass batch melting** — sand + potash + lime → molten gather. Upstream of all glass forming.
- **Free-blown glassware** — blown flasks, bottles, beakers; the Roman-onwards staple.
- **Crown/window glass** — spun disc flattened to panes; late-medieval luxury building material.

---

## Chain: Clay body preparation

**Real-world context.** Every pre-industrial pottery tradition started by digging raw
clay from a bank or pit, then processing it to remove stones/roots and to homogenise
plasticity. Weathering (exposing wet clay to frost and sun for weeks or months) broke
down lumps and killed organics; levigation (slurrying in water, letting the coarse grit
settle, decanting the fine fraction) produced a smooth body; wedging (kneading like
dough) drove out air pockets that would explode in the kiln. Skipping any of these was
visible in the finished pot as cracks, pops, or warping.

**Gameplay role.** Foundational intermediate. Nothing in this category works without
`prepared_clay` — not pots, not brick, not crucibles, not glaze slip. It is the
ceramic equivalent of `plank` for wood.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | raw_clay ×3 | shovel | — | Resource node at riverbank / clay pit |
| 2 | age | weathering_bed | raw_clay ×3 | weathered_clay ×3 | — | 1200 | `stepType: time`; outdoor exposure. Interesting step. |
| 3 | leach | settling_tub | weathered_clay ×3, water ×2 | levigated_slip ×3, grit ×1 | — | 400 | `stepType: time`; slow settle & decant |
| 4 | dry | — | levigated_slip ×3 | plastic_clay ×3 | — | 300 | `stepType: time`; evaporation |
| 5 | knead | wedging_bench | plastic_clay ×3 | prepared_clay ×3 | — | 0 | `stepType: attack`; swing to wedge out air |

**Primitive verbs exercised:** gather, age, leach, dry, knead.

**Workstations introduced:** `weathering_bed` (open outdoor frame), `settling_tub`
(water-filled vat), `wedging_bench` (heavy flat surface, often stone).

**Byproducts and their fate:** `grit` (coarse sand/pebble fraction from levigation) →
could feed mortar/concrete or be discarded; `water` is consumed not returned.

**Knowledge gating:** none; this is peasant-level knowledge.

**Engine gaps exposed:**
- `GAP-ENV` — weathering beds historically required outdoor exposure to frost/sun cycles.
  Engine cannot express "must be outdoors and exposed to weather" today.
- `GAP-ENV` (second angle) — the settling step needs water access; we can force it via
  input item but lose the river-adjacency flavour.

**Variants worth noting:** potters in very plastic-clay regions (e.g. Chinese kaolin)
skipped aging; others added temper (sand, grog, crushed shell) at the wedging step to
reduce shrinkage. A `grogged_clay` variant would be the same chain with a temper input
at step 5 — flag as minor variant, not a distinct chain.

---

## Chain: Wheel-thrown pottery (bisque + glaze-fired)

**Real-world context.** The two-fire workflow — bisque fire to harden the greenware so
it can be handled during glazing, then a higher glaze fire to vitrify the glaze — was
standard across the Mediterranean, China, and medieval Europe from roughly the late
Iron Age onward. A pole wheel or kick wheel lets the potter throw symmetric vessels in
minutes; coiling and slab-building are the handbuilt alternatives. Firing temperatures
ran 900–1000 °C for earthenware, 1200 °C+ for stoneware; a medieval updraft kiln held
that with careful fuel management over 12–24 hours, followed by slow cooling.

**Gameplay role.** Produces storage jars, cups, bowls, amphorae — the everyday
containers that gate food storage (grain jars), liquid trade (oil/wine amphorae), and
alchemy (unglazed pots for dry goods, glazed pots for liquids). No direct combat use,
but upstream of cooking, fermenting, and oil-storage chains.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (chain) | — | prepared_clay ×2 | — | — | — | From clay prep chain |
| 2 | turn | potters_wheel | prepared_clay ×2 | greenware_pot ×1 | — | 0 | `stepType: attack`; swing drives wheel. Interesting step (formed at precise slot). |
| 3 | dry | drying_rack | greenware_pot ×1 | bone_dry_pot ×1 | — | 800 | `stepType: time`; leather-hard → bone-dry. Shelter needed. |
| 4 | apply-high-heat | updraft_kiln | bone_dry_pot ×1, charcoal ×3 | bisque_pot ×1, ash ×1 | — | 900 | `stepType: time`; ~900 °C fire. |
| 5 | apply | glazing_bench | bisque_pot ×1, glaze_slurry ×1 | glazed_greenware ×1 | — | 0 | `stepType: attack`; dip & set. From glaze sub-chain. |
| 6 | apply-high-heat | updraft_kiln | glazed_greenware ×1, charcoal ×4 | glazed_pot ×1, ash ×1 | — | 1200 | `stepType: time`; higher fire vitrifies glaze. |

`chainNextRecipeId` chains steps 2 → 3 (wheel → rack move is manual; kiln stays lit
across 4 → 6 only if unglazed batch skips step 5).

**Primitive verbs exercised:** turn, dry, apply-high-heat, apply.

**Workstations introduced:** `potters_wheel` (kick or pole wheel; hand-powered),
`drying_rack` (shelved shelter), `updraft_kiln` (stoke-hole below, chamber above, chimney
draws heat up through the load), `glazing_bench` (dip/brush surface).

**Byproducts and their fate:** `ash` from kiln firing → chemistry category (lye
production) or agriculture (potash fertiliser). Over-fired or cracked pots → `potsherd`
(could feed temper/grog back into clay prep — nice loop).

**Knowledge gating:** `lore_kiln_fire` — firing schedules are the specialist knowledge
here; anyone can throw a lump on a wheel, but few can hold a kiln at heat for 12 hours
without cracking the load.

**Engine gaps exposed:**
- `GAP-BATCH` — a real updraft kiln fires 20–80 pots at once. Our one-input-one-output
  model wastes the fuel cost. Most impactful gap in this category.
- `GAP-ENV` — drying racks must be sheltered from rain; kilns must be on dry ground away
  from straw.
- `GAP-CHECKPOINT` — bisque vs glaze fire are different *temperatures*, not different
  fuels or stations. Today we model them as two separate recipes on the same station,
  which works but wastes the "same kiln, different firing schedule" semantics.
- `GAP-PROCESS-PARAM` — no way to express "overfired → ruined" or "underfired → fragile";
  the output is binary success.

**Variants worth noting:** coil-built and slab-built pottery skip the wheel (step 2 uses
a `handbuilding_mat` station with longer ticks); reduction firing (closed kiln → black
pottery) is a `GAP-PROCESS-PARAM` variant of step 4; raku (pull hot, dunk in sawdust)
is post-1500 in Japan but conceptually a `quench` step after firing. Stoneware is
earthenware with higher-fire clay — same chain, different material tag.

---

## Chain: Brickmaking

**Real-world context.** Fired brick shows up in Mesopotamia ~3000 BCE and spreads through
the classical world; the Romans industrialised it with legionary brickyards, and the
medieval northern European tradition (*Backsteingotik*) built cathedrals from it.
Process: dig clay (often coarser than pottery clay, tempered with sand/straw), mould in
a wooden frame, slide the green brick onto the yard to sun-dry, then stack in a clamp
kiln (a brick pile that fires itself — outer bricks are the kiln walls) or an updraft
brick kiln for days.

**Gameplay role.** Building material. Brick walls have higher HP than plank walls,
enable permanent construction, and are the prerequisite for stone/brick chimneys (→
smithy, → higher-tier furnaces). Roof tile uses the same chain with a different form
step.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (chain) | — | prepared_clay ×4 | — | — | — | Clay prep; coarser temper OK |
| 2 | press | brick_mould | prepared_clay ×4, sand ×1 | green_brick ×4 | — | 0 | `stepType: attack`; one swing forms four |
| 3 | dry | drying_yard | green_brick ×4 | sun_dried_brick ×4 | — | 1200 | `stepType: time`; open air, sun-dry. |
| 4 | apply-high-heat | brick_clamp | sun_dried_brick ×20, charcoal ×6 | fired_brick ×18, ash ×2, cull_brick ×2 | — | 1800 | `stepType: time`; long fire, batch. |

Note the step-4 cull: historically the clamp's outer layer underfires while the centre
overfires, giving ~10% discards. That's an authentic reason to batch many bricks at
once (step 4 inputs 20 not 4).

**Primitive verbs exercised:** press, dry, apply-high-heat.

**Workstations introduced:** `brick_mould` (wooden frame, reusable — unlike sand cast
moulds), `drying_yard` (flat open area), `brick_clamp` (self-consuming kiln; see gaps)
or shared `updraft_kiln`.

**Byproducts and their fate:** `ash` → chemistry/agriculture; `cull_brick` (under- or
over-fired) → rubble fill for road/foundation courses.

**Knowledge gating:** none at the brickmaking level; the tempering knowledge is peasant
craft.

**Engine gaps exposed:**
- `GAP-BATCH` — brick clamps are the strongest batch example in the category. A single
  clamp fires 10 000+ bricks. Our current one-recipe-one-output model can fake it with
  output quantity 18, but then the player must gather 20 sun-dried bricks of input
  first — the UI friction of the batch size is the real problem, not the math.
- `GAP-ENV` — sun-drying is weather-dependent; rain ruins green bricks.
- `GAP-CONSUMED-STATION` — clamp kilns are literally a brick pile; they partially
  self-destruct on use (outer layer stays, middle is harvested as product). Regular
  kilns survive. Flag for the clamp variant specifically.

**Variants worth noting:** adobe/mud-brick (skip step 4 entirely; sun-dried only — fails
scope for the in-game kiln chain but exists as a simpler building material chain worth
one line in the building category).

---

## Chain: Roof tile

**Real-world context.** Imbrex/tegula (Roman S-curve pair), flat medieval peg tile, and
the pantile are regional variations of the same clay-formed-and-fired product. The
difference from brick is the form step: tile is pressed over a shaped wooden block
(*molde*) to curve it, and hung with an integral peg or nail hole. Terracotta tile
shows up wherever brick does and for the same economic reason — fireproof roofs in
urban centres.

**Gameplay role.** Building material specifically for roofs. Compared to thatch, tile
resists fire, lasts decades, and signals wealth — good archetype differentiator for a
successful homesteader / town NPC.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (chain) | — | prepared_clay ×2 | — | — | — | From clay prep |
| 2 | press | tile_form | prepared_clay ×2 | green_tile ×3 | — | 0 | `stepType: attack`; curved former |
| 3 | dry | drying_yard | green_tile ×3 | sun_dried_tile ×3 | — | 1000 | `stepType: time`; sun-dry |
| 4 | apply-high-heat | updraft_kiln | sun_dried_tile ×12, charcoal ×5 | fired_tile ×11, ash ×1, cull_tile ×1 | — | 1400 | `stepType: time`; shared with brick/pottery kiln |

**Primitive verbs exercised:** press, dry, apply-high-heat. All shared with brick.

**Workstations introduced:** `tile_form` (curved wooden former); reuses `drying_yard`,
`updraft_kiln`.

**Byproducts and their fate:** `ash`, `cull_tile` → rubble.

**Knowledge gating:** none.

**Engine gaps exposed:** same as brick — `GAP-BATCH`, `GAP-ENV`. Nothing new.

**Variants worth noting:** ridge tiles, finials, and decorative antefixes are all the
same chain with a different `tile_form` variant input; not worth separate documentation.

---

## Chain: Refractory crucible

**Real-world context.** Melting copper or bronze needs a vessel that survives 1100 °C
without slumping. Crucibles were made from fireclay (high-alumina, low-flux clay) often
grogged with crushed previous crucibles, hand-built (never wheel-thrown — the walls were
too thick), dried very slowly to prevent cracking, then fired hotter than normal
pottery. Medieval European crucibles were typically squat, thick-walled, and produced by
specialist potters near smelting centres. Each crucible survived 5–20 melts before
spalling or cracking.

**Gameplay role.** Bridges ceramics into metallurgy. Without authored crucibles,
non-ferrous metal casting has no consumable vessel — bronze casting, brass, silver, gold
all demand one. This is the main ceramics export to another category.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | fireclay ×2 | pickaxe | — | Resource node; rarer than common clay |
| 2 | knead | wedging_bench | fireclay ×2, potsherd ×1 | grogged_fireclay ×2 | — | 0 | `stepType: attack`; adds temper. `potsherd` alternate: `crucible_shard`. |
| 3 | form | handbuilding_mat | grogged_fireclay ×2 | green_crucible ×1 | — | 0 | `stepType: attack`; hand-built |
| 4 | dry | drying_rack | green_crucible ×1 | bone_dry_crucible ×1 | — | 1600 | `stepType: time`; longer than pottery — thick walls crack otherwise |
| 5 | apply-high-heat | updraft_kiln | bone_dry_crucible ×1, charcoal ×5 | fired_crucible ×1, ash ×1 | — | 1400 | `stepType: time`; high fire |

**Primitive verbs exercised:** gather, knead, form, dry, apply-high-heat.

**Workstations introduced:** `handbuilding_mat` (shared with coil-built pottery); no
dedicated crucible station — the distinction is the input material and the form.

**Byproducts and their fate:** `ash` → chemistry; `crucible_shard` from spent crucibles
(see gameplay role — they wear out in metallurgy) loops back as grog at step 2.

**Knowledge gating:** `lore_refractory_clay` — identifying fireclay and knowing to grog
it is specialist knowledge. Appropriate for a potter-specialist gate before a player
can craft crucibles.

**Engine gaps exposed:**
- `GAP-DURABILITY` — crucibles historically wore out over 5–20 melts. The metallurgy
  side needs tool/station durability to model this. Inside *this* chain there is no new
  gap beyond the shared ones.
- `GAP-ENV` — slow drying in sheltered conditions is critical; same as pottery.

**Variants worth noting:** Hessian crucibles (post-medieval but the archetype was
earlier) used specific alumina-rich clay; graphite-clay crucibles (Bohemian, 15th
century) are a late-period variant with better thermal shock resistance — a single
material tag change.

---

## Chain: Glaze preparation

**Real-world context.** Glaze is glass bonded to a ceramic surface. Pre-industrial
glazes fell into three families: lead glaze (galena or lead oxide fluxed with silica —
cheap, low-fire, shiny, toxic to the potter), ash glaze (wood ash is naturally alkaline
and fluxes silica — the default in East Asian high-fire traditions), and salt glaze
(thrown into the kiln at peak — sodium vapour reacts with the pot surface in-situ,
no slurry). Most European medieval pottery used lead glaze. The prep step is grinding
oxides + silica to a fine slurry and suspending in water for dipping or brushing.

**Gameplay role.** Gates the "glazed" variants of every pottery item — functional
(waterproof liquid jars) and aesthetic (coloured/decorated trade goods). Byproduct
consumer of ash from other chains.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather / harvest | — | — | galena ×1 OR ash ×3 | pickaxe / — | — | Two glaze families, author as alternates |
| 2 | apply-high-heat | updraft_kiln | galena ×1 OR ash ×3, silica_sand ×1 | glaze_frit ×1 | — | 600 | `stepType: time`; pre-fuses oxides into a glass frit |
| 3 | grind | quern | glaze_frit ×1 | glaze_powder ×1 | — | 0 | `stepType: attack` |
| 4 | mix | glazing_bench | glaze_powder ×1, water ×1 | glaze_slurry ×1 | — | 0 | `stepType: attack` |

**Primitive verbs exercised:** apply-high-heat, grind, mix.

**Workstations introduced:** `quern` (shared with grain milling / pigment grinding).
`glazing_bench` shared with pottery.

**Byproducts and their fate:** none notable — glaze is lossy (some stays on brush/tub)
but the loss is modelled as low output quantity, not a distinct byproduct.

**Knowledge gating:** `lore_lead_glaze` or `lore_ash_glaze` — glaze formulation is the
signature "secret" of a pottery lineage. Nice fit for `requiredFragmentId`.

**Engine gaps exposed:**
- `GAP-PROCESS-PARAM` — salt glaze specifically throws salt *into the kiln at peak
  temperature*, not into the glaze jar. That is a mid-firing parameter change that our
  model cannot represent. Workaround: make "salt_glazed_pot" a distinct recipe whose
  inputs include salt at firing time — clumsy but functional.
- `GAP-QUALITY` — glaze depth, even coverage, and absence of crawling/pitting are all
  potter-skill dependent. Today every glaze comes out identical.

**Variants worth noting:** tin-opacified glaze (maiolica, majolica — Hispano-Moresque
technique from ~10th century, then Italian Renaissance) adds tin oxide for the white
opaque base that lets painted decoration stand out. Same chain, tin input added. Mark
as minor variant.

---

## Chain: Glass batch melting

**Real-world context.** Glass is silica (sand) fluxed with an alkali (soda from
Egyptian natron or Levantine plant ash; potash from fern/bracken ash in northern Europe —
the "forest glass" tradition) and stabilised with lime (crushed shell or limestone).
The batch is melted in a crucible in a tank or pot furnace at 1400 °C for many hours, skimmed of
scum, and either worked directly from the pot or cooled into cullet (raw glass chunks)
for later remelting. Roman natron glass dominated the Mediterranean; forest glass was
the European medieval norm.

**Gameplay role.** Upstream of every glass-forming chain. No direct use by itself;
exists to feed blowing, crown-glass, and bead/core-forming chains.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | silica_sand ×3 | shovel | — | Resource node; riverbank sand |
| 2 | harvest | — | — | hardwood_ash ×2 | — | — | Ash as byproduct of every kiln/forge — cross-chain |
| 3 | leach | ash_boiler | hardwood_ash ×2, water ×1 | potash ×1, spent_ash ×1 | — | 400 | `stepType: time`; shared with soapmaking lye |
| 4 | grind | quern | limestone ×1 | ground_lime ×1 | — | 0 | `stepType: attack` |
| 5 | mix | batching_bench | silica_sand ×3, potash ×1, ground_lime ×1, cullet ×1 | glass_batch ×1 | — | 0 | `stepType: attack`; cullet is optional (accelerates melt) |
| 6 | apply-high-heat | glass_furnace | glass_batch ×1, fired_crucible ×1, charcoal ×8 | molten_glass ×1, scum ×1 | — | 1200 | `stepType: time`; crucible consumed-per-N-uses, see gaps |

**Primitive verbs exercised:** gather, harvest, leach, grind, mix, apply-high-heat.

**Workstations introduced:** `ash_boiler` (shared with soap/lye — chemistry category),
`batching_bench` (simple mix surface), `glass_furnace` (bottle-shaped tank furnace with
multiple working holes; longer sustained temperatures than a pottery kiln).

**Byproducts and their fate:** `scum` (impurities skimmed off molten glass) →
discarded; `spent_ash` → could feed agriculture (soil conditioner); cullet loop from
rejected blown pieces feeds back into step 5 — a natural reuse signal.

**Knowledge gating:** `lore_glass_batch` — batch ratios are the glassmaker's trade
secret. Gate this chain entirely.

**Engine gaps exposed:**
- `GAP-STATE` — a glass furnace is not fire-and-forget like a kiln. It is kept continuously
  hot for days/weeks and the glassworker *gathers* batches of molten glass from working
  holes at will. Our model is start-stop-per-recipe, which is fundamentally wrong for
  glass. Pivotal gap for the whole glass sub-category.
- `GAP-DURABILITY` — the crucible inside the furnace wears out; we list it as a consumed
  input but that's awkward (must fetch a new crucible each melt).
- `GAP-BATCH` — a pot furnace holds ~20 kg of glass; the glassworker takes many small
  gathers from one melt.
- `GAP-PROCESS-PARAM` — correct soda/potash/lime/silica ratios determine whether glass
  is workable, milky, or devitrified. Binary success today.

**Variants worth noting:** natron glass (Mediterranean, pre-~800 CE — soda from Egyptian
lake deposits) and soda-ash glass (Levantine plant ash) are regional input variants of
step 5. Lead glass (English crystal, 17th century) is out of scope (post-medieval).

---

## Chain: Free-blown glassware

**Real-world context.** Glassblowing is invented in the 1st century BCE Levant and
spreads with the Roman Empire. A blob of molten glass is gathered on the end of a hollow
iron pipe, blown into a bubble, shaped with paddles/jacks/shears/tongs, and transferred
to a pontil rod for finishing. Crucially, every piece must be *annealed* — cooled
slowly over hours in a lehr (annealing oven) — or it cracks from residual stress within
days. A medieval glasshouse ran pipe, marver, chair, lehr as a continuous workstation
group.

**Gameplay role.** Produces flasks/phials/beakers/bottles. Directly gates alchemy and
medicinal liquid storage; trade good; decorative items for wealthy NPCs.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (chain) | — | molten_glass ×1 | — | — | — | From glass batch melt |
| 2 | gather | glass_furnace | molten_glass ×1 | glass_gob ×1 (on pipe) | blowpipe | 0 | `stepType: attack` — dip pipe in furnace |
| 3 | blow-and-shape | glassblowers_chair | glass_gob ×1 | raw_flask ×1, glass_drip ×1 | blowpipe, jacks | 0 | `stepType: attack`; shears/jacks form. Interesting step. |
| 4 | apply-heat | annealing_lehr | raw_flask ×1, charcoal ×1 | annealed_flask ×1 | — | 1200 | `stepType: time`; slow cool — skip and it cracks |

**Primitive verbs exercised:** gather, blow-and-shape (proposed new verb — specifically
breath-and-tool forming), apply-heat.

**Workstations introduced:** `glassblowers_chair` (the classic arm-railed seat with
rolling-plate), `annealing_lehr` (separate low-heat oven — typically a long tunnel off
the main furnace, bricked one end, decreasing heat gradient).

**Byproducts and their fate:** `glass_drip` (what falls off the pipe during work) → back
to cullet for next batch. Natural loop.

**Knowledge gating:** `lore_glassblowing` — the physical skill is the gate; one of the
clearest specialist trades in the category.

**Engine gaps exposed:**
- `GAP-CHECKPOINT` — blowing is a multi-stage dance (gather → marver → inflate → reheat
  → jack the neck → transfer to pontil → finish → crack off), each of which is genuine
  gameplay in a real glasshouse. Our atomic-recipe model collapses it to one swing.
  Strongest GAP-CHECKPOINT case in the category.
- `GAP-QUALITY` — blown glass quality (wall thickness evenness, symmetry, freedom from
  bubbles) is skill-dependent.
- `GAP-STATE` — shares the continuous-furnace gap from the batch-melt chain.

**Variants worth noting:** mould-blown glass (blow into a clay/metal mould for
repeatable shapes, e.g. Roman-era ribbed bottles and cameo glass) is step 3 with a
`mould` input item; core-forming (Bronze Age — build glass over a clay core on a rod,
chip out the core) is pre-blowing, small-scale (beads and tiny flasks), worth a one-line
mention in variants. Millefiori/cane glass and *verre eglomisé* (gold-leaf sandwich) are
decorative elaborations — skip.

---

## Chain: Crown / window glass

**Real-world context.** Crown glass is a medieval Rhineland/Norman technique (~1000
CE onward) for making flat glass: gather a large gob, blow into a bubble, transfer to
a pontil, reheat, and spin rapidly so centrifugal force flattens the bubble into a
disc up to 1–1.5 m across. Cut panes from the disc; the central "crown" (bullseye, where
the pontil was) was inferior glass that went into cheap lattices. Cylinder glass (blow
cylinder → cut open → reheat → flatten) is the parallel technique producing larger
rectangular panes; it dominated from ~14th century onward.

**Gameplay role.** Window panes — a late-medieval status building material, gates
glazed-window building variant. Economic marker of wealth.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | glass_furnace | molten_glass ×2 | large_gob ×1 | blowpipe | 0 | `stepType: attack` |
| 2 | spin | glassblowers_chair | large_gob ×1 | crown_disc ×1, bullseye ×1 | pontil_rod | 0 | `stepType: attack`; centrifugal flattening. Interesting step. |
| 3 | apply-heat | annealing_lehr | crown_disc ×1, charcoal ×2 | annealed_disc ×1 | — | 1500 | `stepType: time`; bigger mass, longer anneal |
| 4 | cut | glazing_bench | annealed_disc ×1 | window_pane ×4, glass_offcut ×2 | diamond_scorer | 0 | `stepType: attack` |

**Primitive verbs exercised:** gather, spin (proposed new verb), apply-heat, cut.

**Workstations introduced:** reuses `glassblowers_chair` and `annealing_lehr`; adds
`diamond_scorer` as a tool (actual medieval scorers used diamond points or hardened
steel wheels).

**Byproducts and their fate:** `bullseye` → cheap lattice fill (building material of
lower quality); `glass_offcut` → cullet back to batch melt.

**Knowledge gating:** `lore_crown_glass` — late-medieval specialist knowledge, good
progression gate for "village → town → city"-tier architecture.

**Engine gaps exposed:**
- `GAP-CHECKPOINT` — like free-blowing, spinning a crown is multi-stage (gather, start
  bubble, transfer to pontil, reheat, spin). Atomic recipe flattens the drama.
- `GAP-QUALITY` — disc size and evenness are skill-dependent; a master glassworker
  yielded four panes from a disc, a novice maybe one.
- `GAP-SKILLED-YIELD` — directly related: skilled crafter yields more panes per disc.

**Variants worth noting:** cylinder glass (blow elongated cylinder → score lengthwise →
open in a flattening oven) — same gameplay role, different interesting step; could
replace crown glass in a later period or coexist as regional variant.

---

## Variants and minor chains

- **Coiled and slab-built pottery** — the handbuilt alternatives to wheel throwing. Same
  chain as the pottery archetype with a `handbuilding_mat` station and longer form ticks;
  not worth separate schema.
- **Pit firing** — the primitive pre-kiln firing method (stack pots in a pit, cover
  with dung/straw/wood, burn for hours). Useful as a tech-progression precursor to the
  updraft kiln; chain is pottery minus the kiln step, with a `firing_pit` station and
  high failure rate. Skipped because it duplicates pottery structurally — call it a
  pottery variant with a different station.
- **Raku** — post-1500 Japanese; out of scope.
- **Adobe / sun-dried mud-brick** — no firing. Belongs to building category more than
  ceramics; mentioned in brick chain as a variant.
- **Bead-making (core-formed glass)** — Bronze-Age technique (build glass on clay rod,
  chip out the core). Mentioned under blown-glass variants; a decorative chain without
  strong gameplay role unless beads become currency.
- **Millefiori, cameo glass, gold-sandwich (verre eglomisé)** — decorative elaborations
  on blown glass; skip for now.
- **Stoneware** — same chain as earthenware pottery with higher-fire clay. A material
  tag, not a new chain.
- **Majolica / tin-opacified ware** — Hispano-Moresque/Italian specialisation of glazed
  pottery with a tin-glazed white base + painted decoration. One input change in the
  glaze chain.
- **Terra sigillata** — Roman red-slip tableware; a slip (very fine levigated clay)
  applied to pots before firing, giving the red gloss. A sub-recipe at pottery step 3.5
  rather than its own chain.
- **Crucible re-use loop** — not a chain but a byproduct signal worth calling out: spent
  crucibles from metallurgy become grog input for new crucibles, completing a closed loop
  between the two categories.

---

## Category summary

- **Verbs used:** gather, age, leach, dry, knead, turn, form, press, apply,
  apply-high-heat, apply-heat, grind, mix, blow-and-shape (new), spin (new), cut,
  harvest. New verbs `blow-and-shape` and `spin` are specific to hot-glass forming and
  do not substitute cleanly for `turn` or `press`.
- **Workstations introduced:** `weathering_bed`, `settling_tub`, `wedging_bench`,
  `potters_wheel`, `handbuilding_mat`, `drying_rack`, `drying_yard`, `tile_form`,
  `brick_mould`, `brick_clamp`, `updraft_kiln`, `glazing_bench`, `ash_boiler` (shared
  with chemistry), `batching_bench`, `glass_furnace`, `glassblowers_chair`,
  `annealing_lehr`, `quern` (shared with food/chemistry). The kiln family is the
  signature infrastructure; many pre-prep and post-prep stations are lightweight shared
  surfaces.
- **Primitives consumed:** raw_clay (common pit), fireclay (rarer), silica_sand,
  limestone (or crushed shell), galena (for lead glaze), water, charcoal (fuel from
  wood category), hardwood_ash (byproduct of any wood fire — cross-chain input). Most
  primitives are abundant; fireclay and galena are the bottleneck resources.
- **Byproducts exported:**
  - `ash` → chemistry (lye, potash, soap), glass batch (flux), agriculture (fertiliser).
  - `fired_crucible` → **metallurgy** (bronze, brass, silver, gold melts). Primary export.
  - `fired_brick`, `fired_tile` → **building category** (walls, roofs, chimneys).
  - `cullet` / `glass_drip` → recycles back into glass batch — internal loop.
  - `potsherd`, `crucible_shard` → grog temper back into clay preparation — internal
    loop, and nice closed-cycle storytelling.
  - `bullseye` → lower-tier building glass.
  - `grit`, `spent_ash`, `glass_offcut` → incidental, either discarded or minor loops.
- **Top engine gaps:**
  - **`GAP-BATCH`** — most frequent in category and most impactful. Kilns, brick clamps,
    and glass furnaces are all intrinsically batched; the one-charge model either wastes
    fuel or forces ugly output-quantity inflation. Closing this gap would benefit every
    single chain above.
  - **`GAP-ENV`** — almost every drying and clay-preparation step is weather-dependent
    (rain ruins greenware, frost weathers clay, sun dries brick). Second-most frequent.
  - **`GAP-STATE`** — glass furnaces are continuously-hot *pools* of molten material,
    not batch recipes. The entire glass sub-category is mis-modelled without some
    always-on furnace state.
  - **`GAP-CHECKPOINT`** — blown glass and crown glass are inherently multi-stage per
    vessel; the atomic-recipe model collapses the interesting interactive part. A
    focussed gap that could be left open (use the many-small-recipes workaround) but is
    visible wherever molten glass is worked.
  - **`GAP-DURABILITY`** — crucibles wear out in metallurgy; without this the
    ceramics-metallurgy export loop is awkward (crucible-as-input instead of
    crucible-as-worn-tool).
  - **`GAP-PROCESS-PARAM`** — overfire / underfire / reduction vs oxidation / correct
    batch ratio. Binary-success today; any success-variance mechanic would make this
    category far more interesting.
