/**
 * NoiseSystem (T-014) — actor loudness derived from horizontal speed, scaled
 * by the crouch multiplier while Crouched. Runs against real game_config.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Velocity, InputState } from "../components/game.ts";
import { Crouched } from "../components/tags.ts";
import { NoiseLevel } from "../components/noise.ts";
import { NoiseSystem } from "./noise.ts";

const content = await JsonSource.load();
const MAX = content.getGameConfig().physics.maxGroundSpeed;
const CROUCH_MUL = content.getGameConfig().stealth.crouchNoiseMultiplier;

function noiseFor(vx: number, vy: number, crouched: boolean): number {
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Velocity, { x: vx, y: vy, z: 0 });
  w.write(id, InputState, InputState.default());
  if (crouched) w.write(id, Crouched, Crouched.default());
  new NoiseSystem(content).run(w, new EventBus(), 1 / 20);
  w.applyChangeset();
  return w.get(id, NoiseLevel)!.level;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

Deno.test("noise: full sprint → max loudness", () => assertEquals(noiseFor(MAX, 0, false), 1));
Deno.test("noise: standing still → silent", () => assertEquals(noiseFor(0, 0, false), 0));
Deno.test("noise: half speed → half loud", () => assertEquals(noiseFor(MAX / 2, 0, false), 0.5));
Deno.test("noise: crouch-sprint scaled by the crouch multiplier", () =>
  assertEquals(r3(noiseFor(MAX, 0, true)), r3(CROUCH_MUL)));
Deno.test("noise: clamps at 1 above maxGroundSpeed", () => assertEquals(noiseFor(MAX * 2, 0, false), 1));

Deno.test("noise: an entity without InputState gets no NoiseLevel (actors only)", () => {
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Velocity, { x: MAX, y: 0, z: 0 }); // a moving projectile, say — no InputState
  new NoiseSystem(content).run(w, new EventBus(), 1 / 20);
  w.applyChangeset();
  assertEquals(w.get(id, NoiseLevel), null);
});
