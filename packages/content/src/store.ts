/**
 * ContentService — interface and in-memory implementation.
 *
 * All game content (materials, models, recipes, prefabs, lore, item templates)
 * is accessed through this interface.  The server populates it at startup by
 * reading the JSON data files via loadContentStore().  The future client will
 * have a NetworkContentStore that fetches definitions via WebTransport on demand.
 *
 * Systems receive the ContentService by injection — they never import hardcoded
 * data tables directly.
 *
 * # Federated registry shape (T-175)
 *
 * The primary access pattern is **typed registries** exposed as readonly fields:
 *
 *   content.prefabs.getOrThrow(id)   — single-item lookup
 *   content.materials.byTag("metal") — tag-indexed query
 *   content.skeletons.values()       — iteration
 *
 * Specialized lookups (`getMaterialById`, `getPrefabsByCategory`,
 * `getBiomesByPriority`, the derived caches `getBoneIndex` /
 * `getHitboxTemplate` / `getClipIndex` / `getMaskIndex` / `getRecipeGraph`,
 * and the singletons `getGameConfig` / `getTileLayout`) remain as named
 * methods. Generic id-lookups go through the registries.
 */
import type {
  MaterialId,
  MaterialDef,
  ModelDefinition,
  Hitbox,
  SubObjectRef,
  ResolvedSubObject,
  SkeletonDef,
  BoneDef,
  AnimationLibrary,
  ItemPart,
  DerivedItemStats,
  Recipe,
  NpcTemplate,
  BehaviorTreeSpec,
  BiomeDef,
  ZoneDef,
  PoiDef,
  PoiRole,
  LoreFragment,
  Prefab,
  ConceptVerbEntry,
  SkillVerb,
  LoreConcept,
  GameConfig,
  TileLayout,
  WeaponActionDef,
  VerbDef,
  StateMachineDef,
  ManeuverDef,
  BuffDef,
} from "./types.ts";
import type { HitboxContentAdapter, HitboxPartTemplate } from "./hitbox_derive.ts";
import { deriveHitboxTemplate } from "./hitbox_derive.ts";
import type { AnimationClip, BoneMask } from "./types.ts";
import { buildClipIndex, buildMaskIndex } from "./animation_eval.ts";
import type { RecipeGraph } from "./recipe_graph.ts";
import { buildRecipeGraph } from "./recipe_graph.ts";
import type { ContentRegistryReadonly } from "./registry.ts";
import { ContentRegistry } from "./registry.ts";

export interface ContentService {
  // ---- federated registries (T-175) ----
  // Primary access path. Each registry is read-only post-load.
  // Materials are keyed by string name (the unique craft-system key); the
  // numeric MaterialId is a secondary handle, looked up via getMaterialById().
  readonly materials:       ContentRegistryReadonly<MaterialDef>;
  readonly models:          ContentRegistryReadonly<ModelDefinition>;
  readonly skeletons:       ContentRegistryReadonly<SkeletonDef>;
  readonly prefabs:         ContentRegistryReadonly<Prefab>;
  readonly recipes:         ContentRegistryReadonly<Recipe>;
  readonly npcTemplates:    ContentRegistryReadonly<NpcTemplate>;
  readonly behaviorTrees:   ContentRegistryReadonly<BehaviorTreeSpec>;
  readonly biomes:          ContentRegistryReadonly<BiomeDef>;
  readonly zones:           ContentRegistryReadonly<ZoneDef>;
  /**
   * POI definitions (T-206). Authored as one JSON file per POI in
   * `data/pois/`. Consumed by the Tier-6 generator (T-209) when weaving
   * tiles into POI-dependency-DAGs.
   */
  readonly pois:            ContentRegistryReadonly<PoiDef>;
  readonly loreFragments:   ContentRegistryReadonly<LoreFragment>;
  readonly weaponActions:   ContentRegistryReadonly<WeaponActionDef>;
  readonly verbs:           ContentRegistryReadonly<VerbDef>;
  /**
   * Animation libraries keyed by archetype id (T-178). Look up clips via
   * `store.animationLibraries.getOrThrow(skeleton.archetype).clips[clipId]`.
   * Multiple skeletons sharing an archetype share the same library entry.
   */
  readonly animationLibraries: ContentRegistryReadonly<AnimationLibrary>;
  /**
   * Character State Machines keyed by id (T-182). One actor prefab references
   * one via `prefab.stateMachineId`. Animation is one of the layer outputs;
   * gameplay systems also read CSM nodes for mode gating.
   */
  readonly stateMachines: ContentRegistryReadonly<StateMachineDef>;
  /**
   * Maneuvers keyed by id (T-185). Composable per-hand actions — see
   * ManeuverDef. ActionSystem looks up by id when input dispatches a skill
   * slot, ManeuverScheduler advances the timeline.
   */
  readonly maneuvers: ContentRegistryReadonly<ManeuverDef>;
  /**
   * Buffs keyed by id (T-196). Declarative status-effect definitions loaded
   * from `data/buffs/*.json`. `applyBuffById` in tile-server reads the def
   * and dispatches to the registered EffectApplyHandler matching
   * `def.effectStat`. Onboard authoring path for buffs that don't need
   * custom code — adding a new slow / poison / heal-over-time is a file
   * drop, no handler changes.
   */
  readonly buffs: ContentRegistryReadonly<BuffDef>;

  // ---- specialized lookups ----
  /** Resolve a material by its numeric MaterialId (the wire/storage key). */
  getMaterialById(id: MaterialId): MaterialDef | undefined;
  /**
   * AABB derived from the model's VoxelNode positions at registration time.
   * Computed once and cached — never re-derived at runtime.
   */
  getModelAabb(id: string): Hitbox | null;
  /** Returns the SkeletonDef associated with the given model ID, or null. */
  getSkeletonForModel(modelId: string): SkeletonDef | null;
  getConceptVerbEntry(verb: SkillVerb, outward: LoreConcept, inward: LoreConcept): ConceptVerbEntry | null;
  getAllConceptVerbEntries(): readonly ConceptVerbEntry[];
  /**
   * Every prefab whose `category` matches AND whose `tags` is a superset of
   * the requested tag list. Empty `requiredTags` returns all prefabs in the
   * category.
   */
  getPrefabsByCategory(category: string, requiredTags?: readonly string[]): readonly Prefab[];
  /** Biomes pre-sorted by ascending priority. */
  getBiomesByPriority(): readonly BiomeDef[];
  /** Zones pre-sorted by ascending priority. */
  getZonesByPriority(): readonly ZoneDef[];

  /** All POIs whose `roles` list includes the given DAG role. */
  findPoisByRole(role: PoiRole): readonly PoiDef[];
  /** All POIs whose `tags` list includes the given tag (case-sensitive). */
  findPoisByTag(tag: string): readonly PoiDef[];

  // ---- derived caches ----
  deriveItemStats(prefabId: string, parts?: ItemPart[], quality?: number): DerivedItemStats;
  /** Reverse index: producers by item, recipes by workstation, primitive items. */
  getRecipeGraph(): RecipeGraph;
  /** Cached bone index (Map<boneId, BoneDef>) — built once per skeleton type. */
  getBoneIndex(skeletonId: string): ReadonlyMap<string, BoneDef>;
  /** Cached hitbox template per (modelId, seed, scale). */
  getHitboxTemplate(modelId: string, seed: number, scale: number): HitboxPartTemplate[];
  /** Cached clip lookup map (clipId → AnimationClip) per skeleton type. */
  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip>;
  /** Cached bone mask lookup map (maskId → BoneMask) per skeleton type. */
  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask>;

  // ---- singletons ----
  getGameConfig(): GameConfig;
  getTileLayout(): TileLayout | null;
}

export class StaticContentStore implements ContentService {
  // ---- federated registries ----
  // Materials registered by NAME (the craft-system key); numeric id is a
  // secondary index on materialsByNumericId.
  public readonly materials = new ContentRegistry<MaterialDef>({
    kind: "material",
    idOf: (m) => m.name,
  });
  public readonly models = new ContentRegistry<ModelDefinition>({
    kind: "model",
    idOf: (m) => m.id,
  });
  public readonly skeletons = new ContentRegistry<SkeletonDef>({
    kind: "skeleton",
    idOf: (s) => s.id,
  });
  public readonly prefabs = new ContentRegistry<Prefab>({
    kind: "prefab",
    idOf: (p) => p.id,
  });
  public readonly recipes = new ContentRegistry<Recipe>({
    kind: "recipe",
    idOf: (r) => r.id,
  });
  public readonly npcTemplates = new ContentRegistry<NpcTemplate>({
    kind: "npcTemplate",
    idOf: (t) => t.id,
  });
  public readonly behaviorTrees = new ContentRegistry<BehaviorTreeSpec>({
    kind: "behaviorTree",
    idOf: (t) => t.id,
  });
  public readonly biomes = new ContentRegistry<BiomeDef>({
    kind: "biome",
    idOf: (b) => b.id,
  });
  public readonly zones = new ContentRegistry<ZoneDef>({
    kind: "zone",
    idOf: (z) => z.id,
  });
  public readonly pois = new ContentRegistry<PoiDef>({
    kind: "poi",
    idOf: (p) => p.id,
  });
  public readonly loreFragments = new ContentRegistry<LoreFragment>({
    kind: "loreFragment",
    idOf: (f) => f.id,
  });
  public readonly weaponActions = new ContentRegistry<WeaponActionDef>({
    kind: "weaponAction",
    idOf: (w) => w.id,
  });
  public readonly verbs = new ContentRegistry<VerbDef>({
    kind: "verb",
    idOf: (v) => v.id,
  });
  public readonly animationLibraries = new ContentRegistry<AnimationLibrary>({
    kind: "animationLibrary",
    idOf: (lib) => lib.id,
  });
  public readonly stateMachines = new ContentRegistry<StateMachineDef>({
    kind: "stateMachine",
    idOf: (sm) => sm.id,
  });
  public readonly maneuvers = new ContentRegistry<ManeuverDef>({
    kind: "maneuver",
    idOf: (m) => m.id,
  });
  public readonly buffs = new ContentRegistry<BuffDef>({
    kind: "buff",
    idOf: (b) => b.id,
  });

  // ---- secondary indices ----
  private materialsByNumericId = new Map<MaterialId, MaterialDef>();
  private conceptVerbEntries = new Map<string, ConceptVerbEntry>();
  private biomesByPrioritySorted: BiomeDef[] = [];
  private zonesByPrioritySorted: ZoneDef[] = [];
  /** Lazy-built POI indices. `null` = needs rebuild after last register. */
  private poisByRole: Map<PoiRole, PoiDef[]> | null = null;
  private poisByTag:  Map<string,  PoiDef[]> | null = null;
  private categoryIndex: Map<string, Prefab[]> | null = null;
  private modelAabb = new Map<string, Hitbox>();
  /** Cached reverse index. Invalidated on registerRecipe/registerPrefab. */
  private recipeGraph: RecipeGraph | null = null;

  // ---- singletons ----
  private gameConfig: GameConfig | null = null;
  private tileLayout: TileLayout | null = null;

  // ---- derived caches ----
  private boneIndexCache = new Map<string, ReadonlyMap<string, BoneDef>>();
  private hitboxTemplateCache = new Map<string, HitboxPartTemplate[]>();
  private clipIndexCache = new Map<string, ReadonlyMap<string, AnimationClip>>();
  private maskIndexCache = new Map<string, ReadonlyMap<string, BoneMask>>();

  // ---- registration ----

  registerMaterial(def: MaterialDef): void {
    this.materials.register(def);
    this.materialsByNumericId.set(def.id, def);
  }

  registerModel(def: ModelDefinition): void {
    this.models.register(def);
    // Derive and cache AABB from voxel positions once, at registration time.
    if (def.nodes.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const n of def.nodes) {
        if (n.x < minX) minX = n.x; if (n.x + 1 > maxX) maxX = n.x + 1;
        if (n.y < minY) minY = n.y; if (n.y + 1 > maxY) maxY = n.y + 1;
        if (n.z < minZ) minZ = n.z; if (n.z + 1 > maxZ) maxZ = n.z + 1;
      }
      this.modelAabb.set(def.id, { minX, minY, minZ, maxX, maxY, maxZ });
    }
  }

  registerSkeleton(def: SkeletonDef): void {
    this.skeletons.register(def);
  }

  registerRecipe(recipe: Recipe): void {
    this.recipes.register(recipe);
    this.recipeGraph = null;
  }

  registerNpcTemplate(template: NpcTemplate): void {
    this.npcTemplates.register(template);
  }

  registerBehaviorTree(spec: BehaviorTreeSpec): void {
    this.behaviorTrees.register(spec);
  }

  registerBiome(def: BiomeDef): void {
    this.biomes.register(def);
    this.biomesByPrioritySorted.push(def);
    this.biomesByPrioritySorted.sort((a, b) => a.priority - b.priority);
  }

  registerZone(def: ZoneDef): void {
    this.zones.register(def);
    this.zonesByPrioritySorted.push(def);
    this.zonesByPrioritySorted.sort((a, b) => a.priority - b.priority);
  }

  registerPoi(def: PoiDef): void {
    this.pois.register(def);
    // Index by role + tag so the Tier-6 generator's queries are O(1) per
    // lookup. Rebuilt lazily on first access (see findPoisByRole / Tag).
    this.poisByRole = null;
    this.poisByTag  = null;
  }

  registerPrefab(prefab: Prefab): void {
    this.prefabs.register(prefab);
    this.recipeGraph = null;
    this.categoryIndex = null;
  }

  registerLoreFragment(fragment: LoreFragment): void {
    this.loreFragments.register(fragment);
  }

  registerConceptVerbEntry(entry: ConceptVerbEntry): void {
    this.conceptVerbEntries.set(`${entry.verb}:${entry.outwardConcept}:${entry.inwardConcept}`, entry);
  }

  registerWeaponAction(def: WeaponActionDef): void {
    this.weaponActions.register(def);
  }

  registerVerbDef(def: VerbDef): void {
    this.verbs.register(def);
  }

  registerAnimationLibrary(lib: AnimationLibrary): void {
    this.animationLibraries.register(lib);
  }

  registerStateMachine(sm: StateMachineDef): void {
    this.stateMachines.register(sm);
  }

  registerManeuver(def: ManeuverDef): void {
    this.maneuvers.register(def);
  }

  registerBuff(def: BuffDef): void {
    this.buffs.register(def);
  }

  setGameConfig(config: GameConfig): void {
    this.gameConfig = config;
  }

  setTileLayout(layout: TileLayout): void {
    this.tileLayout = layout;
  }

  // ---- specialized lookups ----

  getMaterialById(id: MaterialId): MaterialDef | undefined {
    return this.materialsByNumericId.get(id);
  }

  getModelAabb(id: string): Hitbox | null {
    return this.modelAabb.get(id) ?? null;
  }

  getSkeletonForModel(modelId: string): SkeletonDef | null {
    const model = this.models.get(modelId);
    if (!model?.skeletonId) return null;
    return this.skeletons.get(model.skeletonId) ?? null;
  }

  getConceptVerbEntry(verb: SkillVerb, outward: LoreConcept, inward: LoreConcept): ConceptVerbEntry | null {
    return this.conceptVerbEntries.get(`${verb}:${outward}:${inward}`) ?? null;
  }

  getAllConceptVerbEntries(): readonly ConceptVerbEntry[] {
    return Array.from(this.conceptVerbEntries.values());
  }

  getPrefabsByCategory(category: string, requiredTags: readonly string[] = []): readonly Prefab[] {
    if (this.categoryIndex === null) {
      this.categoryIndex = new Map();
      for (const p of this.prefabs.values()) {
        if (!p.category) continue;
        const bucket = this.categoryIndex.get(p.category);
        if (bucket) bucket.push(p);
        else this.categoryIndex.set(p.category, [p]);
      }
    }
    const all = this.categoryIndex.get(category) ?? [];
    if (requiredTags.length === 0) return all;
    return all.filter((p) => {
      const have = p.tags ?? [];
      for (const t of requiredTags) if (!have.includes(t)) return false;
      return true;
    });
  }

  getBiomesByPriority(): readonly BiomeDef[] {
    return this.biomesByPrioritySorted;
  }

  getZonesByPriority(): readonly ZoneDef[] {
    return this.zonesByPrioritySorted;
  }

  findPoisByRole(role: PoiRole): readonly PoiDef[] {
    if (!this.poisByRole) this.rebuildPoiIndices();
    return this.poisByRole!.get(role) ?? [];
  }

  findPoisByTag(tag: string): readonly PoiDef[] {
    if (!this.poisByTag) this.rebuildPoiIndices();
    return this.poisByTag!.get(tag) ?? [];
  }

  private rebuildPoiIndices(): void {
    this.poisByRole = new Map();
    this.poisByTag  = new Map();
    for (const poi of this.pois.values()) {
      for (const role of poi.roles) {
        const arr = this.poisByRole.get(role) ?? [];
        arr.push(poi);
        this.poisByRole.set(role, arr);
      }
      for (const tag of poi.tags) {
        const arr = this.poisByTag.get(tag) ?? [];
        arr.push(poi);
        this.poisByTag.set(tag, arr);
      }
    }
  }

  // ---- derived ----

  deriveItemStats(prefabId: string, _parts?: ItemPart[], quality = 1): DerivedItemStats {
    const prefab = this.prefabs.get(prefabId);
    if (!prefab) return { weight: 1 };

    const c = prefab.components;
    const weight = c["weight"] as { baseWeight?: number } | undefined;
    const armor = c["armor"] as { reduction?: number; staminaPenalty?: number } | undefined;
    const edible = c["edible"] as { food?: number; water?: number } | undefined;
    const illuminator = c["illuminator"] as { radius?: number; color?: number; intensity?: number; flicker?: number } | undefined;
    const tool = c["tool"] as { toolType?: string } | undefined;
    const swingable = c["swingable"] as { damage?: number } | undefined;

    const stats: DerivedItemStats = { weight: weight?.baseWeight ?? 1 };
    if (armor?.reduction !== undefined) stats.armorReduction = armor.reduction * quality;
    if (armor?.staminaPenalty !== undefined) stats.staminaRegenPenalty = armor.staminaPenalty;
    if (edible?.food !== undefined) stats.foodValue = edible.food * quality;
    if (edible?.water !== undefined) stats.waterValue = edible.water * quality;
    if (illuminator?.intensity) {
      stats.lightRadius = illuminator.radius;
      stats.lightColor = illuminator.color;
      stats.lightIntensity = illuminator.intensity * quality;
      stats.lightFlicker = illuminator.flicker;
    }
    if (tool?.toolType) stats.toolType = tool.toolType;
    if (swingable?.damage !== undefined) stats.damage = swingable.damage * quality;

    return stats;
  }

  getRecipeGraph(): RecipeGraph {
    if (!this.recipeGraph) {
      this.recipeGraph = buildRecipeGraph(
        Array.from(this.recipes.values()),
        Array.from(this.prefabs.values()),
      );
    }
    return this.recipeGraph;
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
      // Inline adapter — keeps the legacy `getModel` shape out of the public
      // ContentService surface. Mirrors how ContentCache wraps its own model
      // lookup at the call site.
      const adapter: HitboxContentAdapter = {
        getModel: (id) => this.models.get(id) ?? null,
        getModelAabb: (id) => this.modelAabb.get(id) ?? null,
        getSkeleton: (id) => this.skeletons.get(id) ?? null,
      };
      tmpl = deriveHitboxTemplate(modelId, seed, adapter, scale);
      this.hitboxTemplateCache.set(key, tmpl);
    }
    return tmpl;
  }

  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip> {
    let idx = this.clipIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      const lib = skeleton ? this.animationLibraries.get(skeleton.archetype) : undefined;
      idx = lib ? new Map(Object.entries(lib.clips)) : new Map();
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

  getGameConfig(): GameConfig {
    if (!this.gameConfig) throw new Error("GameConfig not loaded");
    return this.gameConfig;
  }

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
  overrides?: Record<string, number>,
): Record<string, number> {
  if (!skeleton.morphParams?.length) return overrides ? { ...overrides } : {};
  // XOR with a magic constant to produce a different PRNG stream from resolveSubObjects.
  const rand = makePrng((seed ^ 0xA3C5E7F9) >>> 0);
  const result: Record<string, number> = {};
  for (const param of skeleton.morphParams) {
    // Per-instance overrides (T-180) take precedence over the seed-randomized
    // value. Unknown override keys are accepted silently — they fall through
    // when the skeleton doesn't declare a matching morph param.
    if (overrides && param.id in overrides) {
      result[param.id] = overrides[param.id];
      // Still consume one PRNG value so absent overrides downstream stay
      // deterministic — re-seeded streams must produce identical sequences
      // regardless of which params the prefab overrides.
      rand();
    } else {
      result[param.id] = param.min + rand() * (param.max - param.min);
    }
  }
  return result;
}

// ---- helpers ----

