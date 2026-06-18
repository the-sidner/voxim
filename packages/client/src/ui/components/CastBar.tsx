import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

/**
 * Cast bar (T-266) — fills while the local player channels a skill's windup,
 * derived from the networked action runtime (ActiveActions). Hidden when not
 * casting. Sits just above the action bars, centred.
 */

const cast = computed(() => uiState.value.castState);

export function CastBar() {
  const c = cast.value;
  if (!c) return null;
  return (
    <div class="castbar" style={{
      position: "fixed", bottom: "128px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: "var(--z-hud)",
    }}>
      <div class="castbar-fill" style={{ width: `${c.frac * 100}%` }} />
      <span class="castbar-label">{c.label}</span>
    </div>
  );
}
