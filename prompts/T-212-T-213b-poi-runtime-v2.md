# T-212 v2 + T-213b — POI activities (boss/wave/action/puzzle) + trinket→stair runtime unlock

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md` (the primitives sections are the whole
game here: Action effects, Resource, Trigger, registry-dispatch), then BOTH ticket bodies in
`TICKETS.md` — T-212 (v1 landed, v2 remaining list) and T-213 (v1+v2 landed, T-213b remaining
list). They interlock: the unlock chain is the payoff of both.

**Depends / assumes landed:** nothing from the T-311 prompts — this is gameplay-side and can
run before/parallel to them. But re-verify the PoiSystem/Stair state on HEAD first; other
prompts may have landed and TICKETS.md is the truth.

## Goal

The four stubbed POI activities become real, and locked wilderness stairs actually unlock at
runtime when a player uses the matching trinket — heightmap ramp applied live, clients re-mesh,
the locked model swaps. Done means: a testplay run can walk into a wave POI and clear it, and
a scripted trinket-consume opens a stair that was impassable seconds before.

## Architecture decisions (already made)

1. **Registry-dispatch everywhere.** Each activity (`bossfight`, `wave`, `action`, `puzzle`)
   is a handler file in `packages/tile-server/src/poi/` + one `register()` call — the same
   registry v1's `encounter`/`exploration` use. No switch on activity kind anywhere.
2. **No bespoke timers/state machines — compose the primitives:**
   - `wave`: inter-wave delay = a Resource (`data/resources/wave_timer.json`-style def) on the
     POI entity whose terminal threshold fires a `spawn_next_wave` effect. Wave index lives in
     a server-only component (`networked: false`, inline codec). Cleared-on-full-clear:
     subscribe the wave state to `entity_died` via the Trigger primitive? NO — triggers bind
     to the dying entity's roles; the cleaner v1: spawned wave NPCs carry a server-only
     `WaveMember {poiEntityId}` component; a small system (or the existing PoiSystem tick)
     counts living members and advances. Keep it inside PoiSystem's tick — no new System
     unless PoiSystem is already bloated (read it first).
   - `bossfight`: boss prefab spawn at centroid; **lockEntry via blocker entities, not terrain
     edits** — spawn gate-prop entities with collision at the arena entrances when engaged,
     destroy them when the boss dies. Terrain edits for a transient state would fight the
     stair/dig delta machinery for no gain. Boss death → unlock: a content TriggerDef on
     `entity_died` (as: victim, condition: has-boss-tag) firing a `clear_arena_lock` effect is
     the doctrine-clean wiring. Adds-table on phase thresholds: Resource on the boss's health?
     No — health thresholds: use the existing resource/threshold vocabulary ONLY if health is
     already a Resource; otherwise fire adds from the `damage_taken` trigger with a
     health-fraction condition (check what gate conditions exist; extend the condition
     vocabulary via its registry if needed — one handler file).
   - `action`: interactable prefab at centroid. The client interact path EXISTS
     (`ACTION_INTERACT` bit + `interactSlot` in the InputDatagram; `interaction_system.ts`
     client-side) — read how existing interactables (workstations, traders) register their
     interaction handling server-side and follow that pattern exactly. If T-100-style
     hover/click genuinely isn't sufficient for pedestal-use, implement the minimal missing
     piece server-side rather than a parallel path.
   - `puzzle`: reserve `data/puzzles/` as a content category with a boot cross-check, and ship
     ONE template (lever sequence: N lever entities, content-defined order, wrong lever
     resets, completion fires the POI's effect list). Puzzle rules dispatch by template `kind`
     through — you guessed it — a registry.
3. **T-213b unlock chain, end to end:**
   - Trinket = an item prefab whose use fires an `unlock_stair` EFFECT through the one
     action-effect registry (the consume action's `effects` on `active:enter`, exactly like
     `health` on food — read an existing consume ActionDef first). The effect resolver looks
     up the `Stair` entity matching the trinket (`Stair.trinketId` — the component already
     carries everything: `{stairId, toZoneId, fromZoneId, trinketId, anchorXY, unlocked}`).
   - Server flip: set `Stair.unlocked`, apply the ramp via the SAME `applyStairUnlock` helper
     the boot path uses (atlas package; tile-server already imports it — since T-315 C1 it
     takes `wallHeight` from GenParams and B8 made the wire ramp fields authoritative — pass
     the real values, no defaults), swap `ModelRef` to the found-stair model via `world.set`.
   - **Broadcast rides the existing delta pipeline**: Heightmap/OpenMask are networked chunk
     components — mutate them through the changeset (`world.mutate`) and the per-tick delta
     build ships them to AoI clients automatically. Do NOT invent a StairUnlocked wire
     message for the terrain; at most publish a server EventBus event for SFX/prints later.
   - Client re-mesh on chunk-grid deltas: the pattern exists for terrain dig edits — find how
     `game.ts`/renderer react to a Heightmap delta today (TerrainDig path) and make sure the
     stair chunks re-mesh through the same code, not a copy.
4. **Boot cross-checks:** every content id this touches (spawn-table prefab ids, boss/adds
   prefab ids, trinket ids on stairs, puzzle template ids, gate-prop prefab) gets the standard
   throw-at-boot cross-check. The T-315 A6 commit shows the house pattern in `server.ts`.
5. **Non-respawning stays v1 behaviour** for encounter/exploration; bossfight/wave reset
   policy: fired-once per boot is acceptable v1 — note it in the ticket, don't build respawn
   scheduling.

## Suggested commit sequence

1. `tile-server+content`: wave handler (+ wave_timer resource def + WaveMember) with one
   authored wave POI in content; testplay it.
2. `tile-server+content`: bossfight handler (blocker entities + entity_died unlock trigger +
   adds via damage_taken); one boss POI.
3. `tile-server+content+client(if needed)`: action handler through the existing interact path.
4. `tile-server+content`: puzzle category + lever-sequence template + handler.
5. `tile-server+content`: T-213b unlock chain (effect resolver + live applyStairUnlock +
   ModelRef swap + delta-driven client re-mesh verified in testplay: walk against the locked
   wall, consume trinket, walk up).
6. Per-biome stair models ONLY if trivial content drops remain in budget — otherwise leave the
   ticket note as-is.
7. Close: T-212 → done (v2 list satisfied), T-213 → done (T-213b satisfied), commit hashes in.

## Do NOT

- Add an `isBoss`/`isNpc` branch to any shared system — differences live in component data.
- Invent new wire messages for things the component-delta pipeline already carries.
- Hand-roll a countdown (`ticksLeft--`) anywhere — that's what Resources are for.
- Leave any activity stubbed-but-silent: if you cut one for budget, say so in TICKETS.md.

## Verification

Standard bar. Testplay each activity end-to-end (the STEPS env can drive movement + interact
keys; correlate server logs for spawn/clear/unlock lines). The unlock test must show the
BEFORE (blocked) and AFTER (walkable ramp + model swap) in two screenshots. Full suite green;
add server tests where the seams are cheap to pin (wave advancement on member death, unlock
flips openMask cells, trinket→stair matching).
