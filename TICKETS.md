# Voxim2 — Engineering Tickets

Each ticket is a self-contained unit of engineering work. Tickets are grouped by domain.

**Format:**
```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done   [Commit: <hash>]

What needs to be built and what "done" looks like.
```

Effort: **S** < half a day · **M** half–two days · **L** multi-day or architectural

---

## Combat

### T-001 · Wire `StateHistoryBuffer` into `ActionSystem` hit detection
Effort: M   Status: done   Commit: d4207dd

`ActionSystem` currently resolves hits against current world state. The buffer exists but is unused.
On swing entering active phase, rewind target position/facing to `serverTick - rttTicks` using the
buffer and evaluate the hit against that historical snapshot.
Done when: hit detection uses rewound state; RTT estimate drives rewind depth.

### T-002 · Parry window detection in `ActionSystem`
Effort: M   Status: done   Commit: 1a12c4b

HealthHitHandler: `blockHeldTicks < parryWindowTicks` (dodge config) triggers parry path.
Emits `DamageDealt { blocked: true, amount: 0 }` (no separate ParrySuccess event needed).

### T-003 · Stagger state from parry
Effort: S   Status: done   Commit: 1a12c4b

HealthHitHandler sets `staggerTicksRemaining: dodgeCfg.staggerTicks` on attacker.
DodgeSystem decrements each tick; ActionSystem gates swing initiation on stagger === 0.

### T-004 · Counter-attack window + bonus damage
Effort: S   Status: done   Commit: 1a12c4b

Parry sets `counterReady: true` on defender's CombatState. Next hit from that entity
applies `counterDamageMultiplier` and clears the flag. Window is open-ended (one hit).

### T-005 · Directional blocking — facing check in hit resolution
Effort: S   Status: done   Commit: 1a12c4b

HealthHitHandler: `angleDiff(incomingAngle, targetSnapshotFacing) <= blockArcHalfRadians`
(π/2 = 90° half-arc). Stamina-exhausted defenders cannot block. Rear/side hits land through.

### T-006 · Ranged weapon action type + projectile spawning
Effort: M   Status: done   Commit: b6cf296

Add `"ranged"` action type to `weapon_actions.json` schema. On action activation, spawn a
projectile entity with `Velocity` in facing direction, `Lifetime`, and `Damage` components.
Projectile travels until lifetime expires or it hits an entity/terrain.
Done when: firing a bow spawns a projectile that deals damage on contact.

### T-007 · Bow/crossbow item templates + facing-based aim
Effort: S   Status: done   Commit: b6cf296

Add bow and crossbow entries to `item_templates.json` with `weaponAction: "ranged_bow"` /
`"ranged_crossbow"`. No zoom — aim is entirely facing-driven (same system as melee).
Done when: equipping a bow uses ranged action; facing determines projectile direction.

### T-008 · Injuries — permanent debuffs from severe damage
Effort: M   Status: todo

When a single hit deals damage exceeding a configurable threshold, roll for an injury.
Write an injury component (type, severity) that applies a stat debuff until treated.
Example injury types: `broken_limb` (reduced speed/attack), `deep_wound` (slow health drain).
Done when: severe hits can produce injury components that apply persistent debuffs.

### T-009 · Injury treatment via supernatural/alchemy workstation
Effort: S   Status: todo

Add a `treat_injury` recipe type to the supernatural/alchemy crafting stations. Using it
removes the injury component from the target entity.
Done when: the correct crafting interaction removes an active injury component.

### T-119 · Replace `ResolveStrikePort` with a deferred `StrikeLanded` event
Effort: S   Status: done   Commit: a8e15ff

`HealthHitHandler` calls `this.strikes.resolveStrike(...)` synchronously during
damage resolution — a cross-system reach through a "port" interface. The docstring
acknowledges it violates the "deferred events for cross-system reactions"
invariant. Replace with an event.

Shape:
  - Add `TileEvents.StrikeLanded { casterId: EntityId; slot: number; targetId: EntityId }`
    to the tile event surface in `@voxim/protocol` (server-only — does not
    cross the wire as a GameEvent).
  - `HealthHitHandler` publishes the event to its `EventEmitter` when a hit
    connects and `SkillInProgress.pendingSkillVerb` starts with `"strike:"`.
  - `SkillSystem` subscribes to it in a new `subscribe(bus)` hook called once
    at construction; the subscriber calls the existing `resolveStrike` method.
    Writes land in the next tick's changeset — 50ms at 20Hz, below perceptible
    for stamina/cooldown/effect feedback.
  - Delete `events/resolve_strike.ts` and the `ResolveStrikePort` interface.
    `SkillSystem` no longer implements it; `HealthHitHandler`'s constructor
    drops the `strikes` parameter.

Done when: no file references `ResolveStrikePort`; strike skills still fire on
hit (stamina deducted, cooldown set, effect applied on the tick after impact);
the system pipeline has one fewer cross-system call.

### T-120 · Split `CombatState` into presence-as-flag components
Effort: M   Status: done   Commit: ac8f398

`CombatState` packs five counters/flags into one always-present component —
`blockHeldTicks`, `staggerTicksRemaining`, `counterReady`, `iFrameTicksRemaining`,
`dodgeCooldownTicks`. Most entities have zero values for most counters most
of the time, but the component ticks through the delta stream whenever any
one changes. Follow `SkillInProgress`'s canonical shape: presence = state.

Split into:
  - `Staggered { ticksRemaining: u8 }` — present only during stagger.
  - `CounterReady` — zero-data marker; present after a parry until the next hit.
  - `IFrameActive { ticksRemaining: u8 }` — present during dodge i-frames.
  - `BlockHeld { ticks: u16 }` — present while ACTION_BLOCK is held;
    counts ticks for parry-window detection.
  - `DodgeCooldown { ticksRemaining: u8 }` — present during cooldown.

DodgeSystem, ActionSystem, HealthHitHandler, and the dodge components already
read `CombatState` — each read site updates to `world.get/has` on the
specific component. New components added to `NETWORKED_DEFS` (or server-only
where clients don't need them — iFrame and dodge cooldown are probably
server-only; stagger and counterReady likely need to reach the client for
animation).

Delete `CombatState`, its codec, and the `combatState` entry in `NETWORKED_DEFS`
in the same commit. Assign fresh `ComponentType` wire IDs for the new
networked components; mark the old `combatState` slot retired with a comment.

Done when: `grep -r "CombatState\|combatState" packages/` returns zero hits
outside the retired-slot comment and migration notes; combat still produces
correct stagger, counter, i-frame, block-timing, and dodge-cooldown behaviour.

### T-192 · CSM declarative scope registry
Effort: M   Status: done   Commit: cdd67ae

`CharacterStateMachineSystem.buildSMScope` is today a ~100-line monolith
of hardcoded reads (`vel.*`, `health.*`, `input.*`, `action.*`,
`physics.*`, `weapon.*`, `event.*`). Adding a new variable for an SM
transition to read requires editing that function. Missing variables
silently default to `0`/`false`, masking typos in transition DSL.

Replace with a `SMScopeContributor` registry: each contributor declares
`{ namespace: string, extract(world, eid, ctx): Record<string, number|boolean|string> }`.
`buildSMScope` becomes a loop over registered contributors. Move every
existing scope group out of `buildSMScope` and into its own contributor
file under `packages/tile-server/src/sm_scope/` (one per namespace —
`velocity.ts`, `health.ts`, `input.ts`, `action.ts`, `physics.ts`,
`equipment.ts`, `events.ts`).

The TickEventBuffer one-tick-event channel survives unchanged; events
become just one contributor.

`weapon.has_block = true` / `weapon.has_aim = false` placeholder constants
go away — derive from the equipped weapon prefab's components instead, or
delete the variables entirely (decide per-variable as part of this work).

Done when: all transitions in `humanoid_default.json` still resolve
correctly; `buildSMScope` is under 30 lines and contains no hardcoded
variable names; adding a new SM-readable variable is a one-file drop in
`sm_scope/`; the silent-default behaviour for missing variables is
preserved for now (validation added in T-194). Refactor replaces, no
shim: `buildSMScope`'s old body is deleted, not @deprecated.

### T-193 · CSM layer roles + state tags
Effort: M   Status: done   Commit: cdd67ae

The CSM today has informal layer semantics — `posture`, `locomotion`,
`right_hand`, `reaction` carry meaning only by convention. Gameplay
systems (ActionSystem, durability handler, terrain hit handler) match
state names by string prefix (`csm.right_hand.node.startsWith("swing")`)
to detect "is currently swinging." `SwingContext` lifecycle in
`CharacterStateMachineSystem.isSwingNode` hardcodes the same prefix.
New action types (cast, channel, throw, maneuver) would either reuse
the `swing.*` names dishonestly or scatter new hardcoded checks.

Two parts:

**Layer roles.** `SMLayer` gains `kind: "base-locomotion" | "action" |
"reaction" | "posture" | "flag"`. The role formalises layer semantics
and is used by validation (T-194) and by systems that want to act on
layer category rather than layer id (e.g. "all action layers can install
a payload component on enter, remove on exit").

**State tags.** `SMState` gains `tags?: string[]`. Tags are arbitrary
strings the SM author declares to expose state semantics to gameplay
systems. Standard tags introduced in this ticket:
  - `"action"` — state is part of a committed-action sequence (any
    swing phase, future cast/channel phases)
  - `"active-hitbox"` — hit detection should run this tick (replaces
    the `swing.active` name match in terrain_hit_handler + durability)
  - `"interruptible-by-block"`, `"interruptible-by-dodge"` — transition
    guards key off these (cleans up `swing.windup → idle on input.block`)
  - `"locks-input"` — PhysicsSystem zeros movement input while in this
    state (stunned, frozen, sleeping, dead)
  - `"locks-facing"` — PhysicsSystem ignores facing input (committed
    swings)
  - `"i-frame"` — hit handlers skip this entity as a target

Tags are queryable in DSL (`csm.right_hand.hasTag("action")`) and via
runtime API (`csm.layerHasTag(eid, "right_hand", "active-hitbox")`).
The compiled-SM struct precomputes the tag set per state for O(1) reads.

**Payload component lifecycle.** Action-role layers can declare
`onEnter: { component: "swing_context" }` per state group. The CSM
system installs/removes the named payload component automatically when
entering/leaving tagged states. The current `SwingContext` removal
special-case in `CharacterStateMachineSystem` (the `queued`-guard
ordering hack) gets a real home: payload lifecycle is system-managed,
not hand-tracked at every transition site.

Migrate `humanoid_default.json`'s swing.* states to carry `tags: ["action",
"active-hitbox"]` etc. Update ActionSystem, durability system, terrain
hit handler to read tags instead of state-name prefixes. The string
`startsWith("swing")` should not appear in any system after this lands.

Done when: no system code references SM state names as strings (only
tags + layer kind); a new action type can be authored by dropping a
ManeuverDef-like file + adding states with the right tags, with zero
system code changes; SwingContext lifecycle works without the
removal-vs-write ordering hack.

### T-194 · CSM compile-time validation
Effort: S   Status: done   Commit: cdd67ae

Builds on T-192 + T-193. At server boot, the SM compiler should reject
malformed defs loudly instead of silently mis-behaving.

Checks:
- Every `csm.<layer>` reference in a transition / paramOverride
  resolves to a real layer.
- Every scope variable referenced in any transition is registered by
  some `SMScopeContributor` (T-192).
- Every `$slot` clip reference is satisfied by `animationSlots` on
  every prefab that selects this SM.
- Every `from` state in a transition exists in the layer.
- Every `to` state in a transition exists in the layer.
- Tags referenced by `hasTag(...)` in DSL belong to a known tag set
  (warn-only, not hard-fail — author-extensible).

Done when: introducing a typo in `humanoid_default.json` (e.g.
`healt.current`, or `csm.postur == crouched`, or `$walk_forwrd`) fails
server boot with a precise error message naming the file, layer, state,
and offending token. The validator runs in the existing
`compileStateMachine` path so cost is paid once per boot.

### T-195 · DerivedStats component + StatAggregationSystem
Effort: M   Status: deferred-into-T-197

The ticket assumed no stat-aggregation existed. The codebase already has
the right framework (ActiveEffects + BuffSystem + EffectComposeHandler +
SpeedModifier as the composed output, EncumbrancePenalty as the base layer
— see [buff.ts](packages/tile-server/src/systems/buff.ts) /
[effect_handler.ts](packages/tile-server/src/effects/effect_handler.ts)),
just shaped one-stat-at-a-time. The unification into a single DerivedStats
component only earns its keep when a second stat needs to fold — at which
point the rename (`SpeedModifier` → `DerivedStats`, generalise
`EffectContribution`) lands as one diff with its motivating consumer.

T-197 will be that diff: when poiseRegen needs a home it triggers the
DerivedStats collapse.

There is no home for continuous stat aggregation today. Encumbrance
exists as a one-off system that mutates movement speed; nothing else
composes. A planned slow-debuff, a poison damage-over-time, a
movement-speed buff, equipment-derived swing-speed scalar, all need a
common fold point.

Add:
- `DerivedStats` component (networked — client reads moveSpeed for
  prediction, sees swingSpeed for animation pacing). Fields are flat
  scalars: `moveSpeed`, `swingSpeed`, `damageResist`, `staggerResist`,
  `poiseRegen`, `stamRegen`. Start with this set; extend as new buffs
  land.
- `StatAggregationSystem` runs early in the tick (before PhysicsSystem
  and ActionSystem). For each actor, fold:
    base stats from prefab.components.derivedStatsBase
      ↓ multiplied/added by equipment-derived modifiers
      ↓ multiplied/added by active Buffs (T-196) modifiers
      → DerivedStats
  Composition rule per stat is declared on the stat (multiplicative for
  resists, additive-with-clamp for speeds, etc.) — defined once in
  `packages/content/src/derived_stats.ts`, not per-call-site.

Subsume `EncumbranceSystem` into this: encumbrance becomes a modifier
contributor, not a parallel pipeline. Refactor replaces, no shim — the
`Encumbrance` component goes away and its data folds into prefab
weight + DerivedStats.moveSpeed.

PhysicsSystem reads `DerivedStats.moveSpeed`. ActionSystem reads
`DerivedStats.swingSpeed` to scale swing phase durations (replaces
direct equipment lookup). Hit handlers read `DerivedStats.damageResist`.

Done when: a prefab declares `derivedStatsBase: { moveSpeed: 4.0,
swingSpeed: 1.0, ... }`; equipping a heavy weapon multiplies swingSpeed
by 0.8; PhysicsSystem uses the folded value; the Encumbrance component
is deleted; rebuilds happen each tick (cheap — O(active buffs + equipped
slots)).

### T-196 · Buffs component + BuffSystem (continuous + discrete channels)
Effort: M   Status: done   Commit: cbb88af

The original ticket scope (new Buffs component, new BuffSystem) was
already covered by the existing ActiveEffects / BuffSystem framework.
What landed in this commit is the missing authoring + discrete-event
half: `data/buffs/*.json` declarative defs, the `applyBuffById` helper
to apply them from gameplay code, boot-time validation that every
BuffDef.effectStat resolves, and an `onApplyEvent` channel that pushes
into TickEventBuffer for the CSM to react to. Stacking / onExpire are
intentionally out of scope until a buff with stack semantics or expire
behaviour needs them.

Status effects (slow, poison, stunned, frozen, sleeping, bleed, blessed,
cursed) don't have a home. Each future system would otherwise reinvent
its own timer + apply + expire path.

`Buffs` component holds a flat array of active buffs:
```
{ defId: BuffDefId, appliedTick: u32, durationTicks: u32, stacks: u8, sourceEid?: u32 }
```

`BuffDef` lives in `data/buffs/{id}.json` (one file per buff):
```
{
  id, displayName, icon,
  durationSeconds, maxStacks, stackBehaviour: "refresh"|"extend"|"add",
  modifiers: [ { stat: "moveSpeed", op: "mul", value: 0.7 } ],
  perTick: [ { kind: "damage", amount: 2 } ],
  onApply:  { event?: "event.stunned" },
  onExpire: { event?: "event.unstunned" }
}
```

`BuffSystem` runs before StatAggregationSystem each tick:
- Decrement buff timers; expire and fire `onExpire` event when zero.
- Apply `perTick` effects (damage, heal, drain stamina).
- On expire, mark Buffs dirty so StatAggregationSystem re-folds.

Two output channels:
- **Continuous**: `modifiers[]` consumed by StatAggregationSystem
  (T-195) on each tick's fold.
- **Discrete**: `onApply.event` / `onExpire.event` written into
  TickEventBuffer → consumed by CSM scope contributor (T-192). This
  is how a "stunned" buff drives the CSM's posture layer into
  `posture.stunned` and back out.

Authoring a new status effect = drop a `BuffDef` JSON + ensure the SM
has a matching state if the buff is meant to drive one. No code change.

Done when: applying a sample `buff_slow` from a damage hook reduces
moveSpeed by 30% for 5s and expires cleanly; applying `buff_stunned`
transitions posture to stunned and locks input (via T-193 `locks-input`
tag); stacking same buff respects `stackBehaviour`.

### T-197 · Poise + stagger pipeline
Effort: S   Status: done   Commit: cd693a0

Stagger today comes from parry only (T-003). The combat design needs
generalised stagger from heavy hits + poise depletion, with severity
tiers (light vs heavy) driving different reaction animations.

Add:
- `Poise` component: `{ current: f32, max: f32, regenPerSec: f32 }`.
  `regenPerSec` reads from `DerivedStats.poiseRegen` (T-195) at use
  time; the component holds only the instantaneous value.
- Damage-resolution hook (in hit handlers): reduce victim Poise by hit
  weight (declared on WeaponActionDef or scaled by damage). When Poise
  ≤ 0, fire `event.stagger { tier }` where tier comes from how far the
  hit overshot the threshold (light vs heavy), then reset Poise to max
  with a brief regen-disabled window.
- CSM reaction layer (in `humanoid_default.json`) gains
  `stagger.light` / `stagger.heavy` states with data-driven durations;
  transitions key off `event.stagger`'s tier field.
- Per-actor base Poise via `derivedStatsBase` (T-195); heavy armour
  contributes via the same modifier path.

The existing `event.hit.heavy` + `knockback` state is the prototype;
this ticket generalises it. Refactor replaces: `event.hit.heavy` goes
away, replaced by `event.stagger { tier: "heavy" }`.

Done when: hitting an NPC three times rapidly with a heavy weapon
depletes its poise and triggers `stagger.heavy`; a single heavy hit
against a low-poise actor goes straight to stagger; poise regenerates
over time when not under pressure; the tier field cleanly selects
`stagger.light` vs `stagger.heavy` clips.

### T-198 · Hit-part metadata + richer hit-event payload
Effort: S   Status: done   Commit: 996094f

To support the combat design's "what got hit, with what part, in what
phase" — needed for headshot multipliers, hit-spark placement, future
limb-targeting, and a simple aiming layer — the swingPath and hit
events need to carry that data end-to-end.

- `SwingPathKeyframe` gains optional `hitPart: "tip" | "mid" | "haft" |
  "pommel"` (string, author-extensible). Range between keyframes
  inherits the earlier keyframe's tag.
- Victim-side: `Hitbox` components on actors / NPCs declare named
  parts (`head`, `torso`, `left_arm`, ...). The capsule-vs-actor sweep
  in ActionSystem picks the closest part to the contact point.
- The fired `HitEvent` (currently `{ attacker, victim, damage, ... }`)
  gains `attackerPart`, `victimPart`, `phase` ("active" today, room for
  more later).
- Damage-resolution in hit handlers uses `attackerPart`/`victimPart`
  for multipliers (tip > pommel; head > torso) — values from
  `game_config.json` or per-weapon-action override.
- Client receives the richer event for hit-spark placement (renders at
  the victimPart's bone position instead of a generic chest-center).

Done when: hitting an NPC's head with a sword tip deals more damage
than hitting its torso with the haft; client hit-sparks render at the
contact location; the HitEvent on the wire carries part data; no
hardcoded multipliers — values live in content.

### T-199 · WeaponActionDef root motion
Effort: S   Status: done   Commit: 154f25a

Slashes should give a small forward push so attacking feels weighty
(per combat design). Today swings are purely in-place; movement comes
from input only.

`WeaponActionDef` gains optional `rootMotion`:
```
"rootMotion": {
  "forwardImpulse": 2.5,
  "phase": "active",
  "duration": 0.12
}
```

ActionSystem on phase entry adds the impulse to Velocity, scaled by
`DerivedStats.moveSpeed` (T-195) so a slowed character pushes
proportionally less. Capped/decayed over the declared duration; doesn't
fight player input but biases it.

Done when: a sample slash on the iron sword carries the character ~0.3m
forward during its active window; the push is suppressed under a slow
debuff; declaring rootMotion: null preserves the in-place behaviour.

### T-254 · Combat drift sweep: reaction priority, active-tick traces, DoT lethality, SKILL_N verbs
Effort: M   Status: done   Commit: <hash>
Two bullets resolved by earlier arcs before this commit: DoT lethality —
fixed by T-249's DeathSystem health≤0 sweep (regression test added here);
SKILL_N-fires-strike-verbs — moot, the strike verb and the verb matrix were
deleted (T-259b/T-260b). The remaining four land here; sword_overhead also
turned out to ship an unregistered `tag_absent` gate (never boot-checked,
would have thrown mid-tick) — replaced with `not_staggered`, and the new
gate cross-check would now catch it at boot.

Code/content drift at the action boundary — each side assumes a contract the other doesn't
honor, and none of it fails fast (2026-06 review):

- **Any reaction force-interrupts any running reaction.** Incumbent priority is
  `def.priority ?? 0` (`dispatcher.ts:223-229`) but reaction defs only declare
  `interruptPriority` — a `hit_front` (10) cancels a running `stagger_heavy` (60), replacing
  a 14-tick lockout with a short flinch. Compare against the incumbent's `interruptPriority`
  (or give reactions a real `priority`).
- **`weapon_trace` only ever samples the first arc slice.** All swing JSONs wire it on
  `active:enter` only, while the resolver is built for per-tick sampling (`tCurr/tPrev`
  math + hit-dedup scratch) — `swing_heavy`'s 3 active ticks contribute nothing to hit
  detection. Wire `active:tick` in the swing JSONs.
- **`sword_overhead`'s `params.weaponActionId` override is never read** — the resolver
  always derives geometry/timing from the equipped weapon's light variant. Honor
  `ctx.params`.
- **DoT cannot kill.** `buff.ts:92` clamps health to ≥0 and no path scans hp ≤ 0 — a
  poisoned target sits at 0 HP forever looping the death reaction. Route lethality through
  one place.
- **SKILL_N casts strike-verb skills directly.** `activateSkill` has no verb filter, so a
  strike slot fires its on-hit effect as a targetless button AoE — contradicting the
  documented model (strikes fire on melee connect only).
- **Fail-fast gaps:** ActionDef gate ids (`preconditions`, `cancel.*.gates`) are never
  cross-checked against the gate registry at boot (unknown id throws mid-tick), and
  `readJsonDir(dataDir, "actions").catch(() => [])` silently boots a server with zero
  actions on a directory read error.

Done when: getting tapped no longer cancels a hard stagger; heavy swings connect during
their full active window; a DoT kill destroys the entity; SKILL_N on a strike slot is a
no-op; both fail-fast gaps abort boot loudly.

---

## Networking & Client Prediction

### T-010 · Entity interpolation for remote entities
Effort: M   Status: done   Commit: pre-existing

Remote entities (other players, NPCs) currently snap to last received position. Maintain a two-
snapshot buffer per remote entity on the client. Render at a fixed delay (~100ms), interpolating
position and facing between the two buffered snapshots.
Done when: remote entities move smoothly; no snapping visible under normal latency.

### T-011 · Client-side prediction replay loop
Effort: L   Status: done   Commit: e6ac868

Client currently waits for server state for own entity position. Apply own inputs immediately
client-side. On receiving `ack_input_seq`, discard acknowledged inputs and replay remaining
unacknowledged inputs on top of the server-authoritative position.
Done when: own movement is instant locally; server corrections are applied without visible snap
under normal latency.

### T-012 · Reconciliation smoothing
Effort: M   Status: done   Commit: dfa1313

Decide and implement correction strategy: interpolate toward server position for small divergences
(< configurable threshold); hard-snap for large ones. Threshold tunable in `game_config.json`.
Done when: minor corrections are invisible; large corrections snap without rubber-band effect.

### T-013 · RTT estimation per client
Effort: S   Status: done   Commit: d4207dd

Track RTT per client using the `timestamp` field in input datagrams. Maintain a rolling average
(configurable window). Expose as `rttTicks` for use in lag compensation (T-001) and client
reconciliation (T-011).
Done when: each session has a live RTT estimate in ticks; it's used by ActionSystem.

### T-253 · Input hardening: finiteness, RTT clamp, seq ordering, reconnect, backpressure
Effort: M   Status: todo

Hostile-client hardening of the input path (2026-06 review):

- **Non-finite input poisons the world.** `vec2Normalize` bounds magnitude but not NaN;
  `movementX: NaN` flows through `stepPhysics` into `Position`, and the pairwise-separation
  pass (`physics.ts:154-162`) spreads the NaN to every nearby entity — onto the wire and
  into the lag-comp history. The input drain must zero/reject non-finite movement/facing.
- **Client timestamp drives an unbounded rewind window.** `updateRtt` (`session.ts:71-75`)
  has no upper clamp and the history buffer holds 6.4s — a lying client sustains
  multi-second lag-comp rewinds. Clamp RTT to a sane max.
- **Inputs are latest-by-arrival, not latest-by-seq.** A reordered older datagram is applied
  as current and acked, regressing `ackInputSeq` and breaking reconciliation. Discard
  datagrams with seq ≤ last applied.
- **Reconnect corrupts the session map.** A second connection for the same playerId
  overwrites `sessions` without closing the old session; the old session's cleanup then
  unconditionally deletes the *new* entry (`server.ts:1448,1498-1499`). Evict the existing
  session first; cleanup must only delete its own entry.
- **No backpressure bound.** `sendStateRaw` (`session.ts:199-212`) chains a full state
  message per tick for a non-reading client, unbounded; `commandQueue` is a plain unbounded
  array. Cap depth, drop/close past the cap.

Done when: fuzzed NaN/reordered datagrams leave all positions finite and acks monotonic; a
second connection per playerId cleanly replaces the first; a stalled reader is disconnected
at the queue cap.

---

## Stealth

### T-014 · Noise level component — run vs. crouch
Effort: S   Status: todo

Add a `NoiseLevel` component derived each tick from movement speed and crouch state. Running =
high noise; walking = medium; crouching = low. Written by `PhysicsSystem` or a new
`StealthSystem`.
Done when: `NoiseLevel` is present on moving entities and varies correctly with movement state.

### T-015 · NPC detection radius driven by noise + distance
Effort: M   Status: todo

In `NpcAiSystem`, replace binary proximity detection with a soft gradient: detection probability
scales with target noise level and inverse distance. Crouching at range may not trigger detection;
running nearby always does.
Done when: crouching entities are harder to detect at distance than running ones; NPCs react
proportionally.

### T-016 · Directional detection — NPC facing vs. target position
Effort: S   Status: todo

Enemies facing away from the player have no detection. Add a facing arc check to NPC threat
detection: enemies detect within a forward cone at full sensitivity; rear detection only at very
short range.
Done when: flanking unaware NPCs is viable; frontal approach is consistently detected.

### T-017 · Light level detection modifier
Effort: M   Status: todo

Day/night cycle already reduces player perception radius. Extend the detection system to also
reduce NPC detection range at night (and in caves / unlit areas if light source system exists).
Done when: night makes stealth meaningfully easier; NPCs detect less far in darkness.

---

## Lore & Skills

### T-018 · Lore tome as inventory item
Effort: M   Status: done   Commit: (pre-existing)

`blank_tome` and `tome` item templates exist; `InventorySlot.fragmentId` carries the payload;
codec round-trips correctly via inventorySlotCodec optional field encoding.

### T-019 · Externalise Lore — write fragment to tome
Effort: M   Status: done   Commit: (pre-existing)

DynastySystem handles `CommandType.Externalise`: consumes a blank_tome from inventory,
produces a filled tome with the selected fragmentId. Cooldown gated via InteractCooldown.

### T-020 · Internalise Lore — read tome to add fragment
Effort: S   Status: done   Commit: (pre-existing)

DynastySystem handles `CommandType.Internalise`: reads fragmentId from tome slot,
appends to `learnedFragmentIds`, consumes the tome. Cooldown from `lore.externaliseConsumeTicks`.

### T-021 · Balance algorithm in SkillSystem
Effort: M   Status: todo

Implement the cost/effect ratio formula from spec:
`ratio = fragment2.magnitude / (fragment1.magnitude + action.base_magnitude)`
Scale effect power by ratio (full at ≥1.0; scaled down below; amplified above).
Done when: skills with higher-magnitude costs produce amplified effects; lower costs produce
reduced effects; a test case verifies the formula.

### T-022 · Full verb coverage in concept-verb matrix
Effort: L   Status: todo

Currently only `strike` and a few other verbs are wired. Implement all 14 verbs from the spec:
`attack`, `throw`, `shout`, `dash`, `pray`, `harvest`, `track`, `craft`, `enchant`, `trade`,
`persuade`, `build`, passive. Each verb needs a resolution path in `SkillSystem` that reads the
matrix and applies the appropriate effect.
Done when: all 14 verbs have a code path; at least one concept-verb combination per verb is
tested end-to-end.

### T-023 · Expanded skill loadout slots (6–8)
Effort: S   Status: todo

Current `LoreLoadout` has 4 slots. Expand to 6–8 (TBD, set in `game_config.json`). Ensure codec
and UI handle variable slot count.
Done when: slot count is config-driven; codec encodes correctly at the new count.

### T-024 · Tradition naming system for skills
Effort: S   Status: todo

Add `domain` field to fragment definitions (`SUPERNATURAL`, `RELIGIOUS`, `ALCHEMICAL`). Add a
tradition word bank per concept per domain to `lore_fragments.json`. Skill names are generated
as `fragment1_tradition_word + verb_noun`.
Done when: skill names render with tradition flavour; same underlying skill has three readable
names from three traditions.

---

## Crafting & Economy

### T-025 · Workstations as world deployables
Effort: M   Status: done   Commit: 708300c

Add workstation item templates: `chopping_block`, `forge`, `anvil`, `furnace`, `workbench`,
`writing_desk`, `altar`, `alchemist_bench`. Each is a deployable (can be placed in world).
Add a `WorkstationType` component on deployed entities. Crafting system routes interactions
by workstation type.
Done when: workstations can be placed and persist as world entities; they have a type component.

### T-026 · Physical crafting interaction — material placement on workstation
Effort: M   Status: done   Commit: 2822939

Replace menu-driven crafting with the physical model: player places material items onto a
workstation entity (via interact action). Workstation holds a material slot buffer. Attacking the
workstation with the correct tool triggers the crafting check against the buffer contents.
Done when: crafting requires physical material placement + tool attack; menu crafting is removed.

### T-027 · Crafting action step type (tool + attack)
Effort: S   Status: done   Commit: 2822939

Implement instantaneous crafting resolution: when player attacks workstation with correct tool
and correct materials are in the slot buffer, consume materials and spawn output item.
Done when: `axe on chopping_block + log → planks` works via the physical model.

### T-028 · Crafting time-based step type (furnace/fire)
Effort: S   Status: done   Commit: 2822939

Workstations with `"stepType": "time"` in recipe definition run a timer after materials are
placed and a fuel/trigger condition is met. Output spawns when timer completes.
Done when: `ore + fuel → furnace → metal slugs after N ticks` works.

### T-029 · Crafting assembly step type (multi-material + recipe select)
Effort: M   Status: done   Commit: 2822939

For assembly steps: player places multiple materials, selects a recipe from their known Lore
(filtered to recipes valid for current station + materials), then attacks to produce output.
Done when: `2 ingots on anvil + select blade recipe + hammer → rough blade` works.

### T-030 · Recipes as Lore — require known recipe to select
Effort: S   Status: done   Commit: (next)

`Recipe.requiredFragmentId` optional field added to types.ts. `_handleSelectRecipe` in
CraftingSystem checks `LoreLoadout.learnedFragmentIds` before setting `activeRecipeId`.
Recipes without `requiredFragmentId` remain freely available.

### T-031 · Currency — coins as physical inventory item with weight
Effort: S   Status: todo

Add `coin` item template with a weight value. Coins stack in inventory up to a limit.
Trader transactions deduct/add coins from entity inventory (not an abstract balance).
Done when: buying from a trader deducts physical coin items; selling adds them.

### T-032 · NPC buy/need system — NPCs seek traders when need critical
Effort: M   Status: todo

When an NPC's hunger/thirst reaches a threshold and it has coins, add a `seek_trader` job:
find the nearest trader NPC with food/water, buy from them if currency is sufficient.
Same mechanic for tool needs (NPC without hammer seeks a trader selling hammers).
Done when: hungry NPCs with coins autonomously locate and buy food from trader NPCs.

### T-033 · Material property propagation through crafting chain
Effort: M   Status: superseded by T-121

Original sketch: a flat material-property table propagated to outputs. Replaced by
T-121's category + per-recipe-formula model, which is per-instance, atomic, and
extends across multi-step chains.

### T-116 · Research pass — pre-industrial artisan crafting chains
Effort: L   Status: in-progress

Compile a curated catalog of real-world pre-industrial artisanal production chains (metallurgy,
ceramics, textiles, leather, wood/pyrolysis, food/preservation, chemistry/dyes, stone/mineral)
into `research/crafting/`. Each chain is documented with a canonical schema (steps, workstations,
primitive verbs, byproducts, gameplay role, engine-gap flags) so we can later decide which chains
to author as content and which engine features — if any — need to be added to express them.

Scope: pre-1500 tech, observable physical transformations, chains that fit Voxim's gamified
simulation tempo (long chains OK, month-long real-world durations compressed, NPCs handling
boring intermediate steps). Explicitly NOT a 1:1 history simulator.

Phases:
  1. Framing doc + schema (README.md)
  2. Per-category research files (one markdown per category)
  3. Synthesis: cross-category verb vocabulary, workstation inventory, engine-gap list
  4. (Separate ticket, later) — decisions on which chains to author as content,
     and which engine gaps to close.

Done when: research/crafting/ contains the framing doc, one file per category, and a summary
extracting the verb vocabulary, workstation inventory, and engine-gap list across all chains.

### T-117 · Items-as-entities refactor
Effort: L   Status: done   Commit (Ph1): 26a4546   Commit (Ph2): 46d638b   Commit (Ph3): 2dc9fd6   Commit (Ph4): 690de19

Collapse `ItemTemplate` into `Prefab`. Move every item behaviour onto composable
server-only components (Equippable, Swingable, Tool, Deployable, Edible,
Illuminator, Armor, MaterialSource, Composed, Stackable, Weight, Renderable).
Make every unique (non-stackable) item a World entity carried by inventory /
equipment entity-refs; stackables stay as `{ prefabId, quantity }` compact
slots. Instance state (parts, durability, quality, inscription, history) lives
as components on the item entity.

Phases:
  1. Template component vocabulary (additive, non-breaking) — DONE 26a4546
  2. `ItemTemplate` → `Prefab` migration (breaking) — DONE 46d638b
     Old item JSON scratched; new item prefabs authored fresh in content sprint.
  3. Unique items become entities; inventory/equipment entity-refs (breaking) — DONE 2dc9fd6
  4. Instance components: Durability, Inscribed, QualityStamped, History — DONE 690de19
  5. Polish, benchmarks, cleanup — DONE (this commit)

Each breaking phase is its own atomic diff per CLAUDE.md's refactor philosophy.
Checkpoint sign-off gates each breaking phase.

Done when: `grep -r "ItemTemplate" packages/` returns zero matches, every item
in the simulation is either a compact stackable slot or an entity with its own
components, and benchmark confirms the entity budget holds.

### T-118 · Unify deploy + place into one `PlacementSystem`
Effort: M   Status: done   Commit: 8e7578f

Two placement paths currently exist — `CraftingSystem._handleDeploy` (workstation
deploy via `CommandType.DeployItem`) and `BuildingSystem._handlePlace` (blueprint
placement via `CommandType.PlaceBlueprint`). They do the same thing: validate,
spawn a prefab, patch runtime coordinates, fire side-effects. Collapse them.

Target shape:
  - One `PlacementSystem` in `systems/placement.ts`.
  - One `CommandType.Place { prefabId, worldX, worldY, fromInventorySlot? }`.
  - Placement rules live on the target prefab, not on the command handler.
    Extend the existing `Deployable` component (or add a sibling `Placeable`)
    to carry: `alignment: "forward-facing" | "cell-aligned"`, `consumesFromInventory: boolean`,
    `requiresToolType?: string`, `reach?: number`. Blueprints declare these
    too — no blueprint-specific branch.
  - Hearth anchoring becomes an event subscriber. PlacementSystem publishes
    `TileEvents.EntityDeployed { entityId, placerId, prefabId }`; an
    `AccountHearthAnchor` subscriber (registered next to EventRouter)
    reacts when the deployed prefab carries `Hearth`. Removes `accountClient`
    from `CraftingSystem`'s constructor.
  - Delete `CommandType.DeployItem` and `CommandType.PlaceBlueprint` in the
    same commit; rewrite the protocol enum slot comment.
  - Blueprint construction (hit-driven) stays in `BlueprintHitHandler`; this
    refactor only unifies the spawn path.

Done when: `CraftingSystem._handleDeploy` and `BuildingSystem._handlePlace`
are gone, both flows run through `PlacementSystem.handlePlace`, and placing
a hearth still updates the player's account anchor via the new subscriber.

### T-121 · Per-instance stats + per-recipe formulas — items become real things
Effort: L   Status: done   (umbrella; phases T-122..T-127 cover the work)

Replace the current "every variant is its own prefab, recipes lock or list
alternates" model with a generic-item system where variants share a category,
carry per-instance stats, and recipes atomically map input stats → output
stats via expression formulas. The bow chain motivates the design (see
SPEC.md §"Crafting" and §"Quality is Cumulative"); birch/pine/oak/yew are all
`category: "wood"` with their own `flexibility`/`density`/`grain` stats; one
recipe `bow_stave_split` takes any wood and outputs a `bow_stave` with stats
computed from the input; `wooden_bow_assemble` takes a stave + a string and
outputs a bow whose `draw_weight`/`range`/`durability` are computed from
both. Adding spider silk = one new file. Adding a new wood = one new file.
Adding a new stat = touch the recipe(s) that should produce it.

This is a **destructive replacement**, per CLAUDE.md's refactor rules:
- The current variant-explosion item set is scratched. Every recipe that
  duplicated logic per material (`bowstring_linen`, `bowstring_sinew`,
  `bowstring_gut` → one `bowstring_assemble`) collapses. The 450-prefab item
  catalogue and 238-recipe set both shrink and re-shape; expect a substantial
  net deletion in content. Models stay — the visual primitives are reusable.
- No alternates field, no "either itemType or category" co-existence, no
  legacy recipe shape. Recipes pre-migration won't load post-migration. The
  loader rejects unknown shapes loudly.
- No save-data compatibility. Existing inventories regenerate from seed
  per CLAUDE.md.

The system is organised so each phase is one atomic diff. Phases T-122..T-126
break out the work; T-127 lands the UI. T-033 is superseded.

**Architectural shape (terminology used by all subsequent tickets):**
- **Category** — string tag on a prefab (`"wood"`, `"cordage"`, `"ingot"`).
  Loose filter, not a schema. Recipes match inputs by category.
- **Tags** — additional set-of-strings on a prefab (`"organic"`, `"elastic"`,
  `"fire-resistant"`). Recipes can require tags within a category. Authoring
  tags well is the biggest content-design risk; introducing them upfront
  means we don't paint into a corner.
- **Stats** — open key→f32 map on item entities. On raw-material prefabs
  the values are authored directly; on crafted intermediates they're
  computed by the recipe at craft time and stored on the new entity.
- **Roles** — name strings inside a recipe (`"stave"`, `"string"`,
  `"lamination"`) that disambiguate multiple inputs of the same category.
  The matcher assigns loaded buffer items to roles.
- **Formula** — expression string evaluated at craft completion. Variables:
  `<role>.<stat>`, `tool.<stat>`, `workstation.<stat>`, `skill.<verb>`.
  Operators: `+ - * / min max clamp`. Numbers only. No randomness, no IO.
- **Stack vs unique discriminator carries over from T-117**: prefabs with
  `stackable: {}` and no recipe-computed stats stay as compact stack slots;
  any item that has *computed* stats becomes a unique entity carrying a new
  `Stats` instance component. Two stacks of the same prefab merge only if
  their stat blobs are byte-identical (which is automatic for raw materials
  whose stats come from the prefab — they're always identical).

Done when: every phase below is `done`; the bow chain works end-to-end with
stats propagating from a yew log to a finished bow with a procedurally
generated name; a recipe-graph validator passes at content-load over the
full data set; no recipe still uses the old `itemType` + `alternates` shape.

### T-122 · Stats infrastructure + Stats instance component
Effort: M   Status: done   Commit: c776134   Phase 1 of T-121

Add a `Stats` instance component (`Map<string, number>` or fixed-arity
key-value list — pick whichever serialises cheapest in `@voxim/codecs`).
Networked because the client needs it for tooltips; one wireId slot.
Server-side: write at item-entity creation by `spawnPrefab` when the
prefab declares `stats: { ... }`; written at craft completion by the
crafting system.

`Prefab` type gains optional `category: string`, `tags?: string[]`, and
`stats?: Record<string, number>` for raw-material variants whose stats are
hand-authored on the prefab. Loader validates that any stat key is finite
and any tag is a non-empty string.

Done when: `Stats` exists in the codecs + tile-server registry; spawning a
prefab that declares `stats: { ... }` writes the component on the entity;
client decodes it onto `EntityState`; nothing yet consumes the data.

### T-123 · Formula DSL — parser, evaluator, validator
Effort: M   Status: done   Commit: 1defbb7   Phase 2 of T-121

A small expression language inside `@voxim/content` (~200 lines, no deps).
Parses the BNF below at load time into an AST; evaluator takes a scope
`{ [varName]: number }` → number. Variables are dotted strings resolved
against the supplied scope; no implicit fallbacks (referencing an unknown
var fails the eval and is logged once with the recipe id).

```
expr     := term (('+' | '-') term)*
term     := factor (('*' | '/') factor)*
factor   := number | identifier | '(' expr ')' | call
call     := ('min' | 'max' | 'clamp') '(' args ')'
args     := expr (',' expr)*
identifier := [a-zA-Z_][a-zA-Z0-9_.]*
```

Companion `validateFormula(expr, knownVars: Set<string>)` returns the set
of variables the expression actually reads, used by T-124's recipe-graph
validator.

Done when: `parseFormula` + `evalFormula` are exported; unit tests cover
arithmetic, function calls, var resolution, undefined-var errors, syntax
errors; `deno test` passes.

### T-124 · Recipe schema rewrite + content-graph validator
Effort: M   Status: done   Commit: b54bfe6   Phase 3 of T-121

`Recipe` type changes shape — destructive replacement of the input/output
fields; loader fails loud on the old shape (no migration path):

```
inputs: Array<{
  itemType?: string,         // exact prefab id (rare — keys, lore, etc.)
  category?: string,         // category filter (the common case)
  tags?: string[],           // all required (intersection)
  role: string,              // disambiguates multiple inputs
  quantity: number
}>

outputs: Array<{
  itemType: string,
  quantity: number,
  stats?: Record<string, string>  // statName → formula expression
}>
```

Exactly one of `itemType` / `category` per input, never both. Roles are
unique within a recipe. The crafting matcher iterates buffer slots,
assigns each to the first role whose category/tags filter accepts it, and
fails if any role goes unfilled.

Validator (runs once at server start, after content load):
- For every recipe, parse every output stat formula. Collect referenced
  variable names.
- For each `<role>.<stat>` reference: confirm at least one prefab matching
  that role's category/tags constraint produces `<stat>` (either via
  hand-authored prefab stats or via *some* upstream recipe whose output
  declares that stat under the matching itemType).
- For each `tool.<x>`, `workstation.<x>`, `skill.<x>` reference: confirm the
  variable belongs to the documented scope set.
- Any unsatisfied reference fails server boot with the recipe id and
  variable name. No silent NaN bows.

Done when: `Recipe` type carries the new shape; validator runs and passes
on the migrated content from T-125; spinning up the server with a
deliberately-broken recipe (drop a referenced stat from a wood prefab)
fails with a clear error message naming both files.

### T-125 · Wood + bow chain — first vertical
Effort: L   Status: done   Commit: 4287e5c   Phase 4 of T-121

Authoring pass that exercises every piece of T-122..T-124 end-to-end. No
new code unless something breaks.

- Add stats to the wood variants currently in `prefabs/items/`
  (`birch_wood`, `pine_wood`, `oak_wood`, `yew_wood`, `cedar_wood`,
  whichever exist). Tag `wood`. Stats: `flexibility`, `density`, `grain`,
  `flammability`, `color` (colour stays a hex int, but lives on the prefab
  not in stats — drop if it doesn't fit the f32 stat format).
- Add stats to the cordage variants (`linen_yarn`, `sinew`, `gut`).
  Tag `cordage`. Stats: `tensile`, `creep`, `elasticity`.
- Author replacements for the bow-chain recipes, deleting the originals
  in the same commit:
  - `bow_stave_split` (was: split). Takes `{ category: "wood", role: "stave" }`.
    Output `bow_stave` with stats `spring`/`weight`/`straightness` computed
    from `stave.flexibility`/`density`/`grain`.
  - `bowstring_assemble` (collapses `bowstring_linen` + `_sinew` + `_gut`).
    Takes `{ category: "cordage", role: "string", quantity: 3 }`.
    Output `bowstring` with stats `tensile`/`creep` from the cordage stats.
  - `wooden_bow_assemble`. Takes `bow_stave` + `bowstring`. Output
    `wooden_bow` with stats `draw_weight`/`range`/`durability`.
  - Same for `hunting_bow_assemble` and `composite_bow_assemble`.
- Delete the now-orphaned recipes: `bowstring_linen`, `bowstring_sinew`,
  `bowstring_gut`, `bow_stave_from_wood` (the broken `wood` reference one).
- Confirm T-124's validator passes against the result.

Done when: gathering yew, splitting a stave, twisting linen into a string,
and assembling all three on a bench produces a `wooden_bow` whose `Stats`
component reflects the chain (verifiable in network capture).

### T-126 · Migrate remaining categories (content sweep)
Effort: L   Status: done   Phase 5 of T-121

Replaced by a *catalogue wipe and minimal re-author* rather than a per-
category migration. Item count dropped 450 → 27, recipe count 238 → 13.
The new set is a single coherent pipeline (gather → smelt → forge → assemble)
that exercises every system in T-121..T-127 end-to-end with tractable
balance surface.

Categories: `wood` (birch / yew / oak — variants by stat), `ore` (iron_ore
with `purity`). Tags: `hardwood` (yew + oak only) gates `wood_handle_carve`,
proving tag-filter recipes work. Other materials (stone, fiber, coal) are
single-prefab and stat-less.

Resource nodes (7): tree, birch_tree, yew_tree, iron_ore_vein, rock_large,
fiber_bush, berry_bush. Zones updated; deprecated nodes (rock_small,
stone_deposit, coal_seam, copper_ore_vein, clay_deposit, flint_deposit,
mushroom_patch, flower_patch) removed.

Out of scope (deferred): cordage variance (sinew/gut), additional metals
(copper/steel/bronze), leather chain, stat aggregations (avg/sum across
multiple inputs of the same role). All purely additive over the current
shape — copy a recipe / variant file.

Pure content authoring — the system is in place from T-122..T-125. Each
sub-bullet is its own commit:
- `ingot` (copper, iron, steel, bronze, wootz). Stats: `hardness`,
  `toughness`, `density`, `melt_point`. Migrate the 50+ smith recipes.
- `cloth` (linen, wool, hemp). Stats: `weave_density`, `breathability`.
- `leather` (cow, deer, wolf). Stats: `thickness`, `suppleness`.
- `hide` and `fur`. Stats per real-world properties.
- `stone` (granite, sandstone, flint, marble). Stats: `hardness`,
  `friability`, `weight`.
- `bone`/`horn`/`shell`. Stats: `density`, `flexibility`.
- Whatever else the catalogue exposes once the pattern is set.

Each sub-pass deletes the per-variant recipe duplicates it replaces. Net
content count drops; the validator stays green throughout.

Done when: every domain in the existing recipe catalogue has been visited;
no recipe still expresses material variance via duplicated recipes or
`alternates`; the prefab item count is materially smaller than it is today.

### T-127 · Tooltip + procedural naming UI
Effort: M   Status: done   Phase 6 of T-121

Without UI, the system's depth is invisible — players just see numbers
fluctuate. Add:
- Inventory + workstation panel tooltips that show an item's stats with
  short labels (`Spring 0.96`, `Tensile 0.78`).
- A "provenance" affordance (right-click → Inspect, or hover-hold) that
  walks the entity-ref chain for crafted items and shows the chain:
  `Pine Bow ← Pine Stave ← pine_wood`. Bounded depth (3–4 levels max in
  the panel; deeper is collapsible).
- Procedural naming: the `displayName` for a crafted unique is built from
  the most-impactful role variant + the base prefab name. Convention:
  `{stave-variant-adjective} {base-name} with {string-variant} string`,
  e.g. `Pine Longbow with Linen String`. Rules live in a tiny formatter
  per recipe, declared next to the recipe (one line, optional — fall back
  to the base prefab name).

Done when: hovering a crafted bow in inventory shows its stats and a
provenance trail; the bow's display name reflects its source materials.

### T-034 · Terrain tool (shovel) — reduce heightmap cell via combat interaction
Effort: M   Status: done   Commit: 47a2a3d

wooden_shovel (digPower 1) and stone_shovel (digPower 2); DerivedItemStats.digPower field;
game_config.terrain: digStep, minDigHeight, materialDrops map. TerrainDigSystem fires on first
active-phase tick of a shovel swing; lowers Heightmap cell at targeted cell within DIG_REACH.

### T-035 · Terrain modification yields displaced material
Effort: S   Status: done   Commit: 47a2a3d

TerrainDigSystem reads MaterialGrid after dig; drops item matching materialDrops[matId];
auto-collects into digger inventory or spawns world ItemData entity when inventory is full.

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
Effort: S   Status: todo

The hiring workbench is currently hardcoded at spawn. Make it a craftable deployable item that
the player places in the world. Placed instance creates a `WorkbenchOwner` component with the
placer's dynasty ID.
Done when: players can craft and place hiring workbenches; ownership is tracked.

### T-039 · NPC sleep need + bed infrastructure
Effort: M   Status: todo

Add `Sleep` as an NPC need alongside `Hunger`/`Thirst`. Add a `bed` deployable. When sleep need
is critical, NPC seeks the nearest unoccupied bed and fulfills it. No bed = NPC enters permanent
low-performance state or eventually leaves.
Done when: NPCs seek and use beds; missing beds cause retention problems.

### T-040 · NPC sensory system — proximity event subscription
Effort: M   Status: todo

NPCs currently detect threats via direct distance checks. Replace with event-bus subscriptions:
NPCs subscribe to `DamageDealt`, `EntityDied`, `LoudNoise` events within their detection radius.
Guards subscribe broadly; labourers subscribe narrowly.
Done when: nearby combat events trigger NPC awareness without per-tick distance scans.

### T-041 · NPC Lore accumulation through job execution
Effort: M   Status: todo

When an NPC completes a job of a type it can learn from (crafting, building, gathering), increment
an internal Lore experience counter. At a threshold, add the relevant fragment to the NPC's Lore
set. Slower and with a smaller fragment ceiling than players.
Done when: a blacksmith NPC gains crafting-related Lore over many crafting jobs.

### T-042 · NPC specialisation matching to job requirements
Effort: S   Status: todo

Jobs in the board have optional `skillRequirement` field. When an NPC pulls a job, it checks
whether it has the required Lore. NPCs without the Lore skip to a lower-priority job.
Done when: a forging job requiring smithing Lore is only taken by NPCs with that fragment.

### T-043 · NPC social idle behaviour
Effort: S   Status: todo

When an NPC's job queue is empty, rather than standing idle, it wanders within a home range and
occasionally emits a `SocialIdle` event. Nearby NPCs react by moving closer briefly. Simple,
low-cost — flavour over simulation.
Done when: idle NPCs appear to socialise with nearby NPCs rather than standing frozen.

### T-144 · NPC ground-drop pickup pathway
Effort: S   Status: todo

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

### T-255 · NPCs can't pay stamina — melee/dodge never starts
Effort: S   Status: done   Commit: 6ec1cf6

Since T-229 wired `StaminaCostHandler` into the dispatcher, `canStart` fails for every NPC
swing: NPCs are deliberately seeded *without* a stamina resource (`spawner.ts:193-197`,
"parity" comment predates the cost wiring), `staminaValue` returns 0 for a missing resource,
and every swing action costs 10-22 stamina. What used to be "NPC skills fizzle" silently
became "NPC melee never starts" (2026-06 review).

Fix: seed NPCs with a stamina resource (template-driven max) — the "no isNpc branches"
answer, and NPC stamina pressure falls out for free. Alternative (worse): make the cost
handler's policy explicit for actors without the resource.

Done when: a wolf/bandit lands melee hits on a live server; dodge-capable NPCs dodge; an NPC
that runs dry visibly pauses attacking until stamina recovers.

---

## World & Macro Simulation

### T-044 · City state data structure + persistent state file
Effort: M   Status: todo

Define a `CityState` structure: personality traits, long-term goals, relationship map
(city→city stance), resource inventory, population count, event log (last N events).
Serialise to a JSON file per city; load on startup. This is the LLM's memory.
Done when: city state persists across tile server restarts; event log accumulates.

### T-045 · World event bus (gateway-scoped)
Effort: M   Status: todo

Implement the gateway-level event bus. Tile servers publish cross-tile events to it
(`PlayerCrossedGate`, `CaravanArrived`, `CityRaided`, etc.). The macro simulation and gateway
subscribe. Gateway event bus is distinct from the per-tile event bus.
Done when: a tile server can publish a world event; a gateway subscriber receives it.

### T-046 · City LLM agent interface — event-driven tool calls
Effort: L   Status: todo

Define the LLM call interface: context packet structure, available tool call schema
(`post_job`, `set_priority`, `send_caravan`, `propose_trade`, `declare_hostility`, `hire_npc`).
LLM is triggered by significant events from the world event bus. Validate and execute tool call
outputs against engine state.
Done when: a mock LLM response can be parsed and its tool calls executed by the engine.
Note: actual LLM integration is a separate ticket.

### T-047 · LLM fallback utility AI for city strategy
Effort: M   Status: todo

When LLM is unavailable, a simple utility AI runs: maintain food production jobs, keep guard
posts filled, trigger `send_caravan` when a surplus threshold is crossed. Strategic decisions
queue until the LLM responds.
Done when: a city without LLM access maintains basic operations autonomously.

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

### T-172 · Drowner creature + UAL2 import pipeline fix
Effort: M   Status: done   Commit: 84771f9

First non-human/non-canine creature: a Gollum-like swamp ambusher running on all fours with
elongated arms. Skeleton reuses the human bone-name schema so existing `anim_maps/` entries
work; voxel parts in a new `drowner_flesh` material with bone showing through skull/ribs/claws.
NPC template + prefab + addition to `MOB_NPC_POOL` so it spawns at mob POIs alongside
wolf/bandit/archer.

The work also exposed and fixed two latent bugs in `scripts/convert_anim.ts` and the
content-data conventions:
  - The converter was emitting absolute source-bone quaternions per keyframe, which baked the
    source rig's bind orientation (e.g. a leg bone whose source local Y points along the bone)
    into every frame and stacked it on top of our identity-rest skeleton. Fix: subtract the
    source node's bind rotation before Euler conversion so frames are stored as deltas-from-bind.
    Benefits any future Mixamo/CMU/Quaternius import.
  - Bone segment lengths must match attached voxel-model lengths or you get visible gaps at
    every joint (1-voxel-wide limbs make this glaring). Drowner part-models extended to fill
    the 2.5-unit arm and 1.5-unit upper-leg segments.

New `anim_maps/ual.json` covers the Unreal-style bone names (`pelvis`, `spine_01/02/03`,
`upperarm_l/r`, `thigh_l/r`, `calf_l/r`) used by `UAL2_Standard.fbx`, distinct from the older
Mixamo-style names handled by `quaternius.json`. Four core clips converted: idle / walk /
attack / death.

Done when: a drowner spawns at a mob POI, plays the converted Zombie idle in rest pose without
distortion, and the rest of the UAL2 library can be imported by any caller running
`convert_anim.ts <glb> ual --clip <name>`.

---

## Gateway & Multi-tile

### T-051 · Gateway handshake flow
Effort: M   Status: todo

Implement the real gateway handshake: client connects → authenticates → gateway looks up which
tile the player is on → returns tile server address → client opens direct WebTransport connection
to tile server → gateway steps off the data path.
Done when: a fresh client connects through gateway and reaches the correct tile server.

### T-052 · Tile directory — register on startup, lookup by player
Effort: S   Status: todo

Tile servers register with the gateway on startup (tile ID, address, current population).
Gateway maintains this directory in memory. Player→tile mapping updated on each gate crossing.
Done when: gateway can answer "which tile is player X on?" with current data.

### T-053 · Gate entities on tile edges
Effort: M   Status: todo

Gates are physical entities in the world at fixed positions on tile edges (from world generation).
Player approaching a gate receives a `GateApproached` event. Gate carries `destinationTileId`.
Done when: gate entities exist; player proximity triggers the gate event.

### T-054 · Player tile traversal — entity handoff
Effort: L   Status: todo

On `GateApproached` event, source tile server serialises the full player entity (all components).
Sends serialised entity + destination tile ID to gateway. Gateway forwards to destination tile
server which deserialises and inserts the entity. Source tombstones the entity.
Done when: a player crosses a gate and continues play on the destination tile; no component state
is lost.

### T-055 · Client tile transition — new WebTransport connection
Effort: M   Status: todo

When the client receives a `GateCrossing` event in the state stream, it opens a new WebTransport
connection to the destination tile server address (provided by gateway), closes the old one, and
re-initialises the client world state from the first state message on the new connection.
Done when: client seamlessly transitions between tiles on gate crossing.

### T-256 · Handoff v2: transfer the whole player, not eight components
Effort: L   Status: todo

The T-140 handoff ships a partial component list and loses state in four ways (2026-06
review; same root cause as T-251 — partial entity transfer with no "re-complete" pass):

- **Unique items are destroyed.** `serializePlayer` (`handoff.ts:57-80`) copies the
  `Inventory`/`Equipment` components but not the referenced item *entities* (Durability,
  QualityStamped, …). On the destination, `StaleSlotCleanupSystem` scrubs the dangling refs
  next tick; the source tile destroys only the player and leaks the orphaned item entities.
  Every gate crossing silently deletes everything equipped/unique.
- **`restorePlayer` produces a hollow entity.** It writes 8 components; the reconnect path
  sees `isAlive` and skips `spawnPrefab` (`server.ts:1353-1355`) — no ModelRef (invisible),
  no Hitbox (unhittable), no ActorSlots (can't act), no FogState/Heritage/Name.
- **Handoff↔disconnect race.** `handedOff` is set only after the gateway ack
  (`server.ts:1202`); a disconnect during the fetch runs normal cleanup (wrong
  `updateLocation`, ghost entity on the destination), and the stale `handedOff` entry later
  swallows a real death's `recordDeath` (`server.ts:1503-1507`). The `wasHandedOff`
  early-return also precedes `saveFog` — fog is dropped on every crossing.
- **Gates ignore the carved portal offset.** Tile-server places triggers/arrivals at edge
  midpoints (`gate.ts:37-58`) while atlas carves the only walkable corridor at the shared
  `gate.offset` — gates can be physically unreachable and arrivals land in closed pixels.

Fix shape: serialize the full archetype *plus* referenced item entities (recursive over
inventory/equipment refs); restore through `spawnPrefab` + component overlay, not raw
writes; mark `handedOff` before the gateway fetch and reconcile on failure; place
gates/arrivals at the carved offset. Add a serialize→restore round-trip test asserting
component-set equality.

Done when: a player crosses a gate with equipped unique items and continues playing —
visible, hittable, acting, items intact, fog preserved — and a disconnect mid-handoff
neither ghosts the entity nor suppresses a later death record.

### T-257 · Multi-process correctness sweep: routing loop, event-log order, regen params, TILE_ID
Effort: S   Status: todo

Four independent fixes across the multi-process stack (2026-06 review):

- **A dead tile stream kills coordinator→tile routing permanently.** The write rejection
  exits the gateway read loop without closing the coordinator session
  (`gateway/src/edge/wt_server.ts:186-196`) — the coordinator keeps writing into a stream
  nobody reads until process restart. Close the session on routing failure (both
  directions) so reconnect logic kicks in. Symmetric hazard in `acceptTile`'s loop.
- **City event log is permuted on every append.** The trim query's `ORDER BY 1` orders the
  one-row outer select, not the aggregate input (`db/src/repos/city_repo.ts:106-122`) — the
  log scrambles and the LIMIT trim evicts the wrong entries. Fix:
  `jsonb_agg(elem ORDER BY idx)`.
- **Atlas lazy regen ignores persisted GenParams.** `getOrGenerateTile`
  (`atlas/src/server.ts:473`) falls back to `DEFAULT_GEN_PARAMS` while the bake path uses
  the world's merged params — on-demand tiles diverge from baked siblings. Pass the
  persisted params.
- **Default `TILE_ID="tile_0"` cannot boot.** `parseTileId` requires `^\d+_\d+$` and
  `loadTerrainFromAtlas` runs unconditionally — the documented `deno task tile`/`demo`
  paths crash without an explicit `TILE_ID=0_0`. Fix the default in `tile-server/main.ts:62`.

Done when: killing a tile mid-command doesn't wedge the coordinator channel; event-log
ordering has a repo test; lazy-regen output matches the bake for a non-default world;
`deno task demo` boots with no env vars.

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

### T-056 · World map macro generator
Effort: L   Status: todo

Generate the world map: elevation noise → temperature/moisture gradients → biome assignment per
tile cell. Output: a `WorldMap` structure with biome per cell, elevation, river flag, city seed
positions, corruption zones, road network stub.
Done when: a deterministic world map generates from a seed; biomes are distributed correctly.

### T-057 · River tracing on world map
Effort: M   Status: todo

Trace rivers from high-elevation cells downhill to coastal or low-elevation outlets. Output a
list of tile cells with river presence flag. River tiles get a channel cut during tile generation.
Done when: rivers flow from mountains to coast; river flags are present on tile map cells.

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

### T-060 · Corruption distribution on world map
Effort: S   Status: todo

Place one or more catastrophe ground-zero points. Compute corruption level for each tile cell
using falloff from ground-zero points. Corrupted and Badlands biomes cluster here.
Done when: corruption level is available per tile cell; biome assignment uses it.

### T-061 · Tile generator — biome-parameterised heightmap + resource nodes
Effort: L   Status: todo

Generate a tile on demand from world map inputs: biome, elevation, river flag, road flag,
corruption level, gate positions. Produces `Heightmap`, `MaterialGrid`, and resource node
entities seeded by biome type and density.
Done when: a tile loads from world map data with correct biome-appropriate terrain and nodes.

### T-062 · Corruption overlay in tile generation
Effort: M   Status: todo

If a tile's corruption level > 0, warp terrain (increase noise amplitude) and replace normal
spawns with corrupted variants. Higher corruption = more severe warping.
Done when: corrupted tiles have visibly warped terrain; enemy spawns are corrupted variants.

### T-063 · Cave instance tile type
Effort: M   Status: todo

Cave instances are tiles with enclosed-rock generation (walls + floor = rock material, no open
sky). A cave gate on a surface tile links to a cave tile ID. Cave tiles are generated with the
same tile generator, just with different biome parameters (cave biome).
Done when: a surface gate can link to a cave tile; cave tile generates correctly.

### T-064 · Dynamic chunk loading/unloading by entity proximity
Effort: M   Status: todo

Currently all chunks for a tile are loaded at startup. Load a chunk entity into the world only
when a player or active NPC is within a configurable radius. Serialise and unload chunks with
no nearby entities after a grace period.
Done when: distant chunks are absent from world store; they load when an entity approaches.

### T-156 · Atlas tilemap — three wall kinds (grass mound, stone, forest), all 2u
Effort: S   Status: done   Commit: 8412026

The maze needs three visually distinct wall types, all non-walkable, all
raised the same 2 world units (just enough to exceed the 0.75u runtime
stepHeight). The existing `boundary_kinds` machinery had three slots
(CLIFF / VEGETATION / WATER) but only CLIFF was raised; VEGETATION was
flat-with-trees and the third "default" wall type was missing.

  - Rename CLIFF → STONE, VEGETATION → FOREST atomically through atlas
    + tile-server. Same numeric ids (1, 2) so old wire payloads still
    decode meaningfully — they were just internal vocabulary.
  - Add `BOUNDARY_KIND_GRASS_MOUND` (id 4). Becomes the fallback wall
    type — picked when neither STONE (high altitude / rugged) nor FOREST
    (high moisture) qualifies. Inspector colours it bright green.
  - `WALL_HEIGHT` 3.0 → 2.0; terrain stage now raises all three wall
    kinds (STONE, FOREST, GRASS_MOUND), not only STONE. WATER and OPEN
    stay at floor height. Players can't step over any wall type.
  - Per-kind closed material: STONE → STONE, FOREST → DIRT (forest
    floor), GRASS_MOUND → GRASS, WATER → WATER.
  - GenParams `kinds` slice renamed: `cliff*` → `stone*`,
    `vegetationMoisture` → `forestMoisture`, `vegetationDensityStride`
    → `forestDensityStride`. Inspector knob configs + hints follow.

Done when: a baked tile shows green-mound walls in dry biomes, dark-green
forest walls (with trees on top) in wet biomes, grey stone walls in
high-altitude biomes; player can't step over any of them; the inspector
"kinds" layer paints all four ids distinctly.

### T-155 · Atlas tilemap — paths first, rooms emerge at convergent junctions
Effort: M   Status: done   Commit: 9690371

Inverts the pipeline order. Today chambers come first and corridors are
forced to bridge them; user wants paths to drive the structure and rooms
to *emerge* where many paths converge.

New stage layout:

  noise → junctions → network → rooms → portals → ...

  - **junctions** (replaces the seed-placement half of `chambers`):
    Poisson-disk sample N points across the tile. Just positions; no
    growth. These are first-class graph nodes, not rooms.

  - **network** (modified): operates on `seeds[]` instead of chambers.
    Delaunay over the seeds, MST + braid as before, carve all chosen
    edges as Catmull-Rom splines (seed → seed; no boundary-endpoint
    walk needed since seeds are points). Recursive branches as before.
    NEW: returns a `degrees[]` array — for each seed, the count of
    chosen edges touching it.

  - **rooms** (new, replaces the growth half of `chambers`): per
    junction, roll a probability scaling with degree:
    `prob = clamp(roomChanceBase + (degree − 1) · roomChancePerDegree, 0, 1)`.
    Junctions where the roll succeeds get a noise-flooded disk grown
    around them via the same priority-flood used before, but tightly
    sized (`sizeMin/sizeMax` tuned for ~200–600 px = small "hub"
    rooms). Round-robin growth lets adjacent rooms compete fairly.
    Pass-through junctions (low degree) become invisible bends in the
    corridor; convergent junctions (degree ≥ 3) usually become rooms.

  - **portal_placement** (modified): targets the nearest junction
    instead of the nearest chamber. After room growth some junctions
    have rooms, some don't — gate carves don't care; they just stitch
    into the network.

GenParams adds `room.roomChanceBase` (default ~0.05) and
`room.roomChancePerDegree` (default ~0.30): degree 1 → 5%, degree 2 →
35%, degree 3 → 65%, degree 4 → 95%, ≥5 → 100%. Existing
`room.sizeMin/Max/compactness` retuned for the smaller room scale.
`chambers.ts` is deleted (replaced by the junctions + rooms split).

Done when: forest_maze bake produces a dense maze of paths with most
junctions invisible (just bends) and ~30–50% of junctions hosting small
noise-shaped rooms. Connectivity: the spanning tree still connects
every junction (and every gate to every other gate).

### T-154 · Atlas tilemap — organic chambers + recursive branch-paths
Effort: M   Status: done   Commit: f282b2c

After T-153 chambers were properly sized but visually too round (compactness
× distance dominates noise ~10:1, so growth is essentially Voronoi) and
the network was sparse — only chamber-to-chamber MST + braid corridors,
~10 carves per tile total. The user wants chambers with organic lobes
and "many more paths weaving like a maze."

Three bundled changes:

1. **Lower compactness, raise noise frequency.** Drop default
   `room.compactness` from 0.35 → 0.10 and bump `noise.baseFrequency`
   from 0.0125 → 0.022 across all presets, so noise wavelength becomes
   smaller than chamber radius — noise has space to sculpt the boundary
   into lobes/peninsulas/indents instead of being averaged out.

2. **More mainline interconnections.** Bump `room.targetCount` 7 → 10
   and `network.loopRate` 0.55 → 0.85 in the forest_maze preset. More
   chambers → more Delaunay edges; more loop rate → more braids kept.
   Roughly doubles the main corridor count.

3. **Recursive branch-paths pass.** After the main carve loop, each
   corridor optionally spawns sub-branches that wander off into the
   wall space. For each parent corridor: with probability
   `network.branchRate`, sample a point along its spline at random t
   in [0.2, 0.8], take the local tangent, pick a perpendicular ± random
   angle, and carve a new spline of length
   `branchLengthFraction × parent_length`. Branches recurse up to
   `branchMaxDepth` levels (each level scaled down by lengthFraction),
   so the carve fan-out is bounded but visible. Branches that
   coincidentally hit other corridors / chambers form natural junctions;
   ones that don't form dead-end paths — both reinforce the maze feel.

The `samplePoint` and `sampleTangent` helpers (Catmull-Rom evaluator
+ analytical derivative) move into `bezier_carve.ts` so other consumers
(future "POI placement on a corridor", inspector hover markers, …) can
reuse them.

Done when: forest_maze bake produces ~10 chambers with visible noise
lobes (no longer reading as disks) and the corridor count rises from
~10 to 30+, with branches forming dead-ends and crossings throughout
the wall space.

### T-153 · Atlas tilemap — generate at runtime resolution (gridSize 128 → 512)
Effort: S   Status: done   Commit: 1a15c73

Atlas was running its pipeline at a 128² sample grid and the upsample stage
was scaling the result 4× to fit tile-server's 512² voxel resolution. That
created a visible seam between what the inspector showed (chunky, coarse)
and what the player walked on (finer, with bilinear floor reconstruction
and nearest-neighbour openness). Bump `DEFAULT_GRID_SIZE` to 512 so atlas
generates at the same resolution as the runtime; one pixel = one voxel
= one world unit. The upsample stage stays in place but the loop becomes
effectively a 1:1 copy plus material translation.

Two follow-on cleanups land in the same commit:

- **`compactness` uses world units.** The chamber-growth distance term was
  in pixels, which would silently mean different things at different
  gridSize. Multiply by `px2world` so the knob is gridSize-invariant.
- **Spatial defaults rescaled.** All knobs that previously meant "pixels
  at 4 wu/px" now mean "pixels at 1 wu/px". minSeparation 32 → 128;
  sizeMin/Max 320/600 → 5000/9500; maxEdgeLength 90 → 360;
  widthMin/Max 0/1 → 1/3; bezierSamples 50 → 200. All four presets
  retuned. Inspector knob ranges widened to fit the new scale.

Done when: re-bake of forest_maze produces ~7 chambers per tile that
look identical in shape between the inspector and an in-game tile, no
upsample seam, and player physics behaves the same as before (collision
& heightmap unchanged).

### T-152 · Atlas tilemap — room-feeling chambers + segmented spline corridors
Effort: M   Status: done   Commit: 82c1639

T-151 produced chambers that read as snake-shaped fragments of the noise
field instead of *rooms* (areas you can spawn things inside), and single-
quadratic corridors that cut straight through chambers and could swing
outside the tile. Four bundled fixes to land it as a usable level shape:

1. **Compact chamber growth.** Today the priority-flood cost is just
   `noise[p]`, so chambers follow whichever low-noise lobe drifts away
   from the seed → snake silhouettes. Add a distance-from-seed term:
   `cost = noise[p] + compactness · |p − seed|`. `room.compactness`
   defaults around 0.35 — chambers accrete volume around the seed but
   still take organic shapes from noise structure. Combined with much
   bigger `sizeMin/sizeMax` defaults, this gives chambers that read as
   spaces, not corridors.

2. **Boundary endpoints.** Corridors used to run centroid → centroid,
   carving straight through the chambers they "connect". Now each
   network edge ray-marches from each centroid toward the partner and
   uses the last in-chamber pixel as the bezier endpoint. The chamber
   interior stays untouched; corridors look like they enter and exit at
   the chamber walls, which is what makes them feel like *gaps in a wall*
   rather than tubes drilled through rooms.

3. **Segmented spline paths.** Single quadratic bezier replaced with
   `network.segments` (default 4) waypoints generated along the line
   between endpoints, perpendicular-perturbed by `curvature ·
   edge_length` with a sin envelope so the perturbation tapers to zero
   at the endpoints. The carve sweeps a Catmull-Rom spline through the
   waypoints (each segment becomes a cubic bezier; C1 continuous at the
   joints). This gives real wandering paths instead of one arc.

4. **Tile-interior clipping.** Each waypoint is clamped to a margin
   inside the tile (margin = halfWidth + 2). Corridors no longer
   excursion outside the playable area when curvature is high.

`Corridor` record changes from (a, cp, b) to a `waypoints: Array<{x,y}>`
list. Inspector replicates the same Catmull-Rom math to draw centerlines.
Defaults retuned: chambers larger and rounder, corridors narrower so
chambers visually dominate the tile.

Done when: bake forest_maze and the inspector shows ~7 chunky chambers
of varied organic shape, corridors that wander through 3-5 bends and
stay inside the tile, and chamber interiors visibly preserved (no
corridor cutting them in half).

### T-151 · Atlas tilemap — Poisson-seeded chambers + bezier corridor carve
Effort: M   Status: done   Commit: 33ec1a6

T-150 produced too many chambers (~17 typical) with round/blob silhouettes
and fixed-width A* corridors that read as straight wedges. Replace the
chamber and carve stages so designers get explicit count control, organic
silhouettes, and curving variable-width paths between rooms.

Replace, don't accrete (the prior `roomify` and `carve` modules are
deleted in the same commit):

1. **`chambers`** (replaces `roomify`) — Poisson-disk sample N seeds
   (target count, deterministic from tileSeed), then grow each chamber
   via priority flood over the noise field: round-robin one-pixel-at-a-
   time accretion, lowest-noise neighbour first. Naturally gives organic
   shapes (the chamber follows weak-noise lobes) and Voronoi-ish
   competition between adjacent chambers.

2. **`bezier_carve`** (replaces `carve`) — for an edge between two
   chamber centroids: midpoint perpendicular-displaced by `network.curvature
   × edge_length × ±sign`, quadratic bezier sampled densely, square brush
   of `widthMin..widthMax` stamped at each sample. Per-edge width is
   sampled per edge from a tile-seeded PRNG so different routes have
   visibly different girths.

3. **`network`** rewritten to use bezier_carve. Stores the carved
   corridors (endpoints + control point + width) on `TileInit.corridors`
   so the inspector can draw centerlines and per-edge widths.

4. **`portal_placement`** carves gates → nearest chamber via the same
   bezier carve; the gate corridors land in `TileInit.corridors` too.

5. **GenParams** restructured: `room.{targetCount, minSeparation,
   sizeMin, sizeMax}` and `network.{maxEdgeLength, loopRate, widthMin,
   widthMax, curvature, bezierSamples}`. Inspector knob hints updated.

6. **Inspector** rooms layer overlays the corridor centerlines as thin
   contrasting lines on top of the chamber-coloured open pixels, so the
   network reads as drawn paths instead of just light-grey blobs.

Done when: the four named presets each give 5–10 chambers per tile with
visibly organic silhouettes, corridors curve and vary in width, the
inspector renders centerline overlays on the rooms layer, and the gate
summary stays correct (every present gate reaches every other through
the carved network).

### T-150 · Atlas tilemap — interwoven room network from noise blobs
Effort: M   Status: done   Commit: 64d2bc1

Today's tilemap pipeline leaves connectivity to luck: noise threshold produces one rambling
open snake, room detection labels whatever blobs fall out, and `portal_placement` carves a
straight 1-pixel stub from each gate until it bumps into anything open. There's no guarantee
gates reach each other, and no design intent behind which rooms connect to which.

Replace the head of the pipeline with a structural pass that uses the noise field as the
*source of organic shape* but treats connectivity as a deliberate plan:

1. **Tighten noise threshold** so the field fragments into many distinct open blobs
   instead of one connected region.
2. **`runRoomify`** — drop blobs below `params.room.minPixelArea`; optionally dilate the
   keepers; re-flood for a clean `rooms[]` + `roomOf`.
3. **`runNetwork`** — Delaunay triangulation over room centroids → MST for guaranteed
   connectivity → keep `params.network.loopRate` of the remaining Delaunay edges as loops.
   Carve each chosen edge using A\* through closed pixels with **noise-flow cost** (the
   carve naturally meanders along the weakest walls — no straight-line cuts).
4. **Shrink `runPortalPlacement`** to "stitch each gate into the network": pick the nearest
   room centroid, A\* from the gate's edge pixel using the same noise-flow cost.
5. New `GenParams` slices `room` and `network`; presets and inspector knob hints updated.

Done when: every present gate is on the network, the inspector "rooms" view shows a
clearly interwoven layout (multiple paths between most room pairs), corridors visibly
follow noise-thin regions instead of cutting straight lines, and the four named presets
each give a distinct overall topology.

### T-203 · `@voxim/levelgen` — typed transformer pipeline package
Effort: S   Status: done   Commit: 808036a

The tilemap pipeline in `packages/atlas/src/tilemap/pipeline/` is already a series of
pure `runX(state, params, seed) → state` functions, but the contract is informal: each
stage invents its own signature, the orchestrator in `generate.ts` threads state by
hand, and there is no place for cross-cutting concerns (tracing, memoization, seed
splitting, pluggable implementations). As level generation grows (yin-yang macro mask,
wilderness segmentation, POI dependency DAG, content fill — see T-204, T-205, and the
broader level-design notes), this needs to be a real abstraction.

Create a new package `@voxim/levelgen` that holds only the infrastructure — no
algorithms. It is the contract every level-gen stage in the project (atlas, tile-server,
future tools) speaks.

Surface:
- `Transformer<TIn, TOut, TParams>` — `(state: TIn, seed: number, params: TParams) => TOut`.
  Pure, deterministic, no I/O.
- `pipe(a, b, c, …)` — type-aware composition. The TS compiler rejects a pipeline whose
  intermediate types don't match. Returns a `Transformer<First.TIn, Last.TOut, …>`.
- `splitSeed(globalSeed: number, stageId: string): number` — deterministic hash so each
  stage runs on its own RNG stream. Changing late-stage params does not reroll early
  stages. Implementation: stable string-hash (e.g. xxhash32 or FNV-1a) combined with the
  global seed; must be portable and independent of JS engine ordering.
- `Registry<TIn, TOut, TParams>` — keyed lookup of transformer implementations for one
  stage. `register(id, transformer)`, `get(id)`. Enables pluggability (Voronoi vs.
  WFC segmentation, etc.) without baking choices into the orchestrator.
- `withTrace(transformer, sink)` — wrapper that publishes `{ stageId, inputHash,
  outputHash, params, durationMs }` to a sink for inspector use. Production code uses
  the bare transformer; Atlas wraps for instrumentation.
- `memoize(transformer)` — keyed on `(inputHash, seed, paramsHash)`. Optional opt-in;
  used by Atlas's inspector to keep "slider tweak → repaint" fast.

Constraints:
- Zero runtime dependencies beyond `@voxim/engine`'s utility surface (and only if
  actually needed — prefer no deps).
- Hashing utilities live here too, so atlas and tile-server agree byte-for-byte on
  `(input, params) → hash`.
- The package is consumed by both atlas and tile-server — no platform-specific code.

Done when: `deno check` passes; `@voxim/levelgen` exports the surface above; a tiny
internal smoke test composes two no-op transformers, verifies typed `pipe` rejects a
mismatch, and shows `splitSeed` produces stable, well-distributed sub-seeds. No
consumer migration in this ticket — that lands in T-204.

### T-204 · Migrate atlas tilemap pipeline to `@voxim/levelgen` Transformer interface
Effort: M   Status: done   Commit: e28f283   Depends on: T-203

The 9-stage tilemap pipeline (`noise_field → junctions → network → rooms →
portal_placement → boundary_kinds → rivers → terrain → materials`) lives in
`packages/atlas/src/tilemap/pipeline/` with ad-hoc `runX` signatures and hand-threaded
state in `generate.ts`. Lift it onto the Transformer contract from T-203.

Per stage:
- Define explicit `TIn` / `TOut` types (no more shared "TileState" grab-bag — each
  stage names exactly what it consumes and what it produces).
- Convert `runX` to `Transformer<TIn, TOut, TParams>` where `TParams` is the relevant
  slice of `GenParams`.
- Replace the per-stage `seed` argument with a `splitSeed(tileSeed, stageId)` call
  inside the orchestrator. Stages must not see the global tile seed directly.
- Replace `generate.ts`'s hand-threaded orchestration with one `pipe(...)` composition
  parameterised by the `GenParams` object.

Determinism gate (the bar for "done"):
- Snapshot the current inspector output (openMask, chamberOf, kindOf, heightmap,
  materials, gateSummary) for every named preset and a handful of representative seeds
  before the refactor.
- After the refactor, regenerate and assert **byte-identical** output. Any divergence
  is a bug in the migration, not a freedom granted by the abstraction.
- Snapshot test lives in `packages/atlas` and runs under `deno test`.

Tile-server's call into atlas (if any — verify; otherwise this is purely an atlas-side
refactor) updates in the same commit. No shims, no `runXLegacy`, no parallel paths.

Done when: snapshot test green for every preset, `deno check
packages/atlas/mod.ts` passes, `generate.ts` is a one-screen `pipe(...)` composition,
and every old `runX` is either renamed/replaced or deleted.

### T-205 · Atlas inspector — pipeline trace, layer toggles, transformer-swap UI
Effort: M   Status: done   Commit: be3725f   Depends on: T-204

With T-204 the pipeline is a list of typed Transformers each producing a snapshottable
state. Build the inspector affordances that turn that into a real procedural-generation
playground:

- **Per-stage trace panel** — shows every stage in pipeline order with input/output
  hashes, duration, and a "view output" radio. Selecting a stage renders that stage's
  output as the inspector's primary view (instead of the final tile). Layer overlays
  (gates, junctions, chambers, network edges) compose on top.
- **Per-stage param editor** — each stage's `TParams` slice renders as labeled controls
  derived from the existing `GenParams` knob-hints. Editing a param re-runs the
  pipeline from that stage onward (earlier stages hit the memoization cache from T-203
  and don't recompute).
- **Memoized re-runs** — apply `memoize` to every stage. Goal: a slider tweak in the
  late-stage `materials` params updates the view in under ~50 ms for a 512² tile.
  Verify by instrumenting and showing the "cache hit / cache miss" per stage in the
  trace panel.
- **Pipeline-config picker** — surface a single dropdown that loads a named pipeline
  config (transformer choice per stage, default params). v1 ships with the current
  pipeline as the only choice and the four existing GenParams presets — the
  *architecture* supports more, but populating alternative implementations is later
  work. Picker selection is reflected in the URL so configs are shareable.
- **State export/import** — a "dump state at stage N" button writes the
  serialised `TOut` of any stage to a JSON file. Loading a dumped state into the
  inspector skips upstream stages and renders from there. Foundation for bug repros
  and CI fixtures.

The "manual override" / hand-paint mode is explicitly **out of scope** — it would
introduce a second source of truth and break determinism. Editing happens through
procedural params only.

Done when: opening Atlas on a freshly generated tile shows the trace panel populated
with all 9 stages, clicking each stage swaps the primary view to that stage's output,
slider tweaks confirm sub-50ms repaints for late-stage edits via the cache-hit
indicator, dumping and reloading an intermediate state round-trips byte-identical, and
the URL captures the active preset + seed.

### T-206 · POI content schema — TypeScript types + valibot validation + loader
Effort: S   Status: done   Commit: a4faf77

The POI schema is designed and three example POIs ship in
`packages/content/data/pois/` (`wolf_den`, `ancient_arena`, `glyph_puzzle`),
with the full design in `packages/content/data/pois/SCHEMA.md`. This ticket
wires the schema into the content package so authoring errors fail loudly at
load time and the generator (T-209) has typed access to POIs.

- Add `PoiDef` and supporting types to `packages/content/src/types.ts`,
  matching SCHEMA.md exactly. The `activity` field is a discriminated union
  keyed on `type`; `gate` is a discriminated union keyed on `kind`.
- Add a valibot schema in the same module (or a sibling file) for runtime
  validation. The loader must reject unknown `type`/`gate.kind`/`role`
  values, out-of-range `difficulty`, and POIs whose `gate` declares
  `flavorAccept` while `kind` is `"open"`.
- Extend `JsonSource.load()` to scan `data/pois/` and produce a
  `ContentRegistry<PoiDef>`. SCHEMA.md is ignored (md files filtered out at
  the loader, same pattern other categories already use).
- `ContentService` gains `getPoi(id)`, `listPois()`, `findPoisByRole(role)`,
  `findPoisByTag(tag)`. The last two return arrays; the matcher in T-209
  will use them heavily.
- Tests in `packages/content/src/`: load the three example files, assert
  shape; assert that a deliberately broken POI (unknown `type`) rejects;
  assert that SCHEMA.md's examples stay in sync with what the loader
  accepts (parse-and-compare the json blocks if practical, else load the
  three example files which double as living docs).

Done when: `deno check` clean across affected packages, `deno test`
green on the new POI tests, atlas + tile-server still load without
warnings, adding a fourth POI file is purely a file drop.

### T-207 · Author POI roster covering type + theme space
Effort: M   Status: done   Commit: 3e6dc7c   Depends on: T-206

Three POI examples are not enough to make the generator (T-209) produce
varied tiles. The roster needs to cover every POI `type` with at least 2-3
variants, and the theme vocabulary must form **bridging chains** — for
every accept-themes-set declared by some POI's gate, at least one other
POI's `reward.trinketTheme.themes` must intersect it. Without bridges,
the constraint solver runs out of valid keys and resorts to retry-spam.

Target: ~15 authored POI definitions covering:

- 3-4 `encounter` (wolf_den is one; add e.g. `bandit_camp`, `bog_drowner_pool`,
  `corrupted_glade`)
- 2-3 `bossfight` (ancient_arena is one; add e.g. `hollow_root`, `tideborn_serpent`)
- 2-3 `wave` (e.g. `forgotten_garrison`, `cursed_quarry`)
- 2-3 `puzzle` (glyph_puzzle is one; add e.g. `mirror_atrium`, `tideflow_locks`)
- 1-2 `action` (e.g. `ancient_chalice`, `signal_pyre`)
- 1-2 `exploration` (e.g. `cairn_marker`, `weeping_statue`)

Theme vocabulary v1 (every accept must be drop-reachable from some POI):
`bone`, `stone`, `primal`, `ancient`, `ritual`, `arcane`, `glyph`, `regal`,
`mystic`, `verdant`, `rotten`, `tidal`, `cursed`, `martial`.

Ship a small validator script (`scripts/check_poi_bridges.ts`) that loads
the roster and asserts every gate's `flavorAccept` is reachable from at
least one POI's `themes`. Run it in CI / pre-commit.

Done when: 15+ POI files exist, the bridge-check passes, atlas tiles bake
without retry-saturation warnings (T-209 logs retry counts).

### T-208 · AnnotatedZoneGraph + topology-annotation transformer
Effort: M   Status: done   Commit: 19bcfaf

The current pipeline produces `chamberOf` (per-pixel chamber id) and
`rooms` (connected-component records after carving), but downstream stages
that want to *reason about zones* — POI matcher in T-209, surface modulation,
spawn rules — have to re-derive structure from raw pixel state every time.
Lift that derivation into a first-class artifact.

New `Transformer<MaterialsState, AnnotatedZoneState, ZoneParams>` running
after `materials` (last stage in the run, so it sees all final state):

```typescript
interface AnnotatedZone {
  id:        ZoneId;
  pixels:    Uint32Array;    // indices into the grid; cheap to iterate
  area:      number;
  centroid:  { x: number; y: number };
  aspectRatio: number;       // 1.0 = round, → 0 elongated
  enclosure:  number;        // 0..1: how surrounded by closed pixels
  topologyRole: ZoneRole;    // "plaza" | "pocket" | "deadend" | "corridor" | "crossroads" | "lobby" | "arena"
  kindHistogram: Record<KindId, number>;  // for kind-filtered POI matching
  neighbors: ZoneId[];       // adjacency in the corridor graph
  isEntry:   boolean;        // touches a portal
}
interface AnnotatedZoneState extends MaterialsState {
  zoneGraph: { zones: AnnotatedZone[]; byPixel: Uint16Array };
}
```

Role assignment is rule-based on (degree, area, aspectRatio, enclosure):
- `arena`     — area > 1500
- `plaza`     — degree ≥ 3, aspectRatio > 0.6, area > 400
- `crossroads`— degree ≥ 3, area < 400
- `lobby`     — degree == 2, area > 250
- `corridor`  — degree == 2, area ≤ 250, aspectRatio < 0.4
- `pocket`    — degree == 1, area > 150
- `deadend`   — degree == 1, area ≤ 150

Atlas inspector: add a new view-stage (T-205's view-this-stage radio
naturally extends) that colorises zones by role. Use it to eyeball
classification before T-209 consumes it.

Done when: every tile produces a `zoneGraph` with topology roles; inspector
renders the zone-role layer; a snapshot test asserts byte-identity for
representative tiles (same gate as T-204).

### T-209 · POI matcher + dependency-DAG solver
Effort: L   Status: done   Commit: b9a2641   Depends on: T-206, T-208 (T-207 deferred — see below)

The Tier-6 generator. Consumes `AnnotatedZoneGraph` (T-208) + the POI
roster (T-207), produces a `TileNarrative` (`PoiInstance[]`,
`TrinketInstance[]`, `dagShape`, entry + terminal sets) per the contract in
SCHEMA.md § 8.

Phases inside the transformer:

1. **Candidate scoring** — for every (zone, POI-def) pair, compute a fit
   score from `fit` constraints. Hard rejects (`requiredBiome` mismatch,
   area out of bounds, `requiredKind` empty intersection) drop to 0;
   soft mismatches (preferred topology absent) reduce the score but
   don't eliminate.
2. **Selection** — pick N POIs (N depends on tile difficulty tier;
   3-7 typical) under constraints: at least one POI with `entry` role,
   exactly one with `terminal` role if dagShape requires one, no two
   POIs in the same zone, world-wide quota weights respected.
3. **DAG wiring** — assign keys/locks. For each non-entry POI, find an
   upstream POI whose `reward.trinketTheme.themes` intersects this POI's
   `gate.flavorAccept`. For `multi` gates, find `count` distinct upstream
   POIs. Acyclicity + reachability checked at end; failure → bump retry
   sub-seed and reset.
4. **Trinket naming** — procedural display name from source themes + dest
   flavorTags + sourcePoi.displayName per SCHEMA.md § 6.

Determinism gate: all phases consume sub-seeds derived from
`splitSeed(tileSeed, "poi_phaseN_retryM")` (T-203 utility). Retry count
becomes part of the tile save so reload reproduces. Bounded retry: max 16
attempts, then fall back to a degraded DAG (linear chain through best-fit
POIs only, no flavour matching) and log a warning.

Auxiliary content categories this needs (separate tickets if scope creeps;
inline as stubs otherwise):
- `packages/content/data/spawn_tables/` — referenced by `encounter`/`wave`
  POI activities
- `packages/content/data/puzzles/` — referenced by `puzzle` POI activities

For v1 these can ship as 2-3 stub entries each, just enough to bake a
working tile. Full content authoring is a follow-up.

Atlas inspector: render the DAG as an overlay on the zone-role view.
Nodes = POI instances at their zone centroids; edges = trinket dependencies;
edge labels = trinket display names. Add a "Quest path" toggle that
highlights one entry→terminal traversal.

Done when: a baked tile carries a non-empty `TileNarrative` with at least
one entry + one terminal; the bridge-check from T-207 means no retry
saturation in 100 sample bakes; the DAG renders in atlas; ten random
tile bakes show at least three distinct dagShapes (linear / branching /
diamond / lattice mix); save+reload reproduces the DAG byte-identical.

### T-210 · Wilderness zones + stairs — yin-yang dungeon model
Effort: L   Status: done   Commit: 3086c6b   Depends on: T-208, T-209

The original Tier-3/6 model treated only open pixels as the playable
surface; closed pixels were uniform walls. Players walked through
corridors and chambers; everything else was background. T-210 reframes
the tile as a **two-class zone partition**:

  PATH zones — open-pixel chambers + corridors. Default-walkable.
    The connective tissue of the tile.
  WILDERNESS zones — closed-pixel blobs (stone / forest / grass
    mound). Elevated plateaus, walkable on their elevated top once
    the player reaches them. Reached only via STAIRS — discrete
    level-design objects gated by trinkets.

Stairs are the materialisation of wilderness-POI gates. When the
matcher selects a POI on a wilderness zone, it computes a stair anchor
(path-pixel adjacent to that wilderness blob, nearest to the blob's
centroid) and emits a `StairInstance` with `lockedBy` pointing at the
upstream POI's trinket. Completing that upstream POI unlocks the stair
and lets the player ascend.

Scope:
- `ZoneRole` enum extended with wilderness roles `crag` / `grove` /
  `thicket` / `hollow` / `outcrop` / `morass` (last reserved for v2 —
  water blobs aren't wilderness yet; bridge mechanic isn't built).
- `AnnotatedZone.traversal: "path" | "wilderness"` first-class field.
- `PoiFit.traversal: "path" | "wilderness" | "either"` filter. Default
  `"path"` for back-compat.
- New types `StairInstance` + `PoiInstance.stairId` in pipeline state.
- `zoneGraph` transformer flood-fills closed pixels (excluding water)
  into wilderness zones alongside the existing open-pixel segmentation.
- Matcher gains a two-phase selection: phase A picks entries first
  (min 2 when target ≥ 4) so the wire phase has thematic-coverage
  options; phase B fills remaining slots. Wilderness POIs are rejected
  if their zone has no adjacent path zone (no stair anchor possible).
- POI roster re-tagged: bossfights / shrines / puzzles / waves /
  exploration → wilderness; encounters / mechanical structures →
  path; cairn_marker / frostshade_hunt → either.
- Inspector palette gains earth-toned wilderness role colours;
  drawTileDag overlays stairs as diamond markers with dashed climb
  paths (red = locked, green outline = found / always-open).

NOT in scope (deferred to follow-up):
- Engine collision update so the player can actually walk onto an
  unlocked wilderness plateau. Currently the heightmap still treats
  wilderness pixels as wall-height (2u) and openMask still blocks.
  The narrative declares the stair-and-zone gating; runtime
  enforcement comes with T-212 (POI runtime).

Done when: zone graph snapshot byte-identical for the new shape (4
re-captured fixtures); 16 atlas tests green including 6 narrative
structural-validity tests; bridge validator passes; inspector renders
stairs + wilderness colours on the POI-network view; happy-path
fraction ≥ 40% across 20 sample tile bakes.

### T-211 · Zone names + client zoneOf transmission
Effort: M   Status: done   Commit: ac343e7   Depends on: T-210

Procedurally name each zone (path or wilderness) from a combination of
biome, topology role, dominant theme of nearby POIs, and an
adjective-noun vocabulary. Examples:
  forest + grove                  → "Whispering Grove"
  swamp + morass (near rotten POI) → "Drowner's Mire"
  stone + crag (near regal POI)   → "Brittlewatch Crag"
  path + crossroads (near martial) → "Bandit's Crossroads"
  path + plaza (near ritual)      → "Sacred Plaza"

Wire the zone list (id + name + topologyRole + traversal) and the
`zoneOf` typed array into `TileInit` so the client can look up the
zone under the player's pixel and display a "you are in: X" caption.
Bumps `BOOTSTRAP_VERSION`. Client tracks `currentZoneId` in a signal,
renders a soft toast on transitions + a persistent caption.

Done when: every zone has a procedural name; client shows "You are in
the X" on entry; transitions fire only on actual zone-id changes
(not every tick); save/reload preserves names byte-identical.

### T-212 · POI runtime + wilderness-stair unlock
Effort: L   Status: in-progress   Commit: 03525ae (v1)   Depends on: T-210, T-211

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
Effort: M   Status: in-progress   Commit: 867766f (v1)   Depends on: T-210

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

### T-214 · LevelDef IR — declarative tile graph + reducer pipeline
Effort: L   Status: done

`LevelDef` is the authoritative semantic structure of a tile: a graph of
`Region | StairEdge | PortalEdge | PoiPlacement | TrinketEdge` with
explicit gameplay invariants (`PlateauRegion.jumpable: false`). Pipeline
stages mutate `state.level` as they compute their slice; the final
state's `level` IS the tile's LevelDef — no post-pass absorber.

**Landed:**
  - `LevelDef` types in `packages/atlas/src/tilemap/level/types.ts` —
    JSON-friendly graph; `emptyLevel()` seeds the pipeline.
  - `PipelineBase.level` threaded through every stage state. The
    inspector's `instrumented_runner` captures `state.level` per stage,
    giving a progressive-build snapshot the UI can layer-toggle.
  - **`zoneGraph` reducer** writes `state.level.regions[]` (path /
    plateau split with `jumpable: false` typed invariant) and
    `state.level.edges.portals[]` (region-anchored).
  - **`poiNetwork` reducer** writes `state.level.narrative.{pois,
    trinkets, dag}` and `state.level.edges.stairs[]` directly.
    Internal `TileNarrative`/`StairInstance` stay as solver scratch
    but no longer escape to pipeline state.
  - Wire format: `TileInitWire.{narrative, zones}` and `TileNarrativeWire`
    deleted. `TileInit.level: LevelDef` is the single semantic carrier.
  - Consumers migrated: `stair_spawner.ts` reads `level.edges.stairs`;
    `poi_spawner.ts` reads `level.narrative.pois`; `atlas_terrain.ts`
    marker/ramp painting reads `level.edges.stairs`; `server.ts`
    `zoneById` built from `level.regions`; inspector POI/stair/DAG
    rendering reads `level`.
  - `buildLevelDef` absorbing translator deleted entirely — its work
    moved into the reducer stages.
  - `verifyLevelInvariants` (`packages/atlas/src/tilemap/level/verify.ts`)
    runs at the end of `generateTile` and asserts: plateau pixels are
    sealed at bake time (openMask=0 — stair unlocks happen post-bake
    in tile-server); every region's zoneId touches `zoneOf`; every
    stair edge resolves to real regions. Throws on violation.

**Tests:**
  - Snapshot determinism gate (`generate.snapshot.test.ts` +
    `zone_graph.snapshot.test.ts` + `poi_network.snapshot.test.ts`) —
    all byte-identical through the migration. `instrumented_runner`
    hash folds in `state.level` content.
  - `level/level.test.ts` — LevelDef invariants pass on real bakes
    (region uniqueness, plateau jumpable: false, stair endpoints,
    POI hosts, portals).
  - `level/verify.test.ts` — invariant assertions catch the three
    violation cases (unsealed plateau, dangling zoneId, missing stair
    endpoint) plus positive + regression-canary cases.
  - `stair_spawner.test.ts` — placeStairs operates on `LevelDef`
    directly.

**Follow-up landings:**
  - Inspector UI controls — layer toggles, stage scrubber, live
    param/seed re-runs, drag-to-reorder pipeline stages — all wired
    on top of the per-stage `state.level` substrate.
  - Region masks — `RegionMeta.pixels: number[]` added; regions own
    their pixel sets, `zoneOf` is derived via `levelToZoneOf(level)`
    on the consumer side, and the parallel wire field is gone.
  - Rasterizer split — `rasterize(state): RasterizedBuffers` is the
    canonical interface. `openMask` and `kindOf` are produced
    directly from `level.regions` (a path-region pixel is open;
    plateau regions stamp their `wallKind` into kindOf). Both stay
    byte-identical to the legacy pipeline output, proving the
    LevelDef encodes the same information.

**Out of scope (future work):**
  - **heightMap rasterizer derivation**. Today the terrain stage
    produces a per-pixel heightMap that adds `params.wallHeight` to
    the biome-modulated floor for closed pixels. To migrate this
    into the rasterizer cleanly, the terrain stage should output the
    raw floor (no wall delta) and the rasterizer should compose
    `heightMap = floor + level.region.wallStep`. Blocked on
    reconciling `params.wallHeight` (per-world config) vs
    `region.wallStep` (currently hardcoded to `WALL_HEIGHT = 2.0`
    in zoneGraph) — they need to agree before the split lands.
  - **materials rasterizer derivation**. Path / plateau / corridor
    materials are currently biome-modulated per-pixel by the
    materials stage. Migrating requires region metadata for
    floor/wall materials. Significant content + tuning surface.

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

### T-225..T-237 · Action as the universal behavior primitive
Effort: XL (multi-ticket arc)   Status: in-progress (T-225 done: `97a20cc`)

See [`ACTION_PRIMITIVE_PLAN.md`](ACTION_PRIMITIVE_PLAN.md) at the repo
root for the full design + migration plan. Summary:

Every character behavior — combat, movement, blocking, dodging,
interacting, throwing, consuming, praying, *being hit* — collapses
into one primitive: an `Action`. Three interlocking pieces:

  - **Slots** — declared per-actor-template (humanoid:
    `[locomotion, primary, posture]`; horseman adds `mount`; etc.).
    Each slot holds ≤ 1 `ActiveAction` at a time. Slot dispatch is
    independent; cross-slot deps via gates.
  - **Actions** — universal content (phases, cancel matrix, per-phase
    movement enum `free|slowed|locked`, costs, priority, effects,
    animation, preconditions, limb targets). Kinds: active, reaction
    (interruptPriority), ambient (perpetual phase). Reused across
    weapons / actors / NPCs.
  - **Gates** — closed-vocabulary typed predicates registered in code,
    referenced from JSON (`has_resource`, `tag_present`, `slot_busy`,
    `equipped_category`, etc.). No expression DSL.

Plan revised 2026-05-15: the `CharacterStateMachine` (the layered
concurrent FSM that already exists) is the structure being absorbed,
not supplemented. Its five jobs unbundle into slots (concurrency),
gates (transitions), tag-installs (output flags), animation-side
rules (paramOverrides), and ambient actions (locomotion/posture).
Maneuvers fold in as multi-effect primary-slot actions. `SwingContext`
folds into resolver-local state inside `weapon_trace`.

Migration phases (each its own ticket; each an atomic commit):

  - T-225 — Action schema + content loader (done — `97a20cc`)
  - T-226 — Engine substrate + locomotion + posture migration. Lands
    as two green sub-commits (recorded exception to the atomic-phase
    rule — the AnimationSystem parity surgery is too risky to weld to
    foundational types in one unreviewable diff):
      - T-226a (done) — substrate: ActionDef schema ext (slot/limbs/
        preconditions/cancel.gates/ActionGate), actorSlots+activeActions
        codecs + wire ids 47/48 + components, entity-generic gate +
        effect registries, ActionDispatcher. 21 tests. Not yet wired
        into the server tick.
      - T-226b (done) — posture migration only (scoped down from
        locomotion+posture: locomotion's sidestep is i_frame/dodge-
        entangled, jump/airborne physics-coupled — deferred to 226c).
        Prefab.actorSlots + inheritance + spawn-install; Crouched tag +
        TAG_COMPONENTS; set_tag/clear_tag resolvers; PostureIntent +
        CompositeIntentResolver; upright/crouched JSONs; posture scope
        contributor; posture layer deleted from humanoid_default + 5
        paramOverrides rewritten csm.posture→posture.crouched;
        ActionDispatcher wired into server.ts. 3 parity tests incl.
        boot-critical CSM compile+scope-validate. Bake byte-identical.
      - T-226c (done) — locomotion migration in 3 green sub-commits:
        c1 ActionAnimation projection schema (clipId/crouchClipId/loop/
        speedScale/mask); c2 9 locomotion JSONs + LocomotionIntentResolver
        (faithful 13-transition port: priority, from-state allow-lists,
        0.5/0.2 hysteresis, dodge guard) + 10 FSM tests; c3
        projectLocomotion (AnimationSystem emits lower-body from the
        slot, mirrors effectiveState+resolveSpeedScale+computeClipTime;
        empty→idle), CSM locomotion layer deleted, posture scope
        contributor + posture.ts deleted (Crouched read directly by the
        projection), CompositeIntentResolver([Posture,Locomotion]) wired,
        8 projection-parity tests. sidestep is a cosmetic placeholder
        until dodge (T-229) gives it proper semantics. Gameplay
        untouched (zero csm.locomotion consumers). Bake byte-identical
        across 11 atlas snapshots.

  **T-226 fully landed.** CSM reduced to right_hand/left_hand/reaction;
  posture + locomotion are action slots; substrate proven by two real
  migrations. Next: T-227.
  - T-227 — Universal swing action library + chain refactor; delete
    ActionSystem + SwingContext + SwingChain + ActionImpulse; CSM
    right_hand + left_hand layers removed (SkillSystem KEPT — its
    on-hit half is a StrikeLanded subscriber, not in the swing path).
    In progress: c1 inert swing library (swing_light/thrust/medium/
    heavy/spin + ranged_shot) LANDED; c2 groundwork (ResolveContext
    .serverTick + dispatcher.prepare) LANDED. c2/c3/c4 are a deep
    multi-session rewire — survey found block/parry lag-comp rewinds
    the CSM right_hand node out of StateHistoryBuffer, and
    health_hit_handler reads SwingContext.pendingSkillVerb directly,
    so retiring those requires StateHistoryBuffer to snapshot
    ActiveActions + hit-handler rewiring. PIVOT (user directive):
    structure over parity — no harness; aggressive rebuild, accept
    retuning/maneuver-breakage (maneuvers rebuilt as actions in T-228).
    DONE — c1 swing library, c2 serverTick, c3a weapon_trace/
    projectile_spawn resolvers, and the flip (PrimaryIntentResolver +
    block/primary_idle actions + Blocking tag + Composite intent;
    deleted ActionSystem/DurabilitySystem/ManeuverScheduler/action
    sm-scope/SwingContext/SwingChain/ActionImpulse + CSM right_hand/
    left_hand; weapon_trace folds durability; AnimationSystem projects
    locomotion+primary; hit handlers rewired). Maneuver/ManeuverLoadout
    kept inert (prefabs load) → rebuilt T-228. Type-clean; 45+33 tests
    green; bake byte-identical. CSM reduced to the `reaction` layer
    only. Accepted regressions (retuned later): feel, lag-comp block
    precision, root-motion, maneuvers, weapon-trail, client predictor.
  - T-228 — DONE (3 green sub-commits). c1: deleted inert maneuver
    machinery (Maneuver/ManeuverLoadout/ManeuverDef/maneuvers data —
    runtime-dead since T-227; ManeuverDef→ActionDef conversion deferred
    to the T-237 skill-loadout work, no content survived to migrate).
    c2: hit-reactions as reaction-slot actions (hit_front/back,
    stagger_light/heavy, death; PendingReaction + ReactionIntentResolver;
    AnimationSystem reaction projection); CSM def emptied. c3: CSM
    fully deleted — system+component, state_machine.ts compiler,
    sm_expression.ts, sm_scope/, StateMachineDef+SM types,
    humanoid_default.json, state_machines/, prefab stateMachineId,
    spawner install, stateMachines registry, AnimationSystem CSM
    coupling, lag-comp csmLayerNodes. Bootstrap 8→9. Type-clean; 49+11
    tests green; bake byte-identical. **CSM eliminated — all behavior
    is the action dispatcher.** Open follow-up: reaction interrupt-
    priority + poise tuning (was the planned T-232 polish).
  - T-229 — DONE. dodge_roll.json (replaces sidestep) — locomotion-slot
    active, locked dash, stamina cost, not_staggered/not_exhausted
    preconditions, dodge_impulse + iframe tag effects. Made the movement
    enum live (PhysicsSystem honours "locked"; replaces Sidestep
    generically + makes swing active-lock real). iframe tag replaces
    IFrameActive; StaminaCostHandler injected (all costs.stamina now
    real). DodgeSystem shrank to CombatTimersSystem (Staggered +
    BlockHeld only — dies at T-232/T-233). Deleted IFrameActive/
    DodgeCooldown/Sidestep. Fixed stale prefab_round_trip test. 166
    tests green; bake byte-identical. Cross-action cancel-into (swing
    windup → dodge_roll) holds via existing matrix.
  - T-230 — DONE. consume.json (primary-slot active raise/ingest/recover)
    + has_edible gate + consume_item effect (actions/resolvers/consume.ts).
    ConsumptionSystem deleted; PrimaryIntentResolver maps ACTION_CONSUME →
    consume. Eating is animation-paced now (1/action vs 1/tick-held;
    accepted retune). interact/pray: nothing to migrate — ACTION_INTERACT
    retired (hover PickUp command), no prayer mechanic exists. 2 consume
    tests + 168 green; bake byte-identical.
  - T-231 — RE-SCOPED (doc only, no code). Premise contradicted by the
    codebase: building construction is ALREADY action-driven (hammer
    swing → weapon_trace → BlueprintHitHandler); blueprint Place is a UI
    command, not a body action; crafting is workstation-state + inventory
    commands with attack/assembly steps already hit-driven. Only the
    time-step countdown is timer-shaped — explicitly folded into the
    T-238 Resource primitive, not force-fit as a player-slot action.
    Forcing a craft/build action shell would add complexity. See
    ACTION_PRIMITIVE_PLAN.md T-231.
  - T-232 — DONE. stagger_light/heavy install the `staggered` tag for
    their play phase (phase duration = stagger window); not_staggered
    gate reads the tag; parry posts PendingReaction:stagger_heavy.
    Networked Staggered component DELETED — def, registry, mod export,
    staggeredCodec/StaggeredData, protocol wire 36 retired. Client
    renders stagger from reaction-slot AnimationState. CombatTimersSystem
    shrank to BlockHeld-only (dies at T-233). Poise-as-Resource +
    poise_available gate is genuinely T-238 (event-posted reactions
    aren't intent-gated) — not duplicated here. 1 stagger test + 168
    green; bake byte-identical. Client codec-decode debt deferred to
    T-236 client pass.
  - T-233 — DONE. Parry window now derives from the held `block`
    action's primary-slot ticksInPhase (block is the sole Blocking-tag
    writer, so its age = how long block held). BlockHeld component
    deleted; CombatTimersSystem deleted entirely (nothing left after
    T-232). The DodgeSystem→CombatTimersSystem→∅ residue is fully gone —
    every combat counter is now an action phase or a tag. 1 block test
    + 169 green; bake byte-identical.
  - T-234 — DONE (scope clarified). BT interpreter + generic NpcAiSystem
    + data-driven wolf already existed (codebase ahead of plan; no
    per-archetype code to delete). Closed the real gap: `request_action`
    BT node + RequestedActions per-slot channel + RequestedActionIntent-
    Resolver (composed last, overrides bit intent) — trees can now name
    ANY action, not just the bit-mapped subset. Job/plan navigation layer
    deliberately kept (not character-action primitives; collapsing it
    would be a T-231-style contortion). 3 BT tests + 173 green; bake
    byte-identical.
  - T-235 — RE-SCOPED (doc only). Substrate verified ready (dispatcher
    entity-generic for slotless children; getParent; spawnPrefab
    children/destroySubtree). But BuffSystem is 3 shapes: periodic DoT
    (fits a buff-child ambient tick), aggregate compose → SpeedModifier
    (that's DerivedStat = T-239, single-writer; N children would race),
    consume-on-use damage hooks (event-shaped). Migrating only DoT
    splits buffs across two live mechanisms — the forbidden parallel
    path. T-235 ∧ T-239 is one replacement: sequenced to land together
    as a single commit that deletes BuffSystem whole. See
    ACTION_PRIMITIVE_PLAN.md T-235.
  - T-236 — SERVER DONE (no code). AnimationSystem already derives every
    layer purely from ActiveActions + tags (landed T-226c/227/228); no
    velocity heuristics / paramOverrides / CSM mirrors remain. Remaining
    work is ~25 lines of client dead-code removal (client_world.ts decodes
    of deleted components + game.ts swing-predictor seed) — deferred to
    the planned scene-view-centric client rebuild, where it's trivial.
    See ACTION_PRIMITIVE_PLAN.md T-236.
  - T-237 — DONE. Mostly already achieved by T-228–234 (ManeuverLoadout
    deleted not renamed — LoreLoadout is it; intent resolution clean;
    bootstrap v9 final; skill→action binding live). Real work: promoted
    registry-dispatch doctrine to CLAUDE.md "Patterns to follow"
    (Discovery 3); brought CLAUDE.md ECS/combat/NPC/animation sections in
    line with the action-primitive end-state (no more ActionSystem/CSM/
    SkillInProgress); fixed last stale code comments. Doc+comment only,
    173 green; bake byte-identical.

**ACTION ARC COMPLETE (T-225–T-237, 2026-05-15.)** CSM/ActionSystem/
DodgeSystem/ConsumptionSystem/CombatTimersSystem and the
Staggered/IFrameActive/DodgeCooldown/Sidestep/BlockHeld components are
gone; all character behaviour is one content action over the
entity-generic ActionDispatcher + gate/effect registries + tags.
T-231/T-235 re-scoped, T-236 server-done (client deferred to the
scene-view client rebuild). Deferred structural pieces (crafting
time-step timer, buff compose) carried by sibling arcs T-238/T-239.

### T-238 · Resource primitive arc (sibling of the action arc)
Effort: XL (multi-ticket arc)   Status: done
Commits: T-238a 6c0590b · T-238b a2410f5 · T-238c c8714d3 ·
T-238d 02d3cc0 · T-238e be1e8e8 · T-238f 50c13d9 · T-238g a88faa1

**Sub-plan: [`RESOURCE_PRIMITIVE_PLAN.md`](RESOURCE_PRIMITIVE_PLAN.md)**
(filed 2026-05-15, action arc complete). Phasing T-238a (inert substrate)
→ T-238b stamina → T-238c hunger/thirst → T-238d poise → T-238e
corruption → T-238f crafting timer → T-238g polish; each a green commit
deleting the system it replaces.
- **T-238a — DONE.** ResourceDef + validator + data/resources/ loader +
  ContentService.resources + bootstrap v10 + Resource component (server-
  only) + ResourceSystem + rate-modifier registry + dedicated
  ResourceEffect registry (Registry<H> doctrine, resource-shaped context
  — honest refinement over "reuse the action ResolveContext") +
  modify_health effect. 5 unit tests + 178 green; inert; bake
  byte-identical. See plan T-238a.
- **T-238g — DONE.** Boot-time cross-ref validation: every ResourceDef
  threshold effect + rateModifier kind checked against the resource
  effect/modifier registries at server boot, fail-fast (mirrors buff /
  recipe-step / BT checks). Bootstrap settled at final v10 (no schema
  bump in d–f; transitional `if (body.buffs)`/`if (body.resources)`
  decode guards removed — version is strictly enforced). CLAUDE.md gained
  a "Universal primitives over one substrate" section (Action + Resource
  done, corruption excised, DerivedStat T-239 next); stale system-order
  and save-contract lines corrected. Arc complete. 183 green;
  byte-identical.
- **T-238f — DONE.** crafting_timer.json (workstation-entity Resource,
  rate -20/s = -1/tick from per-entity-seeded recipe.ticks, bounds.min 0,
  cross@0 -> resolve_recipe). timeStep handler shrank to auto-start only;
  ResourceSystem owns the countdown; new resolve_recipe ResourceEffect
  owns completion (re-derive assignment vs current buffer -> shared
  resolveRecipe / abandon). Design refinement: cross@0 not sustained@0
  (completion is one-shot; cross fires once then parks at 0 without
  re-firing — no "remove resource to stop" dance). DELETED
  WorkstationBuffer.progressTicks (networked codec i32 gone; client
  crafting-progress readout drops, server-only until Resource networking
  — client drifted). 2 tests + 183 green; bake byte-identical (terrain
  untouched; only a wire codec changed).
- **T-238e — DONE (scope changed: removal, not migration).** Project
  decision mid-arc: drop the corruption mechanic wholesale, to be
  reintroduced later at a different scale. So rather than migrate it onto
  the Resource substrate, the whole mechanic is deleted in one commit:
  CorruptionSystem, TileCorruption + CorruptionExposure components (wire
  ids 24/25 retired), the corruption_penalty rate modifier (the T-238b
  bridge — its sole purpose), game_config.corruption, ZoneDef
  .corruptionBaseline + 11 zone JSONs, ZoneCell.corruption (terrain cache
  v2→v3), WorldMapCell.corruptionLevel, the "corruption" DeathCause, and
  every save/handoff/spawn/client touchpoint. Lore flavour + the
  "Corrupted Glade" POI are world narrative (not the mechanic) — kept.
  This moots the plan's closed-rateModifier-vocabulary hinge; equipment
  _stat is now the only shipped modifier. 223 green. Bake intentionally
  changes (corruption was world content, not runtime state — invariant 1
  legitimately N/A here; worlds regenerate from seed).
- **T-238d — DONE.** poise.json (pure regen 12/s, bounds 0..50, no
  modifiers/thresholds — the minimal Resource). Seeded on player+NPC
  spawn; health_hit_handler keeps poise damage + break→stagger-tier,
  now reading/writing Resource.values.poise. DELETED PoiseSystem,
  Poise component, poiseCodec/PoiseData. Accepted retune: the 0.5 s
  regen-disable window is dropped (near-vestigial since break resets to
  max — only bit on a re-hit within the window; dead game_config key
  removed in T-238g). 2 tests + 181 green; bake byte-identical.
- **T-238c — DONE.** hunger.json/thirst.json (cross@80→emit_event
  HungerCritical/ThirstCritical; sustained@100→modify_health starvation).
  emit_event effect shipped. Seeded on player+NPC spawn; consume_item,
  seek_food/water, NpcAiSystem, handoff migrated. DELETED HungerSystem,
  Hunger+Thirst components, hunger/thirst codecs, wire ids 7/8. Accepted
  retune: simultaneous hunger&thirst≥100 → max not sum (deferred-write
  edge). 2 tests + 179 green; bake byte-identical.
- **T-238b — DONE.** stamina.json (rate 8/s + equipment_stat +
  corruption_penalty modifiers); player spawn seeds Resource.stamina
  (NPC parity preserved); spend/staminaValue helpers replace
  deductStamina across cost/skill/gates/hit-handler/debug; handoff
  persists Resource. DELETED StaminaSystem, Stamina component,
  staminaCodec/StaminaData, exhausted flag, wire id 9. corruption_penalty
  is a documented T-238e bridge. Penalty math now multiplicative
  (accepted retune). 2 new tests + 179 green; bake byte-identical. Honest scope (mirrors T-231/T-235):
durability **excluded** (event-decremented, not a tick-rate scalar — a
misfit); health passive-regen **not invented** (none exists; starvation/
corruption damage become threshold effects on those resources); the
`exhausted` flag is **deleted** (= `stamina.value <= 0`); corruption
migrates fully only if the closed `rateModifier` vocabulary holds (no
DSL — the action-arc rule), else partial + honest note. See the plan.

Original framing (kept for context): see the "The unified substrate"
section of [`ACTION_PRIMITIVE_PLAN.md`](ACTION_PRIMITIVE_PLAN.md).
`StaminaSystem`,
`HungerSystem`, `CorruptionSystem`, `DurabilitySystem`, health regen,
and planned poise are one shape hand-rolled 5+ times: a bounded scalar
that changes per tick by a rate, the rate modulated by external
multipliers, crossing named thresholds that fire events / set flags /
couple into another resource. Collapse into a `Resource` component
family + one `ResourceSystem` + content `ResourceDef`
(`{ bounds, rate, rateModifiers, thresholds: [{ at, effect }] }`).
Thresholds dispatch through the **same effect registry the action arc
introduces** — built entity-generic in T-226 specifically so this arc
reuses it. Filed as a sibling so the spine (one substrate,
content-driven primitives, no hardcoded switches) stays visible.
Full sub-plan filed when the action arc nears completion. Depends on
T-226 (effect registry must exist and be entity-generic). **Also
absorbs the crafting time-step timer** (`WorkstationBuffer.progressTicks`)
handed over from the re-scoped T-231 — a workstation-entity timed
process, the canonical degenerate-timer-as-Resource case.

### T-239 · Status/Modifier primitive arc (sibling of the action arc)
Effort: L   Status: done
Commits: plan e458d35/f60d452 · Ph1 9061f7e · Ph2a 433d45e · Ph2b 1966626
The spine is complete: Actions + Resources + Status/Modifier, three
content-driven primitives over one substrate. BuffSystem / ActiveEffects
/ SpeedModifier / EncumbrancePenalty / EncumbranceSystem + the 5 bespoke
effect handlers + 4 sub-registries deleted; one StatModifier record + an
effective() query over a ModifierSource registry; a buff = scene-graph
child + ambient action + buff_timer Resource. Accepted retunes recorded
in STATUS_MODIFIER_PLAN.md. 189 green; bake byte-identical.

**Sub-plan: [`STATUS_MODIFIER_PLAN.md`](STATUS_MODIFIER_PLAN.md)** (filed
2026-05-16; reframed same day). The "DerivedStat" framing put the output
projection first and was rejected: the real need is a **uniform way any
source modifies an entity** (buffs, equipment, environment, posture).
Reframed to a **Modifier record + one `effective(entity,stat)` query
over a `ModifierSource` registry** (hybrid: compose live over existing
stores — equipment from the Equipment component, buffs from scene-graph
children, encumbrance live; no redundant materialized ledger/sync).
Recon corrected two design-doc assumptions (damage hooks already live in
health_hit_handler not BuffSystem; speed is the only composed actor stat
today). One non-phaseable commit deletes BuffSystem + ActiveEffects +
SpeedModifier + EncumbrancePenalty + EncumbranceSystem whole (= T-235 ∧
T-239). Buff = scene-graph child + ambient action + buff_timer Resource
lifetime (all three primitives at once).

See the "The unified substrate" section of
[`ACTION_PRIMITIVE_PLAN.md`](ACTION_PRIMITIVE_PLAN.md). `BuffSystem`
already has a generic `composeRegistry`, but its output is hardcoded to
`speedBonus → SpeedModifier`. Generalize into a `DerivedStat` primitive:
sources register typed modifiers, one composer produces the effective
value, consumers read it. The actor-level dual of `DerivedItemStats`
(which already does this for items). Retire `SpeedModifier`,
`EncumbrancePenalty`, and the per-stat bespoke composition; unify with
`DerivedItemStats` where the symmetry is clean. **Lands together with the
re-scoped T-235 as one commit that deletes BuffSystem whole**: DoT →
buff-child ambient action, speed/compose → this DerivedStat writer,
consume-on-use → damage-pipeline resolvers. The substrate readiness for
the buff-child half is already verified (see ACTION_PRIMITIVE_PLAN.md
T-235); this arc supplies the compose half so there's no split path.

### T-240 · Usable items over the action+effect substrate
Effort: M   Status: done   Commits: Ph1 048c723 · Ph2 5bdf076 · Ph3 766f0b9

"Use an item" is an action, and an item's payload is an `EffectSpec[]`
over the **existing** effect-resolver registry — not a new effect system.
This kills the dead `CommandType.UseItem` → `EquipmentSystem._handleUseItem`
path (destroys the item, applies nothing) and the `consume_item`
slot-rescan, and retires the `edible` component. Subsumes the
`consume`/`UseItem` duplication found in the post-T-239 cleanup sweep.

Principle drawn explicitly: **use = produces a gameplay effect over time
→ action; manage (equip/unequip/move/drop) = rearranges slots → command.**
Only the effect-bearing "use" delegates to the action runtime; the
EquipmentSystem command handlers stay as-is. `usable: { actionId }`
selects the *presentation shell* (animation/timing — eat vs drink vs
read-scroll); the *payload* is entirely the item's effect list. Procedural
items ride the existing **stackable=prefab / unique=entity-instance**
discriminator: unique items carry an `ItemEffects` instance component
(generation writes the list at spawn), stackable read `effects` off the
prefab. No new procedural/fixed concept. The effect registry becomes the
generation vocabulary, so it joins the boot fail-fast cross-check family
(ResourceDef / buff / recipe-step / BT). Wire compat for `UseItem` is
broken freely (client is drift-broken by design, T-…/project memory).

Phases, each a self-contained commit (refactor doctrine — old path dies
in the same commit as the new):

- **Ph1** — generic `use_item` action (primary slot, windup→apply→
  winddown) + `slot_has_usable` gate + `apply_item_effects` edge resolver
  (fans the slot item's `EffectSpec[]` through the shared registry);
  `UseItem` command → `RequestedAction(use_item, {slot})`; **delete**
  `EquipmentSystem._handleUseItem`. `consume` becomes a `use_item` shell.
- **Ph2** ✓ — `ItemEffects` server-only instance component + top-level
  prefab `effects` field (NOT a `components` key — effects are item data
  like `stats`, so the spawn walk never tries to resolve an `effects`
  component / content-load never rejects it); migrated berries (the only
  `edible` prefab) to `effects`; **deleted** the `Edible` component +
  schema + codec + `EdibleData` type (it was dead scaffolding — never
  written to any entity) and the Ph1 `deriveItemStats` synthesis bridge.
  `deriveItemStats` now derives `foodValue`/`waterValue` from the item's
  `adjust_resource` effects, so its DerivedItemStats contract is unchanged
  and NPC food-seeking (`findNearestConsumable`) is untouched.
  **Scope cut, deliberate:** selection stays "first usable slot", not the
  explicit slot `UseItem` names. Per-slot targeting needs a per-action
  param channel the dispatcher lacks (slot would ride
  `ActiveActionState.scratch`, but `start()` seeds none and intent carries
  only an action id). That's a substrate gap, not item-effects work; a
  leak-prone `PendingItemUse{slot}` carrier was rejected as accretion.
  Tracked for a later substrate ticket / Ph3-adjacent.
- **Ph3** ✓ — boot cross-check: every prefab `effects[].id` must resolve
  to a registered action-effect resolver, fail fast at boot (joins the
  ResourceDef / buff / recipe-step / BT family in `server.ts`). `spend_item`
  is now an effect, not a hardcoded step in `apply_item_effects`: a
  consumable lists it (berries does), a **reusable** item (wand/tool)
  omits it and survives the use — covered by tests. Durability/charges
  *can* now be expressed as an item-carried resource + `spend_item`'s
  absence, but the existing `Durability` instance component (combat
  weapon_trace) is **not** migrated here — that's a separate refactor, not
  dragged in (accretion risk). Procedural generator targeting the
  vocabulary remains a separate later ticket — substrate only.

Done: clicking a usable slot runs `use_item`, effects resolve through the
shared registry, food restores hunger via an `EffectSpec`, no `edible`
component / `_handleUseItem` remains, boot fails fast on an unknown item
effect id. 132 action+system+content tests green; server graph type-checks.

Deferred (tracked, not done — deliberate scope edges, not loose ends):
- Explicit per-slot targeting (`UseItem` names a slot): needs a per-action
  param channel the dispatcher lacks. Substrate gap; a leak-prone
  `PendingItemUse{slot}` carrier was rejected as accretion.
- `Durability` → item-resource migration: own ticket when it's worth it.
- Procedural item-effect generation against the vocabulary: own ticket.

### T-241 · Lifetime → Resource (post-T-239 sweep #1)
Effort: S   Status: done   Commit: a97e09e

`LifetimeSystem` decrements `Lifetime.ticks` and `world.destroy`s at 0 —
byte-for-byte the `buff_timer` Resource pattern (`cross@0 →
destroySubtree`) the T-239 buff arc already runs. A parallel countdown
mechanism the refactor doctrine says shouldn't survive. From the
post-T-239 sweep (#1, the cleanest win): a bounded tick-scalar *is* a
`ResourceDef`.

- `data/resources/lifetime.json` — mirror `buff_timer` (rate -20 = -1/tick
  at 20Hz, `cross@0 → destroy_self`); per-entity max seeded at spawn.
- `destroy_self` ResourceEffect — `world.destroy(entityId)`. Distinct from
  `expire_buff`'s `destroySubtree`: a projectile is not a buff and has no
  subtree; honest leaf name. Boot cross-check is automatic (the existing
  ResourceDef threshold-effect check in `server.ts`).
- The only `Lifetime` writer (`ProjectileSpawnResolver`) writes
  `Resource{ lifetime }` instead. `LifetimeSystem` deleted; `Lifetime`
  component retired (wire id 12 → retired comment, never reused — it was
  networked but only server-transient projectiles carried it; the client
  renders projectiles from Position/ProjectileData, never needed it).

Done: projectile expiry is `ResourceSystem` + `destroy_self`; `Lifetime`
component + `LifetimeSystem` + `lifetimeCodec` gone; wire id 12 retired;
server graph type-checks; 180 tile-server+content tests green (incl. a new
lifetime cross@0→destroy_self test). Also swept up a Ph2 leftover the
narrower Ph2 test scope missed: `prefab_round_trip.test.ts` still imported
the retired `Edible` — deleted here (same "retire a component" shape).
Same accepted ≤1-tick retune as every other Resource migration.

### T-242 · ResourceNode respawn timer → Resource (post-T-239 sweep #4)
Effort: S   Status: done   Commit: 52f2647

`ResourceNodeSystem` exists only to decrement `respawnTicksRemaining` and
restore the node at 0 — the same timer→Resource shape as Lifetime/buff.
The node's *hitPoints* stay on `ResourceNode` (hit-driven, not a tick
scalar — correctly bespoke); only the respawn countdown migrates.

- `data/resources/respawn_timer.json` (rate -20, `cross@0 →
  respawn_node`). `respawn_node` ResourceEffect restores the node from its
  prefab `resourceNode.hitPoints` (what the system did) and drops the
  spent timer value.
- `ResourceNodeHitHandler`: on deplete-with-respawn, set `ResourceNode
  {hitPoints:0, depleted:true}` + write `Resource{ respawn_timer }`
  instead of stamping `respawnTicksRemaining`. Non-respawning nodes still
  `world.destroy` (unchanged) — so `depleted:true` now always coexists
  with an active timer; the `respawnTicksRemaining` field is dead and
  removed from the component + its networked codec.
- `ResourceNodeSystem` deleted; server wiring removed. Boot cross-check
  automatic via the existing ResourceDef threshold-effect check.

Done: depleted nodes respawn via `ResourceSystem` + `respawn_node`;
`ResourceNodeSystem` + `respawnTicksRemaining` + its codec field gone;
server graph type-checks; 181 tile-server+content tests green (incl. a new
respawn_node test). One honest substrate edge, recorded in the effect
header: the spent `respawn_timer` can't be deleted from inside the effect
(ResourceSystem is the single Resource writer and commits its own
post-integration write after the effect that tick — deferred-write
clobber, same reality as item_use's adjust_resource). It's left pinned at
0, which is inert (clamped at min; `cross@0` never re-fires with prev
already in-zone); the hit handler overwrites it on the next depletion. No
leak, no bespoke cleanup.

### T-243 · Projectile flight → ambient action (post-T-239 sweep #5)
Effort: L   Status: done   Commit: ef61011

`ProjectileSystem` is a bespoke per-tick System that duplicates the
`weapon_trace` shape (sweep a volume this tick → broad-phase → intersect →
dedup → `HitContext` → handler chain → HitSpark) and adds a third gravity
integrator beside PhysicsSystem and ItemPhysicsSystem. A projectile is a
real world entity with physicality, not a particle — so under the action
doctrine its flight belongs *on* the substrate, not beside it. The
substrate was built for this: `ActionDispatcher` already advances ambient
actions on any entity carrying `ActiveActions` with no `ActorSlots`/intent
(the buff-child precedent, T-239). Lifetime already migrated (T-241).

- `data/actions/projectile_flight.json` — ambient action, slot `flight`,
  one perpetual phase `hold` (`ticks: -1`), effect
  `{ phase: "hold:tick", kind: "projectile_trace" }`. Mirrors `buff.json`.
- `projectile_trace` EffectResolver (`actions/resolvers/projectile.ts`) —
  lifts `ProjectileSystem.run`'s per-projectile body into a single-entity
  `resolve(ctx)`: ballistic step → terrain collision → broad-phase over
  `query(Hitbox, Position)` + distance cull (same shape as weapon_trace's
  candidate loop; no spatial-grid threading into the effect layer) →
  `testHitboxIntersection` → dedup via `ProjectileData.hitEntities` →
  shared `HitHandler[]` chain (unchanged) → `world.destroy` on terrain hit
  / maxHits. Constructed with `(hitHandlers)`; gravity + terrain from
  `ctx.content` / `ctx.world`.
- `ProjectileSpawnResolver` additionally seeds the ambient action at spawn
  (`states: { flight: { actionId: "projectile_flight", phase: "hold",
  ticksInPhase: 0, initiator: "ambient" } }`) — verbatim buff-spawn shape.
- `ProjectileSystem` + `systems/projectile.ts` deleted; removed from the
  server pipeline.
- Doctrine gap closed: add a boot cross-check that every `ActionDef`
  effect `kind` resolves to a registered action-effect resolver (today
  weapon_trace/buff_tick/projectile_trace only fail at dispatch). Covers
  the new effect fail-fast, same stance as the ResourceDef/recipe-step/BT
  checks.

Non-goal (follow-up): deduping the sweep core *shared* with weapon_trace.
This sweep moves projectile flight onto the substrate; weapon_trace keeps
its lag-comp snapshot path untouched. Extracting one `traceAndDispatch`
both call is a separate, lower-risk cleanup once both live as effects.

Note: projectiles now carry the networked `ActiveActions` (wireId 48), so
one small extra component crosses the wire per in-AoI projectile — correct
(a projectile *is* an entity) and inert for the client.

### T-244 · DRY the weapon_trace / projectile_trace sweep tail
Effort: S   Status: done   Commit: f4c2b0c

The T-243 non-goal, landed. `weapon_trace` (melee) and `projectile_trace`
(ranged) carried two copies of the same dispatch tail: once a candidate
target is in hand, both `testHitboxIntersection` → publish `HitSpark` →
run the shared `HitHandler[]` chain, building a near-identical
`HitContext`. The genuine difference is everything *before* (candidate
source, exclusions, broad-phase) and a handful of `HitContext` fields
(attackerPart, weaponStats, parry, skillVerb, coordinates) — not the tail.

- `combat/sweep.ts` — `dispatchSweepHit(world, events, handlers, hitbox,
  targetPos, targetFacing, radius, segments, buildContext)`: tests the
  swept volume, and on contact builds the context (caller's closure),
  fires `HitSpark` at the context's hit point, runs the handler chain,
  returns the intersection (so callers record dedup / count hits). The
  pure geometry test stays in `hit_resolver.ts`; this is the events +
  dispatch layer on top.
- Both resolvers' inner loops now call it. HitSpark position is read back
  off the built context (`hitX/Y/Z`), so melee's blade-contact point and
  ranged's trajectory-end point both flow through unchanged — byte-for-byte
  the prior behaviour. Each caller keeps its own loop (the control flow
  genuinely differs: melee hits every target in arc; ranged breaks +
  destroys at maxHits), so this DRYs the shared tail without forcing a
  unified loop the two don't actually share.

Done: one copy of the test→spark→dispatch tail; server graph type-checks;
185 tile-server+content tests green (incl. the melee weapon-trace suite and
the T-243 projectile tests, both exercising the shared path).

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

### T-068 · Client content cache — IndexedDB
Effort: M   Status: todo

Raw model definitions received from the server are persisted to IndexedDB keyed by
`(modelId, version)`. On subsequent page loads, known models are served from cache; the server
is only queried for unknown or newer versions.
Done when: a page reload reuses cached models without re-requesting them from the server.

### T-069 · Model request via reliable WebTransport stream
Effort: S   Status: todo

Client requests model definitions via the same reliable WebTransport stream as game state.
No separate HTTP endpoint. Server responds with a `ModelDefinition` message on that stream.
Done when: model requests and game state share one connection; no HTTP fallback exists.

### T-070 · Render placeholder for unknown modelId
Effort: S   Status: todo

When an entity with an unknown `modelId` arrives, render a bounding-box placeholder immediately.
Replace with real geometry when baking completes (T-067). Never block the game loop.
Done when: new entities always appear immediately as boxes; real model swaps in without a pop.

### T-157 · Fog of war + LOS + minimap
Effort: L   Status: done   Commit: HEAD

Exploration tracking split across client and server.  The world is dark
by default; the player's line-of-sight reveals it.  Once seen, a cell
stays "explored" (dim) for the rest of the session.  Currently-visible
cells (the LOS arc in front of the player) render at full brightness.

Data is split by lifetime:

  - **`seenEver`** lives on the **server** — authoritative, persistent,
    can survive reconnects.  Per-player bitmap of explored fog cells.
  - **`currentlyVisible`** stays on the **client** — too ephemeral to
    network at 20 Hz; the client recomputes it each frame from `OpenMask`
    and the player's facing.

Resolution: 256×256 fog cells over the 512-unit tile (one fog cell per
2×2 world units).  Bit-packed to **8 KB per (player, tile)** on the wire
and on disk.  2u matches wall thickness (T-156) so the resolution drop
isn't visible.

Shared constants in `@voxim/protocol/src/fog.ts`:
`FOG_GRID_SIZE = 256`, `FOG_CELL_SIZE = 2`, `FOG_GRID_BYTES = 8192`,
`LOS_HALF_ANGLE_RAD ≈ 0.96`, `LOS_RADIUS = 40`, `LOS_RAY_COUNT = 110`,
`LOS_STEP = 0.5`.  Both sides import these — no drift possible.

Server (`packages/tile-server`):
  - `components/fog_state.ts` — server-only component: bit-packed
    `Uint8Array(FOG_GRID_BYTES)`, plus a `revealedThisTick: number[]`
    queue of newly-set cell indices (drained by the send path each
    tick).
  - `systems/fog_of_war.ts` — runs each tick.  For every player entity
    with `FogState`, casts the LOS cone in world-unit ray steps and
    marks fog cells.  Reads `OpenMask` from terrain chunks for
    occlusion; rays stop at closed cells.  New bits are pushed to
    `revealedThisTick`.
  - `aoi.ts` / `server.ts` — embeds fog data inside `BinaryStateMessage`:
    full snapshot on the first tick the client sees (cleared after
    send), reveal list on every subsequent tick that has new cells.

Wire format additions to `BinaryStateMessage`:
  - `fogSnapshot: Uint8Array | null` — 8 KB bit-packed bitmap, set only
    on the first message after join.
  - `fogReveals: Uint16Array` — newly-revealed fog cell indices as u16
    (256² = 65536 fits exactly).

Client (`packages/client`):
  - `state/fog_of_war.ts` refactored: `seenEver` is bit-packed and
    server-driven (applied via `applySnapshot`/`applyReveals`).
    `currentlyVisible` stays client-computed at 256² resolution (matches
    server grid).  Texture upload from packed bits: pack three states
    (unseen/seen/visible) into the R8 channel for the shader.
  - `connection/tile_connection.ts` and `game.ts`: forward fog fields
    from BinaryStateMessage into FogOfWar.

Persistence (deferred to follow-up): bitmap saved per (playerId, tileId)
to the account service or a tile-local file.  In-memory only for now —
fog resets on tile-server restart, but survives client refresh during
one server lifetime.

Renderer (`packages/client/src/render/edge_pass.ts`): unchanged shader
math; just samples the new 256² fog texture instead of 512².

UI (`packages/client/src/ui/components/Minimap.tsx`): 200×200 canvas in
the top-right.  Reads the bit-packed grids from `FogOfWar` and draws
the player marker.  Throttled to ~10 Hz.

Done when: world is black on first connect; walking forward reveals a
cone-shaped trail that stays dim behind the player; the LOS arc in
front is full-bright; closed cells (walls) block the cone; the minimap
top-right shows the same explored shape; on client refresh the player
sees their previously-explored area immediately on join (server-driven
snapshot).

### T-159 · River cells render as translucent water
Effort: S   Status: in-progress

Atlas marks rivers/ponds with `BOUNDARY_KIND_WATER` and they're already
closed in `OpenMask`, but visually they used to be just flat blue cells —
nothing said "water".  Two changes:

  - `atlas/.../terrain.ts`: WATER cells now drop to `floor - RIVER_DEPTH`
    (0.5 world units below floor) instead of staying flat.  Rivers carve
    a shallow trench.  STONE / FOREST / GRASS_MOUND walls still rise by
    `wallHeight`; OPEN cells unchanged.
  - `client/render/water_renderer.ts` (new): per-chunk translucent surface
    mesh at the original floor height (`heights[idx] + RIVER_DEPTH`) over
    every WATER cell.  One shared `THREE.ShaderMaterial` with a `uTime`-
    driven sin/cos wave pattern in the fragment shader — three crossed
    bands plus a sparkle highlight.  Subscribes to `ClientWorld.onChunkKinds`
    (same hook ForestPropsRenderer uses) and pulls the heightmap out of
    `ClientWorld` (new `getHeightmapData` accessor).

`RIVER_DEPTH = 0.5` is duplicated in the client mirror with a cross-
referencing comment (atlas isn't a client dep).  Per-frame `uTime` pump
runs from `game.ts` next to the renderer call.

Done when: rivers render as visibly recessed channels with an animated
translucent water surface above them; the bed (mud material) shows
through the water; the surface ripples gently at game speed.

### T-160 · First POI primitive: room + mob placement in chambers
Effort: M   Status: in-progress

Empty chambers feel pointless.  Atlas already detects discrete pre-network
chambers (T-152/155 — `TileInit.chambers`); this ticket gives each chamber
a deterministic chance of being a "point of interest".

Two POI types, deliberately primitive (the user spec was "first primitive"):

  - **mob POI** (40 % roll): 3 random NPCs spawn near the chamber centroid.
    Pool = `["wolf", "bandit", "archer"]` (whatever's in `content/npcs/`).
    Re-derived every boot from `(tileSeed, chamberId)`; NPCs aren't
    persisted (consistent with `procedural.spawnInitialNpcs`).
  - **room POI** (25 % roll): a 5×5 wooden enclosure stamped directly into
    the terrain buffers (closed `openMask`, raised `heights`, wood
    `material`, stone `kind` to suppress forest decoration).  One cell on
    the south wall is left open as a doorway.  Stamping happens BEFORE
    `chunksFromBuffers` so the walls are part of the world from boot.
  - 35 % empty.  Tiny chambers (<25 pixels) skipped outright.

Implementation entirely in `tile-server`:
  - `atlas_terrain.ts` exposes `chambers` on its result (world-unit
    centroids passed through from `TileInit`).
  - `poi_placer.ts` (new): `placePois(buffers, chambers, seed, woodId)`
    mutates buffers in place for room POIs and returns a list of mob
    spawns; `spawnMobPois(world, content, mobs)` instantiates them after
    chunks are committed.
  - `server.ts` calls both on the no-save boot path, between
    `loadTerrainFromAtlas` and `chunksFromBuffers` (room) and after
    `procedural.spawnProceduralProps()` (mobs).

Atlas-side `Feature[]` typing is intentionally out of scope — the
placeholders in `TileInit.features` stay `unknown[]` for now.  When the
POI system grows past "first primitive" it'll move into the atlas
pipeline so layouts are part of the persisted bake.

Done when: walking through a freshly-baked tile reveals empty rooms,
small wood-walled enclosures with a south door, and chamber clusters of
3 hostile NPCs scattered across the map — same layout on every restart.

### T-161 · Persist fog of war across sessions
Effort: M   Status: in-progress

T-157 left fog as ephemeral in-memory state — refresh / disconnect
discarded the whole exploration map.  This ticket lifts `seenEver` to
durable storage so reconnects start with the player's prior progress.

Persistence shape:
  - DB: `user_tile_fog (user_id uuid, tile_id text, bitmap bytea,
    updated_at timestamptz)` keyed by (user, tile).  Migration
    `0013_user_tile_fog.sql`; repo `PgUserTileFogRepo` mirrors the
    `PgHeritageRepo` upsert pattern.
  - Account service: two new endpoints under `/internal/user/:id/fog/:tileId`
    — `GET` returns the bitmap as `application/octet-stream` (404 if none),
    `PUT` writes the request body verbatim.  Service-secret gated like the
    other internal routes.
  - `AccountClient.getFog(userId, tileId)` / `saveFog(userId, tileId, bitmap)`.
  - Tile-server: after spawning the player, fetch fog and copy into
    `FogState.seenEver`; `pendingSnapshot` stays `true` so the next state
    message ships the hydrated bitmap to the client.  On disconnect (alive
    OR dead, before `world.destroy`), save the current `seenEver` back.
    Handoff path is intentionally not yet handled (rare in current dev mode).
  - Dev mode (no `accountClient`): noop — fog stays per-process as before.

Concurrency / size: 8 KB per (user, tile).  Upsert each disconnect — at
human play frequencies that's well under any DB pressure.  Buffer is
opaque to Postgres; the account service trusts what tile-server writes.

Done when: explore part of a tile, log out, log back in, the explored
area is immediately visible on join.  Tile-server logs `fog restored`
on hydration and surfaces save errors without blocking disconnect cleanup.

### T-163 · Weapon damage in prefab data + per-entity soft collision + floating names + HUD diagnostics
Effort: M   Status: done

Four small features bundled because they all flowed out of the same play
session.  Each is self-contained but the user noted them together, and
splitting hindsight tickets one-per-commit would just be ceremony.

**Damage on hit.** `deriveItemStats` in `packages/content/src/store.ts`
read `weight`, `armor`, `edible`, `illuminator`, `tool` from prefab
components but never `swingable` — so every equipped weapon's
`weaponStats.damage` was undefined and the `?? 0` in
`HealthHitHandler` zeroed every connected hit.  Unarmed worked because
it pulls from `gameConfig.combat.unarmed.damage` directly.

Fix:
  - Added `damage?: number` to `SwingableData` (types + valibot schema +
    server-only Swingable codec, with a presence byte so absent and
    explicit-zero round-trip distinctly).  Round-trip test got two new
    cases.
  - `deriveItemStats` now reads `swingable.damage` and exposes it as
    `stats.damage`, scaled by per-instance `quality`.
  - Populated all melee weapon prefabs with sensible base damages:
    stone_axe 12, stone_pickaxe 9, stone_hammer 14, iron_axe 22,
    iron_pickaxe 16, iron_sword 25.  `wooden_bow` left damage-less —
    bow_shot is projectile-driven, not melee.
  - Crafted iron items still carry per-instance `Stats` from the recipe
    formula (`head.sharpness * 30 + workstation.quality * 5` etc.); the
    prefab damage is the fallback.  Wiring an instance-Stats override
    into `ActionSystem` is a future ticket.

**Player ↔ entity soft collision.**  `PhysicsSystem` previously only
collided with terrain.  Reworked into a three-pass loop:

  1. Integrate every (Position + Velocity + InputState) entity into a
     local `Step[]` array (the existing per-entity body, just
     extracted).
  2. Pairwise XY separation — overlapping pairs each get pushed half the
     overlap along the connecting axis.  Pure position correction; no
     velocity damping (next-tick physics naturally re-runs).
  3. Commit the corrected positions via `world.set`.

  Brute-force O(N²) is fine: physics-active entities cap at < 100 in
  AoI; SpatialGrid would only pay off at much higher densities.  Radius
  is `gameConfig.physics.entityCollisionRadius` (0.4).  Z is untouched
  so jumping over entities still works.  Degenerate exact-overlap pairs
  are nudged along +X for determinism.

**Floating name labels.**  New networked `Name` component
(`ComponentType.name = 44`, `nameCodec` in `@voxim/codecs`).  Players
get their login name shipped via the new optional
`TileJoinRequest.displayName` field (client caches it under
`voxim.login_name` at sign-in); NPCs mirror their `NpcTemplate.displayName`
into `Name` at spawn.  Empty / missing names fall back to a
`Player-{id6}` stub on the server.  Client renders one camera-billboarded
`THREE.Sprite` per labelled entity, parented to the entity mesh group at
y = 2.2 with a translucent rounded-pill canvas texture.  Texture is
regenerated only on text change.  `disposeEntityMesh` and
`syncNameLabel` keep the sprite lifecycle pinned to the mesh's.

**HUD diagnostics.**  `BinaryStateMessage` gained one trailing u16,
`onlineCount`, sourced from the tile's session map.  Game.ts patches it
into a new `uiState.hudStats` slice plus a 500 ms-windowed FPS counter.
A small `HudStats` Preact component sits to the left of the minimap
(`top: 12, right: 220`), styled to match the minimap chrome.

Done when: starter stone_axe deals 12 damage, two players can't walk
through each other, every entity has a label above its head, and an
`fps / online` panel sits next to the minimap.

### T-162 · Geometric edge detection in `EdgePass`
Effort: S   Status: done

The Sobel pass in `edge_pass.ts` ran on luminance, normalised by local
mean brightness so day/night fired equally hard.  Side effect: the
±8 % per-cell brightness hash on terrain (`cellVariation` in
`terrain_mesh.ts`) became visible as diagonal dot rows on flat ground —
the normalised gradient on dark cells easily cleared `lumThreshold`,
and the 1-unit cell grid projects to ≈45° under the isometric camera.

Replaced with a depth-only detector that ignores colour entirely:
  - Sobel on linearised view-space depth (= -view.z), normalised by
    centre depth so a 1-unit step looks the same near and far —
    catches silhouettes against the background and terrain height steps.
  - 1 - cos(angle) between four "quadrant" view-space normals
    reconstructed via cross-products of asymmetric position derivatives
    (R/L × U/D) — catches creases between faces of different orientation.
  - `max(edgeD, edgeN) * edgeStrength` — whichever fires harder wins.
  - Sky pixels (depth ≥ 0.9999) skip the whole block; `vpos()` would
    explode there.

Tunables on the material are now `uDepthThreshold` (default 0.04 ≈
1-unit z-step at typical cam distance) and `uNormalThreshold` (default
0.10 ≈ 25° crease).  `lumThreshold` and the `luma()` helper are gone;
no other code referenced them.

Done when: flat terrain has no diagonal artifact rows, but building
silhouettes, terrain height steps, and corner creases still outline.

### T-164 · InstancePool refactor — Phase 1: primitive + voxel-geo extraction
Effort: M   Status: done   Commit: 21daefd

First of four phases that move all procedurally-placed instanced
rendering (forest decorations, server props, future rocks) onto a
single CPU-culled pool keyed by archetype.  Motivated by a 2026-05-07
profiling session: 1 327 draws / 2 M tris per frame, 23 ms GL, with
forest alone responsible for 7 936 InstancedMesh nodes covering
204 k instances (~25 instances/draw, well below the instancing
break-even).  Full design in `INSTANCE_POOL_PLAN.md` at the repo root.

This phase lands the primitive with no callers yet.

  - Extract `buildSubModelGeo`, `buildLocalDispGeo`, `mergeGeos` from
    `packages/client/src/render/prop_instance_pool.ts` into a new
    `packages/client/src/render/voxel_geo.ts`.  Update the imports in
    `prop_instance_pool.ts` and `forest_props.ts`.  No re-export
    bridge — the helpers' new home is the only home.
  - Add `packages/client/src/render/instance_pool.ts` exporting an
    `InstancePool` class with the API in the plan (`registerArchetype`,
    `add`, `remove`, `removeByPrefix`, `update`, `buildHoverShells`,
    `dispose`).  InstancedMeshes constructed by the pool use
    `frustumCulled = false`; visibility is owned by the pool, not
    Three.js.
  - Wire `this.instancePool = new InstancePool(this.scene)` in
    `GameRenderer`'s constructor and call `this.instancePool.update(visibleChunks)`
    inside `render()` just before the existing terrain-visibility loop
    is reused to compute the visible-chunks set.

Done when: `deno check packages/client/src/game.ts` passes; the game
runs and renders identically to before; the HUD draw/tris numbers are
unchanged because the new pool has zero handles.

### T-165 · InstancePool refactor — Phase 2: forest_props migration
Effort: M   Status: done   Commit: 21daefd

Rewrite `packages/client/src/render/forest_props.ts` so it registers
archetypes and per-tree handles into the InstancePool from T-164
instead of building per-chunk InstancedMeshes itself.

  - `decorateChunk` walks the kinds grid as today, but for each tree
    contribution it (a) calls `instancePool.registerArchetype("forest:" + def.id + "|" + matId, …)`
    once per (sub-model × material) pair, then (b) emits one handle
    per tree position keyed `"forest:cx,cy:lx,ly"` whose chunkKey is
    `"cx,cy"` and whose slots are the world matrices for each part.
  - Delete `geoCache`, `matCache`, `chunkMeshes` from the class — the
    pool owns them now.
  - `reset()` becomes `instancePool.removeByPrefix("forest:")` plus
    the existing `decorated`/`queue`/`active` cleanup.
  - The chunk-arrival queue and `start()`'s 8 ms-budget drain loop
    are preserved.

Done when: forests render pixel-identically (same trees, same
positions, same shadows, same canopyFade); HUD draws drop ~10× (660 →
~60 per pass); HUD tris number unchanged (same content, batched
differently); tile transition still cleans up the previous tile's
forest correctly.

### T-166 · InstancePool refactor — Phase 3: prop_instance_pool deletion
Effort: M   Status: done   Commit: 21daefd

Delete `packages/client/src/render/prop_instance_pool.ts` entirely.
Server-prop entities (ground items, ruins, resource nodes) register
with the InstancePool directly.

  - The static-prop branch in `GameRenderer.updateEntity()` (the
    `else` after the skeleton branch) registers archetypes via the
    pool, builds slots from the resolved sub-objects, and calls
    `instancePool.add(entityId, chunkKey, slots)` where `chunkKey =
    floor(worldPos.x / 32) + "," + floor(worldPos.z / 32)`.  Removal
    on entity destroy / AoI exit is `instancePool.remove(entityId)`.
  - The VELOCITY_EPSILON_SQ defer-until-settled gate is preserved
    verbatim.
  - `HoverOutlineRenderer` calls `instancePool.buildHoverShells(entityId)`
    instead of `propPool.buildHoverShells(entityId)`.  Behaviour
    identical: wrapper Meshes share pool-owned geometry/material and
    must not be disposed on cleanup beyond the wrapper itself.
  - `propPool` field on `GameRenderer`, `getPropPool()`, and every
    other reference to `PropInstancePool` are removed.
  - `propPositions.set(entityId, worldPos)` and the
    `interactionSystem.addStaticEntity(...)` registration stay where
    they are — pick-box handling is parallel to the pool, not part of
    it.

Done when: ground items, ruins, and resource nodes render with the
same position and rotation as before; hover outline still highlights
static props; no references to `PropInstancePool` or `prop_instance_pool.ts`
remain; HUD shows the prop_pool bucket folded into forest archetypes
or its own archetypes (down from 6 always-on draws to per-frame slice).

### T-167 · InstancePool refactor — Phase 4: perf validation + plan cleanup
Effort: S   Status: done   Commit: HEAD

Closeout for the four-phase refactor.  Numbers measured on the
user's machine in a forested area with shadows on:

  - **Before** (35 FPS): 1 327 draws, 2.07 M tris, 23 ms GL,
    7 936 forest InstancedMeshes (25 instances/draw average), the
    old `prop_instance_pool.ts` rendering all 4 096 slots every
    frame with `frustumCulled = false`.
  - **After**  (58 FPS): 421 draws, 2.5 M tris, 12.1 ms GL, 0.3 ms
    skeleton+IK, ping 25 ms, tick 20.0 Hz, 5 256 InstancePool
    handles spread across one InstancedMesh per archetype.

The 5×5 chunk window for InstancePool culling — 2-chunk radius
around the player — covers both the 120-unit shadow camera frustum
and the main camera's forward cone with no popping.  Terrain stays
at 9×9 since terrain meshes are cheap and a tighter window would
seam-pop visibly on flat ground.

The HUD diagnostics that drove the investigation stayed in: per-
section ms breakdown (sk+ik / trail / gl / post), draws and tris
counters, the "Bypass post-FX" / "Shadows" toggles, and the
`Log scene census` button.  A second commit (a5675f1) added
network and scene stats — ping, input lag, server tick rate,
inbound kbps, entity count, InstancePool handle count — to round
out the diagnostic surface.

Plan document `INSTANCE_POOL_PLAN.md` deleted in this commit.

Done.

### T-168 · Basic-item detail pass via per-prefab `modelScale`
Effort: M   Status: done

Sweep over hand-held items and small pickups: re-author every voxel
model at finer resolution and set `modelScale` on the prefab so the
physical size stays the same.  Hero weapons (sword, spear, bow,
crossbow) drop to `modelScale 0.25–0.33` (3–4× more voxels per axis,
enough to suggest a fuller, crossguard, recurve limbs, prod + string +
stirrup).  Tools and resources drop to `modelScale 0.5` (2× per axis).

  - Split shared models so iron and stone variants look different:
    `model_axe_basic` becomes the iron axe; new `model_axe_stone` and
    `model_pickaxe_stone` carry stone heads with leather binding.
  - Add prefabs for `iron_spear` (uses existing `thrust` action) and
    `wooden_crossbow` (uses existing `crossbow_shot`).  Add `model_bolt`
    (shorter than an arrow, broader head) and point `crossbow_shot`'s
    projectile at it instead of `model_arrow`.
  - Hitbox is auto-derived from voxels — no `hitbox` field in the
    refreshed model files.

Done when: every item under `prefabs/items/` has a `modelScale` set;
sword/spear/bow/crossbow render with recognisable detail; iron and
stone tool variants look distinct; `deno task gen-content` and
`deno check` are clean.

### T-169 · Human animation polish + walk-style variants
Effort: M   Status: done

Refresh every existing clip on the `human` skeleton with denser
keyframes (more in-betweens through each cycle) and asymmetric
secondary motion: idle gets a real breath cycle and slow weight
shift; walk gets heel-strike dorsiflexion, hip drop, counter-shoulder
roll, head bob and wrist follow-through; crouch + crouch_walk get a
slight asymmetric stance and listening head turn; roll picks up a
recovery overshoot before settling; death staggers torso/head timing
and adds a sideways head loll.

Add three locomotion variants for character / state expression:
  - `walk_slouch`: forward-tipped torso, head down, short stride,
    minimal arm swing — defeated / weary.
  - `walk_boast`: chest puffed back, head tilted up, exaggerated
    stride and shoulder roll — confident / threatening.
  - `walk_limp`: asymmetric stride favouring the left leg, right leg
    dragging, side-tilt toward injured side — wounded.

Wire `walk_limp` automatically: AnimationSystem picks it instead of
`walk` when `Health.current / Health.max < 0.30`.  `walk_slouch` and
`walk_boast` are authored content for future NPC archetypes / scripted
moments — they don't change behaviour by themselves.

Done when: idle and walk look noticeably more alive; a player at
< 30% health limps without further wiring; `deno check` is clean.

### T-170 · Held-weapon grip anchor + roll Y-lift + A/D fix
Effort: S   Status: done

Three independent bugs surfaced once T-168/T-169 were in front of the
camera:

  - **Weapons held wrong.**  Item models had `z=0` at the pommel/butt,
    so the renderer (which anchors the model origin at the wrist)
    placed the wrist at the END of the weapon and the blade extended
    a full 2m past the hand.  Re-author every held model so model
    `z=0` sits inside the grip — pommel/butt go into negative z, blade
    extends into positive z.  `bladeDimensions.length` (`maxZ*scale`)
    now correctly measures grip-to-tip.

  - **Dodge roll dipped through the floor.**  Animation tracks rotate
    bones but cannot translate the root, so a full forward somersault
    around the feet pivot swings the head below ground.  Renderer now
    reads the active "roll" layer's `time` and adds a `sin(πt) ·
    1.6 · modelScale · weight` Y offset to the entity group's position
    so the body clears the ground at mid-roll.  Stored on
    `EntityMeshGroup.rollLiftY`; applied to both the local-prediction
    and remote-interpolation position writes.

  - **A and D were swapped.**  The right-vector formula was
    `(sin f, -cos f)` (clockwise of facing in math-y-up convention),
    but with the top-down camera using world +Y as screen-up, that
    sent strafe-D into the screen-LEFT direction.  Flipped to
    `(-sin f, cos f)` so `D` strafes to the player's visual right and
    `A` to the left.

Done when: a held sword visibly hangs from the grip not the pommel; a
forward roll stays above ground; pressing D moves the player to the
right of where the cursor points.

### T-171 · Animation library + per-prefab slot assignment + devtool
Effort: L   Status: done

Three layers landed together:

  - **Animation library.**  `packages/content/data/anim_library/` —
    one file per clip.  Two file shapes: plain (`AnimationClip` +
    `_skeleton`/`_source`) and compound (`_kind: additive | crossfade
    | phase_shift` + recipe).  Compounds get **baked into plain clips
    at content load**, so `AnimationSystem` and the bone evaluator
    stay unchanged — no runtime support for compound clips needed.
    Library clips with the same `id` as a skeleton's inline clip
    override the inline one (that's how the devtool import workflow
    swaps a hand-authored `walk` for an imported one).  Loader work
    lives in `packages/content/src/anim_library.ts`.

  - **Per-prefab slot indirection.**  New `Prefab.animationSlots`
    field maps slot names (`"walk"`, `"idle"`, ...) to clip ids on
    the entity's skeleton.  `Spawner` writes a server-only
    `AnimationSlots` component from this; `AnimationSystem` looks up
    `slots["walk"]` instead of hard-coding `"walk"`.  Two prefabs
    sharing one skeleton can now play different walks — `walk_zombie`
    on a zombie, `walk_normal` on the player — without forking the
    skeleton.  Absent component / absent slot falls through to the
    slot name as the clip id, so existing prefabs keep working.

  - **Devtool: Library tab.**  New top-level tab in the voxel editor
    with four sub-workflows:
      * **Browse** — list library + inline clips per skeleton, with a
        delete button.  Shows when an inline clip is overridden.
      * **Import GLB** — file picker → animation picker → bone-map
        preset (quaternius / mixamo / cmu) → previews how many bones
        match vs. drop → saves as a `LibraryClipPlain`.
      * **Mix** — author a compound clip recipe (additive / crossfade
        / phase-shift), pick base + overlay, set weight / mask, save.
      * **Assign** — pick a prefab, edit its slot → clipId map (as a
        dropdown of clips known to the prefab's skeleton), save back
        to the prefab JSON.

    Devtool writes go through new POST/DELETE endpoints in
    `scripts/serve_devtools.ts`, restricted to `anim_library/` and
    `prefabs/`.  The browser uses three.js's GLTFLoader (already a
    dep) for parsing GLBs — no new toolchain needed.

Done when: a Quaternius GLB can be imported via the UI, the resulting
clip appears in Browse, an Assign edit on a prefab updates the
prefab JSON, and the tile server picks the new clip up after restart.

---

## Player UX

### T-071 · Character creation screen
Effort: M   Status: todo

On first connection (or after dynasty wipe), show a character creation screen: species selection
(visual only; minor passive trait), starting Lore fragment selection (from a small initial set).
Done when: new player completes character creation and spawns as a properly initialised entity.

### T-072 · Respawn / heir flow UI
Effort: M   Status: todo

On death, spawn heir at family workbench. Show respawn UI: walk to family library, select tomes
to read (internalise Lore), walk to family treasury, equip stored gear. Guide the player through
the ritual without hard-coding it.
Done when: death triggers the heir flow; heir spawns at workbench and can complete the ritual.

### T-073 · Inventory UI
Effort: M   Status: todo

Basic inventory panel: grid of carried items, item info on hover, drag-to-equip. Weight bar
showing current vs. max encumbrance. Must reflect real-time updates from server state.
Done when: player can view, equip, and drop items from inventory.

### T-074 · Main menu / title screen
Effort: S   Status: todo

Minimal title screen: connect button (triggers gateway handshake), server status indicator.
No account system in scope for now — identity from a locally-stored player ID.
Done when: player can start the game from a title screen without direct URL manipulation.

### T-075 · Trader interaction UI
Effort: S   Status: todo

When interacting with a trader NPC, show a buy/sell panel: trader's goods + prices on one side,
player's inventory on the other. Transaction deducts/adds physical coin items (T-031).
Done when: player can buy and sell items with a trader NPC via a UI panel.

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
Effort: M   Status: todo

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
Effort: S   Status: todo

`WorkbenchOwner` component already exists. When a workbench entity is destroyed, emit a
`WorkbenchDestroyed` event. NPCs assigned to that workbench receive the event, clear their
job board association, and enter idle/neutral state.
Done when: destroying a workbench causes its NPCs to go neutral within a configurable number
of ticks.

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
Effort: S   Status: todo

Add a `Species` component: `{ speciesId: string }`. Add species definitions to a new
`species.json` data file. Each species has a small passive trait (e.g. dwarf: +5% base health;
human: no modifier). Species is set at character creation (T-071).
Done when: species component is present on player entities; passive trait applies to base stats.

### T-085 · Species visual variants — skeleton archetype mapping
Effort: M   Status: todo

Species definitions include a `skeletonArchetype` field that maps to a different skeleton
definition. Dwarf skeleton is shorter and wider; human is the default. Visual differentiation
without new animations — same animation set, different bone proportions.
Done when: a dwarf character renders with dwarf skeleton proportions; animations play on both.

---

## Item Durability

### T-086 · Item durability scalar component
Effort: S   Status: todo

Add `Durability: { current: number; max: number }` component to all equippable items at spawn.
This is independent of material quality — two steel swords can be at different durability states.
Done when: equipped items have a durability component; it serialises and syncs to client.

### T-087 · Durability drain from use (combat + crafting)
Effort: S   Status: todo

Each successful combat hit with a weapon reduces its durability by a configurable amount.
Crafting tool use similarly drains the tool. At zero durability, item becomes unusable.
Done when: weapons and tools degrade from use; reaching zero makes them inoperable.

### T-088 · Durability repair via crafting workstation
Effort: S   Status: todo

Add a repair recipe type: item + repair material → restored durability. Repair at the
appropriate workstation (anvil for metal, workbench for wood). Repair restores a fixed amount,
not full — repeated repairs compound material cost.
Done when: player can repair a degraded item at a workstation to partially restore durability.

---

## World / Environment

### T-089 · Light emission system (torch, fireplace, hearth)
Effort: M   Status: done   Commit: 57587f4

`LightEmitter` (wireId 31) and `DarknessModifier` (wireId 32) networked components.
Light level is virtual state — `getLightAt(world, x, y)` is a pure function over ECS queries, no
precomputed grid. EquipmentSystem writes LightEmitter when a torch/lantern is equipped (driven by
`baseStats.lightColor/Intensity/Radius/Flicker` on the item template). `spawnEntity()` writes
LightEmitter for placed emitters (campfire, hearth) via `components.lightEmitter` on EntityTemplate.
Client: `LightManager` attaches `THREE.PointLight` to entity groups; flicker via double-sinusoid
oscillator. Protocol note: component-removal delta not yet implemented — zero-intensity write used
as "off" sentinel until wire removal is added (see T-097).
Done when: a placed torch emits visible light that fades with distance; campfire casts warm
ambient glow; lights respond to day/night cycle.

### T-090 · Room detection and enclosed-wall system
Effort: L   Status: todo

A room is a contiguous enclosed volume formed by placed wall/floor blueprint structures.
Room detection runs as a server-side flood-fill over the structure grid after each build event.
Detected rooms receive a `RoomTag` entity with area, enclosure quality (0–1), and an interior
cell set. Downstream consumers: warmth bonus (fireplaces raise interior temperature), shelter
bonus (reduces corruption gain), NPC pathfinding prefers enclosed spaces for settling.
Done when: placing walls that form a closed loop creates a detectable room entity; room dissolves
when a wall is removed; interior cells are queryable by other systems.

---

## UI / Interaction

### T-091 · Workstation recipe browser and selection UI
Effort: M   Status: todo

Currently the workstation CraftingPanel only shows auto-matched items; there is no way to
browse or select a recipe. The workstation needs a recipe list panel showing all recipes valid
for this station type. Clicking a recipe locks it as the `activeRecipeId` on WorkstationBuffer
(server command via CommandType.SelectRecipe). Input slots then show required ingredients;
items placed that don't match the locked recipe are rejected. Time-based recipes (smelt, cook)
auto-start once all ingredients are present.
Done when: player can open a workstation, browse its recipe list, select one, and place
matching items to start crafting.

### T-092 · Blade dimensions derived from equipped item voxel model
Effort: M   Status: done   Commit: (pending)

The hilt (from swingPath keyframes) is the anchor; the weapon model AABB drives blade geometry.
Model Z axis = blade axis (voxel Z → Three.js Y via anchor quaternion). `bladeLength = aabb.maxZ
× entityScale`, `bladeRadius = minCrossSection/2 × scale`. Unarmed uses constants in ActionSystem.
`WeaponSwingPath.defaultBladeLength/defaultBladeRadius` and `DerivedItemStats.bladeLength/bladeRadius`
removed — no per-action or per-item overrides. Swept-capsule hit detection (hilt→tip segment) unchanged.
Client caches blade dimensions on `EntityMeshGroup.bladeDimensions` when weapon model loads in
`syncHandSlot`. Volumetric trail covered by T-099.

### T-099 · Volumetric weapon trail
Effort: S   Status: done   Commit: (pending)

Trail now records the full weapon blade segment (hilt + tip in world space) plus a perpendicular
direction and half cross-section width (`halfCross` from model AABB). `rebuildTrailMesh` renders
a closed tube: 4 verts per slice (hiltL, hiltR, tipR, tipL), 4 quad faces per slice pair (left
side, right side, near face, far face). Shows the physical space the blade swept through rather
than a tip-only ribbon. Trail width driven by the widest AABB cross-section dimension.

### T-128 · Input system rewrite — Intent router + charged attacks + build polyline
Effort: L   Status: done   (delivered as T-129 + T-130 + T-131)

Replace the current ad-hoc click/key surface with a single Intent-based
pipeline. Add charged attacks (server-decided, charge_ms on the wire), a
proper Mode state machine for building, polyline-tool blueprints (walls
placed as connected segments), explicit hover-driven interact (E key), and
the matching server cleanup (drop the INTERACT bit, drop InteractCooldown,
add a PickUp command).

Today's surface — three independent pipelines (canvas mouse via
InputController; UI clicks via Preact onClick; drag via dragSystem global
listeners) — collapses into one router. Mode-switching (buildMode /
radial-open / drag-active) lives in a translator, not embedded in the
input listener. UI handlers and world handlers register against the same
router with priority + claim semantics; an open panel doesn't block
canvas clicks unless it actually sits under the cursor.

Architecture (terminology used across T-129..T-131):

  RawEvent              — kbd/mouse/touch event, no game knowledge
  InputCapture          — owns the global event listeners, emits RawEvent
  Context               — live state read by the translator:
                            HoverState (entity + terrain cell at cursor),
                            HoldState  (LMB held since when, charge),
                            Mode       (normal | radial-open | build),
                            ModalStack (currently open panels)
  IntentTranslator      — (RawEvent + Context) → typed Intent[]
                          all mode logic lives here
  Intent                — typed union: world-main-action, interact,
                          block-start/end, mode-enter-build,
                          build-cursor-move, build-place-anchor,
                          mode-exit-build, ui-* actions (existing UIAction
                          shapes get folded in)
  IntentRouter          — handlers register with priority + claim();
                          first claim wins; unclaimed intents fall through.
                          UI handlers and world handlers share the chain.

Wire-format change (T-129):
- InputDatagram extends from 36 → 38 bytes (`u16 chargeMs`).
- ACTION_INTERACT bit slot retired; comment-reserved.
- New `CommandType.PickUp { entityId }`.
- `Swingable` schema: `{ actions: Array<{ actionId, chargeMin, chargeMax }> }`
  replaces the single `weaponActionId`. Server picks the first action
  whose `[chargeMin, chargeMax]` interval contains chargeMs. Same shape
  for melee (two-tier light/heavy) and ranged (one action that reads
  chargeMs internally for projectile speed scaling). `chargeMin` defaults
  to 0 and `chargeMax` to 65535 (clipped at the wire).

What to delete (per CLAUDE.md "refactors replace"):
- `InputController` class entirely. Its responsibilities split into
  InputCapture (low-level events) + IntentTranslator (mode + charge logic).
- `ACTION_INTERACT` flag + every reference. Slot number stays a comment.
- `InteractCooldown` server-only component (was the throttle for the
  retired INTERACT bit). Drop from registry, components/items.ts, handoff.ts.
- `CraftingSystem.run()`'s INTERACT-load branch (the "shove inventory[0]
  into nearest workstation buffer" code). The drag-into-WorkstationPanel
  flow has replaced it since T-124.
- `UIAction` type's overlap with Intent — they merge; UIAction either
  becomes Intent or is fully absorbed (TBD during T-130).
- `buildMode` boolean on InputController, `onBuildPlace`/`onBuildOpenMenu`
  callback hooks — Mode state machine in the translator replaces them.

Phases T-129..T-131 break the work out so each commit ships standalone.

### T-129 · Server: chargeMs wire field, server-decided actions, drop INTERACT
Effort: M   Status: done   Commit: 3c80954   Phase 1 of T-128

Wire + server-side groundwork. Lands without the client input rewrite —
charged attacks are mechanically possible the moment this lands; the
client just sends `chargeMs = 0` until T-130 wires up the timing.

- `packages/protocol/src/messages.ts` — `InputDatagram` gains `chargeMs:
  u16`. Total size 36 → 38 bytes. ACTION_INTERACT (`1 << 3`) retired —
  bit slot stays a comment. New `CommandType.PickUp = 21` with payload
  `string entityId`.
- `packages/protocol/src/codecs.ts` — InputDatagram codec extended;
  encode/decode for the PickUp command.
- `packages/codecs/src/components.ts` — `inputStateCodec` extended to
  carry `chargeMs`.
- `packages/tile-server/src/components/items.ts` — delete `InteractCooldown`.
- `packages/tile-server/src/component_registry.ts` — drop InteractCooldown.
- `packages/tile-server/src/handoff.ts` — drop interactCooldown serialisation.
- `packages/tile-server/src/components/item_behaviours.ts` — `Swingable`
  schema becomes `{ actions: { actionId, chargeMin?, chargeMax? }[] }`.
  The matcher walks `actions` in order and picks the first whose
  [chargeMin, chargeMax] contains the player's chargeMs. Implicit defaults:
  chargeMin=0, chargeMax=65535.
- `packages/tile-server/src/systems/action.ts` — when starting a swing,
  read `InputState.chargeMs` and the equipped weapon's `swingable.actions`
  to pick the action variant; rest unchanged.
- `packages/tile-server/src/systems/crafting.ts` — delete the
  ACTION_INTERACT-driven buffer-load branch in `run()` (the for-loop
  block that walks players, checks the bit, finds nearest workstation,
  appends inventory[0] into the buffer). LoadWorkstation command
  remains the only path.
- New `CommandType.PickUp` handler — picks up the targeted ground item
  (ItemData entity) into the player's Inventory if the entity is within
  configured pickup range. Handler lives next to LoadWorkstation/
  TakeWorkstation in CraftingSystem (it's the same locality of inventory
  manipulation), or factor a new `InventoryCommandSystem` if cleaner.
- Content authoring: every weapon prefab with
  `swingable: { weaponActionId: X }` becomes
  `swingable: { actions: [{ actionId: X }] }` (no charge ranges →
  always-pick first). One demonstration weapon — iron_sword — gets the
  light/heavy split:
  ```
  swingable: { actions: [
    { actionId: "slash",    chargeMax: 200 },
    { actionId: "overhead", chargeMin: 200 }
  ] }
  ```
  All other weapons stay single-action.
- Client-side: only the InputController + InputDatagram encoder
  changes — send `chargeMs = 0` for now. The actual hold-and-release
  timing comes in T-130.

Done when: server boots clean against the new wire format; swinging a
sword produces "slash" today (chargeMs=0); no ACTION_INTERACT references
remain (`grep ACTION_INTERACT packages/` is empty); no InteractCooldown
references remain; crafting system's run() no longer mentions INTERACT.

### T-130 · Client: input system rewrite — InputCapture / IntentRouter / Mode / charge bar
Effort: L   Status: done   Commit: 84adcd0   Phase 2 of T-128

The big landing. Replaces InputController + the scattered Preact click
plumbing with the Intent pipeline.

New modules under `packages/client/src/input/`:
- `input_capture.ts` — owns `document` mouse/keyboard listeners. Emits
  `RawEvent { kind, button, key, canvasPos, target, t }`. The `target`
  field carries the original DOM EventTarget so the translator can
  distinguish UI clicks from canvas clicks. No game knowledge.
- `context.ts` — exports a `Context` object aggregating four reactive
  slices: `HoverState` (entity + terrain cell), `HoldState` (LMB held
  since), `Mode` (normal | radial | build), `ModalStack` (which panels
  are open). Slices are independent signals so consumers can subscribe
  fine-grained.
- `intent_translator.ts` — pure function `(RawEvent, Context) →
  Intent[]`. All mode-dependent logic concentrates here.
- `intent_router.ts` — registry of `IntentHandler { id, priority,
  claim(intent): boolean }`. First claim wins; consumed intents stop
  propagating.
- `intents.ts` — typed union of every intent shape.

Existing flows migrated (no parallel-system phase):
- `InputController` deleted. Game.ts no longer wires `onLmbClick` /
  `onBuildPlace` / `onBuildOpenMenu`; instead it registers handlers with
  the router for `world-main-action`, `block-start/end`, `interact`,
  `mode-enter-build`, etc.
- `InventoryPanel`, `EquipmentPanel`, `WorkstationPanel`, `RadialMenu`,
  `ContextMenu` — their onClick / onMouseDown handlers become
  `intentRouter.dispatch({ kind: "ui-...", ... })`. The shared `dragSystem`
  becomes a router handler too (claims `drag-start`, manages the document
  mousemove/mouseup loop internally).
- `UIAction` either folds into `Intent` (single union) or stays as a
  nested type — pick whichever produces less ceremony at registration
  sites. Lean toward single union with a `kind: "ui-..."` prefix
  convention to keep room for non-UI intents.

Charge attacks (client side):
- `HoldState.lmb = { downAtMs, weaponPrefabId }` set on LMB-down outside
  build mode, cleared on release.
- LMB-up emits `world-main-action { chargeMs }`.
- Default handler reads the player's equipped weapon, mirrors the server's
  `swingable.actions` lookup to pick the predicted action client-side
  (so the predictor stays in sync once predictor learns about swings),
  and sends an `InputDatagram` with ACTION_USE_SKILL set + chargeMs.
- New `ChargeBar` UI component — small fill bar above/under the player
  cursor showing chargeMs progress against the weapon's first
  `chargeMax` threshold. Reads `HoldState.lmb` reactively. Hidden when
  no charge active.

E-key flow:
- E-down → translator emits `interact { hoverTarget }`.
- Default `InteractHandler` switches on hoverTarget kind:
  - `entity = ground-item` → send `CommandType.PickUp { entityId }`
  - `entity = workstation`  → `openPanel("workstation")` + mirror entity
  - `entity = anything else` → no-op
  - no hover                → no-op.
- Removes the legacy server-side INTERACT path (already gone in T-129);
  the auto-pickup ItemPickupSystem stays in place for ambient
  collection within radius.

Modal precedence (per the agreed rule):
- The router does NOT special-case open panels. UI handlers register at
  high priority and naturally claim events that land on UI DOM nodes.
- World handlers register at lower priority and run for events that
  bubble through.
- Translator skips world intents when `event.target` is inside `#ui` AND
  some UI handler claimed the corresponding ui-* intent.

Done when: `grep InputController packages/client` is empty; LMB on
canvas attacks; LMB-hold then release sends a chargeMs; E over a hovered
ground item picks it up via PickUp command; E over a workstation opens
the panel; clicking a panel button doesn't attack the world; the charge
bar fills while LMB is held.

### T-131 · Build mode polyline + ghost preview
Effort: M   Status: done   Phase 3 of T-128

Build mode becomes a stateful tool with proper preview rendering and a
chain-placement workflow for line blueprints (walls).

Mode definition:
```
Mode = "normal" | "radial-open" | "build"
Mode.build = {
  blueprintId: string,
  tool: "single" | "polyline",
  polyline?: { lastAnchor: WorldCell }   // null until first click
}
```

Blueprint declaration:
- `Placeable` component gains `tool: "single" | "polyline"`. Default
  "single" when omitted. wall blueprints set `"polyline"`.

Mode entry/exit:
- RMB-down with hammer equipped → emits `mode-open-radial`.
- Radial commit → `mode-enter-build { blueprintId }` → Mode = build.
- Hammer unequipped → `mode-exit-build` (auto). Polyline anchors
  discarded silently.
- ESC while in build → `mode-exit-build`. Polyline anchors discarded.
- Re-opening the radial discards polyline implicitly (same as ESC).

In build mode, intents:
- `build-cursor-move { worldCell }` — fires per frame while in build
  mode; ghost renderer subscribes.
- `build-place { worldCell }` — emitted on LMB.
  - tool="single": send Place command, do not change mode.
  - tool="polyline": if no anchor yet, set lastAnchor = worldCell (no
    placement). If anchor exists, send Place commands for each cell on
    the segment from lastAnchor → worldCell (Bresenham line over grid),
    then update lastAnchor = worldCell. Each segment commits as it's
    drawn — no staging, no confirm.
- `build-undo` — emitted on RMB tap.
  - if polyline anchors active: pop the lastAnchor (no server side-effect;
    next click re-anchors fresh).
  - else: `mode-exit-build`.
- `build-cancel` — emitted on ESC. Same as exit.

Ghost rendering (renderer-side):
- New module `client/src/render/build_ghost.ts`. Subscribes to Mode +
  cursor cell. Renders:
  - tool="single": a wireframe outline of the blueprint's footprint at
    cursor cell.
  - tool="polyline" without anchor: same outline as single.
  - tool="polyline" with anchor: a ribbon/line of outlines from
    lastAnchor cell → cursor cell, one outline per cell along the
    Bresenham path. Highlight cursor cell brighter so the player sees
    the next-anchor target.
- Material: thin emissive line shader, accent colour from the theme
  palette.

Content updates:
- `wood_wall`, `stone_wall` blueprint prefabs add
  `placeable: { ..., tool: "polyline" }`. Existing `placeable.alignment`
  remains "cell-aligned".
- All other placeable prefabs (kits, doors, floors) implicitly default
  to `"single"`.

Future work (out of scope for T-131):
- Blueprint deletion via "right-click on a placed blueprint" intent.
- Rectangle / fill tools (would add new tool values + intent emitters).
- Build-mode HUD chip showing the active blueprint id.

Done when: equipping a hammer + RMB opens the radial; selecting "wood
wall" enters build mode with a polyline ghost; LMB places the first
anchor (no segment yet); LMB again places a wall segment from anchor to
cursor and re-anchors at the new cell; RMB tap pops the anchor and
returns to free-cursor preview; ESC exits build mode; unequipping the
hammer also exits.

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

## Engine / Netcode

### T-094 · Discriminated union for ComponentDef — wireId required on networked components
Effort: M   Status: done

`ComponentDef` currently has `networked: boolean` but no wire ID on the type itself. Adding a
new networked component requires touching two separate places (the def file + `COMPONENT_REGISTRY`)
and forgetting the registry causes silent delta loss.

**Change `ComponentDef` in `@voxim/engine` to a discriminated union:**

```typescript
export interface NetworkedComponentDef<T, N extends string = string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  readonly networked: true;
  readonly wireId: number;  // stable wire format ID, never reuse
}

export interface ServerOnlyComponentDef<T, N extends string = string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  readonly networked: false;
}

export type ComponentDef<T, N extends string = string> =
  | NetworkedComponentDef<T, N>
  | ServerOnlyComponentDef<T, N>;
```

`defineComponent()` gets two overloads: one requiring `wireId` when networked (default), one
accepting `networked: false` without it.

**Cascade changes:**
- All ~28 networked component defs: add `wireId: ComponentType.X`
- All ~6 server-only defs: add `networked: false` explicitly (already set, just becomes
  the discriminant)
- `COMPONENT_REGISTRY` entries: drop `typeId` field (now lives on the def)
- `buildDeltaMap` in `server.ts`: replace `COMPONENT_NAME_TO_TYPE.get(entry.token.name)`
  lookup with `entry.token.wireId` directly
- `buildSpawnComponents` in `aoi.ts`: replace `COMPONENT_NAME_TO_TYPE.get(def.name)`
  with `def.wireId`
- `DEF_BY_TYPE_ID` derivation: `new Map(NETWORKED_DEFS.map(d => [d.wireId, d]))`
- Remove the startup assertion added in d372aef (TypeScript makes it redundant)
- Remove `COMPONENT_NAME_TO_TYPE` from `server.ts` import (no longer used there)

Done when: `deno check` passes, adding a networked component without `wireId` is a
compile error, and server-only components cannot have `wireId`.


### T-097 · Wire protocol: component removal delta
Effort: S   Status: todo

**The problem.** `BinaryStateMessage` currently carries `spawns`, `deltas` (component writes),
and `destroys` (entity removals).  There is no message for removing a single component from a
living entity.  When a component is removed via `world.remove()`, the client never learns about it
— its `EntityState` retains the stale value until the entity leaves and re-enters AoI.

**Known example: T-089 `LightEmitter`.** When a player unequips a torch, `EquipmentSystem` calls
`world.set(entityId, LightEmitter, { intensity: 0, radius: 0, ... })` instead of `world.remove()`
to signal "light off" to the client.  The component persists in ECS state with sentinel values.
This is a workaround, not a proper solution — it leaves garbage data in the ECS and requires every
consumer of `LightEmitter` to guard against `intensity <= 0`.

**Decision needed.** Before implementing, weigh:
- Extend `BinaryStateMessage` with `componentRemovals: { entityId: string; componentType: number }[]`.
  Clean, explicit, low overhead per removal.
- Alternatively, tolerate sentinel-value conventions for sparse components (simpler protocol,
  higher call-site burden).

**If wire removal is added:**
1. Add `componentRemovals` to `BinaryStateMessage` and update `binaryStateMessageCodec`.
2. Server: collect `changeset.removals` for networked defs and encode them alongside deltas.
3. Client: `ClientWorld.applyRemoval(entityId, componentType)` clears the field in `EntityState`.
4. Replace the `intensity: 0` sentinel in `EquipmentSystem._updateLightEmitter()` with a real
   `world.remove(entityId, LightEmitter)` call.
5. Remove the `intensity <= 0` guard from `getLightAt()` and `LightManager.sync()`.

Done when: a protocol decision is recorded here; if wire removal is chosen, all five steps above
are complete and `LightEmitter` is the first component to use the new path.
Effort: M   Status: done   Commit: 38e1462

All content previously stored in large flat JSON arrays has been split into
one file per item under typed subdirectories.  Singletons (game_config.json,
concept_verb_matrix.json, etc.) stay as flat files.

**New directory layout under `packages/content/data/`:**
- `models/{id}.json` — 69 model definitions
- `skeletons/{id}.json` — skeleton rigs
- `items/{id}.json` — item templates (was item_templates.json)
- `templates/{id}.json` — entity templates (was entity_templates.json)
- `npcs/{id}.json` — NPC templates
- `weapon_actions/{id}.json` — weapon swing definitions
- `recipes/{id}.json`
- `structures/{id}.json`
- `lore/{id}.json` — lore fragments
- `materials/{name}.json` — material definitions (numeric id stays in file)

**Loader** (`loader.ts`): switched from `readJson(dir, "file.json")` to
`readJsonDir(dir, "subdir")` which scans the directory, sorts by filename
for deterministic order, and loads each file as one item.

**Client aggregation**: since the browser bundle can't use Deno.readDir, two
generated TypeScript files aggregate the per-item imports for static bundling:
`weapon_actions_static.ts` and `item_templates_static.ts`.  Run
`deno task gen-content` after adding/renaming data files.

### T-249 · Changeset: ordered op-log + `world.mutate` (deferred read-modify-write)
Effort: L   Status: done   Commits: 2b36633 (moves 1+2, engine) · 6fd0ae2 (move 2, conversions)

`applyChangeset` applies all `pendingSets`, then all `pendingRemovals`
(`engine/src/world.ts:233-256`). Two structural consequences, both with live victims
(2026-06 review):

- **Program order between `set()` and `remove()` is inverted.** `clear_tag` (interrupted
  action's exit) + `set_tag` (new action's enter) in the same tick nets to *removed* — a
  force-interrupted stagger runs without its `Staggered` tag; a `PendingReaction` consumed
  (deferred remove) and re-set by a same-tick hit is dropped.
- **Whole-component `set` is last-write-wins against the committed base.** Two hits in one
  tick lose one hit's damage (both `DamageDealt` events still fire); two DoT buffs don't
  stack; a stamina spend and a poise hit on the same `Resource` erase each other; and
  `resolveStrike`'s flush-time writes land at the front of the *next* tick's queue where
  `SkillSystem.run`'s cooldown batch and `ResourceSystem`'s every-tick `Resource` rewrite
  overwrite them — T-247/T-248 strike skills currently fire cooldown- and cost-free.

Fix, three moves:

1. **One pending op queue** (`set | mutate | remove`), applied strictly in push order at
   commit. Restores program-order semantics; a set-then-remove nets to a removal.
2. **`world.mutate(id, C, fn)`** — deferred read-modify-write. `fn` runs at commit against
   the value *after* earlier ops this tick, so concurrent contributions compose. Reads during
   the tick still see committed state — the "systems can't see each other's writes" isolation
   doctrine holds untouched. Convert the multi-writer components (`Health`, `Resource`,
   `LoreLoadout` cooldowns, `PendingReaction`) to mutate; plain `set` remains for
   single-writer ownership (ActionDispatcher → ActiveActions, spawn paths). `ResourceSystem`
   mutates individual resource keys instead of rewriting the whole component.
3. **Post-changeset event flush becomes notify-only.** `resolveStrike` moves out of the flush
   into `SkillSystem.run` (drain a StrikeLanded buffer at the top of run), so cooldown stamps
   and costs land inside the system phase, batched with the GCD logic — single writer of
   `LoreLoadout` again. Resolving a tick's strikes together also fixes "one cleave = N
   activations paid once" (each flush-time call read the still-committed cooldown 0).

Delta build derives the final value per (entity, component) from the op walk — encode once
(fixes the "exactly once" violation); removals feed T-250's removal channel.

**Combined with the T-259 trigger arc (project decision 2026-06-10).** Move 3 as
written (relocate `resolveStrike` into a SkillSystem buffer-drain) is superseded:
T-259b deletes the strike path outright, so the interim relocation would be
built-then-deleted. The combined sequencing instead: moves 1+2 land first (engine
op-log + mutate + conversions — T-259's trigger effects need them to compose), the
**notify-only flush doctrine** from move 3 is adopted as-is, and its consumer is the
T-259 `TriggerSystem` (a real System draining an event buffer at the top of its
run — not a flush-time writer). "Strike cooldowns/costs survive" resolves by
deletion in T-259b. See `TRIGGER_PRIMITIVE_PLAN.md` for the merged phasing.

Done when: the stagger-tag and PendingReaction same-tick cases keep the later write; two
same-tick hits both subtract health; DoTs stack; engine tests cover set/mutate/remove
interleavings. (Strike criterion → T-259b.)

### T-250 · Replication: component-removal channel + death events + InputState
Effort: M   Status: todo

Three gaps where the changeset produces transitions the wire cannot express (2026-06 review):

- `runTick` builds deltas only from `changeset.sets` (`server.ts:950`); `changeset.removals`
  is dropped and `BinaryStateMessage` has no removal channel at all. `CounterReady` —
  networked purely as a UI presence flag — latches on the client forever; stale
  `Velocity`/`Position` survive on in-AoI entities. "Component presence as flag" is
  structurally unimplementable on the wire as it stands.
- `computeSessionUpdate` prunes `knownEntities` (step 3) *before* filtering events (step 5),
  so `EntityDied`'s `knownEntities.has(ev.entityId)` is false for exactly the sessions that
  knew the entity (`aoi.ts:219-239`) — the event is wire-dead; clients only see a bare
  despawn. Filter events against the pre-prune known set.
- `InputState` is in `NETWORKED_DEFS` but every writer uses `world.write`, so it never
  appears in any delta; the comment at `server.ts:1006` asserts a delivery path that does not
  exist. Decide: make it server-only, or route it through the changeset.

Done when: removing a networked component reaches the client as a removal; `EntityDied`
arrives at sessions that knew the entity; `InputState` is either server-only or actually
replicates.

### T-251 · Save/load: complete the entity round-trip
Effort: L   Status: todo

`serialize()` is an allowlist of three queries while spawning is a rich pipeline (visual
shell, archetype installers, server-only Resources); nothing reconciles the two
(`save_manager.ts`, 2026-06 review):

- Chunks save only `Heightmap + MaterialGrid`; `OpenMask`/`KindGrid` are lost and
  `buildOpennessLookup` treats a missing mask as open — after one restart-with-save, POI
  walls and water boundaries are walkable and client decoration is gone.
- Workstations and placed structures are never matched by any save query, but
  `spawnInitialEntities` runs only `if (!loaded)` — gone forever after the first autosave.
- Resource nodes reload without `ModelRef`/`Hitbox` (invisible, skipped by weapon_trace) and
  without the server-only respawn `Resource` — nodes saved depleted are permanently dead.
- `deserialize` mutates the world before rejecting trailing bytes (then the fresh path runs
  on top — duplicate chunks/WorldClock); a truncated payload throws unhandled and crashes
  boot.

Fix shape: save the full chunk component set; include placed/workstation entities; run loaded
entities through a "re-complete" pass (installVisualShell + archetype installers) instead of
raw component writes; validate the full payload before any `world.create`. Add the missing
round-trip test: spawn → save → load → assert component-set equality per entity class.
SaveManager has zero tests today.

Done when: restart-with-save preserves collision, decoration, workstations and harvestable
nodes; a corrupt save is rejected without world mutation; the round-trip test passes.

### T-252 · Delete TickEventBuffer; prune stale per-entity state; equip-entity leak
Effort: S   Status: done   Commit: 3635d0b

- `TickEventBuffer` has been write-only since the CSM retired (T-228): `physics.ts:201,204`
  fire into it, nothing reads or `clear()`s it — unbounded per-entity Map growth for the
  process lifetime. Delete it (replace-don't-accrete slipped here).
- `PhysicsSystem.offGroundTicks` and the `HitboxSystem` pose/transform pools never drop
  destroyed entities — slow growth under NPC churn.
- `spawnEquipEntity` creates item entities for every player *and NPC*, but `DeathSystem`
  destroys only the holder (`deathHooks` is empty) and the disconnect path destroys only the
  player — every NPC kill and player session leaks ItemData entities into the world.

Done when: grep finds no TickEventBuffer; per-entity maps shrink on entity destroy; killing
an NPC removes its equip entities from the world.

---

## Procedural Characters

### T-096 · Skeleton morph params — seed-driven body proportion variation
Effort: M   Status: done   Commit: (pending)

Add a `morphParams` array to `SkeletonDef` that declares named scalar parameters
(e.g. `armLength`, `legLength`, `torsoHeight`, `shoulderWidth`), each mapping
to a set of bone IDs, a rest-axis (`x`/`y`/`z`), and a `[min, max]` multiplier
range.  `resolveMorphParams(skeleton, seed)` samples each param via a PRNG stream
derived from `ModelRef.seed` (XOR-separated from the pool-selection stream so the
two don't alias).  Resolved values are applied in `solveSkeleton()` (server,
hitboxes) and `upgradeToSkeletonModel()` (client, Three.js bone Groups) — same
seed produces identical proportions on both sides, no codec changes needed.

Done when:
- `MorphParamDef` type defined in `types.ts`, `morphParams?` on `SkeletonDef`
- `resolveMorphParams()` exported from `@voxim/content`
- `solveSkeleton()` accepts optional `morphParams` and scales per-bone rest offsets
- `upgradeToSkeletonModel()` accepts optional `morphParams` and scales bone positions
- `HitboxSystem` and `spawner.ts` compute and forward morph params from `ModelRef.seed`
- `human.json` skeleton declares four params: `armLength`, `legLength`, `torsoHeight`, `shoulderWidth`
- `deno check` passes clean

**Deleted**: `model_hitboxes.json` (was never read by the loader — orphaned
leftover from a superseded hitbox system).

---

## Devtools

### T-098 · Comprehensive debug panel rework
Effort: M   Status: done   Commit: fe646e1

The debug panel in `DebugPanel.tsx` is growing ad-hoc. The existing `GiveItemSection`
(filter input → scrollable item list → quantity → button per item) establishes the right
pattern: a self-contained `Section` component, isolated signals for local state, actions
dispatched via `UIAction` to `game.ts`, server-side handler on `CommandType`. New sections
should follow that same shape.

Planned sections (this list will grow — add new ones here before implementing):
- **Set time of day** — slider or input for world clock hour; dispatches a `debug_set_time`
  action; server command sets `WorldClock` directly
- **Spawn NPC** — filterable list of NPC template IDs; quantity input; dispatches
  `debug_spawn_npc`; server spawns at player position
- **Set stat** — dropdown (health / stamina / hunger / …) + numeric input; dispatches
  `debug_set_stat`
- **Teleport** — X/Z coordinate inputs; dispatches `debug_teleport`

Done when:
- `DebugPanel.tsx` is restructured so each capability is a self-contained `Section`
  component following the `GiveItemSection` pattern (local signals, `onAction` dispatch)
- `UIAction` union extended with new debug action variants
- `game.ts` `handleAction` routes each new action to a `CommandType` send
- Server-side command handlers implemented for each new action
- Existing give-item flow untouched and still working

Done when: `deno check` passes, adding a new item is a single JSON file drop.

---

### T-100 · Entity hover + click interaction system
Effort: M   Status: done   Commit: (pending)

Client-side system for hovering entities and dispatching click events to
registered handlers. Foundation for workbench UI, ground item pickup, and
any future entity-level interaction.

**Outline system** (prerequisite):
- Inverted-hull outline meshes added to every entity voxel (`buildVoxelMesh`
  creates them as child meshes using `makeOutlineMesh`). Stored in
  `EntityMeshGroup.outlineMeshes[]`.
- `HOVER_OUTLINE_MAT` — warm yellow-white variant of `OUTLINE_MAT`, thicker.
  Material-swap on hover: `setEntityHovered(mesh, true/false)`.
- `setHullOutlinesVisible()` — bulk toggle used by the debug panel.

**InteractionSystem** (`src/interaction/`):
- Each entity gets an invisible pick cylinder on Three.js layer 3 (`PICK_LAYER`).
  Camera renders only layer 0 so cylinders are never drawn.
- `update(mouseX, mouseY)` — called each frame; raycasts layer 3, swaps outline
  materials, fires `onHoverStart`/`onHoverEnd` on the matching handler.
- `handleClick(mouseX, mouseY, playerX, playerY)` — called on LMB via
  `InputController.onLmbClick`; dispatches to the highest-priority handler
  whose `canHandle()` returns true and entity is within `interactionRange`.
  Returns `true` to consume the click (suppresses `ACTION_USE_SKILL`).
- `register(handler)` / `unregister(id)` — extensible handler registry.

**Debug panel** additions:
- "Sobel edges" toggle — sets `edgeStrength` uniform on EdgePass to 0/1.
- "Hull outlines" toggle — calls `toggleHullOutlines()` on renderer.

Both outline types now visible and independently toggleable for comparison.

**Registering a new handler** (example — workbench):
```typescript
is.register({
  id: "workbench",
  priority: 10,
  interactionRange: 4,
  canHandle: (t) => t.entityState.raw.has("workstationType"),
  onClick: (t) => { openPanel("crafting"); return true; },
});
```

## Registry Refactor

Multi-phase scaffolding effort to move string-dispatch in systems onto a unified
registry pattern. Each phase ships with deletion of replaced code — no
deprecation shims, feature flags, or legacy fallbacks.

### T-101 · Phase 0.2 — generic `Registry<T>` helper in `@voxim/engine`
Effort: S   Status: done

Added `packages/engine/src/registry.ts` with a typed `Registry<H>` class that
throws on duplicate ids and unknown id lookups. Exported from `@voxim/engine`.
Used by subsequent phases (EffectRegistry, JobHandler, BehaviorTree nodes,
RecipeStepHandler).

### T-102 · Phase 0.1 — move hardcoded tuning constants to `game_config.json`
Effort: S   Status: done

Moved 16 module-level `const` tuning values out of tile-server system files
into `data/game_config.json` under new / extended sub-objects
(`crafting`, `consumption`, `animation`, `building`, `terrain.digReach`,
`combat.unarmedBladeLength`/`unarmedBladeRadius`, and 7 new
`npcAiDefaults.*` fields). `GameConfig` type in `@voxim/content` extended
to match. All original constants deleted from systems; helper functions in
`npc_ai.ts` now take explicit config values through their signatures rather
than reading module-level constants.

### T-103 · Phase 1 — `EffectRegistry` for skill/buff effect dispatch
Effort: M   Status: done

Added three registries (apply / tick / compose) in
`packages/tile-server/src/effects/`. Five handlers created:
`health_effect` (apply + tick), `speed_effect` (apply + compose),
`damage_boost_effect` (apply), `shield_effect` (apply), `flee_effect` (apply).
SkillSystem and BuffSystem both dispatch through registries — zero
`effectStat ===` string branches remain in either system.

Wire-level `effectStat` changed from closed u8 enum to length-prefixed
string in `activeEffectCodec`, so new effect ids are addable via JSON +
handler file with no codec changes. `SkillEffectStat` union deleted from
`@voxim/content`, `@voxim/codecs`, and lore_loadout component.
`SKILL_EFFECT_STAT_TO_U8`/`U8_TO_SKILL_EFFECT_STAT` maps deleted.
`CONSUME_ON_USE_SENTINEL` only referenced by `damage_boost_effect.ts`
(apply) and lore_loadout's generic `isConsumeOnUse()` helper (used by
BuffSystem without effect-specific knowledge).

Startup validation in `server.ts` iterates every ConceptVerbEntry and
throws if its `effectStat` has no registered apply handler.

### T-104 · Phase 2 — `DeathSystem` + `RequestDeath` event
Effort: M   Status: done

Consolidated entity destruction from health loss into one system. Added
`DeathRequestPort` interface + `DeathSystem` that collects requests during
a tick, dedupes, runs registered `DeathHook`s, publishes
`TileEvents.EntityDied`, and destroys. Runs last in the tick chain.

`DeathRequestPort` is a direct port (not a deferred event) so death
happens same-tick. Systems receive `deathSystem` by constructor injection
and hold it as a port: `HungerSystem`, `CorruptionSystem`, `SkillSystem`,
`BuffSystem`, `HealthHitHandler`. Effect handler contexts
(`EffectApplyContext`, `EffectTickContext`) carry the port so
`healthEffectApply` and `healthEffectTick` can request deaths without
knowing about `DeathSystem`.

All 5 health-driven destroys redirected to `RequestDeath`:
`HungerSystem` (starvation), `CorruptionSystem` (corruption),
`HealthHitHandler` (damage), `healthEffectApply` (effect instant/drain),
`healthEffectTick` (DoT). Remaining `world.destroy` calls are all
non-death (item pickup, projectile expiry, blueprint completion,
resource depletion, player disconnect) — these stay direct.

`DeathHook` registry is empty today; future drop-tables / heirs /
corpses will register as additive hooks with no system-file edits.

### T-105 · Phase 3 — `JobHandler` registry in NpcAiSystem
Effort: M   Status: done

Added `JobHandler` interface in `packages/tile-server/src/ai/job_handler.ts`
and registry factory in `ai/mod.ts`. Six handlers, one file each:
`idle`, `wander`, `flee`, `seekFood`, `seekWater`, `attackTarget`.

NpcAiSystem no longer switches on `job.type`. Per-tick flow:
emergency overrides → queue advance → `registry.get(job.type)` →
plan/replan → `advancePlan` for direction → `handler.tick(...)` → apply
transition (replaceJob / clearJob) and write InputState. Job-specific
logic (attack stop-in-range, seek auto-consume, target validation) all
lives in the handlers.

Shared AI utilities (`moveSteps`, `advancePlan`, spatial scans) extracted
into `ai/plan_helpers.ts`. `NpcTuning` type consolidates per-NPC values
resolved from template + game_config defaults.

Emergency priority cascade and `generateDefaultJob` stay in `npc_ai.ts`
for this phase — Phase 4 behavior trees will replace both.
NpcAiSystem: 523 lines → 245 lines.

### T-106 · Phase 4 — Behavior trees for NPC decision-making
Effort: L   Status: done

NPC decision-making moved from hardcoded priority cascade into data. Added
BT infrastructure under `packages/tile-server/src/ai/bt/`: evaluator,
`BTNodeFactory` interface, and 13 node factories — 2 composites
(`sequence`, `selector`), 6 condition checks
(`check_hunger_critical`, `check_thirst_critical`, `check_health_critical`,
`check_current_job_not`, `check_queue_empty_or_expired`, `check_plan_expired`)
and 5 actions (`set_job_seek_food`, `set_job_seek_water`,
`set_job_flee_from_nearest`, `set_job_attack_nearest`, `set_job_default`).

ContentStore gained `getBehaviorTree` / `getAllBehaviorTrees` and the
`behavior_trees/` directory. Two BT JSON files encode the old cascade:
`hostile.json` (aggro scan included) and `passive.json` (no aggro).

`NpcTemplate.behavior` (union) deleted and replaced with
`behaviorTreeId: string` (required). All 5 existing NPC JSON files
updated in the same commit — bandit (previously "neutral") remapped to
"passive" since neutral and passive were behaviorally identical today.

Server startup validates every NpcTemplate's behaviorTreeId resolves to
a loaded tree; `buildBehaviorTree` throws on unknown node types.
NpcAiSystem's tick flow now:
  evaluate BT → apply BTOutput (replaceCurrent / cooldownPlan) →
  dispatch through JobHandler registry from Phase 3 → advance plan →
  handler.tick → write InputState.

Zero `behavior` references remain anywhere in the codebase.
NpcAiSystem went from 245 lines to 211 lines; the emergency cascade and
`generateDefaultJob` helper are both gone.

### T-107 · Phase 5 — `RecipeStepHandler` registry
Effort: S   Status: done

Added `RecipeStepHandler` interface in
`packages/tile-server/src/crafting/step_handler.ts` plus registry factory
in `crafting/mod.ts`. Three handlers, one file each: `attack_step`
(onHit, tool-gated instant resolve), `assembly_step` (onHit, requires
active selection), `time_step` (onTick, auto-start + countdown).

Shared `resolveRecipe` + `toolMatches` helpers in `crafting/util.ts`.

`WorkstationHitHandler` is now a generic dispatcher — iterates the
registry's `onHit` handlers in registration order (assembly before
attack so explicit selection wins). `CraftingSystem` keeps the
ACTION_INTERACT placement phase and iterates every registered `onTick`
handler per workstation; all time-specific code (auto-start,
progressTicks countdown, completion resolve) moved into `time_step`.

Server startup validates every recipe's `stepType` resolves to a
registered handler — fail fast on mismatch.

Zero `stepType === "..."` branches remain in systems or handlers.
The only remaining comparisons are (a) `findMatchingRecipe`'s filter
parameter and (b) the assembly handler's self-identity check
(`ID` constant referenced from its own factory). Neither is a
cross-system dispatch branch.

### T-108 · Phase 6 — biome + zone as content data
Effort: M   Status: done

Moved biome climate thresholds, material assignments, zone profiles,
and spawn densities out of `packages/world/` code into
`packages/content/data/biomes/*.json` (9 files) and
`packages/content/data/zones/*.json` (11 files). Added `BiomeDef` +
`ZoneDef` types with range-based classify rules and material rules to
`@voxim/content`; registered on `ContentStore` with `getAllBiomes` /
`getBiome` / `getAllZones` / `getZone` (both pre-sorted by priority).

Rewrote `packages/world/src/biomes.ts` and `zones.ts` as pure functions
over `BiomeDef[]` / `ZoneDef[]`: `classifyBiome(defs, sample)`,
`biomeMaterialName(def, sample)`, `classifyZone(defs, sample)`.

Generator takes a new `WorldGenContent` argument carrying the biomes,
zones, and a material-name → id resolver. Per-cell height scale and
roughness read directly from `BiomeDef` fields.

Terrain cache format bumped to v2: `biomeId` and `zoneId` serialized as
length-prefixed UTF-8 strings instead of u8 enum values. `ZoneCell`
gained string `zoneId` / `biomeId`.

Deletions:
- `BiomeId` const-enum and `MAT_*` constants in biomes.ts
- `ZoneType` const-enum and `ZONE_PROFILES` in zones.ts
- `biomeMaterial`, `biomeHeightScale`, `biomeRoughness` functions
- `NPC_DENSITY`, `NODE_DENSITY`, `PROP_DENSITY` constants in server.ts —
  densities now per-zone in data
- Unused `generateTile` and `generateFlatTile` convenience functions
- Tectonic-based hills fallthrough hardcoded in classifyZone;
  now expressed as two rules on `hills.json`.

Server spawn functions (spawnProceduralNpcs / Nodes / Props) read
weights + densities from the per-zone def via `content.getZone(cell.zoneId)`.
`gen_terrain.ts` loads ContentStore and builds a `WorldGenContent`
adapter before calling `buildTerrainBuffers`.

Adding a new biome or zone is a JSON file drop; the `packages/world/`
package holds only generic rule-matching logic and noise evaluation.

### T-109 · Phase 7 — recipe schema expansion
Effort: S   Status: done

Rewrote `Recipe` type:
- `inputs[]` gained `alternates?: string[]` — recipe matches when any
  primary or alternate item type has the required quantity in the buffer;
  consumption picks the first acceptable type (primary preferred).
- `outputs: RecipeOutput[]` replaces single `outputType` / `outputQuantity`.
  `resolveRecipe` spawns one item entity per output.
- `requiredTools: string[]` replaces `requiredTool: string | null`.
  Empty array = any tool. `toolMatches` accepts the weapon when its
  toolType is in the list.
- `chainNextRecipeId?: string` — when set, on completion the workstation's
  `activeRecipeId` is set to this id (rather than cleared) so the next
  swing or tick continues the chain.

All 18 existing recipe JSON files rewritten in the same commit to the
new shape via a one-shot Python transform. Loader accepts only the new
shape; old field names are gone from `Recipe` and from all content.

Consumers updated: `recipeInputsMatch` and `consumeFromBuffer` in
`crafting.ts` honor alternates; `findCraftableRecipe` in ContentStore
does the same; `resolveRecipe` spawns each output and chains via
`chainNextRecipeId`; `attack_step`, `assembly_step`, `time_step` log
the full outputs list.

### T-245 · POI activity dispatch → registry (kill the last system switch)
Effort: M   Status: done   Commit: d3582e1

`PoiSystem.dispatch` carried a `switch (def.type)` over the six POI
activity kinds (encounter / exploration / bossfight / wave / action /
puzzle) — a literal violation of the "never switch on a kind/type field in
a system; rewrite it as a registry" doctrine, and the very thing the
system's own comment anticipated ("per-type adapter modules"). All six
types appear in authored content; four silently no-op'd through the switch.

- `poi/activity.ts` — `PoiActivityHandler { id; activate(ctx) }` +
  `PoiActivityContext` (world, events, content, def, pos, playerId,
  poiInstanceId). `def.activity` narrows to the handler's shape (registry
  guarantees `handler.id === def.type`).
- `poi/activities/{encounter,exploration}.ts` — the two real handlers,
  lifted verbatim from the switch's cases. `poi/activities/unimplemented.ts`
  — `makeUnimplementedActivity(type)`, registered for the four not-yet-built
  types as explicit no-op adapters (identical behaviour to the old stub
  branch: log + nothing) so every type has a home. `poi/mod.ts` —
  `newPoiActivityRegistry()` (mirrors `ai/bt/mod.ts`).
- `PoiSystem` takes the registry; `dispatch` is now
  `activities.get(def.type).activate(ctx)`. `spawnPrefab` /
  `resolveSpawnTable` / `TileEvents` imports moved into the handlers.
- Boot cross-check in `server.ts`: every `PoiDef.type` must resolve to a
  registered handler — fail fast, same stance as the ResourceDef /
  action-effect / recipe-step / BT checks. (So `get()` never throws at
  runtime.)

Each future POI type (bossfight, wave, …) is now one handler file + one
`register()` call, no engine edit — the substrate doctrine, finished for
POIs. Done: switch gone; server graph type-checks; 187 tile-server+content
tests green (incl. 2 new: the boot invariant — every content POI type
resolves — and an unimplemented type firing without crashing).

### T-246 · One effect substrate — skill effects fold onto action effects
Effort: M   Status: done   Commit: 698dd6b

Step 1 of the skill-as-action arc (a skill is an action; effects compose,
data-driven). The blocker was **two parallel effect substrates**: action
effects (`actions/effect.ts`, `EffectResolver`/`ResolveContext`, fired on
phase edges) and a second skill-only registry (`effects/`,
`EffectApplyHandler`/`EffectApplyContext`, fired by `SkillSystem` with its
own caster+magnitude context). The five skill effects already overlapped
the action effects — speed/damage_boost/shield are `spawnBuffChild` calls
(= `start_buff`), health is a targeted heal/drain. One substrate.

- `actions/resolvers/skill_effects.ts` — the five effects as ordinary
  `EffectResolver`s: actor is `ctx.entityId`, per-cast config
  (`magnitude`/`durationTicks`/`targeting`/`range`/`drainToCaster`/
  `overrideTargetId`) arrives in `ctx.params`. `health` is a class resolver
  (needs the death port); targeting is query-based (bounded counts, same as
  `projectile_trace`) instead of the spatial grid.
- `SkillSystem` drops the `applyRegistry`/`deaths` deps; `dispatch` fires
  through the one action-effect registry, building `params` from the
  concept-verb entry. It supplies a throwaway slot/state/edge (the effects
  read only entityId+params) — the synthetic shape that disappears when a
  skill genuinely becomes an action (step 2).
- The `effects/` dir (effect_handler, skill_effects, flee_effect, mod,
  util) is deleted; `EffectApplyHandler`/`EffectApplyContext` gone. The
  concept-verb boot cross-check now validates `effectStat` against the
  unified `actionEffects` registry. Server construction reorders so
  `actionEffects` (with the skill effects) is built before `SkillSystem`.

Side benefit: item `effects[]` and skill effects now share one registry, so
a consumable can name `health`/`speed` etc. directly. The verb matrix
survives only as the temporary param-source (slated to go in step 2 — the
data-driven composability is what's kept). Done: one effect substrate;
`deno check` clean; 192 tile-server+content tests green (incl. 5 new
locking each skill effect through the unified resolver path — behaviour
preserved from the retired registry).

### T-247 · Consolidate skill activation into one path (skill-as-action prep)
Effort: S   Status: done   Commit: c464f6b

`SkillSystem.run()` (the SKILL_N input path) and `resolveStrike()` (the
on-hit StrikeLanded path) carried two near-identical copies of the
activation core: resolve the slot's fragments → concept-verb entry, pay the
stamina/health cost, fire the effect. They differed only in cooldown
bookkeeping (run batches all four slots; strike stamps one) and the target.

- `activateSkill(world, events, casterId, slot, overrideTargetId)` — the one
  activation path; returns the cooldown ticks to stamp on success, or null
  if it didn't fire (no slot/fragments/entry, or unaffordable). The caller
  owns the cooldown array write.
- `run` and `resolveStrike` shrink to: check the slot's cooldown gate →
  `activateSkill` → stamp the returned cooldown. The cost/dispatch logic
  lives in exactly one place.

This is the seam step 2 converts to "start the skill action": the cost
becomes the action's `costs`, the cooldown a gate, the dispatch the action's
effect on a phase edge. Behaviour-preserving refactor (the one cosmetic
change: cooldown is stamped after dispatch instead of before — independent
deferred writes, same result). Done: one activation path; `deno check`
clean; 195 tile-server+content tests green (incl. 3 new — first SkillSystem
coverage: heal+cost+cooldown on activation, a slot on cooldown no-ops, no
flag no-ops).

### T-248 · Global cooldown (GCD) — the decided cooldown model, half 1
Effort: S   Status: done   Commit: a092ac0

Design decision (skill arc): cooldowns are a **global CD + separate per-skill
CDs** (WoW-like). Per-skill already existed (`skillCooldowns[4]`); this adds
the global cooldown — one active skill use locks the whole bar for a config
duration. Slots into the `activateSkill` seam (T-247).

- `LoreLoadout.globalCooldownTicks` (networked — codec + component default +
  spawner). Wire format of `loreLoadout` gains a trailing u32 (the client
  re-receives on reconnect; doctrine permits the break).
- `game_config.lore.globalCooldownTicks` (default 20 = 1.0s @ 20Hz).
- `SkillSystem.run`: decrements the GCD each tick, gates every active slot on
  `gcd === 0`, and stamps `gcd = config` on any cast — a single local `gcd`
  in the per-entity loop so a slot 0 cast blocks slot 3 the same tick.
- Scope: the **active** (SKILL_N) path only. On-hit `strike` riders
  (`resolveStrike`) neither check nor set the GCD — procs ignore the GCD,
  same as the reference model.

Will move to a gate over a shared resource when a skill becomes an action
(arc step 2b); the field + semantics + tests survive that move, only the
dispatch site changes. Done: `deno check` clean (codecs+content+tile-server);
197 tests green (incl. 2 new: one cast locks the bar + sets GCD; an active
GCD blocks and decrements).

### T-259 · Trigger primitive arc — the fourth primitive (on-hit/proc substrate)
Effort: L   Status: done
Commits: plan 087ce97/d45071e · 0 (op-log) 2b36633 · 0b (mutate+conversions) 6fd0ae2 · a (primitive) d82f785 · b (strike cutover) d6426c0 · c (proc surface) f3a59b2
The spine closes: Actions · Resources · Modifiers · **Triggers**. Phase c
shipped the `health_below` gate, the `npc_template` TriggerSource
(NpcTemplate.triggers[] — innate archetype procs), and two real procs:
`desperate_frenzy` (wolf, damage_taken + health_below 0.25 → damage_boost,
ICD 200) and `hunters_vigor` (iron_sword, entity_died as killer →
+20 stamina). CLAUDE.md updated to the four-primitive architecture.

### T-260 · Skill = Action — slots point at actions; the verb matrix retires
Effort: L   Status: done   Commits: a 6acf3b8 · b b5ec63d

Skill-arc step 2 (decisions recorded 2026-06-03: slots point at actions;
cooldown model = global CD + per-skill CDs). An active skill becomes an
`ActionDef` — windup/active/winddown, costs, gates, effects with inline
params — started through the dispatcher like every other action. The
concept-verb matrix and the verb vocabulary retire; data-driven
composability survives as the skill action's `effects[]` (param
interpolation from fragments returns later if wanted).

**a — cooldowns as a dispatcher primitive.** `ActionDef.cooldownTicks`
(per-action, WoW model: the spell is on cooldown wherever bound) +
`ActionDef.triggersGcd` (raises/blocked-by the actor's global cooldown,
`game_config.lore.globalCooldownTicks`). Server-only `ActionCooldowns
{gcd, remaining}` component; the dispatcher decrements at the top of run,
checks in `canStart` (committed view, ≤1-tick retune), stamps on actual
`start()` — a request rejected by the cancel matrix burns nothing.
Composing mutates throughout (T-249). Generic: dodge/NPC signature moves
can now carry cooldowns. Supersedes T-248's loadout-level GCD field (the
semantics + tests move here in phase b).

**b — the cutover.** `LoreLoadout.skills` becomes `(actionId | null)[4]`
(codec reshape; `skillCooldowns` + `globalCooldownTicks` leave the wire —
cooldown state is the server-only `ActionCooldowns`). `SkillIntentResolver`
(SKILL_N bit + slot's actionId → primary-slot intent, after
PrimaryIntentResolver so a skill press beats a swing press) replaces
`SkillSystem.run`; **SkillSystem is deleted** — the last Layer-2 system.
Ship `skill_mend` (self-heal cast) + `skill_fireblast` (area damage) as
ActionDefs; players start with `skill_mend` (config
`player.startingSkills`). DELETE: concept_verb_matrix.json, verbs.json,
`ConceptVerbEntry`/`VerbDef`/`SkillVerb`/`LoreSkillSlot` types, the
store/loader/bootstrap plumbing (bootstrap v13), the concept-verb boot
check, `NpcTemplate.skillLoadout`, and the whole SkillActivated wire path
(event id 8 → retired comment; EventRouter never subscribed it — it was
already wire-dead).


**Sub-plan: [`TRIGGER_PRIMITIVE_PLAN.md`](TRIGGER_PRIMITIVE_PLAN.md)**
(filed 2026-06-03). Design decision: the `strike` loadout verb is obsolete
— a swing is an action; on-hit behaviour is a *triggered effect*, not a
skill slot. The first proposal (an `"active:hit"` pseudo-edge fired by
weapon_trace) was reviewed and **rejected**: it overloads the temporal
phase-edge vocabulary with a contingent world event, makes weapon_trace a
second effect dispatcher, and builds a hit-only mechanism where the vision
(low-health procs, on-kill effects, zone/equipment behaviours) demands a
general primitive anyway.

Accepted shape: keep synchronous hit *resolution* (HitHandler chain)
untouched; **reify the hit as a `HitLanded` event**; add `TriggerDef`
content (`on` event kind from a closed catalog, `as` role binding,
`conditions` = the existing gate registry, `effects` through the one T-246
registry, optional internal cooldown) + one `TriggerSystem` as the single
event→effect bridge (post-changeset, the strike path's documented timing) +
a `TriggerSource` registry mirroring ModifierSource (v1: equipment).
No trigger re-entry in v1 (proc loops are a decision, not an accident).

**Combined with T-249 (project decision 2026-06-10):** T-249's flush-time-write
diagnosis applies verbatim to the originally planned flush-subscribing
TriggerSystem, so the runtime is revised: TriggerSystem is a real System that
*collects* events during the notify-only flush and *drains* the buffer at the
top of its next run, firing effects via `world.mutate` so concurrent procs
compose. T-249 moves 1+2 are the arc's substrate phases; T-249 move 3 is
superseded (strike deleted, not relocated).

Phases (merged): **0** = T-249 move 1 (ordered op-log) · **0b** = T-249 move 2
(`world.mutate` + multi-writer conversions) · **a** primitive standalone
(+ HitLanded, buffered TriggerSystem) · **b** strike cutover — wolf's DRAIN
becomes a weapon trigger and the seven-site strike path (strikeVerb,
HitContext.skillVerb, StrikeLanded, resolveStrike, registerSubscribers) is
deleted in the same commit (completes T-249's strike criterion by deletion) ·
**c** proc surface (health_below gate, on-kill + low-health demo triggers).
Closes the spine: Actions · Resources · Modifiers · **Triggers**.

The gateway gains a second responsibility alongside tile routing: it is the
outward-facing account service. It owns user identity, credentials, session
tokens, per-user settings, and persistent heritage. Tile servers become
stateless with respect to cross-session data — they call the account service
on player join/death/disconnect instead of keeping their own stores.

**Architecture summary**

- Single process, same as today's `deno task gateway`. New code lives under
  `packages/gateway/src/account/` with a narrow interface to the existing
  routing code — clean enough to extract into its own service later if load
  ever demands it.
- Password auth (argon2id), opaque session tokens (hashed at rest).
- Storage is two files per user, same directory:
  - `users/{userId}.json` — login + settings + activeDynastyId + lastTileId.
    JSON because these fields evolve freely (new settings, new features).
  - `users/{userId}.heritage.bin` — `heritageCodec` payload only. Binary
    because the shape is stable and the codec already exists.
  - No cross-reference stored; the filename stem is the link. No field is
    duplicated between the two files, so cross-file atomicity is a non-issue.
- Tiles call the account service via HTTP using a shared secret in a header.
- HeritageStore class is deleted entirely; tile-server gains an AccountClient.

Tickets T-110 through T-115 build this in order. T-110 and T-111 are
independent and can parallel.

### T-110 · Account storage layer — AccountStore + binary/JSON file format
Effort: M   Status: done   Commit: ea1d769

New `packages/gateway/src/account/store.ts` exposes:

```
class AccountStore {
  constructor(rootDir: string)
  async createUser(loginName, passwordHash): Promise<User>
  async getUserById(userId): Promise<User | null>
  async getUserByLogin(loginName): Promise<User | null>
  async updateUser(userId, patch): Promise<void>          // JSON side only
  async getHeritage(userId): Promise<HeritageData | null>
  async putHeritage(userId, data): Promise<void>          // binary side only
}
```

Files on disk:
- `users/{userId}.json` — `{ userId, loginName, passwordHash, createdAt,
  lastLoginAt, activeDynastyId, lastTileId, settings }`. `settings` is a
  free-form object; no schema enforced by the store.
- `users/{userId}.heritage.bin` — `heritageCodec.encode(data)` with file
  header `u32 magic "VXUH" | u32 version | f64 savedAt | bytes payload`.

Implementation notes:
- Atomic write via `write tmp + rename`, same as `save_manager.ts`.
- Login-name → userId lookup: maintain a sibling `users/_index_by_login.json`
  that maps loginName → userId. Rebuilt lazily by scanning on first use if
  missing. No DB.
- Store is oblivious to auth — it does not hash passwords. Caller passes the
  hash in.

Done when: unit can create, load, patch a user; heritage can be written and
read round-trip via the codec; missing files return null without throwing;
two concurrent writes to different users do not interfere.

### T-111 · Auth primitives — argon2id hashing + opaque session tokens
Effort: M   Status: done   Commit: 2fe46a6

Note: shipped with PBKDF2-HMAC-SHA256 (600k iterations) rather than
argon2id — pure Web Crypto, zero new deps. Hash format is self-describing
so a future swap is a prefix-dispatch in verifyPassword + rehash on
login.

New `packages/gateway/src/account/auth.ts`.

- Import `hash-wasm` or equivalent Deno-compatible argon2id implementation.
  Constants: memory 64 MiB, iterations 3, parallelism 1 (sensible defaults;
  tune on measured hardware).
- `hashPassword(plain): Promise<string>` returns the full argon2id-encoded
  string (includes salt + params).
- `verifyPassword(plain, stored): Promise<boolean>`.
- `generateToken(): string` — 32 random bytes, base64url-encoded (~43 chars).
- `hashToken(token): string` — SHA-256 hex. Only the hash is stored; the
  client holds the raw token.

New `packages/gateway/src/account/session_store.ts` — in-memory for MVP.
`Map<tokenHash, { userId, expiresAt }>`. On login: generate token, store
hashed form, return raw to client. On validate: hash incoming, look up, check
expiry. Token TTL: 7 days, rolling. Revocation is store removal.

Rationale for in-memory first: session state doesn't need to survive gateway
restarts (users re-login), and a single gateway process is the MVP shape. A
persistent sessions layer can be added later without changing the API.

Done when: a hashed password round-trips through verify; a generated token
validates exactly once per value; expired tokens reject.

### T-112 · HTTP endpoints — client-facing and server-to-server
Effort: M   Status: done   Commit: 0a290dc

New `packages/gateway/src/account/endpoints.ts`. Routed from the existing
`handleRequest` in `server.ts` under the `/account/*` prefix.

Client endpoints (authenticated by session token in `Authorization: Bearer`):
- `POST /account/register`    body: `{ loginName, password }`
                              → 201 `{ userId, token }`
                              → 409 if loginName taken
- `POST /account/login`       body: `{ loginName, password }`
                              → 200 `{ userId, token, activeDynastyId, lastTileId }`
                              → 401 on bad creds
- `POST /account/logout`      → 204 (invalidates the bearer token)
- `GET  /account/me`          → 200 `{ userId, loginName, settings,
                              activeDynastyId, lastTileId }`
- `PATCH /account/me/settings` body: arbitrary JSON object
                              → 204 (merged into settings, atomic)

Server-to-server endpoints (authenticated by `X-Voxim-Service-Secret`
matching a shared env var; no token):
- `GET  /internal/session/:token`     → `{ userId, activeDynastyId, lastTileId }`
                                      Used by gateway handshake; takes the raw
                                      token, not the hash, for operational
                                      simplicity.
- `GET  /internal/user/:userId/heritage` → heritageCodec payload as
                                      `application/octet-stream`
- `POST /internal/user/:userId/death`  body: `{ killerId?, cause }`
                                      Advances `HeritageData.generation`
                                      and appends a trait per the current
                                      `HeritageStore.recordDeath` logic.
                                      → 204
- `PATCH /internal/user/:userId/location` body: `{ lastTileId }` → 204

Done when: curl against each endpoint with the right auth produces the
expected status + body; wrong auth returns 401; malformed bodies return 400.
The server-to-server secret is read from `VOXIM_SERVICE_SECRET` env var and
the gateway refuses to start without it.

### T-113 · Gateway handshake requires a session token
Effort: S   Status: done   Commit: 1125d71

Kill the auth stub at `packages/gateway/src/session.ts:48-49`
(`// Auth stub — always accept`).

Protocol change in `@voxim/protocol`:
- `GatewayConnectRequest` gains `token: string` (required).
- `GatewayErrorResponse.code` gains `"unauthenticated"`.

In `handleGatewaySession`:
- Read `req.token`, hash it, look up in SessionStore via the `/internal/
  session/:token` endpoint (or directly against the store — the endpoints
  file exports the store).
- If invalid/expired: respond `{ type: "error", code: "unauthenticated" }`.
- If valid: use `session.userId` (not a generated playerId); resolve tile via
  `TileDirectory.tileForPlayer(userId)` with `userId` as the routing key.
- Carry `userId` through the `tile` response so the client passes it to the
  tile server on WT connect.

Done when: a client that presents no token or a bad token is refused; a
client that presents a valid token is routed to the tile identified by its
user record's `lastTileId` (or default tile if null).

### T-114 · Delete HeritageStore; tile-server becomes an account-service client
Effort: M   Status: done   Commit: 49c1c49

Tile server now also re-validates the session token in TileJoinRequest
against the gateway's /internal/session endpoint. Prevents a client that
skips the gateway (direct WebTransport) from claiming any userId.

- Delete `packages/tile-server/src/heritage_store.ts` and
  `@voxim/tile-server`'s export of `HeritageStore` from `mod.ts`.
- Add `packages/tile-server/src/account_client.ts` exposing:

  ```
  class AccountClient {
    constructor(baseUrl: string, serviceSecret: string)
    async getHeritage(userId): Promise<HeritageData | null>
    async recordDeath(userId, killerId?, cause): Promise<void>
    async updateLocation(userId, tileId): Promise<void>
  }
  ```

  Sends `X-Voxim-Service-Secret` on every call. Uses
  `heritageCodec.decode()` on the response bytes — no JSON parse.

- `spawnPlayer` (and its callers) take `AccountClient` instead of
  `HeritageStore`. On player join, `await accountClient.getHeritage(userId)`
  replaces `heritageStore.get(dynastyId)`. `maxHealthFor` moves into a
  pure function that takes `HeritageData` as input (no store dependency).

- `TileServer.handleSession` disconnect path: `accountClient.recordDeath(userId, …)`
  replaces `heritageStore.recordDeath(...)`. Make that call `await`ed (the
  path is already async).

- New `TileServerConfig.gatewayUrl` (already exists) +
  `TileServerConfig.serviceSecret` (new) wire the client.

- The `dynastyId` concept inside the tile server goes away for tracking
  purposes — the `Heritage` component still carries it (that's wire-facing
  data) but it comes from the `getHeritage` response, not from a local map.

Done when: `grep HeritageStore packages/` returns nothing; player death on a
tile posts to the gateway and a restart of the tile server preserves the
dynasty's generation count; no tile-local persistence of heritage remains.

### T-115 · Client login UI + connect flow
Effort: M   Status: done   Commit: b91928f

Currently the client connects to the gateway with no credentials. After this
ticket, the client acquires a session token via HTTP then uses it in the
WebTransport handshake.

- Add `packages/client/src/ui/login.ts` rendering a minimal login/register
  form. Two fields (loginName, password), two buttons.
- On login success: store the token in `localStorage` (acceptable for MVP;
  XSS is not in scope until we have a moderation story).
- On page load: if a token exists, try `GET /account/me` first; if 200,
  skip the login screen and proceed to the game. If 401, clear the stored
  token and show login.
- `GatewayConnectRequest` — populate `token` from storage. On
  `"unauthenticated"` response, clear token and re-show login.

Served by the gateway (via `/account/login.html` or just served alongside
the existing game client asset bundle). Match the existing theme CSS —
bare minimum, no framework.

Done when: a fresh browser session asks for login; after register, the
player connects to the game; after a death and reconnect the player's
heritage is visible (generation + bonus max-health applied).

---

**Out of scope for T-110–T-115 (explicitly deferred):**
- Email verification, password reset, OAuth — T-11x future tickets.
- Rate limiting on login / registration — add when we care about brute-force.
- Persistent session store — add when gateway horizontal scaling matters.
- Account deletion / GDPR-style export — add when we have a privacy policy.
- Admin tools (ban, reset, promote) — separate ticket line.
- `deno task inspect-user` CLI — nice to have, T-116 candidate.

---

## Multi-process architecture (Postgres + coordinator)

These tickets implement the cross-process architecture described in
`ARCHITECTURE.md`. They land in order — each phase produces something
runnable. They supersede / replace the older Gateway tickets T-051, T-052,
T-053, T-054, T-055 by giving them concrete substrates; the originals stay
as the gameplay-level acceptance criteria.

### T-132 · Postgres + docker-compose dev stack
Effort: M   Status: done   Commit: 7dc0764

Stand up the multi-process dev environment. No behaviour change yet — gateway
and tile-server still run with their existing in-memory / file-based state;
this ticket only puts the substrate in place so subsequent tickets can move
state into Postgres.

- Add `docker-compose.yml` with services: `postgres` (postgres:16, named
  volume `voxim-pg-data`, port 5432:5432), `certs-init` (one-shot, populates
  named volume `voxim-certs` by running `scripts/gen_certs.ts`).
- Add `docker-compose.dev.yml` overriding gateway/tile/coordinator services
  to bind-mount `packages/` and run with `deno run --watch`.
- Add `Dockerfile` per service (`gateway`, `tile-server`, `coordinator`,
  `client-dev`) — minimal, `denoland/deno:alpine` base, copy workspace,
  preload imports.
- Add `.env.example` with `POSTGRES_PASSWORD`, `VOXIM_SERVICE_SECRET`,
  `GATEWAY_URL`, `DATABASE_URL`. Real `.env` gitignored.
- Add `deno task compose-up` / `compose-down` helpers wrapping
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml`.
- Document the workflow in `ARCHITECTURE.md` (already present).

Done when: `deno task compose-up` brings up postgres + the existing services
unchanged, and `psql` to localhost:5432 succeeds.

### T-133 · `packages/db` — repositories + migrator
Effort: M   Status: done   Commit: 7dc0764

New workspace package. No consumers yet — that's T-134.

- `packages/db/deno.json` exporting `mod.ts`.
- `client.ts` — Postgres connection pool from `DATABASE_URL`, using
  `https://deno.land/x/postgres`.
- `migrate.ts` — forward-only migrator. Reads `migrations/*.sql` in numeric
  order, tracks applied versions in a `_migrations` table, applies pending
  ones inside a transaction. Runnable as `deno task migrate`.
- `migrations/0001_users.sql`, `0002_heritage.sql`, `0003_sessions.sql`,
  `0004_tile_registry.sql`, `0005_tile_saves.sql`, `0006_world_map.sql`,
  `0007_cities.sql` — schema per `ARCHITECTURE.md`.
- `repos/user_repo.ts`, `heritage_repo.ts`, `session_repo.ts`, `tile_repo.ts`,
  `tile_save_repo.ts`, `world_map_repo.ts`, `city_repo.ts` — typed CRUD
  interfaces. No business logic, just SQL.
- Repos export interfaces + a default Postgres-backed implementation. Tests
  can substitute fakes.

Done when: `deno task migrate` against a fresh Postgres applies all migrations
cleanly; running it twice is a no-op; each repo has a smoke test that does
insert → read → update → delete against a real local Postgres.

### T-134 · Migrate gateway accounts/sessions/heritage to Postgres
Effort: M   Status: done   Commit: deac9cc

Replace the file-based `AccountStore` and in-memory `SessionStore` with the
DB repositories from T-133.

- Gateway depends on `@voxim/db`.
- `AccountStore` deleted. `AccountEndpoints` consumes `UserRepo` +
  `HeritageRepo` + `SessionRepo` directly.
- Login index file (`_index_by_login.json`) and `users/` directory removed.
- Token hashing / heritage encoding / atomic-write semantics preserved by
  moving them into `SessionRepo` / `HeritageRepo`.
- Session expiry sweep: a daily job (no-op for now via simple interval) that
  deletes expired sessions. Sessions still validate lazily on read.

Done when: register → login → reconnect → die → reconnect cycle works
end-to-end against Postgres. Old `data/accounts/` directory has no readers
left and can be deleted.

### T-135 · Tile registry to DB + heartbeat + TTL eviction
Effort: M   Status: done   Commit: 97566c2   (supersedes T-052)

Replace in-memory `TileDirectory` with `TileRepo`. Add the heartbeat lifecycle.

- Tile-server hits `POST /register` on startup (already does), then
  `POST /heartbeat` every 10s (new).
- Gateway sweeps `tile_registry` for rows with `last_heartbeat_at < now() - 30s`
  and removes them. Sweep runs on a 10s interval.
- `TileSpawner` interface defined in
  `packages/gateway/src/edge/tile_orchestrator.ts`. Only impl: `NoopSpawner`
  that throws "not implemented" — used when gateway receives a connect for an
  unregistered tile.
- Player→tile lookup goes through `TileRepo.findByPlayer()` (joins on
  `users.last_tile_id` for now; will become a separate table when handoffs
  are real).

Done when: tile registers, heartbeats, gets evicted on Ctrl-C; `psql` shows
the row coming and going.

### T-136 · Tile saves to Postgres
Effort: M   Status: done   Commit: e29aaa7

Move tile snapshots from disk to `tile_saves` table.

- `SaveManager` writes `payload` blob (existing VXM2 binary format) +
  `size_bytes` to `tile_saves` via `TileSaveRepo` on auto-save.
- Tile-server boot: `SELECT payload FROM tile_saves WHERE tile_id = ?` →
  if hit, restore; else generate from world map (T-138) or seed.
- Old file-based save path deleted. Local save files in `data/saves/`
  removed.
- Tile-server is now stateless on disk: kill the container, bring up a
  replacement with the same TILE_ID, picks up where it left off.

Done when: a tile-server with state runs, is killed, comes back up (same
TILE_ID), and the world is intact (terrain mutations, dropped items, NPC
positions).

### T-137 · `packages/coordinator` skeleton + privileged WT handshake
Effort: M   Status: done   Commit: cf60647

New service. Reuses `@voxim/engine` for ECS + tickloop. Connects to gateway
on startup as a privileged peer.

- `packages/coordinator/main.ts` — entry point, reads `GATEWAY_URL`,
  `VOXIM_SERVICE_SECRET`, `DATABASE_URL`.
- `coordinator/src/world.ts` — boots a `World` from `@voxim/engine`,
  ticks at 1 Hz.
- `coordinator/src/gateway_link.ts` — opens WT session to gateway, sends
  `{ kind: "coordinator", secret }` handshake on first frame, multiplexes
  events (down) and commands (up) on the reliable stream.
- Gateway recognises `kind: "coordinator"` and stores a single coordinator
  link slot. Rejects a second simultaneous coordinator. Disconnect → null.
- No real macro sim yet — just a tickloop logging "tick N" and an empty ECS
  world.

Done when: `docker compose up coordinator` brings it up, gateway logs
"coordinator connected", coordinator logs ticks.

### T-138 · World map: gen + persist + tile lookup
Effort: M   Status: done   Commit: 0324930   (replaces stub for T-056/T-060)

Coordinator generates the world map on first startup and persists it.
Tile-servers fetch their cell during terrain generation.

- Coordinator on startup: if `world_map` table empty, generate from a seed
  (env `WORLD_SEED`), pack to a binary blob, write one row.
- World map cell shape: `biome`, `elevation_tier`, `river_flag`, `road_flag`,
  `gate_positions[]`, `city_seed_flag`, `corruption_level`. One cell per
  tile (e.g., 64×64 grid → 4096 tiles).
- Gateway exposes `GET /internal/world/tile/{tileId}` (service-secret auth)
  that proxies to coordinator's WT command channel and returns the cell for
  that tile.
- Tile-server's terrain generator reads its world-map cell as input. Existing
  terrain-gen code adapts to consume biome/elevation/river/road as inputs.

Done when: the same TILE_ID always generates the same terrain across
container restarts; cells differ correctly per tile_id; rivers/roads/gates
align with the macro grid.

### T-139 · World event bus over WT (tile→coordinator + coordinator→tile)
Effort: M   Status: done   Commit: 2871ade   (supersedes T-045)

Real publish/subscribe over the WT streams established in T-135 and T-137.

- Define `WorldEvent` and `TileCommand` codecs in `@voxim/protocol`.
- Tile-server publishes `WorldEvent` (e.g., `PlayerCrossedGate`,
  `CaravanArrived`, `NpcKilled`) on its WT stream to gateway.
- Gateway routes events to the connected coordinator (if any).
- Coordinator emits `TileCommand` (e.g., `SpawnCaravan`, `DispatchNpc`,
  `ApplyCityState`) targeting a specific tile-id; gateway routes to that
  tile-server's WT stream.
- In-memory only; no durable replay table (deferred per `ARCHITECTURE.md`).
- Gateway's `worldEvents` `// TODO` stubs in `server.ts` deleted.

Done when: tile publishes a test event, coordinator's tickloop receives it
and logs; coordinator emits a test command, the targeted tile receives and
logs it.

### T-140 · Gate entities + handoff over the new substrate
Effort: L   Status: done   Commit: db38b68   (supersedes / completes T-053, T-054)

Now that registry, world map, and event bus exist, build the actual
multi-tile gate flow.

- Gate entities placed at world-map cell edges where adjacent cells share a
  road or natural border. Tile-server reads gate positions from its world-map
  cell during terrain gen.
- Player proximity → `GateApproached` event published to coordinator (for
  logging) and a server-side handoff trigger.
- Source tile: serialise full player entity (all components), `POST /handoff`
  to gateway with `destinationTileId`.
- Gateway: validate destination tile is registered, forward to destination
  tile's admin URL, on ack tombstone player's entry on source.
- Destination tile: `restorePlayer()` deserialises and inserts the entity;
  acks gateway.
- Gateway updates `users.last_tile_id`.
- Idempotency: source tile retries on ack timeout with a stable handoff key;
  gateway dedupes via in-memory in-flight map keyed by handoff key.

Done when: a player walks through a gate and continues play on the
destination tile; entity state survives (HP, inventory, dynasty); same
player can't be present on both tiles simultaneously (no double-spawn).

### T-141 · Client tile transition
Effort: M   Status: done   Commit: a0eb265   (supersedes T-055)

Client side of T-140. Receives `GateCrossing` from the state stream, opens
a new WT to the destination tile, replaces local world state.

- Server-side: just before tombstoning on source, send a final state-stream
  message `{ type: "gate_crossing", destinationTileAddress, destinationTileCertHashHex }`.
- Client: tear down WT, drop interpolation buffers + entity caches, open new
  WT to destination, run `TileJoinRequest` flow, re-initialise from first
  state message.
- Loading screen during transition (~1s typical).

Done when: client transitions between tiles seamlessly in dev compose.

### T-142 · CityState + utility-AI fallback
Effort: M   Status: done   Commit: 8231e91   (folds in T-044, T-047)

Coordinator gets actual macro behaviour, even without an LLM.

- `CityState` row created on first startup at each city seed location from
  the world map. Fields: personality (random init), goals (default mix),
  relationships ({}), inventory (small starting stock), event_log ([]),
  population_count.
- Utility-AI tickloop (slow, every 10 server ticks): maintain food
  production, keep guard posts staffed, dispatch caravan when surplus
  threshold crossed. Mutates `cities.state` and emits `TileCommand`s.
- Event log trimmed to last 200 entries on each write.

Done when: coordinator boots, cities exist in DB, utility AI moves them
forward in observable ways (event log accumulates, caravan commands fire to
tiles).

### T-143 · `packages/ai-manager` skeleton + LLM call shape
Effort: M   Status: done   Commit: 374d7de   (lays groundwork for T-046, T-050)

Separate process. Stub LLM responses initially (echo a deterministic
response) so the coordinator integration is testable without API costs.

- `packages/ai-manager/main.ts` — Deno HTTP server.
- `POST /agent/city` — accepts a `CityContextPacket`, returns
  `{ tool_calls: [...] }`. Initially: deterministic mock response keyed on
  the most recent event.
- Coordinator gains an `AIManagerClient` that POSTs to it on significant
  events (rate-limited to one call per city per significant event).
- `AI_MANAGER_URL` env var; absent → coordinator skips and uses utility AI
  only (T-142).
- Real Anthropic call deferred to a future ticket — this one only proves
  the wiring.

Done when: significant in-game event in a city → coordinator POSTs to AI
manager → manager returns mock tool calls → coordinator validates and
applies them via `TileCommand`s.

### T-145 · Gate visual marker + label
Effort: S   Status: done   Commit: 45f1043

Without a visible cue, the player has no way to find a gate — gates were
server-only entities at fixed edge positions, and the proximity trigger
fired once they happened to walk within 4 units. T-141's reconnect path
proves out only with a way to actually reach a gate.

- Promote `GateLink` to networked: add `wireId`, move codec to `@voxim/codecs`.
- Always include gate entities in every player's AoI (≤4 per tile, trivial
  cost) so the player sees them from spawn.
- Client decodes `gateLink` into ClientWorld and the renderer draws a
  pillar with an edge-coloured capstone at each gate's position.
- WorldOverlay shows a "→ {destinationTileId}" label anchored above the pillar.

Done when: a fresh client sees pillars on its tile's connecting edges,
walks to one, and the existing T-140/141 handoff carries them across.

---

**Out of scope for T-132–T-143 (explicitly deferred):**
- Multi-gateway replication.
- Multi-coordinator sharding of macro sim.
- `DockerSocketSpawner` / dynamic tile-spawning by gateway. Slot-based
  scaling sufficient for solo dev.
- Per-tile world-map override layer.
- Durable `world_events` log with replay.
- Live tile migration between hosts.
- Real LLM API integration (separate ticket once T-143 wiring proves out).

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

### T-173 · BoneDef rest rotations + correct retargeting math
Effort: M   Status: done   Commit: 6e260e9

Add `restRotX/Y/Z` (Euler XYZ radians, parent-local frame) to `BoneDef`,
default 0/0/0 (forward-compatible — existing identity-rest skeletons
unchanged). Solver falls back to `restRot` for bones the clip omits, so
rest pose / sparse clips show the bind not identity.

Convert_anim.ts retargeting fixed from pre-multiply (`B^-1 * A`) to
post-multiply (`R = A * B^-1`). Pre-multiply produces a rotation of the
correct magnitude but expresses it in the source bind's local axes —
visually fine for symmetric bipeds close to T-pose, breaks for asymmetric
or non-identity bind chains (rotten knight's giant arm exposed this).
Post-multiply is the correct retargeting transform for identity-rest
targets: `target_world = parent_world * R = parent_world * A * B^-1`,
which differs from source's `parent_world * A` only by `B^-1` — exact
when source/target binds match (T-179 work), good approximation
otherwise. Removes the 47° "zombie reaching" amplification on rotten
knight's right arm.

Originally scoped as "drop bind subtraction entirely" + "encode source
bind in target's restRot". Tested empirically — that path requires
rewriting our translation convention (source rig uses near-zero
translations + bone-local-axis positioning; we use entity-local Z-up
translations + voxel models authored along world axes). Deferred to
T-179 where canonical biped + voxel models can be authored together.
T-173 ships the schema + correct retargeting math; existing skeletons
keep identity rest; clips re-imported with the corrected formula.

Done: schema field added; solver falls back to restRot; convert_anim.ts
post-multiplies; drowner + rotten_knight clips re-imported (8 clips);
type-check clean; bone world positions sane (feet near ground, hands at
chest height instead of flying above the head).

### T-174 · ContentRegistry<T> primitive + tag indexing
Effort: S   Status: done   Commit: 86e435a

Generic id-keyed registry primitive in `@voxim/content`:

  get(id) | getOrThrow(id) | has(id) | byTag(tag) | forEach() | size

Tags declared per item via optional `tags: string[]` on the schema; registry
maintains a reverse `Map<tag, Set<T>>` populated on register. Validation hook
(per-type schema check) called on register. Smoke-test by tagging existing
materials (`metal` / `flesh` / `wood`) and verifying `byTag` queries.

Building block for T-175. No engine call-site changes yet.

Done when: `ContentRegistry<T>` exists with unit coverage; materials have
tags; `byTag("metal")` returns the iron / steel / copper / worn_iron rows.

### T-175 · Federate ContentStore into typed registries
Effort: L   Status: done   Commit: e48cd39+e4c0e5c

Refactor `ContentStore`'s ~30 ad-hoc `get*` methods into a federated shape:

  store.materials, store.skeletons, store.models, store.prefabs,
  store.verbs, store.loreFragments, store.weaponActions, store.recipes,
  store.zones, store.tileLayouts                — ContentRegistry<T>
  store.gameConfig, store.terrainConfig, store.conceptVerbMatrix
                                                — singletons

Engine call sites updated: `content.getPrefab(id)` → `content.prefabs.getOrThrow(id)`.
Old methods deleted (no shim, per refactor philosophy).

Top-level package layout uses namespace re-exports for call-site clarity:

  // packages/content/mod.ts
  export * as registries from "./registries.ts"
  export * as generators from "./generators/index.ts"
  export * as algorithms from "./algorithms/index.ts"
  export { ContentService, type Prefab, ... } from "./service.ts"

Consumers write `import { registries, generators } from "@voxim/content"` then
`registries.prefabs.getOrThrow(id)` / `generators.names.invoke(...)`.
Modules stay side-effect-free so esbuild's default tree-shaking still prunes
unused namespace members on the client. Subpath exports
(`@voxim/content/generators`) deferred until measurable need.

Sequenced behind T-174 since registries are the building block. Touches every
package that consumes ContentStore, but each call-site change is mechanical.

Done when: every consumer reads via the federated shape; old getters gone;
`deno check` clean across all packages; runtime behavior unchanged.

### T-176 · ContentService interface + JsonSource
Effort: M   Status: done   Commit: d8398ee

Extract `ContentService` interface in `@voxim/content` describing the read
surface (federated registries + `invoke()` for generators). Implementations:

  - `JsonSource`     — scans `data/**/*.json`, builds a `ContentService`.
                       Used by tile-server at startup.
  - `BootstrapSource` — hydrates from a binary blob (T-177).
                       Used by client.

Engine code consumes `ContentService`, never `ContentStore` directly.
JsonSource is the only on-disk reader; nothing else touches the filesystem.

Done when: tile-server constructs JsonSource at boot; engine accepts
ContentService; no `Deno.readDir` outside `JsonSource`.

### T-177 · Content bootstrap codec + WT handshake delivery
Effort: M   Status: done   Commit: 61f3c59+ebc1bc0+ac1c401

Binary codec serializes a fully-loaded `ContentStore` into a length-prefixed
blob (target ~1–5 MB compressed) with a content hash in its manifest.
Tile-server sends the blob immediately after `TileJoinAck` on the reliable
stream. Client's `BootstrapSource` (T-176) reads the length-framed blob,
decodes, hydrates an in-memory ContentStore.

Removes the client's compile-time content dependency: delete
`scripts/gen_content.ts`, delete the generated `*_static.ts` files, drop
static imports of JSON from `packages/client/`. Bundle shrinks; content is
always in sync with the server it just connected to. Hash in manifest sits
unused for now — enables future delta / cache strategies.

Done when: client receives content over WT handshake on every join;
`gen-content` deno task gone; tile-server restart → client reconnect →
fresh content visible without rebuild.

### T-178 · AnimationLibrary as peer registry (decouple from Skeleton)
Effort: M   Status: done   Commit: 9ae9484

Animation clips currently live as `clips: AnimationClip[]` inside
`SkeletonDef`, populated at load by splicing files tagged `_skeleton: "X"`
from `data/anim_library/`. Move them out:

  store.animationLibraries: ContentRegistry<AnimationLibrary>
  AnimationLibrary { archetype, clips: ContentRegistry<AnimationClip> }

Skeletons declare `archetype: "biped" | "quadruped" | …`. Folder layout:
`data/anim_library/{archetype}/{clipId}.json` — folder is authoritative,
`_skeleton` field dropped. Loader sweeps each archetype subfolder, builds
one library per archetype. Multiple skeletons of the same archetype share
clips by reference (no duplication, as we currently do for drowner →
rotten_knight).

Animation system / skeleton evaluator look up clips via
`store.animationLibraries.getOrThrow(skeleton.archetype).clips.get(clipId)`.
Splice machinery in `anim_library.ts` deleted.

Done when: drowner_*.json and rotten_knight_*.json consolidated into one
biped library; both creatures animate from the shared library; no
`_skeleton` field anywhere; clip-splice code path gone.

### T-179 · Canonical biped skeleton + full UAL2 clip suite
Effort: M   Status: done   Commit: 9cb79df

Author `data/skeletons/biped.json` from the UAL2 bind directly: 17 bones
using UAL bone names (pelvis, spine_01/02/03, neck_01, Head, clavicle_l/r,
upperarm_l/r, lowerarm_l/r, hand_l/r, thigh_l/r, calf_l/r, foot_l/r),
translations from `inverseBindMatrices` decomposition, restRot from bind
quaternion (T-173). `archetype: "biped"`.

Morph params: `legLength`, `armLength`, `torsoHeight`, `shoulderWidth`,
`headSize`, `hipWidth`, plus per-side variants (`rightArmScale`,
`leftArmScale`, `rightLegScale`, `leftLegScale`) for asymmetric monsters.

Import ~20 UAL2 clips into `data/anim_library/biped/`: idle, walk, run
(Walk_Carry_Loop), jump_start/loop/land, slide, melee_hook, sword_combo,
hit_knockback, death, idle variants. No `_skeleton` field — folder placement
is authoritative (T-178).

Done when: biped skeleton + library load via JsonSource; sample biped NPC
plays distinct walk vs. run vs. attack from library clips; AnimationSlots
mappings resolve cleanly.

### T-180 · Migrate creatures to biped via morphs (retire one-off skeletons)
Effort: M   Status: done   Commit: cc615c1

Drowner, rotten_knight, human, bandit, archer, villager all migrate to
`skeletonId: "biped"`. Per-prefab morph values express proportions:

  drowner       { armLength: 1.4, legLength: 0.85, headSize: 1.1 }
  rotten_knight { torsoHeight: 1.1, rightArmScale: 1.5, … }
  human         { } (defaults)

Per-side morph application: extend the morph applier in
`skeleton_solver.ts` to scale single bones (not bilateral) when the param
targets an `_l`/`_r` suffix bone. Voxel parts updated to match canonical
biped offsets.

Delete `skeletons/drowner.json`, `skeletons/rotten_knight.json`, and
`skeletons/human.json` (the latter only if all human prefabs migrate
cleanly). `skeletons/wolf.json` untouched — different archetype.

Done when: every humanoid creature uses biped + morphs; old per-creature
humanoid skeleton JSONs deleted; rotten_knight's giant arm renders correctly
without authoring a separate skeleton.

### T-181 · Behavior tree runtime in @voxim/content + first BT as data
Effort: L   Status: todo

Move behavior-tree concepts from `tile-server/src/systems/npc_ai.ts` into
`@voxim/content` as a generic engine algorithm. Schema for `BehaviorTreeDef`:

  Composite nodes: sequence, selector, parallel
  Decorator nodes: invert, repeat, succeed-on-fail, cooldown
  Leaf nodes:      declarative action references (find_target, move_to,
                   attack_target, idle_wait) that resolve against an
                   ActionRegistry the host process supplies

Tree definitions live at `data/behavior_trees/{id}.json`. Migrate the
"hostile" tree (currently hardcoded in npc_ai.ts) to data. NPC templates
already reference `behaviorTreeId`; the lookup goes through
`content.behaviorTrees.getOrThrow(id)`.

Algorithm/data split: tree TICK runtime in `@voxim/content` (engine code),
tree DEFINITIONS in JSON (data), leaf ACTION implementations in tile-server
(registered with the runtime). Adding a new AI archetype = one JSON file.

Done when: hostile tree loads from data; NPC AI ticks against the loaded
tree; adding "skittish" or "patrol" archetypes is a content-only change
with no code edits.

### T-182 · State machine runtime + animation state machines as data
Effort: M   Status: todo   Plan: ANIMATION_SM_PLAN.md

State machine concepts (currently buried in animation slot indirection plus
ad-hoc velocity-checks in `animation.ts`) move to `@voxim/content` as a
generic runtime. Schema for `StateMachineDef`:

  states:      { id, onEnter?, onExit?, layers? }
  transitions: { from, to, condition: ConditionExpr, priority }

`ConditionExpr` is a small data-driven expression: comparisons on entity
component values (`velocity.magnitude > 4`, `health.current / health.max < 0.3`,
`isOnGround === true`), boolean composition. Evaluated each tick.

Existing animation slot logic refactored into a state machine
(`humanoid_default`) with idle/walk/run/death/attack states. NPC templates
declare `stateMachineId: "humanoid_default"`.

Done when: animation transitions resolve via SM tick (not hardcoded velocity
comparisons); two NPCs sharing an SM share behavior; per-prefab SM override
is one JSON field flip.

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
Effort: L   Status: todo

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

### T-191a · Devtools shell + 3D viewport + asset browser + file IO
Effort: M   Status: done

Foundation for all later phases. No game-content awareness.

  shell/        common framework — top-bar route switcher, multi-pane
                layout, theme.
  3d viewport   Three.js scene primitives wrapped in a Preact
                component: orbit/pan/zoom camera, grid, ground plane,
                lighting rig, gizmos (translate/rotate/scale handles),
                framing controls.
  asset browser file tree under packages/content/data/ with type
                filters; reads JSON, edits in-place via shared file-IO
                helpers that write back to the same bind-mounted
                source tree.
  file IO       read/write/list endpoints on the dev server so the
                tool can persist edits directly to disk.

Done when: starting the devtools shows an empty viewport with the
asset browser populated from data/, clicking a JSON file opens it as
text (preview placeholder for the editor that'll replace it), and
saving the file from the tool round-trips to disk.

### T-191b · Voxel editor — Layer A (scene tree, voxels, sub-objects)
Effort: M   Status: in-progress

v1 delivered: file pick → load + render model in viewport (instanced
voxels by material), scene tree (model + voxels-by-count + sub-object
rows), inspector with material remap palette and sub-object identity /
transform / boneId editors, add/remove sub-object actions, Save → write
back to models/<id>.json.

v2 deferred (will land iteratively):
  - 3D translate/rotate/scale gizmos in the viewport for sub-objects
  - interactive voxel painting (click to add, shift-click remove)
  - generator-node spawning (waits on T-183)
  - bone-attachment preview when editing a sub-object's boneId

The model-as-Godot-scene-tree editor. Operates purely on
ModelDefinition; zero prefab / weapon-action knowledge.

UI:
  scene tree    left pane, hierarchical: voxel block | sub-object
                | generator-node (T-183). Selection drives the
                viewport gizmo.
  viewport      3D model + gizmo handles for selected node's
                transform, voxel-cell paint mode with material
                picker.
  materials     palette pinned to right, sourced from
                data/materials/.
  inspector     bottom pane — selected node's properties (position,
                rotation, scale, material, sub-object reference,
                generator id + params).

Save writes the ModelDefinition back to data/models/{id}.json.
Generators (when T-183 lands) appear as a node type that bakes its
voxels at save time; until then, only authored voxel blocks and
sub-object references are available.

Done when: opens any data/models/*.json, lets you place / move /
edit voxel cells and sub-objects, saves back to the same file, and
the result loads cleanly into the game client.

### T-191c · Animation editor — Layer A (clip player + skeleton view)
Effort: M   Status: in-progress

v1 delivered: pick a SkeletonDef from skeletons/, get a clip list for
its archetype, click a clip → loads it and plays on the rendered bone
skeleton. Timeline scrubber + play/pause/loop/speed controls.
Inspector shows per-bone keyframe count + flags clips that reference
bones not in the loaded skeleton.

Skeleton view renders one cylinder per parent→child bone + joint
spheres, with restRot + restPos in bone-local frame matching the
engine's FK pipeline. Clip sampling reuses shortest-arc Euler
interpolation (same math as engine animation_eval.ts) — a deliberate
local copy keeps Layer A free of game-content imports.

v2 deferred:
  - multi-layer playback (locomotion + combat etc.) with masks
  - mesh model toggle (render biped_skeletal or another voxel model
    bound to the same skeleton, alongside the bone overlay)
  - keyframe edit (drag a keyframe time, edit per-bone Euler at
    selected time, insert new keyframe)

Pure animation tooling — load any SkeletonDef + clips from the same
archetype, play them on the skeleton, no game content required.

UI:
  skeleton view 3D bone overlay on the selected skeleton (bones
                rendered as cylinders + joint dots), optional voxel
                model from data/models/* bound to the same
                skeletonId.
  clip browser  list of clips in the archetype's library; preview
                clip metadata (duration, looped, bone tracks).
  player        play / pause / scrub / loop / speed; multi-layer
                playback (locomotion + combat etc.) with per-layer
                mask + weight + blend mode controls, mirroring
                AnimationLayer in the engine.
  timeline      shows keyframe density per bone, layer overlays.

Done when: pick a skeleton + a clip, see it play on the bones; swap
the bound voxel model and watch the same clip animate the new
geometry; stack two layers with masks and observe the composed pose.

### T-191d · Devtools Layer B — game-content overlays
Effort: M   Status: done

v1 delivered: animation editor gains two Layer-B side tabs alongside
the existing Clip inspector.

  Equipment — lists prefabs that declare an `equippable` component
  bucketed by slot. Pick one for weapon (hand_r) or off-hand (hand_l)
  and the studio attaches its voxel model to that bone, using the
  weapon's primary swingable.chain[0].light → WeaponActionDef.blade
  (baseLocal / tipLocal) for the same FK-driven attachment math the
  game renderer uses. Bottom-anchor offset + modelScale match too.
  Authors see in-engine attachment fidelity in the studio.

  SM driver — pick a state machine from `state_machines/`, compile +
  tick at 20Hz via the engine's compileStateMachine / smTickAll,
  toggle input bits (use_skill / block / jump / dodge / crouch / aim
  / skill_1..2) and fire one-tick events (swing_started / shoot_fired
  / left_ground / landed / hit / hit.heavy / hit.from_front /
  hit.from_back / maneuver_started / maneuver_ended). Live readout
  of layer node + elapsed. When the SM-driver tab is active, the
  studio routes pose updates through the SM: highest-priority
  animation-output layer's current clip is resolved against the
  base playable_character slot map and sampled to drive the
  skeleton.

  Content-loader shell (`shell/content_loader.ts`) provides the Layer-B
  HTTP-fetch helpers (prefab tree walk, weapon action / SM / maneuver
  by id). Pure data — no @voxim/content imports beyond the
  compile/tick functions, which are themselves data-only evaluators.

v2 deferred:
  - maneuver picker tab (fire a ManeuverDef, watch the timeline)
  - scene-preview overlay for the voxel editor (ground + lighting +
    optional skeleton + weapon-in-hand)
  - weapon trail rendering in the SM driver path (replicates the
    engine's trail recording for clip authors)

Add the game-content shell on top of A. Both editors gain a "scene
preview" mode that loads ContentService (same path JsonSource does)
and treats the artifact as if it were in-game.

Voxel editor preview: spawn the model on a small scene (ground plane
+ lighting + optional skeleton + optional weapon-in-hand attachment
via a prefab picker), orbit camera, screenshot button.

Animation editor preview: full actor sandbox.
  equipment   drag-drop items from a prefab browser into weapon /
              off-hand / armor slots; visible attachments respond.
  state-machine driver
              buttons for every input bit + event flag the actor's
              SM reads; live readout of layer states + elapsed.
  maneuver    fire any ManeuverDef and watch the timeline tick
              (clip changes per hand, locomotion impulses, hit-tag
              windows).

Done when: dropping an iron_sword onto a sandbox actor shows the
weapon attached and animated through every clip in the library; the
SM driver can take the actor through swing.windup → stop → active →
winddown by toggling input.use_skill; firing double_strike plays
the maneuver visibly end-to-end.

### T-191e · Weapon sweep debugger + per-clip attachment overrides
Effort: M   Status: todo

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
Effort: S   Status: todo

After T-191b reaches feature parity (cell placement + sub-object
placement + material picker + save round-trip), delete
packages/devtools/src/voxel-editor/ wholesale. No shim, no
deprecation marker — refactors replace.

Done when: old voxel-editor directory is gone, devtools serves only
the new app, build still green.

### T-184 · Per-hand combat layers in CSM
Effort: S   Status: done

Replace the single `combat` SM layer (mask: upper_body) with two arm-masked
layers (`right_hand`, mask: right_arm; `left_hand`, mask: left_arm). Add
`right_arm` / `left_arm` bone masks on biped.json. Right-hand layer carries
all existing combat states (idle, swing.windup/active/winddown, block, aim,
shoot); swing.* states override mask to upper_body so two-handed swings
still engage the torso. Left-hand layer ships with `idle` only — it is the
landing pad for off-hand maneuvers (T-185) that come next. Server code that
read csm.combat.{node,elapsed} is renamed to csm.right_hand.{node,elapsed}
across action.ts, animation.ts, durability.ts, terrain_hit_handler.ts,
health_hit_handler.ts, and the bench. No backwards-compat shim — combat
layer is gone.

### T-185 · Maneuver system (composable per-hand actions)
Effort: L   Status: in-progress

First cut delivered:
  - ManeuverDef type + content registry + JsonSource loader + bootstrap codec
    bumped to v5; sample `data/maneuvers/double_strike.json` ships.
  - Server: Maneuver server-only component (carries elapsed + resolved per-hand
    clipId + activeHitTags), ManeuverSchedulerSystem advances the timeline,
    selects active per-hand clips, applies `dash` locomotion impulses, and
    refreshes activeHitTags each tick.
  - SM: `right_hand` and `left_hand` layers gain an `in_maneuver` state with
    null clip; entering on `event.maneuver_started`, exiting on
    `event.maneuver_ended`, both fired by ManeuverScheduler / ActionSystem.
  - AnimationSystem injects Maneuver.{rightClipId,leftClipId} into the
    layer projection when the SM node is `in_maneuver` — the SM stays
    generic, the maneuver def drives the actual per-hand clip.
  - ActionSystem first-cut binding: ACTION_SKILL_1 fires `double_strike` if
    available; stamina-gated; locked out by Staggered / mid-swing / already
    in a maneuver.
  - HealthHitHandler reads attacker's Maneuver.activeHitTags on a successful
    hit and logs each tag (placeholder for the future effect resolver).
  - Interrupt windows enforced: ManeuverScheduler scans active windows each
    tick, checks input bits against the window's `by` list (dodge/block/
    jump/swing → ACTION_DODGE/_BLOCK/_JUMP/_USE_SKILL), and fires
    event.maneuver_ended early when a matching bit is held.
  - DodgeSystem skips input.dodge while a Maneuver is present — the
    scheduler owns dodge during a maneuver, converting it into an interrupt
    when the active window allows. Prevents dodging out of a committed
    move and avoids double-handling.
  - ManeuverLoadout server-only component (slots[4] of ManeuverDef ids)
    decouples skill-bit → maneuver. ActionSystem reads the loadout for the
    actor; ACTION_SKILL_1..4 → slots[0..3]. Player spawns with
    [double_strike, shield_bash, "", ""].
  - Second sample `shield_bash.json`: 0.6s, off-hand-only, 0.45-0.6
    interrupt window, stun tag, 15 stamina.
  - Maneuver blade trail bridge: AnimationSystem during `in_maneuver`
    populates `weaponActionId` from the equipped weapon's primary
    swingable action, and sets `ticksIntoAction` into the active window
    when `Maneuver.activeHitTags.length > 0`. Renderer's existing trail
    + blade-attachment paths now work for maneuvers without renderer
    changes — the FK-driven `evaluateBladeWorld` (already used by swings)
    handles the maneuver's animated arm pose because clips drive the
    hand bone matrix.
  - Sample maneuver catalogue (5 authored): `double_strike`,
    `shield_bash`, `whirlwind`, `leap_strike`, `quick_stab`,
    `kick_combo`, `prayer`. Each demonstrates a different shape — fast
    poke / committed combo / gap-closer / wide arc / off-hand bash /
    self-buff ritual — to exercise dual-hand tracks, locomotion dashes,
    multi-window hit effects, and varied interrupt-window patterns.
    Player default loadout is `[quick_stab, kick_combo, leap_strike,
    whirlwind]`.

Swing chargeable windup (T-185 follow-on, partly delivered):
  - SM right_hand layer's swing flow is now four-phase:
    `windup` (loops while ACTION_USE_SKILL held, max 5s, exits to idle
    on input.block) → `stop` (0.08s release pause) → `active` →
    `winddown`. `swing.windup → idle` on `input.block` (priority 100)
    cancels uncommitted swings; `!input.use_skill` (priority 60)
    releases the held charge into `swing.stop`; the original duration
    auto-fire still serves as a max-charge fallback.
  - isSwingNode / isSwingingNode helpers and AnimationSystem's
    cumulative ticksIntoAction calculation extended to recognise
    `swing.stop` as part of the swing window.

Still TODO under T-185:
  - Charge-on-release variant pickup (re-pick weaponActionId from
    accumulated windup elapsed at the moment swing.windup → swing.stop
    fires; today the variant is still picked at press time).
  - Real on-hit effect resolver behind the tag list (current
    HealthHitHandler logs them).
  - Per-PC loadout rebinding UI.

### T-190 · Per-character body variation (morphRanges)
Effort: S   Status: done

Every PC spawn now samples a unique body shape from per-prefab
`morphRanges` windows, so no two characters of the same prefab look (or
move) identical — but a given entity respawns/reloads identical because
the sample is deterministic per entity UUID.

Schema:
  Prefab.morphRanges?: Record<string, {min, max}>
  Inherits + shallow-merges through `extends` like morphValues.

Spawn:
  installVisualShell calls sampleMorphValues(prefab, seed) to mix
  explicit prefab.morphValues (authored overrides — win per key) with
  seeded samples from morphRanges. Result writes onto
  ModelRef.morphValues, already networked, so client and server see
  identical bodies.
  Per-key sub-seed = mix32(seed, hash32(key)) so adding a new morph
  doesn't shift previously sampled keys.
  Default seed = hash32(entityId) — UUID is server-persistent so
  reloaded NPCs look the same. Player spawns can override with a
  heritage-derived seed for cross-death continuity.

Layer 1 voxel scaling (T-186):
  entity_mesh.ts now multiplies each sub-object's voxel subScale by the
  parent bone's morph scale on the same axis. Stretching `armLength`
  by 1.1× now lengthens BOTH the elbow→wrist bone offset AND the
  visible forearm chunk in lockstep — no more visible joint gaps at
  morph extremes. Ground-clearance calculation reads the same morphed
  subScale so feet stay planted.

Authored ranges on `_playable_character` (~±10%):
  armLength 0.92–1.10, legLength 0.92–1.10, torsoHeight 0.95–1.08,
  shoulderWidth 0.90–1.15, hipWidth 0.92–1.12, headSize 0.95–1.05.
  Every PC inherits these unless they declare their own. Drowner +
  rotten_knight keep their explicit morphValues (asymmetric anchors)
  and inherit the ranges, so they get variation within those anchors.

Property: zero new data flow. Spawner reads existing morphRanges →
samples → writes existing ModelRef.morphValues. Wire format unchanged.
Renderer reads same field. Whole feature is "spawner sample + Layer 1
voxel-scaling extension". Layer 2 (procedural body recipes) remains
open under T-186.

### T-186 · Procedural character body generator (skeleton + voxel mesh)
Effort: L   Status: in-progress

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

### T-188 · Vermintide-style combo chains + heavy/light variant
Effort: M   Status: done

Each weapon carries an authored sequence of attacks that play out as the
player chains LMB presses together. Press during windup of swing N to
queue swing N+1. No grace window after winddown — let the swing finish
with no held input and the chain is gone, next press starts at index 0.
Block at any time also resets the chain. Hold LMB through the windup
past the weapon's heavy-charge threshold and the queued attack fires
its heavy variant instead of its light variant; release short → light.

Schema migration (replaces, not accretes):
  swingable.actions[]  → REMOVED
  swingable.chain      → ChainEntry[] with { light, heavy }
                         actionIds. Chain index wraps at end.
  swingable.heavyChargeMs → number, threshold (windup elapsed) above
                            which release fires heavy variant.

New server-only SwingChain component { index } — present iff the actor
is in a chain. Removed when chain breaks (winddown→idle without queue,
block, stagger, death, maneuver start).

ActionSystem changes:
  - On press with no SwingContext: install SwingChain{index:0} + start.
  - During active/winddown: if input.use_skill still held → mark
    SwingContext.queued.
  - On swing.windup→swing.stop fired: read csm.right_hand.elapsed,
    pick chain[index].heavy if elapsed >= heavyChargeMs/1000 else
    chain[index].light. Update SwingContext.weaponActionId — the new
    action's tick budgets drive swing.active and swing.winddown
    durations via existing $action.* scope vars.
  - On swing.winddown→idle fired: if queued, advance SwingChain.index
    (mod chain.length), reinstall SwingContext, refire
    event.swing_started; else remove SwingChain.
  - On any block firing: remove SwingChain.

Done when: pressing LMB three times rapidly with the iron sword plays
three different slashes in sequence; tap-tap-hold plays light, light,
heavy as the third; a momentary block during the second swing's
winddown resets so the next press fires slash[0] again.

### T-189 · Sidestep replaces roll
Effort: S   Status: done

Drop the dodge roll outright (Rolling component + sprinting_forward_roll
clip + dodge.roll SM state retire — refactors replace, no shim). New
Sidestep server-only component { ticksRemaining, vx, vy } — direction
from movement input at press time, default to facing-back if no
movement. Locomotion SM gains `sidestep` state replacing `roll`. Clip:
`esquiva_1` for one direction + mirrored variant for the other (or one
clip applied bidirectionally; the actual translation comes from the
velocity impulse, the clip provides body language).

Tuning: shorter than current roll (~0.25 s vs 0.7 s), shorter cooldown,
keeps i-frames during the ~half-duration that elapses inside Sidestep.
No rotation lock-in — character keeps facing the cursor through the
dash. dodge.staminaCost in game_config drops accordingly.

Done when: pressing dodge while moving left does a short left-hop with
a visible body lean; without movement, the actor hops backward; total
travel distance and i-frame coverage feel like Vermintide-class
sidestep, not Dark-Souls roll. The roll clip + Rolling component are
deleted, not deprecated.

### T-187 · Runtime dual-slot equip for hand items
Effort: S   Status: todo

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

A *maneuver* is the authored unit for any committed action (slash, stab,
shield-bash, prayer, throw, multi-step combo). Generalises the existing
WeaponActionDef so PCs and NPCs share authoring.

Shape:
  data/maneuvers/{id}.json — ManeuverDef
    duration                  — total locked window
    interruptWindows[]        — { fromT, toT, by: ["dodge","block",…] }
    tracks.left_hand[]        — { t, clip } scheduled events on left_hand layer
    tracks.right_hand[]       — same, right_hand layer
    tracks.locomotion[]       — { t, kind: "dash", forward, duration }
    tracks.hitEffects[]       — { tag, fromT, magnitude } — see notes below
    requirements              — stamina, weapon slot constraints

Runtime:
  - ActionSystem on input → install Maneuver payload component, validate
    requirements, fire event.maneuver_started.
  - CSM transitions right_hand (or both) to a generic `in_maneuver` state
    that locks until duration elapses or an interrupt window grants exit.
  - New ManeuverScheduler system advances Maneuver.elapsed each tick and
    emits events as tracks cross: SM scope variables for clip per hand,
    locomotion impulses to PhysicsSystem, hit-tag updates on Maneuver.
  - Hit handlers read Maneuver.hitTags (active for current elapsed) and
    apply on-hit effects.

hitEffects (effects layer): start with simple inline tags applied on hit.
Mark this as a placeholder — a richer effect system (status stacks,
duration, propagation) will replace this and is intentionally out of scope
for the first cut. The Maneuver-scheduler-emits-tags pattern survives the
later effect-system rework; only the resolver behind the tag changes.

Done when: a sample two-step `double_strike` maneuver lives in data,
firing it locks the player for its duration, plays a left-arm clip then a
right-arm clip with a forward dash, and applies a "bleed" tag on hit. Both
PC and an NPC can be authored to use the same ManeuverDef.

### T-200 · Per-bone hitbox fallback for skeletal-viz models
Effort: S   Status: done

`biped_skeletal` (and any future skeletal-viz model) authors every
bone_segment sub-object with `hitbox: false` — they're purely visual.
`deriveHitboxTemplate` consequently produced zero parts for every PC
that uses `biped_skeletal`, and the entity had no hittable volume.

Add a skeleton-driven fallback inside `deriveHitboxTemplate`: when the
sub-object loop yields nothing AND the model declares a `skeletonId`,
emit one bone-local capsule per bone — origin → first-declared child's
rest offset for non-terminals, fixed nub along bone-local +Y for
terminals. Radius from a per-bone table (matching `build_skeletal.ts`),
falling back to `DEFAULT_BONE_RADIUS` for unknown bones. The capsules
are anchored to the parent bone, so live `applyHitboxTemplate` continues
to wrap them in the bone's world transform every tick.

`HitboxContentAdapter` gains an optional `getSkeleton(id)` — both
adapter callsites (server `StaticContentStore`, client `ContentCache`)
wire it through.

### T-201 · Weapon trail fires only during swing.active
Effort: XS   Status: done

The 4-stage swing flow (windup → stop → active → winddown) mapped
`ticksIntoAction` for the windup hold and stop pause into the renderer's
[windupTicks, windupTicks+activeTicks) trail window, so the trail
accumulated stationary slices before the blade ever moved. LMB swings
looked broken; skill-fired maneuvers worked because the maneuver bridge
only seeds ticksIntoAction inside the active window.

Set ticksIntoAction = 0 during swing.windup and swing.stop (pre-active);
keep cumulative values for swing.active and swing.winddown.
`weaponActionId` still propagates so the weapon-attachment math (which
keys off weaponActionId, not ticksIntoAction) stays aligned with the
swing pose.

### T-202 · Player + NPC scale tuning
Effort: XS   Status: done

Player `modelScale` was bumped to 2.4 during skeletal-viz testing; halve
it (1.2) so the character matches the world scale. Author per-NPC
`modelScale` to nudge the biped humanoids slightly above the player —
archer/bandit/merchant/villager 1.4, drowner 1.35, rotten_knight 1.5,
wolf 1.3. Existing morphRanges keep silhouette variation on top.

---

## Ops & Deployment

### T-158 · CI image publish + production compose
Effort: S   Status: done   Commit: db7c589

Until now there was no path from a green build to a deployable artifact —
the sysadmin would have had to clone the repo, run `docker compose build`,
and reason about source state on the host. Replace that with a registry-
based deploy: GitHub Actions builds and pushes every server image, the
sysadmin runs a compose file that only references images.

- `.github/workflows/docker-publish.yml`: manual `workflow_dispatch` trigger.
  Matrix builds all six images (gateway, coordinator, atlas, tile-server,
  certs-init, client-dev) in parallel, pushes to
  `ghcr.io/<owner>/<repo>/<service>`. Every build gets `:sha-<short>`;
  runs whose ref is `main` (or that pass `tag_latest=true`) also update
  `:latest`. Auth via `GITHUB_TOKEN` with `packages: write` — no extra
  secrets. GHA cache wired per-service so reruns are fast.
- `docker-compose.prod.yml`: mirrors the base compose service shape but
  replaces every `build:` with an `image:` reference parameterised by
  `VOXIM_IMAGE_REPO` (default `ghcr.io/the-sidner/voxim`) and `VOXIM_TAG`
  (default `latest`). Drops dev-only bind mounts. Sysadmin keeps a
  populated `.env` and runs
  `docker compose -f docker-compose.prod.yml --env-file .env up -d`.
  To pin a specific build set `VOXIM_TAG=sha-<short>` before `pull && up -d`.
- `.env.example`: document the two new variables.

Done when: a manual workflow run produces six ghcr.io tags, the sysadmin
pulls them on a clean host with only `docker-compose.prod.yml` + `.env`,
and the stack comes up identically to the dev compose.

