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
import type { MaterialDef, MaterialProperties, ModelDefinition, SkeletonDef, Recipe, LoreFragment, NpcTemplate, Prefab, GameConfig, TileLayout, WeaponActionDef, ActionDef, ActionGate, BehaviorTreeSpec, BiomeDef, ZoneDef, ResourceDef, TriggerDef, PuzzleDef, ProcModelDef, ScatterDef, GradeDef, LightDef,
  AtmosphereDef, WaterStyleDef, DecalDef, DissolveProfileDef, CliffProfileDef, Palette } from "./types.ts";
import { crossCheckFieldExpr } from "./field_expr.ts";
import { crossCheckBodyRecipe } from "./body_recipe.ts";
import { snapColorToRamp, hexStrToNum } from "./palette_snap.ts";
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
    weaponActionsRaw, actionsRaw, behaviorTreesRaw,
    biomesRaw, zonesRaw, poisRaw, resourcesRaw, triggersRaw, puzzlesRaw,
    procModelsRaw, scatterRaw, gradesRaw, lightsRaw, atmospheresRaw, waterStylesRaw, decalsRaw, dissolveProfilesRaw, cliffProfilesRaw, animLibraryArchetypes,
  ] = await Promise.all([
    readJsonDir(dataDir, "materials"),
    readJsonDir(dataDir, "models"),
    readJsonDir(dataDir, "skeletons"),
    readJsonDir(dataDir, "recipes"),
    readJsonDir(dataDir, "lore"),
    readJsonDir(dataDir, "prefabs"),
    readJsonDir(dataDir, "npcs"),
    readJsonDir(dataDir, "weapon_actions"),
    readJsonDirOptional(dataDir, "actions"),
    readJsonDir(dataDir, "behavior_trees"),
    readJsonDir(dataDir, "biomes"),
    readJsonDir(dataDir, "zones"),
    readJsonDirOptional(dataDir, "pois"),
    readJsonDirOptional(dataDir, "resources"),
    readJsonDirOptional(dataDir, "triggers"),
    readJsonDirOptional(dataDir, "puzzles"),
    readJsonDirOptional(dataDir, "procmodels"),
    readJsonDirOptional(dataDir, "scatter"),
    readJsonDirOptional(dataDir, "grades"),
    readJsonDirOptional(dataDir, "lights"),
    readJsonDirOptional(dataDir, "atmospheres"),
    readJsonDirOptional(dataDir, "water_styles"),
    readJsonDirOptional(dataDir, "decals"),
    readJsonDirOptional(dataDir, "dissolve_profiles"),
    readJsonDirOptional(dataDir, "cliff_profiles"),
    // T-178: anim_library is now organized as `{archetype}/{clipId}.json`
    // subfolders. Returns Map<archetype, clipFile[]>.
    readJsonArchetypeDirs(dataDir, "anim_library").catch(() => new Map()),
  ]);

  // Palette (T-280): the single color authority. Load it before materials so
  // each material color snaps to the nearest ramp swatch at registration —
  // cohesion enforced by the pipeline, not authoring discipline.
  const palette = await readJsonObject(dataDir, "palette.json") as unknown as Palette;
  store.setPalette(palette);
  // Auto-snap targets exclude the reserved `signal` swatches (fire/corruption/
  // vitals) so an ordinary earth material can't be pulled onto, say, blood or
  // rot. Materials that ARE signal (torch, corrupted) or whose nearest-color
  // misses intent (water → deep-water) are pinned by the `materials` overrides.
  const signal = new Set(palette.signal ?? []);
  const worldRamp = Object.entries(palette.ramp)
    .filter(([name]) => !signal.has(name))
    .map(([, hex]) => hexStrToNum(hex));
  const overrides = palette.materials ?? {};
  const swatchName = new Map<number, string>();
  for (const [name, hex] of Object.entries(palette.ramp)) swatchName.set(hexStrToNum(hex), name);
  const logSnaps = (() => { try { return !!Deno.env.get("VOXIM_PALETTE_LOG"); } catch { return false; } })();
  const hexOf = (c: number) => "#" + c.toString(16).padStart(6, "0");
  for (const raw of materialsRaw as RawMaterialDef[]) {
    const mat = parseMaterial(raw);
    const override = overrides[mat.name];
    const snapped = override !== undefined && palette.ramp[override] !== undefined
      ? hexStrToNum(palette.ramp[override])
      : snapColorToRamp(mat.color, worldRamp);
    if (logSnaps && snapped !== mat.color) {
      console.log(`[palette] ${mat.name.padEnd(14)} ${hexOf(mat.color)} → ${(swatchName.get(snapped) ?? "?").padEnd(11)} ${hexOf(snapped)}${override ? " (override)" : ""}`);
    }
    mat.color = snapped;
    // T-311 P4: the disturbanceField FieldExpr must reference known planes.
    if (mat.render?.relief?.disturbanceField) {
      crossCheckFieldExpr(mat.render.relief.disturbanceField, `Material '${mat.name}' relief.disturbanceField`);
    }
    store.registerMaterial(mat);
  }

  // T-315 A6: mossBlend.material names another material by NAME. Can't
  // inline-check in the loop above — materials register in filename order,
  // so a blend target may not be registered yet when the referencing
  // material's file is processed. Separate post-registration pass, same
  // shape as the scatter→procModel cross-check below.
  for (const mat of store.materials.values()) {
    const mb = mat.render?.mossBlend;
    if (mb && !store.materials.get(mb.material)) {
      throw new Error(
        `[content] material '${mat.name}' mossBlend.material references unknown material '${mb.material}'`,
      );
    }
  }

  for (const raw of modelsRaw as ModelDefinition[]) {
    store.registerModel(raw);
  }

  for (const raw of skeletonsRaw as SkeletonDef[]) {
    store.registerSkeleton(raw);
    // T-186 Layer 2: a skeleton's bodyRecipe part must name a real bone and
    // every formula field must resolve (at both morph extremes) against the
    // skeleton's own morphParams — fail fast, same stance as every other
    // content cross-check in this file.
    crossCheckBodyRecipe(raw);
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

  for (const raw of puzzlesRaw as PuzzleDef[]) {
    validatePuzzleDef(raw);
    store.registerPuzzle(raw);
  }

  // Procedural models + scatter (T-285) — visual-only content the client's
  // ScatterRenderer consumes. Register first, then cross-check scatter→procModel
  // once all procmodels are loaded (the generator id is checked client-side,
  // where the generator registry lives).
  for (const raw of procModelsRaw as ProcModelDef[]) {
    validateProcModelDef(raw);
    store.registerProcModel(raw);
  }
  for (const raw of scatterRaw as ScatterDef[]) {
    validateScatterDef(raw);
    store.registerScatter(raw);
  }
  for (const raw of gradesRaw as GradeDef[]) {
    store.registerGrade(raw);
  }
  for (const raw of lightsRaw as LightDef[]) {
    validateLightDef(raw);
    store.registerLight(raw);
  }
  for (const raw of atmospheresRaw as AtmosphereDef[]) {
    validateAtmosphereDef(raw);
    store.registerAtmosphere(raw);
  }
  if (!store.atmospheres.get("default")) {
    throw new Error(
      `[content] no "default" AtmosphereDef loaded — data/atmospheres/default.json ` +
      `must exist as the selector fallback.`,
    );
  }
  for (const raw of waterStylesRaw as WaterStyleDef[]) {
    validateWaterStyleDef(raw);
    store.registerWaterStyle(raw);
  }
  if (!store.waterStyles.get("default")) {
    throw new Error(
      `[content] no "default" WaterStyleDef loaded — data/water_styles/default.json ` +
      `must exist as the selector fallback.`,
    );
  }
  for (const raw of decalsRaw as DecalDef[]) {
    validateDecalDef(raw);
    store.registerDecal(raw);
  }
  for (const raw of dissolveProfilesRaw as DissolveProfileDef[]) {
    validateDissolveProfileDef(raw);
    store.registerDissolveProfile(raw);
  }
  for (const raw of cliffProfilesRaw as CliffProfileDef[]) {
    store.registerCliffProfile(raw);
  }
  for (const s of store.scatter.values()) {
    if (!store.procModels.get(s.procModel)) {
      throw new Error(`[content] scatter "${s.id}" references unknown procModel "${s.procModel}"`);
    }
    // T-311 P4: a morphField without tiers to select is an authoring error.
    if (s.morphField && !store.procModels.get(s.procModel)?.morphTiers?.length) {
      throw new Error(
        `[content] scatter "${s.id}" authors morphField but procModel "${s.procModel}" has no morphTiers`,
      );
    }
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
/**
 * Read an optional content directory: a MISSING directory is an empty
 * category; any other error (permissions, I/O) still fails the boot —
 * `.catch(() => [])` used to swallow those and silently boot a server
 * with zero actions (T-254).
 */
async function readJsonDirOptional(dir: string, subdir: string): Promise<unknown[]> {
  try {
    return await readJsonDir(dir, subdir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}

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

/**
 * Shape-validate one PuzzleDef (T-212 v2). `kind` membership in the
 * puzzle-kind registry (`poi/puzzle_kinds/mod.ts`) is the tile-server's
 * boot cross-check, same stance as TriggerDef's effect/gate checks.
 */
export function validatePuzzleDef(def: PuzzleDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`PuzzleDef: missing or empty id`);
  }
  if (typeof def.kind !== "string" || def.kind.length === 0) {
    throw new Error(`Puzzle '${def.id}': 'kind' must be a non-empty string`);
  }
}

/**
 * Shape-validate one ProcModelDef (T-285). `generator` membership in the
 * client generator registry is the CLIENT's boot cross-check (generators are
 * client-side); `params` is opaque (the generator interprets its own shape).
 */
export function validateProcModelDef(def: ProcModelDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`ProcModelDef: missing or empty id`);
  }
  if (typeof def.generator !== "string" || def.generator.length === 0) {
    throw new Error(`ProcModel '${def.id}': 'generator' must be a non-empty id`);
  }
  if (def.params === null || typeof def.params !== "object") {
    throw new Error(`ProcModel '${def.id}': 'params' must be an object`);
  }
  // T-311 P4: corruption-morph tiers — at most 3 overrides (4 tiers incl. base).
  if (def.morphTiers !== undefined) {
    if (!Array.isArray(def.morphTiers) || def.morphTiers.length < 1 || def.morphTiers.length > 3) {
      throw new Error(`ProcModel '${def.id}': 'morphTiers' must be an array of 1–3 param-override objects`);
    }
    for (const t of def.morphTiers) {
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        throw new Error(`ProcModel '${def.id}': every 'morphTiers' entry must be an object`);
      }
    }
  }
}

export function validateLightDef(def: LightDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`LightDef: missing or empty id`);
  }
  if (def.family !== "warm" && def.family !== "corruption" && def.family !== "cold") {
    throw new Error(`Light '${def.id}': 'family' must be 'warm' | 'corruption' | 'cold'`);
  }
  for (const k of ["baseColor", "radius", "intensity"] as const) {
    if (typeof def[k] !== "number") throw new Error(`Light '${def.id}': '${k}' must be a number`);
  }
}

/** Shape-validate one AtmosphereDef (T-311 P5a). Cross-checked at boot against
 *  `WorldClock.biomeTag`'s closed tag vocabulary is the SELECTOR's job (server
 *  boot, T-315 A6 house pattern) — this only validates the def's own shape. */
export function validateAtmosphereDef(def: AtmosphereDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`AtmosphereDef: missing or empty id`);
  }
  const sa = def.sunArc;
  if (!sa || typeof sa !== "object") {
    throw new Error(`Atmosphere '${def.id}': 'sunArc' must be an object`);
  }
  for (const k of ["dawnAzimuthDeg", "duskAzimuthDeg", "maxAltitudeDeg", "nightDepthDeg"] as const) {
    if (typeof sa[k] !== "number") {
      throw new Error(`Atmosphere '${def.id}': sunArc.${k} must be a number`);
    }
  }
  const m = def.mist;
  if (!m || typeof m !== "object") {
    throw new Error(`Atmosphere '${def.id}': 'mist' must be an object`);
  }
  if (typeof m.heightMin !== "number" || typeof m.heightMax !== "number" || m.heightMax < m.heightMin) {
    throw new Error(`Atmosphere '${def.id}': mist.heightMin/heightMax must be numbers with heightMax >= heightMin`);
  }
  if (!m.densityByPhase || typeof m.densityByPhase !== "object") {
    throw new Error(`Atmosphere '${def.id}': 'mist.densityByPhase' must be an object`);
  }
  if (typeof m.color !== "string" || m.color.length === 0) {
    throw new Error(`Atmosphere '${def.id}': 'mist.color' must be a non-empty hex string`);
  }
  const g = def.godRay;
  if (!g || typeof g !== "object") {
    throw new Error(`Atmosphere '${def.id}': 'godRay' must be an object`);
  }
  for (const k of ["intensity", "nearFieldRange", "decay", "strength"] as const) {
    if (typeof g[k] !== "number") {
      throw new Error(`Atmosphere '${def.id}': godRay.${k} must be a number`);
    }
  }
  if (typeof g.color !== "string" || g.color.length === 0) {
    throw new Error(`Atmosphere '${def.id}': 'godRay.color' must be a non-empty hex string`);
  }
}

/** Shape-validate one WaterStyleDef (T-311 P5b). */
export function validateWaterStyleDef(def: WaterStyleDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`WaterStyleDef: missing or empty id`);
  }
  for (const k of ["shallowColor", "deepColor"] as const) {
    if (typeof def[k] !== "string" || def[k].length === 0) {
      throw new Error(`WaterStyle '${def.id}': '${k}' must be a non-empty hex string`);
    }
  }
  if (typeof def.opacity !== "number") {
    throw new Error(`WaterStyle '${def.id}': 'opacity' must be a number`);
  }
  const w = def.waves;
  if (!w || typeof w !== "object") {
    throw new Error(`WaterStyle '${def.id}': 'waves' must be an object`);
  }
  for (const k of ["amplitude", "frequencyX", "frequencyZ", "speed"] as const) {
    if (!Array.isArray(w[k]) || w[k].length !== 3) {
      throw new Error(`WaterStyle '${def.id}': waves.${k} must be a 3-element array`);
    }
  }
  for (const k of ["normalScale", "lumDivisor"] as const) {
    if (typeof w[k] !== "number") {
      throw new Error(`WaterStyle '${def.id}': waves.${k} must be a number`);
    }
  }
  const f = def.fresnel;
  if (!f || typeof f !== "object") {
    throw new Error(`WaterStyle '${def.id}': 'fresnel' must be an object`);
  }
  for (const k of ["exponent", "tintStrength", "opacityBoost"] as const) {
    if (typeof f[k] !== "number") {
      throw new Error(`WaterStyle '${def.id}': fresnel.${k} must be a number`);
    }
  }
  const s = def.specular;
  if (!s || typeof s !== "object") {
    throw new Error(`WaterStyle '${def.id}': 'specular' must be an object`);
  }
  if (typeof s.exponent !== "number") {
    throw new Error(`WaterStyle '${def.id}': specular.exponent must be a number`);
  }
  if (!Array.isArray(s.gain) || s.gain.length !== 3) {
    throw new Error(`WaterStyle '${def.id}': specular.gain must be a 3-element array`);
  }
}

/** Shape-validate one ephemeral combat DecalDef (T-311 P4). The `source` id is
 *  cross-checked on the client against the decal-source registry (the closed
 *  event catalog); `material` against the material registry. */
export function validateDecalDef(def: DecalDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`DecalDef: missing or empty id`);
  }
  if (typeof def.source !== "string" || def.source.length === 0) {
    throw new Error(`Decal '${def.id}': 'source' must be a non-empty decal-source id`);
  }
  if (typeof def.material !== "string" || def.material.length === 0) {
    throw new Error(`Decal '${def.id}': 'material' must be a material name`);
  }
  if (!Array.isArray(def.count) || def.count.length !== 2 || def.count[0] < 0 || def.count[1] < def.count[0]) {
    throw new Error(`Decal '${def.id}': 'count' must be a [min,max] pair with 0 ≤ min ≤ max`);
  }
  if (!Array.isArray(def.sizeRange) || def.sizeRange.length !== 2 || def.sizeRange[0] <= 0) {
    throw new Error(`Decal '${def.id}': 'sizeRange' must be a positive [min,max] pair`);
  }
  if (typeof def.radius !== "number" || def.radius < 0) {
    throw new Error(`Decal '${def.id}': 'radius' must be ≥ 0`);
  }
  if (typeof def.ttlSeconds !== "number" || def.ttlSeconds <= 0
    || typeof def.fadeSeconds !== "number" || def.fadeSeconds < 0) {
    throw new Error(`Decal '${def.id}': 'ttlSeconds' must be > 0 and 'fadeSeconds' ≥ 0`);
  }
}

/** Shape-validate one DissolveProfileDef (T-311 P5c). `maxSeparatedVoxels` /
 *  `maxSeparationDistance` are the I3b hard caps — enforced positive so a
 *  zeroed-out profile can't silently disable the cost guard. */
export function validateDissolveProfileDef(def: DissolveProfileDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`DissolveProfileDef: missing or empty id`);
  }
  if (typeof def.frayBandWidth !== "number" || def.frayBandWidth < 0 || def.frayBandWidth > 1) {
    throw new Error(`DissolveProfileDef '${def.id}': 'frayBandWidth' must be in [0,1]`);
  }
  if (typeof def.driftSpeed !== "number" || def.driftSpeed < 0) {
    throw new Error(`DissolveProfileDef '${def.id}': 'driftSpeed' must be ≥ 0`);
  }
  if (typeof def.maxSeparatedVoxels !== "number" || def.maxSeparatedVoxels <= 0) {
    throw new Error(`DissolveProfileDef '${def.id}': 'maxSeparatedVoxels' must be > 0 (I3b hard cap)`);
  }
  if (typeof def.maxSeparationDistance !== "number" || def.maxSeparationDistance <= 0) {
    throw new Error(`DissolveProfileDef '${def.id}': 'maxSeparationDistance' must be > 0 (I3b hard cap)`);
  }
  if (typeof def.durationTicks !== "number" || def.durationTicks <= 0) {
    throw new Error(`DissolveProfileDef '${def.id}': 'durationTicks' must be > 0`);
  }
  if (def.phaseCurve !== undefined && def.phaseCurve !== "linear" && def.phaseCurve !== "smoothstep") {
    throw new Error(`DissolveProfileDef '${def.id}': 'phaseCurve' must be 'linear' | 'smoothstep'`);
  }
}

/** Shape-validate one ScatterDef (T-285). procModel→ProcModelDef membership is
 *  cross-checked after all are loaded (loader + client). */
export function validateScatterDef(def: ScatterDef): void {
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(`ScatterDef: missing or empty id`);
  }
  if (typeof def.procModel !== "string" || def.procModel.length === 0) {
    throw new Error(`Scatter '${def.id}': 'procModel' must be a non-empty id`);
  }
  // 'kind' and 'material' are mutually exclusive dispatch keys (mirrors
  // scatter_renderer.ts's own `matIds !== undefined ? ... : kinds[cellIdx] === def.kind`
  // branch): 'kind' is required when 'material' is absent, and must be
  // omitted (never silently ignored) when 'material' is present.
  if (def.material === undefined) {
    if (typeof def.kind !== "number" || !Number.isInteger(def.kind) || def.kind < 0) {
      throw new Error(`Scatter '${def.id}': 'kind' must be a non-negative integer boundary kind (required when 'material' is absent)`);
    }
  } else if (def.kind !== undefined) {
    throw new Error(`Scatter '${def.id}': 'kind' is ignored when 'material' is set — omit it`);
  }
  if (typeof def.pool !== "number" || def.pool < 1 || !Number.isInteger(def.pool)) {
    throw new Error(`Scatter '${def.id}': 'pool' must be a positive integer`);
  }
  if (typeof def.stride !== "number" || def.stride < 1) {
    throw new Error(`Scatter '${def.id}': 'stride' must be ≥ 1`);
  }
  if (!Array.isArray(def.scaleJitter) || def.scaleJitter.length !== 2) {
    throw new Error(`Scatter '${def.id}': 'scaleJitter' must be a [min,max] pair`);
  }
  // T-311 P4: a densityField FieldExpr must reference only known field planes.
  if (def.densityField) crossCheckFieldExpr(def.densityField, `ScatterDef '${def.id}'`);
  // T-311 P4: same for the corruption-morph tier selector (procModel morphTiers
  // membership is cross-checked with the other procModel refs after load).
  if (def.morphField) crossCheckFieldExpr(def.morphField, `ScatterDef '${def.id}' morphField`);
  if (def.cluster) {
    if (!Array.isArray(def.cluster.count) || def.cluster.count.length !== 2) {
      throw new Error(`Scatter '${def.id}': 'cluster.count' must be a [min,max] pair`);
    }
    if (typeof def.cluster.radius !== "number" || def.cluster.radius < 0) {
      throw new Error(`Scatter '${def.id}': 'cluster.radius' must be ≥ 0`);
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
  if (def.hitStopTicks !== undefined
    && (typeof def.hitStopTicks !== "number" || def.hitStopTicks < 0 || !Number.isFinite(def.hitStopTicks))) {
    throw new Error(`Action '${def.id}': hitStopTicks must be a non-negative number`);
  }
  if (def.preWindup !== undefined) {
    if (typeof def.preWindup.clipId !== "string" || def.preWindup.clipId.length === 0) {
      throw new Error(`Action '${def.id}': preWindup.clipId must be a non-empty string`);
    }
    if (typeof def.preWindup.ticks !== "number" || !Number.isInteger(def.preWindup.ticks) || def.preWindup.ticks <= 0) {
      throw new Error(`Action '${def.id}': preWindup.ticks must be a positive integer`);
    }
    const firstPhase = phaseNames[0];
    const firstPhaseTicks = def.phases[firstPhase]?.ticks ?? 0;
    if (firstPhaseTicks !== -1 && def.preWindup.ticks >= firstPhaseTicks) {
      throw new Error(
        `Action '${def.id}': preWindup.ticks (${def.preWindup.ticks}) must be < first phase '${firstPhase}'.ticks (${firstPhaseTicks})`,
      );
    }
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
