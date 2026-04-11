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
  heightmapCodec, materialGridCodec,
  staminaCodec, modelRefCodec, animationStateCodec, equipmentCodec, inventoryCodec,
  blueprintCodec,
} from "@voxim/codecs";
import type { HeightmapData, MaterialGridData, ModelRefData, AnimationStateData, EquipmentData, InventoryData, BlueprintData } from "@voxim/codecs";

export interface PositionState  { x: number; y: number; z: number }
export interface VelocityState  { x: number; y: number; z: number }
export interface FacingState    { angle: number }
export interface HealthState    { current: number; max: number }
export interface StaminaState   { current: number; max: number; exhausted: boolean }
export interface HungerState    { value: number }

export interface EntityState {
  position?: PositionState;
  velocity?: VelocityState;
  facing?: FacingState;
  health?: HealthState;
  stamina?: StaminaState;
  hunger?: HungerState;
  heightmap?: HeightmapData;
  materialGrid?: MaterialGridData;
  modelRef?: ModelRefData;
  animationState?: AnimationStateData;
  equipment?: EquipmentData;
  inventory?: InventoryData;
  blueprint?: BlueprintData;
  /** Raw bytes for components the client doesn't decode eagerly, keyed by component name. */
  raw: Map<string, Uint8Array>;
  /** Per-component version counters (component type ID → version). Stale deltas are discarded. */
  versions: Map<number, number>;
}

function makeEntity(): EntityState {
  return { raw: new Map(), versions: new Map() };
}

const CHUNK_CELLS = 32;

export class ClientWorld {
  private readonly entities = new Map<string, EntityState>();
  private lastSnapshotTick = -1;
  /** Heightmap data indexed by "chunkX,chunkY" for O(1) terrain height queries. */
  private readonly chunkHeightmaps = new Map<string, Float32Array>();

  private applyComponentData(
    entity: EntityState,
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
      case ComponentType.stamina: {
        const s = staminaCodec.decode(data);
        entity.stamina = { current: s.current, max: s.max, exhausted: s.exhausted };
        break;
      }
      case ComponentType.hunger: {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        entity.hunger = { value: v.getFloat32(0, true) };
        break;
      }
      case ComponentType.heightmap: {
        const hm = heightmapCodec.decode(data);
        entity.heightmap = hm;
        this.chunkHeightmaps.set(`${hm.chunkX},${hm.chunkY}`, hm.data);
        break;
      }
      case ComponentType.materialGrid:
        entity.materialGrid = materialGridCodec.decode(data);
        break;
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
      this.applyComponentData(entity, comp.componentType, comp.data, 0);
    }
  }

  /** Apply a single component delta for an already-known entity. */
  applyDelta(delta: BinaryComponentDelta): void {
    let entity = this.entities.get(delta.entityId);
    if (!entity) {
      entity = makeEntity();
      this.entities.set(delta.entityId, entity);
    }
    this.applyComponentData(entity, delta.componentType, delta.data, delta.version);
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
    const cx = Math.floor(wx / CHUNK_CELLS);
    const cy = Math.floor(wy / CHUNK_CELLS);
    const data = this.chunkHeightmaps.get(`${cx},${cy}`);
    if (!data) return 0;
    const lx = Math.max(0, Math.min(CHUNK_CELLS - 1, Math.floor(wx - cx * CHUNK_CELLS)));
    const ly = Math.max(0, Math.min(CHUNK_CELLS - 1, Math.floor(wy - cy * CHUNK_CELLS)));
    return data[lx + ly * CHUNK_CELLS] ?? 0;
  }

  clear(): void {
    this.entities.clear();
    this.chunkHeightmaps.clear();
  }
}
