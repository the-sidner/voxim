/**
 * Phase-window derivation (T-327) — pure functions that read an ActionDef's
 * declared `phases` + `effects` and answer "which phases does window X span"
 * for the Phases panel's timeline. No new content vocabulary: everything
 * here is already how i-frame/block/hitbox-live windows are AUTHORED (a
 * `set_tag`/`clear_tag` pair, or a `weapon_trace` effect edge) — this just
 * reads that shape back out generically instead of hardcoding "dash"/"hold".
 */
import type { ActionDefSummary } from "../shell/content_loader.ts";

export interface PhaseWindow {
  /** "hitbox-live" for a weapon_trace window, else the set_tag tag name
   *  (e.g. "iframe", "blocking"). */
  label: string;
  fromPhase: string;
  toPhase: string;
}

interface ParsedEffectRef {
  phase: string;
  edge: "enter" | "exit" | "tick";
  kind: string;
  params?: Record<string, unknown>;
}

function parseEffects(def: ActionDefSummary): ParsedEffectRef[] {
  const out: ParsedEffectRef[] = [];
  for (const e of def.effects) {
    const sep = e.phase.lastIndexOf(":");
    if (sep < 0) continue;
    const phase = e.phase.slice(0, sep);
    const edge = e.phase.slice(sep + 1) as ParsedEffectRef["edge"];
    out.push({ phase, edge, kind: e.kind, params: e.params });
  }
  return out;
}

/**
 * Every window an ActionDef declares: one entry per phase carrying a
 * `weapon_trace` effect (labelled "hitbox-live"), plus one entry per
 * set_tag/clear_tag pair (labelled by the tag name — "iframe", "blocking",
 * or any future one) spanning from the phase that sets it to the phase that
 * clears it, in the def's DECLARED phase order (not effects array order —
 * `phases` key order is the timeline's left-to-right order per doctrine).
 * A tag set but never cleared (an ambient action's perpetual hold, e.g.
 * block.json) spans to the last declared phase.
 */
export function derivePhaseWindows(def: ActionDefSummary): PhaseWindow[] {
  const phaseNames = Object.keys(def.phases);
  const effects = parseEffects(def);
  const windows: PhaseWindow[] = [];

  const hitboxPhases = new Set(
    effects.filter((e) => e.kind === "weapon_trace" && (e.edge === "enter" || e.edge === "tick")).map((e) => e.phase),
  );
  for (const phase of phaseNames) {
    if (hitboxPhases.has(phase)) windows.push({ label: "hitbox-live", fromPhase: phase, toPhase: phase });
  }

  const openTag = new Map<string, string>(); // tag -> phase where it was set
  for (const phase of phaseNames) {
    for (const e of effects) {
      if (e.phase !== phase) continue;
      if (e.kind === "set_tag" && e.edge === "enter") {
        const tag = e.params?.tag;
        if (typeof tag === "string") openTag.set(tag, phase);
      } else if (e.kind === "clear_tag" && e.edge === "exit") {
        const tag = e.params?.tag;
        if (typeof tag === "string" && openTag.has(tag)) {
          windows.push({ label: tag, fromPhase: openTag.get(tag)!, toPhase: phase });
          openTag.delete(tag);
        }
      }
    }
  }
  const lastPhase = phaseNames[phaseNames.length - 1];
  for (const [tag, from] of openTag) {
    windows.push({ label: tag, fromPhase: from, toPhase: lastPhase });
  }

  return windows;
}

/** True if `phase` falls within [window.fromPhase, window.toPhase] in the
 *  def's declared phase order (inclusive both ends). */
export function windowCoversPhase(def: ActionDefSummary, window: PhaseWindow, phase: string): boolean {
  const order = Object.keys(def.phases);
  const from = order.indexOf(window.fromPhase);
  const to = order.indexOf(window.toPhase);
  const at = order.indexOf(phase);
  if (from < 0 || to < 0 || at < 0) return false;
  return at >= from && at <= to;
}

/** The first `weaponActionId` a `weapon_trace` effect pins via params (T-254
 *  signature moves, e.g. sword_overhead -> "overhead"). Generic swings
 *  (swing_medium etc.) resolve their weapon geometry dynamically from
 *  whatever's equipped, so they pin nothing — the panel falls back to a
 *  manual weapon-action picker in that case. */
export function pinnedWeaponActionId(def: ActionDefSummary): string | null {
  for (const e of def.effects) {
    if (e.kind !== "weapon_trace") continue;
    const id = e.params?.weaponActionId;
    if (typeof id === "string") return id;
  }
  return null;
}
