/**
 * Keyframe Inspector — edit rotX/Y/Z for the selected keyframe.
 * Shows values in degrees (converted from radians internally).
 */
import {
  editingClip, selectedBoneId, selectedBoneKeyframes, selectedKeyframe, selectedKeyframeIdx,
  addKeyframe, updateKeyframeRotation, deleteKeyframe, scrubTime,
} from "../anim_state.ts";

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

export function KeyframeInspector() {
  const clip = editingClip.value;
  const boneId = selectedBoneId.value;
  const kf = selectedKeyframe.value;
  const kfIdx = selectedKeyframeIdx.value;
  const kfs = selectedBoneKeyframes.value;
  const t = scrubTime.value;

  return (
    <div class="dt-section">
      <div class="dt-section-header">
        <span>Keyframe</span>
        <div style={{ display: "flex", gap: "var(--s-1)" }}>
          {clip && boneId && (
            <button class="btn xs" onClick={() => addKeyframe(boneId, t)}>
              + At <span class="num">{(t * 100).toFixed(0)}%</span>
            </button>
          )}
          {kf !== null && kfIdx !== null && boneId && (
            <button class="btn xs ghost danger" onClick={() => deleteKeyframe(boneId, kfIdx)}>✕</button>
          )}
        </div>
      </div>

      {!boneId && (
        <span class="flavour">Select a bone in the viewport or timeline.</span>
      )}

      {boneId && !kf && (
        <div class="flavour">
          Bone: <span class="num text-info">{boneId}</span>
          <br /><span class="num">{kfs.length}</span> keyframe{kfs.length !== 1 ? "s" : ""}. Click + to add one at scrub time.
        </div>
      )}

      {boneId && kf !== null && kfIdx !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-1)" }}>
          <div class="eyebrow">
            Bone: <span class="num text-info">{boneId}</span>
            {" · "}#<span class="num">{kfIdx}</span>/{kfs.length - 1}
            {" · t="}<span class="num">{kf.time.toFixed(3)}</span>
          </div>

          {(["rotX", "rotY", "rotZ"] as const).map((field) => (
            <div key={field} style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
              <span class="eyebrow" style={{ minWidth: 16 }}>{field.slice(-1)}</span>
              <input
                type="number"
                step="1"
                style={{ width: 72 }}
                value={(kf[field] * R2D).toFixed(1)}
                onBlur={(e) => {
                  const deg = parseFloat((e.target as HTMLInputElement).value);
                  if (!isNaN(deg)) updateKeyframeRotation(boneId, kfIdx, { [field]: deg * D2R });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <span class="text-dim" style={{ fontSize: 10 }}>°</span>
              <span class="num text-dim" style={{ fontSize: 10 }}>({kf[field].toFixed(3)} rad)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
