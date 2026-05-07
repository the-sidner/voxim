/// <reference lib="dom" />
/**
 * Top-right minimap showing the full 512×512 tile and the player's exploration
 * progress (T-157).  Reads the renderer's FogOfWar instance via {@link fogRef};
 * the player marker is sourced from `fog.lastPlayer`, which game.ts updates
 * each frame as part of the LOS update.
 *
 * Pixel grid is downsampled to MINIMAP_SIZE × MINIMAP_SIZE using nearest-cell
 * sampling: cheap and the geometry of the cells is what we care about.  The
 * canvas is redrawn at ~10 Hz from a requestAnimationFrame loop — enough for
 * a "where am I going" feel without burning the main thread on every frame.
 */
import { useEffect, useRef } from "preact/hooks";
import { fogRef } from "../fog_ref.ts";
import { FOG_GRID_SIZE, FOG_CELL_SIZE } from "@voxim/protocol";

/** Tile size in world units (== FOG_GRID_SIZE * FOG_CELL_SIZE). */
const TILE_WORLD_SIZE = FOG_GRID_SIZE * FOG_CELL_SIZE;

const MINIMAP_SIZE = 200;
/** Redraw cadence — 10 Hz is plenty for exploration feel. */
const REDRAW_INTERVAL_MS = 100;

const COL_UNSEEN  = [12, 12, 14];      // near-black background
const COL_SEEN    = [80, 80, 92];      // dim grey — explored
const COL_VISIBLE = [200, 200, 220];   // bright — currently in LOS
const COL_PLAYER  = "rgb(255, 220, 90)";
const COL_BORDER  = "rgba(220, 220, 220, 0.35)";

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Backbuffer at MINIMAP_SIZE × MINIMAP_SIZE — drawn into ImageData once
    // per redraw, then blitted with putImageData.  Player marker is painted
    // on top with regular canvas commands at a separate scale.
    const img = ctx.createImageData(MINIMAP_SIZE, MINIMAP_SIZE);

    let lastDraw = 0;
    let lastVersion = -1;
    let raf = 0;
    let stopped = false;

    const draw = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(draw);

      const fog = fogRef.value;
      if (!fog) return;
      if (now - lastDraw < REDRAW_INTERVAL_MS && fog.version === lastVersion) return;
      lastDraw = now;
      lastVersion = fog.version;

      // Downsample fog state to MINIMAP_SIZE × MINIMAP_SIZE.  Fog is 256² and
      // the canvas is 200² → 1.28 source cells per dest pixel.  Sampling the
      // nearest cell is fine — players aren't reading individual cells, they
      // want the silhouette of where they've been.  Both grids are bit-packed.
      const data = img.data;
      const scale = FOG_GRID_SIZE / MINIMAP_SIZE;
      let p = 0;
      for (let py = 0; py < MINIMAP_SIZE; py++) {
        const sy = Math.floor(py * scale);
        const rowBase = sy * FOG_GRID_SIZE;
        for (let px = 0; px < MINIMAP_SIZE; px++) {
          const sx = Math.floor(px * scale);
          const idx = rowBase + sx;
          const col = fog.isVisible(idx) ? COL_VISIBLE : (fog.isSeen(idx) ? COL_SEEN : COL_UNSEEN);
          data[p++] = col[0];
          data[p++] = col[1];
          data[p++] = col[2];
          data[p++] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // Border + player marker.
      ctx.strokeStyle = COL_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, MINIMAP_SIZE - 1, MINIMAP_SIZE - 1);

      const player = fog.lastPlayer;
      if (player) {
        const cx = (player.x / TILE_WORLD_SIZE) * MINIMAP_SIZE;
        const cy = (player.y / TILE_WORLD_SIZE) * MINIMAP_SIZE;

        // Facing wedge — short triangle in the look direction.
        const r = 7;
        const a = player.facing;
        const tipX = cx + Math.cos(a) * r;
        const tipY = cy + Math.sin(a) * r;
        const halfSpread = 0.5; // ~57°
        const blX = cx + Math.cos(a + Math.PI - halfSpread) * (r * 0.6);
        const blY = cy + Math.sin(a + Math.PI - halfSpread) * (r * 0.6);
        const brX = cx + Math.cos(a + Math.PI + halfSpread) * (r * 0.6);
        const brY = cy + Math.sin(a + Math.PI + halfSpread) * (r * 0.6);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(blX, blY);
        ctx.lineTo(brX, brY);
        ctx.closePath();
        ctx.fillStyle = COL_PLAYER;
        ctx.fill();

        // Player dot.
        ctx.beginPath();
        ctx.arc(cx, cy, 2.0, 0, Math.PI * 2);
        ctx.fillStyle = COL_PLAYER;
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div style={{
      position: "fixed",
      top: "12px",
      right: "12px",
      width: `${MINIMAP_SIZE}px`,
      height: `${MINIMAP_SIZE}px`,
      background: "rgba(0, 0, 0, 0.55)",
      border: "1px solid rgba(220, 220, 220, 0.25)",
      borderRadius: "4px",
      overflow: "hidden",
      zIndex: "var(--z-hud)",
      pointerEvents: "none",
    }}>
      <canvas
        ref={canvasRef}
        width={MINIMAP_SIZE}
        height={MINIMAP_SIZE}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
