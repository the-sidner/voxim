/**
 * ContentStore — interface and in-memory implementation.
 *
 * All game content (materials, models, recipes, prefabs, lore, item templates)
 * is accessed through this interface.  The server populates it at startup by
 * reading the JSON data files via loadContentStore().  The future client will
 * have a NetworkContentStore that fetches definitions via WebTransport on demand.
 *
 * Systems receive the ContentStore by injection — they never import hardcoded
 * data tables directly.
 */
import type {
  MaterialId,
  MaterialDef,
  MaterialProperties,
  ModelDefinition,
  Hitbox,
  SubObjectRef,
  ResolvedSubObject,
  SkeletonDef,
  BoneDef,
  ItemPart,
  ItemTemplate,
  DerivedItemStats,
  StatContribution,
  Recipe,
  NpcTemplate,
  BehaviorTreeSpec,
  BiomeDef,
  ZoneDef,
  LoreFragment,
  Prefab,
  ConceptVerbEntry,
  SkillVerb,
  LoreConcept,
  GameConfig,
  TileLayout,
  WeaponActionDef,
  VerbDef,
} from "./types.ts";
import type { HitboxPartTemplate } from "./hitbox_derive.ts";
import { deriveHitboxTemplate } from "./hitbox_derive.ts";
import type { AnimationClip, BoneMask } from "./types.ts";
import { buildClipIndex, buildMaskIndex } from "./animation_eval.ts";

export interface ContentStore {
  // ---- materials ----
  getMaterial(id: MaterialId): MaterialDef | null;
  getMaterialByName(name: string): MaterialDef | null;
  getAllMaterials(): MaterialDef[];

  // ---- models ----
  getModel(id: string): ModelDefinition | null;
  /**
   * AABB derived from the model's VoxelNode positions at registration time.
   * Computed once and cached — never re-derived at runtime.
   * Returns null for unknown model IDs or models with no nodes.
   */
  getModelAabb(id: string): Hitbox | null;

  // ---- skeletons ----
  getSkeleton(id: string): SkeletonDef | null;

  // ---- item templates ----
  getItemTemplate(id: string): ItemTemplate | null;
  getAllItemTemplates(): readonly ItemTemplate[];
  /**
   * Derive the full stat block for a specific item instance.
   * Combines the template's baseStats with material property contributions
   * from each part.  Returns baseStats only when parts is empty/undefined.
   */
  deriveItemStats(templateId: string, parts?: ItemPart[]): DerivedItemStats;

  // ---- recipes ----
  getRecipe(id: string): Recipe | null;
  getAllRecipes(): readonly Recipe[];
  /** First recipe whose inputs are fully covered by the given inventory map. */
  findCraftableRecipe(inventory: Map<string, number>): Recipe | null;

  // ---- NPC templates ----
  getNpcTemplate(id: string): NpcTemplate | null;
  getAllNpcTemplates(): readonly NpcTemplate[];

  // ---- behavior trees ----
  getBehaviorTree(id: string): BehaviorTreeSpec | null;
  getAllBehaviorTrees(): readonly BehaviorTreeSpec[];

  // ---- biomes ----
  /** All biomes, pre-sorted by ascending priority. */
  getAllBiomes(): readonly BiomeDef[];
  getBiome(id: string): BiomeDef | null;

  // ---- zones ----
  /** All zones, pre-sorted by ascending priority. */
  getAllZones(): readonly ZoneDef[];
  getZone(id: string): ZoneDef | null;

  // ---- prefabs ----
  getPrefab(id: string): Prefab | null;
  getAllPrefabs(): readonly Prefab[];

  // ---- lore fragments ----
  getLoreFragment(id: string): LoreFragment | null;
  getAllLoreFragments(): readonly LoreFragment[];

  // ---- concept-verb matrix ----
  getConceptVerbEntry(verb: SkillVerb, outward: LoreConcept, inward: LoreConcept): ConceptVerbEntry | null;
  getAllConceptVerbEntries(): readonly ConceptVerbEntry[];

  // ---- weapon actions ----
  getWeaponAction(id: string): WeaponActionDef | null;
  getAllWeaponActions(): readonly WeaponActionDef[];

  // ---- skeleton lookup by model ----
  /** Returns the SkeletonDef associated with the given model ID, or null if none. */
  getSkeletonForModel(modelId: string): SkeletonDef | null;

  /**
   * Returns a cached bone index (Map<boneId, BoneDef>) for the given skeleton.
   * Built once per skeleton type and reused — avoids per-tick linear searches in solveSkeleton.
   */
  getBoneIndex(skeletonId: string): ReadonlyMap<string, BoneDef>;

  /**
   * Returns the cached hitbox template for a (modelId, seed, scale) combination.
   * Derived once and reused — the template does not depend on live animation state.
   */
  getHitboxTemplate(modelId: string, seed: number, scale: number): HitboxPartTemplate[];

  /**
   * Returns a pre-built clip lookup map (clipId → AnimationClip) for a skeleton.
   * Built once per skeleton type and reused — avoids linear searches in evaluateAnimationLayers.
   */
  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip>;

  /**
   * Returns a pre-built bone mask lookup map (maskId → BoneMask) for a skeleton.
   * Built once per skeleton type and reused.
   */
  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask>;

  // ---- verbs ----
  getVerbDef(id: SkillVerb): VerbDef | null;

  // ---- game config ----
  getGameConfig(): GameConfig;

  // ---- tile layout ----
  getTileLayout(): TileLayout | null;
}

export class StaticContentStore implements ContentStore {
  private materials = new Map<MaterialId, MaterialDef>();
  private materialsByName = new Map<string, MaterialDef>();
  private models = new Map<string, ModelDefinition>();
  private skeletons = new Map<string, SkeletonDef>();
  private itemTemplates = new Map<string, ItemTemplate>();
  private recipes = new Map<string, Recipe>();
  private npcTemplates = new Map<string, NpcTemplate>();
  private behaviorTrees = new Map<string, BehaviorTreeSpec>();
  private biomes = new Map<string, BiomeDef>();
  private biomesByPriority: BiomeDef[] = [];
  private zones = new Map<string, ZoneDef>();
  private zonesByPriority: ZoneDef[] = [];
  private prefabs = new Map<string, Prefab>();
  private loreFragments = new Map<string, LoreFragment>();
  private conceptVerbEntries = new Map<string, ConceptVerbEntry>();
  private weaponActions = new Map<string, WeaponActionDef>();
  private verbDefs = new Map<SkillVerb, VerbDef>();
  private gameConfig: GameConfig | null = null;
  private tileLayout: TileLayout | null = null;

  // ---- derived caches ----
  /** Per-model AABB derived from VoxelNode positions at registerModel() time. */
  private aabbCache = new Map<string, Hitbox>();
  /** One entry per skeleton type (skeletonId → Map<boneId, BoneDef>). */
  private boneIndexCache = new Map<string, ReadonlyMap<string, BoneDef>>();
  /** One entry per (modelId:seed:scale) combination. */
  private hitboxTemplateCache = new Map<string, HitboxPartTemplate[]>();
  /** One entry per skeleton type (skeletonId → Map<clipId, AnimationClip>). */
  private clipIndexCache = new Map<string, ReadonlyMap<string, AnimationClip>>();
  /** One entry per skeleton type (skeletonId → Map<maskId, BoneMask>). */
  private maskIndexCache = new Map<string, ReadonlyMap<string, BoneMask>>();

  // ---- registration ----

  registerMaterial(def: MaterialDef): void {
    this.materials.set(def.id, def);
    this.materialsByName.set(def.name, def);
  }

  registerModel(def: ModelDefinition): void {
    this.models.set(def.id, def);
    // Derive and cache AABB from voxel positions once, at registration time.
    if (def.nodes.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const n of def.nodes) {
        if (n.x < minX) minX = n.x; if (n.x + 1 > maxX) maxX = n.x + 1;
        if (n.y < minY) minY = n.y; if (n.y + 1 > maxY) maxY = n.y + 1;
        if (n.z < minZ) minZ = n.z; if (n.z + 1 > maxZ) maxZ = n.z + 1;
      }
      this.aabbCache.set(def.id, { minX, minY, minZ, maxX, maxY, maxZ });
    }
  }

  registerSkeleton(def: SkeletonDef): void {
    this.skeletons.set(def.id, def);
  }

  registerItemTemplate(template: ItemTemplate): void {
    this.itemTemplates.set(template.id, template);
  }

  registerRecipe(recipe: Recipe): void {
    this.recipes.set(recipe.id, recipe);
  }

  registerNpcTemplate(template: NpcTemplate): void {
    this.npcTemplates.set(template.id, template);
  }

  registerBehaviorTree(spec: BehaviorTreeSpec): void {
    this.behaviorTrees.set(spec.id, spec);
  }

  registerBiome(def: BiomeDef): void {
    this.biomes.set(def.id, def);
    this.biomesByPriority.push(def);
    this.biomesByPriority.sort((a, b) => a.priority - b.priority);
  }

  registerZone(def: ZoneDef): void {
    this.zones.set(def.id, def);
    this.zonesByPriority.push(def);
    this.zonesByPriority.sort((a, b) => a.priority - b.priority);
  }

  registerPrefab(prefab: Prefab): void {
    this.prefabs.set(prefab.id, prefab);
  }

  registerLoreFragment(fragment: LoreFragment): void {
    this.loreFragments.set(fragment.id, fragment);
  }

  registerConceptVerbEntry(entry: ConceptVerbEntry): void {
    this.conceptVerbEntries.set(`${entry.verb}:${entry.outwardConcept}:${entry.inwardConcept}`, entry);
  }

  registerWeaponAction(def: WeaponActionDef): void {
    this.weaponActions.set(def.id, def);
  }

  registerVerbDef(def: VerbDef): void {
    this.verbDefs.set(def.id, def);
  }

  setGameConfig(config: GameConfig): void {
    this.gameConfig = config;
  }

  setTileLayout(layout: TileLayout): void {
    this.tileLayout = layout;
  }

  // ---- ContentStore impl — materials ----

  getMaterial(id: MaterialId): MaterialDef | null {
    return this.materials.get(id) ?? null;
  }

  getMaterialByName(name: string): MaterialDef | null {
    return this.materialsByName.get(name) ?? null;
  }

  getAllMaterials(): MaterialDef[] {
    return Array.from(this.materials.values());
  }

  // ---- models ----

  getModel(id: string): ModelDefinition | null {
    return this.models.get(id) ?? null;
  }

  getModelAabb(id: string): Hitbox | null {
    return this.aabbCache.get(id) ?? null;
  }

  // ---- skeletons ----

  getSkeleton(id: string): SkeletonDef | null {
    return this.skeletons.get(id) ?? null;
  }

  // ---- item templates ----

  getItemTemplate(id: string): ItemTemplate | null {
    return this.itemTemplates.get(id) ?? null;
  }

  getAllItemTemplates(): readonly ItemTemplate[] {
    return Array.from(this.itemTemplates.values());
  }

  deriveItemStats(templateId: string, parts?: ItemPart[]): DerivedItemStats {
    const template = this.getItemTemplate(templateId);
    if (!template) return { weight: 1 };

    // Start from base stats
    const stats: DerivedItemStats = {
      weight: template.weight,
      ...template.baseStats,
    };

    // Preserve non-numeric/non-accumulating fields from the template
    if (template.toolType !== undefined) stats.toolType = template.toolType;
    else if (template.baseStats.toolType !== undefined) stats.toolType = template.baseStats.toolType;
    if (template.weaponAction !== undefined) stats.weaponAction = template.weaponAction;

    if (!parts || parts.length === 0 || template.slots.length === 0) {
      return stats;
    }

    // Accumulate material property contributions per part
    for (const part of parts) {
      const slotDef = template.slots.find((s) => s.id === part.slot);
      if (!slotDef) continue;

      const material = this.getMaterialByName(part.materialName);
      if (!material) continue;

      for (const contrib of slotDef.statContributions) {
        accumulateStat(stats, contrib, material.properties);
      }
    }

    return stats;
  }

  // ---- recipes ----

  getRecipe(id: string): Recipe | null {
    return this.recipes.get(id) ?? null;
  }

  getAllRecipes(): readonly Recipe[] {
    return Array.from(this.recipes.values());
  }

  findCraftableRecipe(inventory: Map<string, number>): Recipe | null {
    for (const recipe of this.recipes.values()) {
      const ok = recipe.inputs.every((inp) => {
        if ((inventory.get(inp.itemType) ?? 0) >= inp.quantity) return true;
        if (inp.alternates) {
          for (const alt of inp.alternates) {
            if ((inventory.get(alt) ?? 0) >= inp.quantity) return true;
          }
        }
        return false;
      });
      if (ok) return recipe;
    }
    return null;
  }

  // ---- NPC templates ----

  getNpcTemplate(id: string): NpcTemplate | null {
    return this.npcTemplates.get(id) ?? null;
  }

  getAllNpcTemplates(): readonly NpcTemplate[] {
    return Array.from(this.npcTemplates.values());
  }

  // ---- behavior trees ----

  getBehaviorTree(id: string): BehaviorTreeSpec | null {
    return this.behaviorTrees.get(id) ?? null;
  }

  getAllBehaviorTrees(): readonly BehaviorTreeSpec[] {
    return Array.from(this.behaviorTrees.values());
  }

  // ---- biomes ----

  getAllBiomes(): readonly BiomeDef[] {
    return this.biomesByPriority;
  }

  getBiome(id: string): BiomeDef | null {
    return this.biomes.get(id) ?? null;
  }

  // ---- zones ----

  getAllZones(): readonly ZoneDef[] {
    return this.zonesByPriority;
  }

  getZone(id: string): ZoneDef | null {
    return this.zones.get(id) ?? null;
  }

  // ---- prefabs ----

  getPrefab(id: string): Prefab | null {
    return this.prefabs.get(id) ?? null;
  }

  getAllPrefabs(): readonly Prefab[] {
    return Array.from(this.prefabs.values());
  }

  // ---- lore ----

  getLoreFragment(id: string): LoreFragment | null {
    return this.loreFragments.get(id) ?? null;
  }

  getAllLoreFragments(): readonly LoreFragment[] {
    return Array.from(this.loreFragments.values());
  }

  // ---- concept-verb matrix ----

  getConceptVerbEntry(verb: SkillVerb, outward: LoreConcept, inward: LoreConcept): ConceptVerbEntry | null {
    return this.conceptVerbEntries.get(`${verb}:${outward}:${inward}`) ?? null;
  }

  getAllConceptVerbEntries(): readonly ConceptVerbEntry[] {
    return Array.from(this.conceptVerbEntries.values());
  }

  // ---- weapon actions ----

  getWeaponAction(id: string): WeaponActionDef | null {
    return this.weaponActions.get(id) ?? null;
  }

  getAllWeaponActions(): readonly WeaponActionDef[] {
    return Array.from(this.weaponActions.values());
  }

  getSkeletonForModel(modelId: string): SkeletonDef | null {
    const model = this.models.get(modelId);
    if (!model?.skeletonId) return null;
    return this.skeletons.get(model.skeletonId) ?? null;
  }

  getBoneIndex(skeletonId: string): ReadonlyMap<string, BoneDef> {
    let idx = this.boneIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      idx = skeleton ? new Map(skeleton.bones.map((b) => [b.id, b])) : new Map();
      this.boneIndexCache.set(skeletonId, idx);
    }
    return idx;
  }

  getHitboxTemplate(modelId: string, seed: number, scale: number): HitboxPartTemplate[] {
    const key = `${modelId}:${seed}:${scale}`;
    let tmpl = this.hitboxTemplateCache.get(key);
    if (!tmpl) {
      tmpl = deriveHitboxTemplate(modelId, seed, this, scale);
      this.hitboxTemplateCache.set(key, tmpl);
    }
    return tmpl;
  }

  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip> {
    let idx = this.clipIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      idx = skeleton ? buildClipIndex(skeleton) : new Map();
      this.clipIndexCache.set(skeletonId, idx);
    }
    return idx;
  }

  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask> {
    let idx = this.maskIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      idx = skeleton ? buildMaskIndex(skeleton) : new Map();
      this.maskIndexCache.set(skeletonId, idx);
    }
    return idx;
  }

  // ---- verbs ----

  getVerbDef(id: SkillVerb): VerbDef | null {
    return this.verbDefs.get(id) ?? null;
  }

  // ---- game config ----

  getGameConfig(): GameConfig {
    if (!this.gameConfig) throw new Error("GameConfig not loaded");
    return this.gameConfig;
  }

  // ---- tile layout ----

  getTileLayout(): TileLayout | null {
    return this.tileLayout;
  }
}

// ---- procedural model variation ----

/**
 * Tiny seeded PRNG (mulberry32).  Produces values in [0, 1).
 * Same seed always produces the same sequence — deterministic across server and client.
 */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolve a model's subObjects list against a seed, collapsing every pool
 * entry to a single chosen modelId and honouring per-point probabilities.
 *
 * Call this once at mesh-build time (client) or spawn time (server, if the
 * server needs the resolved list).  The same (subObjects, seed) pair always
 * produces the same result, so all clients converge on the same visual.
 *
 * Sub-objects with neither modelId nor pool are skipped.
 */
export function resolveSubObjects(subObjects: SubObjectRef[], seed: number): ResolvedSubObject[] {
  const rand = makePrng(seed);
  const result: ResolvedSubObject[] = [];
  for (const sub of subObjects) {
    const prob = sub.probability ?? 1.0;
    if (prob < 1.0 && rand() >= prob) continue;
    let modelId: string | undefined;
    if (sub.pool && sub.pool.length > 0) {
      modelId = sub.pool[Math.floor(rand() * sub.pool.length)];
    } else {
      modelId = sub.modelId;
    }
    if (!modelId) continue;
    result.push({ modelId, transform: sub.transform, boneId: sub.boneId, materialSlot: sub.materialSlot });
  }
  return result;
}

/**
 * Sample procedural body proportion parameters for a skeleton from a seed.
 *
 * Uses a PRNG stream independent of resolveSubObjects (different seed derivation)
 * so adding or removing sub-object pool entries never shifts morph values.
 *
 * Returns an empty object if the skeleton defines no morphParams.
 * The same (skeleton, seed) pair always produces the same result — deterministic
 * across server (hitbox derivation) and client (mesh building).
 */
export function resolveMorphParams(
  skeleton: import("./types.ts").SkeletonDef,
  seed: number,
): Record<string, number> {
  if (!skeleton.morphParams?.length) return {};
  // XOR with a magic constant to produce a different PRNG stream from resolveSubObjects.
  const rand = makePrng((seed ^ 0xA3C5E7F9) >>> 0);
  const result: Record<string, number> = {};
  for (const param of skeleton.morphParams) {
    result[param.id] = param.min + rand() * (param.max - param.min);
  }
  return result;
}

// ---- helpers ----

/**
 * Apply one StatContribution to the stats object.
 * stat += material.properties[property] * multiplier
 */
function accumulateStat(
  stats: DerivedItemStats,
  contrib: StatContribution,
  props: MaterialProperties,
): void {
  const propValue = props[contrib.property];
  const key = contrib.stat as string;
  if (key === "toolType") return; // string field — not numeric, skip accumulation
  const current = (stats as unknown as Record<string, number | undefined>)[key] ?? 0;
  (stats as unknown as Record<string, number>)[key] = current + propValue * contrib.multiplier;
}
