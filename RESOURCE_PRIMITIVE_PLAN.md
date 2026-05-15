# Resource as a Universal Tick-Scalar Primitive — Implementation Plan

**Status:** design locked, substrate not yet implemented. Companion to
`ACTION_PRIMITIVE_PLAN.md` (the action arc is complete) and
`SCENE_GRAPH_PLAN.md`.
**Tickets:** T-238 arc, sub-tickets T-238a … T-238g below.
**Thesis:** the second of the three primitives over one substrate. The
action arc proved the pattern (content-defined behaviour + entity-generic
gate/effect registries + no hardcoded switches); the Resource arc reuses
*the same effect registry* for threshold dispatch. Net: ~4–5 more bespoke
per-tick systems collapse to one system + data, with **no loss of
capability**.

---

## The shape (Discovery 1, restated precisely)

`StaminaSystem`, `HungerSystem` (hunger+thirst), `CorruptionSystem`,
`PoiseSystem`, and the crafting time-step timer are the same hand-rolled
loop:

> a scalar `value` bounded `[min, max]`, changing each tick by a signed
> `rate`, the rate optionally modulated by **external** inputs (armor,
> another resource's level, day/night), crossing **named thresholds** that
> fire an effect / event / couple into another resource.

One `Resource` component family + one `ResourceSystem` driven by content
`ResourceDef` replaces all of them. Threshold dispatch goes through the
**existing `EffectRegistry`** (`actions/effect.ts`) — `entityId`-generic by
the load-bearing decision made in T-226 *specifically so this arc reuses
it*. No new dispatch machinery.

---

## What is honestly in scope (and what is not)

Same discipline as the action arc's T-231/T-235 re-scopes — do not force
misfits:

- **Clean fits (migrate):** `stamina`, `hunger`, `thirst`, `poise`
  (regen-only — break stays in `health_hit_handler`, it needs
  overshoot/tier), and the **crafting time-step countdown** (a degenerate
  timer Resource on the *workstation* entity — the dispatcher/registries
  are already entity-generic; T-231 handed this here).
- **`exhausted` boolean is deleted, not migrated.** It is exactly
  `stamina.value <= 0`. `StaminaCostHandler`, `health_hit_handler`'s
  stam-gate, and `not_exhausted` gate switch to reading the resource
  value. One less piece of redundant state.
- **Health passive regen: none exists today.** The arc does **not** invent
  it. Health stays event-written (combat / starvation / corruption damage,
  DeathSystem on ≤0). Starvation/corruption damage become threshold
  effects *on the hunger/corruption resources* that modify Health — Health
  itself is not a `Resource` (no tick rate).
- **Durability: excluded.** It is event-decremented (one line in the
  `weapon_trace` effect, per-swing), not a per-tick rate scalar. Forcing it
  into a tick system would be a T-231-style contortion. It already follows
  the effect-resolver doctrine; leave it.
- **Corruption: conditional, evaluated carefully.** `tileCorruption` flips
  rate by day/night (`WorldClock`); `corruptionExposure` rate depends on
  the tile's level and couples a penalty into `stamina`. These are not
  `base × multiplier`; they are *conditional rate selection* + a
  *cross-resource modifier*. The action arc banned an expression DSL — so
  corruption is admitted **only** if it fits a small **closed**
  `rateModifier` vocabulary (below). If a clean expression of it needs a
  DSL, `CorruptionSystem` stays a thin bespoke rate contributor while
  `tileCorruption`/`corruptionExposure` still become `Resource`-tracked
  values (partial migration), and that is recorded honestly rather than
  contorted.

---

## ResourceDef (content schema — `data/resources/{id}.json`)

```jsonc
{
  "id": "stamina",
  "scope": "entity",                 // "entity" | "tile" (tileCorruption) | "self"
  "bounds": { "min": 0, "max": 100 },// max may be seeded per-entity at spawn
  "rate": 8,                          // signed per-SECOND base delta (regen +, decay/timer −)
  "rateModifiers": [                  // closed vocabulary, evaluated in order
    { "kind": "equipment_stat", "stat": "staminaRegenPenalty", "apply": "subtract_fraction" },
    { "kind": "resource_gate", "resource": "corruptionExposure", "at": 30, "dir": "above",
      "apply": "scale", "factor": 0.7 }
  ],
  "thresholds": [                     // dispatched through the EffectRegistry
    { "at": 0,  "dir": "below", "edge": "sustained", "effect": "clamp_floor" }
  ]
}
```

`rateModifier.kind` is a **closed registry** (mirrors gates/effects), not a
DSL. Initial vocabulary, exactly what the surveyed systems need:

- `equipment_stat` — sum a `DerivedItemStats` field across equipped slots.
- `resource_gate` — when another resource is above/below `at`, `scale` by
  `factor` (covers corruption→stamina penalty).
- `daynight` — select `dayRate` / `nightRate` from `WorldClock` (covers
  `tileCorruption`).
- `tile_coupled` — rate = host `tileCorruption.value × k` when >0, else a
  decay constant (covers `corruptionExposure`).

If those four close the set, corruption migrates fully. New conditions are
new `kind`s (one handler each), never inline logic — the registry doctrine
T-237 wrote into `CLAUDE.md`.

`threshold.edge`: `"cross"` fires the effect once on entering the zone
(HungerCritical event); `"sustained"` fires every tick while in the zone
(starvation/corruption DPS, exhausted clamp). The effect is a normal
`EffectResolver` — e.g. `modify_health` (params `{ dps }`),
`emit_event` (params `{ event }`), `resolve_recipe` (crafting timer).

`Resource` component: `{ values: Record<resourceId, { value, max }> }`
server-only initially (no resource-bar UI yet — networking is a later add,
same call the action `ActiveActions` made). One component holding all of an
entity's resources keeps the query/delta cheap and matches `ActiveActions`'
multi-slot shape.

---

## Phasing (each a green commit; system deleted in the same commit it is replaced — no parallel paths)

- **T-238a — substrate (inert). LANDED.** `ResourceDef` (+ hand-rolled
  `validateResourceDef`, matching the action-arc validator style — *not*
  valibot, the plan's "valibot" was loose wording; closed validator is
  consistent with `validateActionDef`) + `data/resources/` loader +
  `ContentService.resources` + bootstrap **v9→v10** + `Resource` component
  (server-only, `{ values: Record<id,{value,max}> }`) + `ResourceSystem` +
  `ResourceRateModifier` registry + threshold dispatch + the real
  `modify_health` effect. **Design refinement (honest call, like
  T-231/T-235):** thresholds dispatch through a *dedicated*
  `ResourceEffect` registry — same `Registry<H>` doctrine + effect-resolver
  pattern, but a resource-shaped context (`{world,events,entityId,content,
  resourceId,value,dt,params,deaths}`) instead of synthesising a fake
  `ActiveActionState`/slot/edge to reuse the action `ResolveContext`. Same
  spine; faking action state to satisfy the plan's letter would have been
  the smell. `clamp`/`emit_event` are *not* shipped: clamp is intrinsic to
  bounds (not an effect), `emit_event` lands with its first consumer
  (T-238c hunger). 5 ResourceSystem unit tests (rate, min/max clamp,
  modifier chain, sustained-vs-cross, unknown-id tolerance) + 178
  content/tile-server/codecs/engine green; substrate fully inert (nothing
  installs `Resource`), bake byte-identical.
- **T-238b — stamina. LANDED.** `data/resources/stamina.json` (rate 8/s,
  `equipment_stat` + `corruption_penalty` modifiers); player spawn seeds
  `Resource.values.stamina` (NPCs unchanged — they never had Stamina, so
  still can't pay stamina costs: strict parity). `staminaValue`/
  `spendStamina` helpers replace `deductStamina`; `StaminaCostHandler`,
  `SkillSystem`, `not_exhausted`, `health_hit_handler` stam-gate, and the
  debug cheat all go through the Resource. handoff persists `Resource`
  (covers stamina now, hunger/thirst/poise automatically as they migrate).
  **Deleted: `StaminaSystem`, the `Stamina` component, `staminaCodec`/
  `StaminaData`, the `exhausted` flag, wire id 9 (retired).** Two new
  modifier kinds shipped: `equipment_stat` (armor penalty) and
  `corruption_penalty` (a documented **bridge** reading the still-extant
  `CorruptionExposure` component — becomes a generic `resource_gate` at
  T-238e, a one-file swap since it is a registered closed kind). Penalty
  composition is now multiplicative `(1-a)(1-c)` vs the old additive-capped
  `1-(a+c)` — accepted retune, noted. dodge_roll + prefab_round_trip tests
  adjusted; 2 new stamina-regen integration tests; 179 green; bake
  byte-identical.
- **T-238c — hunger + thirst. LANDED.** `data/resources/{hunger,thirst}.json`
  — `cross@80 → emit_event` (HungerCritical/ThirstCritical, payload
  `{entityId,value}` preserved) + `sustained@100 → modify_health`
  (starvation/dehydration DPS, cause "starvation" — `DeathCause` has no
  "dehydration", parity-faithful). `emit_event` effect shipped (string →
  `TileEvents` symbol, fail-fast on unknown). Seeded on **both** player &
  NPC spawn (NPC AI seek-food/water reads it). Migrated consumers:
  `consume_item`, `seek_food`/`seek_water` job handlers, `NpcAiSystem`
  BTContext, handoff (now via the persisted `Resource`). **Deleted:
  `HungerSystem`, `Hunger`+`Thirst` components, `hunger`/`thirst` codecs,
  wire ids 7/8 (retired).** Accepted retune: simultaneous hunger≥100 **and**
  thirst≥100 now deals max(2,3)·dt not 2+3 (two deferred Health writes,
  last wins — documented edge case). 2 hunger integration tests + 179
  green; bake byte-identical.
- **T-238d — poise. LANDED.** `data/resources/poise.json` (pure regen,
  rate 12/s, bounds 0..50, no modifiers/thresholds — the simplest possible
  Resource). Seeded on player & NPC spawn (`Resource.values.poise`, max
  from `combat.poise.max`). `health_hit_handler` keeps the poise *damage*
  and break → stagger-tier decision; it now reads/writes
  `Resource.values.poise` instead of the standalone component.
  **Deleted: `PoiseSystem`, the `Poise` component + `poiseCodec`/
  `PoiseData`.** **Accepted retune (honest call):** the 0.5 s
  `regenDisabledSecondsAfterBreak` window is *dropped*, not modeled. With
  break resetting poise to max it only ever bit on a re-hit *within* the
  window — near-vestigial; modeling it would have meant a second
  countdown-Resource + a `resource_gate` modifier purely to reproduce a
  marginal edge. The dead `game_config` key is removed in T-238g. 2 poise
  regen integration tests (rate+clamp, broken→full no-suppression); 181
  content/tile-server/codecs/engine green; bake byte-identical (resources
  are runtime state, terrain untouched).
- **T-238e — corruption.** Iff the closed `rateModifier` vocabulary above
  holds: `tileCorruption` (tile-scope) + `corruptionExposure` (entity)
  Resources; **delete `CorruptionSystem`**. Else: partial — values become
  Resources, a slim rate contributor remains; recorded honestly.
- **T-238f — crafting timer.** `WorkstationBuffer.progressTicks` → a
  workstation-entity countdown Resource whose `at:0` sustained threshold
  fires a `resolve_recipe` effect; the time-step handler shrinks to that
  effect. (Inputs-match auto-start stays recipe logic.)
- **T-238g — polish.** Remove now-dead config keys' duplication, settle
  bootstrap at its final version, ensure `CLAUDE.md` "unified substrate"
  section reflects Action + Resource done, DerivedStat (T-239) next.

`ResourceSystem` order: after `DayNightSystem` (needs `WorldClock`), after
`EquipmentSystem` (armor modifiers), before `ActionDispatcher` (actions
gate on resource values), before `PhysicsSystem`. `sortSystemsByDependencies`
handles it via `dependsOn`.

---

## Invariants

1. Bake byte-identical per commit (no world-content change; resources are
   runtime state).
2. Each phase deletes the system it replaces in the same commit. No flags,
   no `legacy`, no two live paths (the `CLAUDE.md` hard rules).
3. Threshold dispatch is the **existing** `EffectRegistry` — no parallel
   effect system. New effects/`rateModifier` kinds are one handler + one
   `register()` each.
4. Client untouched (drifted for the scene-view rebuild — see the project
   memory / T-236).
5. `T-239` (DerivedStat) consumes the settled resource/effect machinery
   afterward and lands together with the re-scoped `T-235` (buffs as
   scene-graph children) — the BuffSystem-deletion commit.

---

## Net

Deletes `StaminaSystem`, `HungerSystem`, `PoiseSystem`, (likely)
`CorruptionSystem`, shrinks the crafting time-step handler, and removes the
redundant `exhausted` flag + `Stamina` component — replaced by one
`ResourceSystem` + ~6 `data/resources/*.json` + a handful of effect /
rateModifier handlers. Same capability, far less bespoke per-tick code; the
"what changes this scalar and what happens at the edges?" question gets one
data-shaped answer everywhere.
