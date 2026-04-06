/**
 * Builds a Three.js Mesh from a chunk's heightmap and material grid.
 *
 * Heightmap semantics: heightmap[cx, cy] is the height of CELL (cx, cy) — the
 * flat surface that covers world square [offX+cx, offX+cx+1] × [offZ+cy, offZ+cy+1].
 * This is NOT a vertex height; it defines the top face of the cell as a flat quad.
 *
 * Coordinate mapping (world → Three.js):
 *   world.x → three.x   (east)
 *   world.z → three.y   (up / height)
 *   world.y → three.z   (south/depth)
 *
 * Geometry:
 *   - Each cell contributes a flat top quad at height h[cx,cy].
 *   - Interior East/South edges with differing heights get a vertical wall quad.
 *   - No gaps between adjacent chunks: cell (31,cy) ends at world x = offX+32,
 *     which is exactly where the neighbouring chunk's cell (0,cy) begins.
 *   - DoubleSide material so walls are visible from both sides (no winding concerns).
 *   - Every vertex is displaced by vertexDisp() keyed on its world position.
 *     Shared boundary vertices between chunks always hash to the same offset,
 *     so there are never cracks or seams at chunk edges.
 */
import * as THREE from "three";
import type { HeightmapData, MaterialGridData } from "@voxim/codecs";
import { vertexDisp } from "./displacement.ts";

const CHUNK = 32;

/** ±10 % of voxel face width — spec open question, tunable here. */
const DISP_MAG = 0.10;

// Material ID → RGB hex (matches generator.ts zone assignments)
const MAT_COLORS: Record<number, number> = {
  0: 0x111111, // void / air
  1: 0x4a7c3f, // grass
  2: 0x6b6b6b, // (unused, default stone)
  3: 0x888888, // stone
  4: 0x7a4f2a, // dirt
  5: 0xc2a05e, // sand
  6: 0x555555, // dark stone
  7: 0x333333, // deep stone
  8: 0x2244cc, // water
};

function colorForMat(id: number): THREE.Color {
  return new THREE.Color(MAT_COLORS[id] ?? 0x888888);
}

/**
 * Per-cell brightness micro-variation — the flat-shading equivalent of bump mapping.
 * Each cell gets a deterministic ±8 % brightness offset based on its world position,
 * breaking up the uniform look of large same-material areas without adding geometry.
 * Returns a multiplier in [0.92, 1.08].
 */
function cellVariation(wx: number, wz: number): number {
  let h = Math.imul(wx | 0, 0x9e3779b9) ^ Math.imul(wz | 0, 0x6c62272e);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return 0.92 + 0.16 * ((h >>> 0) / 0xffffffff);
}

/**
 * Build or rebuild the mesh for one chunk.
 * If `existing` is provided its geometry is disposed and replaced in-place.
 *
 * `neighborEast`  / `neighborEastMat`  — the chunk at (chunkX+1, chunkY). When
 * provided, east-edge wall quads bridging the chunk boundary are generated.
 * `neighborSouth` / `neighborSouthMat` — the chunk at (chunkX, chunkY+1).
 * Without these, boundary-cell height differences leave unsealed gaps.
 */
export function buildTerrainMesh(
  heightmap: HeightmapData,
  materials: MaterialGridData,
  existing?: THREE.Mesh,
  neighborEast?: HeightmapData | null,
  neighborEastMat?: MaterialGridData | null,
  neighborSouth?: HeightmapData | null,
  neighborSouthMat?: MaterialGridData | null,
): THREE.Mesh {
  const offX = heightmap.chunkX * CHUNK;
  const offZ = heightmap.chunkY * CHUNK;

  // Collect face data dynamically — number of wall quads varies with terrain.
  const posBuf: number[] = [];
  const colBuf: number[] = [];
  const idxBuf: number[] = [];
  let vBase = 0;

  /**
   * Emit a quad as two CCW triangles (v0,v2,v1) + (v1,v2,v3).
   * All four vertices share the same vertex color (r,g,b).
   */
  const quad = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    r: number, g: number, b: number,
  ) => {
    posBuf.push(x0, y0, z0,  x1, y1, z1,  x2, y2, z2,  x3, y3, z3);
    colBuf.push(r, g, b,  r, g, b,  r, g, b,  r, g, b);
    idxBuf.push(vBase, vBase+2, vBase+1,  vBase+1, vBase+2, vBase+3);
    vBase += 4;
  };

  const cellH   = (cx: number, cy: number) => heightmap.data[cx + cy * CHUNK];
  const cellCol = (cx: number, cy: number) => colorForMat(materials.data[cx + cy * CHUNK]);


  /**
   * Displace a world-space vertex and return the three spread-ready coordinates.
   *
   * Hash only on (x, z) — intentionally ignoring y.  Adjacent wall segments that
   * share an (x, z) boundary position but differ in height must agree on their
   * horizontal δx/δz, otherwise the seam between them opens into a visible crack.
   * No vertical displacement: terrain walls stay axis-aligned in y.
   */
  const dv = (x: number, y: number, z: number): [number, number, number] => {
    const [dx, , dz] = vertexDisp(x, 0, z, DISP_MAG);
    return [x + dx, y, z + dz];
  };

  for (let cy = 0; cy < CHUNK; cy++) {
    for (let cx = 0; cx < CHUNK; cx++) {
      const h   = cellH(cx, cy);
      const col = cellCol(cx, cy);

      const wx0 = offX + cx,  wx1 = offX + cx + 1;
      const wz0 = offZ + cy,  wz1 = offZ + cy + 1;

      // ---- top face (flat at cell height, vertices displaced by world pos) ----
      const cv = cellVariation(wx0, wz0);
      quad(
        ...dv(wx0, h, wz0),
        ...dv(wx1, h, wz0),
        ...dv(wx0, h, wz1),
        ...dv(wx1, h, wz1),
        col.r * cv, col.g * cv, col.b * cv,
      );

      // ---- East interior wall ----
      if (cx < CHUNK - 1) {
        const hE = cellH(cx + 1, cy);
        if (h !== hE) {
          const hLo = Math.min(h, hE), hHi = Math.max(h, hE);
          const wc  = h > hE ? col : cellCol(cx + 1, cy);
          const wcv = h > hE ? cv : cellVariation(wx1, wz0);
          quad(
            ...dv(wx1, hLo, wz0),
            ...dv(wx1, hLo, wz1),
            ...dv(wx1, hHi, wz0),
            ...dv(wx1, hHi, wz1),
            wc.r * wcv, wc.g * wcv, wc.b * wcv,
          );
        }
      }

      // ---- South interior wall ----
      if (cy < CHUNK - 1) {
        const hS = cellH(cx, cy + 1);
        if (h !== hS) {
          const hLo = Math.min(h, hS), hHi = Math.max(h, hS);
          const wc  = h > hS ? col : cellCol(cx, cy + 1);
          const wcv = h > hS ? cv : cellVariation(wx0, wz1);
          quad(
            ...dv(wx0, hLo, wz1),
            ...dv(wx1, hLo, wz1),
            ...dv(wx0, hHi, wz1),
            ...dv(wx1, hHi, wz1),
            wc.r * wcv, wc.g * wcv, wc.b * wcv,
          );
        }
      }
    }
  }

  // ---- East chunk-boundary walls (cx = CHUNK-1 edge, neighbor at cx = 0) ----
  if (neighborEast && neighborEastMat) {
    for (let cy = 0; cy < CHUNK; cy++) {
      const h  = cellH(CHUNK - 1, cy);
      const hE = neighborEast.data[0 + cy * CHUNK];
      if (h !== hE) {
        const wx1 = offX + CHUNK;
        const wz0 = offZ + cy, wz1 = offZ + cy + 1;
        const hLo = Math.min(h, hE), hHi = Math.max(h, hE);
        const col = cellCol(CHUNK - 1, cy);
        const colE = colorForMat(neighborEastMat.data[0 + cy * CHUNK]);
        const wc  = h > hE ? col : colE;
        const wcv = h > hE ? cellVariation(offX + CHUNK - 1, offZ + cy)
                           : cellVariation(offX + CHUNK,     offZ + cy);
        quad(
          ...dv(wx1, hLo, wz0),
          ...dv(wx1, hLo, wz1),
          ...dv(wx1, hHi, wz0),
          ...dv(wx1, hHi, wz1),
          wc.r * wcv, wc.g * wcv, wc.b * wcv,
        );
      }
    }
  }

  // ---- South chunk-boundary walls (cy = CHUNK-1 edge, neighbor at cy = 0) ----
  if (neighborSouth && neighborSouthMat) {
    for (let cx = 0; cx < CHUNK; cx++) {
      const h  = cellH(cx, CHUNK - 1);
      const hS = neighborSouth.data[cx + 0 * CHUNK];
      if (h !== hS) {
        const wx0 = offX + cx, wx1 = offX + cx + 1;
        const wz1 = offZ + CHUNK;
        const hLo = Math.min(h, hS), hHi = Math.max(h, hS);
        const col = cellCol(cx, CHUNK - 1);
        const colS = colorForMat(neighborSouthMat.data[cx + 0 * CHUNK]);
        const wc  = h > hS ? col : colS;
        const wcv = h > hS ? cellVariation(offX + cx, offZ + CHUNK - 1)
                           : cellVariation(offX + cx, offZ + CHUNK);
        quad(
          ...dv(wx0, hLo, wz1),
          ...dv(wx1, hLo, wz1),
          ...dv(wx0, hHi, wz1),
          ...dv(wx1, hHi, wz1),
          wc.r * wcv, wc.g * wcv, wc.b * wcv,
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(posBuf), 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(new Float32Array(colBuf), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idxBuf), 1));
  geo.computeVertexNormals();

  // DoubleSide: walls must be visible from either side without winding concerns.
  // flatShading uses dFdx/dFdy + gl_FrontFacing, so normals are correct on both faces.
  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading:  true,
    shininess:    0,
    side:         THREE.DoubleSide,
  });

  if (existing) {
    existing.geometry.dispose();
    existing.geometry = geo;
    (existing.material as THREE.Material).dispose();
    existing.material = mat;
    existing.castShadow    = true;
    existing.receiveShadow = true;
    return existing;
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  return mesh;
}
