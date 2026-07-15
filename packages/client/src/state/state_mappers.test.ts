/**
 * Pins the single client-side day-phase derivation: worldClockPhase reads the
 * SAME content boundaries the server's DayNightSystem fires DayPhaseChanged
 * from (game_config.dayNight), so tuning dawnStart/noonStart/duskStart moves
 * the lighting phase and the toast together — never two disagreeing sources.
 */
import { assertEquals } from "jsr:@std/assert";
import { worldClockPhase } from "./state_mappers.ts";

const DAY = 1000;

Deno.test("worldClockPhase: default boundaries (pre-bootstrap fallback)", () => {
  assertEquals(worldClockPhase(0, DAY), "midnight");
  assertEquals(worldClockPhase(249, DAY), "midnight");
  assertEquals(worldClockPhase(250, DAY), "dawn");
  assertEquals(worldClockPhase(500, DAY), "noon");
  assertEquals(worldClockPhase(750, DAY), "dusk");
  assertEquals(worldClockPhase(999, DAY), "dusk");
  assertEquals(worldClockPhase(1000, DAY), "midnight", "wraps at day length");
});

Deno.test("worldClockPhase: content-tuned boundaries shift every phase edge", () => {
  const dayNight = { dawnStart: 0.2, noonStart: 0.45, duskStart: 0.8 };
  assertEquals(worldClockPhase(199, DAY, dayNight), "midnight");
  assertEquals(worldClockPhase(200, DAY, dayNight), "dawn", "dawn follows the tuned dawnStart, not 0.25");
  assertEquals(worldClockPhase(449, DAY, dayNight), "dawn");
  assertEquals(worldClockPhase(450, DAY, dayNight), "noon");
  assertEquals(worldClockPhase(799, DAY, dayNight), "noon", "0.75 is still noon under duskStart=0.8");
  assertEquals(worldClockPhase(800, DAY, dayNight), "dusk");
});
