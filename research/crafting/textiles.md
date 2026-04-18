# Textiles

**Scope & gameplay role.** Textiles turn plant stems, animal fleeces, and gathered fibres into
the soft goods of medieval life: clothing layers, sacks, sails, ropes, nets, bandages, bedding,
and trade cloth. The chains are long, labour-cheap, and heavily staged with intermediate items
that each have their own gameplay identity (tow, yarn, greige cloth, fulled cloth) — which makes
the category the clearest showcase for `chainNextRecipeId` and for NPC-labour authoring, because
a homesteader can feed raw fibre in and collect finished cloth days later without touching the
middle steps. Textiles serve homesteaders directly (armour padding, packs, bedding), combatants
indirectly (gambesons, bowstring cores, quiver linings), and traders as a staple export — finished
linen and wool broadcloth were among the most valuable pre-industrial bulk goods.

**Chains documented.**

- **Flax → linen** — the archetype ten-step chain; retting, breaking, scutching, heckling, spin, weave, bleach.
- **Wool → woollen broadcloth** — shear, scour, card/comb, spin, weave, full, tease, shear.
- **Wool → felt** — no spinning; wet wool + heat + agitation → dense mat. Shortest distinct chain.
- **Hemp → rope/sailcloth** — flax-parallel pipeline tuned for coarser, stronger end uses.
- **Cordage / rope-making** — prepared fibre → yarn → ply → rope. Shared endpoint for flax/hemp/nettle.
- **Basketry (withy & rush)** — green rods around a form; no loom, no spinning.
- **Knotted nets** — fishing/fowling nets knotted from plied cordage.
- **Nettle / nalbinding fibre-to-garment** — compressed subsistence chain: nettle-ret → spin → nalbind sock/mitten.

Chains skipped and why:
- **Silk reeling** — pre-1500 but geographically exotic for Voxim's setting; one-line mention in Variants.
- **Dyeing as a standalone chain** — authored as the terminal step of wool/linen chains to avoid duplicating chemistry-category work. Cross-reference only.
- **Cotton ginning/carding** — pre-1500 in Indian and Mediterranean world, but the chain is structurally a subset of wool (card → spin → weave) without retting or fulling; noted under Variants.
- **Tapestry / brocade / damask weaving** — same loom verb, output quality differs. GAP-QUALITY more than a separate chain. Noted under Variants.

---

## Chain: Flax → linen

**Real-world context.** Flax (*Linum usitatissimum*) was the dominant northern European bast
fibre from the Neolithic through the Industrial Revolution. Egyptian mummy-wrappings, Irish and
Flemish linen, and Russian sailcloth all come from the same basic pipeline. The chain is unusual
for how much of it is **controlled decay** — retting literally rots the plant's pectin glue to
free the long bast fibres without destroying them. Over-ret and the fibre crumbles; under-ret
and it won't separate. This judgement call was the retting-master's entire skill.

**Gameplay role.** Produces `linen_cloth`, the baseline light textile for shirts, sheets,
bandages, sacks, sails, and gambeson outer shells. Intermediate `linen_yarn` feeds cordage and
sewing. Byproduct `tow` feeds coarser sackcloth, tinder, and stuffing. No linen items currently
exist in Voxim — this is a net-new progression tree adjacent to the existing wood/stone starter
tier.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|------------------------|-------|-------|-------|
| 1 | gather | — | — | flax_stalks ×N | — | — | Resource node (cultivated plot or wild patch); not a recipe |
| 2 | ret | retting_pond | flax_stalks ×5 | retted_flax ×5 | — | 1600 | `stepType: time`. Pond-retting; bacterial. Needs standing water & warmth — GAP-ENV |
| 3 | break | flax_brake | retted_flax ×1 | broken_flax ×1, shive ×1 | — | 0 | `stepType: attack`; swing the hinged brake — `strike` verb reused. Shive (woody core) = fuel byproduct |
| 4 | scutch | scutching_board | broken_flax ×1 | scutched_flax ×1, tow_coarse ×1 | scutching_knife | 0 | `stepType: attack`; scrape off remaining boon. Wooden knife |
| 5 | heckle | heckling_comb | scutched_flax ×1 | line_flax ×1, tow_fine ×1 | — | 0 | `stepType: attack`; draw fibre through iron combs. Interesting step: yields two grades of fibre |
| 6 | spin | spinning_wheel | line_flax ×1 | linen_yarn ×2 | distaff | 300 | `stepType: time`. Wheel preferred; distaff+spindle slower variant |
| 7 | weave | loom | linen_yarn ×8 | greige_linen ×1 | shuttle | 600 | `stepType: time`. "Greige" = loom-state, unbleached, stiff |
| 8 | bleach | bleaching_green | greige_linen ×1 | bleached_linen ×1, spent_lye ×1 | — | 2400 | `stepType: time`. Sun-bleach on grass, sprinkled with lye & buttermilk. GAP-ENV (direct sun) |
| 9 | finish | workbench | bleached_linen ×1 | linen_cloth ×1 | smoothing_stone | 0 | `stepType: attack`; calender/smooth. Optional cosmetic finish step |

Steps 2→9 chain via `chainNextRecipeId` where station continuity allows (breaks between stations).

**Primitive verbs exercised:** ret, break (new — striking a hinged brake), scutch (new), heckle
(new), spin, weave, bleach (new), finish. `strike`/`hammer` analogue covers break/scutch if we
want to collapse verbs.

**Workstations introduced:** retting_pond (outdoor, water-adjacent), flax_brake (hinged wooden
jaw), scutching_board (vertical plank + slot), heckling_comb (iron-toothed combs on bench;
multiple grades), spinning_wheel (great wheel or flyer wheel; lore-gated if flyer), loom
(horizontal or vertical warp-weighted), bleaching_green (outdoor grass field — GAP-ENV).

**Byproducts and their fate:** shive → fuel/tinder (feeds campfire chain); tow_coarse →
sackcloth recipe, stuffing for gambeson padding, tinder; tow_fine → coarse yarn for cheap cloth,
candle-wick-equivalent; spent_lye → discard or feed fuller's bleach; bleached droppings (grass
scorched under cloth) → discarded in Voxim.

**Knowledge gating:** `lore_retting` on step 2 (the decay-judgement is the gated skill);
`lore_heckling_grades` optional for tow_fine yield. Weave & spin ungated — common peasant
skills.

**Engine gaps exposed:** `GAP-ENV` (retting needs water body + warm season; bleaching needs
sustained sunlight); `GAP-CHECKPOINT` (retting has a real "is it done yet?" decision — under-ret
yields 0 fibre, over-ret yields damaged fibre; currently only modellable as fixed-ticks binary
success); `GAP-PROCESS-PARAM` (retting temperature and water chemistry matter historically);
`GAP-QUALITY` (line vs tow grading is binary in today's schema — fine for now, but a skilled
heckler extracted more line and less tow — `GAP-SKILLED-YIELD`).

**Variants worth noting:** **Dew-retting** — stalks laid on grass for 2–6 weeks, fungal rather
than bacterial. Slower, lower fibre yield, different byproduct chemistry. Station:
`dew_retting_field`. Same recipe shape, longer ticks (~3000), stronger GAP-ENV (needs
grass + dew + cool nights). **Enzymatic retting** is post-industrial; skip.

---

## Chain: Wool → woollen broadcloth

**Real-world context.** Medieval Europe's single largest non-food industry. England, Flanders,
Florence, and Castile built their economies on the wool chain. The **fulling** step —
thickening loose weave by agitating it in hot, soapy liquid until the fibres mat — was
originally done by foot-trampling in a trough (hence "walker" as a surname); post-11th-century
fulling mills used water-powered hammers, one of the earliest industrial machines. The final
nap-and-shear gave the dense, water-shedding "broadcloth" surface.

**Gameplay role.** Produces `woollen_cloth` (warm, water-resistant, winter-armour padding
lining) and `broadcloth` (higher-tier trade good). Shears produce `raw_fleece` as a resource;
chain ends at finished cloth ready for garment assembly. No wool items currently exist in Voxim.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|------------------------|-------|-------|-------|
| 1 | shear | — (sheep entity) | — | raw_fleece ×1, lanolin_trace ×1 | shears | 0 | Interaction with sheep NPC, not a station recipe. `stepType: attack` in spirit |
| 2 | skirt | sorting_table | raw_fleece ×1 | skirted_fleece ×1, belly_wool ×1 | — | 0 | `stepType: attack`; discard stained edges. Belly wool = coarse stuffing |
| 3 | scour | scouring_vat | skirted_fleece ×1, stale_urine ×1, wood_ash ×1 | scoured_wool ×1, dirty_suint ×1 | — | 400 | `stepType: time`. Urine+ash = ammonia soap, cuts lanolin |
| 4 | card OR comb | carding_bench | scoured_wool ×1 | wool_rolag ×2 OR worsted_top ×1, noil ×1 | carding_paddles OR combs | 0 | `stepType: assembly` (two output paths). Carding = woollen (crossed fibres). Combing = worsted (parallel) |
| 5 | spin | spinning_wheel | wool_rolag ×1 | wool_yarn ×2 | — | 300 | `stepType: time`. Or drop-spindle variant slower |
| 6 | weave | loom | wool_yarn ×10 | greige_wool ×1 | shuttle | 600 | `stepType: time` |
| 7 | full | fulling_trough | greige_wool ×1, fullers_earth ×1, stale_urine ×1 | fulled_wool ×1, fuller_liquor ×1 | fulling_hammer | 800 | `stepType: time` or attack-driven. Most physical step. Cloth shrinks ~30% |
| 8 | tease | teasing_frame | fulled_wool ×1 | napped_wool ×1 | teasel_head | 0 | `stepType: attack`; drag teasel heads across cloth to raise nap |
| 9 | shear | cloth_shearing_board | napped_wool ×1 | broadcloth ×1, wool_dust ×1 | cloth_shears | 0 | `stepType: attack`; level the nap. Distinct from step 1 shear-sheep |
| 10 | dye | dyeing_vat | broadcloth ×1, mordant ×1, dye_liquor ×1 | dyed_broadcloth ×1, spent_dye ×1 | — | 400 | `stepType: time`. Optional. Cross-ref chemistry category for dye_liquor source |

**Primitive verbs exercised:** shear, sort (skirt), scour (new wash-variant), card, comb,
spin, weave, full (new — agitate-felt), tease (new), dye.

**Workstations introduced:** sorting_table (shared across chains), scouring_vat (water +
heat-source; GAP-STATE for "is it hot?"), carding_bench (paddles in stand), fulling_trough
(water-powered hammers or foot-trampling), teasing_frame (vertical frame with teasel heads),
cloth_shearing_board (long trestle with wool-shears), dyeing_vat (shared with chemistry
dyeing).

**Byproducts and their fate:** belly_wool → stuffing, coarse yarn; dirty_suint → lanolin
rendering (grease-for-leather/candles), soap-making feed; noil (combing waste) → carded cloth
or mattress stuffing; fuller_liquor → drained; wool_dust → discarded; spent_dye → drained.
Lanolin extracted from suint is a **real cross-chain flow** into leather and cosmetic chains.

**Knowledge gating:** `lore_fulling` (the shrinkage timing is the craft skill);
`lore_worsted_combing` for the high-end parallel-fibre branch.

**Engine gaps exposed:** `GAP-STATE` (scouring_vat needs "hot?"; fulling_trough needs water
flow state for mill version); `GAP-PROCESS-PARAM` (fulling time determines final density — a
real dial, not a discrete output); `GAP-CONSUMED-STATION` (teasel heads wear out; workaround
= input item); `GAP-BATCH` (real fulling mills handle whole bolts at once); `GAP-QUALITY`
(broadcloth quality varied enormously with skill — cannot express today).

**Variants worth noting:** **Woad-vat dyeing** — the blue-dye chain proper; ferment urine
indigo precursors for weeks, smell unbelievable, document under chemistry. **Lodenwalker**
(Alpine dense fulling for weather-cloth) — same chain, extreme ticks on full step.

---

## Chain: Wool → felt

**Real-world context.** Felting predates spinning and weaving by millennia; the oldest
recovered textiles are felts, not woven cloth. Central Asian steppe nomads made tents
(yurts/gers), boots, and saddle-pads entirely of felt. The technique is elegant: wet wool,
warm temperature, mechanical agitation → the scales on wool fibres interlock irreversibly.
No spindle, no loom — just rolling, beating, or walking a wet fleece until it densifies.

**Gameplay role.** Produces `felt_mat` for hat bodies, armour padding, cold-weather
footwear, and tent fabric. Chain is deliberately short — counterpoint to the ten-step linen
pipeline. Serves as the earliest unlockable wool-based armour padding.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|------------------------|-------|-------|-------|
| 1 | — | see wool chain steps 1–3 | — | scoured_wool ×2 | — | — | Shared early steps with wool chain |
| 2 | layer | felting_mat | scoured_wool ×2, water ×1 | wet_batt ×1 | — | 0 | `stepType: attack`; lay wool in cross-hatched layers on reed mat |
| 3 | felt | felting_mat | wet_batt ×1, hot_water ×1, soap ×1 | felt_mat ×1, grey_water ×1 | felting_roller | 500 | `stepType: time` or attack-chained. Roll/beat/trample until dense |
| 4 | shape | form_block | felt_mat ×1 | hat_body ×1 OR boot_body ×1 | — | 0 | `stepType: assembly`; drape and shrink over form. Optional variant step |

**Primitive verbs exercised:** layer (new — may collapse to `assemble`), felt (new — the
category-defining verb), shape (new — collapse to `form`?).

**Workstations introduced:** felting_mat (reed or bamboo rolling mat), form_block (wooden
last for hats/boots — consumable? GAP-CONSUMED-STATION if single-use per form).

**Byproducts and their fate:** grey_water → drained (in Voxim: discarded; real world: still
full of lanolin, dog/goat-wash reuse).

**Knowledge gating:** `lore_felting` — the technique is regionally specific; a Central-Asian
or Anatolian-coded lore fragment would flavour the unlock.

**Engine gaps exposed:** `GAP-STATE` (felting needs "is the water hot?" — current model
encodes as input item); `GAP-PROCESS-PARAM` (more agitation = denser felt; binary output
today).

---

## Chain: Hemp → rope & sailcloth

**Real-world context.** *Cannabis sativa* grown for fibre was the other great bast crop,
favoured over flax for coarser, stronger applications: ship rigging, sailcloth, sackcloth,
fishing lines. Venice, Pisa, and later English naval yards consumed enormous quantities.
The processing pipeline is nearly identical to flax, but hemp stalks are taller, tougher,
and the fibre is coarser — different tool sizing, longer retting, no expectation of
fine cloth at the end.

**Gameplay role.** Produces `hemp_rope` (naval/building staple) and `sailcloth` (canvas
ancestor; gameplay role: ship hulls if/when we get them, or wagon covers, tent shells,
heavy sacks). Provides a coarser, stronger counterpart to flax — gameplay differentiation
via material stats on the shared item template.

**Chain steps:** Structurally identical to flax steps 1–7 with re-tuned ticks and no
bleach step (sailcloth stays tan; better weather-resistance without bleaching). Rope
sub-chain branches at step 6.

| # | Verb | Station | Inputs | Outputs | Tools | Ticks | Notes |
|---|------|---------|--------|---------|-------|-------|-------|
| 1 | gather | — | — | hemp_stalks ×N | — | — | Resource node |
| 2 | ret | retting_pond | hemp_stalks ×5 | retted_hemp ×5 | — | 2000 | Longer than flax — tougher pectin |
| 3 | break | flax_brake | retted_hemp ×1 | broken_hemp ×1, hemp_shive ×1 | — | 0 | Shares station with flax |
| 4 | scutch | scutching_board | broken_hemp ×1 | scutched_hemp ×1, hemp_tow ×1 | scutching_knife | 0 | Coarser tow — different byproduct grade |
| 5 | hackle | heckling_comb | scutched_hemp ×1 | line_hemp ×1, hemp_tow_fine ×1 | — | 0 | Wider-toothed comb variant (same station, lore-gated tool swap) |
| 6a | spin | rope_walk OR spinning_wheel | line_hemp ×2 | hemp_yarn ×4 | — | 300 | Rope-walk yields longer yarns suited to rope |
| 7a | weave | loom | hemp_yarn ×12 | sailcloth ×1 | shuttle | 600 | Sailcloth endpoint |
| 6b | spin→ply | rope_walk | line_hemp ×3 | hemp_strand ×2 | — | 200 | Twist for rope — see cordage chain |
| 7b | lay | rope_walk | hemp_strand ×3 | hemp_rope ×1 | — | 200 | Counter-twist three strands into rope |

**Primitive verbs exercised:** Same as flax. New: `ply` / `lay` for rope — see cordage
chain for the verb definition.

**Workstations introduced:** rope_walk (long narrow corridor, historically 100–300 m;
compressed in game to a single station). Rope-walks are a GAP-ENV of their own — they need
length, which a world-space station can represent if we allow oriented placement.

**Byproducts and their fate:** hemp_shive → fuel; hemp_tow → oakum (caulking for boats —
cross-chain with shipbuilding), coarse sackcloth; hemp_tow_fine → cheap cord.

**Knowledge gating:** `lore_rope_walk` for step 7b — the counter-twist doctrine.

**Engine gaps exposed:** Same as flax, plus `GAP-ENV` specifically for rope-walk length
(may need oriented-placement constraint on the workstation prefab).

**Variants worth noting:** **Nettle fibre** — *Urtica dioica* processes similarly, lower
yield, ambient-available (no cultivation needed). Emergency/frontier textile. See final
chain below for the compressed version.

---

## Chain: Cordage / rope-making (generic)

**Real-world context.** The universal "take prepared fibre, turn it into something
load-bearing" chain. Applies to flax, hemp, nettle, lime-bast, sinew, hair, gut. Structure
is always: fibres → yarn (single twist) → strand (several yarns plied counter-twist) →
rope (several strands plied counter-twist again). The counter-twist is what keeps rope
from unwinding — a genuinely interesting physical principle that a `ply` verb captures
cleanly.

**Gameplay role.** Produces `cord`, `rope`, and `cable` (tiered by diameter/strand count).
Used everywhere: bowstrings, pack-straps, snares, fishing-line, bucket-hoists, bindings.
This is not a full ten-step chain — it's a short, high-reuse cap that sits on top of any
bast-fibre chain.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs | Tools | Ticks | Notes |
|---|------|---------|--------|---------|-------|-------|-------|
| 1 | spin | spinning_wheel OR rope_walk | prepared_fibre ×2 | yarn ×2 | — | 200 | `alternates: [line_flax, line_hemp, line_nettle, sinew_strip]` — classic alternates case |
| 2 | ply | rope_walk | yarn ×2 | strand ×1 | — | 150 | Counter-twist. `stepType: time` |
| 3 | lay | rope_walk | strand ×3 | rope ×1 | — | 200 | Final counter-twist. Three-strand rope is standard |
| 4 | lay (cable) | rope_walk | rope ×3 | cable ×1 | — | 300 | Optional fourth tier for heavy rigging |

**Primitive verbs exercised:** spin, ply (new — counter-twist binding), lay (new — collapse
to `ply`? argue: no, "lay a rope" is a distinct craft vocabulary; keep separate).

**Workstations introduced:** rope_walk (shared with hemp chain).

**Byproducts and their fate:** none direct — rope-making is clean. Off-cuts and short
ends → kindling or rag stuffing.

**Knowledge gating:** `lore_rope_walk` gates ply+lay. Raw "twist two strings together"
primitive can be ungated for survival-tier cord.

**Engine gaps exposed:** Minor. `GAP-QUALITY` (a well-laid rope outlasts a badly-laid one
2–5× in the real world; today's model bakes quality into material stats only).

---

## Chain: Basketry (withy & rush)

**Real-world context.** Among the oldest human crafts — woven-form containers predate
pottery. Withies (one-year willow shoots) were coppiced annually and soaked to stay
flexible; rushes and reeds were cut green from wetlands. Every European village had
baskets for grain, fish, fruit, eel-traps, fencing hurdles, even coracles (willow frame +
hide). No loom, no spinning — structural weaving directly around or inside a form.

**Gameplay role.** Produces `basket`, `creel`, `eel_trap`, `hurdle` (fencing panel).
Low-tier containers filling an inventory/carrying gameplay role; fishing chain uses
eel_trap; farming chain uses hurdles for livestock pens. Fills a "day-one craft without
iron" niche that the current wood-chopping tier does not.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|------------------------|-------|-------|-------|
| 1 | gather | — | — | green_withy ×N OR rushes ×N | knife | — | Resource node; `alternates` on future basket recipes |
| 2 | soak | soaking_trough | green_withy ×5 | pliable_withy ×5 | — | 400 | `stepType: time`. Rehydrate dried withies for workability |
| 3 | weave | basketry_form | pliable_withy ×8 | basket ×1 OR creel ×1 OR hurdle ×1 | — | 300 | `stepType: assembly` (multiple output shapes from same inputs) |

**Primitive verbs exercised:** gather, soak, weave. Basket-weave is mechanically distinct
from loom-weave; could share a verb with a station disambiguator, or introduce `plait` as
a separate verb. Propose keep `weave` + station context.

**Workstations introduced:** soaking_trough (any water-vessel prefab; low barrier),
basketry_form (a wooden form peg-board — the shape on the form determines which output
in the assembly).

**Byproducts and their fate:** short withy ends → tinder, kindling.

**Knowledge gating:** Ungated for `basket`. `lore_eel_trap` for the fishing-specific
weave. `lore_hurdle_making` for the fence-panel weave (slightly different technique —
hedgerow wattle).

**Engine gaps exposed:** `GAP-ENV` light (withies want coppice groves; not blocking);
`GAP-CONSUMED-STATION` (none — forms are reusable).

**Variants worth noting:** **Wattle-and-daub** — hurdle-making extends into building
chain; the woven wattle panel is the textile-ish step, daub (clay+dung+straw) is separate
masonry chain.

---

## Chain: Knotted nets

**Real-world context.** Fishing nets, fowling nets, hair-nets, cargo nets. Knotted with
a shuttle (netting-needle) and a gauge (mesh-stick) to keep mesh size uniform. The
**sheet-bend / fisherman's knot** is the category-defining verb. Nets are slow to make
and valuable; a pre-industrial fisherman's net was major capital.

**Gameplay role.** Produces `fishing_net`, `bird_net`, `cargo_net`. Fishing net is a
gameplay primitive for passive food gathering (a deployed-item workstation that produces
fish over time — interesting GAP-ENV case). Cargo net expands carrying capacity.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs | Tools | Ticks | Notes |
|---|------|---------|--------|---------|-------|-------|-------|
| 1 | — | see cordage chain | — | cord ×N | — | — | Prerequisite |
| 2 | knot | netting_bench | cord ×10 | fishing_net ×1 | netting_needle, mesh_gauge | 1200 | `stepType: time`. Long because it really is slow work |
| 3 | tar | tarring_pot | fishing_net ×1, pine_tar ×1 | tarred_net ×1 | — | 300 | `stepType: time`. Optional — waterproofs and preserves the cord. Cross-chain with pine-tar/pitch chemistry |

**Primitive verbs exercised:** knot (new — structurally a cousin of `weave` but topologically
distinct, belongs in vocabulary), tar (new — may collapse to `cure` or `apply`).

**Workstations introduced:** netting_bench (bench with hooks for fixing the work-piece),
tarring_pot (heated pitch vessel — GAP-STATE for "is it hot enough?").

**Byproducts and their fate:** cord offcuts → rag/tinder.

**Knowledge gating:** `lore_netting_knot` — a named knot is a recognisable lore-unit.

**Engine gaps exposed:** `GAP-STATE` (tarring_pot temperature); `GAP-ENV` (deployed
fishing_net as a workstation needs "placed in water" — a real environmental constraint
that today cannot be expressed).

---

## Chain: Nettle → nalbinding garment (compressed subsistence chain)

**Real-world context.** Nalbinding is a single-needle looping technique predating knitting
by centuries — Viking-age socks, mittens, and hats were nalbound. Paired with nettle fibre
(freely available, retted like flax), it represents the **frontier/peasant emergency
textile path**: no loom, no spinning wheel, no cultivated crop. The output is dense,
hard-wearing, and impossible to unravel — a dropped stitch doesn't run.

**Gameplay role.** Earliest-possible warm-layer crafting. Produces `nalbound_mitten`,
`nalbound_sock`, `nalbound_cap`. Gameplay niche: before the player has a loom, before
they've cultivated flax, they can harvest wild nettles and hand-loop serviceable cold-
weather gear. A deliberate low-tier progression entry point parallel to starter wood tools.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs | Tools | Ticks | Notes |
|---|------|---------|--------|---------|-------|-------|-------|
| 1 | gather | — | — | nettle_stalks ×N | gloves_or_tough_skin | — | Resource node. Stinging-hazard is flavour, not mechanic |
| 2 | ret | retting_pond | nettle_stalks ×3 | retted_nettle ×3 | — | 1400 | Shorter than flax — thinner stalks |
| 3 | scutch+heckle | scutching_board | retted_nettle ×1 | nettle_fibre ×1, nettle_tow ×1 | scutching_knife | 0 | Compressed into one step — nettle doesn't warrant both |
| 4 | spin | distaff_and_spindle | nettle_fibre ×2 | nettle_yarn ×3 | spindle | 400 | Hand spindle — no wheel needed. Slower |
| 5 | nalbind | handcraft (no station) | nettle_yarn ×4 | nalbound_mitten ×1 | nalbinding_needle | 800 | `stepType: time`. Portable craft — unusually, no station. GAP: current model assumes station for timed recipes |

**Primitive verbs exercised:** gather, ret, scutch, heckle, spin, nalbind (new — a looping
variant of knit/weave; propose separate verb).

**Workstations introduced:** None new. Step 5 flags a novel gap: **GAP-PORTABLE-CRAFT** —
the current Recipe model binds recipes to stations; a seated-anywhere timed craft cannot
be expressed without either (a) a "portable" workstation item, or (b) a new no-station
stepType. Today you would work around with a `handcraft_stool` prefab the player places.

**Byproducts and their fate:** nettle_tow → stuffing, tinder.

**Knowledge gating:** `lore_nalbinding` — a regional/named technique.

**Engine gaps exposed:** `GAP-PORTABLE-CRAFT` (new — timed recipes with no station).
`GAP-ENV` (retting). Overlaps otherwise with flax chain gaps.

**Variants worth noting:** **Sprang** (lattice-twisted mesh, elastic) and **tablet-weaving**
(narrow decorative bands using wooden tablets) are further low-station textile crafts; each
could be a one-line chain under Variants of a full authored category.

---

## Variants and minor chains

- **Silk reeling (mulberry → cocoon → raw silk → degummed silk → woven silk).** Geographically
  exotic for Voxim's setting; include only if the game grows a "foreign trade goods" tier.
  Structurally: raise silkworms (out-of-scope resource node), reel unbroken filament from
  cocoons in hot water, throw/ply, degum in soap-water, dye, weave. Shares `ret`-ish logic
  at degumming; shares `ply` with cordage.
- **Cotton (gin → card → spin → weave).** Pre-1500 in the Indian subcontinent, Mediterranean,
  and Song China. Structurally simpler than flax (no retting, no breaking). Gin (`charkha`)
  separates seed from fibre — a striking verb with a clear station. Document in full only if
  we want a warm-climate/trade-tier cloth branch.
- **Tapestry, brocade, damask.** Same `weave` verb on the same `loom` station, differing by
  pattern complexity and yarn colour-count. A `GAP-QUALITY` or lore-gated recipe variant
  rather than a distinct chain.
- **Straw-plait** (hats, mats) — short chain: thresh straw → sort by grade → plait. Single-
  verb chain, minor, slot into "Preparation & gathering" variants.
- **Oakum and caulking.** The terminal fate of hemp_tow_fine + pine-tar; used to waterproof
  ship seams. Documented properly under ship-building when that category is authored.
- **Stand-alone dyeing.** Referenced from wool & linen chains; authored in the chemistry
  category. Mordant chain (alum, iron, copperas) + dyestuff chain (woad ferment, madder
  root, weld, kermes) belongs there.

---

## Category summary

- **Verbs used:** gather, ret, break, scutch, heckle, spin, weave, bleach, finish, shear
  (two contexts: sheep and cloth), sort/skirt, scour, card, comb, full, tease, dye, layer,
  felt, shape, ply, lay, soak, knot, tar, nalbind.
  - **New to the seed vocabulary:** ret, break, scutch, heckle, bleach, scour, card, comb,
    full, tease, felt, ply, lay, knot, nalbind. About half are bast-fibre-specific; a
    reasonable Phase 3 collapse is: `ret` (keep — unique biology), `break`+`scutch`+
    `heckle` (collapse under a `process-fibre` parent with station disambiguation),
    `card`+`comb` (keep separate — different outputs), `full`+`felt` (same physics,
    different inputs — could collapse to `felt` verb with station context), `ply`+`lay`
    (collapse to `ply`), `nalbind`+`knit` (collapse to `loop` or keep as
    lore-gated variants of `knit`).
- **Workstations introduced:** retting_pond, dew_retting_field, flax_brake, scutching_board,
  heckling_comb, spinning_wheel, distaff_and_spindle, loom, bleaching_green, sorting_table,
  scouring_vat, carding_bench, fulling_trough, teasing_frame, cloth_shearing_board,
  dyeing_vat, felting_mat, form_block, rope_walk, netting_bench, tarring_pot, basketry_form,
  soaking_trough. ~23 prefabs; many are simple wooden structures authored as prefab drops.
- **Primitives consumed from resource nodes:** flax_stalks, hemp_stalks, nettle_stalks,
  green_withy, rushes, reeds, raw_fleece (from sheep NPC), water, wood_ash (from hearth),
  stale_urine (from household — cross-chain with food/household), fullers_earth (from
  stone/mineral category), pine_tar (from chemistry), mordant + dye_liquor (from chemistry).
- **Byproducts exported to other chains:**
  - `shive` / `hemp_shive` → fuel, kindling (feeds campfire/fuel chain).
  - `tow_coarse` / `tow_fine` / `hemp_tow` → coarser sackcloth, armour padding stuffing,
    oakum for ship caulking, candle/torch wick equivalent.
  - `belly_wool`, `noil` → stuffing for pillows/mattresses/gambesons.
  - `lanolin` / `dirty_suint` → leather chain (waterproofing), candle chain, soap chain.
  - `fuller_liquor`, `spent_lye`, `grey_water`, `spent_dye` → drained; environmental
    flavour only today, could feed a pollution/corruption system later.
  - `wool_dust`, `scale-analogues` → discarded.
- **Top engine gaps in this category:**
  - **`GAP-ENV`** — the most frequent. Retting needs standing water and warmth; dew-retting
    needs dew and cool nights; bleaching-greens need sustained direct sun; rope-walks need
    length; deployed fishing nets need submersion in water. Textiles more than any other
    category tie production to physical terrain affordances. Closing this gap would be the
    single highest-leverage engine change the category motivates.
  - **`GAP-CHECKPOINT`** — retting and fulling both have "is it done?" judgement calls that
    compress poorly to fixed tick counts. Over-ret destroys fibre; under-ret yields none.
    Today modellable only as binary success with fixed ticks + lore-gated skill. A first-
    class "sample the station, decide to continue or stop" primitive would map cleanly
    onto the real craft.
  - **`GAP-PROCESS-PARAM`** — fulling time → cloth density; felting agitation → felt
    density; retting temperature → fibre quality. These are continuous dials in reality
    and discrete/binary in the current model.
  - **`GAP-QUALITY`** and **`GAP-SKILLED-YIELD`** appear throughout — a skilled heckler
    extracts more line and less tow from the same retted bundle; a skilled fuller hits
    the density target; a skilled weaver produces tighter, more even cloth.
  - **`GAP-PORTABLE-CRAFT`** (new gap, flagged by nalbinding) — timed recipes with no
    station. Workaroundable via a "portable stool" workstation item, but worth naming.
  - **`GAP-STATE`** — scouring vats, fulling troughs, tarring pots, dyeing vats all want
    a "hot?" state beyond the buffer. Workable as fuel-input today but loses the
    "stoke the fire" interactivity flagged in the README.
