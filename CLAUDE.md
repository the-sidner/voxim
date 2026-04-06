# Voxim2 — Architecture Reference

Medieval post-apocalyptic multiplayer action RPG. Deno + TypeScript monorepo.
Single authoritative tile-server per 512×512 world tile, browser client over WebTransport.

## Running the project

```
deno task demo          # bundle client + start tile server
deno task tile          # server only
deno task bundle        # client bundle only
deno task gen-terrain   # regenerate terrain_tile_0.bin
deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts
```

---

## Package map

| Package | Import alias | Purpose |
|---------|-------------|---------|
| `packages/engine` | `@voxim/engine` | ECS core — World, ComponentDef, EventBus, physics math. Zero game dependencies. |
| `packages/codecs` | `@voxim/codecs` | Binary codecs for every **networked** component. Shared by server and client. |
| `packages/protocol` | `@voxim/protocol` | Wire message types, ComponentType enum, InputDatagram codec, action bitflags. |
| `packages/content` | `@voxim/content` | Data-driven game definitions. ContentStore loads from `packages/content/data/*.json`. |
| `packages/world` | `@voxim/world` | Terrain generation, heightmaps, biome zones. |
| `packages/tile-server` | `@voxim/tile-server` | Authoritative game server — systems, components, save/load, NPC AI. |
| `packages/client` | `@voxim/client` | Browser client — Three.js render, input, state interpolation, skeleton animation. |
| `packages/gateway` | — | Stub multi-tile router. Out of scope for now. |

---

## ECS overview

### Entities and components

```typescript
// Define (once, at module level in a component file):
export const Health = defineComponent({
  name: "health" as const,        // must match ComponentType enum name
  codec: buildCodec<HealthData>({ current: { type: "f32" }, max: { type: "f32" } }),
  default: (): HealthData => ({ current: 100, max: 100 }),
  // networked: false             // add this for server-only components
});
```

**Two write APIs:**

| Method | When | Effect |
|--------|------|--------|
| `world.write(id, C, v)` | Spawning / input drain | Immediate, bypasses changeset |
| `world.erase(id, C)` | Spawning cleanup | Immediate removal |
| `world.set(id, C, v)` | Inside systems | Deferred until `applyChangeset()` |
| `world.remove(id, C)` | Inside systems | Deferred removal |
| `world.destroy(id)` | Inside systems | Tombstones entity; purged on `applyChangeset()` |

**Read API:**
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
  prepare?(serverTick: number, ctx: TickContext): void;  // optional
  run(world: World, events: EventEmitter, dt: number): void;
}
```

Systems never call `applyChangeset()` themselves. They accumulate deferred writes; the tick loop commits them all at once after all systems have run. **A system cannot see another system's writes until the next tick.** This is intentional.

### Server tick sequence (20 Hz)

1. **Drain input** — latest InputDatagram per player written to InputState via `world.write()`
2. **Run systems** — in order (see below); deferred writes accumulate
3. **Apply changeset** — `world.applyChangeset()` commits all deferred writes and removals
4. **Fire events** — deferred event queue flushed; subscribers see committed state
5. **Build delta** — changed components encoded to `Uint8Array` once per component
6. **Send state** — per-session AoI filter (128-unit radius), encode StateMessage, send
7. **Advance tick** — auto-save if interval elapsed

### System execution order (`server.ts`)

```
NpcAiSystem → PhysicsSystem → DodgeSystem → HungerSystem → StaminaSystem
→ LifetimeSystem → EquipmentSystem → CraftingSystem → ConsumptionSystem
→ BuildingSystem → GatheringSystem → DayNightSystem → CorruptionSystem
→ EncumbranceSystem → SkillSystem → ActionSystem → BuffSystem
→ TraderSystem → DynastySystem → AnimationSystem
```

Order matters: SkillSystem runs before ActionSystem so on-hit effects compose correctly. AnimationSystem runs last so it sees all state changes.

---

## Adding or reworking a component

### Adding a new component

1. **Define type + codec** in the appropriate component file under `packages/tile-server/src/components/` (server-only) or `packages/codecs/src/components.ts` (if networked and used client-side too).
2. **Server-only component?** Set `networked: false` on the def. It will be excluded from wire deltas automatically. Do **not** add it to the registry.
3. **Networked component?** Do all of these:
   - Add a stable numeric ID to the `ComponentType` enum in `packages/protocol/src/component_types.ts`. Never reuse a retired ID.
   - Register in `packages/tile-server/src/component_registry.ts` as `{ typeId: ComponentType.X, def: MyComponent }`.
   - Add the codec in `packages/codecs/src/components.ts` so the client can decode it.
4. **Write the component at spawn** in `spawner.ts` if all entities need it.

### Retiring a component

- Comment out its entry in `component_registry.ts` with a note like `// 10 (attackCooldown) retired`.
- Remove from `component_types.ts` import but **leave the numeric slot** as a comment so the ID is never recycled.
- Remove from `spawner.ts` and all system reads/writes.
- Delete the `defineComponent()` call.

### Codec rules

- **All codecs belong in `@voxim/codecs`** if they are used on the wire (server ↔ client). Never define a networked codec inline in a component file.
- **Server-only components** may define their codec inline (e.g. `skillInProgressCodec` in `game.ts`) since the client never sees them.
- Use `buildCodec<T>({ field: { type: "f32" } })` for flat structs with primitives.
- Use `WireWriter` / `WireReader` for variable-length data (strings, arrays, nested objects).
- Every codec must implement `Serialiser<T>` from `@voxim/engine`.

---

## Combat and skills

### Combat architecture (two-layer)

```
ActionSystem (Layer 1 — physics of the swing)
  → SkillSystem.resolve() (Layer 2 — Lore effects on hit)
```

**ActionSystem** handles: windup → active → winddown timing (from `weapon_actions.json`), hitbox detection, damage calculation, knockback, parry/block/counter logic. When a hit connects and `pendingSkillVerb` is set it delegates to SkillSystem.

**SkillSystem** handles: skill slot activation from `INPUT_SKILL_N` flags, cooldown management, concept-verb matrix lookups, applying `ActiveEffects`.

### SkillInProgress component

Present on an entity **only while a swing is in progress** (windup through winddown). Absent otherwise — do not write it at spawn. Systems that need to gate on "is swinging?" just check `world.get(entityId, SkillInProgress) !== null`.

Fields:
```typescript
{
  weaponActionId: string;       // key into weapon_actions.json
  phase: "windup"|"active"|"winddown";
  ticksInPhase: number;
  hitEntities: string[];        // already-hit this swing (prevents multi-hit)
  inputTimestamp: number;       // client wall-clock ms for RTT rewind
  pendingSkillVerb: string;     // "strike:0" → fire skill slot 0 on connect
}
```

### Skill loadout

LoreLoadout: 4 skill slots, each with `{ verb, outwardFragmentId, inwardFragmentId }`.
- Verb `"strike"` — fires on melee connect via `pendingSkillVerb`
- Verbs `"invoke"`, `"ward"`, `"step"` — activate immediately in SkillSystem

Effect magnitude = `outwardFragment.magnitude × entry.outwardScale`.

### Adding a new weapon action

Add an entry to `packages/content/data/weapon_actions.json`:
```json
{
  "id": "spear_thrust",
  "windupTicks": 6,
  "activeTicks": 3,
  "winddownTicks": 8,
  "animationStyle": "thrust",
  "hitbox": { "range": 2.8, "arcHalf": 0.4 }
}
```
Set `weaponAction: "spear_thrust"` in the item template's `baseStats`. No code changes needed.

---

## Network protocol

### InputDatagram (client → server, unreliable, ~60 Hz)

36-byte fixed binary. Key fields: `seq` (monotonic, for ack), `timestamp` (wall-clock ms, for RTT), `facing` (f32 radians), `movementX/Y` (f32 normalised), `actions` (u32 bitfield), `interactSlot` (u32).

Action bitflags (defined in `packages/protocol/src/messages.ts`):
```
ACTION_USE_SKILL = 1 << 0
ACTION_BLOCK     = 1 << 1
ACTION_JUMP      = 1 << 2
ACTION_INTERACT  = 1 << 3
ACTION_DODGE     = 1 << 4
ACTION_SKILL_1   = 1 << 5
ACTION_SKILL_2   = 1 << 6
ACTION_SKILL_3   = 1 << 7
ACTION_SKILL_4   = 1 << 8
```

### StateMessage (server → client, reliable stream, 20 Hz)

Length-prefixed binary. Contains:
- `entityDeltas` — per-entity component changes (only changed components, only entities in AoI)
- `entityDestroys` — entities that left AoI or died
- `events` — discrete game events (damage, death, crafting complete, etc.)
- `ackInputSeq` — last input seq processed (client-side reconciliation)

### Rewind / lag compensation

When a hit enters the active phase on the first tick, ActionSystem rewinds the target's position using `StateHistoryBuffer.getAt(serverTick - rttTicks)`. NPCs always use the current tick (no client latency to compensate for).

---

## Content / data-driven design

All tuning lives in `packages/content/data/`. No hardcoded game values in systems.

| File | What it controls |
|------|-----------------|
| `game_config.json` | Combat ratios, physics constants, stamina regen, dodge windows, NPC AI defaults |
| `weapon_actions.json` | Swing timing (windup/active/winddown), hitbox shape, animation style |
| `item_templates.json` | Item categories, material slots, base stats |
| `npc_templates.json` | NPC archetype stats, skill loadouts, behavior type |
| `lore_fragments.json` | Fragment concepts and magnitude values |
| `concept_verb_matrix.json` | Skill effect table — verb × outward × inward → effectStat + scaling |

Access via `ContentStore` injected into every system constructor. Never read JSON files directly from systems.

Item stats are derived at runtime — not stored: `content.deriveItemStats(itemType, parts)` combines template base stats with per-slot material property multipliers.

---

## Client animation

`skeleton_evaluator.ts` generates bone poses procedurally each frame:

- **Lower body** always plays locomotion (idle sway / walk gait by velocity magnitude and direction).
- **Upper body** is overridden by attack animation when `AnimationState.mode === "attack"`.
- Attack pose is parameterised by `windupTicks`, `activeTicks`, `winddownTicks`, `ticksIntoAction` — all read from `AnimationState`, which AnimationSystem derives from `SkillInProgress` + `weapon_actions.json`.
- `attackStyle` (slash / overhead / thrust / unarmed) selects the pose function.
- No hardcoded timing constants in the evaluator — everything flows from content data.

`AnimationSystem` runs last every tick and derives `AnimationState` from observable entity state (health, velocity, SkillInProgress).

---

## NPC AI

NpcAiSystem writes to the **same InputState component** as players. All downstream systems (physics, action, skill) are unaware whether the entity is an NPC or player — there are no `isNpc` branches.

NPCs get `LoreLoadout` and `ActiveEffects` at spawn (same as players). Skill loadout comes from `npc_templates.json → skillLoadout`.

Job queue (`NpcJobQueue`): `current` job + `scheduled` list + A\* `plan` (waypoints). Replanning is budgeted at 16 per tick to prevent frame spikes.

---

## Patterns to follow

**Component presence as flag** — Don't add `active: boolean` fields. If a thing is happening, the component exists. If it isn't, remove the component. (`SkillInProgress` is the canonical example.)

**No isNpc branches** — NPCs and players share all combat/physics/skill systems. Differences are expressed through component data (LoreLoadout contents, NpcTag presence, etc.).

**Deferred events for game logic reactions** — If system B needs to react to something system A did, A publishes an event and B subscribes via EventBus. Don't call B from A directly.

**ContentStore is the only way to read game data** — Never import JSON files directly. Never hardcode numeric tuning values in systems.

**Codec in @voxim/codecs, not inline** — If a component is networked, its codec belongs in the codecs package so the client and server share it. Inline codecs are only acceptable for `networked: false` components.
