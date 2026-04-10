/**
 * Playback controls — play/pause button, scrub slider, time readout.
 */
import { editingClip, scrubTime, isPlaying, selectedBoneId } from "../anim_state.ts";

const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#ccc",
  cursor: "pointer", borderRadius: 2, fontSize: 12, padding: "3px 10px",
  fontFamily: "monospace",
};
const BTN_ACTIVE: preact.JSX.CSSProperties = {
  ...BTN, background: "#4a7c3f", borderColor: "#6aac5f",
};

export function PlaybackPanel() {
  const clip = editingClip.value;
  const t = scrubTime.value;
  const playing = isPlaying.value;
  const dur = clip?.durationSeconds ?? 1.0;
  const currentSec = (t * dur).toFixed(2);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 8px", background: "#1e1e1e", borderBottom: "1px solid #333",
      flexShrink: 0,
    }}>
      <button
        style={playing ? BTN_ACTIVE : BTN}
        onClick={() => { isPlaying.value = !playing; }}
      >
        {playing ? "⏸ Pause" : "▶ Play"}
      </button>

      <input
        type="range"
        min={0} max={1} step={0.001}
        value={t}
        onInput={(e) => {
          isPlaying.value = false;
          scrubTime.value = parseFloat((e.target as HTMLInputElement).value);
        }}
        style={{ flex: 1, accentColor: "#4a7c3f" }}
      />

      <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace", minWidth: 80, textAlign: "right" }}>
        {currentSec}s / {dur.toFixed(2)}s
      </span>

      {selectedBoneId.value && (
        <span style={{ fontSize: 11, color: "#4a9c3f", fontFamily: "monospace" }}>
          [{selectedBoneId.value}]
        </span>
      )}
    </div>
  );
}
