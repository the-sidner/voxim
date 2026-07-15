/**
 * Connection-handler wiring: the per-message callbacks on a TileConnection.
 *
 * Extracted from VoximGame (T-353) — this is the client's single wire→world
 * ingestion path: snapshots and state messages flow into ClientWorld, the
 * renderer, the fog, the prediction reconciler, and the UI signals from here.
 * Wired once during start() and again per tile transition (T-141), since each
 * transition builds a fresh connection. All renderer/hud references use
 * optional chaining — safe before they are created (handlers are wired BEFORE
 * connect() so no message can be dropped).
 */
import type { VoximGame } from "../game.ts";
import type { TileConnection } from "./tile_connection.ts";
import type { ClientChunk, EntityState } from "../state/client_world.ts";
import { ComponentType } from "@voxim/protocol";
import type { UIState } from "../ui/ui_store.ts";
import { uiState, patchUI, openPanel, closePanel, pushToast } from "../ui/ui_store.ts";
import { currentZoneName, currentZoneRole, currentZoneTraversal } from "../ui/zone_ref.ts";
import { humanizeItemType } from "../ui/item_names.ts";
import { recordState, recordSnapshot } from "../ui/network_capture.ts";
import { modeState } from "../input/context.ts";
import { mirrorWorkstationToUi, mirrorTraderToUi, mirrorJobBoardToUi, mirrorContainerToUi } from "../ui/panel_bridge.ts";
import { worldClockPhase, vitalsPatch, mapEquipmentToUI, mapInventoryToUI, mapLoreLoadoutToUI, deriveCastState, getToolType, isHoldToAimWeapon } from "../state/state_mappers.ts";

/**
 * Apply the local player's components to the UI store + the input-derived
 * flags (buildMode, aimWeaponActive) + heritage observation — the ONE
 * definition of "apply player state". Called per state message with `changed`
 * = the component types that actually arrived this tick (a plain Position
 * delta at 20 Hz must not re-run the full inventory/equipment mapping suite),
 * and once from start() WITHOUT `changed` after the input system is
 * constructed, so join-time equipment reaches the input flags (messages
 * during connect() run with game.input === null and skip them).
 * All resulting UI fields land in a single patchUI so uiState subscribers
 * wake once per message, not once per field.
 */
export function applyLocalPlayerState(
  game: VoximGame,
  state: EntityState,
  changed?: ReadonlySet<number>,
): void {
  const arrived = (t: number) => !changed || changed.has(t);
  const patch: Partial<UIState> = {};
  if (state.health && arrived(ComponentType.health)) {
    patch.health = { current: state.health.current, max: state.health.max };
  }
  if (state.resource && arrived(ComponentType.resource)) {
    Object.assign(patch, vitalsPatch(state.resource));
  }
  if (state.actionCooldowns && arrived(ComponentType.actionCooldowns)) {
    patch.skillCooldowns = state.actionCooldowns;
  }
  if (state.activeActions && arrived(ComponentType.activeActions)) {
    patch.castState = deriveCastState(state.activeActions, game.contentService);
  }
  if (state.equipment && arrived(ComponentType.equipment)) {
    patch.equipment = mapEquipmentToUI(state.equipment);
    if (game.input) {
      const toolType = getToolType(state.equipment.weapon?.prefabId, game.contentService);
      const newBuildMode = toolType === "hammer";
      if (newBuildMode !== game.input.buildMode) {
        console.log(`[Build] buildMode=${newBuildMode} weapon=${state.equipment.weapon?.prefabId ?? "none"} toolType=${toolType ?? "none"}`);
        game.input.buildMode = newBuildMode;
        // Hammer unequipped while in build mode → cancel any staged
        // blueprint selection. Routed through the intent so handlers
        // stay the single source of mode-clear logic.
        if (!newBuildMode && modeState.value.kind === "build") {
          game.intentRouter?.dispatch({ kind: "build-cancel" });
        }
      }
      // T-337: hold-to-aim weapon detection — drives IntentTranslator's
      // held-vs-tap ACTION_USE_SKILL branch and the pointer-lock
      // pitch-capture branch.
      game.input.aimWeaponActive = isHoldToAimWeapon(state.equipment.weapon?.prefabId, game.contentService);
    }
  }
  const inventoryChanged = state.inventory && arrived(ComponentType.inventory);
  if (inventoryChanged) {
    patch.inventory = mapInventoryToUI(state.inventory!, game.world);
  }
  if (state.loreLoadout && arrived(ComponentType.loreLoadout)) {
    patch.skillLoadout = mapLoreLoadoutToUI(state.loreLoadout);
  }
  if (Object.keys(patch).length > 0) patchUI(patch);
  // After patchUI so the hotbar derivation reads the fresh inventory:
  // an assigned slot's item may have changed/emptied (T-309).
  if (inventoryChanged) game._syncHotbarAttachments();
  if (state.heritage && arrived(ComponentType.heritage)) {
    game._observeHeritageGeneration(state.heritage.generation);
  }
}

export function wireConnectionHandlers(game: VoximGame, conn: TileConnection): void {
  conn.onSnapshot = (snap) => {
    game.serverTick = snap.serverTick;
    game.world.applySnapshot(snap);
    recordSnapshot(snap);
    // Same loading gate as onStateMessage below: during loading, positions
    // only buffer in ClientWorld (mesh creation + model prefetch would starve
    // QUIC flow control) — _finishLoading() flushes everything to the renderer.
    if (!game.loadingComplete) return;
    for (const e of snap.entities) {
      const state = game.world.get(e.entityId);
      if (state?.position) game.renderer?.updateEntity(e.entityId, state);
    }
  };

  conn.onStateMessage = (msg) => {
    game.serverTick = msg.serverTick;
    recordState(msg);

    if (msg.onlineCount !== game.lastOnlineCount) {
      game.lastOnlineCount = msg.onlineCount;
      patchUI({ hudStats: { ...uiState.value.hudStats, onlineCount: msg.onlineCount } });
    }

    // RTT + input-lag bookkeeping for the acked seq (EMA + send-buffer prune).
    game._recordAckedSeq(msg.ackInputSeq);

    // Fog of war (T-157) — server is authoritative for `seenEver`.
    // Snapshots arrive on the first state message after join (and on resync);
    // reveal lists ride every tick that uncovered new cells.  Applied to
    // the Game-owned FogOfWar so messages received during connect() (before
    // the renderer is built) aren't dropped.
    if (msg.fogSnapshot) {
      game.fog.applySnapshot(msg.fogSnapshot);
    }
    if (msg.fogReveals.length > 0) {
      game.fog.applyReveals(msg.fogReveals);
    }

    // Per-entity set of component types that actually arrived this message —
    // the local-player UI application is keyed on THIS, never on the merged
    // EntityState (which is always fully populated after join, so keying on
    // it re-ran every mapper 20x/s while merely moving).
    const updated = new Map<string, Set<number>>();
    const changedFor = (entityId: string): Set<number> => {
      let set = updated.get(entityId);
      if (!set) { set = new Set(); updated.set(entityId, set); }
      return set;
    };
    for (const spawn of msg.spawns) {
      game.world.applySpawn(spawn);
      const set = changedFor(spawn.entityId);
      for (const comp of spawn.components) set.add(comp.componentType);
      // Mirror placed voxels (blueprint entities) into the build occupancy so
      // the cursor stacks on top of them (T-284). Single source = ClientWorld.
      const e = game.world.get(spawn.entityId);
      if (e?.blueprint && e.position) {
        game.buildOccupancy.add(spawn.entityId, e.position.x, e.position.y);
      }
    }
    for (const delta of msg.deltas) {
      game.world.applyDelta(delta);
      changedFor(delta.entityId).add(delta.componentType);
    }
    for (const rm of msg.removals) {
      game.world.applyRemoval(rm.entityId, rm.componentType);
      changedFor(rm.entityId).add(rm.componentType);
    }
    for (const entityId of msg.destroys) {
      game.buildOccupancy.remove(entityId);
      game.world.applyDestroy(entityId);
      game.renderer?.removeEntity(entityId);
      game.renderer?.removeGateMarker(entityId);
      game.overlay?.removeEntityBar(entityId);
      game.overlay?.removeGateLabel(entityId);
    }

    for (const [entityId, changed] of updated) {
      const state = game.world.get(entityId);
      if (!state) continue;
      if (state.heightmap && state.materialGrid) {
        game._noteTerrainChunkReceived(state.heightmap.chunkX, state.heightmap.chunkY);
        // During loading: don't push to renderer yet — keeps JS thread free so
        // QUIC flow control isn't starved.  _finishLoading() flushes everything.
        if (game.loadingComplete) {
          const chunk = game.world.getChunk(state.heightmap.chunkX, state.heightmap.chunkY);
          if (chunk?.heightmap && chunk.materialGrid) game.renderer?.updateTerrain(chunk as ClientChunk);
        }
      } else if (state.gateLink && state.position) {
        // Gate entities are rendered as standalone navigational markers,
        // not via the regular entity mesh path (no modelRef, no skeleton).
        // Pin the pillar to local terrain height so it stands on the ground.
        if (game.loadingComplete) {
          const groundZ = game.world.getTerrainHeight(state.position.x, state.position.y);
          game.renderer?.updateGateMarker(
            entityId, state.position.x, state.position.y, groundZ, state.gateLink.edge,
          );
        }
      } else if (state.position) {
        if (game.loadingComplete) game.renderer?.updateEntity(entityId, state);
      }
      if (state.worldClock) {
        game.renderer?.setDayPhase(worldClockPhase(
          state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks,
          game.contentService?.getGameConfig().dayNight,
        ));
      }
      if (entityId === game.playerId) {
        applyLocalPlayerState(game, state, changed);
      }
      // Mirror buffer/tag updates on the open workstation entity into uiState
      // so the panel reflects loads/takes/recipe progress without polling.
      if (uiState.value.workstation?.entityId === entityId) {
        mirrorWorkstationToUi(game.world, entityId);
      }
      // Family chest: refresh when the open chest's slots change (a deposit or
      // withdraw) so the panel reflects the move without polling.
      if (uiState.value.container?.entityId === entityId) {
        mirrorContainerToUi(game.world, entityId);
      }
      // Heir ritual (T-072): any container touching this dynasty's chests
      // (deposit/withdraw, or one newly entering AoI) can change the
      // guidance banner's pending counts — rescan regardless of which
      // panel (if any) is open.
      if (game.ritualActive && !game.ritualDismissed && state.container) {
        game._recomputeRitualGuide();
      }
      // Trade panel: refresh when the open trader's stock OR the player's
      // inventory (coins/goods) changes, so prices and the sell list stay live.
      const traderId = uiState.value.trader?.npcId;
      if (traderId && (entityId === traderId || entityId === game.playerId)) {
        mirrorTraderToUi(game.world, game.playerId, game.contentService, traderId);
      }
      // Job-board panel: refresh when the open board's pending jobs change
      // (a job claimed/completed by an assigned NPC) so the list stays live.
      if (uiState.value.jobBoard?.entityId === entityId) {
        mirrorJobBoardToUi(game.world, entityId);
      }
    }

    // Workstation panel cleanup: if the entity left AoI / was destroyed,
    // the world drop happened above and the mirror would no-op — but the
    // panel still has stale state. Close it so the next click can reopen.
    const wsId = uiState.value.workstation?.entityId;
    if (wsId && msg.destroys.includes(wsId)) {
      closePanel("workstation");
    }
    const chId = uiState.value.container?.entityId;
    if (chId && msg.destroys.includes(chId)) {
      closePanel("container");
    }
    const trId = uiState.value.trader?.npcId;
    if (trId && msg.destroys.includes(trId)) {
      closePanel("trader");
    }
    const jbId = uiState.value.jobBoard?.entityId;
    if (jbId && msg.destroys.includes(jbId)) {
      closePanel("job_board");
    }
    // A tracked ritual chest leaving AoI/destroyed isn't itself a `delta`,
    // so the container-scan trigger above wouldn't see it — rescan directly.
    if (game.ritualActive && !game.ritualDismissed && msg.destroys.length > 0) {
      game._recomputeRitualGuide();
    }

    game._finishLoadingIfReady();

    // Client-side prediction reconciliation
    if (game.predictor && game.playerId) {
      const playerState = game.world.get(game.playerId);
      const pos = playerState?.position;
      const vel = playerState?.velocity;
      if (pos) {
        const terrainFn = (x: number, y: number) => game.world.getTerrainHeight(x, y);
        const isOpenFn  = (x: number, y: number) => game.world.isOpen(x, y);
        const serverVel = vel ?? { x: 0, y: 0, z: 0 };
        if (!game.predictor.isInitialised) {
          game.predictor.seed(pos, serverVel);
        } else {
          game.predictor.reconcile(msg.ackInputSeq, pos, serverVel, terrainFn, isOpenFn);
        }
      }
    }

    for (const ev of msg.events) {
      switch (ev.type) {
        case "DamageDealt": {
          const blocked = ev.blocked ? " (blocked)" : "";
          console.log(`[Event] DamageDealt target=${ev.targetId.slice(-6)} source=${ev.sourceId.slice(-6)} amount=${ev.amount.toFixed(1)}${blocked}`);
          const screenPos = game.renderer?.getEntityScreenPos(ev.targetId);
          if (screenPos) game.overlay?.showDamage(screenPos.x, screenPos.y, Math.round(ev.amount), ev.blocked);
          game.decals?.onEvent(ev);
          // Hitstop punch (T-296+T-292): a real (unblocked) hit briefly
          // freezes the scene. No wire field for the server's exact
          // hitStopTicks — the client derives a flat short window from the
          // existing DamageDealt payload (amount already rides the wire),
          // scaling toward the longer end on a heavier hit. Only for hits
          // the LOCAL player dealt or took — the server's freeze
          // (collectHitStopFreezes) covers only attacker + targets, and a
          // bystander's whole scene stuttering on someone else's fight
          // reads as broken, not punchy.
          if (!ev.blocked && ev.amount > 0
              && (ev.targetId === game.playerId || ev.sourceId === game.playerId)) {
            const emphasis = Math.min(1, ev.amount / 25);
            game.renderer?.triggerHitStop(60 + emphasis * 60);
          }
          break;
        }
        case "HitSpark":
          game.renderer?.onParticleEvent(ev);
          break;
        case "Healed": {
          const screenPos = game.renderer?.getEntityScreenPos(ev.entityId);
          if (screenPos) game.overlay?.showHeal(screenPos.x, screenPos.y, Math.round(ev.amount));
          break;
        }
        case "EntityDied":
          console.log(`[Event] EntityDied entity=${ev.entityId.slice(-6)}${ev.killerId ? ` killer=${ev.killerId.slice(-6)}` : ""}`);
          game.decals?.onEvent(ev);
          game.renderer?.onEntityDied(ev.entityId);
          if (ev.entityId === game.playerId) {
            openPanel("death", true);
            pushToast("You died", "danger");
          }
          break;
        case "HungerCritical":
          console.log(`[Event] HungerCritical entity=${ev.entityId.slice(-6)}`);
          if (ev.entityId === game.playerId) pushToast("Starving!", "warn");
          break;
        case "DayPhaseChanged": {
          // Toast only — the renderer's day phase is derived from the streamed
          // WorldClock (worldClockPhase above, same content boundaries the
          // server fires this event from), never set from the event.
          console.log(`[Event] DayPhaseChanged phase=${ev.phase} time=${ev.timeOfDay.toFixed(2)}`);
          const labels: Record<string, string> = { dawn: "Dawn", noon: "Noon", dusk: "Dusk", midnight: "Midnight" };
          pushToast(labels[ev.phase] ?? ev.phase, "info");
          break;
        }
        case "CraftingCompleted":
          console.log(`[Event] CraftingCompleted crafter=${ev.crafterId.slice(-6)} recipe=${ev.recipeId}`);
          if (ev.crafterId === game.playerId) pushToast(`Crafted: ${ev.recipeId}`, "success");
          break;
        case "BuildingCompleted":
          console.log(`[Event] BuildingCompleted builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
          if (ev.builderId === game.playerId) {
            pushToast(`Built: ${humanizeItemType(ev.structureType)}`, "success");
            game._lastMissingToastKey = null;
          }
          break;
        case "BuildingMaterialsConsumed":
          console.log(`[Event] BuildingMaterialsConsumed builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
          if (ev.builderId === game.playerId) {
            const lines = ev.consumed.map((c) => `${c.quantity}× ${humanizeItemType(c.itemType)}`).join(", ");
            pushToast(`Materials used: ${lines}`, "info");
          }
          break;
        case "BuildingMissingMaterials": {
          console.log(`[Event] BuildingMissingMaterials builder=${ev.builderId.slice(-6)} type=${ev.structureType}`);
          if (ev.builderId === game.playerId) {
            // Throttle: only toast once per unique (structureType, missing list) combination
            const key = ev.structureType + ":" + ev.missing.map((m) => `${m.itemType}×${m.quantity}`).join(",");
            if (key !== game._lastMissingToastKey) {
              game._lastMissingToastKey = key;
              const lines = ev.missing.map((m) => `${m.quantity}× ${humanizeItemType(m.itemType)}`).join(", ");
              pushToast(`Missing: ${lines}`, "warn");
            }
          }
          break;
        }
        case "NodeDepleted":
          console.log(`[Event] NodeDepleted node=${ev.nodeId.slice(-6)} type=${ev.nodeTypeId} harvester=${ev.harvesterId.slice(-6)}`);
          if (ev.harvesterId === game.playerId) pushToast(`${ev.nodeTypeId} depleted`, "info");
          break;
        case "GateApproached":
          console.log(`[Event] GateApproached entity=${ev.entityId.slice(-6)} gate=${ev.gateId} dest=${ev.destinationTileId}`);
          if (ev.entityId === game.playerId) pushToast(`Entering ${ev.destinationTileId}`, "info");
          break;
        case "GateCrossing":
          console.log(`[Event] GateCrossing entity=${ev.entityId.slice(-6)} → ${ev.destinationTileAddress}`);
          if (ev.entityId === game.playerId) {
            game._transitionToTile(ev.destinationTileAddress, ev.destinationTileCertHashHex);
          }
          break;
        case "TradeCompleted":
          console.log(`[Event] TradeCompleted buyer=${ev.buyerId.slice(-6)} item=${ev.itemType} qty=${ev.quantity} coins=${ev.coinDelta}`);
          if (ev.buyerId === game.playerId) {
            const coins = ev.coinDelta > 0 ? `-${ev.coinDelta}` : `+${-ev.coinDelta}`;
            pushToast(`${ev.quantity}x ${ev.itemType} (${coins} coins)`, "success");
          }
          break;
        case "LoreExternalised":
          console.log(`[Event] LoreExternalised entity=${ev.entityId.slice(-6)} fragment=${ev.fragmentId}`);
          if (ev.entityId === game.playerId) pushToast(`Fragment written: ${ev.fragmentId}`, "info");
          break;
        case "LoreInternalised":
          console.log(`[Event] LoreInternalised entity=${ev.entityId.slice(-6)} fragment=${ev.fragmentId}`);
          if (ev.entityId === game.playerId) pushToast(`Lore absorbed: ${ev.fragmentId}`, "success");
          break;
        case "ZoneEntered":
          if (ev.playerId === game.playerId) {
            // Empty name = sub-threshold zone or no-zone band; clear
            // the HUD caption rather than show "You are in: ".
            currentZoneName.value = ev.zoneName;
            currentZoneRole.value = ev.topologyRole;
            currentZoneTraversal.value = ev.traversal;
            if (ev.zoneName) pushToast(`Entering: ${ev.zoneName}`, "info");
          }
          break;
        case "EnclosureChanged":
          game.roofRenderer?.onEnclosureChanged(ev.cells);
          break;
      }
    }
  };

  conn.onClose = () => {
    // During tile transitions we deliberately close the source connection;
    // the new connection is what runs after _transitionToTile() returns.
    // Don't tear the game down in that case.
    if (game.transitioning) return;
    console.log("[Game] disconnected");
    game.stop();
  };
}
