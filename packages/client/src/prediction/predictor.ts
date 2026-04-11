/**
 * Client-side prediction for the local player.
 *
 * Records every input the client sends with its frame dt. On each server
 * acknowledgement, resets to the authoritative state and replays all inputs
 * with seq > ackSeq so the predicted position is always ahead of the server.
 *
 * Uses the same stepPhysics() as the server — identical by construction.
 */
import type { Vec3 } from "@voxim/engine";
import type { PhysicsBody, PhysicsInput, PhysicsConfig } from "@voxim/engine";
import { stepPhysics } from "@voxim/engine";

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
  private pending: PendingInput[] = [];
  private _initialised = false;

  constructor(private readonly physicsConfig: PhysicsConfig) {}

  get isInitialised(): boolean { return this._initialised; }

  get position(): Vec3 { return this.body.position; }

  /** Seed from first authoritative position. Called once when the server sends initial state. */
  seed(pos: Vec3, vel: Vec3): void {
    this.body.position = { ...pos };
    this.body.velocity = { ...vel };
    this._initialised = true;
  }

  /**
   * Advance the predicted body by one frame.
   * Records the input so it can be replayed after reconciliation.
   * Returns the new predicted position.
   */
  step(seq: number, input: PhysicsInput, dt: number, getTerrainHeight: (x: number, y: number) => number): Vec3 {
    if (!this._initialised) return this.body.position;

    this.pending.push({ seq, input, dt });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    stepPhysics(this.body, input, getTerrainHeight, dt, this.physicsConfig);
    return this.body.position;
  }

  /**
   * Reconcile against a server authoritative state.
   * 1. Prune inputs the server has already processed (seq <= ackSeq).
   * 2. Reset body to server state.
   * 3. Replay remaining inputs in order.
   */
  reconcile(
    ackSeq: number,
    serverPos: Vec3,
    serverVel: Vec3,
    getTerrainHeight: (x: number, y: number) => number,
  ): void {
    // Discard acknowledged inputs
    const idx = this.pending.findLastIndex((p) => p.seq <= ackSeq);
    if (idx >= 0) this.pending.splice(0, idx + 1);

    // Reset to server state
    this.body.position = { ...serverPos };
    this.body.velocity = { ...serverVel };
    this.body.onGround = false;

    // Replay unacknowledged inputs
    for (const p of this.pending) {
      stepPhysics(this.body, p.input, getTerrainHeight, p.dt, this.physicsConfig);
    }

    this._initialised = true;
  }
}
