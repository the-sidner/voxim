/**
 * unlock_stair effect resolver (T-213b) — the runtime half of the
 * trinket → stair unlock chain. Fired as an item's `EffectSpec` (via
 * `apply_item_effects`, same fan-out `health`-on-food uses) when a player
 * consumes a trinket carrying `{ id: "unlock_stair", params: { trinketId }
 * }`.
 *
 * Finds the `Stair` entity whose `trinketId` matches and isn't unlocked
 * yet, then:
 *
 *   1. Assembles a flat TILE_SIZE² scratch view of the CURRENTLY LOADED
 *      Heightmap/OpenMask chunks (`applyStairUnlock` operates on flat
 *      per-tile buffers, not chunked components — this is the adapter).
 *      Cells belonging to an unloaded chunk are left untouched and logged
 *      (KNOWN GAP, see below).
 *   2. Runs the byte-identical atlas `applyStairUnlock` algorithm against
 *      that scratch (same function the boot path uses for "found" stairs
 *      — no duplicated ramp/flood-fill math).
 *   3. Scatters the touched cells back into their owning chunk components
 *      via `world.set` — this rides the normal changeset/delta pipeline,
 *      so AoI clients re-mesh through the exact path terrain-dig edits
 *      already use. No new wire message.
 *   4. Flips `Stair.unlocked` and swaps `ModelRef` to the found-stair
 *      model.
 *
 * KNOWN GAP (documented, not silently accepted — see TICKETS.md T-213):
 * `ChunkLifecycleSystem.restore()` replays a chunk's CACHED pre-unlock
 * snapshot verbatim on reload. If a cell's chunk is unloaded at the moment
 * of unlock, that cell is skipped here (logged) and — if the chunk was
 * ALREADY unloaded before this fired — will restore locked on next load.
 * Narrow in practice (the load radius keeps a wide margin around the
 * player, who must be near the stair to use the trinket), but real.
 */

import type { World, EntityId } from "@voxim/engine";
import { applyStairUnlock } from "@voxim/atlas";
import { Heightmap, OpenMask, TILE_SIZE } from "@voxim/world";
import type { HeightmapData, OpenMaskData } from "@voxim/world";
import type { EffectResolver, ResolveContext } from "../effect.ts";
import { Stair } from "../../components/stair.ts";
import { ModelRef } from "../../components/game.ts";
import { STAIR_FOUND_PREFAB_ID } from "../../stair_spawner.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("unlock_stair");

/** Lazily-read accessor — `zoneBuffer` is assigned on `TileServer` AFTER
 * this resolver is constructed+registered at boot (loadTerrainFromAtlas
 * runs later in `start()`), so a captured value would be stale/null. The
 * closure reads it fresh at call time instead. */
export type ZoneBufferAccessor = () => Uint16Array | null;

interface ChunkEntry {
  entityId: EntityId;
  heightmap: HeightmapData;
  openMask: OpenMaskData;
}

export class UnlockStairResolver implements EffectResolver {
  readonly id = "unlock_stair";

  constructor(private readonly getZoneBuffer: ZoneBufferAccessor) {}

  resolve(ctx: ResolveContext): void {
    const trinketId = ctx.params.trinketId;
    if (typeof trinketId !== "string" || trinketId.length === 0) return;

    const zoneBuffer = this.getZoneBuffer();
    if (!zoneBuffer) {
      log.warn("unlock_stair fired before zoneBuffer is available — no-op");
      return;
    }

    const match = ctx.world.query(Stair).find(
      (s) => s.stair.trinketId === trinketId && !s.stair.unlocked,
    );
    if (!match) {
      log.info("unlock_stair: trinketId=%s matches no locked stair (already unlocked or unknown)", trinketId);
      return;
    }
    const { entityId: stairId, stair } = match;

    // ── 1. Assemble a flat TILE_SIZE² scratch from loaded chunks. ──
    const chunks: ChunkEntry[] = [];
    for (const { entityId, heightmap } of ctx.world.query(Heightmap)) {
      const openMask = ctx.world.get(entityId, OpenMask);
      if (!openMask) continue; // incomplete chunk — same defensive stance as ChunkLifecycleSystem
      chunks.push({ entityId, heightmap, openMask });
    }

    const heightBuffer = new Float32Array(TILE_SIZE * TILE_SIZE);
    const openBuffer = new Uint8Array(TILE_SIZE * TILE_SIZE);
    const loadedCellMask = new Uint8Array(TILE_SIZE * TILE_SIZE); // 1 = this cell's chunk is loaded
    const chunkSize = Math.sqrt(chunks[0]?.heightmap.data.length ?? 1024) | 0;

    for (const c of chunks) {
      const baseX = c.heightmap.chunkX * chunkSize;
      const baseY = c.heightmap.chunkY * chunkSize;
      for (let ly = 0; ly < chunkSize; ly++) {
        for (let lx = 0; lx < chunkSize; lx++) {
          const gx = baseX + lx, gy = baseY + ly;
          if (gx < 0 || gy < 0 || gx >= TILE_SIZE || gy >= TILE_SIZE) continue;
          const gidx = gy * TILE_SIZE + gx;
          const lidx = ly * chunkSize + lx;
          heightBuffer[gidx] = c.heightmap.data[lidx];
          openBuffer[gidx] = c.openMask.data[lidx];
          loadedCellMask[gidx] = 1;
        }
      }
    }

    // ── 2. Run the byte-identical atlas algorithm. ──
    const touched = applyStairUnlock(heightBuffer, openBuffer, zoneBuffer, TILE_SIZE, {
      wildernessZoneId: stair.toZoneId,
      anchor: { x: stair.anchorX, y: stair.anchorY },
      wallHeight: stair.wallHeight,
      rampDepth: stair.rampDepth,
      rampHalfWidth: stair.rampHalfWidth,
    });

    if (touched === 0) {
      log.warn("unlock_stair: stair=%s applyStairUnlock touched 0 cells (anchor not adjacent to its wilderness zone?)", stair.stairId);
    }

    // ── 3. Scatter touched cells back into their owning chunks. ──
    let unloadedSkipped = 0;
    for (const c of chunks) {
      const baseX = c.heightmap.chunkX * chunkSize;
      const baseY = c.heightmap.chunkY * chunkSize;
      let chunkTouched = false;
      const newHeight = c.heightmap.data.slice();
      const newOpen = c.openMask.data.slice();
      for (let ly = 0; ly < chunkSize; ly++) {
        for (let lx = 0; lx < chunkSize; lx++) {
          const gx = baseX + lx, gy = baseY + ly;
          if (gx < 0 || gy < 0 || gx >= TILE_SIZE || gy >= TILE_SIZE) continue;
          const gidx = gy * TILE_SIZE + gx;
          const lidx = ly * chunkSize + lx;
          if (newHeight[lidx] !== heightBuffer[gidx] || newOpen[lidx] !== openBuffer[gidx]) {
            newHeight[lidx] = heightBuffer[gidx];
            newOpen[lidx] = openBuffer[gidx];
            chunkTouched = true;
          }
        }
      }
      if (chunkTouched) {
        ctx.world.set(c.entityId, Heightmap, { ...c.heightmap, data: newHeight });
        ctx.world.set(c.entityId, OpenMask, { ...c.openMask, data: newOpen });
      }
    }

    // Cells whose wilderness zone matches but whose chunk was never in the
    // loaded set at all can't be detected via the scatter loop above (they
    // never had a scratch entry) — cheaply estimate via the zoneBuffer scan
    // the algorithm already did, cross-referenced against loadedCellMask.
    for (let idx = 0; idx < zoneBuffer.length; idx++) {
      if (zoneBuffer[idx] === stair.toZoneId && loadedCellMask[idx] === 0) unloadedSkipped++;
    }
    if (unloadedSkipped > 0) {
      log.warn(
        "unlock_stair: stair=%s wildernessZone=%d has %d cells in unloaded chunks — " +
        "they will NOT reflect the unlock until manually re-touched (KNOWN GAP, see TICKETS.md T-213)",
        stair.stairId, stair.toZoneId, unloadedSkipped,
      );
    }

    // ── 4. Flip lock state + swap the visible model. ──
    ctx.world.set(stairId, Stair, { ...stair, unlocked: true });
    const foundModelId = ctx.content.prefabs.get(STAIR_FOUND_PREFAB_ID)?.modelId;
    const currentModel = ctx.world.get(stairId, ModelRef);
    if (foundModelId && currentModel) {
      ctx.world.set(stairId, ModelRef, { ...currentModel, modelId: foundModelId });
    }

    log.info("unlock_stair: stair=%s trinket=%s touched=%d cells (chunks=%d)", stair.stairId, trinketId, touched, chunks.length);
  }
}
