/**
 * Particle-source registry (T-340) — the closed event catalog for event-driven
 * ParticleEmitterDefs (combat bursts). A named handler maps a wire `GameEvent`
 * to a spawn point, or null when the event doesn't apply, so the WHERE of
 * every burst traces to a server-authoritative event — a `ParticleEmitterDef
 * .source` is one content string dispatched through this registry (registry-
 * dispatch over content-defined ids, mirrors decal_sources.ts). Emitters
 * triggered by a fixed mechanism instead (muzzle flash, ambience) don't set
 * `source` and never go through this file. Pure + THREE-free.
 */
import type { GameEvent } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";

export interface ParticleSpawnSpec {
  x: number;
  y: number;
  z: number;
}

/**
 * Deliberately narrower than DecalSource (no `positionOf` resolver param):
 * no particle source needs an entity-position lookup yet — `hit_impact`
 * reads its spawn point straight off the HitSpark event. Add the param back
 * the moment a source needs it, per the registry-dispatch doctrine (don't
 * carry an unused parameter into new code to pre-match a sibling's shape).
 */
export type ParticleSource = (ev: GameEvent) => ParticleSpawnSpec | null;

const REGISTRY = new Map<string, ParticleSource>();

export function registerParticleSource(id: string, source: ParticleSource): void {
  REGISTRY.set(id, source);
}

export function getParticleSource(id: string): ParticleSource | undefined {
  return REGISTRY.get(id);
}

export function particleSourceIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * The impact point of a landed hit — fires for BOTH melee (weapon_trace) and
 * ranged (projectile_trace): both resolve through the shared
 * `dispatchSweepHit` tail on the server, which publishes ONE HitSpark event
 * for either case. One source wiring covers "a projectile IMPACT" per the
 * ticket with no server change.
 */
const hitImpactSource: ParticleSource = (ev) => {
  if (ev.type !== "HitSpark") return null;
  return { x: ev.x, y: ev.y, z: ev.z };
};

/** Idempotent builtin registration (the decal/TextureStyle registry idiom). */
export function registerBuiltinParticleSources(): void {
  registerParticleSource("hit_impact", hitImpactSource);
}

/** Boot cross-check (fail-fast, next to crossCheckDecals): every
 *  ParticleEmitterDef with a `source` names a registered one, and every
 *  def's `material` names a known material. */
export function crossCheckParticles(content: ContentService): void {
  registerBuiltinParticleSources();
  for (const p of content.particles.values()) {
    if (p.source && !REGISTRY.has(p.source)) {
      throw new Error(
        `[particles] "${p.id}" names unknown source "${p.source}" (registered: ${particleSourceIds().join(", ")})`,
      );
    }
    if (!content.materials.get(p.material)) {
      throw new Error(`[particles] "${p.id}" names unknown material "${p.material}"`);
    }
  }
}
