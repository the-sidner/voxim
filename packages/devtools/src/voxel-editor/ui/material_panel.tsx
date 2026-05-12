/** Scrollable material picker with colored swatches. */
import { useEffect, useRef } from "preact/hooks";
import type { MaterialDef } from "@voxim/content";
import { activeMaterial } from "../state.ts";
import { getVoxelTexture } from "../../../../client/src/render/material_textures.ts";

interface Props {
  materials: MaterialDef[];
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function Swatch({ mat }: { mat: MaterialDef }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = activeMaterial.value === mat.id;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const tex = getVoxelTexture(mat.id, mat.color);
    if (tex && tex.image instanceof HTMLCanvasElement) {
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(tex.image, 0, 0, 32, 32);
    } else {
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = hexColor(mat.color);
      ctx.fillRect(0, 0, 32, 32);
    }
  }, [mat.id, mat.color]);

  return (
    <div
      class={`dt-swatch ${active ? "is-active" : ""}`}
      title={`${mat.name} (id=${mat.id})`}
      onClick={() => { activeMaterial.value = mat.id; }}
    >
      <canvas ref={canvasRef} width={32} height={32} style={{ display: "block", imageRendering: "pixelated" }} />
      <span class="name">{mat.name}</span>
    </div>
  );
}

export function MaterialPanel({ materials }: Props) {
  return (
    <div class="dt-section" style={{ overflow: "auto" }}>
      <div class="dt-section-header">Materials</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-1)" }}>
        {materials.map((m) => <Swatch key={m.id} mat={m} />)}
      </div>
    </div>
  );
}
