/**
 * Screen-space post-process pass: Sobel edge detection + height AO + sRGB output.
 *
 * Uses a normalised luminance Sobel: the gradient is divided by the local mean
 * brightness, so edges fire at consistent strength across day/night cycles and
 * on dark surfaces (terrain faces, midnight shadows, etc.).
 *
 * Depth texture is reserved for a future packed-depth pass; direct DEPTH_COMPONENT
 * sampling via sampler2D produces undefined results on several WebGL2 drivers due
 * to framebuffer-attachment feedback, so it is not used here.
 */

import * as THREE from "three";

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tHeight;
  uniform vec2      texelSize;
  uniform float     edgeStrength;
  uniform vec3      edgeColor;
  uniform float     lumThreshold;

  float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec2 uv = vUv;
    vec2 e = texelSize;

    // ---- Sobel on luminance (normalised by local mean) ------------------
    float l00 = luma(texture2D(tColor, uv + e * vec2(-1.0, -1.0)).rgb);
    float l10 = luma(texture2D(tColor, uv + e * vec2( 0.0, -1.0)).rgb);
    float l20 = luma(texture2D(tColor, uv + e * vec2( 1.0, -1.0)).rgb);
    float l01 = luma(texture2D(tColor, uv + e * vec2(-1.0,  0.0)).rgb);
    float l21 = luma(texture2D(tColor, uv + e * vec2( 1.0,  0.0)).rgb);
    float l02 = luma(texture2D(tColor, uv + e * vec2(-1.0,  1.0)).rgb);
    float l12 = luma(texture2D(tColor, uv + e * vec2( 0.0,  1.0)).rgb);
    float l22 = luma(texture2D(tColor, uv + e * vec2( 1.0,  1.0)).rgb);

    float gxL = -l00 + l20 - 2.0*l01 + 2.0*l21 - l02 + l22;
    float gyL = -l00 - 2.0*l10 - l20 + l02 + 2.0*l12 + l22;
    float edgeLumAbs = sqrt(gxL*gxL + gyL*gyL);

    // Normalise by local mean brightness — edges fire equally at noon and midnight.
    float avgLuma = (l00+l10+l20+l01+l21+l02+l12+l22) / 8.0;
    float edgeLum = edgeLumAbs / max(avgLuma, 0.001);

    float edge = clamp(
      smoothstep(lumThreshold, lumThreshold * 2.0, edgeLum) * edgeStrength,
      0.0, 1.0
    );

    vec4 color = texture2D(tColor, uv);

    // ---- Height + soft AO shading ---------------------------------------
    float hC = texture2D(tHeight, uv).r;

    float aoR = 3.0;
    float hN = texture2D(tHeight, uv + e * vec2( 0.0,  aoR)).r;
    float hS = texture2D(tHeight, uv + e * vec2( 0.0, -aoR)).r;
    float hE = texture2D(tHeight, uv + e * vec2( aoR,  0.0)).r;
    float hW = texture2D(tHeight, uv + e * vec2(-aoR,  0.0)).r;
    float avgNH     = (hN + hS + hE + hW) * 0.25;
    float occlusion = clamp((avgNH - hC) * 3.0, 0.0, 0.35);

    float hFactor  = 0.82 + 0.18 * hC;
    float aoFactor = 1.0 - occlusion;
    color.rgb *= hFactor * aoFactor;

    // edgeColor is sRGB; convert to linear for correct mixing.
    vec3 edgeLinear = pow(max(edgeColor, vec3(0.0)), vec3(2.2));
    color.rgb = mix(color.rgb, edgeLinear, edge);

    // Linear → sRGB for canvas output.
    color.rgb = pow(max(color.rgb, vec3(0.0)), vec3(1.0 / 2.2));

    gl_FragColor = color;
  }
`;

export class EdgePass {
  readonly material: THREE.ShaderMaterial;

  constructor(
    colorTex: THREE.Texture,
    heightTex: THREE.Texture,
    width: number,
    height: number,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor:       { value: colorTex },
        tHeight:      { value: heightTex },
        texelSize:    { value: new THREE.Vector2(1 / width, 1 / height) },
        edgeStrength: { value: 1.0 },
        edgeColor:    { value: new THREE.Color(0x0d0d0d) },
        lumThreshold: { value: 0.4 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      depthTest:  false,
      depthWrite: false,
    });
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms.texelSize.value as THREE.Vector2).set(1 / width, 1 / height);
  }

  dispose(): void {
    this.material.dispose();
  }
}
