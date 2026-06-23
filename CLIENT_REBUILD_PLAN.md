# Client Rebuild Plan — Voxel Pipeline · Architecture · Identity

Status: **planned** (umbrella T-279). This document is the destination; each phase
below is a ticket that deletes the old path in the same commit it lands the new
(refactors **replace**, they don't accrete — CLAUDE.md). Grounded in a full
subsystem audit (8 auditors + 2 design syntheses), not a guess.

---

## 0. Diagnosis — how good is it right now?

The client is **intentionally drifted** (server refactors outran it), but the drift
is concentrated, not pervasive. Honest scores from the audit:

| Subsystem | Quality | Verdict | State |
|---|---|---|---|
| voxel bake core (`voxel_bake`/`voxel_geo`/`displacement`/`bake_pool`/InstancePool) | **4/5** | **keep** | the asset |
| UI layer (`ui/`, signal store, panels) | **4/5** | refactor | live, polished |
| state/networking (`client_world`, decode, interp, bootstrap) | **4/5** | refactor | live |
| render core (`renderer.ts` god-class) | 3/5 | **refactor** | partially broken |
| placement/build (ghost, radial, blueprint) | 3/5 | refactor | partially broken |
| visual identity (lighting, color, post-FX) | 3/5 | refactor | partially broken |
| animation/input | 3/5 | refactor | input live, anim drifted |
| terrain render (`terrain_mesh.ts`) | 3/5 | **rebuild** | live but height-quads |

**Three structural problems explain almost all of it:**

1. **`VoximRenderer` is a 2111-line god-class** (37 methods) owning terrain,
   entity lifecycle, equipment attachment, weapon trails, lighting, 3-pass
   post-FX, gate markers, camera, hit sparks, and debug census. `updateEntity`
   (renderer.ts:614-751) alone interleaves placeholder creation, async
   prefetch→bake→upgrade, and the placeholder→prop-pool handoff behind three
   stale-`.then` re-checks plus a `VELOCITY_EPSILON_SQ` hack that only exists
   because `applySnapshot` writes `velocity={0,0,0}` for every entity.

2. **Voxels are rendered through FOUR divergent representations** the owner wants
   unified: per-node `THREE.Mesh`-per-voxel (skeletal entities), merged-per-material
   `InstancedMesh` (static props — *the good path*), heightmap top+wall quads
   (terrain — **not voxels at all**), and dumb `BoxGeometry` (build ghost). They
   share only `displacement.vertexDisp`. Terrain and models will never read as one
   grid until terrain is re-expressed as voxels through the same bake path.

3. **Five disconnected color authorities, none referencing another**: the
   cohesive Dreamborn UI tokens (`theme.css`), saturated content materials
   (`materials/*.json`), terrain's *stale duplicate* `MAT_COLORS`
   (`terrain_mesh.ts:34-44`, already drifted — grass `0x4a7c3f` vs content
   `#4a9e30`), hardcoded lighting (`makePhaseLights`), and ~23 ad-hoc render hex
   literals (candy gate accents, construction-blue blueprints, cyan noon sky).
   The chrome is governed; the world is not; the two are painted from unrelated
   palettes — *that* is why the look lacks cohesion, not any single bad color.

**Dead code to delete on sight:** `upgradeToVoxelModel`/`collectVoxelModelBakeSpecs`
(entity_mesh.ts:415-490, zero callers), `ik_solver.ts` (zero importers),
`swing_predictor.ts` (retired-system stub), stale T-182/CSM comment scaffolds
(renderer.ts:738,1234-1237).

**Keep-grade, do not rewrite:** `voxel_bake.ts` (pure, THREE-free, parity-tested),
`displacement.ts` (`vertexDisp` — the one cross-cutting cohesion primitive),
`bake_pool`/`bake_worker` (robust off-thread bake, 3 degradation paths),
`InstancePool` (one InstancedMesh per archetype), the input→intent→router spine,
the `Place`-command server-authority model, the bootstrap-blob content path, and
the depth/normal **inked-voxel post-FX** (`edge_pass.ts`) — the game's actual
visual signature.

---

## 1. The through-line

Two unifications turn the mess into identity, and one breakup makes them
maintainable:

- **One voxel pipeline.** `bakeVoxels(atoms, materialId)` becomes the single
  geometry kitchen; models, terrain, placement, and the ghost all become
  *producers of voxel atoms*. The owner's "place a single voxel or a line of
  voxels, with scaling, voxels of different sizes, voxels as terrain edges"
  stops being four systems and becomes one.
- **One color authority.** `palette/world.json` (a strict ~22-swatch ash-hazed
  ramp) snaps every material at load and feeds materials, terrain, voxels,
  lighting, and UI. A designer retunes the whole game — chrome and world — from
  one file, cross-checked at boot.
- **One scene owner.** `VoximRenderer` sheds the entity-mesh lifecycle into an
  `EntityMeshRegistry` (this *is* the planned T-223 scene-graph move) and keeps
  only scene/camera/post-FX/lighting.

---

## 2. The central voxel-build pipeline

### 2.1 The voxel atom — one struct, the input currency of everything

THREE-free, shared server↔client, subsuming `VoxelBakeSpec`,
`ModelDefinition.nodes`, terrain cells, and placed blueprints:

```ts
// packages/content/src/voxel.ts
export interface VoxelAtom {
  cx: number; cy: number; cz: number;   // CENTER in model/world space
  sx: number; sy: number; sz: number;   // per-voxel half-extents → "different sizes"
  materialId: number;                    // the ONLY color carrier → palette
  vid?: number;                          // 0 = baked-static; else an editable voxel id
}
```

Three grounded decisions: **center + half-extents** (the bake math at
`voxel_bake.ts:118` already scales the ±0.5 box about the center); **per-voxel
size on the atom, not a per-entity `scale` arg** (the one mechanical change that
unlocks variable sizes — the unit-box template already scales arbitrarily, and it
ends the InstancePool "archetype explosion" from scale-in-the-key); **`materialId`
is the only color carrier** (no atom stores a hex — kills the terrain-vs-content
fork structurally).

### 2.2 The one kitchen, four producers

`bakeSubModel` is promoted to `bakeVoxels(atoms, materialId): BakedMesh`.
`bakeSubModel` becomes a thin `nodes→atoms` adapter. The `model(x,y,z)→three(x,z,y)`
swap (re-derived inline in 6 places) moves into one `coords.ts` `modelToThree`.
The worker protocol swaps `VoxelBakeSpec[]` for `VoxelAtom[]` and returns merged
`BakedMesh` batches — deleting the fragile parallel-traversal collector/cursor
coupling (`entity_mesh.ts:403-434`).

| Producer | Atoms | Reuses |
|---|---|---|
| Models (entity/prop/forest) | `ModelDefinition.nodes` → atoms | `bakeVoxels` + InstancePool |
| Terrain | per-cell column + edge atoms (§2.4) | `bakeVoxels`, per chunk |
| Placement | one atom per placed cell, size/spacing from brush | `bakeVoxels` (ghost **and** commit) |
| Build ghost | the atoms placement will commit, tinted | `bakeVoxels` (replaces `BoxGeometry`) |

### 2.3 Place-mechanics (the owner's core mechanic)

The build interaction exists in embryo — `modeState` already carries
`kind:"build"` + `tool` + `polyline.lastAnchor`, the IntentRouter claim-chain is
the right pattern, the ghost is a pure `effect()` subscriber. **Keep the spine,
swap the substrate:**

- **Brush descriptor on `modeState`:** add `tool: "single"|"line"`,
  `voxelSize:{x,y,z}`, `spacing` (stride over line cells; 1 = contiguous), sourced
  from the prefab's `placeable` component with live HUD overrides.
- **Line with spacing:** `bresenhamCells` already produces the line; spacing =
  take every `spacing`-th cell. **De-duplicate the two copies** (`build_ghost.ts:94`
  AND `game.ts:1544`, with disagreeing doc comments) into one shared helper so
  preview and commit provably stamp identical cells.
- **Game-feel via the atom:** `vertexDisp` runs through `bakeVoxels` for *every*
  producer, so a placed wall abutting a cliff shares boundary vertices and does
  not crack — that's the felt cohesion. `mag = 0.10·min(size)` scales jitter with
  voxel size, so coarse terrain and fine detail read as one material grammar.
- **Voxel-aware cursor:** today the cursor is a flat ground-plane raycast at the
  player's z (renderer.ts:1010) — the ghost floats/clips on slopes and can't
  stack. One unified `cursor → voxelHit` resolve (top face under cursor at brush
  size, vertical stacking) feeds both the ghost and the facing raycast.

### 2.4 Terrain becomes voxels — and stays server-authoritative

**Placement authority is untouched.** The client sends a `Place` command;
`PlacementSystem` validates against `placeable` and spawns a `Blueprint` entity
that streams back normally. The pipeline extends the *payload* (`voxelSize`,
`spacing`, cell list) and the *validation* (server stamps the same atoms via the
shared `bresenhamCells`) — no new trust surface, the client never invents
committed geometry.

**Terrain, the real change.** A chunk arrives as four loosely-coupled components
(`heightmap`/`materialGrid`/`openMask`/`kindGrid`) stitched in
`client_world.ts:179-215` — a *heightfield*, not voxels. **Opinionated call:
derive voxels client-side, do NOT ship a fat voxel-volume on the wire (yet).**
At decode time each cell `(cx,cy,h,m)` becomes a column of atoms — a top atom at
the surface plus **edge atoms only where a neighbor is lower** (the exact wall
condition `terrain_mesh.ts:142-174` already computes, emitting *atoms* instead of
*quads*), greedy-merged per material per chunk. This makes "voxels are terrain
edges" *literally true* while keeping the wire compact and the heightmap as the
collision/authoring source (physics untouched). A true sparse-voxel chunk wire
format is a deliberate **later** change (Phase 5), built only when volume editing
(overhangs/caves) demands it — not speculatively.

---

## 3. Visual identity — the strict palette

**Thesis: a green-grey world the ash fell on.** Everything organic is muted toward
grey-green and bone; everything man-made is rusted or rotting. Color is *rationed* —
the world is a desaturated earth field, and the only saturated chroma is *meaning*:
ember (fire/heat/agency), rot (corruption), and the grim vital channels. This
extends the existing Dreamborn UI thesis (`earth ↔ rot · flame ↔ aether`) outward
into the 3D world so chrome and world finally share one identity. Because edges
derive from depth/normal (`edge_pass.ts`), **not** color, we can desaturate hard
without losing the inked-voxel legibility — tightening the palette *strengthens*
the signature.

**The ramp — `packages/content/data/palette/world.json`** (~22 swatches; signal
hues taken verbatim from the UI spec so a torch, a UI accent, and a hit-spark are
the same value):

- **Earth:** peat `#161611`, soil `#2b2517`, loam `#3d3320`, clay `#574326`,
  sand `#8f7a4a`, moss-green `#3a4326`, **sage `#586b3c`** (the keystone — grass
  `#4a9e30` → ashen sage), bracken `#6b6a3e`.
- **Stone & metal:** slate `#2e2f2c`, ash-grey `#4a4b46` (stone `#808080` warmed),
  flint `#65665d`, chalk `#8d8d7e`, rust `#5e3a22`, iron-grey `#54565c`, steel
  `#6f7176` (both pulled off blue).
- **Wood & organic:** bark `#3a2c1a`, timber `#6b4d2c`, hide `#6a4a30`, bone
  `#ddd6b9` (verbatim), bone-dim `#a39d80` (verbatim).
- **Water & sky:** deep-water `#1c3038`, shallow `#3f5a5c` (cyan → slate-teal),
  aether `#c8dce4` (verbatim — the only bright blue-white, kept rare).
- **Signal (never terrain):** ember `#d97826`, ember-hi `#ee9748`, rot `#5b3d78`,
  blood `#6c1f1c`, bile `#4d4f1f`, frost `#2c4a5b` (all verbatim from UI).

**Enforcement (content-driven, snap-on-load, fail-fast — like every other
registry):** `palette/world.json` ships in the bootstrap blob; the content loader
snaps every `MaterialDef.color` to the nearest ramp swatch in CIELAB at load
(cohesion is *structural*, not disciplinary); a boot cross-check asserts every
snapped color is on-ramp; `render/palette.ts` exposes named tokens
(`palette.ember`, `palette.deepWater`) and **no raw hex survives in `render/`**.

**Lighting:** lift `makePhaseLights` into the palette's `phases` block; retune the
sky off cyan `#7aa4cc` onto an **ash-hazed bone-grey** by day, ember at
dawn/dusk, rot-tinged `#0e0a18` at midnight. Fog == sky color (already true) at
`fogFar 160-220` tints every distant surface toward the sky — free cross-depth
cohesion. The post-FX spine is untouched.

---

## 4. Phased roadmap

Each phase compiles, ships, and stands alone; old path deleted with the new.
Ordered so the cheapest identity wins land first.

**Phase 0 — Cleanup + palette authority (T-280).** *Highest identity-per-effort.*
Delete the dead code (§0). Create `palette/world.json` + the CIELAB load-snap +
boot cross-check + `render/palette.ts`. **Kill terrain `MAT_COLORS`** (read content
materials — brings the largest on-screen surface onto the palette). Collapse the
four `MaterialDef→Material` builders into one `buildVoxelMaterial`. Lift lighting
into palette data; retune sky. Migrate the ~23 render literals to `palette.*`.
Collapse the UI's two token generations to one source; delete the alias shim. No
new capability — pure cohesion + cleanup.

**Phase 1 — The voxel atom + one kitchen (T-281).** Introduce `VoxelAtom` +
`coords.ts modelToThree`. Add per-voxel size to the bake spec; `bakeSubModel →
bakeVoxels(atoms, materialId)`; route the worker protocol + InstancePool through
atoms. Collapse the entity per-node path onto the merged path; delete
`buildVoxelMesh` + the cursor/collector parallel traversal. Net: models + props
share one path, draw calls collapse, "different sizes" is mechanically supported.

**Phase 2 — Renderer breakup = scene-graph (T-282, subsumes T-223).** Extract
`EntityMeshRegistry` (the `entityMeshes` map + the async prefetch→bake→upgrade
state machine + the placeholder→prop handoff). Renderer keeps scene/camera/
post-FX/lighting + a `render()` over the registry. Fold the three near-identical
async-bake-with-stale-guard blocks (entity, hand slot, armor slot) into one
`loadAndBakeModel` helper; fix the `velocity={0,0,0}`/`VELOCITY_EPSILON_SQ` hack at
its source (`applySnapshot`). Make `scene` private with a narrow `addLayer` API —
one scene-graph owner.

**Phase 3 — Terrain becomes voxels (T-283).** Client re-expresses
heightmap+materialGrid as column/edge atoms through `bakeVoxels` (greedy-merged
per material per chunk). Cliff faces become baked voxel boxes sharing `vertexDisp`
+ palette with props. Heightmap stays the collision/authoring source. Terrain and
models are now one representation in *both shape and look*.

**Phase 4 — The build spine on the real pipeline (T-284).** Brush descriptor on
`modeState` + `ui_store` + a build HUD (size/spacing). Content-drive the
RadialMenu (kill hardcoded `STRUCTURE_OPTIONS`). De-duplicate `bresenhamCells`.
Swap the `BoxGeometry` ghost for `bakeVoxels` at brush size, palette-tinted.
Voxel-face-aware cursor with vertical stacking. `Place` grows `voxelSize`/`spacing`/
cell-list; `PlacementSystem` validates with the shared helper. Fold in the
networking cleanup (CODEC_BY_WIREID registry, kill the hand-rolled DataView
decodes). Server authority unchanged. **The deferred networked-`Container` chest
UI (T-077/T-078) lands here** — it's a UI feature gated on this rebuilt
client + the networked-Container wire add.

**Phase 5 — (deferred) true sparse-voxel chunk wire format.** Replace the
four-grid heightfield wire with one voxel-chunk component when overhangs/caves/
free-placed-volume editing arrives. Not built speculatively.

---

## 5. Reuse vs replace ledger

**Reuse verbatim:** `voxel_bake.ts` + parity test, `displacement.ts`,
`bake_pool`/`bake_worker`, `InstancePool`, input/intent/router spine, one
`bresenhamCells`, the `Place`-command authority model, the bootstrap-blob content
path, the post-FX/edge-ink pipeline.

**Replace/delete:** per-node `buildVoxelMesh`, `BoxGeometry` ghost + `GEO_UNIT`,
`terrain_mesh` `MAT_COLORS` + quad emission (→ atom emission), the 4 duplicated
material builders, the bake collector/cursor coupling, dead static-voxel + IK +
swing-predictor code, hardcoded `STRUCTURE_OPTIONS`, the dual build-intent
vocabulary, the flat-plane cursor pick, the UI alias-shim.

**The spine in one line:** `VoxelAtom` (center + per-voxel size + materialId) →
`bakeVoxels` (one kitchen, `vertexDisp` cohesion) → `buildVoxelMaterial` (one
palette) → InstancePool, fed by four producers (models, terrain, placement,
ghost), placement server-authoritative exactly as today, terrain voxelized
client-side from a still-compact heightmap wire.
