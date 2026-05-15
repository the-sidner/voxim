/**
 * Bootstrap codec — serializes a full ContentService into a single binary
 * blob for delivery over the WebTransport handshake (T-177).
 *
 * Wire format:
 *
 *   uint32 LE  magic VOXB (0x564f5842)
 *   uint32 LE  version            — bump when schema changes
 *   uint32 LE  jsonGzippedLength
 *   bytes      jsonGzipped        — gzipped JSON of everything except animation libraries
 *   uint32 LE  animBinaryLength
 *   bytes      animBinary         — packed binary AnimationLibrary[] (see anim_codec.ts)
 *
 * Animation libraries are split out because their dense f32 keyframe tracks
 * dominate the payload: encoding 350+ clips as JSON inflates each f32 to a
 * 7-char string and gzip can't dedupe noisy float text, blowing the 16 MiB
 * frame cap. The packed binary form is ~5× smaller before any compression.
 *
 * Property: tile-server pre-builds the blob once at startup and sends it on
 * the join stream right after TileJoinAck. The client decodes and hydrates
 * a StaticContentStore — no per-lookup round-trips.
 */

import type { ContentService } from "./store.ts";
import { StaticContentStore } from "./store.ts";
import { encodeAnimationLibraries, decodeAnimationLibraries } from "./anim_codec.ts";
import type {
  MaterialDef, ModelDefinition, SkeletonDef, Recipe, NpcTemplate,
  BehaviorTreeSpec, BiomeDef, ZoneDef, LoreFragment, WeaponActionDef,
  ActionDef, VerbDef, ConceptVerbEntry, GameConfig, TileLayout, Prefab,
  BuffDef,
} from "./types.ts";

/** Wire schema version — bump when the envelope shape changes. */
export const BOOTSTRAP_VERSION = 9;

/** Magic 4-byte prefix on every blob. Catches misrouted bytes early. */
const MAGIC = 0x564f5842; // "VOXB" little-endian-readable

interface ContentBootstrapJson {
  materials:           MaterialDef[];
  models:              ModelDefinition[];
  skeletons:           SkeletonDef[];
  prefabs:             Prefab[];
  recipes:             Recipe[];
  npcTemplates:        NpcTemplate[];
  behaviorTrees:       BehaviorTreeSpec[];
  biomes:              BiomeDef[];
  zones:               ZoneDef[];
  loreFragments:       LoreFragment[];
  weaponActions:       WeaponActionDef[];
  actions:             ActionDef[];
  verbs:               VerbDef[];
  conceptVerbEntries:  ConceptVerbEntry[];
  buffs:               BuffDef[];
  gameConfig:          GameConfig;
  tileLayout:          TileLayout | null;
}

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // deno-lint-ignore no-explicit-any
  writer.write(input as any);
  writer.close();
  const out: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  let total = 0;
  for (const c of out) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of out) { merged.set(c, off); off += c.length; }
  return merged;
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  // deno-lint-ignore no-explicit-any
  writer.write(input as any);
  writer.close();
  const out: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  let total = 0;
  for (const c of out) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of out) { merged.set(c, off); off += c.length; }
  return merged;
}

/**
 * Encode a ContentService into a transport-ready blob.
 *
 * Animation libraries are packed binary; everything else round-trips as gzipped
 * JSON. The two pieces are concatenated with length prefixes inside the magic
 * + version envelope.
 */
export async function encodeBootstrap(service: ContentService): Promise<Uint8Array> {
  const jsonBody: ContentBootstrapJson = {
    materials:           [...service.materials.values()],
    models:              [...service.models.values()],
    skeletons:           [...service.skeletons.values()],
    prefabs:             [...service.prefabs.values()],
    recipes:             [...service.recipes.values()],
    npcTemplates:        [...service.npcTemplates.values()],
    behaviorTrees:       [...service.behaviorTrees.values()],
    biomes:              [...service.biomes.values()],
    zones:               [...service.zones.values()],
    loreFragments:       [...service.loreFragments.values()],
    weaponActions:       [...service.weaponActions.values()],
    actions:             [...service.actions.values()],
    verbs:               [...service.verbs.values()],
    conceptVerbEntries:  [...service.getAllConceptVerbEntries()],
    buffs:               [...service.buffs.values()],
    gameConfig:          service.getGameConfig(),
    tileLayout:          service.getTileLayout(),
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonBody));
  const jsonGzipped = await gzip(jsonBytes);

  const animBinary = encodeAnimationLibraries([...service.animationLibraries.values()]);

  const out = new Uint8Array(4 + 4 + 4 + jsonGzipped.length + 4 + animBinary.length);
  const view = new DataView(out.buffer);
  let off = 0;
  view.setUint32(off, MAGIC, true);                 off += 4;
  view.setUint32(off, BOOTSTRAP_VERSION, true);     off += 4;
  view.setUint32(off, jsonGzipped.length, true);    off += 4;
  out.set(jsonGzipped, off);                        off += jsonGzipped.length;
  view.setUint32(off, animBinary.length, true);     off += 4;
  out.set(animBinary, off);
  return out;
}

/**
 * Decode a blob produced by `encodeBootstrap` and hydrate a fresh
 * StaticContentStore.
 *
 * Throws on magic mismatch (caught at the call site by the network layer)
 * or version mismatch (caller should reload after a fresh handshake).
 */
export async function decodeBootstrap(blob: Uint8Array): Promise<ContentService> {
  if (blob.length < 16) {
    throw new Error(`bootstrap_codec: blob too short (${blob.length} bytes)`);
  }
  // Sub-slices share the underlying buffer at non-zero offsets, so anchor the
  // DataView to the blob's actual byte offset.
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`bootstrap_codec: bad magic 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== BOOTSTRAP_VERSION) {
    throw new Error(`bootstrap_codec: version ${version}, expected ${BOOTSTRAP_VERSION}`);
  }

  const jsonLen = view.getUint32(8, true);
  const jsonStart = 12;
  if (blob.length < jsonStart + jsonLen + 4) {
    throw new Error(`bootstrap_codec: truncated json body (claimed ${jsonLen} bytes)`);
  }
  const jsonGzipped = new Uint8Array(blob.buffer, blob.byteOffset + jsonStart, jsonLen);
  const jsonBytes = await gunzip(jsonGzipped);
  const body = JSON.parse(new TextDecoder().decode(jsonBytes)) as ContentBootstrapJson;

  const animLenOff = jsonStart + jsonLen;
  const animLen = view.getUint32(animLenOff, true);
  const animStart = animLenOff + 4;
  if (blob.length < animStart + animLen) {
    throw new Error(`bootstrap_codec: truncated anim section (claimed ${animLen} bytes)`);
  }
  const animBinary = new Uint8Array(blob.buffer, blob.byteOffset + animStart, animLen);
  const animationLibraries = decodeAnimationLibraries(animBinary);

  const store = new StaticContentStore();
  for (const m of body.materials)            store.registerMaterial(m);
  for (const m of body.models)               store.registerModel(m);
  for (const s of body.skeletons)            store.registerSkeleton(s);
  for (const lib of animationLibraries)      store.registerAnimationLibrary(lib);
  for (const p of body.prefabs)              store.registerPrefab(p);
  for (const r of body.recipes)              store.registerRecipe(r);
  for (const n of body.npcTemplates)         store.registerNpcTemplate(n);
  for (const t of body.behaviorTrees)        store.registerBehaviorTree(t);
  for (const b of body.biomes)               store.registerBiome(b);
  for (const z of body.zones)                store.registerZone(z);
  for (const l of body.loreFragments)        store.registerLoreFragment(l);
  for (const w of body.weaponActions)        store.registerWeaponAction(w);
  for (const a of body.actions)              store.registerAction(a);
  for (const v of body.verbs)                store.registerVerbDef(v);
  for (const e of body.conceptVerbEntries)   store.registerConceptVerbEntry(e);
  if (body.buffs) {
    for (const b of body.buffs)              store.registerBuff(b);
  }
  store.setGameConfig(body.gameConfig);
  if (body.tileLayout !== null) store.setTileLayout(body.tileLayout);

  return store;
}

/**
 * Loader class for the bootstrap-blob source. Mirrors JsonSource's static
 * `load()` shape so callers don't care which source built the content.
 */
export class BootstrapSource {
  static load(blob: Uint8Array): Promise<ContentService> {
    return decodeBootstrap(blob);
  }
}
