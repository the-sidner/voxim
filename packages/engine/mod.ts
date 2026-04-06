// @voxim/engine — zero external dependencies
// ECS core, physics, math types, event bus, Serialiser interface.

export type { Vec2, Vec3, EntityId } from "./src/math.ts";
export { vec2, vec3, vec2Add, vec2Scale, vec2Length, vec2LengthSq, vec2Normalize, vec3Add, vec3Scale, vec3Length, vec3LengthSq, newEntityId } from "./src/math.ts";

export type { Serialiser, ComponentDef } from "./src/component.ts";
export { defineComponent } from "./src/component.ts";

export type { AppliedChangeset, ChangesetSet, ChangesetRemoval, QueryResult } from "./src/world.ts";
export { World } from "./src/world.ts";

export { EventBus } from "./src/events.ts";

export type { PhysicsBody, PhysicsInput, PhysicsConfig } from "./src/physics.ts";
export { DEFAULT_PHYSICS, applyImpulse, stepPhysics } from "./src/physics.ts";
