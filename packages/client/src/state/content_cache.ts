/// <reference lib="dom" />
/**
 * ContentCache — thin synchronous read-through over the bootstrap
 * ContentService (T-177).
 *
 * All lookups resolve from the blob-hydrated ContentService the client
 * decodes at connect time; there is no network round-trip and no local
 * cache — StaticContentStore (the class BootstrapSource.load() actually
 * instantiates) already memoizes its own derived indexes (bone/clip/mask
 * indexes, model AABBs, hitbox templates), so keeping a second copy here
 * would just be a second place for it to drift.
 *
 * getX() and getXSync() all resolve the same way; the async signatures are kept
 * (rather than collapsed to sync) because callers (entity_mesh_registry.ts)
 * `.then()` off them with a stale-guard pattern that assumes a microtask
 * boundary.
 */
import type { ModelDefinition, MaterialDef, SkeletonDef, AnimationClip, BoneMask, HitboxPartTemplate, BoneDef, ContentService, Palette, GradeDef, LightDef, AtmosphereDef, GameConfig } from "@voxim/content";

export class ContentCache {
  /**
   * Bootstrap-delivered ContentService (T-177). Every lookup below resolves
   * through it; null only in the brief window before Game.start wires it.
   */
  private bootstrapService: ContentService | null = null;

  /** Wired by Game.start once the bootstrap blob has been decoded. */
  setBootstrapService(svc: ContentService | null): void {
    this.bootstrapService = svc;
  }

  /** Returns the model definition. */
  getModel(modelId: string): Promise<ModelDefinition | null> {
    return Promise.resolve(this.bootstrapService?.models.get(modelId) ?? null);
  }

  /** Returns the material definition. */
  getMaterial(materialId: number): Promise<MaterialDef | null> {
    return Promise.resolve(this.bootstrapService?.getMaterialById(materialId) ?? null);
  }

  /** Returns the skeleton definition. */
  getSkeleton(skeletonId: string): Promise<SkeletonDef | null> {
    return Promise.resolve(this.bootstrapService?.skeletons.get(skeletonId) ?? null);
  }

  /** Touches a model, its skeleton (if any), all its materials, and all sub-object
   * part models so every id an entity's model graph needs is confirmed resolvable
   * before the caller reads *Sync. For pool sub-objects every pool entry is
   * touched so any resolved variant is ready. */
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
    return this.bootstrapService?.models.get(modelId);
  }

  /** Name → MaterialDef via the bootstrap service (moss-creep target lookup). */
  getMaterialByName(name: string): MaterialDef | undefined {
    return this.bootstrapService?.materials.get(name);
  }

  getMaterialSync(materialId: number): MaterialDef | undefined {
    return this.bootstrapService?.getMaterialById(materialId);
  }

  /** The single color palette (T-280), from the bootstrap blob. Null until the
   *  bootstrap service is wired. */
  getPalette(): Palette | null {
    return this.bootstrapService?.getPalette() ?? null;
  }

  /** Colour grade by id (T-311 Phase 2), from the bootstrap blob. Null until
   *  the bootstrap service is wired or if the id is unknown. */
  getGrade(id: string): GradeDef | null {
    return this.bootstrapService?.grades.get(id) ?? null;
  }

  /** Light definition by id (T-311 P2), from the bootstrap blob. Null until the
   *  bootstrap service is wired or if the id is unknown. */
  getLight(id: string): LightDef | null {
    return this.bootstrapService?.lights.get(id) ?? null;
  }

  /** Atmosphere definition by id (T-311 P5a), from the bootstrap blob. Null
   *  until the bootstrap service is wired or if the id is unknown — callers
   *  fall back to `getAtmosphere("default")`. */
  getAtmosphere(id: string): AtmosphereDef | null {
    return this.bootstrapService?.atmospheres.get(id) ?? null;
  }

  /** Singleton game config, from the bootstrap blob. Null until the bootstrap
   *  service is wired. */
  getGameConfig(): GameConfig | null {
    return this.bootstrapService?.getGameConfig() ?? null;
  }

  getSkeletonSync(skeletonId: string): SkeletonDef | undefined {
    return this.bootstrapService?.skeletons.get(skeletonId);
  }

  getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip> {
    return this.bootstrapService?.getClipIndex(skeletonId) ?? new Map();
  }

  getMaskIndex(skeletonId: string): ReadonlyMap<string, BoneMask> {
    return this.bootstrapService?.getMaskIndex(skeletonId) ?? new Map();
  }

  getBoneIndex(skeletonId: string): ReadonlyMap<string, BoneDef> {
    return this.bootstrapService?.getBoneIndex(skeletonId) ?? new Map();
  }

  /** Voxel AABB for a model — memoized on the bootstrap ContentService (eager
   * at load, so this covers every model, not just already-fetched ones). */
  getModelAabb(modelId: string): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
    return this.bootstrapService?.getModelAabb(modelId) ?? null;
  }

  /** Hitbox capsule templates for a (modelId, seed, scale) combination —
   * memoized on the bootstrap ContentService. */
  getHitboxTemplate(modelId: string, seed: number, scale: number): HitboxPartTemplate[] {
    return this.bootstrapService?.getHitboxTemplate(modelId, seed, scale) ?? [];
  }
}
