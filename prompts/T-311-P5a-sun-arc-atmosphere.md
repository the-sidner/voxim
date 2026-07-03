# T-311 Phase 5a — Server-clock sun arc + AtmosphereDef + ground mist + god-rays

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then `VISUAL_DATAMODEL_PLAN.md`
(§"Three hard invariants", §"Phase 5", §"Honesty notes") and `ART_DIRECTION.md`. Ticket:
T-311 in `TICKETS.md` (in-progress; P0–P4 landed).

**Depends / assumes landed:** T-311 P0–P4 (render-context key from P0d, GradeDef completeness
incl. bloom/height-shade from T-315 D2). Nothing from P5b/P5c/P6.

## Goal

The sun stops being a client constant and becomes a function of the server's networked
`WorldClock`; the sky/light/mist/god-ray look becomes content (`AtmosphereDef`) selected by
the networked render-context key. Done means: the sun visibly arcs over a game day, shadows
and god-rays agree with it, ground mist pools at dawn, and not a single lighting/sky tuning
literal that this phase touches survives in code.

## Architecture decisions (already made — implement, don't re-litigate)

1. **The wire carries data, the client derives presentation** (doctrine): there is NO new
   "sun direction" wire field. The client already receives `WorldClock`
   (`ticksElapsed`, `dayLengthTicks` — codec exists). Sun altitude/azimuth is a pure function
   `sunArc(timeOfDay01, arcParams)` computed client-side each frame. "Server-authoritative"
   means: driven by the server's clock, nothing else. Where the server ever needs the same
   answer later, the pure function is reusable — put it in a small, dependency-free module
   (e.g. `packages/content/src/sun_arc.ts` next to the def types, NOT in the client).
2. **Arc parameters are content, not code.** `AtmosphereDef` (`data/atmospheres/{id}.json`)
   carries: sun path (azimuth at dawn/dusk, max altitude, tilt), day/night color ramps for
   sun+ambient+sky/fog, mist params (height band, density curve vs time-of-day, color),
   god-ray params (intensity, near-field range, decay). Current in-code values (the fixed
   `SUN_DIR` in `packages/client/src/render/environment_lighting.ts`, existing fog/ambient
   literals) become the DEFAULT atmosphere's JSON values — zero look-change for the default
   world at noon is the acceptance test for the wiring commits.
3. **One sun owner.** `environment_lighting.ts` computes the frame's sun direction/color once
   and exposes it; every other consumer (shadow camera, god-rays, and the CURRENT water
   shader's duplicated sun constant at `water_renderer.ts` — see the "Matches SUN_DIR" comment)
   reads that owner. P5b will rebuild the water renderer; in THIS phase just thread the owner's
   uniform into the existing water material so the duplicated constant dies now.
   Note: the shadow-camera basis in `environment_lighting.ts` is precomputed from the fixed
   `SUN_DIR` — it must become per-frame (or per-sun-change) derived. That's a few vector ops;
   don't cache-invalidate cleverly, just recompute when the sun moves meaningfully.
4. **Selection via the render-context key** (I2, landed in P0d): atmosphere id comes off the
   networked biome/render-context, resolved through ContentService with a boot cross-check
   (unknown atmosphere id on a biome → server throws at load, same pattern as
   `startingSkills`/`mossBlend`). Verify what the P0d key actually looks like in code before
   building on it.
5. **GroundMistLayer** is a depth-reconstruction post pass (plan G7): sample scene depth,
   reconstruct world height, blend mist color in a height band. It composes with the existing
   HDR→bloom→EdgePass chain — read `edge_pass.ts`/`renderer.ts`'s pass wiring first and add the
   pass where depth is available. Mist parameters all come from the AtmosphereDef.
6. **God-rays are NEAR-FIELD ONLY in v1** (plan honesty note: the shadow frustum is ±60u;
   beyond it shafts would smear). Sample the real sun shadow map, gate by canopy, cap the
   ray-march range to the frustum, and document the near-field-only decision as a comment on
   the AtmosphereDef god-ray fields. Widening/cascading the frustum is explicitly OUT of scope.
7. **Time-of-day testability:** add a dev-only means to sample two clock phases in testplay
   (cleanest: a `game_config` dev knob or reading `WorldClock` and waiting is NOT acceptable —
   pick something deterministic, e.g. an admin/debug override the harness can set; keep it
   server-side and honest, no client-side clock fork).

## Suggested commit sequence (one commit each, adapt as the code dictates)

1. `content`: AtmosphereDef type + loader + boot cross-check + `data/atmospheres/default.json`
   carrying today's literals; `sun_arc.ts` pure function + unit test (dawn/noon/dusk/night
   angles, continuity across midnight).
2. `client`: environment_lighting consumes WorldClock + AtmosphereDef (sun dir/color, ambient,
   fog); shadow basis per-frame; water shader reads the shared sun uniform; DELETE `SUN_DIR`.
   Testplay: noon looks byte-identical-ish to before; dawn/dusk visibly different.
3. `client`: GroundMistLayer pass, params from AtmosphereDef.
4. `client`: canopy-gated near-field god-rays off the sun shadow map.
5. Close: update `VISUAL_DATAMODEL_PLAN.md` P5 (mark the G7 bullet landed), TICKETS.md T-311
   progress note.

## Do NOT

- Touch the water renderer beyond threading the sun uniform (P5b owns the rebuild).
- Add any new networked component or wire field.
- Ship a frustum widening/cascade.
- Leave the old `SUN_DIR` (or any of its mirror comments) alive anywhere — grep before closing.

## Verification

Standard bar from ENVIRONMENT.md. Additionally: testplay screenshots at ≥2 distinct
times of day, judged (sun angle, shadow direction, mist presence at the dawn sample);
EdgePass frame cost in the HUD (FRAME/POST ms) compared before/after god-rays+mist on the
same scene — call out anything >1–2 ms.
