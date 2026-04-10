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
    // Try to get procedural texture via offscreen canvas copy
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
      title={`${mat.name} (id=${mat.id})`}
      onClick={() => { activeMaterial.value = mat.id; }}
      style={{
        cursor: "pointer",
        border: active ? "2px solid #fff" : "2px solid transparent",
        borderRadius: 3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: 2,
        background: active ? "#333" : "transparent",
      }}
    >
      <canvas ref={canvasRef} width={32} height={32} style={{ display: "block", imageRendering: "pixelated" }} />
      <span style={{ fontSize: 9, color: "#aaa", maxWidth: 36, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {mat.name}
      </span>
    </div>
  );
}

export function MaterialPanel({ materials }: Props) {
  return (
    <div style={{ padding: 8, overflow: "auto", flex: 1 }}>
      <div style={{ fontSize: 11, color: "#888", marginBottom: 6, fontWeight: "bold" }}>MATERIALS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {materials.map((m) => <Swatch key={m.id} mat={m} />)}
      </div>
    </div>
  );
}
