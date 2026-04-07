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
 * shuts down when idle. Registers with the gateway on startup (gateway integration
 * is a stub — Phase 3, step 7).
 */
import { serveDir } from "@std/http/file-server";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId, ChangesetSet } from "@voxim/engine";
import { chunksFromBuffers, loadTerrainCache, seedFromTileId, ZONE_PROFILES, Heightmap } from "@voxim/world";
import type { ZoneGridData } from "@voxim/world";
import { TileEvents, binaryStateMessageCodec, COMPONENT_NAME_TO_TYPE, ACTION_BLOCK, ACTION_CROUCH } from "@voxim/protocol";

// Bits that represent held keys — use latest-wins rather than OR across the tick.
const HELD_ACTION_MASK = ACTION_BLOCK | ACTION_CROUCH;
import type { BinaryComponentDelta, CommandPayload, GameEvent, TileJoinRequest, TileJoinAck, WorldSnapshot } from "@voxim/protocol";
import { computeSessionUpdate } from "./aoi.ts";
import { loadContentStore, type ContentStore } from "@voxim/content";
import { ClientSession } from "./session.ts";
import { TickLoop } from "./tick_loop.ts";
import { DeferredEventQueue } from "./deferred_events.ts";
import { StateHistoryBuffer } from "./state_history.ts";
import { HeritageStore } from "./heritage_store.ts";
import { spawnPlayer, spawnNpc, spawnNode, spawnProp } from "./spawner.ts";
import type { System } from "./system.ts";
import { Position, Velocity, Facing, InputState } from "./components/game.ts";
import { NpcAiSystem } from "./systems/npc_ai.ts";
import { PhysicsSystem } from "./systems/physics.ts";
import { DodgeSystem } from "./systems/dodge.ts";
import { HungerSystem } from "./systems/hunger.ts";
import { StaminaSystem } from "./systems/stamina.ts";
import { LifetimeSystem } from "./systems/lifetime.ts";
import { ActionSystem } from "./systems/action.ts";
import { EquipmentSystem } from "./systems/equipment.ts";
import { CraftingSystem } from "./systems/crafting.ts";
import { ConsumptionSystem } from "./systems/consumption.ts";
import { BuildingSystem } from "./systems/building.ts";
import { GatheringSystem } from "./systems/gathering.ts";
import { DayNightSystem } from "./systems/day_night.ts";
import { CorruptionSystem } from "./systems/corruption.ts";
import { EncumbranceSystem } from "./systems/encumbrance.ts";
import { SkillSystem } from "./systems/skill.ts";
import { BuffSystem } from "./systems/buff.ts";
import { TraderSystem } from "./systems/trader.ts";
import { DynastySystem } from "./systems/dynasty.ts";
import { AnimationSystem } from "./systems/animation.ts";
import { TraderInventory } from "./components/trader.ts";
import { WorldClock, TileCorruption } from "./components/world.ts";
import { SaveManager } from "./save_manager.ts";
import { serializePlayer, restorePlayer } from "./handoff.ts";
import { SpatialGrid } from "./spatial_grid.ts";
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
   * Gateway HTTP base URL for self-registration, e.g. "http://localhost:8080".
   * When set alongside tileAddress, the tile registers itself on startup.
   */
  gatewayUrl?: string;
  /**
   * WebTransport address advertised to clients via the gateway, e.g. "127.0.0.1:4434".
   * Required for gateway self-registration.
   */
  tileAddress?: string;
}

// ── Procedural spawning helpers ───────────────────────────────────────────────

/**
 * Mulberry32 seeded PRNG — returns a function that yields [0, 1) each call.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick a key from a weight table using a single [0,1) random sample.
 */
function weightedPick(weights: Record<string, number>, rng: () => number): string | null {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ─────────────────────────────────────────────────────────────────────────────

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
  private heritageStore = new HeritageStore();
  /** Maps playerId → dynastyId so heritage can be recorded on death. */
  private playerDynasties = new Map<EntityId, string>();
  private content!: ContentStore;

  // Events accumulated by EventBus subscribers during a tick, sent in the next StateMessage
  private pendingEvents: GameEvent[] = [];

  // Initialised in start() — ActionSystem needs tickRateHz and stateHistory
  private systems: System[] = [];

  /** Zone grid built during terrain generation — used for biome-aware NPC/node placement. */
  private zoneGrid: ZoneGridData | null = null;
  /** Tile seed stored for deterministic procedural spawning RNG. */
  private tileSeed = 0;
  private saveManager: SaveManager | null = null;
  private saveTickCounter = 0;
  private static readonly SAVE_INTERVAL_TICKS = 6000; // 5 min at 20 Hz
  private gatewayUrl: string | null = null;

  async start(config: TileServerConfig): Promise<void> {
    const tickRateHz = config.tickRateHz ?? 20;
    this.wtPort = config.port;

    // Compute cert fingerprint (used by the debug client page).
    const b64 = config.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hashBuf = await crypto.subtle.digest("SHA-256", der);
    this.certHashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Load all game content (recipes, structures, lore, materials) from data files.
    // Systems receive the store by injection — no hardcoded tables in game logic.
    this.content = await loadContentStore(config.dataDir);
    const content = this.content;

    // System execution order matches the spec's declared order
    this.systems = [
      new NpcAiSystem(content),
      new PhysicsSystem(content),
      new DodgeSystem(content),
      new HungerSystem(content),
      new StaminaSystem(content),
      new LifetimeSystem(),
      new EquipmentSystem(content),
      new CraftingSystem(content),
      new ConsumptionSystem(content),
      new BuildingSystem(),
      new GatheringSystem(content),
      new DayNightSystem(content),
      new CorruptionSystem(content),
      new EncumbranceSystem(content),
      ...((): [SkillSystem, ActionSystem] => {
        const skill = new SkillSystem(content);
        const action = new ActionSystem(this.stateHistory, tickRateHz, content, skill);
        return [skill, action];
      })(),
      new BuffSystem(),
      new TraderSystem(content),
      new DynastySystem(content),
      new AnimationSystem(content),
    ];

    // Set up persistence (optional — only if saveDir is configured)
    if (config.saveDir) {
      this.saveManager = new SaveManager(`${config.saveDir}/${config.tileId}.json`);
    }

    // Populate the world — load from save if one exists, otherwise generate fresh terrain
    const loaded = this.saveManager ? await this.saveManager.load(this.world) : false;
    if (!loaded) {
      this.tileSeed = seedFromTileId(config.tileId);
      const cachePath = config.terrainCacheFile ?? `./terrain_${config.tileId}.bin`;
      const loadedBuffers = await loadTerrainCache(cachePath);
      if (!loadedBuffers) {
        throw new Error(
          `No terrain cache found at "${cachePath}". Run: deno task gen-terrain`,
        );
      }
      console.log(`[TileServer] loaded terrain from cache: ${cachePath}`);
      chunksFromBuffers(this.world, loadedBuffers.heightBuffer, loadedBuffers.materialBuffer);
      this.zoneGrid = loadedBuffers.zoneGrid;
      this.spawnWorldState(content);
      this.spawnInitialNodes(content);
    }

    // NPCs are always re-spawned from layout (not persisted across restarts)
    this.spawnInitialNpcs(content);

    // Props are always re-spawned (decorative, not persisted)
    this.spawnProceduralProps(content);

    // Subscribe to tile events that need to reach clients as GameEvents
    this.subscribeNetworkEvents();

    // Start the WebTransport QUIC server (Deno.QuicEndpoint, requires --unstable-net)
    this.startQuicEndpoint(config);

    // Start admin HTTP server for gateway → tile internal messages (handoff)
    if (config.adminPort) {
      this.startAdminServer(config);
    }

    // Self-register with gateway so clients can be routed here
    if (config.gatewayUrl && config.tileAddress && config.adminPort) {
      this.gatewayUrl = config.gatewayUrl;
      const adminUrl = `http://localhost:${config.adminPort}`;
      this.registerWithGateway(config.gatewayUrl, config.tileId, config.tileAddress, adminUrl);
    }

    this.tickLoop.start((dt, tick) => this.runTick(dt, tick), { tickRateHz });

    console.log(
      `[TileServer] ${config.tileId} listening on port ${config.port} at ${tickRateHz}Hz`,
      `| ${content.getAllRecipes().length} recipes,`,
      `${content.getAllStructureDefs().length} structures,`,
      `${content.getAllNpcTemplates().length} NPC types,`,
      `${content.getAllNodeTemplates().length} node types,`,
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
        this.world.write(playerId, InputState, {
          facing: latest.facing,
          movementX: latest.movementX,
          movementY: latest.movementY,
          actions: mergedActions,
          seq: latest.seq,
          timestamp: latest.timestamp,
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
    const events = this.pendingEvents.splice(0); // drain accumulated events
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
    if (this.saveManager) {
      this.saveTickCounter++;
      if (this.saveTickCounter >= TileServer.SAVE_INTERVAL_TICKS) {
        this.saveTickCounter = 0;
        this.saveManager.save(this.world).catch((err: unknown) => {
          console.error("[TileServer] autosave failed:", err);
        });
      }
    }

    // Snapshot all combat-relevant entities for lag compensation.
    // Queries the committed world state (applyChangeset already ran).
    const snapEntities = [];
    for (const { entityId, position, velocity, facing } of this.world.query(Position, Velocity, Facing)) {
      const is = this.world.get(entityId, InputState);
      snapEntities.push({
        entityId,
        x: position.x, y: position.y, z: position.z,
        facing: facing.angle,
        velocityX: velocity.x, velocityY: velocity.y, velocityZ: velocity.z,
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
      const typeId = COMPONENT_NAME_TO_TYPE.get(entry.token.name);
      if (typeId === undefined) continue;
      try {
        // deno-lint-ignore no-explicit-any
        const data = entry.token.codec.encode(entry.data as any);
        let list = map.get(entry.entityId);
        if (!list) { list = []; map.set(entry.entityId, list); }
        list.push({ entityId: entry.entityId, componentType: typeId, version: entry.version, data });
      } catch {
        // Encoding failure — skip; stale data is better than a crash
      }
    }
    return map;
  }

  // ---- event subscriptions ----

  private subscribeNetworkEvents(): void {
    // Convert tile bus events into GameEvents for the network delta
    this.eventBus.subscribe(TileEvents.EntityDied, (p: { entityId: EntityId; killerId?: EntityId }) => {
      this.pendingEvents.push({ type: "EntityDied", entityId: p.entityId, killerId: p.killerId });
    });

    this.eventBus.subscribe(TileEvents.DamageDealt, (p: {
      targetId: EntityId;
      sourceId: EntityId;
      amount: number;
      blocked: boolean;
    }) => {
      this.pendingEvents.push({
        type: "DamageDealt",
        targetId: p.targetId,
        sourceId: p.sourceId,
        amount: p.amount,
        blocked: p.blocked,
      });
    });

    this.eventBus.subscribe(TileEvents.BuildingCompleted, (p: {
      builderId: EntityId;
      blueprintId: EntityId;
      structureType: string;
    }) => {
      this.pendingEvents.push({
        type: "BuildingCompleted",
        builderId: p.builderId,
        blueprintId: p.blueprintId,
        structureType: p.structureType,
      });
    });

    this.eventBus.subscribe(TileEvents.CraftingCompleted, (p: {
      crafterId: EntityId;
      recipeId: string;
    }) => {
      this.pendingEvents.push({ type: "CraftingCompleted", crafterId: p.crafterId, recipeId: p.recipeId });
    });

    this.eventBus.subscribe(TileEvents.HungerCritical, (p: { entityId: EntityId }) => {
      this.pendingEvents.push({ type: "HungerCritical", entityId: p.entityId });
    });

    this.eventBus.subscribe(TileEvents.GateApproached, (p: {
      entityId: EntityId;
      gateId: string;
      destinationTileId: string;
    }) => {
      this.pendingEvents.push({
        type: "GateApproached",
        entityId: p.entityId,
        gateId: p.gateId,
        destinationTileId: p.destinationTileId,
      });
      // Initiate tile handoff: serialize player and forward to gateway
      if (this.gatewayUrl) {
        const dynastyId = this.playerDynasties.get(p.entityId) ?? p.entityId;
        const payload = serializePlayer(this.world, p.entityId, dynastyId, p.destinationTileId);
        fetch(`${this.gatewayUrl}/handoff`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).then((r) => {
          if (r.ok) {
            // Destroy the entity here — it will be restored on the destination tile
            if (this.world.isAlive(p.entityId)) this.world.destroy(p.entityId);
            const session = this.sessions.get(p.entityId);
            session?.close();
            this.sessions.delete(p.entityId);
          } else {
            console.error(`[TileServer] handoff failed for ${p.entityId}: ${r.status}`);
          }
        }).catch((err: unknown) => {
          console.error("[TileServer] handoff fetch error:", err);
        });
      }
    });

    this.eventBus.subscribe(TileEvents.NodeDepleted, (p: {
      nodeId: EntityId;
      nodeTypeId: string;
      harvesterId: EntityId;
    }) => {
      this.pendingEvents.push({
        type: "NodeDepleted",
        nodeId: p.nodeId,
        nodeTypeId: p.nodeTypeId,
        harvesterId: p.harvesterId,
      });
    });

    this.eventBus.subscribe(TileEvents.DayPhaseChanged, (p: { phase: string; timeOfDay: number }) => {
      this.pendingEvents.push({ type: "DayPhaseChanged", phase: p.phase, timeOfDay: p.timeOfDay });
    });

    this.eventBus.subscribe(TileEvents.TradeCompleted, (p: {
      buyerId: EntityId; traderId: EntityId; itemType: string; quantity: number; coinDelta: number;
    }) => {
      this.pendingEvents.push({
        type: "TradeCompleted",
        buyerId: p.buyerId,
        traderId: p.traderId,
        itemType: p.itemType,
        quantity: p.quantity,
        coinDelta: p.coinDelta,
      });
    });

    this.eventBus.subscribe(TileEvents.LoreExternalised, (p: { entityId: EntityId; fragmentId: string }) => {
      this.pendingEvents.push({ type: "LoreExternalised", entityId: p.entityId, fragmentId: p.fragmentId });
    });

    this.eventBus.subscribe(TileEvents.LoreInternalised, (p: { entityId: EntityId; fragmentId: string }) => {
      this.pendingEvents.push({ type: "LoreInternalised", entityId: p.entityId, fragmentId: p.fragmentId });
    });
  }

  // ---- WebTransport server (QUIC) ----

  private startQuicEndpoint(config: TileServerConfig): void {
    type QuicEndpoint = { listen(opts: unknown): AsyncIterable<{ accept(): Promise<unknown> }> };
    // deno-lint-ignore no-explicit-any
    const DenoAny = Deno as any;
    let endpoint: QuicEndpoint;
    try {
      endpoint = new DenoAny.QuicEndpoint({ hostname: "0.0.0.0", port: config.port }) as QuicEndpoint;
    } catch (err) {
      console.warn(`[TileServer] WebTransport/QUIC unavailable (${(err as Error).message}). Continuing without WebTransport — admin/HTTP only.`);
      return;
    }
    const listener = endpoint.listen({
      cert: config.cert,
      key: config.key,
      alpnProtocols: ["h3"],
    }) as AsyncIterable<{ accept(): Promise<unknown> }>;

    console.log(`Listening on https://0.0.0.0:${config.port}/`);

    (async () => {
      for await (const incoming of listener) {
        // Accept and upgrade each connection concurrently — don't block the accept loop
        incoming.accept()
          // deno-lint-ignore no-explicit-any
          .then((conn) => (Deno as any).upgradeWebTransport(conn))
          .then((wt: WebTransportSession) => this.handleSession(wt))
          .catch((err: unknown) => {
            console.error("[TileServer] connection error", err);
          });
      }
    })().catch((err: unknown) => {
      console.error("[TileServer] QUIC listener error", err);
    });
  }

  /**
   * Plain HTTP server for gateway → tile internal messages.
   * Runs on a separate port from WebTransport so TLS is not required.
   */
  private startAdminServer(config: TileServerConfig): void {
    const adminPort = config.adminPort!;
    Deno.serve(
      { port: adminPort, hostname: "127.0.0.1" },
      (req) => this.handleAdminRequest(req),
    );
    console.log(`[TileServer] admin HTTP listening on 127.0.0.1:${adminPort}`);
  }

  private async handleAdminRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/handoff") {
      try {
        const payload = await req.json();
        if (!payload.playerId || !payload.components) {
          return new Response("bad request", { status: 400 });
        }
        restorePlayer(this.world, payload);
        console.log(`[TileServer] received handoff for player ${payload.playerId}`);
        return Response.json({ type: "handoff_ack", playerId: payload.playerId });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (req.method === "GET" && url.pathname === "/cert-hash") {
      return Response.json(
        { sha256: this.certHashHex },
        { headers: { "access-control-allow-origin": "*" } },
      );
    }
    if (req.method === "GET" && url.pathname === "/debug") {
      return new Response(debugClientHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && url.pathname === "/game") {
      // Redirect to index.html with tile address as query param — main.ts reads ?tile=
      return Response.redirect(
        `${url.origin}/?tile=${encodeURIComponent(url.hostname + ":" + this.wtPort)}`,
        302,
      );
    }
    // Serve all other client assets (index.html, dist/game.js, src/ui/theme.css, etc.)
    // from the packages/client directory.
    return serveDir(req, {
      fsRoot: new URL("../../client", import.meta.url).pathname,
      quiet: true,
    });
  }

  /**
   * POST self-registration to the gateway so clients can be routed here.
   * Fire-and-forget — a failure is logged but does not block startup.
   */
  private registerWithGateway(gatewayUrl: string, tileId: string, tileAddress: string, adminUrl: string): void {
    fetch(`${gatewayUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "register", tileId, address: tileAddress, adminUrl }),
    }).then((r) => {
      if (!r.ok) console.error(`[TileServer] gateway registration failed: ${r.status}`);
      else console.log(`[TileServer] registered with gateway as ${tileId} → ${tileAddress}`);
    }).catch((err: unknown) => {
      console.error("[TileServer] could not reach gateway:", err);
    });
  }

  private spawnWorldState(content: ContentStore): void {
    const dayLengthTicks = content.getGameConfig().dayNight.dayLengthTicks;
    const id = newEntityId();
    this.world.create(id);
    this.world.write(id, WorldClock, { ticksElapsed: 0, dayLengthTicks });
    this.world.write(id, TileCorruption, { level: 0 });
    console.log("[TileServer] world-state entity created");
  }

  private spawnInitialNodes(content: ContentStore): void {
    const layout = content.getTileLayout();
    if (layout) {
      let spawned = 0;
      for (const node of layout.nodes) {
        const template = content.getNodeTemplate(node.nodeTypeId);
        if (!template) continue;
        spawnNode(this.world, { x: node.x, y: node.y, template });
        spawned++;
      }
      console.log(`[TileServer] spawned ${spawned} resource nodes from tile_layout`);
    } else {
      this.spawnProceduralNodes(content);
    }
  }

  private spawnInitialNpcs(content: ContentStore): void {
    const layout = content.getTileLayout();
    if (layout) {
      for (const npcCfg of layout.npcs) {
        const template = content.getNpcTemplate(npcCfg.npcType) ?? undefined;
        const id = spawnNpc(this.world, {
          x: npcCfg.x,
          y: npcCfg.y,
          name: npcCfg.name,
          npcType: npcCfg.npcType,
          maxHealth: template?.maxHealth,
          modelId: template?.modelTemplateId,
          speedMultiplier: template?.speedMultiplier,
          weaponItemType: template?.weaponItemType ?? null,
          skillLoadout: template?.skillLoadout,
        });
        if (npcCfg.traderListings && npcCfg.traderListings.length > 0) {
          this.world.write(id, TraderInventory, { listings: npcCfg.traderListings });
        }
      }
      console.log(`[TileServer] spawned ${layout.npcs.length} NPCs from tile_layout`);
    } else {
      this.spawnProceduralNpcs(content);
    }
  }

  /**
   * Procedurally scatter NPCs across the tile based on zone spawn profiles.
   * Used when no tile_layout.json is present.
   *
   * Density: on average 0.4 NPC spawns per zone cell.  Water / Shore cells
   * are skipped.  The RNG is seeded from the tile seed so results are stable
   * across server restarts.
   */
  private spawnProceduralNpcs(content: ContentStore): void {
    if (!this.zoneGrid) return;

    const grid = this.zoneGrid;
    const cellWorldSize = 512 / grid.gridSize; // world-units per zone cell side
    const NPC_DENSITY = 0.06; // expected spawns per zone cell (~60 total)
    const MARGIN = 1.5; // world-units away from cell edges
    const rng = mulberry32(this.tileSeed ^ 0xdeadbeef);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const profile = ZONE_PROFILES[cell.zoneType];
        const totalWeight = Object.values(profile.npcWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        // Poisson-approximate: integer part always spawns; fractional part spawns with that probability
        const spawns = Math.floor(NPC_DENSITY) + (rng() < NPC_DENSITY % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const npcType = weightedPick(profile.npcWeights, rng);
          if (!npcType) continue;
          const template = content.getNpcTemplate(npcType);
          if (!template) continue;
          spawnNpc(this.world, {
            x: wx, y: wy,
            npcType,
            name: template.displayName,
            maxHealth: template.maxHealth,
            modelId: template.modelTemplateId,
            speedMultiplier: template.speedMultiplier,
            weaponItemType: template.weaponItemType ?? null,
            skillLoadout: template.skillLoadout,
          });
          total++;
        }
      }
    }

    console.log(`[TileServer] procedurally spawned ${total} NPCs from zone grid`);
  }

  /**
   * Procedurally scatter resource nodes across the tile based on zone spawn profiles.
   * Used when no tile_layout.json is present.
   *
   * Density: on average 1.5 node spawns per zone cell.  Water cells are skipped.
   */
  private spawnProceduralNodes(content: ContentStore): void {
    if (!this.zoneGrid) return;

    const CHUNK_CELLS = 32;
    const heightChunks = new Map<string, Float32Array>();
    for (const { heightmap } of this.world.query(Heightmap)) {
      heightChunks.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap.data);
    }
    const getTerrainZ = (wx: number, wy: number): number => {
      const cx = Math.floor(wx / CHUNK_CELLS);
      const cy = Math.floor(wy / CHUNK_CELLS);
      const data = heightChunks.get(`${cx},${cy}`);
      if (!data) return 4.0;
      const lx = Math.min(CHUNK_CELLS - 1, Math.floor(wx) - cx * CHUNK_CELLS);
      const ly = Math.min(CHUNK_CELLS - 1, Math.floor(wy) - cy * CHUNK_CELLS);
      return data[lx + ly * CHUNK_CELLS];
    };

    const grid = this.zoneGrid;
    const cellWorldSize = 512 / grid.gridSize;
    const NODE_DENSITY = 0.5;
    const MARGIN = 1.0;
    const rng = mulberry32(this.tileSeed ^ 0xcafebabe);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const profile = ZONE_PROFILES[cell.zoneType];
        const totalWeight = Object.values(profile.nodeWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        const spawns = Math.floor(NODE_DENSITY) + (rng() < NODE_DENSITY % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const nodeTypeId = weightedPick(profile.nodeWeights, rng);
          if (!nodeTypeId) continue;
          const template = content.getNodeTemplate(nodeTypeId);
          if (!template) continue;
          spawnNode(this.world, { x: wx, y: wy, z: getTerrainZ(wx, wy), template });
          total++;
        }
      }
    }

    console.log(`[TileServer] procedurally spawned ${total} resource nodes from zone grid`);
  }

  private spawnProceduralProps(content: ContentStore): void {
    if (!this.zoneGrid) return;
    void content;

    // Build terrain height lookup from chunk entities (32×32 cells per chunk).
    const CHUNK_CELLS = 32;
    const heightChunks = new Map<string, Float32Array>();
    for (const { heightmap } of this.world.query(Heightmap)) {
      heightChunks.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap.data);
    }
    const getTerrainZ = (wx: number, wy: number): number => {
      const cx = Math.floor(wx / CHUNK_CELLS);
      const cy = Math.floor(wy / CHUNK_CELLS);
      const data = heightChunks.get(`${cx},${cy}`);
      if (!data) return 4.0;
      const lx = Math.min(CHUNK_CELLS - 1, Math.floor(wx) - cx * CHUNK_CELLS);
      const ly = Math.min(CHUNK_CELLS - 1, Math.floor(wy) - cy * CHUNK_CELLS);
      return data[lx + ly * CHUNK_CELLS];
    };

    const grid = this.zoneGrid;
    const cellWorldSize = 512 / grid.gridSize;
    const PROP_DENSITY = 1.5; // expected props per zone cell (~1500 total)
    const MARGIN = 2.0;
    const rng = mulberry32(this.tileSeed ^ 0xf00dcafe);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const profile = ZONE_PROFILES[cell.zoneType];
        const totalWeight = Object.values(profile.propWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        const spawns = Math.floor(PROP_DENSITY) + (rng() < PROP_DENSITY % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const modelId = weightedPick(profile.propWeights, rng);
          if (!modelId) continue;
          const isBuilding = modelId.includes("building");
          const propSeed = (Math.imul(wx * 100 | 0, 0x45d9f3b) ^ Math.imul(wy * 100 | 0, 0x119de1f3)) >>> 0;
          spawnProp(this.world, {
            x: wx, y: wy, z: getTerrainZ(wx, wy),
            modelId, scale: isBuilding ? 0.5 : 0.35, seed: propSeed,
          });
          total++;
        }
      }
    }

    console.log(`[TileServer] procedurally spawned ${total} props from zone grid`);
  }

  private encodeJsonMessage(value: unknown): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    const out = new Uint8Array(4 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, payload.byteLength, true);
    out.set(payload, 4);
    return out;
  }

  private async readJsonMessage(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<unknown | null> {
    const headerResult = await this.readExact(reader, 4);
    if (!headerResult) return null;
    const len = new DataView(headerResult.data.buffer).getUint32(0, true);
    const payloadResult = await this.readExact(reader, len, headerResult.overflow ?? undefined);
    if (!payloadResult) return null;
    return JSON.parse(new TextDecoder().decode(payloadResult.data));
  }

  private async readExact(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    n: number,
    overflow?: Uint8Array,
  ): Promise<{ data: Uint8Array; overflow: Uint8Array | null } | null> {
    const buf = new Uint8Array(n);
    let offset = 0;
    let leftover: Uint8Array | null = overflow ?? null;

    if (leftover) {
      const take = Math.min(leftover.byteLength, n);
      buf.set(leftover.subarray(0, take), 0);
      offset = take;
      leftover = leftover.byteLength > take ? leftover.subarray(take) : null;
    }

    while (offset < n) {
      const { value, done } = await reader.read();
      if (done || !value) return null;
      const take = Math.min(value.byteLength, n - offset);
      buf.set(value.subarray(0, take), offset);
      offset += take;
      if (value.byteLength > take) leftover = value.subarray(take);
    }
    return { data: buf, overflow: leftover };
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

    const joinMsg = await this.readJsonMessage(jReader) as TileJoinRequest | null;
    jReader.releaseLock();

    // Determine playerId: reuse existing entity (post-handoff) or spawn fresh
    let playerId: EntityId;
    let dynastyId: EntityId;

    const requestedId = joinMsg?.playerId as EntityId | undefined;
    if (requestedId && this.world.isAlive(requestedId)) {
      // Entity was pre-created by restorePlayer() — reuse it
      playerId = requestedId;
      dynastyId = this.playerDynasties.get(playerId) ?? newEntityId();
      this.playerDynasties.set(playerId, dynastyId);
      console.log(`[TileServer] player ${playerId} rejoining (post-handoff)`);
    } else {
      dynastyId = newEntityId();
      const spawn = this.content.getGameConfig().player;
      playerId = spawnPlayer(this.world, { x: spawn.defaultSpawnX, y: spawn.defaultSpawnY, dynastyId, heritageStore: this.heritageStore });
      this.playerDynasties.set(playerId, dynastyId);
    }

    // Send ack with canonical playerId
    const ack: TileJoinAck = { type: "joined", playerId };
    await jWriter.write(this.encodeJsonMessage(ack));
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

    console.log(
      `[TileServer] player ${playerId} connected (dynasty ${dynastyId}, ` +
        `gen ${this.heritageStore.get(dynastyId).generation})`,
    );

    // Input receiver runs concurrently — returns when the session closes
    await clientSession.receiveInputs(session);

    // Session ended — record heritage if the player died (entity already destroyed by combat)
    clientSession.close();
    this.sessions.delete(playerId);
    if (this.world.isAlive(playerId)) {
      // Clean disconnect — entity still alive, destroy it
      this.world.destroy(playerId);
    } else {
      // Entity was destroyed by combat — record the death in heritage
      this.heritageStore.recordDeath(dynastyId, 0);
    }
    this.playerDynasties.delete(playerId);
    console.log(`[TileServer] player ${playerId} disconnected`);
  }
}

// ── Debug client page ─────────────────────────────────────────────────────────

function debugClientHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voxim Debug Client</title>
<style>
  body { font: 13px/1.4 monospace; background:#111; color:#ccc; margin:0; padding:12px; }
  h1   { font-size:14px; color:#8cf; margin:0 0 8px; }
  #controls { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  button { font:inherit; padding:3px 10px; cursor:pointer; }
  #status { color:#8c8; font-size:12px; }
  #log { width:100%; height:calc(100vh - 90px); box-sizing:border-box;
         background:#0a0a0a; color:#bfb; border:1px solid #333;
         padding:6px; overflow-y:scroll; white-space:pre; font-size:12px; }
</style>
</head>
<body>
<h1>Voxim Debug Client</h1>
<div id="controls">
  <button id="btn" onclick="toggle()">Connect</button>
  <span id="status">disconnected</span>
</div>
<div id="log"></div>
<script>
let transport, inputTimer, connected = false;

function log(line) {
  const el = document.getElementById('log');
  el.textContent += line + '\\n';
  el.scrollTop = el.scrollHeight;
  console.log(line);
}

function status(msg, color) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = color ?? '#8c8';
}

function toggle() {
  connected ? disconnect() : connect();
}

async function connect() {
  document.getElementById('btn').textContent = 'Disconnect';
  status('connecting…', '#fc8');

  const { sha256 } = await fetch('/cert-hash').then(r => r.json());
  const hashBytes = Uint8Array.from(sha256.match(/../g).map(h => parseInt(h, 16)));

  transport = new WebTransport('https://' + location.hostname + ':4434', {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }],
  });
  await transport.ready;
  status('connected — joining…', '#fc8');
  log('[' + ts() + '] transport open');

  // join handshake
  log('[' + ts() + '] opening bidi stream…');
  const { readable: jr, writable: jw } = await transport.createBidirectionalStream();
  log('[' + ts() + '] bidi stream open, sending join…');
  const jWriter = jw.getWriter(), jReader = jr.getReader();
  await jWriter.write(encMsg({ type: 'join' }));
  await jWriter.close();
  log('[' + ts() + '] join sent, awaiting ack…');
  const jRead = makeExactReader(jReader);
  const ack = await readMsg(jRead);
  jReader.releaseLock();

  if (!ack || ack.type !== 'joined') { log('join rejected: ' + JSON.stringify(ack)); disconnect(); return; }
  const playerId = ack.playerId;
  status('connected as ' + playerId.slice(-8));
  log('[' + ts() + '] joined as ' + playerId);
  connected = true;

  // input heartbeat 20Hz
  let seq = 0, tick = 0;
  const dgWriter = transport.datagrams.writable.getWriter();
  inputTimer = setInterval(() => {
    const b = new ArrayBuffer(36), v = new DataView(b);
    v.setUint32(0, seq++, true); v.setUint32(4, tick, true);
    v.setFloat64(8, Date.now(), true);
    dgWriter.write(new Uint8Array(b)).catch(() => clearInterval(inputTimer));
  }, 50);

  // state stream
  const uniRdr = transport.incomingUnidirectionalStreams.getReader();
  const { value: stateStream } = await uniRdr.read();
  uniRdr.releaseLock();
  const stateRdr = stateStream.getReader();
  const stateRead = makeExactReader(stateRdr);

  let lastPrint = -1;
  while (true) {
    const hdr = await stateRead(4); if (!hdr) break;
    const len = new DataView(hdr.buffer).getUint32(0, true);
    const payload = await stateRead(len); if (!payload) break;
    const msg = JSON.parse(new TextDecoder().decode(payload), (_k, v) =>
      (v && typeof v === 'object' && v.__t === 'u8')
        ? Uint8Array.from(atob(v.b), c => c.charCodeAt(0)) : v);
    tick = msg.serverTick;
    if (msg.serverTick - lastPrint >= 20) {
      lastPrint = msg.serverTick;
      const counts = {};
      for (const d of msg.entityDeltas) counts[d.componentName] = (counts[d.componentName] ?? 0) + 1;
      const dStr = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,n])=>k+'×'+n).join(', ');
      log('[' + ts() + '] tick ' + String(msg.serverTick).padStart(6) +
          ' | deltas=' + msg.entityDeltas.length + (dStr ? ' [' + dStr + ']' : '') +
          ' | events=' + msg.events.length);
      for (const ev of msg.events) log('  event: ' + JSON.stringify(ev));
    }
  }
  disconnect();
}

function disconnect() {
  connected = false;
  clearInterval(inputTimer);
  try { transport?.close(); } catch(_){}
  status('disconnected', '#c88');
  document.getElementById('btn').textContent = 'Connect';
  log('[' + ts() + '] disconnected');
}

// ── wire helpers ──
function encMsg(v) {
  const p = new TextEncoder().encode(JSON.stringify(v));
  const out = new Uint8Array(4 + p.byteLength);
  new DataView(out.buffer).setUint32(0, p.byteLength, true);
  out.set(p, 4); return out;
}
// Returns a readExact function that preserves leftover bytes across calls.
// Each reader must get its own instance to avoid cross-stream contamination.
function makeExactReader(rdr) {
  let overflow = null;
  return async function readExact(n) {
    const buf = new Uint8Array(n); let off = 0;
    if (overflow) {
      const take = Math.min(overflow.byteLength, n);
      buf.set(overflow.subarray(0, take), 0); off = take;
      overflow = overflow.byteLength > take ? overflow.subarray(take) : null;
    }
    while (off < n) {
      const { value, done } = await rdr.read();
      if (done || !value) return null;
      const take = Math.min(value.byteLength, n - off);
      buf.set(value.subarray(0, take), off); off += take;
      if (value.byteLength > take) overflow = value.subarray(take);
    }
    return buf;
  };
}
async function readMsg(readExact) {
  const h = await readExact(4); if (!h) return null;
  const len = new DataView(h.buffer).getUint32(0, true);
  const p = await readExact(len); if (!p) return null;
  return JSON.parse(new TextDecoder().decode(p));
}
function ts() { return new Date().toISOString().slice(11, 23); }
</script>
</body>
</html>`;
}

