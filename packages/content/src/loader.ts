/**
 * JsonSource — file-based ContentService loader for the Deno tile server.
 *
 * Each content type lives in its own subdirectory under the data root, with one
 * JSON file per item. The loader scans each directory and registers every file
 * it finds — adding a new item requires only dropping a new file.
 *
 * Singleton config files (game_config.json etc.) stay as flat objects.
 *
 * Usage (T-176):
 *   const content = await JsonSource.load();
 *   const prefab = content.prefabs.get("wooden_sword");
 *
 * The companion BootstrapSource (T-177) hydrates a ContentService from a
 * binary blob delivered over the WebTransport handshake — used by the
 * browser client. Both produce ContentService instances with identical
 * shape; engines never know which source built the content they consume.
 *
 * JsonSource is the ONLY filesystem reader in the codebase. No engine code
 * touches `Deno.readDir` directly.
 */
import type { ContentService } from "./store.ts";
import { StaticContentStore } from "./store.ts";
import type { MaterialDef, MaterialProperties, ModelDefinition, SkeletonDef, Recipe, LoreFragment, NpcTemplate, Prefab, ConceptVerbEntry, GameConfig, TileLayout, WeaponActionDef, VerbDef, BehaviorTreeSpec, BiomeDef, ZoneDef, StateMachineDef, ManeuverDef, BuffDef } from "./types.ts";
import { buildAnimationLibrary, type LibraryClipFile } from "./anim_library.ts";

/** Default data directory — packages/content/data/ relative to this file. */
const DEFAULT_DATA_DIR = new URL("../data", import.meta.url).pathname;

/**
 * Loader class for the JSON-on-disk source-of-truth. Single static `load()`
 * method returns a fully-populated ContentService. The class form (vs. a
 * bare function) parallels BootstrapSource and any future content sources,
 * and gives a stable identity for the engine to declare its content
 * provenance against.
 */
export class JsonSource {
  static async load(dataDir: string = DEFAULT_DATA_DIR): Promise<ContentService> {
    return loadContentStoreInternal(dataDir);
  }
}

async function loadContentStoreInternal(
  dataDir: string,
): Promise<StaticContentStore> {
  const store = new StaticContentStore();

  const [
    materialsRaw, modelsRaw, skeletonsRaw, recipesRaw,
    loreRaw, prefabsRaw, npcTemplatesRaw,
    conceptVerbRaw, weaponActionsRaw, verbsRaw, behaviorTreesRaw,
    biomesRaw, zonesRaw, stateMachinesRaw, maneuversRaw, buffsRaw, animLibraryArchetypes,
  ] = await Promise.all([
    readJsonDir(dataDir, "materials"),
    readJsonDir(dataDir, "models"),
    readJsonDir(dataDir, "skeletons"),
    readJsonDir(dataDir, "recipes"),
    readJsonDir(dataDir, "lore"),
    readJsonDir(dataDir, "prefabs"),
    readJsonDir(dataDir, "npcs"),
    readJsonFile(dataDir, "concept_verb_matrix.json"),
    readJsonDir(dataDir, "weapon_actions"),
    readJsonFile(dataDir, "verbs.json"),
    readJsonDir(dataDir, "behavior_trees"),
    readJsonDir(dataDir, "biomes"),
    readJsonDir(dataDir, "zones"),
    readJsonDir(dataDir, "state_machines").catch(() => []),
    readJsonDir(dataDir, "maneuvers").catch(() => []),
    readJsonDir(dataDir, "buffs").catch(() => []),
    // T-178: anim_library is now organized as `{archetype}/{clipId}.json`
    // subfolders. Returns Map<archetype, clipFile[]>.
    readJsonArchetypeDirs(dataDir, "anim_library").catch(() => new Map()),
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

  // Build one AnimationLibrary per archetype subdirectory under
  // data/anim_library/. Compound clip recipes bake into plain clips here
  // so the runtime never sees them. Skeletons declaring an archetype with
  // no library entries are valid (rest pose only) — we don't error on
  // missing archetypes, we just leave the library registry empty for them.
  for (const [archetype, files] of animLibraryArchetypes as Map<string, LibraryClipFile[]>) {
    // Pick any skeleton of this archetype to satisfy compound baking that
    // needs bone names. All skeletons sharing an archetype have the same
    // bone names by construction.
    let skeletonForBaking: SkeletonDef | undefined;
    for (const s of store.skeletons.values()) {
      if (s.archetype === archetype) { skeletonForBaking = s; break; }
    }
    const lib = buildAnimationLibrary(archetype, files, skeletonForBaking);
    store.registerAnimationLibrary(lib);
  }

  for (const raw of recipesRaw as Recipe[]) {
    store.registerRecipe(raw);
  }

  for (const raw of loreRaw as LoreFragment[]) {
    store.registerLoreFragment(raw);
  }

  for (const effective of resolvePrefabInheritance(prefabsRaw as Prefab[])) {
    validatePrefabFields(effective);
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

  for (const raw of stateMachinesRaw as StateMachineDef[]) {
    store.registerStateMachine(raw);
  }

  for (const raw of maneuversRaw as ManeuverDef[]) {
    store.registerManeuver(raw);
  }

  for (const raw of buffsRaw as BuffDef[]) {
    store.registerBuff(raw);
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
 * Read all *.json files in `dir/subdir` (and any subdirectories) recursively,
 * parse each as a single item, and return them sorted by path for deterministic
 * registration order.
 */
async function readJsonDir(dir: string, subdir: string): Promise<unknown[]> {
  const fullDir = `${dir}/${subdir}`;
  const paths: string[] = [];
  await collectJsonPaths(fullDir, paths);
  paths.sort();
  return Promise.all(
    paths.map(async (path) => {
      const text = await Deno.readTextFile(path);
      return JSON.parse(text);
    }),
  );
}

async function collectJsonPaths(dir: string, out: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectJsonPaths(full, out);
    } else if (entry.isFile && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

/**
 * Read `dir/{subdir}/{archetype}/*.json` grouped by archetype subfolder.
 * Used for the per-archetype animation library layout (T-178).
 * Bare files at the top level of `subdir` are ignored — every clip lives
 * inside an archetype directory.
 */
async function readJsonArchetypeDirs(dir: string, subdir: string): Promise<Map<string, unknown[]>> {
  const fullDir = `${dir}/${subdir}`;
  const result = new Map<string, unknown[]>();
  for await (const entry of Deno.readDir(fullDir)) {
    if (!entry.isDirectory) continue;
    const archetype = entry.name;
    const archetypeDir = `${fullDir}/${archetype}`;
    const paths: string[] = [];
    await collectJsonPaths(archetypeDir, paths);
    paths.sort();
    const items = await Promise.all(
      paths.map(async (p) => JSON.parse(await Deno.readTextFile(p))),
    );
    result.set(archetype, items);
  }
  return result;
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
      // category/tags/stats: child overrides parent value-by-key. Stats merge
      // by key (child's value wins per stat); tags concatenate then dedupe.
      const mergedTags = self.tags === undefined && parent.tags === undefined
        ? undefined
        : Array.from(new Set([...(parent.tags ?? []), ...(self.tags ?? [])]));
      const mergedStats = self.stats === undefined && parent.stats === undefined
        ? undefined
        : { ...(parent.stats ?? {}), ...(self.stats ?? {}) };
      // animationSlots and morphValues shallow-merge by key; child wins per slot.
      const mergedSlots = self.animationSlots === undefined && parent.animationSlots === undefined
        ? undefined
        : { ...(parent.animationSlots ?? {}), ...(self.animationSlots ?? {}) };
      const mergedMorph = self.morphValues === undefined && parent.morphValues === undefined
        ? undefined
        : { ...(parent.morphValues ?? {}), ...(self.morphValues ?? {}) };
      const mergedMorphRanges = self.morphRanges === undefined && parent.morphRanges === undefined
        ? undefined
        : { ...(parent.morphRanges ?? {}), ...(self.morphRanges ?? {}) };
      effective = {
        id: self.id,
        ...(self.extends !== undefined && { extends: self.extends }),
        modelId:        self.modelId        ?? parent.modelId,
        modelScale:     self.modelScale     ?? parent.modelScale,
        category:       self.category       ?? parent.category,
        stateMachineId: self.stateMachineId ?? parent.stateMachineId,
        ...(mergedTags  !== undefined && { tags:  mergedTags  }),
        ...(mergedStats !== undefined && { stats: mergedStats }),
        ...(mergedSlots !== undefined && { animationSlots: mergedSlots }),
        ...(mergedMorph !== undefined && { morphValues: mergedMorph }),
        ...(mergedMorphRanges !== undefined && { morphRanges: mergedMorphRanges }),
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

/**
 * Validate the open-set fields a prefab can carry: `category`, `tags`, `stats`.
 * Component-data validation lives in `registerPrefab` (schema-checked against
 * each component's valibot schema). This pass only enforces shape on the
 * generic-item layer added in T-122.
 *
 * Abstract prefabs (`_`-prefixed) are skipped — they exist only as inheritance
 * roots and may legitimately carry partial/unfinished fields.
 */
function validatePrefabFields(p: Prefab): void {
  if (p.id.startsWith("_")) return;

  if (p.category !== undefined) {
    if (typeof p.category !== "string" || p.category.length === 0) {
      throw new Error(`Prefab '${p.id}': category must be a non-empty string`);
    }
  }

  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags)) {
      throw new Error(`Prefab '${p.id}': tags must be an array of strings`);
    }
    for (const t of p.tags) {
      if (typeof t !== "string" || t.length === 0) {
        throw new Error(`Prefab '${p.id}': every tag must be a non-empty string`);
      }
    }
  }

  if (p.stats !== undefined) {
    if (typeof p.stats !== "object" || Array.isArray(p.stats)) {
      throw new Error(`Prefab '${p.id}': stats must be an object`);
    }
    for (const [k, v] of Object.entries(p.stats)) {
      if (typeof k !== "string" || k.length === 0) {
        throw new Error(`Prefab '${p.id}': stat key must be a non-empty string`);
      }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`Prefab '${p.id}': stat '${k}' must be a finite number, got ${v}`);
      }
    }
  }
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
