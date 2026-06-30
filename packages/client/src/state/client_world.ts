/**
 * Client-side entity state store.
 *
 * Applies spawns, deltas, and destroys from the binary BinaryStateMessage stream,
 * plus unreliable WorldSnapshot datagrams for position interpolation.
 */
import type { BinaryComponentDelta, BinaryEntitySpawn, WorldSnapshot } from "@voxim/protocol";
import { ComponentType, COMPONENT_TYPE_TO_NAME, CODEC_BY_WIREID } from "@voxim/protocol";
// Only the terrain-grid codecs are referenced directly (their decode has chunk-
// binding side effects); every other component decodes through CODEC_BY_WIREID.
import { heightmapCodec, openMaskCodec, kindGridCodec, materialGridCodec, vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec } from "@voxim/codecs";
import type {
  VegFieldGridData, SurfaceStateGridData, WaterGridData,
  HeightmapData, MaterialGridData, OpenMaskData, KindGridData, ModelRefData, AnimationStateData,
  EquipmentData, InventoryData, BlueprintData, LightEmitterData, DarknessModifierData,
  ResourceData, ActionCooldownsData, ActiveActionsData,
  LoreLoadoutData,
  DurabilityData, CraftingQueueData, ItemDataData,
  WorkstationBufferData, WorkstationTagData,
  StatsData, ProvenanceData,
  GateLinkData,
  NameData,
  TraderInventoryData,
  JobBoardData,
  ContainerData,
} from "@voxim/codecs";

export interface PositionState  { x: number; y: number; z: number }
export interface VelocityState  { x: number; y: number; z: number }
export interface FacingState    { angle: number }
export interface HealthState    { current: number; max: number }
export interface WorldClockState  { ticksElapsed: number; dayLengthTicks: number }

export interface EntityState {
  position?: PositionState;
  velocity?: VelocityState;
  facing?: FacingState;
  health?: HealthState;
  /** All tick-scalars (stamina/hunger/thirst/poise/…) — vitals for the HUD (T-262). */
  resource?: ResourceData;
  /** Per-action cooldowns + GCD — drives the skill bar sweep (T-265). */
  actionCooldowns?: ActionCooldownsData;
  /** Action runtime: what's running in each slot + phase progress — drives the cast bar (T-266). */
  activeActions?: ActiveActionsData;
  heightmap?: HeightmapData;
  materialGrid?: MaterialGridData;
  openMask?: OpenMaskData;
  kindGrid?: KindGridData;
  vegFieldGrid?: VegFieldGridData;
  surfaceStateGrid?: SurfaceStateGridData;
  waterGrid?: WaterGridData;
  modelRef?: ModelRefData;
  animationState?: AnimationStateData;
  equipment?: EquipmentData;
  inventory?: InventoryData;
  blueprint?: BlueprintData;
  lightEmitter?: LightEmitterData;
  darknessModifier?: DarknessModifierData;
  loreLoadout?: LoreLoadoutData;
  durability?: DurabilityData;
  craftingQueue?: CraftingQueueData;
  itemData?: ItemDataData;
  workstationBuffer?: WorkstationBufferData;
  workstationTag?: WorkstationTagData;
  /** Trader catalogue — drives the trade panel when the player interacts (T-075). */
  traderInventory?: TraderInventoryData;
  /** Hiring board's pending jobs — drives the job-board panel when the player interacts (T-076). */
  jobBoard?: JobBoardData;
  /** Family chest slots — drives the deposit/withdraw panel when the player interacts (T-077/T-078). */
  container?: ContainerData;
  stats?: StatsData;
  provenance?: ProvenanceData;
  worldClock?: WorldClockState;
  gateLink?: GateLinkData;
  name?: NameData;
  /** Raw bytes for components the client doesn't decode eagerly, keyed by component name. */
  raw: Map<string, Uint8Array>;
  /** Per-component version counters (component type ID → version). Stale deltas are discarded. */
  versions: Map<number, number>;
}

function makeEntity(): EntityState {
  return { raw: new Map(), versions: new Map() };
}

const CHUNK_SIDE = 32;

export class ClientWorld {
  private readonly entities = new Map<string, EntityState>();
  private lastSnapshotTick = -1;
  /** Heightmap data indexed by "chunkX,chunkY" for O(1) terrain height queries. */
  private readonly chunkHeightmaps = new Map<string, Float32Array>();
  /**
   * OpenMask data indexed by "chunkX,chunkY". Drives client-side
   * impassability checks in the predictor so we don't rubber-band on
   * boundaries that don't show up as a heightmap step (vegetation, water).
   * Keyed by the SAME coord the heightmap is keyed by — they ride together
   * on the same chunk entity.
   */
  private readonly chunkOpenMasks = new Map<string, Uint8Array>();
  /**
   * KindGrid data indexed by "chunkX,chunkY". Drives client-side
   * decoration of closed cells (forest pixels render trees, stone
   * pixels render rocks, …) so trees etc. don't have to exist as
   * server entities. Same key convention as the heightmap/openMask.
   */
  private readonly chunkKinds = new Map<string, Uint16Array>();
  private readonly chunkMaterials = new Map<string, Uint16Array>();
  // T-311 P3 render-field grids (the full plane bundles — scatter samples several planes).
  private readonly chunkVegFields = new Map<string, VegFieldGridData>();
  private readonly chunkSurfaceStates = new Map<string, SurfaceStateGridData>();
  private readonly chunkWaterGrids = new Map<string, WaterGridData>();
  /**
   * Reverse map: chunk entityId → "chunkX,chunkY". Lets us index the
   * OpenMask / KindGrid deliveries (which don't carry chunkX/chunkY
   * themselves) into the per-coord caches via the chunk's already-known
   * heightmap key.
   */
  private readonly chunkCoordByEntity = new Map<string, string>();
  /**
   * Listeners notified after a chunk gains both its heightmap (so we
   * know the coord) and its kindGrid (so renderers have something to
   * decorate). Renderers register here to spawn forest/rock props on
   * demand instead of polling.
   */
  private readonly kindListeners: Array<(coord: string, kinds: Uint16Array) => void> = [];

  onChunkKinds(listener: (coord: string, kinds: Uint16Array) => void): void {
    this.kindListeners.push(listener);
    // Replay any chunks already loaded so a late-registered renderer
    // catches up without waiting for the next delta.
    for (const [coord, data] of this.chunkKinds) listener(coord, data);
  }

  private bindKinds(coord: string, data: Uint16Array): void {
    const prev = this.chunkKinds.get(coord);
    if (prev === data) return;
    this.chunkKinds.set(coord, data);
    for (const fn of this.kindListeners) fn(coord, data);
  }

  private applyComponentData(
    entity: EntityState,
    entityId: string,
    typeId: number,
    data: Uint8Array,
    version: number,
  ): void {
    // Version guard — version 0 means spawn (always accept); otherwise reject stale deltas
    if (version > 0) {
      const prev = entity.versions.get(typeId) ?? -1;
      if (version <= prev) return;
    }
    entity.versions.set(typeId, version);

    // Terrain-grid components have decode SIDE EFFECTS (binding chunk data into
    // this.chunk* maps, with a back-reference dance because openMask/kindGrid
    // arrive without chunk coords) beyond setting entity.X — so they stay
    // explicit. Everything else is registry-dispatched (T-284): one codec lookup
    // by wire id, assigned to the same-named EntityState field.
    switch (typeId) {
      case ComponentType.heightmap: {
        const hm = heightmapCodec.decode(data);
        entity.heightmap = hm;
        const key = `${hm.chunkX},${hm.chunkY}`;
        this.chunkHeightmaps.set(key, hm.data);
        this.chunkCoordByEntity.set(entityId, key);
        if (entity.openMask) this.chunkOpenMasks.set(key, entity.openMask.data);
        if (entity.kindGrid) this.bindKinds(key, entity.kindGrid.data);
        if (entity.materialGrid) this.chunkMaterials.set(key, entity.materialGrid.data);
        if (entity.vegFieldGrid) this.chunkVegFields.set(key, entity.vegFieldGrid);
        if (entity.surfaceStateGrid) this.chunkSurfaceStates.set(key, entity.surfaceStateGrid);
        if (entity.waterGrid) this.chunkWaterGrids.set(key, entity.waterGrid);
        return;
      }
      case ComponentType.openMask: {
        const om = openMaskCodec.decode(data);
        entity.openMask = om;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkOpenMasks.set(key, om.data);
        return;
      }
      case ComponentType.kindGrid: {
        const kg = kindGridCodec.decode(data);
        entity.kindGrid = kg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.bindKinds(key, kg.data);
        return;
      }
      case ComponentType.materialGrid: {
        const mg = materialGridCodec.decode(data);
        entity.materialGrid = mg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkMaterials.set(key, mg.data);
        return;
      }
      case ComponentType.vegFieldGrid: {
        const vg = vegFieldGridCodec.decode(data);
        entity.vegFieldGrid = vg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkVegFields.set(key, vg);
        return;
      }
      case ComponentType.surfaceStateGrid: {
        const sg = surfaceStateGridCodec.decode(data);
        entity.surfaceStateGrid = sg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkSurfaceStates.set(key, sg);
        return;
      }
      case ComponentType.waterGrid: {
        const wg = waterGridCodec.decode(data);
        entity.waterGrid = wg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkWaterGrids.set(key, wg);
        return;
      }
    }

    // Registry dispatch — the ComponentType key IS the EntityState field name,
    // so a wire-id → codec lookup + a same-named assignment replaces the old
    // 31-case switch (incl. the hand-rolled health/worldClock DataView decodes,
    // now healthCodec/worldClockCodec). Unknown ids fall through to `raw` for
    // forward-compat.
    const name = COMPONENT_TYPE_TO_NAME.get(typeId);
    if (!name) return;
    const codec = CODEC_BY_WIREID.get(typeId);
    if (codec) {
      (entity as unknown as Record<string, unknown>)[name] = codec.decode(data);
    } else {
      entity.raw.set(name, data);
    }
  }

  /** Apply a full entity spawn (all components at initial state). */
  applySpawn(spawn: BinaryEntitySpawn): void {
    let entity = this.entities.get(spawn.entityId);
    if (!entity) {
      entity = makeEntity();
      this.entities.set(spawn.entityId, entity);
    }
    for (const comp of spawn.components) {
      this.applyComponentData(entity, spawn.entityId, comp.componentType, comp.data, 0);
    }
  }

  /** Apply a single component delta for an already-known entity. */
  applyDelta(delta: BinaryComponentDelta): void {
    let entity = this.entities.get(delta.entityId);
    if (!entity) {
      entity = makeEntity();
      this.entities.set(delta.entityId, entity);
    }
    this.applyComponentData(entity, delta.entityId, delta.componentType, delta.data, delta.version);
  }

  /**
   * Apply an unreliable WorldSnapshot datagram.
   * Only updates entities already known; never creates new ones.
   * Stale snapshots (same or older serverTick) are discarded.
   */
  applySnapshot(snap: WorldSnapshot): void {
    if (snap.serverTick < this.lastSnapshotTick) return;
    this.lastSnapshotTick = snap.serverTick;
    for (const e of snap.entities) {
      const entity = this.entities.get(e.entityId);
      if (!entity) continue;
      entity.position = { x: e.x, y: e.y, z: e.z };
      entity.velocity = { x: e.vx, y: e.vy, z: e.vz };
      entity.facing   = { angle: e.facing };
    }
  }

  /**
   * Apply a component removal for an entity that REMAINS known (T-250). The
   * server dropped this component (settled item shedding Velocity, picked-up
   * item shedding Position, an expiring flag) — clear the decoded field so it
   * stops driving rendering/UI, and forget its version so a later re-add is
   * accepted. Whole-entity removal is `applyDestroy`, not this.
   */
  applyRemoval(entityId: string, componentType: number): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    entity.versions.delete(componentType);
    const name = COMPONENT_TYPE_TO_NAME.get(componentType);
    if (!name) return;
    // Decoded fields on EntityState are keyed by the component name
    // (entity.position, entity.velocity, …); undecoded ones live in `raw`.
    // Clear whichever holds it.
    if (entity.raw.has(name)) entity.raw.delete(name);
    else delete (entity as unknown as Record<string, unknown>)[name];
  }

  applyDestroy(entityId: string): void {
    this.entities.delete(entityId);
  }

  get(entityId: string): EntityState | undefined {
    return this.entities.get(entityId);
  }

  has(entityId: string): boolean {
    return this.entities.has(entityId);
  }

  entries(): IterableIterator<[string, EntityState]> {
    return this.entities.entries();
  }

  /**
   * Sample terrain height at a world position via NEAREST cell (matches the
   * server's terrain_lookup, which is explicitly non-bilinear — feet/props must
   * agree with the column-box top at model-z=h). Returns 0 for unloaded chunks;
   * callers near the tile edge can sample past the boundary, so this 0 is a
   * known bounded artifact (see T-311 follow-up — NaN-sentinel + scatter defer).
   */
  getTerrainHeight(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIDE);
    const cy = Math.floor(wy / CHUNK_SIDE);
    const data = this.chunkHeightmaps.get(`${cx},${cy}`);
    if (!data) return 0;
    const lx = Math.max(0, Math.min(CHUNK_SIDE - 1, Math.floor(wx - cx * CHUNK_SIDE)));
    const ly = Math.max(0, Math.min(CHUNK_SIDE - 1, Math.floor(wy - cy * CHUNK_SIDE)));
    return data[lx + ly * CHUNK_SIDE] ?? 0;
  }

  /**
   * Raw heightmap buffer for one chunk, or null if not yet loaded.  Used by
   * decorators that key off chunk-local cells (forest props, water surface).
   */
  getHeightmapData(chunkX: number, chunkY: number): Float32Array | null {
    return this.chunkHeightmaps.get(`${chunkX},${chunkY}`) ?? null;
  }

  /**
   * Raw per-cell material-id buffer for one chunk, or null if not yet loaded.
   * Lets decorators (floor scatter) place props by GROUND material — ferns on
   * grass/moss, etc. — not just by the wall-only KindGrid.
   */
  getMaterialData(chunkX: number, chunkY: number): Uint16Array | null {
    return this.chunkMaterials.get(`${chunkX},${chunkY}`) ?? null;
  }

  /** T-311 P3 render-field grid bundles for a chunk (null until streamed). The
   *  scatter renderer + future moss/wetness consumers sample their planes. */
  getVegFieldGrid(chunkX: number, chunkY: number): VegFieldGridData | null {
    return this.chunkVegFields.get(`${chunkX},${chunkY}`) ?? null;
  }
  getSurfaceStateGrid(chunkX: number, chunkY: number): SurfaceStateGridData | null {
    return this.chunkSurfaceStates.get(`${chunkX},${chunkY}`) ?? null;
  }
  getWaterGrid(chunkX: number, chunkY: number): WaterGridData | null {
    return this.chunkWaterGrids.get(`${chunkX},${chunkY}`) ?? null;
  }

  /**
   * Per-cell impassability check. Returns true (open) for unloaded chunks
   * so out-of-tile coordinates don't accidentally block — same convention
   * the server-side lookup uses.
   */
  isOpen(wx: number, wy: number): boolean {
    const cx = Math.floor(wx / CHUNK_SIDE);
    const cy = Math.floor(wy / CHUNK_SIDE);
    const data = this.chunkOpenMasks.get(`${cx},${cy}`);
    if (!data) return true;
    const lx = Math.max(0, Math.min(CHUNK_SIDE - 1, Math.floor(wx - cx * CHUNK_SIDE)));
    const ly = Math.max(0, Math.min(CHUNK_SIDE - 1, Math.floor(wy - cy * CHUNK_SIDE)));
    return data[lx + ly * CHUNK_SIDE] === 1;
  }

  clear(): void {
    this.entities.clear();
    this.chunkHeightmaps.clear();
    this.chunkOpenMasks.clear();
    this.chunkKinds.clear();
    this.chunkMaterials.clear();
    this.chunkVegFields.clear();
    this.chunkSurfaceStates.clear();
    this.chunkWaterGrids.clear();
    this.chunkCoordByEntity.clear();
  }
}
