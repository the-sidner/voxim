# Terrain-Path Comb — T-315

Pull the whole terrain / level-generator path — atlas → world → tile-server → wire → client render —
back in line with the systems architecture. Not a redesign: the shape is right (atlas is the single
overworld authority, fields ship as data, the client derives presentation). What drifted is the
*hygiene* around that shape: duplicated constants, orphaned config, dead generator paths, tuning
stranded in code, and three naming vocabularies for the same concepts.

**Method.** Multi-agent audit (2026-07-02): 7 segment readers over the full path, 6 drift lenses
(duplication / tuning / dead / layering / doctrine / naming), 127 raw findings → 73 after dedup →
adversarial verification in severity order. **All 7 high + 21 medium findings verified: 27 of 28
confirmed** (1 rejected as documented-deliberate: `SUN_DIR` duplication, which T-311 P5's server
sun-arc replaces anyway). 45 medium/low findings were not individually verified (cost cut-off) and
are marked *(plausible)* below — at a 96 % confirm rate most will be real; each gets a quick
re-check as its commit lands.

**Doctrine anchors:** ContentStore is the only data path · registry-dispatch over kind-switches ·
one value one owner · refactors replace, they don't accrete · wire carries data, client derives
presentation · content ids cross-checked at boot, fail-fast.

---

## What we deliberately do NOT touch (owned by T-311 phases)

- **Water renderer rebuild** — the client re-deriving water height from KindGrid + mirrored
  constants ([water_renderer.ts:36](packages/client/src/render/water_renderer.ts#L36)) is confirmed
  drift, but P5 reworks that file for `WaterStyleDef` anyway. Fix = rebuild around
  `WaterGrid.surfaceLevel` **inside P5**, deleting the KindGrid dependency and the
  pending/tryBuild wait machinery with it. Noted here so it isn't lost; not a comb commit.
- **`SUN_DIR` duplication** (environment_lighting ↔ water shader) — P5's server-authoritative
  sun-arc replaces both. Rejected as drift by the audit.
- **`CLIFF_MIN`/`STONE_H`/`STACK_MAX`/`EXPOSE_MIN`** — P6 (server-authoritative terraced cliffs)
  deletes the whole client cliff voxeliser trigger. We skip plan-0b's interim promotion to
  terrain_config.json; the stacked-stone *language* constants that survive P6 (they live on the
  atoms) are handled in D1 instead.
- **Overhang, dissolves, variantIndex** — I3 decisions stand as written.

---

## Phase A · Substrate correctness (bugs first — the field substrate must be trustworthy)

- **A1 — ChunkLifecycleSystem restores only 4 of 7 grids.** ✅confirmed high.
  [chunk_lifecycle.ts:42](packages/tile-server/src/systems/chunk_lifecycle.ts#L42) `CachedChunk`
  snapshots Heightmap/MaterialGrid/OpenMask/KindGrid; any unload/reload cycle silently destroys
  VegFieldGrid/SurfaceStateGrid/WaterGrid → scatter/moss/wetness go neutral. Sister bug of the
  fixed T-312b (SaveManager path). Widen CachedChunk to all seven grids; planes `.slice()`,
  the three field grids required in the null-guard exactly like the existing four.
- **A2 — Field sampler fed asymmetric inputs.** ✅confirmed.
  [renderer.ts:567](packages/client/src/render/renderer.ts#L567) evaluates terrain FieldExprs with
  `water=null` while scatter passes the real WaterGrid — same expr, different answer per consumer.
  Thread the chunk's `state.waterGrid` through `updateTerrain` (a `terrainWater` map beside
  terrainSurf/terrainVeg).
- **A3 — `ScatterRenderer.needsFields` ignores `morphField`.** ✅spot-verified.
  [scatter_renderer.ts:91](packages/client/src/render/scatter_renderer.ts#L91) only checks
  `densityField` — a morph-only def would never defer for fields and never morph. Check both.
- **A4 — Boot-time terrain mutations never touch the derived field planes.** *(plausible —
  investigate first.)* POI room stamps + stair ramps edit height/material grids
  ([poi_placer.ts:79](packages/tile-server/src/poi_placer.ts#L79)) but the atlas-derived fields
  (wear, traffic…) reflect the pre-mutation tile. Either update the planes for stamped cells or
  document the divergence as accepted at the mutation sites.
- **A5 — Atlas inspector divergence detection is blind to the fields stage.** *(plausible.)*
  [instrumented_runner.ts:278](packages/atlas/src/tilemap/instrumented_runner.ts#L278)
  `hashStageOutput` has no case for the stage T-311 added — add it.
- **A6 — Boot cross-check gaps (fail-fast doctrine).** ✅confirmed (poi_placer) + 2 plausible
  siblings. `MOB_NPC_POOL` prefab ids + the two stair prefab ids validate at boot and THROW
  (delete the silent `continue` at [poi_placer.ts:141](packages/tile-server/src/poi_placer.ts#L141)
  and stair_spawner's warn-and-return); `mossBlend.material`
  ([loader.ts:112](packages/content/src/loader.ts#L112)) and `game_config terrain.materialDrops`
  ([terrain_hit_handler.ts:90](packages/tile-server/src/handlers/terrain_hit_handler.ts#L90))
  get the same cross-check every other content reference already has.

## Phase B · Delete the dead (pure removals, shrinks every later diff)

- **B1 — The gen-terrain path is dead end-to-end.** ✅confirmed. Delete `scripts/gen_terrain.ts`,
  `packages/world/src/terrain_cache.ts` (+ mod.ts re-export), the `gen-terrain` task in deno.json,
  the checked-in `terrain_tile_0.bin`, the `.gitignore` entry, and the CLAUDE.md line. Atlas
  superseded all of it.
- **B2 — `protocol/src/world_map.ts` is legacy with zero payload consumers.** ✅confirmed.
  Delete `WorldMapPayload`/`WorldMapCell`/`encodeWorldMap`/`decodeWorldMap`/`WORLD_MAP_VERSION`;
  **relocate the live `GatePosition`** to tile-server (its only consumer).
- **B3 — `canopy_fade` voxelMode:false branch serves the smooth mesh T-283 deleted.** ✅confirmed.
  Delete the branch + the option; every registered material comes out of the voxel bake and has
  `voxelCenter`.
- **B4 — `TileInit.boundaries/features` are permanently-empty placeholders.** ✅confirmed. Delete
  from TileInit + TileInitWire + all six copy sites; jsonb rows decode by name, no migration.
- **B5 — `terrain_config.json` is an orphaned decoy that drifted from the real
  `DEFAULT_TERRAIN_CONFIG`.** ✅confirmed — and CLAUDE.md documents the dead copy as authoritative.
  Delete the JSON, rewrite the terrain_config.ts header (authority = the TS default, scope = the
  cave-instance/local path; atlas owns overworld), fix CLAUDE.md. Take the dead knobs
  (`hydraulicStrength`, `ruinChance`, `ruinMinAltitude`) and dead `voronoi2D` in the same pass.
- **B6 — Zone-driven ProceduralSpawner scatter + the 11 `data/zones` spawn profiles are dead on
  the production boot path.** *(plausible — verify, then delete or re-wire deliberately; a silent
  half-dead content category is worse than either.)*
- **B7 — Dead GenParams knobs + `NAMED_AREA_MIN` legacy shim.** *(plausible.)* Params documenting
  consumers that don't exist ([genparams.ts:220](packages/atlas/src/genparams.ts#L220)); the
  zone_namer back-compat export + the test pinning the shim — direct break per doctrine. Check the
  unreachable `morass` role ([zone_graph.ts:690](packages/atlas/src/tilemap/pipeline/zone_graph.ts#L690))
  here: reachable-by-fix or delete-the-role is a design call, surface it.
- **B8 — Small fry:** `drawWood` leftovers, stale `StairEdge.rampDepth/rampHalfWidth` — the latter
  goes the OTHER way per the audit's refined fix: make the wire fields authoritative (pass them in
  `applyStairUnlock` at [atlas_terrain.ts:286](packages/tile-server/src/atlas_terrain.ts#L286),
  delete the `??` defaults) rather than delete them — consistent with LevelDef-as-IR.

## Phase C · One value, one owner (constants & vocabulary)

- **C1 — `WALL_HEIGHT`: per-world GenParam at generation, hardcoded 2.0 at every consumption
  site.** ✅confirmed — non-default worlds silently mis-upsample and mis-ramp. Add `wallHeight` to
  `UpsampleOptions` (upsample.ts:128/:166); in `loadTerrainFromAtlas` derive once via
  `mergeGenParams(world.params)` and pass to upsample + `applyStairUnlock`
  ([atlas_terrain.ts:289](packages/tile-server/src/atlas_terrain.ts#L289)).
- **C2 — Chunk dimension re-declared in 12 files across 4 packages**, including a live
  `CHUNK_CELLS` identifier collision (32 vs 1024). ✅confirmed. Import `CHUNK_SIZE` from
  `@voxim/world` everywhere (client already imports the package), delete the local consts and the
  two "must match" comments.
- **C3 — TILE_SIZE under two names in 8 places, GATE_INSET in 3.** ✅confirmed. Tile-server sites
  import from `@voxim/world`; atlas keeps its own (package stays world-free per its charter);
  GATE_INSET/RADIUS/MIRROR_INSET consolidate in gate.ts.
- **C4 — `BOUNDARY_KIND_*` mirrored as bare literals outside atlas although KindGrid ships them
  on the wire.** ✅confirmed — a parallel ID mapping, the thing wireId doctrine forbids. Move the
  vocabulary to `@voxim/protocol` as a const object beside ComponentType; all mirror sites import.
- **C5 — Shared random/noise home.** ✅confirmed ×2 (nine-copy FNV-1a/mulberry32/mix32 family with
  comment-enforced parity; atlas's verbatim-vendored noise copy beside world's). PRNG/hash
  primitives → `@voxim/engine` `src/rand.ts` (all consumers already depend on engine);
  fbm/valueNoise/domainWarp family → `@voxim/levelgen` per its T-203 charter ("consumed by both
  atlas and tile-server… agree byte-for-byte"); delete `atlas/src/common/noise.ts`.
  `levelgen/seed.ts` keeps `splitSeed` as policy over the imported primitives. **Byte-parity is
  load-bearing** (client scatter must match server placement) — the shared module is the fix, the
  test is `deno test` parity cases moved with it.
- **C6 — Micro-duplication batch, one commit:** base64 helpers (atlas ×2), `sampleWidth`
  (network/portal_placement), `clamp01` (content ×2), `ROOM_ID_NONE` re-declared beside its export.
- **C7 — Hand-rolled length prefixes in server.ts beside `encodeFrame`.** ✅confirmed doctrine
  violation ("never roll a custom length-prefix"). All THREE sites (tick send ~1221, gate crossing
  ~1625, initial snapshot ~1820) → `encodeFrame`; protocol's `encodeJson` delegates too.
- **C8 — The 10-plane field bundle shape defined three times** (atlas `FieldPlanes`, world
  `FieldsBufferInput`, `TileInitWire.fieldsB64`). *(plausible.)* One exported shape where the
  dependency graph allows; at minimum kill the structural-assignability-by-luck comment.

## Phase D · Tuning → content (designer knobs reachable)

- **D1 — The stacked-voxel language's stranded knobs (client).** ✅confirmed + spot-verified.
  `TERRAIN_DISP_MAG` is eye-tuned in code while its reserved content knob `relief.dispMag`
  ([types.ts:65](packages/content/src/types.ts#L65)) sits unread — wire it. Hoist the duplicated
  disturbance/tintScale block above the cliff/slab branch split in
  [terrain_voxels.ts](packages/client/src/render/terrain_voxels.ts) (audit-refined fix); name the
  magic response constants (`MOTTLE_FLOOR = 0.25`, course-jitter `×0.5`, chink `×0.3`, overlap
  `+0.05`) and promote the genuinely per-material ones onto `render.relief`. The language survives
  P6 on the atoms — this is not throwaway.
- **D2 — Grade completeness.** *(plausible, aligned with landed G7.)* Bloom threshold/strength,
  height-shade band, emissive HDR scale → `GradeDef`
  ([renderer.ts:462](packages/client/src/render/renderer.ts#L462)); EdgePass constructor literals
  duplicate grades/default.json — construct from the def.
- **D3 — Client look-tuning batch:** canopy wind/fade-cylinder consts, `DAMAGE_FULL_INTENSITY` →
  DecalDef, TextureStyle per-style coefficients → `render.textureStyle` params. *(all plausible,
  batch-verify while moving.)*
- **D4 — Atlas param stragglers.** ✅confirmed (materials.ts, zone_graph) + plausible siblings
  (fields.ts coefficients — the very knobs the inspector sliders claim to tune; zone_namer
  thresholds; corridor literals; terrain ±2u bias). Into GenParams/FieldParams with current values
  as defaults; sub-seed constants stay code (documented exemption).
- **D5 — `protocol/src/fog.ts` carries LOS gameplay tuning.** *(plausible.)* → game_config.

## Phase E · Single-owner structures (the meaty ones)

- **E1 — ContentCache: the self-described legacy parallel path.** ✅confirmed high — already caused
  the terrain-was-grey bug. Make it a thin synchronous read-through over the bootstrap
  ContentService (its own header's stated end-state): all get*/get*Sync resolve from the blob; keep
  only the derived-index memos, repointed. One replace-commit.
- **E2 — Client chunk-state substrate.** ✅confirmed + 2 plausible, one coherent rework:
  ClientWorld becomes the single grid owner (decoded structs, not bare planes) and the renderer's
  parallel `terrainHmaps/Mats/Surf/Veg` maps die; chunk coords stop riding only on Heightmap
  (six sibling grids need a back-reference today, making delivery order load-bearing); ONE
  "chunk ready" hook with explicit grid guarantees replaces the per-consumer retry machinery
  around `onChunkKinds`.
- **E3 — Server chunk-join.** ✅confirmed. `physics/terrain_lookup.ts` becomes the single owner:
  add `buildChunkIndex(world)` for the mutation paths that need entityIds (terrain_hit_handler,
  blueprint applyToTerrain, placement), converting both linear scans + placement's private map.
- **E4 — Atlas assembly + biome tags.** ✅confirmed ×2. Extract `assembleTileInit(FieldsState)`
  so the inspector stops hand-rebuilding the struct the bake assembles (drift = silent inspector
  lies); one ordered `BIOME_TAG_RULES` table replaces the hand-copied threshold ladders in
  zone_namer/poi_network.

## Phase F · Naming & honesty sweep (last — no churn under the other phases)

- **F1 — One axis, one name, one polarity.** The same field is `disturbanceField` (content),
  "wildness axis" and "civilization axis" (comments/prose), with both polarities in circulation.
  Canonical: **disturbance, 0 = civilized/worked, 1 = wild** — matches the shipped content field.
  Kill the synonyms everywhere, including this plan's own sources.
- **F2 — `cx/cy` means chunk coords, cell indices, AND world-space voxel centers** depending on
  file. Rename the colliding locals (chunk→`chunkX/Y`, cell→`cellX/Y`); `VoxelAtom.cx` (center)
  keeps its documented meaning.
- **F3 — pixel vs cell vs voxel** in atlas: standardize on **cell** for tilemap grid elements.
- **F4 — Stale-comment batch** *(each ≤5 min, one commit)*: water→mud comment claims "no water
  material yet" while `data/materials/water.json` exists (check whether the mapping itself should
  now change); aoi.ts "chunks never despawn" header (stale since T-064); "only textureStyle has a
  consumer today" frozen-schema comments; two surviving `surfaceWarpField` references; atlas
  stage-ordinal comments vs ORDERED_STAGES; voxel_bake.test constant-equality claim; genparams
  phantom-wiring docs; heir_spawn's "spawner samples terrain height" vs the literal `z=4.0`;
  `offZ` naming in terrain_voxels vs water_renderer; rivers.ts anonymous `0xfeed` seed;
  `ScatterDef.kind` required-but-ignored for material-matched defs; TerrainDigSystem living in
  `handlers/` under a `_hit_handler` filename.
- **F5 — coords.ts honesty.** ✅confirmed (refined): scope its "single axis-swap home" claim to
  the model→three entity-local conversion and name the world→three positional idiom + its inline
  sites; folding those sites into helpers is optional follow-up, the header lie goes now.

---

## Order & mechanics

A → B → C → D → E → F. Each bullet = one commit (package-prefixed, per git workflow); every phase
ends `deno check` green; A/D/E get a testplay screenshot pass (field-driven visuals must survive
byte-parity moves). *(plausible)* items get a 2-minute re-verify before their commit; a refuted one
is dropped with a line in the commit message of its phase's last commit.

Audit artifacts (segment maps, full 73-finding list with evidence, verdicts) live in the session
scratchpad `audit.json`; the 27 confirmed findings are all reflected above.
