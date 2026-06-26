# Visual Data-Model Arc — author the world's look as content, not client hacks

**Thesis (the user's call, 2026-06-26):** stop achieving visual richness with incremental
client-render hacks. Achieve it the way the **animation arc** did — *planned extensions/refactors of
the data model across server → client → content*, with an **authoring + live-preview devtool** for each.
Build the devtools on the way.

## Why this is a refactor, not new architecture

The repo already proves the pattern **twice**: the engine primitives (Action / Resource / Status /
Trigger) **and** the T-285 **ProcModel / Scatter** visual primitive are all *"one content def + one
registry-dispatched handler + a boot cross-check"* — authored as a JSON file + a `register()` call,
never an engine edit. Terrain SHAPE is already server-authoritative (atlas → `Heightmap` /
`MaterialGrid` / `KindGrid` / `OpenMask` chunk components; the upper/lower zone graph is real data).

So the visual look is **mostly already data-driven**. What's missing is exactly three things, and they
all share one anti-pattern — *richness derived on the CLIENT from a position-hash or a hardcoded
numeric-id switch instead of read from enriched content/server data*:

| Hack today | Where | Should be |
|---|---|---|
| per-voxel **tint** (mottle) from a position hash | `voxel_bake.ts voxelTint()` | a `MaterialDef` field |
| material **relief** texture from a numeric-id → drawFn switch | `material_textures.ts DRAW_FN` | a **registry** keyed on a `MaterialDef` field |
| **terraced cliff** from hardcoded client consts off a flat 2.0u step | `terrain_voxels.ts CLIFF_*` | a **server-authoritative** stepped Heightmap (collision + render agree) |
| atlas-id → material **name** hand table | `atlas_terrain.ts buildMaterialMap` | content-driven |

**Server/client split to respect:** terrain SHAPE + gameplay-relevant signals (heights, masks, a new
*overgrowth* channel) = **server/atlas data**; geometry tessellation, relief, foliage instancing,
per-voxel tint = **client-render — but driven by content defs, not hardcodes.**

**The animation template to copy for the devtool:** the Studio `AnimationEditor`
(`packages/devtools/src/studio/`) — a `Layout` of *left AssetBrowser (filtered to a content dir) ·
centre THREE `ViewportPane` · right param inspector*, reading/writing content JSON via
`shell/file_io.ts`, and **running the REAL shipped runtime** (like the Swing Inspector reuses the real
evaluator) so the preview can't drift from the game. A new panel = one route in `App.tsx` + one editor
component + add the content subdir to `serve_devtools.ts WRITABLE_PREFIXES`.

---

## The arc (T-311) — phased, smallest-first; each phase = a data-model extension + its devtool

### Phase 0 · Lift the client hacks into the data model (no new look — make it honest)
- **0a — `MaterialDef.render` block.** Add `render?: { tintJitter?, textureStyle?, mossWeight?, relief?,
  wetness? }` to `MaterialDef` (`content/src/types.ts`). Move `voxelTint` → `MaterialDef.render.tintJitter`
  (per-material amplitude). Convert `material_textures.ts DRAW_FN` (numeric-id switch) into a
  **texture-style registry** (`register('stone', drawStone)`), keyed on `render.textureStyle`,
  boot-cross-checked. → adding a material's surface look becomes a **file drop**.
- **0b — terrace config to content.** Promote `terrain_voxels.ts` `CLIFF_MIN/STEP_H/STEP_INSET/STEP_MAX`
  into `terrain_config.json` (or a `GenParams.terrace` slice in the bootstrap blob). (Interim — Phase 3
  makes the shape server-authoritative.)
- **0c — atlas material map from content.** Drive `buildMaterialMap` off a content table, not a hand
  switch.

### Phase 1 · The Studio authoring + live-preview panels (the devtool — the animation-arc analog)
- **1a — Studio "ProcModel" route.** AssetBrowser → `procmodels/`; a schema-driven param form; the
  viewport runs the **real** generator registry + `bakeVoxels` (reuse the shipped code path, like the
  Swing Inspector) → live `VoxelAtom[]` preview on every param/seed change. Author trees/plants with
  sliders, see them instantly.
- **1b — Studio "Material" route.** Edit the `MaterialDef.render` block; live-preview `getVoxelTexture`
  on a lit voxel quad (colour + relief + moss).
- **infra —** add `procmodels/ scatter/ materials/ biomes/` to `serve_devtools.ts WRITABLE_PREFIXES`.

### Phase 2 · Richer trees & vegetation (content, authored in the new tools)
- **2a — richer generators + ProcModelDef params:** multi-material trunk (bark / core) + a **metaball
  canopy** generator (overlapping ragged clumps, interior light-gaps, drooping skirt) + multi-tone leaf
  materials; `leaf_bush`, `vine_strand`. (Designs already specced.)
- **2b — biome → scatter binding:** `BiomeDef.scatterIds[]` (or a biome filter on `ScatterDef`) so
  species vary by biome instead of one global `forest_oak`.
- **2c — dense layered ground cover:** `ScatterDef` places a CLUSTER (count range) per cell + sub-cell
  jitter + a `layer`/priority field so several defs compose without grid-aliasing.

### Phase 3 · Terraced upper/lower transition as REAL terrain (server-authoritative)
- **3a — authored cliff profile.** Atlas emits a real multi-step cliff (a `wallProfile`/`cliffHeight`
  on `PlateauRegion`, or a `TerrainTierDef` content type) instead of one fixed `WALL_HEIGHT=2.0`;
  `upsample.ts` writes the true **stepped heights** into the `Heightmap` component so **collision and
  render agree**. Delete the `CLIFF_*` terracing from `terrain_voxels.ts` — the client just voxelises the
  authoritative heightmap. (Stair-gating already server-side → no gameplay change, just honest terrain.)
- **3b — Atlas inspector upgrades:** terrace/tier knobs; point the inspector's hardcoded
  `MATERIAL_COLOURS` at the real `MaterialDef` colours; a **scatter overlay** (prop dots where each
  `ScatterDef` would fire).

### Phase 4 · Overgrowth channel (one server signal, two consumers — the "overgrown ruins" look)
- **4a — `OvergrowthGrid` chunk component** (server-authoritative, atlas-derived from moisture / age /
  proximity-to-ruins): a per-cell scalar.
- **4b — two consumers:** material relief blends **moss-creep** by overgrowth; **wall-scatter**
  (vines/saplings, `ScatterDef.surface:'wall'` + overgrowth threshold) keys on it. One signal feeds both.

### Phase 5 · Close the iteration loop (hot-reload)
- tile-server `/admin/reload-content` (re-run `JsonSource.load` + re-encode the bootstrap blob) + a
  client "refresh blob" → a Studio **Save** propagates to the live game in seconds (terrain still needs a
  re-bake, already wired via the Atlas inspector + `VOXIM_SERVICE_SECRET`).

---

## Order & dependencies

`0 → 1` first (honest data model + the tool to author it), then `2` (richer content using the tool) in
parallel with `3` (server terrain). `4` builds on `0a`(relief) + `3`(atlas). `5` any time after `1`.
Phases 0–2 + 5 are **client-render/content** (no re-bake); 3–4 are **server/atlas** (re-bake, now
unblocked via the dev service secret).

Devtool-first within each phase: build the preview panel, then author against it — the animation arc's
discipline (`AnimationEditor` before authoring clips).
