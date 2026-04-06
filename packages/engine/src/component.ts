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
 * Component definition token.
 * Created with defineComponent(). The symbol `id` is the unique key in the entity store.
 * N is the literal name used as the property key in query results.
 *
 * networked (default true): when false, this component is never included in network deltas.
 * Use for server-only state (AI queues, internal flags) that clients never need.
 */
export interface ComponentDef<T, N extends string = string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
  readonly networked: boolean;
}

/**
 * Define a new component type. Call once per component, at module level.
 * Each call produces a distinct token — the symbol acts as the runtime key.
 *
 * @example
 * export const Position = defineComponent({
 *   name: "position" as const,
 *   codec: positionCodec,
 *   default: () => ({ x: 0, y: 0, z: 0 }),
 * });
 */
export function defineComponent<T, N extends string>(opts: {
  name: N;
  codec: Serialiser<T>;
  default: () => T;
  networked?: boolean;
}): ComponentDef<T, N> {
  return {
    id: Symbol(opts.name),
    name: opts.name,
    default: opts.default,
    codec: opts.codec,
    networked: opts.networked ?? true,
  };
}
