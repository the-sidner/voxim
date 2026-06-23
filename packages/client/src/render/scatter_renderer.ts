/**
 * ScatterRenderer (T-285c) — the general client prop scatterer, the visual
 * content-driven primitive. Replaces the one-off ForestPropsRenderer: instead of
 * the `FOREST_*` hardcodes + the authored `tree_oak` model, it walks every
 * `ScatterDef` (data/scatter/*.json) and renders a per-tile **VariantPool** of
 * procedurally-generated voxel models.
 *
 * Per tile, per ScatterDef: roll the tile seed → K sub-seeds → run the named
 * generator K× → bake K geometries → register K archetypes (`scatter:{id}:{i}|{m}`).
 * Per cell (strided over the chunk's KindGrid): pick `variant = hash(worldPos) %
 * K`, and ride the SUBTLE per-instance scale/rotation jitter on the instance
 * MATRIX — so scale stays out of the archetype key (the resolution of the
 * deferred T-281 archetype-explosion). Everything routes through the shared
 * bakeVoxels + buildVoxelMaterial + InstancePool kitchen, so the whole grim look
 * is inherited. See PROCMODEL_PRIMITIVE_PLAN.md.
 */
import * as THREE from "three";
import type { ContentService, ScatterDef } from "@voxim/content";
import type { ClientWorld } from "../state/client_world.ts";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { canopyFade } from "./canopy_fade.ts";
import { getGenerator, registerBuiltinGenerators } from "./procmodel/mod.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";

const CHUNK_SIDE = 32;
const HANDLE_PREFIX = "scatter:";
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** FNV-1a string hash (matches @voxim/world's seedFromTileId). */
function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 32-bit seed mixer (matches spawner.ts's mix32) — combines tile + variant. */
function mix32(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Cheap 2D integer hash for per-cell variant / rotation / scale selection. */
function hash2u(x: number, y: number): number {
  let n = ((x * 1619) ^ (y * 31337) ^ 0x9e3779b1) | 0;
  n = ((n << 13) ^ n) | 0;
  n = (n * ((n * n * 15731 + 789221) | 0) + 1376312589) | 0;
  return n >>> 0;
}

export class ScatterRenderer {
  /** Coords already decorated, keyed by "chunkX,chunkY". */
  private readonly decorated = new Set<string>();
  /** Built variant pools: scatterId → per-variant archetype-id lists. */
  private readonly pools = new Map<string, string[][]>();
  /** Chunks queued during loading (drained in start()). */
  private readonly queue: Array<{ coord: string; kinds: Uint16Array }> = [];
  private active = false;
  /** ScatterDefs grouped/ordered once; the cell walk consults their `kind`. */
  private readonly defs: ScatterDef[];

  constructor(
    private readonly instancePool: InstancePool,
    private readonly content: ContentService,
    private readonly world: ClientWorld,
    /** Per-tile seed (FNV-1a of the tileId) — makes the pool deterministic. */
    private readonly tileSeed: number,
  ) {
    registerBuiltinGenerators();
    this.defs = [...content.scatter.values()];
    world.onChunkKinds((coord, kinds) => {
      if (!this.active) {
        if (!this.decorated.has(coord)) this.queue.push({ coord, kinds });
        return;
      }
      this.decorateChunk(coord, kinds);
    });
  }

  /** Begin decorating; drain the queue across frames on an 8 ms budget so the
   *  first paint never blocks on a multi-hundred-prop pass. */
  start(): void {
    if (this.active) return;
    this.active = true;
    const drainBatch = () => {
      if (!this.active) return;
      const deadline = performance.now() + 8;
      while (this.queue.length > 0 && performance.now() < deadline) {
        const item = this.queue.shift()!;
        this.decorateChunk(item.coord, item.kinds);
      }
      if (this.queue.length > 0) requestAnimationFrame(drainBatch);
    };
    requestAnimationFrame(drainBatch);
  }

  /**
   * Build (once) the K-variant pool for a ScatterDef: run its generator K times
   * off deterministic sub-seeds, bake each variant's per-material geometry, and
   * register the archetypes. Returns the per-variant archetype-id lists.
   */
  private ensurePool(def: ScatterDef): string[][] {
    const cached = this.pools.get(def.id);
    if (cached) return cached;

    const pm = this.content.procModels.get(def.procModel);
    const gen = pm && getGenerator(pm.generator);
    const variants: string[][] = [];
    if (pm && gen) {
      const ctx = {
        resolveMaterial: (name: string) => {
          const m = this.content.materials.get(name);
          if (!m) throw new Error(`[scatter] procModel "${pm.id}" uses unknown material "${name}"`);
          return m.id;
        },
      };
      for (let i = 0; i < def.pool; i++) {
        const seed = mix32(this.tileSeed, hash32(def.id) ^ i);
        const atoms = gen(seed, pm.params, ctx);
        const matIds = [...new Set(atoms.map((a) => a.materialId))];
        const archIds: string[] = [];
        for (const m of matIds) {
          const archId = `${HANDLE_PREFIX}${def.id}:${i}|${m}`;
          if (!this.instancePool.hasArchetype(archId)) {
            const geometry = geometryFromBaked(bakeVoxels(atoms, m));
            const material = buildVoxelMaterial(this.content.getMaterialById(m), m);
            canopyFade.register(material, { voxelMode: true });
            this.instancePool.registerArchetype(archId, {
              geometry, material, castShadow: true, receiveShadow: true,
            });
          }
          archIds.push(archId);
        }
        variants.push(archIds);
      }
    }
    this.pools.set(def.id, variants);
    return variants;
  }

  private decorateChunk(coord: string, kinds: Uint16Array): void {
    if (this.decorated.has(coord)) return;
    this.decorated.add(coord);
    if (this.defs.length === 0) return;

    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));

    for (const def of this.defs) {
      const variants = this.ensurePool(def);
      if (variants.length === 0) continue;

      const half = (def.stride / 2) | 0;
      const [jMin, jMax] = def.scaleJitter;
      for (let ly = half; ly < CHUNK_SIDE; ly += def.stride) {
        for (let lx = half; lx < CHUNK_SIDE; lx += def.stride) {
          if (kinds[lx + ly * CHUNK_SIDE] !== def.kind) continue;

          const wx = cx * CHUNK_SIDE + lx + 0.5;
          const wy = cy * CHUNK_SIDE + ly + 0.5;
          const wz = this.world.getTerrainHeight(wx, wy);

          // Two decorrelated hashes: one drives variant + rotation, the other
          // the scale jitter, so visually-adjacent props don't lock-step.
          const h1 = hash2u(wx | 0, wy | 0);
          const h2 = hash2u(wy | 0, wx | 0);
          const variant = h1 % variants.length;
          const rotY = def.rotate ? ((h1 >>> 8) & 0xffff) / 0xffff * Math.PI * 2 : 0;
          const scale = def.baseScale * (jMin + (h2 / 0xffffffff) * (jMax - jMin));

          // model(x,y,z=up) → three(x, z, y); scale rides the matrix, NOT the key.
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(wx, wz, wy),
            new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotY),
            new THREE.Vector3(scale, scale, scale),
          );

          const slots: InstanceSlot[] = variants[variant].map((archetypeId) => ({
            archetypeId, matrix: matrix.clone(),
          }));
          if (slots.length === 0) continue;
          this.instancePool.add(`${HANDLE_PREFIX}${def.id}:${cx},${cy}:${lx},${ly}`, coord, slots);
        }
      }
    }
  }

  /** Drop every scatter handle on tile transition. Archetypes (geometry +
   *  material) stay registered — the renderer is per-session (one tile) while
   *  multi-tile is stubbed, so the tile-seeded variant ids never collide. */
  reset(): void {
    this.instancePool.removeByPrefix(HANDLE_PREFIX);
    this.decorated.clear();
    this.queue.length = 0;
    this.active = false;
  }
}
