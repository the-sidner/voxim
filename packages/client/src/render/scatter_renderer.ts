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
import { evaluateFieldExpr } from "@voxim/content";
import type { VegFieldGridData, SurfaceStateGridData, WaterGridData } from "@voxim/codecs";
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
/**
 * Closed-vocabulary read of a FIELD_NAME → [0,1] at one cell (T-311 P4). A
 * name→plane binding (not a switch on kind): the 9 u8 planes normalise by 255;
 * surfaceLevel (f32, NaN sentinel) maps present→1 / NaN→0 (never /255 — that
 * would poison the FieldExpr sum with NaN).
 */
function sampleField(
  field: string,
  veg: VegFieldGridData | null,
  surf: SurfaceStateGridData | null,
  water: WaterGridData | null,
  cellIdx: number,
): number {
  if (veg) {
    if (field === "canopyLight") return veg.canopyLight[cellIdx] / 255;
    if (field === "corruption") return veg.corruption[cellIdx] / 255;
    if (field === "fertility") return veg.fertility[cellIdx] / 255;
  }
  if (surf) {
    if (field === "wetness") return surf.wetness[cellIdx] / 255;
    if (field === "overgrowth") return surf.overgrowth[cellIdx] / 255;
    if (field === "wear") return surf.wear[cellIdx] / 255;
    if (field === "variantIndex") return surf.variantIndex[cellIdx] / 255;
    if (field === "ruinAge") return surf.ruinAge[cellIdx] / 255;
    if (field === "traffic") return surf.traffic[cellIdx] / 255;
  }
  if (field === "surfaceLevel") return water && !Number.isNaN(water.surfaceLevel[cellIdx]) ? 1 : 0;
  return 0;
}

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
  /** True when any ScatterDef drives density off a FieldExpr → decoration must
   *  wait for the chunk's VegFieldGrid/SurfaceStateGrid to stream (T-311 P4). */
  private readonly needsFields: boolean;
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
    this.needsFields = this.defs.some((d) => d.densityField !== undefined);
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
            const matDef = this.content.getMaterialById(m);
            const geometry = geometryFromBaked(bakeVoxels(atoms, m, undefined, matDef?.render?.tintJitter));
            const material = buildVoxelMaterial(matDef, m);
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

    // T-311 P4: per-cell density reads the render-field grids. Defer until they
    // stream (the retry queue gives ~3s); resolve once per chunk.
    const veg = this.needsFields ? this.world.getVegFieldGrid(cx, cy) : null;
    const surf = this.needsFields ? this.world.getSurfaceStateGrid(cx, cy) : null;
    const water = this.needsFields ? this.world.getWaterGrid(cx, cy) : null;
    if (this.needsFields && (!veg || !surf)) return false;

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
      const flatDensity = def.density ?? 1;
      const cluster = def.cluster;

      const half = (def.stride / 2) | 0;
      const [jMin, jMax] = def.scaleJitter;

      // Place ONE instance at a world position into `out`, with decorrelated
      // variant/rotation/scale. `hSel` drives variant + Y-rotation, `hScale` the
      // scale jitter (two hashes so visually-adjacent props don't lock-step);
      // scale rides the matrix, never the archetype key (the T-281 resolution).
      const buildSlots = (wx: number, wy: number, hSel: number, hScale: number, out: InstanceSlot[]) => {
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

      for (let ly = half; ly < CHUNK_SIDE; ly += def.stride) {
        for (let lx = half; lx < CHUNK_SIDE; lx += def.stride) {
          const cellIdx = lx + ly * CHUNK_SIDE;
          const match = matIds !== undefined
            ? matIds.has(materials![cellIdx])
            : kinds[cellIdx] === def.kind;
          if (!match) continue;

          // Per-cell field density [0,1]: a content FieldExpr over the render
          // fields (dense in fertile/shade, receding on dry rock / worn paths)
          // when authored, else the flat density. The organic-vs-uniform-carpet
          // lever (T-311 P4) — a hash only ever decorrelates, never decides density.
          const fieldDensity = (def.densityField && veg && surf)
            ? evaluateFieldExpr(def.densityField, (f) => sampleField(f, veg, surf, water, cellIdx))
            : flatDensity;

          const baseWx = cx * CHUNK_SIDE + lx + 0.5;
          const baseWy = cy * CHUNK_SIDE + ly + 0.5;
          const cellSlots: InstanceSlot[] = [];

          if (cluster) {
            // Field-sized CLUMP: count lerps 0→max with the field and the props
            // scatter in a disk of `radius`, so fertile cells read DENSE while dry
            // cells thin to nothing — the "combine primitives into density" lever.
            const n = Math.round(cluster.count[0] + (cluster.count[1] - cluster.count[0]) * fieldDensity);
            for (let k = 0; k < n; k++) {
              const hk = hash2u((baseWx * 13 + k * 0x9e37) | 0, (baseWy * 7 + k * 0x79b9) | 0);
              const ang = (hk & 0xffff) / 0xffff * Math.PI * 2;
              const rad = Math.sqrt(((hk >>> 16) & 0xffff) / 0xffff) * cluster.radius;  // sqrt → uniform disk
              buildSlots(baseWx + Math.cos(ang) * rad, baseWy + Math.sin(ang) * rad, hk, hash2u(hk | 0, k), cellSlots);
            }
          } else {
            // Single placement, hash-gated by the keep-probability.
            if (fieldDensity < 1) {
              const wxh = cx * CHUNK_SIDE + lx, wyh = cy * CHUNK_SIDE + ly;
              if ((hash2u(wxh ^ 0x9e37, wyh ^ 0x79b9) & 0xffff) / 0xffff > fieldDensity) continue;
            }
            buildSlots(baseWx, baseWy, hash2u(baseWx | 0, baseWy | 0), hash2u(baseWy | 0, baseWx | 0), cellSlots);
          }

          if (cellSlots.length === 0) continue;
          this.instancePool.add(`${HANDLE_PREFIX}${def.id}:${cx},${cy}:${lx},${ly}`, coord, cellSlots);
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
