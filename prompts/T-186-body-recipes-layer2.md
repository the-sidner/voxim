# T-186 Layer 2 — Recipe-driven body voxelizer (morphs drive skeleton AND volume)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the FULL T-186 ticket body in
`TICKETS.md` (Layer 1 is delivered; Layer 2 is this prompt), plus the T-190 Layer-1
implementation it builds on (`entity_mesh.ts` boneScale pass, `biped.json` `morphParams`).

## Step 0 — scope reconciliation (do this BEFORE any code)

`TICKETS.md` also carries **T-302 · humanoid_grammar — Layer 2 procedural character bodies**
(Depends: T-301) in the Symphony content chain. T-186 Layer 2 and T-302 describe overlapping
work from two arcs. Read both tickets AND T-301 (the generator substrate T-302 depends on).
Then reconcile IN WRITING in TICKETS.md before building:

- If T-301's generator substrate exists on HEAD → implement the body voxelizer as a generator
  under that substrate, under whichever ticket's framing matches (likely T-302), and mark the
  OTHER ticket's Layer-2 remainder `obsolete`/superseded with a one-line reason.
- If T-301 has NOT landed → implement under T-186 as specced below, but write the note on
  T-302 that the recipe voxelizer now exists and T-302 reduces to porting it onto the grammar
  substrate (or becomes obsolete).
- One implementation. Never two parallel body-generation paths (doctrine).

## Goal

Character body voxels stop being authored positions and become recipe-driven volumes filled at
model-build time from morph-parameterised dimensions — so one morph value ("long legs", "broad
shoulders") stretches the BONE and elongates/fattens the VISIBLE VOLUME together, and the
joint sits at the visible end of the limb at every slider value. This adds mass-distribution
variety (thick thighs, narrow waist) that Layer 1's uniform per-axis scaling cannot express.

## Architecture decisions (already made)

1. **Single source of truth:** per-character morph values already ride `ModelRef` — Layer 2
   reads THE SAME values Layer 1's boneScale pass reads. No second morph channel, no
   per-instance authored offsets.
2. **Recipe is content on the model/skeleton def** (follow where `morphParams` lives today —
   `biped.json`): per body part, a volume primitive + params (capsule/box/taper: base radius,
   length source = the bone segment, taper curve, symmetry), each param either a constant or
   a morph-scaled expression. The biped's CURRENT look must be reproducible as the default
   recipe — acceptance test: recipe output at neutral morphs ≈ the authored voxels it
   replaces (visually judged via Studio/testplay, not byte-asserted).
3. **Replace, don't accrete:** when the recipe path lands for a body part set, the authored
   voxel positions for those parts are DELETED from the model JSON in the same commit. No
   `useRecipe` flag, no fallback branch. If you can't replace the whole biped in one commit,
   split by body part group (legs commit, torso commit, …) — each commit fully replaces its
   parts.
4. **Where it runs:** at model build/spawn time where the voxel model is currently assembled
   (client `entity_mesh_registry.ts` build path + wherever the server needs AABBs/hitboxes —
   check `deriveItemStats`-style server consumers of body geometry, and `HalfExtents`/hitbox
   templates: if hitboxes derive from authored voxels today, they must derive from the recipe
   output the same way, or collision and visuals drift apart).
5. **Determinism:** same ModelRef morphs → same voxels, every build, both sides if the server
   ever builds them. Seeded variation (if any) comes from the entity's existing seed, through
   the shared PRNG home (`@voxim/engine` rand — T-315 C5), never `Math.random`.
6. **Studio:** the animation/model panel should show recipe output live against morph sliders
   (the panel structure exists from the anim arc — extend, don't fork). This is the tool that
   makes Layer 2 authorable; treat it as part of the deliverable, not garnish.

## Suggested commit sequence

1. Step-0 reconciliation note in TICKETS.md (its own tiny commit — it's an audit-trail fact).
2. `content`: recipe schema on the skeleton/model def + neutral-morph biped recipe + boot
   cross-check (recipe references bones that exist, params in range).
3. `client(+tile-server if hitboxes derive)`: recipe voxelizer + legs replaced; Studio slider
   check; testplay.
4. Torso/arms/head in 1–2 more replace-commits.
5. Morph-driven mass params surfaced on 2–3 NPC templates (thick-set bandit vs lanky drowner)
   as the visible payoff; testplay screenshot of the variety.
6. Close: T-186 done (+ the reconciled ticket updated per Step 0).

## Do NOT

- Keep authored voxels alongside recipe output for the same body part.
- Introduce a second morph-value source or per-NPC authored voxel overrides.
- Let hitboxes/AABBs keep deriving from data the renderer no longer uses.

## Verification

Standard bar. Studio: sliders at extremes produce watertight, joint-aligned bodies (no gaps at
knees/shoulders at min/max). Testplay: NPCs visibly varied in silhouette; hit registration
still lands on the visible body (swing at a morphed NPC). Full suite green.
