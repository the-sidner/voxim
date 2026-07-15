/**
 * T-311 P6 cliff derivation — structural properties (not tuned values; the
 * profile-index resolution is exercised in the content plumbing tests).
 * Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { BoundaryKind } from "@voxim/protocol";
import { deriveCliffPlanes, type CliffDeriveInput } from "./cliff.ts";
import type { CliffProfileDef } from "@voxim/content";

const G = 8;
const N = G * G;
const idx = (x: number, y: number) => x + y * G;

const fakeProfiles: CliffProfileDef[] = [
  {
    id: "columnar",
    wallKind: "stone",
    erosionStates: {
      crisp: { tierCount: 3, jitterAmp: 0.1, edgeChinkiness: 0.2 },
      weathered: { tierCount: 4, jitterAmp: 0.2, edgeChinkiness: 0.3 },
      broken: { tierCount: 5, jitterAmp: 0.3, edgeChinkiness: 0.4 },
    },
  },
];

function baseInput(): CliffDeriveInput {
  const kindOf = new Uint16Array(N).fill(BoundaryKind.open);
  const openMask = new Uint8Array(N).fill(1);
  const chamberOf = new Uint16Array(N);

  // A stone wall cell adjacent to open ground — should get a profile + edge=1.
  kindOf[idx(2, 2)] = BoundaryKind.stone;
  openMask[idx(2, 2)] = 0;

  // A buried stone cell (all 4 neighbours closed too) — should stay profileId 0.
  kindOf[idx(4, 4)] = BoundaryKind.stone;
  openMask[idx(4, 4)] = 0;
  kindOf[idx(3, 4)] = BoundaryKind.stone; openMask[idx(3, 4)] = 0;
  kindOf[idx(5, 4)] = BoundaryKind.stone; openMask[idx(5, 4)] = 0;
  kindOf[idx(4, 3)] = BoundaryKind.stone; openMask[idx(4, 3)] = 0;
  kindOf[idx(4, 5)] = BoundaryKind.stone; openMask[idx(4, 5)] = 0;

  // A forest wall cell — v1 scope narrows to stone only, must stay profileId 0.
  kindOf[idx(6, 6)] = BoundaryKind.forest;
  openMask[idx(6, 6)] = 0;

  return {
    gridSize: G, kindOf, openMask, chamberOf, tileSeed: 12345,
    profileIndex: fakeProfiles,
    params: { erosionCrispMax: 85, erosionWeatheredMax: 170 },
  };
}

Deno.test("T-311 P6: a stone edge cell (open neighbour) gets a resolved profile + edge=1", () => {
  const c = deriveCliffPlanes(baseInput());
  assertEquals(c.edge[idx(2, 2)], 1);
  assertEquals(c.profileId[idx(2, 2)], 1); // index into profileIndex[0], wire id 1
});

Deno.test("T-311 P6: a buried stone cell (no open neighbour) stays profileId 0", () => {
  const c = deriveCliffPlanes(baseInput());
  assertEquals(c.edge[idx(4, 4)], 0);
  assertEquals(c.profileId[idx(4, 4)], 0);
});

Deno.test("T-311 P6: v1 scope — forest walls stay undecorated (profileId 0)", () => {
  const c = deriveCliffPlanes(baseInput());
  assertEquals(c.profileId[idx(6, 6)], 0);
  assertEquals(c.edge[idx(6, 6)], 0);
});

Deno.test("T-311 P6: open cells never get a profile", () => {
  const c = deriveCliffPlanes(baseInput());
  assertEquals(c.profileId[idx(0, 0)], 0);
  assertEquals(c.edge[idx(0, 0)], 0);
});

Deno.test("T-311 P6: no content (empty profileIndex) → all-zero planes (snapshot-safe)", () => {
  const input = baseInput();
  const c = deriveCliffPlanes({ ...input, profileIndex: [] });
  for (let i = 0; i < N; i++) {
    assertEquals(c.profileId[i], 0);
    assertEquals(c.erosion[i], 0);
    assertEquals(c.edge[i], 0);
  }
});

Deno.test("T-311 P6: erosion is deterministic per chamber", () => {
  const input = baseInput();
  input.chamberOf[idx(2, 2)] = 3;
  const a = deriveCliffPlanes(input);
  const b = deriveCliffPlanes(input);
  assertEquals(a.erosion[idx(2, 2)], b.erosion[idx(2, 2)]);
  assert(a.erosion[idx(2, 2)] === 0 || a.erosion[idx(2, 2)] === 1 || a.erosion[idx(2, 2)] === 2);
});

Deno.test("T-311 P6: full deriveCliffPlanes is deterministic", () => {
  const input = baseInput();
  const a = deriveCliffPlanes(input);
  const b = deriveCliffPlanes(input);
  assertEquals(a.profileId, b.profileId);
  assertEquals(a.erosion, b.erosion);
  assertEquals(a.tier, b.tier);
  assertEquals(a.edge, b.edge);
});
