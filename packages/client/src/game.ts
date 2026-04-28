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
import { InputCapture } from "./input/input_capture.ts";
import { IntentRouter } from "./input/intent_router.ts";
import { IntentTranslator } from "./input/intent_translator.ts";
import type { Intent } from "./input/intents.ts";
import { modeState, cursorCellState, type WorldCell } from "./input/context.ts";
import { ClientWorld } from "./state/client_world.ts";
import { ContentCache } from "./state/content_cache.ts";
import { VoximRenderer } from "./render/renderer.ts";
import { BuildGhostRenderer } from "./render/build_ghost.ts";
import { HoverOutlineRenderer } from "./render/hover_outline.ts";
import { InteractionSystem } from "./interaction/interaction_system.ts";
import { makeWorkstationHandler, resourceNodeHandler, groundItemHandler } from "./interaction/interactable_handlers.ts";
import { WorldOverlay } from "./ui/world_overlay.ts";
import { mountUI } from "./ui/mount_ui.tsx";
import { uiState, patchUI, openPanel, closePanel, pushToast } from "./ui/ui_store.ts";
import { setClientWorld } from "./ui/client_world_ref.ts";
import type { UIAction } from "./ui/ui_actions.ts";
import { recordInput, recordState, recordSnapshot } from "./ui/network_capture.ts";
import { setDebugLayer, setDebugItemList } from "./ui/debug_store.ts";
import { ACTION_USE_SKILL, ACTION_JUMP, hasAction, CommandType, EquipSlotIndex, EQUIP_SLOT_NAMES } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { EquipmentData, InventoryData, LoreLoadoutData } from "@voxim/codecs";
import type { EquipmentState, InventoryState, ItemStack, SkillLoadoutState } from "./ui/ui_store.ts";
import { DEFAULT_PHYSICS } from "@voxim/engine";
import { Predictor } from "./prediction/predictor.ts";
import { weapon_actions as weaponActionsData, item_prefabs as itemPrefabsData } from "@voxim/content";
import type { Prefab, ToolData } from "@voxim/content";
import gameConfigData from "../../content/data/game_config.json" with { type: "json" };

export interface GameConfig {
  canvas: HTMLCanvasElement;
  /**
   * Full WebTransport URL of the gateway, e.g. "https://localhost:8080".
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
}

export class VoximGame {
  private connection = new TileConnection();
  private world = new ClientWorld();
  private content: ContentCache | null = null;
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
  /** Throttle key for the "missing materials" toast — avoids spam on every swing. */
  private _lastMissingToastKey: string | null = null;

  /** Total terrain chunks expected per tile (32×32 chunks of 16×16 = 256). */
  private static readonly TOTAL_CHUNKS = 256;

  private terrainChunksReceived = 0;
  /** True once all terrain AND all entity models are preloaded. */
  private loadingComplete = false;

  async start(config: GameConfig): Promise<void> {
    // Step 1: wire message handlers BEFORE connecting — eliminates the race where
    // the server's full snapshot arrives during connect() while handlers are still null.
    // All renderer/hud references use optional chaining — safe before they are created.
    this.connection.onSnapshot = (snap) => {
      this.serverTick = snap.serverTick;
      this.world.applySnapshot(snap);
      recordSnapshot(snap);
      for (const e of snap.entities) {
        const state = this.world.get(e.entityId);
        if (state?.position) this.renderer?.updateEntity(e.entityId, state);
      }
    };

    this.connection.onStateMessage = (msg) => {
      this.serverTick = msg.serverTick;
      recordState(msg);

      const updated = new Set<string>();
      for (const spawn of msg.spawns) {
        this.world.applySpawn(spawn);
        updated.add(spawn.entityId);
      }
      for (const delta of msg.deltas) {
        this.world.applyDelta(delta);
        updated.add(delta.entityId);
      }
      for (const entityId of msg.destroys) {
        this.world.applyDestroy(entityId);
        this.renderer?.removeEntity(entityId);
        this.overlay?.removeEntityBar(entityId);
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
        } else if (state.position) {
          if (this.loadingComplete) this.renderer?.updateEntity(entityId, state);
        }
        if (state.worldClock) {
          this.renderer?.setDayPhase(worldClockPhase(state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks));
        }
        if (entityId === this.playerId) {
          if (state.health)    patchUI({ health:    { current: state.health.current, max: state.health.max } });
          if (state.stamina)   patchUI({ stamina:   { current: state.stamina.current, max: state.stamina.max, exhausted: state.stamina.exhausted } });
          if (state.hunger)    patchUI({ hunger:    { value: state.hunger.value } });
          if (state.equipment) {
            patchUI({ equipment: mapEquipmentToUI(state.equipment) });
            if (this.input) {
              const toolType = getToolType(state.equipment.weapon?.prefabId);
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
      }

      // Workstation panel cleanup: if the entity left AoI / was destroyed,
      // the world drop happened above and the mirror would no-op — but the
      // panel still has stale state. Close it so the next click can reopen.
      const wsId = uiState.value.workstation?.entityId;
      if (wsId && msg.destroys.includes(wsId)) {
        closePanel("workstation");
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
          const serverVel = vel ?? { x: 0, y: 0, z: 0 };
          if (!this.predictor.isInitialised) {
            this.predictor.seed(pos, serverVel);
          } else {
            this.predictor.reconcile(msg.ackInputSeq, pos, serverVel, terrainFn);
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
          case "SkillActivated":
            console.log(`[Event] SkillActivated caster=${ev.casterId.slice(-6)} slot=${ev.slot} effect=${ev.effectType}`);
            break;
        }
      }
    };

    this.connection.onClose = () => {
      console.log("[Game] disconnected");
      this.stop();
    };

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

    // Step 3: connect — handlers are already wired so no messages can be dropped
    console.log(`[Game] connecting to tile ${tileAddress} as ${this.playerId.slice(0, 8)}`);
    const assignedId = await this.connection.connect(tileAddress, this.playerId, tileToken, certHashHex);
    this.playerId = assignedId;
    console.log(`[Game] tile-assigned player ID: ${this.playerId}`);
    (globalThis as unknown as Record<string, unknown>)._voxim_connected = true;

    // Step 4: renderer, content cache, HUD, input — push any world state that
    // arrived during connect() into the renderer now that it exists.
    this.content = new ContentCache(this.connection);
    this.renderer = new VoximRenderer(canvas);
    this.renderer.setLocalPlayer(this.playerId!);
    this.renderer.setContentCache(this.content);
    this.renderer.setWeaponActions([...weaponActionsData]);
    this.renderer.setItemPrefabs(itemPrefabsData);

    // Populate the debug give-item list from the static item prefab data.
    setDebugItemList(itemPrefabsData.map((p) => ({ id: p.id })));

    // Mount world overlay (entity health bars, floating damage numbers — frame-driven)
    this.overlay = new WorldOverlay();

    // Mount Preact UI into <div id="ui"> — must exist in the HTML host page
    mountUI((a) => this._handleUIAction(a));
    // Expose the live world to UI components that need to read entity state
    // (tooltips reading per-instance Stats, provenance, etc.) without prop
    // threading.
    setClientWorld(this.world);

    // Count any terrain chunks that arrived during connect() (before renderer existed).
    // Don't push to renderer yet — _finishLoading() does that after all chunks arrive.
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap) this.terrainChunksReceived++;
      if (state.worldClock) {
        this.renderer?.setDayPhase(worldClockPhase(state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks));
      }
      if (entityId === this.playerId) {
        if (state.health)      patchUI({ health:       { current: state.health.current, max: state.health.max } });
        if (state.stamina)     patchUI({ stamina:      { current: state.stamina.current, max: state.stamina.max, exhausted: state.stamina.exhausted } });
        if (state.hunger)      patchUI({ hunger:       { value: state.hunger.value } });
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
    this.input = new IntentTranslator(this.intentRouter, () => this.renderer!.getPlayerScreenPos());
    this.inputCapture = new InputCapture(canvas, this.input.handle);

    // Interaction system — entity hover highlight + click dispatch.
    this.interactionSystem = new InteractionSystem(this.renderer, this.world);
    this.interactionSystem.register(makeWorkstationHandler((entityId) => this._openWorkstation(entityId)));
    this.interactionSystem.register(resourceNodeHandler);
    this.interactionSystem.register(groundItemHandler);
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

  private scheduleFrame(): void {
    if (!this.running) return;
    this.animFrameId = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    let predictedPos = null;
    if (this.input) {
      const datagram = this.input.buildDatagram(++this.inputSeq, this.serverTick);
      this.connection.sendMovement(datagram);
      recordInput(datagram);
      if (hasAction(datagram.actions, ACTION_USE_SKILL)) {
        // Use the last server-confirmed attack params so the prediction matches the
        // real weapon. Falls back to "slash" defaults if no confirmed state yet.
        const lastAnim = this.playerId ? this.world.get(this.playerId)?.animationState : null;
        // Use last confirmed weapon action for prediction; fall back to unarmed.
        const weaponActionId = lastAnim?.weaponActionId || "unarmed";
        this.renderer?.forceLocalAnimation(weaponActionId);
        // Arc is shown on DamageDealt confirmation, not on input prediction.
      }

      // Step predictor with this frame's input
      if (this.predictor?.isInitialised) {
        const physicsInput = {
          movement: { x: datagram.movementX, y: datagram.movementY },
          jump: hasAction(datagram.actions, ACTION_JUMP),
        };
        const terrainFn = (x: number, y: number) => this.world.getTerrainHeight(x, y);
        predictedPos = this.predictor.step(datagram.seq, physicsInput, dt, terrainFn);
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
    this.renderer?.render(this.serverTick, predictedPos);

    // Update world-space entity health bars (frame-driven, not reactive)
    if (this.overlay) {
      this.overlay.clearEntityBars();
      for (const [entityId, state] of this.world.entries()) {
        if (entityId === this.playerId) continue;
        if (!state.health || !state.position) continue;
        const pos = this.renderer?.getEntityScreenPos(entityId);
        if (pos) this.overlay.setEntityHealth(entityId, state.health.current, state.health.max, pos.x, pos.y);
      }
    }

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
        progressTicks:  state.workstationBuffer.progressTicks,
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

    // World hover-aware interact (E key). Switches on hover target kind:
    // ground items → server PickUp; workstations → open panel; else no-op.
    router.register({
      id: "world-interact",
      priority: 50,
      claim: (intent: Intent) => {
        if (intent.kind !== "interact") return false;
        if (intent.hover.kind !== "entity") return true; // claim+no-op on empty
        const entity = this.world.get(intent.hover.entityId);
        if (entity?.workstationBuffer) {
          this._openWorkstation(intent.hover.entityId);
          return true;
        }
        if (entity?.itemData) {
          this._sendCommand({ cmd: CommandType.PickUp, entityId: intent.hover.entityId });
          return true;
        }
        return true; // hovered something else; consume so it doesn't propagate
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
        // TODO: send respawn request to server
        break;

      case "debug_toggle": {
        const on = this.toggleDebug(action.layer);
        setDebugLayer(action.layer, on);
        break;
      }

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
        const prefab = itemPrefabsData.find((p: Prefab) => p.id === action.structureType);
        const placeable = prefab?.components.placeable as { tool?: "single" | "polyline" } | undefined;
        const tool = placeable?.tool ?? "single";
        modeState.value = { kind: "build", blueprintId: action.structureType, tool };
        break;
      }

      // Not yet implemented — log for discoverability during development.
      case "split_stack":
      case "hotbar_assign":
      case "hotbar_use":
      case "trade_buy":
      case "trade_sell":
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

  toggleDebug(layer: "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox" | "sobel_edges"): boolean {
    if (!this.renderer) return false;
    switch (layer) {
      case "heightmap":   return this.renderer.toggleHeightDebug();
      case "sobel_edges": return this.renderer.toggleSobelEdges();
      default:            return this.renderer.debugOverlayManager.toggle(layer);
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
    let terrainCount = 0, entityCount = 0;
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap && state.materialGrid) {
        this.renderer?.updateTerrain(state.heightmap, state.materialGrid); terrainCount++;
      } else if (state.position) {
        this.renderer?.updateEntity(entityId, state); entityCount++;
      }
    }
    console.log(`[Game] flushed ${terrainCount} terrain chunks + ${entityCount} entities to renderer`);

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
    }).catch(() => {
      patchUI({ loading: false });
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
function humanizeItemType(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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
 * Map a server LoreLoadoutData into the SkillLoadoutState shape the UI expects.
 */
function mapLoreLoadoutToUI(loadout: LoreLoadoutData): SkillLoadoutState {
  const slots = loadout.skills.map((s, index) => ({
    index,
    verb:              s?.verb              ?? "strike",
    outwardFragmentId: s?.outwardFragmentId ?? null,
    inwardFragmentId:  s?.inwardFragmentId  ?? null,
    cooldownTicks:     loadout.skillCooldowns[index] ?? 0,
    maxCooldownTicks:  0,
  }));
  return { slots };
}

function getToolType(prefabId: string | undefined): string | undefined {
  if (!prefabId) return undefined;
  const prefab = itemPrefabsData.find((p: Prefab) => p.id === prefabId);
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
