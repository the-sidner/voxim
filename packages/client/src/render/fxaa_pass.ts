/**
 * Screen-space FXAA (Fast Approximate Anti-Aliasing) pass.
 *
 * Reads sRGB output from the EdgePass and blends sub-pixel transitions along
 * detected edges using luma-guided sampling.  The algorithm finds the dominant
 * edge direction (horizontal vs vertical) at each pixel, walks outward along
 * the edge in both directions to locate its endpoints, then offsets the UV
 * toward the neighbour by a fraction proportional to how far the pixel sits
 * from the nearest endpoint.
 *
 * Input must already be gamma-corrected (sRGB) because luma detection is
 * tuned for perceptual brightness rather than linear light.
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

  uniform sampler2D tDiffuse;
  uniform vec2      resolution;   // 1/width, 1/height

  // Perceptual luma (BT.601, matches FXAA reference).
  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    vec2 uv = vUv;
    vec2 e  = resolution;

    // ---- Centre + cardinal neighbours -----------------------------------
    vec3 rgbC = texture2D(tDiffuse, uv).rgb;
    float lumaC = luma(rgbC);
    float lumaN = luma(texture2D(tDiffuse, uv + vec2( 0.0,  e.y)).rgb);
    float lumaS = luma(texture2D(tDiffuse, uv + vec2( 0.0, -e.y)).rgb);
    float lumaE = luma(texture2D(tDiffuse, uv + vec2( e.x,  0.0)).rgb);
    float lumaW = luma(texture2D(tDiffuse, uv + vec2(-e.x,  0.0)).rgb);

    float lumaMin = min(lumaC, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    float lumaMax = max(lumaC, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    float range   = lumaMax - lumaMin;

    // Skip smooth regions — two thresholds to avoid blurring dark areas.
    if (range < max(0.0312, lumaMax * 0.125)) {
      gl_FragColor = vec4(rgbC, 1.0);
      return;
    }

    // ---- Diagonal neighbours (for edge direction) -----------------------
    float lumaNW = luma(texture2D(tDiffuse, uv + vec2(-e.x,  e.y)).rgb);
    float lumaNE = luma(texture2D(tDiffuse, uv + vec2( e.x,  e.y)).rgb);
    float lumaSW = luma(texture2D(tDiffuse, uv + vec2(-e.x, -e.y)).rgb);
    float lumaSE = luma(texture2D(tDiffuse, uv + vec2( e.x, -e.y)).rgb);

    // ---- Determine dominant edge direction ------------------------------
    float edgeH = abs(-2.0*lumaW + lumaNW + lumaSW)
                + abs(-2.0*lumaC + lumaN  + lumaS ) * 2.0
                + abs(-2.0*lumaE + lumaNE + lumaSE);
    float edgeV = abs(-2.0*lumaS + lumaSW + lumaSE)
                + abs(-2.0*lumaC + lumaW  + lumaE ) * 2.0
                + abs(-2.0*lumaN + lumaNW + lumaNE);
    bool isHorizontal = edgeH >= edgeV;

    // Step length perpendicular to the edge, directed toward the steeper side.
    float luma1 = isHorizontal ? lumaS : lumaW;
    float luma2 = isHorizontal ? lumaN : lumaE;
    float grad1 = abs(luma1 - lumaC);
    float grad2 = abs(luma2 - lumaC);
    bool steepSide = grad1 >= grad2;

    float stepLen = isHorizontal ? e.y : e.x;
    if (!steepSide) stepLen = -stepLen;

    // UV half-stepped perpendicular to the edge (sits on the edge itself).
    vec2 uvEdge = uv;
    if (isHorizontal) uvEdge.y += stepLen * 0.5;
    else              uvEdge.x += stepLen * 0.5;

    // ---- Walk along the edge to find endpoints -------------------------
    vec2 along = isHorizontal ? vec2(e.x, 0.0) : vec2(0.0, e.y);

    float lumaLocalAvg  = (lumaC + (steepSide ? luma1 : luma2)) * 0.5;
    float gradScaled    = max(grad1, grad2) * 0.25;

    vec2 uvP = uvEdge + along;
    vec2 uvN = uvEdge - along;

    float lumaEndP = luma(texture2D(tDiffuse, uvP).rgb) - lumaLocalAvg;
    float lumaEndN = luma(texture2D(tDiffuse, uvN).rgb) - lumaLocalAvg;

    bool doneP = abs(lumaEndP) >= gradScaled;
    bool doneN = abs(lumaEndN) >= gradScaled;

    // Walk up to 8 steps in each direction to find the edge boundary.
    for (int i = 0; i < 8; i++) {
      if (!doneP) { uvP += along; lumaEndP = luma(texture2D(tDiffuse, uvP).rgb) - lumaLocalAvg; }
      if (!doneN) { uvN -= along; lumaEndN = luma(texture2D(tDiffuse, uvN).rgb) - lumaLocalAvg; }
      doneP = doneP || abs(lumaEndP) >= gradScaled;
      doneN = doneN || abs(lumaEndN) >= gradScaled;
      if (doneP && doneN) break;
    }

    // ---- Blend amount from endpoint distances ---------------------------
    float distP = isHorizontal ? abs(uvP.x - uv.x) : abs(uvP.y - uv.y);
    float distN = isHorizontal ? abs(uvN.x - uv.x) : abs(uvN.y - uv.y);

    bool nearerToP  = distP < distN;
    float lumaEnd   = nearerToP ? lumaEndP : lumaEndN;
    float spanTotal = distP + distN;

    // If the luma delta at the nearer endpoint has the same sign as the centre
    // offset, we're pointing the wrong way — skip blend to avoid ringing.
    if (((lumaC - lumaLocalAvg) < 0.0) == (lumaEnd < 0.0)) {
      gl_FragColor = vec4(rgbC, 1.0);
      return;
    }

    // Offset UV toward the neighbour pixel along the perpendicular axis.
    float pixelOffset = (0.5 - min(distP, distN) / spanTotal);
    vec2 blendUv = uv;
    if (isHorizontal) blendUv.y += pixelOffset * stepLen;
    else              blendUv.x += pixelOffset * stepLen;

    gl_FragColor = texture2D(tDiffuse, blendUv);
  }
`;

export class FxaaPass {
  readonly material: THREE.ShaderMaterial;

  constructor(tex: THREE.Texture, width: number, height: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: tex },
        resolution: { value: new THREE.Vector2(1 / width, 1 / height) },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      depthTest:  false,
      depthWrite: false,
    });
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms.resolution.value as THREE.Vector2).set(1 / width, 1 / height);
  }

  dispose(): void {
    this.material.dispose();
  }
}
