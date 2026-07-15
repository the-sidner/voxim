/**
 * InstancePool upload-behaviour tests — headless three.js (no WebGL context),
 * same precedent as crumble_controller.test.ts / camera_rig.test.ts.
 *
 * The GPU upload cost is asserted through its two observable proxies on the
 * InstancedBufferAttribute (what WebGLAttributes.updateBuffer consumes):
 *   - `version`      — bumped by `needsUpdate = true`; unchanged version ⇒
 *                      the renderer performs NO bufferSubData at all.
 *   - `updateRanges` — the exact float span the renderer uploads; before the
 *                      fix this was empty ⇒ full 4096×16-float (262 KB)
 *                      backing-array upload per touched archetype per frame.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { InstancePool } from "./instance_pool.ts";
import type { InstanceSlot } from "./instance_pool.ts";

function newPool(): { pool: InstancePool; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const pool = new InstancePool(scene);
  pool.registerArchetype("arch", {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    material: new THREE.MeshBasicMaterial(),
    castShadow: false,
    receiveShadow: false,
  });
  return { pool, scene };
}

function attrOf(scene: THREE.Scene): THREE.InstancedBufferAttribute {
  const mesh = scene.getObjectByName("arch") as THREE.InstancedMesh;
  return mesh.instanceMatrix as THREE.InstancedBufferAttribute;
}

function meshOf(scene: THREE.Scene): THREE.InstancedMesh {
  return scene.getObjectByName("arch") as THREE.InstancedMesh;
}

function slot(x: number): InstanceSlot {
  return { archetypeId: "arch", matrix: new THREE.Matrix4().makeTranslation(x, 0, 0) };
}

Deno.test("update: uploads exactly the live matrices via updateRanges, never the full 4096-slot buffer", () => {
  const { pool, scene } = newPool();
  pool.add("h1", "0,0", [slot(1)]);
  pool.add("h2", "0,0", [slot(2)]);
  pool.add("h3", "0,0", [slot(3)]);

  pool.update(["0,0"]);

  const attr = attrOf(scene);
  assertEquals(meshOf(scene).count, 3);
  assertEquals(attr.updateRanges.length, 1, "one coalesced range covering the live span");
  assertEquals(attr.updateRanges[0].start, 0);
  assertEquals(attr.updateRanges[0].count, 3 * 16, "3 instances × 16 floats — not 4096 × 16 (the full backing array)");
});

Deno.test("update: a fully static frame uploads NOTHING (attribute version unchanged) and keeps last frame's count", () => {
  const { pool, scene } = newPool();
  pool.add("h1", "0,0", [slot(1)]);
  pool.update(["0,0"]);

  const attr = attrOf(scene);
  const versionAfterFirst = attr.version;
  assertEquals(meshOf(scene).count, 1);

  // 100 static frames: same handles, same visibility.
  for (let i = 0; i < 100; i++) pool.update(["0,0"]);

  assertEquals(attr.version, versionAfterFirst, "no needsUpdate ⇒ the renderer performs zero bufferSubData for static frames");
  assertEquals(meshOf(scene).count, 1, "count survives untouched across skipped frames");
});

Deno.test("update: adding / removing a handle dirties its archetype and re-uploads the new live span", () => {
  const { pool, scene } = newPool();
  pool.add("h1", "0,0", [slot(1)]);
  pool.update(["0,0"]);
  const attr = attrOf(scene);
  const v1 = attr.version;

  pool.add("h2", "0,0", [slot(2)]);
  pool.update(["0,0"]);
  assert(attr.version > v1, "add() must trigger a re-upload");
  assertEquals(meshOf(scene).count, 2);
  assertEquals(attr.updateRanges[0].count, 2 * 16);

  const v2 = attr.version;
  pool.remove("h1");
  pool.update(["0,0"]);
  assert(attr.version > v2, "remove() must trigger a re-upload");
  assertEquals(meshOf(scene).count, 1);
  assertEquals(attr.updateRanges[0].count, 1 * 16);
});

Deno.test("update: a visibility change dirties every archetype (chunk enters/leaves the window)", () => {
  const { pool, scene } = newPool();
  pool.add("near", "0,0", [slot(1)]);
  pool.add("far", "5,5", [slot(2)]);
  pool.update(["0,0"]);
  assertEquals(meshOf(scene).count, 1, "only the visible chunk's instance draws");
  const v1 = attrOf(scene).version;

  pool.update(["0,0", "5,5"]);
  assert(attrOf(scene).version > v1, "widening the visible set must rewrite");
  assertEquals(meshOf(scene).count, 2);

  pool.update(["5,5"]);
  assertEquals(meshOf(scene).count, 1, "narrowing drops the now-hidden instance");
});

Deno.test("update: an archetype emptied by visibility keeps count=0 with no upload needed", () => {
  const { pool, scene } = newPool();
  pool.add("h1", "0,0", [slot(1)]);
  pool.update(["0,0"]);
  assertEquals(meshOf(scene).count, 1);

  pool.update(["9,9"]); // handle's chunk no longer visible
  assertEquals(meshOf(scene).count, 0, "count=0 ⇒ nothing draws; the stale buffer tail is unreachable");
});

Deno.test("update: replacing a handle whose new slots drop an archetype still rewrites the dropped archetype", () => {
  const { pool, scene } = newPool();
  const scene2Arch = "arch2";
  pool.registerArchetype(scene2Arch, {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    material: new THREE.MeshBasicMaterial(),
    castShadow: false,
    receiveShadow: false,
  });
  pool.add("h1", "0,0", [slot(1), { archetypeId: scene2Arch, matrix: new THREE.Matrix4() }]);
  pool.update(["0,0"]);
  const mesh2 = scene.getObjectByName(scene2Arch) as THREE.InstancedMesh;
  assertEquals(mesh2.count, 1);

  // Re-add drawing ONLY into "arch" — arch2's instance must disappear.
  pool.add("h1", "0,0", [slot(1)]);
  pool.update(["0,0"]);
  assertEquals(mesh2.count, 0, "the outgoing slot list's archetypes are dirtied on replacement");
  assertEquals(meshOf(scene).count, 1);
});
