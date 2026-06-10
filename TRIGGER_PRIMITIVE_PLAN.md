# Trigger as the Fourth Primitive — Implementation Plan

**Status:** FILED — design accepted, no phase landed yet. Companion to
`ACTION_PRIMITIVE_PLAN.md`, `RESOURCE_PRIMITIVE_PLAN.md`,
`STATUS_MODIFIER_PLAN.md`.
**Tickets:** T-259 arc (phases T-259a–c below).
**Thesis:** the fourth primitive over the same substrate. Actions answer
"what is this entity *doing*", Resources "what bounded scalar is *moving*",
Modifiers "what changes this entity's *stats*". Triggers answer **"when
this fact occurs, fire that effect"** — the reactive quarter of the
WoW-style skill vision (on-hit riders, on-kill procs, low-health panic
buttons, on-equip passives-with-behaviour). One `TriggerDef` content type +
one `TriggerSystem` replaces the strike-rider plumbing and pre-empts every
future hand-rolled "subscribe + check + apply" coupling.

---

## The shape (restated precisely)

The codebase already contains the pattern, hand-rolled, in one full
instance and several half-instances:

> when event **E** occurs and entity **O** is involved in role **R**, and
> conditions **C** hold, fire effect specs **F** with the event's other
> party bound as target.

- **Strike riders (the full instance, and the slop).** A melee hit lands →
  `strikeVerb()` has pre-read the attacker's `LoreLoadout` for a
  `strike`-verb slot → the slot index travels as a *string*
  (`HitContext.skillVerb = "strike:N"`) → `HealthHitHandler` parses it and
  publishes `StrikeLanded` → `SkillSystem.registerSubscribers`'s bus
  subscriber calls `resolveStrike` → which re-reads the loadout, re-resolves
  fragments → matrix entry → fires the effect. Seven sites
  (`combat.ts:82`, `hit_handler.ts:47`, `health_hit_handler.ts:218`,
  `tile_events.ts:44,135`, `skill.ts:48,99`) exist only to route one fact
  to one effect. **Design decision (this arc's origin): the `strike` verb
  is obsolete — a swing is an action, and on-hit behaviour is an effect of
  that action's hit.**
- **Resource threshold events (the producer half).** `emit_event`
  (T-238c) already publishes named `TileEvents` when a Resource crosses a
  threshold. Nothing content-defined can *consume* them — NpcAi reads
  hunger directly; the events only reach the client. Triggers are the
  missing consumer half.
- **The wished-for instances (the vision).** "When below 10 % health,
  gain a frenzy buff", "on kill, restore stamina", "arrows apply venom on
  hit" — each would today be a new subscriber + a new bespoke check. Each
  becomes one JSON file.

**Explicit non-instance: reactions.** `HealthHitHandler` posting
`PendingReaction` (hit_front / stagger) is *synchronous resolution*, not a
rider — combat rules must resolve within the tick. Reactions stay exactly
where they are. (A later convergence — triggers that *start actions* via a
`request_action` effect — is recorded under "Later", with the latency
caveat that rules it out for core combat reactions.)

---

## What is honestly in scope (and what is not)

**In scope:**
- `TriggerDef` content type (`data/triggers/{id}.json`) + registry +
  loader + bootstrap (version bump; client re-receives — doctrine permits).
- `TriggerSystem`: the **single** event→effect bridge. Subscribes to the
  real bus (post-changeset flush, the exact timing `resolveStrike` runs at
  today — "invisible at 20 Hz" per the existing skill.ts comment).
- A `TriggerSource` registry mirroring `ModifierSource` (hybrid doctrine:
  read live from the store that owns the data) — v1 source: `equipment`
  (weapon + armor prefab `triggers[]`).
- Reifying the hit: `HitLanded` event (attacker, target, bodyPart, damage,
  blocked) published where `StrikeLanded` is today.
- **Deleting the entire strike path** in the same commit the weapon-trigger
  replacement lands (replace, don't accrete).
- Conditions = the existing **gate registry** (`GateContext` is already
  `{world, entityId, content, params}` — a pure per-owner test; no new
  condition machinery).
- Internal cooldowns (ICD) per trigger — the proc-loop brake.

**Not in scope (recorded, deliberately):**
- Inscription / zone / buff-granted triggers (later sources; one
  `TriggerSource` file each when they come).
- Triggers starting actions (`request_action` effect) — wanted for
  "triggered advanced actions", needs the PendingReaction-vs-latency
  design first.
- Networking trigger state (same stance as buffs/resources: server-only
  until the client rebuild).
- The verb matrix's fate. After this arc the matrix's `strike` rows are
  unreferenced (only `invoke`/`ward`/`step` resolve). The matrix retires
  wholesale in the slots→actions step (skill-arc step 2b, separate ticket)
  — per the project decision that the matrix goes but data-driven effect
  composability stays.

---

## TriggerDef (content schema — `data/triggers/{id}.json`)

```json
{
  "id": "vampiric_bite",
  "on": "hit_landed",
  "as": "attacker",
  "conditions": [
    { "gate": "not_exhausted" }
  ],
  "internalCooldownTicks": 0,
  "effects": [
    { "kind": "health",
      "params": { "magnitude": 5, "targeting": "entity", "drainToCaster": true } }
  ]
}
```

- `on` — event kind, from a **closed v1 catalog** (see below). Boot
  cross-check: unknown kind = fail fast.
- `as` — which event role binds to the trigger's **owner** O. A weapon
  trigger fires for its wielder when *their* hit lands (`as: "attacker"`);
  an armor trigger may fire when the wearer *is* hit (`as: "target"`).
  The same entity being hit does not proc its own on-hit weapons.
- `conditions` — gate refs, tested against the owner. Boot cross-checked
  against the gate registry. A low-health proc is `on: "damage_taken"`
  + a new `health_below { fraction }` gate — **no new event needed**.
- `effects` — specs fired through the **one** action-effect registry
  (T-246), `entityId` = owner, `overrideTargetId` = the event's other
  party merged into params. Boot cross-checked.
- `internalCooldownTicks` — optional ICD; runtime remaining lives in a
  server-only `TriggerCooldowns { remaining: Record<triggerId, ticks> }`
  component on the owner (same honest stance as `skillCooldowns`:
  per-instance N-counters don't fit the single-named-scalar Resource —
  recorded at T-248).

### Event-kind catalog (v1 — closed, grows one entry per need)

| kind | published by | roles |
|---|---|---|
| `hit_landed` | `HealthHitHandler` after resolution (NEW — replaces `StrikeLanded`) | attacker, target |
| `damage_taken` | existing `DamageDealt` | attacker (sourceId), target |
| `entity_died` | existing `EntityDied` | killer, victim |

Each catalog entry is a tiny binding record (event symbol → role-id
extraction), registered like everything else. Resource `emit_event`
payloads (`{ entityId }`) join the catalog when a use case arrives.

---

## Runtime (TriggerSystem)

Per subscribed event, during the post-changeset flush:

1. Resolve involved entities per the catalog binding (e.g. attacker +
   target).
2. For each involved entity O and role R: collect O's trigger ids from the
   `TriggerSource` registry (v1: `equipment` walks weapon+armor prefab
   `triggers[]` — live read, no materialized list to sync).
3. For each trigger: match `on` + `as` (R), test `conditions` (gates, owner
   = O), check ICD.
4. Fire `effects` through the action-effect registry (owner as `entityId`,
   other party as `overrideTargetId`, synthetic slot/state — the same
   dispatch shape `SkillSystem.dispatch` uses since T-246).
5. Stamp ICD.

**Re-entrancy invariant:** effects fired by triggers may themselves publish
catalog events (the `health` effect publishes `DamageDealt`). The bus is
synchronous during flush → unguarded, a lifesteal weapon would proc itself.
v1 rule: **no re-entry** — `TriggerSystem` sets a `dispatching` flag and
drops (logs) events arriving while it is set. Proc chains are a design
decision for later, not an accident now.

---

## Phasing (each a green commit; old path deleted in the same commit its replacement lands)

### T-259a — the primitive, standalone
`TriggerDef` type + `data/triggers/` loader + content registry + bootstrap
bump · event-kind catalog (3 entries; `HitLanded` event + payload added and
published by `HealthHitHandler` **alongside** the still-live `StrikeLanded`
for this one commit — additive fact, not a parallel implementation) ·
`TriggerSystem` + `TriggerSource` registry + `equipment` source ·
`TriggerCooldowns` component · boot cross-checks (on-kind, gates, effect
kinds, prefab `triggers[]` ids) · tests: a weapon trigger procs on
`hit_landed`, `as` filters roles, conditions gate, ICD throttles, re-entry
dropped.

### T-259b — the strike cutover (the deletion commit)
`data/triggers/vampiric_bite.json` + `triggers: ["vampiric_bite"]` on the
wolf's weapon prefab — behavioural replacement for the wolf's
`strike`/DRAIN loadout slot. **Deleted in this same commit:** `strikeVerb()`
(combat.ts), `HitContext.skillVerb`, the `StrikeLanded` publish + event +
payload, `SkillSystem.resolveStrike` + `registerSubscribers`, the wolf
template's strike slot. `LoreLoadout` slots are active-only from here
(`strike` verb gone from live data; matrix strike rows inert — they retire
with the matrix in skill-arc 2b). Tests updated; the wolf's drain asserted
via the trigger path.

### T-259c — the proc surface (prove the generality)
`health_below` gate · two shipped demo triggers: an on-kill stamina restore
(`entity_died` / `as: killer`) and a low-health frenzy
(`damage_taken` / `as: target` / `health_below 0.25` / `damage_boost`
effect + ICD) · attach via an actor-level source (`NpcTemplate.triggers[]`
or a player starting-kit item — whichever needs no new component) ·
boot-check sweep.

---

## Invariants

- `ActionDispatcher` stays the only **phase-edge** effect firer;
  `TriggerSystem` is the only **event→effect** bridge. weapon_trace /
  projectile_trace dispatch hits, never effects-of-hits.
- Synchronous combat resolution (HitHandler chain, PendingReaction,
  block/parry/poise) is untouched — triggers are riders, ≤1 tick later,
  the strike path's documented status quo.
- Phase-edge vocabulary stays `enter/tick/exit` — no pseudo-edges; facts
  are events, not phases.
- Every content id (on-kind, gate, effect, trigger ref) boot-cross-checked,
  fail-fast.
- No trigger re-entry (v1).
- One effect registry; trigger effects reuse T-246's resolvers unchanged.

## Net

**Deleted:** the seven-site strike path (~110 lines + one wire-facing
event), the last string-typed side-channel in `HitContext`.
**Added:** ~1 system + 1 content type + 1 source registry + 3 catalog
entries + 1 gate (~250 lines), all registry-shaped.
**Bought:** every future "when X then Y" — on-hit, on-kill, low-health,
on-block, on-equip behaviours, zone procs — becomes one JSON file + at
most one new catalog entry or gate, never a subscriber, never a system.
The four primitives close: **Actions · Resources · Modifiers · Triggers.**
