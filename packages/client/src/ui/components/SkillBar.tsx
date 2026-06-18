import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import { contentService } from "../content_ref.ts";
import { Slot } from "./primitives.tsx";

/**
 * The action bar — the player's four skill slots, bound to keys 1–4 (the
 * `ACTION_SKILL_1..4` input bits the translator sends). Pressing the number
 * key activates the skill server-side via SkillIntentResolver; this bar is the
 * visual readout, including a cooldown sweep from the networked ActionCooldowns
 * (T-265): a bottom-up fill covering the remaining fraction, plus the seconds
 * left. A slot is locked by the larger of its per-action cooldown and the GCD.
 *
 * A slot holds the id of a skill ActionDef (or null). ActionDefs carry no
 * authored label, so we derive one from the id (`skill_mend` → "Mend").
 */

const TICK_HZ = 20;

const loadout   = computed(() => uiState.value.skillLoadout);
const cooldowns = computed(() => uiState.value.skillCooldowns);

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
  const cd = cooldowns.value;
  const svc = contentService.value;
  const gcdTotal = svc?.getGameConfig().lore.globalCooldownTicks ?? TICK_HZ;

  // Four slots whether or not the loadout has arrived, so the bar's footprint
  // and key hints are stable.
  const slots = lo?.slots ?? [0, 1, 2, 3].map((index) => ({ index, actionId: null as string | null }));

  return (
    <div class="skillbar interactive" style={{
      position: "fixed", bottom: "36px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: "var(--z-hud)",
    }}>
      {slots.map((slot) => {
        const actionId = slot.actionId;
        const label = actionId ? skillLabel(actionId) : "";

        // Cooldown: the slot is locked by max(per-action remaining, gcd). The
        // sweep fraction is measured against whichever drives the lock.
        let lockTicks = 0;
        let totalTicks = 0;
        if (actionId && cd) {
          const perAction = cd.remaining[actionId] ?? 0;
          const perTotal = svc?.actions.get(actionId)?.cooldownTicks ?? 0;
          if (perAction > 0 && perTotal > 0) { lockTicks = perAction; totalTicks = perTotal; }
          if (cd.gcd > lockTicks) { lockTicks = cd.gcd; totalTicks = gcdTotal; }
        }
        const fillFrac = lockTicks > 0 && totalTicks > 0 ? Math.min(1, lockTicks / totalTicks) : 0;
        const seconds = lockTicks / TICK_HZ;

        return (
          <Slot key={slot.index} empty={!actionId} title={label}>
            <span class="slot-key">{slot.index + 1}</span>
            {actionId && <span class="slot-glyph">{label.charAt(0)}</span>}
            {fillFrac > 0 && (
              <div class="slot-cd-fill" style={{ height: `${fillFrac * 100}%` }} />
            )}
            {seconds >= 0.1 && (
              <span class="slot-cd-text">{seconds >= 1 ? Math.ceil(seconds) : seconds.toFixed(1)}</span>
            )}
          </Slot>
        );
      })}
    </div>
  );
}
