/**
 * Client-side entity state store.
 *
 * Applies spawns, deltas, and destroys from the binary BinaryStateMessage stream,
 * plus unreliable WorldSnapshot datagrams for position interpolation.
 */
import type { BinaryComponentDelta, BinaryEntitySpawn, WorldSnapshot } from "@voxim/protocol";
import { ComponentType, COMPONENT_TYPE_TO_NAME, CODEC_BY_WIREID } from "@voxim/protocol";
import { CHUNK_SIZE } from "@voxim/world";
import { Parent } from "@voxim/engine";
import type { ParentData } from "@voxim/engine";
// Only the terrain-grid codecs are referenced directly (their decode has chunk-
// binding side effects); every other component decodes through CODEC_BY_WIREID.
import { heightmapCodec, openMaskCodec, kindGridCodec, materialGridCodec, vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec, cliffGridCodec } from "@voxim/codecs";
import type {
  VegFieldGridData, SurfaceStateGridData, WaterGridData, CliffGridData,
  HeightmapData, MaterialGridData, OpenMaskData, KindGridData, ModelRefData, AnimationStateData,
  EquipmentData, InventoryData, BlueprintData, LightEmitterData,
  ResourceData, ActionCooldownsData, ActiveActionsData,
  LoreLoadoutData,
  DurabilityData, ItemDataData,
  WorkstationBufferData, WorkstationTagData,
  StatsData, ProvenanceData,
  GateLinkData,
  NameData,
  TraderInventoryData,
  JobBoardData,
  ContainerData,
  PoiInteractableData,
  HeritageData,
  BoneData,
} from "@voxim/codecs";

export interface PositionState  { x: number; y: number; z: number }
export interface VelocityState  { x: number; y: number; z: number }
export interface FacingState    { angle: number }
export interface HealthState    { current: number; max: number }
export interface WorldClockState  { ticksElapsed: number; dayLengthTicks: number; biomeTag: string }

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
  cliffGrid?: CliffGridData;
  modelRef?: ModelRefData;
  animationState?: AnimationStateData;
  equipment?: EquipmentData;
  inventory?: InventoryData;
  blueprint?: BlueprintData;
  lightEmitter?: LightEmitterData;
  loreLoadout?: LoreLoadoutData;
  durability?: DurabilityData;
  itemData?: ItemDataData;
  workstationBuffer?: WorkstationBufferData;
  workstationTag?: WorkstationTagData;
  /** Trader catalogue — drives the trade panel when the player interacts (T-075). */
  traderInventory?: TraderInventoryData;
  /** Hiring board's pending jobs — drives the job-board panel when the player interacts (T-076). */
  jobBoard?: JobBoardData;
  /** Family chest slots — drives the deposit/withdraw panel when the player interacts (T-077/T-078). */
  container?: ContainerData;
  /** `action`/`puzzle` POI world-prop marker (chalice pedestal, signal brazier,
   *  lever, …) — drives the violet hover outline and the Use-key UseEntity
   *  verb (T-212 v2). */
  poiInteractable?: PoiInteractableData;
  /** dynastyId/generation/traits — the local player's own copy tells the client
   *  it just respawned as an heir (a generation bump) and which family chests
   *  are its own, T-072. */
  heritage?: HeritageData;
  stats?: StatsData;
  provenance?: ProvenanceData;
  worldClock?: WorldClockState;
  gateLink?: GateLinkData;
  name?: NameData;
  /**
   * Scene-graph parent (T-219/T-220) — the engine's own Parent component.
   * `ClientWorld`'s childrenIndex (T-223) is derived from this field, kept
   * in sync on every spawn/delta/removal/destroy — see `childrenOf`/
   * `descendants`. `entity_mesh_registry.ts` resolves equipment attachment
   * bones through that index (T-223); `entity_mesh.ts`'s `boneGroups` pose
   * hierarchy is unaffected — it still comes from content `SkeletonDef`
   * data, never from entity transforms (bones carry none).
   */
  parent?: ParentData;
  /** One entity per skeleton bone (T-219) — boneId only, see BoneData. */
  bone?: BoneData;
  /** Raw bytes for components the client doesn't decode eagerly, keyed by component name. */
  raw: Map<string, Uint8Array>;
  /** Per-component version counters (component type ID → version). Stale deltas are discarded. */
  versions: Map<number, number>;
}

function makeEntity(): EntityState {
  return { raw: new Map(), versions: new Map() };
}

/**
 * One chunk's decoded terrain grids, keyed by "chunkX,chunkY" in
 * `ClientWorld`'s single chunk map. `heightmap` and `materialGrid` are the
 * only fields guaranteed present — they're the two components every chunk
 * entity always carries (game.ts's loading gate has always been
 * `state.heightmap && state.materialGrid`). The other six ride the same
 * chunk entity but ship as separate wire components; production always
 * writes all eight together at chunk creation (`chunksFromBuffers`), so in
 * practice they arrive in the SAME spawn message — but nothing here assumes
 * that ordering: fields are filled in as their deltas/spawn-components
 * decode, in whatever order they arrive.
 */
export interface ClientChunk {
  chunkX: number;
  chunkY: number;
  heightmap: HeightmapData;
  materialGrid: MaterialGridData;
  openMask?: OpenMaskData;
  kindGrid?: KindGridData;
  vegFieldGrid?: VegFieldGridData;
  surfaceStateGrid?: SurfaceStateGridData;
  waterGrid?: WaterGridData;
  cliffGrid?: CliffGridData;
}

/** Fields guaranteed non-undefined on a ClientChunk once `onChunkReady` fires. */
type ReadyChunk = ClientChunk & Required<Pick<ClientChunk, "heightmap" | "materialGrid">>;

export class ClientWorld {
  private readonly entities = new Map<string, EntityState>();
  private lastSnapshotTick = -1;

  /** Single grid owner: one entry per chunk coord, filled in as grid
   *  components decode (in any order). Replaces the old parallel
   *  chunk* maps. */
  private readonly chunks = new Map<string, Partial<ClientChunk>>();
  /**
   * Reverse map: chunk entityId → "chunkX,chunkY". The wire's openMask/
   * kindGrid/vegFieldGrid/surfaceStateGrid/waterGrid/cliffGrid components
   * don't carry their own chunkX/chunkY — this recovers the coord so their
   * deltas can still find (or create) the right `chunks` entry even if they
   * arrive before the chunk's heightmap.
   */
  private readonly chunkCoordByEntity = new Map<string, string>();
  /**
   * Listeners notified once a chunk reaches "ready" (heightmap + materialGrid
   * both present — the same bar game.ts's loading gate has always used).
   * Renderers register here to build terrain/scatter/water for a chunk
   * instead of polling or hand-rolling their own retry queues.
   */
  private readonly readyListeners: Array<(coord: string, chunk: ReadyChunk) => void> = [];
  private readonly readyCoords = new Set<string>();

  /**
   * Scene-graph reverse index (T-223): parent entityId → its direct
   * children. Mirrors engine `World`'s `childIndex` (packages/engine/src/
   * world.ts) — the client's own half of the same scene graph, kept in
   * sync from the replicated `Parent` component instead of local writes.
   * Maintained by `applyComponentData`'s explicit `parent` case,
   * `applyRemoval`, and `applyDestroy`; read via `childrenOf`/`descendants`.
   * Indexed defensively: a child's declared parent need not itself be a
   * known entity (it may have left AoI, or arrive out of order) — the
   * bucket is keyed by parentId regardless of whether that id has ever
   * been spawned.
   */
  private readonly childrenIndex = new Map<string, Set<string>>();

  /**
   * Subscribe to chunk-ready notifications. Fires once per chunk, at the
   * first spawn/delta BATCH boundary where both `heightmap` and
   * `materialGrid` are present — never mid-decode, so every grid that rode
   * the same message (openMask, kindGrid, vegFieldGrid, surfaceStateGrid,
   * waterGrid, cliffGrid) is already bound when listeners run. Today's
   * production path writes all eight together at chunk creation, so in
   * practice all eight are present; callers that need one of the six
   * non-gating grids should still null-check it (an old save predating
   * T-311 P3/P6 may lack fields).
   *
   * Replays every chunk already ready so a late-registered listener catches
   * up without waiting for the next delta.
   */
  onChunkReady(listener: (coord: string, chunk: ReadyChunk) => void): void {
    this.readyListeners.push(listener);
    for (const coord of this.readyCoords) {
      const chunk = this.chunks.get(coord);
      if (chunk && isReady(chunk)) listener(coord, chunk);
    }
  }

  private chunkFor(coord: string): Partial<ClientChunk> {
    let c = this.chunks.get(coord);
    if (!c) {
      c = {};
      this.chunks.set(coord, c);
    }
    return c;
  }

  private maybeFireReady(coord: string): void {
    if (this.readyCoords.has(coord)) return;
    const chunk = this.chunks.get(coord);
    if (!chunk || !isReady(chunk)) return;
    this.readyCoords.add(coord);
    for (const fn of this.readyListeners) fn(coord, chunk);
  }

  /** Add `childId` to `parentId`'s child bucket, creating it if needed. */
  private addToChildIndex(parentId: string, childId: string): void {
    let set = this.childrenIndex.get(parentId);
    if (!set) {
      set = new Set();
      this.childrenIndex.set(parentId, set);
    }
    set.add(childId);
  }

  /** Remove `childId` from `parentId`'s child bucket, pruning the bucket
   *  once empty (unbounded-session hygiene — items/corpses churn a lot). */
  private removeFromChildIndex(parentId: string, childId: string): void {
    const set = this.childrenIndex.get(parentId);
    if (!set) return;
    set.delete(childId);
    if (set.size === 0) this.childrenIndex.delete(parentId);
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
    // the single `chunks` map, with a back-reference dance because openMask/
    // kindGrid/etc. arrive without chunk coords) beyond setting entity.X — so
    // they stay explicit. `parent` joins this list (T-223): its decode also
    // maintains `childrenIndex`, moving `entityId` out of its OLD parent's
    // bucket (if any) and into its new one. Everything else is
    // registry-dispatched (T-284): one codec lookup by wire id, assigned to
    // the same-named EntityState field.
    switch (typeId) {
      case ComponentType.parent: {
        const p = Parent.codec.decode(data);
        const oldParentId = entity.parent?.entityId ?? null;
        entity.parent = p;
        if (oldParentId !== p.entityId) {
          if (oldParentId) this.removeFromChildIndex(oldParentId, entityId);
          if (p.entityId) this.addToChildIndex(p.entityId, entityId);
        }
        return;
      }
      case ComponentType.heightmap: {
        const hm = heightmapCodec.decode(data);
        entity.heightmap = hm;
        const key = `${hm.chunkX},${hm.chunkY}`;
        this.chunkCoordByEntity.set(entityId, key);
        const chunk = this.chunkFor(key);
        chunk.chunkX = hm.chunkX;
        chunk.chunkY = hm.chunkY;
        chunk.heightmap = hm;
        return;
      }
      case ComponentType.openMask: {
        const om = openMaskCodec.decode(data);
        entity.openMask = om;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).openMask = om;
        return;
      }
      case ComponentType.kindGrid: {
        const kg = kindGridCodec.decode(data);
        entity.kindGrid = kg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).kindGrid = kg;
        return;
      }
      case ComponentType.materialGrid: {
        const mg = materialGridCodec.decode(data);
        entity.materialGrid = mg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).materialGrid = mg;
        return;
      }
      case ComponentType.vegFieldGrid: {
        const vg = vegFieldGridCodec.decode(data);
        entity.vegFieldGrid = vg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).vegFieldGrid = vg;
        return;
      }
      case ComponentType.surfaceStateGrid: {
        const sg = surfaceStateGridCodec.decode(data);
        entity.surfaceStateGrid = sg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).surfaceStateGrid = sg;
        return;
      }
      case ComponentType.waterGrid: {
        const wg = waterGridCodec.decode(data);
        entity.waterGrid = wg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).waterGrid = wg;
        return;
      }
      case ComponentType.cliffGrid: {
        const cg = cliffGridCodec.decode(data);
        entity.cliffGrid = cg;
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkFor(key).cliffGrid = cg;
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

  /** Apply a full entity spawn (all components at initial state).
   *  Chunk-ready fires only AFTER the whole spawn is applied — never from
   *  inside a component case — so every grid that rode this spawn (kindGrid,
   *  the field grids) is already bound when listeners run. Firing mid-decode
   *  (the old materialGrid-case call) handed scatter a chunk whose kindGrid
   *  hadn't decoded yet; the one-shot ready event then never re-fired and the
   *  chunk stayed bare forever (T-315 E2 regression). */
  applySpawn(spawn: BinaryEntitySpawn): void {
    let entity = this.entities.get(spawn.entityId);
    if (!entity) {
      entity = makeEntity();
      this.entities.set(spawn.entityId, entity);
    }
    for (const comp of spawn.components) {
      this.applyComponentData(entity, spawn.entityId, comp.componentType, comp.data, 0);
    }
    const key = this.chunkCoordByEntity.get(spawn.entityId);
    if (key) this.maybeFireReady(key);
  }

  /** Apply a single component delta for an already-known entity. */
  applyDelta(delta: BinaryComponentDelta): void {
    let entity = this.entities.get(delta.entityId);
    if (!entity) {
      entity = makeEntity();
      this.entities.set(delta.entityId, entity);
    }
    this.applyComponentData(entity, delta.entityId, delta.componentType, delta.data, delta.version);
    const key = this.chunkCoordByEntity.get(delta.entityId);
    if (key) this.maybeFireReady(key);
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
    // Defensive (T-223): no current server path wire-removes Parent (a
    // reparent-to-root ships as a value change to {entityId: null}, not a
    // removal) — but treat one as reverting to root, same effect, so the
    // child index can't desync if that ever changes.
    if (componentType === ComponentType.parent) {
      const oldParentId = entity.parent?.entityId ?? null;
      if (oldParentId) this.removeFromChildIndex(oldParentId, entityId);
      delete entity.parent;
      return;
    }
    const name = COMPONENT_TYPE_TO_NAME.get(componentType);
    if (!name) return;
    // Decoded fields on EntityState are keyed by the component name
    // (entity.position, entity.velocity, …); undecoded ones live in `raw`.
    // Clear whichever holds it.
    if (entity.raw.has(name)) entity.raw.delete(name);
    else delete (entity as unknown as Record<string, unknown>)[name];
  }

  applyDestroy(entityId: string): void {
    // Unordered relative to a child's own destroy (aoi.ts §3) — both
    // directions (this entity leaving its parent's bucket, this entity's
    // own bucket being dropped) are independent operations, safe in either
    // order.
    const entity = this.entities.get(entityId);
    const parentId = entity?.parent?.entityId ?? null;
    if (parentId) this.removeFromChildIndex(parentId, entityId);
    this.childrenIndex.delete(entityId);
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
   * Direct scene-graph children of `id` (a snapshot array), [] if none —
   * including when `id` was never itself spawned (T-223's defensive-
   * indexing case: a child can arrive before, or without, its parent).
   * O(1) via `childrenIndex`.
   */
  childrenOf(id: string): string[] {
    const set = this.childrenIndex.get(id);
    return set ? [...set] : [];
  }

  /**
   * All descendants of `root` (depth-first, excludes `root` itself),
   * PARENT-BEFORE-CHILD order — mirrors engine `World.descendants()`'s
   * exact stack/pop DFS shape (packages/engine/src/world.ts) so this holds
   * the same ordering invariant `aoi.ts`'s spawn walk already relies on
   * server-side. O(subtree).
   */
  descendants(root: string): string[] {
    const out: string[] = [];
    const stack = [...this.childrenOf(root)];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      const kids = this.childrenIndex.get(id);
      if (kids) for (const k of kids) stack.push(k);
    }
    return out;
  }

  /** The chunk at (chunkX, chunkY), or undefined if no grid data has arrived
   *  yet. Fields beyond heightmap/materialGrid may be undefined even once
   *  the chunk exists — see `onChunkReady`'s doc for the guarantee. */
  getChunk(chunkX: number, chunkY: number): Partial<ClientChunk> | undefined {
    return this.chunks.get(`${chunkX},${chunkY}`);
  }

  /**
   * Sample terrain height at a world position via NEAREST cell (matches the
   * server's terrain_lookup, which is explicitly non-bilinear — feet/props must
   * agree with the column-box top at model-z=h). Returns 0 for unloaded chunks;
   * callers near the tile edge can sample past the boundary, so this 0 is a
   * known bounded artifact (see T-311 follow-up — NaN-sentinel + scatter defer).
   */
  getTerrainHeight(wx: number, wy: number): number {
    const chunkX = Math.floor(wx / CHUNK_SIZE);
    const chunkY = Math.floor(wy / CHUNK_SIZE);
    const data = this.chunks.get(`${chunkX},${chunkY}`)?.heightmap?.data;
    if (!data) return 0;
    const lx = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(wx - chunkX * CHUNK_SIZE)));
    const ly = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(wy - chunkY * CHUNK_SIZE)));
    return data[lx + ly * CHUNK_SIZE] ?? 0;
  }

  /**
   * Raw heightmap buffer for one chunk, or null if not yet loaded.  Used by
   * decorators that key off chunk-local cells (forest props, water surface).
   */
  getHeightmapData(chunkX: number, chunkY: number): Float32Array | null {
    return this.chunks.get(`${chunkX},${chunkY}`)?.heightmap?.data ?? null;
  }

  /**
   * Raw per-cell material-id buffer for one chunk, or null if not yet loaded.
   * Lets decorators (floor scatter) place props by GROUND material — ferns on
   * grass/moss, etc. — not just by the wall-only KindGrid.
   */
  getMaterialData(chunkX: number, chunkY: number): Uint16Array | null {
    return this.chunks.get(`${chunkX},${chunkY}`)?.materialGrid?.data ?? null;
  }

  /**
   * Per-cell impassability check. Returns true (open) for unloaded chunks
   * so out-of-tile coordinates don't accidentally block — same convention
   * the server-side lookup uses.
   */
  isOpen(wx: number, wy: number): boolean {
    const chunkX = Math.floor(wx / CHUNK_SIZE);
    const chunkY = Math.floor(wy / CHUNK_SIZE);
    const data = this.chunks.get(`${chunkX},${chunkY}`)?.openMask?.data;
    if (!data) return true;
    const lx = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(wx - chunkX * CHUNK_SIZE)));
    const ly = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(wy - chunkY * CHUNK_SIZE)));
    return data[lx + ly * CHUNK_SIZE] === 1;
  }

  /**
   * The tile's WorldClock singleton (T-311 P5a), or null before it's spawned.
   * There is exactly one such entity per tile — a linear scan is cheap next
   * to entity-state decode and avoids a second cache to keep in sync on tile
   * transition (entities.clear() already invalidates this for free).
   */
  getWorldClock(): WorldClockState | null {
    for (const [, state] of this.entities) {
      if (state.worldClock) return state.worldClock;
    }
    return null;
  }

  clear(): void {
    this.entities.clear();
    this.chunks.clear();
    this.chunkCoordByEntity.clear();
    this.readyCoords.clear();
    this.childrenIndex.clear();
    // Re-arm the snapshot staleness guard: each tile server's tick counter
    // starts at 0 at its own boot, so after a tile transition the new tile's
    // WorldSnapshot ticks can be far below the old tile's — without this
    // reset every datagram from the new tile would be silently discarded.
    this.lastSnapshotTick = -1;
  }
}

function isReady(chunk: Partial<ClientChunk>): chunk is ReadyChunk {
  return chunk.heightmap !== undefined && chunk.materialGrid !== undefined;
}
