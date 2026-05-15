import type { EntityId } from "./math.ts";
import type { ComponentDef } from "./component.ts";
import { newEntityId } from "./math.ts";
import { Parent, composeTransform, IDENTITY_TRANSFORM } from "./scene.ts";
import type { Transform } from "./scene.ts";

// ---- internal storage ----

interface StoredComponent<T = unknown> {
  version: number;
  data: T;
}

// ---- changeset types (public) ----

export interface ChangesetSet {
  entityId: EntityId;
  // deno-lint-ignore no-explicit-any
  token: ComponentDef<any>;
  data: unknown;
  version: number;
}

export interface ChangesetRemoval {
  entityId: EntityId;
  // deno-lint-ignore no-explicit-any
  token: ComponentDef<any>;
}

export interface AppliedChangeset {
  readonly sets: ReadonlyArray<ChangesetSet>;
  readonly removals: ReadonlyArray<ChangesetRemoval>;
  readonly destroys: ReadonlyArray<EntityId>;
}

// ---- query result typing ----

/**
 * Derive the query result object type from a tuple of ComponentDef tokens.
 * world.query(Position, Velocity) → Array<{ entityId, position: {...}, velocity: {...} }>
 */
export type QueryResult<T extends readonly ComponentDef<unknown, string>[]> =
  & { entityId: EntityId }
  & {
    [K in T[number] as K extends ComponentDef<unknown, infer N extends string> ? N
      : never]: K extends ComponentDef<infer D, string> ? D : never;
  };

// ---- World ----

export class World {
  // deno-lint-ignore no-explicit-any
  private store = new Map<EntityId, Map<symbol, StoredComponent<any>>>();
  private tombstones = new Set<EntityId>();

  /**
   * Reverse index: component symbol → set of entity IDs that have that component.
   * Maintained in sync with the store so query() iterates only matching entities.
   * Insertion: write() and applyChangeset(). Removal: applyChangeset() on destroy.
   */
  private componentIndex = new Map<symbol, Set<EntityId>>();

  /**
   * Scene-graph reverse index: parent entity → its direct children.
   * Maintained by `setParent` and the destroy purge so `getChildren` is
   * O(1) and `descendants` is O(subtree). The forward link is the `Parent`
   * component (networked, so hierarchy replicates for free).
   */
  private childIndex = new Map<EntityId, Set<EntityId>>();

  // pending deferred writes/removals, accumulated by systems during the tick
  // deno-lint-ignore no-explicit-any
  private pendingSets: Array<{ entityId: EntityId; token: ComponentDef<any>; data: unknown }> = [];
  // deno-lint-ignore no-explicit-any
  private pendingRemovals: Array<{ entityId: EntityId; token: ComponentDef<any> }> = [];
  private pendingDestroys = new Set<EntityId>();

  // ---- entity lifecycle ----

  /**
   * Register a new entity. Generates a UUID v7 id if none supplied.
   * Returns the id so callers can attach components immediately.
   */
  create(id?: EntityId): EntityId {
    const eid = id ?? newEntityId();
    if (!this.store.has(eid)) {
      this.store.set(eid, new Map());
    }
    return eid;
  }

  /**
   * Queue entity for destruction. Tombstoned immediately (stops appearing in queries
   * this tick); physically removed from the store when applyChangeset() runs.
   * Callers can still read component data via get() until applyChangeset().
   */
  destroy(entityId: EntityId): void {
    this.tombstones.add(entityId);
    this.pendingDestroys.add(entityId);
  }

  // ---- reads ----

  /** Read a component. Returns null if entity is missing, tombstoned, or lacks the component. */
  get<T>(entityId: EntityId, token: ComponentDef<T>): T | null {
    // Note: tombstoned entities are still readable until applyChangeset — intentional,
    // so event handlers fired after changeset application can still inspect death state
    // via the AppliedChangeset destroys list (entity is gone by then, this is for same-tick reads).
    const entity = this.store.get(entityId);
    if (!entity) return null;
    return (entity.get(token.id) as StoredComponent<T> | undefined)?.data ?? null;
  }

  has(entityId: EntityId, token: ComponentDef<unknown>): boolean {
    return this.store.get(entityId)?.has(token.id) ?? false;
  }

  isAlive(entityId: EntityId): boolean {
    return this.store.has(entityId) && !this.tombstones.has(entityId);
  }

  isTombstoned(entityId: EntityId): boolean {
    return this.tombstones.has(entityId);
  }

  /** Get internal version counter for a component (used by network delta layer). */
  getVersion(entityId: EntityId, token: ComponentDef<unknown>): number {
    return (
      (this.store.get(entityId)?.get(token.id) as StoredComponent | undefined)?.version ?? 0
    );
  }

  // ---- writes ----

  /**
   * Immediate write — bypasses the deferred changeset.
   * Use only for entity initialisation and InputState writes at tick start.
   * Game systems must use set() instead.
   */
  write<T>(entityId: EntityId, token: ComponentDef<T>, data: T): void {
    const entity = this.store.get(entityId);
    if (!entity) throw new Error(`World.write: unknown entity ${entityId}`);
    const prev = entity.get(token.id) as StoredComponent<T> | undefined;
    // New component on this entity — add to reverse index.
    if (!prev) this.indexAdd(entityId, token.id);
    entity.set(token.id, { version: (prev?.version ?? 0) + 1, data });
  }

  /**
   * Deferred write — queues a component update to the pending changeset.
   * Applied atomically when applyChangeset() is called at end of tick.
   */
  set<T>(entityId: EntityId, token: ComponentDef<T>, data: T): void {
    this.pendingSets.push({ entityId, token, data });
  }

  /**
   * Deferred removal — queues a component to be removed from an entity.
   * Applied atomically when applyChangeset() runs. No-op if the entity
   * doesn't have the component. Game systems must use this (not erase()).
   */
  remove<T>(entityId: EntityId, token: ComponentDef<T>): void {
    this.pendingRemovals.push({ entityId, token });
  }

  /**
   * Immediate removal — removes a component right now, bypassing the changeset.
   * Use only for entity initialisation cleanup. Systems must use remove().
   */
  erase<T>(entityId: EntityId, token: ComponentDef<T>): void {
    const entity = this.store.get(entityId);
    if (!entity) return;
    if (entity.delete(token.id)) {
      this.componentIndex.get(token.id)?.delete(entityId);
    }
  }

  // ---- query ----

  /**
   * Return all living entities that have every token in the argument list.
   *
   * Uses the component index to start iteration from the smallest matching set,
   * so query(NpcTag, Health) iterates only the ~264 NPCs rather than all ~930
   * entities. Cost is O(smallest matching set) rather than O(all entities).
   *
   * Result objects are typed: { entityId, [componentName]: componentData, ... }
   */
  query<const T extends readonly ComponentDef<unknown, string>[]>(
    ...tokens: T
  ): Array<QueryResult<T>> {
    if (tokens.length === 0) return [];

    // Pick the token whose index set is smallest — minimises iterations.
    let smallestSet: Set<EntityId> | undefined;
    for (const token of tokens) {
      const s = this.componentIndex.get(token.id);
      if (!s || s.size === 0) return []; // no entity has this component
      if (!smallestSet || s.size < smallestSet.size) smallestSet = s;
    }
    if (!smallestSet) return [];

    const results: Array<QueryResult<T>> = [];

    for (const entityId of smallestSet) {
      if (this.tombstones.has(entityId)) continue;
      const entity = this.store.get(entityId);
      if (!entity) continue;
      if (!tokens.every((t) => entity.has(t.id))) continue;

      const row: Record<string, unknown> = { entityId };
      for (const token of tokens) {
        row[token.name] = (entity.get(token.id) as StoredComponent).data;
      }
      results.push(row as QueryResult<T>);
    }

    return results;
  }

  // ---- changeset application ----

  /**
   * Apply all deferred writes collected this tick.
   * - Increments version counters on changed components.
   * - Physically removes entities that were queued for destruction.
   * - Returns the applied changeset for delta encoding and event firing.
   * Call exactly once per tick, after all systems have run.
   */
  applyChangeset(): AppliedChangeset {
    const appliedSets: ChangesetSet[] = [];

    for (const entry of this.pendingSets) {
      const entity = this.store.get(entry.entityId);
      // Skip if entity was destroyed this tick or never existed
      if (!entity || this.tombstones.has(entry.entityId)) continue;

      const prev = entity.get(entry.token.id) as StoredComponent | undefined;
      // New component on this entity — add to reverse index.
      if (!prev) this.indexAdd(entry.entityId, entry.token.id);
      const version = (prev?.version ?? 0) + 1;
      entity.set(entry.token.id, { version, data: entry.data });
      appliedSets.push({ entityId: entry.entityId, token: entry.token, data: entry.data, version });
    }

    // Apply deferred component removals.
    const appliedRemovals: ChangesetRemoval[] = [];
    for (const { entityId, token } of this.pendingRemovals) {
      if (this.tombstones.has(entityId)) continue;
      const entity = this.store.get(entityId);
      if (!entity) continue;
      if (entity.delete(token.id)) {
        this.componentIndex.get(token.id)?.delete(entityId);
        appliedRemovals.push({ entityId, token });
      }
    }

    // Physically remove tombstoned entities — purge from all component
    // indices and the scene-graph child index (as both child and parent).
    for (const entityId of this.pendingDestroys) {
      const entity = this.store.get(entityId);
      if (entity) {
        for (const tokenId of entity.keys()) {
          this.componentIndex.get(tokenId)?.delete(entityId);
        }
        const parentId = (entity.get(Parent.id) as StoredComponent<{ entityId: EntityId | null }> | undefined)?.data.entityId ?? null;
        if (parentId) this.childIndex.get(parentId)?.delete(entityId);
      }
      this.childIndex.delete(entityId);
      this.store.delete(entityId);
      this.tombstones.delete(entityId);
    }

    const destroys = Array.from(this.pendingDestroys);

    this.pendingSets = [];
    this.pendingRemovals = [];
    this.pendingDestroys.clear();

    return { sets: appliedSets, removals: appliedRemovals, destroys };
  }

  /** All living entity IDs (excludes tombstoned). */
  entities(): EntityId[] {
    return Array.from(this.store.keys()).filter((id) => !this.tombstones.has(id));
  }

  // ---- scene graph (T-215) ----

  /**
   * Set (or clear, with `parent = null`) an entity's scene-graph parent.
   * Writes the networked `Parent` component immediately (spawn/init path,
   * like `write`) and maintains the reverse child index. Idempotent;
   * reparenting moves the child between parents' child sets. No cycle
   * check yet — callers build trees top-down (consumers land later).
   */
  setParent(child: EntityId, parent: EntityId | null): void {
    if (!this.store.has(child)) throw new Error(`World.setParent: unknown entity ${child}`);
    const prev = this.getParent(child);
    if (prev === parent) return;
    if (prev) this.childIndex.get(prev)?.delete(child);
    this.write(child, Parent, { entityId: parent });
    if (parent) {
      let set = this.childIndex.get(parent);
      if (!set) { set = new Set(); this.childIndex.set(parent, set); }
      set.add(child);
    }
  }

  /** Direct parent, or null if root / no `Parent` component. O(1). */
  getParent(child: EntityId): EntityId | null {
    return this.get(child, Parent)?.entityId ?? null;
  }

  /** Direct children (a snapshot array). O(1) via the reverse index. */
  getChildren(parent: EntityId): EntityId[] {
    const set = this.childIndex.get(parent);
    return set ? [...set] : [];
  }

  /**
   * All descendants of `root` (depth-first, excludes `root` itself).
   * O(subtree). Safe to materialise — used by `destroySubtree` and AoI.
   */
  descendants(root: EntityId): EntityId[] {
    const out: EntityId[] = [];
    const stack = [...this.getChildren(root)];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      const kids = this.childIndex.get(id);
      if (kids) for (const k of kids) stack.push(k);
    }
    return out;
  }

  /**
   * Tombstone `root` and its entire subtree (deferred — purged on
   * `applyChangeset`, same semantics as `destroy`). The child index is
   * cleaned during the purge.
   */
  destroySubtree(root: EntityId): void {
    for (const d of this.descendants(root)) this.destroy(d);
    this.destroy(root);
  }

  /**
   * World transform = parent.world ∘ entity.local, composed up the parent
   * chain. `localOf` supplies each entity's local transform (game data —
   * the engine stays component-agnostic); missing → identity.
   */
  worldTransform(
    entityId: EntityId,
    localOf: (id: EntityId) => Transform | undefined,
  ): Transform {
    const chain: EntityId[] = [];
    let cur: EntityId | null = entityId;
    const seen = new Set<EntityId>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = this.getParent(cur);
    }
    let world = IDENTITY_TRANSFORM;
    for (let i = chain.length - 1; i >= 0; i--) {
      world = composeTransform(world, localOf(chain[i]) ?? IDENTITY_TRANSFORM);
    }
    return world;
  }

  /** An entity's own local transform (relative to its parent). */
  localTransform(
    entityId: EntityId,
    localOf: (id: EntityId) => Transform | undefined,
  ): Transform {
    return localOf(entityId) ?? IDENTITY_TRANSFORM;
  }

  // ---- private helpers ----

  private indexAdd(entityId: EntityId, tokenId: symbol): void {
    let set = this.componentIndex.get(tokenId);
    if (!set) {
      set = new Set();
      this.componentIndex.set(tokenId, set);
    }
    set.add(entityId);
  }
}
