/**
 * Animation editor right sidebar — skeleton picker, clip panel, keyframe inspector, export.
 */
import type { SkeletonDef } from "@voxim/content";
import { editingSkeleton, loadSkeleton } from "../anim_state.ts";
import { ClipPanel } from "./clip_panel.tsx";
import { KeyframeInspector } from "./keyframe_inspector.tsx";
import { AnimExportPanel } from "./anim_export_panel.tsx";

interface Props {
  skeletons: SkeletonDef[];
}

export function AnimSidebar({ skeletons }: Props) {
  const sk = editingSkeleton.value;

  return (
    <div class="dt-sidebar">
      <div class="dt-section">
        <div class="dt-section-header">Skeleton</div>
        <select
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
          <div class="flavour">
            <span class="num">{sk.bones.length}</span> bones · <span class="num">{sk.clips?.length ?? 0}</span> clips
          </div>
        )}
      </div>

      <ClipPanel />
      <KeyframeInspector />
      <AnimExportPanel />
    </div>
  );
}
