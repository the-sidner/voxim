/**
 * Nearest-interactable selection (T-320) — pure so the range gating + priority
 * tiebreak are deterministically testable without DOM/THREE/world.
 *
 * Each candidate carries its own `range` (its matching handler's
 * interactionRange) and `priority`. The winner is the closest candidate within
 * its own range; among candidates at (numerically) equal distance the higher
 * priority wins. Deterministic: with all else equal the earlier candidate holds
 * (a stable pick avoids flicker between two equidistant props).
 */
export interface InteractableCandidate {
  entityId: string;
  x: number;
  y: number;
  /** Max distance this candidate is selectable at (its handler's range). */
  range: number;
  /** Handler priority — breaks ties at equal distance. */
  priority: number;
}

export function pickNearestInteractable(
  candidates: readonly InteractableCandidate[],
  playerX: number,
  playerY: number,
): InteractableCandidate | null {
  let best: InteractableCandidate | null = null;
  let bestDistSq = Infinity;

  for (const c of candidates) {
    const dx = c.x - playerX;
    const dy = c.y - playerY;
    const distSq = dx * dx + dy * dy;
    if (distSq > c.range * c.range) continue; // out of this candidate's range

    if (distSq < bestDistSq) {
      best = c;
      bestDistSq = distSq;
    } else if (distSq === bestDistSq && best !== null && c.priority > best.priority) {
      best = c; // equal distance → higher priority wins
    }
  }

  return best;
}
