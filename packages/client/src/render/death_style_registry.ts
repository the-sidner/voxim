/**
 * Death-style registry (T-339) — the client twin of the server's
 * `Registry<DeathHook>` style dispatch, mirroring `particle_sources.ts`/
 * `decal_sources.ts`'s client-registry shape (a bare `Map` + free functions,
 * not `@voxim/engine`'s `Registry<H>` class — that class is the SERVER
 * convention; client registries key off a stateless id->handler Map, same
 * as every other client-side registry in this file's family).
 *
 * "dissolve" and "crumble" are the two styles that exist. Active ragdoll is
 * a later style in this same registry — not built here.
 */
import type * as THREE from "three";
import type { ContentService, DeathStyleDef } from "@voxim/content";
import type { Vec3 } from "@voxim/engine";
import type { EntityMeshGroup } from "./entity_mesh.ts";

export interface DeathStyleContext {
  scene: THREE.Scene;
  getTerrainHeight: (x: number, y: number) => number;
  /** Fire a fixed-mechanism particle burst (ParticleSystem.spawnBurstAt). */
  spawnParticleBurst: (defId: string, origin: Vec3) => void;
  gravity: number;
}

/**
 * `durationTicks` is passed separately from `def` — it is read off the
 * dying entity's OWN `Resource.values[def.resourceKey].max` (wire-
 * authoritative: whatever the server actually seeded THIS entity's timer
 * to), not re-derived from content, so client timing can never drift from
 * what the server used even if content someday carries more than one def
 * per style.
 */
export type DeathStyleHandler = (
  entityId: string,
  mesh: EntityMeshGroup,
  def: DeathStyleDef,
  durationTicks: number,
  ctx: DeathStyleContext,
) => void;

const REGISTRY = new Map<string, DeathStyleHandler>();

export function registerDeathStyle(style: string, handler: DeathStyleHandler): void {
  REGISTRY.set(style, handler);
}

export function getDeathStyleHandler(style: string): DeathStyleHandler | undefined {
  return REGISTRY.get(style);
}

export function deathStyleIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * "dissolve" is a real (stateless) no-op handler — the T-311 P5c fray/shed
 * visual is already driven every frame off `AnimationState.dissolutionPhase`
 * (renderer.ts's per-entity animation loop, unchanged by T-339), so there is
 * nothing further to do at the moment of death. This entry exists purely so
 * "dissolve" is a REAL registry member (doctrine: no un-registered implicit
 * special case) — a typo'd style in content still fails loud via
 * `crossCheckDeathStyles`.
 *
 * "crumble" is registered here as a PLACEHOLDER no-op. `crossCheckDeathStyles`
 * runs at content-hydration time in game.ts, BEFORE `new VoximRenderer()`
 * exists — so the real, stateful CrumbleController-backed handler can't be
 * registered yet. VoximRenderer's constructor overwrites this placeholder
 * with the real handler once `this.crumbleController` exists; by the time
 * any entity actually dies (well after renderer construction), the real
 * handler is always the one in place. Registering a placeholder here first
 * only guarantees the early cross-check sees "crumble" as a known style.
 */
let _builtinsRegistered = false;
export function registerBuiltinDeathStyles(): void {
  if (_builtinsRegistered) return;
  _builtinsRegistered = true;
  registerDeathStyle("dissolve", () => {});
  registerDeathStyle("crumble", () => {});
}

/** Boot cross-check (fail-fast, mirrors crossCheckParticles/crossCheckDecals):
 *  every loaded DeathStyleDef's `style` names a registered handler. */
export function crossCheckDeathStyles(content: ContentService): void {
  registerBuiltinDeathStyles();
  for (const ds of content.deathStyles.values()) {
    if (!REGISTRY.has(ds.style)) {
      throw new Error(
        `[deathStyles] "${ds.id}" names unknown style "${ds.style}" (registered: ${deathStyleIds().join(", ") || "none"})`,
      );
    }
  }
}
