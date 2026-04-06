/**
 * @voxim/content — content type definitions, content store, file loader.
 * No rendering code. No Three.js. Pure data and types.
 * Depends on: @voxim/engine, @voxim/codecs
 *
 * All game content (materials, models, recipes, structures, lore fragments)
 * is declared in packages/content/data/ as JSON files and accessed at runtime
 * via the ContentStore interface.  Systems receive a ContentStore by injection
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
  AnimationMode,
  AnimationStateData,
  ItemPart,
  StatContribution,
  ItemSlotDef,
  DerivedItemStats,
  ItemTemplate,
  RecipeInput,
  Recipe,
  StructureMaterial,
  StructureDef,
  NpcTemplate,
  ResourceNodeYield,
  ResourceNodeTemplate,
  LoreConcept,
  LoreDomain,
  LoreFragment,
  SkillVerb,
  SkillSlot,
  SkillEffectType,
  SkillEffectStat,
  ConceptVerbEntry,
  WeaponActionDef,
  WeaponHitbox,
  VerbDef,
  GameConfig,
  TileLayout,
  TileNodeConfig,
  TileNpcConfig,
  TileTraderListing,
} from "./src/types.ts";

// ---- ModelRef ECS component ----
export { ModelRef } from "./src/component.ts";

// ---- content store ----
export type { ContentStore } from "./src/store.ts";
export { StaticContentStore, resolveSubObjects } from "./src/store.ts";

// ---- file loader (Deno server-side) ----
export { loadContentStore } from "./src/loader.ts";
