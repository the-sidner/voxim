/// <reference lib="dom" />
/**
 * T-313: far shadow-cascade composite — extends raking shadows past the near
 * sun's tight ±60u frustum (`environment_lighting.ts`'s `sun`). The ARPG
 * camera (especially the T-328 over-the-shoulder framing) sees well past
 * that frustum; everything beyond it fell back to a uniform, unshadowed
 * smear (no shadow data existed out there at all).
 *
 * Design: `environment_lighting.ts` owns a SECOND DirectionalLight
 * (`farCascade`) — wider frustum (±200u), coarser map (1024 vs 2048),
 * intensity 0 (it never lights anything directly; it exists purely so
 * Three's OWN shadow-map machinery renders its depth map for us, for free,
 * respecting every mesh's existing `castShadow`/`receiveShadow` flags
 * exactly the way the near sun's shadow already does — water, dust motes,
 * hit sparks, weapon trails already opt out of `castShadow` the same way
 * for the near cascade, so they're correctly excluded here too with zero
 * new filtering code). We do NOT let it contribute to material lighting
 * (that would double-light everything inside its frustum); instead THIS
 * pass reads its shadow map directly and does the darkening itself, as a
 * bespoke fullscreen-quad compositor — the same hand-rolled pattern as
 * BloomPass/GodRayPass, not a material-shader patch (T-310's invariant:
 * new passes extend the existing pipeline, they don't bolt library
 * machinery like three's CSM addon onto every material's shader chain).
 *
 * Runs BEFORE BloomPass/GodRayPass (not folded into EdgePass at the very
 * end) so the bright-pass + god-ray march both see the far-shadowed HDR
 * colour — canopy-gap light shafts shape correctly past the near cascade's
 * reach too, not just inside it (this is the god-ray "widen once the
 * cascade exists" follow-up god_ray_pass.ts's header names).
 *
 * The near cascade is left COMPLETELY untouched (still Three's built-in
 * per-material shadow, unchanged code path) — this pass only darkens pixels
 * OUTSIDE the near shadow's own tested frustum (a crossfade band keyed off
 * the near shadow's own UV margin), so there is no double-shadowing and no
 * hard seam at the ±60u boundary.
 */
import * as THREE from "three";

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// unpackRGBAToDepth + its constants are copied verbatim from Three's own
// packing.glsl.js (`UnpackFactors4`/`unpackRGBAToDepth`) — the exact inverse
// of `packDepthToRGBA`, which is what WebGLShadowMap's internal depth
// material writes into a light's shadow map for every non-VSM shadow type
// (confirmed against the pinned three@0.167.0 source). Must stay in step
// with Three's own packer, not a from-scratch reimplementation.
const CASCADE_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tFarShadowMap;
  uniform mat4  uProjInv;
  uniform mat4  uViewInv;
  uniform mat4  uNearShadowMatrix;
  uniform mat4  uFarShadowMatrix;
  uniform float uFarEnabled;   // 0 until the far cascade's first shadow-map render
  uniform float uDarken;       // multiplicative floor for far-shadowed pixels
  uniform float uFadeMargin;   // crossfade width, in the near shadow's own UV margin
  uniform float uFarBias;      // depth bias (mirrors Three's own shadowBias usage)

  const float UnpackDownscale = 255.0 / 256.0;
  const vec3  PackFactorsRGB  = vec3( 1.0, 256.0, 256.0 * 256.0 );
  const vec4  UnpackFactors4  = vec4( UnpackDownscale / PackFactorsRGB, 1.0 / ( 256.0 * 256.0 * 256.0 ) );
  float unpackRGBAToDepth( const in vec4 v ) { return dot( v, UnpackFactors4 ); }

  void main() {
    vec4 color = texture2D(tColor, vUv);
    float d = texture2D(tDepth, vUv).r;

    // Sky pixels (nothing to reconstruct) and "no far cascade yet" (the very
    // first frame, before Three has lazily created the shadow map) both
    // pass through unmodified.
    if (d >= 0.9999 || uFarEnabled < 0.5) { gl_FragColor = color; return; }

    vec4 ndc     = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 viewPos = uProjInv * ndc;
    viewPos     /= viewPos.w;
    vec4 world   = uViewInv * viewPos;

    // How deep inside the NEAR shadow's own tested frustum this pixel sits
    // (Three already shaded it correctly there, via the real per-material
    // shadow) — only cross-fade the far cascade in near/beyond that edge.
    vec4 nearCoord = uNearShadowMatrix * vec4(world.xyz, 1.0);
    nearCoord.xyz /= nearCoord.w;
    float nearMargin = min(min(nearCoord.x, 1.0 - nearCoord.x), min(nearCoord.y, 1.0 - nearCoord.y));
    float farWeight = 1.0 - smoothstep(0.0, uFadeMargin, nearMargin);
    if (farWeight <= 0.0) { gl_FragColor = color; return; }

    vec4 farCoord = uFarShadowMatrix * vec4(world.xyz, 1.0);
    farCoord.xyz /= farCoord.w;
    farCoord.z   += uFarBias;

    float lit = 1.0;
    if (farCoord.x >= 0.0 && farCoord.x <= 1.0 && farCoord.y >= 0.0 && farCoord.y <= 1.0 && farCoord.z <= 1.0) {
      float occluderDepth = unpackRGBAToDepth(texture2D(tFarShadowMap, farCoord.xy));
      lit = step(farCoord.z, occluderDepth);
    }

    float darken = mix(1.0, uDarken, (1.0 - lit) * farWeight);
    color.rgb *= darken;
    gl_FragColor = color;
  }
`;

export class ShadowCascadePass {
  private target: THREE.WebGLRenderTarget;
  private readonly mat: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly quad: THREE.Mesh;
  private readonly cam: THREE.OrthographicCamera;
  /** 1×1 placeholder so tFarShadowMap always has a bound texture — render()
   *  is called every frame from the very first one, before the far
   *  cascade's shadow map exists yet (Three creates it lazily on first
   *  use), and a null-valued sampler uniform at draw time is a real WebGL
   *  problem even inside an unreached shader branch (same reasoning as
   *  EdgePass's own tBloom/tGodRay blackTex placeholder). */
  private readonly placeholderShadowMap: THREE.DataTexture;

  constructor(width: number, height: number) {
    // Full-res, colour-only (no depth attachment — callers keep reading the
    // scene's own depthTexture for reconstruction; this target only ever
    // needs to feed BloomPass/GodRayPass/EdgePass a colour texture).
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.placeholderShadowMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this.placeholderShadowMap.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tFarShadowMap: { value: this.placeholderShadowMap },
        uProjInv: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uNearShadowMatrix: { value: new THREE.Matrix4() },
        uFarShadowMatrix: { value: new THREE.Matrix4() },
        uFarEnabled: { value: 0.0 },
        // Multiplicative floor for far-field shadowed pixels. This pass has
        // no notion of the direct-vs-ambient split the way Three's built-in
        // per-material shadow does (it darkens the ALREADY-composited
        // sun+hemi+rim colour post-hoc), so it stays well short of pure
        // black. Tuning knob — verify live against the near cascade's look.
        uDarken: { value: 0.6 },
        // Crossfade width in the near shadow's own UV margin (0 = center,
        // 0.5 = edge) — avoids a hard seam at the ±60u boundary. Tuning knob.
        uFadeMargin: { value: 0.08 },
        // Depth bias — larger magnitude than the near sun's -0.0005 because
        // the far cascade's map is 2× coarser per world unit; needs more
        // slop to avoid self-shadow acne. Tuning knob.
        uFarBias: { value: -0.0015 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: CASCADE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
  }

  /**
   * Darken `colorTex` beyond the near shadow's frustum using the far
   * cascade's shadow map. `farShadowMap`/`farShadowMatrix` are null until
   * the far cascade's first render (Three creates shadow maps lazily on
   * first use) — passthrough (identity) until then.
   */
  render(
    renderer: THREE.WebGLRenderer,
    colorTex: THREE.Texture,
    depthTex: THREE.Texture,
    projInv: THREE.Matrix4,
    viewInv: THREE.Matrix4,
    nearShadowMatrix: THREE.Matrix4,
    farShadowMap: THREE.Texture | null,
    farShadowMatrix: THREE.Matrix4 | null,
  ): void {
    const u = this.mat.uniforms;
    u.tColor.value = colorTex;
    u.tDepth.value = depthTex;
    (u.uProjInv.value as THREE.Matrix4).copy(projInv);
    (u.uViewInv.value as THREE.Matrix4).copy(viewInv);
    (u.uNearShadowMatrix.value as THREE.Matrix4).copy(nearShadowMatrix);
    if (farShadowMap && farShadowMatrix) {
      u.tFarShadowMap.value = farShadowMap;
      (u.uFarShadowMatrix.value as THREE.Matrix4).copy(farShadowMatrix);
      u.uFarEnabled.value = 1.0;
    } else {
      // Before the far cascade's first shadow-map render: keep a valid
      // texture bound (see placeholderShadowMap's doc) even though
      // uFarEnabled=0 means the shader branches away from sampling it.
      u.tFarShadowMap.value = this.placeholderShadowMap;
      u.uFarEnabled.value = 0.0;
    }

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  dispose(): void {
    this.target.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
    this.placeholderShadowMap.dispose();
  }
}
