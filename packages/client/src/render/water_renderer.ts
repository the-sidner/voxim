/// <reference lib="dom" />
/**
 * WaterRenderer — translucent water surface over river cells (T-159).
 *
 * Atlas marks rivers/ponds with `BOUNDARY_KIND_WATER` and lowers their
 * heightmap by `RIVER_DEPTH` (see atlas/.../terrain.ts).  This renderer
 * draws a thin translucent surface back at the original floor height for
 * every WATER cell on a chunk, giving rivers the look of "trench filled
 * with water" rather than "weirdly flat blue cells".
 *
 * One shared `THREE.ShaderMaterial` for all chunks.  A simple sin/cos
 * fragment shader animates the surface — it's not literal physics, just
 * enough motion to read as water at game speed.  `tick(now)` from the
 * render loop bumps the `uTime` uniform.
 *
 * The renderer subscribes to `ClientWorld.onChunkKinds` (same hook the
 * forest props use) and pulls the heightmap out of `ClientWorld` at the
 * same time.  If kindGrid arrives before heightmap, decoration is queued
 * and replayed on the next tick.
 */
import * as THREE from "three";
import type { ClientWorld } from "../state/client_world.ts";

const CHUNK_SIDE = 32;

/** Mirror of atlas's BOUNDARY_KIND_WATER; literal keeps atlas out of the bundle. */
const BOUNDARY_KIND_WATER = 3;

/**
 * How far below floor the WATER channel is cut by atlas's terrain stage.
 * Mirror of `atlas/.../terrain.ts:RIVER_DEPTH` — keep them in sync when tuning.
 * The water surface mesh sits at `heightmap[cell] + RIVER_DEPTH` so it
 * lands at the original floor height, just above the trenched bed.
 */
const RIVER_DEPTH = 0.5;

const VERT = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vWorldPos;
  uniform float uTime;
  uniform vec3  uShallow;     // shallow-water tint (sRGB-ish)
  uniform vec3  uDeep;        // deep-water tint
  uniform float uOpacity;

  void main() {
    // Two crossed travelling-wave bands give a subtle "rippling" feel.
    // Low frequency, low amplitude — at game speed it reads as water without
    // looking like a busy swimming-pool tile.
    float w1 = sin(vWorldPos.x * 0.6 + uTime * 0.9);
    float w2 = sin(vWorldPos.z * 0.55 - uTime * 0.7);
    float w3 = sin((vWorldPos.x + vWorldPos.z) * 0.3 + uTime * 0.45);
    float band = (w1 + w2 + w3) / 3.0;            // [-1, 1]
    float lum  = 0.5 + 0.5 * band;                // [0, 1]

    // Sparse highlights on the wave crests — sharpen with smoothstep so we
    // don't get a uniform glow.
    float sparkle = smoothstep(0.85, 0.97, lum);

    vec3 col = mix(uDeep, uShallow, lum);
    col += sparkle * 0.4;

    gl_FragColor = vec4(col, uOpacity);
  }
`;

function buildWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime:    { value: 0 },
      uShallow: { value: new THREE.Color(0x9ad8e8) },
      uDeep:    { value: new THREE.Color(0x1a4080) },
      uOpacity: { value: 0.62 },
    },
    transparent: true,
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });
}

/**
 * Build a flat quad-mesh covering every WATER cell in the chunk.  Returns
 * null if the chunk contains no water cells (most do).
 */
function buildWaterGeo(
  chunkX: number,
  chunkY: number,
  heights: Float32Array,
  kinds: Uint16Array,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const indices:   number[] = [];
  let vBase = 0;

  const offX = chunkX * CHUNK_SIDE;
  const offZ = chunkY * CHUNK_SIDE;

  for (let ly = 0; ly < CHUNK_SIDE; ly++) {
    for (let lx = 0; lx < CHUNK_SIDE; lx++) {
      const idx = lx + ly * CHUNK_SIDE;
      if (kinds[idx] !== BOUNDARY_KIND_WATER) continue;

      // Surface sits at the original floor — `heights` carries the trenched
      // bed (`floor - RIVER_DEPTH`), so we add the depth back.
      const y = heights[idx] + RIVER_DEPTH;

      const wx0 = offX + lx,     wx1 = offX + lx + 1;
      const wz0 = offZ + ly,     wz1 = offZ + ly + 1;

      positions.push(
        wx0, y, wz0,
        wx1, y, wz0,
        wx0, y, wz1,
        wx1, y, wz1,
      );
      indices.push(vBase, vBase + 2, vBase + 1, vBase + 1, vBase + 2, vBase + 3);
      vBase += 4;
    }
  }

  if (vBase === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geo.computeVertexNormals();
  return geo;
}

export class WaterRenderer {
  private readonly scene: THREE.Scene;
  private readonly world: ClientWorld;
  private readonly material = buildWaterMaterial();
  private readonly chunkMeshes = new Map<string, THREE.Mesh>();
  /** Chunks where kindGrid arrived but heightmap hadn't yet. Replayed on tick. */
  private readonly pending = new Map<string, Uint16Array>();

  constructor(scene: THREE.Scene, world: ClientWorld) {
    this.scene = scene;
    this.world = world;
    world.onChunkKinds((coord, kinds) => this.onKinds(coord, kinds));
  }

  /** Called every frame from the render loop to advance the wave animation. */
  tick(nowMs: number): void {
    this.material.uniforms.uTime.value = nowMs * 0.001;

    // Drain any chunks waiting on their heightmap.
    if (this.pending.size > 0) {
      for (const [coord, kinds] of [...this.pending]) {
        if (this.tryBuild(coord, kinds)) this.pending.delete(coord);
      }
    }
  }

  /** Drop every water mesh — used on tile transitions. */
  clear(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.pending.clear();
  }

  private onKinds(coord: string, kinds: Uint16Array): void {
    if (this.chunkMeshes.has(coord)) return;
    if (!this.tryBuild(coord, kinds)) {
      this.pending.set(coord, kinds);
    }
  }

  /** Returns true on success.  False means heightmap not yet available. */
  private tryBuild(coord: string, kinds: Uint16Array): boolean {
    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));
    const heights = this.world.getHeightmapData(cx, cy);
    if (!heights) return false;

    const geo = buildWaterGeo(cx, cy, heights, kinds);
    if (!geo) {
      // No water cells in this chunk — nothing to render, but mark as "done"
      // so we don't keep retrying on every tick.
      this.chunkMeshes.set(coord, new THREE.Mesh());
      return true;
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Render after opaque terrain so blending sees the bed below.
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.chunkMeshes.set(coord, mesh);
    return true;
  }
}
