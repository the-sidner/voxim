/// <reference lib="dom" />
/**
 * Voxim renderer — Three.js scene management.
 *
 * Visual grammar:
 *   - Post-process pipeline: scene → pixelTarget → shadow-cascade darken
 *     (T-313, far-field raking shadows) → bloom + god-rays → depth-blit →
 *     heightTarget → EdgePass (Sobel + AO + sRGB) → canvas.
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
import type { ClientChunk, ClientWorld, EntityState } from "../state/client_world.ts";
import type { ContentCache } from "../state/content_cache.ts";
import type { WeaponActionDef, Prefab, AtmosphereDef, ParticleEmitterDef } from "@voxim/content";
import { buildChunkAtoms, TERRAIN_DISP_MAG, type CliffFieldInput } from "./terrain_voxels.ts";
import { bakeVoxels, resolveMossResponse } from "./voxel_bake.ts";
import { applySurfaceTreatment, setWetReflectSkyColor } from "./surface_treatments.ts";
import { sampleField } from "./field_sample.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial, setEmissiveHdrScale } from "./voxel_material.ts";
import { canopyFade } from "./canopy_fade.ts";
import { setTextureStyleParams } from "./material_textures.ts";
import { setClientPalette, paletteToken } from "./palette.ts";
import { WeaponTrailRenderer } from "./weapon_trail.ts";
import { GateMarkerRenderer } from "./gate_marker.ts";
import { EntityMeshRegistry } from "./entity_mesh_registry.ts";
import { EnvironmentLighting } from "./environment_lighting.ts";
import { updateSkeletonPose, blendAnimationLayers, type EntityMeshGroup } from "./entity_mesh.ts";
import { computeTelegraphLayer } from "./telegraph.ts";
import { computeIframeFlash, applyIframeFlash } from "./iframe_flash.ts";
import { InstancePool } from "./instance_pool.ts";
import { evaluatePose } from "./skeleton_evaluator.ts";
import { solveSwingPose, applyLocomotionPose, applyCrouchPose, applyFootTerrainIK, applyLookAtPose, applyGaitPose, timeOfDay01 } from "@voxim/content";
import type { BoneRotation, LocoState } from "@voxim/content";
import { CHUNK_SIZE } from "@voxim/world";

// Pelvis drop (skeleton rest units) at full crouch; scaled per entity.
const CROUCH_DROP = 0.9;
// Crouch ease rate — snappy (~150ms settle) but not a one-frame jolt.
const CROUCH_OMEGA = 18;

// Head/gaze stabilization blend (applyLookAtPose) — 0 fully follows the
// spine's lean, 1 fully cancels it. Partial so the head still reads some
// organic follow-through instead of a rigid neck.
const LOOK_AT_GAIN = 0.6;

// Supersample factor = clamp(devicePixelRatio, MIN, MAX). The whole post chain
// renders at this × the CSS resolution and downsamples on the final blit, so the
// comic outlines/flat-shaded silhouettes resolve as clean lines instead of aliased
// stairs. THIS IS THE PRIMARY PERF KNOB: cost scales with the square of this — the
// post chain (SSAO + edge taps + bloom) is fill-rate bound, so every 0.1 here is
// real frames. Capped at 1.35 (was 2.0) so a HiDPI panel renders below native
// device res — still clearly anti-aliased vs the old 1:1 raster, but ~3× cheaper
// than full native-2. Raise toward 1.6 for crisper edges if the GPU has headroom.
const AAGFX_MIN_SS = 1.2;
const AAGFX_MAX_SS = 1.35;
const aagfxSupersample = () =>
  Math.min(Math.max(globalThis.devicePixelRatio || 1, AAGFX_MIN_SS), AAGFX_MAX_SS);

// ---- secondary motion (snappy organic ease) --------------------------------
// The follow-through chain that gets eased — spine + head. NOT the IK'd hands/
// arms (they must stay locked to the hilt so the blade == the hit). Other
// skeletons (wolf) lack the torso bones — the ease just no-ops on missing bones.
const SPRING_BONES = ["torso_lower", "torso_mid", "torso_upper", "head"] as const;
// Higher = snappier. ~32 rad/s settles in ~90ms — organic, but never floaty.
const SPRING_OMEGA = 32;
const _springTargetQ = new THREE.Quaternion();

/**
 * Ease the follow-through bones toward the composed target pose with a
 * framerate-corrected exponential lerp (a = 1 − e^(−ω·dt)). Stateless toward a
 * moving target: it cannot overshoot or float (the user's hard "snappy, not
 * physics-velocity" constraint), it only smooths the per-frame pose change so
 * the spine/head settle organically instead of snapping. Mutates the THREE.Euler
 * values already in `pose`. Seeds to target on first sight (no startup lurch).
 */
function applyBoneSprings(mesh: EntityMeshGroup, pose: Map<string, THREE.Euler>, dtMs: number) {
  const a = 1 - Math.exp(-SPRING_OMEGA * (Math.min(dtMs, 100) / 1000));
  for (const bone of SPRING_BONES) {
    const target = pose.get(bone);
    if (!target) continue;
    _springTargetQ.setFromEuler(target);
    let q = mesh.boneSprings.get(bone);
    if (!q) { q = _springTargetQ.clone(); mesh.boneSprings.set(bone, q); }
    else { q.slerp(_springTargetQ, a); }
    target.setFromQuaternion(q);
  }
}
import { SkeletonOverlay } from "./skeleton_overlay.ts";
import { FacingOverlay, ChunkOverlay } from "./debug_overlay.ts";
import { BladeDebugOverlay } from "./blade_debug_overlay.ts";
import { HitboxDebugOverlay, HITBOX_OVERLAY_LAYER } from "./hitbox_debug_overlay.ts";
import { DebugOverlayManager } from "./debug_overlay_manager.ts";
import type { DebugUpdateContext } from "./debug_overlay_manager.ts";
import { ParticleSystem } from "./particle_system.ts";
import { LightManager } from "./light_manager.ts";
import { EdgePass, PRE_BOOTSTRAP_GRADE } from "./edge_pass.ts";
import { BloomPass } from "./bloom_pass.ts";
import { GodRayPass } from "./god_ray_pass.ts";
import { ShadowCascadePass } from "./shadow_cascade_pass.ts";
import { CameraRig } from "./camera_rig.ts";
import type { FogOfWar } from "../state/fog_of_war.ts";
import { FOG_GRID_SIZE, FOG_CELL_SIZE } from "@voxim/protocol";
import type { GameEvent } from "@voxim/protocol";


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

/**
 * Entities further than this squared distance from the local player have
 * their Three.js group hidden each frame. Sized for the pulled-back camera
 * (~35m slant distance) — visible ground footprint can reach ~50m forward.
 */
const CULL_RADIUS_SQ = 160 * 160;

/** 3rd-person camera vertical sample range above/below player Y for height
 *  shading — default fallback until GradeDef.heightShadeBelow/Above arrives. */
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
  /** Chunk keys whose bake was deferred because content wasn't hydrated yet
   *  (T-331) — `onContentHydrated()` rebuilds every one of these once the
   *  bootstrap ContentService is wired, so no chunk ever bakes with an
   *  unresolvable material and silently falls back to a flat/white voxel. */
  private readonly pendingChunkRebuilds = new Set<string>();
  /** Gate marker pillars (T-145), keyed by entityId. World-space group containing pillar mesh. */
  private gateMarkers!: GateMarkerRenderer; // set in constructor (needs camera + renderer)
  /** Single chunk-grid owner (T-315 E2) — heightmap/materialGrid/surfaceStateGrid/
   *  vegFieldGrid/waterGrid all read through here now; the renderer keeps no
   *  parallel copy of any of them, only the built THREE.Mesh output. */
  private world: ClientWorld | null = null;
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
  private readonly particles: ParticleSystem;
  private readonly lightManager = new LightManager();

  private cameraTarget = new THREE.Vector3(256, 4, 256);
  private localPlayerId: string | null = null;
  private content: ContentCache | null = null;
  /** Atmosphere id currently applied to envLighting/EdgePass/water — re-checked
   *  each frame against the live WorldClock.biomeTag (T-311 P5a) so a tile
   *  transition or a biome change re-selects without a special-cased hook;
   *  null until the first successful apply so the very first frame always runs. */
  private appliedAtmosphereId: string | null = null;
  /** The currently-applied AtmosphereDef (T-311 P5a) — GroundMistLayer reads
   *  its mist params off here each frame (EdgePass.setMist). */
  private currentAtmosphere: AtmosphereDef | null = null;
  /** Current lerped mist density weight — smoothed toward
   *  `mist.densityByPhase[currentDayPhase]` the same way envLighting's
   *  lightCur lerps colors, so mist doesn't snap on a phase change. */
  private mistWeightCur = 0;
  /** Last day-phase name set via setDayPhase() (DayPhaseChanged events) —
   *  mist's phase weight follows the same discrete-phase bucket the colour
   *  ramp does, not a continuous curve (no second FieldExpr-shaped mechanism
   *  for a 4-point lookup). */
  private currentDayPhase = "noon";

  /** Smooth animation tick — advances at server tick rate (20 Hz) based on real time. */
  private smoothTick = 0;
  private lastKnownServerTick = -1;
  private lastServerTickMs = 0;
  private lastFrameMs = 0;
  /** Hitstop (T-296+T-292): wall-clock ms until which the whole scene's
   *  animation/pose advance is frozen — a brief punch-through on confirmed
   *  contact, client-derived from the existing HitSpark/DamageDealt events
   *  (no wire field). Server ticks/state keep flowing; only the visual
   *  per-frame pose advance clamps to ~0 for the window. */
  private hitStopUntilMs = 0;
  /** Same smooth-tick extrapolation as smoothTick, for WorldClock.ticksElapsed
   *  (T-311 P5a) — the sun arc advances at 60fps between the 20Hz server
   *  ticks instead of stepping. */
  private lastKnownWorldClockTicks = -1;
  private lastWorldClockMs = 0;

  /** Full-res render target — 3D scene is drawn here before post-processing. */
  private readonly pixelTarget: THREE.WebGLRenderTarget;
  /** `pixelTarget`'s depth attachment — kept as its own field (Three types
   *  `WebGLRenderTarget.depthTexture` as nullable) since T-313's cascade
   *  darken pass reads it directly in render(), same object as
   *  `pixelTarget.depthTexture`, just non-null at the type level. */
  private readonly depthTex: THREE.DepthTexture;
  /** Height target — world-Y encoded as grayscale, fed into EdgePass for height shading. */
  private readonly heightTarget: THREE.WebGLRenderTarget;
  /** Fullscreen scene + material for the depth → world-Y blit pass. */
  private readonly depthBlitScene: THREE.Scene;
  private readonly depthBlitMat: THREE.ShaderMaterial;
  /** Screen-space edge detection — runs during the blit pass. */
  private readonly edgePass: EdgePass;
  /** HDR bloom — bright-pass + separable blur, composited into the EdgePass. */
  private readonly bloom: BloomPass;
  /** Volumetric light shafts — radial scatter from the sun, into the EdgePass. */
  private readonly godRay: GodRayPass;
  /** T-313: far shadow-cascade darken — extends raking shadows past the near
   *  sun's ±60u frustum; runs between Pass 1 and bloom so bloom/god-ray both
   *  see the far-shadowed HDR colour too. */
  private readonly shadowCascade: ShadowCascadePass;
  private readonly _sunWorld = new THREE.Vector3();
  private readonly _sunUV = new THREE.Vector2();
  private readonly _sunDirScratch = new THREE.Vector3();
  private readonly _skyColorScratch = new THREE.Color();
  private readonly _nearShadowMatrixScratch = new THREE.Matrix4();
  private readonly _farShadowMatrixScratch = new THREE.Matrix4();
  /** 3rd-person camera vertical sample range above/below player Y for height
   *  shading — content-driven via GradeDef.heightShadeBelow/Above (T-315 D2);
   *  these hold the pre-bootstrap fallback until a grade arrives. */
  private heightShadeBelow = HEIGHT_SHADE_BELOW;
  private heightShadeAbove = HEIGHT_SHADE_ABOVE;
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

    this.particles = new ParticleSystem(this.instancePool);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // Supersample: render the whole pipeline at up to 2× the CSS resolution and
    // downsample on the final blit. This is the AAA win for the comic look —
    // the deliberate flat-shaded silhouettes + Sobel ink stay crisp lines instead
    // of stair-stepped aliasing. SSAA (vs MSAA) also anti-aliases the shading and
    // the depth-derived edge pass, which MSAA's edge-only coverage cannot.
    this.renderer.setPixelRatio(aagfxSupersample());
    this.renderer.shadowMap.enabled = true;
    // Soft-but-tight shadows: PCF penumbra at high resolution reads as clean
    // contact shadowing under the comic look — not the old hard 1px stamp, but
    // not a mushy realistic blur either (radius is kept small in EnvironmentLighting).
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Disable auto-reset so renderer.info accumulates draw calls / triangles
    // across every renderer.render() call within a single frame (shadow pass +
    // main scene + post-FX passes). render() resets manually at the top.
    this.renderer.info.autoReset = false;

    const aspect = (canvas.clientWidth || canvas.width || 320) / (canvas.clientHeight || canvas.height || 180);
    this.cameraRig = new CameraRig(aspect);
    this.camera = this.cameraRig.camera;
    // Boot placement before the first frame: dt=0 and no facing target yet, so
    // the yaw holds at its boot value (join screen / pre-spawn).
    this.cameraRig.update(this.cameraTarget, 0);
    this.gateMarkers = new GateMarkerRenderer(this.scene, this.camera, this.renderer.domElement);
    this.entities = new EntityMeshRegistry(
      this.scene, this.instancePool, this.weaponActionsMap, this.itemPrefabMap,
      this._skeletonOverlay, this.lightManager, this.debugOverlayManager,
    );

    // ---- render target (with depth texture for the depth-blit pass) ----
    // Targets are sized at the supersampled (DPR-scaled) drawing-buffer resolution
    // so they map 1:1 to the final blit and the whole pipeline benefits from SSAA.
    const ratio = this.renderer.getPixelRatio();
    const pw = Math.max(1, Math.round((canvas.clientWidth  || canvas.width  || 320) * ratio));
    const ph = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 180) * ratio));
    // Float depth texture — more portable for shader sampling than UnsignedIntType
    // on WebGL2 (some drivers return undefined values for DEPTH_COMPONENT24 sampling).
    const depthTex = new THREE.DepthTexture(pw, ph, THREE.FloatType);
    depthTex.format = THREE.DepthFormat;
    // HalfFloat (HDR) colour: the lit scene keeps radiance above 1.0 (sun disc,
    // emissive embers/torches) instead of clamping at the buffer, so the EdgePass
    // ACES curve tone-maps real highlights and the bloom pass has bright pixels to
    // threshold. An LDR buffer here would clip all of that to flat white.
    this.pixelTarget = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      stencilBuffer: false,
    });
    this.pixelTarget.depthTexture = depthTex;
    this.depthTex = depthTex;

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

    // ---- T-313 far shadow-cascade darken (before EdgePass — see that
    // pass's header for why: bloom/god-ray must also see the far-shadowed
    // colour, so this sits between Pass 1 and bloom, not folded into
    // EdgePass at the end) ----
    this.shadowCascade = new ShadowCascadePass(pw, ph);

    // ---- edge pass + fullscreen blit scene ----
    // EdgePass also applies fog-of-war modulation (T-157): it samples the
    // depth texture to reconstruct world XZ, looks up the fog cell, and
    // multiplies the final colour.  Until attachFog() runs we hand it a
    // 1×1 placeholder so the shader compiles cleanly; uTileSize stays 0
    // (fog disabled) until attach.
    const fogPlaceholder = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    fogPlaceholder.needsUpdate = true;
    this.edgePass = new EdgePass(
      // T-313: EdgePass's "scene colour" input is the shadow-cascade pass's
      // OUTPUT, not the raw Pass-1 pixelTarget — pixelTarget.depthTexture
      // (below) is still read directly, unaffected (only colour is darkened).
      this.shadowCascade.texture,
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

    // ---- HDR bloom (bright-pass + blur of the HalfFloat scene) ----
    // Threshold above the brightest sun-lit earth tones so the glow is mostly
    // emissive (torches/embers) + the hottest highlights, not a haze over the
    // whole lit ground. Tuned by eye against the HalfFloat radiance.
    this.bloom = new BloomPass(pw, ph);
    this.bloom.setThreshold(PRE_BOOTSTRAP_GRADE.bloomThreshold, PRE_BOOTSTRAP_GRADE.bloomKnee);
    this.edgePass.setBloomTexture(this.bloom.texture);

    // ---- volumetric god rays (radial scatter of the bloom toward the sun) ----
    this.godRay = new GodRayPass(pw, ph);
    this.edgePass.setGodRayTexture(this.godRay.texture);

    // ---- environment lighting (sun + hemi + sky/fog + day-night) ----
    this.envLighting = new EnvironmentLighting(this.scene);

    globalThis.addEventListener("resize", () => this.onResize(canvas));
  }

  setLocalPlayer(id: string): void {
    this.localPlayerId = id;
    this.entities.setLocalPlayer(id);
  }

  /** Register the local player's hotbar occupancy for body-anchor rendering (T-309). */
  setHotbar(prefabIds: (string | null)[], activeIndex: number): void {
    this.entities.setHotbar(prefabIds, activeIndex);
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

  /** Wire the ClientWorld (T-315 E2) — the renderer reads chunk grid data
   *  (heightmap/materialGrid/surfaceStateGrid/vegFieldGrid/waterGrid) through
   *  it instead of keeping its own parallel copies. */
  setClientWorld(world: ClientWorld): void {
    this.world = world;
    this.entities.setClientWorld(world);
  }

  setContentCache(cache: ContentCache): void {
    this.content = cache;
    this.entities.setContent(cache);
    this.lightManager.setContent(cache);
    this.particles.setContent(cache);
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
    // Colour grade is content now (T-311 Phase 2, grammar G7): the EdgePass grade
    // uniforms read the authored `grades/default.json` instead of hardcoded
    // constants. Absent → the EdgePass constructor fallback (identical values).
    const grade = cache.getGrade("default");
    if (grade) {
      this.edgePass.setGrade(grade);
      // Bloom threshold/knee, the height-shade band, and the emissive HDR
      // scale aren't EdgePass uniforms — apply them to their own owners
      // (T-315 D2).
      this.bloom.setThreshold(grade.bloomThreshold, grade.bloomKnee);
      this.heightShadeBelow = grade.heightShadeBelow;
      this.heightShadeAbove = grade.heightShadeAbove;
      setEmissiveHdrScale(grade.emissiveHdrScale);
    }
    // Canopy wind/fade-cylinder geometry + procedural texture-noise amounts
    // are content now (T-315 D3): game_config.render instead of hardcoded
    // module consts. Absent → each module's own pre-bootstrap fallback.
    const cfg = cache.getGameConfig();
    if (cfg) {
      canopyFade.applyConfig(cfg.render);
      setTextureStyleParams(cfg.render.textureStyle);
      // Free-look camera geometry + sensitivity/pitch-band knobs (T-320) from
      // game_config.camera.
      this.cameraRig.configure(cfg.camera);
    }
  }


  // ---- terrain ----

  /**
   * Rebuild every chunk whose bake was deferred by the content-hydration gate
   * in `_rebuildChunk` (T-331). Call once the bootstrap ContentService is
   * wired — on the initial join right after `setContentCache`, and again
   * after a tile transition's content re-hydrates, since the renderer (and
   * any chunks queued against it) survives the reconnect. No-op when nothing
   * is pending, so it's safe to call unconditionally.
   */
  onContentHydrated(): void {
    if (this.pendingChunkRebuilds.size === 0) return;
    const pending = [...this.pendingChunkRebuilds];
    this.pendingChunkRebuilds.clear();
    for (const key of pending) {
      const [cx, cy] = key.split(",").map(Number);
      this._rebuildChunk(cx, cy);
    }
  }

  updateTerrain(chunk: ClientChunk): void {
    const cx = chunk.chunkX, cy = chunk.chunkY;

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
    const chunk = this.world?.getChunk(cx, cy);
    const hm = chunk?.heightmap;
    const mat = chunk?.materialGrid;
    if (!hm || !mat) return;

    // T-331: never bake a chunk before the bootstrap ContentService is wired —
    // every material lookup below would silently miss and buildVoxelMaterial
    // would fall back to a flat, textureless voxel colour (reads as a white/
    // grey patch with hard edges under this scene's exposure). Defer instead;
    // onContentHydrated() rebuilds every deferred chunk once content lands.
    // Leaves any existing mesh for this chunk in place rather than tearing it
    // down for a rebuild we can't yet complete.
    if (!this.content?.isHydrated()) {
      this.pendingChunkRebuilds.add(key);
      return;
    }

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

    // Surface fields (T-311 P4): thread the chunk's SurfaceStateGrid planes +
    // the per-material render responses into the atom build; atoms carry the
    // G6 sidecar scalars (`moss01`, `wet01`).
    const surf = chunk?.surfaceStateGrid;
    const veg = chunk?.vegFieldGrid ?? null;
    const water = chunk?.waterGrid ?? null;
    const surfaceInput = surf
      ? {
        overgrowth: surf.overgrowth,
        wetness: surf.wetness,
        mossBiasFor: (matId: number) => {
          const mb = this.content?.getMaterialSync(matId)?.render?.mossBlend;
          return mb ? { floor: mb.floorBias, wall: mb.wallBias, joint: mb.jointBoost } : undefined;
        },
        wets: (matId: number) => this.content?.getMaterialSync(matId)?.render?.wetness !== undefined,
        sample: (field: string, cellIdx: number) => sampleField(field, veg, surf, water, cellIdx),
      }
      : undefined;

    // Cliff fields (T-311 P6): thread the chunk's CliffGrid planes + the
    // client's stable profileId→CliffProfileDef.id index (I3c) into the atom
    // build; profileOf/erosionOf resolve against the bootstrap content.
    const cliffGrid = chunk?.cliffGrid;
    const cliffInput: CliffFieldInput | undefined = cliffGrid
      ? {
        grid: cliffGrid,
        profileOf: (profileId: number) => {
          if (profileId === 0) return undefined;
          return this.content?.getCliffProfileIndex()[profileId - 1];
        },
        erosionOf: (profileIdStr: string, erosionIdx: number) => {
          const def = this.content?.getCliffProfile(profileIdStr);
          if (!def) return undefined;
          const key = erosionIdx === 0 ? "crisp" : erosionIdx === 1 ? "weathered" : "broken";
          return def.erosionStates[key];
        },
      }
      : undefined;

    // Re-express the chunk as voxel atoms (column boxes) bucketed by material,
    // then bake one mesh per material through the shared voxel pipeline (T-283).
    const byMat = buildChunkAtoms(hm, mat, {
      N: this.world?.getChunk(cx, cy - 1)?.heightmap ?? null,
      E: this.world?.getChunk(cx + 1, cy)?.heightmap ?? null,
      S: this.world?.getChunk(cx, cy + 1)?.heightmap ?? null,
      W: this.world?.getChunk(cx - 1, cy)?.heightmap ?? null,
    }, surfaceInput,
      // Per-material relief response (render.relief, T-311 P4).
      (matId: number) => this.content?.getMaterialSync(matId)?.render?.relief,
      cliffInput);
    const meshes: THREE.Mesh[] = [];
    for (const [matId, atoms] of byMat) {
      // Content is guaranteed hydrated here (the gate above deferred otherwise) —
      // an unresolved materialId at this point is a genuine content/data bug
      // (a terrain cell referencing a materialId no MaterialDef registers), not
      // a timing race. Throw rather than silently painting the chunk white/grey
      // (T-331) — this exact silent-fallback shape has bitten three times now.
      const matDef = this.content!.getMaterialSync(matId);
      if (!matDef) {
        throw new Error(
          `[renderer] terrain chunk (${cx},${cy}) has a cell with materialId=${matId}, ` +
          `which no MaterialDef resolves (content is hydrated — this is a real content gap, not a load race)`,
        );
      }
      const mb = matDef.render?.mossBlend;
      const mossTarget = mb ? this.content?.getMaterialByName(mb.material) : undefined;
      const mossResp = mb && mossTarget
        ? resolveMossResponse(matDef.color, mossTarget.color, mb.tintShift)
        : undefined;
      // T-326: render.relief.dispMag is THE one warp-amplitude knob every
      // voxel-baked class reads (props/scatter/characters read it the same
      // way — see entity_mesh.ts/scatter_renderer.ts/entity_mesh_registry.ts).
      // Terrain alone additionally pins TERRAIN_DISP_MAG as its non-content
      // floor (T-283/T-315 no-crack guarantee: every atom of one material
      // MUST resolve the identical mag so shared cliff-edge corners weld).
      const dispMag = matDef.render?.relief?.dispMag ?? TERRAIN_DISP_MAG;
      const baked = bakeVoxels(atoms, matId, dispMag, matDef.render?.tintJitter, mossResp);
      const geo = geometryFromBaked(baked);
      const m = buildVoxelMaterial(matDef, matId);
      canopyFade.register(m);
      // Wetness response (G4): dispatch the wet_specular treatment AFTER
      // canopyFade (treatments chain onBeforeCompile), only where the bake
      // actually emitted the aWetness attribute.
      const wet = matDef.render?.wetness;
      if (wet && baked.wetness) {
        applySurfaceTreatment("wet_specular", m, { gloss: wet.gloss, darken: wet.darken });
      }
      // Cheap wetness-weighted sky reflection (T-311 P5b): same aWetness
      // input, a separate consumer (render.reflect, reserved since G4).
      const reflect = matDef.render?.reflect;
      if (reflect && baked.wetness) {
        applySurfaceTreatment("wet_reflect", m, { strength: reflect.strength, tint: reflect.tint });
      }
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
        dissolutionPhase: current?.dissolutionPhase ?? 0,
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
    // Stale coordinates from the source tile (T-331) — the destination tile's
    // state messages repopulate this.world from scratch, so any deferred
    // rebuild queued against the old world would either no-op (chunk not
    // loaded yet) or redo work a real spawn already triggered.
    this.pendingChunkRebuilds.clear();
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

  /**
   * Unproject canvas pixel coordinates onto the world ground plane.
   *
   * Coordinate mapping: world(x, y, z) → three(x, z, y).
   * The ground plane in Three.js space is y = groundHeight (= world z).
   * Returns world-space { x, y } of the intersection, or null if the ray
   * is parallel to the plane (shouldn't happen for this steeply-angled camera,
   * whatever its yaw).
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
    this.currentDayPhase = phase;
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

  /** Live sun direction (T-311 P5a) — the single sun owner every other
   *  consumer (water shader) reads instead of carrying its own constant.
   *  Plain {x,y,z} (game.ts stays THREE-free) — valid after this frame's
   *  render() has called envLighting.update(). */
  getSunDirection(): { x: number; y: number; z: number } {
    return this.envLighting.getSunDirection(this._sunDirScratch);
  }

  /** Current lerped sky colour (T-311 P5b) — the water sky-streak reflection
   *  term reads this. Plain 0xRRGGBB number (game.ts stays THREE-free). */
  getSkyColor(): number {
    return this.envLighting.getSkyColor(this._skyColorScratch).getHex();
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

  /**
   * Locomotion lean state for an entity. Local player: from movement INTENT
   * (snappy, no physics velocity). Remotes: from networked velocity. Returns
   * null when near-stationary so the FK fast-path skips the extra solve.
   */
  private locoState(
    id: string, mesh: EntityMeshGroup,
    localMovement: { x: number; y: number } | null, localFacing: number | null,
  ): LocoState | null {
    let mx: number, my: number, facing: number;
    if (id === this.localPlayerId && localMovement) {
      mx = localMovement.x; my = localMovement.y; facing = localFacing ?? mesh.facingAngle;
    } else {
      mx = mesh.velocityX; my = mesh.velocityY; facing = mesh.facingAngle;
    }
    const mag = Math.hypot(mx, my);
    if (mag < 0.05) return null;
    // lateral / forward fractions of the move direction relative to facing
    // (forward = (cos(facing),sin(facing)), right = forward rotated -90° —
    // same convention as tile-server's velScope/locomotion_intent.ts) — with
    // T-328 facing decouples from movement direction, so back-pedal/strafe
    // become real, distinct locomotion states instead of always reading ≈+1.
    const strafe = (mx * Math.sin(facing) - my * Math.cos(facing)) / mag;
    const moveFwd = (mx * Math.cos(facing) + my * Math.sin(facing)) / mag;
    return {
      strafe: Math.max(-1, Math.min(1, strafe)),
      moveFwd: Math.max(-1, Math.min(1, moveFwd)),
      turn: 0,
    };
  }

  /**
   * World ground-plane position (x,y) + facing (radians) for an entity —
   * the wire's coordinate convention, NOT Three.js `group.position`/
   * `rotation.y`. Local player prefers the client-predicted position/facing
   * (matches `locoState`'s snappy-no-RTT-lag intent); remotes read off the
   * mesh (one render frame stale vs this frame's interpolation pass below —
   * same tolerance the pose pipeline already accepts elsewhere).
   */
  private entityGroundXY(
    id: string, mesh: EntityMeshGroup,
    localPredictedPos: { x: number; y: number; z: number } | null, localFacing: number | null,
  ): { x: number; y: number; facing: number } {
    if (id === this.localPlayerId && localPredictedPos) {
      return { x: localPredictedPos.x, y: localPredictedPos.y, facing: localFacing ?? mesh.facingAngle };
    }
    return { x: mesh.group.position.x, y: mesh.group.position.z, facing: mesh.facingAngle };
  }

  render(serverTick: number, localPredictedPos?: { x: number; y: number; z: number } | null, localFacing?: number | null, localMovement?: { x: number; y: number } | null, localCrouch?: number): void {
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
    // Hitstop (T-296+T-292): clamp toward ~0 while the freeze window is live —
    // poses hold in place for a beat instead of advancing, reading as a punch
    // landing. A small residual (not exactly 0) keeps eased springs/crossfades
    // from dividing by zero elsewhere.
    const rawDtMs = this.lastFrameMs > 0 ? Math.min(now - this.lastFrameMs, 100) : 16;
    const animDtMs = now < this.hitStopUntilMs ? Math.min(rawDtMs, 1) : rawDtMs;
    // Drive skeleton poses for all animated entities.
    for (const [id, mesh] of this.entities.all) {
      if (mesh.boneGroups && mesh.skeletonId && this.content) {
        const anim = mesh.animationState;
        // Death-dissolve (T-311 P5c): push the server-derived phase into
        // this entity's dissolve-drift uniforms every frame — no-op array
        // for every entity that never resolved a DissolveProfileDef.
        if (mesh.dissolveUniforms.length > 0) {
          const phase = anim?.dissolutionPhase ?? 0;
          for (const u of mesh.dissolveUniforms) u.uPhase.value = phase;
        }
        // Readable i-frame flash (T-298): a client-derived bone-shine while
        // dodge_roll's dash phase (the i-frame window) is live — the player
        // SEES why the dodge worked. Every entity's voxelMeshes carry their
        // own material instances, so this never bleeds across entities.
        applyIframeFlash(mesh, computeIframeFlash(mesh.activeActions, (id) => this.content!.getAction(id)));
        const skeleton   = this.content.getSkeletonSync(mesh.skeletonId);
        const clipIndex  = this.content.getClipIndex(mesh.skeletonId);
        const maskIndex  = this.content.getMaskIndex(mesh.skeletonId);

        // Telegraph lead clip (T-297): an optional tell appended on top of the
        // server-projected layers for the first `preWindup.ticks` of the
        // primary slot's first phase — purely client-derived from the
        // already-networked ActiveActions + the ActionDef's preWindup, no
        // wire change. Absent for every action that doesn't author one.
        const telegraph = this.content
          ? computeTelegraphLayer(mesh.activeActions, (id) => this.content!.getAction(id), mesh.lastAnimUpdateMs, now)
          : null;
        const rawLayers = telegraph ? [...(anim?.layers ?? []), telegraph] : (anim?.layers ?? []);

        // Crossfade the raw 20Hz layer snapshot so state transitions (idle→walk,
        // swing in/out) ease in/out instead of hard-cutting the pose (T-291).
        const layers = blendAnimationLayers(mesh.layerFades, rawLayers, animDtMs);
        const animForPose = anim ? { ...anim, layers } : (telegraph ? { layers, weaponActionId: "", ticksIntoAction: 0, dissolutionPhase: 0 } : null);

        // Fused pose pipeline: gait/crouch (legs) → locomotion lean (spine) →
        // swing overlay (arms) → foot-terrain IK → head stabilization, all
        // composed on one skeleton, each producer taking the previous
        // stage's pose as its basePose so they stack (T-308). The weapon-
        // style clip's UPPER body (arms/spine/head) rides through untouched
        // — only the gait/crouch/swing producers below override bones, and
        // gait+crouch only ever touch the leg chain.
        const swingWA = anim?.weaponActionId
          ? this.weaponActionsMap.get(anim.weaponActionId)
          : undefined;
        const loco = this.locoState(id, mesh, localMovement ?? null, localFacing ?? null);
        // Crouch: eased toward the input target (local player; remotes have no
        // networked crouch yet → 0). The pelvis drop is a root-group translation.
        const crouchTarget = id === this.localPlayerId ? (localCrouch ?? 0) : 0;
        mesh.crouchEased += (crouchTarget - mesh.crouchEased) * (1 - Math.exp(-CROUCH_OMEGA * (animDtMs / 1000)));
        const dropY = mesh.crouchEased > 0.002 ? mesh.crouchEased * CROUCH_DROP * mesh.modelScale : 0;
        // Only the local player crouches (remotes have no networked crouch), so
        // only its root is translated — leaves every other rig's root untouched.
        if (id === this.localPlayerId) {
          const rootBone = mesh.boneGroups.get("root");
          if (rootBone) rootBone.position.y = -dropY;
        }

        // Ground-plane position — the gait phase accumulator and
        // foot-terrain IK both need it; computed once per entity per frame
        // and shared, rather than twice.
        const ground = this.entityGroundXY(id, mesh, localPredictedPos ?? null, localFacing ?? null);
        // Procedural gait (T-308): advance the phase by ACTUAL ground
        // distance covered this frame (not intended speed), so an entity
        // blocked by geometry correctly stops cycling its feet instead of
        // sliding them in place — the "distance not time" property starts
        // here, at the accumulator, not just inside applyGaitPose.
        const gaitDef = skeleton?.gaitId ? this.content.getGaitSync(skeleton.gaitId) : undefined;
        let gaitPhase = 0;
        if (gaitDef) {
          if (mesh.gaitGroundX === null || mesh.gaitGroundY === null) {
            mesh.gaitGroundX = ground.x;
            mesh.gaitGroundY = ground.y;
          } else {
            const d = Math.hypot(ground.x - mesh.gaitGroundX, ground.y - mesh.gaitGroundY);
            // Clamp a single frame's delta to one full stride — a
            // teleport/respawn/tile-transition shouldn't inject a giant
            // phase jump (a visible leg-snap); a real step that large in
            // one frame would itself be a bug.
            mesh.gaitDistance = (mesh.gaitDistance + Math.min(d, gaitDef.strideLength)) % gaitDef.strideLength;
            mesh.gaitGroundX = ground.x;
            mesh.gaitGroundY = ground.y;
          }
          gaitPhase = mesh.gaitDistance / gaitDef.strideLength;
        }

        let pose: Map<string, THREE.Euler>;
        if (skeleton && (swingWA?.swingPath || loco || dropY > 0)) {
          const boneIndex = this.content.getBoneIndex(mesh.skeletonId);
          const baseLayers = swingWA?.swingPath ? layers.filter((l) => l.clipId !== swingWA.clipId) : layers;
          let rot: Map<string, BoneRotation> = evaluatePose(skeleton, clipIndex, maskIndex, anim ? { ...anim, layers: baseLayers } : null);
          if (loco && gaitDef) {
            // Gait OWNS the legs while moving — supersedes applyCrouchPose's
            // own foot-replant, passing the SAME pelvis-drop rootOffset when
            // also crouching so crouch + walk compose without either
            // producer needing to run first (see applyGaitPose's doc).
            const rootOffset = dropY > 0 ? { x: 0, y: -dropY, z: 0 } : undefined;
            rot = applyGaitPose(skeleton, boneIndex, rot, mesh.modelScale, gaitDef, gaitPhase, loco, { rootOffset, morphParams: mesh.modelMorphs });
          } else if (dropY > 0) {
            rot = applyCrouchPose(skeleton, boneIndex, rot, mesh.modelScale, dropY, { morphParams: mesh.modelMorphs });
          }
          if (loco) rot = applyLocomotionPose(skeleton, boneIndex, rot, mesh.modelScale, loco, { morphParams: mesh.modelMorphs });
          if (swingWA?.swingPath) {
            const total = swingWA.windupTicks + swingWA.activeTicks + swingWA.winddownTicks;
            const ticks = anim!.ticksIntoAction + (now - mesh.lastAnimUpdateMs) / 50;
            const t = Math.max(0, Math.min(ticks / total, 1));
            rot = solveSwingPose(skeleton, boneIndex, rot, mesh.modelScale, swingWA.swingPath, t, { morphParams: mesh.modelMorphs });
          }
          // Foot-terrain IK (T-308/T-186): re-plant feet at the local ground
          // height once something else already put this entity through the
          // extra pose pass (walking/crouching/swinging) — a fully idle
          // entity's rest pose has no lean to correct against a slope yet,
          // see swing_pose.ts's applyFootTerrainIK doc for the scoping note.
          if (this.world) {
            const { x, y, facing } = ground;
            const world = this.world;
            rot = applyFootTerrainIK(
              skeleton, boneIndex, rot, mesh.modelScale, { x, y }, facing,
              (wx, wy) => world.getTerrainHeight(wx, wy), { morphParams: mesh.modelMorphs },
            );
          }
          // Head/gaze stabilization — last, so it corrects the FINAL composed
          // lean (crouch + locomotion + swing) rather than an intermediate one.
          rot = applyLookAtPose(skeleton, boneIndex, rot, mesh.modelScale, LOOK_AT_GAIN, { morphParams: mesh.modelMorphs });
          // rewrap the mixed map (THREE.Euler for untouched bones, {x,y,z} for overridden) to THREE.Euler
          pose = new Map<string, THREE.Euler>();
          for (const [bone, r] of rot) pose.set(bone, r instanceof THREE.Euler ? r : new THREE.Euler(r.x, r.y, r.z));
        } else {
          pose = evaluatePose(skeleton, clipIndex, maskIndex, animForPose);
        }

        // Secondary motion: ease the spine/head toward the composed pose (snappy,
        // never floaty) so the body settles organically. IK'd hands are excluded.
        applyBoneSprings(mesh, pose, animDtMs);
        updateSkeletonPose(mesh, pose);

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
    // predictor; facing/rotation comes from the locally-tracked mouse-driven
    // facing (T-328, was movement-derived under T-320) — updateEntityMesh
    // only ever sets rotation from the networked facing, which lags by RTT
    // and made swings sweep from a stale orientation.
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

    // Frame dt (seconds), computed here — reused below for particles/motes.
    // lastFrameMs is advanced here to hold this frame's timestamp.
    const dt = this.lastFrameMs > 0 ? Math.min((now - this.lastFrameMs) / 1000, 0.1) : 0;
    this.lastFrameMs = now;

    // Camera yaw is DERIVED from the player's facing (T-328): mouse-X now
    // rotates FACING (IntentTranslator owns the accumulator, fed the same
    // raw pointer-lock deltas via game.ts), and the camera sits rigidly
    // behind the character's heading — no independent camera-yaw
    // accumulator anymore. Pitch stays camera-only (cameraRig.applyLookDelta,
    // mouse-Y). update() re-places the camera from the current (yaw, pitch)
    // each frame around the player target.
    if (localFacing != null) this.cameraRig.setYaw(localFacing);
    this.cameraRig.update(this.cameraTarget, dt);

    // Day/night lerp + shadow-frustum follow/snap + sky-locked sun disc — all
    // off the now-settled camera target. (After cameraRig.update so the sun disc
    // tracks this frame's camera position.) T-311 P5a: the sun direction is a
    // pure function of the server WorldClock's time-of-day — extrapolate
    // smoothly between the 20 Hz server ticks via wall-clock elapsed time
    // (same smoothTick idiom above) rather than stepping once per network
    // update.
    const clock = this.world?.getWorldClock();
    let t01 = 0.5;
    if (clock) {
      if (clock.ticksElapsed !== this.lastKnownWorldClockTicks) {
        this.lastKnownWorldClockTicks = clock.ticksElapsed;
        this.lastWorldClockMs = now;
      }
      const smoothTicks = clock.ticksElapsed + (now - this.lastWorldClockMs) / 50;
      t01 = timeOfDay01(smoothTicks, clock.dayLengthTicks);

      // Re-select the atmosphere off the live biomeTag (T-311 P5a) — cheap
      // Map lookups, re-checked every frame rather than special-cased into
      // setContentCache/setClientWorld's differing call order per tile
      // transition (WorldClock's entity spawn can decode after either).
      if (this.content && clock.biomeTag !== this.appliedAtmosphereId) {
        const atmo = this.content.getAtmosphere(clock.biomeTag) ?? this.content.getAtmosphere("default");
        if (atmo) {
          this.envLighting.applyAtmosphere(atmo);
          this.currentAtmosphere = atmo;
          this.appliedAtmosphereId = clock.biomeTag;
          // God-ray params are static per atmosphere (unlike mist's per-phase
          // weight) — applied once here, not every frame.
          this.godRay.setParams(atmo.godRay);
          this.edgePass.setGodRayParams(atmo.godRay.strength, atmo.godRay.color);
          // T-340: the ambient drift population rides the same per-frame
          // atmosphere re-selection — a tile transition or biome change
          // picks up a different ambience (or none) for free.
          this.particles.setAmbience(atmo.ambienceParticleId ?? null);
        }
      }
    }
    this.envLighting.update(this.cameraTarget, this.camera.position, t01);
    // Cheap wetness-weighted sky reflection (T-311 P5b): every wet_reflect-
    // treated ground material shares one uniform object, updated here once
    // per frame (same shared-uniform idiom canopyFade uses for wind time).
    setWetReflectSkyColor(this.getSkyColor());

    // Ground mist (T-311 P5a, GroundMistLayer): lerp this frame's phase
    // density weight toward the current AtmosphereDef's target the same way
    // envLighting's lightCur lerps colors, so mist doesn't snap on a phase
    // change; params (band/color) are static per atmosphere, only reapplied
    // when they change.
    if (this.currentAtmosphere) {
      const target = this.currentAtmosphere.mist.densityByPhase[this.currentDayPhase] ?? 0;
      this.mistWeightCur += (target - this.mistWeightCur) * 0.015;
      this.edgePass.setMist(this.currentAtmosphere.mist, this.mistWeightCur);
    }

    // Update weapon tip trail ribbons for all currently attacking entities.
    const tTrailStart = performance.now();
    this.weaponTrail.update(this.entities.all, this.weaponActionsMap, now);
    this.frameTimings.trailMs = performance.now() - tTrailStart;

    // T-340: muzzle-flash edge detection reads the same weapon-action phase
    // math weaponTrail just applied this frame; burst/ambience particle
    // physics integrate right after (replaces hitSparkRenderer/dustMotes).
    this.particles.updateMuzzleFlashes(this.entities.all, this.weaponActionsMap, now);
    this.particles.update(dt, this.cameraTarget);
    canopyFade.setWindTime(now);
    this.edgePass.setTime(now * 0.001);
    this.lightManager.tick(now, this.camera.position);

    const tGlStart = performance.now();
    if (this.bypassPostFX) {
      // Diagnostic mode — render scene directly to canvas, skipping the entire
      // post-FX chain (pixelTarget, hover mask, depth blit, EdgePass).  Use this
      // to measure how much of the frame budget post-FX consumes.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } else {
      // Pass 1: render scene to the HDR pixel target (writes colour + depth).
      this.renderer.setRenderTarget(this.pixelTarget);
      this.renderer.render(this.scene, this.camera);

      // T-313: extend raking shadows past the near sun's ±60u frustum via a
      // second, wider, coarser cascade — darkens the HDR colour BEFORE
      // bloom/god-ray read it, so canopy-gap light shafts shape correctly
      // out there too (not just inside the near cascade's reach).
      {
        const farMap = this.envLighting.getFarShadowMap();
        this.shadowCascade.render(
          this.renderer,
          this.pixelTarget.texture,
          this.depthTex,
          this.camera.projectionMatrixInverse,
          this.camera.matrixWorld,
          this.envLighting.getNearShadowMatrix(this._nearShadowMatrixScratch),
          farMap,
          farMap ? this.envLighting.getFarShadowMatrix(this._farShadowMatrixScratch) : null,
        );
      }

      // Bloom: bright-pass + blur the HDR scene colour (torch/ember/sun glow).
      // The EdgePass adds the result back before its ACES tonemap.
      this.bloom.render(this.renderer, this.shadowCascade.texture);
      this.edgePass.setBloomTexture(this.bloom.texture);

      // God rays: project the sun to screen UV and radial-scatter the bloom
      // bright-target toward it → canopy/mist light shafts.
      this.envLighting.getSunWorldPosition(this._sunWorld).project(this.camera);
      this._sunUV.set(this._sunWorld.x * 0.5 + 0.5, this._sunWorld.y * 0.5 + 0.5);
      this.godRay.render(this.renderer, this.bloom.texture, this._sunUV);
      this.edgePass.setGodRayTexture(this.godRay.texture);

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
      this.depthBlitMat.uniforms.uHeightMin.value = playerPos.y - this.heightShadeBelow;
      this.depthBlitMat.uniforms.uHeightMax.value = playerPos.y + this.heightShadeAbove;
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

  /** Feed a wire GameEvent to the particle system's source registry (T-340) —
   *  replaces spawnHitSpark. */
  onParticleEvent(ev: GameEvent): void {
    this.particles.onEvent(ev);
  }

  /** Register particle emitter definitions (T-340), from the bootstrap-
   *  delivered ContentService. */
  setParticleDefs(defs: ParticleEmitterDef[]): void {
    this.particles.setDefs(defs);
  }

  /** Wire the particle system's gravity constant to GameConfig.physics.gravity
   *  (T-340) — never a hardcoded TS constant. */
  setParticlePhysics(gravity: number): void {
    this.particles.setPhysics(gravity);
  }

  /**
   * Hitstop (T-296+T-292): freeze the whole scene's animation advance for
   * `durationMs` — client-derived punch on a confirmed hit. The server's own
   * per-entity freeze (movement-locked via PhysicsSystem) already holds the
   * attacker+target in place for `hitStopTicks`; this is the visual
   * counterpart so the WHOLE frame reads as a beat, not just the two
   * bodies. Never shortens an already-running freeze (a second hit landing
   * mid-freeze extends it, doesn't reset it shorter).
   */
  triggerHitStop(durationMs: number): void {
    this.hitStopUntilMs = Math.max(this.hitStopUntilMs, performance.now() + durationMs);
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
    // Match the supersampled drawing-buffer resolution (CSS size × pixel ratio).
    const ratio = this.renderer.getPixelRatio();
    const npw = Math.max(1, Math.round(w * ratio));
    const nph = Math.max(1, Math.round(h * ratio));
    this.pixelTarget.setSize(npw, nph);
    this.heightTarget.setSize(npw, nph);
    this.hoverMaskTarget.setSize(npw, nph);
    this.shadowCascade.setSize(npw, nph);
    this.edgePass.setSize(npw, nph);
    this.bloom.setSize(npw, nph);
    this.godRay.setSize(npw, nph);
  }

  dispose(): void {
    this.debugOverlayManager.dispose();
    this.particles.dispose();
    this.lightManager.dispose();
    this.weaponTrail.dispose();
    this.instancePool.dispose();
    this.edgePass.dispose();
    this.bloom.dispose();
    this.godRay.dispose();
    this.shadowCascade.dispose();
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
