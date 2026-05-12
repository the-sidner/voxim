/**
 * Playback controls — play/pause button, scrub slider, time readout.
 */
import { editingClip, scrubTime, isPlaying, selectedBoneId } from "../anim_state.ts";

export function PlaybackPanel() {
  const clip = editingClip.value;
  const t = scrubTime.value;
  const playing = isPlaying.value;
  const dur = clip?.durationSeconds ?? 1.0;
  const currentSec = (t * dur).toFixed(2);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "var(--s-3)",
      padding: "var(--s-2) var(--s-3)",
      flex: 1,
    }}>
      <button
        class={`btn sm ${playing ? "primary" : ""}`}
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
        style={{ flex: 1 }}
      />

      <span class="num text-dim" style={{ minWidth: 90, textAlign: "right" }}>
        {currentSec}s / {dur.toFixed(2)}s
      </span>

      {selectedBoneId.value && (
        <span class="num" style={{ color: "var(--ember-hi)" }}>
          [{selectedBoneId.value}]
        </span>
      )}
    </div>
  );
}
