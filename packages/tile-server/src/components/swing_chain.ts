/**
 * SwingChain — T-188.
 *
 * Tracks the actor's current position in their equipped weapon's combo
 * chain. Present iff the actor is mid-chain.
 *
 * Networked so the client can predict which weapon-action variant fires
 * next: at press time the client picks `chain[index].light`, at release
 * past `swingable.heavyChargeMs` it switches to `chain[index].heavy`.
 * Server remains authoritative; the client snaps to the index the
 * server publishes via the AnimationState delta path.
 *
 * Lifetime:
 *   - Created by ActionSystem on the first swing of a chain.
 *   - Index advances at swing.winddown→idle when SwingContext.queued is
 *     true (the actor pressed LMB during the previous swing's active /
 *     winddown phase, queueing a continuation).
 *   - Removed when:
 *       - winddown→idle fires with queued=false (chain ended naturally),
 *       - input.block fires (block resets chain — even a millisecond
 *         tap restarts the sequence on the next press),
 *       - actor staggers, dies, or starts a maneuver.
 *
 * The wrap behaviour is `index % chain.length` — chains can be
 * arbitrarily long but always cycle back to step 0 after the last
 * authored attack.
 */

import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { swingChainCodec } from "@voxim/codecs";
import type { SwingChainData } from "@voxim/codecs";

export type { SwingChainData } from "@voxim/codecs";

export const SwingChain = defineComponent({
  name: "swingChain" as const,
  wireId: ComponentType.swingChain,
  codec: swingChainCodec,
  default: (): SwingChainData => ({ index: 0 }),
});
