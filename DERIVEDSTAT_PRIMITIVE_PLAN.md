# DerivedStat as a Universal Compose Primitive — Implementation Plan

**Status:** design locked; not yet implemented. Companion to
`ACTION_PRIMITIVE_PLAN.md` (action arc complete), `RESOURCE_PRIMITIVE_PLAN.md`
(resource arc complete), `SCENE_GRAPH_PLAN.md`.
**Tickets:** T-239 (DerivedStat) ∧ re-scoped T-235 (buffs as scene-graph
children) — **one commit that deletes `BuffSystem` whole**. Not phaseable
into green sub-commits the way T-238 was: `BuffSystem` is the single writer
of `SpeedModifier` and the single owner of `ActiveEffects` lifetime;
splitting it leaves two live paths (the `CLAUDE.md` hard rule). Take the
big diff.
**Thesis:** the third and last of the three primitives over one substrate
(Actions, Resources, DerivedStats). The action arc proved the
content-defined registry-dispatch pattern; the resource arc reused the
effect registry; this arc reuses *both* the effect-resolver doctrine (DoT
buffs become ambient actions on scene-graph children) and the
`DerivedItemStats` compose pattern (its actor-level dual).

---

## What `BuffSystem` actually is (recon 2026-05-16, grounded in code)

`buff.ts` is **three unrelated shapes** sharing one `ActiveEffects`
component + one frame loop:

1. **Periodic DoT/HoT** — effects with a registered `tick` handler
   (`health` only today: `tickDeltaPerSec` → Health each frame). A genuine
   per-entity ambient tick.
2. **Aggregate speed compose** — for each effect with a `compose` handler
   (`speed` only today), accumulate `speedBonus`; then the **single write**
   `SpeedModifier = EncumbrancePenalty.multiplier × (1 + Σ speedBonus)`.
   `BuffSystem` is the sole writer of `SpeedModifier`; `PhysicsSystem`
   reads it.
3. **`ActiveEffects` lifetime** — decrement `ticksRemaining`; effects at
   the `CONSUME_ON_USE_SENTINEL` (999) never decrement; only survivors
   (`ticksRemaining > 0`) are kept.

### Two honest corrections to the design doc's framing

- **The damage hooks are *not* in `BuffSystem`.** `OutgoingDamageHook` /
  `IncomingDamageHook` (`damage_boost`, `shield`) are already
  registry-dispatched and invoked **from `health_hit_handler.ts:113–152`**,
  not from `buff.ts`. The damage half is *already* where the doctrine
  wants it. What `BuffSystem` owns for those effects is only shape (3):
  the lifetime of the `ActiveEffect` entries (consume-on-use reaping).
  So "damage-hooks → damage-pipeline resolvers" is **already done** — the
  arc's real damage-side work is just rehoming consume-on-use *lifetime*.
- **Speed is the *only* composed actor stat that exists.** The doc names
  `swingSpeed`, `damageResist`, `poiseRegen`, `visionRange` as fellow
  DerivedStats. In code: `damageResist` is computed per-hit from
  `deriveItemStats` in the hit handler (not an entity-composed stat),
  `poiseRegen` is now a **Resource** (T-238d), `swingSpeed`/`visionRange`
  do not exist. A general N-stat compose *registry* would be speculative
  generality for exactly one stat — precisely the misfit the T-231 /
  T-235 / T-238e re-scopes refused. **See "Scope" below.**

---

## Scope — honest, not speculative (the recurring discipline)

The arc does **one** real generalization and **resists** the rest:

- **DerivedStat is real but thin.** A `DerivedStats` component
  (`{ moveSpeed }` today — the projection `PhysicsSystem` reads) written
  by **one** `DerivedStatSystem` that composes `base ∘ Σ(typed
  contributions)`. Contributions come from a closed `StatContributor`
  registry (mirrors `ResourceRateModifier` / gates / effects): today two
  contributors — `encumbrance` (base multiplier, absorbing
  `EncumbranceSystem`/`EncumbrancePenalty`) and `active_effect_speed` (Σ
  speed `ActiveEffects`). Adding a stat later = a new field + contributor
  handler, **never** a new system. This *is* the actor-level dual of
  `deriveItemStats` (component fields → composed blob); the symmetry is
  named, not forced — we do not retrofit item stats through it.
- **`SpeedModifier` and `EncumbrancePenalty` are deleted, not kept.**
  `DerivedStats.moveSpeed` replaces `SpeedModifier`; `PhysicsSystem` reads
  the new field. `EncumbranceSystem` is **not** deleted — it still
  computes carried-weight → a penalty — but it writes a *contribution*
  the composer reads, not a standalone `EncumbrancePenalty` component
  consumed only by the old `BuffSystem` line. (Open question A below:
  keep `EncumbranceSystem` as a thin contributor source vs. fold its
  weight math into an `encumbrance` StatContributor. Leaning: keep the
  system, delete the component — least churn, clean single responsibility.)
- **DoT/HoT → buff-as-scene-graph-child (the re-scoped T-235).** A
  `start_buff` effect resolver (net-new) spawns a child entity carrying a
  `Buff` ambient action (`ticks:-1`); its `:tick` runs a `buff_tick`
  resolver (net-new) that applies the periodic delta to
  `world.getParent(self)` (Health DoT/HoT) and self-`destroySubtree`s on
  expiry. Substrate verified ready (dispatcher advances ambient actions on
  `ActorSlots`-less children, skips intent — dispatcher.ts:92–121;
  `spawnPrefab` children recursion + `destroySubtree` exist).
- **Consume-on-use lifetime → the effect's own resolver.** `damage_boost`
  / `shield` are consumed at the moment the damage hook fires (in
  `health_hit_handler`), so their `ActiveEffect` entry should be reaped
  **there**, by the hook, not by a surviving global decrement loop. Their
  duration-bounded variants (if any ship later) become buff children like
  the DoTs. This removes the last reason `BuffSystem`'s lifetime loop
  needs to exist.
- **`ActiveEffects` component: retained, lifetime moves.** Still the
  networked store of speed/consume-on-use effects (the compose contributor
  and damage hooks read it). Per-tick decrement of duration-bounded speed
  effects moves onto the **buff child** model too: a speed buff is a child
  whose ambient action lifetime *is* its duration; on `destroySubtree` it
  removes its contribution. Net: `ActiveEffects` becomes the
  consume-on-use + instantaneous store; *durationed* effects are all
  scene-graph children. (Open question B: is it cleaner to keep the
  decrement for consume-on-use-less speed effects as a tiny step, or make
  *all* durationed effects children? Leaning: all children — one model,
  no residual loop, which is the whole point of deleting `BuffSystem`.)

If a piece doesn't fit (e.g. a buff that is neither periodic, nor a stat
contribution, nor consume-on-use), it is recorded honestly and left as a
thin resolver rather than contorted — same rule as every prior arc.

---

## Shape of the unified commit

Deletes: `BuffSystem` (`systems/buff.ts`), `SpeedModifier` +
`EncumbrancePenalty` components, the `compose` sub-registry +
`EffectComposeHandler` + `speedEffectCompose` (its single registrant), the
`tick` sub-registry + `EffectTickHandler` + `healthEffectTick` (DoT moves
to `buff_tick`), `CONSUME_ON_USE_SENTINEL`'s global decrement.

Adds: `DerivedStats` component (server-only initially — `PhysicsSystem` is
server-side; networking later, same call Resources/ActiveActions made),
`DerivedStatSystem` (single writer), `StatContributor` registry +
`encumbrance` + `active_effect_speed` contributors, `start_buff` +
`buff_tick` effect resolvers, a `Buff` ambient `ActionDef` +
`data/prefabs/buff_*.json` child prefabs (one per `BuffDef`, or a generic
parameterized buff child — Open question C).

Rewires: `applyBuffById` → spawn a buff child via `start_buff` instead of
`addActiveEffect`; `PhysicsSystem` reads `DerivedStats.moveSpeed`;
`EncumbranceSystem` emits a contribution; the consume-on-use hooks reap
their own `ActiveEffect`.

Invariants: single-writer of `DerivedStats` preserved (one system);
bake byte-identical (runtime state only — no world-content change);
client untouched (drifted); registry-dispatch, no `switch`; one commit,
no flags/legacy/parallel path.

---

## Open questions for review (before the big diff)

- **A.** `EncumbranceSystem`: keep as a thin contributor-source system
  (delete only the `EncumbrancePenalty` component) vs. fold its
  carried-weight math into an `encumbrance` `StatContributor` and delete
  the system too. Leaning **keep the system, delete the component**.
- **B.** Durationed speed effects: model **all** durationed effects as
  scene-graph buff children (one model, zero residual loop) vs. keep a
  minimal decrement for non-child speed effects. Leaning **all children**.
- **C.** Buff child prefab: one prefab per `BuffDef` (`data/prefabs/
  buff_slow.json` …) vs. a single generic `buff` prefab parameterized by
  the `start_buff` params (effectStat/magnitude/duration). Leaning
  **generic parameterized** — fewer files, the `BuffDef` already carries
  the data; the child just needs the ambient action + params.
- **D.** `DerivedStats` networked now or server-only? Leaning
  **server-only** (consistent with Resource/ActiveActions; the client is
  drifted and rebuilds around the scene view later).

These four don't change the destination (one `DerivedStatSystem`,
`BuffSystem` gone, buffs are children); they change how thin the first
landing is. Resolve, then take the big diff.

---

## Net

`BuffSystem` + `SpeedModifier` + `EncumbrancePenalty` +
`EffectComposeHandler`/`EffectTickHandler` + the consume-on-use decrement
loop collapse into one `DerivedStatSystem` + a `StatContributor` registry
+ two resolvers (`start_buff`, `buff_tick`) + buff-child prefabs. Buffs
stop being a fourth bespoke mechanism and become *actions on scene-graph
children* (T-235) whose stat side is *the same compose primitive*
`deriveItemStats` already is for items. Three content-driven primitives —
Actions, Resources, DerivedStats — over one substrate; the spine is
complete.
