/**
 * Serialiser interface — the only abstraction between the engine and wire formats.
 * Engine code calls encode/decode; it never imports protobuf or any specific format.
 * Implementations live in @voxim/codecs.
 */
export interface Serialiser<T> {
  encode(data: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

interface ComponentDefBase<T, N extends string> {
  readonly id: symbol;
  readonly name: N;
  readonly default: () => T;
  readonly codec: Serialiser<T>;
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
}

/**
 * A component that is never sent over the wire (server-internal state).
 * Examples: Hitbox, SkillInProgress, WorkstationTag, NpcJobQueue.
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
  networked?: true;
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
}): ServerOnlyComponentDef<T, N>;

export function defineComponent<T, N extends string>(opts: {
  name: N;
  wireId?: number;
  codec: Serialiser<T>;
  default: () => T;
  networked?: boolean;
}): ComponentDef<T, N> {
  if (opts.networked === false) {
    return {
      id: Symbol(opts.name),
      name: opts.name,
      default: opts.default,
      codec: opts.codec,
      networked: false,
    };
  }
  return {
    id: Symbol(opts.name),
    name: opts.name,
    default: opts.default,
    codec: opts.codec,
    networked: true,
    wireId: opts.wireId!,
  };
}
