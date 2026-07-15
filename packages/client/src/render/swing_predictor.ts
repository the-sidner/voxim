/**
 * SwingPredictor — press/hold-only prediction of the weapon action the
 * server will fire for the next swing.
 *
 * Predicts only the chain's opening move (`swingable.chain[0]`): the
 * server's actual combo step (`SwingChain`) is server-only state and
 * never reaches the client (T-349 de-networked ActorSlots too), so
 * mid-combo continuation is not predictable client-side — it arrives
 * at RTT/2 via the server-authoritative AnimationState delta instead.
 * The predicted id only drives cosmetic catch-up render
 * (`forceLocalAnimation`), so a mispredicted continuation self-corrects
 * within one tick.
 *
 * Light vs. heavy is the local press-hold timer against
 * `swingable.heavyChargeMs` — the same decision the server makes at
 * windup end, so once the threshold is crossed the predicted id is what
 * will actually fire.
 */

import type { SwingableData } from "@voxim/content";

export class SwingPredictor {
  /** Wall-clock ms when the current press began. Null when not pressed. */
  private pressStartMs: number | null = null;

  /** Tracks edge: true if last call saw pressed=true. */
  private wasPressed = false;

  /**
   * Resolve the predicted action id for this frame.
   *
   * @param pressed      Current frame's ACTION_USE_SKILL bit.
   * @param swingable    Equipped weapon's swingable.* fields, or null when
   *                     unarmed (caller substitutes a fallback id).
   * @param now          Wall-clock ms (Date.now() or performance.now()).
   * @returns The predicted WeaponActionDef id, or null when the predictor
   *          declines to call it (no swingable, empty chain, not pressed).
   */
  predict(
    pressed: boolean,
    swingable: SwingableData | null,
    now: number,
  ): string | null {
    // Edge: press began this frame — record start time.
    if (pressed && !this.wasPressed) {
      this.pressStartMs = now;
    }
    // Edge: press released — reset timer.
    if (!pressed && this.wasPressed) {
      this.pressStartMs = null;
    }
    this.wasPressed = pressed;

    if (!pressed) return null;
    if (!swingable) return null;

    const entry = swingable.chain[0];
    if (!entry) return null;

    // Held past heavyChargeMs → predict heavy variant. The server makes
    // the same decision at swing.windup→swing.stop, so once the user
    // crosses the threshold the predicted id is what will actually fire.
    const heldMs = this.pressStartMs !== null ? now - this.pressStartMs : 0;
    return heldMs >= swingable.heavyChargeMs ? entry.heavy : entry.light;
  }
}
