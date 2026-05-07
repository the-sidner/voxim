/**
 * Screen-space post-process pass: Sobel edge detection + height AO + hover
 * silhouette outline + fog-of-war modulation + sRGB output.
 *
 * Uses a normalised luminance Sobel: the gradient is divided by the local mean
 * brightness, so edges fire at consistent strength across day/night cycles and
 * on dark surfaces (terrain faces, midnight shadows, etc.).
 *
 * Hover outline: HoverOutlineRenderer paints the hovered entity onto a separate
 * mask texture (hoverMaskTarget), depth-test off so the silhouette is visible
 * through walls.  This pass dilates the mask with a square box kernel of
 * radius uHoverRadius (continuous ring at any radius — much smoother than
 * the +× sample it replaced) and composites the dilated ring as uHoverColor.
 * The model itself is left untouched: outline only, no interior wash.
 *
 * Fog of war (T-157): `tFog` is a 512×512 R8 texture covering the current tile
 * (one texel per world unit; see state/fog_of_war.ts).  We reconstruct world
 * XZ from `tDepth` + inverse projection/view matrices (the same trick the
 * separate depth-blit pass uses for height shading) and use it to look up the
 * cell's fog state.  Pixel brightness is multiplied by the resulting factor.
 * Sky pixels (depth ≥ 0.9999) are exempt — they're never on the tile grid.
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
  uniform sampler2D tHoverMask;
  uniform sampler2D tDepth;
  uniform sampler2D tFog;
  uniform mat4      uProjInv;
  uniform mat4      uViewInv;
  uniform float     uTileSize;          // world units per tile axis (= fog texture side)
  uniform float     uFogUnseen;         // brightness for unexplored cells
  uniform float     uFogSeen;           // brightness for explored, not currently visible
  uniform float     uFogVisible;        // brightness for cells in current LOS
  uniform vec2      texelSize;
  uniform float     edgeStrength;
  uniform vec3      edgeColor;
  uniform float     lumThreshold;
  uniform float     uHoverActive;
  uniform vec3      uHoverColor;
  uniform float     uHoverRadius;

  float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  // Map the packed fog enum (0 / 0.5 / 1.0 in [0,1]) to a brightness factor.
  // Texture is R8 → 0/128/255 → 0/~0.502/1.0.
  float fogBrightness(float v) {
    if (v > 0.75) return uFogVisible;   // 1.0
    if (v > 0.25) return uFogSeen;      // ~0.5
    return uFogUnseen;                  // 0
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

    // ---- Hover silhouette outline (linear space) ------------------------
    // Dilate the mask via a square box kernel: max over every texel in the
    // (2R+1)×(2R+1) window.  Cost is small at our pixel-art resolutions (R≈4
    // → 81 samples) and the ring is fully continuous regardless of radius —
    // the previous +× sample produced a star-pattern that read as dots.
    float hMask = texture2D(tHoverMask, vUv).r;
    float hDil  = hMask;
    int   r     = int(uHoverRadius);
    for (int j = -8; j <= 8; j++) {
      if (j < -r || j > r) continue;
      for (int i = -8; i <= 8; i++) {
        if (i < -r || i > r) continue;
        hDil = max(hDil, texture2D(tHoverMask, vUv + e * vec2(float(i), float(j))).r);
      }
    }
    // Rim = dilated minus original.  The model itself stays untouched.
    float hRim = hDil * (1.0 - hMask) * uHoverActive;
    color.rgb = mix(color.rgb, uHoverColor, hRim);

    // ---- Fog of war (T-157) ---------------------------------------------
    // Reconstruct world position from depth + inverse camera matrices.
    // Sky pixels have depth = 1.0; skip them.
    float depth = texture2D(tDepth, vUv).r;
    if (depth < 0.9999 && uTileSize > 0.0) {
      vec4 ndc     = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = uProjInv * ndc;
      viewPos     /= viewPos.w;
      vec4 world   = uViewInv * viewPos;

      // Server (wx, wy) horizontal == ThreeJS (x, z).
      vec2 fogUv = vec2(world.x / uTileSize, world.z / uTileSize);
      // Off-tile geometry stays at unseen brightness.
      float fogVal = (fogUv.x < 0.0 || fogUv.x > 1.0 || fogUv.y < 0.0 || fogUv.y > 1.0)
        ? 0.0
        : texture2D(tFog, fogUv).r;
      color.rgb *= fogBrightness(fogVal);
    }

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
    hoverMaskTex: THREE.Texture,
    depthTex: THREE.Texture,
    fogTex: THREE.Texture,
    width: number,
    height: number,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor:        { value: colorTex },
        tHeight:       { value: heightTex },
        tHoverMask:    { value: hoverMaskTex },
        tDepth:        { value: depthTex },
        tFog:          { value: fogTex },
        uProjInv:      { value: new THREE.Matrix4() },
        uViewInv:      { value: new THREE.Matrix4() },
        uTileSize:     { value: 0.0 },           // 0 disables fog (no tile yet)
        uFogUnseen:    { value: 0.05 },
        uFogSeen:      { value: 0.55 },
        uFogVisible:   { value: 1.0 },
        texelSize:     { value: new THREE.Vector2(1 / width, 1 / height) },
        edgeStrength:  { value: 1.0 },
        edgeColor:     { value: new THREE.Color(0x0d0d0d) },
        lumThreshold:  { value: 0.4 },
        uHoverActive:  { value: 0.0 },
        uHoverColor:   { value: new THREE.Color().setRGB(1.0, 0.96, 0.78) },
        uHoverRadius:  { value: 2.0 },
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

  /**
   * Toggle the Sobel edge detection contribution.
   * When disabled, edgeStrength is set to 0 so the pass becomes a plain
   * height-shaded sRGB blit with no outlines.
   * Returns the new enabled state.
   */
  toggleSobelEdges(): boolean {
    const u = this.material.uniforms.edgeStrength;
    const nowEnabled = u.value === 0;
    u.value = nowEnabled ? 1.0 : 0;
    return nowEnabled;
  }

  /** Enable or disable the hover silhouette outline composite. */
  setHoverActive(active: boolean): void {
    this.material.uniforms.uHoverActive.value = active ? 1.0 : 0.0;
  }

  /** Tint color for the rim and the interior wash (sRGB; converted in shader). */
  setHoverColor(color: THREE.ColorRepresentation): void {
    (this.material.uniforms.uHoverColor.value as THREE.Color).set(color);
  }

  /**
   * Update the camera matrices used to reconstruct world XZ from the depth
   * texture.  Caller passes the camera's `projectionMatrixInverse` and
   * `matrixWorld`.  Must be refreshed every frame after the scene is rendered.
   */
  setCameraMatrices(projInv: THREE.Matrix4, viewInv: THREE.Matrix4): void {
    (this.material.uniforms.uProjInv.value as THREE.Matrix4).copy(projInv);
    (this.material.uniforms.uViewInv.value as THREE.Matrix4).copy(viewInv);
  }

  /** Set the tile size in world units (== fog texture side).  0 disables fog. */
  setTileSize(size: number): void {
    this.material.uniforms.uTileSize.value = size;
  }

  /** Bind the live fog texture (replaces the constructor placeholder). */
  setFogTexture(tex: THREE.Texture): void {
    this.material.uniforms.tFog.value = tex;
  }

  dispose(): void {
    this.material.dispose();
  }
}
