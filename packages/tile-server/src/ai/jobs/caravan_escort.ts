/**
 * CaravanEscort (T-048) — walk a caravan lead NPC to the edge gate bound for
 * its destination tile, then hand off.
 *
 * The destination is the caravan's manifest, not the job: the handler reads
 * the `Caravan` component on the NPC (single source of truth for where it's
 * going + what it carries) and the job's `destinationTileId` is the snapshot
 * the BT/spawn seeded it with. Each tick it resolves the `GateLink` entity
 * whose `destinationTileId` matches and walks toward it.
 *
 * v1 SCOPE: spawn-with-goods + walk-to-the-correct-gate. The cross-tile
 * handoff of an *NPC* (vs. the player path in server.ts / handoff.ts) is
 * multi-process and not verifiable from a single tile-server, so on arrival
 * the handler logs the intended handoff and clears the job. Wiring the NPC
 * through `initiateHandoff` is a follow-up (see T-048 note).
 */
import type { GameConfig } from "@voxim/content";
import type { World } from "@voxim/engine";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { Position } from "../../components/game.ts";
import { GateLink } from "../../components/gate.ts";
import { Caravan } from "../../components/caravan.ts";
import { moveSteps } from "../plan_helpers.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("CaravanEscort");

const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

/** A long escort: a caravan should not abandon the trek to its gate. */
const CARAVAN_EXPIRY_TICKS = 6000;

/** How close (world units) the lead must get to the gate to "arrive". */
const ARRIVAL_DIST = 3;

type CaravanJob = Extract<Job, { type: "caravanEscort" }>;

export const caravanEscortJob: JobHandler = {
  id: "caravanEscort",

  expiryTicks(_defaults: GameConfig["npcAiDefaults"]): number {
    return CARAVAN_EXPIRY_TICKS;
  },

  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "caravanEscort") return null;
    const gate = findGateTo(ctx.world, destinationOf(ctx, job));
    if (!gate) return null;
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, gate.x, gate.y, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
      lastKnownTargetX: gate.x,
      lastKnownTargetY: gate.y,
    };
  },

  tick(input: JobTickInput): JobTickAction {
    const { ctx, job } = input;
    if (job.type !== "caravanEscort") return NO_ACTION;

    const destinationTileId = destinationOf(ctx, job);
    const gate = findGateTo(ctx.world, destinationTileId);
    if (!gate) {
      // No gate to this tile on this map — nothing to escort toward.
      return { ...NO_ACTION, clearJob: true };
    }

    const dx = gate.x - ctx.pos.x;
    const dy = gate.y - ctx.pos.y;
    if (dx * dx + dy * dy <= ARRIVAL_DIST * ARRIVAL_DIST) {
      // Arrived at the gate. The cross-tile NPC handoff is a follow-up; for
      // now record the intent + manifest and drop the job (the lead idles at
      // the gate until the BT re-plans).
      const caravan = ctx.world.get(ctx.entityId, Caravan);
      const goods = caravan?.goods.map((g) => `${g.quantity}x ${g.itemType}`).join(", ") ?? "(none)";
      log.info(
        "caravan %s reached gate to %s — TODO handoff (goods: %s)",
        ctx.entityId, destinationTileId, goods,
      );
      return { ...NO_ACTION, clearJob: true };
    }

    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};

/**
 * The caravan's bound tile. The manifest on the entity wins (it's the source
 * of truth); the job's snapshot is the fallback when no Caravan is present
 * (e.g. a BT seeding the job directly).
 */
function destinationOf(ctx: JobContext, job: CaravanJob): string {
  return ctx.world.get(ctx.entityId, Caravan)?.destinationTileId || job.destinationTileId;
}

/** Position of the GateLink entity whose destinationTileId matches, if any. */
function findGateTo(world: World, destinationTileId: string): { x: number; y: number } | null {
  if (!destinationTileId) return null;
  for (const { entityId, gateLink } of world.query(GateLink)) {
    if (gateLink.destinationTileId !== destinationTileId) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    return { x: pos.x, y: pos.y };
  }
  return null;
}
