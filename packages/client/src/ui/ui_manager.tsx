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
import { uiState, closeTopModal, isModalOpen, openPanel, closePanel } from "./ui_store.ts";
import type { UIAction } from "./ui_actions.ts";

import { StatusBars }      from "./components/StatusBars.tsx";
import { PanelBar }        from "./components/PanelBar.tsx";
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
import { DebugPanel }      from "./components/DebugPanel.tsx";
import { NetworkPanel }    from "./components/NetworkPanel.tsx";

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

  // Global keyboard handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isModalOpen.value) {
        e.preventDefault();
        closeTopModal();
        return;
      }
      // Panel toggles — only fire when not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const toggle = (id: Parameters<typeof openPanel>[0]) => {
        e.preventDefault();
        uiState.value.openPanels.has(id) ? closePanel(id) : openPanel(id);
      };
      if (e.key === "i" || e.key === "I") toggle("inventory");
      if (e.key === "e" || e.key === "E") toggle("equipment");
      if (e.key === "c" || e.key === "C") toggle("stats");
      if (e.key === "`")                  toggle("debug");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Always-visible HUD layer */}
      <StatusBars />
      <Hotbar onAction={onAction} />
      <PanelBar />
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

      {/* Debug tools — float independently, don't block game input */}
      {panels.has("debug")      && <DebugPanel       onAction={onAction} />}
      {panels.has("network")    && <NetworkPanel />}

      {/* Portals — always on top */}
      <TooltipPortal />
      <ContextMenu onAction={onAction} />
    </>
  );
}
