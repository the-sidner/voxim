# Workstation Consolidation — Content Authoring Reference

The SUMMARY deduplicates by name (cauldron absorbs kettle, etc.) and lands on
~75 stations. That is still too many to author, too many for a player to
navigate, and a fragmentation of mechanically-identical things. This document
takes the harder cut: group by **mechanical shape**, parameterise by **data**,
and target a ~17-station endstate.

We deliberately do **not** solve the engine gaps here. Every consolidation
decision below works with the Recipe / WorkstationTag / WorkstationBuffer
shape that exists today. Where a station's *full* expressivity needs GAP-STATE
or GAP-PROCESS-PARAM to feel right, we still author the station today; the
expressivity remaining locked up is a content limitation, not an engine
blocker. First-wave content is exactly the subset of chains that read well
without those gaps closed.

---

## The target taxonomy

17 stations. Every chain in the category catalogues maps to one of these,
parameterised by recipe data (ticks, inputs, required tools, step type).

### Thermal family — 7 stations

| `stationType` | Role | Absorbs | Parameter source (today) | Full expressivity needs |
|---|---|---|---|---|
| `furnace` | High-heat reducing / melting — ore to metal | bloomery, copper_furnace, crucible_furnace, lead_hearth, lime_kiln, roasting_hearth, cupellation_hearth, cementation_crucible | Recipe inputs + ticks. `charcoal` quantity encodes rough temperature. | GAP-PROCESS-PARAM (true temperature dial), GAP-STATE (lit / fuel-remaining) |
| `kiln` | Updraft ceramic firing | updraft_kiln, annealing_lehr, brick_clamp\* | Recipe inputs + ticks | GAP-STATE (pre-heat, cool-down) |
| `oven` | Low-heat baking / arrest | bread_oven, malt_kiln | Recipe + ticks | — |
| `smokehouse` | Cold / hot smoke | smokehouse, smoke_pit | Recipe + ticks | GAP-ENV (chimney cross-draught is flavour) |
| `cauldron` | Hot liquid vessel | cauldron, tinning_pot, glue_pot, brew_kettle, soap_cauldron, tar_kiln, saltern_hearth | Recipe inputs | — |
| `still` | Distillation | alembic_still | Recipe + ticks | GAP-PROCESS-PARAM (heads / tails cuts) |
| `pyrolysis_pit` | Outdoor dry-distil (consumed) | charcoal_clamp, tar_pit | Recipe + ticks | GAP-CONSUMED-STATION (workaround: deployable that despawns on complete) |

Glass-furnace work is **not authored** in the first wave — its craft *is* its
state, and GAP-STATE is mandatory. Flag and defer.

\* brick_clamp is the same workaround as pyrolysis_pit: deployable-that-despawns.

### Wet / vessel family — 4 stations

| `stationType` | Role | Absorbs | Parameter source (today) | Full expressivity needs |
|---|---|---|---|---|
| `vat` | Liquid soak / ferment / ret / tan | soaking_vat, retting_pond, dye_vat, woad_vat, vinegar_crock, pickling_crock, fermenter, mash_tun, steeping_cistern, cheese_vat, tanning_pit, lime_pit, bating_tub, scouring_vat, tawing_drum, fulling_trough, slip_bath, brine_well | Recipe inputs drive the chemistry; ticks drive duration | GAP-STATE (woad alive/dead, tanning liquor strength), GAP-BATCH (real pits hold 20+ hides) |
| `pan` | Open evaporation / settling / cooling | salt_pan, crystallising_tub, settling_tub, settling_pan, cooling_tray | Recipe + ticks | GAP-ENV (solar salt) |
| `cellar` | Cool / humid aging | cellar, wine_cellar, cheese_cave | Recipe + ticks | GAP-ENV (below-ground), GAP-CHECKPOINT (peak-window) |
| `danger_pit` | Reactive outdoor pit | slaking_pit, verdigris_pot, lead_stack_bed | Recipe + ticks | GAP-DANGER-INPUT (damage on-tick), GAP-ENV |

### Mechanical family — 6 stations

| `stationType` | Role | Absorbs | Parameter source (today) | Notes |
|---|---|---|---|---|
| `millstone` | Grind / pulverise | hand_quern, watermill, windmill, grain_mill, ore_stamp, mortar_and_pestle, muller_slab | Recipe + tool + ticks. Power source is a prefab-model variant, not a sim parameter. | — |
| `press` | Apply sustained compression | cheese_press, oil_press, wine_press, treading_trough, butter_churn | Recipe. Churn is functionally a press with a paddle tool. | — |
| `mould` | Shape pour / pack / wax | brick_mould, tile_form, casting_flask, wax_mould, form_block | Recipe | GAP-CONSUMED-STATION for lost-wax (workaround: mould is an input, not a station) |
| `rack` | Dry / cure / bleach | drying_rack, curing_rack, drying_yard, bleaching_green | Recipe + ticks | GAP-ENV for sun/wind-gated variants |
| `bench` | Single-operator surface: stand next to, tool in hand, swing at input | mason_bench, parchment_frame, fleshing_beam, staking_bench, currying_bench, shaving_horse, riving_brake, butcher_block, sorting_table, ink_bench, scribe_desk, chandler_bench, kneading_trough, knapping_stump, carding_bench, heckling_comb, flax_brake, scutching_board, teasing_frame, cloth_shearing_board, netting_bench, threshing_floor, handbuilding_mat, wedging_bench, ash_hopper, weathering_bed, glazing_bench, batching_bench, woad_ball_rack, mortar_trough, salting_floor, basketry_form | Recipe dictates what tool + inputs + station (toolType + stationType match). `workbench` anchor already exists in the game and becomes this. | This is the biggest collapse. See below. |
| `loom_device` | Large bespoke mechanical device | loom, spinning_wheel, potters_wheel, pole_lathe, cooper_workbench, glassblowers_chair, felting_mat, rope_walk, sand_saw_frame, draw_bench, heading_block, butter_churn | Each keeps a distinct `stationType` string because the player recognises them by silhouette; the data model is identical. | Render-only distinction |

### The `bench` collapse — justification

~30 stations consolidate into one. Each of them is mechanically identical
under the hood: a static surface, the player stands in range, equips a
specific tool, and swings to advance a recipe. What distinguishes them in
historical practice (mason vs scribe vs fleshing bench) is what tool you
bring and what material you place — both of which are already fully
captured by `Recipe.requiredTools` + `Recipe.inputs`.

Two things this loses:
- **Visual differentiation.** A scribe-desk and a fleshing-beam look nothing
  alike. Solution: keep the `stationType` string the same (`bench`) but
  allow per-deploy model variation. A prefab can declare `bench_scribe`,
  `bench_mason`, `bench_flesh` — each carries `workstationTag.stationType
  = "bench"` but a different `modelId`. Recipes gate on stationType so they
  are interoperable; visuals stay distinct.
- **Adjacency / co-location.** A "tannery" built from distinct benches
  reads as a place. If they're all `bench`, the player has less to build.
  Counter: they'll still build more benches because each serves different
  recipes, and they'll build them close together because that's where the
  materials are.

The six `loom_device` entries are kept as distinct station-types because
they read as *mechanical devices* rather than benches — a loom or a pole-
lathe has moving parts the player operates. Same data shape, distinct
identity. This is a render / player-model call, not a sim call.

---

## First-wave authorable subset

Stations that read well with zero engine gaps closed. These are the
prefabs we author now.

| `stationType` | First-wave chain usage |
|---|---|
| `furnace` | Charcoal-iron bloom → wrought iron; copper smelt; lime burn (basic) |
| `kiln` | Pottery firing (bisque + gloss) |
| `oven` | Bread |
| `cauldron` | Lye boiling, soap saponification, glue, brine boil (salt), dye liquors |
| `vat` | Bark tanning, flax retting, wool scouring, fermentation (ale, vinegar, cheese) — **without** GAP-STATE the woad / live-tan / live-vinegar dimension is flattened; flag in recipes with a `requiredFragmentId` to gate "advanced" variants |
| `pan` | Salt pan (boiled, not solar) |
| `millstone` | Grain → flour (quern variant); ore stamping |
| `press` | Oil press, cheese press, wine press |
| `mould` | Brick forming, sand-cast billets |
| `rack` | Drying: hides, herbs, linen, planks, pottery greenware |
| `bench` | Everything bench-like — one prefab family with model variants |
| `loom_device` | Specifically `loom`, `spinning_wheel`, `potters_wheel`, `pole_lathe` for first wave. Others defer. |

Deferred from first wave:
- `smokehouse`, `still`, `pyrolysis_pit`, `cellar`, `danger_pit` — each
  needs either GAP-ENV, GAP-STATE, GAP-CONSUMED-STATION, or GAP-DANGER-INPUT
  to read as intended. Authorable as flat time-recipes, but the craft
  doesn't land right.
- `glass_furnace` — explicitly blocked on GAP-STATE.

**First-wave station count: 12.**

Anchor stations already in Voxim: `campfire`, `workbench`, `chopping_block`,
`forge`, `anvil`, `alchemist_bench`, `altar`, `writing_desk`, `hearth`,
`furnace` (already in data — repurpose), `job_board`. Several of these map
onto the taxonomy above (`forge`+`anvil` are `furnace`+`bench` specialisations;
`chopping_block` is `bench`; `workbench` is `bench`; `alchemist_bench`,
`writing_desk`, `altar` are `bench` variants).

Migration path: keep the existing prefab ids. Don't rename `forge` →
`furnace`. Treat the existing ids as *instances* of the taxonomic family
(the `stationType` string can remain `forge` on a `forge` prefab, even
though conceptually it's a `furnace`-family station). The taxonomy is a
content-authoring guide, not a schema migration.

---

## What this reference is for

When a new recipe gets authored, its `stationType` field should be the
most-specific existing station in this taxonomy that fits. If no existing
station fits, add a new prefab — but first check whether the apparent
need is actually a recipe-data or a tool-data expression of an existing
family. The default answer is "use an existing station with new recipe
data." New stations are the exception.

When a chain is authored that exposes a gap, flag it in the recipe or
item file with the `GAP-*` tag from the SUMMARY. Engine work chooses what
to unlock by frequency, not by chain-by-chain advocacy.
