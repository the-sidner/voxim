/**
 * Client-side entity state store.
 *
 * Applies spawns, deltas, and destroys from the binary BinaryStateMessage stream,
 * plus unreliable WorldSnapshot datagrams for position interpolation.
 */
import type { BinaryComponentDelta, BinaryEntitySpawn, WorldSnapshot } from "@voxim/protocol";
import { ComponentType, COMPONENT_TYPE_TO_NAME } from "@voxim/protocol";
import {
  positionCodec, velocityCodec, facingCodec,
  heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec,
  resourceCodec, actionCooldownsCodec, activeActionsCodec, modelRefCodec, animationStateCodec, equipmentCodec, inventoryCodec,
  blueprintCodec, lightEmitterCodec, darknessModifierCodec,
  loreLoadoutCodec,
  durabilityCodec, craftingQueueCodec, itemDataCodec,
  workstationBufferCodec, workstationTagCodec,
  statsCodec, provenanceCodec,
  gateLinkCodec,
  nameCodec,
} from "@voxim/codecs";
import type {
  HeightmapData, MaterialGridData, OpenMaskData, KindGridData, ModelRefData, AnimationStateData,
  EquipmentData, InventoryData, BlueprintData, LightEmitterData, DarknessModifierData,
  ResourceData, ActionCooldownsData, ActiveActionsData,
  LoreLoadoutData,
  DurabilityData, CraftingQueueData, ItemDataData,
  WorkstationBufferData, WorkstationTagData,
  StatsData, ProvenanceData,
  GateLinkData,
  NameData,
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

    switch (typeId) {
      case ComponentType.position:
        entity.position = positionCodec.decode(data);
        break;
      case ComponentType.velocity:
        entity.velocity = velocityCodec.decode(data);
        break;
      case ComponentType.facing:
        entity.facing = facingCodec.decode(data);
        break;
      case ComponentType.health: {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        entity.health = { current: v.getFloat32(0, true), max: v.getFloat32(4, true) };
        break;
      }
      case ComponentType.resource:
        entity.resource = resourceCodec.decode(data);
        break;
      case ComponentType.actionCooldowns:
        entity.actionCooldowns = actionCooldownsCodec.decode(data);
        break;
      case ComponentType.activeActions:
        entity.activeActions = activeActionsCodec.decode(data);
        break;
      case ComponentType.heightmap: {
        const hm = heightmapCodec.decode(data);
        entity.heightmap = hm;
        const key = `${hm.chunkX},${hm.chunkY}`;
        this.chunkHeightmaps.set(key, hm.data);
        // Note the entity → coord mapping so an OpenMask delivery on the
        // same entity (which lacks chunkX/chunkY) can find its slot.
        this.chunkCoordByEntity.set(entityId, key);
        // If the openMask arrived earlier on this same entity but its
        // chunk coord wasn't known yet, bind it now.
        if (entity.openMask) this.chunkOpenMasks.set(key, entity.openMask.data);
        if (entity.kindGrid) this.bindKinds(key, entity.kindGrid.data);
        break;
      }
      case ComponentType.materialGrid:
        entity.materialGrid = materialGridCodec.decode(data);
        break;
      case ComponentType.openMask: {
        const om = openMaskCodec.decode(data);
        entity.openMask = om;
        // Bind to the chunk coord we recorded when the heightmap arrived.
        // If the heightmap hasn't arrived yet (mask first on the same
        // spawn), the heightmap branch will pick this up via the
        // entity.openMask back-reference.
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.chunkOpenMasks.set(key, om.data);
        break;
      }
      case ComponentType.kindGrid: {
        const kg = kindGridCodec.decode(data);
        entity.kindGrid = kg;
        // Same back-reference dance as openMask: bind once we know the
        // chunk coord, otherwise the heightmap branch will pick it up.
        const key = this.chunkCoordByEntity.get(entityId);
        if (key) this.bindKinds(key, kg.data);
        break;
      }
      case ComponentType.modelRef:
        entity.modelRef = modelRefCodec.decode(data);
        break;
      case ComponentType.animationState:
        entity.animationState = animationStateCodec.decode(data);
        break;
      case ComponentType.equipment:
        entity.equipment = equipmentCodec.decode(data);
        break;
      case ComponentType.inventory:
        entity.inventory = inventoryCodec.decode(data);
        break;
      case ComponentType.blueprint:
        entity.blueprint = blueprintCodec.decode(data);
        break;
      case ComponentType.lightEmitter:
        entity.lightEmitter = lightEmitterCodec.decode(data);
        break;
      case ComponentType.darknessModifier:
        entity.darknessModifier = darknessModifierCodec.decode(data);
        break;
      case ComponentType.loreLoadout:
        entity.loreLoadout = loreLoadoutCodec.decode(data);
        break;
      case ComponentType.durability:
        entity.durability = durabilityCodec.decode(data);
        break;
      case ComponentType.craftingQueue:
        entity.craftingQueue = craftingQueueCodec.decode(data);
        break;
      case ComponentType.itemData:
        entity.itemData = itemDataCodec.decode(data);
        break;
      case ComponentType.workstationBuffer:
        entity.workstationBuffer = workstationBufferCodec.decode(data);
        break;
      case ComponentType.workstationTag:
        entity.workstationTag = workstationTagCodec.decode(data);
        break;
      case ComponentType.stats:
        entity.stats = statsCodec.decode(data);
        break;
      case ComponentType.provenance:
        entity.provenance = provenanceCodec.decode(data);
        break;
      case ComponentType.worldClock: {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        entity.worldClock = { ticksElapsed: v.getInt32(0, true), dayLengthTicks: v.getInt32(4, true) };
        break;
      }
      case ComponentType.gateLink:
        entity.gateLink = gateLinkCodec.decode(data);
        break;
      case ComponentType.name:
        entity.name = nameCodec.decode(data);
        break;
      default: {
        const name = COMPONENT_TYPE_TO_NAME.get(typeId);
        if (name) entity.raw.set(name, data);
        break;
      }
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
   * Sample terrain height at a world position. Uses bilinear interpolation
   * between the four surrounding heightmap cells.
   * Returns 0 for unloaded chunks.
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
    this.chunkCoordByEntity.clear();
  }
}
