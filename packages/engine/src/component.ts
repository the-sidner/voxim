import type { GenericSchema } from "valibot";

/**
 * Serialiser interface — the only abstraction between the engine and wire formats.
 * Engine code calls encode/decode; it never imports protobuf or any specific format.
 * Implementations live in @voxim/codecs.
 */
export interface Serialiser<T> {
  encode(data: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/**
 * Optional schema describing the component's data shape.
 *
 * Where it's used:
 *   - Content load validates prefab component entries against the schema.
 *   - Tests round-trip through the codec and assert `v.is(schema, decoded)`.
 *   - Future tooling (editors, JSON schema export) consumes it generically.
 *
 * Codecs (wire format) stay hand-written for now — schema describes
 * structure, codec describes bytes. They describe the same data, and the
 * round-trip test is the contract that keeps them in sync.
 */
export type ComponentSchema<T> = GenericSchema<unknown, T>;

interface ComponentDefBase<T, N extends string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  /**
   * Component shape contract. Optional while schemas are rolled out
   * incrementally; once every ComponentDef has one we will tighten the
   * type to required.
   */
  readonly schema?: ComponentSchema<T>;
  /**
   * Names of other components that must be present on any entity (or prefab)
   * that declares this one. Validated at content-load so invalid prefabs fail
   * fast. Example: WorkstationTag requires WorkstationBuffer.
   *
   * Only the declared direction is checked — the loader does not infer the
   * reverse. Author both sides if the relationship is bidirectional.
   */
  readonly requires?: readonly string[];
}

/**
 * A component that is included in network deltas.
 * `wireId` is a stable numeric ID from the `ComponentType` enum in @voxim/protocol.
 * Never reuse or change a wireId — it is part of the wire format.
 */
export interface NetworkedComponentDef<T, N extends string = string>
  extends ComponentDefBase<T, N> {
  readonly networked: true;
  readonly wireId: number;
  /**
   * Optional wire-equality override (T-363). `World.applyChangeset` always
   * commits a `set`/`mutate` to the entity store — internal readers
   * (`world.get`) see the true value every tick regardless of this hook, so
   * nothing that reads committed state for gameplay logic (a parry window,
   * a bow-charge threshold, an integrating resource) ever sees a stale
   * value. `wireEquals` decides ONLY whether that commit also produces a
   * wire delta: when it returns true for (previously-committed,
   * newly-committed), the write is real but the client couldn't tell the
   * two values apart, so the changeset entry is dropped before
   * `buildDeltaMap` ever sees it. Use it for fields that must advance every
   * tick for internal correctness (a perpetual action phase's tick
   * counter, a continuously-integrating vitals resource) but whose
   * per-tick delta is not itself wire-meaningful. Absent = every commit
   * ships, the historical behaviour.
   *
   * Declared with method-shorthand syntax (not a `readonly` function-typed
   * property) so TS checks it bivariantly — a property-typed function here
   * would make every `NetworkedComponentDef<T>` fail to widen to
   * `ComponentDef<unknown>` (world.query's tuple element type) under
   * `strictFunctionTypes`, the same reason `Serialiser<T>` above uses
   * method shorthand for `encode`/`decode`.
   */
  wireEquals?(a: T, b: T): boolean;
}

/**
 * A component that is never sent over the wire (server-internal state).
 * Examples: Hitbox, PendingReaction, WorkstationTag, NpcJobQueue.
 */
export interface ServerOnlyComponentDef<T, N extends string = string>
  extends ComponentDefBase<T, N> {
  readonly networked: false;
}

/**
 * Component definition token.
 * Created with defineComponent(). The symbol `id` is the unique key in the entity store.
 * N is the literal name used as the property key in query results.
 */
export type ComponentDef<T, N extends string = string> =
  | NetworkedComponentDef<T, N>
  | ServerOnlyComponentDef<T, N>;

// ---- defineComponent overloads ----

/**
 * Define a networked component. The `wireId` is a stable wire-format ID from
 * the `ComponentType` enum — it must never be reused or changed after first deploy.
 *
 * @example
 * export const Position = defineComponent({
 *   name: "position" as const,
 *   wireId: ComponentType.position,
 *   codec: positionCodec,
 *   default: () => ({ x: 0, y: 0, z: 0 }),
 * });
 */
export function defineComponent<T, N extends string>(opts: {
  name: N;
  wireId: number;
  codec: Serialiser<T>;
  default: () => T;
  schema?: ComponentSchema<T>;
  requires?: readonly string[];
  networked?: true;
  wireEquals?: (a: T, b: T) => boolean;
}): NetworkedComponentDef<T, N>;

/**
 * Define a server-only component. Never included in network deltas.
 *
 * @example
 * export const Hitbox = defineComponent({
 *   name: "hitbox" as const,
 *   networked: false,
 *   codec: hitboxCodec,
 *   default: () => ({ ... }),
 * });
 */
export function defineComponent<T, N extends string>(opts: {
  name: N;
  networked: false;
  codec: Serialiser<T>;
  default: () => T;
  schema?: ComponentSchema<T>;
  requires?: readonly string[];
}): ServerOnlyComponentDef<T, N>;

export function defineComponent<T, N extends string>(opts: {
  name: N;
  wireId?: number;
  codec: Serialiser<T>;
  default: () => T;
  schema?: ComponentSchema<T>;
  requires?: readonly string[];
  networked?: boolean;
  wireEquals?: (a: T, b: T) => boolean;
}): ComponentDef<T, N> {
  if (opts.networked === false) {
    return {
      id: Symbol(opts.name),
      name: opts.name,
      default: opts.default,
      codec: opts.codec,
      ...(opts.schema !== undefined && { schema: opts.schema }),
      ...(opts.requires !== undefined && { requires: opts.requires }),
      networked: false,
    };
  }
  return {
    id: Symbol(opts.name),
    name: opts.name,
    default: opts.default,
    codec: opts.codec,
    ...(opts.schema !== undefined && { schema: opts.schema }),
    ...(opts.requires !== undefined && { requires: opts.requires }),
    networked: true,
    wireId: opts.wireId!,
    ...(opts.wireEquals !== undefined && { wireEquals: opts.wireEquals }),
  };
}
