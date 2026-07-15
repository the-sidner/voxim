/**
 * WeaponTrailRenderer cleanup tests (T-361) — headless three.js, partial-cast
 * fakes (crumble_controller.test.ts precedent). Reaches into the private
 * `slices` map to seed trail state directly: driving it through the public
 * path needs a full FK skeleton + active-phase timing, all irrelevant to the
 * lifecycle behaviour under test.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { WeaponTrailRenderer } from "./weapon_trail.ts";
import type { EntityMeshGroup } from "./entity_mesh.ts";

interface TrailInternals {
  slices: Map<string, { alpha: number }[]>;
  meshes: Map<string, THREE.Mesh>;
}

function fakeMesh(): EntityMeshGroup {
  return { animationState: null } as unknown as EntityMeshGroup;
}

Deno.test("despawned entity's slices entry is swept even when its trail mesh is already gone", () => {
  const trail = new WeaponTrailRenderer(new THREE.Scene());
  const internals = trail as unknown as TrailInternals;
  // The leak shape: a thin/faded trail whose MESH was already torn down by
  // rebuild() (slices < 2 removes the mesh, never the slices entry), then
  // the entity despawns. The old sweep keyed on `meshes` never reached it.
  internals.slices.set("despawned", []);
  assertEquals(internals.meshes.has("despawned"), false);

  trail.update(new Map(), new Map(), 0);

  assertEquals(internals.slices.size, 0, "slices entries for absent entities must be removed");
});

Deno.test("a live entity's fully faded trail drops its slices entry instead of parking an empty array forever", () => {
  const trail = new WeaponTrailRenderer(new THREE.Scene());
  const internals = trail as unknown as TrailInternals;
  const entityMeshes = new Map([["e1", fakeMesh()]]); // present, not attacking
  internals.slices.set("e1", [{ alpha: 0.03 }]); // one decay step from gone

  trail.update(entityMeshes, new Map(), 0);

  assertEquals(internals.slices.has("e1"), false, "fade-out completion deletes the key");
});

Deno.test("dispose sweeps mesh-less slices entries too", () => {
  const trail = new WeaponTrailRenderer(new THREE.Scene());
  const internals = trail as unknown as TrailInternals;
  internals.slices.set("e1", []);

  trail.dispose();

  assertEquals(internals.slices.size, 0);
  assert(internals.meshes.size === 0);
});
