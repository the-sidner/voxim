/**
 * dissolve_shader smoke tests (T-311 P5c). No WebGL context available in
 * `deno test` — these pin the parts that don't need one: the patch composes
 * with a pre-existing `onBeforeCompile` (chains, doesn't clobber), the
 * uniform bundle is a fresh object per call (per-entity, not shared like
 * canopy_fade's module-level uniforms), and the patched shader carries the
 * expected attribute/uniform declarations + the begin_vertex injection.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { registerDissolveDrift } from "./dissolve_shader.ts";

/** Minimal fake of the object Three.js passes to onBeforeCompile. */
function fakeShader(): { vertexShader: string; uniforms: Record<string, unknown> } {
  return {
    vertexShader: "void main() {\n  #include <begin_vertex>\n  gl_Position = vec4(transformed, 1.0);\n}",
    uniforms: {},
  };
}

Deno.test("registerDissolveDrift: returns a fresh uniform bundle per call (per-entity, not shared)", () => {
  const matA = new THREE.MeshPhongMaterial();
  const matB = new THREE.MeshPhongMaterial();
  const uA = registerDissolveDrift(matA, 1.4);
  const uB = registerDissolveDrift(matB, 1.4);
  assert(uA !== uB, "distinct materials get distinct uniform bundles");
  assert(uA.uPhase !== uB.uPhase, "distinct .value containers — mutating one must not affect the other");
  uA.uPhase.value = 0.7;
  assertEquals(uB.uPhase.value, 0, "bundle B is untouched by bundle A's phase push");
});

Deno.test("registerDissolveDrift: seeds uDriftDistance from the profile's maxSeparationDistance cap", () => {
  const mat = new THREE.MeshPhongMaterial();
  const u = registerDissolveDrift(mat, 2.5);
  assertEquals(u.uDriftDistance.value, 2.5);
  assertEquals(u.uPhase.value, 0, "starts intact");
});

Deno.test("registerDissolveDrift: chains a pre-existing onBeforeCompile instead of replacing it", () => {
  const mat = new THREE.MeshPhongMaterial();
  let prevCalled = false;
  mat.onBeforeCompile = () => { prevCalled = true; };
  registerDissolveDrift(mat, 1.4);

  const shader = fakeShader();
  // deno-lint-ignore no-explicit-any
  (mat.onBeforeCompile as any)(shader, {});
  assert(prevCalled, "the pre-existing onBeforeCompile must still run");
});

Deno.test("registerDissolveDrift: patches the vertex shader with the attribute/uniform declarations + begin_vertex offset", () => {
  const mat = new THREE.MeshPhongMaterial();
  registerDissolveDrift(mat, 1.4);

  const shader = fakeShader();
  // deno-lint-ignore no-explicit-any
  (mat.onBeforeCompile as any)(shader, {});

  assert(shader.vertexShader.includes("attribute float aFray;"), "declares aFray");
  assert(shader.vertexShader.includes("attribute vec3  aDriftDir;"), "declares aDriftDir");
  assert(shader.vertexShader.includes("uniform float uDissolvePhase;"), "declares the phase uniform");
  assert(shader.vertexShader.includes("uniform float uDriftDistance;"), "declares the drift-distance uniform");
  assert(
    shader.vertexShader.includes("transformed += aDriftDir * aFray * uDissolvePhase * uDriftDistance;"),
    "offsets `transformed` right after #include <begin_vertex> — geometry/normals otherwise untouched",
  );
  assert(shader.uniforms.uDissolvePhase, "wires the phase uniform onto the compiled shader");
  assert(shader.uniforms.uDriftDistance, "wires the drift-distance uniform onto the compiled shader");
});
