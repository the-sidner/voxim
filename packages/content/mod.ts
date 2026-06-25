/**
 * @voxim/content — content type definitions, content store, file loader.
 * No rendering code. No Three.js. Pure data and types.
 * Depends on: @voxim/engine, @voxim/codecs
 *
 * All game content (materials, models, recipes, prefabs, lore fragments)
 * is declared in packages/content/data/ as JSON files and accessed at runtime
 * via the ContentService interface. Systems receive a ContentService by injection
 * rather than importing hardcoded data tables.
 */

// ---- core types ----
export type {
  MaterialId,
  MaterialDef,
  MaterialProperties,
  VoxelNode,
  SubObjectRef,
  ResolvedSubObject,
  Hitbox,
  ModelDefinition,
  ModelRefData,
  BoneDef,
  SkeletonDef,
  AnimationKeyframe,
  AnimationClip,
  AnimationLibrary,
  BoneMask,
  AnimationLayer,
  AnimationStateData,
  ItemPart,
  StatContribution,
  ItemSlotDef,
  DerivedItemStats,
  EquipSlot,
  EquippableData,
  SwingableData,
  ToolData,
  DeployableData,
  PlaceableData,
  EffectSpec,
  IlluminatorData,
  ArmorData,
  MaterialSourceData,
  ComposedData,
  StackableData,
  WeightData,
  RecipeInput,
  RecipeOutput,
  SwingChainEntry,
  Recipe,
  NpcTemplate,
  ResourceNodeYield,
  PrefabResourceNodeData,
  PrefabNpcData,
  PrefabPlayerData,
  Prefab,
  ChildPrefabRef,
  LoreConcept,
  LoreDomain,
  LoreFragment,
  BiomeDef,
  BiomeClassifyRule,
  BiomeMaterialRule,
  ZoneDef,
  ZoneClassifyRule,
  PoiDef,
  PoiType,
  PoiRole,
  ZoneRole,
  PoiFit,
  PoiGate,
  PoiGateOpen,
  PoiGateItem,
  PoiGateMulti,
  PoiGateChoice,
  PoiReward,
  PoiExtraDrop,
  TrinketTheme,
  PoiActivity,
  PoiActivityEncounter,
  PoiActivityBossfight,
  PoiActivityWave,
  PoiActivityWaveEntry,
  PoiActivityPuzzle,
  PoiActivityAction,
  PoiActivityExploration,
  BehaviorTreeSpec,
  WeaponActionDef,
  WeaponBladeDef,
  IKChainDef,
  BodyPartVolume,
  ActionDef,
  ActionPhase,
  ActionCancelRule,
  ActionEffect,
  ActionAnimation,
  ActionMovement,
  ActionGate,
  ResourceDef,
  ResourceRateModifierRef,
  ResourceThreshold,
  ProcModelDef,
  ScatterDef,
  GameConfig,
  Palette,
  PalettePhase,
  TileLayout,
  TileEntityConfig,
  TileTraderListing,
} from "./src/types.ts";
export { snapColorToRamp, hexStrToNum } from "./src/palette_snap.ts";
export type { VoxelAtom } from "./src/voxel.ts";

// ---- hitbox derivation and application ----
export type { HitboxPartTemplate, HitboxContentAdapter } from "./src/hitbox_derive.ts";
export { deriveHitboxTemplate, applyHitboxTemplate } from "./src/hitbox_derive.ts";

// ---- sweep math (shared server + client) ----
export type { Vec3 } from "./src/sweep_math.ts";
export { localToWorld, segSegDistSq, segSegContactPoint, segSegContactInfo } from "./src/sweep_math.ts";

// ---- IK solver (shared server + client) ----
export type { BoneRotation, Quat } from "./src/ik_solver.ts";
export { solveTwoBoneIK, quatFromEulerXYZ, quatMultiply, invertQuat, applyQuat } from "./src/ik_solver.ts";

// ---- Animation layer evaluator (shared server + client) ----
export { evaluateAnimationLayers, buildClipIndex, buildMaskIndex, sampleTrack } from "./src/animation_eval.ts";

// ---- Animation library (load-time bake of compound clips, T-178) ----
export type {
  LibraryClipFile, LibraryClipPlain, LibraryClipCompound,
  LibraryAdditiveClip, LibraryCrossfadeClip, LibraryPhaseShiftClip,
} from "./src/anim_library.ts";
export { buildAnimationLibrary } from "./src/anim_library.ts";

// ---- Skeleton FK solver (shared server + client) ----
export type { BoneTransform } from "./src/skeleton_solver.ts";
export { solveSkeleton, REST_POSE } from "./src/skeleton_solver.ts";

// ---- Procedural pose catalogue: locomotion + swing (inspector + client) ----
export type { SwingSample, SwingPoseParams, LocoState, LocoPoseParams } from "./src/swing_pose.ts";
export { sampleSwingPath, solveSwingPose, applyLocomotionPose } from "./src/swing_pose.ts";

// ---- ModelRef ECS component ----
export { ModelRef } from "./src/component.ts";

// ---- content store ----
export type { ContentService } from "./src/store.ts";
export { StaticContentStore, resolveSubObjects, resolveMorphParams, makePrng } from "./src/store.ts";

// ---- generic content registry primitive (T-174) ----
// Building block for the federated ContentService (T-175). Replaces the
// pattern of `private foos = new Map<string, FooDef>()` plus per-type
// accessor methods accumulated on ContentService. Consumers should be
// typed against ContentRegistryReadonly<T> so engines never mutate the
// registry after load.
export type { ContentRegistryReadonly, ContentRegistryOptions, Tagged } from "./src/registry.ts";
export { ContentRegistry } from "./src/registry.ts";

// ---- POI schema validation (T-206) ----
export { parsePoiDef } from "./src/poi_schema.ts";

// ---- recipe graph (reverse index for crafting planner) ----
export type { RecipeGraph } from "./src/recipe_graph.ts";
export { buildRecipeGraph } from "./src/recipe_graph.ts";

// ---- recipe stat formula DSL ----
export type { FormulaNode, ParsedFormula, FormulaScope } from "./src/formula.ts";
export { parseFormula, evalFormula, checkVars } from "./src/formula.ts";

// (T-228: the Character State Machine — compiler, expression DSL, and
// StateMachineDef — was deleted. Behavior is the action runtime.)

// ---- recipe-graph validator (server boot) ----
export { validateRecipeGraph } from "./src/recipe_validator.ts";

// ---- content sources (JSON on disk for server, bootstrap blob for client) ----
export { JsonSource } from "./src/loader.ts";
export { BootstrapSource, encodeBootstrap, decodeBootstrap, BOOTSTRAP_VERSION } from "./src/bootstrap_codec.ts";

