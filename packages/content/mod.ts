/**
 * @voxim/content — content type definitions, content store, file loader.
 * No rendering code. No Three.js. Pure data and types.
 * Depends on: @voxim/engine, @voxim/codecs
 *
 * All game content (materials, models, recipes, prefabs, lore fragments)
 * is declared in packages/content/data/ as JSON files and accessed at runtime
 * via the ContentStore interface. Systems receive a ContentStore by injection
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
  BoneMask,
  AnimationLayer,
  AnimationStateData,
  ItemPart,
  StatContribution,
  ItemSlotDef,
  DerivedItemStats,
  ItemTemplate,
  EquipSlot,
  RecipeInput,
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
  SwingKeyframe,
  WeaponSwingPath,
  IKChainDef,
  BodyPartVolume,
  VerbDef,
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
export { localToWorld, evaluateSwingPath, deriveTip, segSegDistSq, segSegContactPoint } from "./src/sweep_math.ts";

// ---- IK solver (shared server + client) ----
export type { BoneRotation, Quat } from "./src/ik_solver.ts";
export { solveTwoBoneIK, quatFromEulerXYZ, quatMultiply, invertQuat, applyQuat } from "./src/ik_solver.ts";

// ---- Animation layer evaluator (shared server + client) ----
export { evaluateAnimationLayers, buildClipIndex, buildMaskIndex } from "./src/animation_eval.ts";

// ---- Skeleton FK solver (shared server + client) ----
export type { BoneTransform } from "./src/skeleton_solver.ts";
export { solveSkeleton, REST_POSE } from "./src/skeleton_solver.ts";

// ---- ModelRef ECS component ----
export { ModelRef } from "./src/component.ts";

// ---- content store ----
export type { ContentStore } from "./src/store.ts";
export { StaticContentStore, resolveSubObjects, resolveMorphParams } from "./src/store.ts";

// ---- file loader (Deno server-side) ----
export { loadContentStore } from "./src/loader.ts";

// ---- static aggregations (used by the browser client bundle) ----
export { weapon_actions } from "./src/weapon_actions_static.ts";
export { item_templates } from "./src/item_templates_static.ts";
