# Voxim2 — Engineering Tickets

Each ticket is a self-contained unit of engineering work. Tickets are grouped by domain.
**This file holds only OPEN work.** Closed tickets — done, obsolete, superseded, deferred —
are archived in [CHANGELOG.md](CHANGELOG.md), which doubles as the project changelog.

**Format:**
```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done|obsolete   [Commit: <hash>]

What needs to be built and what "done" looks like.
```

Effort: **S** < half a day · **M** half–two days · **L** multi-day or architectural

---

## Combat

## Stealth

## Lore & Skills

## Crafting & Economy

### T-036 · Blueprint as saveable/storable Lore item
Effort: M   Status: todo

A blueprint (saved after designing) becomes a `blueprint_tome` — a Lore item storable in the
family library, tradeable, and loadable by NPCs via a `build(blueprint_element)` job.
Done when: a designed blueprint can be saved as a tome item; another character or NPC can load
and execute it.

### T-037 · NPC builder job assignment to blueprint element
Effort: S   Status: todo

Add `build_element` job type to the job board. NPCs with hammer + required materials in inventory
can execute build jobs, incrementally constructing blueprint elements.
Done when: assigning a build job to an NPC causes it to navigate to the blueprint and construct.

---

## NPC & Society

### T-042 · NPC specialisation matching to job requirements
Effort: M   Status: needs-design   (original Lore-on-NPC premise is dead — T-260b removed NPC LoreLoadout)

Original premise: jobs carry a `skillRequirement` Lore fragment; an NPC pulling a job checks its
own `learnedFragmentIds`. That mechanism no longer exists — NPCs carry **no LoreLoadout** since
T-260b (`spawner.ts:219`: "No LoreLoadout for NPCs"), so there is nothing to match a fragment
requirement against. There is no `skillRequirement` field on JobBoard jobs today either.

The goal still stands (a forging job should only be taken by an NPC that can smith), but the
matching key must be redesigned around what NPCs actually carry: their `NpcTemplate`
(archetype / `npcType`, and any future per-archetype skill tags). Concrete shape to decide:
add an optional `requiredArchetype` (or a small `skills: string[]` tag set on the template) to
JobBoard pending jobs; when an `AssignedJobBoard` NPC pulls a job, skip ones whose requirement
its template doesn't satisfy. Needs the NPC job-pull-from-board path confirmed/wired first
(JobBoard + AssignedJobBoard components exist; the admin endpoint appends jobs, but verify an
NPC actually dequeues from its assigned board).

Done when: a forging job tagged for smiths is only taken by NPCs whose archetype/skill tags
satisfy it; non-matching NPCs skip to a lower-priority job.

## World & Macro Simulation

### T-049 · Macro simulation — trade agreement + resource exchange
Effort: L   Status: todo

When two cities have an active trade agreement, a periodic job dispatches caravans (T-048)
between them. On arrival, goods are transferred between city inventories. Agreement can lapse
if a caravan is raided N times.
Done when: two cities with an agreement exchange goods via caravans; raiding disrupts the flow.

### T-050 · Connect LLM to city agent interface (T-046)
Effort: M   Status: todo

Wire the real LLM API (Anthropic Claude) to the city agent interface defined in T-046.
Context packet assembly, call trigger from world event bus, response parsing, tool execution.
Rate-limit: one call per city per event; no tick-driven calls.
Done when: a live city reacts to a significant event with LLM-generated tool calls.

## Gateway & Multi-tile

## World Generation

### T-058 · Road network generation
Effort: M   Status: todo

Connect city seed positions with roads following terrain of least resistance. Road tiles get a
flatten pass during tile generation. Gate positions on road tiles align with road path.
Done when: roads connect city seeds on the world map; road tiles carry a road flag.

### T-059 · NPC city seeding on world map
Effort: M   Status: todo

Select city locations from world map (flat terrain, near water, resource diversity). Create a
`CityState` (T-044) for each. Seed each with a founding NPC and a starting workbench.
Done when: world generation produces N cities at valid locations with initial state files.

### T-212 · POI runtime + wilderness-stair unlock
Effort: L   Status: in-progress   (v1 PoiSystem done -- 03525ae; v2 trinket->stair-unlock + boss/wave/puzzle open)

**v1 landed**: PoiTrigger component + PoiSystem with two dispatch paths:

- `encounter` — spawn NPCs from a (stub) spawn-table mapping at the
  POI's zone centroid via `spawnPrefab`. Wolf pack, bandit pack,
  drowner swarm, etc. map to existing NPC templates.
- `exploration` — publish `LoreInternalised` to the triggering player
  with the POI def's `loreId`.
- `bossfight` / `wave` / `action` / `puzzle` — stubbed (log only).
  Full implementations are T-212 v2.

PoiSystem runs each tick; for each `PoiTrigger`, checks if any
player session is within `triggerRadius` and fires the activity on
first crossing. `fired` flips to true and stays — non-respawning
behaviour for v1.

**Remaining (T-212 v2)**:
- `bossfight` — boss prefab spawn at centroid + arena rules
  (lockEntry sets a temporary path-zone collision when engaged; HP=0
  drops it). Adds-table spawns at phase triggers.
- `wave` — state-machine component cycling through `activity.waves`
  in order with `interWaveSeconds` delay. Cleared on full clear.
- `action` — interactable prefab spawn at centroid (chalice pedestal,
  signal brazier, etc.) — needs the entity-hover/click system from
  T-100 to dispatch usage.
- `puzzle` — reserves `data/puzzles/` content category; each puzzle
  template defines its own internal rules (lever sequences,
  reflection paths, valve sequences). Solving the puzzle fires the
  reward path.
- Stair runtime UNLOCK on trinket consumption — currently locked
  stairs stay locked forever. Needs the trinket-inventory checkpoint
  (when a player picks up trinket X, scan stairs whose `lockedBy === X`
  and call `applyStairUnlock` + broadcast heightmap-Δ to AoI clients).
  This is the bridge from "found stairs work" (T-213 v1) to "earn-your-
  way-up-the-plateau".

Make POIs actually do something at runtime + make stairs actually
gate movement. Tile-server reads `TileNarrative` on tile load, spawns
per-POI runtime adapters:

  encounter   → ProximityTrigger spawns SpawnTable on player entry
  bossfight   → boss prefab + arenaRules (lockEntry collides path
                zone until HP=0)
  wave        → state-machine component, sequential spawns
  action      → interactable prefab at the POI's zone centroid
  exploration → one-shot lore-unlock trigger
  puzzle      → reserves a new `packages/content/data/puzzles/`
                content category (stub for v1; full puzzle
                templates ship later)

Stair runtime: stair entity at each `StairInstance.anchorPixel` with
a `Lock` component referencing `lockedBy`. Player approaching an
unlocked stair gets a "Climb" prompt; using it teleports the player
2u up onto the wilderness plateau (collision-safe, no heightmap
mutation in v1 — the elevation step stays as a visual hint).

When the player completes a POI that drops a trinket the player's
inventory gains the trinket. When any stair's `lockedBy` trinket is
in inventory, the stair flips to unlocked + broadcasts a
`StairUnlocked` event to all AoI clients.

Tests:
- dump/reload preserves stair-unlock state byte-identical
- entering an unlocked stair places the player at the wilderness
  centroid with proper Y elevation
- locked stair refuses the climb prompt
- POI completion → trinket inventory → stair unlock → climb → POI
  completion (the full loop, in one integration test)

Done when: a baked tile with the matcher's narrative is fully
playable end-to-end: spawn → walk → fight encounter → get trinket →
climb stair → fight boss → terminal trinket.

### T-213 · Physical stair object — heightmap ramp + step-up walkability
Effort: M   Status: in-progress   (v1+v2 stair carve/props done -- 867766f; T-213b runtime unlock open)

**v1 landed**: `applyStairUnlock` helper + "found" stairs (lockedBy === null)
apply at tile boot. Wilderness plateaus reachable from boot via lerped ramps.

**v2 landed**: `placeStairs` spawns a visible voxel-staircase prop at every
narrative stair anchor. Stone variant for "found" stairs (the heightmap ramp
underneath makes them walkable); stone + iron-capped variant for "locked"
stairs (no ramp, wilderness wall still blocks — the iron cap reads as the
unlit gating cue). `Stair` server-only component carries `{stairId, toZoneId,
fromZoneId, trinketId, anchorXY, unlocked}` so the future unlock pipeline
has everything it needs to flip state at runtime.

**Remaining (T-213b — next ticket-or-extension)**:
- Runtime unlock: when a player consumes a trinket that matches a locked
  stair's `trinketId`, flip openMask + apply ramp + swap the entity's
  ModelRef from `model_stair_locked` to `model_stair` + broadcast a
  Heightmap-Δ + StairUnlocked event to AoI clients.
- Client heightmap-delta application — applying a ramp at runtime requires
  the client to re-mesh those chunks. Pattern exists for building-system
  edits; reuse it.
- Per-biome stair models (root stairs for grove, crag stones, …) — currently
  one stone shape for every biome.

T-210's stairs are currently only a *narrative* artifact — they
declare gating in `TileNarrative.stairs[]` but the engine still
blocks players at the wilderness boundary because the heightmap step
(wallHeight = 2u) exceeds `stepHeight`, and openMask still reads 0
on closed-kind pixels. T-212 originally proposed solving this with
a teleport interactable; this ticket says **no — make the stair a
real ramp the player walks up**.

Mechanism per StairInstance:

  1. RAMP CARVING. For each unlocked stair, modify the heightmap at
     the stair anchor and a small neighbourhood: lerp from path-floor
     height (≈0) at the path-side pixel up to wilderness-plateau
     height (= wallHeight) over a 3-5 pixel run. Width matches the
     stair's "tread" (3-4 pixels, configurable).
  2. OPENMASK FLIP. The ramp pixels become walkable: openMask = 1
     across the lerped run. Wilderness pixels reachable from the ramp
     also become walkable — but ONLY those connected to the unlocked
     stair (downstream flood-fill from the anchor, bounded by
     wilderness-zone id).
  3. PHYSICS CONTINUITY. Existing tile-server collision uses
     openMask + heightmap + stepHeight. Once openMask flips and the
     heightmap is lerped, the player naturally walks up — no new
     traversal mechanic.

Two states per stair:

  LOCKED — heightmap stays at full wall-height across stair pixels;
           openMask = 0; stair anchor renders as a visible prop
           (vertical "step" plate) so the player can see WHERE to
           climb once it unlocks.
  UNLOCKED — heightmap lerped to ramp; openMask = 1; the prop animates
           a brief "open" pose. Wilderness pixels behind the stair are
           now reachable; the player walks up naturally.

Wire deltas needed:

  - Heightmap delta over the ramp pixel range (small — typically <20
    pixels). Reuse the per-tile heightmap-Δ pattern that future
    building / digging will need.
  - openMask delta over the same range + the flooded-reachable
    wilderness pixels.
  - StairUnlocked event with stair id (so the client can play the
    open animation).

Visual:

  - Stair prefab at the anchor — small stone steps or vine-overgrown
    ramp depending on the wilderness zone's dominant kind (crag →
    stone steps, grove → root-stairs, hollow → grassy ramp). One
    prefab per wilderness role, picked at narrative-bake time.
  - Locked stairs are visible from the start so the player can plan
    ("I need to find a key for THAT stair").

Tests:

  - Snapshot: locked-stair heightmap == pre-stair heightmap byte-
    identical (so save/reload before any unlock reproduces).
  - Unlock event applies the heightmap delta deterministically — same
    stair on same tile always produces same delta.
  - Server-side collision integration test: player attempts to walk
    onto a wilderness pixel near a locked stair → blocked. Same
    pixel after unlock → walkable.
  - The flooded-walkable region is bounded by the wilderness-zone
    id; a wilderness pixel in a DIFFERENT wilderness zone is NOT
    reachable through this stair.

Out of scope:
- The stair PROP CONTENT (the actual 3D model variants per zone
  role). For v1, ship one generic "step plate" model and pick it for
  every stair; per-role visuals are a follow-up.
- T-212's POI runtime (encounters firing, bosses spawning) — that's
  the gameplay layer; this ticket is purely the physics + visual
  realisation of stairs.

### T-215..T-224 · Scene graph as a central engine system
Effort: XL (multi-ticket arc)   Status: planned

See [`SCENE_GRAPH_PLAN.md`](SCENE_GRAPH_PLAN.md) at the repo root for the
full design + migration plan. Summary:

`@voxim/engine` grows a scene-graph primitive (parent/child links via a
networked `Parent` component) that sits co-equal with the flat ECS.
Nodes are entities; prefabs produce subtrees of entities; the same
engine APIs work in atlas (bake), tile-server (runtime), coordinator
(world graph), and client (rendering). What differs between services
is *which systems they install*, not which scene representation they
use.

Migration phases (each its own ticket):

  - T-215 — DONE (inert). engine/scene.ts: Parent (networked,
    engine-owned inline codec, wire id 49 reserved in protocol) +
    Transform/composeTransform; World gains setParent/getParent/
    getChildren/descendants/destroySubtree/worldTransform/localTransform
    (O(1) child index, changeset-deferred subtree teardown, cycle-safe
    transform compose). Registered in NETWORKED_DEFS. 8 engine tests +
    regression green; bake byte-identical. Nothing consumes it yet.
  - T-216 — DONE. engine/src/prefab.ts owns the generic spawn walk;
    concretes injected via PrefabSpawnContext (getPrefab/
    resolveComponent/compoundInstaller/preInstall). tile-server
    spawnPrefab keeps its signature as a thin wrapper — call sites
    unchanged, behaviour identical. 70 tests green; bake byte-identical.
  - T-217 — DONE. Prefab.children (ChildPrefabRef{prefabId, local?}) +
    engine spawnPrefab subtree recursion (spawn child → setParent →
    ctx.placeChild) + ChildSpawn structural type + placeChild ctx hook
    (tile-server writes child Position from local; scale deferred). Loader
    validates child shape per-prefab + a cross-ref pass rejecting
    unknown/abstract child ids. 3 engine prefab tests + 96 content/engine
    green; bake byte-identical (no prefab uses children yet). Bootstrap
    rides the JSON blob — no codec bump.
  - T-218 — DONE. First real `children` consumer. PoiBase.scenePrefabId
    (TS+valibot) → prefabs/poi/signal_pyre_scene.json (campfire parent w/
    lightEmitter+poiTrigger + 4 torch_placed children). placePoiTriggers
    spawns the scene prefab via spawnPrefab (recursing the subtree) and
    patches runtime poiInstanceId/poiDefId onto the walked trigger; POIs
    w/o a scene prefab keep the bare-entity fallback. T-217 placeChild
    hook refined to also pass parentId — service bakes child *world*
    Position off the parent (static subtrees; live compose is T-223). 2
    poi_spawner tests + 103 content/engine/poi green; bake byte-identical.
  - T-219 — skeletal bones as scene-graph entities
  - T-220 — equipment attachment via scene-graph
  - T-221 — static prop sub-objects as scene-graph children
  - T-222 — coordinator world-scale scene graph
  - T-223 — client render-scope scene graph
  - T-224 — inspector / editor tooling against any World

The T-214 IR + reducer + rasterizer split work is the substrate this
builds on. Snapshot determinism stays the invariant across every
phase.

### T-066 · Client roof rendering for enclosed areas
Effort: M   Status: todo

On `EnclosureChanged` event, client generates roof geometry over the enclosure polygon.
When the player entity is inside the enclosure, the roof is hidden (player sees interior).
When outside, the roof is visible.
Done when: an enclosed building renders a roof; walking inside makes the roof disappear.

## Client Rebuild

The full plan lives in `CLIENT_REBUILD_PLAN.md` (grounded in an 8-subsystem audit).
Spine: one **voxel pipeline** (`VoxelAtom` → `bakeVoxels` → `buildVoxelMaterial` →
InstancePool, fed by models/terrain/placement/ghost), one **palette authority**
(`palette/world.json` snapping every material at load), and one **scene owner**
(renderer god-class → `EntityMeshRegistry`). Each phase deletes the old path with
the new (replace, don't accrete). Phases are ordered cheapest-identity-win first.

### T-279 · Client rebuild (umbrella)
Effort: XL (multi-phase arc)   Status: planned

Tracks the arc in `CLIENT_REBUILD_PLAN.md`: a general internal-architecture sweep
+ a central voxel-build pipeline (place single voxel / line of voxels with
scaling/spacing, voxels of different sizes, voxels as terrain edges) + a strict
cohesive color palette for visual identity. Keep-grade core (`voxel_bake`,
`displacement`, `bake_pool`, `InstancePool`, input/intent spine, `Place`-command
authority, post-FX edge-ink) is preserved; the mess (renderer god-class, terrain
height-quads, five color authorities, drifted dead code) is replaced. Closes when
T-280..T-284 land; Phase 5 (sparse-voxel chunk wire) stays deferred until volume
editing demands it.

### T-280 · Client rebuild Phase 0 — cleanup + palette authority
Effort: M   Status: done   (8 commits 20efcb4..fc67344)

Every on-screen color now resolves from one `palette.json`: dead static-voxel + IK
paths deleted (20efcb4); the palette authority + CIELAB material snap-on-load
(reserved signal swatches + intent-override map), shipped in the bootstrap blob
(d330699); terrain reads the one source — drifted `MAT_COLORS` gone (5e58043);
day-night lighting/sky/fog from the palette `phases` — cyan sky gone (438b195);
the ~23 ad-hoc render hex literals routed through a `render/palette.ts` token
accessor (782c9ab); the four `MaterialDef→Material` builders collapsed into one
`buildVoxelMaterial` (28c3174); the UI's legacy `--col-*` alias shim inlined onto
the Dreamborn tokens and deleted (fc67344). A designer retunes the whole game —
chrome and world, ground and ghost — from `palette.json`. Headline screenshot-
verified: candy spring-green world → cohesive ash-hazed identity.

Highest identity-per-effort, no new capability. Delete dead code
(`upgradeToVoxelModel`/`collectVoxelModelBakeSpecs` entity_mesh.ts:415-490,
`ik_solver.ts`, `swing_predictor.ts`, stale T-182/CSM comment scaffolds). Create
`packages/content/data/palette/world.json` (the ~22-swatch ash-hazed ramp + a
`phases` lighting block) + a CIELAB load-snap in the content loader + a boot
cross-check (every `MaterialDef.color` on-ramp, fail-fast) + `render/palette.ts`
exposing named tokens. **Delete terrain `MAT_COLORS`/`colorForMat`
(terrain_mesh.ts:34-48)** and read `content.getMaterialSync().color` — closes the
ground-vs-prop drift, the single biggest cohesion defect. Collapse the four
`MaterialDef→Material` builders (entity_mesh/forest_props/renderer/terrain) into
one `buildVoxelMaterial`. Lift `makePhaseLights` into the palette `phases` block;
retune sky off cyan `#7aa4cc` onto ash-grey. Migrate the ~23 ad-hoc render hex
literals to `palette.*` (no raw hex in `render/`). Collapse the UI's two token
generations (theme.css Dreamborn + legacy `--col-*` alias shim) to one source;
delete the shim.
Done when: every on-screen color resolves from `palette/world.json`; terrain and
props share a material color; a designer can retune the whole game's palette from
one file; the dead modules are gone; `deno check` + client bundle green.

### T-281 · Client rebuild Phase 1 — voxel atom + one bake kitchen
Effort: L   Status: done   (ce3cf90, c95c004, 4bc941d, dd4acd4, 55cf331)

`VoxelAtom {cx,cy,cz, sx,sy,sz, materialId, vid?}` + `render/coords.ts` (ce3cf90);
`bakeVoxels(atoms, materialId)` — THE bake kitchen — with per-voxel size,
`bakeSubModel` a thin adapter so the prop/forest path runs through it (c95c004);
the character body (4bc941d) then held weapons + armor (dd4acd4) collapsed onto
`buildMergedSubMeshes` (one merged mesh per material per sub-object via
`bakeVoxels`) — the per-node `buildVoxelMesh` + the collector/cursor
parallel-traversal coupling are gone, and with all baking now sync (a character is
tens of voxels) the whole off-thread bake worker was deleted: `bake_pool`,
`bake_protocol`, `bake_worker`, their test, and the second esbuild entry (55cf331).
"Voxels of different sizes" is mechanically unlocked (parity-tested); a data source
arrives with terrain (T-283) / placement (T-284). Verified live: ANIM harness 7/7
(skeleton builds, walk articulates, swing fires) at each step.
Deferred to T-283/T-284: routing InstancePool's archetype key off per-entity scale
(it currently keys by scale → mixed-size props would explode archetypes; only
matters once varied sizes are emitted).

NOTE (env, T-274 follow-on): `docker restart` of a stack service DROPS the
`./packages` dev bind-mount — the container reverts to its stale image-baked
`/app/packages`, so the tile (which serves the client `dist/game.js` on :14433
from the shared host dist) serves a stale bundle and live verification silently
tests old code. Fix: recreate WITH the dev override, e.g.
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate --no-deps tile-1 client-dev`.
Use `--force-recreate` (compose), never `docker restart`, for dev containers.

Introduce `VoxelAtom {cx,cy,cz, sx,sy,sz, materialId, vid?}` (center + per-voxel
size + material) in `@voxim/content` + `render/coords.ts` `modelToThree` (route
the 6 inline coordinate-swap derivations through it). Promote `bakeSubModel` →
`bakeVoxels(atoms, materialId)`; swap the bake-worker protocol from
`VoxelBakeSpec[]` to `VoxelAtom[]` returning merged `BakedMesh` batches; route
InstancePool through atoms. Collapse the per-node entity path onto the merged
path — delete `buildVoxelMesh`/`buildDisplacedVoxelGeo` and the
collector/cursor parallel-traversal coupling (entity_mesh.ts:403-434). Per-voxel
size mechanically unlocks "voxels of different sizes" (the unit-box template
already scales).
Done when: models + props bake through one `bakeVoxels` path; an entity can carry
mixed-size voxels; draw calls collapse; the parity test still passes.

### T-282 · Client rebuild Phase 2 — renderer breakup (scene-graph; subsumes T-223)
Effort: L   Status: in-progress   (renderer breakup substantively COMPLETE — 50% cut; only low-value polish remains)

FIVE cohesive units lifted out of the renderer god-class — renderer 2120 → 1063
lines, a 50% cut (T-281 had already shrunk it by deleting the bake-worker pool +
per-node path):
  · `WeaponTrailRenderer` (`render/weapon_trail.ts`, d4ee296) — owns slice/mesh
    state + scene layer, fed `update(...)`/frame.
  · `GateMarkerRenderer` (`render/gate_marker.ts`, 491b74e) — owns the gate-pillar
    Groups + buildGateMarker; `screenPos()` takes camera+canvas at construction.
  · `EntityMeshRegistry` (`render/entity_mesh_registry.ts`, c5fadd6) — THE
    headline: the entity-mesh lifecycle (live-mesh map + pooled-prop positions +
    the async spawn→build state machine + equipment sync + per-frame attachment
    placement + `_addStaticProp`/`computePropHalfExtents`). Hybrid boundary from
    a design panel: minimal lifecycle island so the 3 async stale guards +
    velocity-defer + 4 slot re-checks move VERBATIM; the render loop's
    interpolation/cull stays byte-identical in the renderer. The renderer no
    longer names the entity Maps — public methods are thin delegations; external
    callers (game.ts, interaction, hover) unchanged.
  · `loadSlotModel` fold (af963cd) — syncHandSlot + syncArmorSlot's byte-identical
    async prefetch→recheck→load→attach preambles folded into one helper; the slot
    stale-guard is now single-sourced.
  · `EnvironmentLighting` (`render/environment_lighting.ts`, 29eb5d1) — sun + hemi
    + sky/fog + day-night lerp + shadow-frustum follow/snap + sun disc, driven by
    one `update(cameraTarget, cameraPos)`/frame after the camera settles.
    setDayPhase/toggleShadows/palette→lighting become delegations. Verbatim move
    (shadow-snap math byte-identical); screenshot-diffed against baseline (sky,
    sun shading, fog, tree shadows all match; shadows follow the moved player).
All verified each step: deno check (4 targets), grep-zero invariant, 9/9 render
unit tests, ANIM 7/7, screenshot identical to baseline.

REMAINING (low-value polish — the core goal is met, see below):
  · OPTIONAL: extract terrain mesh management (terrainMeshes/Hmaps/Mats +
    updateTerrain/_rebuildChunk/removeTerrain + the cull loop + colorForMat) into
    a `TerrainMeshManager` to chase the ~800-line target. Note: terrain is
    already LOW-coupling (its own maps + methods) — this is line-count cosmetics,
    not untangling, so it's deferred unless the <800 target is wanted for its own
    sake. (T-283 rewrites terrain into voxels anyway — may moot this.)
  · OPTIONAL: `scene` → private behind `addLayer`/`removeLayer`. Marginal: the
    renderer already NEWs the one scene and hands refs to its subsystems; only ~3
    external reachers (game.ts ×2, hover_outline) touch it. Visibility nicety.
  · NOT DOING — the `velocity={0,0,0}` "hack": on inspection it is SOUND, not a
    hack. The synthesis is in applySnapshot (the unreliable movement datagram, a
    flat vx/vy/vz struct); the registry's settle test asks "is it moving?" via
    MAGNITUDE, which is the functionally-correct question (an item at rest has
    ~zero velocity regardless of component presence). A protocol change to make
    presence honest would be high-effort for zero behavioral gain. Closed.
Done when: the core goal — the god-class's COUPLED responsibilities (entity
lifecycle, trail, gates, lighting) out of the renderer — is MET. The renderer is
now scene/camera/post-FX + the render() pipeline + (low-coupling) terrain, at
1063 lines. The remaining items are optional line-count/visibility polish; this
ticket can close here or carry the optional terrain extraction.

### T-283 · Client rebuild Phase 3 — terrain becomes voxels
Effort: L   Status: done   Commit: bf2ff74

Client re-expresses heightmap+materialGrid as voxel atoms: per cell ONE COLUMN-BOX
atom (top face at the cell height, bottom reaching the lowest of its 4 neighbours
so the side faces ARE the exposed cliff), bucketed per material per chunk and
baked through `bakeVoxels`. Cliff faces are baked voxel boxes sharing `vertexDisp`
+ palette with props — "voxels ARE terrain edges" is literally true. Heightmap
stays the collision/authoring source (physics + AoI + wire UNCHANGED). The
quad-emission path (`terrain_mesh.ts`) is deleted, not shimmed.

Implemented (3-approach design panel + judge → hybrid): column-box atomization in
a new THREE-free `terrain_voxels.ts` (`buildChunkAtoms` + `TERRAIN_DISP_MAG`);
heights are 0.25-quantized so the per-voxel-size unlock (T-281) carries cliff
depth — no unit-stacking. The judge's load-bearing catch: `mag = 0.10*min(scale)`
is PER-VOXEL, so different-depth column boxes would crack at a shared cliff corner
— fixed by an optional constant `mag` on `bakeDisplacedVoxel`/`bakeVoxels`, pinned
to `0.10*HEIGHT_STEP` for terrain (default path byte-identical → prop parity).
Uniform palette material via `buildVoxelMaterial` per matId (cellVariation +
vertexColors + the renderer's `_matColor` table dropped). terrainMeshes →
`Map<key, Mesh[]>`; all-4-neighbour rebuild.
Verified: deno check (4 targets); 10/10 render unit tests incl an adversarial case
proving constant-mag welds a shared cliff corner while default mag cracks it; ANIM
7/7; 220 chunks render voxelized + crack-free; screenshot shows blocky
palette-shared terrain meeting props with no gap.

### T-284 · Client rebuild Phase 4 — build spine on the real pipeline
Effort: L   Status: done   Commit: d0cca73   (all 3 chunks landed; the client-rebuild arc is complete)

CHUNK 1 DONE (b5cf82f) — the client build interaction, via a 3-approach design
panel + judge (height-column cursor pick won): VoxelHit {cellX,cellY,baseZ,layer}
replaces WorldCell; `_resolveVoxelHit` = flat-plane ray + terrain-top + per-column
stack count (top-of-column placement, vertical stacking). New `input/build_line.ts`
holds the ONE shared `bresenhamCells`+`brushCells` (deletes both dups; ghost +
commit share it → WYSIWYG). New `state/build_occupancy.ts` mirrors placed
blueprint entities per column (drift-free). `build_ghost.ts` bakes the preview
through `bakeVoxels` at the brush voxelSize, palette-tinted. New `BuildHud.tsx`
(size/spacing steppers). `Placeable.tool` "polyline"→"line" across content +
game_config building.defaultVoxelSize/defaultSpacing. Verified: deno check, 25
unit tests, ghost screenshots (single/line/spacing). NO wire/server change yet.
Deferred (per judge scope cut): side-face placement, a layered occupancy grid,
mid-stack picking, invalid/red ghosting (needs server validation).

CHUNK 2 DONE (d919c1e) — server authority. New `PlaceVoxels=23 { prefabId,
voxelSize, cells:[{cellX,cellY}] }` command + codec replaces chunk 1's per-cell
Place loop; the client sends ONE command (the spacing-decimated brushCells list).
`PlacementSystem._handlePlaceVoxels` is authoritative over BOTH validity and
HEIGHT: each cell's z is the terrain top (`getHeight` on the chunk's Heightmap +
`snapHeight`) + the column's stack × voxelSize — not the placer's z (fixed a
pre-existing ghost-vs-actual mismatch). Stacking allowed (no cellMustBeEmpty),
out-of-reach cells skipped, tool gate reused. The ghost tints red (new palette
`ghostInvalid`) when any cell is out of reach (`_isCellReachable` mirrors the
server gate). Verified: deno check (5 targets), 10 tests (6 codec round-trip +
4 placement: terrain-z/stack/reach/tool-gate), live red out-of-reach line ghost +
tool-gate rejection. NOTE the wire sends the final cell list (server reach-gates
each), not (anchor,end,spacing) — the "shared bresenham server-side" anti-fabrication
is deferred (reach is the real authority; sharing bresenham needs it in a shared
package). Mid-stack `layer`/`baseLayer` fields dropped — the server derives the
stack itself.
CHUNK 3 (folds) — 2 of 3 done:
  · DONE (d170c42) RadialMenu content-driven: the hardcoded STRUCTURE_OPTIONS
    (which listed non-existent wood_door/wood_floor/dirt_ramp) is now a
    `contentService` query over prefabs with BOTH `placeable` + `blueprint`.
  · DONE (f7b0976) Decode registry-dispatch: new `CODEC_BY_WIREID` (in
    @voxim/protocol — NOT @voxim/codecs as guessed; protocol→codecs dep direction
    forbids it) replaces client_world's 31-case switch + the hand-rolled
    health/worldClock DataView decodes (new worldClockCodec). The 3 terrain-grid
    components keep explicit cases (chunk-binding side effects). Coverage test +
    ANIM 7/7 confirm behaviour-identical decoding.
  · DONE (d0cca73) networked-`Container` chest UI (T-077/T-078): Container went
    on the wire (id 53, codec → @voxim/codecs, CODEC_BY_WIREID dispatch); aoi.ts
    streams a chest's banked unique items to the owning dynasty's client.
    ContainerDeposit/Withdraw commands (24/25) + a new ContainerSystem (mirrors
    EquipmentSystem; proximity-gated; helpers switched world.write→world.set so
    the move ships as a delta). ContainerPanel mirrors WorkstationPanel (slot =
    deposit drop-target + withdraw drag-source); makeContainerHandler + E-key
    open it range-gated. Verified: deno check, 335 server/protocol tests, client
    bundle, and a live headless E2E (deploy chest → decode container → deposit a
    unique sword → withdraw it round-trips on client+server).

ORIGINAL SCOPE (full ticket): Brush descriptor on `modeState` (`tool:"single"|"line"`,
`voxelSize`, `spacing`) + `ui_store` fields + a build HUD (size/spacing). Content-
drive the RadialMenu (replace hardcoded `STRUCTURE_OPTIONS` RadialMenu.tsx:22 with
a `contentService` query over placeable prefabs). De-duplicate `bresenhamCells` to
one shared helper consumed by ghost-preview AND commit. Swap the `BoxGeometry`
ghost for `bakeVoxels` at the brush size, palette-tinted. Voxel-face-aware cursor
pick with vertical stacking (one `cursor→voxelHit` resolve feeding ghost + facing).
The `Place` command grows `voxelSize`/`spacing`/cell-list; `PlacementSystem`
validates with the shared `bresenhamCells` (server authority unchanged). Fold in
the networking cleanup: export `CODEC_BY_WIREID` from `@voxim/codecs` and replace
the 31-case decode switch + hand-rolled DataView decodes (client_world.ts:155-283).
**The deferred networked-`Container` chest UI (T-077/T-078) lands here** once
Container is given a wire id + the deposit/withdraw UI is built on the rebuilt
client.
Done when: a player places single voxels and lines with size/spacing control, the
ghost matches the commit cell-for-cell, the radial is content-driven, and decode
is registry-dispatched.

### T-285 · Procedural Model primitive — generator + per-tile variant pool
Effort: L   Status: done   Commits: b2391ed (a) · 399ab7c (b) · 7d2925e (c) · 8ee1576 (d)
(design: `PROCMODEL_PRIMITIVE_PLAN.md`; all four phases landed)

The fifth content-driven primitive (visual), generalizing `ForestPropsRenderer`
into the rebuild's named "Models (entity/prop/forest)" producer — the
`instance_pool.ts` "future rocks and litter" hook. Two locked decisions: (1)
generator = **parametric atom-grammar** emitting `VoxelAtom[]` from a seed (SPEC
L22), not authored `subObjects`+`pool`; (2) **all scatter is visual-only (zero
ECS entity, collision from `OpenMask`); harvest nodes are separate invisible
`ResourceNode` entities** co-located in scatter cells (positional link, accepted
drift) — which frees the generator's PRNG order from any server hitbox contract.

Shape: content `ProcModelDef` (`data/procmodels/`, `{generator, params}`) +
`ScatterDef` (`data/scatter/`, `{kind, procModel, pool, stride, scaleJitter}` —
absorbs every `FOREST_*` hardcode); a client **generator registry**
(`register("tree_grammar", (seed,params)=>VoxelAtom[])`, boot-cross-checked, no
`switch`); a per-tile **VariantPool** (roll `tileSeed`→K sub-seeds→K generator
runs→K baked geometries→K archetypes `scatter:{id}:{i}|{mat}`); a
**ScatterRenderer** replacing `ForestPropsRenderer` that picks `variantIndex =
hash(worldPos) % pool` per cell and rides scale/rotation jitter on the instance
matrix. The fixed-K pool IS the instancing economics (K meshes, thousands of
instances). Scale-on-matrix (not in the archetype key) **resolves the deferred
T-281 archetype-explosion**. Whole look inherited free via `bakeVoxels` +
`buildVoxelMaterial` + `InstancePool`.

Phasing (see plan): **T-285a** schema + registry + cross-check + fix the
`VoxelAtom` half-extents comment (atoms are FULL edge lengths — `voxel_bake.ts:135`
is authoritative), lands inert · **T-285b** `tree_grammar` (trunk/branch-L-system/
foliage-blob) + bake test · **T-285c** VariantPool + ScatterRenderer, delete
`forest_props.ts`, `FOREST_*`→content, live-verify via `scripts/testplay.mjs` ·
**T-285d** second generator (`boulder_grammar`) + 6-variant stone scatter, zero
engine edits. Replace-not-accrete: `tree_oak`/`branch_oak_*` retire for forests.
Sibling ticket (not here): deterministic server harvest-node placement in scatter
cells.
Done when: forests render from `tree_grammar` variant pools (≥`pool` distinct
silhouettes, stable across reloads), `ForestPropsRenderer` and the `FOREST_*`
hardcodes are gone, and a stone ScatterDef adds 6 variants with no code change.

DONE (all four phases). Foundation (a): `ProcModelDef`/`ScatterDef` categories,
client generator registry + cross-check (the client twin of server.ts's checks),
bootstrap v14→15, VoxelAtom comment fixed. Generator (b): `tree_grammar`
(trunk taper + recursive whorl branches + hash-gated foliage), deterministic,
bakes crack-free. Integration (c): `ScatterRenderer` + per-tile `VariantPool`
replaced `ForestPropsRenderer` wholesale (deleted) — scale rides the instance
matrix, not the archetype key (resolves the deferred T-281 explosion); verified
live (8 archetypes / 4 variants / 4653 instances, frame budget intact).
Generalization (d): `boulder_grammar` + stone scatter (6 variants) added with
ZERO renderer edits — one handler + one register() + two data files. Deferred
clean-up (still open): retire the now-unused authored `tree_oak`/`branch_oak_*`
models for forests, and the sibling server harvest-node placement.

### T-286 · Artistic sweep — filmic grim grade + readable lighting
Effort: M   Status: done   Commit: 0a98014

The grim palette ("a green-grey world the ash fell on") was invisible — even at
noon the world rendered as a near-black void; the desaturated earth tones never
read. An art pass to make the world readable AND more cinematic, without losing
the grim, low-chroma identity. All in lighting + the EdgePass post (no LUT):

- **Filmic tone** — the EdgePass renderer was `NoToneMapping` + a raw linear→sRGB
  clamp; added an in-shader ACES curve + exposure (1.5) on the LIT radiance
  (before the fog-of-war dim), so lifted midtones read while sunlit/ember patches
  roll off instead of clipping.
- **Readable fill** — hemisphere intensity bumped across phases (noon 0.25→0.5,
  …, midnight 0.04→0.16 + moonlit sun 0.06→0.18) so shadowed faces aren't black.
  Explored-but-unseen fog dim lifted 0.55→0.66.
- **Split-tone grade** — cool shadows / warm highlights by luminance (±~6%),
  reinforcing the palette's own deep-water/frost ↔ timber/sand axis — painterly
  depth for the flat grey, no recolour.
- **Vignette** — a subtle corner falloff for focus (0.12), sitting on top of the
  fog-of-war (not fighting it).
- **edgeInk plumbed** — EdgePass no longer hardcodes `0x0d0d0d`; the silhouette/
  crease ink reads the `edgeInk` palette token (peat `#161611`, warmer) via
  `setEdgeColor`, wired where the palette applies (the PROCMODEL §6.4 fix).

Verified with a true before/after at snapped-noon (sun 2.5, hemi 0.25→0.5): the
lit world reads with tonal depth where it was a muted void, grim mood intact.

## Animation & Render Verification

### T-275 · Animation freeze — locomotion clobbered by empty-slot idle fallback
Effort: S   Status: done

The user reported "the charactermodel is not animated." Root-caused live via the new animProbe
(T-277): the server WAS selecting the right clip (`walking`, time advancing) and the client WAS
translating, but the rendered skeleton pose was **byte-identical to idle** — the character slid
around frozen.

Cause in `tile-server/src/systems/animation.ts`: `projectLocomotion` is reused for all three
action slots (locomotion / primary / reaction) and resolved `slot?.actionId || "idle"`. The
`|| "idle"` fallback is correct for the **locomotion** slot (empty → idle, no rest-pose flash on
the first post-spawn tick) but wrong for **primary/reaction**: when not attacking/staggered those
slots are empty, so the fallback fabricated a **full-body, weight-1, override, unmasked** `idle`
layer that composited ON TOP of locomotion and overwrote the walk pose every frame. (`primary`
held `primary_idle`, which has no `animation` block → correctly projects nothing; the empty
`reaction` slot's idle fallback was the actual clobberer.)

Fix: scope the idle fallback with a `fallbackToIdle` param — only the locomotion call passes
`true`; primary/reaction stay silent when empty. Reuses the existing bone-mask layering
architecture (empty slots project nothing; real upper-body actions like swings/hits mask
themselves). Verified live: walk limb-articulation (relative to root) jumped 0.03 → 1.20 (~33× idle
baseline), layer stack dropped from `[walking, idle]` to `[walking]`. Parity test extended with the
"empty primary/reaction projects nothing" case.

### T-276 · Bake-pool resilience — worker-load failure must degrade to the sync bake
Effort: S   Status: done

Second "character not animated" failure mode (distinct from T-275; this one leaves no skeleton at
all). `client/src/render/bake_pool.ts` only registered `worker.onmessage`. A module-LOAD failure
(404 / wrong MIME / CSP blocking workers) does NOT throw from `new Worker()` — it fires an async
`error` event. Unhandled, `usingWorkers` stayed true, `bakeModel` posted to a dead worker, and its
resolve-only promise NEVER settled, so the renderer's `await bakePool.bakeModel()` hung →
`upgradeToSkeletonModel` never ran → the entity stayed an unrigged shell, frozen in rest pose.

Fix: honour the file's own contract ("the render path always has a result"). Register
`onerror`/`onmessageerror` → `#fallbackToSync()` (terminate workers, empty the pool so all future
bakes take the synchronous path, and resolve in-flight `#pending` entries via the same
`bakeDisplacedVoxel` the worker runs). Plus a per-request timeout backstop for a silently-dropped
message. Verified live via `BLOCK_WORKER=1` (T-277): with the worker aborted, `hasSkeleton` still
flips true and the character animates.

### T-277 · Headless animation test harness — animProbe + testInput + assertions
Effort: M   Status: done

`scripts/testplay.mjs ANIM=1` now asserts the character is actually animated, not just that a clip
id is on the wire. Added client test hooks: `game.animProbe()` (live AnimationState layers +
`renderer.sampleBoneWorld`/`hasSkeleton`), `game.testInput.down/up` → `IntentTranslator.pressKey/
releaseKey` (drives the REAL input path, since the browser canvas can't reliably receive synthetic
key events). Assertions: skeleton built (polled — survives the async bake), clip plays at rest,
idle near-static, player translates, locomotion clip while moving, **limbs sweep while moving**,
attack drives a primary action — plus walk/idle screenshots for the human "looks good" gate.

Key measurement lessons baked into the harness: (1) the limb-motion metric is the
translation-AND-rotation-invariant **inter-bone distance range** (a sliding/turning rigid body
preserves bone gaps; only a flexing pose changes them) — centroid-subtraction was too weak and read
walk == idle; (2) movement direction is fixed (no cursor → always one heading) and player position
PERSISTS between runs, so the test tries W/S/A/D until one is clear of terrain; (3) the whole
hold→sample→release loop runs in ONE in-page `evaluate` (cross-boundary key+poll raced under load);
(4) one-shot actions (attack) are re-pressed across a dense window so a press eaten by a stall can't
hide the brief swing. `BLOCK_WORKER=1` routes `bake_worker.js` to abort as the regression test for
T-276. Stable 7/7 across repeated runs in both normal and worker-blocked modes.

### T-278 · Keyboard control — game keys hijacked by browser defaults
Effort: S   Status: done

The user reported "we don't have full control over the keybindings" for the browser-hosted canvas.
`InputCapture` listened at `document` but never called `preventDefault`, so the browser ran its own
defaults for game keys: Space and the arrow keys scrolled the page, Tab stole focus, '/' opened
quick-find, etc. — fighting the game input.

Fix: inject an optional `preventDefaultFor(e)` policy into `InputCapture` (kept game-agnostic — the
predicate is supplied by `game.ts`). It swallows the browser default for `IntentTranslator.GAME_KEYS`
on bare presses, and deliberately does NOT when (a) a text field is focused (never hijack typing) or
(b) a ctrl/meta/alt modifier is held (so Ctrl+C/R/V, Ctrl+Shift+I and other OS/browser shortcuts
keep working). Verified live: Space/ArrowDown → defaultPrevented; KeyP, Ctrl+W, and Space-in-an-input
→ not prevented.

## Client / Controls, Feel & Render Polish

Born from the 2026-06-24 client-overhaul analysis (7-reader sweep over the post-rebuild
client). Root finding: **facing is never predicted client-side** — the local body's
`rotation.y` is written only from networked `state.facing` (`entity_mesh.ts:624`); the
renderer overrides the local player's *position* with prediction (`renderer.ts:879`) but
never *rotation*. The cursor facing computed every frame in `IntentTranslator.facing`
round-trips the server before the body turns. That single gap is the spine of BOTH the
controls-feel complaint and the "attacks go random directions" complaint (the swing trail
sweeps from a stale orientation). The "grayscale" look is the palette's own near-grey
atmosphere (noon `sky` = `fog` = `#9aa39e`, ~5% saturation) plus a hardcoded hemisphere
ground color and an imperceptible ±6% split-tone tint — NOT a blocked T-286 boost (the
palette IS the runtime authority via `applyPalette`). Chosen directions: controls →
camera-relative movement + cursor-aim (Diablo/PoE); color → deutlich bunter.

### T-287 · Camera-relative movement + client-predicted cursor-facing
Effort: M   Status: done   Commit: 31be627

Two coupled control fixes; chosen scheme = camera-relative + cursor-aim (Diablo/PoE).

1. **Camera-relative movement.** `IntentTranslator.buildDatagram` builds the movement basis
   from the player's cursor `facing` (`intent_translator.ts:245-252`) — W moves toward the
   cursor. Replace the basis with the fixed camera yaw (`CameraRig.getYaw()`): W = screen-up,
   D = screen-right, regardless of where the cursor points. `facing` still rides the wire
   (cursor-aim) so the body and swings aim at the cursor. Inject `getCameraYaw` into the
   translator.
2. **Predicted facing.** The local mesh `rotation.y` is set only from networked `state.facing`,
   so the body turns a round-trip late. Pass the local `IntentTranslator.facing` through
   `renderer.render()` and apply it to the local player's `group.rotation.y` in the same
   override block that already overrides local position (`renderer.ts:879`), using the
   `-angle - π/2` convention. Remote entities stay on the interpolated networked path.

DONE: aiming turns the body the instant the cursor moves (no ~50-100ms delay); the swing
trail sweeps toward the cursor every time (fixes "attacks go random directions"); WASD moves
relative to the camera, not the cursor. No server change. Verify via the testplay harness
(local mesh `rotation.y` tracks the cursor angle within one frame).

### T-288 · Single saturated lighting authority — de-grey the atmosphere
Effort: S   Status: done   Commit: 4917ad5

The world reads grey because the palette's own atmosphere is near-grey: noon `sky` and `fog`
are both `#9aa39e` (~5% saturation), and fog color = sky color washes the whole scene toward
grey at `fogFar` 230. The hemisphere GROUND color (`0x334433`) is hardcoded in the
`environment_lighting.ts` ctor and never palette-driven (only `hemi.color`/sky updates in
`applyPalette`). User wants DEUTLICH BUNTER. Make `palette.json` the sole, saturated authority:
(a) decouple fog color from sky and push both toward chroma; (b) add `hemiGround` to palette
phases and drive `hemi.groundColor` from it (warm toward sage/earth); (c) delete the dead
hardcoded `makePhaseLights()` fallback table now that all four phases live in the palette (fail
loud on a missing phase rather than silently falling back to cyan). DONE: noon scene reads with
real color (oak/sand/ember are colored, not grey); exactly one phase table; removing a phase
from `palette.json` errors at boot. Final values dialed on screen with the user.

### T-289 · Replace dead split-tone tint with a real saturation control
Effort: S   Status: done   Commit: 2ddeab1   Depends: T-288

The post-process split-tone tint (`edge_pass.ts:202-207`) is ±6% RGB on an already-desaturated
base — below perceptual threshold (ΔE<2 from neutral), pure cognitive noise. Delete it and add a
real `uSaturation`/vibrance uniform that lifts chroma in the grade (>1, toward "deutlich
bunter"). Re-tune exposure/ACES/vignette around the now-authoritative palette. DONE: the post
pass carries one honest knob instead of a dead tint; the scene has visible chroma punch; the
change is delete-tint + add-one-uniform. Tuned on screen with the user.

### T-290 · Skill-cast animations — populate the `animation` field on skill ActionDefs
Effort: S   Status: done   Commit: bd88c96

Skill ActionDefs (`data/actions/skill_fireblast.json`, `skill_mend.json`) have phases/effects/
costs but NO `animation` block, so `AnimationSystem.projectLocomotion` reads `undefined`, returns
null, and the client renders no motion during the cast despite the action running its full
windup/active/winddown server-side. Pure content hole — `swing_light.json` shows the structure.
Add an `animation` block to each skill mapping windup/active/winddown to a cast clip (reuse an
existing channel pose or author a dedicated cast clip in the skeleton's `animationSlots`),
full-body override to match swing behavior. No code change. DONE: pressing a hotbar skill plays a
visible cast animation for the action's full duration on local and remote characters; verified via
the animation harness. (Cast-bar UI off `ui_store.castState` is a separate nicety, not required.)

### T-291 · Client-side layer crossfade — kill the pose snap on every server delta
Effort: M   Status: done   Commit: 1248bed

`AnimationState` arrives as a full layer snapshot at 20Hz and is applied raw each frame with no
blend — idle→swing / idle→walk hard-cut the pose in one frame and layer weights jump 0↔1. Add a
client-only per-mesh crossfade: a small pending-blend queue keyed by layer id; a layer appearing
in the new snapshot fades in (~150-250ms), a disappearing one fades out (retain the previous clip
during the window); fold the eased weight into the layer evaluation. No wire/server change — the
client derives the blend schedule from layer-presence deltas. DONE: idle→walk→swing→idle
transitions are visibly smoothed (no single-frame limb snap), verified frame-by-frame on the
harness. Optional follow-up: sync locomotion clip time to fractional ticks for 60fps-smooth walk.

### T-292 · Combat impact juice — hit feedback, hitstop, knockback emphasis
Effort: M   Status: todo   Depends: T-287

CORRECTED 2026-06-24 after verifying the code (the analysis reader was wrong here, as it was on
lighting): the combat mechanics are NOT invisible. `health_hit_handler` already installs
`hit_front`/`hit_back`/`stagger_light`/`stagger_heavy` into the `reaction` slot on a weapon_trace
hit (and `stagger_heavy` on the attacker for a parry); `block` (primary/ambient), `dodge_roll`
(locomotion) and the reactions all carry `animation` blocks and project into `AnimationState.layers`
via `AnimationSystem`, so they ALREADY animate and reach the client over the existing wire. A
parallel combat-state enum would duplicate a working mechanism (anti-accretion doctrine) — do NOT.

The real gap is impact JUICE — client-side, no wire change. `DamageDealt` reaches the client
(`game.ts:660`) but only `console.log`s it; `HitSpark` spawns particles but there is no hit flash,
no hitstop, no knockback emphasis. Build (and tune live): (a) a brief damage flash on the victim
mesh on `DamageDealt` (per-entity — needs a non-shared material hook or an emissive overlay; mind
the voxel material cache), (b) optional hitstop (a few-frame freeze of attacker+target anim on a
confirmed hit), (c) knockback emphasis — the server impulse already moves the body; add a short
reactive flinch or a small screen-space punch, (d) a floating damage number off `DamageDealt`.
DONE: a landed hit reads with weight (flash + spark + reaction pose, optional hitstop); blocked hits
read distinctly; knockback has impact. All client-side, tuned on screen with the user. NOTE:
playtest the post-T-287 combat FIRST — with attacks finally going where you aim and the reactions
already animating, scope the juice against what actually still feels missing.

### T-293 · Movement responsiveness tuning pass
Effort: S   Status: done   Commit: 496ed4e   Depends: T-287

After T-287 removes the body-lag (the biggest chunk of perceived sluggishness — pain "model too
slow" is feel, not render cost, which is already sub-ms), tune the remainder. In
`game_config.json`: lower `prediction.correctionHalfLifeMs` 60→~35-40, raise
`prediction.hardSnapThresholdUnits` 2.0→~3.0, raise `physics.groundAccel` 40→~60-70 (max speed
stays 6 — reach it in ~1 frame). Verify no rubber-band on high-divergence cases (hitting an
unpredicted obstacle). Render/voxel-bake cost is already fine — explicitly NOT an optimization
ticket. DONE: turning/stopping feel crisp, HUD `inputLag` within 1-2 frames, no rubber-band
regressions; all changes are content/config values.

## Symphony — Feel, Content & Voxel Language

The 2026-06-24 vision arc: the mechanics exist but don't FEEL good yet — they must become a
SYMPHONY, made accessible through FEEL not TELL. Verified reality: the engine + all four primitives
+ combat consequences (parry/poise/stagger/block/knockback/counter) are DONE and networked; the gap
is FEEL plumbing + CONTENT + a written voxel design language, not new systems. User design
decisions: combat pace = **fast everywhere** (Vermintide frequency, short telegraphs); commitment =
**micro-cancel** (first windup tick bailable, then locked); aesthetic = **organic everywhere**
(vertexDisp across all classes, but silhouette proportions anchored to the human scale so figures
still read). Sequenced as 3 batches; lead with the feel core so the symphony is testable soonest.
See [[project_client_overhaul]] memory + the workflow design framework.

### T-295 · Action commitment flag (micro-cancel) — no bail after the first windup tick
Effort: S   Status: done   Commit: 96be004

Verified: `dispatcher.arbitrate()` already locks active/winddown (`cancel.into:[]`) and runs the
reaction-interrupt block (stagger/hit/death via `interruptPriority`) BEFORE the cancel matrix
(`dispatcher.ts:243-262`); only `windup.into:["any"]` keeps swings bailable. Add optional
`ActionDef.committed?: boolean`. When set, the dispatcher honors the action's cancel matrix ONLY
while `current.phase === "windup" && current.ticksInPhase === 0` (the ~50ms micro-cancel grace the
user chose); after that, reject all non-reaction displacements (one branch above the cancel-matrix
block; the reaction-interrupt path stays untouched so stagger/hit/death always cut in). Set
`committed:true` on all `swing_*` and `skill_*` actions. Stamina still deducts on start (commitment
is a resource bet). DONE: press swing then dodge on the same frame → bail works (tick 0); one tick
later → swing is locked and completes, dodge dropped; getting staggered still interrupts. Verify via
the testplay harness.

### T-296 · Hitstop on weapon contact
Effort: S   Status: todo

Add `ActionDef.hitStopTicks` (default 0). The `weapon_trace` resolver, on a landed hit, freezes
attacker+target movement for N ticks via resolver-local scratch (reuse the rewind-tick scratch
pattern — no new component) and emits a contact event the client maps to a sharp audio crack + brief
freeze. Tune light=2, heavy=4-5. DONE: hitting an enemy produces a visible 2-5 tick freeze + crack;
a heavy swing reads heavier than a light one. No wire change beyond the contact event.

### T-297 · Telegraph lead clip for actions
Effort: M   Status: todo   Depends: T-295

Add optional `ActionDef.animation.preWindup {clipId, ticks}`; bootstrap codec carries it;
`skeleton_evaluator` plays the pre-clip for `ticks` before the `windup:enter` clip (server already
sends phase names — the client derives the lead). With the fast global pace, keep tells SHORT: a
1-2 tick player tell, 3-5 tick enemy tells (readable but quick; the heavy-thrower gets the longest).
DONE: a heavy enemy visibly winds up before its hitbox goes live; a player can read and space against
it; falls back cleanly when `preWindup` is absent.

### T-298 · Readable i-frames + recovery-exposure visuals
Effort: M   Status: todo   Depends: T-295

`skeleton_evaluator` reads `dodge_roll`'s `ticksInPhase` to render a flash / bone-shine during the
i-frame window (client-only, existing server state — the player SEES why the dodge worked). Add an
optional 4th `recovery` phase to the action schema; actions without it treat `winddown` as both.
Author `recovery` on the heavy swings so the post-swing exposed stance is a distinct, punishable
clip. DONE: the i-frame window is visually obvious; a whiffed heavy swing leaves a legible openable
window.

### T-299 · Two committed hostile archetypes + global rear multiplier
Effort: M   Status: todo   Depends: T-295, T-297

Author a **Heavy-Thrower** (the ONE slow showcase enemy against the fast global pace: a single
uninterruptible telegraphed overhead via `committed:true` + a new heavy weapon_action + an
`uninterruptible_active` gate so only block/dodge/death stop it, big knockback) and a **Shield-Knight**
(blocks until flanked, then one committed heavy), using existing primitives + `RequestedActions` BT
nodes. Add a global rear `partMultiplier` (1.25-1.5) to `game_config` + a per-archetype gate
exception. DONE: each enemy rewards a distinct defense — dodge-through the thrower, flank the knight —
readable from telegraph alone. Pure content + a BT variant.

### T-300 · Curated showcase tile_layout — the teaching outpost
Effort: S   Status: done   Commit: 5f88375   (landed ahead of T-299 — placed existing enemies; new archetypes still T-299)

Rewrite `tile_layout.json` into a curated opening scene: keep the stations + trader, add a craft
pavilion (forge+anvil+nearby iron ore/coal), a 2-3 drowner marsh-edge, a rotten_knight ruin, the
T-299 heavy-thrower in a clearing, an archer perch — each at 50-80 cells so the player chooses
engagement. Bump safezone `npcSpawnDensity` 0.08→0.2 so enemies are visibly present; let procedural
fill the fringe. DONE: spawning into the world shows combat, crafting, enemy variety, and procedural
scatter at a glance. Zero code.

### T-301 · Codify the voxel design language (DESIGN_LANGUAGE.md + material generatorPreferences + boot coherence check)
Effort: M   Status: todo

Write `DESIGN_LANGUAGE.md` (repo root): the 4-word grammar vocabulary (SOLID / LIMB / SHELL /
SCATTER-FLECK), the human-anchored scale hierarchy (1 unit = 1u; standing human = 1.2u, head ≈12.5%
for readable silhouette; trees 5-12u, boulders 0.5-3u), the signal-hue reservation (ember/rot/blood/
bile/frost NEVER on structural mass) + semantic density bands per material tag. DECISION (user):
**organic everywhere** — vertexDisp / irregular surfaces across ALL classes including characters and
equipment, BUT silhouette PROPORTIONS stay anchored to the human scale and the ground plane so
figures still read and animate at gameplay distance (organic surface ≠ unreadable form). Extend the
material schema with `generatorPreferences {density_range, thickness_range, layerable, emission}`. Add
a client-boot coherence check (mirror `server.ts` fail-fast): every ProcModelDef/ScatterDef resolves
its generator + materials, no signal hue on a structural-mass material, character-class generators
emit at the ground plane. DONE: the doc exists, the schema carries hints, boot fails loudly on a
clashing generator — it unblocks every later generator's param + proportion choices.

### T-302 · humanoid_grammar — Layer 2 procedural character bodies
Effort: L   Status: todo   Depends: T-301

Implement `humanoid_grammar(seed, params, ctx) → VoxelAtom[]` (T-186 Layer 2): emit SOLID torso/head
+ LIMB arms/legs that FILL limb volume from the existing 6 morph keys, organic surface per
DESIGN_LANGUAGE.md, ground-anchored, fail-fast on missing materials. Add a `generated:true` prefab
path so a test NPC spawns from a generated body, not the authored `biped_skeletal`. DONE: a generated
character reads as solid mass at gameplay distance, varies by seed, animates on the existing
skeleton. Reuses bakeVoxels / the morph wire path / skeleton infra; no wire or schema-breaking change.

### T-303 · Voxel-to-stats slice — Composed sword + material-derived stats
Effort: M   Status: todo   Depends: T-301

Author one Composed sword prefab (blade/grip slots with `materialCategories` + `statContributions`)
and implement the unused `deriveItemStats` `_parts` path: sum `material.properties[property] ×
multiplier` per slot into weight/damage; optionally read the already-derived blade AABB length into a
reach/attackRange stat. DECISION (user): voxels feed **weight/damage/reach, NOT swing speed** (speed
stays a per-action design dial the commitment/telegraph work depends on). Keep hardcoded
`swingable.damage` as fallback when Composed is absent. DONE: swapping the blade material measurably
changes the sword's weight and damage via the live StatContribution schema — voxels feed stats.

### T-304 · POI activity handlers (T-212 v2) — encounter spawning
Effort: M   Status: todo   Depends: T-299

Wire the POI activity registry (`Registry<H>`, mirror the action-effect pattern): implement the
`encounter` handler first (reads a POI mob table, spawns mobs at the trigger centroid, sets aggro on
player entry), boot-cross-check existing POIs against the registry. Defer bossfight/wave/puzzle to a
follow-up. DONE: walking into a wolf_den / bandit_camp trigger spawns the pack and they aggro —
dynamic combat at runtime, not just static placement. Reuses spawnPrefab + TickContext; no new
components.

### T-305 · Per-instance morph variety for NPC spawns
Effort: S   Status: done   Commit: 119e117   (humanoids done; wolf needs quadruped morphParams — follow-up)

Extend the spawner's morph sampling so each NPC of a type rolls morph values within a per-prefab
range (e.g. drowner armLength 1.2-1.6, hipWidth 0.8-1.1) from its spawn seed. DONE: a pack of
drowners has visibly distinct silhouettes despite sharing clips/skeleton — cheap visual variety, zero
animation cost, works on authored OR generated (T-302) bodies.

### T-306 · blade_grammar + armor_grammar — procedural equipment
Effort: L   Status: todo   Depends: T-301, T-302, T-303

Two generators on the ProcModel substrate: `blade_grammar` (LIMB spine + SOLID pommel + SHELL guard;
straight/curved/serrated; material per the density bands) emitting trace metadata the `weapon_trace`
resolver re-derives server-side from the same seed at prefab-load (zero wire cost); `armor_grammar`
(SHELL plates keyed by bone, merged into the character's baked mesh at build time). DONE: a weapon's
blade shape and an NPC's armor are seed-unique, the swing hitbox follows the generated blade, and
stats can feed off the emitted materials (composes with T-303). The vision-4 capstone; depends on the
language + body + stats work landing first.

## Procedural Animation

The Overgrowth/David Rosen direction: a few authored anchors + procedural everything-between + IK,
over one substrate (the skeleton). Poses, IK, and body attachments all hang off the same bones, so
orthogonal behaviours (crouch + strafe + swing) compose instead of needing a combinatorial clip
matrix. See `swing_pose.ts` (the shared producer) and the Swing Inspector (the authoring tool).

### T-307 · Authored swingPath + procedural full-body swing
Effort: L   Status: done   Commit: 4f9007b

Re-introduced `SwingPathDef` (authored blade arc) on `WeaponActionDef`; authored 9 default swings;
`solveSwingPose` derives the whole body from the hilt path (spine twist+lean, weapon-arm IK with
blade·aim=1.0 so hit==visual, off-hand counter). Ported to game: server hit sweeps hilt→tip directly,
client renders the producer over locomotion. Replaces borrowed Mixamo melee clips for swing actions.

### T-308 · Procedural pose catalogue (locomotion poses + IK + secondary motion)
Effort: L   Status: in-progress

The fused pipeline: base-pose catalogue (idle/walk/run/strafe/crouch/turn as parametric poses or
blends) → action overlay (swing/block/dodge) → IK layer (weapon arm, foot planting, look-at) →
secondary motion (snappy organic ease). LANDED: `bendSpine` primitive + `applyLocomotionPose`
(strafe/turn lean) composing with the swing in the inspector; **two-arm IK grips** (`GripDef` +
`swingPath.grips` — one arc serves 1H/2H, both hands via the one aimLimb primitive, commit 9190424);
**secondary motion** (snappy exponential ease on spine/head, NOT a physics-velocity spring — user
constraint; hands excluded so blade==hit; commit 05f13c2). **input locomotion lean**
(1cf601d) wired into the client (local player strafe from movement intent; remotes from velocity;
strafe sign unverified live). **crouch + foot IK** (49f1161 pose+inspector, d450415 client): solveSkeleton
gained an optional `rootOffset`; `applyCrouchPose` drops the pelvis + re-plants feet via `aimLimb` on the
leg chains; client crouches on Ctrl (eased `crouchEased` + a root-group translation). NEXT: parametric
gait replacing idle/walk clips; look-at; foot-on-terrain IK; tune crouch depth/knee-pole + strafe sign.
Dual-wield deferred (2nd server sweep + AnimationState channel).

### T-309 · Body attachment slots — hotbar items rendered on the body
Effort: M   Status: todo

Render the player's HOTBAR items on body anchors (sword on back, axe at hip, etc.) — a LIMITED set of
slots, the count EXTENDABLE by carry-equipment (backpack/belt). The active hotbar item is in hand; the
rest render slung on the body. This (per the user) is the data source — NOT faking a sheath off
`weaponActionId` (which double-renders ~95% of the time, per the design review). The render mechanism
already exists: `AttachmentSlot` (bone-parented THREE.Group anchors) + `attachModelToSlot`; `ARMOR_SLOTS`
already maps e.g. `back → torso_upper`. The hotbar exists client-side (`ui_store` hotbar: 8 slots +
activeIndex; `hotbar_assign`/`hotbar_use` actions). To build: (1) add body anchors with offset transforms
(pos+rot) applied every sync — sheath_back, hip_l/r — generalizing the held-weapon absolute-scale build
onto bone-parented anchors; (2) map hotbar slot index → body anchor; render each occupied non-active
hotbar item's model there; (3) gate the visible slot count by equipped carry-gear. DECIDED (user): the hotbar is
NETWORKED (server-authoritative) so other players see your slung gear; and the full INVENTORY is only
accessible by selecting the BACKPACK on the hotbar (no backpack on the bar ⇒ no inventory access — the
hotbar is what you carry on your body; the backpack is one slot that opens the bag). Composes with T-308
for free (anchors are bone children → slung gear sways with the body). This pulls the hotbar from a
client-UI mapping into a real networked component + an inventory-access gate — sizeable; its own arc.

## Player UX

### T-072 · Respawn / heir flow UI
Effort: M   Status: todo   (core respawn-as-heir done in T-270; remaining: ritual UI + library/treasury)

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

## Heritage & Dynasty

### T-077 · Family library — tome storage at workbench
Effort: M   Status: done   (server substrate; deposit/withdraw UI deferred to T-072/T-076)

A special chest entity associated with the family workbench serves as the library. Stores Lore
tome items (T-018). Persists across character deaths (it is a world entity, not character
inventory). Heir can interact with it during the respawn ritual.
Done when: tomes placed in the library chest persist after character death; heir can access them.

### T-078 · Family treasury — gear storage across deaths
Effort: S   Status: done   (server substrate; equip-during-ritual UI deferred to T-072/T-076)

A second chest entity at the family workbench serves as the treasury. Stores equipment items.
Same persistence model as the library (T-077). Heir equips from here during respawn ritual.
Done when: items stored in treasury persist across deaths; heir can equip them.

Done (T-077 + T-078 share one primitive): a server-only **`Container`** component
([components/container.ts]) — entity-ref slots holding UNIQUE item entities (so each tome's
`Inscribed` and each weapon's `Durability`/`QualityStamped` is preserved per-instance, unlike the
stack-only `WorkstationBuffer`), gated by `kind` (library=tome / treasury=equipment) + `dynastyId`
(stamped from the placer's Heritage on deploy via `stampContainerOwner`). Two deployable chest
prefabs (`library_chest`/`treasury_chest`) + kits + recipes, plus the long-missing `tome`/
`blank_tome` prefabs the lore path already referenced (now boot-cross-checked). `storeInContainer`/
`withdrawFromContainer` ([systems/container.ts]) are dynasty+kind+capacity-gated entity-ref MOVES
(never copy/destroy). **Persistence** is the core work: `SaveManager` (VXM2 v4) now round-trips a
chest fixture AND the unique item entities its slots reference — a new `KIND_ITEM` record carrying
each item's instance components with the UUID preserved, emitted before the chest so slot refs
re-resolve on load (`ItemEffects` was also registered so it stops silently dropping on overlay).
"Persists across death" holds because the chest is its own world entity — `equip_cleanup`/disconnect
only walk a holder's `Equipment`/`Inventory`, never a `Container`. 17 deno tests (`container_ops`,
`container_persistence`): round-trip, death-survival, store/withdraw gates, heir-withdraw-and-equip.
**Deferred (client-drift):** networked Container + the deposit/withdraw + ritual UI — server-first,
network later, the same call buffs/modifiers/ActiveActions made.

### T-079 · Heir spawn at family workbench
Effort: M   Status: done

On character death, instead of direct respawn, create a new character entity at the family
workbench position. If the workbench was destroyed, heir spawns at a fallback location (tile
origin) in a weakened state.
Done when: death spawns an heir at the workbench; no workbench = displaced spawn.

Done: happy-path hearth spawn shipped in T-270; this closes the **destroyed-hearth weakened
fallback**. `resolveHeirSpawn(world, content, hearthAnchor, tileId)` ([heir_spawn.ts]) decides
the heir's spawn from the account `hearthAnchor` + LIVE world: standing hearth (a `WorkstationTag`
entity within `player.hearthDetectRadius` of the anchor) → spawn there; anchor here but no
workstation → the hearth is destroyed → displaced to default spawn + `weakened`. No destroy-event
plumbing needed — "still standing" is derived from world state. The hearth anchor is now cached
per-player at join (`playerHearthAnchors`) so an in-session respawn (no join msg) reaches it; this
also fixed the prior bug where `respawnPlayer` passed `null` and always fell to default spawn.
Weakened = the T-008 `Injury` pipeline: `installPlayer` writes the new `game_config.injuries.displaced`
debuff (moveSpeed ×0.7 through the modifier fold) + starts the heir at `displacedHealthFraction`
(0.5) of max HP. Server-only, no wire/save change. 6 deno tests in `heir_spawn.test.ts`.

### T-080 · Dynasty reputation persistence in NPC world
Effort: L (cross-service arc)   Status: todo   (premise corrected — deferred; needs the prerequisite chain below)

GOAL (unchanged): on heir spawn, the new character inherits the dynasty's standing with NPC
cities; a predecessor's actions (king-killing, trade betrayals) persist as dynasty history, so a
new heir faces the same city attitudes. Reputation is keyed by `Heritage.dynastyId` (stable across
permadeath) — keying by dynastyId IS the done-condition.

PREMISE CORRECTION (2026-06 scope pass): the ticket's stated dependency is **false against the
code**. "NPC city relationship maps (T-044)" are **city→city** affinity (`CityState.relationships:
Record<cityId, -1..1>`, `coordinator/src/city_sim.ts`), NOT dynasty-keyed reputation (CHANGELOG
confirms T-044 shipped "city→city stance"). And the substrate this needs does not exist yet:
- Cities live in **Postgres + the coordinator**, not the tile-server (no CityRepo/city entities on a tile).
- NPC attitude is **dynasty-blind** — the only aggro path (`findDetectedThreat`) is proximity/sense
  only; there is no faction/reputation/hostility component anywhere.
- **No city-affiliated NPCs** are seeded (no guard template; `tile_layout.json` seeds a lone merchant).
- **No kill/betrayal → city-history pipeline**; `entity_died` is tile-local, only gate-crossings +
  a heartbeat reach the coordinator.

So this is a cross-service ARC, not a single ticket. Prerequisite chain (each its own ticket when
scheduled): (a) `CityState.dynastyReputation: Record<dynastyId, number>` in the coordinator (reuses
the `cities.state` jsonb — no migration) + a `CityRepo.adjustDynastyReputation` server-side merge;
(b) a `DynastyGrievance` WorldEvent + coordinator handler (tile publishes on king-kill/trade-betrayal
keyed by killer `Heritage.dynastyId`); (c) push per-tile dynasty attitudes down via TileCommand
(replace the log-only `onCommand`) into a server-only `DynastyAttitudes` cache; (d) a city-guard NPC
template + `CityAffiliation` marker; (e) gate `findDetectedThreat`/`set_job_attack_nearest` on the
attacker's dynastyId vs the city's attitude (data-driven thresholds in game_config). Deferred from
the Heritage batch because of this span.

---

## Territorial Control

### T-294 · Upper-terrain claims as POI metadata (not a second heightmap)
Effort: L   Status: todo

Implement ideas.md's upper/lower terrain as a SEMANTIC overlay on the existing single heightmap,
NOT a literal second elevation layer. A second heightmap doubles terrain wire + save size and
forces layered physics/fog for a feature whose content — claims, central POIs, building hubs,
fast-travel — is all metadata that lives on POI entities; the wilderness plateau already IS the
"upper terrain", and "lower navigation / upper for POIs" maps onto the path-floor-vs-plateau the
terrain already expresses. Build the core claim loop: add a server-only `Claim` component on POI
entities (`poiInstanceId`, `claimerId`, `timestamp`); mark central/hub POIs (`isCentral` on
`PoiDef` + a `TileNarrative` tag). Defeating a central POI publishes a `ClaimAcquired` event;
`TriggerSystem` fires a `grant_claim` effect on the victor (reuses the trigger primitive — no new
event→effect bridge). Persist claims in `HeritageStore` per player per tile (survives death/
disconnect). Gate building placement on owned claims (buildings snap to claimed POI anchors; each
claim unlocks a content-defined building set via `data/buildings`). Depends on T-212 (POI runtime)
/ T-213 (stairs). DONE: a player defeats a central POI, receives and keeps a claim across
reconnect, and unlocks claim-gated building options at that anchor; no second heightmap is
introduced; claim state is server-only for now. Defer claim-SHARING (others' spawnpoints / fast-
travel / sleeping) and minimap/fog claim overlays to follow-up tickets so this lands the core loop.

## Species

### T-085 · Species visual variants — skeleton archetype mapping
Effort: M   Status: todo

Species definitions include a `skeletonArchetype` field that maps to a different skeleton
definition. Dwarf skeleton is shorter and wider; human is the default. Visual differentiation
without new animations — same animation set, different bone proportions.
Done when: a dwarf character renders with dwarf skeleton proportions; animations play on both.

---

## Item Durability

## World / Environment

## UI / Interaction

## Housing

### T-093 · Housing system — player-owned structures as persistent home
Effort: L   Status: todo

A house is a enclosed structure (walls + floor + roof, built via the blueprint system) that a
dynasty claims as their home base. Claiming converts a completed enclosure into a `HouseEntity`
tagged with the dynasty ID. The house is the social and mechanical anchor for a dynasty:

**Claiming:** Player interacts with the interior of a fully enclosed structure (detected via
T-090 room flood-fill) to claim it. Requires a placed family workbench (T-038) inside. A
structure can only be claimed by one dynasty. Claiming transfers the structure's wall/floor
entities to the dynasty's tag (T-083).

**Shelter mechanics:** Interior cells of a claimed house provide: corruption gain suppression,
warmth bonus (amplified further if a hearth/campfire is inside, T-089), and a safe-sleep
anchor for NPCs (T-039). These are computed from the `RoomTag` interior cell set (T-090).

**Persistence:** House ownership persists across server restarts as part of the save system.
On heir spawn (T-079), heir always appears inside the family house if it still stands.

**Destruction / capture:** Destroying enough walls dissolves the enclosure (T-090), which
dissolves the `HouseEntity`. The dynasty loses its home anchor. A new claimant can rebuild
and re-claim. This is the base-capture loop (T-082) applied to housing.

**Furniture:** Deployable items (bed, shelf, chest, hearth) can be placed inside. Furniture
carries the dynasty tag. Furniture items are defined in item_templates.json with a
`deployable: true` flag and an entity template for the placed form.

Done when: a player can build a fully enclosed structure, claim it as home, gain shelter
bonuses inside, and lose the claim when the structure is sufficiently destroyed.

---

## Content Architecture

End-state: every distinct piece of game tuning is content; the engine ships small
generic algorithms that consume content; a single typed-registry federation owns
it all. Client and server share content via a WebTransport-handshake bootstrap
blob — no separate HTTP service, no client-side static bundle. Procedural
generators (loot, names, POIs, quests, dialogue) live as data declarations on top
of engine-side algorithms in `@voxim/content`. Tile-server crash → connection
dies → client reconnects → fresh content blob, version drift impossible.

T-173 unblocks immediate creature work and is independent of the rest. T-174 →
T-175 → T-176 → T-177 are the foundation, sequenced. T-178 → T-179 → T-180
together retire the per-creature skeleton sprawl. T-181 / T-182 / T-183 can land
in parallel once the foundation is in.

### T-183 · Unified generator framework
Effort: L   Status: todo

One concept and one entry point for everything procedural — voxel
geometry, loot tables, name generators, POI layouts, stat curves,
templated text. Algorithms are TypeScript code; generators are data
declarations that pick an algorithm and supply its params. Sharp split
keeps each layer testable in isolation.

Entry point:
  content.invoke<I, O>(generatorId: string, input: I): O

Algorithm registry (under packages/content/src/generators/algorithms/):
  voxel_shape    primitive volumes → ModelDefinition.nodes[]
                 (box / cylinder / sphere / capsule / cone / disc / …)
  voxel_compose  union / subtract / overlay multiple voxel outputs
  voxel_distort  twist / noise / taper post-pass
  voxel_recipe   morph-parameterised body part for T-186 Layer 2
  weighted_draw  loot tables, spawn weights
  markov         name generation from phoneme tables
  grammar        L-system / CFG for POI / settlement layouts
  template       placeholder substitution (quest / dialogue text)
  curve          piecewise-linear evaluator for stat scaling

Generator declarations (in content):
  data/generators/voxel/{id}.json    VoxelGeneratorDef
  data/generators/loot/{id}.json     LootTableDef
  data/generators/names/{id}.json    NameGeneratorDef
  data/generators/poi/{id}.json      PoiTemplateDef
  data/generators/curves/{id}.json   CurveDef

Each declaration: `{ id, algorithm, params }`. The algorithm registry
provides typed param schemas; the loader validates against them at
content-load and fails fast on bad params. Adding a new algorithm is
purely additive (register implementation + paramSchema → drop
declarations using it).

Determinism: every invoke accepts an explicit seed; same seed + same
params + same algorithm version → same output. Used for per-entity
body morphs (T-190), per-spawn loot, per-character names, etc.

Voxel editor (T-191b) consumes the framework directly — every
sub-object in the tree can be a generator invocation with sliders for
its declared params, live re-baking on param change.

First non-voxel migrations:
  - poi_placer's hardcoded room shape → grammar
  - corpse loot tables (wolf / drowner / rotten_knight) → weighted_draw
  - one name generator per culture → markov

Done when: poi_placer reads room shape from data; wolves drop loot
from a generator; spawned NPCs get generated names; voxel editor
spawns procedural sub-objects via the same registry; adding a new
algorithm is one file in algorithms/ + zero changes elsewhere.

### T-191 · Devtools rebuild
Effort: L   Status: todo   (umbrella -- shell+voxel+anim Layer A shipped; closes when T-191z + T-191e land)

Scrap the current voxel-editor and build a coherent two-tool suite:
voxel/model designer + animation editor. Hard separation between data
tooling (Layer A — operates on raw ModelDefinition / SkeletonDef /
AnimationClip JSON, zero game-content imports) and game-content
overlays (Layer B — loads ContentService, lets you preview the
artifact in a game-like scene with prefab equipment / state machines /
maneuvers).

Lives next to atlas as a single served Deno+esbuild+Preact app with
two top-level routes (/voxel, /anim) sharing a common shell.

The old packages/devtools/voxel-editor retires at the end (T-191z).

Phasing → sub-tickets T-191a..e + T-191z.

### T-186 · Procedural character body generator (skeleton + voxel mesh)
Effort: L   Status: in-progress   (Layer 1 morph gen done via T-190; Layer 2 voxel recipe unbuilt)

**Layer 1 delivered as part of T-190.** Sub-object voxel chunks now
stretch alongside bones via the existing morphParams table. Remaining
under this ticket: Layer 2 (procedural body-part recipes) — replace
authored body voxel positions with a recipe-driven voxelizer that fills
each part's volume from morph-parameterised dimensions at spawn. Adds
mass-distribution variety (thick thighs, broad shoulders, narrow waist)
that uniform per-axis scaling can't express.

Single-source-of-truth body shaper: per-character morph values (already
on ModelRef) drive BOTH skeletal proportions AND voxel geometry. A "long
legs" parameter stretches the leg bones AND elongates the leg voxel
chunks together, so the skeleton joint sits at the visible end of the
limb at every value of the slider.

Two layers:

  Layer 1 — sub-object voxel scaling alongside bone scaling:
    biped.json `morphParams` already lists which bones each morph
    affects + a `restAxis`. entity_mesh.ts applies these via boneScale
    {X,Y,Z} to bone rest offsets. Extend the same pass to scale any
    voxel sub-objects parented to those bones along the same axis.
    Adds ~30 lines, no schema changes. Covers: limb length, torso
    height, head size, hip width — anything that maps cleanly to
    "scale the bone segment + the visible chunk by the same factor".

  Layer 2 — procedural part recipes (replaces authored body voxels):
    biped voxel body becomes a recipe declaration instead of authored
    voxel positions. Each part declares a shape generator with morph-
    parameterised dimensions, e.g.
      { part: "torso_upper", shape: "tapered_box",
        length: "$torsoHeight",
        widthTop: "$shoulderWidth * 0.6",
        widthBot: "$hipWidth * 0.5", taper: "$torso_taper" }
    A voxelizer in @voxim/content fills each volume at spawn, keyed by
    the per-character morph values. Required when proportions need to
    affect body MASS distribution, not just length — e.g. "broad
    shoulders + narrow waist", "thick thighs", limb taper, asymmetric
    builds — things that uniform per-axis scaling can't express.

Auxiliary work:
  - Posture-overlay layer: small additive AnimationLayer composed from
    slider values (backlean, slump, alert) — pure rotation offsets on
    a few torso/neck bones, runs alongside whatever Mixamo clip plays
    on the override layer. Mixamo motion stays intact; the base pose
    nudges by the slider amount.
  - Character-creator UI: live sliders mutate ModelRef.morphValues
    in-editor, baked to per-character permanent values on commit. Use
    only in the creator screen — for live characters morphs are
    immutable identity.
  - Foot IK pass when limbs scale far from authored proportions, so
    feet stay planted on terrain at extreme heights. ik_solver.ts
    exists; just needs wiring into the FK pipeline.

Property of this design: hit detection self-consistent at any morph.
blade.baseLocal/tipLocal are hand-bone-local; longer arms genuinely
reach further because the hand bone's world position is further out.
No retargeting maths needed.

Done when: the character creator screen exposes ~6 sliders that
visibly reshape the character (height, leg length, arm length,
shoulder width, hip width, head size); a saved character spawns into
the world at exactly those proportions; Mixamo animations play on
every body type without artifact; hits land at the new reach.

## Ops & Deployment

### T-274 · Dev docker stack errors — devtools crash-loop, gateway WT rebind storm, coordinator crash
Effort: S   Status: done   (three root-caused fixes from a bug-hunt; verified live)

`deno task compose-fresh` surfaced three real errors (separate from the known GatewayLink dial
noise). Found + fixed:
- **devtools crash-loop**: `docker/devtools.Dockerfile` still ran the deleted `scripts/build_voxel_editor.ts`
  (T-191z removed the script + `dev.ts`/`serve_devtools.ts` refs but missed the Dockerfile) → container
  exited 1 → `restart: unless-stopped` looped it forever. Fix: drop it from the cache + CMD (studio only).
- **gateway loses UDP/8080 WT listener for good**: every `deno run --watch=./packages` backend (gateway/
  coordinator/atlas/tiles) restarted whenever the client-dev/devtools esbuild watchers rewrote their
  `dist/` bundles (which live under the bind-mounted `./packages`). On that restart the gateway couldn't
  rebind UDP/8080 (Address already in use) → fell back to HTTP-only permanently → killed every tile↔gateway
  + coordinator↔gateway WT link (the permanent GatewayLink "timed out" flood was a *symptom* of this).
  Fix: `--watch-exclude=./packages/client/dist/** --watch-exclude=./packages/devtools/dist/**` on every
  watch service. NOTE: Deno's `--watch-exclude` does NOT comma-split — a single `a,b` value is one literal
  pattern that never matches; you must pass REPEATED flags. Verified live: touching dist no longer restarts
  the backends; the gateway keeps its WT listener.
- **coordinator crash on WT timeout**: `packages/coordinator/main.ts` lacked the `unhandledrejection` guard
  that `tile-server/main.ts` has, so a transient dial timeout (escaping the GatewayLink retry loop as an
  un-awaited rejection) killed the process. Fix: mirror the tile-server guard. Also fixed a pre-existing
  `coordinator.ts:162` TS error (`setInterval` → `ReturnType<typeof setInterval>`) so the package
  type-checks.

### T-261 · Place gates + arrivals at the carved corridor offset
Effort: M   Status: todo

Split from T-256 gap 4. Gates spawn at edge MIDPOINTS (`gatePositionForEdge` /
`mirrorPosition` use `TILE_SIZE / 2`) while atlas carves the only walkable corridor at the
shared `gate.offset` (`atlas_terrain.ts:192-205` reads `g.offset` then discards it; the
`GatePosition` wire type is edge-only). So a gate trigger — and the mirrored arrival point —
can land in a closed pixel: the gate is physically unreachable, or the handed-off player
arrives stuck in a wall.

Fix shape: carry the along-edge `offset` on `GatePosition` (scaled atlas-pixels → world units
via `TILE_SIZE / tile.gridSize`); `gatePositionForEdge` + `mirrorPosition` place along the
edge at that offset instead of the midpoint. Deferred from T-256 because it needs the live
multi-process render + an open-pixel check to verify the offset scale — shipping it blind
risks gates landing in walls (worse than the known-wrong-but-safe midpoint).

Done when: a gate sits on its carved corridor and a handed-off player arrives on an open
cell, verified against the atlas OpenMask.
