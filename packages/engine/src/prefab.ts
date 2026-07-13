/**
 * Prefab spawn — the generic spawn walk (T-216).
 *
 * The engine owns the *shape* of "turn a prefab into an entity": resolve
 * the prefab, reject abstract ids, create the entity, run a
 * service-supplied preamble, then walk `prefab.components` dispatching each
 * key to a compound installer or a direct component write. Everything
 * concrete — which components a placement gets, the visual shell, the
 * player/npc archetype installers — is injected via `PrefabSpawnContext`,
 * because those reference game component defs the dependency-free engine
 * can't see. The engine stays component-agnostic; the service binds the
 * specifics.
 *
 * The prefab-children subtree recursion (T-217) lives here too, alongside
 * the scene-graph primitive: each child entry resolves through the shared
 * seeded pool/probability selection (T-334, rand.ts's `resolveSeededPick`)
 * before being spawned and parented.
 */

import type { World } from "./world.ts";
import type { EntityId } from "./math.ts";
import { newEntityId } from "./math.ts";
import type { ComponentDef } from "./component.ts";
import type { Transform } from "./scene.ts";
import { IDENTITY_TRANSFORM } from "./scene.ts";
import { mulberry32, resolveSeededPick } from "./rand.ts";
import type { SeededPoolEntry } from "./rand.ts";

/**
 * A child entry the subtree walk reads (T-217; seeded pool/probability
 * added T-334). Structurally the content package's `ChildPrefabRef`; the
 * engine stays dependency-free by typing it here. `local` omitted-field
 * defaults are filled to identity before `placeChild` is called.
 *
 * `prefabId` and `pool`/`probability` mirror `SubObjectRef.modelId`/`.pool`/
 * `.probability` — a fixed single prefab, OR a variant pool one entry is
 * drawn from at spawn time (pool wins if both are set), optionally gated by
 * an inclusion probability. Resolved through the ONE shared
 * `resolveSeededPick` (rand.ts) — the same draw order `resolveSubObjects`/
 * `hitbox_derive.ts` use for model sub-objects, so a designer can express
 * the same seeded-random multi-part content (e.g. a tree's branch pool)
 * as either a model's sub-objects or a prefab's children.
 */
export interface ChildSpawn extends SeededPoolEntry {
  prefabId?: string;
  local?: Partial<Transform>;
}

/** The structural subset of a Prefab the generic walk reads. */
export interface PrefabLike {
  id: string;
  components: Record<string, unknown>;
  children?: ReadonlyArray<ChildSpawn>;
}

/**
 * Service-injected concretes. `O` is the service's overrides type (only
 * `id` is read by the engine; the rest is opaque, threaded to installers).
 */
export interface PrefabSpawnContext<O> {
  /** Prefab table lookup (e.g. content.prefabs.get). */
  getPrefab(id: string): PrefabLike | undefined;
  /** Component-name → def (e.g. DEF_BY_NAME.get). */
  // deno-lint-ignore no-explicit-any
  resolveComponent(name: string): ComponentDef<any> | undefined;
  /** Compound-archetype installer for a key (player/npc/…), or undefined. */
  compoundInstaller(
    name: string,
  ): ((world: World, id: EntityId, prefab: PrefabLike, data: unknown, overrides: O) => void) | undefined;
  /**
   * Service preamble — runs after `create(id)`, before the component walk.
   * Owns placement (Position/Facing), the visual shell, animation slots,
   * actor slots, stats: policy the engine doesn't dictate.
   */
  preInstall(world: World, id: EntityId, prefab: PrefabLike, overrides: O): void;
  /**
   * Apply a freshly-spawned child's declared `local` transform after the
   * engine has parented it (T-217). The engine owns hierarchy wiring
   * (`setParent`); the service owns where the transform lands. `parentId`
   * is passed so the service can compose a world transform off the
   * parent's already-installed placement (static subtrees bake world
   * Position at spawn — no per-tick recomposition until a consumer needs
   * it). Receives the fully-defaulted local transform. Absent = children
   * keep their preInstall-default placement.
   */
  placeChild?(world: World, childId: EntityId, parentId: EntityId, local: Transform): void;
  /**
   * Seed the PRNG stream that resolves this entity's `children` pool/
   * probability entries (T-334). Called once, only when `prefab.children`
   * is present, after `id` is assigned. Absent ⇒ seed 0 (deterministic,
   * no per-entity variance). Services that already derive a per-entity
   * seed for procedural model variation (e.g. tile-server's `ModelRef.seed`)
   * should return that SAME value here — one seed governs both a spawned
   * entity's own sub-object variance and which of its declared children get
   * spawned, so nothing can drift out of sync.
   */
  resolveSeed?(overrides: O, id: EntityId): number;
}

/**
 * Spawn a world entity from a prefab id. Identical behaviour for every
 * caller; the service decides what a prefab becomes via `ctx`.
 *
 * Throws on unknown prefab id, an abstract prefab (`_`-prefixed), or an
 * unknown component name (the content loader should have caught it).
 */
export function spawnPrefab<O extends { id?: EntityId }>(
  world: World,
  ctx: PrefabSpawnContext<O>,
  prefabId: string,
  overrides: O,
): EntityId {
  const prefab = ctx.getPrefab(prefabId);
  if (!prefab) throw new Error(`spawnPrefab: unknown prefab '${prefabId}'`);
  if (prefab.id.startsWith("_")) {
    throw new Error(`spawnPrefab: '${prefab.id}' is abstract and cannot be spawned directly`);
  }

  const id = overrides.id ?? newEntityId();
  world.create(id);
  ctx.preInstall(world, id, prefab, overrides);

  for (const [name, data] of Object.entries(prefab.components)) {
    const compound = ctx.compoundInstaller(name);
    if (compound) {
      compound(world, id, prefab, data, overrides);
      continue;
    }
    const def = ctx.resolveComponent(name);
    if (!def) {
      throw new Error(`spawnPrefab '${prefab.id}': unknown component '${name}'`);
    }
    world.write(id, def, { ...def.default(), ...(data as Record<string, unknown>) });
  }

  // Scene-graph subtree (T-217; seeded pool/probability T-334). Each
  // declared child entry is resolved to a concrete prefab id via the ONE
  // shared `resolveSeededPick` — an entry with `probability < 1.0` may be
  // skipped entirely, and a `pool` entry picks one variant — off a single
  // PRNG stream seeded once for this entity (`ctx.resolveSeed`). Every
  // resolved child is then spawned through the same walk (recurses
  // arbitrarily deep), parented to this entity, and placed at its declared
  // local transform. `getPrefab` here surfaces an unknown child id with the
  // same error as a top-level spawn; the content loader also rejects
  // unknown/abstract child refs (including pool entries) at load.
  if (prefab.children) {
    const rand = mulberry32(ctx.resolveSeed?.(overrides, id) ?? 0);
    for (const child of prefab.children) {
      const resolvedId = resolveSeededPick(child, child.prefabId, rand);
      if (!resolvedId) continue;
      const childId = spawnPrefab(world, ctx, resolvedId, {} as O);
      world.setParent(childId, id);
      ctx.placeChild?.(world, childId, id, { ...IDENTITY_TRANSFORM, ...child.local });
    }
  }

  return id;
}
