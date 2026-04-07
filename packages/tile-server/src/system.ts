import type { World } from "@voxim/engine";
import type { CommandPayload } from "@voxim/protocol";
import type { SpatialGrid } from "./spatial_grid.ts";

/**
 * Minimal event emitter interface that both EventBus and DeferredEventQueue satisfy.
 * Systems always receive a DeferredEventQueue so event firing is deferred until after
 * applyChangeset() — subscribers always see the already-committed world state.
 */
export interface EventEmitter {
  publish<T>(type: symbol, event: T): void;
}

/**
 * Per-tick context injected into systems via prepare().
 * Grows as new tick-scoped resources are needed (spatial index, weather, etc.).
 */
export interface TickContext {
  /** Chunk-aligned spatial index, rebuilt from all Position components each tick. */
  spatial: SpatialGrid;

  /**
   * Commands received from players this tick, keyed by player entity ID.
   * Populated from CommandDatagrams before systems run; cleared after all systems run.
   * Systems that consume commands must implement prepare() to cache this reference
   * and process it during run(). The map itself is read-only — only the server
   * tick loop may add or remove entries.
   */
  pendingCommands: ReadonlyMap<string, CommandPayload[]>;
}

/**
 * System interface. Each system is a stateless (or near-stateless) object that
 * runs once per tick, reads the world via queries, and submits changes via world.set().
 *
 * Order is declared at the TileServer level:
 *   NpcAi → Physics → Hunger → Lifetime → Combat → Crafting → Building
 */
export interface System {
  /**
   * Called once per tick before run(). Receives the server tick number and the
   * TickContext (spatial index etc.). Optional — only implement when needed.
   */
  prepare?(serverTick: number, ctx: TickContext): void;

  run(world: World, events: EventEmitter, dt: number): void;
}
