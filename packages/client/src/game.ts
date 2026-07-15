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
import { wireConnectionHandlers, applyLocalPlayerState } from "./connection/wire_handlers.ts";
import type { CharacterCreation } from "./connection/tile_connection.ts";
import { InputCapture } from "./input/input_capture.ts";
import { PointerLockController } from "./input/pointer_lock.ts";
import { IntentRouter } from "./input/intent_router.ts";
import { IntentTranslator } from "./input/intent_translator.ts";
import type { Intent } from "./input/intents.ts";
import { modeState, cursorVoxelState, type VoxelHit } from "./input/context.ts";
import { brushCells, type Cell } from "./input/build_line.ts";
import { BuildOccupancy } from "./state/build_occupancy.ts";
import { snapHeight } from "@voxim/world";
import { ClientWorld } from "./state/client_world.ts";
import type { ClientChunk } from "./state/client_world.ts";
import { ContentCache } from "./state/content_cache.ts";
import { FogOfWar } from "./state/fog_of_war.ts";
import { VoximRenderer } from "./render/renderer.ts";
import { SwingPredictor } from "./render/swing_predictor.ts";
import { BuildGhostRenderer } from "./render/build_ghost.ts";
import { HoverOutlineRenderer } from "./render/hover_outline.ts";
import { ScatterRenderer } from "./render/scatter_renderer.ts";
import { seedFromTileId } from "@voxim/world";
import { WaterRenderer } from "./render/water_renderer.ts";
import { RoofRenderer } from "./render/roof_renderer.ts";
import { DecalRenderer } from "./render/decal_renderer.ts";
import { crossCheckDecals } from "./render/decal_sources.ts";
import { crossCheckParticles } from "./render/particle_sources.ts";
import { crossCheckDeathStyles, registerDeathStyle } from "./render/death_style_registry.ts";
import { CrumbleController } from "./render/crumble_controller.ts";
import { AimIndicatorRenderer } from "./render/aim_indicator.ts";
import { canopyFade } from "./render/canopy_fade.ts";
import { InteractionSystem } from "./interaction/interaction_system.ts";
import { makeWorkstationHandler, makeContainerHandler, makeTraderHandler, makeJobBoardHandler, makeResourceNodeHandler, makeGroundItemHandler, makePoiInteractableHandler } from "./interaction/interactable_handlers.ts";
import { WorldOverlay } from "./ui/world_overlay.ts";
import { mountUI } from "./ui/mount_ui.tsx";
import { uiState, patchUI, openPanel, closePanel, pushToast, hotbarItems } from "./ui/ui_store.ts";
import { setClientWorld, setLocalPlayerId } from "./ui/client_world_ref.ts";
import { setContentService } from "./ui/content_ref.ts";
import { setFogRef } from "./ui/fog_ref.ts";
import type { UIAction } from "./ui/ui_actions.ts";
import { dispatchUIAction } from "./ui/ui_action_dispatch.ts";
import { openWorkstation, openTrader, openJobBoard, openContainer } from "./ui/panel_bridge.ts";
import { recordInput } from "./ui/network_capture.ts";
import { setDebugItemList } from "./ui/debug_store.ts";
import { loadLoginName } from "./ui/login.ts";
import { ACTION_USE_SKILL, ACTION_JUMP, ACTION_CROUCH, hasAction, CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { HeirRitualStep } from "./ui/ui_store.ts";
import { worldClockPhase } from "./state/state_mappers.ts";
import { DEFAULT_PHYSICS } from "@voxim/engine";
import { Predictor } from "./prediction/predictor.ts";
import { BootstrapSource } from "@voxim/content";
import { crossCheckProcModels } from "./render/procmodel/mod.ts";
import { crossCheckDesignLanguage } from "./render/procmodel/design_language_check.ts";
import { crossCheckTextureStyles } from "./render/material_textures.ts";
import { crossCheckFlickerCurves } from "./render/flicker_curves.ts";
import { crossCheckCliffVoxelisers } from "./render/cliff_voxeliser.ts";
import type { ContentService, Prefab, SwingableData } from "@voxim/content";

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


export class VoximGame {
  private connection: TileConnection = new TileConnection();
  world = new ClientWorld();
  /**
   * Fog-of-war state (T-157).  Lives on Game (not the renderer) because
   * server fog messages can arrive during `connect()` before the renderer
   * has been constructed; ClientWorld follows the same pattern.  The
   * renderer is given a reference once it's built so its EdgePass shader
   * can sample the texture.
   */
  fog = new FogOfWar();
  private content: ContentCache | null = null;
  /**
   * ContentService hydrated from the WT-handshake bootstrap blob (T-177).
   * Replaces the static-bundled `*_static.ts` imports for non-renderer
   * consumers (UI panels, debug item list, weapon-action lookup). Held
   * here so tile transitions can swap it for the new tile's blob.
   */
  contentService: ContentService | null = null;
  renderer: VoximRenderer | null = null;
  overlay: WorldOverlay | null = null;
  input: IntentTranslator | null = null;
  private inputCapture: InputCapture | null = null;
  private pointerLock: PointerLockController | null = null;
  intentRouter: IntentRouter | null = null;
  private animFrameId = 0;
  playerId: string | null = null;
  private inputSeq = 0;
  private commandSeq = 0;
  serverTick = 0;

  /**
   * Test/automation hooks (T-272 harness), reached via `window._voxim_game`.
   *
   * `testInput.down/up` drive a key through the real IntentTranslator path
   * (held set + one-shot action bits → buildDatagram → wire), so a headless
   * driver exercises the genuine input pipeline without depending on canvas
   * focus / faked DOM events. `animProbe` reads live animation state for the
   * harness to assert clips actually play (walk while moving, idle while still,
   * swing on attack) instead of only eyeballing a screenshot.
   */
  readonly testInput = {
    down: (code: string): void => this.input?.pressKey(code),
    up: (code: string): void => this.input?.releaseKey(code),
  };

  /**
   * Camera + facing scene-probe hook (T-320, rewired for T-328), reached via
   * `_voxim_game.cameraProbe`. Pointer-lock free-look CANNOT be driven
   * headless — the browser only delivers movementX/Y while a real cursor is
   * locked, which Playwright's synthetic mouse can't produce. This injects
   * look deltas straight into the same two seams pointer lock feeds (dx →
   * IntentTranslator.applyLookDelta, which now owns facing; dy →
   * cameraRig.applyLookDelta, pitch-only) so the harness can confirm facing
   * rotates continuously and the camera tracks it. `rotate()` also re-syncs
   * cameraRig's yaw from the fresh facing immediately (mirroring what the
   * next render() frame would do) so `yaw()`/`facing()` read the post-rotate
   * state synchronously instead of waiting a frame. Mirrors the sibling
   * testInput/buildProbe/interactProbe injection pattern.
   */
  readonly cameraProbe = {
    rotate: (dxPixels: number, dyPixels: number): void => {
      this.input?.applyLookDelta(dxPixels);
      this.renderer?.cameraRig.applyLookDelta(dyPixels);
      if (this.input) this.renderer?.cameraRig.setYaw(this.input.facing);
    },
    yaw: (): number => this.renderer?.cameraRig.getYaw() ?? 0,
    pitch: (): number => this.renderer?.cameraRig.getPitch() ?? 0,
    /** The player's facing (T-328) — should equal `yaw()` exactly at all
     *  times (rigid coupling); reading both is the headless check that the
     *  derivation never drifts. */
    facing: (): number => this.input?.facing ?? 0,
  };

  /**
   * Build-mode test hook (T-284): enter build mode for a blueprint so the harness
   * can screenshot the ghost (the per-frame cursor resolve then populates the
   * preview from the mouse position). Mirrors the `select_blueprint` UI action.
   */
  readonly buildProbe = {
    enter: (blueprintId: string): void => {
      const placeable = this.contentService?.prefabs.get(blueprintId)?.components.placeable as
        | { tool?: "single" | "line" }
        | undefined;
      const bld = this.contentService?.getGameConfig().building;
      modeState.value = {
        kind: "build",
        blueprintId,
        brush: {
          tool: placeable?.tool ?? "single",
          voxelSize: bld?.defaultVoxelSize ?? 1.0,
          spacing: bld?.defaultSpacing ?? 0,
        },
      };
    },
    setSpacing: (spacing: number): void => {
      const m = modeState.value;
      if (m.kind === "build") modeState.value = { ...m, brush: { ...m.brush, spacing } };
    },
    exit: (): void => { modeState.value = { kind: "normal" }; },
  };

  /**
   * Interact test hook (T-212 v2): sends `CommandType.UseEntity` directly,
   * bypassing hover/click. Needed because `testInput`'s `pressKey` deliberately
   * skips the E/Escape UI dispatches (see `intent_translator.ts`'s doc
   * comment) — there is no key-driven path to a world-prop interact for the
   * harness to exercise, same as `buildProbe` bypasses the build-mode UI.
   */
  readonly interactProbe = {
    use: (entityId: string): void => {
      this._sendCommand({ cmd: CommandType.UseEntity, entityId });
    },
  };

  /**
   * Snapshot an entity's animation for harness assertions (default = local
   * player): the networked clip layers + weapon action, plus the world-space
   * translation of a few bones (sampled from the same boneGroups the renderer
   * drives each frame). `hasSkeleton` distinguishes "rig never built" (bake-pool
   * wedge → no animation possible) from "rig built but motionless" (clip
   * resolution / no deltas). Sampling `bones` across two frames proves motion.
   */
  animProbe(
    entityId?: string,
    bones: string[] = ["lower_leg_l", "lower_leg_r", "lower_arm_r", "hand_r"],
  ): {
    entityId: string;
    hasSkeleton: boolean;
    clips: Array<{ clipId: string; time: number; weight: number }>;
    weaponActionId: string;
    ticksIntoAction: number;
    bones: Record<string, [number, number, number] | null>;
  } | null {
    const id = entityId ?? this.playerId;
    if (!id) return null;
    const anim = this.world.get(id)?.animationState ?? null;
    const boneWorld: Record<string, [number, number, number] | null> = {};
    for (const b of bones) boneWorld[b] = this.renderer?.sampleBoneWorld(id, b) ?? null;
    return {
      entityId: id,
      hasSkeleton: this.renderer?.hasSkeleton(id) ?? false,
      clips: (anim?.layers ?? []).map((l) => ({ clipId: l.clipId, time: l.time, weight: l.weight })),
      weaponActionId: anim?.weaponActionId ?? "",
      ticksIntoAction: anim?.ticksIntoAction ?? 0,
      bones: boneWorld,
    };
  }
  private running = false;
  predictor: Predictor | null = null;
  private lastFrameTime = 0;
  private interactionSystem: InteractionSystem | null = null;
  private buildGhost: BuildGhostRenderer | null = null;
  /** Per-column stack counter feeding the build cursor's vertical stacking (T-284). */
  readonly buildOccupancy = new BuildOccupancy();
  private hoverOutline: HoverOutlineRenderer | null = null;
  private scatter: ScatterRenderer | null = null;
  /** Per-tile id for the scatter VariantPool's deterministic seed. Defaults to
   *  the single-tile world; the gateway path overrides it. */
  private tileId = "0_0";
  private waterRenderer: WaterRenderer | null = null;
  roofRenderer: RoofRenderer | null = null;
  decals: DecalRenderer | null = null;
  /** Hold-to-aim arc + landing marker (T-337) — "you cannot aim what you cannot see". */
  private aimIndicator: AimIndicatorRenderer | null = null;
  /** Throttle key for the "missing materials" toast — avoids spam on every swing. */
  _lastMissingToastKey: string | null = null;

  /** Rolling FPS sampler — counts frames between publish ticks. */
  private fpsFrames = 0;
  /** Wall-clock at which the current FPS sampling window started. */
  private fpsWindowStart = 0;
  /** Per-section CPU time accumulators (ms), averaged over the FPS window. */
  private timingAccum = { frame: 0, sk: 0, trail: 0, gl: 0, post: 0 };
  /** Last `onlineCount` shipped via state message; pushed to UIState as it changes. */
  lastOnlineCount = -1;
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
  /** Chunk coords already counted toward the loading gate — a chunk DELTA
   *  (e.g. a terrain dig re-sending heightmap/materialGrid) must not count
   *  a chunk twice, or loading finishes early with terrain holes. */
  private readonly countedChunkCoords = new Set<string>();
  /** True once all terrain AND all entity models are preloaded. */
  loadingComplete = false;
  /** Session token kept around so tile transitions can re-join without re-auth. */
  private tileToken: string | null = null;
  /** True while a tile transition is in flight; suppresses onClose→stop(). */
  transitioning = false;

  // ── Heir ritual guidance (T-072) ──────────────────────────────────────────
  /** Last `Heritage.generation` observed for the local player. Null until the
   *  first heritage snapshot arrives — that first sighting is the baseline,
   *  never a trigger, so joining as an existing heir doesn't fire the ritual. */
  private lastHeritageGeneration: number | null = null;
  /** True once a genuine generation bump has been observed THIS session (a
   *  real death → heir respawn happened while connected). */
  ritualActive = false;
  /** Player closed the guidance banner; stays true until the next generation bump. */
  ritualDismissed = false;

  async start(config: GameConfig): Promise<void> {
    // Step 1: wire message handlers BEFORE connecting — eliminates the race where
    // the server's full snapshot arrives during connect() while handlers are still null.
    // All renderer/hud references use optional chaining — safe before they are created.
    wireConnectionHandlers(this, this.connection);

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
      this.tileId = gatewayResult.tileId;
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
    this.content = new ContentCache();
    // Decode the bootstrap blob into a full ContentService (T-177). Receiving
    // this from the same tile-server we just connected to guarantees the
    // client and server agree on content version — no drift, no mismatched
    // ids. Subsequent reconnects pick up server-side content edits for free.
    const blob = this.connection.bootstrapBlob();
    // T-339/T-357: the "crumble" death-style handler is stateful
    // (CrumbleController), so construct it and register the REAL handler
    // here — before crossCheckDeathStyles runs below — then inject the
    // controller into VoximRenderer. No placeholder/overwrite dance.
    const crumbleController = new CrumbleController();
    registerDeathStyle(
      "crumble",
      (entityId, mesh, def, durationTicks, ctx) => crumbleController.onDeath(entityId, mesh, def, durationTicks, ctx),
    );
    if (blob) {
      this.contentService = await BootstrapSource.load(blob);
      setContentService(this.contentService);
      this.content.setBootstrapService(this.contentService);
      // T-285: fail-fast cross-check that every ProcModelDef.generator resolves
      // to a registered generator and every ScatterDef.procModel resolves — the
      // client twin of server.ts's content cross-checks (generators live here).
      crossCheckProcModels(this.contentService);
      // T-301: every ProcModel/Scatter material resolves, no signal hue lands
      // on structural mass, character-class generators emit at the ground
      // plane — the boot-enforced twin of DESIGN_LANGUAGE.md.
      crossCheckDesignLanguage(this.contentService);
      // T-311 Phase 0a: every MaterialDef.render.textureStyle resolves to a
      // registered TextureStyle (the client twin of the procmodel cross-check).
      crossCheckTextureStyles(this.contentService);
      // T-311 Phase 2: every LightDef.flickerCurveId resolves to a registered curve.
      crossCheckFlickerCurves(this.contentService);
      crossCheckDecals(this.contentService);
      // T-340: every ParticleEmitterDef.source resolves to a registered
      // particle source, and every def.material resolves to a known material.
      crossCheckParticles(this.contentService);
      // T-339: every DeathStyleDef.style resolves to a registered client
      // death-style handler.
      crossCheckDeathStyles(this.contentService);
      // T-311 P6: every CliffProfileDef.id resolves to a registered cliffVoxeliser.
      crossCheckCliffVoxelisers(this.contentService);
      // T-315 D5: LOS gameplay tuning moved from protocol/fog.ts to
      // GameConfig.fogOfWar — keep the client's predicted LOS byte-parity
      // with the server's FogOfWarSystem, which reads the same values.
      this.fog.applyLosConfig(this.contentService.getGameConfig().fogOfWar);
      console.log(`[Game] content service hydrated: ${this.contentService.prefabs.size} prefabs, ${this.contentService.materials.size} materials, ${this.contentService.skeletons.size} skeletons, ${this.contentService.animationLibraries.size} animation libraries`);
    } else {
      console.warn("[Game] no bootstrap blob received — falling back to static-bundled content");
    }
    // Content hydrated above → the SSAA band (game_config render.supersample,
    // T-356) threads straight into construction; the renderer sizes every
    // post-FX target from it exactly once.
    this.renderer = new VoximRenderer(canvas, crumbleController, this.contentService?.getGameConfig().render.supersample);
    this.renderer.setLocalPlayer(this.playerId!);
    setLocalPlayerId(this.playerId!);
    this.renderer.setClientWorld(this.world);
    this.renderer.setContentCache(this.content);
    // T-331: rebuild any chunk the renderer deferred because it baked before
    // content was ready. A no-op here (the renderer was just constructed, so
    // nothing could have baked yet) — matters on the tile-transition path
    // below, where the renderer survives the reconnect.
    this.renderer.onContentHydrated();
    // Renderer-facing weapon actions + item prefabs sourced from the
    // bootstrap-delivered ContentService (T-177 phase 3).  Items are
    // filtered to those that look like inventory items (have an
    // equippable / swingable / tool / consumable / deployable component) —
    // mirrors what the static `item_prefabs` aggregation contained.
    if (this.contentService) {
      this.renderer.setWeaponActions([...this.contentService.weaponActions.values()]);
      // T-340: particle emitters + the engine-owned gravity constant they
      // integrate against (never a hardcoded TS constant).
      this.renderer.setParticleDefs([...this.contentService.particles.values()]);
      this.renderer.setParticlePhysics(this.contentService.getGameConfig().physics.gravity);
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
    for (const [, state] of this.world.entries()) {
      // Deduped against the wire-handler path — messages processed DURING
      // connect() already counted their chunks via _noteTerrainChunkReceived.
      if (state.heightmap) this._noteTerrainChunkReceived(state.heightmap.chunkX, state.heightmap.chunkY);
      if (state.worldClock) {
        this.renderer?.setDayPhase(worldClockPhase(
          state.worldClock.ticksElapsed, state.worldClock.dayLengthTicks,
          this.contentService?.getGameConfig().dayNight,
        ));
      }
    }
    patchUI({ loadingProgress: Math.min(1, this.terrainChunksReceived / VoximGame.TOTAL_CHUNKS) });
    console.log(`[Game] startup complete; terrain chunks pre-received during connect: ${this.terrainChunksReceived}/${VoximGame.TOTAL_CHUNKS}`);
    this._finishLoadingIfReady();
    // Input system — Capture (DOM listeners) → Translator (state + intents)
    // → Router (handlers). Replaces the old InputController callback surface.
    this.intentRouter = new IntentRouter();
    this.input = new IntentTranslator(this.intentRouter);
    // Mouse-sensitivity knob (T-328) — the same game_config.camera value
    // CameraRig.configure() installs for pitch, so facing and pitch turn at
    // the identical rate — plus the keyboard bindings (T-335), which are content
    // now. Pre-bootstrap defaults hold if content is absent.
    const gameCfg = this.content.getGameConfig();
    if (gameCfg?.camera) {
      // T-337: combat.aim (pitchMinDeg/pitchMaxDeg) rides the same configure()
      // call — the SAME band the server clamps InputState.pitch into.
      this.input.configure({ ...gameCfg.camera, bindings: gameCfg.input?.bindings, aim: gameCfg.combat?.aim });
    }
    // Apply the local player's join-time state through the SAME path the wire
    // handlers use (applyLocalPlayerState is the one definition of "apply
    // player state"). Doing it here — after this.input exists — is what lets
    // the equipment-derived input flags (buildMode, aimWeaponActive) reflect
    // the STARTING equipment: every message processed during connect() ran
    // with game.input === null and skipped them.
    {
      const playerState = this.playerId ? this.world.get(this.playerId) : undefined;
      if (playerState) applyLocalPlayerState(this, playerState);
    }
    const translator = this.input;
    this.inputCapture = new InputCapture(canvas, translator.handle, (e) => {
      // Take full control of the game keybindings: swallow the browser's own
      // default for our keys (Space/arrows scroll the page, Tab steals focus,
      // '/' opens quick-find, Digit/letter keys can trigger find-as-you-type).
      // Skip when (a) a text field is focused — never hijack typing — or (b) a
      // ctrl/meta/alt modifier is held, so OS/browser shortcuts (Ctrl+C/R/V,
      // Ctrl+Shift+I, …) keep working; game keys are bare presses.
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return false;
      return translator.gameKeys().has(e.code);
    });
    // Make the canvas focusable + focused so a headless driver's real
    // page.keyboard events have a stable, non-input activeElement to bubble
    // from to the document listener (T-272). The primary harness path is the
    // _voxim_game.testInput hook below; this covers real-key coverage too.
    canvas.tabIndex = 0;
    canvas.focus();

    // Free-look pointer lock (T-320): a canvas click engages lock; opening a
    // panel or entering build mode auto-releases so the cursor returns for
    // UI / voxel placement. Mouse deltas now split (T-328): dx drives the
    // player's FACING (IntentTranslator.applyLookDelta), dy drives the
    // camera's pitch only (cameraRig.applyLookDelta) — the camera's yaw
    // derives from facing every frame (renderer.render() → cameraRig.setYaw).
    //
    // T-337 CAPTURE decision: while `isAiming` (a hold-to-aim weapon's
    // trigger is held), dy is redirected to IntentTranslator.aimPitch
    // instead of the camera — the camera FREEZES at whatever pitch it had
    // when the hold began; mouse-Y instead drives aim distance. Facing (dx)
    // is NEVER captured — direction always updates.
    //
    // Justification (the ticket calls this a live "try both, pick one"
    // decision): CameraRig's pitch band is a deliberately narrow 17deg
    // (45-62deg, T-310) framing knob that keeps the horizon out of frame —
    // it was never meant as a gameplay control surface. Reusing it directly
    // as the distance axis would (a) give the whole aim range only 17deg of
    // mouse travel — imprecise — and (b) re-frame the ENTIRE screen every
    // time the player adjusts range, which fights the arc/landing-marker
    // readability T-337 explicitly requires ("you cannot aim what you
    // cannot see" — a marker whose screen position keeps jumping because
    // the CAMERA is rotating, not just because the aim point moved, reads
    // as broken) and risks reopening the exact horizon-flood/fog problem
    // T-310 closed if a player parks at the top of the band for many
    // consecutive shots. Capturing keeps the frame stable during every
    // hold, gives the aim axis its own independent band
    // (`combat.aim.pitchMinDeg/pitchMaxDeg`, tuned for gameplay range
    // rather than camera framing), and needs zero change to camera_rig.ts's
    // own pitchMinDeg/pitchMaxDeg.
    this.pointerLock = new PointerLockController(
      canvas,
      (dx, dy) => {
        this.input?.applyLookDelta(dx);
        if (this.input?.isAiming) {
          this.input.applyAimPitchDelta(dy);
        } else {
          this.renderer?.cameraRig.applyLookDelta(dy);
        }
      },
    );

    // Interaction system — nearest-interactable proximity selection + Use key
    // (T-320). Selects the closest matching entity each frame and drives the
    // hover outline off proximity; the Use (E) key activates the selection.
    this.interactionSystem = new InteractionSystem(this.world);
    // Each handler's reach is the SAME content value the server enforces on
    // the corresponding command — tune game_config, restart the tile, and the
    // client gate moves with it. Defaults hold pre-bootstrap.
    const cfg = this.contentService?.getGameConfig();
    const interactRange = cfg?.crafting.interactRange ?? 3;
    const tradeRange    = cfg?.trade.rangeWorldUnits ?? 3;
    const pickupRadius  = cfg?.items.pickupRadius ?? 2.5;
    this.interactionSystem.register(makeWorkstationHandler((entityId) => openWorkstation(this.world, entityId), interactRange));
    this.interactionSystem.register(makeContainerHandler((entityId) => openContainer(this.world, entityId), interactRange));
    this.interactionSystem.register(makeTraderHandler((entityId) => openTrader(this.world, this.playerId, this.contentService, entityId), tradeRange));
    this.interactionSystem.register(makeJobBoardHandler((entityId) => openJobBoard(this.world, entityId), interactRange));
    this.interactionSystem.register(makeResourceNodeHandler(interactRange));
    this.interactionSystem.register(makeGroundItemHandler((entityId) =>
      this._sendCommand({ cmd: CommandType.PickUp, entityId }), pickupRadius,
    ));
    this.interactionSystem.register(makePoiInteractableHandler((entityId) =>
      this._sendCommand({ cmd: CommandType.UseEntity, entityId }), interactRange,
    ));

    this._registerIntentHandlers();

    // Build-mode ghost renderer — subscribes to modeState + cursorVoxelState.
    this.buildGhost = new BuildGhostRenderer(
      this.renderer.scene,
      (x, y) => this.world.getTerrainHeight(x, y),
      (cellX, cellY) => this.buildOccupancy.stackHeight(cellX, cellY),
      (cellX, cellY) => this._isCellReachable(cellX, cellY),
    );

    // Hover outline — subscribes to hoverState; decides outline tint per
    // entity category and feeds the silhouette into the EdgePass mask.
    this.hoverOutline = new HoverOutlineRenderer(this.renderer, this.world);

    // Procedural scatter (T-285) — subscribes to chunk KindGrid arrivals and
    // renders a per-tile VariantPool of generated voxel props at every cell
    // whose boundary kind matches a ScatterDef (forests today; rocks/litter as
    // content). Entirely client-side via the shared instanced pool; the server
    // carries no individual prop entities. Replays already-loaded chunks on
    // registration so chunks that arrived during connect() get decorated. The
    // tile seed makes the pool deterministic (same tile → same props on reload).
    if (this.contentService) {
      this.scatter = new ScatterRenderer(
        this.renderer.instancePool, this.contentService, this.world,
        seedFromTileId(this.tileId),
      );
    }

    // Ephemeral combat decals (T-311 P4, designer Q8: in-memory + decay).
    // Wire GameEvents run through the decal-source registry; splats are thin
    // voxel slabs in the shared instanced pool — never saved, never networked.
    if (this.contentService) {
      this.decals = new DecalRenderer(this.renderer.instancePool, this.contentService, this.world);
    }

    // Hold-to-aim arc + landing marker (T-337) — updated per frame below.
    this.aimIndicator = new AimIndicatorRenderer(this.renderer.scene);

    // Water surface (T-159, rebuilt T-311 P5b) — translucent overlay over
    // WaterGrid.surfaceLevel cells, styled by the WaterStyleDef selected via
    // WorldClock.biomeTag. Same onChunkReady hook the scatter renderer uses;
    // no server-side water entities.
    this.waterRenderer = new WaterRenderer(this.renderer.scene, this.world, this.contentService);

    // Roof rendering over enclosed interiors (T-066). EnclosureSystem (server,
    // T-065) publishes the full enclosed-cell set on change; this renderer
    // groups it into per-building meshes and hides whichever one currently
    // contains the player (see the EnclosureChanged event handler + the
    // per-frame updateVisibility call below).
    this.roofRenderer = new RoofRenderer(
      this.renderer.scene,
      this.world,
      this.contentService?.getGameConfig().building.roofHeightAboveFloor ?? 2.0,
    );

    // Step 5: predictor + render loop. Tuning comes from the bootstrap-fresh
    // ContentService like every other config read — never a static bundle-time
    // game_config.json import, which would silently ignore server-side edits.
    const prediction = this.contentService?.getGameConfig().prediction;
    this.predictor = new Predictor(DEFAULT_PHYSICS, {
      correctionHalfLifeMs: prediction?.correctionHalfLifeMs ?? 60,
      hardSnapThresholdUnits: prediction?.hardSnapThresholdUnits ?? 2.0,
    });
    this.lastFrameTime = performance.now();
    this.running = true;
    this.scheduleFrame();
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
  async _transitionToTile(address: string, certHashHex: string): Promise<void> {
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
    this.scatter?.reset();
    this.decals?.reset();
    this.waterRenderer?.clear();
    this.roofRenderer?.clear();
    this.world.clear();
    this.buildOccupancy.clear();
    this.renderer?.clearWorld();
    // Entity-backed panels hold old-tile entity ids that world.clear() just
    // invalidated — old-tile entities never traverse msg.destroys (the only
    // other panel-closing path), so a panel left open across the gate would
    // render stale slots and dispatch commands the new tile can't resolve.
    closePanel("workstation");
    closePanel("container");
    closePanel("trader");
    closePanel("job_board");
    patchUI({ workstation: null, container: null, trader: null, jobBoard: null });
    this.terrainChunksReceived = 0;
    this.countedChunkCoords.clear();
    this.loadingComplete = false;
    this.predictor?.reset();

    // Fresh connection — handlers reference `this` so they keep working.
    const conn = new TileConnection();
    wireConnectionHandlers(this, conn);
    this.connection = conn;

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
        this.fog.applyLosConfig(this.contentService.getGameConfig().fogOfWar);
        console.log(`[Game] content service re-hydrated for new tile`);
      }
      // T-331: the renderer survives the reconnect, so if any chunk of the
      // new tile arrived and baked before content re-hydrated (the same
      // ordering hazard the initial join closes structurally, but here the
      // renderer is never null so the deferral gate is what saves it),
      // rebuild it now.
      this.renderer?.onContentHydrated();
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
    let localMovement: { x: number; y: number } | null = null;
    let localCrouch = 0;
    if (this.input) {
      const datagram = this.input.buildDatagram(++this.inputSeq, this.serverTick);
      // Movement INTENT (camera-relative world XY) — drives the local player's
      // locomotion lean directly, so it's snappy/instant (not physics velocity).
      localMovement = { x: datagram.movementX, y: datagram.movementY };
      localCrouch = hasAction(datagram.actions, ACTION_CROUCH) ? 1 : 0;
      this.connection.sendMovement(datagram);
      recordInput(datagram);
      // Track the send timestamp so we can derive RTT when this seq is
      // acked.  The Map is pruned on lookup so it stays small even if
      // some inputs are dropped on the unreliable datagram channel.
      this.inputSentAt.set(datagram.seq, datagram.timestamp);
      // Swing prediction (T-351): forecast the equipped weapon's opening
      // move (chain[0]) from local press/hold timing (heavy past
      // heavyChargeMs) so forceLocalAnimation doesn't wait RTT/2 for the
      // AnimationState delta. Mid-combo continuation is server-authoritative
      // (SwingChain, unnetworked) and arrives via AnimationState instead.
      // Runs every frame, not just on press, so the heavy promotion crosses
      // correctly when held past the threshold.
      {
        const pressed = hasAction(datagram.actions, ACTION_USE_SKILL);
        const player = this.playerId ? this.world.get(this.playerId) : undefined;
        const weaponPrefabId = player?.equipment?.weapon?.prefabId;
        const prefab = weaponPrefabId
          ? this.contentService?.prefabs.get(weaponPrefabId)
          : undefined;
        const swingable = prefab?.components?.["swingable"] as SwingableData | undefined;
        const predicted = this.swingPredictor.predict(pressed, swingable ?? null, performance.now());
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
    // Re-select the nearest interactable off the player's position (T-320) —
    // proximity, not cursor. Prefer the predicted position so selection tracks
    // smooth client motion; fall back to the networked snapshot.
    if (this.interactionSystem && this.playerId) {
      const me = this.world.get(this.playerId)?.position;
      const px = predictedPos?.x ?? me?.x;
      const py = predictedPos?.y ?? me?.y;
      if (px !== undefined && py !== undefined) this.interactionSystem.update(px, py);
    }
    // Publish the cursor's resolved voxel target so build-mode subscribers
    // (ghost renderer) read it reactively. Done every frame so the ghost tracks
    // cursor movement + column stacking without a per-frame poll per subscriber.
    if (this.input) {
      const hit = this._resolveVoxelHit(this.input.mouseX, this.input.mouseY);
      const prev = cursorVoxelState.value;
      const same = !!hit && !!prev &&
        prev.cellX === hit.cellX && prev.cellY === hit.cellY &&
        prev.baseZ === hit.baseZ && prev.layer === hit.layer;
      if (!hit) {
        if (prev !== null) cursorVoxelState.value = null;
      } else if (!same) {
        cursorVoxelState.value = hit;
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
        // Local mouse-driven facing (T-328, was movement-derived under T-320)
        // so the vision cone tracks the character's heading immediately, not
        // a server round-trip late; fall back to networked. The cone follows
        // wherever the mouse has turned the character to face.
        const facing = this.input?.facing ?? this.world.get(this.playerId)?.facing?.angle ?? 0;
        this.fog.updateLocalLOS(px, py, facing, (x, y) => this.world.isOpen(x, y));
      }
      // Roof hide-when-inside (T-066): same predicted-position source as the
      // canopy fade / fog LOS above.
      if (px !== undefined && py !== undefined) {
        this.roofRenderer?.updateVisibility(px, py);
      }
      // Hold-to-aim arc + landing marker (T-337) — same predicted-position
      // source, local facing, and the captured aim-pitch axis.
      if (px !== undefined && py !== undefined && pz !== undefined && this.contentService) {
        const facing = this.input?.facing ?? this.world.get(this.playerId)?.facing?.angle ?? 0;
        const pitch = this.input?.aimPitch ?? 0;
        const weaponPrefabId = this.world.get(this.playerId)?.equipment?.weapon?.prefabId;
        this.aimIndicator?.update(
          !!this.input?.isAiming,
          { origin: { x: px, y: py, z: pz }, facing, pitch, weaponPrefabId },
          this.contentService,
          (x, y) => this.world.getTerrainHeight(x, y),
        );
      }
    }

    // Water animation: bump the shared shader's uTime + flush any chunks
    // whose kindGrid arrived before their heightmap.
    this.waterRenderer?.tick(now);
    this.decals?.update(now);

    this.renderer?.render(this.serverTick, predictedPos, this.input?.facing ?? null, localMovement, localCrouch);

    // T-311 P5a/P5b: thread this frame's live sun direction + sky colour
    // (EnvironmentLighting is the single owner of both) into the water
    // shader's shared uniforms — after render() so envLighting has already
    // recomputed them this frame.
    if (this.renderer) {
      this.waterRenderer?.setSunDirection(this.renderer.getSunDirection());
      this.waterRenderer?.setSkyColor(this.renderer.getSkyColor());
    }

    // Push the now-settled camera yaw to the fog state so the north-up minimap
    // can draw a heading cone that rotates with the camera (T-317).
    if (this.renderer) this.fog.cameraYaw = this.renderer.cameraRig.getYaw();

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
  _sendCommand(command: CommandPayload): void {
    this.connection.sendCommand({ seq: ++this.commandSeq, command });
  }

  /**
   * Record a state message's `ackInputSeq`: derive RTT from the matching send
   * timestamp (EMA, α = 0.2 — smooth enough to read but reactive to spikes)
   * and prune every eclipsed entry from the send buffer. Called by the
   * connection handlers (connection/wire_handlers.ts) once per state message;
   * pairs with the `inputSentAt.set()` in frame().
   */
  _recordAckedSeq(ackInputSeq: number): void {
    const sentAt = this.inputSentAt.get(ackInputSeq);
    if (sentAt !== undefined) {
      const rtt = Date.now() - sentAt;
      this.smoothedPingMs = this.smoothedPingMs === 0
        ? rtt
        : this.smoothedPingMs * 0.8 + rtt * 0.2;
    }
    this.lastAckedSeq = ackInputSeq;
    // Prune everything ≤ acked seq. Keys are integers; iterate once.
    for (const seq of this.inputSentAt.keys()) {
      if (seq <= ackInputSeq) this.inputSentAt.delete(seq);
    }
  }

  /**
   * Observe the local player's `Heritage.generation`. A real bump this
   * session (not the first sighting — that's just the baseline) means a death
   * just advanced the dynasty and this spawn is the heir (T-079/T-270):
   * activate the ritual guidance and recompute the banner.
   */
  _observeHeritageGeneration(generation: number): void {
    if (this.lastHeritageGeneration !== null && generation > this.lastHeritageGeneration) {
      this.ritualActive = true;
      this.ritualDismissed = false;
    }
    this.lastHeritageGeneration = generation;
    this._recomputeRitualGuide();
  }

  /**
   * Heir ritual guidance (T-072). Rescans every entity currently known to
   * the client for a `container` belonging to the player's own dynasty
   * (matched via the player's own `Heritage.dynastyId`) and still holding
   * something. Deliberately NOT scripted to a fixed sequence: it just
   * reports what's really out there — the library step only exists while a
   * matching library chest has occupied slots, same for the treasury, and
   * the banner disappears on its own once both are empty (or the player
   * dismisses it). Reading/equipping still goes through the ordinary
   * container + inventory UI; there is no "do it for me" button here.
   */
  _recomputeRitualGuide(): void {
    if (!this.ritualActive || this.ritualDismissed || !this.playerId) {
      if (uiState.value.heirRitual) patchUI({ heirRitual: null });
      return;
    }
    const me = this.world.get(this.playerId);
    const dynastyId = me?.heritage?.dynastyId;
    if (!dynastyId) {
      if (uiState.value.heirRitual) patchUI({ heirRitual: null });
      return;
    }

    type Best = { entityId: string; pending: number; dist: number };
    let bestTome: Best | null = null;
    let bestGear: Best | null = null;

    for (const [entityId, state] of this.world.entries()) {
      const c = state.container;
      if (!c || c.dynastyId !== dynastyId || c.slots.length === 0) continue;
      const dist = (me?.position && state.position)
        ? Math.hypot(state.position.x - me.position.x, state.position.y - me.position.y)
        : Infinity;
      const candidate: Best = { entityId, pending: c.slots.length, dist };
      if (c.kind === "tome" && (!bestTome || dist < bestTome.dist)) bestTome = candidate;
      if (c.kind === "equipment" && (!bestGear || dist < bestGear.dist)) bestGear = candidate;
    }

    const steps: HeirRitualStep[] = [];
    if (bestTome) {
      steps.push({
        kind: "tome", containerId: bestTome.entityId, pending: bestTome.pending,
        distance: Number.isFinite(bestTome.dist) ? bestTome.dist : null,
      });
    }
    if (bestGear) {
      steps.push({
        kind: "equipment", containerId: bestGear.entityId, pending: bestGear.pending,
        distance: Number.isFinite(bestGear.dist) ? bestGear.dist : null,
      });
    }
    patchUI({ heirRitual: steps.length > 0 ? { steps } : null });
  }

  /**
   * Register the world-side intent handlers. UI panels and the radial menu
   * keep their Preact onClick paths and dispatch via _handleUIAction (which
   * the router will eventually subsume entirely once T-131 lands its build
   * mode handlers).
   */
  private _registerIntentHandlers(): void {
    const router = this.intentRouter!;

    // Use key (E) — activate the nearest interactable (T-320). Selection is
    // proximity-based every frame (InteractionSystem), so this just fires the
    // matching handler for the current selection: workstation/container/
    // job_board/trader open a panel, POI props → UseEntity, ground item →
    // PickUp. Resource nodes fall through (you swing at them). Unifies the old
    // cursor-first + nearest-ground-item fallback into one proximity path.
    router.register({
      id: "world-interact",
      priority: 50,
      claim: (intent: Intent) => {
        if (intent.kind !== "interact") return false;
        // Activation re-checks range against the SAME (predicted) position
        // the per-frame selection used — never a second position source.
        this.interactionSystem?.activateNearest();
        return true;
      },
    });

    // World main action (LMB release). LMB is now PURELY the swing (T-320) —
    // entity "click to open" is gone (no cursor); interaction is the Use key.
    // The server picks the swing variant from chargeMs (T-129); the translator
    // already set ACTION_USE_SKILL + chargeMs, so this handler only claims the
    // intent so other handlers don't double-fire on the same release.
    router.register({
      id: "world-attack",
      priority: 40,
      claim: (intent: Intent) => {
        if (intent.kind !== "world-main-action") return false;
        // The actual swing rides the next datagram via pendingActions/chargeMs.
        return true;
      },
    });

    // Build-mode actions (T-284). Single-tool: each LMB places one voxel at the
    // cursor column's top (stacking). Line-tool: first LMB stages the anchor (the
    // ghost previews anchor→cursor), second LMB commits the whole spacing-decimated
    // line and clears the anchor. The ghost + commit share brushCells, so WYSIWYG.
    router.register({
      id: "build-action",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "build-action") return false;
        const mode = modeState.value;
        if (mode.kind !== "build") return true;
        const hit = this._resolveVoxelHit(intent.canvasX, intent.canvasY);
        if (!hit) return true;
        if (mode.brush.tool === "single") {
          this._sendPlaceVoxels(mode.blueprintId, mode.brush.voxelSize, [{ cellX: hit.cellX, cellY: hit.cellY }]);
        } else if (!mode.line) {
          modeState.value = { ...mode, line: { anchor: hit } };
        } else {
          this._sendPlaceVoxels(mode.blueprintId, mode.brush.voxelSize, brushCells(mode.brush, mode.line.anchor, hit));
          modeState.value = { ...mode, line: undefined };
        }
        return true;
      },
    });

    // Build-undo: clear a staged line anchor; if there's nothing staged, exit
    // build mode entirely (same effect as build-cancel).
    router.register({
      id: "build-undo",
      priority: 30,
      claim: (intent: Intent) => {
        if (intent.kind !== "build-undo") return false;
        const mode = modeState.value;
        if (mode.kind !== "build") return true;
        if (mode.brush.tool === "line" && mode.line) {
          modeState.value = { ...mode, line: undefined };
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

  /**
   * Resolve the canvas cursor to a voxel placement target (T-284): flat-plane ray
   * → column (cellX,cellY), then the terrain top (baseZ, snapped to the 0.25
   * lattice) and the column's current stack height. One resolve feeds both the
   * ghost and the commit; `placeZ` is derived per brush, never stored.
   */
  private _resolveVoxelHit(canvasX: number, canvasY: number): VoxelHit | null {
    const me = this.playerId ? this.world.get(this.playerId) : null;
    const groundZ = me?.position?.z ?? 4.0;
    const worldPos = this.renderer?.getCursorWorldPos(canvasX, canvasY, groundZ);
    if (!worldPos) return null;
    const cellX = Math.floor(worldPos.x);
    const cellY = Math.floor(worldPos.y);
    const baseZ = snapHeight(this.world.getTerrainHeight(cellX + 0.5, cellY + 0.5));
    const layer = this.buildOccupancy.stackHeight(cellX, cellY);
    return { cellX, cellY, baseZ, layer };
  }

  /** Whether a build cell is within the player's reach — mirrors the server's
   *  per-cell reach gate so the ghost can warn (red) before the player commits. */
  private _isCellReachable(cellX: number, cellY: number): boolean {
    const me = this.playerId ? this.world.get(this.playerId) : null;
    if (!me?.position) return false;
    const maxReach = this.contentService?.getGameConfig().building.maxReachWorldUnits ?? 4.0;
    const dx = me.position.x - (cellX + 0.5);
    const dy = me.position.y - (cellY + 0.5);
    return dx * dx + dy * dy <= maxReach * maxReach;
  }

  /** One command stamps the brush's whole cell footprint (T-284 chunk 2). The
   *  server computes each voxel's z (terrain + stack) + validates reach. */
  private _sendPlaceVoxels(blueprintId: string, voxelSize: number, cells: Cell[]): void {
    if (cells.length === 0) return;
    this._sendCommand({
      cmd: CommandType.PlaceVoxels,
      prefabId: blueprintId,
      voxelSize,
      cells,
    });
  }

  /** Translate UI intents into server messages — see ui/ui_action_dispatch.ts. */
  private _handleUIAction(action: UIAction): void {
    dispatchUIAction(this, action);
  }

  /**
   * Push the local player's current hotbar occupancy to the renderer so
   * non-active slung items render on body anchors (T-309). Reads the SAME
   * derivation Hotbar.tsx uses (hotbarItems) so the HUD icons and the 3D
   * anchors never disagree.
   */
  _syncHotbarAttachments(): void {
    const hb = uiState.value.hotbar;
    if (!hb || !this.renderer) return;
    this.renderer.setHotbar(hotbarItems.value.map((it) => it?.itemType ?? null), hb.activeIndex);
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

  /** Count one terrain chunk's FIRST arrival toward the loading gate +
   *  progress UI. Deduped by chunk coord: later deltas touching the same
   *  chunk (digs) are counted zero times, so the gate can neither finish
   *  early nor keep patching loadingProgress forever after load. */
  _noteTerrainChunkReceived(chunkX: number, chunkY: number): void {
    const coord = `${chunkX},${chunkY}`;
    if (this.countedChunkCoords.has(coord)) return;
    this.countedChunkCoords.add(coord);
    this.terrainChunksReceived++;
    patchUI({ loadingProgress: Math.min(1, this.terrainChunksReceived / VoximGame.TOTAL_CHUNKS) });
    if (this.terrainChunksReceived % 20 === 0 || this.terrainChunksReceived === VoximGame.TOTAL_CHUNKS) {
      console.log(`[Game] terrain chunks received: ${this.terrainChunksReceived}/${VoximGame.TOTAL_CHUNKS}`);
    }
  }

  /** Run _finishLoading() once every expected terrain chunk has arrived. */
  _finishLoadingIfReady(): void {
    if (!this.loadingComplete && this.terrainChunksReceived >= VoximGame.TOTAL_CHUNKS) {
      this._finishLoading();
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
    // T-331: the terrain-chunk counter can cross TOTAL_CHUNKS while this
    // message is still being processed DURING the bootstrap blob's async
    // decode (a real await — gunzip — that lets the state-stream's read loop,
    // wired before connect() even resolves, race ahead of Step 4's renderer
    // construction). Bailing WITHOUT latching loadingComplete lets this retry
    // — either the next incoming message re-checks the same threshold, or
    // Step 4's own post-hydration check (line ~453) calls again once the
    // renderer exists. Latching here with a null renderer would silently
    // orphan every chunk currently in this.world (every updateTerrain call
    // below no-ops via `renderer?.`) with no further retry, ever — proven
    // live by forcing the race: the whole world rendered as empty ground.
    if (!this.renderer) return;
    this.loadingComplete = true;  // renderer calls active from this point

    console.log(`[Game] all terrain received — flushing world to renderer`);
    // Step 1: push all buffered world state into the renderer
    let terrainCount = 0, entityCount = 0, gateCount = 0;
    for (const [entityId, state] of this.world.entries()) {
      if (state.heightmap && state.materialGrid) {
        const chunk = this.world.getChunk(state.heightmap.chunkX, state.heightmap.chunkY);
        if (chunk?.heightmap && chunk.materialGrid) this.renderer?.updateTerrain(chunk as ClientChunk);
        terrainCount++;
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
      this.scatter?.start();
    }).catch(() => {
      patchUI({ loading: false });
      this.scatter?.start();
    });
  }

  stop(): void {
    this.running = false;
    this.predictor = null;
    this.terrainChunksReceived = 0;
    this.countedChunkCoords.clear();
    this.loadingComplete = false;
    cancelAnimationFrame(this.animFrameId);
    this.interactionSystem?.dispose();
    this.interactionSystem = null;
    this.buildGhost?.dispose();
    this.buildGhost = null;
    this.hoverOutline?.dispose();
    this.hoverOutline = null;
    this.scatter = null;
    this.waterRenderer?.clear();
    this.waterRenderer = null;
    this.roofRenderer?.dispose();
    this.roofRenderer = null;
    this.decals?.reset();
    this.decals = null;
    this.aimIndicator?.dispose();
    this.aimIndicator = null;
    this.inputCapture?.dispose();
    this.inputCapture = null;
    this.pointerLock?.dispose();
    this.pointerLock = null;
    this.input = null;
    this.intentRouter = null;
    this.connection.close();
    this.renderer?.dispose();
    this.overlay?.dispose();
    this.world.clear();
  }
}

