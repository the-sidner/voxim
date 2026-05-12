/// <reference lib="dom" />
/**
 * Top-right minimap showing the full 512×512 tile and the player's exploration
 * progress (T-157). Reads the renderer's FogOfWar instance via {@link fogRef};
 * the player marker is sourced from `fog.lastPlayer`, which game.ts updates
 * each frame as part of the LOS update.
 *
 * Pixel grid is downsampled to MINIMAP_SIZE × MINIMAP_SIZE using nearest-cell
 * sampling: cheap and the geometry of the cells is what we care about. The
 * canvas is redrawn at ~10 Hz from a requestAnimationFrame loop.
 *
 * Visual chrome follows the Dreamborn minimap recipe: pressed-metal frame,
 * 160² square, fog from the edges, north tick along the top edge. The
 * canvas itself is rendered into a hairline-bordered well.
 */
import { useEffect, useRef } from "preact/hooks";
import { fogRef } from "../fog_ref.ts";
import { FOG_GRID_SIZE, FOG_CELL_SIZE } from "@voxim/protocol";

const TILE_WORLD_SIZE = FOG_GRID_SIZE * FOG_CELL_SIZE;

const MINIMAP_SIZE = 160;
const REDRAW_INTERVAL_MS = 100;

// Channel colours match the dark-side palette so the minimap doesn't bloom.
const COL_UNSEEN  = [7, 6, 3];        // peat-solid
const COL_SEEN    = [38, 36, 26];     // moss-hov-ish, very dim
const COL_VISIBLE = [80, 78, 60];     // lichen at low value
const COL_PLAYER  = "rgb(217, 120, 38)";  // ember
const COL_BORDER  = "rgb(63, 62, 42)";    // line-bright

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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

      // Inner hairline frame.
      ctx.strokeStyle = COL_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, MINIMAP_SIZE - 1, MINIMAP_SIZE - 1);

      // North-edge bearing ticks (every 12 px).
      ctx.strokeStyle = "rgba(100, 95, 77, 0.7)";
      for (let i = 0; i < 12; i++) {
        const x = 10 + i * 14;
        const h = i % 3 === 0 ? 6 : 3;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0.5);
        ctx.lineTo(x + 0.5, h + 0.5);
        ctx.stroke();
      }

      const player = fog.lastPlayer;
      if (player) {
        const cx = (player.x / TILE_WORLD_SIZE) * MINIMAP_SIZE;
        const cy = (player.y / TILE_WORLD_SIZE) * MINIMAP_SIZE;

        const r = 6;
        const a = player.facing;
        const tipX = cx + Math.cos(a) * r;
        const tipY = cy + Math.sin(a) * r;
        const half = 0.5;
        const blX = cx + Math.cos(a + Math.PI - half) * (r * 0.6);
        const blY = cy + Math.sin(a + Math.PI - half) * (r * 0.6);
        const brX = cx + Math.cos(a + Math.PI + half) * (r * 0.6);
        const brY = cy + Math.sin(a + Math.PI + half) * (r * 0.6);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(blX, blY);
        ctx.lineTo(brX, brY);
        ctx.closePath();
        ctx.fillStyle = COL_PLAYER;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
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
    <div
      class="hud-chrome"
      style={{
        position: "fixed",
        top: "var(--s-4)",
        right: "var(--s-4)",
        width: `${MINIMAP_SIZE + 12}px`,
        padding: "var(--s-1)",
        zIndex: "var(--z-hud)",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-1)",
      }}
    >
      <canvas
        ref={canvasRef}
        width={MINIMAP_SIZE}
        height={MINIMAP_SIZE}
        style={{
          display: "block",
          width: `${MINIMAP_SIZE}px`,
          height: `${MINIMAP_SIZE}px`,
          imageRendering: "pixelated",
          border: "1px solid var(--line)",
          boxShadow: "var(--inset-well)",
        }}
      />
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-eyebrow)",
        letterSpacing: "var(--ls-eyebrow)",
        textTransform: "uppercase",
        color: "var(--bone-faint)",
        padding: "0 var(--s-1)",
      }}>
        <span>N</span>
        <span class="num">0,0</span>
      </div>
    </div>
  );
}
