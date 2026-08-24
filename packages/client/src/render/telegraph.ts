/**
 * Telegraph lead clip (T-297) — client-derived pre-windup tell.
 *
 * Purely client-side projection: the server sends no extra field for this.
 * The client already receives, for every AoI entity, the primary slot's
 * `{actionId, phase, ticksInPhase}` via the networked `ActiveActions`
 * component (mirrored onto `EntityMeshGroup.activeActions`); cross-referenced
 * against the SAME ActionDef's `preWindup {clipId, ticks}` (bootstrap blob,
 * available via `ContentCache.getAction`), this is enough to know "we are
 * `ticksInPhase` ticks into the first (windup) phase, and the action wants a
 * `ticks`-long tell before its real windup motion" — no wire change needed.
 *
 * The tell is expressed as an extra `AnimationLayer` appended on TOP of the
 * server-projected layer stack (which composites bottom→top) so it reads as
 * an override during the tell window and then gets naturally superseded once
 * the real windup layer takes over — `blendAnimationLayers` cross-fades both
 * transitions via its clipId-keyed fade map, no bespoke blend code needed.
 */
import type { ActionDef } from "@voxim/content";
import type { ActiveActionsData } from "@voxim/codecs";

export interface TelegraphLayer {
  clipId: string;
  maskId: string;
  time: number;
  loop: false;
  weight: number;
  blend: "override";
  speedScale: number;
}

/**
 * Sub-tick-extrapolated ticks into the current primary-slot phase — mirrors
 * the `ticksIntoAction` extrapolation the swing-pose path already does
 * (`anim.ticksIntoAction + (now - lastAnimUpdateMs) / 50`), so the tell's own
 * internal clip time advances smoothly between the 20Hz server ticks too.
 */
function extrapolatedTicksInPhase(ticksInPhase: number, lastAnimUpdateMs: number, nowMs: number): number {
  return ticksInPhase + (nowMs - lastAnimUpdateMs) / 50;
}

/**
 * Returns the extra layer to append this frame, or null when no tell is
 * active (absent `activeActions`, no `preWindup` on the running action, past
 * the tell window, or not in the action's first phase at all).
 */
export function computeTelegraphLayer(
  activeActions: ActiveActionsData | null,
  getAction: (id: string) => ActionDef | undefined,
  lastAnimUpdateMs: number,
  nowMs: number,
): TelegraphLayer | null {
  const slot = activeActions?.states["primary"];
  if (!slot) return null;
  const def = getAction(slot.actionId);
  if (!def?.preWindup) return null;

  const firstPhase = Object.keys(def.phases)[0];
  if (slot.phase !== firstPhase) return null;

  const ticks = extrapolatedTicksInPhase(slot.ticksInPhase, lastAnimUpdateMs, nowMs);
  if (ticks >= def.preWindup.ticks) return null;

  // One-shot tell: normalised time across just the tell's own ticks span (not
  // the whole phase), so it plays through once rather than looping/clamping.
  const time = Math.max(0, Math.min(ticks / def.preWindup.ticks, 1));
  return {
    clipId: def.preWindup.clipId,
    maskId: "",
    time,
    loop: false,
    weight: 1,
    blend: "override",
    speedScale: 1,
  };
}
