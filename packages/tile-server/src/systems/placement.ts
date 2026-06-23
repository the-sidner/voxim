/**
 * PlacementSystem — handles every Place command.
 *
 * Replaces CraftingSystem._handleDeploy (workstation placement from inventory)
 * and BuildingSystem._handlePlace (blueprint placement at a grid cell). One
 * command, one system; placement rules live on the spawned prefab's Placeable
 * component.
 *
 * Flow:
 *   1. Resolve the prefab to spawn.
 *        source="prefab"    → spawn prefabId directly.
 *        source="inventory" → read inventory slot → that item's Deployable
 *                             component names the spawn prefab.
 *   2. Read the spawn prefab's Placeable for validation rules.
 *   3. Validate (tool requirement, reach, cell-alignment, cell occupancy).
 *   4. Compute the actual spawn position (cell-aligned snaps to integer
 *      cell centre; forward-facing uses placer pos + facing × offset).
 *   5. Call spawnPrefab.
 *   6. Post-spawn fixups: if the entity has a Blueprint component, patch in
 *      chunk/local coordinates (the prefab can't know them statically).
 *   7. Publish TileEvents.EntityDeployed. Subscribers handle side-effects
 *      (hearth anchor update, etc.) — PlacementSystem holds zero knowledge
 *      of any specific prefab kind.
 *   8. Consume one from inventory if source="inventory".
 *
 * Construction of blueprints (swinging a hammer at them) is unchanged —
 * that lives in BlueprintHitHandler.
 */
import type { World, EntityId } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentService, PlaceableData } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import { Blueprint } from "../components/building.ts";
import { spawnPrefab } from "../spawner.ts";
import { createLogger } from "../logger.ts";
import { Heightmap, getHeight, snapHeight } from "@voxim/world";
import type { HeightmapData } from "@voxim/world";

const log = createLogger("PlacementSystem");

const CHUNK_SIZE = 32;

export class PlacementSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentService) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;
      for (const cmd of commands) {
        if (cmd.cmd === CommandType.Place) {
          this._handle(world, events, entityId, cmd);
        } else if (cmd.cmd === CommandType.PlaceVoxels) {
          this._handlePlaceVoxels(world, events, entityId, cmd);
        }
      }
    }
  }

  private _handle(
    world: World,
    events: EventEmitter,
    placerId: EntityId,
    cmd: Extract<CommandPayload, { cmd: CommandType.Place }>,
  ): void {
    // ── Resolve spawn prefab ──────────────────────────────────────────────
    let spawnPrefabId: string;
    let consumeFromSlot: number | null = null;

    if (cmd.source === "prefab") {
      spawnPrefabId = cmd.prefabId;
    } else {
      const inv = world.get(placerId, Inventory);
      if (!inv) return;
      if (cmd.fromInventorySlot < 0 || cmd.fromInventorySlot >= inv.slots.length) {
        log.debug("place rejected: placer=%s slot index %d out of range", placerId, cmd.fromInventorySlot);
        return;
      }
      const slot = inv.slots[cmd.fromInventorySlot];
      if (slot.kind !== "stack") {
        log.debug("place rejected: placer=%s slot=%d is not a stack (unique items deploy via drop)", placerId, cmd.fromInventorySlot);
        return;
      }
      const itemPrefab = this.content.prefabs.get(slot.prefabId);
      const deployable = itemPrefab?.components["deployable"] as { prefabId?: string } | undefined;
      if (!deployable?.prefabId) {
        log.debug("place rejected: placer=%s item=%s has no deployable component", placerId, slot.prefabId);
        return;
      }
      spawnPrefabId = deployable.prefabId;
      consumeFromSlot = cmd.fromInventorySlot;
    }

    // ── Load spawn prefab + placement rules ──────────────────────────────
    const spawnPrefab_ = this.content.prefabs.get(spawnPrefabId);
    if (!spawnPrefab_) {
      log.warn("place rejected: unknown spawn prefab=%s (placer=%s)", spawnPrefabId, placerId);
      return;
    }
    const rules = spawnPrefab_.components["placeable"] as PlaceableData | undefined;
    if (!rules) {
      log.warn("place rejected: prefab=%s has no placeable component", spawnPrefabId);
      return;
    }

    const placerPos = world.get(placerId, Position);
    if (!placerPos) return;

    // ── Tool gate ────────────────────────────────────────────────────────
    if (rules.requiresToolType) {
      const equipment = world.get(placerId, Equipment);
      if (!equipment?.weapon) {
        log.debug("place rejected: placer=%s needs tool=%s but no weapon equipped", placerId, rules.requiresToolType);
        return;
      }
      const weaponPrefabId = equipment.weapon.prefabId;
      const stats = this.content.deriveItemStats(weaponPrefabId);
      if (stats.toolType !== rules.requiresToolType) {
        log.debug("place rejected: placer=%s tool=%s mismatch (need %s)", placerId, stats.toolType, rules.requiresToolType);
        return;
      }
    }

    // ── Compute target position ──────────────────────────────────────────
    let spawnX: number, spawnY: number, spawnZ: number;
    let cellCoords: { chunkX: number; chunkY: number; localX: number; localY: number } | null = null;

    if (rules.alignment === "cell-aligned") {
      const cellX = Math.floor(cmd.worldX);
      const cellY = Math.floor(cmd.worldY);
      spawnX = cellX + 0.5;
      spawnY = cellY + 0.5;
      spawnZ = placerPos.z;
      cellCoords = {
        chunkX: Math.floor(cellX / CHUNK_SIZE),
        chunkY: Math.floor(cellY / CHUNK_SIZE),
        localX: ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
        localY: ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
      };
      if (rules.cellMustBeEmpty) {
        for (const { blueprint } of world.query(Blueprint)) {
          const bx = blueprint.chunkX * CHUNK_SIZE + blueprint.localX;
          const by = blueprint.chunkY * CHUNK_SIZE + blueprint.localY;
          if (bx === cellX && by === cellY) {
            log.warn("place rejected: cell=(%d,%d) already occupied by blueprint", cellX, cellY);
            return;
          }
        }
      }
    } else {
      // forward-facing: ignore the command's worldX/worldY (untrusted) and
      // derive spawn from placer pos + facing. Keeps the rule authoritative.
      const facing = world.get(placerId, InputState)?.facing ?? 0;
      const offset = this.content.getGameConfig().crafting.deployOffsetWorldUnits;
      spawnX = placerPos.x + Math.sin(facing) * offset;
      spawnY = placerPos.y + Math.cos(facing) * offset;
      spawnZ = placerPos.z;
    }

    // ── Reach ────────────────────────────────────────────────────────────
    const maxReach = rules.reach ?? this.content.getGameConfig().building.maxReachWorldUnits;
    const dx = placerPos.x - spawnX;
    const dy = placerPos.y - spawnY;
    if (dx * dx + dy * dy > maxReach * maxReach) {
      log.warn("place rejected: placer=%s dist=%.1f exceeds reach=%.1f",
        placerId, Math.sqrt(dx * dx + dy * dy), maxReach);
      return;
    }

    // ── Spawn ────────────────────────────────────────────────────────────
    const entityId = spawnPrefab(world, this.content, spawnPrefabId, {
      x: spawnX, y: spawnY, z: spawnZ,
    });

    // ── Post-spawn: patch Blueprint cell coordinates if applicable ───────
    if (cellCoords) {
      const bp = world.get(entityId, Blueprint);
      if (bp) {
        world.write(entityId, Blueprint, {
          ...bp,
          chunkX: cellCoords.chunkX,
          chunkY: cellCoords.chunkY,
          localX: cellCoords.localX,
          localY: cellCoords.localY,
        });
      }
    }

    // ── Consume from inventory ───────────────────────────────────────────
    if (consumeFromSlot !== null) {
      const inv = world.get(placerId, Inventory);
      if (inv) {
        const slot = inv.slots[consumeFromSlot];
        if (slot?.kind === "stack") {
          const newSlots = [...inv.slots];
          if (slot.quantity <= 1) {
            newSlots.splice(consumeFromSlot, 1);
          } else {
            newSlots[consumeFromSlot] = { kind: "stack", prefabId: slot.prefabId, quantity: slot.quantity - 1 };
          }
          world.set(placerId, Inventory, { ...inv, slots: newSlots });
        }
      }
    }

    // ── Publish EntityDeployed ───────────────────────────────────────────
    events.publish(TileEvents.EntityDeployed, {
      placerId, entityId, prefabId: spawnPrefabId,
      worldX: spawnX, worldY: spawnY, worldZ: spawnZ,
    });

    log.info("placed: placer=%s prefab=%s entity=%s at=(%.1f,%.1f) alignment=%s",
      placerId, spawnPrefabId, entityId, spawnX, spawnY, rules.alignment);
  }

  /**
   * Build-spine multi-voxel placement (T-284). One command stamps a single voxel
   * or a whole line; the server is authoritative over BOTH validity and height:
   * each cell is reach-gated against the placer, and its z is computed from the
   * terrain top + the column's current stack × voxelSize (stacking allowed — no
   * cellMustBeEmpty), so a wall sits on the ground and on whatever's beneath it.
   * Out-of-reach cells are silently skipped (the client ghosts them red).
   */
  private _handlePlaceVoxels(
    world: World,
    events: EventEmitter,
    placerId: EntityId,
    cmd: Extract<CommandPayload, { cmd: CommandType.PlaceVoxels }>,
  ): void {
    const prefab = this.content.prefabs.get(cmd.prefabId);
    if (!prefab) {
      log.warn("placevoxels rejected: unknown prefab=%s (placer=%s)", cmd.prefabId, placerId);
      return;
    }
    const rules = prefab.components["placeable"] as PlaceableData | undefined;
    if (!rules) {
      log.warn("placevoxels rejected: prefab=%s has no placeable component", cmd.prefabId);
      return;
    }
    const placerPos = world.get(placerId, Position);
    if (!placerPos) return;

    // Tool gate (same rule as single Place).
    if (rules.requiresToolType) {
      const equipment = world.get(placerId, Equipment);
      if (!equipment?.weapon) return;
      const stats = this.content.deriveItemStats(equipment.weapon.prefabId);
      if (stats.toolType !== rules.requiresToolType) return;
    }

    const maxReach = rules.reach ?? this.content.getGameConfig().building.maxReachWorldUnits;
    const reachSq = maxReach * maxReach;

    // Index terrain heightmaps by chunk for O(1) per-cell height sampling.
    const hmByChunk = new Map<string, HeightmapData>();
    for (const { heightmap } of world.query(Heightmap)) {
      hmByChunk.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap);
    }

    // Count voxels already stacked per column (existing blueprints), so each new
    // voxel lands on the column top; bumped as we place so cells repeated within
    // this command keep stacking.
    const stack = new Map<string, number>();
    for (const { blueprint } of world.query(Blueprint)) {
      const bx = blueprint.chunkX * CHUNK_SIZE + blueprint.localX;
      const by = blueprint.chunkY * CHUNK_SIZE + blueprint.localY;
      const k = `${bx},${by}`;
      stack.set(k, (stack.get(k) ?? 0) + 1);
    }

    let placed = 0;
    for (const { cellX, cellY } of cmd.cells) {
      const spawnX = cellX + 0.5, spawnY = cellY + 0.5;
      const dx = placerPos.x - spawnX, dy = placerPos.y - spawnY;
      if (dx * dx + dy * dy > reachSq) continue; // out of reach — client ghosts red

      const chunkX = Math.floor(cellX / CHUNK_SIZE);
      const chunkY = Math.floor(cellY / CHUNK_SIZE);
      const localX = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const localY = ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const hm = hmByChunk.get(`${chunkX},${chunkY}`);
      const baseZ = hm ? snapHeight(getHeight(hm, localX, localY)) : placerPos.z;
      const key = `${cellX},${cellY}`;
      const layer = stack.get(key) ?? 0;
      const spawnZ = baseZ + layer * cmd.voxelSize;

      const entityId = spawnPrefab(world, this.content, cmd.prefabId, { x: spawnX, y: spawnY, z: spawnZ });
      const bp = world.get(entityId, Blueprint);
      if (bp) {
        world.write(entityId, Blueprint, { ...bp, chunkX, chunkY, localX, localY });
      }
      stack.set(key, layer + 1);
      placed++;
      events.publish(TileEvents.EntityDeployed, {
        placerId, entityId, prefabId: cmd.prefabId, worldX: spawnX, worldY: spawnY, worldZ: spawnZ,
      });
    }

    log.info("placevoxels: placer=%s prefab=%s placed=%d/%d voxelSize=%.2f",
      placerId, cmd.prefabId, placed, cmd.cells.length, cmd.voxelSize);
  }
}
