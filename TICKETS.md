# Voxim2 — Engineering Tickets

Each ticket is a self-contained unit of engineering work. Tickets are grouped by domain.
**This file holds only OPEN work.** Closed tickets — done, obsolete, superseded, deferred —
are archived in [CHANGELOG.md](CHANGELOG.md), which doubles as the project changelog.

**Format:**
```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done|obsolete   [Commit: <hash>]

What needs to be built and what "done" looks like.
```

Effort: **S** < half a day · **M** half–two days · **L** multi-day or architectural

---

## Combat

### T-323 · Hits don't connect — the hitbox is the skeleton, not the body
Effort: M   Status: done   Commit: dd71a68   (user, live play 2026-07-07)

Swings visibly pass through enemies without registering. The mechanism is mostly right — capsules
DO follow the live animation pose (`HitboxSystem` → `evaluateAnimationLayers` → `solveSkeleton` →
`applyHitboxTemplate`), and biped capsule radii DO come from the body recipe — but two concrete
gaps make the hittable volume much thinner than the drawn body:

1. **Non-biped skeletons have no `bodyRecipe`.** `data/skeletons/wolf.json` (11 bones) carries none,
   so `deriveSkeletalCapsules` falls through to the `BONE_RADIUS` table — which is keyed by BIPED
   bone ids (`torso_upper`, `upper_arm_l`, …). A wolf's bones don't match a single key, so every one
   of them gets `DEFAULT_BONE_RADIUS = 0.20` → a stick-figure hitbox inside a fat visible wolf.
   Wolves are the most-fought enemy; this alone explains most missed hits.
2. **`tapered_box` parts get a cylinder capsule.** The recipe's box parts render a BOX of half-width
   `radiusOrWidthTop/Bot`, but `bodyPartCapsule` returns a capsule of radius `max(top,bot)` — the
   box's corners stand ~√2 outside the capsule, so edge/corner hits on the visible silhouette miss.

Fix direction: give every skeleton a real body volume the hitbox can read (a `bodyRecipe` for wolf +
any future archetype, or a per-skeleton radius table — a *shared* source, not a second one), and make
the capsule cover the drawn box (inscribe vs circumscribe is a decision: circumscribing the box costs
generosity, which is probably right for feel). Verify with a LIVE probe, not just unit tests: use the
new T-322 swing-sweep debugger + a scene probe comparing the swept blade capsule against the target's
live `BodyPartVolume` capsules in world space, and find where they actually miss.
Done when: swinging at the visible body of a wolf AND a humanoid connects reliably, verified live.

**Closing notes (lane/t323-hitbox):** re-verified both diagnoses against the actual code before
fixing — #2 held exactly as described; #1 did not, in a way worth recording so nobody re-derives it:
`data/models/wolf.json` HAS 11 subObjects (not zero), so `deriveHitboxTemplate` never reaches
`deriveSkeletalCapsules`/`BONE_RADIUS` for wolf at all. The real bug was narrower and worse: 9 of
those 11 subObjects (tail + all 4 leg segments) were authored `"hitbox": false` — they render but had
**zero** hittable volume; only body/head had a capsule. Fixed by dropping the opt-outs so every
visible sub-object gets a capsule from its own voxel AABB — the same mechanism body/head already used
(one shared source, no new table). Deliberately did NOT add a `bodyRecipe` to the wolf skeleton:
wolf's bones carry no `restRot` (unlike biped's Mixamo-derived bind pose), so `bodyPartCapsule()`'s
assumed "local +Y = bone axis" direction is false for wolf — a recipe-driven capsule would point the
wrong way (e.g. straight up) without also reworking the bind pose, which risks the live render/anim
look and needs verification this lane couldn't do (no live stack). Fix #2 (tapered_box circumscribe)
landed as literally described. Live verification (swing at a wolf + a humanoid, confirm hits land) is
deferred to post-merge per the lane's scope — see postMergeChecklist in the closing commit report.

## Stealth

## Lore & Skills

### T-328 · Externalise Lore UI — write a learned fragment to a blank tome
Effort: S   Status: todo

Found while building T-072 (heir-ritual UI): `CommandType.Internalise` (read a
tome, T-020) now has a client entry point (InventoryPanel's "Read" action),
but `CommandType.Externalise` (write a learned Lore fragment to a blank tome,
T-019) still has none — the server handler has been sitting dead since it
shipped. This is the OTHER half of how tomes get into the family library in
the first place (a living player banks fragments for the next heir to read),
distinct from the heir-ritual flow T-072 covers.
Done when: a player with a learned fragment and a blank_tome in their burden
can pick a fragment (LoreLoadout has no UI surface for `learnedFragmentIds`
today either — that selector is part of this ticket) and write it, producing
a filled tome they can carry to the library.

## Crafting & Economy

### T-036 · Blueprint as saveable/storable Lore item
Effort: M   Status: todo

A blueprint (saved after designing) becomes a `blueprint_tome` — a Lore item storable in the
family library, tradeable, and loadable by NPCs via a `build(blueprint_element)` job.
Done when: a designed blueprint can be saved as a tome item; another character or NPC can load
and execute it.

### T-037 · NPC builder job assignment to blueprint element
Effort: S   Status: todo

Add `build_element` job type to the job board. NPCs with hammer + required materials in inventory
can execute build jobs, incrementally constructing blueprint elements.
Done when: assigning a build job to an NPC causes it to navigate to the blueprint and construct.

---

## NPC & Society

### T-042 · NPC specialisation matching to job requirements
Effort: M   Status: needs-design   (original Lore-on-NPC premise is dead — T-260b removed NPC LoreLoadout)

Original premise: jobs carry a `skillRequirement` Lore fragment; an NPC pulling a job checks its
own `learnedFragmentIds`. That mechanism no longer exists — NPCs carry **no LoreLoadout** since
T-260b (`spawner.ts:219`: "No LoreLoadout for NPCs"), so there is nothing to match a fragment
requirement against. There is no `skillRequirement` field on JobBoard jobs today either.

The goal still stands (a forging job should only be taken by an NPC that can smith), but the
matching key must be redesigned around what NPCs actually carry: their `NpcTemplate`
(archetype / `npcType`, and any future per-archetype skill tags). Concrete shape to decide:
add an optional `requiredArchetype` (or a small `skills: string[]` tag set on the template) to
JobBoard pending jobs; when an `AssignedJobBoard` NPC pulls a job, skip ones whose requirement
its template doesn't satisfy. Needs the NPC job-pull-from-board path confirmed/wired first
(JobBoard + AssignedJobBoard components exist; the admin endpoint appends jobs, but verify an
NPC actually dequeues from its assigned board).

Done when: a forging job tagged for smiths is only taken by NPCs whose archetype/skill tags
satisfy it; non-matching NPCs skip to a lower-priority job.

## World & Macro Simulation

### T-049 · Macro simulation — trade agreement + resource exchange
Effort: L   Status: todo

When two cities have an active trade agreement, a periodic job dispatches caravans (T-048)
between them. On arrival, goods are transferred between city inventories. Agreement can lapse
if a caravan is raided N times.
Done when: two cities with an agreement exchange goods via caravans; raiding disrupts the flow.

### T-050 · Connect LLM to city agent interface (T-046)
Effort: M   Status: todo

Wire the real LLM API (Anthropic Claude) to the city agent interface defined in T-046.
Context packet assembly, call trigger from world event bus, response parsing, tool execution.
Rate-limit: one call per city per event; no tick-driven calls.
Done when: a live city reacts to a significant event with LLM-generated tool calls.

## Gateway & Multi-tile

## World Generation

### T-058 · Road network generation
Effort: M   Status: todo

Connect city seed positions with roads following terrain of least resistance. Road tiles get a
flatten pass during tile generation. Gate positions on road tiles align with road path.
Done when: roads connect city seeds on the world map; road tiles carry a road flag.

### T-059 · NPC city seeding on world map
Effort: M   Status: todo

Select city locations from world map (flat terrain, near water, resource diversity). Create a
`CityState` (T-044) for each. Seed each with a founding NPC and a starting workbench.
Done when: world generation produces N cities at valid locations with initial state files.

### T-215..T-224 · Scene graph as a central engine system
Effort: XL (multi-ticket arc)   Status: planned

See [`SCENE_GRAPH_PLAN.md`](SCENE_GRAPH_PLAN.md) at the repo root for the
full design + migration plan. Summary:

`@voxim/engine` grows a scene-graph primitive (parent/child links via a
networked `Parent` component) that sits co-equal with the flat ECS.
Nodes are entities; prefabs produce subtrees of entities; the same
engine APIs work in atlas (bake), tile-server (runtime), coordinator
(world graph), and client (rendering). What differs between services
is *which systems they install*, not which scene representation they
use.

Migration phases (each its own ticket):

  - T-215 — DONE (inert). engine/scene.ts: Parent (networked,
    engine-owned inline codec, wire id 49 reserved in protocol) +
    Transform/composeTransform; World gains setParent/getParent/
    getChildren/descendants/destroySubtree/worldTransform/localTransform
    (O(1) child index, changeset-deferred subtree teardown, cycle-safe
    transform compose). Registered in NETWORKED_DEFS. 8 engine tests +
    regression green; bake byte-identical. Nothing consumes it yet.
  - T-216 — DONE. engine/src/prefab.ts owns the generic spawn walk;
    concretes injected via PrefabSpawnContext (getPrefab/
    resolveComponent/compoundInstaller/preInstall). tile-server
    spawnPrefab keeps its signature as a thin wrapper — call sites
    unchanged, behaviour identical. 70 tests green; bake byte-identical.
  - T-217 — DONE. Prefab.children (ChildPrefabRef{prefabId, local?}) +
    engine spawnPrefab subtree recursion (spawn child → setParent →
    ctx.placeChild) + ChildSpawn structural type + placeChild ctx hook
    (tile-server writes child Position from local; scale deferred). Loader
    validates child shape per-prefab + a cross-ref pass rejecting
    unknown/abstract child ids. 3 engine prefab tests + 96 content/engine
    green; bake byte-identical (no prefab uses children yet). Bootstrap
    rides the JSON blob — no codec bump.
  - T-218 — DONE. First real `children` consumer. PoiBase.scenePrefabId
    (TS+valibot) → prefabs/poi/signal_pyre_scene.json (campfire parent w/
    lightEmitter+poiTrigger + 4 torch_placed children). placePoiTriggers
    spawns the scene prefab via spawnPrefab (recursing the subtree) and
    patches runtime poiInstanceId/poiDefId onto the walked trigger; POIs
    w/o a scene prefab keep the bare-entity fallback. T-217 placeChild
    hook refined to also pass parentId — service bakes child *world*
    Position off the parent (static subtrees; live compose is T-223). 2
    poi_spawner tests + 103 content/engine/poi green; bake byte-identical.
  - T-219 — skeletal bones as scene-graph entities
  - T-220 — equipment attachment via scene-graph
  - T-221 — static prop sub-objects as scene-graph children
  - T-222 — coordinator world-scale scene graph
  - T-223 — client render-scope scene graph
  - T-224 — inspector / editor tooling against any World

The T-214 IR + reducer + rasterizer split work is the substrate this
builds on. Snapshot determinism stays the invariant across every
phase.

## Client Rebuild

The full plan lives in `CLIENT_REBUILD_PLAN.md` (grounded in an 8-subsystem audit).
Spine: one **voxel pipeline** (`VoxelAtom` → `bakeVoxels` → `buildVoxelMaterial` →
InstancePool, fed by models/terrain/placement/ghost), one **palette authority**
(`palette/world.json` snapping every material at load), and one **scene owner**
(renderer god-class → `EntityMeshRegistry`). Each phase deletes the old path with
the new (replace, don't accrete). Phases are ordered cheapest-identity-win first.

## Animation & Render Verification

## Client / Controls, Feel & Render Polish

### T-331 · Some terrain chunks bake with WHITE vertex colours (material lookup lost at bake time)
Effort: M   Status: todo   (found during the T-313 live-verify, 2026-07-07)

A rectangular patch of terrain renders pure WHITE with hard voxel edges (reproduced at ~(300,306)-(302,316)
in standard-seed7; the player's shadow falls across it, so it is lit geometry, not a light bug).

Evidence already gathered — do NOT re-derive, verify then fix:
- Independent of T-313's new shadow cascade: the patch is identical with the cascade pass disabled (A/B'd),
  and the cascade itself demonstrably works (far field correctly darkens).
- Independent of time of day: identical at hour 7 and hour 12, so it is not the dawn sky × `wet_reflect`
  blowout (that class of bug was fixed for water in 243ce9c).
- The CONTENT is correct: probing the ContentService at those cells returns path/dirt/grass with correct
  colours (e.g. dirt = 0x3D2A20).
- The RENDER is not: a scene probe of the terrain meshes shows `vertexColors: true` on all of them, but
  `material.color` is `#ffffff` on some and `#7c6440` on others. With vertex colours ON, `material.color`
  MULTIPLIES them — so a white base means "show the vertex colours as-is", and the patch being white means
  the VERTEX COLOURS THEMSELVES are white: the voxel bake failed to resolve the material colour for that
  chunk and fell back to white.
- Prime suspect: a RACE — the chunk was baked before the material lookup was ready (the same bug class as the
  T-311-era "all terrain rendered fallback grey", where `ContentCache.getMaterialSync` didn't hold ground
  materials). Since T-315 E1 the ContentCache is a thin read-through over the bootstrap ContentService, so
  check the ORDER: can a chunk-ready hook fire (and bake) before the bootstrap blob has hydrated?
- Second, independent smell: the inconsistent `material.color` across terrain meshes (`#ffffff` vs `#7c6440`)
  is itself suspicious with `vertexColors: true` — a non-white base double-tints. Decide which is correct and
  make it uniform.

Done when: no chunk ever bakes with fallback colours (make the failure LOUD — a missing material at bake time
should throw or warn, never silently paint white), the white patch is gone, and terrain material.color is
consistent across meshes.


### T-328 · Mouse turns the CHARACTER, the camera rides along (supersedes T-320's facing/camera model)
Effort: M   Status: done   Commit: fb4f8b9   (user, 2026-07-07)

Landed: facing is mouse-driven (`IntentTranslator.applyLookDelta` ->
`facingFromLook`, wrapped), camera yaw is a rigid derived read
(`CameraRig.setYaw`, no accumulator, no damping), and movement is
transformed by the FACING basis so A/D strafe and S back-pedals while
still facing the target. Pitch stays camera-only, unchanged. No wire
change. Unit-tested (facing wrap/continuity, yaw-tracks-facing exactly,
A-press-is-a-strafe-not-a-turn) + a `cameraProbe.facing()` headless hook
alongside the existing yaw()/pitch(). The raw pointer-lock FEEL (mouse
turning the character, circling a target) is the user's manual live-play
check — un-headless, same as T-320/T-324's pointer-lock work.

Invert T-320's rotation ownership. Today: mouse-X drives the CAMERA yaw directly, and facing is
derived from the movement direction. The user wants: **mouse-X rotates the PLAYER'S FACING, and the
camera follows that facing.** Consequences, all intended:

- **Facing is mouse-driven, not movement-derived.** `facing += dx × sensitivity` (wrapped), accumulated
  from the same pointer-locked raw deltas T-324/T-324b already deliver. DELETE the movement-direction
  facing derivation T-320 introduced (replace, don't flag).
- **Camera yaw is DERIVED from facing** — the camera sits behind the character's heading. Rigid coupling
  by default (the user asked for the camera to rotate *with* the facing, and T-324 just proved that any
  damping reads as sluggish); if a slight lag is wanted later it becomes a content knob, not a default.
  The pitch pan (mouse-Y, clamped band) is unchanged and stays camera-only.
- **Movement becomes facing-relative, which is the real win:** W = forward along facing, S = back-pedal,
  A/D = STRAFE while still facing the target. Today you cannot circle an enemy while looking at it —
  that is the bug this fixes, and it is what makes the combat model (aim-assist, blocks, dodges) work.
  The locomotion animation must read the movement vector RELATIVE to facing (strafe/backpedal poses
  become genuinely meaningful — coordinate with T-308's strafe/turn lean).
- Server-side soft aim-assist (T-320) is unchanged and composes: your facing is now literally where you
  point, so the swing already starts aimed; aim-assist only snaps it onto the best in-cone target.
- No wire change: `facing` already rides the InputDatagram. Camera stays pure client presentation.

Done when: moving the mouse turns the character (and the camera behind it), A/D strafes around a target
while still facing it, S back-pedals, and swinging goes where the character points — verified live.

### T-324 · Camera feels sluggish and snaps ~90° at a certain rotation
Effort: M   Status: done   Commit: 36112c8   (user, live play 2026-07-07 — T-320 regression)

Root-caused empirically, not by feel: a dense 5-turn `cameraProbe.yaw()` sweep (both offline and
against the live served bundle, both directions, several per-event pixel magnitudes) found ZERO
discontinuities — disproving all three prime suspects below (`camera_rig.ts`'s yaw is a private
field with exactly one mutation site, `applyLookDelta`, which already sums every pointer-lock
event directly with no dt-scaling or damping). The real, fixable defect for both symptoms was
that `requestPointerLock()` never asked for raw input — Chromium applies its OS-level pointer-
acceleration/ballistics curve to `movementX/Y` by default, which compresses slow deliberate turns
(sluggish) and can emit an anomalous single-event jump when the curve recalibrates (the snap).
Fixed by requesting `{ unadjustedMovement: true }` with a `NotSupportedError` fallback to a plain
lock. Yaw continuity is now pinned as a regression test (`camera_rig.test.ts`); the OS-curve fix
itself isn't headless-testable (pointer lock can't be driven headless at all — real hardware feel
is a manual check).

Two distinct defects in the new free-look camera (T-320):
- **Sluggish** — rotation lags the hand even after the sensitivity bump (0.0022 → 0.007). Suspect a
  residual smoothing/damped step surviving from T-317's chase controller, or the yaw only being
  applied once per render frame while pointer-lock `movementX` events accumulate faster (deltas being
  dropped/overwritten rather than summed), or a dt-scaling that shouldn't be there for a *direct*
  (non-damped) rotation.
- **~90° snap at a certain rotation** — smells like a wrap/quadrant bug: an `atan2`/shortest-arc wrap,
  a yaw normalisation crossing ±π, or the pitch clamp interacting with the look-at basis and flipping
  the up-vector. Reproduce by rotating slowly through a full circle and logging `cameraProbe.yaw()`
  continuously — the snap will show as a discontinuity at a specific angle.
Done when: a full 360° sweep is continuous (no jump), rotation tracks the hand 1:1 with no damping,
and both are verified with the `cameraProbe` hook (yaw sampled across a slow sweep) — not by feel alone.

### T-325 · Input rework — UI clicks also drive the camera
Effort: M   Status: done   Commit: 0c6d8cb   (user, live play 2026-07-07 — T-320 gap)

Landed the real routing pass: `input_mode.ts` is one computed `InputMode` ("gameplay" | "ui" |
"build") derived from `modeState` + `uiState.openPanels` + `uiState.radialMenu`, with zero writers
(a pure derivation can't desync from the state it answers about). `PointerLockController` and
`IntentTranslator` both read it instead of re-deriving their own partial answer. Found and closed
two concrete gaps: (1) the build radial menu is a plain `uiState.radialMenu` patch, never added to
`openPanels`, so the old `worldOwnsCursor()` check didn't know about it; (2) `exitPointerLock()` is
async, so a panel opening between mouse events used to leave a window where in-flight deltas still
reached the camera before the browser caught up — fixed by gating `_onMove` on the mode signal
itself, not just the DOM `_locked` mirror. Held-button bookkeeping (`rmbDown`, `holdState.lmb`)
still clears unconditionally on release so a panel opening mid-hold can't leak a stuck block bit or
a phantom charge bar. Verified live with real pointer-lock via Playwright's CDP mouse (trusted
input, unlike page.evaluate()-constructed events): opening Inventory/Stats releases the lock with
zero yaw change, aggressive click+drag+move while a panel is open produces yaw delta 0, closing +
re-clicking restores control (yaw moves again) — see T-324/T-325 arc notes for the numbers.

Clicking a UI element both actuates the UI *and* rotates/steers the camera: pointer-lock and the DOM
UI are fighting over the same mouse. T-320 released the lock on panel-open, but the guard is
incomplete — clicks land on the canvas (or the lock re-engages) while the UI is up. This needs a real
input-routing pass, not another patch: ONE owner decides, per frame, whether the mouse belongs to
gameplay (pointer-locked camera) or to the UI, and the other side sees nothing. Consider an explicit
input-mode state (gameplay / ui / build) driven off the UI modal stack, with pointer-lock engaged only
in `gameplay`, and canvas mouse handlers bailing out in any other mode.
Done when: with any panel open, no mouse movement or click reaches the camera; closing it restores
camera control; build mode keeps its cursor; and the transitions are verified per panel.

Born from the 2026-06-24 client-overhaul analysis (7-reader sweep over the post-rebuild
client). Root finding: **facing is never predicted client-side** — the local body's
`rotation.y` is written only from networked `state.facing` (`entity_mesh.ts:624`); the
renderer overrides the local player's *position* with prediction (`renderer.ts:879`) but
never *rotation*. The cursor facing computed every frame in `IntentTranslator.facing`
round-trips the server before the body turns. That single gap is the spine of BOTH the
controls-feel complaint and the "attacks go random directions" complaint (the swing trail
sweeps from a stale orientation). The "grayscale" look is the palette's own near-grey
atmosphere (noon `sky` = `fog` = `#9aa39e`, ~5% saturation) plus a hardcoded hemisphere
ground color and an imperceptible ±6% split-tone tint — NOT a blocked T-286 boost (the
palette IS the runtime authority via `applyPalette`). Chosen directions: controls →
camera-relative movement + cursor-aim (Diablo/PoE); color → deutlich bunter.

## Symphony — Feel, Content & Voxel Language

### T-326 · Warped voxels everywhere — one organic-disturbance axis, applied consistently
Effort: M   Status: done   Commit: eb4883b, 97c4912   (user, live play 2026-07-07)

The randomized/warped voxel surface we now have (terrain relief, `vertexDisp`, the stacked-stone
language) should be used **consistently across every voxel class we can apply it to** — walls, props,
structures, equipment, characters — **always with an explicit "how warped is this" factor**, not
ad-hoc per subsystem. T-301 already decided the principle ("organic everywhere, but silhouette
proportions stay anchored"); this ticket makes it real and uniform: one disturbance/warp axis, one
knob per material/class (`generatorPreferences` and/or `render.relief` are the existing homes), one
shared application point in the bake so a wall, a sword and a shoulder all read as the same physical
world. Audit where warp is currently applied vs. skipped (terrain: yes; scatter/props/characters:
partly; walls/built structures: no) and close the gaps.
Done when: every voxel-baked class reads its warp amplitude from content, the factor is authorable
per material/class, and a wall, a prop and a character in one screenshot share the same surface idiom.

**How it landed:** picked `MaterialDef.render.relief.dispMag` as the ONE authoritative home
(already terrain's field; `generatorPreferences` is generator hints — density/thickness/layerable/
emission — not an amplitude, documented as such in `DESIGN_LANGUAGE.md` §2/§5 so it can't grow into
a second warp path). Wired the same field through every other `bakeVoxels` call site that was
previously stuck on the internal hardcoded per-voxel default: `bakeSubModel`/`buildSubModelGeo`
gained a `dispMag` parameter (previously had NO way to receive one at all — this was the concrete
"walls/built structures: no" gap, since ruin walls/resource nodes/ground items/built structures all
render as static instanced props through this path), `entity_mesh.ts`'s `buildMeshesFromAtoms`
(characters, equipment, dynamic props — every skeleton/armor/held-item mesh funnels through this
one function) and `scatter_renderer.ts` now resolve `matDef.render.relief.dispMag` instead of
passing `undefined`. Terrain's own path (`renderer.ts`) already read it; unchanged apart from a
doc comment. Absent `dispMag` ⇒ each call site's pre-existing default, byte-identical for every
material that hasn't authored one (none do yet — this ticket lands the mechanism + schema
documentation, not new art-direction numbers, since no live-stack verification was available in
this lane; see the lane's closing report for the exact live-stack proof procedure). Decals and the
build-ghost placement preview are deliberately out of scope (decals are non-structural/ephemeral
per `DESIGN_LANGUAGE.md` §3; the ghost has no resolvable `MaterialDef` — `GHOST_MAT_ID` is a
sentinel, not a content material). Verified in-lane only (type-check green + `deno test -A
packages/`, 826 green, incl. 3 new `bakeSubModel` dispMag tests) — no live-stack testplay per lane
rules.

### T-327 · Combat-feel pipeline — windup / active / winddown / dodge / block / hitstop tuning loop
Effort: L   Status: done   Commits: server da90070 · client 5dc4558 · devtools 81d73fd
(design settled 2026-07-07: **A + B** below — live tuning is the core, the
Studio timeline is the precision complement. Feel is only findable by feeling; the panel is for seeing
exactly what you just felt.)

**A · Live tuning against a running fight (the core).**
- A **training dummy**: `DebugSpawnDummy` — an NPC that takes hits, shows its state, never dies
  (auto-heals after N ticks) and optionally attacks on a fixed loop so blocks/dodges/i-frames can be
  practised against a predictable telegraph.
- A dev **tuning panel** (client, dev-only) exposing the live knobs of the action you're actually
  swinging: phase ticks (windup / active / winddown / recovery), `hitStopTicks`, the dodge i-frame
  window, the block window, knockback scale, and the aim-assist cone/range. Editing a knob takes
  effect on the NEXT action — no restart, no reload.
- Mechanism: ActionDefs live server-side and drive the dispatcher, so the panel sends a
  `DebugSetActionParam { actionId, field, value }` command; the server patches its in-memory
  ContentService ActionDef. Follow the existing debug-command surface exactly (`debug_commands.ts` +
  CommandType + the client `_handleUIAction` case — the same pattern `DebugKillEntity`/`DebugSetTime`
  use). Nothing about this touches production content until you press save.
- **Save back to content**: a button that writes the tuned values into `data/actions/*.json` (reuse
  the devtools `serve_devtools.ts` POST/`WRITABLE_PREFIXES` path, or an admin endpoint) so a good feel
  becomes content, not a lost session.

**B · Studio "Phases" timeline panel (the precision complement).**
A tab beside T-322's Sweep tab in the Studio animation editor: pick an ActionDef, see its phase
timeline in TICKS as bars — windup / active / winddown / recovery edges, the hitbox-live window, the
i-frame and block windows, the hitstop freeze — scrubbable, with the same action's blade sweep (T-322)
visible alongside. T-322 shows the swing's GEOMETRY; this shows its TIME. Together they are the
authoring pair.

Done when: you can spawn a dummy, swing at it, change a phase tick / i-frame / hitstop live, feel the
difference on the very next swing, and save the values you liked into content — and the Studio
timeline shows you exactly which windows you just moved.
Unblocks: T-297/T-298/T-299's numbers are placeholders until this exists.

**LANDED (lane/t327-feelpipe, in-lane verified — live-stack pass still needed, see below):**
A: `DebugSpawnDummy` (`training_dummy`/`training_dummy_attacker` NPCs+prefabs+BTs; the attacker
swings every 40 ticks via the new generic `check_tick_interval` BT node). "Never dies" is a Health
floor at 1 in `health_hit_handler.ts` for any `TrainingDummy`-tagged entity (has to be at the
damage-write site — DeathSystem's composed-lethal sweep independently kills on committed
`Health.current <= 0`); `TrainingDummySystem` heals it back to full `healDelayTicks` after the last
hit. `DebugSetActionParam { actionId, field, value }` patches a numeric leaf of the live
ContentService in place (`actionId="$config"` reaches GameConfig for knockback/aim-assist/parry-window
— those aren't per-ActionDef) — dispatcher re-fetches `content.actions.get()` every tick so it's live
next-action, no restart. Client `DebugPanel` gained "Training dummy" + "Action tuning" sections.
Save-back is `POST /debug/save-action` on the admin HTTP server (same origin as the client, devMode-
gated) rather than the devtools static server, so it doesn't depend on a second process being up.
B: Studio "Phases" tab beside Sweep — phase bars in ticks + i-frame/block/hitbox-live windows derived
generically from the def's `effects` (`phase_windows.ts`, no hardcoded phase names) + the blade sweep
alongside via Sweep's own overlay primitives, manual weapon-action picker when nothing's pinned.
Verification done: type-check matrix, `deno test -A packages/` (839 passed), `deno task bundle` +
`deno task build-studio`. NOT done (no live stack in this lane): actually spawning a dummy, editing a
knob mid-fight, and confirming the Studio timeline against a live swing — see postMergeChecklist.

The phase timings (windup / active / winddown / the new `recovery`), dodge i-frames, block windows,
hitstop and knockback all need real iteration — and there is no loop for iterating them. Today a
tuning change means: edit JSON → restart tile → reload client → fight something → guess. That is too
slow to find feel.

What's needed is an authoring/tuning PIPELINE, in the spirit of the Swing Inspector / the new T-322
sweep debugger, but for TIMING and RESPONSE rather than geometry. Design open — to decide together:
what the loop looks like (live-tunable knobs against a running fight? a Studio panel that scrubs an
action's phase timeline against a dummy target? recorded playback with a frame-by-frame scrubber?),
what it must expose (phase edges, i-frame/block windows, hitstop freeze, the attacker/target state at
every tick), and how tuned values get back into content without a restart.
Blocks: T-297/T-298/T-299's numbers are placeholders until this exists — we can't tune what we can't see.

The 2026-06-24 vision arc: the mechanics exist but don't FEEL good yet — they must become a
SYMPHONY, made accessible through FEEL not TELL. Verified reality: the engine + all four primitives
+ combat consequences (parry/poise/stagger/block/knockback/counter) are DONE and networked; the gap
is FEEL plumbing + CONTENT + a written voxel design language, not new systems. User design
decisions: combat pace = **fast everywhere** (Vermintide frequency, short telegraphs); commitment =
**micro-cancel** (first windup tick bailable, then locked); aesthetic = **organic everywhere**
(vertexDisp across all classes, but silhouette proportions anchored to the human scale so figures
still read). Sequenced as 3 batches; lead with the feel core so the symphony is testable soonest.
See [[project_client_overhaul]] memory + the workflow design framework.

## Procedural Animation

The Overgrowth/David Rosen direction: a few authored anchors + procedural everything-between + IK,
over one substrate (the skeleton). Poses, IK, and body attachments all hang off the same bones, so
orthogonal behaviours (crouch + strafe + swing) compose instead of needing a combinatorial clip
matrix. See `swing_pose.ts` (the shared producer) and the Swing Inspector (the authoring tool).

### T-308 · Procedural pose catalogue (locomotion poses + IK + secondary motion)
Effort: L   Status: done   Commit: 6a5c072

**GAIT DESIGN SETTLED (user, 2026-07-07): option (b) — LAYERED, and the locomotion itself is built
the Overgrowth way: a few authored KEY POSES, interpolated, on layers — not baked clips.**
(David Rosen, GDC 2014 — see the memory note; the repo's `swing_pose.ts` producers are already this
shape.) Concretely:

1. **Key poses, not clips.** Author a SMALL pose catalogue per gait direction (a stride is ~3-4 poses:
   contact / low-pass / push-off). Content, in the existing pose/producer idiom — NOT new clip files.
2. **Phase driven by DISTANCE, not time.** The gait phase advances with ground distance travelled, so
   foot speed matches ground speed and the feet never slide (the talk's central point). Speed changes
   the stride length/frequency, not a clip's playback rate.
3. **Directional blending off the movement-vs-facing vector** — which T-328 just made real: forward /
   back-pedal / lateral strafe are now genuinely distinct inputs. Blend the directional pose sets by
   that vector instead of assuming movement == facing.
4. **Layering (the (b) decision):** the procedural gait owns the LOWER body + pelvis/root; the authored
   weapon-style clips (`$idle`/`$walk_forward` tokens → `great_sword_idle`, `sword_and_shield_idle`, …)
   stay as the UPPER-body layer, so each weapon keeps its authored character. Compose through the
   EXISTING masked layer stack (`AnimationState.layers` + bone masks + `evaluateAnimationLayers`) — do
   not invent a second composition path.
5. **Feeds the landed pieces:** foot placement from the gait drives the already-landed
   `applyFootTerrainIK`; secondary motion (the landed snappy exponential ease) rides on top; the
   landed `applyLocomotionPose` lean composes.

Done when: walking/running/strafing/back-pedalling is generated from interpolated key poses with no
foot sliding at any speed, each weapon style still reads distinctly in the upper body, and the whole
thing composes with crouch + swing + foot-IK without a combinatorial clip matrix.

The fused pipeline: base-pose catalogue (idle/walk/run/strafe/crouch/turn as parametric poses or
blends) → action overlay (swing/block/dodge) → IK layer (weapon arm, foot planting, look-at) →
secondary motion (snappy organic ease). LANDED: `bendSpine` primitive + `applyLocomotionPose`
(strafe/turn lean) composing with the swing in the inspector; **two-arm IK grips** (`GripDef` +
`swingPath.grips` — one arc serves 1H/2H, both hands via the one aimLimb primitive, commit 9190424);
**secondary motion** (snappy exponential ease on spine/head, NOT a physics-velocity spring — user
constraint; hands excluded so blade==hit; commit 05f13c2). **input locomotion lean**
(1cf601d) wired into the client (local player strafe from movement intent; remotes from velocity;
strafe sign unverified live). **crouch + foot IK** (49f1161 pose+inspector, d450415 client): solveSkeleton
gained an optional `rootOffset`; `applyCrouchPose` drops the pelvis + re-plants feet via `aimLimb` on the
leg chains; client crouches on Ctrl (eased `crouchEased` + a root-group translation). **foot-terrain IK +
look-at + facing-relative back-pedal lean** (lane/t308-anim, commit 1625089 — also closes T-186's foot-IK
aux item, same primitive, built once): `applyFootTerrainIK` re-plants each foot at the LOCAL terrain
height under it (self-consistent delta-from-root via `ClientWorld.getTerrainHeight`, clamped against the
unloaded-chunk-returns-0 artifact); `applyLookAtPose` is head/gaze stabilization — counter-rotates the
head against accumulated spine lean at a partial (0.6) gain, NOT target-tracking (no look-target signal
exists on the wire); `LocoState` gained `moveFwd` (facing-relative forward/back, alongside the existing
lateral `strafe`) and `applyLocomotionPose` folds the spine back on back-pedal (forward movement adds no
lean — clips already carry that) — closes the gap for T-328 (mouse-turn + facing-relative movement,
landing concurrently on lane/t328-facingcam), which makes back-pedal/strafe real, distinct locomotion
states for the first time. Both new producers gate on the pose pipeline's existing extra-solve branch
(crouch/locomotion/swing active) rather than running unconditionally every frame — a fully idle entity's
rest pose has no lean to correct yet; whether idle-on-a-slope also warrants the always-on cost is a live
profiling question (see postMergeChecklist in the lane's report). 9 unit tests on a synthetic-skeleton
fixture (`swing_pose.test.ts` — the file had none before). NOT done, and NOT attempted blind (needs a
design decision this lane couldn't make alone, or live-stack visual verification this lane doesn't have):
the full parametric-gait-replaces-clips rewrite (walk_forward/backward/strafe_* stay clip-authoritative —
collapsing weapon-style idle/walk variance into pure procedural motion is a real design call, not a
mechanical follow-on); target-tracking look-at (needs a look-target wire signal); crouch depth/knee-pole
FEEL tuning and strafe-sign LIVE verification (the sign math is convention-consistent by code review —
see the lane report — but "feel" tuning needs testplay iteration this lane cannot do). Dual-wield deferred
(2nd server sweep + AnimationState channel).

**PARAMETRIC GAIT LANDED (lane/t308-gait, commits ab3e36f content + 6a5c072 client) — closes the
"full parametric-gait-replaces-clips rewrite" item above, for the LOWER body.** `GaitDef`
(`data/gaits/*.json`, `SkeletonDef.gaitId`) authors a SMALL single `forward` key-pose track (contact /
push-off / low-pass, one foot's own phase-0..1 offset from its rest position) — `backward`/`strafe`
are DERIVED from it (mirror fwd for backward, swap fwd onto the lateral axis for strafe), the same
"author one source, derive the rest" doctrine `deriveTip()` uses; a gait may still author an explicit
override track later if the derived approximation doesn't read right live. `applyGaitPose` (new
swing_pose.ts sibling producer) is phase-driven by GROUND DISTANCE, not time — the client's
`EntityMeshGroup.gaitDistance` accumulator advances by the entity's ACTUAL ground-plane position
delta every frame (not intended speed), so a wall-blocked entity's feet correctly stop cycling
instead of sliding. **The no-footslide property is proven exactly (1e-6), not just hoped for** — 6
new tests in `swing_pose.test.ts` show a planted foot holds its WORLD position across the whole
stance interval for forward, backward, left-strafe and right-strafe, at arbitrary phase granularity
(the function is pure/memoryless in `phase`, so this generalizes to any real-time speed profile that
produces those phase values). Composes through the EXISTING masked layer stack per the settled
design: `applyGaitPose` only ever touches the leg IK chains, so the weapon-style clip's upper body
(arms/spine/head) rides through completely untouched (also tested); it supersedes
`applyCrouchPose`'s own foot-replant while moving, sharing the same pelvis-drop `rootOffset` so
crouch + walk compose without either producer running first (also tested — no combinatorial clip
matrix, no wall-clock time in the composition). Falls back to the locomotion clip's own leg track for
skeletons with no `gaitId` (the wolf archetype). **Explicitly NOT covered by this landing** — the
literal "Done when" bar (interpolated key poses, no slide at any speed, upper body distinct, composes
with crouch+swing+footIK) is met, but: diagonal movement blends the three direction tracks linearly
(the same informal idiom `applyLocomotionPose` already uses for simultaneous strafe+turn) — proven
exact only at the three cardinal blends, not at every angle; pelvis/root vertical bob + lateral sway
were scoped OUT (the vertical case needs the same render-time root-translation plumbing crouch uses,
generalized beyond local-player-only — a small follow-up, not a design question); the Studio gait/pose
authoring panel named as "if useful" was not built (unit tests substituted); and — like every other
client-visible piece in this ticket's history — live testplay FEEL verification (does the walk actually
read well, does the derived strafe/backward approximation look right) needs the live stack this lane
didn't have. See the lane's closing report for the exact live-verification procedure.

### T-309 · Body attachment slots — hotbar items rendered on the body
Effort: M   Status: done   Commit: 1b86532 (+ 461a960 prerequisite)   (2026-07-13)

**LANDED (lane/t309-hotbar):** both halves. (1) Prerequisite — `hotbar_assign`/`hotbar_use` are
real: `HotbarState.assignments` maps hotbar slot → inventory slot index; the displayed item is
derived live from `InventoryState` (new `hotbarItems` computed, `ui_store.ts`); drag-drop from
`InventoryPanel` assigns (new drop-zone in `Hotbar.tsx`, mirrors `EquipmentPanel`'s pattern);
clicking an occupied slot sets `activeIndex` (`hotbar_use`); a new `hotbar_clear` action
unassigns via right-click (assign-only with no way back would be a dead-end). Client-local only,
session-scoped (not persisted across reconnect, not networked) — see below for what that defers.
(2) Body-anchor rendering — `EntityMeshRegistry.syncHotbar()` renders each occupied NON-active
hotbar item at a new bone-parented body anchor (`sheath_back` → `torso_upper`, `hip_l`/`hip_r` →
`torso_lower` — a LIMITED set of 3, per the ticket; slots 3-7 hold items but have no anchor yet).
Generalizes the held-weapon absolute-scale build (`prefab.modelScale`, not the body's
`entityScale`) onto a bone anchor instead of an entity-root one, per the ticket's step (1).
`ensureBoneAttachment` gained an optional authored rotation for anchors not aligned to a
body-part sub-object. The active slot is always skipped (rendered nowhere by this path — it's
presumed already in hand via the separate, real Equipment system; this path never equips
anything). Anchor pos/rot are aesthetic defaults picked by code review against the skeleton's
bone-local offsets, NOT verified live (this lane had no live-stack access) — flagged tunable in
the code; **live-verify + retune before calling the placement final** (exact procedure in the
lane's postMergeChecklist).

**Deferred, NOT built (scope note from the launching prompt, and too big for this ticket):** the
full vision this ticket originally described — the hotbar becomes a real NETWORKED component so
other players see slung gear, and the full inventory panel gets gated behind selecting a BACKPACK
slot on the hotbar — is its own arc. Split out as **T-329** so it doesn't get lost. Gating the
*visible slot count* by equipped carry-gear (step 3 of the original plan) waits on that same
arc (there is no carry-equipment/backpack system yet to gate on).

**Original ticket text + the 2026-07-07 blocking audit, kept for history:**

Render the player's HOTBAR items on body anchors (sword on back, axe at hip, etc.) — a LIMITED set of
slots, the count EXTENDABLE by carry-equipment (backpack/belt). The active hotbar item is in hand; the
rest render slung on the body. This (per the user) is the data source — NOT faking a sheath off
`weaponActionId` (which double-renders ~95% of the time, per the design review). The render mechanism
already exists: `AttachmentSlot` (bone-parented THREE.Group anchors) + `attachModelToSlot`; `ARMOR_SLOTS`
already maps e.g. `back → torso_upper`. The hotbar exists client-side (`ui_store` hotbar: 8 slots +
activeIndex; `hotbar_assign`/`hotbar_use` actions). To build: (1) add body anchors with offset transforms
(pos+rot) applied every sync — sheath_back, hip_l/r — generalizing the held-weapon absolute-scale build
onto bone-parented anchors; (2) map hotbar slot index → body anchor; render each occupied non-active
hotbar item's model there; (3) gate the visible slot count by equipped carry-gear. DECIDED (user): the hotbar is
NETWORKED (server-authoritative) so other players see your slung gear; and the full INVENTORY is only
accessible by selecting the BACKPACK on the hotbar (no backpack on the bar ⇒ no inventory access — the
hotbar is what you carry on your body; the backpack is one slot that opens the bag). Composes with T-308
for free (anchors are bone children → slung gear sways with the body). This pulls the hotbar from a
client-UI mapping into a real networked component + an inventory-access gate — sizeable; its own arc.

**Blocked on landing even the client-local slice (lane/t309-attach audit, 2026-07-07):** the ticket's
premise "the hotbar exists client-side" is true only for the UI *shape* — `ui_store.HotbarState` (8
slots + activeIndex) and `Hotbar.tsx` render it — but there is NO data behind it anywhere in the repo.
`hotbar_assign`/`hotbar_use` are still routed to the `console.debug("[UIAction unhandled]")` catch-all in
`game.ts` (never implemented); `uiState.hotbar` is initialized once to `{ slots: Array(8).fill(null),
activeIndex: 0 }` and NOTHING ever calls `patchUI({ hotbar: ... })` — confirmed by grepping every
package for `hotbar`/`hotbarSlot`/`HotbarSlot`: zero writers, zero server component, zero
inventory-slot↔hotbar-slot mapping convention, in client, codecs, protocol, or tile-server. Contrast
with `equipment`/`inventory`, which the same boot code maps from real networked `state.equipment` /
`state.inventory` (`game.ts` L415-416). So "render each occupied non-active hotbar item's model" has
no occupancy to read: rendering body anchors now would mean anchors that are permanently empty (dead
code with no live caller), which is scaffolding-for-later, not a shippable slice — the refactor
doctrine's "no half-built parallel paths" applies here even though this is new work, not a refactor.
Landing the visible win (even client-local, unnetworked) requires FIRST deciding + building the
missing piece: what populates the hotbar (most likely: client-local drag-drop from inventory→hotbar,
persisted in `ui_store`, i.e. actually implementing `hotbar_assign`/`hotbar_use` against the existing
`InventoryState`) — a real design/scope decision (persistence across reconnect? decoupled from the
eventual server-authoritative version this ticket also calls for? does drag-drop from inventory panel
onto the Hotbar component need new drop-target wiring in `drag_system.ts`?) that a doctrine-following
agent should not guess. Recommend splitting: a prerequisite ticket to implement client-local
hotbar assignment (make `hotbar_assign`/`hotbar_use` real against `InventoryState`, wire drag-drop),
THEN this ticket's body-anchor rendering has real occupancy to key off. No code changes landed on
`lane/t309-attach` beyond this note — see the lane's final report for the full audit trail.

### T-322 · Swing-sweep debugger in the Studio animation editor (against the T-307 swingPath model)
Effort: M   Status: done   Commit: a537704   (found during the T-191 closeout audit)

T-191e ("weapon sweep debugger + per-clip attachment overrides") was closed `obsolete` on
2026-06-22 on the premise "zero swingPath in content" (blade geometry was clip-driven
baseLocal/tipLocal at the time). T-307 (2026-06-25, three days later) re-introduced
`SwingPathDef` wholesale — 9 default swings now author their blade arc in
`data/weapon_actions/*.json`, and `solveSwingPose` derives the full-body pose from it. T-191e's
obsolete rationale is therefore stale, but the ticket itself described a specific v1-era
mechanism (`data/clip_overrides/{clipId}.json`, hand-bone-matrix-vs-forearm-blend comparison)
that no longer matches how blade attachment works post-T-307/T-308 (aimLimb IK, not clip
blending) — reopening the old text verbatim would be reintroducing a stale plan, not honest
scoping. This is a fresh ticket instead.

`AnimationEditor.tsx` (Studio) still carries only a stub comment (`// weapon-sweep /
attachment-override tooling (T-191e).`, line ~153) — no visualisation of a swingPath's blade arc,
interpolated tip position at scrubbed t, or the swept-capsule volume exists in any devtool today.
Build it against the CURRENT model: a Studio panel (either a new tab on the animation editor or a
dedicated route) that loads a `WeaponActionDef`, renders its `swingPath` keyframes as a 3D curve
in hand-local space via the same `deriveTip()`/`solveSwingPose` code path the game and T-306's
blade_grammar use, scrubs `t` to show the interpolated blade capsule, and overlays the swept
volume across the action's active window. Read-only v1 is enough (no save-back editing) — the
done-bar is visual/debugging parity with what the server's `weapon_trace` resolver actually
sweeps, not an authoring workflow.
Done when: picking any swingPath-bearing weapon action in Studio shows its blade arc + swept
capsule scrubbing through the active phase, matching what the live game renders and hits.

**How it landed:** a new "Sweep" tab on `AnimationEditor.tsx` (not a dedicated route — the
existing skeleton view is right there). `sweep_overlay.ts` is a thin Three.js layer over
`sampleSwingPath`/`solveSwingPose` from `@voxim/content` — the SAME calls the server's
weapon_trace resolver and the client renderer use, so no geometry is re-implemented. The posed
rotations feed straight into the animation editor's existing `SkeletonView.applyPose` (shared
with the Clip/Morph tabs, same Euler-per-bone convention `entity_mesh.ts`'s `updateSkeletonPose`
uses); the swung blade box is read back off the posed hand bone's world transform, not
re-derived, so it can't drift from what's actually posed. Scrub `t` to pose the full body +
place the blade (red during the active window); toggle a swept-volume overlay (N translucent
capsules across the active window, sample count adjustable); a teal guide line surfaces an
authored-hilt-vs-actual-hand-position gap (arm-too-short-for-the-arc), the same tell the
client's standalone Swing Inspector (`packages/client/src/inspector.ts`, T-307/T-308's
authoring tool) already exposes. Read-only v1 as scoped — no save-back editing.
`content/mod.ts` gained the missing `SwingPathDef`/`SwingKeyframe`/`GripDef` type exports;
devtools' Layer-B `content_loader.ts` WeaponActionDef mirror gained the `swingPath` shape.
Verified in-lane (type-check matrix + full suite 813 green + studio bundle rebuild); live-stack
click-through in Studio is the post-merge step (devtools isn't behind the docker dev stack this
lane could touch).

## AAA Graphics

The 2026-06-26 visual-elevation arc: the mechanics + voxel art language exist; what's missing is
DETAIL + AAA light/atmosphere. User direction: the comic / pixel-art look is DELIBERATE and KEPT —
the Sobel outlines and `flatShading:true` stay, voxels (of varying size) remain the atomic units (no
bevels / smooth-normals / subdivision that would round them away). The ask is "rounder, less eckig"
re-read as **crisper + more detailed within the comic idiom**, plus AAA lighting & atmosphere (think
high-end stylized voxel — hard edges, but clean, richly lit, with glow/AO/haze/depth). Sequenced as
phases, each a self-contained commit verified via the testplay screenshot harness.

### T-311 · Visual data-model arc — author the world's look as content, not client hacks
Effort: XL   Status: in-progress   Plan: `VISUAL_DATAMODEL_PLAN.md` + `ART_DIRECTION.md`

**Progress:** Phase 0a landed — `MaterialDef.render` block frozen (I2) + TextureStyle
registry retiring the numeric `DRAW_FN` switch (`abdaf2d`); per-voxel `tintJitter`
amplitude threaded from `render` through `bakeVoxels` (`a649dee`). Both byte-identical /
zero visual change, `deno check` + parity tests green. **0b/0c/0d deliberately deferred,
not skipped:** 0b (CLIFF_* → config) is interim that Phase 6 deletes wholesale + would
need new bootstrap plumbing → throwaway; 0c (`buildMaterialMap`) is a 10-line stable
atlas-enum lookup, not a richness hack → converting it is ceremony; 0d (FieldExpr/
FieldSampler registry) is premature before the Phase-3 grids exist (the critique's #5 —
build the sampler with its data, not before). Phase 1 landed (both panels, live-verified via
playwright) — Studio "Material" editor (`0f6f73d`) live-previews `MaterialDef.render`, and
"ProcModel" editor (`57cf815`) generates trees/plants/rocks through the REAL generator
registry + bake, both via the curated `@voxim/client/render` barrel (shipped runtime, no
drift). The Scatter-Field-Painter half of P1a defers to P3/P4 (no field grids to paint
yet). Phase 2 in progress — **GradeDef** landed (`3a5e940`): the first AuthoredEnvParamSet (G7),
the 13 EdgePass grade constants lifted into a content `grades/` category (wired
types→store→loader→bootstrap round-trip), EdgePass.setGrade applied by the renderer; zero
visual change (values byte-equal to the retired constants). **LightDef** mostly landed (mapped by a
cartography workflow): LightDef content category (`4e8292b`, BOOTSTRAP_VERSION 15→16) +
FlickerCurve registry replacing the hardcoded oscillator (`4bf9c4a`) + client LightBudget
capping dynamic PointLights at 8, degrading the rest to always-on emissive flame voxels
(`8636ce4`, headless unit-verified). The LightEmitter wire bump landed too (`73eeeb7`):
`flicker` float retired for a `lightDefId` string (numbers stay on the wire for getLightAt;
client resolves flicker/castsPool/family from the LightDef — T-250), placed prefabs +
Illuminator + deriveItemStats + EquipmentSystem all moved in one commit, server boot
cross-check added. **LightDef is COMPLETE.** **MaterialStateLadder (G3) COMPLETE** too — `resolveMaterialVariant`
in @voxim/content (colorOverride/HSL-colorShift/emissiveCracks/addsTags; stable id→index, I3c)
+ a Studio Material "State ladder" dropdown previewing each variant through the real resolver
(the in-game per-cell index comes from P3's SurfaceStateGrid.variantIndex); example
corrupted/mossy variants on stone, live-verified. **PHASE 2 COMPLETE** (GradeDef · LightDef ·
MaterialStateLadder). Next: **Phase 3** — the unified per-cell field grids, the ONE permanent
wire break. **FIELD-SET MATRIX SIGNED OFF (user, I1)** — see `VISUAL_DATAMODEL_PLAN.md §Phase 3`:
`VegFieldGrid`{canopyLight,corruption,fertility} + `SurfaceStateGrid`{wetness,overgrowth,wear,
variantIndex u8,ruinAge,traffic} + `WaterGrid`{surfaceLevel f32}; full-res, mandatory RLE/zlib,
ruinAge+traffic baked in now (no 2nd break). P3 + P4 (multi-layer scatter) unlock the hero-cell
DENSITY slice. **P3 commit 1 LANDED (`c87a4fc`)** — the grids are minted as networked chunk
components (wireIds 54/55/56), sync per-plane RLE codecs (gzip ruled out — Serialiser is sync),
registered in NETWORKED_DEFS + the client CODEC_BY_WIREID decode table, createChunk writes neutral
defaults so every chunk carries them, MAX_CHUNK_SPAWNS_PER_TICK 20→12; 6 codec round-trip tests +
deno check ×5 green. **The permanent wire is set.** Remaining P3: **2a LANDED (`70e8e47`)** — pure `deriveFieldPlanes` core, unit-tested. **2b-i LANDED
(`539ee7d`)** — the `fields` pipeline stage (rasterises pathLevel from the zone graph, calls
deriveFieldPlanes → state.fields; wired into the typed pipe + ORDERED_STAGES + a tunable
GenParams["fields"] slice; snapshot unchanged, runner now 12 stages). **commit 3 LANDED (`663bc49`)**
— Atlas-inspector heat overlays (a "fields" viewer + plane select, encodeState/decodeState `__planes`
bundle, round-trip unit-tested) + the `fields` GenParams sliders tune the formulas live, no re-bake.
**DERIVE + VISUALISE + TUNE done.** **2b-ii LANDED + RE-BAKE-VERIFIED** (`<this commit>`): state.fields →
TileInit → TileInitWire(fieldsB64) → upsample (nearest-resample, NaN-safe water) → atlas_terrain →
chunksFromBuffers(32² slice) → setChunk* — every chunk now carries the atlas-DERIVED Veg/SurfaceState/
Water grids. Verified live: brought the docker stack up, `POST /world/bake` ran the fields stage +
serialised fieldsB64 into the stored wire (canopyLight max 255 / ruinAge max 246 / traffic from paths,
via GET /tile), and the tile-server loaded the re-baked world cleanly ("atlas terrain loaded" + booted) —
the re-bake caught + fixed a real transition crash (old worlds lack fieldsB64 → graceful zero planes).
**FieldExpr (G2) evaluator also landed** (`content/field_expr.ts`). **PHASE 3 COMPLETE** (grids minted +
derived + threaded to chunks + inspector + FieldExpr). **Phase 4 STARTED + LIVE-VERIFIED:** client stores the per-chunk field grids (`client_world` maps +
getters) and **field-driven scatter density** landed — `ScatterDef.densityField` (FieldExpr) replaces
the flat hash gate; `scatter_renderer` evaluates it per cell (dense in fertile/shade, receding on dry
rock/paths); 4 foliage defs authored; loader boot cross-check. **Verified live on the running stack:**
re-baked world → tile-server re-derives chunks with fields → AoI → client receives + STORES them
(probe: fertility 66–167, canopyLight 0–255, traffic 0–255, all varying per cell) → scatter reads them.
The live loop caught + fixed 3 integration bugs (re-bake decode crash on old worlds; stale-save bypass;
the T-312b save-load field gap). **FieldExpr (G2)** evaluator also landed. **Scatter CLUSTERS landed +
LIVE-VERIFIED:** `ScatterDef.cluster {count:[min,max], radius}` — a matching cell seeds a field-sized
clump (count lerped 0→max by the cell's field density, scattered in a disk) instead of a single prop, so
fertile/shaded cells read DENSE and dry rock thins to nothing; all instances of a cell share one handle.
Authored into grass (0-5, r1.4) + fern (0-3, r2.2). End-to-end live proof on a SAVE-loaded world after the
T-312b fix: fields reach the client (fertility 66-167, canopyLight 0-255 varying), all 256 chunks decorate,
962 scatter instances place (oak 792, grass 133 clustered, fern 31, rock 6) — visually a dense forest.
**Bush/mushroom zero-placement SOLVED** — the live placement-funnel probe traced it to THREE substrate
bugs, all fixed: (1) FieldExpr inverted windows (min>max, the "denser in shade" idiom) silently degenerated
to a raw≥max threshold via the `span<=1e-6` guard — the declutter pass (415dad2) actually placed ZERO oaks
(`15b4862`); (2) round() on the cluster-count lerp cliffed everything under density 0.25 to empty
(`90a8979`, stochastic hash-dithered rounding — field decides expected count, hash only dithers);
(3) hash2u was Perlin integer noise whose low 16 bits are garbage on cell lattices (median 56576/65535) —
every `(h&0xffff)` probability gate was broken, the REAL bush=0 cause + a near-constant variant pick
(`08d46c8`, murmur3 mix32). Plus the atlas gap the probe exposed: fertility was near-FLAT outside chambers
(no signal could carry groves at all) → **fertility dapple** fbm modulation in `deriveFieldPlanes`
(`feb10e4`, GenParams `fertilityDappleAmp/Scale`, re-bake). Defs re-authored to the MEASURED band
(ground fertility mean 0.26, band 0.14–0.45; `aee129f`): live-verified oak 962 grove-varied /
grass 9.6k / fern 4.8k / mushroom 1.4k / bush 173 / rock 296, paths clear, under InstancePool caps.
**Moss-creep LANDED** (`a46e14a`): `VoxelAtom.moss01` (G6 sidecar — DATA, palette stays the colour
carrier) from SurfaceStateGrid.overgrowth × `render.mossBlend` floor/wall bias (+jointBoost on terrace
ledges); bakeVoxels lerps the per-voxel tint via `resolveMossResponse`; byte-identical when absent
(test-pinned); authored on stone+gravel; Studio Material editor grew a Moss section with a MOCK
overgrowth ramp through the real bake (verified grey→mossy-green). **Wetness specular LANDED**
(`0b4b819`): the G4 **SurfaceTreatment registry** (sibling of TextureStyle; water + `render.reflect`
join in P5) with the `wet_specular` builtin — per-vertex `aWetness` (VoxelAtom.wet01 →
SurfaceFieldInput generalises the moss input) darkens diffuse + boosts Phong specular in-shader;
treatments CHAIN onBeforeCompile after canopyFade; authored on path/stone/gravel/dirt/mud; Studio
Wetness section verified dry-tan→wet-dark. **Corruption-morph LANDED** (`f28733f`):
`ProcModelDef.morphTiers` (≤3 deep-merged param overrides = ≤4 tiers, loader-validated) +
`ScatterDef.morphField` (FieldExpr, cross-checked incl. tier membership); ScatterRenderer builds a
variant pool PER TIER and buckets each cell's SERVER corruption — the field decides the form, never a
hash; fern/grass/oak authored (withered → corrupted purple husk), live-verified tier counts (fern t0
4760 / t1 12 / t2 30 — healthy the norm, corruption marks the old chambers).
**Decals LANDED (Q8 resolved by user: EPHEMERAL)** (`97510c7`): in-memory + decay, never saved, never
networked — no DecalGrid wireId (transient state doesn't earn a permanent wire slot; late-joiner gaps
self-heal by decay). `DecalDef` content category (`data/decals/*.json`, full plumbing, BOOTSTRAP_VERSION
17) + the client decal-source registry over the closed event catalog (`damage`/`death` — wire GameEvents
carry the WHERE/HOW-STRONG: DamageDealt hit contact point + amount intensity, blocked draws none;
EntityDied pools at the entity) + `DecalRenderer` (thin voxel slabs via InstancePool — no alpha quads;
slab-by-slab crumble decay; MAX_SPLATS=160 perf cap; tile-transition reset; `blood` material id 33).
Live-verified: stimulated wire events → splats at player, blocked skipped, fast-forward decay → 0.
**PHASE 4 COMPLETE** (field-driven scatter density/clusters · corruption-morph · moss-creep · wetness
specular · ephemeral decals). **P4 follow-up (`f7eb022`):** cliff edges are now warped voxel STACKS — the T-310 inset-ziggurat
voxeliser is DELETED (with it the recede-degeneration bug family, incl. vanishing 1-wide ridges). A cliff
cell piles 2–5 full-footprint stone boxes base→lip; the hand-stacked read comes from the per-voxel
language alone: exposed-face warp (`render.relief.warp`, the relief block's first consumer; deterministic
voxHash, welded faces/z/top stone exact), per-voxel tint, corner displacement, per-stone Sobel ink.
Live-verified: the pale zigzag ledge artifacts on every cliff edge are gone, TRIS 1718k→1679k. The
stack TRIGGER stays the client stopgap P6 retires — the stacked-stone language survives on the atoms.
**Stacked-voxel language completed (`dc93a14`, `3dd769a`):** `VoxelAtom.dispSeed` decorrelates a voxel's
corner warp from the world-position weld — stones/slabs poke out of the merged mesh, clip into each other
(deliberate) and get their own facet normals (per-stone light); oversize-into-known-solid (≥ max corner
roll) guarantees gaps never see through the wall. Extended to the walkable floor as
`relief.surfaceWarp` + `surfaceWarpField` (FieldExpr, boot-checked): rough clod-mosaic wilderness,
perfectly smooth trodden paths (traffic-inverted) — one grammar, two consumers; field sampler shared
(`field_sample.ts`). **Found + fixed en route: ALL terrain had rendered FALLBACK grey** — the legacy
ContentCache never held ground materials, so getMaterialSync returned undefined and every
`MaterialDef.render` response silently no-opped on terrain; now falls back to the bootstrap
ContentService (scene-probe verified: real colours + textures live, golden paths, textured stone).
Grade retune against the REAL material colours is an open content follow-up.
**Civilization axis (`989fb8a`, user design principle):** `relief.disturbanceField` (renamed from
surfaceWarpField) is THE per-cell wildness FieldExpr (1 = wild, 0 = civilized) scaling every
voxel-disturbance channel: surface roughness, cliff-stack warp, and NEW the per-voxel tint mottle
(`VoxelAtom.tintScale`, 25% floor) — trodden/worked cells read flat + uniform + orderly, wilderness
rough + mottled. `path` authors `disturbanceField: []` (empty expr = always civilized). Next: **Phase 5** — AtmosphereDef + server sun-arc (folds in the deferred
T-310 arcing sun) + creature fragmentation (G6/I3b) + cheap water reflection.
**Phase 5a LANDED (lane/atmosphere):** `sun_arc.ts` (dependency-free pure altitude/azimuth/direction
function, unit-tested incl. midnight-wrap continuity) + `AtmosphereDef` content category (sun path, ground
mist, near-field god-ray params — day/night COLOUR stays on `Palette.phases`, not duplicated). **Resolved
the I2 render-context-key gap**: 0b/0c/0d were deliberately deferred and never actually landed (verified —
`GradeDef` still hardcodes `cache.getGrade("default")`); P5a builds the selector as `WorldClock.biomeTag`
(reuses the existing wireId 23, no new wire field), computed atlas-side via the existing `biomeTag()` ladder
(already used by zone_namer) from the tile's `WorldCellRecord.biome` — one value per tile, no re-bake
needed since biome is DB cell metadata, not baked into the tile_init buffer. `environment_lighting.ts`
now computes the sun direction every frame from the server clock via `sunArc()`; the shadow-camera basis
is recomputed per-frame (was a one-time precompute); `SUN_DIR` is deleted everywhere (grep-swept). Ground
mist landed as an EdgePass composite term (reuses the pass's existing depth reconstruction — no new
render target) with per-phase density from `AtmosphereDef.mist`. God-ray params (the existing
screen-space radial-scatter pass, near-field-only by construction) now come from `AtmosphereDef.godRay`
instead of hardcoded literals. Zero look-change at noon (pinned regression in `sun_arc.test.ts`). Full
suite 605/605 green throughout; atlas snapshot suite unaffected (biomeTag is additive metadata, not baked
into any buffer). Next: **Phase 5b** — WaterStyleDef + water_renderer rebuild, reusing this same
biomeTag selector.
**Phase 5b LANDED (lane/atmosphere):** `WaterStyleDef` content category (wave/fresnel/specular shader
params + base colour, `data/water_styles/default.json` freezing today's literals verbatim) — selected via
the SAME `WorldClock.biomeTag` key P5a's AtmosphereDef uses (the point where I2's "one render-context key,
not three wire bumps" promise is actually redeemed: two independent consumers now share it). `water_renderer.ts`
rebuilt wholesale on `WaterGrid.surfaceLevel`: the KindGrid-derivation path, the client-mirrored
`RIVER_DEPTH` constant, and the pending/tryBuild wait machinery are all deleted (closes the T-315 comb
note); geometry now merges contiguous same-height row runs into single quads (unit-tested, 5 new headless
tests — no THREE scene dependency needed for pure geometry). Cheap wetness-weighted reflection shipped as
two additive consumers of the wet_specular's existing `aWetness` input: a sky-tinted `reflect()` term in
the water shader (EnvironmentLighting is now also the single sky-colour owner via `getSkyColor()`), and a
new `wet_reflect` SurfaceTreatment for wet ground materials (`render.reflect`, unused since G4 until now) —
no render-to-texture, no probe, no SSR (the full planar probe stays a named T-313 follow-on). Full suite
610/610 green throughout. This closes the atmosphere lane's scope (P5a+P5b); P5c (creatures) and P6
(terrain) remain, owned by other lanes.

**Phase 5c LANDED on `lane/creatures` (creature fragmentation, G6/I3b — see
`prompts/T-311-P5c-dissolves.md`):** `dissolutionPhase` f32 appended to
`AnimationStateData` (wire id 14 unchanged, purely additive tail field) —
DERIVED each tick by `AnimationSystem` from `Resource.values["dissolve_timer"]`,
never mutated by ResourceSystem directly (ResourceSystem runs before
AnimationSystem in declared order, and AnimationSystem fully replaces
AnimationState via `world.set` every tick, so a same-tick `world.mutate` from
elsewhere would be silently clobbered). `DissolveProfileDef` content category
(`data/dissolve_profiles/*.json`, mirrors DecalDef's plumbing; one profile
authored, `drowner_rot`) + `NpcTemplate.dissolveProfileId`, boot-cross-checked.
**Architecture correction vs. the prompt's literal wording:** death-dissolve
start is a `shed_dissolve` **DeathHook**, not an `entity_died` Trigger — the
pinned `bossfight.test.ts` test ("an entity_died Trigger ... does NOT fire")
already proves that wiring is structurally inert (TriggerSystem's buffered
drain runs one tick after DeathSystem has already `world.destroy()`-ed the
entity; see `components/boss_arena.ts`'s header). `DeathHook.onDeath` gained an
optional `{ linger: true }` return so a profiled corpse can defer
`world.destroy` to its `dissolve_timer` Resource's terminal threshold
(`cross@0` → the already-registered `destroy_self` effect) instead of despawning
same-tick; default behaviour for every other death (players, non-profiled NPCs,
the boss) is unchanged. Client: G6 sidecar extended (`VoxelAtom.fray01`/
`driftDir` → `aFray`/`aDriftDir`, byte-identical when absent) + an isolated,
cleanly-revertible in-shader drift patch (`dissolve_shader.ts`, per-vertex
`transformed +=` offset only, zero CPU re-bake) + a Studio Dissolve panel
showing the I3b caps live. **I3b MEASUREMENT: PASS** (post-merge, live stack,
2026-07-06): 6 drowners killed in one burst via the new `DebugKillEntity` dev
command (harness commit 148446f); baseline with 14+ live drowners on screen
POST 0.3–0.8 ms (median ~0.45), during 6 simultaneous dissolves POST
0.4–1.2 ms across 6 mid-dissolve samples in two runs — worst-case increase
+0.75 ms, typical +0.2–0.5 ms, within the ≤~1–2 ms bar (headless software-GL,
so absolute costs are conservative). GL stayed inside its baseline noise band
(8–14 ms). The measurement also FOUND AND FIXED a shipped P5c bug: no corpse
ever dissolved live — DeathSystem's health<=0 sweep re-killed the lingering
corpse every tick and shed_dissolve re-seeded `dissolve_timer` back to 60/60
after each ResourceSystem decrement (commit 87843e6, regression-pinned in
shed_dissolve.test.ts; the lane's tests never re-ran DeathSystem after the
linger vote). Known
v1 scope gap (documented at `ContentCache.getSoleDissolveProfileSync`): the
wire carries no per-entity archetype id, so the client resolves "the sole
registered profile" rather than a true per-entity lookup — correct today
(one profile exists) and a safe no-op the moment a second is authored.

### T-312 · Visual content-authoring arc — fill the libraries the look needs
Effort: XL   Status: planned (blocked on T-311 tools)

T-311 delivers the **machinery** (field grids, registries, devtools, render hooks); the art-bible look
only *appears* once content is authored against it. This is that authoring arc — the bulk of the visible
result, and weeks–months of work even with the tools. **Goal: the layered DENSITY of the screenshots**
(`ART_DIRECTION.md §1`), reached by composing small primitives (`VISUAL_DATAMODEL_PLAN.md §Density through
composition`). **Discipline: hero-cell → hero-scene → propagate** — get ONE patch fully dense in the
devtool until a screenshot crop is matched (the density vertical-slice), then let the field grids + biome
tables replay that recipe across the world. Do NOT hand-place; tune one recipe and scale by data.

Each sub-library is gated on its T-311 phase tool:
- **Flora & ground-cover library** — ~12 generators (fern/moss/root/vine/mushroom/grass/thorn/…) ×
  healthy↔corrupted, biome-tuned `ScatterDef`/`ProcModelDef`. Tool: T-311 P1 ProcModel + Scatter-Field-Painter.
- **Ruins/props/landmarks library** — chapels/altars/statues/tombs/gates/monoliths + caravan/barrel/crate/
  well/chest/banner prefabs, sacred↔corrupted + wear states (the ruins + props sheets). Tool: P1 Material + P2 StateLadder.
- **Creature roster** — the haunts (Wailing Shade, Hollow Lantern, Grief Husk, Mirror Stalker, …) as
  `voxel_creature` procmodels + `DissolveProfileDef`s + skeletons. Tool: P5 Creature/Dissolve panel.
- **Settlement module library** — the full tier × upgrade-stage × road-kit content beyond T-311 P7's
  "one strategy + a handful of modules". Tool: P7 Module Composer.
- **Atmosphere/grade/material polish pass** — `AtmosphereDef`/`GradeDef`/`render`-block tuning per
  biome × time-of-day; the final mood pass. Tool: P5 Atmosphere + P2 Grade panels.

LLM-assisted seeding (SPEC L22) is the intended accelerant. Without this arc, T-311 is a richly-capable
engine rendering a sparse world — the capability gap is closed but the look is not yet authored.

### T-313 · Deferred render-capability extensions — the engine bits T-311 does not add
Effort: L   Status: done   Commit: e7c13dd

T-311 closes the *data-model* gap, but a few genuine render capabilities the references imply are out of
its scope. Ranked by **visible-jump-per-effort** (see `VISUAL_DATAMODEL_PLAN.md §boundary` for the table):
1. **Arcing sun + raking shadows** (HIGH jump / MED effort) — **DONE, landed with T-311 P5a** (not a
   separate item after all — folded into P5 as planned): `sun_arc.ts` + per-frame shadow-cam basis
   recompute from the live `sunArc()` direction; `SUN_DIR` is deleted everywhere.
2. **In-world water verification** (LOW effort) — **DONE, landed during the P5 live-verify**: a water
   blowout was found and fixed (commit `243ce9c`); `WaterStyleDef` + `WaterGrid.surfaceLevel` water is
   confirmed live in-world (P5b).
3. **Shadow cascades / full-frame god-rays** (HIGH jump / HIGH effort) — **DONE (this commit, `e7c13dd`)**.
   A second, wider (±200u), coarser (1024) `farCascade` DirectionalLight (intensity 0 — shadow-only,
   rides Three's own castShadow-correct shadow-map machinery for free) extends raking shadows past the
   near sun's ±60u frustum; `shadow_cascade_pass.ts` reads its shadow map directly and composites the
   darkening itself in a bespoke fullscreen-quad pass (NOT a material-shader patch — three's own CSM addon
   globally rewrites `ShaderChunk.lights_fragment_begin`, which would collide with this pipeline's existing
   onBeforeCompile chains; rejected as a workable-but-wrong-license-for-this-codebase approach). Slotted
   before BloomPass/GodRayPass so canopy-gap light shafts shape correctly past the near cascade's reach too
   — the god-ray "widen once the cascade exists" follow-up is folded in for free (no march-distance change
   needed; `god_ray_pass.ts`'s header updated). 2 cascades total (near unchanged + 1 new far), not 3 — kept
   to the cheaper, lower-risk end of "2–3 split" given the per-fragment shadow-sample cost every additional
   cascade light adds to Pass 1 (documented in `environment_lighting.ts`/`shadow_cascade_pass.ts`). Full
   suite green, `deno check` clean; live perf delta (HUD GL timing) and visual verification are a
   postMergeChecklist item — this landed on a lane with no access to the live stack.
4. **Water planar-reflection probe** (MED-localized jump / HIGH + fragile effort) — **explicitly deferred,
   spun into T-330** (not built): the canal-city mirror needs a second scene pass ordered against outline +
   bloom, is fragile (RTT ordering against a hand-rolled pipeline with no EffectComposer), and only pays
   off where water/wet is on-screen. P5b already ships a cheap screen-space sky-streak reflection as the
   pragmatic v1; T-330 tracks the real planar probe as a named follow-on rather than reopening this ticket.

**NOT pursued (idiom / doctrine):** depth-of-field / painterly softening (fights the crisp Sobel ink — an
anti-goal for the kept comic idiom); normal/roughness PBR maps (against the `flatShading` atomic-voxel
doctrine). **Already landed (T-310 follow-ups, not deferred):** foliage wind sway (`canopy_fade` wind
uniforms), richer material weathering textures, hit-impact flash, camera-occlusion fade.

### T-330 · Water planar-reflection probe — the canal-city mirror
Effort: M   Status: todo

Split off T-313 item 4 (deliberately deferred, not built there — see that ticket's closing note). P5b
(`water_renderer.ts`) already ships a cheap screen-space sky-tinted `reflect()` streak keyed off the
existing `wet_specular` `aWetness` input — good enough for ambient wet-surface sheen, but not a true mirror.
This ticket is the quality follow-on: a real planar-reflection render — a second scene pass from a
mirrored camera into its own render target, ordered correctly against the outline (Sobel/EdgePass) and
bloom passes in the existing hand-rolled (no-EffectComposer) pipeline, sampled by the water shader instead
of (or blended with) the sky-streak term. Fragile by nature (a second full scene traversal, camera-plane
mirroring, and RTT-ordering against a pipeline that already has 3+ interleaved passes — see
`shadow_cascade_pass.ts`'s header for how T-313 reasoned about a similar RTT-ordering problem) and only
pays off where water is actually on-screen, so it's explicitly NOT a blocker for anything else. Done when:
a water surface visibly mirrors nearby geometry (not just sky), the pass is skipped/cheap when no water is
on-screen, and the near-field god-ray/bloom/EdgePass ordering established by T-313 is undisturbed.

### T-314 · ARPG presentation & composition — the non-render gaps that still gate "looks finished"
Effort: L   Status: done   Commit: d84455e, 421d1d3   (lane/t314-arpg, 2026-07-13 — 2/3 items landed,
third genuinely blocked, see below)

The references read as "finished" partly for reasons orthogonal to the voxel/render data model. This
ticket tracks the gap; the work lands in its home domains, cross-referenced so the visual arc doesn't
pretend the look is done at T-311/T-312:

- **HUD/UI polish — DONE (commit 421d1d3).** Reused the existing Preact UI, no new UI system. Real
  gaps found and fixed rather than a cosmetic pass: (1) CastBar/StatusBars/Hotbar/SkillBar were four
  independently `position:fixed` strips with hand-tuned pixel offsets — composed into ONE
  `.action-frame hud-chrome` bottom dock (`ui_manager.tsx`) using the SAME `.hud-chrome` pressed-metal
  recipe already shared by Minimap/ZoneCaption/HeirRitual, laid out by DOM order in a flex column
  (anchored via `bottom` only, so the CastBar — visible only while casting — grows the frame upward
  without shifting the rows under it) instead of four sets of magic offset math; each component
  dropped its own positioning, the frame owns layout now. (2) The minimap's coordinate readout was a
  hardcoded `"0,0"` stub — wired to the real live player world position (`fog.lastPlayer`, same
  imperative rAF draw loop the heading cone already uses). (3) `HudStats` (FPS/tris/draws/network
  telemetry) was permanently visible in the primary HUD — exactly the "debug readouts" this ticket
  says to move away from — gated behind the existing `` ` `` debug-panel toggle alongside DebugPanel/
  NetworkPanel, so the default HUD no longer shows engine internals. **Quest/objective readout — not
  built, and not faked.** Grepped the repo: there is no quest/objective content model or player-facing
  progress-tracking system anywhere in the game (`JobBoard`/`AssignedJobBoard` is NPC production-queue
  work, not player quests). The one real thing that already plays this role — `HeirRitual` (T-072),
  a banner deriving live steps from actual dynasty/container state — already composes into the frame's
  right column under the minimap via the shared `hud-chrome` class; left as-is. Inventing a persistent
  quest log with no backing data would be exactly the "scaffolding with no live caller" the T-309 hotbar
  audit warned against — needs a real quest system (design decision, out of scope here) before a
  readout for it means anything.
- **Camera-occlusion extension — DONE (commit d84455e).** `canopy_fade.ts` already faded geometry
  ABOVE the player's head inside a wide radial blob around the camera↔player midpoint (tree canopy);
  extended the SAME uniforms/shader pipeline with a second "wall" band, combined per-voxel via `max()`
  before the existing single discard test — no new registration call sites, every material already
  calling `canopyFade.register()` (terrain, scatter, props) picks it up for free. The wall band's
  horizontal test is the voxel's distance from the camera→player LINE SEGMENT (projected + clamped to
  the segment, not a point-radius blob), and its vertical gate starts just above the player's FEET
  (not the head) so a wall/cliff fades along its whole height while the floor the player stands on is
  never eaten. New content-driven `game_config.render.wallFade` (minHeight/maxHeight/innerRadius/
  outerRadius) mirrors `canopyFade`'s existing knobs (T-315 D3 precedent) — no hardcoded shader
  constants, no `BOOTSTRAP_VERSION` bump needed (GameConfig passes through the bootstrap blob as JSON
  already). Matters immediately per the ticket's premise: T-328 made the camera sit rigidly behind the
  character's heading, so side occluders block the view constantly, not just near hypothetical
  settlements — did NOT wait on T-311 P7 the way the original text speculated, since ordinary terrain
  cliffs/walls already exercise it.
- **Composed-scene worldbuilding — NOT built, genuinely blocked, not faked.** Still depends on T-311 P7
  settlements (authored POI set-pieces + placement), which per the T-312 ticket body is not built
  ("Settlement module library... beyond T-311 P7's 'one strategy + a handful of modules'" — gated on
  the P7 tool). No code landed for this item; tracked where it already lives (T-311 P7 / T-312's
  Settlement module library), not duplicated into a new ticket number.

## Player UX

### T-072 · Respawn / heir flow UI
Effort: M   Status: done   Commit: 1551de9

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

Done (client ritual layer; server substrate was already done — T-077/T-078 chests, T-079 heir
spawn, T-270 respawn-as-heir). Missing signal found and fixed first: `Heritage` (dynastyId/
generation) has been networked since T-079/T-270 but was never added to the client's
`CODEC_BY_WIREID` decode table, so the client had no way to know its own dynastyId or notice a
generation bump — added the one missing entry (protocol, commit 91fe492) rather than inventing a
new server flag.

**Guidance is entirely derived, not scripted.** `game.ts` arms a session-local `ritualActive` flag
the moment it sees the local player's own `Heritage.generation` climb DURING THIS SESSION — the
first heritage snapshot after connect/join is a baseline, never a trigger, so loading in as an
already-established heir does not fire it; only a real death → heir respawn does. While armed,
`_recomputeRitualGuide` rescans every entity the client currently knows about for a `Container`
(T-077/T-078) matching the player's own dynastyId, and reports a step for the nearest tome/
equipment chest ONLY while it still holds something — no chest built yet, or already emptied out,
means no step, and the banner disappears on its own once both are gone or the player dismisses it.
Rendered by the new non-modal `HeirRitual.tsx` HUD banner. There is deliberately no "do it for me"
button — reading/equipping still goes through the ordinary container + inventory UI, per "guide
the player without hard-coding it."

**Tome reading** ("select tomes to read"): `CommandType.Internalise` (T-020) had server logic but
no client entry point anywhere. Added a `read_tome` UIAction wired through InventoryPanel's
context menu (gated on the item being the content-defined tome prefab), mirroring how "Equip"
already works — withdraw a tome out of the library into the burden (existing withdraw_container
flow), then Read it there. No new server command surface, no parallel inventory system.

**Gear equipping** needed no new work — withdraw_container (T-077/T-078) + the existing generic
Equip action already compose into the full flow.

**Follow-on gap found, not fixed here** (out of scope — a different, living-player workflow, not
the heir ritual): `CommandType.Externalise` (write a learned fragment to a blank tome, T-019) still
has zero client UI, tracked as T-328.

## Heritage & Dynasty

### T-080 · Dynasty reputation persistence in NPC world
Effort: L (cross-service arc)   Status: todo   (premise corrected — deferred; needs the prerequisite chain below)

GOAL (unchanged): on heir spawn, the new character inherits the dynasty's standing with NPC
cities; a predecessor's actions (king-killing, trade betrayals) persist as dynasty history, so a
new heir faces the same city attitudes. Reputation is keyed by `Heritage.dynastyId` (stable across
permadeath) — keying by dynastyId IS the done-condition.

PREMISE CORRECTION (2026-06 scope pass): the ticket's stated dependency is **false against the
code**. "NPC city relationship maps (T-044)" are **city→city** affinity (`CityState.relationships:
Record<cityId, -1..1>`, `coordinator/src/city_sim.ts`), NOT dynasty-keyed reputation (CHANGELOG
confirms T-044 shipped "city→city stance"). And the substrate this needs does not exist yet:
- Cities live in **Postgres + the coordinator**, not the tile-server (no CityRepo/city entities on a tile).
- NPC attitude is **dynasty-blind** — the only aggro path (`findDetectedThreat`) is proximity/sense
  only; there is no faction/reputation/hostility component anywhere.
- **No city-affiliated NPCs** are seeded (no guard template; `tile_layout.json` seeds a lone merchant).
- **No kill/betrayal → city-history pipeline**; `entity_died` is tile-local, only gate-crossings +
  a heartbeat reach the coordinator.

So this is a cross-service ARC, not a single ticket. Prerequisite chain (each its own ticket when
scheduled): (a) `CityState.dynastyReputation: Record<dynastyId, number>` in the coordinator (reuses
the `cities.state` jsonb — no migration) + a `CityRepo.adjustDynastyReputation` server-side merge;
(b) a `DynastyGrievance` WorldEvent + coordinator handler (tile publishes on king-kill/trade-betrayal
keyed by killer `Heritage.dynastyId`); (c) push per-tile dynasty attitudes down via TileCommand
(replace the log-only `onCommand`) into a server-only `DynastyAttitudes` cache; (d) a city-guard NPC
template + `CityAffiliation` marker; (e) gate `findDetectedThreat`/`set_job_attack_nearest` on the
attacker's dynastyId vs the city's attitude (data-driven thresholds in game_config). Deferred from
the Heritage batch because of this span.

---

## Territorial Control

### T-294 · Upper-terrain claims as POI metadata (not a second heightmap)
Effort: L   Status: todo

Implement ideas.md's upper/lower terrain as a SEMANTIC overlay on the existing single heightmap,
NOT a literal second elevation layer. A second heightmap doubles terrain wire + save size and
forces layered physics/fog for a feature whose content — claims, central POIs, building hubs,
fast-travel — is all metadata that lives on POI entities; the wilderness plateau already IS the
"upper terrain", and "lower navigation / upper for POIs" maps onto the path-floor-vs-plateau the
terrain already expresses. Build the core claim loop: add a server-only `Claim` component on POI
entities (`poiInstanceId`, `claimerId`, `timestamp`); mark central/hub POIs (`isCentral` on
`PoiDef` + a `TileNarrative` tag). Defeating a central POI publishes a `ClaimAcquired` event;
`TriggerSystem` fires a `grant_claim` effect on the victor (reuses the trigger primitive — no new
event→effect bridge). Persist claims in `HeritageStore` per player per tile (survives death/
disconnect). Gate building placement on owned claims (buildings snap to claimed POI anchors; each
claim unlocks a content-defined building set via `data/buildings`). Depends on T-212 (POI runtime)
/ T-213 (stairs). DONE: a player defeats a central POI, receives and keeps a claim across
reconnect, and unlocks claim-gated building options at that anchor; no second heightmap is
introduced; claim state is server-only for now. Defer claim-SHARING (others' spawnpoints / fast-
travel / sleeping) and minimap/fog claim overlays to follow-up tickets so this lands the core loop.

## Species

## Item Durability

## World / Environment

## UI / Interaction

### T-329 · Networked hotbar + backpack-gated inventory access
Effort: L   Status: todo

Split out of T-309 (done, lane/t309-hotbar, 2026-07-13) — the full vision that ticket originally
described but which its launching prompt explicitly scoped out as "its own arc, do NOT build it
here". T-309 landed a CLIENT-LOCAL hotbar (`HotbarState.assignments`, session-scoped, not
networked) and body-anchor rendering of non-active slung items, visible only to the local player
on their own screen. This ticket makes it real for everyone else and adds the access gate:

1. **Networked hotbar component.** A new server-authoritative component (wireId, codec in
   `@voxim/codecs`) replacing/superseding client-local `HotbarState.assignments` — the server
   is the source of truth for what's assigned to which hotbar slot and which slot is active, so
   every AoI-visible player's client can render the SAME slung-gear body anchors T-309 built
   (those anchors are already generic — they just need real data for remote entities, not only
   the local player). Decide the wire representation: unique items are entity-refs already
   (inventory slot → item entity), so the hotbar assignment is naturally `hotbarSlot →
   inventorySlot` (matching T-309's client-local mapping) or `hotbarSlot → itemEntityId`
   directly — pick one and make `EntityMeshRegistry.syncHotbar` read it for ALL entities with
   the component, not just the local player via the cached setHotbar() path.
2. **Backpack-gated inventory access.** No backpack item assigned to a hotbar slot ⇒ the
   inventory panel doesn't open (or opens empty/locked) — "the hotbar is what you carry on your
   body; the backpack is one slot that opens the bag." Needs: a backpack item concept (new
   Equippable-adjacent component or a `carryContainer` flag on a prefab?), the actual inventory
   capacity/access gate (currently `InventoryPanel` always opens if `uiState.inventory` is
   non-null), and a design decision on what happens to already-stored items when the backpack
   is unassigned (locked-but-visible vs fully hidden vs auto-drop — needs a design call, not a
   default to guess).
3. **Visible slot count by carry-gear.** T-309's step (3) — gate how many of the 8 hotbar slots
   are usable by what's equipped (a belt might grant 2 extra slots beyond the backpack's base
   set) — depends on (2)'s backpack/carry-equipment concept existing first.

Done when: hotbar assignment is server-authoritative and every player sees every other player's
slung gear (not just their own), and opening the burden panel is gated on having a backpack
slotted into the hotbar.

## Housing

### T-093 · Housing system — player-owned structures as persistent home
Effort: L   Status: todo

A house is a enclosed structure (walls + floor + roof, built via the blueprint system) that a
dynasty claims as their home base. Claiming converts a completed enclosure into a `HouseEntity`
tagged with the dynasty ID. The house is the social and mechanical anchor for a dynasty:

**Claiming:** Player interacts with the interior of a fully enclosed structure (detected via
T-090 room flood-fill) to claim it. Requires a placed family workbench (T-038) inside. A
structure can only be claimed by one dynasty. Claiming transfers the structure's wall/floor
entities to the dynasty's tag (T-083).

**Shelter mechanics:** Interior cells of a claimed house provide: corruption gain suppression,
warmth bonus (amplified further if a hearth/campfire is inside, T-089), and a safe-sleep
anchor for NPCs (T-039). These are computed from the `RoomTag` interior cell set (T-090).

**Persistence:** House ownership persists across server restarts as part of the save system.
On heir spawn (T-079), heir always appears inside the family house if it still stands.

**Destruction / capture:** Destroying enough walls dissolves the enclosure (T-090), which
dissolves the `HouseEntity`. The dynasty loses its home anchor. A new claimant can rebuild
and re-claim. This is the base-capture loop (T-082) applied to housing.

**Furniture:** Deployable items (bed, shelf, chest, hearth) can be placed inside. Furniture
carries the dynasty tag. Furniture items are defined in item_templates.json with a
`deployable: true` flag and an entity template for the placed form.

Done when: a player can build a fully enclosed structure, claim it as home, gain shelter
bonuses inside, and lose the claim when the structure is sufficiently destroyed.

**Prerequisite the enclosure/roof stack is waiting on (from T-066's live-verify, 2026-07-07):**
the wall-blueprint completion path currently never writes `OpenMask` — `BlueprintHitHandler.
applyToTerrain` only touches Heightmap/MaterialGrid, so a completed wall does not close a cell in
the grid `EnclosureSystem` reads. T-093 must make wall-blueprint completion (1) write `OpenMask`
(the cell becomes closed) and (2) let `EnclosureSystem` see it (the existing `BuildingCompleted` →
`markDirty` link then triggers the recompute). Once that lands, T-066's roof rendering activates
in-world for free (it is built + unit-tested, dormant only for lack of a live enclosure trigger —
POI room stamps close `OpenMask` at gen but never fire `BuildingCompleted`, so they don't roof
today either). Decide as part of T-093 whether POI cave-chambers should also roof (would need an
initial/boot enclosure compute) or whether roofs stay exclusive to player-built houses.

---

## Content Architecture

End-state: every distinct piece of game tuning is content; the engine ships small
generic algorithms that consume content; a single typed-registry federation owns
it all. Client and server share content via a WebTransport-handshake bootstrap
blob — no separate HTTP service, no client-side static bundle. Procedural
generators (loot, names, POIs, quests, dialogue) live as data declarations on top
of engine-side algorithms in `@voxim/content`. Tile-server crash → connection
dies → client reconnects → fresh content blob, version drift impossible.

T-173 unblocks immediate creature work and is independent of the rest. T-174 →
T-175 → T-176 → T-177 are the foundation, sequenced. T-178 → T-179 → T-180
together retire the per-creature skeleton sprawl. T-181 / T-182 / T-183 can land
in parallel once the foundation is in.

### T-183 · Unified generator framework
Effort: L   Status: todo

One concept and one entry point for everything procedural — voxel
geometry, loot tables, name generators, POI layouts, stat curves,
templated text. Algorithms are TypeScript code; generators are data
declarations that pick an algorithm and supply its params. Sharp split
keeps each layer testable in isolation.

Entry point:
  content.invoke<I, O>(generatorId: string, input: I): O

Algorithm registry (under packages/content/src/generators/algorithms/):
  voxel_shape    primitive volumes → ModelDefinition.nodes[]
                 (box / cylinder / sphere / capsule / cone / disc / …)
  voxel_compose  union / subtract / overlay multiple voxel outputs
  voxel_distort  twist / noise / taper post-pass
  voxel_recipe   morph-parameterised body part for T-186 Layer 2
  weighted_draw  loot tables, spawn weights
  markov         name generation from phoneme tables
  grammar        L-system / CFG for POI / settlement layouts
  template       placeholder substitution (quest / dialogue text)
  curve          piecewise-linear evaluator for stat scaling

Generator declarations (in content):
  data/generators/voxel/{id}.json    VoxelGeneratorDef
  data/generators/loot/{id}.json     LootTableDef
  data/generators/names/{id}.json    NameGeneratorDef
  data/generators/poi/{id}.json      PoiTemplateDef
  data/generators/curves/{id}.json   CurveDef

Each declaration: `{ id, algorithm, params }`. The algorithm registry
provides typed param schemas; the loader validates against them at
content-load and fails fast on bad params. Adding a new algorithm is
purely additive (register implementation + paramSchema → drop
declarations using it).

Determinism: every invoke accepts an explicit seed; same seed + same
params + same algorithm version → same output. Used for per-entity
body morphs (T-190), per-spawn loot, per-character names, etc.

Voxel editor (T-191b) consumes the framework directly — every
sub-object in the tree can be a generator invocation with sliders for
its declared params, live re-baking on param change.

First non-voxel migrations:
  - poi_placer's hardcoded room shape → grammar
  - corpse loot tables (wolf / drowner / rotten_knight) → weighted_draw
  - one name generator per culture → markov

Done when: poi_placer reads room shape from data; wolves drop loot
from a generator; spawned NPCs get generated names; voxel editor
spawns procedural sub-objects via the same registry; adding a new
algorithm is one file in algorithms/ + zero changes elsewhere.

### T-186 · Procedural character body generator (skeleton + voxel mesh)
Effort: L   Status: in-progress   (Layer 1 done via T-190; Layer 2 recipe voxelizer done, see below —
auxiliary work below remains open)

**Layer 1 delivered as part of T-190.** Sub-object voxel chunks now
stretch alongside bones via the existing morphParams table. Remaining
under this ticket: Layer 2 (procedural body-part recipes) — replace
authored body voxel positions with a recipe-driven voxelizer that fills
each part's volume from morph-parameterised dimensions at spawn. Adds
mass-distribution variety (thick thighs, broad shoulders, narrow waist)
that uniform per-axis scaling can't express.

Single-source-of-truth body shaper: per-character morph values (already
on ModelRef) drive BOTH skeletal proportions AND voxel geometry. A "long
legs" parameter stretches the leg bones AND elongates the leg voxel
chunks together, so the skeleton joint sits at the visible end of the
limb at every value of the slider.

Two layers:

  Layer 1 — sub-object voxel scaling alongside bone scaling:
    biped.json `morphParams` already lists which bones each morph
    affects + a `restAxis`. entity_mesh.ts applies these via boneScale
    {X,Y,Z} to bone rest offsets. Extend the same pass to scale any
    voxel sub-objects parented to those bones along the same axis.
    Adds ~30 lines, no schema changes. Covers: limb length, torso
    height, head size, hip width — anything that maps cleanly to
    "scale the bone segment + the visible chunk by the same factor".

  Layer 2 — procedural part recipes (replaces authored body voxels):
    biped voxel body becomes a recipe declaration instead of authored
    voxel positions. Each part declares a shape generator with morph-
    parameterised dimensions, e.g.
      { part: "torso_upper", shape: "tapered_box",
        length: "$torsoHeight",
        widthTop: "$shoulderWidth * 0.6",
        widthBot: "$hipWidth * 0.5", taper: "$torso_taper" }
    A voxelizer in @voxim/content fills each volume at spawn, keyed by
    the per-character morph values. Required when proportions need to
    affect body MASS distribution, not just length — e.g. "broad
    shoulders + narrow waist", "thick thighs", limb taper, asymmetric
    builds — things that uniform per-axis scaling can't express.

**Layer 2 delivered (lane "body", branch lane/body):** `BodyRecipeDef`/
`BodyPartRecipeDef` schema on `SkeletonDef` (`packages/content/src/types.ts`),
a shared pure evaluator (`packages/content/src/body_recipe.ts` —
`evaluateBodyRecipe`/`resolveBodyPartDims`/`bodyPartCapsule`/
`crossCheckBodyRecipe`, reusing `formula.ts` for morph-scaled expressions), a
`bodyRecipe` block on `biped.json` covering all 16 bones and all 10
morphParams (not just the 6 named in this ticket's prose above — biped grew
`right/leftArmScale` and `right/leftLegScale` since this text was written).
`bone_segment.json` and `scripts/build_skeletal.ts` are deleted outright —
every humanoid prefab (player/drowner/rotten_knight/villager/bandit/archer/
merchant, all `modelId: biped_skeletal`) now renders a recipe-voxelized body
instead of the 1-voxel-wide bone-colored debug cylinders every one of them
actually rendered through before this ticket (a placeholder, not a design
target — the "reads as a body, not a stick figure" bar was used instead of
byte-parity with that placeholder). Single source of truth for mesh AND
collision: `hitbox_derive.ts`'s skeletal-capsule fallback now resolves a
recipe-covered bone's capsule via the SAME `bodyPartCapsule()` dimensions the
mesh voxelizer used (previously a wholly separate hardcoded `BONE_RADIUS`
table, decoupled from any voxel geometry — the risk this ticket's "if
hitboxes derive from authored voxels" bullet named turned out to already be
latent rather than active, since the debug cylinders were never hit-boxed at
all; this landing is the first time collision and visuals share one source).
Studio: a Morph panel in `AnimationEditor.tsx` previews the recipe live
against slider values through the real `evaluateBodyRecipe()`. Payoff:
`bandit.json` morphRanges tuned for a thick-set silhouette (wide shoulders,
narrow hips, stocky legs) alongside `drowner.json`'s already-lanky profile.
Also fixed in the same lane: a latent hitbox-template cache-collision bug
(cache key didn't include morphValues) and a client mesh-build bug
(`entity_mesh_registry.ts` wasn't passing `ModelRef.morphValues` into the
mesh-build's `resolveMorphParams` call, so per-instance morph overrides never
reached the VISUAL body, only pose/hitbox-debug). See T-302's body for the
humanoid_grammar porting note this reduces to — **T-302 landed**: the
evaluator is unchanged (still the one body-volume evaluator) but is now
reached through `humanoid_grammar.ts`'s `humanoidGrammarByBone`/
`humanoidGrammar` on the ProcModel generator substrate instead of a direct
`evaluateBodyRecipe()` call from `entity_mesh_registry.ts`. **Foot IK — done**
(lane/t308-anim, commit 1625089, landed as part of T-308's "foot-on-terrain
IK": T-308's and this ticket's foot-IK items were the same work, per the
T-308 coordination note — `applyFootTerrainIK` in `swing_pose.ts` re-plants
feet at the local terrain height via `aimLimb`, so limbs scaled far from
authored proportions (or standing on a slope) still read as planted; see
T-308's entry for the mechanism). NOT done: posture overlay, character-creator
UI — ticket stays in-progress for that residual.

Auxiliary work:
  - Posture-overlay layer: small additive AnimationLayer composed from
    slider values (backlean, slump, alert) — pure rotation offsets on
    a few torso/neck bones. STALE PREMISE as originally worded: "runs
    alongside whatever Mixamo clip plays on the override layer" describes
    the pre-Action-primitive CSM (retired T-228) — there is no more
    "override layer" concept in the current `AnimationLayer`/action-driven
    pipeline (see T-308's `ActionAnimation`/fused pose pipeline). The
    underlying idea (a few additive rotation-offset sliders on torso/neck,
    composed on top of whatever pose is already playing) still fits the
    current base-pose-catalogue architecture as one more producer — but
    where the slider VALUES come from (a per-character stat? a stance
    toggle? NPC archetype flavor?) is a design call this note doesn't
    answer, left open rather than guessed.
  - Character-creator UI: live sliders mutate ModelRef.morphValues
    in-editor, baked to per-character permanent values on commit. Use
    only in the creator screen — for live characters morphs are
    immutable identity. Its own scoped UI/UX arc (creator screen flow,
    persistence, entry point) — not attempted here.

Property of this design: hit detection self-consistent at any morph.
blade.baseLocal/tipLocal are hand-bone-local; longer arms genuinely
reach further because the hand bone's world position is further out.
No retargeting maths needed.

Done when: the character creator screen exposes ~6 sliders that
visibly reshape the character (height, leg length, arm length,
shoulder width, hip width, head size); a saved character spawns into
the world at exactly those proportions; Mixamo animations play on
every body type without artifact; hits land at the new reach.

## Ops & Deployment

