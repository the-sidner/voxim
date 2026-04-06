# Plan: Skill-Based Combat System (revised)

## The three-layer architecture

These three layers are independent. They compose at runtime. Do not conflate them.

### Layer 1 — Action physics (the swing)
The `attack` action is **innate**. Every character has it. No Lore required.
It has phases: **windup → active → winddown.**
- Windup: attacker is committed, no damage, animation telegraphs.
- Active: hitbox is live N ticks. Base weapon damage applies on connect. Each target hit once.
- Winddown: recovery, vulnerable.

What drives the action physics: **weapon type** (timing, hitbox shape, animation style). Not skills. Not fragments.

### Layer 2 — Skill composition (the lore layer)
A skill slot holds `{ verb, fragment1Id, fragment2Id }`.

The **verb** maps to an action type:
- `strike` — fires when a `attack` hitbox connects (melee augment)
- `invoke` — a standalone channeled action (not tied to the weapon swing)
- `ward`   — self-buff, instantaneous or sustained
- `step`   — fires when dodge executes

The `concept_verb_matrix.json` entry for `[verb][f1.concept][f2.concept]` gives:
- `effectType`, `effectStat`, `targeting`, `range`
- `outwardScale` (effect strength per unit of f1.magnitude)
- `inwardScale` (cost strength per unit of f2.magnitude)
- `staminaCostBase`, `healthCostBase`, `cooldownTicks`, `durationTicks`

The **balance formula** (from spec):
```
effect_power = f1.magnitude + action.baseMagnitude
cost_power   = f2.magnitude
ratio        = cost_power / effect_power
→ ratio >= 1.0 : full effect (amplified further above 1.0)
→ ratio <  1.0 : effect scaled down proportionally
```

Fragment magnitudes live in `lore_fragments.json` (1–5). Action `baseMagnitude` is defined per verb in `concept_verb_matrix.json` (implicit) or in a new `verbs.json` config.

### Layer 3 — Effect execution
Effects fire through **`ActiveEffects`** — that component already exists and is the correct abstraction.

Currently handled: `damage_boost`, `shield`.
New types to implement: `drain_life`, `area_damage`, `poison_aura`, `fear_aura`, `speed_boost`, `heal`.

Each effectType has one handler function. No switch statement inside a system — a handler registry keyed by effectType string.

---

## What exists that must be preserved

- `LoreLoadout` component — which fragments the character *knows internally*. Already networked. Do not remove.
- `ActiveEffects` component — already handles timed effects. Do not remove, extend it.
- `concept_verb_matrix.json` — already has verb×concept×concept → effect rows. Do not restructure, extend.
- `lore_fragments.json` — already has 18 fragments. Extend, do not restructure.

---

## New content data to create

**`packages/content/data/verbs.json`** — defines the base parameters for each verb:
```json
[
  { "id": "strike",  "baseMagnitude": 2, "actionType": "melee_augment"  },
  { "id": "invoke",  "baseMagnitude": 4, "actionType": "channeled_aoe"  },
  { "id": "ward",    "baseMagnitude": 3, "actionType": "self_buff"       },
  { "id": "step",    "baseMagnitude": 2, "actionType": "on_dodge"        }
]
```

**`packages/content/data/weapon_actions.json`** — weapon type → action physics parameters:
```json
[
  { "id": "slash",    "windupTicks": 4, "activeTicks": 4, "winddownTicks": 7,  "animationStyle": "slash",    "hitbox": { "shape": "arc",  "range": 2.0, "arcHalf": 1.047 } },
  { "id": "overhead", "windupTicks": 6, "activeTicks": 3, "winddownTicks": 9,  "animationStyle": "overhead", "hitbox": { "shape": "arc",  "range": 1.8, "arcHalf": 0.785 } },
  { "id": "thrust",   "windupTicks": 3, "activeTicks": 4, "winddownTicks": 6,  "animationStyle": "thrust",   "hitbox": { "shape": "cone", "range": 2.6, "arcHalf": 0.4   } },
  { "id": "unarmed",  "windupTicks": 3, "activeTicks": 3, "winddownTicks": 5,  "animationStyle": "unarmed",  "hitbox": { "shape": "arc",  "range": 1.5, "arcHalf": 1.047 } },
  { "id": "bite",     "windupTicks": 4, "activeTicks": 3, "winddownTicks": 8,  "animationStyle": "bite",     "hitbox": { "shape": "arc",  "range": 1.5, "arcHalf": 0.785 } }
]
```

**`item_templates.json` additions** — each weapon gets `"weaponAction": "slash"` (or overhead/thrust). Replaces `attackCooldownTicks` in baseStats — timing now lives in `weapon_actions.json`. `attackCooldownTicks` is removed from all weapon templates.

**`npc_templates.json` additions** — each NPC gets a `"skillLoadout"` array (same shape as the player component) and `"weaponAction"`:
```json
{ "id": "wolf", "weaponAction": "bite", "skillLoadout": [
  { "verb": "strike", "fragment1": "vampiric_drain", "fragment2": "swift_step" }
]}
```

**`game_config.json`** — remove `combat.unarmed.attackCooldownTicks`. Add `"unarmedWeaponAction": "unarmed"`.

---

## Components to add

**`SkillInProgress`** — present on an entity while an action is executing:
```
{
  weaponActionId: string,      // which weapon_action row drives physics
  phase: "windup"|"active"|"winddown",
  ticksInPhase: number,
  hitEntities: string[],       // already-connected this swing
  inputTimestamp: number,      // for lag compensation
  pendingSkillVerb: string,    // which verb to fire when active connects ("strike"|""|...)
}
```

**`SkillLoadout`** — player's configured skill slots (also used for NPCs):
```
{
  slots: Array<{
    verb: string,
    fragment1: string,   // fragment id
    fragment2: string,   // fragment id
  } | null>
}
```

**`SkillCooldowns`** — per-slot cooldown counters:
```
{ cooldowns: number[] }   // indexed by slot number, ticks remaining
```

## Components to remove

**`AttackCooldown`** — deleted entirely. The action physics timer lives in `SkillInProgress`. The between-use cooldown lives in `SkillCooldowns`. Any code referencing `AttackCooldown` is a compile error after Phase 2.

---

## Systems

### `ActionSystem` (new, replaces `CombatSystem`)
Handles Layer 1 — the action physics.

Each tick:
1. Check `InputState` for attack action. If pressed and no `SkillInProgress` exists on entity and no cooldown blocking:
   - Resolve weapon action id from Equipment → item template → `weaponAction` field (fallback: `"unarmed"`).
   - Create `SkillInProgress` with `phase: "windup"`, `ticksInPhase: 0`.
   - Resolve which skill slot has verb `"strike"` from `SkillLoadout` (if any) → store as `pendingSkillVerb`.
2. Advance `SkillInProgress.ticksInPhase`. Transition phases at thresholds from `weapon_actions.json`.
3. During `active` phase: run hitbox each tick against targets not in `hitEntities`.
   - On connect: apply base weapon damage (from `DerivedItemStats.damage`).
   - If `pendingSkillVerb === "strike"`: fire the skill effect (see `SkillSystem`).
   - Mark target in `hitEntities`.
4. When winddown ends: remove `SkillInProgress`.

**Lag compensation:** rewind happens once at the tick the active phase begins, using `inputTimestamp`. Subsequent active ticks check current positions.

### `SkillSystem` (new)
Handles Layer 2 — skill composition and effect dispatch.

Called by `ActionSystem` (for `strike`) and directly by input system (for `invoke`, `ward`, `step`).

```
resolve(world, casterId, verb, fragment1Id, fragment2Id, targetId?, targetPos?):
  f1 = content.getFragment(fragment1Id)
  f2 = content.getFragment(fragment2Id)
  entry = content.getMatrixEntry(verb, f1.concept, f2.concept)
  if !entry: return

  ratio = f2.magnitude / (f1.magnitude + verb.baseMagnitude)
  effectPower = entry.outwardScale × (ratio >= 1 ? ratio : sqrt(ratio))
  staminaCost = entry.staminaCostBase + entry.inwardScale × f2.magnitude

  deduct stamina; if insufficient: return (skill fizzles)
  set SkillCooldowns[slot] = entry.cooldownTicks

  dispatch EFFECT_HANDLERS[entry.effectType](world, events, casterId, targetId, effectPower, entry)
```

Effect handlers (Layer 3):
```typescript
const EFFECT_HANDLERS: Record<string, EffectHandler> = {
  damage_boost: ...,
  shield:       ...,
  drain_life:   ...,
  area_damage:  ...,
  poison_aura:  ...,
  fear_aura:    ...,
  speed_boost:  ...,
  heal:         ...,
}
```

### `AnimationSystem` (rewritten)
No longer reads `AttackCooldown`. Reads `SkillInProgress`:
- If `SkillInProgress` present: `mode = "attack"`, derive `attackStyle` from `weapon_actions[weaponActionId].animationStyle`, compute `ticksIntoAction` and phase boundaries for evaluator.
- Otherwise: walk/idle/death as before.

`AnimationStateData` new shape:
```typescript
{
  mode: AnimationMode;
  attackStyle: string;       // "slash"|"overhead"|"thrust"|"unarmed"|"bite"|""
  windupTicks: number;
  activeTicks: number;
  winddownTicks: number;
  ticksIntoAction: number;   // elapsed since action started
}
```

`startTick` is removed. Evaluator uses `ticksIntoAction` + phase boundary fields directly.

### NPC integration
NPC AI attack job no longer synthesises `ACTION_ATTACK`. It calls `ActionSystem.initiateAction(entityId)` directly — the same path the input handler uses. The NPC's `SkillLoadout` component provides the skill. No `if (isNpc)` branch inside any system.

---

## What is removed

| Thing | Deleted in |
|---|---|
| `CombatSystem` (`combat.ts`) | Phase 3 |
| `AttackCooldown` component + codec | Phase 2 |
| `ACTION_ATTACK` protocol constant | Phase 3 (renamed `ACTION_USE_SKILL`) |
| `ATTACK_TICKS = 15` in evaluator | Phase 4 |
| `attackCooldownTicks` in item_templates baseStats | Phase 1 |
| `startTick` field in `AnimationStateData` | Phase 2 |
| My earlier `skills.json` concept | Never created |

---

## Implementation rules — non-negotiable

1. **No old system survives.** `CombatSystem`, `AttackCooldown`, and `ATTACK_TICKS` must not exist after implementation. No commented-out code. No `// legacy` aliases.

2. **Delete at point of replacement.** If a type, function, component, or file is replaced, it is deleted in the same phase. No `@deprecated` pointers. Callers are updated immediately.

3. **`deno check` passes at the end of each phase** before the next begins. A phase is not complete if there are type errors.

4. **Single code path for players and NPCs.** `ActionSystem` and `SkillSystem` have no `if (isNpc)` branches. NPCs go through `SkillLoadout` like players — their loadout is just smaller.

5. **Content data before systems.** `weapon_actions.json`, `verbs.json`, updated templates are complete before any system that reads them is written.

6. **No parallel running.** `CombatSystem` and `ActionSystem` are never registered simultaneously in `server.ts`.

7. **Codec versioning.** `AnimationStateData` changes shape. Old codec is deleted, new codec written from scratch. Component version increment ensures old wire data is rejected.

8. **Component registry is authoritative.** `AttackCooldown` is removed from `COMPONENT_REGISTRY` in the same commit it is deleted.

9. **No dead code.** After each phase, unused imports and functions are deleted. Linter warnings for unused vars are treated as errors.

10. **No TODOs left open.** A phase is not complete if any `// TODO` exists pointing to work deferred to a later phase. Defer scope, not half-done implementation.

11. **The matrix is data, not code.** No new `effectType` is handled by a switch case inside `SkillSystem`. All effect dispatch is through the handler registry. Adding a new effect = one new handler function.

12. **NPCs use real fragments.** NPC `SkillLoadout` references actual fragment IDs from `lore_fragments.json`. No fake "NPC-only" shortcut effect system.

---

## Implementation phases

### Phase 1 — Content schema
- Add `WeaponActionDef` type to `packages/content/src/types.ts`
- Add `VerbDef` type to `packages/content/src/types.ts`
- Create `packages/content/data/weapon_actions.json`
- Create `packages/content/data/verbs.json`
- Update `item_templates.json`: add `weaponAction` field, remove `attackCooldownTicks` from all weapon `baseStats`
- Update `npc_templates.json`: add `weaponAction` and `skillLoadout` to each NPC
- Update `game_config.json`: remove `combat.unarmed.attackCooldownTicks`, add `unarmedWeaponAction`
- Update `DerivedItemStats`: remove `attackCooldownTicks`, add `weaponAction: string`
- Update `ContentStore`: load `weapon_actions.json` and `verbs.json`, expose getters
- ✓ `deno check` passes

### Phase 2 — Components
- Write `SkillInProgress` component + codec
- Write `SkillLoadout` component + codec
- Write `SkillCooldowns` component + codec
- Rewrite `AnimationStateData` (new fields, remove `startTick`)
- Rewrite `animationStateCodec` from scratch
- Delete `AttackCooldown` component and codec — fix all compile errors immediately
- Update `COMPONENT_REGISTRY`: remove `AttackCooldown`, add three new components
- ✓ `deno check` passes

### Phase 3 — ActionSystem + SkillSystem (server)
- Write `packages/tile-server/src/systems/action_system.ts` — phase advancement, hitbox check, base damage
- Write `packages/tile-server/src/systems/skill_system.ts` — matrix lookup, balance formula, effect dispatch
- Write all eight effect handlers
- Register `ActionSystem` and `SkillSystem` in `server.ts`; **simultaneously** deregister and delete `CombatSystem`
- Delete `packages/tile-server/src/systems/combat.ts`
- Rename `ACTION_ATTACK` → `ACTION_USE_SKILL` in protocol; update all references
- ✓ `deno check` passes

### Phase 4 — AnimationSystem + evaluator
- Rewrite `AnimationSystem` to read `SkillInProgress`; remove all `AttackCooldown` references
- Update `evaluatePose` to accept `AnimationStateData` with new shape; remove `startTick` usage
- Delete `ATTACK_TICKS` constant
- Add `overhead` and `thrust` and `unarmed` pose functions; parameterise all with phase fractions from data
- ✓ `deno check` passes

### Phase 5 — NPC AI
- Remove `ACTION_ATTACK`/`ACTION_USE_SKILL` synthesis from NPC AI
- Replace with direct `ActionSystem.initiateAction(entityId)` call
- Verify all NPC templates have `weaponAction` and `skillLoadout` (set in Phase 1)
- ✓ `deno check` passes

### Phase 6 — Client
- Update `client_world.ts` decoder for new `AnimationStateData` shape
- Update `forceLocalAnimation` in renderer to use new fields
- Update any client input references from `ACTION_ATTACK` → `ACTION_USE_SKILL`
- ✓ `deno check` passes

### Phase 7 — Final audit
Search the entire codebase for:
`AttackCooldown`, `ATTACK_TICKS`, `ACTION_ATTACK`, `attackCooldownTicks`, `startTick`, `CombatSystem`

Every match must be absent or in a comment explaining why it was removed. Remove dead imports. `deno check` clean on all packages.

---

## Out of scope for this plan

- Skill slot UI (equipping fragments into slots)
- Lore acquisition / internalisation mechanics (training, reading tomes)
- Externalising Lore (writing to tomes)
- Dynasty library persistence
- Ranged weapon action type (`invoke` with projectile)
- `shout`, `pray`, `harvest`, `track` verbs (matrix has no entries yet)
- Tick rate increase (revisit after balance pass)
- Fragment upgrading via crafting

---

## Tick rate note

All timing is in ticks. At 20 Hz, one tick = 50ms. A `windupTicks: 4` = 200ms telegraph. An `activeTicks: 4` = 200ms hit window. Adequate for most weapons at this fidelity.

If balance requires finer resolution (e.g. a 1-tick active feels coarse at 50ms), bump the server tick rate. The skill system does not change — rebalance `weapon_actions.json` tick counts. Do not do this during the implementation, only after.
