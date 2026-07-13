import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

/**
 * Cast bar (T-266) — fills while the local player channels a skill's windup,
 * derived from the networked action runtime (ActiveActions). Hidden when not
 * casting; when present, it's the topmost row of the shared `.action-frame`
 * dock (ui_manager.tsx, T-314) — it grows the frame upward above the vitals/
 * hotbar/skillbar rows rather than shifting them.
 */

const cast = computed(() => uiState.value.castState);

export function CastBar() {
  const c = cast.value;
  if (!c) return null;
  return (
    <div class="castbar">
      <div class="castbar-fill" style={{ width: `${c.frac * 100}%` }} />
      <span class="castbar-label">{c.label}</span>
    </div>
  );
}
