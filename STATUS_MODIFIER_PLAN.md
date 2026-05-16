# Status / Modifier — a Universal "what changes this entity's stats?" Primitive

**Status:** design locked (reframed 2026-05-16 from the earlier
"DerivedStat" framing — see "Why the reframe"). Recon-grounded.
Execution-ready (one big diff). Companion to `ACTION_PRIMITIVE_PLAN.md`,
`RESOURCE_PRIMITIVE_PLAN.md`, `SCENE_GRAPH_PLAN.md`.
**Tickets:** T-239 ∧ re-scoped T-235 — one non-phaseable commit that
deletes `BuffSystem` whole.
**Thesis:** the third primitive. Not "compose a derived stat" (that put
the *output projection* first); the real need is a **uniform way any
source modifies an entity** — buffs, equipment, environment, posture —
with the effective value a thin read on top.

---

## Why the reframe (the design correction)

The earlier plan made `DerivedStats` (an output component a system
writes) the primitive. That is backwards: the value is trivial; the
hard, scattered thing is the **input side**. Today "something modifies
an entity's effective stats" exists as **five unrelated mechanisms**:

| Source | Today | Stored? |
|---|---|---|
| Buffs / DoTs / speed | `ActiveEffects` list, ticked/composed/reaped by `BuffSystem` | a list |
| Equipment stats | `deriveItemStats(prefab)` re-scanned **per consumer** (armor in hit handler, weight in encumbrance, stamina-penalty in the resource modifier) | no — recomputed everywhere |
| Environmental | was corruption (deleted); no general channel | — |
| Posture | tags (`crouched` …) read ad-hoc | presence-flag |
| Resource rate bends | closed `rateModifier` registry, re-reads equipment again | no |

The unifying atom across all of them:

> **Modifier** = "while CONDITION holds, stat *S* changes by (*op*,
> *value*)." Only the **condition** differs — a timer (buff), equipped-
> in-slot (equipment), inside-volume (environment), tag-present (posture)
> — and every one of those conditions is *already a primitive we have*
> (Resource timer, Equipment component, spatial membership,
> component-presence tag).

So the primitive is the **Modifier record + one `effective(entity,stat)`
query**, not a stored output.

---

## The model (hybrid: query over existing stores — user decision)

No redundant materialized ledger. Each source stays where it already
lives authoritatively; one query composes across them via a
**`ModifierSource` registry** (registry-dispatch doctrine, like
gates/effects/rateModifiers).

```ts
type ModifierOp = "add" | "mul";                 // closed, minimal
interface StatModifier { stat: string; op: ModifierOp; value: number; }

interface ModifierSource {                        // registered, content-id dispatch
  readonly id: string;                            // "equipment" | "buffs" | "encumbrance" | …
  contribute(world, content, entityId): StatModifier[];
}
```

`StatQuery.effective(world, content, entityId, stat, base)` folds every
source's modifiers for `stat`:

> **effective = (base + Σ add) × Π mul**

- `moveSpeed`  → base 1; muls = encumbrance factor, each speed buff factor → a **product**
- `armorReduction` → base 0; adds = each equipped slot's reduction → a **sum**
- `staminaRegen` → base from `stamina.json` rate; the resource modifier becomes `effective(...,"staminaRegen")`

One rule, every stat; the stat decides whether its sources are `add` or
`mul` by what they emit. **Accepted retune:** multiple speed buffs now
compose multiplicatively (`0.7 × 0.7`) rather than additively
(`1 + (−0.3) + (−0.3)`) — same family of compose-semantics retune the
arc has accepted before (T-238b); documented, not hidden.

### The three source contributors shipped

- **`equipment`** — live `deriveItemStats` over equipped slots → typed
  modifiers (`armorReduction` add, `staminaRegenPenalty` mul, …). The
  Equipment component stays the single source of truth; **nothing is
  copied or synced**. Deletes the duplicated per-consumer scans.
- **`buffs`** — walks the entity's scene-graph **children**; each buff
  child carries its `{stat,op,value}` as `Buff`-action params → one
  modifier. (Periodic DoT/HoT buffs additionally tick — see below.)
- **`encumbrance`** — carried-weight → a single `moveSpeed` `mul`
  factor, computed live (the exact scan `EncumbranceSystem` did).

`zone`/`posture` are **future** `ModifierSource`s (one handler each when
a consumer needs them) — not built now; the registry slot is the
extension point. Honest scope: build the three that have consumers.

---

## Buffs are scene-graph children (re-scoped T-235), lifetime is a Resource

The buff-as-child + Resource-lifetime refinement holds and slots in
cleanly:

- `start_buff` (effect resolver) — spawns `data/prefabs/buff.json` as a
  **child** of the target, sets the child's `Buff` ambient-action params
  `{stat,op,value}` (and `tickDeltaPerSec` for DoTs), and seeds
  `Resource.values.buff_timer = {value:durationTicks,max:durationTicks}`
  on the child.
- `buff_timer` Resource (the T-238f `crafting_timer` shape: rate −20/s,
  bounds.min 0, `cross@0` → `expire_buff`).
- `expire_buff` (ResourceEffect) — `world.destroySubtree(entityId)`
  (the child). One line; the buff vanishes, its modifier with it.
- `buff_tick` (the `Buff` ambient action's `:tick`) — periodic-only:
  applies `tickDeltaPerSec·dt` to `getParent(self)` Health (DoT/HoT).
  Pure stat-modifier buffs (speed) need no tick — they only *exist* and
  the `buffs` `ModifierSource` reads them.
- **Consume-on-use** (`damage_boost`/`shield`) are buff children too;
  the damage hook reads the child's modifier at the hit moment and
  `destroySubtree`s it on consumption (consume = remove the source).

Net: **`ActiveEffects` is deleted entirely** — its three roles all
rehome (speed→child modifier, DoT→child tick, consume-on-use→child read
+ destroyed by the damage hook). *(Plan-time caveat: confirm the full
`ActiveEffects` reader set in recon — `flee_effect` and any others —
before the diff; if one genuinely doesn't fit the child model it stays
a thin documented exception rather than a contortion, same rule as
every prior arc.)*

Substrate verified ready: dispatcher advances ambient (`ticks:-1`)
actions on `ActorSlots`-less children and skips intent
(dispatcher.ts:92–121); `spawnPrefab` children recursion +
`setParent`/`getParent`/`destroySubtree` exist; the Resource timer
pattern is shipped + tested (T-238f).

---

## Consequence that reverses an earlier answer (flagging, not flipping)

Open-question **A** was answered "keep `EncumbranceSystem`, delete the
component" — under the *old* DerivedStat framing. The **hybrid model's
whole premise is "compose live, never store/sync,"** which makes an
`EncumbranceSystem`-as-writer structurally pointless: its only output
was `EncumbrancePenalty`, read only by `BuffSystem`. Under hybrid,
encumbrance is just the `encumbrance` **`ModifierSource`** (live
computation); `EncumbranceSystem` *and* `EncumbrancePenalty` both
dissolve into that one contributor. Keeping the system would contradict
the chosen model. **This supersedes answer A** — surfaced explicitly
for objection rather than silently overridden.

---

## Zero hardcoded effect handlers — fully data-driven (user, 2026-05-16)

The five bespoke handler files (`health_effect`, `speed_effect`,
`damage_boost_effect`, `shield_effect`, `flee_effect`) and **all** their
sub-registries (`apply`, `tick`, `compose`, `outgoingDamage`,
`incomingDamage`) + interfaces (`EffectApplyHandler`,
`EffectTickHandler`, `EffectComposeHandler`, `OutgoingDamageHook`,
`IncomingDamageHook`) are **deleted, not ported**. No `switch`/keyed
handler on `effectStat` survives anywhere.

Everything an effect did becomes content + the generic primitive:

- **A buff is data**: `{ stat, op, value, durationTicks, tickDelta? }`
  carried by the `Buff` action on a scene-graph child. `start_buff` (one
  generic resolver) spawns it; the `buffs` `ModifierSource` reads it;
  `buff_tick` applies `tickDelta` (DoT/HoT) to the parent; `buff_timer`
  Resource + `expire_buff` end it. No per-effect code.
- **The damage pipeline becomes a query, not hooks**: `health_hit_handler`
  reads `effective(attacker,"damageDealt",1)` and
  `effective(target,"damageTaken",1)` (and the existing `armorReduction`
  via the `equipment` source). `damage_hook.ts` + both hook registries
  are deleted.
- **Concept-verb / skill effects become generic**: the matrix entry's
  effect collapses to "apply a `{stat,op,value}` — instantly if
  `durationTicks==0` (one-shot delta, e.g. heal/damage), else as a buff
  child." One generic apply path replaces the keyed `EffectApplyHandler`
  registry.

**Accepted retunes (structure over parity — the established norm):**
`damage_boost`/`shield` lose their exact *consume-on-use* semantics —
they become ordinary durationed data-driven modifiers (a timed
`damageDealt` mul / a `damageTaken` reduction). "Absorb N HP then pop"
is not reproduced; if it returns later it is content (a Resource-pool
buff), not bespoke code. `flee` (already ActiveEffects-free, writes
`NpcJobQueue`) is **out of scope** — it is not a stat modifier; it stays
as the one small documented non-modifier effect path (a generic
"area-job" effect resolver, or left as the lone keyed apply if cleaner —
recorded honestly, not contorted).

This makes the arc overwhelmingly deletion + one primitive; the
combat-pipeline risk I flagged is gone (no bespoke porting).

## Phasing — inert substrate first (the T-238a precedent)

The "one non-phaseable commit" constraint is about not splitting the
*deletion* into two live paths. An **inert substrate** that nothing reads
is not a live path — T-238a established and validated exactly this for
the Resource arc (substrate landed inert, byte-identical, green; the
system-deletions came in later focused commits). Same here:

- **Phase 1 — inert substrate (this commit).** `StatModifier` +
  `ModifierOp`, the `ModifierSource` registry, `StatQuery.effective()`,
  and the two fully-buildable-now sources (`equipment`, `encumbrance`).
  Registered in `server.ts` but **no consumer calls `effective()`** —
  `BuffSystem`/`ActiveEffects`/`SpeedModifier`/`EncumbranceSystem` all
  still authoritative. Unit-tested, byte-identical, fully inert. The
  `buffs` source + buff-child machinery are deferred to phase 2 (they
  need the `Buff` action that doesn't exist yet).
- **Phase 2a — inert buff machinery. LANDED.** `buff_timer.json`
  Resource (the T-238f shape), `expire_buff` ResourceEffect
  (`destroySubtree`), `BuffSpec` server-only component, the `buffs`
  ModifierSource, `start_buff`/`buff_tick` action resolvers, the `buff`
  ambient ActionDef. Registered (boot cross-ref needs `expire_buff`/
  `buff_tick`) but **inert** — nothing spawns a buff / carries `BuffSpec`
  / runs the `buff` action; `BuffSystem`/`ActiveEffects` still
  authoritative. 6 tests; 189 green; terrain-bake unaffected. **Honest
  deviation from "buff prefab":** `start_buff` creates a *bare entity*
  (BuffSpec + buff_timer Resource + buff ActiveActions + setParent), not
  `spawnPrefab` — a buff has no model/physics/slots, so spawnPrefab's
  actor/visual preamble would be wrong. Still fully data-driven (the
  buff's data is its params); `data/prefabs/buff.json` is not needed.
  Question C's "generic parameterized" intent is honoured; the "prefab"
  noun isn't.
- **Phase 2b — the swap (one commit, deletes BuffSystem whole).** Rewire
  physics / hit-handler / the resource `equipment_stat` modifier /
  SkillSystem's concept-verb apply to `effective()` + `start_buff`;
  delete `BuffSystem`, `ActiveEffects`, `SpeedModifier`,
  `EncumbrancePenalty`, `EncumbranceSystem`, all five effect handlers +
  the apply/tick/compose/damage-hook registries + `applyBuffById` (dead).
  Open phase-2b fork: how concept-verb matrix entries express their
  effect as data once the keyed handlers are gone (lean: route through
  the existing action-effect Registry — registry-dispatch is endorsed
  doctrine, not a hardcoded switch; collapses 5 handlers → ~2 generic
  resolvers, reusing `modify_health`). Resolve before the 2b diff.

## Shape of the one commit (= phase 2)

**Delete:** `BuffSystem`, `SpeedModifier`, `EncumbrancePenalty`,
`EncumbranceSystem`, `ActiveEffects` (pending reader recon), the
`tick`/`compose` sub-registries + `EffectTickHandler`/
`EffectComposeHandler` + `healthEffectTick`/`speedEffectCompose`, the
consume-on-use sentinel/decrement, `applyBuffById`'s `addActiveEffect`
path.

**Add:** `StatModifier` type + `ModifierSource` registry + `StatQuery`
(`effective`); the `equipment` / `buffs` / `encumbrance` sources;
`start_buff` / `buff_tick` / `expire_buff` resolvers; a `Buff` ambient
`ActionDef`; `data/prefabs/buff.json`; `data/resources/buff_timer.json`.

**Rewire:** `PhysicsSystem` `moveSpeed`, `health_hit_handler`
`armorReduction`, the resource `equipment_stat` modifier (→
`effective`), `applyBuffById` + concept-verb `speed`/`health` apply (→
`start_buff`); spawner, server wiring, component registry.

**Invariants:** registry-dispatch, no `switch`; one commit, no
flags/legacy/parallel path; bake byte-identical (runtime state only);
client untouched (drifted). The `effective()` query is pure-read; add a
per-tick cache only if measured (no premature materialized store — that
would re-introduce exactly what the hybrid model rejects).

---

## Net

Five scattered "modifies an entity" mechanisms collapse to **one
Modifier record + one `effective()` query over a `ModifierSource`
registry**, with conditions expressed by the primitives we already have
(Resource timer, scene-graph child, Equipment, tag). `BuffSystem`,
`ActiveEffects`, `SpeedModifier`, `EncumbrancePenalty`,
`EncumbranceSystem`, and the per-consumer `deriveItemStats` duplication
all go. A buff is now *a scene-graph child carrying an action whose
lifetime is a Resource* — Actions, Resources, and Status/Modifier are
the three content-driven primitives over one substrate; the spine is
complete and `deriveItemStats` (items) finally has its actor-level dual
without either side duplicating the other.
