/**
 * EngineInspector (T-224) — generic entity/scene-graph introspection over
 * ANY World, for ANY caller-supplied component registry.
 *
 * The engine owns `World` and `ComponentDef` but deliberately doesn't know
 * what components exist for a given game (tile-server's `ALL_DEFS`, a
 * future coordinator registry, a test's synthetic defs) — so the caller
 * hands in its own def list at construction, the same way `ContentService`
 * is injected into systems rather than imported. Component values are read
 * by identity (`world.has`/`world.get` against each def), never by codec —
 * this works identically for networked and server-only components and
 * never touches the wire.
 *
 * Two real runtime owners of `@voxim/engine`'s `World` exist today:
 * `tile-server`'s per-tile authoritative World and `coordinator`'s
 * macro-world World. Both are legitimate specialisation targets; only
 * tile-server is wired to a route today (`admin_server.ts`'s `/inspect/*`).
 *
 * Two surfaces were scouted and DELIBERATELY excluded (T-224 residual):
 *   - The atlas bake inspector (`packages/atlas/src/inspector/`) operates on
 *     encoded typed-array planes (heightmap/materials/noise fields) and
 *     `LevelDef` snapshots from the procedural-gen pipeline — there is no
 *     `World`/entity/component anywhere in that data. Forcing it through
 *     this module would be a dishonest abstraction, not a real one.
 *   - The client `ScenePanel` (T-224, client half, already shipped) reads
 *     `ClientWorld`, the browser's own decoded-from-wire entity map — a
 *     different type entirely from this engine's `World`, and explicitly
 *     scoped by the ticket to stay a purpose-built consumer.
 */
import type { EntityId } from "./math.ts";
import type { ComponentDef } from "./component.ts";
import type { World } from "./world.ts";

export interface EntityFilter {
  /** Entity must carry every one of these components. */
  readonly with?: readonly ComponentDef<unknown>[];
  /** Entity must carry none of these components. */
  readonly without?: readonly ComponentDef<unknown>[];
}

export interface EntitySnapshot {
  readonly entityId: EntityId;
  /** Direct scene-graph parent, or null (root / no Parent component). */
  readonly parent: EntityId | null;
  /** Every present component on this entity, name -> data. */
  readonly components: Readonly<Record<string, unknown>>;
}

export interface SceneTreeNode {
  readonly entityId: EntityId;
  readonly children: readonly SceneTreeNode[];
}

export interface ComponentSummaryRow {
  readonly name: string;
  readonly count: number;
}

export class EngineInspector {
  constructor(
    private readonly world: World,
    private readonly defs: readonly ComponentDef<unknown>[],
  ) {}

  /**
   * Living entity ids, optionally filtered by component presence/absence.
   * `with` goes through `World.query`'s reverse-index intersection (the
   * same fast path every other query in the codebase uses — starts from
   * the smallest matching component set); `without` is a post-filter since
   * the engine keeps no negative index.
   */
  listEntities(filter?: EntityFilter): EntityId[] {
    const withDefs = filter?.with ?? [];
    let ids = withDefs.length > 0
      ? this.world.query(...withDefs).map((row) => row.entityId)
      : this.world.entities();
    const withoutDefs = filter?.without ?? [];
    if (withoutDefs.length > 0) {
      ids = ids.filter((id) => !withoutDefs.some((d) => this.world.has(id, d)));
    }
    return ids;
  }

  /**
   * Every present component on one entity, resolved by identity against
   * the caller-supplied registry. Null if the entity isn't alive (never
   * existed, or tombstoned/purged).
   */
  inspectEntity(entityId: EntityId): EntitySnapshot | null {
    if (!this.world.isAlive(entityId)) return null;
    const components: Record<string, unknown> = {};
    for (const def of this.defs) {
      if (this.world.has(entityId, def)) {
        components[def.name] = this.world.get(entityId, def);
      }
    }
    return { entityId, parent: this.world.getParent(entityId), components };
  }

  /**
   * The scene forest: one tree per root, where a root is any living entity
   * with no LIVE parent — either genuinely parentless, or an orphan whose
   * parent was destroyed without `destroySubtree` (matching the client
   * ScenePanel's own treatment: a silently vanished subtree is exposed,
   * not dropped). `rootIds` overrides root discovery when the caller
   * already knows what it wants (e.g. "just this player's subtree").
   *
   * Cycle-guarded: `World.setParent`'s doc notes there is no cycle check
   * today, so a corrupted world must not hang this walk. In practice a
   * true cycle can't form through the normal Parent/child-index mechanism
   * (a child lives in exactly one parent's child set at a time, so it
   * can't fan into two branches), but the guard is defense-in-depth for a
   * `rootIds` override drilling into a deliberately unusual subtree.
   */
  sceneTree(rootIds?: readonly EntityId[]): SceneTreeNode[] {
    const roots = rootIds ?? this.world.entities().filter((id) => {
      const p = this.world.getParent(id);
      return p === null || !this.world.isAlive(p);
    });
    const seen = new Set<EntityId>();
    const build = (id: EntityId): SceneTreeNode => {
      if (seen.has(id)) return { entityId: id, children: [] };
      seen.add(id);
      const children = this.world.getChildren(id)
        .filter((c) => this.world.isAlive(c))
        .map(build);
      return { entityId: id, children };
    };
    return roots.map(build);
  }

  /** Living-entity count per registered component — a world-shape summary. */
  summary(): ComponentSummaryRow[] {
    return this.defs.map((def) => ({ name: def.name, count: this.world.query(def).length }));
  }
}
