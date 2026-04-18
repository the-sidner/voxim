/**
 * EventRouter — translates internal TileEvents into the GameEvent envelope
 * the client wire protocol carries. Drained once per tick by the tile server
 * and written into each session's BinaryStateMessage.
 *
 * Before extraction this was ~150 lines of back-to-back `eventBus.subscribe`
 * calls inlined in server.ts. Each one had the same shape: read the payload,
 * push a GameEvent into an accumulator. Centralising them here means adding
 * a new GameEvent type is one subscribe call in this file, not a diff in the
 * server class.
 *
 * The GateApproached subscriber is the one that carries side-effects beyond
 * queueing a GameEvent — it also triggers the cross-tile handoff. That side
 * is injected via the `onGateApproached` hook so the router stays ignorant
 * of gateway / session management.
 */
import type { EntityId, EventBus } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { GameEvent } from "@voxim/protocol";

/** Optional callback fired when a player crosses a gate, after the event is queued for delivery. */
export type GateApproachedHandler = (payload: {
  entityId: EntityId;
  gateId: string;
  destinationTileId: string;
}) => void;

export class EventRouter {
  private readonly pending: GameEvent[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly onGateApproached: GateApproachedHandler | null = null,
  ) {
    this.subscribe();
  }

  /** Return and clear the accumulated events. Called once per tick. */
  drain(): GameEvent[] {
    return this.pending.splice(0);
  }

  private subscribe(): void {
    const bus = this.eventBus;
    const push = (e: GameEvent) => this.pending.push(e);

    bus.subscribe(TileEvents.EntityDied, (p: { entityId: EntityId; killerId?: EntityId }) => {
      push({ type: "EntityDied", entityId: p.entityId, killerId: p.killerId });
    });

    bus.subscribe(TileEvents.HitSpark, (p: { x: number; y: number; z: number }) => {
      push({ type: "HitSpark", x: p.x, y: p.y, z: p.z });
    });

    bus.subscribe(TileEvents.DamageDealt, (p: {
      targetId: EntityId;
      sourceId: EntityId;
      amount: number;
      blocked: boolean;
      hitX: number;
      hitY: number;
      hitZ: number;
    }) => {
      push({
        type: "DamageDealt",
        targetId: p.targetId,
        sourceId: p.sourceId,
        amount: p.amount,
        blocked: p.blocked,
        hitX: p.hitX,
        hitY: p.hitY,
        hitZ: p.hitZ,
      });
    });

    bus.subscribe(TileEvents.BuildingCompleted, (p: {
      builderId: EntityId;
      blueprintId: EntityId;
      structureType: string;
    }) => {
      push({
        type: "BuildingCompleted",
        builderId: p.builderId,
        blueprintId: p.blueprintId,
        structureType: p.structureType,
      });
    });

    bus.subscribe(TileEvents.BuildingMaterialsConsumed, (p: {
      builderId: EntityId;
      structureType: string;
      consumed: { itemType: string; quantity: number }[];
    }) => {
      push({
        type: "BuildingMaterialsConsumed",
        builderId: p.builderId,
        structureType: p.structureType,
        consumed: p.consumed,
      });
    });

    bus.subscribe(TileEvents.BuildingMissingMaterials, (p: {
      builderId: EntityId;
      structureType: string;
      missing: { itemType: string; quantity: number }[];
    }) => {
      push({
        type: "BuildingMissingMaterials",
        builderId: p.builderId,
        structureType: p.structureType,
        missing: p.missing,
      });
    });

    bus.subscribe(TileEvents.CraftingCompleted, (p: {
      crafterId: EntityId;
      recipeId: string;
    }) => {
      push({ type: "CraftingCompleted", crafterId: p.crafterId, recipeId: p.recipeId });
    });

    bus.subscribe(TileEvents.HungerCritical, (p: { entityId: EntityId }) => {
      push({ type: "HungerCritical", entityId: p.entityId });
    });

    bus.subscribe(TileEvents.GateApproached, (p: {
      entityId: EntityId;
      gateId: string;
      destinationTileId: string;
    }) => {
      push({
        type: "GateApproached",
        entityId: p.entityId,
        gateId: p.gateId,
        destinationTileId: p.destinationTileId,
      });
      // Handoff side-effect is delegated to the server — this router deals in
      // GameEvent translation only.
      this.onGateApproached?.(p);
    });

    bus.subscribe(TileEvents.NodeDepleted, (p: {
      nodeId: EntityId;
      nodeTypeId: string;
      harvesterId: EntityId;
    }) => {
      push({
        type: "NodeDepleted",
        nodeId: p.nodeId,
        nodeTypeId: p.nodeTypeId,
        harvesterId: p.harvesterId,
      });
    });

    bus.subscribe(TileEvents.DayPhaseChanged, (p: { phase: string; timeOfDay: number }) => {
      push({ type: "DayPhaseChanged", phase: p.phase, timeOfDay: p.timeOfDay });
    });

    bus.subscribe(TileEvents.TradeCompleted, (p: {
      buyerId: EntityId; traderId: EntityId; itemType: string; quantity: number; coinDelta: number;
    }) => {
      push({
        type: "TradeCompleted",
        buyerId: p.buyerId,
        traderId: p.traderId,
        itemType: p.itemType,
        quantity: p.quantity,
        coinDelta: p.coinDelta,
      });
    });

    bus.subscribe(TileEvents.LoreExternalised, (p: { entityId: EntityId; fragmentId: string }) => {
      push({ type: "LoreExternalised", entityId: p.entityId, fragmentId: p.fragmentId });
    });

    bus.subscribe(TileEvents.LoreInternalised, (p: { entityId: EntityId; fragmentId: string }) => {
      push({ type: "LoreInternalised", entityId: p.entityId, fragmentId: p.fragmentId });
    });
  }
}
