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
`Status: done` and add `Commit: <short hash>`. The ticket is the audit trail.

```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done   [Commit: abc1234]

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

## Running the project

```
deno task demo          # bundle client + start tile server
deno task tile          # server only
deno task bundle        # client bundle only
deno task gen-terrain   # regenerate terrain_tile_0.bin
deno task gen-content   # regenerate static TS aggregation files after adding/renaming data files
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
export const SkillInProgress = defineComponent({
  name: "skillInProgress" as const,
  networked: false,
  codec: skillInProgressCodec,
  default: (): SkillInProgressData => ({ ... }),
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

```
NpcAiSystem → PhysicsSystem → DodgeSystem → HungerSystem → StaminaSystem
→ LifetimeSystem → EquipmentSystem → CraftingSystem → ConsumptionSystem
→ BuildingSystem → GatheringSystem → DayNightSystem → CorruptionSystem
→ EncumbranceSystem → SkillSystem → ActionSystem → BuffSystem
→ TraderSystem → DynastySystem → AnimationSystem
```

Order matters: SkillSystem runs before ActionSystem so on-hit effects compose correctly.
AnimationSystem runs last so it sees all state changes before encoding AnimationState.

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

On the first active tick of a swing, ActionSystem rewinds the target's position using
`StateHistoryBuffer.getAt(serverTick - rttTicks)`. NPCs always use the current tick.

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
  items/            {id}.json    — ItemTemplate (item categories, material slots, base stats)
  templates/        {id}.json    — EntityTemplate (prefab: which model + which components)
  npcs/             {id}.json    — NpcTemplate (archetype stats, skill loadout, behavior)
  weapon_actions/   {id}.json    — WeaponActionDef (swing timing, hitbox shape, IK targets)
  recipes/          {id}.json    — Recipe (crafting inputs/outputs, station requirement)
  lore/             {id}.json    — LoreFragment (skill concept + magnitude)
  materials/        {name}.json  — MaterialDef (numeric id in file, name is filename)

  game_config.json              — singleton: combat ratios, physics constants, AI defaults
  concept_verb_matrix.json      — skill effect table: verb × outward × inward → effect + scaling
  verbs.json                    — skill verb definitions
  terrain_config.json           — terrain generation parameters
  tile_layout.json              — optional: NPC/prop placement overrides for a specific tile
```

### Loader

The server calls `loadContentStore(dataDir?)` from `@voxim/content`. It scans each subdirectory,
sorts filenames alphabetically for deterministic registration order, and loads each file as one item.

### Client bundle

The browser client cannot use `Deno.readDir`. Two generated TypeScript files in
`packages/content/src/` aggregate per-item imports statically for bundling:
- `weapon_actions_static.ts` — all weapon actions
- `item_templates_static.ts` — all item templates

**After adding or renaming a data file in those categories, run:**
```
deno task gen-content
```
The generator lives at `scripts/gen_content.ts`. Add new categories to `TARGETS` there if the
client needs them. Always commit the regenerated `*_static.ts` files.

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
Set `weaponAction: "spear_thrust"` in the item template's `baseStats`. Run `deno task gen-content`.
No other code changes needed — the swingPath drives hit detection, arm IK, and trail rendering.

### ContentStore access

Injected into every system constructor. Never import JSON files directly. Never hardcode tuning.

```typescript
content.getWeaponAction("slash")
content.getItemTemplate("wooden_sword")
content.getEntityTemplate("wolf")
content.deriveItemStats(itemType, parts)   // combines template + material multipliers at runtime
```

---

## Combat and skills

### Two-layer architecture

```
ActionSystem (Layer 1 — physics of the swing)
  → SkillSystem.resolve() (Layer 2 — Lore effects on hit)
```

**ActionSystem** handles: windup → active → winddown timing, hitbox sweep detection, damage
calculation, knockback, parry/block/counter logic. Delegates to SkillSystem when `pendingSkillVerb`
is set and a hit connects.

**SkillSystem** handles: skill slot activation from `ACTION_SKILL_N` flags, cooldown management,
concept-verb matrix lookups, applying `ActiveEffects`.

Hit handlers in `packages/tile-server/src/handlers/` implement `HitHandler` and are dispatched
by ActionSystem based on what was hit (entity health, resource node, blueprint, terrain, workstation).

### SkillInProgress component

Present **only while a swing is in progress** (windup through winddown). Absent otherwise.
Gate on "is swinging?" with `world.get(entityId, SkillInProgress) !== null`.
Never write it at spawn.

Key fields: `weaponActionId`, `phase` ("windup"|"active"|"winddown"), `ticksInPhase`,
`hitEntities` (deduplication), `rewindTick` (lag-compensated hit tick, set once on first active
tick), `pendingSkillVerb`.

### Skill loadout

LoreLoadout: 4 skill slots, each `{ verb, outwardFragmentId, inwardFragmentId }`.
- `"strike"` — fires on melee connect via `pendingSkillVerb`
- `"invoke"`, `"ward"`, `"step"` — activate immediately in SkillSystem

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
- Server hit detection: swept capsule in ActionSystem
- Client arm animation: IK constraint targets
- Client trail ribbon: tip position each frame

`ik_solver.ts` is generic — reusable for any bone chain. `ikTargets` on `WeaponActionDef`
specifies which chains track which swingPath points.

`AnimationSystem` runs last each server tick and derives `AnimationState` from observable
entity state (velocity, SkillInProgress, health) — it never reads raw input.

---

## NPC AI

`NpcAiSystem` writes to the **same `InputState` component** as players. All downstream systems
are NPC-unaware — no `isNpc` branches anywhere in physics, combat, or skill code.

Differences between NPCs and players are expressed through component data: `NpcTag` (marker),
`NpcJobQueue` (AI job scheduler), `LoreLoadout` contents from `npc_templates.json`.

Job queue: `current` job + `scheduled` list + A\* `plan` (waypoints). Replanning is budgeted at
16 plans per tick to prevent frame spikes.

---

## Save / load

`SaveManager` (injected into TileServer, optional) persists a binary snapshot:

**What is saved:** WorldClock + TileCorruption, all terrain chunks (Heightmap + MaterialGrid),
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
thing is happening. The component being absent means it isn't. `SkillInProgress` is canonical.

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
