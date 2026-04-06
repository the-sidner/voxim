/**
 * Shared physics simulation.
 * Imported by both @voxim/tile-server and @voxim/client — identical by construction,
 * so client prediction and authoritative simulation always agree.
 *
 * All movement (jump, knockback, skill dash) uses the impulse mechanism:
 * apply a velocity delta to PhysicsBody at a point in time; the loop handles the rest.
 */
import type { Vec2, Vec3 } from "./math.ts";

// ---- types ----

export interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
  onGround: boolean;
}

export interface PhysicsInput {
  /** Normalised movement direction on the horizontal plane. (0,0) = stationary. */
  movement: Vec2;
  /** True on the frame the jump button is pressed (edge-triggered). */
  jump: boolean;
}

export interface PhysicsConfig {
  /** Downward acceleration (positive = downward), units/s². Default 20. */
  gravity: number;
  /** Max horizontal speed on ground, units/s. Default 6. */
  maxGroundSpeed: number;
  /** Horizontal acceleration on ground, units/s². Default 40. */
  groundAccel: number;
  /** Air control multiplier (fraction of ground accel available in air). Default 0.3. */
  airControlMult: number;
  /**
   * Exponential horizontal drag applied every tick when no input — fraction of velocity
   * retained per second. Default 0.05 (5% retained → rapid stop).
   */
  dragRetainPerSec: number;
  /** Upward velocity applied by a jump impulse, units/s. Default 9. */
  jumpImpulse: number;
  /**
   * Auto-step: if horizontal movement is partially blocked by terrain and the height
   * difference is ≤ this value, push the entity up instead of stopping. Default 0.75.
   */
  stepHeight: number;
}

export const DEFAULT_PHYSICS: Readonly<PhysicsConfig> = {
  gravity: 20,
  maxGroundSpeed: 6,
  groundAccel: 40,
  airControlMult: 0.3,
  dragRetainPerSec: 0.05,
  jumpImpulse: 9,
  stepHeight: 0.75,
};

// ---- impulse ----

/**
 * Apply a velocity impulse to a body — the universal mechanism for jump, knockback,
 * skill movement, and any other physics-driven displacement.
 */
export function applyImpulse(body: PhysicsBody, impulse: Vec3): PhysicsBody {
  return {
    ...body,
    velocity: {
      x: body.velocity.x + impulse.x,
      y: body.velocity.y + impulse.y,
      z: body.velocity.z + impulse.z,
    },
  };
}

// ---- step ----

/**
 * Advance physics by one fixed timestep dt.
 *
 * getTerrainHeight(x, y) must return the authoritative terrain z at the given world
 * position. Called after integration so terrain deformation takes effect immediately.
 *
 * Returns a new PhysicsBody — the input is never mutated.
 */
export function stepPhysics(
  body: PhysicsBody,
  input: PhysicsInput,
  getTerrainHeight: (x: number, y: number) => number,
  dt: number,
  config: PhysicsConfig = DEFAULT_PHYSICS,
): PhysicsBody {
  let { position, velocity, onGround } = body;

  // 1. Gravity — applied to vertical velocity when airborne
  if (!onGround) {
    velocity = { ...velocity, z: velocity.z - config.gravity * dt };
  }

  // 2. Horizontal input
  const hasInput = input.movement.x !== 0 || input.movement.y !== 0;
  if (hasInput) {
    if (onGround) {
      // Instant velocity snap on ground — crisp, responsive feel.
      // External impulses (knockback, dodge) still work because they bypass input entirely.
      const s = config.maxGroundSpeed;
      velocity = { ...velocity, x: input.movement.x * s, y: input.movement.y * s };
    } else {
      // Gradual air control
      const accel = config.groundAccel * config.airControlMult * dt;
      velocity = {
        ...velocity,
        x: velocity.x + input.movement.x * accel,
        y: velocity.y + input.movement.y * accel,
      };
    }
  }

  // 3. Horizontal drag when no input
  if (!hasInput) {
    if (onGround) {
      // Instant stop on ground
      velocity = { ...velocity, x: 0, y: 0 };
    } else {
      // Gradual air drag
      const retain = Math.pow(config.dragRetainPerSec, dt);
      velocity = { ...velocity, x: velocity.x * retain, y: velocity.y * retain };
    }
  }

  // 4. Jump impulse — requires onGround (edge-triggered; caller must gate to one frame)
  if (input.jump && onGround) {
    velocity = { ...velocity, z: config.jumpImpulse };
    onGround = false;
  }

  // 5. Integrate position
  let pos: Vec3 = {
    x: position.x + velocity.x * dt,
    y: position.y + velocity.y * dt,
    z: position.z + velocity.z * dt,
  };

  // 6. Terrain collision — snap to surface, reset vertical velocity, set onGround
  const groundZ = getTerrainHeight(pos.x, pos.y);
  if (pos.z <= groundZ) {
    // Auto-step: if we were above the old ground but the new ground is higher,
    // push up instead of stopping (handles ramps and small ledges without jumping).
    // Full AABB deployable collision is a future step.
    const stepDiff = groundZ - position.z;
    if (stepDiff > 0 && stepDiff <= config.stepHeight && velocity.z <= 0) {
      // Auto-step up: terrain rose by a small amount — push entity up to new surface
      pos = { ...pos, z: groundZ };
      velocity = { ...velocity, z: 0 };
      onGround = true;
    } else if (stepDiff > config.stepHeight) {
      // Wall: terrain rose too high to step — revert horizontal movement, stop XY velocity
      pos = { ...pos, x: position.x, y: position.y, z: Math.max(pos.z, groundZ) };
      velocity = { ...velocity, x: 0, y: 0 };
      onGround = pos.z <= groundZ + 0.01;
    } else {
      // Normal landing (falling onto ground, or ground dropped below)
      pos = { ...pos, z: groundZ };
      velocity = { ...velocity, z: 0 };
      onGround = true;
    }
  } else {
    onGround = false;
  }

  return { position: pos, velocity, onGround };
}
