/**
 * pickNearestInteractable is the T-320 proximity-selection contract: the hover
 * outline + Use key both act on whatever it returns, so its range gating and
 * priority tiebreak must be exactly right. Pure → deterministic.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { pickNearestInteractable, type InteractableCandidate } from "./nearest.ts";

const c = (
  entityId: string, x: number, y: number, range: number, priority = 0,
): InteractableCandidate => ({ entityId, x, y, range, priority });

Deno.test("closest in-range candidate wins", () => {
  const picked = pickNearestInteractable(
    [c("far", 3, 0, 5), c("near", 1, 0, 5), c("mid", 2, 0, 5)],
    0, 0,
  );
  assertEquals(picked?.entityId, "near");
});

Deno.test("out-of-range candidate is skipped even if nearest", () => {
  // Ground item at 2.8u with a 2.5u range → excluded; workstation at 2.9u with
  // a 3.0u range → included (per-kind range respected).
  const picked = pickNearestInteractable(
    [c("item", 2.8, 0, 2.5), c("workstation", 2.9, 0, 3.0)],
    0, 0,
  );
  assertEquals(picked?.entityId, "workstation");
});

Deno.test("per-kind range: a ground item just outside its range is not picked", () => {
  assertEquals(pickNearestInteractable([c("item", 2.8, 0, 2.5)], 0, 0), null);
});

Deno.test("empty / all-out-of-range → null", () => {
  assertEquals(pickNearestInteractable([], 0, 0), null);
  assertEquals(pickNearestInteractable([c("far", 10, 0, 3)], 0, 0), null);
});

Deno.test("equal distance breaks on higher priority (job_board > workstation)", () => {
  const picked = pickNearestInteractable(
    [c("workstation", 2, 0, 3, 10), c("job_board", 0, 2, 3, 11)],
    0, 0,
  );
  // Both at distance 2; the priority-11 job_board wins.
  assertEquals(picked?.entityId, "job_board");
});

Deno.test("uses squared distance correctly on a diagonal", () => {
  // (3,4) is 5u away — inside a 6u range, outside a 4u one.
  assert(pickNearestInteractable([c("diag", 3, 4, 6)], 0, 0) !== null);
  assertEquals(pickNearestInteractable([c("diag", 3, 4, 4)], 0, 0), null);
});
