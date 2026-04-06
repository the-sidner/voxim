/// <reference lib="dom" />
/**
 * UIManager — root Preact component.
 *
 * Renders into <div id="ui"> and conditionally mounts all panels based on
 * openPanels signal.  Also owns global keyboard routing: when a modal is
 * open, ESC closes it; when inventory is closed, key events go to the game.
 *
 * Mount once on game start:
 *   import { render } from "preact";
 *   import { UIManager } from "./ui/ui_manager.tsx";
 *   render(<UIManager onAction={handleAction} />, document.getElementById("ui")!);
 */
import { useEffect } from "preact/hooks";
import { uiState, closeTopModal, isModalOpen } from "./ui_store.ts";
import type { UIAction } from "./ui_actions.ts";

import { StatusBars }      from "./components/StatusBars.tsx";
import { Crosshair }       from "./components/Crosshair.tsx";
import { Hotbar }          from "./components/Hotbar.tsx";
import { EquipmentPanel }  from "./components/EquipmentPanel.tsx";
import { InventoryPanel }  from "./components/InventoryPanel.tsx";
import { StatsPanel }      from "./components/StatsPanel.tsx";
import { CraftingPanel }   from "./components/CraftingPanel.tsx";
import { TraderPanel }     from "./components/TraderPanel.tsx";
import { DialoguePanel }   from "./components/DialoguePanel.tsx";
import { SettingsPanel }   from "./components/SettingsPanel.tsx";
import { DeathScreen }     from "./components/DeathScreen.tsx";
import { TooltipPortal }   from "./components/TooltipPortal.tsx";
import { ContextMenu }     from "./components/ContextMenu.tsx";
import { ToastQueue }      from "./components/ToastQueue.tsx";

export interface UIManagerProps {
  /**
   * Callback for actions that need to reach game.ts (equip, move item, etc.)
   * This keeps the UI decoupled from the game loop — the UI describes intent,
   * game.ts translates to server messages.
   */
  onAction: (action: UIAction) => void;
}

export function UIManager({ onAction }: UIManagerProps) {
  const panels = uiState.value.openPanels;

  // Global keyboard handler — ESC pops the modal stack
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isModalOpen.value) {
        e.preventDefault();
        closeTopModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Always-visible HUD layer */}
      <Crosshair />
      <StatusBars />
      <Hotbar onAction={onAction} />
      <ToastQueue />

      {/* Toggleable panels */}
      {panels.has("inventory")  && <InventoryPanel  onAction={onAction} />}
      {panels.has("equipment")  && <EquipmentPanel  onAction={onAction} />}
      {panels.has("stats")      && <StatsPanel />}
      {panels.has("crafting")   && <CraftingPanel   onAction={onAction} />}
      {panels.has("trader")     && <TraderPanel      onAction={onAction} />}
      {panels.has("dialogue")   && <DialoguePanel    onAction={onAction} />}
      {panels.has("settings")   && <SettingsPanel    onAction={onAction} />}

      {/* Modals — render above panels */}
      {panels.has("death")      && <DeathScreen      onAction={onAction} />}

      {/* Portals — always on top */}
      <TooltipPortal />
      <ContextMenu onAction={onAction} />
    </>
  );
}
