/**
 * World persistence — binary payload stored in `tile_saves` (one row per
 * tile_id) via `@voxim/db`'s `TileSaveRepo`.
 *
 * The save is the *complete* restart truth for everything the boot path skips
 * when a save loads (`if (!loaded)` in server.ts): the world clock, every
 * terrain chunk, and every persistent world fixture. NPCs, players, items,
 * gates and POI layout are re-derived every boot and deliberately NOT saved.
 *
 * Two entity shapes (T-251):
 *
 *   RAW    — chunks (Heightmap + MaterialGrid + OpenMask + KindGrid) and the
 *            WorldClock singleton. No prefab; their components ARE their state.
 *            Saved as a component list, raw-written back verbatim. The full
 *            grid set matters: a missing OpenMask reads as walkable (POI walls
 *            become passable), a missing KindGrid drops client decoration.
 *
 *   PREFAB — fixtures (resource nodes, workstations, pending blueprints). A
 *            raw component subset can't reconstruct these: the spawn pipeline
 *            installs ModelRef/Hitbox/server-only Resources that a node needs
 *            to be hittable and to respawn. So we save `{prefabId, position,
 *            mutable-state components}` and on load RE-SPAWN through
 *            `spawnPrefab` (which re-runs the whole pipeline, regenerating the
 *            visual shell deterministically from the preserved entity id) then
 *            OVERLAY the saved mutable state. `SpawnedFrom` carries the prefab
 *            id; the same re-completion the tile handoff will use (T-256).
 *
 *   ITEM   — unique item entities referenced by a saved Container's slots (the
 *            tomes/gear banked in a family library/treasury, T-077/T-078). They
 *            have no Position (carried, not placed), so the fixture path never
 *            sees them; we emit them as a raw component list (ItemData + instance
 *            components) with the UUID preserved, so the chest's slot refs resolve
 *            on load. Re-created via `world.create` + overlay, like RAW.
 *
 * Components are keyed by NAME, resolved through `DEF_BY_NAME`, so server-only
 * state (the respawn/crafting Resource) persists alongside networked state —
 * the save format is independent of the wire format.
 *
 * Binary wire format (all little-endian):
 *   u32  magic   = 0x56584D32  ("VXM2")
 *   u32  version = 4
 *   f64  savedAt (ms since epoch)
 *   u32  numEntities
 *   per entity:
 *     u8         kind        (0 = RAW, 1 = PREFAB, 2 = ITEM)
 *     bytes[16]  entityId    (UUID, raw bytes)
 *     if kind == PREFAB:
 *       str      prefabId
 *       f32 x, f32 y, f32 z  (re-spawn position)
 *     u16        numComponents
 *     per component:
 *       str      componentName
 *       u16      dataLen
 *       bytes…   componentData
 */
import type { World, EntityId, ComponentDef } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import { Heightmap, MaterialGrid, OpenMask, KindGrid } from "@voxim/world";
import type { TileSaveRepo } from "@voxim/db";
import type { ContentService } from "@voxim/content";
import { WorldClock } from "./components/world.ts";
import { Position } from "./components/game.ts";
import { Resource } from "./components/resource.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { SpawnedFrom } from "./components/spawned_from.ts";
import { Blueprint, WorkstationBuffer, WorkstationTag } from "./components/building.ts";
import { Container } from "./components/container.ts";
import { ItemData } from "./components/items.ts";
import {
  Durability,
  History,
  Inscribed,
  ItemEffects,
  Owned,
  Provenance,
  QualityStamped,
  Stats,
} from "./components/instance.ts";
import { DEF_BY_NAME } from "./component_registry.ts";
import { spawnPrefab } from "./spawner.ts";

const SAVE_MAGIC   = 0x56584D32; // "VXM2"
const SAVE_VERSION = 4;

const KIND_RAW    = 0;
const KIND_PREFAB = 1;
const KIND_ITEM   = 2;

/** Full component set persisted for a terrain chunk (RAW). */
// deno-lint-ignore no-explicit-any
const CHUNK_DEFS: ReadonlyArray<ComponentDef<any>> = [Heightmap, MaterialGrid, OpenMask, KindGrid];

/** Fixture marker components — an entity carrying any of these is persisted. */
// deno-lint-ignore no-explicit-any
const FIXTURE_MARKER_DEFS: ReadonlyArray<ComponentDef<any>> = [ResourceNode, WorkstationTag, Blueprint, Container];

/**
 * Mutable runtime state overlaid onto a re-spawned fixture. Static prefab data
 * (ModelRef, Hitbox, WorkstationTag, the slots an actor declares) is NOT here
 * — spawnPrefab regenerates it. `resource` carries the server-only respawn /
 * crafting timer; without it a saved-depleted node would never respawn.
 */
// deno-lint-ignore no-explicit-any
const FIXTURE_STATE_DEFS: ReadonlyArray<ComponentDef<any>> = [
  ResourceNode,
  Resource,
  WorkstationBuffer,
  Blueprint,
  // Container (T-077/T-078): {kind, dynastyId, capacity, slots[]} — the chest's
  // owner + which unique item entities it holds. The referenced items are saved
  // separately as KIND_ITEM records (collected from these slots in serialize()).
  Container,
];

/**
 * Instance components of a unique item entity banked in a Container (T-077/T-078).
 * `collectComponents` skips absent ones, so all but `ItemData` are conditional.
 * `ItemEffects` is here AND registered in ALL_DEFS — otherwise it silently drops
 * on overlay. `Owned.lineage` (dynasty inheritance) and `Inscribed.fragmentId`
 * (the tome's lore) are the per-instance state that must survive a restart.
 */
// deno-lint-ignore no-explicit-any
const ITEM_STATE_DEFS: ReadonlyArray<ComponentDef<any>> = [
  ItemData, // always present — prefabId + quantity (the item's identity)
  Durability,
  Inscribed,
  QualityStamped,
  Stats,
  Provenance,
  History,
  Owned,
  ItemEffects,
];

interface SavedComponent {
  name: string;
  data: Uint8Array;
}

interface RawEntity {
  kind: typeof KIND_RAW;
  entityId: EntityId;
  components: SavedComponent[];
}

interface PrefabEntity {
  kind: typeof KIND_PREFAB;
  entityId: EntityId;
  prefabId: string;
  x: number;
  y: number;
  z: number;
  components: SavedComponent[];
}

/** A unique item entity referenced by a saved Container's slots (T-077/T-078). */
interface ItemEntity {
  kind: typeof KIND_ITEM;
  entityId: EntityId;
  components: SavedComponent[];
}

type ParsedEntity = RawEntity | PrefabEntity | ItemEntity;

// ---- SaveManager ----

export class SaveManager {
  constructor(
    private readonly repo: TileSaveRepo,
    private readonly content: ContentService,
    private readonly worldId: string,
    private readonly tileId: string,
  ) {}

  // ---- save ----

  async save(world: World): Promise<void> {
    const payload = this.serialize(world);
    await this.repo.put(this.worldId, this.tileId, payload);
  }

  /** Public for tests / future export tools — produces the VXM2 byte payload. */
  serialize(world: World): Uint8Array {
    const raw: RawEntity[] = [];
    const prefab: PrefabEntity[] = [];

    // WorldClock singleton (RAW) — only one.
    for (const { entityId, worldClock } of world.query(WorldClock)) {
      raw.push({
        kind: KIND_RAW,
        entityId,
        components: [{ name: WorldClock.name, data: WorldClock.codec.encode(worldClock) }],
      });
      break;
    }

    // Terrain chunks (RAW) — the full grid set.
    for (const { entityId } of world.query(Heightmap)) {
      raw.push({ kind: KIND_RAW, entityId, components: collectComponents(world, entityId, CHUNK_DEFS) });
    }

    // Fixtures (PREFAB) — nodes, workstations, blueprints. De-dup: a
    // workstation carries both WorkstationTag and (sometimes) a Blueprint
    // during construction, so collect ids once.
    const fixtureIds = new Set<EntityId>();
    for (const def of FIXTURE_MARKER_DEFS) {
      for (const { entityId } of world.query(def)) fixtureIds.add(entityId);
    }
    for (const entityId of fixtureIds) {
      const sf = world.get(entityId, SpawnedFrom);
      const pos = world.get(entityId, Position);
      if (!sf || !pos) {
        // Can't re-complete without a prefab origin + a world position. A
        // fixture should always have both; warn rather than silently drop.
        console.warn(`[SaveManager] fixture ${entityId.slice(-8)} missing SpawnedFrom/Position — not persisted`);
        continue;
      }
      prefab.push({
        kind: KIND_PREFAB,
        entityId,
        prefabId: sf.prefabId,
        x: pos.x, y: pos.y, z: pos.z,
        components: collectComponents(world, entityId, FIXTURE_STATE_DEFS),
      });
    }

    // Unique item entities referenced by saved containers (T-077/T-078): the
    // tomes/gear in a library/treasury chest's slots. They carry no Position /
    // SpawnedFrom (held, not placed), so the fixture loop above never sees them;
    // emit each as a KIND_ITEM record with its UUID preserved so the chest's slot
    // refs resolve on load. A dangling ref (the item died) is skipped.
    const item: ItemEntity[] = [];
    const seenItems = new Set<EntityId>();
    for (const entityId of fixtureIds) {
      const container = world.get(entityId, Container);
      if (!container) continue;
      for (const slot of container.slots) {
        const refId = slot.entityId as EntityId;
        if (seenItems.has(refId)) continue;
        seenItems.add(refId);
        if (!world.isAlive(refId)) continue;
        item.push({ kind: KIND_ITEM, entityId: refId, components: collectComponents(world, refId, ITEM_STATE_DEFS) });
      }
    }

    // Items FIRST so they are world.create'd before the chest's Container overlay
    // lands — keeping every slot ref resolvable to a live entity post-load.
    const entities: ParsedEntity[] = [...item, ...raw, ...prefab];

    const w = new WireWriter();
    w.writeU32(SAVE_MAGIC);
    w.writeU32(SAVE_VERSION);
    w.writeF64(Date.now());
    w.writeU32(entities.length);
    for (const e of entities) {
      w.writeU8(e.kind);
      w.writeUuid(e.entityId);
      if (e.kind === KIND_PREFAB) {
        w.writeStr(e.prefabId);
        w.writeF32(e.x);
        w.writeF32(e.y);
        w.writeF32(e.z);
      }
      w.writeU16(e.components.length);
      for (const c of e.components) {
        w.writeStr(c.name);
        w.writeU16(c.data.byteLength);
        w.writeBytes(c.data);
      }
    }
    return w.toBytes();
  }

  // ---- load ----

  /**
   * Attempt to load a saved snapshot into `world`.
   * Returns true on success; false if no row exists, the magic / version
   * doesn't match, or the payload is corrupt.
   */
  async load(world: World): Promise<boolean> {
    const row = await this.repo.get(this.worldId, this.tileId);
    if (!row) return false;
    return this.deserialize(world, row.payload);
  }

  /** Public for tests / future import tools. */
  deserialize(world: World, bytes: Uint8Array): boolean {
    // ── Phase 1: parse + validate the WHOLE payload before any world
    //    mutation. A corrupt / truncated save must leave the world untouched
    //    so the fresh-boot path can run on a clean slate.
    let parsed: ParsedEntity[];
    let savedAt: number;
    try {
      const result = this.parse(bytes);
      if (!result) return false; // bad magic / version — already logged
      ({ entities: parsed, savedAt } = result);
    } catch (err) {
      console.warn(`[SaveManager] corrupt save payload (${(err as Error).message}) — starting fresh`);
      return false;
    }

    // ── Phase 2: apply. Structure is validated; unknown prefab/component ids
    //    (content drifted since save) are skipped per-item, not fatal.
    for (const e of parsed) {
      if (e.kind === KIND_PREFAB) {
        if (!this.content.prefabs.get(e.prefabId)) {
          console.warn(`[SaveManager] saved fixture references unknown prefab "${e.prefabId}" — skipped`);
          continue;
        }
        spawnPrefab(world, this.content, e.prefabId, { id: e.entityId, x: e.x, y: e.y, z: e.z });
      } else {
        world.create(e.entityId);
      }
      overlayComponents(world, e.entityId, e.components);
    }

    console.log(
      `[SaveManager] loaded binary save v${SAVE_VERSION} from ${new Date(savedAt).toISOString()}`,
      `| ${parsed.length} entities`,
    );
    return true;
  }

  /**
   * Read + structurally validate a payload into memory. Returns null for a
   * non-VXM2 / wrong-version payload (recoverable: start fresh). Throws on
   * structural corruption (truncation surfaces as a WireReader over-read,
   * trailing bytes, or a declared/recovered count mismatch) — the caller
   * turns that into a clean "start fresh" without having touched the world.
   */
  private parse(bytes: Uint8Array): { entities: ParsedEntity[]; savedAt: number } | null {
    const r = new WireReader(bytes);

    const magic = r.readU32();
    if (magic !== SAVE_MAGIC) {
      console.warn("[SaveManager] not a VXM2 save payload — starting fresh");
      return null;
    }
    const version = r.readU32();
    if (version !== SAVE_VERSION) {
      console.warn(`[SaveManager] save version mismatch (got ${version}, expected ${SAVE_VERSION}) — starting fresh`);
      return null;
    }

    const savedAt     = r.readF64();
    const numEntities = r.readU32();
    const entities: ParsedEntity[] = [];

    for (let i = 0; i < numEntities; i++) {
      const kind = r.readU8();
      const entityId = r.readUuid() as EntityId;

      if (kind === KIND_PREFAB) {
        const prefabId = r.readStr();
        const x = r.readF32(), y = r.readF32(), z = r.readF32();
        entities.push({ kind: KIND_PREFAB, entityId, prefabId, x, y, z, components: readComponents(r) });
      } else if (kind === KIND_ITEM) {
        entities.push({ kind: KIND_ITEM, entityId, components: readComponents(r) });
      } else if (kind === KIND_RAW) {
        entities.push({ kind: KIND_RAW, entityId, components: readComponents(r) });
      } else {
        throw new Error(`unknown entity kind ${kind} at index ${i}`);
      }
    }

    if (!r.done) {
      throw new Error(`${bytes.byteLength - r.offset} trailing bytes after ${numEntities} entities`);
    }
    if (entities.length !== numEntities) {
      throw new Error(`declared ${numEntities} entities but recovered ${entities.length}`);
    }
    return { entities, savedAt };
  }

  /** True if a saved snapshot exists for this tile. */
  async exists(): Promise<boolean> {
    const row = await this.repo.get(this.worldId, this.tileId);
    return row !== null;
  }
}

// ---- helpers ----

/** Encode every present component from `defs` on `entityId`. */
function collectComponents(
  world: World,
  entityId: EntityId,
  // deno-lint-ignore no-explicit-any
  defs: ReadonlyArray<ComponentDef<any>>,
): SavedComponent[] {
  const out: SavedComponent[] = [];
  for (const def of defs) {
    const value = world.get(entityId, def);
    if (value === null) continue;
    out.push({ name: def.name, data: def.codec.encode(value) });
  }
  return out;
}

/** Read one component list from the cursor (shared by RAW and PREFAB). */
function readComponents(r: WireReader): SavedComponent[] {
  const n = r.readU16();
  const out: SavedComponent[] = [];
  for (let j = 0; j < n; j++) {
    const name = r.readStr();
    const dataLen = r.readU16();
    const data = r.readBytes(dataLen);
    out.push({ name, data });
  }
  return out;
}

/**
 * Decode + write each saved component onto an entity. For a PREFAB entity this
 * runs AFTER spawnPrefab, so it overlays mutable state onto the freshly-built
 * shell (replacing the installer's fresh ResourceNode with the saved depleted
 * one, adding the server-only respawn Resource). Unknown names / undecodable
 * bytes are skipped with a warning — never fatal mid-apply.
 */
function overlayComponents(world: World, entityId: EntityId, components: SavedComponent[]): void {
  for (const { name, data } of components) {
    const def = DEF_BY_NAME.get(name);
    if (!def) continue; // component retired since save — forward-compat skip
    try {
      // deno-lint-ignore no-explicit-any
      world.write(entityId, def, def.codec.decode(data) as any);
    } catch {
      console.warn(`[SaveManager] failed to decode component "${name}" for entity ${entityId.slice(-8)}`);
    }
  }
}
