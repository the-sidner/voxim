/**
 * Screen-space post-process pass: geometric edge detection + height AO + hover
 * silhouette outline + fog-of-war modulation + sRGB output.
 *
 * Edges are detected from the depth buffer alone — independent of vertex colour,
 * lighting, fog, or material. Two signals are combined:
 *   - Sobel on linearised depth (silhouettes, terrain height steps),
 *   - 1 - cos(angle) between four "quadrant" view-space normals reconstructed
 *     from depth derivatives (creases between faces of different orientation).
 * Whichever fires harder wins. This avoids the colour-Sobel artifacts where
 * per-cell brightness hashes on flat ground produced diagonal dot rows under
 * the isometric camera.
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
  uniform sampler2D tBloom;            // half-res blurred HDR bright-pass
  uniform float     uBloomStrength;    // how much glow to add back (0 = off)
  uniform mat4      uProjInv;
  uniform mat4      uViewInv;
  uniform float     uTileSize;          // world units per tile axis (= fog texture side)
  uniform float     uFogUnseen;         // brightness for unexplored cells
  uniform float     uFogSeen;           // brightness for explored, not currently visible
  uniform float     uFogVisible;        // brightness for cells in current LOS
  uniform vec2      texelSize;
  uniform float     edgeStrength;
  uniform vec3      edgeColor;
  uniform float     uDepthThreshold;     // depth Sobel / depth — fires on silhouettes & height steps
  uniform float     uNormalThreshold;    // 1 - cos(angle) between quadrant normals — fires on creases
  uniform float     uHoverActive;
  uniform vec3      uHoverColor;
  uniform float     uHoverRadius;
  uniform float     uExposure;            // pre-tonemap radiance lift
  uniform float     uSaturation;          // post-tonemap chroma gain (>1 = bunter)
  uniform float     uAoRadius;            // SSAO sampling reach (view-space, folds in proj scale)
  uniform float     uAoStrength;          // SSAO darkening amount (0 = off)
  uniform float     uSplitTone;           // forest split-tone strength (0 = off)
  uniform float     uVignetteStart;       // radius where corner darkening begins
  uniform float     uVignetteStrength;    // max corner darkening (0 = off)

  // View-space position from a (uv, raw-depth) sample. Garbage at the far
  // plane (w → 0); callers must skip sky pixels via the depth >= 0.9999 test.
  vec3 vpos(vec2 uv, float d) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v   = uProjInv * ndc;
    return v.xyz / v.w;
  }

  // Map the packed fog enum (0 / 0.5 / 1.0 in [0,1]) to a brightness factor.
  // Texture is R8 → 0/128/255 → 0/~0.502/1.0.
  float fogBrightness(float v) {
    if (v > 0.75) return uFogVisible;   // 1.0
    if (v > 0.25) return uFogSeen;      // ~0.5
    return uFogUnseen;                  // 0
  }

  // Narkowicz ACES filmic curve — maps the lit linear radiance through an S-shape
  // so lifted midtones read while the few bright (sunlit / ember) patches roll off
  // instead of clipping. Richer grim tonality than the raw linear clamp.
  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e2 = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e2), 0.0, 1.0);
  }

  // ---- Screen-space ambient occlusion ---------------------------------
  // Reconstructs the view position + a central-difference normal from the depth
  // buffer, then samples a per-pixel-rotated ring: every neighbour that rises in
  // front of this surface along its normal contributes occlusion. The result is
  // the soft contact darkening in every voxel crevice and terrain step that makes
  // the blocky world read as dense and grounded (T-310, phase B). Depth-only, so
  // voxels of ANY size are handled uniformly — no grid/neighbour assumptions.
  float computeSsao(vec2 uv, float dC, vec2 e) {
    vec3 pC = vpos(uv, dC);
    float dist = max(-pC.z, 0.001);
    float dR = texture2D(tDepth, uv + vec2(e.x, 0.0)).r;
    float dL = texture2D(tDepth, uv - vec2(e.x, 0.0)).r;
    float dU = texture2D(tDepth, uv + vec2(0.0, e.y)).r;
    float dD = texture2D(tDepth, uv - vec2(0.0, e.y)).r;
    vec3 N = normalize(cross(
      vpos(uv + vec2(e.x, 0.0), dR) - vpos(uv - vec2(e.x, 0.0), dL),
      vpos(uv + vec2(0.0, e.y), dU) - vpos(uv - vec2(0.0, e.y), dD)));
    // per-pixel rotation breaks up banding from the fixed 8-direction ring
    float ang = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    // world reach → screen uv reach (shrinks with distance), clamped so near
    // surfaces don't smear the whole screen.
    float uvRad = clamp(uAoRadius / dist, 1.5 * e.x, 28.0 * e.x);
    float occ = 0.0;
    // 4 rotated samples — half the taps of the original 8-ring. The per-pixel
    // rotation (ang) + the radius jitter keep it from banding at the lower count.
    for (int i = 0; i < 4; i++) {
      float a2 = (float(i) + 0.5) * 1.5707963 + ang;   // 2π/4
      float r  = uvRad * (0.4 + 0.6 * fract(float(i) * 0.61803));
      vec2 off = vec2(cos(a2), sin(a2)) * r;
      float ds = texture2D(tDepth, uv + off).r;
      if (ds >= 0.9999) continue;                    // sky never occludes
      vec3 diff = vpos(uv + off, ds) - pC;
      float l = length(diff);
      float rangeCheck = smoothstep(1.0, 0.0, l / 2.0);   // ignore far / other-surface hits
      occ += max(dot(N, diff / (l + 1e-4)) - 0.025, 0.0) * rangeCheck;
    }
    return clamp(1.0 - (occ / 4.0) * uAoStrength, 0.0, 1.0);
  }

  void main() {
    vec2 uv = vUv;
    vec2 e = texelSize;

    // ---- Geometry edges from depth + reconstructed view-space normal ----
    // Two independent signals:
    //   depthEdge  — Sobel on linearised depth (= -view.z), normalised by
    //                centre depth so a 1-unit step looks the same near and
    //                far. Fires on silhouettes against the background and
    //                on terrain height steps.
    //   normalEdge — 1 - cos(angle) between four "quadrant" normals built
    //                from asymmetric position derivatives (R/L × U/D crosses).
    //                On a smooth plane all four agree → ≈0; at a crease two
    //                of them swing toward the new face → significant value.
    // Sky pixels (depth ≥ 0.9999) are exempt: vpos() explodes there.
    float dCC = texture2D(tDepth, uv).r;
    float edge = 0.0;
    if (dCC < 0.9999) {
      float d00 = texture2D(tDepth, uv + e * vec2(-1.0, -1.0)).r;
      float d10 = texture2D(tDepth, uv + e * vec2( 0.0, -1.0)).r;
      float d20 = texture2D(tDepth, uv + e * vec2( 1.0, -1.0)).r;
      float d01 = texture2D(tDepth, uv + e * vec2(-1.0,  0.0)).r;
      float d21 = texture2D(tDepth, uv + e * vec2( 1.0,  0.0)).r;
      float d02 = texture2D(tDepth, uv + e * vec2(-1.0,  1.0)).r;
      float d12 = texture2D(tDepth, uv + e * vec2( 0.0,  1.0)).r;
      float d22 = texture2D(tDepth, uv + e * vec2( 1.0,  1.0)).r;

      vec3 pC  = vpos(uv,                          dCC);
      vec3 pE  = vpos(uv + e * vec2( 1.0,  0.0),   d21);
      vec3 pW  = vpos(uv + e * vec2(-1.0,  0.0),   d01);
      vec3 pN  = vpos(uv + e * vec2( 0.0,  1.0),   d12);
      vec3 pS  = vpos(uv + e * vec2( 0.0, -1.0),   d10);
      vec3 pNE = vpos(uv + e * vec2( 1.0,  1.0),   d22);
      vec3 pNW = vpos(uv + e * vec2(-1.0,  1.0),   d02);
      vec3 pSE = vpos(uv + e * vec2( 1.0, -1.0),   d20);
      vec3 pSW = vpos(uv + e * vec2(-1.0, -1.0),   d00);

      float zC = -pC.z;

      // Linearised-depth Sobel.
      float lz00 = -pSW.z, lz10 = -pS.z, lz20 = -pSE.z;
      float lz01 = -pW.z,                lz21 = -pE.z;
      float lz02 = -pNW.z, lz12 = -pN.z, lz22 = -pNE.z;
      float gxZ = -lz00 + lz20 - 2.0*lz01 + 2.0*lz21 - lz02 + lz22;
      float gyZ = -lz00 - 2.0*lz10 - lz20 + lz02 + 2.0*lz12 + lz22;
      float depthEdge = sqrt(gxZ*gxZ + gyZ*gyZ) / max(zC, 0.001);

      // Quadrant normals: each cross product mixes one horizontal derivative
      // (right or left) with one vertical (up or down). On a smooth surface
      // R≈L and U≈D, so all four normals coincide.
      vec3 dxR = pE - pC, dxL = pC - pW;
      vec3 dyU = pN - pC, dyD = pC - pS;
      vec3 nRU = normalize(cross(dxR, dyU));
      vec3 nLU = normalize(cross(dxL, dyU));
      vec3 nRD = normalize(cross(dxR, dyD));
      vec3 nLD = normalize(cross(dxL, dyD));
      float minDot = min(
        min(min(dot(nRU, nLU), dot(nRU, nRD)), dot(nRU, nLD)),
        min(min(dot(nLU, nRD), dot(nLU, nLD)), dot(nRD, nLD))
      );
      float normalEdge = 1.0 - clamp(minDot, 0.0, 1.0);

      float edgeD = smoothstep(uDepthThreshold,  uDepthThreshold  * 2.0, depthEdge);
      float edgeN = smoothstep(uNormalThreshold, uNormalThreshold * 2.0, normalEdge);
      edge = clamp(max(edgeD, edgeN) * edgeStrength, 0.0, 1.0);
    }

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

    // True screen-space AO on top of the coarse height term — the contact
    // shadows that ground voxels in their crevices. Sky pixels are exempt.
    if (dCC < 0.9999 && uAoStrength > 0.0) {
      color.rgb *= computeSsao(uv, dCC, e);
    }

    // edgeColor is sRGB; convert to linear for correct mixing.
    vec3 edgeLinear = pow(max(edgeColor, vec3(0.0)), vec3(2.2));
    color.rgb = mix(color.rgb, edgeLinear, edge);

    // ---- Hover silhouette outline (linear space) ------------------------
    // Dilate the mask via a square box kernel: max over every texel in the
    // (2R+1)×(2R+1) window.  Cost is small at our pixel-art resolutions (R≈4
    // → 81 samples) and the ring is fully continuous regardless of radius —
    // the previous +× sample produced a star-pattern that read as dots.
    // Only run the (expensive) dilation when something is actually hovered —
    // otherwise this was ~25 texture taps per pixel every frame for nothing.
    if (uHoverActive > 0.0) {
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
      float hRim = hDil * (1.0 - hMask);
      color.rgb = mix(color.rgb, uHoverColor, hRim);
    }

    // ---- Bloom (HDR glow) -----------------------------------------------
    // Add the blurred bright-pass back into the linear HDR radiance BEFORE the
    // ACES tonemap, so torch/ember/sun glow rolls off filmically with the rest
    // of the image instead of clipping to flat white. Sampled with linear
    // upscaling from the half-res bloom target → a smooth halo.
    color.rgb += texture2D(tBloom, vUv).rgb * uBloomStrength;

    // ---- Tone (lit radiance) --------------------------------------------
    // Exposure lift then the ACES curve, applied to the LIT scene BEFORE the
    // fog-of-war dim — so tone-mapping shapes the world's light, and fog-of-war
    // stays a clean gameplay multiply on top (a tone-mapped image, not raw HDR).
    color.rgb = aces(color.rgb * uExposure);

    // Saturation lift (T-289): pull each channel away from its luma so the
    // desaturated earth palette reads as colored, not ash-grey. Replaces a dead
    // ±6% split-tone tint that was below perceptual threshold on the grey base.
    // Applied after tone-mapping, before the fog-of-war dim so chroma is graded
    // on the lit image, not the gameplay multiply. uSaturation > 1 extrapolates
    // past the source colour; clamp the low end so it can't go negative.
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = max(mix(vec3(luma), color.rgb, uSaturation), 0.0);

    // Forest split-tone: shadows toward a cool moss-green, highlights toward warm
    // sunlight — the dappled light-through-canopy read that sells "deep forest".
    // Subtle; scaled by uSplitTone.
    {
      float lz = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = vec3(0.92, 1.05, 0.96);   // green-cool
      vec3 highTint   = vec3(1.07, 1.02, 0.89);   // warm gold
      vec3 tinted = color.rgb * mix(shadowTint, highTint, smoothstep(0.16, 0.74, lz));
      color.rgb = mix(color.rgb, tinted, uSplitTone);
    }

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

    // ---- Vignette (presentation) ----------------------------------------
    // A gentle corner falloff focuses the eye on the player and keeps the
    // lifted scene feeling close and grim. Subtle — never a hard black frame.
    float vigD = distance(vUv, vec2(0.5));
    color.rgb *= 1.0 - uVignetteStrength * smoothstep(uVignetteStart, 0.75, vigD);

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
    // 1×1 black placeholder so the shader compiles before the BloomPass texture
    // is wired in; the renderer swaps in the live half-res bloom texture at boot.
    const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    blackTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor:        { value: colorTex },
        tHeight:       { value: heightTex },
        tHoverMask:    { value: hoverMaskTex },
        tDepth:        { value: depthTex },
        tFog:          { value: fogTex },
        tBloom:        { value: blackTex },
        uBloomStrength: { value: 0.7 },
        uProjInv:      { value: new THREE.Matrix4() },
        uViewInv:      { value: new THREE.Matrix4() },
        uTileSize:     { value: 0.0 },           // 0 disables fog (no tile yet)
        uFogUnseen:    { value: 0.18 },
        uFogSeen:      { value: 0.66 },
        uFogVisible:   { value: 1.0 },
        texelSize:     { value: new THREE.Vector2(1 / width, 1 / height) },
        edgeStrength:     { value: 1.0 },
        // edgeInk palette token (peat #161611) — warmer near-black than the old
        // hardcoded 0x0d0d0d; overwritten from the live palette via setEdgeColor.
        edgeColor:        { value: new THREE.Color(0x161611) },
        // Tuned for the isometric camera and 1-unit voxel cells:
        //   depthEdge of ~0.04 ≈ a 1-unit z-step at typical camera distance,
        //   normalEdge of ~0.10 ≈ a ~25° crease (1 - cos 25° ≈ 0.094).
        uDepthThreshold:  { value: 0.04 },
        uNormalThreshold: { value: 0.10 },
        uHoverActive:  { value: 0.0 },
        uHoverColor:   { value: new THREE.Color().setRGB(1.0, 0.96, 0.78) },
        uHoverRadius:  { value: 2.0 },
        // Tone + mood. Exposure lifts the grim-dark scene into a readable
        // midtone; ACES (in-shader) rolls off the highlights; the vignette pulls
        // the corners back for focus. Tuned by eye against the ash-grey world.
        // Lifted a touch (was 1.5) now that HDR headroom + bloom carry the bright
        // end — pulls the grim midtones up so the world reads less muddy-dark.
        uExposure:         { value: 1.42 },
        // Chroma gain — lifts the intentionally-desaturated earth palette into
        // readable color ("deutlich bunter"). 1.0 = neutral; tuned by eye.
        uSaturation:       { value: 1.62 },
        // Slightly deeper + earlier vignette focuses the eye on the player and
        // frames the lit scene cinematically (still soft, never a hard frame).
        uVignetteStart:    { value: 0.42 },
        uVignetteStrength: { value: 0.17 },
        // SSAO — contact darkening between voxels. Radius folds in the projection
        // scale (tuned by eye against the fixed camera); strength is the depth of
        // the crevice shadow. Tuning knobs.
        uAoRadius:         { value: 0.28 },
        uAoStrength:       { value: 1.15 },
        // Forest split-tone (green shadows / warm highlights). Tuning knob.
        uSplitTone:        { value: 0.45 },
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

  /** Edge-ink color — the silhouette/crease tint (sRGB; converted in shader).
   *  Wired from the palette `edgeInk` token so the outline ink is content-driven. */
  setEdgeColor(color: THREE.ColorRepresentation): void {
    (this.material.uniforms.edgeColor.value as THREE.Color).set(color);
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

  /** Post-tonemap chroma gain (1.0 = neutral, >1 = more saturated). Tuning knob. */
  setSaturation(value: number): void {
    this.material.uniforms.uSaturation.value = value;
  }

  /** Bind the live bloom texture (replaces the black constructor placeholder). */
  setBloomTexture(tex: THREE.Texture): void {
    this.material.uniforms.tBloom.value = tex;
  }

  /** Glow amount added back before tone-mapping (0 = off). Tuning knob. */
  setBloomStrength(value: number): void {
    this.material.uniforms.uBloomStrength.value = value;
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
