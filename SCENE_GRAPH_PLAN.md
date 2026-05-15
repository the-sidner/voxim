# Scene Graph as a Central Engine System — Implementation Plan

**Status:** design locked, not yet implemented. Continues in a new session.
**Tickets:** new arc, filed below as T-215 through T-224.
**Predecessor work:** T-214 (LevelDef IR + reducer pipeline + rasterizer split) is fully landed and is the substrate this builds on.
**Last commit on T-214:** `1fb680d` (tickets update marking T-214 done).

---

## Why this matters

Voxim2 today has three not-quite-identical worldviews held together by codecs and convention:

1. **Tile-server** runs an ECS (`@voxim/engine`'s `World`) — flat entity store, components, systems, 20Hz tick.
2. **Client** maintains a separate `ClientWorld` (`packages/client/src/state/client_world.ts`) that decodes incoming state into a parallel store with its own access patterns.
3. **Atlas** runs a reducer pipeline producing pixel buffers + a `LevelDef` semantic graph; no entities at all.

This has worked for the size we're at. It will not work for what comes next: instanced dungeons, lobbies, vehicles, offline play, first-class editor tooling, content-only modding. Each of those requires the same world-as-data abstraction working in multiple contexts, and the three-way duplication is the wrong substrate.

Unity, Godot, and Unreal all converged on a single answer:

- **A scene graph that organizes entities hierarchically**, sitting **co-equal with** (not replacing) the flat ECS-style entity store.
- **Prefabs that produce subtrees of entities**, so designers compose worlds without code.
- **Networking that replicates the scene graph as data**, so multiple service tiers share one mental model.
- **Tooling that operates on the scene graph as a tree**, so designers can see, click, edit.

The T-214 work taught the codebase to think declaratively (LevelDef as authoritative IR, regions owning their pixels, rasterizer split, every node carries provenance). This plan is the **organizing principle** that makes those declarative pieces composable across services: the scene graph becomes a first-class engine concept that atlas (bake), tile-server (runtime), coordinator (world graph), and client (rendering) all consume in their own way.

---

## The architectural insight

**ECS and scene graph are two complementary views over the same entity set, both engine primitives.**

```
                ┌────────────────────────────────────┐
                │  @voxim/engine                     │
                │                                    │
                │  ┌──────────────┐  ┌────────────┐  │
                │  │  ECS         │  │  Scene     │  │
                │  │              │  │  Graph     │  │
                │  │  flat entity │  │            │  │
                │  │  + component │  │  parent ↔  │  │
                │  │  store       │  │  child     │  │
                │  │              │  │  links     │  │
                │  │  queries by  │  │            │  │
                │  │  component   │  │  hierarchy │  │
                │  │  combination │  │  queries   │  │
                │  └──────┬───────┘  └─────┬──────┘  │
                │         └────────┬────────┘        │
                │                  │                 │
                │            same EntityId           │
                │            two views               │
                └────────────────────────────────────┘
```

- The ECS view answers *which* entities have these components (existing `world.query`).
- The scene-graph view answers *which entities are organized under this subtree* (new `world.descendants`).
- An entity may participate in both views simultaneously: the same UUID is both queryable by component combination and reachable by tree traversal.
- Scene-graph participation is opt-in: an entity may have no parent (default), or may be parented to another entity. Parenthood is itself a component (`Parent`), so it's automatically replicated through the existing wire machinery.

**Nodes ARE entities. Prefabs PRODUCE subtrees of entities.** A POI scene fragment is a prefab variant with child prefabs; spawning it creates a parent entity plus all its children, wired together. Destroying the parent destroys the subtree.

**Each service runs its own scene graph over its own entity set.** The engine doesn't dictate the shape of any hierarchy; it just provides the primitive. Coordinator builds a world-graph (tiles + cities); tile-server builds a per-tile hierarchy (chunks → regions → POIs → props); client builds a render-scope tree (camera + visible chunks + entities). Same primitive, different uses.

---

## Per-service scene graphs

The same engine primitive supports very different organizing principles:

### Coordinator

```
WorldRoot
├── Tile(0,0)
├── Tile(0,1)
├── …
├── City("north_harbor")
│   ├── owns → Tile(2,3)
│   ├── owns → Tile(2,4)
│   └── …
└── Faction("ironwood")
    └── controls → City("north_harbor")
```

Used for: world-graph queries ("which tiles does this city own?"), cross-tile state propagation, faction tick. The coordinator's entities are at the world scale; per-tile entities aren't in this graph.

### Tile-server

```
TileRoot
├── Chunk(0,0)
│   ├── Chamber(c3)                  ← region node
│   │   ├── POI(sanctum_of_ash_z3)   ← POI scene fragment
│   │   │   ├── altar_ash
│   │   │   ├── brazier_left
│   │   │   └── brazier_right
│   │   └── Tree(forest)
│   └── …
├── Player(uuid-xyz)
├── Wolf(npc-3)                       ← NPCs are root-level (no spatial parent)
└── …
```

Used for: AoI culling (descendants of nearby chunks), lifecycle (destroy a POI → destroy its altar+braziers), save scoping ("save deviations on this subtree"), event scoping ("damage in this region").

### Client

```
SceneRoot
├── Camera
├── Lighting (sun, ambient, fog)
├── VisibleChunk(0,0)
│   ├── TerrainMesh
│   ├── ForestInstances (InstancedMesh)
│   ├── POI(sanctum_of_ash_z3)
│   │   ├── altar_ash (Three.Mesh)
│   │   └── …
│   └── …
├── Player(self)
│   ├── Camera anchor
│   └── EquippedSword (childed to right-hand bone)
├── OtherPlayers…
└── UI overlay (HUD, name labels)
```

Used for: render culling (cull a chunk → cull its descendants), transform composition (sword in player's hand inherits player's pose), camera attachment, level-of-detail switching.

---

## What the engine provides

One new module + extensions to existing modules:

```
@voxim/engine
  core/
    world.ts          — entities, components (today)
    scene.ts          — parent ↔ child links, hierarchical queries   ★ NEW
    prefab.ts         — prefab spawning, lifted from tile-server     ★ MOVED
    replication.ts    — networked component primitives               ★ NEW (extracted from tile-server)
    events.ts         — EventBus (today)
  physics/             — math (today)
  net/                 — wire format helpers (extracted from @voxim/codecs / protocol)
```

### Engine surface area

```typescript
// @voxim/engine/core/scene.ts

export const Parent = defineComponent({
  name: "parent",
  networked: true,                              // hierarchy changes replicate naturally
  codec: parentCodec,
  default: () => ({ entityId: null as EntityId | null }),
});

// World extension API

world.setParent(child: EntityId, parent: EntityId | null): void
world.getParent(child: EntityId): EntityId | null      // O(1) via component
world.getChildren(parent: EntityId): EntityId[]         // O(1) via maintained reverse index
world.descendants(root: EntityId): Iterable<EntityId>   // O(subtree)
world.destroySubtree(root: EntityId): void              // recursive destroy through changeset
world.localTransform(entity: EntityId): Mat4            // relative to parent
world.worldTransform(entity: EntityId): Mat4            // composed up the chain
```

Replication is automatic: changing `Parent` ships as a normal component delta. Destroying a subtree emits one destroy event per descendant through the existing changeset.

### Prefab composition

`Prefab` gains a `children` field. A prefab may declare child prefabs with relative positions/offsets. `spawnPrefab` creates the root and recursively spawns children parented to the root.

```typescript
// @voxim/engine/core/prefab.ts
function spawnPrefab(world, content, prefabId, overrides): EntityId {
  const def = content.prefabs.get(prefabId);
  const root = newEntityId();
  world.create(root, overrides.parent);     // optional parent argument
  // ... install root's components ...
  for (const childPrefab of def.children ?? []) {
    spawnPrefab(world, content, childPrefab.prefabId, {
      parent: root,
      localPosition: childPrefab.localPosition,
      facing: childPrefab.facing,
      ...childPrefab.overrides,
    });
  }
  return root;
}
```

The POI scene fragment from `SCENE_VIEW` discussions is just a prefab variant:

```json
// content/data/prefabs/poi/sanctum_of_ash.json
{
  "id": "poi:sanctum_of_ash",
  "modelId": null,                       // parent is logical, no visible model
  "components": { "poiTrigger": { ... } },
  "children": [
    { "prefabId": "altar_ash",   "localPosition": { "x":  0, "y": 0 } },
    { "prefabId": "brazier_ash", "localPosition": { "x": -3, "y": 0 } },
    { "prefabId": "brazier_ash", "localPosition": { "x":  3, "y": 0 } }
  ]
}
```

---

## SceneView is a serialized world snapshot, not a separate format

This was the major reframe in the design discussion that produced this plan: **there is no separate "SceneView" wire format**. Atlas's bake produces an initial entity tree (via reducers spawning prefabs into a `World`). That World gets serialized into `tile_init`. Tile-server boot deserializes it into its local World. Client connect deserializes the same World shape into its local World.

```
                  ┌────────────────────────────────────┐
                  │  @voxim/engine                     │
                  │  • World    (entity tree)          │
                  │  • Prefab   (entity templates)     │
                  │  • Net      (replication)          │
                  └─┬──────────────────────────────┬───┘
                    │                              │
       imports     │                              │       imports
                    ▼                              ▼
   ┌─────────────────────────┐      ┌─────────────────────────┐
   │  tile-server (runtime)  │      │  client (runtime)        │
   │  • game systems         │      │  • render systems        │
   │  • AI, physics, crafting│      │  • input, UI, camera     │
   │  • authoritative World  │◄──ws►│  • replicated World       │
   └─────────────────────────┘      └─────────────────────────┘
                    │
                    │ persists initial state
                    ▼
            ┌────────────────┐
            │  atlas (bake)  │
            │  builds scene  │
            │  imports       │
            │  @voxim/engine │
            │  to build the  │
            │  same World    │
            └────────────────┘
```

The difference between services is **which systems they install**, not which scene representation they have. Tile-server installs game systems (`NpcAiSystem`, `PhysicsSystem`, `CraftingSystem`, …). Client installs render systems. Atlas runs reducers at bake then exits. Coordinator runs world-tick systems. They all speak the same `World` API.

---

## How the static-vs-dynamic split works

Most entities in a tile are static decorations — trees, props, decals. A small fraction are dynamic — players, NPCs, projectiles. Both flavors live in the same `World`; the difference is **which components they carry**.

- **Static entities** carry `Position`, `ModelRef`, optional `Hitbox` — no behavior components. No system iterates them per-tick. They render on the client; they exist on the server only as collision/spatial data.
- **Dynamic entities** carry behavior components (`NpcAi`, `Combat`, `PoiTrigger`, `ResourceNode`, etc.). Systems iterate them every tick.

The tile-server's `World` holds *every* entity, static and dynamic. Render-only entities are technically there for collision queries; their lack of behavior components means no system touches them per-tick. The 20Hz `applyChangeset` loop is unaffected by static-entity count because no system writes to them.

For wire efficiency:
- **Server**: AoI filter ships entity state to clients only when components change. Static entities never change → never ship deltas after their initial spawn message.
- **Client**: receives initial spawn for static entities (which materializes them in the client's `World`), then renders them. No per-tick wire cost.

This is the same "no per-tick cost when nothing changes" pattern the existing networking already implements. We're not adding a new optimization category.

---

## Persistence as engine-level concern

Today `tile_save` records component deltas per entity (server-only). With the engine-level scene graph:

- **`tile_init` (bake artifact)**: serialized initial World from atlas. Includes the full entity tree with all components.
- **`tile_save` (runtime deltas)**: changes from the initial World — destroyed entities (suppression markers), modified components (delta-encoded), runtime-spawned entities (full serialization).
- **Boot**: load `tile_init` → reconstruct initial World → apply `tile_save` deviations → start tick loop.

This generalizes the heightmap-chunk pattern (bake + tile_save patches) to the entire entity set. The save format becomes a single engine module: "serialize World deltas."

---

## Migration phases / tickets

Each phase is a shippable ticket. The snapshot-determinism invariant (T-214 established) is preserved through every phase: atlas's bake output must remain byte-equivalent unless a phase explicitly changes the world shape, and tile-server / client behavior must remain consistent.

### T-215 — Scene-graph primitive in `@voxim/engine` — **LANDED**

> Done, inert. `engine/src/scene.ts`: `Parent` (networked, engine-owned
> inline codec — engine owns `Serialiser`, stays dependency-free; wire
> id 49 reserved in `@voxim/protocol`), `Transform` + `composeTransform`.
> `World` extended: `setParent`/`getParent`/`getChildren`/`descendants`/
> `destroySubtree`/`worldTransform`/`localTransform` with an O(1) reverse
> child index purged alongside `componentIndex` on destroy;
> `worldTransform` takes a caller-supplied `localOf` so the engine stays
> component-agnostic and is cycle-safe. Registered in `NETWORKED_DEFS`.
> 8 engine tests + regression (actions/bootstrap/bake) green; bake
> byte-identical. Nothing consumes it yet — T-216+ build on it.

**Goal:** Add the `Parent` component, parent/children index in `World`, and hierarchical query APIs. **No behavior change anywhere else** — existing entities default to parent-less; no system uses the new APIs yet.

**What lands:**
- `@voxim/engine/src/scene.ts` — `Parent` component definition + codec + index
- `@voxim/engine/src/world.ts` extends `World` with `setParent`, `getParent`, `getChildren`, `descendants`, `destroySubtree`, `localTransform`, `worldTransform`
- `Parent` registered in `tile-server/src/component_registry.ts`
- Unit tests: parent set/get, children index maintenance, subtree destroy correctness, transform composition

**Files touched:**

| File | Change |
|---|---|
| `packages/engine/src/scene.ts` | NEW: Parent component, codec, child index |
| `packages/engine/src/world.ts` | extend `World` class with hierarchy APIs |
| `packages/engine/mod.ts` | export `Parent`, hierarchy helpers |
| `packages/tile-server/src/component_registry.ts` | register `Parent` |
| `packages/engine/src/scene.test.ts` | NEW: hierarchy invariant tests |

**Out of scope:** no migrations yet. Prefabs don't have `children`. No system uses the new APIs. The infrastructure is there; nothing reads it.

**Acceptance:** `world.setParent(child, parent)` + `world.destroySubtree(parent)` correctly destroys child. Server snapshot determinism intact. Client + tile-server tests pass.

### T-216 — Move `spawnPrefab` into `@voxim/engine` — **LANDED**

> Done. `engine/src/prefab.ts` owns the generic walk (resolve / reject
> abstract / create / preamble / component dispatch); concretes injected
> via `PrefabSpawnContext` (getPrefab, resolveComponent,
> compoundInstaller, preInstall) since they touch game component defs
> the dependency-free engine can't see. tile-server `spawnPrefab` keeps
> its exact signature as a thin context-binding wrapper — every call
> site unchanged, identical behaviour. 70 regression tests green; bake
> byte-identical. (The atlas/client-spawn payoff is structural
> groundwork — not exercised until T-218; the immediate value is hosting
> the T-217 children recursion in engine beside the scene primitive.)

**Goal:** Lift the prefab spawn path from `tile-server/src/spawner.ts` into the engine package so both atlas and client can spawn prefabs into a `World` identically.

**What lands:**
- Move `spawnPrefab` from `tile-server/src/spawner.ts` to `engine/src/prefab.ts`. The `Prefab` *interface* (today in `@voxim/content/types.ts`) stays in content; the runtime *spawning* moves to engine.
- Engine takes `(world, contentService, prefabId, overrides)` — `contentService` is an interface engine declares; content implements it.
- Tile-server's `spawner.ts` becomes a thin wrapper calling into the engine version + installing tile-server-specific archetypes (player installer, npc installer, etc.) that the engine doesn't know about.
- Atlas can now `import { spawnPrefab } from "@voxim/engine"` if a bake reducer needs to spawn into an in-memory World (this is a precondition for T-218).

**Files touched:**

| File | Change |
|---|---|
| `packages/engine/src/prefab.ts` | NEW: generic `spawnPrefab` lifted from tile-server |
| `packages/engine/mod.ts` | export `spawnPrefab`, `SpawnPrefabOverrides` |
| `packages/tile-server/src/spawner.ts` | shrinks to compound-installer dispatch + engine call |
| `packages/atlas/mod.ts` | (no change required, but exposable as `spawnPrefab` re-export) |

**Out of scope:** prefab children (T-217). Engine `spawnPrefab` still walks flat components only.

**Acceptance:** every call site of the old `spawnPrefab` works identically. Snapshot determinism intact.

### T-217 — `Prefab.children` field — **LANDED**

**Landed as designed.** `ChildPrefabRef {prefabId, local?: {x?,y?,z?,scale?}}`
on `Prefab.children`; engine `spawnPrefab` recurses (spawn child via the same
walk → `world.setParent(child, root)` → `ctx.placeChild(child, identity ∘
local)`). A new optional `placeChild` ctx hook keeps placement service-owned
(tile-server writes child `Position` from the local transform; **scale not yet
folded into ModelRef — deferred until a consumer needs it**). Loader does a
per-prefab structural check plus a post-registration cross-ref pass rejecting
unknown / abstract (`_`-prefixed) child ids. Bootstrap needs no codec bump —
prefabs ride the JSON blob, `children` with them. 3 engine subtree tests
(two-children placement, arbitrary-depth recursion, unknown-id throw) + 96
content/engine tests green; bake byte-identical (no real prefab declares
`children` yet — pure substrate, T-218 is the first consumer).

**Goal:** Prefabs can declare child prefabs; spawning a prefab with children creates a parent + subtree.

**What lands:**
- Extend `Prefab` interface in `@voxim/content/types.ts` with optional `children: ChildPrefabRef[]`.
- `engine/src/prefab.ts` recurses into `children` after installing the root, parenting each child via `world.setParent`.
- Content loader validates child refs at load (deferred to a follow-up if needed).
- Test fixture: a "parent" prefab with two child prefabs; spawn it; assert 3 entities + correct parenting + correct local positions.

**Files touched:**

| File | Change |
|---|---|
| `packages/content/src/types.ts` | extend `Prefab` with `children?: ChildPrefabRef[]` |
| `packages/engine/src/prefab.ts` | recurse into `def.children` after root spawn |
| `packages/content/src/loader.ts` | validate child prefab refs (or defer) |
| `packages/engine/src/prefab.test.ts` | NEW: prefab subtree spawn correctness |

**Out of scope:** no existing prefab uses `children` yet. The infrastructure is there; nothing exercises it in real bakes.

**Acceptance:** synthetic test passes. Snapshot determinism intact.

### T-218 — POI scene fragments as child prefabs (first end-to-end use)

**Goal:** Migrate one composite case (POI scene fragments) to use child prefabs. Validates the whole stack.

**What lands:**
- Pick one POI def (probably `sanctum_of_ash` or whichever has the most authoring intent). Convert its scene fragment into a parent prefab with child prefabs (altar + braziers + decals).
- Atlas's `poiNetwork` reducer emits a `spawn-this-prefab-at-region-centroid` instruction into `state.level` (already there as `PoiPlacement`).
- Tile-server boot walks `level.narrative.pois`, calls `spawnPrefab` for each POI's prefab id, which recursively spawns the child subtree.
- The existing `placePoiTriggers` flow simplifies — instead of writing one bespoke entity, it spawns a POI prefab that includes the `PoiTrigger` component and child prop prefabs.
- Client receives parent + child entity spawn messages; renders them as a subtree.

**Files touched:**

| File | Change |
|---|---|
| `packages/content/data/prefabs/poi/sanctum_of_ash.json` | NEW (or migrate existing scene-fragment JSON) — parent prefab with children |
| `packages/content/data/prefabs/items/altar_ash.json` | NEW: altar leaf prefab |
| `packages/content/data/prefabs/items/brazier_ash.json` | NEW: brazier leaf prefab |
| `packages/tile-server/src/poi_spawner.ts` | call `spawnPrefab(world, content, prefabId)` instead of bespoke entity write |
| `packages/atlas/src/tilemap/pipeline/poi_network.ts` | (no change — narrative already references prefab ids) |
| `packages/tile-server/src/poi_spawner.test.ts` | extend: assert child entities exist + correct parent |

**Acceptance:** an end-to-end bake → boot → render shows the sanctum POI with its altar and braziers visible at the host region's centroid. Inspector can navigate the subtree.

### T-219 — Skeletal entities use scene-graph for bone hierarchy

**Goal:** The skeletal bone hierarchy (today in `entity_mesh.ts`'s `boneGroups` Map) becomes scene-graph parented entities, one entity per bone. Equipment attachments become children of bone entities.

**Why:** Today bones are a parallel hand-rolled hierarchy alongside the ECS. Unifying them means equipment attachment (sword in right hand) is *transform composition*, not post-hoc lookup. Skeletal animation drives bone entity transforms; everything childed to a bone moves with it for free.

**What lands:**
- Bone entities created at skeletal-model installer time (tile-server side; client mirrors via replication).
- `Bone` component: `boneId`, `parentBoneId`, `restPose`.
- `SkeletalAnimationSystem` (client-side) writes bone entity transforms each frame from clip evaluation.
- Equipment slots become child entities of bone entities. Equipping a sword: `world.setParent(swordEntity, rightHandBoneEntity)`.

**Files touched:**

| File | Change |
|---|---|
| `packages/engine/src/scene.ts` | (no change — primitive already exists from T-215) |
| `packages/content/src/types.ts` | `SkeletonDef.bones` becomes the spawn manifest for bone entities |
| `packages/tile-server/src/spawner.ts` | skeletal installer spawns bone subtree |
| `packages/client/src/render/skeleton_evaluator.ts` | writes bone entity transforms instead of `boneGroups` map |
| `packages/client/src/render/entity_mesh.ts` | retire `boneGroups`; query bone entities via scene-graph |
| `packages/tile-server/src/components/equipment.ts` | equipped-item lifecycle uses `setParent` |

**Acceptance:** characters animate correctly, equipped items follow bones, snapshot determinism intact, client visual output identical to pre-T-219.

### T-220 — Equipment + attachment via scene-graph

**Goal:** Fold the existing equipment attachment system into the scene-graph. Equipping = `setParent` to bone; unequipping = `setParent(null)`; dropping = `setParent(null) + Position write`.

This may merge with T-219 depending on how invasive T-219 is. Listed separately because it touches more files (CraftingSystem, EquipmentSystem, on-hit drop handlers, etc.).

### T-221 — Static prop sub-objects as scene-graph children

**Goal:** Multi-part prefabs (`model_building_well` with sub-objects) become parent entities with child entities, one per sub-object. Today's `resolveSubObjects` flat list is replaced by spawn-time child instantiation.

**What lands:**
- `Prefab.children` already supports this from T-217.
- Migrate `model_building_well`, `model_building_cottage`, `model_building_ruin_tower`, etc. to declare children.
- Renderer's static-prop pipeline iterates parent's descendants via scene-graph instead of `resolveSubObjects`.

### T-222 — Coordinator world-scale scene graph

**Goal:** Coordinator's tiles and cities become scene-graph entities. The world-graph (today implicit in coordinator state) becomes navigable.

**What lands:**
- Coordinator imports `@voxim/engine` (today probably already does for events; check).
- Tile entity per tile id; City entity for each named city; world root entity.
- Cross-tile state propagation queries the coordinator's scene graph.
- Faction entities as another root-level layer.

This unlocks future tiers: instanced dungeons are subtrees of the coordinator world; lobbies are parent-less mini-worlds; vehicles are movable subtrees.

### T-223 — Client render-scope scene graph

**Goal:** Client's rendering hierarchy (camera + chunks + props) becomes a scene-graph subtree, replacing today's `Map<chunkKey, mesh>` and `entityMeshes` map.

**What lands:**
- Render systems iterate the client's `World` scene-graph, materializing Three.js objects from entity transforms.
- Chunk culling becomes "skip this subtree if its bounding box is outside the camera frustum."
- LOD switching becomes "swap this subtree for a lower-poly variant."

### T-224 — Inspector / editor tooling against any World

**Goal:** The inspector (today atlas-side, T-214 substrate) generalizes to point at any `World` — bake-time, runtime, or replicated. The same UI controls (layer toggles, stage scrubber, entity inspector, scene-graph navigator) work everywhere.

**What lands:**
- Engine ships an `EngineInspector` module that takes a `World` + introspection callbacks.
- Atlas inspector becomes a specialization that points at the bake World.
- A tile-server admin endpoint exposes the live World for runtime inspection.
- Client gets an in-game inspector overlay against its replicated World (developer toggle).

---

## Invariants to preserve through the arc

1. **Snapshot determinism** — atlas's bake output must be byte-equivalent before and after each phase, unless a phase explicitly changes the world content (e.g., T-218 introduces new entities for POIs). The snapshot determinism gate (`generate.snapshot.test.ts` + `zone_graph.snapshot.test.ts` + `poi_network.snapshot.test.ts`) must stay green.
2. **20Hz tick budget** — tile-server's tick must not regress past its current budget. Static-entity count growth is expected (POIs spawn N entities instead of 1) but per-tick work is bounded by behavior-component count, which doesn't grow.
3. **Wire size discipline** — initial spawn messages grow (each POI ships a parent + children); per-tick deltas don't. AoI filtering keeps the static-entity cost amortized.
4. **Client visual continuity** — pixel-level rendering of an unchanged tile should be visually consistent through migrations. Forest trees in the same spots, water surfaces unchanged, POI props at the right anchor positions.
5. **No backward compatibility for save files** — per `CLAUDE.md`'s refactor rules, on-disk state may break across migrations. Saves regenerate.

---

## Open architectural calls

**1. Atlas's bake — World instance or serialized form?**

Atlas's `generateTile` could either:
- (A) Build an in-memory `World` via engine `spawnPrefab` calls, serialize at end.
- (B) Build a declarative `SceneSpawn[]` list, materialize into World at tile-server boot.

(A) is cleaner architecturally — atlas uses the same engine APIs as tile-server. (B) keeps the bake artifact lighter and atlas dependency-light. Recommend (B) first, migrate to (A) as the engine API stabilizes.

**2. Coordinator scope.**

Today's coordinator is small (city placement, world-graph, faction tick). T-222 puts a full ECS World inside it. Worth doing only if cross-tile state propagation, faction tick, or future features (instanced dungeons) need it. If coordinator stays small, T-222 may be deferred indefinitely.

**3. Client `ClientWorld` retirement.**

The client today has a separate `ClientWorld` because some access patterns differ (interpolation buffers, prediction state). Lifting the client onto engine `World` directly is the cleanest end state, but may require keeping client-specific extensions (prediction component, interpolation history). Could land as an extension to `World` rather than parallel code.

**4. Modding API surface.**

Once content is data-driven (prefabs with children, scene fragments, region styles) and the engine is engine-level, modding becomes natural — drop a content pack, restart, the engine consumes it. But that's a *separate ticket* (T-225+) about authoring tools, content validation, mod isolation. Out of scope for this arc.

**5. Editor (Unity-like scene editor).**

A real scene editor — point-and-click placement, drag prefabs into a scene, save — is the natural end of this arc but is a big undertaking. The T-224 inspector improvements lay groundwork; a separate ticket covers the editor proper. Estimate: 6+ months of work past T-224.

---

## Files that materially change

Rough survey of code volumes per package (approximate, will refine during implementation):

| Package | Lines today | Estimated lines added/changed |
|---|---|---|
| `@voxim/engine` | ~3500 | +1500 (scene.ts, prefab.ts moved in, replication.ts extracted) |
| `@voxim/content` | ~5000 | +200 (Prefab.children type, child validation) |
| `@voxim/tile-server` | ~15000 | -2000 (spawner.ts, poi_spawner.ts, stair_spawner.ts shrink; equipment system simplifies) |
| `@voxim/client` | ~12000 | -1500 (ClientWorld → engine World; bone groups → scene-graph; chunk meshes → scene-graph) |
| `@voxim/atlas` | ~6000 | +200 (bake reducers that build World subtrees instead of flat structures, if option (A) chosen) |
| Net | | **-1600 lines, mostly via deduplication** |

This is a refactor that *removes* code overall, despite touching every package. The deletions come from unifying three not-quite-identical worldviews into one.

---

## Resuming in the next session

Start with **T-215** above (scene-graph primitive in `@voxim/engine`). It's the smallest viable foundation; everything downstream depends on it. Keep the phase-by-phase breakdown — each ticket is a clean commit; together they constitute the arc.

Important context to carry forward:

- **T-214 fully landed.** `LevelDef` is the authoritative IR; reducer pipeline writes regions/edges/narrative; rasterizer derives `openMask` + `kindOf` from level. Last commit on T-214: `1fb680d`. See `TICKETS.md:2085+` for the T-214 entry.
- **Snapshot determinism is the load-bearing invariant.** The T-214 arc preserved it through ~8 commits. The scene-graph arc must do the same. Run `generate.snapshot.test.ts` after every change.
- **The engine package is already shared.** Both `packages/tile-server` and `packages/client` import from `@voxim/engine`. This isn't greenfield — it's an extension of an existing shared package.
- **`spawnPrefab` is the canonical entry point** for "make a thing exist in the world." Today it's in `tile-server/src/spawner.ts:329` and handles compound archetypes (player installer, npc installer, item visual-shell). The compound archetype dispatch stays in tile-server; only the *core* prefab walking moves to engine.
- **Entity ids** are stable strings (UUIDs); a SceneNode's id IS the EntityId. No conversion layer.
- **The Parent component is the only new wire-format addition.** Existing component replication handles it automatically once it's in `NETWORKED_DEFS`.
- **CLAUDE.md refactor rules apply.** "No shims, no parallel paths" — each migration phase replaces, not accretes. The "big diff" version is preferred over piecemeal accretion.
- **The reframe is locked.** Scene graph is co-equal with ECS (not a replacement). Nodes ARE entities (not separate scene-graph-only objects). Prefabs PRODUCE entities (recursive subtree spawn). Same shape on client, server, coordinator, atlas — what differs is which systems each installs.

The arc is patient — T-215 alone is shippable; T-216 alone is shippable; each phase delivers value. There is no "all or nothing" moment. Land them one at a time, keep the snapshot gate green, watch the codebase shrink.
