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

## Stealth

## Lore & Skills

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

### T-212 · POI runtime + wilderness-stair unlock
Effort: L   Status: in-progress   (v1 PoiSystem done -- 03525ae; v2 trinket->stair-unlock + boss/wave/puzzle open)

**v1 landed**: PoiTrigger component + PoiSystem with two dispatch paths:

- `encounter` — spawn NPCs from a (stub) spawn-table mapping at the
  POI's zone centroid via `spawnPrefab`. Wolf pack, bandit pack,
  drowner swarm, etc. map to existing NPC templates.
- `exploration` — publish `LoreInternalised` to the triggering player
  with the POI def's `loreId`.
- `bossfight` / `wave` / `action` / `puzzle` — stubbed (log only).
  Full implementations are T-212 v2.

PoiSystem runs each tick; for each `PoiTrigger`, checks if any
player session is within `triggerRadius` and fires the activity on
first crossing. `fired` flips to true and stays — non-respawning
behaviour for v1.

**Remaining (T-212 v2)**:
- `bossfight` — boss prefab spawn at centroid + arena rules
  (lockEntry sets a temporary path-zone collision when engaged; HP=0
  drops it). Adds-table spawns at phase triggers.
- `wave` — state-machine component cycling through `activity.waves`
  in order with `interWaveSeconds` delay. Cleared on full clear.
- `action` — interactable prefab spawn at centroid (chalice pedestal,
  signal brazier, etc.) — needs the entity-hover/click system from
  T-100 to dispatch usage.
- `puzzle` — reserves `data/puzzles/` content category; each puzzle
  template defines its own internal rules (lever sequences,
  reflection paths, valve sequences). Solving the puzzle fires the
  reward path.
- Stair runtime UNLOCK on trinket consumption — currently locked
  stairs stay locked forever. Needs the trinket-inventory checkpoint
  (when a player picks up trinket X, scan stairs whose `lockedBy === X`
  and call `applyStairUnlock` + broadcast heightmap-Δ to AoI clients).
  This is the bridge from "found stairs work" (T-213 v1) to "earn-your-
  way-up-the-plateau".

Make POIs actually do something at runtime + make stairs actually
gate movement. Tile-server reads `TileNarrative` on tile load, spawns
per-POI runtime adapters:

  encounter   → ProximityTrigger spawns SpawnTable on player entry
  bossfight   → boss prefab + arenaRules (lockEntry collides path
                zone until HP=0)
  wave        → state-machine component, sequential spawns
  action      → interactable prefab at the POI's zone centroid
  exploration → one-shot lore-unlock trigger
  puzzle      → reserves a new `packages/content/data/puzzles/`
                content category (stub for v1; full puzzle
                templates ship later)

Stair runtime: stair entity at each `StairInstance.anchorPixel` with
a `Lock` component referencing `lockedBy`. Player approaching an
unlocked stair gets a "Climb" prompt; using it teleports the player
2u up onto the wilderness plateau (collision-safe, no heightmap
mutation in v1 — the elevation step stays as a visual hint).

When the player completes a POI that drops a trinket the player's
inventory gains the trinket. When any stair's `lockedBy` trinket is
in inventory, the stair flips to unlocked + broadcasts a
`StairUnlocked` event to all AoI clients.

Tests:
- dump/reload preserves stair-unlock state byte-identical
- entering an unlocked stair places the player at the wilderness
  centroid with proper Y elevation
- locked stair refuses the climb prompt
- POI completion → trinket inventory → stair unlock → climb → POI
  completion (the full loop, in one integration test)

Done when: a baked tile with the matcher's narrative is fully
playable end-to-end: spawn → walk → fight encounter → get trinket →
climb stair → fight boss → terminal trinket.

### T-213 · Physical stair object — heightmap ramp + step-up walkability
Effort: M   Status: in-progress   (v1+v2 stair carve/props done -- 867766f; T-213b runtime unlock open)

**v1 landed**: `applyStairUnlock` helper + "found" stairs (lockedBy === null)
apply at tile boot. Wilderness plateaus reachable from boot via lerped ramps.

**v2 landed**: `placeStairs` spawns a visible voxel-staircase prop at every
narrative stair anchor. Stone variant for "found" stairs (the heightmap ramp
underneath makes them walkable); stone + iron-capped variant for "locked"
stairs (no ramp, wilderness wall still blocks — the iron cap reads as the
unlit gating cue). `Stair` server-only component carries `{stairId, toZoneId,
fromZoneId, trinketId, anchorXY, unlocked}` so the future unlock pipeline
has everything it needs to flip state at runtime.

**Remaining (T-213b — next ticket-or-extension)**:
- Runtime unlock: when a player consumes a trinket that matches a locked
  stair's `trinketId`, flip openMask + apply ramp + swap the entity's
  ModelRef from `model_stair_locked` to `model_stair` + broadcast a
  Heightmap-Δ + StairUnlocked event to AoI clients.
- Client heightmap-delta application — applying a ramp at runtime requires
  the client to re-mesh those chunks. Pattern exists for building-system
  edits; reuse it.
- Per-biome stair models (root stairs for grove, crag stones, …) — currently
  one stone shape for every biome.

T-210's stairs are currently only a *narrative* artifact — they
declare gating in `TileNarrative.stairs[]` but the engine still
blocks players at the wilderness boundary because the heightmap step
(wallHeight = 2u) exceeds `stepHeight`, and openMask still reads 0
on closed-kind pixels. T-212 originally proposed solving this with
a teleport interactable; this ticket says **no — make the stair a
real ramp the player walks up**.

Mechanism per StairInstance:

  1. RAMP CARVING. For each unlocked stair, modify the heightmap at
     the stair anchor and a small neighbourhood: lerp from path-floor
     height (≈0) at the path-side pixel up to wilderness-plateau
     height (= wallHeight) over a 3-5 pixel run. Width matches the
     stair's "tread" (3-4 pixels, configurable).
  2. OPENMASK FLIP. The ramp pixels become walkable: openMask = 1
     across the lerped run. Wilderness pixels reachable from the ramp
     also become walkable — but ONLY those connected to the unlocked
     stair (downstream flood-fill from the anchor, bounded by
     wilderness-zone id).
  3. PHYSICS CONTINUITY. Existing tile-server collision uses
     openMask + heightmap + stepHeight. Once openMask flips and the
     heightmap is lerped, the player naturally walks up — no new
     traversal mechanic.

Two states per stair:

  LOCKED — heightmap stays at full wall-height across stair pixels;
           openMask = 0; stair anchor renders as a visible prop
           (vertical "step" plate) so the player can see WHERE to
           climb once it unlocks.
  UNLOCKED — heightmap lerped to ramp; openMask = 1; the prop animates
           a brief "open" pose. Wilderness pixels behind the stair are
           now reachable; the player walks up naturally.

Wire deltas needed:

  - Heightmap delta over the ramp pixel range (small — typically <20
    pixels). Reuse the per-tile heightmap-Δ pattern that future
    building / digging will need.
  - openMask delta over the same range + the flooded-reachable
    wilderness pixels.
  - StairUnlocked event with stair id (so the client can play the
    open animation).

Visual:

  - Stair prefab at the anchor — small stone steps or vine-overgrown
    ramp depending on the wilderness zone's dominant kind (crag →
    stone steps, grove → root-stairs, hollow → grassy ramp). One
    prefab per wilderness role, picked at narrative-bake time.
  - Locked stairs are visible from the start so the player can plan
    ("I need to find a key for THAT stair").

Tests:

  - Snapshot: locked-stair heightmap == pre-stair heightmap byte-
    identical (so save/reload before any unlock reproduces).
  - Unlock event applies the heightmap delta deterministically — same
    stair on same tile always produces same delta.
  - Server-side collision integration test: player attempts to walk
    onto a wilderness pixel near a locked stair → blocked. Same
    pixel after unlock → walkable.
  - The flooded-walkable region is bounded by the wilderness-zone
    id; a wilderness pixel in a DIFFERENT wilderness zone is NOT
    reachable through this stair.

Out of scope:
- The stair PROP CONTENT (the actual 3D model variants per zone
  role). For v1, ship one generic "step plate" model and pick it for
  every stair; per-role visuals are a follow-up.
- T-212's POI runtime (encounters firing, bosses spawning) — that's
  the gameplay layer; this ticket is purely the physics + visual
  realisation of stairs.

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

### T-066 · Client roof rendering for enclosed areas
Effort: M   Status: todo

On `EnclosureChanged` event, client generates roof geometry over the enclosure polygon.
When the player entity is inside the enclosure, the roof is hidden (player sees interior).
When outside, the roof is visible.
Done when: an enclosed building renders a roof; walking inside makes the roof disappear.

## Animation & Render Verification

### T-275 · Animation freeze — locomotion clobbered by empty-slot idle fallback
Effort: S   Status: done

The user reported "the charactermodel is not animated." Root-caused live via the new animProbe
(T-277): the server WAS selecting the right clip (`walking`, time advancing) and the client WAS
translating, but the rendered skeleton pose was **byte-identical to idle** — the character slid
around frozen.

Cause in `tile-server/src/systems/animation.ts`: `projectLocomotion` is reused for all three
action slots (locomotion / primary / reaction) and resolved `slot?.actionId || "idle"`. The
`|| "idle"` fallback is correct for the **locomotion** slot (empty → idle, no rest-pose flash on
the first post-spawn tick) but wrong for **primary/reaction**: when not attacking/staggered those
slots are empty, so the fallback fabricated a **full-body, weight-1, override, unmasked** `idle`
layer that composited ON TOP of locomotion and overwrote the walk pose every frame. (`primary`
held `primary_idle`, which has no `animation` block → correctly projects nothing; the empty
`reaction` slot's idle fallback was the actual clobberer.)

Fix: scope the idle fallback with a `fallbackToIdle` param — only the locomotion call passes
`true`; primary/reaction stay silent when empty. Reuses the existing bone-mask layering
architecture (empty slots project nothing; real upper-body actions like swings/hits mask
themselves). Verified live: walk limb-articulation (relative to root) jumped 0.03 → 1.20 (~33× idle
baseline), layer stack dropped from `[walking, idle]` to `[walking]`. Parity test extended with the
"empty primary/reaction projects nothing" case.

### T-276 · Bake-pool resilience — worker-load failure must degrade to the sync bake
Effort: S   Status: done

Second "character not animated" failure mode (distinct from T-275; this one leaves no skeleton at
all). `client/src/render/bake_pool.ts` only registered `worker.onmessage`. A module-LOAD failure
(404 / wrong MIME / CSP blocking workers) does NOT throw from `new Worker()` — it fires an async
`error` event. Unhandled, `usingWorkers` stayed true, `bakeModel` posted to a dead worker, and its
resolve-only promise NEVER settled, so the renderer's `await bakePool.bakeModel()` hung →
`upgradeToSkeletonModel` never ran → the entity stayed an unrigged shell, frozen in rest pose.

Fix: honour the file's own contract ("the render path always has a result"). Register
`onerror`/`onmessageerror` → `#fallbackToSync()` (terminate workers, empty the pool so all future
bakes take the synchronous path, and resolve in-flight `#pending` entries via the same
`bakeDisplacedVoxel` the worker runs). Plus a per-request timeout backstop for a silently-dropped
message. Verified live via `BLOCK_WORKER=1` (T-277): with the worker aborted, `hasSkeleton` still
flips true and the character animates.

### T-277 · Headless animation test harness — animProbe + testInput + assertions
Effort: M   Status: done

`scripts/testplay.mjs ANIM=1` now asserts the character is actually animated, not just that a clip
id is on the wire. Added client test hooks: `game.animProbe()` (live AnimationState layers +
`renderer.sampleBoneWorld`/`hasSkeleton`), `game.testInput.down/up` → `IntentTranslator.pressKey/
releaseKey` (drives the REAL input path, since the browser canvas can't reliably receive synthetic
key events). Assertions: skeleton built (polled — survives the async bake), clip plays at rest,
idle near-static, player translates, locomotion clip while moving, **limbs sweep while moving**,
attack drives a primary action — plus walk/idle screenshots for the human "looks good" gate.

Key measurement lessons baked into the harness: (1) the limb-motion metric is the
translation-AND-rotation-invariant **inter-bone distance range** (a sliding/turning rigid body
preserves bone gaps; only a flexing pose changes them) — centroid-subtraction was too weak and read
walk == idle; (2) movement direction is fixed (no cursor → always one heading) and player position
PERSISTS between runs, so the test tries W/S/A/D until one is clear of terrain; (3) the whole
hold→sample→release loop runs in ONE in-page `evaluate` (cross-boundary key+poll raced under load);
(4) one-shot actions (attack) are re-pressed across a dense window so a press eaten by a stall can't
hide the brief swing. `BLOCK_WORKER=1` routes `bake_worker.js` to abort as the regression test for
T-276. Stable 7/7 across repeated runs in both normal and worker-blocked modes.

### T-278 · Keyboard control — game keys hijacked by browser defaults
Effort: S   Status: done

The user reported "we don't have full control over the keybindings" for the browser-hosted canvas.
`InputCapture` listened at `document` but never called `preventDefault`, so the browser ran its own
defaults for game keys: Space and the arrow keys scrolled the page, Tab stole focus, '/' opened
quick-find, etc. — fighting the game input.

Fix: inject an optional `preventDefaultFor(e)` policy into `InputCapture` (kept game-agnostic — the
predicate is supplied by `game.ts`). It swallows the browser default for `IntentTranslator.GAME_KEYS`
on bare presses, and deliberately does NOT when (a) a text field is focused (never hijack typing) or
(b) a ctrl/meta/alt modifier is held (so Ctrl+C/R/V, Ctrl+Shift+I and other OS/browser shortcuts
keep working). Verified live: Space/ArrowDown → defaultPrevented; KeyP, Ctrl+W, and Space-in-an-input
→ not prevented.

## Player UX

### T-072 · Respawn / heir flow UI
Effort: M   Status: todo   (core respawn-as-heir done in T-270; remaining: ritual UI + library/treasury)

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

## Heritage & Dynasty

### T-077 · Family library — tome storage at workbench
Effort: M   Status: done   (server substrate; deposit/withdraw UI deferred to T-072/T-076)

A special chest entity associated with the family workbench serves as the library. Stores Lore
tome items (T-018). Persists across character deaths (it is a world entity, not character
inventory). Heir can interact with it during the respawn ritual.
Done when: tomes placed in the library chest persist after character death; heir can access them.

### T-078 · Family treasury — gear storage across deaths
Effort: S   Status: done   (server substrate; equip-during-ritual UI deferred to T-072/T-076)

A second chest entity at the family workbench serves as the treasury. Stores equipment items.
Same persistence model as the library (T-077). Heir equips from here during respawn ritual.
Done when: items stored in treasury persist across deaths; heir can equip them.

Done (T-077 + T-078 share one primitive): a server-only **`Container`** component
([components/container.ts]) — entity-ref slots holding UNIQUE item entities (so each tome's
`Inscribed` and each weapon's `Durability`/`QualityStamped` is preserved per-instance, unlike the
stack-only `WorkstationBuffer`), gated by `kind` (library=tome / treasury=equipment) + `dynastyId`
(stamped from the placer's Heritage on deploy via `stampContainerOwner`). Two deployable chest
prefabs (`library_chest`/`treasury_chest`) + kits + recipes, plus the long-missing `tome`/
`blank_tome` prefabs the lore path already referenced (now boot-cross-checked). `storeInContainer`/
`withdrawFromContainer` ([systems/container.ts]) are dynasty+kind+capacity-gated entity-ref MOVES
(never copy/destroy). **Persistence** is the core work: `SaveManager` (VXM2 v4) now round-trips a
chest fixture AND the unique item entities its slots reference — a new `KIND_ITEM` record carrying
each item's instance components with the UUID preserved, emitted before the chest so slot refs
re-resolve on load (`ItemEffects` was also registered so it stops silently dropping on overlay).
"Persists across death" holds because the chest is its own world entity — `equip_cleanup`/disconnect
only walk a holder's `Equipment`/`Inventory`, never a `Container`. 17 deno tests (`container_ops`,
`container_persistence`): round-trip, death-survival, store/withdraw gates, heir-withdraw-and-equip.
**Deferred (client-drift):** networked Container + the deposit/withdraw + ritual UI — server-first,
network later, the same call buffs/modifiers/ActiveActions made.

### T-079 · Heir spawn at family workbench
Effort: M   Status: done

On character death, instead of direct respawn, create a new character entity at the family
workbench position. If the workbench was destroyed, heir spawns at a fallback location (tile
origin) in a weakened state.
Done when: death spawns an heir at the workbench; no workbench = displaced spawn.

Done: happy-path hearth spawn shipped in T-270; this closes the **destroyed-hearth weakened
fallback**. `resolveHeirSpawn(world, content, hearthAnchor, tileId)` ([heir_spawn.ts]) decides
the heir's spawn from the account `hearthAnchor` + LIVE world: standing hearth (a `WorkstationTag`
entity within `player.hearthDetectRadius` of the anchor) → spawn there; anchor here but no
workstation → the hearth is destroyed → displaced to default spawn + `weakened`. No destroy-event
plumbing needed — "still standing" is derived from world state. The hearth anchor is now cached
per-player at join (`playerHearthAnchors`) so an in-session respawn (no join msg) reaches it; this
also fixed the prior bug where `respawnPlayer` passed `null` and always fell to default spawn.
Weakened = the T-008 `Injury` pipeline: `installPlayer` writes the new `game_config.injuries.displaced`
debuff (moveSpeed ×0.7 through the modifier fold) + starts the heir at `displacedHealthFraction`
(0.5) of max HP. Server-only, no wire/save change. 6 deno tests in `heir_spawn.test.ts`.

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

## Species

### T-085 · Species visual variants — skeleton archetype mapping
Effort: M   Status: todo

Species definitions include a `skeletonArchetype` field that maps to a different skeleton
definition. Dwarf skeleton is shorter and wider; human is the default. Visual differentiation
without new animations — same animation set, different bone proportions.
Done when: a dwarf character renders with dwarf skeleton proportions; animations play on both.

---

## Item Durability

## World / Environment

## UI / Interaction

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

### T-191 · Devtools rebuild
Effort: L   Status: todo   (umbrella -- shell+voxel+anim Layer A shipped; closes when T-191z + T-191e land)

Scrap the current voxel-editor and build a coherent two-tool suite:
voxel/model designer + animation editor. Hard separation between data
tooling (Layer A — operates on raw ModelDefinition / SkeletonDef /
AnimationClip JSON, zero game-content imports) and game-content
overlays (Layer B — loads ContentService, lets you preview the
artifact in a game-like scene with prefab equipment / state machines /
maneuvers).

Lives next to atlas as a single served Deno+esbuild+Preact app with
two top-level routes (/voxel, /anim) sharing a common shell.

The old packages/devtools/voxel-editor retires at the end (T-191z).

Phasing → sub-tickets T-191a..e + T-191z.

### T-186 · Procedural character body generator (skeleton + voxel mesh)
Effort: L   Status: in-progress   (Layer 1 morph gen done via T-190; Layer 2 voxel recipe unbuilt)

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

Auxiliary work:
  - Posture-overlay layer: small additive AnimationLayer composed from
    slider values (backlean, slump, alert) — pure rotation offsets on
    a few torso/neck bones, runs alongside whatever Mixamo clip plays
    on the override layer. Mixamo motion stays intact; the base pose
    nudges by the slider amount.
  - Character-creator UI: live sliders mutate ModelRef.morphValues
    in-editor, baked to per-character permanent values on commit. Use
    only in the creator screen — for live characters morphs are
    immutable identity.
  - Foot IK pass when limbs scale far from authored proportions, so
    feet stay planted on terrain at extreme heights. ik_solver.ts
    exists; just needs wiring into the FK pipeline.

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

### T-274 · Dev docker stack errors — devtools crash-loop, gateway WT rebind storm, coordinator crash
Effort: S   Status: done   (three root-caused fixes from a bug-hunt; verified live)

`deno task compose-fresh` surfaced three real errors (separate from the known GatewayLink dial
noise). Found + fixed:
- **devtools crash-loop**: `docker/devtools.Dockerfile` still ran the deleted `scripts/build_voxel_editor.ts`
  (T-191z removed the script + `dev.ts`/`serve_devtools.ts` refs but missed the Dockerfile) → container
  exited 1 → `restart: unless-stopped` looped it forever. Fix: drop it from the cache + CMD (studio only).
- **gateway loses UDP/8080 WT listener for good**: every `deno run --watch=./packages` backend (gateway/
  coordinator/atlas/tiles) restarted whenever the client-dev/devtools esbuild watchers rewrote their
  `dist/` bundles (which live under the bind-mounted `./packages`). On that restart the gateway couldn't
  rebind UDP/8080 (Address already in use) → fell back to HTTP-only permanently → killed every tile↔gateway
  + coordinator↔gateway WT link (the permanent GatewayLink "timed out" flood was a *symptom* of this).
  Fix: `--watch-exclude=./packages/client/dist/** --watch-exclude=./packages/devtools/dist/**` on every
  watch service. NOTE: Deno's `--watch-exclude` does NOT comma-split — a single `a,b` value is one literal
  pattern that never matches; you must pass REPEATED flags. Verified live: touching dist no longer restarts
  the backends; the gateway keeps its WT listener.
- **coordinator crash on WT timeout**: `packages/coordinator/main.ts` lacked the `unhandledrejection` guard
  that `tile-server/main.ts` has, so a transient dial timeout (escaping the GatewayLink retry loop as an
  un-awaited rejection) killed the process. Fix: mirror the tile-server guard. Also fixed a pre-existing
  `coordinator.ts:162` TS error (`setInterval` → `ReturnType<typeof setInterval>`) so the package
  type-checks.

### T-261 · Place gates + arrivals at the carved corridor offset
Effort: M   Status: todo

Split from T-256 gap 4. Gates spawn at edge MIDPOINTS (`gatePositionForEdge` /
`mirrorPosition` use `TILE_SIZE / 2`) while atlas carves the only walkable corridor at the
shared `gate.offset` (`atlas_terrain.ts:192-205` reads `g.offset` then discards it; the
`GatePosition` wire type is edge-only). So a gate trigger — and the mirrored arrival point —
can land in a closed pixel: the gate is physically unreachable, or the handed-off player
arrives stuck in a wall.

Fix shape: carry the along-edge `offset` on `GatePosition` (scaled atlas-pixels → world units
via `TILE_SIZE / tile.gridSize`); `gatePositionForEdge` + `mirrorPosition` place along the
edge at that offset instead of the midpoint. Deferred from T-256 because it needs the live
multi-process render + an open-pixel check to verify the offset scale — shipping it blind
risks gates landing in walls (worse than the known-wrong-but-safe midpoint).

Done when: a gate sits on its carved corridor and a handed-off player arrives on an open
cell, verified against the atlas OpenMask.
