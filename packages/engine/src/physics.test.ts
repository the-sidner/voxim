/**
 * T-337 — direct coverage for the ballistic substrate (`ballisticStep` /
 * `launchVelocity`), moved here from tile-server-only `physics/ballistic.ts`
 * so the client can share it. Neither function had a dedicated test file
 * before this move (ballisticStep was only exercised indirectly via
 * tile-server's projectile.test.ts); this closes that gap.
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { ballisticStep, launchVelocity } from "./physics.ts";

Deno.test("ballisticStep: no gravity — straight-line integration", () => {
  const body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 2, y: 0, z: 0 } };
  const next = ballisticStep(body, 20, 0, 1);
  assertEquals(next.pos, { x: 2, y: 0, z: 0 });
  assertEquals(next.vel, { x: 2, y: 0, z: 0 });
});

Deno.test("ballisticStep: gravity decelerates vertical velocity then pulls the body down", () => {
  const body = { pos: { x: 0, y: 0, z: 10 }, vel: { x: 0, y: 0, z: 5 } };
  const next = ballisticStep(body, 20, 1.0, 0.1);
  // position integrates with the PRE-step velocity (matches the tile-server's
  // original ballistic.ts semantics — verified by the projectile resolver's
  // own behaviour, unchanged by this move).
  assertAlmostEquals(next.pos.z, 10 + 5 * 0.1);
  assertAlmostEquals(next.vel.z, 5 - 20 * 1.0 * 0.1);
});

Deno.test("ballisticStep: gravityScale < 1 gives a flatter arc than gravityScale 1.0", () => {
  const body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  const flat = ballisticStep(body, 20, 0.4, 1);
  const full = ballisticStep(body, 20, 1.0, 1);
  assertEquals(flat.vel.z, -8);
  assertEquals(full.vel.z, -20);
});

Deno.test("launchVelocity: facing=0, pitch=0 — level shot along +x at full speed", () => {
  const v = launchVelocity(0, 0, 10);
  assertAlmostEquals(v.x, 10);
  assertAlmostEquals(v.y, 0);
  assertAlmostEquals(v.z, 0);
});

Deno.test("launchVelocity: pitch=90deg — straight up, no horizontal component", () => {
  const v = launchVelocity(0, Math.PI / 2, 10);
  assertAlmostEquals(v.x, 0, 1e-9);
  assertAlmostEquals(v.y, 0, 1e-9);
  assertAlmostEquals(v.z, 10);
});

Deno.test("launchVelocity: facing rotates the horizontal component, pitch=0", () => {
  const v = launchVelocity(Math.PI / 2, 0, 10);
  assertAlmostEquals(v.x, 0, 1e-9);
  assertAlmostEquals(v.y, 10);
  assertAlmostEquals(v.z, 0);
});

Deno.test("launchVelocity: positive pitch trades horizontal speed for vertical", () => {
  const v = launchVelocity(0, Math.PI / 4, 10);
  assertAlmostEquals(v.x, 10 * Math.cos(Math.PI / 4));
  assertAlmostEquals(v.z, 10 * Math.sin(Math.PI / 4));
  // Speed is conserved (it's a rotation of the same magnitude vector).
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  assertAlmostEquals(speed, 10);
});
