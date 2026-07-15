/// <reference lib="dom" />
/**
 * WaterRenderer — translucent water surface over WaterGrid cells (T-159,
 * rebuilt T-311 P5b).
 *
 * `WaterGrid.surfaceLevel` (a networked chunk component, T-311 P3) is the
 * SINGLE source of water height: a per-cell f32, NaN = no water, already
 * carrying the atlas-baked final surface height (floor + RIVER_DEPTH — see
 * packages/atlas/src/tilemap/pipeline/fields.ts). This renderer no longer
 * derives water from KindGrid + a client-mirrored depth constant, and no
 * longer carries pending/tryBuild wait machinery — `onChunkReady` already
 * guarantees the full grid set (incl. waterGrid) is bound by the time the
 * hook fires, so there is nothing left to wait for. Old saves predating
 * T-311 P3 may still lack the grid entirely (`chunk.waterGrid` stays
 * `undefined`) — that's the one null-check this file keeps.
 *
 * One shared `THREE.ShaderMaterial` for all chunks, styled by the current
 * `WaterStyleDef` (T-311 P5b) selected via `WorldClock.biomeTag` — the same
 * render-context key AtmosphereDef uses. A simple sin/cos fragment shader
 * animates the surface — it's not literal physics, just enough motion to
 * read as water at game speed. `tick(now)` from the render loop bumps the
 * `uTime` uniform and re-checks the active style.
 *
 * The geometry is built in three-space directly (chunkY maps straight to
 * three.js Z — no model/world axis swap, unlike terrain_voxels.ts's offZ).
 * Contiguous non-NaN cells in a row merge into a single quad run (a simple
 * greedy row-run merge — most water bodies are wide, so this meaningfully
 * cuts vertex count without a full mesh simplifier).
 */
import * as THREE from "three";
import { CHUNK_SIZE } from "@voxim/world";
import type { ContentService, WaterStyleDef } from "@voxim/content";
import type { ClientWorld, ClientChunk } from "../state/client_world.ts";

const VERT = /* glsl */`
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    // cameraPosition is a guaranteed built-in in the VERTEX prefix (not always the
    // fragment one) — compute the view vector here and pass it through.
    vViewDir = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  uniform float uTime;
  uniform vec3  uShallow;     // shallow-water tint (sRGB-ish)
  uniform vec3  uDeep;        // deep-water tint
  uniform float uOpacity;
  uniform vec3  uSunDir;      // normalized, toward the sun (EnvironmentLighting, the single sun owner)
  uniform vec3  uWaveAmplitude;
  uniform vec3  uWaveFreqX;
  uniform vec3  uWaveFreqZ;
  uniform vec3  uWaveSpeed;
  uniform float uNormalScale;
  uniform float uLumDivisor;
  uniform float uFresnelExponent;
  uniform float uFresnelTint;
  uniform float uFresnelOpacityBoost;
  uniform float uSpecularExponent;
  uniform vec3  uSpecularGain;
  uniform vec3  uSkyColor;   // current lerped sky colour (EnvironmentLighting, T-311 P5b)

  void main() {
    // Travelling-wave height field + its analytic gradient → a perturbed surface
    // normal. Drives both the deep↔shallow tint and a moving specular so the
    // water glints instead of sitting as a flat colour band. Three additive
    // sine terms, WaterStyleDef-authored (T-311 P5b).
    float t = uTime;
    float h =
        uWaveAmplitude.x * sin(uWaveFreqX.x * vWorldPos.x + uWaveFreqZ.x * vWorldPos.z + uWaveSpeed.x * t)
      + uWaveAmplitude.y * sin(uWaveFreqX.y * vWorldPos.x + uWaveFreqZ.y * vWorldPos.z + uWaveSpeed.y * t)
      + uWaveAmplitude.z * sin(uWaveFreqX.z * vWorldPos.x + uWaveFreqZ.z * vWorldPos.z + uWaveSpeed.z * t);
    float dhdx =
        uWaveAmplitude.x * uWaveFreqX.x * cos(uWaveFreqX.x * vWorldPos.x + uWaveFreqZ.x * vWorldPos.z + uWaveSpeed.x * t)
      + uWaveAmplitude.y * uWaveFreqX.y * cos(uWaveFreqX.y * vWorldPos.x + uWaveFreqZ.y * vWorldPos.z + uWaveSpeed.y * t)
      + uWaveAmplitude.z * uWaveFreqX.z * cos(uWaveFreqX.z * vWorldPos.x + uWaveFreqZ.z * vWorldPos.z + uWaveSpeed.z * t);
    float dhdz =
        uWaveAmplitude.x * uWaveFreqZ.x * cos(uWaveFreqX.x * vWorldPos.x + uWaveFreqZ.x * vWorldPos.z + uWaveSpeed.x * t)
      + uWaveAmplitude.y * uWaveFreqZ.y * cos(uWaveFreqX.y * vWorldPos.x + uWaveFreqZ.y * vWorldPos.z + uWaveSpeed.y * t)
      + uWaveAmplitude.z * uWaveFreqZ.z * cos(uWaveFreqX.z * vWorldPos.x + uWaveFreqZ.z * vWorldPos.z + uWaveSpeed.z * t);
    vec3 N = normalize(vec3(-dhdx * uNormalScale, 1.0, -dhdz * uNormalScale));
    vec3 V = normalize(vViewDir);

    float lum = clamp(0.5 + 0.5 * (h / uLumDivisor), 0.0, 1.0);
    vec3 col = mix(uDeep, uShallow, lum);

    // Fresnel: grazing angles lighten toward the bright shallow tint — the
    // bright-rim read that says "water surface", not "blue floor".
    float fres = pow(1.0 - max(dot(N, V), 0.0), uFresnelExponent);
    col = mix(col, uShallow * 1.3, fres * uFresnelTint);

    // Sun glint (Blinn) on the perturbed normal — a tight HDR highlight that the
    // bloom pass turns into glittering sparkle on the crests.
    //
    // Gating by dot(N,H)^exponent alone is not enough to confine the glint to
    // crests: when the sun sits near zenith AND the camera looks down steeply
    // (both true at noon with this game's ~55°-pitch free-look camera), the
    // half-vector H lands close to vertical everywhere, and normalScale only
    // tilts N a few degrees even at max wave height — so dot(N,H) stays high
    // across nearly the WHOLE surface, not just the peaks, and the "highlight"
    // becomes a flat near-white wash (the porcelain-water bug, T-311 P5b fix).
    // lum (already the 0..1 wave-height proxy driving the deep<->shallow
    // tint) is a camera/sun-independent measure of "how close to a crest this
    // texel is" — smoothstep it so the glint only switches on near actual
    // peaks, regardless of viewing/sun geometry.
    float crest = smoothstep(0.75, 0.97, lum);
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), uSpecularExponent) * crest;
    col += spec * uSpecularGain;

    // Cheap sky-streak reflection (T-311 P5b, no probe/SSR): the view
    // vector reflected off the perturbed normal, tinted by the current sky
    // colour and weighted by the SAME fresnel rim already driving the
    // shallow-tint lightening — a stretched streak at grazing angles that
    // reads as "reflecting the sky" (the image-gen-3 torch-streak look)
    // without any render-to-texture machinery.
    vec3 R = reflect(-V, N);
    float skyWeight = fres * max(R.y, 0.0);
    col += uSkyColor * skyWeight * 0.5;

    float alpha = clamp(uOpacity + fres * uFresnelOpacityBoost, 0.0, 0.96);
    gl_FragColor = vec4(col, alpha);
  }
`;

function buildWaterMaterial(style: WaterStyleDef): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime:    { value: 0 },
      uShallow: { value: new THREE.Color(0) },
      uDeep:    { value: new THREE.Color(0) },
      uOpacity: { value: 0 },
      // EnvironmentLighting is the single sun owner (T-311 P5a) — no local
      // default; renderer.ts calls setSunDirection() once per frame.
      uSunDir:  { value: new THREE.Vector3(0, 1, 0) },
      uWaveAmplitude: { value: new THREE.Vector3() },
      uWaveFreqX:     { value: new THREE.Vector3() },
      uWaveFreqZ:     { value: new THREE.Vector3() },
      uWaveSpeed:     { value: new THREE.Vector3() },
      uNormalScale:   { value: 0 },
      uLumDivisor:    { value: 1 },
      uFresnelExponent:     { value: 0 },
      uFresnelTint:         { value: 0 },
      uFresnelOpacityBoost: { value: 0 },
      uSpecularExponent:    { value: 0 },
      uSpecularGain:        { value: new THREE.Vector3() },
      // Sky colour for the cheap reflection streak (T-311 P5b) — no local
      // default; renderer.ts calls setSkyColor() once per frame with
      // EnvironmentLighting's live lerped sky colour.
      uSkyColor:            { value: new THREE.Color(0x808080) },
    },
    transparent: true,
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });
  applyWaterStyle(mat, style);
  return mat;
}

/** Push a WaterStyleDef's fields onto an already-built material's uniforms. */
function applyWaterStyle(mat: THREE.ShaderMaterial, style: WaterStyleDef): void {
  const u = mat.uniforms;
  (u.uShallow.value as THREE.Color).set(style.shallowColor);
  (u.uDeep.value as THREE.Color).set(style.deepColor);
  u.uOpacity.value = style.opacity;
  (u.uWaveAmplitude.value as THREE.Vector3).fromArray(style.waves.amplitude);
  (u.uWaveFreqX.value as THREE.Vector3).fromArray(style.waves.frequencyX);
  (u.uWaveFreqZ.value as THREE.Vector3).fromArray(style.waves.frequencyZ);
  (u.uWaveSpeed.value as THREE.Vector3).fromArray(style.waves.speed);
  u.uNormalScale.value = style.waves.normalScale;
  u.uLumDivisor.value = style.waves.lumDivisor;
  u.uFresnelExponent.value = style.fresnel.exponent;
  u.uFresnelTint.value = style.fresnel.tintStrength;
  u.uFresnelOpacityBoost.value = style.fresnel.opacityBoost;
  u.uSpecularExponent.value = style.specular.exponent;
  (u.uSpecularGain.value as THREE.Vector3).fromArray(style.specular.gain);
}

/**
 * Build a mesh covering every non-NaN WaterGrid cell in the chunk, merging
 * contiguous same-row runs into single quads (a simple greedy row-run merge
 * — most water bodies are wide horizontal spans, so this meaningfully cuts
 * vertex count without a full mesh simplifier). Returns null if the chunk
 * has no water cells (most don't). Exported for unit testing (pure geometry,
 * no scene/material dependency).
 */
export function buildWaterGeo(
  chunkX: number,
  chunkY: number,
  surfaceLevel: Float32Array,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const indices:   number[] = [];
  let vBase = 0;

  const offX = chunkX * CHUNK_SIZE;
  const offZ = chunkY * CHUNK_SIZE; // already three.js Z directly — this geometry is built in three-space, no model/world swap pending (cf. terrain_voxels.ts's offZ, which is model-Y pre-swap).

  const addQuad = (wx0: number, wx1: number, wz0: number, wz1: number, y: number) => {
    positions.push(
      wx0, y, wz0,
      wx1, y, wz0,
      wx0, y, wz1,
      wx1, y, wz1,
    );
    indices.push(vBase, vBase + 2, vBase + 1, vBase + 1, vBase + 2, vBase + 3);
    vBase += 4;
  };

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    let runStart = -1;
    let runLevel = NaN;
    for (let lx = 0; lx <= CHUNK_SIZE; lx++) {
      const level = lx < CHUNK_SIZE ? surfaceLevel[lx + ly * CHUNK_SIZE] : NaN;
      const isWater = !Number.isNaN(level);
      // Extend the run only while the level matches exactly (same surface
      // height) — a merged quad must be flat, matching the per-cell source.
      if (runStart >= 0 && (!isWater || level !== runLevel)) {
        const wx0 = offX + runStart, wx1 = offX + lx;
        const wz0 = offZ + ly,       wz1 = offZ + ly + 1;
        addQuad(wx0, wx1, wz0, wz1, runLevel);
        runStart = -1;
      }
      if (isWater && runStart < 0) {
        runStart = lx;
        runLevel = level;
      }
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
  private readonly content: ContentService | null;
  private readonly material: THREE.ShaderMaterial;
  private readonly chunkMeshes = new Map<string, THREE.Mesh>();
  /** Style id currently applied — re-checked against the live
   *  WorldClock.biomeTag each tick (T-311 P5b), same idiom
   *  renderer.ts uses for AtmosphereDef selection. */
  private appliedStyleId: string | null = null;

  constructor(scene: THREE.Scene, world: ClientWorld, content: ContentService | null) {
    this.scene = scene;
    this.world = world;
    this.content = content;
    const initialStyle = content?.waterStyles.get("default");
    this.material = buildWaterMaterial(
      initialStyle ?? {
        id: "default", shallowColor: "#3f5a5c", deepColor: "#1c3038", opacity: 0.62,
        waves: {
          amplitude: [1, 1, 0.6], frequencyX: [0.6, 0, 0.9], frequencyZ: [0, 0.55, 0.9],
          speed: [0.9, -0.7, 1.7], normalScale: 0.14, lumDivisor: 2.6,
        },
        fresnel: { exponent: 3, tintStrength: 0.6, opacityBoost: 0.3 },
        specular: { exponent: 80, gain: [1.9, 1.7, 1.3] },
      },
    );
    if (initialStyle) this.appliedStyleId = "default";

    world.onChunkReady((coord, chunk) => {
      if (chunk.waterGrid) this.buildChunk(coord, chunk);
    });
  }

  /** Called every frame from the render loop: advances the wave animation and
   *  re-selects the water style off the live biomeTag (cheap Map lookup). */
  tick(nowMs: number): void {
    this.material.uniforms.uTime.value = nowMs * 0.001;

    const biomeTag = this.world.getWorldClock()?.biomeTag;
    if (this.content && biomeTag && biomeTag !== this.appliedStyleId) {
      const style = this.content.waterStyles.get(biomeTag) ?? this.content.waterStyles.get("default");
      if (style) {
        applyWaterStyle(this.material, style);
        this.appliedStyleId = biomeTag;
      }
    }
  }

  /** Read the shared sun direction from EnvironmentLighting (the single sun
   *  owner, T-311 P5a) instead of carrying a local constant. Called once per
   *  frame from game.ts (plain {x,y,z} — game.ts stays THREE-free), after
   *  renderer.render() has updated envLighting. */
  setSunDirection(dir: { x: number; y: number; z: number }): void {
    (this.material.uniforms.uSunDir.value as THREE.Vector3).set(dir.x, dir.y, dir.z);
  }

  /** Read the current lerped sky colour from EnvironmentLighting (T-311
   *  P5b) — drives the cheap sky-streak reflection term. Called once per
   *  frame from game.ts (plain 0xRRGGBB number — game.ts stays THREE-free). */
  setSkyColor(hex: number): void {
    (this.material.uniforms.uSkyColor.value as THREE.Color).setHex(hex);
  }

  /** Drop every water mesh — used on tile transitions. */
  clear(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
  }

  private buildChunk(coord: string, chunk: ClientChunk): void {
    if (this.chunkMeshes.has(coord) || !chunk.waterGrid) return;
    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));

    const geo = buildWaterGeo(cx, cy, chunk.waterGrid.surfaceLevel);
    if (!geo) {
      // No water cells in this chunk — nothing to render, but mark as "done"
      // so we don't rebuild on a later delta touching the same coord.
      this.chunkMeshes.set(coord, new THREE.Mesh());
      return;
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Render after opaque terrain so blending sees the bed below.
    mesh.renderOrder = 1;
    mesh.name = "water";
    this.scene.add(mesh);
    this.chunkMeshes.set(coord, mesh);
  }
}
