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
import { InputController } from "./input/input_controller.ts";
import { ClientWorld } from "./state/client_world.ts";
import { ContentCache } from "./state/content_cache.ts";
import { VoximRenderer } from "./render/renderer.ts";
import { WorldOverlay } from "./ui/world_overlay.ts";
import { mountUI } from "./ui/mount_ui.tsx";
import { uiState, patchUI, openPanel, closePanel, pushToast } from "./ui/ui_store.ts";
import type { UIAction } from "./ui/ui_actions.ts";
import { recordInput, recordState, recordSnapshot } from "./ui/network_capture.ts";
import { setDebugLayer } from "./ui/debug_store.ts";
import { ACTION_USE_SKILL, hasAction, CommandType, EquipSlotIndex, EQUIP_SLOT_NAMES } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { EquipmentData, InventoryData } from "@voxim/codecs";
import type { EquipmentState, InventoryState, ItemStack } from "./ui/ui_store.ts";
import weaponActionsData from "../../content/data/weapon_actions.json" with { type: "json" };
import itemTemplatesData from "../../content/data/item_templates.json" with { type: "json" };

export interface GameConfig {
  canvas: HTMLCanvasElement;
  /**
   * Full WebTransport URL of the gateway, e.g. "https://localhost:8080".
   * Used in production. Mutually exclusive with directTile.
   */
  gatewayUrl?: string;
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
  private input: InputController | null = null;
  private animFrameId = 0;
  private playerId: string | null = null;
  private inputSeq = 0;
  private commandSeq = 0;
  private serverTick = 0;
  private running = false;

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
        if (entityId === this.playerId) {
          if (state.health)    patchUI({ health:    { current: state.health.current, max: state.health.max } });
          if (state.stamina)   patchUI({ stamina:   { current: state.stamina.current, max: state.stamina.max, exhausted: state.stamina.exhausted } });
          if (state.hunger)    patchUI({ hunger:    { value: state.hunger.value } });
          if (state.equipment) patchUI({ equipment: mapEquipmentToUI(state.equipment) });
          if (state.inventory) patchUI({ inventory: mapInventoryToUI(state.inventory) });
        }
      }

      if (!this.loadingComplete && this.terrainChunksReceived >= VoximGame.TOTAL_CHUNKS) {
        this._finishLoading();
      }

      for (const ev of msg.events) {
        switch (ev.type) {
          case "DamageDealt": {
            const screenPos = this.renderer?.getEntityScreenPos(ev.targetId);
            if (screenPos) this.overlay?.showDamage(screenPos.x, screenPos.y, Math.round(ev.amount), ev.blocked);
            this.renderer?.spawnHitSpark(ev.hitX, ev.hitY, ev.hitZ);
            break;
          }
          case "EntityDied":
            if (ev.entityId === this.playerId) {
              openPanel("death", true);
              pushToast("You died", "danger");
            }
            break;
          case "HungerCritical":
            if (ev.entityId === this.playerId) pushToast("Starving!", "warn");
            break;
          case "DayPhaseChanged": {
            const labels: Record<string, string> = { dawn: "Dawn", noon: "Noon", dusk: "Dusk", midnight: "Midnight" };
            pushToast(labels[ev.phase] ?? ev.phase, "info");
            this.renderer?.setDayPhase(ev.phase);
            break;
          }
          case "CraftingCompleted":
            if (ev.crafterId === this.playerId) pushToast(`Crafted: ${ev.recipeId}`, "success");
            break;
          case "BuildingCompleted":
            if (ev.builderId === this.playerId) pushToast(`Built: ${ev.structureType}`, "info");
            break;
          case "NodeDepleted":
            if (ev.harvesterId === this.playerId) pushToast(`${ev.nodeTypeId} depleted`, "info");
            break;
          case "GateApproached":
            if (ev.entityId === this.playerId) pushToast(`Entering ${ev.destinationTileId}`, "info");
            break;
          case "TradeCompleted":
            if (ev.buyerId === this.playerId) {
              const coins = ev.coinDelta > 0 ? `-${ev.coinDelta}` : `+${-ev.coinDelta}`;
              pushToast(`${ev.quantity}x ${ev.itemType} (${coins} coins)`, "success");
            }
            break;
          case "LoreExternalised":
            if (ev.entityId === this.playerId) pushToast(`Fragment written: ${ev.fragmentId}`, "info");
            break;
          case "LoreInternalised":
            if (ev.entityId === this.playerId) pushToast(`Lore absorbed: ${ev.fragmentId}`, "success");
            break;
          case "SkillActivated":
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

    if (config.directTile) {
      tileAddress = config.directTile.address;
      certHashHex = config.directTile.certHashHex;
    } else {
      const gatewayResult = await connectViaGateway(config.gatewayUrl!);
      this.playerId = gatewayResult.playerId;
      tileAddress = gatewayResult.tileAddress;
    }

    // Step 3: connect — handlers are already wired so no messages can be dropped
    const assignedId = await this.connection.connect(tileAddress, this.playerId ?? undefined, certHashHex);
    this.playerId = assignedId;
    console.log(`[Game] tile-assigned player ID: ${this.playerId}`);
    (globalThis as unknown as Record<string, unknown>)._voxim_connected = true;

    // Step 4: renderer, content cache, HUD, input — push any world state that
    // arrived during connect() into the renderer now that it exists.
    this.content = new ContentCache(this.connection);
    this.renderer = new VoximRenderer(canvas);
    this.renderer.setLocalPlayer(this.playerId!);
    this.renderer.setContentCache(this.content);
    // deno-lint-ignore no-explicit-any
    this.renderer.setWeaponActions(weaponActionsData as any);
    // deno-lint-ignore no-explicit-any
    this.renderer.setItemTemplates(itemTemplatesData as any);

    // Mount world overlay (entity health bars, floating damage numbers — frame-driven)
    this.overlay = new WorldOverlay();

    // Mount Preact UI into <div id="ui"> — must exist in the HTML host page
    mountUI((a) => this._handleUIAction(a));

    // Count any terrain chunks that arrived during connect() (before renderer existed).
    // Don't push to renderer yet — _finishLoading() does that after all chunks arrive.
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap) this.terrainChunksReceived++;
      if (entityId === this.playerId) {
        if (state.health)    patchUI({ health:    { current: state.health.current, max: state.health.max } });
        if (state.stamina)   patchUI({ stamina:   { current: state.stamina.current, max: state.stamina.max, exhausted: state.stamina.exhausted } });
        if (state.hunger)    patchUI({ hunger:    { value: state.hunger.value } });
        if (state.equipment) patchUI({ equipment: mapEquipmentToUI(state.equipment) });
        if (state.inventory) patchUI({ inventory: mapInventoryToUI(state.inventory) });
      }
    }
    patchUI({ loadingProgress: Math.min(1, this.terrainChunksReceived / VoximGame.TOTAL_CHUNKS) });
    if (!this.loadingComplete && this.terrainChunksReceived >= VoximGame.TOTAL_CHUNKS) {
      this._finishLoading();
    }
    this.input = new InputController(canvas, () => this.renderer!.getPlayerScreenPos());

    // Step 5: render loop
    this.running = true;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    this.animFrameId = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;
    if (this.input) {
      const datagram = this.input.buildDatagram(++this.inputSeq, this.serverTick);
      this.connection.sendMovement(datagram);
      recordInput(datagram);
      if (hasAction(datagram.actions, ACTION_USE_SKILL)) {
        // Use the last server-confirmed attack params so the prediction matches the
        // real weapon. Falls back to "slash" defaults if no confirmed state yet.
        const lastAnim = this.playerId ? this.world.get(this.playerId)?.animationState : null;
        if (lastAnim?.mode === "attack") {
          this.renderer?.forceLocalAnimation("attack", lastAnim.attackStyle, lastAnim.windupTicks, lastAnim.activeTicks, lastAnim.winddownTicks);
        } else {
          this.renderer?.forceLocalAnimation("attack", "slash", 4, 4, 7);
        }
        // Arc is shown on DamageDealt confirmation, not on input prediction.
      }
    }
    this.renderer?.render(this.serverTick);

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

      // Not yet implemented — log for discoverability during development.
      case "split_stack":
      case "hotbar_assign":
      case "hotbar_use":
      case "crafting_add":
      case "crafting_remove":
      case "crafting_craft":
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

  toggleDebug(layer: "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox"): boolean {
    if (!this.renderer) return false;
    switch (layer) {
      case "skeleton":   return this.renderer.skeletonOverlay.toggle();
      case "facing":     return this.renderer.facingOverlay.toggle();
      case "chunks":     return this.renderer.chunkOverlay.toggle();
      case "heightmap":  return this.renderer.toggleHeightDebug();
      case "blade":      return this.renderer.bladeDebugOverlay.toggle();
      case "hitbox":     return this.renderer.hitboxDebugOverlay.toggle();
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
    this.terrainChunksReceived = 0;
    this.loadingComplete = false;
    cancelAnimationFrame(this.animFrameId);
    this.input?.dispose();
    this.connection.close();
    this.renderer?.dispose();
    this.overlay?.dispose();
    this.world.clear();
  }
}

// ---- helpers ----

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
 * Inventory slots with null become null equipment slots.
 */
function mapEquipmentToUI(eq: EquipmentData): EquipmentState {
  function toStack(slot: EquipmentData["weapon"]): ItemStack | null {
    if (!slot) return null;
    return {
      itemType: slot.itemType,
      quantity: slot.quantity,
      displayName: humanizeItemType(slot.itemType),
      modelTemplateId: null, // resolved lazily by content cache when needed
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
 * Map a server InventoryData into the InventoryState shape the UI expects.
 * The slots array is padded to capacity with nulls so the grid always renders
 * the correct number of cells regardless of how many items are present.
 */
function mapInventoryToUI(inv: InventoryData): InventoryState {
  const slots: (ItemStack | null)[] = inv.slots.map((s) => ({
    itemType: s.itemType,
    quantity: s.quantity,
    displayName: humanizeItemType(s.itemType),
    modelTemplateId: null,
  }));
  while (slots.length < inv.capacity) slots.push(null);
  return { slots, maxSlots: inv.capacity };
}
