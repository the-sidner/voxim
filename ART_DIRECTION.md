# Art Direction — the target look, read as a data-model specification

**Source:** the reference bible in `data/fake-art/` (2026-06-26). ~6 in-game ARPG mockups + a set of
annotated **concept-sheets**. The central realisation that drives the whole visual arc:

> **The concept-sheets are not mood art — they are data-model specifications.** Every sheet annotates a
> *grammar* (modules, tiers, states, assembly rules, light-response, wear). The job is not to "paint the
> reference" on the client; it is to put each idea on its correct authority (server/atlas grid · content
> def · client-render that reads both) and land it as **data + registry + boot-check + devtool** — the
> same five-primitive doctrine (`Action`/`Resource`/`Status`/`Trigger`/`ProcModel`) applied to the *look*.

This document is the **goal**. `VISUAL_DATAMODEL_PLAN.md` (T-311) is the **route**.

---

## 1 · The look (verified target aesthetic)

Top-down / three-quarter **ARPG camera** (Diablo / Path of Exile / Last Epoch framing), rendered in the
**stylized atomic-voxel idiom we already keep** (Teardown-ish hard cubes, Sobel outlines, `flatShading`)
— but painterly and cinematic:

- **Near-monochrome, heavily desaturated base** (charcoal / ash / muted forest green) with **selective
  saturation**: warm amber firelight and hot **red corruption glow** are the *only* vivid colour. Strong
  painterly **value contrast** — crushed shadow against small warm highlight pools.
- **Heavy atmosphere**: volumetric **god-rays** through canopy, thick depth **fog + aerial haze** fading
  distance to soft grey, dust in the light, low **ground mist** pooling in valleys / over water.
- **Warm local point-light pools** (torch / campfire / lantern) carved out of the dark — the dominant
  lighting motif, not the sun.
- **Overgrowth reclaiming ruined stone** — moss creep + vines + saplings on stairs/walls. *The* signature.
- **Wet, faintly reflective surfaces** (cobble streets reflecting torchlight; canal water).
- **Voxel creatures that fragment** — bodies of cubes that drift / shed / disintegrate, with glowing red
  emissive cores.
- **Ground detritus** — blood splatter, debris, rubble, scattered litter.
- Everything must **read at ARPG telephoto distance** — clutter is a readability hazard, not just decor.

**The success criterion is DENSITY** — the *erdrückende*, layered richness of the in-game mockups (a wall
of dark overgrown detail framing a lit, readable clearing), **including the authoring effort to reach it**.
Density is not a stretch goal bolted on at the end; it is *the* target, and it is reached the way the whole
engine is built — by **composing small primitives** (one fern → a ground-cover layer → all layers in one
cell → a whole biome), not by hand-authoring big scenes. See `VISUAL_DATAMODEL_PLAN.md §Density through
composition`.

The idiom is **deliberate and kept** (the T-310 decision, load-bearing): outlines + `flatShading` stay;
voxels of varying size are the **atomic units** — no bevels / smooth-normals / subdivision / PBR realism
that would round them away. "Richer" = *more detail + AAA light/atmosphere within the comic idiom*,
**never** realism.

---

## 2 · The recurring grammar (the highest-leverage insight)

The bible repeats the **same handful of structural patterns** across every sheet. Each one is a *single
reusable primitive* — model it once, not per-feature. These are the spine of the plan:

| # | Grammar primitive | Recurs in (sheets) | Model it once as |
|---|---|---|---|
| G1 | **PerCellServerFieldGrid** — coherent spatial scalar/descriptor the atlas can derive but today discards | flora (canopy-light/corruption/fertility), overgrowth, surface wetness/wear, water level, cliff tiers, roads, decals | one networked chunk-component idiom (sibling of `KindGrid`), atlas-written, RLE/zlib-packed, **never consulted for collision** |
| G2 | **FieldExpr** — `look = f(field₀..fieldₙ)` | veg density+species, overgrowth combine, wetness/wear curves, water gradient | a closed, boot-validated `Array<{field,curve,min,max,weight}>` summed-then-clamped (the `ResourceDef.rateModifier` precedent), one shared evaluator |
| G3 | **MaterialStateLadder** — "same geometry, two/N authored states" | healthy↔corrupted, **sacred↔corrupted**, fresh→weathered→decayed, settlement upgrade-stages | `MaterialDef.variants[]` selected by a **server-authoritative index** (stable string-id→index at boot). Two-state and N-state decay are the *same* ladder at length 2 vs N |
| G4 | **SurfaceTreatment + TextureStyle registry** — surface appearance as dispatched handlers, never a numeric-id switch | relief (today's `DRAW_FN` switch), wetness/reflect (wet street == water surface), moss-blend, decal painters | `Registry<DrawFn>` keyed on `MaterialDef.render.textureStyle` + a sibling treatment registry both the voxel material **and** the water mesh dispatch through |
| G5 | **ProceduralAssemblyKit** — authored parts + a layout/voxeliser *strategy* registry; **server emits the plan, client only bakes** | cliff tiers, settlements, roads, tree/creature procmodels, scree/debris | "authored part-def (footprint/profile/tier/state) + registry of assembly strategies"; the atlas resolves the concrete instance list deterministically from seed; the client dispatches each part's strategy-id to a registered handler that emits `VoxelAtom[]` |
| G6 | **PerVoxel render-attribute sidecar** — content-authored per-voxel fields baked as vertex attributes, animated/shaded *in-shader* | per-voxel tint/mottle, moss-blend colour, **emissive cores**, **fray/drift dissolution**, wetness gloss | generalise `bakeVoxels` to write *optional* parallel attributes (`aFray`,`aCoreness`,`aWetness`); per-frame motion stays a **whole-voxel translation in the vertex shader** (geometry immutable, normals + atomic cubes + outlines survive) driven by one networked scalar |
| G7 | **AuthoredEnvParamSet** — a magic-constant block lifted *whole* into a content def, selected by a networked context key, lerped on transition | AtmosphereDef (fog/godray/mist/motes), GradeDef (the 13 EdgePass constants), per-phase palette colour (already), LightDef, WaterStyleDef | "lift the FULL param set into content (partial = orphaned half-migration), select by networked `biomeId`/`gradeId`/`phase`, lerp with hysteresis." Shader maths unchanged — only the *source of the numbers* moves |

**The anti-pattern these kill** (the project's primary failure mode): *richness derived on the client
from a position-hash or a hardcoded numeric-id switch instead of read from enriched content/server data.*
A position-hash may **decorrelate sub-cell placement / grain / weld** layered *on top of* a content/server
value — it may **never** be the gating "how much / which / where" decision (density, species, corruption
intensity, moss coverage, variant index, module placement).

---

## 3 · The sheets → what each demands → which authority owns it

| Sheet (file) | What it specifies | Authority |
|---|---|---|
| **Combat / Encampment / Ruins / Town / Camp** (in-game mockups) | the composite target: god-rays, fog, warm pools, mossy overgrown ruins, wet cobble, blood decals, the swing arc, HUD framing | — (the integration target) |
| **FLORA & GROUND-COVER** (`image-gen-7`) | ferns/moss/roots/vines/corrupted-growths/mushrooms; **canopy-break sunlight response** (full-shade/dappled/direct); **healthy↔corrupted** of the *same* plant; cluster types; biome transitions; **positional density+rot patches (0–100%)**; vegetation reclaiming paths | G1 (canopyLight/corruption/fertility grids) + G2 (density/species FieldExpr) + G3 (corruption morph) |
| **NIGHTMARE WASTES — terrain** (`image-gen-2(2)`) | cliff faces, fractured stacks, scree, overhangs, **terrace plateaus**, stairs, ravines; explicit **PROCEDURAL ASSEMBLY RULES**: voxel-density tiers, **erosion states** (fresh/weathered/decayed), **cliff-edge profiles** (sharp/broken/sloped/overhang), **plateau reveal tiers**, path-cuts | G5 (CliffProfileDef + cliffVoxeliser registry) + server-authoritative stepped Heightmap (collision+render agree) |
| **NIGHTMARE RUINS** (`image-gen-5(1)`) | chapels/shrines/altars/tombs/crypt-stairs/statues/watchtowers/gates/monoliths; **landmark hierarchy**; **SACRED vs CORRUPTED**; emissive red runes; procedural placement | G3 (sacred↔corrupted) + G5 (modules) + emissive cores (G6) |
| **SETTLEMENTS OF ASH** (`image-gen-6`) | shelter→outpost→village→city; core building modules; **building tiers (1–4)**; **upgrade stages**; tile/street/wall modules; landmark hierarchy; inhabitants spawn/despawn; "all x4, modular, replaceable" | G5 (StructureModuleDef + layout-strategy registry) + Resource primitive (growth timer) |
| **ROADS & ROUTES** (`image-gen-4(2)`) | route types; **junction procedural kit**; gates/shrines/milestones/barricades; wear states; **ROUTE READABILITY** (tactical/camera, clutter vs clear) | G5 (RoadKitDef) + G1 (RoadGrid) |
| **CARAVANS & INTERACTABLES** (`image-gen-8`) | carts/barrels/crates/lanterns/torches/banners/wells/chests/ritual-props; **modular variants**; **wear states**; loot breakables; **interactive glow cues** | content prefabs + G3 (wear) + LightDef/emissive (G6/G7) |
| **NIGHTMARE HAUNTS** + **WAILING SHADE** (`Voxim nightmare haunts…`, `image-gen-1(1)`) | bodies of cubes that **drift/shed/disintegrate**; dripping-cube hems; **glowing red cores/eyes**; named haunts | G6 (fray/coreness sidecar + dissolve-profile shader + one networked `dissolutionPhase`) |
| **MINARUN — CASCA WATERWAYS** (`805e6d0a`) | canal city on **water** with boats + reflections | G1 (WaterGrid surface level) + G4 (reflect treatment) — cheap reflection now, planar probe deferred |

The **emissive red corruption glow** and **warm fire** are the only saturated colour anywhere — they ride
G6 (emissive cores), G7 (GradeDef `signalHue` reservation), and LightDef `family`.

---

## 4 · The split, restated for visuals

- **SERVER / ATLAS authority** = *"where & what, coherently across the world and across clients."* Anything
  that must be identical for every player, survive reconnect, or **agree with collision** lives here:
  `Heightmap`/`MaterialGrid`/`OpenMask`/`KindGrid` today, plus the new G1 field grids and the atlas-resolved
  `SettlementPlan`/`CliffGrid`. Derived **once at boot** from signals the atlas already computes (moisture,
  altitude, ruggedness, distance-to-water, distance-to-stone) but today collapses to discrete ids and
  discards before the wire.
- **CONTENT authority** = *"the authored look knobs & rules, as a file drop."* `MaterialDef.render`,
  `AtmosphereDef`, `GradeDef`, `LightDef`, `DecalDef`, `CliffProfileDef`, `WaterStyleDef`,
  `DissolveProfileDef`, `ScatterDef`, `OvergrowthRuleDef`, `FieldExpr` recipes. Ride the bootstrap blob,
  boot-cross-checked against their registries (fail-fast, like every prior primitive).
- **CLIENT-RENDER authority** = *"stateless, deterministic tessellation/lighting that reads the above."*
  `buildChunkAtoms`/`bakeVoxels`/`buildVoxelMaterial`/`EnvironmentLighting`/`GodRayPass`/`EdgePass`/
  `ScatterRenderer`/`LightManager`. **Never invents a gameplay-coherent fact** from a position-hash or a
  numeric-id switch.

**Collision is sacred.** `OpenMask` stays the *sole* collision authority. Every new render grid is purely
cosmetic — a mossed stair stays passable; a "corrupted" variant's tags must not leak into stat derivation;
**cliff overhangs cannot be expressed in a single-height Heightmap → they are dropped from v1, not shipped
as a quiet render>collision divergence.**
