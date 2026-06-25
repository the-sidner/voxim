/**
 * AnimationSystem — projects the action slots into AnimationLayer[] each
 * tick (T-228: the CSM is gone).
 *
 * For every entity with AnimationState, projects the locomotion, primary,
 * and reaction slots (in that composite order — reaction on top) from their
 * `ActiveActions` state into one AnimationLayer each, resolving clips via
 * `prefab.animationSlots` (+ the equipped weapon's clip injected for
 * `$weapon.swing_clip`) and advancing per-clip time from the previous
 * AnimationState. weaponActionId / ticksIntoAction for the client trail
 * are derived from the primary swing. Pure projector — behaviour lives in
 * the action defs + the dispatcher, not here.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type {
  ContentService,
  AnimationStateData,
  AnimationLayer,
} from "@voxim/content";
import { Velocity, AnimationState } from "../components/game.ts";
import { ActiveActions, SwingChain } from "../components/action.ts";
import type { ActiveActionState } from "../components/action.ts";
import { Crouched } from "../components/tags.ts";
import { Equipment } from "../components/equipment.ts";
import type { SwingableData } from "@voxim/content";
import { AnimationSlots } from "../components/animation_slots.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("AnimationSystem");

const TICK_DT = 1 / 20;

/**
 * DEBUG: when true, AnimationSystem emits empty AnimationLayer[] for every
 * entity, so the skeleton FK (server HitboxSystem + client renderer) falls
 * through to the rest pose. Use this to verify that the biped's bind /
 * voxel-rest orientation is correct before diagnosing animation issues.
 *
 * Revert to `false` after the visual check.
 */
const DEBUG_FORCE_REST_POSE = false;

export class AnimationSystem implements System {
  /** Reads ActiveActions (ActionDispatcher writes); must run after it. */
  readonly dependsOn = ["ActionDispatcher"];

  /** One-shot dedupe for projection failures so a recurring per-entity issue logs once. */
  private loggedFailures = new Set<string>();

  constructor(private readonly content: ContentService) {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    const cfg = this.content.getGameConfig();
    const walkSpeedRef = cfg.physics.maxGroundSpeed;

    for (const { entityId } of world.query(AnimationState)) {
      try {
        this.projectOne(world, entityId, walkSpeedRef);
      } catch (err) {
        const key = (err as Error).message;
        if (!this.loggedFailures.has(key)) {
          this.loggedFailures.add(key);
          log.error("animation projection failed for entity=%s: %s", entityId, key);
        }
      }
    }
  }

  private projectOne(
    world: World,
    entityId: string,
    walkSpeedRef: number,
  ): void {
    if (DEBUG_FORCE_REST_POSE) {
      const prev = world.get(entityId, AnimationState);
      const next: AnimationStateData = { layers: [], weaponActionId: "", ticksIntoAction: 0 };
      if (!animStatesEqual(prev, next)) world.set(entityId, AnimationState, next);
      return;
    }

      const baseSlots = world.get(entityId, AnimationSlots)?.slots ?? {};
      // The swing/block/aim clips are weapon-specific. Inject the equipped
      // weapon's geometry-action clip (the same chain[0] source weapon_trace
      // reads) so `$weapon.swing_clip` etc. resolve to the held weapon's
      // animation rather than the actor-prefab default. (T-227 — replaces
      // the retired SwingContext-driven injection.)
      const equipped = world.get(entityId, Equipment)?.weapon?.prefabId;
      const swingable = equipped
        ? this.content.prefabs.get(equipped)?.components["swingable"] as SwingableData | undefined
        : undefined;
      // The combo's current step (SwingChain) selects which chain entry's
      // WeaponActionDef supplies the clip + geometry — so consecutive swings
      // alternate, and a charged swing plays its `.heavy` variant. (T-295
      // follow-up; replaces the hardcoded chain[0].)
      const chainActionId = pickChainWeaponAction(world, entityId, swingable);
      const geomAction = chainActionId
        ? this.content.weaponActions.get(chainActionId)
        : undefined;
      const slotMap = geomAction?.clipId
        ? { ...baseSlots, "weapon.swing_clip": geomAction.clipId }
        : baseSlots;

      const speed = velocityMagnitude(world, entityId);
      const prev  = world.get(entityId, AnimationState);
      const prevTime = getTimeByClip(prev);

      const layers: AnimationLayer[] = [];

      // Locomotion (T-226c) + primary (T-227) are action slots, not CSM
      // layers. Project locomotion first (lowest composite priority, where
      // the retired CSM locomotion layer sat), then primary (upper body,
      // above locomotion). Both read last-tick's committed ActiveActions
      // (deferred-write lag = the CSM's old deferred layerState lag).
      const slots = world.get(entityId, ActiveActions)?.states;
      const locoLayer = projectLocomotion(
        this.content, slots?.["locomotion"], world.has(entityId, Crouched),
        slotMap, prevTime, speed, walkSpeedRef, true, // idle fallback: locomotion only
      );
      if (locoLayer) layers.push(locoLayer);
      const primaryLayer = projectLocomotion(
        this.content, slots?.["primary"], false,
        slotMap, prevTime, speed, walkSpeedRef, // no idle fallback — empty = silent
      );
      if (primaryLayer) layers.push(primaryLayer);

      // Reaction slot (T-228) — hit/stagger/death overrides, projected last
      // so it composites on top (the retired CSM reaction layer was the
      // highest-priority animation layer).
      const reactionLayer = projectLocomotion(
        this.content, slots?.["reaction"], false,
        slotMap, prevTime, speed, walkSpeedRef,
      );
      if (reactionLayer) layers.push(reactionLayer);

      // weaponActionId / ticksIntoAction drive the client weapon-trail +
      // attachment. Derived from the primary slot running a swing action
      // (effects include weapon_trace). Trail-window precision is retuned
      // later (structure-over-parity pivot) — for now: geometry action id
      // while a swing is committed, ticks accumulated across the phases.
      const pa = slots?.["primary"];
      const paDef = pa ? this.content.actions.get(pa.actionId) : undefined;
      const paSwing = !!paDef?.effects.some((e) => e.kind === "weapon_trace") && !!geomAction;
      const weaponActionId = paSwing ? geomAction!.id : "";
      let ticksIntoAction = 0;
      if (paSwing && pa) {
        if (pa.phase === "active") ticksIntoAction = geomAction!.windupTicks + pa.ticksInPhase;
        else if (pa.phase === "winddown") ticksIntoAction = geomAction!.windupTicks + geomAction!.activeTicks + pa.ticksInPhase;
        // windup stays 0 — pre-active, no trail slices.
      }

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };
      if (!animStatesEqual(prev, next)) {
        world.set(entityId, AnimationState, next);
      }
  }

}

// ---- helpers ----

function velocityMagnitude(world: World, entityId: string): number {
  const v = world.get(entityId, Velocity);
  if (!v) return 0;
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** The WeaponActionDef id for this actor's current combo step + heavy flag
 *  (SwingChain). Undefined when unarmed / chainless — callers fall back. */
function pickChainWeaponAction(
  world: World,
  entityId: string,
  swingable: SwingableData | undefined,
): string | undefined {
  const len = swingable?.chain.length ?? 0;
  if (!swingable || len === 0) return undefined;
  const sc = world.get(entityId, SwingChain);
  const entry = swingable.chain[(sc?.index ?? 0) % len];
  return sc?.heavy ? entry.heavy : entry.light;
}

/**
 * Resolve a state's clip reference to an actual clip id.
 *   "$slot"  → slotMap[slot]  (or empty if not mapped)
 *   "raw_id" → "raw_id"
 */
function resolveClipId(clipRef: string, slotMap: Record<string, string>): string {
  if (clipRef.startsWith("$")) {
    const slotName = clipRef.slice(1);
    return slotMap[slotName] ?? "";
  }
  return clipRef;
}

function computeClipTime(
  prev: number,
  state: { loop?: boolean },
  speedScale: number | "velocity",
  speedReference: number,
  currentSpeed: number,
): number {
  let advance: number;
  if (speedScale === "velocity") {
    advance = (currentSpeed / speedReference) * TICK_DT;
  } else {
    advance = speedScale * TICK_DT;
  }
  if (state.loop) {
    return (prev + advance) % 1.0;
  }
  // One-shot: advance and clamp at 1. Per-weapon timing comes from the SM
  // state's duration (number or scope ref); the projection just walks the
  // clip from 0 → 1 across whatever real-time window the SM imposes.
  return Math.min(prev + advance, 1.0);
}

/**
 * Project the `locomotion` action slot into one AnimationLayer, replicating
 * exactly what the retired CSM locomotion layer emitted (T-226c).
 *
 *   - empty slot → fall back to the `idle` action, so the first tick after
 *     spawn (before the dispatcher's deferred write commits) shows the idle
 *     pose, not a rest-pose flash — matching the old spawn-time
 *     initialSMState seeding.
 *   - crouch variant: `anim.crouchClipId` when the `Crouched` tag is
 *     present, replacing the CSM's `posture.crouched` paramOverride.
 *   - speedScale / loop / mask / clip-time accumulation mirror the old
 *     `resolveSpeedScale` + `computeClipTime` (one-shot with no explicit
 *     speedScale auto-fits 1 / phase-duration; locomotion had no mask).
 *
 * Exported for the behavioral parity test.
 */
export function projectLocomotion(
  content: ContentService,
  slot: ActiveActionState | undefined,
  crouched: boolean,
  slotMap: Record<string, string>,
  prevTimeByClip: Map<string, number>,
  speed: number,
  walkSpeedRef: number,
  fallbackToIdle = false,
): AnimationLayer | null {
  // The idle fallback is LOCOMOTION-only: an empty locomotion slot shows the
  // idle pose (no rest-pose flash on the first post-spawn tick, before the
  // dispatcher's deferred write commits). The primary and reaction slots must
  // stay SILENT when empty — fabricating an idle layer there pushes a full-body,
  // weight-1, override, unmasked `idle` on TOP of locomotion, which overwrites
  // the walk pose every frame. That is why every moving character was frozen in
  // its idle pose: the empty reaction slot's idle fallback clobbered "walking".
  const actionId = slot?.actionId || (fallbackToIdle ? "idle" : "");
  if (!actionId) return null;
  const def = content.actions.get(actionId);
  if (!def) return null;
  const phaseName = slot?.phase && def.phases[slot.phase]
    ? slot.phase
    : Object.keys(def.phases)[0];
  const anim = def.animation?.[phaseName];
  if (!anim) return null;

  const clipRef = crouched && anim.crouchClipId ? anim.crouchClipId : anim.clipId;
  const clipId = resolveClipId(clipRef, slotMap);
  if (!clipId) return null;

  const loop = anim.loop ?? false;
  // Auto-fit a one-shot clip to play ONCE across the full span of phases that
  // share it — not each phase independently. A swing's clip spans windup +
  // active + winddown; the old per-phase fit (1/phaseDur) made the 2-tick
  // active phase advance the clip 0.5 PER TICK (a violent two-frame jolt — the
  // "crippled swing / weird rotations"). Summing the same-clip phases makes it
  // walk the clip smoothly (8 ticks → 12.5%/tick).
  let spanTicks = def.phases[phaseName].ticks;
  if (def.animation) {
    let sum = 0;
    for (const [pn, pe] of Object.entries(def.animation)) {
      const ref = crouched && pe.crouchClipId ? pe.crouchClipId : pe.clipId;
      if (ref === clipRef) sum += def.phases[pn]?.ticks ?? 0;
    }
    if (sum > 0) spanTicks = sum;
  }
  const spanDurSec = spanTicks > 0 ? spanTicks * TICK_DT : 0;
  const speedScale: number | "velocity" = anim.speedScale !== undefined
    ? anim.speedScale
    : (!loop && spanDurSec > 0 ? 1 / spanDurSec : 1);

  const time = computeClipTime(
    prevTimeByClip.get(clipId) ?? 0,
    { loop },
    speedScale,
    walkSpeedRef,
    speed,
  );

  return {
    clipId,
    maskId: anim.mask ?? "",
    time,
    weight: 1,
    blend: "override",
    speedScale,
    speedReference: speedScale === "velocity" ? walkSpeedRef : undefined,
  };
}

function getTimeByClip(state: AnimationStateData | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of state?.layers ?? []) m.set(l.clipId, l.time);
  return m;
}

function animStatesEqual(a: AnimationStateData | null, b: AnimationStateData): boolean {
  if (!a) return false;
  if (a.weaponActionId !== b.weaponActionId) return false;
  if (a.ticksIntoAction !== b.ticksIntoAction) return false;
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i], lb = b.layers[i];
    if (la.clipId !== lb.clipId) return false;
    if (Math.abs(la.time - lb.time) > 0.0001) return false;
    if (la.weight !== lb.weight) return false;
    if (la.maskId !== lb.maskId) return false;
  }
  return true;
}
