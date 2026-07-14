/**
 * Shared physics simulation.
 * Imported by both @voxim/tile-server and @voxim/client — identical by construction,
 * so client prediction and authoritative simulation always agree.
 *
 * All movement (jump, knockback, skill dash) uses the impulse mechanism:
 * apply a velocity delta to PhysicsBody at a point in time; the loop handles the rest.
 *
 * Also home to the ballistic (gravity-only) substrate — `BallisticBody` /
 * `ballisticStep` / `launchVelocity` — moved here from tile-server-only
 * `physics/ballistic.ts` (T-337) so the client's aim indicator can integrate
 * the IDENTICAL arc the server fires the projectile with. Distinct policy
 * from `stepPhysics` (no input handling, no ground-contact drag, no air
 * control — suitable for any actor whose only forces during flight are
 * gravity + initial impulse: projectiles, ejected ground items, thrown
 * weapons), sharing this one module because both are "the shared physics
 * math client and server must agree on byte-for-byte."
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
  /**
   * Optional impassability query. When supplied AND the integrated XY
   * position lands on a closed pixel, horizontal movement is reverted
   * and XY velocity zeroed — the same response as a wall step. Lets a
   * boundary block the player without raising the heightmap (e.g. a
   * tree on flat ground).
   *
   * Omit when collision should follow heightmap-only (legacy callers,
   * client predictor before networked openMask lands).
   */
  isOpen?: (x: number, y: number) => boolean,
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

  // 5a. OpenMask collision — if the new XY position lands on a closed
  // pixel, revert horizontal movement (slide is left for a future
  // refinement; for now any closed pixel just stops you cold). Mirrors
  // the wall-step branch's response so behaviour is consistent across
  // the two reasons a pixel can block you.
  //
  // Defensive: only fire when the PREVIOUS position was open. If the
  // entity is already inside a closed pixel (loaded from a save that
  // predates the current openMask, or pushed in by a knockback), we
  // let them move so they can escape rather than locking them in place.
  if (isOpen && !isOpen(pos.x, pos.y) && isOpen(position.x, position.y)) {
    pos = { ...pos, x: position.x, y: position.y };
    velocity = { ...velocity, x: 0, y: 0 };
  }

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
      // Wall: terrain rose too high to step. Revert horizontal movement
      // and zero XY velocity. Z is then resolved against the REVERTED
      // pos's ground (NOT the in-wall ground we just measured) — using
      // groundZ here would teleport the player up to cliff height. Use
      // the previous frame's groundZ instead, which is consistent with
      // the position we just reverted to.
      pos = { ...pos, x: position.x, y: position.y };
      velocity = { ...velocity, x: 0, y: 0 };
      const prevGround = getTerrainHeight(position.x, position.y);
      if (pos.z <= prevGround) {
        pos = { ...pos, z: prevGround };
        velocity = { ...velocity, z: 0 };
        onGround = true;
      } else {
        onGround = false;
      }
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

// ---- ballistic (gravity-only) substrate (T-337, moved from tile-server) ----

export interface BallisticBody {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Advance a ballistic body by `dt` seconds under gravity. Pure function:
 * never touches the world; caller decides what to do with the result
 * (commit, destroy, settle, scan for collisions).
 *
 * @param gravityScale  Multiplier on the world gravity constant (1.0 for
 *                      ordinary objects; arrows/throwing weapons may want
 *                      < 1.0 for a flatter arc).
 */
export function ballisticStep(
  body: BallisticBody,
  gravity: number,
  gravityScale: number,
  dt: number,
): BallisticBody {
  const newVel: Vec3 = {
    x: body.vel.x,
    y: body.vel.y,
    z: body.vel.z - gravity * gravityScale * dt,
  };
  const newPos: Vec3 = {
    x: body.pos.x + body.vel.x * dt,
    y: body.pos.y + body.vel.y * dt,
    z: body.pos.z + body.vel.z * dt,
  };
  return { pos: newPos, vel: newVel };
}

/**
 * Initial launch velocity for a ballistic body aimed by (facing, pitch) at
 * a fixed `speed` (T-337). `facing` is the world-space yaw (radians, 0 = +x
 * axis, matching `InputState.facing` / `MovementDatagram.facing`); `pitch`
 * is the elevation angle above the horizontal plane (radians, 0 = level,
 * positive = upward) — NOT the camera's gaze-below-horizontal pitch, which
 * is a different, unrelated angle convention (see `combat.aim` doc in
 * GameConfig). The one formula both the server's projectile spawn
 * (`ProjectileSpawnResolver`) and the client's aim-indicator preview
 * (`aim_indicator.ts`) call, so the two can never drift apart.
 */
export function launchVelocity(facing: number, pitch: number, speed: number): Vec3 {
  const horiz = speed * Math.cos(pitch);
  return {
    x: horiz * Math.cos(facing),
    y: horiz * Math.sin(facing),
    z: speed * Math.sin(pitch),
  };
}
