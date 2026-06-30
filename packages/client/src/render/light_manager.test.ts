/**
 * LightBudget (T-311 Phase 2). Runs headless — THREE PointLight/Group/Vector3 are
 * pure matrix math, no GL. Pins: with more emitters than the budget, exactly
 * LIGHT_BUDGET (8) lights stay visible and they are the nearest ones; under the
 * budget, all stay visible.
 */
import { assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { LightManager } from "./light_manager.ts";

function makeEmitter() {
  return { color: 0xffffff, intensity: 1, radius: 10, lightDefId: "" };
}

function visibleLights(groups: THREE.Group[]): boolean[] {
  return groups.map((g) =>
    g.children.some((c) => (c as THREE.PointLight).isPointLight && c.visible)
  );
}

Deno.test("T-311: LightBudget keeps only the nearest 8 of many emitters visible", () => {
  const lm = new LightManager();
  const groups: THREE.Group[] = [];
  for (let i = 0; i < 12; i++) {
    const g = new THREE.Group();
    g.position.set(i * 5, 0, 0); // monotonically farther from the camera at origin
    groups.push(g);
    lm.sync(`e${i}`, makeEmitter(), g);
  }
  lm.tick(1000, new THREE.Vector3(0, 0, 0));
  const vis = visibleLights(groups);
  assertEquals(vis.filter(Boolean).length, 8, "exactly the budget is visible");
  // equal importance → nearest 8 (groups 0..7) win, 8..11 degrade
  assertEquals(vis.slice(0, 8).every(Boolean), true, "nearest 8 visible");
  assertEquals(vis.slice(8).some(Boolean), false, "farthest 4 degraded");
});

Deno.test("T-311: under the budget, every emitter stays visible", () => {
  const lm = new LightManager();
  const groups: THREE.Group[] = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    g.position.set(i * 5, 0, 0);
    groups.push(g);
    lm.sync(`e${i}`, makeEmitter(), g);
  }
  lm.tick(1000, new THREE.Vector3(0, 0, 0));
  assertEquals(visibleLights(groups).filter(Boolean).length, 5);
});
