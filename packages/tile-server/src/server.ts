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
import type { EntityId, ChangesetSet, ChangesetRemoval } from "@voxim/engine";
import type { AtlasTileInitRepo, AtlasWorldRepo, TileSaveRepo, WorldsRepo } from "@voxim/db";
import { spawnGates } from "./gate.ts";
import { applyFieldsToChunks, chunksFromBuffers, TILE_SIZE } from "@voxim/world";
import { loadTerrainFromAtlas } from "./atlas_terrain.ts";
import { placePois, spawnMobPois } from "./poi_placer.ts";
import { binaryStateMessageCodec, ACTION_BLOCK, ACTION_CROUCH, encodeFrame, makeFrameReader } from "@voxim/protocol";
import { startAdminServer, registerWithGateway } from "./admin_server.ts";
import { listenQuic } from "./quic_server.ts";
import { GatewayLink } from "./gateway_link.ts";
import { CommandType } from "@voxim/protocol";
import type { BinaryComponentDelta, BootstrapHeader, CommandPayload, TileJoinRequest, TileJoinAck, WorldSnapshot } from "@voxim/protocol";
import { computeAoiSharedInputs, computeSessionUpdate } from "./aoi.ts";
import { JsonSource, validateRecipeGraph, encodeBootstrap, type ContentService } from "@voxim/content";
import { ClientSession } from "./session.ts";
import { sanitizeAndMergeInputs } from "./input_merge.ts";
import { TickLoop } from "./tick_loop.ts";
import { DeferredEventQueue } from "./deferred_events.ts";
import { StateHistoryBuffer } from "./state_history.ts";
import { AccountClient } from "./account_client.ts";
import type { SessionInfo } from "./account_client.ts";
import { resolveHeirSpawn } from "./heir_spawn.ts";
import { spawnPrefab } from "./spawner.ts";
import { teardownPlayer } from "./session_teardown.ts";
import { resolveCharacterSelections, type ResolvedCharacter } from "./character_creation.ts";
import { validatePrefabs } from "./prefab_validator.ts";
import type { System } from "./system.ts";
import { Position, Velocity, Facing, InputState, Name } from "./components/game.ts";
import { Heritage } from "./components/heritage.ts";
import { Hitbox } from "./components/hitbox.ts";
import { FogState } from "./components/fog_state.ts";
import { placePoiTriggers } from "./poi_spawner.ts";
import { placeStairs } from "./stair_spawner.ts";
import { WorldClock } from "./components/world.ts";
import { SaveManager } from "./save_manager.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { ProceduralSpawner } from "./procedural_spawner.ts";
import { EventRouter } from "./event_router.ts";
import type { TickContext } from "./system.ts";
import { wireGameSystems } from "./wiring.ts";
import { HandoffCoordinator, type ZoneMeta } from "./handoff_coordinator.ts";

// Action bits that represent *held* keys (block, crouch) — merged
// latest-wins across a tick rather than OR-accumulated like one-shots.
//
// ACTION_USE_SKILL deliberately does NOT join this mask, even though T-337's
// hold-to-aim mechanic also reads it as a held signal (IntentTranslator.
// isAiming, gated on aimWeaponActive) while charging. Reasoning: melee's
// existing tap-on-release semantics NEED the OR-across-batch treatment (a
// brief click within one server tick must never be missed just because a
// later datagram in the same batch — e.g. a subsequent mouse-move — doesn't
// carry the bit); moving ACTION_USE_SKILL to latest-only would risk
// silently dropping that click. The cost of leaving it out: during a
// hold-to-aim release, the OR-across-batch merge can show the bit "still
// held" for one extra server tick if an earlier datagram in that tick's
// batch was sent before the release — a ~50ms release-detection fuzz, not a
// correctness bug (PrimaryIntentResolver still resolves to releaseActionId
// the very next tick once the batch is clean). Accepted trade: a harmless
// timing fuzz on release beats a real risk of dropping a melee tap.
const HELD_ACTION_MASK = ACTION_BLOCK | ACTION_CROUCH;

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
   * Postgres-backed tile save repo. When set, the server loads an existing
   * snapshot on startup (skipping terrain generation) and auto-saves every
   * `persistence.saveIntervalTicks` ticks. Omit to run in ephemeral mode
   * (no persistence — fine for short-lived dev sessions).
   */
  tileSaves?: TileSaveRepo;
  /**
   * Worlds repo. Required: tile-server resolves the active world (latest
   * baked_at) at boot and uses its uuid to scope tile_init lookups + saves.
   */
  worlds: WorldsRepo;
  /**
   * Atlas worldmap repo. Read-only here — used to fetch the active world's
   * cell metadata (gates) so gate entities can be spawned.
   */
  atlasCells: AtlasWorldRepo;
  /**
   * Atlas tile_init repo. Required: tile-server reads its terrain from
   * atlas's pre-computed TileInit row for the active world.
   */
  atlasTiles: AtlasTileInitRepo;
  /**
   * Plain HTTP port for gateway → tile internal communication (handoff, health-check).
   * When set, starts a plain HTTP admin server on this port.
   */
  adminPort?: number;
  /**
   * Hostname the gateway should reach this tile's admin port at. In docker
   * compose this is the service name (matches the container hostname); in
   * single-process dev it's "localhost". The tile self-registers
   * `http://<adminHost>:<adminPort>` with the gateway.
   */
  adminHost?: string;
  // (terrainCacheFile retired — atlas owns generation now; tile-server fetches.)
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
   * Gateway WebTransport URL, e.g. "https://gateway:8080". Used for the
   * privileged event/command stream (T-139). When omitted, the tile runs
   * without an event channel — it still serves players, but cross-tile
   * coordination is disabled.
   */
  gatewayWtUrl?: string;
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
  private content!: ContentService;
  /**
   * Pre-encoded content bootstrap blob (T-177). Built once at startup, sent
   * to every joining client after TileJoinAck. Lets the client construct a
   * full local ContentService without round-trips for individual lookups,
   * and guarantees the client's content matches THIS tile-server's exactly
   * — reconnect after a server restart picks up content changes
   * automatically.
   */
  private contentBlob!: Uint8Array;
  // Initialised in start() — subscribes to the event bus and drained each tick.
  private events!: EventRouter;
  // Initialised in start() (post-atlas-load) — gate proximity, zone
  // transitions, cross-tile handoff, and the per-player handoff/zone/hearth
  // caches (T-352).
  private handoffCoordinator!: HandoffCoordinator;

  // Initialised in start() via wireGameSystems() (T-352).
  private systems: System[] = [];

  private saveManager: SaveManager | null = null;
  private saveTickCounter = 0;
  private gatewayUrl: string | null = null;
  /** Shared secret presented to the gateway's control-plane endpoints (T-258). */
  private serviceSecret = "";
  /** Privileged WT link to the gateway for world events / tile commands. */
  private gatewayLink: GatewayLink | null = null;
  /**
   * Per-tile gate-summary u16 captured from atlas at boot, recomputed
   * by the runtime edit loop in phase 6D, and pushed to coordinator
   * whenever it changes. Tracks the last-pushed value so we only emit
   * deltas (no-op when nothing has changed).
   */
  private currentGateSummary = 0;
  private lastPushedGateSummary = -1;
  private cellX = 0;
  private cellY = 0;
  /**
   * Per-voxel zone id at TILE_SIZE² resolution (T-211). Source: atlas
   * `upsampleTile()`. Used by `ZoneTrackingSystem` to map player
   * position → zone for the "You are in:" HUD.
   */
  private zoneBuffer: Uint16Array | null = null;
  /** Zone metadata indexed by `zoneBuffer` ids. */
  private zoneById = new Map<number, ZoneMeta>();
  /**
   * Active world this tile-server is serving. Set on atlas terrain load;
   * the bake-poll loop watches `activeWorldBaked` to detect a newer bake
   * and triggers Deno.exit(0) so the process restarts and reloads.
   */
  private activeWorldId = "";
  private activeWorldBaked: Date = new Date(0);
  /** Display name per connected player — cached so a respawn (no join msg) keeps the name. */
  private playerDisplayNames = new Map<EntityId, string>();
  /**
   * Resolved character-creation selections per connected player (T-071) —
   * cached at join so a respawn (no join msg) keeps the chosen species + lore.
   */
  private playerCharacters = new Map<EntityId, ResolvedCharacter>();
  /** Players with a respawn in flight — guards the async recordDeath→spawn from re-entry. */
  private respawning = new Set<EntityId>();

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
    this.serviceSecret = config.serviceSecret ?? "";

    // Account service RPC — required in production, omitted in dev/demo. When
    // absent, join spawns anonymous characters and deaths/location updates
    // are silently dropped (intentional: single-tile dev builds should run
    // without a gateway at all).
    if (config.gatewayUrl && config.serviceSecret) {
      this.accountClient = new AccountClient(config.gatewayUrl, config.serviceSecret);
    }

    // Load all game content (recipes, prefabs, lore, materials) from data files.
    // Systems receive the store by injection — no hardcoded tables in game logic.
    this.content = await JsonSource.load(config.dataDir);
    const content = this.content;
    // Validate every prefab against the component registry + schemas + requires.
    // Fails fast on malformed content so a booted server is known-good.
    validatePrefabs(content);
    // Walk every recipe's stat formulas and prove every variable reference
    // resolves to a producer (raw-material default OR an upstream recipe
    // formula). Surfaces NaN-bow-class bugs at boot, not at first craft.
    validateRecipeGraph(content);
    // Pre-encode the bootstrap blob once — every joining client gets a copy
    // after TileJoinAck. Encoding here means a single allocation per server
    // process; the same Uint8Array reference is sent to every session.
    this.contentBlob = await encodeBootstrap(content);
    console.log(`[TileServer] content bootstrap blob: ${(this.contentBlob.length / 1024).toFixed(1)} KB (gzipped)`);

    // Registry composition root (T-352): every content-driven registry,
    // register() call, boot fail-fast content cross-check, EventBus
    // subscriber, and the dependency-sorted system list live in wiring.ts —
    // invoked at the exact point in boot the inline block occupied.
    this.systems = wireGameSystems({
      content,
      world: this.world,
      eventBus: this.eventBus,
      stateHistory: this.stateHistory,
      tickRateHz,
      devMode: config.devMode ?? false,
      tileId: config.tileId,
      accountClient: this.accountClient,
      getZoneBuffer: () => this.zoneBuffer,
      getSessionPlayerIds: () => this.sessions.keys(),
      onHearthAnchorUpdate: (placerId, anchor) => this.handoffCoordinator.setHearthAnchor(placerId, anchor),
    });

    // Atlas is the source of truth for initial terrain, the gate-summary
    // we publish to coordinator, AND the gate positions (cell metadata).
    // Always fetched — chunks only get applied when no save exists (save-
    // loaded tiles already have their chunks), but summary + coords + gates
    // come from atlas regardless so the world graph and gate entities are
    // consistent across restarts.
    const atlas = await loadTerrainFromAtlas(
      config.worlds,
      config.atlasCells,
      config.atlasTiles,
      config.tileId,
      content,
    );
    this.currentGateSummary = atlas.gateSummary;
    this.cellX = atlas.cellX;
    this.cellY = atlas.cellY;
    this.activeWorldId    = atlas.world.id;
    this.activeWorldBaked = atlas.world.bakedAt;
    // T-211: keep region data warm for the per-player zone tracker.
    // `zoneBuffer` is the per-pixel index; `zoneById` resolves a pixel's
    // region from `LevelDef.regions[]`.
    this.zoneBuffer = atlas.zoneBuffer;
    this.zoneById.clear();
    for (const r of atlas.level.regions) {
      this.zoneById.set(r.zoneId, {
        id: r.zoneId,
        name: r.name,
        topologyRole: r.kind === "river" ? "river" : r.topologyRole,
        traversal: r.kind === "plateau" ? "wilderness" : "path",
      });
    }
    const plateauCount = atlas.level.regions.filter(r => r.kind === "plateau").length;
    console.log(
      `[TileServer] level: ${atlas.level.regions.length} regions loaded ` +
      `(${plateauCount} plateau)`,
    );

    // T-212: place a runtime PoiTrigger at every LevelDef POI's host
    // region centroid. PoiSystem picks these up tick-wise and fires the
    // encounter/exploration/etc. activity on first player proximity.
    // Atlas centroids are in gridSize coords; placePoiTriggers scales
    // to tile-server's TILE_SIZE world-unit space.
    if (atlas.level.narrative.pois.length) {
      placePoiTriggers(this.world, atlas.level, content, TILE_SIZE);
    }
    // T-213 v2: spawn a visible stair prop at every LevelDef stair edge.
    // The heightmap ramp + marker patch are already applied by
    // loadTerrainFromAtlas; this gives the player something to actually see
    // standing at the path/wilderness boundary.
    if (atlas.level.edges.stairs.length) {
      placeStairs(
        this.world, content, atlas.level, atlas.heightBuffer, TILE_SIZE, atlas.wallHeight,
      );
    }
    console.log(
      `[TileServer] active world ${atlas.world.name} (${atlas.world.id.slice(0, 8)}…) ` +
      `${atlas.world.width}×${atlas.world.height} baked ${atlas.world.bakedAt.toISOString()}`,
    );

    // Persistence is scoped per (world_id, tile_id) — switching worlds
    // (rebake) starts that world's tiles fresh.
    if (config.tileSaves) {
      this.saveManager = new SaveManager(config.tileSaves, content, atlas.world.id, config.tileId);
    }

    // Restart-on-bake: every 5s ask the worlds repo for the latest world.
    // If a newer bake exists than the one we loaded, exit and let docker
    // restart us with the new world. The tile_save row is keyed by
    // (world_id, tile_id) so we won't pick up a stale save against fresh
    // terrain — switching worlds implicitly starts the new world's tiles
    // fresh.
    setInterval(async () => {
      try {
        const w = await config.worlds.getLatest();
        if (!w) return;
        if (w.id !== this.activeWorldId
         || w.bakedAt.getTime() > this.activeWorldBaked.getTime()) {
          console.log(
            `[TileServer] new world detected (${w.id.slice(0, 8)}… baked ` +
            `${w.bakedAt.toISOString()}); restarting`,
          );
          Deno.exit(0);
        }
      } catch (err) {
        console.warn(`[TileServer] world poll failed: ${(err as Error).message}`);
      }
    }, 5000);

    const loaded = this.saveManager ? await this.saveManager.load(this.world) : false;
    const tileSeed = atlas.tileSeed;
    // POIs (T-160): mob list filled before chunks commit; room-POI walls
    // get stamped into the buffers in place by `placePois`.  Always re-derived
    // from `(tileSeed, chamber.id)` so the layout is stable across restarts;
    // mob NPCs are not persisted (consistent with `procedural.spawnInitialNpcs`).
    let mobSpawns: ReturnType<typeof placePois> = [];
    if (!loaded) {
      console.log(
        `[TileServer] atlas terrain loaded: cell (${atlas.cellX},${atlas.cellY}) seed=${atlas.tileSeed}`,
      );
      const woodMat = content.materials.get("wood");
      if (!woodMat) throw new Error("POI placer: missing 'wood' content material");
      mobSpawns = placePois(
        atlas.heightBuffer,
        atlas.openBuffer,
        atlas.kindBuffer,
        atlas.materialBuffer,
        atlas.fields,
        atlas.chambers,
        tileSeed,
        woodMat.id,
        atlas.wallHeight,
      );
      chunksFromBuffers(
        this.world,
        atlas.heightBuffer,
        atlas.materialBuffer,
        atlas.openBuffer,
        atlas.kindBuffer,
        atlas.fields, // T-311 P3 render-field planes → VegFieldGrid/SurfaceStateGrid/WaterGrid
        atlas.cliff,  // T-311 P6 cliff planes → CliffGrid
      );
      this.spawnWorldState(content, atlas.biomeTag);

      // Boundary decoration (forest trees, stone debris, …) is purely
      // visual and lives client-side now: KindGrid is networked so the
      // client decorates closed pixels itself. Server keeps no per-tree
      // entities — collision is handled by OpenMask in stepPhysics.
    } else {
      // Save-loaded chunks carry only Heightmap/MaterialGrid/OpenMask/KindGrid
      // (save_manager's CHUNK_DEFS). The render-field grids are deterministic
      // atlas output, deliberately excluded from the save, so overlay them onto
      // the loaded chunks now — else scatter/moss/wetness see neutral fields
      // until the next from-scratch gen (T-312b).
      applyFieldsToChunks(this.world, atlas.fields, atlas.cliff);
      // T-311 P5a: same bucket as the fields overlay above — biomeTag is
      // atlas-derived, not gameplay state, so always refresh it from this
      // boot's atlas classification (also self-heals old saves whose
      // WorldClock predates the biomeTag field).
      this.refreshWorldClockBiomeTag(atlas.biomeTag);
    }

    const procedural = new ProceduralSpawner(this.world, content, tileSeed);
    if (!loaded) procedural.spawnInitialEntities();
    // NPCs are always re-spawned from layout (not persisted across restarts).
    procedural.spawnInitialNpcs();

    // Mob POIs run AFTER procedural NPCs / props so they ride on top of the
    // base population.  Skipped on loaded saves — mob entities aren't
    // persisted, so re-running placePois every boot would double-spawn.
    if (!loaded && mobSpawns.length > 0) {
      spawnMobPois(this.world, content, mobSpawns);
    }

    // Gate entities — always re-spawned from atlas's cell metadata, never
    // persisted. Cheap to recreate and atlas is the source of truth for
    // where gates belong.
    if (atlas.gatePositions.length > 0) {
      const gateIds = spawnGates(this.world, atlas.gatePositions);
      if (gateIds.length > 0) {
        console.log(`[TileServer] spawned ${gateIds.length} gates`);
      }
    }

    // Handoff/gate/zone coordinator (T-352). Constructed after atlas load so
    // zoneBuffer/zoneById are final; gatewayUrl/gatewayLink are assigned by
    // the self-registration blocks below and `events` on the very next line,
    // so those three are lazy getters — nothing invokes the coordinator
    // before the tick loop starts.
    this.handoffCoordinator = new HandoffCoordinator({
      world: this.world,
      eventBus: this.eventBus,
      sessions: this.sessions,
      tickLoop: this.tickLoop,
      tileId: config.tileId,
      serviceSecret: this.serviceSecret,
      zoneBuffer: this.zoneBuffer,
      zoneById: this.zoneById,
      getGatewayUrl: () => this.gatewayUrl,
      getGatewayLink: () => this.gatewayLink,
      getEvents: () => this.events,
      teardownSession: (playerId, opts) => this.teardownSession(playerId, opts),
    });

    // Subscribe to tile events that need to reach clients as GameEvents.
    // The router is responsible for translation; the handoff side-effect
    // lives on the coordinator.
    this.events = new EventRouter(this.eventBus, (p) => this.handoffCoordinator.initiateHandoff(p));

    // Start the WebTransport QUIC server (Deno.QuicEndpoint, requires --unstable-net)
    listenQuic(config, (session) => this.handleSession(session));

    // Start admin HTTP server for gateway → tile internal messages (handoff)
    if (config.adminPort) {
      startAdminServer(config.adminPort, {
        world: this.world,
        content,
        // Control-plane endpoints (/handoff, /jobs, /assign-job-board) require
        // this secret (T-258). Empty when running without a gateway → those
        // endpoints fail closed; players are unaffected (they use WebTransport).
        serviceSecret: config.serviceSecret ?? "",
        getCertHashHex: () => this.certHashHex,
        getWtPort: () => this.wtPort,
        // Gates /debug/save-action (T-327) — same devMode flag DebugCommandSystem
        // uses, so the save-back endpoint is dev-only symmetrically with the
        // live-tuning commands that feed it.
        devMode: config.devMode ?? false,
      });
    }

    // Self-register with gateway so clients can be routed here
    if (config.gatewayUrl && config.tileAddress && config.adminPort) {
      this.gatewayUrl = config.gatewayUrl;
      const adminHost = config.adminHost ?? "localhost";
      const adminUrl = `http://${adminHost}:${config.adminPort}`;
      console.log(`[TileServer] self-registering with gateway: adminUrl=${adminUrl}`);
      registerWithGateway(config.gatewayUrl, config.tileId, config.tileAddress, adminUrl, this.serviceSecret);
    }

    // Privileged WT event/command link to gateway (T-139). Independent of
    // the HTTP register/heartbeat path above — registry is the source of
    // truth for liveness; this stream is the message channel.
    if (config.gatewayWtUrl && config.serviceSecret) {
      const link = new GatewayLink({
        url: config.gatewayWtUrl,
        tileId: config.tileId,
        serviceSecret: config.serviceSecret,
        gatewayCertHashHex: this.certHashHex,
        onCommand: (cmd) => {
          // Real handlers land in T-140 (gate handoff orchestration) and
          // T-148 (caravan dispatch). For now we log so the dev loop is
          // observable when coordinator emits commands.
          console.log(`[TileServer] received tile_command kind=${cmd.command.kind}`, cmd.command);
        },
      });
      link.start();
      this.gatewayLink = link;

      // The link establishes asynchronously, so the first publish call
      // here would be a no-op (writer not yet ready). Retry on a short
      // interval until lastPushedGateSummary tracks currentGateSummary;
      // after that the interval is a delta-only no-op (cheap). Phase 6D's
      // runtime edit loop will set currentGateSummary directly + this
      // interval picks the change up at most ~1s later.
      setInterval(() => this.maybePushSummary(config.tileId), 1000);

      // Until concrete events land (T-140+), publish a periodic "tile_alive"
      // ping every 30s so the coordinator's log shows the channel is wired.
      // Removed in T-140 once real GateApproached events take over.
      setInterval(() => {
        link.publish({
          type: "world_event",
          sourceTileId: config.tileId,
          event: { kind: "tile_alive", at: Date.now() },
        }).catch(() => {/* publish is best-effort */});
      }, 30_000);
    }

    this.tickLoop.start((dt, tick) => this.runTick(dt, tick), { tickRateHz });

    console.log(
      `[TileServer] ${config.tileId} listening on port ${config.port} at ${tickRateHz}Hz`,
      `| ${content.recipes.size} recipes,`,
      `${content.npcTemplates.size} NPC types,`,
      `${content.prefabs.size} prefabs,`,
      `${content.loreFragments.size} lore fragments,`,
      `${[...content.triggers.ids()].length} triggers loaded`,
    );
  }

  async stop(): Promise<void> {
    this.tickLoop.stop();
    for (const session of this.sessions.values()) {
      session.close();
    }
    if (this.gatewayLink) {
      await this.gatewayLink.stop();
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

      // T-361: an in-flight handoff already serialized this player — the
      // destination restores THAT snapshot, so nothing they do here may land
      // (a drop would duplicate the item across tiles; a pickup would be
      // destroyed at the source yet missing from the payload). Discard, don't
      // queue: on success the session closes anyway, on failure play resumes
      // from live input next tick. InputState was neutralised at initiation,
      // so no stale held-movement replays during the freeze either.
      if (this.handoffCoordinator.isHandingOff(playerId)) {
        session.inputBuffer.drain();
        session.commandQueue.length = 0;
        continue;
      }

      // Drain movement datagrams into InputState — sanitized and merged
      // (T-253): non-finite fields zeroed, stale/replayed seqs discarded,
      // "latest" chosen by seq (datagrams are unordered), one-shot bits
      // OR'd, held bits from the latest frame.
      const inputs = session.inputBuffer.drain();
      const merged = sanitizeAndMergeInputs(inputs, session.lastAppliedSeq, HELD_ACTION_MASK);
      if (merged) {
        const { latest, mergedActions } = merged;
        session.lastAppliedSeq = latest.seq;

        // Update per-session RTT EMA from the latest datagram's client
        // timestamp — clamped (T-253): the timestamp is client-supplied.
        if (latest.timestamp > 0) {
          const net = this.content.getGameConfig().network;
          const sampleMs = Math.max(0, Date.now() - latest.timestamp);
          session.updateRtt(sampleMs, net.rttEmaAlpha, net.rttMaxMs);
        }

        this.world.write(playerId, InputState, {
          facing: latest.facing,
          pitch: latest.pitch,
          movementX: latest.movementX,
          movementY: latest.movementY,
          actions: mergedActions,
          chargeMs: latest.chargeMs,
          seq: latest.seq,
          timestamp: latest.timestamp,
          rttMs: session.rttMs,
        });
      }

      // Drain command queue into pendingCommands map. Respawn (T-270) isn't a
      // system command — fire the async re-spawn here and keep it out of the
      // per-system list.
      if (session.commandQueue.length > 0) {
        const cmds = session.commandQueue.splice(0);
        const gameplay = cmds.filter((c) => {
          if (c.cmd === CommandType.Respawn) { void this.respawnPlayer(playerId); return false; }
          return true;
        });
        if (gameplay.length > 0) pendingCommands.set(playerId, gameplay);
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

    // Re-index the spatial grid on the COMMITTED world (T-343).
    //
    // The rebuild in step 2 reflects last tick's state — which is right for the
    // systems, who must all see one consistent snapshot. But AoI (step 6) reads
    // this same grid, and an entity BORN during step 2 (a projectile, a dropped
    // item, a spawned NPC) is not in it. So on its first tick it is replicated to
    // nobody.
    //
    // For a projectile that is not a rounding error, it is the whole feature: a
    // bow arrow lives ~3 ticks, so a third of its flight is never sent, and it
    // appears to the client already downrange. Anything faster — dying inside one
    // tick — is NEVER rendered at all, while the server happily reports the hit.
    // That is exactly what "the arrow doesn't show up but the damage lands" looks
    // like, and it would have been chased as a render bug forever.
    //
    // O(entities with Position) and allocation-free, so a second pass is cheap
    // next to shipping an invisible projectile.
    this.spatial.rebuild(this.world);

    // ── 4. FIRE EVENTS ──────────────────────────────────────────────────────
    // Subscribers see the already-committed world state.
    deferredEvents.flush(this.eventBus);

    // Gate proximity check (T-140) — runs after systems so positions are
    // committed. Publishes GateApproached for any player within a gate's
    // trigger radius; the EventRouter routes it to initiateHandoff.
    this.handoffCoordinator.checkGateProximity();

    // Zone transition check (T-211) — also after-systems / post-changeset.
    // Walks every active session, looks up the zone under the player's
    // current voxel, and fires ZoneEntered when it differs from the last
    // recorded zone for that player.
    this.handoffCoordinator.checkZoneTransitions();

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
      const removedComponents = this.buildRemovalMap(changeset.removals);
      const worldDestroys = new Set(changeset.destroys);
      const aoiRadius = this.content.getGameConfig().network.aoiRadius;
      // Session-independent AoI inputs (chunk ids, always-visible set, container
      // list) are computed once per tick, not once per session (T-355).
      const sharedAoi = computeAoiSharedInputs(this.world);
      for (const [playerId, session] of this.sessions) {
        if (!session.isOpen) { console.warn(`[TileServer] tick ${serverTick}: session ${playerId.slice(-8)} is closed, skipping`); continue; }
        const inputState = this.world.get(playerId, InputState);
        const ackInputSeq = inputState?.seq ?? 0;
        const msg = computeSessionUpdate(
          this.world, sharedAoi, session, this.spatial, playerId,
          changedComponents, removedComponents, worldDestroys, events, serverTick, ackInputSeq,
          aoiRadius, this.sessions.size,
        );
        const payload = binaryStateMessageCodec.encode(msg);
        session.sendStateRaw(encodeFrame(payload));
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
      snapEntities.push({
        entityId,
        x: position.x, y: position.y, z: position.z,
        facing: fac?.angle ?? 0,
        velocityX: vel?.x ?? 0, velocityY: vel?.y ?? 0, velocityZ: vel?.z ?? 0,
      });
    }
    this.stateHistory.push({ serverTick, timestamp: Date.now(), entities: snapEntities });

    // ── 7b. SEND UNRELIABLE SNAPSHOTS ───────────────────────────────────────
    // Each datagram must stay under the QUIC datagram MTU (~1200 bytes).
    // WorldSnapshot layout: 6-byte header + 44 bytes/entity → max 27 entities/datagram.
    // Paginate across multiple datagrams with the same serverTick.
    if (hasSessions) {
      const PAGE_SIZE = 27;
      // actions intentionally excluded from the wire snapshot — a remote
      // player's behaviour reaches clients as the networked AnimationState
      // (derived from their ActiveActions), never as raw input. InputState is
      // server-only (T-250): the client reconciles against `ackInputSeq`, not
      // an echoed input component. snapEntities keeps actions only for the
      // server-side StateHistoryBuffer (lag-compensated block detection).
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

    // Remove disconnected sessions — teardownSession (T-354) is the single
    // cleanup path shared with handleSession's end-of-session continuation.
    for (const [playerId, session] of this.sessions) {
      if (!session.isOpen) {
        // T-256: an in-flight handoff owns this entity's fate — don't destroy
        // it out from under the fetch (that ghosts it on the destination).
        // The handoff's success continuation runs teardownSession(handedOff)
        // itself; on failure this sweep picks the session up once the fetch
        // settles (bounded by its abort timeout) and clears handingOff.
        if (this.handoffCoordinator.isHandingOff(playerId)) continue;
        // Fire-and-forget — the tick loop must not block on the account
        // service's HTTP calls; the map deletes AND the entity destroy run
        // synchronously before teardownPlayer's first await.
        this.teardownSession(playerId).catch((err: unknown) => {
          console.error("[TileServer] teardownSession failed:", err);
        });
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

  /**
   * Map of entity → networked component wire-IDs removed this tick. The AoI
   * filter turns these into per-session removals for entities that REMAIN
   * known (a settled item shedding Velocity, a picked-up item shedding
   * Position). Server-only removals are dropped — the client never knew them.
   */
  private buildRemovalMap(removals: ReadonlyArray<ChangesetRemoval>): Map<EntityId, number[]> {
    const map = new Map<EntityId, number[]>();
    for (const entry of removals) {
      if (!entry.token.networked) continue;
      let list = map.get(entry.entityId);
      if (!list) { list = []; map.set(entry.entityId, list); }
      list.push(entry.token.wireId);
    }
    return map;
  }

  // ---- player spawn / respawn ----

  /**
   * Spawn a fresh player entity for `playerId` — the join-time spawn pipeline,
   * shared with respawn. Fetches heritage (the account service advances the
   * dynasty generation on death, so this returns the HEIR after a respawn),
   * spawns at the hearth when it's on this tile, writes the cached display
   * Name, and hydrates fog. Async (heritage + fog are HTTP).
   */
  private async spawnFreshPlayer(playerId: EntityId, hearthAnchor: SessionInfo["hearthAnchor"]): Promise<void> {
    const heritage = this.accountClient
      ? (await this.accountClient.getHeritage(playerId).catch((err: unknown) => {
          console.error("[TileServer] heritage fetch failed:", err);
          return null;
        })) ?? undefined
      : undefined;
    // T-079: resolve the heir's spawn from the hearth anchor + live world —
    // at the standing hearth, or displaced + weakened if it was destroyed.
    const heir = resolveHeirSpawn(this.world, this.content, hearthAnchor, this.tileId);
    if (heir.atHearth) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} spawning at hearth (%.1f, %.1f)`, heir.x, heir.y);
    } else if (heir.weakened) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} hearth destroyed → displaced + weakened spawn`);
    }
    // Character-creation choices (T-071) resolved + cached at join; the heir
    // on respawn inherits the same species + lore picks.
    const character = this.playerCharacters.get(playerId);
    spawnPrefab(this.world, this.content, "player", {
      id: playerId, x: heir.x, y: heir.y, z: heir.z, heritage,
      speciesId: character?.speciesId,
      initialFragmentIds: character?.fragmentIds,
      weakened: heir.weakened,
    });

    const displayName = this.playerDisplayNames.get(playerId) ?? `Player-${playerId.slice(0, 6)}`;
    this.world.write(playerId, Name, { value: displayName });

    // Fog of war (T-161): hydrate from the account service. Non-fatal;
    // pendingSnapshot stays true so the next state message ships the bitmap.
    await this.hydrateFog(playerId);
  }

  /**
   * Hydrate the player's FogState from the account service's per-(player,
   * tile) bitmap (T-161). OR-merges into whatever the live entity already
   * revealed (a handed-off entity stands in-world before its client joins,
   * so a few cells may be lit already) and forces `pendingSnapshot` so the
   * next state message ships the merged bitmap. Best-effort: no account
   * client / no stored row / length mismatch → no-op.
   */
  private async hydrateFog(playerId: EntityId): Promise<void> {
    if (!this.accountClient) return;
    const fogBitmap = await this.accountClient.getFog(playerId, this.tileId).catch((err: unknown) => {
      console.error("[TileServer] fog fetch failed:", err);
      return null;
    });
    if (!fogBitmap) return;
    const fog = this.world.get(playerId, FogState);
    if (!fog || fogBitmap.byteLength !== fog.seenEver.byteLength) return;
    for (let i = 0; i < fogBitmap.length; i++) fog.seenEver[i] |= fogBitmap[i];
    fog.pendingSnapshot = true;
    console.log(`[TileServer] fog restored for ${playerId.slice(0, 8)} on ${this.tileId}`);
  }

  /**
   * Respawn a dead player into their still-open session (T-270). Records the
   * death — the gateway advances the dynasty generation, so the heritage fetch
   * in spawnFreshPlayer returns the HEIR — then spawns. Async + re-entry-guarded;
   * a no-op if the player is already alive or the session is gone.
   */
  private async respawnPlayer(playerId: EntityId): Promise<void> {
    if (this.respawning.has(playerId) || this.world.isAlive(playerId) || !this.sessions.has(playerId)) return;
    this.respawning.add(playerId);
    try {
      if (this.accountClient) {
        await this.accountClient.recordDeath(playerId, "damage").catch((err: unknown) => {
          console.error("[TileServer] respawn recordDeath failed:", err);
        });
      }
      await this.spawnFreshPlayer(playerId, this.handoffCoordinator.getHearthAnchor(playerId));
      console.log(`[TileServer] player ${playerId.slice(0, 8)} respawned (heir)`);
    } finally {
      this.respawning.delete(playerId);
    }
  }

  private spawnWorldState(content: ContentService, biomeTag: string): void {
    const dayLengthTicks = content.getGameConfig().dayNight.dayLengthTicks;
    const id = newEntityId();
    this.world.create(id);
    this.world.write(id, WorldClock, { ticksElapsed: 0, dayLengthTicks, biomeTag });
    console.log("[TileServer] world-state entity created");
    // Starter entities (workstations, nodes) are declared in tile_layout.json.
  }

  /**
   * T-311 P5a: refresh the WorldClock singleton's `biomeTag` from this boot's
   * atlas-derived value. biomeTag is atlas-derived metadata (not gameplay
   * state) — same bucket as the render-field grids `applyFieldsToChunks`
   * overlays onto save-loaded chunks, so a save-loaded tile's biomeTag always
   * reflects the CURRENT atlas classification, not whatever (or nothing) an
   * older save encoded.
   */
  private refreshWorldClockBiomeTag(biomeTag: string): void {
    for (const { entityId, worldClock } of this.world.query(WorldClock)) {
      this.world.write(entityId, WorldClock, { ...worldClock, biomeTag });
    }
  }

  /**
   * Push the current gate-summary to coordinator iff it differs from the
   * last value we pushed. Called on initial boot and (future, phase 6D)
   * whenever the runtime openMask edit loop recomputes the summary.
   *
   * No-op when the gateway link isn't established (single-tile dev mode).
   */
  private maybePushSummary(tileId: string): void {
    if (!this.gatewayLink) return;
    if (this.currentGateSummary === this.lastPushedGateSummary) return;
    this.gatewayLink.publish({
      type: "world_event",
      sourceTileId: tileId,
      event: {
        kind: "tile_summary_updated",
        tileId,
        cellX: this.cellX,
        cellY: this.cellY,
        summary: this.currentGateSummary,
      },
    });
    this.lastPushedGateSummary = this.currentGateSummary;
  }

  /**
   * The single "player leaves this tile" path (T-354, T-361) — called by the
   * tick loop's dead-session sweep, handleSession's end-of-session
   * continuation, and (with `handedOff`) the handoff success continuation.
   * Whichever caller notices first wins the race: the map deletes AND the
   * entity destroy run synchronously before the first await (see
   * `teardownPlayer`), so a late caller — or a reconnect landing mid-teardown
   * — always sees the entry gone and the entity dead. Disconnect callers own
   * the handingOff guard: an in-flight handoff owns the entity's fate.
   */
  private teardownSession(playerId: EntityId, opts: { handedOff?: boolean } = {}): Promise<void> {
    return teardownPlayer({
      world: this.world,
      sessions: this.sessions,
      accountClient: this.accountClient,
      tileId: this.tileId,
      clearPlayerCaches: (id) => {
        this.handoffCoordinator.clearZone(id);
        this.handoffCoordinator.clearHearthAnchor(id);
        this.playerDisplayNames.delete(id);
        this.playerCharacters.delete(id);
      },
    }, playerId, opts);
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
    // Display label for the floating-name overlay; cached so a respawn (which
    // has no join message) can reuse it. Falls back to a playerId-derived stub.
    const displayName = (joinMsg.displayName ?? "").trim() || `Player-${playerId.slice(0, 6)}`;
    this.playerDisplayNames.set(playerId, displayName);
    // Cache the hearth anchor (T-079) so an in-session respawn can spawn the
    // heir at the hearth (or detect its destruction) — respawn has no join msg.
    this.handoffCoordinator.setHearthAnchor(playerId, info?.hearthAnchor ?? null);

    // Character-creation selections (T-071): validate the client's join-time
    // species/lore picks against bootstrapped content and cache the resolved
    // result so a later respawn (no join msg) reuses the same character. A
    // post-handoff rejoin keeps whatever the source tile already cached.
    if (!this.playerCharacters.has(playerId)) {
      this.playerCharacters.set(
        playerId,
        resolveCharacterSelections(this.content, {
          speciesId: joinMsg.speciesId,
          initialFragmentIds: joinMsg.initialFragmentIds,
        }),
      );
    }

    if (this.world.isAlive(playerId)) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} rejoining (post-handoff)`);
      // A handed-off entity arrives with an EMPTY fog bitmap — fog is keyed
      // per (player, tile) in the account service and never travels in the
      // handoff payload (T-361). Hydrate THIS tile's stored exploration the
      // same way a fresh spawn does.
      await this.hydrateFog(playerId);
    } else {
      await this.spawnFreshPlayer(playerId, this.handoffCoordinator.getHearthAnchor(playerId));
    }

    // Send ack with canonical playerId
    const ack: TileJoinAck = { type: "joined", playerId };
    await jWriter.write(encodeFrame(ack));
    // Then the content bootstrap blob (T-177) — chunked into frames so
    // a single frame never exceeds MAX_FRAME_PAYLOAD_BYTES regardless of
    // total content size. Header announces chunk count + total bytes;
    // client reassembles in order.
    const blob = this.contentBlob;
    if (!blob || blob.length === 0) {
      throw new Error("content bootstrap blob not built — handleSession ran before init finished");
    }
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB — well under the 16 MiB frame cap
    const chunks = Math.ceil(blob.length / CHUNK_SIZE);
    const header: BootstrapHeader = { type: "bootstrap", totalBytes: blob.length, chunks };
    console.log(`[TileServer] sending bootstrap to ${playerId.slice(0, 8)}: ${(blob.length / 1024).toFixed(1)} KB in ${chunks} chunk(s)`);
    await jWriter.write(encodeFrame(header));
    for (let i = 0; i < chunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, blob.length);
      await jWriter.write(encodeFrame(blob.subarray(start, end)));
    }
    console.log(`[TileServer] bootstrap sent to ${playerId.slice(0, 8)}`);
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
    // Reconnect (T-253): evict any existing session for this player BEFORE
    // registering the new one — previously the map entry was silently
    // overwritten and the old session's cleanup then deleted the NEW entry.
    const existing = this.sessions.get(playerId);
    if (existing) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} reconnected — evicting old session`);
      existing.close();
    }
    this.sessions.set(playerId, clientSession);

    // Send the initial world snapshot immediately rather than waiting for the next
    // tick.  Without this, the client may receive no state if the tick already fired
    // while we were awaiting createUnidirectionalStream() above.
    {
      const initialMsg = computeSessionUpdate(
        this.world, computeAoiSharedInputs(this.world), clientSession, this.spatial, playerId,
        new Map(), new Map(), new Set(), [], this.tickLoop.currentTick, 0,
        this.content.getGameConfig().network.aoiRadius,
        this.sessions.size,
      );
      const initialPayload = binaryStateMessageCodec.encode(initialMsg);
      clientSession.sendStateRaw(encodeFrame(initialPayload));
    }

    // Subsequent ticks will send deltas via the normal AoI loop.
    // Background: accept the one further client-opened bidi stream — the
    // command stream (T-273) — and serve it for the lifetime of the session.
    const bidiReader = (session.incomingBidirectionalStreams as ReadableStream).getReader();
    (async () => {
      const command = await bidiReader.read();
      if (!command.done && command.value) {
        clientSession.serveCommands(
          command.value as { readable: ReadableStream<Uint8Array> },
        ).catch(() => {});
      }
    })().catch(() => {}).finally(() => bidiReader.releaseLock());

    const heritageOnJoin = this.world.get(playerId, Heritage);
    console.log(
      `[TileServer] player ${playerId.slice(0, 8)} connected ` +
        `(dynasty ${dynastyId.slice(0, 8)}, gen ${heritageOnJoin?.generation ?? 0})`,
    );

    // Input receiver runs concurrently — returns when the session closes
    await clientSession.receiveInputs(session);

    // Session ended — teardownSession (T-354) is the single cleanup path,
    // shared with the tick loop's dead-session sweep.
    clientSession.close();
    // T-253: a reconnect may have replaced the map entry with a NEW session —
    // this (old) session's cleanup must not delete it or destroy the
    // player the new session is serving. Also dedups against the tick-loop
    // sweep, which deletes the entry synchronously when it wins the race.
    if (this.sessions.get(playerId) !== clientSession) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)}: stale session ended (superseded or already torn down)`);
      return;
    }
    // T-256: a handoff fetch is in flight — it owns the entity. A disconnect
    // here must NOT run normal cleanup (that records a wrong death / rewrites
    // last_tile_id back to ours / ghosts the entity on the destination). The
    // handoff's success continuation runs teardownSession(handedOff) itself;
    // on failure the tile-sweep cleans up once handingOff clears.
    if (this.handoffCoordinator.isHandingOff(playerId)) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)}: session ended mid-handoff — handoff owns the entity`);
      return;
    }
    await this.teardownSession(playerId);
  }
}

