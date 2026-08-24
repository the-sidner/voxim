/**
 * WorldSnapshot region paging (T-364) — the unreliable snapshot channel used
 * to broadcast every entity's raw position to every session regardless of
 * AoI (bandwidth waste + wallhack: a modified client didn't have to respect
 * the reliable channel's "only act on entities you were spawned" contract).
 * Pins:
 *   - a session far from an entity's region does NOT receive that entity's
 *     position bytes at all (not just "ignores them client-side"),
 *   - a session near an entity DOES receive its region's page,
 *   - pages are encoded exactly once per occupied region per tick, no matter
 *     how many sessions later filter against them (encode-once-broadcast-
 *     many, preserved from 04c1dd19).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import type { SnapshotEntity } from "@voxim/protocol";
import { worldSnapshotCodec } from "@voxim/protocol";
import { buildSnapshotPages, isPageVisible, SNAPSHOT_REGION_SIZE } from "./snapshot_paging.ts";
import { AOI_EXIT_MARGIN } from "./aoi.ts";

const AOI_RADIUS = 128;
const SNAPSHOT_RADIUS = AOI_RADIUS + AOI_EXIT_MARGIN; // 160 — matches server.ts's step 7b

// worldSnapshotCodec round-trips entityId through uuidToBytes/bytesToUuid
// (hex-nibble decoding, no validation) — real entity ids are required for a
// clean round trip, a plain label like "near" is not.
function entity(entityId: EntityId, x: number, y: number): SnapshotEntity {
  return { entityId, x, y, z: 4, facing: 0, vx: 0, vy: 0, vz: 0 };
}

/** Mirrors server.ts's per-session filter loop: which entityIds actually reach a session at (px,py). */
function deliveredEntityIds(pages: ReturnType<typeof buildSnapshotPages>, px: number, py: number): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) {
    if (!isPageVisible(page, px, py, SNAPSHOT_RADIUS)) continue;
    for (const e of worldSnapshotCodec.decode(page.bytes).entities) ids.add(e.entityId);
  }
  return ids;
}

Deno.test("region paging: a session with a far-away player does NOT receive a distant entity's position", () => {
  const nearId = newEntityId();
  const farId = newEntityId();
  const near = entity(nearId, 256, 256);
  const far = entity(farId, 500, 500); // region (3,3) vs player's region (2,2) — well past 160
  const pages = buildSnapshotPages([near, far], /*serverTick*/ 10);

  const delivered = deliveredEntityIds(pages, 256, 256);
  assert(!delivered.has(farId), "far entity's page bytes must not reach a distant session");
});

Deno.test("region paging: a nearby entity's page IS received", () => {
  const nearId = newEntityId();
  const farId = newEntityId();
  const near = entity(nearId, 270, 256); // same region as the player, 14 units away
  const far = entity(farId, 500, 500);
  const pages = buildSnapshotPages([near, far], 10);

  const delivered = deliveredEntityIds(pages, 256, 256);
  assert(delivered.has(nearId), "nearby entity's page must reach the session");
});

Deno.test("region paging: isPageVisible is a circle-vs-region-box test at exactly aoiRadius+margin", () => {
  // Page filtering is coarser than the reliable channel's per-entity
  // hysteresis (aoi_hysteresis.test.ts) by design — the whole point of
  // region paging is that one page covers many entities, encoded once. So
  // the boundary this pins is the region BOX edge against the circle, not a
  // single entity's exact distance: a page is visible the moment ANY part of
  // its region falls within aoiRadius + AOI_EXIT_MARGIN of the player,
  // consistent with computeSessionUpdate's own aoiRadius+margin rule so the
  // two channels agree on roughly the same "may this client know about it"
  // boundary without needing identical per-entity precision.
  const page = { regionX: 0, regionY: 0, minX: 0, minY: 0, maxX: 128, maxY: 128, bytes: new Uint8Array(0) };
  // Closest box point to (128 + 159, 0) is (128, 0) — distance 159 < 160.
  assert(isPageVisible(page, 128 + 159, 0, SNAPSHOT_RADIUS), "just inside the region-box boundary must be visible");
  // Closest box point to (128 + 161, 0) is (128, 0) — distance 161 > 160.
  assert(!isPageVisible(page, 128 + 161, 0, SNAPSHOT_RADIUS), "just outside the region-box boundary must not be visible");
});

Deno.test("region paging: pages are encoded exactly once per occupied region, independent of session count", () => {
  const entities = [
    entity(newEntityId(), 40, 40),     // region (0,0)
    entity(newEntityId(), 260, 260),   // region (2,2)
    entity(newEntityId(), 450, 450),   // region (3,3)
  ];

  let encodeCalls = 0;
  const originalEncode = worldSnapshotCodec.encode;
  worldSnapshotCodec.encode = ((snap) => {
    encodeCalls++;
    return originalEncode(snap);
  }) as typeof worldSnapshotCodec.encode;

  try {
    const pages = buildSnapshotPages(entities, 10);
    assertEquals(pages.length, 3, "one page per occupied region — three entities in three distinct regions");
    assertEquals(encodeCalls, 3, "buildSnapshotPages encodes each region once");

    // Filter the SAME pages against five different session positions —
    // encoding must not happen again; only isPageVisible + delivery vary.
    const sessionPositions: Array<[number, number]> = [
      [40, 40], [260, 260], [450, 450], [256, 256], [0, 0],
    ];
    for (const [px, py] of sessionPositions) {
      for (const page of pages) isPageVisible(page, px, py, SNAPSHOT_RADIUS);
    }
    assertEquals(encodeCalls, 3, "filtering per session must not trigger additional encodes");
  } finally {
    worldSnapshotCodec.encode = originalEncode;
  }
});

Deno.test("region paging: a dense region sub-pages at the 27-entity datagram cap, still encoded once (not per session)", () => {
  const entities: SnapshotEntity[] = [];
  for (let i = 0; i < 30; i++) entities.push(entity(newEntityId(), 256 + i, 256)); // all in region (2,2)

  const pages = buildSnapshotPages(entities, 10);
  assertEquals(pages.length, 2, "30 entities in one region split into two sub-pages at the 27 cap");
  for (const page of pages) {
    assertEquals(page.regionX, 2);
    assertEquals(page.regionY, 2);
  }

  const totalEntities = pages.reduce((n, p) => n + worldSnapshotCodec.decode(p.bytes).entities.length, 0);
  assertEquals(totalEntities, 30, "no entity dropped across the sub-pages");
});

Deno.test("region paging: SNAPSHOT_REGION_SIZE tiles the 512-unit world without gaps at region boundaries", () => {
  // A player standing exactly on a region boundary must still see an entity
  // one unit inside the neighbouring region (regression guard against an
  // off-by-one in regionCoord/isPageVisible's floor()).
  const px = SNAPSHOT_REGION_SIZE, py = SNAPSHOT_REGION_SIZE;
  const justInsideId = newEntityId();
  const justInside = entity(justInsideId, SNAPSHOT_REGION_SIZE - 1, SNAPSHOT_REGION_SIZE);
  const pages = buildSnapshotPages([justInside], 10);
  const delivered = deliveredEntityIds(pages, px, py);
  assert(delivered.has(justInsideId));
});
