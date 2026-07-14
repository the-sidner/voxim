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
  ItemSlotDef,
  ComposedData,
  DerivedItemStats,
  Recipe,
  NpcTemplate,
  BehaviorTreeSpec,
  BiomeDef,
  GradeDef,
  LightDef,
  AtmosphereDef,
  WaterStyleDef,
  DecalDef,
  ParticleEmitterDef,
  DissolveProfileDef,
  DeathStyleDef,
  CliffProfileDef,
  ZoneDef,
  PoiDef,
  PoiRole,
  LoreFragment,
  Prefab,
  GameConfig,
  Palette,
  TileLayout,
  WeaponActionDef,
  ActionDef,
  ResourceDef,
  TriggerDef,
  PuzzleDef,
  ProcModelDef,
  ScatterDef,
  GaitDef,
} from "./types.ts";
import type { HitboxContentAdapter, HitboxPartTemplate } from "./hitbox_derive.ts";
import { deriveHitboxTemplate } from "./hitbox_derive.ts";
import type { AnimationClip, BoneMask } from "./types.ts";
import { buildClipIndex, buildMaskIndex } from "./animation_eval.ts";
import type { RecipeGraph } from "./recipe_graph.ts";
import { buildRecipeGraph } from "./recipe_graph.ts";
import type { ContentRegistryReadonly } from "./registry.ts";
import { ContentRegistry } from "./registry.ts";
import { mulberry32, resolveSeededPick } from "@voxim/engine";

/** Default max durability for an equippable/usable item whose prefab doesn't
 *  declare an explicit `durability` (T-086). */
const DEFAULT_MAX_DURABILITY = 100;

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
  /**
   * Procedural gait catalogues (T-308), keyed by id. Loaded from
   * `data/gaits/*.json`, referenced by `SkeletonDef.gaitId`. Client-only
   * consumer (`applyGaitPose` in swing_pose.ts); the server never reads it.
   */
  readonly gaits:           ContentRegistryReadonly<GaitDef>;
  /**
   * Action definitions (T-225) — the universal behavior primitive. Loaded
   * from `data/actions/*.json`. Consumed by the ActionDispatcher (T-226+)
   * which is the only writer of the `ActiveAction` component.
   */
  readonly actions:         ContentRegistryReadonly<ActionDef>;
  /**
   * Animation libraries keyed by archetype id (T-178). Look up clips via
   * `store.animationLibraries.getOrThrow(skeleton.archetype).clips[clipId]`.
   * Multiple skeletons sharing an archetype share the same library entry.
   */
  readonly animationLibraries: ContentRegistryReadonly<AnimationLibrary>;

  /**
   * Resources keyed by id (T-238). Tick-scalar definitions loaded from
   * `data/resources/*.json` — ResourceSystem integrates the rate, clamps to
   * bounds, and dispatches threshold effects through the shared
   * EffectRegistry. Adding a new bounded-scalar (stamina/hunger/poise/…) is
   * a file drop. See RESOURCE_PRIMITIVE_PLAN.md.
   */
  readonly resources: ContentRegistryReadonly<ResourceDef>;

  /**
   * Colour grades keyed by id (T-311 Phase 2, grammar G7). Loaded from
   * `data/grades/*.json`; the client lerps the EdgePass grade uniforms from the
   * selected grade. Authoring a new look is a file drop.
   */
  readonly grades: ContentRegistryReadonly<GradeDef>;

  /**
   * Light definitions keyed by id (T-311 Phase 2). The server resolves a
   * LightDef into the networked LightEmitter numbers; the client derives the
   * presentation-only fields (flicker/family/castsPool). Authoring a light is a
   * file drop. See VISUAL_DATAMODEL_PLAN.md (grammar G7-adjacent).
   */
  readonly lights: ContentRegistryReadonly<LightDef>;

  /**
   * Atmosphere definitions keyed by id (T-311 Phase 5a, grammar G7). Loaded
   * from `data/atmospheres/*.json`; selected per-tile via `WorldClock.biomeTag`
   * with a `"default"` fallback. Owns the sun path (sun_arc.ts params), ground
   * mist band, and near-field god-ray params — NOT day/night colour (that
   * stays on `Palette.phases`). Authoring a new atmosphere is a file drop.
   */
  readonly atmospheres: ContentRegistryReadonly<AtmosphereDef>;

  /**
   * Water style definitions keyed by id (T-311 Phase 5b, grammar G7). Loaded
   * from `data/water_styles/*.json`; selected per-tile via the SAME
   * `WorldClock.biomeTag` key AtmosphereDef uses, same `"default"` fallback.
   * Owns wave/fresnel/specular shader params + base shallow/deep colour —
   * water_renderer.ts reads it instead of hardcoded shader literals.
   */
  readonly waterStyles: ContentRegistryReadonly<WaterStyleDef>;

  /**
   * Ephemeral combat decals keyed by id (T-311 P4). Loaded from
   * `data/decals/*.json`; the client's decal-source registry seeds splats
   * from wire GameEvents and decays them — never saved, never networked.
   */
  readonly decals: ContentRegistryReadonly<DecalDef>;

  /**
   * Particle emitters keyed by id (T-340). Loaded from `data/particles/*.json`;
   * dispatched through the client's particle-source registry (event-sourced
   * bursts) or referenced directly by id (WeaponActionDef.muzzleParticleId,
   * AtmosphereDef.ambienceParticleId).
   */
  readonly particles: ContentRegistryReadonly<ParticleEmitterDef>;

  /**
   * Corrupted-creature dissolve/fray profiles keyed by id (T-311 P5c).
   * Loaded from `data/dissolve_profiles/*.json`; referenced by a
   * dissolve-style `DeathStyleDef.dissolveProfileId` (T-339). Drives the
   * shed_dissolve DeathHook's timer seeding and the client's fray/coreness
   * bake + in-shader drift. See VISUAL_DATAMODEL_PLAN.md §I3b.
   */
  readonly dissolveProfiles: ContentRegistryReadonly<DissolveProfileDef>;

  /**
   * Death styles keyed by id (T-339) — "what happens to a body on death",
   * dispatched by `style` through a registry on server + client. Loaded
   * from `data/death_styles/*.json`; referenced by `NpcTemplate.deathStyleId`.
   */
  readonly deathStyles: ContentRegistryReadonly<DeathStyleDef>;

  /**
   * Cliff profiles keyed by id (T-311 Phase 6). Loaded from
   * `data/cliff_profiles/*.json`; the atlas `cliffStage` resolves stone
   * wilderness-perimeter cells against this table (stable alphabetical
   * id→index) and the client `cliffVoxeliser` registry dispatches on the
   * same id string. Authoring a new cliff look is a file drop.
   */
  readonly cliffProfiles: ContentRegistryReadonly<CliffProfileDef>;

  /**
   * Triggers keyed by id (T-259). Reactive couplings loaded from
   * `data/triggers/*.json` — when event `on` occurs and the owner fills
   * role `as`, fire `effects` through the shared action-effect registry.
   * Attached to owners via TriggerSources (equipment `triggers[]`, …).
   * See TRIGGER_PRIMITIVE_PLAN.md.
   */
  readonly triggers: ContentRegistryReadonly<TriggerDef>;

  /**
   * Puzzle templates keyed by id (T-212 v2). Loaded from `data/puzzles/*.json`
   * — a `puzzle` POI's `activity.puzzleId` references one; the template names
   * the mechanics `kind` dispatched through `poi/puzzle_kinds/mod.ts`'s
   * registry. Per-instance tuning (lever count, hints) stays on the POI's own
   * `activity.params`.
   */
  readonly puzzles: ContentRegistryReadonly<PuzzleDef>;

  /**
   * Procedural model families keyed by id (T-285). Each names a client
   * generator + its params; the per-tile VariantPool bakes K variants from it.
   * Visual-only — shipped in the bootstrap blob, consumed by the client's
   * ScatterRenderer. See PROCMODEL_PRIMITIVE_PLAN.md.
   */
  readonly procModels: ContentRegistryReadonly<ProcModelDef>;

  /**
   * Scatter declarations keyed by id (T-285): where a procmodel scatters (by
   * KindGrid boundary kind) and how big its variant pool is. Replaces the
   * `FOREST_*` hardcodes. Visual-only; consumed by the client.
   */
  readonly scatter: ContentRegistryReadonly<ScatterDef>;

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
  /**
   * Derive an item's stat block from its prefab. When the prefab carries a
   * `Composed` behaviour (`components.composed.slots`) AND the caller passes
   * matching `parts` (one `ItemPart` per filled slot), each slot's
   * `statContributions` are summed in: `stat += material.properties[property]
   * × multiplier`, added on top of the base value derived from the prefab's
   * other components (T-303). Materials are resolved by `ItemPart.materialName`
   * against `this.materials`; a part naming an unknown material or a slot with
   * no matching part is skipped (no throw — this is a runtime stat query, not
   * boot validation). Voxels feed weight/damage/reach — swing speed stays a
   * per-action design dial (DECISION, T-303).
   */
  deriveItemStats(prefabId: string, parts?: ItemPart[], quality?: number): DerivedItemStats;
  /** Reverse index: producers by item, recipes by workstation, primitive items. */
  getRecipeGraph(): RecipeGraph;
  /** Cached bone index (Map<boneId, BoneDef>) — built once per skeleton type. */
  getBoneIndex(skeletonId: string): ReadonlyMap<string, BoneDef>;
  /**
   * Cached hitbox template per (modelId, seed, scale, morphValues). morphValues
   * only matters for skeletons carrying a bodyRecipe (T-186 Layer 2) — every
   * other model's template is identical regardless of what's passed. Pass the
   * SAME morphValues the entity's ModelRef carries (resolveMorphParams's raw
   * override input, not the resolved output) so two entities sharing a
   * modelId+seed+scale but different per-instance morphs never collide in
   * the cache.
   */
  getHitboxTemplate(modelId: string, seed: number, scale: number, morphValues?: Record<string, number>): HitboxPartTemplate[];
  /** Cached clip lookup map (clipId → AnimationClip) per skeleton type. */
  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip>;
  /** Cached bone mask lookup map (maskId → BoneMask) per skeleton type. */
  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask>;

  // ---- singletons ----
  getGameConfig(): GameConfig;
  getTileLayout(): TileLayout | null;
  getPalette(): Palette;
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
  public readonly gaits = new ContentRegistry<GaitDef>({
    kind: "gait",
    idOf: (g) => g.id,
  });
  public readonly actions = new ContentRegistry<ActionDef>({
    kind: "action",
    idOf: (a) => a.id,
  });
  public readonly animationLibraries = new ContentRegistry<AnimationLibrary>({
    kind: "animationLibrary",
    idOf: (lib) => lib.id,
  });
  public readonly resources = new ContentRegistry<ResourceDef>({
    kind: "resource",
    idOf: (r) => r.id,
  });
  public readonly grades = new ContentRegistry<GradeDef>({
    kind: "grade",
    idOf: (g) => g.id,
  });
  public readonly lights = new ContentRegistry<LightDef>({
    kind: "light",
    idOf: (l) => l.id,
  });
  public readonly atmospheres = new ContentRegistry<AtmosphereDef>({
    kind: "atmosphere",
    idOf: (a) => a.id,
  });
  public readonly waterStyles = new ContentRegistry<WaterStyleDef>({
    kind: "waterStyle",
    idOf: (w) => w.id,
  });
  public readonly decals = new ContentRegistry<DecalDef>({
    kind: "decal",
    idOf: (d) => d.id,
  });
  public readonly particles = new ContentRegistry<ParticleEmitterDef>({
    kind: "particle",
    idOf: (p) => p.id,
  });
  public readonly dissolveProfiles = new ContentRegistry<DissolveProfileDef>({
    kind: "dissolveProfile",
    idOf: (d) => d.id,
  });
  public readonly deathStyles = new ContentRegistry<DeathStyleDef>({
    kind: "deathStyle",
    idOf: (d) => d.id,
  });
  public readonly cliffProfiles = new ContentRegistry<CliffProfileDef>({
    kind: "cliffProfile",
    idOf: (c) => c.id,
  });
  public readonly triggers = new ContentRegistry<TriggerDef>({
    kind: "trigger",
    idOf: (t) => t.id,
  });
  public readonly puzzles = new ContentRegistry<PuzzleDef>({
    kind: "puzzle",
    idOf: (p) => p.id,
  });
  public readonly procModels = new ContentRegistry<ProcModelDef>({
    kind: "procModel",
    idOf: (p) => p.id,
  });
  public readonly scatter = new ContentRegistry<ScatterDef>({
    kind: "scatter",
    idOf: (s) => s.id,
  });

  // ---- secondary indices ----
  private materialsByNumericId = new Map<MaterialId, MaterialDef>();
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
  private palette: Palette | null = null;

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

  registerWeaponAction(def: WeaponActionDef): void {
    this.weaponActions.register(def);
  }

  registerGait(def: GaitDef): void {
    this.gaits.register(def);
  }

  registerAction(def: ActionDef): void {
    this.actions.register(def);
  }

  registerAnimationLibrary(lib: AnimationLibrary): void {
    this.animationLibraries.register(lib);
  }




  registerResource(def: ResourceDef): void {
    this.resources.register(def);
  }

  registerGrade(def: GradeDef): void {
    this.grades.register(def);
  }

  registerLight(def: LightDef): void {
    this.lights.register(def);
  }

  registerAtmosphere(def: AtmosphereDef): void {
    this.atmospheres.register(def);
  }

  registerWaterStyle(def: WaterStyleDef): void {
    this.waterStyles.register(def);
  }

  registerDecal(def: DecalDef): void {
    this.decals.register(def);
  }

  registerParticle(def: ParticleEmitterDef): void {
    this.particles.register(def);
  }

  registerDissolveProfile(def: DissolveProfileDef): void {
    this.dissolveProfiles.register(def);
  }

  registerDeathStyle(def: DeathStyleDef): void {
    this.deathStyles.register(def);
  }

  registerCliffProfile(def: CliffProfileDef): void {
    this.cliffProfiles.register(def);
  }

  registerTrigger(def: TriggerDef): void {
    this.triggers.register(def);
  }

  registerPuzzle(def: PuzzleDef): void {
    this.puzzles.register(def);
  }

  registerProcModel(def: ProcModelDef): void {
    this.procModels.register(def);
  }

  registerScatter(def: ScatterDef): void {
    this.scatter.register(def);
  }

  setGameConfig(config: GameConfig): void {
    this.gameConfig = config;
  }

  setTileLayout(layout: TileLayout): void {
    this.tileLayout = layout;
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
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

  deriveItemStats(prefabId: string, parts?: ItemPart[], quality = 1): DerivedItemStats {
    const prefab = this.prefabs.get(prefabId);
    if (!prefab) return { weight: 1 };

    const c = prefab.components;
    const weight = c["weight"] as { baseWeight?: number } | undefined;
    const armor = c["armor"] as { reduction?: number; staminaPenalty?: number } | undefined;
    const illuminator = c["illuminator"] as { radius?: number; color?: number; intensity?: number; lightDefId?: string } | undefined;
    const tool = c["tool"] as { toolType?: string; durability?: number } | undefined;
    const swingable = c["swingable"] as { damage?: number; durability?: number } | undefined;
    const armorDur = c["armor"] as { durability?: number } | undefined;
    const composed = c["composed"] as ComposedData | undefined;

    const stats: DerivedItemStats = { weight: weight?.baseWeight ?? 1 };
    // Durability (T-086): equippable/usable items get a per-instance ceiling.
    // An explicit `durability` on the behaviour component wins; else a default.
    const explicitDur = swingable?.durability ?? tool?.durability ?? armorDur?.durability;
    if (explicitDur !== undefined) stats.maxDurability = explicitDur;
    else if (swingable || tool || armor) stats.maxDurability = DEFAULT_MAX_DURABILITY;
    if (armor?.reduction !== undefined) stats.armorReduction = armor.reduction * quality;
    if (armor?.staminaPenalty !== undefined) stats.staminaRegenPenalty = armor.staminaPenalty;
    // foodValue / waterValue are derived from the item's effect payload
    // (T-240): a negative `adjust_resource` delta on hunger/thirst is, by
    // definition, how much eating/drinking it restores. The DerivedItemStats
    // contract is unchanged so NPC AI (findNearestConsumable) is untouched.
    for (const e of prefab.effects ?? []) {
      if (e.id !== "adjust_resource") continue;
      const d = (e.params?.deltas ?? {}) as Record<string, unknown>;
      if (typeof d.hunger === "number" && d.hunger < 0) {
        stats.foodValue = (stats.foodValue ?? 0) + -d.hunger * quality;
      }
      if (typeof d.thirst === "number" && d.thirst < 0) {
        stats.waterValue = (stats.waterValue ?? 0) + -d.thirst * quality;
      }
    }
    if (illuminator?.intensity) {
      stats.lightRadius = illuminator.radius;
      stats.lightColor = illuminator.color;
      stats.lightIntensity = illuminator.intensity * quality;
      if (illuminator.lightDefId) stats.lightDefId = illuminator.lightDefId;
    }
    if (tool?.toolType) stats.toolType = tool.toolType;
    if (swingable?.damage !== undefined) stats.damage = swingable.damage * quality;

    // Composed material slots (T-303): each filled slot sums
    // `material.properties[property] × multiplier` into the named stat, on
    // top of whatever base value the behaviour components above already set
    // (e.g. a Composed sword still keeps its hardcoded swingable.damage as a
    // base — the blade material ADDS to it, it doesn't replace it). A slot
    // with no matching part, or a part naming an unknown material, is
    // skipped — this derivation never throws at query time.
    if (composed && parts && parts.length > 0) {
      const partBySlot = new Map(parts.map((p) => [p.slot, p.materialName]));
      for (const slot of composed.slots) {
        const materialName = partBySlot.get(slot.id);
        if (materialName === undefined) continue;
        const material = this.materials.get(materialName);
        if (!material) continue;
        for (const contrib of slot.statContributions) {
          const propValue = material.properties[contrib.property];
          const delta = propValue * contrib.multiplier * quality;
          (stats[contrib.stat] as number) = ((stats[contrib.stat] as number) ?? 0) + delta;
        }
      }
    }

    // Reach (T-303, optional): a Composed item's overall model AABB length
    // (its longest axis, in model-local units × modelScale) stands in for
    // blade+grip reach until a per-slot sub-model exists. Only set when the
    // prefab is Composed — a plain item's swingable geometry is whatever the
    // WeaponActionDef's swingPath already authors, and reach staying absent
    // there is correct (no regression for non-Composed weapons).
    if (composed && prefab.modelId) {
      const aabb = this.modelAabb.get(prefab.modelId);
      if (aabb) {
        const extX = aabb.maxX - aabb.minX;
        const extY = aabb.maxY - aabb.minY;
        const extZ = aabb.maxZ - aabb.minZ;
        const scale = prefab.modelScale ?? 1;
        stats.attackRange = Math.max(extX, extY, extZ) * scale;
      }
    }

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

  getHitboxTemplate(modelId: string, seed: number, scale: number, morphValues?: Record<string, number>): HitboxPartTemplate[] {
    // T-186 Layer 2: fold morphValues into the cache key. Every pre-existing
    // model (no bodyRecipe) ignores the resolved morphParams entirely inside
    // deriveHitboxTemplate, so this only adds cache entries for skeletons
    // that actually vary by morph — it never changes cached output for
    // anything else.
    const morphKey = morphValues
      ? Object.keys(morphValues).sort().map((k) => `${k}=${morphValues[k]}`).join(",")
      : "";
    const key = `${modelId}:${seed}:${scale}:${morphKey}`;
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
      const skeleton = this.getSkeletonForModel(modelId);
      const resolvedMorphParams = skeleton ? resolveMorphParams(skeleton, seed, morphValues) : undefined;
      tmpl = deriveHitboxTemplate(modelId, seed, adapter, scale, resolvedMorphParams);
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

  getPalette(): Palette {
    if (!this.palette) throw new Error("Palette not loaded");
    return this.palette;
  }
}

// ---- procedural model variation ----

/**
 * Tiny seeded PRNG (mulberry32).  Produces values in [0, 1).
 * Same seed always produces the same sequence — deterministic across server and client.
 * Exported (T-285) so client procmodel generators draw from the same stream.
 * Re-exported under this name from @voxim/engine's shared mulberry32 (T-315 C5).
 */
export const makePrng = mulberry32;

/**
 * Resolve a model's subObjects list against a seed, collapsing every pool
 * entry to a single chosen modelId and honouring per-point probabilities.
 *
 * Call this once at mesh-build time (client) or spawn time (server, if the
 * server needs the resolved list).  The same (subObjects, seed) pair always
 * produces the same result, so all clients converge on the same visual.
 *
 * Sub-objects with neither modelId nor pool are skipped.
 *
 * The per-entry draw goes through `resolveSeededPick` (T-334) — the ONE
 * shared pool/probability primitive also used by the engine's `spawnPrefab`
 * children walk and (still separately, since it drives a different output
 * shape) by `hitbox_derive.ts`. Same function, same draw order, so a
 * hitbox derived from this model's subObjects can never draw a different
 * variant than the one actually rendered here.
 */
export function resolveSubObjects(subObjects: SubObjectRef[], seed: number): ResolvedSubObject[] {
  const rand = makePrng(seed);
  const result: ResolvedSubObject[] = [];
  for (const sub of subObjects) {
    const modelId = resolveSeededPick(sub, sub.modelId, rand);
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

