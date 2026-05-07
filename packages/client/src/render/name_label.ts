/**
 * Floating name label rendered above each entity's head.
 *
 * One THREE.Sprite per labelled entity, parented to the entity mesh group so
 * world position tracks automatically. Sprites are camera-billboarded by
 * three.js and are not rotated by the parent group's facing — the label
 * always reads horizontally regardless of the entity's facing.
 *
 * Texture is a small canvas with a translucent pill background plus the
 * name text. Generated once per (text, color) and replaced when the name
 * changes — cheap (<200 µs per regen) and avoids the per-frame cost of
 * SDF/MSDF text. Each entity's sprite owns its texture and disposes it on
 * remove.
 */
import * as THREE from "three";

/**
 * World-space height above the entity's group origin. Tuned to the
 * placeholder body (1.8 tall, top at y=1.8) — leaves ≈0.4 of clearance
 * above the head for the label.
 */
const LABEL_HEIGHT = 2.2;

/** Map canvas pixels to world units. ~0.012 → an 8-char name reads as ~1.5 world units. */
const PX_TO_WORLD = 0.012;

const FONT_SIZE_PX = 32;
const PAD_X        = 8;
const PAD_Y        = 4;

export function makeNameSprite(text: string, color = "#ffeebb"): THREE.Sprite {
  const tex = makeNameTexture(text, color);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest:  false,        // always visible — labels shouldn't be occluded
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  // Sprites are unit-square by default. scale(x, y, 1) gives world-unit dims.
  const w = tex.image.width  * PX_TO_WORLD;
  const h = tex.image.height * PX_TO_WORLD;
  sprite.scale.set(w, h, 1);
  sprite.position.y = LABEL_HEIGHT;
  // Render after most opaque geometry so the label punches through silhouettes.
  sprite.renderOrder = 9999;
  return sprite;
}

/**
 * Replace a sprite's text in place. Cheaper than rebuilding the whole sprite
 * (the GPU material is reused) but the texture is regenerated and the old
 * one disposed. Caller still owns the sprite — call `disposeNameSprite` when
 * the entity is removed.
 */
export function setNameSpriteText(sprite: THREE.Sprite, text: string, color = "#ffeebb"): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  const old = mat.map;
  const tex = makeNameTexture(text, color);
  mat.map = tex;
  mat.needsUpdate = true;
  if (old) old.dispose();
  const w = tex.image.width  * PX_TO_WORLD;
  const h = tex.image.height * PX_TO_WORLD;
  sprite.scale.set(w, h, 1);
}

export function disposeNameSprite(sprite: THREE.Sprite): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.dispose();
  sprite.removeFromParent();
}

function makeNameTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${FONT_SIZE_PX}px sans-serif`;
  const metrics = ctx.measureText(text);
  canvas.width  = Math.max(1, Math.ceil(metrics.width)) + PAD_X * 2;
  canvas.height = FONT_SIZE_PX + PAD_Y * 2;

  // Resizing the canvas resets ctx state — re-apply.
  ctx.font = `${FONT_SIZE_PX}px sans-serif`;
  ctx.textBaseline = "top";

  // Translucent pill background — keeps the label readable against any terrain.
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, 6);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillText(text, PAD_X, PAD_Y);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
