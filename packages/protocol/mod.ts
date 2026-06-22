// @voxim/protocol — message schemas, event definitions, Serialiser re-export
// Depends on: @voxim/engine

// Re-export Serialiser so consumers can import it from here without depending on engine directly
export type { Serialiser } from "@voxim/engine";

export { encodeFrame, makeFrameReader } from "./src/framing.ts";

export {
  SERVICE_SECRET_HEADER,
  MIN_SERVICE_SECRET_LENGTH,
  constantTimeEqualStrings,
  verifyServiceSecret,
  isProduction,
  resolveServiceSecret,
} from "./src/service_auth.ts";

export {
  WORLD_MAP_VERSION,
  encodeWorldMap,
  decodeWorldMap,
} from "./src/world_map.ts";
export type {
  WorldMapCell,
  WorldMapPayload,
  GatePosition,
} from "./src/world_map.ts";

export type {
  MovementDatagram,
  CommandDatagram,
  CommandPayload,
  GameEvent,
  DamageDealtEvent,
  EntityDiedEvent,
  CraftingCompletedEvent,
  BuildingCompletedEvent,
  HungerCriticalEvent,
  GateApproachedEvent,
  NodeDepletedEvent,
  DayPhaseChangedEvent,
  TradeCompletedEvent,
  LoreExternalisedEvent,
  LoreInternalisedEvent,
} from "./src/messages.ts";

export {
  CommandType,
  EquipSlotIndex,
  EQUIP_SLOT_NAMES,
  ACTION_USE_SKILL,
  ACTION_BLOCK,
  ACTION_JUMP,
  ACTION_DODGE,
  ACTION_CROUCH,
  ACTION_CONSUME,
  ACTION_SKILL_1,
  ACTION_SKILL_2,
  ACTION_SKILL_3,
  ACTION_SKILL_4,
  hasAction,
} from "./src/messages.ts";

export { TileEvents } from "./src/tile_events.ts";
export type {
  EntityDiedPayload,
  DamageDealtPayload,
  CraftingCompletedPayload,
  BuildingCompletedPayload,
  HungerCriticalPayload,
  ThirstCriticalPayload,
  GateApproachedPayload,
  NodeDepletedPayload,
  DayPhaseChangedPayload,
  HitLandedPayload,
  EntityDeployedPayload,
  TradeCompletedPayload,
  LoreExternalisedPayload,
  LoreInternalisedPayload,
} from "./src/tile_events.ts";

export {
  movementDatagramCodec,
  commandDatagramCodec,
  decodeDatagram,
  DATAGRAM_TYPE_MOVEMENT,
  DATAGRAM_TYPE_COMMAND,
} from "./src/codecs.ts";
export type { DecodedDatagram } from "./src/codecs.ts";

export type {
  WorldSnapshot,
  SnapshotEntity,
} from "./src/world_snapshot.ts";
export { worldSnapshotCodec } from "./src/world_snapshot.ts";

export type {
  ModelDefinition,
  MaterialDef,
  SkeletonDef,
  ContentRequest,
  ContentResponse,
} from "./src/content.ts";
export { contentRequestCodec, contentResponseCodec } from "./src/content.ts";

export { ComponentType, COMPONENT_TYPE_TO_NAME } from "./src/component_types.ts";
export { EventType } from "./src/event_types.ts";
export { binaryStateMessageCodec } from "./src/state_binary.ts";
export type {
  BinaryComponentEntry,
  BinaryEntitySpawn,
  BinaryComponentDelta,
  BinaryComponentRemoval,
  BinaryStateMessage,
} from "./src/state_binary.ts";

export { WorldEvents } from "./src/world_events.ts";

export {
  FOG_GRID_SIZE,
  FOG_CELL_SIZE,
  FOG_CELL_COUNT,
  FOG_GRID_BYTES,
  LOS_HALF_ANGLE_RAD,
  LOS_RADIUS,
  LOS_RAY_COUNT,
  LOS_STEP,
  fogCellIndex,
  packFogCell,
  unpackFogCell,
} from "./src/fog.ts";

export type {
  GatewayConnectRequest,
  GatewayTileResponse,
  GatewayRegisterRequest,
  GatewayRegisterResponse,
  GatewayHeartbeatRequest,
  GatewayHeartbeatResponse,
  TileJoinRequest,
  TileJoinAck,
  BootstrapHeader,
  TileHandoffRequest,
  TileHandoffAck,
  ServiceHandshake,
  ServiceHandshakeAck,
  WorldEventEnvelope,
  TileCommandEnvelope,
} from "./src/gateway.ts";
export type {
  PlayerCrossedGatePayload,
  TileServerStartedPayload,
  TileServerStoppedPayload,
  CaravanDepartedPayload,
  CityRaidedPayload,
} from "./src/world_events.ts";
