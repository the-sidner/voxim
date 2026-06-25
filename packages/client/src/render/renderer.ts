/// <reference lib="dom" />
/**
 * Voxim renderer — Three.js scene management.
 *
 * Visual grammar:
 *   - Post-process pipeline: scene → pixelTarget → depth-blit → heightTarget → EdgePass (Sobel + AO + sRGB) → canvas.
 *   - Flat shading: all geometry uses MeshPhongMaterial with flatShading:true.
 *   - Strong directional sun with hard shadows; dim hemisphere ambient.
 *
 * Camera is an orthographic isometric view (fixed 45°/45° angle).
 * The camera only translates to track the player — orientation never changes.
 * Culling: only the player's current terrain chunk plus its 8 neighbours are
 * visible (3×3 chunk window = 96×96 world units). Entities outside a 68-unit
 * radius from the player have their groups hidden.
 */
import * as THREE from "three";
import type { HeightmapData, MaterialGridData } from "@voxim/codecs";
import type { EntityState } from "../state/client_world.ts";
import type { ContentCache } from "../state/content_cache.ts";
import type { WeaponActionDef, Prefab } from "@voxim/content";
import { buildChunkAtoms, TERRAIN_DISP_MAG } from "./terrain_voxels.ts";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { canopyFade } from "./canopy_fade.ts";
import { setClientPalette, paletteToken } from "./palette.ts";
import { WeaponTrailRenderer } from "./weapon_trail.ts";
import { GateMarkerRenderer } from "./gate_marker.ts";
import { EntityMeshRegistry } from "./entity_mesh_registry.ts";
import { EnvironmentLighting } from "./environment_lighting.ts";
import { updateSkeletonPose, blendAnimationLayers, type EntityMeshGroup } from "./entity_mesh.ts";
import type { InteractionSystem } from "../interaction/interaction_system.ts";
import { InstancePool } from "./instance_pool.ts";
import { evaluatePose } from "./skeleton_evaluator.ts";
import { solveSwingPose } from "@voxim/content";
import { SkeletonOverlay } from "./skeleton_overlay.ts";
import { FacingOverlay, ChunkOverlay } from "./debug_overlay.ts";
import { BladeDebugOverlay } from "./blade_debug_overlay.ts";
import { HitboxDebugOverlay, HITBOX_OVERLAY_LAYER } from "./hitbox_debug_overlay.ts";
import { DebugOverlayManager } from "./debug_overlay_manager.ts";
import type { DebugUpdateContext } from "./debug_overlay_manager.ts";
import { HitSparkRenderer } from "./hit_spark_renderer.ts";
import { LightManager } from "./light_manager.ts";
import { EdgePass } from "./edge_pass.ts";
import { CameraRig } from "./camera_rig.ts";
import type { FogOfWar } from "../state/fog_of_war.ts";
import { FOG_GRID_SIZE, FOG_CELL_SIZE } from "@voxim/protocol";


/**
 * Depth → world-Y blit pass.
 *
 * Reads pixelTarget.depthTexture (written during Pass 1 for every rendered
 * object — terrain, entities, trees, props) and reconstructs the exact world-Y
 * coordinate for each pixel using the camera's inverse matrices.  The result is
 * stored in heightTarget as a normalised greyscale value [0, 1].
 *
 * Running as a SEPARATE pass after Pass 1 means pixelTarget.depthTexture is
 * never bound alongside pixelTarget.texture in the same draw call — avoiding
 * the WebGL2 driver bug that returns black for the colour texture when both
 * attachments of the same FBO are sampled simultaneously.
 *
 * Sky / unrendered pixels are cleared to white (depth = 1.0 → output 1.0) so
 * they are never darkened by EdgePass height shading.
 */
const DEPTH_BLIT_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const DEPTH_BLIT_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tDepth;
  uniform mat4      uProjInv;
  uniform mat4      uViewInv;
  uniform float     uHeightMin;
  uniform float     uHeightMax;

  void main() {
    float depth = texture2D(tDepth, vUv).r;

    // Unrendered (sky) pixels have depth = 1.0 (GL clear default).
    // Output white so EdgePass does not darken sky areas.
    if (depth >= 0.9999) {
      gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
      return;
    }

    // Reconstruct world position from depth + camera inverse matrices.
    vec4 ndc     = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = uProjInv * ndc;
    viewPos     /= viewPos.w;           // perspective divide (identity for ortho, harmless)
    vec4 world   = uViewInv * viewPos;

    float h = clamp((world.y - uHeightMin) / (uHeightMax - uHeightMin), 0.0, 1.0);
    gl_FragColor = vec4(h, h, h, 1.0);
  }
`;

/** Terrain chunk size in world units. Must match CHUNK_SIZE in @voxim/world. */
const CHUNK_SIZE = 32;

/**
 * Entities further than this squared distance from the local player have
 * their Three.js group hidden each frame. Sized for the pulled-back camera
 * (~35m slant distance) — visible ground footprint can reach ~50m forward.
 */
const CULL_RADIUS_SQ = 160 * 160;

/** 3rd-person camera vertical sample range above/below player Y for height shading. */
const HEIGHT_SHADE_BELOW = 8.0;
const HEIGHT_SHADE_ABOVE = 24.0;


/**
 * How many milliseconds behind the latest received state remote entities
 * are rendered, to allow smooth linear interpolation between server ticks.
 */
const INTERP_DELAY_MS = 100;

/** Lerp a number toward target, returning new value. */
function lerpN(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Short-path angle lerp (handles ±π wrap). */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + d * t;
}


/**
 * Minimal contract VoximRenderer needs from HoverOutlineRenderer — declared
 * here so renderer.ts does not import the outline module (which would
 * cycle).  HoverOutlineRenderer implements this directly.
 */
export interface HoverOutlineSink {
  notifyEntityRebuilt(entityId: string): void;
}

/**
 * Three.js layer used for the hover silhouette mask pass.
 * The main camera never renders this layer (it sees layer 0 only).
 * HoverOutlineRenderer enables it on the hovered entity's meshes (or on
 * proxy shells for prop-pool entities) so the mask pass renders them into
 * hoverMaskTarget.  Exported because the renderer doesn't own hover state
 * any more — the outline renderer does, and reads this as a constant.
 */
export const HOVER_LAYER = 4;



export class VoximRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraRig: CameraRig;
  readonly camera: THREE.PerspectiveCamera;

  /** Per-chunk terrain: one voxel Mesh per material present in the chunk (T-283). */
  private readonly terrainMeshes  = new Map<string, THREE.Mesh[]>();
  /** Gate marker pillars (T-145), keyed by entityId. World-space group containing pillar mesh. */
  private gateMarkers!: GateMarkerRenderer; // set in constructor (needs camera + renderer)
  private readonly terrainHmaps   = new Map<string, HeightmapData>();
  private readonly terrainMats    = new Map<string, MaterialGridData>();
  /** Entity-mesh lifecycle — live animated meshes + pooled-prop positions + the
   *  async spawn→build state machine (T-282). The renderer reaches the meshes
   *  through `entities.all` / `entities.get(id)` for its per-frame pose loop. */
  private entities!: EntityMeshRegistry; // set in constructor (needs instancePool + overlays)
  /** Diagnostic — count of live EntityMeshGroups (animated and placeholder). */
  get entityCount(): number { return this.entities.count; }

  /**
   * Test/automation (T-272 harness): world-space translation of a bone, or null
   * if the entity has no built skeleton or no such bone. Reads the SAME
   * `boneGroups` the per-frame pose drives (matrixWorld is current after the
   * render() that just ran), so sampling it twice across frames proves a clip
   * is actually advancing — not merely selected. `boneGroups == null` here also
   * tells the harness the skeleton was never built (the bake-pool wedge case).
   */
  sampleBoneWorld(entityId: string, boneId: string): [number, number, number] | null {
    return this.entities.sampleBoneWorld(entityId, boneId);
  }

  /** Test/automation: true once the entity's animated skeleton rig is built
   * (boneGroups present). Lets the harness distinguish "no rig / bake wedged"
   * from "rig built but motionless". */
  hasSkeleton(entityId: string): boolean {
    return this.entities.hasSkeleton(entityId);
  }
  /**
   * Single owner of all procedurally-placed static instanced rendering
   * (forest decorations, server props, future rocks). See
   * `instance_pool.ts` for the architecture and per-frame culling model.
   * Owned by the renderer (its render loop drives the per-frame cull); the
   * EntityMeshRegistry receives it by reference for the static-prop handoff.
   */
  readonly instancePool: InstancePool;

  readonly debugOverlayManager: DebugOverlayManager;
  // Typed refs for event-driven calls (trackEntity, addChunk, etc.)
  private readonly _skeletonOverlay: SkeletonOverlay;
  private readonly _chunkOverlay:    ChunkOverlay;
  private readonly hitSparkRenderer: HitSparkRenderer;
  private readonly lightManager = new LightManager();

  private cameraTarget = new THREE.Vector3(256, 4, 256);
  private localPlayerId: string | null = null;
  private content: ContentCache | null = null;

  /** Smooth animation tick — advances at server tick rate (20 Hz) based on real time. */
  private smoothTick = 0;
  private lastKnownServerTick = -1;
  private lastServerTickMs = 0;
  private lastFrameMs = 0;

  /** Full-res render target — 3D scene is drawn here before post-processing. */
  private readonly pixelTarget: THREE.WebGLRenderTarget;
  /** Height target — world-Y encoded as grayscale, fed into EdgePass for height shading. */
  private readonly heightTarget: THREE.WebGLRenderTarget;
  /** Fullscreen scene + material for the depth → world-Y blit pass. */
  private readonly depthBlitScene: THREE.Scene;
  private readonly depthBlitMat: THREE.ShaderMaterial;
  /** Screen-space edge detection — runs during the blit pass. */
  private readonly edgePass: EdgePass;
  /** Hover mask: hovered entity rendered flat-white; fed into EdgePass for silhouette outline. */
  private readonly hoverMaskTarget: THREE.WebGLRenderTarget;
  /** Override material used during the hover mask pass — flat white, no lighting. */
  private readonly hoverMaskMat: THREE.MeshBasicMaterial;
  /** Fullscreen blit pass: upscales pixelTarget to the canvas. */
  private readonly blitScene: THREE.Scene;
  private readonly blitMesh: THREE.Mesh;
  private readonly blitCamera: THREE.OrthographicCamera;
  /** Debug: when true the blit pass shows the raw height texture instead of the scene. */
  private heightDebugEnabled = false;
  /** Debug: when true, skip the entire post-FX pipeline and render scene direct to canvas. */
  private bypassPostFX = false;

  /**
   * CPU time (ms) spent in major sections of the most recent render() call.
   * Read by the HUD diagnostics in game.ts. Each field is overwritten every
   * frame; the HUD averages over ~500 ms before display.
   *
   * `drawCalls` and `tris` come from renderer.info.render and reflect what
   * actually reached the GPU (after Three.js frustum culling).
   */
  readonly frameTimings = { skMs: 0, trailMs: 0, glMs: 0, drawCalls: 0, tris: 0 };

  /**
   * Fog-of-war reference (T-157).  Game owns the FogOfWar instance because
   * server fog messages may arrive before the renderer is constructed; we
   * receive a reference here via {@link attachFog} once the renderer is
   * ready, and the EdgePass starts sampling the real texture from then on.
   */
  private attachedFog: FogOfWar | null = null;

  /** Weapon tip trail ribbons — owns its own slice/mesh state + scene layer. */
  private readonly weaponTrail = new WeaponTrailRenderer(this.scene);

  /** Weapon action definitions — set by setWeaponActions() from game.ts. Shared by
   *  reference with the EntityMeshRegistry (its sync* reads swing actions). */
  private weaponActionsMap = new Map<string, WeaponActionDef>();
  /** Item prefab definitions — set by setItemPrefabs() from game.ts. Used to resolve modelId for equipped items. */
  private itemPrefabMap = new Map<string, Prefab>();

  /** Sun + hemisphere ambient + sky/fog + day-night phase lerp + shadow follow.
   *  Set in the constructor (mutates this.scene's lights + fog/background). */
  private envLighting!: EnvironmentLighting;

  constructor(canvas: HTMLCanvasElement) {
    this.instancePool = new InstancePool(this.scene);

    // Build all debug overlays and register them with the manager.
    this._skeletonOverlay = new SkeletonOverlay(this.scene);
    this._chunkOverlay    = new ChunkOverlay(this.scene);
    this.debugOverlayManager = new DebugOverlayManager();
    this.debugOverlayManager.register("skeleton",  this._skeletonOverlay);
    this.debugOverlayManager.register("facing",    new FacingOverlay(this.scene));
    this.debugOverlayManager.register("chunks",    this._chunkOverlay);
    this.debugOverlayManager.register("blade",     new BladeDebugOverlay(this.scene));
    this.debugOverlayManager.register("hitbox",    new HitboxDebugOverlay());

    this.hitSparkRenderer = new HitSparkRenderer(this.scene);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap; // hard 1-pixel shadow edges → thin outline
    // Disable auto-reset so renderer.info accumulates draw calls / triangles
    // across every renderer.render() call within a single frame (shadow pass +
    // main scene + post-FX passes). render() resets manually at the top.
    this.renderer.info.autoReset = false;

    const aspect = (canvas.clientWidth || canvas.width || 320) / (canvas.clientHeight || canvas.height || 180);
    this.cameraRig = new CameraRig(aspect);
    this.camera = this.cameraRig.camera;
    this.cameraRig.update(this.cameraTarget);
    this.gateMarkers = new GateMarkerRenderer(this.scene, this.camera, this.renderer.domElement);
    this.entities = new EntityMeshRegistry(
      this.scene, this.instancePool, this.weaponActionsMap, this.itemPrefabMap,
      this._skeletonOverlay, this.lightManager, this.debugOverlayManager,
    );

    // ---- render target (with depth texture for the depth-blit pass) ----
    const pw = Math.max(1, canvas.clientWidth  || canvas.width  || 320);
    const ph = Math.max(1, canvas.clientHeight || canvas.height || 180);
    // Float depth texture — more portable for shader sampling than UnsignedIntType
    // on WebGL2 (some drivers return undefined values for DEPTH_COMPONENT24 sampling).
    const depthTex = new THREE.DepthTexture(pw, ph, THREE.FloatType);
    depthTex.format = THREE.DepthFormat;
    this.pixelTarget = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
    });
    this.pixelTarget.depthTexture = depthTex;

    // ---- height target + depth-blit pass ----
    this.heightTarget = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      stencilBuffer: false,
    });
    this.depthBlitMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth:     { value: depthTex },
        uProjInv:   { value: new THREE.Matrix4() },
        uViewInv:   { value: new THREE.Matrix4() },
        uHeightMin: { value: 0.0  },
        uHeightMax: { value: 16.0 },
      },
      vertexShader:   DEPTH_BLIT_VERT,
      fragmentShader: DEPTH_BLIT_FRAG,
      depthTest:  false,
      depthWrite: false,
    });
    this.depthBlitScene = new THREE.Scene();
    this.depthBlitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.depthBlitMat));

    // ---- hover mask target + material -----------------------------------
    this.hoverMaskTarget = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
    });
    // depthTest off → silhouette captures the full shape even when occluded
    // by walls or terrain (the outline reads as an x-ray hint of the entity
    // when something blocks it).
    this.hoverMaskMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
    });

    // ---- edge pass + fullscreen blit scene ----
    // EdgePass also applies fog-of-war modulation (T-157): it samples the
    // depth texture to reconstruct world XZ, looks up the fog cell, and
    // multiplies the final colour.  Until attachFog() runs we hand it a
    // 1×1 placeholder so the shader compiles cleanly; uTileSize stays 0
    // (fog disabled) until attach.
    const fogPlaceholder = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    fogPlaceholder.needsUpdate = true;
    this.edgePass = new EdgePass(
      this.pixelTarget.texture,
      this.heightTarget.texture,
      this.hoverMaskTarget.texture,
      depthTex,
      fogPlaceholder,
      pw, ph,
    );
    this.blitScene  = new THREE.Scene();
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blitGeo = new THREE.PlaneGeometry(2, 2);
    this.blitMesh = new THREE.Mesh(blitGeo, this.edgePass.material);
    this.blitScene.add(this.blitMesh);

    // ---- environment lighting (sun + hemi + sky/fog + day-night) ----
    this.envLighting = new EnvironmentLighting(this.scene);

    globalThis.addEventListener("resize", () => this.onResize(canvas));
  }

  setLocalPlayer(id: string): void {
    this.localPlayerId = id;
    this.entities.setLocalPlayer(id);
  }

  /**
   * Hand the renderer the Game-owned FogOfWar (T-157).  The EdgePass shader
   * will start sampling its texture from the next frame; before this call
   * a 1×1 placeholder is bound and `uTileSize = 0` disables fog modulation.
   */
  attachFog(fog: FogOfWar): void {
    this.attachedFog = fog;
    this.edgePass.setFogTexture(fog.texture);
    this.edgePass.setTileSize(FOG_GRID_SIZE * FOG_CELL_SIZE);
  }

  setContentCache(cache: ContentCache): void {
    this.content = cache;
    this.entities.setContent(cache);
    // Lighting + sky/fog come from the single palette source (T-280) once the
    // bootstrap arrives — replaces the hardcoded cyan noon sky with the
    // ash-hazed phase colors (EnvironmentLighting rebuilds its phase table).
    const pal = cache.getPalette();
    if (pal) {
      setClientPalette(pal);
      this.envLighting.applyPalette(pal);
      // Edge ink is content-driven now (T-285 art sweep): the silhouette/crease
      // tint reads the `edgeInk` palette token instead of a hardcoded literal.
      this.edgePass.setEdgeColor(paletteToken("edgeInk"));
    }
  }


  // ---- terrain ----

  updateTerrain(heightmap: HeightmapData, materials: MaterialGridData): void {
    const cx = heightmap.chunkX, cy = heightmap.chunkY;
    const key = `${cx},${cy}`;

    this.terrainHmaps.set(key, heightmap);
    this.terrainMats.set(key, materials);

    // Each cell's column floors to the lowest of its FOUR neighbours, so the new
    // chunk changes the cliff depth along every shared edge — rebuild all four
    // cardinal neighbours, not just W/N.
    this._rebuildChunk(cx, cy);
    this._rebuildChunk(cx - 1, cy);
    this._rebuildChunk(cx + 1, cy);
    this._rebuildChunk(cx, cy - 1);
    this._rebuildChunk(cx, cy + 1);
  }

  private _rebuildChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    const hm = this.terrainHmaps.get(key);
    const mat = this.terrainMats.get(key);
    if (!hm || !mat) return;

    // Tear down the chunk's previous mesh set as a unit — a rebuild can add or
    // drop a material, so the whole multi-material set is replaced.
    const old = this.terrainMeshes.get(key);
    if (old) {
      for (const me of old) {
        this.scene.remove(me);
        me.geometry.dispose();
        (me.material as THREE.Material).dispose();
      }
    }

    // Re-express the chunk as voxel atoms (column boxes) bucketed by material,
    // then bake one mesh per material through the shared voxel pipeline (T-283).
    const byMat = buildChunkAtoms(hm, mat, {
      N: this.terrainHmaps.get(`${cx},${cy - 1}`) ?? null,
      E: this.terrainHmaps.get(`${cx + 1},${cy}`) ?? null,
      S: this.terrainHmaps.get(`${cx},${cy + 1}`) ?? null,
      W: this.terrainHmaps.get(`${cx - 1},${cy}`) ?? null,
    });
    const meshes: THREE.Mesh[] = [];
    for (const [matId, atoms] of byMat) {
      const geo = geometryFromBaked(bakeVoxels(atoms, matId, TERRAIN_DISP_MAG));
      const m = buildVoxelMaterial(this.content?.getMaterialSync(matId), matId);
      canopyFade.register(m, { voxelMode: true });
      const me = new THREE.Mesh(geo, m);
      me.name = "terrain";
      me.castShadow = true;
      me.receiveShadow = true;
      this.scene.add(me);
      meshes.push(me);
    }

    const isNew = !this.terrainMeshes.has(key);
    this.terrainMeshes.set(key, meshes);
    if (isNew) this._chunkOverlay.addChunk(cx, cy, this.debugOverlayManager.isOn("chunks"));
  }

  removeTerrain(chunkX: number, chunkY: number): void {
    const key = `${chunkX},${chunkY}`;
    const meshes = this.terrainMeshes.get(key);
    if (meshes) {
      for (const me of meshes) {
        this.scene.remove(me);
        me.geometry.dispose();
        (me.material as THREE.Material).dispose();
      }
      this.terrainMeshes.delete(key);
      this.terrainHmaps.delete(key);
      this.terrainMats.delete(key);
      this._chunkOverlay.removeChunk(chunkX, chunkY);
    }
  }

  // ---- entities ----

  updateEntity(entityId: string, state: EntityState): void {
    this.entities.updateEntity(entityId, state);
  }

  /**
   * Immediately override the local player's weapon action for client-side prediction.
   * Called the instant the player attacks so the swing is visible without waiting for
   * the server round-trip. The server's confirmed AnimationState will overwrite this
   * within one tick (≤50ms) via the normal delta path.
   */
  forceLocalAnimation(weaponActionId: string): void {
    if (!this.localPlayerId) return;
    const mesh = this.entities.get(this.localPlayerId);
    if (mesh) {
      const current = mesh.animationState;
      mesh.animationState = {
        layers: current?.layers ?? [],
        weaponActionId,
        ticksIntoAction: 0,
      };
      mesh.lastAnimUpdateMs = performance.now();
    }
  }

  removeEntity(entityId: string): void {
    this.entities.removeEntity(entityId);
  }

  /**
   * Drop every entity and terrain chunk currently rendered. Used by tile
   * transitions (T-141) to wipe the source tile's world before the destination
   * tile's state messages start arriving on a fresh connection. Preserves
   * renderer infrastructure (post-process targets, content cache, debug
   * overlays' configuration) — only the per-tile scene contents go.
   */
  clearWorld(): void {
    this.entities.clear();
    this.gateMarkers.dispose();
    for (const key of [...this.terrainMeshes.keys()]) {
      const [cx, cy] = key.split(",").map(Number);
      this.removeTerrain(cx, cy);
    }
    this.attachedFog?.reset();
  }

  // ---- gate markers (T-145) ----

  /**
   * Show or move a navigational marker for a gate entity. The mesh is a tall
   * coloured pillar topped with a faintly glowing capstone — visible from
   * across the tile so the player can navigate toward it. A floating text
   * label ("→ tile_1") is rendered separately by WorldOverlay using the
   * pillar's screen position.
   */
  updateGateMarker(entityId: string, x: number, y: number, z: number, edge: string): void {
    this.gateMarkers.update(entityId, x, y, z, edge);
  }

  removeGateMarker(entityId: string): void {
    this.gateMarkers.remove(entityId);
  }

  getGateScreenPos(entityId: string): { x: number; y: number } | null {
    return this.gateMarkers.screenPos(entityId);
  }

  // ---- interaction system ----

  setInteractionSystem(is: InteractionSystem | null): void {
    this.entities.setInteraction(is);
  }

  /**
   * Register the hover outline renderer.  The registry notifies it when an
   * entity's meshes are rebuilt mid-hover (placeholder → skeleton upgrade)
   * so the outline can re-attach to the new geometry without waiting for the
   * cursor to move.  Pass null to detach.
   */
  setHoverOutline(o: HoverOutlineSink | null): void {
    this.entities.setHover(o);
  }

  /** Public read access to an entity's mesh group — used by InteractionSystem and HoverOutlineRenderer. */
  getEntityMesh(entityId: string): EntityMeshGroup | null {
    return this.entities.getEntityMesh(entityId);
  }

  /** World position of a static prop entity, or null if it isn't in the prop pool. */
  getPropPosition(entityId: string): THREE.Vector3 | null {
    return this.entities.getPropPosition(entityId);
  }

  /** EdgePass — exposed so HoverOutlineRenderer can drive uHoverActive / uHoverColor. */
  getEdgePass(): EdgePass {
    return this.edgePass;
  }

  // ---- camera ----

  getPlayerScreenPos(): { x: number; y: number } {
    return this.getEntityScreenPos(this.localPlayerId ?? "") ?? { x: 0, y: 0 };
  }

  /**
   * Unproject canvas pixel coordinates onto the world ground plane.
   *
   * Coordinate mapping: world(x, y, z) → three(x, z, y).
   * The ground plane in Three.js space is y = groundHeight (= world z).
   * Returns world-space { x, y } of the intersection, or null if the ray
   * is parallel to the plane (shouldn't happen for the fixed iso camera).
   */
  getCursorWorldPos(canvasX: number, canvasY: number, groundHeight: number): { x: number; y: number } | null {
    const w = this.renderer.domElement.clientWidth  || this.renderer.domElement.width;
    const h = this.renderer.domElement.clientHeight || this.renderer.domElement.height;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(
        (canvasX / w) * 2 - 1,
        -(canvasY / h) * 2 + 1,
      ),
      this.camera,
    );
    // Ground plane at Three.js y = groundHeight (= world.z / surface height)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundHeight);
    const hit = new THREE.Vector3();
    const result = raycaster.ray.intersectPlane(plane, hit);
    if (!result) return null;
    // three.x = world.x, three.z = world.y
    return { x: hit.x, y: hit.z };
  }

  /**
   * Cursor-to-facing for the local player: raycast the cursor onto the ground
   * plane at the player's current Y, then return atan2(dy, dx) from player to
   * cursor in game-space (X, Y) — directly usable as `facing` on the wire.
   * Returns null if the local player has no mesh yet or the ray misses.
   */
  getCursorFacing(canvasX: number, canvasY: number): number | null {
    if (!this.localPlayerId) return null;
    const mesh = this.entities.get(this.localPlayerId);
    if (!mesh) return null;
    // Ground plane = local player's current Y (Three.js y = game z = height).
    const hit = this.getCursorWorldPos(canvasX, canvasY, mesh.group.position.y);
    if (!hit) return null;
    // Player position in game coords: three.x = game.x, three.z = game.y.
    const px = mesh.group.position.x;
    const py = mesh.group.position.z;
    const dx = hit.x - px;
    const dy = hit.y - py;
    if (dx === 0 && dy === 0) return null;
    return Math.atan2(dy, dx);
  }

  /** Project an entity's world position to canvas pixel coordinates, or null if not found. */
  getEntityScreenPos(entityId: string): { x: number; y: number } | null {
    const mesh = this.entities.get(entityId);
    if (!mesh) return null;
    const pos = mesh.group.position.clone();
    pos.project(this.camera);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return {
      x: (pos.x * 0.5 + 0.5) * w,
      y: (-pos.y * 0.5 + 0.5) * h,
    };
  }

  // ---- day/night ----

  /**
   * Called when a DayPhaseChanged event arrives.
   * Lighting smoothly interpolates toward the target values each render frame.
   */
  setDayPhase(phase: string): void {
    this.envLighting.setPhase(phase);
  }

  // ---- debug ----

  /** Toggle showing the raw height pre-pass texture instead of the normal scene. */
  toggleHeightDebug(): boolean {
    this.heightDebugEnabled = !this.heightDebugEnabled;
    if (this.heightDebugEnabled) {
      // Simple pass-through shader: displays height texture in sRGB space.
      this.blitMesh.material = new THREE.ShaderMaterial({
        uniforms: { tHeight: { value: this.heightTarget.texture } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
          varying vec2 vUv;
          uniform sampler2D tHeight;
          void main() {
            float h = texture2D(tHeight, vUv).r;
            // linear → sRGB so the gradient is perceptually uniform
            float s = pow(max(h, 0.0), 1.0 / 2.2);
            gl_FragColor = vec4(s, s, s, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      });
    } else {
      (this.blitMesh.material as THREE.Material).dispose();
      this.blitMesh.material = this.edgePass.material;
    }
    return this.heightDebugEnabled;
  }

  /** Toggle the screen-space Sobel edge detection pass on/off. */
  toggleSobelEdges(): boolean {
    return this.edgePass.toggleSobelEdges();
  }

  /**
   * Diagnostic toggle — when on, skip the entire post-FX pipeline (pixelTarget
   * render, hover mask, depth blit, EdgePass) and render the scene directly to
   * the canvas.  Used to measure how much of the frame budget the post-FX is
   * consuming.  The hitbox debug overlay still renders since it's already
   * direct-to-canvas.
   */
  toggleBypassPostFX(): boolean {
    this.bypassPostFX = !this.bypassPostFX;
    return this.bypassPostFX;
  }

  /**
   * Diagnostic toggle — flip sun shadow casting on/off.  When off, the
   * shadow map render pass is skipped entirely; useful for measuring
   * how much of the frame budget the shadow map consumes.
   * Returns the new enabled state.
   */
  toggleShadows(): boolean {
    return this.envLighting.toggleShadows();
  }

  /**
   * Diagnostic — walk the scene and log a breakdown by object kind.
   * For InstancedMesh nodes, logs both the slot count and triangles per
   * instance × count.  Used to find which subsystem is producing a wad of
   * draw calls or triangles when the HUD shows numbers higher than expected.
   */
  logSceneCensus(): void {
    interface Bucket { nodes: number; instanced: number; instances: number; tris: number; }
    const buckets = new Map<string, Bucket>();
    const bucket = (key: string): Bucket => {
      let b = buckets.get(key);
      if (!b) { b = { nodes: 0, instanced: 0, instances: 0, tris: 0 }; buckets.set(key, b); }
      return b;
    };

    const classify = (obj: THREE.Object3D): string => {
      // Walk up the parent chain to find the nearest named ancestor — entity
      // sub-meshes (skinned bones, weapon attachments) should bucket under
      // "entity" rather than appear individually as anonymous Meshes.
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (cur.name) return cur.name;
        cur = cur.parent;
      }
      return (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh).type : obj.type;
    };

    let total = 0, instTotal = 0, triTotal = 0, drawableNodes = 0;
    this.scene.traverse((obj) => {
      total++;
      const m = obj as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      const inst = (m as THREE.InstancedMesh).isInstancedMesh
        ? (m as THREE.InstancedMesh)
        : null;
      const instCount = inst ? inst.count : 1;
      const idx = m.geometry.index;
      const triPer = idx
        ? idx.count / 3
        : (m.geometry.attributes.position?.count ?? 0) / 3;
      const tris = triPer * instCount;
      const key = classify(obj);
      const b = bucket(key);
      b.nodes++;
      if (inst) { b.instanced++; b.instances += instCount; }
      b.tris += tris;
      drawableNodes++;
      instTotal += instCount;
      triTotal += tris;
    });

    const rows = [...buckets.entries()]
      .map(([k, b]) => ({ key: k, ...b }))
      .sort((a, b) => b.tris - a.tris);

    console.groupCollapsed(`Scene census — ${total} nodes, ${drawableNodes} drawable, ${instTotal} instances, ${(triTotal / 1000).toFixed(1)}k tris`);
    console.table(rows);
    console.groupEnd();
  }

  // ---- render loop ----

  render(serverTick: number, localPredictedPos?: { x: number; y: number; z: number } | null, localFacing?: number | null): void {
    // Compute a smooth fractional tick that advances at 20 Hz based on real time.
    // This makes animations run at 60 fps instead of stepping every 50 ms.
    const now = performance.now();
    if (serverTick !== this.lastKnownServerTick) {
      this.lastKnownServerTick = serverTick;
      this.lastServerTickMs = now;
    }
    this.smoothTick = serverTick + (now - this.lastServerTickMs) / 50;

    this.renderer.info.reset();

    const tSkStart = performance.now();
    // Frame dt for the animation crossfade (T-291). lastFrameMs still holds the
    // PREVIOUS frame's timestamp here — it's advanced later in the post-FX block.
    const animDtMs = this.lastFrameMs > 0 ? Math.min(now - this.lastFrameMs, 100) : 16;
    // Drive skeleton poses for all animated entities.
    for (const [, mesh] of this.entities.all) {
      if (mesh.boneGroups && mesh.skeletonId && this.content) {
        const anim = mesh.animationState;
        const skeleton   = this.content.getSkeletonSync(mesh.skeletonId);
        const clipIndex  = this.content.getClipIndex(mesh.skeletonId);
        const maskIndex  = this.content.getMaskIndex(mesh.skeletonId);

        // Crossfade the raw 20Hz layer snapshot so state transitions (idle→walk,
        // swing in/out) ease in/out instead of hard-cutting the pose (T-291).
        const layers = blendAnimationLayers(mesh.layerFades, anim?.layers ?? [], animDtMs);
        const animForPose = anim ? { ...anim, layers } : null;

        // Procedural swing: if the actor is mid-swing on a weapon action with an
        // authored swingPath, drive the whole upper body from that arc (spine
        // twist+lean, weapon-arm IK, off-hand counter) instead of the borrowed
        // Mixamo clip. The lower body keeps locomotion: we strip the swing clip
        // from the base layers so the legs walk/idle while the arms swing.
        const swingWA = anim?.weaponActionId
          ? this.weaponActionsMap.get(anim.weaponActionId)
          : undefined;
        if (swingWA?.swingPath && skeleton) {
          const total = swingWA.windupTicks + swingWA.activeTicks + swingWA.winddownTicks;
          const ticks = anim!.ticksIntoAction + (now - mesh.lastAnimUpdateMs) / 50;
          const t = Math.max(0, Math.min(ticks / total, 1));
          const baseLayers = layers.filter((l) => l.clipId !== swingWA.clipId);
          const basePose = evaluatePose(skeleton, clipIndex, maskIndex, anim ? { ...anim, layers: baseLayers } : null);
          const boneIndex = this.content.getBoneIndex(mesh.skeletonId);
          const swing = solveSwingPose(skeleton, boneIndex, basePose, mesh.modelScale, swingWA.swingPath, t, { morphParams: mesh.modelMorphs });
          const euler = new Map<string, THREE.Euler>();
          for (const [bone, r] of swing) euler.set(bone, new THREE.Euler(r.x, r.y, r.z));
          updateSkeletonPose(mesh, euler);
        } else {
          const pose = evaluatePose(skeleton, clipIndex, maskIndex, animForPose);
          updateSkeletonPose(mesh, pose);
        }

        // Roll vertical lift — sin(πt) parabola peaking at clip mid-point so the
        // tucked body clears the ground during the somersault. Tied to the
        // entity's own scale so a 2× big NPC also lifts 2×. Reads the blended
        // layers so a fading roll lifts proportionally.
        let lift = 0;
        for (const layer of layers) {
          if (layer.clipId === "roll" && layer.weight > 0) {
            lift = Math.sin(layer.time * Math.PI) * 1.6 * mesh.modelScale * layer.weight;
            break;
          }
        }
        mesh.rollLiftY = lift;

        // Look up weapon action for attachment positioning and trail rendering.
        const weaponActionId = anim?.weaponActionId ?? "";
        const weaponAction = weaponActionId ? this.weaponActionsMap.get(weaponActionId) : undefined;

        // Elapsed fractional ticks since last server update — used for 60fps extrapolation.
        const elapsed = (now - mesh.lastAnimUpdateMs) / 50;

        // Compute normalised action time t for attachment and trail positioning.
        const totalTicks = weaponAction
          ? weaponAction.windupTicks + weaponAction.activeTicks + weaponAction.winddownTicks
          : 0;
        const ticks = totalTicks > 0
          ? Math.min((anim?.ticksIntoAction ?? 0) + elapsed, totalTicks)
          : 0;
        const t = totalTicks > 0 ? ticks / totalTicks : 1.0;

        this.entities.updateAttachmentPositions(mesh, anim, weaponAction, t);
      }
    }

    // Interpolate remote entity positions (local player snaps — no delay)
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const [id, mesh] of this.entities.all) {
      if (id === this.localPlayerId) continue;
      const buf = mesh.posBuffer;
      if (buf.length === 0) continue;
      if (buf.length === 1) {
        mesh.group.position.set(buf[0].x, buf[0].y + mesh.rollLiftY, buf[0].z);
        mesh.group.rotation.y = buf[0].ry;
        continue;
      }
      // Find the last sample at or before renderTime
      let lo = 0;
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderTime) lo = i; else break;
      }
      const hi = Math.min(lo + 1, buf.length - 1);
      if (lo === hi) {
        mesh.group.position.set(buf[lo].x, buf[lo].y + mesh.rollLiftY, buf[lo].z);
        mesh.group.rotation.y = buf[lo].ry;
      } else {
        const alpha = Math.max(0, Math.min(1, (renderTime - buf[lo].t) / (buf[hi].t - buf[lo].t)));
        mesh.group.position.set(
          lerpN(buf[lo].x, buf[hi].x, alpha),
          lerpN(buf[lo].y, buf[hi].y, alpha) + mesh.rollLiftY,
          lerpN(buf[lo].z, buf[hi].z, alpha),
        );
        mesh.group.rotation.y = lerpAngle(buf[lo].ry, buf[hi].ry, alpha);
      }
    }
    this.frameTimings.skMs = performance.now() - tSkStart;

    // Override the local player's transform with client-side prediction so the
    // body tracks input without a server round-trip. Position comes from the
    // predictor; facing/rotation comes from the locally-tracked cursor angle
    // (T-287) — updateEntityMesh only ever sets rotation from the networked
    // facing, which lags by RTT and made swings sweep from a stale orientation.
    if (this.localPlayerId) {
      const localMesh = this.entities.all.get(this.localPlayerId);
      if (localMesh) {
        if (localPredictedPos) {
          // world(x, y, z) → three(x, height, y) — same mapping as updateEntityMesh
          localMesh.group.position.set(localPredictedPos.x, localPredictedPos.z + localMesh.groundOffsetWorld + localMesh.rollLiftY, localPredictedPos.y);
        }
        if (localFacing != null) {
          // Same convention as updateEntityMesh: rotation.y = -angle - π/2.
          localMesh.group.rotation.y = -localFacing - Math.PI / 2;
        }
      }
    }

    // Sync debug overlays after poses and interpolation.
    const debugCtx: DebugUpdateContext = {
      entityMeshes: this.entities.all,
      weaponActionsMap: this.weaponActionsMap,
      now,
      content: this.content,
    };
    this.debugOverlayManager.update(debugCtx);

    // Smoothly track local player
    const localMesh = this.localPlayerId
      ? this.entities.all.get(this.localPlayerId)
      : undefined;
    if (localMesh) {
      this.cameraTarget.copy(localMesh.group.position);
    }

    // Chunk culling — two windows.
    //
    // Terrain stays at 9×9 (4-chunk radius, ~128 world units): each
    // terrain chunk is one cheap mesh, and seam-popping at the edge of
    // the rendered area is uglier than rendering a few extra meshes.
    //
    // The InstancePool gets a tighter 5×5 window (2-chunk radius, ~64
    // units). The shadow camera frustum is 120×120 (~3.75 chunks wide)
    // and the main camera's forward cone is similar, so 5×5 covers both
    // with no visible popping. Forest tris are 100× heavier than terrain
    // tris, so the 4× area cut here is the difference between 8 M and
    // 2 M tris drawn per frame. InstancePool iterates these in stable
    // (cy outer, cx inner) order so per-frame instance ordering doesn't
    // shuffle.
    const playerPos = localMesh?.group.position ?? this.cameraTarget;
    const pChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
    const pChunkY = Math.floor(playerPos.z / CHUNK_SIZE);
    const propVisibleChunks = new Set<string>();
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        propVisibleChunks.add(`${pChunkX + dx},${pChunkY + dy}`);
      }
    }
    for (const [key, tmeshes] of this.terrainMeshes) {
      const [cx, cy] = key.split(",").map(Number);
      const vis = Math.abs(cx - pChunkX) <= 4 && Math.abs(cy - pChunkY) <= 4;
      for (const me of tmeshes) me.visible = vis;
    }
    this.instancePool.update(propVisibleChunks);
    // Entity culling — hide entities beyond CULL_RADIUS_SQ
    for (const [id, emesh] of this.entities.all) {
      if (id === this.localPlayerId) { emesh.group.visible = true; continue; }
      const dx = emesh.group.position.x - playerPos.x;
      const dz = emesh.group.position.z - playerPos.z;
      emesh.group.visible = dx * dx + dz * dz <= CULL_RADIUS_SQ;
    }

    this.cameraRig.update(this.cameraTarget);

    // Day/night lerp + shadow-frustum follow/snap + sky-locked sun disc — all
    // off the now-settled camera target. (After cameraRig.update so the sun disc
    // tracks this frame's camera position.)
    this.envLighting.update(this.cameraTarget, this.camera.position);

    // Update weapon tip trail ribbons for all currently attacking entities.
    const tTrailStart = performance.now();
    this.weaponTrail.update(this.entities.all, this.weaponActionsMap, now);
    this.frameTimings.trailMs = performance.now() - tTrailStart;

    // Advance hit spark particles and flicker lights.
    const dt = this.lastFrameMs > 0 ? Math.min((now - this.lastFrameMs) / 1000, 0.1) : 0;
    this.lastFrameMs = now;
    this.hitSparkRenderer.update(dt);
    this.lightManager.tick(now);

    const tGlStart = performance.now();
    if (this.bypassPostFX) {
      // Diagnostic mode — render scene directly to canvas, skipping the entire
      // post-FX chain (pixelTarget, hover mask, depth blit, EdgePass).  Use this
      // to measure how much of the frame budget post-FX consumes.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } else {
      // Pass 1: render scene to low-res pixel target (writes colour + depth).
      this.renderer.setRenderTarget(this.pixelTarget);
      this.renderer.render(this.scene, this.camera);

      // Hover mask: render whatever's currently on HOVER_LAYER flat-white →
      // hoverMaskTarget.  HoverOutlineRenderer puts the hovered entity's meshes
      // (or proxy shells for prop-pool entities) onto the layer and toggles the
      // EdgePass uniform; the renderer just reads the uniform here to skip the
      // pass entirely when there's nothing to outline.
      if (this.edgePass.material.uniforms.uHoverActive.value > 0.0) {
        const savedMask       = this.camera.layers.mask;
        const savedBackground = this.scene.background;
        this.camera.layers.set(HOVER_LAYER);
        this.scene.overrideMaterial = this.hoverMaskMat;
        this.scene.background = null;   // prevent sky color flooding the mask
        this.renderer.setRenderTarget(this.hoverMaskTarget);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        this.scene.overrideMaterial = null;
        this.scene.background = savedBackground;
        this.camera.layers.mask = savedMask;
      }

      // Depth blit: reconstruct world-Y from pixelTarget.depthTexture → heightTarget.
      // pixelTarget is no longer the active FBO here, so reading its depth texture is
      // safe — no same-FBO feedback loop.  Camera matrices are snapped after Pass 1
      // so they match the frame that produced the depth buffer.
      this.depthBlitMat.uniforms.uProjInv.value.copy(this.camera.projectionMatrixInverse);
      this.depthBlitMat.uniforms.uViewInv.value.copy(this.camera.matrixWorld);
      // Recenter the height-shading band on the player so the perspective view's
      // broader Y range (sky, distant hills) doesn't compress contrast near the player.
      this.depthBlitMat.uniforms.uHeightMin.value = playerPos.y - HEIGHT_SHADE_BELOW;
      this.depthBlitMat.uniforms.uHeightMax.value = playerPos.y + HEIGHT_SHADE_ABOVE;
      this.renderer.setRenderTarget(this.heightTarget);
      this.renderer.render(this.depthBlitScene, this.blitCamera);

      // EdgePass reconstructs world XZ from depth too (for fog-of-war), so it
      // needs the same camera matrices the depth-blit pass just used.
      this.edgePass.setCameraMatrices(this.camera.projectionMatrixInverse, this.camera.matrixWorld);

      // Pass 2: edge detection + height shading + sRGB → canvas.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.blitScene, this.blitCamera);
    }

    // Pass 3: hitbox debug overlay — rendered directly to canvas, bypassing
    // the pixel-art and edge-detection passes so the lines stay crisp.
    // Objects in HITBOX_OVERLAY_LAYER are invisible to the main camera (layer 0
    // only by default), so they never appear in pixelTarget.
    // Background must be nulled out: THREE.js renders scene.background even
    // with autoClear=false, which would paint over the Pass 2 blit output.
    const savedMask = this.camera.layers.mask;
    const savedBackground = this.scene.background;
    this.camera.layers.set(HITBOX_OVERLAY_LAYER);
    this.scene.background = null;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = true;
    this.scene.background = savedBackground;
    this.camera.layers.mask = savedMask;
    this.frameTimings.glMs = performance.now() - tGlStart;
    this.frameTimings.drawCalls = this.renderer.info.render.calls;
    this.frameTimings.tris      = this.renderer.info.render.triangles;
  }

  /** Spawn a hit spark burst at the given world-space position. */
  spawnHitSpark(x: number, y: number, z: number): void {
    this.hitSparkRenderer.spawn(x, y, z);
  }

  /** Register weapon action definitions so the trail renderer can look up swing paths. */
  setWeaponActions(actions: WeaponActionDef[]): void {
    this.weaponActionsMap.clear();
    for (const a of actions) this.weaponActionsMap.set(a.id, a);
  }

  /** Register item prefab definitions so the renderer can resolve model IDs for equipped items. */
  setItemPrefabs(prefabs: readonly Prefab[]): void {
    this.itemPrefabMap.clear();
    for (const p of prefabs) this.itemPrefabMap.set(p.id, p);
  }

  private onResize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.cameraRig.resize(aspect);
    const npw = Math.max(1, w);
    const nph = Math.max(1, h);
    this.pixelTarget.setSize(npw, nph);
    this.heightTarget.setSize(npw, nph);
    this.hoverMaskTarget.setSize(npw, nph);
    this.edgePass.setSize(npw, nph);
  }

  dispose(): void {
    this.debugOverlayManager.dispose();
    this.hitSparkRenderer.dispose();
    this.lightManager.dispose();
    this.weaponTrail.dispose();
    this.instancePool.dispose();
    this.edgePass.dispose();
    this.pixelTarget.dispose();
    this.heightTarget.dispose();
    this.hoverMaskTarget.dispose();
    this.hoverMaskMat.dispose();
    this.depthBlitMat.dispose();
    this.renderer.dispose();
    this.entities.disposeAll();
    for (const [, meshes] of this.terrainMeshes) {
      for (const me of meshes) {
        me.geometry.dispose();
        (me.material as THREE.Material).dispose();
      }
    }
    this.gateMarkers.dispose();
  }
}
