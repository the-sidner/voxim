# Procedural Model — a Generator + Per-Tile Variant Pool Primitive — Implementation Plan

**Status:** DONE (T-285, all four phases a–d landed — commits b2391ed / 399ab7c /
7d2925e / 8ee1576). The fifth content-driven primitive over the
voxel substrate — the *visual* sibling of Actions/Resources/Modifier/
Triggers. It is the anticipated generalization the client rebuild already
named: `CLIENT_REBUILD_PLAN.md` §2.2 lists **"Models (entity/prop/forest)"**
as one producer, and `instance_pool.ts` literally reserves the pool for
"forest decorations, server props, **future rocks and litter**". This plan
turns the one-off `ForestPropsRenderer` into that general producer.

**Tickets:** T-285 arc — sub-tickets T-285a … T-285d below.

**Two locked design decisions (the design conversation, 2026-06-23):**

1. **Generator = parametric atom-grammar.** A generator emits `VoxelAtom[]`
   *directly from a seed* (trunk taper, branch L-system, foliage blob), not
   an authored `subObjects`+`pool` composite. SPEC L22's stated destination
   ("No hand-authored 3D models … generated procedurally … LLM provides
   seeding for variety"). The registry stays generator-agnostic; the grammar
   is just the first registered generator.
2. **All scatter is visual-only; harvest is separate.** Every scattered prop
   is client-baked with **zero ECS entity** (collision already comes from the
   server's `OpenMask`, exactly as forest does today). Harvestable nodes
   (chop-tree, ore vein) are **separate invisible `ResourceNode` entities**
   placed by the server and positionally co-located in scatter cells. The
   visual↔gameplay link is positional, not identity — accepted drift. This
   keeps the entire generator client-side and **frees its PRNG order from any
   server hitbox-derivation contract** (visual props have no hitbox).

---

## 1. The shape, restated precisely

The user's vision: *"the tile declares — I need 4 tree variants, 6 stone
variants; they're deterministically rolled into a pool and handed out as
'random' items; variation is subtle, not huge; some objects carry their own
model (equipment), most are baked per-tile."*

That decomposes into three independent layers, each a content/runtime piece:

| Layer | Question | This primitive's answer |
|-------|----------|-------------------------|
| **Shape** | how one variant's atoms come to exist | a registered **generator** `(seed, params) → VoxelAtom[]` |
| **Pool** | how the tile gets exactly K variants | a per-tile **VariantPool**: roll `tileSeed` → K sub-seeds → run generator K× → bake K geometries → register K archetypes |
| **Placement** | how a cell references a variant | a **pool ticket**: cell picks `variantIndex = hash(worldPos) % K`; the placement stores only the index, the pool owns the geometry |

Why a *fixed-K* pool and not infinite per-position variation: **it is the
instancing economics, not an aesthetic choice.** Infinite variety ⇒ every
prop is unique geometry ⇒ no `InstancedMesh` batching ⇒ dead. Fixed K ⇒ K
baked meshes, thousands of instances over them, archetype count bounded and
predictable against the 4096/archetype cap. The user's instinct is the
performance architecture.

Subtle ("not huge") per-instance variation rides the **instance matrix**
(scale 0.85–1.15 + rotation) — nearly free, since the matrix is uploaded
every frame anyway. This is also the clean resolution of the **deferred
T-281 archetype-explosion issue** ("routing InstancePool's archetype key off
per-entity scale"): scale leaves the archetype key entirely and lives in the
matrix.

Everything routes through the existing kitchen — `bakeVoxels` +
`buildVoxelMaterial` + `InstancePool` — so the whole look (edge-ink
outlines, flat shading, grim palette, `vertexDisp` organic wobble, height-AO,
canopy cutout) is **inherited for free**. The generator writes zero shader
code.

---

## 2. Data model (content)

Two new content categories, both loaded by `JsonSource`/ContentStore,
shipped in the bootstrap blob, **consumed only by the client** (the server
ignores them — visual-only).

### 2.1 `ProcModelDef` — `packages/content/data/procmodels/{id}.json`

A recipe for a *family* of models. The `generator` id dispatches to a
registered handler; `params` is the generator's closed parameter object.

```jsonc
{
  "id": "oak",
  "generator": "tree_grammar",          // → registry; boot-cross-checked
  "params": {
    "trunk":  { "heightRange": [6, 11], "radiusBase": 1.0, "taper": 0.6,
                "material": "bark" },
    "branches": { "whorlHeights": [5,7,9,11], "perWhorl": [2, 4], "depth": 2,
                  "angleDeg": 50, "angleJitterDeg": 20,
                  "lengthBase": 4, "lengthDecay": 0.6, "radiusDecay": 0.5,
                  "material": "bark" },
    "foliage": { "style": "clumps", "radius": 2.5, "density": 0.7,
                 "material": "leaf_oak" }
  }
}
```

Materials are named (resolved via `content.resolveMaterialId(name)` at load,
exactly like `biomeMaterialName`) so generator output flows through the
palette-snap and stays grim-cohesive.

### 2.2 `ScatterDef` — `packages/content/data/scatter/{id}.json`

Where a procmodel scatters per tile, and how big its pool is. **This is the
file that replaces every `FOREST_*` hardcode in `forest_props.ts`** —
`FOREST_MODEL_ID`, `FOREST_TREE_STRIDE`, `FOREST_TREE_SCALE`, the
`BOUNDARY_KIND_FOREST` literal all become content.

```jsonc
{
  "id": "forest_oak",
  "kind": 2,                  // KindGrid BOUNDARY_KIND_FOREST — drives the cell walk
  "procModel": "oak",         // → ProcModelDef; boot-cross-checked
  "pool": 4,                  // "I need 4 tree variants" — the tile-declared K
  "stride": 7,                // one prop per 7×7 cell block (matches old forest)
  "baseScale": 0.7,
  "scaleJitter": [0.85, 1.15],
  "rotate": true
}
```

A second category entry — `forest_boulder.json` with `kind`, `procModel:
"boulder"`, `pool: 6` — is all it takes to add 6 stone variants (T-285d).
No code.

---

## 3. The generator registry (client)

Registry-dispatch over content ids, same doctrine as the action effect/gate
registries and BT node factories — **a designer adds a generator as one
handler file + one `register()` call, never an engine edit**, cross-checked
at client bootstrap.

```ts
// packages/client/src/render/procmodel/registry.ts
export type Generator = (seed: number, params: unknown) => VoxelAtom[];
const REGISTRY = new Map<string, Generator>();
export function registerGenerator(id: string, gen: Generator): void { … }
export function getGenerator(id: string): Generator | undefined { … }
```

- Generators are **THREE-free** (they emit `VoxelAtom[]`, the content
  currency) — so they could move server-side later if a procmodel ever needs
  a server hitbox. The "harvest separate" decision means they don't now.
- **Boot cross-check** (client content-load path, mirroring `server.ts`'s
  ResourceDef/BT checks): every `ProcModelDef.generator` resolves to a
  registered generator, and every `ScatterDef.procModel` resolves to a
  `ProcModelDef`. Fail-fast on a typo.

### 3.1 `tree_grammar` (the first generator, T-285b)

Pure `(seed, params) → VoxelAtom[]`, deterministic via `makePrng(seed)`
(mulberry32) consumed in a **fixed order**:

1. **Trunk** — height `h ∈ heightRange`; a vertical stack of column atoms,
   `radius = radiusBase · (1 − taper·z/h)`. Atoms sized in **FULL edge
   lengths** (see §6 correctness note), `material = trunk.material`.
2. **Branches** — at each `whorlHeights[i]`, emit `perWhorl[…]` branches
   ringed at jittered `rotZ`, each a segment chain stepped along a direction
   at `angleDeg ± angleJitterDeg` off vertical, length `lengthBase`, radius
   tapering; **recurse `depth` times** with `length·=lengthDecay`,
   `radius·=radiusDecay`. (The recursion the authored `resolveSubObjects`
   path never had.)
3. **Foliage** — at branch tips, fill an ellipsoid blob of leaf atoms,
   each atom gated by a per-position hash against `density` (so the canopy
   reads organic, not solid — the "illusion of detail" the edge-ink + AO
   then ink in for free).

Displacement: trees float above the terrain lattice (base buried), so they
need **no terrain weld** — the default per-voxel `mag` is fine. (Contrast
terrain, which must pin `TERRAIN_DISP_MAG`; see §6.)

Because the props are visual-only with no hitbox, this PRNG order has **no
server counterpart to stay in lockstep with** — a major simplification over
the `resolveSubObjects` ⇄ `hitbox_derive.ts:184` mirror constraint.

---

## 4. Runtime — VariantPool + ScatterRenderer

### 4.1 `VariantPool` (per tile, per ScatterDef)

Built lazily on first need (first chunk of matching `kind` arrives), cached
by tile:

```
poolSeed(scatterId, i) = mix32(tileSeed, hash32(scatterId) ^ i)   // i ∈ [0,pool)
for each variant i:
   atoms_i   = getGenerator(procModelDef.generator)(poolSeed(scatterId,i), params)
   for each materialId m in atoms_i:
      geo    = geometryFromBaked(bakeVoxels(atoms_i, m))           // bake once
      archId = `scatter:${scatterId}:${i}|${m}`
      instancePool.registerArchetype(archId, { geo, mat: buildVoxelMaterial(m)… })
```

Archetype count is exactly `pool × materialsPerVariant` — bounded, no
explosion. The K generator runs are a **one-time per-tile cost** at load, not
per-cell; they ride the same 8 ms-budget `requestAnimationFrame` drain
`ForestPropsRenderer.start()` already uses so the first paint never blocks.

**`tileSeed` plumbing** (integration point): the client needs the same
per-tile seed the server derives via `seedFromTileId(tileId)`. The client
already knows its `tileId` from `TileJoinAck` → derive it client-side with
the same FNV-1a, or add `tileSeed` to the ack. (Either; deriving client-side
keeps the wire untouched.)

### 4.2 `ScatterRenderer` (replaces `ForestPropsRenderer` wholesale)

Same `world.onChunkKinds` walk, generalized:

```
for each ScatterDef d whose `kind` appears in this chunk:
   ensure VariantPool(d) is built
   for each cell (lx,ly) at stride d.stride where kinds[...] === d.kind:
      wx,wy   = world coords; wz = terrainHeight(wx,wy)
      hsh     = hash2u(wx|0, wy|0)
      variant = hsh % d.pool
      rotY    = d.rotate ? bits→[0,2π) : 0
      scale   = d.baseScale · lerp(d.scaleJitter, bits)
      matrix  = translate(wx,wz,wy) × rotateY(rotY) × scale          // jitter rides the matrix
      slots   = variant's per-material archetypes → InstanceSlot[]
      instancePool.add(`scatter:${d.id}:${cx},${cy}:${lx},${ly}`, chunkKey, slots)
```

- **Handle prefix `scatter:`** → `instancePool.removeByPrefix("scatter:")` on
  tile transition, exactly as forest does with `forest:`.
- **Scale leaves the archetype key.** Forest keyed `forest:{modelId}|{matId}`
  (fixed scale); props keyed `prop:{id}|{matId}|{sx}|{sy}|{sz}` (scale-in-key
  ⇒ T-281 explosion). The pool keys `scatter:{scatterId}:{variant}|{matId}` —
  scale rides the matrix, so mixed-size instances share one archetype. This
  is the resolution of the T-281 deferral.

---

## 5. Replace-not-accrete (the deletion list)

Per CLAUDE.md, the new code lands *with* the old deleted in the same commit:

- **Delete** `packages/client/src/render/forest_props.ts`
  (`ForestPropsRenderer`) — superseded by `ScatterRenderer`.
- **Move** `FOREST_MODEL_ID` / `FOREST_TREE_STRIDE` / `FOREST_TREE_SCALE` /
  `BOUNDARY_KIND_FOREST` → `data/scatter/forest_oak.json` + a shared
  `BOUNDARY_KIND_*` constant.
- **Retire the authored oak model** for scatter: once `tree_grammar`
  produces oak, `tree_oak.json` + `branch_oak_01..15.json` are dead for
  forests. They stay only if the entity `tree` prefab still renders a visual
  ModelRef — but per the "harvest separate / all visual" decision, the
  harvestable tree is an **invisible** `ResourceNode`, so the `tree`
  prefab's visual ModelRef is itself a retirement candidate. Scope: T-285c
  removes the forest usage; the authored-model retirement is a clean-up step
  in the same arc once nothing references them.
- No shims, no `useGrammar` flag, no parallel forest path.

---

## 6. Correctness notes the implementation must honour

1. **`VoxelAtom.sx/sy/sz` are FULL edge lengths, not half-extents.** The
   `voxel.ts` doc-comment says "half-extents," but `bakeDisplacedVoxel`
   (`voxel_bake.ts:135`) scales the `±0.5` unit box by `scale` directly, so
   `sx=1` spans `[−0.5,+0.5]`. The generator must size in full units. **Fix
   the comment** (or the math — comment is wrong, math is authoritative and
   load-bearing) as a T-285a pre-req.
2. **Constant `mag` only where corners are shared.** Terrain pins
   `TERRAIN_DISP_MAG` to weld cliff seams. Free-standing trees don't share
   corners across instances, so the default mag is correct — but if a
   generator ever emits an *on-lattice* prop (a flat stone slab welding to
   terrain), it must pin `TERRAIN_DISP_MAG` and 0.25-grid-align.
3. **No greedy meshing.** Each voxel = 24 verts. Dense foliage blobs pay for
   it; keep `density` and foliage radius modest, or this is where a greedy
   mesher would first earn its keep (future, not T-285).
4. **`edgeInk` palette token is not plumbed** — `EdgePass` hardcodes
   `0x0d0d0d` instead of the `#161611` token. Orthogonal to this primitive
   but relevant to the "outlines" look; tracked separately.

---

## 7. Phasing

- **T-285a — schema + registry + cross-check (no behaviour change).**
  `ProcModelDef`/`ScatterDef` content types + loader; generator registry
  skeleton + a `tree_grammar` stub; client boot cross-check; fix the
  `VoxelAtom` half-extents comment. Lands inert.
- **T-285b — `tree_grammar`.** Trunk/branch/foliage → oak `VoxelAtom[]`;
  deterministic; a parity/visual bake test (atoms → `bakeVoxels` → expected
  vertex counts, crack-free). Verifiable in isolation (no scatter yet).
- **T-285c — VariantPool + ScatterRenderer; delete `ForestPropsRenderer`.**
  Per-tile pool, per-cell variant pick, matrix-borne scale/rot jitter,
  `FOREST_*` → content. Live-verify with `scripts/testplay.mjs` (forest
  renders, ≥ pool distinct silhouettes, stable across reloads, frame budget
  intact).
- **T-285d — second generator (`boulder_grammar`) + stone scatter.** Proves
  the primitive generalizes: 6 stone variants from one ScatterDef, zero
  engine edits.

**Sibling, not in T-285:** deterministic harvest-node placement (server
drops invisible `ResourceNode` entities in scatter cells so the choppable
tree sits *in* the visual forest). Separate ticket — the visual primitive
deliberately does not own gameplay entities.
