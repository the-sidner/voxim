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
import { GameHud } from "./hud.ts";
import { ACTION_USE_SKILL, hasAction } from "@voxim/protocol";

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
  private hud: GameHud | null = null;
  private input: InputController | null = null;
  private animFrameId = 0;
  private playerId: string | null = null;
  private inputSeq = 0;
  private serverTick = 0;
  private running = false;

  async start(config: GameConfig): Promise<void> {
    // Step 1: wire message handlers BEFORE connecting — eliminates the race where
    // the server's full snapshot arrives during connect() while handlers are still null.
    // All renderer/hud references use optional chaining — safe before they are created.
    this.connection.onSnapshot = (snap) => {
      this.serverTick = snap.serverTick;
      this.world.applySnapshot(snap);
      for (const e of snap.entities) {
        const state = this.world.get(e.entityId);
        if (state?.position) this.renderer?.updateEntity(e.entityId, state);
      }
    };

    this.connection.onStateMessage = (msg) => {
      this.serverTick = msg.serverTick;

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
        this.hud?.removeEntityBar(entityId);
      }

      for (const entityId of updated) {
        const state = this.world.get(entityId);
        if (!state) continue;
        if (state.heightmap && state.materialGrid) {
          this.renderer?.updateTerrain(state.heightmap, state.materialGrid);
        } else if (state.position) {
          this.renderer?.updateEntity(entityId, state);
        }
        if (entityId === this.playerId && this.hud) {
          if (state.health)  this.hud.updateHealth(state.health.current, state.health.max);
          if (state.stamina) this.hud.updateStamina(state.stamina.current, state.stamina.max, state.stamina.exhausted);
          if (state.hunger)  this.hud.updateHunger(state.hunger.value);
        }
      }

      for (const ev of msg.events) {
        switch (ev.type) {
          case "DamageDealt": {
            const screenPos = this.renderer?.getEntityScreenPos(ev.targetId);
            if (screenPos) this.hud?.showDamage(screenPos.x, screenPos.y, Math.round(ev.amount), ev.blocked);
            // Show arc for all attackers except local player (already shown on input)
            if (ev.sourceId !== this.playerId) {
              const srcScreen = this.renderer?.getEntityScreenPos(ev.sourceId);
              const tgtScreen = screenPos;
              if (srcScreen && tgtScreen) {
                const angle = Math.atan2(tgtScreen.y - srcScreen.y, tgtScreen.x - srcScreen.x);
                this.hud?.showSwingArc(srcScreen.x, srcScreen.y, angle);
              }
            }
            break;
          }
          case "EntityDied":
            if (ev.entityId === this.playerId) this.hud?.showAlert("You died", "#ff4444");
            break;
          case "HungerCritical":
            if (ev.entityId === this.playerId) this.hud?.showAlert("Starving!", "#ff8800");
            break;
          case "DayPhaseChanged": {
            const labels: Record<string, string> = { dawn: "Dawn", noon: "Noon", dusk: "Dusk", midnight: "Midnight" };
            this.hud?.showAlert(labels[ev.phase] ?? ev.phase, "#aaccff");
            this.renderer?.setDayPhase(ev.phase);
            break;
          }
          case "CraftingCompleted":
            if (ev.crafterId === this.playerId) this.hud?.showAlert(`Crafted: ${ev.recipeId}`, "#88dd88");
            break;
          case "BuildingCompleted":
            if (ev.builderId === this.playerId) this.hud?.showAlert(`Built: ${ev.structureType}`, "#88ccff");
            break;
          case "NodeDepleted":
            if (ev.harvesterId === this.playerId) this.hud?.showAlert(`${ev.nodeTypeId} depleted`, "#998866");
            break;
          case "GateApproached":
            if (ev.entityId === this.playerId) this.hud?.showAlert(`Entering ${ev.destinationTileId}`, "#aaccff");
            break;
          case "TradeCompleted":
            if (ev.buyerId === this.playerId) {
              const coins = ev.coinDelta > 0 ? `-${ev.coinDelta}` : `+${-ev.coinDelta}`;
              this.hud?.showAlert(`${ev.quantity}x ${ev.itemType} (${coins} coins)`, "#88ccff");
            }
            break;
          case "LoreExternalised":
            if (ev.entityId === this.playerId) this.hud?.showAlert(`Fragment written: ${ev.fragmentId}`, "#cc88ff");
            break;
          case "LoreInternalised":
            if (ev.entityId === this.playerId) this.hud?.showAlert(`Lore absorbed: ${ev.fragmentId}`, "#cc88ff");
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
    this.hud = new GameHud();

    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap && state.materialGrid) {
        this.renderer.updateTerrain(state.heightmap, state.materialGrid);
      } else if (state.position) {
        this.renderer.updateEntity(entityId, state);
      }
      if (entityId === this.playerId) {
        if (state.health)  this.hud.updateHealth(state.health.current, state.health.max);
        if (state.stamina) this.hud.updateStamina(state.stamina.current, state.stamina.max, state.stamina.exhausted);
        if (state.hunger)  this.hud.updateHunger(state.hunger.value);
      }
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
      this.connection.sendInput(datagram);
      if (hasAction(datagram.actions, ACTION_USE_SKILL)) {
        this.renderer?.forceLocalAnimation("attack");
        const playerScreen = this.renderer?.getPlayerScreenPos();
        if (playerScreen) this.hud?.showSwingArc(playerScreen.x, playerScreen.y, datagram.facing);
      }
    }
    this.renderer?.render(this.serverTick);

    // Update floating entity health bars
    if (this.hud) {
      this.hud.clearEntityBars();
      for (const [entityId, state] of this.world.entries()) {
        if (entityId === this.playerId) continue;
        if (!state.health || !state.position) continue;
        const pos = this.renderer?.getEntityScreenPos(entityId);
        if (pos) this.hud.setEntityHealth(entityId, state.health.current, state.health.max, pos.x, pos.y);
      }
    }

    this.scheduleFrame();
  }

  toggleDebug(layer: "skeleton" | "facing" | "chunks" | "heightmap"): boolean {
    if (!this.renderer) return false;
    switch (layer) {
      case "skeleton":   return this.renderer.skeletonOverlay.toggle();
      case "facing":     return this.renderer.facingOverlay.toggle();
      case "chunks":     return this.renderer.chunkOverlay.toggle();
      case "heightmap":  return this.renderer.toggleHeightDebug();
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animFrameId);
    this.input?.dispose();
    this.connection.close();
    this.renderer?.dispose();
    this.hud?.dispose();
    this.world.clear();
  }
}
