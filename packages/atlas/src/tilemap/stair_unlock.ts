/**
 * Stair unlock — heightmap ramp + openMask flip (T-213).
 *
 * A StairInstance lives at a path-pixel adjacent to a wilderness blob.
 * When the stair is unlocked (either at tile boot for `lockedBy === null`
 * "found" stairs, or at runtime when a player consumes the gating
 * trinket — that path is T-212), two surfaces become traversable:
 *
 *   1. THE RAMP — heightmap-lerped pixels at the anchor that transition
 *      from path floor (~0) up to wilderness plateau height (wallHeight,
 *      typically 2u). The lerp runs from the path-side pixel deepest
 *      into the wilderness blob, a few pixels deep, so the player walks
 *      a smooth slope up rather than facing a sheer 2u wall.
 *
 *   2. THE WILDERNESS PLATEAU — every pixel of the wilderness zone the
 *      stair leads to becomes walkable (openMask = 1). The heightmap
 *      stays at wallHeight up there; that IS the plateau surface.
 *      Flood-fill bounded by zoneOf so an unlocked stair only opens
 *      its target blob, not adjacent unrelated wilderness.
 *
 * Both effects are produced by mutating the upsampled tile-server
 * buffers (TILE_SIZE² resolution). No new wire format — the modified
 * buffers ship through the existing terrain chunk path. Heightmap
 * lerps for run-time unlocks will need a delta wire format later
 * (T-212 territory).
 */

export interface StairAnchor {
  /** Anchor pixel in tile-server's TILE_SIZE² grid. */
  x: number;
  y: number;
}

export interface StairMarkerOptions {
  wildernessZoneId: number;
  anchor: StairAnchor;
  /**
   * Material id to paint the stair pixels with. Should be the
   * tile-server-translated id for "stone" or "path" — a contrasting
   * surface so the player can spot the stair from a distance.
   */
  markerMaterialId: number;
  /** How many pixels along the climb axis the marker spans. Default 5. */
  markerDepth?: number;
  /** Half-width perpendicular to climb. Default 2 (5-pixel-wide tread). */
  markerHalfWidth?: number;
}

/**
 * Paint a visible marker patch at a stair anchor regardless of lock
 * state (T-213 visibility fix). Locked stairs get the marker on the
 * wilderness wall pixels so the player sees "stairs here, locked";
 * unlocked stairs get it on the ramp pixels (called from
 * `applyStairUnlock` below).
 *
 * Independent of openMask + heightmap — purely a visual cue so the
 * player can spot stair locations from across the tile. Mutates
 * `materialBuffer` in place.
 */
export function markStairAnchor(
  materialBuffer: Uint16Array,
  zoneBuffer: Uint16Array,
  tileSize: number,
  opts: StairMarkerOptions,
): number {
  const { wildernessZoneId, anchor, markerMaterialId } = opts;
  const markerDepth     = opts.markerDepth     ?? 5;
  const markerHalfWidth = opts.markerHalfWidth ?? 2;
  const stride = tileSize;
  if (anchor.x < 0 || anchor.y < 0 || anchor.x >= stride || anchor.y >= stride) return 0;
  const anchorIdx = anchor.y * stride + anchor.x;

  // Climb direction — same logic as the unlock helper. Painted patch
  // runs from the anchor into the wilderness.
  let dx = 0, dy = 0;
  if (anchor.x > 0          && zoneBuffer[anchorIdx - 1]      === wildernessZoneId) { dx = -1; dy =  0; }
  if (anchor.x < stride - 1 && zoneBuffer[anchorIdx + 1]      === wildernessZoneId) { dx =  1; dy =  0; }
  if (anchor.y > 0          && zoneBuffer[anchorIdx - stride] === wildernessZoneId) { dx =  0; dy = -1; }
  if (anchor.y < stride - 1 && zoneBuffer[anchorIdx + stride] === wildernessZoneId) { dx =  0; dy =  1; }
  if (dx === 0 && dy === 0) return 0;
  const px = -dy, py = dx;

  let touched = 0;
  for (let i = 0; i <= markerDepth; i++) {
    for (let j = -markerHalfWidth; j <= markerHalfWidth; j++) {
      const rx = anchor.x + dx * i + px * j;
      const ry = anchor.y + dy * i + py * j;
      if (rx < 0 || ry < 0 || rx >= stride || ry >= stride) continue;
      const idx = ry * stride + rx;
      // Only paint anchor row + target wilderness zone (don't bulldoze
      // an unrelated wilderness blob that happens to share a corner).
      const zoneOk = i === 0 ? true : zoneBuffer[idx] === wildernessZoneId;
      if (!zoneOk) continue;
      materialBuffer[idx] = markerMaterialId;
      touched++;
    }
  }
  return touched;
}

export interface StairUnlockOptions {
  /** Wilderness zone id whose pixels become walkable. */
  wildernessZoneId: number;
  /** Anchor in TILE_SIZE coords (NOT atlas grid coords). */
  anchor: StairAnchor;
  /** Wall step height the wilderness pixels currently carry. */
  wallHeight: number;
  /** Ramp depth (pixels) — how far into the wilderness the lerp extends. */
  rampDepth?: number;
  /** Ramp half-width perpendicular to the climb direction (pixels). */
  rampHalfWidth?: number;
}

/**
 * Apply a stair unlock to tile-server buffers in place.
 *
 *   heightBuffer + openBuffer + zoneBuffer are at TILE_SIZE² resolution
 *   (post-upsample). zoneBuffer is read-only here; the others are
 *   mutated. Returns the count of pixels affected so callers can log /
 *   verify.
 *
 * Algorithm:
 *   1. Determine climb direction: from anchor → wilderness centroid.
 *      Approximated by sampling the 4 neighbours and picking the one
 *      whose zone is `wildernessZoneId` — that's the immediate "up"
 *      direction.
 *   2. Walk `rampDepth` pixels into the wilderness, half-width to each
 *      side. For each ramp pixel, lerp heightmap from floor (the
 *      anchor's current height) up to plateau (anchor + wallHeight),
 *      and flip openMask to 1.
 *   3. Flood-fill openMask = 1 across the entire `wildernessZoneId`
 *      blob (the player walks freely once they reach the plateau).
 */
export function applyStairUnlock(
  heightBuffer: Float32Array,
  openBuffer: Uint8Array,
  zoneBuffer: Uint16Array,
  tileSize: number,
  opts: StairUnlockOptions,
): number {
  const { wildernessZoneId, anchor, wallHeight } = opts;
  const rampDepth     = opts.rampDepth     ?? 4;
  const rampHalfWidth = opts.rampHalfWidth ?? 2;

  const stride = tileSize;
  if (anchor.x < 0 || anchor.y < 0 || anchor.x >= stride || anchor.y >= stride) return 0;
  const anchorIdx = anchor.y * stride + anchor.x;
  const floorHeight = heightBuffer[anchorIdx];

  // Climb direction: pick the 4-neighbour whose zone matches the target.
  let dx = 0, dy = 0;
  if (anchor.x > 0          && zoneBuffer[anchorIdx - 1]      === wildernessZoneId) { dx = -1; dy =  0; }
  if (anchor.x < stride - 1 && zoneBuffer[anchorIdx + 1]      === wildernessZoneId) { dx =  1; dy =  0; }
  if (anchor.y > 0          && zoneBuffer[anchorIdx - stride] === wildernessZoneId) { dx =  0; dy = -1; }
  if (anchor.y < stride - 1 && zoneBuffer[anchorIdx + stride] === wildernessZoneId) { dx =  0; dy =  1; }
  if (dx === 0 && dy === 0) return 0; // anchor not adjacent to the wilderness — nothing to do.

  // Perpendicular axis for the ramp width.
  const px = -dy;
  const py =  dx;

  let touched = 0;

  // (1+2) Carve the ramp. `i` runs along the climb axis (0 = anchor,
  // 1..rampDepth into the wilderness). `j` runs along the perpendicular
  // axis (-halfWidth..+halfWidth).
  for (let i = 0; i <= rampDepth; i++) {
    const t = i / rampDepth;            // 0..1
    const h = floorHeight + wallHeight * t;
    for (let j = -rampHalfWidth; j <= rampHalfWidth; j++) {
      const rx = anchor.x + dx * i + px * j;
      const ry = anchor.y + dy * i + py * j;
      if (rx < 0 || ry < 0 || rx >= stride || ry >= stride) continue;
      const idx = ry * stride + rx;
      // Only mutate pixels that are EITHER the path-side anchor row
      // OR the target wilderness zone. We don't want to bulldoze a
      // neighbouring wilderness zone that happens to be perpendicular.
      const zoneOk = i === 0 ? true : zoneBuffer[idx] === wildernessZoneId;
      if (!zoneOk) continue;
      heightBuffer[idx] = h;
      openBuffer[idx]   = 1;
      touched++;
    }
  }

  // (3) Flood-fill openBuffer across the wilderness blob. Heightmap
  // stays at wallHeight up there — that's the plateau surface; the
  // player walks on top once they step off the ramp.
  const stack: number[] = [];
  for (let idx = 0; idx < zoneBuffer.length; idx++) {
    if (zoneBuffer[idx] === wildernessZoneId && openBuffer[idx] === 0) {
      stack.push(idx);
    }
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (openBuffer[idx] === 1) continue;
    openBuffer[idx] = 1;
    touched++;
  }

  return touched;
}
