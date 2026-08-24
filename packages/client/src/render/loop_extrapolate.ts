/**
 * Local extrapolation of a looping animation layer's clip time (T-363).
 *
 * `AnimationSystem` used to re-send `AnimationState` every tick purely
 * because a looping clip's `time` kept advancing — an idle actor's
 * breathing loop alone made "only re-sent when a slot's state changes" (the
 * doc-comment claim at `component_registry.ts`) false. The server now
 * gates the wire delta (`wireEquals` on the `animationState` component def)
 * for exactly the layer shape this file extrapolates: `loop: true` with a
 * numeric (non-"velocity") `speedScale` — a constant-rate loop has no
 * per-tick input dependency, so its future `time` is fully determined by
 * the last value the client actually received plus real elapsed time.
 *
 * Mirrors the existing `ticksIntoAction`/`ticksInPhase` extrapolation
 * pattern already used for the swing-pose path (`renderer.ts`) and the
 * windup telegraph (`telegraph.ts`): `mesh.lastAnimUpdateMs` anchors the
 * last wire update, `performance.now()` supplies the smooth 60fps delta.
 *
 * Deliberately narrow: a one-shot clip's `time` clamps at 1.0 and a
 * velocity-scaled loop's rate depends on input the client doesn't
 * authoritatively know for remote entities — both keep shipping every tick
 * unchanged, so both are left untouched here.
 */
import type { AnimationLayer } from "@voxim/content";

export function extrapolateLoopingLayers(
  layers: readonly AnimationLayer[],
  lastAnimUpdateMs: number,
  nowMs: number,
): AnimationLayer[] {
  const elapsedSec = (nowMs - lastAnimUpdateMs) / 1000;
  if (!(elapsedSec > 0)) return layers as AnimationLayer[];

  let changed = false;
  const out = layers.map((l) => {
    if (!l.loop || typeof l.speedScale !== "number") return l;
    changed = true;
    const t = (l.time + l.speedScale * elapsedSec) % 1;
    return { ...l, time: t < 0 ? t + 1 : t };
  });
  return changed ? out : (layers as AnimationLayer[]);
}
