/**
 * Procedural-model generator registry (T-285) — registry-dispatch over
 * content-defined generator ids, the same doctrine as the action effect/gate
 * registries and BT node factories. A designer adds a generator as one handler
 * file + one `registerGenerator()` call, never an engine edit, and every
 * `ProcModelDef.generator` is cross-checked against this registry at client
 * boot (fail-fast — see `crossCheckProcModels`). See PROCMODEL_PRIMITIVE_PLAN.md.
 *
 * Generators are THREE-free: they emit `VoxelAtom[]` (the content currency), so
 * the whole grim look — edge-ink, flat shading, palette snap, vertexDisp wobble,
 * height-AO — is inherited downstream through `bakeVoxels` for free, and a
 * generator could move server-side later if a procmodel ever needs a hitbox.
 */
import type { VoxelAtom } from "@voxim/content";

/** What a generator needs from the runtime beyond its own seed + params. */
export interface GeneratorContext {
  /** Resolve a material NAME (carried in the procmodel params) → numeric id. */
  resolveMaterial(name: string): number;
}

/** A generator: a pure, deterministic `(seed, params, ctx) → VoxelAtom[]`. */
export type Generator = (seed: number, params: unknown, ctx: GeneratorContext) => VoxelAtom[];

const REGISTRY = new Map<string, Generator>();

export function registerGenerator(id: string, gen: Generator): void {
  if (REGISTRY.has(id)) throw new Error(`procmodel: generator "${id}" already registered`);
  REGISTRY.set(id, gen);
}

export function getGenerator(id: string): Generator | undefined {
  return REGISTRY.get(id);
}

export function generatorIds(): string[] {
  return [...REGISTRY.keys()];
}
