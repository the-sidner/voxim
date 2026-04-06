/**
 * @voxim/client — Three.js browser client.
 * Depends on: @voxim/engine, @voxim/codecs, @voxim/protocol
 *
 * Entry point for bundling: import VoximGame and call game.start(config).
 * The index.html in this package provides a ready-to-use browser shell.
 */

export { VoximGame } from "./src/game.ts";
export type { GameConfig } from "./src/game.ts";

export { connectViaGateway } from "./src/connection/gateway_client.ts";
export type { GatewayResult } from "./src/connection/gateway_client.ts";

export { TileConnection } from "./src/connection/tile_connection.ts";
export { InputController } from "./src/input/input_controller.ts";
export { ClientWorld } from "./src/state/client_world.ts";
export type { EntityState, PositionState, HealthState } from "./src/state/client_world.ts";

export { VoximRenderer } from "./src/render/renderer.ts";
export { buildTerrainMesh } from "./src/render/terrain_mesh.ts";
