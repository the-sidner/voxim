/**
 * FogOfWarSystem (T-157) — runs the LOS cone for every player with a
 * FogState component and accumulates newly-revealed fog cells.
 *
 * Algorithm: a fan of rays in the player's facing direction, each walked in
 * world-unit steps and terminated at the first closed cell (queried via the
 * shared OpennessFn the physics system already builds for collision).  Every
 * world cell the rays touch is mapped down to its fog cell (one fog cell per
 * 2×2 world units) and bit-set in the FogState bitmap.  Cells that flipped
 * 0→1 are pushed onto `revealedThisTick` for the send path to drain.
 *
 * Cost: ~LOS_RAY_COUNT × LOS_RADIUS / LOS_STEP cell touches per player per
 * tick — ≈110 × 80 = 8800 probes/player/tick.  Trivial.
 *
 * This system is intentionally **NPC-blind**: only entities carrying
 * FogState are processed.  Spawner installs FogState on the local player
 * spawn path and nowhere else.  No `isNpc` branches needed.
 */
import type { World } from "@voxim/engine";
import {
  FOG_CELL_SIZE,
  FOG_GRID_SIZE,
  LOS_HALF_ANGLE_RAD,
  LOS_RADIUS,
  LOS_RAY_COUNT,
  LOS_STEP,
  packFogCell,
} from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Position, Facing } from "../components/game.ts";
import { FogState, fogBitSet } from "../components/fog_state.ts";
import { buildOpennessLookup } from "../physics/terrain_lookup.ts";

export class FogOfWarSystem implements System {
  /** Run after PhysicsSystem so positions are fresh (positions are written via
   *  world.set inside physics; with the deferred-changeset model they'd only
   *  reach us next tick anyway, but ordering makes intent explicit). */
  readonly dependsOn = ["PhysicsSystem"];

  run(world: World, _events: EventEmitter, _dt: number): void {
    const isOpen = buildOpennessLookup(world);

    for (const { entityId, position, facing } of world.query(Position, Facing)) {
      const fog = world.get(entityId, FogState);
      if (!fog) continue;

      const px = position.x;
      const py = position.y;
      const angle = facing.angle;
      const startAngle = angle - LOS_HALF_ANGLE_RAD;
      const angleStep  = (LOS_HALF_ANGLE_RAD * 2) / (LOS_RAY_COUNT - 1);

      const seen = fog.seenEver;
      const revealed = fog.revealedThisTick;

      // Player's own fog cell is always lit — keeps a halo when wedged.
      tryReveal(seen, revealed, px, py);

      for (let r = 0; r < LOS_RAY_COUNT; r++) {
        const a = startAngle + r * angleStep;
        const dx = Math.cos(a);
        const dy = Math.sin(a);

        let lastFogIdx = -1;
        for (let s = LOS_STEP; s <= LOS_RADIUS; s += LOS_STEP) {
          const wx = px + dx * s;
          const wy = py + dy * s;

          const cx = Math.floor(wx / FOG_CELL_SIZE);
          const cy = Math.floor(wy / FOG_CELL_SIZE);
          if (cx < 0 || cy < 0 || cx >= FOG_GRID_SIZE || cy >= FOG_GRID_SIZE) break;

          const idx = packFogCell(cx, cy);
          if (idx !== lastFogIdx) {
            if (fogBitSet(seen, idx)) revealed.push(idx);
            lastFogIdx = idx;
          }
          // The cell itself is illuminated even if it's a wall — then the
          // ray terminates so we don't see past it.
          if (!isOpen(wx, wy)) break;
        }
      }
    }
  }
}

function tryReveal(seen: Uint8Array, revealed: number[], wx: number, wy: number): void {
  const cx = Math.floor(wx / FOG_CELL_SIZE);
  const cy = Math.floor(wy / FOG_CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= FOG_GRID_SIZE || cy >= FOG_GRID_SIZE) return;
  const idx = packFogCell(cx, cy);
  if (fogBitSet(seen, idx)) revealed.push(idx);
}
