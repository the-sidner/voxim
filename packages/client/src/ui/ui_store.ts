/// <reference lib="dom" />
/**
 * UIStore — signal-based state for the entire game UI.
 *
 * game.ts is the only writer.  All UI components read from here via
 * computed() or direct signal access — no prop drilling, no imperative
 * update calls scattered through game logic.
 *
 * Shape conventions:
 *   - Nullable fields are null when the player has no data yet (pre-spawn)
 *     or the feature is not active.
 *   - `openPanels` is a Set — a panel being in the set means it is visible.
 *   - `modalStack` drives ESC behaviour: pop the top entry to go back.
 */
import { signal, computed } from "@preact/signals";

// ── Item / slot types ──────────────────────────────────────────────────────────

export interface ItemStack {
  itemType: string;
  quantity: number;
  /** Derived display label, resolved client-side from content store. */
  displayName: string;
  /** Model template id for icon rendering (may be null while content loads). */
  modelTemplateId: string | null;
}

export interface EquipmentState {
  weapon:    ItemStack | null;
  offHand:   ItemStack | null;
  head:      ItemStack | null;
  chest:     ItemStack | null;
  legs:      ItemStack | null;
  feet:      ItemStack | null;
  back:      ItemStack | null;
}

export interface InventoryState {
  /** Ordered list of item stacks; sparse (null = empty slot). */
  slots: (ItemStack | null)[];
  maxSlots: number;
}

export interface HotbarState {
  /** 8 quick-access slots mirroring specific inventory indices. */
  slots: (ItemStack | null)[];
  activeIndex: number;
}

// ── Vitals ─────────────────────────────────────────────────────────────────────

export interface VitalBar {
  current: number;
  max: number;
}

// ── Stats ──────────────────────────────────────────────────────────────────────

export interface PlayerStatsState {
  level:      number;
  experience: number;
  nextLevel:  number;
  strength:   number;
  endurance:  number;
  agility:    number;
  lore:       number;
  /** Derived combat stats shown in the panel. */
  derived: {
    attackDamage:  number;
    attackSpeed:   number;
    defense:       number;
    moveSpeed:     number;
    carryCapacity: number;
  };
}

// ── Skills ─────────────────────────────────────────────────────────────────────

export interface SkillSlot {
  index: number;
  verb:             string;
  outwardFragmentId: string | null;
  inwardFragmentId:  string | null;
  cooldownTicks:    number;
  maxCooldownTicks: number;
}

export interface SkillLoadoutState {
  slots: SkillSlot[];
}

// ── Crafting ───────────────────────────────────────────────────────────────────

export interface CraftingSlot {
  index: number;
  item: ItemStack | null;
}

export interface CraftingState {
  inputSlots:  CraftingSlot[];
  outputSlot:  ItemStack | null;
  /** Currently matching recipe id, or null if no valid recipe. */
  matchedRecipeId: string | null;
}

// ── Trader ─────────────────────────────────────────────────────────────────────

export interface TraderOffer {
  itemType:    string;
  displayName: string;
  priceCoin:   number;
  stock:       number | null;   // null = unlimited
}

export interface TraderState {
  npcId:        string;
  npcName:      string;
  buyOffers:    TraderOffer[];
  sellOffers:   TraderOffer[];
  playerCoins:  number;
}

// ── Dialogue ───────────────────────────────────────────────────────────────────

export interface DialogueChoice {
  index:  number;
  text:   string;
  /** null = no further dialogue after this choice. */
  nextNodeId: string | null;
}

export interface DialogueState {
  npcId:     string;
  npcName:   string;
  nodeId:    string;
  speakerText: string;
  choices:   DialogueChoice[];
}

// ── Drag/drop ──────────────────────────────────────────────────────────────────

export type DragSourceKind = "inventory" | "equipment" | "hotbar" | "crafting";

export interface DragState {
  item:        ItemStack;
  sourceKind:  DragSourceKind;
  sourceIndex: number;   // slot index within source panel
}

// ── Tooltip ────────────────────────────────────────────────────────────────────

export interface TooltipData {
  item:      ItemStack;
  screenX:   number;
  screenY:   number;
}

// ── Context menu ───────────────────────────────────────────────────────────────

export interface ContextMenuAction {
  label:    string;
  danger?:  boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  actions: ContextMenuAction[];
  screenX: number;
  screenY: number;
}

// ── Toast ──────────────────────────────────────────────────────────────────────

export type ToastKind = "info" | "success" | "warn" | "danger";

export interface Toast {
  id:      number;
  text:    string;
  kind:    ToastKind;
  /** performance.now() when this toast was created — used for TTL. */
  createdAt: number;
}

// ── Panel registry ─────────────────────────────────────────────────────────────

export type PanelId =
  | "inventory"
  | "equipment"
  | "stats"
  | "crafting"
  | "trader"
  | "dialogue"
  | "settings"
  | "death"
  | "debug"
  | "network";

// ── Root UIState ───────────────────────────────────────────────────────────────

export interface UIState {
  // Player vitals — null before first server snapshot
  health:  VitalBar | null;
  stamina: (VitalBar & { exhausted: boolean }) | null;
  hunger:  { value: number } | null;

  equipment:    EquipmentState | null;
  inventory:    InventoryState | null;
  hotbar:       HotbarState | null;
  stats:        PlayerStatsState | null;
  skillLoadout: SkillLoadoutState | null;

  // Active interactions (at most one of each at a time)
  crafting:     CraftingState | null;
  trader:       TraderState | null;
  dialogue:     DialogueState | null;

  // Panel visibility
  openPanels:  Set<PanelId>;
  /**
   * Ordered stack of open modal panels.  ESC pops the top entry.
   * Subset of openPanels — only panels that block game input.
   */
  modalStack:  PanelId[];

  // Transient UI state
  drag:        DragState | null;
  tooltip:     TooltipData | null;
  contextMenu: ContextMenuState | null;
  toasts:      Toast[];

  /** True while the initial world state is still loading. */
  loading: boolean;
  /** 0–1 loading progress (terrain chunks received / 256). */
  loadingProgress: number;
}

// ── Store singleton ────────────────────────────────────────────────────────────

const _initial: UIState = {
  health:      null,
  stamina:     null,
  hunger:      null,
  equipment:   null,
  inventory:   null,
  hotbar:      { slots: Array(8).fill(null) as (null)[], activeIndex: 0 },
  stats:       null,
  skillLoadout: null,
  crafting:    null,
  trader:      null,
  dialogue:    null,
  openPanels:  new Set(),
  modalStack:  [],
  drag:        null,
  tooltip:     null,
  contextMenu: null,
  toasts:      [],
  loading:          true,
  loadingProgress:  0,
};

export const uiState = signal<UIState>({ ..._initial });

// ── Patch helper ───────────────────────────────────────────────────────────────

/**
 * Merge a partial update into uiState.  Triggers reactive re-renders only
 * for components that read the changed fields.
 *
 * Usage (from game.ts):
 *   patchUI({ health: { current: 80, max: 100 } });
 */
export function patchUI(partial: Partial<UIState>): void {
  uiState.value = { ...uiState.value, ...partial };
}

// ── Panel helpers ──────────────────────────────────────────────────────────────

export function openPanel(id: PanelId, isModal = false): void {
  const next = new Set(uiState.value.openPanels);
  next.add(id);
  const stack = isModal
    ? [...uiState.value.modalStack, id]
    : uiState.value.modalStack;
  uiState.value = { ...uiState.value, openPanels: next, modalStack: stack };
}

export function closePanel(id: PanelId): void {
  const next = new Set(uiState.value.openPanels);
  next.delete(id);
  const stack = uiState.value.modalStack.filter((p) => p !== id);
  uiState.value = { ...uiState.value, openPanels: next, modalStack: stack };
}

export function closeTopModal(): void {
  const stack = uiState.value.modalStack;
  if (stack.length === 0) return;
  closePanel(stack[stack.length - 1]);
}

// ── Toast helper ───────────────────────────────────────────────────────────────

let _toastSeq = 0;
const TOAST_TTL_MS = 3500;

export function pushToast(text: string, kind: ToastKind = "info"): void {
  const id = ++_toastSeq;
  const toast: Toast = { id, text, kind, createdAt: performance.now() };
  uiState.value = { ...uiState.value, toasts: [...uiState.value.toasts, toast] };
  setTimeout(() => {
    uiState.value = {
      ...uiState.value,
      toasts: uiState.value.toasts.filter((t) => t.id !== id),
    };
  }, TOAST_TTL_MS);
}

// ── Derived signals (used by multiple components) ──────────────────────────────

/** True when any modal panel is open — game input should be suppressed. */
export const isModalOpen = computed(() => uiState.value.modalStack.length > 0);

/** True when the inventory panel is visible. */
export const inventoryOpen = computed(() => uiState.value.openPanels.has("inventory"));
