# Voxim2 — Architecture Reference

Medieval post-apocalyptic multiplayer action RPG. Deno + TypeScript monorepo.
Single authoritative tile-server per 512×512 world tile, browser client over WebTransport/QUIC.

---

## Ticket system

All significant engineering work is tracked in `TICKETS.md`. Source of truth for what has been
built and what remains.

**When to create a ticket:** any new system, feature, or non-trivial bug fix — including work
that comes up organically. If it's more than a one-liner, it gets a ticket. When in doubt, create one.

**When to update a ticket:** mark `Status: in-progress` when work starts. On completion, mark
`Status: done` and add `Commit: <short hash>`. The ticket is the audit trail. When a refactor
retires a ticket's premise (the system it targeted no longer exists), mark `Status: obsolete`
with a one-line reason — it records that the work will deliberately never be done, rather than
leaving a stale `todo` that contradicts the codebase.

```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done|obsolete   [Commit: abc1234]

What needs to be built and what "done" looks like.
```

New tickets go at the bottom of the relevant domain section. Never reuse a ticket number.

---

## Git workflow

Commit after every reasonable self-contained change. Prefix with the affected package:

```
tile-server: add DodgeSystem cooldown reset on death
engine: fix query returning stale component after removal
codecs: add AnimationState codec fields for attack style
```

If a change spans multiple packages, list the primary one first.

---

## Refactoring philosophy

Refactors **replace, they don't accrete**. When a system changes shape, the old code is
deleted in the same commit as the new code lands — not beside it. The goal of a refactor
is a codebase that reads like it was designed this way from the start.

Hard rules:

- **No shims or re-export bridges.** If `oldFoo.ts` becomes `new/foo.ts`, every import
  site updates. The old path does not survive as a thin re-export "for transition".
- **No `@deprecated` markers with parallel new implementations.** Either the thing is
  authoritative or it's gone. Deprecation with two live paths is how codebases turn into
  layers of half-truth that future readers have to reconcile.
- **No feature flags or "legacy" / "classic" branches to ease migration.** If
  `if (useNewFoo)` appears in the diff, rewrite the patch.
- **No backwards compatibility with on-disk state or wire formats.** Saves, heritage
  files, save files, and the binary protocol may all break between refactors. Users
  reconnect; worlds regenerate from seed; clients re-receive content over WT handshake.
  This freedom is why the code stays shapely — defend it.
- **Data and code move together.** Renaming a field means updating every JSON file that
  uses it in the same commit as the TypeScript rename. Regenerated static files go in
  the same commit too.
- **Delete the plan or the scaffolding once the refactor lands.** If a phased plan
  exists for the refactor, mark it done in `TICKETS.md` with the commit hash in the
  same commit that finishes the last phase — don't leave a "done" document floating.

A refactor that doubles the surface area (old + new both live) is not a refactor — it's
a migration debt you've signed yourself up for. Take the big diff instead.

---

## Running the project

```
deno task demo          # bundle client + start tile server
deno task tile          # server only
deno task bundle        # client bundle only
deno task gen-terrain   # regenerate terrain_tile_0.bin
# content auto-loads from packages/content/data/ at server boot — no aggregation step needed
deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts
```

---

## Package map

| Package | Import alias | Purpose |
|---------|-------------|---------|
| `packages/engine` | `@voxim/engine` | ECS core — World, ComponentDef, EventBus, physics math. Zero game dependencies. |
| `packages/codecs` | `@voxim/codecs` | Binary codecs for every **networked** component. Shared by server and client. |
| `packages/protocol` | `@voxim/protocol` | Wire message types, ComponentType enum, InputDatagram codec, action bitflags, length-prefixed framing. |
| `packages/content` | `@voxim/content` | Data-driven game definitions. ContentStore loads from per-item JSON files in `packages/content/data/`. |
| `packages/world` | `@voxim/world` | Terrain generation, heightmaps, biome zones. |
| `packages/tile-server` | — | Authoritative game server — systems, components, save/load, NPC AI. |
| `packages/client` | — | Browser client — Three.js render, input, state interpolation, skeleton animation. |
| `packages/gateway` | — | Stub multi-tile router. Out of scope for now. |

---

## ECS overview

### Defining a component

`ComponentDef` is a discriminated union with two variants. TypeScript enforces the contract at the
call site — the compiler will reject a misconfigured def:

```typescript
// Networked component — wireId is REQUIRED (stable wire-format ID, never reuse)
export const Health = defineComponent({
  name: "health" as const,
  wireId: ComponentType.health,          // from @voxim/protocol ComponentType enum
  codec: buildCodec<HealthData>({ current: { type: "f32" }, max: { type: "f32" } }),
  default: (): HealthData => ({ current: 100, max: 100 }),
});

// Server-only component — networked: false is REQUIRED, no wireId
export const PendingReaction = defineComponent({
  name: "pendingReaction" as const,
  networked: false,
  codec: pendingReactionCodec,
  default: (): PendingReactionData => ({ actionId: "" }),
});
```

`NetworkedComponentDef` and `ServerOnlyComponentDef` are both exported from `@voxim/engine` if
you need to narrow the type.

### Write APIs

| Method | When | Effect |
|--------|------|--------|
| `world.write(id, C, v)` | Spawning / input drain | Immediate, bypasses changeset |
| `world.erase(id, C)` | Spawning cleanup | Immediate removal |
| `world.set(id, C, v)` | Inside systems | Deferred until `applyChangeset()` |
| `world.remove(id, C)` | Inside systems | Deferred removal |
| `world.destroy(id)` | Inside systems | Tombstones entity; purged on `applyChangeset()` |

### Read APIs

```typescript
world.get(entityId, Health)           // T | null
world.has(entityId, Health)           // boolean
world.isAlive(entityId)               // boolean
world.query(Position, Velocity)       // Array<{ entityId, position, velocity }>
```

Queries use a **reverse component index** — cost is O(smallest matching set), not O(all entities).

### Systems

```typescript
export interface System {
  prepare?(serverTick: number, ctx: TickContext): void;  // optional pre-tick hook
  run(world: World, events: EventEmitter, dt: number): void;
}
```

Systems never call `applyChangeset()` themselves. They accumulate deferred writes via `world.set()`
and `world.remove()`; the tick loop commits them all at once after all systems have run.
**A system cannot see another system's writes until the next tick.** This is intentional.

### Server tick sequence (20 Hz)

1. **Drain input** — latest InputDatagram per player written to InputState via `world.write()`
2. **Run systems** — in declared order; deferred writes accumulate in the changeset
3. **Apply changeset** — `world.applyChangeset()` commits all deferred writes and removals
4. **Fire events** — deferred EventBus queue flushed; subscribers see committed state
5. **Build delta** — changed components in the changeset encoded once per component
6. **Send state** — per-session AoI filter (128-unit radius), encode BinaryStateMessage, send
7. **Advance tick** — auto-save every 6000 ticks (5 min at 20 Hz) if SaveManager is active

### System execution order (`server.ts`)

The concrete order is dependency-sorted at boot (`sortSystemsByDependencies`); the
shape that matters:

```
NpcAiSystem → (Lifetime/Equipment/Placement/Crafting/ResourceNode/
DayNight/ResourceSystem) → PhysicsSystem
→ ActionDispatcher → (ItemPhysics/TerrainDig/
Trader/Dynasty) → AnimationSystem → HitboxSystem → PoiSystem → DeathSystem
```

Order invariants: `NpcAiSystem` writes NPC `InputState` (via `world.write`) before
`PhysicsSystem`/`ActionDispatcher` consume it; `ActionDispatcher` is the single
writer of `ActiveActions` and replaces the retired ActionSystem + DodgeSystem +
CharacterStateMachine (the whole character-behavior arc, T-225–T-234);
`TriggerSystem` runs early, draining last tick's buffered events so procs land
in this tick's changeset (T-259); `AnimationSystem` runs
late so it derives `AnimationState` from the tick's final `ActiveActions` + tags.

---

## Adding or reworking a component

### Adding a networked component (3 steps)

1. **Define** the component in the appropriate file under `packages/tile-server/src/components/`,
   adding both `wireId: ComponentType.X` and a codec from `@voxim/codecs`:
   ```typescript
   export const Foo = defineComponent({
     name: "foo" as const,
     wireId: ComponentType.foo,
     codec: fooCodec,
     default: (): FooData => ({ ... }),
   });
   ```
2. **Reserve a wire ID** — add a new entry to the `ComponentType` const object in
   `packages/protocol/src/component_types.ts`. Never reuse a retired numeric ID.
3. **Register** — add `Foo` to the `NETWORKED_DEFS` array in
   `packages/tile-server/src/component_registry.ts`. The `DEF_BY_TYPE_ID` map is derived
   automatically from `def.wireId`. No separate `typeId` field in the registry.
4. **Add the codec** in `packages/codecs/src/components.ts` so the client can decode it.
5. **Write at spawn** in `spawner.ts` if all entities need it.

### Adding a server-only component (1 step)

Set `networked: false` on the def. That is all — it will be excluded from wire deltas, AoI spawn
messages, and the registry automatically. The codec may be defined inline in the component file.

### Retiring a component

- Leave the numeric slot as a comment in `component_types.ts` (e.g. `// 10 (attackCooldown) retired`) — IDs are permanent.
- Remove from `NETWORKED_DEFS` in `component_registry.ts`.
- Remove from `spawner.ts` and all system reads/writes.
- Delete the `defineComponent()` call and its codec.

### Codec rules

- **Networked codecs belong in `@voxim/codecs`** — the client and server must share them.
  Never define a networked codec inline in a component file.
- **Server-only codecs** may be inline (the client never sees them).
- Use `buildCodec<T>({ field: { type: "f32" } })` for flat structs with primitives.
- Use `WireWriter` / `WireReader` for variable-length data (strings, arrays, nested objects).
- Every codec must implement `Serialiser<T>` from `@voxim/engine`.

---

## Network protocol

### Wire framing

All reliable stream messages (join handshake, state updates, commands) use length-prefixed binary
framing provided by `@voxim/protocol`:

```typescript
import { encodeFrame, makeFrameReader } from "@voxim/protocol";

// Sender
writer.write(encodeFrame({ type: "join", ... }));   // JSON objects
writer.write(encodeFrame(binaryBytes));              // Uint8Array pass-through

// Receiver
const { readJson, readFrame, readPayload } = makeFrameReader(reader);
const msg = await readJson();      // reads one length-prefixed JSON message
const raw = await readPayload();   // reads one length-prefixed binary payload
```

Never roll a custom length-prefix implementation — always use these helpers.

### InputDatagram (client → server, unreliable datagrams, ~60 Hz)

36-byte fixed binary: `seq` (u32, monotonic), `timestamp` (f64, wall-clock ms for RTT),
`facing` (f32 radians), `movementX/Y` (f32 normalised), `actions` (u32 bitfield),
`interactSlot` (u32).

Action bitflags (defined in `packages/protocol/src/messages.ts`):
```
ACTION_USE_SKILL = 1 << 0    ACTION_BLOCK  = 1 << 1    ACTION_JUMP     = 1 << 2
ACTION_INTERACT  = 1 << 3    ACTION_DODGE  = 1 << 4    ACTION_CROUCH   = 1 << 5
ACTION_CONSUME   = 1 << 6    ACTION_SKILL_1 = 1 << 7   ACTION_SKILL_2  = 1 << 8
ACTION_SKILL_3   = 1 << 9    ACTION_SKILL_4 = 1 << 10
```

### BinaryStateMessage (server → client, reliable stream, 20 Hz)

Length-prefixed binary, encoded by `binaryStateMessageCodec`. Contains:
- `entitySpawns` — full component snapshots for entities entering AoI this tick
- `entityDestroys` — entity IDs that left AoI or died
- `componentDeltas` — per-entity changed components (only changed, only AoI)
- `events` — discrete game events (damage, death, crafting, etc.)
- `ackInputSeq` — last input seq processed (for client-side reconciliation)

### Session lifecycle

1. Client opens WebTransport session → tile-server accepts in `handleSession()`
2. Client sends `TileJoinRequest` (JSON, length-prefixed)
3. Server responds with `TileJoinAck` (JSON) or closes session on error
4. Reliable stream: server pushes `BinaryStateMessage` each tick; client sends `CommandDatagram`
5. Unreliable datagrams: client sends `MovementDatagram` ~60 Hz; server sends nothing on datagrams
6. Disconnect: session cleaned up, player entity destroyed, dynasty saved to HeritageStore

### Rewind / lag compensation

On the first active tick of a swing, the `weapon_trace` effect resolver rewinds the
target's position using `StateHistoryBuffer.getAt(serverTick - rttTicks)`. NPCs
always use the current tick.

---

## Content / data-driven design

All tuning lives in `packages/content/data/`. No hardcoded game values in systems.

### Directory layout

Each content type has its own subdirectory — **one JSON file per item**. Adding a new sword,
NPC, or recipe requires dropping a single file; no code changes needed.

```
data/
  models/           {id}.json    — ModelDefinition (voxel geometry + skeleton binding)
  skeletons/        {id}.json    — SkeletonDef (bone hierarchy + animation clips)
  prefabs/          {id}.json    — Prefab (model + open-set component data; extends for inheritance)
  prefabs/items/    {id}.json    — item prefabs (weapon, tool, armour, food, etc.)
  npcs/             {id}.json    — NpcTemplate (archetype stats, skill loadout, behavior)
  weapon_actions/   {id}.json    — WeaponActionDef (swing timing, hitbox shape, IK targets)
  recipes/          {id}.json    — Recipe (crafting inputs/outputs, station requirement)
  lore/             {id}.json    — LoreFragment (skill concept + magnitude)
  materials/        {name}.json  — MaterialDef (numeric id in file, name is filename)

  game_config.json              — singleton: combat ratios, physics constants, AI defaults
  terrain_config.json           — terrain generation parameters
  tile_layout.json              — optional: NPC/prop placement overrides for a specific tile
```

### Loader

The server calls `JsonSource.load(dataDir?)` from `@voxim/content`. It scans each subdirectory,
sorts filenames alphabetically for deterministic registration order, and loads each file as one item.

### Client bootstrap

The browser client cannot use `Deno.readDir`. Instead, the tile-server pre-encodes the entire
ContentService into a binary blob (`encodeBootstrap`) at startup and sends it on the join stream
right after `TileJoinAck`. The client reads the blob, calls `BootstrapSource.load(blob)`, and
holds a fully-hydrated ContentService for the session — every lookup is in-process / synchronous.

Property: tile-server crash → client connection dies → client reconnects → fresh blob → version
drift impossible. Edit content, restart the tile-server, players reload — no client rebuild.

UI components access content via the `contentService` signal (`packages/client/src/ui/content_ref.ts`)
— Preact reactivity rebuilds derived values when the signal swaps on tile transition.

### Adding a new weapon action

Drop a file in `data/weapon_actions/spear_thrust.json`:
```json
{
  "id": "spear_thrust",
  "windupTicks": 6, "activeTicks": 3, "winddownTicks": 8,
  "animationStyle": "spear_thrust",
  "staminaCost": 12,
  "swingPath": {
    "defaultBladeRadius": 0.04,
    "defaultBladeLength": 2.2,
    "keyframes": [
      { "t": 0.0, "hiltFwd": 0.1, "hiltRight": 0.25, "hiltUp": 1.0,
        "bladeFwd": 1.0, "bladeRight": 0.0, "bladeUp": 0.0 }
    ]
  },
  "ikTargets": [
    { "chain": ["upper_arm_r", "lower_arm_r"], "source": "hilt",
      "poleHint": { "fwd": 0.2, "right": 0.4, "up": 0.7 } }
  ]
}
```
Set `weaponActionId: "spear_thrust"` in the item prefab's `swingable` component. Restart the
tile-server; clients pick up the new action automatically on next connect via the bootstrap blob.
No other code changes needed — the swingPath drives hit detection, arm IK, and trail rendering.

### ContentService access

Injected into every system constructor. Never import JSON files directly. Never hardcode tuning.

```typescript
content.getWeaponAction("slash")
content.getPrefab("wooden_sword")          // items are prefabs; no getItemTemplate()
content.getPrefab("wolf")
content.deriveItemStats(prefabId)          // reads Swingable, Armor, Edible, etc. from prefab.components
content.deriveItemStats(prefabId, [], q)   // optional quality 0-1 multiplier for QualityStamped items
```

### Items as prefabs and entities

Every "thing you can hold, wear, swing, eat, or deploy" is a `Prefab` carrying one or more
item-behaviour components (`Equippable`, `Swingable`, `Tool`, `Deployable`, `Edible`,
`Illuminator`, `Armor`, `MaterialSource`, `Composed`, `Stackable`, `Weight`, `Renderable`).

Stackable items (grain, ingots, arrows) stay as `{ kind: "stack", prefabId, quantity }` compact
inventory slots — they are interchangeable and don't justify entities.

Unique items (swords, armour, tomes) are world entities carried by inventory / equipment
entity-refs (`{ kind: "unique", entityId }`). Each unique item entity can carry instance
components (`Durability`, `Inscribed`, `QualityStamped`, `History`, `Owned`) that give it
mutable per-instance state independent of its prefab.

The discriminator is `Stackable`: a prefab with `stackable: {}` in its components produces
stack slots; without it, each crafted copy is its own entity.

---

## Universal primitives over one substrate

The engine is being collapsed onto a small set of **content-defined
primitives** that share one dispatch substrate (`Registry<H>` +
effect-resolver), instead of a bespoke per-mechanic system each. All
three are landed.

- **Action primitive (T-225–T-234 — `ACTION_PRIMITIVE_PLAN.md`, done).**
  Every behaviour — swing, dodge, block, stagger, consume, locomotion — is
  a content `ActionDef`: a slot action with windup/active/winddown phases
  whose edges fire `effects` gated by `gates`, dispatched entity-generic.
  Replaced ActionSystem + DodgeSystem + the CharacterStateMachine.

- **Resource primitive (T-238 — `RESOURCE_PRIMITIVE_PLAN.md`, done).**
  Every bounded tick-scalar is a content `ResourceDef`: a `value` in
  `[min,max]` moved each tick by a signed `rate` (optionally bent by a
  closed `rateModifier` vocabulary), crossing named `thresholds` that fire
  a `ResourceEffect`. One `ResourceSystem` + `data/resources/*.json`
  replaced `StaminaSystem`, `HungerSystem`, `PoiseSystem`, and the
  crafting time-step loop; the `exhausted` flag and `Stamina`/`Hunger`/
  `Thirst`/`Poise` components are gone. It is entity-generic: the crafting
  countdown is the same primitive on a *workstation* entity. **The
  corruption mechanic was removed wholesale (T-238e), not migrated — it
  returns later at a different scale; wire ids 24/25 stay retired.**

- **Status/Modifier primitive (T-239 — `STATUS_MODIFIER_PLAN.md`, done).**
  "What changes this entity's stats?" is one `StatModifier {stat,op,value}`
  + one `effective(entity,stat,base)` query (`(base+Σadd)×Πmul`) over a
  `ModifierSource` registry. Hybrid: sources read live from the store that
  already owns the data — `equipment` (the Equipment component),
  `encumbrance` (carried weight), `buffs` (scene-graph children). A buff
  is a child entity = `BuffSpec` + the `buff` ambient action (DoT tick) +
  a `buff_timer` Resource lifetime: **all three primitives compose into
  one mechanism.** Replaced `BuffSystem`, `ActiveEffects`,
  `SpeedModifier`, `EncumbrancePenalty`, `EncumbranceSystem`, the five
  bespoke effect handlers + the apply-only-survivor of five sub-registries
  + the consume-on-use damage hooks; the per-consumer `deriveItemStats`
  duplication is gone. `deriveItemStats` (items) now has its actor-level
  dual without either side storing the other.

- **Trigger primitive (T-249+T-259 — `TRIGGER_PRIMITIVE_PLAN.md`, done).**
  "When fact X occurs, fire effect Y": a content `TriggerDef`
  (`data/triggers/*.json`) names an event kind from a **closed catalog**
  (`hit_landed` / `damage_taken` / `entity_died`), a role binding (`as:
  attacker|target|killer|victim`), gate `conditions`, an internal cooldown,
  and `effects` fired through the one action-effect registry with the
  event's other party bound as target. One buffered `TriggerSystem` is the
  **single event→effect bridge** (collects during the notify-only flush,
  drains at the top of its next run, writes via `world.mutate` so
  concurrent procs compose; ≤1-tick latency). Owners get triggers from
  `TriggerSource`s reading live stores: `equipment` (worn prefabs'
  `triggers[]`) and `npc_template` (innate archetype procs). No proc
  chains (v1): trigger-published events are `viaTrigger`-tagged and
  skipped by collectors. **Replaced the seven-site strike path**
  (strikeVerb / HitContext.skillVerb / StrikeLanded / resolveStrike) —
  on-hit behaviour is content (`vampiric_bite`), not a loadout verb.
  Underpinned by T-249: the changeset is an ordered op-log and
  `world.mutate(id, C, fn)` is the deferred read-modify-write every
  multi-writer component (Health, Resource) now uses.

All reuse the same doctrine: a designer adds a new effect / gate /
rateModifier / threshold / modifier-source / trigger-source as **one handler file + one
`register()` call**, never an engine edit, and every content id is
**cross-checked against its registry at boot** (fail-fast — see the
ResourceDef / buff / recipe-step / BT checks in `server.ts`). Buff /
modifier / resource state is server-only for now (networking is a later
add, same call `ActiveActions` made).

The spine is complete: **Actions, Resources, Status/Modifier, Triggers** —
four content-driven primitives over one substrate.

---

## Combat and skills

### Two-layer architecture

```
ActionDispatcher (Layer 1 — universal action primitive: every behaviour
  is a slot action with windup/active/winddown phases + effects)
  → TriggerSystem (Layer 2 — on-hit/on-kill riders: content TriggerDefs
    consuming the HitLanded/DamageDealt/EntityDied facts, T-259)
```

**ActionDispatcher** (the universal behaviour primitive, T-225–T-234 — see
`ACTION_PRIMITIVE_PLAN.md`) is the single writer of `ActiveActions`. It advances each
occupied slot's content-defined action through its phases and fires the action's
`effects` on phase edges. The swing's physics is the `weapon_trace` effect resolver:
hitbox sweep, damage, knockback, parry/block/counter — dispatched to the per-target
`HitHandler`s in `packages/tile-server/src/handlers/`. Movement lock, i-frames,
stagger, block, dodge, consume are all just actions/tags now — no bespoke per-mechanic
systems.

**There is no SkillSystem (T-260b).** An active skill IS an `ActionDef`
(`data/actions/skill_*.json`): phases, stamina `costs`, gate
`preconditions`, `cooldownTicks` + `triggersGcd` (the dispatcher's
cooldown primitive, T-260a — state in the server-only `ActionCooldowns`),
and `effects` with inline params (e.g. `health` on `active:enter`). A
`SKILL_N` press becomes primary-slot intent via `SkillIntentResolver`
(composes after the bit-derived primary intent, so a skill press beats a
swing press); the dispatcher arbitrates and runs it like any other action.
On-hit riders are content triggers consuming the `HitLanded` fact via
`TriggerSystem` (T-259).

### "Is the actor swinging?"

There is no `SkillInProgress` component (retired with the CSM). The action runtime is
the source of truth: an actor is mid-action when its slot carries an active-kind
action —
`content.actions.get(world.get(id, ActiveActions)?.states["primary"]?.actionId)?.kind
=== "active"`. Phase / `ticksInPhase` / per-resolver `scratch` (rewind tick, hit
dedup) live in that slot's `ActiveActionState`.

### Skill loadout

`LoreLoadout`: 4 skill slots, each the **id of a skill ActionDef** (or null),
plus `learnedFragmentIds` (lore learning; lost on death). The verb +
fragment-pair composition and the concept-verb matrix are GONE (T-260b) —
a skill's behaviour lives entirely on its ActionDef; fragment-driven
magnitude scaling returns later as param interpolation if wanted. Players
seed their bar from `game_config.player.startingSkills` (boot-cross-checked
against `content.actions`). NPCs carry no LoreLoadout (their procs are
weapon/archetype triggers, T-259).

Effect magnitude = `outwardFragment.magnitude × entry.outwardScale`.

---

## Client animation

`skeleton_evaluator.ts` generates bone poses via a three-stage pipeline each frame:

1. **Base FK** — lower body always plays locomotion (idle / walk). Upper body plays locomotion or
   is overridden by constraint producers.
2. **Constraint producers** — the weapon layer reads `swingPath` hilt + `ikTargets` from the
   weapon action and produces IK constraints. Torso lean derives from hilt position. Other
   producers (look-at, foot planting) contribute additional constraints.
3. **Constraint solver** — solves all constraints generically. Two-bone IK via `ik_solver.ts`.

### Hilt-centric weapon system

SwingPath keyframes define hilt position + blade direction. Tip is always derived:
`hilt + bladeDir × bladeLength` via `deriveTip()`. This single path drives:
- Server hit detection: swept capsule in the `weapon_trace` effect resolver
- Client arm animation: IK constraint targets
- Client trail ribbon: tip position each frame

`ik_solver.ts` is generic — reusable for any bone chain. `ikTargets` on `WeaponActionDef`
specifies which chains track which swingPath points.

`AnimationSystem` runs late each server tick and derives `AnimationState` purely from
the actor's slot `ActiveActions` + tags (locomotion/primary/reaction projections) plus
health — it never reads raw input and has no velocity-heuristic or CSM fallbacks.

---

## NPC AI

`NpcAiSystem` writes to the **same `InputState` component** as players. All downstream systems
are NPC-unaware — no `isNpc` branches anywhere in physics, combat, or skill code.

Differences between NPCs and players are expressed through component data: `NpcTag` (marker),
`NpcJobQueue` (AI job scheduler), `triggers[]` procs from the NPC template (T-259c).

Job queue: `current` job + `scheduled` list + `plan` (waypoints). Replanning is budgeted
per tick to prevent frame spikes. Per-archetype behaviour is a data-driven behaviour tree
(`data/behavior_trees/`, `behaviorTreeId` on the NPC template); `NpcAiSystem` is a generic
BT interpreter with no per-archetype branches. A tree's `request_action` node names an
action directly (via the `RequestedActions` component → `RequestedActionIntentResolver`),
so signature moves are data, not just the input-bit subset (T-234).

---

## Save / load

`SaveManager` (injected into TileServer, optional) persists a binary snapshot:

**What is saved:** WorldClock, all terrain chunks (Heightmap + MaterialGrid),
resource node positions and HP.

**What is NOT saved:** Players (reconnect and respawn fresh), NPCs (re-spawned from config),
transient state (ActiveEffects, cooldowns).

Format: `VXM2` magic + version u32 + timestamp f64 + entity list. Each entity: UUID + component
list of `(wireId u8, dataLen u16, bytes…)`. Loading is forward-compatible — unknown typeIds are
skipped without error.

---

## Server module structure

The `TileServer` class in `server.ts` owns the tick loop and session map. Large subsystems are
extracted into separate modules:

| File | Responsibility |
|------|---------------|
| `server.ts` | TileServer class, tick loop, system wiring, delta build, state send |
| `admin_server.ts` | HTTP admin endpoint (`/status`, `/save`), gateway registration |
| `quic_server.ts` | `listenQuic()` — opens Deno.QuicEndpoint, upgrades to WebTransport |
| `session.ts` | `ClientSession` — per-player input ring buffer, reliable stream writer |
| `spawner.ts` | `spawnPrefab()` — single entry point for every entity type; installs visual shell + compound archetypes + direct components |
| `aoi.ts` | `computeSessionUpdate()` — AoI diff, entity spawn/despawn, event filter |
| `component_registry.ts` | `NETWORKED_DEFS[]`, `DEF_BY_TYPE_ID` — derived from `def.wireId` |
| `save_manager.ts` | Binary save/load for terrain + world state |
| `state_history.ts` | `StateHistoryBuffer` — rolling snapshot for lag compensation rewind |
| `heritage_store.ts` | Persistent dynasty/heritage data across player deaths |
| `spatial_grid.ts` | Spatial hash for AoI proximity queries |
| `systems/` | One file per System implementation |
| `handlers/` | Hit handler dispatch (health, resource node, terrain, blueprint, workstation) |
| `components/` | Component defs grouped by domain |

---

## Patterns to follow

**Component presence as flag** — No `active: boolean` fields. The component existing means the
thing is happening; absent means it isn't. The action tags (`blocking`, `iframe`,
`staggered`, `crouched`) are canonical: an action's phase installs the tag on `:enter`
and clears it on `:exit`; gameplay gates on `world.has(id, Tag)`. Safe because each flag has
**one writer** and **paired install/clear edges** (the dispatcher fires a phase's `:exit`
even on cancel/interrupt, so no tag is orphaned); a stale `true` field has no such guard.

Presence-as-flag is a **server-local** idiom: every flag is `networked: false` (the combat
tags, `CounterReady`, `Airborne`). **Networked presence-flags are abolished** (T-250) — the
wire carries *data*, the client *derives* presentation from it (stagger/counter render off
`AnimationState`, not a wire flag). A flag that needs a lifetime gets one from the Resource
primitive (`CounterReady` ← `counter_window` `cross@0` → `clear_counter_ready`), the same
mechanism buffs/projectiles use — not a hand-rolled countdown. The wire's `removals` channel
exists for genuine networked *data*-component removals (a settled item shedding `Velocity`, a
picked-up item shedding `Position`), built from the changeset op-log's `removals` — "presence
as flag" is only wire-honest because that channel exists.

**Registry-dispatch over content-defined ids** — Never `switch` on a `kind`/`type`
field in a system. Dispatch a content-defined string id to a registered handler via
`Registry<H>` from `@voxim/engine`. This is co-equal with "ContentStore is the only
data access path": it is *why* the code stays data-driven — a designer adds a new
effect / gate / BT node / hit handler / recipe step as one handler file + one
`register()` call, never an engine edit. Live instances: the action effect + gate
registries (`actions/effect.ts`, `actions/gate.ts`), BT node factories
(`ai/bt/mod.ts`), hit handlers (`handlers/`), POI activities (`poi/`), trigger
sources + the event-kind catalog (`triggers/`),
content registries. If a `switch (x.kind)` appears in a system, rewrite it as a
registry.

**No isNpc branches** — NPCs and players share all systems. Differences live in component data.

**Deferred events for cross-system reactions** — System A publishes an event; System B subscribes
via EventBus. Never call system B directly from system A.

**ContentStore is the only data access path** — Never import JSON files directly from systems.
Never hardcode numeric tuning values.

**Networked codec in @voxim/codecs** — If a component is on the wire, its codec belongs in the
codecs package so client and server share it. Inline codecs only for `networked: false` components.

**wireId lives on the def** — `NetworkedComponentDef.wireId` is the stable wire ID. Never maintain
a parallel ID mapping (no `{ typeId, def }` wrapper). `NETWORKED_DEFS` is a flat array of defs;
`DEF_BY_TYPE_ID` is derived from `def.wireId`.

**Hilt path is the single source of truth** — Tip always derived: `hilt + bladeDir × bladeLength`
via `deriveTip()`. Never store independent tip positions.

**Animation is a constraint pipeline** — Base FK → constraint producers → generic solver. No
per-weapon-style branches in the evaluator; add producers, not special cases.

**IK solver is generic** — `ik_solver.ts` solves two-bone IK for any chain. Never write
chain-specific solvers.

**One file per data item** — Content lives in `packages/content/data/{category}/{id}.json`.
Adding content is a file drop, not a code change. Run `deno task gen-content` after adding to
categories used by the browser bundle.
