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
import { GateLink } from "./components/gate.ts";
import { spawnGates, mirrorPosition } from "./gate.ts";
import { chunksFromBuffers, TILE_SIZE } from "@voxim/world";
import type { ZoneGridData } from "@voxim/world";
import { loadTerrainFromAtlas } from "./atlas_terrain.ts";
import { placePois, spawnMobPois } from "./poi_placer.ts";
import { binaryStateMessageCodec, ACTION_BLOCK, ACTION_CROUCH, encodeFrame, makeFrameReader, TileEvents } from "@voxim/protocol";
import type { EntityDeployedPayload } from "@voxim/protocol";
import { startAdminServer, registerWithGateway } from "./admin_server.ts";
import { listenQuic } from "./quic_server.ts";
import { GatewayLink } from "./gateway_link.ts";
import { CommandType } from "@voxim/protocol";
import type { BinaryComponentDelta, BinaryStateMessage, BootstrapHeader, CommandPayload, TileJoinRequest, TileJoinAck, WorldSnapshot } from "@voxim/protocol";
import { computeSessionUpdate } from "./aoi.ts";
import { JsonSource, validateRecipeGraph, encodeBootstrap, type ContentService } from "@voxim/content";
import { ClientSession } from "./session.ts";
import { sanitizeAndMergeInputs } from "./input_merge.ts";
import { TickLoop } from "./tick_loop.ts";
import { DeferredEventQueue } from "./deferred_events.ts";
import { StateHistoryBuffer } from "./state_history.ts";
import { AccountClient } from "./account_client.ts";
import type { SessionInfo } from "./account_client.ts";
import { spawnPrefab, destroyCarriedItemEntities } from "./spawner.ts";
import { validatePrefabs } from "./prefab_validator.ts";
import type { System } from "./system.ts";
import { Position, Velocity, Facing, InputState, Name } from "./components/game.ts";
import { Heritage } from "./components/heritage.ts";
import { Hitbox } from "./components/hitbox.ts";
import { NpcAiSystem } from "./systems/npc_ai.ts";
import { PhysicsSystem } from "./systems/physics.ts";
import { FogOfWarSystem } from "./systems/fog_of_war.ts";
import { FogState } from "./components/fog_state.ts";
import { ItemPhysicsSystem } from "./systems/item_physics.ts";
import { equipmentStatModifier } from "./resources/modifiers/equipment_stat.ts";
import { ActionDispatcher, newGateRegistry, newEffectRegistry, WeaponTraceResolver, ProjectileSpawnResolver, ProjectileTraceResolver } from "./actions/index.ts";
import { PostureIntentResolver, CompositeIntentResolver, PrimaryIntentResolver, SkillIntentResolver, ReactionIntentResolver, RequestedActionIntentResolver } from "./actions/intent.ts";
import { LocomotionIntentResolver } from "./actions/locomotion_intent.ts";
import { setTagResolver, clearTagResolver } from "./actions/resolvers/tags.ts";
import { dodgeImpulseResolver } from "./actions/resolvers/movement.ts";
import { notStaggeredGate, notExhaustedGate, healthBelowGate } from "./actions/resolvers/gates.ts";
import { StaminaCostHandler } from "./actions/cost.ts";
import { EquipmentSystem } from "./systems/equipment.ts";
import { PlacementSystem } from "./systems/placement.ts";
import { CraftingSystem } from "./systems/crafting.ts";
import { slotHasUsableGate, ApplyItemEffectsResolver, adjustResourceResolver, spendItemResolver } from "./actions/resolvers/item_use.ts";
import { HealthHitHandler } from "./handlers/health_hit_handler.ts";
import { ResourceNodeHitHandler } from "./handlers/resource_node_hit_handler.ts";
import { BlueprintHitHandler } from "./handlers/blueprint_hit_handler.ts";
import { WorkstationHitHandler } from "./handlers/workstation_hit_handler.ts";
import { TerrainDigSystem } from "./handlers/terrain_hit_handler.ts";
import { DayNightSystem } from "./systems/day_night.ts";
import { PoiSystem } from "./systems/poi.ts";
import { newPoiActivityRegistry } from "./poi/mod.ts";
import { TriggerSystem } from "./systems/trigger.ts";
import { newTriggerCatalog } from "./triggers/catalog.ts";
import { newTriggerSourceRegistry, equipmentTriggerSource, npcTemplateTriggerSource } from "./triggers/source.ts";
import { placePoiTriggers } from "./poi_spawner.ts";
import { placeStairs } from "./stair_spawner.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";
import { speedSkillEffect, damageBoostSkillEffect, shieldSkillEffect, fleeSkillEffect, HealthSkillResolver } from "./actions/resolvers/skill_effects.ts";
import { ResourceSystem } from "./systems/resource.ts";
import { newResourceEffectRegistry } from "./resources/effect.ts";
import { newResourceModifierRegistry } from "./resources/modifier.ts";
import { newModifierSourceRegistry } from "./modifiers/modifier.ts";
import { equipmentSource } from "./modifiers/sources/equipment.ts";
import { encumbranceSource } from "./modifiers/sources/encumbrance.ts";
import { speciesSource } from "./modifiers/sources/species.ts";
import { buffsSource } from "./modifiers/sources/buffs.ts";
import { modifyHealthEffect } from "./resources/effects/modify_health.ts";
import { emitEventEffect } from "./resources/effects/emit_event.ts";
import { resolveRecipeEffect } from "./resources/effects/resolve_recipe.ts";
import { expireBuffEffect } from "./resources/effects/expire_buff.ts";
import { destroySelfEffect } from "./resources/effects/destroy_self.ts";
import { respawnNodeEffect } from "./resources/effects/respawn_node.ts";
import { clearCounterReadyEffect } from "./resources/effects/clear_counter_ready.ts";
import { startBuffResolver, buffTickResolver } from "./actions/resolvers/buff.ts";
import { createJobRegistry, registerBuiltinJobs } from "./ai/mod.ts";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildAllBehaviorTrees } from "./ai/bt/mod.ts";
import { createRecipeStepRegistry, registerBuiltinSteps } from "./crafting/mod.ts";
import { Registry } from "@voxim/engine";
import { TraderSystem } from "./systems/trader.ts";
import { DynastySystem } from "./systems/dynasty.ts";
import { StaleSlotCleanupSystem } from "./systems/stale_slot_cleanup.ts";
import { AnimationSystem } from "./systems/animation.ts";
import { HitboxSystem } from "./systems/hitbox.ts";
import { DebugCommandSystem } from "./systems/debug_commands.ts";
import { WorldClock } from "./components/world.ts";
import { SaveManager } from "./save_manager.ts";
import { serializePlayer } from "./handoff.ts";
import { SpatialGrid } from "./spatial_grid.ts";
import { ProceduralSpawner } from "./procedural_spawner.ts";
import { EventRouter } from "./event_router.ts";
import { sortSystemsByDependencies } from "./system_order.ts";
import type { TickContext } from "./system.ts";

// Action bits that represent *held* keys (block, crouch) — merged
// latest-wins across a tick rather than OR-accumulated like one-shots.
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

  // Initialised in start() — ActionSystem needs tickRateHz and stateHistory
  private systems: System[] = [];

  private saveManager: SaveManager | null = null;
  private saveTickCounter = 0;
  private gatewayUrl: string | null = null;
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
  private zoneById = new Map<number, {
    id: number;
    name: string;
    topologyRole: string;
    traversal: "path" | "wilderness";
  }>();
  /** Last zone id reported per player, to detect transitions. */
  private playerLastZone = new Map<EntityId, number>();
  /**
   * Active world this tile-server is serving. Set on atlas terrain load;
   * the bake-poll loop watches `activeWorldBaked` to detect a newer bake
   * and triggers Deno.exit(0) so the process restarts and reloads.
   */
  private activeWorldId = "";
  private activeWorldBaked: Date = new Date(0);
  /**
   * Players for whom a handoff fetch is in flight. Prevents a second
   * GateApproached event (or rapidly-repeated collisions) from initiating a
   * duplicate handoff while the first is still pending its gateway round-trip.
   */
  private handingOff = new Set<EntityId>();
  /**
   * Players whose entity was destroyed by a handoff (not by death). The
   * disconnect-cleanup path checks this set so it skips recordDeath when the
   * session unwinds for a moved-away player. Cleared on disconnect cleanup.
   */
  private handedOff = new Set<EntityId>();
  /** Display name per connected player — cached so a respawn (no join msg) keeps the name. */
  private playerDisplayNames = new Map<EntityId, string>();
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

    // Resource substrate (T-238) — the one tick loop for every bounded
    // scalar (stamina/hunger/thirst/poise + the crafting countdown).
    // Thresholds dispatch through resourceEffects; rateModifiers through
    // resourceModifiers — same Registry<H> doctrine as the action arc.
    const resourceEffects = newResourceEffectRegistry();
    resourceEffects.register(modifyHealthEffect);
    resourceEffects.register(emitEventEffect);
    resourceEffects.register(resolveRecipeEffect);
    // expire_buff: a buff child's buff_timer Resource hits 0 → destroySubtree.
    resourceEffects.register(expireBuffEffect);
    resourceEffects.register(destroySelfEffect);
    resourceEffects.register(respawnNodeEffect);
    resourceEffects.register(clearCounterReadyEffect);
    const resourceModifiers = newResourceModifierRegistry();
    resourceModifiers.register(equipmentStatModifier);

    // Status/Modifier query (T-239) — the one place "what changes this
    // entity's stats?" composes: equipment (live), buffs (scene-graph
    // children), encumbrance (live). effective() over this replaces
    // BuffSystem's compose pass, SpeedModifier, EncumbrancePenalty, and
    // the per-consumer deriveItemStats scans.
    const modifierSources = newModifierSourceRegistry();
    modifierSources.register(equipmentSource);
    modifierSources.register(encumbranceSource);
    modifierSources.register(buffsSource);
    modifierSources.register(speciesSource);

    // T-084: the default player species must exist in content.species, else a
    // fresh player would spawn with a Species id no source can resolve.
    const defaultSpecies = content.getGameConfig().player.species ?? "human";
    if (!content.getGameConfig().species[defaultSpecies]) {
      throw new Error(
        `game_config.player.species "${defaultSpecies}" is not defined in game_config.species`,
      );
    }

    // T-238g: ResourceDef content cross-check — every threshold `effect`
    // and rateModifier `kind` referenced from data/resources/*.json must
    // resolve to a registered handler, or the runtime can't dispatch it.
    // Fail fast at boot (mirrors the buff / recipe-step / BT checks).
    for (const def of content.resources.values()) {
      for (const t of def.thresholds ?? []) {
        if (!resourceEffects.has(t.effect)) {
          throw new Error(
            `ResourceDef "${def.id}" references threshold effect "${t.effect}" ` +
            `but no resource-effect handler is registered. ` +
            `Registered: [${resourceEffects.ids().join(", ")}]`,
          );
        }
      }
      for (const m of def.rateModifiers ?? []) {
        if (!resourceModifiers.has(m.kind)) {
          throw new Error(
            `ResourceDef "${def.id}" references rateModifier kind "${m.kind}" ` +
            `but no resource-modifier handler is registered. ` +
            `Registered: [${resourceModifiers.ids().join(", ")}]`,
          );
        }
      }
    }


    // DeathSystem owns the single RequestDeath queue — systems with health-loss
    // kill paths publish here instead of calling world.destroy directly.
    // Hook registry is empty for now; later populated with drop-table, heir-spawn,
    // corpse-spawn hooks — additive, no system-file edits required.
    const deathHooks = new Registry<DeathHook>();
    // T-252: dying holders take their carried item ENTITIES with them
    // (equipment + unique inventory slots) — drop-tables become a sibling
    // hook later; until then a kill must not leak entities.
    deathHooks.register({
      id: "equip_cleanup",
      onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
    });
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
    for (const tmpl of content.npcTemplates.values()) {
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
    for (const recipe of content.recipes.values()) {
      const stepType = recipe.stepType ?? "time";
      if (!recipeSteps.has(stepType)) {
        throw new Error(
          `Recipe "${recipe.id}" references stepType "${stepType}" but no step ` +
          `handler is registered. Registered: [${recipeSteps.ids().join(", ")}]`,
        );
      }
    }

    // Action runtime (T-226). Gate registry is empty until an action
    // references a gate (T-227 swings); the effect registry carries the
    // posture tag resolvers. Posture (T-226b) + locomotion (T-226c)
    // intent are merged via CompositeIntentResolver — more slots compose
    // here as further layers migrate. No cost handler yet (both slots
    // are free).
    const actionGates = newGateRegistry();
    actionGates.register(notStaggeredGate);
    actionGates.register(notExhaustedGate);
    actionGates.register(slotHasUsableGate);
    // health_below: the low-health proc condition (T-259c) — usable by
    // trigger conditions and action preconditions alike.
    actionGates.register(healthBelowGate);
    const actionEffects = newEffectRegistry();
    actionEffects.register(setTagResolver);
    actionEffects.register(clearTagResolver);
    actionEffects.register(dodgeImpulseResolver);
    // T-240: `use_item`'s apply_item_effects fans an item's EffectSpec[]
    // back through this same registry (adjust_resource etc.).
    actionEffects.register(adjustResourceResolver);
    actionEffects.register(spendItemResolver);
    actionEffects.register(new ApplyItemEffectsResolver(actionEffects));
    // Buffs: start_buff spawns a buff scene-graph child; the child's
    // `buff` ambient action fires buff_tick (DoT/HoT) each tick.
    actionEffects.register(startBuffResolver);
    actionEffects.register(buffTickResolver);
    // T-246: the five skill effects fold onto this one substrate (the
    // parallel `effects/` apply registry is gone). speed/damage_boost/shield
    // are buff children; health is the targeted heal/drain (needs the death
    // port); flee forces NPC job queues. SkillSystem fires them through this
    // registry; an action's effect spec can name them too.
    actionEffects.register(speedSkillEffect);
    actionEffects.register(damageBoostSkillEffect);
    actionEffects.register(shieldSkillEffect);
    actionEffects.register(fleeSkillEffect);
    actionEffects.register(new HealthSkillResolver(deathSystem));

    // T-260b: every configured starting-skill slot must be a loaded
    // ActionDef (the slots ARE action ids now; matrix + verbs are gone).
    for (const sk of content.getGameConfig().player.startingSkills ?? []) {
      if (sk !== null && !content.actions.get(sk)) {
        throw new Error(
          `player.startingSkills names action "${sk}" but no such ActionDef ` +
          `is loaded.`,
        );
      }
    }

    // Trigger primitive (T-259) — the single event→effect bridge. Catalog
    // (closed event-kind vocabulary) + sources (live "who owns which
    // triggers" reads; v1: equipment) + the buffered TriggerSystem.
    const triggerCatalog = newTriggerCatalog();
    const triggerSources = newTriggerSourceRegistry();
    triggerSources.register(equipmentTriggerSource);
    triggerSources.register(npcTemplateTriggerSource);
    const triggerSystem = new TriggerSystem(content, triggerCatalog, triggerSources, actionGates, actionEffects);

    // T-259 content cross-checks — every TriggerDef's `on` must be a
    // catalog kind, every condition gate and effect kind registered, and
    // every prefab `triggers[]` ref must resolve. Fail fast at boot, same
    // stance as the ResourceDef / action-effect / POI checks.
    for (const trig of content.triggers.values()) {
      if (!triggerCatalog.has(trig.on)) {
        throw new Error(
          `Trigger "${trig.id}" listens to "${trig.on}" but no such event ` +
          `kind is in the catalog. Known: [${triggerCatalog.ids().join(", ")}]`,
        );
      }
      for (const c of trig.conditions ?? []) {
        if (!actionGates.has(c.gate)) {
          throw new Error(
            `Trigger "${trig.id}" condition gate "${c.gate}" is not ` +
            `registered. Registered: [${actionGates.ids().join(", ")}]`,
          );
        }
      }
      for (const eff of trig.effects) {
        if (!actionEffects.has(eff.kind)) {
          throw new Error(
            `Trigger "${trig.id}" lists effect "${eff.kind}" but no ` +
            `action-effect resolver is registered. ` +
            `Registered: [${actionEffects.ids().join(", ")}]`,
          );
        }
      }
    }
    for (const prefab of content.prefabs.values()) {
      for (const t of prefab.triggers ?? []) {
        if (!content.triggers.get(t)) {
          throw new Error(
            `Prefab "${prefab.id}" grants trigger "${t}" but no such ` +
            `TriggerDef is loaded. Loaded: [${[...content.triggers.ids()].join(", ")}]`,
          );
        }
      }
    }
    for (const tmpl of content.npcTemplates.values()) {
      for (const t of tmpl.triggers ?? []) {
        if (!content.triggers.get(t)) {
          throw new Error(
            `NpcTemplate "${tmpl.id}" grants trigger "${t}" but no such ` +
            `TriggerDef is loaded. Loaded: [${[...content.triggers.ids()].join(", ")}]`,
          );
        }
      }
    }

    const actionDispatcher = new ActionDispatcher(
      content, actionGates, actionEffects,
      new CompositeIntentResolver([
        PostureIntentResolver,
        LocomotionIntentResolver,
        new PrimaryIntentResolver(content),
        // T-260b: a SKILL_N press overrides the bit-derived primary intent —
        // the skill bar IS the action system now (SkillSystem is gone).
        SkillIntentResolver,
        ReactionIntentResolver,
        // Last: a BT-named action request overrides the bit-derived intent.
        RequestedActionIntentResolver,
      ]),
      StaminaCostHandler,
    );
    // Trigger collectors run during the (notify-only) post-changeset flush
    // and only buffer; the TriggerSystem drains at the top of its next run.
    triggerSystem.registerSubscribers(this.eventBus);

    // Hearth anchor subscriber — when a prefab carrying the `hearth` component
    // is placed, tell the account service so the heir spawns at the new
    // location on next login. Fire-and-forget; a failed write leaves the
    // previous anchor in place and is logged. Runs during the post-changeset
    // flush; requires no world mutation, so a 1-tick latency is irrelevant.
    if (this.accountClient && config.tileId) {
      const accountClient = this.accountClient;
      const tileId = config.tileId;
      this.eventBus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
        const prefab = content.prefabs.get(p.prefabId);
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

    // One-tick event channel from gameplay systems → CSM. Cleared at the end
    // of CharacterStateMachineSystem.run each tick.

    const hitHandlers = [
      new HealthHitHandler(content, deathSystem, modifierSources),
      new ResourceNodeHitHandler(content),
      new BlueprintHitHandler(),
      new WorkstationHitHandler(content, recipeSteps),
    ];

    // T-227: the swing's active phase fires these through the dispatcher's
    // effect registry (registered after hitHandlers since weapon_trace
    // dispatches to them). Replaces ActionSystem.resolveHits / spawnProjectile.
    actionEffects.register(new WeaponTraceResolver(this.stateHistory, tickRateHz, hitHandlers));
    actionEffects.register(new ProjectileSpawnResolver());
    // T-243: projectile flight is an ambient action (`projectile_flight`)
    // whose `hold:tick` fires this — motion + collision + hit dispatch over
    // the shared hitHandlers. Replaces the bespoke ProjectileSystem.
    actionEffects.register(new ProjectileTraceResolver(hitHandlers));

    // T-240 Ph3: item effect content cross-check — every `effects[].id` on
    // every prefab must resolve to a registered action-effect resolver, or
    // `use_item` can't dispatch it. Fail fast at boot (mirrors the
    // ResourceDef / buff / recipe-step / BT checks). Unique items' runtime
    // `ItemEffects` (procedural) can't be boot-checked; the prefab payload
    // is the static surface generation targets.
    for (const prefab of content.prefabs.values()) {
      for (const spec of prefab.effects ?? []) {
        if (!actionEffects.has(spec.id)) {
          throw new Error(
            `Prefab "${prefab.id}" lists item effect "${spec.id}" but no ` +
            `action-effect resolver is registered. ` +
            `Registered: [${actionEffects.ids().join(", ")}]`,
          );
        }
      }
    }

    // T-243: action-effect content cross-check — every `effects[].kind` on
    // every ActionDef must resolve to a registered resolver, or the
    // dispatcher throws mid-tick the first time that phase edge fires.
    // Closes the doctrine gap (weapon_trace / buff_tick / projectile_trace
    // were dispatch-time-only); same fail-fast stance as the checks above.
    for (const action of content.actions.values()) {
      for (const eff of action.effects) {
        if (!actionEffects.has(eff.kind)) {
          throw new Error(
            `Action "${action.id}" phase "${eff.phase}" lists effect ` +
            `"${eff.kind}" but no action-effect resolver is registered. ` +
            `Registered: [${actionEffects.ids().join(", ")}]`,
          );
        }
      }
      // T-254: gate ids too (preconditions + cancel-rule gates) — an
      // unknown gate previously threw mid-tick on first arbitration
      // (sword_overhead shipped with an unregistered `tag_absent` for
      // months and nothing noticed).
      const gateRefs = [
        ...(action.preconditions ?? []),
        ...Object.values(action.cancel).flatMap((r) => r.gates ?? []),
      ];
      for (const g of gateRefs) {
        if (!actionGates.has(g.gate)) {
          throw new Error(
            `Action "${action.id}" references gate "${g.gate}" but no gate ` +
            `handler is registered. Registered: [${actionGates.ids().join(", ")}]`,
          );
        }
      }
    }

    // T-245: POI activity registry + content cross-check — every PoiDef's
    // `type` must resolve to a registered PoiActivityHandler, or PoiSystem
    // throws when that POI first fires. Replaces the per-type switch; same
    // fail-fast stance as the checks above.
    const poiActivities = newPoiActivityRegistry();
    for (const poi of content.pois.values()) {
      if (!poiActivities.has(poi.type)) {
        throw new Error(
          `POI "${poi.id}" has activity type "${poi.type}" but no ` +
          `PoiActivityHandler is registered. ` +
          `Registered: [${poiActivities.ids().join(", ")}]`,
        );
      }
    }

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
      // TriggerSystem drains last tick's buffered events early so its
      // effects (procs, buffs, damage) land in this tick's changeset
      // alongside everything else (T-259).
      triggerSystem,
      new NpcAiSystem(content, jobs, behaviorTrees),
      new EquipmentSystem(content),
      new PlacementSystem(content),
      new CraftingSystem(content, recipeSteps),
      new DayNightSystem(content),
      new ResourceSystem(content, resourceEffects, resourceModifiers, deathSystem, modifierSources),
      new PhysicsSystem(content, modifierSources),
      new FogOfWarSystem(),
      // ActionDispatcher advances every actor's slots (posture, locomotion,
      // primary, reaction) from intent + events. The CSM is gone (T-228).
      actionDispatcher,
      new ItemPhysicsSystem(content),
      new TerrainDigSystem(content),
      new TraderSystem(content),
      new DynastySystem(content),
      new AnimationSystem(content),
      new HitboxSystem(content),
      new PoiSystem(content, poiActivities, () => this.sessions.keys()),
      new DebugCommandSystem(content, config.devMode ?? false),
      deathSystem,
    ];
    this.systems = sortSystemsByDependencies(declared);

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
        this.world, content, atlas.level, atlas.heightBuffer, TILE_SIZE,
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
    // zoneGrid is null for now — atlas doesn't produce zones; ProceduralSpawner
    // already no-ops every zone-driven method when this is null.
    const zoneGrid: ZoneGridData | null = null;
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
        atlas.chambers,
        tileSeed,
        woodMat.id,
      );
      chunksFromBuffers(
        this.world,
        atlas.heightBuffer,
        atlas.materialBuffer,
        atlas.openBuffer,
        atlas.kindBuffer,
      );
      this.spawnWorldState(content);

      // Boundary decoration (forest trees, stone debris, …) is purely
      // visual and lives client-side now: KindGrid is networked so the
      // client decorates closed pixels itself. Server keeps no per-tree
      // entities — collision is handled by OpenMask in stepPhysics.
    }

    const procedural = new ProceduralSpawner(this.world, content, zoneGrid, tileSeed);
    if (!loaded) procedural.spawnInitialEntities();
    // NPCs and props are always re-spawned from layout (not persisted across restarts).
    procedural.spawnInitialNpcs();
    procedural.spawnProceduralProps();

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

    // Subscribe to tile events that need to reach clients as GameEvents.
    // The router is responsible for translation; handoff side-effects stay here.
    this.events = new EventRouter(this.eventBus, (p) => this.initiateHandoff(p));

    // Start the WebTransport QUIC server (Deno.QuicEndpoint, requires --unstable-net)
    listenQuic(config, (session) => this.handleSession(session));

    // Start admin HTTP server for gateway → tile internal messages (handoff)
    if (config.adminPort) {
      startAdminServer(config.adminPort, {
        world: this.world,
        content,
        getCertHashHex: () => this.certHashHex,
        getWtPort: () => this.wtPort,
      });
    }

    // Self-register with gateway so clients can be routed here
    if (config.gatewayUrl && config.tileAddress && config.adminPort) {
      this.gatewayUrl = config.gatewayUrl;
      const adminHost = config.adminHost ?? "localhost";
      const adminUrl = `http://${adminHost}:${config.adminPort}`;
      console.log(`[TileServer] self-registering with gateway: adminUrl=${adminUrl}`);
      registerWithGateway(config.gatewayUrl, config.tileId, config.tileAddress, adminUrl);
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

    // ── 4. FIRE EVENTS ──────────────────────────────────────────────────────
    // Subscribers see the already-committed world state.
    deferredEvents.flush(this.eventBus);

    // Gate proximity check (T-140) — runs after systems so positions are
    // committed. Publishes GateApproached for any player within a gate's
    // trigger radius; the EventRouter routes it to initiateHandoff.
    this.checkGateProximity();

    // Zone transition check (T-211) — also after-systems / post-changeset.
    // Walks every active session, looks up the zone under the player's
    // current voxel, and fires ZoneEntered when it differs from the last
    // recorded zone for that player.
    this.checkZoneTransitions();

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
      for (const [playerId, session] of this.sessions) {
        if (!session.isOpen) { console.warn(`[TileServer] tick ${serverTick}: session ${playerId.slice(-8)} is closed, skipping`); continue; }
        const inputState = this.world.get(playerId, InputState);
        const ackInputSeq = inputState?.seq ?? 0;
        const msg = computeSessionUpdate(
          this.world, session, this.spatial, playerId,
          changedComponents, removedComponents, worldDestroys, events, serverTick, ackInputSeq,
          aoiRadius, this.sessions.size,
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

    // Remove disconnected sessions
    for (const [playerId, session] of this.sessions) {
      if (!session.isOpen) {
        // T-256: an in-flight handoff owns this entity's fate — don't destroy
        // it out from under the fetch (that ghosts it on the destination).
        // initiateHandoff destroys + deletes on success; the tile-sweep cleans
        // it up after the handoff resolves and clears handingOff.
        if (this.handingOff.has(playerId)) continue;
        this.sessions.delete(playerId);
        this.playerLastZone.delete(playerId);
        this.playerDisplayNames.delete(playerId);
        if (this.world.isAlive(playerId)) {
          // T-252: take the carried item entities along — players respawn
          // fresh (save doctrine), so leaving them would leak forever.
          destroyCarriedItemEntities(this.world, playerId);
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

  // ---- handoff side-effect ----

  /**
   * Per-tick proximity check: any player whose Position is within a
   * GateLink's radius gets a GateApproached event published. The
   * EventRouter forwards to initiateHandoff. The handingOff guard +
   * destination tile's handoffId dedup prevent re-firing while a
   * handoff is in flight.
   */
  private checkGateProximity(): void {
    if (!this.gatewayUrl || this.sessions.size === 0) return;
    const gates = this.world.query(Position, GateLink);
    if (gates.length === 0) return;

    for (const playerId of this.sessions.keys()) {
      if (this.handingOff.has(playerId)) continue;
      const pos = this.world.get(playerId, Position);
      if (!pos) continue;
      for (const { entityId: gateId, position: gp, gateLink } of gates) {
        const dx = pos.x - gp.x;
        const dy = pos.y - gp.y;
        const r = gateLink.radius;
        if (dx * dx + dy * dy <= r * r) {
          this.eventBus.publish(TileEvents.GateApproached, {
            entityId: playerId,
            gateId,
            destinationTileId: gateLink.destinationTileId,
          });
          break; // one gate per player per tick is plenty
        }
      }
    }
  }

  /**
   * T-211 zone tracker. For each active session, look up the zone id
   * under the player's current voxel and fire a ZoneEntered game event
   * when the zone has changed. The map is cleared on disconnect.
   */
  private checkZoneTransitions(): void {
    const buf = this.zoneBuffer;
    if (!buf || this.sessions.size === 0) return;
    const stride = TILE_SIZE;
    for (const playerId of this.sessions.keys()) {
      const pos = this.world.get(playerId, Position);
      if (!pos) continue;
      const vx = pos.x | 0;
      const vy = pos.y | 0;
      if (vx < 0 || vy < 0 || vx >= stride || vy >= stride) continue;
      const zoneId = buf[vy * stride + vx];
      const lastZone = this.playerLastZone.get(playerId) ?? -1;
      if (zoneId === lastZone) continue;
      this.playerLastZone.set(playerId, zoneId);

      // Sub-threshold / unzoned (0xFFFF for closed-pixel sentinel + water
      // blobs) — emit anyway with an empty name so the client can clear
      // its caption when the player walks across a no-zone band.
      const meta = this.zoneById.get(zoneId);
      this.events.push({
        type: "ZoneEntered",
        playerId,
        zoneId,
        zoneName:     meta?.name ?? "",
        topologyRole: meta?.topologyRole ?? "",
        traversal:    meta?.traversal ?? "path",
      });
    }
  }

  /**
   * Fire-and-forget handoff to the destination tile via the gateway. The
   * re-entry guard prevents a second GateApproached event from starting a
   * parallel handoff while the first is still pending its round-trip; the
   * destination tile deduplicates retries on handoffId.
   *
   * Position is mirrored to the destination's matching edge so the player
   * lands just inside the new tile's gate (away from its own trigger
   * radius — otherwise we'd bounce straight back).
   */
  private initiateHandoff(payload: { entityId: EntityId; gateId: string; destinationTileId: string }): void {
    if (!this.gatewayUrl || this.handingOff.has(payload.entityId)) return;
    this.handingOff.add(payload.entityId);

    const gateLink = this.world.get(payload.gateId as EntityId, GateLink);
    const dynastyId = this.world.get(payload.entityId, Heritage)?.dynastyId ?? payload.entityId;
    const handoffId = crypto.randomUUID();
    const body = serializePlayer(this.world, payload.entityId, dynastyId, payload.destinationTileId, handoffId);

    // Land the player just inside the destination's matching gate. Mirror both
    // the re-spawn coordinates and the Position overlay so spawnPrefab and the
    // overlay agree.
    if (gateLink) {
      const arrival = mirrorPosition(body.z, gateLink.edge);
      body.x = arrival.x; body.y = arrival.y; body.z = arrival.z;
      body.player.position = arrival;
    }

    // Inform the coordinator (T-139 channel). Best-effort — gateway may
    // be down or the link may not be open yet.
    this.gatewayLink?.publish({
      type: "world_event",
      sourceTileId: this.tileId,
      event: {
        kind: "gate_approached",
        playerId: payload.entityId,
        destinationTileId: payload.destinationTileId,
        edge: gateLink?.edge ?? "north",
      },
    }).catch(() => {/* best-effort */});

    fetch(`${this.gatewayUrl}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (r.ok) {
        const ack = await r.json().catch(() => null) as
          | { destinationTileAddress?: string; destinationTileCertHashHex?: string }
          | null;
        const session = this.sessions.get(payload.entityId);
        // Send a final GateCrossing event on the reliable stream and AWAIT
        // the flush — sendStateRaw queues writes via a Promise chain, and
        // session.close() trips the queue's _closed guard if it runs before
        // the queued microtask. Without the await the GateCrossing bytes
        // never hit the wire and the client just sees the disconnect.
        if (session && ack?.destinationTileAddress) {
          this.sendGateCrossing(
            session,
            payload.entityId,
            ack.destinationTileAddress,
            ack.destinationTileCertHashHex ?? "",
          );
          await session.flush();
        }
        // Mark the player as handed-off BEFORE destroy/close so the
        // disconnect-cleanup path in handleSession knows to skip the
        // recordDeath branch — the entity is destroyed because we moved
        // them, not because they died.
        this.handedOff.add(payload.entityId);
        if (this.world.isAlive(payload.entityId)) this.world.destroy(payload.entityId);
        session?.close();
        this.sessions.delete(payload.entityId);
        console.log(
          `[TileServer] handoff complete: ${payload.entityId.slice(0, 8)} → ${payload.destinationTileId}`,
        );
      } else {
        console.error(`[TileServer] handoff failed for ${payload.entityId}: ${r.status}`);
      }
    }).catch((err: unknown) => {
      console.error("[TileServer] handoff fetch error:", err);
    }).finally(() => {
      this.handingOff.delete(payload.entityId);
      // T-256: don't let a handedOff marker outlive the operation. The success
      // path's own cleanup (destroy + sessions.delete) makes the subsequent
      // disconnect-cleanup superseded-return before it consumes the marker, so
      // a leaked entry would later swallow a real death's recordDeath for a
      // player who returned to this tile.
      this.handedOff.delete(payload.entityId);
    });
  }

  /**
   * Spawn a fresh player entity for `playerId` — the join-time spawn pipeline,
   * shared with respawn. Fetches heritage (the account service advances the
   * dynasty generation on death, so this returns the HEIR after a respawn),
   * spawns at the hearth when it's on this tile, writes the cached display
   * Name, and hydrates fog. Async (heritage + fog are HTTP).
   */
  private async spawnFreshPlayer(playerId: EntityId, hearthAnchor: SessionInfo["hearthAnchor"]): Promise<void> {
    const spawn = this.content.getGameConfig().player;
    const heritage = this.accountClient
      ? (await this.accountClient.getHeritage(playerId).catch((err: unknown) => {
          console.error("[TileServer] heritage fetch failed:", err);
          return null;
        })) ?? undefined
      : undefined;
    const spawnAtHearth = hearthAnchor && hearthAnchor.tileId === this.tileId;
    const spawnX = spawnAtHearth ? hearthAnchor.position.x : spawn.defaultSpawnX;
    const spawnY = spawnAtHearth ? hearthAnchor.position.y : spawn.defaultSpawnY;
    const spawnZ = spawnAtHearth ? hearthAnchor.position.z : undefined;
    if (spawnAtHearth) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} spawning at hearth (%.1f, %.1f)`, spawnX, spawnY);
    }
    spawnPrefab(this.world, this.content, "player", { id: playerId, x: spawnX, y: spawnY, z: spawnZ, heritage });

    const displayName = this.playerDisplayNames.get(playerId) ?? `Player-${playerId.slice(0, 6)}`;
    this.world.write(playerId, Name, { value: displayName });

    // Fog of war (T-161): hydrate from the account service. Non-fatal;
    // pendingSnapshot stays true so the next state message ships the bitmap.
    if (this.accountClient) {
      const fogBitmap = await this.accountClient.getFog(playerId, this.tileId).catch((err: unknown) => {
        console.error("[TileServer] fog fetch failed:", err);
        return null;
      });
      if (fogBitmap) {
        const fog = this.world.get(playerId, FogState);
        if (fog && fogBitmap.byteLength === fog.seenEver.byteLength) {
          fog.seenEver.set(fogBitmap);
          console.log(`[TileServer] fog restored for ${playerId.slice(0, 8)} on ${this.tileId}`);
        }
      }
    }
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
      await this.spawnFreshPlayer(playerId, null);
      console.log(`[TileServer] player ${playerId.slice(0, 8)} respawned (heir)`);
    } finally {
      this.respawning.delete(playerId);
    }
  }

  /**
   * Encode a one-off BinaryStateMessage carrying a single GateCrossing event
   * and push it to the player's reliable stream. Sequenced through the
   * session's write queue so it is delivered before the subsequent close().
   */
  private sendGateCrossing(
    session: ClientSession,
    entityId: EntityId,
    destinationTileAddress: string,
    destinationTileCertHashHex: string,
  ): void {
    const msg: BinaryStateMessage = {
      serverTick: this.tickLoop.currentTick,
      ackInputSeq: this.world.get(entityId, InputState)?.seq ?? 0,
      spawns: [],
      deltas: [],
      removals: [],
      destroys: [],
      events: [{
        type: "GateCrossing" as const,
        entityId,
        destinationTileAddress,
        destinationTileCertHashHex,
      }],
      fogSnapshot: null,
      fogReveals: new Uint16Array(0),
      onlineCount: this.sessions.size,
    };
    const payload = binaryStateMessageCodec.encode(msg);
    const framed = new Uint8Array(4 + payload.byteLength);
    new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
    framed.set(payload, 4);
    session.sendStateRaw(framed);
  }

  private spawnWorldState(content: ContentService): void {
    const dayLengthTicks = content.getGameConfig().dayNight.dayLengthTicks;
    const id = newEntityId();
    this.world.create(id);
    this.world.write(id, WorldClock, { ticksElapsed: 0, dayLengthTicks });
    console.log("[TileServer] world-state entity created");
    // Starter entities (workstations, nodes) are declared in tile_layout.json.
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

    if (this.world.isAlive(playerId)) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} rejoining (post-handoff)`);
    } else {
      await this.spawnFreshPlayer(playerId, info?.hearthAnchor ?? null);
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
        this.world, clientSession, this.spatial, playerId,
        new Map(), new Map(), new Set(), [], this.tickLoop.currentTick, 0,
        this.content.getGameConfig().network.aoiRadius,
        this.sessions.size,
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
    // T-253: a reconnect may have replaced the map entry with a NEW session —
    // this (old) session's cleanup must not delete it or destroy the
    // player the new session is serving.
    if (this.sessions.get(playerId) !== clientSession) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)}: stale session ended (superseded by reconnect)`);
      return;
    }
    // T-256: a handoff fetch is in flight — it owns the entity. A disconnect
    // here must NOT run normal cleanup (that records a wrong death / rewrites
    // last_tile_id back to ours / ghosts the entity on the destination). The
    // handoff's success path (destroy + delete) or the tile-sweep (on failure)
    // cleans up once handingOff clears.
    if (this.handingOff.has(playerId)) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)}: session ended mid-handoff — handoff owns the entity`);
      return;
    }
    this.sessions.delete(playerId);
    this.playerDisplayNames.delete(playerId);
    // Persist fog of war (T-161) before the entity (and its FogState) is
    // dropped.  Ordered BEFORE the handed-off early-return (T-256: it used to
    // run after, so fog was dropped on the rare crossing that reaches here).
    // Best-effort: errors log but never block disconnect cleanup.
    if (this.accountClient) {
      const fog = this.world.get(playerId, FogState);
      if (fog) {
        await this.accountClient.saveFog(playerId, this.tileId, fog.seenEver).catch((err: unknown) => {
          console.error("[TileServer] fog save failed:", err);
        });
      }
    }
    // Handoff already destroyed the entity + closed the session intentionally
    // (player moved to another tile). Don't treat that as a death or rewrite
    // the last_tile_id back to ours; the destination tile owns both now.
    const wasHandedOff = this.handedOff.delete(playerId);
    if (wasHandedOff) {
      console.log(`[TileServer] player ${playerId.slice(0, 8)} handed off (no death recorded)`);
      return;
    }
    if (this.world.isAlive(playerId)) {
      // T-252: take the carried item entities along (players respawn fresh).
      destroyCarriedItemEntities(this.world, playerId);
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

