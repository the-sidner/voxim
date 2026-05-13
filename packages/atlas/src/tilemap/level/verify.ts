/**
 * LevelDef invariants — assertions over the final pipeline output.
 *
 * Called from `generateTile` after every reducer has run. Catches drift
 * if a future reducer breaks the plateau-sealed invariant or otherwise
 * produces an inconsistent LevelDef. Throws on violation so the bake
 * loop fails loudly instead of shipping a broken tile.
 *
 * The invariants:
 *
 *   PLATEAU-SEALED — Every plateau region pixel has openMask=0 at bake
 *     time. The gameplay contract is "plateau plateaus are reached only
 *     via stairs". Atlas-side LevelDef + buffers must encode that as a
 *     sealed wall. Tile-server's `applyStairUnlock` is the only thing
 *     allowed to flip openMask=1 on plateau pixels — and it runs at
 *     tile-boot, not at bake. So the bake-time buffer must have every
 *     plateau pixel sealed.
 *
 *   ZONE-COVERAGE — Every region's zoneId appears in zoneOf at least
 *     once. Empty regions are a bug; they'd report names + centroids in
 *     the HUD but the player could never find them.
 *
 *   STAIR-ENDPOINTS — Every stair edge's `from` and `to` reference real
 *     regions. The matcher's selection should already guarantee this,
 *     but assert defensively.
 */

import type { LevelDef } from "./types.ts";

export function verifyLevelInvariants(
  level: LevelDef,
  openMask: Uint8Array,
  zoneOf: Uint16Array,
  gridSize: number,
): void {
  verifyPlateauSealed(level, openMask, zoneOf, gridSize);
  verifyZoneCoverage(level, zoneOf);
  verifyStairEndpoints(level);
}

function verifyPlateauSealed(
  level: LevelDef,
  openMask: Uint8Array,
  zoneOf: Uint16Array,
  _gridSize: number,
): void {
  const plateauZoneIds = new Set<number>();
  for (const r of level.regions) if (r.kind === "plateau") plateauZoneIds.add(r.zoneId);
  if (plateauZoneIds.size === 0) return;

  let leaks = 0;
  let firstLeak: { idx: number; zoneId: number } | null = null;
  for (let idx = 0; idx < zoneOf.length; idx++) {
    if (!plateauZoneIds.has(zoneOf[idx])) continue;
    if (openMask[idx] !== 0) {
      leaks++;
      if (!firstLeak) firstLeak = { idx, zoneId: zoneOf[idx] };
    }
  }
  if (leaks > 0 && firstLeak) {
    throw new Error(
      `LevelDef invariant violated: plateau region with zoneId=${firstLeak.zoneId} ` +
      `has ${leaks} pixel(s) with openMask=1 (first at idx=${firstLeak.idx}). ` +
      `Plateau pixels must be sealed at bake time — stair unlocks happen post-bake in tile-server.`,
    );
  }
}

function verifyZoneCoverage(level: LevelDef, zoneOf: Uint16Array): void {
  const present = new Set<number>();
  for (let i = 0; i < zoneOf.length; i++) {
    const z = zoneOf[i];
    if (z !== 0xFFFF) present.add(z);
  }
  for (const r of level.regions) {
    if (!present.has(r.zoneId)) {
      throw new Error(
        `LevelDef invariant violated: region ${r.id} has zoneId=${r.zoneId} ` +
        `but no pixel in zoneOf reports that id`,
      );
    }
  }
}

function verifyStairEndpoints(level: LevelDef): void {
  const regionIds = new Set(level.regions.map(r => r.id));
  for (const s of level.edges.stairs) {
    if (!regionIds.has(s.from)) {
      throw new Error(`LevelDef invariant violated: stair ${s.id} from=${s.from} is not a real region`);
    }
    if (!regionIds.has(s.to)) {
      throw new Error(`LevelDef invariant violated: stair ${s.id} to=${s.to} is not a real region`);
    }
  }
}
