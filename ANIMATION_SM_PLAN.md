# Character State Machine — Implementation Plan

**Status:** design locked, not yet implemented. Continues in a new session.
**Tickets:** extends T-182 (Character state machine runtime + actor SMs as data) and adds a sister scope for clip-driven weapon attacks (call it T-184 when filed). T-185 covers `SkillInProgress` retirement, folded into T-184 since the migrations are inseparable.
**Last commit on this work:** `3e9d66c` (320 Mixamo clips imported into biped library).

> **Reframe note (2026-05-09).** This plan was originally scoped as an "animation state machine." That framing was too narrow — the data model already generalised to any composable character mode (posture, combat, locomotion, reaction). The plan is now a **Character State Machine (CSM)**: the shared mode-tracking layer for every actor in the game (players, NPCs, mobs, critters, animals). Animation is one consumer, not the purpose. See "Architecture" below.

---

## Why this matters

The biped library now has 367 animation clips (T-178 → T-180). What's missing
is a structured way to *select* which clip plays when. Today that selection
lives as hardcoded `if/else` cascades in
[`tile-server/src/systems/animation.ts`](packages/tile-server/src/systems/animation.ts).
The user wants it data-driven so adding a new creature behavior is a JSON
edit, not a code change.

But "which clip plays" is a downstream consequence of a deeper question:
**what mode is this character in right now?** Today that information is
scattered — `SkillInProgress.phase` says "swinging," raw input bits say
"block held," there's no component that says "crouching," velocity magnitude
implies "running." Everyone re-derives. No shared answer.

The CSM is that shared answer. Every actor — player, NPC, mob, critter,
animal — runs the same SM runtime, against a per-prefab SM definition,
producing a stable set of layer-node values that everyone can query:

> "Am I crouching, facing that direction, mid-attack with this weapon, being
> hit, blocking, jumping?" — answered by reading CSM layer nodes.

Animation systems read the CSM and project nodes to clips. Damage handlers
read the CSM to gate mitigation. AI threat assessment reads it to decide
target selection. The mode lives in one place; everyone consumes it.

A second-but-related rework: attack animations come from clips, not from
IK-driven swing-path keyframes. This falls out naturally — once the combat
layer has a `swing` state with a clip reference, the IK swing-path system
is redundant.

---

## Architecture: layered state machine, typed outputs

Layers run in parallel each tick. Each layer is one orthogonal axis of
character state. Layers compose without exploding into N×M states:
`locomotion=airborne` + `combat=swing.active` + `posture=upright` is just
three independent values, not an `airborne_swinging_upright` super-state.

### Layer outputs are typed

A layer declares what its node value projects to:

| `output` | Effect | Examples |
|---|---|---|
| `"animation"` | Contributes one bone-masked clip slot to `AnimationLayer[]` | `locomotion`, `combat`, `reaction` |
| `"flag"` | Exposes a queryable bool/enum for other systems to read | `posture` (crouching), `stance` (combat-ready) |
| `"mode"` | Internal-only; used by other layers' transitions; no external visibility | sub-state machines, behaviour gating |

AnimationSystem becomes a thin projector: walk the animation-typed layers,
resolve clip slots, emit `AnimationLayer[]`. The CSM runtime itself is
animation-agnostic.

### Default animation-layer priorities

Animation-typed layers compose with priority and bone masks already on the
biped skeleton:

```
priority 10  REACTION   (full body)   stagger / hit_react / knockback / death
priority  1  COMBAT     (upper body)  swing / block / aim / shoot / cast
priority  0  LOCOMOTION (lower body)  idle / walk / run / roll / airborne
```

You can `walk + slash`, `run + aim`, `idle + block`. Reaction overrides
everything when active.

### Crouch is a parameter, not a state

`posture` is a separate `output: "flag"` layer. When `csm.posture == "crouched"`,
the locomotion layer's clip slots swap (idle → crouch_idle, walk → crouched_walking)
via `paramOverrides`. No `crouch_idle` state; same `idle` state, different clip.

---

## Three-tier separation: input, mode, payload

The hard part of the reframe is being precise about where different kinds
of state live. Three tiers, three places:

| Tier | Where | Lifetime | Examples |
|---|---|---|---|
| **Input** (intent) | `InputState` component (unchanged) | Refreshed every tick from datagram or AI | action bitflags, facing radians, movement vector |
| **Mode** (resolved state) | `CharacterStateMachine` layer nodes + elapsed | Owned by SM transitions | combat=`block`, locomotion=`run`, reaction=`hit_front`, posture=`crouched` |
| **Payload** (per-mode data) | Slim companion component, present only while in that mode | Created on enter, destroyed on exit | `SwingContext { weaponActionId, hitEntities, rewindTick }` |

**Authority rules:**
- Input is authoritative for "what did the player/AI ask for."
- CSM is authoritative for "what mode is this character actually in."
- Payload components are authoritative for mode-specific gameplay data
  the SM data model can't represent (sets, refs, lag-comp snapshots).

The SM is the *materialised resolution* of input + equipment + valid
context. A character holding the block button without a shield is not
blocking. The transition rule is the single place that gating lives;
damage handlers read the resolved answer rather than re-deriving.

### What replaces today's `SkillInProgress`

`SkillInProgress` was doing two jobs (mode + payload) in one component.
The migration:

| Today (`SkillInProgress`) | New home |
|---|---|
| `phase: "windup" \| "active" \| "winddown"` | Three CSM states: `swing.windup`, `swing.active`, `swing.winddown` |
| `ticksInPhase` | `state.elapsed` in the SM |
| `weaponActionId` | `SwingContext` component |
| `hitEntities: Set<number>` | `SwingContext` component |
| `rewindTick` | `SwingContext` component |
| `pendingSkillVerb` | One-tick `event.swing_started` flag carrying the verb; `SwingContext` mirrors it for the duration |

`SkillInProgress` is deleted in the same commit `SwingContext` lands.
No transitional shim. (See "Refactoring philosophy" in CLAUDE.md.)

### Component-presence pattern, generalised

The "presence is the flag" pattern stays — but for *payloads only*. Mode
queries route through CSM:

- ✅ `csm.combat.node == "block"` (was: hypothetical `Blocking` tag — never created)
- ✅ `csm.posture.node == "crouched"` (was: scattered `crouched: bool` checks)
- ✅ `csm.combat.node.startsWith("swing.")` (was: `world.has(e, SkillInProgress)`)
- ✅ `world.has(e, SwingContext)` (still presence-as-flag, but only for the payload)

A dedicated `Blocking` component would just rename a CSM node — same data,
two synchronisation points, no upside. We don't introduce one.

---

## Universal-actor design

Every actor (player, NPC, mob, critter, animal, trader) is a "playable
character" in the structural sense — same component skeleton, same SM
runtime, different per-prefab data.

### Prefab base

A new `prefabs/_base/playable_character.json` declares the components every
actor inherits:

```json
{
  "id": "playable_character_base",
  "abstract": true,
  "components": {
    "skeleton": { /* ref */ },
    "health": { "current": 100, "max": 100 },
    "velocity": {},
    "inputState": {},
    "characterStateMachine": { "stateMachineId": "humanoid_default" },
    "animationLayers": {}
  }
}
```

`drowner`, `rotten_knight`, `villager`, `merchant`, `wolf`, `chicken`,
`player_humanoid` all `extends: "playable_character_base"` and override
`stateMachineId` + `animationSlots` as needed.

`stateMachineId` differences let archetypes diverge cleanly:
- `humanoid_default` — full combat+locomotion+reaction+posture
- `humanoid_passive` — no combat layer (villagers, merchants)
- `quadruped_default` — different locomotion (gallop vs run), no upper-body swing
- `critter_default` — minimal SM, idle/wander/flee only

The shared structure is what makes "every actor uses the same systems"
work without isNpc branches.

---

## Design decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| **Scope** | General Character State Machine; animation is one of multiple typed outputs | Reflects what the data model already supports; uniform mode-source for all actors |
| **Source of truth for modes** | CSM nodes | Resolves input + equipment + gating in one rule; consumers read the answer |
| **`SkillInProgress` future** | Retired; replaced by combat-layer states + `SwingContext` payload | Same migration as `Blocking` would have hit; one pattern across all modes |
| **Per-mode tag components** | Disallowed for mode queries; allowed only for *payload* the SM cannot represent | Prevents two-source-of-truth drift |
| **Condition expression** | Tiny DSL parser (~150 LOC), compiled at content load | Authors declare new transitions without code changes; matches recipe formula DSL pattern |
| **Roll direction** | Single clip + root rotation toward `velocity.dir` at state-enter | Cheap; cardinal directions look fine; slight pop on diagonals acceptable for action-RPG |
| **Hit reaction direction** | Front / back / generic stagger (3 clips) | Conveys tactical readability; uses Mixamo's existing hit_react clips |
| **IK swingPath system** | Retired entirely — all weapons clip-driven | Matches CLAUDE.md "no parallel implementations"; ~98% of swingPath authoring goes away |
| **Runtime location** | `@voxim/content` (engine code, shared with client) | Per T-182; client re-ticks for local-player prediction |
| **CSM state networking** | Not networked (server-only). Animation projection (`AnimationLayer[]`) already networks; remote actors derive animation from that. Local player re-runs CSM on client for prediction. | Wire cost stays flat; revisit only if remote-actor mode reads become important on the client |
| **Lag-comp** | `StateHistoryBuffer` captures per-tick CSM layer nodes alongside positions | Required for "was the target blocking at the rewound tick" — small added cost |

---

## Data model

`StateMachineDef` lives in
[`@voxim/content/src/types.ts`](packages/content/src/types.ts):

```ts
export interface StateMachineDef {
  id: string;
  layers: SMLayer[];
}

export interface SMLayer {
  id: string;                                       // "locomotion" | "combat" | "reaction" | "posture" | ...
  output: "animation" | "flag" | "mode";            // what consumers see
  mask?: string;                                    // BoneMask id; only meaningful for output: "animation"
  priority?: number;                                // animation layer override order; ignored otherwise
  states: Record<string, SMState>;
  transitions: SMTransition[];
}

export interface SMState {
  /** For animation layers: clip id or "$param" reference resolved via prefab.animationSlots. null = no animation. */
  /** For flag/mode layers: ignored. */
  clip?: string | null;
  loop?: boolean;
  /** Optional override for early-exit timing; defaults to clip's natural duration. */
  duration?: number;
  /** Realign root bone on state-enter (used by "roll" to face the dodge direction). */
  rotateRoot?: "velocity.dir";
  /** Auto-transition trigger; e.g. "clip.done" fires when state.elapsed >= duration. */
  exitWhen?: string;
  /**
   * Conditional state-config overrides.
   * Key: condition string (e.g. "csm.posture == crouched").
   * Value: per-state-id partial override (e.g. { idle: { clip: "$crouch_idle" } }).
   * Evaluated per tick — multiple matches stack.
   */
  paramOverrides?: Record<string, Partial<Record<string, Partial<SMState>>>>;
}

export interface SMTransition {
  from?: string;          // omit = "*" (any state)
  to: string;
  when: string;           // DSL expression: "vel.mag > 4 && csm.posture != crouched"
  priority?: number;      // higher wins when multiple match in one tick
}
```

### Runtime state component

Server-only. One per actor.

```ts
// packages/tile-server/src/components/character_state_machine.ts
export interface CharacterStateMachineData {
  stateMachineId: string;
  layerStates: Record<string, { node: string; elapsed: number }>;
}
```

The runtime exposes a typed view object built each tick (`csm.combat.node`,
`csm.posture.node`, etc.) for system reads — same shape everywhere, no
manual layerStates indexing.

---

## Condition DSL spec

A small parser lives in `@voxim/content/src/sm_expression.ts`. Expressions
are compiled once at content load, evaluated per tick against an "SM
context" object built from the entity's components.

### Variables exposed

| Domain | Vars |
|---|---|
| velocity | `vel.mag`, `vel.dir.x`, `vel.dir.y` |
| health | `health.current`, `health.max`, `health.frac` |
| input | `input.dodge`, `input.block`, `input.aim`, `input.skill_1` …  (action-flag bits) |
| state | `state.elapsed`, `state.duration` |
| event | `event.hit`, `event.hit.heavy`, `event.hit.from_front`, `event.hit.from_back`, `event.swing_started`, `event.parried`, `event.consumed_potion` (transient one-tick flags) |
| weapon | `weapon.has_aim`, `weapon.has_block`, `weapon.is_two_handed` (queried from equipped weapon prefab) |
| equipped | `equipped.weapon`, `equipped.shield`, `equipped.helm` (slot occupancy) |
| buff | `buff.<id>` (active flags) |
| csm | `csm.<layer>.node` (cross-layer reads — e.g. `csm.posture == crouched`) |

### Operators

`<` `>` `<=` `>=` `==` `!=` `&&` `||` `!` + parens + numeric / bool / enum literals.

### Example transitions

```json
{ "from": "walk",  "to": "run",  "when": "vel.mag > 4 && csm.posture != crouched" }
{ "to": "roll",    "when": "input.dodge && state.elapsed > 0.05" }
{ "to": "death",   "when": "health.current <= 0" }
{ "to": "knockback", "when": "event.hit.heavy" }
{ "to": "block",   "when": "input.block && weapon.has_block && csm.combat.node != swing.winddown" }
```

---

## Sample state machine: `humanoid_default`

Lives at `data/state_machines/humanoid_default.json`. Sketch:

```json
{
  "id": "humanoid_default",
  "layers": [
    {
      "id": "posture",
      "output": "flag",
      "states": {
        "upright":  {},
        "crouched": {}
      },
      "transitions": [
        { "to": "crouched", "when": "input.crouch" },
        { "to": "upright",  "when": "!input.crouch" }
      ]
    },
    {
      "id": "locomotion",
      "output": "animation",
      "mask": "lower_body",
      "priority": 0,
      "states": {
        "idle": { "clip": "$idle", "loop": true,
                  "paramOverrides": {
                    "csm.posture == crouched": { "self": { "clip": "$crouch_idle" } }
                  } },
        "walk": { "clip": "$walk", "loop": true,
                  "paramOverrides": {
                    "csm.posture == crouched": { "self": { "clip": "$crouch_walk" } }
                  } },
        "run":  { "clip": "$run",  "loop": true },
        "roll": { "clip": "$roll", "loop": false, "duration": 0.6,
                  "rotateRoot": "velocity.dir", "exitWhen": "clip.done" },
        "airborne": { "clip": "$airborne", "loop": true }
      },
      "transitions": [
        { "to": "airborne", "when": "event.left_ground" },
        { "from": "airborne", "to": "idle", "when": "event.landed" },
        { "to": "roll", "when": "input.dodge && state.elapsed > 0.05" },
        { "from": "roll", "to": "idle", "when": "state.elapsed >= state.duration" },
        { "to": "run",  "when": "vel.mag > 4 && csm.posture != crouched" },
        { "to": "walk", "when": "vel.mag > 0.5" },
        { "to": "idle", "when": "vel.mag < 0.2" }
      ]
    },
    {
      "id": "combat",
      "output": "animation",
      "mask": "upper_body",
      "priority": 1,
      "states": {
        "idle":         { "clip": "$combat_idle", "loop": true },
        "swing.windup":   { "clip": "$weapon.swing_clip", "loop": false, "duration": "$weapon.windupTicks" },
        "swing.active":   { "clip": "$weapon.swing_clip", "loop": false, "duration": "$weapon.activeTicks" },
        "swing.winddown": { "clip": "$weapon.swing_clip", "loop": false, "duration": "$weapon.winddownTicks" },
        "block": { "clip": "$weapon.block_clip", "loop": true },
        "aim":   { "clip": "$weapon.aim_clip",   "loop": true },
        "shoot": { "clip": "$weapon.shoot_clip", "loop": false, "exitWhen": "clip.done" }
      },
      "transitions": [
        { "to": "swing.windup",   "when": "event.swing_started" },
        { "from": "swing.windup",   "to": "swing.active",   "when": "state.elapsed >= state.duration" },
        { "from": "swing.active",   "to": "swing.winddown", "when": "state.elapsed >= state.duration" },
        { "from": "swing.winddown", "to": "idle",           "when": "state.elapsed >= state.duration" },
        { "to": "block", "when": "input.block && weapon.has_block && !csm.combat.node.startsWith(swing.)" },
        { "from": "block", "to": "idle", "when": "!input.block" },
        { "to": "aim",   "when": "input.aim && weapon.has_aim" },
        { "from": "aim", "to": "shoot", "when": "skill.shoot_fired" }
      ]
    },
    {
      "id": "reaction",
      "output": "animation",
      "priority": 10,
      "states": {
        "none":       { "clip": null },
        "hit_front":  { "clip": "$hit_front", "loop": false, "duration": 0.5 },
        "hit_back":   { "clip": "$hit_back",  "loop": false, "duration": 0.5 },
        "knockback":  { "clip": "$knockback", "loop": false, "duration": 0.7 },
        "death":      { "clip": "$death",     "loop": false, "duration": 1.5 }
      },
      "transitions": [
        { "to": "death",     "when": "health.current <= 0" },
        { "to": "knockback", "when": "event.hit.heavy" },
        { "to": "hit_front", "when": "event.hit.from_front" },
        { "to": "hit_back",  "when": "event.hit.from_back" },
        { "to": "none",      "when": "state.elapsed >= state.duration" }
      ]
    }
  ]
}
```

The `$`-prefixed clip ids resolve via `prefab.animationSlots`. The
existing `animationSlots` map becomes the SM parameter source —
same mechanism, just used by the SM resolver.

### Per-prefab slot examples

```json
// prefabs/drowner.json   (extends: playable_character_base)
"stateMachineId": "humanoid_default",
"animationSlots": {
  "idle":              "zombie_idle_loop",
  "walk":              "zombie_walk_fwd_loop",
  "run":               "zombie_walk_fwd_loop",
  "roll":              "sprinting_forward_roll",
  "airborne":          "falling_idle",
  "combat_idle":       "zombie_idle_loop",
  "weapon.swing_clip": "zombie_scratch",
  "hit_front":         "hit_react_stomach",
  "hit_back":          "standing_react_large_from_right",
  "knockback":         "hit_knockback",
  "death":             "great_sword_death"
}

// prefabs/rotten_knight.json   (extends: playable_character_base)
"stateMachineId": "humanoid_default",
"animationSlots": {
  "idle":              "sword_and_shield_idle",
  "walk":              "sword_and_shield_walk",
  "run":               "sword_and_shield_run",
  "roll":              "sword_and_shield_roll",
  "airborne":          "falling_idle",
  "combat_idle":       "sword_and_shield_idle",
  "weapon.swing_clip": "sword_and_shield_slash",
  "weapon.block_clip": "sword_and_shield_block",
  "hit_front":         "standing_react_small_from_front",
  "hit_back":          "standing_react_large_from_right",
  "knockback":         "hit_knockback",
  "death":             "defeated"
}
```

---

## Tick ordering

Authoritative resolution requires CSM evaluation to precede every
consumer that reads it. Updated server tick sequence:

```
1. drainInput          (writes InputState)
2. NpcAiSystem         (writes InputState for NPCs)
3. PhysicsSystem       (updates Velocity; emits event.left_ground / event.landed)
4. CharacterStateMachineSystem   (← NEW: evaluates transitions, advances elapsed, emits transition events)
5. ActionSystem        (reads csm.combat.* for gating; reads SwingContext for hit detection)
6. DodgeSystem, BuffSystem, EquipmentSystem, ... (read csm.* freely)
7. damage / hit handlers (read target's csm.combat for block, csm.reaction for hyperarmour)
8. AnimationSystem     (projects animation-typed CSM layers → AnimationLayer[])
9. applyChangeset, build delta, send state, advance tick
```

`CharacterStateMachineSystem` runs once, early. All downstream readers see
the freshly-resolved nodes for the current tick.

---

## Lag-compensation: CSM rides in the history buffer

`StateHistoryBuffer.getAt(serverTick - rttTicks)` already rewinds positions
for hit detection. With CSM as authoritative for "was the target blocking,"
the buffer must capture per-tick layer nodes too:

```ts
interface HistorySnapshot {
  positions: Map<EntityId, [x, y, z]>;
  csmLayerNodes: Map<EntityId, Record<string, string>>;  // ← NEW
}
```

Damage handlers querying "is target blocking at hit-resolution tick" route
through the rewound CSM, not the current one. Cost: a few enum strings
per actor per tick — negligible.

Snapshot is taken at the end of each tick (after CharacterStateMachineSystem
has run) so it captures the resolved mode for that tick.

---

## Implementation plan — six commits, in order

### Step 1: CSM runtime in `@voxim/content` (~450 LOC)

Files to create:
- `packages/content/src/sm_expression.ts` — DSL parser + evaluator with compile-once
- `packages/content/src/state_machine.ts` — runtime tick algorithm, layered, typed outputs
- `packages/content/src/state_machine.test.ts` — unit tests against synthetic SM defs

Types extended in `packages/content/src/types.ts` (the schemas above).

`StateMachineDef` registered as a new `ContentRegistryReadonly<StateMachineDef>`
on `ContentService`. Loader scans `data/state_machines/*.json`.

`smRuntime.tick(ctx, def, prevState)` returns `{ layerStates, transitionsFired }`.
A separate `projectAnimationLayers(layerStates, def, slotMap)` builds the
`AnimationLayer[]` from animation-typed layers.

**No consumers yet — pure infrastructure.**

### Step 2: Author SM defs + prefab base + slot maps

- `data/state_machines/humanoid_default.json` — the SM def above (with combat).
- `data/state_machines/humanoid_passive.json` — no combat layer (villagers, merchants).
- `prefabs/_base/playable_character.json` — abstract base prefab with the standard component bundle.
- Update `prefabs/drowner.json`, `prefabs/rotten_knight.json`, and the player humanoid prefab to `extends: "playable_character_base"`, set `stateMachineId`, expand `animationSlots` against the 367-clip biped library.
- Per-prefab `stateMachineId` field added to the Prefab schema.
- `wolf` and other quadrupeds keep their current 3-clip cadence for now; quadruped SM is out of scope (filed as future ticket).

### Step 3: AnimationSystem switches to projection

[`tile-server/src/systems/animation.ts`](packages/tile-server/src/systems/animation.ts):

- Add `CharacterStateMachineSystem` to the system order (between Physics and Action — see "Tick ordering").
- Replace the hardcoded `useLimp ? slot("walk_limp") : slot("walk")` cascade with `projectAnimationLayers(csm.layerStates, def, prefab.animationSlots)`.
- Per-entity SM state held in the new server-only component `CharacterStateMachine`.
- Old hardcoded layer-building deleted in the same commit (no shim).

After this commit: locomotion, posture, and reaction layers are live.
Combat layer is structurally present but `swing` states sit unused
because nothing fires `event.swing_started` yet — that's Step 4.

### Step 4: `SkillInProgress` retirement + clip-driven weapon attacks (T-184)

This is the inseparable migration — combining T-184 (clip-driven weapons) and T-185 (SkillInProgress retirement) because each requires the other.

**a. Component swap.** Delete `SkillInProgress` component + its codec + its registry entry. Add `SwingContext` server-only component:

```ts
// packages/tile-server/src/components/swing_context.ts
export interface SwingContextData {
  weaponActionId: string;
  rewindTick: number;          // set on first active tick
  hitEntities: number[];       // dedup set, serialised as array
  pendingSkillVerb: string | null;
}
```

**b. WeaponActionDef migration.** All weapon JSONs in `packages/content/data/weapon_actions/` migrated:

| Field | Status |
|---|---|
| `swingPath` | REMOVE |
| `ikTargets` | REMOVE |
| `defaultBladeRadius/Length` | REMOVE |
| `clipId: string` (biped library) | ADD |
| `blade: { baseLocal, tipLocal, radius }` | ADD |
| `holdHand?: "hand_r" \| "hand_l"` (default `hand_r`) | ADD |
| `windupTicks`, `activeTicks`, `winddownTicks`, `staminaCost`, `damage`, `skillVerb` | keep |

```json
// weapon_actions/slash.json
{
  "id": "slash",
  "clipId": "sword_and_shield_slash",
  "blade": { "baseLocal": [0, 0.05, 0], "tipLocal": [0, 0.85, 0], "radius": 0.04 },
  "windupTicks": 6, "activeTicks": 8, "winddownTicks": 8,
  "staminaCost": 12, "skillVerb": "strike"
}
```

**c. ActionSystem rewrite.** [`tile-server/src/systems/action.ts`](packages/tile-server/src/systems/action.ts):
1. On `pendingSkillVerb` from input handling: gate-check via `csm.combat.node == "idle" && stamina >= cost`; if admissible, install `SwingContext` and fire one-tick `event.swing_started`.
2. CSM transitions to `swing.windup` next tick (system ordering ensures this).
3. During `csm.combat.node == "swing.active"`: read `hand_r` world transform from latest skeleton solve, transform `baseLocal` and `tipLocal` to world, sweep capsule between successive ticks. Hit dedup via `SwingContext.hitEntities`.
4. Lag-compensated rewind via `StateHistoryBuffer.getAt(serverTick - rttTicks)` — sweeps a different capsule path, same mechanism.
5. On exit from `swing.winddown` (transition event from CSM runtime): remove `SwingContext`.

### Step 5: Hit-reaction wiring + CSM rewind in `StateHistoryBuffer`

[`tile-server/src/handlers/health_hit_handler.ts`](packages/tile-server/src/handlers/health_hit_handler.ts):

- Damage events fire on the EventBus carrying `attackerEntityId`, `direction`, `heavy: bool`.
- Hit-target's CSM context for the next tick gets `event.hit.from_front` / `event.hit.from_back` / `event.hit.heavy` set.
- Direction calc: `dot(targetForward, attackerToTarget)` sign decides front/back.
- Heavy threshold from `gameConfig.combat`.

[`tile-server/src/state_history.ts`](packages/tile-server/src/state_history.ts):

- Snapshot now captures `csmLayerNodes: Map<EntityId, Record<string, string>>` alongside positions.
- Damage handler queries `historyBuffer.getCsmAt(targetId, rewindTick)` for the block check rather than the current CSM. Block mitigation applied based on the target's mode at the rewound tick.

### Step 6: Retire IK swing-path code

- Drop `evaluateSwingPath` / `deriveTip` from `packages/content/src/sweep_math.ts` (and any callers).
- Drop the IK-driven arm code path in [`packages/client/src/render/skeleton_evaluator.ts`](packages/client/src/render/skeleton_evaluator.ts).
- `ik_solver.ts` stays — still used by static IK constraints (foot planting, weapon grip helper). Just no longer driven by swing keyframes.

---

## Files that will be touched

| File | Change |
|---|---|
| `packages/content/src/types.ts` | + `StateMachineDef`, `SMLayer` (with `output` field), `SMState`, `SMTransition`; modify `WeaponActionDef`; add `stateMachineId` to Prefab |
| `packages/content/src/sm_expression.ts` | NEW — DSL parser, compile-once |
| `packages/content/src/state_machine.ts` | NEW — runtime + animation projection |
| `packages/content/src/state_machine.test.ts` | NEW — unit tests |
| `packages/content/src/store.ts` | + `stateMachines` registry |
| `packages/content/src/loader.ts` | + scan `state_machines/*` |
| `packages/content/src/sweep_math.ts` | remove `evaluateSwingPath`/`deriveTip` (Step 6) |
| `packages/content/data/state_machines/humanoid_default.json` | NEW |
| `packages/content/data/state_machines/humanoid_passive.json` | NEW |
| `packages/content/data/prefabs/_base/playable_character.json` | NEW (abstract base) |
| `packages/content/data/prefabs/drowner.json` | extends base, set `stateMachineId`, expand `animationSlots` |
| `packages/content/data/prefabs/rotten_knight.json` | extends base, set `stateMachineId`, expand `animationSlots` |
| `packages/content/data/prefabs/items/iron_sword.json` (et al.) | weapon action format migration (Step 4) |
| `packages/tile-server/src/components/character_state_machine.ts` | NEW (server-only component) |
| `packages/tile-server/src/components/swing_context.ts` | NEW (replaces `SkillInProgress`) |
| `packages/tile-server/src/components/skill_in_progress.ts` | DELETE (Step 4) |
| `packages/tile-server/src/systems/character_state_machine.ts` | NEW system — runs CSM tick |
| `packages/tile-server/src/systems/animation.ts` | replace hardcoded layer logic with `projectAnimationLayers()` |
| `packages/tile-server/src/systems/action.ts` | reads `csm.combat.*`, manages `SwingContext` lifecycle, clip-driven hit detection |
| `packages/tile-server/src/handlers/health_hit_handler.ts` | emit hit events with direction info; query CSM-via-history for block check |
| `packages/tile-server/src/state_history.ts` | snapshot includes per-tick CSM layer nodes |
| `packages/tile-server/src/server.ts` | wire `CharacterStateMachineSystem` into tick order |
| `packages/client/src/render/skeleton_evaluator.ts` | remove IK-during-swing (Step 6) |
| `TICKETS.md` | T-182 done; file T-184 (clip-driven weapons + SkillInProgress retirement) |

---

## Out of scope (future tickets)

- **Networked CSM state** for remote-actor mode reads on the client. Currently server-only; revisit if remote actors need to expose mode beyond what `AnimationLayer[]` already conveys.
- **Blend trees / parametric blending** between clips (e.g. velocity-blended walk→run). Discrete state transitions only in v1.
- **Sub-state machines** (an SM as a state inside another SM). Flat layers only; the dotted state ids (`swing.windup`) are flat strings, not nested SMs.
- **Per-bodypart hit reactions** (head vs gut vs leg). Front/back only.
- **Eight-direction roll**. Single roll clip + root rotate.
- **Quadruped SM** (`quadruped_default.json`). Wolf keeps its current 3-clip cadence; can author later.
- **Behaviour-tree integration** (T-181). The CSM tracks *current mode*; BT decides *what mode to ask for*. The two compose cleanly — BT writes to InputState (same channel as player input), CSM resolves. No special integration needed in v1.
- **Payload component lifecycle helpers**. Step 4 manages `SwingContext` lifecycle imperatively in ActionSystem. If more payload components emerge (CastContext, ChargeContext, etc.) and the pattern repeats, factor a generic "payload bound to SM state" helper.

---

## Open architectural calls (revisit if needed)

**1. CSM state networking.** Currently server-only — client reconstructs animation from networked `AnimationLayer[]` and re-runs CSM only for the local player's prediction. If remote-actor mode reads become important on the client (e.g., predicting your sword bouncing off another player's block before the server confirms), revisit and network CSM layer nodes per actor in AoI. Wire cost estimate: ~50 bytes per entity per tick.

**2. Compile-time expression validation.** The DSL is parsed at content load. Bad expressions in JSON throw at startup, which is fine — but adding a content-validation CLI pass would catch issues earlier in authoring. Defer until authoring volume justifies it.

**3. Payload component lifecycle.** In Step 4, ActionSystem creates and destroys `SwingContext` imperatively, watching CSM transition events. If multiple payload components emerge, consider a declarative `payload: "SwingContext"` field on SMState that the runtime manages automatically.

---

## Resuming in the next session

Start with **Step 1** above (CSM runtime in `@voxim/content`). Keep the
six-step breakdown — each step is a clean commit; together they
constitute T-182 + T-184.

Important context to carry forward:
- The biped library has 367 clips ([`data/anim_library/biped/`](packages/content/data/anim_library/biped/)).
- Skeletons: `biped` (canonical, 17 bones, 10 morph params) and `wolf` (quadruped).
- Existing `ContentService.animationLibraries` registry holds the per-archetype clip libraries (T-178).
- Existing `prefab.animationSlots` is the slot-id → clip-id map that the SM will reuse as its parameter source.
- Bootstrap codec is gzipped (T-179 follow-up); blob size 4.5 MB compressed.
- All Content Architecture tickets through T-180 are landed; T-181 (BT runtime) and T-183 (procedural generators) are still queued and independent of this work.
- The reframe (Animation SM → Character SM) is locked. Animation is one of multiple typed layer outputs, not the SM's purpose.
- `SkillInProgress` is being retired in Step 4. Treat any reference to it during implementation as a port site.
