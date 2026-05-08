/**
 * Bootstrap codec — serializes a full ContentService into a single binary
 * blob for delivery over the WebTransport handshake (T-177).
 *
 * Wire format:
 *
 *   uint32 LE  version           — bump when schema changes (currently 1)
 *   uint32 LE  bodyLength        — bytes of UTF-8 JSON that follow
 *   bytes      bodyJson          — JSON.stringify of the ContentBootstrap envelope
 *
 * The body holds every registry's contents as plain JS objects plus the
 * singleton config. JSON keeps the implementation simple at the cost of
 * ~2x bytes vs a tagged binary encoding; the full content blob is
 * expected to land in the 1-5 MB compressed range, well under what a
 * single WT-stream send can handle.
 *
 * On the server: build the blob once at startup, send to every joining
 * client immediately after TileJoinAck. On the client: decode → hydrate
 * a StaticContentStore → expose as ContentService. No round-trips needed
 * for individual lookups.
 */

import type { ContentService } from "./store.ts";
import { StaticContentStore } from "./store.ts";
import type {
  MaterialDef, ModelDefinition, SkeletonDef, Recipe, NpcTemplate,
  BehaviorTreeSpec, BiomeDef, ZoneDef, LoreFragment, WeaponActionDef,
  VerbDef, ConceptVerbEntry, GameConfig, TileLayout, Prefab,
  AnimationLibrary,
} from "./types.ts";

/** Wire schema version — bump when the envelope shape changes. */
export const BOOTSTRAP_VERSION = 1;

/** Magic 4-byte prefix on every blob. Catches misrouted bytes early. */
const MAGIC = 0x564f5842; // "VOXB" little-endian-readable

interface ContentBootstrap {
  materials:           MaterialDef[];
  models:              ModelDefinition[];
  skeletons:           SkeletonDef[];
  animationLibraries:  AnimationLibrary[];
  prefabs:             Prefab[];
  recipes:             Recipe[];
  npcTemplates:        NpcTemplate[];
  behaviorTrees:       BehaviorTreeSpec[];
  biomes:              BiomeDef[];
  zones:               ZoneDef[];
  loreFragments:       LoreFragment[];
  weaponActions:       WeaponActionDef[];
  verbs:               VerbDef[];
  conceptVerbEntries:  ConceptVerbEntry[];
  gameConfig:          GameConfig;
  tileLayout:          TileLayout | null;
}

/**
 * Encode a ContentService into a transport-ready blob.
 *
 * Iterates each registry once, captures the singleton config, JSON-encodes,
 * and prepends the magic + version + length frame.
 */
export function encodeBootstrap(service: ContentService): Uint8Array {
  const body: ContentBootstrap = {
    materials:           [...service.materials.values()],
    models:              [...service.models.values()],
    skeletons:           [...service.skeletons.values()],
    animationLibraries:  [...service.animationLibraries.values()],
    prefabs:             [...service.prefabs.values()],
    recipes:             [...service.recipes.values()],
    npcTemplates:        [...service.npcTemplates.values()],
    behaviorTrees:       [...service.behaviorTrees.values()],
    biomes:              [...service.biomes.values()],
    zones:               [...service.zones.values()],
    loreFragments:       [...service.loreFragments.values()],
    weaponActions:       [...service.weaponActions.values()],
    verbs:               [...service.verbs.values()],
    conceptVerbEntries:  [...service.getAllConceptVerbEntries()],
    gameConfig:          service.getGameConfig(),
    tileLayout:          service.getTileLayout(),
  };

  const json = JSON.stringify(body);
  const jsonBytes = new TextEncoder().encode(json);
  const out = new Uint8Array(12 + jsonBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, BOOTSTRAP_VERSION, true);
  view.setUint32(8, jsonBytes.length, true);
  out.set(jsonBytes, 12);
  return out;
}

/**
 * Decode a blob produced by `encodeBootstrap` and hydrate a fresh
 * StaticContentStore. Returns it typed as ContentService — consumers don't
 * need to know it's the in-memory implementation.
 *
 * Throws on magic mismatch (caught at the call site by the network layer)
 * or version mismatch (caller should reload after a fresh handshake).
 */
export function decodeBootstrap(blob: Uint8Array): ContentService {
  if (blob.length < 12) {
    throw new Error(`bootstrap_codec: blob too short (${blob.length} bytes)`);
  }
  // Use a DataView aligned to the blob's actual byte offset — Uint8Array
  // sub-slices share the underlying buffer at non-zero offsets.
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`bootstrap_codec: bad magic 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== BOOTSTRAP_VERSION) {
    throw new Error(`bootstrap_codec: version ${version}, expected ${BOOTSTRAP_VERSION}`);
  }
  const len = view.getUint32(8, true);
  if (blob.length < 12 + len) {
    throw new Error(`bootstrap_codec: truncated body (claimed ${len} bytes, blob has ${blob.length - 12})`);
  }
  const jsonBytes = new Uint8Array(blob.buffer, blob.byteOffset + 12, len);
  const body = JSON.parse(new TextDecoder().decode(jsonBytes)) as ContentBootstrap;

  const store = new StaticContentStore();
  for (const m of body.materials)            store.registerMaterial(m);
  for (const m of body.models)               store.registerModel(m);
  for (const s of body.skeletons)            store.registerSkeleton(s);
  for (const lib of body.animationLibraries) store.registerAnimationLibrary(lib);
  for (const p of body.prefabs)              store.registerPrefab(p);
  for (const r of body.recipes)              store.registerRecipe(r);
  for (const n of body.npcTemplates)         store.registerNpcTemplate(n);
  for (const t of body.behaviorTrees)        store.registerBehaviorTree(t);
  for (const b of body.biomes)               store.registerBiome(b);
  for (const z of body.zones)                store.registerZone(z);
  for (const l of body.loreFragments)        store.registerLoreFragment(l);
  for (const w of body.weaponActions)        store.registerWeaponAction(w);
  for (const v of body.verbs)                store.registerVerbDef(v);
  for (const e of body.conceptVerbEntries)   store.registerConceptVerbEntry(e);
  store.setGameConfig(body.gameConfig);
  if (body.tileLayout !== null) store.setTileLayout(body.tileLayout);

  return store;
}

/**
 * Loader class for the bootstrap-blob source. Mirrors JsonSource's static
 * `load()` shape so callers don't care which source built the content.
 */
export class BootstrapSource {
  static load(blob: Uint8Array): ContentService {
    return decodeBootstrap(blob);
  }
}
