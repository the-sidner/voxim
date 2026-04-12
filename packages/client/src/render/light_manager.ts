/// <reference lib="dom" />
/**
 * LightManager — attaches and removes THREE.PointLight instances as
 * LightEmitter components enter and leave the client's view.
 *
 * Each emitting entity gets one PointLight parented to its scene group so
 * the light follows the entity automatically every frame.  When a torch is
 * unequipped the server sends a zero-intensity delta; this manager tears down
 * the light in response.
 *
 * Coordinate mapping: world(x, y, z) → three(x, z, y).
 * PointLights are parented to the entity group, so no per-frame position update
 * is needed — Three.js propagates the group transform automatically.
 *
 * Flicker is driven by a lightweight per-entity oscillator updated in `tick()`.
 */
import * as THREE from "three";
import type { LightEmitterData } from "@voxim/codecs";

interface TrackedLight {
  light: THREE.PointLight;
  /** Base intensity from the component data. */
  baseIntensity: number;
  /** Flicker amplitude 0–1. */
  flicker: number;
  /** Per-entity phase offset so torches don't all sync up. */
  phase: number;
}

export class LightManager {
  /** entityId → tracked light. */
  private readonly lights = new Map<string, TrackedLight>();

  /**
   * Called by the renderer each time an entity's state is updated.
   * Creates, updates, or removes the PointLight as needed.
   *
   * @param entityId  Entity ID
   * @param emitter   LightEmitter component data, or undefined if absent
   * @param group     Three.js group to attach / detach the light from
   */
  sync(entityId: string, emitter: LightEmitterData | undefined, group: THREE.Group): void {
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
      existing.flicker = emitter.flicker;
    } else {
      // Create and parent to entity group.
      // Height offset: center-of-mass is roughly 0.9 world units up (= Three.js Y).
      const light = new THREE.PointLight(emitter.color, emitter.intensity, emitter.radius, 2);
      light.position.set(0, 0.9, 0);
      group.add(light);
      this.lights.set(entityId, {
        light,
        baseIntensity: emitter.intensity,
        flicker: emitter.flicker,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /**
   * Animate flicker for all tracked lights.
   * @param timeMs  Current time in milliseconds (e.g. performance.now())
   */
  tick(timeMs: number): void {
    const t = timeMs * 0.001;
    for (const tracked of this.lights.values()) {
      if (tracked.flicker <= 0) {
        tracked.light.intensity = tracked.baseIntensity;
        continue;
      }
      // Low-frequency flicker via two overlapping sinusoids.
      const noise = 0.5 * (Math.sin(t * 4.1 + tracked.phase) + Math.sin(t * 7.3 + tracked.phase * 1.7));
      const scale = 1 + noise * tracked.flicker * 0.4;
      tracked.light.intensity = tracked.baseIntensity * Math.max(0.1, scale);
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
