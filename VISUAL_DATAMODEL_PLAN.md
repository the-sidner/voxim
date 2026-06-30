# Visual Data-Model Arc — author the world's look as content, not client hacks

**Thesis (the user's call, 2026-06-26):** stop achieving visual richness with incremental client-render
hacks. Achieve it the way the **animation arc** did — *planned extensions/refactors of the data model
across server → content → client*, each with an **authoring + live-preview devtool**. The look's target is
the art bible in `data/fake-art/`, captured as a data-model spec in **`ART_DIRECTION.md`** (read that
first — it is the *goal*; this is the *route*).

## Why this is a refactor, not new architecture

The repo already proves the pattern: the five engine/visual primitives
(Action/Resource/Status/Trigger/**ProcModel**) are each *"one content def + one registry-dispatched
handler + a boot cross-check"*. Terrain SHAPE is already server-authoritative
(`Heightmap`/`MaterialGrid`/`KindGrid`/`OpenMask` chunk components). The look is **mostly already
data-driven**; richness leaks OUT of the data model wherever it is **derived on the client from a
position-hash or a hardcoded numeric-id switch** instead of read from enriched content/server data.

The original three-hack framing was correct but **too narrow**. The full art bible shows the gap is a
*family*: per-voxel tint hash, the `DRAW_FN` numeric-id switch, the client `CLIFF_*` terrace consts — *and*
a missing scene layer (atmosphere/grade/lighting/decals/creatures/water) the look needs but the data model
never modelled. The bible also shows that these are **not N features but 7 reusable primitives** (the
*grammar*). Modelling the grammar once is the highest-leverage move.

---

## The grammar — 7 primitives that cover the whole bible

(Full table + which sheets each comes from: `ART_DIRECTION.md §2`.)

- **G1 · PerCellServerFieldGrid** — one networked chunk-component idiom (sibling of `KindGrid`) for every
  coherent spatial scalar/descriptor the atlas can derive but today discards (canopy-light, corruption,
  fertility, wetness, wear, water level, cliff tier, road kit, decals). Atlas-written in `upsample.ts` +
  `atlas_terrain.ts`, RLE/zlib-packed, networked on a permanent `ComponentType` wireId. **Never consulted
  for collision.** *This is the anti-position-hash substrate.*
- **G2 · FieldExpr** — a closed, boot-validated `Array<{field,curve:'linear'|'smoothstep'|'step',min,max,
  weight}>` summed-then-clamped (the `ResourceDef.rateModifier` precedent). One shared evaluator over the
  G1 fields, used by vegetation density/species, overgrowth combine, wetness/wear curves. *Note: this is a
  validated field-name→grid-plane binding, **not** a behaviour registry — keep it a closed vocabulary; do
  not dress field-sampling up as registry-dispatch (see §"Honesty notes").*
- **G3 · MaterialStateLadder** — `MaterialDef.variants[]` (ordered ladder: `colorShift`/`emissiveCracks`/
  partial-render/`addsTags`) selected by a **server-authoritative index** resolved by **stable
  string-id→index at boot** (not raw array position). Two-state (sacred↔corrupted, healthy↔corrupted) and
  N-state (fresh→weathered→decayed, upgrade-stages) are the *same* ladder at length 2 vs N. Retire
  `corrupted.json` *into* a stone variant (data + code move together).
- **G4 · SurfaceTreatment + TextureStyle registry** — convert `material_textures.ts DRAW_FN` (numeric-id
  switch) into a `Registry<DrawFn>` keyed on `MaterialDef.render.textureStyle`, plus a sibling treatment
  registry both the voxel material **and** the water mesh dispatch through (wet street == water surface ==
  same reflection handler, keyed on an authored treatment id — never `if name==='water'`). Decal painters
  reuse it. One handler file + one `register()` + boot-check per style.
- **G5 · ProceduralAssemblyKit** — authored part-def (footprint/profile/tier/state) + a registry of
  assembly **strategies**. The **server/atlas resolves the concrete instance list** (`SettlementPlan`,
  stepped `Heightmap`+`CliffGrid`) deterministically from seed; the **client only dispatches** each part's
  strategy-id to a registered handler that emits `VoxelAtom[]` — never deciding what/where (that's the
  `CLIFF_MIN` client-hack we're unwinding). Reuses the ProcModel generator registry + `InstancePool` +
  the world-position-lattice weld contract. Growth/decay-over-time rides the **Resource primitive**.
- **G6 · PerVoxel render-attribute sidecar** — generalise `bakeVoxels` to write *optional* parallel
  per-voxel attributes (`aFray`,`aCoreness`,`aWetness`) from content; absent ⇒ byte-identical to today
  (zero cost for solid models). Per-frame motion (creature drift/hem-drip) is a **whole-voxel translation
  in the vertex shader** (geometry immutable, normals + atomic cubes + outlines survive), driven by ONE
  networked scalar (`dissolutionPhase` on `AnimationStateData`). The position-hash is demoted to sub-voxel
  grain on top.
- **G7 · AuthoredEnvParamSet** — lift a magic-constant block *whole* into a content def (`AtmosphereDef`,
  `GradeDef`, `LightDef`, `WaterStyleDef`) owning the **full** param set (partial = orphaned
  half-migration the doctrine forbids), select by a networked context key (`biomeId`/`gradeId`/`phase`)
  via content lookup (not a numeric switch), and **lerp** params on transition (generalise `setPhase` from
  colours to all env params) with hysteresis/min-dwell so a biome seam doesn't strobe. Shader maths
  unchanged — only the *source of the numbers* moves.

---

## Three hard invariants — get these right BEFORE any code lands

These are the non-negotiables from the adversarial review. Each is a permanent or expensive-to-reverse
decision.

### I1 · The per-grid FIELD-SET MATRIX, frozen, before the first chunk-component wireId is minted.
Grids are **permanent** (`component_types.ts` proves IDs are never reused). The single biggest lock-in risk
is **not** whether grids exist — it's their *field set*. Under-speccing a field forces a second wire break
or a client-side re-derivation (a hack). Before Phase 3 code: write the **exhaustive `axis × field` matrix**
— every consumer × every field it reads — and confirm each grid's field set covers all *current* and the
**explicitly-named-deferred** consumers (runtime corruption spread, dynamic wetness, **ruin-age**). Bake the
widths deliberately (`variantIndex:u4` = 16 variants max is a forever-decision).

**Wire-budget correction (verified):** terrain chunks are **always visible and never leave AoI**
(`aoi.ts:130`); they are sent **once**, gated by `MAX_CHUNK_SPAWNS_PER_TICK=20` (`aoi.ts:39`). There is no
"delta on chunk entry" — the constraint is the **initial chunk-stream flood** against the QUIC flow window.
Each 32×32 chunk is ~6 KB today; the field grids roughly **3–4×** that (~20 KB), lengthening the initial
load stall. Therefore: **packed codecs (RLE/zlib) are mandatory, not optional**, and re-deriving
`MAX_CHUNK_SPAWNS_PER_TICK` is part of Phase 3's deliverable. Open call: cap field resolution (1 field-cell
per 2×2 terrain cells) to halve payload? (trades gradient sharpness for stream size).

### I2 · `MaterialDef.render` complete shape + ONE networked render-context key land in Phase 0, frozen.
Six axes extend `render` (tint/relief/wetness/reflect/mossBlend/glowFamily/variants) and **three axes
independently want a biome/grade selector**. Partial landings orphan constants and duplicate wire fields —
the exact half-migrated state the doctrine forbids. Phase 0a freezes the **full `render` block shape** (all
sub-fields optional) in one commit even though consumers land later; and **one** networked per-player
**render-context key** (a small struct: `biomeId` + phase/zone keys) is defined up front — atmosphere,
grade, and future per-region selectors all read it. No three separate small wire bumps.

### I3 · Settle the three doctrine-edge decisions explicitly, in writing.
- **(a) Overhang is DROPPED from v1.** A single-height `Heightmap` cannot express an undercut → a rendered
  overhang is a render>collision divergence. Do not ship the `overhang` voxeliser registry slot. Gate its
  return behind a future volumetric-terrain primitive.
- **(b) The `dissolves` per-voxel drift shader is a deliberate, capped, harness-verified amendment** to the
  "no per-frame voxel offset" rule — *or it doesn't ship*. It stays in-shader (uniforms + static
  attributes, zero CPU re-bake) **and** hard-caps separated-voxel count + max separation as content fields
  the devtool enforces visibly, because drifting voxels get **individually outlined** by the Sobel/SSAO
  EdgePass — verify EdgePass cost under a crowd of dissolving haunts via the testplay harness *before*
  authoring.
- **(c) `variantIndex` must be a content-version-checked stable index.** The grid carries the
  string-id-derived stable index resolved **at atlas-bake**; a boot cross-check asserts the atlas's
  variant-id table and the client bootstrap's variant-id table are the **same content version** (the
  bootstrap-blob version property), or stones silently mis-state on version drift.

---

## The arc (T-311) — reworked, dependency-ordered, smallest-first

`✶` = needs an atlas **re-bake** (server/atlas); all others are **client-render / content** (no re-bake).
Re-bake is unblocked via the dev service secret (see memory `project_visual_datamodel_arc`).

### Phase 0 · Lift the client hacks into the data model (honest foundation, no new look)
- **0a** — Add the **complete** `MaterialDef.render` block (per **I2** — freeze the shape now). Convert
  `material_textures.ts DRAW_FN` → **TextureStyle registry** (G4). Move `voxelTint` salt → `render.tintJitter`.
- **0b** — Promote `terrain_voxels.ts CLIFF_*` consts → `terrain_config.json` (interim; **superseded by
  Phase 6**).
- **0c** — Drive `buildMaterialMap` off a content table, not a hand switch.
- **0d** — Stand up the shared **FieldExpr** data shape + boot-cross-check skeleton (per G2) so Phase 3+
  plug in. Define the **one render-context wire key** (per **I2**).
- *Deliverable:* render block + registries with boot checks; tint/relief/material-map read from content;
  `deno check` green; **zero behavioural change** verified via testplay.

### Phase 1 · Studio Material + ProcModel preview panels (the devtool — animation-arc analog)
- **1b Material route** — edit `render` block + variants; live-preview through the **real**
  `voxelTint`+`getVoxelTexture`+`buildVoxelMaterial` on a lit wall, with **mock** SurfaceStateGrid sliders
  (wetness/overgrowth/wear) + a variant dropdown (fresh↔weathered↔decayed↔corrupted side-by-side).
- **1a ProcModel route** — real generator registry + `bakeVoxels` preview.
- Add `materials/ procmodels/ scatter/ biomes/` to `serve_devtools.ts WRITABLE_PREFIXES`.
- *Devtool honesty (per review):* Phase-1 panels preview **the render of a value** (mock cell, legitimate);
  they **cannot** validate field *coherence* (does corruption pool near ruins?) — that needs the real
  atlas-derived grid and is strictly the Phase-3b **Atlas-inspector heat overlays**. Keep the two separate.

### Phase 2 · Material state ladder + grade + local lighting (content + client, NO new server grids)
The three cross-cutting primitives that need no wire break (or only a tiny one):
- **G3 MaterialStateLadder** — `MaterialDef.variants` + stable-id→index; retire `corrupted.json` into a
  stone variant (per **I3c** for the wire index later).
- **G7 GradeDef** — lift **all 13** EdgePass constants into `GradeDef` (delete the constructor block in one
  commit), select by the generic networked `gradeId` from **I2**, lerp on transition.
- **LightDef + FlickerCurve + client `LightBudget`** — content lights; a fixed PointLight pool ranks
  emitters and renders nearest-N, the rest **degrade to always-on emissive flame voxels** (no pop). Add
  `lightDefId`+`priority` to the `LightEmitter` wire field; **drop the old `flicker` float in the same
  bump** (refactor replaces, not accretes). Single source of truth: prefer client-resolves-from-`lightDefId`
  unless a guttering-fire runtime intensity override justifies numbers-on-wire.
- *Deliverable:* per-biome/phase grade; corrupted = stone variant; dozens of glows via `LightBudget` with
  no pop; Studio Grade + Light panels. One small wire bump.

### Phase 3 ✶ · The unified per-cell field grids — ONE wire-format pass (the load-bearing decision, **I1**)
Land ALL server-authoritative spatial render grids together so the wire breaks **once**. **FIELD-SET
MATRIX — SIGNED OFF (user, the irreversible I1 decision):**

| Grid | Fields (per cell) | Bytes |
|---|---|---|
| **`VegFieldGrid`** | `canopyLight` u8 · `corruption` u8 · `fertility` u8 | 3 |
| **`SurfaceStateGrid`** | `wetness` u8 · `overgrowth` u8 · `wear` u8 · `variantIndex` **u8** · `ruinAge` u8 · `traffic` u8 (subsumes the old standalone `OvergrowthGrid`) | 6 |
| **`WaterGrid`** | `surfaceLevel` f32 (NaN = no water) | 4 |

Two grids (vegetation vs surface-state — distinct consumers/cadence) + WaterGrid separate (f32). **Full
resolution** (1 field-cell per terrain cell). `ruinAge` + `traffic` baked in now (the explicitly-deferred
consumers — ruin-age drives the "oldest stone most swallowed" overgrowth; traffic feeds vegetation
fertility/path-clearing + decals) so there is **no second permanent wire break**; `variantIndex` is **u8**
(256 variants, no 16-ceiling). Atlas-derived from signals it already computes; `upsample.ts` rescales
(smooth=bilinear, discrete=nearest, water-level=uniform); new `ComponentType` wireIds + **mandatory
RLE/zlib-packed** codecs (smooth fields compress hugely); boot cross-checks; re-derive
`MAX_CHUNK_SPAWNS_PER_TICK` for the bigger initial chunk-stream flood. Consumers are **minimal stubs** this
phase (prove the data arrives). FieldExpr/FieldSampler substrate lands here (with the grids as its data).
- **3b** — Atlas-inspector **heat overlays** for each field + live rule-weight sliders re-running the real
  atlas stage; one re-bake validates coherence (pools near water/ruins, recede on dry tops).

### Phase 4 · Field consumers — vegetation, overgrowth, wetness, decals (client reads Phase-3 grids)
- **FieldExpr-driven `ScatterDef`** — the *composition substrate for density* (see §Density through
  composition): add **species table**, **`densityField`** (replaces the one-per-`stride` + hash gate),
  **cluster count range**, **sub-cell jitter**, and **`layer`/priority** so many layers co-occupy a cell;
  rewrite all 7 scatter JSONs in one commit (no accretion). **Corruption-morph generators** (bucketed ≤4 tiers **from the server field**,
  never a hash). **Moss-creep** (`render.mossBlend` reads `SurfaceStateGrid.overgrowth` into the per-voxel
  `color` attribute, G6). **Wetness specular** from the grid via the G4 treatment registry. **Litter ground
  layer** — coarse **per-N-cells**, not per-cell (per the InstancePool cap below). **Surface-walk registry**
  (`floor`/`wall`, deleting the implicit floor-only walk). Server-authoritative **`DecalGrid`** + decal
  source registry seeded from the closed event catalog — **decide saved-vs-ephemeral** (see review §8:
  atlas-seeded static rubble = saved chunk-component; runtime combat blood = probably in-memory + decay,
  not saved).
- *Deliverable:* continuous groundcover/species + healthy↔corrupted morph + moss-creep + wet streets +
  persistent marks, all driven by server fields; Studio Scatter-Field-Painter + Grade&Decal panels;
  **no re-bake**.

### Phase 5 · Atmosphere + sun-arc + creature fragmentation (the signature volumetrics)
- **G7 `AtmosphereDef`** selected by networked biome; **GroundMistLayer** (depth-reconstruction pass);
  **canopy-gated god-rays** sampling the real sun shadow map. **Server-authoritative sun altitude/azimuth**
  on the day-phase payload (shafts + shadows agree) — *replaces* the client `SUN_DIR` constant, and **water
  reads this same sun source** (sequence: sun-arc lands before/with water).
- **Creature fragmentation (G6)** — `voxel_creature` generator + fray/coreness sidecar + `DissolveProfileDef`
  shader (in-shader drift) + one `dissolutionPhase` f32 on `AnimationStateData` + a `shed_voxels` effect /
  `shed_dissolve` DeathHook. Honour **I3b**.
- **Water (cheap reflection, deferred probe)** — ship `WaterStyleDef` + `render.wetness`/`render.reflect`
  via G4, and a **cheap** reflection (screen-space emissive-streak + sky-gradient weighted by wetness — the
  `image-gen-3` torch-streak look). **Defer the full planar probe** to a named follow-on arc.
- *Caveat (review §6):* the shadow frustum is ±60u; on-screen shafts beyond that fall back to a uniform
  smear → either widen/cascade the frustum (real engine work, scope it) or author god-rays as **near-field
  only** and say which in the AtmosphereDefs.

### Phase 6 ✶ · Server-authoritative terraced cliffs (supersedes 0b; the G5 proof)
Atlas resolves perimeter cells into tier bands via **`CliffProfileDef`** + emits the **stepped `Heightmap`**
AND a **`CliffGrid`** {profile/erosion/tier/edge}. Client **deletes `CLIFF_*`** and voxelises the
authoritative heights, dispatching `profileId` through a **`cliffVoxeliser` registry**
(columnar/broken/sloped/stone_stair). Collision agrees because physics floors against the same stepped
heights. **Overhang dropped (I3a).** Scree via the world-lattice seeding.
- *Deliverable:* real stepped cliffs with 3 erosion states, collision+render agree, `CLIFF_*` deleted;
  Studio Cliff panel with a **collision-overlay** toggle; re-bake.

### Phase 7 ✶ · Modular settlements + roads (LATER — the largest axis, scoped)
**Not a 3-file primitive — a procedural-city composer.** Scope to: land
`StructureModuleDef`/`SettlementDef`/`RoadKitDef` def-shapes (footprint/socket/tier/`stateVariants`)
minimal-but-complete + **ONE** layout strategy + a handful of modules + `RoadGrid` wireId +
`SettlementMember` component + the layout-strategy registry, **projecting footprints back into `OpenMask`
at atlas time** (else players walk through walls). Full tier × upgrade × road-kit content is a follow-on
arc. **Architecture decision to resolve first (review §13):** settlement growth/decay-over-time is *new
saved runtime state* unless it is fully derivable from seed + WorldClock (like the POI DAG) — pick
recompute-from-seed, or explicitly expand the save model. Don't pretend this fits the core-finishing window.

### Cross-cutting · Hot-reload loop (any time after Phase 1)
tile-server `/admin/reload-content` (re-run `JsonSource.load` + re-encode the bootstrap blob) + a client
"refresh blob" → a Studio **Save** reaches the live game in seconds (terrain re-bake stays gated by
`VOXIM_SERVICE_SECRET`).

---

## Order & dependencies

`0 → 1 → 2` (no-rebake content/client foundation: the render block, devtools, state-ladder, grade,
lighting) → `3 ✶` (the one wire break — the load-bearing field-grid pass) → `4` (consumers, no re-bake) →
`5` (atmosphere/creatures/water) → `6 ✶` (terraced cliffs) → `7 ✶` (settlements, last + partial). Phases
0–2, 4, 5 are no-rebake; 3, 6, 7 each cost one re-bake.

**Devtool-first within each phase** (the animation-arc discipline): build the live-preview panel that runs
the **real shipped runtime** (the Swing-Inspector rule — never re-implement the effect), then author against
it. The InstancePool cap (`MAX_INSTANCES_PER_ARCHETYPE=4096`, clip-and-warn, `instance_pool.ts:38`) is a
**first-class authoring constraint surfaced in the Scatter panel** (projected instance count vs cap as you
paint) — not a boot-time warning after the look is authored.

---

## Density through composition — start small, then combine

The success criterion (`ART_DIRECTION.md §1`) is the **layered density of the screenshots**, reached by
*composing small primitives* — never by hand-authoring scenes. Two parts: the composition model, and the
authoring ladder.

### The composition stack — density = many field-driven layers in one cell

Today scatter places **one prop per `stride×stride` block, gated by a binary kind/material match + a
per-cell hash probability** (`ScatterDef`, `content/src/types.ts:963`) — uniform and single-layer, the
*opposite* of the references. Density emerges when **many layers co-occupy a cell**, each its own
`ScatterDef`, each density-*varied* by a `FieldExpr` over the server grids (bottom → top):

| Layer | Examples | Granularity |
|---|---|---|
| 0 base | material relief + per-voxel tint (already there) | per-voxel |
| 1 litter | twigs / leaves / pebbles / forest litter | coarse, per-N-cells |
| 2 low cover | grass tufts, moss clumps, small ferns | per-cell, high count |
| 3 mid cover | bushes, large ferns, reeds, mushroom clusters | per-cell, clustered |
| 4 tall | saplings, thorn thickets | sparse |
| 5 canopy | large trees (the existing forest scatter) | sparse, large |
| 6 overgrowth-on-stone | moss blend + wall vines/saplings | OvergrowthGrid + `surface:'wall'` |
| 7 props | barrels / fences / campfires | POI / placement, not pure scatter |
| 8 debris + decals | rubble near ruins, blood near combat | event / proximity driven |

The data-model fields density **requires** (the sharpening of Phase 4 — *all absent today*): **cluster
count range per cell** (place N, not one-per-block); **sub-cell jitter** (clump, don't grid-align);
**`layer`/priority** (many defs compose without stride-fighting); **species table** (one "ground cover" def
places a weighted fern+grass+moss mix); and **`densityField`** replacing the hash gate — so density *varies*
(dense in shade/fertile, sparse on dry rock). *That variation is what reads organic instead of a uniform
carpet.*

### The authoring ladder (start small → combine)

Because every layer is field-driven, you tune **one** scene's recipe and the data replays it everywhere:

1. **One primitive** — author one fern generator; bake it in the ProcModel panel (Phase 1).
2. **One layer** — a `ScatterDef` placing it at field-driven density on a 32×32 patch in the
   Scatter-Field-Painter; watch density follow the painted field.
3. **One HERO CELL, fully dense** — stack ALL layers (litter→grass→fern→bush→sapling→moss→vine→debris) in
   one patch, tune in the devtool until a screenshot crop is matched. The density vertical-slice — proves
   the whole composition stack before scaling.
4. **One HERO SCENE** — a composed set-piece (ruined-stairs-in-forest, like *Combat in the Ashen Wood*) +
   atmosphere + light + props. **The reference image becomes the acceptance test.**
5. **Propagate** — the hero scene's recipe (which defs, which field weights, which `BiomeDef`) is *data*;
   the field grids + biome tables **replay it across the whole world automatically.** Density scales by
   tuning, not by hand-placement.

### The two ceilings density forces (design for them now)

- **Perf / instance budget.** A dense scene at the ARPG camera is the stress case: thousands of
  instances/chunk × the outline + SSAO EdgePass (every small instance is *individually inked*).
  `MAX_INSTANCES_PER_ARCHETYPE=4096` is the binding constraint — surfaced live in the Scatter panel, plus
  **distance-thinning** (author a density falloff with range) and coarse per-N-cell layers for cheap
  fillers. Measure with `measure_fps.mjs` at every hero-scene step.
- **Readability beats raw density.** The references are **dense filler framing readable lit clearings** —
  the forest is a wall of dark detail; the clearing is open and lit. Negative space + value contrast are
  *part of* the composition (the roads sheet calls readability out explicitly). A `densityField` that
  recedes on paths/clearings keeps the player, enemies, and the path legible at telephoto distance.

---

## Devtool plan

Adopt the `AnimationEditor` recipe verbatim per axis: a Studio route = one `App.tsx` hash route + one editor
component reusing `Layout` (left AssetBrowser · centre `ViewportPane` · right inspector) + one
`WRITABLE_PREFIXES` entry, **centre viewport runs the SHIPPED client render code** imported from
`packages/client/src/render` (never re-implemented). Two families, ordered:

1. **Material/surface (foundation):** *Material* route (1b keystone — `render` block + variant dropdown on
   a real lit wall with mock surface-state sliders) · *ProcModel / Scatter-Field-Painter* (paint
   canopyLight/corruption/fertility on a 32×32 grid, run the real `decorateChunk` + generators, **show
   projected instance count vs the 4096 cap**) · *Creature/Dissolve* (real bake path + fray/coreness sidecar
   + the real `onBeforeCompile`, scrub `dissolutionPhase` 0→1).
2. **Atmosphere/scene (composited):** *Atmosphere* (real `EnvironmentLighting`+`GodRayPass`+`GroundMistLayer`
   + day-phase scrubber arcing the sun) · *Light* (real `LightManager`/`LightBudget` + crowd slider to
   preview culling/hysteresis) · *Grade & Decal* (real `EdgePass` + 13 grade sliders + "simulate hits") ·
   *Cliff/Terrain* (real `buildChunkAtoms` + `cliffVoxeliser` + erosion slider + **collision-overlay toggle**
   so authors SEE render-vs-collision divergence) · *Module Composer* (real layout-strategy + SettlementRenderer).

**Atlas-inspector upgrades (Phase 3b, the second devtool spine):** point its hardcoded `MATERIAL_COLOURS` at
real `MaterialDef` colours; add a **scatter overlay** (prop dots where each `ScatterDef` fires); add
**heat-overlay layers for every new field grid** with live rule-weight sliders re-running the real atlas
stage — author field **coherence** before a re-bake.

---

## Honesty notes (from the adversarial review — read before implementing)

- **FieldExpr is not registry-dispatch.** Field-sampling is a boot-validated *field-name→grid-plane
  binding*; calling it a registry to satisfy the anti-switch doctrine is ceremony. Reserve "registry" for
  things with real per-handler behaviour (texture styles, cliff voxelisers, decal painters, layout
  strategies). Keep FieldExpr a *closed* vocabulary (resist "just add a conditional").
- **The position-hash temptation recurs in every axis** and is the doctrine's primary failure mode. The
  test the devtools must make visible: every *how-much / which / where* answer traces to a wire field or a
  content lookup; **only sub-cell dither traces to a hash.**
- **Ruin-age** is the loudest "oldest stone is most swallowed" beat but the atlas may carry **no age field
  yet** → either add a chamber-age atlas field as an explicit Phase-3 sub-task, or drop the age-driven beat
  from v1 honestly (don't let `ageWeight` silently degenerate to 0).
- **Two genuinely-too-big axes** must ship the *data model* + a cheap stand-in, not the whole thing: water
  ships the grids + `render.wetness` + treatment registry + a **cheap** reflection (defer the planar probe);
  settlements ship **def-shape + one strategy + a handful of modules** (defer the 4-tier × 4-upgrade bible).
  Pretending either fits whole is the real dishonesty.

---

## Open questions for the designer (decisions only you can make)

1. **Wire budget vs fidelity** — ✅ RESOLVED (user): full resolution + mandatory RLE/zlib packing.
2. **Grid split** — ✅ RESOLVED (user): two grids (`VegFieldGrid` + `SurfaceStateGrid`), `WaterGrid`
   separate; `variantIndex` u8; `ruinAge` + `traffic` baked in now (see the Phase-3 field-set matrix).
3. **Sun-arc authority** — derive `sunAltitude/Azimuth` server-side from `WorldClock` (recommended; shadows
   + shaft UVs must agree) and add 2 floats to the day-phase payload?
4. **Overhang** — confirmed DROP from v1 (recommended), or one explicitly-reviewed decorative carve-out?
5. **Water reflection altitude** — cheap screen-space streak now + defer planar probe (recommended), or is
   the canal-city mirror important enough this arc to budget a second scene pass?
6. **Settlements scope** — in this visual arc at all, or a separate worldbuilding arc that merely *depends*
   on the visual primitives landing first?
7. **Corruption source-of-truth** — static atlas fbm + corrupted-POI seeds for v1 (recommended), dynamic
   spreading corruption deferred (grids designed mutable-but-static so the upgrade needs no wire break)?
8. **Decal persistence** — combat decals saved (chunk-component) or ephemeral in-memory with decay?

---

## The honest boundary — what this arc does NOT deliver

This arc builds the **instrument**; the art style is the **performance**. Completing Phases 0–7 closes
~100% of the *architecture* gap and gets ~70–80% of the *mood*, but the finished look is gated by three
further bodies of work, tracked as explicit tickets so the plan never pretends Phase 7 = "done":

1. **Content volume (`T-312`)** — the grids/registries/devtools are *places to author* flora, ruins,
   props, creatures, settlements, atmosphere/grade. The look only appears once those libraries are
   authored against the tools (weeks–months; LLM-seeding is the accelerant). *This is the largest remaining
   lift.* Without it, T-311 is a capable engine rendering a sparse world.
2. **Deferred render capabilities (`T-313`)** — a few genuine render features beyond the data model,
   ranked by visible-jump-per-effort:

   | Rank | Extension | Visible jump | Effort | Why this rank |
   |---|---|---|---|---|
   | 1 | **Arcing sun + raking shadows** | High (golden-hour mood) | Med | Reuses the server sun-dir P5 already adds; only the shadow-cam basis recompute is new. **Fold into P5.** |
   | 2 | **In-world water verify** | Low–Med | Very low | Shader exists (T-310 E); just needs reachable water (P3 `WaterGrid`) + tuning. Near-free. |
   | 3 | **Shadow cascades (full-frame god-rays)** | High (whole-frame, ARPG distance) | High | The general render upgrade; ±60u frustum makes shafts/shadows near-field only today. After the cheap wins. |
   | 4 | **Water planar-reflection probe** | Med (localized to water/wet) | High + fragile | The canal mirror; second scene pass vs outline+bloom. P5 ships a cheap streak first. |
   | — | **DoF / painterly post** | — | — | **Not pursued** — softening fights the crisp Sobel ink (anti-goal). |
   | — | **Normal/roughness PBR maps** | — | — | **Not pursued** — against the `flatShading` atomic-voxel doctrine. |

   *Already landed (T-310 follow-ups, **not** deferred): foliage wind sway, richer material weathering,
   hit-impact flash, camera-occlusion fade.*
3. **Presentation & composition (`T-314`)** — orthogonal to the render data model but load-bearing for
   "looks finished": HUD/UI polish, camera-occlusion extension to side-walls (`canopy_fade` already does
   overhead), and **composed-scene worldbuilding** (authored POI set-pieces so the procedural world reads
   as deliberately composed as the references).

**The ceiling we accept (and want):** the `data/fake-art` images are AI stills with painterly post — a
real-time hard-edged voxel renderer will not reproduce them 1:1, and *shouldn't* (the comic idiom is the
T-310 decision). The target is **"the same world, mood, and visual language at playable framerate"**, not
"indistinguishable from the render". None of the three gap-bodies above require changing the data model —
which is the whole point: **we reach the look without locking the core into the wrong shape.**
