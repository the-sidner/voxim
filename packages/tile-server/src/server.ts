/// <reference path="./types/webtransport.d.ts" />
/**
 * TileServer — the authoritative game process for one tile.
 *
 * Responsibilities:
 *   - WebTransport server (Deno HTTP/3, requires --unstable-net flag and TLS certs)
 *   - Per-player session management and input ring buffers
 *   - Fixed-timestep tick loop following the 7-step sequence from the spec
 *   - All server-side systems in declared order
 *
 * Process model: one TileServer instance per tile process. Spun up on demand,
 * shuts down when idle. Registers with the gateway on startup when a
 * gatewayUrl / tileAddress / adminPort triple is configured; omits
 * self-registration in dev/demo mode (single tile, no gateway).
 */
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId, ChangesetSet } from "@voxim/engine";
import { chunksFromBuffers, loadTerrainCache, seedFromTileId } from "@voxim/world";
import type { ZoneGridData } from "@voxim/world";
import { binaryStateMessageCodec, ACTION_BLOCK, ACTION_CROUCH, encodeFrame, makeFrameReader, TileEvents } from "@voxim/protocol";
import type { EntityDeployedPayload } from "@voxim/protocol";
import { startAdminServer, registerWithGateway } from "./admin_server.ts";
import { listenQuic } from "./quic_server.ts";

// Bits that represent held keys — use latest-wins rather than OR across the tick.
const HELD_ACTION_MASK = ACTION_BLOCK | ACTION_CROUCH;
import type { BinaryComponentDelta, CommandPayload, TileJoinRequest, TileJoinAck, WorldSnapshot } from "@voxim/protocol";
import { computeSessionUpdate } from "./aoi.ts";
import { loadContentStore, type ContentStore } from "@voxim/content";
import { ClientSession } from "./session.ts";
import { TickLoop } from "./tick_loop.ts";
import { DeferredEventQueue } from "./deferred_events.ts";
import { StateHistoryBuffer } from "./state_history.ts";
import { AccountClient } from "./account_client.ts";
import type { SessionInfo } from "./account_client.ts";
import { spawnPrefab } from "./spawner.ts";
import { validatePrefabs } from "./prefab_validator.ts";
import type { System } from "./system.ts";
import { Position, Velocity, Facing, InputState } from "./components/game.ts";
import { Heritage } from "./components/heritage.ts";
import { Hitbox } from "./components/hitbox.ts";
import { NpcAiSystem } from "./systems/npc_ai.ts";
import { PhysicsSystem } from "./systems/physics.ts";
import { DodgeSystem } from "./systems/dodge.ts";
import { HungerSystem } from "./systems/hunger.ts";
import { StaminaSystem } from "./systems/stamina.ts";
import { LifetimeSystem } from "./systems/lifetime.ts";
import { ActionSystem } from "./systems/action.ts";
import { EquipmentSystem } from "./systems/equipment.ts";
import { PlacementSystem } from "./systems/placement.ts";
import { CraftingSystem } from "./systems/crafting.ts";
import { ConsumptionSystem } from "./systems/consumption.ts";
import { ResourceNodeSystem } from "./systems/resource_node_system.ts";
import { HealthHitHandler } from "./handlers/health_hit_handler.ts";
import { ResourceNodeHitHandler } from "./handlers/resource_node_hit_handler.ts";
import { BlueprintHitHandler } from "./handlers/blueprint_hit_handler.ts";
import { WorkstationHitHandler } from "./handlers/workstation_hit_handler.ts";
import { TerrainDigSystem } from "./handlers/terrain_hit_handler.ts";
import { ItemPickupSystem } from "./systems/item_pickup.ts";
import { DayNightSystem } from "./systems/day_night.ts";
import { CorruptionSystem } from "./systems/corruption.ts";
import { EncumbranceSystem } from "./systems/encumbrance.ts";
import { SkillSystem } from "./systems/skill.ts";
import { BuffSystem } from "./systems/buff.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";
import { createEffectRegistries, registerBuiltinEffects } from "./effects/mod.ts";
import { createJobRegistry, registerBuiltinJobs } from "./ai/mod.ts";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildAllBehaviorTrees } from "./ai/bt/mod.ts";
import { createRecipeStepRegistry, registerBuiltinSteps } from "./crafting/mod.ts";
import { Registry } from "@voxim/engine";
import { ProjectileSystem } from "./systems/projectile.ts";
import { TraderSystem } from "./systems/trader.ts";
import { DynastySystem } from "./systems/dynasty.ts";
import { DurabilitySystem } from "./systems/durability.ts";
import { StaleSlotCleanupSystem } from "./systems/stale_slot_cleanup.ts";
import { AnimationSystem } from "./systems/animation.ts";
import { HitboxSystem } from "./systems/hitbox.ts";
import { DebugCommandSystem } from "./systems/debug_commands.ts";
import { WorldClock, TileCorruption } from "./components/world.ts";
import { SaveManager } from "./save_manager.ts";
import { serializePlayer } from "./handoff.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { ProceduralSpawner } from "./procedural_spawner.ts";
import { EventRouter } from "./event_router.ts";
import { sortSystemsByDependencies } from "./system_order.ts";
import type { TickContext } from "./system.ts";

export interface TileServerConfig {
  tileId: string;
  port: number;
  /** PEM-encoded TLS certificate (required by WebTransport / HTTP3). */
  cert: string;
  /** PEM-encoded TLS key. */
  key: string;
  tickRateHz?: number;
  /**
   * Path to the content data directory.
   * Defaults to packages/content/data/ (resolved by @voxim/content's loader).
   */
  dataDir?: string;
  /**
   * Directory for world save files.  When set, the server loads an existing
   * save on startup (skipping terrain generation) and auto-saves every 5 minutes.
   * Omit to run in ephemeral mode (no persistence).
   */
  saveDir?: string;
  /**
   * Plain HTTP port for gateway → tile internal communication (handoff, health-check).
   * When set, starts a plain HTTP admin server on this port.
   */
  adminPort?: number;
  /**
   * Path to a pre-generated terrain cache file (.bin).
   * If the file exists it is loaded directly (fast, ~ms).
   * If the file is absent the terrain is generated and saved here for next time.
   * Defaults to `./terrain_${tileId}.bin` when omitted.
   */
  terrainCacheFile?: string;
  /**
   * Gateway HTTP base URL — used for self-registration AND for account
   * service calls (session validation, heritage read/write, location
   * updates). Setting this enables the account-backed join path; omitting
   * it falls back to anonymous spawns (dev only).
   */
  gatewayUrl?: string;
  /**
   * WebTransport address advertised to clients via the gateway, e.g. "127.0.0.1:4434".
   * Required for gateway self-registration.
   */
  tileAddress?: string;
  /**
   * Shared secret the tile presents in the X-Voxim-Service-Secret header
   * when calling the gateway's /internal/* endpoints. Must match the
   * gateway's VOXIM_SERVICE_SECRET; at least 16 chars. Required when
   * gatewayUrl is set.
   */
  serviceSecret?: string;
  /**
   * Enable dev/cheat commands (e.g. DebugGiveItem).
   * Should never be true in production deployments.
   * Defaults to false.
   */
  devMode?: boolean;
}


export class TileServer {
  private world = new World();
  private eventBus = new EventBus();
  private sessions = new Map<EntityId, ClientSession>();
  private readonly spatial = new SpatialGrid();
  /** SHA-256 fingerprint of the TLS cert, hex-encoded. Set in start(). */
  private certHashHex = "";
  /** WebTransport port — served to the demo client page. Set in start(). */
  private wtPort = 4434;
  private tickLoop = new TickLoop();
  private stateHistory = new StateHistoryBuffer();
  /**
   * RPC interface to the gateway-hosted account service. Null when running
   * without a gateway (dev/demo), in which case join spawns brand-new
   * characters with no inherited heritage and deaths do not persist.
   */
  private accountClient: AccountClient | null = null;
  /** Cached from config so disconnect paths can tell the gateway where the player logged off. */
  private tileId = "";
  private content!: ContentStore;
  // Initialised in start() — subscribes to the event bus and drained each tick.
  private events!: EventRouter;

  // Initialised in start() — ActionSystem needs tickRateHz and stateHistory
  private systems: System[] = [];

  private saveManager: SaveManager | null = null;
  private saveTickCounter = 0;
  private gatewayUrl: string | null = null;
  /**
   * Players for whom a handoff fetch is in flight. Prevents a second
   * GateApproached event (or rapidly-repeated collisions) from initiating a
   * duplicate handoff while the first is still pending its gateway round-trip.
   */
  private handingOff = new Set<EntityId>();

  async start(config: TileServerConfig): Promise<void> {
    const tickRateHz = config.tickRateHz ?? 20;
    this.wtPort = config.port;

    // Compute cert fingerprint (served via /cert-hash for client self-signed cert pinning).
    const b64 = config.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hashBuf = await crypto.subtle.digest("SHA-256", der);
    this.certHashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.tileId = config.tileId;

    // Account service RPC — required in production, omitted in dev/demo. When
    // absent, join spawns anonymous characters and deaths/location updates
    // are silently dropped (intentional: single-tile dev builds should run
    // without a gateway at all).
    if (config.gatewayUrl && config.serviceSecret) {
      this.accountClient = new AccountClient(config.gatewayUrl, config.serviceSecret);
    }

    // Load all game content (recipes, prefabs, lore, materials) from data files.
    // Systems receive the store by injection — no hardcoded tables in game logic.
    this.content = await loadContentStore(config.dataDir);
    const content = this.content;
    // Validate every prefab against the component registry + schemas + requires.
    // Fails fast on malformed content so a booted server is known-good.
    validatePrefabs(content);

    // Effect handler registries — apply/tick/compose are plug-in points for
    // SkillSystem and BuffSystem. Built-in effects are registered here; every
    // `effectStat` in the concept-verb matrix must resolve to a registered
    // apply handler. Validated below; fail-fast on mismatch.
    const effects = createEffectRegistries();
    registerBuiltinEffects(effects);
    for (const entry of content.getAllConceptVerbEntries()) {
      if (!effects.apply.has(entry.effectStat)) {
        throw new Error(
          `ContentStore references effectStat "${entry.effectStat}" ` +
          `(verb=${entry.verb} outward=${entry.outwardConcept} inward=${entry.inwardConcept}) ` +
          `but no apply handler is registered. Registered: [${effects.apply.ids().join(", ")}]`
        );
      }
    }

    // DeathSystem owns the single RequestDeath queue — systems with health-loss
    // kill paths publish here instead of calling world.destroy directly.
    // Hook registry is empty for now; later populated with drop-table, heir-spawn,
    // corpse-spawn hooks — additive, no system-file edits required.
    const deathHooks = new Registry<DeathHook>();
    const deathSystem = new DeathSystem(deathHooks);

    // Job handler registry — NpcAiSystem dispatches each NPC's current Job
    // through this. Built-in handlers: idle, wander, flee, seekFood, seekWater,
    // attackTarget. Adding a job type is a new handler file + one register call.
    const jobs = createJobRegistry();
    registerBuiltinJobs(jobs);

    // Behavior tree node registry + compiled trees. Every NpcTemplate
    // references a behaviorTreeId; trees are built from data/behavior_trees/
    // JSON at startup using the node registry. Unknown node types or missing
    // tree references fail fast here.
    const btNodes = createBTNodeRegistry();
    registerBuiltinBTNodes(btNodes);
    const behaviorTrees = buildAllBehaviorTrees(content, btNodes);
    for (const tmpl of content.getAllNpcTemplates()) {
      if (!behaviorTrees.has(tmpl.behaviorTreeId)) {
        throw new Error(
          `NpcTemplate "${tmpl.id}" references behaviorTreeId "${tmpl.behaviorTreeId}" ` +
          `but no such tree was loaded. Available: [${[...behaviorTrees.keys()].join(", ")}]`,
        );
      }
    }

    // Recipe step handler registry — WorkstationHitHandler + CraftingSystem
    // both dispatch through this. Built-ins: assembly (first, so explicit
    // selection wins), attack, time. Adding a step type is one handler file
    // + one register call.
    const recipeSteps = createRecipeStepRegistry();
    registerBuiltinSteps(recipeSteps);
    for (const recipe of content.getAllRecipes()) {
      const stepType = recipe.stepType ?? "time";
      if (!recipeSteps.has(stepType)) {
        throw new Error(
          `Recipe "${recipe.id}" references stepType "${stepType}" but no step ` +
          `handler is registered. Registered: [${recipeSteps.ids().join(", ")}]`,
        );
      }
    }

    // SkillSystem is constructed up front so we can register its StrikeLanded
    // subscriber against the real event bus before the tick loop starts. It
    // runs before ActionSystem in the pipeline so cooldown decrements are
    // visible to swings initiated the same tick.
    const skill = new SkillSystem(content, effects.apply, deathSystem);
    skill.registerSubscribers(this.eventBus, this.world);

    // Hearth anchor subscriber — when a prefab carrying the `hearth` component
    // is placed, tell the account service so the heir spawns at the new
    // location on next login. Fire-and-forget; a failed write leaves the
    // previous anchor in place and is logged. Runs during the post-changeset
    // flush; requires no world mutation, so a 1-tick latency is irrelevant.
    if (this.accountClient && config.tileId) {
      const accountClient = this.accountClient;
      const tileId = config.tileId;
      this.eventBus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
        const prefab = content.getPrefab(p.prefabId);
        if (!prefab?.components.hearth) return;
        accountClient.updateHearth(p.placerId, {
          tileId,
          position: { x: p.worldX, y: p.worldY, z: p.worldZ },
        }).catch((err: unknown) =>
          console.warn(`[hearth] updateHearth failed for ${p.placerId.slice(0, 8)}:`, err)
        );
        console.log(
          `[hearth] anchored player=${p.placerId.slice(0, 8)} entity=${p.entityId.slice(0, 8)} ` +
          `at (${p.worldX.toFixed(1)}, ${p.worldY.toFixed(1)}) on ${tileId}`,
        );
      });
    }

    const hitHandlers = [
      new HealthHitHandler(content, deathSystem, effects.outgoingDamage, effects.incomingDamage),
      new ResourceNodeHitHandler(content),
      new BlueprintHitHandler(),
      new WorkstationHitHandler(content, recipeSteps),
    ];

    // System pipeline, declared in reading order. Real ordering constraints
    // live on each system as `dependsOn` (e.g. PhysicsSystem.dependsOn =
    // ["NpcAiSystem"] because NpcAi writes InputState via world.write() that
    // Physics must see this tick). sortSystemsByDependencies computes the
    // final order: it honours dependsOn and preserves this reading order for
    // any pair whose relative ordering isn't load-bearing.
    //
    // DeathSystem stays last so it drains RequestDeath calls accumulated
    // this tick; its position is implicit in the declaration order since no
    // other system depends on it.
    const declared: System[] = [
      // Runs first so any Inventory/Equipment slot referencing an item entity
      // destroyed last tick (durability broken, consumed, traded away) is
      // scrubbed before downstream systems read slots or a stale ref is sent
      // on the wire.
      new StaleSlotCleanupSystem(),
      new NpcAiSystem(content, jobs, behaviorTrees),
      new HungerSystem(content, deathSystem),
      new StaminaSystem(content),
      new LifetimeSystem(),
      new ItemPickupSystem(content),
      new EquipmentSystem(content),
      new PlacementSystem(content),
      new CraftingSystem(content, recipeSteps),
      new ConsumptionSystem(content),
      new ResourceNodeSystem(content),
      new DayNightSystem(content),
      new CorruptionSystem(content, deathSystem),
      new EncumbranceSystem(content),
      new BuffSystem(effects.tick, effects.compose, deathSystem),
      new PhysicsSystem(content),
      new DodgeSystem(content),
      skill,
      new ActionSystem(this.stateHistory, tickRateHz, content, hitHandlers),
      new ProjectileSystem(content, hitHandlers),
      new TerrainDigSystem(content),
      new TraderSystem(content),
      new DynastySystem(content),
      new DurabilitySystem(),
      new AnimationSystem(content),
      new HitboxSystem(content),
      new DebugCommandSystem(content, config.devMode ?? false),
      deathSystem,
    ];
    this.systems = sortSystemsByDependencies(declared);

    // Set up persistence (optional — only if saveDir is configured)
    if (config.saveDir) {
      this.saveManager = new SaveManager(`${config.saveDir}/${config.tileId}.json`);
    }

    // Populate the world — load from save if one exists, otherwise generate fresh terrain
    const loaded = this.saveManager ? await this.saveManager.load(this.world) : false;
    let zoneGrid: ZoneGridData | null = null;
    let tileSeed = 0;
    if (!loaded) {
      tileSeed = seedFromTileId(config.tileId);
      const cachePath = config.terrainCacheFile ?? `./terrain_${config.tileId}.bin`;
      const loadedBuffers = await loadTerrainCache(cachePath);
      if (!loadedBuffers) {
        throw new Error(
          `No terrain cache found at "${cachePath}". Run: deno task gen-terrain`,
        );
      }
      console.log(`[TileServer] loaded terrain from cache: ${cachePath}`);
      chunksFromBuffers(this.world, loadedBuffers.heightBuffer, loadedBuffers.materialBuffer);
      zoneGrid = loadedBuffers.zoneGrid;
      this.spawnWorldState(content);
    }

    const procedural = new ProceduralSpawner(this.world, content, zoneGrid, tileSeed);
    if (!loaded) procedural.spawnInitialEntities();
    // NPCs and props are always re-spawned from layout (not persisted across restarts).
    procedural.spawnInitialNpcs();
    procedural.spawnProceduralProps();

    // Subscribe to tile events that need to reach clients as GameEvents.
    // The router is responsible for translation; handoff side-effects stay here.
    this.events = new EventRouter(this.eventBus, (p) => this.initiateHandoff(p));

    // Start the WebTransport QUIC server (Deno.QuicEndpoint, requires --unstable-net)
    listenQuic(config, (session) => this.handleSession(session));

    // Start admin HTTP server for gateway → tile internal messages (handoff)
    if (config.adminPort) {
      startAdminServer(config.adminPort, {
        world: this.world,
        getCertHashHex: () => this.certHashHex,
        getWtPort: () => this.wtPort,
      });
    }

    // Self-register with gateway so clients can be routed here
    if (config.gatewayUrl && config.tileAddress && config.adminPort) {
      this.gatewayUrl = config.gatewayUrl;
      const adminUrl = `http://localhost:${config.adminPort}`;
      registerWithGateway(config.gatewayUrl, config.tileId, config.tileAddress, adminUrl);
    }

    this.tickLoop.start((dt, tick) => this.runTick(dt, tick), { tickRateHz });

    console.log(
      `[TileServer] ${config.tileId} listening on port ${config.port} at ${tickRateHz}Hz`,
      `| ${content.getAllRecipes().length} recipes,`,
      `${content.getAllNpcTemplates().length} NPC types,`,
      `${content.getAllPrefabs().length} prefabs,`,
      `${content.getAllLoreFragments().length} lore fragments,`,
      `${content.getAllConceptVerbEntries().length} skill entries loaded`,
    );
  }

  async stop(): Promise<void> {
    this.tickLoop.stop();
    for (const session of this.sessions.values()) {
      session.close();
    }
    if (this.saveManager) {
      await this.saveManager.save(this.world);
      console.log("[TileServer] world saved");
    }
    console.log("[TileServer] stopped");
  }

  // ---- tick sequence ----

  private _tickWarnCount = 0;
  private runTick(dt: number, serverTick: number): void {
    const _t0 = performance.now();
    const _sysMs: [string, number][] = [];
    // ── 1. DRAIN INPUT BUFFERS ──────────────────────────────────────────────
    // MovementDatagrams → InputState (latest-wins for movement, OR for one-shot actions).
    // CommandDatagrams  → pendingCommands map (ordered, processed by systems this tick).
    const pendingCommands = new Map<string, CommandPayload[]>();
    for (const [playerId, session] of this.sessions) {
      if (!this.world.isAlive(playerId)) continue;

      // Drain movement datagrams into InputState.
      const inputs = session.inputBuffer.drain();
      if (inputs.length > 0) {
        const latest = inputs[inputs.length - 1];
        // One-shot bits: OR across all frames so a click in any frame isn't dropped.
        // Held bits: take from latest frame only — releasing a key before tick end
        // must not be reported as still held.
        let oneShots = 0;
        for (const inp of inputs) oneShots |= inp.actions;
        const mergedActions = (oneShots & ~HELD_ACTION_MASK) | (latest.actions & HELD_ACTION_MASK);

        // Update per-session RTT EMA from the latest datagram's client timestamp.
        if (latest.timestamp > 0) {
          const sampleMs = Math.max(0, Date.now() - latest.timestamp);
          const alpha = this.content.getGameConfig().network.rttEmaAlpha;
          session.updateRtt(sampleMs, alpha);
        }

        this.world.write(playerId, InputState, {
          facing: latest.facing,
          movementX: latest.movementX,
          movementY: latest.movementY,
          actions: mergedActions,
          seq: latest.seq,
          timestamp: latest.timestamp,
          rttMs: session.rttMs,
        });
      }

      // Drain command queue into pendingCommands map.
      if (session.commandQueue.length > 0) {
        pendingCommands.set(playerId, session.commandQueue.splice(0));
      }
    }

    // ── 2. RUN SYSTEMS ──────────────────────────────────────────────────────
    this.spatial.rebuild(this.world);
    const ctx: TickContext = { spatial: this.spatial, pendingCommands };
    const deferredEvents = new DeferredEventQueue();
    for (const system of this.systems) {
      const _st = performance.now();
      system.prepare?.(serverTick, ctx);
      system.run(this.world, deferredEvents, dt);
      _sysMs.push([system.constructor.name, performance.now() - _st]);
    }

    // ── 3. APPLY CHANGESET ──────────────────────────────────────────────────
    const _tChangeset = performance.now();
    const changeset = this.world.applyChangeset();
    _sysMs.push(["[changeset]", performance.now() - _tChangeset]);

    // ── 4. FIRE EVENTS ──────────────────────────────────────────────────────
    // Subscribers see the already-committed world state.
    deferredEvents.flush(this.eventBus);

    // ── 5. BUILD DELTA ──────────────────────────────────────────────────────
    const events = this.events.drain();
    const hasSessions = this.sessions.size > 0;

    // Skip serialization and send entirely when no clients are connected.
    const _tSend = performance.now();
    if (hasSessions) {
      // ── 6. SEND STATE (binary, per-session AoI) ───────────────────────────
      // Build component delta map once (encodes each changed component exactly once).
      // AoI filtering and spawn/despawn logic run per session in computeSessionUpdate.
      const changedComponents = this.buildDeltaMap(changeset.sets);
      const worldDestroys = new Set(changeset.destroys);
      for (const [playerId, session] of this.sessions) {
        if (!session.isOpen) { console.warn(`[TileServer] tick ${serverTick}: session ${playerId.slice(-8)} is closed, skipping`); continue; }
        const inputState = this.world.get(playerId, InputState);
        const ackInputSeq = inputState?.seq ?? 0;
        const msg = computeSessionUpdate(
          this.world, session, this.spatial, playerId,
          changedComponents, worldDestroys, events, serverTick, ackInputSeq,
        );
        const payload = binaryStateMessageCodec.encode(msg);
        const framed = new Uint8Array(4 + payload.byteLength);
        new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
        framed.set(payload, 4);
        session.sendStateRaw(framed);
      }
    }
    _sysMs.push(["[send]", performance.now() - _tSend]);

    // ── 7. ADVANCE TICK ─────────────────────────────────────────────────────
    // Periodic autosave — fire-and-forget, errors are logged and swallowed.
    const saveIntervalTicks = this.content.getGameConfig().persistence.saveIntervalTicks;
    if (this.saveManager && saveIntervalTicks > 0) {
      this.saveTickCounter++;
      if (this.saveTickCounter >= saveIntervalTicks) {
        this.saveTickCounter = 0;
        this.saveManager.save(this.world).catch((err: unknown) => {
          console.error("[TileServer] autosave failed:", err);
        });
      }
    }

    // Snapshot all hittable entities for lag compensation.
    // Any entity with a Position and Hitbox is included; Velocity/Facing are optional
    // (resource nodes are static and have neither).
    const snapEntities = [];
    for (const { entityId, position } of this.world.query(Position, Hitbox)) {
      const vel = this.world.get(entityId, Velocity);
      const fac = this.world.get(entityId, Facing);
      const is  = this.world.get(entityId, InputState);
      snapEntities.push({
        entityId,
        x: position.x, y: position.y, z: position.z,
        facing: fac?.angle ?? 0,
        velocityX: vel?.x ?? 0, velocityY: vel?.y ?? 0, velocityZ: vel?.z ?? 0,
        actions: is?.actions ?? 0,
      });
    }
    this.stateHistory.push({ serverTick, timestamp: Date.now(), entities: snapEntities });

    // ── 7b. SEND UNRELIABLE SNAPSHOTS ───────────────────────────────────────
    // Each datagram must stay under the QUIC datagram MTU (~1200 bytes).
    // WorldSnapshot layout: 6-byte header + 44 bytes/entity → max 27 entities/datagram.
    // Paginate across multiple datagrams with the same serverTick.
    if (hasSessions) {
      const PAGE_SIZE = 27;
      // actions intentionally excluded from wire snapshot — clients receive InputState
      // via reliable delta stream. snapEntities keeps actions for the server-side
      // StateHistoryBuffer (lag-compensated block detection), not for the wire format.
      const snapEntitiesMapped = snapEntities.map((e) => ({
        entityId: e.entityId,
        x: e.x, y: e.y, z: e.z,
        facing: e.facing,
        vx: e.velocityX, vy: e.velocityY, vz: e.velocityZ,
      }));
      for (let offset = 0; offset < snapEntitiesMapped.length || offset === 0; offset += PAGE_SIZE) {
        const page = snapEntitiesMapped.slice(offset, offset + PAGE_SIZE);
        const snap: WorldSnapshot = { serverTick, entities: page };
        for (const session of this.sessions.values()) {
          if (session.isOpen) session.sendSnapshot(snap);
        }
      }
    }

    // Remove disconnected sessions
    for (const [playerId, session] of this.sessions) {
      if (!session.isOpen) {
        this.sessions.delete(playerId);
        if (this.world.isAlive(playerId)) {
          this.world.destroy(playerId);
        }
      }
    }

    const _elapsed = performance.now() - _t0;
    if (_elapsed > 50) {
      if (++this._tickWarnCount <= 10 || this._tickWarnCount % 100 === 0) {
        const top = [..._sysMs]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([name, ms]) => `${name.replace("System", "")}=${ms.toFixed(1)}ms`)
          .join(" ");
        console.warn(
          `[TickLoop] overrun tick=${serverTick} elapsed=${_elapsed.toFixed(1)}ms | sys: ${top}`,
        );
      }
    }
  }

  // ---- delta builder ----

  private buildDeltaMap(sets: ReadonlyArray<ChangesetSet>): Map<EntityId, BinaryComponentDelta[]> {
    const map = new Map<EntityId, BinaryComponentDelta[]>();
    for (const entry of sets) {
      if (!entry.token.networked) continue;
      try {
        // deno-lint-ignore no-explicit-any
        const data = entry.token.codec.encode(entry.data as any);
        let list = map.get(entry.entityId);
        if (!list) { list = []; map.set(entry.entityId, list); }
        list.push({ entityId: entry.entityId, componentType: entry.token.wireId, version: entry.version, data });
      } catch {
        // Encoding failure — skip; stale data is better than a crash
      }
    }
    return map;
  }

  // ---- handoff side-effect ----

  /**
   * Fire-and-forget handoff to the destination tile via the gateway. The
   * re-entry guard prevents a second GateApproached event from starting a
   * parallel handoff while the first is still pending its round-trip; the
   * destination tile deduplicates retries on handoffId.
   */
  private initiateHandoff(payload: { entityId: EntityId; gateId: string; destinationTileId: string }): void {
    if (!this.gatewayUrl || this.handingOff.has(payload.entityId)) return;
    this.handingOff.add(payload.entityId);
    const dynastyId = this.world.get(payload.entityId, Heritage)?.dynastyId ?? payload.entityId;
    const handoffId = crypto.randomUUID();
    const body = serializePlayer(this.world, payload.entityId, dynastyId, payload.destinationTileId, handoffId);
    fetch(`${this.gatewayUrl}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => {
      if (r.ok) {
        // Destroy the entity here — it will be restored on the destination tile
        if (this.world.isAlive(payload.entityId)) this.world.destroy(payload.entityId);
        const session = this.sessions.get(payload.entityId);
        session?.close();
        this.sessions.delete(payload.entityId);
      } else {
        console.error(`[TileServer] handoff failed for ${payload.entityId}: ${r.status}`);
      }
    }).catch((err: unknown) => {
      console.error("[TileServer] handoff fetch error:", err);
    }).finally(() => {
      // On success the entity is gone so no subsequent handoff can even fire;
      // on failure the player is still here and should be allowed to retry.
      this.handingOff.delete(payload.entityId);
    });
  }

  private spawnWorldState(content: ContentStore): void {
    const dayLengthTicks = content.getGameConfig().dayNight.dayLengthTicks;
    const id = newEntityId();
    this.world.create(id);
    this.world.write(id, WorldClock, { ticksElapsed: 0, dayLengthTicks });
    this.world.write(id, TileCorruption, { level: 0 });
    console.log("[TileServer] world-state entity created");
    // Starter entities (workstations, nodes) are declared in tile_layout.json.
  }

  private async handleSession(session: WebTransportSession): Promise<void> {
    // Silence the session.closed rejection so it never becomes an uncaught promise
    // rejection that crashes the server process — we handle the close implicitly when
    // receiveInputs() returns (datagrams stream ends / throws).
    (session.closed as Promise<unknown>).catch((err: unknown) => {
      console.log("[TileServer] session.closed rejected:", err);
    });

    await session.ready;

    // --- join handshake ---
    // Client opens a bidirectional stream and sends TileJoinRequest (length-prefixed JSON).
    // We respond with TileJoinAck containing the canonical playerId.
    const streamReader = session.incomingBidirectionalStreams.getReader();
    const { value: joinStream } = await streamReader.read();
    streamReader.releaseLock();

    const jReader = (joinStream as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }).readable.getReader();
    const jWriter = (joinStream as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }).writable.getWriter();

    const joinMsg = await makeFrameReader(jReader).readJson() as TileJoinRequest | null;
    jReader.releaseLock();

    if (!joinMsg || joinMsg.type !== "join" || !joinMsg.playerId) {
      console.warn("[TileServer] rejecting malformed join");
      jWriter.close().catch(() => {}); jWriter.releaseLock();
      return;
    }

    // ── Validate the session token ────────────────────────────────────────────
    // The gateway already validated the token when routing this client to us,
    // but we re-validate here because nothing stops a direct WebTransport
    // connection from skipping the gateway. Token must resolve to the same
    // userId the client claims in joinMsg.playerId.
    //
    // If an account client is configured we enforce this. In dev/demo mode
    // (no gateway), we trust the claimed playerId as-is.
    let playerId: EntityId;
    let dynastyId: EntityId;
    let info: SessionInfo | null = null;

    if (this.accountClient) {
      if (!joinMsg.token) {
        console.warn("[TileServer] rejecting join without token");
        jWriter.close().catch(() => {}); jWriter.releaseLock();
        return;
      }
      info = await this.accountClient.validateSession(joinMsg.token).catch((err: unknown) => {
        console.error("[TileServer] session validation failed:", err);
        return null;
      });
      if (!info || info.userId !== joinMsg.playerId) {
        console.warn(`[TileServer] rejecting join: token/playerId mismatch`);
        jWriter.close().catch(() => {}); jWriter.releaseLock();
        return;
      }
      playerId = info.userId as EntityId;
      dynastyId = info.activeDynastyId as EntityId;
    } else {
      // No account service — accept the claimed playerId verbatim (dev mode).
      playerId = joinMsg.playerId as EntityId;
      dynastyId = playerId;
    }

    // Determine spawn vs reuse: post-handoff the entity already exists; for
    // a fresh join we create it. Heritage is fetched from the account service
    // for real users and from a default (generation 0) for dev-mode spawns.
    if (this.world.isAlive(playerId)) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} rejoining (post-handoff)`);
    } else {
      const spawn = this.content.getGameConfig().player;
      const heritage = this.accountClient
        ? (await this.accountClient.getHeritage(playerId).catch((err: unknown) => {
            console.error("[TileServer] heritage fetch failed:", err);
            return null;
          })) ?? undefined
        : undefined;
      // Use the hearth anchor as spawn point when it's on this tile; otherwise
      // fall back to the default spawn. Cross-tile routing is the gateway's job.
      const anchor = info?.hearthAnchor ?? null;
      const spawnAtHearth = anchor && anchor.tileId === this.tileId;
      const spawnX = spawnAtHearth ? anchor.position.x : spawn.defaultSpawnX;
      const spawnY = spawnAtHearth ? anchor.position.y : spawn.defaultSpawnY;
      const spawnZ = spawnAtHearth ? anchor.position.z : undefined;
      if (spawnAtHearth) {
        console.log(`[TileServer] player ${playerId.slice(0, 8)} spawning at hearth (%.1f, %.1f)`, spawnX, spawnY);
      }
      spawnPrefab(this.world, this.content, "player", {
        id: playerId,
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        heritage,
      });
    }

    // Send ack with canonical playerId
    const ack: TileJoinAck = { type: "joined", playerId };
    await jWriter.write(encodeFrame(ack));
    // Fire-and-forget — don't block on the client consuming the stream FIN.
    // Awaiting close() here caused an 80% failure rate: the tick loop could fire
    // between the await and createUnidirectionalStream(), registering no session
    // for that tick.  The client never received a snapshot.
    jWriter.close().catch(() => {});
    jWriter.releaseLock();

    // Open reliable unidirectional stream for state messages (server → client)
    // Cast: createUnidirectionalStream() returns WritableStream (unparameterized) in
    // the shared type declaration to match lib.dom.d.ts; runtime type is Uint8Array.
    const outStream = await session.createUnidirectionalStream() as WritableStream<Uint8Array>;

    const clientSession = new ClientSession(playerId);
    clientSession.attachOutputStream(outStream);
    // Attach datagram writer for unreliable WorldSnapshot channel
    clientSession.attachDatagramWriter(
      (session.datagrams.writable as WritableStream<Uint8Array>).getWriter(),
    );
    this.sessions.set(playerId, clientSession);

    // Send the initial world snapshot immediately rather than waiting for the next
    // tick.  Without this, the client may receive no state if the tick already fired
    // while we were awaiting createUnidirectionalStream() above.
    {
      const initialMsg = computeSessionUpdate(
        this.world, clientSession, this.spatial, playerId,
        new Map(), new Set(), [], this.tickLoop.currentTick, 0,
      );
      const initialPayload = binaryStateMessageCodec.encode(initialMsg);
      const initialFramed = new Uint8Array(4 + initialPayload.byteLength);
      new DataView(initialFramed.buffer).setUint32(0, initialPayload.byteLength, true);
      initialFramed.set(initialPayload, 4);
      clientSession.sendStateRaw(initialFramed);
    }

    // Subsequent ticks will send deltas via the normal AoI loop.
    // Background: accept the client-opened content bidi stream (second bidi stream)
    // and serve content requests for the lifetime of the session.
    const contentStreamReader = (session.incomingBidirectionalStreams as ReadableStream).getReader();
    contentStreamReader.read().then(
      (result) => {
        contentStreamReader.releaseLock();
        if (!result.done && result.value) {
          clientSession.serveContent(
            result.value as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
            this.content,
          ).catch(() => {});
        }
      },
    ).catch(() => { contentStreamReader.releaseLock(); });

    const heritageOnJoin = this.world.get(playerId, Heritage);
    console.log(
      `[TileServer] player ${playerId.slice(0, 8)} connected ` +
        `(dynasty ${dynastyId.slice(0, 8)}, gen ${heritageOnJoin?.generation ?? 0})`,
    );

    // Input receiver runs concurrently — returns when the session closes
    await clientSession.receiveInputs(session);

    // Session ended. Two paths:
    //   - entity still alive → clean disconnect, destroy locally. Also tell
    //     the account service which tile the player last occupied so the
    //     next login routes back here.
    //   - entity gone → combat death already destroyed it; inform the
    //     account service so heritage advances a generation.
    clientSession.close();
    this.sessions.delete(playerId);
    if (this.world.isAlive(playerId)) {
      this.world.destroy(playerId);
      if (this.accountClient) {
        await this.accountClient.updateLocation(playerId, this.tileId).catch((err: unknown) => {
          console.error("[TileServer] updateLocation failed:", err);
        });
      }
    } else if (this.accountClient) {
      await this.accountClient.recordDeath(playerId, "damage").catch((err: unknown) => {
        console.error("[TileServer] recordDeath failed:", err);
      });
    }
    console.log(`[TileServer] player ${playerId.slice(0, 8)} disconnected`);
  }
}

