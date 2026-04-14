/**
 * Inverted-hull outline pass for voxel entities.
 *
 * Each entity mesh (placeholder, voxel, skeleton part) gets an outline child:
 * the same geometry rendered BackSide with vertices pushed outward along
 * *smoothed* normals.  Smoothing is necessary because BoxGeometry splits each
 * corner into three vertices (one per face normal).  Averaging all normals at
 * the same position produces a diagonal outward vector that seals corners
 * during hull expansion.
 *
 * Usage:
 *   const outline = makeOutlineMesh(sourceGeo);
 *   sourceMesh.add(outline); // child → inherits transform, removed with parent
 *
 * Disposal:
 *   Never dispose OUTLINE_MAT or cached outline geometries — both are shared
 *   singletons.  In clearMeshContent, guard the material disposal traverse
 *   with `!obj.userData.isOutline`.
 */
import * as THREE from "three";

// ---- shader ----

const VERT = /* glsl */`
  attribute vec3 outlineNormal;
  uniform float thickness;

  void main() {
    // Expand in view space: normalMatrix handles non-uniform parent scale
    // so the outline width stays visually consistent from all angles.
    vec3 vNorm = normalize(normalMatrix * outlineNormal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    mvPos.xyz += vNorm * thickness;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 outlineColor;
  void main() {
    gl_FragColor = vec4(outlineColor, 1.0);
  }
`;

/**
 * Shared outline material — one WebGL program, used by every outline mesh.
 * Tune `thickness` (world-space units) and `outlineColor` here globally.
 */
export const OUTLINE_MAT = new THREE.ShaderMaterial({
  uniforms: {
    thickness:    { value: 0.08 },
    outlineColor: { value: new THREE.Color(0x0d0d0d) },
  },
  vertexShader:   VERT,
  fragmentShader: FRAG,
  side: THREE.BackSide,
});

/**
 * Hover variant — same shader, warm highlight color, slightly thicker.
 * Swapped onto outline meshes in place of OUTLINE_MAT when an entity is hovered.
 */
export const HOVER_OUTLINE_MAT = new THREE.ShaderMaterial({
  uniforms: {
    thickness:    { value: 0.12 },
    outlineColor: { value: new THREE.Color(0xf5e060) },
  },
  vertexShader:   VERT,
  fragmentShader: FRAG,
  side: THREE.BackSide,
});

// ---- geometry preparation ----

/**
 * Clone a geometry and add an `outlineNormal` attribute.
 * For each vertex, all vertex normals at the same position are averaged.
 * O(n²) but n ≤ 24 for a BoxGeometry, so this is negligible.
 */
function buildOutlineGeo(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = src.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geo.getAttribute("normal")   as THREE.BufferAttribute;
  const n   = pos.count;
  const out = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    let sx = 0, sy = 0, sz = 0;
    for (let j = 0; j < n; j++) {
      if (
        Math.abs(pos.getX(j) - px) < 1e-4 &&
        Math.abs(pos.getY(j) - py) < 1e-4 &&
        Math.abs(pos.getZ(j) - pz) < 1e-4
      ) {
        sx += nrm.getX(j);
        sy += nrm.getY(j);
        sz += nrm.getZ(j);
      }
    }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    out[i * 3]     = sx / len;
    out[i * 3 + 1] = sy / len;
    out[i * 3 + 2] = sz / len;
  }

  geo.setAttribute("outlineNormal", new THREE.BufferAttribute(out, 3));
  return geo;
}

/**
 * Cache: source geometry → outline geometry with outlineNormal attribute.
 * Keyed by object identity so shared geometries (GEO_VOXEL etc.) are only
 * processed once for the lifetime of the module.
 */
const _geoCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

// ---- public API ----

/**
 * Create an outline mesh for the given source geometry.
 *
 * Attach the result as a child of the source mesh — it will inherit the
 * source's transform and be automatically removed from the scene when
 * the source is removed.
 *
 *   sourceMesh.add(makeOutlineMesh(sourceMesh.geometry));
 */
export function makeOutlineMesh(src: THREE.BufferGeometry): THREE.Mesh {
  let outGeo = _geoCache.get(src);
  if (!outGeo) {
    outGeo = buildOutlineGeo(src);
    _geoCache.set(src, outGeo);
  }
  const mesh = new THREE.Mesh(outGeo, OUTLINE_MAT);
  mesh.userData.isOutline = true;
  return mesh;
}
