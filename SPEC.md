# Voxim2 — Game Specification

> Living document. Updated through design conversations. No code yet.

---

## Core Philosophy

The game is not just a game — it is an ecosystem. Simple, comprehensible systems compose into emergent complexity. This principle is mirrored at every level: physics, player behaviour, network economics, crafting, and society. The design goal is emergence from composition.

### Primary Inspirations
- **Dwarf Fortress / RimWorld** — emergent settlement management, NPC needs, colony dynamics.
- **Action RPG** (not management sim) — the game is played in real-time, **no pausing**. The player is in the world, not above it.
- The no-pause constraint is fundamental: it reduces management complexity, accelerates consequence cascades, and makes decisions feel immediate and consequential. Complexity that requires pausing to manage has no place here.

### Engineering Philosophy

**Lean and composable.** Every system should be as small as possible but open for extension. No feature is designed to its final depth on the first pass — but every feature is designed with its final depth in mind. The data model and data flow are always built for the full system. Stubs are acceptable; shortcuts that assume a simpler system are not.

**Interactions should not need to be declared.** The space of possible interactions between systems is too large to enumerate. Instead, systems are designed so that interactions emerge naturally from composition — the way the skill system produces behaviours from concepts and verbs without specifying each one. When adding a new system, the goal is: define its data and its rules, then let it interact with everything else automatically.

**No hand-authored 3D models.** All visual content — terrain, structures, items, characters, creatures — is generated procedurally from data that already exists in the engine. Material properties drive appearance. Composition drives shape. The voxel format is the universal representation: everything is built from the same atoms, by the same rules. Where seeding is needed for variety and coherence, an LLM provides it — generating structured data (material compositions, creature configurations, building layouts) that the engine then renders. The goal is to never open a 3D modelling tool.

---

## Architecture

### Stack
- **Language**: TypeScript throughout — client, gateway, and tile servers.
- **Client runtime**: browser (Three.js for rendering).
- **Server runtime**: Deno — native WebTransport support (stable), first-class TypeScript, no transpilation overhead, built-in tooling (test, fmt, lint). V8 engine, same as Chrome.
- **Why Deno over Bun**: WebTransport is required on tile servers (not just the gateway) for transparent packet routing. Bun has no native WebTransport and no committed roadmap for it. Deno has had it natively and stably for some time. The performance difference between V8 (Deno) and JavaScriptCore (Bun) is not meaningful at the scale this game will operate for the foreseeable future.
- **Shared code**: types, serialisation/deserialisation, and physics simulation are shared packages used by both client and tile servers. Schema drift between ends is a compile error, not a runtime bug. Physics sharing ensures client prediction and server authoritative simulation are identical by construction.

### Repository & Package Structure

**One monorepo** (`voxim/`) using Deno workspaces. All game packages live here and import each other by scoped name (`@voxim/engine`, `@voxim/codecs`, etc.) — no publishing, no versioning ceremony during development. If a package becomes stable and independently useful, it can be published to JSR without changing any import paths.

Truly independent services (auth, web) live in separate repos — they share no game types and deploy independently.

```
voxim/                        ← monorepo root
  deno.json                   ← workspace root, declares all members

  packages/
    engine/                   ← @voxim/engine
      ECS core: world, entity, component tokens, queries, deferred writes
      Physics simulation (shared client + server — identical by construction)
      Event bus interfaces
      Shared math types: vec2, vec3, EntityId, etc.
      ⚠ Zero dependencies on anything else in the monorepo

    codecs/                   ← @voxim/codecs
      Serialiser implementations (Protobuf today, custom binary later)
      Depends on: engine

    world/                    ← @voxim/world
      Heightmap data model and queries
      Chunk management (32×32 voxel chunks, 256 per tile)
      World generation (stub initially)
      Depends on: engine

    protocol/                 ← @voxim/protocol
      All message type definitions: input datagrams, state messages, events
      The Serialiser interface lives here
      Depends on: engine, codecs

    client/                   ← @voxim/client
      Three.js rendering pipeline
      Chunk geometry builder (vertex displacement applied here)
      Input handling (WASD + mouse → input datagrams)
      Client-side prediction loop
      Depends on: engine, codecs, world, protocol

    tile-server/              ← @voxim/tile-server
      Authoritative tick loop
      All server-side systems: physics, combat, NPC AI, crafting
      WebTransport server (receives inputs, sends state directly to clients)
      Depends on: engine, codecs, world, protocol

    gateway/                  ← @voxim/gateway
      WebTransport signaling server
      Session management, tile directory, handoff coordination
      Depends on: engine, protocol

    content/                  ← @voxim/content
      Model definition types (VoxelNode, ModelDefinition, MaterialId)
      Precomputed hitbox types — the server-side slice
      Content store interface (how definitions are fetched and cached)
      ⚠ No rendering code. No Three.js. Pure data and types.
      Depends on: engine

  services/                   ← independent, not game packages
    auth/                     ← standalone Deno HTTP service (separate repo)
    web/                      ← landing page / site (separate repo)
    debug-tools/              ← world inspector, entity viewer, network monitor
```

**Dependency directions — never import upward:**
```
engine        ← no deps
codecs        ← engine
world         ← engine
content       ← engine
protocol      ← engine, codecs
client        ← engine, codecs, world, protocol, content
tile-server   ← engine, codecs, world, protocol, content
gateway       ← engine, protocol
```

`engine` is the only universal dependency. It must remain agnostic to game content, wire formats, and rendering. `protocol` is where game-specific message structure lives, keeping that knowledge out of `engine`.

### Process Model

```
[Browser Client]
      |
      | WebTransport (QUIC)
      |
[Gateway Process]  ←——→  [Tile Server Process: tile_0042]
                   ←——→  [Tile Server Process: tile_0107]
                   ←——→  [Tile Server Process: tile_0203]
                         ...
```

Three distinct process types:

**Client** — browser, TypeScript / Three.js. Rendering and input only. Connects to the gateway for initial handshake, then opens a direct WebTransport connection to its tile server. The gateway is not on the data path after connection.

**Gateway** — single Deno process (or small cluster behind a load balancer). **Signaling and coordination only — never on the hot data path:**
- Accepts initial WebTransport connections from clients: authenticates, looks up which tile the player is on, returns the tile server address.
- Client then connects directly to the tile server. Gateway steps out.
- **Tile traversal**: when a player crosses a gate, the gateway coordinates the handoff — notifies the destination tile server to expect the player, sends the client the new tile server address, client opens a new direct connection, old connection closes.
- Maintains the world directory: which tile servers are running, which tile each player is on.
- Hosts macro simulation events, inter-tile NPC coordination (caravans etc.), world map queries.
- No game simulation. No data forwarding. Signaling only.

**Tile Server** — one Deno process per active tile. Owns the simulation for exactly one tile:
- Registers with the gateway on startup (tile ID, address).
- Accepts direct WebTransport connections from clients assigned to this tile.
- Runs the authoritative tick loop: physics, NPC AI, combat resolution, crafting.
- Sends state messages directly to connected clients — gateway not involved.
- Spun up on demand when a player first enters a tile. Persists as long as players are present. Saves state and exits when the tile goes idle.

**Why this matters:** routing all player data through the gateway would make it the bottleneck as player count grows. With direct client↔tile server connections, the gateway handles only low-frequency signaling events (connects, disconnects, tile transitions). Adding more players means adding more tile servers — the gateway load barely changes.

### Serialisation
- **Interface**: a `Serialiser` interface with `encode(msg): Uint8Array` and `decode(bytes): msg`. All network code depends on the interface, never on the implementation.
- **Implementation now**: [Protobuf](https://protobuf.dev/) via `protoc` + generated TypeScript. Schemas are the source of truth for all message types.
- **Implementation later**: custom binary codec behind the same interface, if profiling shows protobuf overhead matters. Swap is a one-line dependency change.
- Shared message schemas are a package imported by client, gateway, and tile servers. A schema change is a compile error everywhere simultaneously.

### Input Model
- **WASD** — moves the player in 8 directions relative to the camera. Movement direction is independent of facing.
- **Mouse cursor** — determines facing direction. The character always faces the cursor. You can walk backwards, sideways, or forwards depending on where you look.
- **Space** — jump.
- **Left mouse button** — attack swing.
- **Right mouse button** — block.
- Additional depth (charge attacks, parries, directional attacks, pushes) added to this foundation over time. The input datagram's `actions` bitfield has capacity for this from day one.

### Physics Model

**Shared between client and server.** The client runs the same physics loop as the server for prediction. Implemented as a shared TypeScript package imported by both.

#### Character State
Every simulated entity (player, NPC, projectile) carries:
```
position:  vec3   — x, y, z in world space
velocity:  vec3   — current velocity on all three axes
on_ground: bool   — derived each tick from terrain contact; not stored persistently
```

#### Tick Loop (fixed timestep)
Runs at a fixed step size matching the server tick rate. The client takes multiple steps per frame if needed — frame rate does not affect physics behaviour.

1. **Gravity** — apply downward acceleration to `velocity.z` if not `on_ground`.
2. **Input** — apply movement input as horizontal acceleration. Reduced magnitude when airborne (configurable, ~20–40% of ground control).
3. **Drag** — decay horizontal velocity when no input is applied.
4. **Integrate** — `position += velocity × dt`.
5. **Terrain collision** — if `position.z < heightmap(x, y)`, push z to surface, zero `velocity.z`, set `on_ground = true`.
6. **Deployable collision** — AABB against walls and structures.
7. **Auto-step** — if horizontal movement was blocked by terrain, and height difference ≤ step threshold, push character up rather than blocking. Handles ramps and small ledges without jumping.

#### Velocity Impulses — The Universal Mechanism
Jumping, knockback, and skill-based movement all use the same mechanism: **a velocity impulse** applied to the entity at a point in time. The physics loop does not distinguish between them.

| Source | Effect |
|---|---|
| Jump input | Vertical impulse, requires `on_ground` |
| Leap attack skill | Diagonal impulse in facing direction at activation |
| Knockback from hit | Horizontal impulse (± vertical for launch effects) applied at damage resolution |
| Pull/push skills | Impulse toward or away from caster applied to target |

New skills that manipulate movement are data — an impulse vector and a condition. No new physics code required.

#### Terrain Deformation
The heightmap is queried live each tick (`heightmap(x, y)`). Terrain changes take effect automatically on the next tick: terrain removed beneath an entity causes a fall; terrain raised beneath an entity pushes them up. No special handling required.

#### Float Precision & Reconciliation
Floating point arithmetic is used throughout. Minor divergence between client and server due to JS engine differences is expected and acceptable — reconciliation corrects it each tick. Divergence from simple arithmetic is sub-pixel and not visible to the player.

---

### Entity Component System (ECS)

The entity model is ECS-inspired. Entities are IDs. Components are plain typed data. Systems are functions that query entities by component composition and operate on the results. No inheritance. Fully composable. Open for extension without modifying existing code.

#### Entity IDs
- **UUID v7** — 128-bit, time-ordered, globally unique across all tile servers.
- Always encoded as **16 raw bytes** on the wire and in save files. Never as a string in the protocol. String form is for logging and debugging only.
- Time-ordering gives natural sortability and better storage locality. Global uniqueness means entities moving between tile servers keep their ID permanently.

#### Component Tokens — Open Registry
Components are defined using a typed token factory. The engine has no hardcoded list of component types:

```typescript
// anywhere in the codebase — no central registry
const Position = defineComponent<{ x: number; y: number; z: number }>({
  codec: positionCodec,  // implements Serialiser<T>
  default: () => ({ x: 0, y: 0, z: 0 })
})

const Health = defineComponent<{ current: number; max: number }>({
  codec: healthCodec,
  default: () => ({ current: 100, max: 100 })
})
```

Adding a new component is a new file. No existing files change. The engine is open for extension by construction.

The `codec` field decouples the engine from any specific serialisation library. The engine calls `codec.encode(data)` and `codec.decode(bytes)` — it never imports protobuf or any other format directly. Protobuf implementations live in a separate `@voxim/codecs` package. Swapping serialisation is a one-line change in that package.

#### Entity Storage — Sparse
Entities are stored as `Map<EntityId, Map<ComponentToken, StoredComponent>>`. Only components an entity actually has are allocated. A terrain chunk entity has `Position` and `Material`; a projectile has `Position`, `Velocity`, `Lifetime`, `Damage`. No fixed struct, no wasted allocation.

#### Queries
Systems query the world for entities matching a component signature:

```typescript
const movers = world.query(Position, Velocity)
// TypeScript infers: Array<{ position: PositionData, velocity: VelocityData }>
```

The query API is generic — the engine knows nothing about specific component types. TypeScript's type inference gives full type safety on query results. The internals are hidden; the surface is typed.

#### Component Versioning — Hidden
Each stored component is internally wrapped with a version counter:

```typescript
// internal to the world — never visible to systems
type StoredComponent<T> = { version: number; data: T }
```

Systems always receive `T` — the version is invisible to game code. The network layer has a separate world interface that exposes versions alongside data, used only for delta encoding. The file serialisation layer uses the same interface for save snapshots.

#### Entity Lifecycle
- **Creation**: `world.create(id?)` — ID auto-generated if not provided.
- **Destruction**: entities are not removed immediately. On `world.destroy(entityId)`, the entity is **tombstoned** for one tick — marked as dead, still queryable, systems can react. Removed from the store at the end of that tick.
- **Dangling IDs**: references to destroyed entity IDs (in NPC job queues, network messages, etc.) must be handled gracefully. The world returns `null` for tombstoned or missing IDs. How each system handles nulls is determined during implementation — the engine flags dangling references, systems decide what to do.

#### Tile Handoff — Entities Crossing Gates
When a player (or any entity) crosses a gate between tiles:
1. The source tile server serialises the full entity — all components — using registered codecs.
2. The serialised entity is sent to the gateway.
3. The gateway forwards it to the destination tile server.
4. The destination tile server deserialises and inserts the entity into its world store.
5. The source tile server tombstones and removes the entity.

This uses the same encode/decode path as file save/load. The entity arrives on the new tile intact, same ID, same component state. Gate crossings are the only time entities move between tile servers — NPC behaviour is bounded to its tile.

#### Tile Isolation
Each tile server's world store is independent. Systems on a tile cannot query entities on another tile. This is intentional — tiles are closed maps. An NPC will starve if its tile has no food, even if the adjacent tile has plenty. The only mechanism for cross-tile awareness is the macro simulation layer, which operates at city/world level, not entity level.

#### Event Buses
Two event buses operate alongside the ECS:

**Tile event bus** — scoped to a single tile server. Systems publish events (`EntityDied`, `CraftingCompleted`, `GateApproached`, `DamageDealt`, etc.) after component changes are applied. Other systems and subsystems (NPC sensory input, UI state, sound triggers) subscribe to relevant event types. This is the primary mechanism for system-to-system communication without direct coupling.

**World event bus** — scoped to the gateway / macro layer. Carries cross-tile events: `CaravanDeparted`, `CityRaided`, `PlayerCrossedGate`, `TileServerStarted`. Tile servers publish to this bus; the macro simulation and gateway subscribe. This is how the living world layer receives signals from ground-level activity.

The tile event bus also feeds the NPC sensory system — NPCs subscribe to nearby events as their primary awareness mechanism. Full design of the sensory system is separate, but it is grounded in this event bus from day one.

#### System Ordering
Systems run in a declared order each tick. Order matters — physics must resolve before combat, combat before health updates, health before death checks. The engine maintains an ordered system registry. Systems declare their position explicitly; no implicit ordering. Full system order to be defined during implementation as systems are added.

#### Component Mutability — Deferred Writes
Systems do not mutate components directly. Instead, they submit a **changeset** — a list of `(entityId, componentToken, newData)` tuples — which the world applies atomically at the end of the tick.

This gives three things for the price of one:

1. **Consistent world state** — all systems see the same snapshot for the entire tick. No system observes another system's mid-tick changes. Physics and combat resolve against a stable world, which is more predictable and easier to reason about.
2. **Event bus integration** — events fire after the changeset is applied. Subscribers always see the already-committed new state, never a transitional one.
3. **Delta snapshots for free** — the changeset *is* the network delta. No diffing required. At end-of-tick, iterating the changeset directly produces the `(entityId, component, newData, version)` tuples the network layer needs. The state history ring buffer stores changesets, not full world copies — lag compensation reconstructs historical state by replaying them.

The one constraint: systems cannot react to another system's changes within the same tick. They always operate on last tick's committed state. For this game this is correct behaviour — it is not a limitation.

### Transport — WebTransport
- **Protocol: WebTransport** (QUIC / HTTP/3 underneath).
- Two channels, used for different concerns:
  - **Unreliable datagrams** — player input: facing direction, movement, button states. Sent at render rate (~60Hz). Packet loss is acceptable — latest value wins. No waiting for a tick.
  - **Reliable streams** — authoritative game state: damage events, position corrections, NPC actions, crafting results, entity spawns/despawns. Sent at server tick rate. Must arrive, must be ordered.
- This separation means facing direction (the central combat mechanic) is always fresh on the server without being coupled to the tick rate.

### Tick Rate
- The server tick rate is a **configurable variable** — not hardcoded.
- Start with a conservative value (e.g. 20 ticks/second) and tune from there.
- Different tile processes may eventually run at different tick rates depending on activity level — an empty wilderness tile does not need the same rate as a city under siege.

### Tile Server Tick Loop

#### Input Collection — Separated from Tick Execution
Input collection runs **concurrently with the tick loop**, never blocked by it. As datagrams arrive from WebTransport connections, they are immediately placed into a per-player **input ring buffer**. This is always live — a slow tick never delays input arrival.

```
[WebTransport datagram arrives]
        ↓
[Input receiver — concurrent async loop]
        ↓
[Per-player input ring buffer]
        ↓  (drained at start of each tick)
[Tick loop]
```

In Deno, the input receiver is a concurrent async iterator over the WebTransport datagram stream. It runs alongside the tick loop without blocking it:

```typescript
// always running — never blocked by tick execution
async function receiveInputs(connection: WebTransportConnection) {
  for await (const datagram of connection.datagrams.readable) {
    const input = decode(datagram)
    inputBuffers.get(input.playerId)?.push(input)
  }
}

// tick loop drains buffers at start of each tick
function tick() {
  for (const [playerId, buffer] of inputBuffers) {
    const inputs = buffer.drain()   // all inputs since last drain
    applyInputs(playerId, inputs)
  }
  // ... rest of tick sequence
}
```

#### Tick Overrun Resilience
If a tick takes longer than its budget, inputs continue accumulating in the ring buffers during the overrun. The next tick drains a larger buffer and processes more inputs at once. The game catches up naturally without dropping inputs. The client reconciles from the last acknowledged `seq` — a brief overrun produces a visible but recoverable hiccup, not broken state.

Consistent overruns are a performance problem to be solved by profiling, not by the architecture. The buffer pattern provides resilience against occasional spikes only.

#### Full Tick Sequence
```
1. DRAIN INPUT BUFFERS
   For each connected player, drain their input ring buffer.
   Apply latest facing, movement, and action state to their InputState component.
   (InputState is the one component written immediately, not deferred — 
    it is the stimulus for this tick, not an output of it.)

2. RUN SYSTEMS (declared order)
   a. NPC AI          — evaluate job boards, emit movement/action intents
   b. Input           — translate InputState into physics intents
   c. Physics         — gravity, velocity integration, terrain collision,
                        deployable collision, auto-step
   d. Combat          — resolve attack arcs (with lag compensation rewind),
                        emit damage and knockback changesets
   e. Crafting        — advance time-based steps, emit output changesets
   f. Hunger/Thirst   — accumulate values, emit debuff changesets at thresholds
   g. Lifetime        — decrement projectile/effect lifetimes, emit destroy commands
   h. NPC Needs       — check emergency thresholds, trigger state overrides

3. APPLY CHANGESET
   World applies all (entityId, component, newData) tuples atomically.
   Version counters increment on changed components.
   Tombstoned entities are removed from the store.

4. FIRE EVENTS
   World iterates the changeset, publishes events to the tile event bus:
   EntityDied, DamageDealt, CraftingCompleted, HungerCritical, GateApproached, etc.
   Subscribers react: NPC AI state updates, world event bus notifications,
   sensory input delivery to nearby NPCs.

5. BUILD DELTA
   Network layer iterates the changeset.
   Produces: changed components + version numbers + events this tick.

6. SEND STATE
   Delta sent to each connected client via reliable stream.
   ack_input_seq included — last processed input sequence per player.

7. ADVANCE TICK COUNTER
   Append changeset to state history ring buffer (lag compensation).
```

### Build Order Philosophy
The full system is always the target. Features are built in order of foundational dependency, not in order of complexity. A feature that is not yet implemented exists as a **stub**: a real interface with defined inputs, outputs, and data structures, backed by a minimal or no-op implementation. The stub is replaced in place when the feature is built — no architectural changes needed.

This matters because the hardest problems to fix later are not missing features but wrong shapes. A multi-tile world added to a codebase that assumed single-tile requires rewriting everything that touched tile state. A macro simulation bolted onto a system with no event bus requires inserting one. Building the shape of the full system first — even with empty implementations — means each new feature is an upgrade, not a rewrite.

Concretely: the tile-as-process architecture exists from day one even when there is only one process. The LLM city AI interface is defined before the LLM is connected — the fallback utility AI runs behind it. The macro simulation emits events to the tile layer from the start, even if the logic producing those events is trivial. The Lore system ships with ten fragments, not hardcoded abilities marked "replace later."

### Network Protocol — Prediction & Reconciliation

The client uses **client-side prediction with server reconciliation**. This requires specific data structures in the protocol from day one — retrofitting them later means rewriting both ends of the network layer.

#### The Four-Part Model

- **Client-side prediction** — the client applies its own inputs immediately without waiting for the server. Movement and actions are instant locally. Latency is hidden.
- **Server reconciliation** — the server sends authoritative state tagged with the last input it processed. The client replays all unacknowledged inputs on top of the server correction. Small divergences are smoothed; large ones snap to server state.
- **Entity interpolation** — remote entities (other players, NPCs) are rendered at a fixed delay behind the latest received state (~100ms), interpolating between the last two snapshots. Not predicted — smoothed.
- **Lag compensation** — when the server resolves a combat outcome, it rewinds world state to the tick the client *sent* the input (using client timestamp + RTT). This ensures "I hit them" feels fair even under latency.

#### Input Datagram (unreliable, ~60Hz)

Sent by the client on every frame. Loss-tolerant — latest value wins.

```
seq:       u32    — monotonically increasing per client; never resets
tick:      u32    — client tick at time of input
timestamp: f64    — client wall clock at send (used for lag compensation RTT estimate)
facing:    f32    — character facing angle, radians
movement:  vec2   — normalised movement direction (0,0 = stationary)
actions:   u32    — bitfield: attack, dodge, interact, crouch, jump, etc.
```

`seq` is load-bearing. The server echoes the last `seq` it processed in every state update. The client uses this to know which inputs to replay during reconciliation.

#### State Message (reliable stream, per tick)

Sent by the server at the end of each tick to each connected client.

```
server_tick:   u32     — which server tick produced this state
ack_input_seq: u32     — last client input sequence the server has processed
entity_deltas: [...]   — state changes this tick; delta-encoded against last sent state
events:        [...]   — authoritative outcomes: damage dealt, entity died, item crafted, etc.
```

`ack_input_seq` is what makes reconciliation work. The client discards all buffered inputs with `seq <= ack_input_seq`, then replays the remainder on top of the received state.

Events are separate from entity deltas. Deltas update the world model; events drive UI, sound, effects, and game logic on the client. An entity dying is both a delta (entity removed) and an event (death animation, loot drop notification).

#### Entity Identity

Every entity — player, NPC, item, deployable, projectile — has a **stable globally unique ID** assigned at creation and never reused. All deltas and events reference entities by ID. The client maintains an entity map keyed by ID.

IDs must be globally unique across all tile processes, not just within a tile. A player moving between tiles carries the same ID.

#### Tick Numbering

Client and server maintain independent tick counters. The client estimates the server's current tick from the `server_tick` field in received state messages plus elapsed time. All inputs are tagged with client ticks; all state is tagged with server ticks. The mapping between them is maintained locally on the client for reconciliation bookkeeping.

#### Server State History — Lag Compensation

The server maintains a **ring buffer of world snapshots**, one per tick, covering a rolling window of ~1 second (tunable). Each snapshot stores, for every entity: position, facing angle, velocity, and action state.

When resolving a combat outcome (did this attack arc hit that entity?), the server rewinds to the snapshot corresponding to when the client sent the input, and evaluates the hit against that historical state. This means the attacker sees a fair outcome even if the target moved during transit.

**For this game specifically:** blocking is directional — the defender's facing angle at the time of the attack determines whether the block lands. The state history must therefore include facing angles for all entities, not just positions.

#### Open Questions
- [x] **Prediction scope: movement and actions predicted client-side. Combat outcomes (damage, death, knockback) server-authoritative.**
- [ ] Reconciliation smoothing: hard snap vs. interpolated correction for large divergences?
- [ ] How is RTT estimated per client — rolling average of timestamp delta?

---

## World

### Coordinate System & Units
- **1 world unit = 1 voxel face width** in x and y.
- A character is approximately 2 units tall. A house is 4–5 units wide. A city block is 30–40 units wide.
- **Height precision: 0.25 units** — terrain z values are multiples of 0.25. A height of 4.5 renders as 4 full voxels and one half-height voxel on top.
- **Maximum terrain height: TBD** — provisional ceiling of 64 units. Tunable.
- Positions in physics and entity state are full floats — the 0.25 grid is a terrain constraint, not a movement constraint.

### Tile & Chunk Structure
- A **tile** is **512 × 512 voxels** — large enough to contain a full city, a player settlement, or a substantial wilderness area. A base always fits within a single tile; no cross-tile NPC coordination is needed for normal operations.
- Each tile is subdivided into **chunks of 32 × 32 voxels** — 256 chunks per tile.
- The server simulates only chunks with active entities. Inactive chunks are loaded from disk on demand when an entity enters.
- The client renders only chunks within view distance. Chunks outside view are culled.

### Terrain Data Model

#### Terrain as ECS Entities
Each chunk is an entity in the ECS world. The terrain is not a separate parallel system — it is part of the same entity store as players, NPCs, and items. This means terrain modifications go through the same deferred write and delta path as everything else.

A terrain chunk entity carries two components:

```typescript
// flat typed arrays — fast to query, fast to serialise
Heightmap: {
  data:    Float32Array   // 1024 floats, row-major: index = x + y*32
  chunkX:  number
  chunkY:  number
}

MaterialGrid: {
  data:    Uint16Array    // 1024 material IDs, same layout
}
```

4KB of height data + 2KB of material IDs per chunk. Compact, cache-friendly, directly serialisable to disk and wire.

#### Physics Queries
The physics system looks up terrain height with a single array access:

```typescript
function getHeight(heightmap: Heightmap, localX: number, localY: number): number {
  return heightmap.data[localX + localY * 32]
}
```

Finding which chunk an entity occupies:
```typescript
chunkX = Math.floor(position.x / 32)
chunkY = Math.floor(position.y / 32)
localX = Math.floor(position.x) % 32
localY = Math.floor(position.y) % 32
```

No traversal, no search — O(1) terrain lookup per physics step.

#### Terrain Modification
Digging, building, and terrain deformation submit changesets to the `Heightmap` and/or `MaterialGrid` components of the affected chunk entity. These go through the standard deferred write path — applied at end of tick, versioned, included in the delta, sent to clients. Clients rebuild chunk geometry on receipt.

#### Chunk Lifecycle on the Tile Server
- **Load**: when a player or active NPC approaches a chunk, it is loaded from the tile's save file into the ECS world as a chunk entity.
- **Active**: the chunk entity exists in the world store. Physics and other systems can query it.
- **Unload**: when no active entities occupy or are adjacent to a chunk, it is serialised back to disk and removed from the world store. Saves memory on large, sparsely populated tiles.
- **Save on shutdown**: when the tile server shuts down (tile goes idle), all chunk entities are serialised to disk. Same codec path as network deltas — `Heightmap` and `MaterialGrid` components encoded via their registered codecs.

#### Chunk Save Format
The tile save file is a stream of serialised entities — chunk entities, NPC entities, item entities, deployable entities. All encoded via the same component codec path. Loading the tile is deserialising this stream back into the ECS world store. No special terrain serialisation format — it uses the same system as everything else.

### Voxel Model
- Space is a fixed **x, y integer grid** at the voxel level.
- Each x, y cell stores a **height float** (multiples of 0.25) — the terrain is a heightmap, rendered as stacked voxels.
- This is **not** a true 3D voxel array. The world is strictly:
  1. Ground tiles (heightmap terrain)
  2. Deployables (walls, objects, structures) placed on top of terrain
  3. Nothing above that — **no roofs, no overhangs, no floating geometry exist in game data**
- **No caves in the physical world.** Overhangs are not representable. What looks like a cave is a gate-accessed instance.
- **Jumping exists** — used to traverse height differences in terrain — but does not enable reaching geometry above the player.
- Voxels are uniform in x and y dimensions.

### Vertex Displacement — Organic Geometry

Every piece of geometry in the game — terrain, deployables, items, characters — is rendered through the same voxel pipeline, and all geometry uses **vertex displacement** to break the rigid grid.

#### The Rule
Each vertex has a small fixed random offset applied in all three directions (x, y, z). The offset is **deterministic**: computed from the vertex's **world-space position** as a seed, using a noise function. The same world position always produces the same offset. It never changes.

#### No Gaps — Shared Vertices
Neighbouring voxels, chunks, and tiles share vertices at their boundaries. A vertex at world position `(32, 16, 4.0)` has exactly one displacement value, derived from those coordinates. It does not matter which voxel, chunk, or tile queries it — the result is identical. Adjacent geometry always agrees on shared vertex positions. No cracks, no gaps, no seams at any boundary, including tile-to-tile boundaries.

This is the same principle as gate pre-computation in world generation — boundaries are resolved before interiors, so everything fits.

#### Unified Visual Language
The vertex displacement pipeline is the same for all content at all scales:
- Terrain voxels (large) — larger absolute displacement, same relative proportion
- Structure voxels (medium) — same formula, smaller scale
- Item and character voxels (small) — same formula, smaller scale still

A sword lying on the ground and the ground beneath it are made of the same stuff, displaced by the same rules. There is no visual discontinuity between world geometry and game objects.

#### Simulation vs. Rendering
Displacement is **render-only**. The server operates on the clean grid for physics, collision, and all simulation. The client applies displacement at geometry-build time before drawing. The two layers never interfere.

### Open Questions
- [ ] Displacement magnitude — needs visual tuning. Probably expressed as a fraction of voxel size (e.g. ±10% per axis).
- [ ] Maximum terrain height — provisional 64 units, confirm during world generation design.

---

## World Generation

### Biomes
The world map distributes biomes that determine what each tile looks like and what it produces:

| Biome | Terrain | Resources | Threats | Notes |
|---|---|---|---|---|
| Dense Forest | Varied, heavy canopy | Hardwood, softwood, game animals, herbs | Wolves, bandits | Best bow wood |
| Plains | Flat, open | Farmland, soft stone, clay | Raiders | Best farming, exposed |
| Mountains | High, rocky | Iron, coal, granite, rare ore | Hostile wildlife, cold | Cave gates common |
| Swamp | Low, waterlogged | Rare herbs, reeds, soft wood | Disease, hostile creatures | Best alchemy ingredients |
| Badlands | Dry, cracked | Scarce resources | High corruption | Near catastrophe zones |
| Corrupted Zone | Warped, unstable | Pre-catastrophe Lore, horror drops | Horrors, corrupted creatures | Corruption accumulates here |
| Ruins | Flattened former cities | Pre-catastrophe Lore, salvage | Undead, scavengers | High-value, high-risk |
| Coastal/River | Flat, fertile near water | Fish, clay, river trade access | Pirates, flooding | Trade hub locations |

### Two-Layer Generation

#### Layer 1 — World Map
A 2D macro map generated once at world creation. Each cell = one tile. Generation steps:

1. **Elevation noise** — Perlin/Simplex noise produces a base heightmap at world scale.
2. **Temperature + moisture gradients** — combined with elevation to determine biome per cell.
3. **River tracing** — water flows downhill from high elevation, collecting into rivers and coastal outlets. Rivers follow terrain, not grids.
4. **NPC city seeding** — viable city locations selected (flat terrain, near water, resource diversity). Cities seeded with a founding NPC and a starting workbench.
5. **Road network** — roads generated connecting city seeds, following terrain of least resistance (low elevation, avoiding water).
6. **Corruption distribution** — one or more catastrophe ground-zero points placed. Corruption radiates outward with falloff. Corrupted and Badlands biomes cluster here.
7. **Ruins placement** — former civilisation sites scattered across the map, denser near old road networks.
8. **Gate pre-computation** — gate positions on all tile edges determined before tile interiors are generated. Gates must align between neighbouring tiles. Road gates align with road paths; standard gates at fixed positions per edge.

#### Layer 2 — Tile Generation
Generated on demand when a tile is first loaded. Inputs: biome, elevation, river flag, road flag, corruption level, proximity to cities, gate positions.

1. **Heightmap** — noise generation scaled to biome parameters (mountains: high variance; plains: low variance).
2. **Road cuts** — if road present, flatten a path through the tile matching gate entry/exit positions.
3. **River channel** — if river present, cut a lower-elevation channel through the tile.
4. **Resource node placement** — distributed by biome type and density parameters. Biome determines node types and their material properties.
5. **Corruption overlay** — if corruption level > 0, warp terrain and replace normal spawns with corrupted variants. Higher corruption = more severe warping.
6. **Gate placement** — gates placed at pre-computed positions. Surface gates are terrain features; cave gates are openings in rock faces (mountain tiles).
7. **NPC spawn seeding** — hostile creatures, ambient animals, and wandering NPCs seeded by biome and corruption.

#### Gate Alignment — Key Technical Constraint
- Gate positions are determined at world map generation, before any tile is generated.
- Neighbouring tiles share gate coordinates — tile A's north gate at x=32 matches tile B's south gate at x=32.
- All tile generators receive gate positions as fixed inputs and generate terrain around them.
- This ensures seamless traversal without requiring tile generation to be coordinated at runtime.

### Tile Boundaries & Gates
- Adjacent tiles connect via **fixed gates** — explicit crossing points.
- The gate system is **universal**: it handles spatial transitions between distinct map instances:
  - Surface tile → neighbouring surface tile
  - Surface tile → cave/dungeon instance
  - Cave → deeper cave level
  - Floor transitions within a building (stairs up/down)
- Future goal: surface gates are invisible — terrain and structures blend naturally across boundaries via transition generation.
- Each tile is a **fixed size** — large enough to encompass a full city or player settlement. A base always fits within a single tile; cross-tile NPC coordination is not required for normal operations.

### Buildings, Rooms & Roofs
- Building interiors are **part of the tile map** — not separate instances (except stairs → floor transitions via gates).
- **Roofs do not exist in game data.** They are a **visual effect only**, generated at render time.
- Room detection: the **server** identifies enclosed areas by detecting walls that form a closed boundary and sends enclosure flags to the client. This is server-side to prevent client-side exploit vectors (e.g. a modified client falsely reading "indoors" to gain lighting or other benefits).
- When an enclosure is detected, the client renders a roof over it.
- When the player is inside an enclosure, the roof is hidden — the player sees the interior.
- When outside, the roof is visible and occludes the interior (standard isometric building behaviour).
- This is purely a rendering concern — the simulation has no concept of "indoors."

### Caves & Underground Instances
- Caves are **gate-accessed tile instances**, not carved into the surface heightmap.
- A cave instance is its own tile map — it looks like a cave because its walls and floor are generated as rock, and the client renders a "ceiling" over enclosed rock walls the same way it renders building roofs.
- No chunk-based subterrain. The client renders only the current tile at all times.
- Cave instances are a major gameplay area.

### Rendering Perspective
- The game renders in **3D with a perspective camera** — not isometric.
- The camera is overhead/angled (think Diablo / action-RPG style) with **horizontal rotation only** — vertical tilt is fixed.
- Everything is real 3D geometry; perspective projection gives natural depth and parallax on terrain height.
- The "2.5D feel" comes from the overhead angle and the heightmap world structure, not from a technical projection constraint.

### Cave Visual Treatment
- Cave instances are structurally identical to surface tiles — same map format, same rules.
- The client may apply **visual atmosphere** to imply underground: darkness, fog, ambient lighting changes, particle effects.
- No special data or engine support required for "cave-ness" — it is a client rendering decision.

### Caves & Underground
- Caves, mines, dungeons are **instances** — separate tile-scale maps, not subterranean data embedded in the surface tile.
- No chunk-based subterrain rendering (unlike Minecraft). The client only ever renders one tile's worth of geometry at a time.
- Cave instances are a major gameplay area — not an edge case.
- Cave generation takes world map data as input (geology, biome) just like surface tiles do.

### Open Questions
- [x] **Tile size: 512×512 voxels**, subdivided into 32×32 chunks (256 chunks per tile). See Architecture → Tile & Chunk Structure.
- [ ] Are tiles generated on demand (streaming) or pre-generated?
- [ ] How many gates per tile edge? Fixed positions or generated?
- [ ] How does road/river continuity get enforced across tile boundaries?
- [ ] Can caves connect to multiple surface tiles, or is each cave instance entered from exactly one gate?

---

## Object & Asset System

### Unified Voxel Representation
- **All objects** — items, deployables, characters, machines — are built from the same voxel engine.
- Objects are composed of:
  - **Primitive voxels** (leaf nodes)
  - **Imported sub-objects** (themselves voxel compositions — recursive/hierarchical)
- Sub-objects can be **freely rotated and scaled** within a parent — enabling mechanical assemblies (e.g. gears arranged in a circle, imported into a machine, animated).

### Implications
- Consistent visual language across all content.
- Procedural asset generation is natural — algorithms produce the same format as hand-built content.
- Assets can be built incrementally: low-fidelity early, higher fidelity as development matures.
- Gears, pistons, levers — mechanical systems are first-class visual objects.

### Character Models & Skeletons
- Characters are voxel assemblies like everything else.
- **Animations are skeleton-based with rigid segmentation** — no mesh deformation:
  - Body parts are **separate voxel objects** rigidly attached ("glued") to skeleton bones.
  - Bones transform (rotate/translate); parts move with them as rigid bodies.
  - Mesh overlap between parts is acceptable and part of the aesthetic — puppet/paper doll look.
  - Height and width variation comes from scaling part objects, not creating new animations.
- **Fixed set of skeleton archetypes** — not procedural creature generation (not Spore):
  - Archetypes are designed up front: human, dwarf, spider, zombie, and others as needed.
  - Each archetype has its own skeleton definition and its own animation set.
  - Visual variants within an archetype are created by swapping or restyling voxel part assemblies — different proportions, colours, equipment — without touching the animations.
  - Goal: never need to open a 3D modelling tool (Blender etc.) — all character art is built within the game's own voxel system.

### Rendering vs. Simulation: Material-Driven Appearance
- Item appearance is driven by **material composition** — each material type has a visual definition (colour, surface properties, texture style).
- Material → appearance is a **map**: `material_type → render properties`. This map is the art layer.
- Items with different stats look visibly different as a natural consequence of being made from different materials — no manual art work needed per variant.
- The simulation layer holds material type per part. The render layer reads material type and looks up appearance. They don't need to know more about each other.

### Quality: Two Separate Systems
1. **Material quality** — determined by what materials were used in crafting. A steel blade is inherently better than a stone blade. This is emergent from the crafting chain and naturally represented in the material map (steel and stone are different materials with different render properties and different stats). No special handling needed.
2. **Durability / condition** — tracks wear and damage over time from use. This is a **separate system**, independent of the material map. It does not feed back into per-voxel rendering — that would explode complexity. Handled as its own state on the item (e.g. a scalar from 0–100), surfaced to the player via UI rather than visual model changes.

### Content Layer — Model Definitions

#### Model Definition Structure
Model definitions are data files — generated at world creation time (LLM-seeded for base primitives, composed upward from there), stored server-side, served to clients on demand.

```
ModelDefinition {
  id:         string            — stable globally unique ID
  version:    u32               — incremented when definition changes
  hitbox:     AABB              — precomputed at generation time; server uses only this
  voxels:     VoxelNode[]       — recursive voxel tree; client uses this for rendering
  subObjects: [{
    modelId:    string          — reference by ID, not embedded
    transform:  { position, rotation, scale }
  }]
  materials:  MaterialId[]      — material IDs used in this model
}
```

Sub-objects are **references by ID, not embedded data**. The client resolves them lazily — fetch root model, fetch sub-models as needed. Each sub-model is independently cacheable and reusable across many parent models. A sword references a blade model and a grip model; the blade model is shared with every other sword variant that uses it.

#### The Emergent Model Hierarchy
Models compose upward from base primitives. A change to a base primitive bubbles up automatically through everything that references it:

```
base primitives     ← LLM-seeded at world generation
  (rock, plank, iron voxel, leather strip, etc.)
        ↓
components          ← composed from primitives
  (blade, grip, pommel, axe head, shield face)
        ↓
assemblies          ← composed from components
  (sword, shield, helm, chestplate)
        ↓
equipped entities   ← skeleton archetype + equipment references
  (armoured human, dwarf warrior, undead archer)
```

The LLM seeds the base primitives — "generate a voxel definition for rough-hewn granite, 1 unit cube, slightly irregular." Everything above that is composition. No Blender. No manual authoring above the primitive level.

#### Server vs. Client Slices
The content layer serves two different audiences from the same definition:

- **Server** loads only `hitbox` — a precomputed AABB per model. Small, fast. All physics and combat resolution uses this. Hitboxes are tied to the **skeleton archetype**, not equipped items — a heavily armoured human and a lightly armoured human share the same hitbox. Visual bulk is a rendering concern, not a physics concern.
- **Client** loads the full definition — `voxels`, `subObjects`, `materials`. Assembles and bakes geometry locally.

#### Entity Model Reference
Entities do not carry their model definition — they carry a `ModelRef` component:

```
ModelRef: { modelId: string, scale: vec3 }
```

The server attaches this component at entity creation. The client resolves it against the content store. The entity state stays lean on the wire — just an ID and a scale, not a voxel tree.

#### Client Loading & Baking Pipeline
When the client encounters an entity with an unknown `modelId`:

1. **Render placeholder** immediately — bounding box or low-fidelity stand-in. Never block the game loop.
2. **Request model definition** via the reliable WebTransport stream — same connection as game state, no separate HTTP request.
3. **Resolve sub-objects recursively** — fetch any uncached sub-models. Each is a separate request, each cached independently.
4. **Bake geometry in a Web Worker** — off the main thread. Build Three.js `BufferGeometry`, apply vertex displacement, compute normals. Game loop never stalls.
5. **Swap placeholder** for real geometry when baking completes.

#### Client Caching — Three Levels
- **Memory cache** — baked geometry currently in use, ready to render immediately.
- **Disk cache** (IndexedDB) — raw model definitions received from server. Survives page reload. Keyed by `(modelId, version)` — stale definitions are replaced when the server sends a higher version.
- **Server content store** — source of truth. Generated at world creation, stored as files, served on request.

#### Material Map — The Art Layer
The client holds a **material map**: `MaterialId → render properties` (colour, roughness, surface style, etc.). This is the only place visual style is defined. The same model definition can render:
- Dark and gritty with one material map
- Cartoonish and bright with another
- High contrast / stylised with a third

The server knows nothing about render properties. The content layer holds `MaterialId` references only. Visual style is a pure client decision.

### Open Questions
- [x] **Scene graph / hierarchy**: recursive `subObjects` by reference, resolved lazily by client.
- [x] **Collision for composed objects**: hitbox is precomputed AABB tied to skeleton archetype, not derived from voxel tree at runtime.
- [ ] Nesting depth limits — needs practical testing during content generation.
- [ ] Scaling effect on hitbox — does scale on `ModelRef` affect the hitbox, or is hitbox always the archetype default?
- [ ] What skeleton archetypes are in scope for launch?

---

## Core Game Loop

**Survive → Craft → Fight → Build**

These four pillars reinforce each other in a cycle. Players gather to survive, craft to improve capability, fight to defend or expand, and build to establish presence and infrastructure.

### Design Principle: Emergence Over Prescription
Higher-order behaviours — combat tactics, political structures, economies, social groups — are not designed directly. They emerge from the interaction of a small number of well-designed systems. The systems create pressure; players and NPCs respond to that pressure; interesting things follow. The goal is to design the pressure, not the outcome.

---

## Major Systems

### 1. Survival

#### Hunger & Thirst
- Both are **accumulating meters** — they grow over time continuously (hunger builds; thirst builds faster).
- When either reaches maximum: a **life drain debuff** applies — health slowly ticks down.
- When both are at maximum simultaneously: **2 stacks** of the debuff. Death accelerates.
- Resolution: eat food (reduces hunger), drink water (reduces thirst). Standard, understood, requires no explanation.
- This is intentionally minimal — familiar pressure that drives players into food production and base infrastructure without becoming a complex sim.

#### External Survival Pressure
The rest of survival comes from the world, not from internal meters:
- **Hostile NPCs, animals, and undead** — constant ambient threat. The world is not safe.
- **Day/night cycle** — night lowers the player's view range and perception. The information overlay system is degraded: attack telegraphs are harder to read, detection range shrinks. Stealth becomes more powerful in both directions — you are harder to detect, but so are threats.
  - Creates demand for **light sources** (torches, lanterns — crafted items) to restore perception at night.
  - Undead and hostile creatures may be more active at night (setting-appropriate).

#### Encumbrance
- Items have weight. Characters have a carry limit.
- **Inventory encumbrance**: exceeding the limit slows movement; a hard cap prevents picking up more.
- **Equipment encumbrance**: armour weight directly affects **dodge speed and distance**. Heavy armour = slower, shorter dodge roll. Light armour = fast, full dodge with i-frames.
- This creates a real and permanent equipment trade-off: protection vs. mobility. No "best" choice — depends on playstyle and situation.
- Also makes base infrastructure and NPC porters valuable: a porter NPC ferrying materials means the player can keep working without returning to base.

#### Corruption
- A persistent accumulation value on the character, separate from health.
- **Sources of corruption**:
  - Spending time in corrupted land (the catastrophe's aftermath still spreads)
  - Using pre-catastrophe Lore (powerful but tainted)
  - Proximity to horrors (the catastrophe's creatures)
  - Certain dark Lore fragments require corruption to access at all
- **Effects by level**:
  - Low: minor debuffs, unsettling visual effects on the character
  - Medium: NPCs react with fear or distrust; religious factions become hostile; corrupted creatures may ignore or be drawn to you
  - High: serious health degradation; dark Lore becomes more powerful but unstable
  - Critical: character begins to turn — death, or something worse than death
- **The temptation is the design**: corrupted zones hold the most powerful pre-catastrophe Lore. Horrors drop fragments unavailable elsewhere. The player is constantly offered power at a price.
- **Reducing corruption**: through the supernatural system — prayer, purification rituals, alchemical cleansing. All three traditions have a role. This makes churches, holy sites, and alchemists genuinely valuable infrastructure.
- **Ties to the setting**: corruption is the catastrophe as an ongoing survival threat, not a historical event. The world is still infected. Touching its deepest power means touching what destroyed everything.
- **Ties to the skill system**: some Lore fragments are only accessible above a certain corruption threshold — gated behind willingness to corrupt yourself, not behind a level or class.

#### Injuries *(stub — design later)*
- Severe damage events may leave **permanent debuffs** on the character until treated.
- Examples: broken limb (reduced movement/attack speed), deep wound (health drain), concussion (reduced perception).
- Treatment likely via the supernatural/alchemy system — same purification infrastructure as corruption.
- Adds another layer of stakes to combat without requiring a new system. Full design TBD.

#### What Survival Does NOT Include
- No temperature or weather survival mechanics (at least not as core systems).
- No disease simulation (disease exists in the setting but as world events, not a survival meter).
- No shelter requirement as a meter. Shelter is strongly desirable — at night, hostile creature activity rises and perception degrades — but this pressure is **emergent from threats**, not from an "indoor" buff or a shelter stat. Players build bases because the world is dangerous, not because the UI tells them to go inside.

### 2. Gathering
- Collecting raw resources from nodes in the world: trees → wood, rocks → stone, ore deposits → ore.
- Well-understood genre convention — do not deviate significantly from what players expect.
- Nodes are part of the tile map and are affected by the world generation (biome determines what nodes spawn).
- **Gathering and combat share the same interaction mechanic** — attacking a node with a tool and attacking an enemy with a weapon are the same underlying action. Combat is the meta-system that this plugs into.

### 3. Social
- NPCs are capable of crafting, gathering, and surviving on their own (slower and simpler than players, but using the same systems).
- The social system is potentially the most novel part of the game.

#### Hiring — the Workbench
- Players access the NPC employment system via a **hiring workbench** — a craftable deployable placed in the world.
- The workbench is the explicit interface: it gives the player a clear physical anchor for managing NPCs without hardcoding NPC behaviour.
- Once hired, an NPC is associated with that workbench/base. The player can assign jobs and priorities.

#### NPC Needs & Retention
- Hired NPCs have two core survival needs: **food** and **sleep** (a place to eat, a place to rest).
- If the player provides these (food supply, beds), NPCs will use them and remain at the base.
- If the player does not provide them, NPCs will attempt to fulfill their own needs independently.
- If they fail — they die. NPC death is real and has consequences for the player's operation.
- Retention is **emergent**: NPCs stay because their needs are met, not because of a hardcoded loyalty flag.

#### NPC Autonomy
- NPCs act on their own when not directed — they are not inert until given a task.
- Player influence is through jobs and priorities, not direct control.
- This creates a settlement dynamic: the player builds infrastructure (beds, food production, workshops), NPCs inhabit and use it, productivity follows.

#### The Progression Arc
- Early game: player survives alone, builds first shelter.
- First hire: place workbench → recruit first NPC → immediately need to provide food and a bed.
- Growth: more NPCs → more infrastructure needed → more complex base → more output.
- This arc is driven entirely by survival pressure and resource availability — no scripted quest chain needed.

### Open Questions (Social)
- [ ] Are there other NPC needs beyond food and sleep (safety, social contact, morale)?
- [ ] How does NPC decision-making work mechanically — utility scoring, behaviour trees, simple state machine?
- [ ] Can NPCs leave voluntarily if conditions are poor but not fatal?
- [ ] Do NPCs have specialisations or skills that affect which jobs they're suited for?
- [ ] How do NPCs interact with each other — do they form their own social groups independently of the player?

---

## Combat

### Influences & Feel
- Primary reference: **Vermintide** — souls-like timing and weight, but more fluid and hectic. "Souls-like with CS:GO movement."
- Adapted from first-person to overhead perspective. The read-position-respond loop survives the translation.
- Combat is **skill-based, not stat-based** as the primary expression. Stats matter, but timing, positioning and facing matter more.
- No pausing. Ever. Combat decisions are made in real-time under pressure.

### Core Mechanics

**Facing & Directional Combat**
- Your character faces the cursor/target. Facing direction is the central axis of combat.
- Attack arcs originate forward — width and speed depend on weapon type (spear: narrow, fast; greataxe: wide, slow).
- Blocking faces forward — attacks from the side and behind bypass the block.
- Getting flanked is punishing. Rotating your facing to manage multiple enemies is the primary skill expression.

**Directional Information Asymmetry**
- Information depth is tied to facing direction — not a hard FOV cutoff (not Project Zomboid).
- **In front of you**: full tactical overlay — enemy attack arcs, incoming projectile indicators, telegraph animations, all overlays visible.
- **Behind you**: enemies are still visible, their animations still play — but no overlays, no arc warnings, no projectile indicators. You can see them; you just don't get advance warning.
- This is a **soft information gradient**, not a binary visibility toggle. Rewarding correct facing without punishing the player with blindness.
- Your own attacks work the same way: your swing arc is visible as it executes, your projectiles are visible as they travel.

**Stamina**
- Blocking, swinging, and dodging all cost stamina.
- Running dry is punishing — you can't block or dodge, only move.
- Stamina management is a core skill, especially in prolonged fights or crowds.

**Parry & Counter**
- Enemies telegraph attacks with visible wind-up animations (readable from overhead).
- Blocking within the parry window staggers the enemy, opening a counter window.
- Successful counters deal bonus damage or break enemy posture.

**Dodge**
- Directional dodge roll with i-frames.
- Stamina cost. Used to escape arcs, reposition, or create space.

**Crowds**
- Multiple enemies attacking simultaneously is the primary difficulty driver (Vermintide-style).
- Positioning against groups is a conscious decision from the overhead view — you can see the whole battlefield.
- Friendly fire exists — your NPCs and other players can be hit by your arcs and vice versa.

### Weapons
- Primarily **melee** — the full medieval arsenal: swords, axes, spears, maces, daggers, halberds. Vermintide's variety is the reference.
- **Shields** — directional blocking, distinct from weapon parry.
- **Ranged** — bows and crossbows exist but are deliberately **not a primary playstyle**:
  - No zoom, no precision aiming.
  - Aimed by facing direction — the same directional system as melee.
  - Intentionally kept physical to avoid becoming a stat-fest.
  - Supplementary role: suppression, opening shots, utility.
- **Exotic/lore weapons** — magic or alchemy-based weapons. Lore not yet written but the design space is open.

### Enchantments, Coatings & Blessings
- Magic, alchemy, and religion do not manifest as direct combat spells (no fireballs).
- They provide **modifiers attached to items and equipment**:
  - **Coatings** — weapon oils and poisons (Witcher-style): applied before a fight, add elemental or status effects to strikes.
  - **Buffs / Blessings** — prayer or alchemy-derived stat improvements, timed or situational.
  - **Curses** — hostile modifiers placed on enemies or rival equipment.
  - **Wards** — defensive blessings on armour or structures.
- These are the bridge between the crafting/alchemy system and combat. Preparing before a fight matters.

### Stealth
- A cross-system mechanic with combat, survival, gathering, and social applications:
  - Hunting animals (survival/food)
  - Bypassing enemies in dungeons (combat avoidance)
  - Navigating hostile NPC territory
  - Theft in cities (social/crime)
  - Assassination (combat + political consequence)
- Detection is **soft and gradual**, not binary:
  - Based on distance, noise level (running vs crouching), and enemy facing direction.
  - Consistent with the directional information system — enemies facing away from you have no overlays and reduced detection.
  - Light level likely plays a role (night, torches, cave darkness).

### Skill System — Composable Abilities via Lore

**No hard class system. No skill trees.**

#### Lore — Knowledge as a Resource
- **Lore is raw knowledge** — not a skill or a finished ability. It is understanding that enables things.
- Lore is a **prerequisite layer**: combat skills, crafting expertise, alchemy formulas, religious rites all *require* certain Lore to be known before they can be performed.
- Lore is not the sword — it is knowing how to swing one.

#### Two States of Lore
Lore exists in two states, and can move between them:

| State | Description | Fate on death |
|---|---|---|
| **Internal** | Ingested / learned — lives inside the character. Active and usable. | Lost permanently |
| **External** | Written down — exists as a physical object (tome, scroll, carved stone). Storable, tradeable, inheritable. | Persists |

- **Internalising**: read a tome, train a skill, pray at an altar, receive teaching → Lore enters the character.
- **Externalising**: write it down → Lore becomes a physical object that can be stored, sold, or passed on.
- A character can hold Lore they haven't externalised — it dies with them unless they write it first.

#### Acquiring Lore
- **Training** — doing something repeatedly internalises it. Muscle memory.
- **Reading** — study an external Lore object to internalise it.
- **Prayer** — at an altar, using a praying recipe (itself a form of Lore), divine knowledge is granted.
- **Crafting** — combining existing Lore and materials can synthesise new Lore.
- **Looting** — Lore objects found in the world: dungeons, ruins, enemy scholars. Pre-catastrophe Lore is rare and potentially dangerous or corrupted.

#### The Dynasty Library
- External Lore objects survive death and can be stored in a family base.
- A player can **build a family library** — accumulating written Lore across generations.
- Each heir can internalise from the library, starting with more knowledge than their ancestor did.
- The dynasty grows not just in physical infrastructure but in **accumulated knowledge**.
- This is a long-term investment mechanic: the older and more careful the dynasty, the more powerful its starting position for each new heir.
- Libraries become **high-value targets** — raiding a rival's library is as damaging as destroying their base.

#### Lore in the World Economy
- Lore objects are traded goods. Guilds sell technique. Churches sell prayer Lore. Masters tutor for coin.
- NPC cities have Lore repositories — their productive and military capability depends on what they know.
- A city with rare Lore is a strategic target.

#### Character Stats — Four Fluid Values
The character has exactly four stats. They are not progression targets — they are survival meters, always in flux:

| Stat | What it is |
|---|---|
| **Health** | How much damage you can absorb before death |
| **Stamina** | Fuel for actions: combat, running, blocking, dodging |
| **Hunger** | Accumulates over time; at maximum, life drain applies |
| **Thirst** | Accumulates faster than hunger; at maximum, life drain applies |

- Base values are the same for all characters. No level-up.
- **Skills in loadout can raise these** (while slotted).
- **Effects raise them temporarily**: food, potions, blessings, coatings.
- **Equipment provides armour** (damage reduction) — not a character stat. Armour lives on the item.

#### Basic Actions — Innate, No Lore Required
Every character can: `jump`, `throw`, `run`, `attack`, `crouch`, `dodge`. Human capability — the physics layer. A basic throw is just throwing. Functional, unspecial. **Lore combined with an action produces a skill** — something remarkable.

---

#### The Skill System — Positional Grammar

**A skill = action + Fragment1 + Fragment2. Position determines role.**

- **Fragment1** (position 1): what the skill *expresses outward* — the effect on the world.
- **Fragment2** (position 2): what the skill *draws from* — the cost or fuel.
- Fragments are **neutral** — neither positive nor negative inherently.
- **Same fragments, reversed order = genuinely different skill.**

*Vampiric Drain* [1] + *Hollow Hunger* [2]: steal health from enemy. Cost: your hunger spikes.
*Hollow Hunger* [1] + *Vampiric Drain* [2]: inflict hunger on enemy. Cost: your own health drains.

For **passive skills** (no action): Fragment1 applies persistently to self or as an aura. Fragment2 is the permanent tradeoff while slotted. Passives occupy the same loadout slots as actives — no distinction enforced.

---

#### Fragment Data Structure

```
name:      "Vampiric Drain"
concept:   DRAIN
domain:    SUPERNATURAL      ← tradition (affects naming/aesthetics only)
magnitude: 3                 ← 1–5, upgradeable via crafting
outward:   drain [stat] from [target] into caster
inward:    drain caster's [stat] as fuel
```

Fragments upgraded via crafting: fragment + materials/practice → higher tier. Stronger effect, proportionally stronger cost. Same crafting system as everything else.

---

#### The Verb × Concept Matrix — The Combinatorial Engine

Each cell: *"what does this concept look like through this verb?"*

**Available verbs:**

| Category | Verbs |
|---|---|
| Combat | `attack`, `throw`, `shout`, `dash`, `pray` |
| Gathering | `harvest`, `track` |
| Production | `craft`, `enchant` |
| Social | `trade`, `persuade` |
| Construction | `build` |
| Passive | *(no action)* |

**Example: concept DRAIN and KEEN across verbs:**

| Verb | DRAIN | KEEN |
|---|---|---|
| `attack` | steal health on hit | hit weak points, bonus damage |
| `throw` | projectile drains stat on contact | precise throw, increased range |
| `shout` | drain morale from enemies in arc | sharp cry, cuts through confusion |
| `harvest` | extract more from node, deplete it faster | identify high-quality material before extracting |
| `track` | follow blood/life trails | detect hidden nodes and rare materials |
| `craft` | crafted item has drain property | higher precision, better quality output |
| `trade` | extract more value than fair | read NPC's actual price floor |
| `persuade` | drain NPC's willpower, they concede | sharp read of motivations |
| `build` | structures drain nearby enemy stamina | identify optimal placement |
| **passive** | slow aura drain on nearby enemies | extended detection range |

**Matrix size: ~14 verbs × ~25 concepts = ~350 cells.** Entirely data-driven — no code changes to add new content. New concept = 14 cells. New verb = 25 cells.

---

#### The Balance Algorithm

```
effect_power = fragment1.magnitude + action.base_magnitude
cost_power   = fragment2.magnitude

ratio = cost_power / effect_power
→ ratio >= 1.0 : full effect
→ ratio <  1.0 : effect scaled down
→ ratio >  1.0 : effect amplified (reward for harsh costs)
```

Skills don't need to be exactly equal — they need **meaningful tradeoffs that players juggle.**

**The strategic layer:** find Fragment2 costs that don't affect your build. An acid-resistant character uses *Caustic Fumes* as Fragment2 on everything — cost is meaningless to them, all their skills run amplified. Build synergy emerges from the cost layer, not just the effect layer.

---

#### Naming — The Tradition Illusion

Each concept has a word bank per supernatural tradition:

| Concept | Supernatural | Religious | Alchemical |
|---|---|---|---|
| DRAIN | Vampiric, Siphoning | Penance, Sacrifice | Dissolution, Extraction |
| FIRE | Infernal, Smouldering | Divine Flame, Purgation | Ignis, Combustion |
| FEAR | Dread, Spectral | Judgement, Wrath | Hysteria, Adrenaline |

Skill name = Fragment1 word (tradition-flavoured) + action noun.

Same skill, three traditions → three names → players perceive three different things. **The supernatural unity illusion maintained through naming alone.**

---

#### The Skill Loadout

- One unified set of slots (~6–8, TBD).
- Active or passive per slot — no distinction enforced. Any mix valid.
- You accumulate more skills than fit — loadout choice is the build.
- On death, **all internal Lore is lost** — including every fragment and every skill configuration the character knew.
- The only way to preserve knowledge across death is to **externalise it**: write Lore fragments or complete skill configurations into tomes before dying. Tomes are physical objects stored in the world.
- This gives books real variety: a tome can contain a single fragment, a tested skill combination (fragment1 + action + fragment2), or an entire loadout. The more a player writes down, the richer their heir's starting library.

---

#### Emergent Character Identity

A character deeply invested in DRAIN Lore becomes, coherently across all systems:
- Leeching in combat (attack + drain)
- Extractive with resources (harvest + drain)
- Exploitative in trade (trade + drain)
- Carrying a vampiric aura (passive + drain)

Nobody designed that archetype. It fell out of one concept applied across a matrix.

---

#### Scale

- 25 fragments × 24 ordered pairs × 14 verbs = **8,400** skills
- 50 fragments: **34,300** skills
- Three-fragment advanced compositions: multiples further
- A million is achievable. All procedural. All data-driven.

### Open Questions (Lore)
- [ ] Is a Lore tome consumed when read, or can it be used by multiple characters?
- [ ] Can Lore be partially known — fragments of a technique that give partial benefit?
- [ ] Is there a limit to how much Lore a character can hold internally, or is it unbounded?
- [ ] Can Lore be corrupted — pre-catastrophe knowledge that has dangerous side effects?
- [ ] Is there a lock-on system or is targeting purely facing-based?
- [ ] How do NPCs behave in a fight — autonomous, or can the player issue combat orders?

---

### 4. Combat (System Summary)
- A **meta-system** — not a standalone feature but a mechanic that other systems use:
  - Gathering: attacking resource nodes with tools uses the combat interaction model.
  - Survival: hostile creatures (zombies etc.) apply survival pressure via combat.
  - Progression: dungeons/caves are filled with enemies, making combat a driver of exploration.
- Full design is in the **Combat** section above.

### 5. Building

#### Overview
Building converts raw terrain and materials into permanent world structures. It is distinct from crafting: crafting produces items into inventory; building produces structures directly into the world.

#### Step 1 — Terrain Preparation
- The world is a heightmap of flat cells. Uneven terrain must be flattened before building on it.
- Done with a **terrain tool** (shovel/pick equivalent) — the same combat interaction model as gathering, just targeting ground cells.
- Flattening likely yields displaced material as resources (dirt, stone) — consistent with the gathering system.

#### Step 2 — Blueprint
- A **blueprint tool** (craftable deployable or handheld tool) lets the player design a structure layout on the flattened ground.
- The blueprint is a ghost/preview: walls, doorways, floors, stairs — placed as plans, not real geometry.
- Blueprint creation requires no materials — it is design work only.
- **Blueprints are saveable objects** — storable in the family library, tradeable, shareable. A valuable house design is Lore. Architectural knowledge can be sold.

#### Step 3 — Construction
- A player or NPC with a **hammer** and the required **materials in inventory** walks to the blueprint and builds it.
- Each blueprint element has a material requirement (wood walls = planks, stone walls = cut stone, etc.).
- Progress is incremental — partial construction is valid. A half-built wall is a half-built wall.
- **NPCs can be assigned to build from a blueprint** via the job system — the player designs, NPCs execute. This is the primary scaling mechanism for large structures.

#### What This Means
- Large base construction is a management and logistics problem, not a solo grind.
- The blueprint/build separation mirrors the design/execution split in the management system — same philosophy.
- Building ties into gathering (need materials), crafting (some materials need processing first), NPC jobs (assign builders), and territorial control (the workbench placement completes a base).

### Open Questions (Building)
- [ ] Can structures be destroyed — by combat, corruption, decay over time?
- [ ] Are there material tier requirements for certain structure types (e.g. stone walls require stone-cutting Lore)?
- [ ] Can blueprints be modified after partial construction has begun?

---

## NPC & Society Systems

### NPC Micro AI — Individual Behaviour

#### Core Model
NPCs are **job board executors**. They have a defined set of actions they can perform, and they perform them based on what the job board assigns. The job board is the brain; the NPC is the body.

This keeps individual NPC logic simple and predictable. Emergent behaviour comes from many NPCs executing jobs in parallel, not from complex individual reasoning.

**Sensory system:** NPCs require a minimal sensory layer to function — at minimum, proximity detection for emergency states (threat nearby, food nearby). This is not full autonomous perception, but it is not zero. Sensor scope varies by NPC role: a guard needs threat detection; a trader needs inventory/price awareness; a basic labourer needs very little. The sensory system is one of the most significant implementation challenges in the NPC layer and needs dedicated design.

#### States

**Normal — job execution:**
- NPC pulls the highest-priority available job from their assigned job board.
- Navigates to location, executes the required actions, reports completion.
- Job types map to available NPC actions: `move_to`, `harvest(node)`, `craft(recipe)`, `build(blueprint_element)`, `trade(goods)`, `patrol(area)`, `sleep`, `eat`.
- Failed jobs (NPC dies, tools missing, path blocked) return to the board uncompleted.

**Idle — no job available:**
- When the job queue is empty or the NPC has completed its daily work allocation, it enters idle.
- Idle behaviour is ambient and flavour-driven — wandering, resting, socialising with nearby NPCs.
- Rimworld-style: not scripted, just low-priority random actions within a home range.

**Emergency states — override everything:**
- `STARVING / DEHYDRATED`: hunger or thirst critical → NPC abandons current job, seeks food or water immediately. If none found, health begins draining.
- `UNDER ATTACK`: NPC is hit or a threat enters proximity → enters combat mode. Uses equipped weapons and skills. Fights or flees based on health and confidence. Returns to normal state when threat resolves.
- Emergency states are interrupts — they bypass the job board entirely and resolve before normal execution resumes.

#### Job Board
- Every NPC is assigned to exactly one job board (their workbench/base).
- The job board is the sole management interface — players, city AIs, and other managers post jobs here.
- Jobs have: type, location, priority, required tools/materials, optional skill requirement.
- NPCs match jobs to their capabilities. An NPC without a hammer cannot take a building job.
- Unassigned NPCs (no job board) enter permanent idle — they may wander, trade opportunistically, or eventually leave the area.

#### Scaling — Tiles as Independent Processes
- Each tile map runs as an **independent server process**.
- NPCs exist within a tile's process. Their simulation is entirely local.
- Cross-tile interactions (gate transitions, caravans arriving) are inter-process messages.
- This architecture scales horizontally: more active tiles = more server processes. Player population growth = spin up more tile processes.
- The world simulation is naturally distributed — no shared global state required.

#### Lore & Skills
- NPCs accumulate Lore slowly through job execution (a blacksmith NPC improves with time).
- Their Lore set is smaller and grows slower than a player's.
- City libraries can supply Lore tomes to NPCs via job board assignments — `read(tome)` is a valid job.
- NPC skills are composed the same way as player skills, just from a more limited fragment set.

### NPCs as Simulated Players
- NPCs and players operate on the **same rules and same systems** — same crafting, same economy, same combat.
- NPCs are differentiated only by:
  - Slower simulation tick rate
  - Simpler decision-making ("dumber")
- This makes players naturally superior, but not by design fiat — by actual capability.
- NPCs and players share the same **progression system** — skills improve through use. The player's version is deeper and more expressive; the NPC version is simpler but uses the same underlying structure.

### The Living World — Seeded NPC Civilisations
- On world creation, the world is **seeded with NPC-led settlements** at various points on the world map.
- These settlements develop over time into cities — trading, growing, competing.
- They are not static backdrops; they are active participants in the world economy and politics.
- NPC cities trade with each other and with players. They have their own supply, demand, and production.

### NPC City AI — LLM-Driven Strategy

#### Architecture
- Each NPC city is governed by an **LLM agent** that makes strategic decisions.
- The LLM interacts with the world exclusively through **engine tool calls** — the same job board and priority system available to any player. It cannot do anything a player-king could not do.
- The LLM is the **strategic layer** only. Individual NPC behaviour (gathering, crafting, selling, fighting) runs on the standard NPC simulation tick beneath it.

#### Event-Driven Execution
- The LLM is not called on a tick. It is triggered by **significant events**:
  - Raid on the city or its caravans
  - Resource shortage or surplus threshold crossed
  - Neighbouring city changes political stance
  - A player kills a city leader
  - A trade agreement is broken
  - Population growth or loss beyond a threshold
- Between events, the city runs on the last instructions given.
- This keeps LLM calls infrequent, purposeful, and cost-manageable.

#### Personality & State
- Each city has a **persistent state file** that carries across calls: personality traits (aggressive, mercantile, isolationist, etc.), long-term goals, relationship history, and a recent event log.
- The state file is updated after each call — the LLM's decisions and their outcomes are recorded, giving the next call continuity.
- Personality is seeded at world generation and can drift over time based on events. A city that survives repeated raids becomes more militaristic; one that prospers through trade becomes more commercially oriented.

#### Context & Tools
- On each call, the LLM receives a **context packet**: city personality + state file, current city state, resources, population, threats, caravan status, relationship map with other cities, recent event log.
- Available tool calls (examples):
  - `post_job(type, priority, location)` — adds to the city job board
  - `set_priority(category, level)` — shifts city-wide focus (defense, food, expansion, trade)
  - `send_caravan(destination, goods, guard_count)` — dispatches a trade caravan
  - `propose_trade(city_id, offer, request)` — initiates a trade agreement
  - `declare_hostility(target)` — shifts city stance
  - `hire_npc(role)` — recruits from available NPCs
- The LLM's output is a list of tool calls. The engine validates and executes them.

#### Fallback
- If the LLM is unavailable, a simple utility AI maintains operations: feed population, defend walls, maintain basic production. Strategic decisions wait until the LLM responds.

### Macro Simulation — Abstract Politics
- Wars, alliances, and political conflict between NPC cities are **not simulated at the individual NPC level**.
- They are handled by an **abstract macro simulation** (similar to Civ's diplomatic and economic model):
  - Trade disputes, resource scarcity, political feuds are computed at the city level.
  - Outcomes manifest as concrete world events: trade caravans, raiding parties, territorial expansion.
- These events move through the **world map** and arrive at tile level as real encounters — caravans passing through, raiders attacking.
- The player's base exists within this living political world. It must be **defensible**. A raid is not a scripted event — it is the physical consequence of a macro simulation result.

### Player Interaction with the Macro Layer
- Players normally interact with the macro simulation through **signals** — actions in the world that the macro layer reads and responds to.
  - Example: killing a city's king is an extremely strong signal. The macro sim registers a power vacuum, instability, succession conflict.
- Players can optionally **step into leadership roles** — becoming a king, general, or political figure within the macro simulation.
  - This gives the player direct access to the macro layer: political decisions, trade agreements, declarations of war — the Civ-style interface.
  - Leadership is not permanent or safe. A player-king can be:
    - Voted out by advisors/generals (political failure)
    - Assassinated by NPCs (military/political consequence)
    - Killed by other players (direct PvP with macro consequences)
- Multiple players can hold leadership roles simultaneously in different cities — creating player-vs-player conflict at the political level, mediated through the macro simulation.
- This creates a spectrum of play styles within the same world: settler, trader, warlord, king — all coexisting, all connected through the same simulation.
- **Cooperation is a valid path**: players do not need to build their own base. A player can join an NPC city or a player-run settlement, take jobs on the local job board, explore the wilderness, and contribute to an existing organisation. The adversarial path (build, defend, raid) and the collaborative path (join, work, advance) coexist within the same systems.

### Emergent Society
- Societies emerge organically from:
  - **Association** (players and NPCs grouping)
  - **Work** (labour and resource production)
  - **Crafting** (manufacturing chains)
  - **Building** (physical infrastructure)
  - **Trade** (exchange of goods)
- No hard-coded factions — groups form from behaviour.

---

## Economy & Trade

### Philosophy
Simple enough to make goods spread across the world. Not a full economic simulation — no stock prices, no loans, no global market. Just supply, demand, currency, and physical movement of goods.

### Currency
- A single physical currency — coins as items in inventory.
- Coins have weight (encumbrance applies — large transactions are heavy).
- Currency can be stolen, looted from bodies, lost on death. It is not abstract.
- NPCs and players earn currency by selling. They spend it by buying.

### The Trader System (Micro)
- Any NPC can flag themselves as a **trader** — it is a job assignment on the job board, same as any other job.
- Traders carry inventory they're willing to sell at a price they set.
- NPCs with a need (hunger → seek food, low tools → seek equipment) find the nearest available trader and buy from them if they can afford it.
- Simple decision: `NPC has need → find nearby trader with relevant goods → if currency sufficient → buy`.
- Players interact with the same system — buy from and sell to traders directly.
- No auction house, no global market. Trade is local and physical.

### Macro Trade (Cities)
- NPC city AIs (LLM-driven) negotiate **trade agreements** at the city level.
- Agreements result in **caravans**: real NPC entities with goods, guards, and a destination, travelling the world map.
- Caravans can be raided — disrupting trade routes is a legitimate player strategy with macro consequences.
- Cities export surpluses and import scarcities. The LLM decides what to trade and when, based on city state.

### Regional Specialisation
- World generation distributes material properties unevenly across the map.
- Different regions produce materially different goods even using the same crafting recipes:
  - Flexible wood biome → bows produced there have higher draw strength
  - Dense hardwood region → structural materials are more durable
  - Specific ore deposits → tools with different properties
  - Rare herbs in certain biomes → alchemy ingredients unavailable elsewhere
- This creates **natural trade motivation**: regions export what their materials excel at.
- Players who understand the map gain real economic advantage — knowing where to source materials is knowledge worth having (and worth writing into a tome).

### Crafting — Physical Interaction Model

Crafting uses the **same attack/interaction mechanic as combat and gathering**. There is no menu-driven crafting screen. Everything happens physically in the world.

#### The Mechanic
- Place materials on the correct **workstation** (a deployable in the world).
- Equip the correct **tool**.
- Attack the workstation → output is produced.

The workstation type, tool type, and placed materials together determine the result. Wrong tool = no result. Wrong station = no result. Right combination = crafting happens.

#### Crafting Step Types
Not all steps are instantaneous attacks — some are time-based:

| Step type | How it works | Example |
|---|---|---|
| **Action** | Attack with correct tool | Axe on chopping block → planks |
| **Time** | Place materials, trigger process, wait | Ore in furnace, light it → wait → iron slugs |
| **Assembly** | Place multiple materials, select recipe, attack | 2 ingots on anvil, select blade recipe, hammer → blade |

The time-based steps create natural pacing — a furnace takes time, which means the player does other things while it runs. NPCs can tend furnaces as a job.

#### Crafting Chain Examples
```
Tree trunk → [chopping block + axe] → planks
Ore + fuel → [furnace + fire] → metal slugs  (time step)
Metal slug → [forge + heat + hammer] → ingot  (action step)
2 ingots → [anvil + blade recipe + hammer] → rough blade  (assembly step)
Rough blade + grip → [workbench + knife + recipe] → finished sword
```

Each step in the chain is a physical interaction. A long chain = many steps at many stations. Complex items require complex infrastructure.

#### Recipes as Lore
- Recipes are Lore — you need to know a recipe before you can select it on a workstation.
- A recipe defines: what materials go on the station, which step type executes, what the output is.
- Recipes are acquirable through all standard Lore paths: training, reading, purchasing from traders.
- Unknown recipe = you can try to guess (place materials, attack) and may produce a low-quality result or nothing.

#### Quality is Cumulative
- Input material properties propagate through every step.
- Crafter skill (Lore-based, via the `craft` verb in the skill system) affects output quality at each action step.
- A long chain amplifies both quality advantages and disadvantages — good materials + skilled crafter compounds upward; poor materials or unskilled execution compounds downward.
- **Material properties are real and specific**: flexibility, flammability, density affect specific outcomes, not an abstracted quality scalar.

### Open Questions (Economy)
- [ ] How do traders set prices — fixed markup, or dynamic based on local supply?
- [ ] Can players establish their own trade routes between cities (player-run caravans)?
- [ ] Is currency city-specific (different cities, different coins) or universal?

---

## Progression Philosophy

### Roguelike with World-Based Meta-Progression
- The game is structurally a **roguelike**: each character is a run. The run ends at death.
- The **meta-progression** is world-based — your base, your family library, your dynasty, your NPCs. These persist across deaths and represent your real long-term investment.
- Character power (Lore, equipment) is **temporary**. World investment (infrastructure, knowledge repositories) is **permanent.
- A character has **no levelled stats**. Health and stamina are fixed base values. Capability comes entirely from internalised Lore and equipped items. Nothing on the character sheet accumulates through experience points.

### The Respawn Ritual
On death, the quality of your recovery is a direct reflection of past decisions:

1. Heir spawns → walks to the family library
2. Selects tomes to read → internalises Lore → character is skilled up
3. Walks to the family treasury → equips gear stored there → character is armed
4. Walks back into the world

A well-maintained dynasty with a rich library and stocked treasury means a capable heir within minutes. A neglected dynasty means starting nearly naked.

### Player Knowledge vs Character Knowledge
- The player (human) accumulates meta-knowledge across deaths: how to get certain Lore, where resources spawn, how to handle threats.
- The character still has to **physically acquire** everything. Player knowledge shortens the path but does not replace the journey.
- This is the roguelike contract: you get smarter, your character starts fresh.

### The Death Spiral
- If you die faster than you progress, each death leaves you with less to return to.
- No hard "game over" — just a shrinking inheritance until you are effectively starting from nothing.
- Recovery is always theoretically possible, but increasingly difficult. Past decisions compound in both directions.

### Security of Progression
- The library and treasury are **not specially protected by the engine** — they are as vulnerable as any other part of the base.
- Security is the player's responsibility and is itself part of the progression loop:
  - Hire NPC guards → active base defense
  - Build better walls and doors → harder to breach
  - Better materials → more durable structures
  - Deeper base layout → more time for defenders to respond
- **Progression is self-serving**: you progress to make it harder to lose progress. The loop is intentional.
- No special vault mechanic needed — a well-built, well-defended, well-staffed base IS the vault.

---

## Death & Continuity

### Permadeath
- The game is **hardcore** — when a character dies, it is gone permanently.
- No "respawn at bed," no death penalty that can be walked off.
- This makes every decision carry real weight — combat, risk-taking, politics.
- It also solves many balance problems: power cannot accumulate indefinitely on a single character; death is a natural reset valve.

### Heritage System
- To preserve player investment across deaths, a **heritage system** provides continuity:
  - On death, the player spawns as an **offspring** of their previous character.
  - The heir spawns at the **family's central workbench** — the base's management anchor. No workbench = no safe spawn point; the heir starts displaced and vulnerable. This makes protecting the workbench a primary survival goal.
  - The heir has access to the deceased's structures and base — the physical world investment persists.
  - All internal Lore and carried items are lost — the heir starts without knowledge and must relearn and reequip from the family library and treasury.
  - This creates a **generational arc**: the base and dynasty outlive any individual character.
- The heir inherits the world context too — relationships, reputation, enemies. The NPC world remembers the family name.

### Implications
- Investment in **infrastructure** (buildings, NPC relationships, base development) is the durable form of progress. Personal character power is temporary.
- This naturally encourages players to build and delegate rather than hoard everything on their character.
- NPC cities have their own succession — player succession and NPC succession mirror each other through the same underlying systems.

---

## Management System (Unified)

### One System, All Scales
- Managing a 1-room base and managing a kingdom use **the same interface and the same mechanics**:
  - Job boards — assign tasks to NPCs
  - Priorities — set what gets done first
  - Mail / messages — respond to requests, disputes, events
- A king's workload is not a different system — it is the same system at 1000x the volume.
- **Delegation is the solution to scale**: a king assigns work to generals/stewards (NPC or player), who assign further down. Hierarchies emerge from delegation, not from hardcoded roles.
- Strange, emergent hierarchies are expected and desirable — they reflect the actual state of a settlement's organisation.

### Open Questions (Management)
- [ ] What does the job board UI look like at small scale vs large scale — does it adapt, or does the player need to delegate before it becomes unmanageable?
- [ ] Can players hold management roles in someone else's hierarchy (e.g. a player as a general under a player-king)?

---

## Territorial Control

### The Central Workbench as Ownership
- Base ownership is defined by the **central workbench** — the hiring/management deployable.
- Capturing a base means: kill the defenders, destroy the existing workbench, place your own.
- Without a workbench, the base's NPCs lose direction — they go neutral, disperse, or die. The base becomes inert.
- With your workbench placed, you now control the management layer: you assign jobs, set priorities, govern the space.
- This is the same mechanic as Rust's Tool Cupboard — well-understood, clean, requires real effort to execute.

### Contested Territory & Feuds
- Capture is never permanent against a living, motivated opponent.
- The original owner's heir spawns weak and far away — there is a natural window where the captor can fortify.
- The heir may be disincentivised to retake immediately (weak, poorly equipped, outnumbered).
- But they may build up over time, recruit allies, and return — creating long-running feuds.
- This tension is desirable: it generates stories, rivalries, and long-term political dynamics without needing to be scripted.
- Family-tagged personal assets remain claimed by the original family even after capture — they are a persistent source of grievance and motivation to retake.

### Open Questions (Territory)
- [ ] Can a workbench be reinforced or protected to make destruction harder?
- [ ] What happens to neutral NPCs after a workbench is destroyed — do they leave the tile, stay idle, or become hostile?

---

## Setting

### The World
**Medieval post-apocalyptic.** The base layer is the 1300s — swords, armour, feudalism, the Church, bubonic plague, the first stirrings of mechanics and early engineering. Gritty, grounded, historically-textured.

Layered on top: **low fantasy in the Witcher tradition** — not heroic high fantasy. Alchemy is practical and chemical, not sparkly. Magic is subtle, dangerous, and philosophically loaded. Multiple humanoid species (dwarfs, halflings, elves) exist but are treated with the same ambiguity and complexity as humans — not idealised.

### The Catastrophe
Something happened. A **convergence of magical, philosophical, and religious forces** — not a simple disaster but a conceptual unravelling, where belief systems, arcane structures, and philosophical frameworks collided and tore reality apart. Almost everyone died.

What it left behind:
- **The undead** — zombies and worse, the echoes of the dead who couldn't leave
- **Horrors** — things born from the catastrophe itself, not natural creatures
- **Corrupted land** — terrain infected or warped by whatever force was unleashed
- **Wars** — survivors fought over resources, over blame, over ideology, over the scraps of the old world

### The Present
Players are survivors in this aftermath. The world is hostile by default. Civilisation exists in pockets — NPC cities clinging to order, players carving out space. The catastrophe is in living memory, its causes still debated, its effects still spreading.

The tone sits between **Witcher-style grounded dark fantasy** and **survival horror** — not nihilistic, but not safe.

### The Supernatural — One System, Many Masks
Magic, alchemy, and religion are **mechanically identical**. They are the same underlying system wearing different clothes.

- An **altar** (religious), an **alchemist's bench** (scientific), a **witch's circle** (arcane), a **meditation mat** (spiritual) — all are crafting stations running the same engine underneath. Different aesthetics, same mechanics.
- The Lore they produce is the same type of Lore. A healing prayer and a healing tincture and a healing hex are the same thing, approached from different cultural angles.
- Each tradition has developed different **recipes** (their accumulated Lore), different **vocabularies**, and different **social standing** — but not different fundamental mechanics.

**The social layer is where the distinction lives:**
- A priest and a hedge witch doing the same ritual will be received entirely differently in a devout city.
- Alchemy is "rational" — acceptable in educated circles, distrusted by the church.
- Religion is "ordained" — protected in many cities, viewed as superstition or control by others.
- Magic is "dangerous" — feared, often outlawed, associated with the catastrophe.
- The player learns over time that these stigmas are social constructs. The mechanics don't care.

**The catastrophe connection:**
- The world-ending event was described as a "magical-philosophical-religious interweaving."
- The catastrophe *was* the moment these supposedly separate things converged — and it destroyed the world.
- Survivors now fiercely maintain the distinctions, believing that keeping them separate prevents another collapse.
- Players who discover the underlying unity are touching genuinely dangerous ground — historically, politically, and possibly literally.
- This means the game's central philosophical idea is embedded in its history. The mechanic *is* the lore.

### Open Questions (Setting)
- [ ] What exactly caused the catastrophe — defined lore, or intentionally ambiguous?
- [x] **Species: primarily visual, with minor passive traits.** No mechanical class differences. Species identity is mostly aesthetic and emergent socially (dwarven cities develop differently from human ones by behaviour, not by hardcoded bonuses). Small passive traits are acceptable where they serve the setting (e.g. undead vulnerable to holy damage, a dwarf's natural resilience as a minor health modifier). Enemy/creature species matter more — their operational differences are part of the bestiary design.
- [ ] Does the supernatural system have a hard cost (health, sanity, sacrifice) or is the cost social/political?

---

## Open Design Questions (Global)

- [ ] What genre anchors this closest to? (survival sandbox? strategy? RPG?)
- [x] **No win condition.** Open world simulation — the game runs indefinitely. Player goals are self-directed.
- [ ] What scale of player count is the target? (dozens? thousands?)
- [x] **PvP: always-on.** Players and NPCs follow the same rules — there is no safe zone by default. Protection comes from building, preparing, and progressing. The threat is constant and structural.
- [x] **World persistence: tile-based saves.** Each tile is an independent instance saved to disk. When a tile is loaded (player enters), it loads from its save. When unloaded (no players present), it saves. Natural consequence of the tile architecture — no special persistence system needed.

---

## Implementation Order

The vertical slice target: **single tile, single player, a handful of NPCs**. Core loops working: movement, combat, crafting, building, permadeath + heritage. Everything beyond this is a stub with the right interface.

Build in this order — each step depends on the previous:

### Phase 1 — Foundation
**1. Monorepo scaffold**
Create `voxim/` repo, `deno.json` workspace root, empty package directories each with their own `deno.json`. No code yet — just the structure and dependency graph enforced from day one.

**2. `@voxim/engine`**
- Math types: `vec2`, `vec3`, `EntityId` (UUID v7 string alias)
- `defineComponent<T>({ codec, default })` token factory
- `World` class: sparse entity store, typed queries, deferred changeset, version counters, tombstoning
- Tile event bus interface
- Physics loop: fixed timestep, gravity, velocity integration, impulse mechanism
- No game-specific knowledge. Zero monorepo dependencies.

**3. `@voxim/codecs`**
- `Serialiser<T>` interface: `encode(data: T): Uint8Array`, `decode(bytes: Uint8Array): T`
- Protobuf implementation behind the interface
- Codecs for first components: `Position`, `Velocity`, `Facing`, `Heightmap`, `MaterialGrid`

### Phase 2 — World
**4. `@voxim/world`**
- `Heightmap` and `MaterialGrid` component definitions (using codecs from step 3)
- Chunk entity factory: creates a chunk entity with both components
- Terrain height query: `getHeight(heightmap, localX, localY)`
- Chunk coordinate helpers: world position → chunk + local position
- Stub world generator: produces a flat 512×512 tile, all chunks at height 4.0

**5. `@voxim/protocol`**
- `Serialiser` interface re-exported (clients import it from here)
- Input datagram schema: `seq`, `tick`, `timestamp`, `facing`, `movement`, `actions`
- State message schema: `server_tick`, `ack_input_seq`, `entity_deltas`, `events`
- Event type definitions: `EntityDied`, `DamageDealt`, `GateApproached`, etc.
- Entity delta format: `(entityId, componentToken, encodedData, version)`

### Phase 3 — Server
**6. `@voxim/tile-server`**
Build in layers — get something running at each sub-step before adding the next:

- **6a. WebTransport server** — accept connections, receive datagrams, send reliable messages. No game logic yet. Just the transport working.
- **6b. Input ring buffers** — per-player buffers, concurrent input receiver, drain at tick start.
- **6c. Tick loop** — fixed timestep, the 7-step sequence. Initially with no systems — just runs and sends empty deltas.
- **6d. Physics system** — gravity, movement, terrain collision, auto-step. Player entity moves around a flat tile.
- **6e. Hunger/thirst system** — accumulate values, emit debuff changesets. Player can die of hunger.
- **6f. Lifetime system** — projectile/effect cleanup.
- **6g. Combat system stub** — attack arc detection against state history. Damage events. Death.
- **6h. NPC AI stub** — job board, basic needs, emergency states. NPCs wander and starve.
- **6i. Crafting system stub** — time-based step advancement, output events.
- **6j. Building system stub** — blueprint placement, incremental construction.

**7. `@voxim/gateway`**
- WebTransport signaling server
- Handshake flow: authenticate → look up tile → return tile server address
- Tile directory: one entry for the vertical slice tile
- World event bus stub: receives events from tile servers, does nothing yet
- Tile transition stub: defined interface, not yet needed for single-tile

### Phase 4 — Client (later)
`@voxim/client` and `@voxim/content` are built after the server is running and testable. The server can be integration-tested with a headless fake client that sends input datagrams and asserts on received state messages — no renderer needed to verify correctness of physics, combat, crafting, or NPC behaviour.

Client milestone begins when: server runs, player entity moves, combat resolves, NPCs function, and you want to see it.

---

*Last updated: 2026-04-04 (rev 2 — contradictions pass)*
