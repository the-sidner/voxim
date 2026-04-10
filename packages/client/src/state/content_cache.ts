/// <reference lib="dom" />
/**
 * ContentCache — lazy-loads model and material definitions via the content
 * bidi stream.  Deduplicates in-flight requests so each definition is fetched
 * at most once per session.
 */
import type { ModelDefinition, MaterialDef, SkeletonDef, AnimationClip, BoneMask } from "@voxim/content";
import { buildClipIndex, buildMaskIndex } from "@voxim/content";
import type { TileConnection } from "../connection/tile_connection.ts";

export class ContentCache {
  private readonly models    = new Map<string, ModelDefinition>();
  private readonly materials = new Map<number, MaterialDef>();
  private readonly skeletons = new Map<string, SkeletonDef>();
  private readonly clipIndexCache = new Map<string, ReadonlyMap<string, AnimationClip>>();
  private readonly maskIndexCache = new Map<string, ReadonlyMap<string, BoneMask>>();

  // In-flight promises — prevents duplicate requests for the same key
  private readonly modelPending    = new Map<string, Promise<ModelDefinition | null>>();
  private readonly materialPending = new Map<number, Promise<MaterialDef | null>>();
  private readonly skeletonPending = new Map<string, Promise<SkeletonDef | null>>();

  constructor(private readonly connection: TileConnection) {}

  /** Returns the model definition, fetching it if not yet cached. */
  getModel(modelId: string): Promise<ModelDefinition | null> {
    const cached = this.models.get(modelId);
    if (cached) return Promise.resolve(cached);

    const existing = this.modelPending.get(modelId);
    if (existing) return existing;

    const p = this.connection
      .requestContent({ type: "model_req", modelId })
      .then((resp) => {
        this.modelPending.delete(modelId);
        if (resp.type === "model_def") {
          this.models.set(modelId, resp.def);
          return resp.def;
        }
        return null;
      })
      .catch(() => { this.modelPending.delete(modelId); return null; });

    this.modelPending.set(modelId, p);
    return p;
  }

  /** Returns the material definition, fetching it if not yet cached. */
  getMaterial(materialId: number): Promise<MaterialDef | null> {
    const cached = this.materials.get(materialId);
    if (cached) return Promise.resolve(cached);

    const existing = this.materialPending.get(materialId);
    if (existing) return existing;

    const p = this.connection
      .requestContent({ type: "material_req", materialId })
      .then((resp) => {
        this.materialPending.delete(materialId);
        if (resp.type === "material_def") {
          this.materials.set(materialId, resp.def);
          return resp.def;
        }
        return null;
      })
      .catch(() => { this.materialPending.delete(materialId); return null; });

    this.materialPending.set(materialId, p);
    return p;
  }

  /** Returns the skeleton definition, fetching it if not yet cached. */
  getSkeleton(skeletonId: string): Promise<SkeletonDef | null> {
    const cached = this.skeletons.get(skeletonId);
    if (cached) return Promise.resolve(cached);

    const existing = this.skeletonPending.get(skeletonId);
    if (existing) return existing;

    const p = this.connection
      .requestContent({ type: "skeleton_req", skeletonId })
      .then((resp) => {
        this.skeletonPending.delete(skeletonId);
        if (resp.type === "skeleton_def") {
          this.skeletons.set(skeletonId, resp.def);
          return resp.def;
        }
        return null;
      })
      .catch(() => { this.skeletonPending.delete(skeletonId); return null; });

    this.skeletonPending.set(skeletonId, p);
    return p;
  }

  /** Fetch a model, its skeleton (if any), all its materials, and all sub-object part models.
   * For pool sub-objects every pool entry is prefetched so any resolved variant is ready. */
  async prefetchModel(modelId: string): Promise<void> {
    const def = await this.getModel(modelId);
    if (!def) return;
    const fetches: Promise<unknown>[] = def.materials.map((id) => this.getMaterial(id));
    if (def.skeletonId) fetches.push(this.getSkeleton(def.skeletonId));
    for (const sub of def.subObjects) {
      if (sub.pool) {
        for (const poolId of sub.pool) fetches.push(this.prefetchModel(poolId));
      } else if (sub.modelId) {
        fetches.push(this.prefetchModel(sub.modelId));
      }
    }
    await Promise.all(fetches);
  }

  getModelSync(modelId: string): ModelDefinition | undefined {
    return this.models.get(modelId);
  }

  getMaterialSync(materialId: number): MaterialDef | undefined {
    return this.materials.get(materialId);
  }

  getSkeletonSync(skeletonId: string): SkeletonDef | undefined {
    return this.skeletons.get(skeletonId);
  }

  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip> {
    let idx = this.clipIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      idx = skeleton ? buildClipIndex(skeleton) : new Map();
      this.clipIndexCache.set(skeletonId, idx);
    }
    return idx;
  }

  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask> {
    let idx = this.maskIndexCache.get(skeletonId);
    if (!idx) {
      const skeleton = this.skeletons.get(skeletonId);
      idx = skeleton ? buildMaskIndex(skeleton) : new Map();
      this.maskIndexCache.set(skeletonId, idx);
    }
    return idx;
  }
}
