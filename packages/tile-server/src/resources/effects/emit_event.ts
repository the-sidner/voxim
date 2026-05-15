/**
 * emit_event resource effect (T-238c) — the hunger/thirst "critical"
 * coupling. A `cross` threshold with params `{ event }` publishes the
 * named `TileEvents` symbol once when the value enters the zone, payload
 * `{ entityId, value }` (matching the retired HungerSystem's
 * HungerCritical / ThirstCritical publishes — event_router / aoi consume
 * `{ entityId }`). Unknown event names fail fast.
 */

import { TileEvents } from "@voxim/protocol";
import type { ResourceEffect } from "../effect.ts";

const EVENTS = TileEvents as unknown as Record<string, symbol>;

export const emitEventEffect: ResourceEffect = {
  id: "emit_event",
  resolve(ctx) {
    const name = ctx.params.event;
    if (typeof name !== "string") {
      throw new Error(`emit_event: 'event' param must be a string (resource '${ctx.resourceId}')`);
    }
    const sym = EVENTS[name];
    if (typeof sym !== "symbol") {
      throw new Error(`emit_event: unknown TileEvents '${name}' (resource '${ctx.resourceId}')`);
    }
    ctx.events.publish(sym, { entityId: ctx.entityId, value: ctx.value });
  },
};
