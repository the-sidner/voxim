/**
 * File-based content loader for the Deno tile server.
 *
 * Reads JSON data files from a content data directory and populates a
 * StaticContentStore.  The data directory defaults to packages/content/data/
 * (resolved relative to this source file).  Pass an explicit path in production.
 *
 * Usage:
 *   const content = await loadContentStore();
 *   const template = content.getItemTemplate("wooden_sword");
 */
import { StaticContentStore } from "./store.ts";
import type { MaterialDef, MaterialProperties, ModelDefinition, SkeletonDef, Recipe, StructureDef, LoreFragment, ItemTemplate, NpcTemplate, EntityTemplate, ConceptVerbEntry, GameConfig, TileLayout, WeaponActionDef, ModelHitboxDef, VerbDef } from "./types.ts";

/** Default data directory — packages/content/data/ relative to this file. */
const DEFAULT_DATA_DIR = new URL("../data", import.meta.url).pathname;

export async function loadContentStore(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<StaticContentStore> {
  const store = new StaticContentStore();

  const [materialsRaw, modelsRaw, skeletonsRaw, recipesRaw, structuresRaw, loreRaw, itemTemplatesRaw, entityTemplatesRaw, npcTemplatesRaw, conceptVerbRaw, weaponActionsRaw, modelHitboxesRaw, verbsRaw] = await Promise.all([
    readJson(dataDir, "materials.json"),
    readJson(dataDir, "models.json"),
    readJson(dataDir, "skeletons.json"),
    readJson(dataDir, "recipes.json"),
    readJson(dataDir, "structures.json"),
    readJson(dataDir, "lore_fragments.json"),
    readJson(dataDir, "item_templates.json"),
    readJson(dataDir, "entity_templates.json"),
    readJson(dataDir, "npc_templates.json"),
    readJson(dataDir, "concept_verb_matrix.json"),
    readJson(dataDir, "weapon_actions.json"),
    readJson(dataDir, "model_hitboxes.json"),
    readJson(dataDir, "verbs.json"),
  ]);

  for (const raw of materialsRaw as RawMaterialDef[]) {
    store.registerMaterial(parseMaterial(raw));
  }

  for (const raw of modelsRaw as ModelDefinition[]) {
    store.registerModel(raw);
  }

  for (const raw of skeletonsRaw as SkeletonDef[]) {
    store.registerSkeleton(raw);
  }

  for (const raw of recipesRaw as Recipe[]) {
    store.registerRecipe(raw);
  }

  for (const raw of structuresRaw as StructureDef[]) {
    store.registerStructureDef(raw);
  }

  for (const raw of loreRaw as LoreFragment[]) {
    store.registerLoreFragment(raw);
  }

  for (const raw of itemTemplatesRaw as ItemTemplate[]) {
    store.registerItemTemplate(raw);
  }

  for (const raw of entityTemplatesRaw as EntityTemplate[]) {
    store.registerEntityTemplate(raw);
  }

  for (const raw of npcTemplatesRaw as NpcTemplate[]) {
    store.registerNpcTemplate(raw);
  }

  for (const raw of conceptVerbRaw as ConceptVerbEntry[]) {
    store.registerConceptVerbEntry(raw);
  }

  for (const raw of weaponActionsRaw as WeaponActionDef[]) {
    store.registerWeaponAction(raw);
  }

  for (const raw of modelHitboxesRaw as ModelHitboxDef[]) {
    store.registerModelHitbox(raw);
  }

  for (const raw of verbsRaw as VerbDef[]) {
    store.registerVerbDef(raw);
  }

  const gameConfig = await readJsonObject(dataDir, "game_config.json") as unknown as GameConfig;
  store.setGameConfig(gameConfig);

  try {
    const tileLayout = await readJsonObject(dataDir, "tile_layout.json") as unknown as TileLayout;
    store.setTileLayout(tileLayout);
  } catch {
    // tile_layout.json is optional
  }

  return store;
}

// ---- helpers ----

async function readJson(dir: string, file: string): Promise<unknown[]> {
  const path = `${dir}/${file}`;
  const text = await Deno.readTextFile(path);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Content file ${path}: expected a JSON array, got ${typeof parsed}`);
  }
  return parsed;
}

async function readJsonObject(dir: string, file: string): Promise<Record<string, unknown>> {
  const path = `${dir}/${file}`;
  const text = await Deno.readTextFile(path);
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Content file ${path}: expected a JSON object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Materials in JSON use "#rrggbb" colour strings for readability.
 * Parse them into the numeric 0xRRGGBB integers the engine expects.
 * Properties default to neutral values if omitted (backwards-compatible).
 */
interface RawMaterialDef extends Omit<MaterialDef, "color" | "properties"> {
  color: string | number;
  properties?: Partial<MaterialProperties>;
}

const DEFAULT_PROPERTIES: MaterialProperties = {
  hardness: 0.5,
  density: 0.5,
  flexibility: 0.5,
  flammability: 0.0,
  toughness: 0.5,
};

function parseMaterial(raw: RawMaterialDef): MaterialDef {
  const color =
    typeof raw.color === "string"
      ? parseInt(raw.color.replace("#", ""), 16)
      : raw.color;
  const properties: MaterialProperties = {
    ...DEFAULT_PROPERTIES,
    ...raw.properties,
  };
  return { ...raw, color, properties };
}
