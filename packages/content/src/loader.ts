/**
 * File-based content loader for the Deno tile server.
 *
 * Each content type lives in its own subdirectory under the data root, with one
 * JSON file per item.  The loader scans each directory and registers every file
 * it finds — adding a new item requires only dropping a new file.
 *
 * Singleton config files (game_config.json etc.) stay as flat objects.
 *
 * Usage:
 *   const content = await loadContentStore();
 *   const template = content.getItemTemplate("wooden_sword");
 */
import { StaticContentStore } from "./store.ts";
import type { MaterialDef, MaterialProperties, ModelDefinition, SkeletonDef, Recipe, StructureDef, LoreFragment, ItemTemplate, NpcTemplate, Prefab, ConceptVerbEntry, GameConfig, TileLayout, WeaponActionDef, VerbDef, BehaviorTreeSpec, BiomeDef, ZoneDef } from "./types.ts";

/** Default data directory — packages/content/data/ relative to this file. */
const DEFAULT_DATA_DIR = new URL("../data", import.meta.url).pathname;

export async function loadContentStore(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<StaticContentStore> {
  const store = new StaticContentStore();

  const [
    materialsRaw, modelsRaw, skeletonsRaw, recipesRaw, structuresRaw,
    loreRaw, itemTemplatesRaw, prefabsRaw, npcTemplatesRaw,
    conceptVerbRaw, weaponActionsRaw, verbsRaw, behaviorTreesRaw,
    biomesRaw, zonesRaw,
  ] = await Promise.all([
    readJsonDir(dataDir, "materials"),
    readJsonDir(dataDir, "models"),
    readJsonDir(dataDir, "skeletons"),
    readJsonDir(dataDir, "recipes"),
    readJsonDir(dataDir, "structures"),
    readJsonDir(dataDir, "lore"),
    readJsonDir(dataDir, "items"),
    readJsonDir(dataDir, "prefabs"),
    readJsonDir(dataDir, "npcs"),
    readJsonFile(dataDir, "concept_verb_matrix.json"),
    readJsonDir(dataDir, "weapon_actions"),
    readJsonFile(dataDir, "verbs.json"),
    readJsonDir(dataDir, "behavior_trees"),
    readJsonDir(dataDir, "biomes"),
    readJsonDir(dataDir, "zones"),
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

  for (const effective of resolvePrefabInheritance(prefabsRaw as Prefab[])) {
    store.registerPrefab(effective);
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

  for (const raw of verbsRaw as VerbDef[]) {
    store.registerVerbDef(raw);
  }

  for (const raw of behaviorTreesRaw as BehaviorTreeSpec[]) {
    store.registerBehaviorTree(raw);
  }

  for (const raw of biomesRaw as BiomeDef[]) {
    store.registerBiome(raw);
  }

  for (const raw of zonesRaw as ZoneDef[]) {
    store.registerZone(raw);
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

/**
 * Read all *.json files in `dir/subdir`, parse each as a single item, and
 * return them sorted by filename for deterministic registration order.
 */
async function readJsonDir(dir: string, subdir: string): Promise<unknown[]> {
  const fullDir = `${dir}/${subdir}`;
  const names: string[] = [];
  for await (const entry of Deno.readDir(fullDir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      names.push(entry.name);
    }
  }
  names.sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await Deno.readTextFile(`${fullDir}/${name}`);
      return JSON.parse(text);
    }),
  );
}

/**
 * Read a single JSON file that contains an array of items (concept_verb_matrix,
 * verbs — collections with no natural per-item key).
 */
async function readJsonFile(dir: string, file: string): Promise<unknown[]> {
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

/**
 * Resolve prefab `extends` inheritance. Walks the chain root-to-leaf,
 * deep-merging `components` (and `modelId` / `modelScale`) so a child only
 * needs to declare the delta from its parent.
 *
 * Detects cycles and missing parents at load — the server fails fast rather
 * than spawning malformed entities. Arrays inside component data are replaced
 * wholesale by the child (never concatenated); nested objects are merged.
 */
export function resolvePrefabInheritance(raw: Prefab[]): Prefab[] {
  const byId = new Map<string, Prefab>();
  for (const p of raw) {
    if (byId.has(p.id)) {
      throw new Error(`Prefab '${p.id}' declared more than once`);
    }
    byId.set(p.id, p);
  }

  const resolved = new Map<string, Prefab>();

  const resolve = (id: string, stack: string[]): Prefab => {
    const cached = resolved.get(id);
    if (cached) return cached;
    if (stack.includes(id)) {
      throw new Error(
        `Prefab inheritance cycle: ${[...stack, id].join(" → ")}`,
      );
    }
    const self = byId.get(id);
    if (!self) throw new Error(`Prefab '${id}' not found`);

    let effective: Prefab;
    if (self.extends) {
      const parent = resolve(self.extends, [...stack, id]);
      effective = {
        id: self.id,
        ...(self.extends !== undefined && { extends: self.extends }),
        modelId:    self.modelId    ?? parent.modelId,
        modelScale: self.modelScale ?? parent.modelScale,
        components: mergeComponents(parent.components, self.components),
      };
    } else {
      effective = { ...self };
    }
    resolved.set(id, effective);
    return effective;
  };

  for (const p of raw) resolve(p.id, []);
  return Array.from(resolved.values());
}

/** Deep-merge two component dicts. Arrays are replaced, not concatenated. */
function mergeComponents(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    out[key] = mergeValues(parent[key], value);
  }
  return out;
}

function mergeValues(parent: unknown, child: unknown): unknown {
  if (isPlainObject(parent) && isPlainObject(child)) {
    const merged: Record<string, unknown> = { ...parent };
    for (const [k, v] of Object.entries(child)) merged[k] = mergeValues(parent[k], v);
    return merged;
  }
  // Arrays, primitives, null — child wins outright.
  return child;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
