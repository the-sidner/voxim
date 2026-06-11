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
import type { MaterialDef, MaterialProperties, ModelDefinition, SkeletonDef, Recipe, LoreFragment, NpcTemplate, Prefab, ConceptVerbEntry, GameConfig, TileLayout, WeaponActionDef, ActionDef, ActionGate, VerbDef, BehaviorTreeSpec, BiomeDef, ZoneDef, ResourceDef, TriggerDef } from "./types.ts";
import { parsePoiDef } from "./poi_schema.ts";
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
    conceptVerbRaw, weaponActionsRaw, actionsRaw, verbsRaw, behaviorTreesRaw,
    biomesRaw, zonesRaw, poisRaw, resourcesRaw, triggersRaw, animLibraryArchetypes,
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
    readJsonDir(dataDir, "actions").catch(() => []),
    readJsonFile(dataDir, "verbs.json"),
    readJsonDir(dataDir, "behavior_trees"),
    readJsonDir(dataDir, "biomes"),
    readJsonDir(dataDir, "zones"),
    readJsonDir(dataDir, "pois").catch(() => []),
    readJsonDir(dataDir, "resources").catch(() => []),
    readJsonDir(dataDir, "triggers").catch(() => []),
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
  validatePrefabChildRefs(store);

  for (const raw of npcTemplatesRaw as NpcTemplate[]) {
    store.registerNpcTemplate(raw);
  }

  for (const raw of conceptVerbRaw as ConceptVerbEntry[]) {
    store.registerConceptVerbEntry(raw);
  }

  for (const raw of weaponActionsRaw as WeaponActionDef[]) {
    store.registerWeaponAction(raw);
  }

  // Actions (T-225) — validate each def's internal shape, then a final
  // cross-reference pass once all are loaded so cancel-target globs and
  // explicit ids can resolve against the full set.
  const actionDefs = actionsRaw as ActionDef[];
  for (const def of actionDefs) {
    validateActionDef(def);
    store.registerAction(def);
  }
  validateActionCrossRefs(actionDefs);

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

  // POIs (T-206) are validated via valibot at load time — malformed
  // authoring fails loud with the POI id + the offending field path.
  for (const raw of poisRaw) {
    store.registerPoi(parsePoiDef(raw));
  }



  for (const raw of resourcesRaw as ResourceDef[]) {
    validateResourceDef(raw);
    store.registerResource(raw);
  }

  for (const raw of triggersRaw as TriggerDef[]) {
    validateTriggerDef(raw);
    store.registerTrigger(raw);
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
        ...((self.actorSlots ?? parent.actorSlots) !== undefined && {
          actorSlots: self.actorSlots ?? parent.actorSlots,
        }),
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

  if (p.children !== undefined) {
    if (!Array.isArray(p.children)) {
      throw new Error(`Prefab '${p.id}': children must be an array`);
    }
    for (const c of p.children) {
      if (typeof c?.prefabId !== "string" || c.prefabId.length === 0) {
        throw new Error(`Prefab '${p.id}': every child needs a non-empty prefabId`);
      }
      if (c.local !== undefined) {
        if (typeof c.local !== "object" || Array.isArray(c.local)) {
          throw new Error(`Prefab '${p.id}': child '${c.prefabId}' local must be an object`);
        }
        for (const axis of ["x", "y", "z", "scale"] as const) {
          const v = c.local[axis];
          if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
            throw new Error(
              `Prefab '${p.id}': child '${c.prefabId}' local.${axis} must be a finite number`,
            );
          }
        }
      }
    }
  }
}

/**
 * After every prefab is registered, resolve `children[].prefabId` against
 * the full set (T-217). A child must reference a concrete prefab — unknown
 * or abstract (`_`-prefixed) targets fail loud here rather than at spawn.
 */
function validatePrefabChildRefs(store: ContentService): void {
  for (const p of store.prefabs.values()) {
    if (!p.children) continue;
    for (const c of p.children) {
      const target = store.prefabs.get(c.prefabId);
      if (!target) {
        throw new Error(
          `Prefab '${p.id}': child references unknown prefab '${c.prefabId}'`,
        );
      }
      if (target.id.startsWith("_")) {
        throw new Error(
          `Prefab '${p.id}': child '${c.prefabId}' is abstract and cannot be spawned`,
        );
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

const VALID_ACTION_KINDS = new Set(["active", "reaction", "ambient"]);
const VALID_ACTION_MOVEMENT = new Set(["free", "slowed", "locked"]);
const VALID_ACTION_EFFECT_EDGES = new Set(["enter", "exit", "tick"]);
const ACTION_PHASE_REF_RE = /^([^:]+):(enter|exit|tick)$/;

/**
 * Structural validation for one ActionDef. Cross-action references
 * (cancel-into target ids) are validated in a separate pass once all
 * actions have been loaded — see `validateActionCrossRefs`.
 */
/**
 * Validate a list of ActionGate references (preconditions / cancel gates).
 * Only structural validation here — that `gate` is a non-empty string and
 * `params` (if present) is a plain object. Whether the named gate exists in
 * the runtime registry is a runtime concern (the registry throws on unknown
 * ids); content load does not know the registered vocabulary.
 */
function validateActionGates(actionId: string, where: string, gates: ActionGate[]): void {
  if (!Array.isArray(gates)) {
    throw new Error(`Action '${actionId}' ${where}: must be an array`);
  }
  for (const g of gates) {
    if (!g || typeof g.gate !== "string" || g.gate.length === 0) {
      throw new Error(`Action '${actionId}' ${where}: every entry needs a non-empty 'gate'`);
    }
    if (g.params !== undefined && (typeof g.params !== "object" || Array.isArray(g.params) || g.params === null)) {
      throw new Error(`Action '${actionId}' ${where}: gate '${g.gate}' params must be an object`);
    }
  }
}

/**
 * Structural validation for ResourceDef (T-238) — same hand-rolled,
 * closed-vocabulary style as validateActionDef (no valibot, no DSL).
 * Cross-refs (effect/rateModifier ids exist in their registries) are
 * checked at server boot, like action gates/effects.
 */

/**
 * Shape-validate one TriggerDef (T-259). Registry membership of `on` /
 * `conditions[].gate` / `effects[].kind` is the server's boot cross-check
 * (the catalog and registries live there); this guards the JSON shape.
 */
export function validateTriggerDef(def: TriggerDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`TriggerDef: missing or empty id`);
  }
  if (typeof def.on !== "string" || def.on.length === 0) {
    throw new Error(`Trigger '${def.id}': 'on' must be a non-empty event kind`);
  }
  if (typeof def.as !== "string" || def.as.length === 0) {
    throw new Error(`Trigger '${def.id}': 'as' must be a non-empty role name`);
  }
  if (def.conditions !== undefined) {
    if (!Array.isArray(def.conditions)) {
      throw new Error(`Trigger '${def.id}': conditions must be an array`);
    }
    for (const c of def.conditions) {
      if (!c || typeof c.gate !== "string" || c.gate.length === 0) {
        throw new Error(`Trigger '${def.id}': every condition needs a non-empty 'gate'`);
      }
    }
  }
  if (def.internalCooldownTicks !== undefined
    && (typeof def.internalCooldownTicks !== "number" || def.internalCooldownTicks < 0
      || !Number.isFinite(def.internalCooldownTicks))) {
    throw new Error(`Trigger '${def.id}': internalCooldownTicks must be a non-negative number`);
  }
  if (!Array.isArray(def.effects) || def.effects.length === 0) {
    throw new Error(`Trigger '${def.id}': effects must be a non-empty array`);
  }
  for (const e of def.effects) {
    if (!e || typeof e.kind !== "string" || e.kind.length === 0) {
      throw new Error(`Trigger '${def.id}': every effect needs a non-empty 'kind'`);
    }
  }
}

export function validateResourceDef(def: ResourceDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`ResourceDef: missing or empty id`);
  }
  if (def.scope !== "entity" && def.scope !== "tile") {
    throw new Error(`Resource '${def.id}': scope must be 'entity' | 'tile', got '${def.scope}'`);
  }
  if (!def.bounds || typeof def.bounds !== "object"
    || typeof def.bounds.min !== "number" || !Number.isFinite(def.bounds.min)
    || typeof def.bounds.max !== "number" || !Number.isFinite(def.bounds.max)) {
    throw new Error(`Resource '${def.id}': bounds must be { min:number, max:number }`);
  }
  if (def.bounds.max < def.bounds.min) {
    throw new Error(`Resource '${def.id}': bounds.max < bounds.min`);
  }
  if (typeof def.rate !== "number" || !Number.isFinite(def.rate)) {
    throw new Error(`Resource '${def.id}': rate must be a finite number`);
  }
  if (def.rateModifiers !== undefined) {
    if (!Array.isArray(def.rateModifiers)) {
      throw new Error(`Resource '${def.id}': rateModifiers must be an array`);
    }
    for (const m of def.rateModifiers) {
      if (!m || typeof m.kind !== "string" || m.kind.length === 0) {
        throw new Error(`Resource '${def.id}': every rateModifier needs a non-empty 'kind'`);
      }
      if (m.params !== undefined && (typeof m.params !== "object" || Array.isArray(m.params) || m.params === null)) {
        throw new Error(`Resource '${def.id}': rateModifier '${m.kind}' params must be an object`);
      }
    }
  }
  if (def.thresholds !== undefined) {
    if (!Array.isArray(def.thresholds)) {
      throw new Error(`Resource '${def.id}': thresholds must be an array`);
    }
    for (const t of def.thresholds) {
      if (typeof t.at !== "number" || !Number.isFinite(t.at)) {
        throw new Error(`Resource '${def.id}': threshold.at must be a finite number`);
      }
      if (t.dir !== "above" && t.dir !== "below") {
        throw new Error(`Resource '${def.id}': threshold.dir must be 'above' | 'below', got '${t.dir}'`);
      }
      if (t.edge !== "cross" && t.edge !== "sustained") {
        throw new Error(`Resource '${def.id}': threshold.edge must be 'cross' | 'sustained', got '${t.edge}'`);
      }
      if (typeof t.effect !== "string" || t.effect.length === 0) {
        throw new Error(`Resource '${def.id}': threshold.effect must be a non-empty string`);
      }
      if (t.params !== undefined && (typeof t.params !== "object" || Array.isArray(t.params) || t.params === null)) {
        throw new Error(`Resource '${def.id}': threshold '${t.effect}' params must be an object`);
      }
    }
  }
}

export function validateActionDef(def: ActionDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`Action: missing or empty id`);
  }
  if (!VALID_ACTION_KINDS.has(def.kind)) {
    throw new Error(`Action '${def.id}': kind must be active|reaction|ambient, got '${def.kind}'`);
  }

  if (typeof def.slot !== "string" || def.slot.length === 0) {
    throw new Error(`Action '${def.id}': slot must be a non-empty string`);
  }
  if (def.limbs !== undefined) {
    if (!Array.isArray(def.limbs)) {
      throw new Error(`Action '${def.id}': limbs must be an array of strings`);
    }
    for (const limb of def.limbs) {
      if (typeof limb !== "string" || limb.length === 0) {
        throw new Error(`Action '${def.id}': every limb must be a non-empty string`);
      }
    }
  }

  if (!def.phases || typeof def.phases !== "object" || Array.isArray(def.phases)) {
    throw new Error(`Action '${def.id}': phases must be an object`);
  }
  const phaseNames = Object.keys(def.phases);
  if (phaseNames.length === 0) {
    throw new Error(`Action '${def.id}': must declare at least one phase`);
  }
  for (const [name, phase] of Object.entries(def.phases)) {
    if (!phase || typeof phase.ticks !== "number" || !Number.isInteger(phase.ticks)) {
      throw new Error(`Action '${def.id}' phase '${name}': ticks must be an integer`);
    }
    if (phase.ticks < -1) {
      throw new Error(`Action '${def.id}' phase '${name}': ticks must be >= -1`);
    }
    if (phase.ticks === -1 && def.kind !== "ambient") {
      throw new Error(`Action '${def.id}' phase '${name}': perpetual ticks (-1) is only valid for ambient actions`);
    }
  }

  if (!def.cancel || typeof def.cancel !== "object" || Array.isArray(def.cancel)) {
    throw new Error(`Action '${def.id}': cancel must be an object`);
  }
  for (const [phaseName, rule] of Object.entries(def.cancel)) {
    if (!phaseNames.includes(phaseName)) {
      throw new Error(`Action '${def.id}' cancel.${phaseName}: references undeclared phase`);
    }
    if (!rule || !Array.isArray(rule.into)) {
      throw new Error(`Action '${def.id}' cancel.${phaseName}: into must be an array`);
    }
    for (const target of rule.into) {
      if (typeof target !== "string" || target.length === 0) {
        throw new Error(`Action '${def.id}' cancel.${phaseName}: every target must be a non-empty string`);
      }
    }
    if (rule.gates !== undefined) {
      validateActionGates(def.id, `cancel.${phaseName}.gates`, rule.gates);
    }
  }

  if (!def.movement || typeof def.movement !== "object" || Array.isArray(def.movement)) {
    throw new Error(`Action '${def.id}': movement must be an object`);
  }
  for (const name of phaseNames) {
    const v = def.movement[name];
    if (v === undefined) {
      throw new Error(`Action '${def.id}' phase '${name}': movement value required (free|slowed|locked)`);
    }
    if (!VALID_ACTION_MOVEMENT.has(v)) {
      throw new Error(`Action '${def.id}' movement.${name}: must be free|slowed|locked, got '${v}'`);
    }
  }
  for (const name of Object.keys(def.movement)) {
    if (!phaseNames.includes(name)) {
      throw new Error(`Action '${def.id}' movement.${name}: references undeclared phase`);
    }
  }

  if (def.cooldownTicks !== undefined
    && (typeof def.cooldownTicks !== "number" || def.cooldownTicks < 0 || !Number.isFinite(def.cooldownTicks))) {
    throw new Error(`Action '${def.id}': cooldownTicks must be a non-negative number`);
  }
  if (def.triggersGcd !== undefined && typeof def.triggersGcd !== "boolean") {
    throw new Error(`Action '${def.id}': triggersGcd must be a boolean`);
  }
  if (def.costs !== undefined) {
    if (typeof def.costs !== "object" || Array.isArray(def.costs)) {
      throw new Error(`Action '${def.id}': costs must be an object`);
    }
    for (const [resource, value] of Object.entries(def.costs)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Action '${def.id}' costs.${resource}: must be a finite number`);
      }
    }
  }

  if (!Array.isArray(def.effects)) {
    throw new Error(`Action '${def.id}': effects must be an array`);
  }
  for (const eff of def.effects) {
    if (typeof eff.kind !== "string" || eff.kind.length === 0) {
      throw new Error(`Action '${def.id}': effect.kind must be a non-empty string`);
    }
    if (typeof eff.phase !== "string") {
      throw new Error(`Action '${def.id}': effect.phase must be a string of form '<phaseName>:enter|exit|tick'`);
    }
    const m = eff.phase.match(ACTION_PHASE_REF_RE);
    if (!m) {
      throw new Error(`Action '${def.id}': effect.phase '${eff.phase}' must be '<phaseName>:enter|exit|tick'`);
    }
    if (!phaseNames.includes(m[1])) {
      throw new Error(`Action '${def.id}': effect references undeclared phase '${m[1]}'`);
    }
    if (!VALID_ACTION_EFFECT_EDGES.has(m[2])) {
      throw new Error(`Action '${def.id}': effect edge must be enter|exit|tick, got '${m[2]}'`);
    }
  }

  if (def.animation !== undefined) {
    if (typeof def.animation !== "object" || Array.isArray(def.animation)) {
      throw new Error(`Action '${def.id}': animation must be an object`);
    }
    for (const [phaseName, anim] of Object.entries(def.animation)) {
      if (!phaseNames.includes(phaseName)) {
        throw new Error(`Action '${def.id}' animation.${phaseName}: references undeclared phase`);
      }
      if (typeof anim.clipId !== "string" || anim.clipId.length === 0) {
        throw new Error(`Action '${def.id}' animation.${phaseName}: clipId must be a non-empty string`);
      }
      if (anim.crouchClipId !== undefined && (typeof anim.crouchClipId !== "string" || anim.crouchClipId.length === 0)) {
        throw new Error(`Action '${def.id}' animation.${phaseName}: crouchClipId must be a non-empty string when present`);
      }
      if (anim.loop !== undefined && typeof anim.loop !== "boolean") {
        throw new Error(`Action '${def.id}' animation.${phaseName}: loop must be a boolean`);
      }
      if (
        anim.speedScale !== undefined &&
        anim.speedScale !== "velocity" &&
        (typeof anim.speedScale !== "number" || !Number.isFinite(anim.speedScale))
      ) {
        throw new Error(`Action '${def.id}' animation.${phaseName}: speedScale must be "velocity" or a finite number`);
      }
      if (anim.mask !== undefined && typeof anim.mask !== "string") {
        throw new Error(`Action '${def.id}' animation.${phaseName}: mask must be a string`);
      }
    }
  }

  if (def.preconditions !== undefined) {
    validateActionGates(def.id, "preconditions", def.preconditions);
  }

  if (def.kind === "reaction" && typeof def.interruptPriority !== "number") {
    throw new Error(`Action '${def.id}': reactions must declare interruptPriority (number)`);
  }
  if (def.priority !== undefined && typeof def.priority !== "number") {
    throw new Error(`Action '${def.id}': priority must be a number when present`);
  }
}

/**
 * Cross-reference validation: every non-glob cancel target must name an
 * existing action; every glob (`prefix_*`) must match at least one action
 * in the loaded set. The special token `"any"` is always allowed.
 *
 * Runs once after all defs are registered so id resolution sees the full
 * set, regardless of file order.
 */
export function validateActionCrossRefs(defs: ActionDef[]): void {
  const ids = new Set(defs.map((d) => d.id));
  for (const def of defs) {
    for (const [phaseName, rule] of Object.entries(def.cancel)) {
      for (const target of rule.into) {
        if (target === "any") continue;
        if (target.endsWith("*")) {
          const prefix = target.slice(0, -1);
          let matched = false;
          for (const id of ids) {
            if (id.startsWith(prefix)) { matched = true; break; }
          }
          if (!matched) {
            throw new Error(
              `Action '${def.id}' cancel.${phaseName}: glob '${target}' matches no loaded actions`,
            );
          }
        } else if (!ids.has(target)) {
          throw new Error(
            `Action '${def.id}' cancel.${phaseName}: unknown target '${target}'`,
          );
        }
      }
    }
  }
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
