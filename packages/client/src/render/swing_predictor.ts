/**
 * SwingPredictor — client-side prediction of which WeaponActionDef the
 * server will fire for the next swing, given the equipped weapon's combo
 * chain (`swingable.chain`) and the local press-hold timer.
 *
 * Used by game.ts each frame the player is holding ACTION_USE_SKILL to
 * resolve a `weaponActionId` for `forceLocalAnimation` — that drives the
 * weapon trail / blade-attach without waiting RTT/2 for the server's
 * AnimationState delta.
 *
 * Inputs (per call):
 *   - networked SwingChain.index for the local player (server-authoritative;
 *     index = 0 when no chain is active OR when csm.right_hand is idle).
 *   - csm.right_hand.node for chain-end detection (idle ⇒ predict step 0).
 *   - equipped weapon's swingable.chain + heavyChargeMs (from prefab via
 *     the bootstrap-loaded ContentService).
 *   - local press start timestamp tracked across frames.
 *
 * Output: the WeaponActionDef id for the predicted attack, or null when
 * the predictor can't make a confident call (no swingable, empty chain,
 * not pressed).
 *
 * Note on staleness: SwingChain isn't sent via "component removed" deltas
 * (the wire format has no such message — see state_binary.ts). When the
 * server-side chain ends, the client's cached index would persist forever.
 * The predictor compensates by ignoring the cached index whenever
 * csm.right_hand is in `idle` — chain only exists during a swing, so
 * the only chain-step-0 outcome from idle is the start of a new chain.
 */

interface SwingChainEntryLike { light: string; heavy: string }
interface SwingableLike {
  chain: SwingChainEntryLike[];
  heavyChargeMs: number;
}

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
   * @param chainIndex   Server-authoritative chain index from the networked
   *                     SwingChain component. Pass 0 when not in a chain or
   *                     when csm.right_hand is idle (caller decides).
   * @param now          Wall-clock ms (Date.now() or performance.now()).
   * @returns The predicted WeaponActionDef id, or null when the predictor
   *          declines to call it (no swingable, empty chain, not pressed).
   */
  predict(
    pressed: boolean,
    swingable: SwingableLike | null,
    chainIndex: number,
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
    if (!swingable || swingable.chain.length === 0) return null;

    const entry = swingable.chain[chainIndex % swingable.chain.length];
    if (!entry) return null;

    // Held past heavyChargeMs → predict heavy variant. The server makes
    // the same decision at swing.windup→swing.stop, so once the user
    // crosses the threshold the predicted id is what will actually fire.
    const heldMs = this.pressStartMs !== null ? now - this.pressStartMs : 0;
    return heldMs >= swingable.heavyChargeMs ? entry.heavy : entry.light;
  }
}
