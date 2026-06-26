/// <reference lib="dom" />
/**
 * HDR bloom — the "expensive glow" headline (T-310, phase D).
 *
 * A hand-rolled fullscreen-quad chain matching the rest of the post pipeline
 * (no EffectComposer): a soft-knee bright-pass extracts the HDR pixels above a
 * threshold (torch/ember emissive, the sun disc, hot sunlit highlights — all of
 * which exceed 1.0 only because the scene now renders into a HalfFloat target),
 * then a separable Gaussian blur ping-pongs at half resolution for a few
 * iterations of growing radius. The result is handed to the EdgePass, which adds
 * it into the linear HDR scene colour BEFORE its ACES tonemap, so the glow rolls
 * off filmically with everything else instead of clipping to flat white.
 *
 * Half-res is both cheaper and naturally softer; the EdgePass samples the bloom
 * texture with linear upscaling so it reads as a smooth halo, not a low-res grid.
 */
import * as THREE from "three";

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Soft-knee bright-pass: keep only radiance above the threshold, with a smooth
 *  quadratic knee so the bloom fades in rather than hard-clipping at the cutoff. */
const BRIGHT_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    float knee = max(uKnee, 1e-4);
    float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    soft = (soft * soft) / (4.0 * knee);
    float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

/** Separable 9-tap Gaussian. uDir carries the per-tap UV step (texel × spread)
 *  along one axis; the pass is run once horizontal, once vertical. */
const BLUR_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  void main() {
    vec3 sum = texture2D(tSrc, vUv).rgb * 0.227027;
    sum += texture2D(tSrc, vUv + uDir * 1.3846).rgb * 0.316216;
    sum += texture2D(tSrc, vUv - uDir * 1.3846).rgb * 0.316216;
    sum += texture2D(tSrc, vUv + uDir * 3.2308).rgb * 0.070270;
    sum += texture2D(tSrc, vUv - uDir * 3.2308).rgb * 0.070270;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

interface BlurStep { dir: [number, number]; spread: number }

export class BloomPass {
  private bright: THREE.WebGLRenderTarget;
  private pingA: THREE.WebGLRenderTarget;
  private pingB: THREE.WebGLRenderTarget;
  private readonly brightMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly quad: THREE.Mesh;
  private readonly cam: THREE.OrthographicCamera;
  private bw: number;
  private bh: number;
  /** The final blurred bloom texture, fed to the EdgePass. */
  private result: THREE.Texture;

  constructor(width: number, height: number) {
    this.bw = Math.max(1, Math.floor(width / 2));
    this.bh = Math.max(1, Math.floor(height / 2));
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.bright = new THREE.WebGLRenderTarget(this.bw, this.bh, opts);
    this.pingA = new THREE.WebGLRenderTarget(this.bw, this.bh, opts);
    this.pingB = new THREE.WebGLRenderTarget(this.bw, this.bh, opts);
    this.result = this.pingB.texture;

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uThreshold: { value: 0.85 },
        uKnee: { value: 0.35 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.brightMat);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
  }

  /** Bright-extract `srcTex` then blur it. Leaves the result in `this.result`. */
  render(renderer: THREE.WebGLRenderer, srcTex: THREE.Texture): void {
    const prevTarget = renderer.getRenderTarget();

    // Bright-pass: src → bright
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tSrc.value = srcTex;
    renderer.setRenderTarget(this.bright);
    renderer.render(this.scene, this.cam);

    // Ping-pong blur. Each iteration widens the kernel for a softer, larger halo.
    // bright → pingA (H) → pingB (V) → pingA (H, wider) → pingB (V, wider) …
    const steps: BlurStep[] = [
      { dir: [1, 0], spread: 1.0 },
      { dir: [0, 1], spread: 1.0 },
      { dir: [1, 0], spread: 2.0 },
      { dir: [0, 1], spread: 2.0 },
    ];
    this.quad.material = this.blurMat;
    let src: THREE.Texture = this.bright.texture;
    let dst = this.pingA;
    let other = this.pingB;
    for (const s of steps) {
      this.blurMat.uniforms.tSrc.value = src;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(
        (s.dir[0] * s.spread) / this.bw,
        (s.dir[1] * s.spread) / this.bh,
      );
      renderer.setRenderTarget(dst);
      renderer.render(this.scene, this.cam);
      src = dst.texture;
      const tmp = dst; dst = other; other = tmp;
    }
    this.result = src;
    renderer.setRenderTarget(prevTarget);
  }

  get texture(): THREE.Texture {
    return this.result;
  }

  setSize(width: number, height: number): void {
    this.bw = Math.max(1, Math.floor(width / 2));
    this.bh = Math.max(1, Math.floor(height / 2));
    this.bright.setSize(this.bw, this.bh);
    this.pingA.setSize(this.bw, this.bh);
    this.pingB.setSize(this.bw, this.bh);
  }

  /** Bright-pass threshold (luma above which pixels bloom) + soft-knee width. */
  setThreshold(threshold: number, knee: number): void {
    this.brightMat.uniforms.uThreshold.value = threshold;
    this.brightMat.uniforms.uKnee.value = knee;
  }

  dispose(): void {
    this.bright.dispose();
    this.pingA.dispose();
    this.pingB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.quad.geometry.dispose();
  }
}
