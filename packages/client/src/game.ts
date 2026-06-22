/// <reference lib="dom" />
/**
 * VoximGame — top-level game object.
 *
 * Accepts a canvas and a gateway URL. Auth, connect screens, and surrounding UI
 * live in the parent application (separate repo/stack).
 *
 * Lifecycle:
 *   1. start()  — gateway handshake → tile connection → render loop
 *   2. stop()   — tears down connections and renderer
 */
import { connectViaGateway } from "./connection/gateway_client.ts";
import { TileConnection } from "./connection/tile_connection.ts";
import type { CharacterCreation } from "./connection/tile_connection.ts";
import { InputCapture } from "./input/input_capture.ts";
import { IntentRouter } from "./input/intent_router.ts";
import { IntentTranslator } from "./input/intent_translator.ts";
import type { Intent } from "./input/intents.ts";
import { modeState, cursorCellState, type WorldCell } from "./input/context.ts";
import { ClientWorld } from "./state/client_world.ts";
import { ContentCache } from "./state/content_cache.ts";
import { FogOfWar } from "./state/fog_of_war.ts";
import { VoximRenderer } from "./render/renderer.ts";
import { SwingPredictor } from "./render/swing_predictor.ts";
import { BuildGhostRenderer } from "./render/build_ghost.ts";
import { HoverOutlineRenderer } from "./render/hover_outline.ts";
import { ForestPropsRenderer } from "./render/forest_props.ts";
import { WaterRenderer } from "./render/water_renderer.ts";
import { canopyFade } from "./render/canopy_fade.ts";
import { InteractionSystem } from "./interaction/interaction_system.ts";
import { makeWorkstationHandler, makeTraderHandler, resourceNodeHandler, makeGroundItemHandler } from "./interaction/interactable_handlers.ts";
import { WorldOverlay } from "./ui/world_overlay.ts";
import { mountUI } from "./ui/mount_ui.tsx";
import { uiState, patchUI, openPanel, closePanel, pushToast } from "./ui/ui_store.ts";
import { setClientWorld, setLocalPlayerId } from "./ui/client_world_ref.ts";
import { currentZoneName, currentZoneRole, currentZoneTraversal } from "./ui/zone_ref.ts";
import { setContentService } from "./ui/content_ref.ts";
import { setFogRef } from "./ui/fog_ref.ts";
import type { UIAction } from "./ui/ui_actions.ts";
import { humanizeItemType } from "./ui/item_names.ts";
import { recordInput, recordState, recordSnapshot } from "./ui/network_capture.ts";
import { setDebugLayer, setDebugItemList } from "./ui/debug_store.ts";
import { loadLoginName } from "./ui/login.ts";
import { ACTION_USE_SKILL, ACTION_JUMP, hasAction, CommandType, EquipSlotIndex, EQUIP_SLOT_NAMES } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { EquipmentData, InventoryData, LoreLoadoutData, ResourceData, ActiveActionsData } from "@voxim/codecs";
import type { EquipmentState, InventoryState, ItemStack, SkillLoadoutState } from "./ui/ui_store.ts";
import { DEFAULT_PHYSICS } from "@voxim/engine";
import { Predictor } from "./prediction/predictor.ts";
import { BootstrapSource } from "@voxim/content";
import type { ContentService, Prefab, ToolData } from "@voxim/content";
import gameConfigData from "../../content/data/game_config.json" with { type: "json" };

export interface GameConfig {
  canvas: HTMLCanvasElement;
  /**
   * Base HTTP URL of the gateway, e.g. "http://localhost:8081".
   * Used in production. Mutually exclusive with directTile.
   * When set, `sessionToken` is required — the gateway refuses connections
   * without a valid session token.
   */
  gatewayUrl?: string;
  /**
   * Session token from POST /account/login on the gateway. Required with
   * gatewayUrl; ignored with directTile (dev-only mode has no auth).
   */
  sessionToken?: string;
  /**
   * Direct connection to a tile server — skips the gateway entirely.
   * Used for demo/dev. address is "hostname:port".
   */
  directTile?: { address: string; certHashHex?: string };
  /**
   * Character-creation selections (T-071) for a fresh character — chosen
   * species + lore picks. Carried in the join handshake; the server validates
   * them against content and silently falls back to its defaults. Omit for an
   * existing character (the server keeps the default / cached choice).
   */
  creation?: CharacterCreation;
}

/**
 * Range (world units) for the E-key "grab nearest item" fallback.  Slightly
 * larger than the server's pickupRadius so the client request always reaches
 * the server when the player perceives the item as close — the server makes
 * the final call and rejects out-of-range requests silently.
 */
const E_PICKUP_FALLBACK_RANGE = 3.0;

export class VoximGame {
  private connection: TileConnection = new TileConnection();
  private world = new ClientWorld();
  /**
   * Fog-of-war state (T-157).  Lives on Game (not the renderer) because
   * server fog messages can arrive during `connect()` before the renderer
   * has been constructed; ClientWorld follows the same pattern.  The
   * renderer is given a reference once it's built so its EdgePass shader
   * can sample the texture.
   */
  private fog = new FogOfWar();
  private content: ContentCache | null = null;
  /**
   * ContentService hydrated from the WT-handshake bootstrap blob (T-177).
   * Replaces the static-bundled `*_static.ts` imports for non-renderer
   * consumers (UI panels, debug item list, weapon-action lookup). Held
   * here so tile transitions can swap it for the new tile's blob.
   */
  private contentService: ContentService | null = null;
  private renderer: VoximRenderer | null = null;
  private overlay: WorldOverlay | null = null;
  private input: IntentTranslator | null = null;
  private inputCapture: InputCapture | null = null;
  private intentRouter: IntentRouter | null = null;
  private animFrameId = 0;
  private playerId: string | null = null;
  private inputSeq = 0;
  private commandSeq = 0;
  private serverTick = 0;
  private running = false;
  private predictor: Predictor | null = null;
  private lastFrameTime = 0;
  private interactionSystem: InteractionSystem | null = null;
  private buildGhost: BuildGhostRenderer | null = null;
  private hoverOutline: HoverOutlineRenderer | null = null;
  private forestProps: ForestPropsRenderer | null = null;
  private waterRenderer: WaterRenderer | null = null;
  /** Throttle key for the "missing materials" toast — avoids spam on every swing. */
  private _lastMissingToastKey: string | null = null;

  /** Rolling FPS sampler — counts frames between publish ticks. */
  private fpsFrames = 0;
  /** Wall-clock at which the current FPS sampling window started. */
  private fpsWindowStart = 0;
  /** Per-section CPU time accumulators (ms), averaged over the FPS window. */
  private timingAccum = { frame: 0, sk: 0, trail: 0, gl: 0, post: 0 };
  /** Last `onlineCount` shipped via state message; pushed to UIState as it changes. */
  private lastOnlineCount = -1;
  /**
   * Recently-sent input timestamps keyed by seq.  When a state message
   * arrives with `ackInputSeq`, we look up the original send timestamp
   * to compute round-trip time. Map is pruned on lookup so older entries
   * fall off when their seq is acked or eclipsed.
   */
  private readonly inputSentAt = new Map<number, number>();
  /** Combo-chain prediction for the local player. Stateless across server ticks; carries only the press-hold timer. */
  private readonly swingPredictor = new SwingPredictor();
  /** Smoothed RTT in ms (EMA, α = 0.2). 0 until the first ack arrives. */
  private smoothedPingMs = 0;
  /** Latest `ackInputSeq` from the server; used to compute input lag. */
  private lastAckedSeq = 0;

  /** Total terrain chunks expected per tile (32×32 chunks of 16×16 = 256). */
  private static readonly TOTAL_CHUNKS = 256;

  private terrainChunksReceived = 0;
  /** True once all terrain AND all entity models are preloaded. */
  private loadingComplete = false;
  /** Session token kept around so tile transitions can re-join without re-auth. */
  private tileToken: string | null = null;
  /** True while a tile transition is in flight; suppresses onClose→stop(). */
  private transitioning = false;

  async start(config: GameConfig): Promise<void> {
    // Step 1: wire message handlers BEFORE connecting — eliminates the race where
    // the server's full snapshot arrives during connect() while handlers are still null.
    // All renderer/hud references use optional chaining — safe before they are created.
    this._wireConnectionHandlers(this.connection);

    // Step 2: resolve tile address (via gateway, or direct for demo/dev)
    const { canvas } = config;
    let tileAddress: string;
    let certHashHex: string | undefined;

    // Tile join needs a playerId and a token. In gateway mode both come from
    // the handshake. In direct-tile dev mode we fabricate a stand-in pair
    // (random playerId, literal "dev-token") since the tile runs without an
    // account client and trusts the claim.
    let tileToken: string;
    if (config.directTile) {
      tileAddress = config.directTile.address;
      certHashHex = config.directTile.certHashHex;
      this.playerId = this.playerId ?? crypto.randomUUID();
      tileToken = "dev-token";
    } else {
      if (!config.sessionToken) {
        throw new Error("gatewayUrl mode requires sessionToken — log in first and pass the returned token");
      }
      const gatewayResult = await connectViaGateway(config.gatewayUrl!, config.sessionToken);
      this.playerId = gatewayResult.playerId;
      tileAddress = gatewayResult.tileAddress;
      tileToken = config.sessionToken;
      certHashHex = gatewayResult.tileCertHashHex;
    }
    this.tileToken = tileToken;

    // Step 3: connect — handlers are already wired so no messages can be dropped
    console.log(`[Game] connecting to tile ${tileAddress} as ${this.playerId.slice(0, 8)}`);
    const assignedId = await this.connection.connect(
      tileAddress, this.playerId, tileToken,
      loadLoginName() ?? "",
      certHashHex,
      config.creation,
    );
    this.playerId = assignedId;
    console.log(`[Game] tile-assigned player ID: ${this.playerId}`);
    (globalThis as unknown as Record<string, unknown>)._voxim_connected = true;

    // Step 4: renderer, content cache, HUD, input — push any world state that
    // arrived during connect() into the renderer now that it exists.
    this.content = new ContentCache(this.connection);
    // Decode the bootstrap blob into a full ContentService (T-177). Receiving
    // this from the same tile-server we just connected to guarantees the
    // client and server agree on content version — no drift, no mismatched
    // ids. Subsequent reconnects pick up server-side content edits for free.
    const blob = this.connection.bootstrapBlob();
    if (blob) {
      this.contentService = await BootstrapSource.load(blob);
      setContentService(this.contentService);
      this.content.setBootstrapService(this.contentService);
      console.log(`[Game] content service hydrated: ${this.contentService.prefabs.size} prefabs, ${this.contentService.materials.size} materials, ${this.contentService.skeletons.size} skeletons, ${this.contentService.animationLibraries.size} animation libraries`);
    } else {
      console.warn("[Game] no bootstrap blob received — falling back to static-bundled content");
    }
    this.renderer = new VoximRenderer(canvas);
    this.renderer.setLocalPlayer(this.playerId!);
    setLocalPlayerId(this.playerId!);
    this.renderer.setContentCache(this.content);
    // Renderer-facing weapon actions + item prefabs sourced from the
    // bootstrap-delivered ContentService (T-177 phase 3).  Items are
    // filtered to those that look like inventory items (have an
    // equippable / swingable / tool / consumable / deployable component) —
    // mirrors what the static `item_prefabs` aggregation contained.
    if (this.contentService) {
      this.renderer.setWeaponActions([...this.contentService.weaponActions.values()]);
      const itemPrefabs: Prefab[] = [];
      for (const p of this.contentService.prefabs.values()) {
        const c = p.components;
        if ("equippable" in c || "swingable" in c || "tool" in c
            || "edible" in c || "deployable" in c || "stackable" in c
            || "weight" in c) {
          itemPrefabs.push(p);
        }
      }
      this.renderer.setItemPrefabs(itemPrefabs);
      setDebugItemList(itemPrefabs.map((p) => ({ id: p.id })));
    }

    // Mount world overlay (entity health bars, floating damage numbers — frame-driven)
    this.overlay = new WorldOverlay();

    // Mount Preact UI into <div id="ui"> — must exist in the HTML host page
    mountUI((a) => this._handleUIAction(a));
    // Expose the live world to UI components that need to read entity state
    // (tooltips reading per-instance Stats, provenance, etc.) without prop
    // threading.
    setClientWorld(this.world);
    setFogRef(this.fog);
    this.renderer.attachFog(this.fog);

    // Count any terrain chunks that arrived during connect() (before renderer existed).
    // Don't push to renderer yet — _finishLoading() does that after all chunks arrive.
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap) this.terrainChunksReceived++;
      if (state.worldClock) {
        this.renderer?.setDayPhase(worldClockPhase(state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks));
      }
      if (entityId === this.playerId) {
        if (state.health)      patchUI({ health:       { current: state.health.current, max: state.health.max } });
        if (state.resource)    patchUI(vitalsPatch(state.resource));
        if (state.actionCooldowns) patchUI({ skillCooldowns: state.actionCooldowns });
        if (state.activeActions)   patchUI({ castState: deriveCastState(state.activeActions, this.contentService) });
        if (state.equipment)   patchUI({ equipment:    mapEquipmentToUI(state.equipment) });
        if (state.inventory)   patchUI({ inventory:    mapInventoryToUI(state.inventory, this.world) });
        if (state.loreLoadout) patchUI({ skillLoadout: mapLoreLoadoutToUI(state.loreLoadout) });
      }
    }
    patchUI({ loadingProgress: Math.min(1, this.terrainChunksReceived / VoximGame.TOTAL_CHUNKS) });
    console.log(`[Game] startup complete; terrain chunks pre-received during connect: ${this.terrainChunksReceived}/${VoximGame.TOTAL_CHUNKS}`);
    if (!this.loadingComplete && this.terrainChunksReceived >= VoximGame.TOTAL_CHUNKS) {
      this._finishLoading();
    }
    // Input system — Capture (DOM listeners) → Translator (state + intents)
    // → Router (handlers). Replaces the old InputController callback surface.
    this.intentRouter = new IntentRouter();
    this.input = new IntentTranslator(
      this.intentRouter,
      () => this.renderer!.getPlayerScreenPos(),
      (cx, cy) => this.renderer!.getCursorFacing(cx, cy),
    );
    this.inputCapture = new InputCapture(canvas, this.input.handle);

    // Interaction system — entity hover highlight + click dispatch.
    this.interactionSystem = new InteractionSystem(this.renderer, this.world);
    this.interactionSystem.register(makeWorkstationHandler((entityId) => this._openWorkstation(entityId)));
    this.interactionSystem.register(makeTraderHandler((entityId) => this._openTrader(entityId)));
    this.interactionSystem.register(resourceNodeHandler);
    this.interactionSystem.register(makeGroundItemHandler((entityId) =>
      this._sendCommand({ cmd: CommandType.PickUp, entityId }),
    ));
    this.renderer.setInteractionSystem(this.interactionSystem);

    this._registerIntentHandlers();

    // Build-mode ghost renderer — subscribes to modeState + cursorCellState.
    this.buildGhost = new BuildGhostRenderer(
      this.renderer.scene,
      (x, y) => this.world.getTerrainHeight(x, y),
    );

    // Hover outline — subscribes to hoverState; decides outline tint per
    // entity category and feeds the silhouette into the EdgePass mask.
    this.hoverOutline = new HoverOutlineRenderer(this.renderer, this.world);

    // Forest decoration — subscribes to chunk KindGrid arrivals and spawns
    // synthetic tree props at every FOREST pixel via the same instanced
    // pool the regular entity props use. Entirely client-side; the server
    // never carries individual tree entities. Replays already-loaded chunks
    // on registration so chunks that arrived during connect() get decorated.
    this.forestProps = new ForestPropsRenderer(
      this.renderer.instancePool, this.content, this.world,
    );

    // Water surface (T-159) — translucent overlay over WATER cells, animated
    // via a uTime-driven shader.  Same KindGrid hook the forest renderer
    // uses; no server-side water entities.
    this.waterRenderer = new WaterRenderer(this.renderer.scene, this.world);

    // Step 5: predictor + render loop
    this.predictor = new Predictor(DEFAULT_PHYSICS, {
      // deno-lint-ignore no-explicit-any
      correctionHalfLifeMs: (gameConfigData as any).prediction?.correctionHalfLifeMs ?? 60,
      // deno-lint-ignore no-explicit-any
      hardSnapThresholdUnits: (gameConfigData as any).prediction?.hardSnapThresholdUnits ?? 2.0,
    });
    this.lastFrameTime = performance.now();
    this.running = true;
    this.scheduleFrame();
  }

  /**
   * Wire the per-message callbacks on a TileConnection. Called once during
   * `start()` and again per tile transition (T-141), since each transition
   * builds a fresh connection.
   */
  private _wireConnectionHandlers(conn: TileConnection): void {
    conn.onSnapshot = (snap) => {
      this.serverTick = snap.serverTick;
      this.world.applySnapshot(snap);
      recordSnapshot(snap);
      for (const e of snap.entities) {
        const state = this.world.get(e.entityId);
        if (state?.position) this.renderer?.updateEntity(e.entityId, state);
      }
    };

    conn.onStateMessage = (msg) => {
      this.serverTick = msg.serverTick;
      recordState(msg);

      if (msg.onlineCount !== this.lastOnlineCount) {
        this.lastOnlineCount = msg.onlineCount;
        patchUI({ hudStats: { ...uiState.value.hudStats, onlineCount: msg.onlineCount } });
      }

      // RTT — find the wall-clock timestamp we stamped when sending the
      // input that this state message acknowledges.  Drop it and any
      // older entries from the buffer (their seqs are now eclipsed).
      const sentAt = this.inputSentAt.get(msg.ackInputSeq);
      if (sentAt !== undefined) {
        const rtt = Date.now() - sentAt;
        // EMA with α=0.2 — smooth enough to read but reactive to spikes.
        this.smoothedPingMs = this.smoothedPingMs === 0
          ? rtt
          : this.smoothedPingMs * 0.8 + rtt * 0.2;
      }
      this.lastAckedSeq = msg.ackInputSeq;
      // Prune everything ≤ acked seq. Keys are integers; iterate once.
      for (const seq of this.inputSentAt.keys()) {
        if (seq <= msg.ackInputSeq) this.inputSentAt.delete(seq);
      }

      // Fog of war (T-157) — server is authoritative for `seenEver`.
      // Snapshots arrive on the first state message after join (and on resync);
      // reveal lists ride every tick that uncovered new cells.  Applied to
      // the Game-owned FogOfWar so messages received during connect() (before
      // the renderer is built) aren't dropped.
      if (msg.fogSnapshot) {
        this.fog.applySnapshot(msg.fogSnapshot);
      }
      if (msg.fogReveals.length > 0) {
        this.fog.applyReveals(msg.fogReveals);
      }

      const updated = new Set<string>();
      for (const spawn of msg.spawns) {
        this.world.applySpawn(spawn);
        updated.add(spawn.entityId);
      }
      for (const delta of msg.deltas) {
        this.world.applyDelta(delta);
        updated.add(delta.entityId);
      }
      for (const rm of msg.removals) {
        this.world.applyRemoval(rm.entityId, rm.componentType);
        updated.add(rm.entityId);
      }
      for (const entityId of msg.destroys) {
        this.world.applyDestroy(entityId);
        this.renderer?.removeEntity(entityId);
        this.renderer?.removeGateMarker(entityId);
        this.overlay?.removeEntityBar(entityId);
        this.overlay?.removeGateLabel(entityId);
      }

      for (const entityId of updated) {
        const state = this.world.get(entityId);
        if (!state) continue;
        if (state.heightmap && state.materialGrid) {
          this.terrainChunksReceived++;
          patchUI({ loadingProgress: Math.min(1, this.terrainChunksReceived / VoximGame.TOTAL_CHUNKS) });
          if (this.terrainChunksReceived % 20 === 0 || this.terrainChunksReceived === VoximGame.TOTAL_CHUNKS) {
            console.log(`[Game] terrain chunks received: ${this.terrainChunksReceived}/${VoximGame.TOTAL_CHUNKS}`);
          }
          // During loading: don't push to renderer yet — keeps JS thread free so
          // QUIC flow control isn't starved.  _finishLoading() flushes everything.
          if (this.loadingComplete) this.renderer?.updateTerrain(state.heightmap, state.materialGrid);
        } else if (state.gateLink && state.position) {
          // Gate entities are rendered as standalone navigational markers,
          // not via the regular entity mesh path (no modelRef, no skeleton).
          // Pin the pillar to local terrain height so it stands on the ground.
          if (this.loadingComplete) {
            const groundZ = this.world.getTerrainHeight(state.position.x, state.position.y);
            this.renderer?.updateGateMarker(
              entityId, state.position.x, state.position.y, groundZ, state.gateLink.edge,
            );
          }
        } else if (state.position) {
          if (this.loadingComplete) this.renderer?.updateEntity(entityId, state);
        }
        if (state.worldClock) {
          this.renderer?.setDayPhase(worldClockPhase(state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks));
        }
        if (entityId === this.playerId) {
          if (state.health)    patchUI({ health:    { current: state.health.current, max: state.health.max } });
          if (state.resource)  patchUI(vitalsPatch(state.resource));
          if (state.actionCooldowns) patchUI({ skillCooldowns: state.actionCooldowns });
          if (state.activeActions)   patchUI({ castState: deriveCastState(state.activeActions, this.contentService) });
          if (state.equipment) {
            patchUI({ equipment: mapEquipmentToUI(state.equipment) });
            if (this.input) {
              const toolType = getToolType(state.equipment.weapon?.prefabId, this.contentService);
              const newBuildMode = toolType === "hammer";
              if (newBuildMode !== this.input.buildMode) {
                console.log(`[Build] buildMode=${newBuildMode} weapon=${state.equipment.weapon?.prefabId ?? "none"} toolType=${toolType ?? "none"}`);
                this.input.buildMode = newBuildMode;
                // Hammer unequipped while in build mode → cancel any staged
                // blueprint selection. Routed through the intent so handlers
                // stay the single source of mode-clear logic.
                if (!newBuildMode && modeState.value.kind === "build") {
                  this.intentRouter?.dispatch({ kind: "build-cancel" });
                }
              }
            }
          }
          if (state.inventory) patchUI({ inventory: mapInventoryToUI(state.inventory, this.world) });
          if (state.loreLoadout) patchUI({ skillLoadout: mapLoreLoadoutToUI(state.loreLoadout) });
        }
        // Mirror buffer/tag updates on the open workstation entity into uiState
        // so the panel reflects loads/takes/recipe progress without polling.
        if (uiState.value.workstation?.entityId === entityId) {
          this._mirrorWorkstationToUi(entityId);
        }
        // Trade panel: refresh when the open trader's stock OR the player's
        // inventory (coins/goods) changes, so prices and the sell list stay live.
        const traderId = uiState.value.trader?.npcId;
        if (traderId && (entityId === traderId || entityId === this.playerId)) {
          this._mirrorTraderToUi(traderId);
        }
      }

      // Workstation panel cleanup: if the entity left AoI / was destroyed,
      // the world drop happened above and the mirror would no-op — but the
      // panel still has stale state. Close it so the next click can reopen.
      const wsId = uiState.value.workstation?.entityId;
      if (wsId && msg.destroys.includes(wsId)) {
        closePanel("workstation");
      }
      const trId = uiState.value.trader?.npcId;
      if (trId && msg.destroys.includes(trId)) {
        closePanel("trader");
      }

      if (!this.loadingComplete && this.terrainChunksReceived >= VoximGame.TOTAL_CHUNKS) {
        this._finishLoading();
      }

      // Client-side prediction reconciliation
      if (this.predictor && this.playerId) {
        const playerState = this.world.get(this.playerId);
        const pos = playerState?.position;
        const vel = playerState?.velocity;
        if (pos) {
          const terrainFn = (x: number, y: number) => this.world.getTerrainHeight(x, y);
          const isOpenFn  = (x: number, y: number) => this.world.isOpen(x, y);
          const serverVel = vel ?? { x: 0, y: 0, z: 0 };
          if (!this.predictor.isInitialised) {
            this.predictor.seed(pos, serverVel);
          } else {
            this.predictor.reconcile(msg.ackInputSeq, pos, serverVel, terrainFn, isOpenFn);
          }
        }
      }

      for (const ev of msg.events) {
        switch (ev.type) {
          case "DamageDealt": {
            const blocked = ev.blocked ? " (blocked)" : "";
            console.log(`[Event] DamageDealt target=${ev.targetId.slice(-6)} source=${ev.sourceId.slice(-6)} amount=${ev.amount.toFixed(1)}${blocked}`);
            const screenPos = this.renderer?.getEntityScreenPos(ev.targetId);
            if (screenPos) this.overlay?.showDamage(screenPos.x, screenPos.y, Math.round(ev.amount), ev.blocked);
            break;
          }
          case "HitSpark":
            this.renderer?.spawnHitSpark(ev.x, ev.y, ev.z);
            break;
          case "Healed": {
            const screenPos = this.renderer?.getEntityScreenPos(ev.entityId);
            if (screenPos) this.overlay?.showHeal(screenPos.x, screenPos.y, Math.round(ev.amount));
            break;
          }
          case "EntityDied":
            console.log(`[Event] EntityDied entity=${ev.entityId.slice(-6)}${ev.killerId ? ` killer=${ev.killerId.slice(-6)}` : ""}`);
            if (ev.entityId === this.playerId) {
              openPanel("death", true);
              pushToast("You died", "danger");
            }
            break;
          case "HungerCritical":
            console.log(`[Event] HungerCritical entity=${ev.entityId.slice(-6)}`);
            if (ev.entityId === this.playerId) pushToast("Starving!", "warn");
            break;
          case "DayPhaseChanged": {
            console.log(`[Event] DayPhaseChanged phase=${ev.phase} time=${ev.timeOfDay.toFixed(2)}`);
            const labels: Record<string, string> = { dawn: "Dawn", noon: "Noon", dusk: "Dusk", midnight: "Midnight" };
            pushToast(labels[ev.phase] ?? ev.phase, "info");
            this.renderer?.setDayPhase(ev.phase);
            break;
          }
          case "CraftingCompleted":
            console.log(`[Event] CraftingCompleted crafter=${ev.crafterId.slice(-6)} recipe=${ev.recipeId}`);
            if (ev.crafterId === this.playerId) pushToast(`Crafted: ${ev.recipeId}`, "success");
            break;
          case "BuildingCompleted":
            console.log(`[Event] BuildingCompleted builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
            if (ev.builderId === this.playerId) {
              pushToast(`Built: ${humanizeItemType(ev.structureType)}`, "success");
              this._lastMissingToastKey = null;
            }
            break;
          case "BuildingMaterialsConsumed":
            console.log(`[Event] BuildingMaterialsConsumed builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
            if (ev.builderId === this.playerId) {
              const lines = ev.consumed.map((c) => `${c.quantity}× ${humanizeItemType(c.itemType)}`).join(", ");
              pushToast(`Materials used: ${lines}`, "info");
            }
            break;
          case "BuildingMissingMaterials": {
            console.log(`[Event] BuildingMissingMaterials builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
            if (ev.builderId === this.playerId) {
              // Throttle: only toast once per unique (structureType, missing list) combination
              const key = ev.structureType + ":" + ev.missing.map((m) => `${m.itemType}×${m.quantity}`).join(",");
              if (key !== this._lastMissingToastKey) {
                this._lastMissingToastKey = key;
                const lines = ev.missing.map((m) => `${m.quantity}× ${humanizeItemType(m.itemType)}`).join(", ");
                pushToast(`Missing: ${lines}`, "warn");
              }
            }
            break;
          }
          case "NodeDepleted":
            console.log(`[Event] NodeDepleted node=${ev.nodeId.slice(-6)} type=${ev.nodeTypeId} harvester=${ev.harvesterId.slice(-6)}`);
            if (ev.harvesterId === this.playerId) pushToast(`${ev.nodeTypeId} depleted`, "info");
            break;
          case "GateApproached":
            console.log(`[Event] GateApproached entity=${ev.entityId.slice(-6)} gate=${ev.gateId} dest=${ev.destinationTileId}`);
            if (ev.entityId === this.playerId) pushToast(`Entering ${ev.destinationTileId}`, "info");
            break;
          case "GateCrossing":
            console.log(`[Event] GateCrossing entity=${ev.entityId.slice(-6)} → ${ev.destinationTileAddress}`);
            if (ev.entityId === this.playerId) {
              this._transitionToTile(ev.destinationTileAddress, ev.destinationTileCertHashHex);
            }
            break;
          case "TradeCompleted":
            console.log(`[Event] TradeCompleted buyer=${ev.buyerId.slice(-6)} item=${ev.itemType} qty=${ev.quantity} coins=${ev.coinDelta}`);
            if (ev.buyerId === this.playerId) {
              const coins = ev.coinDelta > 0 ? `-${ev.coinDelta}` : `+${-ev.coinDelta}`;
              pushToast(`${ev.quantity}x ${ev.itemType} (${coins} coins)`, "success");
            }
            break;
          case "LoreExternalised":
            console.log(`[Event] LoreExternalised entity=${ev.entityId.slice(-6)} fragment=${ev.fragmentId}`);
            if (ev.entityId === this.playerId) pushToast(`Fragment written: ${ev.fragmentId}`, "info");
            break;
          case "LoreInternalised":
            console.log(`[Event] LoreInternalised entity=${ev.entityId.slice(-6)} fragment=${ev.fragmentId}`);
            if (ev.entityId === this.playerId) pushToast(`Lore absorbed: ${ev.fragmentId}`, "success");
            break;
          case "ZoneEntered":
            if (ev.playerId === this.playerId) {
              // Empty name = sub-threshold zone or no-zone band; clear
              // the HUD caption rather than show "You are in: ".
              currentZoneName.value = ev.zoneName;
              currentZoneRole.value = ev.topologyRole;
              currentZoneTraversal.value = ev.traversal;
              if (ev.zoneName) pushToast(`Entering: ${ev.zoneName}`, "info");
            }
            break;
        }
      }
    };

    conn.onClose = () => {
      // During tile transitions we deliberately close the source connection;
      // the new connection is what runs after _transitionToTile() returns.
      // Don't tear the game down in that case.
      if (this.transitioning) return;
      console.log("[Game] disconnected");
      this.stop();
    };
  }

  /**
   * Tile transition (T-141). The source tile sends a final GateCrossing event
   * carrying the destination's WT address + cert fingerprint, then tombstones
   * the player. We close the old connection, wipe per-tile world state, open
   * a fresh WT to the destination, and let the join handshake plus its first
   * state message rehydrate the world. The renderer, content cache, UI, input,
   * and predictor are all preserved across the swap — only the connection +
   * world entities + terrain churn.
   */
  private async _transitionToTile(address: string, certHashHex: string): Promise<void> {
    if (this.transitioning) return;
    if (!this.playerId || !this.tileToken) {
      console.error("[Game] tile transition without playerId/token — aborting");
      return;
    }
    this.transitioning = true;
    console.log(`[Game] tile transition → ${address}`);
    pushToast("Crossing tile boundary…", "info");
    patchUI({ loading: true, loadingProgress: 0 });

    // Tear down old connection. onClose is a no-op while transitioning is set.
    this.connection.close();

    // Wipe per-tile state. The renderer instance is kept; only its scene
    // contents go.
    this.forestProps?.reset();
    this.waterRenderer?.clear();
    this.world.clear();
    this.renderer?.clearWorld();
    this.terrainChunksReceived = 0;
    this.loadingComplete = false;
    this.predictor?.reset();

    // Fresh connection — handlers reference `this` so they keep working.
    const conn = new TileConnection();
    this._wireConnectionHandlers(conn);
    this.connection = conn;
    if (this.content) this.content.attachConnection(conn);

    try {
      const assignedId = await conn.connect(
        address, this.playerId, this.tileToken,
        loadLoginName() ?? "",
        certHashHex || undefined,
      );
      this.playerId = assignedId;
      this.renderer?.setLocalPlayer(this.playerId);
      setLocalPlayerId(this.playerId);
      // Re-hydrate ContentService from the new tile-server's blob — content
      // could have changed across the boundary (different version, different
      // tile-specific overrides). Picks up server restarts for free.
      const blob = conn.bootstrapBlob();
      if (blob) {
        this.contentService = await BootstrapSource.load(blob);
        setContentService(this.contentService);
        this.content?.setBootstrapService(this.contentService);
        console.log(`[Game] content service re-hydrated for new tile`);
      }
      console.log(`[Game] transition complete; reconnected as ${this.playerId.slice(0, 8)}`);
    } catch (err) {
      console.error("[Game] tile transition failed:", err);
      pushToast("Failed to enter the next tile", "danger");
      this.transitioning = false;
      this.stop();
      return;
    }
    this.transitioning = false;
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    this.animFrameId = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;

    const tFrameStart = performance.now();
    const now = tFrameStart;
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    // FPS sampler — accumulate frames, publish ~twice per second. Cheap and
    // keeps the HUD readable (raw per-frame fps fluctuates too fast to read).
    this.fpsFrames++;
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    const fpsWindowMs = now - this.fpsWindowStart;
    if (fpsWindowMs >= 500) {
      const f = this.fpsFrames || 1;
      const fps       = Math.round(this.fpsFrames * 1000 / fpsWindowMs);
      const frameMs   = +(this.timingAccum.frame / f).toFixed(1);
      const skMs      = +(this.timingAccum.sk    / f).toFixed(1);
      const trailMs   = +(this.timingAccum.trail / f).toFixed(1);
      const glMs      = +(this.timingAccum.gl    / f).toFixed(1);
      const postMs    = +(this.timingAccum.post  / f).toFixed(1);
      const drawCalls = this.renderer?.frameTimings.drawCalls ?? 0;
      const tris      = this.renderer?.frameTimings.tris      ?? 0;
      // Drain network counters since the last window so we can derive
      // bandwidth and tick rate from the counts and the window span.
      const net       = this.connection.drainNetStats();
      const tickHz    = +(net.messages * 1000 / fpsWindowMs).toFixed(1);
      const kbpsIn    = +(net.bytes * 8 / fpsWindowMs).toFixed(1);  // bytes·8/ms = kilobits/s
      const pingMs    = Math.round(this.smoothedPingMs);
      const inputLag  = Math.max(0, this.inputSeq - this.lastAckedSeq);
      const entities  = this.renderer?.entityCount ?? 0;
      const handles   = this.renderer?.instancePool.handleCount ?? 0;
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
      this.timingAccum = { frame: 0, sk: 0, trail: 0, gl: 0, post: 0 };
      patchUI({ hudStats: {
        ...uiState.value.hudStats,
        fps, frameMs, skMs, trailMs, glMs, postMs, drawCalls, tris,
        pingMs, inputLag, tickHz, kbpsIn, entities, handles,
      } });
    }

    let predictedPos = null;
    if (this.input) {
      const datagram = this.input.buildDatagram(++this.inputSeq, this.serverTick);
      this.connection.sendMovement(datagram);
      recordInput(datagram);
      // Track the send timestamp so we can derive RTT when this seq is
      // acked.  The Map is pruned on lookup so it stays small even if
      // some inputs are dropped on the unreliable datagram channel.
      this.inputSentAt.set(datagram.seq, datagram.timestamp);
      // Combo-chain swing prediction (T-188): pick the weapon action the
      // server is about to fire by combining the networked SwingChain.index
      // with the equipped weapon's swingable.chain and the local press-hold
      // timer (heavy variant if held past swingable.heavyChargeMs). Feeds
      // forceLocalAnimation so the trail / blade-attach catches up at press
      // time instead of waiting RTT/2 for the next AnimationState delta.
      // The predictor runs every frame, not just on press, so the heavy
      // promotion crosses correctly when held past the threshold.
      {
        const pressed = hasAction(datagram.actions, ACTION_USE_SKILL);
        const player = this.playerId ? this.world.get(this.playerId) : undefined;
        const weaponPrefabId = player?.equipment?.weapon?.prefabId;
        const prefab = weaponPrefabId
          ? this.contentService?.prefabs.get(weaponPrefabId)
          : undefined;
        const swingable = prefab?.components?.["swingable"] as
          | { chain: { light: string; heavy: string }[]; heavyChargeMs: number }
          | undefined;
        // Swing chains were folded into the action runtime (T-227) — there's no
        // client-side chain tracking anymore. Predict a basic swing on press
        // for responsiveness; chain-step variation arrives via the networked
        // AnimationState (derived from ActiveActions).
        const predicted = this.swingPredictor.predict(pressed, swingable ?? null, 0, performance.now());
        if (predicted) this.renderer?.forceLocalAnimation(predicted);
      }

      // Step predictor with this frame's input
      if (this.predictor?.isInitialised) {
        const physicsInput = {
          movement: { x: datagram.movementX, y: datagram.movementY },
          jump: hasAction(datagram.actions, ACTION_JUMP),
        };
        const terrainFn = (x: number, y: number) => this.world.getTerrainHeight(x, y);
        const isOpenFn  = (x: number, y: number) => this.world.isOpen(x, y);
        predictedPos = this.predictor.step(datagram.seq, physicsInput, dt, terrainFn, isOpenFn);
      }
    }
    // Update hover highlight — must happen after input so mouse coords are current
    if (this.input && this.interactionSystem) {
      this.interactionSystem.update(this.input.mouseX, this.input.mouseY);
    }
    // Publish the cursor's world cell so build-mode subscribers (ghost
    // renderer) can read it reactively. Done every frame so the ghost
    // tracks cursor movement without a per-frame poll on each subscriber.
    if (this.input) {
      const cell = this._cellFromCanvas(this.input.mouseX, this.input.mouseY);
      const prev = cursorCellState.value;
      if (!cell) {
        if (prev !== null) cursorCellState.value = null;
      } else if (!prev || prev.cellX !== cell.cellX || prev.cellY !== cell.cellY) {
        cursorCellState.value = cell;
      }
    }
    // Camera-occlusion fade — push the player's world position into the
    // shared canopyFade uniforms so every registered material (forest,
    // terrain, props) fades anything above the player along the camera
    // line of sight. Use the predicted position when available so the
    // fade tracks smooth client motion rather than the 20Hz snapshot.
    if (this.playerId && this.renderer) {
      const px = predictedPos?.x ?? this.world.get(this.playerId)?.position?.x;
      const py = predictedPos?.y ?? this.world.get(this.playerId)?.position?.y;
      const pz = predictedPos?.z ?? this.world.get(this.playerId)?.position?.z;
      if (px !== undefined && py !== undefined && pz !== undefined) {
        canopyFade.update(px, py, pz, this.renderer.camera);
      }
      // Fog-of-war LOS update (T-157) — predicted position + last-known
      // facing so the cone tracks smooth client motion.  Only the local
      // `currentlyVisible` arc is computed here; `seenEver` is server-driven
      // and arrives via BinaryStateMessage's fogSnapshot / fogReveals.
      if (px !== undefined && py !== undefined) {
        const facing = this.world.get(this.playerId)?.facing?.angle ?? 0;
        this.fog.updateLocalLOS(px, py, facing, (x, y) => this.world.isOpen(x, y));
      }
    }

    // Water animation: bump the shared shader's uTime + flush any chunks
    // whose kindGrid arrived before their heightmap.
    this.waterRenderer?.tick(now);

    this.renderer?.render(this.serverTick, predictedPos);

    const tPostStart = performance.now();
    // Update world-space entity health bars + gate labels (frame-driven, not reactive)
    if (this.overlay) {
      this.overlay.clearEntityBars();
      this.overlay.clearGateLabels();
      for (const [entityId, state] of this.world.entries()) {
        if (state.gateLink && state.position) {
          const sp = this.renderer?.getGateScreenPos(entityId);
          if (sp) this.overlay.setGateLabel(entityId, `→ ${state.gateLink.destinationTileId}`, sp.x, sp.y);
        }
        if (entityId === this.playerId) continue;
        if (!state.health || !state.position) continue;
        const pos = this.renderer?.getEntityScreenPos(entityId);
        if (pos) this.overlay.setEntityHealth(entityId, state.health.current, state.health.max, pos.x, pos.y);
      }
    }
    const tPostEnd = performance.now();

    // Accumulate per-section timings for the FPS sample window.
    if (this.renderer) {
      this.timingAccum.sk    += this.renderer.frameTimings.skMs;
      this.timingAccum.trail += this.renderer.frameTimings.trailMs;
      this.timingAccum.gl    += this.renderer.frameTimings.glMs;
    }
    this.timingAccum.post  += tPostEnd - tPostStart;
    this.timingAccum.frame += tPostEnd - tFrameStart;

    this.scheduleFrame();
  }

  /**
   * Send a CommandDatagram to the server.
   * Uses a separate monotonically increasing sequence space from movement datagrams.
   */
  private _sendCommand(command: CommandPayload): void {
    this.connection.sendCommand({ seq: ++this.commandSeq, command });
  }

  /**
   * Open the workstation panel for an entity. Refuses when the player is
   * outside the configured interact range — mirrors the server-side reach
   * check so the panel can never claim to interact with something the
   * server would refuse.
   */
  /**
   * Find the closest ground-item entity to the local player within `range`.
   * Used as the E-key fallback when the cursor isn't on a specific entity —
   * scanning the loaded world is cheap (a few hundred entities at most) and
   * keeps pickup forgiving without requiring precise cursor aim.
   */
  private _nearestGroundItem(range: number): string | null {
    const me = this.playerId ? this.world.get(this.playerId) : null;
    if (!me?.position) return null;
    const px = me.position.x, py = me.position.y;
    const r2 = range * range;
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const [entityId, state] of this.world.entries()) {
      if (!state.itemData || !state.position) continue;
      const dx = state.position.x - px;
      const dy = state.position.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 >= bestDist) continue;
      bestDist = d2;
      bestId = entityId;
    }
    return bestId;
  }

  private _openWorkstation(entityId: string): void {
    const ws = this.world.get(entityId);
    if (!ws?.workstationBuffer || !ws.workstationTag || !ws.position) return;
    const me = this.playerId ? this.world.get(this.playerId) : null;
    if (!me?.position) return;
    const dx = me.position.x - ws.position.x;
    const dy = me.position.y - ws.position.y;
    if (dx * dx + dy * dy > 3 * 3) {
      pushToast("Too far away", "warn");
      return;
    }
    this._mirrorWorkstationToUi(entityId);
    openPanel("workstation");
  }

  /**
   * Open the trade panel for a nearby trader NPC (T-075). Builds buy/sell offers
   * from the trader's networked `traderInventory.listings`: buy lists every
   * listing (with live stock), sell lists only the listings the player currently
   * holds. Both buttons dispatch the listing-slot index — the TraderSystem keys
   * buy and sell by the same slot.
   */
  private _openTrader(entityId: string): void {
    const tr = this.world.get(entityId);
    if (!tr?.traderInventory || !tr.position) return;
    const me = this.playerId ? this.world.get(this.playerId) : null;
    if (!me?.position) return;
    const dx = me.position.x - tr.position.x;
    const dy = me.position.y - tr.position.y;
    if (dx * dx + dy * dy > 3 * 3) {
      pushToast("Too far away", "warn");
      return;
    }
    this._mirrorTraderToUi(entityId);
    openPanel("trader");
  }

  /**
   * Snapshot a trader's catalogue + the player's coins/holdings into uiState.
   * Called on open and on every state-message touching the open trader or the
   * player entity, so the panel reflects stock + coin changes without polling.
   */
  private _mirrorTraderToUi(entityId: string): void {
    const tr = this.world.get(entityId);
    if (!tr?.traderInventory) return;
    const me = this.playerId ? this.world.get(this.playerId) : null;

    const currency = this.contentService?.getGameConfig().trade.currencyItemType ?? "coins";
    const nameOf = humanizeItemType;

    // Tally stackable holdings by prefabId (coins + sellable goods are stacks).
    const held = new Map<string, number>();
    for (const s of me?.inventory?.slots ?? []) {
      if (s.kind === "stack") held.set(s.prefabId, (held.get(s.prefabId) ?? 0) + s.quantity);
    }

    const listings = tr.traderInventory.listings;
    patchUI({
      trader: {
        npcId: entityId,
        npcName: tr.name?.value ?? "Trader",
        playerCoins: held.get(currency) ?? 0,
        buyOffers: listings.map((l, slot) => ({
          slot, itemType: l.itemType, displayName: nameOf(l.itemType),
          priceCoin: l.buyPrice, stock: l.stock < 0 ? null : l.stock,
        })),
        sellOffers: listings.flatMap((l, slot) => {
          const have = held.get(l.itemType) ?? 0;
          return have < 1 ? [] : [{
            slot, itemType: l.itemType, displayName: nameOf(l.itemType),
            priceCoin: l.sellPrice, stock: have,
          }];
        }),
      },
    });
  }

  /**
   * Snapshot the open workstation's networked state into uiState so the panel
   * stays purely reactive on the signal. Called both on initial open and on
   * every state-message that touches the open station.
   */
  private _mirrorWorkstationToUi(entityId: string): void {
    const state = this.world.get(entityId);
    if (!state?.workstationBuffer || !state.workstationTag) return;
    patchUI({
      workstation: {
        entityId,
        stationType:    state.workstationTag.stationType,
        capacity:       state.workstationBuffer.capacity,
        slots:          state.workstationBuffer.slots.map((s) => {
          if (!s) return null;
          return s.kind === "stack"
            ? { kind: "stack" as const, itemType: s.itemType, quantity: s.quantity }
            : { kind: "unique" as const, entityId: s.entityId, prefabId: s.prefabId };
        }),
        activeRecipeId: state.workstationBuffer.activeRecipeId,
      },
    });
  }

  /**
   * Register the world-side intent handlers. UI panels and the radial menu
   * keep their Preact onClick paths and dispatch via _handleUIAction (which
   * the router will eventually subsume entirely once T-131 lands its build
   * mode handlers).
   */
  private _registerIntentHandlers(): void {
    const router = this.intentRouter!;

    // World hover-aware interact (E key).  Cursor-driven first:
    //   ground item under cursor → PickUp
    //   workstation under cursor → open panel
    // When nothing's under the cursor, fall back to the nearest ground item
    // within E_PICKUP_FALLBACK_RANGE — drops landing two cells from the
    // depleted node should be grabbable without aiming the cursor at them.
    // The server validates range again via game_config.items.pickupRadius.
    router.register({
      id: "world-interact",
      priority: 50,
      claim: (intent: Intent) => {
        if (intent.kind !== "interact") return false;
        if (intent.hover.kind === "entity") {
          const entity = this.world.get(intent.hover.entityId);
          if (entity?.workstationBuffer) {
            this._openWorkstation(intent.hover.entityId);
            return true;
          }
          if (entity?.itemData) {
            this._sendCommand({ cmd: CommandType.PickUp, entityId: intent.hover.entityId });
            return true;
          }
        }
        const nearest = this._nearestGroundItem(E_PICKUP_FALLBACK_RANGE);
        if (nearest) this._sendCommand({ cmd: CommandType.PickUp, entityId: nearest });
        return true;
      },
    });

    // World main action (LMB release). Today the server picks the swing
    // variant from chargeMs (T-129); the client just forwards the bit on
    // the next datagram. The translator already sets ACTION_USE_SKILL +
    // chargeMs, so this handler exists mainly to claim the intent so other
    // handlers don't double-fire on the same release.
    router.register({
      id: "world-attack",
      priority: 40,
      claim: (intent: Intent) => {
        if (intent.kind !== "world-main-action") return false;
        // Pre-route entity click to the interaction system (workstation
        // open, etc.). LMB-pickup-anything legacy goes through here too:
        // a click on a workstation opens its panel even via LMB, matching
        // the previous onLmbClick behavior.
        if (intent.hover.kind === "entity") {
          const me = this.playerId ? this.world.get(this.playerId) : null;
          const px = me?.position?.x ?? 0;
          const py = me?.position?.y ?? 0;
          this.interactionSystem?.handleClick(this.input!.mouseX, this.input!.mouseY, px, py);
        }
        // The actual swing is sent through the next datagram via
        // pendingActions/chargeMs in the translator. Nothing to do here.
        return true;
      },
    });

    // Build-mode actions (T-131). Single-tool blueprints place one cell per
    // LMB. Polyline-tool blueprints anchor the chain on the first LMB and
    // commit a Bresenham-stamped wall on each subsequent LMB, leaving the
    // cursor cell as the new anchor for the next segment.
    router.register({
      id: "build-action",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "build-action") return false;
        const mode = modeState.value;
        if (mode.kind !== "build") return true;
        const cell = this._cellFromCanvas(intent.canvasX, intent.canvasY);
        if (!cell) return true;
        if (mode.tool === "single") {
          this._sendPlace(mode.blueprintId, cell);
        } else {
          // Polyline: first click places the corner and anchors. Subsequent
          // clicks stamp every cell from the previous anchor up to the new
          // one (start exclusive — already placed) and re-anchor at the new.
          if (!mode.polyline) {
            this._sendPlace(mode.blueprintId, cell);
          } else {
            for (const c of bresenhamCells(mode.polyline.lastAnchor, cell)) {
              this._sendPlace(mode.blueprintId, c);
            }
          }
          modeState.value = { ...mode, polyline: { lastAnchor: cell } };
        }
        return true;
      },
    });

    // Build-undo: pop the polyline anchor; if there's nothing staged, exit
    // build mode entirely (same effect as build-cancel).
    router.register({
      id: "build-undo",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "build-undo") return false;
        const mode = modeState.value;
        if (mode.kind !== "build") return true;
        if (mode.tool === "polyline" && mode.polyline) {
          modeState.value = { ...mode, polyline: undefined };
        } else {
          modeState.value = { kind: "normal" };
          patchUI({ selectedBlueprint: "" });
        }
        return true;
      },
    });

    router.register({
      id: "build-cancel",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "build-cancel") return false;
        modeState.value = { kind: "normal" };
        patchUI({ selectedBlueprint: "", radialMenu: null });
        return true;
      },
    });

    router.register({
      id: "build-radial",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "open-build-radial") return false;
        this._handleUIAction({ type: "open_build_menu", canvasX: intent.canvasX, canvasY: intent.canvasY });
        return true;
      },
    });
  }

  /** Map the canvas-space cursor to the integer world cell beneath it. */
  private _cellFromCanvas(canvasX: number, canvasY: number): WorldCell | null {
    const me = this.playerId ? this.world.get(this.playerId) : null;
    const groundZ = me?.position?.z ?? 4.0;
    const worldPos = this.renderer?.getCursorWorldPos(canvasX, canvasY, groundZ);
    if (!worldPos) return null;
    return { cellX: Math.floor(worldPos.x), cellY: Math.floor(worldPos.y) };
  }

  private _sendPlace(blueprintId: string, cell: WorldCell): void {
    this._sendCommand({
      cmd: CommandType.Place,
      source: "prefab",
      prefabId: blueprintId,
      worldX: cell.cellX + 0.5,
      worldY: cell.cellY + 0.5,
    });
  }

  /**
   * Translate UI intents into server messages.
   * This is the single bridge between the UI layer and game logic.
   */
  private _handleUIAction(action: UIAction): void {
    switch (action.type) {
      case "respawn":
        // Re-enter the world after death (T-270). The session stayed open; the
        // server records the death (advancing the dynasty → heir) and spawns.
        this._sendCommand({ cmd: CommandType.Respawn });
        closePanel("death");
        break;

      case "debug_toggle": {
        const on = this.toggleDebug(action.layer);
        setDebugLayer(action.layer, on);
        break;
      }

      case "debug_scene_census":
        this.renderer?.logSceneCensus();
        break;

      case "debug_give_item":
        this._sendCommand({ cmd: CommandType.DebugGiveItem, itemType: action.itemType, quantity: action.quantity });
        break;

      case "debug_spawn_npc":
        this._sendCommand({ cmd: CommandType.DebugSpawnNpc, npcTemplate: action.npcTemplate, quantity: action.quantity });
        break;

      case "debug_set_time":
        this._sendCommand({ cmd: CommandType.DebugSetTime, hour: action.hour });
        break;

      case "debug_teleport":
        this._sendCommand({ cmd: CommandType.DebugTeleport, worldX: action.worldX, worldY: action.worldY });
        break;

      case "debug_set_stat":
        this._sendCommand({ cmd: CommandType.DebugSetStat, stat: action.stat, value: action.value });
        break;

      case "equip":
        this._sendCommand({ cmd: CommandType.Equip, fromInventorySlot: action.fromSlot });
        break;

      case "unequip": {
        const slotIndex = EQUIP_SLOT_NAMES.indexOf(action.slot as typeof EQUIP_SLOT_NAMES[number]);
        if (slotIndex !== -1) {
          this._sendCommand({ cmd: CommandType.Unequip, equipSlot: slotIndex as EquipSlotIndex });
        }
        break;
      }

      case "move_item":
        this._sendCommand({ cmd: CommandType.MoveItem, fromSlot: action.fromSlot, toSlot: action.toSlot });
        break;

      case "drop_item":
        this._sendCommand({ cmd: CommandType.DropItem, fromSlot: action.fromSlot });
        break;

      case "use_item":
        this._sendCommand({ cmd: CommandType.UseItem, fromSlot: action.fromSlot });
        break;

      case "load_workstation":
        this._sendCommand({
          cmd: CommandType.LoadWorkstation,
          inventorySlot: action.inventorySlot,
          bufferSlot: action.bufferSlot,
        });
        break;

      case "take_workstation":
        this._sendCommand({
          cmd: CommandType.TakeWorkstation,
          bufferSlot: action.bufferSlot,
        });
        break;

      case "select_recipe":
        this._sendCommand({ cmd: CommandType.SelectRecipe, recipeId: action.recipeId });
        break;

      case "deploy_item":
        // Server uses forward-facing placement for kit items, so worldX/worldY
        // are ignored — we send 0/0 to satisfy the codec without a cursor pick.
        console.log(`[Deploy] sending Place from inventory slot=${action.fromSlot}`);
        this._sendCommand({
          cmd: CommandType.Place,
          source: "inventory",
          fromInventorySlot: action.fromSlot,
          worldX: 0,
          worldY: 0,
        });
        break;

      case "place_blueprint":
        console.log(`[Build] sending Place prefab=${action.structureType} world=(${action.worldX.toFixed(1)},${action.worldY.toFixed(1)})`);
        this._sendCommand({
          cmd: CommandType.Place,
          source: "prefab",
          prefabId: action.structureType,
          worldX: action.worldX,
          worldY: action.worldY,
        });
        break;

      case "open_build_menu":
        console.log(`[Build] opening radial menu at canvas=(${action.canvasX.toFixed(0)},${action.canvasY.toFixed(0)})`);
        patchUI({ radialMenu: { x: action.canvasX, y: action.canvasY } });
        break;

      case "select_blueprint": {
        console.log(`[Build] selected blueprint type=${action.structureType}`);
        patchUI({ selectedBlueprint: action.structureType, radialMenu: null });
        const prefab = this.contentService?.prefabs.get(action.structureType);
        const placeable = prefab?.components.placeable as { tool?: "single" | "polyline" } | undefined;
        const tool = placeable?.tool ?? "single";
        modeState.value = { kind: "build", blueprintId: action.structureType, tool };
        break;
      }

      case "trade_buy":
        this._sendCommand({ cmd: CommandType.TradeBuy, listingSlot: action.slot });
        break;

      case "trade_sell":
        this._sendCommand({ cmd: CommandType.TradeSell, inventorySlot: action.slot });
        break;

      // Not yet implemented — log for discoverability during development.
      case "split_stack":
      case "hotbar_assign":
      case "hotbar_use":
      case "dialogue_choice":
      case "dialogue_close":
      case "rebind_key":
        console.debug("[UIAction unhandled]", action);
        break;
    }
  }

  /** Toggle the debug panel visibility. */
  toggleDebugPanel(): void {
    const open = uiState.value.openPanels.has("debug");
    open ? closePanel("debug") : openPanel("debug");
  }

  /** Toggle the network inspector panel visibility. */
  toggleNetworkPanel(): void {
    const open = uiState.value.openPanels.has("network");
    open ? closePanel("network") : openPanel("network");
  }

  toggleDebug(layer: "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox" | "sobel_edges" | "bypass_postfx" | "shadows"): boolean {
    if (!this.renderer) return false;
    switch (layer) {
      case "heightmap":     return this.renderer.toggleHeightDebug();
      case "sobel_edges":   return this.renderer.toggleSobelEdges();
      case "bypass_postfx": return this.renderer.toggleBypassPostFX();
      case "shadows":       return this.renderer.toggleShadows();
      default:              return this.renderer.debugOverlayManager.toggle(layer);
    }
  }

  /**
   * Phase 2 of loading: called once all 256 terrain chunks are in this.world.
   *
   * Steps (all while loading screen is still visible):
   *   1. Flush world state → renderer (terrain meshes + entity positions).
   *      This is the ~100 ms GPU-upload work we deferred from the receive loop.
   *   2. Prefetch all model/skeleton/material definitions via content channel.
   *   3. Dismiss loading screen.
   *
   * State messages keep arriving during steps 2-3 and are applied normally
   * (loadingComplete=true means the renderer is now live).
   */
  private _finishLoading(): void {
    if (this.loadingComplete) return;
    this.loadingComplete = true;  // renderer calls active from this point

    console.log(`[Game] all terrain received — flushing world to renderer`);
    // Step 1: push all buffered world state into the renderer
    let terrainCount = 0, entityCount = 0, gateCount = 0;
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap && state.materialGrid) {
        this.renderer?.updateTerrain(state.heightmap, state.materialGrid); terrainCount++;
      } else if (state.gateLink && state.position) {
        const groundZ = this.world.getTerrainHeight(state.position.x, state.position.y);
        this.renderer?.updateGateMarker(
          entityId, state.position.x, state.position.y, groundZ, state.gateLink.edge,
        );
        gateCount++;
      } else if (state.position) {
        this.renderer?.updateEntity(entityId, state); entityCount++;
      }
    }
    console.log(`[Game] flushed ${terrainCount} terrain chunks + ${entityCount} entities + ${gateCount} gates to renderer`);

    // Step 2: prefetch models (async — loading screen stays up)
    const content = this.content;
    if (!content) { patchUI({ loading: false }); return; }

    const modelIds = new Set<string>();
    for (const [, state] of this.world.entries()) {
      if (state.modelRef?.modelId) modelIds.add(state.modelRef.modelId);
    }
    console.log(`[Game] prefetching ${modelIds.size} models`);
    Promise.all([...modelIds].map((id) => content.prefetchModel(id))).then(() => {
      console.log(`[Game] models ready — dismissing loading screen`);
      patchUI({ loading: false });
      // Forest decoration was deferred during loading — running it then
      // would have starved the WebTransport read loop and stalled chunk
      // delivery. Now that the screen is gone and the message stream is
      // quiet, drain the queued chunks across animation frames.
      this.forestProps?.start();
    }).catch(() => {
      patchUI({ loading: false });
      this.forestProps?.start();
    });
  }

  stop(): void {
    this.running = false;
    this.predictor = null;
    this.terrainChunksReceived = 0;
    this.loadingComplete = false;
    cancelAnimationFrame(this.animFrameId);
    this.interactionSystem?.dispose();
    this.interactionSystem = null;
    this.buildGhost?.dispose();
    this.buildGhost = null;
    this.hoverOutline?.dispose();
    this.hoverOutline = null;
    this.forestProps = null;
    this.waterRenderer?.clear();
    this.waterRenderer = null;
    this.inputCapture?.dispose();
    this.inputCapture = null;
    this.input = null;
    this.intentRouter = null;
    this.connection.close();
    this.renderer?.dispose();
    this.overlay?.dispose();
    this.world.clear();
  }
}

// ---- helpers ----

/**
 * Bresenham line in cell space, inclusive of both endpoints. Used by polyline
 * blueprints to stamp a wall across every cell between two corners with one
 * Place command per cell.
 */
function bresenhamCells(a: WorldCell, b: WorldCell): WorldCell[] {
  const cells: WorldCell[] = [];
  let x0 = a.cellX, y0 = a.cellY;
  const x1 = b.cellX, y1 = b.cellY;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  // Skip the starting cell — it's the previous anchor and already placed.
  let first = true;
  while (true) {
    if (!first) cells.push({ cellX: x0, cellY: y0 });
    first = false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return cells;
}

/**
 * Convert an itemType id (e.g. "wooden_sword") to a display label ("Wooden Sword").
 * Used wherever a human-readable item name is needed client-side.
 */
/**
 * Map a server EquipmentData into the EquipmentState shape the UI expects.
 */
function mapEquipmentToUI(eq: EquipmentData): EquipmentState {
  function toStack(slot: EquipmentData["weapon"]): ItemStack | null {
    if (!slot) return null;
    return {
      itemType: slot.prefabId,
      quantity: 1,
      displayName: humanizeItemType(slot.prefabId),
      modelTemplateId: null,
    };
  }
  return {
    weapon:  toStack(eq.weapon),
    offHand: toStack(eq.offHand),
    head:    toStack(eq.head),
    chest:   toStack(eq.chest),
    legs:    toStack(eq.legs),
    feet:    toStack(eq.feet),
    back:    toStack(eq.back),
  };
}

/**
 * Derive a day-phase name from raw WorldClock fields.
 * Boundaries: midnight 0–0.25, dawn 0.25–0.5, noon 0.5–0.75, dusk 0.75–1.
 */
function worldClockPhase(ticksElapsed: number, dayLengthTicks: number): string {
  const t = (ticksElapsed % dayLengthTicks) / dayLengthTicks;
  if (t < 0.25) return "midnight";
  if (t < 0.5)  return "dawn";
  if (t < 0.75) return "noon";
  return "dusk";
}

/**
 * Map the local player's Resource component to the HUD vital bars (T-262).
 * Stamina/hunger come from the keyed scalars; `exhausted` is derived (the
 * server-side exhausted flag was retired with the Resource primitive).
 */
function vitalsPatch(resource: ResourceData): Parameters<typeof patchUI>[0] {
  const patch: Parameters<typeof patchUI>[0] = {};
  const s = resource.values.stamina;
  if (s) patch.stamina = { current: s.value, max: s.max, exhausted: s.value <= 0 };
  const h = resource.values.hunger;
  if (h) patch.hunger = { value: h.value };
  return patch;
}

/**
 * Map a server LoreLoadoutData into the SkillLoadoutState shape the UI expects.
 * A slot is the id of a skill ActionDef (or null); cooldowns come from the
 * networked ActionCooldowns component (T-265), keyed by action id.
 */
function mapLoreLoadoutToUI(loadout: LoreLoadoutData): SkillLoadoutState {
  return { slots: loadout.skills.map((actionId, index) => ({ index, actionId: actionId ?? null })) };
}

/**
 * Derive the cast-bar state from the action runtime (T-266): the local player
 * is "casting" while its primary slot runs an active-kind action in its windup
 * phase. Instant actions (≤1 windup tick) show no bar. Null when not casting.
 */
function deriveCastState(
  actions: ActiveActionsData,
  content: ContentService | null,
): { label: string; frac: number } | null {
  const slot = actions.states["primary"];
  if (!slot) return null;
  const def = content?.actions.get(slot.actionId);
  if (!def || def.kind !== "active" || slot.phase !== "windup") return null;
  const total = def.phases?.windup?.ticks ?? 0;
  if (total <= 1) return null;
  const label = slot.actionId
    .replace(/^skill_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { label, frac: Math.min(1, slot.ticksInPhase / total) };
}

function getToolType(prefabId: string | undefined, content: ContentService | null): string | undefined {
  if (!prefabId || !content) return undefined;
  const prefab = content.prefabs.get(prefabId);
  const tool = prefab?.components.tool as ToolData | undefined;
  return tool?.toolType;
}

/**
 * Map a server InventoryData into the InventoryState shape the UI expects.
 * The slots array is padded to capacity with nulls so the grid always renders
 * the correct number of cells regardless of how many items are present.
 */
function mapInventoryToUI(inv: InventoryData, world: ClientWorld): InventoryState {
  const slots: (ItemStack | null)[] = inv.slots.map((s) => {
    if (s.kind === "stack") {
      return {
        itemType: s.prefabId,
        quantity: s.quantity,
        displayName: humanizeItemType(s.prefabId),
        modelTemplateId: null,
      };
    } else {
      // Unique item entity — pull its prefab id from the entity's ItemData
      // component so the UI shows a proper name and the tooltip can locate
      // the entity for stat/provenance lookup.
      const entity = world.get(s.entityId);
      const prefabId = entity?.itemData?.prefabId ?? "";
      return {
        itemType: prefabId,
        quantity: 1,
        displayName: prefabId ? humanizeItemType(prefabId) : "(item)",
        modelTemplateId: null,
        entityId: s.entityId,
      };
    }
  });
  while (slots.length < inv.capacity) slots.push(null);
  return { slots, maxSlots: inv.capacity };
}
