# Combat-feel arc — T-296, T-292, T-297, T-298, T-299 (one coupled arc)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the five ticket bodies in `TICKETS.md`
(T-296, T-292, T-297, T-298, T-299) and the T-295 body (the `committed` flag they build on, done).
These five are TIGHTLY COUPLED — they all touch the ActionDef schema, the `weapon_trace` combat
resolver, `skeleton_evaluator`, and `game_config` — so execute them as one arc, smallest-first,
each ticket = one (or few) commits. Reconcile overlaps rather than duplicating.

**Depends / assumes landed (verify against HEAD):** T-295 (`committed` micro-cancel flag), T-320
(the just-landed controller camera + server soft aim-assist in the weapon_trace resolver — your
hitstop/telegraph work must compose with aim-assist, not fight it), T-287 (client-predicted facing).
The suite is green at HEAD; any red test you cause is yours.

Required code reading before edits (anchors drift — locate by symbol):
- `packages/tile-server/src/actions/resolvers/combat.ts` + `packages/tile-server/src/combat/hit_resolver.ts`
  (the weapon_trace sweep + where aim-assist now lives — hitstop hooks here)
- `packages/tile-server/src/components/action.ts` + the ActionDef schema in `@voxim/content`
  (phases windup/active/winddown, `committed`, `animation` block, gates)
- `packages/client/src/render/skeleton_evaluator.ts` (phase-driven clip selection; telegraph +
  i-frame visuals hook here — client derives from server-sent phase names + `ticksInPhase`)
- `packages/tile-server/src/handlers/health_hit_handler.ts` (installs hit_front/hit_back/
  stagger_light/stagger_heavy reactions — the reaction slot)
- `game_config.json` (combat ratios / partMultiplier live here)
- the BT nodes: `packages/tile-server/src/ai/bt/` + `RequestedActions` (T-234) for T-299 archetypes
- `data/actions/*.json`, `data/weapon_actions/*.json`, `data/npcs/*.json`, `data/behavior_trees/*.json`

## The five, smallest-first

### T-296 + T-292 (do together — T-296 IS the core of T-292)
T-296: add `ActionDef.hitStopTicks` (default 0). On a landed weapon_trace hit, freeze attacker+target
movement for N ticks via resolver-local scratch (reuse the rewind-tick scratch pattern — NO new
component), and emit a contact event the client maps to a sharp crack + brief freeze. Tune light=2,
heavy=4-5. T-292 (impact juice, the ticket CORRECTED the analysis — mechanics are NOT invisible;
reactions already exist and animate): so T-292 reduces to the FEEL layer on top — hitstop (T-296),
knockback emphasis (scale the existing knockback impulse on heavier hits), and client hit feedback
(the crack + a brief freeze + emphasis on the existing hit-spark/flash from T-310). Reconcile: land
`hitStopTicks` once, wire both the server freeze and the client contact-event feedback, and the
knockback-emphasis tuning, as T-296+T-292 together. Do not invent a second hitstop path.

### T-297 Telegraph lead clip
Add optional `ActionDef.animation.preWindup {clipId, ticks}`; bootstrap codec carries it;
`skeleton_evaluator` plays the pre-clip for `ticks` before the `windup:enter` clip (server already
sends phase names — the client derives the lead; no new wire field). Fast global pace → SHORT tells:
1-2 tick player, 3-5 tick enemy (heavy-thrower longest). Falls back cleanly when `preWindup` absent.

### T-298 Readable i-frames + recovery-exposure
`skeleton_evaluator` reads `dodge_roll`'s `ticksInPhase` to render a flash / bone-shine during the
i-frame window (client-only, existing server state). Add an optional 4th `recovery` phase to the
action schema; actions without it treat `winddown` as both (back-compat by DEFAULT, not a flag —
the schema default is "no recovery phase"). Author `recovery` on the heavy swings so the post-swing
exposed stance is a distinct, punishable clip.

### T-299 Two committed hostile archetypes + global rear multiplier (depends T-295 + T-297)
Author a **Heavy-Thrower** (one slow showcase enemy: a single uninterruptible telegraphed overhead
via `committed:true` + a new heavy weapon_action + a new `uninterruptible_active` gate so only
block/dodge/death stop it, big knockback) and a **Shield-Knight** (blocks until flanked, then one
committed heavy), using existing primitives + `RequestedActions` BT nodes. Add a global rear
`partMultiplier` (1.25-1.5) to `game_config` + a per-archetype gate exception. Pure content + a BT
variant + the one new gate (one handler file + `register()`). Compose with T-320's aim-assist and
T-297's telegraph (the thrower's long tell uses `preWindup`).

## Doctrine fences
- New gate (`uninterruptible_active`) = one handler file + one `register()` in the gate registry —
  never a `switch` in a system (registry-dispatch doctrine).
- Hitstop uses resolver-local scratch, NOT a new component (the ticket says so explicitly).
- No new wire fields: telegraph/i-frames/recovery all derive client-side from phase names +
  `ticksInPhase` the client already receives; hitstop's contact event rides the existing GameEvent
  catalog if one fits, else is a client-derived response to the existing hit event — do NOT mint a
  ComponentType or a new datagram field.
- `recovery` phase and `preWindup`/`hitStopTicks` are OPTIONAL schema fields defaulting to
  absent/0 — existing content is byte-unchanged in behaviour until authored.
- No isNpc branches for the archetypes — they are NpcTemplates + BT + content, differences in data.

## Suggested commit sequence
1. `tile-server+content`: `ActionDef.hitStopTicks` + weapon_trace freeze + client contact-event
   feedback + knockback emphasis (T-296+T-292). Unit-test the freeze (attacker+target movement-locked
   N ticks on hit, released after).
2. `client+content`: `animation.preWindup` schema + codec + skeleton_evaluator lead-clip (T-297).
3. `client+content`: i-frame flash from dodge_roll ticksInPhase + optional `recovery` phase +
   author recovery on heavy swings (T-298).
4. `tile-server+content`: `uninterruptible_active` gate + Heavy-Thrower + Shield-Knight NpcTemplates/
   weapon_actions/BT + global rear partMultiplier (T-299).
5. Close: mark T-292/296/297/298/299 done with hashes; T-300 (showcase tile) already placed enemies —
   note the new archetypes can now be dropped into it. Delete this prompt file in the closing commit.

## Verification
Standard bar (type-check per commit, full suite, bundle rebuild). Unit-test the server logic
(hitstop freeze window; the `uninterruptible_active` gate lets only block/dodge/death through;
rear partMultiplier applies from behind). The FEEL layer (telegraph readability, i-frame flash,
hitstop punch, archetype fights) is partly un-headless — testplay a spawned Heavy-Thrower + Shield-
Knight (debug_spawn_npc) and screenshot the telegraph windup + a hit freeze; correlate server logs
for the gate rejections and the hitstop freeze. List what stays a manual user feel-check.
