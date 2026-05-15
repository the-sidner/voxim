# Action as the Universal Behavior Primitive — Implementation Plan

**Status:** design locked, not yet implemented. Parallel/complementary to `SCENE_GRAPH_PLAN.md`.
**Tickets:** new arc, T-225 through T-235.
**Relationship to scene-graph arc:** T-215 + T-216 (scene-graph primitive + `spawnPrefab` lift) should land first; the Action arc spawns child entities for passive effects and projectiles and benefits from `Parent` being available. Beyond that the arcs are independent and interleave freely.

---

## Why this matters

The codebase today has roughly thirty systems, many of which are variations on one theme: "the character is doing a thing for N ticks and that thing has a windup, an active window, and a winddown." `ActionSystem` does it for swings. `DodgeSystem` does it for rolls. `ConsumptionSystem` does it for eating. `CraftingSystem`, `BuildingSystem`, `ProjectileSystem`, parts of `EquipmentSystem` and `ManeuverScheduler` all carry their own copies of the same FSM with slightly different fields.

Each one re-implements: phase advancement, cancelability rules, stamina gating, intent reading, animation handoff, and "what happens at the moment of contact / completion." The systems aren't *wrong* — they're just N copies of the same shape, and the differences between them belong in data, not code.

The destination is **a single Action primitive** that every character behavior — combat, movement, blocking, dodging, interacting, throwing, consuming, praying, and being-hit — instantiates. Designers compose new behaviors by dropping a JSON file. NPCs and players share the same action library because actions are content. The two-layer (physical + semantic) doctrine from the existing combat code becomes universal: a thin dispatcher advances phases; a small registry of effect resolvers reacts to phase transitions.

The combat feel target is Vermintide-style: every action commits to a winddown you cannot cancel, every windup is a window where you read your opponent and bail. Hit-reactions (flinch, stagger, knockdown) are actions too — they're just initiated by events rather than by intent. Priority-based interruption is the only special rule.

This is the architectural change that turns the system list from "thirty bespoke FSMs sharing event types" into "one dispatcher + a content library + a registry of small resolvers."

---

## The architectural insight

**Every character behavior is an instance of one primitive: `Action`. The actor carries one accumulator (`ActiveAction`). One system (`ActionDispatcher`) is the only writer of that accumulator. Everything else is content or resolvers.**

```
              ┌──────────────────────────────────────────────────┐
              │  Intent (InputState)                              │
              │  ─ player input drain writes here                 │
              │  ─ NPC AI tree writes here                        │
              │  ─ event handlers can post hit-react requests     │
              └────────────────────────┬─────────────────────────┘
                                       │
                                       ▼
              ┌──────────────────────────────────────────────────┐
              │  ActionDispatcher (one system, top of tick)       │
              │  ─ reads ActiveAction + cancel rules              │
              │  ─ reads constraints (stamina, range, equipment)  │
              │  ─ resolves transitions, emits phase events       │
              └────────────────────────┬─────────────────────────┘
                                       │
                            phase-enter / phase-exit
                                       │
                                       ▼
              ┌──────────────────────────────────────────────────┐
              │  Effect resolvers (small handlers per effect kind)│
              │   weapon_trace   projectile_spawn   modify_health │
              │   modify_inventory   start_buff   apply_force   … │
              └──────────────────────────────────────────────────┘
```

- **Intent is the only thing PCs and NPCs disagree about.** Players write it from `InputDatagram`; NPC behavior trees write the same fields. Downstream, the dispatcher cannot tell the difference and does not need to.
- **`ActiveAction` is the canonical accumulator** from the tag-vs-accumulator framing. Component-presence still works as a query (`world.query(ActiveAction)` finds every actor mid-action). Tags like `Blocking`, `Crouched`, `Aiming` are side outputs an action installs on phase-enter and clears on phase-exit.
- **Hit-reactions are actions, not a special case.** Receiving damage emits an event; an effect resolver requests `hit_react_flinch` via the dispatcher; the dispatcher applies the same cancel-and-priority rules as any other action request.
- **The library is data, the dispatcher is code.** Adding a new action — a thrust, a parry, a backstab, a new monster's tail-sweep, a "drink potion" — is a file drop. The dispatcher walks the same `phases / cancel / movement / costs / effects` shape every time.

---

## The Action content schema

```json
// content/data/actions/sword_overhead.json
{
  "id": "sword_overhead",
  "kind": "active",
  "phases": {
    "windup":   { "ticks": 8 },
    "active":   { "ticks": 3 },
    "winddown": { "ticks": 12 }
  },
  "cancel": {
    "windup":   { "into": ["dodge_*", "block_*"] },
    "active":   { "into": [] },
    "winddown": { "into": [] }
  },
  "movement": {
    "windup":   "slowed",
    "active":   "locked",
    "winddown": "slowed"
  },
  "costs": { "stamina": 18 },
  "priority": 5,
  "effects": [
    { "phase": "active:enter", "kind": "weapon_trace",
      "params": { "swingPathId": "sword_overhead" } }
  ],
  "animation": {
    "windup":   { "clipId": "sword_overhead_windup" },
    "active":   { "clipId": "sword_overhead_active" },
    "winddown": { "clipId": "sword_overhead_recover" }
  }
}
```

```json
// content/data/actions/hit_react_flinch.json
{
  "id": "hit_react_flinch",
  "kind": "reaction",
  "phases": { "active": { "ticks": 6 } },
  "cancel": { "active": { "into": [] } },
  "movement": { "active": "locked" },
  "interrupt_priority": 10,
  "effects": [
    { "phase": "active:enter", "kind": "play_anim",
      "params": { "clipId": "flinch_torso" } }
  ]
}
```

```json
// content/data/actions/consume_food.json
{
  "id": "consume_food",
  "kind": "active",
  "phases": {
    "windup":   { "ticks": 4 },
    "active":   { "ticks": 0 },           // instant on enter
    "winddown": { "ticks": 18 }
  },
  "cancel": {
    "windup":   { "into": ["any"] },
    "winddown": { "into": [] }
  },
  "movement": { "windup": "slowed", "winddown": "slowed" },
  "effects": [
    { "phase": "active:enter", "kind": "modify_inventory",
      "params": { "consumeSlot": "$intent.interactSlot" } },
    { "phase": "active:enter", "kind": "apply_edible_effect",
      "params": { "fromSlot": "$intent.interactSlot" } }
  ]
}
```

```json
// content/data/actions/walk.json
{
  "id": "walk",
  "kind": "ambient",                       // always running at priority 0, never completes
  "phases": { "loop": { "ticks": -1 } },   // -1 means perpetual
  "cancel": { "loop": { "into": ["any"] } },
  "movement": { "loop": "free" },
  "effects": [
    { "phase": "loop:tick", "kind": "apply_movement_intent" }
  ]
}
```

### Schema fields

| Field | Meaning |
|---|---|
| `id` | Stable string id. Referenced by intent, AI trees, other actions' cancel lists. |
| `kind` | `active` (intent-driven, completes), `reaction` (event-driven, completes), `ambient` (always running, never completes — e.g. walk, idle). |
| `phases.<name>.ticks` | Duration. `-1` = perpetual. Phase order is the declared key order. |
| `cancel.<phase>.into` | Action ids (glob-supported, e.g. `dodge_*`) that may interrupt this phase from this actor's intent. `["any"]` opts in to anything. Empty means committed. |
| `movement.<phase>` | One of `free` \| `slowed` \| `locked`. Read by PhysicsSystem each tick. |
| `costs.<resource>` | Validated and deducted at action-start. |
| `priority` | Default initiation priority; `interrupt_priority` (reactions) is the threshold for non-consent interruption. |
| `effects[]` | List of `{ phase: "<name>:enter" \| "<name>:exit" \| "<name>:tick", kind, params }`. Resolved by the effect registry. |
| `animation` | Per-phase clip ids; consumed by client AnimationSystem. |

Globs in cancel lists keep the matrix expressible without a quadratic table. Most actions specify "windup cancels into any movement-class action" with `["dodge_*", "block_*"]` and leave the rest to defaults.

---

## Engine surface area

```typescript
// packages/engine/src/action.ts (new)

export interface ActionDef {
  id: string;
  kind: "active" | "reaction" | "ambient";
  phases: Record<string, { ticks: number }>;
  cancel: Record<string, { into: string[] }>;
  movement: Record<string, "free" | "slowed" | "locked">;
  costs?: Record<string, number>;
  priority?: number;
  interruptPriority?: number;
  effects: ActionEffect[];
  animation?: Record<string, { clipId: string }>;
}

export interface ActionEffect {
  phase: `${string}:${"enter" | "exit" | "tick"}`;
  kind: string;            // registry key
  params: Record<string, unknown>;
}

export const ActiveAction = defineComponent({
  name: "activeAction",
  wireId: ComponentType.activeAction,
  codec: activeActionCodec,
  default: () => ({
    actionId: null as string | null,
    phase: "" as string,
    ticksInPhase: 0,
    initiator: "intent" as "intent" | "event" | "ambient",
    rewindTick: -1,                       // set on active:enter for melee
  }),
});

// Effect-kind registry (open set; each system registers its kinds at boot)
export interface ActionEffectResolver {
  kind: string;
  resolve(world: World, actor: EntityId, params: unknown, ctx: ResolveContext): void;
}
export function registerEffectKind(r: ActionEffectResolver): void;
```

The dispatcher itself is a `System` in `packages/tile-server/src/systems/`; the *primitive* (component, schema, registry) lives in `@voxim/engine`. Same split as the scene-graph plan: engine owns the substrate, services install the systems that use it.

---

## How this composes with the other arcs

- **Scene-graph (T-215..T-224).** Passive effects (buffs, DoTs, bleeds, "on fire") are scene-graph children carrying their own `ActiveAction` in ambient/looping mode. Destroying the actor cleans them via `destroySubtree`. Projectile spawn is `world.create + spawnPrefab(parent: actor)` then drift via physics. Equipment-on-bone (T-219) is unrelated but lives comfortably alongside.
- **Tag vs accumulator framing.** `ActiveAction` is the only accumulator on an actor. Tags (`Blocking`, `Aiming`, `Crouched`) are installed by actions on phase-enter and cleared on phase-exit. No system other than the dispatcher writes them either.
- **The "no isNpc branches" doctrine** becomes structural: intent is a layer above the dispatcher, and `NpcAiSystem` writes intent the same way `InputDatagram` does. No downstream system reads anywhere else.
- **Concept-verb matrix and Lore loadout** stay intact. The on-hit half of `SkillSystem` becomes a function called from the `weapon_trace` resolver when a sweep connects. Skill activation (slots 1–4) becomes intent → action id lookup.
- **Lag compensation.** Today `rewindTick` is set inside ActionSystem on the first active tick. After the migration it's set inside ActionDispatcher on `active:enter`. Same machinery, one home.

---

## What gets deleted, what stays

| Delete (subsumed) | Stays (becomes resolver or shrinks) | Stays (orthogonal) |
|---|---|---|
| ActionSystem | ConsumptionSystem → `apply_edible_effect` resolver | PhysicsSystem (reads `movement` enum from ActiveAction) |
| DodgeSystem | CraftingSystem → `produce_item` resolver + workstation actions | AoI / replication |
| ManeuverScheduler | BuildingSystem → `place_blueprint` resolver | SaveManager |
| character_state_machine (system + component) | ProjectileSystem → `projectile_spawn` resolver + projectile actions | AnimationSystem (reads ActiveAction directly) |
| Half of EquipmentSystem (the swap-action half) | Other half of EquipmentSystem (visual shell parenting) | DayNight, Corruption, Lifetime, Hunger, Stamina |
| Half of SkillSystem (activation) | Other half of SkillSystem → `weapon_trace` resolver hook | TraderSystem, DynastySystem, FogOfWar |
| BuffSystem (today's ticking buffs) | Replaced by ambient actions on scene-graph child entities | Hit handlers (handlers/ unchanged) |

Estimated net code delta after the full arc lands: **−2500 to −3500 lines in tile-server**, **+800 lines in engine** (action runtime + registry), **+200 lines in content** (schema, validation). Net is several thousand lines down, with most of the loss being duplicated FSM bookkeeping.

---

## Migration phases / tickets

Each phase is shippable: snapshot determinism stays green, observable behavior matches pre-migration. The arc deletes more than it adds at every step from T-228 onward.

### T-225 — Action schema + content loader

**Goal:** Add `ActionDef` type to `@voxim/content`; load `data/actions/*.json`; expose `content.getAction(id)`. No runtime use yet.

**What lands:**
- `packages/content/src/types.ts` — `ActionDef`, `ActionEffect`
- `packages/content/data/actions/` — directory created; one fixture file (`sword_overhead.json`)
- `packages/content/src/loader.ts` — scans the new directory
- `packages/content/src/content_service.ts` — `getAction(id)`, `getAllActions()`
- Bootstrap blob includes actions (one extra section in `encodeBootstrap`)
- Loader validates: every cancel target exists, every effect kind is non-empty, every phase referenced in `cancel/movement/animation` exists in `phases`

**Out of scope:** the dispatcher, the registry, any runtime. This is content plumbing only.

**Acceptance:** test asserts the fixture loads and round-trips through bootstrap. Existing snapshot tests untouched.

### T-226 — `ActiveAction` component + ActionDispatcher (one action: weapon swing)

**Goal:** Land the runtime: component, dispatcher, effect registry; migrate one action (weapon swing) end to end. Observable behavior identical to today.

**What lands:**
- `packages/engine/src/action.ts` — `ActiveAction` def, codec, effect registry interface
- `packages/codecs/src/components.ts` — `activeActionCodec`
- `packages/protocol/src/component_types.ts` — new `activeAction` slot
- `packages/tile-server/src/systems/action_dispatcher.ts` — the dispatcher
- One effect kind registered: `weapon_trace` (today's hit detection sweep, lifted from ActionSystem)
- Content fixture: `actions/sword_overhead.json` (and any other swing variants in current use)
- Item prefabs with `swingable.weaponActionId` now reference action ids
- The old `ActionSystem` is **deleted** in this commit, not shimmed
- Existing `SkillInProgress` component is **deleted** (replaced by `ActiveAction`)

**Acceptance:**
- Existing combat tests pass with no logic changes
- Snapshot determinism intact
- A swing visually and behaviorally identical to pre-T-226
- `rewindTick` lag-comp still functions

### T-227 — Effect resolver registry (open set) + concept-verb hook

**Goal:** Generalize the effect registry; migrate SkillSystem's on-hit half to a resolver hook.

**What lands:**
- Effect kinds registered in this phase: `weapon_trace` (refactored to call into a generic on-hit pipeline), `apply_skill_verb` (the concept-verb-matrix lookup), `play_anim`, `apply_force`
- Skill slots 1–4 become intent → action id mappings (`actions/skill_strike.json`, etc.)
- SkillSystem's activation half is **deleted**; its on-hit half becomes the `apply_skill_verb` resolver
- LoreLoadout component stays unchanged; concept-verb-matrix lookup unchanged

**Acceptance:** all existing skill effects still fire correctly. Snapshot tests green.

### T-228 — Migrate dodge

**Goal:** First non-swing migration. Proves the cancel matrix across action *kinds*.

**What lands:**
- `actions/dodge_roll.json` — 4t windup, 8t active (i-frames), 6t winddown; cancel-windup-into `["any"]`; movement locked during active
- DodgeSystem **deleted**
- Effect kind `grant_iframes` (or expressed as a tag `IFrames` installed on `active:enter`, cleared on `active:exit`)
- Sword swings' cancel.windup.into includes `["dodge_*", "block_*"]` — proves cross-action cancels

**Acceptance:** dodge feel unchanged; you can dodge-cancel a swing in windup but not in active or winddown.

### T-229 — Migrate consume / interact / pray

**Goal:** Non-combat actions through the same primitive.

**What lands:**
- `actions/consume_food.json`, `actions/consume_drink.json`
- `actions/interact_chest.json`, `actions/interact_door.json`, `actions/pray_statue.json`
- ConsumptionSystem shrinks to two resolver functions (`apply_edible_effect`, `modify_inventory`)
- Bespoke interaction handling in input/command pipelines deletes; everything routes through action requests
- Effect kinds: `modify_inventory`, `modify_health`, `start_buff`, `open_container`, `grant_lore`

**Acceptance:** all consumables, all interactable props, every quest-statue prayer work identically through the dispatcher.

### T-230 — Migrate crafting and building

**Goal:** Workstation interactions and blueprint placement as actions; long-windup work as a real action.

**What lands:**
- `actions/craft_at_workstation.json` (long windup driven by recipe duration; effect on completion places the produced item in inventory)
- `actions/place_blueprint.json`, `actions/construct_blueprint.json`
- CraftingSystem and BuildingSystem shrink to resolvers
- Recipe ids are passed as action params, not as state on a separate component

**Acceptance:** crafting and building end-to-end functional. Workstation animations gate on action phases.

### T-231 — Hit-reactions as actions; interrupt priority

**Goal:** Receiving damage spawns an action on the receiver. Priority-based interruption goes live.

**What lands:**
- `actions/hit_react_flinch.json` (light hit), `actions/hit_react_stagger.json` (medium), `actions/hit_react_knockdown.json` (heavy)
- The `weapon_trace` on-hit pipeline, after computing damage, requests an appropriate hit-react action on the receiver via the dispatcher (initiator: `event`)
- Dispatcher gains interrupt logic: a `reaction` action with `interrupt_priority > current.priority` cancels current and starts immediately, regardless of current's cancel rules
- Effect kind `apply_force` (knockback) attached to stagger/knockdown active:enter

**Acceptance:** combat feel shifts toward what the design calls for — a heavy hit interrupts your swing, a light tap may not, you cannot start a new swing while in your flinch's winddown.

This is the phase where the architecture starts visibly paying off. Designers tune hit reactions by editing JSON.

### T-232 — Movement as ambient Action with movement-lock enum

**Goal:** Walk/idle/sprint become an ambient action; PhysicsSystem reads the current action's per-phase `movement` enum to determine whether and how the actor can move.

**What lands:**
- `actions/walk.json` — ambient, perpetual, low priority; effect `apply_movement_intent` consumes the move vector from Intent each tick
- `actions/sprint.json` — same shape, higher speed multiplier, costs stamina per tick via `tick`-phase effect
- Every other action's `movement` per-phase enum is consulted by `apply_movement_intent`: `free` → full intent passes through; `slowed` → 0.4×; `locked` → zero
- PhysicsSystem no longer reads InputState directly — only `ActiveAction` + Intent through the movement resolver
- "Lock priority" rule: ambient walk never displaces any non-ambient action; it just runs alongside as a low-priority background

This is the trickiest phase because movement is continuous and concurrent with active actions. The model: an actor can have an ambient action AND an active action simultaneously — `ActiveAction` becomes two slots (`active` + `ambient`) rather than one. Resolver dispatch covers both; cancel rules apply within slots, not across.

**Acceptance:** physics behavior identical to today, but no system other than `apply_movement_intent` reads movement intent. Locked-during-swing behavior is now content (`movement: "locked"`), not a code branch.

### T-233 — AI behavior trees as data; NpcAiSystem becomes an interpreter

**Goal:** NPC AI composes the same action library players use. Behavior trees are JSON.

**What lands:**
- `packages/content/data/behaviors/wolf.json`, `villager.json`, etc.
- Behavior-tree primitive types: `sequence`, `selector`, `cond` (predicate), `request_action(id, target?)`, `wait_until(action_complete)`, `pick_target(filter)`
- `NpcAiSystem` becomes a small interpreter that ticks each NPC's tree and writes Intent (action requests + targeting info)
- One NPC archetype migrated end-to-end (wolf, since it's the simplest combat AI); others migrated incrementally
- Existing hardcoded NPC behavior code deletes per archetype

**Acceptance:** wolves attack, retreat, regroup, search using only data. Same observable behavior. Adding a new monster type is now a JSON drop + (optionally) new actions in the action library.

### T-234 — Buffs / DoTs as scene-graph children with ambient actions

**Goal:** Passive concurrent effects collapse into the same machinery.

**What lands:**
- `actions/buff_on_fire.json` — ambient, looping, tick effect `modify_health: -1`, exit effect (timer-driven) destroys the entity
- A buff is a child entity parented to the actor, carrying an `ActiveAction`, a `Buff` marker, and source metadata
- BuffSystem **deleted**
- Hit handlers that previously installed buff state now spawn a buff child entity via `spawnPrefab` (T-216)
- Animation system can read child buff entities to show stacked overlays

**Acceptance:** every existing buff/DoT functions identically. Buffs visible in inspector as child entities of their host actor.

### T-235 — Animation derives from ActiveAction

**Goal:** Close the loop: animation clip selection is data on the action, not a switch in AnimationSystem.

**What lands:**
- AnimationSystem reads `ActiveAction.actionId + phase` → looks up `actionDef.animation[phase].clipId` → drives `AnimationState`
- Locomotion (idle, walk, run) comes from the ambient action's animation spec, not from velocity heuristics
- Existing per-style animation switches in AnimationSystem **deleted**

**Acceptance:** all animations play correctly. Adding a new action with new clips is a JSON edit.

---

## Open architectural calls

**1. One slot or two?**

T-232 proposes `ActiveAction` becomes two slots: one for the ambient action (walk/idle/sprint), one for the active action (swing, dodge, consume, interact, hit-react). The alternative is a single slot where movement is *not* an action but a special-case read from Intent gated by the active action's movement enum. Two slots are cleaner conceptually (everything is an action) but cost one extra component or a slightly fatter codec. Recommend: two slots; commit to the bit early.

**2. Cancel matrix expression.**

Per-action `cancel.<phase>.into: string[]` with glob support is the proposed shape. The alternatives are a global square matrix (NxN, dense) or a tag-based system ("action has tag `melee_swing`, cancelable-into matches by tag"). Recommend: globs by id-prefix convention (`dodge_*`, `block_*`, `skill_*`). Tags can be added later if the prefix convention frays.

**3. Where does the action request *queue* live?**

Inputs can arrive a tick or two before the current action enters cancelable territory. Vermintide-style "input buffer" is roughly 4–6 ticks of grace. Options:
- (A) Dispatcher holds a per-actor `pendingActionRequest` field with a TTL.
- (B) Intent itself carries an "edge time" tick stamp; dispatcher re-checks each tick whether the buffered intent is still valid.
- (C) No buffer; the player has to land the input cleanly inside a cancelable window.

Recommend: (A), with the buffer TTL configurable per action class. The pending request field is part of `ActiveAction` (or a sibling component). NPCs use the same buffer naturally.

**4. Hit-reaction resistance / poise.**

Stagger thresholds (poise) are a real combat-design lever. Should poise live as a constraint consulted by the dispatcher when an event tries to spawn a hit-react, or as a damage-pipeline multiplier? Recommend: dispatcher-side. The event posts a "wants_to_hit_react(severity)" request, the dispatcher reads the receiver's current poise and either spawns the corresponding hit-react action or denies. Poise becomes a regenerating resource on a component, consumed by accepted hit-reacts.

**5. Action chaining / combos.**

Two-hit and three-hit combos: are they (a) cancel-into rules across separate action ids (`actions/sword_slash_1.json` cancels-into `["sword_slash_2"]`), or (b) a single action with multiple active windows? Recommend (a). It composes with the rest of the matrix and lets designers tune each strike independently. A "combo state" component is unnecessary — the cancel matrix encodes the combo.

**6. NPC behavior tree authoring.**

Out of scope for T-233 to ship a full visual editor. JSON is fine for the first archetypes. Future ticket (post-arc) covers a tree editor; T-224 (inspector tooling) is the right home for it.

---

## Invariants to preserve through the arc

1. **Snapshot determinism.** Every phase preserves byte-equivalent snapshot output unless the phase explicitly changes world content. Replication of `ActiveAction` is the only new wire-format addition; existing component deltas otherwise stable.
2. **20 Hz tick budget.** The dispatcher runs once per tick over actors with `ActiveAction`. Effect resolvers fire only on phase transitions, not every tick. Worst case is comparable to current ActionSystem cost.
3. **Lag compensation continuity.** `rewindTick` set on `active:enter` for melee weapon_trace effects, identical semantics to current ActionSystem.
4. **Client visual continuity.** Each phase's behavior, animations, and timings match pre-migration. The migration is transparent to players.
5. **No backward compatibility for content.** Per `CLAUDE.md` refactor rules: existing item prefabs that referenced `weaponActionId` now reference action ids; same field, possibly renamed. JSON migrations land in the same commits as code.
6. **No parallel paths.** Each phase deletes the system it replaces in the same commit. No `useNewDispatcher` flags. No "legacy" branches. The big diff is preferred.

---

## Files that materially change

| Package | Lines today | Estimated delta |
|---|---|---|
| `@voxim/engine` | ~3500 | +800 (action runtime, registry, ActiveAction) |
| `@voxim/codecs` | ~2000 | +100 (activeActionCodec, action-request codec for client→server) |
| `@voxim/content` | ~5000 | +300 (ActionDef types, loader, validation, ~30 action JSON files) |
| `@voxim/tile-server` | ~15000 | −3000 (dispatcher replaces ActionSystem/Dodge/Maneuver/CSM/half of Equipment/half of Skill/Buff; Consumption/Crafting/Building/Projectile shrink to resolvers) |
| `@voxim/client` | ~12000 | −400 (AnimationSystem simplifies; swing predictor reads ActiveAction directly) |
| Net | | **≈ −2200 lines** |

Like the scene-graph arc, this refactor removes code overall while expanding what the engine can express.

---

## Resuming in the next session

Start with **T-225** (content schema + loader). It's the smallest viable foundation; everything downstream depends on `content.getAction(id)` working. T-226 follows immediately and is the first phase where observable runtime behavior is touched.

Important context to carry forward:

- **Scene-graph T-215 and T-216 should land first.** This arc spawns child entities for buffs (T-234) and projectiles, and benefits from `Parent` being available. Beyond T-216 the arcs interleave freely.
- **`ActiveAction` is the canonical accumulator.** Component-presence-as-flag still works; `world.query(ActiveAction)` returns every actor mid-action.
- **Tags (`Blocking`, `Aiming`, `Crouched`) are side outputs.** Installed by actions on phase-enter, cleared on phase-exit. Only the dispatcher writes them.
- **Movement uses a per-phase enum**, not a multiplier. Three values: `free`, `slowed`, `locked`. Designers think in discrete states. Slowed magnitude is a global constant initially; can be promoted to a per-action override later if needed.
- **`NpcAiSystem` writes Intent** (the same `InputState` component players use). Behavior trees compose action requests. No isNpc branches anywhere downstream of the dispatcher — this becomes a structural property.
- **`SkillInProgress` is deleted in T-226**, replaced by `ActiveAction`. The concept-verb-matrix and Lore loadout work survives — it just lives in the `apply_skill_verb` resolver.
- **CLAUDE.md refactor rules apply.** No shims, no `legacy` branches, no feature flags. Each phase deletes the system it replaces in the same commit.
- **The arc is patient.** T-225 alone is shippable. T-226 alone is shippable. Each phase is a clean commit; together they constitute the arc. There is no all-or-nothing moment.

The destination is a codebase where character behavior is content, the engine ships one dispatcher and a small set of resolvers, and adding a new monster's signature move is a JSON drop. That's the lean, interwoven, composable engine the project is converging on.
