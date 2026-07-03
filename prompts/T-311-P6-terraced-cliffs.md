# T-311 Phase 6 — Server-authoritative terraced cliffs (CliffProfileDef + CliffGrid) ✶ re-bake

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then `VISUAL_DATAMODEL_PLAN.md`
§"Phase 6" + §I1 (field-set matrix — a NEW chunk grid is a forever-decision) + §I3a
(overhang is DROPPED). Ticket: T-311. This phase is marked ✶: it CHANGES atlas bake output
deliberately.

**Depends / assumes landed:** T-311 P0–P4; ideally P5a/b (but not structurally required).
T-315 landed the chunk-grid hygiene rules you MUST follow (ENVIRONMENT.md "Chunk-grid
lessons"). Check TICKETS.md for all of it.

## Goal

Cliff shape stops being a client-side voxeliser heuristic and becomes atlas-authored terrain:
the atlas resolves wilderness-perimeter cells into tier bands via `CliffProfileDef`, emits a
**stepped `Heightmap`** plus a new **`CliffGrid`** chunk component, the client deletes its
`CLIFF_*` trigger constants and voxelises the authoritative heights through a
`cliffVoxeliser` registry, and collision agrees because physics floors against the same
stepped heights. Real stepped cliffs with 3 erosion states; Studio Cliff panel with a
collision-overlay toggle; re-bake.

## Architecture decisions (already made)

1. **I1 discipline before any code:** write the exhaustive field matrix for `CliffGrid` —
   plan names `{profileId, erosion, tier, edge}`. For each field: every consumer (client
   voxeliser, physics? studio?), width (u4/u8), and the named-deferred consumers. profileId is
   a **content-version-checked stable index** exactly like `variantIndex` (I3c) — resolved at
   bake, boot cross-check against the bootstrap blob's content version. Packed codec is
   mandatory (I1 wire-budget note) — follow whatever packing the T-311 P3 grids use.
   Put the matrix in the commit body of the wire commit.
2. **New chunk grid checklist (every step, same commit as the wire id):**
   - `ComponentType` entry (never reuse a retired id) + codec in `@voxim/codecs`
   - component def in `@voxim/world` + `NETWORKED_DEFS` registration
   - `spawner`/atlas-load write path
   - **`CachedChunk` in ChunkLifecycleSystem (snapshot/restore/null-guard) + the round-trip
     assertions in `chunk_lifecycle.test.ts`** — the T-315 A1 lesson, non-negotiable
   - SaveManager bucket decision: CliffGrid is atlas-derived → EXCLUDE from saves and
     re-derive on load via the same path the field grids use (`applyFieldsToChunks` pattern) —
     read how `generator.ts` re-applies fields and mirror it
   - client: `ClientChunk` field + decode case in `client_world.ts` (grid decode side-effects
     are explicit there — follow the existing cases; ready fires at batch boundaries)
   - `codec_registry.test.ts` expected-set update
3. **Atlas emission:** perimeter cells → tier bands via `CliffProfileDef`
   (`data/cliff_profiles/{id}.json`; 3 erosion states in v1: crisp / weathered / broken).
   The atlas emits the STEPPED heightmap directly (the wall is no longer a single 2u step but
   a run of tier steps) — `wallHeight`-derived logic downstream (upsample, stair ramps,
   `applyStairUnlock`; all threaded through GenParams since T-315 C1) must be checked against
   stepped walls: stairs must still carve a walkable ramp through a terraced edge. Read
   `stair_unlock.ts` + `upsample.ts` before deciding whether they need tier awareness or
   already operate on raw heights.
4. **Client:** DELETE the `CLIFF_MIN`/`STONE_H`/`STACK_MAX`/`EXPOSE_MIN` trigger heuristics in
   `terrain_voxels.ts` in the same commit the voxeliser registry lands (replace, don't
   accrete). `cliffVoxeliser` is a `Registry<H>` keyed by profile id string
   (columnar/broken/sloped/stone_stair in v1) — a new cliff look is one handler file +
   register(), never an engine edit. The stacked-stone LANGUAGE constants that live on the
   atoms (T-315 D1 named them; some moved to `render.relief`) survive — only the trigger
   heuristics die.
5. **Collision agrees by construction:** physics reads the same stepped Heightmap — verify
   `stepHeight` vs tier-step height (a tier step must NOT be step-up-walkable unless a stair
   says so). Add a physics test for "tier step blocks, stair ramp walks".
6. **Overhang: DROPPED (I3a).** Do not add an overhang registry slot, not even empty.
7. **Snapshot tests WILL change** — this phase deliberately alters bake output. Regenerate the
   atlas snapshot matrix in the same commit as the emission change, and say exactly that in
   the commit body (deliberate output change vs the byte-parity default). Any snapshot change
   in a commit that should NOT alter output is a bug — keep the two kinds of commits separate.
8. **Studio Cliff panel** with the collision-overlay toggle (plan deliverable): follow the
   existing Studio panel pattern in `packages/devtools`.

## Suggested commit sequence

1. `docs/plan`: CliffGrid field matrix (in the wire commit body or a short plan note).
2. `protocol+codecs+world+tile-server+client`: CliffGrid wire + full checklist from #2.
   (Grid exists, all-zero content, nothing consumes — type-check + tests green.)
3. `atlas+content`: CliffProfileDef + tier-band resolution + stepped Heightmap + CliffGrid
   emission; snapshots regenerated; re-bake + testplay (server side lands; client still
   renders old-style → expect visual interim, that's fine for ONE commit).
4. `client`: cliffVoxeliser registry + CLIFF_* deletion; testplay the terraces.
5. `tile-server`: collision verification + the step/stair physics test.
6. `devtools`: Studio Cliff panel + collision overlay.
7. Close: plan P6 marked landed (this also closes the last T-315 deferred item — say so);
   TICKETS.md updated.

## Do NOT

- Reuse a retired wire id, skip the CachedChunk/test step, or leave CLIFF_* half-alive.
- Implement overhangs.
- Let a "should-be-parity" commit and a "deliberate output change" commit blur together.

## Verification

Standard bar plus: re-bake (`?seed=7&width=2&height=2`), tile self-restarts, testplay at a
wilderness edge — stepped terraces visible with erosion variety, stairs still walkable,
player cannot walk up a raw tier step; chunk unload/reload keeps CliffGrid (walk far away
and back — the T-315 A1 sister-bug scenario); full suite green.
