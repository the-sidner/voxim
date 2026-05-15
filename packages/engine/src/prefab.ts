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
 * This is where the prefab-children subtree recursion lands next (T-217),
 * alongside the scene-graph primitive.
 */

import type { World } from "./world.ts";
import type { EntityId } from "./math.ts";
import { newEntityId } from "./math.ts";
import type { ComponentDef } from "./component.ts";
import type { Transform } from "./scene.ts";
import { IDENTITY_TRANSFORM } from "./scene.ts";

/**
 * A child entry the subtree walk reads (T-217). Structurally the content
 * package's `ChildPrefabRef`; the engine stays dependency-free by typing it
 * here. `local` omitted-field defaults are filled to identity before
 * `placeChild` is called.
 */
export interface ChildSpawn {
  prefabId: string;
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
   * (`setParent`); the service owns where local transform is stored (the
   * game's Position component). Receives the fully-defaulted transform.
   * Absent = children spawn with their preInstall-default placement.
   */
  placeChild?(world: World, childId: EntityId, local: Transform): void;
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

  // Scene-graph subtree (T-217). Each child is spawned through the same
  // walk (recurses arbitrarily deep), parented to this entity, then placed
  // at its declared local transform. `getPrefab` here surfaces an unknown
  // child id with the same error as a top-level spawn; the content loader
  // also rejects unknown/abstract child refs at load.
  if (prefab.children) {
    for (const child of prefab.children) {
      const childId = spawnPrefab(world, ctx, child.prefabId, {} as O);
      world.setParent(childId, id);
      ctx.placeChild?.(world, childId, { ...IDENTITY_TRANSFORM, ...child.local });
    }
  }

  return id;
}
