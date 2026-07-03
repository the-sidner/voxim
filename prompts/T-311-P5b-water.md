# T-311 Phase 5b — WaterStyleDef + water renderer rebuilt on WaterGrid.surfaceLevel

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then `VISUAL_DATAMODEL_PLAN.md`
§"Phase 5" (the Water bullet **including its Comb note** — that note is a confirmed-drift
finding from T-315 and is binding) and §"Three hard invariants". Ticket: T-311.

**Depends / assumes landed:** T-311 P5a (the single sun owner — the water shader must read it,
not carry its own). Check TICKETS.md / git log for "P5a"/"sun arc" before starting.

## Goal

Water becomes a first-class content-styled surface driven by the server's `WaterGrid`
(`surfaceLevel` f32 per cell, NaN = no water), with a cheap wetness-weighted reflection —
and the water renderer's last legacy dependencies die: no KindGrid derivation, no mirrored
height constants, no pending/tryBuild wait machinery.

## Architecture decisions (already made)

1. **`WaterGrid.surfaceLevel` is the single source of water height.** Today
   `packages/client/src/render/water_renderer.ts` re-derives water from `kindGrid` + mirrored
   constants and keeps a `pending`/`tryBuild` replay queue whose own header admits it is
   "provably a no-op today". The rebuild: subscribe to `ClientWorld.onChunkReady` (since
   T-315's fix it fires at spawn/delta batch boundaries — `waterGrid` is guaranteed bound when
   the hook runs for production chunks; still null-check per the hook's doc), read
   `chunk.waterGrid.surfaceLevel`, build per-chunk water geometry by merging contiguous
   non-NaN cells at their surface heights. Delete: the kindGrid path, the mirrored constants,
   the `pending` map, `tryBuild`, and the per-tick replay. The file already builds geometry in
   three-space (see its `offZ` comment) — keep that.
2. **`WaterStyleDef` is content** (`data/water_styles/{id}.json`), selected per biome via the
   render-context key (same selection pattern P5a used for atmospheres, same boot
   cross-check). Today's in-shader literals (wave amplitude/frequency, foam threshold/width,
   base color/opacity) become the default style's JSON values — the default world must look
   unchanged after the wiring commit.
3. **Cheap reflection, no probe** (plan): screen-space emissive-streak + sky-gradient blend,
   weighted by `render.wetness`/`render.reflect` from the G4 material treatment axis where the
   shoreline/wet materials are concerned, and by the WaterStyleDef for open water. The full
   planar probe is explicitly deferred — do not build render-to-texture machinery.
4. **Sun comes from the P5a owner.** No sun constant of any kind in this file when you finish.
5. **Chunk hygiene:** WaterGrid already exists on the wire and in `CachedChunk` (T-315 A1) —
   no new grid, no wire change. If you find any residual water state keyed outside
   `ClientWorld`'s chunk structs, fold it in rather than adding a parallel map (T-315 E2
   doctrine).

## Suggested commit sequence

1. `content`: WaterStyleDef type + loader + boot cross-check + `data/water_styles/default.json`
   with today's literals; biome → style selection via the render-context key.
2. `client`: water_renderer rebuilt on `onChunkReady` + `surfaceLevel`; kindGrid path, mirrored
   constants, pending/tryBuild machinery DELETED in the same commit; style params from the def.
   This closes the T-315 comb note — quote it in the commit body and delete the note from
   `VISUAL_DATAMODEL_PLAN.md`'s P5 bullet in this commit (notes move or die with their fix).
3. `client`: cheap reflection pass (emissive streak + sky gradient, wetness-weighted).
4. Close: plan P5 water bullet marked landed; TICKETS.md progress note.

## Do NOT

- Introduce a planar reflection probe, render-to-texture, or SSR.
- Keep ANY piece of the old derivation "just in case" — the wait machinery, the kind
  constants, all of it goes in the rebuild commit.
- Touch dissolves (P5c) or cliffs (P6).

## Verification

Standard bar. Specifically: testplay at a shoreline (the seed-7 world has water in view from
spawn walking east/south — the T-315 phase-A screenshot had it lower-right): water surface at
the correct height vs terrain, foam/wave look preserved on the default style, reflection
streaks visible on the dusk sample (combine with P5a's time-of-day override), no missing water
on chunks that stream in late (walk a boundary), no console errors. Grep proves zero
references to the deleted symbols.
