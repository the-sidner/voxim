/**
 * Action-installed tags (T-226b) — presence-as-flag markers that ambient /
 * active actions stamp onto an actor for the duration of a phase via the
 * `set_tag` / `clear_tag` effect resolvers.
 *
 * `TAG_COMPONENTS` is the closed name→def map those resolvers dispatch
 * through (same registry shape as effects/gates). Adding a tag is a one-line
 * entry here plus the def. Server-only: a tag's gameplay consequence reaches
 * the client through whatever it already drives (e.g. `crouched` reaches the
 * client as the resolved locomotion clip in the networked AnimationState),
 * not as a wire component of its own.
 */

import type { ComponentDef, Serialiser } from "@voxim/engine";
import { defineComponent } from "@voxim/engine";

const emptyCodec: Serialiser<Record<string, never>> = {
  encode: () => new Uint8Array(),
  decode: () => ({}),
};

/**
 * Crouched — installed by the `crouched` posture action while it occupies
 * the posture slot; absence means upright. Read by the `posture` CSM scope
 * contributor so the still-CSM-resident locomotion layer keeps selecting
 * crouch clip variants exactly as before the posture layer was retired.
 */
export const Crouched = defineComponent({
  name: "crouched" as const,
  networked: false,
  codec: emptyCodec,
  default: (): Record<string, never> => ({}),
});

/**
 * Blocking — installed by the `block` action while it occupies the primary
 * slot. Read by health_hit_handler for parry/block (current-tick; the
 * retired CSM right_hand rewind precision is retuned later, per the
 * structure-over-parity pivot).
 */
export const Blocking = defineComponent({
  name: "blocking" as const,
  networked: false,
  codec: emptyCodec,
  default: (): Record<string, never> => ({}),
});

/** Closed tag vocabulary the set_tag / clear_tag resolvers dispatch through. */
// deno-lint-ignore no-explicit-any
export const TAG_COMPONENTS: Readonly<Record<string, ComponentDef<any>>> = {
  crouched: Crouched,
  blocking: Blocking,
};
