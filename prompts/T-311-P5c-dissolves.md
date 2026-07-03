# T-311 Phase 5c — Creature fragmentation: DissolveProfileDef + dissolutionPhase + shed-on-death

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md` (especially the Trigger/Resource
primitive sections and "wire carries data"), then `VISUAL_DATAMODEL_PLAN.md` §"Phase 5"
(G6 bullet) and **§I3b — the dissolves invariant is a hard gate for this whole prompt**.
Ticket: T-311.

**Depends / assumes landed:** T-311 P0–P4. Independent of P5a/P5b (different subsystem) —
but if they landed, respect their state. Check TICKETS.md.

## Goal

Corrupted creatures visually fray and shed voxels as they take damage and dissolve on death —
authored as content (`DissolveProfileDef`), driven by ONE new networked scalar
(`dissolutionPhase` f32 on `AnimationState`), rendered fully in-shader (zero CPU re-bake),
and hard-capped so the EdgePass outline cost cannot explode.

## The I3b gate (do this FIRST, before authoring anything)

The plan's invariant I3b says the per-voxel drift shader is a deliberate, capped,
harness-verified amendment to the "no per-frame voxel offset" rule — **or it doesn't ship**.
Concretely, before building content:

1. Prototype the shader path with a synthetic worst case (a crowd of ~10 entities at max
   separated-voxel count) via the testplay harness, and measure EdgePass/POST cost in the HUD
   before/after. Drifting voxels get INDIVIDUALLY outlined by the Sobel/SSAO EdgePass — that
   is the cost you are verifying.
2. If the cost is unacceptable at the cap you need, STOP and report — do not ship a reduced
   uncapped version.

## Architecture decisions (already made)

1. **Wire:** exactly ONE new field — `dissolutionPhase: f32` on `AnimationStateData`, codec in
   `@voxim/codecs` (both sides decode it; wire breaks are free per doctrine — no versioning,
   no compat shim). 0 = intact, 1 = fully dissolved. The server writes it; the client derives
   ALL presentation from it + content. No other networked state.
2. **Content:** `DissolveProfileDef` (`data/dissolve_profiles/{id}.json`): fray band width,
   drift velocity/direction params, **hard caps as content fields** (max separated voxels,
   max separation distance — the devtool must be able to show them), phase curve. Referenced
   from the NPC template / prefab (decide by reading how morphTiers are referenced today —
   follow that pattern), boot-cross-checked.
3. **Shader:** in-shader drift only — static per-voxel attributes (fray/coreness sidecar baked
   once at model build: which voxels are "loose", their drift seed) + uniforms
   (dissolutionPhase, profile params). NO per-frame geometry rewrite, NO CPU re-bake. The
   fray/coreness sidecar is generated where the voxel bake already runs (`voxel_bake.ts` /
   the creature model build path — read `entity_mesh_registry.ts` first).
4. **Who advances the phase — compose the existing primitives, no new system:**
   - On death: the `entity_died` trigger catalog + a `shed_dissolve` effect (one effect
     handler file + `register()`, per doctrine). The effect starts the dissolve: a
     `dissolve_timer` Resource on the dying entity moves `dissolutionPhase` (via
     `world.mutate` on AnimationState) from 0→1 over its lifetime; its terminal threshold
     fires the actual despawn. Check how DeathSystem currently despawns corpses and make this
     REPLACE that timing for entities with a profile (no double-despawn).
   - Damage-fraying (sub-lethal): phase floor = f(missing health) is client-derivable from
     Health — do NOT wire that; only the death dissolve animates the networked scalar. Keep
     v1 to death-dissolve + a static damage-fray floor derived client-side.
5. **`shed_voxels` burst effect** (the plan names it): a spawn-particles-style client response
   to the phase crossing thresholds — client-side presentation derived from the same scalar,
   not a second wire event.

## Suggested commit sequence

1. `client` (spike, may be partly throwaway but keep it honest): shader drift path + synthetic
   cap-stress harness run → record the I3b measurement in the commit body. STOP here if it fails.
2. `codecs+tile-server+client`: `dissolutionPhase` on AnimationState (codec + server component
   default + client decode).
3. `content+client`: DissolveProfileDef + loader/cross-check + fray/coreness sidecar bake +
   shader consumption; one profile JSON for one corrupted creature (pick the drowner or
   rotten_knight — whichever template exists with a corrupted framing).
4. `tile-server+content`: `shed_dissolve` effect handler + `entity_died` TriggerDef +
   `dissolve_timer` resource def; despawn handoff from DeathSystem verified.
5. Studio: the devtool panel showing the caps visibly (plan: "the devtool enforces visibly") —
   read the existing Studio panel structure in `packages/devtools` first and follow it.
6. Close: plan G6 bullet marked landed; TICKETS.md note.

## Do NOT

- Add more than the one f32 to the wire.
- Move voxels on the CPU per frame, ever.
- Ship without the I3b measurement recorded.
- Build a bespoke "DissolveSystem" — the Trigger + Resource + effect-registry composition IS
  the implementation (CLAUDE.md shows the same three-primitive composition for buffs).

## Verification

Standard bar. Testplay: kill a profiled creature, screenshot mid-dissolve (voxels visibly
fraying/drifting, entity gone after the timer), HUD frame cost sane during a multi-kill.
Full suite green; codec round-trip test extended for the new field
(`codec_registry.test.ts` expected-set will change — update it deliberately).
