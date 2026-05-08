/**
 * ContentRegistry<T> — generic id-keyed container for content items
 * with optional tag indexing.
 *
 * Building block for the federated ContentService (T-175). Replaces the
 * pattern of `private foos = new Map<string, FooDef>()` plus an ad-hoc
 * `getFoo(id)` accessor that has accumulated dozens of variants on
 * `ContentService`.
 *
 * Items implement the `Tagged` interface (an optional `tags?: string[]`
 * field). Tags are indexed at register-time so `byTag()` is O(1) lookup.
 *
 * Read-only and writable views are split (`ContentRegistryReadonly<T>`
 * vs the concrete `ContentRegistry<T>`) so consumers can be typed against
 * the read surface — engines should never mutate registries after load.
 */

/**
 * Items MAY carry a `tags` array; if present it's indexed by `byTag()`.
 * The interface is structural, not enforced via `extends` — TypeScript's
 * "zero-overlap" check rejects types that don't declare a `tags` property
 * even when the constraint is optional. Instead, registries treat the
 * tags field as a probed, possibly-undefined attribute.
 */
export interface Tagged {
  readonly tags?: readonly string[];
}

export interface ContentRegistryReadonly<T> {
  /** Returns the item with this id, or undefined. */
  get(id: string): T | undefined;
  /** Returns the item, or throws a descriptive error if missing. */
  getOrThrow(id: string): T;
  has(id: string): boolean;
  /**
   * Returns all items carrying this tag. Empty array if none.
   * O(k) where k = number of items with the tag.
   */
  byTag(tag: string): readonly T[];
  forEach(fn: (item: T, id: string) => void): void;
  values(): IterableIterator<T>;
  ids(): IterableIterator<string>;
  readonly size: number;
}

export interface ContentRegistryOptions<T> {
  /** What this registry stores — used in error messages. e.g. "material". */
  kind: string;
  /** Extracts the canonical id from an item. */
  idOf: (item: T) => string;
  /** Optional schema validator called on register; throw to reject. */
  validate?: (item: T) => void;
}

export class ContentRegistry<T> implements ContentRegistryReadonly<T> {
  private readonly items = new Map<string, T>();
  private readonly byTagIndex = new Map<string, Set<T>>();
  private readonly opts: ContentRegistryOptions<T>;

  constructor(opts: ContentRegistryOptions<T>) {
    this.opts = opts;
  }

  /**
   * Register an item. Throws on duplicate id (per the refactor philosophy:
   * silent overwrite hides bugs). Validates first so a bad item cannot
   * partially register and corrupt the index.
   */
  register(item: T): void {
    const id = this.opts.idOf(item);
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`ContentRegistry[${this.opts.kind}]: idOf returned non-string or empty id`);
    }
    this.opts.validate?.(item);
    if (this.items.has(id)) {
      throw new Error(`ContentRegistry[${this.opts.kind}]: duplicate id "${id}"`);
    }
    this.items.set(id, item);
    const maybeTags = (item as Tagged).tags;
    if (maybeTags) {
      for (const tag of maybeTags) {
        let set = this.byTagIndex.get(tag);
        if (!set) {
          set = new Set();
          this.byTagIndex.set(tag, set);
        }
        set.add(item);
      }
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  getOrThrow(id: string): T {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new Error(`ContentRegistry[${this.opts.kind}]: no item with id "${id}"`);
    }
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  byTag(tag: string): readonly T[] {
    const set = this.byTagIndex.get(tag);
    if (!set) return EMPTY;
    return Array.from(set);
  }

  forEach(fn: (item: T, id: string) => void): void {
    for (const [id, item] of this.items) fn(item, id);
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  ids(): IterableIterator<string> {
    return this.items.keys();
  }

  get size(): number {
    return this.items.size;
  }
}

const EMPTY: readonly never[] = Object.freeze([]);
