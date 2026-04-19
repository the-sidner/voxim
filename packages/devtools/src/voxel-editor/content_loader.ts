/**
 * Browser-side content loader — fetches JSON from /content/* served by serve_devtools.ts.
 * Mirrors packages/content/src/loader.ts but uses fetch() instead of Deno.readTextFile.
 */
import {
  StaticContentStore,
} from "@voxim/content";
import type {
  MaterialDef,
  MaterialProperties,
  ModelDefinition,
  SkeletonDef,
  Recipe,
  LoreFragment,
  Prefab,
  NpcTemplate,
  ConceptVerbEntry,
  GameConfig,
  WeaponActionDef,
  VerbDef,
} from "@voxim/content";

const BASE = "/content";

async function fetchArray(file: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${file}: expected array`);
  return data;
}

async function fetchObject(file: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status}`);
  return res.json();
}

interface RawMaterialDef extends Omit<MaterialDef, "color" | "properties"> {
  color: string | number;
  properties?: Partial<MaterialProperties>;
}

const DEFAULT_PROPERTIES: MaterialProperties = {
  hardness: 0.5, density: 0.5, flexibility: 0.5, flammability: 0.0, toughness: 0.5,
};

function parseMaterial(raw: RawMaterialDef): MaterialDef {
  const color = typeof raw.color === "string"
    ? parseInt(raw.color.replace("#", ""), 16)
    : raw.color;
  return { ...raw, color, properties: { ...DEFAULT_PROPERTIES, ...raw.properties } };
}

export interface BrowserContentStore extends StaticContentStore {
  /** All model IDs known to the store (for import picker). */
  allModelIds: readonly string[];
}

export async function loadContentBrowser(): Promise<BrowserContentStore> {
  const store = new StaticContentStore() as BrowserContentStore;

  const [
    materialsRaw, modelsRaw, skeletonsRaw, recipesRaw,
    loreRaw, prefabsRaw, npcTemplatesRaw,
    conceptVerbRaw, weaponActionsRaw, verbsRaw, gameConfigRaw,
  ] = await Promise.all([
    fetchArray("materials.json"),
    fetchArray("models.json"),
    fetchArray("skeletons.json"),
    fetchArray("recipes.json"),
    fetchArray("lore_fragments.json"),
    fetchArray("prefabs.json"),
    fetchArray("npc_templates.json"),
    fetchArray("concept_verb_matrix.json"),
    fetchArray("weapon_actions.json"),
    fetchArray("verbs.json"),
    fetchObject("game_config.json"),
  ]);

  for (const raw of materialsRaw as RawMaterialDef[]) store.registerMaterial(parseMaterial(raw));
  for (const raw of modelsRaw as ModelDefinition[]) store.registerModel(raw);
  for (const raw of skeletonsRaw as SkeletonDef[]) store.registerSkeleton(raw);
  for (const raw of recipesRaw as Recipe[]) store.registerRecipe(raw);
  for (const raw of loreRaw as LoreFragment[]) store.registerLoreFragment(raw);
  for (const raw of prefabsRaw as Prefab[]) store.registerPrefab(raw);
  for (const raw of npcTemplatesRaw as NpcTemplate[]) store.registerNpcTemplate(raw);
  for (const raw of conceptVerbRaw as ConceptVerbEntry[]) store.registerConceptVerbEntry(raw);
  for (const raw of weaponActionsRaw as WeaponActionDef[]) store.registerWeaponAction(raw);
  for (const raw of verbsRaw as VerbDef[]) store.registerVerbDef(raw);
  store.setGameConfig(gameConfigRaw as unknown as GameConfig);

  (store as unknown as { allModelIds: string[] }).allModelIds =
    (modelsRaw as ModelDefinition[]).map((m) => m.id);

  return store;
}
