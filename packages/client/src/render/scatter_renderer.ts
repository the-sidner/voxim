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
  /** Chunks queued during loading (drained across frames). `retries` bounds the
   *  wait for a chunk's material grid to arrive before giving up on floor scatter. */
  private readonly queue: Array<{ coord: string; kinds: Uint16Array; retries?: number }> = [];
  private active = false;
  private draining = false;
  /** True when any ScatterDef keys on a ground material → decoration must wait
   *  for the chunk's material grid, not just its kind grid. */
  private readonly needsMaterials: boolean;
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
    this.needsMaterials = this.defs.some((d) => d.material !== undefined);
    world.onChunkKinds((coord, kinds) => {
      if (!this.decorated.has(coord)) this.queue.push({ coord, kinds });
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

  /** Process one frame's worth of the queue, re-scheduling while work remains.
   *  Chunks whose material grid hasn't arrived defer (bounded by a retry cap) so
   *  floor scatter still lands once the grid streams in. */
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
        if (!this.decorateChunk(item.coord, item.kinds)) {
          const retries = (item.retries ?? 0) + 1;
          if (retries < 180) this.queue.push({ ...item, retries });  // ~3 s, then give up
        }
      }
      if (this.queue.length > 0) this.scheduleDrain();
    });
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
            canopyFade.register(material, { voxelMode: true, wind: true });
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

  /** Returns true once the chunk is decorated; false to DEFER (its material grid
   *  hasn't streamed in yet) so the caller can retry on a later frame. */
  private decorateChunk(coord: string, kinds: Uint16Array): boolean {
    if (this.decorated.has(coord)) return true;

    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));

    // Floor scatter keys on the GROUND material (grass/moss → ferns, mushrooms,
    // tufts) which lives on KindGrid=OPEN(0) cells; wall scatter keys on the
    // KindGrid kind (trees on FOREST walls). Resolve the material grid once;
    // defer the whole chunk until it has arrived if any def needs it.
    const materials = this.world.getMaterialData(cx, cy);
    if (this.needsMaterials && !materials) return false;

    this.decorated.add(coord);
    if (this.defs.length === 0) return true;

    for (const def of this.defs) {
      const variants = this.ensurePool(def);
      if (variants.length === 0) continue;

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
      const density = def.density ?? 1;

      const half = (def.stride / 2) | 0;
      const [jMin, jMax] = def.scaleJitter;
      for (let ly = half; ly < CHUNK_SIDE; ly += def.stride) {
        for (let lx = half; lx < CHUNK_SIDE; lx += def.stride) {
          const cellIdx = lx + ly * CHUNK_SIDE;
          const match = matIds !== undefined
            ? matIds.has(materials![cellIdx])
            : kinds[cellIdx] === def.kind;
          if (!match) continue;
          // Per-cell density gate (deterministic) so floor cover reads natural.
          if (density < 1) {
            const wxh = cx * CHUNK_SIDE + lx, wyh = cy * CHUNK_SIDE + ly;
            if ((hash2u(wxh ^ 0x9e37, wyh ^ 0x79b9) & 0xffff) / 0xffff > density) continue;
          }

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
    return true;
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
