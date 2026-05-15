# Action as the Universal Behavior Primitive — Implementation Plan

**Status:** design locked, not yet implemented. Companion to `SCENE_GRAPH_PLAN.md`.
**Tickets:** new arc, T-225 through T-237 (T-225 landed: `97a20cc`).
**Relationship to scene-graph arc:** T-215 + T-216 (scene-graph primitive + `spawnPrefab` lift) should land first. Beyond that the two arcs are independent and interleave freely.

This plan was revised on 2026-05-15 after a survey revealed the codebase had already
absorbed `SkillInProgress` into a richer `CharacterStateMachine` + `SwingContext`
split. The original plan framed the work against an older code shape; this
revision targets today's reality, in which the CSM is the FSM layer that the
Action arc must absorb rather than displace.

---

## Why this matters

The combat / behavior layer today is composed of four overlapping authoring surfaces, each adding capability but none subsuming the others:

1. **`CharacterStateMachine`** (`StateMachineDef`, 445 LOC compiler in `@voxim/content`) — layered concurrent FSMs covering posture, locomotion, right_hand, left_hand. Conditional transitions driven by an expression DSL; per-state animation clip selection; `paramOverrides` for cross-layer modulation; output-flag layers feeding cross-system queries.
2. **`ActionSystem`** (712 LOC) — consumer of the CSM, doing swing-specific work the CSM doesn't: lag-compensated hit sweeps, projectile spawn, chain-step advance, variant pick (light vs. heavy on release), root-motion impulses.
3. **`Maneuver` / `ManeuverLoadout` / `ManeuverScheduler`** — skill-slot-driven multi-track sequences spanning right_hand, left_hand, locomotion, and hit-effect tracks; T-185 work, partially landed.
4. **`SwingContext` / `SwingChain`** — the payload-and-cursor for an in-progress swing, tracked alongside the CSM's `right_hand` layer.

The four are coherent in isolation. Together they make "what is this actor doing right now?" a question with four data sources and three concept names. The `CSM.layerStates["right_hand"].node === "swing.active"` query in one system, `world.has(entityId, SwingContext)` in another, and `world.has(entityId, Maneuver)` in a third are three different ways of asking the same thing.

The cost shows up everywhere: every new combat feature has to negotiate with all four. Hit-reactions, interrupt priority, cancel matrices, mounted actions, throwing, channeling — each addition multiplies. Designers can't add a new monster's signature move without touching CSM JSON, weapon-action JSON, prefab JSON, and possibly maneuver JSON.

The Action arc's destination: **one authoring surface for character behavior — `ActionDef` — backed by one runtime (`ActionDispatcher`) that owns phase advancement, cancel arbitration, effect dispatch, and intent-to-commitment resolution.** Everything else folds in or gets out of the way.

---

## The architectural insight

**Three interlocking primitives.**

```
                ┌───────────────────────────────────────────────┐
                │  Slots                                          │
                │  ─ data on the actor: declared slot set         │
                │  ─ humanoid: [locomotion, primary, posture]     │
                │  ─ horseman: [locomotion, primary, posture,     │
                │               mount]                            │
                │  ─ each slot holds ≤ 1 ActiveAction at a time   │
                └───────────────────────┬─────────────────────────┘
                                        │ slot dispatch
                                        ▼
                ┌───────────────────────────────────────────────┐
                │  Actions                                        │
                │  ─ content: ActionDef JSON                      │
                │  ─ phases, cancel matrix, movement enum,        │
                │    costs, priority, effects, animation,         │
                │    preconditions, limb targets                  │
                │  ─ universal: usable across any equipment/actor │
                │  ─ kinds: active / reaction / ambient           │
                └───────────────────────┬─────────────────────────┘
                                        │ decisions
                                        ▼
                ┌───────────────────────────────────────────────┐
                │  Gates                                          │
                │  ─ closed-vocabulary typed predicates           │
                │  ─ registered in code, referenced from JSON     │
                │  ─ used in preconditions + cancel rules         │
                │  ─ no expression DSL, no logic trees in data    │
                └───────────────────────────────────────────────┘
```

### Slots

An actor's behavior surface is divided into named slots. Each slot holds at most one `ActiveAction` at a time. Slot dispatch is independent — the dispatcher walks each slot in turn, advancing the action in it. Cross-slot dependencies are expressed via gates (`slot_idle`, `slot_busy`), never via direct coupling.

For the humanoid:

| Slot | Holds | Examples |
|---|---|---|
| `locomotion` | ambient — always running, perpetual phase | `walk`, `idle`, `sprint`, `strafe_left` |
| `primary` | active / reaction — main upper-body commitment | `swing_medium`, `block`, `consume_food`, `dodge_roll`, `hit_react_flinch` |
| `posture` | ambient — held tag-style state | `upright`, `crouched`, `prone` |

The primary slot governs the **whole upper body** — both hands. An action declares which limbs it animates (`limbs: ["right_hand"]`, `["left_hand"]`, `["both_hands"]`, `["head"]`) but slot ownership is one. One-handed sword swing claims right_hand; the left hand is free for the animation system to keep in idle. Two-handed greatsword claims both. Asymmetric two-handed (block left, swing right) is one primary-slot action that targets both with different sub-effects.

The slot set is **data-driven per actor template**. The engine does not hardcode `locomotion / primary / posture`; the actor's prefab declares them via an `actorSlots` field. Adding a `head` slot for vocalizations or a `mount` slot for horseback play is a template edit, not a code change.

### Actions

`ActionDef` is the universal content type for character behavior. It declares:

- **Slot** — which slot it occupies (`slot: "primary"`)
- **Limbs** — animation metadata (`limbs: ["right_hand"]`)
- **Kind** — `active` (intent-driven, completes), `reaction` (event-driven, can interrupt), `ambient` (always running, perpetual phase)
- **Phases** — name → tick count; order is declaration order; `-1` = perpetual (ambient only)
- **Cancel matrix** — per-phase `{ into: ActionId[], gates?: ActionGate[] }`
- **Movement enum** — per-phase `free | slowed | locked`; consumed by physics
- **Costs** — resource deductions on initiate (`{ stamina: 18 }`)
- **Priority / interruptPriority** — initiate priority for active; interrupt threshold for reaction
- **Effects** — list of `{ phase: "<name>:<edge>", kind, params }`, dispatched on phase transitions through the effect registry
- **Animation** — per-phase clip refs handed to the animation system
- **Preconditions** — list of `ActionGate` evaluated at initiation

Actions are **universal across equipment**. `swing_medium` is one action, used by sword, axe, mace, polearm, whichever has the right swing tempo. The action specifies timing and gameplay; the weapon specifies geometry (swing path, blade extent), animation clip (per archetype), and damage. The chain-step entry on a weapon references which action to play per step.

### Gates

A small, closed vocabulary of typed predicates. Each gate is registered in code at startup (same pattern as effect resolvers). Actions reference gates by name with typed params from JSON. **No expression DSL.** No boolean composition (`A AND (B OR C)`). If a check is needed that the registry can't express, the answer is to add a new gate to the registry, not to extend an in-JSON logic syntax.

The starting vocabulary (~14 gates), derived from what the CSM checks today plus the cancel matrix needs:

| Gate kind | What it asks |
|---|---|
| `has_resource` | `{ kind: "stamina" \| "mana" \| ..., min: N }` |
| `tag_present` | `{ tag: string }` — actor carries this tag component |
| `tag_absent` | `{ tag: string }` |
| `slot_idle` | `{ slot: string }` — no active commitment in that slot |
| `slot_busy` | `{ slot: string }` |
| `posture_is` | `{ posture: "upright" \| "crouched" \| "prone" }` (sugar over tag_present) |
| `equipped_category` | `{ slot: "weapon" \| "shield" \| ..., category: string }` |
| `equipped_tag` | `{ slot: string, tag: string }` |
| `target_in_range` | `{ max: N }` — current targeted entity within distance |
| `target_kind` | `{ kind: "actor" \| "prop" \| "terrain" \| "blueprint" }` |
| `velocity_above` | `{ min: N }` |
| `velocity_below` | `{ max: N }` |
| `intent_held` | `{ action: "block" \| "use_skill" \| ... }` — input bit held |
| `intent_edge` | `{ action: ... }` — input bit went 0→1 this tick |
| `cooldown_clear` | `{ id: string }` — named per-actor cooldown is zero |
| `random_lt` | `{ p: 0..1 }` — for AI variability |

Adding `has_status_effect`, `target_facing`, `weather_is`, etc. is a new gate registration in code (~5 lines) plus references in JSON. The discipline: gates are *named and typed*, not composed inline.

---

## Absorbing the CharacterStateMachine

The CSM does five distinct jobs in one structure. Each job has a defined new home:

| CSM responsibility today | New home |
|---|---|
| Layered concurrent FSMs (posture, locomotion, right_hand, left_hand) | **Slots on the actor.** Layer → slot. State → action. Per-slot dispatch handles concurrency. |
| Conditional transitions via expression DSL | **Gate library.** Closed vocabulary, named gates, no expression evaluator. |
| Animation clip selection per state | **AnimationSystem.** Reads ActiveAction in each slot + tags + velocity → picks/composites clips. |
| `paramOverrides` (clip varies by condition) | **AnimationSystem.** Animation-side rules: "if Crouched tag set, swap clip X for X_crouch." Stops mixing with FSM. |
| Output-flag layers (`csm.posture == crouched`) | **Tags installed by perpetual-phase ambient actions.** Posture slot running `crouched` action installs `Crouched` tag. Queries become `world.has(entityId, Crouched)`. |

After the migration: no `StateMachineDef`, no `CharacterStateMachine` component, no `state_machine.ts` compiler/ticker, no `humanoid_default.json`, no `csm.layerStates[...]` reads anywhere. The 445-line CSM compiler in `@voxim/content` and the 157-line CSM ticker in tile-server both go.

**What stays:** the actor-prefab field that referenced `stateMachineId` is replaced by `actorSlots` (the declared slot set) plus per-actor-template starting-action references for ambient slots.

---

## Absorbing Maneuvers, SwingContext, SwingChain

| Existing structure | New home |
|---|---|
| `Maneuver` + `ManeuverDef` (multi-track timed sequences) | **Multi-effect primary-slot actions.** A maneuver's tracks become per-phase effects: `right_hand` track entries → `play_anim` effects on the primary slot; `locomotion` track entries → effects that post sub-actions into the locomotion slot at specific phase times; `hitEffects` track entries → tag-install effects active during phase windows. |
| `ManeuverLoadout` (4-slot bindings to maneuver ids) | **Skill loadout: intent → action id mapping.** Pressing `ACTION_SKILL_1` looks up the actor's skill-slot[0] action id and posts an action request. Same shape, different field name. |
| `ManeuverScheduler` system | **Dispatcher** does this work. No separate scheduler. |
| `SwingContext` (per-swing payload: weaponPrefabId, hitEntities, rewindTick, quality, pendingSkillVerb) | **Resolver-local state.** The `weapon_trace` effect resolver owns the rewindTick + hitEntities dedup set across the active phase. `weaponPrefabId` derives from the wielder's equipment each tick. `pendingSkillVerb` derives from the loadout at active-phase-enter, dispatched into the concept-verb resolver on hit. |
| `SwingChain` (chain step counter) | **Resolver-local + cancel-into composition.** The chain becomes a per-weapon list of action ids: swing chain entry N references action id A_N. Chain step N+1 is entered via cancel-into rules from A_N's winddown. The "chain index" is implicit in which action is currently committed. |

After the migration: `SwingContext`, `SwingChain`, `Maneuver`, `ManeuverLoadout`, `Staggered` (subsumed by hit-react actions), and the maneuver-related codecs all go.

---

## The ActiveAction component shape

```typescript
// packages/engine/src/action.ts (new)

export const ActorSlots = defineComponent({
  name: "actorSlots",
  wireId: ComponentType.actorSlots,
  codec: actorSlotsCodec,
  default: () => ({ slots: [] as string[] }),   // declared slot ids
});

export const ActiveActions = defineComponent({
  name: "activeActions",
  wireId: ComponentType.activeActions,
  codec: activeActionsCodec,
  default: () => ({ states: {} as Record<string, ActiveActionState> }),
});

export interface ActiveActionState {
  actionId: string;
  phase: string;
  ticksInPhase: number;
  initiator: "intent" | "event" | "ambient";
  // Optional per-resolver scratch space — opaque to the dispatcher.
  // Carried inline to keep replication simple; resolvers cast on access.
  scratch?: Record<string, unknown>;
}
```

One `ActiveActions` component per actor; one entry per occupied slot. Removing the slot entry is the "action ended" signal. The dispatcher is the only writer; effect resolvers read but never write directly (they emit events and tag-installs).

Wire size: typically 2-3 slots occupied → ~30-60 bytes per actor per delta. Per-tick deltas only when the slot's state changes (phase transition or ticksInPhase advance). The pre-existing AoI machinery handles the rest.

---

## Effect resolver registry

```typescript
export interface ActionEffectResolver {
  kind: string;
  resolve(
    world: World,
    actor: EntityId,
    slot: string,
    state: ActiveActionState,
    params: unknown,
    edge: "enter" | "exit" | "tick",
    ctx: ResolveContext,
  ): void;
}

export function registerEffectKind(r: ActionEffectResolver): void;
```

Resolvers are registered at server startup. The starting set covers what today's systems do imperatively:

| Effect kind | Replaces |
|---|---|
| `weapon_trace` | `ActionSystem.resolveHits` (sweep, hit handler dispatch, hit-spark events) |
| `projectile_spawn` | `ActionSystem.spawnProjectile` |
| `apply_skill_verb` | Half of `SkillSystem` (concept-verb-matrix lookup on hit) |
| `modify_inventory` | Consumable / pickup hooks |
| `modify_health` | Health changes from consumables / DoTs / hit-react damage |
| `modify_resource` | Stamina / hunger / thirst deltas |
| `apply_force` | Knockback / impulse (lifts `ActionImpulse` writes) |
| `start_buff` | Spawns a scene-graph child entity carrying a Buff ambient action |
| `set_tag` / `clear_tag` | Held-tag lifecycle (e.g., `Blocking` on block action's active-enter, cleared on exit) |
| `play_anim` | Direct clip handoff (most actions use the `animation.<phase>` field, but maneuvers need explicit dispatch) |
| `post_action` | Post a sub-action into another slot (used by multi-effect actions) |
| `consume_item` | Decrement / destroy an item slot in inventory |

Each resolver is ~10-40 lines. Total registry size at the end of the arc: maybe 600-800 lines across the resolver implementations. The current systems that do these jobs aggregate to roughly 2000+ lines.

---

## ActionDef schema — final

```jsonc
// content/data/actions/swing_medium.json
{
  "id": "swing_medium",
  "kind": "active",
  "slot": "primary",
  "limbs": ["right_hand"],
  "phases": {
    "windup":   { "ticks": 8 },
    "active":   { "ticks": 3 },
    "winddown": { "ticks": 12 }
  },
  "cancel": {
    "windup":   { "into": ["dodge_*", "block_*"], "gates": [] },
    "active":   { "into": [] },
    "winddown": { "into": ["swing_medium"], "gates": [
                    { "gate": "has_resource", "params": { "kind": "stamina", "min": 8 } }
                  ] }
  },
  "movement": {
    "windup":   "slowed",
    "active":   "locked",
    "winddown": "slowed"
  },
  "costs": { "stamina": 18 },
  "priority": 5,
  "preconditions": [
    { "gate": "tag_absent", "params": { "tag": "stunned" } },
    { "gate": "equipped_category", "params": { "slot": "weapon", "category": "blade" } }
  ],
  "effects": [
    { "phase": "active:enter", "kind": "weapon_trace" }
  ],
  "animation": {
    "windup":   { "clipId": "$swing_windup" },
    "active":   { "clipId": "$swing_active" },
    "winddown": { "clipId": "$swing_recover" }
  }
}
```

The `$alias` clip refs survive the migration as an animation-side concern: the AnimationSystem resolves `$swing_windup` against the actor's archetype animation slot map (same mechanism as today, just lifted out of CSM).

The chain-step is expressed as cancel-into rules: `swing_medium.winddown.into = ["swing_medium"]` (with a stamina gate) re-enters the action for chain-step 2. The "variant pick" (light vs heavy on release) becomes a windup-phase cancel-into: holding past N ticks promotes to a `swing_heavy` cancel-into, gated on a hold-time gate (new gate kind: `windup_held_ticks_above`). Per-weapon geometry per chain step lives on the weapon prefab's `swingable.chain[]`, looked up at `weapon_trace` resolution.

---

## Engine surface area

```
packages/engine/
  src/
    action.ts          ★ NEW — ActorSlots, ActiveActions, types, default codecs
    action_dispatch.ts ★ NEW — gate registry, effect registry, ActionDispatcher
    scene.ts             (scene-graph T-215)
    world.ts             (existing)
    physics.ts           (existing)
    events.ts            (existing)
  mod.ts                 (exports the above)
```

`ActionDispatcher` is the System in tile-server that wires the engine primitives. It lives in `packages/tile-server/src/systems/action_dispatcher.ts` and consumes the engine's gate registry + effect registry. Engine ships the *substrate*; service ships the *system that uses it*.

Gate implementations live in tile-server too — they consume world state directly (read components, query AoI, etc.). Engine declares the registration interface; tile-server registers the concrete gates at boot. Same pattern as effect resolvers.

---

## How this composes with the scene-graph arc

- **Buffs as scene-graph children.** A status effect (`OnFire`, `Bleeding`, `Poisoned`) is a child entity parented to the actor. The child carries its own `ActiveActions` with an ambient looping action whose `tick`-phase effect emits `modify_health: -N` on the parent. Destroying the actor destroys the subtree via `destroySubtree` (scene-graph T-215). Replication and inspector navigation work for free.
- **Projectiles as spawned entities.** `projectile_spawn` resolver calls `spawnPrefab` (scene-graph T-216) for the projectile prefab; physics + lifetime + own ActiveAction (for fuse / explosion timing) all live on the projectile entity.
- **Equipment attachment via scene-graph** (T-219 / T-220) is unrelated to actions but plays well alongside: equipping a sword `setParent`s it to the right-hand bone entity; weapon-trace resolver reads the equipped weapon via the parent-child traversal.

The two arcs reinforce each other. T-215/T-216 should land before this arc's first migration that spawns child entities (T-236 buffs).

---

## What gets deleted, what stays

| Delete (subsumed by the arc) | Becomes a resolver (much smaller) | Stays orthogonal |
|---|---|---|
| `CharacterStateMachine` system + component | (n/a — fully replaced) | Physics (reads `movement` enum from primary-slot ActiveAction) |
| `state_machine.ts` (445 LOC compiler) | (n/a) | AoI / replication |
| `humanoid_default.json` (CSM JSON) | (n/a — replaced by ambient-action references on actor template) | SaveManager |
| `StateMachineDef` content type | (n/a) | DayNight, Corruption, Lifetime, Hunger, FogOfWar, Trader, Dynasty |
| `state_machines/` directory | (n/a) | Hit handlers (handlers/ unchanged — called from `weapon_trace` resolver) |
| `ActionSystem` (712 LOC) | (n/a) | TraderSystem, DynastySystem, BuildingSystem (per-phase resolvers), Crafting, Consumption — these become resolvers |
| `DodgeSystem` | `grant_iframes` resolver + `dodge_*` action JSON | |
| `Maneuver`, `ManeuverLoadout`, `ManeuverScheduler` | Multi-effect primary-slot actions | |
| `SwingContext` (component + codec) | Resolver-local state inside `weapon_trace` | |
| `SwingChain` (component + codec) | Cancel-into rules between chain-step actions | |
| `Staggered` component | Replaced by the hit-react action's tag installs | |
| Half of `SkillSystem` (slot activation) | Intent → action id lookup in dispatcher | |
| Half of `EquipmentSystem` (swap-action half) | `equip` / `unequip` actions | |
| `BuffSystem` (today's ticking) | Scene-graph child entities with ambient looping actions |
| `ActionImpulse` (root-motion writes) | `apply_force` resolver |

Estimated code delta after the full arc lands: **≈ −3500 to −4500 lines in tile-server**, **−500 lines in content** (CSM compiler), **+1200 lines in engine** (action runtime + registries), **+400 lines in content** (~30 action JSON files + schema additions). Net several thousand lines down. Per the refactor doctrine: replace, don't accrete.

---

## Migration phases / tickets

Each phase is a shippable atomic commit. The arc deletes more than it adds from T-228 onward. Snapshot determinism stays the invariant.

### T-225 — Action schema + content loader (LANDED, `97a20cc`)

Initial ActionDef type, loader, validator, bootstrap codec. Status: done. The schema added in T-225 needs three follow-up extensions in T-226: `slot`, `limbs`, `preconditions`, and `cancel.<phase>.gates`. These slot in cleanly — the bootstrap codec version bumps again.

### T-226 — Engine substrate + locomotion + posture migration (two green sub-commits)

> **Revised mid-implementation (2026-05-15).** The phase was scoped as one
> atomic commit. After surveying the AnimationSystem (363 LOC, deeply
> CSM-coupled, gated by snapshot determinism) the locomotion/posture parity
> surgery is the real risk and welding it to foundational type definitions
> in one unreviewable diff is unsound. T-226 lands as **two sub-commits,
> each green**: (a) the substrate, proven in isolation; (b) the
> locomotion/posture migration that consumes it. This trades the
> "nothing ships dead for one commit" guideline for a reviewable,
> bisectable boundary at the highest-risk seam — a deliberate, recorded
> exception to the atomic-phase invariant for this phase only. The
> `commit` is no longer the atomic unit here; the **pair** is.
>
> - **T-226a — substrate (LANDED).** `ActionDef` schema extensions
>   (`slot`, `limbs`, `preconditions`, `ActionCancelRule.gates`,
>   `ActionGate`); `actorSlotsCodec` / `activeActionsCodec`; wire ids
>   47/48; `ActorSlots` + `ActiveActions` components; entity-generic gate
>   + effect registries; `ActionDispatcher` (phase advancement, cancel
>   arbitration, reaction interrupt, precondition + cost gating, slot
>   validation). 9 dispatcher + 12 schema/codec tests. Nothing wired into
>   the server tick. Commit: `<this commit>`.
> - **T-226b — posture migration (LANDED).** Scoped down from
>   "locomotion + posture" once the locomotion CSM layer proved
>   entangled: its `sidestep` state is `i_frame`-tagged and
>   `input.dodge`-driven (that is *dodge*, a later phase), and
>   jump/airborne/landing are physics-coupled transient states — too
>   much to migrate safely alongside posture. Posture alone proves the
>   whole substrate path at near-zero risk: physics crouch (speed) was
>   already independent of the posture layer, and the *only* coupling —
>   the 5 locomotion crouch-variant `paramOverrides` reading
>   `csm.posture == crouched` — is preserved by feeding the new
>   `Crouched` tag into the (still-CSM-resident) locomotion layer via a
>   `posture` scope contributor. Same one-tick-lag semantics; no
>   AnimationSystem change; bake snapshot byte-identical.
>   What landed: `Prefab.actorSlots` + inheritance merge; spawn-install
>   of `ActorSlots`/`ActiveActions`; `Crouched` server-only tag +
>   `TAG_COMPONENTS`; `set_tag`/`clear_tag` resolvers;
>   `PostureIntentResolver` (+ `CompositeIntentResolver` for later
>   slots); `upright.json`/`crouched.json`; `posture` scope contributor;
>   posture layer deleted from `humanoid_default.json` + 5 paramOverrides
>   rewritten `csm.posture == crouched` → `posture.crouched`;
>   `ActionDispatcher` wired into `server.ts` before the CSM. 3 parity
>   tests incl. "humanoid_default compiles + scope-validates" (the
>   boot-critical check). Commit: `<this commit>`.
> - **T-226c — locomotion migration (LANDED).** Three green
>   sub-commits: (c1) `ActionAnimation` projection schema fields
>   (clipId/crouchClipId/loop/speedScale/mask); (c2) the 9 locomotion
>   action JSONs + `LocomotionIntentResolver` — a faithful port of the
>   CSM layer's 13 transitions (priority order, from-state allow-lists,
>   0.5-enter/0.2-exit velocity hysteresis, dodge settle guard,
>   mid-action→duration-exit-to-idle), 10 FSM-port tests; (c3)
>   `projectLocomotion` (AnimationSystem emits the lower-body layer from
>   the locomotion slot, mirroring effectiveState+resolveSpeedScale+
>   computeClipTime exactly; empty-slot→idle so no rest-pose flash), CSM
>   locomotion layer deleted, `posture` scope contributor + posture.ts
>   deleted (its only consumer was the now-gone locomotion
>   paramOverrides — the Crouched tag is read directly by the
>   projection; no lingering bridge), `CompositeIntentResolver([Posture,
>   Locomotion])` wired, 8 projection-parity tests. `sidestep` migrated
>   as a basic i-frame-cosmetic placeholder (a half-deleted CSM layer is
>   not possible); its *proper* dodge semantics — cancel-into,
>   real i-frames — come with dodge (T-229). Gameplay untouched
>   (csm.locomotion had zero gameplay consumers — jump/dodge/airborne
>   always read input+components directly). Bake byte-identical across
>   all 11 atlas snapshots.
>
> **T-226 is fully landed.** The CSM is reduced to
> right_hand/left_hand/reaction. Posture and locomotion are action
> slots. The substrate is proven in production by two real migrations.
> T-227 (universal swing library; delete ActionSystem + the CSM combat
> layers) is next.
>
> The numbering does not shift: T-226 owns its sub-commits (a/b/c);
> T-227+ keep their ids, so the sibling arcs T-238/T-239 don't collide.

Everything in "What lands" below describes the *full* T-226 phase as
originally conceived; it is now realised across 226a (substrate), 226b
(posture, done), 226c (locomotion, next).

**Goal:** Land the engine primitives, gate library, effect registry, dispatcher; migrate the two simplest CSM layers (locomotion + posture) end-to-end. Observable behavior identical to today for upper-body combat; CSM still drives `right_hand` + `left_hand` for now.

**What lands:**
- Engine: `ActorSlots`, `ActiveActions`, codecs, `ActionDispatcher`, gate-registry interface, effect-registry interface
- Schema extensions in `@voxim/content`: `ActionDef.slot`, `ActionDef.limbs`, `ActionDef.preconditions`, `ActionCancelRule.gates`
- Tile-server registers the 14-gate starting library + the first two effect resolvers (`apply_movement_intent` for locomotion, `set_tag`/`clear_tag` for posture)
- Actor prefab field: `actorSlots: string[]` (replacing `stateMachineId` for migrated slots only)
- Action library starts: `walk.json`, `idle.json`, `sprint.json`, `strafe_left.json`, `strafe_right.json`, `upright.json`, `crouched.json`, `crouch_transition_in.json`, `crouch_transition_out.json`
- `CharacterStateMachine` layer set narrows: locomotion + posture layers **removed** from `humanoid_default.json` in this commit; right_hand + left_hand layers **stay** (transitional)
- PhysicsSystem reads movement from the locomotion slot's current action movement enum; CSM-driven locomotion writes deleted
- AnimationSystem reads slot actions for lower-body + posture; CSM-driven clip selection for those layers deleted
- Tests: dispatcher tick semantics, gate evaluation, locomotion action transitions match prior CSM behavior

**Files touched:** ~25 files; estimated diff 1500-2000 lines, of which ~600 are net deletes.

**Acceptance:** Walking, idle, sprinting, strafing, crouching all behave identically to today. Snapshot determinism intact. Upper-body combat untouched. Hot path for combat still runs through CSM right_hand + ActionSystem.

This is the foundation phase. The substrate is exercised by the smallest meaningful migration; nothing ships dead.

### T-227 — Universal swing action library + chain refactor

> **In progress — sub-commits (each green):**
> - **c1 (LANDED)** — universal swing library, inert: `swing_light/
>   thrust/medium/heavy/spin` + `ranged_shot`, timing buckets derived
>   from the existing WeaponActionDef tempos, reused across any weapon.
>   Referenced by no weapon, no resolver registered.
> - **c2 groundwork (LANDED)** — `ResolveContext.serverTick` +
>   `ActionDispatcher.prepare()` (lag-comp resolvers need the tick).
> - **c2/c3/c4 (NEXT — deep, uncovered)** — see coupling map below.
>
> **Scope refinements recorded mid-implementation:**
> 1. **`SkillSystem` is kept whole.** Its on-hit half is a `StrikeLanded`
>    event *subscriber*, not in the swing path — the weapon_trace
>    resolver just publishes `StrikeLanded` as `ActionSystem` did. Its
>    activation half (skill bits → invoke/ward/step) is unrelated to
>    swings; that split defers to a later phase. T-227 retires
>    `ActionSystem` + CSM `right_hand`/`left_hand` + `SwingContext`/
>    `SwingChain` + `ActionImpulse` only — smaller, same destination.
> 2. **`ranged_shot` is one action** (windup/active/winddown = 20/1/12,
>    mirroring `bow_shot`) rather than the planned two cancel-chained
>    actions — the faithful low-risk representation; the two-action
>    split is a later refinement.
>
> **Coupling discovered during the c2 survey (the real T-227 cost):**
> the swing path is more entangled than this plan first captured —
> - `health_hit_handler` reads `SwingContext.pendingSkillVerb` directly
>   to publish `StrikeLanded`. Retiring `SwingContext` means the skill
>   verb must reach the handler another way (resolver derives it from
>   `LoreLoadout` and carries it on `HitContext`, or via scratch).
> - `HitContext.targetSnapshotCsmNodes` ⇒ lag-comp **block/parry
>   detection rewinds the target's CSM `right_hand` node** out of
>   `StateHistoryBuffer`. Deleting that CSM layer requires
>   `StateHistoryBuffer` to snapshot the relevant `ActiveActions` slot
>   state instead, and hit-handler block detection to read it.
> - The light/heavy variant pick (windup-release `chargeMs`) and combo
>   chain advance (`SwingChain` + `queued`) must become windup-held
>   gates + cancel-into rules.
> These make c3/c4 a genuine multi-session rewire that should land
> behind a combat record/replay parity harness (capture today's
> per-tick hit/damage/event stream, assert byte-identical post-migration)
> — built as the first c3 step. Recorded so the next session executes
> with this map rather than rediscovering it.

> **PIVOT (user directive): structure over parity.** "Don't mind
> dataloss, we can redo that — it's about finding the structure now."
> No combat record/replay harness. The coupling map above still holds,
> but the resolution is now *aggressive rebuild + accept retuning*, not
> byte-faithful preservation: block/parry lag-comp precision, exact
> swing feel, and maneuvers may regress and get re-tuned/rebuilt later.
> Maneuvers break in T-227 and are rebuilt as actions in T-228
> (acceptable). This matches CLAUDE.md (saves/wire formats may break).
>
> **Landed so far:** c1 inert swing library; c2 groundwork
> (`ResolveContext.serverTick`); **c3a — `weapon_trace` +
> `projectile_spawn` resolvers** (structural port of
> `resolveHits`/`spawnProjectile`/`computeBladeWorld`; rewind+dedup in
> `state.scratch`; strike verb via `HitContext.skillVerb`, decoupled
> from `SwingContext`). Type-clean, registered via barrel, not yet
> wired live.
>
> **The flip (LANDED).** One atomic commit: `PrimaryIntentResolver`
> (ACTION_BLOCK → held `block`/`Blocking` tag; ACTION_USE_SKILL → the
> weapon's `swingActionId`; mid-swing → undisturbed; else
> `primary_idle`); `CompositeIntentResolver([Posture, Locomotion,
> Primary])`; **deleted** `ActionSystem` (712 LOC), `DurabilitySystem`,
> `ManeuverSchedulerSystem`, the `action` sm-scope contributor,
> `SwingContext`, `SwingChain`, `ActionImpulse`, CSM `right_hand` +
> `left_hand`. weapon_trace folds in durability; AnimationSystem
> projects locomotion + primary slots (CSM loop now only `reaction`);
> `health_hit_handler` blocks via the `Blocking` tag + strikes via
> `ctx.skillVerb`; `terrain_hit_handler` gates on the primary swing;
> Maneuver/ManeuverLoadout kept as inert defs (prefabs still load),
> runtime gone → rebuilt as actions in **T-228**. Type-clean; 45
> action/loader + 33 sm/locomotion/bake-snapshot tests green; bake
> byte-identical. **The CSM is fully out of locomotion/posture/combat —
> only the `reaction` layer remains.** Accepted regressions (retuned
> later): swing feel, lag-comp block precision, root-motion carry,
> maneuvers, weapon-trail windowing, client swing_predictor/overlay.
>
> **T-227 fully landed.** Next: **T-228** — rebuild maneuvers as
> multi-effect actions and delete the inert Maneuver defs + the
> remaining `reaction` CSM layer (→ hit-reactions become actions, the
> CSM is gone entirely).

**Goal:** Replace the `right_hand` CSM layer + `ActionSystem` + `SwingContext` + `SwingChain` with the action runtime. Universal swing actions; weapons reference action ids per chain step.

**What lands:**
- Action library: `swing_light.json`, `swing_medium.json`, `swing_heavy.json`, `swing_thrust.json`, `swing_360.json`, `ranged_draw.json`, `ranged_release.json` (the ranged sequence as two cancel-chained actions)
- `weapon_trace` and `projectile_spawn` resolvers (lifting `ActionSystem.resolveHits` and `spawnProjectile`)
- `apply_skill_verb` resolver (lifting the on-hit half of `SkillSystem`)
- Each weapon prefab's `swingable.chain[]` entries gain an `actionId` field; the existing `weaponActionId` field stays for now (it's the geometric data the `weapon_trace` resolver reads)
- CSM `right_hand` and `left_hand` layers **removed** from `humanoid_default.json`
- `ActionSystem` **deleted** (full 712 LOC)
- `SwingContext`, `SwingChain` components **deleted**; their codecs deleted from `@voxim/codecs`
- Half of `SkillSystem` deleted (the activation half); the other half lives on as `apply_skill_verb` resolver
- `ActionImpulse` deleted; root-motion lives as `apply_force` resolver effects on swing phase entry

**Acceptance:** Every existing combat scenario plays identically — swing timings, lag comp, chain advances, light/heavy variant pick, projectile shots, on-hit skill verb effects. Snapshot determinism intact. The `CharacterStateMachine` component still exists (no other layers to remove yet, but the right_hand and left_hand layers are gone from the def).

**Files touched:** ~35 files; estimated diff 2500-3500 lines, of which ~1500 are net deletes.

### T-228 — Maneuvers absorbed, CSM retired

**Goal:** Convert all existing maneuvers to multi-effect primary-slot actions; delete the CSM entirely now that no layers remain.

**What lands:**
- Each existing `ManeuverDef` JSON migrated to one or more `ActionDef` JSONs (multi-effect; effects post sub-actions into locomotion / posture slots at phase boundaries via `post_action` resolver)
- `post_action` effect resolver
- `ManeuverLoadout` replaced by a generic `SkillLoadout` (intent skill-bit → action id lookup); dispatcher reads it at intent resolution time
- `Maneuver`, `ManeuverLoadout` components deleted; `ManeuverScheduler` system deleted
- `CharacterStateMachine` component + system deleted
- `state_machine.ts` (compiler), `state_machines/` directory, `humanoid_default.json` all deleted
- `StateMachineDef` content type removed
- Actor prefab `stateMachineId` field replaced by `actorSlots` everywhere; `paramOverrides` fields migrate to animation-side rules

**Acceptance:** Every existing maneuver plays identically. No CSM code or data anywhere in the tree. Snapshot determinism intact.

**Files touched:** ~50 files; estimated diff 3000-4000 lines, of which ~2500 are net deletes.

### T-229 — Migrate dodge

`actions/dodge_roll.json` with i-frame tag-install effects, cancel-windup-into `["any"]`. DodgeSystem deleted. First cross-action cancel-into proves out (swing windups cancel into `dodge_*`).

### T-230 — Migrate consume / interact / pray

Consumables, interactable props, quest-statue prayer — all as primary-slot actions. ConsumptionSystem shrinks to its resolver functions (`apply_edible_effect`, `modify_inventory`). Bespoke command-pipeline interaction handling deleted; everything routes through action requests.

### T-231 — Migrate crafting and building

Long-windup actions; recipe ids as action params. CraftingSystem and BuildingSystem shrink to resolvers.

### T-232 — Hit-reactions as actions; interrupt priority + poise

`hit_react_flinch.json` / `hit_react_stagger.json` / `hit_react_knockdown.json` as reaction-class actions. The `weapon_trace` resolver's on-hit pipeline posts a hit-react action request to the receiver after damage. Dispatcher gains interrupt logic. Poise becomes a regenerating resource consulted by a `poise_available` gate.

`Staggered` component deleted (replaced by tag installs from hit-react actions).

### T-233 — Block as primary-slot action

Block goes from "input bit checked everywhere" to "held primary-slot action with a tail phase that maintains the `Blocking` tag." Cancel rules let blocks transition into swings (parry → riposte) and dodges. Combat-side block checks become `tag_present: Blocking` gate queries.

### T-234 — AI behavior trees as data on the action vocabulary

NPC behavior trees authored as JSON. Tree primitive types: `sequence`, `selector`, `cond` (gate predicate), `request_action(id, target?)`, `wait_until(action_complete)`, `pick_target(filter)`. One NPC archetype (wolf) migrated end to end. `NpcAiSystem` becomes a small BT interpreter. Bespoke per-archetype AI code deletes per migrated archetype.

### T-235 — Buffs / DoTs as scene-graph children with ambient looping actions

A buff is a child entity parented to the actor, carrying its own `ActiveActions` with an ambient looping action whose tick effect modifies the parent. BuffSystem deleted. Hit handlers that installed buff state now spawn a buff child entity via `spawnPrefab`.

### T-236 — Animation derives from ActiveActions (cleanup)

By this point AnimationSystem already reads slot actions (T-226 / T-227 / T-228). This phase cleans up any remaining velocity-heuristic clip selection, `paramOverrides` migrations, and direct CSM-mirroring fallbacks in the client. After this, animation is purely derived: slot actions + tags → clips + composition.

### T-237 — Skill loadout consolidation + final polish

Final cleanup: rename / consolidate the input → action mapping component (formerly `ManeuverLoadout` → `SkillLoadout`), simplify intent resolution, remove any remaining transitional fields. Bootstrap codec settles at its final version.

---

## Invariants to preserve through the arc

1. **Snapshot determinism.** Each phase preserves byte-equivalent snapshot output unless the phase explicitly changes world content. `ActiveActions` replication is the only new wire-format addition per phase; existing component deltas otherwise stable.
2. **20 Hz tick budget.** Dispatcher runs once per tick over actors with `ActiveActions`. Effect resolvers fire only on phase transitions, not every tick. Worst-case cost comparable to or lower than current ActionSystem + CSM tick combined.
3. **Lag compensation continuity.** `rewindTick` set on `active:enter` for melee `weapon_trace` effects; preserved as resolver-local state.
4. **Client visual continuity.** Each phase's behavior, animations, and timings match pre-migration. Migrations are transparent to players.
5. **No backward compatibility for content.** Per `CLAUDE.md`: existing item prefabs with `weaponActionId` references migrate to action-id references in the same commit. JSON migrations land with code. CSM JSON and component types are deleted in the same commit as their replacement.
6. **No parallel paths.** Each phase deletes the system or data it replaces in the same commit. No flags, no shims, no `legacy` branches.

---

## Open architectural calls

**1. Slot set as data on the actor prefab vs hardcoded per template kind.**

Recommendation: declared in actor prefab via `actorSlots: string[]`. Engine has no hardcoded slot list. Slot ids are strings; gates that reference slots take a string param.

**2. Where does the "current target" live?**

Several gates (`target_in_range`, `target_kind`) imply an actor has a "current target." Today this is implicit in input (raycast each tick) or in NPC AI (set as part of the BT). Recommendation: add a small `Targeting` component carrying `{ targetEntityId?, targetWorldPoint? }`, set by input drain / AI / hit-reactions. Gates read it.

**3. Input buffer (Vermintide-style grace window).**

Inputs can arrive before a cancelable window opens. Recommendation: per-slot `pendingActionRequest: { actionId, requestedAtTick, ttl }` field on the dispatcher's bookkeeping (not on the actor — the dispatcher owns transient request state). TTL ~6 ticks by default; configurable per action.

**4. Combos as cancel-into chains vs explicit combo data.**

Recommendation: combos are cancel-into rules across separate action ids. `swing_medium.winddown.into = ["swing_medium"]` with a gate that limits chain depth (`combo_count_below: 3`). No combo-state component. Chain depth is implicit in a per-actor `combo_count` resource managed by gate increments on chain entry / resets on idle.

**5. Multiple effects on the same phase edge — order semantics.**

Effects fire in declaration order. Side-effecting effects (`modify_inventory`, `consume_item`) should be ordered before downstream effects (`apply_edible_effect`, `start_buff`). Plan: the loader enforces declaration-order dispatch; designers order effects intentionally.

**6. Poise / stagger resistance threshold.**

Each actor has a `Poise` resource (regenerates over time, consumed by accepted hit-reacts). Hit-reaction posting goes through the `poise_available` gate at the dispatcher; if denied, the hit lands as damage without a hit-react. Severity tiers: light (flinch — 1 poise), medium (stagger — 3 poise), heavy (knockdown — 8 poise + breaks blocks).

**7. Resolver-local state lifecycle.**

The `weapon_trace` resolver needs to persist `rewindTick` and `hitEntities` across multiple `active:tick` calls within one action. Options:
- (A) Resolver maintains a `Map<entityId, ResolverState>` keyed by actor, cleared on `active:exit`.
- (B) Encode resolver scratch into the `ActiveActionState.scratch` field, opaque to dispatcher, serialized as part of the component.

Recommendation: (B) for resolver state that needs to replicate (rewindTick) and (A) for state that doesn't (transient sweep caches). (B) is necessary for client-side prediction to match the server's hit detection.

---

## Files that materially change

| Package | Lines today | Estimated delta after full arc |
|---|---|---|
| `@voxim/engine` | ~3500 | +1200 (action runtime, registries, dispatcher interface) |
| `@voxim/codecs` | ~2000 | +150 (ActorSlots + ActiveActions codecs); −250 (delete SwingContext, SwingChain, Maneuver, CSM codecs) |
| `@voxim/protocol` | ~1000 | +50 (new ComponentType slots); −150 (delete retired slots) |
| `@voxim/content` | ~5000 | +600 (ActionDef extensions, schema validators, ~50 action JSON files); −550 (delete state_machine.ts compiler + sm_expression.ts + maneuvers/ + state_machines/) |
| `@voxim/tile-server` | ~15000 | −5500 (delete CSM system + ActionSystem + DodgeSystem + ManeuverScheduler + BuffSystem + half of SkillSystem + half of EquipmentSystem; shrink Consumption/Crafting/Building/Projectile to resolvers); +1800 (dispatcher + 14 gates + 12 effect resolvers + behavior-tree interpreter) |
| `@voxim/client` | ~12000 | −800 (delete CSM mirror, swing predictor simplifies, animation system reads slot actions directly); +200 (ActiveActions decode and prediction state) |
| Net | | **≈ −3000 to −4000 lines** |

The destination is a codebase where:
- Character behavior is content (one schema, one library)
- The engine ships one dispatcher + gate registry + effect registry
- Adding a new monster's signature move is a JSON drop + (optionally) one new gate
- "What is this actor doing?" has one answer everywhere
- "How do NPCs differ from players?" is "they write Intent from a behavior tree instead of from `InputDatagram`" — and that's it

---

## The unified substrate — adjacent primitives discovered

A survey of the rest of the engine (2026-05-15) found that the Action arc is
not a standalone refactor — it is the **first of three primitives over one
shared substrate**. Capturing this here so the broader simplification isn't
lost between tickets. The goal of this whole effort, stated plainly: **reduce
the complexity of the codebase without reducing what it can do.** Six-plus
bespoke per-tick systems collapse into three content-driven primitives over
one effect/gate/registry substrate.

### Discovery 1 — the Resource primitive

`StaminaSystem`, `HungerSystem`, `CorruptionSystem`, `DurabilitySystem`,
health regen, and the planned poise are the **same shape hand-rolled 5+
times**:

- a scalar `value` bounded `[min, max]`
- changes per tick by a `rate` (regen / decay / accumulation / exposure)
- the rate is modulated by external multipliers (armor penalty, corruption
  penalty, day↔night, tile state)
- crossing a named threshold fires an event, sets a flag, or **couples into
  another resource** (hunger ≥ 100 → health damage; corruption ≥ threshold →
  health damage; stamina ≤ 0 → `exhausted`)

A `Resource` component family + one `ResourceSystem` driven by content
`ResourceDef` (`{ bounds, rate, rateModifiers, thresholds: [{ at, effect }] }`)
collapses StaminaSystem + HungerSystem + CorruptionSystem + Durability into
one system + data. **The threshold→effect dispatch is the same effect
registry the action arc introduces** — "hunger crosses 100 → `modify_health`"
is the same machinery as "swing active:enter → `weapon_trace`". The gate
library's `has_resource` already assumes this convergence.

### Discovery 2 — the DerivedStat primitive

`EncumbranceSystem` sets a base multiplier; `BuffSystem` composes it with all
speed `ActiveEffects` into the final `SpeedModifier` that `PhysicsSystem`
reads. `BuffSystem` already has a generic `composeRegistry` — but its output
is hardcoded to `speedBonus → SpeedModifier`. The general shape:

> **effective stat = base ∘ Σ(typed contributions from N sources)**

Same shape for movement speed, stamina regen, damage, armor reduction, attack
speed, vision range — today each is bespoke. A `DerivedStat` primitive
(sources register typed modifiers, one composer produces the effective value,
consumers read it) generalizes the half-built compose pass. It is the
**actor-level dual of `DerivedItemStats`**, which already does exactly this
for items. One side of the symmetry is built; the other is scattered.

### Discovery 3 — registry-dispatch is already the doctrine, just unnamed

`packages/engine/src/registry.ts` is a generic `Registry<H>` whose own
docstring states it exists for *"content-defined string dispatch … into
systems without hardcoded switches."* Instances already live: content
registries, BuffSystem tick/compose registries, hit handlers, effect
handlers. The action arc adds two more (gates, effect resolvers). This is a
pattern to **promote to written doctrine in `CLAUDE.md`**: *"registry-dispatch
over content-defined ids; never a hardcoded `switch` on a kind field"* —
same status as "ContentStore is the only data access path". Tracked as part
of T-237.

### Discovery 4 — Lifetime / cooldowns are degenerate Actions

`LifetimeSystem` (countdown → destroy), DodgeCooldown, the `windupChargeMs`
map, buff `ticksRemaining`, the auto-save timer — all "count N ticks then
act." The action arc's ambient/perpetual-phase **already subsumes this**.
Stated explicitly so nobody builds a separate `Timer` primitive:
`Lifetime` becomes an ambient action with one phase and an on-complete
`destroy` effect; cooldowns become resource-style or resolver-local. The
degenerate Action *is* the timer. No new primitive needed; this is absorbed
within the existing arc (T-227 onward), not a follow-on.

### The synthesis

The primitives are not independent — they share one substrate:

```
   entities carry components
            │
   ┌────────┴─────────┐
   │   per tick:       │
   │   • Actions advance phases  ─┐
   │   • Resources advance values ─┼──→  one effect registry
   │                              ─┘     (threshold / phase → effect)
   └────────┬─────────┘
            │
   gates query composed state (resources, tags, slots)
            │
   DerivedStats = read-side projection consumers see
            │
   scene-graph = orthogonal organizational axis
```

The whole engine in one breath: **entities are components; one dispatcher
advances Actions and Resources; both emit effects through one registry; gates
read the composed state; DerivedStats are the projection; scene-graph
organizes it hierarchically.** Six-plus bespoke per-tick systems become
*Actions + Resources + DerivedStats*, three content-driven primitives over
one effect/gate/registry substrate.

### Sequencing — the wedge, not the mega-refactor

Do **not** widen the action arc to swallow Resources and DerivedStats now —
that risks an unshippable mega-refactor and violates the "each phase is
shippable" invariant. Instead:

- The action arc's **effect registry and gate library are built generic from
  day one (T-226)** — not action-specific. `registerEffectKind` /
  `registerGate` take an entity + context, not an actor + slot. This is the
  load-bearing decision: it lets Resources and DerivedStats plug into the
  *same* substrate as follow-on arcs rather than spawning parallel
  inventions.
- **T-238 — Resources arc.** After the action arc lands, collapse
  StaminaSystem / HungerSystem / CorruptionSystem / Durability / health-regen
  / poise into a `Resource` component family + one `ResourceSystem` +
  `ResourceDef` content, with thresholds dispatching through the existing
  effect registry. Own multi-phase sub-plan, filed when the action arc nears
  completion.
- **T-239 — DerivedStat arc.** Generalize `BuffSystem`'s compose pass into a
  `DerivedStat` primitive; retire `SpeedModifier` / `EncumbrancePenalty` /
  bespoke stat composition; unify with `DerivedItemStats` where the symmetry
  is clean. Own sub-plan.

The action arc is the wedge. Resources and DerivedStats are the same wedge
driven further into the same crack. They are filed as siblings (T-238,
T-239) so the spine — *one substrate, content-driven primitives, no
hardcoded switches* — is visible across the whole effort, not rediscovered
per arc.

---

## Resuming in the next session

Start with **T-226**. Scope: engine substrate (ActorSlots, ActiveActions, dispatcher), gate library, effect registry, schema extensions, and the locomotion + posture migration. The CSM stays for upper-body combat through T-226; T-227 retires the right_hand + left_hand layers; T-228 retires the rest. One atomic commit per phase.

Important context to carry forward:

- **The CSM is what's being absorbed.** This wasn't fully recognized in the first plan draft. Today's CSM is a layered concurrent FSM with an expression DSL — exactly the structure the Action arc was reaching for, just authored differently. The arc replaces it, doesn't supplement it.
- **Slots are per-actor-template, in data.** Engine has no hardcoded slot list. Adding `head` or `mount` slots later is a template edit.
- **Primary slot governs the whole upper body.** Limb targeting (right_hand / left_hand / both / head) is metadata on the action for animation routing; slot ownership is one.
- **Gate library is closed-vocabulary, registered in code.** No expression DSL. New gates are TypeScript additions (~5 lines each); using them is pure data.
- **Maneuvers fully fold in as multi-effect actions in T-228.** They were a proto-action concept.
- **`SwingContext` and `SwingChain` fold into resolver-local state.** The `weapon_trace` resolver owns the rewindTick + hit dedup. Chain becomes cancel-into rules between chain-step actions.
- **Universal action library, not per-weapon.** One `swing_medium` action used by every weapon with that tempo; weapons supply geometry per chain step via the existing `swingable.chain[]` (each entry pointing at an action id).
- **CLAUDE.md refactor rules apply.** No shims, no parallel paths, no flags. Each phase deletes the system or data it replaces in the same commit. JSON and code migrate together.
- **Snapshot determinism is the load-bearing invariant.** Same gate as scene-graph arc. Run `generate.snapshot.test.ts` after every phase.
- **Scene-graph T-215 + T-216 should land before T-235** (buffs as scene-graph children).
- **Build the effect registry + gate library entity-generic in T-226, not actor-specific.** `registerEffectKind` / `registerGate` take an entity + context, never an actor + slot. This is the load-bearing decision that lets the Resources (T-238) and DerivedStat (T-239) arcs reuse the same substrate instead of inventing parallel ones. See "The unified substrate" section.

The arc is patient. Each phase is shippable; together they constitute the migration. There is no all-or-nothing moment. The destination is the lean, interwoven, composable engine the project is converging on.
