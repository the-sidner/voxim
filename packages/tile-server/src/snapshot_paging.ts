/**
 * WorldSnapshot region paging (T-364).
 *
 * The unreliable WorldSnapshot channel used to page purely by entity COUNT
 * (27/datagram, the QUIC-MTU cap) and broadcast every page to every session —
 * bandwidth waste, and a wallhack: any connected session received the raw
 * position bytes of every entity in the tile regardless of AoI, even though
 * an honest client only acts on entities it already knows from the reliable
 * spawn channel. A modified client does not have to stay honest.
 *
 * Fix: page by spatial REGION instead of raw count. Each region's entities
 * are still encoded exactly ONCE per tick (preserving the encode-once-
 * broadcast-many property from 04c1dd19 — buildSnapshotPages takes no
 * per-session input), but a page is only handed to sessions whose AoI
 * overlaps that region. A dense region still sub-pages at
 * MAX_ENTITIES_PER_PAGE to stay under the datagram MTU.
 */
import type { SnapshotEntity, WorldSnapshot } from "@voxim/protocol";
import { worldSnapshotCodec } from "@voxim/protocol";

/** WorldSnapshot layout: 6-byte header + 44 bytes/entity → stays under the ~1200-byte QUIC datagram MTU at 27 entities. */
const MAX_ENTITIES_PER_PAGE = 27;

/**
 * World-unit size of one paging region. The 512×512 tile splits into a 4×4
 * grid of 128-unit regions — small enough that a session's AoI circle
 * (radius aoiRadius + AOI_EXIT_MARGIN, ~160 units) overlaps only a handful
 * of regions, large enough that the region count (≤16) stays cheap to scan
 * per session regardless of entity density.
 */
export const SNAPSHOT_REGION_SIZE = 128;

export interface SnapshotPage {
  readonly regionX: number;
  readonly regionY: number;
  /** Region bounding box in world units — used by isPageVisible's circle/AABB test. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Pre-encoded datagram bytes — identical for every session, encoded once. */
  readonly bytes: Uint8Array;
}

function regionCoord(v: number): number {
  return Math.floor(v / SNAPSHOT_REGION_SIZE);
}

function regionKey(rx: number, ry: number): number {
  // Regions are non-negative for any in-bounds tile position (512/128 = 4 per
  // side), but clients off the tile edge (in-flight handoff) can carry
  // slightly negative coordinates — bias-encode so the key stays a small
  // non-negative integer without colliding.
  return (rx + 4096) * 65536 + (ry + 4096);
}

/**
 * Bucket every snapshot-eligible entity into its spatial region and encode
 * each region's page(s) exactly once. Called once per tick, independent of
 * session count — the caller (server.ts) filters the returned pages per
 * session via isPageVisible instead of re-encoding per session.
 */
export function buildSnapshotPages(
  entities: readonly SnapshotEntity[],
  serverTick: number,
): SnapshotPage[] {
  const buckets = new Map<number, { rx: number; ry: number; list: SnapshotEntity[] }>();
  for (const e of entities) {
    const rx = regionCoord(e.x);
    const ry = regionCoord(e.y);
    const key = regionKey(rx, ry);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { rx, ry, list: [] };
      buckets.set(key, bucket);
    }
    bucket.list.push(e);
  }

  const pages: SnapshotPage[] = [];
  for (const { rx, ry, list } of buckets.values()) {
    const minX = rx * SNAPSHOT_REGION_SIZE;
    const minY = ry * SNAPSHOT_REGION_SIZE;
    const maxX = minX + SNAPSHOT_REGION_SIZE;
    const maxY = minY + SNAPSHOT_REGION_SIZE;
    for (let offset = 0; offset < list.length; offset += MAX_ENTITIES_PER_PAGE) {
      const slice = list.slice(offset, offset + MAX_ENTITIES_PER_PAGE);
      const snap: WorldSnapshot = { serverTick, entities: slice };
      pages.push({ regionX: rx, regionY: ry, minX, minY, maxX, maxY, bytes: worldSnapshotCodec.encode(snap) });
    }
  }
  return pages;
}

/**
 * True if a session centered at (px, py) with the given radius (aoiRadius +
 * AOI_EXIT_MARGIN — see aoi.ts) can see anything in this page's region.
 * Circle-vs-AABB: clamp the circle center into the box, compare distance.
 */
export function isPageVisible(page: SnapshotPage, px: number, py: number, radius: number): boolean {
  const cx = Math.max(page.minX, Math.min(px, page.maxX));
  const cy = Math.max(page.minY, Math.min(py, page.maxY));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}
