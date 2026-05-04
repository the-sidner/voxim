# Atlas — Procedural Level Service

> Status: design — phase 0 (skeleton) only.
> Branch: `atlas/skeleton`. Lessons-from informed by archived branch `explore/ots-camera`.

## Vision

The world is one big dungeon. Two primitives compose at every scale:

- **Rooms** — open space you can walk through.
- **Boundaries** — things that block movement until something transforms them.

World-scale boundaries (rivers, mountain spines, road-blocks) thread through many tiles. Tile-scale boundaries (trees, cliffs, water channels) shape the maze inside each tile. Players transform boundaries into rooms — chop, bridge, climb, mine — and the resulting topology change propagates through a single navigation graph that drives both macro routing (which tiles to traverse) and micro routing (which rooms inside a tile).

The "open world feel" comes from continuous biome parameters and worldgen-spanning features. The "dungeon feel" comes from rooms-and-corridors generated inside each tile. They're the same system at two scales.

## Why a separate service

The earlier in-tile approach (`packages/tile-gen` + scattered glue across tile-server, world, content) became hard to reason about — too many seams, too much shared state, no clean ownership. Atlas is a deliberate redesign: one process owns level generation end-to-end, writes its outputs into the DB the tile-server reads, and ships with its own inspector. Tile-server stops embedding generation; it becomes a pure runtime that consumes pre-generated tile blobs.

```
                         ┌──────────────┐
                         │    Atlas     │
                         │   service    │
                         │              │
                         │  worldmap    │← deterministic, materialised
                         │  tilemap     │← deterministic from worldmap
                         │  inspector   │← built-in web UI
                         │  HTTP API    │← regen, query, edit
                         └──────┬───────┘
                                │ writes
                         ┌──────▼───────┐
                         │     DB       │
                         │  worldmap    │
                         │  tile_init   │←─────────┐
                         └──────────────┘          │
                                                   │ reads at boot
                                            ┌──────┴─────┐
                                            │ tile-server│
                                            │ (runtime)  │
                                            └────────────┘

              ┌──────────────┐     reads aggregate world graph
              │ coordinator  │←────────────────────────
              └──────────────┘     (built from per-tile gate-summaries)
```

Three responsibilities, cleanly split:
- **Atlas** — authoring + generation. Owns initial state.
- **Tile-server** — runtime. Owns mutations (chops, builds, deaths).
- **Coordinator** — macro brain. Owns the aggregated world graph.

## The two layers inside atlas

### Worldmap layer (pre-computed, persisted)

For each cell of the macro grid, atlas computes once and stores:
- biome parameter bundle (the connector — extensible record)
- linear-feature specs (river entry/exit, road waypoints, etc.)
- gate offsets (mirrored across shared edges)
- city seed flag, corruption level, whatever else the macro layer cares about

The worldmap is **precalculated and persisted**. No recomputation on tile-gen
queries — it's already in the DB.

### Tilemap layer (computed from worldmap)

For each tile, atlas reads the worldmap row + the tile's deterministic seed and produces:
- heightmap + material grid (the bytes tile-server already knows how to load)
- openMask + room graph + portal anchors
- spawn descriptors (POIs, NPCs, ambient features)
- the gate-summary `u16`

Stored in DB as `tile_init` — a single row per tile, binary-packed. Tile-server's boot becomes "read `tile_init`; if `tile_save` exists, replay edits on top."

### The interface between layers

A single function call inside atlas:

```ts
function generateTile(
  worldCell: WorldCellRecord,    // from worldmap layer
  tileSeed: number,
): TileInit
```

That's the connector. Tilemap never queries the worldmap layer for anything else — everything it needs is in the cell record. Worldmap never knows tilemap exists.

The cell record is an **extensible parameter bundle**. New parameter slots get added freely; consumers ignore unknown fields.

## What atlas exposes

- **HTTP API**
  - `POST /world/regen` — recompute the worldmap (rare; world-creation event).
  - `POST /tile/{id}/regen` — recompute one tile's `tile_init`. Tile-server's `/regen-terrain` proxies to this.
  - `GET /world/cell/{x}/{y}` — JSON record of one worldmap cell.
  - `GET /tile/{id}/inspect` — debug payload for one tile (rooms, openMask, gate-summary, spawns).
  - `PATCH /tile/{id}/override` — manual edit overrides for a single tile.
  - `GET /health` — liveness.
- **Inspector web UI** (served from the same service)
  - World view: zoomable map of cells, biome shading, river/road overlay, world graph of gate-summaries.
  - Tile view: stage cards driving the live atlas, not running gen in the browser.
  - Edit mode: tweak a parameter, regen tile, watch the result.

## Architectural commitments (carried over from design conversation)

| # | Decision |
|---|---|
| Q1 | The **navigation graph** is the runtime truth — not pixels. Chops, builds, bridges propagate through it. |
| Q2 | Worldgen is **deterministic** but **materialised** in DB. Tilegen reads from the persisted record, not from a recomputation. |
| Q3 | Biomes are worldgen decisions. Tile flavour comes from a **blendable parameter bundle**, not hand-authored archetype JSONs. Numeric tunings interpolate; categorical choices come as weighted baskets. |
| Q4 | **Two-tier graph.** Outer: world is a 2D graph of tile-nodes. Inner: each tile is its own room-node graph. Bridge is the gate-summary `u16`. |
| Q5 | The parameter bundle is the worldmap↔tilemap **connector** — extensible, not a fixed schema. |
| Q6 | Linear features (rivers, roads) delivered as **per-tile specs** (entry/exit edges + offsets), not continuous polylines. Mirrors gate alignment. |
| Q7 | Gate-summary is **boolean reachability** for now. Cost-aware version (distance/safety) deferred until needed. |
| Q8 | **Coordinator** owns the aggregated world graph (in-memory). **Tile-server** owns its own summary (persisted in tile_save). **Gateway** stays a router. No new microservice for the aggregate. |
| Q9 | Boundary-adjacent-pixel dissolve rules — deferred. |

## Storage shape — gate-summary

```
u16 per tile, four nibbles in fixed edge order [N, E, S, W]:

   nibble:  3      2      1      0
   edge:    W      S      E      N
   value:   0..2   0..2   0..2   0..2     ← component id (gate present)
            0xF    0xF    0xF    0xF      ← no gate on this edge
```

**Derivation.** BFS over the inner room graph already labels connected components; assign each gate the component id of its host room. Canonicalise by walking gates in order N→E→S→W, giving id 0 to the first present gate and the next unused id to each newly-encountered component. Two same-shape tiles produce identical `u16`s.

**Query.**

```ts
function reachable(s: number, from: Edge, to: Edge): boolean {
  const a = (s >> (from * 4)) & 0xF;
  const b = (s >> (to   * 4)) & 0xF;
  return a !== 0xF && b !== 0xF && a === b;
}
```

**Coordinator aggregate.** `Uint16Array(worldW * worldH)`. 512 bytes for a 16×16 world.

**On the wire.** Full snapshot on subscribe; deltas as `{tileId, u16}`. ~3 bytes per delta.

**Change detection.** Compute new `u16`, compare to previous. One CPU compare; no graph diffing.

## Internal package layout (target)

Reached over the course of phases 0–6. Phase 0 establishes the skeleton; later phases fill it in.

```
packages/atlas/
  main.ts                  ← service entrypoint
  mod.ts                   ← re-exports for tooling
  DESIGN.md                ← this file
  src/
    server.ts              ← HTTP server (phase 0: /health only)
    worldmap/              ← phase 1
      generate.ts          ← deterministic worldmap pass
      schema.ts            ← cell record shape
      repo.ts              ← DB read/write
    tilemap/               ← phase 2
      generate.ts          ← deterministic tilemap pass
      pipeline/            ← stages: noise, rooms, portals, boundaries, features
      boundaries/          ← BoundaryKind modules (with transform contract)
      features/            ← FeatureKind modules (POIs)
      summary.ts           ← gate-summary u16 derivation
      repo.ts              ← DB read/write
    inspector/             ← phase 1+
      ui/                  ← web frontend (preact, served as static)
      api.ts               ← inspector-specific HTTP routes
    common/                ← rng, math, types
```

## Boundary kinds — data, not code

A boundary kind is **just metadata**. There is no per-kind callback, no `shape()` or `onTransform()` interface to implement. The whole runtime story is one universal loop, kind-agnostic:

```
player action at pixel p with verb v:
  inst = boundaryAt(p)
  if (!inst) → ignore
  if (!inst.kind.transformVerbs.includes(v)) → "wrong tool"
  else:
    openMask[inst.pixels] = 1   // flip
    reflood()                   // O(N) BFS over openMask
    summary = packGateNibbles(rooms, portals)
    if (summary !== lastSummary) push to coordinator
```

So a kind is:

```ts
interface BoundaryKind {
  id: string;                  // "vegetation" | "rock" | "water"
  visual: { modelId, … };      // how to render closed pixels of this kind
  transformVerbs: string[];    // which player verbs can flip it open
}
```

Kinds live in JSON. Adding a new boundary type is a content task, not an engineering one. The gating, the reflood, the summary recompute, the push — all universal.

A boundary **instance** stored per tile (`{ kind, pixels[] }`) tracks which closed pixels belong to which kind, so:
- tile-server knows what model to render at each pixel
- a single chop can atomically clear a multi-pixel boulder
- verb compatibility is decided per-instance, not per-pixel

## Phased plan

Each phase is a self-contained PR. Don't move on until the prior is merged + working.

**Phase 0 — service skeleton.** ← *this commit*
New `packages/atlas/`. Empty service that boots, exposes `/health`, has compose entry, type-checks. The "we have a new process running" milestone.

**Phase 1 — worldmap layer.**
Worldmap generation: biome params per cell, gate offsets, linear-feature specs. Persist to DB. Inspector renders the world view (cells coloured by biome, gates marked, river/road overlay). No tile generation yet.

**Phase 2 — tilemap layer.**
Tile pipeline: noise → rooms → portals → boundaries → features. Write `tile_init` rows. Inspector renders one tile's stage-by-stage view. Tile-server starts reading `tile_init` instead of running its own gen.

**Phase 3 — gate-summary + world graph.**
Atlas derives the `u16` per tile and stores it. Inspector tile view shows the four nibbles + reachability matrix; world view draws connectivity arcs through each cell. Coordinator aggregation lands here too — tiles push, coordinator holds the world graph.

(The runtime "edit → reflood → push" loop is kind-agnostic and universal — no per-kind callback to wire. Once tile-server reads `tile_init` from atlas in phase 6, it picks up the loop with a single function.)

**Phase 4 — boundary kinds.** Split into three sub-phases:

  *4A* — atlas tags every closed pixel with a kind id (CLIFF, VEGETATION,
  WATER, …). Persisted in `tile_init.kindOf`. Inspector adds a "kinds"
  layer. Tile-server still treats every closed pixel uniformly (raised
  cliff) so collision keeps working via the existing heightmap step.

  *4B* — openMask flows through to physics. New per-chunk `OpenMask`
  component; tile-server's terrain lookup gains an `isOpen(x,y)` query;
  `stepPhysics` consults it so movement is blocked on closed pixels
  regardless of the heightmap. Decouples collision from rendering.

  *4C* — per-kind rendering. Vegetation pixels stop raising the
  heightmap and spawn tree entities at those positions; cliffs keep
  the +3u step. With 4B in place, the player still can't walk through
  trees because openMask collides them.

  Boundary kinds remain pure metadata throughout — no per-kind
  callbacks, just visual hints + transform verbs.

**Phase 5 — linear features land in tile gen.**
Rivers + roads stamped into openMask via per-tile specs from worldmap layer.

**Phase 6 — tile-server reads tile_init + runs the runtime loop.**
Tile-server stops generating; reads `tile_init` from atlas at boot, applies player edits on top of it. Player actions that flip openMask pixels trigger the universal `reflood → resummarise → push to coordinator` loop. World graph updates live as players reshape tiles.

## What carries over from the archived branch (concepts only)

- Boundaries-as-primitive — central concept the conversation arrived at.
- Two-tier nav graph (world × per-tile) with gate-summary bridge.
- Per-tile linear-feature specs for rivers/roads.
- Module dispatch via kind/instance pattern, but **registered explicitly** in one place — no more import-time self-registration singletons.
- Stage-by-stage inspectability of the pipeline.
- Reachability check is informational, not constraining.

## What was deliberately dropped

- All of `packages/tile-gen` source (replaced by atlas's tilemap layer).
- `packages/world` (will fold into atlas worldmap layer in phase 1).
- The maze debug overlay, the `/maze-info` endpoint, the in-tile-server `procedural` spawner integration.
- `WorldMapPayload` shape in protocol (replaced by atlas-managed records).
- `componentOverrides` plumbing on `SpawnDescriptor` (was speculative, never used).
- `GenState` mega-struct that 12 stages all mutate — replaced by typed inputs/outputs threaded through the orchestrator.
- Singleton kind registries — replaced by explicit module lists.
