/// <reference lib="dom" />
/**
 * LightManager — attaches and removes THREE.PointLight instances as
 * LightEmitter components enter and leave the client's view.
 *
 * Each emitting entity gets one PointLight parented to its scene group so
 * the light follows the entity automatically every frame.  When a torch is
 * unequipped the server REMOVES the LightEmitter component (T-269) — it arrives
 * as a wire removal (T-250), `sync` is called with `undefined`, and this manager
 * tears down the light.  The `intensity <= 0` branch is kept as defence (e.g.
 * an explicitly dimmed emitter) but is no longer the unequip path.
 *
 * Coordinate mapping: world(x, y, z) → three(x, z, y).
 * PointLights are parented to the entity group, so no per-frame position update
 * is needed — Three.js propagates the group transform automatically.
 *
 * Flicker is driven by a lightweight per-entity oscillator updated in `tick()`.
 */
import * as THREE from "three";
import type { LightEmitterData } from "@voxim/codecs";
import { getFlickerCurve, registerBuiltinFlickerCurves } from "./flicker_curves.ts";

/**
 * Max simultaneous dynamic PointLights (T-311 P2 LightBudget). The reference
 * scenes pack many torches/fires; uncapped, each LightEmitter would mint a
 * PointLight and overflow the MeshPhongMaterial forward-lighting uniform array.
 * Only the nearest-N (by importance/distance) cast a real light; the rest keep
 * glowing through their always-on emissive flame voxels (+ bloom) for free.
 */
const LIGHT_BUDGET = 8;
/** Reused scratch to avoid per-light Vector3 allocation each frame. */
const _scratch = new THREE.Vector3();

interface TrackedLight {
  light: THREE.PointLight;
  /** Base intensity from the component data. */
  baseIntensity: number;
  /** Content flicker-curve id (T-311) — dispatched in tick(). */
  flickerCurveId: string;
  /** Eligible for a real PointLight (vs emissive-only). Interim true until the
   *  wire carries lightDefId and we resolve LightDef.castsPool (commit 5). */
  castsPool: boolean;
  /** Per-entity phase offset so torches don't all sync up. */
  phase: number;
}

/**
 * Interim flicker-curve resolution until the LightEmitter wire carries
 * `lightDefId` (T-311 P2 commit 5): map the legacy `flicker` float to a curve.
 * Commit 5 replaces this with a LightDef lookup off the wire id.
 */
function flickerCurveFor(emitter: LightEmitterData): string {
  return emitter.flicker > 0 ? "torch" : "steady";
}

export class LightManager {
  /** entityId → tracked light. */
  private readonly lights = new Map<string, TrackedLight>();

  constructor() {
    registerBuiltinFlickerCurves();
  }

  /**
   * Called by the renderer each time an entity's state is updated.
   * Creates, updates, or removes the PointLight as needed.
   *
   * @param entityId  Entity ID
   * @param emitter   LightEmitter component data, or undefined if absent
   * @param group     Three.js group to attach / detach the light from
   */
  sync(entityId: string, emitter: LightEmitterData | undefined, group: THREE.Group): void {
    // Absent component (unequipped — the removal channel cleared it, T-269) or
    // a degenerate emitter → no light.
    if (!emitter || emitter.intensity <= 0 || emitter.radius <= 0) {
      this._remove(entityId, group);
      return;
    }

    const existing = this.lights.get(entityId);
    if (existing) {
      // Update existing light in place.
      existing.light.color.setHex(emitter.color);
      existing.light.distance = emitter.radius;
      existing.baseIntensity = emitter.intensity;
      existing.flickerCurveId = flickerCurveFor(emitter);
    } else {
      // Create and parent to entity group.
      // Height offset: center-of-mass is roughly 0.9 world units up (= Three.js Y).
      const light = new THREE.PointLight(emitter.color, emitter.intensity, emitter.radius, 2);
      light.position.set(0, 0.9, 0);
      group.add(light);
      this.lights.set(entityId, {
        light,
        baseIntensity: emitter.intensity,
        flickerCurveId: flickerCurveFor(emitter),
        castsPool: true,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /**
   * Animate flicker for all tracked lights.
   * @param timeMs  Current time in milliseconds (e.g. performance.now())
   */
  /**
   * Per-frame: animate flicker (content curve) for every light, then apply the
   * LightBudget — only the nearest-N (importance ÷ distance²) cast a real
   * PointLight; the rest are switched invisible (their emissive flame voxels keep
   * the glow for free, so there is no visible pop). `cameraPos` is the camera's
   * world position (ranking origin).
   */
  tick(timeMs: number, cameraPos: THREE.Vector3): void {
    const t = timeMs * 0.001;
    const steady = getFlickerCurve("steady")!;
    const ranked: { light: THREE.PointLight; score: number }[] = [];
    for (const tracked of this.lights.values()) {
      const fn = getFlickerCurve(tracked.flickerCurveId) ?? steady;
      tracked.light.intensity = fn(t, tracked.phase, tracked.baseIntensity);
      if (!tracked.castsPool) { tracked.light.visible = false; continue; }
      tracked.light.getWorldPosition(_scratch);
      const importance = tracked.baseIntensity * Math.max(1, tracked.light.distance);
      const distSq = Math.max(1e-3, _scratch.distanceToSquared(cameraPos));
      ranked.push({ light: tracked.light, score: importance / distSq });
    }
    // Cheap when ranked.length ≤ budget (the common case); a sort only matters
    // once a scene exceeds the budget, exactly when it must.
    ranked.sort((a, b) => b.score - a.score);
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].light.visible = i < LIGHT_BUDGET;
    }
  }

  /** Remove all lights for an entity (called when entity is destroyed or leaves AoI). */
  remove(entityId: string, group: THREE.Group): void {
    this._remove(entityId, group);
  }

  private _remove(entityId: string, group: THREE.Group): void {
    const tracked = this.lights.get(entityId);
    if (!tracked) return;
    group.remove(tracked.light);
    tracked.light.dispose();
    this.lights.delete(entityId);
  }

  dispose(): void {
    // Groups are already gone at shutdown; just release GPU resources.
    for (const tracked of this.lights.values()) tracked.light.dispose();
    this.lights.clear();
  }
}
