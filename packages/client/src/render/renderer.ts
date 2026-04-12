/// <reference lib="dom" />
/**
 * Voxim renderer — Three.js scene management.
 *
 * Visual grammar:
 *   - Post-process pipeline: scene → pixelTarget → depth-blit → heightTarget → EdgePass (Sobel + AO + sRGB) → aaTarget → FxaaPass → canvas.
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
import type { MaterialDef, ModelDefinition, WeaponActionDef, ItemTemplate, AnimationStateData } from "@voxim/content";
import { resolveSubObjects } from "@voxim/content";
import { buildTerrainMesh } from "./terrain_mesh.ts";
import {
  createEntityMesh,
  updateEntityMesh,
  upgradeToSkeletonModel,
  updateSkeletonPose,
  ensureAttachment,
  ensureBoneAttachment,
  attachModelToSlot,
  attachArmorToSlot,
  detachModelFromSlot,
  disposeEntityMesh,
  type EntityMeshGroup,
} from "./entity_mesh.ts";
import { PropInstancePool } from "./prop_instance_pool.ts";
import { evaluatePose, evaluateWeaponSlice, buildDriveContext, applyIKChains } from "./skeleton_evaluator.ts";
import { SkeletonOverlay } from "./skeleton_overlay.ts";
import { FacingOverlay, ChunkOverlay } from "./debug_overlay.ts";
import { BladeDebugOverlay } from "./blade_debug_overlay.ts";
import { HitboxDebugOverlay, HITBOX_OVERLAY_LAYER } from "./hitbox_debug_overlay.ts";
import { HitSparkRenderer } from "./hit_spark_renderer.ts";
import { EdgePass } from "./edge_pass.ts";
import { FxaaPass } from "./fxaa_pass.ts";

/**
 * Isometric view direction: camera sits at this offset from the camera target.
 * (16, 24, 16) in Three.js space = 45° azimuth, ~47° elevation — classic game iso.
 */
const ISO_OFFSET = new THREE.Vector3(16, 24, 16);

/** One recorded frame of the weapon blade during an attack's active phase. */
interface TrailSlice {
  hilt: THREE.Vector3;
  tip:  THREE.Vector3;
  alpha: number;
}

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
 * Half-height of the orthographic frustum in world units.
 * The visible vertical range is 2×ORTHO_HALF = 60 world units.
 */
const ORTHO_HALF = 20;

/** Terrain chunk size in world units. Must match CHUNK_SIZE in @voxim/world. */
const CHUNK_SIZE = 32;

/**
 * Entities further than this squared distance (in world-x/y plane) from the
 * local player have their Three.js group hidden each frame.
 * 68² ≈ diagonal of the 3×3 chunk window (96 units) with a small margin.
 */
const CULL_RADIUS_SQ = 68 * 68;


/**
 * How many milliseconds behind the latest received state remote entities
 * are rendered, to allow smooth linear interpolation between server ticks.
 */
const INTERP_DELAY_MS = 100;

/** Lighting definition for a given time-of-day phase. */
interface DayPhaseLight {
  sky: THREE.Color; fog: THREE.Color; sun: THREE.Color;
  sunIntensity: number; hemiIntensity: number; fogFar: number;
}

function makePhaseLights(): Record<string, DayPhaseLight> {
  return {
    noon:     { sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc), sun: new THREE.Color(0xfffde0), sunIntensity: 2.5,  hemiIntensity: 0.25, fogFar: 220 },
    dawn:     { sky: new THREE.Color(0xd8846a), fog: new THREE.Color(0xb06848), sun: new THREE.Color(0xffb060), sunIntensity: 1.4,  hemiIntensity: 0.14, fogFar: 160 },
    dusk:     { sky: new THREE.Color(0xa04828), fog: new THREE.Color(0x883820), sun: new THREE.Color(0xff7030), sunIntensity: 1.1,  hemiIntensity: 0.11, fogFar: 150 },
    midnight: { sky: new THREE.Color(0x08091a), fog: new THREE.Color(0x060714), sun: new THREE.Color(0x2030a0), sunIntensity: 0.06, hemiIntensity: 0.04, fogFar: 100 },
  };
}

/** Lerp a number toward target, returning new value. */
function lerpN(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Short-path angle lerp (handles ±π wrap). */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + d * t;
}

/**
 * Normalized direction FROM the world origin TOWARD the sun.
 * Used for both the DirectionalLight position and the visible sun sphere.
 */
const SUN_DIR = new THREE.Vector3(20, 100, -15).normalize();

/** Scratch objects — reused by updateAttachmentPositions to avoid per-frame allocation. */
const _attachTmp   = new THREE.Vector3();
const _bladeTip    = new THREE.Vector3();
const _bladeUp     = new THREE.Vector3(0, 1, 0);  // world-up used as orientation hint
const _attachQuat  = new THREE.Quaternion();
const _attachMat   = new THREE.Matrix4();


export class VoximRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;

  private readonly terrainMeshes  = new Map<string, THREE.Mesh>();
  private readonly terrainHmaps   = new Map<string, HeightmapData>();
  private readonly terrainMats    = new Map<string, MaterialGridData>();
  private readonly entityMeshes   = new Map<string, EntityMeshGroup>();
  private readonly propPool: PropInstancePool;
  private readonly propPositions  = new Map<string, THREE.Vector3>();

  readonly skeletonOverlay:    SkeletonOverlay;
  readonly facingOverlay:      FacingOverlay;
  readonly chunkOverlay:       ChunkOverlay;
  readonly bladeDebugOverlay:  BladeDebugOverlay;
  readonly hitboxDebugOverlay: HitboxDebugOverlay;
  private readonly hitSparkRenderer: HitSparkRenderer;

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
  /** Intermediate target for EdgePass output — FXAA reads from this. */
  private readonly aaTarget: THREE.WebGLRenderTarget;
  /** Screen-space FXAA — smooths sub-pixel edges on EdgePass output before canvas output. */
  private readonly fxaaPass: FxaaPass;
  private fxaaEnabled = true;
  /** Fullscreen blit pass: upscales pixelTarget to the canvas. */
  private readonly blitScene: THREE.Scene;
  private readonly blitMesh: THREE.Mesh;
  private readonly blitCamera: THREE.OrthographicCamera;
  /** Fullscreen scene for the FXAA pass. */
  private readonly fxaaScene: THREE.Scene;
  /** Debug: when true the blit pass shows the raw height texture instead of the scene. */
  private heightDebugEnabled = false;

  /**
   * Weapon tip trail system.
   *
   * During an attack's active phase the weapon blade traces a path through world
   * space.  Each frame we record a (hilt, tip) slice and render consecutive slices
   * as a ribbon mesh.  Slices fade out at 0.04 alpha/frame and are culled when
   * they reach zero.
   */
  private readonly trailSlices = new Map<string, TrailSlice[]>();
  private readonly trailMeshes = new Map<string, THREE.Mesh>();

  /**
   * Entity-root slots that follow a rest bone each frame (position + rotation).
   * "main_hand" is handled separately (swing-path during attacks).
   * Armor slots are bone-parented (see ARMOR_SLOTS) and need no entry here.
   */
  private static readonly SLOT_REST_BONE: Record<string, string> = {
    off_hand: "hand_l",
  };

  /**
   * Armor slots: maps equipment slot name → one or more render slots, each
   * attached to a specific bone.  Leg and foot items attach to both sides.
   */
  private static readonly ARMOR_SLOTS: Record<string, Array<{ renderSlotId: string; boneId: string }>> = {
    head:  [{ renderSlotId: "head",          boneId: "head" }],
    chest: [{ renderSlotId: "chest",         boneId: "torso_upper" }],
    back:  [{ renderSlotId: "back",          boneId: "torso_upper" }],
    legs:  [
      { renderSlotId: "legs_upper_l", boneId: "upper_leg_l" },
      { renderSlotId: "legs_upper_r", boneId: "upper_leg_r" },
      { renderSlotId: "legs_lower_l", boneId: "lower_leg_l" },
      { renderSlotId: "legs_lower_r", boneId: "lower_leg_r" },
    ],
    feet:  [
      { renderSlotId: "feet_l",       boneId: "foot_l" },
      { renderSlotId: "feet_r",       boneId: "foot_r" },
    ],
  };
  /** Weapon action definitions — set by setWeaponActions() from game.ts. */
  private weaponActionsMap = new Map<string, WeaponActionDef>();
  /** Item template definitions — set by setItemTemplates() from game.ts. Used to resolve weapon modelTemplateId. */
  private itemTemplateMap = new Map<string, ItemTemplate>();

  /** Directional sun — its target tracks the camera center each frame. */
  private readonly sun: THREE.DirectionalLight;
  /**
   * Shadow camera basis vectors (pre-computed from the fixed SUN_DIR).
   * Used to snap the shadow frustum in shadow-UV space rather than world X/Z —
   * world-axis snapping leaves residual swimming along the perpendicular axis
   * whenever the shadow camera isn't aligned with the world grid.
   */
  private readonly _shadowCamRight: THREE.Vector3;
  private readonly _shadowCamUp: THREE.Vector3;
  /** Visible sun disc in the sky. */
  private readonly sunMesh: THREE.Mesh;
  /** Hemisphere sky/ground ambient. */
  private readonly hemi: THREE.HemisphereLight;

  // ---- day/night lighting ----
  private readonly phaseLights = makePhaseLights();
  /** Current interpolated lighting values (mutated every frame). */
  private readonly lightCur: DayPhaseLight = {
    sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc),
    sun: new THREE.Color(0xfffde0), sunIntensity: 2.5, hemiIntensity: 0.25, fogFar: 220,
  };
  /** Target lighting values set by setDayPhase(). */
  private readonly lightTgt: DayPhaseLight = {
    sky: new THREE.Color(0x7aa4cc), fog: new THREE.Color(0x7aa4cc),
    sun: new THREE.Color(0xfffde0), sunIntensity: 2.5, hemiIntensity: 0.25, fogFar: 220,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.propPool        = new PropInstancePool(this.scene);
    this.skeletonOverlay   = new SkeletonOverlay(this.scene);
    this.facingOverlay     = new FacingOverlay(this.scene);
    this.chunkOverlay      = new ChunkOverlay(this.scene);
    this.bladeDebugOverlay  = new BladeDebugOverlay(this.scene);
    this.hitboxDebugOverlay = new HitboxDebugOverlay();
    this.hitSparkRenderer   = new HitSparkRenderer(this.scene);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap; // hard 1-pixel shadow edges → thin outline

    const aspect = (canvas.clientWidth || canvas.width || 320) / (canvas.clientHeight || canvas.height || 180);
    // near=-200 prevents the near plane from clipping terrain and objects that sit
    // "behind" the camera along the isometric view direction (most visible near map edges).
    this.camera = new THREE.OrthographicCamera(
      -ORTHO_HALF * aspect, ORTHO_HALF * aspect, ORTHO_HALF, -ORTHO_HALF, -200, 1000,
    );
    this.camera.position.copy(this.cameraTarget).add(ISO_OFFSET);
    this.camera.lookAt(this.cameraTarget);

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

    // ---- edge pass + fullscreen blit scene ----
    this.edgePass   = new EdgePass(this.pixelTarget.texture, this.heightTarget.texture, pw, ph);
    this.blitScene  = new THREE.Scene();
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blitGeo = new THREE.PlaneGeometry(2, 2);
    this.blitMesh = new THREE.Mesh(blitGeo, this.edgePass.material);
    this.blitScene.add(this.blitMesh);

    // ---- FXAA pass — reads EdgePass output, writes anti-aliased result to canvas ----
    this.aaTarget = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      stencilBuffer: false,
    });
    this.fxaaPass  = new FxaaPass(this.aaTarget.texture, pw, ph);
    this.fxaaScene = new THREE.Scene();
    this.fxaaScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fxaaPass.material));

    // ---- lighting ----
    // Strong directional sun — dominates shading so flat-shaded faces read clearly.
    this.sun = new THREE.DirectionalLight(0xfffde0, 2.5);
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near   = 0.5;
    this.sun.shadow.camera.far    = 400;
    this.sun.shadow.camera.left   = -90;
    this.sun.shadow.camera.right  =  90;
    this.sun.shadow.camera.top    =  90;
    this.sun.shadow.camera.bottom = -90;
    this.sun.shadow.bias = -0.001; // prevent self-shadow acne on flat faces
    this.scene.add(this.sun);
    // Target must be in the scene so Three.js updates its world matrix each frame.
    this.scene.add(this.sun.target);

    // Pre-compute shadow camera basis vectors from the fixed SUN_DIR.
    // Three.js lookAt: camLocalZ = normalize(eye - target) = SUN_DIR.
    // camLocalX = normalize(cross(worldUp, SUN_DIR)); camLocalY = cross(SUN_DIR, camLocalX).
    // Snapping in these axes (not world X/Z) eliminates shadow swimming on non-axis geometry.
    {
      const up = new THREE.Vector3(0, 1, 0);
      this._shadowCamRight = new THREE.Vector3().crossVectors(up, SUN_DIR).normalize();
      this._shadowCamUp    = new THREE.Vector3().crossVectors(SUN_DIR, this._shadowCamRight).normalize();
    }

    // Ambient fill — brightened so shadowed cliff walls are readable, not black voids.
    this.hemi = new THREE.HemisphereLight(0x99bbdd, 0x334433, 0.55);
    this.scene.add(this.hemi);

    // ---- visible sun sphere ----
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(10, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfffce0 }),
    );
    this.scene.add(this.sunMesh);

    // ---- sky ----
    this.scene.fog = new THREE.Fog(0x7aa4cc, 80, 220);
    this.scene.background = new THREE.Color(0x7aa4cc);

    globalThis.addEventListener("resize", () => this.onResize(canvas));
  }

  setLocalPlayer(id: string): void {
    this.localPlayerId = id;
  }

  setContentCache(cache: ContentCache): void {
    this.content = cache;
  }

  // ---- terrain ----

  updateTerrain(heightmap: HeightmapData, materials: MaterialGridData): void {
    const cx = heightmap.chunkX, cy = heightmap.chunkY;
    const key = `${cx},${cy}`;

    this.terrainHmaps.set(key, heightmap);
    this.terrainMats.set(key, materials);

    this._rebuildChunk(cx, cy);

    // Neighbors whose east/south boundary wall now references this chunk need rebuilding too.
    this._rebuildChunk(cx - 1, cy);  // west neighbor — its east boundary faces us
    this._rebuildChunk(cx, cy - 1);  // north neighbor — its south boundary faces us
  }

  private _rebuildChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    const hm = this.terrainHmaps.get(key);
    const mat = this.terrainMats.get(key);
    if (!hm || !mat) return;

    const existing = this.terrainMeshes.get(key);
    const mesh = buildTerrainMesh(
      hm, mat, existing,
      this.terrainHmaps.get(`${cx + 1},${cy}`) ?? null,
      this.terrainMats.get(`${cx + 1},${cy}`) ?? null,
      this.terrainHmaps.get(`${cx},${cy + 1}`) ?? null,
      this.terrainMats.get(`${cx},${cy + 1}`) ?? null,
    );
    if (!existing) {
      this.scene.add(mesh);
      this.terrainMeshes.set(key, mesh);
      this.chunkOverlay.addChunk(cx, cy);
    }
  }

  removeTerrain(chunkX: number, chunkY: number): void {
    const key = `${chunkX},${chunkY}`;
    const mesh = this.terrainMeshes.get(key);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.terrainMeshes.delete(key);
      this.terrainHmaps.delete(key);
      this.terrainMats.delete(key);
      this.chunkOverlay.removeChunk(chunkX, chunkY);
    }
  }

  // ---- entities ----

  updateEntity(entityId: string, state: EntityState): void {
    // Static props are fully managed by propPool after their first model load.
    if (this.propPool.hasProp(entityId)) return;

    const isLocal = entityId === this.localPlayerId;
    let mesh = this.entityMeshes.get(entityId);
    if (!mesh) {
      mesh = createEntityMesh(state, isLocal);
      this.scene.add(mesh.group);
      this.entityMeshes.set(entityId, mesh);
    } else {
      updateEntityMesh(mesh, state);
    }

    // Upgrade to skeleton model (animated entity) or prop pool (static entity)
    // when modelRef arrives or changes.
    const modelRef = state.modelRef;
    if (modelRef && this.content && mesh.modelId !== modelRef.modelId) {
      const capture = mesh;
      const scale = { x: modelRef.scaleX, y: modelRef.scaleY, z: modelRef.scaleZ };
      this.content.prefetchModel(modelRef.modelId).then(() => {
        const def = this.content!.getModelSync(modelRef.modelId);
        if (!def) return;

        const resolvedSubs = resolveSubObjects(def.subObjects, modelRef.seed ?? 0);

        const allMatIds = new Set<number>(def.materials);
        for (const sub of resolvedSubs) {
          const subDef = this.content!.getModelSync(sub.modelId);
          if (subDef) for (const id of subDef.materials) allMatIds.add(id);
        }
        const mats = new Map<number, MaterialDef>();
        for (const id of allMatIds) {
          const m = this.content!.getMaterialSync(id);
          if (m) mats.set(id, m);
        }

        const skeleton = def.skeletonId
          ? this.content!.getSkeletonSync(def.skeletonId)
          : undefined;

        const subModelDefs = new Map<string, ModelDefinition>();
        for (const sub of resolvedSubs) {
          const subDef = this.content!.getModelSync(sub.modelId);
          if (subDef) subModelDefs.set(sub.modelId, subDef);
        }

        if (skeleton) {
          upgradeToSkeletonModel(capture, def, skeleton, resolvedSubs, subModelDefs, mats, scale);
          this.skeletonOverlay.trackEntity(entityId, capture, skeleton);

          // Record each sub-object's transform so armor anchors can be placed
          // at the same position and scale as the body-part they overlay.
          capture.boneSlotTransforms.clear();
          for (const sub of resolvedSubs) {
            if (sub.boneId && sub.transform.scaleX === sub.transform.scaleY &&
                sub.transform.scaleX === sub.transform.scaleZ) {
              capture.boneSlotTransforms.set(sub.boneId, {
                x: sub.transform.x, y: sub.transform.y, z: sub.transform.z,
                scale: sub.transform.scaleX,
              });
            }
          }

          // Sync all equipment slots now that boneGroups exist.
          this.syncEquipment(capture, state);
        } else {
          // Static prop — hand off to instanced pool, discard the placeholder Group.
          const worldPos = capture.group.position.clone();
          this.scene.remove(capture.group);
          disposeEntityMesh(capture);
          this.entityMeshes.delete(entityId);
          this.propPool.addProp(entityId, worldPos, def, resolvedSubs, subModelDefs, mats, scale);
          this.propPositions.set(entityId, worldPos);
          // TODO Step 7: re-wire hitbox debug overlay using local computeHitboxDebug()
        }
      }).catch(() => {});
    }

    // React to equipment changes on already-upgraded skeleton entities.
    // syncEquipment exits early per-slot when the model ID hasn't changed.
    if (mesh.boneGroups && state.equipment !== undefined) {
      this.syncEquipment(mesh, state);
    }
  }

  /**
   * Immediately override the local player's weapon action for client-side prediction.
   * Called the instant the player attacks so the swing is visible without waiting for
   * the server round-trip. The server's confirmed AnimationState will overwrite this
   * within one tick (≤50ms) via the normal delta path.
   */
  forceLocalAnimation(weaponActionId: string): void {
    if (!this.localPlayerId) return;
    const mesh = this.entityMeshes.get(this.localPlayerId);
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
    if (this.propPool.hasProp(entityId)) {
      this.propPool.removeProp(entityId);
      this.propPositions.delete(entityId);
      this.hitboxDebugOverlay.removeEntity(entityId);
      return;
    }
    const mesh = this.entityMeshes.get(entityId);
    if (mesh) {
      this.skeletonOverlay.untrackEntity(entityId);
      this.bladeDebugOverlay.remove(entityId);
      this.hitboxDebugOverlay.removeEntity(entityId);
      this.scene.remove(mesh.group);
      disposeEntityMesh(mesh);
      this.entityMeshes.delete(entityId);
    }
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

  /** Project an entity's world position to canvas pixel coordinates, or null if not found. */
  getEntityScreenPos(entityId: string): { x: number; y: number } | null {
    const mesh = this.entityMeshes.get(entityId);
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
    const p = this.phaseLights[phase] ?? this.phaseLights.noon;
    this.lightTgt.sky.copy(p.sky);
    this.lightTgt.fog.copy(p.fog);
    this.lightTgt.sun.copy(p.sun);
    this.lightTgt.sunIntensity = p.sunIntensity;
    this.lightTgt.hemiIntensity = p.hemiIntensity;
    this.lightTgt.fogFar = p.fogFar;
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

  toggleFxaa(): boolean {
    this.fxaaEnabled = !this.fxaaEnabled;
    return this.fxaaEnabled;
  }

  // ---- render loop ----

  render(serverTick: number, localPredictedPos?: { x: number; y: number; z: number } | null): void {
    // Compute a smooth fractional tick that advances at 20 Hz based on real time.
    // This makes animations run at 60 fps instead of stepping every 50 ms.
    const now = performance.now();
    if (serverTick !== this.lastKnownServerTick) {
      this.lastKnownServerTick = serverTick;
      this.lastServerTickMs = now;
    }
    this.smoothTick = serverTick + (now - this.lastServerTickMs) / 50;

    // Drive skeleton poses for all animated entities.
    for (const [, mesh] of this.entityMeshes) {
      if (mesh.boneGroups && mesh.skeletonId && this.content) {
        const anim = mesh.animationState;
        const skeleton   = this.content.getSkeletonSync(mesh.skeletonId);
        const clipIndex  = this.content.getClipIndex(mesh.skeletonId);
        const maskIndex  = this.content.getMaskIndex(mesh.skeletonId);

        const pose = evaluatePose(skeleton, clipIndex, maskIndex, anim);
        updateSkeletonPose(mesh, pose);

        // Look up weapon action for attachment positioning and trail rendering.
        const weaponActionId = anim?.weaponActionId ?? "";
        const weaponAction = weaponActionId ? this.weaponActionsMap.get(weaponActionId) : undefined;

        // Elapsed fractional ticks since last server update — used for 60fps extrapolation.
        const elapsed = (now - mesh.lastAnimUpdateMs) / 50;

        // IK post-pass: build drive context (hilt position etc.) then solve arm chains.
        if (skeleton?.ikChains?.length && weaponAction?.ikChainIds?.length) {
          const driveCtx = buildDriveContext(anim, this.weaponActionsMap, elapsed);
          applyIKChains(mesh, skeleton, weaponAction.ikChainIds, driveCtx);
        }

        // Compute normalised action time t for attachment and trail positioning.
        const totalTicks = weaponAction
          ? weaponAction.windupTicks + weaponAction.activeTicks + weaponAction.winddownTicks
          : 0;
        const ticks = totalTicks > 0
          ? Math.min((anim?.ticksIntoAction ?? 0) + elapsed, totalTicks)
          : 0;
        const t = totalTicks > 0 ? ticks / totalTicks : 1.0;

        this.updateAttachmentPositions(mesh, anim, weaponAction, t);
      }
    }

    // Interpolate remote entity positions (local player snaps — no delay)
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const [id, mesh] of this.entityMeshes) {
      if (id === this.localPlayerId) continue;
      const buf = mesh.posBuffer;
      if (buf.length === 0) continue;
      if (buf.length === 1) {
        mesh.group.position.set(buf[0].x, buf[0].y, buf[0].z);
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
        mesh.group.position.set(buf[lo].x, buf[lo].y, buf[lo].z);
        mesh.group.rotation.y = buf[lo].ry;
      } else {
        const alpha = Math.max(0, Math.min(1, (renderTime - buf[lo].t) / (buf[hi].t - buf[lo].t)));
        mesh.group.position.set(
          lerpN(buf[lo].x, buf[hi].x, alpha),
          lerpN(buf[lo].y, buf[hi].y, alpha),
          lerpN(buf[lo].z, buf[hi].z, alpha),
        );
        mesh.group.rotation.y = lerpAngle(buf[lo].ry, buf[hi].ry, alpha);
      }
    }

    // Override local player position with client-side prediction
    if (localPredictedPos && this.localPlayerId) {
      const localMesh = this.entityMeshes.get(this.localPlayerId);
      if (localMesh) {
        // world(x, y, z) → three(x, height, y) — same mapping as updateEntityMesh
        localMesh.group.position.set(localPredictedPos.x, localPredictedPos.z, localPredictedPos.y);
      }
    }

    // Sync debug overlays after poses and interpolation
    this.skeletonOverlay.update(this.entityMeshes);
    this.facingOverlay.update(this.entityMeshes);
    this.bladeDebugOverlay.update(this.entityMeshes, this.weaponActionsMap, now);

    // Smoothly transition day/night lighting (per-frame lerp toward target)
    const L = 0.015; // lerp speed — full transition over ~4 s at 60 fps
    this.lightCur.sky.lerp(this.lightTgt.sky, L);
    this.lightCur.fog.lerp(this.lightTgt.fog, L);
    this.lightCur.sun.lerp(this.lightTgt.sun, L);
    this.lightCur.sunIntensity  = lerpN(this.lightCur.sunIntensity,  this.lightTgt.sunIntensity,  L);
    this.lightCur.hemiIntensity = lerpN(this.lightCur.hemiIntensity, this.lightTgt.hemiIntensity, L);
    this.lightCur.fogFar        = lerpN(this.lightCur.fogFar,        this.lightTgt.fogFar,        L);
    (this.scene.background as THREE.Color).copy(this.lightCur.sky);
    (this.scene.fog as THREE.Fog).color.copy(this.lightCur.fog);
    (this.scene.fog as THREE.Fog).far = this.lightCur.fogFar;
    this.sun.color.copy(this.lightCur.sun);
    this.sun.intensity   = this.lightCur.sunIntensity;
    this.hemi.intensity  = this.lightCur.hemiIntensity;
    this.sunMesh.visible = this.lightCur.sunIntensity > 0.15;

    // Smoothly track local player
    const localMesh = this.localPlayerId
      ? this.entityMeshes.get(this.localPlayerId)
      : undefined;
    if (localMesh) {
      this.cameraTarget.copy(localMesh.group.position);
    }

    // Chunk culling — only render 3×3 chunks around the player
    const playerPos = localMesh?.group.position ?? this.cameraTarget;
    const pChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
    const pChunkY = Math.floor(playerPos.z / CHUNK_SIZE);
    for (const [key, tmesh] of this.terrainMeshes) {
      const [cx, cy] = key.split(",").map(Number);
      tmesh.visible = Math.abs(cx - pChunkX) <= 2 && Math.abs(cy - pChunkY) <= 2;
    }
    // Entity culling — hide entities beyond CULL_RADIUS_SQ
    for (const [id, emesh] of this.entityMeshes) {
      if (id === this.localPlayerId) { emesh.group.visible = true; continue; }
      const dx = emesh.group.position.x - playerPos.x;
      const dz = emesh.group.position.z - playerPos.z;
      emesh.group.visible = dx * dx + dz * dz <= CULL_RADIUS_SQ;
    }

    const targetCamPos = this.cameraTarget.clone().add(ISO_OFFSET);
    this.camera.position.copy(targetCamPos);
    this.camera.lookAt(this.cameraTarget);

    // Keep sun shadow frustum centered on the player area.
    // Both position and target must move together — only the direction between
    // them (SUN_DIR) defines where shadows fall, not the absolute world position.
    this.sun.target.position.copy(this.cameraTarget);
    this.sun.position.copy(this.cameraTarget).addScaledVector(SUN_DIR, 100);

    // Snap shadow frustum to its own texel grid (in shadow-camera UV space) to
    // eliminate shadow swimming.  Snapping in world X/Z leaves residual drift
    // along the axes not aligned with the shadow camera — visible on tall objects
    // like trees.  Projecting onto the shadow camera's right/up vectors and
    // rounding there keeps the shadow projection pixel-stable in all directions.
    {
      const sc = this.sun.shadow.camera;
      const texelX = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
      const texelY = (sc.top   - sc.bottom) / this.sun.shadow.mapSize.y;

      const t   = this.sun.target.position;
      const dotX = t.dot(this._shadowCamRight);
      const dotY = t.dot(this._shadowCamUp);

      const snapX = Math.round(dotX / texelX) * texelX - dotX;
      const snapY = Math.round(dotY / texelY) * texelY - dotY;

      const cx = this._shadowCamRight.x * snapX + this._shadowCamUp.x * snapY;
      const cy = this._shadowCamRight.y * snapX + this._shadowCamUp.y * snapY;
      const cz = this._shadowCamRight.z * snapX + this._shadowCamUp.z * snapY;

      this.sun.target.position.x += cx;
      this.sun.target.position.y += cy;
      this.sun.target.position.z += cz;
      this.sun.position.x += cx;
      this.sun.position.y += cy;
      this.sun.position.z += cz;
    }

    // Keep the sun sphere fixed in the sky relative to the camera
    this.sunMesh.position
      .copy(this.camera.position)
      .addScaledVector(SUN_DIR, 350);

    // Update weapon tip trail ribbons for all currently attacking entities.
    this.updateWeaponTrails(now);

    // Advance hit spark particles.
    const dt = this.lastFrameMs > 0 ? Math.min((now - this.lastFrameMs) / 1000, 0.1) : 0;
    this.lastFrameMs = now;
    this.hitSparkRenderer.update(dt);

    // Pass 1: render scene to low-res pixel target (writes colour + depth).
    this.renderer.setRenderTarget(this.pixelTarget);
    this.renderer.render(this.scene, this.camera);

    // Depth blit: reconstruct world-Y from pixelTarget.depthTexture → heightTarget.
    // pixelTarget is no longer the active FBO here, so reading its depth texture is
    // safe — no same-FBO feedback loop.  Camera matrices are snapped after Pass 1
    // so they match the frame that produced the depth buffer.
    this.depthBlitMat.uniforms.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    this.depthBlitMat.uniforms.uViewInv.value.copy(this.camera.matrixWorld);
    this.renderer.setRenderTarget(this.heightTarget);
    this.renderer.render(this.depthBlitScene, this.blitCamera);

    // Pass 2: edge detection + height shading + sRGB.
    // When FXAA is enabled, render to aaTarget so the FXAA pass can read it;
    // otherwise render directly to the canvas.
    this.renderer.setRenderTarget(this.fxaaEnabled ? this.aaTarget : null);
    this.renderer.render(this.blitScene, this.blitCamera);

    // Pass 3: FXAA — smooth sub-pixel edges on EdgePass output → canvas.
    if (this.fxaaEnabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.fxaaScene, this.blitCamera);
    }

    // Pass 4: hitbox debug overlay — rendered directly to canvas, bypassing
    // the pixel-art, edge-detection, and FXAA passes so the lines stay crisp.
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

  /** Register item template definitions so the renderer can resolve weapon model IDs from item types. */
  setItemTemplates(templates: ItemTemplate[]): void {
    this.itemTemplateMap.clear();
    for (const t of templates) this.itemTemplateMap.set(t.id, t);
  }

  /**
   * Sync all equipment slots for an entity whose skeleton is already built.
   * Called after skeleton upgrade and on every equipment delta.
   * Each slot exits early when its model ID hasn't changed.
   */
  private syncEquipment(mesh: EntityMeshGroup, state: EntityState): void {
    if (!mesh.boneGroups || !this.content) return;

    const eq = state.equipment;
    const entityScale = state.modelRef
      ? { x: state.modelRef.scaleX, y: state.modelRef.scaleY, z: state.modelRef.scaleZ }
      : { x: 0.35, y: 0.35, z: 0.35 };

    // ── Weapon (main_hand): entity-root anchor, repositioned per-frame ──────
    this.syncHandSlot(mesh, "main_hand", eq?.weapon?.itemType ?? null, entityScale);

    // ── Off-hand: entity-root anchor, follows hand_l bone per-frame ──────────
    this.syncHandSlot(mesh, "off_hand", eq?.offHand?.itemType ?? null, entityScale);

    // ── Armor: bone-parented anchors at the sub-object transform ─────────────
    for (const [equipSlot, renderSlots] of Object.entries(VoximRenderer.ARMOR_SLOTS)) {
      const itemType = (eq as Record<string, { itemType: string } | null> | undefined)?.[equipSlot]?.itemType ?? null;
      const template = itemType ? this.itemTemplateMap.get(itemType) : null;
      const modelId  = template?.modelTemplateId ?? null;
      for (const { renderSlotId, boneId } of renderSlots) {
        this.syncArmorSlot(mesh, renderSlotId, boneId, modelId, entityScale);
      }
    }
  }

  /**
   * Sync a single entity-root attachment slot (weapon or off-hand).
   * The anchor is positioned per-frame by updateAttachmentPositions.
   */
  private syncHandSlot(
    mesh: EntityMeshGroup,
    slotId: string,
    itemType: string | null,
    entityScale: { x: number; y: number; z: number },
  ): void {
    const template = itemType ? this.itemTemplateMap.get(itemType) : null;
    const modelId  = template?.modelTemplateId ?? null;

    const existing = mesh.attachments.get(slotId);
    if (modelId === (existing?.modelId ?? null)) return;

    detachModelFromSlot(mesh, slotId);
    if (!modelId) return;

    const pendingSlot = ensureAttachment(mesh, slotId);
    pendingSlot.modelId = modelId;   // reserve to prevent races

    this.content!.prefetchModel(modelId).then(() => {
      const currentSlot = mesh.attachments.get(slotId);
      if (currentSlot?.modelId !== modelId || !mesh.boneGroups) return;
      const def = this.content!.getModelSync(modelId);
      if (!def) { if (currentSlot) currentSlot.modelId = null; return; }

      const mats = new Map<number, MaterialDef>();
      for (const id of def.materials) {
        const m = this.content!.getMaterialSync(id);
        if (m) mats.set(id, m);
      }
      attachModelToSlot(mesh, slotId, def, mats, entityScale);
    }).catch(() => {
      const currentSlot = mesh.attachments.get(slotId);
      if (currentSlot?.modelId === modelId) currentSlot.modelId = null;
    });
  }

  /**
   * Sync a single bone-parented armor slot.
   *
   * The anchor is parented to the bone group and positioned at the sub-object
   * transform recorded in mesh.boneSlotTransforms so the armor voxels overlay
   * the body-part voxels exactly.  polygonOffset (onTop=true) prevents z-fighting.
   */
  private syncArmorSlot(
    mesh: EntityMeshGroup,
    renderSlotId: string,
    boneId: string,
    modelId: string | null,
    entityScale: { x: number; y: number; z: number },
  ): void {
    const existing = mesh.attachments.get(renderSlotId);
    if (modelId === (existing?.modelId ?? null)) return;

    detachModelFromSlot(mesh, renderSlotId);
    if (!modelId) return;

    const boneGroup = mesh.boneGroups!.get(boneId);
    if (!boneGroup) return; // bone not present on this skeleton

    // Look up the sub-object transform for this bone so the armor aligns with it.
    const subInfo = mesh.boneSlotTransforms.get(boneId);
    const pendingSlot = ensureBoneAttachment(
      mesh, renderSlotId, boneGroup,
      subInfo?.x ?? 0, subInfo?.y ?? 0, subInfo?.z ?? 0,
      entityScale,
      subInfo?.scale ?? 1,
    );
    pendingSlot.modelId = modelId;  // reserve

    this.content!.prefetchModel(modelId).then(() => {
      const currentSlot = mesh.attachments.get(renderSlotId);
      if (currentSlot?.modelId !== modelId || !mesh.boneGroups) return;
      const def = this.content!.getModelSync(modelId);
      if (!def) { if (currentSlot) currentSlot.modelId = null; return; }

      const mats = new Map<number, MaterialDef>();
      for (const id of def.materials) {
        const m = this.content!.getMaterialSync(id);
        if (m) mats.set(id, m);
      }
      attachArmorToSlot(mesh, renderSlotId, def, mats, entityScale);
    }).catch(() => {
      const currentSlot = mesh.attachments.get(renderSlotId);
      if (currentSlot?.modelId === modelId) currentSlot.modelId = null;
    });
  }

  /**
   * Position each entity's attachment slot anchors for the current frame.
  /**
   * "main_hand" — during an attack the anchor is placed at the hilt position
   * derived from the swing-path keyframes (same data the server uses for hit
   * detection).  At all other times it follows the hand_r bone so the weapon
   * sits naturally in the hand during locomotion.
   *
   * Future slots ("off_hand", "back", "belt", …) simply follow their
   * designated rest bone; add entries to SLOT_REST_BONE to enable them.
   */
  private updateAttachmentPositions(
    mesh: EntityMeshGroup,
    anim: AnimationStateData | null,
    weaponAction: WeaponActionDef | undefined,
    t: number,
  ): void {
    if (!mesh.attachments.size) return;

    // Compute entity world matrix once before the loop (needed for world→local).
    mesh.group.updateWorldMatrix(true, true);
    const _entityWorldQuat = new THREE.Quaternion();
    mesh.group.getWorldQuaternion(_entityWorldQuat);
    const _entityWorldQuatInv = _entityWorldQuat.clone().invert();

    for (const [slotId, slot] of mesh.attachments) {
      // Bone-parented slots inherit their bone's transform automatically through
      // the Three.js scene hierarchy — no per-frame work needed.
      if (slot.boneParented) continue;

      if (slotId === "main_hand") {
        if (anim?.weaponActionId && weaponAction?.swingPath?.keyframes?.length) {
          // Authoritative hilt position + blade orientation from swing path.
          // Same source as server hit detection — weapon model is visually exact.
          const bladeLength = weaponAction.swingPath.defaultBladeLength ?? 1.0;
          const s = evaluateWeaponSlice(
            weaponAction.swingPath.keyframes, t, bladeLength,
          );
          slot.anchor.position.set(s.hiltX, s.hiltY, s.hiltZ);
          // Orient anchor so its +Y axis (= blade direction in model space,
          // Three.js local +Y) points from hilt toward tip.
          // setFromUnitVectors(+Y, dir_to_tip) is exact — no gimbal issues.
          _bladeTip.set(s.tipX, s.tipY, s.tipZ);
          _attachTmp.subVectors(_bladeTip, slot.anchor.position).normalize();
          slot.anchor.quaternion.setFromUnitVectors(_bladeUp, _attachTmp);
        } else {
          // Follow hand_r: copy its world transform (position + rotation)
          // into the anchor so the weapon sits naturally in the hand.
          const handBone = mesh.boneGroups?.get("hand_r");
          if (handBone) {
            handBone.getWorldPosition(_attachTmp);
            mesh.group.worldToLocal(_attachTmp);
            slot.anchor.position.copy(_attachTmp);
            handBone.getWorldQuaternion(_attachQuat);
            _attachQuat.premultiply(_entityWorldQuatInv);
            slot.anchor.quaternion.copy(_attachQuat);
          }
        }
      } else {
        // Generic rest-bone follow — copies both position AND rotation so held
        // items (e.g. off-hand shield) animate naturally with the limb.
        const restBoneId = VoximRenderer.SLOT_REST_BONE[slotId];
        if (restBoneId) {
          const bone = mesh.boneGroups?.get(restBoneId);
          if (bone) {
            bone.getWorldPosition(_attachTmp);
            mesh.group.worldToLocal(_attachTmp);
            slot.anchor.position.copy(_attachTmp);
            bone.getWorldQuaternion(_attachQuat);
            _attachQuat.premultiply(_entityWorldQuatInv);
            slot.anchor.quaternion.copy(_attachQuat);
          }
        }
      }
    }
  }

  /**
   * Append a weapon trail slice for each entity currently in the active attack phase,
   * decay existing slices, and rebuild ribbon meshes.
   * Called once per render frame before the scene draw.
   */
  private updateWeaponTrails(now: number): void {
    const ppu = globalThis.innerHeight / 40; // pixels per world unit (approx)

    for (const [entityId, mesh] of this.entityMeshes) {
      const anim = mesh.animationState;
      if (!anim || !anim.weaponActionId) {
        // Decay-only: let existing trail finish fading even after attack ends
        const slices = this.trailSlices.get(entityId);
        if (slices && slices.length > 0) {
          for (const s of slices) s.alpha -= 0.04;
          this.trailSlices.set(entityId, slices.filter((s) => s.alpha > 0));
          this.rebuildTrailMesh(entityId, ppu);
        }
        continue;
      }

      const weaponAction = this.weaponActionsMap.get(anim.weaponActionId);
      const keyframes = weaponAction?.swingPath?.keyframes;
      const elapsed = (now - mesh.lastAnimUpdateMs) / 50;
      const total = weaponAction
        ? weaponAction.windupTicks + weaponAction.activeTicks + weaponAction.winddownTicks
        : 0;
      const ticks = Math.min(anim.ticksIntoAction + elapsed, total);
      const inActive = weaponAction
        ? ticks >= weaponAction.windupTicks && ticks < weaponAction.windupTicks + weaponAction.activeTicks
        : false;

      let slices = this.trailSlices.get(entityId) ?? [];

      if (inActive && keyframes && keyframes.length > 0) {
        const t = total > 0 ? ticks / total : 0;
        const local = evaluateWeaponSlice(keyframes, t, weaponAction?.swingPath?.defaultBladeLength ?? 1.0);

        // Force matrix recompute so we get current-frame position, not last frame's.
        // (updateWeaponTrails runs before renderer.render which would normally do this.)
        mesh.group.updateWorldMatrix(true, false);

        // Build the ribbon from the tip trajectory with a fixed vertical extent
        // so the trail is visible from the isometric camera. Using hilt↔tip
        // produces a horizontal sheet that looks flat from above.
        const TRAIL_HALF_HEIGHT = 0.35;
        const localTip = new THREE.Vector3(local.tipX, local.tipY, local.tipZ);
        const worldTip = localTip.applyMatrix4(mesh.group.matrixWorld);

        const top    = new THREE.Vector3(worldTip.x, worldTip.y + TRAIL_HALF_HEIGHT, worldTip.z);
        const bottom = new THREE.Vector3(worldTip.x, worldTip.y - TRAIL_HALF_HEIGHT, worldTip.z);

        slices.push({ hilt: bottom, tip: top, alpha: 0.5 });
      }

      // Decay all slices
      for (const s of slices) s.alpha -= 0.04;
      slices = slices.filter((s) => s.alpha > 0);
      this.trailSlices.set(entityId, slices);

      this.rebuildTrailMesh(entityId, ppu);
    }

    // Remove trail meshes for entities no longer tracked
    for (const [entityId] of this.trailMeshes) {
      if (!this.entityMeshes.has(entityId)) {
        this.removeTrailMesh(entityId);
      }
    }
  }

  /** Rebuild the ribbon mesh from the current slice buffer for one entity. */
  private rebuildTrailMesh(entityId: string, _ppu: number): void {
    const slices = this.trailSlices.get(entityId) ?? [];

    if (slices.length < 2) {
      // Remove the visual mesh but keep slices so they can accumulate.
      // (removeTrailMesh would delete the slice data too.)
      const existing = this.trailMeshes.get(entityId);
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        (existing.material as THREE.Material).dispose();
        this.trailMeshes.delete(entityId);
      }
      return;
    }

    const positions: number[] = [];
    const colors:    number[] = [];
    const indices:   number[] = [];

    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      positions.push(s.hilt.x, s.hilt.y, s.hilt.z);
      positions.push(s.tip.x,  s.tip.y,  s.tip.z);
      colors.push(1, 0.35, 0, s.alpha);
      colors.push(1, 0.6,  0, s.alpha * 0.7);
    }

    // Each consecutive pair of slices forms a quad (two triangles)
    for (let i = 0; i < slices.length - 1; i++) {
      const h0 = i * 2,     t0 = i * 2 + 1;
      const h1 = (i+1)*2,   t1 = (i+1)*2 + 1;
      indices.push(h0, t0, h1);
      indices.push(t0, t1, h1);
    }

    let trailMesh = this.trailMeshes.get(entityId);
    if (!trailMesh) {
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      trailMesh = new THREE.Mesh(geo, mat);
      this.scene.add(trailMesh);
      this.trailMeshes.set(entityId, trailMesh);
    }

    const geo = trailMesh.geometry;
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
  }

  private removeTrailMesh(entityId: string): void {
    const mesh = this.trailMeshes.get(entityId);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.trailMeshes.delete(entityId);
    }
    this.trailSlices.delete(entityId);
  }

  private onResize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.left   = -ORTHO_HALF * aspect;
    this.camera.right  =  ORTHO_HALF * aspect;
    this.camera.top    =  ORTHO_HALF;
    this.camera.bottom = -ORTHO_HALF;
    this.camera.updateProjectionMatrix();
    const npw = Math.max(1, w);
    const nph = Math.max(1, h);
    this.pixelTarget.setSize(npw, nph);
    this.heightTarget.setSize(npw, nph);
    this.edgePass.setSize(npw, nph);
    this.aaTarget.setSize(npw, nph);
    this.fxaaPass.setSize(npw, nph);
  }

  dispose(): void {
    this.skeletonOverlay.dispose();
    this.facingOverlay.dispose();
    this.chunkOverlay.dispose();
    this.bladeDebugOverlay.dispose();
    this.hitboxDebugOverlay.dispose();
    this.hitSparkRenderer.dispose();
    this.propPool.dispose();
    this.edgePass.dispose();
    this.fxaaPass.dispose();
    this.pixelTarget.dispose();
    this.heightTarget.dispose();
    this.aaTarget.dispose();
    this.depthBlitMat.dispose();
    this.renderer.dispose();
    for (const [entityId] of this.trailMeshes) this.removeTrailMesh(entityId);
    for (const [, mesh] of this.entityMeshes) disposeEntityMesh(mesh);
    for (const [, mesh] of this.terrainMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}

// ---- helpers ----
