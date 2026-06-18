/**
 * Combat components — per-entity state that only exists while an entity is
 * in a specific combat condition.
 *
 * All components in this file follow the "component presence as flag" rule:
 * the component exists iff the state is active. Absence is the zero state.
 * Never written at spawn.
 *
 *   CounterReady     — parried an attack and has a bonus-damage window open.
 *                      Server-only (T-250): combat presence-flags are not
 *                      networked — the wire carries data (Health,
 *                      AnimationState), not flags. The window is bounded by a
 *                      `counter_window` Resource (cross@0 → clear_counter_ready
 *                      removes this tag) — the same lifetime mechanism buffs
 *                      and projectiles use, so an unconsumed counter expires
 *                      instead of latching forever.
 *
 * The parry window is read from the held `block` action's primary-slot
 * `ticksInPhase` (T-233) — no BlockHeld counter / CombatTimersSystem.
 *
 * Stagger is no longer a component here — it's the `stagger_light` /
 * `stagger_heavy` reaction actions (phase duration = stagger window) plus
 * the `staggered` tag (components/tags.ts) for the action-lockout; the
 * client renders it from the networked reaction-slot AnimationState (T-232).
 *
 * Dodge invulnerability is the `iframe` tag installed by the `dodge_roll`
 * action's dash phase (see components/tags.ts); the retired IFrameActive /
 * DodgeCooldown countdowns are gone with the dodge migration (T-229).
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";

const emptyCodec: Serialiser<Record<string, never>> = {
  encode: () => new Uint8Array(),
  decode: () => ({}),
};

// ---- CounterReady (server-only, zero-payload marker) ----------------------

export const CounterReady = defineComponent({
  name: "counterReady" as const,
  networked: false,
  codec: emptyCodec,
  default: (): Record<string, never> => ({}),
});

// ---- Airborne (server-only marker) ----------------------------------------
//
// Present iff the entity's feet are off the ground this tick. PhysicsSystem
// is the sole writer (computes from post-integration position vs terrain) and
// uses world.write so the same-tick CSM tick reads it without a one-frame
// lag. Empty payload — presence is the flag.

export const Airborne = defineComponent({
  name: "airborne" as const,
  networked: false,
  codec: emptyCodec,
  default: (): Record<string, never> => ({}),
});

// Poise (T-197) retired as a standalone component (T-238d): it is now
// `Resource.values.poise` — a pure-regen tick scalar owned by
// ResourceSystem (data/resources/poise.json). The hit handler still owns
// poise *damage* and the break → stagger tier decision; it just reads and
// writes the Resource now.
