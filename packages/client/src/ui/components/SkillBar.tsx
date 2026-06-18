import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import { contentService } from "../content_ref.ts";
import { Slot } from "./primitives.tsx";

/**
 * The action bar — the player's four skill slots, bound to keys 1–4 (the
 * `ACTION_SKILL_1..4` input bits the translator already sends; see
 * intent_translator.ts). Display-only: pressing the number key activates the
 * skill server-side via SkillIntentResolver. Cooldowns aren't shown yet —
 * ActionCooldowns is server-only (a later wire add).
 *
 * A slot holds the id of a skill ActionDef (or null). ActionDefs carry no
 * authored label, so we derive one from the id (`skill_mend` → "Mend").
 */

const loadout = computed(() => uiState.value.skillLoadout);

/** `skill_fire_blast` → "Fire Blast". */
function skillLabel(actionId: string): string {
  return actionId
    .replace(/^skill_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function SkillBar() {
  const lo = loadout.value;
  // Render four slots whether or not the loadout has arrived, so the bar's
  // footprint is stable and the key hints are always visible.
  const slots = lo?.slots ?? [0, 1, 2, 3].map((index) => ({ index, actionId: null }));
  if (slots.every((s) => !s.actionId)) {
    // Nothing slotted — keep the bar present but unobtrusive rather than
    // popping in when the first skill is learned.
  }
  const svc = contentService.value;

  return (
    <div class="skillbar interactive" style={{
      position: "fixed", bottom: "36px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: "var(--z-hud)",
    }}>
      {slots.map((slot) => {
        const known = slot.actionId !== null && (!svc || svc.actions.get(slot.actionId) !== undefined);
        const label = slot.actionId ? skillLabel(slot.actionId) : "";
        return (
          <Slot key={slot.index} empty={!slot.actionId} title={label}>
            <span class="slot-key">{slot.index + 1}</span>
            {slot.actionId && known && (
              <span class="slot-glyph">{label.charAt(0)}</span>
            )}
          </Slot>
        );
      })}
    </div>
  );
}
