// @voxim/gateway — signaling server, tile orchestrator, client handshake
// Depends on: @voxim/engine, @voxim/protocol, @voxim/db

export { GatewayServer } from "./src/server.ts";
export type { GatewayConfig } from "./src/server.ts";

export { TileOrchestrator, NoopSpawner } from "./src/edge/tile_orchestrator.ts";
export type { TileSpawner, TileOrchestratorConfig } from "./src/edge/tile_orchestrator.ts";
