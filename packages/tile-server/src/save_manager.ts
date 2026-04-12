/**
 * World persistence — binary format v2.
 *
 * What is saved:
 *   WorldClock + TileCorruption  — so day/night and corruption survive restarts
 *   Heightmap + MaterialGrid     — all 256 terrain chunks
 *   Position + ResourceNode      — node positions, hit-point state, respawn timers
 *
 * What is NOT saved:
 *   Players     — re-connect and spawn fresh each session
 *   NPCs        — re-spawned from configuration on startup
 *   ActiveEffects, cooldowns — transient per-session state
 *
 * Binary wire format (all little-endian):
 *   u32  magic   = 0x56584D32  ("VXM2")
 *   u32  version = 2
 *   f64  savedAt (ms since epoch)
 *   u32  numEntities
 *   per entity:
 *     bytes[16]  entityId  (UUID, raw bytes)
 *     u16        numComponents
 *     per component:
 *       u8       typeId    (from ComponentType enum)
 *       u16      dataLen
 *       bytes…   componentData
 *
 * Adding a new persisted component:
 *   1. Ensure it has an entry in COMPONENT_REGISTRY (component_registry.ts).
 *   2. Add it to the relevant query in save() below.
 *   3. No changes needed to load() — it reads any typeId it recognises.
 */
import type { World, EntityId } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import { Heightmap, MaterialGrid } from "@voxim/world";
import { WorldClock, TileCorruption } from "./components/world.ts";
import { Position } from "./components/game.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { DEF_BY_TYPE_ID } from "./component_registry.ts";

const SAVE_MAGIC   = 0x56584D32; // "VXM2"
const SAVE_VERSION = 2;

// ---- internal helpers ----

interface SavedComponent {
  typeId: number;
  data: Uint8Array;
}

interface SavedEntity {
  entityId: EntityId;
  components: SavedComponent[];
}

function encodeEntity(
  entityId: EntityId,
  components: SavedComponent[],
  w: WireWriter,
): void {
  w.writeUuid(entityId);
  w.writeU16(components.length);
  for (const { typeId, data } of components) {
    w.writeU8(typeId);
    w.writeU16(data.byteLength);
    w.writeBytes(data);
  }
}

// ---- SaveManager ----

export class SaveManager {
  constructor(private readonly savePath: string) {}

  // ---- save ----

  async save(world: World): Promise<void> {
    const entities: SavedEntity[] = [];

    // World-state entity (WorldClock + TileCorruption)
    for (const { entityId, worldClock } of world.query(WorldClock)) {
      const components: SavedComponent[] = [
        { typeId: WorldClock.wireId, data: WorldClock.codec.encode(worldClock) },
      ];
      const corruption = world.get(entityId, TileCorruption);
      if (corruption) {
        components.push({
          typeId: TileCorruption.wireId,
          data: TileCorruption.codec.encode(corruption),
        });
      }
      entities.push({ entityId, components });
      break; // only one world-state entity
    }

    // Terrain chunks (Heightmap + MaterialGrid)
    for (const { entityId, heightmap, materialGrid } of world.query(Heightmap, MaterialGrid)) {
      entities.push({
        entityId,
        components: [
          { typeId: Heightmap.wireId,     data: Heightmap.codec.encode(heightmap) },
          { typeId: MaterialGrid.wireId,  data: MaterialGrid.codec.encode(materialGrid) },
        ],
      });
    }

    // Resource nodes (Position + ResourceNode)
    for (const { entityId, position, resource_node } of world.query(Position, ResourceNode)) {
      entities.push({
        entityId,
        components: [
          { typeId: Position.wireId,     data: Position.codec.encode(position) },
          { typeId: ResourceNode.wireId, data: ResourceNode.codec.encode(resource_node) },
        ],
      });
    }

    // Encode
    const w = new WireWriter();
    w.writeU32(SAVE_MAGIC);
    w.writeU32(SAVE_VERSION);
    w.writeF64(Date.now());
    w.writeU32(entities.length);
    for (const entity of entities) {
      encodeEntity(entity.entityId, entity.components, w);
    }

    await Deno.writeFile(this.savePath, w.toBytes());
  }

  // ---- load ----

  /**
   * Attempt to load a binary save file into `world`.
   * Returns true on success; false if the file is absent, has wrong magic, or wrong version.
   */
  async load(world: World): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(this.savePath);
    } catch {
      return false; // file does not exist
    }

    const r = new WireReader(bytes);

    const magic = r.readU32();
    if (magic !== SAVE_MAGIC) {
      console.warn("[SaveManager] not a VXM2 save file — starting fresh");
      return false;
    }

    const version = r.readU32();
    if (version !== SAVE_VERSION) {
      console.warn(
        `[SaveManager] save version mismatch (got ${version}, expected ${SAVE_VERSION}) — starting fresh`,
      );
      return false;
    }

    const savedAt     = r.readF64();
    const numEntities = r.readU32();
    let   loaded      = 0;

    for (let i = 0; i < numEntities; i++) {
      const entityId   = r.readUuid() as EntityId;
      const numComps   = r.readU16();

      // Read all component bytes first (unknown typeIds must still advance the cursor)
      const comps: SavedComponent[] = [];
      for (let j = 0; j < numComps; j++) {
        const typeId  = r.readU8();
        const dataLen = r.readU16();
        const data    = r.readBytes(dataLen);
        comps.push({ typeId, data });
      }

      // Create entity and write recognised components
      world.create(entityId);
      for (const { typeId, data } of comps) {
        const def = DEF_BY_TYPE_ID.get(typeId);
        if (!def) continue; // unknown typeId — forward-compatibility skip
        try {
          // deno-lint-ignore no-explicit-any — def is NetworkedComponentDef<unknown> at this
          // point; the decoded value is the correct type by construction (same def owns both
          // codec and world slot), but TypeScript can't prove it without a generic parameter.
          world.write(entityId, def, def.codec.decode(data) as any);
        } catch {
          console.warn(`[SaveManager] failed to decode component typeId=${typeId} for entity ${entityId}`);
        }
      }
      loaded++;
    }

    console.log(
      `[SaveManager] loaded binary save v${SAVE_VERSION} from ${new Date(savedAt).toISOString()}`,
      `| ${loaded} entities`,
    );
    return true;
  }

  /** True if a save file exists at this path (fast check, no parse). */
  async exists(): Promise<boolean> {
    try {
      await Deno.stat(this.savePath);
      return true;
    } catch {
      return false;
    }
  }
}

