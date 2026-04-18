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
 * Execution order is computed at startup from `dependsOn` edges — see
 * [system_order.ts](./system_order.ts). Systems without declared dependencies
 * fall back to the order they appear in the array passed to the sorter, which
 * keeps the server file readable as a pipeline while letting the sorter fix
 * any pair whose ordering is load-bearing.
 */
export interface System {
  /**
   * Called once per tick before run(). Receives the server tick number and the
   * TickContext (spatial index etc.). Optional — only implement when needed.
   */
  prepare?(serverTick: number, ctx: TickContext): void;

  run(world: World, events: EventEmitter, dt: number): void;

  /**
   * Optional override for the name used by the dependency sorter. Defaults to
   * the class's constructor name. Set this when the class is renamed but
   * `dependsOn` sites should keep referring to the old name, or when a
   * generic wrapper needs a more specific identity.
   */
  readonly name?: string;

  /**
   * Names of systems that must run earlier in the same tick. The topological
   * sort at startup guarantees each listed name appears before this system
   * in the final order. An empty or absent list means "order relative to
   * everything else doesn't matter"; the sorter preserves input position for
   * those.
   */
  readonly dependsOn?: string[];
}
