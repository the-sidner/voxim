/**
 * Decal-source registry (T-311 P4) — the closed event catalog for EPHEMERAL
 * combat decals (designer decision: in-memory + decay, never saved, never
 * networked). Each source is a named handler that maps a wire `GameEvent` to
 * a splat spawn spec, or null when the event doesn't apply — so the WHERE and
 * HOW-STRONG of every decal traces to a server-authoritative event, and a
 * `DecalDef.source` is one content string dispatched through this registry
 * (registry-dispatch over content-defined ids, like triggers' event kinds).
 * Pure + THREE-free: position lookups go through the injected resolver.
 */
import type { GameEvent } from "@voxim/protocol";
import type { ContentService, DecalDef } from "@voxim/content";

export interface DecalSpawnSpec {
  x: number;
  y: number;
  /** 0..1 — lerps the DecalDef's slab count. */
  intensity: number;
}

export type DecalSource = (
  ev: GameEvent,
  /** Resolve an entity's current world position (null when out of AoI). */
  positionOf: (entityId: string) => { x: number; y: number } | null,
  /** The matching DecalDef — sources read their own authored params (e.g.
   *  damageSource's fullIntensityAt) instead of a shared global. */
  def: DecalDef,
) => DecalSpawnSpec | null;

const REGISTRY = new Map<string, DecalSource>();

export function registerDecalSource(id: string, source: DecalSource): void {
  REGISTRY.set(id, source);
}

export function getDecalSource(id: string): DecalSource | undefined {
  return REGISTRY.get(id);
}

export function decalSourceIds(): string[] {
  return [...REGISTRY.keys()];
}

/** Full damage at/above this amount → intensity 1 (splat count maxes out) —
 *  fallback when a DecalDef doesn't author its own `fullIntensityAt`. */
const DEFAULT_DAMAGE_FULL_INTENSITY = 30;

/** Blood at the hit contact point; blocked hits draw none. */
const damageSource: DecalSource = (ev, _positionOf, def) => {
  if (ev.type !== "DamageDealt" || ev.blocked || ev.amount <= 0) return null;
  const fullAt = def.fullIntensityAt ?? DEFAULT_DAMAGE_FULL_INTENSITY;
  return { x: ev.hitX, y: ev.hitY, intensity: Math.min(1, ev.amount / fullAt) };
};

/** A full-strength pool where an entity died (position from live state). */
const deathSource: DecalSource = (ev, positionOf) => {
  if (ev.type !== "EntityDied") return null;
  const pos = positionOf(ev.entityId);
  return pos ? { x: pos.x, y: pos.y, intensity: 1 } : null;
};

/** Idempotent builtin registration (the TextureStyle/SurfaceTreatment idiom). */
export function registerBuiltinDecalSources(): void {
  registerDecalSource("damage", damageSource);
  registerDecalSource("death", deathSource);
}

/** Boot cross-check (fail-fast, next to crossCheckProcModels et al.): every
 *  DecalDef names a registered source and a known material. */
export function crossCheckDecals(content: ContentService): void {
  registerBuiltinDecalSources();
  for (const d of content.decals.values()) {
    if (!REGISTRY.has(d.source)) {
      throw new Error(
        `[decals] "${d.id}" names unknown source "${d.source}" (registered: ${decalSourceIds().join(", ")})`,
      );
    }
    if (!content.materials.get(d.material)) {
      throw new Error(`[decals] "${d.id}" names unknown material "${d.material}"`);
    }
  }
}
