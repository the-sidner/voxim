/// <reference lib="dom" />
/**
 * Volumetric light shafts / "god rays" (toward the concept-art reference look).
 * The defining signature of the target art: light streaming through the canopy
 * and mist. A hand-rolled radial light-scattering pass (Mitchell, GPU Gems 3) on
 * the bloom bright-target: from each pixel it marches TOWARD the sun's screen
 * position, accumulating brightness with exponential decay, so bright sky-gaps,
 * the sun, and torches smear into directional shafts. Half-res; the EdgePass adds
 * the result into the HDR scene before tone-mapping so the shafts roll off.
 */
import * as THREE from "three";

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const RAY_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2  uSunUV;     // sun position in screen UV (may be off-screen)
  uniform float uDensity;   // how far toward the sun the march reaches
  uniform float uDecay;     // per-step brightness falloff
  uniform float uWeight;    // per-step contribution
  const int SAMPLES = 24;
  void main() {
    vec2 delta = (vUv - uSunUV) * (uDensity / float(SAMPLES));
    vec2 uv = vUv;
    vec3 col = texture2D(tSrc, uv).rgb;
    float illum = 1.0;
    for (int i = 0; i < SAMPLES; i++) {
      uv -= delta;
      col += texture2D(tSrc, uv).rgb * illum * uWeight;
      illum *= uDecay;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class GodRayPass {
  private target: THREE.WebGLRenderTarget;
  private readonly mat: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly quad: THREE.Mesh;
  private readonly cam: THREE.OrthographicCamera;

  constructor(width: number, height: number) {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc:     { value: null },
        uSunUV:   { value: new THREE.Vector2(0.5, 1.2) },
        uDensity: { value: 0.85 },
        uDecay:   { value: 0.97 },
        uWeight:  { value: 0.42 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: RAY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
  }

  /** Radial-blur `srcTex` (the bloom bright-target) toward the sun screen UV. */
  render(renderer: THREE.WebGLRenderer, srcTex: THREE.Texture, sunUV: THREE.Vector2): void {
    const prev = renderer.getRenderTarget();
    this.mat.uniforms.tSrc.value = srcTex;
    (this.mat.uniforms.uSunUV.value as THREE.Vector2).copy(sunUV);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  }

  dispose(): void {
    this.target.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}
