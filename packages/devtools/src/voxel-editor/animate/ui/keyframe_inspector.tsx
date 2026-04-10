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

const LABEL: preact.JSX.CSSProperties = { color: "#888", fontSize: 11, minWidth: 20 };
const INPUT: preact.JSX.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "2px 4px", borderRadius: 2, width: 64,
};
const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
  cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "2px 6px",
};

export function KeyframeInspector() {
  const clip = editingClip.value;
  const boneId = selectedBoneId.value;
  const kf = selectedKeyframe.value;
  const kfIdx = selectedKeyframeIdx.value;
  const kfs = selectedBoneKeyframes.value;
  const t = scrubTime.value;

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>KEYFRAME</span>
        <div style={{ display: "flex", gap: 4 }}>
          {clip && boneId && (
            <button style={BTN} onClick={() => addKeyframe(boneId, t)}>
              + At {(t * 100).toFixed(0)}%
            </button>
          )}
          {kf !== null && kfIdx !== null && boneId && (
            <button style={{ ...BTN, color: "#c66" }} onClick={() => deleteKeyframe(boneId, kfIdx)}>✕</button>
          )}
        </div>
      </div>

      {!boneId && (
        <div style={{ color: "#555", fontSize: 11 }}>Select a bone in the viewport or timeline.</div>
      )}

      {boneId && !kf && (
        <div style={{ color: "#555", fontSize: 11 }}>
          Bone: <span style={{ color: "#8bc" }}>{boneId}</span>
          <br />{kfs.length} keyframe{kfs.length !== 1 ? "s" : ""}. Click + to add one at scrub time.
        </div>
      )}

      {boneId && kf !== null && kfIdx !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 10, color: "#666" }}>
            Bone: <span style={{ color: "#8bc" }}>{boneId}</span>
            {" | "}#{kfIdx}/{kfs.length - 1}
            {" | "}t={kf.time.toFixed(3)}
          </div>

          {(["rotX", "rotY", "rotZ"] as const).map((field) => (
            <div key={field} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={LABEL}>{field.slice(-1)}</span>
              <input
                type="number"
                step="1"
                style={INPUT}
                value={(kf[field] * R2D).toFixed(1)}
                onBlur={(e) => {
                  const deg = parseFloat((e.target as HTMLInputElement).value);
                  if (!isNaN(deg)) updateKeyframeRotation(boneId, kfIdx, { [field]: deg * D2R });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <span style={{ fontSize: 10, color: "#555" }}>°</span>
              <span style={{ fontSize: 10, color: "#444" }}>({kf[field].toFixed(3)} rad)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
