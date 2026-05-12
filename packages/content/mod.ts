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
  EdibleData,
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
  LoreConcept,
  LoreDomain,
  LoreFragment,
  SkillVerb,
  SkillSlot,
  SkillEffectType,
  ConceptVerbEntry,
  BiomeDef,
  BiomeClassifyRule,
  BiomeMaterialRule,
  ZoneDef,
  ZoneClassifyRule,
  BehaviorTreeSpec,
  WeaponActionDef,
  WeaponBladeDef,
  IKChainDef,
  BodyPartVolume,
  VerbDef,
  SMLayerOutput,
  SMLayerKind,
  SMState,
  SMTransition,
  SMLayer,
  StateMachineDef,
  ManeuverDef,
  ManeuverHandTrack,
  ManeuverLocomotionTrack,
  ManeuverHitEffect,
  ManeuverInterruptWindow,
  ManeuverRequirements,
  GameConfig,
  TileLayout,
  TileEntityConfig,
  TileTraderListing,
} from "./src/types.ts";

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

// ---- ModelRef ECS component ----
export { ModelRef } from "./src/component.ts";

// ---- content store ----
export type { ContentService } from "./src/store.ts";
export { StaticContentStore, resolveSubObjects, resolveMorphParams } from "./src/store.ts";

// ---- generic content registry primitive (T-174) ----
// Building block for the federated ContentService (T-175). Replaces the
// pattern of `private foos = new Map<string, FooDef>()` plus per-type
// accessor methods accumulated on ContentService. Consumers should be
// typed against ContentRegistryReadonly<T> so engines never mutate the
// registry after load.
export type { ContentRegistryReadonly, ContentRegistryOptions, Tagged } from "./src/registry.ts";
export { ContentRegistry } from "./src/registry.ts";

// ---- recipe graph (reverse index for crafting planner) ----
export type { RecipeGraph } from "./src/recipe_graph.ts";
export { buildRecipeGraph } from "./src/recipe_graph.ts";

// ---- recipe stat formula DSL ----
export type { FormulaNode, ParsedFormula, FormulaScope } from "./src/formula.ts";
export { parseFormula, evalFormula, checkVars } from "./src/formula.ts";

// ---- character state machine (T-182) ----
export type { SMExprNode, ParsedSMExpr, SMScope, SMScopeValue } from "./src/sm_expression.ts";
export { parseSMExpr, evalSMExpr, evalSMExprBool, checkSMVars } from "./src/sm_expression.ts";
export type {
  CompiledStateMachine,
  SMLayerState,
  SMRuntimeState,
  SMTransitionFired,
} from "./src/state_machine.ts";
export {
  compileStateMachine,
  initialSMState,
  smTickAll,
  buildCsmVars,
  effectiveState,
  resolveDuration,
  stateHasTag,
  defStateHasTag,
  validateStateMachineScope,
  collectSlotRefs,
} from "./src/state_machine.ts";

// ---- recipe-graph validator (server boot) ----
export { validateRecipeGraph } from "./src/recipe_validator.ts";

// ---- content sources (JSON on disk for server, bootstrap blob for client) ----
export { JsonSource } from "./src/loader.ts";
export { BootstrapSource, encodeBootstrap, decodeBootstrap, BOOTSTRAP_VERSION } from "./src/bootstrap_codec.ts";

