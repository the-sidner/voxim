/**
 * Pure wire→UI mapper functions: decoded component data in, UI-store shapes
 * out. Shared by game.ts's initial hydration pass (start()) and the
 * per-message connection handlers (connection/wire_handlers.ts). No signal
 * writes happen here — callers patch the store.
 */
import type { ActiveActionsData, EquipmentData, InventoryData, LoreLoadoutData, ResourceData } from "@voxim/codecs";
import type { EquipmentState, InventoryState, ItemStack, SkillLoadoutState, UIState } from "../ui/ui_store.ts";
import type { ContentService, GameConfig, SwingableData, ToolData } from "@voxim/content";
import type { ClientWorld } from "./client_world.ts";
import { humanizeItemType } from "../ui/item_names.ts";

/**
 * Map a server EquipmentData into the EquipmentState shape the UI expects.
 */
export function mapEquipmentToUI(eq: EquipmentData): EquipmentState {
  function toStack(slot: EquipmentData["weapon"]): ItemStack | null {
    if (!slot) return null;
    return {
      itemType: slot.prefabId,
      quantity: 1,
      displayName: humanizeItemType(slot.prefabId),
      modelTemplateId: null,
    };
  }
  return {
    weapon:  toStack(eq.weapon),
    offHand: toStack(eq.offHand),
    head:    toStack(eq.head),
    chest:   toStack(eq.chest),
    legs:    toStack(eq.legs),
    feet:    toStack(eq.feet),
    back:    toStack(eq.back),
  };
}

/**
 * Derive a day-phase name from raw WorldClock fields — the ONE client-side
 * day-phase source (renderer.setDayPhase's only writer). Boundaries come from
 * the same content values the server's DayNightSystem reads
 * (game_config.dayNight.dawnStart/noonStart/duskStart), so tuning them
 * server-side moves the client's lighting phase in lockstep with the
 * DayPhaseChanged toast. Defaults hold pre-bootstrap.
 */
export function worldClockPhase(
  ticksElapsed: number,
  dayLengthTicks: number,
  dayNight?: Pick<GameConfig["dayNight"], "dawnStart" | "noonStart" | "duskStart">,
): string {
  const t = (ticksElapsed % dayLengthTicks) / dayLengthTicks;
  if (t < (dayNight?.dawnStart ?? 0.25)) return "midnight";
  if (t < (dayNight?.noonStart ?? 0.5))  return "dawn";
  if (t < (dayNight?.duskStart ?? 0.75)) return "noon";
  return "dusk";
}

/**
 * Map the local player's Resource component to the HUD vital bars (T-262).
 * Stamina/hunger come from the keyed scalars; `exhausted` is derived (the
 * server-side exhausted flag was retired with the Resource primitive).
 */
export function vitalsPatch(resource: ResourceData): Partial<UIState> {
  const patch: Partial<UIState> = {};
  const s = resource.values.stamina;
  if (s) patch.stamina = { current: s.value, max: s.max, exhausted: s.value <= 0 };
  const h = resource.values.hunger;
  if (h) patch.hunger = { value: h.value };
  return patch;
}

/**
 * Map a server LoreLoadoutData into the SkillLoadoutState shape the UI expects.
 * A slot is the id of a skill ActionDef (or null); cooldowns come from the
 * networked ActionCooldowns component (T-265), keyed by action id.
 */
export function mapLoreLoadoutToUI(loadout: LoreLoadoutData): SkillLoadoutState {
  return {
    slots: loadout.skills.map((actionId, index) => ({ index, actionId: actionId ?? null })),
    learnedFragmentIds: loadout.learnedFragmentIds,
  };
}

/**
 * Derive the cast-bar state from the action runtime (T-266): the local player
 * is "casting" while its primary slot runs an active-kind action in its windup
 * phase. Instant actions (≤1 windup tick) show no bar. Null when not casting.
 */
export function deriveCastState(
  actions: ActiveActionsData,
  content: ContentService | null,
): { label: string; frac: number } | null {
  const slot = actions.states["primary"];
  if (!slot) return null;
  const def = content?.actions.get(slot.actionId);
  if (!def || (def.kind !== "active" && def.kind !== "ambient")) return null;
  const phase = def.phases?.[slot.phase];
  if (!phase) return null;
  const label = slot.actionId
    .replace(/^skill_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  // T-337: a perpetual phase (hold-to-aim's `ticks: -1`) reads as a FULL
  // bar — "charged, ready to release" — regardless of how long the actor
  // has been holding. Checked generically via the CURRENT phase's own
  // ticks, not hardcoded to "windup" or a phase index, so it applies to any
  // hold action whichever phase name it uses.
  if (phase.ticks === -1) return { label, frac: 1 };
  // Skills: progressive fill during their windup only (unchanged).
  if (def.kind !== "active" || slot.phase !== "windup") return null;
  const total = phase.ticks;
  if (total <= 1) return null;
  return { label, frac: Math.min(1, slot.ticksInPhase / total) };
}

export function getToolType(prefabId: string | undefined, content: ContentService | null): string | undefined {
  if (!prefabId || !content) return undefined;
  const prefab = content.prefabs.get(prefabId);
  const tool = prefab?.components.tool as ToolData | undefined;
  return tool?.toolType;
}

/**
 * T-337: true when the equipped weapon's swingActionId resolves to a
 * hold-to-aim ActionDef (kind:"ambient" + releaseActionId set). Mirrors the
 * SAME resolution PrimaryIntentResolver performs server-side (swingable
 * .swingActionId, default "swing_light") — client and server must agree on
 * which weapons are hold-to-aim, or the input path (this flag) and the
 * dispatcher's own branch would disagree about what a press means.
 */
export function isHoldToAimWeapon(prefabId: string | undefined, content: ContentService | null): boolean {
  if (!prefabId || !content) return false;
  const swingable = content.prefabs.get(prefabId)?.components["swingable"] as SwingableData | undefined;
  const swingActionId = swingable?.swingActionId ?? "swing_light";
  const def = content.actions.get(swingActionId);
  return !!def?.releaseActionId;
}

/**
 * Map a server InventoryData into the InventoryState shape the UI expects.
 * The slots array is padded to capacity with nulls so the grid always renders
 * the correct number of cells regardless of how many items are present.
 */
export function mapInventoryToUI(inv: InventoryData, world: ClientWorld): InventoryState {
  const slots: (ItemStack | null)[] = inv.slots.map((s) => {
    if (s.kind === "stack") {
      return {
        itemType: s.prefabId,
        quantity: s.quantity,
        displayName: humanizeItemType(s.prefabId),
        modelTemplateId: null,
      };
    } else {
      // Unique item entity — pull its prefab id from the entity's ItemData
      // component so the UI shows a proper name and the tooltip can locate
      // the entity for stat/provenance lookup.
      const entity = world.get(s.entityId);
      const prefabId = entity?.itemData?.prefabId ?? "";
      return {
        itemType: prefabId,
        quantity: 1,
        displayName: prefabId ? humanizeItemType(prefabId) : "(item)",
        modelTemplateId: null,
        entityId: s.entityId,
      };
    }
  });
  while (slots.length < inv.capacity) slots.push(null);
  return { slots, maxSlots: inv.capacity };
}
