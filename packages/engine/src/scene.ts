/**
 * Scene graph (T-215) — the engine's hierarchy primitive.
 *
 * Parenthood is itself a component (`Parent`), so hierarchy changes
 * replicate through the existing wire machinery once `Parent` is in
 * `NETWORKED_DEFS`. The reverse child index + traversal/teardown live on
 * `World` (see world.ts) so `world.getChildren` is O(1) and
 * `world.destroySubtree` is O(subtree).
 *
 * This is engine infrastructure, co-equal with `World`/`EventBus` — not a
 * per-game component. The codec is therefore defined inline here (engine
 * owns the `Serialiser` interface and has no dependency on `@voxim/codecs`);
 * a `Parent` entityId is a UUID string, empty = root. The wire id is owned
 * here and mirrored as a reservation comment in `@voxim/protocol`'s
 * `ComponentType`.
 *
 * Nothing consumes this yet (T-215 is the inert substrate): existing
 * entities are parent-less by default; no system calls the hierarchy APIs;
 * prefabs have no `children`. Downstream tickets (subtrees, bones,
 * equipment, buffs) build on it.
 */

import { defineComponent } from "./component.ts";
import type { Serialiser } from "./component.ts";
import type { EntityId } from "./math.ts";

export interface ParentData {
  /** Parent entity UUID, or null = scene root (no parent). */
  entityId: EntityId | null;
}

/**
 * Stable wire id for `Parent`. Engine owns scene infrastructure, so the id
 * is declared here rather than in `@voxim/protocol`'s game `ComponentType`
 * enum (which carries a reservation comment for it). Never reuse.
 */
export const SCENE_PARENT_WIRE_ID = 49;

const parentCodec: Serialiser<ParentData> = {
  encode(v: ParentData): Uint8Array {
    return new TextEncoder().encode(v.entityId ?? "");
  },
  decode(bytes: Uint8Array): ParentData {
    const s = new TextDecoder().decode(bytes);
    return { entityId: s.length > 0 ? s : null };
  },
};

export const Parent = defineComponent({
  name: "parent" as const,
  wireId: SCENE_PARENT_WIRE_ID,
  codec: parentCodec,
  default: (): ParentData => ({ entityId: null }),
});

/**
 * Minimal transform for hierarchy composition (T-215). Translation +
 * uniform scale only — rotation is added when a consumer needs it
 * (equipment-on-bone, T-219/T-220), kept lean here per "no migrations yet".
 */
export interface Transform {
  x: number;
  y: number;
  z: number;
  /** Uniform scale. 1 = identity. */
  scale: number;
}

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, z: 0, scale: 1 };

/**
 * Compose a child local transform onto its parent's world transform:
 * world = parent ∘ local. Scale multiplies; the child's local offset is
 * scaled by the parent before translation. Pure — used by
 * `World.worldTransform`.
 */
export function composeTransform(parent: Transform, local: Transform): Transform {
  return {
    x: parent.x + local.x * parent.scale,
    y: parent.y + local.y * parent.scale,
    z: parent.z + local.z * parent.scale,
    scale: parent.scale * local.scale,
  };
}
