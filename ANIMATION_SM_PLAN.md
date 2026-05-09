# Animation State Machine — Implementation Plan

**Status:** design locked, not yet implemented. Continues in a new session.
**Tickets:** extends T-182 (State machine runtime + animation SMs as data) and adds a sister scope for weapon attacks (call it T-184 when filed).
**Last commit on this work:** `3e9d66c` (320 Mixamo clips imported into biped library).

---

## Why this matters

The biped library now has 367 animation clips (T-178 → T-180). What's missing
is a structured way to *select* which clip plays when. Today that selection
lives as hardcoded `if/else` cascades in
[`tile-server/src/systems/animation.ts`](packages/tile-server/src/systems/animation.ts).
The user wants it data-driven so adding a new creature behavior is a JSON
edit, not a code change.

The user also wants attack animations to come from clips, not from
IK-driven swing-path keyframes. This is a separate-but-related rework.

---

## Architecture: layered state machine, body-part-masked

Three layers run in parallel each tick. Their outputs compose into the
existing `AnimationLayer[]` stack. Layer priority (override order):

```
priority 10  REACTION   (full body)   stagger / hit_react / knockback / death
priority  1  COMBAT     (upper body)  swing / block / aim / shoot / cast
priority  0  LOCOMOTION (lower body)  idle / walk / run / roll
```

**Key principle:** layers are independent. You can `walk + slash`,
`run + aim`, `idle + block`. Reaction overrides everything when active.

**Crouch is a parameter, not a state.** When `crouching == true`, the
locomotion layer's state clip references swap (idle → crouch_idle, walk
→ crouched_walking). No "crouch_idle" state — same `idle` state, different
clip via `paramOverrides`.

The bone masks (`upper_body`, `lower_body`) already exist on the biped
skeleton.

---

## Design decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| **Condition expression** | Tiny DSL parser (~150 LOC) | Authors declare new transitions without code changes; matches the existing recipe formula DSL pattern; data-driven goal |
| **Roll direction** | Single clip + root rotation toward `velocity.dir` at state-enter | Cheap; looks fine for cardinal directions; slight pop on diagonals acceptable for action-RPG |
| **Hit reaction direction** | Front / back / generic stagger (3 clips) | Conveys tactical readability without overengineering; uses Mixamo's existing hit_react_stomach / hit_react_head |
| **IK swingPath system** | **Retired entirely** — all weapons clip-driven | Matches CLAUDE.md "no parallel implementations"; ~98% of swingPath authoring goes away |
| **Runtime location** | `@voxim/content` (engine code) | Per T-182; data-driven principle; client could re-tick if needed later |
| **SM state networking** | Server-only, derived on client | `AnimationLayer[]` already networks; client doesn't need to know "which SM state", only "which clips playing" |

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
  id: string;                                       // "locomotion" | "combat" | "reaction"
  mask?: string;                                    // BoneMask id; undefined = full body
  states: Record<string, SMState>;
  transitions: SMTransition[];
}

export interface SMState {
  /** Clip id, or "$param" reference resolved via prefab.animationSlots. null = no animation. */
  clip: string | null;
  loop?: boolean;
  /** Optional override for early-exit timing; defaults to clip's natural duration. */
  duration?: number;
  /** Realign root bone on state-enter (used by "roll" to face the dodge direction). */
  rotateRoot?: "velocity.dir";
  /** Auto-transition trigger; e.g. "clip.done" fires when state.elapsed >= duration. */
  exitWhen?: string;
  /**
   * Conditional state-config overrides.
   * Key: condition string (e.g. "crouching=true").
   * Value: per-state-id partial override (e.g. { idle: { clip: "$crouch_idle" } }).
   * Evaluated per tick — multiple matches stack.
   */
  paramOverrides?: Record<string, Partial<Record<string, Partial<SMState>>>>;
}

export interface SMTransition {
  from?: string;          // omit = "*" (any state)
  to: string;
  when: string;           // DSL expression: "vel.mag > 4 && !crouching"
  priority?: number;      // higher wins when multiple match in one tick
}
```

---

## Condition DSL spec

A small parser lives in `@voxim/content/src/sm_expression.ts`. Built per-tick
"SM context" object holds the variables; expression evaluates against it.

### Variables exposed

| Domain | Vars |
|---|---|
| velocity | `vel.mag`, `vel.dir.x`, `vel.dir.y` |
| health | `health.current`, `health.max`, `health.frac` |
| input | `input.dodge`, `input.block`, `input.aim` (action-flag bits) |
| posture | `crouching` (bool, derived from posture sub-state) |
| state | `state.elapsed`, `state.duration` |
| event | `event.hit`, `event.hit.heavy`, `event.hit.from_front`, `event.hit.from_back` (true for one tick after a damage event) |
| weapon | `weapon.has_aim`, `weapon.has_block` (queried from equipped weapon) |
| skill | `skill.swing_started`, `skill.shoot_fired` (transient flags from SkillSystem) |

### Operators

`<` `>` `<=` `>=` `==` `!=` `&&` `||` `!` + parens + numeric / bool literals.

### Example transitions

```json
{ "from": "walk",  "to": "run",  "when": "vel.mag > 4 && !crouching" }
{ "to": "roll", "when": "input.dodge && state.elapsed > 0.05" }
{ "to": "death", "when": "health.current <= 0" }
{ "to": "knockback", "when": "event.hit.heavy" }
```

---

## Sample state machine: `humanoid_default`

Lives at `data/state_machines/humanoid_default.json`. Sketch:

```json
{
  "id": "humanoid_default",
  "layers": [
    {
      "id": "locomotion",
      "mask": "lower_body",
      "states": {
        "idle": { "clip": "$idle", "loop": true,
                  "paramOverrides": {
                    "crouching=true": { "self": { "clip": "$crouch_idle" } }
                  } },
        "walk": { "clip": "$walk", "loop": true,
                  "paramOverrides": {
                    "crouching=true": { "self": { "clip": "$crouch_walk" } }
                  } },
        "run":  { "clip": "$run",  "loop": true },
        "roll": { "clip": "$roll", "loop": false, "duration": 0.6,
                  "rotateRoot": "velocity.dir", "exitWhen": "clip.done" }
      },
      "transitions": [
        { "to": "roll", "when": "input.dodge && state.elapsed > 0.05" },
        { "from": "roll", "to": "idle", "when": "state.elapsed >= state.duration" },
        { "to": "run",  "when": "vel.mag > 4 && !crouching" },
        { "to": "walk", "when": "vel.mag > 0.5" },
        { "to": "idle", "when": "vel.mag < 0.2" }
      ]
    },
    {
      "id": "combat",
      "mask": "upper_body",
      "states": {
        "idle":  { "clip": "$combat_idle", "loop": true },
        "swing": { "clip": "$weapon.swing_clip", "loop": false, "exitWhen": "clip.done" },
        "block": { "clip": "$weapon.block_clip", "loop": true },
        "aim":   { "clip": "$weapon.aim_clip",   "loop": true },
        "shoot": { "clip": "$weapon.shoot_clip", "loop": false, "exitWhen": "clip.done" }
      },
      "transitions": [
        { "to": "swing", "when": "skill.swing_started" },
        { "from": "swing", "to": "idle", "when": "state.elapsed >= state.duration" },
        { "to": "block", "when": "input.block && weapon.has_block" },
        { "from": "block", "to": "idle", "when": "!input.block" },
        { "to": "aim",   "when": "input.aim && weapon.has_aim" },
        { "from": "aim", "to": "shoot", "when": "skill.shoot_fired" }
      ]
    },
    {
      "id": "reaction",
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
existing `animationSlots` map becomes the SM parameter source — same
mechanism, just used by the SM resolver instead of the hardcoded
animation system.

### Per-prefab slot examples

```json
// prefabs/drowner.json
"animationSlots": {
  "idle":             "zombie_idle_loop",
  "walk":             "zombie_walk_fwd_loop",
  "run":              "zombie_walk_fwd_loop",
  "roll":             "sprinting_forward_roll",
  "combat_idle":      "zombie_idle_loop",
  "weapon.swing_clip": "zombie_scratch",
  "hit_front":        "hit_react_stomach",
  "hit_back":         "standing_react_large_from_right",
  "knockback":        "hit_knockback",
  "death":            "great_sword_death"
}

// prefabs/rotten_knight.json
"animationSlots": {
  "idle":             "sword_and_shield_idle",
  "walk":             "sword_and_shield_walk",
  "run":              "sword_and_shield_run",
  "roll":             "sword_and_shield_roll",
  "combat_idle":      "sword_and_shield_idle",
  "weapon.swing_clip": "sword_and_shield_slash",
  "weapon.block_clip": "sword_and_shield_block",
  "hit_front":        "standing_react_small_from_front",
  "hit_back":         "standing_react_large_from_right",
  "knockback":        "hit_knockback",
  "death":            "defeated"
}
```

---

## Implementation plan — six commits, in order

### Step 1: SM runtime in `@voxim/content` (~400 LOC)

Files to create:
- `packages/content/src/sm_expression.ts` — DSL parser + evaluator
- `packages/content/src/state_machine.ts` — runtime tick algorithm
- `packages/content/src/state_machine.test.ts` — unit tests against synthetic SM defs

Types extended in `packages/content/src/types.ts` (the schemas above).

`StateMachineDef` registered as a new `ContentRegistryReadonly<StateMachineDef>`
on `ContentService`. Loader scans `data/state_machines/*.json`.

`smRuntime.tick(ctx, def, prevState)` returns `{ layerStates, animationLayers }`
where `animationLayers` is the `AnimationLayer[]` the existing pipeline
already consumes.

**No consumers yet — this commit is pure infrastructure.**

### Step 2: Author `humanoid_default.json` + prefab slot maps

- `data/state_machines/humanoid_default.json` — the SM def above.
- Update `prefabs/drowner.json` / `rotten_knight.json` with full slot maps
  pulling from the 367-clip biped library.
- Add a `humanoid_passive.json` SM (no combat layer) for villagers /
  merchants.
- Per-prefab `stateMachineId: "humanoid_default"` field added to the
  Prefab schema.

### Step 3: `AnimationSystem` switches over

[`tile-server/src/systems/animation.ts`](packages/tile-server/src/systems/animation.ts)

Replace the hardcoded `useLimp ? slot("walk_limp") : slot("walk")` cascade
with `smRuntime.tick(ctx, def)` → `AnimationLayer[]`. Per-entity SM state
held in a server-only component `AnimationStateMachineState`.

Old hardcoded layer-building deleted in the same commit (no shim).

### Step 4: Hit-reaction layer wiring

Damage events fire on the EventBus. SM context for the hit target gets
`event.hit*` flags set for one tick.

Direction calc: `dot(targetForward, attackerToTarget)` sign decides
`from_front` vs `from_back`. Heavy threshold from `gameConfig.combat`
triggers `knockback`.

### Step 5: Weapon attacks become clip-driven (the rework)

[`packages/content/data/weapon_actions/*.json`](packages/content/data/weapon_actions/) and
[`packages/tile-server/src/systems/action.ts`](packages/tile-server/src/systems/action.ts)

`WeaponActionDef` schema migration:

| Field | Status |
|---|---|
| `swingPath` | **REMOVE** |
| `ikTargets` | **REMOVE** |
| `defaultBladeRadius/Length` | **REMOVE** |
| `clipId: string` (biped library) | **ADD** |
| `blade: { baseLocal: [x,y,z], tipLocal: [x,y,z], radius: number }` | **ADD** |
| `holdHand?: "hand_r" \| "hand_l"` (default `hand_r`) | **ADD** |
| `windupTicks`, `activeTicks`, `winddownTicks`, `staminaCost`, `damage`, `skillVerb` | keep |

Runtime flow:
1. `ActionSystem` on `pendingSkillVerb` → push the weapon's `clipId` into
   the combat layer's `swing` state via SM "external trigger" (a one-tick
   flag the SM consumes).
2. During `activeTicks`: read `hand_r` world transform from latest skeleton
   solve, transform `baseLocal` and `tipLocal` to world space, sweep capsule
   between successive ticks.
3. Lag-compensated rewind via `StateHistoryBuffer.getAt(serverTick - rttTicks)`
   continues to work — sweeps a different capsule path, same mechanism.

All weapon JSONs migrated:
```json
// weapon_actions/slash.json
{
  "id": "slash",
  "clipId": "sword_and_shield_slash",
  "blade": { "baseLocal": [0, 0.05, 0], "tipLocal": [0, 0.85, 0], "radius": 0.04 },
  "windupTicks": 6, "activeTicks": [6, 14], "winddownTicks": 8,
  "staminaCost": 12, "skillVerb": "strike"
}
```

### Step 6: Delete IK swing-path code

- Drop the swing-path evaluator in `packages/content/src/sweep_math.ts`
  (the `evaluateSwingPath` / `deriveTip` functions and their callers).
- Drop the IK-driven arm code path in
  [`packages/client/src/render/skeleton_evaluator.ts`](packages/client/src/render/skeleton_evaluator.ts).
- `ik_solver.ts` stays — still used by static IK constraints (foot
  planting, weapon grip helper). Just no longer driven by swing keyframes.

---

## Files that will be touched

| File | Change |
|---|---|
| `packages/content/src/types.ts` | + `StateMachineDef`, `SMLayer`, `SMState`, `SMTransition`; modify `WeaponActionDef` |
| `packages/content/src/sm_expression.ts` | NEW — DSL parser |
| `packages/content/src/state_machine.ts` | NEW — runtime |
| `packages/content/src/state_machine.test.ts` | NEW — tests |
| `packages/content/src/store.ts` | + `stateMachines` registry |
| `packages/content/src/loader.ts` | + scan `state_machines/*` |
| `packages/content/data/state_machines/humanoid_default.json` | NEW |
| `packages/content/data/state_machines/humanoid_passive.json` | NEW |
| `packages/content/data/prefabs/drowner.json` | expand `animationSlots` |
| `packages/content/data/prefabs/rotten_knight.json` | expand `animationSlots` |
| `packages/content/data/prefabs/items/iron_sword.json` (et al.) | weapon action format migration |
| `packages/tile-server/src/components/animation_state_machine.ts` | NEW (server-only component) |
| `packages/tile-server/src/systems/animation.ts` | replace hardcoded layer logic with `smRuntime.tick()` |
| `packages/tile-server/src/systems/action.ts` | clip-driven attack flow |
| `packages/tile-server/src/handlers/health_hit_handler.ts` | emit hit events with direction info |
| `packages/content/src/sweep_math.ts` | remove `evaluateSwingPath`/`deriveTip` |
| `packages/client/src/render/skeleton_evaluator.ts` | remove IK-during-swing |
| `TICKETS.md` | mark T-182 done; file T-184 for weapon clip-driven (separate scope) |

---

## Out of scope (future tickets)

- **Networked SM state** for client-side prediction. Server-only for now.
- **Blend trees / parametric blending** between clips (e.g. velocity-blended
  walk→run). Discrete state transitions only in v1.
- **Sub-state machines** (an SM as a state inside another SM). Flat
  layers only.
- **Per-bodypart hit reactions** (head vs gut vs leg). Front/back only.
- **Eight-direction roll**. Single roll clip + root rotate.
- **Per-creature SM definitions** (e.g. `quadruped_default.json`). Wolf
  keeps its current 3-clip cadence; can author a quadruped SM later.

---

## Open architectural call (revisit if needed)

**SM state component networking.** Currently locked as server-only —
client reconstructs from `AnimationLayer[]` which is already networked.
If client-side prediction of state transitions becomes important
(rolling input doesn't feel responsive), revisit and network the SM
state component. Wire cost: ~50 bytes per entity per tick.

---

## Resuming in the next session

Start with **Step 1** above (SM runtime in `@voxim/content`). Keep the
six-step breakdown — each step is a clean commit; together they
constitute T-182 + T-184.

Important context to carry forward:
- The biped library has 367 clips ([`data/anim_library/biped/`](packages/content/data/anim_library/biped/)).
- Skeletons: `biped` (canonical, 17 bones, 10 morph params) and `wolf` (quadruped).
- Existing `ContentService.animationLibraries` registry holds the per-archetype clip libraries (T-178).
- Existing `prefab.animationSlots` is the slot-id → clip-id map that the SM will reuse as its parameter source.
- Bootstrap codec is gzipped (T-179 follow-up); blob size 4.5 MB compressed.
- All Content Architecture tickets through T-180 are landed; T-181 (BT runtime) and T-183 (procedural generators) are still queued and independent of this work.
