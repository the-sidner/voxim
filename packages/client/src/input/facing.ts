/**
 * Facing derivation (T-320): the body faces its (already camera-relative)
 * movement direction while moving, and HOLDS the previous facing when there is
 * no move input. Pure so the hold-when-idle contract is deterministically
 * testable — a naive `atan2(0, 0)` would snap idle facing to 0 (east) on
 * key-release, a visible body flick.
 *
 * `movX/movY` are the normalised camera-relative move vector the datagram
 * already computes; `prev` is the last facing to hold when idle.
 */
export function facingFromMove(prev: number, movX: number, movY: number): number {
  if (movX === 0 && movY === 0) return prev;
  return Math.atan2(movY, movX);
}
