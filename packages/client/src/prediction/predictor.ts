/**
 * Client-side prediction for the local player.
 *
 * The physics body (body.position) is always hard-snapped to the authoritative
 * server state after replay — this is the ground truth for future physics steps.
 *
 * A separate renderOffset absorbs corrections visually: small divergences blend
 * out exponentially (half-life controlled by correctionHalfLifeMs); large ones
 * snap immediately to avoid rubber-band artefacts.
 *
 * render position = body.position + renderOffset
 */
import type { Vec3 } from "@voxim/engine";
import type { PhysicsBody, PhysicsInput, PhysicsConfig } from "@voxim/engine";
import { stepPhysics } from "@voxim/engine";

export interface PredictorConfig {
  /** Half-life of the visual correction offset in milliseconds. */
  correctionHalfLifeMs: number;
  /** Divergences ≥ this (world units) snap immediately instead of blending. */
  hardSnapThresholdUnits: number;
}

interface PendingInput {
  seq: number;
  input: PhysicsInput;
  dt: number;
}

/** Max buffered inputs. At 60 fps × 3 s = 180 frames headroom. */
const MAX_PENDING = 180;

export class Predictor {
  private body: PhysicsBody = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: false,
  };
  /** Visual offset — difference between old render position and new physics position after reconcile. */
  private renderOffset: Vec3 = { x: 0, y: 0, z: 0 };
  private pending: PendingInput[] = [];
  private _initialised = false;

  constructor(
    private readonly physicsConfig: PhysicsConfig,
    private readonly predictorConfig: PredictorConfig,
  ) {}

  get isInitialised(): boolean { return this._initialised; }

  /** Current render position — use this for mesh placement. */
  get renderPosition(): Vec3 {
    return {
      x: this.body.position.x + this.renderOffset.x,
      y: this.body.position.y + this.renderOffset.y,
      z: this.body.position.z + this.renderOffset.z,
    };
  }

  /** Seed from first authoritative position. Called once when the server sends initial state. */
  seed(pos: Vec3, vel: Vec3): void {
    this.body.position = { ...pos };
    this.body.velocity = { ...vel };
    this.renderOffset = { x: 0, y: 0, z: 0 };
    this._initialised = true;
  }

  /**
   * Advance the predicted body by one frame.
   * Decays the render offset and steps physics.
   * Returns the render position (body.position + decayed renderOffset).
   */
  step(seq: number, input: PhysicsInput, dt: number, getTerrainHeight: (x: number, y: number) => number): Vec3 {
    if (!this._initialised) return this.body.position;

    this.pending.push({ seq, input, dt });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    stepPhysics(this.body, input, getTerrainHeight, dt, this.physicsConfig);

    // Exponential decay of render offset: retain = 0.5^(dt / halfLife)
    const halfLifeSec = this.predictorConfig.correctionHalfLifeMs / 1000;
    const retain = Math.pow(0.5, dt / halfLifeSec);
    this.renderOffset.x *= retain;
    this.renderOffset.y *= retain;
    this.renderOffset.z *= retain;

    return this.renderPosition;
  }

  /**
   * Reconcile against authoritative server state.
   * 1. Prune inputs the server has already processed (seq ≤ ackSeq).
   * 2. Capture old render position.
   * 3. Reset body to server state and replay remaining inputs.
   * 4. Compute new renderOffset from divergence — smooth or snap.
   */
  reconcile(
    ackSeq: number,
    serverPos: Vec3,
    serverVel: Vec3,
    getTerrainHeight: (x: number, y: number) => number,
  ): void {
    // Capture render position before reset
    const oldRender = this.renderPosition;

    // Discard acknowledged inputs
    const idx = this.pending.findLastIndex((p) => p.seq <= ackSeq);
    if (idx >= 0) this.pending.splice(0, idx + 1);

    // Reset to server state
    // Derive onGround from terrain — don't hard-code false or a pending jump input
    // won't be applied during replay, causing the jump to be "eaten" and the player
    // to snap back to the ground.
    this.body.position = { ...serverPos };
    this.body.velocity = { ...serverVel };
    const terrainZ = getTerrainHeight(serverPos.x, serverPos.y);
    this.body.onGround = serverPos.z <= terrainZ + 0.05;

    // Replay unacknowledged inputs
    for (const p of this.pending) {
      stepPhysics(this.body, p.input, getTerrainHeight, p.dt, this.physicsConfig);
    }

    // Compute divergence between where the player appeared and where physics landed
    const dx = oldRender.x - this.body.position.x;
    const dy = oldRender.y - this.body.position.y;
    const dz = oldRender.z - this.body.position.z;
    const divergence = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const threshold = this.predictorConfig.hardSnapThresholdUnits;
    if (divergence >= threshold) {
      // Large divergence — snap immediately, no blending
      this.renderOffset = { x: 0, y: 0, z: 0 };
    } else {
      // Small divergence — carry the offset forward for smooth blending
      this.renderOffset = { x: dx, y: dy, z: dz };
    }

    this._initialised = true;
  }
}
