/**
 * `event.*` scope variables — one-tick discrete events from TickEventBuffer.
 *
 * Pre-emits a `false` for every event in `KNOWN_EVENTS` so transitions
 * referencing them don't throw on ticks where the event hasn't fired. New
 * events authored after a transition is added need to be added here too,
 * otherwise the buffer entry would be visible but its absence would throw.
 *
 * T-194 will replace this hand-maintained list with a derivation from the
 * compiled SM defs' referenced variables.
 */

import type { SMScopeContributor } from "./types.ts";

const KNOWN_EVENTS = [
  "event.swing_started",
  "event.shoot_fired",
  "event.left_ground",
  "event.landed",
  "event.hit",
  "event.hit.heavy",
  "event.hit.from_front",
  "event.hit.from_back",
  "event.maneuver_started",
  "event.maneuver_ended",
] as const;

export const eventsContributor: SMScopeContributor = {
  namespace: "event",
  variables: KNOWN_EVENTS,
  contribute({ tickEvents, entityId }, scope) {
    for (const ev of KNOWN_EVENTS) scope[ev] = false;
    for (const ev of tickEvents.get(entityId)) scope[ev] = true;
  },
};
