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
import { evaluateFieldExpr, morphTierParams } from "@voxim/content";
import { CHUNK_SIZE } from "@voxim/world";
import { mix32 } from "@voxim/engine";
import type { ClientChunk, ClientWorld } from "../state/client_world.ts";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { canopyFade } from "./canopy_fade.ts";
import { getGenerator, registerBuiltinGenerators } from "./procmodel/mod.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";
import { sampleField } from "./field_sample.ts";

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

/** Cheap 2D integer hash for per-cell variant / rotation / scale selection. */
function hash2u(x: number, y: number): number {
  // Full-avalanche 2D hash (murmur3 finalizer via mix32). The previous
  // Perlin-style integer noise (n·(n²·15731+789221)+…) only mixes its HIGH
  // bits — its low 16 bits are heavily biased on cell lattices (measured
  // median 56576/65535), which silently broke every `(h & 0xffff)/0xffff`
  // probability gate (keep-gate, cluster dither) and the `% variants` pick.
  return mix32(Math.imul(x | 0, 0x1f1f1f1f) | 0, Math.imul(y | 0, 0x2545f491) | 0);
}

export class ScatterRenderer {
  /** Coords already decorated, keyed by "chunkX,chunkY". */
  private readonly decorated = new Set<string>();
  /** Built variant pools: scatterId → per-variant archetype-id lists. */
  private readonly pools = new Map<string, string[][]>();
  /** Chunks queued during loading (drained across frames) — ready chunks only,
   *  since `onChunkReady` already guarantees heightmap+materialGrid (and, in
   *  practice, every other grid: production always writes all seven grid
   *  components together at chunk creation). No retry machinery needed. */
  private readonly queue: Array<{ coord: string; chunk: ClientChunk }> = [];
  private active = false;
  private draining = false;
  /** ScatterDefs grouped/ordered once; the cell walk consults kind or material. */
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
    world.onChunkReady((coord, chunk) => {
      if (!this.decorated.has(coord) && chunk.kindGrid) {
        this.queue.push({ coord, chunk: chunk as ClientChunk });
      }
      if (this.active) this.scheduleDrain();
    });
  }

  /** Begin decorating; drain the queue across frames on an 8 ms budget so the
   *  first paint never blocks on a multi-hundred-prop pass. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleDrain();
  }

  /** Process one frame's worth of the queue, re-scheduling while work remains. */
  private scheduleDrain(): void {
    if (this.draining || !this.active) return;
    this.draining = true;
    requestAnimationFrame(() => {
      this.draining = false;
      if (!this.active) return;
      const deadline = performance.now() + 8;
      const n = this.queue.length;  // one pass; re-queued items wait for next rAF
      for (let i = 0; i < n && performance.now() < deadline; i++) {
        const item = this.queue.shift();
        if (!item) break;
        this.decorateChunk(item.coord, item.chunk);
      }
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  /**
   * Build (once) the K-variant pool for a ScatterDef at one morph `tier`: run
   * its generator K times off deterministic sub-seeds — tier > 0 deep-merges
   * `morphTiers[tier-1]` over the base params (corruption-morph, T-311 P4) —
   * bake each variant's per-material geometry, and register the archetypes.
   * Returns the per-variant archetype-id lists.
   */
  private ensurePool(def: ScatterDef, tier: number): string[][] {
    const poolKey = `${def.id}:t${tier}`;
    const cached = this.pools.get(poolKey);
    if (cached) return cached;

    const pm = this.content.procModels.get(def.procModel);
    const gen = pm && getGenerator(pm.generator);
    const variants: string[][] = [];
    if (pm && gen) {
      const params = morphTierParams(pm.params, pm.morphTiers, tier);
      const ctx = {
        resolveMaterial: (name: string) => {
          const m = this.content.materials.get(name);
          if (!m) throw new Error(`[scatter] procModel "${pm.id}" uses unknown material "${name}"`);
          return m.id;
        },
      };
      for (let i = 0; i < def.pool; i++) {
        const seed = mix32(this.tileSeed, hash32(def.id) ^ i);
        const atoms = gen(seed, params, ctx);
        const matIds = [...new Set(atoms.map((a) => a.materialId))];
        const archIds: string[] = [];
        for (const m of matIds) {
          const archId = `${HANDLE_PREFIX}${def.id}:t${tier}:${i}|${m}`;
          if (!this.instancePool.hasArchetype(archId)) {
            const matDef = this.content.getMaterialById(m);
            const geometry = geometryFromBaked(bakeVoxels(atoms, m, undefined, matDef?.render?.tintJitter));
            const material = buildVoxelMaterial(matDef, m);
            canopyFade.register(material, { wind: true });
            this.instancePool.registerArchetype(archId, {
              geometry, material, castShadow: true, receiveShadow: true,
            });
          }
          archIds.push(archId);
        }
        variants.push(archIds);
      }
    }
    this.pools.set(poolKey, variants);
    return variants;
  }

  /** Decorate one chunk. `onChunkReady` already guarantees heightmap +
   *  materialGrid; kindGrid is checked at the queue-push site above.
   *  vegFieldGrid/surfaceStateGrid/waterGrid ride the same chunk entity and
   *  production always writes them alongside heightmap/materialGrid, so no
   *  defer/retry is needed here — a def whose field genuinely never arrives
   *  (an old save predating T-311 P3) just reads a flat/neutral density. */
  private decorateChunk(coord: string, chunk: ClientChunk): void {
    if (this.decorated.has(coord)) return;

    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));
    const kinds = chunk.kindGrid!.data;

    // Floor scatter keys on the GROUND material (grass/moss → ferns, mushrooms,
    // tufts) which lives on KindGrid=OPEN(0) cells; wall scatter keys on the
    // KindGrid kind (trees on FOREST walls).
    const materials = chunk.materialGrid.data;
    const veg = chunk.vegFieldGrid ?? null;
    const surf = chunk.surfaceStateGrid ?? null;
    const water = chunk.waterGrid ?? null;

    this.decorated.add(coord);
    if (this.defs.length === 0) return;

    for (const def of this.defs) {
      const basePool = this.ensurePool(def, 0);
      if (basePool.length === 0) continue;
      // Corruption-morph (T-311 P4): the cell's SERVER field buckets into one
      // of the procModel's ≤4 tiers; each tier is its own variant pool.
      const morphTierCount = def.morphField
        ? 1 + (this.content.procModels.get(def.procModel)?.morphTiers?.length ?? 0)
        : 1;

      let matIds: Set<number> | undefined;
      if (def.material !== undefined) {
        const names = Array.isArray(def.material) ? def.material : [def.material];
        matIds = new Set<number>();
        for (const nm of names) {
          const m = this.content.materials.get(nm);
          if (m) matIds.add(m.id);
        }
        if (matIds.size === 0) continue;  // all names unknown (typo)
      }
      const flatDensity = def.density ?? 1;
      const cluster = def.cluster;

      const half = (def.stride / 2) | 0;
      const [jMin, jMax] = def.scaleJitter;

      // Place ONE instance at a world position into `out`, with decorrelated
      // variant/rotation/scale. `hSel` drives variant + Y-rotation, `hScale` the
      // scale jitter (two hashes so visually-adjacent props don't lock-step);
      // scale rides the matrix, never the archetype key (the T-281 resolution).
      const buildSlots = (variants: string[][], wx: number, wy: number, hSel: number, hScale: number, out: InstanceSlot[]) => {
        const wz = this.world.getTerrainHeight(wx, wy);
        const variant = hSel % variants.length;
        const rotY = def.rotate ? ((hSel >>> 8) & 0xffff) / 0xffff * Math.PI * 2 : 0;
        const scale = def.baseScale * (jMin + (hScale / 0xffffffff) * (jMax - jMin));
        // model(x,y,z=up) → three(x, z, y).
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(wx, wz, wy),
          new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotY),
          new THREE.Vector3(scale, scale, scale),
        );
        for (const archetypeId of variants[variant]) out.push({ archetypeId, matrix: matrix.clone() });
      };

      for (let ly = half; ly < CHUNK_SIZE; ly += def.stride) {
        for (let lx = half; lx < CHUNK_SIZE; lx += def.stride) {
          const cellIdx = lx + ly * CHUNK_SIZE;
          const match = matIds !== undefined
            ? matIds.has(materials[cellIdx])
            : kinds[cellIdx] === def.kind;
          if (!match) continue;

          // Per-cell field density [0,1]: a content FieldExpr over the render
          // fields (dense in fertile/shade, receding on dry rock / worn paths)
          // when authored, else the flat density. The organic-vs-uniform-carpet
          // lever (T-311 P4) — a hash only ever decorrelates, never decides density.
          const fieldDensity = (def.densityField && veg && surf)
            ? evaluateFieldExpr(def.densityField, (f) => sampleField(f, veg, surf, water, cellIdx))
            : flatDensity;

          // Corruption-morph tier: the server field decides which variant pool
          // grows here (bucketed, never a hash); tier 0 = the healthy base.
          const morphTier = (morphTierCount > 1 && veg && surf)
            ? Math.min(
              morphTierCount - 1,
              Math.floor(evaluateFieldExpr(def.morphField!, (f) => sampleField(f, veg, surf, water, cellIdx)) * morphTierCount),
            )
            : 0;
          const variants = morphTier === 0 ? basePool : this.ensurePool(def, morphTier);
          if (variants.length === 0) continue;

          const baseWx = cx * CHUNK_SIZE + lx + 0.5;
          const baseWy = cy * CHUNK_SIZE + ly + 0.5;
          const cellSlots: InstanceSlot[] = [];

          if (cluster) {
            // Field-sized CLUMP: count lerps 0→max with the field and the props
            // scatter in a disk of `radius`, so fertile cells read DENSE while dry
            // cells thin to nothing — the "combine primitives into density" lever.
            // The fractional part rounds STOCHASTICALLY (hash-dithered, the same
            // doctrine as the single-placement keep-gate below): a plain round()
            // cliffs everything under count 0.5 to 0, so low-density fields read
            // as EMPTY instead of sparse — the field decides the expected count,
            // the hash only dithers the quantisation.
            const x = cluster.count[0] + (cluster.count[1] - cluster.count[0]) * fieldDensity;
            const hq = hash2u((cx * CHUNK_SIZE + lx) ^ 0x5bd1, (cy * CHUNK_SIZE + ly) ^ 0xe995);
            const n = Math.floor(x) + (((hq & 0xffff) / 0xffff) < x - Math.floor(x) ? 1 : 0);
            for (let k = 0; k < n; k++) {
              const hk = hash2u((baseWx * 13 + k * 0x9e37) | 0, (baseWy * 7 + k * 0x79b9) | 0);
              const ang = (hk & 0xffff) / 0xffff * Math.PI * 2;
              const rad = Math.sqrt(((hk >>> 16) & 0xffff) / 0xffff) * cluster.radius;  // sqrt → uniform disk
              buildSlots(variants, baseWx + Math.cos(ang) * rad, baseWy + Math.sin(ang) * rad, hk, hash2u(hk | 0, k), cellSlots);
            }
          } else {
            // Single placement, hash-gated by the keep-probability.
            if (fieldDensity < 1) {
              const wxh = cx * CHUNK_SIZE + lx, wyh = cy * CHUNK_SIZE + ly;
              if ((hash2u(wxh ^ 0x9e37, wyh ^ 0x79b9) & 0xffff) / 0xffff > fieldDensity) continue;
            }
            buildSlots(variants, baseWx, baseWy, hash2u(baseWx | 0, baseWy | 0), hash2u(baseWy | 0, baseWx | 0), cellSlots);
          }

          if (cellSlots.length === 0) continue;
          this.instancePool.add(`${HANDLE_PREFIX}${def.id}:${cx},${cy}:${lx},${ly}`, coord, cellSlots);
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
