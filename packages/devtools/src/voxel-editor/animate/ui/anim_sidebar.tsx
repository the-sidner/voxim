/**
 * Animation editor right sidebar — skeleton picker, clip panel, keyframe inspector, export.
 */
import type { SkeletonDef } from "@voxim/content";
import { editingSkeleton, loadSkeleton } from "../anim_state.ts";
import { ClipPanel } from "./clip_panel.tsx";
import { KeyframeInspector } from "./keyframe_inspector.tsx";
import { AnimExportPanel } from "./anim_export_panel.tsx";

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "2px 5px", borderRadius: 3, width: "100%",
};

interface Props {
  skeletons: SkeletonDef[];
}

export function AnimSidebar({ skeletons }: Props) {
  const sk = editingSkeleton.value;

  return (
    <div style={{
      width: 220, flexShrink: 0, background: "#1e1e1e",
      borderLeft: "1px solid #333", overflowY: "auto",
      display: "flex", flexDirection: "column",
    }}>
      {/* Skeleton selector */}
      <div style={{ padding: 8, borderBottom: "1px solid #333" }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4, fontWeight: "bold" }}>SKELETON</div>
        <select
          style={INPUT}
          value={sk?.id ?? ""}
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            const found = skeletons.find((s) => s.id === id);
            if (found) loadSkeleton(found);
          }}
        >
          <option value="">— select —</option>
          {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
        {sk && (
          <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>
            {sk.bones.length} bones · {sk.clips?.length ?? 0} clips
          </div>
        )}
      </div>

      <ClipPanel />
      <KeyframeInspector />
      <AnimExportPanel />
    </div>
  );
}
