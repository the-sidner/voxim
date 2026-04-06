/**
 * ContentStore — interface and in-memory implementation.
 *
 * All game content (materials, models, recipes, structures, lore, item templates)
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
  SubObjectRef,
  ResolvedSubObject,
  SkeletonDef,
  ItemPart,
  ItemTemplate,
  DerivedItemStats,
  StatContribution,
  Recipe,
  StructureDef,
  NpcTemplate,
  LoreFragment,
  ResourceNodeTemplate,
  ConceptVerbEntry,
  SkillVerb,
  LoreConcept,
  GameConfig,
  TileLayout,
  WeaponActionDef,
  ModelHitboxDef,
  VerbDef,
} from "./types.ts";

export interface ContentStore {
  // ---- materials ----
  getMaterial(id: MaterialId): MaterialDef | null;
  getMaterialByName(name: string): MaterialDef | null;
  getAllMaterials(): MaterialDef[];

  // ---- models ----
  getModel(id: string): ModelDefinition | null;

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

  // ---- structures ----
  getStructureDef(id: string): StructureDef | null;
  getAllStructureDefs(): readonly StructureDef[];

  // ---- NPC templates ----
  getNpcTemplate(id: string): NpcTemplate | null;
  getAllNpcTemplates(): readonly NpcTemplate[];

  // ---- resource nodes ----
  getNodeTemplate(id: string): ResourceNodeTemplate | null;
  getAllNodeTemplates(): readonly ResourceNodeTemplate[];

  // ---- lore fragments ----
  getLoreFragment(id: string): LoreFragment | null;
  getAllLoreFragments(): readonly LoreFragment[];

  // ---- concept-verb matrix ----
  getConceptVerbEntry(verb: SkillVerb, outward: LoreConcept, inward: LoreConcept): ConceptVerbEntry | null;
  getAllConceptVerbEntries(): readonly ConceptVerbEntry[];

  // ---- weapon actions ----
  getWeaponAction(id: string): WeaponActionDef | null;
  getAllWeaponActions(): readonly WeaponActionDef[];

  // ---- model hitboxes ----
  getModelHitboxDef(modelTemplateId: string): ModelHitboxDef | null;

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
  private structures = new Map<string, StructureDef>();
  private npcTemplates = new Map<string, NpcTemplate>();
  private nodeTemplates = new Map<string, ResourceNodeTemplate>();
  private loreFragments = new Map<string, LoreFragment>();
  private conceptVerbEntries = new Map<string, ConceptVerbEntry>();
  private weaponActions = new Map<string, WeaponActionDef>();
  private modelHitboxes = new Map<string, ModelHitboxDef>();
  private verbDefs = new Map<SkillVerb, VerbDef>();
  private gameConfig: GameConfig | null = null;
  private tileLayout: TileLayout | null = null;

  // ---- registration ----

  registerMaterial(def: MaterialDef): void {
    this.materials.set(def.id, def);
    this.materialsByName.set(def.name, def);
  }

  registerModel(def: ModelDefinition): void {
    this.models.set(def.id, def);
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

  registerStructureDef(def: StructureDef): void {
    this.structures.set(def.id, def);
  }

  registerNpcTemplate(template: NpcTemplate): void {
    this.npcTemplates.set(template.id, template);
  }

  registerNodeTemplate(template: ResourceNodeTemplate): void {
    this.nodeTemplates.set(template.id, template);
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

  registerModelHitbox(def: ModelHitboxDef): void {
    this.modelHitboxes.set(def.modelTemplateId, def);
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
      if (
        recipe.inputs.every(
          (inp) => (inventory.get(inp.itemType) ?? 0) >= inp.quantity,
        )
      ) {
        return recipe;
      }
    }
    return null;
  }

  // ---- structures ----

  getStructureDef(id: string): StructureDef | null {
    return this.structures.get(id) ?? null;
  }

  getAllStructureDefs(): readonly StructureDef[] {
    return Array.from(this.structures.values());
  }

  // ---- NPC templates ----

  getNpcTemplate(id: string): NpcTemplate | null {
    return this.npcTemplates.get(id) ?? null;
  }

  getAllNpcTemplates(): readonly NpcTemplate[] {
    return Array.from(this.npcTemplates.values());
  }

  // ---- resource nodes ----

  getNodeTemplate(id: string): ResourceNodeTemplate | null {
    return this.nodeTemplates.get(id) ?? null;
  }

  getAllNodeTemplates(): readonly ResourceNodeTemplate[] {
    return Array.from(this.nodeTemplates.values());
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

  // ---- model hitboxes ----

  getModelHitboxDef(modelTemplateId: string): ModelHitboxDef | null {
    return this.modelHitboxes.get(modelTemplateId) ?? null;
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
