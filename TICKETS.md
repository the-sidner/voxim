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

### T-008 · Injuries — permanent debuffs from severe damage
Effort: M   Status: done   (Injury component + injury ModifierSource + severe-hit roll; unit-tested. Unblocks T-009)

When a single hit deals damage exceeding a configurable threshold, roll for an injury.
Write an injury component (type, severity) that applies a stat debuff until treated.
Example injury types: `broken_limb` (reduced speed/attack), `deep_wound` (slow health drain).
Done when: severe hits can produce injury components that apply persistent debuffs.

Landed via the Status/Modifier primitive (same pattern as species, T-084): server-only `Injury`
component holding `{ typeId, severity }[]`; an `injury` ModifierSource resolves each to its
`game_config.injuries[typeId]` debuff (additive penalties scale with severity), folded through
`effective()` so it composes with equipment/encumbrance/buffs/species. The health hit handler rolls
on any hit ≥ `combat.injuryThreshold` (25) with `combat.injuryChance` (0.35): picks an injury type,
adds it to the victim (re-injury of the same type deepens severity). Persists until treated (T-009).
Shipped injuries: `broken_leg` (×0.7 moveSpeed), `deep_gash` (−0.08 armorReduction → take more
damage). Targets live-queried stats only — the `deep_wound` health-drain DoT variant is a follow-up
(it wants the buff/Resource DoT tick, not a stat modifier). Unit-tested: each debuff via
`effective()`, severity scaling, stacking, absent-component and unknown-id inert.

### T-009 · Injury treatment via supernatural/alchemy workstation
Effort: S   Status: done   (treat recipe step heals the crafter's injury; unit-tested; pairs with T-008)

Add a `treat_injury` recipe type to the supernatural/alchemy crafting stations. Using it
removes the injury component from the target entity.
Done when: the correct crafting interaction removes an active injury component.

Landed: new `treat` recipe step-handler (`steps/treat_step.ts`, one handler + one register, mirroring
repair T-088). A swing at the recipe's `stationType` with a `stepType: "treat"` recipe selected and
its materials present heals the **crafter** (`ctx.hit.attackerId`): consume materials, reduce the
first `Injury` entry by one severity, removing the entry at 0 and the whole component once the last
injury clears. `RecipeStepType` gains `"treat"`; `data/recipes/treat_injury.json`
(alchemist_bench + 2× plant_fiber poultice). Repeated treatment compounds the material cost,
symmetric with repair. Unit-tested: severity decrement + material consume, last-severity clears the
component, nothing-to-treat and no-material no-ops.

## Stealth

### T-014 · Noise level component — run vs. crouch
Effort: S   Status: done   (NoiseLevel component + NoiseSystem derives it from speed × crouch; unit-tested)

Add a `NoiseLevel` component derived each tick from movement speed and crouch state. Running =
high noise; walking = medium; crouching = low. Written by `PhysicsSystem` or a new
`StealthSystem`.
Done when: `NoiseLevel` is present on moving entities and varies correctly with movement state.

Landed: server-only `NoiseLevel { level: 0..1 }` written each tick by a new generic `NoiseSystem`
over every actor (Velocity + InputState — players and NPCs alike). `level = min(1, speed/
maxGroundSpeed)`, scaled by `stealth.crouchNoiseMultiplier` (0.3) while the `Crouched` tag is set —
so sprint→1, crouch-walk is quiet, still→0. Consumed by NPC perception next (T-015 detection
gradient). Unit-tested: sprint/still/half/crouch/clamp and actors-only gating.

### T-015 · NPC detection radius driven by noise + distance
Effort: M   Status: done   (unified sight+hearing+proximity detection; consumes NoiseLevel; unit-tested)

In `NpcAiSystem`, replace binary proximity detection with a soft gradient: detection probability
scales with target noise level and inverse distance. Crouching at range may not trigger detection;
running nearby always does.
Done when: crouching entities are harder to detect at distance than running ones; NPCs react
proportionally.

Landed: the aggro scan (`findDetectedThreat`, replacing T-016's `findNearestThreatInArc`) now folds
three senses, target detected if ANY fires within aggro range — **sight** (forward cone, T-016),
**hearing** (`NoiseLevel × (1 − dist/range) ≥ aggroAuditoryThreshold`, T-014's noise, omnidirectional),
**proximity** (the short rear range, any direction). Chose a deterministic threshold over a per-tick
probability roll — same graded gameplay (a croucher at range escapes, a sprinter behind is heard,
frontal is always caught) without RNG flicker that would make NPCs twitch in and out of aggro.
Config: `aggroAuditoryThreshold` 0.15. Unit-tested: silent sight/proximity cases plus sprinter-heard /
croucher-at-range-missed / croucher-close-heard / out-of-range-however-loud.

### T-016 · Directional detection — NPC facing vs. target position
Effort: S   Status: done   (forward-cone aggro scan via findNearestThreatInArc; unit-tested)

Enemies facing away from the player have no detection. Add a facing arc check to NPC threat
detection: enemies detect within a forward cone at full sensitivity; rear detection only at very
short range.
Done when: flanking unaware NPCs is viable; frontal approach is consistently detected.

Landed: `findNearestThreatInArc` replaces the omnidirectional `findNearestNonNpc` in the
`set_job_attack_nearest` BT node — a target is seen at full `aggroRangeSq` only inside the NPC's
forward cone (`facing ± aggroConeHalfAngle`), and only within a much shorter `aggroRangeSq ×
aggroRearRangeRatio` behind/to the flank. The NPC's facing comes from its `Facing` component. Two
config knobs added to `npcAiDefaults` (cone half-angle 1.2217 ≈ ±70°, rear ratio 0.08 ≈ 28% of
frontal range). Flee detection stays omnidirectional (a different trigger). Unit-tested: front
detected, far-behind unseen, close-behind seen, flank unseen, nearest-eligible wins.

### T-017 · Light level detection modifier
Effort: M   Status: done   (findDetectedThreat scales aggro + rear ranges by getLightAt(pos) via game_config.npcAiDefaults.nightDetectionRangeMultiplier; pitch dark → half range, torches/fires restore it)

---

## Lore & Skills

### T-023 · Expanded skill loadout slots (6–8)
Effort: S   Status: done   (loreLoadoutCodec length-prefixed; game_config.player.skillSlots seeds the count; UI maps the array so it adapts)

Current `LoreLoadout` has 4 slots. Expand to 6–8 (TBD, set in `game_config.json`). Ensure codec
and UI handle variable slot count.
Done when: slot count is config-driven; codec encodes correctly at the new count.

## Crafting & Economy

### T-031 · Currency — coins as physical inventory item with weight
Effort: S   Status: done   (coins.json stackable prefab + 50 starting coins; trader machinery already referenced currencyItemType)

Add `coin` item template with a weight value. Coins stack in inventory up to a limit.
Trader transactions deduct/add coins from entity inventory (not an abstract balance).
Done when: buying from a trader deducts physical coin items; selling adds them.

### T-032 · NPC buy/need system — NPCs seek traders when need critical
Effort: M   Status: obsolete   (premise dead: hunger/thirst are Resources now (T-238), no NPC currency; the intent — NPCs handling hunger/thirst emergencies — is already met by the seekFood/seekWater jobs finding ground consumables, wired into passive.json)

When an NPC's hunger/thirst reaches a threshold and it has coins, add a `seek_trader` job:
find the nearest trader NPC with food/water, buy from them if currency is sufficient.
Same mechanic for tool needs (NPC without hammer seeks a trader selling hammers).
Done when: hungry NPCs with coins autonomously locate and buy food from trader NPCs.

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

### T-038 · Hiring workbench as craftable deployable
Effort: S   Status: done

The hiring workbench is currently hardcoded at spawn. Make it a craftable deployable item that
the player places in the world. Placed instance creates a `WorkbenchOwner` component with the
placer's dynasty ID.
Done when: players can craft and place hiring workbenches; ownership is tracked.

Landed: `job_board_assemble` recipe (workbench assembly, wood + cloth → stackable
`job_board_kit`); the kit deploys into the existing `job_board` prefab. New server-only
`WorkbenchOwner {dynastyId}` component, stamped by an EntityDeployed subscriber in server.ts when
a `job_board` is placed (reads the placer's Heritage.dynastyId). Sets up T-082 (base capture).

### T-039 · NPC sleep need + bed infrastructure
Effort: M   Status: done

Add `Sleep` as an NPC need alongside `Hunger`/`Thirst`. Add a `bed` deployable. When sleep need
is critical, NPC seeks the nearest unoccupied bed and fulfills it. No bed = NPC enters permanent
low-performance state or eventually leaves.
Done when: NPCs seek and use beds; missing beds cause retention problems.

Landed: `sleep` ResourceDef (tiredness rises while awake, exhaustion DPS at max) seeded on
every NPC; `seekBed` job + `check_sleep_critical`/`set_job_seek_bed` BT nodes wired into the
passive tree (mirrors the hunger/thirst seek pattern); stateless bed (`bed` placeable prop +
`bed_kit` deployable, found by `SpawnedFrom` prefab id, first-come proximity). Tuning in
`game_config.npcAiDefaults` (sleepEmergency / seekBedTicks / bedSleepRestore / bedRangeSq).

### T-040 · NPC sensory system — proximity event subscription
Effort: M   Status: todo

NPCs currently detect threats via direct distance checks. Replace with event-bus subscriptions:
NPCs subscribe to `DamageDealt`, `EntityDied`, `LoudNoise` events within their detection radius.
Guards subscribe broadly; labourers subscribe narrowly.
Done when: nearby combat events trigger NPC awareness without per-tick distance scans.

### T-041 · NPC Lore accumulation through job execution
Effort: M   Status: obsolete   (premise dead: NPCs carry no LoreLoadout since T-260b — spawner.ts:221 "NPCs don't learn lore"; their behaviour is weapon/archetype triggers (T-259), not learned fragments. Same retirement as T-042)

When an NPC completes a job of a type it can learn from (crafting, building, gathering), increment
an internal Lore experience counter. At a threshold, add the relevant fragment to the NPC's Lore
set. Slower and with a smaller fragment ceiling than players.
Done when: a blacksmith NPC gains crafting-related Lore over many crafting jobs.

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

### T-043 · NPC social idle behaviour
Effort: S   Status: done   (idle NPCs drift toward a nearby fellow → emergent clustering; unit-tested)

When an NPC's job queue is empty, rather than standing idle, it wanders within a home range and
occasionally emits a `SocialIdle` event. Nearby NPCs react by moving closer briefly. Simple,
low-cost — flavour over simulation.
Done when: idle NPCs appear to socialise with nearby NPCs rather than standing frozen.

Landed via an **emergent** model rather than the broadcast-event one — simpler and reads the same:
`set_job_default` now, `socialIdleChance` (0.35) of the time, drifts a mobile idle NPC toward the
nearest fellow within `socialScanRadius` (12u), stopping ~1.5u short so they gather *around* each
other. When several idle NPCs each seek their nearest neighbour they converge into loose clusters —
"socialising" — without any SocialIdle event or reaction plumbing. Gated on `wanderRadius > 0`, so
stationary vendors (the merchant at its stall) never wander off. New `findNearestNpc` helper;
`socialIdleChance` + `socialScanRadius` config. Unit-tested: nearest-fellow selection (excl.
self/players/out-of-range), mobile drift toward a fellow, stationary NPCs staying put.

### T-144 · NPC ground-drop pickup pathway
Effort: S   Status: done   (gather_resource collect phase; chop → sweep its drops → next node; unit-tested)

NPCs that gather resources (and any future job that produces a world ItemData entity instead of
writing directly to the harvester's inventory) currently never collect their own drops. Background:
the player-facing `ItemPickupSystem` was deleted in favour of explicit PickUp commands; that system
already excluded NPCs (`if (world.has(collectorId, NpcTag)) continue`), so removing it changed
nothing for the NPC path — but the original `gather_resource` job docstring was aspirational and
assumed pickup happened automatically. It doesn't. Today a forester chops a tree, the logs spawn
on the ground next to it, and the NPC walks away empty-handed.

The fix lives inside the existing `JobHandler` pattern. Two reasonable shapes:
  - Extend `gather_resource` so after depleting the node it transitions into a "collect spawned
    drops" sub-state: scan ItemData entities within a small radius of the node whose `prefabId`
    matches the job's `itemType`, walk to each in turn, fold into Inventory, destroy the world
    entity. Job completes when the inventory threshold is met OR no more matching drops in range.
  - Or: a small dedicated `pickup_drops` job that `gather_resource` enqueues on depletion, with
    args `{ near: {x,y}, itemType, radius }`. Reusable by future producers (mining, butchering).
The implementer picks; the second is cleaner for reuse but heavier today.

Two interactions worth handling:
  - With T-129's drop-ejection physics, drops have non-zero Velocity for ~0.4s after spawn.
    Either wait for Velocity to be removed (settled) before collecting, or accept that the first
    pickup attempt may chase a moving target — collecting on settled-only is simpler.
  - Inventory-full case: the NPC just leaves the drops on the ground (matches the player flow);
    don't silently void overflow.

Done when: a forester NPC depletes a tree, walks to each dropped log, and the logs appear in its
inventory before it transitions to its next job. Verified via the NPC inventory tooltip and the
ground entity count returning to baseline near the node.

## World & Macro Simulation

### T-048 · Caravan entity — NPC group with goods + destination
Effort: M   Status: todo

A caravan is a group entity: lead NPC + guard NPCs + goods inventory + destination tile.
The lead NPC navigates to a gate; at the gate, the caravan crosses tiles via the gate system.
Goods are physical items in the caravan inventory — raidable.
Done when: a caravan entity can be dispatched, navigate to a gate, and be intercepted.

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

### T-258 · Control-plane auth — pre-launch blocker
Effort: M   Status: todo

**Deliberately deferred: not relevant while dev-only. Must land before anything is publicly
reachable.** The secret machinery exists (`X-Voxim-Service-Secret`,
`constantTimeEqualStrings`) but only guards `/internal/*` (2026-06 review):

- Tile admin `/handoff`, `/jobs`, `/assign-job-board` accept any POST — `/handoff` writes
  attacker-supplied Health/Inventory/Equipment via `restorePlayer`; the port binds
  `0.0.0.0` and also serves the client assets, so it is public by design
  (`admin_server.ts:42-118`).
- Gateway `/register`, `/heartbeat`, `/handoff` are unauthenticated
  (`gateway/src/server.ts:156-158`) — registry poisoning routes clients (and handoff
  payloads carrying player state) to an attacker.
- Atlas `POST /world/bake` + `/restart` are public via Caddy with CORS `*`
  (`atlas/src/server.ts:114`, `docker/Caddyfile:32-42`) — any third-party web page can bake
  a new world, exiting every tile-server and the coordinator.
- Fail-open: without `VOXIM_SERVICE_SECRET`/`GATEWAY_URL` the join path accepts any claimed
  playerId (`server.ts:1344-1348`); the dev-secret fallback has no production guard.

Fix: require the service secret on every mutating control-plane endpoint (tile admin,
gateway register/heartbeat/handoff, atlas bake/restart); split admin off the public asset
port or bind it non-public; fail closed in production when the secret is unset.

Done when: every mutating endpoint rejects requests without the secret; production with a
missing secret refuses to boot instead of running open.

---

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

### T-063 · Cave instance tile type
Effort: M   Status: done

Cave instances are tiles with enclosed-rock generation (walls + floor = rock material, no open
sky). A cave gate on a surface tile links to a cave tile ID. Cave tiles are generated with the
same tile generator, just with different biome parameters (cave biome).
Done when: a surface gate can link to a cave tile; cave tile generates correctly.

v1 landed: rock-dominant `cave` biome (`instanceOnly` so it never wins the overworld cascade);
`parseTileId` now discriminates overworld `cellX_cellY` from the cave instance form
`cave_<x>_<y>_<level>`; `caveInstanceTerrain` generates an enclosed stone tile via the world
generator with `WorldGenContent.forcedBiome` bypassing classification; `GateSpec.instanceType?:
"cave"` lets a gate point at a cave instance. The live stair→instance→exit runtime loop is
multi-process territory (T-212) — only the cave tile TYPE is generable + parseable here.

### T-064 · Dynamic chunk loading/unloading by entity proximity
Effort: M   Status: todo

Currently all chunks for a tile are loaded at startup. Load a chunk entity into the world only
when a player or active NPC is within a configurable radius. Serialise and unload chunks with
no nearby entities after a grace period.
Done when: distant chunks are absent from world store; they load when an entity approaches.

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

### T-065 · Enclosure detection on server
Effort: L   Status: todo

Server detects enclosed areas: a closed loop of wall entities forms an enclosure. Compute this
when walls are placed or destroyed. Emit `EnclosureChanged` event with enclosure polygon.
Client uses this to decide whether to render a roof.
Done when: placing walls in a closed rectangle produces an `EnclosureChanged` event with correct
polygon; destroying a wall removes the enclosure.

### T-066 · Client roof rendering for enclosed areas
Effort: M   Status: todo

On `EnclosureChanged` event, client generates roof geometry over the enclosure polygon.
When the player entity is inside the enclosure, the roof is hidden (player sees interior).
When outside, the roof is visible.
Done when: an enclosed building renders a roof; walking inside makes the roof disappear.

### T-067 · Model baking in Web Worker
Effort: M   Status: todo

Move `buildDisplacedVoxelGeo` (and the full model baking pipeline) off the main thread into a
Web Worker. Main thread sends model definition; worker returns a baked `BufferGeometry` (or
transferable geometry data). Game loop never stalls during baking.
Done when: loading a complex model does not drop frames; the main thread continues rendering
while the worker bakes.

## Player UX

### T-071 · Character creation screen
Effort: M   Status: todo

On first connection (or after dynasty wipe), show a character creation screen: species selection
(visual only; minor passive trait), starting Lore fragment selection (from a small initial set).
Done when: new player completes character creation and spawns as a properly initialised entity.

### T-072 · Respawn / heir flow UI
Effort: M   Status: todo   (core respawn-as-heir done in T-270; remaining: ritual UI + library/treasury)

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

### T-075 · Trader interaction UI
Effort: M   Status: done   (full interaction flow: decode→handler→panel→dispatch; merchant placed; verified end-to-end via testplay harness)

When interacting with a trader NPC, show a buy/sell panel: trader's goods + prices on one side,
player's inventory on the other. Transaction deducts/adds physical coin items (T-031).
Done when: player can buy and sell items with a trader NPC via a UI panel.

Landed: client now decodes the networked `traderInventory`; `makeTraderHandler` opens the panel
on interact (range-gated); `_openTrader`/`_mirrorTraderToUi` build buy offers (all listings, live
stock) + sell offers (listings the player holds), refreshed on every state-message touching the
trader or player; `trade_buy`/`trade_sell` UIActions dispatch `TradeBuy`/`TradeSell` by listing
slot (the server keys both by slot). `Btn` widened to accept `disabled`. A stationary merchant
("Edda the Trader", `wanderRadius: 0`) was placed near spawn in `tile_layout.json`. Verified with
`scripts/testplay.mjs`: buy berries → coins −3, berries +1, server `buy:` log; sell → coins +1,
berries −1, server `sell:` log; panel screenshot confirms both columns render.

### T-076 · Job board UI
Effort: M   Status: todo

Panel for the hiring workbench: list of current jobs (type, priority, status), add/remove/
reprioritise jobs. Show which NPCs are assigned to which jobs. Simple, not real-time — refreshes
on open.
Done when: player can post and manage jobs via the workbench UI.

---

## Heritage & Dynasty

### T-077 · Family library — tome storage at workbench
Effort: M   Status: todo

A special chest entity associated with the family workbench serves as the library. Stores Lore
tome items (T-018). Persists across character deaths (it is a world entity, not character
inventory). Heir can interact with it during the respawn ritual.
Done when: tomes placed in the library chest persist after character death; heir can access them.

### T-078 · Family treasury — gear storage across deaths
Effort: S   Status: todo

A second chest entity at the family workbench serves as the treasury. Stores equipment items.
Same persistence model as the library (T-077). Heir equips from here during respawn ritual.
Done when: items stored in treasury persist across deaths; heir can equip them.

### T-079 · Heir spawn at family workbench
Effort: M   Status: todo   (happy-path heir spawn at hearth done in T-270; remaining: destroyed-hearth weakened-state fallback)

On character death, instead of direct respawn, create a new character entity at the family
workbench position. If the workbench was destroyed, heir spawns at a fallback location (tile
origin) in a weakened state.
Done when: death spawns an heir at the workbench; no workbench = displaced spawn.

### T-080 · Dynasty reputation persistence in NPC world
Effort: M   Status: todo

NPC city relationship maps (T-044) store reputation by dynasty ID, not character ID. On heir
spawn, the new character inherits the dynasty's relationship standing with all cities. Actions
by previous characters (king-killing, trade betrayals) persist as dynasty history.
Done when: a new heir faces the same NPC city attitudes as their predecessor.

---

## Territorial Control

### T-081 · Workbench ownership + NPC deauthorisation on destruction
Effort: S   Status: done   (already satisfied by the self-healing execute_assigned_job node; premise obsolete; now test-locked)

`WorkbenchOwner` component already exists. When a workbench entity is destroyed, emit a
`WorkbenchDestroyed` event. NPCs assigned to that workbench receive the event, clear their
job board association, and enter idle/neutral state.
Done when: destroying a workbench causes its NPCs to go neutral within a configurable number
of ticks.

Resolution: the premise is obsolete — `WorkbenchOwner` does not exist, and there is no
`WorkbenchDestroyed` event. The goal is nonetheless already met by a **pull** model rather than the
described **push** one: the `execute_assigned_job` BT node checks each tick whether its
`AssignedJobBoard.boardId` still resolves to a live `JobBoard` entity; when it doesn't
(`!board || !isAlive`), it removes its own `AssignedJobBoard` marker and returns failure, so the
selector falls through to idle/wander (neutral). The NPC goes neutral on its next BT tick, however
the board vanished (combat, despawn, AoI, reload) — strictly more robust than a one-shot event.
Closed by adding the missing regression test (`execute_assigned_job.test.ts`): board-gone → marker
cleared + failure; live board → assignment kept.

### T-082 · Base capture flow — place new workbench to claim
Effort: S   Status: todo

After an enemy workbench is destroyed (T-081), the attacker places their own workbench at the
location. Placed workbench assigns its owner's dynasty ID. Former NPCs, now neutral, can be
re-hired via the new workbench.
Done when: capturing a base by destroying and replacing the workbench gives the attacker control
of the management layer.

### T-083 · Family-tagged asset persistence after capture
Effort: S   Status: todo

Deployable entities (chests, furniture, structures built by a dynasty) carry a `DynastyTag`
component. After a base capture, tagged assets remain in the world but their dynasty tag
persists — they are not transferred to the new owner automatically. This is a persistent
grievance/motivation mechanic.
Done when: a captured base still has the original dynasty's tagged assets; a new owner does not
automatically inherit them.

---

## Species

### T-084 · Species component with minor passive trait
Effort: S   Status: done   (Species component + game_config.species + species ModifierSource; unit-tested)

Add a `Species` component: `{ speciesId: string }`. Add species definitions to a new
`species.json` data file. Each species has a small passive trait (e.g. dwarf: +5% base health;
human: no modifier). Species is set at character creation (T-071).
Done when: species component is present on player entities; passive trait applies to base stats.

Landed: server-only `Species { speciesId }` component, written on every player at spawn from
`game_config.player.species` (default "human"); boot cross-checks the default exists. Species defs
live in `game_config.species` (human/dwarf/elf) as `StatModifier` lists — the trait applies through
the Status/Modifier primitive's `effective()` fold via a new `species` ModifierSource, composing
with equipment/encumbrance/buffs over one path (no bespoke stat code). Chose the lighter
game_config home over a new content category + bootstrap surface for a handful of species; promote
to its own category when character creation (T-071) makes it player-facing.

Note: traits target stats the server queries live via `effective()` — today `moveSpeed` and
`armorReduction` (dwarf: +0.1 armorReduction, ×0.92 moveSpeed; elf: ×1.1 moveSpeed). The ticket's
"+5% base health" example needs `maxHealth` routed through `effective()` at spawn (it's set once
today and never re-queried) — a follow-up if health-class traits are wanted. Unit-tested:
dwarf/elf/human folds, missing-component and unknown-id are inert.

### T-085 · Species visual variants — skeleton archetype mapping
Effort: M   Status: todo

Species definitions include a `skeletonArchetype` field that maps to a different skeleton
definition. Dwarf skeleton is shorter and wider; human is the default. Visual differentiation
without new animations — same animation set, different bone proportions.
Done when: a dwarf character renders with dwarf skeleton proportions; animations play on both.

---

## Item Durability

### T-086 · Item durability scalar component
Effort: S   Status: done   (deriveItemStats.maxDurability + installDurability at spawnEquipEntity & crafting; drain was already live)

Add `Durability: { current: number; max: number }` component to all equippable items at spawn.
This is independent of material quality — two steel swords can be at different durability states.
Done when: equipped items have a durability component; it serialises and syncs to client.

### T-087 · Durability drain from use (combat + crafting)
Effort: S   Status: done   (combat resolver drains the equipped item 1/swing -- combat & harvest -- and destroys at 0; live once items carry Durability)

Each successful combat hit with a weapon reduces its durability by a configurable amount.
Crafting tool use similarly drains the tool. At zero durability, item becomes unusable.
Done when: weapons and tools degrade from use; reaching zero makes them inoperable.

### T-088 · Durability repair via crafting workstation
Effort: S   Status: done   (repair recipe step-handler restores durability + consumes material; unit-tested)

Add a repair recipe type: item + repair material → restored durability. Repair at the
appropriate workstation (anvil for metal, workbench for wood). Repair restores a fixed amount,
not full — repeated repairs compound material cost.
Done when: player can repair a degraded item at a workstation to partially restore durability.

Landed: new `repair` recipe step-handler (`steps/repair_step.ts`, registered in
`registerBuiltinSteps` — one handler file + one `register()`, the doctrine). On a hit at the recipe's
`stationType` with a `stepType: "repair"` recipe selected, it finds the worn unique Durability item in
the buffer, verifies + consumes the recipe's material inputs (reusing `tryAssignRoles` +
`consumeFromBuffer`), and adds `repairAmount` to the item's `remaining` capped at max — the item is
kept, only materials are spent, so repeated repairs compound the material cost without overfilling.
`RecipeStepType` gains `"repair"`; `Recipe.repairAmount?` added; `data/recipes/repair_metal.json`
(anvil + iron_ingot → +40, hammer-gated). Unit-tested: restore+consume+keep, max cap, no-material
no-op, wrong-tool no-op, full-item left alone.

---

## World / Environment

### T-090 · Room detection and enclosed-wall system
Effort: L   Status: obsolete   (its consumers are gone/superseded: the corruption "shelter bonus" was removed wholesale (T-238e), and the live server-side enclosure work is T-065. Re-spec against T-065 if room semantics are wanted again)

A room is a contiguous enclosed volume formed by placed wall/floor blueprint structures.
Room detection runs as a server-side flood-fill over the structure grid after each build event.
Detected rooms receive a `RoomTag` entity with area, enclosure quality (0–1), and an interior
cell set. Downstream consumers: warmth bonus (fireplaces raise interior temperature), shelter
bonus (reduces corruption gain), NPC pathfinding prefers enclosed spaces for settling.
Done when: placing walls that form a closed loop creates a detectable room entity; room dissolves
when a wall is removed; interior cells are queryable by other systems.

---

## UI / Interaction

### T-273 · Discrete commands ride unreliable datagrams — they can silently drop
Effort: M   Status: done

Landed: discrete commands now ride a dedicated reliable command bidi stream (client opens it after
the content stream; `sendCommand` length-prefixes `commandDatagramCodec` output via `encodeFrame`).
Server `ClientSession.serveCommands` frame-reads + decodes into the same `commandQueue`; the command
branch is removed from `receiveInputs` so datagrams carry movement only. Movement stays unreliable.

`TileConnection.sendCommand` writes `CommandDatagram`s on the WebTransport **datagram** (unreliable)
path, same as movement. For ~60 Hz latest-wins movement that's correct, but discrete one-shot
commands — `Equip`, `Place`, `TradeBuy`/`TradeSell`, `SelectRecipe`, `LoadWorkstation`, `PickUp`,
`Respawn` — have no delivery guarantee: a dropped datagram means the action just never happens, with
no client feedback. Surfaced while verifying T-075 with the test-play harness: under load a buy/sell
press would intermittently produce no server `TradeSystem` log at all (the command never arrived).
The `CommandDatagram.seq` field exists but nothing acks or resends.

Fix shape: deliver discrete commands over a **reliable** channel (a dedicated bidirectional stream,
length-prefixed via the existing `encodeFrame`/`makeFrameReader` helpers), keeping only movement on
datagrams. Server drains the command stream into the same per-player `commandQueue` it already uses,
so systems are unchanged. Alternatively, an ack+resend layer keyed on `seq`, but a reliable stream is
simpler and the command rate is low. Movement stays unreliable.

Done when: a discrete command issued by the client is guaranteed to reach the server (or surfaces a
visible failure), verified by hammering buy/equip presses through the test-play harness with zero
silent drops.

### T-091 · Workstation recipe browser and selection UI
Effort: M   Status: done   (recipe browser: all station recipes, clickable → SelectRecipe; verified via testplay harness)

Currently the workstation CraftingPanel only shows auto-matched items; there is no way to
browse or select a recipe. The workstation needs a recipe list panel showing all recipes valid
for this station type. Clicking a recipe locks it as the `activeRecipeId` on WorkstationBuffer
(server command via CommandType.SelectRecipe). Input slots then show required ingredients;
items placed that don't match the locked recipe are rejected. Time-based recipes (smelt, cook)
auto-start once all ingredients are present.
Done when: player can open a workstation, browse its recipe list, select one, and place
matching items to start crafting.

Landed: `findStationRecipes` lists every recipe for the open station's type (not just buffer-
matched); each renders as a clickable `RecipeRow` showing output label + input summary + a
ready dot (buffer satisfies inputs), the active recipe highlighted. Clicking dispatches the new
`select_recipe` UIAction → `CommandType.SelectRecipe`; the server's existing `_handleSelectRecipe`
locks `activeRecipeId` (range-gated, lore-gated). `humanizeItemType` extracted to
`ui/item_names.ts` (shared by game.ts + the panel). Verified with `scripts/testplay.mjs`: walk to
the workbench, open it, select `bowstring_assemble` → `activeRecipeId` reads back + server
`select-recipe` log; panel screenshot shows the highlighted active recipe over the full browse list.

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

### T-191e · Weapon sweep debugger + per-clip attachment overrides
Effort: M   Status: obsolete   (premise dead: swingPath keyframes were retired for clip-driven baseLocal/tipLocal blade geometry — zero swingPath in content; a sweep debugger would visualise a system that no longer exists)

Deepest piece. Sits inside the animation editor.

Per-frame visualisation of a WeaponActionDef's attachment math:
  - swingPath keyframes as a 3D curve in hand-local space.
  - interpolated tip position at scrubbed t.
  - projected world-space blade capsule per tick of the active
    window.
  - hand bone matrix vs forearm-blended matrix side-by-side, so we
    can compare smoothing strategies (multi-frame averaging,
    forearm/hand weighted blend, authored override) and pick what
    looks right per clip.

Per-clip attachment override system:
  data/clip_overrides/{clipId}.json — optional override for
  baseLocal/tipLocal/holdHand applied when this clip is played.
  Engine's evaluateBladeWorld falls back to the override map before
  the weapon action's default. The animation editor lets you
  manipulate the attachment gizmo at any frame and save it.

Blocked on: T-191c (skeleton + clip player). Also waiting on user's
weapon-smoothing investigation before locking in the smoothing
algorithm.

Done when: pick any sword+slash combo, scrub the swing, see the
blade match what's drawn in-engine; if the hand wobbles, save an
override frame-by-frame and the game client renders the corrected
attachment.

### T-191z · Retire old voxel-editor
Effort: S   Status: done

Deleted packages/devtools/src/voxel-editor/ + scripts/build_voxel_editor.ts
+ VOXEL_EDITOR_PLAN.md wholesale; dropped the build-voxel-editor deno task
and its prefix from the devtools/dev pipelines; serve_devtools now serves the
studio at both / and /studio; devtools/mod.ts points at the studio entry. The
studio is the only devtools app and `deno task build-studio` stays green.

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

### T-187 · Runtime dual-slot equip for hand items
Effort: S   Status: done   (EquippableData.slot → slots[]; first-empty-candidate routing; unit-tested)

Today `EquippableData.slot` is a single `EquipSlot`. Weapons declare
`slot: "weapon"`, so EquipmentSystem can only ever route a sword into
the main-hand slot — picking up a second sword from inventory cannot
fill the off-hand. Spawn-time bypasses this (the spawner writes
startingEquipment directly without slot validation, which is how the
default dual-wielding player already works), but the inventory→equip
flow doesn't.

Path: change `slot: EquipSlot` to `slots: EquipSlot[]` (single-item
arrays for everything that exists today; weapons declare `["weapon",
"offHand"]`). EquipmentSystem iterates the list and equips into the
first empty slot, with an optional client-supplied target slot to
disambiguate. Migrate every existing prefab + the codec + the typed
schema in one diff (rule: refactors replace, no shim). Done when
picking up a second sword and equipping it lands it in the off-hand
visually + on the wire, and unequipping main-hand then re-equipping
that sword routes it correctly.

Landed: `EquippableData.slot: EquipSlot` → `slots: EquipSlot[]` (content type +
valibot schema + server-only codec, now length-prefixed). The Equip handler lands
the item in the first declared slot that's free, rejecting only when all
candidates are occupied. All 10 equippable prefabs migrated in the same diff
(weapons → `["weapon","offHand"]`, cloth_tunic → `["chest"]`); no shim. The
optional client-supplied target slot was left out — first-empty routing already
satisfies the done-when; add it only if a real disambiguation need appears.
Unit-tested: off-hand fill when main hand taken, main-hand-first when both free,
all-occupied rejection, single-slot armour routing. (Removed a block of stale
"maneuver" design that had been pasted into this ticket — it described the
retired CSM/ActionSystem/ManeuverScheduler, gone since T-228.)

## Ops & Deployment

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

### T-268 · Devtools studio de-drift (CSM-era animation editor)
Effort: M   Status: done

Removed the dead CSM/maneuver scaffolding: deleted ManeuverPanel.tsx +
StateMachineDef/loadStateMachine + ManeuverDef/listManeuvers (zero callsites,
no data/maneuvers or data/state_machines dirs); dropped maneuvers/state_machines
from ANIM_DIRS and the serve_devtools writable prefixes; removed the maneuver
tab + onManeuverTick/onManeuverIdle + the SM-era loadClipById helper. The
animation editor docstring now describes the live constraint-pipeline /
ActionDispatcher model. `deno task build-studio` stays green.

The studio animation editor was built around the retired CSM / state-machine model (T-228).
T-267-adjacent work removed the immediate build blocker (the SMDriverPanel, which imported the
deleted `compileStateMachine`/`smTickAll`/`initialSMState` from `@voxim/content`) so the devtools
container stops crash-looping. But residual CSM-era scaffolding remains, none of it build-breaking
(esbuild erases the dead type imports):

- `content_loader.ts` still exports `StateMachineDef` + `loadStateMachine` (state_machines/*.json)
  with no consumer.
- `ANIM_DIRS` keeps `state_machines` in the browsable list though the tab is gone.
- The maneuver tab / `ManeuverPanel` / `onManeuverTick` are likely also retired-era (the maneuver
  runtime was removed at T-228) — verify and remove if dead.
- The animation editor should be re-grounded on the current model (action runtime + the
  constraint-pipeline animation), not state machines.

Done when: the studio animation editor reflects the current animation architecture with no
CSM/state-machine or maneuver-runtime remnants, and `build_studio.ts` stays green.

### T-272 · Agent test-play harness (Playwright)
Effort: S   Status: done   Commit: f77c28d

A headless harness (`scripts/testplay.mjs`) that drives the real browser client so the agent can
verify gameplay end-to-end instead of reasoning blind: **see** (screenshot the rendered scene +
HUD), **drive** (keyboard input steps), **read** (live world state — own entity position, health,
resources, AoI entity count via `window._voxim_game`), and **correlate** (merge client-console +
tile-server + gateway `docker logs` onto one millisecond timeline, GatewayLink dial-noise filtered).

Connects in gateway mode: auths against the gateway (`/account/login` → falls back to `/account/register`)
for a real session token, injects it via `addInitScript(VOXIM_SESSION_TOKEN)`, and connects through
the gateway → tile (the docker tile validates tokens, so direct-tile/dev-token is rejected). Env knobs:
`STEPS` (input script), `OUT` (screenshot path), `LOG_GREP` (keep only matching log lines),
`HEADLESS=0` (watch live), `TILE_C`/`GW_C` (container names).

Proven: full join handshake visible across both sides of the wire; `W`-walk moves the player
(`x:256→261`); skill casts consume stamina (`100→77`); the rendered scene + HUD (vitals/skill bar/
hotbar/minimap) screenshot correctly.

Done when: `node scripts/testplay.mjs` connects, screenshots the running game, and prints a correlated
CLI/SRV/GW log timeline. ✓
