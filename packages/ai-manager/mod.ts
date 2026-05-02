/**
 * @voxim/ai-manager — public API.
 *
 * Exposes the request / response shapes the coordinator and ai-manager share
 * across HTTP. The mock dispatcher is exported so the coordinator's tests can
 * exercise the same code path without spinning up the service.
 */
export type {
  CityContextPacket,
  AgentResponse,
  AgentToolCall,
} from "./src/types.ts";
export { mockAgentResponse } from "./src/mock.ts";
